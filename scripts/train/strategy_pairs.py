#!/usr/bin/env python3
"""
Pairs trading strategies backtest for 24 mainstream coins.

Four strategies:

  A: Top correlated pairs — compute 60d rolling pairwise correlations, pick
     the 5 most correlated pairs.  When the spread (log price ratio) of a
     selected pair exceeds 2 sigma from its rolling mean, enter a dollar-neutral
     pair trade (short winner / long loser).  Close when the spread reverts to
     within 1 sigma.

  B: Sector pairs (L1–L1, DeFi–DeFi) — within each sector, trade *all* pairs
     when the spread widens.  L1: BTC, ETH, SOL, ADA, AVAX, NEAR.
     DeFi: UNI, AAVE, MKR, INJ, LINK.  Same z-score entry/exit as A but
     selectively within sectors — more fundamental than purely statistical.

  C: BTC-ETH ratio mean reversion — ETH/BTC ratio is well-known to mean-revert.
     When the ratio > 2 sigma above its 60d MA, short ETH / long BTC.
     When the ratio < 2 sigma below, long ETH / short BTC.
     Very low cost (2 instruments, 1x each).

  D: Cross-exchange premium (funding-rate sentiment) — use Binance 8-hourly
     funding rate data as a sentiment indicator.  When funding > 0.05 % (extremely
     bullish), short futures; when funding < −0.05 % (extremely bearish), long.
     Contrarian bet that extreme funding reverts.

WFO: train=365d, test=63d, step=21d
Output: data/research/strategy_pairs_report.json

No secrets. Read-only on ZIP files.
"""

import json
import os
import zipfile
from datetime import datetime, timezone

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
FR_DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/um-all-usdt-fundingRate/um/fundingRate"
)
PROJECT_ROOT = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
)
OUTPUT_PATH = os.path.join(
    PROJECT_ROOT, "data", "research", "strategy_pairs_report.json"
)

COST_BPS = 15
COST_DEC = COST_BPS / 10_000  # 0.0015 fractional cost per leg

# 24 mainstream coins (verified available in data directory)
# INJUSDT is included for the DeFi sector (Strategy B)
SYMBOLS_24 = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "SOLUSDT",
    "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT", "INJUSDT", "UNIUSDT",
    "LTCUSDT", "BCHUSDT", "ATOMUSDT", "TRXUSDT", "FILUSDT", "NEARUSDT",
    "APTUSDT", "SUIUSDT", "ARBUSDT", "OPUSDT", "AAVEUSDT", "MKRUSDT",
]

# WFO parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

# --- Strategy A ---
CORR_WINDOW = 60       # lookback for pairwise correlation
SPREAD_WINDOW = 60     # lookback for spread z-score rolling stats
Z_ENTRY = 2.0          # z-score entry threshold
Z_EXIT = 1.0           # z-score exit threshold (reversion)
MAX_PAIRS_A = 5        # number of top correlated pairs selected

# --- Strategy B : Sector definitions ---
L1_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "NEARUSDT"]
DEFI_SYMBOLS = ["UNIUSDT", "AAVEUSDT", "MKRUSDT", "INJUSDT", "LINKUSDT"]

# --- Strategy C ---
RATIO_WINDOW = 60  # rolling window for ETH/BTC ratio mean and std

# --- Strategy D : Funding rate ---
FUNDING_ENTRY = 0.0005   # 0.05 % threshold to enter
FUNDING_EXIT = 0.0001    # 0.01 % threshold to exit


# ---------------------------------------------------------------------------
# Data loading  (klines)
# ---------------------------------------------------------------------------

def _parse_ts(ts_str: str) -> int:
    """Parse Binance kline timestamp (ms or us) into milliseconds."""
    v = int(ts_str)
    return v // 1000 if v > 1e15 else v


def load_closes(symbol: str) -> dict:
    """Load daily close prices from monthly ZIP files.

    Returns {YYYY-MM-DD: close_price}.
    """
    closes: dict[str, float] = {}
    kdir = os.path.join(DATA_ROOT, symbol, "1d")
    if not os.path.isdir(kdir):
        return closes
    for fname in sorted(os.listdir(kdir)):
        if not fname.endswith(".zip"):
            continue
        fpath = os.path.join(kdir, fname)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode("utf-8", errors="replace")
                for line in text.strip().split("\n"):
                    line = line.strip()
                    if not line:
                        continue
                    cols = line.split(",")
                    if len(cols) < 5:
                        continue
                    try:
                        ts_ms = _parse_ts(cols[0])
                        close = float(cols[4])
                        ds = datetime.fromtimestamp(
                            ts_ms / 1000, tz=timezone.utc
                        ).strftime("%Y-%m-%d")
                        closes[ds] = close
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue
    return closes


def daily_returns(closes: dict) -> dict:
    """Convert {date: close} to {date: daily_return}."""
    dates = sorted(closes)
    rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        p, c = dates[i - 1], dates[i]
        if closes[p] > 0:
            rets[c] = (closes[c] - closes[p]) / closes[p]
    return rets


# ---------------------------------------------------------------------------
# Data loading  (funding rates)
# ---------------------------------------------------------------------------

def load_funding_rates(symbol: str) -> dict:
    """Load 8-hourly funding rate data from Binance monthly ZIP files.

    Returns {YYYY-MM-DD: average_daily_funding_rate}.
    """
    rates: dict[str, list[float]] = {}
    fr_dir = os.path.join(FR_DATA_ROOT, symbol)
    if not os.path.isdir(fr_dir):
        return {d: 0.0 for d in rates}

    for fname in sorted(os.listdir(fr_dir)):
        if not fname.endswith(".zip"):
            continue
        fpath = os.path.join(fr_dir, fname)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode("utf-8", errors="replace")
                lines = text.strip().split("\n")
                # first line is header
                for line in lines[1:]:
                    line = line.strip()
                    if not line:
                        continue
                    cols = line.split(",")
                    if len(cols) < 3:
                        continue
                    try:
                        ts_ms = int(cols[0])
                        rate = float(cols[2])
                        ds = datetime.fromtimestamp(
                            ts_ms / 1000, tz=timezone.utc
                        ).strftime("%Y-%m-%d")
                        rates.setdefault(ds, []).append(rate)
                    except (ValueError, IndexError):
                        continue
        except Exception:
            continue

    # Aggregate to daily mean
    daily: dict[str, float] = {}
    for ds, vals in rates.items():
        daily[ds] = float(np.mean(vals))
    return daily


# ---------------------------------------------------------------------------
# Strategy helpers
# ---------------------------------------------------------------------------

def pair_correlation(
    sym_a: str, sym_b: str,
    returns: dict, all_dates: list,
    date: str, window: int,
) -> float | None:
    """Compute Pearson correlation of daily returns for a pair over a rolling window."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window:
        return None

    vals_a: list[float] = []
    vals_b: list[float] = []
    for d in all_dates[idx - window: idx]:
        ra = returns.get(sym_a, {}).get(d)
        rb = returns.get(sym_b, {}).get(d)
        if ra is not None and rb is not None:
            vals_a.append(ra)
            vals_b.append(rb)

    if len(vals_a) < window // 2:
        return None

    corr = np.corrcoef(vals_a, vals_b)[0, 1]
    return float(corr) if not np.isnan(corr) else None


def spread_zscore(
    sym_a: str, sym_b: str,
    closes: dict, all_dates: list,
    date: str, window: int,
) -> float | None:
    """Compute z-score of the log-price spread for a pair at *date*.

    z = (spread[t] - mean(spread[t−w : t])) / std(spread[t−w : t])
    """
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window:
        return None

    spreads: list[float] = []
    for i in range(idx - window, idx + 1):
        d = all_dates[i]
        pa = closes.get(sym_a, {}).get(d)
        pb = closes.get(sym_b, {}).get(d)
        if pa is not None and pb is not None and pa > 0 and pb > 0:
            spreads.append(np.log(pa / pb))

    if len(spreads) < window // 2:
        return None

    lookback = spreads[:-1]  # exclude current day
    current = spreads[-1]
    mu = float(np.mean(lookback))
    sigma = float(np.std(lookback, ddof=1))
    if sigma <= 0:
        return 0.0
    return (current - mu) / sigma


def top_correlated_pairs(
    symbols: list, returns: dict, all_dates: list,
    date: str, corr_window: int, n: int,
) -> list[tuple[str, str]]:
    """Return the *n* most highly correlated symbol pairs."""
    scores: list[tuple[float, str, str]] = []
    for i in range(len(symbols)):
        for j in range(i + 1, len(symbols)):
            a, b = symbols[i], symbols[j]
            corr = pair_correlation(a, b, returns, all_dates, date, corr_window)
            if corr is not None and not np.isnan(corr):
                scores.append((abs(corr), a, b))

    scores.sort(key=lambda x: x[0], reverse=True)
    return [(a, b) for _, a, b in scores[:n]]


def sector_pairs(symbols_a: list, symbols_b: list | None = None) -> list[tuple[str, str]]:
    """Generate all intra-sector pairs.

    If symbols_b is None, generate all pairs within symbols_a.
    If symbols_b is given, generate all cross pairs between the two lists.
    """
    if symbols_b is None:
        pairs: list[tuple[str, str]] = []
        for i in range(len(symbols_a)):
            for j in range(i + 1, len(symbols_a)):
                pairs.append((symbols_a[i], symbols_a[j]))
        return pairs
    return [(a, b) for a in symbols_a for b in symbols_b]


def rolling_z_score(values: list[float], window: int) -> np.ndarray:
    """Compute rolling z-score for a 1-D array."""
    arr = np.array(values, dtype=float)
    result = np.full_like(arr, np.nan, dtype=float)
    if len(arr) < window + 1:
        return result
    for i in range(window, len(arr)):
        seg = arr[i - window: i]
        mu = np.mean(seg)
        sigma = np.std(seg, ddof=1)
        if sigma > 0:
            result[i] = (arr[i] - mu) / sigma
        else:
            result[i] = 0.0
    return result


# ---------------------------------------------------------------------------
# Performance metrics
# ---------------------------------------------------------------------------

def _max_drawdown(returns_series: np.ndarray) -> float:
    """Maximum peak-to-trough drawdown from a daily return series."""
    if len(returns_series) == 0:
        return 0.0
    cum = np.cumprod(1 + returns_series)
    peak = np.maximum.accumulate(cum)
    dd = (cum - peak) / peak
    return float(np.min(dd))


def fold_metrics(fold_id: int, test_dates: list, daily_rets: list) -> dict:
    """Compute performance metrics for one WFO fold."""
    if not daily_rets:
        return {
            "fold_id": fold_id,
            "test_range": f"{test_dates[0]} ~ {test_dates[-1]}",
            "n_days": 0,
            "error": "no_daily_returns",
        }
    rets = np.array(daily_rets, dtype=float)
    n = len(rets)
    total_ret = float(np.prod(1 + rets) - 1)
    ann_ret = float(np.mean(rets) * 252)
    ann_vol = float(np.std(rets, ddof=1) * np.sqrt(252)) if n > 1 else 0.0
    sharpe = ann_ret / ann_vol if ann_vol > 0 else 0.0
    win_rate = float(np.mean(rets > 0))
    mdd = _max_drawdown(rets)
    return {
        "fold_id": fold_id,
        "test_range": f"{test_dates[0]} ~ {test_dates[-1]}",
        "n_days": n,
        "total_return": round(total_ret, 6),
        "annualized_return": round(ann_ret, 6),
        "annualized_vol": round(ann_vol, 6),
        "sharpe": round(sharpe, 4),
        "win_rate": round(win_rate, 4),
        "max_drawdown": round(mdd, 6),
    }


def aggregate_folds(folds: list[dict]) -> dict:
    """Aggregate multiple fold results into a strategy summary."""
    valid = [f for f in folds if "error" not in f]
    if not valid:
        return {
            "fold_count": 0,
            "n_days": 0,
            "mean_total_return": 0.0,
            "std_total_return": 0.0,
            "mean_annualized_return": 0.0,
            "mean_sharpe": 0.0,
            "std_sharpe": 0.0,
            "mean_win_rate": 0.0,
            "mean_max_drawdown": 0.0,
            "pass_rate": 0.0,
        }

    sharpes = np.array([f["sharpe"] for f in valid])
    total_rets = np.array([f["total_return"] for f in valid])
    ann_rets = np.array([f["annualized_return"] for f in valid])
    win_rates = np.array([f["win_rate"] for f in valid])
    mdd = np.array([f["max_drawdown"] for f in valid])
    n_days = np.array([f["n_days"] for f in valid])

    return {
        "fold_count": len(valid),
        "n_days": int(np.sum(n_days)),
        "mean_total_return": round(float(np.mean(total_rets)), 6),
        "std_total_return": (
            round(float(np.std(total_rets, ddof=1)), 6) if len(total_rets) > 1 else 0.0
        ),
        "mean_annualized_return": round(float(np.mean(ann_rets)), 6),
        "mean_sharpe": round(float(np.mean(sharpes)), 4),
        "std_sharpe": (
            round(float(np.std(sharpes, ddof=1)), 4) if len(sharpes) > 1 else 0.0
        ),
        "mean_win_rate": round(float(np.mean(win_rates)), 4),
        "mean_max_drawdown": round(float(np.mean(mdd)), 6),
        "pass_rate": round(float(np.mean(total_rets > 0)), 4),
    }


# ---------------------------------------------------------------------------
# WFO runner
# ---------------------------------------------------------------------------

def _rebalance_dates(all_dates: list, test_start: int, test_end: int,
                     step: int) -> list:
    """Return a list of rebalance dates within the test window."""
    r = list(range(test_start, test_end, step))
    return [all_dates[i] for i in r if i < test_end]


def run_wfo(all_dates: list, strategy_func, data_bundle: dict,
            label: str = "") -> list[dict]:
    """Walk-forward optimisation for a rule-based pairs strategy.

    Parameters
    ----------
    all_dates : sorted list of date strings for the full history.
    strategy_func : callable(all_dates, test_start_idx, test_end_idx, bundle)
        -> list[float] of daily portfolio returns in the test window.
    data_bundle : dict passed to strategy_func.

    Returns
    -------
    list of fold result dicts.
    """
    folds: list[dict] = []
    fold_id = 0
    i = 0
    while i + TRAIN_DAYS + TEST_DAYS <= len(all_dates):
        test_start = i + TRAIN_DAYS
        test_end = test_start + TEST_DAYS
        test_range = all_dates[test_start:test_end]

        if len(test_range) < 10:
            i += STEP_DAYS
            continue

        try:
            daily = strategy_func(all_dates, test_start, test_end, data_bundle)
        except Exception as e:
            folds.append({
                "fold_id": fold_id,
                "test_range": f"{test_range[0]} ~ {test_range[-1]}",
                "error": str(e),
            })
            i += STEP_DAYS
            fold_id += 1
            continue

        fm = fold_metrics(fold_id, test_range, daily)
        folds.append(fm)

        if fold_id % 5 == 0 and label:
            s_val = fm.get("sharpe", "ERR")
            if isinstance(s_val, str):
                s_str = f"{s_val:>8}"
            else:
                s_str = f"{s_val:>8.4f}"
            print(f"    {label} fold {fold_id}: sharpe={s_str}  "
                  f"ret={fm.get('total_return', 0):>8.4f}  "
                  f"win={fm.get('win_rate', 0):>6.2%}")

        i += STEP_DAYS
        fold_id += 1

    return folds


# ===================================================================
# Strategy A : Top Correlated Pairs
# ===================================================================
# For each pair of coins, compute 60d correlation.  Pick the 5 most highly
# correlated pairs.  When the log-price spread > 2 sigma (rolling 60d), enter
# a dollar-neutral pair trade: short the winner, long the loser.
# Close when the spread reverts to within 1 sigma.
# Re-evaluate the top 5 pairs every 21 trading days.

def strategy_a_top_correlated_pairs(
    all_dates: list, test_start: int, test_end: int, bundle: dict,
) -> list[float]:
    returns = bundle["all_returns"]
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]

    test_dates = all_dates[test_start:test_end]
    daily_rets = [0.0] * len(test_dates)

    # Pre‑compute the spread z‑score for every possible pair from the full history.
    # We will slice on the fly.
    steps = list(range(test_start, test_end, 21))  # rebalance indices
    if not steps:
        steps = [test_start]

    ret_map: dict[str, float] = {}
    # positions: (sym_a, sym_b) -> {"direction": "short_a_long_b"|"long_a_short_b"}
    positions: dict[tuple[str, str], str] = {}

    # One rebalance before the first test day to select initial pairs.
    # We use a helper to select pairs at a given date.
    def _select_pairs(ref_date: str) -> list[tuple[str, str]]:
        return top_correlated_pairs(symbols, returns, all_dates, ref_date,
                                     CORR_WINDOW, MAX_PAIRS_A)

    # Pre‑initialise: select pairs using the day before test start
    if test_start > 0:
        current_pairs = _select_pairs(all_dates[test_start - 1])
    else:
        current_pairs = _select_pairs(all_dates[test_start])

    # Track the latest rebalance date that has passed
    next_rebal_idx = test_start + 21  # first rebalance within test window

    for i, d in enumerate(test_dates):
        idx = all_dates.index(d)

        # Re‑select pairs every 21 days
        if idx >= next_rebal_idx and next_rebal_idx < test_end:
            # Close all current positions (forced turnover)
            if positions:
                for pk in list(positions.keys()):
                    ret_map[d] = ret_map.get(d, 0.0) - 2 * COST_DEC / MAX_PAIRS_A
                    del positions[pk]
            ref_date = all_dates[next_rebal_idx - 1] if next_rebal_idx > 0 else d
            current_pairs = _select_pairs(ref_date)
            next_rebal_idx += 21

        # --- P&L from active positions ---
        port_ret = 0.0
        if positions:
            pair_rets: list[float] = []
            to_exit: list[tuple[str, str]] = []
            for pair_key, direction in list(positions.items()):
                a, b = pair_key
                ra = returns.get(a, {}).get(d, 0.0)
                rb = returns.get(b, {}).get(d, 0.0)
                if direction == "long_a_short_b":
                    pair_rets.append(ra - rb)
                else:
                    pair_rets.append(rb - ra)

                # Check exit: z‑score reverted within 1 sigma
                z = spread_zscore(a, b, closes, all_dates, d, SPREAD_WINDOW)
                if z is not None and abs(z) < Z_EXIT:
                    port_ret -= 2 * COST_DEC / MAX_PAIRS_A
                    to_exit.append(pair_key)

            for pk in to_exit:
                del positions[pk]

            if pair_rets:
                port_ret += sum(pair_rets) / MAX_PAIRS_A

        # --- New entries ---
        for pair in current_pairs:
            if pair in positions:
                continue
            z = spread_zscore(pair[0], pair[1], closes, all_dates, d, SPREAD_WINDOW)
            if z is None:
                continue
            if z > Z_ENTRY:
                # sym_a outperformed ⟹ short a, long b
                positions[pair] = "short_a_long_b"
                port_ret -= 2 * COST_DEC / MAX_PAIRS_A
            elif z < -Z_ENTRY:
                positions[pair] = "long_a_short_b"
                port_ret -= 2 * COST_DEC / MAX_PAIRS_A

        ret_map[d] = port_ret

    return [ret_map.get(d, 0.0) for d in test_dates]


# ===================================================================
# Strategy B : Sector pairs (L1–L1, DeFi–DeFi)
# ===================================================================
# L1: BTC, ETH, SOL, ADA, AVAX, NEAR  → 6 coins → 15 pairs
# DeFi: UNI, AAVE, MKR, INJ, LINK      → 5 coins → 10 pairs
# Total: 25 pairs.  Apply the same z-score pair-trading logic but only
# within sectors.  This is more fundamental than purely statistical.

def strategy_b_sector_pairs(
    all_dates: list, test_start: int, test_end: int, bundle: dict,
) -> list[float]:
    closes = bundle["all_closes"]
    returns = bundle["all_returns"]
    symbols = bundle["symbols"]

    # Build all intra‑sector pairs
    l1_in = [s for s in L1_SYMBOLS if s in symbols]
    defi_in = [s for s in DEFI_SYMBOLS if s in symbols]

    all_sector_pairs = sector_pairs(l1_in) + sector_pairs(defi_in)
    n_pairs = len(all_sector_pairs)
    if n_pairs == 0:
        return []

    test_dates = all_dates[test_start:test_end]
    daily_rets = [0.0] * len(test_dates)

    ret_map: dict[str, float] = {}
    positions: dict[tuple[str, str], str] = {}

    for i, d in enumerate(test_dates):
        port_ret = 0.0

        # --- P&L from active positions ---
        if positions:
            pair_rets: list[float] = []
            to_exit: list[tuple[str, str]] = []
            for pair_key, direction in list(positions.items()):
                a, b = pair_key
                ra = returns.get(a, {}).get(d, 0.0)
                rb = returns.get(b, {}).get(d, 0.0)
                if direction == "long_a_short_b":
                    pair_rets.append(ra - rb)
                else:
                    pair_rets.append(rb - ra)

                z = spread_zscore(a, b, closes, all_dates, d, SPREAD_WINDOW)
                if z is not None and abs(z) < Z_EXIT:
                    port_ret -= 2 * COST_DEC / n_pairs
                    to_exit.append(pair_key)

            for pk in to_exit:
                del positions[pk]

            if pair_rets:
                port_ret += sum(pair_rets) / n_pairs

        # --- New entries ---
        for pair in all_sector_pairs:
            if pair in positions:
                continue
            z = spread_zscore(pair[0], pair[1], closes, all_dates, d, SPREAD_WINDOW)
            if z is None:
                continue
            if z > Z_ENTRY:
                positions[pair] = "short_a_long_b"
                port_ret -= 2 * COST_DEC / n_pairs
            elif z < -Z_ENTRY:
                positions[pair] = "long_a_short_b"
                port_ret -= 2 * COST_DEC / n_pairs

        ret_map[d] = port_ret

    return [ret_map.get(d, 0.0) for d in test_dates]


# ===================================================================
# Strategy C : BTC-ETH ratio mean reversion
# ===================================================================
# ETH/BTC ratio is well-known to mean-revert.  When the ratio > 2 sigma
# above its 60d MA, short ETH / long BTC.  When the ratio < 2 sigma below,
# long ETH / short BTC.  Very low cost (2 instruments, 1x each).

def strategy_c_btc_eth_ratio(
    all_dates: list, test_start: int, test_end: int, bundle: dict,
) -> list[float]:
    closes = bundle["all_closes"]
    rets = bundle["all_returns"]
    sym_a, sym_b = "ETHUSDT", "BTCUSDT"

    test_dates = all_dates[test_start:test_end]

    # Build the ratio time series: ETH / BTC
    ratio_list: list[float] = []
    valid_dates: list[str] = []
    for d in all_dates[:test_end]:
        e = closes.get(sym_a, {}).get(d)
        b = closes.get(sym_b, {}).get(d)
        if e is not None and b is not None and b > 0:
            ratio_list.append(e / b)
            valid_dates.append(d)

    # Map ratio value to each valid date
    ratio_by_date: dict[str, float] = dict(zip(valid_dates, ratio_list))
    ratio_arr = np.array(ratio_list, dtype=float)
    # Rolling z-score for the ratio
    z_scores = rolling_z_score(ratio_list, RATIO_WINDOW)

    ret_map: dict[str, float] = {}
    in_position: str | None = None  # "short_eth_long_btc" | "long_eth_short_btc" | None

    for d in test_dates:
        if d not in ratio_by_date:
            port_ret = 0.0
        else:
            port_ret = 0.0
            idx = valid_dates.index(d)

            # Map returns for the two legs on this day
            reth = rets.get(sym_a, {}).get(d, 0.0)
            rbtc = rets.get(sym_b, {}).get(d, 0.0)

            if in_position is not None:
                # Daily P&L
                if in_position == "short_eth_long_btc":
                    port_ret = -reth + rbtc
                else:
                    port_ret = reth - rbtc

                # Check exit: z-score reverted
                z = z_scores[idx]
                if not np.isnan(z) and abs(z) < Z_EXIT:
                    # Close: 2 legs cost
                    port_ret -= 2 * COST_DEC
                    in_position = None

            if in_position is None:
                z = z_scores[idx]
                if not np.isnan(z):
                    if z > Z_ENTRY:
                        # ETH overvalued → short ETH / long BTC
                        in_position = "short_eth_long_btc"
                        port_ret -= 2 * COST_DEC  # entry cost (2 legs)
                    elif z < -Z_ENTRY:
                        in_position = "long_eth_short_btc"
                        port_ret -= 2 * COST_DEC

        ret_map[d] = port_ret

    return [ret_map.get(d, 0.0) for d in test_dates]


# Also keep a reference to the bundle's returns for access inside strategy_c


# ===================================================================
# Strategy D : Cross-exchange premium (funding-rate sentiment)
# ===================================================================
# Use Binance 8-hourly funding rate data as a sentiment indicator.
# When funding > 0.05 % (extremely bullish), short (contrarian).
# When funding < -0.05 % (extremely bearish), long.
# Hold until funding reverts within ±0.01 %.

def strategy_d_funding_premium(
    all_dates: list, test_start: int, test_end: int, bundle: dict,
) -> list[float]:
    returns = bundle["all_returns"]
    funding_rates = bundle.get("funding_rates", {})
    symbols = [s for s in bundle["symbols"] if s in funding_rates]

    n_coins = max(1, len(symbols))
    test_dates = all_dates[test_start:test_end]

    ret_map: dict[str, float] = {}
    # active_positions[sym] = "long" | "short"
    active_positions: dict[str, str] = {}

    for d in test_dates:
        port_ret = 0.0
        to_exit: list[str] = []

        # --- P&L from active positions ---
        if active_positions:
            pos_rets: list[float] = []
            for sym, direction in list(active_positions.items()):
                r = returns.get(sym, {}).get(d, 0.0)
                ret_i = -r if direction == "short" else r
                pos_rets.append(ret_i)

                # Check exit via funding rate
                fr = funding_rates.get(sym, {}).get(d)
                if fr is not None and abs(fr) < FUNDING_EXIT:
                    port_ret -= 2 * COST_DEC / n_coins
                    to_exit.append(sym)

            for sym in to_exit:
                del active_positions[sym]

            if pos_rets:
                port_ret += sum(pos_rets) / n_coins

        # --- New entries ---
        for sym in symbols:
            if sym in active_positions:
                continue
            fr = funding_rates.get(sym, {}).get(d)
            if fr is None:
                continue
            if fr > FUNDING_ENTRY:
                # Extremely positive funding → short
                active_positions[sym] = "short"
                port_ret -= 2 * COST_DEC / n_coins
            elif fr < -FUNDING_ENTRY:
                active_positions[sym] = "long"
                port_ret -= 2 * COST_DEC / n_coins

        ret_map[d] = port_ret

    return [ret_map.get(d, 0.0) for d in test_dates]


# ===================================================================
# Equal-weight baseline
# ===================================================================

def strategy_equal_weight(all_dates: list, test_start: int, test_end: int,
                          bundle: dict) -> list[float]:
    """Equal-weight all coins, no rebalance cost (naive baseline)."""
    rets = bundle["all_returns"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    for d in all_dates[test_start:test_end]:
        today = [rets[sym].get(d, 0.0) for sym in symbols
                 if d in rets[sym]]
        ret_map[d] = float(np.mean(today)) if today else 0.0

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Main
# ===================================================================

def main() -> None:
    print("=" * 66)
    print("  Pairs Trading Strategy Backtest")
    print("=" * 66)

    # ---- 1. Load spot data --------------------------------------------
    print("\n[1/7] Loading daily OHLCV for 24 mainstream coins...")
    all_closes: dict[str, dict] = {}
    all_returns: dict[str, dict] = {}
    loaded = 0
    missing: list[str] = []
    for sym in SYMBOLS_24:
        c = load_closes(sym)
        if c and len(c) > 100:
            all_closes[sym] = c
            all_returns[sym] = daily_returns(c)
            loaded += 1
        else:
            missing.append(sym)

    symbols = [s for s in SYMBOLS_24 if s in all_closes]
    print(f"  Loaded {loaded}/{len(SYMBOLS_24)} symbols")
    if missing:
        print(f"  Missing: {missing}")

    all_dates = sorted(set(d for c in all_closes.values() for d in c))
    print(f"  Date range: {all_dates[0]} -> {all_dates[-1]}  "
          f"({len(all_dates)} trading days)")

    # ---- 2. Load funding rate data ------------------------------------
    print("\n[2/7] Loading Binance funding rate data...")
    fr_loaded = 0
    funding_rates: dict[str, dict] = {}
    for sym in symbols:
        fr = load_funding_rates(sym)
        if fr and len(fr) > 30:
            funding_rates[sym] = fr
            fr_loaded += 1
    print(f"  Loaded funding rates for {fr_loaded}/{len(symbols)} symbols")

    # ---- 3. Shared data bundle ----------------------------------------
    base_bundle = {
        "all_returns": all_returns,
        "all_closes": all_closes,
        "symbols": symbols,
        "funding_rates": funding_rates,
    }

    # ---- 4. Baseline (equal-weight) -----------------------------------
    print("\n[3/7] Baseline: Equal-Weight All Coins")
    baseline_folds = run_wfo(all_dates, strategy_equal_weight, base_bundle,
                              label="EW")
    baseline_summary = aggregate_folds(baseline_folds)
    print(f"  -> {baseline_summary['fold_count']} folds, "
          f"mean_sharpe={baseline_summary['mean_sharpe']:.4f}, "
          f"win_rate={baseline_summary['mean_win_rate']:.2%}, "
          f"pass_rate={baseline_summary['pass_rate']:.0%}")

    # ---- 5. Strategy A : Top Correlated Pairs -------------------------
    print("\n[4/7] Strategy A: Top Correlated Pairs")
    a_folds = run_wfo(all_dates, strategy_a_top_correlated_pairs, base_bundle,
                       label="A-PAIRS")
    a_summary = aggregate_folds(a_folds)
    print(f"  -> {a_summary['fold_count']} folds, "
          f"mean_sharpe={a_summary['mean_sharpe']:.4f}, "
          f"win_rate={a_summary['mean_win_rate']:.2%}, "
          f"pass_rate={a_summary['pass_rate']:.0%}")

    # ---- 6. Strategy B : Sector Pairs ---------------------------------
    print("\n[5/7] Strategy B: Sector Pairs (L1-L1, DeFi-DeFi)")
    b_folds = run_wfo(all_dates, strategy_b_sector_pairs, base_bundle,
                       label="B-SECTOR")
    b_summary = aggregate_folds(b_folds)
    print(f"  -> {b_summary['fold_count']} folds, "
          f"mean_sharpe={b_summary['mean_sharpe']:.4f}, "
          f"win_rate={b_summary['mean_win_rate']:.2%}, "
          f"pass_rate={b_summary['pass_rate']:.0%}")

    # ---- 7. Strategy C : BTC-ETH Ratio Mean Reversion -----------------
    print("\n[6/7] Strategy C: BTC-ETH Ratio Mean Reversion")
    c_folds = run_wfo(all_dates, strategy_c_btc_eth_ratio, base_bundle,
                       label="C-BTCETH")
    c_summary = aggregate_folds(c_folds)
    print(f"  -> {c_summary['fold_count']} folds, "
          f"mean_sharpe={c_summary['mean_sharpe']:.4f}, "
          f"win_rate={c_summary['mean_win_rate']:.2%}, "
          f"pass_rate={c_summary['pass_rate']:.0%}")

    # ---- 8. Strategy D : Funding Premium ------------------------------
    print("\n[7/7] Strategy D: Funding Premium (Contrarian)")
    d_folds = run_wfo(all_dates, strategy_d_funding_premium, base_bundle,
                       label="D-FUND")
    d_summary = aggregate_folds(d_folds)
    print(f"  -> {d_summary['fold_count']} folds, "
          f"mean_sharpe={d_summary['mean_sharpe']:.4f}, "
          f"win_rate={d_summary['mean_win_rate']:.2%}, "
          f"pass_rate={d_summary['pass_rate']:.0%}")

    # ---- 9. Build report ----------------------------------------------
    report: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "strategy": "strategy_pairs",
        "config": {
            "symbols": symbols,
            "n_symbols": len(symbols),
            "train_days": TRAIN_DAYS,
            "test_days": TEST_DAYS,
            "step_days": STEP_DAYS,
            "cost_bps": COST_BPS,
            "period": f"{all_dates[0]} to {all_dates[-1]}",
            "strategy_params": {
                "A_top_correlated_pairs": {
                    "corr_window": CORR_WINDOW,
                    "spread_window": SPREAD_WINDOW,
                    "z_entry": Z_ENTRY,
                    "z_exit": Z_EXIT,
                    "max_pairs": MAX_PAIRS_A,
                    "rebalance_days": 21,
                },
                "B_sector_pairs": {
                    "sectors": {
                        "L1": L1_SYMBOLS,
                        "DeFi": DEFI_SYMBOLS,
                    },
                    "spread_window": SPREAD_WINDOW,
                    "z_entry": Z_ENTRY,
                    "z_exit": Z_EXIT,
                },
                "C_btc_eth_ratio": {
                    "ratio_window": RATIO_WINDOW,
                    "z_entry": Z_ENTRY,
                    "z_exit": Z_EXIT,
                    "pair": ["ETHUSDT", "BTCUSDT"],
                },
                "D_funding_premium": {
                    "funding_entry": FUNDING_ENTRY,
                    "funding_exit": FUNDING_EXIT,
                    "data_source": "Binance um fundingRate (8-hourly, aggregated daily)",
                },
            },
        },
        "baseline_equal_weight": {
            "description": "Equal-weight all 24 coins, no rebalance cost.",
            "folds": baseline_folds,
            "summary": baseline_summary,
        },
        "strategy_a_top_correlated_pairs": {
            "description": (
                "Select top 5 correlated pairs by 60d pairwise correlation. "
                "When log-price spread z-score > 2, enter dollar-neutral pair "
                "trade (short winner / long loser). Exit when |z| < 1. "
                "Pairs re-selected every 21 days. Cost: 2-leg entry + 2-leg exit."
            ),
            "folds": a_folds,
            "summary": a_summary,
        },
        "strategy_b_sector_pairs": {
            "description": (
                "Intra-sector pairs trading. L1 (6 coins, 15 pairs): BTC/ETH/SOL/ADA/AVAX/NEAR. "
                "DeFi (5 coins, 10 pairs): UNI/AAVE/MKR/INJ/LINK. "
                "Same z-score entry/exit as Strategy A. All sector pairs monitored continuously."
            ),
            "folds": b_folds,
            "summary": b_summary,
        },
        "strategy_c_btc_eth_ratio": {
            "description": (
                "ETH/BTC ratio mean reversion. 60d rolling z-score of the ratio. "
                "z > 2: short ETH / long BTC. z < -2: long ETH / short BTC. "
                "Exit when |z| < 1. Low cost (2 instruments, 1x each, 4 legs total)."
            ),
            "folds": c_folds,
            "summary": c_summary,
        },
        "strategy_d_funding_premium": {
            "description": (
                "Contrarian funding-rate strategy. Use Binance 8-hourly funding rate "
                "(aggregated daily) as sentiment. When funding > 0.05% → short. "
                "When funding < -0.05% → long. Exit when |funding| < 0.01%. "
                "Per-coin allocation = 1/N of capital."
            ),
            "folds": d_folds,
            "summary": d_summary,
        },
    }

    # ---- 10. Comparison across strategies -----------------------------
    summaries = {
        "baseline_ew": baseline_summary,
        "A_top_pairs": a_summary,
        "B_sector_pairs": b_summary,
        "C_btc_eth_ratio": c_summary,
        "D_funding_premium": d_summary,
    }
    best_name = max(
        summaries, key=lambda k: summaries[k].get("mean_sharpe", -999)
    )
    best_sharpe = summaries[best_name]["mean_sharpe"]

    rankings = sorted(
        [
            {
                "strategy": name,
                "mean_sharpe": s["mean_sharpe"],
                "mean_total_return": s["mean_total_return"],
                "mean_annualized_return": s["mean_annualized_return"],
                "mean_win_rate": s["mean_win_rate"],
                "mean_max_drawdown": s["mean_max_drawdown"],
                "fold_count": s["fold_count"],
            }
            for name, s in summaries.items()
        ],
        key=lambda x: x["mean_sharpe"],
        reverse=True,
    )

    report["comparison"] = {
        "best_strategy": best_name,
        "best_sharpe": best_sharpe,
        "rankings": rankings,
    }

    print(f"\n--- Comparison ---")
    for r in rankings:
        print(f"  {r['strategy']:25s} sharpe={r['mean_sharpe']:.4f}  "
              f"ret={r['mean_total_return']:.4f}  "
              f"win={r['mean_win_rate']:.2%}  "
              f"dd={r['mean_max_drawdown']:.4f}")

    # ---- 11. M1 gate --------------------------------------------------
    # Strategy must beat baseline (EW) in mean Sharpe
    m1_baseline_sharpe = baseline_summary["mean_sharpe"]
    m1_gates = {}
    for name in ["A_top_pairs", "B_sector_pairs", "C_btc_eth_ratio", "D_funding_premium"]:
        s = summaries[name]
        passed = (s["mean_sharpe"] > m1_baseline_sharpe and s["fold_count"] > 0
                  and s["pass_rate"] > 0.3)
        m1_gates[name] = passed

    report["m1_gate"] = {
        "baseline_sharpe": m1_baseline_sharpe,
        **m1_gates,
        "n_passed": sum(m1_gates.values()),
    }

    print(f"\n--- M1 Gate (beat baseline sharpe={m1_baseline_sharpe:.4f}) ---")
    for name, passed in m1_gates.items():
        status = "PASS" if passed else "FAIL"
        s = summaries[name]
        print(f"  {name:25s} {status}  (sharpe={s['mean_sharpe']:.4f}, "
              f"pass_rate={s['pass_rate']:.0%})")

    # Write report
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
