#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Check and optionally deduplicate risk symbols by timestamp in OKX candles shards."
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_historical",
        help="Dataset root path.",
    )
    parser.add_argument(
        "--symbols",
        default="ARB-USDT,CVC-USDT",
        help="Comma-separated symbol list.",
    )
    parser.add_argument(
        "--timeframes",
        default="1h,15m,5m",
        help="Comma-separated timeframes.",
    )
    parser.add_argument(
        "--apply",
        default="false",
        choices=("true", "false"),
        help="Apply dedup rewrite in-place when duplicates are found.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output report path (default: <dataset-root>/reports/swarm/risk_symbols_dedup_report.v1.json).",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_list(value: str) -> list[str]:
    return [x.strip() for x in value.split(",") if x.strip()]


def load_catalog_inst_type_map(catalog_path: Path) -> dict[str, str]:
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    out: dict[str, str] = {}
    for row in payload.get("items", []):
        inst_id = str(row.get("instId", "")).strip()
        if not inst_id:
            continue
        inst_type = str(row.get("instType", "")).upper()
        out[inst_id] = "swap" if inst_type == "SWAP" else "spot"
    return out


def read_shard_lines(path: Path) -> list[str]:
    if path.suffix == ".zst":
        proc = subprocess.run(
            ["zstd", "-q", "-d", "-c", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.splitlines()
    return path.read_text(encoding="utf-8", errors="ignore").splitlines()


def write_shard_lines(path: Path, lines: list[str]) -> None:
    content = "\n".join(lines) + "\n"
    if path.suffix == ".zst":
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".csv", delete=False) as tmp:
            tmp.write(content)
            tmp_path = Path(tmp.name)
        try:
            subprocess.run(
                ["zstd", "-q", "-f", str(tmp_path), "-o", str(path)],
                check=True,
            )
        finally:
            tmp_path.unlink(missing_ok=True)
        return
    path.write_text(content, encoding="utf-8")


def dedup_lines(lines: list[str]) -> tuple[list[str], int, int]:
    header = ""
    seen: dict[int, str] = {}
    duplicate_rows = 0
    parsed_rows = 0

    for raw in lines:
        text = raw.strip()
        if not text:
            continue
        if text.startswith("timestamp,"):
            if not header:
                header = text
            continue
        first_comma = text.find(",")
        if first_comma <= 0:
            continue
        ts_text = text[:first_comma].strip()
        if not ts_text.isdigit():
            continue
        parsed_rows += 1
        ts = int(ts_text)
        if ts in seen:
            duplicate_rows += 1
            continue
        seen[ts] = text

    deduped_rows = [seen[ts] for ts in sorted(seen)]
    out_lines = [header or "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange", *deduped_rows]
    return out_lines, parsed_rows, duplicate_rows


def main() -> None:
    args = parse_args()
    root = repo_root()
    dataset_root = (root / args.dataset_root).resolve()
    symbols = parse_list(args.symbols)
    timeframes = parse_list(args.timeframes)
    apply_dedup = args.apply == "true"

    output_path = (
        Path(args.output).resolve()
        if args.output
        else (dataset_root / "reports" / "swarm" / "risk_symbols_dedup_report.v1.json")
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    catalog_map = load_catalog_inst_type_map(dataset_root / "catalog" / "usdt_all.v1.json")
    reports: list[dict[str, Any]] = []

    files_checked = 0
    files_with_duplicates = 0
    total_duplicate_rows = 0
    files_rewritten = 0

    for symbol in symbols:
        inst_type_dir = catalog_map.get(symbol, "spot")
        for timeframe in timeframes:
            symbol_dir = dataset_root / "candles" / timeframe / inst_type_dir / symbol
            if not symbol_dir.exists():
                reports.append(
                    {
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "symbolDir": str(symbol_dir),
                        "status": "missing_dir",
                        "files": [],
                    }
                )
                continue

            shard_files = sorted(
                list(symbol_dir.glob("*.csv")) + list(symbol_dir.glob("*.csv.zst"))
            )
            tf_report = {
                "symbol": symbol,
                "timeframe": timeframe,
                "symbolDir": str(symbol_dir),
                "status": "ok",
                "files": [],
            }

            for shard_path in shard_files:
                files_checked += 1
                lines = read_shard_lines(shard_path)
                deduped_lines, parsed_rows, duplicate_rows = dedup_lines(lines)
                after_rows = max(len(deduped_lines) - 1, 0)
                has_duplicates = duplicate_rows > 0
                rewritten = False
                if has_duplicates:
                    files_with_duplicates += 1
                    total_duplicate_rows += duplicate_rows
                    if apply_dedup:
                        write_shard_lines(shard_path, deduped_lines)
                        rewritten = True
                        files_rewritten += 1
                tf_report["files"].append(
                    {
                        "path": str(shard_path),
                        "parsedRows": parsed_rows,
                        "duplicateRows": duplicate_rows,
                        "rowsAfterDedup": after_rows,
                        "hasDuplicates": has_duplicates,
                        "rewritten": rewritten,
                    }
                )

            reports.append(tf_report)

    payload = {
        "schemaVersion": "okx_risk_symbol_dedup_report.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRoot": str(dataset_root),
        "params": {
            "symbols": symbols,
            "timeframes": timeframes,
            "apply": apply_dedup,
        },
        "totals": {
            "filesChecked": files_checked,
            "filesWithDuplicates": files_with_duplicates,
            "totalDuplicateRows": total_duplicate_rows,
            "filesRewritten": files_rewritten,
        },
        "items": reports,
    }
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "risk dedup check complete: "
        f"checked={files_checked} with_duplicates={files_with_duplicates} "
        f"duplicate_rows={total_duplicate_rows} rewritten={files_rewritten} output={output_path}"
    )


if __name__ == "__main__":
    main()

