#!/usr/bin/env python3
"""
Carry Observation Report — v7 Carry plan Observation phase.

Reads data/research/carry_data.jsonl (per-day, per-symbol carry features),
computes rolling 30d z-scores, evaluates entry conditions, and produces both
a JSON report (data/research/carry_observation_report.json) and a human-readable
stdout summary for the last 7 days.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from statistics import mean, stdev
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
REPO_ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
INPUT_PATH = os.path.join(REPO_ROOT, "data", "research", "carry_data.jsonl")
OUTPUT_PATH = os.path.join(REPO_ROOT, "data", "research", "carry_observation_report.json")

SYMBOLS_ORDER = ["BTCUSDT", "ETHUSDT"]

# Entry condition thresholds
FUNDING_RATE_CANDIDATE_THRESHOLD = 0.0003       # 0.03%
ZSCORE_STRONG_THRESHOLD = 2.0                    # 2 sigma
BASIS_BPS_ENTRY_THRESHOLD = 10.0                 # 10 bps

# Rolling window
ROLLING_WINDOW = 30  # days


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def load_carry_data(path: str) -> list[dict[str, Any]]:
    """Load all rows from carry_data.jsonl. Returns empty list if missing."""
    if not os.path.isfile(path):
        return []
    rows: list[dict[str, Any]] = []
    with open(path, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def compute_rolling_zscore(values: list[float]) -> list[float | None]:
    """Compute rolling z-scores over a window.

    For each index i, z-score = (value[i] - mean(values[:i+1])) / stdev(values[:i+1])
    but only when at least 2 data points are available.  Returns None where
    the window is too small.
    """
    zscores: list[float | None] = []
    for i in range(len(values)):
        window = values[: i + 1]
        if len(window) < 2:
            zscores.append(None)
        elif len(window) <= ROLLING_WINDOW:
            # Use all available data up to this point
            mu = mean(window)
            sigma = stdev(window)
            zscores.append((values[i] - mu) / sigma if sigma > 0 else 0.0)
        else:
            window = values[i - ROLLING_WINDOW + 1 : i + 1]
            mu = mean(window)
            sigma = stdev(window)
            zscores.append((values[i] - mu) / sigma if sigma > 0 else 0.0)
    return zscores


def classify_entry(
    funding_rate_8h: float,
    funding_zscore: float | None,
    basis_bps: float | None,
) -> dict[str, Any]:
    """Classify a single day as entry candidate or not.

    Returns a dict with qualification flags.
    """
    rate_candidate = funding_rate_8h > FUNDING_RATE_CANDIDATE_THRESHOLD
    zscore_strong = funding_zscore is not None and funding_zscore > ZSCORE_STRONG_THRESHOLD
    basis_ok = basis_bps is not None and basis_bps > BASIS_BPS_ENTRY_THRESHOLD

    entry_candidate = rate_candidate and zscore_strong and basis_ok

    return {
        "rate_candidate": rate_candidate,
        "zscore_strong": zscore_strong,
        "basis_ok": basis_ok,
        "entry_candidate": entry_candidate,
    }


def build_symbol_series(
    sym_rows: list[dict[str, Any]],
) -> dict[str, list[dict[str, Any]]]:
    """Build per-date entries with computed z-scores for one symbol.

    Returns dict mapping date -> enriched row dict.
    """
    if not sym_rows:
        return {}

    sym_rows.sort(key=lambda r: r.get("date", ""))

    dates: list[str] = []
    funding_rates: list[float] = []
    basis_values: list[float | None] = []
    features_list: list[dict[str, Any]] = []
    net_carry_values: list[float] = []

    for r in sym_rows:
        dates.append(r.get("date", ""))
        funding_rates.append(float(r.get("funding_rate_8h", 0.0)))
        basis_values.append(
            float(r["basis_bps"]) if r.get("basis_bps") is not None else None
        )
        features_list.append(r.get("features", {}))
        net_carry_values.append(float(r.get("expected_net_carry_bps", 0.0)))

    zscores = compute_rolling_zscore(funding_rates)

    date_map: dict[str, dict[str, Any]] = {}
    for i in range(len(dates)):
        fr = funding_rates[i]
        zb = basis_values[i]
        zs = zscores[i]
        classification = classify_entry(fr, zs, zb)

        date_map[dates[i]] = {
            "funding_rate_8h": fr,
            "funding_zscore_30d": zs,
            "basis_bps": zb,
            "entry_candidate": classification["entry_candidate"],
            "rate_candidate": classification["rate_candidate"],
            "zscore_strong": classification["zscore_strong"],
            "basis_ok": classification["basis_ok"],
            "expected_net_carry_bps": net_carry_values[i],
            "features": features_list[i] if features_list[i] else {},
        }
    return date_map


def compute_summary(series: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute 30-day summary statistics from a list of enriched entries."""
    if not series:
        return {}

    recent = series[-ROLLING_WINDOW:]
    candidate_days = [e for e in recent if e["entry_candidate"]]
    valid_funding = [e["funding_rate_8h"] for e in recent]
    valid_basis = [e["basis_bps"] for e in recent if e["basis_bps"] is not None]

    best_entry: str | None = None
    worst_entry: str | None = None
    best_net_carry = -float("inf")
    worst_net_carry = float("inf")
    for cd in candidate_days:
        nc = cd.get("expected_net_carry_bps", 0.0)
        if nc > best_net_carry:
            best_net_carry = nc
            best_entry = cd.get("date", "")
        if nc < worst_net_carry:
            worst_net_carry = nc
            worst_entry = cd.get("date", "")

    return {
        "candidate_days": len(candidate_days),
        "avg_funding_rate": mean(valid_funding) if valid_funding else None,
        "avg_basis_bps": mean(valid_basis) if valid_basis else None,
        "best_entry": best_entry,
        "worst_entry": worst_entry,
    }


# ---------------------------------------------------------------------------
# Print helpers
# ---------------------------------------------------------------------------
def print_header(title: str) -> None:
    """Print a section header."""
    print()
    print("=" * 72)
    print(f"  {title}")
    print("=" * 72)


def print_separator() -> None:
    print("-" * 72)


def fmt_pct(value: float | None, digits: int = 4) -> str:
    """Format a decimal as percentage string."""
    if value is None:
        return "N/A"
    return f"{value * 100:.{digits}f}%"


def fmt_bps(value: float | None, digits: int = 1) -> str:
    """Format a value in bps."""
    if value is None:
        return "N/A"
    return f"{value:.{digits}f} bps"


def fmt_zscore(value: float | None, digits: int = 1) -> str:
    if value is None:
        return "N/A"
    return f"{value:.{digits}f}σ"


def print_daily_report(
    report: list[dict[str, Any]],
    max_days: int = 7,
) -> None:
    """Print the last N days of the daily report."""
    # Each entry in report is a per-date dict with nested symbol keys
    # Sort by date descending, take last max_days
    sorted_report = sorted(report, key=lambda e: e.get("date", ""), reverse=True)
    recent = list(reversed(sorted_report[:max_days]))

    # Collect all symbols across all entries
    all_symbols: list[str] = []
    for entry in recent:
        for k in entry:
            if k in ("date", "generated_at"):
                continue
            if k not in all_symbols:
                all_symbols.append(k)

    print_header(f"Last {len(recent)} Days — Carry Observation Report")

    for entry in recent:
        date_str = entry.get("date", "????-??-??")
        print(f"\n  >>> {date_str} {'=' * 40}")

        for sym in all_symbols:
            d = entry.get(sym)
            if d is None:
                continue

            fr = d.get("funding_rate_8h")
            zs = d.get("funding_zscore_30d")
            bb = d.get("basis_bps")
            nc = d.get("expected_net_carry_bps")
            is_entry = d.get("entry_candidate", False)
            rate_cand = d.get("rate_candidate", False)
            zs_strong = d.get("zscore_strong", False)
            basis_ok = d.get("basis_ok", False)

            features = d.get("features", {})
            spot = features.get("spot_price")
            vol = features.get("volume_24h_usd")
            mark = features.get("mark_price")

            flag = " *** ENTRY CANDIDATE ***" if is_entry else ""
            print(f"\n    [{sym}]{flag}")
            print(f"      Funding rate (8h)      : {fmt_pct(fr)}  {'[>0.03%]' if rate_cand else ''}")
            print(f"      Funding z-score (30d)   : {fmt_zscore(zs)}  {'[>2σ]' if zs_strong else ''}")
            print(f"      Basis                   : {fmt_bps(bb)}  {'[>10bps]' if basis_ok else ''}")
            print(f"      Expected net carry      : {fmt_bps(nc, digits=2)}")
            if spot is not None:
                print(f"      Spot price              : ${float(spot):,.2f}")
            if mark is not None:
                print(f"      Mark price              : ${float(mark):,.2f}")
            if vol is not None:
                print(f"      Volume 24h              : ${float(vol):,.0f}")

    # Summary line
    total_cand = 0
    total_days = 0
    for entry in recent:
        for sym in all_symbols:
            d = entry.get(sym)
            if d is not None:
                total_days += 1
                if d.get("entry_candidate"):
                    total_cand += 1
    print(f"\n  Summary (last {len(recent)} days, {len(all_symbols)} symbols): {total_cand}/{total_days} entry candidate slots")
    print_separator()


def print_summary(summary: dict[str, dict[str, Any]]) -> None:
    """Print the 30-day summary for each symbol."""
    print_header("30-Day Summary Statistics")

    for sym in sorted(summary.keys()):
        s = summary.get(sym, {})
        if not s:
            print(f"\n  [{sym}] — No data")
            continue

        cd = s.get("candidate_days", 0)
        afr = s.get("avg_funding_rate")
        abb = s.get("avg_basis_bps")
        be = s.get("best_entry", "N/A")
        we = s.get("worst_entry", "N/A")

        print(f"\n  {sym}")
        print(f"    Candidate days (30d)     : {cd}")
        print(f"    Avg funding rate (30d)   : {fmt_pct(afr)}")
        print(f"    Avg basis (30d)          : {fmt_bps(abb)}")
        print(f"    Best entry date          : {be}")
        print(f"    Worst entry date         : {we}")

    print_separator()


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    """Entry point."""

    rows = load_carry_data(INPUT_PATH)

    if not rows:
        msg = (
            f"Input file not found or empty: {INPUT_PATH}\n"
            "No carry data available. Generate carry_data.jsonl first before\n"
            "running the observation report."
        )
        print(msg)
        # Write a minimal JSON report indicating no data
        report: dict[str, Any] = {
            "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "latest_data": None,
            "daily_report": [],
            "summary_last_30_days": {},
            "status": "no_data",
            "message": "carry_data.jsonl not found or empty. No report generated.",
        }
        os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
        with open(OUTPUT_PATH, "w") as f:
            json.dump(report, f, indent=2, default=str)
        print(f"\nWrote minimal report to {OUTPUT_PATH}")
        sys.exit(0)

    print(f"Loaded {len(rows)} carry data rows from {INPUT_PATH}")

    # Group rows by symbol
    sym_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    dates_seen: set[str] = set()
    for r in rows:
        sym = r.get("symbol", "UNKNOWN")
        sym_rows[sym].append(r)
        date_val = r.get("date")
        if date_val:
            dates_seen.add(date_val)

    # Discover symbols present in data
    present_symbols = [s for s in SYMBOLS_ORDER if s in sym_rows]
    other_symbols = sorted(set(sym_rows.keys()) - set(SYMBOLS_ORDER))
    all_symbols = present_symbols + other_symbols

    print(f"Symbols found: {', '.join(all_symbols)}")
    print(f"Date range: {len(dates_seen)} unique dates")

    # Build per-symbol date maps and summaries
    sym_date_maps: dict[str, dict[str, dict[str, Any]]] = {}
    summary_last_30_days: dict[str, dict[str, Any]] = {}

    for sym in all_symbols:
        date_map = build_symbol_series(sym_rows[sym])
        sym_date_maps[sym] = date_map
        # Build a date-tagged list for summary computation (remove date field after)
        series_list: list[dict[str, Any]] = []
        for dt, entry_data in sorted(date_map.items()):
            tagged = dict(entry_data)
            tagged["date"] = dt
            series_list.append(tagged)
        summary_last_30_days[sym] = compute_summary(series_list)

    # Group by date: each daily_report entry has date + per-symbol nested data
    all_dates_sorted = sorted(
        set().union(*(dm.keys() for dm in sym_date_maps.values()))
    )
    daily_report: list[dict[str, Any]] = []
    for dt in all_dates_sorted:
        day_entry: dict[str, Any] = {"date": dt}
        for sym in all_symbols:
            dm = sym_date_maps.get(sym, {})
            if dt in dm:
                day_entry[sym] = dm[dt]
        daily_report.append(day_entry)

    # Determine latest data info
    all_dates = sorted(dates_seen)
    latest_date = all_dates[-1] if all_dates else None
    latest_symbols = list(sym_rows.keys())

    # Build output JSON
    output: dict[str, Any] = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest_data": {
            "date": latest_date,
            "symbols": latest_symbols,
        },
        "daily_report": daily_report,
        "summary_last_30_days": summary_last_30_days,
        "status": "ok",
    }

    # Write JSON report
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(output, f, indent=2, default=str)
    print(f"\nWrote JSON report to {OUTPUT_PATH}")

    # Print human-readable report
    print("\n")
    print("*" * 72)
    print("*  CARRY OBSERVATION REPORT")
    print(f"*  Generated: {output['generated_at']}")
    print(f"*  Latest data date: {latest_date or 'N/A'}")
    print("*" * 72)

    print_daily_report(daily_report, max_days=7)
    print_summary(summary_last_30_days)


if __name__ == "__main__":
    main()
