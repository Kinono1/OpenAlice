#!/usr/bin/env python3
"""
IC First Pass — Single-asset time-series Spearman Rank IC + WFO-Lite.

Loads 2 months of BTCUSDT 1h data from Binance ZIPs, runs:
  1. Time-series Spearman Rank IC (rolling window)
  2. WFO-Lite (walk-forward Ridge regression)

Outputs to stdout + data/research/ic_first_pass_report.json
"""
import sys
import os
import json
import zipfile
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

# ── Find repo root (handle worktree nesting) ───────────────────────────────
# When running from a worktree, __file__ may be inside .claude/worktrees/agent-*
# We need the actual OpenAlice repo root where scripts/ lives.
_script_dir = os.path.dirname(os.path.abspath(__file__))     # .../scripts/train/
_repo_root = os.path.dirname(os.path.dirname(_script_dir))   # .../OpenAlice/

# Add repo root to path so scripts/ can be found
sys.path.insert(0, _repo_root)

# ── Import IC functions directly from file ─────────────────────────────────
import importlib.util


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


_ic_path = os.path.join(_repo_root, "scripts", "train", "ic_computation.py")
_wfo_path = os.path.join(_repo_root, "scripts", "train", "wfo_validator.py")

ic_mod = _load_module("ic_computation", _ic_path)
wfo_mod = _load_module("wfo_validator", _wfo_path)

compute_icir = ic_mod.compute_icir
compute_ic_drawdown = ic_mod.compute_ic_drawdown
effective_n_correction = ic_mod.effective_n_correction
walk_forward_validation = wfo_mod.walk_forward_validation

# ── Paths ──────────────────────────────────────────────────────────────────
DATA_DIR = (
    "/Volumes/shield/cryptoData/openalice-data/market/"
    "binance-public/spot-all-usdt-klines-1h/spot/BTCUSDT/1h/"
)
OUTPUT_PATH = os.path.join(
    _repo_root, "data", "research", "ic_first_pass_report.json"
)

# ── Data loading ───────────────────────────────────────────────────────────
COLUMNS = [
    "open_time", "open", "high", "low", "close", "volume",
    "close_time", "quote_vol", "trades", "taker_buy_base",
    "taker_buy_quote", "ignore",
]


def load_zip_csv(zip_path: str) -> pd.DataFrame:
    """Load a single CSV from a ZIP archive (assumes one file inside)."""
    with zipfile.ZipFile(zip_path, "r") as z:
        name = z.namelist()[0]
        with z.open(name) as f:
            return pd.read_csv(f, header=None)


def load_btc_data():
    """Load 2024-01 + 2024-02 BTCUSDT 1h data."""
    dfs = []
    for month in ["01", "02"]:
        zfile = f"BTCUSDT-1h-2024-{month}.zip"
        df = load_zip_csv(os.path.join(DATA_DIR, zfile))
        dfs.append(df)
    df = pd.concat(dfs, ignore_index=True)
    df.columns = COLUMNS
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
    df["close"] = df["close"].astype(float)
    df = df.sort_values("open_time").reset_index(drop=True)
    return df


# ── Feature construction ───────────────────────────────────────────────────
def build_features(df: pd.DataFrame):
    """Add return columns to the DataFrame."""
    # 1-hour return and forward return
    df["ret_1h"] = df["close"].pct_change(1)                 # (c_t / c_{t-1}) - 1
    df["forward_1h"] = df["close"].pct_change(1).shift(-1)   # (c_{t+1} / c_t) - 1

    # 24-hour return and forward return
    df["ret_24h"] = df["close"].pct_change(24)                # (c_t / c_{t-24}) - 1
    df["forward_24h"] = df["close"].pct_change(24).shift(-24) # (c_{t+24} / c_t) - 1
    return df


# ── Time-series rolling IC ────────────────────────────────────────────────
def compute_ts_ic_series(
    factor: pd.Series,
    forward: pd.Series,
    window: int = 168,       # one week of 1h bars
) -> pd.Series:
    """Rolling time-series Spearman rank IC for a single asset.

    At each step, takes the last *window* observations and computes the
    Spearman rank correlation between factor values and forward returns.
    Returns an IC series indexed by the *last* timestamp of each window.
    """
    valid = factor.notna() & forward.notna()
    f = factor[valid].values
    r = forward[valid].values
    idx = factor.index[valid]

    if len(f) < window + 1:
        return pd.Series(dtype=float)

    ic_vals = []
    ic_idx = []
    for i in range(len(f) - window):
        rho, _ = spearmanr(f[i: i + window], r[i: i + window])
        ic_vals.append(float(rho) if not np.isnan(rho) else 0.0)
        ic_idx.append(idx[i + window])

    return pd.Series(ic_vals, index=pd.Index(ic_idx, name="timestamp"), name="spearman_ic")


# ── Report helpers ─────────────────────────────────────────────────────────
def ic_summary(name: str, factor: pd.Series, forward: pd.Series) -> dict:
    """Compute rolling IC series and summary stats."""
    ic_series = compute_ts_ic_series(factor, forward, window=168)
    n = int(ic_series.notna().sum())

    if n < 3:
        return {
            "spearman_ic": 0.0,
            "icir": 0.0,
            "drawdown": 0.0,
            "n": 0,
        }

    mean_ic = float(ic_series.mean())
    icir = compute_icir(ic_series)
    dd = compute_ic_drawdown(ic_series)
    eff_n = effective_n_correction(ic_series, method="newey_west", max_lags=24)

    return {
        "spearman_ic": round(mean_ic, 6),
        "icir": round(icir, 6),
        "drawdown": round(dd, 6),
        "n": int(n),
        "effective_n": round(eff_n, 1),
    }


# ── Main ───────────────────────────────────────────────────────────────────
def main():
    print("=" * 60)
    print("IC First Pass Report")
    print("=" * 60)

    # 1. Load data
    print("\n[1/4] Loading BTCUSDT 1h data (2024-01 + 2024-02)...")
    df = load_btc_data()
    print(f"  Loaded {len(df)} rows")
    print(f"  Date range: {df['open_time'].min()} → {df['open_time'].max()}")

    # 2. Build features
    print("\n[2/4] Building features (ret_1h, ret_24h, forward_1h, forward_24h)...")
    df = build_features(df)
    print(f"  ret_1h valid: {df['ret_1h'].notna().sum()}")
    print(f"  forward_1h valid: {df['forward_1h'].notna().sum()}")
    print(f"  ret_24h valid: {df['ret_24h'].notna().sum()}")
    print(f"  forward_24h valid: {df['forward_24h'].notna().sum()}")
    print(f"  Total rows: {len(df)}")

    # 3. Compute IC
    print("\n[3/4] Computing Spearman Rank IC (rolling weekly windows, W=168)...")

    ic_results = {}

    # --- ret_1h → forward_1h ---
    print("\n  Factor: ret_1h  →  Target: forward_1h")
    r1 = ic_summary("ret_1h_fwd_1h", df["ret_1h"], df["forward_1h"])
    ic_results["ret_1h_fwd_1h"] = r1
    print(f"    Spearman IC (mean of rolling): {r1['spearman_ic']:.6f}")
    print(f"    ICIR                         : {r1['icir']:.6f}")
    print(f"    Max drawdown (cumulative)     : {r1['drawdown']:.6f}")
    print(f"    N windows                     : {r1['n']}")
    print(f"    Effective N (NW-adjusted)     : {r1['effective_n']}")

    # --- ret_24h → forward_24h ---
    print("\n  Factor: ret_24h → Target: forward_24h")
    r24 = ic_summary("ret_24h_fwd_24h", df["ret_24h"], df["forward_24h"])
    ic_results["ret_24h_fwd_24h"] = r24
    print(f"    Spearman IC (mean of rolling): {r24['spearman_ic']:.6f}")
    print(f"    ICIR                         : {r24['icir']:.6f}")
    print(f"    Max drawdown (cumulative)     : {r24['drawdown']:.6f}")
    print(f"    N windows                     : {r24['n']}")
    print(f"    Effective N (NW-adjusted)     : {r24['effective_n']}")

    # 3b. Overall (single-pass) IC for reference
    print("\n  --- Overall (single-pass) Spearman IC for reference ---")
    for label, factor_col, fwd_col in [
        ("ret_1h  → fwd_1h", "ret_1h", "forward_1h"),
        ("ret_24h → fwd_24h", "ret_24h", "forward_24h"),
    ]:
        valid = df[fwd_col].notna() & df[factor_col].notna()
        f_vals = df.loc[valid, factor_col].values
        r_vals = df.loc[valid, fwd_col].values
        n_valid = len(f_vals)
        if n_valid >= 3:
            rho, pval = spearmanr(f_vals, r_vals)
            print(f"    {label:25s}: ρ={rho:.6f}  p={pval:.4e}  n={n_valid}")
        else:
            print(f"    {label:25s}: insufficient data (n={n_valid})")

    # 4. Run WFO-Lite
    print("\n\n[4/4] Running WFO-Lite (Ridge, train=60, test=14, step=7, embargo=24)...")

    wfo_results = {}
    for label, feature_col, target_col in [
        ("ret_1h_fwd_1h", "ret_1h", "forward_1h"),
        ("ret_24h_fwd_24h", "ret_24h", "forward_24h"),
    ]:
        # Build a single-column feature matrix
        x = df[[feature_col]].dropna()
        y = df[target_col]
        common = x.index.intersection(y.dropna().index)
        if len(common) < 100:
            print(f"\n  Skipping {label}: insufficient data ({len(common)} rows)")
            continue

        X_mat = x.loc[common]
        y_ser = y.loc[common]
        print(f"\n  WFO: {label} (n={len(common)})")

        result = walk_forward_validation(
            X_mat, y_ser,
            train_window=60,
            test_window=14,
            step=7,
            embargo=24,
        )

        summary = result.get("summary", {})
        wfo_results[label] = summary
        print(f"    Folds        : {result.get('fold_count', 0)}")
        print(f"    Mean IC      : {summary.get('mean_ic', 0):.6f}")
        print(f"    Std IC       : {summary.get('std_ic', 0):.6f}")
        print(f"    Median spread: {summary.get('median_spread', 0):.6f}")
        print(f"    Pass rate    : {summary.get('pass_rate', 0):.3f}")
        print(f"    Fail ratio   : {summary.get('failed_window_ratio', 1):.3f}")

    # 5. Build final report
    print("\n\nSaving report...")
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    report = {
        "generated_at": generated_at,
        "symbol": "BTCUSDT",
        "data_range": {
            "start": str(df["open_time"].min().date()),
            "end": str(df["open_time"].max().date()),
            "rows": int(len(df)),
        },
        "ic_results": ic_results,
        "wfo_results": wfo_results,
        "status": "completed",
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"  Report saved to: {OUTPUT_PATH}")
    print("\nDone.")


if __name__ == "__main__":
    main()
