"""
Generate feature matrix from Binance ZIP data.

Replicates the logic in src/domain/features/feature_builder.ts for historical mode:
load OHLCV + funding + mark price data, compute PIT-compliant features row by row,
and output JSONL.

Usage:
  /opt/miniconda3/bin/python3 scripts/train/generate_features.py \
    --symbols BTCUSDT,ETHUSDT \
    --start-month 2020-01 --end-month 2026-04 \
    --output data/research/features.jsonl
"""

import argparse
import json
import os
import sys
import time
import zipfile
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

# ─── Constants ────────────────────────────────────────────────────────────────

FRESHNESS_THRESHOLD = 0.8
FUNDING_30D_PERIODS = 720

# Spot klines CSV (no header): open_time,open,high,low,close,volume,close_time,...
SPOT_KLINE_COLS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_asset_volume", "number_of_trades",
    "taker_buy_base_volume", "taker_buy_quote_volume", "ignore",
]

# Funding rate CSV (has header): calc_time,funding_interval_hours,last_funding_rate
FUNDING_COLS = ["calc_time", "funding_interval_hours", "last_funding_rate"]

# Mark price klines CSV (has header): open_time,open,high,low,close,volume,close_time,...
MARK_KLINE_COLS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_volume", "count",
    "taker_buy_volume", "taker_buy_quote_volume", "ignore",
]

ALL_FEATURE_KEYS = [
    "ret_1h", "ret_4h", "ret_24h", "realized_vol_24h", "volume_z_24h",
    "funding_rate", "funding_z_30d", "oi_change_24h", "basis_bps",
    "btc_ret_24h", "market_dispersion",
]

# ─── Helpers ──────────────────────────────────────────────────────────────────


def parse_args():
    parser = argparse.ArgumentParser(
        description="Generate feature matrix from Binance ZIP data"
    )
    parser.add_argument(
        "--symbols",
        required=True,
        help="Comma-separated symbols, e.g. BTCUSDT,ETHUSDT",
    )
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


def load_symbol_data(
    symbol: str,
    months: list[str],
    data_root: str,
) -> tuple[Optional[pd.DataFrame], Optional[pd.DataFrame], Optional[pd.DataFrame]]:
    """Load OHLCV, funding, and mark price data for one symbol across months."""
    klines_root = os.path.join(
        data_root, "spot-all-usdt-klines-1h", "spot", symbol, "1h"
    )
    funding_root = os.path.join(
        data_root, "um-all-usdt-fundingRate", "um", "fundingRate", symbol
    )
    mark_root = os.path.join(
        data_root,
        "um-all-usdt-markPriceKlines-1h",
        "um",
        "markPriceKlines",
        symbol,
        "1h",
    )

    ohlcv_dfs = []
    funding_dfs = []
    mark_dfs = []

    for month in months:
        # Klines (spot)
        klines_path = os.path.join(klines_root, f"{symbol}-1h-{month}.zip")
        df = read_zip_csv(klines_path, SPOT_KLINE_COLS, has_header=False)
        if df is not None and not df.empty:
            ohlcv_dfs.append(df)

        # Funding rate
        funding_path = os.path.join(funding_root, f"{symbol}-fundingRate-{month}.zip")
        df_f = read_zip_csv(funding_path, FUNDING_COLS, has_header=True)
        if df_f is not None and not df_f.empty:
            funding_dfs.append(df_f)

        # Mark price klines
        mark_path = os.path.join(mark_root, f"{symbol}-1h-{month}.zip")
        df_m = read_zip_csv(mark_path, MARK_KLINE_COLS, has_header=True)
        if df_m is not None and not df_m.empty:
            mark_dfs.append(df_m)

    ohlcv = pd.concat(ohlcv_dfs, ignore_index=True) if ohlcv_dfs else None
    funding = pd.concat(funding_dfs, ignore_index=True) if funding_dfs else None
    mark_price = pd.concat(mark_dfs, ignore_index=True) if mark_dfs else None

    return ohlcv, funding, mark_price


def normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """Convert raw klines DataFrame to standard OHLCV with datetime index."""
    if df is None or df.empty:
        return pd.DataFrame()
    result = df[["open_time", "open", "high", "low", "close", "volume"]].copy()
    result.columns = ["timestamp_ms", "open", "high", "low", "close", "volume"]
    for col in ["open", "high", "low", "close", "volume"]:
        result[col] = pd.to_numeric(result[col], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


def normalize_funding(df: pd.DataFrame) -> pd.DataFrame:
    """Convert raw funding rate data to standardized format."""
    if df is None or df.empty:
        return pd.DataFrame()
    result = df[["calc_time", "last_funding_rate"]].copy()
    result.columns = ["timestamp_ms", "rate"]
    result["rate"] = pd.to_numeric(result["rate"], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


def normalize_mark_price(df: pd.DataFrame) -> pd.DataFrame:
    """Convert raw mark price klines to standard OHLCV format."""
    if df is None or df.empty:
        return pd.DataFrame()
    result = df[["open_time", "open", "high", "low", "close", "volume"]].copy()
    result.columns = ["timestamp_ms", "open", "high", "low", "close", "volume"]
    for col in ["open", "high", "low", "close", "volume"]:
        result[col] = pd.to_numeric(result[col], errors="coerce")
    result["timestamp"] = pd.to_datetime(result["timestamp_ms"], unit="ms")
    result = result.drop(columns=["timestamp_ms"])
    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


# ─── Statistics ──────────────────────────────────────────────────────────────


def _std(values: np.ndarray) -> float:
    """Sample standard deviation (ddof=1)."""
    if len(values) < 2:
        return float("nan")
    return float(np.std(values, ddof=1))


def _mean(values: np.ndarray) -> float:
    if len(values) == 0:
        return float("nan")
    return float(np.mean(values))


def _z_score(value: float, arr: np.ndarray) -> Optional[float]:
    m = _mean(arr)
    s = _std(arr)
    if not np.isfinite(s) or s == 0:
        return None
    return float((value - m) / s)


# ─── Per-Symbol Feature Computation ──────────────────────────────────────────


def compute_symbol_features(
    bars: pd.DataFrame,
    funding: pd.DataFrame,
    mark_price: pd.DataFrame,
) -> dict:
    """
    Compute all per-symbol features at the LAST bar in `bars`.

    Matches the logic of computeSymbolFeatures() in feature_builder.ts.

    Parameters
    ----------
    bars : pd.DataFrame
        Sorted OHLCV bars up to and including the current decision time, with
        columns ['timestamp', 'open', 'high', 'low', 'close', 'volume'].
    funding : pd.DataFrame
        Sorted funding rate points with timestamps <= decision time.
    mark_price : pd.DataFrame
        Sorted mark price bars with timestamps <= decision time.

    Returns
    -------
    dict with keys matching ALL_FEATURE_KEYS. Missing/invalid values are None.
    """
    features = {k: None for k in ALL_FEATURE_KEYS}
    n = len(bars)

    if n == 0:
        return features

    # ------- ret_1h -------
    if n >= 2:
        prev_close = bars.iloc[-2]["close"]
        if prev_close != 0 and np.isfinite(prev_close):
            features["ret_1h"] = (bars.iloc[-1]["close"] - prev_close) / prev_close

    # ------- ret_4h -------
    if n >= 5:
        prev_close = bars.iloc[-5]["close"]
        if prev_close != 0 and np.isfinite(prev_close):
            features["ret_4h"] = (bars.iloc[-1]["close"] - prev_close) / prev_close

    # ------- ret_24h -------
    if n >= 25:
        prev_close = bars.iloc[-25]["close"]
        if prev_close != 0 and np.isfinite(prev_close):
            features["ret_24h"] = (bars.iloc[-1]["close"] - prev_close) / prev_close

    # ------- realized_vol_24h -------
    if n >= 25:
        closes = bars["close"].values
        rets = []
        for i in range(n - 24, n):
            pc = closes[i - 1]
            if pc != 0 and np.isfinite(pc):
                rets.append((closes[i] - pc) / pc)
        if len(rets) >= 2:
            v = _std(np.array(rets))
            features["realized_vol_24h"] = v if np.isfinite(v) else None

    # ------- volume_z_24h -------
    if n >= 24:
        volumes = bars["volume"].values[-24:]
        latest_vol = float(bars.iloc[-1]["volume"])
        features["volume_z_24h"] = _z_score(latest_vol, volumes)

    # ------- funding_rate -------
    if funding is not None and len(funding) >= 1:
        features["funding_rate"] = float(funding.iloc[-1]["rate"])

    # ------- funding_z_30d -------
    if funding is not None and len(funding) >= FUNDING_30D_PERIODS:
        window = funding.iloc[-FUNDING_30D_PERIODS:]
        rates = window["rate"].values
        latest_rate = float(window.iloc[-1]["rate"])
        features["funding_z_30d"] = _z_score(latest_rate, rates)

    # ------- oi_change_24h ------- (always None — no OI data source in this script)
    # Kept as None per TS implementation contract.

    # ------- basis_bps -------
    if mark_price is not None and len(mark_price) >= 1 and n >= 1:
        futures_close = float(mark_price.iloc[-1]["close"])
        spot_close = float(bars.iloc[-1]["close"])
        if spot_close != 0 and np.isfinite(spot_close):
            features["basis_bps"] = ((futures_close - spot_close) / spot_close) * 10000

    return features


# ─── Data Loading ─────────────────────────────────────────────────────────────


def load_all_data(
    symbols: list[str],
    months: list[str],
    data_root: str,
) -> tuple[dict[str, pd.DataFrame], dict[str, pd.DataFrame], dict[str, pd.DataFrame]]:
    """Load normalized data for all symbols.

    Returns (ohlcv_map, funding_map, mark_map) where each is a dict
    symbol -> normalized DataFrame.
    """
    ohlcv_map = {}
    funding_map = {}
    mark_map = {}

    for symbol in symbols:
        print(f"  Loading {symbol}...", file=sys.stderr)
        ohlcv, funding, mark_price = load_symbol_data(symbol, months, data_root)

        df_ohlcv = normalize_ohlcv(ohlcv)
        if not df_ohlcv.empty:
            ohlcv_map[symbol] = df_ohlcv
            print(f"    OHLCV: {len(df_ohlcv)} bars", file=sys.stderr)

        df_funding = normalize_funding(funding)
        if not df_funding.empty:
            funding_map[symbol] = df_funding
            print(f"    Funding: {len(df_funding)} points", file=sys.stderr)

        df_mark = normalize_mark_price(mark_price)
        if not df_mark.empty:
            mark_map[symbol] = df_mark
            print(f"    Mark: {len(df_mark)} bars", file=sys.stderr)

    return ohlcv_map, funding_map, mark_map


# ─── Main Feature Matrix Builder ──────────────────────────────────────────────


def get_btc_symbol(symbols: list[str]) -> Optional[str]:
    """Find the BTC symbol in a list (by convention BTCUSDT)."""
    for s in symbols:
        if s.lower().startswith("btc") or "btc" in s.lower():
            return s
    return None


def compute_freshness(features: dict, max_possible: int) -> float:
    """Fraction of non-null features out of max_possible."""
    if max_possible == 0:
        return 1.0
    non_null = sum(1 for k in ALL_FEATURE_KEYS if features.get(k) is not None)
    return non_null / max_possible


def compute_max_possible(
    symbol: str,
    btc_symbol: Optional[str],
    has_funding: bool,
    has_mark_and_spot: bool,
    multi_symbol_has_ret24h: bool,
) -> int:
    """Number of features that *could* be non-null given available data sources."""
    count = 5  # ret_1h, ret_4h, ret_24h, realized_vol_24h, volume_z_24h
    if has_funding:
        count += 2  # funding_rate, funding_z_30d
    # oi_change_24h not added — no OI data source
    if has_mark_and_spot:
        count += 1  # basis_bps
    if btc_symbol is not None and symbol != btc_symbol:
        count += 1  # btc_ret_24h
    if multi_symbol_has_ret24h:
        count += 1  # market_dispersion
    return count


def build_feature_matrix(
    symbols: list[str],
    ohlcv_map: dict[str, pd.DataFrame],
    funding_map: dict[str, pd.DataFrame],
    mark_map: dict[str, pd.DataFrame],
) -> list[dict]:
    """
    Compute PIT-compliant feature matrix replicating feature_builder.ts.

    For each unique bar timestamp (aligned across symbols), compute per-symbol
    features using only data up to that timestamp, then compute cross-sectional
    features, filter by freshness, and collect rows.
    """
    if not symbols or not ohlcv_map:
        return []

    # Collect all unique timestamps across all symbols
    ts_set: set[pd.Timestamp] = set()
    for sym, df in ohlcv_map.items():
        if not df.empty:
            ts_set.update(df["timestamp"].values)

    if not ts_set:
        return []

    sorted_timestamps = sorted(ts_set)

    # Pre-compute the list of symbols that have at least some OHLCV data
    active_symbols = [s for s in symbols if s in ohlcv_map and not ohlcv_map[s].empty]
    btc_symbol = get_btc_symbol(active_symbols)

    rows = []

    # Precompute "has_*" flags at the data-source level
    has_any_funding = len(funding_map) > 0
    has_any_mark = len(mark_map) > 0

    total_ts = len(sorted_timestamps)
    report_interval = max(1, total_ts // 20)

    for idx, dt in enumerate(sorted_timestamps):
        if idx % report_interval == 0:
            pct = idx / total_ts * 100
            print(f"  Processing: {idx}/{total_ts} timestamps ({pct:.0f}%)", file=sys.stderr)

        # Phase 1: per-symbol features
        symbol_feats: dict[str, dict] = {}
        symbol_latest_ms: dict[str, Optional[int]] = {}

        for symbol in active_symbols:
            bars = ohlcv_map.get(symbol)
            if bars is None or bars.empty:
                # No data for this symbol at all
                symbol_feats[symbol] = {k: None for k in ALL_FEATURE_KEYS}
                symbol_latest_ms[symbol] = None
                continue

            # Slice bars up to and including decision time
            bars_up_to = bars[bars["timestamp"] <= dt]
            if bars_up_to.empty:
                symbol_feats[symbol] = {k: None for k in ALL_FEATURE_KEYS}
                symbol_latest_ms[symbol] = None
                continue

            latest_ts = bars_up_to.iloc[-1]["timestamp"]
            symbol_latest_ms[symbol] = int(latest_ts.timestamp() * 1000)

            # Funding up to dt
            fund_up_to = funding_map.get(symbol)
            if fund_up_to is not None and not fund_up_to.empty:
                fund_up_to = fund_up_to[fund_up_to["timestamp"] <= dt]

            # Mark price up to dt
            mark_up_to = mark_map.get(symbol)
            if mark_up_to is not None and not mark_up_to.empty:
                mark_up_to = mark_up_to[mark_up_to["timestamp"] <= dt]

            feats = compute_symbol_features(bars_up_to, fund_up_to, mark_up_to)
            symbol_feats[symbol] = feats

        # Phase 2: cross-sectional features

        # btc_ret_24h
        btc_ret24h = None
        if btc_symbol is not None:
            btc_feats = symbol_feats.get(btc_symbol)
            if btc_feats is not None:
                btc_ret24h = btc_feats.get("ret_24h")

        for sym, feats in symbol_feats.items():
            if sym == btc_symbol:
                feats["btc_ret_24h"] = None  # BTC does not get its own btc_ret_24h
            else:
                feats["btc_ret_24h"] = btc_ret24h

        # market_dispersion: std of ret_24h across all symbols
        ret24h_values = []
        for feats in symbol_feats.values():
            r = feats.get("ret_24h")
            if r is not None:
                ret24h_values.append(r)

        market_disp = None
        if len(ret24h_values) >= 2:
            d = _std(np.array(ret24h_values))
            market_disp = d if np.isfinite(d) else None

        for feats in symbol_feats.values():
            feats["market_dispersion"] = market_disp

        # Phase 3: build rows, filter by freshness
        multi_symbol_has_ret24h = len(ret24h_values) >= 2
        decision_ts = pd.Timestamp(dt)
        decision_ts_str = decision_ts.strftime("%Y-%m-%dT%H:%M:%SZ")

        for symbol in active_symbols:
            feats = symbol_feats.get(symbol)
            if feats is None:
                continue

            sym_has_funding = (
                has_any_funding
                and symbol in funding_map
                and funding_map[symbol] is not None
                and len(funding_map[symbol]) > 0
            )
            sym_has_mark_and_spot = (
                has_any_mark
                and symbol in mark_map
                and mark_map[symbol] is not None
                and len(mark_map[symbol]) > 0
                and symbol in ohlcv_map
                and not ohlcv_map[symbol].empty
            )

            max_possible = compute_max_possible(
                symbol,
                btc_symbol,
                sym_has_funding,
                sym_has_mark_and_spot,
                multi_symbol_has_ret24h,
            )
            freshness = compute_freshness(feats, max_possible)

            if freshness < FRESHNESS_THRESHOLD:
                continue

            latest_ms = symbol_latest_ms.get(symbol)
            cutoff_ms = int(decision_ts.timestamp() * 1000)
            data_lag_ms = cutoff_ms - latest_ms if latest_ms is not None else 0
            data_lag_ms = max(0, data_lag_ms)

            row = {
                "timestamp": decision_ts_str,
                "symbol": symbol,
                "features": {
                    "ret_1h": feats.get("ret_1h"),
                    "ret_4h": feats.get("ret_4h"),
                    "ret_24h": feats.get("ret_24h"),
                    "realized_vol_24h": feats.get("realized_vol_24h"),
                    "volume_z_24h": feats.get("volume_z_24h"),
                    "funding_rate": feats.get("funding_rate"),
                    "funding_z_30d": feats.get("funding_z_30d"),
                    "oi_change_24h": feats.get("oi_change_24h"),
                    "basis_bps": feats.get("basis_bps"),
                    "btc_ret_24h": feats.get("btc_ret_24h"),
                    "market_dispersion": feats.get("market_dispersion"),
                },
                "metadata": {
                    "feature_freshness": freshness,
                    "data_lag_ms": data_lag_ms,
                    "decision_time": decision_ts_str,
                },
            }
            rows.append(row)

    return rows


def serialize_value(v):
    """Serialize a value for JSON output. Converts numpy types to native."""
    if isinstance(v, (np.floating, float)):
        if np.isfinite(v):
            return float(v)
        return None
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


def sanitize_row(row: dict) -> dict:
    """Walk a row dict and convert non-serializable values to JSON-safe forms."""
    if isinstance(row, dict):
        return {k: sanitize_row(v) for k, v in row.items()}
    elif isinstance(row, list):
        return [sanitize_row(item) for item in row]
    else:
        return serialize_value(row)


# ─── Entry Point ─────────────────────────────────────────────────────────────


def main():
    args = parse_args()
    symbols = [s.strip() for s in args.symbols.split(",")]
    months = month_range(args.start_month, args.end_month)
    data_root = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"

    print(f"Features: loading {len(symbols)} symbols, {len(months)} months", file=sys.stderr)
    print(f"  Symbols: {symbols}", file=sys.stderr)
    print(f"  Months: {months[0]}...{months[-1]}", file=sys.stderr)
    t0 = time.time()

    ohlcv_map, funding_map, mark_map = load_all_data(symbols, months, data_root)
    t1 = time.time()
    print(f"Data loaded in {t1 - t0:.1f}s", file=sys.stderr)

    if not ohlcv_map:
        print("ERROR: No OHLCV data loaded for any symbol.", file=sys.stderr)
        sys.exit(1)

    print(f"Building feature matrix...", file=sys.stderr)
    rows = build_feature_matrix(symbols, ohlcv_map, funding_map, mark_map)
    t2 = time.time()
    print(f"Feature matrix built: {len(rows)} rows in {t2 - t1:.1f}s", file=sys.stderr)

    # Ensure output directory exists
    output_path = args.output
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

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
