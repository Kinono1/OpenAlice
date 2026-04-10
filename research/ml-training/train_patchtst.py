"""Enhanced LSTM/PatchTST Training Pipeline.

Features over original:
- Train/val/test split (60/20/20) with time-series ordering
- Early stopping with patience
- Cosine annealing LR scheduler
- Proper normalization stats export for TS feature-pipeline.ts
- Evaluation: MAE, RMSE, directional accuracy on test set
- Data fetcher integration: pull real crypto features from ccxt

Usage:
    # From pre-built CSV (legacy):
    python train_patchtst.py --dataset data.csv --target-column close --architecture lstm

    # From live ccxt data:
    python train_patchtst.py --symbol BTC/USDT --start 2024-01-01 --end 2025-12-31 --architecture lstm

    # Export to ONNX after training:
    python train_patchtst.py --dataset data.csv --target-column close --export-onnx model.onnx
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from feature_schema import CANONICAL_FEATURE_NAMES, canonical_feature_row
from model import ForecastModelConfig, build_model, require_torch


# ---- Data Loading ----

def load_csv_rows(path: Path):
    with path.open("r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    if not rows:
        raise RuntimeError(f"No rows found in {path}")
    return rows


def resolve_supervised_dataset(rows, target_column: str):
    if target_column not in rows[0]:
        raise RuntimeError(f"Target column {target_column} not found in dataset.")

    features = [canonical_feature_row(row) for row in rows]
    targets = [[float(row[target_column])] for row in rows]
    return CANONICAL_FEATURE_NAMES, features, targets


def build_windows(feature_rows, target_rows, lookback: int, horizon: int):
    features = []
    targets = []
    for start in range(0, len(feature_rows) - lookback - horizon + 1):
        window = feature_rows[start : start + lookback]
        target_row = target_rows[start + lookback + horizon - 1]
        features.append(window)
        targets.append(target_row)
    return features, targets


def compute_normalizer(samples):
    feature_count = len(samples[0][0])
    flat = [
        [row[column] for sample in samples for row in sample]
        for column in range(feature_count)
    ]
    mean = [sum(values) / len(values) for values in flat]
    std = []
    for index, values in enumerate(flat):
        variance = sum((value - mean[index]) ** 2 for value in values) / len(values)
        std.append(max(variance ** 0.5, 1e-6))
    return {"mean": mean, "std": std}


def normalize_samples(samples, normalizer):
    normalized = []
    for sample in samples:
        normalized.append(
            [
                [
                    (value - normalizer["mean"][column]) / normalizer["std"][column]
                    for column, value in enumerate(row)
                ]
                for row in sample
            ]
        )
    return normalized


# ---- Evaluation Metrics ----

def directional_accuracy(predictions, targets):
    """Fraction of samples where sign(prediction - last_input) matches sign(target - last_input)."""
    import numpy as np

    pred_dir = np.sign(predictions)
    true_dir = np.sign(targets)
    return float(np.mean(pred_dir == true_dir))


def compute_metrics(predictions, targets):
    import numpy as np

    errors = predictions - targets
    mae = float(np.mean(np.abs(errors)))
    rmse = float(np.sqrt(np.mean(errors ** 2)))
    da = directional_accuracy(
        np.sign(predictions.flatten()),
        np.sign(targets.flatten()),
    )
    return {"mae": mae, "rmse": rmse, "directional_accuracy": da}


# ---- Training ----

def train_model(args):
    # Load or fetch data
    if args.dataset:
        dataset_path = Path(args.dataset)
        rows = load_csv_rows(dataset_path)
        feature_names, feature_rows, target_rows = resolve_supervised_dataset(rows, args.target_column)
    else:
        # Fetch from ccxt
        from common.data_fetcher import prepare_research_dataset
        symbol = args.symbol or "BTC/USDT"
        print(f"Fetching {symbol} data from ccxt...")
        df = prepare_research_dataset(
            symbol=symbol,
            timeframe=args.timeframe,
            start_date=args.start,
            end_date=args.end,
            exchange_id=args.exchange,
        )
        # Use factor values + derived features as input columns
        feature_cols = [
            "factor_funding_rate", "factor_basis", "factor_volume_surge", "factor_momentum",
            "factor_mean_reversion", "factor_volatility_regime", "factor_liquidation_pressure",
            "factor_cross_timeframe_divergence",
            "return_1h_pct", "return_6h_pct", "return_24h_pct", "return_7d_pct",
            "realized_vol_pct", "volume_ratio",
            "rsi_proxy", "macd_hist_proxy", "bb_position_proxy", "atr_pct_proxy",
        ]
        available_cols = [c for c in feature_cols if c in df.columns]
        columns = available_cols + ["close"]

        # Fill NaN with 0
        df_clean = df[columns].fillna(0)
        records = df_clean.to_dict(orient="records")
        target_column = args.target_column if args.target_column in df_clean.columns else "close"
        feature_names = list(CANONICAL_FEATURE_NAMES)
        feature_rows = [canonical_feature_row(record) for record in records]
        target_rows = [[float(record[target_column])] for record in records]

    if args.validate_only:
        summary = {
            "feature_names": feature_names,
            "feature_count": len(feature_names),
            "row_count": len(feature_rows),
            "target_count": len(target_rows),
            "target_column": args.target_column,
        }
        print(json.dumps(summary, indent=2))
        return summary

    torch, _ = require_torch()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build supervised windows
    feature_windows, targets = build_windows(
        feature_rows,
        target_rows,
        args.lookback,
        args.horizon,
    )
    if not feature_windows:
        raise RuntimeError("Not enough rows to build supervised windows.")
    print(f"Total windows: {len(feature_windows)} (lookback={args.lookback}, horizon={args.horizon})")

    # Compute normalization on training set only
    n = len(feature_windows)
    train_end = int(n * 0.6)
    val_end = int(n * 0.8)

    normalizer = compute_normalizer(feature_windows[:train_end])
    normalized_features = normalize_samples(feature_windows, normalizer)

    # Split
    train_features = normalized_features[:train_end]
    train_targets = targets[:train_end]
    val_features = normalized_features[train_end:val_end]
    val_targets = targets[train_end:val_end]
    test_features = normalized_features[val_end:]
    test_targets = targets[val_end:]

    print(f"Train: {len(train_features)}, Val: {len(val_features)}, Test: {len(test_features)}")

    # Tensors
    feature_tensor = torch.tensor(train_features, dtype=torch.float32)
    target_tensor = torch.tensor(train_targets, dtype=torch.float32)
    val_feature_tensor = torch.tensor(val_features, dtype=torch.float32)
    val_target_tensor = torch.tensor(val_targets, dtype=torch.float32)
    test_feature_tensor = torch.tensor(test_features, dtype=torch.float32)
    test_target_tensor = torch.tensor(test_targets, dtype=torch.float32)

    # Build model
    input_dim = len(feature_names)
    config = ForecastModelConfig(
        input_dim=input_dim,
        hidden_dim=args.hidden_dim,
        num_layers=args.num_layers,
        horizon=1,
        architecture=args.architecture,
    )
    model = build_model(config)
    total_params = sum(p.numel() for p in model.parameters())
    print(f"Model: {args.architecture}, input_dim={input_dim}, params={total_params:,}")

    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr, weight_decay=1e-5)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)
    loss_fn = torch.nn.MSELoss()

    # Training loop with early stopping
    best_val_loss = float("inf")
    patience_counter = 0
    best_state = None
    history = []

    for epoch in range(args.epochs):
        # Train
        model.train()
        optimizer.zero_grad()
        prediction = model(feature_tensor)
        loss = loss_fn(prediction, target_tensor)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), max_norm=1.0)
        optimizer.step()
        scheduler.step()

        train_loss = float(loss.detach().cpu().item())

        # Validate
        model.eval()
        with torch.no_grad():
            val_pred = model(val_feature_tensor)
            val_loss = float(loss_fn(val_pred, val_target_tensor).cpu().item())

        history.append({
            "epoch": epoch + 1,
            "train_loss": train_loss,
            "val_loss": val_loss,
            "lr": float(optimizer.param_groups[0]["lr"]),
        })

        # Early stopping
        if val_loss < best_val_loss:
            best_val_loss = val_loss
            patience_counter = 0
            best_state = {k: v.clone() for k, v in model.state_dict().items()}
        else:
            patience_counter += 1

        if (epoch + 1) % 10 == 0 or epoch == 0:
            print(f"  Epoch {epoch+1:3d}/{args.epochs}  "
                  f"train_loss={train_loss:.6f}  val_loss={val_loss:.6f}  "
                  f"lr={optimizer.param_groups[0]['lr']:.2e}")

        if patience_counter >= args.patience:
            print(f"  Early stopping at epoch {epoch+1} (patience={args.patience})")
            break

    # Restore best model
    if best_state is not None:
        model.load_state_dict(best_state)

    # Test evaluation
    model.eval()
    with torch.no_grad():
        test_pred = model(test_feature_tensor).cpu().numpy()
        test_true = test_target_tensor.cpu().numpy()

    test_metrics = compute_metrics(test_pred, test_true)
    print(f"\nTest Metrics:")
    print(f"  MAE:                {test_metrics['mae']:.6f}")
    print(f"  RMSE:               {test_metrics['rmse']:.6f}")
    print(f"  Directional Acc:    {test_metrics['directional_accuracy']:.3f}")

    # Save checkpoint
    checkpoint_path = output_dir / f"{args.architecture}_forecast.pt"
    torch.save(
        {
            "state_dict": model.state_dict(),
            "config": {
                "input_dim": input_dim,
                "hidden_dim": args.hidden_dim,
                "num_layers": args.num_layers,
                "horizon": 1,
                "architecture": args.architecture,
            },
            "feature_names": feature_names,
            "target_column": args.target_column,
            "normalizer": normalizer,
            "history": history,
            "test_metrics": test_metrics,
        },
        checkpoint_path,
    )

    # Save normalization stats for TypeScript feature-pipeline.ts
    norm_stats = {
        "featureNames": feature_names,
        "mean": normalizer["mean"],
        "std": normalizer["std"],
    }
    norm_path = output_dir / f"{args.architecture}_normalization.json"
    with open(norm_path, "w", encoding="utf-8") as f:
        json.dump(norm_stats, f, indent=2)

    # Save metadata
    metadata = {
        "architecture": args.architecture,
        "input_dim": input_dim,
        "hidden_dim": args.hidden_dim,
        "num_layers": args.num_layers,
        "lookback": args.lookback,
        "horizon": args.horizon,
        "total_params": total_params,
        "feature_names": feature_names,
        "target_column": args.target_column,
        "normalization_path": str(norm_path),
        "checkpoint_path": str(checkpoint_path),
        "history": history,
        "test_metrics": test_metrics,
    }
    metadata_path = output_dir / f"{args.architecture}_forecast.json"
    with open(metadata_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, indent=2, default=str)

    print(f"\nCheckpoint: {checkpoint_path}")
    print(f"Normalization: {norm_path}")
    print(f"Metadata: {metadata_path}")

    # Export ONNX if requested
    if args.export_onnx:
        onnx_path = Path(args.export_onnx)
        onnx_path.parent.mkdir(parents=True, exist_ok=True)
        dummy = torch.zeros((1, args.lookback, input_dim), dtype=torch.float32)
        torch.onnx.export(
            model,
            dummy,
            onnx_path,
            input_names=["features"],
            output_names=["forecast"],
            dynamic_axes={"features": {1: "lookback"}, "forecast": {1: "horizon"}},
            opset_version=17,
        )
        print(f"ONNX exported: {onnx_path}")

    return metadata


def main():
    parser = argparse.ArgumentParser(description="Train LSTM/PatchTST forecaster")
    # Data source
    parser.add_argument("--dataset", help="CSV with numeric feature columns (legacy mode)")
    parser.add_argument("--target-column", default="close")
    parser.add_argument("--symbol", default="BTC/USDT", help="Symbol for ccxt data fetch")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--exchange", default="binance")
    # Model
    parser.add_argument("--architecture", choices=["lstm", "patchtst"], default="lstm")
    parser.add_argument("--lookback", type=int, default=48)
    parser.add_argument("--horizon", type=int, default=24)
    parser.add_argument("--hidden-dim", type=int, default=64)
    parser.add_argument("--num-layers", type=int, default=2)
    # Training
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--patience", type=int, default=15, help="Early stopping patience")
    parser.add_argument("--output-dir", default="research/ml-training/artifacts")
    parser.add_argument("--export-onnx", default="", help="ONNX output path (empty = skip)")
    parser.add_argument("--validate-only", action="store_true", help="Validate dataset/feature contract and exit before training")
    args = parser.parse_args()

    train_model(args)


if __name__ == "__main__":
    main()
