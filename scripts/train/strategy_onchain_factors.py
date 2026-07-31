#!/usr/bin/env python3
"""
Strategy backtesting using on-chain factors from Coin Metrics + daily klines.

Four strategies tested with Walk-Forward Optimization (WFO-Lite):

  A - BTC on-chain momentum: active address (AdrActCnt) 30d growth
  B - Fee revenue proxy: FeeTotUSD 30d growth
  C - NVT ratio: CapMrktCurUSD / FeeTotUSD percentile-based signals
  D - Combined on-chain + adaptive low-vol

Data:
  - On-chain: asset_metrics_1d.jsonl (BTC + ETH daily metrics)
  - Daily klines: spot-all-usdt-klines-1d/ (24 mainstream coins)
  - BTC on-chain signals used as market-wide indicator for altcoin universe

Output: data/research/strategy_onchain_factors_report.json
No secrets, no API calls. Read-only on ZIP files and JSONL.
"""

import json
import os
import sys
import warnings
import zipfile
from collections import defaultdict
from datetime import datetime, timezone

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
ONCHAIN_PATH = (
    "/Volumes/shield/cryptoData/openalice-data/onchain/coinmetrics"
    "/asset_metrics_1d.jsonl"
)
START_DATE = "2018-01-01"
END_DATE = "2026-04-30"
N_SYMBOLS = 24
MIN_MONTHS = 36
LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")
COST_BPS = 15
REBALANCE_DAYS = 21
TOP_N_TO_HOLD = 10         # number of altcoins in basket when bullish

# WFO-Lite
WFO_TRAIN = 365
WFO_TEST = 63
WFO_STEP = 21

# On-chain signal thresholds
ACTIVE_ADDR_CHANGE_LOOKBACK = 30
ACTIVE_ADDR_BUY_THRESHOLD = 0.05       # >5% 30d growth → buy
FEE_CHANGE_LOOKBACK = 30
FEE_BUY_THRESHOLD = 0.10               # >10% 30d fee growth → buy
FEE_SELL_THRESHOLD = 0.0               # <0% fee growth → sell
NVT_LOOKBACK = 365                     # percentile window (WFO train)
NVT_OVERBOUGHT_PCT = 90
NVT_OVERSOLD_PCT = 10
LOW_VOL_LOOKBACK = 21                  # rolling volatility window for Strat D

OUTPUT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "research", "strategy_onchain_factors_report.json",
)

# ---------------------------------------------------------------------------
# Timestamp / Date Helpers
# ---------------------------------------------------------------------------

def _ms(date_str: str) -> int:
    """ISO date string -> millisecond UTC timestamp."""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _ts_to_date(ts: int) -> str:
    """Convert timestamp int (13-digit ms or 16-digit us) to YYYY-MM-DD string."""
    if ts > 1e15:  # 16+ digits → microseconds
        ts_s = ts / 1_000_000
    else:  # 13 digits → milliseconds
        ts_s = ts / 1000
    return datetime.fromtimestamp(ts_s, tz=timezone.utc).strftime("%Y-%m-%d")


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
# Performance Metrics
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


# ---------------------------------------------------------------------------
# Data Loading: Coin Metrics (on-chain)
# ---------------------------------------------------------------------------

def load_coinmetrics(path: str, assets: tuple = ("btc",)) -> dict[str, dict[str, dict]]:
    """Load on-chain data from Coin Metrics JSONL file.

    Returns {date_str: {asset_str: {field: value}}}.
    Fields are stored as strings in JSONL; converted to float where possible.
    """
    cm_data: dict[str, dict[str, dict]] = {}
    asset_set = set(assets)

    with open(path, "r") as f:
        for line in f:
            record = json.loads(line)
            payload = record.get("payload", {})
            asset = payload.get("asset")
            if asset not in asset_set:
                continue
            time_str = payload.get("time", "")[:10]  # "2010-01-01"
            if len(time_str) != 10:
                continue

            fields = {}
            for k, v in payload.items():
                if k in ("asset", "time"):
                    continue
                if v is None:
                    fields[k] = np.nan
                else:
                    try:
                        fields[k] = float(v)
                    except (ValueError, TypeError):
                        fields[k] = np.nan

            if time_str not in cm_data:
                cm_data[time_str] = {}
            cm_data[time_str][asset] = fields

    return cm_data


# ---------------------------------------------------------------------------
# Data Loading: Binance Daily Klines
# ---------------------------------------------------------------------------

def discover_symbols(n_symbols: int = N_SYMBOLS) -> list[str]:
    """Return top *n_symbols* spot symbols with >= MIN_MONTHS of daily data.

    Excludes leveraged tokens. Sorted by data completeness descending.
    """
    candidates: list[tuple[int, str]] = []
    for sym in sorted(os.listdir(DATA_ROOT)):
        sym_path = os.path.join(DATA_ROOT, sym, "1d")
        if not os.path.isdir(sym_path):
            continue
        if any(sym.endswith(pat) for pat in LEVERAGED_PATTERNS):
            continue
        zip_count = sum(1 for f in os.listdir(sym_path) if f.endswith(".zip"))
        if zip_count >= MIN_MONTHS:
            candidates.append((zip_count, sym))
    candidates.sort(key=lambda t: (-t[0], t[1]))
    selected = [sym for _, sym in candidates[:n_symbols]]
    # Ensure BTCUSDT is present
    if "BTCUSDT" not in selected:
        selected.insert(0, "BTCUSDT")
    return selected


def load_klines_dates(
    symbol: str, start_ms: int, end_ms: int,
) -> dict[str, list[float]]:
    """Load daily kline close + quote_volume for a symbol, keyed by date string.

    Returns {date_str: [close, quote_volume]} for days within start_ms..end_ms.
    Handles both 13-digit (ms) and 16-digit (us) kline timestamps.
    """
    result: dict[str, list[float]] = {}
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
            if len(parts) < 8:
                continue
            try:
                ts = int(parts[0])
            except (ValueError, IndexError):
                continue

            # Adaptive timestamp parsing
            ts_s = ts / 1_000_000 if ts > 1e15 else ts / 1000
            if ts_s < start_ms / 1000 or ts_s > end_ms / 1000:
                continue

            close = float(parts[4]) if parts[4] else np.nan
            quote_vol = float(parts[7]) if len(parts) > 7 and parts[7] else np.nan
            date_str = datetime.fromtimestamp(ts_s, tz=timezone.utc).strftime("%Y-%m-%d")
            result[date_str] = [close, quote_vol]
    return result


def load_multi_klines_dates(
    symbols: list[str], start_ms: int, end_ms: int,
) -> dict[str, dict[str, list[float]]]:
    """Load klines for multiple symbols.

    Returns {symbol: {date_str: [close, quote_vol]}}.
    """
    data: dict[str, dict[str, list[float]]] = {}
    for i, sym in enumerate(symbols):
        data[sym] = load_klines_dates(sym, start_ms, end_ms)
        if (i + 1) % 10 == 0:
            print(f"  loaded {i + 1}/{len(symbols)} symbols ...", file=sys.stderr)
    return data


# ---------------------------------------------------------------------------
# Build unified timeline (date-str keyed)
# ---------------------------------------------------------------------------

def build_aligned_timeline(
    klines_data: dict[str, dict[str, list[float]]],
    cm_data: dict[str, dict[str, dict]],
    start_date: str,
    end_date: str,
) -> tuple[list[str], dict[str, np.ndarray], dict]:
    """Align klines and coinmetrics data on a shared day grid.

    Returns:
      dates: sorted list of date strings in the shared timeline
      close_arrays: {symbol: np.array(n_days)} of close prices
      cm_signal_arrays: dict of on-chain field arrays keyed by asset and field
    """
    # Collect all dates present in klines data (at least some coins)
    kline_dates: set[str] = set()
    for sym_data in klines_data.values():
        kline_dates.update(sym_data.keys())

    # Also include coinmetrics dates that fall in our range
    cm_dates = {d for d in cm_data if start_date <= d <= end_date}

    shared = sorted(kline_dates & cm_dates)
    # Only keep dates >= start_date and <= end_date
    shared = [d for d in shared if start_date <= d <= end_date]
    n = len(shared)

    if n == 0:
        return [], {}, {}

    # Build close arrays for each symbol
    close_arrays: dict[str, np.ndarray] = {}
    for sym, sym_data in klines_data.items():
        arr = np.full(n, np.nan)
        for i, d in enumerate(shared):
            vals = sym_data.get(d)
            if vals and np.isfinite(vals[0]):
                arr[i] = vals[0]
        close_arrays[sym] = arr

    # Build quote_volume arrays for ranking
    qv_arrays: dict[str, np.ndarray] = {}
    for sym, sym_data in klines_data.items():
        arr = np.full(n, np.nan)
        for i, d in enumerate(shared):
            vals = sym_data.get(d)
            if vals and len(vals) > 1 and np.isfinite(vals[1]):
                arr[i] = vals[1]
        qv_arrays[sym] = arr

    # Build on-chain signal arrays per asset
    cm_signal_arrays: dict = {}
    for asset in cm_data[next(iter(cm_data))].keys() if cm_data else []:
        for field in ["AdrActCnt", "CapMrktCurUSD", "FeeTotNtv", "PriceUSD", "TxCnt"]:
            key = f"{asset}_{field}"
            arr = np.full(n, np.nan)
            for i, d in enumerate(shared):
                asset_data = cm_data.get(d, {}).get(asset, {})
                val = asset_data.get(field, np.nan)
                if np.isfinite(val):
                    arr[i] = val
            cm_signal_arrays[key] = arr

    return shared, close_arrays, cm_signal_arrays, qv_arrays


# ---------------------------------------------------------------------------
# On-Chain Signal Computation
# ---------------------------------------------------------------------------

def compute_onchain_signals(
    cm_signal_arrays: dict,
    n: int,
) -> dict[str, np.ndarray]:
    """Compute derived on-chain signals from raw Coin Metrics fields.

    Returns dict of arrays:
      btc_adr_change_30d  - AdrActCnt 30d % change
      btc_fee_tot_usd     - FeeTotNtv * PriceUSD
      btc_fee_change_30d  - FeeTotUSD 30d % change
      btc_nvt             - CapMrktCurUSD / max(FeeTotUSD, 1)
      btc_price_30d_ret   - PriceUSD 30d return
      btc_vol_30d         - 30d rolling volatility of PriceUSD returns
      eth_*               - Same for ETH (where available)
    """
    signals: dict[str, np.ndarray] = {}

    for prefix in ("btc", "eth"):
        adr = cm_signal_arrays.get(f"{prefix}_AdrActCnt", np.full(n, np.nan))
        cap = cm_signal_arrays.get(f"{prefix}_CapMrktCurUSD", np.full(n, np.nan))
        fee = cm_signal_arrays.get(f"{prefix}_FeeTotNtv", np.full(n, np.nan))
        price = cm_signal_arrays.get(f"{prefix}_PriceUSD", np.full(n, np.nan))
        txc = cm_signal_arrays.get(f"{prefix}_TxCnt", np.full(n, np.nan))

        # Derived: FeeTotUSD = FeeTotNtv * PriceUSD
        fee_usd = np.full(n, np.nan)
        for i in range(n):
            if np.isfinite(fee[i]) and np.isfinite(price[i]) and price[i] > 0:
                fee_usd[i] = fee[i] * price[i]
        signals[f"{prefix}_fee_tot_usd"] = fee_usd

        # AdrActCnt 30d change
        adr_change = np.full(n, np.nan)
        for i in range(ACTIVE_ADDR_CHANGE_LOOKBACK, n):
            if np.isfinite(adr[i]) and np.isfinite(adr[i - ACTIVE_ADDR_CHANGE_LOOKBACK]) and adr[i - ACTIVE_ADDR_CHANGE_LOOKBACK] > 0:
                adr_change[i] = adr[i] / adr[i - ACTIVE_ADDR_CHANGE_LOOKBACK] - 1.0
        signals[f"{prefix}_adr_change_30d"] = adr_change

        # FeeTotUSD 30d change
        fee_change = np.full(n, np.nan)
        for i in range(FEE_CHANGE_LOOKBACK, n):
            if np.isfinite(fee_usd[i]) and np.isfinite(fee_usd[i - FEE_CHANGE_LOOKBACK]) and fee_usd[i - FEE_CHANGE_LOOKBACK] > 0:
                fee_change[i] = fee_usd[i] / fee_usd[i - FEE_CHANGE_LOOKBACK] - 1.0
        signals[f"{prefix}_fee_change_30d"] = fee_change

        # NVT proxy: CapMrktCurUSD / max(FeeTotUSD, 1)
        nvt = np.full(n, np.nan)
        for i in range(n):
            if np.isfinite(cap[i]) and np.isfinite(fee_usd[i]) and fee_usd[i] > 0:
                nvt[i] = cap[i] / fee_usd[i]
        signals[f"{prefix}_nvt"] = nvt

        # PriceUSD 30d return (for regime detection)
        price_30d = np.full(n, np.nan)
        for i in range(30, n):
            if np.isfinite(price[i]) and np.isfinite(price[i - 30]) and price[i - 30] > 0:
                price_30d[i] = price[i] / price[i - 30] - 1.0
        signals[f"{prefix}_price_30d_ret"] = price_30d

        # Daily price return (for volatility computation)
        daily_ret = np.full(n, np.nan)
        for i in range(1, n):
            if np.isfinite(price[i]) and np.isfinite(price[i - 1]) and price[i - 1] > 0:
                daily_ret[i] = price[i] / price[i - 1] - 1.0

        # 30d rolling volatility (annualized)
        vol_30d = np.full(n, np.nan)
        for i in range(30, n):
            segment = daily_ret[i - 29:i + 1]
            valid = segment[np.isfinite(segment)]
            if len(valid) >= 15:
                vol_30d[i] = float(np.std(valid, ddof=1) * np.sqrt(365.25))
        signals[f"{prefix}_vol_30d"] = vol_30d

    return signals


# ---------------------------------------------------------------------------
# Rolling 30d avg quote volume (for top-N basket selection)
# ---------------------------------------------------------------------------

def build_rolling_vol_30d(
    qv_arrays: dict[str, np.ndarray], n: int,
) -> dict[str, np.ndarray]:
    """Compute 30d rolling avg quote volume for each symbol."""
    rolling: dict[str, np.ndarray] = {}
    for sym, qv in qv_arrays.items():
        rv = np.full(n, np.nan)
        for i in range(30, n):
            window = qv[i - 30:i]
            if np.sum(np.isfinite(window)) >= 15:
                rv[i] = np.nanmean(window)
        rolling[sym] = rv
    return rolling


# ---------------------------------------------------------------------------
# Basket return helper
# ---------------------------------------------------------------------------

def basket_equal_weight_return(
    close_arrays: dict[str, np.ndarray],
    symbols: list[str],
    i_day: int,
) -> float:
    """Return equal-weight daily return for a basket of symbols."""
    rets = []
    for sym in symbols:
        arr = close_arrays.get(sym, np.full(close_arrays.get(next(iter(close_arrays)), np.array([])).size, np.nan))
        if i_day > 0 and np.isfinite(arr[i_day]) and np.isfinite(arr[i_day - 1]) and arr[i_day - 1] > 0:
            rets.append(arr[i_day] / arr[i_day - 1] - 1.0)
    if not rets:
        return 0.0
    return float(np.mean(rets))


# ===================================================================
# STRATEGY A: BTC On-Chain Momentum (Active Address Growth)
# ===================================================================

def strategy_a_onchain_momentum(
    dates: list[str],
    close_arrays: dict[str, np.ndarray],
    qv_arrays: dict[str, np.ndarray],
    symbols: list[str],
    signals: dict[str, np.ndarray],
) -> dict:
    """Strategy A: BTC active address 30d growth as market signal.

    Signal logic:
      - AdrActCnt 30d change > 5% → bullish (buy top-10 altcoin basket)
      - Else → cash (flat)
    WFO-Lite: train=365d, test=63d, step=21d.

    Note: Signal thresholds are fixed (not trained), but WFO validates
    consistency across multiple out-of-sample periods.
    """
    print("\n[Strategy A] BTC On-Chain Momentum (Active Addresses) ...")
    n = len(dates)
    adr_change = signals.get("btc_adr_change_30d", np.full(n, np.nan))

    # Binary signal: 1 = bullish, 0 = cash
    raw_signal = np.zeros(n)
    raw_signal[adr_change > ACTIVE_ADDR_BUY_THRESHOLD] = 1.0
    # Need minimum 30 days of data to compute signal
    raw_signal[:ACTIVE_ADDR_CHANGE_LOOKBACK] = 0.0

    tradeable = [s for s in symbols if s != "BTCUSDT"]
    rolling_vol = build_rolling_vol_30d(qv_arrays, n)

    # Full-period portfolio
    daily_strat = np.zeros(n)
    daily_bench = np.zeros(n)
    btc_close = close_arrays.get("BTCUSDT", np.full(n, np.nan))

    # WFO windows
    wfo_windows = []
    rebalance_day_set = set(range(0, n, REBALANCE_DAYS))

    # Iterate WFO windows
    for w_start in range(ACTIVE_ADDR_CHANGE_LOOKBACK + 30, n - WFO_TRAIN - WFO_TEST, WFO_STEP):
        train_end = w_start + WFO_TRAIN
        test_start = train_end
        test_end = min(test_start + WFO_TEST, n)
        if test_end > n:
            break

        # Run test period
        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        current_basket: list[str] = []
        trades = 0

        for t_abs in range(test_start, test_end):
            t_rel = t_abs - test_start
            sig = raw_signal[t_abs]

            # Rebalance on schedule
            if t_abs in rebalance_day_set or (len(current_basket) == 0 and t_rel > 0):
                vol_rank = []
                for sym in tradeable:
                    rv = rolling_vol.get(sym, np.full(n, np.nan))
                    if np.isfinite(rv[t_abs]):
                        vol_rank.append((rv[t_abs], sym))
                vol_rank.sort(key=lambda tup: -tup[0])
                current_basket = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]
                trades += 1

            if sig > 0.5 and len(current_basket) > 0:
                port_ret[t_rel] = basket_equal_weight_return(close_arrays, current_basket, t_abs)
            else:
                port_ret[t_rel] = 0.0

            # BTC benchmark
            if np.isfinite(btc_close[t_abs]) and np.isfinite(btc_close[t_abs - 1]) and btc_close[t_abs - 1] > 0:
                bench_ret[t_rel] = btc_close[t_abs] / btc_close[t_abs - 1] - 1.0

        cost_per = COST_BPS / 10_000
        port_ret -= cost_per * (trades / max(1, len(port_ret)))

        strat_m = compute_metrics(port_ret)
        bench_m = compute_metrics(bench_ret)

        bullish_pct = float(np.mean(raw_signal[test_start:test_end] > 0.5))
        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": dates[w_start],
            "train_end": dates[train_end - 1],
            "test_start": dates[test_start],
            "test_end": dates[test_end - 1],
            "test_days": int(test_end - test_start),
            "bullish_pct": round(bullish_pct, 4),
            "n_trades": trades,
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_m,
            "benchmark": bench_m,
        })

    # Full-period run
    current_basket_full: list[str] = []
    for t in range(ACTIVE_ADDR_CHANGE_LOOKBACK + 30, n):
        sig = raw_signal[t]
        if t in rebalance_day_set or len(current_basket_full) == 0:
            vol_rank = []
            for sym in tradeable:
                rv = rolling_vol.get(sym, np.full(n, np.nan))
                if np.isfinite(rv[t]):
                    vol_rank.append((rv[t], sym))
            vol_rank.sort(key=lambda tup: -tup[0])
            current_basket_full = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]

        if sig > 0.5 and len(current_basket_full) > 0:
            daily_strat[t] = basket_equal_weight_return(close_arrays, current_basket_full, t)
        else:
            daily_strat[t] = 0.0

        if np.isfinite(btc_close[t]) and np.isfinite(btc_close[t - 1]) and btc_close[t - 1] > 0:
            daily_bench[t] = btc_close[t] / btc_close[t - 1] - 1.0

    overall_strat = compute_metrics(daily_strat[ACTIVE_ADDR_CHANGE_LOOKBACK + 30:])
    overall_bench = compute_metrics(daily_bench[ACTIVE_ADDR_CHANGE_LOOKBACK + 30:])

    # Signal stats
    bullish_days = int(np.sum(raw_signal > 0.5))
    total_signal_days = max(1, int(np.sum(np.isfinite(raw_signal))))
    avg_adr_change = float(np.nanmean(adr_change)) if np.sum(np.isfinite(adr_change)) > 0 else 0.0

    print(f"  {len(wfo_windows)} WFO windows, {bullish_days}/{total_signal_days} bullish days")
    print(f"  Avg AdrActCnt 30d change: {avg_adr_change:.2%}")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "BTC active address 30d growth >5% → bullish: buy top-10 altcoin basket. Cash otherwise.",
        "parameters": {
            "active_addr_lookback": ACTIVE_ADDR_CHANGE_LOOKBACK,
            "buy_threshold": ACTIVE_ADDR_BUY_THRESHOLD,
            "top_n_coins": TOP_N_TO_HOLD,
            "rebalance_days": REBALANCE_DAYS,
            "wfo_train_days": WFO_TRAIN,
            "wfo_test_days": WFO_TEST,
            "wfo_step_days": WFO_STEP,
        },
        "signal_stats": {
            "avg_adr_cnt_30d_change": round(avg_adr_change, 6),
            "bullish_days_ratio": round(bullish_days / total_signal_days, 4),
            "n_bullish_days": bullish_days,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY B: Fee Revenue Proxy
# ===================================================================

def strategy_b_fee_revenue(
    dates: list[str],
    close_arrays: dict[str, np.ndarray],
    qv_arrays: dict[str, np.ndarray],
    symbols: list[str],
    signals: dict[str, np.ndarray],
) -> dict:
    """Strategy B: BTC FeeTotUSD 30d growth as demand proxy.

    Signal logic:
      - FeeTotUSD 30d change > 10% → network usage growing → buy basket
      - FeeTotUSD 30d change < 0% → shrinking → cash
      - Between thresholds → hold previous state
    WFO-Lite: train=365d, test=63d, step=21d.
    """
    print("\n[Strategy B] Fee Revenue as Demand Proxy ...")
    n = len(dates)
    fee_change = signals.get("btc_fee_change_30d", np.full(n, np.nan))

    # State machine signal: 1 = bullish, 0 = cash
    raw_signal = np.zeros(n)
    for i in range(FEE_CHANGE_LOOKBACK, n):
        if np.isfinite(fee_change[i]):
            if fee_change[i] > FEE_BUY_THRESHOLD:
                raw_signal[i] = 1.0
            elif fee_change[i] < FEE_SELL_THRESHOLD:
                raw_signal[i] = 0.0
            else:
                # Hold previous
                raw_signal[i] = raw_signal[i - 1] if i > 0 else 0.0

    tradeable = [s for s in symbols if s != "BTCUSDT"]
    rolling_vol = build_rolling_vol_30d(qv_arrays, n)

    daily_strat = np.zeros(n)
    daily_bench = np.zeros(n)
    btc_close = close_arrays.get("BTCUSDT", np.full(n, np.nan))

    wfo_windows = []
    rebalance_day_set = set(range(0, n, REBALANCE_DAYS))

    for w_start in range(FEE_CHANGE_LOOKBACK + 30, n - WFO_TRAIN - WFO_TEST, WFO_STEP):
        train_end = w_start + WFO_TRAIN
        test_start = train_end
        test_end = min(test_start + WFO_TEST, n)
        if test_end > n:
            break

        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        current_basket: list[str] = []
        trades = 0

        for t_abs in range(test_start, test_end):
            t_rel = t_abs - test_start
            sig = raw_signal[t_abs]

            if t_abs in rebalance_day_set or len(current_basket) == 0:
                vol_rank = []
                for sym in tradeable:
                    rv = rolling_vol.get(sym, np.full(n, np.nan))
                    if np.isfinite(rv[t_abs]):
                        vol_rank.append((rv[t_abs], sym))
                vol_rank.sort(key=lambda tup: -tup[0])
                current_basket = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]
                trades += 1

            if sig > 0.5 and len(current_basket) > 0:
                port_ret[t_rel] = basket_equal_weight_return(close_arrays, current_basket, t_abs)
            else:
                port_ret[t_rel] = 0.0

            if np.isfinite(btc_close[t_abs]) and np.isfinite(btc_close[t_abs - 1]) and btc_close[t_abs - 1] > 0:
                bench_ret[t_rel] = btc_close[t_abs] / btc_close[t_abs - 1] - 1.0

        cost_per = COST_BPS / 10_000
        port_ret -= cost_per * (trades / max(1, len(port_ret)))

        strat_m = compute_metrics(port_ret)
        bench_m = compute_metrics(bench_ret)
        bullish_pct = float(np.mean(raw_signal[test_start:test_end] > 0.5))

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": dates[w_start],
            "train_end": dates[train_end - 1],
            "test_start": dates[test_start],
            "test_end": dates[test_end - 1],
            "test_days": int(test_end - test_start),
            "bullish_pct": round(bullish_pct, 4),
            "n_trades": trades,
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_m,
            "benchmark": bench_m,
        })

    # Full-period
    current_basket_full: list[str] = []
    for t in range(FEE_CHANGE_LOOKBACK + 30, n):
        sig = raw_signal[t]
        if t in rebalance_day_set or len(current_basket_full) == 0:
            vol_rank = []
            for sym in tradeable:
                rv = rolling_vol.get(sym, np.full(n, np.nan))
                if np.isfinite(rv[t]):
                    vol_rank.append((rv[t], sym))
            vol_rank.sort(key=lambda tup: -tup[0])
            current_basket_full = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]

        if sig > 0.5 and len(current_basket_full) > 0:
            daily_strat[t] = basket_equal_weight_return(close_arrays, current_basket_full, t)
        else:
            daily_strat[t] = 0.0

        if np.isfinite(btc_close[t]) and np.isfinite(btc_close[t - 1]) and btc_close[t - 1] > 0:
            daily_bench[t] = btc_close[t] / btc_close[t - 1] - 1.0

    overall_strat = compute_metrics(daily_strat[FEE_CHANGE_LOOKBACK + 30:])
    overall_bench = compute_metrics(daily_bench[FEE_CHANGE_LOOKBACK + 30:])

    bullish_days = int(np.sum(raw_signal > 0.5))
    avg_fee_change = float(np.nanmean(fee_change)) if np.sum(np.isfinite(fee_change)) > 0 else 0.0

    print(f"  {len(wfo_windows)} WFO windows, {bullish_days}/{n} bullish days")
    print(f"  Avg FeeTotUSD 30d change: {avg_fee_change:.2%}")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "BTC FeeTotUSD (FeeTotNtv * PriceUSD) 30d change: >10% buy, <0% cash, hold otherwise.",
        "parameters": {
            "fee_lookback": FEE_CHANGE_LOOKBACK,
            "buy_threshold": FEE_BUY_THRESHOLD,
            "sell_threshold": FEE_SELL_THRESHOLD,
            "top_n_coins": TOP_N_TO_HOLD,
            "rebalance_days": REBALANCE_DAYS,
            "wfo_train_days": WFO_TRAIN,
            "wfo_test_days": WFO_TEST,
            "wfo_step_days": WFO_STEP,
        },
        "signal_stats": {
            "avg_fee_tot_usd_30d_change": round(avg_fee_change, 6),
            "bullish_days_ratio": round(bullish_days / max(1, n), 4),
            "n_bullish_days": bullish_days,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY C: NVT Ratio
# ===================================================================

def strategy_c_nvt_ratio(
    dates: list[str],
    close_arrays: dict[str, np.ndarray],
    qv_arrays: dict[str, np.ndarray],
    symbols: list[str],
    signals: dict[str, np.ndarray],
) -> dict:
    """Strategy C: NVT (Network Value to Transactions) ratio.

    NVT_proxy = CapMrktCurUSD / FeeTotUSD  (using fees as activity proxy)

    Signal (thresholds computed PER WFO WINDOW from training data):
      - NVT < train_10th_pctile → undervalued → buy basket
      - NVT > train_90th_pctile → overvalued → cash
      - Else → hold previous position
    WFO-Lite: train=365d (compute percentiles), test=63d.
    """
    print("\n[Strategy C] NVT Ratio Strategy ...")
    n = len(dates)
    nvt = signals.get("btc_nvt", np.full(n, np.nan))

    tradeable = [s for s in symbols if s != "BTCUSDT"]
    rolling_vol = build_rolling_vol_30d(qv_arrays, n)

    btc_close = close_arrays.get("BTCUSDT", np.full(n, np.nan))
    wfo_windows = []
    rebalance_day_set = set(range(0, n, REBALANCE_DAYS))

    for w_start in range(60, n - WFO_TRAIN - WFO_TEST, WFO_STEP):
        train_end = w_start + WFO_TRAIN
        test_start = train_end
        test_end = min(test_start + WFO_TEST, n)
        if test_end > n:
            break

        # Compute percentiles from training window
        train_nvt = nvt[w_start:train_end]
        train_valid = train_nvt[np.isfinite(train_nvt)]
        if len(train_valid) < 30:
            continue
        pct_10 = float(np.percentile(train_valid, NVT_OVERSOLD_PCT))
        pct_90 = float(np.percentile(train_valid, NVT_OVERBOUGHT_PCT))

        # Build signal for test period
        test_nvt = nvt[test_start:test_end]
        signal = np.zeros(test_end - test_start)
        for i in range(len(signal)):
            if np.isfinite(test_nvt[i]):
                if test_nvt[i] < pct_10:
                    signal[i] = 1.0  # undervalued → buy
                elif test_nvt[i] > pct_90:
                    signal[i] = 0.0  # overvalued → cash
                else:
                    signal[i] = signal[i - 1] if i > 0 else 1.0  # hold

        # Execute test period
        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        current_basket: list[str] = []
        trades = 0

        for i, t_abs in enumerate(range(test_start, test_end)):
            sig = signal[i]

            if t_abs in rebalance_day_set or len(current_basket) == 0:
                vol_rank = []
                for sym in tradeable:
                    rv = rolling_vol.get(sym, np.full(n, np.nan))
                    if np.isfinite(rv[t_abs]):
                        vol_rank.append((rv[t_abs], sym))
                vol_rank.sort(key=lambda tup: -tup[0])
                current_basket = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]
                trades += 1

            if sig > 0.5 and len(current_basket) > 0:
                port_ret[i] = basket_equal_weight_return(close_arrays, current_basket, t_abs)
            else:
                port_ret[i] = 0.0

            if np.isfinite(btc_close[t_abs]) and np.isfinite(btc_close[t_abs - 1]) and btc_close[t_abs - 1] > 0:
                bench_ret[i] = btc_close[t_abs] / btc_close[t_abs - 1] - 1.0

        cost_per = COST_BPS / 10_000
        port_ret -= cost_per * (trades / max(1, len(port_ret)))

        strat_m = compute_metrics(port_ret)
        bench_m = compute_metrics(bench_ret)
        bullish_pct = float(np.mean(signal > 0.5))

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": dates[w_start],
            "train_end": dates[train_end - 1],
            "test_start": dates[test_start],
            "test_end": dates[test_end - 1],
            "test_days": int(test_end - test_start),
            "nvt_10th_pctile": round(pct_10, 4),
            "nvt_90th_pctile": round(pct_90, 4),
            "bullish_pct": round(bullish_pct, 4),
            "n_trades": trades,
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_m,
            "benchmark": bench_m,
        })

    # Full-period: use global percentiles
    nvt_valid = nvt[np.isfinite(nvt)]
    global_pct_10 = float(np.percentile(nvt_valid, NVT_OVERSOLD_PCT)) if len(nvt_valid) > 30 else 0.0
    global_pct_90 = float(np.percentile(nvt_valid, NVT_OVERBOUGHT_PCT)) if len(nvt_valid) > 30 else 0.0

    full_sig = np.zeros(n)
    for i in range(60, n):
        if np.isfinite(nvt[i]):
            if nvt[i] < global_pct_10:
                full_sig[i] = 1.0
            elif nvt[i] > global_pct_90:
                full_sig[i] = 0.0
            else:
                full_sig[i] = full_sig[i - 1] if i > 0 else 1.0

    daily_strat = np.zeros(n)
    daily_bench = np.zeros(n)
    current_basket_full: list[str] = []
    for t in range(60, n):
        if t in rebalance_day_set or len(current_basket_full) == 0:
            vol_rank = []
            for sym in tradeable:
                rv = rolling_vol.get(sym, np.full(n, np.nan))
                if np.isfinite(rv[t]):
                    vol_rank.append((rv[t], sym))
            vol_rank.sort(key=lambda tup: -tup[0])
            current_basket_full = [s for _, s in vol_rank[:TOP_N_TO_HOLD]]

        if full_sig[t] > 0.5 and len(current_basket_full) > 0:
            daily_strat[t] = basket_equal_weight_return(close_arrays, current_basket_full, t)
        else:
            daily_strat[t] = 0.0

        if np.isfinite(btc_close[t]) and np.isfinite(btc_close[t - 1]) and btc_close[t - 1] > 0:
            daily_bench[t] = btc_close[t] / btc_close[t - 1] - 1.0

    overall_strat = compute_metrics(daily_strat[60:])
    overall_bench = compute_metrics(daily_bench[60:])

    # NVT stats
    nvt_mean = float(np.mean(nvt_valid)) if len(nvt_valid) > 0 else 0.0
    bullish_days = int(np.sum(full_sig > 0.5))
    bearish_days = n - 60 - bullish_days

    print(f"  {len(wfo_windows)} WFO windows")
    print(f"  NVT 10th pct={global_pct_10:.2f}, 90th pct={global_pct_90:.2f}")
    print(f"  {bullish_days} bullish days, {bearish_days} bearish days")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "NVT proxy (CapMrktCurUSD / FeeTotUSD). Buy when NVT <10th pctile (undervalued), cash when >90th pctile (overvalued). Percentiles computed per WFO train window.",
        "parameters": {
            "nvt_oversold_pct": NVT_OVERSOLD_PCT,
            "nvt_overbought_pct": NVT_OVERBOUGHT_PCT,
            "top_n_coins": TOP_N_TO_HOLD,
            "rebalance_days": REBALANCE_DAYS,
            "wfo_train_days": WFO_TRAIN,
            "wfo_test_days": WFO_TEST,
            "wfo_step_days": WFO_STEP,
        },
        "nvt_stats": {
            "mean": round(nvt_mean, 4),
            "global_10th_pctile": round(global_pct_10, 4),
            "global_90th_pctile": round(global_pct_90, 4),
        },
        "signal_stats": {
            "bullish_days_ratio": round(bullish_days / max(1, n - 60), 4),
            "n_bullish_days": bullish_days,
            "n_bearish_days": bearish_days,
        },
        "full_period": {
            "strategy": overall_strat,
            "benchmark_btc": overall_bench,
        },
        "wfo_windows": wfo_windows,
    }


# ===================================================================
# STRATEGY D: Combined On-Chain + Adaptive Low-Vol
# ===================================================================

def strategy_d_combined_lowvol(
    dates: list[str],
    close_arrays: dict[str, np.ndarray],
    qv_arrays: dict[str, np.ndarray],
    symbols: list[str],
    signals: dict[str, np.ndarray],
) -> dict:
    """Strategy D: Combined on-chain + adaptive low-vol.

    When on-chain signals are bullish (active addresses growing AND
    NVT not extreme), apply adaptive low-vol strategy: select bottom
    quartile by 21d rolling realized volatility (defensive).

    When on-chain signals are bearish, stay in cash.

    On-chain bullish filter:
      - AdrActCnt 30d change > 5% (growing)
      - NVT not in extreme top 10% of training window

    WFO-Lite: train=365d (NVT percentile), test=63d, step=21d.
    """
    print("\n[Strategy D] Combined On-Chain + Adaptive Low-Vol ...")
    n = len(dates)
    adr_change = signals.get("btc_adr_change_30d", np.full(n, np.nan))
    nvt = signals.get("btc_nvt", np.full(n, np.nan))

    tradeable = [s for s in symbols if s != "BTCUSDT"]
    rolling_vol = build_rolling_vol_30d(qv_arrays, n)

    btc_close = close_arrays.get("BTCUSDT", np.full(n, np.nan))
    wfo_windows = []
    rebalance_day_set = set(range(0, n, REBALANCE_DAYS))

    # Pre-compute 21d realized volatility for each symbol (for low-vol selection)
    sym_vol_21d: dict[str, np.ndarray] = {}
    for sym in symbols:
        arr = close_arrays.get(sym, np.full(n, np.nan))
        vol_arr = np.full(n, np.nan)
        for i in range(LOW_VOL_LOOKBACK + 1, n):
            ret_window = np.full(LOW_VOL_LOOKBACK, np.nan)
            for j in range(LOW_VOL_LOOKBACK):
                idx = i - LOW_VOL_LOOKBACK + j + 1
                if np.isfinite(arr[idx]) and np.isfinite(arr[idx - 1]) and arr[idx - 1] > 0:
                    ret_window[j] = arr[idx] / arr[idx - 1] - 1.0
            valid_ret = ret_window[np.isfinite(ret_window)]
            if len(valid_ret) >= 10:
                vol_arr[i] = float(np.std(valid_ret, ddof=1) * np.sqrt(365.25))
        sym_vol_21d[sym] = vol_arr

    for w_start in range(max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) + 30, n - WFO_TRAIN - WFO_TEST, WFO_STEP):
        train_end = w_start + WFO_TRAIN
        test_start = train_end
        test_end = min(test_start + WFO_TEST, n)
        if test_end > n:
            break

        # Compute NVT 90th percentile from training window
        train_nvt = nvt[w_start:train_end]
        train_nvt_valid = train_nvt[np.isfinite(train_nvt)]
        nvt_90th = float(np.percentile(train_nvt_valid, NVT_OVERBOUGHT_PCT)) if len(train_nvt_valid) >= 20 else float("inf")

        # Execute test period
        port_ret = np.zeros(test_end - test_start)
        bench_ret = np.zeros(test_end - test_start)
        trades = 0
        low_vol_basket: list[str] = []

        for i, t_abs in enumerate(range(test_start, test_end)):
            # Check on-chain bullish filter
            adr_ok = np.isfinite(adr_change[t_abs]) and adr_change[t_abs] > ACTIVE_ADDR_BUY_THRESHOLD
            nvt_ok = np.isfinite(nvt[t_abs]) and nvt[t_abs] <= nvt_90th
            bullish = adr_ok and nvt_ok

            if bullish:
                # Low-vol selection: pick bottom quartile by 21d vol
                if t_abs in rebalance_day_set or i == 0:
                    vol_ranking = []
                    for sym in tradeable:
                        v = sym_vol_21d.get(sym, np.full(n, np.nan))
                        if np.isfinite(v[t_abs]):
                            vol_ranking.append((v[t_abs], sym))
                    vol_ranking.sort(key=lambda tup: tup[0])  # ascending by vol
                    n_low_vol = max(1, int(len(vol_ranking) * 0.25))
                    low_vol_basket = [s for _, s in vol_ranking[:n_low_vol]]
                    trades += 1

                    port_ret[i] = basket_equal_weight_return(close_arrays, low_vol_basket, t_abs)
                else:
                    # Use previous basket (from last rebalance)
                    port_ret[i] = basket_equal_weight_return(close_arrays, low_vol_basket, t_abs) if low_vol_basket else 0.0
            else:
                port_ret[i] = 0.0

            if np.isfinite(btc_close[t_abs]) and np.isfinite(btc_close[t_abs - 1]) and btc_close[t_abs - 1] > 0:
                bench_ret[i] = btc_close[t_abs] / btc_close[t_abs - 1] - 1.0

        cost_per = COST_BPS / 10_000
        port_ret -= cost_per * (trades / max(1, len(port_ret)))

        strat_m = compute_metrics(port_ret)
        bench_m = compute_metrics(bench_ret)
        bullish_pct = float(
            np.mean([
                1 if (
                    np.isfinite(adr_change[t_abs]) and adr_change[t_abs] > ACTIVE_ADDR_BUY_THRESHOLD
                    and np.isfinite(nvt[t_abs]) and nvt[t_abs] <= nvt_90th
                ) else 0
                for t_abs in range(test_start, test_end)
            ])
        )

        wfo_windows.append({
            "window": len(wfo_windows) + 1,
            "train_start": dates[w_start],
            "train_end": dates[train_end - 1],
            "test_start": dates[test_start],
            "test_end": dates[test_end - 1],
            "test_days": int(test_end - test_start),
            "nvt_90th_pctile": round(nvt_90th, 4),
            "bullish_pct": round(bullish_pct, 4),
            "n_trades": trades,
            "strategy_return": round(float(np.nansum(port_ret)), 6),
            "benchmark_return": round(float(np.nansum(bench_ret)), 6),
            "excess_return": round(float(np.nansum(port_ret) - np.nansum(bench_ret)), 6),
            "strategy": strat_m,
            "benchmark": bench_m,
        })

    # Full-period
    nvt_valid = nvt[np.isfinite(nvt)]
    global_nvt_90th = float(np.percentile(nvt_valid, NVT_OVERBOUGHT_PCT)) if len(nvt_valid) >= 20 else float("inf")

    daily_strat = np.zeros(n)
    daily_bench = np.zeros(n)
    for t in range(max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) + 30, n):
        adr_ok = np.isfinite(adr_change[t]) and adr_change[t] > ACTIVE_ADDR_BUY_THRESHOLD
        nvt_ok = np.isfinite(nvt[t]) and nvt[t] <= global_nvt_90th
        bullish = adr_ok and nvt_ok

        if bullish:
            vol_ranking = []
            for sym in tradeable:
                v = sym_vol_21d.get(sym, np.full(n, np.nan))
                if np.isfinite(v[t]):
                    vol_ranking.append((v[t], sym))
            vol_ranking.sort(key=lambda tup: tup[0])
            n_low_vol = max(1, int(len(vol_ranking) * 0.25))
            low_vol_basket = [s for _, s in vol_ranking[:n_low_vol]]
            daily_strat[t] = basket_equal_weight_return(close_arrays, low_vol_basket, t)
        else:
            daily_strat[t] = 0.0

        if np.isfinite(btc_close[t]) and np.isfinite(btc_close[t - 1]) and btc_close[t - 1] > 0:
            daily_bench[t] = btc_close[t] / btc_close[t - 1] - 1.0

    overall_strat = compute_metrics(daily_strat[max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) + 30:])
    overall_bench = compute_metrics(daily_bench[max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) + 30:])

    # Signal stats
    bullish_days = 0
    for t in range(max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) + 30, n):
        if np.isfinite(adr_change[t]) and adr_change[t] > ACTIVE_ADDR_BUY_THRESHOLD and np.isfinite(nvt[t]) and nvt[t] <= global_nvt_90th:
            bullish_days += 1
    total_days = n - max(ACTIVE_ADDR_CHANGE_LOOKBACK, LOW_VOL_LOOKBACK) - 30

    print(f"  {len(wfo_windows)} WFO windows, {bullish_days}/{total_days} bullish days")
    print(f"  Strategy: {overall_strat['annualized_return']:.2%} ann ret, {overall_strat['sharpe_ratio']:.2f} Sharpe")
    print(f"  Benchmark (BTC): {overall_bench['annualized_return']:.2%} ann ret")

    return {
        "description": "Combined on-chain (active address growing + NVT not extreme) + low-vol (bottom quartile by 21d vol). Cash when on-chain bearish.",
        "parameters": {
            "active_addr_buy_threshold": ACTIVE_ADDR_BUY_THRESHOLD,
            "active_addr_lookback": ACTIVE_ADDR_CHANGE_LOOKBACK,
            "nvt_overbought_pct": NVT_OVERBOUGHT_PCT,
            "low_vol_lookback": LOW_VOL_LOOKBACK,
            "low_vol_quartile": 0.25,
            "rebalance_days": REBALANCE_DAYS,
            "wfo_train_days": WFO_TRAIN,
            "wfo_test_days": WFO_TEST,
            "wfo_step_days": WFO_STEP,
        },
        "signal_stats": {
            "bullish_days_ratio": round(bullish_days / max(1, total_days), 4),
            "n_bullish_days": bullish_days,
            "n_total_days": total_days,
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

    print("=" * 60)
    print("On-Chain Factor Strategy Backtest")
    print("=" * 60)
    print(f"Period: {START_DATE} to {END_DATE}")

    # ---- 1. Load Coin Metrics on-chain data ----
    print(f"\n[1] Loading Coin Metrics on-chain data ...")
    cm_data = load_coinmetrics(ONCHAIN_PATH, assets=("btc", "eth"))
    cm_dates = sorted(cm_data.keys())
    print(f"  Loaded {len(cm_data)} unique dates for assets: "
          f"{[a for a in cm_data[next(iter(cm_data))].keys()] if cm_data else []}")
    cm_date_range = (cm_dates[0], cm_dates[-1]) if cm_dates else ("None", "None")
    print(f"  Date range: {cm_date_range[0]} to {cm_date_range[1]}")

    # ---- 2. Discover universe ----
    print(f"\n[2] Discovering top {N_SYMBOLS} symbols with >= {MIN_MONTHS} months data ...")
    symbols = discover_symbols(N_SYMBOLS)
    print(f"  Found {len(symbols)} symbols")
    for sym in symbols:
        print(f"    {sym}")
    if not symbols:
        print("ERROR: no symbols found.", file=sys.stderr)
        sys.exit(1)

    # ---- 3. Load kline data ----
    print(f"\n[3] Loading kline data for {len(symbols)} symbols ...")
    klines_data = load_multi_klines_dates(symbols, start_ms, end_ms)
    print(f"  Loaded {len(klines_data)} symbols")

    # ---- 4. Build aligned timeline ----
    print(f"\n[4] Building aligned timeline (on-chain + klines) ...")
    dates, close_arrays, cm_signal_arrays, qv_arrays = build_aligned_timeline(
        klines_data, cm_data, START_DATE, END_DATE,
    )
    n = len(dates)
    if n < 100:
        print("ERROR: too few aligned dates.", file=sys.stderr)
        sys.exit(1)
    print(f"  {n} shared trading days ({dates[0]} to {dates[-1]})")

    # ---- 5. Compute on-chain signals ----
    print(f"\n[5] Computing on-chain signals ...")
    signals = compute_onchain_signals(cm_signal_arrays, n)
    btc_fields = [k for k in signals if "btc_" in k]
    for k in btc_fields:
        n_valid = int(np.sum(np.isfinite(signals[k])))
        print(f"  {k}: {n_valid}/{n} valid")

    # ---- 6. Run Strategy A ----
    result_a = strategy_a_onchain_momentum(
        dates, close_arrays, qv_arrays, symbols, signals,
    )

    # ---- 7. Run Strategy B ----
    result_b = strategy_b_fee_revenue(
        dates, close_arrays, qv_arrays, symbols, signals,
    )

    # ---- 8. Run Strategy C ----
    result_c = strategy_c_nvt_ratio(
        dates, close_arrays, qv_arrays, symbols, signals,
    )

    # ---- 9. Run Strategy D ----
    result_d = strategy_d_combined_lowvol(
        dates, close_arrays, qv_arrays, symbols, signals,
    )

    # ---- 10. Build report ----
    print(f"\n{'=' * 60}")
    print(f"[10] Building final report ...")

    # WFO summary per strategy
    def wfo_summary(wfo_windows: list[dict]) -> dict:
        if not wfo_windows:
            return {"n_windows": 0}
        returns = [w.get("excess_return", 0) for w in wfo_windows]
        strat_rets = [w.get("strategy", {}).get("annualized_return", 0) for w in wfo_windows]
        bench_rets = [w.get("benchmark", {}).get("annualized_return", 0) for w in wfo_windows]
        return {
            "n_windows": len(wfo_windows),
            "mean_excess_return": round(float(np.mean(returns)), 6),
            "std_excess_return": round(float(np.std(returns, ddof=1)), 6) if len(returns) > 1 else 0.0,
            "positive_excess_windows": int(np.sum([r > 0 for r in returns])),
            "mean_strategy_ann_ret": round(float(np.nanmean(strat_rets)), 6),
            "mean_bench_ann_ret": round(float(np.nanmean(bench_rets)), 6),
            "positive_strat_return_windows": int(np.sum([r > 0 for r in strat_rets if np.isfinite(r)])),
        }

    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": {
            "data_sources": {
                "onchain": "Coin Metrics asset_metrics_1d.jsonl (BTC + ETH, daily)",
                "market": f"Binance daily klines (ZIP) — {N_SYMBOLS} USDT pairs",
            },
            "period": f"{dates[0]} to {dates[-1]}",
            "n_dates": n,
            "symbols": symbols,
            "cost_bps": COST_BPS,
            "rebalance_days": REBALANCE_DAYS,
            "top_n_in_basket": TOP_N_TO_HOLD,
            "wfo": {
                "train_days": WFO_TRAIN,
                "test_days": WFO_TEST,
                "step_days": WFO_STEP,
            },
            "onchain_fields_available": [
                "AdrActCnt", "CapMrktCurUSD", "FeeTotNtv",
                "PriceUSD", "SplyCur", "TxCnt",
            ],
        },
        "strategy_a_onchain_momentum": {
            "description": result_a["description"],
            "parameters": result_a["parameters"],
            "signal_stats": result_a["signal_stats"],
            "full_period": result_a["full_period"],
            "wfo_lite": {
                "summary": wfo_summary(result_a["wfo_windows"]),
                "windows": result_a["wfo_windows"],
            },
        },
        "strategy_b_fee_revenue": {
            "description": result_b["description"],
            "parameters": result_b["parameters"],
            "signal_stats": result_b["signal_stats"],
            "full_period": result_b["full_period"],
            "wfo_lite": {
                "summary": wfo_summary(result_b["wfo_windows"]),
                "windows": result_b["wfo_windows"],
            },
        },
        "strategy_c_nvt_ratio": {
            "description": result_c["description"],
            "parameters": result_c["parameters"],
            "nvt_stats": result_c["nvt_stats"],
            "signal_stats": result_c["signal_stats"],
            "full_period": result_c["full_period"],
            "wfo_lite": {
                "summary": wfo_summary(result_c["wfo_windows"]),
                "windows": result_c["wfo_windows"],
            },
        },
        "strategy_d_combined_lowvol": {
            "description": result_d["description"],
            "parameters": result_d["parameters"],
            "signal_stats": result_d["signal_stats"],
            "full_period": result_d["full_period"],
            "wfo_lite": {
                "summary": wfo_summary(result_d["wfo_windows"]),
                "windows": result_d["wfo_windows"],
            },
        },
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\n  Report saved to: {OUTPUT_PATH}")

    # ---- Summary ----
    print(f"\n{'=' * 60}")
    print(f"SUMMARY COMPARISON")
    print(f"{'=' * 60}")
    headers = ["Strategy", "Ann.Ret", "Sharpe", "MaxDD", "WinRate", "N_Days", "WFO_n"]
    print(f"  {headers[0]:35s} {headers[1]:>10s} {headers[2]:>8s} {headers[3]:>10s} {headers[4]:>8s} {headers[5]:>7s} {headers[6]:>7s}")
    print(f"  {'-'*35} {'-'*10} {'-'*8} {'-'*10} {'-'*8} {'-'*7} {'-'*7}")
    for name, res in [
        ("A: On-Chain Momentum (AddrCnt)", result_a),
        ("B: Fee Revenue Proxy", result_b),
        ("C: NVT Ratio", result_c),
        ("D: Combined + Low-Vol", result_d),
    ]:
        fp = res.get("full_period", {})
        s = fp.get("strategy", {})
        wfo_w = res.get("wfo_windows", [])
        print(f"  {name:35s} {s.get('annualized_return', 0):>9.2%} "
              f"{s.get('sharpe_ratio', 0):>7.2f} "
              f"{s.get('max_drawdown_pct', 0):>9.2%} "
              f"{s.get('win_rate', 0):>7.2%} "
              f"{s.get('n_obs', 0):>7d} "
              f"{len(wfo_w):>7d}")

    print(f"\nDone.")


if __name__ == "__main__":
    main()
