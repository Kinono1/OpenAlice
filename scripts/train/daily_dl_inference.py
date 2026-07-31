#!/usr/bin/env python3
"""
Daily DL Inference Report

Loads the trained LogisticRegression model (models/signals/btc_direction_model.joblib),
computes 60-day return statistics from latest BTC Binance data, and predicts
21-day direction with confidence.

Part of the daily low-vol observer pipeline.

Output: data/research/daily_dl_inference_report.json

Usage:
    cd /Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice
    /opt/miniconda3/bin/python3 scripts/train/daily_dl_inference.py
    cat data/research/daily_dl_inference_report.json

No secrets, read-only on model file and Binance data.
"""

import json
import os
import sys
import zipfile
import warnings
from datetime import datetime, timezone

import numpy as np
from scipy.stats import skew
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
MODEL_PATH = os.path.join(PROJECT_ROOT, 'models', 'signals', 'btc_direction_model.joblib')
OUTPUT_PATH = os.path.join(PROJECT_ROOT, 'data', 'research', 'daily_dl_inference_report.json')

SEQ_LEN = 60       # must match train script
FWD_HORIZON = 21   # prediction horizon (for reference only)


# ---------------------------------------------------------------------------
# Timestamp parsing
# ---------------------------------------------------------------------------

def parse_ts_to_date(ts_str: str) -> str:
    """Parse Binance timestamp to YYYY-MM-DD. Handles 13-digit (ms) and 16-digit (us)."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc).strftime('%Y-%m-%d')
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime('%Y-%m-%d')


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def load_model() -> tuple:
    """Load trained model and metadata from joblib file.

    Returns:
        (model, metadata) tuple.
    """
    if not os.path.isfile(MODEL_PATH):
        print(f'ERROR: Model not found at {MODEL_PATH}')
        print('Run scripts/train/train_dl_model.py first.')
        sys.exit(1)

    data = joblib.load(MODEL_PATH)
    return data['model'], data.get('metadata', {})


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_btc_closes() -> dict[str, float]:
    """Load ALL daily close prices for BTCUSDT from Binance ZIP files.

    Returns {date_str: close_price} sorted chronologically.
    """
    closes: dict[str, float] = {}
    kline_path = os.path.join(KLINES_DIR, 'BTCUSDT', '1d')
    if not os.path.isdir(kline_path):
        print(f'  ERROR: BTC kline directory not found: {kline_path}')
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


# ---------------------------------------------------------------------------
# Feature computation (must match training script)
# ---------------------------------------------------------------------------

def compute_btc_features(closes: dict[str, float]) -> tuple[list[str], np.ndarray]:
    """Compute 5 statistical features from 60-day returns for every valid date.

    Features: [mean, std, skew, min, max] of 60 daily returns.

    Args:
        closes: {date_str: close_price}

    Returns:
        (dates, X) where X is (n_valid_dates, 5).
    """
    dates = sorted(closes.keys())
    if len(dates) < SEQ_LEN + 1:
        return [], np.empty((0, 5))

    # Precompute daily returns
    daily_rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        prev = closes[dates[i - 1]]
        if prev > 0:
            daily_rets[dates[i]] = (closes[dates[i]] - prev) / prev

    valid_dates: list[str] = []
    X_list: list[np.ndarray] = []

    for i in range(SEQ_LEN, len(dates)):
        d = dates[i]

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

        # Statistical features (same as training)
        feat_mean = float(np.mean(rets_arr))
        feat_std = float(np.std(rets_arr, ddof=1))
        feat_skew = float(skew(rets_arr))
        feat_min = float(np.min(rets_arr))
        feat_max = float(np.max(rets_arr))

        valid_dates.append(d)
        X_list.append(np.array([feat_mean, feat_std, feat_skew, feat_min, feat_max],
                                dtype=np.float64))

    if not X_list:
        return [], np.empty((0, 5))

    return valid_dates, np.array(X_list, dtype=np.float64)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print('=' * 60)
    print('DAILY DL INFERENCE REPORT')
    print('=' * 60)

    # ------------------------------------------------------------------
    # Step 1: Load model
    # ------------------------------------------------------------------
    print('\n[1/4] Loading trained model...')
    model, metadata = load_model()
    feature_names = metadata.get('features', [])
    print(f'  Model:        {metadata.get("model_type", "unknown")}')
    print(f'  Trained at:   {metadata.get("trained_at", "unknown")}')
    print(f'  Features:     {feature_names}')
    print(f'  Train acc:    {metadata.get("training_accuracy", "?"):.1%}')

    # ------------------------------------------------------------------
    # Step 2: Load BTC data
    # ------------------------------------------------------------------
    print('\n[2/4] Loading BTC daily closes...')
    closes = load_btc_closes()
    if not closes:
        report = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'status': 'data_missing',
            'message': 'No BTCUSDT daily close data available from Binance',
            'prediction': None,
        }
        os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
        with open(OUTPUT_PATH, 'w') as f:
            json.dump(report, f, indent=2)
        print(f'\nERROR: No BTC data')
        print(f'Output: {OUTPUT_PATH}')
        return

    print(f'  {len(closes)} daily closes loaded')
    print(f'  Date range: {min(closes.keys())} to {max(closes.keys())}')

    # ------------------------------------------------------------------
    # Step 3: Compute features and predict
    # ------------------------------------------------------------------
    print('\n[3/4] Computing features and running inference...')

    feature_dates, X = compute_btc_features(closes)

    if len(feature_dates) == 0:
        report = {
            'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
            'status': 'insufficient_data',
            'message': f'Need at least {SEQ_LEN + 1} trading days of BTC data',
            'n_days_available': len(closes),
            'prediction': None,
        }
        os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
        with open(OUTPUT_PATH, 'w') as f:
            json.dump(report, f, indent=2)
        print(f'\nERROR: Insufficient data (need {SEQ_LEN + 1} days, have {len(closes)})')
        print(f'Output: {OUTPUT_PATH}')
        return

    print(f'  {len(feature_dates)} feature dates computed')
    print(f'  Date range: {feature_dates[0]} to {feature_dates[-1]}')

    # --- Latest prediction ---
    latest_date = feature_dates[-1]
    latest_features = X[-1:]  # (1, 5)

    pred_proba = model.predict_proba(latest_features)[0]
    pred_class = int(model.predict(latest_features)[0])
    # Confidence = probability of the predicted class
    confidence = float(pred_proba[pred_class])

    direction = 'up' if pred_class == 1 else 'down'
    up_prob = float(pred_proba[1])
    down_prob = float(pred_proba[0])

    # --- Recent trend: predict over last N dates ---
    n_lookback = min(60, len(feature_dates))
    lookback_X = X[-n_lookback:]
    lookback_dates = feature_dates[-n_lookback:]
    lookback_preds = model.predict(lookback_X)
    lookback_probs = model.predict_proba(lookback_X)[:, 1]

    up_count = int(np.sum(lookback_preds == 1))
    down_count = int(np.sum(lookback_preds == 0))
    avg_confidence = float(np.mean(np.maximum(lookback_probs, 1 - lookback_probs)))

    # Signal strength = average predicted probability of up class
    signal_strength = float(np.mean(lookback_probs))

    # Check if model is well-calibrated in recent period (proxy: how often is up_pred > 0.5 correct?)
    # We don't have labels yet, so just report the raw signal strengths.

    # --- Latest BTC close price ---
    sorted_dates = sorted(closes.keys())
    latest_btc_price = float(closes[sorted_dates[-1]])
    latest_btc_date = sorted_dates[-1]

    # ------------------------------------------------------------------
    # Step 4: Build and write report
    # ------------------------------------------------------------------
    print('\n[4/4] Writing report...')

    report = {
        'generated_at': datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z'),
        'status': 'completed',
        'model_info': {
            'type': metadata.get('model_type', 'LogisticRegression'),
            'features': metadata.get('features', feature_names),
            'trained_at': metadata.get('trained_at', 'unknown'),
            'training_accuracy': metadata.get('training_accuracy'),
        },
        'btc_data': {
            'date_range': f'{min(closes.keys())} to {max(closes.keys())}',
            'n_trading_days': len(closes),
            'latest_close_price': latest_btc_price,
            'latest_close_date': latest_btc_date,
        },
        'feature_data': {
            'n_computed_dates': len(feature_dates),
            'feature_window_days': SEQ_LEN,
            'feature_date_range': f'{feature_dates[0]} to {feature_dates[-1]}',
        },
        'prediction': {
            'date': latest_date,
            'predicted_direction': direction,
            'confidence': round(confidence, 6),
            'up_probability': round(up_prob, 6),
            'down_probability': round(down_prob, 6),
            'predicted_class': pred_class,
        },
        'recent_context': {
            'n_days_analyzed': n_lookback,
            'up_predictions': up_count,
            'down_predictions': down_count,
            'avg_confidence': round(avg_confidence, 6),
            'signal_strength': round(signal_strength, 6),
        },
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH) or '.', exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(report, f, indent=2)

    # ------------------------------------------------------------------
    # Print human-readable summary
    # ------------------------------------------------------------------
    print()
    print(f'Daily DL Inference Report -- {latest_date}')
    print('=' * 55)
    print(f'BTC price:      ${latest_btc_price:,.2f} ({latest_btc_date})')
    print(f'Data window:    {feature_dates[0]} to {latest_date} ({len(feature_dates)} days)')
    print()
    print(f'Predicted direction: {direction.upper()}')
    print(f'Confidence:          {confidence:.1%}')
    print(f'Up probability:      {up_prob:.1%}')
    print(f'Down probability:    {down_prob:.1%}')
    print()
    print(f'Recent {n_lookback}d signals: {up_count}u / {down_count}d')
    print(f'Signal strength:     {signal_strength:.1%}')
    print(f'Avg confidence:      {avg_confidence:.1%}')
    print()
    print(f'Output: {OUTPUT_PATH}')


if __name__ == '__main__':
    main()
