"""
Leverage test — test V6a adaptive strategy at different leverage levels (1x to 100x).

Usage: /opt/miniconda3/bin/python3 scripts/train/leverage_test.py
"""
import json, os, zipfile
from datetime import datetime, timezone
import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'

MAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT','NEARUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT', 'AAVEUSDT']

LEVERAGE_LEVELS = [1, 2, 3, 5, 10, 20, 50, 100]

def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_all():
    all_closes = {}
    for sym in MAIN_SYMBOLS:
        path = os.path.join(KLINES_DIR, sym, '1d')
        if not os.path.isdir(path): continue
        closes = {}
        for zf in sorted(os.listdir(path))[:]:
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
                                vol = float(cols[5])
                                date = parse_ts_to_date(cols[0])
                                closes[date] = {'close': close, 'vol': vol}
                            except: pass
            except: continue
        if closes: all_closes[sym] = closes
    return all_closes


def main():
    print('Loading data...')
    all_closes = load_all()
    all_dates = sorted(set(d for closes in all_closes.values() for d in closes.keys()))
    # Using all loaded dates

    # Simple V6a strategy: 60d vol, bottom 20%, cap-weighted, 60d rebalance
    print(f'Running leverage test on {len(all_dates)} days, {len(all_closes)} symbols')
    print()

    # Compute daily returns
    returns = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        ret = {}
        for i in range(1, len(dates)):
            if closes[dates[i-1]]['close'] > 0:
                ret[dates[i]] = (closes[dates[i]]['close'] - closes[dates[i-1]]['close']) / closes[dates[i-1]]['close']
        returns[sym] = ret

    # Compute 60d vol
    vol60 = {}
    for sym, ret in returns.items():
        dates = sorted(ret.keys())
        vol60[sym] = {}
        for i in range(60, len(dates)):
            w = [ret[dates[j]] for j in range(i-59, i+1)]
            v = np.std(w, ddof=1)
            if v > 0 and not np.isnan(v):
                vol60[sym][dates[i]] = v

    # WFO folds
    folds = []
    i = 0
    while i + 365 + 63 <= len(all_dates):
        folds.append({'train': all_dates[i:i+365], 'test': all_dates[i+365:i+365+63]})
        i += 21
    print(f'WFO folds: {len(folds)}')

    results = {}
    for leverage in LEVERAGE_LEVELS:
        fold_returns = []
        for fold in folds:
            test = fold['test']
            for si in range(0, len(test), 60):
                ei = min(si + 60, len(test))
                window = test[si:ei]
                if len(window) < 2: continue

                rebal_date = window[0]
                # Compute vol at rebalance
                vols = {}
                for sym in all_closes:
                    v = vol60.get(sym, {}).get(rebal_date)
                    if v and v > 0:
                        vols[sym] = v

                if len(vols) < 3: continue

                # Volume floor
                med_vol = np.median(list(vols.values()))
                vols = {s: v for s, v in vols.items() if v <= med_vol * 1.5}
                if len(vols) < 3: continue

                # Select bottom 20%
                ranked = sorted(vols.items(), key=lambda x: x[1])
                n_buy = max(1, int(len(ranked) * 0.2))
                buy = [s for s, _ in ranked[:n_buy]]

                # Market-cap weighted
                total = sum(1.0/vols[s] for s in buy)
                weights = {s: (1.0/vols[s])/total for s in buy}

                # Compute period return
                period_ret = 0.0
                for sym in buy:
                    if sym in all_closes and window[0] in all_closes[sym] and window[-1] in all_closes[sym]:
                        s = all_closes[sym][window[0]]['close']
                        e = all_closes[sym][window[-1]]['close']
                        if s > 0:
                            period_ret += ((e - s) / s) * weights.get(sym, 0)

                # Apply leverage
                leveraged_ret = period_ret * leverage

                # Apply costs (higher for higher leverage - more frequent rebalancing risk)
                cost = 0.0015 * (1 + leverage * 0.01)  # 15bps base + 1% of leverage as additional risk
                leveraged_ret -= cost

                # Liquidation check: if return drops below -100%, position is liquidated
                if leveraged_ret < -1.0:
                    leveraged_ret = -1.0  # Max loss is 100%

                fold_returns.append(leveraged_ret)

        if not fold_returns:
            results[leverage] = {'win_rate': 0, 'n_periods': 0}
            continue

        wins = sum(1 for r in fold_returns if r > 0)
        total_wr = wins / len(fold_returns)
        mean_r = np.mean(fold_returns)
        std_r = np.std(fold_returns, ddof=1) if len(fold_returns) > 1 else 1
        holding_days = 60
        annual_factor = 365.25 / holding_days
        sharpe = mean_r / std_r * np.sqrt(annual_factor) if std_r > 0 else 0
        max_dd = 0
        peak = 1
        cum = 1
        for r in fold_returns:
            cum *= (1 + r)
            peak = max(peak, cum)
            dd = (peak - cum) / peak
            max_dd = max(max_dd, dd)

        results[leverage] = {
            'leverage': leverage,
            'win_rate': round(total_wr, 4),
            'mean_return': round(mean_r, 6),
            'sharpe': round(sharpe, 4),
            'max_drawdown': round(max_dd, 4),
            'n_periods': len(fold_returns),
            'total_return': round(cum - 1, 4),
        }
        print(f'{leverage}x: win_rate={total_wr:.2%}, sharpe={sharpe:.2f}, max_dd={max_dd:.2%}, total_ret={cum-1:.2%}')

    # Find best leverage
    best_lev = max(results.items(), key=lambda x: x[1].get('win_rate', 0))

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'strategy': 'adaptive_v6a_leverage_test',
        'leverage_results': results,
        'best_leverage': best_lev[0],
        'best_win_rate': best_lev[1]['win_rate'],
    }
    with open('data/research/leverage_test_report.json', 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\nBest leverage: {best_lev[0]}x at {best_lev[1]["win_rate"]:.2%} win rate')


if __name__ == '__main__':
    main()
