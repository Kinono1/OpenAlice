"""
Generate cost-adjusted forward return labels from Binance ZIP data.

Computes point-in-time forward returns at a given horizon, adjusted for
estimated trading costs (fees, spread, slippage, funding).

Usage:
  /opt/miniconda3/bin/python3 scripts/train/generate_labels.py \\
    --symbols BTCUSDT,ETHUSDT \\
    --horizon 24h \\
    --fee-bps 5 \\
    --output data/research/labels.jsonl
"""

import argparse
import json
import os
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Optional

import numpy as np
import pandas as pd

# ─── Constants ────────────────────────────────────────────────────────────────

# Spot klines CSV (no header)
SPOT_KLINE_COLS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_asset_volume", "number_of_trades",
    "taker_buy_base_volume", "taker_buy_quote_volume", "ignore",
]

# Funding rate CSV (has header)
FUNDING_COLS = ["calc_time", "funding_interval_hours", "last_funding_rate"]

# Mark price klines CSV (has header)
MARK_KLINE_COLS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "count",
    "taker_buy_volume", "taker_buy_quote_volume", "ignore",
]

HORIZON_MAP = {
    "1h": 1,
    "4h": 4,
    "8h": 8,
    "24h": 24,
    "48h": 48,
    "72h": 72,
    "7d": 168,
    "30d": 720,
}

# ─── Helpers ──────────────────────────────────────────────────────────────────


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate cost-adjusted forward return labels from Binance ZIP data"
    )
    parser.add_argument(
        "--symbols",
        required=True,
        help="Comma-separated symbols, e.g. BTCUSDT,ETHUSDT",
    )
    parser.add_argument(
        "--horizon",
        default="24h",
        choices=list(HORIZON_MAP.keys()),
        help="Forward return horizon",
    )
    parser.add_argument(
        "--fee-bps",
        type=float,
        default=5.0,
        help="Taker fee in bps (per leg, default 5.0)",
    )
    parser.add_argument("--spread-bps", type=float, default=2.0, help="Estimated spread in bps")
    parser.add_argument("--slippage-bps", type=float, default=1.0, help="Estimated slippage in bps")
    parser.add_argument("--start-month", default="2020-01", help="Start month YYYY-MM")
    parser.add_argument("--end-month", default="2026-04", help="End month YYYY-MM")
    parser.add_argument("--output", required=True, help="Output JSONL path")
    return parser.parse_args()


def month_range(start_month: str, end_month: str):
    """Generate YYYY-MM strings from start to end inclusive."""
    start = datetime.strptime(start_month, "%Y-%m")
    end = datetime.strptime(end_month, "%Y-%m")
    months = []
    while start <= end:
        months.append(start.strftime("%Y-%m"))
        y = start.year
        m = start.month + 1
        if m > 12:
            m = 1
            y += 1
        start = datetime(y, m, 1)
    return months


def read_zip_csv(path: str, cols: list[str], has_header: bool = False) -> Optional[pd.DataFrame]:
    """Read a single ZIP file containing a CSV, return DataFrame or None."""
    if not os.path.isfile(path):
        return None
    try:
        with zipfile.ZipFile(path) as z:
            names = z.namelist()
            if not names:
                return None
            with z.open(names[0]) as f:
                kwargs = {"header": 0} if has_header else {"header": None, "names": cols}
                df = pd.read_csv(f, **kwargs)
        return df
    except Exception as e:
        print(f"  [WARN] Error reading {path}: {e}", file=sys.stderr)
        return None


def load_klines_data(
    symbol: str,
    months: list[str],
    data_root: str,
) -> Optional[pd.DataFrame]:
    """Load and normalize spot klines for one symbol across months."""
    klines_root = os.path.join(
        data_root, "spot-all-usdt-klines-1h", "spot", symbol, "1h"
    )
    dfs = []
    for month in months:
        path = os.path.join(klines_root, f"{symbol}-1h-{month}.zip")
        df = read_zip_csv(path, SPOT_KLINE_COLS, has_header=False)
        if df is not None and not df.empty:
            dfs.append(df)
    if not dfs:
        return None

    combined = pd.concat(dfs, ignore_index=True)
    result = combined[["open_time", "close"]].copy()
    result.columns = ["timestamp_ms", "close"]
    result["close"] = pd.to_numeric(result["close"], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


def load_funding_data(
    symbol: str,
    months: list[str],
    data_root: str,
) -> Optional[pd.DataFrame]:
    """Load and normalize funding rate data for one symbol."""
    funding_root = os.path.join(
        data_root, "um-all-usdt-fundingRate", "um", "fundingRate", symbol
    )
    dfs = []
    for month in months:
        path = os.path.join(funding_root, f"{symbol}-fundingRate-{month}.zip")
        df = read_zip_csv(path, FUNDING_COLS, has_header=True)
        if df is not None and not df.empty:
            dfs.append(df)
    if not dfs:
        return None

    combined = pd.concat(dfs, ignore_index=True)
    result = combined[["calc_time", "last_funding_rate"]].copy()
    result.columns = ["timestamp_ms", "rate"]
    result["rate"] = pd.to_numeric(result["rate"], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


def load_mark_price_data(
    symbol: str,
    months: list[str],
    data_root: str,
) -> Optional[pd.DataFrame]:
    """Load and normalize mark price klines for one symbol."""
    mark_root = os.path.join(
        data_root,
        "um-all-usdt-markPriceKlines-1h",
        "um",
        "markPriceKlines",
        symbol,
        "1h",
    )
    dfs = []
    for month in months:
        path = os.path.join(mark_root, f"{symbol}-1h-{month}.zip")
        df = read_zip_csv(path, MARK_KLINE_COLS, has_header=True)
        if df is not None and not df.empty:
            dfs.append(df)
    if not dfs:
        return None

    combined = pd.concat(dfs, ignore_index=True)
    result = combined[["open_time", "close"]].copy()
    result.columns = ["timestamp_ms", "close"]
    result["close"] = pd.to_numeric(result["close"], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


# ─── Label Computation ────────────────────────────────────────────────────────


def estimate_funding_cost(
    funding_df: Optional[pd.DataFrame],
    dt: pd.Timestamp,
    horizon_hours: int,
) -> float:
    """
    Estimate total funding cost over the holding period.

    Uses the most recent funding rate before `dt` and assumes it persists
    for the full horizon. Funding settles every 8 hours.

    Returns cost in bps (positive = cost to long, negative = rebate).
    """
    if funding_df is None or funding_df.empty:
        return 0.0

    # Latest funding rate <= dt
    mask = funding_df["timestamp"] <= dt
    if not mask.any():
        return 0.0

    latest = funding_df[mask].iloc[-1]
    rate = latest["rate"]

    if not np.isfinite(rate):
        return 0.0

    # Number of 8-hour funding intervals in the holding period
    n_intervals = horizon_hours / 8.0
    # Funding cost in bps (rate is in decimal, convert to bps: *10000)
    # If rate = 0.0001 (1bp per 8h), total cost over 24h = 3bps
    total_cost_bps = float(rate * n_intervals * 10000)
    return total_cost_bps


def compute_labels(
    symbols: list[str],
    ohlcv_map: dict[str, pd.DataFrame],
    funding_map: dict[str, pd.DataFrame],
    mark_map: dict[str, pd.DataFrame],
    horizon_hours: int,
    fee_bps: float,
    spread_bps: float,
    slippage_bps: float,
) -> list[dict]:
    """
    Compute cost-adjusted forward returns for each symbol at each bar timestamp.

    Label formula:
        forward_net_return = (close[t+horizon] / close[t] - 1) - estimated_cost

    Where estimated_cost accounts for:
    - Taker fee (both legs: entry + exit)
    - Spread
    - Slippage
    - Funding cost over holding period

    Returns list of dicts with keys: timestamp, symbol, forward_net_return_XXh,
    forward_gross_return_XXh, estimated_cost_bps.
    """
    horizon_label = f"forward_net_return_{horizon_hours}h"

    rows = []

    for symbol in symbols:
        bars = ohlcv_map.get(symbol)
        if bars is None or bars.empty:
            print(f"  [SKIP] No OHLCV data for {symbol}", file=sys.stderr)
            continue

        prices = bars["close"].values
        timestamps = bars["timestamp"].values
        n = len(prices)
        symbol_rows = []

        funding_df = funding_map.get(symbol)
        mark_df = mark_map.get(symbol)

        # Pre-compute cost estimate that doesn't depend on future data
        # Fee: entry + exit = 2 * fee_bps
        # Spread: estimated spread_bps
        # Slippage: estimated slippage_bps
        base_cost_bps = 2 * fee_bps + spread_bps + slippage_bps

        for i in range(n - horizon_hours):
            dt = timestamps[i]
            current_close = prices[i]
            future_close = prices[i + horizon_hours]

            if not np.isfinite(current_close) or current_close == 0:
                continue
            if not np.isfinite(future_close):
                continue

            # Gross return
            gross_return = float((future_close / current_close) - 1)

            # Funding cost over the holding period
            funding_cost_bps = estimate_funding_cost(
                funding_df, pd.Timestamp(dt), horizon_hours
            )

            # Total estimated cost in bps
            total_cost_bps = base_cost_bps + funding_cost_bps
            total_cost_decimal = total_cost_bps / 10000.0

            # Net return = gross - cost
            net_return = gross_return - total_cost_decimal

            ts_str = pd.Timestamp(dt).strftime("%Y-%m-%dT%H:%M:%SZ")

            symbol_rows.append(
                {
                    "timestamp": ts_str,
                    "symbol": symbol,
                    horizon_label: net_return,
                    f"forward_gross_return_{horizon_hours}h": gross_return,
                    "estimated_cost_bps": round(total_cost_bps, 4),
                }
            )

        rows.extend(symbol_rows)
        print(f"  {symbol}: {len(symbol_rows)} labels", file=sys.stderr)

    return rows


def sanitize_value(v):
    """Convert numpy types to native Python for JSON serialization."""
    if isinstance(v, (np.floating, float)):
        return None if not np.isfinite(v) else float(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


def sanitize_row(row: dict) -> dict:
    """Walk a row dict and convert non-serializable values."""
    return {k: sanitize_value(v) if not isinstance(v, (str, list, dict)) else v
            for k, v in row.items()}


# ─── Entry Point ──────────────────────────────────────────────────────────────


def main():
    args = parse_args()
    symbols = [s.strip() for s in args.symbols.split(",")]
    months = month_range(args.start_month, args.end_month)
    horizon_hours = HORIZON_MAP[args.horizon]
    data_root = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"

    horizon_label = f"forward_net_return_{horizon_hours}h"

    print(f"Labels: {len(symbols)} symbols, horizon={args.horizon} ({horizon_hours}h)", file=sys.stderr)
    print(f"  Symbols: {symbols}", file=sys.stderr)
    print(f"  Fee: {args.fee_bps} bps/leg, Spread: {args.spread_bps} bps, Slippage: {args.slippage_bps} bps", file=sys.stderr)
    print(f"  Months: {months[0]}...{months[-1]}", file=sys.stderr)
    t0 = time.time()

    # Load data
    ohlcv_map = {}
    funding_map = {}
    mark_map = {}

    for symbol in symbols:
        print(f"  Loading {symbol}...", file=sys.stderr)
        bars = load_klines_data(symbol, months, data_root)
        if bars is not None and not bars.empty:
            ohlcv_map[symbol] = bars
            print(f"    OHLCV: {len(bars)} bars", file=sys.stderr)

        fund = load_funding_data(symbol, months, data_root)
        if fund is not None and not fund.empty:
            funding_map[symbol] = fund

        mark = load_mark_price_data(symbol, months, data_root)
        if mark is not None and not mark.empty:
            mark_map[symbol] = mark

    t1 = time.time()
    print(f"Data loaded in {t1 - t0:.1f}s", file=sys.stderr)

    if not ohlcv_map:
        print("ERROR: No OHLCV data loaded.", file=sys.stderr)
        sys.exit(1)

    print(f"Computing labels...", file=sys.stderr)
    rows = compute_labels(
        symbols,
        ohlcv_map,
        funding_map,
        mark_map,
        horizon_hours,
        args.fee_bps,
        args.spread_bps,
        args.slippage_bps,
    )
    t2 = time.time()
    print(f"Labels computed: {len(rows)} rows in {t2 - t1:.1f}s", file=sys.stderr)

    # Ensure output directory exists
    output_path = args.output
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)

    # Write JSONL
    written = 0
    with open(output_path, "w") as f:
        for row in rows:
            safe = sanitize_row(row)
            f.write(json.dumps(safe, ensure_ascii=False) + "\n")
            written += 1

    t3 = time.time()
    print(f"Written {written} rows to {output_path} in {t3 - t2:.1f}s", file=sys.stderr)
    print(f"Total time: {t3 - t0:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
