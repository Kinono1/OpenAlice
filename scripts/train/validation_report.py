"""
Validation Report Aggregator.

Read-only aggregator that collects existing WFO, PIT audit, DSR, and cost
artifacts into a single validation report JSON. Does NOT run any strategy,
backtest, or audit process -- only reads what is already on disk.

Usage:
    python3 scripts/train/validation_report.py \\
        --config scripts/train/strategy_95_push.py \\
        --output data/research/validation_report.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Path defaults relative to the project root (two levels up from this file)
# ---------------------------------------------------------------------------
_THIS_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.abspath(os.path.join(_THIS_DIR, "..", ".."))

DEFAULT_CONFIG_PATH = os.path.join(_PROJECT_ROOT, "scripts", "train", "strategy_95_push.py")
DEFAULT_WFO_PATH = os.path.join(_PROJECT_ROOT, "data", "research", "strategy_95_push_report.json")
DEFAULT_PIT_PATH = os.path.join(_PROJECT_ROOT, "data", "research", "pit_audit_report.json")
DEFAULT_OUTPUT_PATH = os.path.join(_PROJECT_ROOT, "data", "research", "validation_report.json")


# ═══════════════════════════════════════════════════════════════════════════
# DSR — Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014)
# ═══════════════════════════════════════════════════════════════════════════

def _deflated_sharpe_ratio(
    sharpe: float,
    n_periods: int,
    n_trials: int | None = None,
) -> float:
    """Compute Deflated Sharpe Ratio (approximation from Lopez de Prado).

    Parameters
    ----------
    sharpe : float
        Annualized (or per-observation) Sharpe ratio.
    n_periods : int
        Number of independent observations / periods.
    n_trials : int or None
        Number of independent strategy trials.  If *None* a conservative
        default of 10 is used.

    Returns
    -------
    float
        DSR probability in [0, 1].
    """
    if n_trials is None:
        n_trials = 10  # conservative default when unknown

    from math import log, sqrt
    from scipy.stats import norm

    sr_adj = sharpe * sqrt(n_periods)

    e_max = sqrt(2.0 * log(n_trials))
    v_max = 1.0 - 0.577 * (2.0 * log(n_trials)) / n_periods

    if v_max <= 0:
        v_max = 1e-8

    dsr_z = (sr_adj - e_max) / sqrt(v_max)
    return float(norm.cdf(dsr_z))


def _try_load_dsr_external(
    sharpe: float, n_periods: int, n_trials: int | None = None
) -> tuple[float | None, str]:
    """Attempt to compute DSR via an external ``dsr`` module.

    Falls back to the local implementation if the module cannot be imported.
    Returns ``(value, source_label)``.
    """
    try:
        import dsr  # type: ignore[import-untyped]
    except ImportError:
        return None, "fallback"

    try:
        kwargs = {}
        if n_trials is not None:
            kwargs["n_trials"] = n_trials
        if hasattr(dsr, "deflated_sharpe_ratio"):
            value = dsr.deflated_sharpe_ratio(sharpe, n_periods, **kwargs)
        elif hasattr(dsr, "compute_dsr"):
            value = dsr.compute_dsr(sharpe, n_periods, **kwargs)
        elif hasattr(dsr, "dsr"):
            value = dsr.dsr(sharpe, n_periods, **kwargs)
        else:
            return None, "fallback"
        return float(value), "external"
    except Exception:
        return None, "fallback"


def compute_dsr(
    sharpe: float,
    n_periods: int,
    n_trials: int | None = None,
) -> float | None:
    """Return DSR probability or *None* if inputs are insufficient."""
    if sharpe is None or n_periods is None or n_periods < 2:
        return None

    # Prefer an external dsr module, fall back to local implementation.
    value, source = _try_load_dsr_external(sharpe, n_periods, n_trials)
    if source == "external" and value is not None:
        return value

    try:
        return _deflated_sharpe_ratio(sharpe, n_periods, n_trials)
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════════════════════
# WFO report loader
# ═══════════════════════════════════════════════════════════════════════════

def load_wfo(wfo_path: str) -> dict[str, Any]:
    """Load the strategy WFO report JSON and extract summary stats.

    Returns a dict with keys: *status*, *source*, *n_folds*,
    *median_win_rate*, *median_sharpe*, and optionally *note*.
    """
    if not os.path.isfile(wfo_path):
        return {"status": "missing", "source": wfo_path}

    try:
        with open(wfo_path, "r") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        return {"status": "error", "source": wfo_path, "detail": str(exc)}

    # The report has a "strategies" dict and a "best" key.
    strategies: dict = data.get("strategies", {})
    if not strategies:
        return {"status": "error", "source": wfo_path, "detail": "no strategies key in report"}

    win_rates = []
    sharpes = []
    n_folds_set: set[int] = set()

    best_name: str | None = data.get("best")

    for sname, sdata in strategies.items():
        wr = sdata.get("win_rate")
        sh = sdata.get("sharpe")
        nf = sdata.get("n_folds") or sdata.get("n_periods")
        if wr is not None:
            win_rates.append(float(wr))
        if sh is not None:
            sharpes.append(float(sh))
        if nf is not None:
            n_folds_set.add(int(nf))

    if not win_rates:
        return {"status": "error", "source": wfo_path, "detail": "no win_rate values in strategies"}
    if not sharpes:
        sharpes = [0.0]

    # Compute medians across all strategies.
    win_rates.sort()
    sharpes.sort()

    result: dict[str, Any] = {
        "status": "loaded",
        "source": wfo_path,
        "n_folds": max(n_folds_set) if n_folds_set else None,
        "median_win_rate": _median_sorted(win_rates),
        "median_sharpe": _median_sorted(sharpes),
        "note": "Sharpe uses sqrt(12) — see D1 fix",
    }

    # Attach per-strategy detail.
    best = (data.get("best"), data.get("best_win_rate"))
    result["best"] = {"name": best[0], "win_rate": best[1]} if best[0] else None

    return result


def _median_sorted(sorted_vals: list[float]) -> float:
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    mid = n // 2
    if n % 2 == 1:
        return sorted_vals[mid]
    return (sorted_vals[mid - 1] + sorted_vals[mid]) / 2.0


# ═══════════════════════════════════════════════════════════════════════════
# PIT audit loader
# ═══════════════════════════════════════════════════════════════════════════

def load_pit_audit(pit_path: str) -> dict[str, Any]:
    """Load the PIT audit report JSON.

    Returns ``{"status": "missing"}`` or ``{"status": "loaded", ...}``
    with the top-level keys from the audit report.
    """
    if not os.path.isfile(pit_path):
        return {"status": "missing"}

    try:
        with open(pit_path, "r") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as exc:
        return {"status": "error", "detail": str(exc)}

    result: dict[str, Any] = {"status": "loaded", "source": pit_path}

    # Preserve all top-level keys from the audit payload.
    for k in data:
        result[k] = data[k]

    return result


# ═══════════════════════════════════════════════════════════════════════════
# Cost extraction from strategy source
# ═══════════════════════════════════════════════════════════════════════════

def extract_cost_bps(config_path: str) -> dict[str, Any]:
    """Read the hardcoded cost (in bps) from the strategy config file.

    Falls back to a best-effort grep for the cost pattern ``0.0015``
    or ``15bps`` in the source, and reports *missing* if the file does
    not exist.
    """
    if not os.path.isfile(config_path):
        return {"configured": None, "status": "missing"}

    try:
        with open(config_path, "r") as fh:
            source = fh.read()
    except OSError as exc:
        return {"configured": None, "status": "error", "detail": str(exc)}

    # Pattern: a decimal literal followed by "# ...bps"
    pattern = re.compile(
        r"""
        (?P<decimal>\d+\.\d+)\s*               # e.g. 0.0015
        \#[^#]*? (?P<bps>\d+) \s* bps          # e.g. # 15bps cost
        """,
        re.VERBOSE | re.IGNORECASE,
    )

    for match in pattern.finditer(source):
        bps = int(match.group("bps"))
        line_num = source[: match.start()].count("\n") + 1
        return {
            "configured": bps,
            "status": "loaded",
            "source": config_path,
            "line": line_num,
            "note": f"hardcoded in {os.path.basename(config_path)}:{line_num}, awaiting parameterization",
        }

    # Fallback: look for the comment alone
    fallback = re.search(r"(\d+)\s*bps", source, re.IGNORECASE)
    if fallback:
        bps = int(fallback.group(1))
        return {
            "configured": bps,
            "status": "loaded",
            "source": config_path,
            "note": "extracted via regex fallback (line unknown), awaiting parameterization",
        }

    return {"configured": None, "status": "not_found", "source": config_path}


# ═══════════════════════════════════════════════════════════════════════════
# Regime split (stub / placeholder)
# ═══════════════════════════════════════════════════════════════════════════

def load_regime_split(research_dir: str) -> dict[str, Any]:
    """Search for regime-split artifacts under *research_dir*.

    Currently looks for JSON files whose name contains ``regime_split``
    or ``regime_drilldown``.  Returns ``{"status": "missing"}`` when
    nothing is found.
    """
    if not os.path.isdir(research_dir):
        return {"status": "missing"}

    candidates: list[str] = []
    for fname in os.listdir(research_dir):
        if "regime_split" in fname.lower() or "regime_drilldown" in fname.lower():
            fpath = os.path.join(research_dir, fname)
            if os.path.isfile(fpath) and fname.endswith(".json"):
                candidates.append(fpath)

    if not candidates:
        return {"status": "missing"}

    # Use the first candidate found.
    path = sorted(candidates)[0]
    try:
        with open(path, "r") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {"status": "error", "source": path}

    return {
        "status": "loaded",
        "source": path,
        "data": data,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Negative OOS Sharpe rate (PBO proxy)
# ═══════════════════════════════════════════════════════════════════════════

def load_negative_oos_sharpe_rate(research_dir: str) -> dict[str, Any]:
    """Search walk-forward reports and derive the fraction of OOS folds with
    negative Sharpe ratio.

    Returns ``{"value": <float>, "status": "loaded"}`` or
    ``{"value": None, "status": "missing"}``.
    """
    # Look for WFO report files that include per-fold Sharpe data.
    candidates: list[str] = []
    for fname in os.listdir(research_dir):
        if "wfo" in fname.lower() and fname.endswith(".json"):
            candidates.append(os.path.join(research_dir, fname))

    for path in candidates:
        try:
            with open(path, "r") as fh:
                data = json.load(fh)
        except (json.JSONDecodeError, OSError):
            continue

        folds = data.get("wfo_lite", {}).get("folds", []) or data.get("folds", [])
        if not folds:
            # Some reports use a flat list.
            folds = data.get("fold_results", [])

        sharpe_values: list[float] = []
        for fold in folds:
            if "sharpe_window" in fold and fold["sharpe_window"] is not None:
                sharpe_values.append(float(fold["sharpe_window"]))
            elif "test_sharpe" in fold and fold["test_sharpe"] is not None:
                sharpe_values.append(float(fold["test_sharpe"]))

        if len(sharpe_values) >= 3:
            negative_rate = sum(1 for s in sharpe_values if s < 0) / len(sharpe_values)
            return {
                "value": round(negative_rate, 4),
                "status": "loaded",
                "source": path,
                "n_folds": len(sharpe_values),
            }

    # Fall back to the main strategy_95_push report — it has per-strategy
    # Sharpe but not per-fold.  We mark as missing (can't derive rate from
    # aggregate-only stats).
    return {"value": None, "status": "missing"}


# ═══════════════════════════════════════════════════════════════════════════
# Main aggregation
# ═══════════════════════════════════════════════════════════════════════════

def aggregate_report(
    config_path: str = DEFAULT_CONFIG_PATH,
    wfo_path: str = DEFAULT_WFO_PATH,
    pit_path: str = DEFAULT_PIT_PATH,
    output_path: str = DEFAULT_OUTPUT_PATH,
) -> dict[str, Any]:
    """Run the full aggregation and optionally write *output_path*.

    Returns the full report dict.  Every sub-object contains a ``status``
    field that is one of ``"loaded"``, ``"missing"``, or ``"error"``.
    """
    research_dir = os.path.dirname(wfo_path)

    # 1. WFO
    wfo_result = load_wfo(wfo_path)
    strategy_name: str | None = None
    if wfo_result.get("status") == "loaded":
        best = wfo_result.get("best") or {}
        strategy_name = best.get("name")

    if not strategy_name:
        strategy_name = "unknown"

    # 2. Negative OOS Sharpe rate (PBO proxy)
    negative_oos = load_negative_oos_sharpe_rate(research_dir)

    # 3. DSR — needs Sharpe + n_periods
    dsr_result: dict[str, Any] = {"value": None, "status": "missing"}
    if wfo_result.get("status") == "loaded" and wfo_result.get("median_sharpe") is not None:
        sharpe = wfo_result["median_sharpe"]
        n_periods = wfo_result.get("n_folds")  # best proxy available
        n_strategies = len(
            json.load(open(wfo_path)).get("strategies", {})  # noqa: SIM115
        ) if os.path.isfile(wfo_path) else None

        dsr_value = compute_dsr(sharpe, n_periods, n_trials=n_strategies)
        if dsr_value is not None:
            dsr_result = {
                "value": round(dsr_value, 4),
                "status": "loaded",
                "sharpe_used": sharpe,
                "n_periods_used": n_periods,
                "n_trials_used": n_strategies,
            }

    # 4. PIT audit
    pit_result = load_pit_audit(pit_path)

    # 5. Cost
    cost_result = extract_cost_bps(config_path)

    # 6. Regime split
    regime_result = load_regime_split(research_dir)

    report: dict[str, Any] = {
        "strategy": strategy_name,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    # WFO section — include strategy-level detail
    if wfo_result.get("status") == "loaded":
        wfo_section: dict[str, Any] = {
            "status": "loaded",
            "source": wfo_path,
        }
        for key in ("n_folds", "median_win_rate", "median_sharpe", "note"):
            if key in wfo_result:
                wfo_section[key] = wfo_result[key]
        if "best" in wfo_result and wfo_result["best"]:
            wfo_section["best"] = wfo_result["best"]
    else:
        wfo_section = wfo_result

    report["wfo"] = wfo_section
    report["negative_oos_sharpe_rate"] = negative_oos
    report["dsr"] = dsr_result
    report["pit_audit"] = pit_result
    report["cost_bps"] = cost_result
    report["regime_split"] = regime_result

    return report


# ═══════════════════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════════════════

def _resolve(path: str) -> str:
    """Resolve *path* relative to the project root if it is not absolute."""
    if os.path.isabs(path):
        return path
    return os.path.join(_PROJECT_ROOT, path)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Aggregate WFO / PIT / DSR / cost artifacts into a single validation report.",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG_PATH,
        help=f"Path to strategy config (default: {DEFAULT_CONFIG_PATH})",
    )
    parser.add_argument(
        "--wfo",
        default=DEFAULT_WFO_PATH,
        help=f"Path to WFO report JSON (default: {DEFAULT_WFO_PATH})",
    )
    parser.add_argument(
        "--pit",
        default=DEFAULT_PIT_PATH,
        help=f"Path to PIT audit report JSON (default: {DEFAULT_PIT_PATH})",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT_PATH,
        help=f"Output JSON path (default: {DEFAULT_OUTPUT_PATH})",
    )

    args = parser.parse_args(argv)

    config_path = _resolve(args.config)
    wfo_path = _resolve(args.wfo)
    pit_path = _resolve(args.pit)
    output_path = _resolve(args.output)

    report = aggregate_report(
        config_path=config_path,
        wfo_path=wfo_path,
        pit_path=pit_path,
        output_path=output_path,
    )

    # Ensure the output directory exists.
    output_dir = os.path.dirname(output_path)
    if output_dir and not os.path.isdir(output_dir):
        os.makedirs(output_dir, exist_ok=True)

    with open(output_path, "w") as fh:
        json.dump(report, fh, indent=2, ensure_ascii=False)
        fh.write("\n")

    print(f"Validation report written to {output_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
