"""
Naive baselines — every ML model must beat these before promotion.

1. BTC buy-and-hold benchmark
2. equal-weight universe benchmark
3. raw factor rank baseline
4. random rank baseline
5. shuffled-label negative control
"""
import numpy as np
import pandas as pd


def btc_buy_hold_benchmark(btc_returns: pd.Series) -> float:
    """Simple buy-and-hold BTC return over the period."""
    return float(btc_returns.sum())


def equal_weight_universe(return_matrix: pd.DataFrame) -> pd.Series:
    """Equal-weight portfolio return across universe per time step."""
    return return_matrix.mean(axis=1)


def raw_factor_rank_baseline(
    factor_values: pd.Series,
    forward_returns: pd.Series,
    top_pct: float = 0.25,
) -> dict:
    """Top quartile minus bottom quartile return from raw factor rank."""
    valid = factor_values.notna() & forward_returns.notna()
    f = factor_values[valid]
    r = forward_returns[valid]
    if len(f) < 4:
        return {'top_return': 0.0, 'bottom_return': 0.0, 'spread': 0.0}

    ranked = f.rank(ascending=True)
    n_top = max(1, int(len(f) * top_pct))
    top = r[ranked.nlargest(n_top).index].mean()
    bottom = r[ranked.nsmallest(n_top).index].mean()
    return {
        'top_return': float(top),
        'bottom_return': float(bottom),
        'spread': float(top - bottom),
    }


def random_rank_baseline(
    forward_returns: pd.Series,
    n_permutations: int = 1000,
) -> dict:
    """Distribution of IC from random ranks (should center at 0)."""
    from scipy.stats import spearmanr
    ics = []
    for _ in range(n_permutations):
        random_rank = np.random.permutation(len(forward_returns))
        rho = spearmanr(random_rank, forward_returns.values)[0]
        ics.append(float(rho) if not np.isnan(rho) else 0.0)

    return {
        'mean_ic': float(np.mean(ics)),
        'std_ic': float(np.std(ics, ddof=1)),
        'p95_ic': float(np.percentile(ics, 95)),
        'p05_ic': float(np.percentile(ics, 5)),
    }


def shuffled_label_negative_control(
    feature_matrix: pd.DataFrame,
    forward_returns: pd.Series,
    n_permutations: int = 100,
    model=None,
) -> dict:
    """Shuffle labels, train model, check IC distribution.

    If model IC > 0.03 on shuffled labels, data leakage detected.
    """
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler
    from scipy.stats import spearmanr

    if model is None:
        model = Ridge(alpha=1.0, random_state=42)

    X = feature_matrix.values.astype(float)
    y = forward_returns.values.astype(float)

    valid = ~(np.isnan(X).any(axis=1) | np.isnan(y))
    X, y = X[valid], y[valid]

    if len(X) < 10:
        return {'mean_ic': 0.0, 'leakage_detected': False, 'error': 'insufficient_data'}

    ics = []
    for _ in range(n_permutations):
        y_shuffled = np.random.permutation(y)
        scaler = StandardScaler()
        X_s = scaler.fit_transform(X)
        model.fit(X_s, y_shuffled)
        y_pred = model.predict(X_s)
        rho = spearmanr(y_pred, y_shuffled)[0]
        ics.append(float(rho) if not np.isnan(rho) else 0.0)

    mean_ic = float(np.mean(ics))
    return {
        'mean_ic': mean_ic,
        'std_ic': float(np.std(ics, ddof=1)),
        'leakage_detected': mean_ic > 0.03,
        'n_permutations': n_permutations,
    }
