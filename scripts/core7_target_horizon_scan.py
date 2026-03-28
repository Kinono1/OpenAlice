#!/usr/bin/env python3
"""Scan CORE7 features against multiple candidate targets for feature/horizon redesign."""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from core7_feature_predictive_scan import (
    evaluate_feature,
    feature_columns,
    feature_file,
    repo_root as resolve_repo_root,
    resolve_path,
    split_symbols,
    tail_rows,
    to_float,
    write_json,
)


DEFAULT_FEATURE_ROOT = "data/market/core7_feature_base_1m"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/core7_target_horizon_scan.v1.json"
DEFAULT_DOC = "docs/research/stage_c_feature_horizon_redesign_20260311.md"
DEFAULT_SYMBOLS = "BTC-USDT,ETH-USDT,SOL-USDT"
DEFAULT_TAIL_ROWS = 6000
DEFAULT_TOP_N = 10

TARGETS = {
    "forward_return_15m": {"kind": "directional_return", "bars": 15},
    "forward_return_1h": {"kind": "directional_return", "bars": 60},
    "forward_return_4h": {"kind": "directional_return", "bars": 240},
    "absolute_return_1h": {"kind": "magnitude", "bars": 60},
    "realized_vol_1h": {"kind": "magnitude", "bars": 60},
    "directional_persistence_1h": {"kind": "regime", "bars": 60},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Scan CORE7 features against multiple targets/horizons.")
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="CORE7 feature root.")
    parser.add_argument("--symbols", default=DEFAULT_SYMBOLS, help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=DEFAULT_TAIL_ROWS, help="Rows to retain from file tail.")
    parser.add_argument("--top-n", type=int, default=DEFAULT_TOP_N, help="Top features to report per target.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="JSON output path.")
    parser.add_argument("--doc-output", default=DEFAULT_DOC, help="Markdown interpretation output path.")
    return parser.parse_args()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def average(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def one_minute_returns(close_values: Sequence[Optional[float]]) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(1, len(close_values)):
        prev_value = close_values[idx - 1]
        value = close_values[idx]
        if prev_value is None or value is None or prev_value == 0:
            continue
        out[idx] = (value / prev_value) - 1.0
    return out


def forward_return(close_values: Sequence[Optional[float]], bars: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        now = close_values[idx]
        future = close_values[idx + bars]
        if now is None or future is None or now == 0:
            continue
        out[idx] = (future / now) - 1.0
    return out


def absolute_forward_return(close_values: Sequence[Optional[float]], bars: int) -> List[Optional[float]]:
    base = forward_return(close_values, bars)
    return [abs(value) if value is not None else None for value in base]


def realized_vol_target(close_values: Sequence[Optional[float]], bars: int) -> List[Optional[float]]:
    one_min_ret = one_minute_returns(close_values)
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        window = [value for value in one_min_ret[idx + 1 : idx + bars + 1] if value is not None]
        if len(window) < max(5, bars // 4):
            continue
        out[idx] = math.sqrt(sum(value * value for value in window) / len(window))
    return out


def directional_persistence_target(close_values: Sequence[Optional[float]], bars: int) -> List[Optional[float]]:
    one_min_ret = one_minute_returns(close_values)
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        window = [value for value in one_min_ret[idx + 1 : idx + bars + 1] if value is not None]
        if len(window) < max(5, bars // 4):
            continue
        positives = sum(1 for value in window if value > 0)
        negatives = sum(1 for value in window if value < 0)
        total = max(1, positives + negatives)
        out[idx] = (positives - negatives) / total
    return out


def build_target(target_name: str, close_values: Sequence[Optional[float]]) -> List[Optional[float]]:
    spec = TARGETS[target_name]
    bars = int(spec["bars"])
    if target_name.startswith("forward_return_"):
        return forward_return(close_values, bars)
    if target_name.startswith("absolute_return_"):
        return absolute_forward_return(close_values, bars)
    if target_name.startswith("realized_vol_"):
        return realized_vol_target(close_values, bars)
    if target_name.startswith("directional_persistence_"):
        return directional_persistence_target(close_values, bars)
    raise ValueError(f"Unsupported target: {target_name}")


def score_target(rows: Sequence[Dict[str, str]], top_n: int) -> Dict[str, Any]:
    columns = feature_columns(rows)
    close_values = [to_float(row.get("okx_close")) for row in rows]
    output: Dict[str, Any] = {}
    for target_name in TARGETS.keys():
        target_values = build_target(target_name, close_values)
        per_feature: Dict[str, Dict[str, float]] = {}
        for idx, column in enumerate(columns):
            series = [to_float(row.get(column)) for row in rows]
            per_feature[column] = evaluate_feature(series, target_values, seed=91_000 + idx)
        ranked = sorted(
            (
                {"feature": feature, **stats}
                for feature, stats in per_feature.items()
                if stats["sampleCount"] >= 200
            ),
            key=lambda item: (item["rankIcAbs"], item["miExcessOverShuffle"]),
            reverse=True,
        )
        top = ranked[:top_n]
        best_rank = top[0]["rankIcAbs"] if top else 0.0
        best_mi = top[0]["miExcessOverShuffle"] if top else 0.0
        output[target_name] = {
            "targetSpec": TARGETS[target_name],
            "featureCount": len(per_feature),
            "topFeatures": top,
            "targetScore": best_rank + best_mi,
            "bestMeanAbsRankIc": best_rank,
            "bestMiExcessOverShuffle": best_mi,
        }
    return output


def aggregate_targets(symbol_payloads: Dict[str, Any], top_n: int) -> Dict[str, Any]:
    aggregate: Dict[str, Any] = {}
    for target_name, spec in TARGETS.items():
        feature_stats: Dict[str, Dict[str, List[float]]] = {}
        target_scores: List[float] = []
        for symbol_result in symbol_payloads.values():
            target_result = symbol_result["targets"][target_name]
            target_scores.append(float(target_result["targetScore"]))
            for row in target_result["topFeatures"]:
                bucket = feature_stats.setdefault(
                    row["feature"],
                    {"rankIcAbs": [], "miExcessOverShuffle": []},
                )
                bucket["rankIcAbs"].append(float(row["rankIcAbs"]))
                bucket["miExcessOverShuffle"].append(float(row["miExcessOverShuffle"]))

        top_features = sorted(
            (
                {
                    "feature": feature,
                    "meanAbsRankIc": average(values["rankIcAbs"]),
                    "meanMiExcessOverShuffle": average(values["miExcessOverShuffle"]),
                }
                for feature, values in feature_stats.items()
            ),
            key=lambda item: (item["meanAbsRankIc"], item["meanMiExcessOverShuffle"]),
            reverse=True,
        )[:top_n]

        aggregate[target_name] = {
            "targetSpec": spec,
            "meanTargetScore": average(target_scores),
            "topFeatures": top_features,
        }
    return aggregate


def choose_recommendation(aggregate: Dict[str, Any]) -> Dict[str, Any]:
    ranked = sorted(
        (
            {
                "target": target,
                "kind": payload["targetSpec"]["kind"],
                "meanTargetScore": payload["meanTargetScore"],
            }
            for target, payload in aggregate.items()
        ),
        key=lambda item: item["meanTargetScore"],
        reverse=True,
    )
    best_overall = ranked[0]
    best_structural = next(
        (item for item in ranked if item["kind"] in {"magnitude", "regime"}),
        best_overall,
    )
    if best_overall["kind"] == "directional_return" and best_structural["target"] != best_overall["target"]:
        if best_structural["meanTargetScore"] >= best_overall["meanTargetScore"] * 0.9:
            recommended = best_structural
            rationale = (
                "Structural target is within 90% of the best directional score and better matches the current "
                "signal-audit conclusion that surviving signal is dominated by structure rather than direct alpha."
            )
        else:
            recommended = best_overall
            rationale = "Directional target remains materially stronger than structural alternatives."
    else:
        recommended = best_overall
        rationale = "Best overall target already aligns with the strongest surviving signal type."
    return {
        "rankedTargets": ranked,
        "recommendedTarget": recommended,
        "rationale": rationale,
    }


def write_doc(path: Path, payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    lines.append("# Stage-C Feature / Horizon Redesign Scan")
    lines.append("")
    lines.append(f"Date: `{payload['generatedAt']}`")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append("- symbols: `BTC-USDT`, `ETH-USDT`, `SOL-USDT`")
    lines.append("- source frequency: `1m` feature base")
    lines.append("- candidate targets: forward return, absolute return, realized volatility, directional persistence")
    lines.append("")
    lines.append("## Ranked Targets")
    lines.append("")
    for item in payload["recommendation"]["rankedTargets"]:
        lines.append(
            f"- `{item['target']}` kind=`{item['kind']}` meanTargetScore=`{item['meanTargetScore']:.6f}`"
        )
    lines.append("")
    rec = payload["recommendation"]["recommendedTarget"]
    lines.append("## Recommendation")
    lines.append("")
    lines.append(f"- recommended target: `{rec['target']}`")
    lines.append(f"- target kind: `{rec['kind']}`")
    lines.append(f"- rationale: {payload['recommendation']['rationale']}")
    lines.append("")
    lines.append("## Top Features For Recommended Target")
    lines.append("")
    top = payload["aggregate"][rec["target"]]["topFeatures"][:5]
    for row in top:
        lines.append(
            f"- `{row['feature']}` meanAbsRankIc=`{row['meanAbsRankIc']:.4f}` "
            f"meanMiExcessOverShuffle=`{row['meanMiExcessOverShuffle']:.6f}`"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = resolve_repo_root(args.repo_root)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output)
    doc_output_path = resolve_path(root, args.doc_output)
    symbols = split_symbols(args.symbols)

    symbol_payloads: Dict[str, Any] = {}
    for symbol in symbols:
        rows = tail_rows(feature_file(feature_root, symbol), args.tail_rows)
        symbol_payloads[symbol] = {
            "sampleRows": len(rows),
            "targets": score_target(rows, args.top_n),
        }

    aggregate = aggregate_targets(symbol_payloads, args.top_n)
    recommendation = choose_recommendation(aggregate)
    payload = {
        "schemaVersion": "core7_target_horizon_scan.v1",
        "generatedAt": utc_iso(),
        "config": {
            "featureRoot": str(feature_root),
            "symbols": symbols,
            "tailRows": args.tail_rows,
            "topN": args.top_n,
            "targets": TARGETS,
        },
        "symbols": symbol_payloads,
        "aggregate": aggregate,
        "recommendation": recommendation,
    }
    write_json(output_path, payload)
    write_doc(doc_output_path, payload)
    print(json.dumps({"output": str(output_path), "recommendedTarget": recommendation["recommendedTarget"]["target"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
