#!/usr/bin/env python3
"""External benchmark harness for OpenAlice strategy evaluation.

This script normalizes benchmark outputs from external frameworks
(Freqtrade/Qlib/Hummingbot/others) into OpenAlice-like metrics and
applies main-board style gates against the latest completed H0 baseline.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import shutil
import statistics
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_MANIFEST = "data/research/external-benchmark/inputs/runs_manifest.json"
DEFAULT_OUT_DIR = "data/research/external-benchmark"
DEFAULT_EXPERIMENTS_ROOT = "data/training-data/cvar-next"
DEFAULT_CYCLE_PATTERN = "cvar24-autosearch-live-cycle*"

AGGREGATE_FIELDS = [
    "run_id",
    "framework",
    "strategy",
    "artifact_type",
    "artifact",
    "sample_size",
    "trained_symbols",
    "error_symbols",
    "robust_mean",
    "robust_std",
    "robust_ci_lb95",
    "robust_ci_ub95",
    "cost_mean",
    "net_median_mean",
    "net_trim10_mean",
    "lift_pos_mean",
    "turnover_mean",
    "error_ratio_mean",
    "gate_pass_robust_uplift",
    "gate_pass_robust_ci",
    "gate_pass_variance",
    "gate_pass_lift",
    "gate_pass_net_trim10",
    "gate_pass_error_ratio",
    "eligible",
    "notes",
]


@dataclass
class ParsedRun:
    run_id: str
    framework: str
    strategy: str
    artifact_type: str
    artifact_path: str
    records: List[Dict[str, Any]]
    notes: List[str]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Normalize external benchmark artifacts to OpenAlice-compatible metrics "
            "and compare against latest H0 baseline."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--manifest",
        default=DEFAULT_MANIFEST,
        help="Input manifest JSON path.",
    )
    parser.add_argument(
        "--out-dir",
        default=DEFAULT_OUT_DIR,
        help="Output directory.",
    )
    parser.add_argument(
        "--experiments-root",
        default=DEFAULT_EXPERIMENTS_ROOT,
        help="Path to cvar-next experiments root.",
    )
    parser.add_argument(
        "--cycle-pattern",
        default=DEFAULT_CYCLE_PATTERN,
        help="Glob pattern to find cycle experiment folders.",
    )
    parser.add_argument(
        "--baseline-cycle-dir",
        default="",
        help="Optional explicit baseline cycle directory (contains decision/board csv).",
    )
    parser.add_argument(
        "--min-completed-runs",
        type=int,
        default=24,
        help="Minimum completed runs for baseline auto-pick.",
    )
    parser.add_argument(
        "--bootstrap-samples",
        type=int,
        default=2000,
        help="Bootstrap sample count for CI.",
    )
    parser.add_argument(
        "--create-example-manifest",
        action="store_true",
        help="Create example manifest template and continue.",
    )
    parser.add_argument(
        "--probe-tools",
        action="store_true",
        help="Include local tool availability probe in output.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files; print JSON summary.",
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


def to_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        text = str(value).strip()
        if text == "":
            return None
        return float(text)
    except Exception:
        return None


def parse_bool(value: Any) -> Optional[bool]:
    if value is None:
        text = ""
    else:
        text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    return None


def trimmed_mean(values: Sequence[float], proportion: float = 0.10) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(float(v) for v in values)
    n = len(ordered)
    k = int(n * proportion)
    if n - 2 * k <= 0:
        core = ordered
    else:
        core = ordered[k : n - k]
    return float(sum(core) / len(core))


def bootstrap_ci(
    values: Sequence[float],
    confidence: float = 0.95,
    samples: int = 2000,
    seed: int = 42,
) -> Tuple[Optional[float], Optional[float]]:
    vals = [float(v) for v in values]
    if not vals:
        return None, None
    if len(vals) == 1:
        return vals[0], vals[0]
    rng = random.Random(seed)
    means: List[float] = []
    n = len(vals)
    for _ in range(max(1, int(samples))):
        draw = [vals[rng.randrange(n)] for __ in range(n)]
        means.append(float(sum(draw) / n))
    means.sort()
    alpha = 1.0 - confidence
    lo_idx = max(0, int((alpha / 2) * len(means)))
    hi_idx = min(len(means) - 1, int((1 - alpha / 2) * len(means)) - 1)
    return means[lo_idx], means[hi_idx]


def cycle_index(path: Path) -> int:
    name = path.name
    marker = "cycle"
    idx = name.find(marker)
    if idx < 0:
        return -1
    tail = name[idx + len(marker) :]
    digits = []
    for ch in tail:
        if ch.isdigit():
            digits.append(ch)
        else:
            break
    return int("".join(digits)) if digits else -1


def parse_decision_metric(decision_text: str, key: str) -> str:
    needle = f"- {key}: `"
    pos = decision_text.find(needle)
    if pos < 0:
        return ""
    start = pos + len(needle)
    end = decision_text.find("`", start)
    if end < 0:
        return ""
    return decision_text[start:end].strip()


def load_latest_baseline(
    experiments_root: Path,
    cycle_pattern: str,
    min_completed_runs: int,
    explicit_cycle_dir: Optional[Path],
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    warnings: List[str] = []
    if explicit_cycle_dir is not None:
        cycle_dirs = [explicit_cycle_dir]
    else:
        cycle_dirs = sorted(
            [p for p in experiments_root.glob(cycle_pattern) if p.is_dir()],
            key=cycle_index,
        )
    selected: Optional[Path] = None
    for cycle_dir in reversed(cycle_dirs):
        decision_path = cycle_dir / "decision.md"
        board_path = cycle_dir / "board_main_aggregate.csv"
        if not decision_path.exists() or not board_path.exists():
            continue
        try:
            decision = decision_path.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        completed = parse_decision_metric(decision, "completedRuns")
        try:
            completed_runs = int(completed or "0")
        except ValueError:
            completed_runs = 0
        if completed_runs < int(min_completed_runs):
            continue
        selected = cycle_dir
        break

    if selected is None:
        warnings.append("no completed cycle baseline found")
        return None, warnings

    board_path = selected / "board_main_aggregate.csv"
    try:
        with board_path.open("r", encoding="utf-8", newline="") as fh:
            rows = list(csv.DictReader(fh))
    except Exception as exc:
        warnings.append(f"failed to read baseline board csv: {exc}")
        return None, warnings

    h0 = None
    for row in rows:
        if str(row.get("config_id", "")).strip() == "H0":
            h0 = row
            break
    if h0 is None:
        warnings.append("baseline cycle has no H0 row")
        return None, warnings

    baseline = {
        "cycle_dir": str(selected),
        "robust_mean": to_float(h0.get("robust_mean")),
        "robust_ci_lb95": to_float(h0.get("robust_ci_lb95")),
        "robust_std": to_float(h0.get("robust_std")),
        "lift_pos_mean": to_float(h0.get("lift_pos_mean")),
        "net_trim10_mean": to_float(h0.get("net_trim10_mean")),
    }
    if baseline["robust_ci_lb95"] is None:
        baseline["robust_ci_lb95"] = baseline["robust_mean"]
    if baseline["robust_std"] is None:
        baseline["robust_std"] = 0.0
    if baseline["lift_pos_mean"] is None:
        baseline["lift_pos_mean"] = 0.0
    if baseline["net_trim10_mean"] is None:
        baseline["net_trim10_mean"] = 0.0
    if baseline["robust_mean"] is None:
        warnings.append("baseline H0 robust_mean missing")
    return baseline, warnings


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_csv(
    path: Path, rows: Sequence[Dict[str, Any]], fields: Sequence[str]
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(fields))
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def safe_get(row: Dict[str, Any], keys: Sequence[str]) -> Optional[Any]:
    for key in keys:
        if key in row and row.get(key) not in (None, ""):
            return row.get(key)
    return None


def normalize_net_pct(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    # Heuristic: small absolute value likely ratio, convert to percentage.
    if -3.0 <= value <= 3.0:
        return value * 100.0
    return value


def parse_generic_metrics_csv(path: Path) -> Tuple[List[Dict[str, Any]], List[str]]:
    notes: List[str] = []
    rows: List[Dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8", newline="") as fh:
            raw_rows = list(csv.DictReader(fh))
    except Exception as exc:
        return [], [f"failed to read csv: {exc}"]

    for idx, raw in enumerate(raw_rows, start=1):
        robust = to_float(
            safe_get(
                raw,
                [
                    "robust_cost_aware_utility",
                    "robust",
                    "robust_utility",
                    "utility_robust",
                ],
            )
        )
        cost = to_float(
            safe_get(
                raw,
                [
                    "cost_aware_utility",
                    "cost",
                    "cost_utility",
                ],
            )
        )
        net = to_float(
            safe_get(
                raw,
                [
                    "net_return_pct_after_cost",
                    "net_return_pct",
                    "net_return",
                    "return_pct_after_cost",
                ],
            )
        )
        net = normalize_net_pct(net)
        lift = to_float(
            safe_get(
                raw,
                [
                    "accuracy_lift",
                    "lift",
                    "winrate_lift",
                ],
            )
        )
        if lift is None:
            winrate = to_float(safe_get(raw, ["winrate", "win_rate_after_cost"]))
            if winrate is not None:
                if 0.0 <= winrate <= 1.0:
                    lift = winrate - 0.5
                else:
                    lift = (winrate / 100.0) - 0.5

        turnover = to_float(
            safe_get(
                raw,
                [
                    "turnover_per_bar",
                    "turnover",
                    "turnover_rate",
                ],
            )
        )
        error_flag = parse_bool(safe_get(raw, ["error", "error_flag"]))

        if None in (robust, cost, net, lift, turnover):
            notes.append(
                f"skip row {idx}: missing required metrics "
                "(robust/cost/net/lift/turnover)"
            )
            continue

        symbol = str(
            safe_get(raw, ["symbol", "pair", "instrument", "asset"]) or f"row{idx}"
        ).strip()
        rows.append(
            {
                "symbol": symbol,
                "robust_cost_aware_utility": float(robust),
                "cost_aware_utility": float(cost),
                "net_return_pct_after_cost": float(net),
                "accuracy_lift": float(lift),
                "turnover_per_bar": float(turnover),
                "error_flag": bool(error_flag is True),
            }
        )
    return rows, notes


def parse_freqtrade_backtest_json(
    path: Path,
    candle_count: int,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    notes: List[str] = [
        "freqtrade mapping uses approximate utility conversion from backtest stats"
    ]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [], [f"failed to read json: {exc}"]

    strategy_blocks: List[Tuple[str, Dict[str, Any]]] = []
    if isinstance(payload, dict) and isinstance(payload.get("strategy"), dict):
        for name, block in payload["strategy"].items():
            if isinstance(block, dict):
                strategy_blocks.append((str(name), block))
    elif isinstance(payload, dict):
        strategy_blocks.append(("default", payload))
    else:
        return [], ["unsupported freqtrade json structure"]

    rows: List[Dict[str, Any]] = []
    for strategy_name, block in strategy_blocks:
        pair_rows = block.get("results_per_pair")
        if not isinstance(pair_rows, list):
            notes.append(f"strategy {strategy_name}: missing results_per_pair")
            continue

        strategy_dd = to_float(
            safe_get(
                block,
                [
                    "max_drawdown_pct",
                    "max_drawdown_account",
                    "max_drawdown",
                ],
            )
        )
        if strategy_dd is not None and -3.0 <= strategy_dd <= 3.0:
            strategy_dd = strategy_dd * 100.0

        for idx, pair_row in enumerate(pair_rows, start=1):
            if not isinstance(pair_row, dict):
                continue
            symbol = str(
                safe_get(pair_row, ["key", "pair", "symbol"])
                or f"{strategy_name}:{idx}"
            ).strip()

            net = to_float(
                safe_get(
                    pair_row,
                    [
                        "profit_total_pct",
                        "total_profit_pct",
                        "profit_total",
                        "profit_mean_pct",
                    ],
                )
            )
            net = normalize_net_pct(net)

            winrate = to_float(safe_get(pair_row, ["winrate"]))
            if winrate is None:
                wins = to_float(safe_get(pair_row, ["wins"]))
                draws = to_float(safe_get(pair_row, ["draws"]))
                losses = to_float(safe_get(pair_row, ["losses"]))
                if wins is not None and losses is not None:
                    total = (wins or 0.0) + (draws or 0.0) + (losses or 0.0)
                    if total > 0:
                        winrate = wins / total
            if winrate is not None and winrate > 1.0:
                winrate = winrate / 100.0

            trades = to_float(safe_get(pair_row, ["trades", "trade_count"])) or 0.0
            pair_dd = to_float(
                safe_get(pair_row, ["max_drawdown_pct", "max_drawdown", "drawdown_pct"])
            )
            if pair_dd is None:
                pair_dd = strategy_dd
            if pair_dd is not None and -3.0 <= pair_dd <= 3.0:
                pair_dd = pair_dd * 100.0

            if net is None or winrate is None:
                notes.append(
                    f"skip pair {symbol}: missing net return or winrate in freqtrade json"
                )
                continue

            drawdown_pct = abs(pair_dd) if pair_dd is not None else 0.0
            robust = float(net - 0.5 * drawdown_pct)
            cost = float(net)
            lift = float(winrate - 0.5)
            if candle_count > 0:
                turnover = float(trades / candle_count)
            else:
                turnover = float(min(1.0, trades / 1000.0))
                notes.append(
                    "turnover_per_bar approximated from trades/1000 (no candle_count provided)"
                )

            rows.append(
                {
                    "symbol": symbol,
                    "robust_cost_aware_utility": robust,
                    "cost_aware_utility": cost,
                    "net_return_pct_after_cost": float(net),
                    "accuracy_lift": lift,
                    "turnover_per_bar": turnover,
                    "error_flag": False,
                }
            )
    return rows, notes


def parse_entry(
    entry: Dict[str, Any], repo_root: Path
) -> Tuple[Optional[ParsedRun], List[str]]:
    notes: List[str] = []
    run_id = str(entry.get("run_id") or "").strip()
    if not run_id:
        return None, ["entry missing run_id"]
    framework = str(entry.get("framework") or "unknown").strip().lower()
    strategy = str(entry.get("strategy") or "").strip()
    artifact_type = str(entry.get("artifact_type") or "auto").strip().lower()
    artifact_raw = str(entry.get("artifact") or "").strip()
    if not artifact_raw:
        return None, [f"{run_id}: missing artifact path"]
    artifact_path = resolve_path(repo_root, artifact_raw)
    if not artifact_path.exists():
        return None, [f"{run_id}: artifact not found: {artifact_path}"]

    if artifact_type == "auto":
        if artifact_path.suffix.lower() == ".csv":
            artifact_type = "generic_metrics_csv"
        elif framework == "freqtrade" and artifact_path.suffix.lower() == ".json":
            artifact_type = "freqtrade_backtest_json"
        else:
            artifact_type = "generic_metrics_csv"

    rows: List[Dict[str, Any]] = []
    if artifact_type in {"generic_metrics_csv", "openalice_leaderboard_csv"}:
        rows, parse_notes = parse_generic_metrics_csv(artifact_path)
        notes.extend(parse_notes)
    elif artifact_type == "freqtrade_backtest_json":
        candle_count = int(to_float(entry.get("candle_count")) or 0)
        rows, parse_notes = parse_freqtrade_backtest_json(
            artifact_path,
            candle_count=candle_count,
        )
        notes.extend(parse_notes)
    else:
        return None, [f"{run_id}: unsupported artifact_type={artifact_type}"]

    if not rows:
        return None, [f"{run_id}: no valid metric rows parsed"] + notes

    parsed = ParsedRun(
        run_id=run_id,
        framework=framework,
        strategy=strategy,
        artifact_type=artifact_type,
        artifact_path=str(artifact_path),
        records=rows,
        notes=notes,
    )
    return parsed, []


def summarize_records(
    records: Sequence[Dict[str, Any]],
    bootstrap_samples: int,
) -> Optional[Dict[str, Any]]:
    robust_vals: List[float] = []
    cost_vals: List[float] = []
    net_vals: List[float] = []
    lift_vals: List[float] = []
    turnover_vals: List[float] = []
    error_flags: List[bool] = []

    for row in records:
        robust = to_float(row.get("robust_cost_aware_utility"))
        cost = to_float(row.get("cost_aware_utility"))
        net = to_float(row.get("net_return_pct_after_cost"))
        lift = to_float(row.get("accuracy_lift"))
        turnover = to_float(row.get("turnover_per_bar"))
        if None in (robust, cost, net, lift, turnover):
            continue
        robust_vals.append(float(robust))
        cost_vals.append(float(cost))
        net_vals.append(float(net))
        lift_vals.append(float(lift))
        turnover_vals.append(float(turnover))
        error_flags.append(bool(row.get("error_flag") is True))

    if not robust_vals:
        return None

    robust_ci_lb95, robust_ci_ub95 = bootstrap_ci(
        robust_vals,
        samples=bootstrap_samples,
    )
    trained_symbols = len(robust_vals)
    error_symbols = sum(1 for flag in error_flags if flag)
    denom = trained_symbols + error_symbols
    error_ratio = float(error_symbols / denom) if denom > 0 else 0.0

    return {
        "sample_size": trained_symbols,
        "trained_symbols": trained_symbols,
        "error_symbols": error_symbols,
        "robust_mean": float(sum(robust_vals) / len(robust_vals)),
        "robust_std": float(statistics.stdev(robust_vals))
        if len(robust_vals) > 1
        else 0.0,
        "robust_ci_lb95": robust_ci_lb95,
        "robust_ci_ub95": robust_ci_ub95,
        "cost_mean": float(sum(cost_vals) / len(cost_vals)),
        "net_median_mean": float(statistics.median(net_vals)),
        "net_trim10_mean": trimmed_mean(net_vals, 0.10),
        "lift_pos_mean": float(sum(1 for v in lift_vals if v > 0) / len(lift_vals)),
        "turnover_mean": float(sum(turnover_vals) / len(turnover_vals)),
        "error_ratio_mean": error_ratio,
    }


def apply_main_gates(row: Dict[str, Any], baseline: Optional[Dict[str, Any]]) -> None:
    if not baseline or baseline.get("robust_mean") is None:
        row["gate_pass_robust_uplift"] = ""
        row["gate_pass_robust_ci"] = ""
        row["gate_pass_variance"] = ""
        row["gate_pass_lift"] = ""
        row["gate_pass_net_trim10"] = ""
        row["gate_pass_error_ratio"] = ""
        row["eligible"] = ""
        return

    robust = row.get("robust_mean")
    robust_ci_lb = row.get("robust_ci_lb95")
    robust_std = row.get("robust_std")
    lift = row.get("lift_pos_mean")
    trim = row.get("net_trim10_mean")
    error_ratio = row.get("error_ratio_mean")

    b_robust = float(baseline["robust_mean"])
    b_robust_ci_lb = float(baseline.get("robust_ci_lb95") or b_robust)
    b_robust_std = float(baseline.get("robust_std") or 0.0)
    b_lift = float(baseline.get("lift_pos_mean") or 0.0)
    b_trim = float(baseline.get("net_trim10_mean") or 0.0)

    row["gate_pass_robust_uplift"] = (
        robust is not None and float(robust) >= b_robust + 0.02
    )
    row["gate_pass_robust_ci"] = (
        robust_ci_lb is not None and float(robust_ci_lb) >= b_robust_ci_lb + 0.005
    )
    row["gate_pass_variance"] = robust_std is not None and float(robust_std) <= max(
        0.08, b_robust_std * 1.2
    )
    row["gate_pass_lift"] = lift is not None and float(lift) >= max(0.0, b_lift + 0.05)
    row["gate_pass_net_trim10"] = trim is not None and float(trim) >= b_trim + 1.0
    row["gate_pass_error_ratio"] = error_ratio is not None and float(error_ratio) <= 0.2
    row["eligible"] = bool(
        row["gate_pass_robust_uplift"]
        and row["gate_pass_robust_ci"]
        and row["gate_pass_variance"]
        and row["gate_pass_lift"]
        and row["gate_pass_net_trim10"]
        and row["gate_pass_error_ratio"]
    )


def sort_aggregate_rows(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(
        rows,
        key=lambda r: (
            not bool(r.get("eligible") is True),
            -(to_float(r.get("robust_ci_lb95")) or -1e99),
            -(to_float(r.get("robust_mean")) or -1e99),
            (to_float(r.get("robust_std")) or 1e99),
            -(to_float(r.get("net_trim10_mean")) or -1e99),
        ),
    )


def format_metric(value: Any, digits: int = 6) -> str:
    f = to_float(value)
    if f is None:
        return "n/a"
    return f"{f:.{digits}f}"


def bool_text(value: Any) -> str:
    b = parse_bool(value)
    if b is None:
        return ""
    return "True" if b else "False"


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = [
        "# External Benchmark Report",
        "",
        f"- generatedAt: `{payload.get('generated_at', '')}`",
        f"- manifest: `{payload.get('manifest', '')}`",
        f"- totalEntries: `{payload.get('total_entries', 0)}`",
        f"- parsedRuns: `{payload.get('parsed_runs', 0)}`",
        f"- failedEntries: `{len(payload.get('failed_entries', []))}`",
        "",
    ]

    baseline = payload.get("baseline")
    if isinstance(baseline, dict):
        lines.extend(
            [
                "## Baseline",
                "",
                f"- cycleDir: `{baseline.get('cycle_dir', '')}`",
                f"- H0 robust_mean: `{format_metric(baseline.get('robust_mean'))}`",
                f"- H0 robust_ci_lb95: `{format_metric(baseline.get('robust_ci_lb95'))}`",
                f"- H0 lift_pos_mean: `{format_metric(baseline.get('lift_pos_mean'))}`",
                f"- H0 net_trim10_mean: `{format_metric(baseline.get('net_trim10_mean'))}`",
                "",
            ]
        )
    else:
        lines.extend(["## Baseline", "", "- unavailable", ""])

    lines.extend(
        [
            "## Aggregate",
            "",
            "| run_id | framework | strategy | robust_mean | robust_ci_lb95 | lift_pos_mean | turnover_mean | error_ratio_mean | eligible |",
            "|---|---|---|---:|---:|---:|---:|---:|---|",
        ]
    )
    for row in payload.get("aggregate", []):
        lines.append(
            f"| {row.get('run_id', '')} | {row.get('framework', '')} | "
            f"{row.get('strategy', '')} | "
            f"{format_metric(row.get('robust_mean'))} | "
            f"{format_metric(row.get('robust_ci_lb95'))} | "
            f"{format_metric(row.get('lift_pos_mean'))} | "
            f"{format_metric(row.get('turnover_mean'))} | "
            f"{format_metric(row.get('error_ratio_mean'))} | "
            f"{bool_text(row.get('eligible'))} |"
        )
    lines.append("")

    failed_entries = payload.get("failed_entries", [])
    if failed_entries:
        lines.extend(["## Failed Entries", ""])
        for item in failed_entries:
            lines.append(
                f"- `{item.get('run_id', 'unknown')}`: {item.get('error', '')}"
            )
        lines.append("")

    warnings = payload.get("warnings", [])
    if warnings:
        lines.extend(["## Warnings", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")

    probe = payload.get("tool_probe")
    if isinstance(probe, dict):
        lines.extend(
            [
                "## Tool Probe",
                "",
                "| tool | available | path |",
                "|---|---|---|",
            ]
        )
        for key, info in probe.items():
            lines.append(
                f"| {key} | {bool_text(info.get('available'))} | {info.get('path', '')} |"
            )
        lines.append("")
    return "\n".join(lines)


def create_example_manifest(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    example = {
        "runs": [
            {
                "run_id": "freqtrade-sample-01",
                "framework": "freqtrade",
                "strategy": "SampleStrategy",
                "artifact_type": "freqtrade_backtest_json",
                "artifact": "data/external-benchmarks/freqtrade/sample_backtest.json",
                "candle_count": 1440,
                "notes": "freqtrade backtesting export json path",
            },
            {
                "run_id": "qlib-sample-01",
                "framework": "qlib",
                "strategy": "TopkDropout",
                "artifact_type": "generic_metrics_csv",
                "artifact": "data/external-benchmarks/qlib/sample_metrics.csv",
                "notes": "csv should include robust/cost/net/lift/turnover columns",
            },
            {
                "run_id": "hummingbot-sample-01",
                "framework": "hummingbot",
                "strategy": "pure_market_making",
                "artifact_type": "generic_metrics_csv",
                "artifact": "data/external-benchmarks/hummingbot/sample_metrics.csv",
            },
        ]
    }
    write_json(path, example)


def probe_tools() -> Dict[str, Dict[str, Any]]:
    tool_names = [
        "python3",
        "freqtrade",
        "hummingbot",
        "qlib",
        "docker",
        "gh",
    ]
    probe: Dict[str, Dict[str, Any]] = {}
    for name in tool_names:
        path = shutil.which(name)
        probe[name] = {
            "available": path is not None,
            "path": path or "",
        }
    return probe


def load_manifest(path: Path) -> Tuple[List[Dict[str, Any]], List[str]]:
    if not path.exists():
        return [], [f"manifest not found: {path}"]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return [], [f"failed to parse manifest: {exc}"]

    runs = payload.get("runs")
    if not isinstance(runs, list):
        return [], ["manifest must contain array field `runs`"]
    out: List[Dict[str, Any]] = []
    for item in runs:
        if isinstance(item, dict):
            out.append(item)
    if not out:
        return [], ["manifest has no valid run entries"]
    return out, []


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    manifest_path = resolve_path(repo_root, args.manifest)
    out_dir = resolve_path(repo_root, args.out_dir)
    experiments_root = resolve_path(repo_root, args.experiments_root)
    explicit_cycle_dir = (
        resolve_path(repo_root, args.baseline_cycle_dir)
        if str(args.baseline_cycle_dir).strip()
        else None
    )

    warnings: List[str] = []

    if args.create_example_manifest:
        if manifest_path.exists():
            warnings.append(f"manifest already exists, keep existing: {manifest_path}")
        else:
            create_example_manifest(manifest_path)
            warnings.append(f"created example manifest: {manifest_path}")

    runs, manifest_errors = load_manifest(manifest_path)
    warnings.extend(manifest_errors)
    baseline, baseline_warnings = load_latest_baseline(
        experiments_root=experiments_root,
        cycle_pattern=args.cycle_pattern,
        min_completed_runs=int(args.min_completed_runs),
        explicit_cycle_dir=explicit_cycle_dir,
    )
    warnings.extend(baseline_warnings)

    aggregate: List[Dict[str, Any]] = []
    failed_entries: List[Dict[str, str]] = []
    parsed_runs = 0

    for entry in runs:
        run_id = str(entry.get("run_id") or "unknown")
        parsed, errors = parse_entry(entry, repo_root=repo_root)
        if errors:
            failed_entries.append({"run_id": run_id, "error": "; ".join(errors)})
            continue
        if parsed is None:
            failed_entries.append({"run_id": run_id, "error": "unknown parse failure"})
            continue

        summary = summarize_records(
            parsed.records,
            bootstrap_samples=int(args.bootstrap_samples),
        )
        if summary is None:
            failed_entries.append(
                {
                    "run_id": parsed.run_id,
                    "error": "unable to summarize parsed rows (no valid metrics)",
                }
            )
            continue

        row: Dict[str, Any] = {
            "run_id": parsed.run_id,
            "framework": parsed.framework,
            "strategy": parsed.strategy,
            "artifact_type": parsed.artifact_type,
            "artifact": parsed.artifact_path,
            "sample_size": summary["sample_size"],
            "trained_symbols": summary["trained_symbols"],
            "error_symbols": summary["error_symbols"],
            "robust_mean": summary["robust_mean"],
            "robust_std": summary["robust_std"],
            "robust_ci_lb95": summary["robust_ci_lb95"],
            "robust_ci_ub95": summary["robust_ci_ub95"],
            "cost_mean": summary["cost_mean"],
            "net_median_mean": summary["net_median_mean"],
            "net_trim10_mean": summary["net_trim10_mean"],
            "lift_pos_mean": summary["lift_pos_mean"],
            "turnover_mean": summary["turnover_mean"],
            "error_ratio_mean": summary["error_ratio_mean"],
            "notes": " | ".join(parsed.notes[:4]),
        }
        apply_main_gates(row, baseline=baseline)
        aggregate.append(row)
        parsed_runs += 1

    aggregate = sort_aggregate_rows(aggregate)
    run_ts = now_utc()
    run_id = run_ts.strftime("%Y%m%dT%H%M%SZ")

    tool_probe = probe_tools() if args.probe_tools else None
    payload: Dict[str, Any] = {
        "generated_at": iso(run_ts),
        "run_id": run_id,
        "manifest": str(manifest_path),
        "out_dir": str(out_dir),
        "total_entries": len(runs),
        "parsed_runs": parsed_runs,
        "failed_entries": failed_entries,
        "baseline": baseline,
        "aggregate": aggregate,
        "warnings": warnings,
    }
    if tool_probe is not None:
        payload["tool_probe"] = tool_probe

    markdown = render_markdown(payload)

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    latest_json = out_dir / "latest_external_benchmark_report.json"
    latest_md = out_dir / "latest_external_benchmark_report.md"
    latest_csv = out_dir / "external_main_aggregate.csv"
    archive_json = out_dir / "archive" / run_id / "external_benchmark_report.json"
    archive_md = out_dir / "archive" / run_id / "external_benchmark_report.md"
    archive_csv = out_dir / "archive" / run_id / "external_main_aggregate.csv"

    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_csv(latest_csv, aggregate, AGGREGATE_FIELDS)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)
    write_csv(archive_csv, aggregate, AGGREGATE_FIELDS)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "manifest": str(manifest_path),
                "out_dir": str(out_dir),
                "parsed_runs": parsed_runs,
                "failed_entries": len(failed_entries),
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "latest_csv": str(latest_csv),
                "dry_run": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
