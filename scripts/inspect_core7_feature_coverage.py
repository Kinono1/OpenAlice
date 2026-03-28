#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

from core7_pipeline_utils import read_csv_any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Inspect normalized/feature coverage for the core7 pipeline."
    )
    parser.add_argument(
        "--feature-root",
        default="data/market/core7_feature_base_1m",
        help="Root containing per-instId feature tables.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional JSON output path.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    feature_root = Path(args.feature_root).resolve()
    items: list[dict[str, object]] = []
    for inst_dir in sorted([path for path in feature_root.iterdir() if path.is_dir()]):
        data_path = inst_dir / "data.csv.zst"
        if not data_path.exists():
            data_path = inst_dir / "data.csv"
        if not data_path.exists():
            continue
        df = read_csv_any(data_path)
        items.append(
            {
                "okxInstId": inst_dir.name.replace("okx_inst_id=", ""),
                "rows": int(len(df)),
                "columns": int(len(df.columns)),
                "missingShare": float(df.isna().mean().mean()) if len(df.columns) else 0.0,
                "path": str(data_path),
            }
        )
    payload = {
        "schemaVersion": "core7_feature_coverage.v1",
        "featureRoot": str(feature_root),
        "totals": {
            "tables": len(items),
            "rows": int(sum(int(item["rows"]) for item in items)),
        },
        "items": items,
    }
    if args.output:
        output = Path(args.output).resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
