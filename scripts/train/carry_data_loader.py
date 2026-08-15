#!/usr/bin/env python3
"""
Carry Data Loader

Loads BTC and ETH funding rate + spot + mark price data from Binance ZIP files
and outputs a clean JSONL for carry analysis.

Data sources:
  - Spot 1h klines  (binance-public, um-all)
  - Mark price 1h klines (binance-public, um-all)
  - Funding rate (binance-public, um-all)

Usage:
    python3 scripts/train/carry_data_loader.py

Output:
    data/research/carry_data.jsonl
"""

import zipfile
import csv
import json
import io
import os
import sys
from datetime import datetime, timezone
from bisect import bisect_right
from collections.abc import Sequence
from collections import deque

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SYMBOLS = ["BTCUSDT", "ETHUSDT"]

BASE_DIR = "/Volumes/shield/cryptoData/openalice-data/market/binance-public"

SPOT_DIR_TPL = os.path.join(
    BASE_DIR, "spot-all-usdt-klines-1h", "spot", "{symbol}", "1h"
)
FR_DIR_TPL = os.path.join(
    BASE_DIR, "um-all-usdt-fundingRate", "um", "fundingRate", "{symbol}"
)
MP_DIR_TPL = os.path.join(
    BASE_DIR,
    "um-all-usdt-markPriceKlines-1h",
    "um",
    "markPriceKlines",
    "{symbol}",
    "1h",
)

# Load all months up to and including 2024-06.
# Cutoff is exclusive, so months < "2024-07" are loaded.
CUTOFF_YM = "2024-07"

# Output path relative to repo root (scripts/train/ -> ../../ -> repo root)
_REPO_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..")
)
OUTPUT_FILE = os.path.join(_REPO_ROOT, "data", "research", "carry_data.jsonl")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def extract_year_month(filename: str) -> str | None:
    """Extract ``YYYY-MM`` from a filename such as ``BTCUSDT-1h-2024-01.zip``.

    The year and month are always the last two ``-`` separated components of
    the basename (before the ``.zip`` extension).
    """
    base = filename.removesuffix(".zip")
    parts = base.split("-")
    if len(parts) >= 2:
        yyyy, mm = parts[-2], parts[-1]
        if len(yyyy) == 4 and yyyy.isdigit() and len(mm) == 2 and mm.isdigit():
            return f"{yyyy}-{mm}"
    return None


def timestamp_to_iso(ts_sec: int) -> str:
    """Convert a Unix timestamp (seconds) to an ISO-8601 UTC string."""
    return datetime.fromtimestamp(ts_sec, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def read_csv_rows_from_zip(zip_path: str) -> list[list[str]]:
    """Read every row from the single CSV inside a ZIP file.

    Returns a list of rows (each row is a list of strings).  An empty list is
    returned on any error (missing file, corrupt ZIP, etc.) without raising.
    """
    rows: list[list[str]] = []
    try:
        with zipfile.ZipFile(zip_path) as zf:
            csv_name = zf.namelist()[0]
            with zf.open(csv_name) as fh:
                reader = csv.reader(io.TextIOWrapper(fh))
                for row in reader:
                    rows.append(row)
    except Exception as exc:
        print(f"  [WARN] Failed to read {zip_path}: {exc}", file=sys.stderr)
    return rows


# ---------------------------------------------------------------------------
# Data loaders (per symbol)
# ---------------------------------------------------------------------------


def load_spot_klines(symbol: str) -> dict[int, dict]:
    """Load all spot 1h klines for *symbol* up to the cutoff month.

    Columns (no header row)::

        Open time, Open, High, Low, **Close**, **Volume**, Close time,
        **Quote asset volume**, Trades, Taker buy base vol,
        Taker buy quote vol, Ignore

    Close          -> index 4
    Volume         -> index 5
    Quote a. vol.  -> index 7 (this is USDT notional volume)
    """
    data: dict[int, dict] = {}
    directory = SPOT_DIR_TPL.format(symbol=symbol)
    if not os.path.isdir(directory):
        print(f"  [WARN] Spot directory not found: {directory}", file=sys.stderr)
        return data

    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".zip"):
            continue
        ym = extract_year_month(fname)
        if ym is None or ym >= CUTOFF_YM:
            continue

        fpath = os.path.join(directory, fname)
        for row in read_csv_rows_from_zip(fpath):
            if len(row) < 12:
                continue
            ts_sec = int(row[0]) // 1000
            data[ts_sec] = {
                "spot_price": float(row[4]),
                "volume": float(row[5]),
                "quote_volume": float(row[7]),
            }

    print(
        f"  Loaded {len(data):,} spot klines for {symbol}", file=sys.stderr
    )
    return data


def load_mark_price_klines(symbol: str) -> dict[int, dict]:
    """Load all mark-price 1h klines for *symbol* up to the cutoff month.

    The CSV uses the same column layout as spot klines (no header).
    Close (index 4) is the mark price at the end of the hour.
    """
    data: dict[int, dict] = {}
    directory = MP_DIR_TPL.format(symbol=symbol)
    if not os.path.isdir(directory):
        print(
            f"  [WARN] Mark-price directory not found: {directory}",
            file=sys.stderr,
        )
        return data

    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".zip"):
            continue
        ym = extract_year_month(fname)
        if ym is None or ym >= CUTOFF_YM:
            continue

        fpath = os.path.join(directory, fname)
        for row in read_csv_rows_from_zip(fpath):
            if len(row) < 5:
                continue
            # Mark-price files from mid-2022 onward include a header row
            # (open_time,open,high,low,close,...).  Older files do not.
            # Detect by checking whether the first field parses as an integer.
            try:
                ts_sec = int(row[0]) // 1000
            except (ValueError, IndexError):
                continue
            data[ts_sec] = {"mark_price": float(row[4])}

    print(
        f"  Loaded {len(data):,} mark-price klines for {symbol}",
        file=sys.stderr,
    )
    return data


def load_funding_rates(symbol: str) -> list[tuple[int, float]]:
    """Load all funding-rate records for *symbol* up to the cutoff month.

    CSV format (has a single header row)::

        calc_time, funding_interval_hours, last_funding_rate

    Returns a list of ``(timestamp_sec, rate)`` tuples sorted by timestamp.
    """
    rates: list[tuple[int, float]] = []
    directory = FR_DIR_TPL.format(symbol=symbol)
    if not os.path.isdir(directory):
        print(
            f"  [WARN] Funding-rate directory not found: {directory}",
            file=sys.stderr,
        )
        return rates

    for fname in sorted(os.listdir(directory)):
        if not fname.endswith(".zip"):
            continue
        ym = extract_year_month(fname)
        if ym is None or ym >= CUTOFF_YM:
            continue

        fpath = os.path.join(directory, fname)
        rows = read_csv_rows_from_zip(fpath)
        # First row is the CSV header -- skip it.
        for row in rows[1:]:
            if len(row) < 3:
                continue
            ts_sec = int(row[0]) // 1000
            rate = float(row[2])
            rates.append((ts_sec, rate))

    rates.sort(key=lambda x: x[0])
    print(
        f"  Loaded {len(rates):,} funding-rate samples for {symbol}",
        file=sys.stderr,
    )
    return rates


# ---------------------------------------------------------------------------
# Derived fields
# ---------------------------------------------------------------------------


def compute_rolling_24h_volume(
    spot_data: dict[int, dict],
) -> dict[int, float]:
    """Compute a 24-hour rolling sum of quote asset volume (USDT).

    The window is 86400 seconds wide.  Values for the first ~24 hours will
    naturally ramp up as the window fills; this is acceptable.
    """
    sorted_ts = sorted(spot_data.keys())
    window: deque[tuple[int, float]] = deque()
    current_sum = 0.0
    result: dict[int, float] = {}

    for ts in sorted_ts:
        qv = spot_data[ts]["quote_volume"]
        window.append((ts, qv))
        current_sum += qv
        # Slide window: discard entries older than 24 h
        while window and ts - window[0][0] >= 86400:
            _, old_qv = window.popleft()
            current_sum -= old_qv
        result[ts] = current_sum

    return result


class FundingRateLookup:
    """Forward-fill funding-rate lookup via binary search.

    For any hourly timestamp returns the most recent funding-rate event that
    occurred at or before that timestamp.
    """

    def __init__(self, rates: Sequence[tuple[int, float]]) -> None:
        self._times = [r[0] for r in rates]
        self._values = [r[1] for r in rates]

    def get(self, ts_sec: int) -> float | None:
        """Return the funding rate applicable at *ts_sec*, or *None*."""
        if not self._times:
            return None
        idx = bisect_right(self._times, ts_sec) - 1
        if idx >= 0:
            return self._values[idx]
        return None


# ---------------------------------------------------------------------------
# Symbol pipeline
# ---------------------------------------------------------------------------


def process_symbol(symbol: str) -> list[dict]:
    """Load all data for *symbol*, merge on hourly timestamps, and
    return a list of output rows sorted ascending by time."""
    print(f"\n{'─' * 52}", file=sys.stderr)
    print(f"  Processing {symbol}", file=sys.stderr)
    print(f"{'─' * 52}", file=sys.stderr)

    spot_data = load_spot_klines(symbol)
    if not spot_data:
        print(f"  [SKIP] No spot data for {symbol}.", file=sys.stderr)
        return []

    mark_data = load_mark_price_klines(symbol)
    fr_rates = load_funding_rates(symbol)

    fr_lookup = FundingRateLookup(fr_rates)
    vol_24h = compute_rolling_24h_volume(spot_data)

    # Retain only hours where both spot and mark-price are present.
    common_ts = sorted(set(spot_data.keys()) & set(mark_data.keys()))
    print(
        f"  Merged timestamps: {len(common_ts):,}", file=sys.stderr
    )

    rows: list[dict] = []
    for ts in common_ts:
        sp = spot_data[ts]
        mp = mark_data[ts]
        spot_price = sp["spot_price"]
        mark_price = mp["mark_price"]

        # Basis = (mark - spot) / spot, expressed in basis points (1 bp = 0.01 %)
        basis_bps = (mark_price - spot_price) / spot_price * 10_000

        rows.append(
            {
                "timestamp": timestamp_to_iso(ts),
                "symbol": symbol,
                "spot_price": spot_price,
                "mark_price": mark_price,
                "funding_rate_8h": fr_lookup.get(ts),
                "basis_bps": round(basis_bps, 4),
                "volume_24h_usd": round(vol_24h.get(ts, 0.0), 2),
            }
        )

    return rows


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    print("=" * 52, file=sys.stderr)
    print("  Carry Data Loader", file=sys.stderr)
    print("=" * 52, file=sys.stderr)
    print(f"  Symbols : {', '.join(SYMBOLS)}", file=sys.stderr)
    print(f"  Period  : < {CUTOFF_YM}  (up to 2024-06 inclusive)", file=sys.stderr)
    print(f"  Output  : {OUTPUT_FILE}", file=sys.stderr)

    all_rows: list[dict] = []
    for symbol in SYMBOLS:
        symbol_rows = process_symbol(symbol)
        all_rows.extend(symbol_rows)

    # Global chronological order; ties broken by symbol.
    all_rows.sort(key=lambda r: (r["timestamp"], r["symbol"]))

    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    with open(OUTPUT_FILE, "w") as fh:
        for row in all_rows:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"\n{'=' * 52}", file=sys.stderr)
    print(
        f"  Done.  {len(all_rows):,} rows written.", file=sys.stderr
    )
    print(f"{'=' * 52}", file=sys.stderr)

    # Print first and last row to stdout so the caller can verify.
    if all_rows:
        print(json.dumps(all_rows[0], ensure_ascii=False))
        print(json.dumps(all_rows[-1], ensure_ascii=False))


if __name__ == "__main__":
    main()
