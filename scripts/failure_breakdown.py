#!/usr/bin/env python3
"""Decompose recurring failure causes for cvar-next autosearch experiments.

Outputs:
- latest_failure_breakdown.json
- latest_failure_breakdown.md
- archive/<run_id>/failure_breakdown.{json,md}
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

CYCLE_RE = re.compile(r"cycle(\d+)")


@dataclass
class CycleSummary:
    cycle_name: str
    cycle_index: int
    generated_at: str
    completed_runs: int
    failed_runs: int
    champion: str
    transfer_pass: str
    challengers: int
    evaluated_challengers: int
    main_bindingness_mean: Optional[float]
    transfer_bindingness: Optional[float]
    main_gate_fail_counts: Dict[str, int]
    transfer_gate_fail_counts: Dict[str, int]
    regime_fallback_ratio_mean: Optional[float]
    regime_numeric_warning_mean: Optional[float]
    candidate_survival_rate: Optional[float]
    regime_future_alignment_risk_mean: Optional[float]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Compute failure cause breakdown for completed cvar-next autosearch "
            "cycles and emit machine+human readable summaries."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--experiments-root",
        default="data/training-data/cvar-next",
        help="Root directory containing cycle experiment folders.",
    )
    parser.add_argument(
        "--cycle-pattern",
        default="cvar24-autosearch-live-cycle*",
        help="Glob pattern under experiments-root for cycle folders.",
    )
    parser.add_argument(
        "--min-completed-runs",
        type=int,
        default=24,
        help="Only include cycles with completedRuns >= this threshold.",
    )
    parser.add_argument(
        "--windows",
        default="8,20,30",
        help="Comma-separated windows to summarize (e.g. 8,20,30).",
    )
    parser.add_argument(
        "--sample-cycles",
        type=int,
        default=12,
        help="How many latest cycles to include in markdown detail table.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy-watch/analysis",
        help="Output directory for latest/archive reports.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files; print JSON payload only.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (root / path).resolve()


def parse_bool(raw: Any) -> Optional[bool]:
    text = str(raw or "").strip().lower()
    if not text:
        return None
    if text in {"true", "1", "yes", "y"}:
        return True
    if text in {"false", "0", "no", "n"}:
        return False
    return None


def parse_float(raw: Any) -> Optional[float]:
    try:
        text = str(raw or "").strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def parse_windows(raw: str) -> List[int]:
    out: List[int] = []
    for chunk in str(raw or "").split(","):
        text = chunk.strip()
        if not text:
            continue
        try:
            value = int(text)
        except ValueError:
            continue
        if value > 0:
            out.append(value)
    deduped: List[int] = []
    seen = set()
    for value in out:
        if value in seen:
            continue
        seen.add(value)
        deduped.append(value)
    return deduped or [8, 20, 30]


def cycle_index(path: Path) -> int:
    match = CYCLE_RE.search(path.name)
    return int(match.group(1)) if match else -1


def read_csv_rows(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", newline="") as fh:
            return list(csv.DictReader(fh))
    except Exception:
        return []


def parse_decision_value(text: str, key: str) -> str:
    pattern = rf"- {re.escape(key)}: `([^`]+)`"
    match = re.search(pattern, text)
    return match.group(1).strip() if match else ""


def parse_cycle(path: Path, min_completed_runs: int) -> Optional[CycleSummary]:
    decision_path = path / "decision.md"
    if not decision_path.exists():
        return None
    try:
        decision_text = decision_path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return None

    completed_raw = parse_decision_value(decision_text, "completedRuns")
    failed_raw = parse_decision_value(decision_text, "failedRuns")
    generated_at = parse_decision_value(decision_text, "generatedAt")
    champion = parse_decision_value(decision_text, "champion")
    transfer_pass = parse_decision_value(decision_text, "transferPass")

    try:
        completed_runs = int(completed_raw or "0")
    except ValueError:
        completed_runs = 0
    try:
        failed_runs = int(failed_raw or "0")
    except ValueError:
        failed_runs = 0

    if completed_runs < int(min_completed_runs):
        return None

    main_rows = read_csv_rows(path / "board_main_aggregate.csv")
    mixed_rows = read_csv_rows(path / "board_mixed_aggregate.csv")

    main_gate_fail_counts: Dict[str, int] = {}
    challengers = 0
    evaluated_challengers = 0
    eligible_challengers = 0
    main_bindingness_values: List[float] = []
    regime_fallback_values: List[float] = []
    regime_numeric_warning_values: List[float] = []
    regime_future_alignment_risk_values: List[float] = []
    for row in main_rows:
        if str(row.get("board", "")).strip().lower() != "main":
            continue
        config_id = str(row.get("config_id", "")).strip()
        if not config_id or config_id == "H0":
            continue
        challengers += 1
        gate_results: List[Optional[bool]] = []
        for key, value in row.items():
            if not key.startswith("gate_pass_"):
                continue
            is_pass = parse_bool(value)
            gate_results.append(is_pass)
            if is_pass is False:
                main_gate_fail_counts[key] = main_gate_fail_counts.get(key, 0) + 1
        if any(v is not None for v in gate_results):
            evaluated_challengers += 1
            eligible_flag = parse_bool(row.get("eligible"))
            if eligible_flag is True:
                eligible_challengers += 1
            bindingness = parse_float(row.get("gate_bindingness_ratio"))
            if bindingness is not None:
                main_bindingness_values.append(bindingness)
            regime_fallback = parse_float(row.get("regime_fallback_ratio_mean"))
            if regime_fallback is not None:
                regime_fallback_values.append(regime_fallback)
            regime_numeric_warning = parse_float(row.get("regime_numeric_warning_mean"))
            if regime_numeric_warning is not None:
                regime_numeric_warning_values.append(regime_numeric_warning)
            future_alignment_risk = parse_float(
                row.get("regime_future_alignment_risk_mean")
            )
            if future_alignment_risk is not None:
                regime_future_alignment_risk_values.append(future_alignment_risk)

    transfer_gate_fail_counts: Dict[str, int] = {}
    transfer_bindingness: Optional[float] = None
    for row in mixed_rows:
        if str(row.get("config_id", "")).strip() != "S1":
            continue
        for key, value in row.items():
            if not key.startswith("gate_pass_"):
                continue
            is_pass = parse_bool(value)
            if is_pass is False:
                transfer_gate_fail_counts[key] = (
                    transfer_gate_fail_counts.get(key, 0) + 1
                )
        transfer_bindingness = parse_float(row.get("gate_bindingness_ratio"))
        break

    main_bindingness_mean = (
        round(sum(main_bindingness_values) / len(main_bindingness_values), 4)
        if main_bindingness_values
        else None
    )
    regime_fallback_ratio_mean = (
        round(sum(regime_fallback_values) / len(regime_fallback_values), 6)
        if regime_fallback_values
        else None
    )
    regime_numeric_warning_mean = (
        round(sum(regime_numeric_warning_values) / len(regime_numeric_warning_values), 6)
        if regime_numeric_warning_values
        else None
    )
    candidate_survival_rate = (
        round(eligible_challengers / evaluated_challengers, 6)
        if evaluated_challengers > 0
        else None
    )
    regime_future_alignment_risk_mean = (
        round(
            sum(regime_future_alignment_risk_values)
            / len(regime_future_alignment_risk_values),
            6,
        )
        if regime_future_alignment_risk_values
        else None
    )

    return CycleSummary(
        cycle_name=path.name,
        cycle_index=cycle_index(path),
        generated_at=generated_at,
        completed_runs=completed_runs,
        failed_runs=failed_runs,
        champion=champion,
        transfer_pass=transfer_pass,
        challengers=challengers,
        evaluated_challengers=evaluated_challengers,
        main_bindingness_mean=main_bindingness_mean,
        transfer_bindingness=transfer_bindingness,
        main_gate_fail_counts=main_gate_fail_counts,
        transfer_gate_fail_counts=transfer_gate_fail_counts,
        regime_fallback_ratio_mean=regime_fallback_ratio_mean,
        regime_numeric_warning_mean=regime_numeric_warning_mean,
        candidate_survival_rate=candidate_survival_rate,
        regime_future_alignment_risk_mean=regime_future_alignment_risk_mean,
    )


def sorted_fail_ratio(
    counts: Dict[str, int],
    denom: int,
) -> Dict[str, float]:
    if denom <= 0:
        denom = 1
    items = sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    return {key: round(value / denom, 4) for key, value in items}


def top_keys(items: Dict[str, float], top_n: int = 3) -> List[str]:
    return [key for key, _ in list(items.items())[:top_n]]


def metric_trend(values: Sequence[float], eps: float) -> str:
    if len(values) < 2:
        return "n/a"
    delta = float(values[-1] - values[0])
    if delta > eps:
        return "up"
    if delta < -eps:
        return "down"
    return "stable"


def infer_notes(
    champion_h0_ratio: float,
    transfer_false_ratio: float,
    main_bindingness_mean: Optional[float],
    transfer_bindingness_mean: Optional[float],
    main_fail_ratio: Dict[str, float],
    transfer_fail_ratio: Dict[str, float],
) -> List[str]:
    notes: List[str] = []
    if champion_h0_ratio >= 0.6:
        notes.append("主榜候选多数无法通过门槛，策略质量提升尚未形成稳定可晋级候选。")
    if transfer_false_ratio >= 0.8:
        notes.append("副榜 transfer 持续失败，跨源泛化/一致性是当前首要瓶颈。")
    if main_bindingness_mean is not None and main_bindingness_mean >= 0.40:
        notes.append(
            "主榜平均门控绑定度较高（>=0.40），说明候选常被多门槛同时卡住，需做正交方向改造而非阈值微调。"
        )
    if transfer_bindingness_mean is not None and transfer_bindingness_mean >= 0.40:
        notes.append(
            "transfer 门控绑定度高，跨源迁移失败通常是结构性问题，不是单指标噪声。"
        )
    if main_fail_ratio:
        tops = top_keys(main_fail_ratio, top_n=2)
        if tops:
            notes.append(
                "主榜最常失败门槛: " + ", ".join(tops) + "，应优先围绕这两项设计实验。"
            )
    if transfer_fail_ratio:
        tops = top_keys(transfer_fail_ratio, top_n=2)
        notes.append("transfer 失败主因: " + ", ".join(tops) + "。")
    return notes


def summarize_window(cycles: Sequence[CycleSummary], window: int) -> Dict[str, Any]:
    subset = list(cycles[-window:]) if len(cycles) > window else list(cycles)
    total = len(subset)
    if total <= 0:
        return {
            "window": window,
            "actual_cycles": 0,
            "champion_h0_ratio": 0.0,
            "transfer_false_ratio": 0.0,
            "main_gate_fail_ratio": {},
            "transfer_gate_fail_ratio": {},
            "regime_fallback_ratio_mean": None,
            "regime_numeric_warning_mean": None,
            "candidate_survival_rate_mean": None,
            "regime_future_alignment_risk_mean": None,
            "regime_fallback_ratio_trend": "n/a",
            "regime_numeric_warning_trend": "n/a",
            "candidate_survival_rate_trend": "n/a",
            "regime_future_alignment_risk_trend": "n/a",
            "notes": ["样本为空。"],
        }

    champion_h0 = 0
    transfer_false = 0
    challengers_total = 0
    main_counts: Dict[str, int] = {}
    transfer_counts: Dict[str, int] = {}
    transfer_rows = 0
    main_bindingness_weighted_sum = 0.0
    main_bindingness_weight = 0
    transfer_bindingness_values: List[float] = []
    regime_fallback_values: List[float] = []
    regime_numeric_warning_values: List[float] = []
    candidate_survival_values: List[float] = []
    regime_future_alignment_risk_values: List[float] = []

    for row in subset:
        if row.champion == "H0":
            champion_h0 += 1
        if str(row.transfer_pass).strip().lower() == "false":
            transfer_false += 1

        challengers_total += row.evaluated_challengers
        if row.main_bindingness_mean is not None and row.evaluated_challengers > 0:
            main_bindingness_weighted_sum += (
                row.main_bindingness_mean * row.evaluated_challengers
            )
            main_bindingness_weight += row.evaluated_challengers
        for key, value in row.main_gate_fail_counts.items():
            main_counts[key] = main_counts.get(key, 0) + value

        if row.transfer_gate_fail_counts:
            transfer_rows += 1
            for key, value in row.transfer_gate_fail_counts.items():
                transfer_counts[key] = transfer_counts.get(key, 0) + value
        if row.transfer_bindingness is not None:
            transfer_bindingness_values.append(row.transfer_bindingness)
        if row.regime_fallback_ratio_mean is not None:
            regime_fallback_values.append(float(row.regime_fallback_ratio_mean))
        if row.regime_numeric_warning_mean is not None:
            regime_numeric_warning_values.append(float(row.regime_numeric_warning_mean))
        if row.candidate_survival_rate is not None:
            candidate_survival_values.append(float(row.candidate_survival_rate))
        if row.regime_future_alignment_risk_mean is not None:
            regime_future_alignment_risk_values.append(
                float(row.regime_future_alignment_risk_mean)
            )

    main_bindingness_mean = (
        round(main_bindingness_weighted_sum / main_bindingness_weight, 4)
        if main_bindingness_weight > 0
        else None
    )
    transfer_bindingness_mean = (
        round(sum(transfer_bindingness_values) / len(transfer_bindingness_values), 4)
        if transfer_bindingness_values
        else None
    )

    main_fail_ratio = sorted_fail_ratio(main_counts, challengers_total)
    transfer_fail_ratio = sorted_fail_ratio(
        transfer_counts,
        transfer_rows if transfer_rows > 0 else total,
    )
    champion_h0_ratio = round(champion_h0 / total, 4)
    transfer_false_ratio = round(transfer_false / total, 4)
    notes = infer_notes(
        champion_h0_ratio=champion_h0_ratio,
        transfer_false_ratio=transfer_false_ratio,
        main_bindingness_mean=main_bindingness_mean,
        transfer_bindingness_mean=transfer_bindingness_mean,
        main_fail_ratio=main_fail_ratio,
        transfer_fail_ratio=transfer_fail_ratio,
    )
    regime_fallback_ratio_mean = (
        round(sum(regime_fallback_values) / len(regime_fallback_values), 6)
        if regime_fallback_values
        else None
    )
    regime_numeric_warning_mean = (
        round(sum(regime_numeric_warning_values) / len(regime_numeric_warning_values), 6)
        if regime_numeric_warning_values
        else None
    )
    candidate_survival_rate_mean = (
        round(sum(candidate_survival_values) / len(candidate_survival_values), 6)
        if candidate_survival_values
        else None
    )
    regime_future_alignment_risk_mean = (
        round(
            sum(regime_future_alignment_risk_values)
            / len(regime_future_alignment_risk_values),
            6,
        )
        if regime_future_alignment_risk_values
        else None
    )
    regime_fallback_ratio_trend = metric_trend(regime_fallback_values, eps=0.01)
    regime_numeric_warning_trend = metric_trend(regime_numeric_warning_values, eps=0.001)
    candidate_survival_rate_trend = metric_trend(candidate_survival_values, eps=0.01)
    regime_future_alignment_risk_trend = metric_trend(
        regime_future_alignment_risk_values, eps=0.001
    )
    if (
        isinstance(regime_fallback_ratio_mean, float)
        and regime_fallback_ratio_mean >= 0.30
    ):
        notes.append("regime fallback 比率偏高（>=0.30），建议优先检查聚类稳定性与样本质量。")
    if (
        isinstance(candidate_survival_rate_mean, float)
        and candidate_survival_rate_mean < 0.34
    ):
        notes.append("挑战者生存率偏低（<0.34），主榜候选质量分布需要优化。")

    return {
        "window": window,
        "actual_cycles": total,
        "champion_h0_ratio": champion_h0_ratio,
        "transfer_false_ratio": transfer_false_ratio,
        "main_bindingness_mean": main_bindingness_mean,
        "transfer_bindingness_mean": transfer_bindingness_mean,
        "evaluated_challengers": challengers_total,
        "main_gate_fail_ratio": main_fail_ratio,
        "transfer_gate_fail_ratio": transfer_fail_ratio,
        "regime_fallback_ratio_mean": regime_fallback_ratio_mean,
        "regime_numeric_warning_mean": regime_numeric_warning_mean,
        "candidate_survival_rate_mean": candidate_survival_rate_mean,
        "regime_future_alignment_risk_mean": regime_future_alignment_risk_mean,
        "regime_fallback_ratio_trend": regime_fallback_ratio_trend,
        "regime_numeric_warning_trend": regime_numeric_warning_trend,
        "candidate_survival_rate_trend": candidate_survival_rate_trend,
        "regime_future_alignment_risk_trend": regime_future_alignment_risk_trend,
        "notes": notes,
    }


def cycle_row_for_markdown(cycle: CycleSummary) -> Dict[str, Any]:
    main_top = ",".join(top_keys(sorted_fail_ratio(cycle.main_gate_fail_counts, 1), 2))
    transfer_top = ",".join(
        top_keys(sorted_fail_ratio(cycle.transfer_gate_fail_counts, 1), 2)
    )
    return {
        "cycle": cycle.cycle_name,
        "champion": cycle.champion or "n/a",
        "transfer_pass": cycle.transfer_pass or "n/a",
        "evaluated_challengers": cycle.evaluated_challengers,
        "main_bindingness_mean": cycle.main_bindingness_mean,
        "transfer_bindingness": cycle.transfer_bindingness,
        "regime_fallback_ratio_mean": cycle.regime_fallback_ratio_mean,
        "regime_numeric_warning_mean": cycle.regime_numeric_warning_mean,
        "candidate_survival_rate": cycle.candidate_survival_rate,
        "regime_future_alignment_risk_mean": cycle.regime_future_alignment_risk_mean,
        "main_top_fail": main_top or "-",
        "transfer_top_fail": transfer_top or "-",
    }


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = [
        "# Strategy Failure Breakdown",
        "",
        f"- generatedAt: `{payload.get('generated_at', '')}`",
        f"- experimentsRoot: `{payload.get('experiments_root', '')}`",
        f"- cyclePattern: `{payload.get('cycle_pattern', '')}`",
        f"- totalCompletedCycles: `{payload.get('total_completed_cycles', 0)}`",
        "",
        "## Window Summary",
        "",
        "| window | actualCycles | evaluatedChallengers | championH0Ratio | transferFalseRatio | mainBindMean | transferBindMean | fallbackMean | numericWarnMean | survivalMean | futureRiskMean | fallbackTrend | survivalTrend | mainTopFail | transferTopFail |",
        "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|",
    ]
    for row in payload.get("windows", []):
        main_top = ",".join(top_keys(row.get("main_gate_fail_ratio", {}), 2)) or "-"
        transfer_top = (
            ",".join(top_keys(row.get("transfer_gate_fail_ratio", {}), 2)) or "-"
        )
        main_bind = row.get("main_bindingness_mean")
        transfer_bind = row.get("transfer_bindingness_mean")
        fallback_mean = row.get("regime_fallback_ratio_mean")
        numeric_warn_mean = row.get("regime_numeric_warning_mean")
        survival_mean = row.get("candidate_survival_rate_mean")
        future_risk_mean = row.get("regime_future_alignment_risk_mean")
        main_bind_text = (
            f"{float(main_bind):.4f}" if isinstance(main_bind, (int, float)) else "n/a"
        )
        transfer_bind_text = (
            f"{float(transfer_bind):.4f}"
            if isinstance(transfer_bind, (int, float))
            else "n/a"
        )
        fallback_text = (
            f"{float(fallback_mean):.4f}"
            if isinstance(fallback_mean, (int, float))
            else "n/a"
        )
        numeric_warn_text = (
            f"{float(numeric_warn_mean):.4f}"
            if isinstance(numeric_warn_mean, (int, float))
            else "n/a"
        )
        survival_text = (
            f"{float(survival_mean):.4f}"
            if isinstance(survival_mean, (int, float))
            else "n/a"
        )
        future_risk_text = (
            f"{float(future_risk_mean):.4f}"
            if isinstance(future_risk_mean, (int, float))
            else "n/a"
        )
        lines.append(
            f"| {row.get('window', 0)} | {row.get('actual_cycles', 0)} | "
            f"{row.get('evaluated_challengers', 0)} | "
            f"{row.get('champion_h0_ratio', 0.0):.4f} | "
            f"{row.get('transfer_false_ratio', 0.0):.4f} | "
            f"{main_bind_text} | {transfer_bind_text} | "
            f"{fallback_text} | {numeric_warn_text} | {survival_text} | {future_risk_text} | "
            f"{row.get('regime_fallback_ratio_trend', 'n/a')} | "
            f"{row.get('candidate_survival_rate_trend', 'n/a')} | "
            f"{main_top} | {transfer_top} |"
        )

    lines.extend(["", "## Notes", ""])
    for row in payload.get("windows", []):
        lines.append(
            f"### Window {row.get('window', 0)} (actual {row.get('actual_cycles', 0)})"
        )
        notes = row.get("notes", [])
        if not notes:
            lines.append("- 无。")
        else:
            for note in notes:
                lines.append(f"- {note}")
        lines.append("")

    lines.extend(
        [
            "## Latest Cycles",
            "",
            "| cycle | champion | transferPass | evaluatedChallengers | mainBind | transferBind | fallbackMean | numericWarnMean | survival | futureRisk | mainTopFail | transferTopFail |",
            "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for row in payload.get("latest_cycles", []):
        main_bind = row.get("main_bindingness_mean")
        transfer_bind = row.get("transfer_bindingness")
        fallback_mean = row.get("regime_fallback_ratio_mean")
        numeric_warn_mean = row.get("regime_numeric_warning_mean")
        survival_rate = row.get("candidate_survival_rate")
        future_risk = row.get("regime_future_alignment_risk_mean")
        main_bind_text = (
            f"{float(main_bind):.4f}" if isinstance(main_bind, (int, float)) else "n/a"
        )
        transfer_bind_text = (
            f"{float(transfer_bind):.4f}"
            if isinstance(transfer_bind, (int, float))
            else "n/a"
        )
        fallback_text = (
            f"{float(fallback_mean):.4f}"
            if isinstance(fallback_mean, (int, float))
            else "n/a"
        )
        numeric_warn_text = (
            f"{float(numeric_warn_mean):.4f}"
            if isinstance(numeric_warn_mean, (int, float))
            else "n/a"
        )
        survival_text = (
            f"{float(survival_rate):.4f}"
            if isinstance(survival_rate, (int, float))
            else "n/a"
        )
        future_risk_text = (
            f"{float(future_risk):.4f}"
            if isinstance(future_risk, (int, float))
            else "n/a"
        )
        lines.append(
            f"| {row.get('cycle', '')} | {row.get('champion', '')} | "
            f"{row.get('transfer_pass', '')} | {row.get('evaluated_challengers', 0)} | "
            f"{main_bind_text} | {transfer_bind_text} | "
            f"{fallback_text} | {numeric_warn_text} | {survival_text} | {future_risk_text} | "
            f"{row.get('main_top_fail', '')} | {row.get('transfer_top_fail', '')} |"
        )
    lines.append("")
    return "\n".join(lines)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    experiments_root = resolve_path(repo_root, args.experiments_root)
    out_dir = resolve_path(repo_root, args.out_dir)
    windows = parse_windows(args.windows)

    cycle_dirs = sorted(
        [p for p in experiments_root.glob(args.cycle_pattern) if p.is_dir()],
        key=lambda p: (cycle_index(p), p.name),
    )
    parsed: List[CycleSummary] = []
    for cycle_path in cycle_dirs:
        row = parse_cycle(cycle_path, min_completed_runs=int(args.min_completed_runs))
        if row is not None:
            parsed.append(row)

    ts = now_utc()
    run_id = ts.strftime("%Y%m%dT%H%M%SZ")
    window_rows = [summarize_window(parsed, window) for window in windows]
    latest_cycles = [
        cycle_row_for_markdown(row)
        for row in (parsed[-args.sample_cycles :] if args.sample_cycles > 0 else parsed)
    ]

    payload = {
        "generated_at": iso(ts),
        "run_id": run_id,
        "experiments_root": str(experiments_root),
        "cycle_pattern": args.cycle_pattern,
        "min_completed_runs": int(args.min_completed_runs),
        "total_completed_cycles": len(parsed),
        "windows": window_rows,
        "latest_cycles": latest_cycles,
    }
    markdown = render_markdown(payload)

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    latest_json = out_dir / "latest_failure_breakdown.json"
    latest_md = out_dir / "latest_failure_breakdown.md"
    archive_json = out_dir / "archive" / run_id / "failure_breakdown.json"
    archive_md = out_dir / "archive" / run_id / "failure_breakdown.md"

    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "out_dir": str(out_dir),
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "completed_cycles": len(parsed),
                "windows": windows,
                "dry_run": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
