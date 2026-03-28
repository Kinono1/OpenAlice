#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build an OKX candles resume state file from existing shard files."
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_1m_core7",
        help="Dataset root that contains candles/<timeframe>/<market>/<symbol>/ shards.",
    )
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol list.",
    )
    parser.add_argument(
        "--symbols-file",
        default="",
        help="Optional file with one symbol per line.",
    )
    parser.add_argument(
        "--timeframe",
        default="1m",
        help="Timeframe label to inspect (default: 1m).",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output state JSON path.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_symbols(args: argparse.Namespace) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    if args.symbols:
        for raw in args.symbols.split(","):
            symbol = raw.strip()
            if symbol and symbol not in seen:
                seen.add(symbol)
                out.append(symbol)
    if args.symbols_file:
        path = Path(args.symbols_file)
        if not path.is_absolute():
            path = (repo_root() / path).resolve()
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            symbol = line.strip()
            if not symbol or symbol.startswith("#") or symbol in seen:
                continue
            seen.add(symbol)
            out.append(symbol)
    if not out:
        raise SystemExit("No symbols provided. Use --symbols or --symbols-file.")
    return out


def detect_market(symbol: str) -> str:
    return "swap" if symbol.endswith("-SWAP") else "spot"


def iter_lines(path: Path) -> Iterable[str]:
    if path.suffix == ".zst":
        proc = subprocess.run(
            ["zstd", "-q", "-d", "-c", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        yield from proc.stdout.splitlines()
        return
    yield from path.read_text(encoding="utf-8", errors="ignore").splitlines()


def read_min_max_timestamp(path: Path) -> tuple[int | None, int | None]:
    min_ts: int | None = None
    max_ts: int | None = None
    for raw in iter_lines(path):
        line = raw.strip()
        if not line or line.startswith("timestamp,"):
            continue
        first_comma = line.find(",")
        if first_comma <= 0:
            continue
        token = line[:first_comma].strip()
        if not token.isdigit():
            continue
        ts = int(token)
        if min_ts is None or ts < min_ts:
            min_ts = ts
        if max_ts is None or ts > max_ts:
            max_ts = ts
    return min_ts, max_ts


def main() -> None:
    args = parse_args()
    root = repo_root()
    dataset_root = Path(args.dataset_root)
    if not dataset_root.is_absolute():
        dataset_root = (root / dataset_root).resolve()
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = (root / output_path).resolve()

    payload = {
        "schemaVersion": "okx_candles_state.v1",
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "items": {},
    }

    for symbol in parse_symbols(args):
        symbol_dir = dataset_root / "candles" / args.timeframe / detect_market(symbol) / symbol
        if not symbol_dir.exists():
            continue
        shard_files = sorted(
            [
                path
                for path in symbol_dir.iterdir()
                if path.is_file() and (path.name.endswith(".csv") or path.name.endswith(".csv.zst"))
            ]
        )
        if not shard_files:
            continue

        min_ts: int | None = None
        max_ts: int | None = None
        min_file: Path | None = None
        for path in shard_files:
            shard_min, shard_max = read_min_max_timestamp(path)
            if shard_min is None or shard_max is None:
                continue
            if min_ts is None or shard_min < min_ts:
                min_ts = shard_min
                min_file = path
            if max_ts is None or shard_max > max_ts:
                max_ts = shard_max

        if min_ts is None or max_ts is None or min_file is None:
            continue

        payload["items"][f"{symbol}::{args.timeframe}"] = {
            "cursorAfter": min_ts,
            "lastWrittenTs": max_ts,
            "completed": False,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "resumeFromFile": str(min_file),
        }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"wrote {output_path}")
    print(f"items={len(payload['items'])}")


if __name__ == "__main__":
    main()
