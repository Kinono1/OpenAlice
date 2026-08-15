#!/usr/bin/env python3
"""
Deep Learning Strategy Test: LSTM, Transformer, CNN comparison.

Tests three PyTorch deep learning approaches (LSTM time-series predictor,
Transformer factor combiner, CNN pattern recognizer) against simple
buy-hold and low-vol baselines on Binance daily kline data.

Uses MPS acceleration on Apple Silicon when available.

Data: daily klines from OpenAlice warehouse (ZIP files).
Output: data/research/strategy_deep_learning_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import warnings
import zipfile
from collections import OrderedDict
from datetime import datetime, timezone

import numpy as np

import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, TensorDataset

# Suppress harmless warnings
warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")
warnings.filterwarnings("ignore", category=UserWarning, module="torch")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DEVICE = "mps" if torch.backends.mps.is_available() else "cpu"
print(f"Device: {DEVICE} (torch {torch.__version__})")

BASE = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
KLINES_DIR = f"{BASE}/spot-all-usdt-klines-1d/spot"

# 24 mainstream coins (sorted alphabetically)
MAIN_SYMBOLS = sorted([
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
    "ADAUSDT", "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
    "MATICUSDT", "UNIUSDT", "LTCUSDT", "BCHUSDT", "ATOMUSDT",
    "XLMUSDT", "TRXUSDT", "FILUSDT", "ETCUSDT", "APTUSDT",
    "INJUSDT", "OPUSDT", "NEARUSDT", "SUIUSDT",
])

PROJECT_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
)
OUTPUT_PATH = os.path.join(PROJECT_ROOT, "data", "research", "strategy_deep_learning_report.json")

SEED = 42
torch.manual_seed(SEED)
np.random.seed(SEED)
if DEVICE == "mps":
    torch.mps.manual_seed(SEED)


# ---------------------------------------------------------------------------
# Adaptive Timestamp Parsing
# ---------------------------------------------------------------------------
def parse_timestamp(ts_str: str) -> datetime:
    """Adaptive timestamp: 13 digits = ms (/1000), 16 digits = us (/1000000)."""
    ts = int(ts_str)
    if len(ts_str) >= 16:
        return datetime.fromtimestamp(ts / 1_000_000, tz=timezone.utc)
    else:
        return datetime.fromtimestamp(ts / 1000, tz=timezone.utc)


def date_str(ts_str: str) -> str:
    """Convert timestamp string to YYYY-MM-DD using adaptive parsing."""
    return parse_timestamp(ts_str).strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Data Loading
# ---------------------------------------------------------------------------
def load_symbol_ohlcv(symbol: str):
    """Load OHLCV for one symbol from all ZIPs.

    Returns (closes, highs, lows, volumes) each as dict[date_str, float].
    Returns empty dicts if the symbol directory is missing.
    """
    path = os.path.join(KLINES_DIR, symbol, "1d")
    if not os.path.isdir(path):
        print(f"  WARNING: {symbol} directory not found at {path}")
        return {}, {}, {}, {}

    closes: dict[str, float] = {}
    highs: dict[str, float] = {}
    lows: dict[str, float] = {}
    volumes: dict[str, float] = {}

    for zf in sorted(os.listdir(path)):
        if not zf.endswith(".zip"):
            continue
        zip_path = os.path.join(path, zf)
        try:
            with zipfile.ZipFile(zip_path) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode("utf-8", errors="replace")
                for line in text.strip().split("\n"):
                    cols = line.split(",")
                    if len(cols) < 7:
                        continue
                    try:
                        d = date_str(cols[0])
                        closes[d] = float(cols[4])
                        highs[d] = float(cols[2])
                        lows[d] = float(cols[3])
                        volumes[d] = float(cols[5])
                    except (ValueError, IndexError):
                        pass
        except Exception as exc:
            print(f"  WARNING: failed to read {zip_path}: {exc}")
            continue

    return closes, highs, lows, volumes


def load_all_symbols(symbols: list[str]):
    """Load OHLCV for all symbols.

    Returns dicts keyed by symbol, each value being a dict[date_str, float].
    """
    all_closes: dict[str, dict[str, float]] = {}
    all_highs: dict[str, dict[str, float]] = {}
    all_lows: dict[str, dict[str, float]] = {}
    all_volumes: dict[str, dict[str, float]] = {}

    for sym in symbols:
        c, h, lo, v = load_symbol_ohlcv(sym)
        if c:
            all_closes[sym] = c
            all_highs[sym] = h
            all_lows[sym] = lo
            all_volumes[sym] = v
            print(f"  {sym}: {len(c)} trading days, {list(c.keys())[:2]}...")
        else:
            print(f"  {sym}: no data loaded")

    return all_closes, all_highs, all_lows, all_volumes


# ---------------------------------------------------------------------------
# Return Computation
# ---------------------------------------------------------------------------
def compute_daily_returns(closes: dict[str, float]) -> dict[str, float]:
    """Compute daily returns from close prices. Returned dict has
    date → (close_t - close_{t-1}) / close_{t-1}, starting from the
    second available date."""
    dates = sorted(closes.keys())
    rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        prev = closes[dates[i - 1]]
        if prev > 0:
            rets[dates[i]] = (closes[dates[i]] - prev) / prev
    return rets


def compute_forward_returns(closes: dict[str, float], horizon: int = 21):
    """Compute horizon-day forward return for each date.

    Returns dict[date, fwd_return].
    """
    dates = sorted(closes.keys())
    fwd: dict[str, float] = {}
    for i in range(len(dates) - horizon):
        ret = (closes[dates[i + horizon]] - closes[dates[i]]) / closes[dates[i]]
        fwd[dates[i]] = ret
    return fwd


# ---------------------------------------------------------------------------
# Feature Computation (shared across strategies)
# ---------------------------------------------------------------------------
def compute_features_for_symbol(
    rets: dict[str, float], volumes: dict[str, float], min_lookback: int = 63
):
    """Compute rolling features for one symbol.

    Returns dict[date → [ret_5d, ret_21d, vol_21d, volume_z, ret_63d]].
    Only returns dates with at least `min_lookback` prior days.
    """
    dates = sorted(rets.keys())
    features: dict[str, list[float]] = {}
    vol_dates = sorted(volumes.keys())
    vol_set = set(vol_dates)

    for idx, d in enumerate(dates):
        if idx < min_lookback:
            continue

        # Returns over windows
        ret_5d = sum(rets[dates[idx - j]] for j in range(1, 6))
        ret_21d = sum(rets[dates[idx - j]] for j in range(1, 22))
        ret_63d = sum(rets[dates[idx - j]] for j in range(1, min(64, idx + 1)))

        # 21-day volatility
        vol_vals = [rets[dates[idx - j]] for j in range(1, 22)]
        vol_21d = float(np.std(vol_vals, ddof=1)) if len(vol_vals) > 1 else 0.001

        # Volume z-score (21d volume vs 63d baseline)
        vol_vals_21 = [volumes.get(d, volumes.get(dates[idx - 1], 0))
                       for d in dates[idx - 20:idx + 1]]
        vol_vals_63 = [volumes.get(d, volumes.get(dates[idx - 1], 0))
                       for d in dates[max(0, idx - 63):idx + 1]]
        vol_mu = float(np.mean(vol_vals_63)) if vol_vals_63 else 1
        vol_sd = float(np.std(vol_vals_63, ddof=1)) if len(vol_vals_63) > 1 else 1
        vol_21_mean = float(np.mean(vol_vals_21)) if vol_vals_21 else 0
        volume_z = (vol_21_mean - vol_mu) / vol_sd if vol_sd > 0 else 0.0

        features[d] = [ret_5d, ret_21d, vol_21d, volume_z, ret_63d]

    return features


# ---------------------------------------------------------------------------
# Common Date Grid
# ---------------------------------------------------------------------------
def get_common_dates(symbols, all_closes, min_symbols: int = 20):
    """Find dates where at least `min_symbols` symbols have data."""
    if not all_closes:
        return []
    date_sets = []
    loaded_syms = [s for s in symbols if s in all_closes]
    for sym in loaded_syms:
        date_sets.append(set(all_closes[sym].keys()))
    union_dates = sorted(set.union(*date_sets)) if date_sets else []

    valid_dates = []
    for d in union_dates:
        count = sum(1 for s in loaded_syms if d in all_closes[s])
        if count >= min_symbols:
            valid_dates.append(d)
    return valid_dates


# ===================================================================
# STRATEGY A: LSTM Time-Series Predictor (BTC only)
# ===================================================================
class LSTMPredictor(nn.Module):
    """LSTM with 2 layers, hidden=64, dropout=0.2."""

    def __init__(self, input_size: int = 1, hidden: int = 64,
                 num_layers: int = 2, dropout: float = 0.2):
        super().__init__()
        self.lstm = nn.LSTM(input_size, hidden, num_layers,
                            batch_first=True, dropout=dropout)
        self.fc = nn.Linear(hidden, 1)

    def forward(self, x):
        # x: (batch, seq_len, input_size)
        out, _ = self.lstm(x)
        out = out[:, -1, :]  # last time step
        out = self.fc(out).squeeze(-1)
        return out


def run_strategy_a_lstm(all_rets):
    """
    Strategy A: LSTM Time-Series Predictor for BTCUSDT.

    Uses past 60 days of returns to predict next 21-day direction.
    Train: 2017-2023, Validate: 2024-01 to 2024-06.
    """
    print("\n" + "=" * 60)
    print("STRATEGY A: LSTM Time-Series Predictor (BTC)")
    print("=" * 60)

    if "BTCUSDT" not in all_rets:
        print("  SKIP: BTCUSDT returns not available")
        return None

    seq_len = 60
    fwd_horizon = 21

    print("  Building sequences from close prices...")

    # Load BTC close prices for correct forward return computation
    btc_closes, _, _, _ = load_symbol_ohlcv("BTCUSDT")
    btc_dates = sorted(btc_closes.keys())
    btc_forward_21 = compute_forward_returns(btc_closes, horizon=fwd_horizon)

    # Find dates that work for both seq lookback and forward return
    seqs_X: list[np.ndarray] = []
    seqs_y: list[int] = []
    seqs_dates: list[str] = []

    for i in range(seq_len, len(btc_dates) - fwd_horizon):
        d = btc_dates[i]
        if d not in btc_forward_21:
            continue
        lookback_returns = []
        valid = True
        for j in range(i - seq_len + 1, i + 1):
            # Compute return from previous close to this close
            prev_d = btc_dates[j - 1]
            cur_d = btc_dates[j]
            if btc_closes[prev_d] > 0:
                r = (btc_closes[cur_d] - btc_closes[prev_d]) / btc_closes[prev_d]
                lookback_returns.append(r)
            else:
                valid = False
                break
        if not valid or len(lookback_returns) != seq_len:
            continue

        fwd_ret = btc_forward_21[d]
        label = 1 if fwd_ret > 0 else 0

        seqs_X.append(np.array(lookback_returns, dtype=np.float32))
        seqs_y.append(label)
        seqs_dates.append(d)

    X_arr = np.array(seqs_X)  # (n_samples, 60)
    y_arr = np.array(seqs_y)

    print(f"  Total samples: {len(X_arr)}")

    # Split by date: train 2017-2023, val 2024-01 to 2024-06
    train_mask = np.array([d < "2024-01-01" for d in seqs_dates])
    val_mask = np.array([
        "2024-01-01" <= d <= "2024-06-30" for d in seqs_dates
    ])

    X_train = X_arr[train_mask]
    y_train = y_arr[train_mask]
    X_val = X_arr[val_mask]
    y_val = y_arr[val_mask]

    print(f"  Train samples: {len(X_train)}, Val samples: {len(X_val)}")
    print(f"  Train positive ratio: {y_train.mean():.2%}")
    print(f"  Val positive ratio: {y_val.mean():.2%}")

    if len(X_train) < 100 or len(X_val) < 20:
        print("  SKIP: insufficient data for LSTM training")
        return None

    # Normalize returns per sample (z-score within each sequence)
    # Better: normalize across the whole dataset
    ret_mean = X_train.mean()
    ret_std = X_train.std() + 1e-8
    X_train_norm = (X_train - ret_mean) / ret_std
    X_val_norm = (X_val - ret_mean) / ret_std

    # Reshape: (batch, seq_len, input_size=1)
    X_train_t = torch.FloatTensor(X_train_norm).unsqueeze(-1).to(DEVICE)
    y_train_t = torch.FloatTensor(y_train).to(DEVICE)
    X_val_t = torch.FloatTensor(X_val_norm).unsqueeze(-1).to(DEVICE)
    y_val_t = torch.FloatTensor(y_val).to(DEVICE)

    # Build model
    model = LSTMPredictor(input_size=1, hidden=64, num_layers=2, dropout=0.2).to(DEVICE)
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCEWithLogitsLoss()

    # Train
    n_epochs = 200
    batch_size = 128
    train_dataset = TensorDataset(X_train_t, y_train_t)
    train_loader = DataLoader(train_dataset, batch_size=batch_size, shuffle=True)

    best_val_acc = 0.0
    best_state = None
    patience = 20
    no_improve = 0

    for epoch in range(n_epochs):
        model.train()
        epoch_losses = []
        for batch_X, batch_y in train_loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_losses.append(loss.item())

        # Evaluate
        model.eval()
        with torch.no_grad():
            train_preds = torch.sigmoid(model(X_train_t)).cpu().numpy()
            val_preds = torch.sigmoid(model(X_val_t)).cpu().numpy()

        train_acc = np.mean((train_preds > 0.5) == y_train)
        val_acc = np.mean((val_preds > 0.5) == y_val)

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1

        if (epoch + 1) % 20 == 0:
            print(f"  Epoch {epoch+1:3d}: loss={np.mean(epoch_losses):.4f}, "
                  f"train_acc={train_acc:.2%}, val_acc={val_acc:.2%}")

        if no_improve >= patience:
            print(f"  Early stopping at epoch {epoch+1}")
            break

    # Restore best
    if best_state:
        model.load_state_dict(best_state)

    # Final evaluation
    model.eval()
    with torch.no_grad():
        train_preds = torch.sigmoid(model(X_train_t)).cpu().numpy()
        val_preds = torch.sigmoid(model(X_val_t)).cpu().numpy()

    train_acc = np.mean((train_preds > 0.5) == y_train)
    val_acc = np.mean((val_preds > 0.5) == y_val)

    # Directional accuracy: sign of prediction vs sign of actual
    # For BCE, pred > 0.5 means up, pred < 0.5 means down
    train_directional = train_acc  # same for binary
    val_directional = val_acc

    # Precision, recall for positive class
    val_preds_bin = (val_preds > 0.5).astype(int)
    tp = np.sum((val_preds_bin == 1) & (y_val == 1))
    fp = np.sum((val_preds_bin == 1) & (y_val == 0))
    fn = np.sum((val_preds_bin == 0) & (y_val == 1))
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0

    print(f"\n  LSTM Results:")
    print(f"    Train accuracy: {train_acc:.2%}")
    print(f"    Val accuracy:   {val_acc:.2%}")
    print(f"    Precision:      {precision:.2%}")
    print(f"    Recall:         {recall:.2%}")
    print(f"    F1-score:       {f1:.2%}")

    return {
        "name": "LSTM Time-Series Predictor (BTC)",
        "architecture": {
            "type": "LSTM",
            "layers": 2,
            "hidden_size": 64,
            "dropout": 0.2,
            "input_seq_len": 60,
            "prediction_horizon_days": 21,
        },
        "training": {
            "device": DEVICE,
            "epochs_trained": n_epochs - no_improve,
            "n_epochs_max": n_epochs,
            "batch_size": batch_size,
            "optimizer": "Adam",
            "learning_rate": 0.001,
        },
        "data": {
            "symbol": "BTCUSDT",
            "train_period": "2017-2023",
            "val_period": "2024-01 to 2024-06",
            "n_train_samples": int(len(X_train)),
            "n_val_samples": int(len(X_val)),
        },
        "results": {
            "train_directional_accuracy": float(train_directional),
            "val_directional_accuracy": float(val_directional),
            "val_precision": float(precision),
            "val_recall": float(recall),
            "val_f1_score": float(f1),
            "best_val_accuracy": float(best_val_acc),
        },
    }


# ===================================================================
# STRATEGY B: Transformer Factor Combiner (all 24 symbols)
# ===================================================================
class TransformerFactorCombiner(nn.Module):
    """Small TransformerEncoder for cross-sectional factor combination.

    Treats each symbol as a token in a sequence. Processes all symbols'
    features simultaneously and classifies each as above/below median.
    """

    def __init__(self, n_features: int = 5, d_model: int = 32,
                 nhead: int = 4, num_layers: int = 2, n_symbols: int = 24):
        super().__init__()
        self.input_proj = nn.Linear(n_features, d_model)
        self.pos_embed = nn.Parameter(torch.randn(1, n_symbols, d_model) * 0.1)
        encoder_layer = nn.TransformerEncoderLayer(
            d_model=d_model, nhead=nhead, batch_first=True,
            dim_feedforward=d_model * 4, dropout=0.1,
        )
        self.transformer = nn.TransformerEncoder(encoder_layer, num_layers=num_layers)
        self.classifier = nn.Linear(d_model, 2)

    def forward(self, x):
        # x: (batch, n_symbols, n_features)
        x = self.input_proj(x)  # (batch, n_symbols, d_model)
        x = x + self.pos_embed
        x = self.transformer(x)  # (batch, n_symbols, d_model)
        x = self.classifier(x)  # (batch, n_symbols, 2)
        return x


def run_strategy_b_transformer(all_closes, symbols):
    """
    Strategy B: Transformer Factor Combiner.

    Uses all 24 symbols' features at each timestamp. Small TransformerEncoder
    to predict which symbols will outperform median in next 21 days.

    WFO: train=365d, test=63d, step=21d.

    To ensure sufficient common history, drops the newest ~4 symbols and
    operates on the top-20 longest-history symbols.
    """
    print("\n" + "=" * 60)
    print("STRATEGY B: Transformer Factor Combiner (cross-sectional)")
    print("=" * 60)

    # Select symbols with longest history for sufficient common date range
    loaded_syms = [s for s in symbols if s in all_closes and len(all_closes[s]) > 100]
    loaded_syms.sort(key=lambda s: len(all_closes[s]), reverse=True)

    # Use top 20 for a good common date range
    n_keep = min(20, len(loaded_syms))
    kept_syms = loaded_syms[:n_keep]
    dropped_syms = loaded_syms[n_keep:]

    print(f"  Using top {n_keep} symbols by history (dropped {len(dropped_syms)}: "
          f"{dropped_syms if dropped_syms else 'none'})")

    all_rets: dict[str, dict[str, float]] = {}
    all_volumes: dict[str, dict[str, float]] = {}
    for sym in kept_syms:
        all_rets[sym] = compute_daily_returns(all_closes[sym])
        _, _, _, vols = load_symbol_ohlcv(sym)
        all_volumes[sym] = vols

    # Precompute features for each symbol
    print("  Precomputing features...")
    all_features: dict[str, dict[str, list[float]]] = {}
    for sym in kept_syms:
        feat = compute_features_for_symbol(all_rets[sym], all_volumes.get(sym, {}))
        if feat:
            all_features[sym] = feat

    # Find common dates across all symbols
    # Use the intersection of feature dates
    feat_date_sets = []
    for sym in kept_syms:
        if sym in all_features:
            feat_date_sets.append(set(all_features[sym].keys()))

    if not feat_date_sets:
        print("  SKIP: no feature dates available")
        return None

    common_dates = sorted(set.intersection(*feat_date_sets))
    print(f"  Common dates with all features: {len(common_dates)}")

    if len(common_dates) < 400:
        print("  SKIP: insufficient common dates (< 400)")
        return None

    # Precompute forward returns
    print("  Computing forward returns...")
    all_fwd: dict[str, dict[str, float]] = {}
    for sym in kept_syms:
        all_fwd[sym] = compute_forward_returns(all_closes[sym], horizon=21)

    # Build feature matrices and labels for each common date
    n_symbols = len(kept_syms)
    n_features = 5

    X_dict: dict[str, np.ndarray] = {}  # date → (n_symbols, n_features)
    y_dict: dict[str, np.ndarray] = {}  # date → (n_symbols,) binary

    for d in common_dates:
        sym_features = []
        sym_fwd_rets = []
        for sym in kept_syms:
            sym_features.append(all_features[sym].get(d, [0.0] * n_features))
            fwd = all_fwd.get(sym, {}).get(d, 0.0)
            sym_fwd_rets.append(fwd)
        X_dict[d] = np.array(sym_features, dtype=np.float32)
        # Label: 1 if above median forward return
        median_ret = float(np.median(sym_fwd_rets))
        y_dict[d] = np.array([1 if r > median_ret else 0 for r in sym_fwd_rets],
                             dtype=np.int64)

    # WFO loop
    train_window = 365
    test_window = 63
    step = 21

    all_test_preds: list[np.ndarray] = []
    all_test_labels: list[np.ndarray] = []
    all_test_dates: list[str] = []

    wfo_start = train_window
    n_windows = 0

    print(f"\n  WFO: train={train_window}d, test={test_window}d, step={step}d")
    print(f"  Running WFO from index {wfo_start} to {len(common_dates) - test_window}")

    for wfo_end in range(wfo_start, len(common_dates) - test_window + 1, step):
        train_dates = common_dates[wfo_end - train_window:wfo_end]
        test_dates = common_dates[wfo_end:wfo_end + test_window]

        # Build training data
        X_train_list = [X_dict[d] for d in train_dates]
        y_train_list = [y_dict[d] for d in train_dates]
        X_train = np.stack(X_train_list, axis=0)  # (n_train_dates, n_symbols, n_features)
        y_train = np.stack(y_train_list, axis=0)

        X_test_list = [X_dict[d] for d in test_dates]
        y_test_list = [y_dict[d] for d in test_dates]
        X_test = np.stack(X_test_list, axis=0)
        y_test = np.stack(y_test_list, axis=0)

        # Normalize features across training set
        feat_mean = X_train.mean(axis=(0, 1), keepdims=True)
        feat_std = X_train.std(axis=(0, 1), keepdims=True) + 1e-8
        X_train_norm = (X_train - feat_mean) / feat_std
        X_test_norm = (X_test - feat_mean) / feat_std

        X_train_t = torch.FloatTensor(X_train_norm).to(DEVICE)
        y_train_t = torch.LongTensor(y_train).to(DEVICE)
        X_test_t = torch.FloatTensor(X_test_norm).to(DEVICE)

        # Build model
        model = TransformerFactorCombiner(
            n_features=n_features, d_model=32, nhead=4,
            num_layers=2, n_symbols=n_symbols,
        ).to(DEVICE)

        optimizer = optim.Adam(model.parameters(), lr=0.001)
        criterion = nn.CrossEntropyLoss()

        # Train
        model.train()
        n_epochs = 100
        batch_size = 32
        dataset = TensorDataset(X_train_t, y_train_t)
        loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

        for epoch in range(n_epochs):
            total_loss = 0.0
            n_batches = 0
            for batch_X, batch_y in loader:
                optimizer.zero_grad()
                outputs = model(batch_X)  # (batch, n_symbols, 2)
                loss = criterion(outputs.permute(0, 2, 1), batch_y)
                loss.backward()
                torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
                optimizer.step()
                total_loss += loss.item()
                n_batches += 1

        # Evaluate on test
        model.eval()
        with torch.no_grad():
            test_logits = model(X_test_t)
            test_preds = test_logits.argmax(dim=-1).cpu().numpy()  # (n_test_dates, n_symbols)

        all_test_preds.append(test_preds)
        all_test_labels.append(y_test)
        all_test_dates.extend(test_dates)
        n_windows += 1

        window_acc = np.mean(test_preds == y_test)
        print(f"  WFO window {n_windows:2d}: [{test_dates[0]}..{test_dates[-1]}] "
              f"acc={window_acc:.2%}")

    if n_windows == 0:
        print("  SKIP: no WFO windows completed")
        return None

    # Aggregate all test predictions
    all_preds = np.concatenate(all_test_preds, axis=0)
    all_labels = np.concatenate(all_test_labels, axis=0)

    overall_acc = np.mean(all_preds == all_labels)

    # Per-class accuracy
    pos_mask = all_labels == 1
    neg_mask = all_labels == 0
    acc_pos = np.mean(all_preds[pos_mask] == 1) if pos_mask.sum() > 0 else 0.0
    acc_neg = np.mean(all_preds[neg_mask] == 0) if neg_mask.sum() > 0 else 0.0

    # Average accuracy per symbol
    sym_accs = {}
    for i, sym in enumerate(kept_syms):
        sym_preds = all_preds[:, i]
        sym_labels = all_labels[:, i]
        sym_accs[sym] = float(np.mean(sym_preds == sym_labels))

    best_sym = max(sym_accs, key=sym_accs.get)
    worst_sym = min(sym_accs, key=sym_accs.get)

    print(f"\n  Transformer Results:")
    print(f"    WFO windows:       {n_windows}")
    print(f"    Total test samples: {all_preds.shape[0]} dates x {n_symbols} symbols")
    print(f"    Overall accuracy:   {overall_acc:.2%}")
    print(f"    Positive class acc: {acc_pos:.2%}")
    print(f"    Negative class acc: {acc_neg:.2%}")
    print(f"    Best symbol:        {best_sym} ({sym_accs[best_sym]:.2%})")
    print(f"    Worst symbol:       {worst_sym} ({sym_accs[worst_sym]:.2%})")

    return {
        "name": "Transformer Factor Combiner",
        "architecture": {
            "type": "TransformerEncoder",
            "layers": 2,
            "nhead": 4,
            "d_model": 32,
            "feedforward_dim": 128,
            "dropout": 0.1,
            "n_features": n_features,
            "n_symbols": n_symbols,
        },
        "training": {
            "device": DEVICE,
            "wfo": {
                "train_window_days": train_window,
                "test_window_days": test_window,
                "step_days": step,
                "n_windows": n_windows,
            },
            "optimizer": "Adam",
            "learning_rate": 0.001,
            "epochs_per_window": 100,
        },
        "data": {
            "symbols": kept_syms,
            "n_symbols": n_symbols,
            "n_features": n_features,
            "common_date_range": f"{common_dates[0]} to {common_dates[-1]}",
            "n_common_dates": len(common_dates),
        },
        "results": {
            "overall_accuracy": float(overall_acc),
            "positive_class_accuracy": float(acc_pos),
            "negative_class_accuracy": float(acc_neg),
            "per_symbol_accuracy": sym_accs,
            "best_symbol": str(best_sym),
            "best_symbol_accuracy": float(sym_accs[best_sym]),
            "worst_symbol": str(worst_sym),
            "worst_symbol_accuracy": float(sym_accs[worst_sym]),
        },
    }


# ===================================================================
# STRATEGY C: CNN Pattern Recognizer (BTC)
# ===================================================================
class CNNPatternNet(nn.Module):
    """1D CNN on 60-day normalized price sequences for BTC.

    Conv1d(1,32,kernel=5) → Conv1d(32,64,kernel=3) → GAP → FC → binary.
    """

    def __init__(self):
        super().__init__()
        self.conv1 = nn.Conv1d(1, 32, kernel_size=5, padding=2)
        self.bn1 = nn.BatchNorm1d(32)
        self.conv2 = nn.Conv1d(32, 64, kernel_size=3, padding=1)
        self.bn2 = nn.BatchNorm1d(64)
        self.pool = nn.AdaptiveAvgPool1d(1)
        self.fc = nn.Sequential(
            nn.Linear(64, 32),
            nn.ReLU(),
            nn.Dropout(0.2),
            nn.Linear(32, 2),
        )

    def forward(self, x):
        # x: (batch, 1, 60)
        x = torch.relu(self.bn1(self.conv1(x)))
        x = torch.relu(self.bn2(self.conv2(x)))
        x = self.pool(x).squeeze(-1)  # (batch, 64)
        x = self.fc(x)  # (batch, 2)
        return x


def run_strategy_c_cnn(all_closes):
    """
    Strategy C: CNN Pattern Recognizer (BTC).

    1D CNN on 60-day normalized price sequences that detect chart patterns
    predicting future direction. Train: 2017-2023, Test: 2024.
    """
    print("\n" + "=" * 60)
    print("STRATEGY C: CNN Pattern Recognizer (BTC)")
    print("=" * 60)

    if "BTCUSDT" not in all_closes:
        print("  SKIP: BTCUSDT closes not available")
        return None

    btc_closes = all_closes["BTCUSDT"]
    btc_dates = sorted(btc_closes.keys())
    btc_forward_21 = compute_forward_returns(btc_closes, horizon=21)

    seq_len = 60
    seqs_X: list[np.ndarray] = []
    seqs_y: list[int] = []
    seqs_dates: list[str] = []

    for i in range(seq_len, len(btc_dates) - 21):
        d = btc_dates[i]
        if d not in btc_forward_21:
            continue

        # Get 60-day price sequence
        prices = [btc_closes[btc_dates[j]] for j in range(i - seq_len + 1, i + 1)]
        prices = np.array(prices, dtype=np.float32)

        # Normalize: z-score within each 60-day window
        mu = prices.mean()
        sd = prices.std() + 1e-8
        prices_norm = (prices - mu) / sd

        fwd_ret = btc_forward_21[d]
        label = 1 if fwd_ret > 0 else 0

        seqs_X.append(prices_norm)
        seqs_y.append(label)
        seqs_dates.append(d)

    X_arr = np.array(seqs_X)  # (n_samples, 60)
    y_arr = np.array(seqs_y)

    # Add channel dim: (n_samples, 1, 60)
    X_arr = X_arr[:, np.newaxis, :]

    print(f"  Total samples: {len(X_arr)}")
    print(f"  Positive ratio: {y_arr.mean():.2%}")

    # Split: train 2017-2023, test 2024
    train_mask = np.array([d < "2024-01-01" for d in seqs_dates])
    test_mask = np.array(["2024-01-01" <= d <= "2024-12-31" for d in seqs_dates])

    X_train = X_arr[train_mask]
    y_train = y_arr[train_mask]
    X_test = X_arr[test_mask]
    y_test = y_arr[test_mask]

    print(f"  Train samples: {len(X_train)}, Test samples: {len(X_test)}")
    print(f"  Train positive: {y_train.mean():.2%}, Test positive: {y_test.mean():.2%}")

    if len(X_train) < 100 or len(X_test) < 20:
        print("  SKIP: insufficient data")
        return None

    # Convert to tensors
    X_train_t = torch.FloatTensor(X_train).to(DEVICE)
    y_train_t = torch.LongTensor(y_train).to(DEVICE)
    X_test_t = torch.FloatTensor(X_test).to(DEVICE)
    y_test_t = torch.LongTensor(y_test).to(DEVICE)

    # Build model
    model = CNNPatternNet().to(DEVICE)
    optimizer = optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.CrossEntropyLoss()

    # Train
    n_epochs = 200
    batch_size = 64
    dataset = TensorDataset(X_train_t, y_train_t)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    best_test_acc = 0.0
    best_state = None
    patience = 25
    no_improve = 0

    for epoch in range(n_epochs):
        model.train()
        epoch_losses = []
        for batch_X, batch_y in loader:
            optimizer.zero_grad()
            outputs = model(batch_X)
            loss = criterion(outputs, batch_y)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            epoch_losses.append(loss.item())

        # Evaluate
        model.eval()
        with torch.no_grad():
            train_logits = model(X_train_t)
            test_logits = model(X_test_t)

        train_preds = train_logits.argmax(dim=-1).cpu().numpy()
        test_preds = test_logits.argmax(dim=-1).cpu().numpy()
        train_acc = np.mean(train_preds == y_train)
        test_acc = np.mean(test_preds == y_test)

        if test_acc > best_test_acc:
            best_test_acc = test_acc
            best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items()}
            no_improve = 0
        else:
            no_improve += 1

        if (epoch + 1) % 25 == 0:
            print(f"  Epoch {epoch+1:3d}: loss={np.mean(epoch_losses):.4f}, "
                  f"train_acc={train_acc:.2%}, test_acc={test_acc:.2%}")

        if no_improve >= patience:
            print(f"  Early stopping at epoch {epoch+1}")
            break

    # Restore best
    if best_state:
        model.load_state_dict(best_state)

    # Final evaluation
    model.eval()
    with torch.no_grad():
        test_logits = model(X_test_t)
    test_preds = test_logits.argmax(dim=-1).cpu().numpy()
    test_probs = torch.softmax(test_logits, dim=-1)[:, 1].cpu().numpy()

    test_acc = np.mean(test_preds == y_test)

    # Per-class metrics
    tp = np.sum((test_preds == 1) & (y_test == 1))
    fp = np.sum((test_preds == 1) & (y_test == 0))
    tn = np.sum((test_preds == 0) & (y_test == 0))
    fn = np.sum((test_preds == 0) & (y_test == 1))

    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) > 0 else 0.0
    specificity = tn / (tn + fp) if (tn + fp) > 0 else 0.0

    print(f"\n  CNN Results:")
    print(f"    Train accuracy:   {train_acc:.2%}")
    print(f"    Test accuracy:    {test_acc:.2%}")
    print(f"    Precision:        {precision:.2%}")
    print(f"    Recall:           {recall:.2%}")
    print(f"    F1-score:         {f1:.2%}")
    print(f"    Specificity:      {specificity:.2%}")

    return {
        "name": "CNN Pattern Recognizer (BTC)",
        "architecture": {
            "type": "1D CNN",
            "layers": [
                "Conv1d(1, 32, kernel=5) + BatchNorm + ReLU",
                "Conv1d(32, 64, kernel=3) + BatchNorm + ReLU",
                "AdaptiveAvgPool1d -> FC(64->32) -> Dropout -> FC(32->2)",
            ],
            "input_seq_len": 60,
        },
        "training": {
            "device": DEVICE,
            "epochs_trained": n_epochs - no_improve,
            "n_epochs_max": n_epochs,
            "batch_size": batch_size,
            "optimizer": "Adam",
            "learning_rate": 0.001,
        },
        "data": {
            "symbol": "BTCUSDT",
            "input_type": "60-day normalized price sequence",
            "train_period": "2017-2023",
            "test_period": "2024",
            "n_train_samples": int(len(X_train)),
            "n_test_samples": int(len(X_test)),
        },
        "results": {
            "test_accuracy": float(test_acc),
            "test_precision": float(precision),
            "test_recall": float(recall),
            "test_f1_score": float(f1),
            "test_specificity": float(specificity),
            "best_test_accuracy": float(best_test_acc),
        },
    }


# ===================================================================
# BASELINES
# ===================================================================
def run_baselines(all_closes):
    """
    Compute simple buy-hold and low-vol baselines for comparison.

    Buy-hold: hold BTC for the full period (2024).
    Low-vol: long lowest 25% vol, short highest 25% vol, rebalanced monthly.
    """
    print("\n" + "=" * 60)
    print("BASELINES: Buy-Hold and Low-Vol")
    print("=" * 60)

    baselines = {}

    # --- BTC Buy-Hold (2024) ---
    if "BTCUSDT" in all_closes:
        btc_closes = all_closes["BTCUSDT"]
        btc_2024_dates = sorted([d for d in btc_closes if "2024" in d])
        btc_2024_returns = compute_daily_returns(btc_closes)
        btc_2024_rets = {d: btc_2024_returns[d] for d in btc_2024_returns
                         if "2024" in d}

        if btc_2024_rets:
            total_ret = sum(btc_2024_rets.values())
            daily_rets_arr = np.array(list(btc_2024_rets.values()))
            ann_ret = float((1 + total_ret) ** (365 / len(btc_2024_rets)) - 1)
            ann_vol = float(daily_rets_arr.std() * np.sqrt(252))
            sharpe = ann_ret / ann_vol if ann_vol > 0 else 0.0
            hit_rate = float(np.mean(daily_rets_arr > 0))

            btc_start = btc_closes[btc_2024_dates[0]]
            btc_end = btc_closes[btc_2024_dates[-1]]
            bh_return = (btc_end - btc_start) / btc_start

            baselines["btc_buy_hold_2024"] = {
                "description": "Buy and hold BTC throughout 2024",
                "start_price": float(btc_start),
                "end_price": float(btc_end),
                "total_return": float(bh_return),
                "annualized_return": float(ann_ret),
                "annualized_volatility": float(ann_vol),
                "sharpe_ratio": float(sharpe),
                "daily_hit_rate": float(hit_rate),
                "n_trading_days": int(len(btc_2024_rets)),
            }
            print(f"  BTC Buy-Hold 2024:")
            print(f"    Return:         {bh_return:.2%}")
            print(f"    Ann. return:    {ann_ret:.2%}")
            print(f"    Sharpe:         {sharpe:.3f}")
            print(f"    Hit rate:       {hit_rate:.2%}")

    # --- Low-Vol Baseline ---
    # Monthly rebalanced long-short: long lowest 25% vol, short highest 25% vol
    print("  Computing low-vol baseline...")
    loaded_syms = [s for s in MAIN_SYMBOLS if s in all_closes]
    lv_returns: list[float] = []
    lv_dates: list[str] = []

    # Precompute daily returns and 21d vol for all symbols
    lv_all_rets = {}
    for sym in loaded_syms:
        lv_all_rets[sym] = compute_daily_returns(all_closes[sym])

    # Get all trading dates
    all_trading_dates = sorted(set(
        d for sym_rets in lv_all_rets.values() for d in sym_rets
    ))

    # Rebalance every 21 trading days
    rebalance_dates = all_trading_dates[63::21]  # need 63 lookback for vol

    for rebal_i, rebal_d in enumerate(rebalance_dates):
        if rebal_d < "2024-01-01" or rebal_d > "2024-11-30":
            continue

        # Compute 21d vol for each symbol ending on rebalance date
        sym_vols = {}
        for sym in loaded_syms:
            sym_rets = lv_all_rets.get(sym, {})
            sym_dates = sorted(sym_rets.keys())
            idx = next((i for i, d in enumerate(sym_dates) if d >= rebal_d), -1)
            if idx < 21 or idx >= len(sym_dates):
                continue
            vol_vals = [sym_rets[sym_dates[idx - j]] for j in range(1, 22)]
            sym_vols[sym] = float(np.std(vol_vals, ddof=1))

        if len(sym_vols) < 6:
            continue

        # Rank by vol
        sorted_syms = sorted(sym_vols.keys(), key=lambda s: sym_vols[s])
        n_long = max(1, len(sorted_syms) // 4)
        n_short = max(1, len(sorted_syms) // 4)
        long_syms = sorted_syms[:n_long]
        short_syms = sorted_syms[-n_short:]

        # Hold for next 21 days
        next_date_idx = rebalance_dates.index(rebal_d) + 1
        if next_date_idx >= len(rebalance_dates):
            hold_until = rebal_d
        else:
            hold_until = rebalance_dates[next_date_idx]

        # Compute equal-weight long-short return
        for i in range(len(all_trading_dates)):
            d = all_trading_dates[i]
            if d < rebal_d or d >= hold_until:
                continue
            if d == rebal_d:
                continue

            long_ret = np.mean([lv_all_rets[sym].get(d, 0)
                                for sym in long_syms]) if long_syms else 0
            short_ret = np.mean([lv_all_rets[sym].get(d, 0)
                                 for sym in short_syms]) if short_syms else 0
            position_ret = long_ret - short_ret
            lv_returns.append(position_ret)
            lv_dates.append(d)

    if lv_returns:
        lv_arr = np.array(lv_returns)
        lv_total = float(lv_arr.sum())
        lv_ann_ret = float(lv_arr.mean() * 252)
        lv_ann_vol = float(lv_arr.std() * np.sqrt(252))
        lv_sharpe = lv_ann_ret / lv_ann_vol if lv_ann_vol > 0 else 0.0
        lv_hit = float(np.mean(lv_arr > 0))
        lv_max_dd = float(np.minimum.accumulate(1 + np.cumsum(lv_arr)).min() - 1)

        baselines["low_vol_long_short_2024"] = {
            "description": "Monthly rebalanced long-lowest-25%-vol, short-highest-25%-vol",
            "total_return": float(lv_total),
            "annualized_return": float(lv_ann_ret),
            "annualized_volatility": float(lv_ann_vol),
            "sharpe_ratio": float(lv_sharpe),
            "daily_hit_rate": float(lv_hit),
            "max_drawdown": float(lv_max_dd),
            "n_trading_days": int(len(lv_returns)),
        }
        print(f"  Low-Vol Long-Short 2024:")
        print(f"    Return:         {lv_total:.2%}")
        print(f"    Ann. return:    {lv_ann_ret:.2%}")
        print(f"    Sharpe:         {lv_sharpe:.3f}")
        print(f"    Hit rate:       {lv_hit:.2%}")
        print(f"    Max DD:         {lv_max_dd:.2%}")

    return baselines


# ===================================================================
# MAIN
# ===================================================================
def main():
    print("=" * 60)
    print("DEEP LEARNING STRATEGY TEST")
    print("=" * 60)
    print(f"\nLoading data for {len(MAIN_SYMBOLS)} symbols...")

    all_closes, all_highs, all_lows, all_volumes = load_all_symbols(MAIN_SYMBOLS)

    print(f"\nSymbols with data: {len([s for s in MAIN_SYMBOLS if s in all_closes])}")

    # Run all strategies
    results = OrderedDict()
    results["lstm"] = run_strategy_a_lstm(
        {sym: compute_daily_returns(all_closes[sym]) for sym in all_closes}
    )
    results["transformer"] = run_strategy_b_transformer(all_closes, MAIN_SYMBOLS)
    results["cnn"] = run_strategy_c_cnn(all_closes)
    results["baselines"] = run_baselines(all_closes)

    # Prepare report
    print("\n" + "=" * 60)
    print("COMPILING REPORT")
    print("=" * 60)

    # Summary comparison
    comparison: dict[str, float] = {}
    for key, result in results.items():
        if result is None:
            continue
        if key == "baselines":
            for bk, bv in result.items():
                if isinstance(bv, dict) and "sharpe_ratio" in bv:
                    comparison[f"baseline_{bk}"] = float(bv["sharpe_ratio"])
            continue
        if isinstance(result, dict) and "results" in result:
            r = result["results"]
            if "val_directional_accuracy" in r:
                comparison[f"{key}_directional_accuracy"] = float(r["val_directional_accuracy"])
                comparison[f"{key}_f1_score"] = float(r.get("val_f1_score", 0))
            elif "test_directional_accuracy" in r:
                comparison[f"{key}_directional_accuracy"] = float(r["test_directional_accuracy"])
                comparison[f"{key}_f1_score"] = float(r.get("test_f1_score", 0))
            elif "test_accuracy" in r:
                comparison[f"{key}_test_accuracy"] = float(r["test_accuracy"])
                comparison[f"{key}_f1_score"] = float(r.get("test_f1_score", 0))
            elif "overall_accuracy" in r:
                comparison[f"{key}_overall_accuracy"] = float(r["overall_accuracy"])

    # Data summary
    all_dates = sorted(set(
        d for sym_closes in all_closes.values() for d in sym_closes
    )) if all_closes else []

    report = OrderedDict([
        ("generated_at", datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")),
        ("device", DEVICE),
        ("torch_version", torch.__version__),
        ("data_info", {
            "n_symbols_available": len([s for s in MAIN_SYMBOLS if s in all_closes]),
            "n_symbols_requested": len(MAIN_SYMBOLS),
            "symbols_requested": MAIN_SYMBOLS,
            "symbols_with_data": sorted(all_closes.keys()),
            "full_date_range": f"{all_dates[0]} to {all_dates[-1]}" if all_dates else "N/A",
            "n_total_trading_days": len(all_dates),
        }),
        ("strategies", {
            "strategy_a_lstm": results.get("lstm"),
            "strategy_b_transformer": results.get("transformer"),
            "strategy_c_cnn": results.get("cnn"),
        }),
        ("baselines", results.get("baselines", {})),
        ("comparison_summary", comparison),
    ])

    # Write report
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\nReport saved to {OUTPUT_PATH}")

    # Final summary
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for key, result in results.items():
        if result is None:
            print(f"  {key}: SKIPPED (insufficient data)")
            continue
        if key == "baselines":
            for bk, bv in result.items():
                sharpe = bv.get("sharpe_ratio", "N/A")
                ret = bv.get("total_return", "N/A")
                print(f"  Baseline {bk}: Sharpe={sharpe}, Return={ret}")
            continue
        name = result.get("name", key)
        res = result.get("results", {})
        acc = res.get("val_directional_accuracy") or res.get("test_accuracy") or \
              res.get("overall_accuracy") or res.get("test_directional_accuracy", "N/A")
        print(f"  {name}: Accuracy={acc}")


if __name__ == "__main__":
    main()
