#!/usr/bin/env python3
"""
4h and 6h strategy test with WFO-Lite.

Strategies:
  A (4h_low_vol):      4h low-vol - realized_vol 42 bars, bottom 25%,
                        market-cap weight (trailing avg quote vol proxy),
                        weekly rebalance (42 bars = 7 days).
  B (4h_momentum):     4h momentum - ret_42bars, top 25%,
                        equal weight, weekly rebalance.
  C (6h_composite):    6h composite - volume_z + realized_vol, top 25%,
                        equal weight, weekly rebalance (28 bars = 7 days).
  D (4h_6h_combo):     Only buy if low-vol in BOTH 4h and 6h,
                        equal weight, weekly rebalance.

WFO-Lite: train=180d, test=30d, step=7d.
Cost: 15bps per leg (one leg per trade for long-only portfolios).

Data: Binance spot 4h and 6h klines (ZIP) from OpenAlice warehouse.
      4h: spot-all-usdt-klines-4h/spot/{SYMBOL}/4h/
      6h: spot-all-usdt-klines-6h/spot/{SYMBOL}/6h/
Output: data/research/strategy_4h_6h_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_4H_DIR = f'{BASE}/spot-all-usdt-klines-4h/spot'
KLINES_6H_DIR = f'{BASE}/spot-all-usdt-klines-6h/spot'
COST_BPS = 15
OUTPUT_PATH = (
    '/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice'
    '/data/research/strategy_4h_6h_report.json'
)

TOP_15_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT',
]

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')
STABLECOIN_SYMBOLS = frozenset([
    'USDCUSDT', 'USDTUSDT', 'DAIUSDT', 'TUSDUSDT', 'FDUSDUSDT',
    'BUSDUSDT', 'EURUSDT', 'GBPUSDT', 'AUDUSDT',
])

# WFO-Lite: calendar days → bar counts
BARS_PER_DAY_4H = 6  # 24h / 4h
BARS_PER_DAY_6H = 4  # 24h / 6h

WFO_TRAIN_BARS_4H = 180 * BARS_PER_DAY_4H   # 1080
WFO_TEST_BARS_4H = 30 * BARS_PER_DAY_4H     # 180
WFO_STEP_BARS_4H = 7 * BARS_PER_DAY_4H      # 42

WFO_TRAIN_BARS_6H = 180 * BARS_PER_DAY_6H   # 720
WFO_TEST_BARS_6H = 30 * BARS_PER_DAY_6H     # 120
WFO_STEP_BARS_6H = 7 * BARS_PER_DAY_6H      # 28

# Signal windows
VOL_WINDOW_4H = 42       # 42 4h bars = 7 days
MOM_WINDOW_4H = 42       # return over 42 4h bars
VOL_WINDOW_6H = 28       # 28 6h bars = 7 days
VOLUME_WINDOW_6H = 28    # volume z-score over 28 6h bars

REBAL_INTERVAL_4H = 42   # weekly on 4h data
REBAL_INTERVAL_6H = 28   # weekly on 6h data

# Holding periods defined same as rebal intervals (full-hold between rebalances)

STRATEGIES = {
    '4h_low_vol': {
        'rebal_bars': REBAL_INTERVAL_4H,
        'pct': 0.25,
        'direction': 'low',
        'weighting': 'mcap',
        'data_tf': '4h',
        'description': '4h realized_vol(42 bars), bottom 25%, mcap-weight, weekly rebal (42 bars)',
    },
    '4h_momentum': {
        'rebal_bars': REBAL_INTERVAL_4H,
        'pct': 0.25,
        'direction': 'high',
        'weighting': 'equal',
        'data_tf': '4h',
        'description': '4h ret_42bars, top 25%, equal-weight, weekly rebal (42 bars)',
    },
    '6h_composite': {
        'rebal_bars': REBAL_INTERVAL_6H,
        'pct': 0.25,
        'direction': 'high',
        'weighting': 'equal',
        'data_tf': '6h',
        'description': '6h volume_z + realized_vol composite, top 25%, equal-weight, weekly rebal (28 bars)',
    },
    '4h_6h_combo': {
        'rebal_bars': REBAL_INTERVAL_4H,
        'pct': 0.25,
        'direction': 'low',
        'weighting': 'equal',
        'data_tf': '4h_6h',
        'description': '4h+6h combo: buy if low-vol in BOTH, equal-weight, weekly rebal (42 bars 4h)',
    },
}

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


def load_klines_data(
    symbol: str,
    timeframe: str,
    klines_dir: str,
) -> dict[int, tuple[float, float, float]]:
    """Load 4h or 6h klines for a symbol from monthly ZIP files.

    Binance CSV columns (pipe-delimited in source, comma in files):
        open_time(ms), open, high, low, close, volume, close_time,
        quote_asset_volume, n_trades, taker_buy_volume, taker_quote_volume, ignore

    Args:
        symbol: Trading pair e.g. BTCUSDT.
        timeframe: '4h' or '6h'.
        klines_dir: Base directory for the kline type.

    Returns:
        dict[timestamp_ms] -> (close, volume, quote_volume)
    """
    tf_lower = timeframe.lower().replace(' ', '')
    kline_path = os.path.join(klines_dir, symbol, tf_lower)
    if not os.path.isdir(kline_path):
        return {}

    data: dict[int, tuple[float, float, float]] = {}
    for fname in sorted(os.listdir(kline_path)):
        if not fname.endswith('.zip'):
            continue
        fpath = os.path.join(kline_path, fname)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) >= 8:
                        try:
                            ts_ms = int(cols[0])
                            close = float(cols[4])
                            volume = float(cols[5])
                            quote_vol = float(cols[7])
                            data[ts_ms] = (close, volume, quote_vol)
                        except (ValueError, IndexError):
                            continue
        except Exception:
            continue

    return data


def load_all_data(
    symbols: list[str],
    klines_dir: str,
    timeframe: str,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[str]]:
    """Load and align klines for all symbols into a common bar matrix.

    Returns:
        (bar_index_ts, price_matrix, volume_matrix, valid_symbols)
        bar_index_ts: array of int (millisecond timestamps), shape (n_bars,).
        price_matrix: float64 array, shape (n_sym, n_bars). NaN for missing bars.
        volume_matrix: float64 array, shape (n_sym, n_bars). NaN for missing bars.
        quote_volume_matrix: float64 array, shape (n_sym, n_bars). NaN for missing.
        valid_symbols: list of symbols that returned data.
    """
    raw: dict[str, dict[int, tuple[float, float, float]]] = {}
    for sym in symbols:
        d = load_klines_data(sym, timeframe, klines_dir)
        if len(d) >= 100:  # require at least 100 bars
            raw[sym] = d

    if not raw:
        return np.array([], dtype=np.int64), np.array([]), np.array([]), np.array([]), []

    # Build common bar index (sorted union)
    all_ts_set: set[int] = set()
    for d in raw.values():
        all_ts_set.update(d.keys())
    bar_index = np.array(sorted(all_ts_set), dtype=np.int64)
    n_bars = len(bar_index)
    ts_to_idx = {ts: i for i, ts in enumerate(bar_index)}

    valid_symbols = list(raw.keys())
    n_sym = len(valid_symbols)
    price_mtx = np.full((n_sym, n_bars), np.nan, dtype=np.float64)
    volume_mtx = np.full((n_sym, n_bars), np.nan, dtype=np.float64)
    quote_vol_mtx = np.full((n_sym, n_bars), np.nan, dtype=np.float64)

    for si, sym in enumerate(valid_symbols):
        for ts, (close, volume, qvol) in raw[sym].items():
            idx = ts_to_idx.get(ts)
            if idx is not None:
                price_mtx[si, idx] = close
                volume_mtx[si, idx] = volume
                quote_vol_mtx[si, idx] = qvol

    return bar_index, price_mtx, volume_mtx, quote_vol_mtx, valid_symbols


# ---------------------------------------------------------------------------
# Signal computation helpers (bar-index based, on-aligned matrices)
# ---------------------------------------------------------------------------

def realized_vol(
    price_mtx: np.ndarray,
    bar_idx: int,
    window: int,
) -> np.ndarray:
    """Compute trailing realized vol for each symbol at a bar index.

    Args:
        price_mtx: shape (n_sym, n_bars), close prices, NaN for missing.
        bar_idx: current bar index (inclusive for signal lookback).
        window: number of PRICE observations to use.
                Returns are computed from adjacent closes.

    Returns:
        Array of vol values (n_sym,). NaN where insufficient data.
    """
    n_sym = price_mtx.shape[0]
    if bar_idx < window:
        return np.full(n_sym, np.nan)

    # Last (window+1) price values to get window returns
    prices = price_mtx[:, bar_idx - window : bar_idx + 1]  # (n_sym, window+1)

    with np.errstate(divide='ignore', invalid='ignore'):
        rets = np.diff(prices) / prices[:, :-1]  # (n_sym, window)

    vol = np.nanstd(rets, axis=1, ddof=1)
    # Require at least 60% non-NaN returns
    valid_count = np.sum(~np.isnan(rets), axis=1)
    vol[valid_count < max(2, int(window * 0.6))] = np.nan
    vol[vol <= 0] = np.nan
    return vol


def momentum_return(
    price_mtx: np.ndarray,
    bar_idx: int,
    window: int,
) -> np.ndarray:
    """Compute trailing cumulative return over *window* bars.

    ret = close[bar_idx] / close[bar_idx - window] - 1

    Returns:
        Array of returns (n_sym,). NaN where missing.
    """
    n_sym = price_mtx.shape[0]
    if bar_idx < window:
        return np.full(n_sym, np.nan)

    p_now = price_mtx[:, bar_idx]
    p_then = price_mtx[:, bar_idx - window]

    with np.errstate(divide='ignore', invalid='ignore'):
        ret = p_now / p_then - 1.0

    ret[~np.isfinite(ret)] = np.nan
    return ret


def average_volume(
    volume_mtx: np.ndarray,
    bar_idx: int,
    window: int,
) -> np.ndarray:
    """Compute trailing average volume over *window* bars.

    Returns:
        Array of mean volumes (n_sym,). NaN where insufficient data.
    """
    n_sym = volume_mtx.shape[0]
    if bar_idx < window:
        return np.full(n_sym, np.nan)

    vols = volume_mtx[:, bar_idx - window : bar_idx + 1]
    with np.errstate(invalid='ignore'):
        avg = np.nanmean(vols, axis=1)

    # Require >= 60% non-NaN
    valid_count = np.sum(~np.isnan(vols), axis=1)
    avg[valid_count < max(1, int(window * 0.6))] = np.nan
    return avg


def average_quote_volume(
    qvol_mtx: np.ndarray,
    bar_idx: int,
    window: int,
) -> np.ndarray:
    """Compute trailing average quote volume (proxy for market cap)."""
    n_sym = qvol_mtx.shape[0]
    if bar_idx < window:
        return np.full(n_sym, np.nan)

    qvols = qvol_mtx[:, bar_idx - window : bar_idx + 1]
    with np.errstate(invalid='ignore'):
        avg = np.nanmean(qvols, axis=1)
    valid_count = np.sum(~np.isnan(qvols), axis=1)
    avg[valid_count < max(1, int(window * 0.6))] = np.nan
    return avg


def cross_sectional_zscore(values: np.ndarray) -> np.ndarray:
    """Compute cross-sectional z-score, handling NaN.

    Returns z-scores; NaN if all values NaN or < 2 finite values.
    """
    n = np.sum(np.isfinite(values))
    if n < 2:
        return np.full_like(values, np.nan)

    mean = np.nanmean(values)
    std = np.nanstd(values, ddof=1)
    if std < 1e-12:
        return np.full_like(values, 0.0)

    return (values - mean) / std


# ---------------------------------------------------------------------------
# WFO fold execution – 4h strategies (A, B) and combo (D)
# ---------------------------------------------------------------------------

def run_fold_4h(
    price_mtx: np.ndarray,
    volume_mtx: np.ndarray,
    qvol_mtx: np.ndarray,
    bar_index: np.ndarray,
    symbols: list[str],
    train_start_idx: int,
    train_end_idx: int,
    test_start_idx: int,
    test_end_idx: int,
) -> dict[str, dict] | None:
    """Run one WFO fold for 4h-based strategies (A, B, D).

    D (4h+6h combo) is handled separately since it needs 6h data.
    This function handles A and B only.

    Args:
        All matrix arguments are for 4h data.
        train/test indices are in 4h bars.

    Returns:
        dict[strategy_key -> fold result dict] or None.
    """
    n_sym = price_mtx.shape[0]
    n_test_bars = test_end_idx - test_start_idx

    if n_test_bars < REBAL_INTERVAL_4H + 10:
        return None

    test_start_ts = bar_index[test_start_idx]
    test_end_ts = bar_index[test_end_idx - 1] if test_end_idx > test_start_idx else bar_index[test_start_idx]
    dt_start = datetime.fromtimestamp(test_start_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    dt_end = datetime.fromtimestamp(test_end_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    range_str = f'{dt_start} ~ {dt_end}'

    fold_results: dict[str, dict] = {}

    for name, cfg in STRATEGIES.items():
        if cfg['data_tf'] != '4h':
            continue  # skip 6h-only and combo here

        rebal_bars = cfg['rebal_bars']
        pct = cfg['pct']
        direction = cfg['direction']
        weighting = cfg['weighting']

        fold_rets: list[float] = []

        # Generate rebalance bar indices within test window
        first_rebal = test_start_idx + VOL_WINDOW_4H  # need signal history
        rebal_pts = list(range(first_rebal, test_end_idx, rebal_bars))
        if len(rebal_pts) < 2:
            continue

        for ri in range(len(rebal_pts) - 1):
            entry_idx = rebal_pts[ri]
            exit_idx = rebal_pts[ri + 1]

            if exit_idx >= test_end_idx:
                break

            # ---- Signal computation ----
            if name == '4h_low_vol':
                # realized_vol 42 bars
                vol = realized_vol(price_mtx, entry_idx, VOL_WINDOW_4H)
                scores = vol  # raw vol values

                # Select bottom pct by vol
                valid_mask = np.isfinite(scores)
                valid_indices = np.where(valid_mask)[0]
                if len(valid_indices) < 4:
                    continue

                valid_scores = scores[valid_indices]
                # Lower vol = better
                rank_order = np.argsort(valid_scores)
                n_select = max(1, int(len(valid_indices) * pct))
                selected_idx = valid_indices[rank_order[:n_select]]

                # Market-cap weighting
                if weighting == 'mcap':
                    mcap_proxy = average_quote_volume(qvol_mtx, entry_idx, VOL_WINDOW_4H)
                    proxy_vals = mcap_proxy[selected_idx]
                    total = np.nansum(proxy_vals)
                    if total <= 0:
                        continue
                    weights = proxy_vals / total
                else:
                    weights = np.full(len(selected_idx), 1.0 / len(selected_idx))

            elif name == '4h_momentum':
                # ret_42bars
                mom = momentum_return(price_mtx, entry_idx, MOM_WINDOW_4H)
                scores = mom

                valid_mask = np.isfinite(scores)
                valid_indices = np.where(valid_mask)[0]
                if len(valid_indices) < 4:
                    continue

                valid_scores = scores[valid_indices]
                # Higher return = better
                rank_order = np.argsort(valid_scores)[::-1]  # descending
                n_select = max(1, int(len(valid_indices) * pct))
                selected_idx = valid_indices[rank_order[:n_select]]
                weights = np.full(len(selected_idx), 1.0 / len(selected_idx))

            else:
                continue  # unknown 4h strategy

            # ---- Forward return computation ----
            entry_prices = price_mtx[selected_idx, entry_idx]
            exit_prices = price_mtx[selected_idx, exit_idx]

            with np.errstate(divide='ignore', invalid='ignore'):
                sym_rets = exit_prices / entry_prices - 1.0

            valid_ret = np.isfinite(sym_rets)
            if np.sum(valid_ret) < 1:
                continue

            gross_ret = float(np.nansum(weights * sym_rets))
            # Cost: 1 leg per trade (long-only) × 2 for rebalance (sell all + buy new)
            net_ret = gross_ret - COST_BPS / 10000000 * 2
            fold_rets.append(net_ret)

        if len(fold_rets) < 2:
            continue

        ret_arr = np.array(fold_rets)
        mean_ret = float(np.mean(ret_arr))
        std_ret = float(np.std(ret_arr, ddof=1)) if len(ret_arr) > 1 else 0.0
        win_rate = float(np.mean(ret_arr > 0))
        sharpe = (
            float(mean_ret / std_ret * np.sqrt(52))  # annualize: ~52 weeks
            if std_ret > 1e-12
            else 0.0
        )
        cum = np.cumprod(1 + ret_arr)
        running_max = np.maximum.accumulate(cum)
        drawdowns = (cum - running_max) / running_max
        max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

        fold_results[name] = {
            'train_range': f'bar_{train_start_idx} ~ bar_{train_end_idx}',
            'test_range': range_str,
            'n_windows': len(fold_rets),
            'mean_return': mean_ret,
            'std_return': std_ret,
            'win_rate': win_rate,
            'sharpe_window': sharpe,
            'max_drawdown': max_dd,
            'holding_period_returns': [float(r) for r in fold_rets],
        }

    return fold_results if fold_results else None


def run_fold_6h(
    price_mtx_6h: np.ndarray,
    volume_mtx_6h: np.ndarray,
    bar_index_6h: np.ndarray,
    symbols_6h: list[str],
    train_start_idx: int,
    train_end_idx: int,
    test_start_idx: int,
    test_end_idx: int,
) -> dict[str, dict] | None:
    """Run one WFO fold for the 6h composite strategy (C).

    C: volume_z + realized_vol composite, top 25%.

    Returns:
        dict or None.
    """
    n_test_bars = test_end_idx - test_start_idx
    if n_test_bars < REBAL_INTERVAL_6H + 10:
        return None

    test_start_ts = bar_index_6h[test_start_idx]
    test_end_ts = bar_index_6h[test_end_idx - 1] if test_end_idx > test_start_idx else bar_index_6h[test_start_idx]
    dt_start = datetime.fromtimestamp(test_start_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    dt_end = datetime.fromtimestamp(test_end_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    range_str = f'{dt_start} ~ {dt_end}'

    fold_rets: list[float] = []

    first_rebal = test_start_idx + VOL_WINDOW_6H
    rebal_pts = list(range(first_rebal, test_end_idx, REBAL_INTERVAL_6H))
    if len(rebal_pts) < 2:
        return None

    for ri in range(len(rebal_pts) - 1):
        entry_idx = rebal_pts[ri]
        exit_idx = rebal_pts[ri + 1]
        if exit_idx >= test_end_idx:
            break

        # ---- Signal: volume_z + realized_vol ----
        vol = realized_vol(price_mtx_6h, entry_idx, VOL_WINDOW_6H)
        avg_vol = average_volume(volume_mtx_6h, entry_idx, VOLUME_WINDOW_6H)

        # Composite: z-score(avg_vol) + z-score(vol)
        vol_z = cross_sectional_zscore(vol)
        avgvol_z = cross_sectional_zscore(avg_vol)
        composite = avgvol_z + vol_z  # both z-scores; NaN propagates

        valid_mask = np.isfinite(composite)
        valid_indices = np.where(valid_mask)[0]
        if len(valid_indices) < 4:
            continue

        valid_scores = composite[valid_indices]
        # Higher = better (top 25%)
        rank_order = np.argsort(valid_scores)[::-1]
        n_select = max(1, int(len(valid_indices) * 0.25))
        selected_idx = valid_indices[rank_order[:n_select]]
        weights = np.full(len(selected_idx), 1.0 / len(selected_idx))

        # Forward return
        entry_prices = price_mtx_6h[selected_idx, entry_idx]
        exit_prices = price_mtx_6h[selected_idx, exit_idx]
        with np.errstate(divide='ignore', invalid='ignore'):
            sym_rets = exit_prices / entry_prices - 1.0

        valid_ret = np.isfinite(sym_rets)
        if np.sum(valid_ret) < 1:
            continue

        w = weights[valid_ret] if len(weights) > np.sum(~valid_ret) else weights
        # Re-weight to sum to 1 using only valid weights
        w_subset = weights[valid_ret] if len(weights) > np.sum(~valid_ret) else np.ones(np.sum(valid_ret)) / np.sum(valid_ret)
        gross_ret = float(np.nansum(sym_rets[valid_ret] * w_subset)) if np.sum(valid_ret) > 0 else 0.0
        net_ret = gross_ret - COST_BPS / 10000000 * 2
        fold_rets.append(net_ret)

    if len(fold_rets) < 2:
        return None

    ret_arr = np.array(fold_rets)
    mean_ret = float(np.mean(ret_arr))
    std_ret = float(np.std(ret_arr, ddof=1)) if len(ret_arr) > 1 else 0.0
    win_rate = float(np.mean(ret_arr > 0))
    sharpe = (
        float(mean_ret / std_ret * np.sqrt(52))
        if std_ret > 1e-12
        else 0.0
    )
    cum = np.cumprod(1 + ret_arr)
    running_max = np.maximum.accumulate(cum)
    drawdowns = (cum - running_max) / running_max
    max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

    return {
        '6h_composite': {
            'train_range': f'bar_{train_start_idx} ~ bar_{train_end_idx}',
            'test_range': range_str,
            'n_windows': len(fold_rets),
            'mean_return': mean_ret,
            'std_return': std_ret,
            'win_rate': win_rate,
            'sharpe_window': sharpe,
            'max_drawdown': max_dd,
            'holding_period_returns': [float(r) for r in fold_rets],
        },
    }


def run_fold_combo(
    price_mtx_4h: np.ndarray,
    volume_mtx_4h: np.ndarray,
    price_mtx_6h: np.ndarray,
    vol_mtx_6h: np.ndarray,
    bar_index_4h: np.ndarray,
    bar_index_6h: np.ndarray,
    symbols_4h: list[str],
    symbols_6h: list[str],
    train_start_idx: int,
    train_end_idx: int,
    test_start_idx: int,
    test_end_idx: int,
) -> dict[str, dict] | None:
    """Run one WFO fold for the 4h+6h combo strategy (D).

    Only buy if a symbol is in the low-vol bottom 25% on BOTH timeframes.
    4h low-vol: realized_vol 42 bars.
    6h low-vol: realized_vol 28 bars.
    Rebalances on the 4h schedule.

    Returns:
        dict or None.
    """
    n_test_bars = test_end_idx - test_start_idx
    if n_test_bars < REBAL_INTERVAL_4H + 10:
        return None

    test_start_ts = bar_index_4h[test_start_idx]
    test_end_ts = bar_index_4h[test_end_idx - 1] if test_end_idx > test_start_idx else bar_index_4h[test_start_idx]
    dt_start = datetime.fromtimestamp(test_start_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    dt_end = datetime.fromtimestamp(test_end_ts / 1000000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M')
    range_str = f'{dt_start} ~ {dt_end}'

    fold_rets: list[float] = []

    first_rebal = test_start_idx + VOL_WINDOW_4H
    rebal_pts = list(range(first_rebal, test_end_idx, REBAL_INTERVAL_4H))
    if len(rebal_pts) < 2:
        return None

    # Build symbol index maps
    sym_4h = {s: i for i, s in enumerate(symbols_4h)}
    sym_6h = {s: i for i, s in enumerate(symbols_6h)}

    # Common symbols that exist in both datasets
    common_symbols = [s for s in symbols_4h if s in sym_6h]
    if len(common_symbols) < 4:
        return None

    for ri in range(len(rebal_pts) - 1):
        entry_idx_4h = rebal_pts[ri]
        exit_idx_4h = rebal_pts[ri + 1]
        if exit_idx_4h >= test_end_idx:
            break

        # 4h low-vol: select bottom 25%
        vol_4h = realized_vol(price_mtx_4h, entry_idx_4h, VOL_WINDOW_4H)
        valid_4h = np.isfinite(vol_4h) & (vol_4h > 0)
        valid_4h_indices = np.where(valid_4h)[0]
        if len(valid_4h_indices) < 4:
            continue

        vol_4h_valid = vol_4h[valid_4h_indices]
        n_sel_4h = max(1, int(len(valid_4h_indices) * 0.25))
        rank_4h = np.argsort(vol_4h_valid)  # ascending = low vol
        selected_4h_idx = set(valid_4h_indices[rank_4h[:n_sel_4h]])
        selected_4h_syms = {symbols_4h[i] for i in selected_4h_idx}

        # 6h low-vol: align entry_idx_4h to 6h index
        entry_ts = bar_index_4h[entry_idx_4h]
        # Find the 6h bar at or just before entry_ts
        # (6h bars align at 00:00, 06:00, 12:00, 18:00 UTC; 4h at 00,4,8,12,16,20)
        # Since both start at midnight, 00:00 and 12:00 bars align exactly.
        # Round entry_ts down to nearest 6h bar.
        from datetime import timedelta
        entry_dt = datetime.fromtimestamp(entry_ts / 1000000, tz=timezone.utc)
        # Round hour down to multiple of 6
        rounded_hour = (entry_dt.hour // 6) * 6
        rounded_dt = entry_dt.replace(hour=rounded_hour, minute=0, second=0, microsecond=0)
        rounded_ts = int(rounded_dt.timestamp() * 1000)

        # Find nearest 6h bar index <= entry_ts
        six_h_indices = np.where(bar_index_6h <= entry_ts)[0]
        if len(six_h_indices) == 0:
            continue
        six_h_idx = six_h_indices[-1]

        # Check we have enough 6h history
        if six_h_idx < VOL_WINDOW_6H:
            continue

        vol_6h = realized_vol(price_mtx_6h, six_h_idx, VOL_WINDOW_6H)
        valid_6h = np.isfinite(vol_6h) & (vol_6h > 0)
        valid_6h_indices = np.where(valid_6h)[0]
        if len(valid_6h_indices) < 4:
            continue

        vol_6h_valid = vol_6h[valid_6h_indices]
        n_sel_6h = max(1, int(len(valid_6h_indices) * 0.25))
        rank_6h = np.argsort(vol_6h_valid)
        selected_6h_idx = set(valid_6h_indices[rank_6h[:n_sel_6h]])
        selected_6h_syms = {symbols_6h[i] for i in selected_6h_idx}

        # Intersection: buy if low-vol in BOTH
        intersect_syms = selected_4h_syms & selected_6h_syms
        if len(intersect_syms) < 2:
            continue

        # Equal weight
        weights = np.full(len(intersect_syms), 1.0 / len(intersect_syms))

        # Compute forward returns
        sym_rets_list = []
        for sym in intersect_syms:
            si_4h = sym_4h[sym]
            ep = price_mtx_4h[si_4h, entry_idx_4h]
            xp = price_mtx_4h[si_4h, exit_idx_4h]
            if np.isfinite(ep) and np.isfinite(xp) and ep > 0:
                sym_rets_list.append(float(xp / ep - 1.0))

        if not sym_rets_list:
            continue

        gross_ret = float(np.mean(sym_rets_list))
        net_ret = gross_ret - COST_BPS / 10000000 * 2
        fold_rets.append(net_ret)

    if len(fold_rets) < 2:
        return None

    ret_arr = np.array(fold_rets)
    mean_ret = float(np.mean(ret_arr))
    std_ret = float(np.std(ret_arr, ddof=1)) if len(ret_arr) > 1 else 0.0
    win_rate = float(np.mean(ret_arr > 0))
    sharpe = (
        float(mean_ret / std_ret * np.sqrt(52))
        if std_ret > 1e-12
        else 0.0
    )
    cum = np.cumprod(1 + ret_arr)
    running_max = np.maximum.accumulate(cum)
    drawdowns = (cum - running_max) / running_max
    max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

    return {
        '4h_6h_combo': {
            'train_range': f'bar_{train_start_idx} ~ bar_{train_end_idx}',
            'test_range': range_str,
            'n_windows': len(fold_rets),
            'mean_return': mean_ret,
            'std_return': std_ret,
            'win_rate': win_rate,
            'sharpe_window': sharpe,
            'max_drawdown': max_dd,
            'holding_period_returns': [float(r) for r in fold_rets],
        },
    }


# ---------------------------------------------------------------------------
# Summary computation
# ---------------------------------------------------------------------------

def compute_strategy_summary(folds: list[dict]) -> dict:
    """Compute aggregate metrics across all folds for one strategy."""
    if not folds:
        return {
            'fold_count': 0,
            'mean_return': 0.0,
            'std_return': 0.0,
            'mean_win_rate': 0.0,
            'max_drawdown': 0.0,
            'pass_rate_above_0': 0.0,
            'global_win_rate': 0.0,
            'global_sharpe': 0.0,
            'global_n_holding_periods': 0,
        }

    fold_returns = [f['mean_return'] for f in folds]
    fold_win_rates = [f['win_rate'] for f in folds]
    fold_dds = [f['max_drawdown'] for f in folds]

    mean_ret = float(np.mean(fold_returns))
    std_ret = float(np.std(fold_returns, ddof=1)) if len(fold_returns) > 1 else 0.0

    # Global metrics from pooled holding period returns
    all_hp_returns = []
    for f in folds:
        all_hp_returns.extend(f.get('holding_period_returns', []))
    all_hp_arr = np.array(all_hp_returns)
    global_mean = float(np.mean(all_hp_arr)) if len(all_hp_arr) > 0 else 0.0
    global_std = float(np.std(all_hp_arr, ddof=1)) if len(all_hp_arr) > 1 else 0.0
    global_sharpe = (
        float(global_mean / global_std * np.sqrt(52))
        if global_std > 1e-12
        else 0.0
    )
    global_win_rate = float(np.mean(all_hp_arr > 0)) if len(all_hp_arr) > 0 else 0.0

    return {
        'fold_count': len(folds),
        'mean_return': mean_ret,
        'std_return': std_ret,
        'mean_win_rate': float(np.mean(fold_win_rates)),
        'max_drawdown': float(np.min(fold_dds)) if fold_dds else 0.0,
        'pass_rate_above_0': float(np.mean([f['mean_return'] > 0 for f in folds])),
        'global_win_rate': global_win_rate,
        'global_sharpe': global_sharpe,
        'global_n_holding_periods': len(all_hp_arr),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print('=== 4h+6h Strategy Test (WFO-Lite) ===')
    print()

    probes = [
        ('BTCUSDT', '4h'),
        ('ETHUSDT', '6h'),
    ]
    for sym, tf in probes:
        if tf == '4h':
            d = load_klines_data(sym, '4h', KLINES_4H_DIR)
        else:
            d = load_klines_data(sym, '6h', KLINES_6H_DIR)
        print(f'  Probe {sym} {tf}: {len(d)} bars')

    print()
    print(f'Symbols: {TOP_15_SYMBOLS}')

    # ------------------------------------------------------------------
    # Step 1: Load 4h data
    # ------------------------------------------------------------------
    print('\nLoading 4h data...')
    bar_index_4h, price_mtx_4h, vol_mtx_4h, qvol_mtx_4h, symbols_4h = load_all_data(
        TOP_15_SYMBOLS, KLINES_4H_DIR, '4h',
    )
    if len(symbols_4h) == 0:
        print('ERROR: No 4h data loaded. Exiting.')
        sys.exit(1)

    print(f'  4h bar index: {len(bar_index_4h)} bars')
    print(f'  Symbols with data: {symbols_4h} ({len(symbols_4h)} total)')
    if len(bar_index_4h) > 0:
        dt0 = datetime.fromtimestamp(bar_index_4h[0] / 1000000, tz=timezone.utc).strftime('%Y-%m-%d')
        dt1 = datetime.fromtimestamp(bar_index_4h[-1] / 1000000, tz=timezone.utc).strftime('%Y-%m-%d')
        print(f'  4h period: {dt0} to {dt1}')

    # ------------------------------------------------------------------
    # Step 2: Load 6h data
    # ------------------------------------------------------------------
    print('\nLoading 6h data...')
    bar_index_6h, price_mtx_6h, vol_mtx_6h, qvol_mtx_6h, symbols_6h = load_all_data(
        TOP_15_SYMBOLS, KLINES_6H_DIR, '6h',
    )
    if len(symbols_6h) == 0:
        print('ERROR: No 6h data loaded. Exiting.')
        sys.exit(1)

    print(f'  6h bar index: {len(bar_index_6h)} bars')
    print(f'  Symbols with data: {symbols_6h} ({len(symbols_6h)} total)')
    if len(bar_index_6h) > 0:
        dt0 = datetime.fromtimestamp(bar_index_6h[0] / 1000000, tz=timezone.utc).strftime('%Y-%m-%d')
        dt1 = datetime.fromtimestamp(bar_index_6h[-1] / 1000000, tz=timezone.utc).strftime('%Y-%m-%d')
        print(f'  6h period: {dt0} to {dt1}')

    # ------------------------------------------------------------------
    # Step 3: WFO-Lite loop for 4h strategies (A, B)
    # ------------------------------------------------------------------
    print(f'\n=== WFO-Lite (train={WFO_TRAIN_BARS_4H} bars 4h, test={WFO_TEST_BARS_4H}, step={WFO_STEP_BARS_4H}) ===')

    lite_folds_4h: dict[str, list[dict]] = {
        name: [] for name in STRATEGIES if STRATEGIES[name]['data_tf'] == '4h'
    }
    n_4h = len(bar_index_4h)

    i_4h = 0
    fold_id = 0
    while i_4h + WFO_TRAIN_BARS_4H + WFO_TEST_BARS_4H <= n_4h:
        train_start = i_4h
        train_end = i_4h + WFO_TRAIN_BARS_4H
        test_start = train_end
        test_end = min(test_start + WFO_TEST_BARS_4H, n_4h)

        fold = run_fold_4h(
            price_mtx_4h, vol_mtx_4h, qvol_mtx_4h,
            bar_index_4h, symbols_4h,
            train_start, train_end, test_start, test_end,
        )
        if fold:
            for name in lite_folds_4h:
                if name in fold:
                    lite_folds_4h[name].append(fold[name])
                    print(f'  Fold {fold_id}: {name} → {len(lite_folds_4h[name][-1]["holding_period_returns"])} windows')

        i_4h += WFO_STEP_BARS_4H
        fold_id += 1

    # ------------------------------------------------------------------
    # Step 4: WFO-Lite loop for 6h strategy (C)
    # ------------------------------------------------------------------
    print(f'\n=== WFO-Lite (train={WFO_TRAIN_BARS_6H} bars 6h, test={WFO_TEST_BARS_6H}, step={WFO_STEP_BARS_6H}) ===')

    lite_folds_6h: list[dict] = []
    n_6h = len(bar_index_6h)

    i_6h = 0
    fold_id = 0
    while i_6h + WFO_TRAIN_BARS_6H + WFO_TEST_BARS_6H <= n_6h:
        train_start = i_6h
        train_end = i_6h + WFO_TRAIN_BARS_6H
        test_start = train_end
        test_end = min(test_start + WFO_TEST_BARS_6H, n_6h)

        fold = run_fold_6h(
            price_mtx_6h, vol_mtx_6h,
            bar_index_6h, symbols_6h,
            train_start, train_end, test_start, test_end,
        )
        if fold and '6h_composite' in fold:
            lite_folds_6h.append(fold['6h_composite'])
            print(f'  Fold {fold_id}: 6h_composite → {len(lite_folds_6h[-1]["holding_period_returns"])} windows')

        i_6h += WFO_STEP_BARS_6H
        fold_id += 1

    # ------------------------------------------------------------------
    # Step 5: WFO-Lite loop for combo strategy (D)
    # ------------------------------------------------------------------
    print(f'\n=== WFO-Lite combo (4h schedule) ===')

    lite_folds_combo: list[dict] = []

    i_combo = 0
    fold_id = 0
    while i_combo + WFO_TRAIN_BARS_4H + WFO_TEST_BARS_4H <= n_4h:
        train_start = i_combo
        train_end = i_combo + WFO_TRAIN_BARS_4H
        test_start = train_end
        test_end = min(test_start + WFO_TEST_BARS_4H, n_4h)

        fold = run_fold_combo(
            price_mtx_4h, vol_mtx_4h,
            price_mtx_6h, vol_mtx_6h,
            bar_index_4h, bar_index_6h,
            symbols_4h, symbols_6h,
            train_start, train_end, test_start, test_end,
        )
        if fold and '4h_6h_combo' in fold:
            lite_folds_combo.append(fold['4h_6h_combo'])
            print(f'  Fold {fold_id}: 4h_6h_combo → {len(lite_folds_combo[-1]["holding_period_returns"])} windows')

        i_combo += WFO_STEP_BARS_4H
        fold_id += 1

    # ------------------------------------------------------------------
    # Step 6: Print results
    # ------------------------------------------------------------------
    print()
    for name in ['4h_low_vol', '4h_momentum']:
        folds_data = lite_folds_4h.get(name, [])
        summary = compute_strategy_summary(folds_data)
        cfg = STRATEGIES[name]
        print(f'\n--- {name} ---')
        print(f'  Config: {cfg["description"]}')
        print(f'  Folds: {summary["fold_count"]}')
        print(f'  Mean fold return: {summary["mean_return"]:.4f} ({summary["mean_return"]*100:.2f}%)')
        print(f'  Std fold return: {summary["std_return"]:.4f}')
        print(f'  Global Sharpe (all HP returns): {summary["global_sharpe"]:.2f}')
        print(f'  Global win rate: {summary["global_win_rate"]:.2%}')
        print(f'  Fold pass rate (>0): {summary["pass_rate_above_0"]:.2%}')
        print(f'  Max drawdown: {summary["max_drawdown"]:.4f}')
        print(f'  Total holding periods: {summary["global_n_holding_periods"]}')

    print(f'\n--- 6h_composite ---')
    summary_c = compute_strategy_summary(lite_folds_6h)
    cfg_c = STRATEGIES['6h_composite']
    print(f'  Config: {cfg_c["description"]}')
    print(f'  Folds: {summary_c["fold_count"]}')
    print(f'  Mean fold return: {summary_c["mean_return"]:.4f} ({summary_c["mean_return"]*100:.2f}%)')
    print(f'  Global Sharpe: {summary_c["global_sharpe"]:.2f}')
    print(f'  Global win rate: {summary_c["global_win_rate"]:.2%}')
    print(f'  Fold pass rate (>0): {summary_c["pass_rate_above_0"]:.2%}')

    print(f'\n--- 4h_6h_combo ---')
    summary_d = compute_strategy_summary(lite_folds_combo)
    cfg_d = STRATEGIES['4h_6h_combo']
    print(f'  Config: {cfg_d["description"]}')
    print(f'  Folds: {summary_d["fold_count"]}')
    print(f'  Mean fold return: {summary_d["mean_return"]:.4f} ({summary_d["mean_return"]*100:.2f}%)')
    print(f'  Global Sharpe: {summary_d["global_sharpe"]:.2f}')
    print(f'  Global win rate: {summary_d["global_win_rate"]:.2%}')
    print(f'  Fold pass rate (>0): {summary_d["pass_rate_above_0"]:.2%}')

    # ------------------------------------------------------------------
    # Step 7: Build & write report
    # ------------------------------------------------------------------
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'strategy': 'strategy_4h_6h',
        'config': {
            'n_symbols_4h': len(symbols_4h),
            'symbols_4h': symbols_4h,
            'n_symbols_6h': len(symbols_6h),
            'symbols_6h': symbols_6h,
            'cost_bps': COST_BPS,
        },
        'strategies': {},
        'wfo_lite': {
            'train_days': 180,
            'test_days': 30,
            'step_days': 7,
            'train_bars_4h': WFO_TRAIN_BARS_4H,
            'test_bars_4h': WFO_TEST_BARS_4H,
            'step_bars_4h': WFO_STEP_BARS_4H,
            'train_bars_6h': WFO_TRAIN_BARS_6H,
            'test_bars_6h': WFO_TEST_BARS_6H,
            'step_bars_6h': WFO_STEP_BARS_6H,
        },
    }

    for name in ['4h_low_vol', '4h_momentum']:
        folds_data = lite_folds_4h.get(name, [])
        summary = compute_strategy_summary(folds_data)
        report['strategies'][name] = {
            'description': STRATEGIES[name]['description'],
            'rebal_bars': STRATEGIES[name]['rebal_bars'],
            'selection_pct': STRATEGIES[name]['pct'],
            'direction': STRATEGIES[name]['direction'],
            'weighting': STRATEGIES[name]['weighting'],
            'folds': folds_data,
            'summary': summary,
        }

    report['strategies']['6h_composite'] = {
        'description': cfg_c['description'],
        'rebal_bars': cfg_c['rebal_bars'],
        'selection_pct': cfg_c['pct'],
        'direction': cfg_c['direction'],
        'weighting': cfg_c['weighting'],
        'folds': lite_folds_6h,
        'summary': summary_c,
    }

    report['strategies']['4h_6h_combo'] = {
        'description': cfg_d['description'],
        'rebal_bars': cfg_d['rebal_bars'],
        'selection_pct': cfg_d['pct'],
        'direction': cfg_d['direction'],
        'weighting': cfg_d['weighting'],
        'folds': lite_folds_combo,
        'summary': summary_d,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)

    print(f'\nReport: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
