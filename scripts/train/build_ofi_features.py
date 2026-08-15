#!/usr/bin/env python3
"""
Build Order Flow Imbalance (OFI) features from Binance aggTrades data.

Reads aggregate trade ZIP files from local storage, computes 1h-window features
(OFI, tick ratio, intensity, avg trade size, trade size std), and writes JSONL.

Usage:
    python3 scripts/train/build_ofi_features.py \
        --symbol BTCUSDT \
        --month 2024-01 \
        --output data/research/ofi_btc_2024-01.jsonl
"""

import argparse
import csv
import io
import json
import math
import os
import sys
import zipfile
from datetime import datetime, timezone

DATA_BASE = (
    "/Volumes/shield/cryptoData/openalice-data/"
    "market/binance-public/spot-all-usdt-aggTrades/spot/aggTrades"
)

# Column indices in the aggTrades CSV (no header row).
#   0: Aggregate trade ID
#   1: Price
#   2: Quantity
#   3: First trade ID
#   4: Last trade ID
#   5: Timestamp (milliseconds)
#   6: Is buyer maker  (True = buyer took the ask = buy pressure)
#   7: Placeholder
IDX_PRICE = 1
IDX_QTY = 2
IDX_TS = 5
IDX_IS_BUYER_MAKER = 6

PROGRESS_INTERVAL = 2_000_000  # Log progress every N rows


def flush_hour(
    hour_ts: int,
    cur: dict,
    records: list,
    symbol: str,
) -> None:
    """Compute feature values for one completed hour window and append to records."""
    total_vol = cur["buy_volume"] + cur["sell_volume"]
    total_trades = cur["total_trades"]

    # Sanity guard -- should not happen with real data, but skip if empty.
    if total_trades == 0 or total_vol == 0.0:
        return

    ofi = (cur["buy_volume"] - cur["sell_volume"]) / total_vol
    tick_ratio = cur["buy_trades"] / total_trades
    trades_per_second = total_trades / 3600.0
    avg_trade_size_usd = cur["welford_mean"]

    # Population standard deviation via Welford's M2.
    if cur["welford_n"] > 1:
        variance = cur["welford_m2"] / cur["welford_n"]
        trade_size_std = math.sqrt(variance)
    else:
        trade_size_std = 0.0

    dt = datetime.fromtimestamp(hour_ts, tz=timezone.utc)
    timestamp_str = dt.strftime("%Y-%m-%dT%H:%M:%SZ")

    records.append({
        "timestamp": timestamp_str,
        "symbol": symbol,
        "ofi": round(ofi, 6),
        "tick_ratio": round(tick_ratio, 6),
        "trades_per_second": round(trades_per_second, 4),
        "avg_trade_size_usd": round(avg_trade_size_usd, 2),
        "trade_size_std": round(trade_size_std, 2),
    })


def make_fresh_accumulator() -> dict:
    """Return a clean accumulator dict for a new hour window."""
    return {
        "buy_volume": 0.0,
        "sell_volume": 0.0,
        "buy_trades": 0,
        "total_trades": 0,
        # Welford online statistics for trade-size USD values.
        "welford_n": 0,
        "welford_mean": 0.0,
        "welford_m2": 0.0,
    }


def process_month(symbol: str, month: str, output_path: str) -> None:
    """Process one month's aggTrades ZIP and write OFI features to JSONL."""
    zip_dir = os.path.join(DATA_BASE, symbol)
    zip_name = f"{symbol}-aggTrades-{month}.zip"
    zip_path = os.path.join(zip_dir, zip_name)

    if not os.path.isfile(zip_path):
        print(f"ERROR: ZIP not found: {zip_path}", file=sys.stderr)
        sys.exit(1)

    print(f"Processing {zip_path} ...", file=sys.stderr)

    records: list[dict] = []
    cur = make_fresh_accumulator()
    current_hour: int | None = None  # Unix-seconds start of current hour
    row_count = 0

    with zipfile.ZipFile(zip_path, "r") as zf:
        # Locate CSV inside the ZIP.
        csv_files = [n for n in zf.namelist() if n.endswith(".csv")]
        if not csv_files:
            print(f"ERROR: No CSV file inside {zip_path}", file=sys.stderr)
            sys.exit(1)
        csv_name = csv_files[0]

        with zf.open(csv_name) as f:
            reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))

            for row in reader:
                # Guard against empty lines.
                if not row or len(row) < 8:
                    continue

                # --- Detect and skip header row (first row with non-numeric ID). ---
                if row_count == 0:
                    try:
                        int(row[0])
                    except (ValueError, IndexError):
                        # Looks like a CSV header row -- skip it.
                        continue

                ts_ms = int(row[IDX_TS])
                price = float(row[IDX_PRICE])
                quantity = float(row[IDX_QTY])
                is_buyer_maker = row[IDX_IS_BUYER_MAKER].strip().lower() == "true"

                trade_size_usd = price * quantity

                # Floor timestamp to hour-boundary in seconds.
                hour_ts = (ts_ms // 3_600_000) * 3600

                if current_hour is None:
                    current_hour = hour_ts

                # Flush previous hour when we cross into a new one.
                if hour_ts != current_hour:
                    flush_hour(current_hour, cur, records, symbol)
                    cur = make_fresh_accumulator()
                    current_hour = hour_ts

                # --- Accumulate ---
                cur["total_trades"] += 1

                if is_buyer_maker:
                    cur["buy_volume"] += trade_size_usd
                    cur["buy_trades"] += 1
                else:
                    cur["sell_volume"] += trade_size_usd

                # Welford online update for trade-size distribution.
                w_n = cur["welford_n"] + 1
                w_mean = cur["welford_mean"]
                w_m2 = cur["welford_m2"]

                delta = trade_size_usd - w_mean
                w_mean_new = w_mean + delta / w_n
                delta2 = trade_size_usd - w_mean_new
                w_m2_new = w_m2 + delta * delta2

                cur["welford_n"] = w_n
                cur["welford_mean"] = w_mean_new
                cur["welford_m2"] = w_m2_new

                row_count += 1

                if row_count % PROGRESS_INTERVAL == 0:
                    print(
                        f"  ... {row_count:,} rows processed",
                        file=sys.stderr,
                    )

    # Flush the last hour.
    if current_hour is not None and cur["total_trades"] > 0:
        flush_hour(current_hour, cur, records, symbol)

    print(f"  Total rows: {row_count:,}", file=sys.stderr)

    # --- Write output ---
    out_dir = os.path.dirname(output_path)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(output_path, "w") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    print(
        f"Wrote {len(records)} hour-window records to {output_path}",
        file=sys.stderr,
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build Order Flow Imbalance features from Binance aggTrades",
    )
    parser.add_argument(
        "--symbol",
        default="BTCUSDT",
        help="Trading pair symbol (default: BTCUSDT)",
    )
    parser.add_argument(
        "--month",
        required=True,
        help="Month in YYYY-MM format, e.g. 2024-01",
    )
    parser.add_argument(
        "--output",
        required=True,
        help="Output JSONL path (e.g. data/research/ofi_btc_2024-01.jsonl)",
    )
    args = parser.parse_args()

    process_month(args.symbol, args.month, args.output)


if __name__ == "__main__":
    main()
