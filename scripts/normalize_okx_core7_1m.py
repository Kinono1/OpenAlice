#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from core7_pipeline_utils import (
    detect_okx_market,
    iso_from_ms,
    list_symbol_dirs,
    parse_csv_list,
    parse_bool,
    read_csv_any,
    write_csv_zst,
    write_json,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize OKX core7 1m candles into a stable Layer 3 schema."
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_1m_core7",
        help="Root of the OKX core7 dataset.",
    )
    parser.add_argument(
        "--output-root",
        default="data/market/okx_1m_core7_norm",
        help="Root for normalized OKX outputs.",
    )
    parser.add_argument(
        "--timeframe",
        default="1m",
        help="Timeframe label to normalize (default: 1m).",
    )
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol allowlist.",
    )
    parser.add_argument(
        "--symbols-file",
        default="",
        help="Optional file with one symbol per line.",
    )
    parser.add_argument(
        "--include-source-columns",
        default="true",
        choices=("true", "false"),
        help="Include source_file and shard_month columns in normalized output.",
    )
    parser.add_argument(
        "--summary-output",
        default="",
        help="Optional summary JSON path (default: <output-root>/reports/normalize_okx_core7_1m.summary.json).",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def read_symbols_file(path: Path) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        symbol = line.strip()
        if not symbol or symbol.startswith("#") or symbol in seen:
            continue
        seen.add(symbol)
        out.append(symbol)
    return out


def resolve_symbol_allowlist(args: argparse.Namespace) -> set[str]:
    out = set(parse_csv_list(args.symbols))
    if args.symbols_file:
        path = Path(args.symbols_file)
        if not path.is_absolute():
            path = (repo_root() / path).resolve()
        out.update(read_symbols_file(path))
    return out


def load_symbol_dataframe(
    symbol_dir: Path,
    market: str,
    timeframe: str,
    include_source_columns: bool,
) -> tuple[pd.DataFrame, dict[str, int]]:
    shard_paths = sorted(
        [
            path
            for path in symbol_dir.iterdir()
            if path.is_file() and (path.name.endswith(".csv") or path.name.endswith(".csv.zst"))
        ]
    )
    rows_read = 0
    rows_kept = 0
    frames: list[pd.DataFrame] = []
    for shard_path in shard_paths:
        df = read_csv_any(shard_path)
        if df.empty:
            continue
        rows_read += len(df)
        expected_cols = {
            "timestamp",
            "iso",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "symbol",
            "timeframe",
            "exchange",
        }
        missing = expected_cols - set(df.columns)
        if missing:
            raise ValueError(f"{shard_path} missing columns: {sorted(missing)}")
        df = df.rename(
            columns={
                "timestamp": "timestamp_ms",
                "iso": "iso_utc",
            }
        )
        df["market"] = market
        df["timeframe"] = timeframe
        df["timestamp_ms"] = pd.to_numeric(df["timestamp_ms"], errors="coerce").astype("Int64")
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df.dropna(subset=["timestamp_ms", "open", "high", "low", "close", "volume", "symbol"])
        df["timestamp_ms"] = df["timestamp_ms"].astype("int64")
        if include_source_columns:
            df["source_file"] = str(shard_path)
            df["shard_month"] = shard_path.name.split(".csv")[0]
        frames.append(
            df[
                [
                    "timestamp_ms",
                    "iso_utc",
                    "symbol",
                    "market",
                    "exchange",
                    "timeframe",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    *(["source_file", "shard_month"] if include_source_columns else []),
                ]
            ]
        )
    if not frames:
        return (
            pd.DataFrame(
                columns=[
                    "timestamp_ms",
                    "iso_utc",
                    "symbol",
                    "market",
                    "exchange",
                    "timeframe",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    *(["source_file", "shard_month"] if include_source_columns else []),
                ]
            ),
            {"rowsRead": rows_read, "rowsKept": rows_kept, "shards": len(shard_paths)},
        )
    merged = pd.concat(frames, ignore_index=True)
    merged = merged.sort_values(["timestamp_ms", "iso_utc"], kind="stable")
    merged = merged.drop_duplicates(subset=["timestamp_ms"], keep="last")
    merged["iso_utc"] = merged["timestamp_ms"].apply(iso_from_ms)
    rows_kept = len(merged)
    return merged.reset_index(drop=True), {
        "rowsRead": rows_read,
        "rowsKept": rows_kept,
        "shards": len(shard_paths),
    }


def main() -> None:
    args = parse_args()
    root = repo_root()
    dataset_root = Path(args.dataset_root)
    if not dataset_root.is_absolute():
        dataset_root = (root / dataset_root).resolve()
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = (root / output_root).resolve()
    summary_output = (
        Path(args.summary_output).resolve()
        if args.summary_output
        else (output_root / "reports" / "normalize_okx_core7_1m.summary.json")
    )

    allowlist = resolve_symbol_allowlist(args)
    include_source_columns = parse_bool(args.include_source_columns, default=True)

    items: list[dict[str, object]] = []
    for market in ("spot", "swap"):
        market_root = dataset_root / "candles" / args.timeframe / market
        for symbol_dir in list_symbol_dirs(market_root):
            symbol = symbol_dir.name
            if allowlist and symbol not in allowlist:
                continue
            df, stats = load_symbol_dataframe(
                symbol_dir=symbol_dir,
                market=detect_okx_market(symbol),
                timeframe=args.timeframe,
                include_source_columns=include_source_columns,
            )
            output_path = output_root / market / symbol / args.timeframe / "data.csv.zst"
            write_csv_zst(df, output_path)
            items.append(
                {
                    "symbol": symbol,
                    "market": market,
                    "timeframe": args.timeframe,
                    "output": str(output_path),
                    "rows": int(len(df)),
                    **stats,
                }
            )

    payload = {
        "schemaVersion": "normalize_okx_core7_1m.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRoot": str(dataset_root),
        "outputRoot": str(output_root),
        "timeframe": args.timeframe,
        "symbolsFilter": sorted(allowlist) if allowlist else None,
        "totals": {
            "symbols": len(items),
            "rows": int(sum(int(item["rows"]) for item in items)),
        },
        "items": items,
    }
    write_json(summary_output, payload)
    print(f"normalized OKX symbols={len(items)} rows={payload['totals']['rows']}")
    print(f"summary={summary_output}")


if __name__ == "__main__":
    main()
