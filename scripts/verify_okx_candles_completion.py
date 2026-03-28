#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify OKX candles completion for explicit symbols and timeframes."
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_historical",
        help="Dataset root path.",
    )
    parser.add_argument(
        "--symbols-file",
        required=True,
        help="Text file with one instId per line.",
    )
    parser.add_argument(
        "--timeframes",
        default="1m",
        help="Comma-separated timeframe labels, e.g. 1m or 1m,5m.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Output report path (default: <dataset-root>/reports/validation/okx_candles_completion.v1.json).",
    )
    parser.add_argument(
        "--end-date",
        default="",
        help="Expected inclusive end date in YYYY-MM-DD (default: current UTC date).",
    )
    parser.add_argument(
        "--require-end-month-shard",
        default="true",
        choices=("true", "false"),
        help="Require a non-empty shard for the end-date month.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_csv_list(raw: str) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for token in raw.split(","):
        value = token.strip()
        if not value:
            continue
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def parse_bool(raw: str) -> bool:
    return str(raw).strip().lower() == "true"


def parse_end_month(raw: str) -> str:
    if not raw:
        now = datetime.now(timezone.utc)
        return now.strftime("%Y-%m")
    try:
        value = datetime.strptime(raw, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise ValueError("--end-date must be YYYY-MM-DD") from exc
    return value.strftime("%Y-%m")


def read_symbols_file(path: Path) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        sym = line.strip()
        if not sym or sym.startswith("#"):
            continue
        if sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
    return out


def sanitize_segment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", value)


def load_state_payloads(state_dir: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not state_dir.exists():
        return out
    for path in sorted(state_dir.glob("*.state.v1.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict):
            payload["_sourcePath"] = str(path)
            out.append(payload)
    return out


def collect_completed_sources(
    state_payloads: list[dict[str, Any]],
    task_key: str,
) -> list[str]:
    sources: list[str] = []
    for payload in state_payloads:
        items = payload.get("items", {})
        if not isinstance(items, dict):
            continue
        row = items.get(task_key)
        if isinstance(row, dict) and row.get("completed") is True:
            source_path = str(payload.get("_sourcePath", ""))
            if source_path:
                sources.append(source_path)
    return sources


def detect_market(symbol: str) -> str:
    return "swap" if symbol.endswith("-SWAP") else "spot"


def find_shard_files(symbol_dir: Path) -> list[Path]:
    return sorted(list(symbol_dir.glob("*.csv")) + list(symbol_dir.glob("*.csv.zst")))


def build_report(
    *,
    dataset_root: Path,
    symbols: list[str],
    timeframes: list[str],
    end_month: str,
    require_end_month_shard: bool,
) -> dict[str, Any]:
    state_payloads = load_state_payloads(dataset_root / "state")
    items: list[dict[str, Any]] = []
    valid_count = 0

    for symbol in symbols:
        market = detect_market(symbol)
        symbol_segment = sanitize_segment(symbol)
        for timeframe in timeframes:
            task_key = f"{symbol}::{timeframe}"
            completed_sources = collect_completed_sources(state_payloads, task_key)
            symbol_dir = dataset_root / "candles" / timeframe / market / symbol_segment
            shard_files = find_shard_files(symbol_dir)
            nonempty_files = [path for path in shard_files if path.stat().st_size > 0]
            end_month_files = [
                path for path in shard_files if path.name.startswith(f"{end_month}.")
            ]
            end_month_nonempty = [path for path in end_month_files if path.stat().st_size > 0]

            coverage_complete = (
                symbol_dir.exists()
                and bool(nonempty_files)
                and (
                    (not require_end_month_shard)
                    or bool(end_month_nonempty)
                )
            )
            valid = bool(completed_sources) or coverage_complete
            if valid:
                valid_count += 1

            items.append(
                {
                    "instId": symbol,
                    "market": market,
                    "timeframe": timeframe,
                    "taskKey": task_key,
                    "stateCompleted": bool(completed_sources),
                    "stateSources": completed_sources,
                    "symbolDir": str(symbol_dir),
                    "dirExists": symbol_dir.exists(),
                    "shardCount": len(shard_files),
                    "nonEmptyShardCount": len(nonempty_files),
                    "endMonth": end_month,
                    "endMonthShardCount": len(end_month_files),
                    "endMonthNonEmptyShardCount": len(end_month_nonempty),
                    "coverageComplete": coverage_complete,
                    "valid": valid,
                }
            )

    return {
        "schemaVersion": "okx_candles_completion_validation.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRoot": str(dataset_root),
        "params": {
            "symbols": symbols,
            "timeframes": timeframes,
            "endMonth": end_month,
            "requireEndMonthShard": require_end_month_shard,
        },
        "totals": {
            "tasks": len(items),
            "validTasks": valid_count,
            "invalidTasks": len(items) - valid_count,
        },
        "items": items,
    }


def main() -> None:
    args = parse_args()
    root = repo_root()
    dataset_root = Path(args.dataset_root)
    if not dataset_root.is_absolute():
        dataset_root = (root / dataset_root).resolve()
    symbols_file = Path(args.symbols_file)
    if not symbols_file.is_absolute():
        symbols_file = (root / symbols_file).resolve()

    output_path = (
        Path(args.output).resolve()
        if args.output
        else (dataset_root / "reports" / "validation" / "okx_candles_completion.v1.json")
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)

    symbols = read_symbols_file(symbols_file)
    timeframes = [value.lower() for value in parse_csv_list(args.timeframes)]
    if not symbols:
        raise SystemExit("No symbols found in --symbols-file")
    if not timeframes:
        raise SystemExit("No timeframes provided")

    payload = build_report(
        dataset_root=dataset_root,
        symbols=symbols,
        timeframes=timeframes,
        end_month=parse_end_month(args.end_date),
        require_end_month_shard=parse_bool(args.require_end_month_shard),
    )
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    invalid_tasks = int(payload["totals"]["invalidTasks"])
    if invalid_tasks > 0:
        print(f"validation failed: invalidTasks={invalid_tasks}", file=sys.stderr)
        raise SystemExit(1)
    print(f"validation passed: tasks={payload['totals']['tasks']}")


if __name__ == "__main__":
    main()
