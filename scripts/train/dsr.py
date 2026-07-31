"""
Deflated Sharpe Ratio (DSR) and Probabilistic Sharpe Ratio (PSR).

Implements the formulas from:
  Bailey & Lopez de Prado (2014).
  "The Deflated Sharpe Ratio: Correcting for Selection Bias, Backtest Overfitting,
   and Non-Normality"
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=2460551

The implementation follows the TypeScript reference at
  src/backtest/statistical_significance.ts  (computeDeflatedSharpe)
"""

import math

import scipy.stats as stats

EULER_GAMMA = 0.5772156649015328606065120900824024310421


def psr(
    sharpe: float,
    T: int,
    skew: float = 0.0,
    kurt: float = 3.0,
    benchmark_sr: float = 0.0,
) -> float:
    """Probabilistic Sharpe Ratio (PSR).

    Returns the probability that the true Sharpe ratio exceeds *benchmark_sr*,
    given the observed sample Sharpe, skewness, and (Pearson) kurtosis.

    Parameters
    ----------
    sharpe : float
        Observed Sharpe ratio of the strategy.
    T : int
        Number of independent observations (trades / returns).
    skew : float, optional
        Skewness of returns (default 0, i.e. normal).
    kurt : float, optional
        Pearson kurtosis of returns (default 3, i.e. normal).
    benchmark_sr : float, optional
        Benchmark Sharpe ratio to compare against (default 0).

    Returns
    -------
    float
        PSR value in [0, 1].
    """
    if T < 2:
        return 0.5

    sr_diff = sharpe - benchmark_sr
    denom = 1.0 - skew * sharpe + ((kurt - 1.0) / 4.0) * sharpe * sharpe
    if denom <= 0.0:
        denom = 1e-12

    sigma_sharpe = math.sqrt(denom / float(T - 1))
    if sigma_sharpe <= 0.0:
        return 0.5

    return float(stats.norm.cdf(sr_diff / sigma_sharpe))


def deflated_sharpe_ratio(
    sharpe: float,
    T: int,
    N: int,
    skew: float = 0.0,
    kurt: float = 3.0,
) -> float:
    """Deflated Sharpe Ratio (DSR).

    Adjusts the Probabilistic Sharpe Ratio for multiple-testing bias introduced
    by evaluating *N* different strategy configurations.  The benchmark Sharpe
    is the expected maximum of *N* i.i.d. standard normal variables, using the
    approximation from Bailey & Lopez de Prado (2014).

    When *N* <= 1, no correction is applied and the result equals PSR(0) so
    that a strategy with zero observed Sharpe and a single trial yields DSR
    approximately 0.5 (the unbiased neutral value).

    Parameters
    ----------
    sharpe : float
        Observed Sharpe ratio of the best-performing strategy.
    T : int
        Number of independent observations.
    N : int
        Number of trials (parameter combinations / strategies tested).
    skew : float, optional
        Skewness of returns (default 0).
    kurt : float, optional
        Pearson kurtosis of returns (default 3).

    Returns
    -------
    float
        DSR value in [0, 1].  High values indicate the strategy is unlikely to
        be a product of multiple-testing luck.
    """
    if T < 2:
        return 0.5

    if N <= 1:
        # Single trial: no multiple-testing correction.
        return psr(sharpe, T, skew, kurt, 0.0)

    denom = 1.0 - skew * sharpe + ((kurt - 1.0) / 4.0) * sharpe * sharpe
    if denom <= 0.0:
        denom = 1e-12

    sigma_sharpe = math.sqrt(denom / float(T - 1))
    if sigma_sharpe <= 0.0:
        return 0.5

    # Clamp probabilities to avoid +/-inf from extreme quantiles
    p1 = max(1e-6, min(1.0 - 1e-6, 1.0 - 1.0 / float(N)))
    p2 = max(1e-6, min(1.0 - 1e-6, 1.0 - 1.0 / (float(N) * math.e)))

    z1 = float(stats.norm.ppf(p1))
    z2 = float(stats.norm.ppf(p2))

    # Expected maximum of N i.i.d. standard normals
    benchmark_sharpe = sigma_sharpe * (
        (1.0 - EULER_GAMMA) * z1 + EULER_GAMMA * z2
    )

    z = (sharpe - benchmark_sharpe) / sigma_sharpe
    return float(stats.norm.cdf(z))


if __name__ == "__main__":
    # Test 1: zero Sharpe, many trials => DSR well below 0.5
    dsr1 = deflated_sharpe_ratio(0, 200, 100)
    ok1 = dsr1 < 0.45
    print(f"dsr(0, 200, 100) = {dsr1:.6f}  {'PASS' if ok1 else 'FAIL'}")
    assert ok1, f"Expected < 0.45, got {dsr1}"

    # Test 2: zero Sharpe, single trial => DSR ~0.5
    dsr2 = deflated_sharpe_ratio(0, 200, 1)
    ok2 = abs(dsr2 - 0.5) < 0.05
    print(f"dsr(0, 200, 1)   = {dsr2:.6f}  {'PASS' if ok2 else 'FAIL'}")
    assert ok2, f"Expected ~0.5, got {dsr2}"

    # Test 3: strong Sharpe => DSR near 1.0
    dsr3 = deflated_sharpe_ratio(2, 500, 10)
    ok3 = dsr3 > 0.95
    print(f"dsr(2, 500, 10)  = {dsr3:.6f}  {'PASS' if ok3 else 'FAIL'}")
    assert ok3, f"Expected > 0.95, got {dsr3}"

    print("\nAll tests passed.")
