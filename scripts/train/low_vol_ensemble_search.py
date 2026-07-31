#!/usr/bin/env python3
"""
Ensemble strategy optimization — push win rate past 70%.

Tests 7 advanced low-volatility strategy variants using WFO-Lite
(train=365d, test=63d, step=21d) and reports results.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/low_vol_ensemble_search.py

Output: data/research/low_vol_ensemble_report.json

Read-only on data files. No secrets, no API calls.
"""

import json
import os
import sys
import zipfile
import time
from datetime import datetime, timezone
from functools import partial

import numpy as np

# ---------------------------------------------------------------------------
# Paths and constants
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
OUTPUT_PATH = 'data/research/low_vol_ensemble_report.json'
COST_BPS = 15
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')

# Baseline configuration from best grid search result
# vol_window=60, holding_period=60, quantile=0.2, mainstream only, no trend filter
BASELINE = {
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

# Vol windows needed by variants
VOL_WINDOWS_NEEDED = sorted({10, 21, 30, 45, 60})


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
    all_dates: list[str],
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
# SMA computation helper
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


# ---------------------------------------------------------------------------
# Common WFO-Lite runner with pluggable signal function
# ---------------------------------------------------------------------------

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
) -> dict | None:
    """Run WFO-Lite for a strategy variant with a custom selector function.

    *selector_fn* is a callable:
        (valid_syms, valid_vols, rebal_di, hold_end_di,
         close_matrix, volume_matrix, ret_matrix,
         btc_idx, sym_filter_arr, params, vol_cache, vol_windows)
        -> (selected_sym_indices, weights)

    The function should return (np.array([], dtype=int), np.array([]))
    to signal "stay in cash" for the period.
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
                # Cash position: 0% net return, but track BTC benchmark
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


def _append_btc_benchmark(
    close_matrix: np.ndarray,
    btc_idx: int,
    rebal_di: int,
    hold_end_di: int,
    btc_list: list[float],
) -> None:
    """Append BTC return for the holding period to *btc_list*."""
    btc_sp = close_matrix[btc_idx, rebal_di]
    btc_ep = close_matrix[btc_idx, hold_end_di]
    if np.isfinite(btc_sp) and np.isfinite(btc_ep) and btc_sp > 0:
        btc_list.append(float(btc_ep / btc_sp - 1))
    else:
        btc_list.append(0.0)


# ---------------------------------------------------------------------------
# Selector functions for each variant
# ---------------------------------------------------------------------------

def selector_baseline(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Baseline: bottom-quantile by vol, equal-weight."""
    q = params.get('quantile', 0.20)
    n_valid = len(valid_syms)
    n_long = max(1, int(n_valid * q))
    sort_order = np.argsort(valid_vols)
    selected = valid_syms[sort_order[:n_long]]
    weights = np.ones(len(selected)) / len(selected)
    return selected, weights


def selector_multi_quantile(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 1: Multi-quantile ensemble.

    Run 3 quantiles (0.15, 0.20, 0.25) independently. Select coins
    appearing in >= 2 of the 3. Equal-weight.
    """
    quantiles = [0.15, 0.20, 0.25]
    n_valid = len(valid_syms)

    scores = np.zeros(n_valid, dtype=int)
    for q in quantiles:
        n_q = max(1, int(n_valid * q))
        order = np.argsort(valid_vols)
        selected_set = set(order[:n_q])
        for j in range(n_valid):
            if j in selected_set:
                scores[j] += 1

    consensus = scores >= 2
    n_selected = int(np.sum(consensus))
    if n_selected < 1:
        return np.array([], dtype=int), np.array([])

    selected = valid_syms[consensus]
    weights = np.ones(n_selected) / n_selected
    return selected, weights


def selector_inverse_vol(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 2: Inverse-vol weighting (risk parity).

    Same bottom-quantile selection as baseline, but weight by 1/vol_i.
    """
    q = params.get('quantile', 0.20)
    n_valid = len(valid_syms)
    n_long = max(1, int(n_valid * q))

    sort_order = np.argsort(valid_vols)
    selected = valid_syms[sort_order[:n_long]]
    sel_vols = valid_vols[sort_order[:n_long]]

    inv_vols = 1.0 / sel_vols
    weights = inv_vols / float(np.sum(inv_vols))
    return selected, weights


def pre_filter_sma_trend(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 3: Trend filter v2 (SMA crossover).

    Only select when BTC 50d SMA > 200d SMA. Otherwise stay in cash.
    Uses baseline selection when trend is bullish.
    """
    sma50 = compute_sma(close_matrix, btc_idx, rebal_di, 50)
    sma200 = compute_sma(close_matrix, btc_idx, rebal_di, 200)

    if sma50 is None or sma200 is None:
        return np.array([], dtype=int), np.array([])

    if sma50 <= sma200:
        # Bearish: stay in cash
        return np.array([], dtype=int), np.array([])

    # Bullish: use baseline selection
    return selector_baseline(
        valid_syms, valid_vols, rebal_di, hold_end_di,
        close_matrix, volume_matrix, ret_matrix,
        btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
    )


def selector_momentum_vol(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 4: Momentum + Low Vol combo.

    Rank by vol (ascending) and 21d momentum (descending).
    Take intersection of top quartile by both. Equal-weight.
    """
    q = params.get('quantile', 0.25)
    n_valid = len(valid_syms)

    # Compute 21d momentum for each valid symbol
    momentum_start_di = max(0, rebal_di - 21)
    momentums = []
    for sym_idx in valid_syms:
        sp = close_matrix[int(sym_idx), momentum_start_di]
        ep = close_matrix[int(sym_idx), rebal_di]
        if np.isfinite(sp) and np.isfinite(ep) and sp > 0:
            momentums.append(float(ep / sp - 1))
        else:
            momentums.append(np.nan)

    momentums = np.array(momentums, dtype=float)
    mom_valid = np.isfinite(momentums)
    n_mom_valid = int(np.sum(mom_valid))

    if n_mom_valid < max(3, params.get('min_symbols', 3)):
        return np.array([], dtype=int), np.array([])

    # Filter to symbols with valid momentum
    valid_syms_f = valid_syms[mom_valid]
    valid_vols_f = valid_vols[mom_valid]
    momentums_f = momentums[mom_valid]
    n_f = len(valid_syms_f)

    n_q = max(1, int(n_f * q))

    # Vol ranking (ascending)
    vol_order = np.argsort(valid_vols_f)
    vol_set = set(valid_syms_f[vol_order[:n_q]])

    # Momentum ranking (descending)
    mom_order = np.argsort(-momentums_f)
    mom_set = set(valid_syms_f[mom_order[:n_q]])

    intersection = vol_set & mom_set
    if len(intersection) < 1:
        return np.array([], dtype=int), np.array([])

    selected = np.array(list(intersection), dtype=int)
    weights = np.ones(len(selected)) / len(selected)
    return selected, weights


def run_rolling_optimization_variant(
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
) -> dict | None:
    """Variant 5: Rolling optimization.

    Every 60 days, re-optimize quantile threshold based on last 365 days
    via a simple grid search over quantile=[0.1, 0.15, 0.2, 0.25, 0.3].
    Pick the best quantile (by Sharpe) for the NEXT 60 days.
    """
    vw = params.get('vol_window', 60)
    hp = params.get('holding_period', 60)
    use_mainstream = params.get('use_mainstream', True)

    vw_idx = int(np.where(vol_windows == vw)[0][0])

    if use_mainstream:
        sym_filter = [i for i, s in enumerate(symbols) if s in MAIN_SYMBOLS]
    else:
        sym_filter = list(range(len(symbols)))
    sym_filter_arr = np.array(sym_filter, dtype=int)

    all_window_rets: list[float] = []
    all_window_btc: list[float] = []

    # Rolling optimization state: which quantile to use
    current_quantile = 0.20  # start with baseline
    next_opt_di = TRAIN_DAYS  # first optimization at first test window

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

            # ---- Re-optimize quantile if needed ----
            if rebal_di >= next_opt_di:
                opt_start = max(0, rebal_di - 365)
                opt_end = rebal_di

                candidate_quantiles = [0.10, 0.15, 0.20, 0.25, 0.30]
                best_q = 0.20
                best_sharpe = -999.0

                for cand_q in candidate_quantiles:
                    q_rets: list[float] = []
                    q_step = opt_start + 60
                    while q_step + 60 <= opt_end:
                        q_rebal = q_step
                        q_hold_end = min(q_step + 60, opt_end)

                        vols_q = vol_cache[vw_idx, sym_filter_arr, q_rebal]
                        valid_q = np.isfinite(vols_q) & (vols_q > 0)
                        n_v_q = int(np.sum(valid_q))
                        if n_v_q < params.get('min_symbols', 3):
                            q_step += 60
                            continue

                        syms_q = sym_filter_arr[valid_q]
                        vols_v_q = vols_q[valid_q]

                        n_l = max(1, int(n_v_q * cand_q))
                        order_q = np.argsort(vols_v_q)
                        sel_q = syms_q[order_q[:n_l]]

                        sp_q = close_matrix[sel_q, q_rebal]
                        ep_q = close_matrix[sel_q, q_hold_end]
                        pv_q = (np.isfinite(sp_q) & np.isfinite(ep_q)
                                & (sp_q > 0))
                        n_pv = int(np.sum(pv_q))
                        if n_pv < 1:
                            q_step += 60
                            continue

                        rets = ep_q[pv_q] / sp_q[pv_q] - 1.0
                        q_rets.append(float(np.mean(rets)))
                        q_step += 60

                    if len(q_rets) >= 3:
                        arr = np.array(q_rets)
                        s = float(np.mean(arr) / (np.std(arr, ddof=1) + 1e-10)
                                  * np.sqrt(365.25 / 60))
                        if s > best_sharpe:
                            best_sharpe = s
                            best_q = cand_q

                current_quantile = best_q
                next_opt_di = rebal_di + 60

            # ---- Use current_quantile for selection ----
            vols_at_rebal = vol_cache[vw_idx, sym_filter_arr, rebal_di]
            valid_mask = np.isfinite(vols_at_rebal) & (vols_at_rebal > 0)
            n_valid = int(np.sum(valid_mask))

            if n_valid < params.get('min_symbols', 3):
                continue

            valid_syms = sym_filter_arr[valid_mask]
            valid_vols = vols_at_rebal[valid_mask]

            n_long = max(1, int(n_valid * current_quantile))
            sort_order = np.argsort(valid_vols)
            selected = valid_syms[sort_order[:n_long]]

            # ---- Equal-weight forward return ----
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
            gross = float(np.mean(fwd_rets))
            net = gross - COST_BPS / 10000 * 2

            all_window_rets.append(net)
            _append_btc_benchmark(close_matrix, btc_idx,
                                  rebal_di, hold_end_di, all_window_btc)

        i += STEP_DAYS

    if not all_window_rets:
        return None

    return compute_metrics_from_window_returns(
        all_window_rets, all_window_btc, hp,
    )


def selector_mcap_weight(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 6: Market-cap weighted entry.

    Same selection as baseline but weight by sqrt(daily_volume).
    """
    q = params.get('quantile', 0.20)
    n_valid = len(valid_syms)
    n_long = max(1, int(n_valid * q))

    sort_order = np.argsort(valid_vols)
    selected = valid_syms[sort_order[:n_long]]

    # Get volume for selected symbols
    sel_volumes = volume_matrix[selected, rebal_di]
    vol_valid = np.isfinite(sel_volumes) & (sel_volumes > 0)
    n_vv = int(np.sum(vol_valid))

    if n_vv < 1:
        # Fall back to equal weight
        weights = np.ones(len(selected)) / len(selected)
        return selected, weights

    sqrt_vols = np.sqrt(sel_volumes[vol_valid])
    weights = np.zeros(len(selected))
    weights[vol_valid] = sqrt_vols / float(np.sum(sqrt_vols))
    return selected, weights


def selector_extreme_tail(
    valid_syms, valid_vols, rebal_di, hold_end_di,
    close_matrix, volume_matrix, ret_matrix,
    btc_idx, sym_filter_arr, params, vol_cache, vol_windows,
):
    """Variant 7: Extreme tail (bottom 10%) with long holding.

    Very concentrated low-vol selection, infrequent rebalancing (90d).
    """
    # Override params for this variant
    q = 0.10
    n_valid = len(valid_syms)
    n_long = max(1, int(n_valid * q))

    sort_order = np.argsort(valid_vols)
    selected = valid_syms[sort_order[:n_long]]
    weights = np.ones(len(selected)) / len(selected)
    return selected, weights


# ---------------------------------------------------------------------------
# Combined ensemble: combine top 2-3 variant signals
# ---------------------------------------------------------------------------

def run_combined_ensemble(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
    top_variant_configs: list[tuple[str, dict, callable]],
    params: dict,
) -> dict | None:
    """Run WFO-Lite combining signals from top variants.

    At each rebalance point, each variant selects coins independently.
    A coin is selected if >= majority of variants agree.
    Equal-weight among agreed-upon coins.
    """
    vw = params.get('vol_window', 60)
    hp = params.get('holding_period', 60)
    use_mainstream = params.get('use_mainstream', True)

    vw_idx = int(np.where(vol_windows == vw)[0][0])

    if use_mainstream:
        sym_filter = [i for i, s in enumerate(symbols) if s in MAIN_SYMBOLS]
    else:
        sym_filter = list(range(len(symbols)))
    sym_filter_arr = np.array(sym_filter, dtype=int)

    all_window_rets: list[float] = []
    all_window_btc: list[float] = []

    n_variants = len(top_variant_configs)
    majority_threshold = (n_variants // 2) + 1

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

            # ---- Collect signals from each variant ----
            vote_counts: dict[int, int] = {}

            for vname, vparams, vselector in top_variant_configs:
                selected, _ = vselector(
                    valid_syms, valid_vols, rebal_di, hold_end_di,
                    close_matrix, volume_matrix, ret_matrix,
                    btc_idx, sym_filter_arr, vparams, vol_cache, vol_windows,
                )
                for sym_idx in selected:
                    vote_counts[int(sym_idx)] = vote_counts.get(int(sym_idx), 0) + 1

            # Only select symbols with majority agreement
            agreed = [s for s, c in vote_counts.items() if c >= majority_threshold]
            if len(agreed) < 1:
                # If no agreement, stay in cash
                all_window_rets.append(0.0)
                _append_btc_benchmark(close_matrix, btc_idx,
                                      rebal_di, hold_end_di, all_window_btc)
                continue

            selected_arr = np.array(agreed, dtype=int)
            weights = np.ones(len(selected_arr)) / len(selected_arr)

            # ---- Forward return ----
            start_prices = close_matrix[selected_arr, rebal_di]
            end_prices = close_matrix[selected_arr, hold_end_di]

            price_valid = (
                np.isfinite(start_prices)
                & np.isfinite(end_prices)
                & (start_prices > 0)
            )
            n_price_valid = int(np.sum(price_valid))
            if n_price_valid < 1:
                continue

            fwd_rets = end_prices[price_valid] / start_prices[price_valid] - 1.0
            w = weights[price_valid] / float(np.sum(weights[price_valid]))
            gross = float(np.sum(w * fwd_rets))
            net = gross - COST_BPS / 10000 * 2

            all_window_rets.append(net)
            _append_btc_benchmark(close_matrix, btc_idx,
                                  rebal_di, hold_end_di, all_window_btc)

        i += STEP_DAYS

    if not all_window_rets:
        return None

    return compute_metrics_from_window_returns(
        all_window_rets, all_window_btc, hp,
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print('=== Low-Vol Ensemble Strategy Search ===')
    print(f'Target: Win rate > 70% on WFO-Lite (train={TRAIN_DAYS}d, test={TEST_DAYS}d, step={STEP_DAYS}d)')
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
    vol_cache = precompute_rolling_vol(ret_matrix, vol_windows, all_dates)
    t1 = time.time()
    vol_cache_size = vol_cache.nbytes
    print(f'   Vol cache: {vol_cache.shape}, {vol_cache_size / 1024 / 1024:.1f} MB, computed in {t1 - t0:.1f}s')

    # ---- Step 3: Run baseline (replicate best grid search result) ----
    print('\n4. Running baseline (best grid search config)...')
    baseline_metrics = run_wfo_variant(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, symbols, btc_idx, n_dates,
        BASELINE, 'baseline', selector_baseline,
    )

    if baseline_metrics:
        print(f'   Win rate:            {baseline_metrics["win_rate"]:.2%}')
        print(f'   Mean window return:  {baseline_metrics["mean_window_return"]:.4f}')
        print(f'   Sharpe:              {baseline_metrics["sharpe"]:.2f}')
        print(f'   Outperform BTC rate: {baseline_metrics["outperform_btc_rate"]:.2%}')
        print(f'   Max drawdown:        {baseline_metrics["max_drawdown"]:.2%}')
        print(f'   N windows:           {baseline_metrics["n_windows"]}')
    else:
        print('   WARNING: Baseline returned no results!')

    # ---- Step 4: Run all 7 variants ----
    variant_defs = [
        ('multi_quantile_ensemble', {
            'vol_window': 60, 'holding_period': 60, 'min_symbols': 3, 'use_mainstream': True,
        }, selector_multi_quantile, 'Variant 1: Multi-quantile ensemble (q=0.15,0.20,0.25, 2-of-3)'),
        ('inverse_vol_weight', {
            'vol_window': 60, 'holding_period': 60, 'quantile': 0.20, 'min_symbols': 3, 'use_mainstream': True,
        }, selector_inverse_vol, 'Variant 2: Inverse-vol weighting (risk parity)'),
        ('sma_trend_filter', {
            'vol_window': 60, 'holding_period': 60, 'quantile': 0.20, 'min_symbols': 3, 'use_mainstream': True,
        }, pre_filter_sma_trend, 'Variant 3: Trend filter v2 (BTC SMA50 > SMA200)'),
        ('momentum_vol_combo', {
            'vol_window': 60, 'holding_period': 60, 'quantile': 0.25, 'min_symbols': 3, 'use_mainstream': True,
        }, selector_momentum_vol, 'Variant 4: Momentum + Low Vol combo (intersection)'),
        ('rolling_optimization', {
            'vol_window': 60, 'holding_period': 60, 'min_symbols': 3, 'use_mainstream': True,
        }, None, 'Variant 5: Rolling optimization (re-optimize quantile every 60d)'),
        ('mcap_weighted', {
            'vol_window': 60, 'holding_period': 60, 'quantile': 0.20, 'min_symbols': 3, 'use_mainstream': True,
        }, selector_mcap_weight, 'Variant 6: Market-cap weighted (sqrt volume proxy)'),
        ('extreme_tail', {
            'vol_window': 60, 'holding_period': 90, 'quantile': 0.10, 'min_symbols': 3, 'use_mainstream': True,
        }, selector_extreme_tail, 'Variant 7: Extreme tail (q=0.10, hp=90d)'),
    ]

    results_list: list[dict] = []
    failures: list[tuple[str, str]] = []

    print('\n5. Running 7 strategy variants...')
    for vname, vparams, vselector, vdesc in variant_defs:
        print(f'\n   --- {vname}: {vdesc} ---')
        try:
            if vname == 'rolling_optimization':
                metrics = run_rolling_optimization_variant(
                    close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
                    all_dates, symbols, btc_idx, n_dates,
                    vparams,
                )
            else:
                metrics = run_wfo_variant(
                    close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
                    all_dates, symbols, btc_idx, n_dates,
                    vparams, vname, vselector,
                )

            if metrics and metrics.get('n_windows', 0) > 0:
                entry = {'name': vname, **metrics}
                results_list.append(entry)
                print(f'      Win rate:            {metrics["win_rate"]:.2%}')
                print(f'      Mean window return:  {metrics["mean_window_return"]:.4f}')
                print(f'      Annualized return:   {metrics["annualized_return"]:.4f}')
                print(f'      Sharpe:              {metrics["sharpe"]:.2f}')
                print(f'      Outperform BTC rate: {metrics["outperform_btc_rate"]:.2%}')
                print(f'      Max drawdown:        {metrics["max_drawdown"]:.2%}')
                print(f'      N windows:           {metrics["n_windows"]}')
            else:
                failures.append((vname, 'No valid windows'))
                print('      FAILED: No valid windows')
        except Exception as e:
            failures.append((vname, str(e)))
            print(f'      FAILED: {e}')

    # ---- Step 5: Find best variant ----
    if results_list:
        results_list.sort(key=lambda r: -r['win_rate'])
        best_variant = results_list[0]['name']
        best_win_rate = results_list[0]['win_rate']
        print(f'\n6. Best variant: {best_variant} (WR={best_win_rate:.2%})')

        target_70_met = best_win_rate > 0.70
        print(f'   Target 70% met: {"YES" if target_70_met else "NO"}')
    else:
        best_variant = 'N/A'
        best_win_rate = 0.0
        target_70_met = False
        print('\n6. No variants produced valid results.')

    # ---- Step 6: Combined ensemble ----
    print('\n7. Running combined ensemble of top variants...')
    combined_result = None
    top_n_for_ensemble = min(3, len(results_list))

    if top_n_for_ensemble >= 2:
        top_configs = []
        for i in range(top_n_for_ensemble):
            r = results_list[i]
            # Find matching variant def
            for vname, vparams, vselector, _ in variant_defs:
                if vname == r['name']:
                    top_configs.append((vname, vparams, vselector))
                    break

        if len(top_configs) >= 2:
            combined_result = run_combined_ensemble(
                close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
                all_dates, symbols, btc_idx, n_dates,
                top_configs,
                {'vol_window': 60, 'holding_period': 60, 'min_symbols': 3, 'use_mainstream': True},
            )

    if combined_result and combined_result.get('n_windows', 0) > 0:
        ensemble_entry = {**combined_result}
        print(f'      Win rate:            {combined_result["win_rate"]:.2%}')
        print(f'      Mean window return:  {combined_result["mean_window_return"]:.4f}')
        print(f'      Annualized return:   {combined_result["annualized_return"]:.4f}')
        print(f'      Sharpe:              {combined_result["sharpe"]:.2f}')
        print(f'      Outperform BTC rate: {combined_result["outperform_btc_rate"]:.2%}')
        print(f'      Max drawdown:        {combined_result["max_drawdown"]:.2%}')
        print(f'      N windows:           {combined_result["n_windows"]}')

        combined_win_rate = combined_result['win_rate']
        if combined_win_rate > 0.70:
            target_70_met = True
            print(f'\n   *** COMBINED ENSEMBLE BREAKS 70%! WR={combined_win_rate:.2%} ***')
    else:
        ensemble_entry = None
        print('      Combined ensemble produced no valid results.')

    # ---- Step 7: Build recommendation ----
    if combined_result and combined_result.get('win_rate', 0) > best_win_rate:
        recommendation = (
            f"Use combined ensemble of top {top_n_for_ensemble} variants "
            f"({', '.join(c[0] for c in top_configs)}) "
            f"with majority-vote signal aggregation."
        )
    elif results_list:
        rec_variant = results_list[0]
        recommendation = (
            f"Use single best variant {rec_variant['name']} "
            f"with WR={rec_variant['win_rate']:.2%}. "
            f"Combined ensemble did not improve over the single best variant."
        )
    else:
        recommendation = "No variant produced valid results."

    # ---- Step 8: Build and write report ----
    print('\n8. Building report...')

    baseline_entry = {
        'name': 'best_from_grid',
        **baseline_metrics,
    } if baseline_metrics else None

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'config': {
            'n_symbols': len(symbols),
            'n_dates': n_dates,
            'period': f'{all_dates[0]} to {all_dates[-1]}',
            'cost_bps': COST_BPS,
            'wfo_mode': 'WFO-Lite',
            'train_days': TRAIN_DAYS,
            'test_days': TEST_DAYS,
            'step_days': STEP_DAYS,
            'baseline_config': BASELINE,
        },
        'baseline': baseline_entry,
        'variants': results_list,
        'failures': [{'name': n, 'reason': r} for n, r in failures],
        'best_variant': best_variant,
        'best_win_rate': round(best_win_rate, 4),
        'target_70_met': target_70_met,
        'combined_ensemble': ensemble_entry,
        'recommendation': recommendation,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'   Report: {OUTPUT_PATH}')

    # ---- Summary table ----
    print()
    print('=== Ensemble Search Results ===')
    print(f'  Target met (WR > 70%): {"YES" if target_70_met else "NO"}')
    print()

    if baseline_metrics:
        print(f'  {"Baseline":30s}  WR={baseline_metrics["win_rate"]:.2%}  '
              f'Sh={baseline_metrics["sharpe"]:.2f}  '
              f'MDD={baseline_metrics["max_drawdown"]:.2%}  '
              f'N={baseline_metrics["n_windows"]}')

    for r in results_list:
        print(f'  {r["name"]:30s}  WR={r["win_rate"]:.2%}  '
              f'Sh={r["sharpe"]:.2f}  '
              f'MDD={r["max_drawdown"]:.2%}  '
              f'N={r["n_windows"]}')

    if combined_result:
        print(f'  {"COMBINED_ENSEMBLE":30s}  WR={combined_result["win_rate"]:.2%}  '
              f'Sh={combined_result["sharpe"]:.2f}  '
              f'MDD={combined_result["max_drawdown"]:.2%}  '
              f'N={combined_result["n_windows"]}')

    if failures:
        print()
        print('  Failed variants:')
        for n, r in failures:
            print(f'    {n}: {r}')

    print()
    print(f'  Recommendation: {recommendation}')


if __name__ == '__main__':
    main()
