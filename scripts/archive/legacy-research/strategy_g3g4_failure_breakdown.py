#!/usr/bin/env python3
"""Generate G3/G4-oriented failure breakdown for strategy MVP outputs.

Outputs:
- latest_strategy_g3g4_breakdown.json
- latest_strategy_g3g4_breakdown.md
- archive/<run_id>/strategy_g3g4_breakdown.{json,md}
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a structured G3/G4 failure breakdown from latest strategy outputs."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--validation-runs",
        default="data/research/strategy/strategy_validation_runs.json",
        help="Path to strategy_validation_runs.json.",
    )
    parser.add_argument(
        "--experiment-verdict",
        default="data/research/strategy/experiment_verdict.v2.json",
        help="Path to experiment_verdict.v2.json.",
    )
    parser.add_argument(
        "--g3-checkpoint",
        default="data/runtime/gates/G3.checkpoint.json",
        help="Path to G3 checkpoint.",
    )
    parser.add_argument(
        "--g4-checkpoint",
        default="data/runtime/gates/G4.checkpoint.json",
        help="Path to G4 checkpoint.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy/analysis/g3g4",
        help="Output directory for latest/archive reports.",
    )
    parser.add_argument(
        "--protocol-ablation",
        default="data/research/strategy/analysis/g3g4/latest_protocol_ablation.json",
        help="Path to protocol ablation JSON report (optional).",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id. Default uses current UTC timestamp.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print payload only; do not write files.",
    )
    return parser.parse_args()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (root / path).resolve()


def load_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    if not path.exists():
        return None, f"missing file: {path}"
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except Exception as exc:  # pragma: no cover - defensive runtime guard
        return None, f"invalid json {path}: {exc}"


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


def mean(values: Iterable[Optional[float]]) -> Optional[float]:
    filtered = [v for v in values if v is not None]
    if not filtered:
        return None
    return float(sum(filtered) / len(filtered))


def safe_round(raw: Optional[float], digits: int = 6) -> Optional[float]:
    if raw is None:
        return None
    return round(raw, digits)


def to_int(raw: Any) -> Optional[int]:
    try:
        if raw is None:
            return None
        value = int(raw)
        return value if value > 0 else None
    except Exception:
        return None


def to_non_negative_int(raw: Any) -> Optional[int]:
    try:
        if raw is None:
            return None
        value = int(raw)
        return value if value >= 0 else None
    except Exception:
        return None


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def extract_top_table_rows(candidates: List[Dict[str, Any]], limit: int = 6) -> List[Dict[str, Any]]:
    ranked = sorted(
        candidates,
        key=lambda row: (
            row.get("backtestSharpe") is not None,
            row.get("backtestSharpe") or float("-inf"),
        ),
        reverse=True,
    )
    return ranked[:limit]


def summarize_family(candidates: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        groups[str(row.get("strategy", "unknown"))].append(row)

    summary: Dict[str, Dict[str, Any]] = {}
    for family, rows in sorted(groups.items()):
        pass_count = sum(1 for row in rows if row.get("candidatePass") is True)
        summary[family] = {
            "count": len(rows),
            "passCount": pass_count,
            "passRatio": safe_round(pass_count / len(rows), 6) if rows else None,
            "meanSharpe": safe_round(mean(row.get("backtestSharpe") for row in rows), 6),
            "meanPbo": safe_round(mean(row.get("pbo") for row in rows), 6),
            "meanDsrProbability": safe_round(
                mean(row.get("dsrProbability") for row in rows), 6
            ),
            "meanFdrQ": safe_round(mean(row.get("fdrQ") for row in rows), 6),
        }
    return summary


def quantiles(values: List[float]) -> Dict[str, Optional[float]]:
    if not values:
        return {"p25": None, "p50": None, "p75": None, "p90": None, "max": None}
    sorted_vals = sorted(values)

    def at(p: float) -> float:
        if len(sorted_vals) == 1:
            return sorted_vals[0]
        idx = int(round((len(sorted_vals) - 1) * p))
        idx = max(0, min(idx, len(sorted_vals) - 1))
        return sorted_vals[idx]

    return {
        "p25": safe_round(at(0.25), 6),
        "p50": safe_round(at(0.50), 6),
        "p75": safe_round(at(0.75), 6),
        "p90": safe_round(at(0.90), 6),
        "max": safe_round(sorted_vals[-1], 6),
    }


def build_wfo_diagnostics(candidates: List[Dict[str, Any]]) -> Dict[str, Any]:
    failed_window_ratios = [
        value
        for value in (to_float(row.get("wfoFailedWindowRatio")) for row in candidates)
        if value is not None
    ]
    mean_degradation_rates = [
        value
        for value in (to_float(row.get("wfoMeanDegradationRate")) for row in candidates)
        if value is not None
    ]
    worst_degradation_rates = [
        value
        for value in (to_float(row.get("wfoWorstDegradationRate")) for row in candidates)
        if value is not None
    ]

    by_family: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for row in candidates:
        by_family[str(row.get("strategy", "unknown"))].append(row)

    regime_buckets: Dict[str, Any] = {}
    for family, rows in sorted(by_family.items()):
        total_windows = sum(to_non_negative_int(r.get("wfoTotalWindows")) or 0 for r in rows)
        failed_windows = sum(to_non_negative_int(r.get("wfoFailedWindows")) or 0 for r in rows)
        fail_reasons: Counter[str] = Counter()
        for r in rows:
            fail_by_reason = r.get("wfoFailByReason", {})
            if isinstance(fail_by_reason, dict):
                for key, value in fail_by_reason.items():
                    count = to_int(value)
                    if count is None:
                        continue
                    fail_reasons[str(key)] += count
        regime_buckets[family] = {
            "count": len(rows),
            "meanSharpe": safe_round(mean(to_float(r.get("backtestSharpe")) for r in rows), 6),
            "meanFailedWindowRatio": safe_round(
                mean(to_float(r.get("wfoFailedWindowRatio")) for r in rows), 6
            ),
            "meanDegradationRate": safe_round(
                mean(to_float(r.get("wfoMeanDegradationRate")) for r in rows), 6
            ),
            "wfoFailureDensity": safe_round(
                failed_windows / total_windows if total_windows > 0 else None,
                6,
            ),
            "wfoFailReasons": dict(
                sorted(fail_reasons.items(), key=lambda item: (-item[1], item[0]))
            ),
        }

    return {
        "windowQuantiles": {
            "failedWindowRatio": quantiles(failed_window_ratios),
            "meanDegradationRate": quantiles(mean_degradation_rates),
            "worstDegradationRate": quantiles(worst_degradation_rates),
        },
        "regimeBuckets": regime_buckets,
    }


def build_protocol_ablation_summary(raw: Dict[str, Any]) -> Dict[str, Any]:
    profiles = raw.get("profiles", [])
    if not isinstance(profiles, list):
        profiles = []
    normalized_profiles: List[Dict[str, Any]] = []
    for row in profiles:
        if not isinstance(row, dict):
            continue
        hard_gap = row.get("hardGap", {})
        if not isinstance(hard_gap, dict):
            hard_gap = {}
        normalized_profiles.append(
            {
                "profile": row.get("profile"),
                "result": row.get("result"),
                "wfoFailureDensity": safe_round(to_float(row.get("wfoFailureDensity")), 6),
                "hardGapTotal": safe_round(to_float(hard_gap.get("totalGap")), 6),
                "fdrGap": safe_round(to_float(hard_gap.get("fdrGap")), 6),
                "meanSharpe": safe_round(to_float(row.get("meanSharpe")), 6),
            }
        )

    return {
        "runId": raw.get("run_id"),
        "recommendedProfile": raw.get("recommendedProfile"),
        "rankingObjective": raw.get("rankingObjective"),
        "profiles": normalized_profiles,
    }


def build_fdr_feasibility(
    *,
    thresholds: Dict[str, Any],
    candidates: List[Dict[str, Any]],
) -> Dict[str, Any]:
    alpha = to_float(thresholds.get("fdrQMax"))
    candidate_count = len(candidates)
    payload: Dict[str, Any] = {
        "alpha": safe_round(alpha, 6),
        "candidateCount": candidate_count,
        "rankThresholds": [],
        "bestCaseMinDsrProbabilityForQPass": None,
        "champion": {},
    }
    if alpha is None or candidate_count <= 0:
        return payload

    rank_thresholds: List[Dict[str, Any]] = []
    for rank in range(1, candidate_count + 1):
        max_p = alpha * (rank / candidate_count)
        rank_thresholds.append(
            {
                "rank": rank,
                "maxPValueForQPass": safe_round(max_p, 6),
                "minDsrProbabilityForQPass": safe_round(1 - max_p, 6),
            }
        )
    payload["rankThresholds"] = rank_thresholds
    payload["bestCaseMinDsrProbabilityForQPass"] = safe_round(
        1 - (alpha / candidate_count), 6
    )

    champion = next(
        (
            row
            for row in sorted(
                candidates,
                key=lambda row: (
                    row.get("backtestSharpe") is not None,
                    row.get("backtestSharpe") or float("-inf"),
                ),
                reverse=True,
            )
            if row.get("strategyId") is not None
        ),
        None,
    )
    if champion is None:
        return payload

    rank = to_int(champion.get("fdrRank"))
    required_min_dsr = None
    if rank is not None and 1 <= rank <= candidate_count:
        required_min_dsr = safe_round(1 - alpha * (rank / candidate_count), 6)
    champion_dsr = to_float(champion.get("dsrProbability"))
    champion_fdr_q = to_float(champion.get("fdrQ"))
    champion_fdr_p = to_float(champion.get("fdrPValue"))
    payload["champion"] = {
        "strategyId": champion.get("strategyId"),
        "strategyName": champion.get("strategyName"),
        "fdrRank": rank,
        "fdrQ": safe_round(champion_fdr_q, 6),
        "fdrPValue": safe_round(champion_fdr_p, 6),
        "dsrProbability": safe_round(champion_dsr, 6),
        "requiredMinDsrProbabilityForCurrentRankQPass": required_min_dsr,
        "dsrGapToCurrentRankRequirement": safe_round(
            (required_min_dsr - champion_dsr)
            if required_min_dsr is not None and champion_dsr is not None
            else None,
            6,
        ),
        "qGapToThreshold": safe_round(
            (champion_fdr_q - alpha) if champion_fdr_q is not None else None, 6
        ),
    }
    return payload


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Strategy G3/G4 Failure Breakdown")
    lines.append("")
    lines.append(f"- run_id: `{payload.get('run_id', '')}`")
    lines.append(f"- generated_at: `{payload.get('generated_at', '')}`")
    lines.append(f"- verdict: `{payload.get('verdict', {}).get('result', 'unknown')}`")
    lines.append(
        f"- no_decision: `{payload.get('no_decision', {}).get('triggered', False)}`"
    )
    lines.append("")

    g3 = payload.get("gates", {}).get("G3", {})
    g4 = payload.get("gates", {}).get("G4", {})
    lines.append("## Gates")
    lines.append("")
    lines.append(f"- G3: `{g3.get('status', 'unknown')}`")
    lines.append(f"- G4: `{g4.get('status', 'unknown')}`")
    lines.append(f"- G3 reason codes: `{','.join(g3.get('reasonCodes', []))}`")
    lines.append(f"- G4 reason codes: `{','.join(g4.get('reasonCodes', []))}`")
    lines.append("")

    metric = payload.get("metric_snapshot", {})
    lines.append("## Metric Snapshot")
    lines.append("")
    lines.append(f"- meanPbo: `{metric.get('meanPbo')}`")
    lines.append(f"- meanDsrProbability: `{metric.get('meanDsrProbability')}`")
    lines.append(f"- meanFdrQ: `{metric.get('meanFdrQ')}`")
    lines.append(f"- meanSharpe: `{metric.get('meanSharpe')}`")
    lines.append(f"- medianSharpe: `{metric.get('medianSharpe')}`")
    lines.append("")

    fdr = payload.get("fdr_feasibility", {})
    champion = fdr.get("champion", {})
    lines.append("## FDR Feasibility")
    lines.append("")
    lines.append(f"- alpha(fdrQMax): `{fdr.get('alpha')}`")
    lines.append(f"- candidateCount: `{fdr.get('candidateCount')}`")
    lines.append(
        "- bestCaseMinDsrProbabilityForQPass: "
        f"`{fdr.get('bestCaseMinDsrProbabilityForQPass')}`"
    )
    lines.append(
        "- champion(fdrRank/fdrQ/dsrProbability): "
        f"`{champion.get('fdrRank')}/{champion.get('fdrQ')}/{champion.get('dsrProbability')}`"
    )
    lines.append(
        "- champion required min dsr for current rank: "
        f"`{champion.get('requiredMinDsrProbabilityForCurrentRankQPass')}`"
    )
    lines.append(
        "- champion dsr gap to requirement: "
        f"`{champion.get('dsrGapToCurrentRankRequirement')}`"
    )
    lines.append(
        "- champion q gap to threshold: "
        f"`{champion.get('qGapToThreshold')}`"
    )
    lines.append("")

    wfo_reasons = payload.get("failure_breakdown", {}).get("wfoGateReasons", {})
    lines.append("## WFO Gate Reasons")
    lines.append("")
    if not wfo_reasons:
        lines.append("- none")
    else:
        for key, value in sorted(
            wfo_reasons.items(), key=lambda item: (-item[1], item[0])
        ):
            lines.append(f"- `{key}`: {value}")
    lines.append("")

    wfo_diag = payload.get("wfo_diagnostics", {})
    quant = wfo_diag.get("windowQuantiles", {})
    lines.append("## WFO Diagnostics")
    lines.append("")
    lines.append("- failedWindowRatio quantiles:")
    lines.append(f"  p25/p50/p75/p90/max = `{(quant.get('failedWindowRatio') or {}).get('p25')}/{(quant.get('failedWindowRatio') or {}).get('p50')}/{(quant.get('failedWindowRatio') or {}).get('p75')}/{(quant.get('failedWindowRatio') or {}).get('p90')}/{(quant.get('failedWindowRatio') or {}).get('max')}`")
    lines.append("- meanDegradationRate quantiles:")
    lines.append(f"  p25/p50/p75/p90/max = `{(quant.get('meanDegradationRate') or {}).get('p25')}/{(quant.get('meanDegradationRate') or {}).get('p50')}/{(quant.get('meanDegradationRate') or {}).get('p75')}/{(quant.get('meanDegradationRate') or {}).get('p90')}/{(quant.get('meanDegradationRate') or {}).get('max')}`")
    lines.append("- worstDegradationRate quantiles:")
    lines.append(f"  p25/p50/p75/p90/max = `{(quant.get('worstDegradationRate') or {}).get('p25')}/{(quant.get('worstDegradationRate') or {}).get('p50')}/{(quant.get('worstDegradationRate') or {}).get('p75')}/{(quant.get('worstDegradationRate') or {}).get('p90')}/{(quant.get('worstDegradationRate') or {}).get('max')}`")
    lines.append("")
    lines.append("| regime(bucketed by family) | count | meanSharpe | meanFailedWindowRatio | meanDegradationRate | wfoFailureDensity |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for family, row in sorted((wfo_diag.get("regimeBuckets") or {}).items()):
        if not isinstance(row, dict):
            continue
        lines.append(
            "| "
            + " | ".join(
                [
                    str(family),
                    str(row.get("count", "")),
                    str(row.get("meanSharpe", "")),
                    str(row.get("meanFailedWindowRatio", "")),
                    str(row.get("meanDegradationRate", "")),
                    str(row.get("wfoFailureDensity", "")),
                ]
            )
            + " |"
        )
    lines.append("")

    fail_counts = payload.get("failure_breakdown", {}).get("releaseGateFailedChecks", {})
    lines.append("## Release Gate Failure Counts")
    lines.append("")
    if not fail_counts:
        lines.append("- none")
    else:
        for key, value in sorted(fail_counts.items(), key=lambda item: (-item[1], item[0])):
            lines.append(f"- `{key}`: {value}")
    lines.append("")

    protocol_ablation = payload.get("protocolAblation", {})
    lines.append("## Protocol Ablation")
    lines.append("")
    if not isinstance(protocol_ablation, dict) or not protocol_ablation:
        lines.append("- unavailable")
    else:
        lines.append(f"- run_id: `{protocol_ablation.get('runId')}`")
        lines.append(
            f"- recommendedProfile: `{protocol_ablation.get('recommendedProfile')}`"
        )
        lines.append(
            f"- rankingObjective: `{protocol_ablation.get('rankingObjective')}`"
        )
        lines.append("")
        lines.append(
            "| profile | result | wfoFailureDensity | hardGapTotal | fdrGap | meanSharpe |"
        )
        lines.append("|---|---|---:|---:|---:|---:|")
        for row in protocol_ablation.get("profiles", []):
            if not isinstance(row, dict):
                continue
            lines.append(
                "| "
                + " | ".join(
                    [
                        str(row.get("profile", "")),
                        str(row.get("result", "")),
                        str(row.get("wfoFailureDensity", "")),
                        str(row.get("hardGapTotal", "")),
                        str(row.get("fdrGap", "")),
                        str(row.get("meanSharpe", "")),
                    ]
                )
                + " |"
            )
    lines.append("")

    lines.append("## Top Candidates by Sharpe")
    lines.append("")
    lines.append("| strategyId | strategyName | family | sharpe | pbo | dsrProbability | fdrQ | pass | failedChecks |")
    lines.append("|---|---|---|---:|---:|---:|---:|---|---|")
    for row in payload.get("top_candidates_by_sharpe", []):
        failed_checks = ",".join(row.get("releaseGateFailedChecks", []))
        lines.append(
            "| "
            + " | ".join(
                [
                    str(row.get("strategyId", "")),
                    str(row.get("strategyName", "")),
                    str(row.get("strategy", "")),
                    str(row.get("backtestSharpe", "")),
                    str(row.get("pbo", "")),
                    str(row.get("dsrProbability", "")),
                    str(row.get("fdrQ", "")),
                    str(row.get("candidatePass", "")),
                    failed_checks,
                ]
            )
            + " |"
        )
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if args.repo_root
        else Path(__file__).resolve().parents[1]
    )
    ts = now_utc()
    run_id = args.run_id.strip() or ts.strftime("%Y%m%dT%H%M%SZ")

    validation_runs_path = resolve_path(repo_root, args.validation_runs)
    verdict_path = resolve_path(repo_root, args.experiment_verdict)
    g3_path = resolve_path(repo_root, args.g3_checkpoint)
    g4_path = resolve_path(repo_root, args.g4_checkpoint)
    protocol_ablation_path = resolve_path(repo_root, args.protocol_ablation)
    out_dir = resolve_path(repo_root, args.out_dir)

    warnings: List[str] = []
    validation_runs_raw, err = load_json(validation_runs_path)
    if err:
        warnings.append(err)
    verdict_raw, err = load_json(verdict_path)
    if err:
        warnings.append(err)
    g3_raw, err = load_json(g3_path)
    if err:
        warnings.append(err)
    g4_raw, err = load_json(g4_path)
    if err:
        warnings.append(err)
    protocol_ablation_raw, err = load_json(protocol_ablation_path)
    if err:
        warnings.append(f"protocol ablation optional: {err}")

    validation_runs = validation_runs_raw if isinstance(validation_runs_raw, dict) else {}
    verdict = verdict_raw if isinstance(verdict_raw, dict) else {}
    g3 = g3_raw if isinstance(g3_raw, dict) else {}
    g4 = g4_raw if isinstance(g4_raw, dict) else {}
    protocol_ablation = (
        protocol_ablation_raw if isinstance(protocol_ablation_raw, dict) else {}
    )

    candidate_rows = validation_runs.get("candidates", [])
    if not isinstance(candidate_rows, list):
        candidate_rows = []

    normalized_candidates: List[Dict[str, Any]] = []
    release_gate_fail_counter: Counter[str] = Counter()
    failure_reason_counter: Counter[str] = Counter()
    wfo_gate_reason_counter: Counter[str] = Counter()
    sharpe_values: List[float] = []
    pass_count = 0

    for row in candidate_rows:
        if not isinstance(row, dict):
            continue
        strategy = str(row.get("strategy", "unknown"))
        failed_checks = []
        release_gate = row.get("releaseGate")
        if isinstance(release_gate, dict):
            failed_checks = release_gate.get("failedChecks", [])
        if not isinstance(failed_checks, list):
            failed_checks = []
        failed_checks = [str(item) for item in failed_checks if str(item).strip()]
        release_gate_fail_counter.update(failed_checks)

        failure_reasons = row.get("failureReasons", [])
        if not isinstance(failure_reasons, list):
            failure_reasons = []
        failure_reasons = [str(item) for item in failure_reasons if str(item).strip()]
        failure_reason_counter.update(failure_reasons)

        candidate_pass = bool(row.get("candidatePass")) or str(row.get("status")) == "pass"
        if candidate_pass:
            pass_count += 1

        wfo_summary = row.get("wfoSummary")
        if not isinstance(wfo_summary, dict):
            wfo_summary = {}
        wfo_fail_by_reason = wfo_summary.get("failByReason", {})
        if isinstance(wfo_fail_by_reason, dict):
            for key, value in wfo_fail_by_reason.items():
                reason = str(key).strip()
                if not reason:
                    continue
                count = to_int(value)
                if count is None:
                    continue
                wfo_gate_reason_counter[reason] += count

        sharpe = to_float((row.get("backtestMetrics") or {}).get("sharpe"))
        if sharpe is not None:
            sharpe_values.append(sharpe)

        normalized = {
            "strategyId": row.get("strategyId"),
            "strategyName": row.get("strategyName"),
            "strategy": strategy,
            "status": row.get("status"),
            "candidatePass": candidate_pass,
            "pbo": safe_round(to_float((row.get("significance") or {}).get("pbo")), 6),
            "dsrValue": safe_round(
                to_float((row.get("significance") or {}).get("dsrValue")), 6
            ),
            "dsrProbability": safe_round(
                to_float((row.get("significance") or {}).get("dsrProbability")), 6
            ),
            "fdrQ": safe_round(to_float((row.get("fdr") or {}).get("qValue")), 6),
            "fdrPValue": safe_round(to_float((row.get("fdr") or {}).get("pValue")), 6),
            "fdrRank": to_int((row.get("fdr") or {}).get("rank")),
            "wfoGatePassed": bool(row.get("wfoGatePassed")),
            "wfoFailedWindows": to_non_negative_int(wfo_summary.get("failedWindows")),
            "wfoTotalWindows": to_non_negative_int(wfo_summary.get("totalWindows")),
            "wfoFailedWindowRatio": safe_round(
                to_float(wfo_summary.get("failedWindowRatio")), 6
            ),
            "wfoMeanDegradationRate": safe_round(
                to_float(wfo_summary.get("meanDegradationRate")), 6
            ),
            "wfoWorstDegradationRate": safe_round(
                to_float(wfo_summary.get("worstDegradationRate")), 6
            ),
            "wfoFailByReason": wfo_fail_by_reason
            if isinstance(wfo_fail_by_reason, dict)
            else {},
            "backtestSharpe": safe_round(sharpe, 6),
            "backtestReturnPct": safe_round(
                to_float((row.get("backtestMetrics") or {}).get("totalReturnPct")), 6
            ),
            "backtestMaxDrawdownPct": safe_round(
                to_float((row.get("backtestMetrics") or {}).get("maxDrawdownPct")), 6
            ),
            "releaseGateFailedChecks": failed_checks,
            "failureReasons": failure_reasons,
        }
        normalized_candidates.append(normalized)

    mean_pbo = mean(row.get("pbo") for row in normalized_candidates)
    mean_dsr_probability = mean(row.get("dsrProbability") for row in normalized_candidates)
    mean_fdr_q = mean(row.get("fdrQ") for row in normalized_candidates)
    mean_sharpe = mean(sharpe_values)
    median_sharpe = statistics.median(sharpe_values) if sharpe_values else None

    verdict_result = str(verdict.get("result", "UNKNOWN"))
    no_decision_triggered = verdict_result != "GO"

    payload: Dict[str, Any] = {
        "schemaVersion": "strategy_g3g4_breakdown.v2",
        "run_id": run_id,
        "generated_at": iso(ts),
        "inputs": {
            "validation_runs": str(validation_runs_path),
            "experiment_verdict": str(verdict_path),
            "g3_checkpoint": str(g3_path),
            "g4_checkpoint": str(g4_path),
            "protocol_ablation": str(protocol_ablation_path),
        },
        "warnings": warnings,
        "verdict": {
            "result": verdict_result,
            "reasonCodes": verdict.get("reasonCodes", []),
            "thresholds": verdict.get("thresholds", {}),
            "aggregateMetrics": verdict.get("aggregateMetrics", {}),
        },
        "gates": {
            "G3": {
                "status": g3.get("status", "unknown"),
                "reasonCodes": g3.get("reasonCodes", []),
            },
            "G4": {
                "status": g4.get("status", "unknown"),
                "reasonCodes": g4.get("reasonCodes", []),
            },
        },
        "candidate_summary": {
            "count": len(normalized_candidates),
            "passCount": pass_count,
            "failCount": max(0, len(normalized_candidates) - pass_count),
            "familyBreakdown": summarize_family(normalized_candidates),
        },
        "failure_breakdown": {
            "releaseGateFailedChecks": dict(
                sorted(release_gate_fail_counter.items(), key=lambda item: (-item[1], item[0]))
            ),
            "wfoGateReasons": dict(
                sorted(wfo_gate_reason_counter.items(), key=lambda item: (-item[1], item[0]))
            ),
            "failureReasonCodes": dict(
                sorted(failure_reason_counter.items(), key=lambda item: (-item[1], item[0]))
            ),
        },
        "metric_snapshot": {
            "meanPbo": safe_round(mean_pbo, 6),
            "meanDsrProbability": safe_round(mean_dsr_probability, 6),
            "meanFdrQ": safe_round(mean_fdr_q, 6),
            "meanSharpe": safe_round(mean_sharpe, 6),
            "medianSharpe": safe_round(median_sharpe, 6),
        },
        "fdr_feasibility": build_fdr_feasibility(
            thresholds=verdict.get("thresholds", {})
            if isinstance(verdict.get("thresholds"), dict)
            else {},
            candidates=normalized_candidates,
        ),
        "wfo_diagnostics": build_wfo_diagnostics(normalized_candidates),
        "protocolAblation": build_protocol_ablation_summary(protocol_ablation)
        if protocol_ablation
        else {},
        "top_candidates_by_sharpe": extract_top_table_rows(normalized_candidates, limit=6),
        "no_decision": {
            "triggered": no_decision_triggered,
            "reason": (
                "verdict.result != GO; strict-evidence policy requires no-decision"
                if no_decision_triggered
                else "GO achieved"
            ),
        },
    }

    markdown = render_markdown(payload)
    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    latest_json = out_dir / "latest_strategy_g3g4_breakdown.json"
    latest_md = out_dir / "latest_strategy_g3g4_breakdown.md"
    archive_dir = out_dir / "archive" / run_id
    archive_json = archive_dir / "strategy_g3g4_breakdown.json"
    archive_md = archive_dir / "strategy_g3g4_breakdown.md"

    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "archive_json": str(archive_json),
                "archive_md": str(archive_md),
                "no_decision": payload["no_decision"]["triggered"],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
