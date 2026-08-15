#!/usr/bin/env python3
"""
Multi-timeframe low-vol strategy test with WFO-Lite.

Strategies:
  A (multi_tf_low_vol): Multi-tf low-vol (daily + weekly + monthly)
     - Combine vol from 3 timeframes:
       daily: realized_vol_21d, weekly: realized_vol_12w, monthly: realized_vol_6m
     - Composite score = average z-score of all three
     - Select bottom 20% by composite score
     - Equal-weight, rebalance 21 trading days
  B (weekly_low_vol): Weekly low-vol only
     - Use weekly klines aggregated from daily
     - realized_vol_12w (12 weeks)
     - Select bottom 25%, equal-weight
     - Rebalance every 28 days (4 weeks)
  C (contrarian_high_vol): Contrarian (high vol -> buy)
     - Buy HIGHEST vol coins
     - realized_vol_21d, select top 25%
     - Equal-weight, rebalance 21 trading days

WFO-Lite: train=365d, test=63d, step=21d
Output: data/research/strategy_multi_tf_report.json

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
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
COST_BPS = 15
OUTPUT_PATH = (
    '/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice'
    '/data/research/strategy_multi_tf_report.json'
)

MAIN_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
    'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
    'AAVEUSDT', 'MKRUSDT',
]

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')
STABLECOIN_SYMBOLS = frozenset([
    'USDCUSDT', 'USDTUSDT', 'DAIUSDT', 'TUSDUSDT', 'FDUSDUSDT',
    'BUSDUSDT', 'EURUSDT', 'GBPUSDT', 'AUDUSDT', 'PAXUSDT',
])

# WFO-Lite parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

# Strategy parameters
DAILY_VOL_WINDOW = 21
WEEKLY_VOL_WINDOW = 12
MONTHLY_VOL_WINDOW = 6

STRATEGIES = {
    'multi_tf_low_vol': {
        'rebal_days': 21,
        'pct': 0.20,
        'direction': 'low',
        'description': 'Multi-tf composite z-score (daily+weekly+monthly), bottom 20%, rebal 21d',
    },
    'weekly_low_vol': {
        'rebal_days': 28,
        'pct': 0.25,
        'direction': 'low',
        'description': 'Weekly 12w realized vol, bottom 25%, rebal 28d',
    },
    'contrarian_high_vol': {
        'rebal_days': 21,
        'pct': 0.25,
        'direction': 'high',
        'description': 'Daily 21d realized vol, top 25%, rebal 21d',
    },
}


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_daily_closes(symbol: str) -> dict[str, float]:
    """Load ALL daily closes for a symbol from monthly ZIP files.

    Binance CSV columns (pipe-delimited in source):
        open_time(ms), open, high, low, close, volume, ...
    Returns {date_str: close_price}.
    """
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {}

    closes: dict[str, float] = {}
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
                    if len(cols) >= 5:
                        try:
                            ts_ms = int(cols[0])
                            close = float(cols[4])
                            date_str = datetime.fromtimestamp(
                                ts_ms / 1000, tz=timezone.utc
                            ).strftime('%Y-%m-%d')
                            closes[date_str] = close
                        except (ValueError, IndexError):
                            continue
        except Exception:
            continue
    return closes


def compute_returns(closes: dict[str, float]) -> dict[str, float]:
    """Compute daily returns from close prices.

    Returns dict[date_str] -> daily_return.
    """
    dates = sorted(closes.keys())
    rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        d, prev = dates[i], dates[i - 1]
        if closes[prev] > 0:
            rets[d] = (closes[d] - closes[prev]) / closes[prev]
    return rets


# ---------------------------------------------------------------------------
# Period aggregation helpers
# ---------------------------------------------------------------------------

def _get_week_id(date_str: str) -> tuple[int, int]:
    """Return ISO (year, week_number)."""
    dt = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    iso = dt.isocalendar()
    return (iso[0], iso[1])


def _get_month_id(date_str: str) -> tuple[int, int]:
    """Return (year, month)."""
    dt = datetime.strptime(date_str, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    return (dt.year, dt.month)


def _aggregate_period(
    closes: dict[str, float],
    period_fn,
    period_fmt: str,
) -> dict[str, float]:
    """Aggregate daily closes to lower-frequency periods.

    Args:
        closes: {date_str: close} — already filtered to dates <= rebal_date.
        period_fn: function mapping date_str -> period_id tuple.
        period_fmt: format string for period_id tuple -> str key.

    Returns:
        dict[period_key_str] -> close_price
        where close_price is the LAST close of each period.
    """
    periods: dict[tuple, tuple[str, float]] = {}
    for date_str, close in closes.items():
        pid = period_fn(date_str)
        if pid not in periods or date_str > periods[pid][0]:
            periods[pid] = (date_str, close)

    return {period_fmt % pid: c for pid, (_, c) in sorted(periods.items())}


def aggregate_weekly(closes: dict[str, float]) -> dict[str, float]:
    """Aggregate daily closes to ISO weekly frequency.

    Returns dict like {'2024-W01': close, ...}.
    """
    return _aggregate_period(closes, _get_week_id, '%d-W%02d')


def aggregate_monthly(closes: dict[str, float]) -> dict[str, float]:
    """Aggregate daily closes to calendar monthly frequency.

    Returns dict like {'2024-01': close, ...}.
    """
    return _aggregate_period(closes, _get_month_id, '%d-%02d')


def compute_period_returns(period_closes: dict[str, float]) -> list[float]:
    """Compute consecutive returns from period-level closes.

    Args:
        period_closes: {period_key: close} sorted by period_key.

    Returns:
        list of returns, one per consecutive pair.
    """
    sorted_items = sorted(period_closes.items())
    rets: list[float] = []
    for i in range(1, len(sorted_items)):
        prev_c, curr_c = sorted_items[i - 1][1], sorted_items[i][1]
        if prev_c > 0:
            rets.append((curr_c - prev_c) / prev_c)
    return rets


# ---------------------------------------------------------------------------
# Volatility computation
# ---------------------------------------------------------------------------

def realized_vol_sorted(rets: list[float], window: int) -> float | None:
    """Compute sample std of the last *window* returns.

    Args:
        rets: list of return values (most recent last).
        window: number of observations.

    Returns:
        volatility or None if insufficient data.
    """
    if len(rets) < max(2, window):
        return None
    recent = rets[-window:]
    vol = float(np.std(recent, ddof=1))
    return vol if vol > 0 and not np.isnan(vol) else None


def compute_daily_vol(
    all_returns: dict[str, dict[str, float]],
    rebal_date: str,
    symbol: str,
    window: int = DAILY_VOL_WINDOW,
) -> float | None:
    """Compute rolling realized vol from daily returns up to rebal_date."""
    sym_rets = all_returns.get(symbol, {})
    dates = sorted(d for d in sym_rets if d <= rebal_date)
    if len(dates) < window + 1:
        return None
    recent = [sym_rets[d] for d in dates[-window:]]
    return realized_vol_sorted(recent, window)


def compute_aggregated_vol(
    all_closes: dict[str, dict[str, float]],
    rebal_date: str,
    symbol: str,
    agg_fn,
    window: int,
) -> float | None:
    """Compute realized vol from aggregated (weekly/monthly) returns.

    Args:
        all_closes: {symbol: {date: close}}.
        agg_fn: aggregate_weekly or aggregate_monthly.
        window: number of periods.

    Returns:
        volatility or None.
    """
    closes = all_closes.get(symbol, {})
    closes_upto = {d: c for d, c in closes.items() if d <= rebal_date}
    if len(closes_upto) < 30:  # need enough daily data for meaningful aggregation
        return None

    agg = agg_fn(closes_upto)
    if len(agg) < window + 1:
        return None

    rets = compute_period_returns(agg)
    return realized_vol_sorted(rets, window)


# ---------------------------------------------------------------------------
# Cross-sectional scoring
# ---------------------------------------------------------------------------

def compute_composite_scores(
    all_closes: dict[str, dict[str, float]],
    all_returns: dict[str, dict[str, float]],
    rebal_date: str,
    symbols: list[str],
) -> dict[str, float]:
    """Compute multi-tf composite score (avg z-score of daily/weekly/monthly vol).

    Returns dict[symbol] -> composite_score (lower = lower vol).
    Only includes symbols where all three vol estimates are available.
    Returns empty dict if < 4 symbols qualify.
    """
    raw: dict[str, tuple[float, float, float]] = {}
    for sym in symbols:
        dv = compute_daily_vol(all_returns, rebal_date, sym, DAILY_VOL_WINDOW)
        wv = compute_aggregated_vol(
            all_closes, rebal_date, sym, aggregate_weekly, WEEKLY_VOL_WINDOW
        )
        mv = compute_aggregated_vol(
            all_closes, rebal_date, sym, aggregate_monthly, MONTHLY_VOL_WINDOW
        )
        if dv is not None and wv is not None and mv is not None:
            raw[sym] = (dv, wv, mv)

    if len(raw) < 4:
        return {}

    syms = list(raw.keys())
    dv_vals = np.array([raw[s][0] for s in syms])
    wv_vals = np.array([raw[s][1] for s in syms])
    mv_vals = np.array([raw[s][2] for s in syms])

    dv_mean, dv_std = float(np.mean(dv_vals)), float(np.std(dv_vals, ddof=1))
    wv_mean, wv_std = float(np.mean(wv_vals)), float(np.std(wv_vals, ddof=1))
    mv_mean, mv_std = float(np.mean(mv_vals)), float(np.std(mv_vals, ddof=1))

    dv_std = dv_std if dv_std > 1e-12 else 1.0
    wv_std = wv_std if wv_std > 1e-12 else 1.0
    mv_std = mv_std if mv_std > 1e-12 else 1.0

    composites: dict[str, float] = {}
    for sym in syms:
        dv_z = (raw[sym][0] - dv_mean) / dv_std
        wv_z = (raw[sym][1] - wv_mean) / wv_std
        mv_z = (raw[sym][2] - mv_mean) / mv_std
        composites[sym] = (dv_z + wv_z + mv_z) / 3.0

    return composites


def compute_weekly_vol_scores(
    all_closes: dict[str, dict[str, float]],
    rebal_date: str,
    symbols: list[str],
) -> dict[str, float]:
    """Compute weekly 12w realized vol for each symbol.

    Returns dict[symbol] -> vol.
    """
    scores: dict[str, float] = {}
    for sym in symbols:
        vol = compute_aggregated_vol(
            all_closes, rebal_date, sym, aggregate_weekly, WEEKLY_VOL_WINDOW
        )
        if vol is not None:
            scores[sym] = vol
    return scores


def compute_daily_vol_scores(
    all_returns: dict[str, dict[str, float]],
    rebal_date: str,
    symbols: list[str],
) -> dict[str, float]:
    """Compute daily 21d realized vol for each symbol.

    Returns dict[symbol] -> vol.
    """
    scores: dict[str, float] = {}
    for sym in symbols:
        vol = compute_daily_vol(all_returns, rebal_date, sym, DAILY_VOL_WINDOW)
        if vol is not None:
            scores[sym] = vol
    return scores


# ---------------------------------------------------------------------------
# Strategy execution helpers
# ---------------------------------------------------------------------------

def select_symbols(
    scores: dict[str, float],
    direction: str,
    pct: float,
) -> list[str]:
    """Select symbols by vol percentile.

    Args:
        scores: dict[symbol] -> vol or composite score.
        direction: 'low' -> ascending (buy low vol), 'high' -> descending (buy high vol).
        pct: fraction to select (e.g., 0.25 = top/bottom 25%).

    Returns:
        list of selected symbols.
    """
    if not scores:
        return []

    reverse = direction == 'high'
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=reverse)
    n_select = max(1, int(len(ranked) * pct))
    return [sym for sym, _ in ranked[:n_select]]


# ---------------------------------------------------------------------------
# WFO fold execution
# ---------------------------------------------------------------------------

def run_fold(
    all_closes: dict[str, dict[str, float]],
    all_returns: dict[str, dict[str, float]],
    all_dates: list[str],
    train_start: str,
    train_end: str,
    test_start: str,
    test_end: str,
) -> dict[str, dict] | None:
    """Run one WFO fold for all 3 strategies.

    For each strategy, computes portfolio returns over holding periods
    within the test window.

    Returns:
        dict[strategy_name -> dict of fold-level metrics] or None if insufficient data.
    """
    test_dates = [d for d in all_dates if test_start <= d < test_end]
    if len(test_dates) < 10:
        return None

    symbols = list(all_closes.keys())

    fold_results: dict[str, dict] = {}

    for name, config in STRATEGIES.items():
        rebal_interval = config['rebal_days']
        pct = config['pct']
        direction = config['direction']

        rebal_indices = list(range(0, len(test_dates), rebal_interval))
        if len(rebal_indices) < 2:
            continue

        fold_returns: list[float] = []

        for wi in range(len(rebal_indices)):
            si = rebal_indices[wi]
            if wi + 1 < len(rebal_indices):
                ei = rebal_indices[wi + 1]
            else:
                ei = len(test_dates)
            window_dates = test_dates[si:ei]

            if len(window_dates) < 2:
                continue

            rebal_date = test_dates[si]

            # Compute scores based on strategy type
            if name == 'multi_tf_low_vol':
                scores = compute_composite_scores(
                    all_closes, all_returns, rebal_date, symbols
                )
            elif name == 'weekly_low_vol':
                scores = compute_weekly_vol_scores(
                    all_closes, rebal_date, symbols
                )
            else:  # contrarian_high_vol
                scores = compute_daily_vol_scores(
                    all_returns, rebal_date, symbols
                )

            if len(scores) < 4:
                continue

            selected = select_symbols(scores, direction, pct)
            if not selected:
                continue

            # Compute equal-weighted return over holding period
            sym_rets = []
            for sym in selected:
                s = all_closes[sym].get(window_dates[0])
                e = all_closes[sym].get(window_dates[-1])
                if s and e and s > 0:
                    sym_rets.append((e - s) / s)

            if not sym_rets:
                continue

            gross_ret = float(np.mean(sym_rets))
            net_ret = gross_ret - COST_BPS / 10000 * 2  # 2 legs per rebalance
            fold_returns.append(net_ret)

        if fold_returns:
            ret_arr = np.array(fold_returns)
            mean_ret = float(np.mean(ret_arr))
            std_ret = float(np.std(ret_arr, ddof=1)) if len(ret_arr) > 1 else 0.0
            win_rate = float(np.mean(ret_arr > 0))
            sharpe = (
                float(mean_ret / std_ret * np.sqrt(12))
                if std_ret > 1e-12
                else 0.0
            )
            cum = np.cumprod(1 + ret_arr)
            running_max = np.maximum.accumulate(cum)
            drawdowns = (cum - running_max) / running_max
            max_dd = float(np.min(drawdowns)) if len(drawdowns) > 0 else 0.0

            fold_results[name] = {
                'train_range': f'{train_start} ~ {train_end}',
                'test_range': f'{test_start} ~ {test_end}',
                'n_windows': len(fold_returns),
                'mean_return': mean_ret,
                'std_return': std_ret,
                'win_rate': win_rate,
                'sharpe_window': sharpe,
                'max_drawdown': max_dd,
                'holding_period_returns': [float(r) for r in fold_returns],
            }

    return fold_results if fold_results else None


# ---------------------------------------------------------------------------
# Summary computation
# ---------------------------------------------------------------------------

def compute_strategy_summary(folds: list[dict]) -> dict:
    """Compute aggregate metrics across all folds for one strategy.

    Includes both per-fold averages and global metrics computed from
    all holding period returns pooled across folds.
    """
    if not folds:
        return {
            'fold_count': 0,
            'mean_return': 0,
            'std_return': 0,
            'win_rate': 0,
            'sharpe': 0,
            'max_drawdown': 0,
        }

    fold_returns = [f['mean_return'] for f in folds]
    fold_win_rates = [f['win_rate'] for f in folds]
    fold_dds = [f['max_drawdown'] for f in folds]

    mean_ret = float(np.mean(fold_returns))
    std_ret = float(np.std(fold_returns, ddof=1)) if len(fold_returns) > 1 else 0.0

    # Global Sharpe: pool all holding period returns across folds
    all_hp_returns = []
    for f in folds:
        all_hp_returns.extend(f.get('holding_period_returns', []))
    all_hp_arr = np.array(all_hp_returns)
    global_mean = float(np.mean(all_hp_arr)) if len(all_hp_arr) > 0 else 0.0
    global_std = float(np.std(all_hp_arr, ddof=1)) if len(all_hp_arr) > 1 else 0.0
    global_sharpe = (
        float(global_mean / global_std * np.sqrt(12))
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
        'win_rate_folds': float(np.mean([f['mean_return'] > 0 for f in folds])),
        'pass_rate_above_0': float(np.mean([f['mean_return'] > 0 for f in folds])),
        # Global metrics from all holding period returns
        'global_win_rate': global_win_rate,
        'global_sharpe': global_sharpe,
        'global_n_holding_periods': len(all_hp_arr),
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print('=== Multi-timeframe Low-Vol Strategy Test (WFO-Lite) ===')
    print()

    # Step 1: Load data
    print('Loading daily closes for MAIN_SYMBOLS...')
    all_closes: dict[str, dict[str, float]] = {}
    for sym in MAIN_SYMBOLS:
        closes = load_daily_closes(sym)
        if closes:
            all_closes[sym] = closes
            print(f'  {sym}: {len(closes)} days')
        else:
            print(f'  {sym}: NO DATA')

    if not all_closes:
        print('ERROR: No data loaded. Exiting.')
        sys.exit(1)

    # Build common date index (union of all dates across symbols)
    all_dates = sorted(set(d for c in all_closes.values() for d in c))
    print(f'\nData matrix: {len(all_closes)} symbols x {len(all_dates)} days')
    print(f'Period: {all_dates[0]} to {all_dates[-1]}')

    # Compute daily returns for each symbol
    print('Computing daily returns...')
    all_returns: dict[str, dict[str, float]] = {
        sym: compute_returns(closes) for sym, closes in all_closes.items()
    }

    # Step 2: WFO-Lite loop
    print(f'\n=== WFO-Lite (train={TRAIN_DAYS}d, test={TEST_DAYS}d, step={STEP_DAYS}d) ===')

    lite_folds: dict[str, list[dict]] = {name: [] for name in STRATEGIES}

    i = 0
    while i + TRAIN_DAYS + TEST_DAYS <= len(all_dates):
        train_start = all_dates[i]
        train_end = all_dates[i + TRAIN_DAYS]
        test_start = all_dates[i + TRAIN_DAYS]
        test_end = all_dates[min(i + TRAIN_DAYS + TEST_DAYS, len(all_dates) - 1)]

        fold = run_fold(
            all_closes, all_returns, all_dates,
            train_start, train_end, test_start, test_end,
        )
        if fold:
            for name in STRATEGIES:
                if name in fold:
                    lite_folds[name].append(fold[name])

        i += STEP_DAYS

    # Step 3: Print results
    print()
    for name in STRATEGIES:
        folds_data = lite_folds[name]
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

    # Step 4: Build & write report
    period_str = f'{all_dates[0]} to {all_dates[-1]}'

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'strategy': 'strategy_multi_tf',
        'config': {
            'n_symbols': len(all_closes),
            'symbols': list(all_closes.keys()),
            'cost_bps': COST_BPS,
            'period': period_str,
        },
        'strategies': {},
        'wfo_lite': {
            'train_days': TRAIN_DAYS,
            'test_days': TEST_DAYS,
            'step_days': STEP_DAYS,
        },
    }

    for name, cfg in STRATEGIES.items():
        folds_data = lite_folds[name]
        summary = compute_strategy_summary(folds_data)
        report['strategies'][name] = {
            'description': cfg['description'],
            'rebal_days': cfg['rebal_days'],
            'selection_pct': cfg['pct'],
            'direction': cfg['direction'],
            'folds': folds_data,
            'summary': summary,
        }

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)

    print(f'\nReport: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
