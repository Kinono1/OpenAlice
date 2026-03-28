#!/usr/bin/env python3
"""Phase-B family search with gate-aware ranking for OpenAlice G3/G4 recovery.

Goal:
- Expand candidate search beyond trend-only into mixed families
  (trend/meanReversion/breakout/ensemble).
- Keep hard gates unchanged.
- Rank trials with gate-aware priority:
  passCount > wfoPassCount > fewer release-gate failures > better DSR/FDR/PBO.

Outputs:
- latest_phaseb_family_search.json/.md
- archive/<run_id>/phaseb_family_search.json/.md
- latest_phaseb_recommended_candidates.json
- archive/<run_id>/phaseb_recommended_candidates.json
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import random
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run phase-B mixed-family candidate search with gate-aware ranking."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--base-candidates",
        default="docs/research/strategy_candidates.v1.json",
        help="Base candidates config used as template.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy/analysis/g3g4",
        help="Output directory for latest/archive reports.",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id. Default uses UTC timestamp.",
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=24,
        help="Number of trial candidate-sets.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260303,
        help="RNG seed for candidate sampling.",
    )
    parser.add_argument(
        "--pnpm-bin",
        default="pnpm",
        help="pnpm executable used to call strategy validation.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan/search only without calling strategy validation command.",
    )
    return parser.parse_args()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (root / p).resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def to_float(raw: Any, default: float) -> float:
    try:
        if raw is None:
            return default
        return float(raw)
    except Exception:
        return default


def to_int(raw: Any, default: int) -> int:
    try:
        if raw is None:
            return default
        return int(raw)
    except Exception:
        return default


def extract_thresholds(base_cfg: Dict[str, Any]) -> Dict[str, float]:
    thresholds = base_cfg.get("thresholds", {})
    if not isinstance(thresholds, dict):
        thresholds = {}
    return {
        "meanPboMax": to_float(thresholds.get("meanPboMax"), 0.2),
        "meanDsrProbabilityMin": to_float(
            thresholds.get("meanDsrProbabilityMin"), 0.5
        ),
        "fdrQMax": to_float(thresholds.get("fdrQMax"), 0.1),
    }


def build_family_pools() -> Dict[str, List[Dict[str, Any]]]:
    trend_pool: List[Dict[str, Any]] = []
    for fast in [16, 18, 20, 21, 22, 24, 28, 34]:
        for slow in [65, 70, 72, 75, 80, 89, 95, 100]:
            if fast >= slow:
                continue
            for allow_short in [True, False]:
                trend_pool.append(
                    {
                        "strategy": "trend",
                        "params": {
                            "trendFastPeriod": fast,
                            "trendSlowPeriod": slow,
                            "allowShort": allow_short,
                        },
                        "name": f"trend_{fast}_{slow}_{'ls' if allow_short else 'lo'}",
                    }
                )

    mr_pool: List[Dict[str, Any]] = []
    for rsi_period in [12, 14, 18]:
        for bb_period in [18, 20, 24]:
            for oversold, overbought in [(25, 70), (30, 70), (30, 75), (35, 75)]:
                for allow_short in [False, True]:
                    mr_pool.append(
                        {
                            "strategy": "meanReversion",
                            "params": {
                                "rsiPeriod": rsi_period,
                                "rsiOversold": oversold,
                                "rsiOverbought": overbought,
                                "bbPeriod": bb_period,
                                "bbStdDev": 2.0,
                                "allowShort": allow_short,
                            },
                            "name": (
                                f"mr_r{rsi_period}_bb{bb_period}_"
                                f"{oversold}_{overbought}_{'ls' if allow_short else 'lo'}"
                            ),
                        }
                    )

    breakout_pool: List[Dict[str, Any]] = []
    for breakout_period in [24, 36, 48, 60, 72]:
        for exit_period in [8, 12, 16, 20]:
            if exit_period >= breakout_period:
                continue
            for allow_short in [False, True]:
                breakout_pool.append(
                    {
                        "strategy": "breakout",
                        "params": {
                            "breakoutPeriod": breakout_period,
                            "breakoutExitPeriod": exit_period,
                            "allowShort": allow_short,
                        },
                        "name": (
                            f"breakout_{breakout_period}_{exit_period}_"
                            f"{'ls' if allow_short else 'lo'}"
                        ),
                    }
                )

    ensemble_pool: List[Dict[str, Any]] = []
    for threshold in [0.22, 0.3, 0.34, 0.4]:
        for allow_short in [False, True]:
            for tw, mw, bw in [(2, 1, 1), (3, 1, 1), (1, 2, 1), (1, 1, 2), (2, 2, 1)]:
                ensemble_pool.append(
                    {
                        "strategy": "ensemble",
                        "params": {
                            "allowShort": allow_short,
                            "trendFastPeriod": 20,
                            "trendSlowPeriod": 60,
                            "rsiPeriod": 14,
                            "rsiOversold": 30,
                            "rsiOverbought": 70,
                            "bbPeriod": 20,
                            "bbStdDev": 2.0,
                            "breakoutPeriod": 40,
                            "breakoutExitPeriod": 12,
                            "ensembleThreshold": threshold,
                            "ensembleWeights": {
                                "trend": tw,
                                "meanReversion": mw,
                                "breakout": bw,
                            },
                        },
                        "name": (
                            f"ensemble_t{threshold}_{tw}{mw}{bw}_"
                            f"{'ls' if allow_short else 'lo'}"
                        ),
                    }
                )

    return {
        "trend": trend_pool,
        "meanReversion": mr_pool,
        "breakout": breakout_pool,
        "ensemble": ensemble_pool,
    }


def build_templates() -> List[Tuple[str, str, str]]:
    # Phase-B (minimal expansion): keep two trend legs and inject at most one non-trend leg.
    return [
        ("trend", "trend", "trend"),
        ("trend", "trend", "meanReversion"),
        ("trend", "trend", "breakout"),
        ("trend", "trend", "ensemble"),
        ("trend", "trend", "trend"),
        ("trend", "trend", "meanReversion"),
        ("trend", "trend", "breakout"),
        ("trend", "trend", "ensemble"),
    ]


def generate_trial_candidates(
    *,
    rng: random.Random,
    pools: Dict[str, List[Dict[str, Any]]],
    template: Sequence[str],
    trial_index: int,
) -> List[Dict[str, Any]]:
    chosen: List[Dict[str, Any]] = []
    seen: set[Tuple[str, str]] = set()
    for slot, family in enumerate(template, start=1):
        if family not in pools or not pools[family]:
            raise ValueError(f"family pool missing: {family}")
        candidate = rng.choice(pools[family])
        key = (family, json.dumps(candidate.get("params", {}), sort_keys=True))
        retries = 0
        while key in seen and retries < 20:
            candidate = rng.choice(pools[family])
            key = (family, json.dumps(candidate.get("params", {}), sort_keys=True))
            retries += 1
        seen.add(key)
        chosen.append(
            {
                "strategyId": f"PB{trial_index + 1:03d}_{slot}",
                "strategyName": candidate["name"],
                "strategy": candidate["strategy"],
                "params": candidate["params"],
            }
        )
    return chosen


def run_validation(
    *,
    repo_root: Path,
    pnpm_bin: str,
    candidates_path: Path,
    runs_out: Path,
    verdict_out: Path,
    release_out: Path,
) -> Dict[str, Any]:
    argv = [
        pnpm_bin,
        "tsx",
        "scripts/run_strategy_mvp_validation.ts",
        "--candidates",
        str(candidates_path),
        "--output",
        str(runs_out),
        "--verdict-output",
        str(verdict_out),
        "--release-gate-status-path",
        str(release_out),
    ]
    proc = subprocess.run(
        argv,
        cwd=str(repo_root),
        text=True,
        capture_output=True,
        check=False,
    )
    return {
        "command": " ".join(shlex.quote(part) for part in argv),
        "exitCode": proc.returncode,
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-4000:],
    }


def rank_key(row: Dict[str, Any]) -> Tuple[float, ...]:
    return (
        float(to_int(row.get("passCount"), 0)),
        float(to_int(row.get("wfoPassCount"), 0)),
        -to_float(row.get("wfoFailureDensity"), 1.0),
        -to_float(row.get("hardGapMagnitude"), float("inf")),
        float(-to_int(row.get("releaseGateFailCount"), 0)),
        to_float(row.get("hardGapScore"), float("-inf")),
        to_float(row.get("meanDsrProbability"), -1.0),
        -to_float(row.get("fdrQ"), 9.0),
        -to_float(row.get("meanPbo"), 9.0),
        to_float(row.get("meanSharpe"), -9.0),
    )


def summarize_trial(
    *,
    trial_id: int,
    template: Sequence[str],
    is_baseline_anchor: bool,
    candidates: List[Dict[str, Any]],
    thresholds: Dict[str, float],
    command_info: Dict[str, Any],
    runs_payload: Optional[Dict[str, Any]],
    verdict_payload: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    rows = []
    champion = {}
    if isinstance(runs_payload, dict):
        raw_rows = runs_payload.get("candidates", [])
        if isinstance(raw_rows, list):
            rows = [row for row in raw_rows if isinstance(row, dict)]
        raw_champion = runs_payload.get("champion", {})
        if isinstance(raw_champion, dict):
            champion = raw_champion

    pass_count = sum(1 for row in rows if str(row.get("status")) == "pass")
    wfo_pass_count = sum(1 for row in rows if bool(row.get("wfoGatePassed")))
    wfo_fail_count = max(0, len(rows) - wfo_pass_count)
    wfo_failure_density = (
        float(wfo_fail_count) / float(len(rows)) if rows else 1.0
    )
    release_gate_fail_count = sum(
        1 for row in rows if not bool((row.get("releaseGate") or {}).get("allowPaperTrading"))
    )
    reason_codes = []
    agg = {}
    result = "UNKNOWN"
    if isinstance(verdict_payload, dict):
        agg = verdict_payload.get("aggregateMetrics", {}) or {}
        reason_codes = verdict_payload.get("reasonCodes", []) or []
        result = str(verdict_payload.get("result", "UNKNOWN"))

    sharpe_values = [
        to_float((row.get("backtestMetrics") or {}).get("sharpe"), float("nan"))
        for row in rows
    ]
    sharpe_values = [v for v in sharpe_values if v == v]  # drop nan
    mean_sharpe = sum(sharpe_values) / len(sharpe_values) if sharpe_values else None
    mean_pbo = to_float(agg.get("meanPbo"), float("nan"))
    mean_dsr = to_float(agg.get("meanDsrProbability"), float("nan"))
    fdr_q = to_float(agg.get("fdrQ"), float("nan"))
    has_finite_hard_metrics = all(
        math.isfinite(value) for value in (mean_pbo, mean_dsr, fdr_q)
    )
    if has_finite_hard_metrics:
        pbo_gap = max(0.0, mean_pbo - thresholds["meanPboMax"])
        dsr_gap = max(0.0, thresholds["meanDsrProbabilityMin"] - mean_dsr)
        fdr_gap = max(0.0, fdr_q - thresholds["fdrQMax"])
        hard_gap_magnitude = pbo_gap + dsr_gap + fdr_gap
        hard_gap_score = -hard_gap_magnitude
    else:
        pbo_gap = None
        dsr_gap = None
        fdr_gap = None
        hard_gap_magnitude = None
        hard_gap_score = float("-inf")

    summary = {
        "trial": trial_id,
        "template": list(template),
        "isBaselineAnchor": is_baseline_anchor,
        "result": result,
        "meanPbo": agg.get("meanPbo"),
        "meanDsrProbability": agg.get("meanDsrProbability"),
        "fdrQ": agg.get("fdrQ"),
        "meanSharpe": mean_sharpe,
        "hardGapScore": hard_gap_score,
        "thresholdGaps": {
            "meanPboGap": pbo_gap,
            "meanDsrProbabilityGap": dsr_gap,
            "fdrQGap": fdr_gap,
        },
        "passCount": pass_count,
        "wfoPassCount": wfo_pass_count,
        "wfoFailCount": wfo_fail_count,
        "wfoFailureDensity": wfo_failure_density,
        "hardGapMagnitude": hard_gap_magnitude,
        "releaseGateFailCount": release_gate_fail_count,
        "reasonCodes": reason_codes,
        "command": command_info,
        "champion": champion,
        "candidates": candidates,
    }
    return summary


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Phase-B Family Search Report")
    lines.append("")
    lines.append(f"- run_id: `{payload.get('run_id', '')}`")
    lines.append(f"- generated_at: `{payload.get('generated_at', '')}`")
    lines.append(f"- dry_run: `{payload.get('dry_run', False)}`")
    lines.append(f"- generated_trials: `{payload.get('generatedTrials', 0)}`")
    lines.append(f"- total_trials: `{payload.get('totalTrials', 0)}`")
    lines.append(f"- baseline_anchor_trial: `{payload.get('baselineAnchorTrial', 0)}`")
    summary = payload.get("summary", {})
    lines.append(f"- valid_trials: `{summary.get('validTrials', 0)}`")
    lines.append(f"- go_trials: `{summary.get('goTrials', 0)}`")
    lines.append("")
    lines.append("## Top Trials (Gate-Aware)")
    lines.append("")
    lines.append(
        "| rank | trial | baseline | result | passCount | wfoPass | releaseFail | hardGapScore | meanPbo | meanDsrProb | fdrQ | meanSharpe | template |"
    )
    lines.append("|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|")
    for idx, row in enumerate(payload.get("topTrials", []), start=1):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(idx),
                    str(row.get("trial", "")),
                    "yes" if bool(row.get("isBaselineAnchor")) else "no",
                    str(row.get("result", "")),
                    str(row.get("passCount", "")),
                    str(row.get("wfoPassCount", "")),
                    str(row.get("releaseGateFailCount", "")),
                    str(row.get("hardGapScore", "")),
                    str(row.get("meanPbo", "")),
                    str(row.get("meanDsrProbability", "")),
                    str(row.get("fdrQ", "")),
                    str(row.get("meanSharpe", "")),
                    ",".join(row.get("template", [])),
                ]
            )
            + " |"
        )
    lines.append("")
    best = payload.get("bestTrial", {})
    if isinstance(best, dict) and best:
        lines.append("## Recommended Candidate Set")
        lines.append("")
        lines.append(f"- trial: `{best.get('trial')}`")
        lines.append(f"- baseline_anchor: `{bool(best.get('isBaselineAnchor'))}`")
        lines.append(f"- result: `{best.get('result')}`")
        lines.append(f"- hard_gap_score: `{best.get('hardGapScore')}`")
        lines.append(f"- reasonCodes: `{','.join(best.get('reasonCodes', []))}`")
        lines.append("")
        lines.append("| strategyId | strategy | strategyName |")
        lines.append("|---|---|---|")
        for row in best.get("candidates", []):
            lines.append(
                "| "
                + " | ".join(
                    [
                        str(row.get("strategyId", "")),
                        str(row.get("strategy", "")),
                        str(row.get("strategyName", "")),
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
    out_dir = resolve_path(repo_root, args.out_dir)
    archive_dir = out_dir / "archive" / run_id

    base_candidates_path = resolve_path(repo_root, args.base_candidates)
    base_cfg = read_json(base_candidates_path)
    if not isinstance(base_cfg, dict):
        raise ValueError("base candidates config must be a JSON object.")
    if to_int(args.trials, 0) <= 0:
        raise ValueError("--trials must be > 0")

    thresholds = extract_thresholds(base_cfg)
    pools = build_family_pools()
    templates = build_templates()
    rng = random.Random(args.seed)

    base_candidates_raw = base_cfg.get("candidates", [])
    if not isinstance(base_candidates_raw, list) or not base_candidates_raw:
        raise ValueError("base candidates config must include a non-empty candidates array.")

    trial_specs: List[Dict[str, Any]] = [
        {
            "trial": 0,
            "template": tuple("baseline" for _ in base_candidates_raw),
            "isBaselineAnchor": True,
            "candidates": copy.deepcopy(base_candidates_raw),
        }
    ]
    for i in range(args.trials):
        template = templates[i % len(templates)]
        generated_candidates = generate_trial_candidates(
            rng=rng,
            pools=pools,
            template=template,
            trial_index=i,
        )
        trial_specs.append(
            {
                "trial": i + 1,
                "template": template,
                "isBaselineAnchor": False,
                "candidates": generated_candidates,
            }
        )

    trial_rows: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="openalice-phaseb-family-search-") as temp_dir:
        tmp = Path(temp_dir)
        for spec in trial_specs:
            trial_id = to_int(spec.get("trial"), -1)
            template = list(spec.get("template", []))
            candidates = copy.deepcopy(spec.get("candidates", []))
            is_baseline_anchor = bool(spec.get("isBaselineAnchor"))
            cfg = copy.deepcopy(base_cfg)
            cfg["candidates"] = candidates

            candidate_path = tmp / f"phaseb_candidates_{trial_id:03d}.json"
            runs_path = tmp / f"phaseb_runs_{trial_id:03d}.json"
            verdict_path = tmp / f"phaseb_verdict_{trial_id:03d}.json"
            release_path = tmp / f"phaseb_release_{trial_id:03d}.json"
            candidate_path.write_text(
                json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )

            command_info = {
                "command": "",
                "exitCode": None,
                "stdoutTail": "",
                "stderrTail": "",
            }
            runs_payload: Optional[Dict[str, Any]] = None
            verdict_payload: Optional[Dict[str, Any]] = None

            if not args.dry_run:
                command_info = run_validation(
                    repo_root=repo_root,
                    pnpm_bin=args.pnpm_bin,
                    candidates_path=candidate_path,
                    runs_out=runs_path,
                    verdict_out=verdict_path,
                    release_out=release_path,
                )
                if runs_path.exists():
                    raw = read_json(runs_path)
                    if isinstance(raw, dict):
                        runs_payload = raw
                if verdict_path.exists():
                    raw = read_json(verdict_path)
                    if isinstance(raw, dict):
                        verdict_payload = raw

            row = summarize_trial(
                trial_id=trial_id,
                template=template,
                is_baseline_anchor=is_baseline_anchor,
                candidates=candidates,
                thresholds=thresholds,
                command_info=command_info,
                runs_payload=runs_payload,
                verdict_payload=verdict_payload,
            )
            trial_rows.append(row)

    valid_trials = [
        row for row in trial_rows if row.get("result") in ("GO", "NO_GO")
    ]
    ranked_trials = sorted(valid_trials, key=rank_key, reverse=True)
    top_trials = ranked_trials[:10]
    best_trial = top_trials[0] if top_trials else {}
    go_trials = sum(1 for row in valid_trials if row.get("result") == "GO")

    payload = {
        "schemaVersion": "strategy_phaseb_family_search.v1",
        "generated_at": iso(ts),
        "run_id": run_id,
        "dry_run": bool(args.dry_run),
        "seed": args.seed,
        "generatedTrials": args.trials,
        "totalTrials": len(trial_specs),
        "baselineAnchorTrial": 0,
        "baseCandidatesPath": str(base_candidates_path),
        "summary": {
            "validTrials": len(valid_trials),
            "goTrials": go_trials,
        },
        "bestTrial": best_trial,
        "topTrials": top_trials,
        "allTrials": trial_rows,
    }
    markdown = render_markdown(payload)

    latest_json = out_dir / "latest_phaseb_family_search.json"
    latest_md = out_dir / "latest_phaseb_family_search.md"
    archive_json = archive_dir / "phaseb_family_search.json"
    archive_md = archive_dir / "phaseb_family_search.md"
    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    if best_trial:
        best_cfg = copy.deepcopy(base_cfg)
        best_cfg["candidates"] = best_trial.get("candidates", [])
        rec_latest = out_dir / "latest_phaseb_recommended_candidates.json"
        rec_archive = archive_dir / "phaseb_recommended_candidates.json"
        write_json(rec_latest, best_cfg)
        write_json(rec_archive, best_cfg)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "archive_json": str(archive_json),
                "archive_md": str(archive_md),
                "valid_trials": len(valid_trials),
                "go_trials": go_trials,
                "best_trial": best_trial.get("trial"),
                "best_result": best_trial.get("result"),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
