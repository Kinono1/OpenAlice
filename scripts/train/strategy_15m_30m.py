#!/usr/bin/env python3
"""
15m/30m WFO strategy test — three intraday strategies across top 15 spot coins.

Strategies:
  A (low_vol_15m): 15m low-vol
     - realized_vol over last 16 bars
     - Select bottom 25% (lowest vol)
     - Equal-weight, rebalance every 16 bars (4h)
     - Cost: 20bps

  B (reversal_30m): 30m reversal
     - ret_48bars (24h return)
     - Buy bottom 25% (most negative = reversal)
     - Equal-weight, rebalance daily (every 48 bars)
     - Cost: 15bps

  C (momentum_vol_15m): 15m momentum + volume filter
     - ret_16bars (4h return) + volume_z > 0 filter
     - Select top 25% by return, volume-confirmed
     - Equal-weight, rebalance every 16 bars (4h)
     - Cost: 20bps

Data: Binance spot USDT klines from OpenAlice warehouse (ZIP format).
WFO walk-forward only — no secrets, no API calls, read-only.

Output: data/research/strategy_15m_30m_report.json
"""

import json
import os
import sys
import warnings
import zipfile
from datetime import datetime, timezone, timedelta

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
DATA_ROOT_15M = f"{BASE}/spot-all-usdt-klines-15m/spot"
DATA_ROOT_30M = f"{BASE}/spot-all-usdt-klines-30m/spot"

START_DATE = "2024-01-01"
END_DATE = "2024-12-31"

# Top 15 USDT pairs by data availability (excluding leveraged/stable)
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
    "UNIUSDT", "LTCUSDT", "BCHUSDT", "ATOMUSDT", "NEARUSDT",
]

OUTPUT_PATH = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
    "/data/research/strategy_15m_30m_report.json"
)

STRATEGIES = {
    "low_vol_15m": {
        "tf": "15m",
        "lookback_bars": 16,
        "rebal_bars": 16,
        "pct": 0.25,
        "direction": "low",
        "cost_bps": 20,
        "train_days": 30,
        "test_days": 3,
        "step_days": 1,
        "description": "15m realized_vol 16 bars, bottom 25%, equal-weight, 4h rebalance",
    },
    "reversal_30m": {
        "tf": "30m",
        "lookback_bars": 48,
        "rebal_bars": 48,
        "pct": 0.25,
        "direction": "low",
        "cost_bps": 15,
        "train_days": 60,
        "test_days": 7,
        "step_days": 1,
        "description": "30m ret_48bars (24h), bottom 25%, equal-weight, daily rebalance",
    },
    "momentum_vol_15m": {
        "tf": "15m",
        "lookback_bars": 16,
        "rebal_bars": 16,
        "pct": 0.25,
        "direction": "high",
        "cost_bps": 20,
        "train_days": 30,
        "test_days": 3,
        "step_days": 1,
        "description": "15m ret_16bars + volume_z > 0 filter, top 25%, 4h rebalance",
    },
}


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def data_root_for_tf(tf: str) -> str:
    """Return the data root directory for a given time frame."""
    if tf == "15m":
        return DATA_ROOT_15M
    elif tf == "30m":
        return DATA_ROOT_30M
    else:
        raise ValueError(f"Unknown tf: {tf}")


def load_klines(
    symbol: str,
    tf: str,
    start_ms: int,
    end_ms: int,
) -> list[tuple[int, float, float]]:
    """Load (timestamp_ms, close, volume) rows from monthly ZIP klines.

    Binance CSV columns: open_time(ms), open, high, low, close, volume, ...
    Returns chronologically sorted list covering [start_ms, end_ms].
    Missing ZIPs are silently skipped.
    """
    root = data_root_for_tf(tf)
    kline_dir = os.path.join(root, symbol, tf)
    if not os.path.isdir(kline_dir):
        return []

    rows: list[tuple[int, float, float]] = []

    # Load all monthly ZIPs within the date range
    start_dt = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)

    for year in range(start_dt.year, end_dt.year + 1):
        for month in range(1, 13):
            # Determine the month bounds to skip irrelevant ZIPs
            month_start = datetime(year, month, 1, tzinfo=timezone.utc)
            if month == 12:
                month_end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
            else:
                month_end = datetime(year, month + 1, 1, tzinfo=timezone.utc)

            if month_end.timestamp() * 1000 < start_ms:
                continue
            if month_start.timestamp() * 1000 > end_ms:
                break

            zip_name = f"{symbol}-{tf}-{year}-{month:02d}.zip"
            zip_path = os.path.join(kline_dir, zip_name)
            if not os.path.exists(zip_path):
                continue

            try:
                with zipfile.ZipFile(zip_path, "r") as zf:
                    csv_name = zip_name.replace(".zip", ".csv")
                    if csv_name not in zf.namelist():
                        continue
                    raw = zf.read(csv_name).decode("utf-8")
            except (zipfile.BadZipFile, UnicodeDecodeError):
                continue

            for line in raw.strip().split("\n"):
                parts = line.split(",")
                if len(parts) < 6:
                    continue
                ts = int(parts[0])
                if start_ms <= ts <= end_ms:
                    rows.append((ts, float(parts[4]), float(parts[5])))

    rows.sort(key=lambda r: r[0])
    return rows


def build_data_matrices(
    symbols: list[str],
    tf: str,
    start_ms: int,
    end_ms: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build aligned price & volume matrices for all symbols at given tf.

    Returns:
        timestamps: 1D array of unique bar timestamps (n_bars,)
        price_mtx:  (n_sym, n_bars) float64 close prices, NaN for missing bars
        volume_mtx: (n_sym, n_bars) float64 volumes, NaN for missing bars
    """
    print(f"  Loading {tf} data for {len(symbols)} symbols ...")
    raw_data: dict[str, list[tuple[int, float, float]]] = {}
    for sym in symbols:
        raw_data[sym] = load_klines(sym, tf, start_ms, end_ms)
        if not raw_data[sym]:
            print(f"    WARN: {sym} has no {tf} data in range")

    loaded = {s for s, d in raw_data.items() if d}
    print(f"    {len(loaded)}/{len(symbols)} symbols have data")

    # Build sorted unique timestamp index
    all_timestamps = sorted({ts for data in raw_data.values() for ts, _, _ in data})
    ts_idx = {ts: i for i, ts in enumerate(all_timestamps)}
    timestamps = np.array(all_timestamps, dtype=np.int64)
    n_bars = len(all_timestamps)

    n_sym = len(symbols)
    price_mtx = np.full((n_sym, n_bars), np.nan, dtype=np.float64)
    volume_mtx = np.full((n_sym, n_bars), np.nan, dtype=np.float64)

    for si, sym in enumerate(symbols):
        for ts, close, vol in raw_data.get(sym, []):
            idx = ts_idx.get(ts)
            if idx is not None:
                price_mtx[si, idx] = close
                volume_mtx[si, idx] = vol

    return timestamps, price_mtx, volume_mtx


# ---------------------------------------------------------------------------
# WFO window iterator
# ---------------------------------------------------------------------------

def _date_to_ms(dt: datetime) -> int:
    return int(dt.timestamp() * 1000)


def wfo_windows(
    start_dt: datetime,
    end_dt: datetime,
    train_days: int,
    test_days: int,
    step_days: int,
):
    """Yield (train_start_ms, train_end_ms, test_start_ms, test_end_ms)."""
    current = start_dt
    while current + timedelta(days=train_days + test_days) <= end_dt:
        train_start = current
        train_end = current + timedelta(days=train_days)
        test_start = train_end
        test_end = test_start + timedelta(days=test_days)
        yield (
            _date_to_ms(train_start),
            _date_to_ms(train_end),
            _date_to_ms(test_start),
            _date_to_ms(test_end),
        )
        current += timedelta(days=step_days)


# ---------------------------------------------------------------------------
# Signal computation
# ---------------------------------------------------------------------------

def compute_realized_vol(
    returns: np.ndarray,  # (n_sym, n_bars) returns matrix
) -> np.ndarray:  # (n_sym,) vol per symbol
    """Compute sample std of returns over the window (NaN-aware)."""
    with np.errstate(invalid="ignore"):
        vol = np.nanstd(returns, axis=1, ddof=1)
    return vol


def compute_cumulative_return(
    price_window: np.ndarray,  # (n_sym, lookback+1) price slice
) -> np.ndarray:  # (n_sym,) cumulative return
    """Compute (last / first - 1) for each symbol, NaN-aware."""
    first = price_window[:, 0]
    last = price_window[:, -1]
    with np.errstate(divide="ignore", invalid="ignore"):
        ret = last / first - 1.0
    return ret


def compute_volume_zscore(
    volume_window: np.ndarray,  # (n_sym, lookback) volume slice
) -> np.ndarray:  # (n_sym,) z-score of latest volume vs its history
    """Compute z-score of the most recent bar's volume vs its own history."""
    n_sym = volume_window.shape[0]
    z = np.full(n_sym, np.nan, dtype=np.float64)

    for si in range(n_sym):
        series = volume_window[si, :]
        valid = series[~np.isnan(series)]
        if len(valid) < 4:
            z[si] = 0.0
            continue
        latest = valid[-1]
        hist = valid[:-1]
        if len(hist) < 3:
            z[si] = 0.0
            continue
        mu = np.nanmean(hist)
        std = np.nanstd(hist, ddof=1)
        if std > 1e-12 and np.isfinite(std):
            z[si] = (latest - mu) / std
        else:
            z[si] = 0.0
    return z


# ---------------------------------------------------------------------------
# Fold execution — 15m strategies (A & C)
# ---------------------------------------------------------------------------

def run_fold_15m(
    price_mtx: np.ndarray,
    volume_mtx: np.ndarray,
    timestamps: np.ndarray,
    test_start_ms: int,
    test_end_ms: int,
    config: dict,
    strategy_name: str,
) -> list[float] | None:
    """Run one WFO fold for a 15m strategy (low_vol_15m or momentum_vol_15m).

    Returns list of holding-period net returns, or None if insufficient data.
    """
    lookback_bars = config["lookback_bars"]
    rebal_bars = config["rebal_bars"]
    pct = config["pct"]
    direction = config["direction"]
    cost_bps = config["cost_bps"]
    cost_factor = cost_bps / 10_000

    # Find bar indices within the test window
    test_mask = (timestamps >= test_start_ms) & (timestamps < test_end_ms)
    test_indices = np.where(test_mask)[0]
    if len(test_indices) < rebal_bars + 1:
        return None

    first_idx = int(test_indices[0])
    last_idx = int(test_indices[-1])

    # Pre-compute one-period returns for vol computation
    with np.errstate(divide="ignore", invalid="ignore"):
        returns_1b = np.diff(price_mtx) / price_mtx[:, :-1]
    # returns_1b[:, j] = return from bar j to bar j+1

    fold_returns: list[float] = []

    # Rebalance every rebal_bars bars starting from the first test bar
    for r_idx in range(first_idx, last_idx - rebal_bars + 1, rebal_bars):
        if r_idx < lookback_bars:
            continue

        # --- Compute signal ---

        if strategy_name == "low_vol_15m":
            # Strategy A: realized_vol over last lookback_bars
            lb_start = r_idx - lookback_bars
            lookback_returns = returns_1b[:, lb_start : r_idx - 1]
            # lookback_returns shape: (n_sym, lookback_bars - 1) = (n_sym, 15) for 16-bar lookback
            # This gives us the one-period returns for the lookback window

            # Actually, let's recompute: if lookback is 16 bars, we want vol over 16 returns
            # returns_1b[:, j] = price[j+1]/price[j]-1
            # So returns from bar r_idx-16 to r_idx-1 are returns_1b[:, r_idx-16 : r_idx-1]
            # That's 15 returns from 16 bars. For a 16-bar lookback window, we want exactly
            # the last 16-1=15 one-period returns, or the last 16 price changes...

            # Let me use price ratios instead for a cleaner 16-bar vol estimate
            price_lookback = price_mtx[:, r_idx - lookback_bars : r_idx]
            # shape (n_sym, lookback_bars) = (n_sym, 16)

            # Compute 1-bar returns from the price lookback window
            pb_rets = np.diff(price_lookback) / price_lookback[:, :-1]
            # shape (n_sym, lookback_bars - 1) = (n_sym, 15)

            vol = compute_realized_vol(pb_rets)
            scores = vol

        elif strategy_name == "momentum_vol_15m":
            # Strategy C: ret_16bars + volume_z > 0 filter
            price_lookback = price_mtx[:, r_idx - lookback_bars : r_idx]
            # Cumulative return over the lookback window
            scores_raw = compute_cumulative_return(price_lookback)

            # Volume z-score: compare latest bar volume vs previous lookback-1 bars
            vol_lookback = volume_mtx[:, r_idx - lookback_bars : r_idx]
            # shape (n_sym, lookback_bars)
            vol_z = compute_volume_zscore(vol_lookback)

            # Volume filter: set score to NaN where volume_z <= 0
            scores = np.where(vol_z > 0, scores_raw, np.nan)
        else:
            continue

        # --- Select symbols ---

        # Forward holding-period return: buy at r_idx, sell at r_idx + rebal_bars
        price_now = price_mtx[:, r_idx]
        price_future = price_mtx[:, r_idx + rebal_bars]
        with np.errstate(divide="ignore", invalid="ignore"):
            fwd_ret = price_future / price_now - 1.0

        # Must have valid score, valid fwd return, non-NaN price
        valid_mask = (
            ~np.isnan(scores)
            & ~np.isnan(fwd_ret)
            & np.isfinite(price_now)
            & (price_now > 0)
            & np.isfinite(price_future)
            & (price_future > 0)
        )
        valid_indices = np.where(valid_mask)[0]

        if len(valid_indices) < 4:
            continue

        valid_scores = scores[valid_indices]
        valid_fwd = fwd_ret[valid_indices]

        # Rank: low = ascending (buy low scores), high = descending (buy high scores)
        ascending = direction == "low"
        rank_order = np.argsort(valid_scores)
        if not ascending:
            rank_order = rank_order[::-1]

        n_select = max(1, int(np.ceil(len(valid_indices) * pct)))
        selected_fwd = valid_fwd[rank_order[:n_select]]

        gross_ret = float(np.nanmean(selected_fwd))
        net_ret = gross_ret - cost_factor  # one leg (long-only)
        fold_returns.append(net_ret)

    return fold_returns if fold_returns else None


# ---------------------------------------------------------------------------
# Fold execution — 30m strategy (B)
# ---------------------------------------------------------------------------

def run_fold_30m(
    price_mtx: np.ndarray,
    timestamps: np.ndarray,
    test_start_ms: int,
    test_end_ms: int,
    config: dict,
) -> list[float] | None:
    """Run one WFO fold for the 30m reversal strategy (B).

    Returns list of holding-period net returns, or None if insufficient data.
    """
    lookback_bars = config["lookback_bars"]
    rebal_bars = config["rebal_bars"]
    pct = config["pct"]
    direction = config["direction"]
    cost_bps = config["cost_bps"]
    cost_factor = cost_bps / 10_000

    test_mask = (timestamps >= test_start_ms) & (timestamps < test_end_ms)
    test_indices = np.where(test_mask)[0]
    if len(test_indices) < rebal_bars + 1:
        return None

    first_idx = int(test_indices[0])
    last_idx = int(test_indices[-1])

    fold_returns: list[float] = []

    for r_idx in range(first_idx, last_idx - rebal_bars + 1, rebal_bars):
        if r_idx < lookback_bars + 1:
            continue

        # Strategy B: ret_48bars (24h) — reversal signal
        # Cumulative return over last lookback_bars: price[r_idx-1] / price[r_idx-1-lookback] - 1
        price_ago = price_mtx[:, r_idx - lookback_bars - 1]
        price_latest = price_mtx[:, r_idx - 1]

        with np.errstate(divide="ignore", invalid="ignore"):
            ret_48bars = price_latest / price_ago - 1.0

        scores = ret_48bars

        # Forward holding-period return
        price_now = price_mtx[:, r_idx]
        price_future = price_mtx[:, r_idx + rebal_bars]
        with np.errstate(divide="ignore", invalid="ignore"):
            fwd_ret = price_future / price_now - 1.0

        valid_mask = (
            ~np.isnan(scores)
            & ~np.isnan(fwd_ret)
            & np.isfinite(price_now)
            & (price_now > 0)
            & np.isfinite(price_future)
            & (price_future > 0)
        )
        valid_indices = np.where(valid_mask)[0]

        if len(valid_indices) < 4:
            continue

        valid_scores = scores[valid_indices]
        valid_fwd = fwd_ret[valid_indices]

        ascending = direction == "low"
        rank_order = np.argsort(valid_scores)
        if not ascending:
            rank_order = rank_order[::-1]

        n_select = max(1, int(np.ceil(len(valid_indices) * pct)))
        selected_fwd = valid_fwd[rank_order[:n_select]]

        gross_ret = float(np.nanmean(selected_fwd))
        net_ret = gross_ret - cost_factor
        fold_returns.append(net_ret)

    return fold_returns if fold_returns else None


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def compute_metrics(
    all_fold_returns: list[list[float]],
) -> dict:
    """Compute aggregate performance metrics across all folds for a strategy.

    Each element of all_fold_returns is the list of holding-period net returns
    for one WFO fold.
    """
    if not all_fold_returns:
        return {
            "fold_count": 0,
            "total_trades": 0,
            "mean_return": 0.0,
            "std_return": 0.0,
            "sharpe": 0.0,
            "win_rate": 0.0,
            "max_drawdown": 0.0,
            "avg_trades_per_fold": 0.0,
        }

    fold_mean_returns = [float(np.mean(r)) for r in all_fold_returns if r]

    # Pool all holding-period returns
    all_returns_flat = []
    for r in all_fold_returns:
        all_returns_flat.extend(r)
    all_arr = np.array(all_returns_flat)

    if len(all_arr) == 0:
        return {
            "fold_count": len(all_fold_returns),
            "total_trades": 0,
            "mean_return": 0.0,
            "std_return": 0.0,
            "sharpe": 0.0,
            "win_rate": 0.0,
            "max_drawdown": 0.0,
            "avg_trades_per_fold": 0.0,
        }

    abs_mean = float(np.mean(all_arr))
    abs_std = float(np.std(all_arr, ddof=1)) if len(all_arr) > 1 else 0.0

    # Annualized Sharpe: rebal_bars per holding period, bars_per_year depends on tf
    # We'll compute it later based on the strategy config
    win_rate = float(np.mean(all_arr > 0))

    # Max drawdown from cumulative returns
    cum = np.cumprod(1.0 + all_arr)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    # Fraction of folds with positive mean return
    fold_pass_rate = float(np.mean([m > 0 for m in fold_mean_returns])) if fold_mean_returns else 0.0

    mean_fold_return = float(np.mean(fold_mean_returns)) if fold_mean_returns else 0.0
    std_fold_return = float(np.std(fold_mean_returns, ddof=1)) if len(fold_mean_returns) > 1 else 0.0

    return {
        "fold_count": len(all_fold_returns),
        "total_trades": len(all_arr),
        "avg_trades_per_fold": len(all_arr) / max(1, len(all_fold_returns)),
        "fold_mean_return": round(mean_fold_return, 8),
        "fold_std_return": round(std_fold_return, 8),
        "fold_pass_rate": round(fold_pass_rate, 6),
        "pooled_mean_return": round(abs_mean, 8),
        "pooled_std_return": round(abs_std, 8),
        "win_rate": round(win_rate, 6),
        "max_drawdown": round(max_dd, 6),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("Strategy Test: 15m / 30m Intraday Strategies (WFO)")
    print("=" * 60)
    print()

    start_dt = datetime.strptime(START_DATE, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end_dt = datetime.strptime(END_DATE, "%Y-%m-%d").replace(tzinfo=timezone.utc)

    # Need some data before the test period for lookback. Load from early 2024.
    data_start_dt = start_dt  # Jan 1 2024
    data_end_dt = end_dt + timedelta(days=1)  # include Dec 31 final bars

    start_ms = _date_to_ms(data_start_dt)
    end_ms = _date_to_ms(data_end_dt)

    # ---- Load data for both timeframes ------------------------------------
    print("--- Loading Data ---")
    print()

    timestamps_15m, price_15m, volume_15m = build_data_matrices(
        SYMBOLS, "15m", start_ms, end_ms
    )
    print(f"  15m bars: {len(timestamps_15m)}")
    print()

    timestamps_30m, price_30m, _ = build_data_matrices(
        SYMBOLS, "30m", start_ms, end_ms
    )
    print(f"  30m bars: {len(timestamps_30m)}")
    print()

    # ---- Organize data by timeframe ---------------------------------------
    tf_data = {
        "15m": {
            "timestamps": timestamps_15m,
            "price": price_15m,
            "volume": volume_15m,
        },
        "30m": {
            "timestamps": timestamps_30m,
            "price": price_30m,
            "volume": None,  # not needed for 30m strategy
        },
    }

    # ---- Run WFO for each strategy ----------------------------------------
    print("--- Walk-Forward Optimization ---")
    print()

    results: dict[str, dict] = {}

    for name, config in STRATEGIES.items():
        tf = config["tf"]
        train_days = config["train_days"]
        test_days = config["test_days"]
        step_days = config["step_days"]

        data = tf_data[tf]
        timestamps = data["timestamps"]
        price_mtx = data["price"]
        volume_mtx = data["volume"]

        print(f"  Strategy: {name}")
        print(f"    {config['description']}")
        print(f"    WFO: train={train_days}d, test={test_days}d, step={step_days}d")
        print()

        # Last possible test start: need full test window + train window before
        # the data end. But for a pure test-only approach, we just need the
        # test window to fit in the data range.
        # Start date for WFO: allow enough days for the first fold's test window
        # to have lookback data (use the beginning of the data range).

        fold_results: list[list[float]] = []
        fold_info: list[dict] = []

        for (
            train_start_ms,
            train_end_ms,
            test_start_ms,
            test_end_ms,
        ) in wfo_windows(start_dt, end_dt, train_days, test_days, step_days):

            if tf == "15m":
                fold_rets = run_fold_15m(
                    price_mtx,
                    volume_mtx,
                    timestamps,
                    test_start_ms,
                    test_end_ms,
                    config,
                    name,
                )
            else:  # 30m
                fold_rets = run_fold_30m(
                    price_mtx,
                    timestamps,
                    test_start_ms,
                    test_end_ms,
                    config,
                )

            if fold_rets is not None and len(fold_rets) > 0:
                fold_results.append(fold_rets)
                fold_info.append({
                    "train_start": datetime.fromtimestamp(
                        train_start_ms / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d"),
                    "train_end": datetime.fromtimestamp(
                        train_end_ms / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d"),
                    "test_start": datetime.fromtimestamp(
                        test_start_ms / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d"),
                    "test_end": datetime.fromtimestamp(
                        test_end_ms / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d"),
                    "n_trades": len(fold_rets),
                    "mean_return": round(float(np.mean(fold_rets)), 8),
                    "std_return": round(
                        float(np.std(fold_rets, ddof=1)), 8
                    ) if len(fold_rets) > 1 else 0.0,
                    "win_rate": round(float(np.mean([r > 0 for r in fold_rets])), 6),
                })

        # Compute annualized Sharpe based on the holding period
        rebal_bars = config["rebal_bars"]
        if tf == "15m":
            bars_per_year = 365.25 * 24 * 4  # 15m = 4 bars/hour
        else:
            bars_per_year = 365.25 * 24 * 2  # 30m = 2 bars/hour

        ann_factor = bars_per_year / rebal_bars

        metrics = compute_metrics(fold_results)

        # Annualized Sharpe from pooled returns
        pooled_mean = metrics["pooled_mean_return"]
        pooled_std = metrics["pooled_std_return"]
        if pooled_std > 1e-12:
            annualized_sharpe = pooled_mean / pooled_std * np.sqrt(ann_factor)
        else:
            annualized_sharpe = 0.0

        annualized_return = pooled_mean * ann_factor

        results[name] = {
            "description": config["description"],
            "timeframe": tf,
            "rebal_bars": rebal_bars,
            "lookback_bars": config["lookback_bars"],
            "cost_bps": config["cost_bps"],
            "wfo_config": {
                "train_days": train_days,
                "test_days": test_days,
                "step_days": step_days,
            },
            "metrics": {
                **metrics,
                "annualized_return": round(annualized_return, 8),
                "annualized_sharpe": round(float(annualized_sharpe), 4),
            },
            "folds": fold_info,
        }

        m = results[name]["metrics"]
        print(f"    Folds: {m['fold_count']}")
        print(f"    Total trades: {m['total_trades']}")
        print(f"    Pooled mean HP return: {m['pooled_mean_return']:.6f}")
        print(f"    Annualized return: {m['annualized_return']:.6f}")
        print(f"    Annualized Sharpe: {m['annualized_sharpe']:.4f}")
        print(f"    Win rate (per trade): {m['win_rate']:.4f}")
        print(f"    Max drawdown: {m['max_drawdown']:.6f}")
        print(f"    Fold pass rate (>0): {m['fold_pass_rate']:.4f}")
        print()

    # ---- Build report -----------------------------------------------------
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "strategy": "strategy_15m_30m",
        "config": {
            "n_symbols": len(SYMBOLS),
            "symbols": SYMBOLS,
            "period": f"{START_DATE} to {END_DATE}",
        },
        "strategies": {},
    }

    for name, res in results.items():
        report["strategies"][name] = {
            "description": res["description"],
            "timeframe": res["timeframe"],
            "rebal_bars": res["rebal_bars"],
            "lookback_bars": res["lookback_bars"],
            "cost_bps": res["cost_bps"],
            "wfo_config": res["wfo_config"],
            "metrics": res["metrics"],
            "fold_count": res["metrics"]["fold_count"],
            "folds": res["folds"],
        }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"  Report: {OUTPUT_PATH}")
    print()

    # ---- Summary ----------------------------------------------------------
    print("=" * 60)
    print("Summary")
    print("=" * 60)
    for name in STRATEGIES:
        m = results.get(name, {}).get("metrics", {})
        print(f"  {name}:")
        print(f"    Annualized return : {m.get('annualized_return', 0):.4f}")
        print(f"    Annualized Sharpe : {m.get('annualized_sharpe', 0):.2f}")
        print(f"    Win rate          : {m.get('win_rate', 0):.2%}")
        print(f"    Max DD            : {m.get('max_drawdown', 0):.4f}")
        print(f"    Fold pass rate    : {m.get('fold_pass_rate', 0):.2%}")
        print(f"    Folds             : {m.get('fold_count', 0)}")


if __name__ == "__main__":
    main()
