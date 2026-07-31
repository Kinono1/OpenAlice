"""
IC Computation — Spearman Rank IC, ICIR, IC Drawdown, Negative Control.

Usage:
    from ic_computation import compute_spearman_rank_ic, compute_ic_series
"""
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from typing import Optional


def compute_spearman_rank_ic(
    factor_values: np.ndarray,
    forward_returns: np.ndarray,
) -> float:
    """Spearman Rank IC for one time step."""
    mask = ~(np.isnan(factor_values) | np.isnan(forward_returns))
    n_valid = mask.sum()
    if n_valid < 3:
        return float('nan')
    rho, _ = spearmanr(factor_values[mask], forward_returns[mask])
    return float(rho) if not np.isnan(rho) else float('nan')


def compute_ic_series(
    factor_matrix: pd.DataFrame,   # index=timestamp, columns=symbol, values=factor
    return_matrix: pd.DataFrame,   # aligned forward returns
) -> pd.Series:
    """Daily IC series. Each row is one timestep."""
    common_idx = factor_matrix.index.intersection(return_matrix.index)
    ics = []
    valid_idx = []
    for t in common_idx:
        f = factor_matrix.loc[t].values.astype(float)
        r = return_matrix.loc[t].values.astype(float)
        ic = compute_spearman_rank_ic(f, r)
        if np.isfinite(ic):
            ics.append(ic)
            valid_idx.append(t)
    return pd.Series(ics, index=valid_idx, name='spearman_ic')


def compute_icir(ic_series: pd.Series) -> float:
    """ICIR = mean(IC) / std(IC)."""
    ic_series = ic_series.replace([np.inf, -np.inf], np.nan).dropna()
    if len(ic_series) < 2:
        return 0.0
    m = ic_series.mean()
    s = ic_series.std(ddof=1)
    return float(m / s) if s > 1e-12 else 0.0


def compute_ic_drawdown(ic_series: pd.Series) -> float:
    """Peak-to-trough max drawdown of cumulative IC."""
    ic_series = ic_series.replace([np.inf, -np.inf], np.nan).dropna()
    if len(ic_series) == 0:
        return 0.0
    cum = ic_series.cumsum()
    peak = cum.expanding().max()
    dd = (peak - cum).max()
    return float(dd) if not np.isnan(dd) else 0.0


def compute_normalized_ic_drawdown(ic_series: pd.Series) -> float:
    """IC drawdown normalized by IC std."""
    ic_series = ic_series.replace([np.inf, -np.inf], np.nan).dropna()
    dd = compute_ic_drawdown(ic_series)
    s = ic_series.std(ddof=1)
    if s <= 0:
        return float('inf')
    return dd / s


def _newey_west_se(ic_series: pd.Series, max_lags: int = 24) -> float:
    """Newey-West adjusted standard error."""
    ic_series = ic_series.replace([np.inf, -np.inf], np.nan).dropna()
    n = len(ic_series)
    if n < 2:
        return float('inf')
    resid = ic_series - ic_series.mean()
    var = (resid ** 2).sum() / n
    for lag in range(1, min(max_lags + 1, n)):
        cov = (resid.iloc[lag:] * resid.iloc[:-lag]).sum() / n
        var += 2 * (1 - lag / (max_lags + 1)) * cov
    return float(np.sqrt(max(var, 0) / n))


def effective_n_correction(
    ic_series: pd.Series,
    method: str = 'newey_west',
    max_lags: int = 24,
) -> float:
    """Effective sample size using Newey-West or block bootstrap."""
    if method == 'newey_west':
        se = _newey_west_se(ic_series, max_lags)
        if se <= 0 or np.isinf(se):
            return float(len(ic_series))
        raw_se = ic_series.std(ddof=1) / np.sqrt(len(ic_series))
        if raw_se <= 0:
            return float(len(ic_series))
        effective_n = len(ic_series) * (raw_se / se) ** 2
        return float(effective_n)
    else:
        return float(len(ic_series))


def negative_control_test(
    factor_matrix: pd.DataFrame,
    return_matrix: pd.DataFrame,
    n_permutations: int = 100,
) -> dict:
    """Shuffle forward returns, recompute IC. If mean IC > 0.03, data leakage."""
    original_series = compute_ic_series(factor_matrix, return_matrix)
    original_ic = original_series.mean()
    shuffled_ics = []
    for _ in range(n_permutations):
        shuffled_returns = return_matrix.apply(
            lambda x: x.sample(frac=1).values, axis=0
        )
        ic_shuf = compute_ic_series(factor_matrix, shuffled_returns)
        if len(ic_shuf) > 0 and np.isfinite(ic_shuf.mean()):
            shuffled_ics.append(ic_shuf.mean())

    shuffled_mean = float(np.mean(shuffled_ics)) if shuffled_ics else float('nan')
    shuffled_std = float(np.std(shuffled_ics, ddof=1)) if len(shuffled_ics) > 1 else 0.0

    return {
        'original_mean_ic': float(original_ic) if np.isfinite(original_ic) else None,
        'shuffled_mean_ic': shuffled_mean,
        'shuffled_std_ic': shuffled_std,
        'leakage_detected': bool(np.isfinite(shuffled_mean) and shuffled_mean > 0.03),
        'n_permutations': n_permutations,
        'n_valid_original_timestamps': int(len(original_series)),
        'n_valid_shuffles': int(len(shuffled_ics)),
    }


def top_bottom_net_return(
    factor_matrix: pd.DataFrame,
    return_matrix: pd.DataFrame,
    top_n: int = 5,
    bottom_n: int = 5,
) -> pd.Series:
    """Long top N, short bottom N by factor rank. Return net spread."""
    common_idx = factor_matrix.index.intersection(return_matrix.index)
    spreads = []
    valid_idx = []
    for t in common_idx:
        f = factor_matrix.loc[t].astype(float)
        r = return_matrix.loc[t].astype(float)
        valid = f.notna() & r.notna()
        f, r = f[valid], r[valid]
        if len(f) < top_n + bottom_n:
            continue
        ranked = f.rank(ascending=True)
        top = r[ranked.nlargest(top_n).index].mean()
        bottom = r[ranked.nsmallest(bottom_n).index].mean()
        spreads.append(float(top - bottom))
        valid_idx.append(t)
    return pd.Series(spreads, index=valid_idx)
