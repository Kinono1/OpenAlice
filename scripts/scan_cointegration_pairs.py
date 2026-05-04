#!/usr/bin/env python3
from __future__ import annotations

"""
Offline cointegration scanner for OpenAlice.

Reads OHLCV data from data/klines/<SYMBOL>_<INTERVAL>.csv (or .json),
runs Engle-Granger two-step cointegration test on all symbol pairs,
filters by p-value < 0.05 and half-life in [2, 200] bars,
writes data/runtime/pairs_registry.json only with --dry-run false.

Usage:
    python3 scripts/scan_cointegration_pairs.py [--interval 1h] [--lookback 365] [--data-dir data/klines] --dry-run false

Output schema (data/runtime/pairs_registry.json):
    {
      "generatedAt": "2026-04-27T13:00:00Z",
      "interval": "1h",
      "lookbackBars": 8760,
      "pairs": [
        {
          "symbolA": "BTC/USDT",
          "symbolB": "ETH/USDT",
          "hedgeRatio": 1.52,
          "halfLife": 24.3,
          "spreadMean": 0.12,
          "spreadStd": 1.84,
          "adfTStat": -3.71,
          "pValue": 0.03,
          "isCointegrated": true,
          "updatedAt": "2026-04-27T13:00:00Z"
        }
      ]
    }
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from itertools import combinations
from pathlib import Path
from typing import Optional

try:
    import numpy as np
except ImportError:
    np = None

HAS_STATSMODELS = False
adfuller = None
coint = None


def load_optional_statsmodels() -> None:
    """Load statsmodels only for real scans so default dry-run stays dependency-light."""
    global HAS_STATSMODELS, adfuller, coint
    try:
        from statsmodels.tsa.stattools import adfuller as loaded_adfuller, coint as loaded_coint
        adfuller = loaded_adfuller
        coint = loaded_coint
        HAS_STATSMODELS = True
    except ImportError:
        HAS_STATSMODELS = False
        print("[warn] statsmodels not found — using manual Engle-Granger implementation", file=sys.stderr)


def ols(y: np.ndarray, x: np.ndarray):
    """OLS: y = alpha + beta*x. Returns (alpha, beta, residuals)."""
    n = len(y)
    x_with_const = np.column_stack([np.ones(n), x])
    try:
        coeffs, _, _, _ = np.linalg.lstsq(x_with_const, y, rcond=None)
    except np.linalg.LinAlgError:
        return 0.0, 1.0, y - np.mean(y)
    alpha, beta = coeffs[0], coeffs[1]
    residuals = y - alpha - beta * x
    return alpha, beta, residuals


def adf_tstat_manual(series: np.ndarray) -> float:
    """Manual ADF t-stat (no constant, no trend)."""
    n = len(series)
    if n < 4:
        return 0.0
    diff = np.diff(series)
    lagged = series[:-1]
    _, beta, residuals = ols(diff, lagged)
    ss_res = np.sum(residuals ** 2)
    se = np.sqrt(ss_res / max(len(residuals) - 2, 1))
    ss_lag = np.sum((lagged - lagged.mean()) ** 2)
    se_beta = se / np.sqrt(ss_lag) if ss_lag > 0 else np.inf
    return beta / se_beta if se_beta > 0 else 0.0


def mackinnon_pvalue(t_stat: float) -> float:
    """Approximate MacKinnon (1994) p-value for ADF."""
    if t_stat < -3.43: return 0.01
    if t_stat < -2.86: return 0.05
    if t_stat < -2.57: return 0.10
    if t_stat < -1.94: return 0.20
    return 0.50


def half_life(spread: np.ndarray) -> float:
    """Estimate mean-reversion half-life via AR(1)."""
    if len(spread) < 3:
        return float('inf')
    _, beta, _ = ols(spread[1:], spread[:-1])
    if beta <= 0 or beta >= 1:
        return float('inf')
    return -np.log(2) / np.log(beta)


def test_cointegration(prices_a: np.ndarray, prices_b: np.ndarray,
                       p_threshold: float = 0.05,
                       min_half_life: float = 2.0,
                       max_half_life: float = 200.0) -> dict:
    """Engle-Granger two-step cointegration test."""
    n = min(len(prices_a), len(prices_b))
    if n < 60:
        return {"isCointegrated": False, "pValue": 1.0}

    a, b = prices_a[-n:], prices_b[-n:]

    if HAS_STATSMODELS:
        try:
            _, p_value, _ = coint(a, b)  # type: ignore[misc]
            _, beta, residuals = ols(a, b)
            t_stat = float(adfuller(residuals, autolag=None, maxlag=1)[0])  # type: ignore[misc]
        except Exception:
            _, beta, residuals = ols(a, b)
            t_stat = adf_tstat_manual(residuals)
            p_value = mackinnon_pvalue(t_stat)
    else:
        _, beta, residuals = ols(a, b)
        t_stat = adf_tstat_manual(residuals)
        p_value = mackinnon_pvalue(t_stat)

    hl = half_life(residuals)
    spread_mean = float(np.mean(residuals))
    spread_std = float(np.std(residuals))

    is_coint = (
        p_value <= p_threshold
        and min_half_life <= hl <= max_half_life
        and spread_std > 0
    )

    return {
        "hedgeRatio": float(beta),
        "halfLife": float(hl) if np.isfinite(hl) else 9999.0,
        "spreadMean": spread_mean,
        "spreadStd": spread_std,
        "adfTStat": float(t_stat),
        "pValue": float(p_value),
        "isCointegrated": is_coint,
    }


def load_prices(data_dir: Path, symbol: str, interval: str) -> Optional[np.ndarray]:
    """Load close prices from CSV or JSON. Returns None if not found."""
    safe_sym = symbol.replace("/", "_").replace(":", "_")
    for ext in [".csv", ".json"]:
        path = data_dir / f"{safe_sym}_{interval}{ext}"
        if not path.exists():
            continue
        try:
            if ext == ".csv":
                import csv
                with open(path) as f:
                    rows = list(csv.DictReader(f))
                # Try common close column names
                for col in ["close", "Close", "c", "4"]:
                    if col in (rows[0] if rows else {}):
                        return np.array([float(r[col]) for r in rows if r.get(col)])
            else:
                with open(path) as f:
                    data = json.load(f)
                if isinstance(data, list):
                    if isinstance(data[0], list):
                        return np.array([float(row[4]) for row in data])  # OHLCV[4] = close
                    if isinstance(data[0], dict):
                        for col in ["close", "Close", "c"]:
                            if col in data[0]:
                                return np.array([float(r[col]) for r in data])
        except Exception as e:
            print(f"[warn] Failed to load {path}: {e}", file=sys.stderr)
    return None


def scan(data_dir: Path, interval: str, lookback: int,
         p_threshold: float, min_hl: float, max_hl: float) -> list[dict]:
    """Scan all symbol pairs in data_dir for cointegration."""
    # Discover available symbols
    symbols = []
    for f in sorted(data_dir.iterdir()):
        if f.suffix in (".csv", ".json") and f"_{interval}" in f.stem:
            sym = f.stem.replace(f"_{interval}", "").replace("_", "/", 1)
            symbols.append(sym)

    symbols = list(dict.fromkeys(symbols))  # deduplicate
    print(f"[info] Found {len(symbols)} symbols, testing {len(symbols)*(len(symbols)-1)//2} pairs", file=sys.stderr)

    # Load price series
    price_cache: dict[str, np.ndarray] = {}
    for sym in symbols:
        prices = load_prices(data_dir, sym, interval)
        if prices is not None and len(prices) >= 60:
            price_cache[sym] = prices[-lookback:]

    results = []
    now = datetime.now(timezone.utc).isoformat()

    for sym_a, sym_b in combinations(list(price_cache.keys()), 2):
        result = test_cointegration(
            price_cache[sym_a], price_cache[sym_b],
            p_threshold=p_threshold, min_half_life=min_hl, max_half_life=max_hl,
        )
        if result.get("isCointegrated"):
            results.append({
                "symbolA": sym_a,
                "symbolB": sym_b,
                "updatedAt": now,
                **result,
            })

    results.sort(key=lambda r: r["pValue"])
    print(f"[info] Found {len(results)} cointegrated pairs", file=sys.stderr)
    return results


def main():
    parser = argparse.ArgumentParser(description="Scan cointegrated pairs for OpenAlice")
    parser.add_argument("--interval", default="1h")
    parser.add_argument("--lookback", type=int, default=8760, help="Max bars to use (default 8760 = 1yr hourly)")
    parser.add_argument("--data-dir", default="data/klines")
    parser.add_argument("--output", default="data/runtime/pairs_registry.json")
    parser.add_argument("--p-threshold", type=float, default=0.05)
    parser.add_argument("--min-half-life", type=float, default=2.0)
    parser.add_argument("--max-half-life", type=float, default=200.0)
    parser.add_argument("--dry-run", default="true", help="Default true. Use --dry-run false to write output.")
    args = parser.parse_args()

    dry_run = parse_bool(args.dry_run, default=True)
    if dry_run:
        print(json.dumps({
            "family": "cointegration_pairs",
            "command": "scan_cointegration_pairs",
            "executionMode": {
                "dryRun": True,
                "readsKlineData": False,
                "writesPairsRegistry": False,
                "promotionEligible": False,
            },
            "inputs": {
                "interval": args.interval,
                "lookbackBars": args.lookback,
                "dataDir": args.data_dir,
            },
            "output": args.output,
            "optIn": {
                "scanAndWriteRegistry": "--dry-run false",
            },
        }, indent=2))
        return

    if np is None:
        print("[error] numpy is required when --dry-run false", file=sys.stderr)
        sys.exit(1)
    load_optional_statsmodels()

    data_dir = Path(args.data_dir)
    if not data_dir.exists():
        print(f"[error] Data directory not found: {data_dir}", file=sys.stderr)
        sys.exit(1)

    pairs = scan(data_dir, args.interval, args.lookback,
                 args.p_threshold, args.min_half_life, args.max_half_life)

    output = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "interval": args.interval,
        "lookbackBars": args.lookback,
        "pThreshold": args.p_threshold,
        "pairs": pairs,
    }

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)

    print(f"[done] Wrote {len(pairs)} pairs to {out_path}")


def parse_bool(raw: str, default: bool) -> bool:
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in ("1", "true", "yes", "y", "on"):
        return True
    if normalized in ("0", "false", "no", "n", "off"):
        return False
    raise ValueError(f"Invalid boolean value: {raw}")


if __name__ == "__main__":
    main()
