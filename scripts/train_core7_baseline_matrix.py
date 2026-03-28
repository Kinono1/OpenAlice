#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


DEFAULT_LABELS = ["label_dir_fwd_1m", "label_dir_fwd_5m", "label_dir_fwd_15m"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train the core7 sklearn baseline over every per-instId feature table and aggregate results."
    )
    parser.add_argument(
        "--feature-root",
        default="data/market/core7_feature_base_1m",
        help="Root of per-instId feature tables.",
    )
    parser.add_argument(
        "--output-dir",
        default="data/market/core7_models",
        help="Directory for per-model summaries and aggregate leaderboard.",
    )
    parser.add_argument(
        "--labels",
        default=",".join(DEFAULT_LABELS),
        help="Comma-separated label columns to train.",
    )
    parser.add_argument(
        "--python-bin",
        default=sys.executable,
        help="Python interpreter used to invoke train_core7_baseline.py.",
    )
    return parser.parse_args()


def parse_csv_list(raw: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for token in raw.split(","):
        value = token.strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    args = parse_args()
    root = Path(__file__).resolve().parents[1]
    feature_root = Path(args.feature_root)
    if not feature_root.is_absolute():
        feature_root = (root / feature_root).resolve()
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = (root / output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    labels = parse_csv_list(args.labels)
    trainer = root / "scripts" / "train_core7_baseline.py"

    items: list[dict[str, object]] = []
    for inst_dir in sorted([path for path in feature_root.iterdir() if path.is_dir()]):
        data_path = inst_dir / "data.csv.zst"
        if not data_path.exists():
            data_path = inst_dir / "data.csv"
        if not data_path.exists():
            continue
        inst_id = inst_dir.name.replace("okx_inst_id=", "")
        for label in labels:
            summary_path = output_dir / f"{inst_id}.{label}.summary.json"
            cmd = [
                args.python_bin,
                str(trainer),
                "--input",
                str(data_path),
                "--label-col",
                label,
                "--output",
                str(summary_path),
            ]
            run = subprocess.run(cmd, text=True, capture_output=True, check=False)
            item: dict[str, object] = {
                "okxInstId": inst_id,
                "label": label,
                "output": str(summary_path),
                "returncode": run.returncode,
            }
            if run.returncode == 0 and summary_path.exists():
                payload = json.loads(summary_path.read_text(encoding="utf-8"))
                metrics = payload.get("metrics", {})
                item["metrics"] = metrics
                item["rows"] = payload.get("splits", {}).get("rows")
            else:
                item["stderr"] = run.stderr[-2000:]
            items.append(item)
            print(f"[{len(items)}] {inst_id} {label} rc={run.returncode}")

    successful = [item for item in items if int(item["returncode"]) == 0]
    leaderboard = sorted(
        successful,
        key=lambda item: (
            -float((item.get("metrics") or {}).get("test_auc") or -1.0),
            -float((item.get("metrics") or {}).get("test_accuracy") or -1.0),
            str(item["okxInstId"]),
        ),
    )
    payload = {
        "schemaVersion": "core7_baseline_matrix.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "featureRoot": str(feature_root),
        "outputDir": str(output_dir),
        "labels": labels,
        "totals": {
            "jobs": len(items),
            "successfulJobs": len(successful),
            "failedJobs": len(items) - len(successful),
        },
        "leaderboard": leaderboard,
        "items": items,
    }
    write_json(output_dir / "core7_baseline_matrix.summary.json", payload)


if __name__ == "__main__":
    main()
