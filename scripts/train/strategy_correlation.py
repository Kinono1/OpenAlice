#!/usr/bin/env python3
"""
Correlation-based and volatility breakout strategies backtest for 24 mainstream coins.

Four strategies:

  A: Correlation regime — compute 60d rolling pairwise correlations. When avg
     pairwise corr < 0.3, equal-weight all coins (low-corr regime). When avg
     corr > 0.6, buy only BTC (high-corr regime). Values between 0.3 and 0.6
     carry the previous allocation forward. Monthly rebalance (21 trading days).

  B: Drawdown-contingent — remove any coin whose drawdown from its 90-day high
     exceeds 30 %. Apply V6a (bottom 20 % by 60d realized vol) on the
     surviving coins. Monthly rebalance.

  C: Volatility breakout — for each coin, if the daily absolute return exceeds
     2x the 60-day median absolute return, a vol spike is detected. Enter the
     top 3 coins by spike ratio, hold for 10 trading days.

  D: Monthly rotation — each month, buy the 3 coins with the highest 30-day
     trailing return. Equal-weight, hold for 30 days.

WFO: train=365d, test=63d, step=21d
Output: data/research/strategy_correlation_report.json

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
PROJECT_ROOT = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
)
OUTPUT_PATH = os.path.join(
    PROJECT_ROOT, "data", "research", "strategy_correlation_report.json"
)

COST_BPS = 15
COST_DEC = COST_BPS / 10_000  # fractional cost for one leg

# 24 mainstream coins (verified available in data directory)
SYMBOLS_24 = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "SOLUSDT",
    "DOGEUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT", "MATICUSDT", "UNIUSDT",
    "LTCUSDT", "BCHUSDT", "ATOMUSDT", "TRXUSDT", "ETCUSDT", "XLMUSDT",
    "FILUSDT", "EOSUSDT", "VETUSDT", "ICPUSDT", "FTMUSDT", "THETAUSDT",
]

# WFO parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

# --- Strategy A ---
CORR_WINDOW = 60    # lookback for rolling pairwise correlation
CORR_LOW = 0.3      # low-correlation-regime threshold
CORR_HIGH = 0.6     # high-correlation-regime threshold

# --- Strategy B ---
DD_WINDOW = 90       # lookback for high-water mark drawdown
DD_THRESHOLD = -0.30  # max allowable drawdown
V6A_VOL_WINDOW = 60  # lookback for V6a realised vol estimate
V6A_QUANTILE = 0.20  # bottom quantile for V6a low-vol selection

# --- Strategy C ---
VOL_SPIKE_WINDOW = 60     # lookback for median absolute return
VOL_SPIKE_THRESHOLD = 2.0  # spike multiplier
VOL_SPIKE_HOLD = 10        # holding days after entering
VOL_SPIKE_TOP_N = 3        # top N by spike ratio

# --- Strategy D ---
MOM_LOOKBACK = 30  # trailing return window for momentum
MOM_TOP_N = 3      # top N by trailing return
MOM_HOLD = 30      # holding days

# Rebalance interval for monthly strategies
MONTHLY_REBAL = 21  # trading days approximating one month


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def _parse_ts(ts_str: str) -> int:
    """Parse Binance kline timestamp (ms or us) into milliseconds."""
    v = int(ts_str)
    return v // 1000 if v > 1e15 else v


def load_closes(symbol: str) -> dict:
    """Load daily close prices from monthly ZIP files.

    Returns {YYYY-MM-DD: close_price}.
    """
    closes = {}
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
    rets = {}
    for i in range(1, len(dates)):
        p, c = dates[i - 1], dates[i]
        if closes[p] > 0:
            rets[c] = (closes[c] - closes[p]) / closes[p]
    return rets


# ---------------------------------------------------------------------------
# Quantitative helpers
# ---------------------------------------------------------------------------

def lookback_cumret(rets: dict, all_dates: list, date: str, lb: int) -> float | None:
    """Cumulative return over *lb* days ending on *date* (exclusive)."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < lb:
        return None
    r_vals = []
    for d in all_dates[idx - lb + 1: idx + 1]:
        if d in rets:
            r_vals.append(rets[d])
    if len(r_vals) < lb // 2:
        return None
    return float(np.prod(1 + np.array(r_vals)) - 1)


def realized_vol(rets: dict, all_dates: list, date: str, window: int) -> float | None:
    """Annualized realised volatility over *window* days ending at *date*."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window:
        return None
    r_vals = []
    for d in all_dates[idx - window + 1: idx + 1]:
        if d in rets:
            r_vals.append(rets[d])
    if len(r_vals) < window // 2:
        return None
    vol = np.std(r_vals, ddof=1)
    return float(vol * np.sqrt(252)) if vol > 0 else None


def _drawdown_from_high(closes: dict, all_dates: list, date: str,
                         window: int) -> float | None:
    """Drawdown of current price from the highest close in the rolling window."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window - 1:
        return None
    prices = []
    for d in all_dates[idx - window + 1: idx + 1]:
        if d in closes:
            prices.append(closes[d])
    if len(prices) < window // 2:
        return None
    high = max(prices)
    current = prices[-1]
    if high <= 0:
        return None
    return (current - high) / high


# ---------------------------------------------------------------------------
# Correlation helper (Strategy A)
# ---------------------------------------------------------------------------

def _avg_pairwise_corr(returns: dict, symbols: list, all_dates: list,
                        date: str, window: int) -> float | None:
    """Average pairwise Pearson correlation of daily returns over rolling window."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window:
        return None

    window_dates = all_dates[idx - window: idx]
    matrix_rows = []
    valid = []
    for sym in symbols:
        if sym not in returns:
            continue
        vals = []
        for d in window_dates:
            vals.append(returns[sym].get(d, np.nan))
        arr = np.array(vals, dtype=float)
        # skip symbols with too many missing days
        if np.isnan(arr).sum() > window * 0.15:
            continue
        matrix_rows.append(arr)
        valid.append(sym)

    if len(valid) < 3:
        return None

    X = np.array(matrix_rows)                     # n_sym x window
    # drop columns (days) that have any NaN
    X = X[:, ~np.isnan(X).any(axis=0)]
    if X.shape[1] < window // 2:
        return None

    corr = np.corrcoef(X)
    n = len(valid)
    upper = corr[np.triu_indices(n, k=1)]
    return float(np.mean(upper)) if len(upper) > 0 else None


# ---------------------------------------------------------------------------
# Performance metrics
# ---------------------------------------------------------------------------

def _max_drawdown(returns: np.ndarray) -> float:
    """Maximum peak-to-trough drawdown from a daily return series."""
    if len(returns) == 0:
        return 0.0
    cum = np.cumprod(1 + returns)
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
    """Walk-forward optimisation for a rule-based strategy.

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
    folds = []
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
            _s = fm.get("sharpe", "ERR")
            if isinstance(_s, str):
                _s_str = f"{_s:>8}"
            else:
                _s_str = f"{_s:>8.4f}"
            print(f"    {label} fold {fold_id}: sharpe={_s_str}  "
                  f"ret={fm.get('total_return', 0):>8.4f}  "
                  f"win={fm.get('win_rate', 0):>6.2%}")

        i += STEP_DAYS
        fold_id += 1

    return folds


# ===================================================================
# Strategy A : Correlation Regime
# ===================================================================

def strategy_a_corr_regime(all_dates: list, test_start: int, test_end: int,
                           bundle: dict) -> list[float]:
    """Correlation regime strategy.

    Monthly rebalance. Compute 60d average pairwise correlation.
      - avg < 0.3 : equal-weight ALL coins (low-corr / diversifying regime)
      - avg > 0.6 : BTC only (high-corr / risk-on-off regime)
      - else      : carry forward the previous allocation

    One round-trip (2 legs) on rebalance days when the selected set changes.
    """
    returns = bundle["all_returns"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, MONTHLY_REBAL)
    if not rebal_dates:
        return []

    # Initial allocation: equal-weight all
    current_selected: set[str] = set(symbols)

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = (rebal_dates[r_idx + 1]
                     if r_idx + 1 < len(rebal_dates)
                     else all_dates[test_end - 1])

        avg_corr = _avg_pairwise_corr(returns, symbols, all_dates,
                                       r_date, CORR_WINDOW)

        if avg_corr is not None:
            if avg_corr < CORR_LOW:
                current_selected = set(symbols)
            elif avg_corr > CORR_HIGH:
                current_selected = {"BTCUSDT"}
            # 0.3 <= avg_corr <= 0.6 : carry forward current_selected

        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if not current_selected:
                ret_map[d] = 0.0
                continue
            rets_today = [returns[sym][d] for sym in current_selected
                          if d in returns[sym]]
            ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

        # Transaction cost when allocation changes
        new_set = current_selected
        if new_set != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = new_set.copy()

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Strategy B : Drawdown-Contingent + V6a
# ===================================================================

def strategy_b_drawdown_v6a(all_dates: list, test_start: int, test_end: int,
                            bundle: dict) -> list[float]:
    """Drawdown-contingent low-vol strategy.

    1. Remove any coin whose drawdown from the 90-day high exceeds 30 %.
    2. On survivors, apply V6a: select the bottom 20 % by 60d realised vol.
    Equal-weight selected coins. Monthly rebalance.
    """
    returns = bundle["all_returns"]
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, MONTHLY_REBAL)
    if not rebal_dates:
        return []

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = (rebal_dates[r_idx + 1]
                     if r_idx + 1 < len(rebal_dates)
                     else all_dates[test_end - 1])

        # Step 1: filter out coins in deep drawdown
        survivors: list[str] = []
        for sym in symbols:
            if sym not in closes:
                continue
            dd = _drawdown_from_high(closes[sym], all_dates, r_date, DD_WINDOW)
            if dd is not None and dd >= DD_THRESHOLD:
                survivors.append(sym)

        # Step 2: V6a low-vol selection on survivors
        selected: set[str] = set()
        if survivors:
            vol_scores: list[tuple[str, float]] = []
            for sym in survivors:
                if sym not in returns:
                    continue
                vol = realized_vol(returns[sym], all_dates, r_date,
                                   V6A_VOL_WINDOW)
                if vol is not None and vol > 0:
                    vol_scores.append((sym, vol))

            vol_scores.sort(key=lambda x: x[1])
            n_keep = max(1, int(len(vol_scores) * V6A_QUANTILE))
            selected = {sym for sym, _ in vol_scores[:n_keep]}

        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if not selected:
                ret_map[d] = 0.0
                continue
            rets_today = [returns[sym][d] for sym in selected
                          if d in returns[sym]]
            ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

        # Transaction cost on rebalance
        if selected != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = selected.copy()

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Strategy C : Volatility Breakout
# ===================================================================

def _median_abs_return(rets: dict, all_dates: list, date: str,
                       window: int) -> float | None:
    """Median absolute daily return over *window* days ending at *date* (inclusive)."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window - 1:
        return None
    abs_vals = []
    for j in range(idx - window + 1, idx + 1):
        d = all_dates[j]
        if d in rets:
            abs_vals.append(abs(rets[d]))
    if len(abs_vals) < window // 2:
        return None
    return float(np.median(abs_vals))


def strategy_c_vol_breakout(all_dates: list, test_start: int, test_end: int,
                            bundle: dict) -> list[float]:
    """Volatility breakout strategy.

    Daily signal: for each coin, if |return_today| > 2x median(|return|, 60d),
    a vol spike is detected.  Enter the top 3 coins by spike ratio on the
    signal day (at the close).  Hold each position for 10 trading days.

    Entry cost of 2 * COST_DEC per new position (pro-rated by equal weight)
    is applied on the entry day.
    """
    returns = bundle["all_returns"]
    symbols = bundle["symbols"]

    # positions[sym] = remaining holding days (decremented each morning)
    positions: dict[str, int] = {}
    daily: list[float] = []

    test_dates = all_dates[test_start:test_end]

    for i, d in enumerate(test_dates):
        idx = all_dates.index(d)

        # --- 1. Compute today's portfolio return from active positions ---
        active = [sym for sym, rem in positions.items() if rem > 0]
        if active:
            rets_today = [returns[sym].get(d, 0.0) for sym in active]
            port_ret = float(np.mean(rets_today))
        else:
            port_ret = 0.0

        # --- 2. Decrement all hold counters (day elapsed) ---
        expired: list[str] = []
        for sym in positions:
            positions[sym] -= 1
            if positions[sym] <= 0:
                expired.append(sym)
        for sym in expired:
            del positions[sym]

        # --- 3. Check for vol spike signals (use data up to yesterday) ---
        spike_candidates: list[tuple[str, float]] = []

        if idx >= VOL_SPIKE_WINDOW:
            prev_date = all_dates[idx - 1]

            for sym in symbols:
                # skip coins already held
                if sym in positions:
                    continue
                if sym not in returns or d not in returns[sym]:
                    continue
                if prev_date not in returns[sym]:
                    continue

                # median over trailing window ending yesterday
                median_abs = _median_abs_return(returns[sym], all_dates,
                                                 prev_date, VOL_SPIKE_WINDOW)
                if median_abs is None or median_abs <= 0:
                    continue

                today_abs = abs(returns[sym][d])
                spike_ratio = today_abs / median_abs

                if spike_ratio > VOL_SPIKE_THRESHOLD:
                    spike_candidates.append((sym, spike_ratio))

            # Enter top N by spike ratio
            spike_candidates.sort(key=lambda x: x[1], reverse=True)
            for j, (sym, _ratio) in enumerate(
                    spike_candidates[:VOL_SPIKE_TOP_N]):
                if sym not in positions:
                    positions[sym] = VOL_SPIKE_HOLD
                    # Apply 2-leg cost for this position (buy + sell).
                    # The position weight is 1 / total_positions after entry.
                    total_pos = len(active) + (j + 1)
                    port_ret -= 2 * COST_DEC / max(1, total_pos)

        daily.append(port_ret)

    return daily


# ===================================================================
# Strategy D : Monthly Rotation (high-momentum)
# ===================================================================

def strategy_d_monthly_rotation(all_dates: list, test_start: int, test_end: int,
                                bundle: dict) -> list[float]:
    """Monthly rotation strategy.

    Each month, select the 3 coins with the highest 30-day trailing return.
    Equal-weight, hold for 30 days.  Full round-trip cost on rebalance.
    """
    returns = bundle["all_returns"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, MONTHLY_REBAL)
    if not rebal_dates:
        return []

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = (rebal_dates[r_idx + 1]
                     if r_idx + 1 < len(rebal_dates)
                     else all_dates[test_end - 1])

        # Score each coin by trailing 30-day return
        scores: list[tuple[str, float]] = []
        for sym in symbols:
            if sym not in returns:
                continue
            cr = lookback_cumret(returns[sym], all_dates, r_date, MOM_LOOKBACK)
            if cr is not None:
                scores.append((sym, cr))

        scores.sort(key=lambda x: x[1], reverse=True)
        selected = {sym for sym, _ in scores[:MOM_TOP_N]}

        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if not selected:
                ret_map[d] = 0.0
                continue
            rets_today = [returns[sym][d] for sym in selected
                          if d in returns[sym]]
            ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

        # Cost on rebalance
        if selected != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = selected.copy()

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Equal-weight baseline
# ===================================================================

def strategy_equal_weight(all_dates: list, test_start: int, test_end: int,
                          bundle: dict) -> list[float]:
    """Equal-weight all coins, no rebalance cost (naive baseline)."""
    returns = bundle["all_returns"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    for d in all_dates[test_start:test_end]:
        rets_today = [returns[sym].get(d, 0.0) for sym in symbols
                      if d in returns[sym]]
        ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Main
# ===================================================================

def main() -> None:
    print("=" * 66)
    print("  Correlation & Volatility Breakout Strategy Backtest")
    print("=" * 66)

    # ---- 1. Load data ------------------------------------------------
    print("\n[1/6] Loading daily OHLCV for 24 mainstream coins...")
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

    # ---- 2. Shared data bundle ---------------------------------------
    base_bundle = {
        "all_returns": all_returns,
        "all_closes": all_closes,
        "symbols": symbols,
    }

    # ---- 3. Baseline (equal-weight) ----------------------------------
    print("\n[2/6] Baseline: Equal-Weight All Coins")
    baseline_folds = run_wfo(all_dates, strategy_equal_weight, base_bundle,
                              label="EW")
    baseline_summary = aggregate_folds(baseline_folds)
    print(f"  -> {baseline_summary['fold_count']} folds, "
          f"mean_sharpe={baseline_summary['mean_sharpe']:.4f}, "
          f"win_rate={baseline_summary['mean_win_rate']:.2%}, "
          f"pass_rate={baseline_summary['pass_rate']:.0%}")

    # ---- 4. Strategy A : Correlation Regime --------------------------
    print("\n[3/6] Strategy A: Correlation Regime")
    a_folds = run_wfo(all_dates, strategy_a_corr_regime, base_bundle,
                       label="A-CORR")
    a_summary = aggregate_folds(a_folds)
    print(f"  -> {a_summary['fold_count']} folds, "
          f"mean_sharpe={a_summary['mean_sharpe']:.4f}, "
          f"win_rate={a_summary['mean_win_rate']:.2%}, "
          f"pass_rate={a_summary['pass_rate']:.0%}")

    # ---- 5. Strategy B : Drawdown-Contingent + V6a -------------------
    print("\n[4/6] Strategy B: Drawdown-Contingent + V6a")
    b_folds = run_wfo(all_dates, strategy_b_drawdown_v6a, base_bundle,
                       label="B-DD-V6A")
    b_summary = aggregate_folds(b_folds)
    print(f"  -> {b_summary['fold_count']} folds, "
          f"mean_sharpe={b_summary['mean_sharpe']:.4f}, "
          f"win_rate={b_summary['mean_win_rate']:.2%}, "
          f"pass_rate={b_summary['pass_rate']:.0%}")

    # ---- 6. Strategy C : Volatility Breakout -------------------------
    print("\n[5/6] Strategy C: Volatility Breakout")
    c_folds = run_wfo(all_dates, strategy_c_vol_breakout, base_bundle,
                       label="C-VOL-BRK")
    c_summary = aggregate_folds(c_folds)
    print(f"  -> {c_summary['fold_count']} folds, "
          f"mean_sharpe={c_summary['mean_sharpe']:.4f}, "
          f"win_rate={c_summary['mean_win_rate']:.2%}, "
          f"pass_rate={c_summary['pass_rate']:.0%}")

    # ---- 7. Strategy D : Monthly Rotation ----------------------------
    print("\n[6/6] Strategy D: Monthly Rotation (Top-3 Momentum)")
    d_folds = run_wfo(all_dates, strategy_d_monthly_rotation, base_bundle,
                       label="D-ROTATE")
    d_summary = aggregate_folds(d_folds)
    print(f"  -> {d_summary['fold_count']} folds, "
          f"mean_sharpe={d_summary['mean_sharpe']:.4f}, "
          f"win_rate={d_summary['mean_win_rate']:.2%}, "
          f"pass_rate={d_summary['pass_rate']:.0%}")

    # ---- 8. Build report ---------------------------------------------
    report: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "strategy": "strategy_correlation",
        "config": {
            "symbols": symbols,
            "n_symbols": len(symbols),
            "train_days": TRAIN_DAYS,
            "test_days": TEST_DAYS,
            "step_days": STEP_DAYS,
            "cost_bps": COST_BPS,
            "period": f"{all_dates[0]} to {all_dates[-1]}",
            "strategy_params": {
                "A_corr_regime": {
                    "corr_window": CORR_WINDOW,
                    "corr_low": CORR_LOW,
                    "corr_high": CORR_HIGH,
                    "rebalance_days": MONTHLY_REBAL,
                },
                "B_drawdown_contingent": {
                    "dd_window": DD_WINDOW,
                    "dd_threshold": DD_THRESHOLD,
                    "v6a_vol_window": V6A_VOL_WINDOW,
                    "v6a_quantile": V6A_QUANTILE,
                    "rebalance_days": MONTHLY_REBAL,
                },
                "C_vol_breakout": {
                    "vol_lookback": VOL_SPIKE_WINDOW,
                    "spike_threshold": VOL_SPIKE_THRESHOLD,
                    "hold_days": VOL_SPIKE_HOLD,
                    "top_n": VOL_SPIKE_TOP_N,
                },
                "D_monthly_rotation": {
                    "momentum_lookback": MOM_LOOKBACK,
                    "top_n": MOM_TOP_N,
                    "hold_days": MOM_HOLD,
                    "rebalance_days": MONTHLY_REBAL,
                },
            },
        },
        "baseline_equal_weight": {
            "description": "Equal-weight all 24 coins, no rebalance cost.",
            "folds": baseline_folds,
            "summary": baseline_summary,
        },
        "strategy_a_corr_regime": {
            "description": (
                "Monthly rebalance. 60d avg pairwise correlation determines "
                "regime: <0.3 equal-weight all, >0.6 BTC-only, else carry "
                "forward. 2-leg cost on regime change."
            ),
            "folds": a_folds,
            "summary": a_summary,
        },
        "strategy_b_drawdown_contingent": {
            "description": (
                "Monthly rebalance. Remove coins with >30% drawdown from "
                "90d high, then V6a-select bottom 20% by 60d vol on survivors. "
                "2-leg cost on rebalance."
            ),
            "folds": b_folds,
            "summary": b_summary,
        },
        "strategy_c_vol_breakout": {
            "description": (
                "Daily signal. For each coin, if |return| > 2x 60d median "
                "|return|, signal vol spike. Enter top 3 by spike ratio, "
                "hold 10 days. 2-leg cost per entry."
            ),
            "folds": c_folds,
            "summary": c_summary,
        },
        "strategy_d_monthly_rotation": {
            "description": (
                "Monthly rebalance. Select 3 coins with highest 30d return. "
                "Equal-weight, hold 30 days. 2-leg cost on rebalance."
            ),
            "folds": d_folds,
            "summary": d_summary,
        },
    }

    # M1 gate: strategy must beat equal-weight baseline
    m1_a = (a_summary["mean_sharpe"] > baseline_summary["mean_sharpe"]
            and a_summary["pass_rate"] > 0.3)
    m1_b = (b_summary["mean_sharpe"] > baseline_summary["mean_sharpe"]
            and b_summary["pass_rate"] > 0.3)
    m1_c = (c_summary["mean_sharpe"] > baseline_summary["mean_sharpe"]
            and c_summary["pass_rate"] > 0.3)
    m1_d = (d_summary["mean_sharpe"] > baseline_summary["mean_sharpe"]
            and d_summary["pass_rate"] > 0.3)

    report["m1_gate"] = {
        "strategy_a": m1_a,
        "strategy_b": m1_b,
        "strategy_c": m1_c,
        "strategy_d": m1_d,
        "n_passed": sum([m1_a, m1_b, m1_c, m1_d]),
    }

    print(f"\n--- M1 Gate ---")
    print(f"  A Correlation Regime:  {'PASS' if m1_a else 'FAIL'} "
          f"(sharpe={a_summary['mean_sharpe']:.4f}, "
          f"pass_rate={a_summary['pass_rate']:.0%})")
    print(f"  B Drawdown+V6a:        {'PASS' if m1_b else 'FAIL'} "
          f"(sharpe={b_summary['mean_sharpe']:.4f}, "
          f"pass_rate={b_summary['pass_rate']:.0%})")
    print(f"  C Vol Breakout:        {'PASS' if m1_c else 'FAIL'} "
          f"(sharpe={c_summary['mean_sharpe']:.4f}, "
          f"pass_rate={c_summary['pass_rate']:.0%})")
    print(f"  D Monthly Rotation:    {'PASS' if m1_d else 'FAIL'} "
          f"(sharpe={d_summary['mean_sharpe']:.4f}, "
          f"pass_rate={d_summary['pass_rate']:.0%})")

    # Write report
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
