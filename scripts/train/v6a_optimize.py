#!/usr/bin/env python3
"""
V6a Volume Floor Threshold Optimization.

Tests V6a strategy with different volume floor thresholds and reports best params.

V6a: Cross-sectional volume-momentum strategy on 24 mainstream coins.
  - For each coin, compute average daily trading volume over trailing `vol_window`
  - Apply volume floor: exclude coins below cross-sectional percentile threshold
  - Select top quantile of remaining coins by volume
  - Weight positions by chosen scheme (market-cap / equal / inverse-vol)
  - Hold for `holding_period` days, then rebalance
  - Benchmark each window against BTC buy-and-hold

WFO-Lite: train=365d, test=63d, step=21d.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/v6a_optimize.py

Output: data/research/v6a_optimize_report.json

Read-only on data files. No secrets, no API calls.
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
# Paths and constants
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
OUTPUT_PATH = 'data/research/v6a_optimize_report.json'
COST_BPS = 15

# ---------------------------------------------------------------------------
# Mainstream coin universe (24 coins)
# ---------------------------------------------------------------------------
MAIN_SYMBOLS = frozenset([
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
    'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
    'AAVEUSDT', 'MKRUSDT',
])

# ---------------------------------------------------------------------------
# V6a fixed parameters
# ---------------------------------------------------------------------------
VOL_WINDOW = 60

# ---------------------------------------------------------------------------
# Parameter grids for optimization
# ---------------------------------------------------------------------------
PARAM_GRID = {
    'volume_floor': [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],   # cross-sectional percentile to filter out
    'volume_metric': ['raw', 'sqrt', 'log'],                   # transformation before rank
    'weighting': ['market_cap', 'equal', 'inverse_vol'],       # position weighting
    'quantile': [0.20, 0.28],                                   # top fraction to select
    'holding_period': [45, 50, 55, 60, 65, 70],                # rebalance interval (days)
}

# WFO-Lite parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def _parse_timestamp(ts_str: str) -> str:
    """Parse Binance daily kline timestamp to YYYY-MM-DD.

    Older data (~pre-2025) uses 13-digit ms timestamps.
    Newer data (~2025 onward) uses 16-digit microsecond timestamps.
    """
    ts = int(ts_str)
    if ts > 1e15:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_daily_data(symbol: str) -> dict:
    """Load daily kline data for *symbol*.

    Returns {'close': {date_str -> price}, 'volume': {date_str -> quote_volume_in_USDT}}.

    Quote volume (col 7) is used as the volume metric because it is
    invariant to unit splits/merges and serves as a market-cap proxy.
    """
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {'close': {}, 'volume': {}}

    closes: dict[str, float] = {}
    volumes: dict[str, float] = {}

    zip_files = sorted(f for f in os.listdir(kline_path) if f.endswith('.zip'))
    if not zip_files:
        return {'close': {}, 'volume': {}}

    for zf in zip_files:
        fpath = os.path.join(kline_path, zf)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) < 8:
                        continue
                    try:
                        date_str = _parse_timestamp(cols[0])
                        close = float(cols[4])
                        quote_vol = float(cols[7])  # USDT notional volume
                        closes[date_str] = close
                        volumes[date_str] = quote_vol
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue

    return {'close': closes, 'volume': volumes}


# ---------------------------------------------------------------------------
# Build aligned data matrices
# ---------------------------------------------------------------------------

def build_matrices() -> tuple:
    """Load aligned data for all mainstream symbols.

    Returns:
        close_matrix:  (n_sym, n_dates)  close prices, NaN for missing
        vol_matrix:    (n_sym, n_dates)  daily quote volume, NaN for missing
        all_dates:     sorted list of date strings
        symbols:       list of available symbol names
        btc_idx:       integer index of BTCUSDT (or None)
        n_dates:       number of dates
    """
    all_data: dict[str, dict] = {}
    for sym in MAIN_SYMBOLS:
        data = load_daily_data(sym)
        if data['close'] and data['volume']:
            all_data[sym] = data

    available = [s for s in MAIN_SYMBOLS if s in all_data]
    print(f'  Symbols with data: {len(available)} / {len(MAIN_SYMBOLS)}')
    for s in MAIN_SYMBOLS:
        if s not in all_data:
            print(f'    MISSING: {s}')

    all_dates = sorted(set(
        d for data in all_data.values() for d in data['close']
    ))
    n_dates = len(all_dates)
    n_sym = len(available)
    date_to_idx = {d: i for i, d in enumerate(all_dates)}

    print(f'  Date range: {all_dates[0]} to {all_dates[-1]}  ({n_dates} days)')

    close_matrix = np.full((n_sym, n_dates), np.nan)
    vol_matrix = np.full((n_sym, n_dates), np.nan)

    for si, sym in enumerate(available):
        data = all_data[sym]
        for d, p in data['close'].items():
            if d in date_to_idx:
                close_matrix[si, date_to_idx[d]] = p
        for d, v in data['volume'].items():
            if d in date_to_idx:
                vol_matrix[si, date_to_idx[d]] = v

    btc_idx = None
    for si, sym in enumerate(available):
        if sym == 'BTCUSDT':
            btc_idx = si
            break

    return close_matrix, vol_matrix, all_dates, available, btc_idx, n_dates


# ---------------------------------------------------------------------------
# Precompute trailing average volume
# ---------------------------------------------------------------------------

def precompute_trailing_volume(vol_matrix: np.ndarray) -> np.ndarray:
    """Rolling average of daily quote volume over VOL_WINDOW days.

    Returns (n_sym, n_dates) matrix — NaN where insufficient history.
    """
    n_sym, n_dates = vol_matrix.shape
    avg = np.full((n_sym, n_dates), np.nan)

    for si in range(n_sym):
        for di in range(VOL_WINDOW, n_dates):
            sl = vol_matrix[si, di - VOL_WINDOW + 1: di + 1]
            valid = np.isfinite(sl)
            if np.sum(valid) >= max(VOL_WINDOW // 2, 10):
                avg[si, di] = np.nanmean(sl)

    return avg


# ---------------------------------------------------------------------------
# Precompute rolling return volatility (for inverse-vol weighting)
# ---------------------------------------------------------------------------

def precompute_rolling_vol(close_matrix: np.ndarray, window: int = 21) -> np.ndarray:
    """Rolling 21-day return volatility for each symbol/date.

    Returns (n_sym, n_dates) matrix — NaN where insufficient history.
    """
    n_sym, n_dates = close_matrix.shape
    ret = np.full((n_sym, n_dates), np.nan)
    with np.errstate(invalid='ignore', divide='ignore'):
        ret[:, 1:] = close_matrix[:, 1:] / close_matrix[:, :-1] - 1.0

    vol = np.full((n_sym, n_dates), np.nan)
    for si in range(n_sym):
        for di in range(window, n_dates):
            sl = ret[si, di - window + 1: di + 1]
            valid = np.isfinite(sl)
            if np.sum(valid) >= max(window // 2, 5):
                vol[si, di] = np.nanstd(sl, ddof=1)

    return vol


# ---------------------------------------------------------------------------
# WFO evaluation for a single parameter combination
# ---------------------------------------------------------------------------

def evaluate_params(
    close_matrix: np.ndarray,
    trailing_vol_avg: np.ndarray,
    rolling_ret_vol: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
    params: dict,
) -> dict | None:
    """Run WFO-Lite for one V6a parameter combination.

    Collects all per-window returns across every fold and computes pooled
    metrics.  Returns None if no valid windows exist.

    Metrics returned:
        win_rate, mean_return, sharpe, max_drawdown,
        outperform_btc_rate, n_windows, n_folds
    """
    vf = params['volume_floor']
    vm = params['volume_metric']
    w = params['weighting']
    q = params['quantile']
    hp = params['holding_period']

    n_sym = len(symbols)

    # Storage across all windows and folds
    all_window_rets: list[float] = []
    all_window_btc: list[float] = []
    fold_rets: list[float] = []

    i = 0
    while i + TRAIN_DAYS + TEST_DAYS <= n_dates:
        test_start = i + TRAIN_DAYS
        test_end = min(test_start + TEST_DAYS, n_dates)

        test_range = np.arange(test_start, test_end)
        if len(test_range) < 10:
            i += STEP_DAYS
            continue

        # Rebalance points within the test window
        rebal_points = test_range[::hp]

        window_rets: list[float] = []
        window_btc: list[float] = []

        for ri in range(len(rebal_points) - 1):
            rebal_di = rebal_points[ri]
            hold_end_di = rebal_points[ri + 1]

            if hold_end_di >= n_dates or rebal_di < VOL_WINDOW:
                continue

            # ----- 1. Get trailing average volume for each coin -----
            raw_vol_at_date = trailing_vol_avg[:, rebal_di]  # (n_sym,) raw values

            # ----- 2. Valid coin mask -----
            valid_mask = np.isfinite(raw_vol_at_date) & (raw_vol_at_date > 0)
            n_valid = int(np.sum(valid_mask))
            if n_valid < 2:
                continue

            # ----- 3. Apply volume metric transformation -----
            metric_vals = raw_vol_at_date.copy()
            if vm == 'sqrt':
                metric_vals[valid_mask] = np.sqrt(metric_vals[valid_mask])
            elif vm == 'log':
                metric_vals[valid_mask] = np.log(metric_vals[valid_mask])
            # 'raw' — no transformation

            # ----- 4. Volume floor filter (on metric values) -----
            valid_metric_vals = metric_vals[valid_mask]
            valid_indices = np.where(valid_mask)[0]

            if vf > 0:
                floor_threshold = np.percentile(valid_metric_vals, vf * 100)
                above_floor = valid_metric_vals >= floor_threshold
                candidate_indices = valid_indices[above_floor]
                candidate_metrics = valid_metric_vals[above_floor]
            else:
                candidate_indices = valid_indices
                candidate_metrics = valid_metric_vals

            n_candidates = len(candidate_indices)
            if n_candidates < 2:
                continue

            # ----- 5. Select top quantile by (transformed) volume -----
            n_select = max(1, int(n_candidates * q))
            # Descending sort (highest volume first)
            sort_order = np.argsort(candidate_metrics)[::-1]
            selected_indices = candidate_indices[sort_order[:n_select]]
            n_selected = len(selected_indices)

            # ----- 6. Compute weights -----
            if w == 'equal':
                weights = np.ones(n_selected) / n_selected

            elif w == 'market_cap':
                # Use raw average volume as market-cap proxy
                mc = raw_vol_at_date[selected_indices]
                mc_ok = np.isfinite(mc) & (mc > 0)
                if np.sum(mc_ok) < 1:
                    weights = np.ones(n_selected) / n_selected
                else:
                    wts = np.where(mc_ok, mc, 0.0)
                    weights = wts / np.sum(wts)

            elif w == 'inverse_vol':
                # Weight inversely proportional to trailing return volatility
                rv = rolling_ret_vol[selected_indices, rebal_di]
                rv_ok = np.isfinite(rv) & (rv > 0)
                if np.sum(rv_ok) < 1:
                    weights = np.ones(n_selected) / n_selected
                else:
                    inv = np.where(rv_ok, 1.0 / rv, 0.0)
                    weights = inv / np.sum(inv)

            # ----- 7. Compute forward weighted return -----
            start_prices = close_matrix[selected_indices, rebal_di]
            end_prices = close_matrix[selected_indices, hold_end_di]

            price_ok = (
                np.isfinite(start_prices)
                & np.isfinite(end_prices)
                & (start_prices > 0)
            )
            n_price_ok = int(np.sum(price_ok))
            if n_price_ok < 1:
                continue

            fwd_rets = end_prices[price_ok] / start_prices[price_ok] - 1.0
            wts = weights[price_ok]
            wts = wts / np.sum(wts)

            gross = float(np.sum(wts * fwd_rets))
            net = gross - COST_BPS / 10000 * 2  # round-trip cost
            window_rets.append(net)

            # BTC benchmark
            btc_sp = close_matrix[btc_idx, rebal_di]
            btc_ep = close_matrix[btc_idx, hold_end_di]
            if (np.isfinite(btc_sp) and np.isfinite(btc_ep) and btc_sp > 0):
                window_btc.append(float(btc_ep / btc_sp - 1))
            else:
                window_btc.append(0.0)

        if window_rets:
            fold_rets.append(float(np.mean(window_rets)))
            all_window_rets.extend(window_rets)
            all_window_btc.extend(window_btc)

        i += STEP_DAYS

    if not all_window_rets:
        return None

    # ---- Pooled metrics across all windows ----
    pool = np.array(all_window_rets)
    btc_pool = np.array(all_window_btc)

    mean_return = float(np.mean(pool))
    win_rate = float(np.mean(pool > 0))
    outperform_btc = (
        float(np.mean(pool > btc_pool))
        if len(btc_pool) == len(pool) else 0.0
    )

    pool_std = float(np.std(pool, ddof=1))
    if pool_std > 0 and len(pool) > 1:
        ann_factor = 365.25 / hp
        sharpe = float(np.mean(pool) / pool_std * np.sqrt(ann_factor))
    else:
        sharpe = 0.0

    # Max drawdown on pooled cumulative returns
    cum = np.cumprod(1 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = (cum - running_max) / running_max
    max_dd = float(np.min(dd)) if len(dd) > 0 else 0.0

    return {
        'mean_return': round(mean_return, 6),
        'win_rate': round(win_rate, 4),
        'sharpe': round(sharpe, 4),
        'max_drawdown': round(max_dd, 4),
        'outperform_btc_rate': round(outperform_btc, 4),
        'n_windows': len(pool),
        'n_folds': len(fold_rets),
    }


# ---------------------------------------------------------------------------
# Grid evaluation
# ---------------------------------------------------------------------------

def generate_combinations() -> list[dict]:
    """Generate all parameter combinations from the grid."""
    keys = list(PARAM_GRID.keys())
    combos: list[dict] = []
    for values in itertools.product(*[PARAM_GRID[k] for k in keys]):
        combos.append(dict(zip(keys, values)))
    return combos


def run_evaluation(
    close_matrix: np.ndarray,
    trailing_vol_avg: np.ndarray,
    rolling_ret_vol: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
    combos: list[dict],
) -> list[tuple[dict, dict]]:
    """Evaluate all parameter combos, return sorted (params, metrics) by win_rate descending."""
    results: list[tuple[dict, dict]] = []
    n_total = len(combos)
    t_start = time.time()
    n_skipped = 0

    for idx, params in enumerate(combos):
        metrics = evaluate_params(
            close_matrix, trailing_vol_avg, rolling_ret_vol,
            all_dates, symbols, btc_idx, n_dates,
            params,
        )
        if metrics is not None:
            results.append((params, metrics))
        else:
            n_skipped += 1

        if (idx + 1) % 50 == 0 or idx == n_total - 1:
            elapsed = time.time() - t_start
            rate = (idx + 1) / elapsed if elapsed > 0 else 0
            done_pct = (idx + 1) * 100 // n_total
            print(f'    [{idx+1}/{n_total}] {done_pct}%  '
                  f'({rate:.1f} combos/s, {n_skipped} skipped)', flush=True)

    results.sort(key=lambda x: -x[1]['win_rate'])
    return results


# ---------------------------------------------------------------------------
# Report builder
# ---------------------------------------------------------------------------

def build_report(
    results: list[tuple[dict, dict]],
    combos: list[dict],
    all_dates: list[str],
    symbols: list[str],
    n_dates: int,
) -> dict:
    """Build the final report JSON."""
    top_results: list[dict] = []
    best_params: dict = {}
    best_metrics: dict = {}

    if results:
        best_params, best_metrics = results[0]
        for i in range(min(10, len(results))):
            p, m = results[i]
            top_results.append({
                'params': p,
                'win_rate': m['win_rate'],
                'mean_return': m['mean_return'],
                'sharpe': m['sharpe'],
                'max_drawdown': m['max_drawdown'],
                'outperform_btc_rate': m['outperform_btc_rate'],
                'n_windows': m['n_windows'],
                'n_folds': m['n_folds'],
            })

    # Per-dimension analysis: find best value for each dimension
    dim_analysis: dict[str, list[dict]] = {}
    for dim in PARAM_GRID:
        dim_analysis[dim] = []
        for val in PARAM_GRID[dim]:
            matched = [(p, m) for p, m in results if p.get(dim) == val]
            if matched:
                wr_vals = [mm['win_rate'] for _, mm in matched]
                mean_ret_vals = [mm['mean_return'] for _, mm in matched]
                dim_analysis[dim].append({
                    'value': val,
                    'mean_win_rate': round(float(np.mean(wr_vals)), 4),
                    'max_win_rate': round(float(np.max(wr_vals)), 4),
                    'mean_return': round(float(np.mean(mean_ret_vals)), 6),
                    'count': len(matched),
                })

    # Best per dimension (holding others fixed at best)
    best_per_dim: dict[str, dict] = {}
    for dim in PARAM_GRID:
        entries = dim_analysis.get(dim, [])
        if entries:
            best_entry = max(entries, key=lambda e: e['mean_win_rate'])
            best_per_dim[dim] = {
                'best_value': best_entry['value'],
                'mean_win_rate': best_entry['mean_win_rate'],
                'max_win_rate': best_entry['max_win_rate'],
            }

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'config': {
            'v6a_fixed_params': {
                'vol_window': VOL_WINDOW,
                'universe': '24 mainstream coins',
                'cost_bps': COST_BPS,
            },
            'param_grid': {k: list(v) for k, v in PARAM_GRID.items()},
            'n_symbols': len(symbols),
            'n_dates': n_dates,
            'period': f'{all_dates[0]} to {all_dates[-1]}',
            'wfo_mode': 'WFO-Lite',
            'train_days': TRAIN_DAYS,
            'test_days': TEST_DAYS,
            'step_days': STEP_DAYS,
        },
        'search_summary': {
            'total_combinations': len(combos),
            'valid_results': len(results),
        },
        'best_params': best_params,
        'best_metrics': best_metrics,
        'best_per_dimension': best_per_dim,
        'top_10_results': top_results,
    }

    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print('=== V6a Volume Floor Threshold Optimization ===')
    print(f'WFO-Lite: train={TRAIN_DAYS}d, test={TEST_DAYS}d, step={STEP_DAYS}d')
    print(f'V6a fixed: vol_window={VOL_WINDOW}d, mainstream coins only')
    print(f'Grid: {len(list(itertools.product(*PARAM_GRID.values())))} total combos')
    print()

    # ---- Step 1: Load data ----
    print('1. Loading mainstream coin data...')
    close_matrix, vol_matrix, all_dates, symbols, btc_idx, n_dates = build_matrices()

    if btc_idx is None:
        print('ERROR: BTCUSDT not found in mainstream symbols')
        sys.exit(1)

    if n_dates < TRAIN_DAYS + TEST_DAYS:
        print(f'ERROR: Insufficient data ({n_dates} days, need {TRAIN_DAYS + TEST_DAYS})')
        sys.exit(1)

    # ---- Step 2: Precompute trailing volume averages ----
    print('2. Precomputing trailing volume averages (window=60d)...')
    t0 = time.time()
    trailing_vol_avg = precompute_trailing_volume(vol_matrix)
    t1 = time.time()
    print(f'   Done in {t1 - t0:.1f}s')

    # ---- Step 3: Precompute rolling return volatility ----
    print('3. Precomputing rolling return volatility (window=21d)...')
    rolling_ret_vol = precompute_rolling_vol(close_matrix, window=21)
    t2 = time.time()
    print(f'   Done in {t2 - t1:.1f}s')

    # ---- Step 4: Generate parameter combinations ----
    print('4. Generating parameter combinations...')
    combos = generate_combinations()
    print(f'   {len(combos)} combinations')

    # ---- Step 5: Run evaluation ----
    print(f'5. Running WFO-Lite optimization...')
    t3 = time.time()
    results = run_evaluation(
        close_matrix, trailing_vol_avg, rolling_ret_vol,
        all_dates, symbols, btc_idx, n_dates,
        combos,
    )
    t4 = time.time()
    print(f'   Evaluation completed in {t4 - t3:.1f}s ({((t4 - t3) / 60):.1f} min)')

    # ---- Step 6: Build and write report ----
    print('6. Building report...')
    report = build_report(
        results, combos, all_dates, symbols, n_dates,
    )

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'   Report: {OUTPUT_PATH}')

    # ---- Print summary ----
    bp = report['best_params']
    bm = report['best_metrics']
    print()
    print('=== V6a Optimization Results ===')
    print(f'  Valid results: {len(results)} / {len(combos)}')
    print()
    print('  Best Parameters:')
    for k, v in bp.items():
        print(f'    {k}: {v}')
    print()
    print('  Best Metrics:')
    print(f'    win_rate:            {bm.get("win_rate", "N/A")}')
    print(f'    mean_return:         {bm.get("mean_return", "N/A")}')
    print(f'    sharpe:              {bm.get("sharpe", "N/A")}')
    print(f'    max_drawdown:        {bm.get("max_drawdown", "N/A")}')
    print(f'    outperform_btc_rate: {bm.get("outperform_btc_rate", "N/A")}')
    print(f'    n_windows:           {bm.get("n_windows", "N/A")}')
    print(f'    n_folds:             {bm.get("n_folds", "N/A")}')
    print()
    print('  Best Per Dimension:')
    for dim, info in report.get('best_per_dimension', {}).items():
        print(f'    {dim}: value={info["best_value"]}, mean_wr={info["mean_win_rate"]:.2%}')
    print()
    print(f'  Total runtime: {t4 - t0:.0f}s ({((t4 - t0) / 60):.1f} min)')


if __name__ == '__main__':
    main()
