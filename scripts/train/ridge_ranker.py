"""
Ridge ranker — trains Ridge regression to predict forward returns, then rank-transforms.

Phase 1 model. Must beat Naive baselines before promotion to Phase 2.
"""
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from sklearn.preprocessing import StandardScaler
from typing import Tuple, Optional


def train_ridge_ranker(
    feature_matrix: pd.DataFrame,
    forward_returns: pd.Series,
    alpha: float = 1.0,
    fit_intercept: bool = True,
) -> Tuple[Ridge, StandardScaler]:
    """Train a Ridge ranker.

    Returns:
        (model, scaler) — call predict_rank(model, scaler, features) for inference.
    """
    # Drop rows with missing features or target
    valid = feature_matrix.notna().all(axis=1) & forward_returns.notna()
    X = feature_matrix[valid].values.astype(np.float64)
    y = forward_returns[valid].values.astype(np.float64)

    if X.shape[0] < 10 or X.shape[1] < 1:
        raise ValueError(f'Insufficient training data: {X.shape}')

    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = Ridge(alpha=alpha, fit_intercept=fit_intercept, random_state=42)
    model.fit(X_scaled, y)

    return model, scaler


def predict_rank(
    model: Ridge,
    scaler: StandardScaler,
    features: pd.DataFrame,
) -> np.ndarray:
    """Predict forward returns, then rank-transform (1=best, N=worst)."""
    X = features.values.astype(np.float64)
    X_scaled = scaler.transform(X)
    preds = model.predict(X_scaled)
    ranks = pd.Series(preds).rank(ascending=False).values
    return ranks
