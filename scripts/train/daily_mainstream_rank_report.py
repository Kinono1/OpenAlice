#!/usr/bin/env python3
"""
Daily Low-Vol Rank Report — Mainstream Coins Only (Adaptive Vol)

Reads Binance daily klines for ~25 mainstream coins,
selects the best vol window via 365-day backtest Sharpe,
selects bottom 15% by adaptive vol, applies volume floor filter,
cap-weights by sqrt(daily_volume).

Observation ONLY — no orders, no signals.

Usage:
    /opt/miniconda3/bin/python3 scripts/train/daily_mainstream_rank_report.py
    cat data/research/daily_low_vol_rank_report.json
"""
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import numpy as np

BASE = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
KLINES_DIR = f"{BASE}/spot-all-usdt-klines-1d/spot"
OUTPUT_PATH = "data/research/daily_low_vol_rank_report.json"

MAIN_SYMBOLS = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "BNBUSDT",
    "XRPUSDT",
    "DOGEUSDT",
    "ADAUSDT",
    "AVAXUSDT",
    "LINKUSDT",
    "DOTUSDT",
    "UNIUSDT",
    "LTCUSDT",
    "BCHUSDT",
    "ATOMUSDT",
    "NEARUSDT",
    "OPUSDT",
    "ARBUSDT",
    "SUIUSDT",
    "TRXUSDT",
    "APTUSDT",
    "INJUSDT",
    "ETCUSDT",
    "AAVEUSDT",
    "MKRUSDT",
]

# Vol windows to evaluate
VOL_WINDOWS = [10, 14, 21, 30, 45, 60, 90]

# How many months of ZIP files to load
N_MONTHS = 18

# Backtest window in days
BACKTEST_DAYS = 365

# Bottom percentile for low-vol selection
LOW_VOL_PCT = 0.15


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------


def load_daily_data(symbol: str):
    """Load daily closes and quote volumes from Binance ZIP files.

    Returns (closes, volumes) where each is a dict of date -> float.
    """
    closes: dict[str, float] = {}
    volumes: dict[str, float] = {}
    kline_path = os.path.join(KLINES_DIR, symbol, "1d")
    if not os.path.isdir(kline_path):
        return closes, volumes

    zip_files = sorted([f for f in os.listdir(kline_path) if f.endswith(".zip")])
    if not zip_files:
        return closes, volumes

    for zf in zip_files[-N_MONTHS:]:
        fpath = os.path.join(kline_path, zf)
        try:
            with zipfile.ZipFile(fpath) as z:
                names = z.namelist()
                if not names:
                    continue
                text = z.read(names[0]).decode("utf-8", errors="replace")
                for line in text.strip().split("\n"):
                    cols = line.split(",")
                    if len(cols) >= 8:
                        try:
                            ts_ms = int(cols[0])
                            # Daily klines use microsecond timestamps (16 digits)
                            ts_sec = ts_ms / 1_000_000
                            close = float(cols[4])
                            volume = float(cols[7])  # Quote asset volume (USDT)
                            date = datetime.fromtimestamp(
                                ts_sec, tz=timezone.utc
                            ).strftime("%Y-%m-%d")
                            closes[date] = close
                            volumes[date] = volume
                        except (ValueError, IndexError):
                            continue
        except Exception:
            continue
    return closes, volumes


# ---------------------------------------------------------------------------
# Aligned array helpers
# ---------------------------------------------------------------------------


def build_arrays(all_closes, all_volumes, all_dates, date_to_idx):
    """Build aligned numpy arrays for returns and volumes.

    Returns (ret_arrays, vol_arrays, last_prices).
    """
    n = len(all_dates)
    ret_arrays = {}
    vol_arrays = {}
    last_prices = {}

    for sym in all_closes:
        closes = all_closes[sym]
        dates = sorted(closes.keys())

        # Return array
        arr = np.full(n, np.nan)
        for i in range(1, len(dates)):
            d_prev, d_curr = dates[i - 1], dates[i]
            if closes[d_prev] > 0:
                idx = date_to_idx.get(d_curr)
                if idx is not None:
                    arr[idx] = (closes[d_curr] - closes[d_prev]) / closes[d_prev]
        ret_arrays[sym] = arr

        # Volume array
        vol_arr = np.full(n, np.nan)
        for d in dates:
            idx = date_to_idx.get(d)
            if idx is not None and d in all_volumes.get(sym, {}):
                vol_arr[idx] = all_volumes[sym][d]
        vol_arrays[sym] = vol_arr

        # Last close price
        last_prices[sym] = closes[dates[-1]]

    return ret_arrays, vol_arrays, last_prices


# ---------------------------------------------------------------------------
# Backtest: find best vol window
# ---------------------------------------------------------------------------


def find_best_window(ret_arrays, all_dates):
    """Find the vol window with the best Sharpe over the last BACKTEST_DAYS days.

    For each window W, constructs a daily bottom-15%-by-vol portfolio
    (equal-weighted) and computes its annualized Sharpe.

    Returns (best_window, best_sharpe, win_rate, backtest_returns_for_best).
    """
    n = len(all_dates)
    window_perf: dict[int, dict] = {}

    for W in VOL_WINDOWS:
        portfolio_rets: list[float] = []
        start = W
        end = min(start + BACKTEST_DAYS, n - 1)

        for i in range(start, end):
            nxt = i + 1
            if nxt >= n:
                break

            # Compute vol for each symbol over the last W daily returns
            vols: dict[str, float] = {}
            for sym, arr in ret_arrays.items():
                chunk = arr[i - W + 1 : i + 1]
                valid = int(np.sum(~np.isnan(chunk)))
                if valid >= max(5, int(W * 0.7)):
                    vols[sym] = float(np.nanstd(chunk, ddof=1))

            if len(vols) < 5:
                continue

            # Bottom LOW_VOL_PCT by vol
            sorted_syms = sorted(vols, key=vols.get)
            n_sel = max(1, int(len(sorted_syms) * LOW_VOL_PCT))
            selected = sorted_syms[:n_sel]

            # Equal-weighted next-day return
            rets_today = [
                float(ret_arrays[sym][nxt])
                for sym in selected
                if not np.isnan(ret_arrays[sym][nxt])
            ]
            if len(rets_today) >= max(1, len(selected) // 2):
                portfolio_rets.append(float(np.mean(rets_today)))

        if len(portfolio_rets) >= 30:
            daily_sharpe = float(np.mean(portfolio_rets) / np.std(portfolio_rets))
            annual_sharpe = daily_sharpe * np.sqrt(365)
            win = float(np.mean([1 if r > 0 else 0 for r in portfolio_rets]))
            window_perf[W] = {
                "sharpe": annual_sharpe,
                "win_rate": win,
                "returns": portfolio_rets,
            }
            print(
                f"  Window={W:2d}: Sharpe={annual_sharpe:.3f}  "
                f"WinRate={win:.2%}  n_days={len(portfolio_rets)}"
            )

    # Fallback to 21 if no window had enough data
    if not window_perf:
        print("  WARNING: Not enough data for backtest, falling back to window=21")
        return 21, 0.0, 0.0, []

    best_w = max(window_perf, key=lambda w: window_perf[w]["sharpe"])
    perf = window_perf[best_w]
    return best_w, perf["sharpe"], perf["win_rate"], perf["returns"]


# ---------------------------------------------------------------------------
# Today's selection
# ---------------------------------------------------------------------------


def select_today(ret_arrays, vol_arrays, last_prices, best_window, all_dates):
    """Select bottom LOW_VOL_PCT by best_window vol, filter by volume, cap-weight.

    Returns (signals_long, signals_short, vols_dict).
    Each signal dict: {symbol, vol, price, weight, volume_usdt}.
    """
    n = len(all_dates)
    last_idx = n - 1

    # Compute vol for each symbol using the best window
    vols: dict[str, float] = {}
    for sym, arr in ret_arrays.items():
        chunk = arr[last_idx - best_window + 1 : last_idx + 1]
        valid = int(np.sum(~np.isnan(chunk)))
        if valid >= max(5, int(best_window * 0.7)):
            vols[sym] = float(np.nanstd(chunk, ddof=1))

    if len(vols) < 3:
        # Fallback: try a shorter window
        fallback = 21
        for sym, arr in ret_arrays.items():
            chunk = arr[last_idx - fallback + 1 : last_idx + 1]
            if np.sum(~np.isnan(chunk)) >= 10:
                vols[sym] = float(np.nanstd(chunk, ddof=1))

    # Sort by vol
    sorted_syms = sorted(vols, key=vols.get)
    n_bottom = max(1, int(len(sorted_syms) * LOW_VOL_PCT))
    n_top = max(1, int(len(sorted_syms) * LOW_VOL_PCT))

    long_candidates = sorted_syms[:n_bottom]
    short_candidates = sorted_syms[-n_top:]

    # Volume floor: median of all current quote volumes
    current_volumes: dict[str, float] = {}
    for sym in vols:
        v = float(vol_arrays[sym][last_idx])
        if not np.isnan(v):
            current_volumes[sym] = v

    median_vol = float(np.median(list(current_volumes.values()))) if current_volumes else 0.0

    # Filter long candidates: only coins above median volume
    long_filtered = [
        sym
        for sym in long_candidates
        if sym in current_volumes and current_volumes[sym] >= median_vol
    ]

    # If all got filtered out, take the top-volume long candidate
    if not long_filtered and long_candidates:
        long_filtered = [
            max(long_candidates, key=lambda s: current_volumes.get(s, 0))
        ]

    # Cap-weight by sqrt(volume)
    weights: dict[str, float] = {}
    if long_filtered:
        sq = {sym: np.sqrt(current_volumes[sym]) for sym in long_filtered if current_volumes[sym] > 0}
        total = sum(sq.values())
        if total > 0:
            weights = {sym: round(float(v / total), 6) for sym, v in sq.items()}
        else:
            n = len(long_filtered)
            weights = {sym: round(1.0 / n, 6) for sym in long_filtered}

    # Build long signals
    signals_long = []
    for sym in long_filtered:
        signals_long.append(
            {
                "symbol": sym,
                "vol": round(vols[sym], 6),
                "price": last_prices.get(sym, 0),
                "weight": weights.get(sym, 0),
                "volume_usdt": round(current_volumes.get(sym, 0), 2),
            }
        )
    signals_long.sort(key=lambda x: x["weight"], reverse=True)

    # Build short signals (no volume filter for avoid)
    signals_short = []
    for sym in short_candidates:
        signals_short.append(
            {
                "symbol": sym,
                "vol": round(vols[sym], 6),
                "price": last_prices.get(sym, 0),
                "volume_usdt": round(current_volumes.get(sym, 0), 2),
            }
        )

    return signals_long, signals_short, vols


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    print("Loading mainstream coin data (adaptive vol)...")
    all_closes: dict[str, dict] = {}
    all_volumes: dict[str, dict] = {}

    for sym in MAIN_SYMBOLS:
        closes, volumes = load_daily_data(sym)
        if closes:
            all_closes[sym] = closes
            all_volumes[sym] = volumes
            print(f"  {sym}: {len(closes)} days")
        else:
            print(f"  {sym}: NO DATA")

    print(f"\nSymbols with data: {len(all_closes)}/{len(MAIN_SYMBOLS)}")

    if not all_closes:
        print("ERROR: No data loaded", file=sys.stderr)
        report = {
            "status": "data_missing",
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2)
        sys.exit(1)

    # Build common date index
    all_dates_set: set[str] = set()
    for closes in all_closes.values():
        all_dates_set.update(closes.keys())
    all_dates = sorted(all_dates_set)
    date_to_idx = {d: i for i, d in enumerate(all_dates)}
    print(f"Total unique dates: {len(all_dates)}")

    # Build aligned arrays
    ret_arrays, vol_arrays, last_prices = build_arrays(
        all_closes, all_volumes, all_dates, date_to_idx
    )

    # Find best vol window from 365-day backtest
    print("\nBacktesting vol windows...")
    best_window, best_sharpe, win_rate, _ = find_best_window(ret_arrays, all_dates)
    print(
        f"  -> Selected window: {best_window}  "
        f"(Sharpe={best_sharpe:.3f}, WinRate={win_rate:.2%})"
    )

    # Today's selection
    print("\nSelecting today's low-vol candidates...")
    signals_long, signals_short, current_vols = select_today(
        ret_arrays, vol_arrays, last_prices, best_window, all_dates
    )
    print(f"  Long signals: {len(signals_long)}")
    for s in signals_long:
        print(
            f"    {s['symbol']:>9s}: vol={s['vol']:.6f}  "
            f"weight={s['weight']:.4f}  vol_usdt={s['volume_usdt']:.0f}"
        )
    print(f"  Short signals: {len(signals_short)}")
    for s in signals_short:
        print(f"    {s['symbol']:>9s}: vol={s['vol']:.6f}")

    # Legacy buy_candidates / avoid (same data, vol field for backward compat)
    buy_candidates = [
        {"symbol": s["symbol"], "vol_21d": s["vol"], "price": s["price"]}
        for s in signals_long
    ]
    avoid = [
        {"symbol": s["symbol"], "vol_21d": s["vol"], "price": s["price"]}
        for s in signals_short
    ]

    # BTC 21d vol (reference benchmark, separate from adaptive)
    btc_vol_21d = None
    if "BTCUSDT" in ret_arrays:
        btc_rets = [float(v) for v in ret_arrays["BTCUSDT"][-21:] if not np.isnan(v)]
        if len(btc_rets) >= 5:
            btc_vol_21d = round(float(np.std(btc_rets, ddof=1)), 6)

    btc_percentile = 0.5
    if "BTCUSDT" in current_vols and current_vols:
        sorted_vals = sorted(current_vols.values())
        btc_val = current_vols["BTCUSDT"]
        btc_percentile = (
            sum(1 for v in sorted_vals if v <= btc_val) / len(sorted_vals)
            if sorted_vals
            else 0.5
        )

    last_date = all_dates[-1]

    report = {
        "status": "completed",
        "generated_at": datetime.now(timezone.utc)
        .isoformat()
        .replace("+00:00", "Z"),
        "date": last_date,
        "n_mainstream_symbols": len(MAIN_SYMBOLS),
        "n_symbols_with_data": len(all_closes),
        "btc_vol_21d": btc_vol_21d,
        "btc_vol_percentile": round(btc_percentile, 4),
        "buy_candidates": buy_candidates,
        "avoid": avoid,
        "adaptive_params": {
            "vol_window_selected": best_window,
            "win_rate_365d": round(float(win_rate), 4),
        },
        "signals": {
            "long": signals_long,
            "short": signals_short,
        },
        "note": (
            f"adaptive_vol_15pct: window={best_window}, "
            f"sharpe_365d={best_sharpe:.3f}, win_rate_365d={win_rate:.2%}"
        ),
    }

    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    # Print human-readable summary
    print(f"\nDaily Low-Vol Rank Report — Adaptive Vol — {last_date}")
    print("=" * 60)
    print(f"Symbols analyzed: {len(all_closes)}/{len(MAIN_SYMBOLS)}")
    print(f"BTC vol 21d: {btc_vol_21d}  (percentile: {btc_percentile:.0%})")
    print(
        f"Adaptive vol window: {best_window}  "
        f"(Sharpe: {best_sharpe:.3f}, Win Rate: {win_rate:.2%})"
    )
    buy_list = ", ".join(s["symbol"] for s in signals_long)
    avoid_list = ", ".join(s["symbol"] for s in signals_short)
    print(f"\nLong signals (lowest vol):\n  {buy_list}")
    print(f"\nShort signals (highest vol):\n  {avoid_list}")
    print(f"\nOutput: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
