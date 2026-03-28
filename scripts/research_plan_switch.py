#!/usr/bin/env python3
"""Build plan switchboard (A/B/C) from archived strategy iteration outputs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


FDR_CAP_DEFAULT = 0.05
WFO_CAP_DEFAULT = 0.10
FORCED_C_7D_FDR_IMPROVEMENT_MIN = 0.02
RUN_ID_TS_PATTERN = re.compile(r"(\d{8}T\d{6}Z)")
RUN_ID_PLAN_PREFIX_PATTERN = re.compile(r"^\s*([AaBb])[-_].+")


@dataclass
class PlanObservation:
    plan: str
    run_id: str
    generated_at: dt.datetime
    day: str
    fdr_q: float
    wfo_failure_density: float
    protocol_profile: str
    archive_dir: Path


@dataclass
class DailyPlanMetrics:
    day: str
    run_id: str
    fdr_q: float
    wfo_failure_density: float
    delta_fdr_q: float
    delta_wfo: float
    score: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Generate dual-track plan switchboard from archived A/B iteration outputs."
        )
    )
    parser.add_argument(
        "--archive-root",
        default="data/research/strategy/runs/archive",
        help="Archive root containing iteration run directories.",
    )
    parser.add_argument(
        "--window",
        type=int,
        default=3,
        help="Rolling evaluation window (days) for final A/B score aggregation.",
    )
    parser.add_argument(
        "--fdr-weight",
        type=float,
        default=0.6,
        help="Weight for normalized deltaFdrQ contribution.",
    )
    parser.add_argument(
        "--wfo-weight",
        type=float,
        default=0.4,
        help="Weight for normalized deltaWfo contribution.",
    )
    parser.add_argument(
        "--min-improvement",
        type=float,
        default=0.01,
        help="Minimum daily best deltaFdrQ treated as meaningful improvement.",
    )
    parser.add_argument(
        "--output",
        default="data/research/strategy/analysis/g3g4/plan_switchboard.latest.v1.json",
        help="Output JSON path.",
    )
    return parser.parse_args()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(base: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (base / path).resolve()


def to_float(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def clamp(raw: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, raw))


def safe_round(raw: float, digits: int = 6) -> float:
    return round(raw, digits)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    if not path.exists():
        return None, f"missing file: {path}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except Exception as exc:
        return None, f"invalid json {path}: {exc}"


def parse_iso_datetime(raw: str) -> Optional[dt.datetime]:
    text = (raw or "").strip()
    if not text:
        return None
    normalized = text.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def parse_run_id_timestamp(*candidates: str) -> Optional[dt.datetime]:
    for raw in candidates:
        if not raw:
            continue
        match = RUN_ID_TS_PATTERN.search(str(raw))
        if not match:
            continue
        try:
            parsed = dt.datetime.strptime(match.group(1), "%Y%m%dT%H%M%SZ")
            return parsed.replace(tzinfo=dt.timezone.utc)
        except ValueError:
            continue
    return None


def infer_plan(iteration_payload: Dict[str, Any], run_id: str, dirname: str) -> Optional[str]:
    direct = str(iteration_payload.get("plan", "")).strip().upper()
    if direct in {"A", "B"}:
        return direct
    for candidate in (run_id, dirname):
        match = RUN_ID_PLAN_PREFIX_PATTERN.match(candidate or "")
        if match:
            return match.group(1).upper()
    return None


def locate_breakdown_path(archive_dir: Path) -> Optional[Path]:
    candidates: Sequence[Path] = [
        archive_dir
        / "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json",
        archive_dir / "strategy_g3g4_breakdown.json",
        archive_dir / "data/research/strategy/analysis/g3g4/strategy_g3g4_breakdown.json",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return None


def extract_fdr_q(breakdown_payload: Dict[str, Any]) -> Optional[float]:
    verdict = breakdown_payload.get("verdict", {})
    if not isinstance(verdict, dict):
        return None
    metrics = verdict.get("aggregateMetrics", {})
    if not isinstance(metrics, dict):
        return None
    return to_float(metrics.get("fdrQ"))


def _iter_regime_bucket_rows(raw: Any) -> Iterable[Dict[str, Any]]:
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                yield item
        return
    if isinstance(raw, dict):
        for value in raw.values():
            if isinstance(value, dict):
                yield value


def extract_wfo_failure_density(
    breakdown_payload: Dict[str, Any],
    protocol_profile: str,
) -> Optional[float]:
    wfo_diag = breakdown_payload.get("wfo_diagnostics", {})
    if isinstance(wfo_diag, dict):
        regime_buckets = wfo_diag.get("regimeBuckets", {})
        densities: List[float] = []
        for bucket in _iter_regime_bucket_rows(regime_buckets):
            density = to_float(bucket.get("wfoFailureDensity"))
            if density is not None:
                densities.append(density)
        if densities:
            return float(statistics.mean(densities))

    protocol_ablation = breakdown_payload.get("protocolAblation", {})
    profiles = protocol_ablation.get("profiles", []) if isinstance(protocol_ablation, dict) else []
    target_profile = str(protocol_profile or "").strip().lower()

    if target_profile and isinstance(profiles, list):
        for row in profiles:
            if not isinstance(row, dict):
                continue
            profile_name = str(row.get("profile", "")).strip().lower()
            if profile_name != target_profile:
                continue
            density = to_float(row.get("wfoFailureDensity"))
            if density is not None:
                return density
    return None


def discover_observations(archive_root: Path) -> Tuple[List[PlanObservation], List[str]]:
    warnings: List[str] = []
    observations: List[PlanObservation] = []
    if not archive_root.exists():
        return [], [f"archive root not found: {archive_root}"]

    archive_dirs = sorted(
        [path for path in archive_root.iterdir() if path.is_dir()],
        key=lambda path: path.name,
    )
    for archive_dir in archive_dirs:
        iteration_path = archive_dir / "strategy_g3g4_iteration.json"
        iteration_payload_raw, iteration_error = load_json(iteration_path)
        if iteration_error is not None:
            warnings.append(iteration_error)
            continue
        if not isinstance(iteration_payload_raw, dict):
            warnings.append(f"invalid iteration payload shape: {iteration_path}")
            continue

        run_id = str(iteration_payload_raw.get("run_id", "")).strip() or archive_dir.name
        plan = infer_plan(iteration_payload_raw, run_id=run_id, dirname=archive_dir.name)
        if plan not in {"A", "B"}:
            warnings.append(
                f"skip archive without A/B plan tag (run_id={run_id}, dir={archive_dir.name})"
            )
            continue

        generated_at = parse_iso_datetime(str(iteration_payload_raw.get("generated_at", "")))
        if generated_at is None:
            generated_at = parse_run_id_timestamp(run_id, archive_dir.name)
        if generated_at is None:
            warnings.append(
                f"skip archive with unparsable generated time (run_id={run_id}, dir={archive_dir.name})"
            )
            continue

        breakdown_path = locate_breakdown_path(archive_dir)
        if breakdown_path is None:
            warnings.append(
                f"skip archive missing breakdown json under archive dir: {archive_dir}"
            )
            continue
        breakdown_payload_raw, breakdown_error = load_json(breakdown_path)
        if breakdown_error is not None:
            warnings.append(breakdown_error)
            continue
        if not isinstance(breakdown_payload_raw, dict):
            warnings.append(f"invalid breakdown payload shape: {breakdown_path}")
            continue

        fdr_q = extract_fdr_q(breakdown_payload_raw)
        if fdr_q is None:
            warnings.append(f"missing fdrQ in breakdown: {breakdown_path}")
            continue
        protocol_profile = str(iteration_payload_raw.get("protocol_profile", "")).strip()
        wfo_failure_density = extract_wfo_failure_density(
            breakdown_payload_raw,
            protocol_profile=protocol_profile,
        )
        if wfo_failure_density is None:
            warnings.append(
                f"missing wfoFailureDensity (profile/fallback) in breakdown: {breakdown_path}"
            )
            continue

        observations.append(
            PlanObservation(
                plan=plan,
                run_id=run_id,
                generated_at=generated_at,
                day=generated_at.date().isoformat(),
                fdr_q=fdr_q,
                wfo_failure_density=wfo_failure_density,
                protocol_profile=protocol_profile,
                archive_dir=archive_dir,
            )
        )
    return observations, warnings


def latest_per_day(observations: Sequence[PlanObservation]) -> Dict[str, PlanObservation]:
    by_day: Dict[str, PlanObservation] = {}
    for row in observations:
        existing = by_day.get(row.day)
        if existing is None or row.generated_at > existing.generated_at:
            by_day[row.day] = row
    return by_day


def compute_daily_plan_metrics(
    observations: Sequence[PlanObservation],
    *,
    fdr_weight: float,
    wfo_weight: float,
    fdr_cap: float,
    wfo_cap: float,
) -> Dict[str, DailyPlanMetrics]:
    by_day = latest_per_day(observations)
    ordered_days = sorted(by_day.keys())
    metrics: Dict[str, DailyPlanMetrics] = {}
    prev: Optional[PlanObservation] = None
    for day in ordered_days:
        current = by_day[day]
        if prev is None:
            delta_fdr_q = 0.0
            delta_wfo = 0.0
        else:
            delta_fdr_q = prev.fdr_q - current.fdr_q
            delta_wfo = prev.wfo_failure_density - current.wfo_failure_density

        normalized_fdr = clamp(delta_fdr_q / fdr_cap if fdr_cap > 0 else 0.0, -1.0, 1.0)
        normalized_wfo = clamp(delta_wfo / wfo_cap if wfo_cap > 0 else 0.0, -1.0, 1.0)
        score = (fdr_weight * normalized_fdr) + (wfo_weight * normalized_wfo)

        metrics[day] = DailyPlanMetrics(
            day=day,
            run_id=current.run_id,
            fdr_q=current.fdr_q,
            wfo_failure_density=current.wfo_failure_density,
            delta_fdr_q=delta_fdr_q,
            delta_wfo=delta_wfo,
            score=score,
        )
        prev = current
    return metrics


def trailing_count(rows: Sequence[Dict[str, Any]], key: str) -> int:
    count = 0
    for row in reversed(rows):
        if bool(row.get(key)):
            count += 1
            continue
        break
    return count


def build_output_payload(
    *,
    archive_root: Path,
    window: int,
    fdr_weight: float,
    wfo_weight: float,
    min_improvement: float,
    observations: Sequence[PlanObservation],
    warnings: Sequence[str],
) -> Dict[str, Any]:
    obs_by_plan: Dict[str, List[PlanObservation]] = {"A": [], "B": []}
    for row in observations:
        if row.plan in obs_by_plan:
            obs_by_plan[row.plan].append(row)

    plan_a_daily = compute_daily_plan_metrics(
        obs_by_plan["A"],
        fdr_weight=fdr_weight,
        wfo_weight=wfo_weight,
        fdr_cap=FDR_CAP_DEFAULT,
        wfo_cap=WFO_CAP_DEFAULT,
    )
    plan_b_daily = compute_daily_plan_metrics(
        obs_by_plan["B"],
        fdr_weight=fdr_weight,
        wfo_weight=wfo_weight,
        fdr_cap=FDR_CAP_DEFAULT,
        wfo_cap=WFO_CAP_DEFAULT,
    )

    evaluation_days = sorted(set(plan_a_daily.keys()) & set(plan_b_daily.keys()))
    if not evaluation_days:
        raise ValueError("no overlapping A/B evaluation days discovered from archives")

    daily_rows: List[Dict[str, Any]] = []
    for day in evaluation_days:
        a = plan_a_daily[day]
        b = plan_b_daily[day]
        best_fdr_improvement = max(a.delta_fdr_q, b.delta_fdr_q)
        both_non_positive = (a.score <= 0.0) and (b.score <= 0.0)
        daily_rows.append(
            {
                "day": day,
                "A": {
                    "runId": a.run_id,
                    "fdrQ": safe_round(a.fdr_q),
                    "wfoFailureDensity": safe_round(a.wfo_failure_density),
                    "deltaFdrQ": safe_round(a.delta_fdr_q),
                    "deltaWfo": safe_round(a.delta_wfo),
                    "score": safe_round(a.score),
                },
                "B": {
                    "runId": b.run_id,
                    "fdrQ": safe_round(b.fdr_q),
                    "wfoFailureDensity": safe_round(b.wfo_failure_density),
                    "deltaFdrQ": safe_round(b.delta_fdr_q),
                    "deltaWfo": safe_round(b.delta_wfo),
                    "score": safe_round(b.score),
                },
                "bestFdrImprovement": safe_round(best_fdr_improvement),
                "bothNonPositive": both_non_positive,
                "lowFdrImprovement": bool(best_fdr_improvement < min_improvement),
            }
        )

    window_days = evaluation_days[-window:]
    window_set = set(window_days)
    window_rows = [row for row in daily_rows if row["day"] in window_set]
    if not window_rows:
        raise ValueError("evaluation window has no rows")

    latest_row = window_rows[-1]
    score_a = statistics.mean(float(row["A"]["score"]) for row in window_rows)
    score_b = statistics.mean(float(row["B"]["score"]) for row in window_rows)

    if score_a > score_b:
        base_primary = "A"
        base_secondary = "B"
        base_reason = "INFO_PRIMARY_A_SCORE_HIGHER"
    elif score_b > score_a:
        base_primary = "B"
        base_secondary = "A"
        base_reason = "INFO_PRIMARY_B_SCORE_HIGHER"
    else:
        latest_delta_a = float(latest_row["A"]["deltaFdrQ"])
        latest_delta_b = float(latest_row["B"]["deltaFdrQ"])
        if latest_delta_b > latest_delta_a:
            base_primary = "B"
            base_secondary = "A"
            base_reason = "INFO_PRIMARY_B_TIEBREAK_DELTAFDR"
        else:
            base_primary = "A"
            base_secondary = "B"
            base_reason = "INFO_PRIMARY_A_TIEBREAK_DELTAFDR"

    non_positive_days = trailing_count(daily_rows, key="bothNonPositive")
    low_fdr_improvement_days = trailing_count(daily_rows, key="lowFdrImprovement")
    recent_7_rows = daily_rows[-7:]
    best_7d_fdr_improvement = (
        max(float(row["bestFdrImprovement"]) for row in recent_7_rows)
        if recent_7_rows
        else 0.0
    )

    forced_c_by_non_positive = non_positive_days >= 2
    forced_c_by_low_7d_fdr = best_7d_fdr_improvement < FORCED_C_7D_FDR_IMPROVEMENT_MIN
    forced_c = forced_c_by_non_positive or forced_c_by_low_7d_fdr

    reason_codes: List[str] = [base_reason]
    if abs(score_a - score_b) < min_improvement:
        reason_codes.append("WARN_SCORE_MARGIN_BELOW_MIN_IMPROVEMENT")
    if forced_c_by_non_positive:
        reason_codes.append("HARD_FORCED_C_TWO_DAY_NON_POSITIVE")
    if forced_c_by_low_7d_fdr:
        reason_codes.append("HARD_FORCED_C_LOW_7D_FDR_IMPROVEMENT")

    next_primary_plan = "C" if forced_c else base_primary
    next_secondary_plan = base_primary if forced_c else base_secondary

    return {
        "schemaVersion": "plan_switchboard.v1",
        "generatedAt": iso(now_utc()),
        "mode": "dual_track",
        "windowDays": window,
        "weights": {
            "fdr": safe_round(fdr_weight),
            "wfo": safe_round(wfo_weight),
        },
        "normalizationCaps": {
            "fdr": safe_round(FDR_CAP_DEFAULT),
            "wfo": safe_round(WFO_CAP_DEFAULT),
        },
        "plans": {
            "A": {
                "runId": str(latest_row["A"]["runId"]),
                "fdrQ": float(latest_row["A"]["fdrQ"]),
                "wfoFailureDensity": float(latest_row["A"]["wfoFailureDensity"]),
                "deltaFdrQ": float(latest_row["A"]["deltaFdrQ"]),
                "deltaWfo": float(latest_row["A"]["deltaWfo"]),
                "score": safe_round(score_a),
            },
            "B": {
                "runId": str(latest_row["B"]["runId"]),
                "fdrQ": float(latest_row["B"]["fdrQ"]),
                "wfoFailureDensity": float(latest_row["B"]["wfoFailureDensity"]),
                "deltaFdrQ": float(latest_row["B"]["deltaFdrQ"]),
                "deltaWfo": float(latest_row["B"]["deltaWfo"]),
                "score": safe_round(score_b),
            },
        },
        "streaks": {
            "nonPositiveDays": non_positive_days,
            "lowFdrImprovementDays": low_fdr_improvement_days,
        },
        "decision": {
            "nextPrimaryPlan": next_primary_plan,
            "nextSecondaryPlan": next_secondary_plan,
            "forcedC": forced_c,
            "reasonCodes": reason_codes,
        },
        "thresholds": {
            "minImprovement": safe_round(min_improvement),
            "forcedC7dFdrImprovementMin": safe_round(FORCED_C_7D_FDR_IMPROVEMENT_MIN),
            "best7dFdrImprovementObserved": safe_round(best_7d_fdr_improvement),
        },
        "source": {
            "archiveRoot": str(archive_root),
            "evaluatedDays": len(window_rows),
            "availableOverlappingDays": len(evaluation_days),
        },
        "dailyScores": daily_rows,
        "warnings": list(warnings),
    }


def main() -> int:
    args = parse_args()
    if args.window <= 0:
        print("ERROR: --window must be > 0", file=sys.stderr)
        return 2
    if args.fdr_weight < 0 or args.wfo_weight < 0:
        print("ERROR: --fdr-weight and --wfo-weight must be >= 0", file=sys.stderr)
        return 2
    if args.min_improvement < 0:
        print("ERROR: --min-improvement must be >= 0", file=sys.stderr)
        return 2

    cwd = Path.cwd()
    archive_root = resolve_path(cwd, args.archive_root)
    output_path = resolve_path(cwd, args.output)

    observations, warnings = discover_observations(archive_root)
    if not observations:
        print(
            f"ERROR: no valid A/B observations found under archive root: {archive_root}",
            file=sys.stderr,
        )
        return 2

    try:
        payload = build_output_payload(
            archive_root=archive_root,
            window=args.window,
            fdr_weight=float(args.fdr_weight),
            wfo_weight=float(args.wfo_weight),
            min_improvement=float(args.min_improvement),
            observations=observations,
            warnings=warnings,
        )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    write_json(output_path, payload)
    print(
        json.dumps(
            {
                "output": str(output_path),
                "nextPrimaryPlan": payload["decision"]["nextPrimaryPlan"],
                "nextSecondaryPlan": payload["decision"]["nextSecondaryPlan"],
                "forcedC": payload["decision"]["forcedC"],
                "evaluatedDays": payload["source"]["evaluatedDays"],
                "availableOverlappingDays": payload["source"]["availableOverlappingDays"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
