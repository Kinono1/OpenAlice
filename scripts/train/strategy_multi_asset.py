#!/usr/bin/env python3
"""
Multi-asset strategy backtest — four distinct strategies across asset classes.

Strategies:
  A — ETH/BTC Ratio: z-score of ETH/BTC ratio. <-1 → long alts, >1 → long BTC.
  B — Layer Rotation: monthly overweight the hottest group (L1 / DeFi / Meme).
  C — Market-cap Decile: rank by size proxy, buy bottom 50 % (small-cap effect).
  D — Inverse V6a: long the highest-volatility coins (bottom 75% vol filter).

Data: Binance daily klines (ZIP) from the OpenAlice warehouse.
All four use Walk-Forward Optimisation (train=365d, test=63d).

Output: data/research/strategy_multi_asset_report.json
No secrets, no API calls.  Read-only on ZIP files.
"""

from __future__ import annotations

import json
import os
import sys
import zipfile
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

import numpy as np

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
    "/spot-all-usdt-klines-1d/spot"
)
COST_BPS = 15                     # round-trip transaction cost in bps
MIN_MONTHS = 36                   # minimum months of data to include a symbol
TOP_N_SYMBOLS = 100               # max symbols to load for cross-sectional strats

# WFO parameters (shared across all four strategies)
WFO_TRAIN_DAYS = 365
WFO_TEST_DAYS = 63
WFO_STEP_DAYS = 21

OUTPUT_PATH = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
    "/data/research/strategy_multi_asset_report.json"
)

LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")

# Strategy B — Layer groups
LAYER_GROUPS: dict[str, list[str]] = {
    "L1":   ["BTCUSDT", "ETHUSDT", "SOLUSDT", "ADAUSDT", "AVAXUSDT", "NEARUSDT", "TRXUSDT"],
    "DeFi": ["UNIUSDT", "AAVEUSDT", "MKRUSDT", "INJUSDT"],
    "Meme": ["DOGEUSDT"],
}
ALL_LAYER_SYMBOLS = list({s for syms in LAYER_GROUPS.values() for s in syms})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _ms(date_str: str) -> int:
    """ISO date string -> millisecond UTC timestamp."""
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)


def _ym_range(start_str: str, end_str: str):
    """Yield (year, month) tuples from start to end inclusive."""
    sy, sm = int(start_str[:4]), int(start_str[5:7])
    ey, em = int(end_str[:4]), int(end_str[5:7])
    y, m = sy, sm
    while (y, m) <= (ey, em):
        yield y, m
        m += 1
        if m > 12:
            m = 1
            y += 1


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def discover_symbols(min_months: int = MIN_MONTHS,
                     top_n: int = TOP_N_SYMBOLS,
                     exclude_leveraged: bool = True) -> list[str]:
    """Return up to *top_n* symbols with at least *min_months* of daily data."""
    scored: list[tuple[str, int]] = []
    for d in sorted(os.listdir(DATA_ROOT)):
        if exclude_leveraged and d.startswith(LEVERAGED_PATTERNS):
            continue
        kline_path = os.path.join(DATA_ROOT, d, "1d")
        if not os.path.isdir(kline_path):
            continue
        months = [f for f in os.listdir(kline_path) if f.endswith(".zip")]
        if len(months) >= min_months:
            scored.append((d, len(months)))
    scored.sort(key=lambda x: -x[1])
    return [sym for sym, _ in scored[:top_n]]


def _load_symbol_klines(symbol: str) -> dict[str, dict[str, float]]:
    """
    Load daily OHLCV for one symbol into {date_str: {open, high, low, close, volume, quote_vol}}.
    Returns empty dict if the directory is missing.
    """
    kline_path = os.path.join(DATA_ROOT, symbol, "1d")
    if not os.path.isdir(kline_path):
        return {}

    rows: dict[str, dict[str, float]] = {}
    for fname in sorted(os.listdir(kline_path)):
        if not fname.endswith(".zip"):
            continue
        fpath = os.path.join(kline_path, fname)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode("utf-8", errors="replace")
                for line in text.strip().split("\n"):
                    cols = line.split(",")
                    if len(cols) < 8:
                        continue
                    try:
                        ts_ms = int(cols[0])
                        o = float(cols[1])
                        h = float(cols[2])
                        l_ = float(cols[3])
                        c = float(cols[4])
                        v = float(cols[5])
                        qv = float(cols[7])
                    except (ValueError, IndexError):
                        continue
                    date_str = datetime.fromtimestamp(
                        ts_ms / 1000, tz=timezone.utc
                    ).strftime("%Y-%m-%d")
                    rows[date_str] = {
                        "open": o, "high": h, "low": l_, "close": c,
                        "volume": v, "quote_vol": qv,
                    }
        except Exception:
            continue
    return rows


def load_universe(
    symbols: list[str],
    year_min: int = 2019,
    year_max: int = 2026,
) -> dict[str, dict[str, dict[str, float]]]:
    """Load full OHLCV for a list of symbols."""
    result: dict[str, dict[str, dict[str, float]]] = {}
    for sym in symbols:
        klines = _load_symbol_klines(sym)
        if klines:
            result[sym] = klines
    return result


def daily_returns(
    ohlcv: dict[str, dict[str, float]],
) -> dict[str, float]:
    """Compute daily simple returns from close prices."""
    dates = sorted(ohlcv.keys())
    rets: dict[str, float] = {}
    for i in range(1, len(dates)):
        prev_close = ohlcv[dates[i - 1]]["close"]
        cur_close = ohlcv[dates[i]]["close"]
        if prev_close > 0:
            rets[dates[i]] = (cur_close - prev_close) / prev_close
    return rets


def isin_dates(ohlcv: dict[str, dict[str, float]]) -> list[str]:
    """Return sorted date strings for which we have data."""
    return sorted(ohlcv.keys())


# ---------------------------------------------------------------------------
# Walk-forward fold iterator
# ---------------------------------------------------------------------------
def wfo_folds(all_dates: list[str]) -> list[dict[str, str]]:
    """
    Yield fold dicts {train_start, train_end, test_start, test_end}
    for (train=365d, test=63d, step=21d).
    """
    folds: list[dict[str, str]] = []
    i = 0
    while i + WFO_TRAIN_DAYS + WFO_TEST_DAYS <= len(all_dates):
        folds.append({
            "train_start": all_dates[i],
            "train_end":   all_dates[i + WFO_TRAIN_DAYS],
            "test_start":  all_dates[i + WFO_TRAIN_DAYS],
            "test_end":    all_dates[min(i + WFO_TRAIN_DAYS + WFO_TEST_DAYS,
                                        len(all_dates) - 1)],
        })
        i += WFO_STEP_DAYS
    return folds


# ---------------------------------------------------------------------------
# Per-window metrics helpers
# ---------------------------------------------------------------------------
def window_return(ohlcv: dict[str, dict[str, float]],
                  sym: str, date_start: str, date_end: str) -> float | None:
    """Simple return for *sym* between two dates."""
    s = ohlcv.get(sym, {}).get(date_start, {}).get("close")
    e = ohlcv.get(sym, {}).get(date_end, {}).get("close")
    if s and e and s > 0:
        return (e - s) / s
    return None


def fold_summary(fold_returns: list[float],
                 fold_bench: list[float] | None = None) -> dict[str, Any]:
    """Aggregate metrics for one fold's rebalance-window returns."""
    if not fold_returns:
        return {}
    arr = np.array(fold_returns)
    mean_r = float(np.mean(arr))
    std_r = float(np.std(arr, ddof=1)) if len(arr) > 1 else 0.0
    sharpe = (mean_r / std_r * np.sqrt(12)) if std_r > 0 else 0.0
    out: dict[str, Any] = {
        "n_windows": len(fold_returns),
        "mean_return": mean_r,
        "median_return": float(np.median(arr)),
        "std_return": std_r,
        "win_rate": float(np.mean(arr > 0)),
        "sharpe_window": float(sharpe),
        "cum_return": float(np.prod(1 + arr) - 1),
    }
    if fold_bench is not None and len(fold_bench) == len(fold_returns):
        b_arr = np.array(fold_bench)
        out["bench_mean_return"] = float(np.mean(b_arr))
        out["outperform_rate"] = float(np.mean(arr > b_arr))
    return out


def wfo_aggregate(fold_results: list[dict[str, Any] | None]) -> dict[str, Any]:
    """Aggregate across WFO folds."""
    valid = [f for f in fold_results if f is not None]
    if not valid:
        return {"fold_count": 0}
    fold_means = [f["mean_return"] for f in valid]
    fold_sharpes = [f["sharpe_window"] for f in valid]
    mean_r = float(np.mean(fold_means))
    std_r = float(np.std(fold_means, ddof=1)) if len(fold_means) > 1 else 0.0
    return {
        "fold_count": len(valid),
        "mean_fold_return": mean_r,
        "std_fold_return": std_r,
        "mean_fold_sharpe": float(np.mean(fold_sharpes)),
        "pass_rate_return_gt0": float(np.mean([m > 0 for m in fold_means])),
        "best_fold_return": float(max(fold_means)),
        "worst_fold_return": float(min(fold_means)),
        "folds": valid,
    }


# ===================================================================
# STRATEGY A — ETH/BTC Ratio
# ===================================================================
def strategy_a_ratio(
    ohlcv: dict[str, dict[str, dict[str, float]]],
    folds: list[dict[str, str]],
) -> dict[str, Any]:
    """
    ETH/BTC ratio z-score strategy.

    At each rebalance (21d):
      - Compute z-score of ETH/BTC ratio over a 90d lookback.
      - z < -1 → long all alt-symbols equally.
      - z > +1 → long BTC only.
      - otherwise → 50/50 BTC + alt basket.

    The "training" window is used to calibrate the z-score threshold;
    here the threshold is fixed at ±1, but the z-score is computed
    from rolling moments estimated over the train window.
    """
    ETH = "ETHUSDT"
    BTC = "BTCUSDT"
    ALT_SYMBOLS = [s for s in ohlcv if s not in (ETH, BTC)]
    REBAL = 21

    def _run_fold(fold: dict[str, str]) -> dict[str, Any] | None:
        test_dates = [d for d in isin_dates(ohlcv.get(BTC, {}))
                      if fold["test_start"] <= d < fold["test_end"]]
        if len(test_dates) < REBAL:
            return None

        # Build ETH/BTC ratio time series over the train + test period
        lookback_start = fold["train_start"]
        all_ratio_dates: list[str] = []
        ratio_values: list[float] = []
        btc_ohlcv = ohlcv.get(BTC, {})
        eth_ohlcv = ohlcv.get(ETH, {})

        for d in sorted(set(list(btc_ohlcv.keys()) + list(eth_ohlcv.keys()))):
            if d < lookback_start or d > fold["test_end"]:
                continue
            b = btc_ohlcv.get(d, {}).get("close")
            e = eth_ohlcv.get(d, {}).get("close")
            if b and e and b > 0:
                all_ratio_dates.append(d)
                ratio_values.append(e / b)

        if len(ratio_values) < 100:
            return None

        ratio_arr = np.array(ratio_values)

        # Rolling z-score using expanding window on training data only
        def _zscore(idx: int) -> float:
            # use all train data up to & including this point
            train_slice = ratio_arr[:idx + 1]
            if len(train_slice) < 30:
                return 0.0
            mu = float(np.mean(train_slice))
            sd = float(np.std(train_slice, ddof=1))
            if sd == 0:
                return 0.0
            return (ratio_arr[idx] - mu) / sd

        fold_rets: list[float] = []
        bench_rets: list[float] = []
        rebal_ix = list(range(0, len(test_dates), REBAL))

        for wi in range(len(rebal_ix) - 1):
            si, ei = rebal_ix[wi], rebal_ix[wi + 1]
            window_dates = test_dates[si:ei]
            if len(window_dates) < 2:
                continue

            rebal_date = test_dates[si]

            # Find ratio value and index for this date
            try:
                ridx = all_ratio_dates.index(rebal_date)
            except ValueError:
                continue
            z = _zscore(ridx)

            # Allocate
            if z < -1:
                # long all alts equally
                weights = {s: 1.0 / len(ALT_SYMBOLS) for s in ALT_SYMBOLS}
            elif z > 1:
                # long BTC only
                weights = {BTC: 1.0}
            else:
                # 50/50 BTC + alt basket
                weights = {BTC: 0.5}
                for s in ALT_SYMBOLS:
                    weights[s] = 0.5 / len(ALT_SYMBOLS)

            # Compute portfolio return over window
            w_ret = 0.0
            for sym, w in weights.items():
                r = window_return(ohlcv, sym, window_dates[0], window_dates[-1])
                if r is not None:
                    w_ret += w * r
            # Cost: one rebalance per leg
            w_ret -= COST_BPS / 10000 * 2
            fold_rets.append(w_ret)

            # Benchmark: BTC
            btc_r = window_return(ohlcv, BTC, window_dates[0], window_dates[-1])
            bench_rets.append(btc_r if btc_r is not None else 0.0)

        if len(fold_rets) < 2:
            return None

        out = fold_summary(fold_rets, bench_rets)
        out["train_range"] = f'{fold["train_start"]} ~ {fold["train_end"]}'
        out["test_range"] = f'{fold["test_start"]} ~ {fold["test_end"]}'
        return out

    fold_results = [_run_fold(f) for f in folds]
    return wfo_aggregate(fold_results)


# ===================================================================
# STRATEGY B — Layer Rotation
# ===================================================================
def strategy_b_layer_rotation(
    ohlcv: dict[str, dict[str, dict[str, float]]],
    folds: list[dict[str, str]],
) -> dict[str, Any]:
    """
    Each month, compute the 30d return of each group (L1, DeFi, Meme).
    Overweight (allocate 100 % to) the group with the highest 30d return.
    Rebalance 30d.
    """

    def _group_return(ohlcv_data: dict, symbols: list[str],
                      start: str, end: str) -> float:
        """Equal-weighted return of a group between two dates."""
        rets = []
        for s in symbols:
            r = window_return(ohlcv_data, s, start, end)
            if r is not None:
                rets.append(r)
        return float(np.mean(rets)) if rets else float("-inf")

    REBAL = 30

    def _run_fold(fold: dict[str, str]) -> dict[str, Any] | None:
        btc = ohlcv.get("BTCUSDT", {})
        test_dates = [d for d in sorted(btc.keys())
                      if fold["test_start"] <= d < fold["test_end"]]
        if len(test_dates) < REBAL:
            return None

        fold_rets: list[float] = []
        bench_rets: list[float] = []
        rebal_ix = list(range(0, len(test_dates), REBAL))

        for wi in range(len(rebal_ix) - 1):
            si, ei = rebal_ix[wi], rebal_ix[wi + 1]
            window_dates = test_dates[si:ei]
            if len(window_dates) < 2:
                continue

            rebal_date = test_dates[si]
            # Look back 30 days from rebalance to compute group return
            lookback = max(0, si - 30)

            group_scores: dict[str, float] = {}
            for gname, syms in LAYER_GROUPS.items():
                gr = _group_return(ohlcv, syms,
                                   test_dates[lookback] if lookback < si else test_dates[0],
                                   rebal_date)
                group_scores[gname] = gr

            # Pick best group
            best_group = max(group_scores, key=group_scores.get)  # type: ignore[arg-type]

            # Allocate equal-weight to all symbols in the best group
            best_syms = LAYER_GROUPS[best_group]
            w = 1.0 / len(best_syms)

            port_ret = 0.0
            for s in best_syms:
                r = window_return(ohlcv, s, window_dates[0], window_dates[-1])
                if r is not None:
                    port_ret += w * r
            port_ret -= COST_BPS / 10000 * 2
            fold_rets.append(port_ret)

            btc_r = window_return(ohlcv, "BTCUSDT", window_dates[0], window_dates[-1])
            bench_rets.append(btc_r if btc_r is not None else 0.0)

        if len(fold_rets) < 2:
            return None

        out = fold_summary(fold_rets, bench_rets)
        out["train_range"] = f'{fold["train_start"]} ~ {fold["train_end"]}'
        out["test_range"] = f'{fold["test_start"]} ~ {fold["test_end"]}'
        return out

    fold_results = [_run_fold(f) for f in folds]
    return wfo_aggregate(fold_results)


# ===================================================================
# STRATEGY C — Market-cap Decile (small-cap effect)
# ===================================================================
def strategy_c_market_cap_decile(
    ohlcv: dict[str, dict[str, dict[str, float]]],
    folds: list[dict[str, str]],
) -> dict[str, Any]:
    """
    Each month, rank all coins by market-cap proxy
    (30d average quote_volume × close).  Buy the bottom 50 % (smaller coins).
    Rebalance 30d.
    The training window sets the threshold (median rank).
    """

    REBAL = 30

    def _mcap_proxy(ohlcv_data: dict, sym: str, center_date: str,
                    lookback: int = 30) -> float | None:
        """30d avg quote_vol × close as of *center_date*."""
        kls = ohlcv_data.get(sym, {})
        dates = sorted(d for d in kls if d <= center_date)
        if len(dates) < lookback:
            return None
        recent = dates[-lookback:]
        avg_qv = float(np.mean([kls[d]["quote_vol"] for d in recent]))
        last_close = kls[recent[-1]]["close"]
        return avg_qv * last_close

    def _run_fold(fold: dict[str, str]) -> dict[str, Any] | None:
        btc = ohlcv.get("BTCUSDT", {})
        test_dates = [d for d in sorted(btc.keys())
                      if fold["test_start"] <= d < fold["test_end"]]
        if len(test_dates) < REBAL:
            return None

        fold_rets: list[float] = []
        bench_rets: list[float] = []
        rebal_ix = list(range(0, len(test_dates), REBAL))

        for wi in range(len(rebal_ix) - 1):
            si, ei = rebal_ix[wi], rebal_ix[wi + 1]
            window_dates = test_dates[si:ei]
            if len(window_dates) < 2:
                continue

            rebal_date = test_dates[si]

            # Compute mcap proxy for each symbol
            proxies: list[tuple[str, float]] = []
            for sym in ohlcv:
                p = _mcap_proxy(ohlcv, sym, rebal_date)
                if p is not None and p > 0:
                    proxies.append((sym, p))

            if len(proxies) < 4:
                continue

            # Rank ascending → smaller coins first
            proxies.sort(key=lambda x: x[1])
            n_buy = max(1, len(proxies) // 2)
            buy_syms = [sym for sym, _ in proxies[:n_buy]]

            w = 1.0 / len(buy_syms)
            port_ret = 0.0
            for s in buy_syms:
                r = window_return(ohlcv, s, window_dates[0], window_dates[-1])
                if r is not None:
                    port_ret += w * r
            port_ret -= COST_BPS / 10000 * 2
            fold_rets.append(port_ret)

            btc_r = window_return(ohlcv, "BTCUSDT", window_dates[0], window_dates[-1])
            bench_rets.append(btc_r if btc_r is not None else 0.0)

        if len(fold_rets) < 2:
            return None

        out = fold_summary(fold_rets, bench_rets)
        out["train_range"] = f'{fold["train_start"]} ~ {fold["train_end"]}'
        out["test_range"] = f'{fold["test_start"]} ~ {fold["test_end"]}'
        return out

    fold_results = [_run_fold(f) for f in folds]
    return wfo_aggregate(fold_results)


# ===================================================================
# STRATEGY D — Inverse V6a (high vol)
# ===================================================================
def strategy_d_inverse_v6a(
    ohlcv: dict[str, dict[str, dict[str, float]]],
    folds: list[dict[str, str]],
) -> dict[str, Any]:
    """
    Buy the highest-volatility coins (opposite of V6a which buys low vol).
    Filter: only trade the bottom 75 % of universe by volatility
    (i.e. exclude the most extreme 25 % of outliers).
    Rebalance 60d.
    """

    REBAL = 60
    VOL_LOOKBACK = 60

    def _run_fold(fold: dict[str, str]) -> dict[str, Any] | None:
        btc = ohlcv.get("BTCUSDT", {})
        test_dates = [d for d in sorted(btc.keys())
                      if fold["test_start"] <= d < fold["test_end"]]
        if len(test_dates) < REBAL:
            return None

        fold_rets: list[float] = []
        bench_rets: list[float] = []
        rebal_ix = list(range(0, len(test_dates), REBAL))

        for wi in range(len(rebal_ix) - 1):
            si, ei = rebal_ix[wi], rebal_ix[wi + 1]
            window_dates = test_dates[si:ei]
            if len(window_dates) < 2:
                continue

            rebal_date = test_dates[si]

            # Compute realised volatility for each symbol
            vol_scores: list[tuple[str, float]] = []
            for sym, kls in ohlcv.items():
                date_returns = daily_returns(kls)
                vol_dates = sorted(d for d in date_returns if d <= rebal_date)
                if len(vol_dates) < VOL_LOOKBACK // 2:
                    continue
                recent_rets = [date_returns[d] for d in vol_dates[-VOL_LOOKBACK:]]
                vol = float(np.std(recent_rets, ddof=1))
                if vol > 0 and not np.isnan(vol):
                    vol_scores.append((sym, vol))

            if len(vol_scores) < 4:
                continue

            # Sort by vol descending
            vol_scores.sort(key=lambda x: -x[1])

            # Bottom 75 % filter: keep only the first 75 % of ranked symbols
            cutoff = max(1, int(len(vol_scores) * 0.75))
            trade_syms = [sym for sym, _ in vol_scores[:cutoff]]

            # Among those, buy the highest vol (top 25 % of the filtered set)
            n_high = max(1, int(len(trade_syms) * 0.25))
            buy_syms = [sym for sym, _ in vol_scores[:n_high]]

            w = 1.0 / len(buy_syms)
            port_ret = 0.0
            for s in buy_syms:
                r = window_return(ohlcv, s, window_dates[0], window_dates[-1])
                if r is not None:
                    port_ret += w * r
            port_ret -= COST_BPS / 10000 * 2
            fold_rets.append(port_ret)

            btc_r = window_return(ohlcv, "BTCUSDT", window_dates[0], window_dates[-1])
            bench_rets.append(btc_r if btc_r is not None else 0.0)

        if len(fold_rets) < 1:
            return None

        out = fold_summary(fold_rets, bench_rets)
        out["train_range"] = f'{fold["train_start"]} ~ {fold["train_end"]}'
        out["test_range"] = f'{fold["test_start"]} ~ {fold["test_end"]}'
        return out

    fold_results = [_run_fold(f) for f in folds]
    return wfo_aggregate(fold_results)


# ===================================================================
# Main
# ===================================================================
def main() -> None:
    print("=" * 60)
    print("Multi-Asset Strategy Backtest")
    print("=" * 60)

    # ------------------------------------------------------------------
    # 1. Data loading
    # ------------------------------------------------------------------
    print("\n[1/4] Discovering symbols ...")
    symbols = discover_symbols(min_months=MIN_MONTHS, top_n=TOP_N_SYMBOLS)
    print(f"  Found {len(symbols)} symbols with >= {MIN_MONTHS} months of data")

    # Ensure key symbols are present for strategies A & B
    for required in ["BTCUSDT", "ETHUSDT"] + ALL_LAYER_SYMBOLS:
        if required not in symbols:
            symbols.insert(0, required)

    print("\n[2/4] Loading OHLCV data ...")
    ohlcv = load_universe(symbols)
    print(f"  Loaded {len(ohlcv)} symbols")

    btc_dates = isin_dates(ohlcv.get("BTCUSDT", {}))
    print(f"  BTC date range: {btc_dates[0]} to {btc_dates[-1]} ({len(btc_dates)} days)")

    # ------------------------------------------------------------------
    # 2. WFO folds
    # ------------------------------------------------------------------
    all_dates = btc_dates  # use BTC calendar as reference
    folds = wfo_folds(all_dates)
    print(f"\n[3/4] WFO folds: {len(folds)} (train={WFO_TRAIN_DAYS}d, test={WFO_TEST_DAYS}d, step={WFO_STEP_DAYS}d)")

    # ------------------------------------------------------------------
    # 3. Run strategies
    # ------------------------------------------------------------------
    print("\n[4/4] Running strategies ...")
    results: dict[str, Any] = {}

    # --- Strategy A ---
    print("\n  --- Strategy A: ETH/BTC Ratio ---")
    res_a = strategy_a_ratio(ohlcv, folds)
    print(f"    Folds: {res_a.get('fold_count', 0)}")
    print(f"    Mean fold return: {res_a.get('mean_fold_return', 0):.4f}")
    print(f"    Mean fold Sharpe: {res_a.get('mean_fold_sharpe', 0):.2f}")
    print(f"    Pass rate (return > 0): {res_a.get('pass_rate_return_gt0', 0):.2%}")
    results["strategy_a_eth_btc_ratio"] = res_a

    # --- Strategy B ---
    print("\n  --- Strategy B: Layer Rotation ---")
    res_b = strategy_b_layer_rotation(ohlcv, folds)
    print(f"    Folds: {res_b.get('fold_count', 0)}")
    print(f"    Mean fold return: {res_b.get('mean_fold_return', 0):.4f}")
    print(f"    Mean fold Sharpe: {res_b.get('mean_fold_sharpe', 0):.2f}")
    print(f"    Pass rate (return > 0): {res_b.get('pass_rate_return_gt0', 0):.2%}")
    results["strategy_b_layer_rotation"] = res_b

    # --- Strategy C ---
    print("\n  --- Strategy C: Market-cap Decile ---")
    res_c = strategy_c_market_cap_decile(ohlcv, folds)
    print(f"    Folds: {res_c.get('fold_count', 0)}")
    print(f"    Mean fold return: {res_c.get('mean_fold_return', 0):.4f}")
    print(f"    Mean fold Sharpe: {res_c.get('mean_fold_sharpe', 0):.2f}")
    print(f"    Pass rate (return > 0): {res_c.get('pass_rate_return_gt0', 0):.2%}")
    results["strategy_c_market_cap_decile"] = res_c

    # --- Strategy D ---
    print("\n  --- Strategy D: Inverse V6a ---")
    res_d = strategy_d_inverse_v6a(ohlcv, folds)
    print(f"    Folds: {res_d.get('fold_count', 0)}")
    print(f"    Mean fold return: {res_d.get('mean_fold_return', 0):.4f}")
    print(f"    Mean fold Sharpe: {res_d.get('mean_fold_sharpe', 0):.2f}")
    print(f"    Pass rate (return > 0): {res_d.get('pass_rate_return_gt0', 0):.2%}")
    results["strategy_d_inverse_v6a"] = res_d

    # ------------------------------------------------------------------
    # 4. Build report
    # ------------------------------------------------------------------
    report: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "strategy": "multi_asset",
        "config": {
            "n_symbols": len(ohlcv),
            "cost_bps": COST_BPS,
            "period": f"{all_dates[0]} to {all_dates[-1]}",
            "wfo": {
                "train_days": WFO_TRAIN_DAYS,
                "test_days": WFO_TEST_DAYS,
                "step_days": WFO_STEP_DAYS,
            },
            "strategies": {
                "A": {
                    "name": "ETH/BTC Ratio",
                    "rebalance_days": 21,
                    "lookback_days": 90,
                    "zscore_threshold": 1.0,
                },
                "B": {
                    "name": "Layer Rotation",
                    "rebalance_days": 30,
                    "groups": {k: v for k, v in LAYER_GROUPS.items()},
                },
                "C": {
                    "name": "Market-cap Decile",
                    "rebalance_days": 30,
                    "buy_pct": 0.50,
                },
                "D": {
                    "name": "Inverse V6a",
                    "rebalance_days": 60,
                    "vol_lookback_days": 60,
                    "vol_filter_pct": 0.75,
                    "buy_top_pct_of_filtered": 0.25,
                },
            },
        },
        "results": results,
    }

    # M1 gate: pass if at least one strategy has mean_fold_return > 0 and pass_rate > 0.3
    strat_pass = [
        name for name, r in results.items()
        if r.get("mean_fold_return", -1) > 0 and r.get("pass_rate_return_gt0", 0) > 0.3
    ]
    report["m1_pass"] = len(strat_pass) > 0
    report["m1_pass_strategies"] = strat_pass

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)
    print(f"\n{'=' * 60}")
    print(f"Report written to {OUTPUT_PATH}")
    print(f"M1 pass: {'YES' if report['m1_pass'] else 'NO'}")
    if strat_pass:
        print(f"  Passing strategies: {', '.join(strat_pass)}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
