"""
Walk-Forward Optimization for long-only low-vol strategy.

WFO-Lite: train=365d, test=63d, step=21d, embargo=21d
WFO-Formal: train=730d, test=90d, step=30d, embargo=21d

Output: data/research/low_vol_wfo_report.json
"""
import json, os, sys, zipfile
from datetime import datetime, timezone
import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
COST_BPS = 15
REBAL_DAYS = 21
LONG_PCT = 0.25


def discover_symbols(max_symbols=50):
    results = []
    for d in os.listdir(KLINES_DIR):
        if any(s in d for s in ['UPUSDT', 'DOWNUSDT', 'BULLUSDT', 'BEARUSDT']):
            continue
        kline_path = os.path.join(KLINES_DIR, d, '1d')
        if not os.path.isdir(kline_path):
            continue
        files = sorted([f for f in os.listdir(kline_path) if f.endswith('.zip')])
        if len(files) >= 36:
            results.append({'symbol': d, 'months': len(files)})
    results.sort(key=lambda r: r['months'], reverse=True)
    return [r['symbol'] for r in results[:max_symbols]]


def load_daily_closes(symbol, start_year=2020, end_year=2024):
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return {}
    closes = {}
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
                                date_str = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime('%Y-%m-%d')
                                closes[date_str] = close
                            except (ValueError, IndexError):
                                continue
            except Exception:
                continue
    return closes


def compute_returns(closes):
    dates = sorted(closes.keys())
    ret = {}
    for i in range(1, len(dates)):
        d, prev = dates[i], dates[i - 1]
        if closes[prev] > 0:
            ret[d] = (closes[d] - closes[prev]) / closes[prev]
    return ret


def run_fold(all_dates, returns, btc_closes, train_start, train_end, test_start, test_end):
    """Run one WFO fold: train on train window, test on test window."""
    # In long-only low-vol, there's no model to "train" - it's a fixed rule.
    # So WFO-Lite tests: does the rule work in EACH window independently?

    test_dates = [d for d in all_dates if test_start <= d < test_end]
    if len(test_dates) < 10:
        return None

    # Rebalance every REBAL_DAYS within the test window
    rebalance_indices = list(range(0, len(test_dates), REBAL_DAYS))

    fold_returns = []
    fold_btc_returns = []

    for wi in range(len(rebalance_indices) - 1):
        si = rebalance_indices[wi]
        ei = rebalance_indices[wi + 1]
        window_dates = test_dates[si:ei]

        if len(window_dates) < 2:
            continue

        # Compute vol at rebalance date
        rebal_date = test_dates[si]
        vol_data = {}
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
        n_long = max(1, int(len(ranked) * LONG_PCT))
        long_symbols = [sym for sym, _ in ranked[:n_long]]

        long_rets = []
        for sym in long_symbols:
            s = all_closes[sym].get(window_dates[0])
            e = all_closes[sym].get(window_dates[-1])
            if s and e and s > 0:
                long_rets.append((e - s) / s)

        if long_rets:
            gross = np.mean(long_rets)
            net = gross - COST_BPS / 10000 * 2
            fold_returns.append(net)

            btc_s = btc_closes.get(window_dates[0])
            btc_e = btc_closes.get(window_dates[-1])
            if btc_s and btc_e and btc_s > 0:
                fold_btc_returns.append((btc_e - btc_s) / btc_s)
            else:
                fold_btc_returns.append(0)

    if not fold_returns:
        return None

    return {
        'train_range': f'{train_start} ~ {train_end}',
        'test_range': f'{test_start} ~ {test_end}',
        'n_windows': len(fold_returns),
        'mean_return': float(np.mean(fold_returns)),
        'median_return': float(np.median(fold_returns)),
        'std_return': float(np.std(fold_returns, ddof=1)) if len(fold_returns) > 1 else 0,
        'mean_btc': float(np.mean(fold_btc_returns)) if fold_btc_returns else 0,
        'outperform_rate': sum(1 for r, b in zip(fold_returns, fold_btc_returns) if r > b) / len(fold_returns) if fold_returns else 0,
        'win_rate': sum(1 for r in fold_returns if r > 0) / len(fold_returns),
        'sharpe_window': float(np.mean(fold_returns) / np.std(fold_returns, ddof=1) * np.sqrt(12)) if len(fold_returns) > 1 and np.std(fold_returns, ddof=1) > 0 else 0,
    }


def main():
    print('Discovering symbols...')
    global all_closes
    symbols = discover_symbols(50)
    print(f'  Found {len(symbols)} symbols')

    print('Loading data...')
    all_closes = {}
    for sym in symbols:
        closes = load_daily_closes(sym)
        if closes:
            all_closes[sym] = closes

    btc_closes = all_closes.get('BTCUSDT', {})
    all_dates = sorted(set(d for c in all_closes.values() for d in c.keys()))

    returns = {}
    for sym, closes in all_closes.items():
        returns[sym] = compute_returns(closes)

    print(f'  {len(all_closes)} symbols × {len(all_dates)} days')

    # WFO-Lite: train=365d, test=63d, step=21d
    print('\n=== WFO-Lite (train=365d, test=63d) ===')
    lite_folds = []
    train_days = 365
    test_days = 63
    step_days = 21

    i = 0
    while i + train_days + test_days <= len(all_dates):
        train_start = all_dates[i]
        train_end = all_dates[i + train_days]
        test_start = all_dates[i + train_days]
        test_end = all_dates[min(i + train_days + test_days, len(all_dates) - 1)]

        fold = run_fold(all_dates, returns, btc_closes, train_start, train_end, test_start, test_end)
        if fold:
            lite_folds.append(fold)
        i += step_days

    if lite_folds:
        mean_ics = [f['mean_return'] for f in lite_folds]
        mean_sharpes = [f['sharpe_window'] for f in lite_folds]
        print(f'  Folds: {len(lite_folds)}')
        print(f'  Mean fold return: {np.mean(mean_ics):.4f}')
        print(f'  Mean window Sharpe: {np.mean(mean_sharpes):.2f}')
        print(f'  Fold pass rate (return > 0): {sum(1 for r in mean_ics if r > 0)/len(mean_ics):.2%}')
        print(f'  Fold outperform BTC rate: {np.mean([f["outperform_rate"] for f in lite_folds]):.2%}')

    # WFO-Formal: train=730d, test=90d, step=30d
    print('\n=== WFO-Formal (train=730d, test=90d) ===')
    formal_folds = []
    train_days = 730
    test_days = 90
    step_days = 30

    i = 0
    while i + train_days + test_days <= len(all_dates):
        train_start = all_dates[i]
        train_end = all_dates[i + train_days]
        test_start = all_dates[i + train_days]
        test_end = all_dates[min(i + train_days + test_days, len(all_dates) - 1)]

        fold = run_fold(all_dates, returns, btc_closes, train_start, train_end, test_start, test_end)
        if fold:
            formal_folds.append(fold)
        i += step_days

    if formal_folds:
        mean_ics = [f['mean_return'] for f in formal_folds]
        mean_sharpes = [f['sharpe_window'] for f in formal_folds]
        print(f'  Folds: {len(formal_folds)}')
        print(f'  Mean fold return: {np.mean(mean_ics):.4f}')
        print(f'  Mean window Sharpe: {np.mean(mean_sharpes):.2f}')
        print(f'  Fold pass rate (return > 0): {sum(1 for r in mean_ics if r > 0)/len(mean_ics):.2%}')
        print(f'  Fold outperform BTC rate: {np.mean([f["outperform_rate"] for f in formal_folds]):.2%}')

    # Build report
    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'strategy': 'low_vol_long_only',
        'config': {
            'n_symbols': len(all_closes),
            'rebalance_days': REBAL_DAYS,
            'long_pct': LONG_PCT,
            'cost_bps': COST_BPS,
            'period': f'{all_dates[0]} to {all_dates[-1]}',
        },
        'wfo_lite': {
            'train_days': 365, 'test_days': 63, 'step_days': 21,
            'folds': lite_folds,
            'summary': {
                'fold_count': len(lite_folds),
                'mean_return': float(np.mean([f['mean_return'] for f in lite_folds])) if lite_folds else 0,
                'std_return': float(np.std([f['mean_return'] for f in lite_folds], ddof=1)) if len(lite_folds) > 1 else 0,
                'pass_rate': sum(1 for f in lite_folds if f['mean_return'] > 0) / len(lite_folds) if lite_folds else 0,
                'outperform_btc_rate': float(np.mean([f['outperform_rate'] for f in lite_folds])) if lite_folds else 0,
            },
        },
        'wfo_formal': {
            'train_days': 730, 'test_days': 90, 'step_days': 30,
            'folds': formal_folds,
            'summary': {
                'fold_count': len(formal_folds),
                'mean_return': float(np.mean([f['mean_return'] for f in formal_folds])) if formal_folds else 0,
                'std_return': float(np.std([f['mean_return'] for f in formal_folds], ddof=1)) if len(formal_folds) > 1 else 0,
                'pass_rate': sum(1 for f in formal_folds if f['mean_return'] > 0) / len(formal_folds) if formal_folds else 0,
                'outperform_btc_rate': float(np.mean([f['outperform_rate'] for f in formal_folds])) if formal_folds else 0,
            },
        },
    }

    # M1 gate
    lite_pass = (report['wfo_lite']['summary']['mean_return'] > 0 and
                 report['wfo_lite']['summary']['pass_rate'] > 0.3)
    report['m1_pass'] = lite_pass
    print(f'\nM1 pass: {"✅" if lite_pass else "❌"}')

    out_path = 'data/research/low_vol_wfo_report.json'
    with open(out_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'Report: {out_path}')


if __name__ == '__main__':
    all_closes = {}
    main()
