#!/usr/bin/env python3
"""
Test 5-minute cross-sectional strategies with WFO-Lite.

Strategies:
  A: 5m low-vol        — realized_vol over 12 bars, buy bottom 25%, hourly rebalance
  B: 5m reversal       — ret_3bars (15min), buy past losers, 15min rebalance
  C: 5m momentum+vol   — ret_12bars + volume > 1.5x avg, hourly rebalance

WFO-Lite: train=7d, test=1d, step=12h
Cost: 30 bps per trade
Universe: top 10 coins (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, DOT)

Output: data/research/strategy_5m_report.json
No secrets, no API calls.  Read-only on ZIP files.
"""

import json
import os
import sys
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np

warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
DATA_ROOT = (
    "/Volumes/shield/cryptoData/openalice-data/market/binance-public/"
    "spot-all-usdt-klines-5m/spot"
)
SYMBOLS = [
    "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT",
    "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
    "LINKUSDT", "DOTUSDT",
]
YEAR = 2024
COST_BPS = 30                     # transaction cost per rebalance entry
SELECT_PCT = 0.25                 # top/bottom fraction to select

# WFO-Lite parameters
TRAIN_DAYS = 7
TEST_DAYS = 1
STEP_HOURS = 12

# Time-bar constants (5-minute bars)
N_BARS_HOUR = 12                  # 12 x 5min = 1 hour
N_BARS_15MIN = 3                  # 3 x 5min = 15min

OUTPUT_PATH = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice/"
    "data/research/strategy_5m_report.json"
)


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def load_5m_bars(symbol: str, year: int) -> list[tuple]:
    """Load 5m (timestamp_ms, close, volume) rows for *symbol* in *year*.

    Data stored as monthly ZIP files of Binance kline CSV.
    Columns in each row: open_time,open,high,low,close,volume,...
    """
    kline_path = os.path.join(DATA_ROOT, symbol, "5m")
    rows: list[tuple[int, float, float]] = []
    for month in range(1, 13):
        zip_name = f"{symbol}-5m-{year}-{month:02d}.zip"
        zip_path = os.path.join(kline_path, zip_name)
        if not os.path.exists(zip_path):
            continue
        try:
            with zipfile.ZipFile(zip_path, "r") as zf:
                csv_name = zip_name.replace(".zip", ".csv")
                if csv_name not in zf.namelist():
                    continue
                raw = zf.read(csv_name).decode("utf-8")
        except Exception:
            continue
        for line in raw.strip().split("\n"):
            parts = line.split(",")
            if len(parts) >= 6:
                ts = int(parts[0])
                close = float(parts[4])
                volume = float(parts[5])
                rows.append((ts, close, volume))
    rows.sort(key=lambda r: r[0])
    return rows


def build_aligned_matrices(
    all_bars: dict[str, list[tuple]],
) -> tuple:
    """Build aligned price, return, and volume matrices from all symbols.

    Returns (timestamps, symbols, price_mtx, return_mtx, volume_mtx).
      timestamps  — list[int] of aligned bar timestamps (ms)
      symbols     — list[str] of symbol names in matrix row order
      price_mtx   — (n_sym, n_bars) float64
      return_mtx  — (n_sym, n_bars-1) float64  (period returns)
      volume_mtx  — (n_sym, n_bars) float64
    """
    all_ts = sorted({ts for bars in all_bars.values() for ts, *_ in bars})
    ts_idx = {ts: i for i, ts in enumerate(all_ts)}
    n_bars = len(all_ts)
    symbols = list(all_bars.keys())
    n_sym = len(symbols)

    price = np.full((n_sym, n_bars), np.nan, dtype=np.float64)
    volume = np.full((n_sym, n_bars), np.nan, dtype=np.float64)

    for si, sym in enumerate(symbols):
        for ts, close, vol in all_bars[sym]:
            j = ts_idx.get(ts)
            if j is not None:
                price[si, j] = close
                volume[si, j] = vol

    with np.errstate(divide="ignore", invalid="ignore"):
        returns = np.diff(price) / price[:, :-1]

    return all_ts, symbols, price, returns, volume


# ---------------------------------------------------------------------------
# Strategies  (each receives a view into the test-window slice)
# ---------------------------------------------------------------------------
def strategy_a(
    ret: np.ndarray, prc: np.ndarray, volm: np.ndarray,
    s: int, e: int,
) -> list[float]:
    """Strategy A — Low-vol: buy bottom 25% by realized vol over 12 bars.

    Rebalances hourly (every 12 bars).  Returns list of net returns (after
    30 bps cost) for periods where >= 2 coins have valid signals.
    """
    trades: list[float] = []
    first = s + N_BARS_HOUR
    last = e - N_BARS_HOUR
    for r in range(first, last, N_BARS_HOUR):
        lb = ret[:, r - N_BARS_HOUR : r]
        with np.errstate(invalid="ignore"):
            vol = np.nanstd(lb, axis=1, ddof=1)
        fwd = prc[:, r + N_BARS_HOUR] / prc[:, r] - 1.0
        valid = (~np.isnan(vol)) & (~np.isnan(fwd)) & (vol > 0) & (prc[:, r] > 0)
        vi = np.where(valid)[0]
        if len(vi) < 2:
            continue
        n_pick = max(1, int(np.ceil(len(vi) * SELECT_PCT)))
        pick = vi[np.argsort(vol[vi])[:n_pick]]
        gross = float(np.nanmean(fwd[pick]))
        trades.append(gross - COST_BPS / 10_000)
    return trades


def strategy_b(
    ret: np.ndarray, prc: np.ndarray, volm: np.ndarray,
    s: int, e: int,
) -> list[float]:
    """Strategy B — Reversal: buy bottom 25% by ret_3bars (past losers).

    Rebalances every 3 bars (15 min).  Past cumulative return over 3 bars,
    buy worst performers (lowest return).
    """
    trades: list[float] = []
    first = s + N_BARS_15MIN
    last = e - N_BARS_15MIN
    for r in range(first, last, N_BARS_15MIN):
        past = np.nansum(ret[:, r - N_BARS_15MIN : r], axis=1)
        fwd = prc[:, r + N_BARS_15MIN] / prc[:, r] - 1.0
        valid = (~np.isnan(past)) & (~np.isnan(fwd)) & (prc[:, r] > 0)
        vi = np.where(valid)[0]
        if len(vi) < 2:
            continue
        n_pick = max(1, int(np.ceil(len(vi) * SELECT_PCT)))
        pick = vi[np.argsort(past[vi])[:n_pick]]          # worst past = reversal
        gross = float(np.nanmean(fwd[pick]))
        trades.append(gross - COST_BPS / 10_000)
    return trades


def strategy_c(
    ret: np.ndarray, prc: np.ndarray, volm: np.ndarray,
    s: int, e: int,
) -> list[float]:
    """Strategy C — Momentum + volume confirmation.

    Signal: ret_12bars (momentum) + volume > 1.5x avg (24-bar lookback).
    Rebalances hourly (every 12 bars).
    """
    VOL_LB = 24  # bars for volume average (2 hours)
    trades: list[float] = []
    first = s + N_BARS_HOUR
    last = e - N_BARS_HOUR
    for r in range(first, last, N_BARS_HOUR):
        mom = np.nansum(ret[:, r - N_BARS_HOUR : r], axis=1)

        # Volume confirmation: current bar volume > 1.5x avg of prior VOL_LB bars
        avg_start = max(0, r - VOL_LB)
        avg_vol = np.nanmean(volm[:, avg_start:r], axis=1)
        cur_vol = volm[:, r]
        vol_ok = (
            (cur_vol > 1.5 * avg_vol)
            & (avg_vol > 0)
            & (~np.isnan(cur_vol))
            & (~np.isnan(avg_vol))
        )

        fwd = prc[:, r + N_BARS_HOUR] / prc[:, r] - 1.0
        valid = (~np.isnan(mom)) & (~np.isnan(fwd)) & vol_ok & (prc[:, r] > 0)
        vi = np.where(valid)[0]
        if len(vi) < 2:
            continue
        n_pick = max(1, int(np.ceil(len(vi) * SELECT_PCT)))
        pick = vi[np.argsort(-mom[vi])[:n_pick]]          # best past = momentum
        gross = float(np.nanmean(fwd[pick]))
        trades.append(gross - COST_BPS / 10_000)
    return trades


# ---------------------------------------------------------------------------
# WFO-Lite runner
# ---------------------------------------------------------------------------
def _ts_str(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%d %H:%M"
    )


def run_wfo(
    strat_fn,
    timestamps: list[int],
    price: np.ndarray,
    returns: np.ndarray,
    volume: np.ndarray,
) -> tuple[list[dict], dict]:
    """Run WFO-Lite for one strategy and return (folds, summary).

    WFO-Lite: train=7d, test=1d, step=12h.
    Each fold runs the strategy on its test-window and records per-fold metrics.
    """
    n_bars = len(timestamps)
    bpd = 24 * N_BARS_HOUR               # bars per day
    train_bars = TRAIN_DAYS * bpd
    test_bars = TEST_DAYS * bpd
    step_bars = STEP_HOURS * N_BARS_HOUR

    folds: list[dict] = []
    all_nets: list[float] = []

    fold_idx = 0
    t_start = train_bars
    while t_start + test_bars <= n_bars:
        t_end = t_start + test_bars

        trade_nets = strat_fn(returns, price, volume, t_start, t_end)

        nets_valid = [t for t in trade_nets if np.isfinite(t)]
        n_valid = len(nets_valid)

        fold_ret = float(np.mean(nets_valid)) if n_valid > 0 else 0.0
        fold_wr = float(np.mean(np.array(nets_valid) > 0)) if n_valid > 0 else 0.0

        folds.append({
            "fold": fold_idx,
            "test_window": (
                f"{_ts_str(timestamps[t_start])} -> "
                f"{_ts_str(timestamps[min(t_end - 1, n_bars - 1)])}"
            ),
            "n_rebalance_periods": len(trade_nets),
            "n_valid_trades": n_valid,
            "mean_return": round(fold_ret, 6),
            "win_rate": round(fold_wr, 4),
        })

        all_nets.extend(nets_valid)
        fold_idx += 1
        t_start += step_bars

    # -- Aggregate summary ------------------------------------------------
    n_folds = len(folds)
    if n_folds == 0:
        return folds, {
            "fold_count": 0, "total_trades": 0, "mean_win_rate": 0.0,
            "fold_pass_rate": 0.0, "mean_fold_return": 0.0,
        }

    fold_wrs = np.array([f["win_rate"] for f in folds])
    fold_rets = np.array([f["mean_return"] for f in folds])

    summary = {
        "fold_count": n_folds,
        "total_trades": int(np.sum([f["n_valid_trades"] for f in folds])),
        "mean_win_rate": round(float(np.mean(fold_wrs)), 4),
        "median_win_rate": round(float(np.median(fold_wrs)), 4),
        "std_win_rate": round(float(np.std(fold_wrs, ddof=1)), 4)
        if n_folds > 1
        else 0.0,
        "fold_pass_rate": round(float(np.mean(fold_rets > 0)), 4),
        "mean_fold_return": round(float(np.mean(fold_rets)), 6),
        "median_fold_return": round(float(np.median(fold_rets)), 6),
    }

    # Overall metrics from all individual trades
    if all_nets:
        arr = np.array(all_nets)
        summary["overall_win_rate"] = round(float(np.mean(arr > 0)), 4)
        summary["overall_mean_return"] = round(float(np.mean(arr)), 6)
        summary["overall_std_return"] = round(float(np.std(arr, ddof=1)), 6)
        sd = float(np.std(arr, ddof=1))
        # Annualized Sharpe: 288 holding periods per day * 365 = ~105120 per year
        # But Sharpe is tricky for 5-min strategies.  We use sqrt(periods_per_year).
        # A "period" is one rebalance interval.  For hourly rebalancing (strats A,C)
        # there are 24*365 = 8760 periods/year, and for 15-min (strat B) it's
        # 96*365 = 35040 periods/year.  This varies per strategy.  For simplicity
        # compute a generic per-trade Sharpe with sqrt(n).
        summary["overall_sharpe"] = (
            round(float(np.mean(arr) / sd * np.sqrt(len(arr))), 4)
            if sd > 0
            else 0.0
        )

    return folds, summary


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f"Loading 5m data for {len(SYMBOLS)} symbols (year {YEAR}) ...")
    all_bars: dict[str, list[tuple]] = {}
    for sym in SYMBOLS:
        bars = load_5m_bars(sym, YEAR)
        if bars:
            all_bars[sym] = bars
            print(f"  {sym}: {len(bars)} bars")
        else:
            print(f"  WARN: {sym} has no data")

    if not all_bars:
        print("ERROR: no data loaded. Check DATA_ROOT path.", file=sys.stderr)
        sys.exit(1)

    print("\nBuilding aligned matrices ...")
    timestamps, symbols, price, returns, volume = build_aligned_matrices(all_bars)
    n_bars = len(timestamps)
    print(f"  {len(symbols)} symbols x {n_bars} bars")
    print(f"  Range: {_ts_str(timestamps[0])} -> {_ts_str(timestamps[-1])}")

    bpd = 24 * N_BARS_HOUR
    print(f"\nWFO-Lite: train={TRAIN_DAYS}d, test={TEST_DAYS}d, step={STEP_HOURS}h")
    print(f"  bars/day={bpd}, train={TRAIN_DAYS*bpd}, test={TEST_DAYS*bpd}, step={STEP_HOURS*N_BARS_HOUR}")

    strategies = {
        "low_vol": {
            "fn": strategy_a,
            "desc": (
                "5m low-vol: realized_vol over 12 bars (60 min), "
                "buy bottom 25%, hourly rebalance"
            ),
        },
        "reversal": {
            "fn": strategy_b,
            "desc": (
                "5m reversal: ret_3bars (15 min), "
                "buy past losers (bottom 25%), 15-min rebalance"
            ),
        },
        "momentum_volume": {
            "fn": strategy_c,
            "desc": (
                "5m momentum + volume confirmation: ret_12bars (60 min) "
                "+ volume > 1.5x avg (24-bar lookback), hourly rebalance"
            ),
        },
    }

    results: dict[str, dict] = {}
    for name, cfg in strategies.items():
        print(f"\n{'='*60}")
        print(f"Strategy: {name}")
        print(f"  {cfg['desc']}")
        folds, summary = run_wfo(cfg["fn"], timestamps, price, returns, volume)
        print(f"  Folds computed: {summary['fold_count']}")
        print(f"  Total trades:   {summary['total_trades']}")
        print(f"  Mean win rate:  {summary['mean_win_rate']:.2%}")
        print(f"  Fold pass rate: {summary['fold_pass_rate']:.2%}")
        print(f"  Mean fold ret:  {summary['mean_fold_return']:.4f}")
        if "overall_win_rate" in summary:
            print(f"  Overall win:    {summary['overall_win_rate']:.2%}")
            print(f"  Overall Sharpe: {summary.get('overall_sharpe', 0):.2f}")
        results[name] = {
            "description": cfg["desc"],
            "folds": folds,
            "summary": summary,
        }

    # ---- Build report ---------------------------------------------------
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": {
            "symbols": SYMBOLS,
            "year": YEAR,
            "cost_bps": COST_BPS,
            "selection_pct": SELECT_PCT,
            "wfo_lite": {
                "train_days": TRAIN_DAYS,
                "test_days": TEST_DAYS,
                "step_hours": STEP_HOURS,
            },
        },
        "strategies": results,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    print(f"\nReport saved to {OUTPUT_PATH}")

    # ---- Quick summary table --------------------------------------------
    print(f"\n{'Strategy':<20} {'Folds':>6} {'Trades':>8} {'WinRate':>8} "
          f"{'FoldPass%':>10} {'MeanRet':>8} {'Sharpe':>8}")
    print("-" * 70)
    for name, res in results.items():
        s = res["summary"]
        shr = s.get("overall_sharpe", 0)
        print(f"{name:<20} {s['fold_count']:>6} {s['total_trades']:>8} "
              f"{s['mean_win_rate']:>7.1%} {s['fold_pass_rate']:>9.1%} "
              f"{s['mean_fold_return']:>8.4f} {shr:>8.2f}")


if __name__ == "__main__":
    main()
