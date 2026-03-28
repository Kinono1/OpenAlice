#!/usr/bin/env python3
"""Generate one low-complexity Round 4 candidate pack from redesigned target tables."""

from __future__ import annotations

import argparse
import copy
import csv
import json
import math
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, Iterable, List, Optional


DEFAULT_BASE = "docs/research/strategy_candidates.v1.json"
DEFAULT_FEATURE_ROOT = "data/research/strategy/analysis/stage_c/target_tables"

MAPPING_CHOICES = ("no_trade", "breakout", "trend")
MAPPING_META = {
    "no_trade": {
        "variant": "vol_as_no_trade_filter",
        "strategy": "volNoTradeFilter",
        "doc_slug": "no_trade_filter",
    },
    "breakout": {
        "variant": "vol_as_breakout_enable_flag",
        "strategy": "volBreakout",
        "doc_slug": "breakout_enable_flag",
    },
    "trend": {
        "variant": "vol_as_trend_enable_flag",
        "strategy": "volTrend",
        "doc_slug": "trend_enable_flag",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate one Stage-C Round 4 candidate pack."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--base-candidates", default=DEFAULT_BASE, help="Base strategy candidate template.")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="Root of redesigned target tables.")
    parser.add_argument("--mapping", choices=MAPPING_CHOICES, required=True, help="Round 4 mapping to materialize.")
    parser.add_argument("--symbols", default="BTC-USDT,ETH-USDT,SOL-USDT", help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=4000, help="Rows to sample from each target table tail.")
    parser.add_argument("--output", default="", help="Output candidate path.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def default_output_path(root: Path, mapping: str) -> Path:
    slug = MAPPING_META[mapping]["doc_slug"]
    return root / "docs" / "research" / f"stage_c_round4_candidates.{slug}.v1.json"


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
    range_pct = [v for row in rows if (v := to_float(row, "okx_range_pct")) is not None]
    abs_return = [abs(v) for row in rows if (v := to_float(row, "target_abs_return_1h")) is not None]
    return {
        "currentVolMedian": median(current_vol, 0.001),
        "futureVolMedian": median(future_vol, 0.001),
        "futureVolP70": percentile(future_vol, 0.70, 0.001),
        "futureVolP80": percentile(future_vol, 0.80, 0.001),
        "futureVolP90": percentile(future_vol, 0.90, 0.001),
        "rangePctMedian": median(range_pct, 0.001),
        "absReturnMedian": median(abs_return, 0.001),
    }


def mean_dict(stats: List[Dict[str, float]]) -> Dict[str, float]:
    keys = stats[0].keys()
    return {key: sum(item[key] for item in stats) / len(stats) for key in keys}


def trigger_ratios(stats: Dict[str, float]) -> List[float]:
    current_vol = max(stats["currentVolMedian"], 1e-6)
    raw = [
        max(1.02, stats["futureVolP70"] / current_vol),
        max(1.05, stats["futureVolP80"] / current_vol),
        max(1.08, stats["futureVolP90"] / current_vol),
    ]
    return [round(value, 4) for value in raw]


def generate_candidates(mapping: str, stats: Dict[str, float]) -> List[Dict[str, Any]]:
    ratios = trigger_ratios(stats)
    if mapping == "no_trade":
        windows = [(12, 48), (18, 60), (24, 72)]
        return [
            {
                "strategyId": f"STC_R4_NTF_{idx}",
                "strategyName": f"round4_vol_filter_{window}_{baseline}_{ratio:.2f}",
                "strategy": "volNoTradeFilter",
                "params": {
                    "allowShort": False,
                    "volWindowBars": window,
                    "volBaselineBars": baseline,
                    "volTriggerRatio": ratio,
                },
            }
            for idx, ((window, baseline), ratio) in enumerate(zip(windows, ratios), start=1)
        ]

    if mapping == "breakout":
        periods = [(12, 6), (20, 10), (28, 14)]
        cooldown = [0, 2, 4]
        return [
            {
                "strategyId": f"STC_R4_VB_{idx}",
                "strategyName": f"round4_vol_breakout_{breakout}_{exit}_{ratio:.2f}",
                "strategy": "volBreakout",
                "params": {
                    "allowShort": False,
                    "breakoutPeriod": breakout,
                    "breakoutExitPeriod": exit,
                    "volWindowBars": 24,
                    "volBaselineBars": 72,
                    "volTriggerRatio": ratio,
                    "volCooldownBars": cooldown[idx - 1],
                },
            }
            for idx, ((breakout, exit), ratio) in enumerate(zip(periods, ratios), start=1)
        ]

    periods = [(10, 35), (14, 50), (18, 70)]
    return [
        {
            "strategyId": f"STC_R4_VT_{idx}",
            "strategyName": f"round4_vol_trend_{fast}_{slow}_{ratio:.2f}",
            "strategy": "volTrend",
            "params": {
                "allowShort": False,
                "trendFastPeriod": fast,
                "trendSlowPeriod": slow,
                "volWindowBars": 24,
                "volBaselineBars": 72,
                "volTriggerRatio": ratio,
            },
        }
        for idx, ((fast, slow), ratio) in enumerate(zip(periods, ratios), start=1)
    ]


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    base_path = resolve_path(root, args.base_candidates)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output) if args.output else default_output_path(root, args.mapping)
    symbols = split_symbols(args.symbols)

    base_payload = read_json(base_path)
    symbol_stats = [summarize_symbol(tail_rows(feature_file(feature_root, symbol), args.tail_rows)) for symbol in symbols]
    aggregate = mean_dict(symbol_stats)
    candidates = generate_candidates(args.mapping, aggregate)
    meta = MAPPING_META[args.mapping]

    payload = copy.deepcopy(base_payload)
    payload["schemaVersion"] = "strategy_candidates.v1"
    payload["generatedAt"] = utc_iso()
    payload["candidates"] = candidates
    payload["stageCRound4Mapping"] = {
        "schemaVersion": "stage_c_round4_mapping.v1",
        "generatedAt": utc_iso(),
        "mapping": meta["variant"],
        "mappingKey": args.mapping,
        "target": "target_realized_vol_1h",
        "targetRole": "gating_target",
        "symbols": symbols,
        "aggregateStats": aggregate,
        "candidateCount": len(candidates),
        "strategy": meta["strategy"],
    }
    write_json(output_path, payload)
    print(json.dumps({"output": str(output_path), "candidateCount": len(candidates), "mapping": args.mapping}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
