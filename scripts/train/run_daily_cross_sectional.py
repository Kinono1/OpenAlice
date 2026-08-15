#!/usr/bin/env python3
"""
Daily Cross-Sectional Factor Testing.

Tests whether cross-sectional momentum/volatility/volume/range factors
have predictive power at daily frequency across Binance USDT spot symbols.

What it does:
  1. Auto-discovers symbols with >= 36 months of daily data
  2. Selects top N symbols by data coverage
  3. Loads daily OHLCV for all symbols from start-year-01 to end-year-06
  4. Computes per-symbol daily features:
     - ret_1d, ret_5d, ret_21d (past returns)
     - realized_vol_21d (21-day rolling std of daily returns)
     - volume_z_21d (21-day z-score of volume)
     - range_pct = (high - low) / close
  5. Loads daily forward returns (next 5 days, next 21 days)
  6. For each factor, computes Spearman Rank IC across symbols (cross-sectional)
  7. For the best composite combination, runs WFO-Lite
  8. Writes report to data/research/daily_cross_sectional_report.json

Usage:
    /opt/miniconda3/bin/python3 scripts/train/run_daily_cross_sectional.py \
        --max-symbols 50 --start-year 2020 --end-year 2024
"""

import argparse
import importlib.util
import json
import os
import sys
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

# ---------------------------------------------------------------------------
# Repo root discovery (handles worktree nesting)
# ---------------------------------------------------------------------------
_script_dir = os.path.dirname(os.path.abspath(__file__))
_repo_root = os.path.dirname(os.path.dirname(_script_dir))
sys.path.insert(0, _repo_root)


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# Load existing IC/wfo modules for reuse
_ic_path = os.path.join(_repo_root, "scripts", "train", "ic_computation.py")
_wfo_path = os.path.join(_repo_root, "scripts", "train", "wfo_validator.py")

ic_mod = _load_module("ic_computation", _ic_path)
wfo_mod = _load_module("wfo_validator", _wfo_path)

compute_icir = ic_mod.compute_icir
compute_ic_drawdown = ic_mod.compute_ic_drawdown
effective_n_correction = ic_mod.effective_n_correction

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
DAILY_BASE = (
    "/Volumes/shield/cryptoData/openalice-data/market/"
    "binance-public/spot-all-usdt-klines-1d/spot"
)
OUTPUT_PATH = os.path.join(
    _repo_root, "data", "research", "daily_cross_sectional_report.json"
)

# Binance kline CSV columns (no header in ZIP contents)
COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_vol", "trades", "taker_buy_base",
    "taker_buy_quote", "ignore",
]

# ---------------------------------------------------------------------------
# Step 1: Symbol discovery
# ---------------------------------------------------------------------------


def discover_symbols(min_months: int = 36) -> list[tuple[str, int]]:
    """Discover symbols with at least *min_months* of monthly ZIP files.

    Returns list of (symbol, n_months) sorted by coverage descending.
    """
    results: list[tuple[str, int]] = []
    sym_dir = os.path.join(DAILY_BASE)
    if not os.path.isdir(sym_dir):
        print(f"  WARNING: Data directory not found: {sym_dir}", file=sys.stderr)
        return results

    for entry in sorted(os.listdir(sym_dir)):
        sym_path = os.path.join(sym_dir, entry, "1d")
        if not os.path.isdir(sym_path):
            continue
        symbol = entry

        n_zip = 0
        try:
            for f in os.listdir(sym_path):
                if f.endswith(".zip") and symbol in f:
                    n_zip += 1
        except PermissionError:
            continue

        if n_zip >= min_months:
            results.append((symbol, n_zip))

    results.sort(key=lambda x: x[1], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Step 2: Data loading
# ---------------------------------------------------------------------------


def generate_months(start_ym: str, end_ym: str) -> list[str]:
    """Generate YYYY-MM strings from start_ym to end_ym inclusive."""
    months = []
    sy, sm = int(start_ym[:4]), int(start_ym[5:7])
    ey, em = int(end_ym[:4]), int(end_ym[5:7])
    y, m = sy, sm
    while (y < ey) or (y == ey and m <= em):
        months.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return months


def load_symbol_data(symbol: str, start_ym: str, end_ym: str) -> pd.DataFrame | None:
    """Load daily OHLCV for one symbol from monthly ZIP files.

    Returns DataFrame with COLUMNS columns, or None if no data found.
    """
    data_dir = os.path.join(DAILY_BASE, symbol, "1d")
    if not os.path.isdir(data_dir):
        return None

    dfs: list[pd.DataFrame] = []
    for ym in generate_months(start_ym, end_ym):
        zip_name = f"{symbol}-1d-{ym}.zip"
        zip_path = os.path.join(data_dir, zip_name)
        if not os.path.isfile(zip_path):
            continue
        try:
            with zipfile.ZipFile(zip_path, "r") as z:
                csv_name = z.namelist()[0]
                with z.open(csv_name) as f:
                    df_chunk = pd.read_csv(f, header=None)
                    dfs.append(df_chunk)
        except Exception as e:
            print(f"  Warning: {zip_path}: {e}", file=sys.stderr)

    if not dfs:
        return None

    df = pd.concat(dfs, ignore_index=True)
    df.columns = COLUMNS
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    df = df.sort_values("open_time").reset_index(drop=True)

    # Drop rows where close is NaN or zero
    df = df[df["close"].notna() & (df["close"] > 0)].copy()
    return df


# ---------------------------------------------------------------------------
# Step 3: Feature engineering
# ---------------------------------------------------------------------------


def compute_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add daily features. Returns same DataFrame with new columns."""
    close = df["close"]
    high = df["high"]
    low = df["low"]
    volume = df["volume"]
    ret_1d = close.pct_change(1)

    # Past returns
    df["ret_1d"] = ret_1d
    df["ret_5d"] = close.pct_change(5)
    df["ret_21d"] = close.pct_change(21)

    # Forward returns
    df["fwd_5d"] = close.pct_change(5).shift(-5)
    df["fwd_21d"] = close.pct_change(21).shift(-21)

    # Realized volatility (21-day rolling std of daily returns)
    df["realized_vol_21d"] = ret_1d.rolling(21).std()

    # Volume z-score (21-day rolling)
    vol_mean = volume.rolling(21).mean()
    vol_std = volume.rolling(21).std().replace(0, np.nan)
    df["volume_z_21d"] = (volume - vol_mean) / vol_std

    # Daily range percentage
    df["range_pct"] = (high - low) / close

    return df


# ---------------------------------------------------------------------------
# Step 4: Build cross-sectional matrices
# ---------------------------------------------------------------------------


def build_factor_matrix(
    symbol_dfs: dict[str, pd.DataFrame],
    factor_col: str,
) -> pd.DataFrame:
    """Build a wide matrix: index=date, columns=symbols, values=factor."""
    series_list: list[pd.Series] = []
    for symbol, df in symbol_dfs.items():
        if factor_col not in df.columns:
            continue
        s = df.set_index("open_time")[factor_col]
        s.name = symbol
        series_list.append(s)

    if not series_list:
        return pd.DataFrame()

    result = pd.concat(series_list, axis=1)
    result = result.sort_index()
    result = result[sorted(result.columns)]
    return result


# ---------------------------------------------------------------------------
# Step 5: Factor IC computation
# ---------------------------------------------------------------------------


def compute_factor_ic(
    factor_matrix: pd.DataFrame,
    return_matrix: pd.DataFrame,
) -> dict:
    """Cross-sectional Spearman Rank IC for one factor vs one forward horizon.

    Returns dict with mean_ic, icir, drawdown, n, effective_n.
    """
    ic_series = ic_mod.compute_ic_series(factor_matrix, return_matrix)
    n = int(ic_series.notna().sum())

    if n < 3:
        return {
            "mean_ic": 0.0,
            "icir": 0.0,
            "drawdown": 0.0,
            "n": 0,
        }

    mean_ic = float(ic_series.mean())
    icir_val = compute_icir(ic_series)
    dd = compute_ic_drawdown(ic_series)
    eff_n = effective_n_correction(ic_series, method="newey_west", max_lags=21)

    return {
        "mean_ic": round(mean_ic, 6),
        "icir": round(icir_val, 6),
        "drawdown": round(dd, 6),
        "n": n,
        "effective_n": round(eff_n, 1),
    }


# ---------------------------------------------------------------------------
# Step 6: WFO-Lite (cross-sectional adaptation)
# ---------------------------------------------------------------------------


def run_wfo_cross_sectional(
    factor_matrix: pd.DataFrame,
    return_matrix: pd.DataFrame,
    train_window: int = 504,   # ~2 years of daily data
    test_window: int = 63,     # ~3 months
    step: int = 21,            # ~1 month step
    embargo: int = 21,         # 1 month embargo
) -> dict:
    """Walk-forward validation for cross-sectional factors.

    At each fold: trains a Ridge on historical (date, symbol) pairs,
    tests on future OOS dates, computes per-date cross-sectional IC.
    """
    from sklearn.linear_model import Ridge
    from sklearn.preprocessing import StandardScaler

    common_dates = factor_matrix.index.intersection(return_matrix.index)
    dates = sorted(common_dates)
    n = len(dates)

    folds: list[dict] = []
    train_start = 0
    fold_id = 0

    while train_start + train_window + embargo + test_window <= n:
        train_end = train_start + train_window
        test_start = train_end + embargo
        test_end = test_start + test_window

        if test_end > n:
            break

        train_dates = dates[train_start:train_end]
        test_dates = dates[test_start:test_end]

        # --- Flatten train data: (date, symbol) pairs ---
        train_rows: list[dict] = []
        for dt in train_dates:
            fvals = factor_matrix.loc[dt].dropna()
            rvals = return_matrix.loc[dt]
            common = fvals.index.intersection(rvals.dropna().index)
            for sym in common:
                train_rows.append({
                    "factor": float(fvals[sym]),
                    "forward_ret": float(rvals[sym]),
                })

        if len(train_rows) < 30:
            train_start += step
            continue

        train_df = pd.DataFrame(train_rows)

        # --- Flatten test data ---
        test_rows: list[dict] = []
        test_date_labels: list = []
        for dt in test_dates:
            fvals = factor_matrix.loc[dt].dropna()
            rvals = return_matrix.loc[dt]
            common = fvals.index.intersection(rvals.dropna().index)
            for sym in common:
                test_rows.append({
                    "factor": float(fvals[sym]),
                    "forward_ret": float(rvals[sym]),
                    # Keep date for per-day IC computation
                    "_date": dt,
                })
            test_date_labels.append(dt)

        if len(test_rows) < 10:
            train_start += step
            continue

        test_df = pd.DataFrame(test_rows)

        try:
            scaler = StandardScaler()
            X_train = scaler.fit_transform(train_df[["factor"]].values)
            y_train = train_df["forward_ret"].values

            model = Ridge(alpha=1.0, random_state=42)
            model.fit(X_train, y_train)

            X_test = scaler.transform(test_df[["factor"]].values)
            y_pred = model.predict(X_test)
            y_actual = test_df["forward_ret"].values

            # --- Per-date cross-sectional IC ---
            test_copy = test_df.copy()
            test_copy["pred"] = y_pred
            test_copy["actual"] = y_actual

            daily_ics: list[float] = []
            for dt in test_dates:
                sub = test_copy[test_copy["_date"] == dt]
                if len(sub) >= 5:
                    rho, _ = spearmanr(sub["pred"].values, sub["actual"].values)
                    if not np.isnan(rho):
                        daily_ics.append(float(rho))

            mean_ic = float(np.mean(daily_ics)) if daily_ics else 0.0

            folds.append({
                "fold_id": fold_id,
                "n_train": len(train_df),
                "n_test": len(test_df),
                "n_daily_ics": len(daily_ics),
                "mean_ic": round(mean_ic, 6),
                "train_range": [str(dates[train_start]), str(dates[min(train_end - 1, n - 1)])],
                "test_range": [str(dates[test_start]), str(dates[min(test_end - 1, n - 1)])],
            })
        except Exception as e:
            folds.append({
                "fold_id": fold_id,
                "error": str(e),
            })

        fold_id += 1
        train_start += step

    if not folds:
        return {"status": "no_folds_generated", "fold_count": 0}

    valid_ics = [f.get("mean_ic", 0) for f in folds if "mean_ic" in f]

    return {
        "status": "completed",
        "fold_count": len(folds),
        "fold_results": folds,
        "summary": {
            "mean_ic": round(float(np.mean(valid_ics)), 6) if valid_ics else 0,
            "std_ic": round(float(np.std(valid_ics, ddof=1)), 6) if len(valid_ics) > 1 else 0,
            "n_folds": len(valid_ics),
            "train_window_days": train_window,
            "test_window_days": test_window,
            "step_days": step,
            "embargo_days": embargo,
        },
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Daily cross-sectional factor testing"
    )
    parser.add_argument(
        "--max-symbols", type=int, default=50,
        help="Maximum number of symbols to include (default: 50)"
    )
    parser.add_argument(
        "--start-year", type=int, default=2020,
        help="Start year for data loading (default: 2020)"
    )
    parser.add_argument(
        "--end-year", type=int, default=2024,
        help="End year for data loading (default: 2024)"
    )
    parser.add_argument(
        "--min-months", type=int, default=36,
        help="Minimum months of daily data for symbol selection (default: 36)"
    )
    args = parser.parse_args()

    print("=" * 60)
    print("Daily Cross-Sectional Factor Testing")
    print("=" * 60)
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # -----------------------------------------------------------------------
    # [1/6] Discover symbols
    # -----------------------------------------------------------------------
    print(f"\n[1/6] Discovering symbols with >= {args.min_months} months of data...")
    candidates = discover_symbols(min_months=args.min_months)
    print(f"  Found {len(candidates)} candidates")

    if not candidates:
        report = {"generated_at": generated_at, "status": "no_symbols_found"}
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2, default=str)
        print("  No symbols found. Report saved.")
        return

    selected = candidates[: args.max_symbols]
    print(f"  Selected top {len(selected)} symbols by coverage:")
    for sym, n_months in selected[:5]:
        print(f"    {sym}: {n_months} months")
    print(f"    ... and {len(selected) - 5} more")

    # -----------------------------------------------------------------------
    # [2/6] Load data
    # -----------------------------------------------------------------------
    print(f"\n[2/6] Loading daily data ({args.start_year}-01 to {args.end_year}-06)...")
    start_ym = f"{args.start_year}-01"
    end_ym = f"{args.end_year}-06"

    symbol_dfs: dict[str, pd.DataFrame] = {}
    loaded_count = 0
    for symbol, _ in selected:
        df = load_symbol_data(symbol, start_ym, end_ym)
        if df is not None and len(df) > 100:
            symbol_dfs[symbol] = df
            loaded_count += 1
        else:
            print(f"  Warning: {symbol} has insufficient data for range")

    print(f"  Successfully loaded {loaded_count} symbols")

    if loaded_count < 10:
        print("  ERROR: Too few symbols with data. Aborting.")
        report = {
            "generated_at": generated_at,
            "status": "insufficient_symbols",
            "n_symbols": loaded_count,
        }
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2, default=str)
        return

    # -----------------------------------------------------------------------
    # [3/6] Compute features
    # -----------------------------------------------------------------------
    print(f"\n[3/6] Computing daily features...")
    for symbol in list(symbol_dfs.keys()):
        symbol_dfs[symbol] = compute_features(symbol_dfs[symbol])
    print(f"  Features computed for {len(symbol_dfs)} symbols")

    # -----------------------------------------------------------------------
    # [4/6] Build cross-sectional matrices
    # -----------------------------------------------------------------------
    print(f"\n[4/6] Building cross-sectional matrices...")

    # Factor names used in the report
    factor_names = [
        "ret_1d",
        "ret_5d",
        "ret_21d",
        "realized_vol_21d",
        "volume_z_21d",
        "range_pct",
    ]

    factor_matrices: dict[str, pd.DataFrame] = {}
    for fn in factor_names:
        mat = build_factor_matrix(symbol_dfs, fn)
        factor_matrices[fn] = mat
        print(f"  Factor {fn:20s} -> {mat.shape}")

    # Forward return horizons
    fwd_horizons = {"5d": "fwd_5d", "21d": "fwd_21d"}
    return_matrices: dict[str, pd.DataFrame] = {}
    for label, col in fwd_horizons.items():
        mat = build_factor_matrix(symbol_dfs, col)
        return_matrices[label] = mat
        print(f"  Forward {label:4s} -> {mat.shape}")

    # Determine overall date range
    all_dates = set()
    for mat in factor_matrices.values():
        all_dates.update(mat.index)
    for mat in return_matrices.values():
        all_dates.update(mat.index)
    all_dates_sorted = sorted(all_dates)
    n_days = len(all_dates_sorted)
    data_start = str(all_dates_sorted[0].date()) if all_dates_sorted else None
    data_end = str(all_dates_sorted[-1].date()) if all_dates_sorted else None
    print(f"\n  Total unique dates: {n_days}")
    print(f"  Date range: {data_start} -> {data_end}")

    # -----------------------------------------------------------------------
    # [5/6] Compute factor ICs
    # -----------------------------------------------------------------------
    print(f"\n[5/6] Computing Spearman Rank IC (cross-sectional)...")

    # Map each factor to its natural forward horizon for primary results
    factor_to_fwd = {
        "ret_1d": "5d",
        "ret_5d": "5d",
        "ret_21d": "21d",
        "realized_vol_21d": "21d",
        "volume_z_21d": "21d",
        "range_pct": "5d",
    }

    factor_results: dict[str, dict] = {}

    for fn in factor_names:
        fwd_label = factor_to_fwd.get(fn, "21d")
        fm = factor_matrices[fn]
        rm = return_matrices[fwd_label]

        result = compute_factor_ic(fm, rm)
        factor_results[fn] = result
        print(f"  {fn:20s} -> fwd_{fwd_label}: "
              f"mean_ic={result['mean_ic']:.6f}  "
              f"icir={result['icir']:.6f}  "
              f"n={result['n']}")

    # Find best single factor (highest |mean_ic|)
    best_factor_key = max(
        factor_results, key=lambda k: abs(factor_results[k]["mean_ic"])
    )
    best_ic = factor_results[best_factor_key]["mean_ic"]
    best_icir = factor_results[best_factor_key]["icir"]
    print(f"\n  Best single factor: {best_factor_key}")
    print(f"    mean_ic = {best_ic:.6f}")
    print(f"    icir    = {best_icir:.6f}")

    # M0B pass: |mean_IC| > 0.02 AND |ICIR| > 0.2
    m0b_pass = abs(best_ic) > 0.02 and abs(best_icir) > 0.2
    print(f"  M0B gate: {'PASS' if m0b_pass else 'FAIL'} "
          f"(|mean_ic|={abs(best_ic):.4f} > 0.02, "
          f"|icir|={abs(best_icir):.4f} > 0.2)")

    # Build composite factor: equal-weighted z-score of z-scored factors
    print(f"\n  Building composite factor (equal-weighted z-scores)...")
    z_scored: dict[str, pd.DataFrame] = {}
    for fn in factor_names:
        fm = factor_matrices[fn]
        if fm.shape[1] < 5:
            print(f"    Skipping {fn}: only {fm.shape[1]} symbols")
            continue
        # Cross-sectional z-score at each date
        mean_series = fm.mean(axis=1)
        std_series = fm.std(axis=1).replace(0, np.nan)
        z = fm.subtract(mean_series, axis=0).div(std_series, axis=0)
        z_scored[fn] = z

    composite_result: dict | None = None
    composite_fwd_label: str | None = None

    if z_scored:
        composite = sum(z_scored.values()) / len(z_scored)

        for fwd_label in ["5d", "21d"]:
            rm = return_matrices[fwd_label]
            common = composite.index.intersection(rm.index)
            if len(common) < 30:
                continue
            c_aligned = composite.loc[common]
            r_aligned = rm.loc[common]
            result = compute_factor_ic(c_aligned, r_aligned)
            key = f"composite_fwd_{fwd_label}"
            factor_results[key] = result
            print(f"  composite fwd_{fwd_label:4s}: "
                  f"mean_ic={result['mean_ic']:.6f}  "
                  f"icir={result['icir']:.6f}  "
                  f"n={result['n']}")

            if composite_result is None or abs(result["mean_ic"]) > abs(composite_result["mean_ic"]):
                composite_result = result
                composite_fwd_label = fwd_label
    else:
        print("  WARNING: Could not build composite (no z-scored factors available).")

    best_all = best_factor_key
    if composite_result is not None and abs(composite_result["mean_ic"]) > abs(best_ic):
        best_all = "composite"
        print(f"\n  Composite outperforms best single factor.")

    # -----------------------------------------------------------------------
    # [6/6] WFO-Lite
    # -----------------------------------------------------------------------
    print(f"\n[6/6] Running WFO-Lite for best factor...")

    wfo_summary: dict | None = None
    wfo_on = None

    if composite_result is not None and composite_result["n"] > 100:
        # Use composite for WFO
        fwd_label = composite_fwd_label or "21d"
        rm = return_matrices[fwd_label]
        common = composite.index.intersection(rm.index)
        c_aligned = composite.loc[common]
        r_aligned = rm.loc[common]
        wfo_on = f"composite_fwd_{fwd_label}"
    elif best_factor_key in factor_results and factor_results[best_factor_key]["n"] > 100:
        fwd_label = factor_to_fwd.get(best_factor_key, "21d")
        fm = factor_matrices[best_factor_key]
        rm = return_matrices[fwd_label]
        common = fm.index.intersection(rm.index)
        c_aligned = fm.loc[common]
        r_aligned = rm.loc[common]
        wfo_on = f"{best_factor_key}_fwd_{fwd_label}"

    if wfo_on is not None:
        fwd_label_used = wfo_on.split("_fwd_")[1] if "_fwd_" in wfo_on else "21d"
        rm = return_matrices[fwd_label_used]
        if wfo_on.startswith("composite"):
            c_aligned = composite.loc[composite.index.intersection(rm.index)]
            r_aligned = rm.loc[composite.index.intersection(rm.index)]
        else:
            base_fn = wfo_on.split("_fwd_")[0]
            fm = factor_matrices[base_fn]
            common = fm.index.intersection(rm.index)
            c_aligned = fm.loc[common]
            r_aligned = rm.loc[common]

        print(f"  WFO-Lite on: {wfo_on}")
        wfo_result = run_wfo_cross_sectional(c_aligned, r_aligned)
        wfo_summary = wfo_result.get("summary")
        n_folds = wfo_result.get("fold_count", 0)
        print(f"  Folds: {n_folds}")
        if wfo_summary:
            print(f"    Mean IC  : {wfo_summary['mean_ic']:.6f}")
            print(f"    Std IC   : {wfo_summary['std_ic']:.6f}")
            print(f"    N folds  : {wfo_summary['n_folds']}")
    else:
        print("  Skipped: insufficient data for any factor.")

    # -----------------------------------------------------------------------
    # Build final report
    # -----------------------------------------------------------------------
    print(f"\nSaving report...")

    report: dict = {
        "generated_at": generated_at,
        "status": "completed",
        "n_symbols": loaded_count,
        "n_days": n_days,
        "data_range": {"start": data_start, "end": data_end},
        "factor_results": factor_results,
        "best_factor": best_all,
        "m0b_pass": m0b_pass,
    }

    if wfo_summary is not None:
        report["wfo_summary"] = wfo_summary

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"  Report saved to: {OUTPUT_PATH}")
    print("\nDone.")


if __name__ == "__main__":
    main()
