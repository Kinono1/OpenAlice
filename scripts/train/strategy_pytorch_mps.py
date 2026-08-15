"""
PyTorch + MPS neural network factor combiner.

Uses Apple M4 Pro GPU (MPS) to train a small neural network
that combines multiple factors into a composite score.

Usage: /opt/miniconda3/bin/python3 scripts/train/strategy_pytorch_mps.py
"""
import json, os, sys, zipfile
from datetime import datetime, timezone
import numpy as np

import torch
import torch.nn as nn
import torch.optim as optim

DEVICE = 'mps' if torch.backends.mps.is_available() else 'cpu'
print(f'Device: {DEVICE} (torch {torch.__version__})')

BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BASE}/spot-all-usdt-klines-1d/spot'

MAIN_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT','NEARUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT', 'AAVEUSDT']

def parse_ts_to_date(ts_str):
    """Adaptive timestamp: 13 digits = ms, 16 digits = μs."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_closes(symbol):
    path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(path): return {}
    closes = {}
    for zf in sorted(os.listdir(path)):
        if not zf.endswith('.zip'): continue
        try:
            with zipfile.ZipFile(os.path.join(path, zf)) as z:
                text = z.read(z.namelist()[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) >= 5:
                        try:
                            ts = int(cols[0])
                            close = float(cols[4])
                            date = datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
                            closes[date] = close
                        except: pass
        except: continue
    return closes


class FactorNet(nn.Module):
    """Small neural network for factor combination."""
    def __init__(self, n_factors=5, hidden=32):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(n_factors, hidden),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(hidden, hidden // 2),
            nn.ReLU(),
            nn.Linear(hidden // 2, 1),
        )

    def forward(self, x):
        return self.net(x).squeeze()


def main():
    print('Loading data...')
    all_closes = {}
    for sym in MAIN_SYMBOLS:
        c = load_closes(sym)
        if c: all_closes[sym] = c

    # Build daily returns for each symbol
    all_ret = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        ret = {}
        for i in range(1, len(dates)):
            if closes[dates[i-1]] > 0:
                ret[dates[i]] = (closes[dates[i]] - closes[dates[i-1]]) / closes[dates[i-1]]
        all_ret[sym] = ret

    # Build factor matrix (date × symbol × factor)
    all_dates = sorted(set(d for sym in all_ret for d in all_ret[sym]))
    all_dates = [d for d in all_dates if '2020-01-01' <= d <= '2024-06-30']
    print(f'Dates: {len(all_dates)}, Symbols: {len(MAIN_SYMBOLS)}')

    # Precompute factors for each date-symbol
    # Factor 1: 21d vol
    vol = {}
    for sym, ret in all_ret.items():
        dates = sorted(ret.keys())
        vol[sym] = {}
        for i in range(21, len(dates)):
            v = float(np.std([ret[dates[j]] for j in range(i-20, i+1)], ddof=1))
            vol[sym][dates[i]] = v if v > 0 else 0.001

    # Factor 2: 5d return
    # Factor 3: 21d return
    # Factor 4: 21d volume z-score proxy (daily range as proxy)
    range_21d = {}
    for sym, closes in all_closes.items():
        dates = sorted(closes.keys())
        range_21d[sym] = {}
        for i in range(21, len(dates)):
            vals = []
            for j in range(i-20, i+1):
                d = dates[j]
                c = closes.get(d, 0)
                vals.append(c)
            r = max(vals) - min(vals) if vals else 0
            range_21d[sym][dates[i]] = r / (np.mean(vals) if np.mean(vals) > 0 else 1)

    # Factor 5: BTC relative strength (symbol return / BTC return)
    btc_ret = all_ret.get('BTCUSDT', {})

    # Build dataset: each row = one date-symbol with 5 factors → forward 21d return
    X, y = [], []
    date_splits = []

    for sym in MAIN_SYMBOLS:
        dates = sorted(all_ret.get(sym, {}).keys())
        for i in range(21, len(dates) - 21):
            d = dates[i]
            fwd_d = dates[i + 21]
            if fwd_d not in all_ret[sym]:
                continue

            f1 = vol.get(sym, {}).get(d)
            f2 = (all_ret[sym][dates[i]] - all_ret[sym][dates[i-4]]) / 4 if i >= 4 else None
            f3 = (all_ret[sym][dates[i]] - all_ret[sym][dates[i-20]]) / 20 if i >= 20 else None
            f4 = range_21d.get(sym, {}).get(d)
            f5 = (all_ret[sym][d] / btc_ret.get(d, 1)) if sym != 'BTCUSDT' and btc_ret.get(d, 0) != 0 else 0

            features = [f1, f2, f3, f4, f5]
            if any(v is None for v in features):
                continue

            target = all_ret[sym][fwd_d]
            X.append(features)
            y.append(target)
            date_splits.append(d)

    X = np.array(X, dtype=np.float32)
    y = np.array(y, dtype=np.float32)
    print(f'Dataset: {X.shape[0]} samples, {X.shape[1]} features')

    # WFO split: train first 80%, test last 20%
    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    # Z-score normalize
    mean, std = X_train.mean(axis=0), X_train.std(axis=0) + 1e-8
    X_train = (X_train - mean) / std
    X_test = (X_test - mean) / std

    # Convert to tensors
    X_t = torch.FloatTensor(X_train).to(DEVICE)
    y_t = torch.FloatTensor(y_train).to(DEVICE)
    X_te = torch.FloatTensor(X_test).to(DEVICE)
    y_te = torch.FloatTensor(y_test).to(DEVICE)

    # Train simple linear model + small NN
    models = {
        'linear': nn.Linear(5, 1).to(DEVICE),
        'net': FactorNet(5, 32).to(DEVICE),
    }

    results = {}
    for name, model in models.items():
        optimizer = optim.Adam(model.parameters(), lr=0.01)
        criterion = nn.MSELoss()

        model.train()
        for epoch in range(100):
            optimizer.zero_grad()
            pred = model(X_t)
            loss = criterion(pred, y_t)
            loss.backward()
            optimizer.step()

        # Evaluate
        model.eval()
        with torch.no_grad():
            pred_train = model(X_t).cpu().numpy()
            pred_test = model(X_te).cpu().numpy()

        # Directional accuracy
        train_dir = np.mean((pred_train > 0) == (y_train > 0))
        test_dir = np.mean((pred_test > 0) == (y_test > 0))
        from scipy.stats import spearmanr
        train_ic = spearmanr(pred_train, y_train)[0] if len(pred_train) > 3 else 0
        test_ic = spearmanr(pred_test, y_test)[0] if len(pred_test) > 3 else 0

        results[name] = {
            'train_directional_acc': float(train_dir),
            'test_directional_acc': float(test_dir),
            'train_spearman_ic': float(train_ic),
            'test_spearman_ic': float(test_ic),
        }
        print(f'{name}: train_acc={train_dir:.2%}, test_acc={test_dir:.2%}, test_ic={test_ic:.4f}')

    # Baseline: simple average of factors
    simple_pred = X_test.mean(axis=1)
    simple_dir = np.mean((simple_pred > 0) == (y_test > 0))
    simple_ic = spearmanr(simple_pred, y_test)[0] if len(simple_pred) > 3 else 0
    results['simple_average'] = {
        'test_directional_acc': float(simple_dir),
        'test_spearman_ic': float(simple_ic),
    }
    print(f'simple_avg: test_acc={simple_dir:.2%}, test_ic={simple_ic:.4f}')

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'device': DEVICE,
        'dataset': {'n_samples': len(X), 'n_features': 5, 'n_train': len(X_train), 'n_test': len(X_test)},
        'results': results,
        'best_test_ic': max(r.get('test_spearman_ic', 0) for r in results.values()),
    }
    with open('data/research/strategy_pytorch_report.json', 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\nReport saved. Best test IC: {report["best_test_ic"]:.4f}')


if __name__ == '__main__':
    main()
