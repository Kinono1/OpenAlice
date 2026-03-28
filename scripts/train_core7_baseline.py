#!/usr/bin/env python3
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import (
    accuracy_score,
    f1_score,
    mean_absolute_error,
    mean_squared_error,
    precision_score,
    recall_score,
    roc_auc_score,
    r2_score,
)
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

from core7_pipeline_utils import read_csv_any, write_json


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Train a minimal sklearn baseline on a core7 feature table."
    )
    parser.add_argument("--input", required=True, help="Feature table path (.csv or .csv.zst).")
    parser.add_argument("--label-col", required=True, help="Label column to predict.")
    parser.add_argument("--output", required=True, help="Summary JSON output path.")
    parser.add_argument("--train-ratio", type=float, default=0.7, help="Train split ratio.")
    parser.add_argument("--valid-ratio", type=float, default=0.15, help="Validation split ratio.")
    return parser.parse_args()


def is_binary_label(series: pd.Series) -> bool:
    uniq = sorted(set(series.dropna().astype(int).tolist()))
    return uniq in ([0], [1], [0, 1])


def build_feature_matrix(df: pd.DataFrame, label_col: str) -> tuple[pd.DataFrame, pd.Series]:
    label_cols = [col for col in df.columns if col.startswith("label_")]
    exclude = set(label_cols + ["timestamp_ms", "iso_utc", "okx_inst_id", "okx_market", "base", "quote"])
    y = df[label_col]
    X = df[[col for col in df.columns if col not in exclude and pd.api.types.is_numeric_dtype(df[col])]].copy()
    return X, y


def main() -> None:
    args = parse_args()
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()

    df = read_csv_any(input_path)
    if args.label_col not in df.columns:
        raise SystemExit(f"Missing label column: {args.label_col}")

    df = df.sort_values("timestamp_ms", kind="stable").reset_index(drop=True)
    df = df[df[args.label_col].notna()].reset_index(drop=True)
    if len(df) < 50:
        raise SystemExit(f"Not enough labeled rows for baseline training: {len(df)}")

    X, y = build_feature_matrix(df, args.label_col)
    if X.empty:
        raise SystemExit("No numeric feature columns found after exclusions.")

    n = len(df)
    train_end = int(n * args.train_ratio)
    valid_end = train_end + int(n * args.valid_ratio)
    train_end = max(1, min(train_end, n - 2))
    valid_end = max(train_end + 1, min(valid_end, n - 1))

    X_train, X_valid, X_test = X.iloc[:train_end], X.iloc[train_end:valid_end], X.iloc[valid_end:]
    y_train, y_valid, y_test = y.iloc[:train_end], y.iloc[train_end:valid_end], y.iloc[valid_end:]

    metrics: dict[str, float | None]
    model_name: str

    if is_binary_label(y):
        model_name = "logistic_regression"
        pipe = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="constant", fill_value=0.0)),
                ("scaler", StandardScaler()),
                ("model", LogisticRegression(max_iter=500, class_weight="balanced")),
            ]
        )
        pipe.fit(X_train, y_train.astype(int))
        prob_valid = pipe.predict_proba(X_valid)[:, 1]
        pred_valid = (prob_valid >= 0.5).astype(int)
        prob_test = pipe.predict_proba(X_test)[:, 1]
        pred_test = (prob_test >= 0.5).astype(int)
        majority = int(y_train.mode().iloc[0])
        naive_test = np.full(len(y_test), majority)
        metrics = {
            "valid_accuracy": float(accuracy_score(y_valid, pred_valid)),
            "valid_precision": float(precision_score(y_valid, pred_valid, zero_division=0)),
            "valid_recall": float(recall_score(y_valid, pred_valid, zero_division=0)),
            "valid_f1": float(f1_score(y_valid, pred_valid, zero_division=0)),
            "valid_auc": float(roc_auc_score(y_valid, prob_valid)) if len(set(y_valid.astype(int))) > 1 else None,
            "test_accuracy": float(accuracy_score(y_test, pred_test)),
            "test_precision": float(precision_score(y_test, pred_test, zero_division=0)),
            "test_recall": float(recall_score(y_test, pred_test, zero_division=0)),
            "test_f1": float(f1_score(y_test, pred_test, zero_division=0)),
            "test_auc": float(roc_auc_score(y_test, prob_test)) if len(set(y_test.astype(int))) > 1 else None,
            "naive_test_accuracy": float(accuracy_score(y_test, naive_test)),
        }
    else:
        model_name = "ridge_regression"
        pipe = Pipeline(
            [
                ("imputer", SimpleImputer(strategy="constant", fill_value=0.0)),
                ("scaler", StandardScaler()),
                ("model", Ridge(alpha=1.0)),
            ]
        )
        pipe.fit(X_train, y_train.astype(float))
        pred_valid = pipe.predict(X_valid)
        pred_test = pipe.predict(X_test)
        zero_baseline = np.zeros(len(y_test))
        metrics = {
            "valid_rmse": float(mean_squared_error(y_valid, pred_valid) ** 0.5),
            "valid_mae": float(mean_absolute_error(y_valid, pred_valid)),
            "valid_r2": float(r2_score(y_valid, pred_valid)),
            "test_rmse": float(mean_squared_error(y_test, pred_test) ** 0.5),
            "test_mae": float(mean_absolute_error(y_test, pred_test)),
            "test_r2": float(r2_score(y_test, pred_test)),
            "naive_zero_test_rmse": float(mean_squared_error(y_test, zero_baseline) ** 0.5),
        }

    payload = {
        "schemaVersion": "core7_baseline_train.summary.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "input": str(input_path),
        "labelCol": args.label_col,
        "model": model_name,
        "splits": {
            "rows": n,
            "trainRows": len(X_train),
            "validRows": len(X_valid),
            "testRows": len(X_test),
        },
        "features": {
            "count": len(X.columns),
            "names": list(X.columns),
        },
        "metrics": metrics,
    }
    write_json(output_path, payload)
    print(f"trained {model_name} rows={n} features={len(X.columns)}")
    print(f"summary={output_path}")


if __name__ == "__main__":
    main()
