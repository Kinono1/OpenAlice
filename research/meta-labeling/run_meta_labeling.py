"""End-to-end Meta-Labeling Research Pipeline.

Generates triple barrier labels from factor ensemble signals,
builds meta features, trains XGBoost binary classifier, evaluates
on held-out test set.

Usage:
    python run_meta_labeling.py --symbol BTC/USDT --start 2024-01-01 --end 2025-12-31
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.data_fetcher import prepare_research_dataset, CACHE_DIR

# Triple barrier defaults matching TS triple-barrier.ts
DEFAULT_UPPER_BARRIER_PCT = 0.03    # 3% take-profit
DEFAULT_LOWER_BARRIER_PCT = 0.015   # 1.5% stop-loss
DEFAULT_MAX_HOLDING_BARS = 48       # 48 hours

META_FEATURES = [
    "factor_funding_rate", "factor_basis", "factor_volume_surge", "factor_momentum",
    "factor_mean_reversion", "factor_volatility_regime", "factor_liquidation_pressure",
    "factor_cross_timeframe_divergence",
    "conf_funding_rate", "conf_basis", "conf_volume_surge", "conf_momentum",
    "conf_mean_reversion", "conf_volatility_regime", "conf_liquidation_pressure",
    "conf_cross_timeframe_divergence",
    "return_1h_pct", "return_6h_pct", "return_24h_pct", "return_7d_pct",
    "realized_vol_pct", "volume_ratio",
    "rsi_proxy", "macd_hist_proxy", "bb_position_proxy", "atr_pct_proxy",
]

OUTPUT_DIR = CACHE_DIR / "meta_labeling_results"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


# ---- Triple Barrier Labeling (matches TS triple-barrier.ts exactly) ----

def evaluate_triple_barrier(
    candles: pd.DataFrame,
    entry_index: int,
    upper_barrier_pct: float,
    lower_barrier_pct: float,
    max_holding_bars: int,
    side: str = "long",
) -> dict:
    """Triple barrier labeling matching TS evaluateTripleBarrierLabel.

    Returns dict with: label (0/1), exit_reason, exit_index, entry_price,
    exit_price, realized_return_pct, hit_upper, hit_lower.
    """
    if entry_index >= len(candles) - 1:
        return {
            "label": 0, "exit_reason": "insufficient_data", "exit_index": entry_index,
            "entry_price": 0, "exit_price": 0, "realized_return_pct": 0,
            "hit_upper": False, "hit_lower": False,
        }

    entry_price = candles.iloc[entry_index]["close"]
    final_index = min(entry_index + max_holding_bars, len(candles) - 1)

    for i in range(entry_index + 1, final_index + 1):
        high = candles.iloc[i]["high"]
        low = candles.iloc[i]["low"]

        if side == "long":
            upper_price = entry_price * (1 + upper_barrier_pct)
            lower_price = entry_price * (1 - lower_barrier_pct)

            if high >= upper_price:
                exit_price = upper_price
                ret = (exit_price - entry_price) / entry_price * 100
                return {
                    "label": 1, "exit_reason": "take-profit", "exit_index": i,
                    "entry_price": entry_price, "exit_price": exit_price,
                    "realized_return_pct": ret, "hit_upper": True, "hit_lower": False,
                }
            if low <= lower_price:
                exit_price = lower_price
                ret = (exit_price - entry_price) / entry_price * 100
                return {
                    "label": 0, "exit_reason": "stop-loss", "exit_index": i,
                    "entry_price": entry_price, "exit_price": exit_price,
                    "realized_return_pct": ret, "hit_upper": False, "hit_lower": True,
                }
        else:  # short
            upper_price = entry_price * (1 + lower_barrier_pct)
            lower_price = entry_price * (1 - upper_barrier_pct)

            if low <= lower_price:
                exit_price = lower_price
                ret = (entry_price - exit_price) / entry_price * 100
                return {
                    "label": 1, "exit_reason": "take-profit", "exit_index": i,
                    "entry_price": entry_price, "exit_price": exit_price,
                    "realized_return_pct": ret, "hit_upper": False, "hit_lower": True,
                }
            if high >= upper_price:
                exit_price = upper_price
                ret = (entry_price - exit_price) / entry_price * 100
                return {
                    "label": 0, "exit_reason": "stop-loss", "exit_index": i,
                    "entry_price": entry_price, "exit_price": exit_price,
                    "realized_return_pct": ret, "hit_upper": True, "hit_lower": False,
                }

    # Time expiry
    exit_price = candles.iloc[final_index]["close"]
    if side == "long":
        ret = (exit_price - entry_price) / entry_price * 100
        label = 1 if ret > 0 else 0
    else:
        ret = (entry_price - exit_price) / entry_price * 100
        label = 1 if ret > 0 else 0

    return {
        "label": label, "exit_reason": "time-expiry", "exit_index": final_index,
        "entry_price": entry_price, "exit_price": exit_price,
        "realized_return_pct": ret, "hit_upper": False, "hit_lower": False,
    }


def generate_ensemble_signal(df: pd.DataFrame) -> pd.Series:
    """Generate simple ensemble signal from 4 factors.

    Equal-weight aggregation matching TS combineFactorSignals logic.
    Returns: -1, 0, or 1 for each bar.
    """
    factor_cols = [
        "factor_funding_rate",
        "factor_basis",
        "factor_volume_surge",
        "factor_momentum",
        "factor_mean_reversion",
        "factor_volatility_regime",
        "factor_liquidation_pressure",
        "factor_cross_timeframe_divergence",
    ]
    conf_cols = [
        "conf_funding_rate",
        "conf_basis",
        "conf_volume_surge",
        "conf_momentum",
        "conf_mean_reversion",
        "conf_volatility_regime",
        "conf_liquidation_pressure",
        "conf_cross_timeframe_divergence",
    ]

    # Weighted by confidence (decisionStrengthWeight proxy)
    weighted_sum = pd.Series(0.0, index=df.index)
    total_weight = pd.Series(0.0, index=df.index)

    for fc, cc in zip(factor_cols, conf_cols):
        conf = df[cc].fillna(0).values
        # Map confidence to weight: D1=1.0, D2=0.8, D3=0.6, D4=0.3, D5=0
        weight = np.where(conf >= 0.85, 1.0,
                 np.where(conf >= 0.65, 0.8,
                 np.where(conf >= 0.45, 0.6,
                 np.where(conf >= 0.25, 0.3, 0.0))))
        weighted_sum += df[fc].fillna(0) * weight
        total_weight += weight

    ensemble_value = np.where(total_weight > 0, weighted_sum / total_weight, 0)

    # Signal: 1 if value > 0.1, -1 if < -0.1, else 0
    signal = np.where(ensemble_value > 0.1, 1,
             np.where(ensemble_value < -0.1, -1, 0))
    return pd.Series(signal, index=df.index)


def generate_labels(
    df: pd.DataFrame,
    upper_pct: float = DEFAULT_UPPER_BARRIER_PCT,
    lower_pct: float = DEFAULT_LOWER_BARRIER_PCT,
    max_bars: int = DEFAULT_MAX_HOLDING_BARS,
    signal_step: int = 24,  # Generate labels every N bars
) -> pd.DataFrame:
    """Generate meta labels from factor ensemble signals + triple barrier."""
    signals = generate_ensemble_signal(df)

    labels = []
    for i in range(0, len(df) - max_bars, signal_step):
        sig = signals.iloc[i]
        if sig == 0:
            continue

        side = "long" if sig > 0 else "short"
        result = evaluate_triple_barrier(df, i, upper_pct, lower_pct, max_bars, side)

        # Build feature vector at entry
        features = {"entry_index": i, "side": side, **result}
        for feat_name in META_FEATURES:
            if feat_name in df.columns:
                features[f"meta_{feat_name}"] = float(df.iloc[i][feat_name]) if pd.notna(df.iloc[i][feat_name]) else 0.0

        # Add ensemble value as meta feature
        features["meta_ensemble_value"] = float(sig)
        features["meta_ensemble_abs"] = abs(float(sig))

        labels.append(features)

    return pd.DataFrame(labels)


def train_meta_model(labels_df: pd.DataFrame, test_ratio: float = 0.2):
    """Train XGBoost meta-label classifier on generated labels."""
    feature_cols = [c for c in labels_df.columns if c.startswith("meta_")]
    X = labels_df[feature_cols].values
    y = labels_df["label"].values

    # Split by time (not random) — last portion is test
    split_idx = int(len(X) * (1 - test_ratio))
    X_train, X_test = X[:split_idx], X[split_idx:]
    y_train, y_test = y[:split_idx], y[split_idx:]

    print(f"\nTraining set: {len(X_train)} samples")
    print(f"Test set:     {len(X_test)} samples")
    print(f"Label distribution (train): pos={sum(y_train==1)}, neg={sum(y_train==0)}")

    # Try XGBoost first, fall back to sklearn
    model = None
    backend = None
    try:
        from xgboost import XGBClassifier
        model = XGBClassifier(
            n_estimators=200,
            learning_rate=0.05,
            max_depth=4,
            subsample=0.9,
            colsample_bytree=0.9,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=42,
        )
        model.fit(X_train, y_train, eval_set=[(X_test, y_test)], verbose=False)
        backend = "xgboost"
    except ImportError:
        from sklearn.ensemble import GradientBoostingClassifier
        model = GradientBoostingClassifier(
            n_estimators=200,
            learning_rate=0.05,
            random_state=42,
        )
        model.fit(X_train, y_train)
        backend = "sklearn-gb"

    # Evaluate
    from sklearn.metrics import (
        accuracy_score,
        auc,
        classification_report,
        precision_score,
        recall_score,
        f1_score,
        roc_auc_score,
    )

    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1] if hasattr(model, "predict_proba") else y_pred.astype(float)

    metrics = {
        "backend": backend,
        "accuracy": float(accuracy_score(y_test, y_pred)),
        "precision": float(precision_score(y_test, y_pred, zero_division=0)),
        "recall": float(recall_score(y_test, y_pred, zero_division=0)),
        "f1": float(f1_score(y_test, y_pred, zero_division=0)),
        "auc": float(roc_auc_score(y_test, y_prob)) if len(np.unique(y_test)) > 1 else None,
        "train_size": len(X_train),
        "test_size": len(X_test),
        "train_pos_rate": float(np.mean(y_train)),
        "test_pos_rate": float(np.mean(y_test)),
    }

    # Feature importance
    if backend == "xgboost":
        importance = model.feature_importances_
    else:
        importance = model.feature_importances_

    feat_importance = sorted(
        zip(feature_cols, importance),
        key=lambda x: x[1],
        reverse=True,
    )
    metrics["feature_importance"] = [
        {"feature": name, "importance": float(imp)}
        for name, imp in feat_importance[:15]
    ]

    # Save model
    model_path = OUTPUT_DIR / "meta_labeling_model"
    if backend == "xgboost":
        model_path = model_path.with_suffix(".json")
        model.save_model(str(model_path))
    else:
        try:
            import joblib
            model_path = model_path.with_suffix(".joblib")
            joblib.dump(model, model_path)
        except ImportError:
            model_path = model_path.with_suffix(".pkl")
            import pickle
            with open(model_path, "wb") as f:
                pickle.dump(model, f)

    metrics["model_path"] = str(model_path)
    return metrics, model, feat_importance, feature_cols


def print_meta_report(metrics: dict, feat_importance: list) -> None:
    """Print meta-labeling results."""
    print("\n" + "=" * 80)
    print("META-LABELING CLASSIFICATION REPORT")
    print("=" * 80)
    print(f"  Backend: {metrics['backend']}")
    print(f"  Train: {metrics['train_size']} samples (pos rate: {metrics['train_pos_rate']:.1%})")
    print(f"  Test:  {metrics['test_size']} samples (pos rate: {metrics['test_pos_rate']:.1%})")
    print()
    print(f"  Accuracy:  {metrics['accuracy']:.3f}")
    print(f"  Precision: {metrics['precision']:.3f}")
    print(f"  Recall:    {metrics['recall']:.3f}")
    print(f"  F1 Score:  {metrics['f1']:.3f}")
    if metrics.get("auc") is not None:
        print(f"  AUC:       {metrics['auc']:.3f}")

    print("\n  Top Features:")
    for name, imp in feat_importance[:10]:
        bar = "█" * int(imp * 100)
        print(f"    {name:35s} {imp:.4f} {bar}")

    # Assessment
    auc_val = metrics.get("auc") or 0.5
    if metrics["precision"] > 0.6 and auc_val > 0.6:
        print("\n  ✓ Meta-model shows predictive value — suitable for signal filtering")
    elif metrics["precision"] > 0.55:
        print("\n  ~ Meta-model shows marginal predictive value — needs more data or features")
    else:
        print("\n  ✗ Meta-model does not outperform random — factor signals lack edge")


def main():
    parser = argparse.ArgumentParser(description="Meta-Labeling Research Pipeline")
    parser.add_argument("--symbol", default="BTC/USDT")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--exchange", default="binance")
    parser.add_argument("--upper-barrier", type=float, default=DEFAULT_UPPER_BARRIER_PCT)
    parser.add_argument("--lower-barrier", type=float, default=DEFAULT_LOWER_BARRIER_PCT)
    parser.add_argument("--max-holding", type=int, default=DEFAULT_MAX_HOLDING_BARS)
    parser.add_argument("--signal-step", type=int, default=24)
    args = parser.parse_args()

    # Fetch data
    df = prepare_research_dataset(args.symbol, args.timeframe, args.start, args.end, args.exchange)

    # Generate labels
    print("\nGenerating triple barrier labels...")
    labels_df = generate_labels(
        df, args.upper_barrier, args.lower_barrier, args.max_holding, args.signal_step,
    )
    print(f"  Generated {len(labels_df)} labeled samples")
    if len(labels_df) == 0:
        print("  No labels generated. Adjust signal threshold or barrier parameters.")
        return

    pos_rate = labels_df["label"].mean()
    print(f"  Positive labels: {sum(labels_df['label']==1)} ({pos_rate:.1%})")
    print(f"  Negative labels: {sum(labels_df['label']==0)} ({1-pos_rate:.1%})")

    # Save labeled dataset
    safe_symbol = args.symbol.replace("/", "_").replace(":", "_")
    labels_path = OUTPUT_DIR / f"labels_{safe_symbol}_{args.start}_{args.end}.csv"
    labels_df.to_csv(labels_path, index=False)
    print(f"  Labels saved to {labels_path}")

    # Train model
    if len(labels_df) < 50:
        print(f"\n  ⚠ Only {len(labels_df)} samples — insufficient for training. Need at least 50.")
        return

    metrics, model, feat_importance, feature_cols = train_meta_model(labels_df)

    # Print report
    print_meta_report(metrics, feat_importance)

    # Save results
    results_path = OUTPUT_DIR / f"results_{safe_symbol}_{args.start}_{args.end}.json"
    with open(results_path, "w", encoding="utf-8") as f:
        # Remove non-serializable keys
        serializable = {k: v for k, v in metrics.items()}
        json.dump(serializable, f, indent=2, default=str)
    print(f"\nResults saved to {results_path}")

    # Save normalization stats for TS feature-pipeline
    feature_data = labels_df[[c for c in labels_df.columns if c.startswith("meta_")]]
    norm_stats = {
        "featureNames": list(feature_data.columns),
        "mean": feature_data.mean().tolist(),
        "std": feature_data.std().tolist(),
    }
    norm_path = OUTPUT_DIR / "meta_feature_normalization.json"
    with open(norm_path, "w", encoding="utf-8") as f:
        json.dump(norm_stats, f, indent=2)
    print(f"Normalization stats saved to {norm_path}")


if __name__ == "__main__":
    main()
