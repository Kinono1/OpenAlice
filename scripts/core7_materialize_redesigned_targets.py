#!/usr/bin/env python3
"""Materialize redesigned target columns for CORE7 feature tables."""

from __future__ import annotations

import argparse
import csv
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from core7_feature_predictive_scan import (
    feature_file,
    iter_csv_rows,
    repo_root as resolve_repo_root,
    resolve_path,
    split_symbols,
)


DEFAULT_FEATURE_ROOT = "data/market/core7_feature_base_1m"
DEFAULT_OUTPUT_ROOT = "data/research/strategy/analysis/stage_c/target_tables"
DEFAULT_SUMMARY = "data/research/strategy/analysis/stage_c/target_materialization_summary.v1.json"
DEFAULT_DOC = "docs/research/stage_c_target_materialization_20260311.md"
DEFAULT_SYMBOLS = "BTC-USDT,ETH-USDT,SOL-USDT"
DEFAULT_TAIL_ROWS = 6000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Materialize redesigned target columns for CORE7.")
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="Input CORE7 feature root.")
    parser.add_argument("--output-root", default=DEFAULT_OUTPUT_ROOT, help="Output target table root.")
    parser.add_argument("--summary-output", default=DEFAULT_SUMMARY, help="Summary JSON path.")
    parser.add_argument("--doc-output", default=DEFAULT_DOC, help="Markdown summary output path.")
    parser.add_argument("--symbols", default=DEFAULT_SYMBOLS, help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=DEFAULT_TAIL_ROWS, help="Rows to retain from file tail.")
    return parser.parse_args()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


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


def tail_rows(path: Path, limit: int) -> List[Dict[str, str]]:
    from collections import deque

    keep = deque(maxlen=max(limit, 1))
    for row in iter_csv_rows(path):
        keep.append(row)
    return list(keep)


def one_minute_returns(close_values: List[Optional[float]]) -> List[Optional[float]]:
    returns: List[Optional[float]] = [None] * len(close_values)
    for idx in range(1, len(close_values)):
        prev_value = close_values[idx - 1]
        value = close_values[idx]
        if prev_value is None or value is None or prev_value == 0:
            continue
        returns[idx] = (value / prev_value) - 1.0
    return returns


def realized_vol_target(close_values: List[Optional[float]], bars: int) -> List[Optional[float]]:
    rets = one_minute_returns(close_values)
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        window = [value for value in rets[idx + 1 : idx + bars + 1] if value is not None]
        if len(window) < max(5, bars // 4):
            continue
        out[idx] = math.sqrt(sum(value * value for value in window) / len(window))
    return out


def absolute_return_target(close_values: List[Optional[float]], bars: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        now = close_values[idx]
        future = close_values[idx + bars]
        if now is None or future is None or now == 0:
            continue
        out[idx] = abs((future / now) - 1.0)
    return out


def forward_return_target(close_values: List[Optional[float]], bars: int) -> List[Optional[float]]:
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        now = close_values[idx]
        future = close_values[idx + bars]
        if now is None or future is None or now == 0:
            continue
        out[idx] = (future / now) - 1.0
    return out


def directional_persistence_target(close_values: List[Optional[float]], bars: int) -> List[Optional[float]]:
    rets = one_minute_returns(close_values)
    out: List[Optional[float]] = [None] * len(close_values)
    for idx in range(len(close_values) - bars):
        window = [value for value in rets[idx + 1 : idx + bars + 1] if value is not None]
        if len(window) < max(5, bars // 4):
            continue
        positives = sum(1 for value in window if value > 0)
        negatives = sum(1 for value in window if value < 0)
        total = max(1, positives + negatives)
        out[idx] = (positives - negatives) / total
    return out


def write_csv(path: Path, rows: List[Dict[str, Any]], fieldnames: List[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow(row)


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_doc(path: Path, payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    lines.append("# Stage-C Target Materialization")
    lines.append("")
    lines.append(f"Date: `{payload['generatedAt']}`")
    lines.append("")
    lines.append("## Purpose")
    lines.append("")
    lines.append("Materialize redesigned target columns so the next research sprint starts from a concrete dataset rather than a paper recommendation.")
    lines.append("")
    lines.append("## Targets")
    lines.append("")
    lines.append("- `target_realized_vol_1h`")
    lines.append("- `target_abs_return_1h`")
    lines.append("- `target_forward_return_4h`")
    lines.append("- `target_directional_persistence_1h`")
    lines.append("")
    lines.append("## Coverage Summary")
    lines.append("")
    for item in payload["symbols"]:
        lines.append(
            f"- `{item['symbol']}` rows=`{item['rows']}` "
            f"realized_vol_1h=`{item['coverage']['target_realized_vol_1h']}` "
            f"abs_return_1h=`{item['coverage']['target_abs_return_1h']}` "
            f"forward_return_4h=`{item['coverage']['target_forward_return_4h']}` "
            f"directional_persistence_1h=`{item['coverage']['target_directional_persistence_1h']}`"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = resolve_repo_root(args.repo_root)
    feature_root = resolve_path(root, args.feature_root)
    output_root = resolve_path(root, args.output_root)
    summary_output = resolve_path(root, args.summary_output)
    doc_output = resolve_path(root, args.doc_output)
    symbols = split_symbols(args.symbols)

    symbol_summaries: List[Dict[str, Any]] = []
    for symbol in symbols:
        path = feature_file(feature_root, symbol)
        rows = tail_rows(path, args.tail_rows)
        close_values = [to_float(row.get("okx_close")) for row in rows]
        target_realized_vol_1h = realized_vol_target(close_values, 60)
        target_abs_return_1h = absolute_return_target(close_values, 60)
        target_forward_return_4h = forward_return_target(close_values, 240)
        target_directional_persistence_1h = directional_persistence_target(close_values, 60)

        enriched_rows: List[Dict[str, Any]] = []
        for idx, row in enumerate(rows):
            item = dict(row)
            item["target_realized_vol_1h"] = target_realized_vol_1h[idx]
            item["target_abs_return_1h"] = target_abs_return_1h[idx]
            item["target_forward_return_4h"] = target_forward_return_4h[idx]
            item["target_directional_persistence_1h"] = target_directional_persistence_1h[idx]
            enriched_rows.append(item)

        fieldnames = list(rows[0].keys()) + [
            "target_realized_vol_1h",
            "target_abs_return_1h",
            "target_forward_return_4h",
            "target_directional_persistence_1h",
        ]
        output_path = output_root / f"okx_inst_id={symbol}" / "data.csv"
        write_csv(output_path, enriched_rows, fieldnames)

        symbol_summaries.append(
            {
                "symbol": symbol,
                "inputPath": str(path),
                "outputPath": str(output_path),
                "rows": len(enriched_rows),
                "coverage": {
                    "target_realized_vol_1h": sum(1 for value in target_realized_vol_1h if value is not None),
                    "target_abs_return_1h": sum(1 for value in target_abs_return_1h if value is not None),
                    "target_forward_return_4h": sum(1 for value in target_forward_return_4h if value is not None),
                    "target_directional_persistence_1h": sum(
                        1 for value in target_directional_persistence_1h if value is not None
                    ),
                },
            }
        )

    summary = {
        "schemaVersion": "core7_target_materialization.v1",
        "generatedAt": utc_iso(),
        "config": {
            "featureRoot": str(feature_root),
            "outputRoot": str(output_root),
            "symbols": symbols,
            "tailRows": args.tail_rows,
        },
        "symbols": symbol_summaries,
    }
    write_json(summary_output, summary)
    write_doc(doc_output, summary)
    print(json.dumps({"summary": str(summary_output), "outputRoot": str(output_root)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
