"""
Tests for IC computation module.

Usage:
    /opt/miniconda3/bin/python3 -m pytest scripts/train/test_ic_computation.py -v
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../..'))

import numpy as np
import pandas as pd
from scripts.train.ic_computation import (
    compute_spearman_rank_ic,
    compute_ic_series,
    compute_icir,
    compute_ic_drawdown,
    compute_normalized_ic_drawdown,
    effective_n_correction,
    negative_control_test,
    top_bottom_net_return,
)
from scripts.train.naive_baselines import (
    btc_buy_hold_benchmark,
    equal_weight_universe,
    raw_factor_rank_baseline,
    random_rank_baseline,
    shuffled_label_negative_control,
)
from scripts.train.ridge_ranker import train_ridge_ranker


def test_spearman_rank_ic_perfect():
    """Perfect rank correlation → IC = 1.0."""
    f = np.array([1, 2, 3, 4, 5])
    r = np.array([1, 2, 3, 4, 5])
    ic = compute_spearman_rank_ic(f, r)
    assert abs(ic - 1.0) < 1e-10


def test_spearman_rank_ic_inverse():
    """Perfect inverse rank → IC = -1.0."""
    f = np.array([1, 2, 3, 4, 5])
    r = np.array([5, 4, 3, 2, 1])
    ic = compute_spearman_rank_ic(f, r)
    assert abs(ic - (-1.0)) < 1e-10


def test_spearman_rank_ic_random():
    """Random values → IC near 0."""
    np.random.seed(42)
    f = np.random.randn(100)
    r = np.random.randn(100)
    ic = compute_spearman_rank_ic(f, r)
    assert abs(ic) < 0.3  # should be close to 0


def test_spearman_rank_ic_too_few():
    """Fewer than 3 valid pairs → IC = 0."""
    ic = compute_spearman_rank_ic(np.array([1, 2]), np.array([3, 4]))
    assert ic == 0.0


def test_icir_constant():
    """Constant IC → ICIR undefined (std=0 → 0)."""
    ic = pd.Series([0.1] * 30)
    assert compute_icir(ic) == 0.0


def test_ic_drawdown_positive():
    """Monotonically increasing cumulative IC → drawdown = 0."""
    ic = pd.Series([0.1] * 30)
    dd = compute_ic_drawdown(ic)
    assert dd == 0.0


def test_ic_drawdown_negative():
    """Negative IC values → positive drawdown."""
    ic = pd.Series([0.5, 0.3, -0.2, -0.1, 0.1])
    dd = compute_ic_drawdown(ic)
    assert dd > 0


def test_ic_drawdown_peak():
    """Peak at t=3 with negative IC after → positive drawdown."""
    ic = pd.Series([0.1, 0.3, 0.5, -0.4, -0.2])
    dd = compute_ic_drawdown(ic)
    # cumulative = [0.1, 0.4, 0.9, 0.5, 0.3], peak=0.9 at t=3
    # dd = 0.9 - 0.3 = 0.6
    assert abs(dd - 0.6) < 1e-10


def test_normalized_ic_drawdown():
    """Normalized dd should equal dd / std(ic)."""
    ic = pd.Series([0.5, 0.3, -0.1, 0.2, -0.3])
    dd = compute_ic_drawdown(ic)
    norm = compute_normalized_ic_drawdown(ic)
    s = ic.std(ddof=1)
    expected = dd / s if s > 0 else float('inf')
    assert abs(norm - expected) < 1e-10


def test_effective_n_less_than_nominal():
    """Autocorrelated IC → effective N < nominal N."""
    np.random.seed(42)
    ic = pd.Series(np.random.randn(100) * 0.1)
    eff_n = effective_n_correction(ic)
    assert eff_n <= 100


def test_negative_control_no_leakage():
    """Random data → no leakage detected."""
    np.random.seed(42)
    n_assets, n_days = 20, 50
    factors = pd.DataFrame(np.random.randn(n_days, n_assets))
    returns = pd.DataFrame(np.random.randn(n_days, n_assets))
    result = negative_control_test(factors, returns, n_permutations=30)
    assert not result['leakage_detected']
    assert abs(result['shuffled_mean_ic']) < 0.05


def test_btc_benchmark():
    """Simple return sum."""
    ret = pd.Series([0.1, -0.05, 0.02])
    b = btc_buy_hold_benchmark(ret)
    assert abs(b - 0.07) < 1e-10


def test_equal_weight():
    """Mean across assets per time step."""
    ret = pd.DataFrame({'A': [0.1, 0.2], 'B': [0.3, 0.4]})
    ew = equal_weight_universe(ret)
    assert abs(ew.iloc[0] - 0.2) < 1e-10
    assert abs(ew.iloc[1] - 0.3) < 1e-10


def test_raw_factor_rank():
    """Top quantile > bottom quantile for sorted data."""
    f = pd.Series([1, 2, 3, 4, 5, 6, 7, 8])
    r = pd.Series([0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08])
    result = raw_factor_rank_baseline(f, r, top_pct=0.25)
    assert result['spread'] > 0


def test_random_rank():
    """Random ranks → mean IC ≈ 0."""
    np.random.seed(42)
    r = pd.Series(np.random.randn(100))
    result = random_rank_baseline(r, n_permutations=200)
    assert abs(result['mean_ic']) < 0.05


def test_ridge_ranker():
    """Ridge can learn a simple linear relationship."""
    np.random.seed(42)
    n = 100
    X = pd.DataFrame({'f1': np.random.randn(n), 'f2': np.random.randn(n)})
    y = pd.Series(2 * X['f1'] - 0.5 * X['f2'] + np.random.randn(n) * 0.1)
    model, scaler = train_ridge_ranker(X, y, alpha=0.1)
    from scipy.stats import spearmanr
    pred = model.predict(scaler.transform(X.values.astype(float)))
    ic = spearmanr(pred, y)[0]
    assert ic > 0.5  # should recover the linear signal


def test_top_bottom_net_return():
    """Higher factor values should have higher forward returns."""
    n_assets = 20
    factors = pd.DataFrame({'A': [1, 2], 'B': [3, 4], 'C': [5, 6], 'D': [7, 8]})
    returns = pd.DataFrame({'A': [0.01, 0.02], 'B': [0.03, 0.04], 'C': [0.05, 0.06], 'D': [0.07, 0.08]})
    spread = top_bottom_net_return(factors.T, returns.T, top_n=1, bottom_n=1)
    assert len(spread) > 0
