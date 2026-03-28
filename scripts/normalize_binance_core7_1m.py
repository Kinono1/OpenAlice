#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from core7_pipeline_utils import (
    iso_from_ms,
    list_symbol_dirs,
    normalize_timestamp_ms,
    parse_csv_list,
    parse_bool,
    read_first_zip_member_lines,
    write_csv_zst,
    write_json,
)


BINANCE_COLUMNS = [
    "open_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "close_time",
    "quote_volume",
    "count",
    "taker_buy_volume",
    "taker_buy_quote_volume",
    "ignore",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Normalize Binance core7 1m spot/um data into a stable Layer 3 schema."
    )
    parser.add_argument(
        "--input-root",
        default="data/market/binance_1m_core7",
        help="Root of the raw Binance core7 downloads.",
    )
    parser.add_argument(
        "--output-root",
        default="data/market/binance_1m_core7_norm",
        help="Root for normalized Binance outputs.",
    )
    parser.add_argument(
        "--markets",
        default="spot,um",
        help="Comma-separated markets to normalize (spot,um).",
    )
    parser.add_argument(
        "--symbols",
        default="",
        help="Optional comma-separated symbol allowlist.",
    )
    parser.add_argument(
        "--timeframe",
        default="1m",
        help="Timeframe label to normalize (default: 1m).",
    )
    parser.add_argument(
        "--include-source-columns",
        default="true",
        choices=("true", "false"),
        help="Include source_file/member/shard_month columns.",
    )
    parser.add_argument(
        "--summary-output",
        default="",
        help="Optional summary JSON path.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def has_header(first_line: str) -> bool:
    first_token = first_line.split(",", 1)[0].strip().lower()
    return first_token in {"open_time", "timestamp"} or not first_token.isdigit()


def load_zip_rows(path: Path, market: str, timeframe: str) -> tuple[pd.DataFrame, str]:
    member, lines = read_first_zip_member_lines(path)
    if not lines:
        return pd.DataFrame(columns=BINANCE_COLUMNS), member
    if has_header(lines[0]):
        reader = csv.DictReader(lines)
        rows = list(reader)
        df = pd.DataFrame(rows)
    else:
        reader = csv.reader(lines)
        df = pd.DataFrame(list(reader), columns=BINANCE_COLUMNS[: len(BINANCE_COLUMNS)])
    if df.empty:
        return df, member

    df["timestamp_ms"] = df["open_time"].apply(normalize_timestamp_ms)
    df["close_time_ms"] = df["close_time"].apply(normalize_timestamp_ms)
    for src, dest in (
        ("count", "trades_count"),
        ("taker_buy_volume", "taker_buy_base"),
        ("taker_buy_quote_volume", "taker_buy_quote"),
    ):
        if src in df.columns:
            df[dest] = pd.to_numeric(df[src], errors="coerce")
        else:
            df[dest] = pd.NA

    for col in ("open", "high", "low", "close", "volume", "quote_volume"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
        else:
            df[col] = pd.NA

    df = df.dropna(subset=["timestamp_ms", "open", "high", "low", "close", "volume"])
    df["timestamp_ms"] = df["timestamp_ms"].astype("int64")
    df["close_time_ms"] = df["close_time_ms"].astype("Int64")
    df["iso_utc"] = df["timestamp_ms"].apply(iso_from_ms)
    df["market"] = market
    df["exchange"] = "binance"
    df["timeframe"] = timeframe
    return df, member


def main() -> None:
    args = parse_args()
    root = repo_root()
    input_root = Path(args.input_root)
    if not input_root.is_absolute():
        input_root = (root / input_root).resolve()
    output_root = Path(args.output_root)
    if not output_root.is_absolute():
        output_root = (root / output_root).resolve()
    summary_output = (
        Path(args.summary_output).resolve()
        if args.summary_output
        else (output_root / "reports" / "normalize_binance_core7_1m.summary.json")
    )

    include_source_columns = parse_bool(args.include_source_columns, default=True)
    wanted_markets = parse_csv_list(args.markets) or ["spot", "um"]
    wanted_symbols = set(parse_csv_list(args.symbols))
    items: list[dict[str, object]] = []

    for market in wanted_markets:
        market_root = input_root / market
        for symbol_dir in list_symbol_dirs(market_root):
            symbol = symbol_dir.name
            if wanted_symbols and symbol not in wanted_symbols:
                continue
            tf_root = symbol_dir / args.timeframe
            if not tf_root.exists():
                continue
            zip_paths = sorted(tf_root.glob("*.zip"))
            frames: list[pd.DataFrame] = []
            rows_read = 0
            for zip_path in zip_paths:
                df, member = load_zip_rows(zip_path, market=market, timeframe=args.timeframe)
                if df.empty:
                    continue
                rows_read += len(df)
                if include_source_columns:
                    df["source_file"] = str(zip_path)
                    df["source_member"] = member
                    df["shard_month"] = zip_path.stem.split("-")[-2] + "-" + zip_path.stem.split("-")[-1]
                frames.append(
                    df[
                        [
                            "timestamp_ms",
                            "iso_utc",
                            "close_time_ms",
                            "open",
                            "high",
                            "low",
                            "close",
                            "volume",
                            "quote_volume",
                            "trades_count",
                            "taker_buy_base",
                            "taker_buy_quote",
                            "market",
                            "exchange",
                            "timeframe",
                            *(["source_file", "source_member", "shard_month"] if include_source_columns else []),
                        ]
                    ].assign(symbol=symbol)
                )
            if not frames:
                continue
            merged = pd.concat(frames, ignore_index=True)
            merged = merged.sort_values(["timestamp_ms"], kind="stable")
            merged = merged.drop_duplicates(subset=["timestamp_ms"], keep="last")
            output_path = output_root / market / symbol / args.timeframe / "data.csv.zst"
            write_csv_zst(merged, output_path)
            items.append(
                {
                    "symbol": symbol,
                    "market": market,
                    "timeframe": args.timeframe,
                    "rowsRead": rows_read,
                    "rowsKept": int(len(merged)),
                    "files": len(zip_paths),
                    "output": str(output_path),
                }
            )

    payload = {
        "schemaVersion": "normalize_binance_core7_1m.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputRoot": str(input_root),
        "outputRoot": str(output_root),
        "markets": wanted_markets,
        "timeframe": args.timeframe,
        "symbolsFilter": sorted(wanted_symbols) if wanted_symbols else None,
        "totals": {
            "symbols": len(items),
            "rows": int(sum(int(item["rowsKept"]) for item in items)),
        },
        "items": items,
    }
    write_json(summary_output, payload)
    print(f"normalized Binance symbols={len(items)} rows={payload['totals']['rows']}")
    print(f"summary={summary_output}")


if __name__ == "__main__":
    main()
