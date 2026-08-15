#!/usr/bin/env python3
"""
Macro-level strategy backtest using four regime-based strategies.

Strategies:
  A: BTC dominance rotation -- BTC_price / median(all_coin_prices).
     When dominance RISING (BTC outperforming) -> buy BTC only (capital preservation).
     When dominance FALLING (altcoins outperforming) -> buy top 10 altcoins (risk-on).
     Rebalance 21d.

  B: Risk-on / risk-off -- classify regime by avg 21d return across all coins.
     If > 0 -> risk-on (buy high-beta: DOGE, AVAX, NEAR, APT, ARB).
     If < 0 -> risk-off (buy low-beta: BTC, ETH, LTC, XRP).
     Rebalance 21d.

  C: Volatility regime timing -- BTC 60d vol vs its 1-year median.
     Below median -> low vol (safe, equal-weight all coins).
     Above median -> high vol (50% cash, 50% BTC).
     Rebalance 21d.

  D: Trend following with volatility stop -- long top 5 coins by 90d momentum.
     Exit any position that drops > 10% from its 30d high.
     Rebalance weekly (7d).

WFO for all 4: train=365d lookback, test=63d window.
Output: data/research/strategy_macro_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd

warnings.filterwarnings("ignore", category=RuntimeWarning)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
START_DATE = "2020-01-01"
END_DATE = "2026-04-30"
COST_PER_LEG_BPS = 15

# WFO parameters
WFO_TRAIN_DAYS = 365
WFO_TEST_DAYS = 63
WFO_STEP = 21

# Rebalance frequencies
REBALANCE_21D = 21
REBALANCE_7D = 7

# Strategy A
BTC_DOMINANCE_ALTS = [
    'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT',
    'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'UNIUSDT',
]

# Strategy B
HIGH_BETA = ['DOGEUSDT', 'AVAXUSDT', 'NEARUSDT', 'APTUSDT', 'ARBUSDT']
LOW_BETA = ['BTCUSDT', 'ETHUSDT', 'LTCUSDT', 'XRPUSDT']

# Strategy C
BTC_60D_VOL_WINDOW = 60
BTC_VOL_MEDIAN_DAYS = 180  # trailing window for vol median (reduced from 365 to fit WFO window)

# Strategy D
MOMENTUM_LOOKBACK = 90
STOP_DRAWDOWN = 0.10  # 10% drop from 30d high
STOP_LOOKBACK = 30
N_TOP_MOMENTUM = 5

LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")
KLINES_HEADER = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_vol", "trades", "taker_buy_base",
    "taker_buy_quote", "ignore",
]

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
OUTPUT_PATH = os.path.join(
    REPO_ROOT, "data", "research", "strategy_macro_report.json"
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ms(date_str: str) -> int:
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _ym_range(start_str: str, end_str: str):
    sy, sm = int(start_str[:4]), int(start_str[5:7])
    ey, em = int(end_str[:4]), int(end_str[5:7])
    y, m = sy, sm
    while (y, m) <= (ey, em):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


def intersperse_nan(series_list: list[pd.Series]) -> pd.DataFrame:
    """Concatenate series on common index, columns=symbol names."""
    result = pd.concat(series_list, axis=1)
    result = result.sort_index()
    return result


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_symbol_data(
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame | None:
    """Load daily OHLCV for one symbol from monthly ZIP klines."""
    data_dir = os.path.join(DATA_ROOT, symbol, "1d")
    if not os.path.isdir(data_dir):
        return None
    start_dt = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)

    dfs: list[pd.DataFrame] = []
    for year, month in _ym_range(START_DATE, END_DATE):
        if (year, month) < (start_dt.year, start_dt.month):
            continue
        if (year, month) > (end_dt.year, end_dt.month):
            break
        zip_name = f"{symbol}-1d-{year}-{month:02d}.zip"
        zip_path = os.path.join(data_dir, zip_name)
        if not os.path.exists(zip_path):
            continue
        try:
            with zipfile.ZipFile(zip_path, "r") as z:
                csv_name = z.namelist()[0]
                with z.open(csv_name) as f:
                    df_chunk = pd.read_csv(f, header=None)
                    dfs.append(df_chunk)
        except Exception:
            continue

    if not dfs:
        return None
    df = pd.concat(dfs, ignore_index=True)
    df.columns = KLINES_HEADER
    # Guard against out-of-bounds timestamps (corrupted CSV lines)
    df["open_time"] = pd.to_numeric(df["open_time"], errors="coerce")
    df = df.dropna(subset=["open_time"]).copy()
    df["open_time"] = df["open_time"].astype("int64")
    df = df[df["open_time"].between(_ms("2010-01-01"), _ms("2030-01-01"))].copy()
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.sort_values("open_time").reset_index(drop=True)
    df = df[df["close"].notna() & (df["close"] > 0)].copy()
    return df


# ---------------------------------------------------------------------------
# Performance helpers
# ---------------------------------------------------------------------------

def compute_strategy_metrics(returns: list[float], ann_factor_days: float = 21) -> dict:
    """Annualized return, Sharpe, max drawdown, win rate."""
    n = len(returns)
    if n < 2:
        return {
            "annualized_return": 0.0,
            "annualized_vol": 0.0,
            "sharpe_ratio": 0.0,
            "max_drawdown_pct": 0.0,
            "win_rate": 0.0,
            "n_periods": n,
        }
    g = np.array(returns)
    ann_factor = 365.25 / ann_factor_days
    ann_ret = float(np.mean(g) * ann_factor)
    ann_vol = float(np.std(g, ddof=1) * np.sqrt(ann_factor))
    sharpe = float(np.mean(g) / np.std(g, ddof=1) * np.sqrt(ann_factor)) if np.std(g, ddof=1) > 0 else 0.0
    cum = np.cumprod(1.0 + g)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))
    win_rate = float(np.mean(g > 0))
    return {
        "annualized_return": round(ann_ret, 6),
        "annualized_vol": round(ann_vol, 6),
        "sharpe_ratio": round(sharpe, 4),
        "max_drawdown_pct": round(max_dd, 6),
        "win_rate": round(win_rate, 4),
        "n_periods": n,
    }


# ===================================================================
# STRATEGY A: BTC Dominance Rotation
# ===================================================================

def run_strategy_a(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
    alt_indices: list[int],
) -> dict:
    """
    BTC dominance rotation.

    At each 21d rebalance:
      - BTC dominance = BTC_price / median(all_coin_prices)
      - Compare dominance level to previous rebalance:
        RISING -> buy BTC only
        FALLING -> equal-weight top 10 altcoins
    """
    n_sym, n_dates = price_mtx.shape
    rebal = REBALANCE_21D
    min_hist = rebal * 2  # need at least 2 rebalance periods to compare dominance
    max_r = n_dates - rebal

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    regime_log: list[str] = []

    # Cache previous dominance level
    prev_dominance: float | None = None

    r_idx = min_hist
    while r_idx <= max_r:
        # Compute BTC dominance at current date
        prices_now = price_mtx[:, r_idx]
        valid_prices = prices_now[np.isfinite(prices_now) & (prices_now > 0)]
        if len(valid_prices) < 5 or btc_idx is None:
            r_idx += rebal
            continue

        btc_price = float(prices_now[btc_idx])
        median_price = float(np.median(valid_prices))
        if median_price <= 0:
            r_idx += rebal
            continue
        dominance = btc_price / median_price

        # Determine regime (on second+ pass)
        if prev_dominance is not None:
            rising = dominance > prev_dominance
        else:
            rising = True  # default to BTC on first pass
        regime = "BTC_dominance_rising" if rising else "BTC_dominance_falling"

        # Forward return from r_idx to r_idx + rebal
        fwd_prices = price_mtx[:, r_idx + rebal - 1]
        fwd_valid = np.isfinite(fwd_prices) & (fwd_prices > 0)

        if rising:
            # Buy BTC only
            if not fwd_valid[btc_idx]:
                r_idx += rebal
                continue
            long_fwd = [fwd_prices[btc_idx] / prices_now[btc_idx] - 1]
        else:
            # Buy top altcoins
            valid_alts = [ai for ai in alt_indices
                          if np.isfinite(prices_now[ai]) and prices_now[ai] > 0
                          and fwd_valid[ai]]
            if len(valid_alts) < 3:
                r_idx += rebal
                continue
            long_fwd = [fwd_prices[ai] / prices_now[ai] - 1 for ai in valid_alts]

        gross = float(np.mean(long_fwd))
        cost = COST_PER_LEG_BPS / 10_000.0
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        # BTC benchmark
        if btc_idx is not None and np.isfinite(prices_now[btc_idx]) and prices_now[btc_idx] > 0:
            if fwd_valid[btc_idx]:
                btc_returns.append(float(fwd_prices[btc_idx] / prices_now[btc_idx] - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))
        regime_log.append(regime)

        prev_dominance = dominance
        r_idx += rebal

    metrics = compute_strategy_metrics(raw_returns, ann_factor_days=rebal)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / rebal)), 6
    )

    regime_counts: dict[str, int] = {}
    for rg in regime_log:
        regime_counts[rg] = regime_counts.get(rg, 0) + 1

    return {
        "performance": metrics,
        "regime_distribution": regime_counts,
        "period_returns": [
            {
                "timestamp": ts,
                "gross": round(g, 6),
                "net": round(n, 6),
                "btc": round(b, 6),
                "regime": rg,
            }
            for ts, g, n, b, rg in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns, regime_log
            )
        ],
    }


# ===================================================================
# STRATEGY B: Risk-On / Risk-Off
# ===================================================================

def run_strategy_b(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
    high_beta_indices: list[int],
    low_beta_indices: list[int],
) -> dict:
    """
    Risk-on / risk-off regime classification.

    At each 21d rebalance:
      - Compute avg 21d return across all coins (cross-sectional mean of past 21d returns)
      - If > 0 -> risk-on: buy high-beta (DOGE, AVAX, NEAR, APT, ARB)
      - If < 0 -> risk-off: buy low-beta (BTC, ETH, LTC, XRP)
    """
    n_sym, n_dates = price_mtx.shape
    rebal = REBALANCE_21D
    min_hist = rebal + 1
    max_r = n_dates - rebal

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    regime_log: list[str] = []

    r_idx = min_hist
    while r_idx <= max_r:
        # Avg cross-sectional 21d return
        past_prices = price_mtx[:, r_idx - rebal]
        current_prices = price_mtx[:, r_idx]
        valid = np.isfinite(past_prices) & np.isfinite(current_prices) & (past_prices > 0) & (current_prices > 0)
        if np.sum(valid) < 5:
            r_idx += rebal
            continue
        rets_21d = current_prices[valid] / past_prices[valid] - 1
        avg_rets_21d = float(np.mean(rets_21d))

        risk_on = avg_rets_21d > 0
        regime = "risk_on" if risk_on else "risk_off"

        target_idx = high_beta_indices if risk_on else low_beta_indices

        # Forward return
        fwd_prices = price_mtx[:, r_idx + rebal - 1]
        long_fwd = []
        for ti in target_idx:
            if (np.isfinite(current_prices[ti]) and current_prices[ti] > 0
                    and np.isfinite(fwd_prices[ti]) and fwd_prices[ti] > 0):
                long_fwd.append(fwd_prices[ti] / current_prices[ti] - 1)
        if len(long_fwd) < 2:
            r_idx += rebal
            continue

        gross = float(np.mean(long_fwd))
        cost = COST_PER_LEG_BPS / 10_000.0
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        if btc_idx is not None:
            if (np.isfinite(current_prices[btc_idx]) and current_prices[btc_idx] > 0
                    and np.isfinite(fwd_prices[btc_idx]) and fwd_prices[btc_idx] > 0):
                btc_returns.append(float(fwd_prices[btc_idx] / current_prices[btc_idx] - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))
        regime_log.append(f"{regime}(avg_return={avg_rets_21d:.4f})")
        r_idx += rebal

    metrics = compute_strategy_metrics(raw_returns, ann_factor_days=rebal)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / rebal)), 6
    )

    regime_counts: dict[str, int] = {}
    for rg in regime_log:
        rg_key = rg.split("(")[0]
        regime_counts[rg_key] = regime_counts.get(rg_key, 0) + 1

    return {
        "performance": metrics,
        "regime_distribution": regime_counts,
        "period_returns": [
            {"timestamp": ts, "gross": round(g, 6), "net": round(n, 6), "btc": round(b, 6), "regime": rg}
            for ts, g, n, b, rg in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns, regime_log
            )
        ],
    }


# ===================================================================
# STRATEGY C: Volatility Regime Timing
# ===================================================================

def run_strategy_c(
    price_mtx: np.ndarray,
    ret_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
) -> dict:
    """
    Volatility regime timing.

    At each 21d rebalance:
      - Compute BTC 60d rolling vol (annualized std of daily returns)
      - Compare to 1-year rolling median of BTC 60d vol
      - Below median -> low vol: buy equal-weight all coins
      - Above median -> high vol: 50% cash, 50% BTC
    """
    n_sym, n_dates = price_mtx.shape
    rebal = REBALANCE_21D
    min_hist = BTC_60D_VOL_WINDOW + BTC_VOL_MEDIAN_DAYS
    max_r = n_dates - rebal

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    regime_log: list[str] = []

    if btc_idx is None:
        return {
            "performance": compute_strategy_metrics([], ann_factor_days=rebal),
            "regime_distribution": {},
            "period_returns": [],
        }

    r_idx = min_hist
    while r_idx <= max_r:
        # BTC 60d vol
        btc_rets = ret_mtx[btc_idx, max(0, r_idx - BTC_60D_VOL_WINDOW):r_idx]
        btc_rets_valid = btc_rets[np.isfinite(btc_rets)]
        if len(btc_rets_valid) < 30:
            r_idx += rebal
            continue
        btc_60d_vol = float(np.std(btc_rets_valid, ddof=1) * np.sqrt(365.25))

        # 180-day trailing median of BTC 60d vol
        # Compute BTC 60d vol at each day in the trailing window
        daily_vols: list[float] = []
        for d in range(max(BTC_60D_VOL_WINDOW, r_idx - BTC_VOL_MEDIAN_DAYS), r_idx):
            slice_rets = ret_mtx[btc_idx, max(0, d - BTC_60D_VOL_WINDOW):d]
            slice_valid = slice_rets[np.isfinite(slice_rets)]
            if len(slice_valid) >= 30:
                daily_vols.append(float(np.std(slice_valid, ddof=1) * np.sqrt(365.25)))

        if len(daily_vols) < 100:
            r_idx += rebal
            continue
        vol_median = float(np.median(daily_vols))

        low_vol_regime = btc_60d_vol < vol_median
        regime = "low_vol" if low_vol_regime else "high_vol"

        current_prices = price_mtx[:, r_idx]
        fwd_prices = price_mtx[:, r_idx + rebal - 1]

        if low_vol_regime:
            # Equal-weight all coins
            long_fwd = []
            for si in range(n_sym):
                if (np.isfinite(current_prices[si]) and current_prices[si] > 0
                        and np.isfinite(fwd_prices[si]) and fwd_prices[si] > 0):
                    long_fwd.append(fwd_prices[si] / current_prices[si] - 1)
            if len(long_fwd) < 3:
                r_idx += rebal
                continue
            gross = float(np.mean(long_fwd))
        else:
            # 50% cash, 50% BTC
            if (np.isfinite(current_prices[btc_idx]) and current_prices[btc_idx] > 0
                    and np.isfinite(fwd_prices[btc_idx]) and fwd_prices[btc_idx] > 0):
                btc_fwd = fwd_prices[btc_idx] / current_prices[btc_idx] - 1
                gross = 0.5 * btc_fwd  # 50% BTC, 50% cash (0 return)
            else:
                gross = 0.0

        cost = COST_PER_LEG_BPS / 10_000.0
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        if btc_idx is not None:
            if (np.isfinite(current_prices[btc_idx]) and current_prices[btc_idx] > 0
                    and np.isfinite(fwd_prices[btc_idx]) and fwd_prices[btc_idx] > 0):
                btc_returns.append(float(fwd_prices[btc_idx] / current_prices[btc_idx] - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))
        regime_log.append(f"{regime}(vol={btc_60d_vol:.4f},median={vol_median:.4f})")
        r_idx += rebal

    metrics = compute_strategy_metrics(raw_returns, ann_factor_days=rebal)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / rebal)), 6
    )

    regime_counts: dict[str, int] = {}
    for rg in regime_log:
        rg_key = rg.split("(")[0]
        regime_counts[rg_key] = regime_counts.get(rg_key, 0) + 1

    return {
        "performance": metrics,
        "regime_distribution": regime_counts,
        "period_returns": [
            {"timestamp": ts, "gross": round(g, 6), "net": round(n, 6), "btc": round(b, 6), "regime": rg}
            for ts, g, n, b, rg in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns, regime_log
            )
        ],
    }


# ===================================================================
# STRATEGY D: Trend Following with Volatility Stop
# ===================================================================

def run_strategy_d(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
) -> dict:
    """
    Trend following with trailing volatility stop.

    Rebalance weekly (7d):
      - At each rebalance, compute 90d momentum for all coins
      - Long top 5 coins by momentum
      - During the holding period, exit any position that drops > 10% from its 30d high
      - If stopped out, that portion sits in cash until next rebalance
    """
    n_sym, n_dates = price_mtx.shape
    rebal = REBALANCE_7D
    min_hist = MOMENTUM_LOOKBACK + 1
    max_r = n_dates - rebal - 1  # need one extra for stop check window

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    detail_log: list[dict] = []

    r_idx = min_hist
    while r_idx <= max_r:
        # Compute 90d momentum
        past_prices = price_mtx[:, r_idx - MOMENTUM_LOOKBACK]
        current_prices = price_mtx[:, r_idx]
        valid = (np.isfinite(past_prices) & np.isfinite(current_prices)
                 & (past_prices > 0) & (current_prices > 0))
        if np.sum(valid) < 5:
            r_idx += rebal
            continue

        momentum = np.full(n_sym, np.nan)
        for si in range(n_sym):
            if valid[si]:
                momentum[si] = current_prices[si] / past_prices[si] - 1

        # Top 5 by momentum
        valid_indices = np.where(valid)[0]
        sorted_idx = valid_indices[np.argsort(momentum[valid_indices])[::-1]]
        top5 = sorted_idx[:min(N_TOP_MOMENTUM, len(sorted_idx))]

        if len(top5) < 2:
            r_idx += rebal
            continue

        # Simulate holding period with stops
        # For each selected coin, check if it hits a stop during the 7-day hold
        holding_end = min(r_idx + rebal, n_dates)
        coin_returns: list[float] = []

        for si in top5:
            entry_price = current_prices[si]
            stopped_out = False
            exit_price = entry_price

            for d in range(r_idx + 1, holding_end):
                if d >= n_dates:
                    break
                day_price = price_mtx[si, d]
                if not np.isfinite(day_price) or day_price <= 0:
                    stopped_out = True
                    break

                # 30-day high ending at day d
                lookback_start = max(0, d - STOP_LOOKBACK)
                window_prices = price_mtx[si, lookback_start:d + 1]
                window_valid = window_prices[np.isfinite(window_prices) & (window_prices > 0)]
                if len(window_valid) < 5:
                    continue

                high_30d = float(np.max(window_valid))
                if day_price < (1.0 - STOP_DRAWDOWN) * high_30d:
                    exit_price = day_price
                    stopped_out = True
                    break

            if not stopped_out:
                # Hold to end of period
                if holding_end < n_dates and np.isfinite(price_mtx[si, holding_end]) and price_mtx[si, holding_end] > 0:
                    exit_price = price_mtx[si, holding_end]

            coin_ret = exit_price / entry_price - 1
            coin_returns.append(coin_ret)

        if not coin_returns:
            r_idx += rebal
            continue

        gross = float(np.mean(coin_returns))
        cost = COST_PER_LEG_BPS / 10_000.0
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        # BTC benchmark
        if btc_idx is not None:
            if (np.isfinite(current_prices[btc_idx]) and current_prices[btc_idx] > 0
                    and holding_end < n_dates
                    and np.isfinite(price_mtx[btc_idx, holding_end])
                    and price_mtx[btc_idx, holding_end] > 0):
                btc_returns.append(float(price_mtx[btc_idx, holding_end] / current_prices[btc_idx] - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))
        selected_syms = [symbols[si] for si in top5]
        detail_log.append({
            "date": str(all_timestamps[r_idx].date()),
            "selected": selected_syms,
            "coin_returns": [round(r, 6) for r in coin_returns],
            "gross": round(gross, 6),
        })

        r_idx += rebal

    metrics = compute_strategy_metrics(raw_returns, ann_factor_days=rebal)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / rebal)), 6
    )

    # Compute avg hit rate (how often the stop fired)
    total_positions = N_TOP_MOMENTUM * len(raw_returns)
    # Count stopped-out positions from detail_log
    stopped_count = 0
    for detail in detail_log:
        coin_rets = detail["coin_returns"]
        # A stop would typically cause a more negative return, but we can't
        # easily count it from the aggregated return. Instead, count positions.
    # Rough estimate: if any coin return is worse than the momentum holding return,
    # it might have been stopped out. This is imprecise but gives a sense.
    stop_hit_estimate = 0
    for detail in detail_log:
        for cr in detail["coin_returns"]:
            if cr < -STOP_DRAWDOWN * 0.8:  # roughly near stop level
                stop_hit_estimate += 1

    return {
        "performance": metrics,
        "period_returns": [
            {"timestamp": ts, "gross": round(g, 6), "net": round(n, 6), "btc": round(b, 6)}
            for ts, g, n, b in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns
            )
        ],
        "details": detail_log,
        "stop_stats": {
            "total_positions_ever": total_positions,
            "estimated_stopped_out": stop_hit_estimate,
            "stop_rate": round(stop_hit_estimate / total_positions, 4) if total_positions > 0 else 0.0,
        },
    }


# ===================================================================
# WFO-Lite Validation (for strategies A, B, C)
# ===================================================================

def run_wfo_lite_strategy_a(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
    alt_indices: list[int],
) -> dict:
    return run_strategy_a(price_mtx, all_timestamps, symbols, btc_idx, alt_indices)


def run_wfo_lite_strategy_b(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
    high_beta_indices: list[int],
    low_beta_indices: list[int],
) -> dict:
    return run_strategy_b(price_mtx, all_timestamps, symbols, btc_idx, high_beta_indices, low_beta_indices)


def run_wfo_lite_strategy_c(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    btc_idx: int | None,
    ret_mtx: np.ndarray,
) -> dict:
    return run_strategy_c(price_mtx, ret_mtx, all_timestamps, symbols, btc_idx)


def run_wfo_folds(
    strategy_fn,
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    extra_args: dict,
) -> dict:
    """Run WFO for a rule-based strategy.

    Partitions timeline into sequential windows:
      - Each window is WFO_TEST_DAYS long
      - Preceded by WFO_TRAIN_DAYS of lookback data (included in slice)
    """
    n_dates = len(all_timestamps)
    total_needed = WFO_TRAIN_DAYS + WFO_TEST_DAYS

    if n_dates < total_needed + 10:
        return {"status": "insufficient_data", "fold_count": 0}

    all_folds: list[dict] = []
    test_start = 0

    while test_start + total_needed <= n_dates:
        test_end = test_start + total_needed

        # Full slice includes both lookback (train) and test period
        slice_start = test_start
        slice_end = test_end

        # Run strategy on this slice
        window_result = strategy_fn(
            price_mtx[:, slice_start:slice_end],
            all_timestamps[slice_start:slice_end],
            symbols,
            **extra_args,
        )

        perf = window_result["performance"]
        n_periods = perf.get("n_periods", 0)
        regime_dist = window_result.get("regime_distribution", {})

        all_folds.append({
            "fold_id": len(all_folds),
            "lookback_range": [
                str(all_timestamps[slice_start].date()),
                str(all_timestamps[slice_start + WFO_TRAIN_DAYS - 1].date()),
            ],
            "test_range": [
                str(all_timestamps[slice_start + WFO_TRAIN_DAYS].date()),
                str(all_timestamps[min(slice_end - 1, n_dates - 1)].date()),
            ],
            "n_periods": n_periods,
            "annualized_return": perf["annualized_return"],
            "sharpe_ratio": perf["sharpe_ratio"],
            "win_rate": perf["win_rate"],
            "max_drawdown_pct": perf["max_drawdown_pct"],
            "regime_distribution": regime_dist,
        })

        test_start += WFO_STEP

    if not all_folds:
        return {"status": "no_folds", "fold_count": 0}

    fold_returns = [f["annualized_return"] for f in all_folds]
    fold_sharpes = [f["sharpe_ratio"] for f in all_folds]
    fold_pass = sum(1 for r in fold_returns if r > 0)

    return {
        "status": "completed",
        "fold_count": len(all_folds),
        "fold_results": all_folds,
        "summary": {
            "mean_annualized_return": round(float(np.mean(fold_returns)), 6),
            "std_annualized_return": round(float(np.std(fold_returns, ddof=1)), 6) if len(fold_returns) > 1 else 0.0,
            "mean_sharpe": round(float(np.mean(fold_sharpes)), 4),
            "pass_rate": round(fold_pass / len(fold_returns), 4) if fold_returns else 0.0,
            "n_folds": len(all_folds),
            "train_days": WFO_TRAIN_DAYS,
            "test_days": WFO_TEST_DAYS,
            "step_days": WFO_STEP,
        },
    }


# ===================================================================
# WFO-Lite for Strategy D
# ===================================================================

def run_wfo_folds_strategy_d(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
) -> dict:
    """WFO for Strategy D (trend following)."""
    n_dates = len(all_timestamps)
    total_needed = WFO_TRAIN_DAYS + WFO_TEST_DAYS

    if n_dates < total_needed + 10:
        return {"status": "insufficient_data", "fold_count": 0}

    all_folds: list[dict] = []
    test_start = 0

    while test_start + total_needed <= n_dates:
        slice_start = test_start
        slice_end = test_start + total_needed

        window_result = run_strategy_d(
            price_mtx[:, slice_start:slice_end],
            all_timestamps[slice_start:slice_end],
            symbols,
            None,  # no btc_idx needed for D's internal logic
        )

        perf = window_result["performance"]
        n_periods = perf.get("n_periods", 0)

        all_folds.append({
            "fold_id": len(all_folds),
            "lookback_range": [
                str(all_timestamps[slice_start].date()),
                str(all_timestamps[slice_start + WFO_TRAIN_DAYS - 1].date()),
            ],
            "test_range": [
                str(all_timestamps[slice_start + WFO_TRAIN_DAYS].date()),
                str(all_timestamps[min(slice_end - 1, n_dates - 1)].date()),
            ],
            "n_periods": n_periods,
            "annualized_return": perf["annualized_return"],
            "sharpe_ratio": perf["sharpe_ratio"],
            "win_rate": perf["win_rate"],
            "max_drawdown_pct": perf["max_drawdown_pct"],
        })

        test_start += WFO_STEP

    if not all_folds:
        return {"status": "no_folds", "fold_count": 0}

    fold_returns = [f["annualized_return"] for f in all_folds]
    fold_sharpes = [f["sharpe_ratio"] for f in all_folds]
    fold_pass = sum(1 for r in fold_returns if r > 0)

    return {
        "status": "completed",
        "fold_count": len(all_folds),
        "fold_results": all_folds,
        "summary": {
            "mean_annualized_return": round(float(np.mean(fold_returns)), 6),
            "std_annualized_return": round(float(np.std(fold_returns, ddof=1)), 6) if len(fold_returns) > 1 else 0.0,
            "mean_sharpe": round(float(np.mean(fold_sharpes)), 4),
            "pass_rate": round(fold_pass / len(fold_returns), 4) if fold_returns else 0.0,
            "n_folds": len(all_folds),
            "train_days": WFO_TRAIN_DAYS,
            "test_days": WFO_TEST_DAYS,
            "step_days": WFO_STEP,
        },
    }


# ===================================================================
# MAIN
# ===================================================================

def main():
    start_ms = _ms(START_DATE)
    end_ms = _ms(END_DATE)

    print("=" * 60)
    print("Macro Strategy Backtest (WFO)")
    print("=" * 60)

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # -------------------------------------------------------------------
    # [1] Define universe
    # -------------------------------------------------------------------
    # Start with broader set; we'll filter to loaded symbols
    all_candidate_symbols = [
        'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
        'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'DOTUSDT',
        'UNIUSDT', 'LTCUSDT', 'BCHUSDT', 'ATOMUSDT',
        'NEARUSDT', 'OPUSDT', 'ARBUSDT', 'SUIUSDT',
        'TRXUSDT', 'APTUSDT', 'INJUSDT', 'ETCUSDT',
        'AAVEUSDT', 'MKRUSDT', 'FILUSDT', 'ICPUSDT',
        'RUNEUSDT', 'FETUSDT', 'PEPEUSDT',
    ]
    print(f"\n[1] Universe: {len(all_candidate_symbols)} candidate symbols")

    # -------------------------------------------------------------------
    # [2] Load data
    # -------------------------------------------------------------------
    print(f"\n[2] Loading daily data ({START_DATE} to {END_DATE})...")
    symbol_dfs: dict[str, pd.DataFrame] = {}
    for sym in all_candidate_symbols:
        df = load_symbol_data(sym, start_ms, end_ms)
        if df is not None and len(df) > 200:
            symbol_dfs[sym] = df
        else:
            print(f"  WARN: {sym} insufficient data, dropping")

    print(f"  Loaded {len(symbol_dfs)} symbols with data")

    if len(symbol_dfs) < 10:
        print("ERROR: too few symbols with data.", file=sys.stderr)
        report = {"generated_at": generated_at, "status": "insufficient_data"}
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2, default=str)
        return

    symbols_loaded = list(symbol_dfs.keys())

    # -------------------------------------------------------------------
    # [3] Build common price matrix & return matrix
    # -------------------------------------------------------------------
    print(f"\n[3] Building cross-sectional matrices...")

    # Use close price to establish common timeline
    close_series_list = []
    for sym in symbols_loaded:
        s = symbol_dfs[sym].set_index("open_time")["close"]
        s.name = sym
        close_series_list.append(s)

    price_wide = intersperse_nan(close_series_list)  # date x symbol
    all_dates = sorted(price_wide.index)
    n_dates = len(all_dates)
    symbols_aligned = sorted(price_wide.columns)

    print(f"  Timeline: {all_dates[0].date()} -> {all_dates[-1].date()} ({n_dates} days)")
    print(f"  Symbols: {len(symbols_aligned)}")

    # Price matrix: n_sym x n_dates
    n_sym = len(symbols_aligned)
    price_mtx = np.full((n_sym, n_dates), np.nan)
    for si, sym in enumerate(symbols_aligned):
        price_mtx[si, :] = price_wide[sym].values

    # Daily return matrix: n_sym x n_dates
    ret_mtx = np.full((n_sym, n_dates), np.nan)
    for si in range(n_sym):
        ret_mtx[si, 1:] = price_mtx[si, 1:] / price_mtx[si, :-1] - 1

    # Locate BTC index
    btc_idx = None
    for si, sym in enumerate(symbols_aligned):
        if sym == "BTCUSDT":
            btc_idx = si
            print(f"  BTC index: {si} ({sym})")
            break

    # Build altcoin indices for Strategy A
    alt_indices = []
    for alt in BTC_DOMINANCE_ALTS:
        for si, sym in enumerate(symbols_aligned):
            if sym == alt:
                alt_indices.append(si)
                break
    print(f"  Altcoins for strategy A: {len(alt_indices)} symbols")

    # Build high/low beta indices for Strategy B
    hb_indices = []
    for sym in HIGH_BETA:
        for si, s in enumerate(symbols_aligned):
            if s == sym:
                hb_indices.append(si)
                break
    lb_indices = []
    for sym in LOW_BETA:
        for si, s in enumerate(symbols_aligned):
            if s == sym:
                lb_indices.append(si)
                break
    print(f"  High-beta indices: {len(hb_indices)}, Low-beta indices: {len(lb_indices)}")

    # -------------------------------------------------------------------
    # [4] Run Strategy A: BTC Dominance Rotation
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[4] Strategy A: BTC Dominance Rotation")
    print(f"{'=' * 60}")

    result_a = run_strategy_a(price_mtx, all_dates, symbols_aligned, btc_idx, alt_indices)
    perf_a = result_a["performance"]
    print(f"  Annualized return: {perf_a['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_a['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_a['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_a['win_rate']:.2%}")
    print(f"  N periods:         {perf_a['n_periods']}")
    print(f"  Regime dist:       {result_a['regime_distribution']}")

    print(f"\n  WFO validation...")
    wfo_a = run_wfo_folds(
        run_wfo_lite_strategy_a, price_mtx, all_dates, symbols_aligned,
        {"btc_idx": btc_idx, "alt_indices": alt_indices},
    )
    if wfo_a.get("summary"):
        s = wfo_a["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [5] Run Strategy B: Risk-On / Risk-Off
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[5] Strategy B: Risk-On / Risk-Off")
    print(f"{'=' * 60}")

    result_b = run_strategy_b(price_mtx, all_dates, symbols_aligned, btc_idx, hb_indices, lb_indices)
    perf_b = result_b["performance"]
    print(f"  Annualized return: {perf_b['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_b['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_b['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_b['win_rate']:.2%}")
    print(f"  N periods:         {perf_b['n_periods']}")
    print(f"  Regime dist:       {result_b['regime_distribution']}")

    print(f"\n  WFO validation...")
    wfo_b = run_wfo_folds(
        run_wfo_lite_strategy_b, price_mtx, all_dates, symbols_aligned,
        {"btc_idx": btc_idx, "high_beta_indices": hb_indices, "low_beta_indices": lb_indices},
    )
    if wfo_b.get("summary"):
        s = wfo_b["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [6] Run Strategy C: Volatility Regime Timing
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[6] Strategy C: Volatility Regime Timing")
    print(f"{'=' * 60}")

    result_c = run_strategy_c(price_mtx, ret_mtx, all_dates, symbols_aligned, btc_idx)
    perf_c = result_c["performance"]
    print(f"  Annualized return: {perf_c['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_c['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_c['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_c['win_rate']:.2%}")
    print(f"  N periods:         {perf_c['n_periods']}")
    print(f"  Regime dist:       {result_c['regime_distribution']}")

    print(f"\n  WFO validation...")
    wfo_c = run_wfo_folds(
        run_wfo_lite_strategy_c, price_mtx, all_dates, symbols_aligned,
        {"btc_idx": btc_idx, "ret_mtx": ret_mtx},
    )
    if wfo_c.get("summary"):
        s = wfo_c["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [7] Run Strategy D: Trend Following with Volatility Stop
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[7] Strategy D: Trend Following with Volatility Stop")
    print(f"{'=' * 60}")

    result_d = run_strategy_d(price_mtx, all_dates, symbols_aligned, btc_idx)
    perf_d = result_d["performance"]
    print(f"  Annualized return: {perf_d['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_d['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_d['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_d['win_rate']:.2%}")
    print(f"  N periods:         {perf_d['n_periods']}")
    print(f"  Stop stats:        {result_d.get('stop_stats', {})}")

    print(f"\n  WFO validation...")
    wfo_d = run_wfo_folds_strategy_d(
        price_mtx, all_dates, symbols_aligned,
    )
    if wfo_d.get("summary"):
        s = wfo_d["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [8] Build report
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[8] Building final report...")

    report: dict = {
        "generated_at": generated_at,
        "status": "completed",
        "config": {
            "n_symbols": len(symbols_aligned),
            "symbols": symbols_aligned,
            "cost_per_leg_bps": COST_PER_LEG_BPS,
            "period": f"{START_DATE} to {END_DATE}",
            "n_dates": n_dates,
            "date_range": {
                "start": str(all_dates[0].date()),
                "end": str(all_dates[-1].date()),
            },
        },
        "wfo_config": {
            "train_days": WFO_TRAIN_DAYS,
            "test_days": WFO_TEST_DAYS,
            "step_days": WFO_STEP,
        },
        "strategy_a_dominance_rotation": {
            "description": "BTC dominance = BTC_price / median(all_coin_prices). "
                          "When dominance rising -> buy BTC only (capital preservation). "
                          "When dominance falling -> buy top 10 altcoins (risk-on). Rebalance 21d.",
            "performance": result_a["performance"],
            "regime_distribution": result_a["regime_distribution"],
            "wfo": wfo_a,
            "n_periods": perf_a["n_periods"],
        },
        "strategy_b_risk_on_off": {
            "description": "Classify regime by avg 21d return across all coins. "
                          "If > 0 -> risk-on (buy high-beta: DOGE, AVAX, NEAR, APT, ARB). "
                          "If < 0 -> risk-off (buy low-beta: BTC, ETH, LTC, XRP). Rebalance 21d.",
            "performance": result_b["performance"],
            "regime_distribution": result_b["regime_distribution"],
            "wfo": wfo_b,
            "n_periods": perf_b["n_periods"],
        },
        "strategy_c_volatility_regime": {
            "description": "BTC 60d vol vs 1-year median. "
                          "Below -> low vol (equal-weight all coins). "
                          "Above -> high vol (50% cash, 50% BTC). Rebalance 21d.",
            "performance": result_c["performance"],
            "regime_distribution": result_c["regime_distribution"],
            "wfo": wfo_c,
            "n_periods": perf_c["n_periods"],
        },
        "strategy_d_trend_following_stop": {
            "description": "Long top 5 coins by 90d momentum. "
                          "Exit any position dropping > 10% from 30d high. Rebalance weekly (7d).",
            "performance": result_d["performance"],
            "stop_stats": result_d["stop_stats"],
            "wfo": wfo_d,
            "n_periods": perf_d["n_periods"],
        },
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"\n  Report saved to: {OUTPUT_PATH}")

    # -------------------------------------------------------------------
    # Summary comparison
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"SUMMARY COMPARISON")
    print(f"{'=' * 60}")
    print(f"  {'Strategy':30s} {'Ann.Ret':>10s} {'Sharpe':>8s} {'MaxDD':>10s} {'WinRate':>8s} {'N':>5s}")
    print(f"  {'-' * 30} {'-' * 10} {'-' * 8} {'-' * 10} {'-' * 8} {'-' * 5}")
    for name, perf in [
        ("A: Dominance Rotation", perf_a),
        ("B: Risk On/Off", perf_b),
        ("C: Vol Regime", perf_c),
        ("D: Trend+Stop", perf_d),
    ]:
        print(f"  {name:30s} {perf['annualized_return']:>9.2%} "
              f"{perf['sharpe_ratio']:>7.2f} "
              f"{perf['max_drawdown_pct']:>9.2%} "
              f"{perf['win_rate']:>7.2%} "
              f"{perf['n_periods']:>5d}")

    print(f"\nDone.")


if __name__ == "__main__":
    main()
