#!/usr/bin/env python3
"""
V6a Adaptive: Make V6a adaptive to market conditions.

V6a base (FIXED): vol_window=60, quantile=0.20, holding=60d, volume_floor=0.50

Adaptive variants:
  A: Adaptive vol_window  — test [21, 30, 45, 60, 90] over past 365d, pick best
  B: Adaptive quantile    — test [0.10, 0.15, 0.20, 0.25, 0.30] over past 365d
  C: Adaptive holding     — test [30, 45, 60, 75, 90] over past 365d
  D: Adaptive volume_floor — test [0.3, 0.4, 0.5, 0.6] over past 365d
  E: FULL adaptive        — grid search ALL 4-param combos over past 365d, deploy winner

Each uses WFO-Lite: train=365d, deploy=60d, step=60d.

Output: data/research/v6a_adaptive_report.json

Read-only on ZIP files. No secrets, no API calls.
"""

import json
import os
import sys
import zipfile
import itertools
import time
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
OUTPUT_PATH = 'data/research/v6a_adaptive_report.json'
COST_BPS = 15

TRAIN_LOOKBACK = 365   # days to look back for parameter selection
DEPLOY_PERIOD = 60     # deployment holding period (except variant C)
STEP_DAYS = 60         # WFO step (same as deploy period for most variants)

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')

# 24 mainstream coins
MAIN_SYMBOLS = frozenset([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
    'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
    'AAVEUSDT', 'MKRUSDT',
])

# All vol_window values needed across all variants (cache building)
ALL_VOL_WINDOWS = sorted({21, 30, 45, 60, 90})

# Candidate values for each adaptive parameter
CANDIDATE_VOL_WINDOWS = [21, 30, 45, 60, 90]
CANDIDATE_QUANTILES = [0.10, 0.15, 0.20, 0.25, 0.30]
CANDIDATE_HOLDINGS = [30, 45, 60, 75, 90]
CANDIDATE_VOLUME_FLOORS = [0.3, 0.4, 0.5, 0.6]

# Default V6a config
V6A_DEFAULT = {
    'vol_window': 60,
    'quantile': 0.20,
    'holding_period': 60,
    'volume_floor': 0.50,
}

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def discover_symbols(max_symbols: int = 50) -> list[str]:
    """Return top *max_symbols* symbols by monthly ZIP count."""
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

    Returns (closes, volumes) dicts keyed by date string.
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

def build_matrices() -> tuple:
    """Load data for 24 mainstream symbols, build aligned matrices.

    Returns:
        close_matrix:   (n_sym, n_dates)  close prices
        volume_matrix:  (n_sym, n_dates)  daily volumes (0 for missing)
        ret_matrix:     (n_sym, n_dates)  daily returns, NaN missing
        vol_windows:    np.array of int window sizes
        all_dates:      sorted date string list
        btc_idx:        index of BTCUSDT
        n_dates:        int
        sym_indices:    np.array of mainstream symbol indices in [0, n_sym)
    """
    symbols = sorted(MAIN_SYMBOLS)
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

    vol_windows = np.array(ALL_VOL_WINDOWS, dtype=int)
    sym_indices = np.arange(n_sym, dtype=int)

    return (close_matrix, volume_matrix, ret_matrix, vol_windows,
            all_dates, btc_idx, n_dates, sym_indices)


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

    print('    Vol precompute: 100%')
    return vol_cache


# ---------------------------------------------------------------------------
# Core V6a evaluation on a date range (used for parameter selection training)
# ---------------------------------------------------------------------------

def evaluate_v6a_on_range(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    range_start_di: int,
    range_end_di: int,
    params: dict,
) -> dict | None:
    """Run V6a strategy over date range [range_start_di, range_end_di).

    Rebalances happen every params['holding_period'] days within the range,
    starting after one vol_window warmup.

    Returns dict {sharpe, win_rate, mean_return, outperform_btc_rate,
                  n_windows, all_rets, all_btc_rets} or None.
    """
    vw = params['vol_window']
    hp = params['holding_period']
    q = params['quantile']
    vf = params['volume_floor']

    # Find vol_window index in cache
    vw_idx = int(np.where(vol_windows == vw)[0][0])

    # Build rebalance points within range
    first_rebal = range_start_di + vw
    if first_rebal >= range_end_di - hp:
        return None

    rebal_points = list(range(first_rebal, range_end_di, hp))
    if len(rebal_points) < 2:
        return None

    window_rets: list[float] = []
    window_btc: list[float] = []

    for ri in range(len(rebal_points) - 1):
        rebal_di = rebal_points[ri]
        hold_end_di = rebal_points[ri + 1]

        if hold_end_di >= close_matrix.shape[1]:
            continue

        # ---- Vol data for all mainstream symbols ----
        vols = vol_cache[vw_idx, sym_indices, rebal_di]
        valid_mask = np.isfinite(vols) & (vols > 0)
        n_valid = int(np.sum(valid_mask))

        if n_valid < 3:
            continue

        valid_syms = sym_indices[valid_mask]
        valid_vols = vols[valid_mask]

        # ---- Volume floor filter (V6a) ----
        volumes_at_rebal = volume_matrix[valid_syms, rebal_di]
        vol_finite = np.isfinite(volumes_at_rebal) & (volumes_at_rebal > 0)
        n_vol_finite = int(np.sum(vol_finite))

        if n_vol_finite >= 2:
            vol_threshold = float(
                np.percentile(volumes_at_rebal[vol_finite], vf * 100)
            )
            above_floor = vol_finite & (volumes_at_rebal >= vol_threshold)
            n_above = int(np.sum(above_floor))
        else:
            above_floor = np.ones(n_valid, dtype=bool)
            n_above = n_valid

        if n_above < 3:
            continue

        filtered_syms = valid_syms[above_floor]
        filtered_vols = valid_vols[above_floor]

        # ---- Bottom quantile by vol ----
        n_long = max(1, int(n_above * q))
        sort_order = np.argsort(filtered_vols)
        selected = filtered_syms[sort_order[:n_long]]

        # ---- Forward return with market-cap weights ----
        start_prices = close_matrix[selected, rebal_di]
        end_prices = close_matrix[selected, hold_end_di]
        price_valid = (
            np.isfinite(start_prices)
            & np.isfinite(end_prices)
            & (start_prices > 0)
        )
        n_pv = int(np.sum(price_valid))

        if n_pv < 1:
            continue

        fwd_rets = end_prices[price_valid] / start_prices[price_valid] - 1.0
        sel_volumes = volume_matrix[selected[price_valid], rebal_di]
        vv = np.isfinite(sel_volumes) & (sel_volumes > 0)
        n_vv = int(np.sum(vv))

        if n_vv > 0:
            sqrt_vols = np.sqrt(sel_volumes[vv])
            weights = np.zeros(n_pv)
            weights[vv] = sqrt_vols / float(np.sum(sqrt_vols))
        else:
            weights = np.ones(n_pv) / n_pv

        gross = float(np.sum(weights * fwd_rets))
        net = gross - COST_BPS / 10000 * 2

        window_rets.append(net)

        # BTC benchmark
        btc_sp = close_matrix[btc_idx, rebal_di]
        btc_ep = close_matrix[btc_idx, hold_end_di]
        if np.isfinite(btc_sp) and np.isfinite(btc_ep) and btc_sp > 0:
            window_btc.append(float(btc_ep / btc_sp - 1))
        else:
            window_btc.append(0.0)

    if len(window_rets) < 2:
        return None

    # ---- Metrics ----
    pool = np.array(window_rets)
    btc_pool = np.array(window_btc)

    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    if std_ret > 0:
        ann_factor = 365.25 / hp
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
    else:
        sharpe = 0.0

    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) else 0.0
    )

    return {
        'sharpe': sharpe,
        'win_rate': win_rate,
        'mean_return': mean_ret,
        'outperform_btc_rate': outperform,
        'n_windows': len(pool),
        'all_rets': window_rets,
        'all_btc_rets': window_btc,
    }


# ---------------------------------------------------------------------------
# Deploy V6a for a single holding period
# ---------------------------------------------------------------------------

def deploy_v6a_one_period(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    rebal_di: int,
    hold_end_di: int,
    params: dict,
) -> tuple[float, float] | None:
    """Deploy V6a for one holding period. Returns (net_return, btc_return)."""
    vw = params['vol_window']
    q = params['quantile']
    vf = params['volume_floor']

    vw_idx = int(np.where(vol_windows == vw)[0][0])

    # Vol data
    vols = vol_cache[vw_idx, sym_indices, rebal_di]
    valid_mask = np.isfinite(vols) & (vols > 0)
    n_valid = int(np.sum(valid_mask))

    if n_valid < 3:
        return None

    valid_syms = sym_indices[valid_mask]
    valid_vols = vols[valid_mask]

    # Volume floor
    volumes_at_rebal = volume_matrix[valid_syms, rebal_di]
    vol_finite = np.isfinite(volumes_at_rebal) & (volumes_at_rebal > 0)
    n_vol_finite = int(np.sum(vol_finite))

    if n_vol_finite >= 2:
        vol_threshold = float(
            np.percentile(volumes_at_rebal[vol_finite], vf * 100)
        )
        above_floor = vol_finite & (volumes_at_rebal >= vol_threshold)
        n_above = int(np.sum(above_floor))
    else:
        above_floor = np.ones(n_valid, dtype=bool)
        n_above = n_valid

    if n_above < 3:
        return None

    filtered_syms = valid_syms[above_floor]
    filtered_vols = valid_vols[above_floor]

    # Bottom quantile
    n_long = max(1, int(n_above * q))
    sort_order = np.argsort(filtered_vols)
    selected = filtered_syms[sort_order[:n_long]]

    # Forward return
    start_prices = close_matrix[selected, rebal_di]
    end_prices = close_matrix[selected, hold_end_di]
    price_valid = (
        np.isfinite(start_prices)
        & np.isfinite(end_prices)
        & (start_prices > 0)
    )
    n_pv = int(np.sum(price_valid))

    if n_pv < 1:
        return None

    fwd_rets = end_prices[price_valid] / start_prices[price_valid] - 1.0
    sel_volumes = volume_matrix[selected[price_valid], rebal_di]
    vv = np.isfinite(sel_volumes) & (sel_volumes > 0)
    n_vv = int(np.sum(vv))

    if n_vv > 0:
        sqrt_vols = np.sqrt(sel_volumes[vv])
        weights = np.zeros(n_pv)
        weights[vv] = sqrt_vols / float(np.sum(sqrt_vols))
    else:
        weights = np.ones(n_pv) / n_pv

    gross = float(np.sum(weights * fwd_rets))
    net = gross - COST_BPS / 10000 * 2

    # BTC benchmark
    btc_sp = close_matrix[btc_idx, rebal_di]
    btc_ep = close_matrix[btc_idx, hold_end_di]
    if np.isfinite(btc_sp) and np.isfinite(btc_ep) and btc_sp > 0:
        btc_ret = float(btc_ep / btc_sp - 1)
    else:
        btc_ret = 0.0

    return (net, btc_ret)


# ---------------------------------------------------------------------------
# Find best parameter candidate over a training window
# ---------------------------------------------------------------------------

def find_best_param_single(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    train_start_di: int,
    train_end_di: int,
    candidate_values: list,
    param_name: str,
    fixed_params: dict,
) -> tuple:
    """Evaluate *candidate_values* for *param_name* on training window.

    Returns (best_value, {value: metrics_dict}) or (default_val, {}).
    """
    results: dict = {}

    for val in candidate_values:
        params = dict(fixed_params)
        params[param_name] = val

        metrics = evaluate_v6a_on_range(
            close_matrix, volume_matrix, ret_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            train_start_di, train_end_di,
            params,
        )
        if metrics is not None and metrics['n_windows'] >= 2:
            results[val] = metrics

    if not results:
        return fixed_params[param_name], results

    # Rank by Sharpe, then win rate as tiebreaker
    def _score(val):
        m = results[val]
        # Give a floor of -5 to avoid degenerate selection
        return (m['sharpe'] if m['sharpe'] > -5 else -5, m['win_rate'])

    best_val = max(results, key=_score)
    return best_val, results


def find_best_params_full(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    btc_idx: int,
    sym_indices: np.ndarray,
    train_start_di: int,
    train_end_di: int,
) -> tuple:
    """Grid search ALL 4-param combos over training window.

    Returns (best_params_dict, {param_tuple_str: metrics_dict}).
    """
    candidates_vw = CANDIDATE_VOL_WINDOWS
    candidates_q = CANDIDATE_QUANTILES
    candidates_hp = CANDIDATE_HOLDINGS
    candidates_vf = CANDIDATE_VOLUME_FLOORS

    results: dict = {}

    for vw, q, hp, vf in itertools.product(
        candidates_vw, candidates_q, candidates_hp, candidates_vf
    ):
        # Skip invalid: holding must be >= vol_window
        if hp < vw:
            continue
        # Skip invalid: training window too short for this combo
        # Need at least 2 rebalances in training + warmup
        if train_end_di - train_start_di < vw + 2 * hp:
            continue

        params = {
            'vol_window': vw,
            'quantile': q,
            'holding_period': hp,
            'volume_floor': vf,
        }

        metrics = evaluate_v6a_on_range(
            close_matrix, volume_matrix, ret_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            train_start_di, train_end_di,
            params,
        )
        if metrics is not None and metrics['n_windows'] >= 2:
            key = f'vw={vw}_q={q:.2f}_hp={hp}_vf={vf:.1f}'
            results[key] = {'params': params, 'metrics': metrics}

    if not results:
        return dict(V6A_DEFAULT), results

    def _score(item):
        # item is (key, value) where value = {'params': ..., 'metrics': ...}
        m = item[1]['metrics']
        return (m['sharpe'] if m['sharpe'] > -5 else -5, m['win_rate'])

    best_key = max(results.items(), key=_score)[0]
    return dict(results[best_key]['params']), results


# ---------------------------------------------------------------------------
# WFO-style runner for a single adaptive variant
# ---------------------------------------------------------------------------

def run_adaptive_variant(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    btc_idx: int,
    sym_indices: np.ndarray,
    n_dates: int,
    variant_name: str,
    param_name: str | None,
    candidate_values: list | None,
    fixed_params: dict,
    deploy_holding: int = DEPLOY_PERIOD,
) -> dict:
    """Run a WFO-Lite adaptive variant.

    For variant A-D: adapt a single param, keep others fixed.
    For variant E (param_name=None, candidate_values=None): full grid search.

    Returns dict with deployment results and fold-by-fold details.
    """
    folds: list[dict] = []
    all_deploy_rets: list[float] = []
    all_deploy_btc: list[float] = []
    selected_history: list = []

    # First fold starts after train_lookback days
    first_fold_start = TRAIN_LOOKBACK
    # We need at least one deploy period after training
    i = first_fold_start
    while i + deploy_holding <= n_dates:
        train_start = i - TRAIN_LOOKBACK
        train_end = i
        deploy_start = i
        deploy_end = i + deploy_holding

        if deploy_end > n_dates:
            break

        train_str = f'{all_dates[train_start]} ~ {all_dates[train_end - 1]}'
        deploy_str = f'{all_dates[deploy_start]} ~ {all_dates[deploy_end - 1]}'
        rebal_date = all_dates[deploy_start]

        # ---- Parameter selection on training window ----
        if param_name is None and candidate_values is None:
            # No search — use fixed_params directly (baseline)
            best_params = dict(fixed_params)
            selection_results = {}
        elif param_name is None:
            # FULL adaptive (variant E)
            best_params, selection_results = find_best_params_full(
                close_matrix, volume_matrix, ret_matrix,
                vol_cache, vol_windows,
                btc_idx, sym_indices,
                train_start, train_end,
            )
        else:
            best_val, selection_results = find_best_param_single(
                close_matrix, volume_matrix, ret_matrix,
                vol_cache, vol_windows,
                btc_idx, sym_indices,
                train_start, train_end,
                candidate_values, param_name, fixed_params,
            )
            best_params = dict(fixed_params)
            best_params[param_name] = best_val

        # ---- Deploy best params for one holding period ----
        result = deploy_v6a_one_period(
            close_matrix, volume_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            deploy_start, deploy_end,
            best_params,
        )

        deploy_ret = None
        deploy_btc = None
        if result is not None:
            deploy_ret, deploy_btc = result
            all_deploy_rets.append(deploy_ret)
            all_deploy_btc.append(deploy_btc)

        # ---- Record fold ----
        fold = {
            'rebalance_date': rebal_date,
            'train_range': train_str,
            'deploy_range': deploy_str,
            'best_params': {k: (round(v, 4) if isinstance(v, float) else v)
                            for k, v in best_params.items()},
            'deploy_return': deploy_ret,
            'deploy_btc_return': deploy_btc,
        }

        if param_name is not None:
            # Single-param: record training scores per candidate
            training_scores = {}
            for val, metrics in selection_results.items():
                training_scores[str(val)] = {
                    'sharpe': round(metrics['sharpe'], 4),
                    'win_rate': round(metrics['win_rate'], 4),
                    'mean_return': round(metrics['mean_return'], 6),
                    'n_windows': metrics['n_windows'],
                }
            fold['selected_value'] = best_params[param_name]
            fold['training_scores'] = training_scores
            selected_history.append(best_params[param_name])
        else:
            # Full grid: store top-5 training combos
            sorted_results = sorted(
                selection_results.items(),
                key=lambda x: (-x[1]['metrics']['sharpe'],
                               -x[1]['metrics']['win_rate'])
            )
            top5 = []
            for key, data in sorted_results[:5]:
                top5.append({
                    'params': data['params'],
                    'sharpe': round(data['metrics']['sharpe'], 4),
                    'win_rate': round(data['metrics']['win_rate'], 4),
                    'n_windows': data['metrics']['n_windows'],
                })
            fold['top5_training_combos'] = top5
            fold['n_training_combos_evaluated'] = len(selection_results)

        folds.append(fold)

        i += deploy_holding

    # ---- Pooled deployment metrics ----
    if not all_deploy_rets:
        return {
            'variant': variant_name,
            'folds': folds,
            'error': 'No valid deployment periods',
        }

    pool = np.array(all_deploy_rets)
    btc_pool = np.array(all_deploy_btc)

    n_deploy = len(pool)
    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    if std_ret > 0:
        ann_factor = 365.25 / deploy_holding
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
        ann_ret = float(mean_ret * ann_factor)
    else:
        sharpe = 0.0
        ann_ret = 0.0

    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) else 0.0
    )

    # Max drawdown
    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    # BTC pooled
    btc_mean = float(np.mean(btc_pool))
    btc_ann = float(btc_mean * ann_factor) if len(btc_pool) > 0 else 0.0

    # Selection frequency (for single-param variants)
    selection_freq: dict = {}
    if param_name is not None and selected_history:
        unique_vals = sorted(set(selected_history))
        for val in unique_vals:
            count = selected_history.count(val)
            selection_freq[str(val)] = {
                'count': count,
                'fraction': round(count / len(selected_history), 4),
            }

    return {
        'variant': variant_name,
        'n_deployments': n_deploy,
        'sharpe': round(sharpe, 4),
        'win_rate': round(win_rate, 4),
        'annualized_return': round(ann_ret, 6),
        'mean_window_return': round(mean_ret, 6),
        'max_drawdown': round(max_dd, 6),
        'outperform_btc_rate': round(outperform, 4),
        'btc_annualized_return': round(btc_ann, 6),
        'all_deploy_returns': [round(r, 6) for r in all_deploy_rets],
        'all_btc_returns': [round(r, 6) for r in all_deploy_btc],
        'folds': folds,
        'selection_frequency': selection_freq if param_name is not None else None,
        'adaptive_param': param_name,
    }


# ---------------------------------------------------------------------------
# Variant definitions
# ---------------------------------------------------------------------------

VARIANT_CONFIGS = [
    {
        'name': 'A_adaptive_vol_window',
        'param_name': 'vol_window',
        'candidates': CANDIDATE_VOL_WINDOWS,
        'fixed_params': {k: v for k, v in V6A_DEFAULT.items()
                         if k != 'vol_window'},
        'deploy_holding': 60,
        'description': 'Adaptive vol_window — test [21,30,45,60,90] on past 365d',
    },
    {
        'name': 'B_adaptive_quantile',
        'param_name': 'quantile',
        'candidates': CANDIDATE_QUANTILES,
        'fixed_params': {k: v for k, v in V6A_DEFAULT.items()
                         if k != 'quantile'},
        'deploy_holding': 60,
        'description': 'Adaptive quantile — test [0.10,0.15,0.20,0.25,0.30] on past 365d',
    },
    {
        'name': 'C_adaptive_holding',
        'param_name': 'holding_period',
        'candidates': CANDIDATE_HOLDINGS,
        'fixed_params': {k: v for k, v in V6A_DEFAULT.items()
                         if k != 'holding_period'},
        'deploy_holding': None,  # varies per fold
        'description': 'Adaptive holding period — test [30,45,60,75,90] on past 365d',
    },
    {
        'name': 'D_adaptive_volume_floor',
        'param_name': 'volume_floor',
        'candidates': CANDIDATE_VOLUME_FLOORS,
        'fixed_params': {k: v for k, v in V6A_DEFAULT.items()
                         if k != 'volume_floor'},
        'deploy_holding': 60,
        'description': 'Adaptive volume floor — test [0.3,0.4,0.5,0.6] on past 365d',
    },
    {
        'name': 'E_full_adaptive',
        'param_name': None,
        'candidates': None,
        'fixed_params': {},
        'deploy_holding': None,  # varies per fold
        'description': 'FULL adaptive — grid search ALL 4-param combos, deploy winner',
    },
]


# ---------------------------------------------------------------------------
# Variant C and E: adaptive holding period requires special handling
# since deploy_holding varies per fold
# ---------------------------------------------------------------------------

def run_variant_c_adaptive_holding(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    btc_idx: int,
    sym_indices: np.ndarray,
    n_dates: int,
) -> dict:
    """Variant C: adaptive holding period.

    Each fold selects the best holding_period from training, then
    deploys for that holding_period. Next fold starts at the end
    of the previous deployment.
    """
    folds: list[dict] = []
    all_deploy_rets: list[float] = []
    all_deploy_btc: list[float] = []
    selected_history: list[int] = []

    fixed_params = {k: v for k, v in V6A_DEFAULT.items()
                    if k != 'holding_period'}

    i = TRAIN_LOOKBACK
    while i < n_dates:
        train_start = i - TRAIN_LOOKBACK
        train_end = i

        # Find best holding_period
        results: dict = {}
        for hp in CANDIDATE_HOLDINGS:
            params = dict(fixed_params)
            params['holding_period'] = hp

            metrics = evaluate_v6a_on_range(
                close_matrix, volume_matrix, ret_matrix,
                vol_cache, vol_windows,
                btc_idx, sym_indices,
                train_start, train_end,
                params,
            )
            if metrics is not None and metrics['n_windows'] >= 2:
                results[hp] = metrics

        if not results:
            # Fallback to default VI
            best_hp = V6A_DEFAULT['holding_period']
        else:
            def _score_hp(hp):
                m = results[hp]
                return (m['sharpe'] if m['sharpe'] > -5 else -5, m['win_rate'])
            best_hp = max(results, key=_score_hp)

        # Deploy for best_hp days
        deploy_start = i
        deploy_end = i + best_hp

        if deploy_end > n_dates:
            break

        best_params = dict(fixed_params)
        best_params['holding_period'] = best_hp

        result = deploy_v6a_one_period(
            close_matrix, volume_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            deploy_start, deploy_end,
            best_params,
        )

        deploy_ret = None
        deploy_btc = None
        if result is not None:
            deploy_ret, deploy_btc = result
            all_deploy_rets.append(deploy_ret)
            all_deploy_btc.append(deploy_btc)

        train_str = f'{all_dates[train_start]} ~ {all_dates[train_end - 1]}'
        deploy_str = f'{all_dates[deploy_start]} ~ {all_dates[deploy_end - 1]}'

        fold = {
            'rebalance_date': all_dates[deploy_start],
            'train_range': train_str,
            'deploy_range': deploy_str,
            'best_params': {'holding_period': best_hp},
            'deploy_return': deploy_ret,
            'deploy_btc_return': deploy_btc,
            'selected_value': best_hp,
            'training_scores': {
                str(hp): {
                    'sharpe': round(m['sharpe'], 4),
                    'win_rate': round(m['win_rate'], 4),
                    'mean_return': round(m['mean_return'], 6),
                    'n_windows': m['n_windows'],
                }
                for hp, m in results.items()
            },
        }
        folds.append(fold)
        selected_history.append(best_hp)

        i += best_hp  # step by selected holding period

    if not all_deploy_rets:
        return {
            'variant': 'C_adaptive_holding',
            'folds': folds,
            'error': 'No valid deployment periods',
        }

    # Pooled metrics (annualized by average holding period)
    pool = np.array(all_deploy_rets)
    btc_pool = np.array(all_deploy_btc)

    n_deploy = len(pool)
    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    avg_hp = float(np.mean(selected_history)) if selected_history else 60

    if std_ret > 0:
        ann_factor = 365.25 / avg_hp
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
        ann_ret = float(mean_ret * ann_factor)
    else:
        sharpe = 0.0
        ann_ret = 0.0

    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) else 0.0
    )

    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    btc_mean = float(np.mean(btc_pool))
    btc_ann = float(btc_mean * ann_factor) if len(btc_pool) > 0 else 0.0

    selection_freq = {}
    unique_vals = sorted(set(selected_history))
    for val in unique_vals:
        count = selected_history.count(val)
        selection_freq[str(val)] = {
            'count': count,
            'fraction': round(count / len(selected_history), 4),
        }

    return {
        'variant': 'C_adaptive_holding',
        'n_deployments': n_deploy,
        'sharpe': round(sharpe, 4),
        'win_rate': round(win_rate, 4),
        'annualized_return': round(ann_ret, 6),
        'mean_window_return': round(mean_ret, 6),
        'max_drawdown': round(max_dd, 6),
        'outperform_btc_rate': round(outperform, 4),
        'btc_annualized_return': round(btc_ann, 6),
        'avg_holding_period': round(avg_hp, 1),
        'all_deploy_returns': [round(r, 6) for r in all_deploy_rets],
        'all_btc_returns': [round(r, 6) for r in all_deploy_btc],
        'folds': folds,
        'selection_frequency': selection_freq,
        'adaptive_param': 'holding_period',
    }


def run_variant_e_full_adaptive(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    btc_idx: int,
    sym_indices: np.ndarray,
    n_dates: int,
) -> dict:
    """Variant E: FULL adaptive — holding period also adapts per fold."""
    folds: list[dict] = []
    all_deploy_rets: list[float] = []
    all_deploy_btc: list[float] = []
    selected_hps: list[int] = []

    i = TRAIN_LOOKBACK
    while i < n_dates:
        train_start = i - TRAIN_LOOKBACK
        train_end = i

        # Full grid search on training window
        best_params, selection_results = find_best_params_full(
            close_matrix, volume_matrix, ret_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            train_start, train_end,
        )

        deploy_hp = best_params['holding_period']
        deploy_start = i
        deploy_end = i + deploy_hp

        if deploy_end > n_dates:
            break

        result = deploy_v6a_one_period(
            close_matrix, volume_matrix,
            vol_cache, vol_windows,
            btc_idx, sym_indices,
            deploy_start, deploy_end,
            best_params,
        )

        deploy_ret = None
        deploy_btc = None
        if result is not None:
            deploy_ret, deploy_btc = result
            all_deploy_rets.append(deploy_ret)
            all_deploy_btc.append(deploy_btc)

        train_str = f'{all_dates[train_start]} ~ {all_dates[train_end - 1]}'
        deploy_str = f'{all_dates[deploy_start]} ~ {all_dates[deploy_end - 1]}'

        # Top 5 training combos
        sorted_results = sorted(
            selection_results.items(),
            key=lambda x: (-x[1]['metrics']['sharpe'],
                           -x[1]['metrics']['win_rate'])
        )
        top5 = []
        for key, data in sorted_results[:5]:
            top5.append({
                'params': data['params'],
                'sharpe': round(data['metrics']['sharpe'], 4),
                'win_rate': round(data['metrics']['win_rate'], 4),
                'n_windows': data['metrics']['n_windows'],
            })

        fold = {
            'rebalance_date': all_dates[deploy_start],
            'train_range': train_str,
            'deploy_range': deploy_str,
            'best_params': {k: (round(v, 4) if isinstance(v, float) else v)
                            for k, v in best_params.items()},
            'deploy_return': deploy_ret,
            'deploy_btc_return': deploy_btc,
            'top5_training_combos': top5,
            'n_training_combos_evaluated': len(selection_results),
        }
        folds.append(fold)
        selected_hps.append(deploy_hp)

        i += deploy_hp

    if not all_deploy_rets:
        return {
            'variant': 'E_full_adaptive',
            'folds': folds,
            'error': 'No valid deployment periods',
        }

    pool = np.array(all_deploy_rets)
    btc_pool = np.array(all_deploy_btc)

    n_deploy = len(pool)
    win_rate = float(np.mean(pool > 0))
    mean_ret = float(np.mean(pool))
    std_ret = float(np.std(pool, ddof=1))

    avg_hp = float(np.mean(selected_hps)) if selected_hps else 60
    if std_ret > 0:
        ann_factor = 365.25 / avg_hp
        sharpe = float(mean_ret / std_ret * np.sqrt(ann_factor))
        ann_ret = float(mean_ret * ann_factor)
    else:
        sharpe = 0.0
        ann_ret = 0.0

    outperform = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) else 0.0
    )

    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    btc_mean = float(np.mean(btc_pool))
    btc_ann = float(btc_mean * ann_factor) if len(btc_pool) > 0 else 0.0

    return {
        'variant': 'E_full_adaptive',
        'n_deployments': n_deploy,
        'sharpe': round(sharpe, 4),
        'win_rate': round(win_rate, 4),
        'annualized_return': round(ann_ret, 6),
        'mean_window_return': round(mean_ret, 6),
        'max_drawdown': round(max_dd, 6),
        'outperform_btc_rate': round(outperform, 4),
        'btc_annualized_return': round(btc_ann, 6),
        'avg_holding_period': round(avg_hp, 1),
        'all_deploy_returns': [round(r, 6) for r in all_deploy_rets],
        'all_btc_returns': [round(r, 6) for r in all_deploy_btc],
        'folds': folds,
        'adaptive_param': 'all',
    }


# ---------------------------------------------------------------------------
# Baseline V6a (fixed params) for comparison
# ---------------------------------------------------------------------------

def run_baseline_v6a(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    vol_cache: np.ndarray,
    vol_windows: np.ndarray,
    all_dates: list[str],
    btc_idx: int,
    sym_indices: np.ndarray,
    n_dates: int,
) -> dict:
    """Run V6a with FIXED params (vol_window=60, quantile=0.20,
    holding=60, volume_floor=0.50) as WFO-Lite for comparison."""
    config = {
        'name': 'baseline_v6a_fixed',
        'param_name': None,
        'fixed_params': dict(V6A_DEFAULT),
        'deploy_holding': 60,
    }

    return run_adaptive_variant(
        close_matrix, volume_matrix, ret_matrix,
        vol_cache, vol_windows, all_dates,
        btc_idx, sym_indices, n_dates,
        'baseline_v6a_fixed',
        None, None, dict(V6A_DEFAULT),
        deploy_holding=60,
    )


# ---------------------------------------------------------------------------
# Report builder
# ---------------------------------------------------------------------------

def build_report(
    baseline: dict,
    variant_results: dict[str, dict],
    all_dates: list[str],
    n_sym: int,
    n_dates: int,
) -> dict:
    """Build the final JSON report."""
    variants = {}
    for name, result in variant_results.items():
        # Strip raw return arrays from output (keep only summary + folds)
        clean = {k: v for k, v in result.items()
                 if k not in ('all_deploy_returns', 'all_btc_returns')}
        variants[name] = clean

    # Summary comparison table
    comparison = []
    for name, result in variant_results.items():
        if 'error' in result:
            comparison.append({
                'variant': name,
                'error': result['error'],
            })
        else:
            comparison.append({
                'variant': name,
                'sharpe': result.get('sharpe', 0),
                'win_rate': result.get('win_rate', 0),
                'annualized_return': result.get('annualized_return', 0),
                'max_drawdown': result.get('max_drawdown', 0),
                'outperform_btc_rate': result.get('outperform_btc_rate', 0),
                'n_deployments': result.get('n_deployments', 0),
                'btc_annualized_return': result.get('btc_annualized_return', 0),
            })
    comparison.sort(key=lambda x: -x.get('sharpe', 0))

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'description': 'V6a Adaptive: WFO-Lite comparison of 5 adaptive variants vs fixed baseline',
        'config': {
            'n_symbols': n_sym,
            'n_dates': n_dates,
            'period': f'{all_dates[0]} to {all_dates[-1]}',
            'cost_bps': COST_BPS,
            'train_lookback_days': TRAIN_LOOKBACK,
            'default_v6a_config': V6A_DEFAULT,
            'candidates': {
                'vol_window': CANDIDATE_VOL_WINDOWS,
                'quantile': CANDIDATE_QUANTILES,
                'holding_period': CANDIDATE_HOLDINGS,
                'volume_floor': CANDIDATE_VOLUME_FLOORS,
            },
        },
        'baseline': {
            k: v for k, v in baseline.items()
            if k not in ('all_deploy_returns', 'all_btc_returns', 'folds')
        },
        'variants': variants,
        'comparison': comparison,
        'best_variant': comparison[0]['variant'] if comparison else None,
    }

    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print('=== V6a Adaptive ===')
    print('Making V6a adaptive to market conditions with 5 WFO-Lite variants')
    print()

    # ---- Step 1: Data loading ----
    print('1. Building matrices for 24 mainstream symbols...')
    (close_matrix, volume_matrix, ret_matrix, vol_windows,
     all_dates, btc_idx, n_dates, sym_indices) = build_matrices()

    if btc_idx is None:
        print('ERROR: BTCUSDT not found in symbols')
        sys.exit(1)

    # ---- Step 2: Vol precomputation ----
    print('2. Precomputing rolling volatility...')
    t0 = time.time()
    vol_cache = precompute_rolling_vol(ret_matrix, vol_windows)
    t1 = time.time()
    cache_mb = vol_cache.nbytes / 1024 / 1024
    print(f'   Vol cache: {vol_cache.shape}, {cache_mb:.1f} MB, '
          f'computed in {t1 - t0:.1f}s')
    print()

    # ---- Step 3: Baseline ----
    print('3. Running baseline V6a (fixed params)...')
    baseline = run_baseline_v6a(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
    )
    if 'error' in baseline:
        print(f'   ERROR: {baseline["error"]}')
    else:
        print(f'   Sharpe:     {baseline["sharpe"]:.2f}')
        print(f'   Win rate:   {baseline["win_rate"]:.2%}')
        print(f'   Ann return: {baseline["annualized_return"]:.2%}')
        print(f'   N deploys:  {baseline["n_deployments"]}')
    print()

    # ---- Step 4: Run adaptive variants ----
    variant_results: dict[str, dict] = {}

    # A: Adaptive vol_window
    print('4A. Running adaptive vol_window...')
    t_a0 = time.time()
    vc = VARIANT_CONFIGS[0]
    result_a = run_adaptive_variant(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
        vc['name'], vc['param_name'], vc['candidates'],
        vc['fixed_params'], vc['deploy_holding'],
    )
    t_a1 = time.time()
    variant_results['A_adaptive_vol_window'] = result_a
    if 'error' not in result_a:
        print(f'   Sharpe:     {result_a["sharpe"]:.2f}')
        print(f'   Win rate:   {result_a["win_rate"]:.2%}')
        print(f'   Ann return: {result_a["annualized_return"]:.2%}')
        print(f'   N deploys:  {result_a["n_deployments"]}')
        print(f'   Time:       {t_a1 - t_a0:.1f}s')
    else:
        print(f'   ERROR: {result_a["error"]}')

    # B: Adaptive quantile
    print('4B. Running adaptive quantile...')
    t_b0 = time.time()
    vc = VARIANT_CONFIGS[1]
    result_b = run_adaptive_variant(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
        vc['name'], vc['param_name'], vc['candidates'],
        vc['fixed_params'], vc['deploy_holding'],
    )
    t_b1 = time.time()
    variant_results['B_adaptive_quantile'] = result_b
    if 'error' not in result_b:
        print(f'   Sharpe:     {result_b["sharpe"]:.2f}')
        print(f'   Win rate:   {result_b["win_rate"]:.2%}')
        print(f'   Ann return: {result_b["annualized_return"]:.2%}')
        print(f'   N deploys:  {result_b["n_deployments"]}')
        print(f'   Time:       {t_b1 - t_b0:.1f}s')
    else:
        print(f'   ERROR: {result_b["error"]}')

    # C: Adaptive holding period
    print('4C. Running adaptive holding period...')
    t_c0 = time.time()
    result_c = run_variant_c_adaptive_holding(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
    )
    t_c1 = time.time()
    variant_results['C_adaptive_holding'] = result_c
    if 'error' not in result_c:
        print(f'   Sharpe:     {result_c["sharpe"]:.2f}')
        print(f'   Win rate:   {result_c["win_rate"]:.2%}')
        print(f'   Ann return: {result_c["annualized_return"]:.2%}')
        print(f'   N deploys:  {result_c["n_deployments"]}')
        print(f'   Avg HP:     {result_c["avg_holding_period"]:.0f}d')
        print(f'   Time:       {t_c1 - t_c0:.1f}s')
    else:
        print(f'   ERROR: {result_c["error"]}')

    # D: Adaptive volume floor
    print('4D. Running adaptive volume floor...')
    t_d0 = time.time()
    vc = VARIANT_CONFIGS[3]
    result_d = run_adaptive_variant(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
        vc['name'], vc['param_name'], vc['candidates'],
        vc['fixed_params'], vc['deploy_holding'],
    )
    t_d1 = time.time()
    variant_results['D_adaptive_volume_floor'] = result_d
    if 'error' not in result_d:
        print(f'   Sharpe:     {result_d["sharpe"]:.2f}')
        print(f'   Win rate:   {result_d["win_rate"]:.2%}')
        print(f'   Ann return: {result_d["annualized_return"]:.2%}')
        print(f'   N deploys:  {result_d["n_deployments"]}')
        print(f'   Time:       {t_d1 - t_d0:.1f}s')
    else:
        print(f'   ERROR: {result_d["error"]}')

    # E: FULL adaptive (all 4 params)
    print('4E. Running FULL adaptive (all params)...')
    print('     This may take several minutes...')
    t_e0 = time.time()
    result_e = run_variant_e_full_adaptive(
        close_matrix, volume_matrix, ret_matrix, vol_cache, vol_windows,
        all_dates, btc_idx, sym_indices, n_dates,
    )
    t_e1 = time.time()
    variant_results['E_full_adaptive'] = result_e
    if 'error' not in result_e:
        print(f'   Sharpe:     {result_e["sharpe"]:.2f}')
        print(f'   Win rate:   {result_e["win_rate"]:.2%}')
        print(f'   Ann return: {result_e["annualized_return"]:.2%}')
        print(f'   N deploys:  {result_e["n_deployments"]}')
        print(f'   Avg HP:     {result_e["avg_holding_period"]:.0f}d')
        print(f'   Time:       {t_e1 - t_e0:.1f}s')
    else:
        print(f'   ERROR: {result_e["error"]}')

    # ---- Step 5: Build report ----
    print()
    print('5. Building report...')
    report = build_report(
        baseline, variant_results, all_dates,
        len(MAIN_SYMBOLS), n_dates,
    )

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'   Report: {OUTPUT_PATH}')

    # ---- Summary ----
    print()
    print('=== Summary ===')
    print(f'  {"Variant":30s}  {"Sharpe":>8s}  {"WinRate":>8s}  '
          f'{"AnnRet":>8s}  {"OutpfBTC":>8s}  {"N":>4s}')
    print('  ' + '-' * 72)
    for cmp in report['comparison']:
        name = cmp['variant']
        sharp = cmp.get('sharpe', 0)
        wr = cmp.get('win_rate', 0)
        ann = cmp.get('annualized_return', 0)
        opf = cmp.get('outperform_btc_rate', 0)
        n = cmp.get('n_deployments', 0)
        print(f'  {name:30s}  {sharp:>8.2f}  {wr:>8.2%}  '
              f'{ann:>8.2%}  {opf:>8.2%}  {n:>4d}')

    best = report['best_variant']
    print()
    if best:
        print(f'  Best variant: {best}')
    else:
        print('  No valid variants')


if __name__ == '__main__':
    main()
