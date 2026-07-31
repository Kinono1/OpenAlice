#!/usr/bin/env python3
"""
Data audit for 5 core Binance symbols: BTCUSDT, ETHUSDT, BNBUSDT, SOLUSDT, XRPUSDT.

Scans ZIP files from the Binance public data repository and produces a
structured JSON report detailing per-symbol, per-data-type coverage, row
counts, quality issues, and missing months.

Data sources (read-only):
  - Spot 1h klines:  binance-public/spot-all-usdt-klines-1h/spot/{SYMBOL}/1h/
  - Funding rate:    binance-public/um-all-usdt-fundingRate/um/fundingRate/{SYMBOL}/
  - Mark price 1h:   binance-public/um-all-usdt-markPriceKlines-1h/um/markPriceKlines/{SYMBOL}/1h/

Output: data/research/data_audit_report.json
"""

import json
import os
import sys
import zipfile
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_DIR = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"
REPO_ROOT = "/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
OUTPUT_PATH = os.path.join(REPO_ROOT, "data", "research", "data_audit_report.json")

SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT"]

DATA_TYPES = {
    "spot-klines-1h": {
        "dir_template": "spot-all-usdt-klines-1h/spot/{sym}/1h",
        "file_pattern": "{sym}-1h-{month}.zip",
        "label": "Spot Klines 1h",
    },
    "funding-rate": {
        "dir_template": "um-all-usdt-fundingRate/um/fundingRate/{sym}",
        "file_pattern": "{sym}-fundingRate-{month}.zip",
        "label": "Funding Rate",
    },
    "mark-price-klines-1h": {
        "dir_template": "um-all-usdt-markPriceKlines-1h/um/markPriceKlines/{sym}/1h",
        "file_pattern": "{sym}-1h-{month}.zip",
        "label": "Mark Price Klines 1h",
    },
}

# CSV column indices (0-based)
# Klines (spot and mark price): open_time(0), open(1), high(2), low(3), close(4), volume(5), ...
# Funding rate: calc_time(0), funding_interval_hours(1), last_funding_rate(2)
COL_VOLUME = 5  # used for zero-volume detection in klines


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def months_in_range(first_month: str, last_month: str) -> list[str]:
    """Return all YYYY-MM strings from first_month to last_month inclusive."""
    fy, fm = int(first_month[:4]), int(first_month[5:7])
    ly, lm = int(last_month[:4]), int(last_month[5:7])
    result: list[str] = []
    y, m = fy, fm
    while (y < ly) or (y == ly and m <= lm):
        result.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return result


def month_count(first_month: str, last_month: str) -> int:
    """Total months from first_month to last_month inclusive."""
    fy, fm = int(first_month[:4]), int(first_month[5:7])
    ly, lm = int(last_month[:4]), int(last_month[5:7])
    return (ly - fy) * 12 + (lm - fm) + 1


def parse_month(filename: str) -> str | None:
    """Extract YYYY-MM from a Binance ZIP filename, e.g. BTCUSDT-1h-2024-01.zip."""
    # Strip .zip
    body = filename[:-4] if filename.endswith(".zip") else filename
    # Last two dash-separated tokens should be year and month
    parts = body.split("-")
    if len(parts) >= 2:
        candidate = f"{parts[-2]}-{parts[-1]}"
        if len(candidate) == 7 and candidate[4] == "-":
            return candidate
    return None


def file_sort_key(fname: str) -> tuple:
    """Sort key that orders ZIP filenames by year-month."""
    m = parse_month(fname)
    if m is None:
        return (9999, 99)
    return (int(m[:4]), int(m[5:7]))


def has_csv_header(first_line: str) -> bool:
    """Return True if *first_line* looks like a column-name header (not raw data)."""
    stripped = first_line.strip()
    if not stripped:
        return False
    # Binance kline / funding date always starts with a digit (timestamp).
    # Column-name headers start with a letter.
    return not stripped[0].isdigit()


# ---------------------------------------------------------------------------
# Core audit logic
# ---------------------------------------------------------------------------
def audit_data_type(
    symbol: str, data_type_key: str, cfg: dict
) -> dict:
    """
    Audit a single data type for *symbol*.

    Returns a dict with the full audit record.
    """
    dir_path = os.path.join(BASE_DIR, cfg["dir_template"].format(sym=symbol))
    label = cfg["label"]
    file_pattern = cfg["file_pattern"]

    record: dict = {
        "symbol": symbol,
        "data_type": data_type_key,
        "data_type_label": label,
        "first_month": None,
        "last_month": None,
        "expected_months": 0,
        "actual_months": 0,
        "missing_months": [],
        "total_rows": 0,
        "duplicate_timestamps": 0,
        "zero_volume_bars": 0,
        "status": "pass",
        "warnings": [],
    }

    # ---- 1. List and validate ZIP files ----
    if not os.path.isdir(dir_path):
        record["status"] = "warn"
        record["warnings"].append(f"Directory not found: {dir_path}")
        return record

    all_files = sorted(
        (f for f in os.listdir(dir_path) if f.endswith(".zip")),
        key=file_sort_key,
    )

    if not all_files:
        record["status"] = "warn"
        record["warnings"].append("No ZIP files found")
        return record

    # Extract months from filenames
    file_months: list[tuple[str, str]] = []  # (filename, month)
    for fname in all_files:
        month = parse_month(fname)
        if month is None:
            record["warnings"].append(f"Cannot parse month from filename: {fname}")
            continue
        file_months.append((fname, month))

    if not file_months:
        record["status"] = "warn"
        record["warnings"].append("No valid monthly ZIP filenames found")
        return record

    first_month = file_months[0][1]
    last_month = file_months[-1][1]
    actual_months_set = {m for _, m in file_months}

    record["first_month"] = first_month
    record["last_month"] = last_month
    record["actual_months"] = len(file_months)

    # Expected months
    expected = months_in_range(first_month, last_month)
    record["expected_months"] = len(expected)

    missing = sorted(set(expected) - actual_months_set)
    record["missing_months"] = missing

    if missing:
        record["warnings"].append(
            f"Missing {len(missing)} month(s): {', '.join(missing[:10])}"
            + (f"... (+{len(missing)-10} more)" if len(missing) > 10 else "")
        )
        record["status"] = "warn"

    # ---- 2. Scan each ZIP for row counts / quality ----
    total_rows = 0
    seen_timestamps: set[str] = set()
    dup_count = 0
    zero_vol_count = 0
    # Track row counts per file for diagnostics
    file_row_counts: dict[str, int] = {}
    header_detected: bool | None = None  # None=unset, True/False once determined

    total_files = len(file_months)
    for idx, (fname, month) in enumerate(file_months, 1):
        fpath = os.path.join(dir_path, fname)

        # Print progress line (carriage return)
        progress = (
            f"  [{symbol}] {data_type_key}: scanning {idx}/{total_files} "
            f"({fname})        "
        )
        print(progress, end="\r", file=sys.stderr, flush=True)

        if not os.path.isfile(fpath):
            record["warnings"].append(f"File disappeared during scan: {fpath}")
            continue

        try:
            with zipfile.ZipFile(fpath, "r") as zf:
                names = zf.namelist()
                if not names:
                    record["warnings"].append(f"Empty ZIP: {fname}")
                    continue

                csv_name = names[0]
                raw = zf.read(csv_name).decode("utf-8", errors="replace")
                lines = raw.strip().split("\n")
        except Exception as exc:
            record["warnings"].append(f"Cannot read {fname}: {exc}")
            continue

        if not lines:
            record["warnings"].append(f"Empty CSV inside {fname}")
            continue

        # Detect header on first file
        first_line = lines[0].strip()
        if header_detected is None:
            header_detected = has_csv_header(first_line)

        # Determine data lines
        if header_detected:
            data_lines = lines[1:]
        else:
            data_lines = lines

        row_count = len(data_lines)
        file_row_counts[fname] = row_count
        total_rows += row_count

        # Check duplicates and zero volume
        for line in data_lines:
            line = line.strip()
            if not line:
                continue
            parts = line.split(",")
            if len(parts) < 6:
                # Too few columns, skip quality checks but still counted
                continue

            ts = parts[0].strip()
            if ts in seen_timestamps:
                dup_count += 1
            else:
                seen_timestamps.add(ts)

            # Zero-volume check for klines (mark price may also apply)
            if data_type_key in ("spot-klines-1h", "mark-price-klines-1h"):
                vol_str = parts[COL_VOLUME].strip()
                try:
                    vol = float(vol_str)
                    if vol == 0.0:
                        zero_vol_count += 1
                except ValueError:
                    pass

    # Clear progress line
    print(" " * 80, end="\r", file=sys.stderr, flush=True)

    record["total_rows"] = total_rows
    record["duplicate_timestamps"] = dup_count
    record["zero_volume_bars"] = zero_vol_count

    # ---- 3. Determine overall status ----
    issues: list[str] = []
    if missing:
        issues.append(f"missing_months={len(missing)}")
    if dup_count > 0:
        issues.append(f"duplicate_timestamps={dup_count}")
    if zero_vol_count > 0:
        issues.append(f"zero_volume_bars={zero_vol_count}")

    if not issues:
        record["status"] = "pass"
    elif dup_count > 0 or missing:
        record["status"] = "fail"
    else:
        record["status"] = "warn"

    # ---- 4. Add first-month / last-month sampling notes ----
    if file_months:
        first_name = file_months[0][0]
        last_name = file_months[-1][0]
        first_rows = file_row_counts.get(first_name, 0)
        last_rows = file_row_counts.get(last_name, 0)
        record["first_file"] = first_name
        record["last_file"] = last_name
        record["first_file_rows"] = first_rows
        record["last_file_rows"] = last_rows

        if first_rows < 24:
            record["warnings"].append(
                f"Partial first month ({first_name}): {first_rows} rows"
            )
        if last_rows < 24:
            record["warnings"].append(
                f"Partial last month ({last_name}): {last_rows} rows"
            )

    return record


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> None:
    start = datetime.now(timezone.utc)
    print(f"Data audit started at {start.isoformat()}")
    print(f"Base directory: {BASE_DIR}")
    print(f"Symbols: {', '.join(SYMBOLS)}")
    print(f"Data types: {', '.join(DATA_TYPES.keys())}")
    print()

    all_audits: list[dict] = []

    for symbol in SYMBOLS:
        for dtype_key, dtype_cfg in DATA_TYPES.items():
            print(f"\nAuditing {symbol} / {dtype_key} ...")
            record = audit_data_type(symbol, dtype_key, dtype_cfg)
            all_audits.append(record)

            # Quick summary line
            status_icon = {
                "pass": "PASS",
                "warn": "WARN",
                "fail": "FAIL",
            }.get(record["status"], "????")
            print(
                f"  {status_icon} | {record['actual_months']}/{record['expected_months']} months "
                f"| {record['total_rows']:>8,} rows "
                f"| dups={record['duplicate_timestamps']} "
                f"| zero_vol={record['zero_volume_bars']}"
            )

    # ---- Build report ----
    report = {
        "report_generated": start.isoformat(),
        "report_generated_utc": start.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "base_directory": BASE_DIR,
        "symbols": SYMBOLS,
        "data_types": list(DATA_TYPES.keys()),
        "audits": all_audits,
        "summary": {
            "total_audits": len(all_audits),
            "pass": sum(1 for a in all_audits if a["status"] == "pass"),
            "warn": sum(1 for a in all_audits if a["status"] == "warn"),
            "fail": sum(1 for a in all_audits if a["status"] == "fail"),
        },
    }

    # ---- Write output ----
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(report, f, indent=2)

    elapsed = (datetime.now(timezone.utc) - start).total_seconds()
    print(f"\n{'=' * 60}")
    print(f"Report written to: {OUTPUT_PATH}")
    print(
        f"Summary: {report['summary']['pass']} pass, "
        f"{report['summary']['warn']} warn, "
        f"{report['summary']['fail']} fail "
        f"({report['summary']['total_audits']} total)"
    )
    print(f"Elapsed: {elapsed:.1f}s")


if __name__ == "__main__":
    main()
