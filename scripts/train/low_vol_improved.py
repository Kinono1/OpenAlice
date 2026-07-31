#!/usr/bin/env python3
"""
Improved low-volatility strategy variants.

Variants:
  A: Trend filter — only long when BTC 21d return > 0
  B: Risk parity — inverse-vol weighting instead of equal-weight
  C: Longer holding — 60-day rebalance instead of 21
  D: Combined — trend filter + risk parity + 60d holding

Also runs WFO-Lite on the best variant.
Output: data/research/low_vol_improved_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
COST_BPS = 15
OUTPUT_PATH = ('/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice'
               '/data/research/low_vol_improved_report.json')

LEVERAGED_PATTERNS = ('UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT')

# ---------------------------------------------------------------------------
# Universe discovery
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

# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def load_daily_closes(symbol: str, start_year: int = 2020, end_year: int = 2024) -> dict[str, float]:
    """Return dict[date_str] -> close_price for *symbol*."""
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {}
    closes: dict[str, float] = {}
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


def compute_daily_returns(closes: dict[str, float]) -> dict[str, float]:
    """Return dict[date_str] -> daily_simple_return."""
    dates = sorted(closes.keys())
    ret: dict[str, float] = {}
    for i in range(1, len(dates)):
        d, prev = dates[i], dates[i - 1]
        if closes[prev] > 0:
            ret[d] = (closes[d] - closes[prev]) / closes[prev]
    return ret

# ---------------------------------------------------------------------------
# Core strategy runner
# ---------------------------------------------------------------------------
def run_strategy(
    dates: list[str],
    all_closes: dict[str, dict[str, float]],
    returns: dict[str, dict[str, float]],
    btc_closes: dict[str, float],
    btc_returns: dict[str, float],
    *,
    rebalance_days: int = 21,
    long_pct: float = 0.25,
    use_trend_filter: bool = False,
    use_risk_parity: bool = False,
    cost_bps: int = COST_BPS,
) -> dict | None:
    """Run a low-vol strategy variant and return aggregated metrics.

    Parameters
    ----------
    dates : list[str]
        Sorted date strings that define the backtest timeline.
        Rebalance points are computed from this list.
    all_closes : dict[symbol] -> dict[date_str] -> price
    returns : dict[symbol] -> dict[date_str] -> daily_return
    btc_closes, btc_returns : BTC price/return data for trend filter & benchmark.

    Returns a dict with keys:
      net_annualized, sharpe, max_dd, win_rate, outperform_rate,
      total_trades, total_return, window_returns, btc_window_returns
    """
    rebalance_indices = list(range(0, len(dates), rebalance_days))

    window_returns: list[float] = []
    btc_window_returns: list[float] = []
    window_date_strs: list[str] = []

    for wi in range(len(rebalance_indices) - 1):
        start_idx = rebalance_indices[wi]
        end_idx = rebalance_indices[wi + 1]
        window_dates = dates[start_idx:end_idx]

        if len(window_dates) < 2:
            continue

        rebal_date = window_dates[0]

        # ---- Trend filter ------------------------------------------------
        if use_trend_filter:
            btc_dates_before = sorted(d for d in btc_returns if d <= rebal_date)
            if len(btc_dates_before) < 15:
                continue
            btc_21d_prod = 1.0
            for d in btc_dates_before[-21:]:
                btc_21d_prod *= (1 + btc_returns[d])
            btc_21d_return = btc_21d_prod - 1.0

            if btc_21d_return <= 0:
                # All cash: 0% net return
                window_returns.append(0.0)
                window_date_strs.append(rebal_date)

                btc_s = btc_closes.get(window_dates[0])
                btc_e = btc_closes.get(window_dates[-1])
                if btc_s and btc_e and btc_s > 0:
                    btc_window_returns.append((btc_e - btc_s) / btc_s)
                else:
                    btc_window_returns.append(0.0)
                continue

        # ---- Vol ranking ------------------------------------------------
        vol_data: dict[str, float] = {}
        for sym in returns:
            sym_dates = sorted(d for d in returns[sym] if d <= rebal_date)
            if len(sym_dates) < 15:
                continue
            recent = [returns[sym][d] for d in sym_dates[-21:]]
            vol = np.std(recent, ddof=1)
            if vol > 0 and not np.isnan(vol):
                vol_data[sym] = vol

        if len(vol_data) < 4:
            continue

        ranked = sorted(vol_data.items(), key=lambda x: x[1])
        n_long = max(1, int(len(ranked) * long_pct))
        long_symbols = [sym for sym, _ in ranked[:n_long]]

        # ---- Weights ----------------------------------------------------
        if use_risk_parity:
            vols_arr = np.array([vol_data[sym] for sym in long_symbols])
            inv_vols = 1.0 / vols_arr
            w = inv_vols / np.sum(inv_vols)
            weights = {sym: float(w[i]) for i, sym in enumerate(long_symbols)}
        else:
            w = 1.0 / len(long_symbols)
            weights = {sym: w for sym in long_symbols}

        # ---- Forward return --------------------------------------------
        weighted_return = 0.0
        has_position = False
        for sym in long_symbols:
            s = all_closes[sym].get(window_dates[0])
            e = all_closes[sym].get(window_dates[-1])
            if s and e and s > 0:
                weighted_return += weights[sym] * ((e - s) / s)
                has_position = True

        if not has_position:
            continue

        gross = weighted_return
        net = gross - cost_bps / 10000 * 2  # buy + sell

        window_returns.append(net)
        window_date_strs.append(rebal_date)

        # BTC benchmark
        btc_s = btc_closes.get(window_dates[0])
        btc_e = btc_closes.get(window_dates[-1])
        if btc_s and btc_e and btc_s > 0:
            btc_window_returns.append((btc_e - btc_s) / btc_s)
        else:
            btc_window_returns.append(0.0)

    # ---- Aggregate metrics ------------------------------------------------
    n_periods = len(window_returns)
    if n_periods == 0:
        return None

    n_arr = np.array(window_returns)
    b_arr = np.array(btc_window_returns)

    ann_factor = 365.25 / rebalance_days

    net_annualized = float(np.mean(n_arr) * ann_factor)

    mean_n = float(np.mean(n_arr))
    std_n = float(np.std(n_arr, ddof=1))
    sharpe = float(mean_n / std_n * np.sqrt(ann_factor)) if std_n > 0 else 0.0

    cum = np.cumprod(1.0 + n_arr)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    win_rate = float(np.mean(n_arr > 0))
    outperform_rate = float(np.mean(n_arr > b_arr)) if len(b_arr) > 0 else 0.0
    total_return = float(np.prod(1 + n_arr) - 1)

    return {
        'net_annualized': round(net_annualized, 6),
        'sharpe': round(sharpe, 4),
        'max_dd': round(max_dd, 6),
        'win_rate': round(win_rate, 4),
        'outperform_rate': round(outperform_rate, 4),
        'total_trades': n_periods,
        'total_return': round(total_return, 6),
        # Raw arrays kept for WFO rollup
        '_window_returns': [round(r, 6) for r in window_returns],
        '_btc_window_returns': [round(r, 6) for r in btc_window_returns],
    }

# ---------------------------------------------------------------------------
# WFO-Lite
# ---------------------------------------------------------------------------
def run_wfo_lite(
    all_dates: list[str],
    all_closes: dict,
    returns: dict,
    btc_closes: dict,
    btc_returns: dict,
    config: dict,
    *,
    train_days: int = 365,
    test_days: int = 63,
    step_days: int = 21,
) -> dict | None:
    """Walk-forward optimization (lite). Returns summary + folds."""
    folds: list[dict] = []

    i = 0
    while i + train_days + test_days <= len(all_dates):
        train_start = all_dates[i]
        train_end = all_dates[i + train_days]
        test_start = all_dates[i + train_days]
        test_end = all_dates[min(i + train_days + test_days, len(all_dates) - 1)]

        test_window = [d for d in all_dates if test_start <= d < test_end]
        if len(test_window) < 10:
            i += step_days
            continue

        result = run_strategy(
            test_window, all_closes, returns, btc_closes, btc_returns,
            rebalance_days=config.get('rebalance_days', 21),
            long_pct=config.get('long_pct', 0.25),
            use_trend_filter=config.get('use_trend_filter', False),
            use_risk_parity=config.get('use_risk_parity', False),
            cost_bps=COST_BPS,
        )

        if result and result['total_trades'] > 0:
            folds.append({
                'train_range': f'{train_start} ~ {train_end}',
                'test_range': f'{test_start} ~ {test_end}',
                'n_windows': result['total_trades'],
                'mean_window_return': float(np.mean(result['_window_returns'])),
                'annualized_return': result['net_annualized'],
                'sharpe': result['sharpe'],
                'win_rate': result['win_rate'],
                'outperform_rate': result['outperform_rate'],
            })

        i += step_days

    if not folds:
        return None

    ann_rets = [f['annualized_return'] for f in folds]
    sharpes = [f['sharpe'] for f in folds]
    outperforms = [f['outperform_rate'] for f in folds]

    return {
        'train_days': train_days,
        'test_days': test_days,
        'step_days': step_days,
        'fold_count': len(folds),
        'mean_annualized_return': float(np.mean(ann_rets)),
        'std_annualized_return': float(np.std(ann_rets, ddof=1)) if len(ann_rets) > 1 else 0,
        'pass_rate': float(np.mean([r > 0 for r in ann_rets])),
        'outperform_btc_rate': float(np.mean(outperforms)),
        'mean_sharpe': float(np.mean(sharpes)),
        'folds': folds,
    }

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print('=== Low-Vol Strategy Improvements ===')
    print()

    # ---- Data loading ----------------------------------------------------
    print('1. Discovering symbols ...')
    symbols = discover_symbols(50)
    print(f'   Found {len(symbols)} symbols')

    print('2. Loading daily closes ...')
    all_closes: dict[str, dict[str, float]] = {}
    for sym in symbols:
        closes = load_daily_closes(sym)
        if closes:
            all_closes[sym] = closes

    all_dates = sorted(set(d for c in all_closes.values() for d in c))
    print(f'   Price matrix: {len(all_closes)} symbols x {len(all_dates)} days')
    print(f'   Period: {all_dates[0]} to {all_dates[-1]}')

    print('3. Computing daily returns ...')
    returns: dict[str, dict[str, float]] = {}
    for sym, closes in all_closes.items():
        returns[sym] = compute_daily_returns(closes)

    btc_closes = all_closes.get('BTCUSDT', {})
    btc_returns = compute_daily_returns(btc_closes) if btc_closes else {}

    # ---- Strategy variants -----------------------------------------------
    variant_configs: dict[str, dict] = {
        'base_25pct_eqwt_21d': {
            'rebalance_days': 21,
            'use_trend_filter': False,
            'use_risk_parity': False,
            'desc': 'Base: bottom 25%, equal-weight, 21d rebal',
        },
        'trend_filter_25pct_eqwt_21d': {
            'rebalance_days': 21,
            'use_trend_filter': True,
            'use_risk_parity': False,
            'desc': 'Trend filter: only long when BTC 21d return > 0',
        },
        'risk_parity_25pct_21d': {
            'rebalance_days': 21,
            'use_trend_filter': False,
            'use_risk_parity': True,
            'desc': 'Risk parity: inverse-vol weighting',
        },
        'base_25pct_eqwt_60d': {
            'rebalance_days': 60,
            'use_trend_filter': False,
            'use_risk_parity': False,
            'desc': 'Longer hold: 60d rebal, equal-weight',
        },
        'combined_trend_rp_60d': {
            'rebalance_days': 60,
            'use_trend_filter': True,
            'use_risk_parity': True,
            'desc': 'Combined: trend filter + risk parity + 60d hold',
        },
    }

    print('\n4. Running strategy variants ...')
    results: dict[str, dict] = {}
    for name, cfg in variant_configs.items():
        print(f'\n   --- {name}: {cfg["desc"]} ---')
        res = run_strategy(
            all_dates, all_closes, returns, btc_closes, btc_returns,
            rebalance_days=cfg['rebalance_days'],
            use_trend_filter=cfg['use_trend_filter'],
            use_risk_parity=cfg['use_risk_parity'],
        )
        if res:
            # Strip internal arrays before storing in report
            clean = {k: v for k, v in res.items() if not k.startswith('_')}
            results[name] = clean
            print(f'      Net annualized:    {clean["net_annualized"]:.2%}')
            print(f'      Sharpe:            {clean["sharpe"]:.2f}')
            print(f'      Max DD:            {clean["max_dd"]:.2%}')
            print(f'      Win rate:          {clean["win_rate"]:.2%}')
            print(f'      vs BTC outpf rate: {clean["outperform_rate"]:.2%}')
            print(f'      Total trades:      {clean["total_trades"]}')
        else:
            print('      FAILED (no valid periods)')

    # ---- Determine best variant (by Sharpe) ------------------------------
    valid_results = {k: v for k, v in results.items() if v['total_trades'] > 0}
    if not valid_results:
        print('\nERROR: no variant produced valid results.')
        sys.exit(1)

    best_name = max(valid_results, key=lambda k: valid_results[k]['sharpe'])
    print(f'\n5. Best variant (by Sharpe): {best_name}')

    # ---- WFO-Lite on best variant ----------------------------------------
    print(f'\n6. Running WFO-Lite on {best_name} ...')
    best_cfg = variant_configs[best_name]
    wfo = run_wfo_lite(
        all_dates, all_closes, returns, btc_closes, btc_returns,
        best_cfg,
        train_days=365, test_days=63, step_days=21,
    )

    if wfo:
        print(f'      Folds:               {wfo["fold_count"]}')
        print(f'      Mean ann return:     {wfo["mean_annualized_return"]:.2%}')
        print(f'      Mean Sharpe:         {wfo["mean_sharpe"]:.2f}')
        print(f'      Fold pass rate:      {wfo["pass_rate"]:.2%}')
        print(f'      Outperform BTC rate: {wfo["outperform_btc_rate"]:.2%}')
    else:
        print('      WFO-Lite produced no valid folds.')

    # ---- M1 gate ---------------------------------------------------------
    m1_pass = bool(wfo and wfo['mean_annualized_return'] > 0 and wfo['pass_rate'] > 0.3)
    print(f'\n7. M1 gate: {"PASS" if m1_pass else "FAIL"}')

    # ---- Build final report ----------------------------------------------
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'config': {
            'n_symbols': len(all_closes),
            'n_dates': len(all_dates),
            'period': f'{all_dates[0]} ~ {all_dates[-1]}',
            'cost_bps': COST_BPS,
            'long_pct': 0.25,
        },
        'variants': results,
        'best_variant': best_name,
        'wfo_lite_summary': wfo,
        'm1_pass': m1_pass,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\n8. Report written: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
