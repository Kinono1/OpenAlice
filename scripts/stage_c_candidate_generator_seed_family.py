#!/usr/bin/env python3
"""Generate a single-seed Stage-C candidate set for vol-gated breakout."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
import subprocess
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional


DEFAULT_BASE = "docs/research/strategy_candidates.v1.json"
DEFAULT_FEATURE_ROOT = "data/research/strategy/analysis/stage_c/target_tables"
DEFAULT_OUTPUT = "docs/research/stage_c_strategy_candidates.seed_family.v1.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate single-seed Stage-C candidates from redesigned target tables.")
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--base-candidates", default=DEFAULT_BASE, help="Base strategy_candidates.v1 template.")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="Root of redesigned target tables.")
    parser.add_argument("--symbols", default="BTC-USDT,ETH-USDT,SOL-USDT", help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=4000, help="Rows to sample from the tail of each table.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output path.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
      return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def split_symbols(raw: str) -> List[str]:
    return [item.strip() for item in raw.split(",") if item.strip()]


def feature_file(feature_root: Path, inst_id: str) -> Path:
    csv_path = feature_root / f"okx_inst_id={inst_id}" / "data.csv"
    if not csv_path.exists():
        raise FileNotFoundError(f"Missing redesigned target table for {inst_id}: {csv_path}")
    return csv_path


def iter_csv_rows(path: Path) -> Iterable[Dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        yield from csv.DictReader(handle)


def tail_rows(path: Path, limit: int) -> List[Dict[str, str]]:
    keep: Deque[Dict[str, str]] = deque(maxlen=max(limit, 1))
    for row in iter_csv_rows(path):
        keep.append(row)
    return list(keep)


def to_float(row: Dict[str, str], key: str) -> Optional[float]:
    raw = row.get(key)
    if raw is None or raw == "":
        return None
    try:
        value = float(raw)
    except ValueError:
        return None
    if not math.isfinite(value):
        return None
    return value


def median(values: List[float], fallback: float = 0.0) -> float:
    if not values:
        return fallback
    ordered = sorted(values)
    mid = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[mid]
    return (ordered[mid - 1] + ordered[mid]) / 2


def percentile(values: List[float], q: float, fallback: float) -> float:
    if not values:
        return fallback
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * q)))
    return ordered[idx]


def summarize_symbol(rows: List[Dict[str, str]]) -> Dict[str, float]:
    current_vol = [v for row in rows if (v := to_float(row, "okx_rv_60m")) is not None]
    future_vol = [v for row in rows if (v := to_float(row, "target_realized_vol_1h")) is not None]
    breakout_span = [v for row in rows if (v := to_float(row, "okx_range_pct")) is not None]
    return {
        "currentVolMedian": median(current_vol, 0.001),
        "futureVolMedian": median(future_vol, 0.001),
        "futureVolP70": percentile(future_vol, 0.70, 0.001),
        "futureVolP80": percentile(future_vol, 0.80, 0.001),
        "futureVolP90": percentile(future_vol, 0.90, 0.001),
        "rangePctMedian": median(breakout_span, 0.001),
    }


def mean_dict(stats: List[Dict[str, float]]) -> Dict[str, float]:
    keys = stats[0].keys()
    return {
        key: sum(item[key] for item in stats) / len(stats)
        for key in keys
    }


def generate_candidates(stats: Dict[str, float]) -> List[Dict[str, Any]]:
    current_vol = max(stats["currentVolMedian"], 1e-6)
    vol_thresholds = [
        max(1.05, stats["futureVolP70"] / current_vol),
        max(1.10, stats["futureVolP80"] / current_vol),
        max(1.15, stats["futureVolP90"] / current_vol),
    ]
    breakout_sets = [
        (12, 6),
        (20, 10),
        (30, 15),
    ]

    candidates: List[Dict[str, Any]] = []
    idx = 1
    for vol_trigger in vol_thresholds:
        for breakout_period, breakout_exit in breakout_sets:
            candidates.append(
                {
                    "strategyId": f"STC_SEED_VB_{idx}",
                    "strategyName": f"seed_vol_breakout_{breakout_period}_{breakout_exit}_{vol_trigger:.2f}",
                    "strategy": "volBreakout",
                    "params": {
                        "allowShort": False,
                        "breakoutPeriod": breakout_period,
                        "breakoutExitPeriod": breakout_exit,
                        "volWindowBars": 60,
                        "volBaselineBars": 240,
                        "volTriggerRatio": round(vol_trigger, 4),
                    },
                }
            )
            idx += 1
    return candidates


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    base_path = resolve_path(root, args.base_candidates)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output)
    symbols = split_symbols(args.symbols)

    base_payload = read_json(base_path)
    stats = [summarize_symbol(tail_rows(feature_file(feature_root, symbol), args.tail_rows)) for symbol in symbols]
    aggregate = mean_dict(stats)
    candidates = generate_candidates(aggregate)

    payload = copy.deepcopy(base_payload)
    payload["schemaVersion"] = "strategy_candidates.v1"
    payload["generatedAt"] = utc_iso()
    payload["candidates"] = candidates
    payload["stageCSeedFamily"] = {
        "schemaVersion": "stage_c_seed_family.v1",
        "generatedAt": utc_iso(),
        "family": "vol_gated_breakout_seed",
        "target": "target_realized_vol_1h",
        "mapping": "gating_target",
        "symbols": symbols,
        "aggregateStats": aggregate,
        "candidateCount": len(candidates),
    }
    write_json(output_path, payload)
    print(json.dumps({"output": str(output_path), "candidateCount": len(candidates)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
