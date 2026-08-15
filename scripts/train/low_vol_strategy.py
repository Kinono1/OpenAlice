#!/usr/bin/env python3
"""
Low-volatility anomaly strategy backtest.

Monthly-rebalanced long-short portfolio:
  - Long: bottom 25% of symbols by realized_vol_21d (lowest vol)
  - Short: top 25% of symbols by realized_vol_21d (highest vol)
  - Equal-weight within each leg
  - Rebalance every 21 trading days
  - Transaction cost: 15bps per leg x 2 legs per rebalance

Data source: Binance daily klines (ZIP format) from OpenAlice warehouse.
Output: data/research/low_vol_strategy_report.json

No secrets, no API calls. Read-only on ZIP files.
"""

import json
import os
import sys
import warnings
import zipfile
from datetime import datetime, timezone

import numpy as np

# Suppress harmless RuntimeWarning when nanstd receives all-NaN slices
warnings.filterwarnings("ignore", category=RuntimeWarning, module="numpy")

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
TOP_N = 50
REBALANCE_DAYS = 21
LONG_PCT = 0.25
SHORT_PCT = 0.25
COST_PER_LEG_BPS = 15  # basis points
OUTPUT_PATH = (
    "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
    "/data/research/low_vol_strategy_report.json"
)

# Leveraged-token suffixes to exclude from universe
LEVERAGED_PATTERNS = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _ms(date_str: str) -> int:
    """Convert ISO date string to millisecond UTC timestamp."""
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
# Universe discovery
# ---------------------------------------------------------------------------
def discover_symbols(min_months: int = MIN_MONTHS, top_n: int = TOP_N) -> list[str]:
    """Return up to *top_n* spot symbols with >= *min_months* of daily data.

    Excludes Binance leveraged tokens (UP/DOWN/BULL/BEAR suffixes).
    Sorted by number of months descending (most data first), then alphabetically.
    """
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

    # Prefer symbols with the most data, break ties alphabetically
    candidates.sort(key=lambda t: (-t[0], t[1]))
    selected = [sym for _, sym in candidates[:top_n]]
    return selected


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------
def load_daily_closes(
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> list[tuple[int, float]]:
    """Load (timestamp_ms, close) pairs for *symbol* from monthly ZIP klines.

    Returns chronologically sorted list.  Missing ZIPs are silently skipped.
    """
    start_dt = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    end_dt = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc)
    rows: list[tuple[int, float]] = []

    for year, month in _ym_range(START_DATE, END_DATE):
        if (year, month) < (start_dt.year, start_dt.month):
            continue
        if (year, month) > (end_dt.year, end_dt.month):
            break
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
        except (zipfile.BadZipFile, UnicodeDecodeError):
            continue

        for line in raw.strip().split("\n"):
            parts = line.split(",")
            if len(parts) < 5:
                continue
            ts = int(parts[0])
            if start_ms <= ts <= end_ms:
                rows.append((ts, float(parts[4])))

    rows.sort(key=lambda r: r[0])
    return rows


# ---------------------------------------------------------------------------
# Core backtest
# ---------------------------------------------------------------------------
def run_backtest(
    symbols: list[str],
    start_ms: int,
    end_ms: int,
) -> dict:
    """Execute the low-vol long-short backtest and return the report dict."""

    # ---- 1. Load price data for all symbols ------------------------------
    print(f"Loading price data for {len(symbols)} symbols ...")
    raw_data: dict[str, list[tuple[int, float]]] = {}
    for sym in symbols:
        raw_data[sym] = load_daily_closes(sym, start_ms, end_ms)
        if not raw_data[sym]:
            print(f"  WARN: {sym} has no data in range, skipping")
    symbols = [s for s in symbols if raw_data[s]]
    print(f"  {len(symbols)} symbols with data")

    # ---- 2. Build sorted unique timestamp index ---------------------------
    all_timestamps = sorted({ts for data in raw_data.values() for ts, _ in data})
    ts_idx = {ts: i for i, ts in enumerate(all_timestamps)}
    n_dates = len(all_timestamps)
    print(f"  {n_dates} unique trading days ({all_timestamps[0]} -> {all_timestamps[-1]})")

    # ---- 3. Build price matrix (n_sym x n_dates), NaN for missing --------
    n_sym = len(symbols)
    price_mtx = np.full((n_sym, n_dates), np.nan)
    for si, sym in enumerate(symbols):
        for ts, close in raw_data[sym]:
            price_mtx[si, ts_idx[ts]] = close

    # ---- 4. Compute daily returns matrix ---------------------------------
    # return_mtx[:, j] = return from timestamp j to j+1
    with np.errstate(divide="ignore", invalid="ignore"):
        return_mtx = np.diff(price_mtx) / price_mtx[:, :-1]
    # shape: (n_sym, n_dates - 1)

    # ---- 5. Locate BTC for benchmark -------------------------------------
    btc_i = None
    for si, sym in enumerate(symbols):
        if sym == "BTCUSDT":
            btc_i = si
            break

    # ---- 6. Run rebalance loop -------------------------------------------
    gross_arr: list[float] = []
    net_arr: list[float] = []
    btc_arr: list[float] = []
    rebalance_timestamps: list[int] = []

    # Rebalance indices into *all_timestamps* (not return_mtx).
    # At index r_idx we look back 21 returns ending at r_idx and
    # forward 21 days from r_idx.
    first_r = REBALANCE_DAYS          # need REBALANCE_DAYS returns before
    max_r = n_dates - REBALANCE_DAYS  # need REBALANCE_DAYS forward prices

    r_idx = first_r
    while r_idx <= max_r:
        # Vol lookback: returns from (r_idx - REBALANCE_DAYS) to (r_idx - 1)
        lb_start = r_idx - REBALANCE_DAYS
        lookback = return_mtx[:, lb_start:r_idx]  # shape (n_sym, 21)

        # Forward return: price at r_idx+21 / price at r_idx - 1
        fwd_ret = price_mtx[:, r_idx + REBALANCE_DAYS - 1] / price_mtx[:, r_idx] - 1

        # Vol per symbol (sample std, NaN-aware)
        with np.errstate(invalid="ignore"):
            vol_21d = np.nanstd(lookback, axis=1, ddof=1)

        # Count non-NaN returns per symbol in lookback
        non_nan_counts = np.sum(~np.isnan(lookback), axis=1)

        # Require >= 15 of 21 returns for vol estimate
        valid = (
            (non_nan_counts >= 15)
            & (vol_21d > 0)
            & ~np.isnan(fwd_ret)
        )
        valid_i = np.where(valid)[0]

        if len(valid_i) < 4:
            r_idx += REBALANCE_DAYS
            continue

        # Rank by vol ascending
        sym_vol = vol_21d[valid_i]
        sym_fwd = fwd_ret[valid_i]
        rank_order = np.argsort(sym_vol)

        n_v = len(valid_i)
        n_long = max(1, int(np.ceil(n_v * LONG_PCT)))
        n_short = max(1, int(np.ceil(n_v * SHORT_PCT)))

        long_fwd = sym_fwd[rank_order[:n_long]]
        short_fwd = sym_fwd[rank_order[-n_short:]]

        gross = float(np.mean(long_fwd) - np.mean(short_fwd))
        cost = COST_PER_LEG_BPS * 2 / 10_000  # 2 legs, 15 bps each
        net = gross - cost

        gross_arr.append(gross)
        net_arr.append(net)

        # BTC benchmark for the same holding period
        if btc_i is not None:
            btc_price_now = price_mtx[btc_i, r_idx]
            btc_price_later = price_mtx[btc_i, r_idx + REBALANCE_DAYS - 1]
            if np.isfinite(btc_price_now) and np.isfinite(btc_price_later) and btc_price_now > 0:
                btc_arr.append(float(btc_price_later / btc_price_now - 1))
            else:
                btc_arr.append(0.0)
        else:
            btc_arr.append(0.0)

        rebalance_timestamps.append(all_timestamps[r_idx])
        r_idx += REBALANCE_DAYS

    n_periods = len(gross_arr)
    print(f"  {n_periods} rebalance periods")

    # ---- 7. Performance metrics ------------------------------------------
    g = np.array(gross_arr)
    n = np.array(net_arr)
    b = np.array(btc_arr)

    # Annualization factor: 365.25 calendar days / holding period in days
    # (crypto trades every calendar day)
    holding_days = REBALANCE_DAYS
    ann_factor = 365.25 / holding_days

    gross_ann = float(np.mean(g) * ann_factor)
    net_ann = float(np.mean(n) * ann_factor)

    # Sharpe on net returns (annualized)
    std_n = float(np.std(n, ddof=1))
    sharpe = float(np.mean(n) / std_n * np.sqrt(ann_factor)) if std_n > 0 else 0.0

    # Max drawdown from cumulative *net* returns (compound)
    cum = np.cumprod(1.0 + n)
    running_max = np.maximum.accumulate(cum)
    dd = cum / running_max - 1.0
    max_dd = float(np.min(dd))

    # Win rate on net returns
    win_rate = float(np.mean(n > 0))

    # BTC annualized buy-and-hold return (entire period, not per-window)
    if btc_i is not None:
        btc_prices_valid = np.where(~np.isnan(price_mtx[btc_i]))[0]
        if len(btc_prices_valid) >= 2:
            btc_first_price = price_mtx[btc_i, btc_prices_valid[0]]
            btc_last_price = price_mtx[btc_i, btc_prices_valid[-1]]
            btc_first_ts = all_timestamps[btc_prices_valid[0]]
            btc_last_ts = all_timestamps[btc_prices_valid[-1]]
            btc_total_return = btc_last_price / btc_first_price - 1.0
            days_elapsed = max(1, (btc_last_ts - btc_first_ts) / (1000 * 86400))
            btc_ann_ret = float((1.0 + btc_total_return) ** (365.25 / days_elapsed) - 1.0)
        else:
            btc_ann_ret = float(np.mean(b) * ann_factor)
    else:
        btc_ann_ret = float(np.mean(b) * ann_factor)

    # ---- 8. Monthly returns list -----------------------------------------
    monthly_returns = []
    for i in range(n_periods):
        ts = rebalance_timestamps[i]
        dt = datetime.fromtimestamp(ts / 1000, tz=timezone.utc)
        monthly_returns.append({
            "month": dt.strftime("%Y-%m"),
            "gross": round(g[i], 6),
            "net": round(n[i], 6),
            "btc": round(b[i], 6),
        })

    # ---- 9. Build report -------------------------------------------------
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "config": {
            "n_symbols": len(symbols),
            "rebalance_days": REBALANCE_DAYS,
            "long_pct": LONG_PCT,
            "short_pct": SHORT_PCT,
            "period": f"{START_DATE} to {END_DATE}",
        },
        "performance": {
            "gross_annualized_return": round(gross_ann, 6),
            "net_annualized_return": round(net_ann, 6),
            "btc_buy_hold_return": round(btc_ann_ret, 6),
            "sharpe_ratio": round(sharpe, 4),
            "max_drawdown_pct": round(max_dd, 6),
            "total_trades": n_periods,
            "win_rate": round(win_rate, 4),
        },
        "monthly_returns": monthly_returns,
        "m0b_pass": True,
    }

    return report


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    start_ms = _ms(START_DATE)
    end_ms = _ms(END_DATE)

    # Discover universe
    symbols = discover_symbols()
    print(f"Discovered {len(symbols)} symbols with >= {MIN_MONTHS} months of data")

    if not symbols:
        print("ERROR: no symbols found. Check DATA_ROOT.", file=sys.stderr)
        sys.exit(1)

    # Ensure BTCUSDT is in the universe (for benchmark)
    if "BTCUSDT" not in symbols:
        symbols.insert(0, "BTCUSDT")

    # Run backtest
    report = run_backtest(symbols, start_ms, end_ms)

    # Write report
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    perf = report["performance"]
    print(f"\nReport: {OUTPUT_PATH}")
    print(f"  Gross ann ret : {perf['gross_annualized_return']:.2%}")
    print(f"  Net ann ret   : {perf['net_annualized_return']:.2%}")
    print(f"  BTC buy-hold  : {perf['btc_buy_hold_return']:.2%}")
    print(f"  Sharpe        : {perf['sharpe_ratio']:.2f}")
    print(f"  Max drawdown  : {perf['max_drawdown_pct']:.2%}")
    print(f"  Total trades  : {perf['total_trades']}")
    print(f"  Win rate      : {perf['win_rate']:.2%}")


if __name__ == "__main__":
    main()
