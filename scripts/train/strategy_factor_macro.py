"""
Factor Momentum + Macro/On-Chain Multi-Factor Strategy.
Two new directions from 2024/2025 academic research.
WFO-Lite on all variants.

Usage: /opt/miniconda3/bin/python3 scripts/train/strategy_factor_macro.py
"""
import json, os, zipfile
from datetime import datetime, timezone, timedelta
from collections import defaultdict
import numpy as np

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'
ONCHAIN = '/Volumes/shield/cryptoData/openalice-data/onchain/coinmetrics/asset_metrics_1d.jsonl'

MAIN = ['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','AVAXUSDT','LINKUSDT','DOTUSDT','UNIUSDT','LTCUSDT','BCHUSDT','ATOMUSDT','NEARUSDT','TRXUSDT','ETCUSDT']

def parse_ts(s):
    ts = int(s)
    if len(s) >= 16: return datetime.fromtimestamp(ts/1000000, tz=timezone.utc).strftime('%Y-%m-%d')
    return datetime.fromtimestamp(ts/1000, tz=timezone.utc).strftime('%Y-%m-%d')

def load_klines():
    d = {}
    for sym in MAIN:
        p = os.path.join(KLINES_DIR, sym, '1d')
        if not os.path.isdir(p): continue
        c = {}
        for zf in sorted(os.listdir(p)):
            if not zf.endswith('.zip'): continue
            try:
                with zipfile.ZipFile(os.path.join(p, zf)) as z:
                    for line in z.read(z.namelist()[0]).decode('utf-8',errors='replace').strip().split('\n'):
                        cols = line.split(',')
                        if len(cols) >= 6:
                            date = parse_ts(cols[0])
                            c[date] = {'close': float(cols[4]), 'vol': float(cols[5])}
            except: continue
        if c: d[sym] = c
    return d

def load_onchain():
    """Load Coin Metrics data for BTC."""
    if not os.path.exists(ONCHAIN): return {}
    data = {}
    with open(ONCHAIN) as f:
        for line in f:
            if not line.strip(): continue
            try:
                import json as j
                row = j.loads(line)
                pl = row.get('payload', {})
                asset = pl.get('asset', '').lower()
                if asset != 'btc': continue
                date = pl.get('time','')[:10]
                data[date] = {
                    'adr_act': float(pl.get('AdrActCnt',0) or 0),
                    'cap_mkt': float(pl.get('CapMrktCurUSD',0) or 0),
                    'fee_ntv': float(pl.get('FeeTotNtv',0) or 0),
                    'tx_cnt': float(pl.get('TxCnt',0) or 0),
                    'price': float(pl.get('PriceUSD',0) or 0),
                }
            except: continue
    return data

def compute_rets(closes):
    rets = {}
    for sym, c in closes.items():
        dates = sorted(c.keys())
        ret = {}
        for i in range(1, len(dates)):
            if c[dates[i-1]]['close'] > 0:
                ret[dates[i]] = (c[dates[i]]['close'] - c[dates[i-1]]['close']) / c[dates[i-1]]['close']
        rets[sym] = ret
    return rets

def zscore(vals):
    m, s = np.mean(vals), np.std(vals, ddof=1)
    return (vals[-1] - m) / s if s > 0 else 0

def main():
    print('Loading data...')
    closes = load_klines()
    rets = compute_rets(closes)
    oc = load_onchain()

    all_dates = sorted(set.intersection(*[set(rets[s].keys()) for s in rets]))
    
    print(f'Common dates: {len(all_dates)}')

    # WFO folds
    folds = []
    i = 0
    while i + 365 + 63 <= len(all_dates):
        folds.append(all_dates[i+365:i+365+63])
        i += 21
    print(f'WFO folds: {len(folds)}')


    # Run strategies
    strategies = {}

    # --- Factor Momentum ---
    print('\n=== Factor Momentum ===')
    fm_folds = []
    for fold in folds:
        fold_rets = []
        for si in range(0, len(fold), 30):
            window = fold[si:si+30]
            if len(window) < 2: continue
            rebal = window[0]

            # Compute 5 factors for all coins
            factor_returns = {}
            for sym in rets:
                r = rets[sym]
                sd = sorted(d for d in r if d <= rebal)
                if len(sd) < 90: continue

                # Factor 1: Low-vol
                v = np.std([r[sd[i]] for i in range(-21,0)], ddof=1)
                # Factor 2: Momentum
                mom = (closes[sym][sd[-1]]['close'] - closes[sym][sd[-61]]['close']) / closes[sym][sd[-61]]['close'] if sd[-61] in closes[sym] and closes[sym][sd[-61]]['close'] > 0 else 0
                # Factor 3: Reversal
                rev = (closes[sym][sd[-1]]['close'] - closes[sym][sd[-6]]['close']) / closes[sym][sd[-6]]['close'] if sd[-6] in closes[sym] and closes[sym][sd[-6]]['close'] > 0 else 0
                # Factor 4: Volume stability
                vols = [closes[sym][sd[i]]['vol'] for i in range(-21,0) if sd[i] in closes[sym]]
                vol_stab = -np.std(vols, ddof=1) / (np.mean(vols) if np.mean(vols) > 0 else 1)
                # Factor 5: Size proxy
                avg_vol = np.mean(vols) if vols else 0

                factor_returns[sym] = [-v, mom, -rev, vol_stab, -avg_vol]

            if len(factor_returns) < 4: continue

            # Factor momentum: compute which factors performed best
            factor_past_returns = []
            for fi in range(5):
                vals = [factor_returns[s][fi] for s in factor_returns]
                factor_past_returns.append(np.mean(vals))

            factor_rank = np.argsort(factor_past_returns)[::-1]
            best_factor = factor_rank[0]

            # Buy coins with best factor
            scores = {s: factor_returns[s][best_factor] for s in factor_returns}
            ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            n_buy = max(1, int(len(ranked) * 0.25))
            buy = [s for s,_ in ranked[:n_buy]]

            ret = 0
            for sym in buy:
                if sym in closes and window[0] in closes[sym] and window[-1] in closes[sym]:
                    s = closes[sym][window[0]]['close']
                    e = closes[sym][window[-1]]['close']
                    if s > 0: ret += (e-s)/s
            ret = ret/len(buy) - 0.0015
            fold_rets.append(ret)

        if fold_rets:
            wr = sum(1 for r in fold_rets if r > 0) / len(fold_rets)
            mean_r = np.mean(fold_rets)
            strategies['factor_momentum'] = {'win_rate': round(wr,4), 'mean_return': round(mean_r,6), 'n': len(fold_rets)}
            print(f'  factor_momentum: wr={wr:.2%}, n={len(fold_rets)}')

    # --- Macro On-Chain Combo ---
    print('\n=== Macro + On-Chain ===')
    mo_folds = []
    for fold in folds:
        fold_rets = []
        for si in range(0, len(fold), 30):
            window = fold[si:si+30]
            if len(window) < 2: continue
            rebal = window[0]

            # Compute on-chain regime
            oc_dates = sorted(oc.keys())
            oc_recent = [d for d in oc_dates if d <= rebal]
            if len(oc_recent) < 60: continue

            addr_now = oc.get(oc_recent[-1], {}).get('adr_act',0)
            addr_30d = [oc.get(d,{}).get('adr_act',0) for d in oc_recent[-30:]]
            addr_60d = [oc.get(d,{}).get('adr_act',0) for d in oc_recent[-60:]]
            addr_growth = (np.mean(addr_30d) - np.mean(addr_60d)) / (np.mean(addr_60d) + 1)

            fee_now = oc.get(oc_recent[-1], {}).get('fee_ntv',0)
            fee_30d = [oc.get(d,{}).get('fee_ntv',0) for d in oc_recent[-30:]]
            fee_60d = [oc.get(d,{}).get('fee_ntv',0) for d in oc_recent[-60:]]
            fee_growth = (np.mean(fee_30d) - np.mean(fee_60d)) / (np.mean(fee_60d) + 1)

            # Compute macro regime from BTC behavior
            btc_rets = [r for d,r in rets.get('BTCUSDT',{}).items() if d <= rebal]
            if len(btc_rets) < 90: continue

            btc_mom_30d = np.mean(btc_rets[-30:]) if len(btc_rets) >= 30 else 0
            btc_vol_30d = np.std(btc_rets[-30:], ddof=1) if len(btc_rets) >= 30 else 1
            btc_sharpe = btc_mom_30d / btc_vol_30d if btc_vol_30d > 0 else 0

            # Compute price factors for each coin
            scores = {}
            for sym in rets:
                r = rets[sym]
                sd = sorted(d for d in r if d <= rebal)
                if len(sd) < 21: continue
                vol_21d = np.std([r[sd[i]] for i in range(-21,0)], ddof=1)

                # On-chain regime: bullish if addr_growth > 0 and fee_growth > 0
                oc_signal = 1 if addr_growth > 0 and fee_growth > 0 else (-1 if addr_growth < 0 and fee_growth < 0 else 0)

                # Macro regime: risk-on if btc_sharpe > 0
                macro_signal = 1 if btc_sharpe > 0 else -1

                # Composite
                scores[sym] = -vol_21d * 0.4 + oc_signal * 0.3 + macro_signal * 0.3

            if len(scores) < 4: continue
            ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
            n_buy = max(1, int(len(ranked) * 0.25))
            buy = [s for s,_ in ranked[:n_buy]]

            ret = 0
            for sym in buy:
                if sym in closes and window[0] in closes[sym] and window[-1] in closes[sym]:
                    s = closes[sym][window[0]]['close']
                    e = closes[sym][window[-1]]['close']
                    if s > 0: ret += (e-s)/s
            ret = ret/len(buy) - 0.0015
            fold_rets.append(ret)

        if fold_rets:
            wr = sum(1 for r in fold_rets if r > 0) / len(fold_rets)
            strategies['macro_onchain'] = {'win_rate': round(wr,4), 'mean_return': round(np.mean(fold_rets),6), 'n': len(fold_rets)}
            print(f'  macro_onchain: wr={wr:.2%}, n={len(fold_rets)}')

    # Baseline: adaptive_vol_15pct
    print('\n=== Baseline ===')
    for fold in folds:
        fold_rets = []
        for si in range(0, len(fold), 60):
            window = fold[si:si+60]
            if len(window) < 2: continue
            rebal = window[0]
            vols = {}
            for sym in rets:
                r = rets[sym]
                sd = sorted(d for d in r if d <= rebal)
                if len(sd) < 21: continue
                v = np.std([r[sd[i]] for i in range(-21,0)], ddof=1)
                if v > 0: vols[sym] = v
            if len(vols) < 3: continue
            ranked = sorted(vols.items(), key=lambda x: x[1])
            n_buy = max(1, int(len(ranked) * 0.15))
            buy = [s for s,_ in ranked[:n_buy]]
            ret = 0
            for sym in buy:
                if sym in closes and window[0] in closes[sym] and window[-1] in closes[sym]:
                    s = closes[sym][window[0]]['close']
                    e = closes[sym][window[-1]]['close']
                    if s > 0: ret += (e-s)/s
            ret = ret/len(buy) - 0.0015
            fold_rets.append(ret)
        if fold_rets:
            wr = sum(1 for r in fold_rets if r > 0) / len(fold_rets)
            strategies['baseline_low_vol'] = {'win_rate': round(wr,4), 'mean_return': round(np.mean(fold_rets),6), 'n': len(fold_rets)}
            print(f'  baseline: wr={wr:.2%}, n={len(fold_rets)}')
        break  # Only first fold for speed

    # Results
    print(f'\n=== Results ===')
    best = max(strategies.items(), key=lambda x: x[1]['win_rate'])
    for name, r in strategies.items():
        icon = '🏆' if r['win_rate'] == best[1]['win_rate'] else ' '
        print(f'{icon} {name}: wr={r["win_rate"]*100:.2f}%, n={r["n"]}')
    print(f'\nBest: {best[0]} at {best[1]["win_rate"]*100:.2f}%')

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'strategies': strategies,
        'best': best[0],
        'best_win_rate': best[1]['win_rate'],
        'beat_baseline': best[1]['win_rate'] > max(r['win_rate'] for k,r in strategies.items() if k != best[0]),
    }
    with open('data/research/strategy_factor_macro_report.json', 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\nReport saved.')

if __name__ == '__main__':
    main()
