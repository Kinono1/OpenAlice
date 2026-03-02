#!/usr/bin/env python3
"""ML Ensemble V1 for next-bar crypto return prediction.

Models:
- XGBoost
- LightGBM
- CatBoost
- RandomForest
- Ridge/Logistic (linear baseline)
- PyTorch MLP (tabular classifier/regressor)

This V3 iteration adds:
- NAS-like lightweight hyperparameter search (time-ordered validation split)
- Cost-aware objective metrics (fees/slippage/latency adjusted)
- Triple-barrier labeling option

Input: JSON file (see --input)
Output: JSON to stdout
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Mapping, Sequence, Tuple


def safe_import_numpy():
    try:
        import numpy as np
    except Exception as exc:  # pragma: no cover - hard dependency
        raise RuntimeError(
            "numpy is required for ml_ensemble_v1.py. Install with: pip install numpy"
        ) from exc
    return np


np = safe_import_numpy()


def safe_import_torch():
    try:
        import torch
        import torch.nn as nn
    except Exception as exc:
        raise RuntimeError(
            "PyTorch is required for pytorch model. Install with: conda install pytorch -c pytorch (or pip install torch)"
        ) from exc
    return torch, nn


def clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def parse_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    raw = str(value).strip().lower()
    if raw in {"1", "true", "yes", "y", "on"}:
        return True
    if raw in {"0", "false", "no", "n", "off"}:
        return False
    return default


def run_with_runtime_warning_guard(fn: Any) -> Any:
    with warnings.catch_warnings():
        warnings.filterwarnings(
            "ignore",
            category=UserWarning,
            message=r"X does not have valid feature names, but LGBM(Classifier|Regressor) was fitted with feature names",
        )
        warnings.filterwarnings(
            "error",
            category=RuntimeWarning,
            message=r".*(matmul|overflow|divide by zero|invalid value).*",
        )
        warnings.filterwarnings("error", category=RuntimeWarning, module=r"sklearn\..*")
        return fn()


def mean(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values) / len(values))


def std(values: Sequence[float]) -> float:
    if not values:
        return 0.0
    m = mean(values)
    var = sum((v - m) ** 2 for v in values) / len(values)
    return float(math.sqrt(var))


def stable_seed_offset(text: str) -> int:
    acc = 0
    for idx, ch in enumerate(text):
        acc += (idx + 1) * ord(ch)
    return acc % 1_000_003


class TorchMLPBinaryClassifier:
    def __init__(
        self,
        seed: int,
        hidden_dim: int = 48,
        dropout: float = 0.1,
        lr: float = 1e-3,
        weight_decay: float = 1e-4,
        epochs: int = 40,
        batch_size: int = 128,
        patience: int = 8,
    ) -> None:
        self.seed = int(seed)
        self.hidden_dim = int(max(8, hidden_dim))
        self.dropout = float(clip(dropout, 0.0, 0.5))
        self.lr = float(max(1e-5, lr))
        self.weight_decay = float(max(0.0, weight_decay))
        self.epochs = int(max(5, epochs))
        self.batch_size = int(max(16, batch_size))
        self.patience = int(max(2, patience))
        self.feature_mean: Any = None
        self.feature_std: Any = None
        self.model: Any = None
        self.constant_prob: float | None = None

    def _scale_fit(self, X: Any) -> Any:
        self.feature_mean = np.mean(X, axis=0)
        self.feature_std = np.std(X, axis=0) + 1e-6
        return (X - self.feature_mean) / self.feature_std

    def _scale_transform(self, X: Any) -> Any:
        if self.feature_mean is None or self.feature_std is None:
            raise RuntimeError("Classifier scaler is not fitted.")
        return (X - self.feature_mean) / self.feature_std

    def _build_model(self, input_dim: int, nn: Any) -> Any:
        hidden2 = max(8, self.hidden_dim // 2)
        return nn.Sequential(
            nn.Linear(input_dim, self.hidden_dim),
            nn.ReLU(),
            nn.Dropout(self.dropout),
            nn.Linear(self.hidden_dim, hidden2),
            nn.ReLU(),
            nn.Dropout(self.dropout),
            nn.Linear(hidden2, 1),
        )

    def fit(self, X: Any, y: Any) -> "TorchMLPBinaryClassifier":
        X_arr = np.array(X, dtype=np.float32)
        y_arr = np.array(y, dtype=np.float32).reshape(-1)
        if len(X_arr) == 0:
            raise ValueError("Empty training data for TorchMLPBinaryClassifier.")

        self.constant_prob = None
        unique_labels = np.unique(y_arr)
        if len(unique_labels) < 2:
            self.constant_prob = float(np.mean(y_arr)) if len(y_arr) else 0.5
            self.feature_mean = np.mean(X_arr, axis=0)
            self.feature_std = np.std(X_arr, axis=0) + 1e-6
            self.model = None
            return self

        X_scaled = self._scale_fit(X_arr)
        n = len(X_scaled)
        val_size = max(16, int(n * 0.2))
        if n - val_size < 32:
            val_size = max(8, n - 32)
        if val_size < 8:
            val_size = min(8, n)

        split = max(1, n - val_size)
        X_train = X_scaled[:split]
        y_train = y_arr[:split]
        X_val = X_scaled[split:]
        y_val = y_arr[split:]

        torch, nn = safe_import_torch()
        torch.set_num_threads(1)
        torch.manual_seed(self.seed)

        model = self._build_model(X_scaled.shape[1], nn)
        optimizer = torch.optim.Adam(
            model.parameters(),
            lr=self.lr,
            weight_decay=self.weight_decay,
        )

        pos_count = float(np.sum(y_train > 0.5))
        neg_count = float(len(y_train) - pos_count)
        if pos_count > 0 and neg_count > 0:
            pos_weight = torch.tensor([max(0.5, neg_count / max(pos_count, 1e-6))])
            criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
        else:
            criterion = nn.BCEWithLogitsLoss()

        X_train_t = torch.tensor(X_train, dtype=torch.float32)
        y_train_t = torch.tensor(y_train, dtype=torch.float32)
        X_val_t = torch.tensor(X_val, dtype=torch.float32)
        y_val_t = torch.tensor(y_val, dtype=torch.float32)

        best_val = float("inf")
        best_state: Dict[str, Any] | None = None
        no_improve = 0
        generator = torch.Generator(device="cpu")
        generator.manual_seed(self.seed + 101)

        for _ in range(self.epochs):
            model.train()
            perm = torch.randperm(len(X_train_t), generator=generator)
            batch_losses: List[float] = []
            for start in range(0, len(perm), self.batch_size):
                idx = perm[start : start + self.batch_size]
                xb = X_train_t[idx]
                yb = y_train_t[idx]
                logits = model(xb).reshape(-1)
                loss = criterion(logits, yb)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                batch_losses.append(float(loss.detach().item()))

            model.eval()
            with torch.no_grad():
                if len(X_val_t) > 0:
                    val_logits = model(X_val_t).reshape(-1)
                    val_loss = float(criterion(val_logits, y_val_t).detach().item())
                else:
                    val_loss = float(np.mean(batch_losses)) if batch_losses else 0.0

            if val_loss + 1e-7 < best_val:
                best_val = val_loss
                best_state = {
                    k: v.detach().cpu().clone() for k, v in model.state_dict().items()
                }
                no_improve = 0
            else:
                no_improve += 1
                if no_improve >= self.patience:
                    break

        if best_state is not None:
            model.load_state_dict(best_state)
        self.model = model.eval()
        return self

    def predict_proba(self, X: Any) -> Any:
        X_arr = np.array(X, dtype=np.float32)
        if len(X_arr) == 0:
            return np.array([], dtype=float)
        if self.constant_prob is not None:
            return np.full(len(X_arr), self.constant_prob, dtype=float)
        if self.model is None:
            raise RuntimeError("TorchMLPBinaryClassifier is not fitted.")

        X_scaled = self._scale_transform(X_arr)
        torch, _ = safe_import_torch()
        with torch.no_grad():
            x_t = torch.tensor(X_scaled, dtype=torch.float32)
            logits = self.model(x_t).reshape(-1)
            probs = torch.sigmoid(logits).detach().cpu().numpy().reshape(-1)
        return probs

    def predict(self, X: Any) -> Any:
        p = np.array(self.predict_proba(X), dtype=float).reshape(-1)
        return (p >= 0.5).astype(int)


class TorchMLPRegressor:
    def __init__(
        self,
        seed: int,
        hidden_dim: int = 48,
        dropout: float = 0.1,
        lr: float = 1e-3,
        weight_decay: float = 1e-4,
        epochs: int = 40,
        batch_size: int = 128,
        patience: int = 8,
    ) -> None:
        self.seed = int(seed)
        self.hidden_dim = int(max(8, hidden_dim))
        self.dropout = float(clip(dropout, 0.0, 0.5))
        self.lr = float(max(1e-5, lr))
        self.weight_decay = float(max(0.0, weight_decay))
        self.epochs = int(max(5, epochs))
        self.batch_size = int(max(16, batch_size))
        self.patience = int(max(2, patience))
        self.feature_mean: Any = None
        self.feature_std: Any = None
        self.model: Any = None
        self.constant_value: float | None = None

    def _scale_fit(self, X: Any) -> Any:
        self.feature_mean = np.mean(X, axis=0)
        self.feature_std = np.std(X, axis=0) + 1e-6
        return (X - self.feature_mean) / self.feature_std

    def _scale_transform(self, X: Any) -> Any:
        if self.feature_mean is None or self.feature_std is None:
            raise RuntimeError("Regressor scaler is not fitted.")
        return (X - self.feature_mean) / self.feature_std

    def _build_model(self, input_dim: int, nn: Any) -> Any:
        hidden2 = max(8, self.hidden_dim // 2)
        return nn.Sequential(
            nn.Linear(input_dim, self.hidden_dim),
            nn.ReLU(),
            nn.Dropout(self.dropout),
            nn.Linear(self.hidden_dim, hidden2),
            nn.ReLU(),
            nn.Dropout(self.dropout),
            nn.Linear(hidden2, 1),
        )

    def fit(self, X: Any, y: Any) -> "TorchMLPRegressor":
        X_arr = np.array(X, dtype=np.float32)
        y_arr = np.array(y, dtype=np.float32).reshape(-1)
        if len(X_arr) == 0:
            raise ValueError("Empty training data for TorchMLPRegressor.")

        self.constant_value = None
        if len(y_arr) < 16:
            self.constant_value = float(np.mean(y_arr)) if len(y_arr) else 0.0
            self.feature_mean = np.mean(X_arr, axis=0)
            self.feature_std = np.std(X_arr, axis=0) + 1e-6
            self.model = None
            return self

        X_scaled = self._scale_fit(X_arr)
        y_scaled = np.clip(y_arr, -1.0, 1.0)
        n = len(X_scaled)
        val_size = max(16, int(n * 0.2))
        if n - val_size < 32:
            val_size = max(8, n - 32)
        if val_size < 8:
            val_size = min(8, n)

        split = max(1, n - val_size)
        X_train = X_scaled[:split]
        y_train = y_scaled[:split]
        X_val = X_scaled[split:]
        y_val = y_scaled[split:]

        torch, nn = safe_import_torch()
        torch.set_num_threads(1)
        torch.manual_seed(self.seed)

        model = self._build_model(X_scaled.shape[1], nn)
        optimizer = torch.optim.Adam(
            model.parameters(),
            lr=self.lr,
            weight_decay=self.weight_decay,
        )
        criterion = nn.SmoothL1Loss()

        X_train_t = torch.tensor(X_train, dtype=torch.float32)
        y_train_t = torch.tensor(y_train, dtype=torch.float32)
        X_val_t = torch.tensor(X_val, dtype=torch.float32)
        y_val_t = torch.tensor(y_val, dtype=torch.float32)

        best_val = float("inf")
        best_state: Dict[str, Any] | None = None
        no_improve = 0
        generator = torch.Generator(device="cpu")
        generator.manual_seed(self.seed + 313)

        for _ in range(self.epochs):
            model.train()
            perm = torch.randperm(len(X_train_t), generator=generator)
            batch_losses: List[float] = []
            for start in range(0, len(perm), self.batch_size):
                idx = perm[start : start + self.batch_size]
                xb = X_train_t[idx]
                yb = y_train_t[idx]
                pred = model(xb).reshape(-1)
                loss = criterion(pred, yb)
                optimizer.zero_grad()
                loss.backward()
                optimizer.step()
                batch_losses.append(float(loss.detach().item()))

            model.eval()
            with torch.no_grad():
                if len(X_val_t) > 0:
                    val_pred = model(X_val_t).reshape(-1)
                    val_loss = float(criterion(val_pred, y_val_t).detach().item())
                else:
                    val_loss = float(np.mean(batch_losses)) if batch_losses else 0.0

            if val_loss + 1e-7 < best_val:
                best_val = val_loss
                best_state = {
                    k: v.detach().cpu().clone() for k, v in model.state_dict().items()
                }
                no_improve = 0
            else:
                no_improve += 1
                if no_improve >= self.patience:
                    break

        if best_state is not None:
            model.load_state_dict(best_state)
        self.model = model.eval()
        return self

    def predict(self, X: Any) -> Any:
        X_arr = np.array(X, dtype=np.float32)
        if len(X_arr) == 0:
            return np.array([], dtype=float)
        if self.constant_value is not None:
            return np.full(len(X_arr), self.constant_value, dtype=float)
        if self.model is None:
            raise RuntimeError("TorchMLPRegressor is not fitted.")

        X_scaled = self._scale_transform(X_arr)
        torch, _ = safe_import_torch()
        with torch.no_grad():
            x_t = torch.tensor(X_scaled, dtype=torch.float32)
            pred = self.model(x_t).reshape(-1).detach().cpu().numpy().reshape(-1)
        return pred


def rsi(closes: Sequence[float], period: int) -> List[float]:
    if len(closes) < 2:
        return [50.0 for _ in closes]
    out = [50.0 for _ in closes]
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    for i in range(1, len(closes)):
        start = max(1, i - period + 1)
        window = deltas[start - 1 : i]
        gains = [d for d in window if d > 0]
        losses = [-d for d in window if d < 0]
        avg_gain = mean(gains) if gains else 0.0
        avg_loss = mean(losses) if losses else 0.0
        if avg_loss <= 1e-12 and avg_gain <= 1e-12:
            out[i] = 50.0
        elif avg_loss <= 1e-12:
            out[i] = 100.0
        else:
            rs = avg_gain / avg_loss
            out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def atr(candles: Sequence[Dict[str, Any]], period: int) -> List[float]:
    if not candles:
        return []
    true_ranges: List[float] = []
    prev_close = float(candles[0]["close"])
    for candle in candles:
        high = float(candle["high"])
        low = float(candle["low"])
        close = float(candle["close"])
        tr = max(high - low, abs(high - prev_close), abs(low - prev_close))
        true_ranges.append(tr)
        prev_close = close
    out = [0.0 for _ in candles]
    for i in range(len(candles)):
        start = max(0, i - period + 1)
        out[i] = mean(true_ranges[start : i + 1])
    return out


@dataclass
class Dataset:
    X: Any
    y_dir: Any
    y_ret: Any
    times: Any
    latest_features: Any
    latest_time: int
    feature_names: List[str]
    labeling: Dict[str, Any]


def build_dataset(
    candles: Sequence[Dict[str, Any]],
    horizon: int,
    labeling_mode: str = "next_return_sign",
    barrier_take_profit_atr: float = 1.5,
    barrier_stop_loss_atr: float = 1.0,
    barrier_max_horizon_bars: int = 6,
) -> Dataset:
    closes = [float(c["close"]) for c in candles]
    highs = [float(c["high"]) for c in candles]
    lows = [float(c["low"]) for c in candles]
    volumes = [float(c["volume"]) for c in candles]
    times = [int(c["time"]) for c in candles]

    mode = (labeling_mode or "next_return_sign").strip().lower()
    if mode not in {"next_return_sign", "triple_barrier"}:
        mode = "next_return_sign"

    barrier_max_horizon_bars = max(1, int(barrier_max_horizon_bars))
    max_label_horizon = (
        max(horizon, barrier_max_horizon_bars)
        if mode == "triple_barrier"
        else int(horizon)
    )

    min_warmup = 32
    need = min_warmup + max_label_horizon + 5
    if len(candles) < need:
        raise ValueError(f"Not enough candles: need >= {need}, got {len(candles)}.")

    ret = [0.0 for _ in closes]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        ret[i] = (closes[i] / prev - 1.0) if prev > 0 else 0.0

    rsi14 = rsi(closes, 14)
    atr14 = atr(candles, 14)

    feature_names = [
        "ret1",
        "ret3",
        "ret6",
        "ret12",
        "vol5",
        "vol20",
        "rangePct",
        "closeVsSma5",
        "closeVsSma20",
        "sma5VsSma20",
        "volumeZ20",
        "rsi14",
        "atr14Pct",
        "mom24",
    ]

    def feature_row(i: int) -> List[float]:
        c = closes[i]
        sma5 = mean(closes[i - 4 : i + 1])
        sma20 = mean(closes[i - 19 : i + 1])
        vol5 = std(ret[i - 4 : i + 1])
        vol20 = std(ret[i - 19 : i + 1])
        vol_mean20 = mean(volumes[i - 19 : i + 1])
        vol_std20 = std(volumes[i - 19 : i + 1])
        range_pct = (highs[i] - lows[i]) / c if c else 0.0
        volume_z20 = (volumes[i] - vol_mean20) / (vol_std20 + 1e-8)
        atr14_pct = atr14[i] / c if c else 0.0
        return [
            ret[i],
            closes[i] / closes[i - 3] - 1.0,
            closes[i] / closes[i - 6] - 1.0,
            closes[i] / closes[i - 12] - 1.0,
            vol5,
            vol20,
            range_pct,
            c / sma5 - 1.0 if sma5 else 0.0,
            c / sma20 - 1.0 if sma20 else 0.0,
            sma5 / sma20 - 1.0 if sma20 else 0.0,
            volume_z20,
            rsi14[i] / 100.0,
            atr14_pct,
            closes[i] / closes[i - 24] - 1.0,
        ]

    X: List[List[float]] = []
    y_dir: List[int] = []
    y_ret: List[float] = []
    row_times: List[int] = []
    label_horizons: List[int] = []
    event_counts = {"tp": 0, "sl": 0, "timeout": 0, "horizon": 0}

    start = min_warmup
    end = len(candles) - max_label_horizon
    for i in range(start, end):
        f = feature_row(i)
        target_ret = closes[i + horizon] / closes[i] - 1.0
        direction = 1 if target_ret > 0 else 0
        label_h = horizon

        if mode == "triple_barrier":
            ref_close = closes[i]
            atr_pct = atr14[i] / ref_close if ref_close else 0.0
            width_scale = max(atr_pct, 1e-6)
            tp = max(1e-6, barrier_take_profit_atr * width_scale)
            sl = max(1e-6, barrier_stop_loss_atr * width_scale)

            target_ret = closes[i + max_label_horizon] / ref_close - 1.0
            direction = 1 if target_ret > 0 else 0
            event = "timeout"
            label_h = max_label_horizon

            for j in range(1, max_label_horizon + 1):
                f_ret = closes[i + j] / ref_close - 1.0
                if f_ret >= tp:
                    target_ret = f_ret
                    direction = 1
                    event = "tp"
                    label_h = j
                    break
                if f_ret <= -sl:
                    target_ret = f_ret
                    direction = 0
                    event = "sl"
                    label_h = j
                    break
            event_counts[event] += 1
        else:
            event_counts["horizon"] += 1

        X.append(f)
        y_ret.append(target_ret)
        y_dir.append(direction)
        row_times.append(times[i])
        label_horizons.append(int(label_h))

    latest_index = len(candles) - 1
    if latest_index < start:
        raise ValueError("Not enough candles for latest feature row.")
    latest_features = feature_row(latest_index)

    sample_count = len(X)
    pos_rate = float(sum(y_dir) / sample_count) if sample_count else 0.0
    labeling: Dict[str, Any] = {
        "mode": mode,
        "horizonBars": int(horizon),
        "avgLabelHorizonBars": float(mean(label_horizons)),
        "labelDistribution": {
            "positiveRate": pos_rate,
            "tpRate": float(event_counts["tp"] / max(1, sample_count)),
            "slRate": float(event_counts["sl"] / max(1, sample_count)),
            "timeoutRate": float(event_counts["timeout"] / max(1, sample_count)),
            "horizonRate": float(event_counts["horizon"] / max(1, sample_count)),
        },
    }
    if mode == "triple_barrier":
        labeling["barrier"] = {
            "takeProfitAtr": float(barrier_take_profit_atr),
            "stopLossAtr": float(barrier_stop_loss_atr),
            "maxHorizonBars": int(max_label_horizon),
        }

    return Dataset(
        X=np.array(X, dtype=float),
        y_dir=np.array(y_dir, dtype=int),
        y_ret=np.array(y_ret, dtype=float),
        times=np.array(row_times, dtype=int),
        latest_features=np.array(latest_features, dtype=float),
        latest_time=int(times[-1]),
        feature_names=feature_names,
        labeling=labeling,
    )


def auc_score(y_true: Any, y_prob: Any) -> float | None:
    try:
        from sklearn.metrics import roc_auc_score

        if len(np.unique(y_true)) < 2:
            return None
        return float(roc_auc_score(y_true, y_prob))
    except Exception:
        return None


def majority_baseline_accuracy(y_true: Any) -> float:
    if len(y_true) == 0:
        return 0.0
    up_rate = float(np.mean(y_true))
    return max(up_rate, 1.0 - up_rate)


def accuracy_score(y_true: Any, y_pred: Any) -> float:
    if len(y_true) == 0:
        return 0.0
    return float(np.mean(y_true == y_pred))


def mae(y_true: Any, y_pred: Any) -> float:
    if len(y_true) == 0:
        return 0.0
    return float(np.mean(np.abs(y_true - y_pred)))


def rmse(y_true: Any, y_pred: Any) -> float:
    if len(y_true) == 0:
        return 0.0
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def sanitize_probabilities(values: Any) -> Any:
    arr = np.array(values, dtype=float).reshape(-1)
    arr = np.nan_to_num(arr, nan=0.5, posinf=1.0, neginf=0.0)
    return np.clip(arr, 0.0, 1.0)


def sanitize_returns(values: Any, cap: float = 1.0) -> Any:
    arr = np.array(values, dtype=float).reshape(-1)
    arr = np.nan_to_num(arr, nan=0.0, posinf=cap, neginf=-cap)
    return np.clip(arr, -cap, cap)


def sanitize_feature_matrix(values: Any, cap: float = 1_000.0) -> Any:
    arr = np.array(values, dtype=float)
    if arr.ndim == 1:
        arr = arr.reshape(1, -1)
    safe_cap = max(1e-6, float(cap))
    arr = np.nan_to_num(arr, nan=0.0, posinf=safe_cap, neginf=-safe_cap)
    return np.clip(arr, -safe_cap, safe_cap)


def derive_feature_clip_caps(
    X_train: Any,
    quantile: float = 0.995,
    min_cap: float = 1.0,
    max_cap: float = 250.0,
) -> Any:
    arr = sanitize_feature_matrix(X_train, cap=max_cap)
    if arr.shape[0] == 0:
        return np.full(arr.shape[1], max(1.0, min_cap), dtype=float)

    q = clip(float(quantile), 0.90, 0.9999)
    lo = max(1e-6, min(float(min_cap), float(max_cap)))
    hi = max(lo, float(max_cap))
    caps = np.quantile(np.abs(arr), q, axis=0)
    caps = np.nan_to_num(caps, nan=lo, posinf=hi, neginf=lo)
    return np.clip(np.abs(caps), lo, hi)


def sanitize_feature_matrix_with_caps(
    values: Any, caps: Any, fallback_cap: float = 250.0
) -> Any:
    arr = np.array(values, dtype=float)
    vector_input = arr.ndim == 1
    if vector_input:
        arr = arr.reshape(1, -1)
    safe_fallback = max(1e-6, float(fallback_cap))
    arr = np.nan_to_num(arr, nan=0.0, posinf=safe_fallback, neginf=-safe_fallback)

    cap_arr = np.array(caps, dtype=float).reshape(1, -1)
    if cap_arr.shape[1] != arr.shape[1]:
        clipped = np.clip(arr, -safe_fallback, safe_fallback)
    else:
        cap_arr = np.nan_to_num(
            np.abs(cap_arr),
            nan=safe_fallback,
            posinf=safe_fallback,
            neginf=safe_fallback,
        )
        cap_arr = np.clip(cap_arr, 1e-6, safe_fallback)
        clipped = np.clip(arr, -cap_arr, cap_arr)

    if vector_input:
        return clipped.reshape(-1)
    return clipped


def sanitize_regime_feature_matrix(
    features: Any,
    train_size: int,
    clip_quantile: float = 0.995,
    min_cap: float = 1e-4,
    max_cap: float = 25.0,
) -> Tuple[Any, Any]:
    arr = np.array(features, dtype=float)
    if arr.ndim == 1:
        arr = arr.reshape(-1, 1)
    if arr.shape[0] == 0:
        return arr, arr

    train_n = int(clip(float(train_size), 1.0, float(arr.shape[0])))
    train_raw = sanitize_feature_matrix(arr[:train_n], cap=max_cap)
    all_raw = sanitize_feature_matrix(arr, cap=max_cap)
    caps = derive_feature_clip_caps(
        train_raw,
        quantile=clip_quantile,
        min_cap=min_cap,
        max_cap=max_cap,
    )
    train_feats = sanitize_feature_matrix_with_caps(
        train_raw,
        caps,
        fallback_cap=max_cap,
    )
    all_feats = sanitize_feature_matrix_with_caps(
        all_raw,
        caps,
        fallback_cap=max_cap,
    )
    return train_feats, all_feats


def resolve_selection_mode(metric: str, mode: str) -> str:
    normalized = (mode or "auto").strip().lower()
    if normalized in {"max", "min"}:
        return normalized
    if metric in {"maePct", "rmsePct"}:
        return "min"
    return "max"


def pick_metric(metrics: Dict[str, Any], metric: str) -> float | None:
    try:
        value = float(metrics.get(metric))
    except Exception:
        return None
    if not math.isfinite(value):
        return None
    return value


def better_score(candidate: float | None, best: float | None, mode: str) -> bool:
    if candidate is None:
        return False
    if best is None:
        return True
    if mode == "min":
        return candidate < best
    return candidate > best


def model_predict_proba(model: Any, X: Any) -> Any:
    if hasattr(model, "predict_proba"):
        p = model.predict_proba(X)
        if len(getattr(p, "shape", ())) == 2 and p.shape[1] >= 2:
            return p[:, 1]
        return p.reshape(-1)
    pred = model.predict(X)
    pred = np.array(pred, dtype=float).reshape(-1)
    return np.clip(pred, 0.0, 1.0)


def shift_signal(signal: Any, latency_bars: int) -> Any:
    signal = np.array(signal, dtype=float).reshape(-1)
    latency = max(0, int(latency_bars))
    if latency <= 0:
        return signal
    out = np.zeros_like(signal)
    if latency < len(signal):
        out[latency:] = signal[:-latency]
    return out


def compute_cost_aware_metrics(
    y_ret: Any,
    p_up: Any,
    fee_rate: float,
    slippage_bps: float,
    latency_bars: int,
    robust_per_bar_clip: float = 0.25,
) -> Dict[str, float]:
    y = sanitize_returns(y_ret, cap=1.0)
    p = sanitize_probabilities(p_up)
    if len(y) == 0:
        return {
            "costAwareUtility": 0.0,
            "netSharpeAfterCost": 0.0,
            "netReturnPctAfterCost": 0.0,
            "grossReturnPctBeforeCost": 0.0,
            "turnoverPerBar": 0.0,
            "tradeCount": 0.0,
            "winRateAfterCost": 0.0,
            "robustCostAwareUtility": 0.0,
            "robustSharpeAfterCost": 0.0,
            "robustSortinoAfterCost": 0.0,
            "robustAnnualizedReturnPctAfterCost": 0.0,
        }

    raw_signal = np.where(p >= 0.5, 1.0, -1.0)
    exec_signal = shift_signal(raw_signal, latency_bars)
    prev_signal = np.concatenate([np.array([0.0]), exec_signal[:-1]])
    turnover = np.abs(exec_signal - prev_signal) / 2.0

    per_turnover_cost = max(0.0, float(fee_rate)) + max(0.0, float(slippage_bps)) / 1e4
    gross = exec_signal * y
    net = gross - turnover * per_turnover_cost

    mean_net = float(np.mean(net))
    std_net = float(np.std(net))
    utility = mean_net / (std_net + 1e-8)
    net_sharpe = utility * math.sqrt(252.0)

    gross_curve = np.clip(1.0 + gross, 1e-6, 10.0)
    net_curve = np.clip(1.0 + net, 1e-6, 10.0)
    gross_log_sum = float(np.sum(np.log(gross_curve)))
    net_log_sum = float(np.sum(np.log(net_curve)))
    # Keep cumulative return metrics finite for very long volatile series.
    gross_return = float(math.exp(clip(gross_log_sum, -50.0, 50.0)) - 1.0)
    net_return = float(math.exp(clip(net_log_sum, -50.0, 50.0)) - 1.0)

    robust_clip = clip(float(robust_per_bar_clip), 0.01, 0.5)
    robust_net = np.clip(net, -robust_clip, robust_clip)
    robust_med = float(np.median(robust_net))
    robust_mad = float(np.median(np.abs(robust_net - robust_med)))
    robust_scale = max(robust_mad, 1e-4)
    robust_core_utility = clip(robust_med / robust_scale, -25.0, 25.0)
    turnover_penalty = float(np.mean(turnover) * per_turnover_cost * 100.0)
    robust_cost_aware_utility = clip(
        robust_core_utility - turnover_penalty, -25.0, 25.0
    )

    robust_log = np.log1p(np.clip(robust_net, -0.95, 5.0))
    robust_mean_log = float(np.mean(robust_log))
    robust_std_log = float(np.std(robust_log))
    robust_sharpe = clip(
        robust_mean_log / (robust_std_log + 1e-8) * math.sqrt(252.0), -50.0, 50.0
    )

    downside = np.minimum(robust_log, 0.0)
    downside_std = float(np.sqrt(np.mean(downside**2)))
    robust_sortino = clip(
        robust_mean_log / (downside_std + 1e-8) * math.sqrt(252.0), -50.0, 50.0
    )

    robust_annual = clip(
        math.exp(clip(robust_mean_log * 252.0, -5.0, 5.0)) - 1.0, -0.95, 5.0
    )

    return {
        "costAwareUtility": float(utility),
        "netSharpeAfterCost": float(net_sharpe),
        "netReturnPctAfterCost": float(net_return * 100.0),
        "grossReturnPctBeforeCost": float(gross_return * 100.0),
        "turnoverPerBar": float(np.mean(turnover)),
        "tradeCount": float(np.sum(turnover > 0)),
        "winRateAfterCost": float(np.mean(net > 0)),
        "robustCostAwareUtility": float(robust_cost_aware_utility),
        "robustSharpeAfterCost": float(robust_sharpe),
        "robustSortinoAfterCost": float(robust_sortino),
        "robustAnnualizedReturnPctAfterCost": float(robust_annual * 100.0),
    }


def evaluate_prediction_metrics(
    y_true_dir: Any,
    y_true_ret: Any,
    y_prob: Any,
    y_ret_pred: Any,
    baseline_accuracy: float,
    fee_rate: float,
    slippage_bps: float,
    latency_bars: int,
    robust_per_bar_clip: float,
) -> Dict[str, Any]:
    y_prob = sanitize_probabilities(y_prob)
    y_ret_pred = sanitize_returns(y_ret_pred, cap=1.0)
    y_pred_dir = (y_prob >= 0.5).astype(int)

    base_metrics: Dict[str, Any] = {
        "directionAccuracy": float(accuracy_score(y_true_dir, y_pred_dir)),
        "baselineDirectionAccuracy": float(baseline_accuracy),
        "accuracyLift": float(
            accuracy_score(y_true_dir, y_pred_dir) - baseline_accuracy
        ),
        "auc": auc_score(y_true_dir, y_prob),
        "maePct": float(mae(y_true_ret, y_ret_pred) * 100.0),
        "rmsePct": float(rmse(y_true_ret, y_ret_pred) * 100.0),
        "testUpRate": float(np.mean(y_true_dir)),
        "testSamples": int(len(y_true_dir)),
    }
    base_metrics.update(
        compute_cost_aware_metrics(
            y_ret=y_true_ret,
            p_up=y_prob,
            fee_rate=fee_rate,
            slippage_bps=slippage_bps,
            latency_bars=latency_bars,
            robust_per_bar_clip=robust_per_bar_clip,
        )
    )
    return base_metrics


def normalize_regime_labels(
    labels: Any,
    expected_len: int,
    default_label: str = "unknown",
) -> List[str]:
    arr = np.array(labels, dtype=object).reshape(-1)
    out: List[str] = []
    for i in range(expected_len):
        if i >= len(arr):
            out.append(default_label)
            continue
        raw = arr[i]
        if raw is None:
            out.append(default_label)
            continue
        text = str(raw).strip()
        out.append(text if text else default_label)
    return out


def compute_adaptive_conformal_summary(
    y_val_true: Any,
    y_val_pred: Any,
    y_test_true: Any,
    y_test_pred: Any,
    regime_labels_val: Sequence[str],
    regime_labels_test: Sequence[str],
    current_regime: str,
    latest_return_pred: float,
    alpha: float,
    min_regime_samples: int,
    shift_weight_clip_min: float,
    shift_weight_clip_max: float,
) -> Dict[str, Any]:
    alpha = clip(float(alpha), 0.01, 0.40)
    q_level = clip(1.0 - alpha, 0.50, 0.999)
    min_regime_samples = max(5, int(min_regime_samples))
    shift_weight_clip_min = clip(float(shift_weight_clip_min), 0.05, 1.0)
    shift_weight_clip_max = clip(float(shift_weight_clip_max), 1.0, 20.0)
    if shift_weight_clip_max < shift_weight_clip_min:
        shift_weight_clip_max = shift_weight_clip_min

    val_true = sanitize_returns(y_val_true, cap=5.0)
    val_pred = sanitize_returns(y_val_pred, cap=5.0)
    test_true = sanitize_returns(y_test_true, cap=5.0)
    test_pred = sanitize_returns(y_test_pred, cap=5.0)

    regime_val = normalize_regime_labels(regime_labels_val, len(val_true))
    regime_test = normalize_regime_labels(regime_labels_test, len(test_true))

    val_mask = np.isfinite(val_true) & np.isfinite(val_pred)
    test_mask = np.isfinite(test_true) & np.isfinite(test_pred)
    if int(np.sum(val_mask)) <= 0 or int(np.sum(test_mask)) <= 0:
        global_q = 0.0
        lower_latest = float(latest_return_pred * 100.0)
        upper_latest = float(latest_return_pred * 100.0)
        return {
            "method": "adaptive_regime_abs_residual",
            "alpha": float(alpha),
            "qLevel": float(q_level),
            "globalQAbsReturn": float(global_q),
            "regimeQAbsReturn": {},
            "validationRegimeCounts": {},
            "testRegimeCounts": {},
            "coverageTest": 0.0,
            "coverageShiftWeightedTest": 0.0,
            "sharpnessPct": 0.0,
            "latestRegime": current_regime,
            "latestLowerExpectedReturnPct": lower_latest,
            "latestUpperExpectedReturnPct": upper_latest,
            "shiftWeightsByRegime": {},
        }

    val_residual = np.abs(val_true - val_pred)
    val_residual = val_residual[val_mask]
    regime_val_masked = [regime_val[i] for i, ok in enumerate(val_mask) if bool(ok)]
    global_q = float(np.quantile(val_residual, q_level)) if len(val_residual) else 0.0

    regime_q: Dict[str, float] = {}
    val_counts: Dict[str, int] = {}
    unique_regimes = sorted(set(regime_val_masked))
    for regime in unique_regimes:
        idx = [i for i, r in enumerate(regime_val_masked) if r == regime]
        count = len(idx)
        val_counts[regime] = int(count)
        if count <= 0:
            continue
        if count < min_regime_samples:
            regime_q[regime] = float(global_q)
            continue
        values = val_residual[np.array(idx, dtype=int)]
        regime_q[regime] = float(np.quantile(values, q_level))

    if not regime_q:
        regime_q["unknown"] = float(global_q)

    q_test = np.array(
        [float(regime_q.get(r, global_q)) for r in regime_test], dtype=float
    )
    lower = test_pred - q_test
    upper = test_pred + q_test
    hit = (test_true >= lower) & (test_true <= upper)

    masked_hits = hit[test_mask]
    masked_width = (upper - lower)[test_mask]
    coverage = float(np.mean(masked_hits)) if len(masked_hits) else 0.0
    sharpness_pct = float(np.mean(masked_width) * 100.0) if len(masked_width) else 0.0

    test_counts: Dict[str, int] = {}
    for regime, ok in zip(regime_test, test_mask):
        if not bool(ok):
            continue
        test_counts[regime] = int(test_counts.get(regime, 0) + 1)

    total_val = max(1, int(sum(val_counts.values())))
    total_test = max(1, int(sum(test_counts.values())))
    shift_weights_by_regime: Dict[str, float] = {}
    for regime, t_count in test_counts.items():
        p_test = float(t_count) / float(total_test)
        p_val = float(val_counts.get(regime, 0)) / float(total_val)
        if p_val <= 0:
            weight = shift_weight_clip_max
        else:
            weight = clip(
                p_test / max(p_val, 1e-8),
                shift_weight_clip_min,
                shift_weight_clip_max,
            )
        shift_weights_by_regime[regime] = float(weight)

    sample_weights = np.array(
        [float(shift_weights_by_regime.get(r, 1.0)) for r in regime_test], dtype=float
    )
    sample_weights = sample_weights[test_mask]
    if len(sample_weights) and float(np.sum(sample_weights)) > 0:
        weighted_coverage = float(
            np.sum(sample_weights * masked_hits.astype(float)) / np.sum(sample_weights)
        )
    else:
        weighted_coverage = coverage

    latest_regime = str(current_regime or "unknown")
    latest_q = float(regime_q.get(latest_regime, global_q))
    latest_lower = float((latest_return_pred - latest_q) * 100.0)
    latest_upper = float((latest_return_pred + latest_q) * 100.0)

    return {
        "method": "adaptive_regime_abs_residual",
        "alpha": float(alpha),
        "qLevel": float(q_level),
        "globalQAbsReturn": float(global_q),
        "regimeQAbsReturn": {k: float(v) for k, v in regime_q.items()},
        "validationRegimeCounts": {k: int(v) for k, v in val_counts.items()},
        "testRegimeCounts": {k: int(v) for k, v in test_counts.items()},
        "coverageTest": float(coverage),
        "coverageShiftWeightedTest": float(weighted_coverage),
        "sharpnessPct": float(sharpness_pct),
        "latestRegime": latest_regime,
        "latestLowerExpectedReturnPct": float(latest_lower),
        "latestUpperExpectedReturnPct": float(latest_upper),
        "shiftWeightsByRegime": {
            k: float(v) for k, v in shift_weights_by_regime.items()
        },
    }


def rolling_std(values: Sequence[float], window: int) -> List[float]:
    out: List[float] = []
    w = max(1, int(window))
    for i in range(len(values)):
        start = max(0, i - w + 1)
        out.append(float(std(values[start : i + 1])))
    return out


def ema_series(values: Sequence[float], period: int) -> List[float]:
    if not values:
        return []
    p = max(1, int(period))
    alpha = 2.0 / (p + 1.0)
    out = [float(values[0])]
    for i in range(1, len(values)):
        out.append(float(alpha * values[i] + (1.0 - alpha) * out[-1]))
    return out


def compute_regime_feature_matrix(
    candles: Sequence[Dict[str, Any]],
    sample_times: Any,
) -> Dict[str, Any]:
    closes = [float(c["close"]) for c in candles]
    highs = [float(c["high"]) for c in candles]
    lows = [float(c["low"]) for c in candles]
    volumes = [float(c["volume"]) for c in candles]
    times = [int(c["time"]) for c in candles]

    if not closes:
        return {
            "names": [
                "vol20",
                "vol60",
                "atr14Pct",
                "trend",
                "rangePct",
                "volumeZ20",
            ],
            "values": np.zeros((0, 6), dtype=float),
            "diagnostics": {
                "sampleTimeCount": 0,
                "timeIndexMissCount": 0,
                "fallbackToLastIndexCount": 0,
                "futureAlignmentRisk": 0.0,
            },
        }

    ret = [0.0 for _ in closes]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        ret[i] = closes[i] / prev - 1.0 if prev > 0 else 0.0

    vol20 = rolling_std(ret, 20)
    vol60 = rolling_std(ret, 60)
    atr14_raw = atr(candles, 14)
    atr14_pct = [
        float(atr14_raw[i] / closes[i]) if closes[i] else 0.0
        for i in range(len(closes))
    ]
    ema_fast = ema_series(closes, 12)
    ema_slow = ema_series(closes, 48)
    trend = [
        float((ema_fast[i] / ema_slow[i] - 1.0) if ema_slow[i] else 0.0)
        for i in range(len(closes))
    ]
    range_pct = [
        float((highs[i] - lows[i]) / closes[i]) if closes[i] else 0.0
        for i in range(len(closes))
    ]
    volume_z20: List[float] = []
    for i in range(len(volumes)):
        start = max(0, i - 19)
        v_slice = volumes[start : i + 1]
        v_mean = mean(v_slice)
        v_std = std(v_slice) + 1e-8
        volume_z20.append(float((volumes[i] - v_mean) / v_std))

    time_to_idx = {int(t): idx for idx, t in enumerate(times)}
    features: List[List[float]] = []
    sample_count = 0
    time_index_miss_count = 0
    fallback_to_last_index_count = 0
    for ts in np.array(sample_times, dtype=int).reshape(-1):
        sample_count += 1
        idx = time_to_idx.get(int(ts))
        if idx is None:
            time_index_miss_count += 1
            fallback_to_last_index_count += 1
            idx = min(max(int(len(closes) - 1), 0), len(closes) - 1)
        features.append(
            [
                vol20[idx],
                vol60[idx],
                atr14_pct[idx],
                trend[idx],
                range_pct[idx],
                volume_z20[idx],
            ]
        )

    return {
        "names": [
            "vol20",
            "vol60",
            "atr14Pct",
            "trend",
            "rangePct",
            "volumeZ20",
        ],
        "values": np.array(features, dtype=float),
        "diagnostics": {
            "sampleTimeCount": int(sample_count),
            "timeIndexMissCount": int(time_index_miss_count),
            "fallbackToLastIndexCount": int(fallback_to_last_index_count),
            "futureAlignmentRisk": float(
                fallback_to_last_index_count / max(1, sample_count)
            ),
        },
    }


def _rule_regime_labels_from_features(
    train_feats: Any,
    all_feats: Any,
    count: int,
) -> List[str]:
    vol_col_train = train_feats[:, 0] if train_feats.shape[1] > 0 else np.zeros(0)
    atr_col_train = (
        train_feats[:, 2] if train_feats.shape[1] > 2 else np.zeros_like(vol_col_train)
    )
    trend_col_train = (
        train_feats[:, 3] if train_feats.shape[1] > 3 else np.zeros_like(vol_col_train)
    )
    vol_mix_train = np.maximum(vol_col_train, atr_col_train)
    abs_trend_train = np.abs(trend_col_train)
    vol_thr = float(np.quantile(vol_mix_train, 0.65)) if len(vol_mix_train) else 0.0
    trend_thr = (
        float(np.quantile(abs_trend_train, 0.60)) if len(abs_trend_train) else 0.0
    )

    labels: List[str] = []
    for row in all_feats:
        row_vol = float(row[0]) if len(row) > 0 else 0.0
        row_atr = float(row[2]) if len(row) > 2 else 0.0
        row_trend = float(row[3]) if len(row) > 3 else 0.0
        high_vol = max(row_vol, row_atr) >= vol_thr
        trending = abs(row_trend) >= trend_thr
        if high_vol and trending:
            labels.append("HighVolTrend")
        elif high_vol:
            labels.append("HighVolMeanRevert")
        else:
            if count >= 4 and trending:
                labels.append("LowVolTrend")
            else:
                labels.append("LowVolCarry")
    return labels


def _adaptive_cluster_balance_threshold(
    *,
    sample_size: int,
    base_threshold: float,
    mode: str,
) -> float:
    threshold = float(base_threshold)
    if mode == "adaptive":
        if sample_size < 100:
            threshold *= 0.8
        elif sample_size > 1000:
            threshold *= 1.2
    return float(clip(threshold, 0.05, 0.20))


def detect_regime_labels(
    regime_method: str,
    regime_count: int,
    seed: int,
    regime_features: Any,
    train_size: int,
    labeling_mode: str = "original",
    kmeans_zclip: float = 8.0,
    kmeans_scale_floor: float = 1e-6,
    kmeans_min_cluster_balance: float = 0.10,
    kmeans_balance_threshold_mode: str = "static",
    diagnostics_level: str = "basic",
    time_index_diagnostics: Optional[Dict[str, Any]] = None,
) -> Tuple[List[str], Dict[str, Any]]:
    method_requested = (regime_method or "rule").strip().lower()
    method = method_requested if method_requested in {"rule", "kmeans"} else "rule"
    labeling_mode = str(labeling_mode or "original").strip().lower()
    if labeling_mode not in {"original", "strict"}:
        labeling_mode = "original"
    diagnostics_level = str(diagnostics_level or "basic").strip().lower()
    if diagnostics_level not in {"basic", "extended"}:
        diagnostics_level = "basic"
    balance_mode = str(kmeans_balance_threshold_mode or "static").strip().lower()
    if balance_mode not in {"static", "adaptive"}:
        balance_mode = "static"

    zclip_cap = float(clip(float(kmeans_zclip), 2.0, 25.0))
    scale_floor = float(clip(float(kmeans_scale_floor), 1e-8, 1.0))
    min_cluster_balance = float(clip(float(kmeans_min_cluster_balance), 0.01, 0.90))
    diagnostics: Dict[str, Any] = {
        "methodRequested": method_requested,
        "methodUsed": method,
        "labelingMode": labeling_mode,
        "fallbackApplied": False,
        "fallbackReason": "",
        "fallbackReasonCode": "",
        "uniqueTrainRows": 0,
        "clusterCount": 0,
        "clusterSizes": [],
        "clusterBalanceRatio": None,
        "clusterBalanceThreshold": None,
        "clusterBalanceThresholdMode": balance_mode,
        "zclipCap": zclip_cap,
        "scaleFloor": scale_floor,
        "numericWarningCount": 0,
        "featureConditionNumber": None,
        "diagnosticsLevel": diagnostics_level,
    }
    if isinstance(time_index_diagnostics, dict):
        diagnostics["sampleTimeCount"] = int(time_index_diagnostics.get("sampleTimeCount", 0))
        diagnostics["timeIndexMissCount"] = int(time_index_diagnostics.get("timeIndexMissCount", 0))
        diagnostics["fallbackToLastIndexCount"] = int(
            time_index_diagnostics.get("fallbackToLastIndexCount", 0)
        )
        diagnostics["futureAlignmentRisk"] = float(
            time_index_diagnostics.get("futureAlignmentRisk", 0.0)
        )

    n = int(regime_features.shape[0])
    if n <= 0:
        diagnostics["methodUsed"] = "rule"
        diagnostics["fallbackApplied"] = True
        diagnostics["fallbackReason"] = "empty_regime_features"
        diagnostics["fallbackReasonCode"] = "ERR_DATA_000"
        return [], diagnostics

    train_size = int(clip(float(train_size), 1.0, float(n)))
    train_feats, all_feats = sanitize_regime_feature_matrix(
        regime_features,
        train_size=train_size,
        clip_quantile=0.995,
        min_cap=1e-4,
        max_cap=25.0,
    )

    count = int(max(3, min(int(regime_count), 4)))
    count = int(min(count, max(1, int(train_feats.shape[0]))))
    diagnostics["clusterCount"] = count

    def mark_fallback(reason: str, code: str) -> None:
        diagnostics["fallbackApplied"] = True
        diagnostics["fallbackReason"] = reason
        diagnostics["fallbackReasonCode"] = code
        diagnostics["methodUsed"] = "rule"

    if method == "kmeans" and count < 2:
        mark_fallback("insufficient_train_rows", "ERR_CLUSTER_004")
        method = "rule"

    if method == "kmeans" and count >= 2:
        try:
            from sklearn.cluster import KMeans

            unique_train = np.unique(np.round(train_feats, decimals=8), axis=0)
            unique_train_rows = int(unique_train.shape[0])
            diagnostics["uniqueTrainRows"] = unique_train_rows
            if unique_train_rows < count:
                raise ValueError("insufficient_unique_rows")

            train_mean = np.median(train_feats, axis=0)
            train_mean = np.nan_to_num(train_mean, nan=0.0, posinf=0.0, neginf=0.0)
            train_scale = np.std(train_feats, axis=0)
            train_scale = np.nan_to_num(train_scale, nan=1.0, posinf=1.0, neginf=1.0)
            train_scale = np.where(train_scale > scale_floor, train_scale, scale_floor)
            z_train = (train_feats - train_mean) / train_scale
            z_all = (all_feats - train_mean) / train_scale
            z_train = np.clip(z_train, -zclip_cap, zclip_cap)
            z_all = np.clip(z_all, -zclip_cap, zclip_cap)
            z_train = sanitize_feature_matrix(z_train, cap=max(5.0, zclip_cap))
            z_all = sanitize_feature_matrix(z_all, cap=max(5.0, zclip_cap))
            if not np.isfinite(z_train).all() or not np.isfinite(z_all).all():
                raise ValueError("non_finite_regime_features")
            try:
                condition_target = z_train
                if int(z_train.shape[0]) > int(z_train.shape[1]):
                    condition_target = np.cov(z_train, rowvar=False)
                condition_number = float(np.linalg.cond(condition_target))
                if math.isfinite(condition_number):
                    diagnostics["featureConditionNumber"] = condition_number
            except Exception:
                diagnostics["featureConditionNumber"] = None
            km = KMeans(n_clusters=count, random_state=seed, n_init=10)
            with warnings.catch_warnings(record=True) as captured_warnings:
                warnings.simplefilter("always", RuntimeWarning)
                km.fit(z_train)
                labels_train = km.predict(z_train)
                labels_original = km.predict(z_all)
            numeric_warning_count = sum(
                1
                for item in captured_warnings
                if issubclass(item.category, RuntimeWarning)
            )
            diagnostics["numericWarningCount"] = int(numeric_warning_count)
            if not np.isfinite(km.cluster_centers_).all():
                raise ValueError("non_finite_kmeans_centers")
            if not np.isfinite(labels_train).all():
                raise ValueError("non_finite_kmeans_labels")
            cluster_count = int(np.unique(labels_train).shape[0])
            if cluster_count < min(2, count):
                raise ValueError("insufficient_clusters")
            cluster_sizes = np.bincount(labels_train, minlength=count).astype(int)
            diagnostics["clusterCount"] = cluster_count
            diagnostics["clusterSizes"] = [int(v) for v in cluster_sizes.tolist()]
            max_cluster = int(np.max(cluster_sizes)) if len(cluster_sizes) else 0
            min_cluster = int(np.min(cluster_sizes)) if len(cluster_sizes) else 0
            cluster_balance_ratio = (
                float(min_cluster / max(1, max_cluster)) if max_cluster > 0 else 0.0
            )
            balance_threshold = _adaptive_cluster_balance_threshold(
                sample_size=int(train_feats.shape[0]),
                base_threshold=min_cluster_balance,
                mode=balance_mode,
            )
            diagnostics["clusterBalanceRatio"] = cluster_balance_ratio
            diagnostics["clusterBalanceThreshold"] = balance_threshold
            if cluster_balance_ratio < balance_threshold:
                raise ValueError("imbalanced_clusters")

            if labeling_mode == "strict":
                labels = np.array(labels_original, dtype=int)
                labels[:train_size] = labels_train
                for idx in range(train_size, len(labels)):
                    if idx <= 0:
                        continue
                    prev_label = int(labels[idx - 1])
                    curr_point = z_all[idx]
                    curr_pred = int(labels_original[idx])
                    if curr_pred == prev_label:
                        labels[idx] = prev_label
                        continue
                    prev_dist = float(
                        np.sum((curr_point - km.cluster_centers_[prev_label]) ** 2)
                    )
                    curr_dist = float(
                        np.sum((curr_point - km.cluster_centers_[curr_pred]) ** 2)
                    )
                    labels[idx] = curr_pred if curr_dist < prev_dist * 0.85 else prev_label
            else:
                labels = labels_original
            diagnostics["methodUsed"] = "kmeans"
            return [f"Cluster{int(v)}" for v in labels], diagnostics
        except Exception as exc:
            reason_text = str(exc).strip().lower()
            if "insufficient_unique_rows" in reason_text:
                mark_fallback("insufficient_unique_rows", "ERR_CLUSTER_001")
            elif "insufficient_clusters" in reason_text:
                mark_fallback("insufficient_clusters", "ERR_CLUSTER_002")
            elif "imbalanced_clusters" in reason_text:
                mark_fallback("imbalanced_clusters", "ERR_CLUSTER_003")
            elif "non_finite" in reason_text:
                mark_fallback("numerical_instability", "ERR_NUMERIC_001")
            else:
                mark_fallback("kmeans_exception", "ERR_CLUSTER_999")
            print(
                f"[ml_ensemble_v1] regime kmeans fallback to rule "
                f"(reason={type(exc).__name__})",
                file=sys.stderr,
            )
            method = "rule"
    else:
        diagnostics["methodUsed"] = "rule"

    labels = _rule_regime_labels_from_features(train_feats, all_feats, count)
    return labels, diagnostics


def compute_distribution(labels: Sequence[str]) -> Dict[str, float]:
    if not labels:
        return {}
    total = float(len(labels))
    out: Dict[str, float] = {}
    for label in labels:
        out[label] = out.get(label, 0.0) + 1.0
    for key in list(out.keys()):
        out[key] = float(out[key] / total)
    return out


def robust_zscore(values: Dict[str, float]) -> Dict[str, float]:
    if not values:
        return {}
    keys = list(values.keys())
    arr = np.array([values[k] for k in keys], dtype=float)
    med = float(np.median(arr))
    mad = float(np.median(np.abs(arr - med)))
    if mad <= 1e-12:
        spread = float(np.std(arr))
        denom = spread if spread > 1e-12 else 1.0
    else:
        denom = 1.4826 * mad
    return {k: float((values[k] - med) / denom) for k in keys}


def normalize_hybrid_weights(raw: Mapping[str, Any] | None) -> Dict[str, float]:
    defaults = {
        "accuracyLift": 0.20,
        "robustCostAwareUtility": 0.30,
        "netSharpeAfterCost": 0.20,
        "rmsePct": 0.10,
        "winRateAfterCost": 0.10,
        "turnoverPerBar": 0.10,
    }
    merged = dict(defaults)
    if raw:
        for key in defaults:
            try:
                merged[key] = max(0.0, float(raw.get(key, merged[key])))
            except Exception:
                pass
    s = float(sum(merged.values()))
    if s <= 1e-12:
        return defaults
    return {k: float(v / s) for k, v in merged.items()}


def compute_hybrid_scores(
    metrics_by_model: Dict[str, Dict[str, Any]],
    weights: Dict[str, float],
) -> Dict[str, float]:
    if not metrics_by_model:
        return {}

    negative_metrics = {"rmsePct", "turnoverPerBar"}
    max_abs_metric_z = 6.0
    max_abs_score = 6.0
    near_constant_std = 1e-9
    z_by_metric: Dict[str, Dict[str, float]] = {}
    for metric in weights.keys():
        metric_values: Dict[str, float] = {}
        for model, metrics in metrics_by_model.items():
            v = pick_metric(metrics, metric)
            metric_values[model] = 0.0 if v is None else float(v)
        vals = np.array(list(metric_values.values()), dtype=float)
        if len(vals) <= 1 or float(np.std(vals)) < near_constant_std:
            z_by_metric[metric] = {k: 0.0 for k in metric_values.keys()}
            continue
        z_map = robust_zscore(metric_values)
        if metric in negative_metrics:
            z_map = {k: -float(v) for k, v in z_map.items()}
        z_by_metric[metric] = {
            k: float(clip(v, -max_abs_metric_z, max_abs_metric_z))
            if np.isfinite(v)
            else 0.0
            for k, v in z_map.items()
        }

    scores: Dict[str, float] = {}
    for model in metrics_by_model.keys():
        score = 0.0
        for metric, weight in weights.items():
            score += float(weight) * float(z_by_metric.get(metric, {}).get(model, 0.0))
        if not np.isfinite(score):
            score = 0.0
        scores[model] = float(clip(score, -max_abs_score, max_abs_score))
    return scores


def brier_score(y_true: Any, y_prob: Any) -> float:
    y = np.array(y_true, dtype=float).reshape(-1)
    p = sanitize_probabilities(y_prob)
    if len(y) == 0:
        return 0.0
    return float(np.mean((y - p) ** 2))


def calibrate_probabilities(
    method: str,
    y_valid: Any,
    p_valid: Any,
    p_test: Any,
    p_latest: float,
) -> Dict[str, Any]:
    y_val = np.array(y_valid, dtype=int).reshape(-1)
    p_val = sanitize_probabilities(p_valid)
    p_test_in = sanitize_probabilities(p_test)
    p_last_in = float(clip(float(p_latest), 0.0, 1.0))

    before = brier_score(y_val, p_val)
    details = {
        "method": (method or "none").strip().lower(),
        "brierBefore": before,
        "brierAfter": before,
        "applied": False,
    }
    if len(y_val) < 40 or len(np.unique(y_val)) < 2:
        details["method"] = "none"
        details["reason"] = "insufficient_validation_labels"
        return {
            "pValid": p_val,
            "pTest": p_test_in,
            "pLatest": p_last_in,
            "details": details,
        }

    m = details["method"]
    if m not in {"sigmoid", "isotonic"}:
        details["method"] = "none"
        return {
            "pValid": p_val,
            "pTest": p_test_in,
            "pLatest": p_last_in,
            "details": details,
        }

    try:
        if m == "sigmoid":
            from sklearn.linear_model import LogisticRegression

            x_val = np.log(
                np.clip(p_val, 1e-6, 1.0 - 1e-6) / np.clip(1.0 - p_val, 1e-6, 1.0)
            )
            x_val = x_val.reshape(-1, 1)
            model = LogisticRegression(max_iter=1500, C=0.5, solver="liblinear")
            run_with_runtime_warning_guard(lambda: model.fit(x_val, y_val))

            p_val_cal = run_with_runtime_warning_guard(
                lambda: sanitize_probabilities(model.predict_proba(x_val)[:, 1])
            )
            brier_after = brier_score(y_val, p_val_cal)
            if brier_after <= before + 1e-12:
                x_test = np.log(
                    np.clip(p_test_in, 1e-6, 1.0 - 1e-6)
                    / np.clip(1.0 - p_test_in, 1e-6, 1.0)
                ).reshape(-1, 1)
                x_last = np.array(
                    [
                        math.log(
                            clip(p_last_in, 1e-6, 1.0 - 1e-6)
                            / clip(1.0 - p_last_in, 1e-6, 1.0)
                        )
                    ],
                    dtype=float,
                ).reshape(-1, 1)
                p_test_out = run_with_runtime_warning_guard(
                    lambda: sanitize_probabilities(model.predict_proba(x_test)[:, 1])
                )
                p_last_out = float(
                    run_with_runtime_warning_guard(
                        lambda: sanitize_probabilities(
                            model.predict_proba(x_last)[:, 1]
                        )
                    )[0]
                )
                details["brierAfter"] = float(brier_after)
                details["applied"] = True
                return {
                    "pValid": p_val_cal,
                    "pTest": p_test_out,
                    "pLatest": p_last_out,
                    "details": details,
                }
        else:
            from sklearn.isotonic import IsotonicRegression

            model = IsotonicRegression(out_of_bounds="clip")
            model.fit(p_val, y_val)
            p_val_cal = sanitize_probabilities(model.predict(p_val))
            brier_after = brier_score(y_val, p_val_cal)
            if brier_after <= before + 1e-12:
                p_test_out = sanitize_probabilities(model.predict(p_test_in))
                p_last_out = float(
                    sanitize_probabilities(model.predict([p_last_in]))[0]
                )
                details["brierAfter"] = float(brier_after)
                details["applied"] = True
                return {
                    "pValid": p_val_cal,
                    "pTest": p_test_out,
                    "pLatest": p_last_out,
                    "details": details,
                }
    except Exception as exc:
        details["reason"] = f"calibration_failed:{exc}"
        return {
            "pValid": p_val,
            "pTest": p_test_in,
            "pLatest": p_last_in,
            "details": details,
        }

    details["reason"] = "brier_worse_after_calibration"
    return {
        "pValid": p_val,
        "pTest": p_test_in,
        "pLatest": p_last_in,
        "details": details,
    }


def resolve_three_way_split(
    sample_count: int,
    train_ratio: float,
    lock_ratio: float,
) -> Tuple[int, int]:
    n = int(sample_count)
    lock_ratio = clip(float(lock_ratio), 0.05, 0.30)
    locked_size = max(20, int(round(n * lock_ratio)))
    max_locked = max(20, n - 80)
    locked_size = min(locked_size, max_locked)
    if n - locked_size < 80:
        locked_size = max(20, n - 80)

    unlocked = n - locked_size
    train_ratio = clip(float(train_ratio), 0.5, 0.9)
    train_size = int(round(unlocked * train_ratio))
    train_size = max(80, min(train_size, unlocked - 20))
    val_size = unlocked - train_size
    if val_size < 20:
        val_size = 20
        train_size = unlocked - val_size
    if train_size < 80 or val_size < 20:
        raise ValueError(
            f"Unable to allocate train/validation/locked_test split for n={n}"
        )
    train_end = train_size
    val_end = train_size + val_size
    if not (0 < train_end < val_end < n):
        raise ValueError(
            f"Invalid split boundaries: train_end={train_end}, val_end={val_end}, n={n}"
        )
    return train_end, val_end


def model_search_space(model_name: str) -> List[Dict[str, Any]]:
    if model_name == "randomForest":
        return [
            {"n_estimators": 90, "max_depth": 5, "min_samples_leaf": 5},
            {"n_estimators": 140, "max_depth": 6, "min_samples_leaf": 3},
            {"n_estimators": 180, "max_depth": 8, "min_samples_leaf": 2},
            {"n_estimators": 120, "max_depth": 4, "min_samples_leaf": 6},
        ]
    if model_name == "ridge":
        return [
            {"clf_C": 0.4, "reg_alpha": 4.0},
            {"clf_C": 0.6, "reg_alpha": 3.0},
            {"clf_C": 0.3, "reg_alpha": 6.0},
            {"clf_C": 0.8, "reg_alpha": 2.0},
        ]
    if model_name == "xgboost":
        return [
            {
                "n_estimators": 70,
                "max_depth": 3,
                "learning_rate": 0.05,
                "subsample": 0.9,
                "colsample_bytree": 0.85,
                "reg_lambda": 1.0,
            },
            {
                "n_estimators": 100,
                "max_depth": 4,
                "learning_rate": 0.04,
                "subsample": 0.9,
                "colsample_bytree": 0.9,
                "reg_lambda": 1.0,
            },
            {
                "n_estimators": 120,
                "max_depth": 3,
                "learning_rate": 0.03,
                "subsample": 0.85,
                "colsample_bytree": 0.8,
                "reg_lambda": 2.0,
            },
            {
                "n_estimators": 80,
                "max_depth": 5,
                "learning_rate": 0.06,
                "subsample": 0.8,
                "colsample_bytree": 0.8,
                "reg_lambda": 1.0,
            },
        ]
    if model_name == "lightgbm":
        return [
            {
                "n_estimators": 80,
                "num_leaves": 21,
                "learning_rate": 0.05,
                "subsample": 0.9,
                "colsample_bytree": 0.85,
                "min_child_samples": 20,
            },
            {
                "n_estimators": 120,
                "num_leaves": 31,
                "learning_rate": 0.04,
                "subsample": 0.9,
                "colsample_bytree": 0.9,
                "min_child_samples": 15,
            },
            {
                "n_estimators": 140,
                "num_leaves": 41,
                "learning_rate": 0.03,
                "subsample": 0.85,
                "colsample_bytree": 0.8,
                "min_child_samples": 25,
            },
            {
                "n_estimators": 100,
                "num_leaves": 17,
                "learning_rate": 0.06,
                "subsample": 0.8,
                "colsample_bytree": 0.85,
                "min_child_samples": 30,
            },
        ]
    if model_name == "catboost":
        return [
            {"iterations": 80, "depth": 5, "learning_rate": 0.05, "l2_leaf_reg": 3.0},
            {"iterations": 120, "depth": 4, "learning_rate": 0.04, "l2_leaf_reg": 5.0},
            {"iterations": 150, "depth": 6, "learning_rate": 0.03, "l2_leaf_reg": 3.0},
            {"iterations": 100, "depth": 5, "learning_rate": 0.06, "l2_leaf_reg": 7.0},
        ]
    if model_name == "pytorch":
        return [
            {
                "hidden_dim": 32,
                "dropout": 0.05,
                "lr": 0.0015,
                "weight_decay": 5e-05,
                "epochs": 30,
                "batch_size": 128,
            },
            {
                "hidden_dim": 48,
                "dropout": 0.1,
                "lr": 0.001,
                "weight_decay": 1e-04,
                "epochs": 40,
                "batch_size": 128,
            },
            {
                "hidden_dim": 64,
                "dropout": 0.15,
                "lr": 0.0008,
                "weight_decay": 1e-04,
                "epochs": 50,
                "batch_size": 64,
            },
        ]
    return []


def choose_candidate_params(
    model_name: str, seed: int, nas_trials: int
) -> List[Dict[str, Any]]:
    space = model_search_space(model_name)
    if not space:
        return []
    nas_trials = max(1, min(int(nas_trials), len(space)))
    if nas_trials >= len(space):
        return [dict(row) for row in space]
    if nas_trials == 1:
        return [dict(space[0])]

    rng = np.random.default_rng(seed + stable_seed_offset(model_name))
    picked_idx = [0]
    remaining = list(range(1, len(space)))
    sample_size = min(len(remaining), nas_trials - 1)
    sampled = rng.choice(remaining, size=sample_size, replace=False)
    picked_idx.extend(sorted(int(i) for i in np.array(sampled).reshape(-1)))
    return [dict(space[i]) for i in picked_idx]


def build_model_pair(
    model_name: str,
    seed: int,
    params: Mapping[str, Any],
) -> Tuple[Any, Any]:
    if model_name == "randomForest":
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor

        clf = RandomForestClassifier(
            n_estimators=int(params.get("n_estimators", 90)),
            max_depth=int(params.get("max_depth", 5)),
            min_samples_leaf=int(params.get("min_samples_leaf", 5)),
            random_state=seed,
            n_jobs=1,
        )
        reg = RandomForestRegressor(
            n_estimators=int(params.get("n_estimators", 90)),
            max_depth=int(params.get("max_depth", 5)),
            min_samples_leaf=int(params.get("min_samples_leaf", 5)),
            random_state=seed,
            n_jobs=1,
        )
        return clf, reg

    if model_name == "ridge":
        from sklearn.linear_model import LogisticRegression, Ridge
        from sklearn.pipeline import make_pipeline
        from sklearn.preprocessing import RobustScaler

        clf_c = clip(float(params.get("clf_C", 0.4)), 0.05, 1.0)
        reg_alpha = max(1.0, float(params.get("reg_alpha", 4.0)))
        clf = make_pipeline(
            RobustScaler(quantile_range=(5.0, 95.0), with_scaling=False),
            LogisticRegression(
                max_iter=1500,
                random_state=seed,
                C=clf_c,
                solver="liblinear",
            ),
        )
        reg = make_pipeline(
            RobustScaler(quantile_range=(5.0, 95.0), with_scaling=False),
            Ridge(alpha=reg_alpha, solver="svd"),
        )
        return clf, reg

    if model_name == "xgboost":
        from xgboost import XGBClassifier, XGBRegressor

        base = {
            "n_estimators": int(params.get("n_estimators", 70)),
            "max_depth": int(params.get("max_depth", 3)),
            "learning_rate": float(params.get("learning_rate", 0.05)),
            "subsample": float(params.get("subsample", 0.9)),
            "colsample_bytree": float(params.get("colsample_bytree", 0.85)),
            "reg_lambda": float(params.get("reg_lambda", 1.0)),
        }
        clf = XGBClassifier(
            **base,
            random_state=seed,
            objective="binary:logistic",
            eval_metric="logloss",
            tree_method="hist",
            n_jobs=1,
        )
        reg = XGBRegressor(
            **base,
            random_state=seed,
            objective="reg:squarederror",
            tree_method="hist",
            n_jobs=1,
        )
        return clf, reg

    if model_name == "lightgbm":
        from lightgbm import LGBMClassifier, LGBMRegressor

        base = {
            "n_estimators": int(params.get("n_estimators", 80)),
            "num_leaves": int(params.get("num_leaves", 21)),
            "learning_rate": float(params.get("learning_rate", 0.05)),
            "subsample": float(params.get("subsample", 0.9)),
            "colsample_bytree": float(params.get("colsample_bytree", 0.85)),
            "min_child_samples": int(params.get("min_child_samples", 20)),
            "random_state": seed,
            "verbose": -1,
        }
        clf = LGBMClassifier(**base)
        reg = LGBMRegressor(**base)
        return clf, reg

    if model_name == "catboost":
        from catboost import CatBoostClassifier, CatBoostRegressor

        base = {
            "iterations": int(params.get("iterations", 80)),
            "depth": int(params.get("depth", 5)),
            "learning_rate": float(params.get("learning_rate", 0.05)),
            "l2_leaf_reg": float(params.get("l2_leaf_reg", 3.0)),
            "random_seed": seed,
            "verbose": False,
        }
        clf = CatBoostClassifier(**base, loss_function="Logloss")
        reg = CatBoostRegressor(**base, loss_function="RMSE")
        return clf, reg

    if model_name == "pytorch":
        # Lazy-import validation so unsupported envs can still run other models.
        safe_import_torch()
        base = {
            "hidden_dim": int(params.get("hidden_dim", 48)),
            "dropout": float(params.get("dropout", 0.1)),
            "lr": float(params.get("lr", 0.001)),
            "weight_decay": float(params.get("weight_decay", 1e-4)),
            "epochs": int(params.get("epochs", 40)),
            "batch_size": int(params.get("batch_size", 128)),
            "patience": int(params.get("patience", 8)),
        }
        clf = TorchMLPBinaryClassifier(seed=seed, **base)
        reg = TorchMLPRegressor(seed=seed, **base)
        return clf, reg

    raise ValueError(f"unknown_model: {model_name}")


def split_for_nas(
    X: Any,
    y_dir: Any,
    y_ret: Any,
) -> Tuple[Any, Any, Any, Any, Any, Any] | None:
    n = int(len(X))
    if n < 140:
        return None
    val_size = max(40, int(n * 0.2))
    if n - val_size < 80:
        val_size = max(30, n - 80)
    if val_size < 30 or n - val_size < 60:
        return None

    split = n - val_size
    return (
        X[:split],
        X[split:],
        y_dir[:split],
        y_dir[split:],
        y_ret[:split],
        y_ret[split:],
    )


def build_expanding_oof_predictions(
    model_name: str,
    seed: int,
    params: Mapping[str, Any],
    X: Any,
    y_dir: Any,
    y_ret: Any,
    folds: int = 4,
    gap_bars: int = 0,
) -> Tuple[Any, Any, float, List[Dict[str, int]]]:
    n = int(len(X))
    if n < 120:
        return (
            np.full(n, np.nan, dtype=float),
            np.full(n, np.nan, dtype=float),
            0.0,
            [],
        )

    folds = max(2, min(int(folds), 8))
    min_train = max(80, int(n * 0.4))
    if min_train >= n - 10:
        min_train = max(60, n - 20)

    remaining = max(0, n - min_train)
    fold_size = max(20, remaining // folds) if remaining > 0 else 0
    if fold_size <= 0:
        return (
            np.full(n, np.nan, dtype=float),
            np.full(n, np.nan, dtype=float),
            0.0,
            [],
        )

    p_oof = np.full(n, np.nan, dtype=float)
    r_oof = np.full(n, np.nan, dtype=float)
    gaps: List[Dict[str, int]] = []

    fold_idx = 0
    start = min_train
    gap = max(0, int(gap_bars))
    while start < n:
        val_start = min(n, start + gap)
        end = min(n, val_start + fold_size)
        if end - val_start < 10:
            break

        train_end = start
        if gap > 0 and val_start > train_end:
            gaps.append(
                {
                    "fold": int(fold_idx),
                    "trainEnd": int(train_end),
                    "valStart": int(val_start),
                    "gapBars": int(val_start - train_end),
                }
            )
        X_fold_train = X[:train_end]
        y_fold_train_dir = y_dir[:train_end]
        y_fold_train_ret = y_ret[:train_end]
        X_fold_val = X[val_start:end]

        try:
            if len(np.unique(y_fold_train_dir)) >= 2:
                clf_fold, reg_fold = build_model_pair(
                    model_name,
                    seed=seed + 1009 + fold_idx * 37 + stable_seed_offset(model_name),
                    params=params,
                )
                run_with_runtime_warning_guard(
                    lambda: clf_fold.fit(X_fold_train, y_fold_train_dir)
                )
                run_with_runtime_warning_guard(
                    lambda: reg_fold.fit(X_fold_train, y_fold_train_ret)
                )
                p_val = run_with_runtime_warning_guard(
                    lambda: sanitize_probabilities(
                        model_predict_proba(clf_fold, X_fold_val)
                    )
                )
                r_val = run_with_runtime_warning_guard(
                    lambda: sanitize_returns(reg_fold.predict(X_fold_val), cap=1.0)
                )
            else:
                # Classification fallback when early folds have a single class.
                p_const = (
                    float(np.mean(y_fold_train_dir)) if len(y_fold_train_dir) else 0.5
                )
                r_const = (
                    float(np.mean(y_fold_train_ret)) if len(y_fold_train_ret) else 0.0
                )
                p_val = sanitize_probabilities(
                    np.full(end - val_start, p_const, dtype=float)
                )
                r_val = sanitize_returns(
                    np.full(end - val_start, r_const, dtype=float), cap=1.0
                )
        except Exception:
            p_const = float(np.mean(y_fold_train_dir)) if len(y_fold_train_dir) else 0.5
            r_const = float(np.mean(y_fold_train_ret)) if len(y_fold_train_ret) else 0.0
            p_val = sanitize_probabilities(
                np.full(end - val_start, p_const, dtype=float)
            )
            r_val = sanitize_returns(
                np.full(end - val_start, r_const, dtype=float), cap=1.0
            )

        p_oof[val_start:end] = np.array(p_val, dtype=float).reshape(-1)
        r_oof[val_start:end] = np.array(r_val, dtype=float).reshape(-1)

        fold_idx += 1
        start = end

    coverage_mask = np.isfinite(p_oof) & np.isfinite(r_oof)
    coverage = float(np.mean(coverage_mask)) if n > 0 else 0.0
    return p_oof, r_oof, coverage, gaps


def fit_and_predict(payload: Dict[str, Any]) -> Dict[str, Any]:
    candles = payload.get("candles") or []
    if not candles:
        raise ValueError("`candles` is required and must be non-empty.")

    horizon = int(payload.get("horizonBars", 1))
    if horizon < 1:
        raise ValueError("`horizonBars` must be >= 1.")

    train_ratio = float(payload.get("trainRatio", 0.8))
    train_ratio = clip(train_ratio, 0.5, 0.9)
    min_confidence = clip(float(payload.get("minConfidence", 0.55)), 0.5, 0.9)
    min_expected_return_pct = float(payload.get("minExpectedReturnPct", 0.0))
    min_expected_return = min_expected_return_pct / 100.0
    seed = int(payload.get("seed", 42))
    ensemble_mode = str(payload.get("ensembleMode", "stacking")).strip().lower()
    if ensemble_mode not in {"stacking", "regime_moe"}:
        ensemble_mode = "stacking"
    regime_count = int(payload.get("regimeCount", 3))
    regime_method = str(payload.get("regimeMethod", "rule")).strip().lower()
    if regime_method not in {"rule", "kmeans"}:
        regime_method = "rule"
    regime_labeling_mode = str(payload.get("regimeLabelingMode", "original")).strip().lower()
    if regime_labeling_mode not in {"original", "strict"}:
        regime_labeling_mode = "original"
    regime_kmeans_zclip = clip(float(payload.get("regimeKmeansZclip", 8.0)), 2.0, 25.0)
    regime_kmeans_scale_floor = clip(
        float(payload.get("regimeKmeansScaleFloor", 1e-6)),
        1e-8,
        1.0,
    )
    regime_kmeans_min_cluster_balance = clip(
        float(payload.get("regimeKmeansMinClusterBalance", 0.10)),
        0.01,
        0.90,
    )
    regime_kmeans_balance_threshold_mode = str(
        payload.get("regimeKmeansBalanceThresholdMode", "static")
    ).strip().lower()
    if regime_kmeans_balance_threshold_mode not in {"static", "adaptive"}:
        regime_kmeans_balance_threshold_mode = "static"
    regime_kmeans_diagnostics_level = str(
        payload.get("regimeKmeansDiagnosticsLevel", "basic")
    ).strip().lower()
    if regime_kmeans_diagnostics_level not in {"basic", "extended"}:
        regime_kmeans_diagnostics_level = "basic"
    hybrid_weights = normalize_hybrid_weights(payload.get("hybridWeights"))
    oof_min_coverage_soft = clip(
        float(payload.get("oofMinCoverageSoft", 0.60)), 0.2, 0.95
    )
    oof_hard_floor = clip(float(payload.get("oofHardFloor", 0.25)), 0.05, 0.9)
    if oof_hard_floor > oof_min_coverage_soft:
        oof_hard_floor = oof_min_coverage_soft
    soft_fail_max_weight = clip(float(payload.get("softFailMaxWeight", 0.15)), 0.0, 1.0)
    tscv_gap_bars = max(0, int(payload.get("tscvGapBars", 2)))
    test_lock_ratio = clip(float(payload.get("testLockRatio", 0.10)), 0.05, 0.30)
    calibration_method = (
        str(payload.get("calibrationMethod", "sigmoid")).strip().lower()
    )
    if calibration_method not in {"none", "sigmoid", "isotonic"}:
        calibration_method = "sigmoid"
    risk_clamp_on_soft_warn = clip(
        float(payload.get("riskClampOnSoftStatWarn", 0.35)), 0.05, 1.0
    )

    labeling_mode = str(payload.get("labelingMode", "next_return_sign"))
    barrier_take_profit_atr = float(payload.get("barrierTakeProfitAtr", 1.5))
    barrier_stop_loss_atr = float(payload.get("barrierStopLossAtr", 1.0))
    barrier_max_horizon_bars = int(
        payload.get("barrierMaxHorizonBars", max(3, horizon))
    )

    cost_fee_rate = max(0.0, float(payload.get("costFeeRate", 0.0006)))
    cost_slippage_bps = max(0.0, float(payload.get("costSlippageBps", 8.0)))
    cost_latency_bars = max(0, int(payload.get("costLatencyBars", 1)))
    robust_per_bar_clip = clip(float(payload.get("robustPerBarClip", 0.25)), 0.01, 0.5)
    conformal_alpha = clip(float(payload.get("conformalAlpha", 0.10)), 0.01, 0.40)
    conformal_min_regime_samples = max(
        5, int(payload.get("conformalMinRegimeSamples", 25))
    )
    conformal_shift_weight_clip_min = clip(
        float(payload.get("conformalShiftWeightClipMin", 0.25)), 0.05, 1.0
    )
    conformal_shift_weight_clip_max = clip(
        float(payload.get("conformalShiftWeightClipMax", 4.0)), 1.0, 20.0
    )
    decision_use_conformal_lower_bound = parse_bool(
        payload.get("decisionUseConformalLowerBound"), default=False
    )
    model_safety_filter_enabled = parse_bool(
        payload.get("modelSafetyFilterEnabled"), default=True
    )
    model_safety_min_robust_cost_aware = float(
        payload.get("modelSafetyMinRobustCostAwareUtility", -0.08)
    )
    model_safety_min_cost_aware = float(
        payload.get("modelSafetyMinCostAwareUtility", -0.12)
    )
    model_safety_min_net_return_pct = float(
        payload.get("modelSafetyMinNetReturnPctAfterCost", -45.0)
    )
    model_safety_max_turnover_per_bar = clip(
        float(payload.get("modelSafetyMaxTurnoverPerBar", 1.0)), 0.0, 1.0
    )
    feature_clip_quantile = clip(
        float(payload.get("featureClipQuantile", 0.995)), 0.90, 0.9999
    )
    feature_clip_cap_min = clip(
        float(payload.get("featureClipCapMin", 1.0)), 0.1, 200.0
    )
    feature_clip_cap_max = clip(
        float(payload.get("featureClipCapMax", 250.0)),
        feature_clip_cap_min,
        5_000.0,
    )
    target_return_cap = clip(float(payload.get("targetReturnCap", 1.0)), 0.1, 5.0)

    selection_metric = str(payload.get("modelSelectionMetric", "accuracyLift"))
    selection_mode = resolve_selection_mode(
        selection_metric, str(payload.get("modelSelectionMode", "auto"))
    )

    nas_enabled = parse_bool(payload.get("nasEnabled"), default=False)
    nas_trials = int(payload.get("nasTrials", 2 if nas_enabled else 1))
    nas_trials = int(clip(nas_trials, 1, 6))
    nas_metric = str(payload.get("nasMetric", selection_metric))
    nas_mode = resolve_selection_mode(nas_metric, str(payload.get("nasMode", "auto")))

    requested_models = payload.get("includeModels") or [
        "xgboost",
        "lightgbm",
        "catboost",
        "randomForest",
        "ridge",
        "pytorch",
    ]
    requested_models = [str(m) for m in requested_models]
    if not requested_models:
        requested_models = ["randomForest", "ridge", "pytorch"]

    dataset = build_dataset(
        candles=candles,
        horizon=horizon,
        labeling_mode=labeling_mode,
        barrier_take_profit_atr=barrier_take_profit_atr,
        barrier_stop_loss_atr=barrier_stop_loss_atr,
        barrier_max_horizon_bars=barrier_max_horizon_bars,
    )
    n = int(dataset.X.shape[0])
    if n < 180:
        raise ValueError(
            f"Not enough labeled samples for ML ensemble: {n}, need >= 180."
        )

    train_end, val_end = resolve_three_way_split(
        sample_count=n,
        train_ratio=train_ratio,
        lock_ratio=test_lock_ratio,
    )

    X_train_raw = dataset.X[:train_end]
    X_val_raw = dataset.X[train_end:val_end]
    X_test_raw = dataset.X[val_end:]
    y_train_dir = dataset.y_dir[:train_end]
    y_val_dir = dataset.y_dir[train_end:val_end]
    y_test_dir = dataset.y_dir[val_end:]
    y_train_ret = sanitize_returns(dataset.y_ret[:train_end], cap=target_return_cap)
    y_val_ret = sanitize_returns(
        dataset.y_ret[train_end:val_end], cap=target_return_cap
    )
    y_test_ret = sanitize_returns(dataset.y_ret[val_end:], cap=target_return_cap)

    feature_caps = derive_feature_clip_caps(
        X_train_raw,
        quantile=feature_clip_quantile,
        min_cap=feature_clip_cap_min,
        max_cap=feature_clip_cap_max,
    )
    X_train = sanitize_feature_matrix_with_caps(
        X_train_raw, feature_caps, fallback_cap=feature_clip_cap_max
    )
    X_val = sanitize_feature_matrix_with_caps(
        X_val_raw, feature_caps, fallback_cap=feature_clip_cap_max
    )
    X_test = sanitize_feature_matrix_with_caps(
        X_test_raw, feature_caps, fallback_cap=feature_clip_cap_max
    )
    latest_features = sanitize_feature_matrix_with_caps(
        dataset.latest_features, feature_caps, fallback_cap=feature_clip_cap_max
    )
    feature_cap_median = float(np.median(feature_caps)) if len(feature_caps) else 0.0
    feature_cap_p95 = (
        float(np.quantile(feature_caps, 0.95)) if len(feature_caps) else 0.0
    )
    times_train = dataset.times[:train_end]
    times_val = dataset.times[train_end:val_end]
    times_test = dataset.times[val_end:]

    baseline_val_accuracy = majority_baseline_accuracy(y_val_dir)
    baseline_test_accuracy = majority_baseline_accuracy(y_test_dir)

    model_train_cls_oof: Dict[str, Any] = {}
    model_train_reg_oof: Dict[str, Any] = {}
    model_val_prob: Dict[str, Any] = {}
    model_val_ret_pred: Dict[str, Any] = {}
    model_test_prob: Dict[str, Any] = {}
    model_test_ret_pred: Dict[str, Any] = {}
    model_latest_prob: Dict[str, float] = {}
    model_latest_ret: Dict[str, float] = {}
    model_meta_coverage: Dict[str, float] = {}
    model_meta_gaps: Dict[str, List[Dict[str, int]]] = {}
    model_quality_state: Dict[str, str] = {}
    model_soft_capped: Dict[str, bool] = {}
    model_metrics_val: Dict[str, Dict[str, Any]] = {}
    model_metrics_test: Dict[str, Dict[str, Any]] = {}
    model_safety_pass: Dict[str, bool] = {}
    model_safety_reason: Dict[str, str] = {}

    def model_safety_reasons(metrics: Dict[str, Any]) -> List[str]:
        if not model_safety_filter_enabled:
            return []
        robust_cu = float(metrics.get("robustCostAwareUtility", 0.0))
        cost_aware = float(metrics.get("costAwareUtility", 0.0))
        net_pct = float(metrics.get("netReturnPctAfterCost", 0.0))
        turnover = float(metrics.get("turnoverPerBar", 0.0))
        reasons: List[str] = []
        if robust_cu < model_safety_min_robust_cost_aware:
            reasons.append("robust_cost_aware_below_floor")
        if cost_aware < model_safety_min_cost_aware:
            reasons.append("cost_aware_below_floor")
        if net_pct < model_safety_min_net_return_pct:
            reasons.append("net_return_below_floor")
        if turnover > model_safety_max_turnover_per_bar:
            reasons.append("turnover_above_cap")
        return reasons

    def model_passes_safety(metrics: Dict[str, Any]) -> bool:
        return len(model_safety_reasons(metrics)) == 0

    dropped: List[Dict[str, str]] = []
    base_votes: Dict[str, Dict[str, float]] = {}
    model_reports: List[Dict[str, Any]] = []
    used_model_names: List[str] = []

    for name in requested_models:
        candidates = choose_candidate_params(
            name, seed=seed, nas_trials=nas_trials if nas_enabled else 1
        )
        if not candidates:
            dropped.append({"model": name, "reason": "unknown_model"})
            continue

        chosen_params = dict(candidates[0])
        chosen_score: float | None = None
        candidate_reports: List[Dict[str, Any]] = []

        nas_split = split_for_nas(X_train, y_train_dir, y_train_ret)
        if nas_enabled and nas_split is not None:
            (
                X_nas_train,
                X_nas_val,
                y_nas_train_dir,
                y_nas_val_dir,
                y_nas_train_ret,
                y_nas_val_ret,
            ) = nas_split
            baseline_nas = majority_baseline_accuracy(y_nas_val_dir)

            for idx, params in enumerate(candidates):
                candidate_seed = seed + idx * 17 + stable_seed_offset(name)
                try:
                    c_clf, c_reg = build_model_pair(name, candidate_seed, params)
                    run_with_runtime_warning_guard(
                        lambda: c_clf.fit(X_nas_train, y_nas_train_dir)
                    )
                    run_with_runtime_warning_guard(
                        lambda: c_reg.fit(X_nas_train, y_nas_train_ret)
                    )
                    p_val = run_with_runtime_warning_guard(
                        lambda: sanitize_probabilities(
                            model_predict_proba(c_clf, X_nas_val)
                        )
                    )
                    r_val = run_with_runtime_warning_guard(
                        lambda: sanitize_returns(c_reg.predict(X_nas_val), cap=1.0)
                    )
                    c_metrics = evaluate_prediction_metrics(
                        y_true_dir=y_nas_val_dir,
                        y_true_ret=y_nas_val_ret,
                        y_prob=p_val,
                        y_ret_pred=r_val,
                        baseline_accuracy=baseline_nas,
                        fee_rate=cost_fee_rate,
                        slippage_bps=cost_slippage_bps,
                        latency_bars=cost_latency_bars,
                        robust_per_bar_clip=robust_per_bar_clip,
                    )
                    c_score = pick_metric(c_metrics, nas_metric)
                    candidate_reports.append(
                        {
                            "params": dict(params),
                            "objectiveScore": c_score,
                            "metrics": {
                                "directionAccuracy": c_metrics["directionAccuracy"],
                                "accuracyLift": c_metrics["accuracyLift"],
                                "costAwareUtility": c_metrics["costAwareUtility"],
                                "robustCostAwareUtility": c_metrics[
                                    "robustCostAwareUtility"
                                ],
                                "rmsePct": c_metrics["rmsePct"],
                            },
                        }
                    )
                    if better_score(c_score, chosen_score, nas_mode):
                        chosen_score = c_score
                        chosen_params = dict(params)
                except Exception as exc:
                    candidate_reports.append(
                        {
                            "params": dict(params),
                            "objectiveScore": None,
                            "error": f"{exc}",
                        }
                    )
        else:
            candidate_reports.append(
                {
                    "params": dict(chosen_params),
                    "objectiveScore": None,
                    "metrics": "nas_skipped",
                }
            )

        try:
            clf, reg = build_model_pair(name, seed=seed, params=chosen_params)
        except Exception as exc:
            dropped.append({"model": name, "reason": f"import_or_init_failed: {exc}"})
            continue

        try:
            run_with_runtime_warning_guard(lambda: clf.fit(X_train, y_train_dir))
            run_with_runtime_warning_guard(lambda: reg.fit(X_train, y_train_ret))
        except Exception as exc:
            dropped.append({"model": name, "reason": f"fit_failed: {exc}"})
            continue

        try:
            p_train = run_with_runtime_warning_guard(
                lambda: sanitize_probabilities(model_predict_proba(clf, X_train))
            )
            p_val = run_with_runtime_warning_guard(
                lambda: sanitize_probabilities(model_predict_proba(clf, X_val))
            )
            p_test = run_with_runtime_warning_guard(
                lambda: sanitize_probabilities(model_predict_proba(clf, X_test))
            )
            p_last = float(
                run_with_runtime_warning_guard(
                    lambda: sanitize_probabilities(
                        model_predict_proba(clf, latest_features.reshape(1, -1))
                    )
                )[0]
            )

            r_train = run_with_runtime_warning_guard(
                lambda: sanitize_returns(reg.predict(X_train), cap=1.0)
            )
            r_val = run_with_runtime_warning_guard(
                lambda: sanitize_returns(reg.predict(X_val), cap=1.0)
            )
            r_test = run_with_runtime_warning_guard(
                lambda: sanitize_returns(reg.predict(X_test), cap=1.0)
            )
            r_last = float(
                run_with_runtime_warning_guard(
                    lambda: sanitize_returns(
                        reg.predict(latest_features.reshape(1, -1)), cap=1.0
                    )
                )[0]
            )
        except Exception as exc:
            dropped.append({"model": name, "reason": f"predict_failed: {exc}"})
            continue

        p_train_meta, r_train_meta, meta_coverage, meta_gaps = (
            build_expanding_oof_predictions(
                model_name=name,
                seed=seed,
                params=chosen_params,
                X=X_train,
                y_dir=y_train_dir,
                y_ret=y_train_ret,
                folds=4,
                gap_bars=tscv_gap_bars,
            )
        )
        quality_state = "ok"
        soft_capped = False
        if meta_coverage < oof_hard_floor:
            quality_state = "hard_drop"
        elif meta_coverage < oof_min_coverage_soft:
            quality_state = "soft_fail"
            soft_capped = True

        model_train_cls_oof[name] = np.array(p_train_meta, dtype=float).reshape(-1)
        model_train_reg_oof[name] = np.array(r_train_meta, dtype=float).reshape(-1)
        model_val_prob[name] = np.array(p_val, dtype=float).reshape(-1)
        model_val_ret_pred[name] = np.array(r_val, dtype=float).reshape(-1)
        model_test_prob[name] = np.array(p_test, dtype=float).reshape(-1)
        model_test_ret_pred[name] = np.array(r_test, dtype=float).reshape(-1)
        model_latest_prob[name] = float(p_last)
        model_latest_ret[name] = float(r_last)
        model_meta_coverage[name] = float(meta_coverage)
        model_meta_gaps[name] = meta_gaps
        model_quality_state[name] = quality_state
        model_soft_capped[name] = soft_capped

        base_votes[name] = {
            "pUp": float(clip(p_last, 0.0, 1.0)),
            "expectedReturnPct": float(r_last * 100.0),
        }
        m_metrics_val = evaluate_prediction_metrics(
            y_true_dir=y_val_dir,
            y_true_ret=y_val_ret,
            y_prob=p_val,
            y_ret_pred=r_val,
            baseline_accuracy=baseline_val_accuracy,
            fee_rate=cost_fee_rate,
            slippage_bps=cost_slippage_bps,
            latency_bars=cost_latency_bars,
            robust_per_bar_clip=robust_per_bar_clip,
        )
        m_metrics_test = evaluate_prediction_metrics(
            y_true_dir=y_test_dir,
            y_true_ret=y_test_ret,
            y_prob=p_test,
            y_ret_pred=r_test,
            baseline_accuracy=baseline_test_accuracy,
            fee_rate=cost_fee_rate,
            slippage_bps=cost_slippage_bps,
            latency_bars=cost_latency_bars,
            robust_per_bar_clip=robust_per_bar_clip,
        )
        model_metrics_val[name] = m_metrics_val
        model_metrics_test[name] = m_metrics_test
        safety_ok = model_passes_safety(m_metrics_val)
        model_safety_pass[name] = bool(safety_ok)
        if not safety_ok:
            model_safety_reason[name] = ",".join(model_safety_reasons(m_metrics_val))
        model_reports.append(
            {
                "model": name,
                "metrics": m_metrics_val,
                "lockedTestMetrics": m_metrics_test,
                "latest": {
                    "pUp": float(clip(p_last, 0.0, 1.0)),
                    "expectedReturnPct": float(r_last * 100.0),
                },
                "stackingMetaTrain": {
                    "mode": "oof_expanding",
                    "coverage": meta_coverage,
                    "state": quality_state,
                    "gapBars": tscv_gap_bars,
                    "gaps": meta_gaps,
                    "softCapped": soft_capped,
                },
                "safety": {
                    "pass": bool(safety_ok),
                    "reason": model_safety_reason.get(name),
                },
                "objectiveScore": pick_metric(m_metrics_val, selection_metric),
                "nas": {
                    "enabled": nas_enabled,
                    "metric": nas_metric,
                    "mode": nas_mode,
                    "trialsRequested": nas_trials if nas_enabled else 1,
                    "trialsEvaluated": len(candidate_reports),
                    "bestParams": chosen_params,
                    "bestScore": chosen_score,
                    "candidates": candidate_reports,
                },
            }
        )
        used_model_names.append(name)

    if not used_model_names:
        raise RuntimeError("All requested models failed during fit/predict.")

    hard_dropped_models = [
        m for m in used_model_names if model_quality_state.get(m) == "hard_drop"
    ]
    soft_fail_models = [
        m for m in used_model_names if model_quality_state.get(m) == "soft_fail"
    ]
    selectable_models = [
        m for m in used_model_names if model_quality_state.get(m) != "hard_drop"
    ]
    if not selectable_models:
        fallback = max(
            used_model_names,
            key=lambda m: float(model_meta_coverage.get(m, 0.0)),
        )
        selectable_models = [fallback]
        model_quality_state[fallback] = "soft_fail"
        model_soft_capped[fallback] = True
        if fallback not in soft_fail_models:
            soft_fail_models.append(fallback)
        hard_dropped_models = [m for m in used_model_names if m != fallback]
    selectable_models_for_routing = [
        m for m in selectable_models if model_safety_pass.get(m, True)
    ]
    if not selectable_models_for_routing:
        if "randomForest" in selectable_models:
            selectable_models_for_routing = ["randomForest"]
        else:
            fallback_model = max(
                selectable_models,
                key=lambda m: (
                    float(
                        (model_metrics_val.get(m, {}) or {}).get(
                            "robustCostAwareUtility", -1e99
                        )
                    ),
                    float(
                        (model_metrics_val.get(m, {}) or {}).get(
                            "costAwareUtility", -1e99
                        )
                    ),
                    float(
                        (model_metrics_val.get(m, {}) or {}).get(
                            "netReturnPctAfterCost", -1e99
                        )
                    ),
                ),
            )
            selectable_models_for_routing = [fallback_model]

    regime_feature_bundle = compute_regime_feature_matrix(candles, dataset.times)
    regime_features = regime_feature_bundle["values"]
    regime_labels_all, regime_diagnostics = detect_regime_labels(
        regime_method=regime_method,
        regime_count=regime_count,
        seed=seed,
        regime_features=regime_features,
        train_size=train_end,
        labeling_mode=regime_labeling_mode,
        kmeans_zclip=float(regime_kmeans_zclip),
        kmeans_scale_floor=float(regime_kmeans_scale_floor),
        kmeans_min_cluster_balance=float(regime_kmeans_min_cluster_balance),
        kmeans_balance_threshold_mode=regime_kmeans_balance_threshold_mode,
        diagnostics_level=regime_kmeans_diagnostics_level,
        time_index_diagnostics=(
            regime_feature_bundle.get("diagnostics", {})
            if isinstance(regime_feature_bundle, dict)
            else {}
        ),
    )
    regime_labels_train = regime_labels_all[:train_end]
    regime_labels_val = regime_labels_all[train_end:val_end]
    regime_labels_test = regime_labels_all[val_end:]
    current_regime = regime_labels_all[-1] if regime_labels_all else "unknown"

    stacked_models = list(selectable_models)
    stack_meta_train_mode = "oof_expanding"
    stack_meta_train_coverage = 0.0
    ensemble_available = False
    p_val_ens = np.full(len(y_val_dir), 0.5, dtype=float)
    p_test_ens = np.full(len(y_test_dir), 0.5, dtype=float)
    p_last_ens = 0.5
    r_val_ens = np.zeros(len(y_val_ret), dtype=float)
    r_test_ens = np.zeros(len(y_test_ret), dtype=float)
    r_last_ens = 0.0
    # Stacking requires at least two distinct base models; otherwise it can
    # produce degenerate "ensemble" outputs that are just noisy transforms of
    # a single model and destabilize selection metrics.
    if len(stacked_models) > 1:
        try:
            meta_reg_cap = max(1.0, float(target_return_cap))
            cls_train_mat_full = sanitize_feature_matrix(
                np.column_stack([model_train_cls_oof[m] for m in stacked_models]),
                cap=1.0,
            )
            reg_train_mat_full = sanitize_feature_matrix(
                np.column_stack([model_train_reg_oof[m] for m in stacked_models]),
                cap=meta_reg_cap,
            )
            cls_val_mat = sanitize_feature_matrix(
                np.column_stack([model_val_prob[m] for m in stacked_models]), cap=1.0
            )
            reg_val_mat = sanitize_feature_matrix(
                np.column_stack([model_val_ret_pred[m] for m in stacked_models]),
                cap=meta_reg_cap,
            )
            cls_test_mat = sanitize_feature_matrix(
                np.column_stack([model_test_prob[m] for m in stacked_models]), cap=1.0
            )
            reg_test_mat = sanitize_feature_matrix(
                np.column_stack([model_test_ret_pred[m] for m in stacked_models]),
                cap=meta_reg_cap,
            )
            cls_last_vec = sanitize_feature_matrix(
                np.array(
                    [model_latest_prob[m] for m in stacked_models], dtype=float
                ).reshape(1, -1),
                cap=1.0,
            )
            reg_last_vec = sanitize_feature_matrix(
                np.array(
                    [model_latest_ret[m] for m in stacked_models], dtype=float
                ).reshape(1, -1),
                cap=meta_reg_cap,
            )

            meta_valid_mask = np.isfinite(cls_train_mat_full).all(axis=1) & np.isfinite(
                reg_train_mat_full
            ).all(axis=1)
            stack_meta_train_coverage = (
                float(np.mean(meta_valid_mask)) if len(meta_valid_mask) else 0.0
            )
            min_meta_rows = max(40, int(len(y_train_dir) * 0.2))
            if int(np.sum(meta_valid_mask)) >= min_meta_rows:
                cls_train_mat = cls_train_mat_full[meta_valid_mask]
                reg_train_mat = reg_train_mat_full[meta_valid_mask]
                y_meta_dir = y_train_dir[meta_valid_mask]
                y_meta_ret = sanitize_returns(
                    y_train_ret[meta_valid_mask], cap=target_return_cap
                )

                if len(np.unique(y_meta_dir)) >= 2:
                    from sklearn.linear_model import LogisticRegression

                    meta_clf = LogisticRegression(
                        max_iter=1500,
                        random_state=seed,
                        C=0.5,
                        solver="liblinear",
                    )
                    run_with_runtime_warning_guard(
                        lambda: meta_clf.fit(cls_train_mat, y_meta_dir)
                    )
                    p_val_ens = run_with_runtime_warning_guard(
                        lambda: sanitize_probabilities(
                            model_predict_proba(meta_clf, cls_val_mat)
                        )
                    )
                    p_test_ens = run_with_runtime_warning_guard(
                        lambda: sanitize_probabilities(
                            model_predict_proba(meta_clf, cls_test_mat)
                        )
                    )
                    p_last_ens = float(
                        run_with_runtime_warning_guard(
                            lambda: sanitize_probabilities(
                                model_predict_proba(meta_clf, cls_last_vec)
                            )
                        )[0]
                    )
                else:
                    constant = float(np.mean(y_meta_dir)) if len(y_meta_dir) else 0.5
                    p_val_ens = sanitize_probabilities(
                        np.full(len(y_val_dir), constant, dtype=float)
                    )
                    p_test_ens = sanitize_probabilities(
                        np.full(len(y_test_dir), constant, dtype=float)
                    )
                    p_last_ens = constant

                from sklearn.linear_model import Ridge

                meta_reg = Ridge(alpha=max(2.0, float(target_return_cap)), solver="svd")
                run_with_runtime_warning_guard(
                    lambda: meta_reg.fit(reg_train_mat, y_meta_ret)
                )
                r_val_ens = run_with_runtime_warning_guard(
                    lambda: sanitize_returns(meta_reg.predict(reg_val_mat), cap=1.0)
                )
                r_test_ens = run_with_runtime_warning_guard(
                    lambda: sanitize_returns(meta_reg.predict(reg_test_mat), cap=1.0)
                )
                r_last_ens = float(
                    run_with_runtime_warning_guard(
                        lambda: sanitize_returns(
                            meta_reg.predict(reg_last_vec), cap=1.0
                        )
                    ).reshape(-1)[0]
                )
                ensemble_available = True
            else:
                stack_meta_train_mode = "oof_insufficient_rows_skip"
        except Exception as exc:
            stack_meta_train_mode = f"meta_train_failed:{exc}"
            cls_val_fallback = sanitize_feature_matrix(
                np.column_stack([model_val_prob[m] for m in stacked_models]), cap=1.0
            )
            cls_test_fallback = sanitize_feature_matrix(
                np.column_stack([model_test_prob[m] for m in stacked_models]), cap=1.0
            )
            reg_val_fallback = sanitize_feature_matrix(
                np.column_stack([model_val_ret_pred[m] for m in stacked_models]),
                cap=max(1.0, float(target_return_cap)),
            )
            reg_test_fallback = sanitize_feature_matrix(
                np.column_stack([model_test_ret_pred[m] for m in stacked_models]),
                cap=max(1.0, float(target_return_cap)),
            )
            p_val_ens = sanitize_probabilities(np.mean(cls_val_fallback, axis=1))
            p_test_ens = sanitize_probabilities(np.mean(cls_test_fallback, axis=1))
            p_last_ens = float(
                sanitize_probabilities(
                    np.array([mean([model_latest_prob[m] for m in stacked_models])])
                )[0]
            )
            r_val_ens = sanitize_returns(np.mean(reg_val_fallback, axis=1), cap=1.0)
            r_test_ens = sanitize_returns(np.mean(reg_test_fallback, axis=1), cap=1.0)
            r_last_ens = float(
                sanitize_returns(
                    np.array([mean([model_latest_ret[m] for m in stacked_models])]),
                    cap=1.0,
                )[0]
            )
    elif stacked_models:
        stack_meta_train_mode = "single_model_skip"

    p_last_ens = clip(float(p_last_ens), 0.0, 1.0)
    ensemble_metrics_val = evaluate_prediction_metrics(
        y_true_dir=y_val_dir,
        y_true_ret=y_val_ret,
        y_prob=p_val_ens,
        y_ret_pred=r_val_ens,
        baseline_accuracy=baseline_val_accuracy,
        fee_rate=cost_fee_rate,
        slippage_bps=cost_slippage_bps,
        latency_bars=cost_latency_bars,
        robust_per_bar_clip=robust_per_bar_clip,
    )
    ensemble_metrics_test = evaluate_prediction_metrics(
        y_true_dir=y_test_dir,
        y_true_ret=y_test_ret,
        y_prob=p_test_ens,
        y_ret_pred=r_test_ens,
        baseline_accuracy=baseline_test_accuracy,
        fee_rate=cost_fee_rate,
        slippage_bps=cost_slippage_bps,
        latency_bars=cost_latency_bars,
        robust_per_bar_clip=robust_per_bar_clip,
    )

    global_hybrid_scores = compute_hybrid_scores(
        metrics_by_model={
            m: model_metrics_val[m] for m in selectable_models_for_routing
        },
        weights=hybrid_weights,
    )

    per_regime_winner: Dict[str, Dict[str, Any]] = {}
    unique_regimes = sorted(set(regime_labels_val))
    min_regime_samples = max(20, int(len(y_val_dir) * 0.05))
    for regime_label in unique_regimes:
        row_idx = np.array(
            [i for i, lbl in enumerate(regime_labels_val) if lbl == regime_label],
            dtype=int,
        )
        if len(row_idx) < min_regime_samples:
            continue
        regime_metrics: Dict[str, Dict[str, Any]] = {}
        for model_name in selectable_models_for_routing:
            y_sub_dir = y_val_dir[row_idx]
            y_sub_ret = y_val_ret[row_idx]
            p_sub = model_val_prob[model_name][row_idx]
            r_sub = model_val_ret_pred[model_name][row_idx]
            regime_metrics[model_name] = evaluate_prediction_metrics(
                y_true_dir=y_sub_dir,
                y_true_ret=y_sub_ret,
                y_prob=p_sub,
                y_ret_pred=r_sub,
                baseline_accuracy=majority_baseline_accuracy(y_sub_dir),
                fee_rate=cost_fee_rate,
                slippage_bps=cost_slippage_bps,
                latency_bars=cost_latency_bars,
                robust_per_bar_clip=robust_per_bar_clip,
            )

        regime_scores = compute_hybrid_scores(regime_metrics, hybrid_weights)
        if not regime_scores:
            continue
        sorted_regime = sorted(
            regime_scores.items(),
            key=lambda item: item[1],
            reverse=True,
        )
        winner = sorted_regime[0][0]
        runner_up = sorted_regime[1][0] if len(sorted_regime) > 1 else None
        per_regime_winner[regime_label] = {
            "winner": winner,
            "runnerUp": runner_up,
            "winnerScore": float(sorted_regime[0][1]),
            "runnerUpScore": float(sorted_regime[1][1])
            if len(sorted_regime) > 1
            else None,
            "sampleCount": int(len(row_idx)),
        }

    if global_hybrid_scores:
        sorted_global_hybrid = sorted(
            global_hybrid_scores.items(),
            key=lambda item: item[1],
            reverse=True,
        )
        global_winner = sorted_global_hybrid[0][0]
        global_winner_score = float(sorted_global_hybrid[0][1])
    else:
        global_winner = selectable_models_for_routing[0]
        global_winner_score = 0.0

    def resolve_regime_weights(label: str) -> Dict[str, float]:
        route = per_regime_winner.get(label)
        winner = route.get("winner") if isinstance(route, dict) else None
        runner_up = route.get("runnerUp") if isinstance(route, dict) else None
        if not winner:
            winner = global_winner
        weights: Dict[str, float] = {}
        if winner:
            weights[winner] = 1.0
        if runner_up and runner_up != winner:
            weights[winner] = 0.8
            weights[runner_up] = 0.2

        for model_name in list(weights.keys()):
            state = model_quality_state.get(model_name, "ok")
            if state == "hard_drop":
                weights.pop(model_name, None)
            elif state == "soft_fail":
                weights[model_name] = min(
                    float(weights[model_name]), soft_fail_max_weight
                )

        if not weights:
            fallback = global_winner
            fallback_weight = 1.0
            if model_quality_state.get(fallback) == "soft_fail":
                fallback_weight = min(soft_fail_max_weight, 1.0)
            weights[fallback] = fallback_weight
        return weights

    def blend_by_regime(
        labels: Sequence[str],
        probs_by_model: Dict[str, Any],
        rets_by_model: Dict[str, Any],
    ) -> Tuple[Any, Any]:
        n_rows = len(labels)
        p_out = np.full(n_rows, 0.5, dtype=float)
        r_out = np.zeros(n_rows, dtype=float)
        for i, label in enumerate(labels):
            weights = resolve_regime_weights(label)
            total_w = float(sum(weights.values()))
            prob = 0.5 * max(0.0, 1.0 - total_w)
            ret_exp = 0.0
            for model_name, w in weights.items():
                prob += float(w) * float(probs_by_model[model_name][i])
                ret_exp += float(w) * float(rets_by_model[model_name][i])
            p_out[i] = float(clip(prob, 0.0, 1.0))
            r_out[i] = float(ret_exp)
        return p_out, r_out

    def blend_latest_vote(label: str) -> Tuple[float, float, Dict[str, Dict[str, Any]]]:
        weights = resolve_regime_weights(label)
        total_w = float(sum(weights.values()))
        p_latest = 0.5 * max(0.0, 1.0 - total_w)
        r_latest = 0.0
        weighted_votes: Dict[str, Dict[str, Any]] = {}
        for model_name, w in weights.items():
            p_model = float(model_latest_prob[model_name])
            r_model = float(model_latest_ret[model_name])
            p_latest += float(w) * p_model
            r_latest += float(w) * r_model
            weighted_votes[model_name] = {
                "weight": float(w),
                "pUp": float(clip(p_model, 0.0, 1.0)),
                "expectedReturnPct": float(r_model * 100.0),
                "state": model_quality_state.get(model_name, "ok"),
            }
        return float(clip(p_latest, 0.0, 1.0)), float(r_latest), weighted_votes

    ranking_rows: List[Dict[str, Any]] = list(model_reports)
    if ensemble_available:
        ranking_rows.append(
            {
                "model": "ensemble",
                "metrics": ensemble_metrics_val,
                "lockedTestMetrics": ensemble_metrics_test,
                "latest": {
                    "pUp": float(p_last_ens),
                    "expectedReturnPct": float(r_last_ens * 100.0),
                },
                "objectiveScore": pick_metric(ensemble_metrics_val, selection_metric),
            }
        )

    def objective_score_or(row: Dict[str, Any], default: float) -> float:
        score = pick_metric(row.get("metrics", {}), selection_metric)
        return default if score is None else float(score)

    selected_p_val = np.full(len(y_val_dir), 0.5, dtype=float)
    selected_p_test = np.full(len(y_test_dir), 0.5, dtype=float)
    selected_r_val = np.zeros(len(y_val_ret), dtype=float)
    selected_r_test = np.zeros(len(y_test_ret), dtype=float)
    selected_p_last = 0.5
    selected_r_last = 0.0
    weighted_base_votes: Dict[str, Dict[str, Any]] = {}

    if ensemble_mode == "regime_moe":
        selected_p_val, selected_r_val = blend_by_regime(
            regime_labels_val, model_val_prob, model_val_ret_pred
        )
        selected_p_test, selected_r_test = blend_by_regime(
            regime_labels_test, model_test_prob, model_test_ret_pred
        )
        selected_p_last, selected_r_last, weighted_base_votes = blend_latest_vote(
            current_regime
        )
        best_model = global_winner
        best_score = global_winner_score
        ranking = [
            {
                "model": name,
                "metrics": model_metrics_val[name],
                "lockedTestMetrics": model_metrics_test[name],
                "latest": {
                    "pUp": float(model_latest_prob[name]),
                    "expectedReturnPct": float(model_latest_ret[name] * 100.0),
                },
                "objectiveScore": float(global_hybrid_scores.get(name, 0.0)),
            }
            for name in sorted(
                selectable_models_for_routing,
                key=lambda m: float(global_hybrid_scores.get(m, -1e99)),
                reverse=True,
            )
        ]
    else:
        ranking_candidates = list(ranking_rows)
        if model_safety_filter_enabled:
            filtered = []
            for row in ranking_rows:
                row_model = str(row.get("model", ""))
                if row_model == "ensemble" or model_safety_pass.get(row_model, True):
                    filtered.append(row)
            if filtered:
                ranking_candidates = filtered
        if selection_mode == "max":
            ranking = sorted(
                ranking_candidates,
                key=lambda row: (
                    pick_metric(row.get("metrics", {}), selection_metric) is None,
                    -objective_score_or(row, -1e99),
                ),
            )
        else:
            ranking = sorted(
                ranking_candidates,
                key=lambda row: (
                    pick_metric(row.get("metrics", {}), selection_metric) is None,
                    objective_score_or(row, 1e99),
                ),
            )
        selected_row = ranking[0] if ranking else ranking_candidates[0]
        best_model = selected_row.get("model", "ensemble")
        best_score = pick_metric(selected_row.get("metrics", {}), selection_metric)
        if best_model == "ensemble" and ensemble_available:
            selected_p_val = np.array(p_val_ens, dtype=float).reshape(-1)
            selected_p_test = np.array(p_test_ens, dtype=float).reshape(-1)
            selected_r_val = np.array(r_val_ens, dtype=float).reshape(-1)
            selected_r_test = np.array(r_test_ens, dtype=float).reshape(-1)
            selected_p_last = float(p_last_ens)
            selected_r_last = float(r_last_ens)
            weighted_base_votes = {
                "ensemble": {
                    "weight": 1.0,
                    "pUp": float(clip(p_last_ens, 0.0, 1.0)),
                    "expectedReturnPct": float(r_last_ens * 100.0),
                    "state": "ok",
                }
            }
        else:
            selected_p_val = np.array(model_val_prob[best_model], dtype=float).reshape(
                -1
            )
            selected_p_test = np.array(
                model_test_prob[best_model], dtype=float
            ).reshape(-1)
            selected_r_val = np.array(
                model_val_ret_pred[best_model], dtype=float
            ).reshape(-1)
            selected_r_test = np.array(
                model_test_ret_pred[best_model], dtype=float
            ).reshape(-1)
            selected_p_last = float(model_latest_prob[best_model])
            selected_r_last = float(model_latest_ret[best_model])
            weighted_base_votes = {
                best_model: {
                    "weight": 1.0,
                    "pUp": float(clip(selected_p_last, 0.0, 1.0)),
                    "expectedReturnPct": float(selected_r_last * 100.0),
                    "state": model_quality_state.get(best_model, "ok"),
                }
            }

    calibration = calibrate_probabilities(
        method=calibration_method,
        y_valid=y_val_dir,
        p_valid=selected_p_val,
        p_test=selected_p_test,
        p_latest=selected_p_last,
    )
    selected_p_val = np.array(calibration["pValid"], dtype=float).reshape(-1)
    selected_p_test = np.array(calibration["pTest"], dtype=float).reshape(-1)
    selected_p_last = float(calibration["pLatest"])

    selected_metrics_validation = evaluate_prediction_metrics(
        y_true_dir=y_val_dir,
        y_true_ret=y_val_ret,
        y_prob=selected_p_val,
        y_ret_pred=selected_r_val,
        baseline_accuracy=baseline_val_accuracy,
        fee_rate=cost_fee_rate,
        slippage_bps=cost_slippage_bps,
        latency_bars=cost_latency_bars,
        robust_per_bar_clip=robust_per_bar_clip,
    )
    selected_metrics_test = evaluate_prediction_metrics(
        y_true_dir=y_test_dir,
        y_true_ret=y_test_ret,
        y_prob=selected_p_test,
        y_ret_pred=selected_r_test,
        baseline_accuracy=baseline_test_accuracy,
        fee_rate=cost_fee_rate,
        slippage_bps=cost_slippage_bps,
        latency_bars=cost_latency_bars,
        robust_per_bar_clip=robust_per_bar_clip,
    )

    conformal_summary = compute_adaptive_conformal_summary(
        y_val_true=y_val_ret,
        y_val_pred=selected_r_val,
        y_test_true=y_test_ret,
        y_test_pred=selected_r_test,
        regime_labels_val=regime_labels_val,
        regime_labels_test=regime_labels_test,
        current_regime=current_regime,
        latest_return_pred=float(selected_r_last),
        alpha=conformal_alpha,
        min_regime_samples=conformal_min_regime_samples,
        shift_weight_clip_min=conformal_shift_weight_clip_min,
        shift_weight_clip_max=conformal_shift_weight_clip_max,
    )
    selected_metrics_validation["conformalQAbsReturn"] = float(
        conformal_summary.get("globalQAbsReturn", 0.0)
    )
    selected_metrics_test["conformalCoverage"] = float(
        conformal_summary.get("coverageTest", 0.0)
    )
    selected_metrics_test["conformalCoverageShiftWeighted"] = float(
        conformal_summary.get("coverageShiftWeightedTest", 0.0)
    )
    selected_metrics_test["conformalSharpnessPct"] = float(
        conformal_summary.get("sharpnessPct", 0.0)
    )
    selected_metrics_test["conformalLatestLowerExpectedReturnPct"] = float(
        conformal_summary.get("latestLowerExpectedReturnPct", 0.0)
    )
    selected_metrics_test["conformalLatestUpperExpectedReturnPct"] = float(
        conformal_summary.get("latestUpperExpectedReturnPct", 0.0)
    )

    selected_p_up = float(clip(selected_p_last, 0.0, 1.0))
    selected_expected_return_pct = float(selected_r_last * 100.0)
    decision_expected_return_pct = selected_expected_return_pct
    if decision_use_conformal_lower_bound:
        decision_expected_return_pct = float(
            conformal_summary.get(
                "latestLowerExpectedReturnPct", selected_expected_return_pct
            )
        )
    selected_expected_return = decision_expected_return_pct / 100.0
    selected_confidence = float(abs(selected_p_up - 0.5) * 2.0)
    if (
        selected_p_up >= min_confidence
        and selected_expected_return > min_expected_return
    ):
        direction = "buy"
    elif (
        selected_p_up <= (1.0 - min_confidence)
        and selected_expected_return < -min_expected_return
    ):
        direction = "sell"
    else:
        direction = "hold"

    forbidden_violations: List[str] = []
    if not (0 < train_end < val_end < n):
        forbidden_violations.append("invalid_time_split")
    if len(times_train) and len(times_val):
        if int(times_train[-1]) >= int(times_val[0]):
            forbidden_violations.append("train_validation_overlap")
    if len(times_val) and len(times_test):
        if int(times_val[-1]) >= int(times_test[0]):
            forbidden_violations.append("validation_locked_test_overlap")

    soft_warnings: List[str] = []
    if model_quality_state.get(best_model) == "soft_fail":
        soft_warnings.append("best_model_soft_fail")
    if float(selected_metrics_test.get("accuracyLift", 0.0)) < 0.0:
        soft_warnings.append("locked_test_negative_accuracy_lift")
    if (
        ensemble_mode == "regime_moe"
        and float(best_score if best_score is not None else 0.0) < 0.0
    ):
        soft_warnings.append("hybrid_score_below_zero")
    conformal_target = max(0.50, 1.0 - conformal_alpha - 0.05)
    if (
        float(conformal_summary.get("coverageShiftWeightedTest", 1.0))
        < conformal_target
    ):
        soft_warnings.append("conformal_shift_coverage_below_target")
    risk_clamp_applied = len(soft_warnings) > 0
    release_gate_decision = {
        "hardBlocks": forbidden_violations,
        "softWarnings": soft_warnings,
        "riskClampApplied": bool(risk_clamp_applied),
        "maxAllocAfterClamp": float(
            risk_clamp_on_soft_warn if risk_clamp_applied else 1.0
        ),
    }

    def safe_window(times_slice: Any) -> Dict[str, Any]:
        if len(times_slice) == 0:
            return {"fromTime": None, "toTime": None, "size": 0}
        return {
            "fromTime": int(times_slice[0]),
            "toTime": int(times_slice[-1]),
            "size": int(len(times_slice)),
        }

    hybrid_per_regime = {
        regime: {
            "winner": data.get("winner"),
            "runnerUp": data.get("runnerUp"),
            "winnerScore": data.get("winnerScore"),
            "runnerUpScore": data.get("runnerUpScore"),
            "sampleCount": data.get("sampleCount"),
        }
        for regime, data in per_regime_winner.items()
    }

    model_selection_metric = (
        "hybridScore" if ensemble_mode == "regime_moe" else selection_metric
    )
    model_selection_mode = "max" if ensemble_mode == "regime_moe" else selection_mode

    return {
        "dataset": {
            "samples": int(n),
            "featureCount": int(dataset.X.shape[1]),
            "trainSize": int(len(X_train)),
            "validationSize": int(len(X_val)),
            "testSize": int(len(X_test)),
            "fromTime": int(dataset.times[0]),
            "toTime": int(dataset.times[-1]),
            "latestTime": int(dataset.latest_time),
            "horizonBars": int(horizon),
            "featureNames": dataset.feature_names,
            "labeling": dataset.labeling,
        },
        "modelsRequested": requested_models,
        "modelsUsed": used_model_names,
        "droppedModels": dropped,
        "intermediateModels": model_reports,
        "modelSelection": {
            "metric": model_selection_metric,
            "mode": model_selection_mode,
            "bestModel": best_model,
            "bestScore": best_score,
            "ranking": [
                {
                    "model": row["model"],
                    "objectiveScore": (
                        row.get("objectiveScore")
                        if ensemble_mode == "regime_moe"
                        else pick_metric(row.get("metrics", {}), selection_metric)
                    ),
                    "metrics": row["metrics"],
                    "lockedTestMetrics": row.get("lockedTestMetrics"),
                    "latest": row["latest"],
                }
                for row in ranking
            ],
        },
        "prediction": {
            "direction": direction,
            "pUp": float(selected_p_up),
            "confidence": selected_confidence,
            "expectedReturnPct": float(selected_expected_return_pct),
            "decisionExpectedReturnPct": float(decision_expected_return_pct),
            "conformalLowerExpectedReturnPct": float(
                conformal_summary.get("latestLowerExpectedReturnPct", 0.0)
            ),
            "conformalUpperExpectedReturnPct": float(
                conformal_summary.get("latestUpperExpectedReturnPct", 0.0)
            ),
            "baseModelVotes": base_votes,
            "weightedBaseVotes": weighted_base_votes,
            "thresholds": {
                "minConfidence": float(min_confidence),
                "minExpectedReturnPct": float(min_expected_return_pct),
            },
        },
        "metrics": selected_metrics_test,
        "validationMetrics": selected_metrics_validation,
        "conformal": conformal_summary,
        "regimeSummary": {
            "detectorMethod": regime_method,
            "regimeDistributionTrain": compute_distribution(regime_labels_train),
            "regimeDistributionTest": compute_distribution(regime_labels_test),
            "currentRegime": current_regime,
            "diagnostics": regime_diagnostics,
        },
        "hybridScore": {
            "weights": hybrid_weights,
            "perModel": {k: float(v) for k, v in global_hybrid_scores.items()},
            "perRegimeWinner": hybrid_per_regime,
            "globalWinner": {
                "model": global_winner,
                "score": global_winner_score,
            },
        },
        "oofQuality": {
            "coveragePerModel": {
                model_name: {
                    "coverage": float(model_meta_coverage.get(model_name, 0.0)),
                    "state": model_quality_state.get(model_name, "unknown"),
                    "softCapped": bool(model_soft_capped.get(model_name, False)),
                    "safetyPass": bool(model_safety_pass.get(model_name, True)),
                    "safetyReason": model_safety_reason.get(model_name),
                    "gapCount": int(len(model_meta_gaps.get(model_name, []))),
                    "gaps": model_meta_gaps.get(model_name, []),
                }
                for model_name in used_model_names
            },
            "softFailModels": soft_fail_models,
            "hardDroppedModels": hard_dropped_models,
        },
        "selectionAudit": {
            "trainWindow": safe_window(times_train),
            "validationWindow": safe_window(times_val),
            "lockedTestWindow": safe_window(times_test),
            "forbiddenDataUsageViolations": forbidden_violations,
        },
        "releaseGateDecision": release_gate_decision,
        "trainingConfig": {
            "costModel": {
                "feeRate": cost_fee_rate,
                "slippageBps": cost_slippage_bps,
                "latencyBars": cost_latency_bars,
                "robustPerBarClip": robust_per_bar_clip,
            },
            "conformal": {
                "alpha": conformal_alpha,
                "minRegimeSamples": conformal_min_regime_samples,
                "shiftWeightClipMin": conformal_shift_weight_clip_min,
                "shiftWeightClipMax": conformal_shift_weight_clip_max,
                "decisionUseConformalLowerBound": bool(
                    decision_use_conformal_lower_bound
                ),
            },
            "featureSanitization": {
                "featureClipQuantile": feature_clip_quantile,
                "featureClipCapMin": feature_clip_cap_min,
                "featureClipCapMax": feature_clip_cap_max,
                "targetReturnCap": target_return_cap,
                "appliedFeatureCapMedian": feature_cap_median,
                "appliedFeatureCapP95": feature_cap_p95,
            },
            "ensembleMode": ensemble_mode,
            "regime": {
                "count": int(regime_count),
                "method": regime_method,
                "labelingMode": regime_labeling_mode,
                "kmeansZclip": float(regime_kmeans_zclip),
                "kmeansScaleFloor": float(regime_kmeans_scale_floor),
                "kmeansMinClusterBalance": float(regime_kmeans_min_cluster_balance),
                "kmeansBalanceThresholdMode": regime_kmeans_balance_threshold_mode,
                "kmeansDiagnosticsLevel": regime_kmeans_diagnostics_level,
            },
            "hybridWeights": hybrid_weights,
            "nas": {
                "enabled": nas_enabled,
                "trials": nas_trials,
                "metric": nas_metric,
                "mode": nas_mode,
            },
            "labeling": {
                "mode": labeling_mode,
                "barrierTakeProfitAtr": barrier_take_profit_atr,
                "barrierStopLossAtr": barrier_stop_loss_atr,
                "barrierMaxHorizonBars": barrier_max_horizon_bars,
            },
            "oofPolicy": {
                "oofMinCoverageSoft": oof_min_coverage_soft,
                "oofHardFloor": oof_hard_floor,
                "softFailMaxWeight": soft_fail_max_weight,
                "tscvGapBars": tscv_gap_bars,
            },
            "split": {
                "trainRatio": float(train_ratio),
                "testLockRatio": float(test_lock_ratio),
                "trainEndIndex": int(train_end),
                "validationEndIndex": int(val_end),
            },
            "calibration": calibration["details"],
            "riskPolicy": {
                "riskClampOnSoftStatWarn": risk_clamp_on_soft_warn,
            },
            "modelSafety": {
                "enabled": bool(model_safety_filter_enabled),
                "minRobustCostAwareUtility": model_safety_min_robust_cost_aware,
                "minCostAwareUtility": model_safety_min_cost_aware,
                "minNetReturnPctAfterCost": model_safety_min_net_return_pct,
                "maxTurnoverPerBar": model_safety_max_turnover_per_bar,
                "routingModels": selectable_models_for_routing,
            },
            "stacking": {
                "metaTrainMode": stack_meta_train_mode,
                "metaTrainCoverage": stack_meta_train_coverage,
                "ensembleAvailable": bool(ensemble_available),
            },
        },
    }


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run ML Ensemble V1 prediction/evaluation"
    )
    parser.add_argument("--input", required=True, help="Path to input JSON payload")
    return parser.parse_args(argv)


def main(argv: Sequence[str]) -> int:
    args = parse_args(argv)
    input_path = Path(args.input)
    payload = json.loads(input_path.read_text(encoding="utf-8"))
    result = fit_and_predict(payload)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:  # pragma: no cover - surfaced to caller
        sys.stderr.write(f"ml_ensemble_v1 failed: {exc}\n")
        raise
