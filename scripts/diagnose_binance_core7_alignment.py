#!/usr/bin/env python3
"""Diagnose Binance presence vs final feature-base merge coverage for CORE7."""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List


DEFAULT_RAW_ROOT = "data/market/binance_1m_core7"
DEFAULT_NORM_ROOT = "data/market/binance_1m_core7_norm"
DEFAULT_FEATURE_ROOT = "data/research/strategy/analysis/stage_c/target_tables"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/binance_alignment_diagnosis.v1.json"
DEFAULT_SYMBOLS = "BTC-USDT,ETH-USDT,SOL-USDT"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Diagnose Binance alignment gap for CORE7.")
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--raw-root", default=DEFAULT_RAW_ROOT)
    parser.add_argument("--norm-root", default=DEFAULT_NORM_ROOT)
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--symbols", default=DEFAULT_SYMBOLS)
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def split_symbols(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_tail_csv_zst(path: Path, keep: int = 6000) -> List[Dict[str, str]]:
    proc = subprocess.Popen(["zstd", "-q", "-d", "-c", str(path)], stdout=subprocess.PIPE, text=True, encoding="utf-8")
    assert proc.stdout is not None
    reader = csv.DictReader(proc.stdout)
    rows: List[Dict[str, str]] = []
    for row in reader:
        rows.append(row)
        if len(rows) > keep:
            rows.pop(0)
    proc.stdout.close()
    proc.wait()
    return rows


def read_csv_rows(path: Path, keep: int = 6000) -> List[Dict[str, str]]:
    if path.suffix == ".zst":
        return read_tail_csv_zst(path, keep)
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: List[Dict[str, str]] = []
        for row in reader:
            rows.append(row)
            if len(rows) > keep:
                rows.pop(0)
    return rows


def count_nonzero(rows: Iterable[Dict[str, str]], key: str) -> int:
    total = 0
    for row in rows:
        value = row.get(key)
        if value in ("", None):
            continue
        try:
            if float(value) != 0:
                total += 1
        except Exception:
            continue
    return total


def count_nonnull(rows: Iterable[Dict[str, str]], key: str) -> int:
    total = 0
    for row in rows:
        value = row.get(key)
        if value not in ("", None):
            total += 1
    return total


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    raw_root = resolve_path(root, args.raw_root)
    norm_root = resolve_path(root, args.norm_root)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output)
    symbols = split_symbols(args.symbols)

    details: List[Dict[str, Any]] = []
    repaired = True
    for symbol in symbols:
        binance_symbol = symbol.replace("-", "")
        raw_spot = raw_root / "spot" / binance_symbol / "1m"
        raw_um = raw_root / "um" / binance_symbol / "1m"
        norm_spot = norm_root / "spot" / binance_symbol / "1m" / "data.csv.zst"
        norm_um = norm_root / "um" / binance_symbol / "1m" / "data.csv.zst"
        feature_table = feature_root / f"okx_inst_id={symbol}" / "data.csv"
        feature_rows = read_csv_rows(feature_table)

        has_binance_spot = count_nonzero(feature_rows, "has_binance_spot_bar")
        has_binance_um = count_nonzero(feature_rows, "has_binance_um_bar")
        spread_spot = count_nonnull(feature_rows, "spread_spot_pct")
        spread_um = count_nonnull(feature_rows, "spread_um_pct")
        basis = count_nonnull(feature_rows, "binance_basis_pct")

        symbol_ok = all(v > 0 for v in [has_binance_spot, has_binance_um, spread_spot, spread_um, basis])
        repaired = repaired and symbol_ok
        details.append(
            {
                "symbol": symbol,
                "rawSpotExists": raw_spot.exists(),
                "rawUmExists": raw_um.exists(),
                "normalizedSpotExists": norm_spot.exists(),
                "normalizedUmExists": norm_um.exists(),
                "featureTableExists": feature_table.exists(),
                "rows": len(feature_rows),
                "hasBinanceSpotBarNonZero": has_binance_spot,
                "hasBinanceUmBarNonZero": has_binance_um,
                "spreadSpotPctNonNull": spread_spot,
                "spreadUmPctNonNull": spread_um,
                "binanceBasisPctNonNull": basis,
                "symbolRepaired": symbol_ok,
            }
        )

    payload = {
        "schemaVersion": "binance_alignment_diagnosis.v1",
        "generatedAt": utc_iso(),
        "rawRoot": str(raw_root),
        "normalizedRoot": str(norm_root),
        "featureRoot": str(feature_root),
        "symbols": details,
        "result": "binance_path_repaired" if repaired else "keep_arbitrage_closed",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output_path), "result": payload["result"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
