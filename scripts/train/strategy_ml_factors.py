#!/usr/bin/env python3
"""
Multi-factor ML-based strategy backtest.

Tests four factor combination strategies for 24 mainstream crypto coins:
  A: Rank aggregation (ensemble of factors)
  B: Z-score composite
  C: Rolling regression (linear)
  D: Regime-weighted

WFO validation on all strategies.
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
from sklearn.linear_model import LinearRegression
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore", category=RuntimeWarning)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
START_DATE = "2020-01-01"
END_DATE = "2024-06-30"
MIN_MONTHS = 36
N_SYMBOLS = 24
REBALANCE_DAYS = 21
LONG_PCT = 0.25
COST_PER_LEG_BPS = 15

# WFO-Lite windows for rule-based strategies (must be large enough for multiple rebal periods)
WFO_TEST_WINDOW = 252   # ~1 year (12 rebalance periods)
WFO_STEP = 63           # ~3 months step

# Rolling regression parameters (Strategy C)
ROLL_TRAIN_DAYS = 365
ROLL_TEST_DAYS = 63
ROLL_STEP = 21

# Regime thresholds (Strategy D)
REGIME_UPTREND_THRESHOLD = 0.05    # BTC 30d return > 5%
REGIME_DOWNTREND_THRESHOLD = -0.05 # BTC 30d return < -5%
BTC_LOOKBACK_DAYS = 30

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.dirname(os.path.dirname(SCRIPT_DIR))
OUTPUT_PATH = os.path.join(
    REPO_ROOT, "data", "research", "strategy_ml_factors_report.json"
)

LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")
KLINES_HEADER = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_vol", "trades", "taker_buy_base",
    "taker_buy_quote", "ignore",
]

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


def safe_float(v):
    """Convert to float, returning NaN on failure."""
    try:
        return float(v)
    except (ValueError, TypeError):
        return np.nan


# ---------------------------------------------------------------------------
# Universe discovery
# ---------------------------------------------------------------------------

def discover_symbols(n_symbols: int = N_SYMBOLS) -> list[str]:
    """Return top *n_symbols* spot symbols with >= MIN_MONTHS of daily data.

    Excludes Binance leveraged tokens (UP/DOWN/BULL/BEAR suffixes).
    Sorted by number of months descending (most data first).
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
    return selected


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_symbol_data(
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame | None:
    """Load daily OHLCV for one symbol from monthly ZIP klines.

    Returns DataFrame or None if no data found.
    """
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
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.sort_values("open_time").reset_index(drop=True)
    df = df[df["close"].notna() & (df["close"] > 0)].copy()
    return df


# ---------------------------------------------------------------------------
# Feature computation
# ---------------------------------------------------------------------------

def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add factor columns: realized_vol_21d, ret_5d, range_21d, fwd_21d."""
    close = df["close"].values
    high = df["high"].values
    low = df["low"].values
    n = len(df)

    # Daily returns
    ret_1d = np.full(n, np.nan)
    if n > 1:
        ret_1d[1:] = close[1:] / close[:-1] - 1

    # Past 5-day return
    ret_5d = np.full(n, np.nan)
    if n > 5:
        ret_5d[5:] = close[5:] / close[:-5] - 1

    # Realized volatility: 21-day rolling std of daily returns
    realized_vol_21d = np.full(n, np.nan)
    for i in range(20, n):
        segment = ret_1d[i - 20:i + 1]
        if np.sum(~np.isnan(segment)) >= 15:
            realized_vol_21d[i] = np.nanstd(segment, ddof=1)

    # Daily range percentage
    range_pct = np.where(close > 0, (high - low) / close, np.nan)

    # 21-day rolling average of range_pct
    range_21d = np.full(n, np.nan)
    for i in range(20, n):
        segment = range_pct[i - 20:i + 1]
        if np.sum(~np.isnan(segment)) >= 15:
            range_21d[i] = np.nanmean(segment)

    # Forward 21-day return (return from close[t] to close[t+21])
    fwd_21d = np.full(n, np.nan)
    if n > REBALANCE_DAYS:
        fwd_21d[:-REBALANCE_DAYS] = (
            close[REBALANCE_DAYS:] / close[:-REBALANCE_DAYS] - 1
        )

    df["ret_1d"] = ret_1d
    df["ret_5d"] = ret_5d
    df["realized_vol_21d"] = realized_vol_21d
    df["range_21d"] = range_21d
    df["range_pct"] = range_pct
    df["fwd_21d"] = fwd_21d

    return df


# ---------------------------------------------------------------------------
# Matrix building
# ---------------------------------------------------------------------------

def build_wide_matrix(
    symbol_dfs: dict[str, pd.DataFrame],
    col: str,
) -> pd.DataFrame:
    """Build a wide DataFrame: index=date, columns=symbols, values=col."""
    series_list: list[pd.Series] = []
    for sym, df in symbol_dfs.items():
        if col not in df.columns:
            continue
        s = df.set_index("open_time")[col]
        s.name = sym
        series_list.append(s)
    if not series_list:
        return pd.DataFrame()
    result = pd.concat(series_list, axis=1)
    result = result.sort_index()
    return result


# ---------------------------------------------------------------------------
# Performance helpers
# ---------------------------------------------------------------------------

def compute_strategy_metrics(returns: list[float], btc_returns: list[float]):
    """Compute annualized return, Sharpe, max drawdown, win rate."""
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
    ann_factor = 365.25 / REBALANCE_DAYS
    ann_ret = float(np.mean(g) * ann_factor)
    ann_vol = float(np.std(g, ddof=1) * np.sqrt(ann_factor))
    sharpe = float(np.mean(g) / np.std(g, ddof=1) * np.sqrt(ann_factor)) if np.std(g, ddof=1) > 0 else 0.0

    cum = np.cumprod(1.0 + g)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))
    win_rate = float(np.mean(g > 0))

    # BTC benchmark
    if btc_returns:
        btc_arr = np.array(btc_returns)
        btc_ann = float(np.mean(btc_arr) * ann_factor)
    else:
        btc_ann = 0.0

    return {
        "annualized_return": round(ann_ret, 6),
        "annualized_vol": round(ann_vol, 6),
        "sharpe_ratio": round(sharpe, 4),
        "max_drawdown_pct": round(max_dd, 6),
        "win_rate": round(win_rate, 4),
        "btc_annualized_return": round(btc_ann, 6),
        "n_periods": n,
    }


# ===================================================================
# STRATEGY A: Rank Aggregation
# ===================================================================

def run_strategy_a(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    factor_matrices: dict[str, np.ndarray],
    btc_idx: int | None = None,
) -> dict:
    """Rank aggregation ensemble.

    For each rebalance date, rank each factor (all ascending),
    average ranks, select top 25% by best (lowest) average rank,
    equal-weight, hold 21 days.

    Factors used: realized_vol_21d, ret_5d, range_21d
    """
    n_sym, n_dates = price_mtx.shape
    first_r = REBALANCE_DAYS + 1  # need history
    max_r = n_dates - REBALANCE_DAYS

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    period_details: list[dict] = []

    r_idx = first_r
    while r_idx <= max_r:
        # Factor values at this date
        factor_ranks = []
        factor_names = []

        for fname in ["realized_vol_21d", "ret_5d", "range_21d"]:
            if fname not in factor_matrices:
                continue
            vals = factor_matrices[fname][:, r_idx].copy()
            valid = ~np.isnan(vals)
            if np.sum(valid) < 4:
                continue
            # Rank ascending (ascending means low values get better rank)
            ranked = np.full(n_sym, np.nan)
            valid_idx = np.where(valid)[0]
            order = np.argsort(vals[valid_idx])
            for rank_pos, orig_pos in enumerate(order):
                ranked[valid_idx[orig_pos]] = rank_pos + 1
            factor_ranks.append(ranked)
            factor_names.append(fname)

        if len(factor_ranks) < 2:
            r_idx += REBALANCE_DAYS
            continue

        # Composite rank: average across factors
        with np.errstate(invalid="ignore"):
            composite_rank = np.nanmean(factor_ranks, axis=0)  # (n_sym,)

        # Forward return
        fwd_ret = price_mtx[:, r_idx + REBALANCE_DAYS - 1] / price_mtx[:, r_idx] - 1

        valid_comp = ~np.isnan(composite_rank) & ~np.isnan(fwd_ret)
        if np.sum(valid_comp) < 4:
            r_idx += REBALANCE_DAYS
            continue

        # Select top 25% by best (lowest) composite rank
        valid_idx = np.where(valid_comp)[0]
        sorted_idx = valid_idx[np.argsort(composite_rank[valid_idx])]
        n_long = max(1, int(np.ceil(len(sorted_idx) * LONG_PCT)))
        long_idx = sorted_idx[:n_long]
        long_fwd = fwd_ret[long_idx]

        gross = float(np.mean(long_fwd))
        cost = float(COST_PER_LEG_BPS) / 10_000
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        # BTC benchmark
        if btc_idx is not None:
            b_n = price_mtx[btc_idx, r_idx]
            b_l = price_mtx[btc_idx, r_idx + REBALANCE_DAYS - 1]
            if np.isfinite(b_n) and np.isfinite(b_l) and b_n > 0:
                btc_returns.append(float(b_l / b_n - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))

        # Detail
        long_syms = [symbols[i] for i in long_idx]
        period_details.append({
            "date": str(all_timestamps[r_idx].date()),
            "n_long": len(long_idx),
            "gross": round(gross, 6),
            "net": round(net, 6),
            "long_symbols": long_syms,
        })

        r_idx += REBALANCE_DAYS

    metrics = compute_strategy_metrics(raw_returns, btc_returns)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / REBALANCE_DAYS)), 6
    )

    return {
        "performance": metrics,
        "period_returns": [
            {
                "timestamp": ts,
                "gross": round(g, 6),
                "net": round(n, 6),
                "btc": round(b, 6),
            }
            for ts, g, n, b in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns
            )
        ],
        "details": period_details,
    }


# ===================================================================
# STRATEGY B: Z-Score Composite
# ===================================================================

def run_strategy_b(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    factor_matrices: dict[str, np.ndarray],
    btc_idx: int | None = None,
) -> dict:
    """Z-score composite.

    For each rebalance date, cross-sectionally z-score each factor,
    average z-scores, select top 25% (lowest composite, since all
    factors have negative IC), equal-weight.
    """
    n_sym, n_dates = price_mtx.shape
    first_r = REBALANCE_DAYS + 1
    max_r = n_dates - REBALANCE_DAYS

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []

    r_idx = first_r
    while r_idx <= max_r:
        z_scores = []

        for fname in ["realized_vol_21d", "ret_5d", "range_21d"]:
            if fname not in factor_matrices:
                continue
            vals = factor_matrices[fname][:, r_idx].copy()
            valid = ~np.isnan(vals)
            if np.sum(valid) < 4:
                continue
            mean_v = np.nanmean(vals)
            std_v = np.nanstd(vals, ddof=1)
            if std_v < 1e-12:
                continue
            z = np.full(n_sym, np.nan)
            z[valid] = (vals[valid] - mean_v) / std_v
            z_scores.append(z)

        if len(z_scores) < 2:
            r_idx += REBALANCE_DAYS
            continue

        # Composite: mean z-score (negative z means low value, which predicts
        # high forward return for these factors)
        with np.errstate(invalid="ignore"):
            composite = np.nanmean(z_scores, axis=0)

        fwd_ret = price_mtx[:, r_idx + REBALANCE_DAYS - 1] / price_mtx[:, r_idx] - 1

        valid_comp = ~np.isnan(composite) & ~np.isnan(fwd_ret)
        if np.sum(valid_comp) < 4:
            r_idx += REBALANCE_DAYS
            continue

        # Select top 25% by lowest composite (most negative z = best)
        valid_idx = np.where(valid_comp)[0]
        sorted_idx = valid_idx[np.argsort(composite[valid_idx])]
        n_long = max(1, int(np.ceil(len(sorted_idx) * LONG_PCT)))
        long_idx = sorted_idx[:n_long]
        long_fwd = fwd_ret[long_idx]

        gross = float(np.mean(long_fwd))
        cost = float(COST_PER_LEG_BPS) / 10_000
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        if btc_idx is not None:
            b_n = price_mtx[btc_idx, r_idx]
            b_l = price_mtx[btc_idx, r_idx + REBALANCE_DAYS - 1]
            if np.isfinite(b_n) and np.isfinite(b_l) and b_n > 0:
                btc_returns.append(float(b_l / b_n - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))
        r_idx += REBALANCE_DAYS

    metrics = compute_strategy_metrics(raw_returns, btc_returns)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / REBALANCE_DAYS)), 6
    )

    return {
        "performance": metrics,
        "period_returns": [
            {
                "timestamp": ts,
                "gross": round(g, 6),
                "net": round(n, 6),
                "btc": round(b, 6),
            }
            for ts, g, n, b in zip(
                rebalance_timestamps, raw_returns, net_returns, btc_returns
            )
        ],
    }


# ===================================================================
# STRATEGY C: Rolling Regression
# ===================================================================

def run_strategy_c(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    factor_matrices: dict[str, np.ndarray],
    fwd_mtx: np.ndarray,
    btc_idx: int | None = None,
) -> dict:
    """Rolling regression strategy.

    For each fold:
      - Train: pool all (date, symbol) pairs over past ROLL_TRAIN_DAYS days
      - Regress forward_21d_return ~ vol_21d + ret_5d + range_21d
      - Test: use coefficients for next ROLL_TEST_DAYS days
      - At each rebalance date in test window, compute composite score,
        select top 25%, equal-weight

    This IS the WFO — rolling train/test windows naturally provide
    out-of-sample validation.
    """
    n_sym, n_dates = price_mtx.shape
    all_folds: list[dict] = []
    all_returns: list[dict] = []

    fold_id = 0
    train_start = 0

    while train_start + ROLL_TRAIN_DAYS + ROLL_TEST_DAYS <= n_dates:
        train_end = train_start + ROLL_TRAIN_DAYS
        test_start = train_end
        test_end = min(test_start + ROLL_TEST_DAYS, n_dates)

        # ---- Build training data (flattened across symbols and dates) ----
        train_rows: list[dict] = []
        for d_idx in range(train_start, train_end):
            for s_idx in range(n_sym):
                vol = factor_matrices.get("realized_vol_21d", np.full_like(price_mtx, np.nan))[s_idx, d_idx]
                ret5 = factor_matrices.get("ret_5d", np.full_like(price_mtx, np.nan))[s_idx, d_idx]
                rng = factor_matrices.get("range_21d", np.full_like(price_mtx, np.nan))[s_idx, d_idx]
                fwd = fwd_mtx[s_idx, d_idx]
                if not any(np.isnan([vol, ret5, rng, fwd])):
                    train_rows.append({
                        "vol": vol, "ret5": ret5, "range": rng, "fwd": fwd,
                    })

        if len(train_rows) < 30:
            train_start += ROLL_STEP
            continue

        # Train linear regression
        train_df = pd.DataFrame(train_rows)
        X_train = train_df[["vol", "ret5", "range"]].values
        y_train = train_df["fwd"].values

        scaler = StandardScaler()
        X_tr_scaled = scaler.fit_transform(X_train)

        model = LinearRegression()
        model.fit(X_tr_scaled, y_train)
        coef_vol, coef_ret, coef_range = model.coef_
        intercept = model.intercept_

        # ---- Run strategy on test window ----
        fold_raw_returns: list[float] = []
        fold_net_returns: list[float] = []
        fold_btc_returns: list[float] = []
        fold_rebal_dates: list[str] = []

        r_idx = test_start + REBALANCE_DAYS + 1  # need factor history
        while r_idx < test_end:
            if r_idx + REBALANCE_DAYS >= n_dates:
                break

            # Compute composite score = model prediction
            composite = np.full(n_sym, np.nan)
            for s_idx in range(n_sym):
                vol = factor_matrices.get("realized_vol_21d", np.full_like(price_mtx, np.nan))[s_idx, r_idx]
                ret5 = factor_matrices.get("ret_5d", np.full_like(price_mtx, np.nan))[s_idx, r_idx]
                rng = factor_matrices.get("range_21d", np.full_like(price_mtx, np.nan))[s_idx, r_idx]
                if not np.isnan([vol, ret5, rng]).any():
                    x_scaled = scaler.transform([[vol, ret5, rng]])
                    composite[s_idx] = float(model.predict(x_scaled)[0])

            fwd_ret = price_mtx[:, r_idx + REBALANCE_DAYS - 1] / price_mtx[:, r_idx] - 1

            valid = ~np.isnan(composite) & ~np.isnan(fwd_ret)
            if np.sum(valid) < 4:
                r_idx += REBALANCE_DAYS
                continue

            # Select top 25% by highest predicted return
            valid_idx = np.where(valid)[0]
            sorted_idx = valid_idx[np.argsort(composite[valid_idx])[::-1]]  # descending
            n_long = max(1, int(np.ceil(len(sorted_idx) * LONG_PCT)))
            long_idx = sorted_idx[:n_long]
            long_fwd = fwd_ret[long_idx]

            gross = float(np.mean(long_fwd))
            cost = float(COST_PER_LEG_BPS) / 10_000
            net = gross - cost

            fold_raw_returns.append(gross)
            fold_net_returns.append(net)

            if btc_idx is not None:
                b_n = price_mtx[btc_idx, r_idx]
                b_l = price_mtx[btc_idx, r_idx + REBALANCE_DAYS - 1]
                if np.isfinite(b_n) and np.isfinite(b_l) and b_n > 0:
                    fold_btc_returns.append(float(b_l / b_n - 1))
                else:
                    fold_btc_returns.append(0.0)

            fold_rebal_dates.append(str(all_timestamps[r_idx].date()))
            all_returns.append({
                "timestamp": int(all_timestamps[r_idx].timestamp() * 1000),
                "gross": round(gross, 6),
                "net": round(net, 6),
                "btc": round(fold_btc_returns[-1] if fold_btc_returns else 0, 6),
                "fold_id": fold_id,
            })

            r_idx += REBALANCE_DAYS

        fold_metrics = compute_strategy_metrics(fold_raw_returns, fold_btc_returns)
        fold_metrics["net_annualized_return"] = round(
            float(np.mean(fold_net_returns) * (365.25 / REBALANCE_DAYS)), 6
        ) if fold_net_returns else 0

        # Also compute correlations between prediction and actual (rank IC)
        fold_ics = []
        # For each rebalance date in fold, compute cross-sectional IC
        r_idx_check = test_start + REBALANCE_DAYS + 1
        while r_idx_check < test_end:
            if r_idx_check + REBALANCE_DAYS >= n_dates:
                break
            preds = []
            actuals = []
            for s_idx in range(n_sym):
                vol = factor_matrices.get("realized_vol_21d", np.full_like(price_mtx, np.nan))[s_idx, r_idx_check]
                ret5 = factor_matrices.get("ret_5d", np.full_like(price_mtx, np.nan))[s_idx, r_idx_check]
                rng = factor_matrices.get("range_21d", np.full_like(price_mtx, np.nan))[s_idx, r_idx_check]
                fwd = price_mtx[s_idx, r_idx_check + REBALANCE_DAYS - 1] / price_mtx[s_idx, r_idx_check] - 1
                if not any(np.isnan([vol, ret5, rng, fwd])):
                    x_scaled = scaler.transform([[vol, ret5, rng]])
                    preds.append(float(model.predict(x_scaled)[0]))
                    actuals.append(float(fwd))
            if len(preds) >= 5:
                from scipy.stats import spearmanr
                rho, _ = spearmanr(preds, actuals)
                if not np.isnan(rho):
                    fold_ics.append(float(rho))
            r_idx_check += REBALANCE_DAYS

        mean_ic = float(np.mean(fold_ics)) if fold_ics else 0.0

        all_folds.append({
            "fold_id": fold_id,
            "train_range": [
                str(all_timestamps[train_start].date()),
                str(all_timestamps[min(train_end - 1, n_dates - 1)].date()),
            ],
            "test_range": [
                str(all_timestamps[test_start].date()),
                str(all_timestamps[min(test_end - 1, n_dates - 1)].date()),
            ],
            "n_train_examples": len(train_rows),
            "n_rebalance_periods": len(fold_raw_returns),
            "coefficients": {
                "vol_21d": round(float(coef_vol), 6),
                "ret_5d": round(float(coef_ret), 6),
                "range_21d": round(float(coef_range), 6),
                "intercept": round(float(intercept), 6),
            },
            "performance": fold_metrics,
            "mean_prediction_ic": round(mean_ic, 6),
        })

        fold_id += 1
        train_start += ROLL_STEP

    # Aggregate across all folds
    all_gross = [r["gross"] for r in all_returns]
    all_btc = [r["btc"] for r in all_returns]
    overall_metrics = compute_strategy_metrics(all_gross, all_btc)
    overall_metrics["net_annualized_return"] = round(
        float(np.mean([r["net"] for r in all_returns]) * (365.25 / REBALANCE_DAYS)), 6
    ) if all_returns else 0

    # Fold-level statistics
    fold_returns = [f["performance"]["annualized_return"] for f in all_folds]
    fold_pass = sum(1 for r in fold_returns if r > 0)
    fold_ics = [f["mean_prediction_ic"] for f in all_folds]
    fold_ic_pass = sum(1 for ic in fold_ics if ic > 0)

    return {
        "performance": overall_metrics,
        "n_folds": len(all_folds),
        "fold_results": all_folds,
        "period_returns": all_returns,
        "fold_summary": {
            "fold_count": len(all_folds),
            "mean_fold_return": round(float(np.mean(fold_returns)), 6) if fold_returns else 0,
            "fold_pass_rate": round(fold_pass / len(fold_returns), 4) if fold_returns else 0,
            "mean_fold_ic": round(float(np.mean(fold_ics)), 6) if fold_ics else 0,
            "fold_ic_pass_rate": round(fold_ic_pass / len(fold_ics), 4) if fold_ics else 0,
        },
    }


# ===================================================================
# STRATEGY D: Regime-Weighted
# ===================================================================

def run_strategy_d(
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    factor_matrices: dict[str, np.ndarray],
    btc_idx: int | None,
) -> dict:
    """Regime-weighted strategy.

    At each rebalance date, classify BTC regime:
      - uptrend: BTC 30d return > 5% -> use momentum (ret_5d, descending)
      - downtrend: BTC 30d return < -5% -> use low-vol (realized_vol_21d, ascending)
      - sideways: else -> use reversal (ret_5d, ascending)

    Select top 25% by regime-appropriate factor, equal-weight, hold 21d.
    """
    n_sym, n_dates = price_mtx.shape
    need_history = max(BTC_LOOKBACK_DAYS, REBALANCE_DAYS) + 1
    max_r = n_dates - REBALANCE_DAYS

    raw_returns: list[float] = []
    net_returns: list[float] = []
    btc_returns: list[float] = []
    rebalance_timestamps: list[int] = []
    regime_log: list[str] = []

    r_idx = need_history
    while r_idx <= max_r:
        # BTC 30d return
        if btc_idx is not None and r_idx >= BTC_LOOKBACK_DAYS:
            btc_price_old = price_mtx[btc_idx, r_idx - BTC_LOOKBACK_DAYS]
            btc_price_now = price_mtx[btc_idx, r_idx]
            if np.isfinite(btc_price_old) and np.isfinite(btc_price_now) and btc_price_old > 0:
                btc_30d_ret = btc_price_now / btc_price_old - 1
            else:
                btc_30d_ret = 0.0
        else:
            btc_30d_ret = 0.0

        # Classify regime
        if btc_30d_ret > REGIME_UPTREND_THRESHOLD:
            regime = "uptrend"
            factor_name = "ret_5d"
            ascending = False  # momentum: high past returns win
        elif btc_30d_ret < REGIME_DOWNTREND_THRESHOLD:
            regime = "downtrend"
            factor_name = "realized_vol_21d"
            ascending = True  # low-vol: low vol wins
        else:
            regime = "sideways"
            factor_name = "ret_5d"
            ascending = True  # reversal: past losers win

        # Get factor values
        if factor_name not in factor_matrices:
            r_idx += REBALANCE_DAYS
            continue

        factor_vals = factor_matrices[factor_name][:, r_idx]
        fwd_ret = price_mtx[:, r_idx + REBALANCE_DAYS - 1] / price_mtx[:, r_idx] - 1

        valid = ~np.isnan(factor_vals) & ~np.isnan(fwd_ret)
        if np.sum(valid) < 4:
            r_idx += REBALANCE_DAYS
            continue

        valid_idx = np.where(valid)[0]

        if ascending:
            sorted_idx = valid_idx[np.argsort(factor_vals[valid_idx])]
        else:
            sorted_idx = valid_idx[np.argsort(factor_vals[valid_idx])[::-1]]

        n_long = max(1, int(np.ceil(len(sorted_idx) * LONG_PCT)))
        long_idx = sorted_idx[:n_long]
        long_fwd = fwd_ret[long_idx]

        gross = float(np.mean(long_fwd))
        cost = float(COST_PER_LEG_BPS) / 10_000
        net = gross - cost

        raw_returns.append(gross)
        net_returns.append(net)

        if btc_idx is not None:
            b_n = price_mtx[btc_idx, r_idx]
            b_l = price_mtx[btc_idx, r_idx + REBALANCE_DAYS - 1]
            if np.isfinite(b_n) and np.isfinite(b_l) and b_n > 0:
                btc_returns.append(float(b_l / b_n - 1))
            else:
                btc_returns.append(0.0)

        rebalance_timestamps.append(int(all_timestamps[r_idx].timestamp() * 1000))

        btc_30d_pct = round(btc_30d_ret * 100, 2)
        regime_log.append(f"{regime}(btc30d={btc_30d_pct}%)")

        r_idx += REBALANCE_DAYS

    metrics = compute_strategy_metrics(raw_returns, btc_returns)
    metrics["net_annualized_return"] = round(
        float(np.mean(net_returns) * (365.25 / REBALANCE_DAYS)), 6
    )

    # Regime distribution
    regime_counts: dict[str, int] = {}
    for r in regime_log:
        rg = r.split("(")[0]
        regime_counts[rg] = regime_counts.get(rg, 0) + 1

    return {
        "performance": metrics,
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
        "regime_distribution": regime_counts,
    }


# ===================================================================
# WFO-Lite Validation (for rule-based strategies A, B, D)
# ===================================================================

def run_wfo_lite(
    strategy_fn,
    price_mtx: np.ndarray,
    all_timestamps: list[pd.Timestamp],
    symbols: list[str],
    factor_matrices: dict[str, np.ndarray],
    btc_idx: int | None,
    strategy_name: str,
    **strategy_kwargs,
) -> dict:
    """WFO-Lite validation for a rule-based strategy.

    Partitions timeline into overlapping test windows, runs the strategy
    independently in each window, and reports fold-level consistency.
    """
    n_dates = len(all_timestamps)

    if n_dates < WFO_TEST_WINDOW + 50:
        return {"status": "insufficient_data", "fold_count": 0}

    all_folds: list[dict] = []
    test_start = 0

    while test_start + WFO_TEST_WINDOW <= n_dates:
        test_end = min(test_start + WFO_TEST_WINDOW, n_dates)

        # Run strategy on this window
        window_result = strategy_fn(
            price_mtx[:, test_start:test_end],
            all_timestamps[test_start:test_end],
            symbols,
            {k: v[:, test_start:test_end] for k, v in factor_matrices.items()},
            btc_idx,
            **strategy_kwargs,
        )

        perf = window_result["performance"]
        n_periods = perf.get("n_periods", 0)

        all_folds.append({
            "fold_id": len(all_folds),
            "test_range": [
                str(all_timestamps[test_start].date()),
                str(all_timestamps[min(test_end - 1, n_dates - 1)].date()),
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
            "std_annualized_return": round(float(np.std(fold_returns, ddof=1)), 6) if len(fold_returns) > 1 else 0,
            "mean_sharpe": round(float(np.mean(fold_sharpes)), 4),
            "pass_rate": round(fold_pass / len(fold_returns), 4),
            "n_folds": len(all_folds),
            "test_window_days": WFO_TEST_WINDOW,
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
    print("Multi-Factor ML Strategy Backtest")
    print("=" * 60)

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # -------------------------------------------------------------------
    # [1] Discover symbols
    # -------------------------------------------------------------------
    print(f"\n[1] Discovering symbols (>= {MIN_MONTHS} months)...")
    symbols = discover_symbols(N_SYMBOLS)
    print(f"  Found top {len(symbols)} symbols:")
    for sym in symbols:
        print(f"    {sym}")

    if not symbols:
        print("ERROR: no symbols found. Check DATA_ROOT.", file=sys.stderr)
        report = {"generated_at": generated_at, "status": "no_symbols_found"}
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2, default=str)
        return

    # -------------------------------------------------------------------
    # [2] Load data
    # -------------------------------------------------------------------
    print(f"\n[2] Loading daily data ({START_DATE} to {END_DATE})...")
    symbol_dfs: dict[str, pd.DataFrame] = {}
    for sym in symbols:
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
    # [3] Compute features
    # -------------------------------------------------------------------
    print(f"\n[3] Computing features...")
    for sym in symbols_loaded:
        symbol_dfs[sym] = compute_features(symbol_dfs[sym])
    print(f"  Features computed for {len(symbol_dfs)} symbols")

    # -------------------------------------------------------------------
    # [4] Build matrices
    # -------------------------------------------------------------------
    print(f"\n[4] Building cross-sectional matrices...")

    factor_names = ["realized_vol_21d", "ret_5d", "range_21d"]
    factor_matrices: dict[str, np.ndarray] = {}
    dates: list[pd.Timestamp] = []

    # Use close price to establish the common timeline
    price_wide = build_wide_matrix(symbol_dfs, "close")  # date x symbol
    all_dates = sorted(price_wide.index)
    n_dates = len(all_dates)
    symbols_aligned = sorted(price_wide.columns)

    print(f"  Timeline: {all_dates[0].date()} -> {all_dates[-1].date()} ({n_dates} days)")
    print(f"  Symbols: {len(symbols_aligned)}")

    # Build price matrix (n_sym x n_dates)
    n_sym = len(symbols_aligned)
    price_mtx = np.full((n_sym, n_dates), np.nan)
    for si, sym in enumerate(symbols_aligned):
        price_mtx[si, :] = price_wide[sym].values

    # Build factor matrices and forward return matrix
    for fname in factor_names:
        wide = build_wide_matrix(symbol_dfs, fname)
        wide = wide.reindex(index=all_dates, columns=symbols_aligned)
        mat = wide.values.T  # n_sym x n_dates
        factor_matrices[fname] = mat
        n_valid = int(np.sum(~np.isnan(mat)))
        print(f"  Factor {fname:20s}: {n_valid} valid values across {n_sym} symbols")

    # Forward return matrix
    fwd_wide = build_wide_matrix(symbol_dfs, "fwd_21d")
    fwd_wide = fwd_wide.reindex(index=all_dates, columns=symbols_aligned)
    fwd_mtx = fwd_wide.values.T  # n_sym x n_dates

    n_valid_fwd = int(np.sum(~np.isnan(fwd_mtx)))
    print(f"  Forward 21d: {n_valid_fwd} valid values")

    # Locate BTC index
    btc_idx = None
    for si, sym in enumerate(symbols_aligned):
        if sym == "BTCUSDT":
            btc_idx = si
            print(f"  BTC index: {si} ({sym})")
            break

    # -------------------------------------------------------------------
    # [5] Run Strategy A: Rank Aggregation
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[5] Strategy A: Rank Aggregation Ensemble")
    print(f"{'=' * 60}")
    result_a = run_strategy_a(price_mtx, all_dates, symbols_aligned, factor_matrices, btc_idx)
    perf_a = result_a["performance"]
    print(f"  Annualized return: {perf_a['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_a['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_a['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_a['win_rate']:.2%}")
    print(f"  N periods:         {perf_a['n_periods']}")

    # WFO-Lite for Strategy A
    print(f"\n  WFO-Lite validation...")
    wfo_a = run_wfo_lite(
        run_strategy_a, price_mtx, all_dates, symbols_aligned,
        factor_matrices, btc_idx, "Strategy A"
    )
    if wfo_a.get("summary"):
        s = wfo_a["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [6] Run Strategy B: Z-Score Composite
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[6] Strategy B: Z-Score Composite")
    print(f"{'=' * 60}")
    result_b = run_strategy_b(price_mtx, all_dates, symbols_aligned, factor_matrices, btc_idx)
    perf_b = result_b["performance"]
    print(f"  Annualized return: {perf_b['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_b['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_b['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_b['win_rate']:.2%}")
    print(f"  N periods:         {perf_b['n_periods']}")

    print(f"\n  WFO-Lite validation...")
    wfo_b = run_wfo_lite(
        run_strategy_b, price_mtx, all_dates, symbols_aligned,
        factor_matrices, btc_idx, "Strategy B"
    )
    if wfo_b.get("summary"):
        s = wfo_b["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [7] Run Strategy C: Rolling Regression
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[7] Strategy C: Rolling Regression")
    print(f"{'=' * 60}")
    result_c = run_strategy_c(
        price_mtx, all_dates, symbols_aligned,
        factor_matrices, fwd_mtx, btc_idx
    )
    perf_c = result_c["performance"]
    print(f"  Annualized return: {perf_c['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_c['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_c['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_c['win_rate']:.2%}")
    print(f"  N periods:         {perf_c['n_periods']}")
    print(f"  N folds:           {result_c['n_folds']}")

    if result_c.get("fold_summary"):
        fs = result_c["fold_summary"]
        print(f"  Mean fold return:  {fs['mean_fold_return']:.2%}")
        print(f"  Fold pass rate:    {fs['fold_pass_rate']:.2%}")
        print(f"  Mean fold IC:      {fs['mean_fold_ic']:.4f}")

    # Print first few fold coefficients
    if result_c.get("fold_results"):
        print(f"\n  Fold coefficients (first 3):")
        for fold in result_c["fold_results"][:3]:
            c = fold["coefficients"]
            print(f"    Fold {fold['fold_id']}: vol={c['vol_21d']:.4f}, "
                  f"ret5={c['ret_5d']:.4f}, range={c['range_21d']:.4f}, "
                  f"IC={fold['mean_prediction_ic']:.4f}")

    # -------------------------------------------------------------------
    # [8] Run Strategy D: Regime-Weighted
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[8] Strategy D: Regime-Weighted")
    print(f"{'=' * 60}")
    result_d = run_strategy_d(price_mtx, all_dates, symbols_aligned, factor_matrices, btc_idx)
    perf_d = result_d["performance"]
    print(f"  Annualized return: {perf_d['annualized_return']:.2%}")
    print(f"  Sharpe:            {perf_d['sharpe_ratio']:.2f}")
    print(f"  Max drawdown:      {perf_d['max_drawdown_pct']:.2%}")
    print(f"  Win rate:          {perf_d['win_rate']:.2%}")
    print(f"  N periods:         {perf_d['n_periods']}")
    print(f"  Regime distribution: {result_d.get('regime_distribution', {})}")

    print(f"\n  WFO-Lite validation...")
    wfo_d = run_wfo_lite(
        run_strategy_d, price_mtx, all_dates, symbols_aligned,
        factor_matrices, btc_idx, "Strategy D"
    )
    if wfo_d.get("summary"):
        s = wfo_d["summary"]
        print(f"    {s['n_folds']} folds, mean return={s['mean_annualized_return']:.2%}, "
              f"pass rate={s['pass_rate']:.2%}")

    # -------------------------------------------------------------------
    # [9] Build report
    # -------------------------------------------------------------------
    print(f"\n{'=' * 60}")
    print(f"[9] Building final report...")

    # Strip away detailed period_returns to keep report size manageable
    # Keep summary only in the top-level report
    report: dict = {
        "generated_at": generated_at,
        "status": "completed",
        "config": {
            "n_symbols": len(symbols_aligned),
            "symbols": symbols_aligned,
            "rebalance_days": REBALANCE_DAYS,
            "long_pct": LONG_PCT,
            "cost_per_leg_bps": COST_PER_LEG_BPS,
            "period": f"{START_DATE} to {END_DATE}",
            "n_dates": n_dates,
            "date_range": {
                "start": str(all_dates[0].date()),
                "end": str(all_dates[-1].date()),
            },
        },
        "factors_used": [
            {
                "name": "realized_vol_21d",
                "direction": "ascending",
                "ic_prior": -0.105,
            },
            {
                "name": "ret_5d",
                "direction": "ascending",
                "ic_prior": -0.044,
            },
            {
                "name": "range_21d",
                "direction": "ascending",
                "ic_prior": -0.073,
            },
        ],
        "strategy_a_rank_aggregation": {
            "description": "Average of factor ranks across realized_vol_21d, ret_5d, range_21d. Select top 25% by best (lowest) rank. Equal-weight, rebalance 21d.",
            "performance": result_a["performance"],
            "wfo_lite": wfo_a,
            "n_periods": perf_a["n_periods"],
        },
        "strategy_b_zscore_composite": {
            "description": "Cross-sectional z-score each factor, average z-scores, select top 25% by lowest (most negative) z. Equal-weight, rebalance 21d.",
            "performance": result_b["performance"],
            "wfo_lite": wfo_b,
            "n_periods": perf_b["n_periods"],
        },
        "strategy_c_rolling_regression": {
            "description": "LinearRegression(forward_21d ~ vol_21d + ret_5d + range_21d) trained on rolling 365-day window. Coefficients applied to next 63 days. WFO by construction.",
            "performance": result_c["performance"],
            "fold_count": result_c["n_folds"],
            "fold_summary": result_c["fold_summary"],
            "fold_results": result_c["fold_results"],
            "n_periods": perf_c["n_periods"],
        },
        "strategy_d_regime_weighted": {
            "description": "Classify BTC regime: uptrend (>5%/30d) -> momentum(ret_5d descending); downtrend (<-5%) -> low-vol(realized_vol_21d ascending); sideways -> reversal(ret_5d ascending). Top 25% by regime factor.",
            "performance": result_d["performance"],
            "regime_distribution": result_d["regime_distribution"],
            "wfo_lite": wfo_d,
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
    print(f"  {'-'*30} {'-'*10} {'-'*8} {'-'*10} {'-'*8} {'-'*5}")
    for name, perf in [
        ("A: Rank Aggregation", perf_a),
        ("B: Z-Score Composite", perf_b),
        ("C: Rolling Regression", perf_c),
        ("D: Regime-Weighted", perf_d),
    ]:
        print(f"  {name:30s} {perf['annualized_return']:>9.2%} "
              f"{perf['sharpe_ratio']:>7.2f} "
              f"{perf['max_drawdown_pct']:>9.2%} "
              f"{perf['win_rate']:>7.2%} "
              f"{perf['n_periods']:>5d}")

    print(f"\nDone.")


if __name__ == "__main__":
    main()
