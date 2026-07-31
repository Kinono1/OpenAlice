#!/usr/bin/env python3
"""
Carry statistical analysis.

Reads carry data from data/research/carry_data.jsonl, computes entry candidates
based on v7 Carry plan conditions, and produces a statistical analysis report
written to data/research/carry_analysis_report.json.

Entry conditions (v7 Carry plan):
  - funding_rate_8h > 0.03%
  - funding_zscore_30d > 2.0
  - basis_bps > 10

Net carry:
  expected_net_carry_bps = funding_rate_bps * 8h
                          + basis_convergence_bps
                          - 15 (fee + spread + slippage)
"""

import json
import os
import sys
from datetime import datetime, timezone

import numpy as np
import pandas as pd

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
REPO_ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
INPUT_PATH = os.path.join(REPO_ROOT, "data", "research", "carry_data.jsonl")
OUTPUT_PATH = os.path.join(REPO_ROOT, "data", "research", "carry_analysis_report.json")

# Entry condition thresholds (v7 Carry plan)
FUNDING_RATE_THRESHOLD = 0.0003      # 0.03%
FUNDING_ZSCORE_THRESHOLD = 2.0
BASIS_BPS_THRESHOLD = 10.0

# Cost assumptions (bps each)
TOTAL_COST_BPS = 5 + 5 + 5           # fee + spread + slippage = 15 bps

# Funding persistence check
FUNDING_PERSISTENCE_RATE = 0.0001    # 0.01%
FUNDING_PERSISTENCE_PCT = 0.55       # 55%

# Rolling window for funding z-score (30 days at 1h = 720 periods)
ZSCORE_WINDOW = 720

# Lookahead for basis convergence and adverse basis move
LOOKAHEAD_HOURS = 8


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _symbol_key(symbol: str) -> str:
    """Derive lowercase key from symbol, e.g. BTCUSDT -> btc, ETHUSDT -> eth."""
    return symbol.lower().replace("usdt", "")


def _candidates_key(symbol: str) -> str:
    """Derive candidates section key from symbol, e.g. BTCUSDT -> btc_by_condition."""
    return f"{_symbol_key(symbol)}_by_condition"


# ---------------------------------------------------------------------------
# Load
# ---------------------------------------------------------------------------
def load_data(filepath: str) -> pd.DataFrame:
    """Load and parse carry_data.jsonl into a DataFrame.

    Handles two input schemas:
      - Canonical (task spec): ``timestamp``, ``spot_price``, ``mark_price``,
        ``funding_rate_8h``, ``basis_bps``, ``volume_24h_usd`` as top-level keys.
      - Legacy (existing file): ``date`` (instead of ``timestamp``), with
        ``spot_price``, ``mark_price``, ``volume_24h_usd`` nested under
        ``features``.

    The result is sorted by (symbol, timestamp) with a uniform ``timestamp``
    column in datetime64[ns] dtype.
    """
    if not os.path.exists(filepath):
        print(f"ERROR: Input file not found: {filepath}")
        print("Run the carry data loader first to generate the data.")
        sys.exit(1)

    rows: list[dict] = []
    with open(filepath, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                print(f"WARNING: Skipping unparseable JSON line: {line[:100]}")
                continue

    if not rows:
        print("ERROR: No valid data rows found in input file.")
        sys.exit(1)

    df = pd.DataFrame(rows)

    # -- Normalise time column ------------------------------------------------
    if "timestamp" not in df.columns and "date" in df.columns:
        df["timestamp"] = pd.to_datetime(df["date"])
    elif "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"])
    else:
        print("ERROR: Input data has neither 'timestamp' nor 'date' column.")
        sys.exit(1)

    # -- Flatten nested ``features`` dict (legacy format) --------------------
    if "features" in df.columns:
        features_df = pd.json_normalize(df["features"])
        # Only bring in columns that don't already exist at top level
        for col in features_df.columns:
            if col not in df.columns:
                df[col] = features_df[col].values
        df = df.drop(columns=["features"])

    # -- Sort -----------------------------------------------------------------
    df = df.sort_values(["symbol", "timestamp"]).reset_index(drop=True)

    print(f"Loaded {len(df):,} rows from {filepath}")
    print(f"  Symbols: {df['symbol'].unique().tolist()}")
    print(f"  Date range: {df['timestamp'].min()}  to  {df['timestamp'].max()}")
    if len(df) < 100:
        print(f"  (small dataset — z-score and 8h-lookahead stats may be limited)")

    return df


# ---------------------------------------------------------------------------
# Derived feature computation
# ---------------------------------------------------------------------------
def compute_funding_zscore(df: pd.DataFrame) -> pd.DataFrame:
    """Compute a 30-day rolling z-score of funding_rate_8h per symbol.

    This mirrors the v7 Carry plan's funding_zscore_30d feature.  Rows
    without enough history will have NaN.
    """
    df = df.copy()
    df["funding_zscore_30d"] = np.nan

    if "funding_rate_8h" not in df.columns:
        print("  WARNING: funding_rate_8h column not found; z-score will be all NaN")
        return df

    for symbol in df["symbol"].unique():
        mask = df["symbol"] == symbol
        rates = df.loc[mask, "funding_rate_8h"]
        rolling_mean = rates.rolling(
            window=ZSCORE_WINDOW, min_periods=30
        ).mean()
        rolling_std = rates.rolling(
            window=ZSCORE_WINDOW, min_periods=30
        ).std()
        df.loc[mask, "funding_zscore_30d"] = (
            (rates - rolling_mean) / rolling_std.replace(0, np.nan)
        ).values

    z_nonnull = df["funding_zscore_30d"].notna().sum()
    print(f"  Computed funding_zscore_30d for {z_nonnull:,} / {len(df):,} rows")
    return df


def compute_basis_change(df: pd.DataFrame) -> pd.DataFrame:
    """Compute the change in basis_bps over the next LOOKAHEAD_HOURS hours.

    Positive basis_change_bps means convergence (good for a carry trade).
    """
    df = df.copy()
    df["basis_8h_later"] = np.nan
    df["basis_change_bps"] = np.nan

    if "basis_bps" not in df.columns:
        print("  WARNING: basis_bps column not found; basis change will be all NaN")
        return df

    for symbol in df["symbol"].unique():
        mask = df["symbol"] == symbol
        sym = df.loc[mask].copy()
        shifted = sym["basis_bps"].shift(-LOOKAHEAD_HOURS)
        df.loc[mask, "basis_8h_later"] = shifted.values
        df.loc[mask, "basis_change_bps"] = (
            sym["basis_bps"] - shifted
        ).values

    chg_nonnull = df["basis_change_bps"].notna().sum()
    print(f"  Computed basis_change_bps for {chg_nonnull:,} / {len(df):,} rows")
    return df


# ---------------------------------------------------------------------------
# Report sections
# ---------------------------------------------------------------------------
def compute_candidates(df: pd.DataFrame) -> dict:
    """Count rows meeting each entry condition, per symbol.

    Returns a dict keyed by ``{symbol_key}_by_condition``.
    """
    result: dict = {}
    has_funding = "funding_rate_8h" in df.columns
    has_zscore = "funding_zscore_30d" in df.columns
    has_basis = "basis_bps" in df.columns

    for symbol in df["symbol"].unique():
        key = _candidates_key(symbol)
        sym = df[df["symbol"] == symbol]
        n = len(sym)

        cond_funding = (
            sym["funding_rate_8h"].fillna(0) > FUNDING_RATE_THRESHOLD
            if has_funding else pd.Series([False] * n)
        )
        cond_zscore = (
            sym["funding_zscore_30d"].fillna(0) > FUNDING_ZSCORE_THRESHOLD
            if has_zscore else pd.Series([False] * n)
        )
        cond_basis = (
            sym["basis_bps"].fillna(0) > BASIS_BPS_THRESHOLD
            if has_basis else pd.Series([False] * n)
        )

        all_met = cond_funding & cond_zscore & cond_basis

        result[key] = {
            "total_hours": n,
            "funding_rate_gt_0.03pct": int(cond_funding.sum()),
            "funding_zscore_gt_2": int(cond_zscore.sum()),
            "basis_bps_gt_10": int(cond_basis.sum()),
            "all_conditions_met": int(all_met.sum()),
        }

    return result


def compute_net_carry_statistics(df: pd.DataFrame) -> dict:
    """Compute per-symbol net carry statistics on candidate entry rows.

    Returns a dict keyed by ``{symbol_key}``.

    Net carry formula (bps):
      funding_bps        = funding_rate_8h * 10000
      basis_convergence  = basis_change_bps (= basis_t - basis_{t+8h})
      net_carry          = funding_bps + basis_convergence - TOTAL_COST_BPS
    """
    result: dict = {}

    for symbol in df["symbol"].unique():
        sym_key = _symbol_key(symbol)
        sym = df[df["symbol"] == symbol].copy()

        # --- identify candidate entries -----------------------------------
        cond_funding = sym["funding_rate_8h"].fillna(0) > FUNDING_RATE_THRESHOLD
        cond_zscore = sym["funding_zscore_30d"].fillna(0) > FUNDING_ZSCORE_THRESHOLD
        cond_basis = sym["basis_bps"].fillna(0) > BASIS_BPS_THRESHOLD
        cand_mask = cond_funding & cond_zscore & cond_basis
        cand = sym[cand_mask].copy()
        n_candidates = len(cand)

        stats: dict = {
            "candidate_count": n_candidates,
            "median_net_carry_bps": None,
            "mean_net_carry_bps": None,
            "std_net_carry_bps": None,
            "p95_adverse_basis_move": None,
            "max_simulated_drawdown_pct": None,
            "funding_persistence_gt_55pct": False,
        }

        if n_candidates > 0:
            # net carry per candidate
            funding_bps = cand["funding_rate_8h"].values * 10000.0
            convergence = cand["basis_change_bps"].fillna(0).values
            net_carry = funding_bps + convergence - TOTAL_COST_BPS

            stats["median_net_carry_bps"] = float(np.nanmedian(net_carry))
            stats["mean_net_carry_bps"] = float(np.nanmean(net_carry))
            stats["std_net_carry_bps"] = float(np.nanstd(net_carry))

            # P95 adverse basis move (absolute basis change)
            adverse = cand["basis_change_bps"].abs().dropna()
            if len(adverse) > 0:
                stats["p95_adverse_basis_move"] = float(
                    np.percentile(adverse.values, 95)
                )

            # Simulated drawdown on cumulative net carry (chronological)
            cand = cand.sort_values("timestamp")
            c_funding = cand["funding_rate_8h"].values * 10000.0
            c_converge = cand["basis_change_bps"].fillna(0).values
            c_net = c_funding + c_converge - TOTAL_COST_BPS
            c_net = np.nan_to_num(c_net, nan=0.0)
            cumulative = np.cumsum(c_net)
            peak = np.maximum.accumulate(cumulative)
            # avoid division by zero when peak is 0
            dd = np.where(peak > 0, (peak - cumulative) / peak, 0.0)
            stats["max_simulated_drawdown_pct"] = round(
                float(np.max(dd) * 100.0), 4
            )

        # --- funding persistence (entire symbol history) -----------------
        if "funding_rate_8h" in sym.columns:
            total = max(len(sym), 1)
            high = int((sym["funding_rate_8h"] > FUNDING_PERSISTENCE_RATE).sum())
            stats["funding_persistence_gt_55pct"] = (high / total) > FUNDING_PERSISTENCE_PCT

        result[sym_key] = stats

    return result


def compute_observation_pass(statistics: dict) -> dict:
    """Evaluate whether each symbol passes the four observation criteria.

    Candidate passes when:
      - candidate_count > 30
      - median_net_carry_bps > 2 * TOTAL_COST_BPS  (>= 30 bps)
      - funding_persistence > 55%
      - max_simulated_drawdown_pct < 2.0%
    """
    result: dict = {}

    for sym_key, stats in statistics.items():
        cnt = stats.get("candidate_count", 0)
        med = stats.get("median_net_carry_bps") or 0.0
        persist = stats.get("funding_persistence_gt_55pct", False)
        dd = stats.get("max_simulated_drawdown_pct") or 99.0

        checks = {
            "candidate_count_gt_30": cnt > 30,
            "net_carry_gt_2x_cost": med > 2.0 * TOTAL_COST_BPS,
            "funding_persistence_gt_55": persist,
            "drawdown_lt_2pct": dd < 2.0,
        }
        checks["overall"] = all(checks.values())
        result[sym_key] = checks

    return result


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    print("=" * 60)
    print("  Carry Statistical Analysis")
    print("=" * 60)

    # 1. Load
    df = load_data(INPUT_PATH)

    # 2. Compute derived features
    print("\n[1/4] Computing 30-day funding z-score ...")
    df = compute_funding_zscore(df)

    print("[2/4] Computing 8h basis change ...")
    df = compute_basis_change(df)

    # 3. Top-level metadata
    symbols = sorted(df["symbol"].unique().tolist())
    total_rows = len(df)

    print(f"\n[3/4] Computing entry candidates & net carry statistics ...")
    candidates = compute_candidates(df)
    statistics = compute_net_carry_statistics(df)
    observation_pass = compute_observation_pass(statistics)

    # 4. Build report
    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": "pass",
        "symbols": symbols,
        "total_hours": total_rows,
        "total_days": total_rows // 24,
        "candidates": candidates,
        "net_carry_statistics": statistics,
        "observation_pass": observation_pass,
    }

    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2, default=str)

    print(f"[4/4] Report written to {OUTPUT_PATH}\n")

    # Summary
    print("=" * 60)
    print("  Summary")
    print("=" * 60)
    print(f"  Total hours : {total_rows:,}")
    print(f"  Total days  : {total_rows // 24:,}")
    print(f"  Symbols     : {symbols}")
    for sk in sorted(statistics):
        c = candidates.get(f"{sk}_by_condition", {})
        s = statistics.get(sk, {})
        o = observation_pass.get(sk, {})
        print(f"\n  {sk.upper()} : {c.get('all_conditions_met', 0):,} candidates "
              f"over {c.get('total_hours', 0):,} hours")
        print(f"    median_net_carry       : {s.get('median_net_carry_bps')} bps")
        print(f"    mean_net_carry          : {s.get('mean_net_carry_bps')} bps")
        print(f"    p95_adverse_basis       : {s.get('p95_adverse_basis_move')} bps")
        print(f"    max_drawdown            : {s.get('max_simulated_drawdown_pct')} %")
        print(f"    funding_persist >55%    : {s.get('funding_persistence_gt_55pct')}")
        print(f"    observation pass        : {o.get('overall', False)}")
    print("\n" + "=" * 60)
    print("  Done.")


if __name__ == "__main__":
    main()
