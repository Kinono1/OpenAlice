#!/usr/bin/env python3
"""
Time-series momentum strategies backtest for 24 mainstream coins.

4 strategies — all pure time-series (no cross-sectional ranking):

  A: BTC TS momentum — long BTC if past-Xd return > 0, else cash.
     Test X = [10, 20, 30, 60, 90, 120, 200] with WFO.

  B: Multi-coin TS momentum — for each coin independently: if 90d return > 0
     then long; else skip.  Equal-weight all with positive momentum.
     Rebalance monthly (21 trading days).

  C: Double momentum (absolute + relative vol) — Step 1: keep only coins with
     positive 90d TS momentum.  Step 2: among those, pick the bottom 25 %
     by 21d realized vol (lowest vol in uptrend).  Equal-weight, rebalance 21d.

  D: Moving-average crossover — for each coin: if 50d SMA > 200d SMA (golden
     cross) → buy.  If 50d SMA < 200d SMA (death cross) → sell / cash.
     Equal-weight all golden-cross coins.  Rebalance weekly (5 trading days).

WFO: train=365d, test=63d, step=21d for ALL strategies.
Output: data/research/strategy_ts_momentum_report.json

No secrets, no API calls.  Read-only on ZIP files.
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
PROJECT_ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
OUTPUT_PATH = os.path.join(PROJECT_ROOT, "data", "research", "strategy_ts_momentum_report.json")

COST_BPS = 15
COST_DEC = COST_BPS / 10_000  # fractional cost for one leg

# 24 mainstream coins (by market cap + data coverage)
SYMBOLS_24 = [
    "BTCUSDT", "ETHUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT", "SOLUSDT",
    "DOTUSDT", "DOGEUSDT", "AVAXUSDT", "MATICUSDT", "LINKUSDT", "UNIUSDT",
    "ATOMUSDT", "LTCUSDT", "BCHUSDT", "TRXUSDT", "ETCUSDT", "XLMUSDT",
    "FILUSDT", "AAVEUSDT", "ALGOUSDT", "VETUSDT", "ICPUSDT", "FTMUSDT",
]

# WFO parameters
TRAIN_DAYS = 365
TEST_DAYS = 63
STEP_DAYS = 21

# Strategy-specific parameters
LOOKBACKS_A = [10, 20, 30, 60, 90, 120, 200]  # lookbacks to test for BTC TS
REBAL_MONTHLY = 21  # trading days for monthly rebalance
REBAL_WEEKLY = 5    # trading days for weekly rebalance
TS_LOOKBACK = 90    # lookback for TS momentum signal (B, C)
VOL_WINDOW = 21     # vol estimation window (C)
MA_FAST = 50        # fast MA period (D)
MA_SLOW = 200       # slow MA period (D)
VOL_LONG_PCT = 0.25  # bottom quartile for low-vol selection (C)

# ---------------------------------------------------------------------------
# Data loading helpers
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
    """Cumulative log-ish return over *lb* days ending on *date* (exclusive).

    Returns (price[date] - price[date-lb]) / price[date-lb], or None if
    insufficient data.
    """
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < lb:
        return None
    start = all_dates[idx - lb]

    r_vals = []
    for d in all_dates[idx - lb + 1 : idx + 1]:
        if d in rets:
            r_vals.append(rets[d])
    if len(r_vals) < lb // 2:
        return None
    return float(np.prod(1 + np.array(r_vals)) - 1)


def sma(closes: dict, all_dates: list, date: str, window: int) -> float | None:
    """Simple moving average over *window* days ending at *date* (inclusive)."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window - 1:
        return None
    vals = [closes.get(d) for d in all_dates[idx - window + 1 : idx + 1]]
    vals = [v for v in vals if v is not None and v > 0]
    if len(vals) < window // 2:
        return None
    return float(np.mean(vals))


def realized_vol(rets: dict, all_dates: list, date: str, window: int) -> float | None:
    """Annualized realized volatility over *window* days ending at *date*."""
    idx = all_dates.index(date) if date in all_dates else -1
    if idx < window:
        return None
    r_vals = []
    for d in all_dates[idx - window + 1 : idx + 1]:
        if d in rets:
            r_vals.append(rets[d])
    if len(r_vals) < window // 2:
        return None
    vol = np.std(r_vals, ddof=1)
    return float(vol * np.sqrt(252)) if vol > 0 else None


# ---------------------------------------------------------------------------
# Performance metrics for a single fold
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
            "mean_annualized_return": 0.0,
            "mean_sharpe": 0.0,
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
        "std_total_return": round(float(np.std(total_rets, ddof=1)), 6) if len(total_rets) > 1 else 0.0,
        "mean_annualized_return": round(float(np.mean(ann_rets)), 6),
        "mean_sharpe": round(float(np.mean(sharpes)), 4),
        "std_sharpe": round(float(np.std(sharpes, ddof=1)), 4) if len(sharpes) > 1 else 0.0,
        "mean_win_rate": round(float(np.mean(win_rates)), 4),
        "mean_max_drawdown": round(float(np.mean(mdd)), 6),
        "pass_rate": round(float(np.mean(total_rets > 0)), 4),
    }


# ---------------------------------------------------------------------------
# WFO runner
# ---------------------------------------------------------------------------

def run_wfo(all_dates: list, strategy_func, data_bundle: dict,
            label: str = "") -> list[dict]:
    """Walk-forward optimization for a rule-based strategy.

    Parameters
    ----------
    all_dates : sorted list of date strings for the full history.
    strategy_func : callable(all_dates, test_start_idx, test_end_idx, data_bundle)
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
            daily = strategy_func(
                all_dates, test_start, test_end, data_bundle
            )
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
            print(f"    {label} fold {fold_id}: sharpe={fm.get('sharpe', 'ERR'):>8}  "
                  f"ret={fm.get('total_return', 0):>8.4f}  "
                  f"win={fm.get('win_rate', 0):>6.2%}")

        i += STEP_DAYS
        fold_id += 1

    return folds


# ===================================================================
# Strategy A : BTC Time-Series Momentum
# ===================================================================

def strategy_a_btc_ts(all_dates: list, test_start: int, test_end: int,
                      bundle: dict) -> list[float]:
    """BTC TS momentum — daily signal based on past *lb* day return.

    If past-*lb* return > 0, go long BTC; else cash.
    """
    lb = bundle["lookback"]
    btc_ret = bundle["btc_returns"]
    btc_close = bundle["btc_closes"]
    date_set = bundle["date_set"]

    daily = []
    prev_signal = 0  # start in cash

    for i in range(test_start, test_end):
        d = all_dates[i]
        if d not in btc_ret:
            continue
        i_idx = all_dates.index(d)
        if i_idx < lb:
            continue

        # lookback return ending on previous trading day (avoid look-ahead)
        prev_date = all_dates[i_idx - 1]
        lb_start = all_dates[i_idx - 1 - lb]
        if prev_date not in btc_close or lb_start not in btc_close:
            continue
        cum_ret = (btc_close[prev_date] - btc_close[lb_start]) / btc_close[lb_start]

        signal = 1.0 if cum_ret > 0 else 0.0

        ret = signal * btc_ret[d]

        # transaction cost when signal changes (one leg: buy or sell)
        if signal != prev_signal:
            ret -= COST_DEC

        daily.append(ret)
        prev_signal = signal

    return daily


# ===================================================================
# Strategy B : Multi-Coin TS Momentum
# ===================================================================

def strategy_b_multi_ts(all_dates: list, test_start: int, test_end: int,
                        bundle: dict) -> list[float]:
    """Multi-coin TS momentum.

    Rebalance every 21 trading days.  At each rebalance date, select coins
    with positive 90d return.  Equal-weight, hold until next rebalance.
    """
    returns = bundle["all_returns"]
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]

    # Build a dict of daily portfolio returns (date -> return)
    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, REBAL_MONTHLY)
    if not rebal_dates:
        return []

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = rebal_dates[r_idx + 1] if r_idx + 1 < len(rebal_dates) else all_dates[test_end - 1]

        # At r_date, select coins with positive 90d return
        selected: list[str] = []
        for sym in symbols:
            if sym not in returns:
                continue
            cr = lookback_cumret(returns[sym], all_dates, r_date, TS_LOOKBACK)
            if cr is not None and cr > 0:
                selected.append(sym)

        # Holding period: from r_date (inclusive) to day before next rebalance
        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if d not in ret_map:
                ret_map[d] = 0.0

            if not selected:
                ret_map[d] = 0.0
                continue

            rets_today = []
            for sym in selected:
                if d in returns[sym]:
                    rets_today.append(returns[sym][d])

            if rets_today:
                ret_map[d] = float(np.mean(rets_today))
            else:
                ret_map[d] = 0.0

        # Cost: 2 legs (sell old + buy new) on rebalance day if selections changed
        new_set = set(selected)
        if new_set != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = new_set

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Strategy C : Double Momentum (TS momentum + low vol)
# ===================================================================

def strategy_c_double_momentum(all_dates: list, test_start: int, test_end: int,
                                bundle: dict) -> list[float]:
    """Double momentum — absolute (TS) + relative (low vol).

    Step 1: keep only coins with positive 90d return.
    Step 2: among those, select bottom 25 % by 21d realized vol.
    Equal-weight, rebalance monthly.
    """
    returns = bundle["all_returns"]
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]

    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, REBAL_MONTHLY)
    if not rebal_dates:
        return []

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = rebal_dates[r_idx + 1] if r_idx + 1 < len(rebal_dates) else all_dates[test_end - 1]

        # Step 1: TS momentum filter (positive 90d return)
        momentum_candidates: list[str] = []
        for sym in symbols:
            if sym not in returns:
                continue
            cr = lookback_cumret(returns[sym], all_dates, r_date, TS_LOOKBACK)
            if cr is not None and cr > 0:
                momentum_candidates.append(sym)

        # Step 2: pick bottom 25 % by realized vol
        vol_scores: list[tuple[str, float]] = []
        for sym in momentum_candidates:
            vol = realized_vol(returns[sym], all_dates, r_date, VOL_WINDOW)
            if vol is not None and vol > 0:
                vol_scores.append((sym, vol))

        vol_scores.sort(key=lambda x: x[1])
        n_keep = max(1, int(len(vol_scores) * VOL_LONG_PCT))
        selected = [sym for sym, _ in vol_scores[:n_keep]]

        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if not selected:
                ret_map[d] = 0.0
                continue

            rets_today = [returns[sym][d] for sym in selected if d in returns[sym]]
            ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

        new_set = set(selected)
        if new_set != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = new_set

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ===================================================================
# Strategy D : Moving-Average Crossover
# ===================================================================

def strategy_d_ma_crossover(all_dates: list, test_start: int, test_end: int,
                             bundle: dict) -> list[float]:
    """MA crossover — golden cross / death cross.

    For each coin: if 50d SMA > 200d SMA → buy; else cash.
    Equal-weight, rebalance weekly (5 trading days).
    """
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]
    all_returns = bundle["all_returns"]

    ret_map: dict[str, float] = {}
    prev_selected: set[str] = set()

    rebal_dates = _rebalance_dates(all_dates, test_start, test_end, REBAL_WEEKLY)
    if not rebal_dates:
        return []

    for r_idx, r_date in enumerate(rebal_dates):
        next_date = rebal_dates[r_idx + 1] if r_idx + 1 < len(rebal_dates) else all_dates[test_end - 1]

        # Check golden / death cross at rebalance date
        selected: list[str] = []
        for sym in symbols:
            if sym not in closes:
                continue
            fast = sma(closes[sym], all_dates, r_date, MA_FAST)
            slow = sma(closes[sym], all_dates, r_date, MA_SLOW)
            if fast is not None and slow is not None and fast > slow:
                selected.append(sym)

        hold_dates = [d for d in all_dates if r_date <= d < next_date]
        for d in hold_dates:
            if not selected:
                ret_map[d] = 0.0
                continue

            rets_today = [all_returns[sym][d] for sym in selected if d in all_returns[sym]]
            ret_map[d] = float(np.mean(rets_today)) if rets_today else 0.0

        new_set = set(selected)
        if new_set != prev_selected and r_date in ret_map:
            ret_map[r_date] -= 2 * COST_DEC
        prev_selected = new_set

    return [ret_map.get(d, 0.0) for d in all_dates[test_start:test_end]]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _rebalance_dates(all_dates: list, test_start: int, test_end: int,
                     step: int) -> list:
    """Return a list of rebalance dates within the test window.

    The first rebalance is at *test_start* (first day of test window),
    then every *step* days thereafter.
    """
    r = list(range(test_start, test_end, step))
    return [all_dates[i] for i in r if i < test_end]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    print("=" * 66)
    print("  Time-Series Momentum Strategy Backtest")
    print("=" * 66)

    # ---- 1. Load data --------------------------------------------------
    print("\n[1/5] Loading daily OHLCV for 24 mainstream coins...")
    all_closes: dict[str, dict] = {}
    all_returns: dict[str, dict] = {}
    loaded = 0
    for sym in SYMBOLS_24:
        c = load_closes(sym)
        if c:
            all_closes[sym] = c
            all_returns[sym] = daily_returns(c)
            loaded += 1
        else:
            print(f"  WARN: {sym} has no data, skipping")

    symbols = [s for s in SYMBOLS_24 if s in all_closes]
    print(f"  Loaded {loaded}/{len(SYMBOLS_24)} symbols")

    # Build unified date list
    all_dates = sorted(set(d for c in all_closes.values() for d in c))
    print(f"  Date range: {all_dates[0]} → {all_dates[-1]}  ({len(all_dates)} trading days)")

    date_set = set(all_dates)

    # BTC data
    btc_returns = all_returns.get("BTCUSDT", {})
    btc_closes = all_closes.get("BTCUSDT", {})

    # Shared data bundle
    base_bundle = {
        "all_returns": all_returns,
        "all_closes": all_closes,
        "symbols": symbols,
        "date_set": date_set,
    }

    btc_bundle = {
        **base_bundle,
        "btc_returns": btc_returns,
        "btc_closes": btc_closes,
        "lookback": None,  # filled per lookback
    }

    report: dict = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "strategy": "ts_momentum",
        "config": {
            "symbols": symbols,
            "n_symbols": len(symbols),
            "train_days": TRAIN_DAYS,
            "test_days": TEST_DAYS,
            "step_days": STEP_DAYS,
            "cost_bps": COST_BPS,
            "period": f"{all_dates[0]} to {all_dates[-1]}",
        },
    }

    # ---- 2. Strategy A : BTC TS Momentum --------------------------------
    print("\n[2/5] Strategy A: BTC Time-Series Momentum")
    print("  Lookbacks:", LOOKBACKS_A)

    a_results: dict = {}
    best_lb = None
    best_sharpe = -999.0

    for lb in LOOKBACKS_A:
        btc_bundle["lookback"] = lb
        print(f"\n  --- Lookback {lb:3d}d ---")
        folds = run_wfo(all_dates, strategy_a_btc_ts, btc_bundle, label=f"A-{lb}d")
        summary = aggregate_folds(folds)

        a_results[str(lb)] = {
            "lookback_days": lb,
            "fold_count": summary["fold_count"],
            "summary": summary,
            "folds": folds,
        }

        s = summary["mean_sharpe"]
        print(f"  → {summary['fold_count']} folds, mean_sharpe={s:.4f}, "
              f"win_rate={summary['mean_win_rate']:.2%}, "
              f"pass_rate={summary['pass_rate']:.0%}")

        if s > best_sharpe:
            best_sharpe = s
            best_lb = lb

    report["strategy_a"] = {
        "description": "BTC TS momentum: long BTC if past-Xd return > 0, else cash. "
                       "Daily signal, one-leg cost (15bps) on signal change.",
        "lookbacks": a_results,
        "best_lookback": {"lookback_days": best_lb, "mean_sharpe": round(best_sharpe, 4)},
    }

    # ---- 3. Strategy B : Multi-Coin TS Momentum -------------------------
    print("\n[3/5] Strategy B: Multi-Coin TS Momentum")
    print(f"  Lookback: {TS_LOOKBACK}d, Rebalance: {REBAL_MONTHLY}d, Two-leg cost ({COST_BPS*2}bps)")

    b_folds = run_wfo(all_dates, strategy_b_multi_ts, base_bundle, label="B")
    b_summary = aggregate_folds(b_folds)
    print(f"  → {b_summary['fold_count']} folds, mean_sharpe={b_summary['mean_sharpe']:.4f}, "
          f"win_rate={b_summary['mean_win_rate']:.2%}, "
          f"pass_rate={b_summary['pass_rate']:.0%}")

    report["strategy_b"] = {
        "description": (
            f"Multi-coin TS momentum: long each coin with positive "
            f"{TS_LOOKBACK}d return. Equal-weight, rebalance every "
            f"{REBAL_MONTHLY}d ({REBAL_MONTHLY} trading days). "
            f"{COST_BPS*2}bps per rebalance."
        ),
        "summary": b_summary,
        "folds": b_folds,
    }

    # ---- 4. Strategy C : Double Momentum --------------------------------
    print("\n[4/5] Strategy C: Double Momentum (TS + low vol)")
    print(f"  TS lookback: {TS_LOOKBACK}d, Vol window: {VOL_WINDOW}d, "
          f"Low-vol pct: {VOL_LONG_PCT:.0%}")

    c_folds = run_wfo(all_dates, strategy_c_double_momentum, base_bundle, label="C")
    c_summary = aggregate_folds(c_folds)
    print(f"  → {c_summary['fold_count']} folds, mean_sharpe={c_summary['mean_sharpe']:.4f}, "
          f"win_rate={c_summary['mean_win_rate']:.2%}, "
          f"pass_rate={c_summary['pass_rate']:.0%}")

    report["strategy_c"] = {
        "description": (
            f"Double momentum: Step 1 = coins with positive {TS_LOOKBACK}d "
            f"return. Step 2 = bottom {VOL_LONG_PCT:.0%} by {VOL_WINDOW}d "
            f"realized vol. Equal-weight, rebalance {REBAL_MONTHLY}d. "
            f"{COST_BPS*2}bps per rebalance."
        ),
        "summary": c_summary,
        "folds": c_folds,
    }

    # ---- 5. Strategy D : MA Crossover ------------------------------------
    print("\n[5/5] Strategy D: MA Crossover (Golden Cross)")
    print(f"  Fast MA: {MA_FAST}d, Slow MA: {MA_SLOW}d, "
          f"Rebalance: {REBAL_WEEKLY}d")

    d_folds = run_wfo(all_dates, strategy_d_ma_crossover, base_bundle, label="D")
    d_summary = aggregate_folds(d_folds)
    print(f"  → {d_summary['fold_count']} folds, mean_sharpe={d_summary['mean_sharpe']:.4f}, "
          f"win_rate={d_summary['mean_win_rate']:.2%}, "
          f"pass_rate={d_summary['pass_rate']:.0%}")

    # Compute avg coins held for Strategy D
    avg_held = _avg_coins_held(all_dates, base_bundle, REBAL_WEEKLY, MA_FAST, MA_SLOW)

    report["strategy_d"] = {
        "description": (
            f"MA crossover: if {MA_FAST}d SMA > {MA_SLOW}d SMA (golden cross) "
            f"→ buy; else cash. Equal-weight, rebalance every {REBAL_WEEKLY}d "
            f"({REBAL_WEEKLY} trading days). "
            f"{COST_BPS*2}bps per rebalance."
        ),
        "summary": {**d_summary, "avg_coins_held": round(avg_held, 2)},
        "folds": d_folds,
    }

    # ---- Write report ---------------------------------------------------
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n{'=' * 66}")
    print(f"  Report written: {OUTPUT_PATH}")
    print(f"{'=' * 66}")

    # Summary table
    print("\n\nSummary:")
    print(f"  {'Strategy':<30} {'Folds':>5} {'Sharpe':>8} {'WinRate':>8} {'PassRate':>8}")
    print(f"  {'-'*30} {'-'*5} {'-'*8} {'-'*8} {'-'*8}")
    for key, label in [("strategy_a", f"A: BTC TS (best={best_lb}d)"),
                        ("strategy_b", "B: Multi TS"),
                        ("strategy_c", "C: Double Mom"),
                        ("strategy_d", "D: MA Cross")]:
        s = report[key]
        if key == "strategy_a":
            summ = s["lookbacks"][str(best_lb)]["summary"]
        else:
            summ = s["summary"]
        print(f"  {label:<30} {summ['fold_count']:>5} {summ['mean_sharpe']:>8.4f} "
              f"{summ['mean_win_rate']:>7.2%} {summ['pass_rate']:>7.0%}")


def _avg_coins_held(all_dates, bundle, rebal_step, ma_fast, ma_slow):
    """Compute average number of coins selected across rebalance dates."""
    closes = bundle["all_closes"]
    symbols = bundle["symbols"]
    counts = []
    for r in range(0, len(all_dates), rebal_step):
        d = all_dates[r]
        n = 0
        for sym in symbols:
            if sym not in closes:
                continue
            f = sma(closes[sym], all_dates, d, ma_fast)
            s = sma(closes[sym], all_dates, d, ma_slow)
            if f is not None and s is not None and f > s:
                n += 1
        counts.append(n)
    return float(np.mean(counts)) if counts else 0.0


if __name__ == "__main__":
    main()
