#!/usr/bin/env python3
"""
Streaming Binance aggTrades feature builder.

Reads aggTrades ZIP files month-by-month, aggregates into 1h features,
and caches as parquet for downstream research consumption.

Streaming design:
  - Each ZIP is read row-by-row; only one hour of raw trades is held in
    memory at a time (typically < 100k rows for liquid pairs).
  - Parquet is written once per month per symbol.
  - Cache-hit detection avoids redundant processing.

Usage:
    python3 scripts/train/agg_trade_feature_builder.py --symbol BTCUSDT --market spot
    python3 scripts/train/agg_trade_feature_builder.py --symbol BTCUSDT --year-month 2024-01
    python3 scripts/train/agg_trade_feature_builder.py --all-mainstream
"""

import argparse
import csv
import io
import logging
import os
import sys
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Path constants
# ---------------------------------------------------------------------------

DATA_BASE: dict[str, str] = {
    "spot": (
        "/Volumes/shield/cryptoData/openalice-data/"
        "market/binance-public/spot-all-usdt-aggTrades/spot/aggTrades"
    ),
    "um": (
        "/Volumes/shield/cryptoData/openalice-data/"
        "market/binance-public/um-all-usdt-aggTrades/um/aggTrades"
    ),
}

CACHE_DIR = "data/research/agg_trade_features"

# ---------------------------------------------------------------------------
# aggTrades CSV column indices (no header row in official files)
#   0: agg_trade_id
#   1: price
#   2: quantity
#   3: first_trade_id
#   4: last_trade_id
#   5: trade_time       (13‑digit millisecond epoch)
#   6: is_buyer_maker
#   7: is_best_price_match
# ---------------------------------------------------------------------------
IDX_PRICE = 1
IDX_QTY = 2
IDX_TS = 5
IDX_IS_BUYER_MAKER = 6

# ---------------------------------------------------------------------------
# 24 mainstream USDT-margined coins (by approximate volume rank)
# ---------------------------------------------------------------------------
MAINSTREAM_COINS: list[str] = [
    "BTCUSDT",
    "ETHUSDT",
    "BNBUSDT",
    "SOLUSDT",
    "XRPUSDT",
    "ADAUSDT",
    "DOGEUSDT",
    "AVAXUSDT",
    "DOTUSDT",
    "LINKUSDT",
    "MATICUSDT",
    "UNIUSDT",
    "SHIBUSDT",
    "LTCUSDT",
    "ATOMUSDT",
    "ETCUSDT",
    "XLMUSDT",
    "BCHUSDT",
    "ALGOUSDT",
    "VETUSDT",
    "FILUSDT",
    "TRXUSDT",
    "NEARUSDT",
    "APTUSDT",
]

PROGRESS_INTERVAL = 2_000_000


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        stream=sys.stderr,
    )


# ===================================================================
# Hour-level computation
# ===================================================================


def _compute_hour_features(
    trades: list[tuple[float, float, bool]],
    hour_unix_s: int,
) -> dict | None:
    """Aggregate one hour of trade tuples into a single feature row.

    Parameters
    ----------
    trades : list of (price, quantity, is_buyer_maker)
        All trades falling inside this hour bucket.
    hour_unix_s : int
        Unix timestamp (seconds) at the start of the hour.

    Returns
    -------
    dict | None
        Feature row or ``None`` when *trades* is empty or volume is zero.
    """
    n_trades = len(trades)
    if n_trades == 0:
        return None

    prices = np.array([t[0] for t in trades], dtype=np.float64)
    quantities = np.array([t[1] for t in trades], dtype=np.float64)
    is_buyer_maker = np.array([t[2] for t in trades], dtype=bool)

    volume_usdt = prices * quantities
    total_vol = float(np.sum(volume_usdt))

    if total_vol < 1e-12:
        return None

    # 1. Trade flow imbalance
    #    is_buyer_maker == False → aggressive buyer (buy pressure)
    buy_vol = float(np.sum(volume_usdt[~is_buyer_maker]))
    sell_vol = float(np.sum(volume_usdt[is_buyer_maker]))
    trade_flow_imbalance = (buy_vol - sell_vol) / total_vol

    # 2. Large trade ratio
    q_mean = float(np.mean(quantities))
    q_std = float(np.std(quantities, ddof=0))
    if q_std > 0:
        large_count = int(np.sum(quantities > q_mean + 3.0 * q_std))
    else:
        large_count = 0
    large_trade_ratio = large_count / n_trades

    # 3. Tick volatility — std of log(price_i / price_{i-1})
    if n_trades >= 2:
        log_returns = np.diff(np.log(prices))
        tick_volatility = float(np.std(log_returns, ddof=0))
    else:
        tick_volatility = 0.0

    # 4. VWAP deviation
    vwap = float(np.average(prices, weights=quantities))
    last_price = float(prices[-1])
    vwap_deviation = last_price / vwap - 1.0

    # 5. VPIN proxy — hourly |imbalance| (simplified VPIN)
    vpin_proxy = abs(trade_flow_imbalance)

    hour_dt = datetime.fromtimestamp(hour_unix_s, tz=timezone.utc)

    return {
        "timestamp": hour_dt,
        "trade_flow_imbalance": round(trade_flow_imbalance, 6),
        "large_trade_ratio": round(large_trade_ratio, 6),
        "tick_volatility": round(tick_volatility, 8),
        "vwap_deviation": round(vwap_deviation, 8),
        "vpin_proxy": round(vpin_proxy, 6),
        "n_trades": n_trades,
        "total_volume_usdt": round(total_vol, 2),
    }


# ===================================================================
# Monthly processing
# ===================================================================


def process_agg_trades_month(
    symbol: str,
    year_month: str,
    base_dir: str | None = None,
    market: str = "spot",
    cache_dir: str | None = None,
) -> str | None:
    """Process one month of aggTrades, write aggregated parquet cache.

    The entire month is streamed row-by-row from the ZIP.  Only a single
    hour's worth of trades is held in memory at any moment.

    Parameters
    ----------
    symbol : str
        Trading pair symbol, e.g. ``"BTCUSDT"``.
    year_month : str
        Month string in ``"2024-01"`` format.
    base_dir : str | None
        Override aggTrades data root directory.  Falls back to
        ``DATA_BASE[market]``.
    market : str
        ``"spot"`` or ``"um"`` (Binance futures).
    cache_dir : str | None
        Parquet cache root.  Falls back to ``CACHE_DIR``.

    Returns
    -------
    str | None
        Absolute path to the cached parquet file, or ``None`` when
        the month is skipped (missing ZIP, corrupt file, empty data,
        or cache already exists).
    """
    base = base_dir or DATA_BASE.get(market)
    if base is None:
        logger.error("Unknown market '%s'; valid values: spot, um", market)
        return None

    cache_root = cache_dir or CACHE_DIR
    if not os.path.isabs(cache_root):
        cache_root = os.path.abspath(cache_root)

    year, month = year_month.split("-")
    zip_path = os.path.join(
        base, symbol, f"{symbol}-aggTrades-{year}-{month}.zip"
    )
    cache_path = os.path.join(
        cache_root, market, symbol, f"{year_month}.parquet"
    )

    # ----- cache hit -------------------------------------------------------
    if os.path.isfile(cache_path):
        logger.info("Cache hit: %s", cache_path)
        return cache_path

    # ----- missing ZIP (skip) ----------------------------------------------
    if not os.path.isfile(zip_path):
        logger.info("ZIP not found: %s — skip", zip_path)
        return None

    logger.info("Processing %s %s %s ...", market.upper(), symbol, year_month)

    # ----- open ZIP --------------------------------------------------------
    try:
        zf = zipfile.ZipFile(zip_path, "r")
    except (zipfile.BadZipFile, OSError) as exc:
        logger.warning("Corrupt ZIP %s: %s", zip_path, exc)
        return None

    # ----- stream rows, aggregate per hour --------------------------------
    records: list[dict] = []
    current_hour_ts: int | None = None
    hour_buffer: list[tuple[float, float, bool]] = []
    row_count = 0

    try:
        csv_files = [n for n in zf.namelist() if n.endswith(".csv")]
        if not csv_files:
            logger.warning("No CSV inside %s", zip_path)
            return None
        csv_name = csv_files[0]

        with zf.open(csv_name) as raw:
            reader = csv.reader(io.TextIOWrapper(raw, encoding="utf-8"))

            for row in reader:
                # Skip malformed / empty lines
                if not row or len(row) < 8:
                    continue

                # Skip CSV header row when present
                if row_count == 0:
                    try:
                        int(row[0])
                    except (ValueError, IndexError):
                        continue

                ts_ms = int(row[IDX_TS])
                price = float(row[IDX_PRICE])
                qty = float(row[IDX_QTY])
                is_buyer_maker = (
                    row[IDX_IS_BUYER_MAKER].strip().lower() == "true"
                )

                # Floor milliseconds to hour boundary (unix seconds)
                hour_ts = (ts_ms // 3_600_000) * 3600

                if current_hour_ts is None:
                    current_hour_ts = hour_ts

                # Flush previous hour when we cross a boundary
                if hour_ts != current_hour_ts:
                    feat = _compute_hour_features(
                        hour_buffer, current_hour_ts
                    )
                    if feat is not None:
                        records.append(feat)
                    hour_buffer = []
                    current_hour_ts = hour_ts

                hour_buffer.append((price, qty, is_buyer_maker))
                row_count += 1

                if row_count % PROGRESS_INTERVAL == 0:
                    logger.info("  %s rows ...", f"{row_count:,}")

        # Flush the final hour
        if hour_buffer:
            feat = _compute_hour_features(hour_buffer, current_hour_ts)
            if feat is not None:
                records.append(feat)

    finally:
        zf.close()

    # ----- empty guard -----------------------------------------------------
    if not records:
        logger.warning(
            "No hourly features for %s %s", symbol, year_month
        )
        return None

    logger.info(
        "  %s raw rows → %s hourly records",
        f"{row_count:,}",
        len(records),
    )

    # ----- write parquet ---------------------------------------------------
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    df = pd.DataFrame(records)
    df.to_parquet(cache_path, index=False)

    logger.info("Wrote %d rows → %s", len(df), cache_path)
    return cache_path


# ===================================================================
# Full-symbol sweep
# ===================================================================


def process_symbol(
    symbol: str,
    base_dir: str | None = None,
    market: str = "spot",
    cache_dir: str | None = None,
) -> int:
    """Process all available aggTrades months for a symbol.

    Discovers ZIP files on disk by scanning the data directory.
    Each month is processed independently via ``process_agg_trades_month``.

    Parameters
    ----------
    symbol : str
        Trading pair symbol, e.g. ``"BTCUSDT"``.
    base_dir : str | None
        Override data root.
    market : str
        ``"spot"`` or ``"um"``.
    cache_dir : str | None
        Parquet cache root.

    Returns
    -------
    int
        Number of months successfully processed (cached or fresh).
    """
    base = base_dir or DATA_BASE.get(market)
    if base is None:
        logger.error("Unknown market '%s'", market)
        return 0

    symbol_dir = os.path.join(base, symbol)
    if not os.path.isdir(symbol_dir):
        logger.warning("Symbol directory not found: %s", symbol_dir)
        return 0

    zip_files = sorted(
        f
        for f in os.listdir(symbol_dir)
        if f.startswith(f"{symbol}-aggTrades-") and f.endswith(".zip")
    )

    if not zip_files:
        logger.warning(
            "No aggTrades ZIP files for %s in %s", symbol, symbol_dir
        )
        return 0

    n_done = 0
    for zip_name in zip_files:
        # Extract YYYY-MM from "BTCUSDT-aggTrades-2024-01.zip"
        stem = zip_name.replace(".zip", "")
        parts = stem.split("-")  # [symbol, "aggTrades", YYYY, MM]
        if len(parts) >= 4:
            year_month = f"{parts[-2]}-{parts[-1]}"
        else:
            continue

        result = process_agg_trades_month(
            symbol=symbol,
            year_month=year_month,
            base_dir=base_dir,
            market=market,
            cache_dir=cache_dir,
        )
        if result is not None:
            n_done += 1

    logger.info(
        "Symbol %s: %d / %d month(s) processed",
        symbol,
        n_done,
        len(zip_files),
    )
    return n_done


# ===================================================================
# Data loading
# ===================================================================


def load_agg_features(
    symbol: str,
    market: str = "spot",
    cache_dir: str | None = None,
) -> pd.DataFrame:
    """Load cached aggregated features for a symbol across all months.

    Concatenates all per-month parquet files into a single DataFrame,
    sorted ascending by timestamp.

    Parameters
    ----------
    symbol : str
        Trading pair symbol.
    market : str
        ``"spot"`` or ``"um"``.
    cache_dir : str | None
        Parquet cache root.  Falls back to ``CACHE_DIR``.

    Returns
    -------
    pd.DataFrame
        Hourly features with columns ``timestamp``, ``trade_flow_imbalance``,
        ``large_trade_ratio``, ``tick_volatility``, ``vwap_deviation``,
        ``vpin_proxy``, ``n_trades``, ``total_volume_usdt``, plus a
        ``symbol`` column.  Returns an empty DataFrame when no cache exists.
    """
    cache_root = cache_dir or CACHE_DIR
    if not os.path.isabs(cache_root):
        cache_root = os.path.abspath(cache_root)

    cache_symbol_dir = os.path.join(cache_root, market, symbol)
    if not os.path.isdir(cache_symbol_dir):
        logger.warning("No cache directory for %s", f"{market}/{symbol}")
        return pd.DataFrame()

    parquet_files = sorted(
        f
        for f in os.listdir(cache_symbol_dir)
        if f.endswith(".parquet")
    )

    if not parquet_files:
        logger.info(
            "No parquet files in %s", cache_symbol_dir
        )
        return pd.DataFrame()

    frames: list[pd.DataFrame] = []
    for pf in parquet_files:
        path = os.path.join(cache_symbol_dir, pf)
        try:
            df = pd.read_parquet(path)
        except Exception as exc:
            logger.warning("Failed to read %s: %s", path, exc)
            continue
        frames.append(df)

    if not frames:
        return pd.DataFrame()

    result = pd.concat(frames, ignore_index=True)
    result["timestamp"] = pd.to_datetime(result["timestamp"], utc=True)

    if "symbol" not in result.columns:
        result["symbol"] = symbol

    result = result.sort_values("timestamp").reset_index(drop=True)
    return result


# ===================================================================
# IC computation
# ===================================================================


def compute_ic(
    factor_name: str,
    factor_series: pd.Series,
    forward_returns: pd.Series,
) -> dict:
    """Compute Spearman Rank IC between a factor series and forward returns.

    Parameters
    ----------
    factor_name : str
        Label for the factor (included in the returned dict).
    factor_series : pd.Series
        Factor values, typically indexed by timestamp.
    forward_returns : pd.Series
        Aligned forward-return series.

    Returns
    -------
    dict
        Keys: ``factor``, ``spearman_ic``, ``n`` (number of valid pairs).
    """
    valid = factor_series.notna() & forward_returns.notna()
    n_valid = int(valid.sum())
    if n_valid < 3:
        return {"factor": factor_name, "spearman_ic": 0.0, "n": n_valid}

    ic = factor_series[valid].corr(forward_returns[valid], method="spearman")
    return {
        "factor": factor_name,
        "spearman_ic": float(ic) if pd.notna(ic) else 0.0,
        "n": n_valid,
    }


# ===================================================================
# CLI
# ===================================================================


def main() -> None:
    _setup_logging()

    parser = argparse.ArgumentParser(
        description="Build aggTrade features from Binance aggTrades ZIP files",
    )
    parser.add_argument(
        "--symbol",
        default=None,
        help="Trading pair symbol (e.g. BTCUSDT). Ignored with --all-mainstream.",
    )
    parser.add_argument(
        "--market",
        choices=("spot", "um"),
        default="spot",
        help="Market segment: spot | um  (default: spot).",
    )
    parser.add_argument(
        "--year-month",
        default=None,
        help="Single month to process in YYYY-MM format. Omit to scan all.",
    )
    parser.add_argument(
        "--all-mainstream",
        action="store_true",
        help="Process the 24 mainstream coins.",
    )
    parser.add_argument(
        "--base-dir",
        default=None,
        help="Override aggTrades data root directory.",
    )
    parser.add_argument(
        "--cache-dir",
        default=None,
        help="Override parquet cache root directory.",
    )
    args = parser.parse_args()

    # Resolve symbol list
    if args.all_mainstream:
        symbols = MAINSTREAM_COINS
    elif args.symbol:
        symbols = [args.symbol.upper()]
    else:
        parser.print_help()
        sys.exit(1)

    total_processed = 0
    for sym in symbols:
        if args.year_month is not None:
            result = process_agg_trades_month(
                symbol=sym,
                year_month=args.year_month,
                base_dir=args.base_dir,
                market=args.market,
                cache_dir=args.cache_dir,
            )
            if result is not None:
                total_processed += 1
        else:
            n = process_symbol(
                symbol=sym,
                base_dir=args.base_dir,
                market=args.market,
                cache_dir=args.cache_dir,
            )
            total_processed += n

    logger.info("Done. %d month(s) processed.", total_processed)


if __name__ == "__main__":
    main()
