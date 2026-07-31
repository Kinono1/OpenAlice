#!/usr/bin/env python3
"""
Volatility prediction strategies for 24 mainstream coins.

Four strategies with WFO (train=365d, test=63d):

  A: Vol prediction -> position sizing overlay on adaptive_vol_15pct
     - Predict next 21d vol from last 60d returns (GARCH-like persistence)
     - If predicted vol > 90th pct cross-sectionally -> 50% position
     - If predicted vol < 10th pct -> full position

  B: Multi-timeframe momentum
     - Momentum at 10d, 30d, 90d, each z-scored cross-sectionally
     - Composite = 0.33*z(10d) + 0.33*z(30d) + 0.33*z(90d)
     - Buy top 25% by composite, rebalance every 30 days

  C: Dual momentum (absolute + relative)
     - Absolute: only buy if 90d return > 0 (uptrend)
     - Relative: among uptrend coins, buy top 25% by 90d momentum
     - Avoids buying in bear markets

  D: Volatility risk premium overlay on adaptive_vol_15pct
     - 30d realized vol vs 30d range-based (Parkinson) implied vol proxy
     - When realized > implied -> vol expected to decline -> buy low-vol
     - When realized < implied -> vol expected to increase -> reduce positions

Data: Binance daily klines from OpenAlice warehouse.
Output: data/research/strategy_vol_prediction_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
KLINES_DIR = f"{BASE}/spot-all-usdt-klines-1d/spot"
OUTPUT_PATH = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
    "/data/research/strategy_vol_prediction_report.json"
)
COST_BPS = 15

# 24 mainstream coins — the universe used by all strategies
MAIN_SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
    "UNIUSDT", "LTCUSDT", "BCHUSDT", "ATOMUSDT",
    "NEARUSDT", "OPUSDT", "ARBUSDT", "SUIUSDT",
    "TRXUSDT", "APTUSDT", "INJUSDT", "ETCUSDT",
    "AAVEUSDT", "MKRUSDT",
]

# WFO parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 63  # non-overlapping test windows

# Base selection for low-vol strategies: bottom 15th percentile
LOW_VOL_QUANTILE = 0.15


# ---------------------------------------------------------------------------
# Data loading — adaptive timestamp
# ---------------------------------------------------------------------------

def parse_ts_ms(ts_str: str) -> int:
    """Parse binance millisecond timestamp string."""
    return int(ts_str)


def ts_to_date(ts_ms: int) -> str:
    """Convert millisecond timestamp to date string."""
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def load_symbol_ohlcv(
    symbol: str,
) -> dict[str, tuple[float, float, float, float, float]]:
    """Load all daily OHLCV data for a symbol.

    Returns dict keyed by date string 'YYYY-MM-DD' with value
    (open, high, low, close, volume). Returns empty dict on failure.
    """
    kline_path = os.path.join(KLINES_DIR, symbol, "1d")
    if not os.path.isdir(kline_path):
        return {}

    result: dict[str, tuple[float, float, float, float, float]] = {}
    zip_files = sorted(f for f in os.listdir(kline_path) if f.endswith(".zip"))

    for zname in zip_files:
        zpath = os.path.join(kline_path, zname)
        try:
            with zipfile.ZipFile(zpath) as zf:
                names = zf.namelist()
                if not names:
                    continue
                text = zf.read(names[0]).decode("utf-8", errors="replace")
        except (zipfile.BadZipFile, UnicodeDecodeError, OSError):
            continue

        for line in text.strip().split("\n"):
            cols = line.split(",")
            if len(cols) < 6:
                continue
            try:
                ts = parse_ts_ms(cols[0])
                o = float(cols[1])
                h = float(cols[2])
                lv = float(cols[3])
                c = float(cols[4])
                v = float(cols[5])
                date = ts_to_date(ts)
                if date not in result:
                    result[date] = (o, h, lv, c, v)
            except (ValueError, IndexError):
                continue

    return result


def discover_adaptive_range(
    symbols: list[str],
) -> tuple[list[str], list[str], np.ndarray, np.ndarray, np.ndarray, np.ndarray, np.ndarray, int]:
    """Load and align OHLCV data for all symbols, return matrices and metadata.

    This implements adaptive timestamp: the date range is determined by
    the intersection of available data across all 24 coins.

    Returns:
        all_dates:   sorted list of date strings covering the overlap
        symbols:     filtered symbol list
        close:       (n_sym, n_dates) close prices, NaN for missing
        high:        (n_sym, n_dates) high prices, NaN for missing
        low:         (n_sym, n_dates) low prices, NaN for missing
        volume:      (n_sym, n_dates) daily volumes, 0 for missing
        ret:         (n_sym, n_dates) daily simple returns, NaN for missing
        btc_idx:     int index of BTCUSDT in symbols
    """
    print("Loading data for 24 mainstream coins ...")
    raw: dict[str, dict[str, tuple[float, float, float, float, float]]] = {}
    for sym in symbols:
        data = load_symbol_ohlcv(sym)
        if data:
            raw[sym] = data
            print(f"  {sym}: {len(data)} days", flush=True)
        else:
            print(f"  WARN: {sym} has no data", flush=True)

    # Find common date range (adaptive timestamp): keep dates where ALL symbols have data
    date_sets = [set(d.keys()) for d in raw.values()]
    common_dates = sorted(set.intersection(*date_sets) if date_sets else set())

    if not common_dates:
        print("ERROR: no overlapping dates across all symbols", file=sys.stderr)
        sys.exit(1)

    print(f"  Common date range: {common_dates[0]} to {common_dates[-1]} "
          f"({len(common_dates)} trading days)")

    # Keep only symbols that have data
    available_symbols = [s for s in symbols if s in raw]
    n_sym = len(available_symbols)
    n_dates = len(common_dates)

    close = np.full((n_sym, n_dates), np.nan)
    high = np.full((n_sym, n_dates), np.nan)
    low = np.full((n_sym, n_dates), np.nan)
    volume = np.zeros((n_sym, n_dates))

    date_to_idx = {d: i for i, d in enumerate(common_dates)}
    for si, sym in enumerate(available_symbols):
        data = raw[sym]
        for date, (o, h, lv, c, v) in data.items():
            if date in date_to_idx:
                di = date_to_idx[date]
                close[si, di] = c
                high[si, di] = h
                low[si, di] = lv
                volume[si, di] = v

    # Daily returns
    ret = np.full((n_sym, n_dates), np.nan)
    ret[:, 0] = 0.0
    with np.errstate(invalid="ignore", divide="ignore"):
        ret[:, 1:] = close[:, 1:] / close[:, :-1] - 1.0

    # BTC index
    btc_idx = None
    for si, sym in enumerate(available_symbols):
        if sym == "BTCUSDT":
            btc_idx = si
            break

    print(f"  Matrices: {n_sym} symbols x {n_dates} days")
    return common_dates, available_symbols, close, high, low, volume, ret, btc_idx


# ---------------------------------------------------------------------------
# Precompute rolling stats (shared across strategies)
# ---------------------------------------------------------------------------

def rolling_std(mat: np.ndarray, window: int) -> np.ndarray:
    """Rolling sample standard deviation, NaN-aware.

    Returns (n_sym, n_dates) array. First <window> columns are NaN.
    Requires >= window//2 valid observations.
    """
    n_sym, n_dates = mat.shape
    result = np.full((n_sym, n_dates), np.nan)
    for si in range(n_sym):
        for di in range(window, n_dates):
            sl = mat[si, di - window + 1 : di + 1]
            valid = sl[np.isfinite(sl)]
            if len(valid) >= max(window // 2, 5):
                result[si, di] = float(np.std(valid, ddof=1))
    return result


def rolling_mean(mat: np.ndarray, window: int) -> np.ndarray:
    """Rolling mean, NaN-aware."""
    n_sym, n_dates = mat.shape
    result = np.full((n_sym, n_dates), np.nan)
    for si in range(n_sym):
        for di in range(window, n_dates):
            sl = mat[si, di - window + 1 : di + 1]
            valid = sl[np.isfinite(sl)]
            if len(valid) >= max(window // 2, 5):
                result[si, di] = float(np.mean(valid))
    return result


def rolling_parkinson_vol(
    high_mat: np.ndarray,
    low_mat: np.ndarray,
    window: int,
) -> np.ndarray:
    """Rolling Parkinson (1980) range-based volatility estimator.

    Parkinson vol per day: sigma_i = sqrt( (ln(high_i/low_i))^2 / (4*ln(2)) )
    30d Parkinson vol = sqrt( mean(sigma_i^2) ) for the window
    """
    n_sym, n_dates = high_mat.shape
    result = np.full((n_sym, n_dates), np.nan)
    # Precompute daily Range^2 / (4*ln(2))
    with np.errstate(invalid="ignore", divide="ignore"):
        park_daily = (np.log(high_mat / low_mat) ** 2) / (4.0 * np.log(2.0))

    for si in range(n_sym):
        for di in range(window, n_dates):
            sl = park_daily[si, di - window + 1 : di + 1]
            valid_values = sl[np.isfinite(sl) & (sl > 0)]
            if len(valid_values) >= max(window // 2, 5):
                park_vol = float(np.sqrt(np.mean(valid_values)))
                result[si, di] = park_vol
    return result


def rolling_return(
    close_mat: np.ndarray,
    lag: int,
) -> np.ndarray:
    """Rolling return over *lag* days (close / close_{t-lag} - 1)."""
    n_sym, n_dates = close_mat.shape
    result = np.full((n_sym, n_dates), np.nan)
    with np.errstate(invalid="ignore", divide="ignore"):
        for di in range(lag, n_dates):
            result[:, di] = close_mat[:, di] / close_mat[:, di - lag] - 1.0
    return result


# ---------------------------------------------------------------------------
# Cross-sectional helpers
# ---------------------------------------------------------------------------

def zscore_cross_sectional(arr: np.ndarray) -> np.ndarray:
    """Compute z-score across the symbol dimension (axis=0), NaN-safe."""
    mean = np.nanmean(arr)
    std = np.nanstd(arr, ddof=1)
    if std > 0 and np.isfinite(std):
        return (arr - mean) / std
    return np.zeros_like(arr)


def percentile_rank(arr: np.ndarray) -> np.ndarray:
    """Percentile rank (0 to 1) of each element in arr (cross-sectional)."""
    n = np.sum(np.isfinite(arr))
    if n < 2:
        return np.full_like(arr, 0.5, dtype=float)
    order = np.argsort(arr)
    ranks = np.empty_like(arr)
    ranks[order] = np.arange(len(arr), dtype=float) / (len(arr) - 1)
    return ranks


def top_n_mask(arr: np.ndarray, top_fraction: float) -> np.ndarray:
    """Return boolean mask for top *top_fraction* elements by value."""
    valid = np.isfinite(arr)
    if np.sum(valid) < 2:
        return np.zeros(len(arr), dtype=bool)
    threshold = np.nanpercentile(arr, (1.0 - top_fraction) * 100)
    return valid & (arr >= threshold)


def bottom_n_mask(arr: np.ndarray, bottom_fraction: float) -> np.ndarray:
    """Return boolean mask for bottom *bottom_fraction* elements by value."""
    valid = np.isfinite(arr)
    if np.sum(valid) < 2:
        return np.zeros(len(arr), dtype=bool)
    threshold = np.nanpercentile(arr, bottom_fraction * 100)
    return valid & (arr <= threshold)


# ---------------------------------------------------------------------------
# Performance helpers
# ---------------------------------------------------------------------------

def metrics_from_returns(
    rets: list[float],
    btc_rets: list[float],
    ann_factor: float,
) -> dict:
    """Compute standard performance metrics from a sequence of returns."""
    if len(rets) < 2:
        return {"error": "Insufficient return observations", "n": len(rets)}

    pool = np.array(rets)
    btc_pool = np.array(btc_rets)

    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    if std_ret > 0 and std_ret < 10:  # guard against degenerate
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
        ann_ret = float(mean_ret * ann_factor)
    else:
        sharpe = 0.0
        ann_ret = 0.0

    # Max drawdown
    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.nanmin(dd)) if np.sum(np.isfinite(dd)) > 0 else 0.0

    # Outperform BTC
    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) and len(pool) > 0
        else 0.0
    )

    btc_mean = float(np.mean(btc_pool)) if len(btc_pool) > 0 else 0.0
    btc_ann = btc_mean * ann_factor

    return {
        "n": len(pool),
        "win_rate": round(win_rate, 4),
        "mean_return": round(mean_ret, 6),
        "std_return": round(std_ret, 6),
        "sharpe": round(sharpe, 4),
        "annualized_return": round(ann_ret, 6),
        "max_drawdown": round(max_dd, 6),
        "outperform_btc": round(outperform, 4),
        "btc_annualized_return": round(btc_ann, 6),
        "all_returns": [round(float(r), 6) for r in pool],
        "all_btc_returns": [round(float(r), 6) for r in btc_pool],
    }


# ===================================================================
# STRATEGY A: Vol prediction -> position sizing overlay
# ===================================================================

def run_strategy_a_fold(
    close: np.ndarray,
    volume: np.ndarray,
    ret: np.ndarray,
    vol_60d: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    test_start_di: int,
    test_end_di: int,
    rebal_interval: int = 21,
) -> dict | None:
    """Run Strategy A on one test window.

    GARCH-like: predicted 21d vol = 60d daily vol * sqrt(21).
    Overlay on adaptive_vol_15pct:
      - Base: select bottom 15% by 60d vol
      - If predicted vol > 90th pct -> 50% weight
      - If predicted vol < 10th pct -> full weight
      - Others: normal
    """
    n_sym = len(sym_indices)
    rebal_dates = list(range(test_start_di, test_end_di, rebal_interval))

    fold_rets: list[float] = []
    fold_btc: list[float] = []

    for ri in range(len(rebal_dates) - 1):
        rebal_di = rebal_dates[ri]
        hold_end_di = rebal_dates[ri + 1]

        if hold_end_di >= close.shape[1]:
            continue

        # ---- Base: 60d vol selection (adaptive_vol_15pct) ----
        vols = vol_60d[sym_indices, rebal_di]
        vols_valid = np.isfinite(vols) & (vols > 0)
        n_valid = int(np.sum(vols_valid))
        if n_valid < 4:
            continue

        # Bottom 15% by vol
        vol_threshold = float(np.nanpercentile(vols, LOW_VOL_QUANTILE * 100))
        base_mask = vols_valid & (vols <= vol_threshold)
        base_selected = np.where(base_mask)[0]
        if len(base_selected) < 1:
            continue

        # ---- Overlay: predicted 21d vol ----
        # Predicted 21d vol = 60d vol * sqrt(21) (GARCH-like persistence)
        predicted_21d_vol = vols[base_selected] * np.sqrt(21.0)

        # Cross-sectional percentile of predicted vol
        pred_pct = np.array([
            np.mean(vols <= predicted_21d_vol[i])
            for i in range(len(predicted_21d_vol))
        ])

        # Weight adjustment
        weights = np.ones(len(base_selected))
        for i in range(len(base_selected)):
            if pred_pct[i] > 0.90:
                weights[i] = 0.5
            elif pred_pct[i] < 0.10:
                weights[i] = 1.0
            # else: 1.0 (default)

        # ---- Volume-weighted sqrt weights (similar to V6a) ----
        vol_at_rebal = volume[base_selected, rebal_di]
        vol_valid = np.isfinite(vol_at_rebal) & (vol_at_rebal > 0)
        n_vol_valid = int(np.sum(vol_valid))

        if n_vol_valid >= 1:
            sqrt_vols = np.sqrt(vol_at_rebal[vol_valid])
            base_w = np.zeros(len(base_selected))
            base_w[vol_valid] = sqrt_vols / float(np.sum(sqrt_vols))
        else:
            base_w = np.ones(len(base_selected)) / len(base_selected)

        # Apply overlay weight adjustment, then normalize
        adj_weights = base_w * weights
        w_sum = float(np.sum(adj_weights))
        if w_sum > 0:
            adj_weights = adj_weights / w_sum
        else:
            adj_weights = np.ones(len(base_selected)) / len(base_selected)

        # ---- Forward return ----
        start_prices = close[base_selected, rebal_di]
        end_prices = close[base_selected, hold_end_di]
        price_ok = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_price_ok = int(np.sum(price_ok))
        if n_price_ok < 1:
            continue

        fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
        gross = float(np.sum(adj_weights[price_ok] * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        fold_rets.append(net)

        # BTC benchmark
        btc_s = close[btc_idx, rebal_di]
        btc_e = close[btc_idx, hold_end_di]
        if np.isfinite(btc_s) and np.isfinite(btc_e) and btc_s > 0:
            fold_btc.append(float(btc_e / btc_s - 1))
        else:
            fold_btc.append(0.0)

    if len(fold_rets) < 2:
        return None

    m = metrics_from_returns(fold_rets, fold_btc, 365.25 / rebal_interval)

    return {
        "rebalance_interval_days": rebal_interval,
        "n_trades": len(fold_rets),
        **m,
    }


# ===================================================================
# STRATEGY B: Multi-timeframe momentum
# ===================================================================

def run_strategy_b_fold(
    close: np.ndarray,
    ret_10d: np.ndarray,
    ret_30d: np.ndarray,
    ret_90d: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    test_start_di: int,
    test_end_di: int,
    rebal_interval: int = 30,
) -> dict | None:
    """Run Strategy B on one test window.

    Composite = 0.33*zscore(10d) + 0.33*zscore(30d) + 0.33*zscore(90d)
    Buy top 25% by composite, equal-weight, rebalance 30d.
    """
    rebal_dates = list(range(test_start_di, test_end_di, rebal_interval))

    fold_rets: list[float] = []
    fold_btc: list[float] = []

    for ri in range(len(rebal_dates) - 1):
        rebal_di = rebal_dates[ri]
        hold_end_di = rebal_dates[ri + 1]

        if hold_end_di >= close.shape[1]:
            continue

        # Compute momentum at each timeframe
        mom_10d = ret_10d[sym_indices, rebal_di]
        mom_30d = ret_30d[sym_indices, rebal_di]
        mom_90d = ret_90d[sym_indices, rebal_di]

        # NaN filter: all momentum values must be finite
        valid = (
            np.isfinite(mom_10d)
            & np.isfinite(mom_30d)
            & np.isfinite(mom_90d)
        )
        n_valid = int(np.sum(valid))
        if n_valid < 4:
            continue

        valid_syms = np.where(valid)[0]

        # Z-score each timeframe
        z10 = zscore_cross_sectional(mom_10d[valid_syms])
        z30 = zscore_cross_sectional(mom_30d[valid_syms])
        z90 = zscore_cross_sectional(mom_90d[valid_syms])

        composite = 0.33 * z10 + 0.33 * z30 + 0.33 * z90

        # Buy top 25%
        top_pct = 0.25
        threshold = float(np.nanpercentile(composite, (1.0 - top_pct) * 100))
        selected = valid_syms[composite >= threshold]

        if len(selected) < 1:
            continue

        # Equal-weight
        weights = np.ones(len(selected)) / len(selected)

        # Forward return
        start_prices = close[selected, rebal_di]
        end_prices = close[selected, hold_end_di]
        price_ok = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_price_ok = int(np.sum(price_ok))
        if n_price_ok < 1:
            continue

        fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
        gross = float(np.sum(weights[price_ok] * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        fold_rets.append(net)

        # BTC
        btc_s = close[btc_idx, rebal_di]
        btc_e = close[btc_idx, hold_end_di]
        if np.isfinite(btc_s) and np.isfinite(btc_e) and btc_s > 0:
            fold_btc.append(float(btc_e / btc_s - 1))
        else:
            fold_btc.append(0.0)

    if len(fold_rets) < 2:
        return None

    m = metrics_from_returns(fold_rets, fold_btc, 365.25 / rebal_interval)

    return {
        "rebalance_interval_days": rebal_interval,
        "n_trades": len(fold_rets),
        **m,
    }


# ===================================================================
# STRATEGY C: Dual momentum (absolute + relative)
# ===================================================================

def run_strategy_c_fold(
    close: np.ndarray,
    ret_90d: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    test_start_di: int,
    test_end_di: int,
    rebal_interval: int = 30,
) -> dict | None:
    """Run Strategy C on one test window.

    Absolute: only buy if 90d return > 0 (uptrend).
    Relative: among uptrend coins, buy top 25% by 90d momentum.
    Equal-weight, rebalance 30d.
    """
    rebal_dates = list(range(test_start_di, test_end_di, rebal_interval))

    fold_rets: list[float] = []
    fold_btc: list[float] = []

    for ri in range(len(rebal_dates) - 1):
        rebal_di = rebal_dates[ri]
        hold_end_di = rebal_dates[ri + 1]

        if hold_end_di >= close.shape[1]:
            continue

        mom_90d = ret_90d[sym_indices, rebal_di]

        # ---- Absolute filter: 90d return > 0 ----
        absolute_ok = np.isfinite(mom_90d) & (mom_90d > 0)
        n_absolute = int(np.sum(absolute_ok))
        if n_absolute < 2:
            continue

        uptrend_syms = np.where(absolute_ok)[0]
        uptrend_mom = mom_90d[uptrend_syms]

        # ---- Relative: top 25% among uptrend ----
        threshold = float(np.nanpercentile(uptrend_mom, 75.0))  # top 25%
        selected = uptrend_syms[uptrend_mom >= threshold]

        if len(selected) < 1:
            continue

        weights = np.ones(len(selected)) / len(selected)

        # Forward return
        start_prices = close[selected, rebal_di]
        end_prices = close[selected, hold_end_di]
        price_ok = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_price_ok = int(np.sum(price_ok))
        if n_price_ok < 1:
            continue

        fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
        gross = float(np.sum(weights[price_ok] * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        fold_rets.append(net)

        # BTC benchmark
        btc_s = close[btc_idx, rebal_di]
        btc_e = close[btc_idx, hold_end_di]
        if np.isfinite(btc_s) and np.isfinite(btc_e) and btc_s > 0:
            fold_btc.append(float(btc_e / btc_s - 1))
        else:
            fold_btc.append(0.0)

    if len(fold_rets) < 2:
        return None

    m = metrics_from_returns(fold_rets, fold_btc, 365.25 / rebal_interval)

    return {
        "rebalance_interval_days": rebal_interval,
        "n_trades": len(fold_rets),
        **m,
    }


# ===================================================================
# STRATEGY D: Volatility risk premium overlay
# ===================================================================

def run_strategy_d_fold(
    close: np.ndarray,
    volume: np.ndarray,
    ret: np.ndarray,
    vol_30d: np.ndarray,
    vol_range_30d: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    test_start_di: int,
    test_end_di: int,
    rebal_interval: int = 21,
) -> dict | None:
    """Run Strategy D on one test window.

    30d realized vol vs 30d range-based (Parkinson) implied vol proxy.

    Overlay on adaptive_vol_15pct:
      - Base: select bottom 15% by 30d realized vol
      - ratio = realized / range_vol
      - If ratio > 1 (realized > implied) -> vol expected to decline -> overweight
      - If ratio < 1 (realized < implied) -> vol expected to increase -> underweight
    """
    n_sym = len(sym_indices)
    rebal_dates = list(range(test_start_di, test_end_di, rebal_interval))

    fold_rets: list[float] = []
    fold_btc: list[float] = []

    for ri in range(len(rebal_dates) - 1):
        rebal_di = rebal_dates[ri]
        hold_end_di = rebal_dates[ri + 1]

        if hold_end_di >= close.shape[1]:
            continue

        # ---- Base: 30d realized vol selection ----
        vols = vol_30d[sym_indices, rebal_di]
        vols_valid = np.isfinite(vols) & (vols > 0)
        n_valid = int(np.sum(vols_valid))
        if n_valid < 4:
            continue

        vol_threshold = float(np.nanpercentile(vols, LOW_VOL_QUANTILE * 100))
        base_mask = vols_valid & (vols <= vol_threshold)
        base_selected = np.where(base_mask)[0]
        if len(base_selected) < 1:
            continue

        # ---- Overlay: vol risk premium ratio ----
        realized = vols[base_selected]
        # vol_range_30d is indexed by [original_sym_index, di]
        range_vals = np.array([vol_range_30d[si, rebal_di] for si in base_selected])

        range_valid = np.isfinite(range_vals) & (range_vals > 0)
        n_range_valid = int(np.sum(range_valid))
        if n_range_valid < 1:
            continue

        ratios = np.zeros(len(base_selected))
        ratios[range_valid] = realized[range_valid] / range_vals[range_valid]

        # Weight adjustment:
        # ratio > 1 -> overweight (vol expected to decline, good for longs)
        # ratio < 1 -> underweight (vol expected to increase, reduce exposure)
        adj = np.ones(len(base_selected))
        for i in range(len(base_selected)):
            if range_valid[i]:
                r = ratios[i]
                if r > 1.2:
                    adj[i] = 1.5  # strong overweight
                elif r > 1.0:
                    adj[i] = 1.2  # mild overweight
                elif r < 0.8:
                    adj[i] = 0.5  # strong underweight
                elif r < 1.0:
                    adj[i] = 0.8  # mild underweight
                # else r == 1.0, adj[i] = 1.0

        # ---- Volume-weighted base weights ----
        vol_at_rebal = volume[base_selected, rebal_di]
        vol_ok = np.isfinite(vol_at_rebal) & (vol_at_rebal > 0)
        n_vol_ok = int(np.sum(vol_ok))

        if n_vol_ok >= 1:
            sqrt_vols = np.sqrt(vol_at_rebal[vol_ok])
            base_w = np.zeros(len(base_selected))
            base_w[vol_ok] = sqrt_vols / float(np.sum(sqrt_vols))
        else:
            base_w = np.ones(len(base_selected)) / len(base_selected)

        # Apply overlay weight and normalize
        final_w = base_w * adj
        w_sum = float(np.sum(final_w))
        if w_sum > 0:
            final_w = final_w / w_sum
        else:
            final_w = np.ones(len(base_selected)) / len(base_selected)

        # ---- Forward return ----
        start_prices = close[base_selected, rebal_di]
        end_prices = close[base_selected, hold_end_di]
        price_ok = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_price_ok = int(np.sum(price_ok))
        if n_price_ok < 1:
            continue

        fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
        gross = float(np.sum(final_w[price_ok] * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        fold_rets.append(net)

        # BTC
        btc_s = close[btc_idx, rebal_di]
        btc_e = close[btc_idx, hold_end_di]
        if np.isfinite(btc_s) and np.isfinite(btc_e) and btc_s > 0:
            fold_btc.append(float(btc_e / btc_s - 1))
        else:
            fold_btc.append(0.0)

    if len(fold_rets) < 2:
        return None

    m = metrics_from_returns(fold_rets, fold_btc, 365.25 / rebal_interval)

    return {
        "rebalance_interval_days": rebal_interval,
        "n_trades": len(fold_rets),
        **m,
    }


# ===================================================================
# WFO runner
# ===================================================================

def run_wfo(
    strategy_name: str,
    strategy_fn,
    strategy_kwargs: dict,
    all_dates: list[str],
    n_dates: int,
    train_days: int = TRAIN_DAYS,
    test_days: int = TEST_DAYS,
    step_days: int = STEP_DAYS,
) -> dict:
    """Run WFO for a given strategy function.

    Slides a (train + test) window across the timeline.
    On each fold the strategy is evaluated on the test window only.
    Training is implicit (lookback data used at each rebalance point).

    Returns dict with fold-by-fold results and pooled metrics.
    """
    folds: list[dict] = []
    all_rets: list[float] = []
    all_btc: list[float] = []

    i = 0
    while i + train_days + test_days <= n_dates:
        train_start_di = i
        train_end_di = i + train_days
        test_start_di = i + train_days
        test_end_di = i + train_days + test_days

        train_range = f"{all_dates[train_start_di]} ~ {all_dates[train_end_di - 1]}"
        test_range = f"{all_dates[test_start_di]} ~ {all_dates[test_end_di - 1]}"

        kw = dict(strategy_kwargs)
        kw["test_start_di"] = test_start_di
        kw["test_end_di"] = test_end_di

        result = strategy_fn(**kw)

        fold_entry = {
            "train_range": train_range,
            "test_range": test_range,
        }

        if result is not None:
            fold_entry["result"] = {
                "n_trades": result.get("n_trades", 0),
                "win_rate": result.get("win_rate", 0),
                "mean_return": result.get("mean_return", 0),
                "sharpe": result.get("sharpe", 0),
                "annualized_return": result.get("annualized_return", 0),
            }
            fold_rets = result.get("all_returns", [])
            fold_btc = result.get("all_btc_returns", [])
            all_rets.extend(fold_rets)
            all_btc.extend(fold_btc)
        else:
            fold_entry["result"] = None

        folds.append(fold_entry)
        i += step_days

    # Pooled metrics
    if len(all_rets) < 2:
        return {
            "strategy": strategy_name,
            "folds": folds,
            "error": "No valid trades across folds",
        }

    # Compute average holding period from strategy_kwargs or default
    rebal_interval = strategy_kwargs.get("rebal_interval", 21)
    ann_factor = 365.25 / rebal_interval

    pool = np.array(all_rets)
    btc_pool = np.array(all_btc)

    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    if std_ret > 0 and std_ret < 10:
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
        ann_ret = float(mean_ret * ann_factor)
    else:
        sharpe = 0.0
        ann_ret = 0.0

    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.nanmin(dd)) if np.sum(np.isfinite(dd)) > 0 else 0.0

    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) and len(pool) > 0
        else 0.0
    )

    btc_mean = float(np.mean(btc_pool)) if len(btc_pool) > 0 else 0.0
    btc_ann = btc_mean * ann_factor

    return {
        "strategy": strategy_name,
        "n_folds": len(folds),
        "n_total_trades": len(all_rets),
        "win_rate": round(win_rate, 4),
        "sharpe": round(sharpe, 4),
        "annualized_return": round(ann_ret, 6),
        "mean_return": round(mean_ret, 6),
        "std_return": round(std_ret, 6),
        "max_drawdown": round(max_dd, 6),
        "outperform_btc_rate": round(outperform, 4),
        "btc_annualized_return": round(btc_ann, 6),
        "folds": folds,
    }


# ===================================================================
# Compare adaptive_vol_15pct baseline (no overlay)
# ===================================================================

def run_baseline_fold(
    close: np.ndarray,
    volume: np.ndarray,
    ret: np.ndarray,
    vol_60d: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    test_start_di: int,
    test_end_di: int,
    rebal_interval: int = 21,
) -> dict | None:
    """Run adaptive_vol_15pct baseline (no overlay) on one test window."""
    rebal_dates = list(range(test_start_di, test_end_di, rebal_interval))

    fold_rets: list[float] = []
    fold_btc: list[float] = []

    for ri in range(len(rebal_dates) - 1):
        rebal_di = rebal_dates[ri]
        hold_end_di = rebal_dates[ri + 1]

        if hold_end_di >= close.shape[1]:
            continue

        vols = vol_60d[sym_indices, rebal_di]
        vols_valid = np.isfinite(vols) & (vols > 0)
        n_valid = int(np.sum(vols_valid))
        if n_valid < 4:
            continue

        vol_threshold = float(np.nanpercentile(vols, LOW_VOL_QUANTILE * 100))
        base_mask = vols_valid & (vols <= vol_threshold)
        base_selected = np.where(base_mask)[0]
        if len(base_selected) < 1:
            continue

        # Volume-weighted sqrt weights
        vol_at_rebal = volume[base_selected, rebal_di]
        vol_ok = np.isfinite(vol_at_rebal) & (vol_at_rebal > 0)
        n_vol_ok = int(np.sum(vol_ok))

        if n_vol_ok >= 1:
            sqrt_vols = np.sqrt(vol_at_rebal[vol_ok])
            weights = np.zeros(len(base_selected))
            weights[vol_ok] = sqrt_vols / float(np.sum(sqrt_vols))
        else:
            weights = np.ones(len(base_selected)) / len(base_selected)

        # Forward return
        start_prices = close[base_selected, rebal_di]
        end_prices = close[base_selected, hold_end_di]
        price_ok = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_price_ok = int(np.sum(price_ok))
        if n_price_ok < 1:
            continue

        fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
        gross = float(np.sum(weights[price_ok] * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        fold_rets.append(net)

        # BTC benchmark
        btc_s = close[btc_idx, rebal_di]
        btc_e = close[btc_idx, hold_end_di]
        if np.isfinite(btc_s) and np.isfinite(btc_e) and btc_s > 0:
            fold_btc.append(float(btc_e / btc_s - 1))
        else:
            fold_btc.append(0.0)

    if len(fold_rets) < 2:
        return None

    m = metrics_from_returns(fold_rets, fold_btc, 365.25 / rebal_interval)
    m["rebalance_interval_days"] = rebal_interval
    return m


# ===================================================================
# Report builder
# ===================================================================

def build_report(
    results: dict[str, dict],
    all_dates: list[str],
    symbols: list[str],
) -> dict:
    """Build final JSON report from all strategy results."""
    # Comparison table
    comparison = []
    for name, result in results.items():
        entry = {"strategy": name}
        if "error" in result:
            entry["error"] = result["error"]
        else:
            entry["sharpe"] = result.get("sharpe", 0)
            entry["win_rate"] = result.get("win_rate", 0)
            entry["annualized_return"] = result.get("annualized_return", 0)
            entry["max_drawdown"] = result.get("max_drawdown", 0)
            entry["outperform_btc_rate"] = result.get("outperform_btc_rate", 0)
            entry["n_total_trades"] = result.get("n_total_trades", 0)
            entry["n_folds"] = result.get("n_folds", 0)
            entry["btc_annualized_return"] = result.get("btc_annualized_return", 0)
        comparison.append(entry)
    comparison.sort(key=lambda x: -x.get("sharpe", 0))

    report = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "description": (
            "Volatility prediction strategies for 24 mainstream coins. "
            "Four strategies with WFO (train=365d, test=63d, step=63d)."
        ),
        "config": {
            "n_symbols": len(symbols),
            "n_dates": len(all_dates),
            "period": f"{all_dates[0]} to {all_dates[-1]}",
            "wfo": {
                "train_days": TRAIN_DAYS,
                "test_days": TEST_DAYS,
                "step_days": STEP_DAYS,
            },
            "cost_bps": COST_BPS,
            "low_vol_quantile": LOW_VOL_QUANTILE,
            "strategies": {
                "A_vol_prediction_overlay": "Vol prediction -> position sizing on adaptive_vol_15pct",
                "B_multitf_momentum": "Multi-timeframe momentum: composite of 10d/30d/90d z-scores",
                "C_dual_momentum": "Dual momentum: absolute 90d > 0 + relative top 25%",
                "D_vol_risk_premium": "Volatility risk premium overlay on adaptive_vol_15pct",
                "baseline_adaptive_vol_15pct": "Base adaptive_vol_15pct (no overlay, for comparison)",
            },
        },
        "results": results,
        "comparison": comparison,
        "best_strategy": comparison[0]["strategy"] if comparison else None,
    }

    return report


# ===================================================================
# Main
# ===================================================================

def main():
    print("=" * 64)
    print("Volatility Prediction Strategies — WFO")
    print("=" * 64)
    print()

    # ---- Step 1: Load data with adaptive timestamp ----
    print("1. Loading data with adaptive timestamp ...")
    all_dates, symbols, close, high, low, volume, ret, btc_idx = (
        discover_adaptive_range(MAIN_SYMBOLS)
    )
    n_dates = len(all_dates)
    n_sym = len(symbols)
    print(f"   Date range: {all_dates[0]} to {all_dates[-1]} ({n_dates} days)")
    print()

    if btc_idx is None:
        print("ERROR: BTCUSDT not found in symbols", file=sys.stderr)
        sys.exit(1)

    # ---- Step 2: Precompute shared rolling statistics ----
    print("2. Precomputing shared rolling statistics ...")
    print("   2a. Rolling 60d vol ...", end=" ", flush=True)
    vol_60d = rolling_std(ret, 60)
    print(f"done ({np.sum(np.isfinite(vol_60d)):,} finite values)")

    print("   2b. Rolling 30d vol ...", end=" ", flush=True)
    vol_30d = rolling_std(ret, 30)
    print("done")

    print("   2c. Rolling 30d range (Parkinson) vol ...", end=" ", flush=True)
    vol_range_30d = rolling_parkinson_vol(high, low, 30)
    print("done")

    print("   2d. Rolling 10d, 30d, 90d returns (momentum) ...", end=" ", flush=True)
    ret_10d = rolling_return(close, 10)
    ret_30d = rolling_return(close, 30)
    ret_90d = rolling_return(close, 90)
    print("done")
    print()

    sym_indices = np.arange(n_sym, dtype=int)

    # ---- Step 3: Run WFO for each strategy ----
    # We need enough data for at least one WFO fold
    min_required = TRAIN_DAYS + TEST_DAYS
    if n_dates < min_required:
        print(f"ERROR: need at least {min_required} days, have {n_dates}", file=sys.stderr)
        sys.exit(1)

    results: dict[str, dict] = {}

    # ---- 3a. Baseline adaptive_vol_15pct (no overlay) ----
    print("3a. Running baseline adaptive_vol_15pct (no overlay) ...", flush=True)
    baseline_result = run_wfo(
        "baseline_adaptive_vol_15pct",
        run_baseline_fold,
        {
            "close": close,
            "volume": volume,
            "ret": ret,
            "vol_60d": vol_60d,
            "btc_idx": btc_idx,
            "sym_indices": sym_indices,
            "rebal_interval": 21,
        },
        all_dates, n_dates,
    )
    results["baseline_adaptive_vol_15pct"] = baseline_result
    if "error" not in baseline_result:
        print(f"   Sharpe: {baseline_result['sharpe']:.2f}, "
              f"Win rate: {baseline_result['win_rate']:.2%}, "
              f"Ann ret: {baseline_result['annualized_return']:.2%}")
    else:
        print(f"   ERROR: {baseline_result['error']}")
    print()

    # ---- 3b. Strategy A: Vol prediction overlay ----
    print("3b. Running Strategy A: Vol prediction overlay ...", flush=True)
    result_a = run_wfo(
        "A_vol_prediction_overlay",
        run_strategy_a_fold,
        {
            "close": close,
            "volume": volume,
            "ret": ret,
            "vol_60d": vol_60d,
            "btc_idx": btc_idx,
            "sym_indices": sym_indices,
            "rebal_interval": 21,
        },
        all_dates, n_dates,
    )
    results["A_vol_prediction_overlay"] = result_a
    if "error" not in result_a:
        print(f"   Sharpe: {result_a['sharpe']:.2f}, "
              f"Win rate: {result_a['win_rate']:.2%}, "
              f"Ann ret: {result_a['annualized_return']:.2%}")
    else:
        print(f"   ERROR: {result_a['error']}")
    print()

    # ---- 3c. Strategy B: Multi-timeframe momentum ----
    print("3c. Running Strategy B: Multi-timeframe momentum ...", flush=True)
    result_b = run_wfo(
        "B_multitf_momentum",
        run_strategy_b_fold,
        {
            "close": close,
            "ret_10d": ret_10d,
            "ret_30d": ret_30d,
            "ret_90d": ret_90d,
            "btc_idx": btc_idx,
            "sym_indices": sym_indices,
            "rebal_interval": 30,
        },
        all_dates, n_dates,
    )
    results["B_multitf_momentum"] = result_b
    if "error" not in result_b:
        print(f"   Sharpe: {result_b['sharpe']:.2f}, "
              f"Win rate: {result_b['win_rate']:.2%}, "
              f"Ann ret: {result_b['annualized_return']:.2%}")
    else:
        print(f"   ERROR: {result_b['error']}")
    print()

    # ---- 3d. Strategy C: Dual momentum ----
    print("3d. Running Strategy C: Dual momentum ...", flush=True)
    result_c = run_wfo(
        "C_dual_momentum",
        run_strategy_c_fold,
        {
            "close": close,
            "ret_90d": ret_90d,
            "btc_idx": btc_idx,
            "sym_indices": sym_indices,
            "rebal_interval": 30,
        },
        all_dates, n_dates,
    )
    results["C_dual_momentum"] = result_c
    if "error" not in result_c:
        print(f"   Sharpe: {result_c['sharpe']:.2f}, "
              f"Win rate: {result_c['win_rate']:.2%}, "
              f"Ann ret: {result_c['annualized_return']:.2%}")
    else:
        print(f"   ERROR: {result_c['error']}")
    print()

    # ---- 3e. Strategy D: Volatility risk premium overlay ----
    print("3e. Running Strategy D: Volatility risk premium overlay ...", flush=True)
    result_d = run_wfo(
        "D_vol_risk_premium",
        run_strategy_d_fold,
        {
            "close": close,
            "volume": volume,
            "ret": ret,
            "vol_30d": vol_30d,
            "vol_range_30d": vol_range_30d,
            "btc_idx": btc_idx,
            "sym_indices": sym_indices,
            "rebal_interval": 21,
        },
        all_dates, n_dates,
    )
    results["D_vol_risk_premium"] = result_d
    if "error" not in result_d:
        print(f"   Sharpe: {result_d['sharpe']:.2f}, "
              f"Win rate: {result_d['win_rate']:.2%}, "
              f"Ann ret: {result_d['annualized_return']:.2%}")
    else:
        print(f"   ERROR: {result_d['error']}")
    print()

    # ---- Step 4: Build and write report ----
    print("4. Building report ...")
    report = build_report(results, all_dates, symbols)

    os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"   Report: {OUTPUT_PATH}")
    print()

    # ---- Summary ----
    print("=" * 64)
    print("WFO Summary")
    print("=" * 64)
    print(f"  {'Strategy':35s} {'Sharpe':>7s} {'WinRate':>8s} {'AnnRet':>8s} "
          f"{'MaxDD':>8s} {'OutBTC':>7s} {'Trades':>7s}")
    print("  " + "-" * 84)
    for cmp in report["comparison"]:
        name = cmp["strategy"]
        if "error" in cmp:
            print(f"  {name:35s} {'ERROR':>7s} {cmp['error']}")
        else:
            print(f"  {name:35s} {cmp['sharpe']:>7.2f} {cmp['win_rate']:>8.2%} "
                  f"{cmp['annualized_return']:>8.2%} {cmp['max_drawdown']:>8.2%} "
                  f"{cmp['outperform_btc_rate']:>7.2%} {cmp['n_total_trades']:>7d}")

    best = report.get("best_strategy")
    if best:
        print(f"\n  Best strategy: {best}")
    print()


if __name__ == "__main__":
    main()
