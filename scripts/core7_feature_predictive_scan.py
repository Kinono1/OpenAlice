#!/usr/bin/env python3
"""Run a quick predictive-power scan over CORE7 feature tables."""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import subprocess
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional, Sequence


DEFAULT_FEATURE_ROOT = "data/market/core7_feature_base_1m"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/core7_feature_predictive_scan.v1.json"
DEFAULT_DOC = "docs/research/core7_feature_predictive_scan_20260311.md"
DEFAULT_SYMBOLS = "BTC-USDT,ETH-USDT,SOL-USDT"
DEFAULT_TAIL_ROWS = 12000
DEFAULT_TOP_N = 20
FORWARD_HORIZONS = {"1h": 60, "4h": 240}

IGNORE_COLUMNS = {
    "timestamp_ms",
    "iso_utc",
    "okx_inst_id",
    "okx_market",
    "exchange",
    "timeframe",
    "source_file",
    "shard_month",
    "base",
    "quote",
    "okx_pair_symbol",
    "okx_pair_market",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Quick predictive scan for CORE7 feature tables.")
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="CORE7 feature root.")
    parser.add_argument("--symbols", default=DEFAULT_SYMBOLS, help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=DEFAULT_TAIL_ROWS, help="Rows to retain from file tail.")
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N, help="Top features to report per view.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="JSON output path.")
    parser.add_argument("--doc-output", default=DEFAULT_DOC, help="Markdown interpretation output path.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def split_symbols(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def feature_file(feature_root: Path, inst_id: str) -> Path:
    zst = feature_root / f"okx_inst_id={inst_id}" / "data.csv.zst"
    if zst.exists():
        return zst
    csv_path = feature_root / f"okx_inst_id={inst_id}" / "data.csv"
    if csv_path.exists():
        return csv_path
    raise FileNotFoundError(f"Missing feature table for {inst_id}")


def iter_csv_rows(path: Path) -> Iterable[Dict[str, str]]:
    if path.suffix == ".zst":
        proc = subprocess.Popen(
            ["zstd", "-q", "-d", "-c", str(path)],
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        assert proc.stdout is not None
        try:
            yield from csv.DictReader(proc.stdout)
        finally:
            proc.stdout.close()
            proc.wait()
    else:
        with path.open("r", encoding="utf-8", newline="") as handle:
            yield from csv.DictReader(handle)


def tail_rows(path: Path, limit: int) -> List[Dict[str, str]]:
    keep: Deque[Dict[str, str]] = deque(maxlen=max(limit, 1))
    for row in iter_csv_rows(path):
        keep.append(row)
    return list(keep)


def to_float(value: str | None) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    if not math.isfinite(parsed):
        return None
    return parsed


def feature_columns(rows: Sequence[Dict[str, str]]) -> List[str]:
    if not rows:
        return []
    columns: List[str] = []
    sample = rows[0]
    for key in sample.keys():
        if key in IGNORE_COLUMNS or key.startswith("label_"):
            continue
        if any(to_float(row.get(key)) is not None for row in rows[:20]):
            columns.append(key)
    return columns


def average(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def variance(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    mu = average(values)
    return sum((value - mu) ** 2 for value in values) / len(values)


def ranks(values: Sequence[float]) -> List[float]:
    indexed = sorted(enumerate(values), key=lambda item: item[1])
    out = [0.0] * len(values)
    idx = 0
    while idx < len(indexed):
        end = idx + 1
        while end < len(indexed) and indexed[end][1] == indexed[idx][1]:
            end += 1
        rank = (idx + end - 1) / 2.0 + 1.0
        for pos in range(idx, end):
            out[indexed[pos][0]] = rank
        idx = end
    return out


def pearson(x: Sequence[float], y: Sequence[float]) -> float:
    if len(x) != len(y) or len(x) < 2:
        return 0.0
    var_x = variance(x)
    var_y = variance(y)
    if var_x <= 0 or var_y <= 0:
        return 0.0
    mean_x = average(x)
    mean_y = average(y)
    cov = sum((ax - mean_x) * (by - mean_y) for ax, by in zip(x, y)) / len(x)
    return cov / math.sqrt(var_x * var_y)


def spearman_rank_ic(feature: Sequence[float], target: Sequence[float]) -> float:
    if len(feature) != len(target) or len(feature) < 2:
        return 0.0
    return pearson(ranks(feature), ranks(target))


def quantile_bins(values: Sequence[float], bins: int = 10) -> List[int]:
    if not values:
        return []
    ordered = sorted(values)
    thresholds: List[float] = []
    for idx in range(1, bins):
        q_idx = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * idx / bins)))
        thresholds.append(ordered[q_idx])
    out: List[int] = []
    for value in values:
        bucket = 0
        while bucket < len(thresholds) and value > thresholds[bucket]:
            bucket += 1
        out.append(bucket)
    return out


def mutual_information(feature: Sequence[float], target: Sequence[float], bins: int = 10) -> float:
    if len(feature) != len(target) or len(feature) < 8:
        return 0.0
    fx = quantile_bins(feature, bins=bins)
    ty = quantile_bins(target, bins=bins)
    total = len(fx)
    joint: Dict[tuple[int, int], int] = defaultdict(int)
    px: Dict[int, int] = defaultdict(int)
    py: Dict[int, int] = defaultdict(int)
    for xb, yb in zip(fx, ty):
        joint[(xb, yb)] += 1
        px[xb] += 1
        py[yb] += 1
    mi = 0.0
    for (xb, yb), count in joint.items():
        pxy = count / total
        pxv = px[xb] / total
        pyv = py[yb] / total
        mi += pxy * math.log(max(pxy / (pxv * pyv), 1e-12))
    return mi


def compute_forward_returns(close_values: Sequence[Optional[float]], horizon: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - horizon):
        current = close_values[idx]
        future = close_values[idx + horizon]
        if current is None or future is None or current == 0:
            continue
        out[idx] = (future / current) - 1.0
    return out


def evaluate_feature(feature_values: Sequence[Optional[float]], target_values: Sequence[Optional[float]], seed: int) -> Dict[str, float]:
    usable_feature: List[float] = []
    usable_target: List[float] = []
    for feature, target in zip(feature_values, target_values):
        if feature is None or target is None:
            continue
        usable_feature.append(feature)
        usable_target.append(target)
    if len(usable_feature) < 200 or variance(usable_feature) <= 0 or variance(usable_target) <= 0:
        return {
            "sampleCount": len(usable_feature),
            "rankIc": 0.0,
            "rankIcAbs": 0.0,
            "rankIcShuffle": 0.0,
            "mutualInformation": 0.0,
            "mutualInformationShuffle": 0.0,
            "miExcessOverShuffle": 0.0,
        }
    rng = random.Random(seed)
    shuffled = usable_target[:]
    rng.shuffle(shuffled)
    rank_ic = spearman_rank_ic(usable_feature, usable_target)
    rank_ic_shuffle = spearman_rank_ic(usable_feature, shuffled)
    mi = mutual_information(usable_feature, usable_target)
    mi_shuffle = mutual_information(usable_feature, shuffled)
    return {
        "sampleCount": len(usable_feature),
        "rankIc": rank_ic,
        "rankIcAbs": abs(rank_ic),
        "rankIcShuffle": rank_ic_shuffle,
        "mutualInformation": mi,
        "mutualInformationShuffle": mi_shuffle,
        "miExcessOverShuffle": mi - mi_shuffle,
    }


def summarize_symbol(rows: Sequence[Dict[str, str]], top_n: int) -> Dict[str, Any]:
    columns = feature_columns(rows)
    close_values = [to_float(row.get("okx_close")) for row in rows]
    horizon_results: Dict[str, Any] = {}
    for horizon_name, horizon_bars in FORWARD_HORIZONS.items():
        targets = compute_forward_returns(close_values, horizon_bars)
        per_feature: Dict[str, Dict[str, float]] = {}
        for idx, column in enumerate(columns):
            series = [to_float(row.get(column)) for row in rows]
            per_feature[column] = evaluate_feature(series, targets, seed=17_000 + idx + horizon_bars)
        top_rank_ic = sorted(
            (
                {"feature": feature, **stats}
                for feature, stats in per_feature.items()
                if stats["sampleCount"] >= 200
            ),
            key=lambda item: item["rankIcAbs"],
            reverse=True,
        )[:top_n]
        top_mi = sorted(
            (
                {"feature": feature, **stats}
                for feature, stats in per_feature.items()
                if stats["sampleCount"] >= 200
            ),
            key=lambda item: item["miExcessOverShuffle"],
            reverse=True,
        )[:top_n]
        horizon_results[horizon_name] = {
            "horizonBars": horizon_bars,
            "featureCount": len(per_feature),
            "topByAbsRankIc": top_rank_ic,
            "topByMiExcess": top_mi,
        }
    return {"sampleRows": len(rows), "horizons": horizon_results}


def aggregate_symbol_results(symbols: Dict[str, Any], top_n: int) -> Dict[str, Any]:
    aggregate: Dict[str, Any] = {}
    for horizon_name in FORWARD_HORIZONS.keys():
        stats: Dict[str, Dict[str, List[float]]] = defaultdict(lambda: defaultdict(list))
        for symbol_result in symbols.values():
            horizon = symbol_result["horizons"][horizon_name]
            for row in horizon["topByAbsRankIc"]:
                stats[row["feature"]]["rankIcAbs"].append(row["rankIcAbs"])
                stats[row["feature"]]["rankIc"].append(row["rankIc"])
                stats[row["feature"]]["rankIcShuffle"].append(row["rankIcShuffle"])
            for row in horizon["topByMiExcess"]:
                stats[row["feature"]]["miExcessOverShuffle"].append(row["miExcessOverShuffle"])
                stats[row["feature"]]["mutualInformation"].append(row["mutualInformation"])
                stats[row["feature"]]["mutualInformationShuffle"].append(row["mutualInformationShuffle"])

        top_rank_ic = sorted(
            (
                {
                    "feature": feature,
                    "meanAbsRankIc": average(values["rankIcAbs"]),
                    "meanRankIc": average(values["rankIc"]),
                    "meanRankIcShuffle": average(values["rankIcShuffle"]),
                }
                for feature, values in stats.items()
                if values.get("rankIcAbs")
            ),
            key=lambda item: item["meanAbsRankIc"],
            reverse=True,
        )[:top_n]
        top_mi = sorted(
            (
                {
                    "feature": feature,
                    "meanMiExcessOverShuffle": average(values["miExcessOverShuffle"]),
                    "meanMutualInformation": average(values["mutualInformation"]),
                    "meanMutualInformationShuffle": average(values["mutualInformationShuffle"]),
                }
                for feature, values in stats.items()
                if values.get("miExcessOverShuffle")
            ),
            key=lambda item: item["meanMiExcessOverShuffle"],
            reverse=True,
        )[:top_n]
        aggregate[horizon_name] = {
            "topByMeanAbsRankIc": top_rank_ic,
            "topByMeanMiExcess": top_mi,
            "signalStillExists": bool(
                top_rank_ic
                and top_mi
                and (
                    top_rank_ic[0]["meanAbsRankIc"] >= 0.02
                    or top_mi[0]["meanMiExcessOverShuffle"] > 0.001
                )
            ),
        }
    return aggregate


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_doc(path: Path, payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    lines.append("# CORE7 Feature Predictive Scan")
    lines.append("")
    lines.append(f"Date: `{payload['generatedAt']}`")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append("- symbols: `BTC-USDT`, `ETH-USDT`, `SOL-USDT`")
    lines.append("- horizons: `1h`, `4h`")
    lines.append("- metrics: `Spearman rank-IC`, `mutual information`, shuffle baseline")
    lines.append("")
    lines.append("## Aggregate Readout")
    lines.append("")
    for horizon_name, summary in payload["aggregate"].items():
        verdict = "signal still exists" if summary["signalStillExists"] else "signal too weak, return to feature engineering"
        lines.append(f"### {horizon_name}")
        lines.append("")
        lines.append(f"- conclusion: `{verdict}`")
        top_rank = summary["topByMeanAbsRankIc"][:5]
        top_mi = summary["topByMeanMiExcess"][:5]
        if top_rank:
            lines.append("- top rank-IC features:")
            for row in top_rank:
                lines.append(
                    f"  - `{row['feature']}` absRankIC=`{row['meanAbsRankIc']:.4f}` "
                    f"meanRankIC=`{row['meanRankIc']:.4f}` shuffle=`{row['meanRankIcShuffle']:.4f}`"
                )
        if top_mi:
            lines.append("- top MI features:")
            for row in top_mi:
                lines.append(
                    f"  - `{row['feature']}` miExcess=`{row['meanMiExcessOverShuffle']:.6f}` "
                    f"mi=`{row['meanMutualInformation']:.6f}` shuffle=`{row['meanMutualInformationShuffle']:.6f}`"
                )
        lines.append("")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output)
    doc_output_path = resolve_path(root, args.doc_output)
    symbols = split_symbols(args.symbols)

    symbol_results: Dict[str, Any] = {}
    for symbol in symbols:
        rows = tail_rows(feature_file(feature_root, symbol), args.tail_rows)
        symbol_results[symbol] = summarize_symbol(rows, args.top_n)

    payload = {
        "schemaVersion": "core7_feature_predictive_scan.v1",
        "generatedAt": utc_iso(),
        "config": {
            "featureRoot": str(feature_root),
            "symbols": symbols,
            "tailRows": args.tail_rows,
            "topN": args.top_n,
            "horizons": FORWARD_HORIZONS,
        },
        "symbols": symbol_results,
        "aggregate": aggregate_symbol_results(symbol_results, args.top_n),
    }
    write_json(output_path, payload)
    write_doc(doc_output_path, payload)
    print(json.dumps({"output": str(output_path), "doc": str(doc_output_path)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
