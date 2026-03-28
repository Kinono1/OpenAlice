#!/usr/bin/env python3
"""Generate Stage-C candidate set v2 from CORE7 feature tables."""

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
DEFAULT_FEATURE_ROOT = "data/market/core7_feature_base_1m"
DEFAULT_OUTPUT = "docs/research/stage_c_strategy_candidates.v1.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate Stage-C strategy_candidates.v1 from CORE7 feature tables."
    )
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--base-candidates", default=DEFAULT_BASE, help="Base strategy_candidates.v1 template.")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="CORE7 feature root.")
    parser.add_argument("--symbols", default="BTC-USDT,ETH-USDT,SOL-USDT", help="Comma-separated OKX instIds.")
    parser.add_argument("--tail-rows", type=int, default=12000, help="Rows to sample from the tail of each feature table.")
    parser.add_argument(
        "--profile",
        choices=("v1", "v2"),
        default="v1",
        help="Candidate profile. v1 reproduces the original Sprint 1 families; v2 applies the Sprint 1 re-scope.",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output path for generated candidates.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    value = Path(raw).expanduser()
    return value if value.is_absolute() else (root / value).resolve()


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
    zst = feature_root / f"okx_inst_id={inst_id}" / "data.csv.zst"
    if zst.exists():
        return zst
    csv_path = feature_root / f"okx_inst_id={inst_id}" / "data.csv"
    if csv_path.exists():
        return csv_path
    raise FileNotFoundError(f"Missing feature table for {inst_id}")


def iter_csv_rows(path: Path) -> Iterable[Dict[str, str]]:
    if path.suffix == ".zst":
        proc = subprocess.Popen(
            ["zstd", "-q", "-d", "-c", str(path)],
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )
        assert proc.stdout is not None
        try:
            yield from csv.DictReader(proc.stdout)
        finally:
            proc.stdout.close()
            proc.wait()
    else:
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


def mean(values: List[float], fallback: float = 0.0) -> float:
    return sum(values) / len(values) if values else fallback


def stddev(values: List[float], fallback: float = 0.0) -> float:
    if len(values) < 2:
        return fallback
    mu = mean(values)
    variance = sum((value - mu) ** 2 for value in values) / len(values)
    return math.sqrt(variance)


def clamp_int(value: int, lower: int, upper: int) -> int:
    return max(lower, min(upper, value))


def build_symbol_stats(rows: List[Dict[str, str]]) -> Dict[str, float]:
    spread = [abs(v) for row in rows if (v := to_float(row, "spread_spot_pct")) is not None]
    basis = [abs(v) for row in rows if (v := to_float(row, "okx_basis_pct")) is not None]
    volume_z = [abs(v) for row in rows if (v := to_float(row, "okx_volume_z20")) is not None]
    rv = [v for row in rows if (v := to_float(row, "okx_rv_5m")) is not None]
    sma_gap = [
        abs(a - b)
        for row in rows
        if (a := to_float(row, "okx_close_vs_sma_5")) is not None
        and (b := to_float(row, "okx_close_vs_sma_20")) is not None
    ]
    label_bias = [v for row in rows if (v := to_float(row, "label_dir_fwd_5m")) is not None]
    return {
        "spreadMedian": median(spread, 0.001),
        "basisStd": stddev(basis, 0.001),
        "volumeZMedian": median(volume_z, 0.5),
        "rvMedian": median(rv, 0.002),
        "smaGapMedian": median(sma_gap, 0.001),
        "labelLongBias": mean(label_bias, 0.5),
    }


def aggregate_stats(symbol_stats: List[Dict[str, float]]) -> Dict[str, float]:
    return {
        key: mean([entry[key] for entry in symbol_stats], fallback=0.0)
        for key in symbol_stats[0].keys()
    }


def generate_candidates(stats: Dict[str, float]) -> List[Dict[str, Any]]:
    breakout_anchor = clamp_int(int(round(18 + stats["spreadMedian"] * 10000)), 12, 48)
    exit_anchor = clamp_int(max(6, breakout_anchor // 2), 6, 24)

    trend_fast_anchor = clamp_int(int(round(12 + stats["volumeZMedian"] * 4)), 10, 32)
    trend_slow_anchor = clamp_int(trend_fast_anchor * 3 + int(round(stats["rvMedian"] * 1000)), 36, 120)

    rsi_anchor = clamp_int(int(round(14 + stats["basisStd"] * 500)), 10, 24)
    oversold_anchor = clamp_int(int(round(28 - stats["labelLongBias"] * 6)), 20, 35)
    overbought_anchor = clamp_int(int(round(72 + (0.5 - stats["labelLongBias"]) * 6)), 65, 80)

    ensemble_threshold_anchor = max(0.22, min(0.55, 0.28 + stats["smaGapMedian"] * 8))
    trend_weight_bias = max(0.8, min(1.8, 1.0 + stats["labelLongBias"] - 0.5))
    mr_weight_bias = max(0.8, min(1.8, 1.0 + stats["spreadMedian"] * 120))
    breakout_weight_bias = max(0.8, min(1.8, 1.0 + stats["basisStd"] * 400))

    candidates: List[Dict[str, Any]] = []

    for idx, offset in enumerate([-6, -3, 0, 3, 6], start=1):
        period = clamp_int(breakout_anchor + offset, 10, 60)
        exit_period = clamp_int(exit_anchor + offset // 2, 5, 30)
        candidates.append(
            {
                "strategyId": f"STC_BASIS_C{idx}",
                "strategyName": f"stagec_basis_breakout_{period}_{exit_period}",
                "strategy": "breakout",
                "params": {
                    "breakoutPeriod": period,
                    "breakoutExitPeriod": exit_period,
                    "allowShort": True,
                },
                "family": "cross_exchange_basis_spread_regime",
                "hypothesis": "Basis and spread compression/expansion signals can identify breakout regimes more cleanly than the frozen baseline.",
            }
        )

    for idx, (fast_off, slow_off) in enumerate([(-4, -8), (-2, -4), (0, 0), (2, 8), (4, 12)], start=1):
        fast = clamp_int(trend_fast_anchor + fast_off, 8, 36)
        slow = clamp_int(trend_slow_anchor + slow_off, fast + 8, 140)
        candidates.append(
            {
                "strategyId": f"STC_VOL_C{idx}",
                "strategyName": f"stagec_volume_trend_{fast}_{slow}",
                "strategy": "trend",
                "params": {
                    "trendFastPeriod": fast,
                    "trendSlowPeriod": slow,
                    "allowShort": True,
                },
                "family": "multi_timeframe_volume_volatility_regime",
                "hypothesis": "Volume/volatility-regime cues can improve trend timing and reduce unstable high-vol entries.",
            }
        )

    weight_variants = [
        (trend_weight_bias + 0.2, mr_weight_bias, breakout_weight_bias - 0.1, -0.03),
        (trend_weight_bias, mr_weight_bias + 0.2, breakout_weight_bias, -0.01),
        (trend_weight_bias, mr_weight_bias, breakout_weight_bias, 0.0),
        (trend_weight_bias - 0.1, mr_weight_bias, breakout_weight_bias + 0.2, 0.02),
        (trend_weight_bias + 0.1, mr_weight_bias - 0.1, breakout_weight_bias + 0.1, 0.04),
    ]
    for idx, (tw, mw, bw, threshold_delta) in enumerate(weight_variants, start=1):
        threshold = max(0.18, min(0.65, ensemble_threshold_anchor + threshold_delta))
        candidates.append(
            {
                "strategyId": f"STC_ADAPT_C{idx}",
                "strategyName": f"stagec_adaptive_ensemble_{idx}",
                "strategy": "ensemble",
                "params": {
                    "allowShort": True,
                    "ensembleThreshold": round(threshold, 4),
                    "ensembleWeights": {
                        "trend": round(max(0.5, tw), 4),
                        "meanReversion": round(max(0.5, mw), 4),
                        "breakout": round(max(0.5, bw), 4),
                    },
                    "rsiPeriod": rsi_anchor,
                    "rsiOversold": oversold_anchor,
                    "rsiOverbought": overbought_anchor,
                    "bbPeriod": 20,
                    "bbStdDev": 2,
                    "trendFastPeriod": trend_fast_anchor,
                    "trendSlowPeriod": trend_slow_anchor,
                    "breakoutPeriod": breakout_anchor,
                    "breakoutExitPeriod": exit_anchor,
                },
                "family": "composite_momentum_mean_reversion_adaptive",
                "hypothesis": "Adaptive ensemble weighting across momentum, breakout, and reversion signals can outperform single-family candidates.",
            }
        )

    return candidates


def generate_candidates_v2(stats: Dict[str, float]) -> List[Dict[str, Any]]:
    breakout_anchor = clamp_int(int(round(24 + stats["spreadMedian"] * 8000)), 18, 42)
    exit_anchor = clamp_int(max(8, breakout_anchor // 2), 8, 22)

    trend_fast_anchor = clamp_int(int(round(18 + stats["volumeZMedian"] * 3)), 14, 30)
    trend_slow_anchor = clamp_int(int(round(84 + stats["rvMedian"] * 2000)), trend_fast_anchor + 20, 144)

    rsi_anchor = clamp_int(int(round(12 + stats["basisStd"] * 400)), 10, 20)
    oversold_anchor = clamp_int(int(round(32 - stats["labelLongBias"] * 4)), 24, 35)
    overbought_anchor = clamp_int(int(round(68 + (0.5 - stats["labelLongBias"]) * 4)), 65, 76)
    ensemble_threshold_anchor = max(0.42, min(0.68, 0.48 + stats["smaGapMedian"] * 10))

    candidates: List[Dict[str, Any]] = []

    for idx, offset in enumerate([-6, -3, 0, 3, 6], start=1):
        period = clamp_int(breakout_anchor + offset, 16, 48)
        exit_period = clamp_int(exit_anchor + offset // 2, 8, 24)
        candidates.append(
            {
                "strategyId": f"STC2_BASIS_C{idx}",
                "strategyName": f"stagec2_basis_compression_breakout_{period}_{exit_period}",
                "strategy": "breakout",
                "params": {
                    "breakoutPeriod": period,
                    "breakoutExitPeriod": exit_period,
                    "allowShort": False,
                },
                "family": "compressed_basis_breakout_long_only",
                "hypothesis": "Sprint 1 showed modest PBO improvement but universal DSR collapse; v2 keeps the cleaner basis/breakout direction while removing short-side churn and lengthening confirmation windows.",
                "failureEvidence": "Sprint 1: meanPbo improved on BTC (-0.0143) and SOL (-0.0571) but meanDsrProbability deteriorated on all three assets while fdrQ stayed ~1.0.",
            }
        )

    for idx, (fast_off, slow_off) in enumerate([(-4, -12), (-2, -6), (0, 0), (2, 10), (4, 18)], start=1):
        fast = clamp_int(trend_fast_anchor + fast_off, 12, 32)
        slow = clamp_int(trend_slow_anchor + slow_off, fast + 16, 160)
        candidates.append(
            {
                "strategyId": f"STC2_TREND_C{idx}",
                "strategyName": f"stagec2_vol_confirmed_trend_{fast}_{slow}",
                "strategy": "trend",
                "params": {
                    "trendFastPeriod": fast,
                    "trendSlowPeriod": slow,
                    "allowShort": False,
                },
                "family": "volume_confirmed_trend_long_only",
                "hypothesis": "Sprint 1 trend families likely lagged regime shifts; v2 shifts to slower long-only confirmation windows to reduce noisy reversals and improve DSR before chasing FDR gains.",
                "failureEvidence": "Sprint 1: no asset crossed fdrQ < 0.5 and meanDsrProbability worsened across BTC/ETH/SOL despite added volume/volatility regime features.",
            }
        )

    weight_variants = [
        (1.8, 0.6, 1.0, -0.04),
        (1.7, 0.7, 1.0, -0.02),
        (1.6, 0.8, 1.0, 0.0),
        (1.5, 0.8, 1.1, 0.03),
        (1.4, 0.9, 1.1, 0.06),
    ]
    for idx, (tw, mw, bw, threshold_delta) in enumerate(weight_variants, start=1):
        threshold = max(0.4, min(0.75, ensemble_threshold_anchor + threshold_delta))
        candidates.append(
            {
                "strategyId": f"STC2_ENSEMBLE_C{idx}",
                "strategyName": f"stagec2_conservative_ensemble_{idx}",
                "strategy": "ensemble",
                "params": {
                    "allowShort": False,
                    "ensembleThreshold": round(threshold, 4),
                    "ensembleWeights": {
                        "trend": round(tw, 4),
                        "meanReversion": round(mw, 4),
                        "breakout": round(bw, 4),
                    },
                    "rsiPeriod": rsi_anchor,
                    "rsiOversold": oversold_anchor,
                    "rsiOverbought": overbought_anchor,
                    "bbPeriod": 20,
                    "bbStdDev": 2,
                    "trendFastPeriod": trend_fast_anchor,
                    "trendSlowPeriod": trend_slow_anchor,
                    "breakoutPeriod": breakout_anchor,
                    "breakoutExitPeriod": exit_anchor,
                },
                "family": "conservative_trend_dominant_ensemble",
                "hypothesis": "Sprint 1 adaptive ensembles were too permissive; v2 raises thresholds, removes short bias, and forces trend-dominant voting so the ensemble only fires in higher-conviction regimes.",
                "failureEvidence": "Sprint 1: adaptive ensembles added complexity without improving fdrQ, while meanDsrProbability fell by 0.15-0.17 vs the frozen baseline.",
            }
        )

    return candidates


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    base_path = resolve_path(root, args.base_candidates)
    feature_root = resolve_path(root, args.feature_root)
    output_path = resolve_path(root, args.output)
    symbols = split_symbols(args.symbols)

    base_payload = read_json(base_path)
    symbol_summaries: List[Dict[str, Any]] = []
    stats_accumulator: List[Dict[str, float]] = []

    for symbol in symbols:
        path = feature_file(feature_root, symbol)
        rows = tail_rows(path, args.tail_rows)
        if not rows:
            raise ValueError(f"No rows found for {symbol}: {path}")
        stats = build_symbol_stats(rows)
        stats_accumulator.append(stats)
        symbol_summaries.append(
            {
                "instId": symbol,
                "path": str(path),
                "sampleRows": len(rows),
                "stats": stats,
            }
        )

    aggregate = aggregate_stats(stats_accumulator)
    if args.profile == "v2":
        candidates = generate_candidates_v2(aggregate)
    else:
        candidates = generate_candidates(aggregate)

    payload = copy.deepcopy(base_payload)
    payload["schemaVersion"] = "strategy_candidates.v1"
    payload["generatedAt"] = utc_iso()
    payload["candidates"] = [
        {
            "strategyId": item["strategyId"],
            "strategyName": item["strategyName"],
            "strategy": item["strategy"],
            "params": item["params"],
        }
        for item in candidates
    ]
    payload["stageCCompile"] = {
        "schemaVersion": "stage_c_candidate_generator.v1",
        "generatedAt": utc_iso(),
        "profile": args.profile,
        "sourceFeatureRoot": str(feature_root),
        "symbols": symbol_summaries,
        "aggregateStats": aggregate,
        "families": (
            [
                {
                    "family": "compressed_basis_breakout_long_only",
                    "hypothesis": "Keep the only Sprint 1 direction that improved PBO, but make it long-only and slower so DSR does not collapse immediately.",
                    "candidateCount": 5,
                },
                {
                    "family": "volume_confirmed_trend_long_only",
                    "hypothesis": "Use slower trend confirmation windows and remove short-side churn before expanding the candidate pool again.",
                    "candidateCount": 5,
                },
                {
                    "family": "conservative_trend_dominant_ensemble",
                    "hypothesis": "Raise ensemble thresholds and force trend-dominant weighting to test whether weaker adaptive variants were the main source of DSR collapse.",
                    "candidateCount": 5,
                },
            ]
            if args.profile == "v2"
            else [
                {
                    "family": "cross_exchange_basis_spread_regime",
                    "hypothesis": "Basis and spread compression/expansion signals can identify breakout regimes more cleanly than the frozen baseline.",
                    "candidateCount": 5,
                },
                {
                    "family": "multi_timeframe_volume_volatility_regime",
                    "hypothesis": "Volume/volatility-regime cues can improve trend timing and reduce unstable high-vol entries.",
                    "candidateCount": 5,
                },
                {
                    "family": "composite_momentum_mean_reversion_adaptive",
                    "hypothesis": "Adaptive ensemble weighting across momentum, breakout, and reversion signals can outperform single-family candidates.",
                    "candidateCount": 5,
                },
            ]
        ),
        "outputCandidateCount": len(candidates),
    }

    write_json(output_path, payload)
    print(
        json.dumps(
            {
                "output": str(output_path),
                "candidateCount": len(candidates),
                "symbols": symbols,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
