#!/usr/bin/env python3
"""
Train DL Model: LogisticRegression on 60-day return statistics -> 21-day direction.

Loads 24 mainstream coins daily Binance data (2017-2023), computes features
from 60-day returns (mean, std, skew, min, max), trains a LogisticRegression
classifier to predict 21-day forward direction.

Saves trained model to models/signals/btc_direction_model.joblib.

Run once at install time. Subsequent daily inference uses the saved model.

Usage:
    cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
    /opt/miniconda3/bin/python3 scripts/train/train_dl_model.py

No secrets, read-only on Binance ZIP data.
"""

import json
import os
import sys
import zipfile
import warnings
from datetime import datetime, timezone

import numpy as np
from scipy.stats import skew
from sklearn.linear_model import LogisticRegression
import joblib

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
BINANCE_BASE = '/Volumes/shield/cryptoData/openalice-data/market/binance-public'
KLINES_DIR = f'{BINANCE_BASE}/spot-all-usdt-klines-1d/spot'
PROJECT_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
)
MODEL_DIR = os.path.join(PROJECT_ROOT, 'models', 'signals')
MODEL_PATH = os.path.join(MODEL_DIR, 'btc_direction_model.joblib')

# 24 mainstream coins (same universe as daily_mainstream_rank_report.py)
MAIN_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
    'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
    'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
    'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
    'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
    'AAVEUSDT', 'MKRUSDT',
]

SEQ_LEN = 60       # lookback window (trading days)
FWD_HORIZON = 21   # forward prediction horizon (trading days)
TRAIN_CUTOFF = '2024-01-01'  # train on samples before this date


def parse_ts_to_date(ts_str: str) -> str:
    """Parse Binance timestamp to YYYY-MM-DD. Handles 13-digit (ms) and 16-digit (us)."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


def load_daily_closes(symbol: str) -> dict[str, float]:
    """Load all daily close prices for a symbol from Binance monthly ZIP files.

    Returns {date_str: close_price} sorted chronologically.
    """
    closes: dict[str, float] = {}
    kline_path = os.path.join(KLINES_DIR, symbol, '1d')
    if not os.path.isdir(kline_path):
        return closes

    for zf in sorted(os.listdir(kline_path)):
        if not zf.endswith('.zip'):
            continue
        fpath = os.path.join(kline_path, zf)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode('utf-8', errors='replace')
                for line in text.strip().split('\n'):
                    cols = line.split(',')
                    if len(cols) < 5:
                        continue
                    try:
                        d = parse_ts_to_date(cols[0])
                        close = float(cols[4])
                        closes[d] = close
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue
    return closes


def compute_features_and_target(
    closes: dict[str, float],
    max_date: str | None = None,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Compute 5 statistical features from 60-day returns + 21-day direction target.

    For each date d with enough data:
      Features: [mean, std, skew, min, max] of the 60 daily returns ending at d
      Target:   1 if 21-day forward return > 0, else 0

    Args:
        closes: {date_str: close_price}
        max_date: If set, skip samples where date >= max_date.

    Returns:
        (X, y, sample_dates)
        X: (n_samples, 5) feature matrix
        y: (n_samples,) binary labels
        sample_dates: list of date strings corresponding to each sample
    """
    dates = sorted(closes.keys())
    if len(dates) < SEQ_LEN + FWD_HORIZON + 1:
        return np.empty((0, 5)), np.empty(0), []

    # Precompute daily returns {date: return}
    daily_rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        prev = closes[dates[i - 1]]
        if prev > 0:
            daily_rets[dates[i]] = (closes[dates[i]] - prev) / prev

    # Precompute 21-day forward returns
    fwd_rets: dict[str, float] = {}
    for i in range(len(dates) - FWD_HORIZON):
        p = closes[dates[i]]
        if p > 0:
            fwd_rets[dates[i]] = (closes[dates[i + FWD_HORIZON]] - p) / p

    X_list: list[np.ndarray] = []
    y_list: list[int] = []
    date_list: list[str] = []

    for i in range(SEQ_LEN, len(dates)):
        d = dates[i]

        # Filter to training period
        if max_date is not None and d >= max_date:
            continue
        if d not in fwd_rets:
            continue

        # Collect 60 daily returns ending at date d
        lookback_rets = []
        valid = True
        for j in range(i - SEQ_LEN + 1, i + 1):
            r = daily_rets.get(dates[j])
            if r is None:
                valid = False
                break
            lookback_rets.append(r)

        if not valid or len(lookback_rets) != SEQ_LEN:
            continue

        rets_arr = np.array(lookback_rets, dtype=np.float64)

        # Statistical features: mean, std, skew, min, max
        feat_mean = float(np.mean(rets_arr))
        feat_std = float(np.std(rets_arr, ddof=1))
        feat_skew = float(skew(rets_arr))
        feat_min = float(np.min(rets_arr))
        feat_max = float(np.max(rets_arr))

        # Binary target: 1 if 21-day forward return is positive
        label = 1 if fwd_rets[d] > 0 else 0

        X_list.append(np.array([feat_mean, feat_std, feat_skew, feat_min, feat_max],
                                dtype=np.float64))
        y_list.append(label)
        date_list.append(d)

    if not X_list:
        return np.empty((0, 5)), np.empty(0), []

    return np.array(X_list, dtype=np.float64), np.array(y_list, dtype=np.int64), date_list


def main() -> None:
    print('=' * 60)
    print('BTC DIRECTION MODEL TRAINER')
    print('=' * 60)
    print(f'\nTraining period: before {TRAIN_CUTOFF}')
    print(f'Features:  60-day returns -> [mean, std, skew, min, max]')
    print(f'Target:    21-day forward direction (binary)')
    print(f'Symbols:   {len(MAIN_SYMBOLS)} mainstream coins\n')

    # ------------------------------------------------------------------
    # Step 1: Load all symbols and compute features
    # ------------------------------------------------------------------
    all_X: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    loaded_symbols: list[str] = []
    total_samples = 0

    for sym in MAIN_SYMBOLS:
        closes = load_daily_closes(sym)
        if not closes:
            print(f'  {sym}: NO DATA -- skipping')
            continue

        X, y, dates = compute_features_and_target(closes, max_date=TRAIN_CUTOFF)
        if len(X) == 0:
            print(f'  {sym}: insufficient data -- skipping')
            continue

        all_X.append(X)
        all_y.append(y)
        loaded_symbols.append(sym)
        total_samples += len(X)

        pos_ratio = y.mean()
        date_range = f'{dates[0]} .. {dates[-1]}'
        print(f'  {sym}: {len(X)} samples, {pos_ratio:.1%} positive, {date_range}')

    if not all_X:
        print('\nFATAL: No training data available from any symbol')
        sys.exit(1)

    X_full = np.concatenate(all_X, axis=0)
    y_full = np.concatenate(all_y, axis=0)

    print(f'\n{"=" * 60}')
    print(f'Training dataset:')
    print(f'  Symbols loaded:   {len(loaded_symbols)}/{len(MAIN_SYMBOLS)}')
    print(f'  Total samples:    {total_samples}')
    print(f'  Positive ratio:   {y_full.mean():.1%}')
    print(f'  Feature dims:     {X_full.shape[1]}')

    if len(X_full) < 100:
        print('\nFATAL: Too few training samples (< 100)')
        sys.exit(1)

    # ------------------------------------------------------------------
    # Step 2: Train LogisticRegression
    # ------------------------------------------------------------------
    print(f'\n{"=" * 60}')
    print('Training LogisticRegression...')

    model = LogisticRegression(
        C=1.0,
        l1_ratio=0,
        solver='lbfgs',
        max_iter=1000,
        class_weight='balanced',
        random_state=42,
    )
    model.fit(X_full, y_full)

    # ------------------------------------------------------------------
    # Step 3: Evaluate
    # ------------------------------------------------------------------
    train_preds = model.predict(X_full)
    train_acc = float(np.mean(train_preds == y_full))
    train_probs = model.predict_proba(X_full)[:, 1]

    # Brier score (calibration)
    brier = float(np.mean((train_probs - y_full) ** 2))

    # Precision/recall for positive class
    tp = int(np.sum((train_preds == 1) & (y_full == 1)))
    fp = int(np.sum((train_preds == 1) & (y_full == 0)))
    fn = int(np.sum((train_preds == 0) & (y_full == 1)))
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    # Feature coefficients
    feature_names = ['mean_ret', 'std_ret', 'skew_ret', 'min_ret', 'max_ret']
    coefs = model.coef_[0]
    intercept = float(model.intercept_[0])

    print(f'  Accuracy:     {train_acc:.2%}')
    print(f'  Precision:    {precision:.2%}')
    print(f'  Recall:       {recall:.2%}')
    print(f'  F1-score:     {f1:.2%}')
    print(f'  Brier score:  {brier:.4f}')
    print(f'  Intercept:    {intercept:.4f}')
    print(f'  Coefficients:')
    for name, coef in zip(feature_names, coefs):
        print(f'    {name:12s}: {coef:+.4f}')

    # ------------------------------------------------------------------
    # Step 4: Save model and metadata
    # ------------------------------------------------------------------
    metadata = {
        'model_type': 'LogisticRegression',
        'features': feature_names,
        'seq_len_days': SEQ_LEN,
        'fwd_horizon_days': FWD_HORIZON,
        'trained_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'n_training_samples': int(len(X_full)),
        'n_symbols_trained': len(loaded_symbols),
        'n_symbols_total': len(MAIN_SYMBOLS),
        'training_accuracy': train_acc,
        'training_precision': precision,
        'training_recall': recall,
        'training_f1_score': f1,
        'brier_score': brier,
        'coefficients': {name: float(coef) for name, coef in zip(feature_names, coefs)},
        'intercept': intercept,
    }

    os.makedirs(MODEL_DIR, exist_ok=True)
    joblib.dump({'model': model, 'metadata': metadata}, MODEL_PATH)

    report_path = os.path.join(MODEL_DIR, 'btc_direction_model_training_report.json')
    with open(report_path, 'w') as f:
        json.dump(metadata, f, indent=2)

    print(f'\n{"=" * 60}')
    print(f'Model saved to:  {MODEL_PATH}')
    print(f'Report saved to: {report_path}')
    print('Training complete.')


if __name__ == '__main__':
    main()
