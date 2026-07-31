#!/usr/bin/env python3
"""
Strategy ensemble and meta-strategies combining multiple signals.

Tests 5 strategies with WFO-Lite (train=365d, test=63d, step=21d):

  A: Signal fusion ensemble — average 3 ranks (low-vol, momentum, volume
     stability), buy top 25%, rebalance 30d.

  B: Adaptive switch — 60d rolling win rate toggles between low-vol,
     momentum, and reversal strategies every 30d.

  C: Volatility-adjusted position sizing — V6a low-vol base portfolio
     but scale positions 50% when BTC 21d vol exceeds historical median.

  D: Multi-strategy equal-weight — run 4 strategies (low-vol, momentum,
     reversal, BTC-only) in parallel with equal capital allocation.

  E: Pairs trading proxy — trade spread mean-reversion on top 3 most
     correlated pairs from top-10-volume coins (60d lookback).

WFO-Lite per fold: train=365d, test=63d, step=21d.
Daily klines from: /Volumes/shield/cryptoData/openalice-data/market/...

Output: data/research/strategy_ensemble_report.json
No secrets, no API calls.
"""

import json
import os
import sys
import zipfile
import warnings
from datetime import datetime, timezone

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------
BASE = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
KLINES_DIR = f"{BASE}/spot-all-usdt-klines-1d/spot"
OUTPUT_PATH = "data/research/strategy_ensemble_report.json"
COST_BPS = 15

WFO_TRAIN = 365
WFO_TEST = 63
WFO_STEP = 21

LONG_PCT = 0.25

# 24 mainstream coins – same universe as existing research scripts
MAIN_SYMBOLS = frozenset([
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
    "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "LINKUSDT", "DOTUSDT",
    "UNIUSDT", "LTCUSDT", "BCHUSDT", "ATOMUSDT",
    "NEARUSDT", "OPUSDT", "ARBUSDT", "SUIUSDT",
    "TRXUSDT", "APTUSDT", "INJUSDT", "ETCUSDT",
    "AAVEUSDT", "MKRUSDT",
])

LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_daily_ohlcv(
    symbol: str, start_year: int = 2019, end_year: int = 2026
) -> tuple[dict[str, float], dict[str, float]]:
    """Load (closes, volumes) for *symbol* from monthly ZIP klines.

    Returns ({date_str: close}, {date_str: volume}).
    Missing ZIPs / corrupt files are silently skipped.
    """
    kline_path = os.path.join(KLINES_DIR, symbol, "1d")
    if not os.path.isdir(kline_path):
        return {}, {}
    closes: dict[str, float] = {}
    volumes: dict[str, float] = {}
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            fname = f"{symbol}-1d-{year}-{month:02d}.zip"
            fpath = os.path.join(kline_path, fname)
            if not os.path.exists(fpath):
                continue
            try:
                with zipfile.ZipFile(fpath) as z:
                    names = z.namelist()
                    if not names:
                        continue
                    text = z.read(names[0]).decode("utf-8", errors="replace")
                    for line in text.strip().split("\n"):
                        cols = line.split(",")
                        if len(cols) >= 6:
                            try:
                                ts_ms = int(cols[0])
                                close = float(cols[4])
                                volume = float(cols[5])
                                date_str = datetime.fromtimestamp(
                                    ts_ms / 1000, tz=timezone.utc
                                ).strftime("%Y-%m-%d")
                                closes[date_str] = close
                                volumes[date_str] = volume
                            except (ValueError, IndexError):
                                continue
            except Exception:
                continue
    return closes, volumes


# ---------------------------------------------------------------------------
# Matrix construction
# ---------------------------------------------------------------------------

def build_matrices(
    symbols: list[str],
) -> tuple:
    """Load and align price/volume data for all *symbols*.

    Returns:
        close_matrix:   (n_sym, n_dates) close prices, NaN for missing
        volume_matrix:  (n_sym, n_dates) daily volume, 0 for missing
        ret_matrix:     (n_sym, n_dates) daily simple returns, NaN missing
        all_dates:      sorted list of date strings
        symbols:        symbol list (as input)
        btc_idx:        index of BTCUSDT
        n_dates:        number of trading days
    """
    all_closes: dict[str, dict[str, float]] = {}
    all_volumes: dict[str, dict[str, float]] = {}
    for sym in symbols:
        closes, volumes = load_daily_ohlcv(sym)
        if closes:
            all_closes[sym] = closes
            all_volumes[sym] = volumes

    all_dates = sorted(set(
        d for closes in all_closes.values() for d in closes
    ))
    n_dates = len(all_dates)
    n_sym = len(symbols)
    date_to_idx = {d: i for i, d in enumerate(all_dates)}

    close_matrix = np.full((n_sym, n_dates), np.nan)
    volume_matrix = np.zeros((n_sym, n_dates))

    for si, sym in enumerate(symbols):
        if sym in all_closes:
            for d, p in all_closes[sym].items():
                if d in date_to_idx:
                    close_matrix[si, date_to_idx[d]] = p
            if sym in all_volumes:
                for d, v in all_volumes[sym].items():
                    if d in date_to_idx:
                        volume_matrix[si, date_to_idx[d]] = v

    # Daily simple returns
    ret_matrix = np.full((n_sym, n_dates), np.nan)
    ret_matrix[:, 0] = 0.0
    with np.errstate(invalid="ignore", divide="ignore"):
        ret_matrix[:, 1:] = close_matrix[:, 1:] / close_matrix[:, :-1] - 1.0

    # BTC index
    btc_idx = None
    for si, sym in enumerate(symbols):
        if sym == "BTCUSDT":
            btc_idx = si
            break

    return close_matrix, volume_matrix, ret_matrix, all_dates, symbols, btc_idx, n_dates


# ---------------------------------------------------------------------------
# Rolling window helpers
# ---------------------------------------------------------------------------

def safe_rolling_std(arr: np.ndarray, window: int, min_periods: int = 5) -> float:
    """Compute std of *arr* over the last *window* elements (right-aligned).
    Returns NaN if fewer than *min_periods* finite values.
    """
    n = len(arr)
    if n < min_periods:
        return np.nan
    valid = arr[np.isfinite(arr)]
    if len(valid) < min_periods:
        return np.nan
    return float(np.std(valid[-window:], ddof=1)) if len(valid[-window:]) >= 2 else np.nan


def safe_rolling_mean(arr: np.ndarray, window: int, min_periods: int = 5) -> float:
    """Compute mean of *arr* over the last *window* elements."""
    n = len(arr)
    if n < min_periods:
        return np.nan
    valid = arr[np.isfinite(arr)]
    if len(valid) < min_periods:
        return np.nan
    return float(np.mean(valid[-window:]))


def rank_normalized(values: np.ndarray) -> np.ndarray:
    """Rank array (0=best, 1=worst), normalized to [0,1]. NaN values get 0.5."""
    n = len(values)
    if n == 0:
        return np.array([], dtype=float)
    out = np.full(n, 0.5, dtype=float)
    finite_mask = np.isfinite(values)
    n_finite = int(np.sum(finite_mask))
    if n_finite < 2:
        return out
    finite_vals = values[finite_mask]
    order = np.argsort(finite_vals)
    ranks = np.empty(n_finite)
    ranks[order] = np.arange(n_finite)
    normalized = ranks / float(n_finite - 1)  # 0=lowest, 1=highest
    out[finite_mask] = normalized
    return out  # 0=best (lowest value), 1=worst (highest value)


def btc_benchmark_return(
    close_matrix: np.ndarray, btc_idx: int, start_di: int, end_di: int
) -> float | None:
    """Return BTC return from *start_di* to *end_di* (exclusive), or None if invalid."""
    if btc_idx is None:
        return None
    sp = close_matrix[btc_idx, start_di]
    ep = close_matrix[btc_idx, min(end_di, close_matrix.shape[1] - 1)]
    if np.isfinite(sp) and np.isfinite(ep) and sp > 0:
        return float(ep / sp - 1.0)
    return None


# ---------------------------------------------------------------------------
# Performance metrics calculator
# ---------------------------------------------------------------------------

def compute_period_metrics(
    returns_list: list[float],
    btc_returns_list: list[float],
    holding_days: int,
) -> dict | None:
    """Compute pooled metrics from a list of holding-period returns."""
    if not returns_list:
        return None
    pool = np.array(returns_list)
    btc_pool = np.array(btc_returns_list) if len(btc_returns_list) == len(returns_list) else np.zeros(len(pool))

    win_rate = float(np.mean(pool > 0))
    mean_return = float(np.mean(pool))
    median_return = float(np.median(pool))
    std_return = float(np.std(pool, ddof=1))
    outperform_rate = float(np.mean(pool > btc_pool))

    ann_factor = 365.25 / holding_days
    ann_return = float(np.mean(pool)) * ann_factor
    sharpe = float(np.mean(pool) / std_return * np.sqrt(ann_factor)) if std_return > 0 and len(pool) > 1 else 0.0

    cum = np.cumprod(1.0 + pool)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    return {
        "win_rate": round(win_rate, 4),
        "mean_period_return": round(mean_return, 6),
        "median_period_return": round(median_return, 6),
        "std_period_return": round(std_return, 6),
        "annualized_return": round(ann_return, 6),
        "sharpe": round(sharpe, 4),
        "outperform_btc_rate": round(outperform_rate, 4),
        "max_drawdown": round(max_dd, 6),
        "n_periods": len(pool),
    }


# ---------------------------------------------------------------------------
# WFO-Lite iterator
# ---------------------------------------------------------------------------

def wfo_folds(n_dates: int):
    """Yield (fold_idx, test_start, test_end) for each non-overlapping WFO fold."""
    i = 0
    while i + WFO_TRAIN + WFO_TEST <= n_dates:
        test_start = i + WFO_TRAIN
        test_end = test_start + WFO_TEST
        yield i, test_start, min(test_end, n_dates)
        i += WFO_STEP


# ===================================================================
# STRATEGY A: Signal Fusion Ensemble
# ===================================================================
# Combine 3 signals into a composite score:
#   1. 21d low-vol rank (lower vol = better)
#   2. 30d momentum rank (higher momentum = better)
#   3. 30d volume stability rank (lower volume CV = better)
# Average the 3 ranks, buy top 25%. Rebalance 30d.
# ===================================================================

def compute_21d_vol(ret_matrix: np.ndarray, sym_idx: int, end_di: int) -> float:
    """21-day realized vol for symbol *sym_idx* ending at *end_di*."""
    if end_di < 21:
        return np.nan
    rets = ret_matrix[sym_idx, end_di - 20: end_di + 1]
    valid = rets[np.isfinite(rets)]
    if len(valid) < 15:
        return np.nan
    return float(np.std(valid, ddof=1))


def compute_30d_momentum(close_matrix: np.ndarray, sym_idx: int, end_di: int) -> float:
    """30-day price return ending at *end_di*."""
    if end_di < 30:
        return np.nan
    sp = close_matrix[sym_idx, end_di - 30]
    ep = close_matrix[sym_idx, end_di]
    if np.isfinite(sp) and np.isfinite(ep) and sp > 0:
        return float(ep / sp - 1.0)
    return np.nan


def volume_cv(volume_matrix: np.ndarray, sym_idx: int, end_di: int, window: int = 30) -> float:
    """Coefficient of variation of volume over *window* days ending at *end_di*."""
    if end_di < window:
        return np.nan
    vols = volume_matrix[sym_idx, end_di - window + 1: end_di + 1]
    valid = vols[vols > 0]
    if len(valid) < 15:
        return np.nan
    mean_v = float(np.mean(valid))
    std_v = float(np.std(valid, ddof=1))
    return std_v / mean_v if mean_v > 0 else np.nan


def compute_fwd_return(
    close_matrix: np.ndarray, sym_indices: np.ndarray,
    start_di: int, end_di: int,
) -> tuple[np.ndarray, np.ndarray]:
    """Compute forward return for symbols from *start_di* to *end_di*.
    Returns (valid_mask, fwd_returns).
    """
    start_prices = close_matrix[sym_indices, start_di]
    end_prices = close_matrix[sym_indices, end_di]
    valid = np.isfinite(start_prices) & np.isfinite(end_prices) & (start_prices > 0)
    if int(np.sum(valid)) < 1:
        return valid, np.array([])
    fwd_rets = end_prices[valid] / start_prices[valid] - 1.0
    return valid, fwd_rets


def run_strategy_A(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """WFO-Lite for Strategy A: Signal fusion ensemble."""
    hp = 30  # holding period / rebalance
    all_period_rets: list[float] = []
    all_btc_rets: list[float] = []

    for _, test_start, test_end in wfo_folds(n_dates):
        if test_end - test_start < 10:
            continue

        rebal_indices = list(range(test_start, test_end, hp))

        for ri in range(len(rebal_indices) - 1):
            rebal_di = rebal_indices[ri]
            hold_end_di = rebal_indices[ri + 1]

            if hold_end_di >= n_dates or rebal_di < 30:
                continue

            # Compute 3 signals for each mainstream symbol
            vol_vals: list[float] = []
            mom_vals: list[float] = []
            vol_stab_vals: list[float] = []

            valid_sym_indices: list[int] = []

            for si, sym in enumerate(symbols):
                if sym not in MAIN_SYMBOLS:
                    continue
                v = compute_21d_vol(ret_matrix, si, rebal_di)
                m = compute_30d_momentum(close_matrix, si, rebal_di)
                vs = volume_cv(volume_matrix, si, rebal_di, 30)
                if np.isfinite(v) and v > 0 and np.isfinite(m) and np.isfinite(vs) and vs > 0:
                    vol_vals.append(v)
                    mom_vals.append(m)
                    vol_stab_vals.append(vs)
                    valid_sym_indices.append(si)

            n_valid = len(valid_sym_indices)
            if n_valid < 4:
                continue

            sym_arr = np.array(valid_sym_indices, dtype=int)

            # Rank each signal: 0 = best, 1 = worst
            vol_rank = rank_normalized(np.array(vol_vals))        # lower vol = lower rank = better
            mom_rank_rev = 1.0 - rank_normalized(np.array(mom_vals))  # higher mom = lower rank = better
            vs_rank = rank_normalized(np.array(vol_stab_vals))    # lower CV = lower rank = better

            composite = (vol_rank + mom_rank_rev + vs_rank) / 3.0

            n_long = max(1, int(n_valid * LONG_PCT))
            order = np.argsort(composite)
            selected = sym_arr[order[:n_long]]

            # Forward return
            _, fwd_rets = compute_fwd_return(close_matrix, selected, rebal_di, hold_end_di)
            if len(fwd_rets) < 1:
                continue

            gross = float(np.mean(fwd_rets))
            net = gross - COST_BPS / 10000 * 2  # 2 legs (buy + eventual sell)

            all_period_rets.append(net)

            btc_r = btc_benchmark_return(close_matrix, btc_idx, rebal_di, hold_end_di)
            all_btc_rets.append(btc_r if btc_r is not None else 0.0)

    if not all_period_rets:
        return None

    metrics = compute_period_metrics(all_period_rets, all_btc_rets, hp)
    return {
        "holding_days": hp,
        **metrics,
    }


# ===================================================================
# STRATEGY B: Adaptive Switch
# ===================================================================
# Use 60d rolling performance to switch between:
#   (a) low-vol: bottom 25% by 21d vol
#   (b) momentum: top 25% by 30d momentum
#   (c) reversal: bottom 25% by 5d return (worst recent = reversal)
# Evaluate which performed best in past 60 days, use it next 30d.
# ===================================================================

def compute_5d_return(close_matrix: np.ndarray, sym_idx: int, end_di: int) -> float:
    """5-day return ending at *end_di*."""
    if end_di < 5:
        return np.nan
    sp = close_matrix[sym_idx, end_di - 5]
    ep = close_matrix[sym_idx, end_di]
    if np.isfinite(sp) and np.isfinite(ep) and sp > 0:
        return float(ep / sp - 1.0)
    return np.nan


def eval_strategy_on_window(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    symbols: list[str],
    rebal_di: int,
    hold_end_di: int,
    strategy_type: str,
) -> float | None:
    """Evaluate a single strategy's long-only return over one holding period.

    Strategy types:
    - "low_vol": bottom 25% by 21d vol
    - "momentum": top 25% by 30d momentum
    - "reversal": bottom 25% by 5d return (contrarian buy)

    Returns net return or None if evaluation fails.
    """
    vol_vals: list[float] = []
    mom_vals: list[float] = []
    ret5_vals: list[float] = []
    sym_indices: list[int] = []

    for si, sym in enumerate(symbols):
        if sym not in MAIN_SYMBOLS:
            continue
        v = compute_21d_vol(ret_matrix, si, rebal_di)
        m = compute_30d_momentum(close_matrix, si, rebal_di)
        r5 = compute_5d_return(close_matrix, si, rebal_di)

        ok = np.isfinite(v) and v > 0
        if strategy_type == "low_vol":
            ok = ok
        elif strategy_type == "momentum":
            ok = ok and np.isfinite(m)
        elif strategy_type == "reversal":
            ok = ok and np.isfinite(r5)

        if ok:
            vol_vals.append(v)
            mom_vals.append(m if not np.isnan(m) else 0.0)
            ret5_vals.append(r5 if not np.isnan(r5) else 0.0)
            sym_indices.append(si)

    n_valid = len(sym_indices)
    if n_valid < 4:
        return None

    sym_arr = np.array(sym_indices, dtype=int)

    if strategy_type == "low_vol":
        vals = np.array(vol_vals)
        ascending = True
    elif strategy_type == "momentum":
        vals = np.array(mom_vals)
        ascending = False
    elif strategy_type == "reversal":
        vals = np.array(ret5_vals)
        ascending = True  # worst 5d performers = reversal candidates
    else:
        return None

    n_long = max(1, int(n_valid * LONG_PCT))
    if ascending:
        order = np.argsort(vals)
    else:
        order = np.argsort(-vals)

    selected = sym_arr[order[:n_long]]

    _, fwd_rets = compute_fwd_return(close_matrix, selected, rebal_di, hold_end_di)
    if len(fwd_rets) < 1:
        return None

    gross = float(np.mean(fwd_rets))
    net = gross - COST_BPS / 10000 * 2
    return net


def determine_best_strategy(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    symbols: list[str],
    rebal_di: int,
) -> str | None:
    """Evaluate which of 3 strategies performed best over the last 60 days
    (two 30d holding periods ending at *rebal_di*).

    Returns one of "low_vol", "momentum", "reversal", or None if evaluation fails.
    """
    lookback_ends = [rebal_di - 30, rebal_di]
    lookback_starts = [rebal_di - 60, rebal_di - 30]

    # Need at least 60 days of data before this point
    if rebal_di < 60:
        return None

    strategies = ["low_vol", "momentum", "reversal"]
    strategy_scores: dict[str, list[float]] = {s: [] for s in strategies}

    for start_di, end_di in zip(lookback_starts, lookback_ends):
        if start_di < 0 or end_di >= len(ret_matrix[0]):
            continue
        for strat in strategies:
            ret = eval_strategy_on_window(
                close_matrix, ret_matrix, symbols,
                start_di, end_di, strat,
            )
            if ret is not None:
                strategy_scores[strat].append(ret)

    if not any(v for v in strategy_scores.values()):
        return None

    # Pick strategy with highest average return across the 2 periods
    best_strat = None
    best_avg = -float("inf")
    for strat in strategies:
        scores = strategy_scores[strat]
        if len(scores) >= 1:
            avg = float(np.mean(scores))
            if avg > best_avg:
                best_avg = avg
                best_strat = strat

    return best_strat


def run_strategy_B(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """WFO-Lite for Strategy B: Adaptive switch."""
    hp = 30
    all_period_rets: list[float] = []
    all_btc_rets: list[float] = []
    strategy_choices: list[str] = []

    for _, test_start, test_end in wfo_folds(n_dates):
        if test_end - test_start < 10:
            continue

        rebal_indices = list(range(test_start, test_end, hp))

        for ri in range(len(rebal_indices) - 1):
            rebal_di = rebal_indices[ri]
            hold_end_di = rebal_indices[ri + 1]

            if hold_end_di >= n_dates or rebal_di < 30:
                continue

            # Determine best strategy based on past 60d performance
            best_strat = determine_best_strategy(
                close_matrix, ret_matrix, symbols, rebal_di,
            )
            if best_strat is None:
                best_strat = "low_vol"  # default

            strategy_choices.append(best_strat)

            net = eval_strategy_on_window(
                close_matrix, ret_matrix, symbols,
                rebal_di, hold_end_di, best_strat,
            )

            if net is None:
                continue

            all_period_rets.append(net)

            btc_r = btc_benchmark_return(close_matrix, btc_idx, rebal_di, hold_end_di)
            all_btc_rets.append(btc_r if btc_r is not None else 0.0)

    if not all_period_rets:
        return None

    metrics = compute_period_metrics(all_period_rets, all_btc_rets, hp)

    # Count strategy usage
    usage = {"low_vol": 0, "momentum": 0, "reversal": 0}
    for s in strategy_choices:
        if s in usage:
            usage[s] += 1

    return {
        "holding_days": hp,
        "strategy_usage": usage,
        **metrics,
    }


# ===================================================================
# STRATEGY C: Volatility-Adjusted Position Sizing
# ===================================================================
# Base portfolio = V6a low-vol (bottom 25% by 21d vol, rebalance 21d).
# If BTC 21d vol > historical median (over train window), reduce to 50%
# position size (50% cash). Else full positions.
# Report cash/time split.
# ===================================================================

def compute_symbol_vol(ret_matrix: np.ndarray, sym_idx: int, end_di: int, window: int = 21) -> float:
    """Rolling *window*-day vol for a symbol ending at *end_di*."""
    if end_di < window:
        return np.nan
    rets = ret_matrix[sym_idx, end_di - window + 1: end_di + 1]
    valid = rets[np.isfinite(rets)]
    if len(valid) < max(window // 2, 5):
        return np.nan
    return float(np.std(valid, ddof=1))


def run_strategy_C(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """WFO-Lite for Strategy C: Vol-adjusted position sizing."""
    hp = 21  # standard V6a rebalance
    all_period_rets: list[float] = []
    all_btc_rets: list[float] = []
    cash_periods: int = 0
    full_periods: int = 0

    for _, test_start, test_end in wfo_folds(n_dates):
        if test_end - test_start < 10:
            continue

        rebal_indices = list(range(test_start, test_end, hp))

        for ri in range(len(rebal_indices) - 1):
            rebal_di = rebal_indices[ri]
            hold_end_di = rebal_indices[ri + 1]

            if hold_end_di >= n_dates or rebal_di < 21:
                continue

            # --- BTC vol regime ---
            btc_vol = compute_symbol_vol(ret_matrix, btc_idx, rebal_di, 21)
            if not np.isfinite(btc_vol) or btc_vol <= 0:
                continue

            # Historical median: use the training window (365d before test_start)
            train_start = max(0, rebal_di - WFO_TRAIN)
            btc_vol_history: list[float] = []
            for di in range(train_start, rebal_di + 1):
                v = compute_symbol_vol(ret_matrix, btc_idx, di, 21)
                if np.isfinite(v) and v > 0:
                    btc_vol_history.append(v)

            if len(btc_vol_history) < 20:
                continue  # insufficient history

            btc_vol_median = float(np.median(btc_vol_history))

            # Position scale
            if btc_vol > btc_vol_median:
                position_scale = 0.50
                cash_periods += 1
            else:
                position_scale = 1.00
                full_periods += 1

            # --- Low-vol selection (V6a) ---
            vol_vals: list[float] = []
            sym_indices: list[int] = []

            for si, sym in enumerate(symbols):
                if sym not in MAIN_SYMBOLS:
                    continue
                v = compute_symbol_vol(ret_matrix, si, rebal_di, 21)
                if np.isfinite(v) and v > 0:
                    vol_vals.append(v)
                    sym_indices.append(si)

            n_valid = len(sym_indices)
            if n_valid < 4:
                continue

            sym_arr = np.array(sym_indices, dtype=int)
            n_long = max(1, int(n_valid * LONG_PCT))
            order = np.argsort(vol_vals)
            selected = sym_arr[order[:n_long]]

            # Forward return
            _, fwd_rets = compute_fwd_return(close_matrix, selected, rebal_di, hold_end_di)
            if len(fwd_rets) < 1:
                continue

            gross = float(np.mean(fwd_rets))
            net = gross - COST_BPS / 10000 * 2

            # Apply position scaling:
            # If position_scale=0.50, only 50% of capital is deployed,
            # the rest earns 0 (cash). So return = 0.5 * net.
            scaled_net = net * position_scale

            all_period_rets.append(scaled_net)

            btc_r = btc_benchmark_return(close_matrix, btc_idx, rebal_di, hold_end_di)
            all_btc_rets.append(btc_r if btc_r is not None else 0.0)

    if not all_period_rets:
        return None

    metrics = compute_period_metrics(all_period_rets, all_btc_rets, hp)

    total_periods = cash_periods + full_periods
    return {
        "holding_days": hp,
        "cash_periods": cash_periods,
        "full_position_periods": full_periods,
        "total_periods": total_periods,
        "cash_time_fraction": round(cash_periods / total_periods, 4) if total_periods > 0 else 0,
        **metrics,
    }


# ===================================================================
# STRATEGY D: Multi-Strategy Equal-Weight
# ===================================================================
# Run 4 strategies in parallel, each gets 25% of capital:
#   1. V6a low-vol: bottom 25% by 21d vol, 30d holding
#   2. 30d momentum long-only: top 25%, 30d holding
#   3. 5d reversal long-only: bottom 25% by 5d return, 30d holding
#   4. BTC-only: buy and hold BTC for 30d
# Combined return = 0.25 * sum of 4 returns
# ===================================================================

def single_strategy_ret(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    symbols: list[str],
    rebal_di: int,
    hold_end_di: int,
    strategy_type: str,
) -> float | None:
    """Compute one strategy's forward return for a holding period.

    *strategy_type*: "low_vol", "momentum", "reversal"
    """
    return eval_strategy_on_window(
        close_matrix, ret_matrix, symbols,
        rebal_di, hold_end_di, strategy_type,
    )


def run_strategy_D(
    close_matrix: np.ndarray,
    ret_matrix: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """WFO-Lite for Strategy D: Multi-strategy equal-weight."""
    hp = 30
    all_period_rets: list[float] = []
    all_btc_rets: list[float] = []

    for _, test_start, test_end in wfo_folds(n_dates):
        if test_end - test_start < 10:
            continue

        rebal_indices = list(range(test_start, test_end, hp))

        for ri in range(len(rebal_indices) - 1):
            rebal_di = rebal_indices[ri]
            hold_end_di = rebal_indices[ri + 1]

            if hold_end_di >= n_dates or rebal_di < 30:
                continue

            strat_names = ["low_vol", "momentum", "reversal"]
            returns: list[float] = []

            for sname in strat_names:
                r = single_strategy_ret(
                    close_matrix, ret_matrix, symbols,
                    rebal_di, hold_end_di, sname,
                )
                if r is not None:
                    returns.append(r)
                else:
                    returns.append(0.0)

            # BTC-only: buy and hold BTC
            btc_r = btc_benchmark_return(close_matrix, btc_idx, rebal_di, hold_end_di)
            returns.append(btc_r if btc_r is not None else 0.0)

            # Equal-weight all 4
            combined_ret = float(np.mean(returns))

            all_period_rets.append(combined_ret)
            all_btc_rets.append(btc_r if btc_r is not None else 0.0)

    if not all_period_rets:
        return None

    metrics = compute_period_metrics(all_period_rets, all_btc_rets, hp)
    return {
        "holding_days": hp,
        **metrics,
    }


# ===================================================================
# STRATEGY E: Pairs Trading Proxy
# ===================================================================
# For each pair of coins (top 10 by volume), compute 60d correlation.
# Pick the 3 most highly correlated pairs.
# When spread > 2 std, short winner / long loser.
# Hold until spread reverts (|z| < 0.5) or end of test window.
# ===================================================================

def pick_top_volume_coins(
    volume_matrix: np.ndarray,
    symbols: list[str],
    end_di: int,
    lookback: int = 30,
    n_top: int = 10,
) -> list[int]:
    """Return indices of top *n_top* coins by average daily volume
    over the *lookback* days ending at *end_di*.
    """
    if end_di < lookback:
        # Fall back to available data
        if end_di < 1:
            return []
        start_di = 0
    else:
        start_di = end_di - lookback

    avg_volumes: list[tuple[int, float]] = []
    for si in range(len(symbols)):
        vol_slice = volume_matrix[si, start_di: end_di + 1]
        valid = vol_slice[vol_slice > 0]
        if len(valid) >= 10:
            avg_volumes.append((si, float(np.mean(valid))))

    avg_volumes.sort(key=lambda t: -t[1])
    return [idx for idx, _ in avg_volumes[:n_top]]


def select_pairs(
    close_matrix: np.ndarray,
    coin_indices: list[int],
    end_di: int,
    lookback: int = 60,
    n_pairs: int = 3,
) -> list[tuple[int, int, float]]:
    """Select the top *n_pairs* most correlated pairs from *coin_indices*.

    Returns list of (idx_a, idx_b, correlation).
    """
    if end_di < lookback or len(coin_indices) < 2:
        return []

    start_di = end_di - lookback
    n_coins = len(coin_indices)
    pairs: list[tuple[int, int, float]] = []

    for i in range(n_coins):
        for j in range(i + 1, n_coins):
            si_a = coin_indices[i]
            si_b = coin_indices[j]

            returns_a = close_matrix[si_a, start_di: end_di + 1]
            returns_b = close_matrix[si_b, start_di: end_di + 1]

            # Price returns for correlation
            p_a = returns_a[np.isfinite(returns_a) & np.isfinite(returns_b)]
            p_b = returns_b[np.isfinite(returns_a) & np.isfinite(returns_b)]

            if len(p_a) < 30:
                continue

            ret_a = np.diff(p_a) / p_a[:-1]
            ret_b = np.diff(p_b) / p_b[:-1]

            if len(ret_a) < 20:
                continue

            corr = float(np.corrcoef(ret_a, ret_b)[0, 1])
            if np.isfinite(corr):
                pairs.append((si_a, si_b, abs(corr)))

    pairs.sort(key=lambda t: -t[2])
    return pairs[:n_pairs]


def run_pairs_trading_fold(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    symbols: list[str],
    test_start: int,
    test_end: int,
    n_dates: int,
) -> list[float]:
    """Run pairs trading within a single test window.

    Returns list of daily PnL fractions (PnL / total capital allocated).
    """
    # --- Selection at start of test window ---
    # Top 10 coins by volume (using last 30d of training window)
    coin_indices = pick_top_volume_coins(
        volume_matrix, symbols,
        end_di=test_start, lookback=30, n_top=10,
    )
    if len(coin_indices) < 4:
        return []

    # Pick 3 most correlated pairs using 60d lookback
    pairs = select_pairs(
        close_matrix, coin_indices,
        end_di=test_start, lookback=60, n_pairs=3,
    )
    if len(pairs) < 1:
        return []

    # -- Daily simulation --
    # Track open positions per pair: {pair_key: {
    #   'entry_z': float,
    #   'entry_spread': float,
    #   'short_idx': int,   (symbol index we are shorting)
    #   'long_idx': int,    (symbol index we are longing)
    #   'day_opened': int,  (date index)
    #   'short_entry_price': float,
    #   'long_entry_price': float,
    # }}
    n_pairs_selected = len(pairs)
    positions: dict[str, dict] = {}

    daily_pnl: list[float] = []

    # Allocate equal total capital to each pair
    # Total capital = 1.0 (100%). Each pair gets 1/n_pairs capital.
    # Within each pair, half goes long, half goes short (market neutral).
    capital_per_pair = 1.0 / n_pairs_selected

    window_start = test_start
    window_end = min(test_end, n_dates)

    for di in range(window_start, window_end):
        day_pnl = 0.0

        for pi, (si_a, si_b, _) in enumerate(pairs):
            # Compute spread z-score: log(price_A) - log(price_B)
            lookback_start = max(0, di - 60)
            spread_history: list[float] = []
            for dd in range(lookback_start, di + 1):
                p_a = close_matrix[si_a, dd]
                p_b = close_matrix[si_b, dd]
                if np.isfinite(p_a) and np.isfinite(p_b) and p_a > 0 and p_b > 0:
                    spread_history.append(float(np.log(p_a) - np.log(p_b)))

            if len(spread_history) < 30:
                continue

            spread_arr = np.array(spread_history)
            current_spread = spread_arr[-1]
            mean_spread = float(np.mean(spread_arr[:-1]))
            std_spread = float(np.std(spread_arr[:-1], ddof=1))

            if std_spread <= 0 or not np.isfinite(std_spread):
                continue

            z_score = (current_spread - mean_spread) / std_spread

            pair_key = f"{si_a}_{si_b}"

            # Check if we should OPEN a position
            if pair_key not in positions:
                if abs(z_score) > 2.0:
                    # z > 0: A has outperformed B → short A, long B
                    # z < 0: B has outperformed A → long A, short B
                    if z_score > 0:
                        short_idx, long_idx = si_a, si_b
                    else:
                        short_idx, long_idx = si_b, si_a

                    short_entry = close_matrix[short_idx, di]
                    long_entry = close_matrix[long_idx, di]
                    if not (np.isfinite(short_entry) and np.isfinite(long_entry)
                            and short_entry > 0 and long_entry > 0):
                        continue

                    positions[pair_key] = {
                        "short_idx": short_idx,
                        "long_idx": long_idx,
                        "short_entry": float(short_entry),
                        "long_entry": float(long_entry),
                        "entry_di": di,
                    }
            else:
                # Position IS open — check for EXIT (reversion)
                pos = positions[pair_key]
                exit_trade = False

                if abs(z_score) < 0.5:
                    exit_trade = True
                elif di == window_end - 1:
                    # Force close at end of test window
                    exit_trade = True

                if exit_trade:
                    # Compute PnL for this position
                    short_exit = close_matrix[pos["short_idx"], di]
                    long_exit = close_matrix[pos["long_idx"], di]
                    if (np.isfinite(short_exit) and np.isfinite(long_exit)
                            and short_exit > 0 and long_exit > 0):
                        # Short PnL: start - end (we sold high, buy back low)
                        short_pnl = (pos["short_entry"] - short_exit) / pos["short_entry"]
                        # Long PnL: end - start
                        long_pnl = (long_exit - pos["long_entry"]) / pos["long_entry"]
                        # Equal notional: half capital on each leg
                        pair_pnl = 0.5 * short_pnl + 0.5 * long_pnl
                        # Subtract transaction costs (2 legs entry + 2 legs exit = 4 legs)
                        pair_pnl -= COST_BPS * 4 / 10000
                        day_pnl += pair_pnl * capital_per_pair

                    del positions[pair_key]

        # For still-open positions, mark-to-market daily
        for pair_key, pos in list(positions.items()):
            short_now = close_matrix[pos["short_idx"], di]
            long_now = close_matrix[pos["long_idx"], di]
            if (np.isfinite(short_now) and np.isfinite(long_now)
                    and short_now > 0 and long_now > 0):
                short_pnl = (pos["short_entry"] - short_now) / pos["short_entry"]
                long_pnl = (long_now - pos["long_entry"]) / pos["long_entry"]
                pair_pnl_mtm = 0.5 * short_pnl + 0.5 * long_pnl
                # Only realized PnL counts — so MTM not added to cumulative
                # We only add PnL at exit (realized)
                # But for computing period returns within WFO, we track daily

        daily_pnl.append(day_pnl)

    # Close any remaining positions at end of test window
    # (already handled in the loop above for di == window_end - 1)

    # Aggregate daily PnL into period returns (one per fold)
    # For consistency with the WFO framework, return a single value
    # representing the total return over the fold
    if not daily_pnl:
        return [0.0]

    total_ret = float(np.sum(daily_pnl))
    return [total_ret]


def run_strategy_E(
    close_matrix: np.ndarray,
    volume_matrix: np.ndarray,
    all_dates: list[str],
    symbols: list[str],
    btc_idx: int,
    n_dates: int,
) -> dict | None:
    """WFO-Lite for Strategy E: Pairs trading proxy.
    Returns fold-level returns (each fold's total PnL).
    """
    hp = 63  # average holding period = test window length
    all_period_rets: list[float] = []
    all_btc_rets: list[float] = []

    for fold_idx, test_start, test_end in wfo_folds(n_dates):
        if test_end - test_start < 10:
            continue

        fold_rets = run_pairs_trading_fold(
            close_matrix, volume_matrix, symbols,
            test_start, min(test_end, n_dates), n_dates,
        )

        for r in fold_rets:
            all_period_rets.append(r)

        # BTC return for the fold
        btc_r = btc_benchmark_return(close_matrix, btc_idx, test_start, min(test_end, n_dates))
        all_btc_rets.append(btc_r if btc_r is not None else 0.0)

    if not all_period_rets:
        return None

    metrics = compute_period_metrics(all_period_rets, all_btc_rets, hp)

    # Count how many folds had active trades vs stayed in cash
    active_folds = sum(1 for r in all_period_rets if r != 0.0)
    total_folds = len(all_period_rets) if all_period_rets else 0

    return {
        "holding_days": hp,
        "active_folds": active_folds,
        "total_folds": total_folds,
        **metrics,
    }


# ===================================================================
# Report builder
# ===================================================================

def build_report(results: dict, config: dict) -> dict:
    """Wrap all strategy results into a single report dict."""
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "strategy": "strategy_ensemble",
        "config": config,
        "results": {},
    }

    for name, data in results.items():
        if data is None:
            report["results"][name] = {"error": "No valid results"}
            continue

        summary = {
            "annualized_return": data.get("annualized_return", 0),
            "sharpe": data.get("sharpe", 0),
            "win_rate": data.get("win_rate", 0),
            "outperform_btc_rate": data.get("outperform_btc_rate", 0),
            "max_drawdown": data.get("max_drawdown", 0),
            "n_periods": data.get("n_periods", 0),
        }
        entry = {**data, "summary": summary}
        report["results"][name] = entry

    return report


# ===================================================================
# Ranking table
# ===================================================================

def print_ranking(results: dict) -> None:
    """Print a sorted ranking table of all strategies."""
    rows = []
    for name, data in results.items():
        if data is None or "annualized_return" not in data:
            continue
        rows.append((
            name,
            data.get("annualized_return", 0),
            data.get("sharpe", 0),
            data.get("win_rate", 0),
            data.get("outperform_btc_rate", 0),
            data.get("max_drawdown", 0),
            data.get("n_periods", 0),
        ))

    rows.sort(key=lambda r: -r[1])  # sort by annualized return descending

    print()
    print("=" * 100)
    print(f"  {'Strategy':40s} {'AnnRet':>8s} {'Sharpe':>8s} {'WinRate':>8s} {'OutpBTC':>8s} {'MaxDD':>8s} {'N':>6s}")
    print("=" * 100)
    for name, ann_ret, sharpe, wr, obtc, mdd, n in rows:
        print(f"  {name:40s} {ann_ret:>8.2%} {sharpe:>8.2f} {wr:>8.2%} {obtc:>8.2%} {mdd:>8.2%} {n:>6d}")
    print("=" * 100)


# ===================================================================
# Main
# ===================================================================

def main():
    print("=" * 60)
    print("Strategy Ensemble and Meta-Strategy Analysis")
    print("=" * 60)
    print()
    print(f"WFO-Lite: train={WFO_TRAIN}d, test={WFO_TEST}d, step={WFO_STEP}d")
    print(f"Universe: {len(MAIN_SYMBOLS)} mainstream coins")
    print()

    # ---- Step 1: Data loading ----
    symbols_list = sorted(MAIN_SYMBOLS)
    print("1. Loading data and building matrices...")
    close_matrix, volume_matrix, ret_matrix, all_dates, symbols, btc_idx, n_dates = build_matrices(symbols_list)
    print(f"   {len(symbols)} symbols x {n_dates} days")
    print(f"   Period: {all_dates[0]} to {all_dates[-1]}")

    if btc_idx is None:
        print("ERROR: BTCUSDT not found in symbols")
        sys.exit(1)

    config = {
        "n_symbols": len(symbols),
        "n_dates": n_dates,
        "period": f"{all_dates[0]} to {all_dates[-1]}",
        "cost_bps": COST_BPS,
        "wfo_mode": "WFO-Lite",
        "train_days": WFO_TRAIN,
        "test_days": WFO_TEST,
        "step_days": WFO_STEP,
        "long_pct": LONG_PCT,
        "main_symbols": sorted(MAIN_SYMBOLS),
    }

    # ---- Step 2: Run all 5 strategies ----
    print("\n2. Running Strategy A: Signal Fusion Ensemble...")
    result_A = run_strategy_A(
        close_matrix, volume_matrix, ret_matrix,
        all_dates, symbols, btc_idx, n_dates,
    )
    if result_A:
        print(f"   Ann ret: {result_A['annualized_return']:.2%}  "
              f"Sharpe: {result_A['sharpe']:.2f}  "
              f"WinRate: {result_A['win_rate']:.2%}  "
              f"N: {result_A['n_periods']}")
    else:
        print("   No valid results")

    print("\n3. Running Strategy B: Adaptive Switch...")
    result_B = run_strategy_B(
        close_matrix, ret_matrix,
        all_dates, symbols, btc_idx, n_dates,
    )
    if result_B:
        print(f"   Ann ret: {result_B['annualized_return']:.2%}  "
              f"Sharpe: {result_B['sharpe']:.2f}  "
              f"WinRate: {result_B['win_rate']:.2%}  "
              f"N: {result_B['n_periods']}")
        usage = result_B.get("strategy_usage", {})
        print(f"   Strategy usage: {usage}")
    else:
        print("   No valid results")

    print("\n4. Running Strategy C: Vol-Adjusted Position Sizing...")
    result_C = run_strategy_C(
        close_matrix, ret_matrix,
        all_dates, symbols, btc_idx, n_dates,
    )
    if result_C:
        print(f"   Ann ret: {result_C['annualized_return']:.2%}  "
              f"Sharpe: {result_C['sharpe']:.2f}  "
              f"WinRate: {result_C['win_rate']:.2%}  "
              f"N: {result_C['n_periods']}")
        print(f"   Cash time fraction: {result_C.get('cash_time_fraction', 0):.2%}  "
              f"(cash periods: {result_C.get('cash_periods', 0)} / "
              f"total: {result_C.get('total_periods', 0)})")
    else:
        print("   No valid results")

    print("\n5. Running Strategy D: Multi-Strategy Equal-Weight...")
    result_D = run_strategy_D(
        close_matrix, ret_matrix,
        all_dates, symbols, btc_idx, n_dates,
    )
    if result_D:
        print(f"   Ann ret: {result_D['annualized_return']:.2%}  "
              f"Sharpe: {result_D['sharpe']:.2f}  "
              f"WinRate: {result_D['win_rate']:.2%}  "
              f"N: {result_D['n_periods']}")
    else:
        print("   No valid results")

    print("\n6. Running Strategy E: Pairs Trading Proxy...")
    result_E = run_strategy_E(
        close_matrix, volume_matrix,
        all_dates, symbols, btc_idx, n_dates,
    )
    if result_E:
        print(f"   Ann ret: {result_E['annualized_return']:.2%}  "
              f"Sharpe: {result_E['sharpe']:.2f}  "
              f"WinRate: {result_E['win_rate']:.2%}  "
              f"Active folds: {result_E.get('active_folds', 0)} / "
              f"{result_E.get('total_folds', 0)}")
    else:
        print("   No valid results")

    # ---- Step 7: Build and write report ----
    print("\n7. Building report...")
    results = {
        "strategy_A_signal_fusion": result_A,
        "strategy_B_adaptive_switch": result_B,
        "strategy_C_vol_sizing": result_C,
        "strategy_D_multi_strategy_eq_weight": result_D,
        "strategy_E_pairs_trading": result_E,
    }

    report = build_report(results, config)

    os.makedirs(os.path.dirname(OUTPUT_PATH) or ".", exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"   Report: {OUTPUT_PATH}")

    # ---- Ranking ----
    print_ranking(results)

    # ---- Best strategy ----
    best_name = None
    best_val = -float("inf")
    for name, data in results.items():
        if data and "annualized_return" in data and data["annualized_return"] is not None:
            if data["annualized_return"] > best_val:
                best_val = data["annualized_return"]
                best_name = name

    if best_name:
        print(f"\nBest strategy by annualized return: {best_name}")
    print("\nDone.")


if __name__ == "__main__":
    main()
