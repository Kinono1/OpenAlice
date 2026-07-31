#!/usr/bin/env python3
"""
Strategy backtesting using on-chain and market data.

Four strategies tested with Walk-Forward Optimization (WFO):

  A - Stablecoin rotation (USDTVOL/BTCVOL ratio as proxy for USDT dominance)
  B - Weekend effect (weekend vs weekday volatility patterns)
  C - BTC as predictor (BTC 7d return momentum spillover to alts)
  D - Volume divergence (price-volume correlation break-down signals)

Data sources:
  - Binance daily klines (ZIP): price, volume, quote_volume across 120+ USDT pairs

Output: data/research/strategy_onchain_report.json  (WFO results, no secrets)
"""

import json
import os
import sys
import warnings
import zipfile
from collections import defaultdict
from datetime import datetime, timezone, timedelta

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
START_DATE = "2020-01-01"
END_DATE = "2024-12-31"
TOP_N_UNIVERSE = 120          # number of symbols to load for USDTVOL + trading
LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")
COST_BPS = 15                  # per-leg trading cost in basis points

# Strategy parameters
STRAT_A_LOOKBACK = 90          # days for USDT dominance trend estimation
STRAT_A_MA_SHORT = 5           # short MA for ratio trend
STRAT_A_MA_LONG = 20           # long MA for ratio trend
STRAT_A_TOP_N = 10             # coins to buy when bullish
STRAT_A_WFO_TRAIN = 365        # WFO train days
STRAT_A_WFO_TEST = 63          # WFO test days

STRAT_B_TRAIN = 365            # WFO train days for weekend effect
STRAT_B_TEST = 63              # WFO test days for weekend effect

STRAT_C_BTC_THRESHOLD = 0.05   # BTC 7d return threshold
STRAT_C_TOP_N = 10             # top altcoins to hold
STRAT_C_REBALANCE_DAYS = 7     # weekly rebalance

STRAT_D_LOOKBACK = 30          # rolling window for volume divergence score
STRAT_D_TOP_PCT = 0.25         # fraction of universe to hold

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "research", "strategy_onchain_report.json",
)


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _ms(date_str: str) -> int:
    """ISO date string -> millisecond UTC timestamp."""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _ts_to_date(ts_ms: int) -> str:
    """Millisecond timestamp -> YYYY-MM-DD string."""
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


def _ym_range(start_str: str, end_str: str):
    """Yield (year, month) from start to end inclusive."""
    sy, sm = int(start_str[:4]), int(start_str[5:7])
    ey, em = int(end_str[:4]), int(end_str[5:7])
    y, m = sy, sm
    while (y, m) <= (ey, em):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


def _daily_return(p1: float, p0: float) -> float:
    if p0 > 0 and np.isfinite(p0) and np.isfinite(p1):
        return p1 / p0 - 1.0
    return np.nan


# ---------------------------------------------------------------------------
# Universe discovery
# ---------------------------------------------------------------------------

def discover_symbols(min_months: int = 12, top_n: int = TOP_N_UNIVERSE) -> list[str]:
    """Return up to *top_n* symbols with >= *min_months* of data (excludes leveraged tokens)."""
    candidates: list[tuple[int, str]] = []
    for sym in sorted(os.listdir(DATA_ROOT)):
        sym_path = os.path.join(DATA_ROOT, sym, "1d")
        if not os.path.isdir(sym_path):
            continue
        if any(sym.endswith(pat) for pat in LEVERAGED_PATTERNS):
            continue
        zip_count = sum(1 for f in os.listdir(sym_path) if f.endswith(".zip"))
        if zip_count >= min_months:
            candidates.append((zip_count, sym))
    candidates.sort(key=lambda t: (-t[0], t[1]))
    return [sym for _, sym in candidates[:top_n]]


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_klines(symbol: str, start_ms: int, end_ms: int,
                cols: tuple[int, ...] = (0, 4, 5, 7)) -> dict[int, list[float]]:
    """Load kline columns for a symbol into {timestamp_ms: [col_values]}.

    Default cols: (time, close, volume, quote_volume).
    Returns dict keyed by open-time (ms).
    """
    result: dict[int, list[float]] = {}
    for year, month in _ym_range(START_DATE, END_DATE):
        zip_name = f"{symbol}-1d-{year}-{month:02d}.zip"
        zip_path = os.path.join(DATA_ROOT, symbol, "1d", zip_name)
        if not os.path.exists(zip_path):
            continue
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                csv_name = zip_name.replace(".zip", ".csv")
                if csv_name not in zf.namelist():
                    continue
                raw = zf.read(csv_name).decode("utf-8")
        except (zipfile.BadZipFile, UnicodeDecodeError, OSError):
            continue

        for line in raw.strip().split("\n"):
            parts = line.split(",")
            if len(parts) < max(cols) + 1:
                continue
            try:
                ts = int(parts[0])
            except (ValueError, IndexError):
                continue
            if ts < start_ms or ts > end_ms:
                continue
            values = [float(parts[c]) for c in cols[1:]]  # skip ts column (0)
            result[ts] = values
    return result


def load_multi_klines(
    symbols: list[str], start_ms: int, end_ms: int,
    cols: tuple[int, ...] = (0, 4, 5, 7),
) -> dict[str, dict[int, list[float]]]:
    """Load klines for multiple symbols. Returns {symbol: {ts: [values]}}."""
    data: dict[str, dict[int, list[float]]] = {}
    for i, sym in enumerate(symbols):
        data[sym] = load_klines(sym, start_ms, end_ms, cols)
        if (i + 1) % 20 == 0:
            print(f"  loaded {i + 1}/{len(symbols)} symbols ...", file=sys.stderr)
    return data


# ---------------------------------------------------------------------------
# Build unified daily timeline
# ---------------------------------------------------------------------------

def build_timeline(symbols_data: dict[str, dict[int, list[float]]],
                   start_ms: int, end_ms: int) -> tuple[list[int], dict[str, np.ndarray]]:
    """Build sorted unique day timestamps and align close prices.

    Returns (timestamps_ms, {symbol: close_array}) where close_array has same
    length as timestamps_ms, with NaN for missing days.
    """
    all_ts = sorted({
        ts for data in symbols_data.values()
        for ts in data.keys()
    })
    all_ts = [ts for ts in all_ts if start_ms <= ts <= end_ms]
    n = len(all_ts)
    ts_to_idx = {ts: i for i, ts in enumerate(all_ts)}

    arrays: dict[str, np.ndarray] = {}
    for sym, data in symbols_data.items():
        arr = np.full(n, np.nan)
        for ts, vals in data.items():
            if ts in ts_to_idx:
                arr[ts_to_idx[ts]] = vals[0]  # close is first requested col
        arrays[sym] = arr

    return all_ts, arrays


def build_timeline_full(
    symbols_data: dict[str, dict[int, list[float]]],
    n_cols: int, start_ms: int, end_ms: int,
) -> tuple[list[int], dict[str, np.ndarray]]:
    """Build timeline preserving all loaded columns.

    Returns (timestamps_ms, {symbol: (n_days, n_cols) array}).
    """
    all_ts = sorted({
        ts for data in symbols_data.values()
        for ts in data.keys()
    })
    all_ts = [ts for ts in all_ts if start_ms <= ts <= end_ms]
    n = len(all_ts)
    ts_to_idx = {ts: i for i, ts in enumerate(all_ts)}

    arrays: dict[str, np.ndarray] = {}
    for sym, data in symbols_data.items():
        arr = np.full((n, n_cols), np.nan)
        for ts, vals in data.items():
            if ts in ts_to_idx:
                arr[ts_to_idx[ts]] = vals
        arrays[sym] = arr

    return all_ts, arrays


# ---------------------------------------------------------------------------
# Performance metrics
# ---------------------------------------------------------------------------

def compute_metrics(returns: np.ndarray, ann_factor: float = 365.25) -> dict:
    """Compute performance metrics from a daily return array."""
    returns = returns[np.isfinite(returns)]
    if len(returns) < 5:
        return {
            "annualized_return": 0.0,
            "annualized_vol": 0.0,
            "sharpe_ratio": 0.0,
            "max_drawdown_pct": 0.0,
            "win_rate": 0.0,
            "n_obs": int(len(returns)),
        }
    ann_ret = float(np.mean(returns) * ann_factor)
    ann_vol = float(np.std(returns, ddof=1) * np.sqrt(ann_factor))
    sharpe = ann_ret / ann_vol if ann_vol > 0 else 0.0
    cum = np.cumprod(1.0 + returns)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))
    win_rate = float(np.mean(returns > 0))
    return {
        "annualized_return": round(ann_ret, 6),
        "annualized_vol": round(ann_vol, 6),
        "sharpe_ratio": round(sharpe, 4),
        "max_drawdown_pct": round(max_dd, 6),
        "win_rate": round(win_rate, 4),
        "n_obs": int(len(returns)),
    }


# ===================================================================
# STRATEGY A: Stablecoin Rotation
# ===================================================================

def strategy_a(
    timestamps: list[int],
    close_arrays: dict[str, np.ndarray],
    quote_vol_arrays: dict[str, np.ndarray],
    symbols: list[str],
) -> dict:
    """Stablecoin rotation strategy.

    Signal: USDTVOL/BTCVOL ratio trend.
      - USDTVOL = sum of all quote volumes (ex-BTC)
      - BTCVOL  = BTCUSDT quote volume
      - If short MA(5) > long MA(20) of ratio → ratio rising → bearish → cash
      - If short MA(5) <= long MA(20) → ratio falling → bullish → buy top 10 coins

    Top 10 coins selected by 30d avg quote volume as market cap proxy (re-ranked monthly).
    """
    print("\n[Strategy A] Stablecoin Rotation ...")
    n = len(timestamps)
    btc_idx = None
    for i, sym in enumerate(symbols):
        if sym == "BTCUSDT":
            btc_idx = i
            break

    # ---- 1. Compute USDTVOL and ratio ----
    # Total quote volume per day across all symbols except BTC
    total_qv = np.zeros(n)
    for sym in symbols:
        if sym == "BTCUSDT":
            continue
        qv = quote_vol_arrays.get(sym, np.full(n, np.nan))
        total_qv = np.where(np.isfinite(qv), total_qv + qv, total_qv)
    total_qv[total_qv == 0] = np.nan

    btc_qv = quote_vol_arrays.get("BTCUSDT", np.full(n, np.nan))
    ratio = total_qv / btc_qv  # USDTVOL / BTCVOL

    # ---- 2. Trend signal via SMA crossover ----
    # Compute short and long MAs of ratio
    ratio_short_ma = np.full(n, np.nan)
    ratio_long_ma = np.full(n, np.nan)
    for i_day in range(STRAT_A_MA_LONG, n):
        window_short = ratio[i_day - STRAT_A_MA_SHORT + 1 : i_day + 1]
        window_long = ratio[i_day - STRAT_A_MA_LONG + 1 : i_day + 1]
        n_valid_short = np.sum(np.isfinite(window_short))
        n_valid_long = np.sum(np.isfinite(window_long))
        if n_valid_short >= STRAT_A_MA_SHORT // 2 and n_valid_long >= STRAT_A_MA_LONG // 2:
            ratio_short_ma[i_day] = np.nanmean(window_short)
            ratio_long_ma[i_day] = np.nanmean(window_long)

    # Signal: 1 = bullish (buy), 0 = bearish (cash)
    signal = np.zeros(n)
    bullish = ratio_short_ma <= ratio_long_ma  # short MA <= long MA → ratio falling → bullish
    signal[bullish] = 1.0
    # No signal before we have both MAs
    signal[:STRAT_A_MA_LONG] = 0.0

    # ---- 3. Top-N coin selection (30d volume proxy, re-ranked monthly) ----
    # Build daily price matrix for top movers
    # Re-rank: every ~21 days (monthly) re-select top N by trailing 30d avg volume
    rank_dates = list(range(0, n, 21))  # re-rank every 21 trading days

    # Pre-compute 30d rolling avg volume for each symbol (for top-N ranking)
    rolling_vol_30d: dict[str, np.ndarray] = {}
    for sym in symbols:
        qv = quote_vol_arrays.get(sym, np.full(n, np.nan))
        rv = np.full(n, np.nan)
        for i_day in range(30, n):
            window = qv[i_day - 30 : i_day]
            if np.sum(np.isfinite(window)) >= 15:
                rv[i_day] = np.nanmean(window)
        rolling_vol_30d[sym] = rv

    # ---- 4. Walk-forward performance evaluation ----
    windows = []
    daily_strat_returns = np.zeros(n)
    daily_bench_returns = np.zeros(n)
    position = 0.0  # how much of capital deployed (0 = cash, 1 = fully invested)

    # For simplicity, use an equal-weight basket of top-N coins
    # Track portfolio value per day
    portfolio_nav = 1.0
    cash_nav = 1.0
    current_basket: list[str] = []

    for i_day in range(STRAT_A_MA_LONG + 30, n):
        if i_day >= n:
            break

        # Check for re-ranking month boundary
        if i_day in rank_dates or (len(current_basket) == 0 and i_day > STRAT_A_MA_LONG + 30):
            # Re-rank by 30d avg volume
            vol_ranking = []
            for sym in symbols:
                vol = rolling_vol_30d.get(sym, np.full(n, np.nan))
                if np.isfinite(vol[i_day]) and sym != "BTCUSDT":
                    vol_ranking.append((vol[i_day], sym))
            vol_ranking.sort(key=lambda t: -t[0])
            current_basket = [sym for _, sym in vol_ranking[:STRAT_A_TOP_N]]

        # Determine signal and position
        is_bullish = signal[i_day] > 0.5

        if is_bullish and len(current_basket) > 0:
            # Compute portfolio return (equal-weight basket)
            basket_ret = 0.0
            n_in_basket = 0
            for sym in current_basket:
                close_arr = close_arrays.get(sym, np.full(n, np.nan))
                if i_day > 0 and np.isfinite(close_arr[i_day]) and np.isfinite(close_arr[i_day - 1]) and close_arr[i_day - 1] > 0:
                    basket_ret += close_arr[i_day] / close_arr[i_day - 1] - 1.0
                    n_in_basket += 1
            if n_in_basket > 0:
                daily_return = basket_ret / n_in_basket
            else:
                daily_return = 0.0
        else:
            # Cash: 0% return (stablecoin position yields nothing)
            daily_return = 0.0

        # BTC benchmark
        if btc_idx is not None and i_day > 0:
            btc_arr = close_arrays.get("BTCUSDT", np.full(n, np.nan))
            if np.isfinite(btc_arr[i_day]) and np.isfinite(btc_arr[i_day - 1]) and btc_arr[i_day - 1] > 0:
                bench_ret = btc_arr[i_day] / btc_arr[i_day - 1] - 1.0
            else:
                bench_ret = 0.0
        else:
            bench_ret = 0.0

        daily_strat_returns[i_day] = daily_return
        daily_bench_returns[i_day] = bench_ret

    # ---- 5. WFO windows ----
    wfo_windows = []
    train_size = STRAT_A_WFO_TRAIN
    test_size = STRAT_A_WFO_TEST
    step = test_size

    for w_start in range(STRAT_A_MA_LONG + 30, n - train_size - test_size, step):
        train_end = w_start + train_size
        test_start = train_end
        test_end = min(test_start + test_size, n)

        if test_end > n:
            break

        # Train period: compute signal (already done above)
        # Test period: evaluate strategy
        test_returns = daily_strat_returns[test_start:test_end]
        test_bench = daily_bench_returns[test_start:test_end]

        strat_metrics = compute_metrics(test_returns)
        bench_metrics = compute_metrics(test_bench)

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": _ts_to_date(timestamps[w_start]),
            "train_end": _ts_to_date(timestamps[train_end - 1]),
            "test_start": _ts_to_date(timestamps[test_start]),
            "test_end": _ts_to_date(timestamps[test_end - 1]),
            "test_days": int(test_end - test_start),
            "bullish_pct": round(float(np.mean(signal[test_start:test_end] > 0.5)), 4),
            "strategy_return": round(float(np.nansum(test_returns)), 6),
            "benchmark_return": round(float(np.nansum(test_bench)), 6),
            "excess_return": round(float(np.nansum(test_returns) - np.nansum(test_bench)), 6),
            "strategy": strat_metrics,
            "benchmark": bench_metrics,
        })

    # Overall full-period metrics
    valid = np.isfinite(daily_strat_returns)
    overall_strat = compute_metrics(daily_strat_returns[valid])
    overall_bench = compute_metrics(daily_bench_returns[valid])

    # Average ratio stats
    ratio_valid = ratio[np.isfinite(ratio)]
    ratio_mean = float(np.mean(ratio_valid)) if len(ratio_valid) > 0 else 0.0
    ratio_std = float(np.std(ratio_valid, ddof=1)) if len(ratio_valid) > 1 else 0.0

    print(f"  {len(wfo_windows)} WFO windows, {int(np.sum(valid))} trading days")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "Stablecoin rotation: buy top-10 coins when USDTVOL/BTCVOL ratio falling (bullish), cash when rising (bearish)",
        "parameters": {
            "lookback_days": STRAT_A_LOOKBACK,
            "ma_short": STRAT_A_MA_SHORT,
            "ma_long": STRAT_A_MA_LONG,
            "top_n_coins": STRAT_A_TOP_N,
            "wfo_train_days": STRAT_A_WFO_TRAIN,
            "wfo_test_days": STRAT_A_WFO_TEST,
        },
        "usdt_btc_ratio_stats": {
            "mean": round(ratio_mean, 4),
            "std": round(ratio_std, 4),
            "min": round(float(np.nanmin(ratio)), 4),
            "max": round(float(np.nanmax(ratio)), 4),
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY B: Weekend Effect
# ===================================================================

def strategy_b(
    timestamps: list[int],
    close_arrays: dict[str, np.ndarray],
    symbols: list[str],
) -> dict:
    """Weekend effect strategy.

    Hypothesis: weekend (Sat+Sun) volatility is lower than weekday volatility.
    If confirmed → hold through weekends (buy Fri close, sell Mon close).

    WFO: train=365d, test=63d.
    """
    print("\n[Strategy B] Weekend Effect ...")
    n = len(timestamps)

    # ---- 1. Build index of top coins for broad market representation ----
    # Use top 10 non-BTC coins by data completeness
    non_btc = [s for s in symbols if s != "BTCUSDT"]
    # Use first 10 as broad index
    index_syms = non_btc[:min(10, len(non_btc))]
    if "ETHUSDT" in symbols and "ETHUSDT" not in index_syms:
        index_syms.insert(0, "ETHUSDT")
    index_syms = index_syms[:10]

    # Equal-weight index returns
    daily_index_ret = np.full(n, np.nan)
    for i_day in range(1, n):
        rets = []
        for sym in index_syms:
            arr = close_arrays.get(sym, np.full(n, np.nan))
            if np.isfinite(arr[i_day]) and np.isfinite(arr[i_day - 1]) and arr[i_day - 1] > 0:
                rets.append(arr[i_day] / arr[i_day - 1] - 1.0)
        if len(rets) >= 3:
            daily_index_ret[i_day] = float(np.mean(rets))

    # ---- 2. Day-of-week labels ----
    dow = np.full(n, -1, dtype=int)  # 0=Mon, ..., 6=Sun
    for i_day, ts in enumerate(timestamps):
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        dow[i_day] = dt.weekday()  # Monday=0, Sunday=6

    # ---- 3. WFO: train=365d, test=63d ----
    wfo_windows = []
    train_size = STRAT_B_TRAIN
    test_size = STRAT_B_TEST
    step = test_size

    all_daily_ret = daily_index_ret  # use index returns for vol analysis
    all_btc_close = close_arrays.get("BTCUSDT", np.full(n, np.nan))

    for w_start in range(1, n - train_size - test_size, step):
        train_end = w_start + train_size
        test_start = train_end
        test_end = min(test_start + test_size, n)

        if test_end > n:
            break

        # ---- Train: compute weekday vs weekend vol ----
        train_rets = all_daily_ret[w_start:train_end]
        train_dow = dow[w_start:train_end]

        weekend_mask = (train_dow >= 5)  # Sat(5) or Sun(6)
        weekday_mask = (train_dow < 5) & (train_dow >= 0)

        weekend_rets = train_rets[weekend_mask]
        weekday_rets = train_rets[weekday_mask]

        weekend_rets = weekend_rets[np.isfinite(weekend_rets)]
        weekday_rets = weekday_rets[np.isfinite(weekday_rets)]

        weekend_vol = float(np.std(weekend_rets, ddof=1)) if len(weekend_rets) >= 5 else 0.0
        weekday_vol = float(np.std(weekday_rets, ddof=1)) if len(weekday_rets) >= 5 else 0.0

        weekend_vol_annualized = weekend_vol * np.sqrt(365.25)
        weekday_vol_annualized = weekday_vol * np.sqrt(365.25)
        vol_ratio = weekend_vol / weekday_vol if weekday_vol > 0 else float("inf")

        # Decision: if weekend vol < weekday vol, hold through weekends
        hold_weekends = weekend_vol < weekday_vol

        # ---- Test: execute strategy ----
        test_rets = all_daily_ret[test_start:test_end]
        test_dow = dow[test_start:test_end]

        # Strategy: if holding weekends, we buy on Friday and sell on Monday
        # When not holding, we skip the weekend (0 return over weekend)
        strat_rets = np.full(test_end - test_start, np.nan)

        # Compute Friday→Monday returns (hold through weekend)
        for t in range(test_start, test_end):
            i = t - test_start
            dt = datetime.fromtimestamp(timestamps[t] / 1000, tz=timezone.utc)
            # Friday = 4, Saturday = 5, Sunday = 6, Monday = 0
            if dt.weekday() == 4:  # Friday
                # Buy Friday close
                # We need Monday's return: if next day is Monday (skip weekend)
                if t + 3 < test_end and dow[t + 3] == 0:  # Monday is 3 days later
                    buy_val = all_btc_close[t]
                    sell_val = all_btc_close[t + 3]
                    if np.isfinite(buy_val) and np.isfinite(sell_val) and buy_val > 0:
                        strat_rets[i] = sell_val / buy_val - 1.0
                    # Also: the weekend days themselves
                    # Actually, we're holding through weekend, so Friday return is 0 (we don't trade intraday)
                # The weekend return (Fri close to Mon close) is already captured above
            elif dt.weekday() in (0, 1, 2, 3):  # Mon-Thu
                # Weekday: just hold the position (track BTC return)
                if t > test_start and np.isfinite(all_btc_close[t]) and np.isfinite(all_btc_close[t - 1]) and all_btc_close[t - 1] > 0:
                    strat_rets[i] = all_btc_close[t] / all_btc_close[t - 1] - 1.0
                elif t == test_start:
                    strat_rets[i] = 0.0  # flat on first day of test window
            elif dt.weekday() == 5:  # Saturday
                if not hold_weekends:
                    strat_rets[i] = 0.0  # flat if not holding
            elif dt.weekday() == 6:  # Sunday
                if not hold_weekends:
                    strat_rets[i] = 0.0

        # Fill NaN with 0
        strat_rets = np.nan_to_num(strat_rets, nan=0.0)
        bench_rets = np.nan_to_num(test_rets, nan=0.0)

        # For benchmark: also track Friday-to-Monday (buy-and-hold doesn't skip weekends)
        bench_bh = np.nan_to_num(test_rets, nan=0.0)

        strat_metrics = compute_metrics(strat_rets)
        bench_metrics = compute_metrics(bench_bh)

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": _ts_to_date(timestamps[w_start]),
            "train_end": _ts_to_date(timestamps[train_end - 1]),
            "test_start": _ts_to_date(timestamps[test_start]),
            "test_end": _ts_to_date(timestamps[test_end - 1]),
            "test_days": int(test_end - test_start),
            "weekend_vol_ann": round(weekend_vol_annualized, 6),
            "weekday_vol_ann": round(weekday_vol_annualized, 6),
            "weekend_weekday_vol_ratio": round(vol_ratio, 4),
            "hold_weekends": hold_weekends,
            "friday_count": int(np.sum(dow[test_start:test_end] == 4)),
            "strategy_return": round(float(np.nansum(strat_rets)), 6),
            "benchmark_return": round(float(np.nansum(bench_bh)), 6),
            "excess_return": round(float(np.nansum(strat_rets) - np.nansum(bench_bh)), 6),
            "strategy": strat_metrics,
            "benchmark": bench_metrics,
        })

    # Overall full-period
    # Re-run full-period strategy for overall metrics
    full_strat = np.zeros(n)
    full_bench = np.zeros(n)
    for t in range(1, n):
        dt = datetime.fromtimestamp(timestamps[t] / 1000, tz=timezone.utc)
        if dt.weekday() == 4 and t + 3 < n:  # Friday
            if np.isfinite(all_btc_close[t]) and np.isfinite(all_btc_close[t + 3]) and all_btc_close[t] > 0:
                full_strat[t] = all_btc_close[t + 3] / all_btc_close[t] - 1.0
        elif dt.weekday() in (0, 1, 2, 3) and t > 0:
            if np.isfinite(all_btc_close[t]) and np.isfinite(all_btc_close[t - 1]) and all_btc_close[t - 1] > 0:
                full_strat[t] = all_btc_close[t] / all_btc_close[t - 1] - 1.0
        # Saturday/Sunday: flat
        if np.isfinite(daily_index_ret[t]):
            full_bench[t] = daily_index_ret[t]

    full_valid = np.isfinite(full_strat)
    overall_strat = compute_metrics(full_strat[full_valid])
    overall_bench = compute_metrics(full_bench[np.isfinite(full_bench)])

    print(f"  {len(wfo_windows)} WFO windows")
    print(f"  Weekday vol: {np.mean([w['weekday_vol_ann'] for w in wfo_windows]):.4f}, "
          f"Weekend vol: {np.mean([w['weekend_vol_ann'] for w in wfo_windows]):.4f}")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")

    return {
        "description": "Weekend effect: hold BTC through weekends if weekend vol < weekday vol (buy Fri, sell Mon)",
        "parameters": {
            "wfo_train_days": STRAT_B_TRAIN,
            "wfo_test_days": STRAT_B_TEST,
            "index_symbols": index_syms,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_index": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY C: BTC as Predictor
# ===================================================================

def strategy_c(
    timestamps: list[int],
    close_arrays: dict[str, np.ndarray],
    quote_vol_arrays: dict[str, np.ndarray],
    symbols: list[str],
) -> dict:
    """BTC 7d return momentum spillover to altcoins.

      - If BTC 7d return > +5% → buy top 10 altcoins (momentum spillover)
      - If BTC 7d return < -5% → sell all altcoins (risk off)
      - Otherwise → hold previous position (momentum persists)
      - Weekly rebalance
    """
    print("\n[Strategy C] BTC as Predictor ...")
    n = len(timestamps)

    btc_arr = close_arrays.get("BTCUSDT", np.full(n, np.nan))

    # 7d rolling BTC return
    btc_7d_ret = np.full(n, np.nan)
    for i in range(7, n):
        if np.isfinite(btc_arr[i]) and np.isfinite(btc_arr[i - 7]) and btc_arr[i - 7] > 0:
            btc_7d_ret[i] = btc_arr[i] / btc_arr[i - 7] - 1.0

    # Weekly rebalance schedule
    rebalance_indices = list(range(0, n, STRAT_C_REBALANCE_DAYS))

    # Top-10 altcoins by 30d avg volume (re-ranked every rebalance)
    altcoins = [s for s in symbols if s != "BTCUSDT"]

    # Pre-compute 30d rolling avg volume
    rolling_vol_30d: dict[str, np.ndarray] = {}
    for sym in altcoins:
        qv = quote_vol_arrays.get(sym, np.full(n, np.nan))
        rv = np.full(n, np.nan)
        for i_day in range(30, n):
            window = qv[i_day - 30 : i_day]
            if np.sum(np.isfinite(window)) >= 15:
                rv[i_day] = np.nanmean(window)
        rolling_vol_30d[sym] = rv

    # ---- WFO: rolling windows ----
    wfo_windows = []
    train_size = 180
    test_size = 63
    step = test_size

    for w_start in range(7, n - train_size - test_size, step):
        train_end = w_start + train_size
        test_start = train_end
        test_end = min(test_start + test_size, n)

        if test_end > n:
            break

        # Signals: -1 = risk off (sell all), 0 = hold, 1 = buy top alts
        # Use state machine: "hold" (0) carries forward the previous non-neutral signal
        raw_signal = np.zeros(n)
        for i in range(7, n):
            if np.isfinite(btc_7d_ret[i]):
                if btc_7d_ret[i] > STRAT_C_BTC_THRESHOLD:
                    raw_signal[i] = 1.0
                elif btc_7d_ret[i] < -STRAT_C_BTC_THRESHOLD:
                    raw_signal[i] = -1.0
                # else stays 0.0

        # Carry forward: when signal is 0 (hold), keep previous non-zero position
        effective_signal = np.zeros(n)
        last_nonzero = 0.0  # default: out of market
        for i in range(7, n):
            if raw_signal[i] != 0.0:
                effective_signal[i] = raw_signal[i]
                last_nonzero = raw_signal[i]
            else:
                effective_signal[i] = last_nonzero

        # Execute on test period
        test_signals = effective_signal[test_start:test_end]
        test_btc_ret = btc_7d_ret[test_start:test_end]

        # Track portfolio
        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        current_alts: list[str] = []
        trades = 0

        for t_rel in range(7, len(port_ret)):
            t_abs = test_start + t_rel
            sig = test_signals[t_rel]

            # Re-rank altcoins on test_start and every rebalance
            if (t_abs in rebalance_indices) or (len(current_alts) == 0):
                vol_ranking = []
                for sym in altcoins:
                    vol = rolling_vol_30d.get(sym, np.full(n, np.nan))
                    if np.isfinite(vol[t_abs]):
                        vol_ranking.append((vol[t_abs], sym))
                vol_ranking.sort(key=lambda tup: -tup[0])
                current_alts = [s for _, s in vol_ranking[:STRAT_C_TOP_N]]
                trades += 1

            if sig > 0.5:  # Buy top alts
                rets = []
                for sym in current_alts:
                    arr = close_arrays.get(sym, np.full(n, np.nan))
                    if t_abs > 0 and np.isfinite(arr[t_abs]) and np.isfinite(arr[t_abs - 1]) and arr[t_abs - 1] > 0:
                        rets.append(arr[t_abs] / arr[t_abs - 1] - 1.0)
                port_ret[t_rel] = float(np.mean(rets)) if len(rets) >= 3 else 0.0
            else:  # Risk off (sig < -0.5 or 0 carry-forward from risk-off position) → cash
                port_ret[t_rel] = 0.0

            # BTC benchmark
            if np.isfinite(btc_arr[t_abs]) and np.isfinite(btc_arr[t_abs - 1]) and btc_arr[t_abs - 1] > 0:
                bench_ret[t_rel] = btc_arr[t_abs] / btc_arr[t_abs - 1] - 1.0

        # Apply trading costs
        cost_per_trade = COST_BPS / 10_000
        port_ret -= cost_per_trade * (trades / max(1, len(port_ret)))

        strat_metrics = compute_metrics(port_ret)
        bench_metrics = compute_metrics(bench_ret)

        # Count signal types
        n_bullish = int(np.sum(effective_signal[test_start:test_end] > 0.5))
        n_bearish = int(np.sum(effective_signal[test_start:test_end] < -0.5))
        n_neutral = int(np.sum(np.abs(effective_signal[test_start:test_end]) <= 0.5))

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": _ts_to_date(timestamps[w_start]),
            "train_end": _ts_to_date(timestamps[train_end - 1]),
            "test_start": _ts_to_date(timestamps[test_start]),
            "test_end": _ts_to_date(timestamps[test_end - 1]),
            "test_days": int(test_end - test_start),
            "n_bullish_days": n_bullish,
            "n_bearish_days": n_bearish,
            "n_neutral_days": n_neutral,
            "avg_btc_7d_return": round(float(np.nanmean(test_btc_ret)), 6),
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_metrics,
            "benchmark": bench_metrics,
        })

    # Quick full-period summary with dynamic ranking (same as WFO)
    all_port = np.zeros(n)
    all_bench = np.zeros(n)
    current_alts_full: list[str] = []

    # Recompute raw signal for full period
    full_raw = np.zeros(n)
    for i in range(7, n):
        if np.isfinite(btc_7d_ret[i]):
            if btc_7d_ret[i] > STRAT_C_BTC_THRESHOLD:
                full_raw[i] = 1.0
            elif btc_7d_ret[i] < -STRAT_C_BTC_THRESHOLD:
                full_raw[i] = -1.0

    full_effective_signal = np.zeros(n)
    full_last_nonzero = 0.0
    for i in range(7, n):
        if full_raw[i] != 0.0:
            full_effective_signal[i] = full_raw[i]
            full_last_nonzero = full_raw[i]
        else:
            full_effective_signal[i] = full_last_nonzero

    rebalance_idx = 0
    for t in range(7, n):
        if t in rebalance_indices or len(current_alts_full) == 0:
            vol_ranking = []
            for sym in altcoins:
                vol = rolling_vol_30d.get(sym, np.full(n, np.nan))
                if np.isfinite(vol[t]):
                    vol_ranking.append((vol[t], sym))
            vol_ranking.sort(key=lambda tup: -tup[0])
            current_alts_full = [s for _, s in vol_ranking[:STRAT_C_TOP_N]]
            rebalance_idx += 1

        sig = full_effective_signal[t]

        if sig > 0.5:
            rets = []
            for sym in current_alts_full:
                arr = close_arrays.get(sym, np.full(n, np.nan))
                if t > 0 and np.isfinite(arr[t]) and np.isfinite(arr[t - 1]) and arr[t - 1] > 0:
                    rets.append(arr[t] / arr[t - 1] - 1.0)
            all_port[t] = float(np.mean(rets)) if len(rets) >= 3 else 0.0
        else:  # Risk off → cash
            all_port[t] = 0.0

        if np.isfinite(btc_arr[t]) and np.isfinite(btc_arr[t - 1]) and btc_arr[t - 1] > 0:
            all_bench[t] = btc_arr[t] / btc_arr[t - 1] - 1.0

    overall_strat = compute_metrics(all_port[7:])
    overall_bench = compute_metrics(all_bench[7:])

    print(f"  {len(wfo_windows)} WFO windows")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "BTC 7d return predicts altcoins: buy top 10 when BTC >5%, sell all when BTC <-5%, hold otherwise",
        "parameters": {
            "btc_return_threshold": STRAT_C_BTC_THRESHOLD,
            "top_n_altcoins": STRAT_C_TOP_N,
            "rebalance_days": STRAT_C_REBALANCE_DAYS,
            "wfo_train_days": train_size,
            "wfo_test_days": test_size,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY D: Volume Divergence
# ===================================================================

def strategy_d(
    timestamps: list[int],
    close_arrays: dict[str, np.ndarray],
    volume_arrays: dict[str, np.ndarray],
    symbols: list[str],
) -> dict:
    """Volume divergence strategy.

    volume_divergence_score = -corr(price_return, volume_return) over rolling window.
    - High score = price and volume moving in opposite directions → mean-reversion signal
    - Buy top 25% by divergence score
    - Rebalance every 21 trading days
    """
    print("\n[Strategy D] Volume Divergence ...")
    n = len(timestamps)
    lb = STRAT_D_LOOKBACK
    top_pct = STRAT_D_TOP_PCT

    # Non-BTC, non-leveraged coins
    tradeable = [s for s in symbols if s != "BTCUSDT"]

    # ---- 1. Compute divergence score for each symbol ----
    # volume_divergence_score[t][sym] = -corr(price_ret[prev], vol_change[prev]) over lookback
    # where vol_change = log(volume[t] / volume[t-1])
    divergence_scores: dict[str, np.ndarray] = {}
    for sym in tradeable:
        close_arr = close_arrays.get(sym, np.full(n, np.nan))
        vol_arr = volume_arrays.get(sym, np.full(n, np.nan))

        daily_ret = np.full(n, np.nan)
        vol_change = np.full(n, np.nan)
        for i in range(1, n):
            if np.isfinite(close_arr[i]) and np.isfinite(close_arr[i - 1]) and close_arr[i - 1] > 0:
                daily_ret[i] = close_arr[i] / close_arr[i - 1] - 1.0
            if np.isfinite(vol_arr[i]) and np.isfinite(vol_arr[i - 1]) and vol_arr[i - 1] > 0:
                vol_change[i] = np.log(vol_arr[i] / vol_arr[i - 1])

        scores = np.full(n, np.nan)
        for i in range(lb + 1, n):
            ret_window = daily_ret[i - lb : i]
            vol_window = vol_change[i - lb : i]
            valid = np.isfinite(ret_window) & np.isfinite(vol_window)
            if np.sum(valid) >= lb // 2:
                corr = np.corrcoef(ret_window[valid], vol_window[valid])[0, 1]
                scores[i] = -corr  # high score = divergence

        divergence_scores[sym] = scores
        # Clean up non-finite scores at the end for this sym

    # ---- 2. WFO: rolling windows ----
    wfo_windows = []
    train_size = 90
    test_size = 63
    step = test_size

    for w_start in range(lb + 5, n - train_size - test_size, step):
        train_end = w_start + train_size
        test_start = train_end
        test_end = min(test_start + test_size, n)

        if test_end > n:
            break

        # Score at test_start determines initial position
        # Rebalance every 21 days within test window

        # Execute test period
        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        rebalance_dates = list(range(test_start, test_end, 21))
        trades = 0

        for t_abs in range(test_start, test_end):
            t_rel = t_abs - test_start

            # Check rebalance
            if t_abs in rebalance_dates or t_rel == 0:
                # Rank all symbols by divergence score
                ranked = []
                for sym in tradeable:
                    scores = divergence_scores.get(sym, np.full(n, np.nan))
                    if np.isfinite(scores[t_abs]):
                        ranked.append((scores[t_abs], sym))
                ranked.sort(key=lambda tup: -tup[0])  # descending score
                n_top = max(1, int(len(ranked) * top_pct))
                top_divergent = [sym for _, sym in ranked[:n_top]]
                trades += 1
            else:
                top_divergent = top_divergent if 'top_divergent' in dir() else []

            # Equal-weight return of top divergent coins
            if len(top_divergent) > 0:
                rets = []
                for sym in top_divergent:
                    arr = close_arrays.get(sym, np.full(n, np.nan))
                    if t_abs > 0 and np.isfinite(arr[t_abs]) and np.isfinite(arr[t_abs - 1]) and arr[t_abs - 1] > 0:
                        rets.append(arr[t_abs] / arr[t_abs - 1] - 1.0)
                port_ret[t_rel] = float(np.mean(rets)) if len(rets) >= 3 else 0.0
            else:
                port_ret[t_rel] = 0.0

            # BTC benchmark
            btc_arr = close_arrays.get("BTCUSDT", np.full(n, np.nan))
            if t_abs > 0 and np.isfinite(btc_arr[t_abs]) and np.isfinite(btc_arr[t_abs - 1]) and btc_arr[t_abs - 1] > 0:
                bench_ret[t_rel] = btc_arr[t_abs] / btc_arr[t_abs - 1] - 1.0

        cost_per_trade = COST_BPS / 10_000
        port_ret -= cost_per_trade * (trades / max(1, len(port_ret)))

        strat_metrics = compute_metrics(port_ret)
        bench_metrics = compute_metrics(bench_ret)

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": _ts_to_date(timestamps[w_start]),
            "train_end": _ts_to_date(timestamps[train_end - 1]),
            "test_start": _ts_to_date(timestamps[test_start]),
            "test_end": _ts_to_date(timestamps[test_end - 1]),
            "test_days": int(test_end - test_start),
            "n_top_divergent": n_top if 'n_top' in dir() else 0,
            "n_trades": trades,
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_metrics,
            "benchmark": bench_metrics,
        })

    # Full-period summary
    full_port = np.zeros(n)
    full_bench = np.zeros(n)
    for t in range(lb + 5, n):
        ranked = []
        for sym in tradeable:
            scores = divergence_scores.get(sym, np.full(n, np.nan))
            if np.isfinite(scores[t]):
                ranked.append((scores[t], sym))
        ranked.sort(key=lambda tup: -tup[0])
        n_top = max(1, int(len(ranked) * top_pct))
        top_div = [sym for _, sym in ranked[:n_top]]

        if len(top_div) > 0:
            rets = []
            for sym in top_div:
                arr = close_arrays.get(sym, np.full(n, np.nan))
                if t > 0 and np.isfinite(arr[t]) and np.isfinite(arr[t - 1]) and arr[t - 1] > 0:
                    rets.append(arr[t] / arr[t - 1] - 1.0)
            full_port[t] = float(np.mean(rets)) if len(rets) >= 3 else 0.0

        btc_arr = close_arrays.get("BTCUSDT", np.full(n, np.nan))
        if t > 0 and np.isfinite(btc_arr[t]) and np.isfinite(btc_arr[t - 1]) and btc_arr[t - 1] > 0:
            full_bench[t] = btc_arr[t] / btc_arr[t - 1] - 1.0

    overall_strat = compute_metrics(full_port[lb + 5 :])
    overall_bench = compute_metrics(full_bench[lb + 5 :])

    print(f"  {len(wfo_windows)} WFO windows")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "Volume divergence: buy top 25% coins by -corr(price_return, volume_change) — mean reversion signal",
        "parameters": {
            "lookback_days": STRAT_D_LOOKBACK,
            "top_pct": STRAT_D_TOP_PCT,
            "wfo_train_days": train_size,
            "wfo_test_days": test_size,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# Main
# ===================================================================

def main():
    start_ms = _ms(START_DATE)
    end_ms = _ms(END_DATE)

    # ---- 1. Discover universe ----
    print(f"Discovering symbols with >= 12 months of data ...")
    symbols = discover_symbols(min_months=12, top_n=TOP_N_UNIVERSE)
    print(f"  Found {len(symbols)} symbols")
    if not symbols:
        print("ERROR: no symbols found. Check DATA_ROOT.", file=sys.stderr)
        sys.exit(1)

    # Ensure BTCUSDT is present
    if "BTCUSDT" not in symbols:
        symbols.insert(0, "BTCUSDT")

    # ---- 2. Load kline data: close, volume, quote_volume ----
    print(f"Loading kline data for {len(symbols)} symbols from {START_DATE} to {END_DATE} ...")
    data = load_multi_klines(symbols, start_ms, end_ms, cols=(0, 4, 5, 7))
    # cols: 0=time, 4=close, 5=volume, 7=quote_volume

    # Build timeline with close (col 0 of requested = close)
    print("Building unified timeline ...")
    timestamps, close_arrays = build_timeline(data, start_ms, end_ms)
    n = len(timestamps)
    print(f"  {n} trading days ({_ts_to_date(timestamps[0])} to {_ts_to_date(timestamps[-1])})")

    # Build volume and quote_volume arrays
    vol_arrays: dict[str, np.ndarray] = {}
    qv_arrays: dict[str, np.ndarray] = {}
    ts_set = set(timestamps)
    for sym, sym_data in data.items():
        v_arr = np.full(n, np.nan)
        qv_arr = np.full(n, np.nan)
        for ts, vals in sym_data.items():
            if ts in ts_set:
                idx = timestamps.index(ts)
                v_arr[idx] = vals[1] if len(vals) > 1 else np.nan    # volume
                qv_arr[idx] = vals[2] if len(vals) > 2 else np.nan   # quote_volume
        vol_arrays[sym] = v_arr
        qv_arrays[sym] = qv_arr

    # ---- 3. Run strategies ----
    results = {}

    results["A_stablecoin_rotation"] = strategy_a(
        timestamps, close_arrays, qv_arrays, symbols
    )

    results["B_weekend_effect"] = strategy_b(
        timestamps, close_arrays, symbols
    )

    results["C_btc_predictor"] = strategy_c(
        timestamps, close_arrays, qv_arrays, symbols
    )

    results["D_volume_divergence"] = strategy_d(
        timestamps, close_arrays, vol_arrays, symbols
    )

    # ---- 4. Build report ----
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": {
            "data_source": "Binance daily klines (ZIP) — 120+ USDT pairs",
            "period": f"{START_DATE} to {END_DATE}",
            "universe_size": len(symbols),
            "cost_bps": COST_BPS,
        },
        "strategies": results,
    }

    # ---- 5. Write output ----
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n{'=' * 60}")
    print(f"Report written to: {OUTPUT_PATH}")
    print(f"{'=' * 60}")

    # Print summary
    for sname, sresult in results.items():
        fp = sresult.get("full_period", {})
        strategy_label = sname.split("_", 1)[1].replace("_", " ").title()
        strat = fp.get("strategy", {})
        bench = fp.get("benchmark_btc") or fp.get("benchmark_index") or fp.get("benchmark", {})
        wfo = sresult.get("wfo_windows", [])
        n_windows = len(wfo)
        avg_excess = float(np.mean([w.get("excess_return", 0.0) for w in wfo])) if wfo else 0.0
        print(f"\n[{sname[0]}] {strategy_label}")
        print(f"  WFO windows: {n_windows}")
        print(f"  Strategy: {strat.get('annualized_return', 'N/A')} ann ret, "
              f"Sharpe {strat.get('sharpe_ratio', 'N/A')}, "
              f"DD {strat.get('max_drawdown_pct', 'N/A')}")
        print(f"  Benchmark: {bench.get('annualized_return', 'N/A')} ann ret")
        if avg_excess != 0.0:
            print(f"  Avg excess return (WFO): {avg_excess:.4%}")


if __name__ == "__main__":
    main()
