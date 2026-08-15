"""
Funding rate cross-sectional strategy — using MPS if available.
Tests 3 strategies on cross-sectional funding rate data.

Usage: /opt/miniconda3/bin/python3 scripts/train/strategy_funding.py
"""
import json, os, sys, zipfile
from datetime import datetime, timezone
from collections import defaultdict
import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
FUND_DIR = f'{BASE}/um-all-usdt-fundingRate/um/fundingRate'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'

MAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT', 'NEARUSDT']

# Try MPS
try:
    import torch
    DEVICE = 'mps' if torch.backends.mps.is_available() else 'cpu'
except:
    DEVICE = 'cpu'
print(f'Using device: {DEVICE}')

def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_funding(symbol, start_year=2020, end_year=2024):
    path = os.path.join(FUND_DIR, symbol)
    if not os.path.isdir(path): return {}
    rates = {}
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            fname = f'{symbol}-fundingRate-{year}-{month:02d}.zip'
            fpath = os.path.join(path, fname)
            if not os.path.exists(fpath): continue
            try:
                with zipfile.ZipFile(fpath) as z:
                    text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                    for line in text.strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 2:
                            try:
                                ts = int(cols[0])
                                rate = float(cols[1])
                                date = parse_ts_to_date(cols[0])
                                rates[date] = rate
                            except: pass
            except: continue
    return rates


def load_closes(symbol):
    path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(path): return {}
    closes = {}
    for zf in sorted(os.listdir(path))[-12:]:
        if not zf.endswith('.zip'): continue
        try:
            with zipfile.ZipFile(os.path.join(path, zf)) as z:
                text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) >= 5:
                        try:
                            ts_us = int(cols[0])
                            close = float(cols[4])
                            date = parse_ts_to_date(cols[0])
                            closes[date] = close
                        except: pass
        except: continue
    return closes


def wfo_split(all_dates, train_days=365, test_days=63, step_days=21):
    folds = []
    i = 0
    while i + train_days + test_days <= len(all_dates):
        folds.append({
            'train': all_dates[i:i+train_days],
            'test': all_dates[i+train_days:i+train_days+test_days],
        })
        i += step_days
    return folds


def run_strategy(name, strategy_fn, wfo_folds):
    results = []
    for fold in wfo_folds:
        res = strategy_fn(fold['train'], fold['test'])
        results.append(res)
    wins = sum(1 for r in results if r > 0)
    mean_r = np.mean(results) if results else 0
    std_r = np.std(results, ddof=1) if len(results) > 1 else 1
    return {
        'win_rate': round(wins / len(results), 4) if results else 0,
        'mean_return': round(mean_r, 6),
        'sharpe': round(mean_r / std_r * np.sqrt(12), 4) if std_r > 0 else 0,
        'n_folds': len(results),
        'n_wins': wins,
    }


def main():
    print('Loading funding data...')
    all_funding = {}
    for sym in MAIN_SYMBOLS:
        rates = load_funding(sym)
        if rates: all_funding[sym] = rates

    print('Loading daily closes...')
    all_closes = {}
    for sym in MAIN_SYMBOLS:
        closes = load_closes(sym)
        if closes: all_closes[sym] = closes

    # Build daily returns
    returns = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        ret = {}
        for i in range(1, len(dates)):
            if closes[dates[i-1]] > 0:
                ret[dates[i]] = (closes[dates[i]] - closes[dates[i-1]]) / closes[dates[i-1]]
        returns[sym] = ret

    # Build consolidated daily vol
    vol = {}
    for sym, ret in returns.items():
        dates = sorted(ret.keys())
        vol[sym] = {}
        for i in range(21, len(dates)):
            v = np.std([ret[d] for d in dates[i-20:i+1]], ddof=1)
            vol[sym][dates[i]] = v

    all_dates = sorted(set(d for sym in all_funding for d in all_funding[sym]))
    all_dates = [d for d in all_dates if d >= '2020-01-01' and d <= '2024-06-30']
    print(f'Total dates: {len(all_dates)}')

    wfo = wfo_split(all_dates, 365, 63, 21)
    print(f'WFO folds: {len(wfo)}')

    # Strategy A: Funding reversal (long most negative funding)
    def strat_a(train, test):
        fold_rets = []
        for i in range(0, len(test), 7):
            week = test[i:i+7]
            if len(week) < 2: continue
            # Get funding at start of week
            funding_vals = {}
            for sym in MAIN_SYMBOLS:
                f = all_funding.get(sym, {})
                dates = [d for d in f if d <= week[0]]
                if dates: funding_vals[sym] = f[dates[-1]]
            if len(funding_vals) < 4: continue
            ranked = sorted(funding_vals.items(), key=lambda x: x[1])
            long = [s for s, _ in ranked[:max(1, len(ranked)//4)]]
            short = [s for s, _ in ranked[-max(1, len(ranked)//4):]]

            long_ret, short_ret = [], []
            for sym in long:
                if sym in returns and week[-1] in returns[sym]:
                    long_ret.append(returns[sym][week[-1]])
            for sym in short:
                if sym in returns and week[-1] in returns[sym]:
                    short_ret.append(returns[sym][week[-1]])

            if long_ret and short_ret:
                net = np.mean(long_ret) - np.mean(short_ret) - 0.003
                fold_rets.append(net)
        return np.mean(fold_rets) if fold_rets else 0

    # Strategy B: Funding + low-vol combo
    def strat_b(train, test):
        fold_rets = []
        for i in range(0, len(test), 21):
            period = test[i:i+21]
            if len(period) < 2: continue
            scores = {}
            for sym in MAIN_SYMBOLS:
                # Funding score
                f = all_funding.get(sym, {})
                f_dates = [d for d in f if d <= period[0]]
                if not f_dates: continue
                f_val = f[f_dates[-1]]
                # Vol score
                v = vol.get(sym, {})
                v_dates = [d for d in v if d <= period[0]]
                if not v_dates: continue
                v_val = v[v_dates[-1]]
                # Composite: high funding (negative) + low vol
                scores[sym] = (-f_val / 0.001) + (-v_val / 0.01) if v_val > 0 else -f_val

            if len(scores) < 4: continue
            ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            buy = [s for s, _ in ranked[:max(1, len(ranked)//4)]]

            rets = []
            for sym in buy:
                if sym in returns and period[-1] in returns[sym]:
                    rets.append(returns[sym][period[-1]])
            if rets:
                fold_rets.append(np.mean(rets) - 0.0015)
        return np.mean(fold_rets) if fold_rets else 0

    # Strategy C: Funding momentum
    def strat_c(train, test):
        fold_rets = []
        for i in range(0, len(test), 7):
            week = test[i:i+7]
            if len(week) < 2: continue
            funding_chg = {}
            for sym in MAIN_SYMBOLS:
                f = all_funding.get(sym, {})
                dates = sorted([d for d in f if d <= week[0]])
                if len(dates) < 8: continue
                chg = f[dates[-1]] - f[dates[-8]]
                funding_chg[sym] = chg
            if len(funding_chg) < 4: continue
            ranked = sorted(funding_chg.items(), key=lambda x: x[1], reverse=True)
            buy = [s for s, _ in ranked[:max(1, len(ranked)//4)]]
            rets = []
            for sym in buy:
                if sym in returns and week[-1] in returns[sym]:
                    rets.append(returns[sym][week[-1]])
            if rets:
                fold_rets.append(np.mean(rets) - 0.0015)
        return np.mean(fold_rets) if fold_rets else 0

    results = {}
    for name, fn in [('funding_reversal', strat_a), ('funding_vol_combo', strat_b), ('funding_momentum', strat_c)]:
        r = run_strategy(name, fn, wfo)
        results[name] = r
        print(f'{name}: win_rate={r["win_rate"]:.2%}, sharpe={r["sharpe"]:.2f}, folds={r["n_folds"]}')

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'device': DEVICE,
        'strategies': results,
        'best': max(results.items(), key=lambda x: x[1]['win_rate'])[0],
        'best_win_rate': max(r['win_rate'] for r in results.values()),
    }
    with open('data/research/strategy_funding_report.json', 'w') as f:
        json.dump(report, f, indent=2)
    print(f'Report saved. Best: {report[\"best\"]} ({report[\"best_win_rate\"]:.2%})')


if __name__ == '__main__':
    main()
