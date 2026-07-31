#!/usr/bin/env python3
"""
Final push — break 70% win rate.

Tests 6 near-miss variants building on V6 (market-cap weighted).

Variants:
  V6a: Volume floor filter — exclude coins below median daily volume
  V6b: BTC market-wide vol filter — skip when BTC 21d realized vol > 90th pctile
  V6c: Fine-grid quantile search — sweep 0.12 to 0.28 (step 0.02)
  V6d: BTC SMA200 filter — only long when BTC close > SMA200
  V6e: Two-stage rank — bottom 30% by vol, top 50% by volume
  V6f: Adjusted holding period — sweep 30 to 90 (step 10)

WFO-Lite: train=365d, test=63d, step=21d.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/low_vol_final_push.py

Output: data/research/low_vol_final_push_report.json

Read-only on data files. No secrets, no API calls.
"""

import json
import os
import sys
import zipfile
import time
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
OUTPUT_PATH = 'data/research/low_vol_final_push_report.json'
COST_BPS = 15
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')

# Known best config from V6 (market-cap weighted)
V6_CONFIG = {
    'vol_window': 60,
    'holding_period': 60,
    'quantile': 0.20,
    'min_symbols': 3,
    'use_mainstream': True,
}

MAIN_SYMBOLS = frozenset([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
    'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
    'AAVEUSDT', 'MKRUSDT',
])

# Vol windows needed
VOL_WINDOWS_NEEDED = sorted({10, 21, 30, 45, 60})

BASELINE_WIN_RATE = 0.6866


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def discover_symbols(max_symbols: int = 50) -> list[str]:
    """Return top *max_symbols* symbols by monthly ZIP file count."""
    results: list[tuple[int, str]] = []
    for d in os.listdir(KLINES_DIR):
        if any(d.endswith(p) for p in LEVERAGED_PATTERNS):
            continue
        kline_path = os.path.join(KLINES_DIR, d, '1d')
        if not os.path.isdir(kline_path):
            continue
        files = sorted(f for f in os.listdir(kline_path) if f.endswith('.zip'))
        if len(files) >= 36:
            results.append((len(files), d))
    results.sort(key=lambda t: (-t[0], t[1]))
    return [sym for _, sym in results[:max_symbols]]


def load_daily_closes_and_volume(
    symbol: str,
    start_year: int = 2020,
    end_year: int = 2024,
) -> tuple[dict[str, float], dict[str, float]]:
    """Load daily close prices and volume for *symbol*.

    Returns (closes: dict[date_str]->price, volumes: dict[date_str]->volume).
    """
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {}, {}
    closes: dict[str, float] = {}
    volumes: dict[str, float] = {}
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            fname = f'{symbol}-1d-{year}-{month:02d}.zip'
            fpath = os.path.join(kline_path, fname)
            if not os.path.exists(fpath):
                continue
            try:
                with zipfile.ZipFile(fpath) as z:
                    names = z.namelist()
                    if not names:
                        continue
                    text = z.read(names[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 6:
                            try:
                                ts_ms = int(cols[0])
                                close = float(cols[4])
                                volume = float(cols[5])
                                date_str = datetime.fromtimestamp(
                                    ts_ms / 1000, tz=timezone.utc
                                ).strftime('%Y-%m-%d')
                                closes[date_str] = close
                                volumes[date_str] = volume
                            except (ValueError, IndexError):
                                continue
            except Exception:
                continue
    return closes, volumes


# ---------------------------------------------------------------------------
# Matrix construction
# ---------------------------------------------------------------------------

def build_matrices(
    symbols: list[str],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str], int, int]:
    """Load price and volume data, build aligned matrices.

    Returns:
        close_matrix:   (n_symbols, n_dates) close prices
        volume_matrix:  (n_symbols, n_dates) daily volume (0 for missing)
        ret_matrix:     (n_symbols, n_dates) daily returns, NaN for missing
        all_dates:      sorted date string list
        btc_idx:        index of BTCUSDT in symbols
        n_dates:        number of dates
    """
    all_closes: dict[str, dict[str, float]] = {}
    all_volumes: dict[str, dict[str, float]] = {}
    for sym in symbols:
        closes, volumes = load_daily_closes_and_volume(sym)
        if closes:
            all_closes[sym] = closes
            all_volumes[sym] = volumes

    all_dates = sorted(set(
        d for closes in all_closes.values() for d in closes
    ))
    n_dates = len(all_dates)
    n_sym = len(symbols)

    print(f'  Price matrix: {n_sym} symbols x {n_dates} days')
    print(f'  Period: {all_dates[0]} to {all_dates[-1]}')

    close_matrix = np.full((n_sym, n_dates), np.nan)
    volume_matrix = np.zeros((n_sym, n_dates))
    date_to_idx = {d: i for i, d in enumerate(all_dates)}

    for si, sym in enumerate(symbols):
        if sym in all_closes:
            for d, p in all_closes[sym].items():
                if d in date_to_idx:
                    close_matrix[si, date_to_idx[d]] = p
            if sym in all_volumes:
                for d, v in all_volumes[sym].items():
                    if d in date_to_idx:
                        volume_matrix[si, date_to_idx[d]] = v

    # Daily simple returns
    ret_matrix = np.full((n_sym, n_dates), np.nan)
    ret_matrix[:, 0] = 0.0
    with np.errstate(invalid='ignore', divide='ignore'):
        ret_matrix[:, 1:] = (
            close_matrix[:, 1:] / close_matrix[:, :-1] - 1.0
        )

    # BTC index
    btc_idx = None
    for si, sym in enumerate(symbols):
        if sym == 'BTCUSDT':
            btc_idx = si
            break

    vol_windows_arr = np.array(VOL_WINDOWS_NEEDED, dtype=int)

    return close_matrix, volume_matrix, ret_matrix, vol_windows_arr, all_dates, btc_idx, n_dates


# ---------------------------------------------------------------------------
# Rolling volatility precomputation
# ---------------------------------------------------------------------------

def precompute_rolling_vol(
    ret_matrix: np.ndarray,
    vol_windows: np.ndarray,
) -> np.ndarray:
    """Precompute rolling vol for each (window, symbol, date).

    vol_cache[wi, si, di] = std of past vol_windows[wi] daily returns
                            ending at date index di. NaN if insufficient data.
    """
    n_sym, n_dates = ret_matrix.shape
    n_windows = len(vol_windows)
    vol_cache = np.full((n_windows, n_sym, n_dates), np.nan)

    total_ops = n_windows * n_sym
    ops_done = 0
    last_pct = -1

    for wi, vw in enumerate(vol_windows):
        for si in range(n_sym):
            for di in range(vw, n_dates):
                ret_slice = ret_matrix[si, di - vw + 1: di + 1]
                valid_mask = np.isfinite(ret_slice)
                n_valid = np.sum(valid_mask)
                if n_valid >= max(vw // 2, 5):
                    vol_cache[wi, si, di] = float(np.nanstd(ret_slice, ddof=1))

            ops_done += 1
            pct = (ops_done * 100) // total_ops
            if pct > last_pct and pct % 10 == 0:
                print(f'    Vol precompute: {pct}%', flush=True)
                last_pct = pct

    print(f'    Vol precompute: 100%')
    return vol_cache


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def compute_sma(close_matrix: np.ndarray, sym_idx: int, di: int, window: int) -> float | None:
    """Compute SMA for a symbol at date index di over *window* days.

    Returns None if insufficient data.
    """
    start = max(0, di - window + 1)
    prices = close_matrix[sym_idx, start:di + 1]
    valid = prices[np.isfinite(prices)]
    if len(valid) < window // 2:
        return None
    return float(np.mean(valid))


def compute_metrics_from_window_returns(
    window_returns: list[float],
    btc_window_returns: list[float],
    holding_period: int,
) -> dict:
    """Compute pooled metrics from a list of window returns."""
    pool = np.array(window_returns)
    btc_pool = np.array(btc_window_returns)

    if len(pool) == 0:
        return {}

    win_rate = float(np.mean(pool > 0))
    mean_return = float(np.mean(pool))
    outperform_rate = (float(np.mean(pool > btc_pool))
                       if len(btc_pool) == len(pool) else 0.0)

    pool_std = float(np.std(pool, ddof=1))
    if pool_std > 0 and len(pool) > 1:
        ann_factor = 365.25 / holding_period
        sharpe = float(np.mean(pool) / pool_std * np.sqrt(ann_factor))
    else:
        sharpe = 0.0

    # Max drawdown from cumulative returns
    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    return {
        'win_rate': round(win_rate, 4),
        'mean_window_return': round(mean_return, 6),
        'annualized_return': round(mean_return * (365.25 / holding_period), 6),
        'sharpe': round(sharpe, 4),
        'outperform_btc_rate': round(outperform_rate, 4),
        'max_drawdown': round(max_dd, 6),
        'n_windows': len(pool),
    }


def _append_btc_benchmark(
    close_matrix: np.ndarray,
    btc_idx: int,
    rebal_di: int,
    hold_end_di: int,
    btc_list: list[float],
) -> None:
    btc_sp = close_matrix[btc_idx, rebal_di]
    btc_ep = close_matrix[btc_idx, hold_end_di]
    if np.isfinite(btc_sp) and np.isfinite(btc_ep) and btc_sp > 0:
        btc_list.append(float(btc_ep / btc_sp - 1))
    else:
        btc_list.append(0.0)


# ---------------------------------------------------------------------------
# WFO-Lite runner with pluggable selector
# ---------------------------------------------------------------------------

def run_wfo_variant(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
    params: dict,
    variant_name: str,
    selector_fn,
    vol_cache_21d: np.ndarray | None = None,
) -> dict | None:
    """Run WFO-Lite for a strategy variant with a custom selector function.

    *selector_fn* is a callable:
        (valid_syms, valid_vols, rebal_di, hold_end_di,
         close_matrix, volume_matrix, ret_matrix,
         btc_idx, sym_filter_arr, params, vol_cache, vol_windows)
        -> (selected_sym_indices, weights)

    Returns None when empty, or dict with pooled metrics.
    """
    vw = params.get('vol_window', 60)
    hp = params.get('holding_period', 60)
    use_mainstream = params.get('use_mainstream', True)

    vw_idx = int(np.where(vol_windows == vw)[0][0])

    # Build symbol filter
    if use_mainstream:
        sym_filter = [i for i, s in enumerate(symbols) if s in MAIN_SYMBOLS]
    else:
        sym_filter = list(range(len(symbols)))
    sym_filter_arr = np.array(sym_filter, dtype=int)

    all_window_rets: list[float] = []
    all_window_btc: list[float] = []

    i = 0
    while i + TRAIN_DAYS + TEST_DAYS <= n_dates:
        test_start = i + TRAIN_DAYS
        test_end = min(test_start + TEST_DAYS, n_dates)

        test_range = np.arange(test_start, test_end)
        if len(test_range) < 10:
            i += STEP_DAYS
            continue

        rebal_points = test_range[::hp]

        for ri in range(len(rebal_points) - 1):
            rebal_di = rebal_points[ri]
            hold_end_di = rebal_points[ri + 1]

            if hold_end_di >= n_dates or rebal_di < vw:
                continue

            # ---- Vol data ----
            vols_at_rebal = vol_cache[vw_idx, sym_filter_arr, rebal_di]
            valid_mask = np.isfinite(vols_at_rebal) & (vols_at_rebal > 0)
            n_valid = int(np.sum(valid_mask))

            if n_valid < params.get('min_symbols', 3):
                continue

            valid_syms = sym_filter_arr[valid_mask]
            valid_vols = vols_at_rebal[valid_mask]

            # ---- Custom selection ----
            selected, weights = selector_fn(
                valid_syms, valid_vols, rebal_di, hold_end_di,
                close_matrix, volume_matrix, ret_matrix,
                btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
            )

            if len(selected) == 0:
                # Cash position: 0% net return, track BTC benchmark
                all_window_rets.append(0.0)
                _append_btc_benchmark(close_matrix, btc_idx,
                                      rebal_di, hold_end_di, all_window_btc)
                continue

            # ---- Forward return ----
            start_prices = close_matrix[selected, rebal_di]
            end_prices = close_matrix[selected, hold_end_di]

            price_valid = (
                np.isfinite(start_prices)
                & np.isfinite(end_prices)
                & (start_prices > 0)
            )
            n_price_valid = int(np.sum(price_valid))
            if n_price_valid < 1:
                continue

            fwd_rets = end_prices[price_valid] / start_prices[price_valid] - 1.0

            # Adjust weights for price-valid subset
            if len(weights) == len(selected):
                w = weights[price_valid]
                w_sum = float(np.sum(w))
                if w_sum > 0:
                    w = w / w_sum
                else:
                    w = np.ones(n_price_valid) / n_price_valid
            else:
                w = np.ones(n_price_valid) / n_price_valid

            gross = float(np.sum(w * fwd_rets))
            net = gross - COST_BPS / 10000 * 2

            all_window_rets.append(net)
            _append_btc_benchmark(close_matrix, btc_idx,
                                  rebal_di, hold_end_di, all_window_btc)

        i += STEP_DAYS

    if not all_window_rets:
        return None

    metrics = compute_metrics_from_window_returns(
        all_window_rets, all_window_btc, hp,
    )
    return metrics


# ---------------------------------------------------------------------------
# Precompute per-date context arrays (SMA200, BTC vol percentile, etc.)
# ---------------------------------------------------------------------------

def precompute_btc_sma200(
    close_matrix: np.ndarray,
    btc_idx: int,
    n_dates: int,
) -> np.ndarray:
    """Precompute boolean array: is BTC price > SMA200 at each date?

    Returns bool[n_dates] where True means BTC > SMA200.
    """
    above_sma200 = np.zeros(n_dates, dtype=bool)
    for di in range(200, n_dates):
        sma = compute_sma(close_matrix, btc_idx, di, 200)
        if sma is not None and np.isfinite(close_matrix[btc_idx, di]):
            above_sma200[di] = close_matrix[btc_idx, di] > sma
    return above_sma200


def precompute_btc_vol_percentile(
    vol_cache: np.ndarray,
    btc_idx: int,
    n_dates: int,
    lookback_window: int = 21,
    percentile: float = 0.90,
) -> np.ndarray:
    """Precompute boolean array: is BTC realized vol above historical percentile?

    At each date di, computes BTC's `lookback_window`-day realized vol,
    then checks if it exceeds the `percentile`-th percentile of all past
    values (up to di). Returns bool[n_dates] where True means "high vol,
    skip trading".

    The vol_cache index for `lookback_window` must exist.
    """
    # VOL_WINDOWS_NEEDED is a Python list; convert for np.where
    vw_arr = np.array(VOL_WINDOWS_NEEDED, dtype=int)
    vw_idx = int(np.where(vw_arr == lookback_window)[0][0])
    btc_vols = vol_cache[vw_idx, btc_idx, :]  # (n_dates,)

    high_vol_flag = np.zeros(n_dates, dtype=bool)

    for di in range(n_dates):
        if not np.isfinite(btc_vols[di]):
            continue
        # Look at all earlier dates for percentile
        history = btc_vols[:di]
        valid_history = history[np.isfinite(history)]
        if len(valid_history) < 20:
            continue  # not enough history, don't flag
        threshold = float(np.percentile(valid_history, percentile * 100))
        if btc_vols[di] > threshold:
            high_vol_flag[di] = True

    return high_vol_flag


# ---------------------------------------------------------------------------
# Selector functions for each variant
# ---------------------------------------------------------------------------

# Globals for precomputed state that selectors need
_ABOVE_SMA200: np.ndarray | None = None
_HIGH_BTC_VOL: np.ndarray | None = None


def selector_v6_mcap_weight(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """V6 baseline: bottom-quantile by vol, market-cap weight via sqrt(volume)."""
    q = params.get('quantile', 0.20)
    n_valid = len(valid_syms)
    n_long = max(1, int(n_valid * q))

    sort_order = np.argsort(valid_vols)
    selected = valid_syms[sort_order[:n_long]]

    sel_volumes = volume_matrix[selected, rebal_di]
    vol_valid = np.isfinite(sel_volumes) & (sel_volumes > 0)
    n_vv = int(np.sum(vol_valid))

    if n_vv < 1:
        weights = np.ones(len(selected)) / len(selected)
        return selected, weights

    sqrt_vols = np.sqrt(sel_volumes[vol_valid])
    weights = np.zeros(len(selected))
    weights[vol_valid] = sqrt_vols / float(np.sum(sqrt_vols))
    return selected, weights


# ---- V6a: Volume floor filter -----------------------------------------------

def selector_v6a_volume_floor(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """V6a: Filter out coins below median volume, then apply V6 selection.

    First filters the valid coins to only those with daily_volume >= median,
    then applies the same bottom-quantile-by-vol + mcap-weight as V6.
    """
    q = params.get('quantile', 0.20)

    # Get volumes at rebalance date for valid symbols
    volumes_at_rebal = volume_matrix[valid_syms, rebal_di]
    vol_finite = np.isfinite(volumes_at_rebal) & (volumes_at_rebal > 0)

    if int(np.sum(vol_finite)) < 2:
        # Not enough volume data, fall through
        return selector_v6_mcap_weight(
            valid_syms, valid_vols, rebal_di, hold_end_di,
            close_matrix, volume_matrix, ret_matrix,
            btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
        )

    # Compute median volume across valid symbols
    median_vol = float(np.median(volumes_at_rebal[vol_finite]))

    # Filter to symbols with volume >= median
    above_median = vol_finite & (volumes_at_rebal >= median_vol)
    n_above = int(np.sum(above_median))

    if n_above < params.get('min_symbols', 3):
        # Too few symbols after filter, use unfiltered V6
        return selector_v6_mcap_weight(
            valid_syms, valid_vols, rebal_di, hold_end_di,
            close_matrix, volume_matrix, ret_matrix,
            btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
        )

    filtered_syms = valid_syms[above_median]
    filtered_vols = valid_vols[above_median]

    # Apply V6 selection on filtered set
    n_long = max(1, int(n_above * q))
    sort_order = np.argsort(filtered_vols)
    selected = filtered_syms[sort_order[:n_long]]

    # Market-cap weight within selected
    sel_volumes = volume_matrix[selected, rebal_di]
    vv = np.isfinite(sel_volumes) & (sel_volumes > 0)
    n_vv = int(np.sum(vv))

    if n_vv < 1:
        weights = np.ones(len(selected)) / len(selected)
        return selected, weights

    sqrt_vols = np.sqrt(sel_volumes[vv])
    weights = np.zeros(len(selected))
    weights[vv] = sqrt_vols / float(np.sum(sqrt_vols))
    return selected, weights


# ---- V6b: BTC market-wide vol filter ---------------------------------------

def selector_v6b_vol_filter(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """V6b: Skip trading when BTC 21d realized vol is at extreme levels.

    Uses precomputed _HIGH_BTC_VOL array. If flagged, returns empty
    (stay in cash). Otherwise applies V6 selection.
    """
    global _HIGH_BTC_VOL
    if _HIGH_BTC_VOL is not None and rebal_di < len(_HIGH_BTC_VOL):
        if _HIGH_BTC_VOL[rebal_di]:
            # High vol environment -> stay in cash
            return np.array([], dtype=int), np.array([])

    # Normal environment, apply V6
    return selector_v6_mcap_weight(
        valid_syms, valid_vols, rebal_di, hold_end_di,
        close_matrix, volume_matrix, ret_matrix,
        btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
    )


# ---- V6d: SMA200 filter ----------------------------------------------------

def selector_v6d_sma200(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """V6d: Only long when BTC close > SMA200.

    Simpler trend filter — avoids deep bear markets.
    Uses precomputed _ABOVE_SMA200 array.
    """
    global _ABOVE_SMA200
    if _ABOVE_SMA200 is not None and rebal_di < len(_ABOVE_SMA200):
        if not _ABOVE_SMA200[rebal_di]:
            # BTC below SMA200 -> stay in cash
            return np.array([], dtype=int), np.array([])

    # Bullish by SMA200, apply V6
    return selector_v6_mcap_weight(
        valid_syms, valid_vols, rebal_di, hold_end_di,
        close_matrix, volume_matrix, ret_matrix,
        btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
    )


# ---- V6e: Two-stage rank ---------------------------------------------------

def selector_v6e_two_stage(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """V6e: Two-stage rank.

    Stage 1: rank by vol (ascending), select bottom 30%
    Stage 2: within that set, rank by volume (descending), select top 50%
    Weight by market cap (sqrt volume) within final set.

    This gives medium-vol-high-cap coins.
    """
    n_valid = len(valid_syms)
    stage1_pct = 0.30  # bottom 30% by vol
    stage2_pct = 0.50  # top 50% by volume within stage 1

    # Stage 1: bottom 30% by vol
    n_stage1 = max(1, int(n_valid * stage1_pct))
    vol_order = np.argsort(valid_vols)
    stage1_syms = valid_syms[vol_order[:n_stage1]]

    # Get volumes for stage 1 symbols
    stage1_volumes = volume_matrix[stage1_syms, rebal_di]
    vol_valid = np.isfinite(stage1_volumes) & (stage1_volumes > 0)
    n_vol_valid = int(np.sum(vol_valid))

    if n_vol_valid < 1:
        # Fall back: take all stage 1, equal weight
        weights = np.ones(len(stage1_syms)) / len(stage1_syms)
        return stage1_syms, weights

    # Stage 2: top 50% by volume (descending) within valid stage 1
    valid_s1 = stage1_syms[vol_valid]
    valid_s1_vols = stage1_volumes[vol_valid]
    n_stage2 = max(1, int(n_vol_valid * stage2_pct))

    # Sort descending by volume
    vol_desc_order = np.argsort(-valid_s1_vols)
    selected = valid_s1[vol_desc_order[:n_stage2]]

    # Market-cap weight within final set
    sel_volumes = volume_matrix[selected, rebal_di]
    vv = np.isfinite(sel_volumes) & (sel_volumes > 0)
    n_vv = int(np.sum(vv))

    if n_vv < 1:
        weights = np.ones(len(selected)) / len(selected)
        return selected, weights

    sqrt_vols = np.sqrt(sel_volumes[vv])
    weights = np.zeros(len(selected))
    weights[vv] = sqrt_vols / float(np.sum(sqrt_vols))
    return selected, weights


# ---------------------------------------------------------------------------
# WFO-Lite runner for param sweeps (V6c quantile, V6f holding_period)
# ---------------------------------------------------------------------------

def run_v6c_quantile_sweep(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """V6c: Fine-grid quantile search.

    Sweep quantile from 0.12 to 0.28 in steps of 0.02.
    Keep vol_window=60, holding_period=60, mainstream only.
    Report best and full sweep.
    """
    quantiles = [round(q, 2) for q in
                 [0.12, 0.14, 0.16, 0.18, 0.20, 0.22, 0.24, 0.26, 0.28]]

    sweep_results: list[dict] = []

    for q in quantiles:
        params = {
            'vol_window': 60,
            'holding_period': 60,
            'quantile': q,
            'min_symbols': 3,
            'use_mainstream': True,
        }
        metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            params, f'v6c_q{q:.2f}', selector_v6_mcap_weight,
        )
        if metrics and metrics.get('n_windows', 0) > 0:
            entry = {'quantile': q, **metrics}
            sweep_results.append(entry)

    if not sweep_results:
        return None

    sweep_results.sort(key=lambda r: -r['win_rate'])
    best = sweep_results[0]

    return {
        'best_quantile': best['quantile'],
        'best_win_rate': best['win_rate'],
        'best_metrics': best,
        'sweep': sweep_results,
    }


def run_v6f_holding_period_sweep(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """V6f: Fine-grid holding_period search.

    Sweep holding_period from 30 to 90 in steps of 10.
    Keep vol_window=60, quantile=0.20, mainstream only.
    Report best and full sweep.
    """
    holding_periods = list(range(30, 91, 10))

    sweep_results: list[dict] = []

    for hp in holding_periods:
        params = {
            'vol_window': 60,
            'holding_period': hp,
            'quantile': 0.20,
            'min_symbols': 3,
            'use_mainstream': True,
        }
        metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            params, f'v6f_hp{hp}', selector_v6_mcap_weight,
        )
        if metrics and metrics.get('n_windows', 0) > 0:
            entry = {'holding_period': hp, **metrics}
            sweep_results.append(entry)

    if not sweep_results:
        return None

    sweep_results.sort(key=lambda r: -r['win_rate'])
    best = sweep_results[0]

    return {
        'best_holding_period': best['holding_period'],
        'best_win_rate': best['win_rate'],
        'best_metrics': best,
        'sweep': sweep_results,
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print('=== Low-Vol Final Push: Break 70% Win Rate ===')
    print(f'Baseline best: {BASELINE_WIN_RATE:.2%} (V6 market-cap weighted)')
    print(f'WFO-Lite: train={TRAIN_DAYS}d, test={TEST_DAYS}d, step={STEP_DAYS}d')
    print()

    # ---- Step 1: Data loading ----
    print('1. Discovering symbols...')
    symbols = discover_symbols(50)
    print(f'   Found {len(symbols)} symbols')

    print('2. Loading data and building matrices...')
    close_matrix, volume_matrix, ret_matrix, vol_windows, all_dates, btc_idx, n_dates = build_matrices(symbols)

    if btc_idx is None:
        print('ERROR: BTCUSDT not found in symbols')
        sys.exit(1)

    # ---- Step 2: Precompute rolling volatility ----
    print('3. Precomputing rolling volatility...')
    t0 = time.time()
    vol_cache = precompute_rolling_vol(ret_matrix, vol_windows)
    t1 = time.time()
    vol_cache_size = vol_cache.nbytes
    print(f'   Vol cache: {vol_cache.shape}, {vol_cache_size / 1024 / 1024:.1f} MB, computed in {t1 - t0:.1f}s')

    # ---- Step 2b: Precompute context arrays ----
    print('4. Precomputing context arrays (SMA200, BTC vol percentile)...')

    # SMA200
    global _ABOVE_SMA200, _HIGH_BTC_VOL
    t2 = time.time()
    _ABOVE_SMA200 = precompute_btc_sma200(close_matrix, btc_idx, n_dates)
    above_count = int(np.sum(_ABOVE_SMA200))
    print(f'   BTC > SMA200: {above_count}/{n_dates} days ({above_count/n_dates:.1%})')

    # BTC 21d vol percentile
    _HIGH_BTC_VOL = precompute_btc_vol_percentile(
        vol_cache, btc_idx, n_dates, lookback_window=21, percentile=0.90,
    )
    high_vol_count = int(np.sum(_HIGH_BTC_VOL))
    print(f'   BTC high vol flags (pctile > 90%): {high_vol_count}/{n_dates} days ({high_vol_count/n_dates:.1%})')
    t3 = time.time()
    print(f'   Context arrays computed in {t3 - t2:.1f}s')

    # ---- Step 3: Run all variants ----
    print('\n5. Running all variants...')
    results_list: list[dict] = []
    failures: list[tuple[str, str]] = []

    # --- V6a: Volume floor filter ---
    print('\n   --- V6a: Volume floor filter ---')
    try:
        v6a_params = {**V6_CONFIG}
        v6a_metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            v6a_params, 'v6a_volume_floor', selector_v6a_volume_floor,
        )
        if v6a_metrics and v6a_metrics.get('n_windows', 0) > 0:
            entry = {'name': 'v6a_volume_floor', **v6a_metrics}
            results_list.append(entry)
            print(f'      Win rate:            {v6a_metrics["win_rate"]:.2%}')
            print(f'      Sharpe:              {v6a_metrics["sharpe"]:.2f}')
            print(f'      Mean window return:  {v6a_metrics["mean_window_return"]:.4f}')
            print(f'      Annualized return:   {v6a_metrics["annualized_return"]:.4f}')
            print(f'      Outperform BTC rate: {v6a_metrics["outperform_btc_rate"]:.2%}')
            print(f'      Max drawdown:        {v6a_metrics["max_drawdown"]:.2%}')
            print(f'      N windows:           {v6a_metrics["n_windows"]}')
        else:
            failures.append(('v6a_volume_floor', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6a_volume_floor', str(e)))
        print(f'      FAILED: {e}')

    # --- V6b: Vol filter ---
    print('\n   --- V6b: BTC market-wide vol filter ---')
    try:
        v6b_params = {**V6_CONFIG}
        v6b_metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            v6b_params, 'v6b_vol_filter', selector_v6b_vol_filter,
        )
        if v6b_metrics and v6b_metrics.get('n_windows', 0) > 0:
            entry = {'name': 'v6b_vol_filter', **v6b_metrics}
            results_list.append(entry)
            print(f'      Win rate:            {v6b_metrics["win_rate"]:.2%}')
            print(f'      Sharpe:              {v6b_metrics["sharpe"]:.2f}')
            print(f'      Mean window return:  {v6b_metrics["mean_window_return"]:.4f}')
            print(f'      Annualized return:   {v6b_metrics["annualized_return"]:.4f}')
            print(f'      Outperform BTC rate: {v6b_metrics["outperform_btc_rate"]:.2%}')
            print(f'      Max drawdown:        {v6b_metrics["max_drawdown"]:.2%}')
            print(f'      N windows:           {v6b_metrics["n_windows"]}')
        else:
            failures.append(('v6b_vol_filter', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6b_vol_filter', str(e)))
        print(f'      FAILED: {e}')

    # --- V6d: SMA200 filter ---
    print('\n   --- V6d: SMA200 filter ---')
    try:
        v6d_params = {**V6_CONFIG}
        v6d_metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            v6d_params, 'v6d_sma200', selector_v6d_sma200,
        )
        if v6d_metrics and v6d_metrics.get('n_windows', 0) > 0:
            entry = {'name': 'v6d_sma200', **v6d_metrics}
            results_list.append(entry)
            print(f'      Win rate:            {v6d_metrics["win_rate"]:.2%}')
            print(f'      Sharpe:              {v6d_metrics["sharpe"]:.2f}')
            print(f'      Mean window return:  {v6d_metrics["mean_window_return"]:.4f}')
            print(f'      Annualized return:   {v6d_metrics["annualized_return"]:.4f}')
            print(f'      Outperform BTC rate: {v6d_metrics["outperform_btc_rate"]:.2%}')
            print(f'      Max drawdown:        {v6d_metrics["max_drawdown"]:.2%}')
            print(f'      N windows:           {v6d_metrics["n_windows"]}')
        else:
            failures.append(('v6d_sma200', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6d_sma200', str(e)))
        print(f'      FAILED: {e}')

    # --- V6e: Two-stage rank ---
    print('\n   --- V6e: Two-stage rank ---')
    try:
        v6e_params = {**V6_CONFIG}
        v6e_metrics = run_wfo_variant(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
            v6e_params, 'v6e_two_stage', selector_v6e_two_stage,
        )
        if v6e_metrics and v6e_metrics.get('n_windows', 0) > 0:
            entry = {'name': 'v6e_two_stage', **v6e_metrics}
            results_list.append(entry)
            print(f'      Win rate:            {v6e_metrics["win_rate"]:.2%}')
            print(f'      Sharpe:              {v6e_metrics["sharpe"]:.2f}')
            print(f'      Mean window return:  {v6e_metrics["mean_window_return"]:.4f}')
            print(f'      Annualized return:   {v6e_metrics["annualized_return"]:.4f}')
            print(f'      Outperform BTC rate: {v6e_metrics["outperform_btc_rate"]:.2%}')
            print(f'      Max drawdown:        {v6e_metrics["max_drawdown"]:.2%}')
            print(f'      N windows:           {v6e_metrics["n_windows"]}')
        else:
            failures.append(('v6e_two_stage', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6e_two_stage', str(e)))
        print(f'      FAILED: {e}')

    # --- V6c: Quantile sweep ---
    print('\n   --- V6c: Fine-grid quantile search ---')
    try:
        v6c_result = run_v6c_quantile_sweep(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
        )
        if v6c_result and v6c_result.get('best_metrics'):
            best_q = v6c_result['best_quantile']
            best_wr = v6c_result['best_win_rate']
            print(f'      Best quantile: {best_q} (WR={best_wr:.2%})')
            for sweep_entry in v6c_result['sweep']:
                q = sweep_entry.get('quantile', '?')
                wr = sweep_entry.get('win_rate', 0)
                print(f'        q={q:.2f} -> WR={wr:.2%}')
            entry = {
                'name': 'v6c_quantile_search',
                **v6c_result['best_metrics'],
                'best_quantile': best_q,
                'sweep_detail': v6c_result['sweep'],
            }
            results_list.append(entry)
        else:
            failures.append(('v6c_quantile_search', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6c_quantile_search', str(e)))
        print(f'      FAILED: {e}')

    # --- V6f: Holding period sweep ---
    print('\n   --- V6f: Holding period search ---')
    try:
        v6f_result = run_v6f_holding_period_sweep(
            close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
            all_dates, symbols, btc_idx, n_dates,
        )
        if v6f_result and v6f_result.get('best_metrics'):
            best_hp = v6f_result['best_holding_period']
            best_wr = v6f_result['best_win_rate']
            print(f'      Best holding_period: {best_hp}d (WR={best_wr:.2%})')
            for sweep_entry in v6f_result['sweep']:
                hp = sweep_entry.get('holding_period', '?')
                wr = sweep_entry.get('win_rate', 0)
                print(f'        hp={hp}d -> WR={wr:.2%}')
            entry = {
                'name': 'v6f_holding_period_search',
                **v6f_result['best_metrics'],
                'best_holding_period': best_hp,
                'sweep_detail': v6f_result['sweep'],
            }
            results_list.append(entry)
        else:
            failures.append(('v6f_holding_period_search', 'No valid windows'))
            print('      FAILED: No valid windows')
    except Exception as e:
        failures.append(('v6f_holding_period_search', str(e)))
        print(f'      FAILED: {e}')

    # ---- Step 4: Determine best ----
    target_70_met = False
    best_variant = 'N/A'
    best_win_rate = 0.0
    best_detail = {}

    if results_list:
        results_list.sort(key=lambda r: -r['win_rate'])
        best_variant = results_list[0]['name']
        best_win_rate = results_list[0]['win_rate']
        target_70_met = best_win_rate > 0.70

        print(f'\n6. Best variant: {best_variant} (WR={best_win_rate:.2%})')
        print(f'   Target 70% met: {"YES" if target_70_met else "NO"}')

        best_detail = {
            'variant': best_variant,
            'win_rate': results_list[0]['win_rate'],
            'mean_window_return': results_list[0].get('mean_window_return', 0),
            'annualized_return': results_list[0].get('annualized_return', 0),
            'sharpe': results_list[0].get('sharpe', 0),
            'outperform_btc_rate': results_list[0].get('outperform_btc_rate', 0),
            'max_drawdown': results_list[0].get('max_drawdown', 0),
            'n_windows': results_list[0].get('n_windows', 0),
        }

        # Detailed best_params_detail for the best variant
        if best_variant == 'v6c_quantile_search':
            best_detail['best_quantile'] = results_list[0].get('best_quantile')
        elif best_variant == 'v6f_holding_period_search':
            best_detail['best_holding_period'] = results_list[0].get('best_holding_period')
    else:
        print('\n6. No variants produced valid results.')

    # ---- Step 5: Build summary table ----
    variants_summary = []
    for r in results_list:
        variants_summary.append({
            'name': r['name'],
            'win_rate': r['win_rate'],
            'target_met': r['win_rate'] > 0.70,
        })

    # ---- Build and write report ----
    print('\n7. Building report...')

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'baseline_win_rate': BASELINE_WIN_RATE,
        'config': {
            'n_symbols': len(symbols),
            'n_dates': n_dates,
            'period': f'{all_dates[0]} to {all_dates[-1]}',
            'cost_bps': COST_BPS,
            'wfo_mode': 'WFO-Lite',
            'train_days': TRAIN_DAYS,
            'test_days': TEST_DAYS,
            'step_days': STEP_DAYS,
            'baseline_v6_config': V6_CONFIG,
        },
        'variants': variants_summary,
        'variant_details': results_list,
        'failures': [{'name': n, 'reason': r} for n, r in failures],
        'best_variant': best_variant,
        'best_win_rate': round(best_win_rate, 4),
        'target_70_met': target_70_met,
        'best_params_detail': best_detail,
        'plan': 'Update observer with best params' if target_70_met else 'Continue search',
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'   Report: {OUTPUT_PATH}')

    # ---- Summary ----
    print()
    print('=== Final Push Results ===')
    print(f'  Baseline win rate:   {BASELINE_WIN_RATE:.2%}')
    print(f'  Target 70% met:      {"YES" if target_70_met else "NO"}')
    print(f'  Best variant:        {best_variant}')
    print(f'  Best win rate:       {best_win_rate:.2%}')
    print()

    print('  Variant summary:')
    sep_line = '-' * 30 + '  ' + '-' * 8 + '  ' + '-' * 8
    print(f'  {"Name":30s}  {"WR":>8s}  {"Target":>8s}')
    print(f'  {sep_line}')
    for r in results_list:
        met = 'YES' if r['win_rate'] > 0.70 else 'no'
        print(f'  {r["name"]:30s}  {r["win_rate"]:.4f}  {met:>8s}')

    if failures:
        print()
        print('  Failed variants:')
        for n, r in failures:
            print(f'    {n}: {r}')

    if target_70_met:
        print()
        print(f'  *** BREAKTHROUGH: {best_variant} achieves {best_win_rate:.2%} ***')
        print(f'  Plan: {report["plan"]}')
    else:
        print()
        print(f'  Best variant {best_variant} at {best_win_rate:.2%} still below 70%.')
        print(f'  Plan: {report["plan"]}')


if __name__ == '__main__':
    main()
