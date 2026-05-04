#!/usr/bin/env python3
"""Wait for download jobs, clean all data, then retrain ensemble models.

Pipeline:
1) Wait until background download tasks finish (optional).
2) Normalize/clean OKX + Binance public 1d candles into a new training folder.
3) Retrain ML ensemble per symbol and export metrics leaderboard.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import importlib.util
import json
import math
import re
import subprocess
import sys
import zipfile
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

SOURCE_PRIORITY = {
    "okx": 3,
    "binance_um": 2,
    "binance_spot": 1,
}
SOURCE_ALIASES: Dict[str, Tuple[str, ...]] = {
    "all": ("okx", "binance_um", "binance_spot"),
    "binance": ("binance_um", "binance_spot"),
    "binance_all": ("binance_um", "binance_spot"),
    "binance_public": ("binance_um", "binance_spot"),
    "um": ("binance_um",),
    "futures": ("binance_um",),
    "perp": ("binance_um",),
    "spot": ("binance_spot",),
}


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def log(msg: str) -> None:
    print(f"[{utc_now()}] {msg}", flush=True)


def parse_bool(raw: str) -> bool:
    v = raw.strip().lower()
    if v in {"1", "true", "yes", "y", "on"}:
        return True
    if v in {"0", "false", "no", "n", "off"}:
        return False
    raise ValueError(f"invalid boolean: {raw}")


def normalize_source_token(raw: str) -> str:
    return raw.strip().lower().replace("-", "_")


def parse_source_filter_csv(raw: str, flag_name: str) -> List[str]:
    tokens = [normalize_source_token(x) for x in str(raw).split(",") if x.strip()]
    if not tokens:
        return []

    expanded: Set[str] = set()
    invalid: List[str] = []
    for token in tokens:
        if token in SOURCE_PRIORITY:
            expanded.add(token)
            continue
        alias_targets = SOURCE_ALIASES.get(token)
        if alias_targets:
            expanded.update(alias_targets)
            continue
        invalid.append(token)

    if invalid:
        valid_tokens = sorted(set(SOURCE_PRIORITY.keys()) | set(SOURCE_ALIASES.keys()))
        raise ValueError(
            f"invalid {flag_name} value(s): {sorted(set(invalid))}; valid options: {valid_tokens}"
        )
    return sorted(expanded)


def parse_args(argv: List[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Wait for downloads, clean data, and retrain ML ensemble."
    )
    parser.add_argument(
        "--wait-downloads",
        default="true",
        help="Wait until known download jobs finish (true/false). Default: true",
    )
    parser.add_argument("--poll-sec", type=int, default=60)
    parser.add_argument(
        "--timeframe",
        default="1d",
        help="Target timeframe, currently expected 1d for full pipeline.",
    )
    parser.add_argument("--quote", default="USDT")
    parser.add_argument(
        "--output-root",
        default="data/training-data/full-v1",
        help="Output root for cleaned data + retrain results.",
    )
    parser.add_argument("--okx-dir", default="data/market/okx")
    parser.add_argument(
        "--binance-um-dir", default="data/market/binance-public/um-all-usdt-1d"
    )
    parser.add_argument(
        "--binance-spot-dir", default="data/market/binance-public/spot-all-usdt-1d"
    )
    parser.add_argument("--min-bars", type=int, default=220)
    parser.add_argument("--max-symbols", type=int, default=0)
    parser.add_argument(
        "--max-symbols-per-source",
        type=int,
        default=0,
        help=(
            "Optional cap per source bucket before global --max-symbols clipping. "
            "Set 0 to disable."
        ),
    )
    parser.add_argument(
        "--symbol-sort-mode",
        default="alpha",
        help="Order symbols before --max-symbols clipping: alpha|bars_desc.",
    )
    parser.add_argument(
        "--symbol-allowlist",
        default="",
        help=(
            "Comma-separated symbols to keep for training. Supports base symbol "
            "(e.g. BTC/USDT) or fully qualified symbol key "
            "(e.g. BTC/USDT::binance_um)."
        ),
    )
    parser.add_argument(
        "--include-sources",
        default="",
        help=(
            "Comma-separated source buckets to include before training. "
            "Supports canonical buckets (okx,binance_um,binance_spot) and aliases "
            "(binance,um,spot,all)."
        ),
    )
    parser.add_argument(
        "--exclude-sources",
        default="",
        help=(
            "Comma-separated source buckets to exclude before training. "
            "Applied after --include-sources."
        ),
    )
    parser.add_argument("--horizon-bars", type=int, default=1)
    parser.add_argument("--train-ratio", type=float, default=0.8)
    parser.add_argument("--min-confidence", type=float, default=0.55)
    parser.add_argument("--min-expected-return-pct", type=float, default=0.03)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--include-models",
        default="xgboost,lightgbm,catboost,randomForest,ridge,pytorch",
        help="Comma-separated model list for ml_ensemble_v1 (supports pytorch).",
    )
    parser.add_argument(
        "--selection-objective",
        default="accuracyLift",
        help="Objective metric used for model selection and leaderboard ranking.",
    )
    parser.add_argument(
        "--selection-mode",
        default="auto",
        help="Objective mode: auto|max|min (auto=min for maePct/rmsePct, else max).",
    )
    parser.add_argument(
        "--ensemble-mode",
        default="stacking",
        help="Ensemble mode passed to ml_ensemble_v1: stacking|regime_moe.",
    )
    parser.add_argument(
        "--regime-count",
        type=int,
        default=3,
        help="Regime count for regime_moe mode (3 or 4).",
    )
    parser.add_argument(
        "--regime-method",
        default="rule",
        help="Regime detector method: rule|kmeans.",
    )
    parser.add_argument(
        "--regime-kmeans-zclip",
        type=float,
        default=8.0,
        help="KMeans regime z-space clipping cap.",
    )
    parser.add_argument(
        "--regime-kmeans-scale-floor",
        type=float,
        default=1e-6,
        help="KMeans regime scale floor to avoid divide-by-zero.",
    )
    parser.add_argument(
        "--regime-kmeans-min-cluster-balance",
        type=float,
        default=0.10,
        help="KMeans minimum cluster balance ratio (min_cluster/max_cluster).",
    )
    parser.add_argument(
        "--regime-kmeans-balance-threshold-mode",
        default="static",
        help="Cluster balance threshold mode: static|adaptive.",
    )
    parser.add_argument(
        "--regime-labeling-mode",
        default="original",
        help="Regime labeling mode for detector: original|strict.",
    )
    parser.add_argument(
        "--regime-kmeans-diagnostics-level",
        default="basic",
        help="KMeans diagnostics detail level: basic|extended.",
    )
    parser.add_argument(
        "--hybrid-weight-accuracy-lift",
        type=float,
        default=0.20,
        help="Hybrid score weight for accuracyLift.",
    )
    parser.add_argument(
        "--hybrid-weight-robust-cost-aware-utility",
        type=float,
        default=0.30,
        help="Hybrid score weight for robustCostAwareUtility.",
    )
    parser.add_argument(
        "--hybrid-weight-net-sharpe-after-cost",
        type=float,
        default=0.20,
        help="Hybrid score weight for netSharpeAfterCost.",
    )
    parser.add_argument(
        "--hybrid-weight-rmse-pct",
        type=float,
        default=0.10,
        help="Hybrid score weight for rmsePct (negative metric).",
    )
    parser.add_argument(
        "--hybrid-weight-win-rate-after-cost",
        type=float,
        default=0.10,
        help="Hybrid score weight for winRateAfterCost.",
    )
    parser.add_argument(
        "--hybrid-weight-turnover-per-bar",
        type=float,
        default=0.10,
        help="Hybrid score weight for turnoverPerBar (negative metric).",
    )
    parser.add_argument(
        "--oof-min-coverage-soft",
        type=float,
        default=0.60,
        help="OOF soft-fail lower bound.",
    )
    parser.add_argument(
        "--oof-hard-floor",
        type=float,
        default=0.25,
        help="OOF hard-drop floor.",
    )
    parser.add_argument(
        "--soft-fail-max-weight",
        type=float,
        default=0.15,
        help="Max routing weight for soft-fail models.",
    )
    parser.add_argument(
        "--tscv-gap-bars",
        type=int,
        default=2,
        help="Gap bars for expanding OOF TimeSeries split.",
    )
    parser.add_argument(
        "--test-lock-ratio",
        type=float,
        default=0.10,
        help="Locked test ratio at tail; excluded from model selection.",
    )
    parser.add_argument(
        "--calibration-method",
        default="sigmoid",
        help="Probability calibration method: none|sigmoid|isotonic.",
    )
    parser.add_argument(
        "--risk-clamp-on-soft-stat-warn",
        type=float,
        default=0.35,
        help="Max allocation when soft statistical gate warnings trigger.",
    )
    parser.add_argument(
        "--regime-schema-version",
        default="v1_rule_3regime",
        help="Version tag written into clean CSV regime columns.",
    )
    parser.add_argument(
        "--labeling-mode",
        default="next_return_sign",
        help="Labeling mode passed to ML script: next_return_sign|triple_barrier.",
    )
    parser.add_argument(
        "--barrier-tp-atr",
        type=float,
        default=1.5,
        help="Triple-barrier TP width in ATR multiples.",
    )
    parser.add_argument(
        "--barrier-sl-atr",
        type=float,
        default=1.0,
        help="Triple-barrier SL width in ATR multiples.",
    )
    parser.add_argument(
        "--barrier-max-horizon-bars",
        type=int,
        default=6,
        help="Maximum holding bars for triple-barrier labeling.",
    )
    parser.add_argument(
        "--cost-fee-rate",
        type=float,
        default=0.0006,
        help="Per-turnover fee rate for cost-aware utility metric.",
    )
    parser.add_argument(
        "--cost-slippage-bps",
        type=float,
        default=8.0,
        help="Per-turnover slippage in bps for cost-aware utility metric.",
    )
    parser.add_argument(
        "--cost-latency-bars",
        type=int,
        default=1,
        help="Execution latency bars for cost-aware utility metric.",
    )
    parser.add_argument(
        "--robust-per-bar-clip",
        type=float,
        default=0.25,
        help="Per-bar return clip used by robust cost-aware utility metric.",
    )
    parser.add_argument(
        "--conformal-alpha",
        type=float,
        default=0.10,
        help="Target miscoverage for conformal intervals (alpha, e.g. 0.10).",
    )
    parser.add_argument(
        "--conformal-min-regime-samples",
        type=int,
        default=25,
        help="Minimum validation samples per regime before using regime-specific conformal quantile.",
    )
    parser.add_argument(
        "--conformal-shift-weight-clip-min",
        type=float,
        default=0.25,
        help="Lower clip for regime shift importance weights.",
    )
    parser.add_argument(
        "--conformal-shift-weight-clip-max",
        type=float,
        default=4.0,
        help="Upper clip for regime shift importance weights.",
    )
    parser.add_argument(
        "--decision-use-conformal-lower-bound",
        default="false",
        help="Use conformal lower bound of expected return for buy/sell/hold decision thresholds (true/false).",
    )
    parser.add_argument(
        "--model-safety-filter-enabled",
        default="true",
        help="Enable validation-metric safety filter before model routing (true/false).",
    )
    parser.add_argument(
        "--model-safety-min-robust-cost-aware-utility",
        type=float,
        default=-0.08,
        help="Validation floor for robustCostAwareUtility; below this model is filtered.",
    )
    parser.add_argument(
        "--model-safety-min-cost-aware-utility",
        type=float,
        default=-0.12,
        help="Validation floor for costAwareUtility; below this model is filtered.",
    )
    parser.add_argument(
        "--model-safety-min-net-return-pct-after-cost",
        type=float,
        default=-45.0,
        help="Validation floor for netReturnPctAfterCost; below this model is filtered.",
    )
    parser.add_argument(
        "--model-safety-max-turnover-per-bar",
        type=float,
        default=1.0,
        help=(
            "Validation cap for turnoverPerBar; above this model is filtered. "
            "Set >=1.0 to effectively disable this cap."
        ),
    )
    parser.add_argument(
        "--nas-enabled",
        default="false",
        help="Enable NAS-like hyperparameter search inside ml_ensemble_v1 (true/false).",
    )
    parser.add_argument(
        "--nas-trials",
        type=int,
        default=2,
        help="Maximum candidate trials per base model when NAS is enabled.",
    )
    parser.add_argument(
        "--nas-metric",
        default="costAwareUtility",
        help="NAS objective metric. Default: costAwareUtility.",
    )
    parser.add_argument(
        "--nas-mode",
        default="auto",
        help="NAS objective mode: auto|max|min.",
    )
    parser.add_argument(
        "--delisted-days",
        type=int,
        default=90,
        help="Mark symbol as delisted proxy if last bar older than N days from global max.",
    )
    parser.add_argument(
        "--isolate-sources",
        default="true",
        help="When true, keep source-specific symbols (e.g. BTC/USDT::okx) to avoid cross-venue splicing.",
    )
    parser.add_argument(
        "--partition-mode",
        default="none",
        help="Partition mode for downstream replay analysis: none|exchange|exchange_regime.",
    )
    parser.add_argument(
        "--regime-scheme",
        default="rule_v1",
        help="Regime label scheme for clean outputs: rule_v1|kmeans_v1.",
    )
    parser.add_argument(
        "--partition-manifest-out",
        default="",
        help="Optional explicit output path for partition manifest JSON.",
    )
    # pnpm forwards a leading "--" sentinel to scripts; ignore it for argparse.
    normalized_argv = list(argv)
    while normalized_argv and normalized_argv[0] == "--":
        normalized_argv = normalized_argv[1:]
    return parser.parse_args(normalized_argv)


def safe_float(v: Any) -> Optional[float]:
    try:
        f = float(v)
        if math.isfinite(f):
            return f
    except Exception:
        return None
    return None


def safe_int(v: Any) -> Optional[int]:
    try:
        iv = int(float(v))
        return iv
    except Exception:
        return None


def resolve_selection_mode(metric: str, mode: str) -> str:
    normalized = (mode or "auto").strip().lower()
    if normalized in {"max", "min"}:
        return normalized
    if metric in {"maePct", "rmsePct"}:
        return "min"
    return "max"


def mean(values: List[float]) -> float:
    if not values:
        return 0.0
    return float(sum(values) / len(values))


def std(values: List[float]) -> float:
    if len(values) < 2:
        return 0.0
    m = mean(values)
    var = sum((v - m) ** 2 for v in values) / len(values)
    return float(math.sqrt(max(var, 0.0)))


def quantile(values: List[float], q: float) -> float:
    if not values:
        return 0.0
    v = sorted(values)
    qq = max(0.0, min(1.0, float(q)))
    pos = qq * (len(v) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return float(v[lo])
    w = pos - lo
    return float(v[lo] * (1.0 - w) + v[hi] * w)


def sanitize_regime_feature_pair_series(
    vol_mix: List[float],
    trend: List[float],
    clip_quantile: float = 0.995,
    max_abs_cap: float = 25.0,
) -> Tuple[List[float], List[float]]:
    n = min(len(vol_mix), len(trend))
    if n <= 0:
        return [], []

    clean_vol: List[float] = []
    clean_trend: List[float] = []
    for i in range(n):
        v = float(vol_mix[i])
        t = float(trend[i])
        if not math.isfinite(v):
            v = 0.0
        if not math.isfinite(t):
            t = 0.0
        clean_vol.append(max(0.0, v))
        clean_trend.append(t)

    qq = max(0.90, min(0.999, float(clip_quantile)))
    abs_vol = [abs(v) for v in clean_vol]
    abs_trend = [abs(v) for v in clean_trend]
    cap_hi = max(1e-6, float(max_abs_cap))
    vol_cap = min(cap_hi, max(1e-6, quantile(abs_vol, qq)))
    trend_cap = min(cap_hi, max(1e-6, quantile(abs_trend, qq)))

    out_vol = [min(max(0.0, v), vol_cap) for v in clean_vol]
    out_trend = [min(max(t, -trend_cap), trend_cap) for t in clean_trend]
    return out_vol, out_trend


def ema_series(values: List[float], period: int) -> List[float]:
    if not values:
        return []
    p = max(1, int(period))
    alpha = 2.0 / (p + 1.0)
    out = [float(values[0])]
    for i in range(1, len(values)):
        out.append(float(alpha * values[i] + (1.0 - alpha) * out[-1]))
    return out


def rolling_std(values: List[float], window: int) -> List[float]:
    out: List[float] = []
    w = max(1, int(window))
    for i in range(len(values)):
        start = max(0, i - w + 1)
        out.append(std(values[start : i + 1]))
    return out


def build_rule_regime_labels(rows: List[CandleRow]) -> List[str]:
    if not rows:
        return []
    closes = [float(r.close) for r in rows]
    highs = [float(r.high) for r in rows]
    lows = [float(r.low) for r in rows]
    volumes = [float(r.volume) for r in rows]

    ret = [0.0 for _ in closes]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        ret[i] = closes[i] / prev - 1.0 if prev > 0 else 0.0

    vol20 = rolling_std(ret, 20)
    ema_fast = ema_series(closes, 12)
    ema_slow = ema_series(closes, 48)
    trend = [
        (ema_fast[i] / ema_slow[i] - 1.0) if ema_slow[i] else 0.0
        for i in range(len(closes))
    ]

    tr: List[float] = []
    prev_close = closes[0]
    for i in range(len(closes)):
        high = highs[i]
        low = lows[i]
        close = closes[i]
        tr.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        prev_close = close
    atr14: List[float] = []
    for i in range(len(closes)):
        start = max(0, i - 13)
        atr14.append(mean(tr[start : i + 1]))
    atr14_pct = [
        (atr14[i] / closes[i]) if closes[i] else 0.0 for i in range(len(closes))
    ]

    volume_z20: List[float] = []
    for i in range(len(volumes)):
        start = max(0, i - 19)
        v_slice = volumes[start : i + 1]
        v_mean = mean(v_slice)
        v_std = std(v_slice) + 1e-8
        volume_z20.append((volumes[i] - v_mean) / v_std)

    warmup = min(120, max(20, len(rows) // 3))
    vol_mix_train = [
        max(vol20[i], atr14_pct[i]) for i in range(max(1, warmup), len(rows))
    ]
    abs_trend_train = [abs(trend[i]) for i in range(max(1, warmup), len(rows))]
    vol_thr = quantile(vol_mix_train, 0.65)
    trend_thr = quantile(abs_trend_train, 0.60)

    out: List[str] = []
    for i in range(len(rows)):
        _ = volume_z20[i]  # reserve feature for potential future thresholding
        high_vol = max(vol20[i], atr14_pct[i]) >= vol_thr
        trending = abs(trend[i]) >= trend_thr
        if high_vol and trending:
            out.append("HighVolTrend")
        elif high_vol:
            out.append("HighVolMeanRevert")
        else:
            out.append("LowVolCarry")
    return out


def _compute_regime_feature_series(
    rows: List[CandleRow],
) -> Tuple[List[float], List[float]]:
    if not rows:
        return [], []
    closes = [float(r.close) for r in rows]
    highs = [float(r.high) for r in rows]
    lows = [float(r.low) for r in rows]

    ret = [0.0 for _ in closes]
    for i in range(1, len(closes)):
        prev = closes[i - 1]
        ret[i] = closes[i] / prev - 1.0 if prev > 0 else 0.0

    vol20 = rolling_std(ret, 20)
    ema_fast = ema_series(closes, 12)
    ema_slow = ema_series(closes, 48)
    trend = [
        (ema_fast[i] / ema_slow[i] - 1.0) if ema_slow[i] else 0.0
        for i in range(len(closes))
    ]

    tr: List[float] = []
    prev_close = closes[0]
    for i in range(len(closes)):
        high = highs[i]
        low = lows[i]
        close = closes[i]
        tr.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
        prev_close = close
    atr14: List[float] = []
    for i in range(len(closes)):
        start = max(0, i - 13)
        atr14.append(mean(tr[start : i + 1]))
    atr14_pct = [
        (atr14[i] / closes[i]) if closes[i] else 0.0 for i in range(len(closes))
    ]

    vol_mix = [max(vol20[i], atr14_pct[i]) for i in range(len(closes))]
    return sanitize_regime_feature_pair_series(
        vol_mix,
        trend,
        clip_quantile=0.995,
        max_abs_cap=25.0,
    )


def build_kmeans_regime_labels(
    rows: List[CandleRow],
    k: int = 3,
    iterations: int = 12,
    zclip: float = 8.0,
    scale_floor: float = 1e-6,
    min_cluster_balance: float = 0.10,
    balance_threshold_mode: str = "static",
) -> List[str]:
    if not rows:
        return []
    vol_mix, trend = _compute_regime_feature_series(rows)
    if not vol_mix:
        return ["LowVolCarry" for _ in rows]

    points = [(float(vol_mix[i]), float(trend[i])) for i in range(len(rows))]
    raw_points = [
        p for p in points if math.isfinite(p[0]) and math.isfinite(p[1])
    ]
    if len(raw_points) <= k:
        return build_rule_regime_labels(rows)
    zclip = max(2.0, min(25.0, float(zclip)))
    scale_floor = max(1e-8, min(1.0, float(scale_floor)))
    min_cluster_balance = max(0.01, min(0.90, float(min_cluster_balance)))
    balance_mode = str(balance_threshold_mode or "static").strip().lower()
    if balance_mode not in {"static", "adaptive"}:
        balance_mode = "static"

    vol_values = [p[0] for p in raw_points]
    trend_values = [p[1] for p in raw_points]
    vol_center = quantile(vol_values, 0.50)
    trend_center = quantile(trend_values, 0.50)
    vol_scale = max(std(vol_values), scale_floor)
    trend_scale = max(std(trend_values), scale_floor)
    z_points = [
        (
            max(-zclip, min(zclip, (p[0] - vol_center) / vol_scale)),
            max(-zclip, min(zclip, (p[1] - trend_center) / trend_scale)),
        )
        for p in points
    ]
    unique_points = {
        (round(p[0], 8), round(p[1], 8))
        for p in z_points
        if math.isfinite(p[0]) and math.isfinite(p[1])
    }
    if len(unique_points) < k:
        return build_rule_regime_labels(rows)
    k = min(k, len(unique_points), len(z_points))
    if k < 2:
        return build_rule_regime_labels(rows)

    sorted_points = sorted(z_points, key=lambda x: (x[0], abs(x[1])))
    centroids = [
        sorted_points[int((len(sorted_points) - 1) * i / max(1, k - 1))]
        for i in range(k)
    ]
    assignments = [0 for _ in z_points]
    for _ in range(max(3, iterations)):
        changed = False
        for idx, p in enumerate(z_points):
            best_id = 0
            best_dist = float("inf")
            for cid, c in enumerate(centroids):
                d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2
                if d < best_dist:
                    best_dist = d
                    best_id = cid
            if assignments[idx] != best_id:
                assignments[idx] = best_id
                changed = True

        cluster_points: Dict[int, List[Tuple[float, float]]] = defaultdict(list)
        for idx, cid in enumerate(assignments):
            cluster_points[cid].append(z_points[idx])
        for cid in range(k):
            pts = cluster_points.get(cid)
            if not pts:
                continue
            centroids[cid] = (
                sum(x for x, _ in pts) / len(pts),
                sum(y for _, y in pts) / len(pts),
            )
        if not changed:
            break

    cluster_sizes: List[int] = [0 for _ in range(k)]
    for cid in assignments:
        cluster_sizes[int(cid)] += 1
    max_cluster = max(cluster_sizes) if cluster_sizes else 0
    min_cluster = min(cluster_sizes) if cluster_sizes else 0
    cluster_balance_ratio = float(min_cluster / max(1, max_cluster))
    threshold = min_cluster_balance
    if balance_mode == "adaptive":
        if len(z_points) < 100:
            threshold *= 0.8
        elif len(z_points) > 1000:
            threshold *= 1.2
    threshold = max(0.05, min(0.20, threshold))
    if cluster_balance_ratio < threshold:
        return build_rule_regime_labels(rows)

    vol_thr = quantile(vol_mix, 0.65)
    trend_thr = quantile([abs(x) for x in trend], 0.60)
    label_by_cluster: Dict[int, str] = {}
    for cid in range(k):
        pts = [points[i] for i, a in enumerate(assignments) if a == cid]
        if not pts:
            label_by_cluster[cid] = "LowVolCarry"
            continue
        vol_c = sum(x for x, _ in pts) / len(pts)
        trend_c = sum(y for _, y in pts) / len(pts)
        high_vol = vol_c >= vol_thr
        trending = abs(trend_c) >= trend_thr
        if high_vol and trending:
            label = "HighVolTrend"
        elif high_vol:
            label = "HighVolMeanRevert"
        elif trending:
            label = "LowVolTrend"
        else:
            label = "LowVolCarry"
        label_by_cluster[cid] = label

    return [
        label_by_cluster.get(assignments[i], "LowVolCarry") for i in range(len(points))
    ]


def build_regime_labels(
    rows: List[CandleRow],
    regime_scheme: str,
    *,
    regime_kmeans_zclip: float = 8.0,
    regime_kmeans_scale_floor: float = 1e-6,
    regime_kmeans_min_cluster_balance: float = 0.10,
    regime_kmeans_balance_threshold_mode: str = "static",
) -> List[str]:
    scheme = (regime_scheme or "rule_v1").strip().lower()
    if scheme == "kmeans_v1":
        return build_kmeans_regime_labels(
            rows,
            zclip=regime_kmeans_zclip,
            scale_floor=regime_kmeans_scale_floor,
            min_cluster_balance=regime_kmeans_min_cluster_balance,
            balance_threshold_mode=regime_kmeans_balance_threshold_mode,
        )
    return build_rule_regime_labels(rows)


def resolve_partition_id(
    partition_mode: str,
    exchange_bucket: str,
    latest_regime_label: str,
) -> str:
    mode = (partition_mode or "none").strip().lower()
    exchange = exchange_bucket or "unknown"
    regime = latest_regime_label or "unknown"
    if mode == "exchange":
        return exchange
    if mode == "exchange_regime":
        return f"{exchange}__{regime}"
    return "all"


def iso_from_ms(ts_ms: int) -> str:
    return dt.datetime.fromtimestamp(ts_ms / 1000.0, tz=dt.timezone.utc).isoformat()


MIN_TS_MS = int(dt.datetime(2009, 1, 1, tzinfo=dt.timezone.utc).timestamp() * 1000)
MAX_TS_MS = int(
    (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=365 * 5)).timestamp() * 1000
)


def normalize_timestamp_ms(raw_ts: int) -> Optional[int]:
    ts = int(raw_ts)
    if ts <= 0:
        return None
    # Seconds -> milliseconds
    if ts < 100_000_000_000:
        ts *= 1000
    # Micro/nano -> milliseconds
    while ts > 9_999_999_999_999:
        ts //= 1000
    if ts < MIN_TS_MS or ts > MAX_TS_MS:
        return None
    return ts


def normalize_okx_symbol(raw: str, quote: str) -> Optional[str]:
    if "/" not in raw:
        return None
    base, rest = raw.split("/", 1)
    quote_part = rest.split(":")[0]
    if quote_part.upper() != quote:
        return None
    base = base.strip().upper()
    if not base:
        return None
    return f"{base}/{quote}"


def normalize_binance_symbol(raw: str, quote: str) -> Optional[str]:
    s = raw.strip().upper()
    if not s.endswith(quote):
        return None
    base = s[: -len(quote)]
    if not base:
        return None
    return f"{base}/{quote}"


def compose_symbol_key(symbol: str, source_bucket: str, isolate_sources: bool) -> str:
    if not isolate_sources:
        return symbol
    return f"{symbol}::{source_bucket}"


def split_symbol_key(symbol_key: str) -> Tuple[str, Optional[str]]:
    if "::" not in symbol_key:
        return symbol_key, None
    base, bucket = symbol_key.split("::", 1)
    return base, bucket or None


def valid_bar(ts: int, o: float, h: float, l: float, c: float, v: float) -> bool:
    if ts <= 0:
        return False
    if min(o, h, l, c) <= 0:
        return False
    if v < 0:
        return False
    if h < l:
        return False
    if o > h or o < l:
        return False
    if c > h or c < l:
        return False
    return True


def sanitize_symbol(symbol: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", symbol)


def pgrep_any(patterns: Iterable[str]) -> bool:
    for p in patterns:
        rc = subprocess.run(
            ["pgrep", "-f", p],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        ).returncode
        if rc == 0:
            return True
    return False


def tail_match(log_path: Path, regex: str) -> str:
    if not log_path.exists():
        return ""
    pat = re.compile(regex)
    last = ""
    with log_path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if pat.search(line):
                last = line.strip()
    return last


def tail_last_line(log_path: Path) -> str:
    if not log_path.exists():
        return ""
    last = ""
    with log_path.open("r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            if line.strip():
                last = line.strip()
    return last


def wait_for_downloads(args: argparse.Namespace) -> None:
    patterns = [
        "scripts/binance_public_download_klines.ts -- --source binance-all-usdt --market um --timeframe 1d --startMonth 2019-09 --outDir data/market/binance-public/um-all-usdt-1d",
        "scripts/binance_public_download_klines.ts -- --source binance-all-usdt --market spot --timeframe 1d --startMonth 2017-08 --outDir data/market/binance-public/spot-all-usdt-1d",
        "scripts/okx_download_ohlcv.ts -- --universe all --includeInactive true --timeframe 1d --start 2018-01-01",
    ]
    um_log = Path("logs/binance_um_all_usdt_1d.log")
    spot_log = Path("logs/binance_spot_all_usdt_1d.log")
    okx_log = Path("logs/okx_all_1d_full.log")

    while pgrep_any(patterns):
        um_progress = tail_match(um_log, r"progress .*\/51168|done:|EXIT:")
        spot_progress = tail_match(spot_log, r"progress .*\/66847|done:|EXIT:")
        okx_progress = tail_last_line(okx_log)
        log("downloads running; waiting...")
        if um_progress:
            log(f"  um:   {um_progress}")
        if spot_progress:
            log(f"  spot: {spot_progress}")
        if okx_progress:
            log(f"  okx:  {okx_progress}")
        subprocess.run(["sleep", str(args.poll_sec)], check=False)
    log("download tasks finished; start cleaning phase.")


@dataclass
class CandleRow:
    open: float
    high: float
    low: float
    close: float
    volume: float
    source: str
    market: str
    raw_symbol: str
    priority: int


def ingest_okx(
    okx_dir: Path,
    timeframe: str,
    quote: str,
    books: Dict[str, Dict[int, CandleRow]],
    stats: Dict[str, Any],
) -> None:
    files = sorted(okx_dir.glob(f"*_{timeframe}.csv"))
    log(f"ingest okx files: {len(files)}")
    for i, path in enumerate(files, 1):
        with path.open("r", encoding="utf-8", errors="ignore") as f:
            reader = csv.DictReader(f)
            for row in reader:
                stats["okx_rows_raw"] += 1
                raw_symbol = (row.get("symbol") or "").strip()
                symbol = normalize_okx_symbol(raw_symbol, quote)
                if not symbol:
                    stats["okx_rows_skip_quote"] += 1
                    continue
                ts = safe_int(row.get("timestamp"))
                o = safe_float(row.get("open"))
                h = safe_float(row.get("high"))
                l = safe_float(row.get("low"))
                c = safe_float(row.get("close"))
                v = safe_float(row.get("volume"))
                if None in {ts, o, h, l, c, v}:
                    stats["okx_rows_invalid"] += 1
                    continue
                assert ts is not None and o is not None and h is not None
                assert l is not None and c is not None and v is not None
                ts_ms = normalize_timestamp_ms(ts)
                if ts_ms is None:
                    stats["okx_rows_invalid"] += 1
                    continue
                if not valid_bar(ts_ms, o, h, l, c, v):
                    stats["okx_rows_invalid"] += 1
                    continue
                row_obj = CandleRow(
                    open=o,
                    high=h,
                    low=l,
                    close=c,
                    volume=v,
                    source="okx",
                    market="mixed",
                    raw_symbol=raw_symbol,
                    priority=SOURCE_PRIORITY["okx"],
                )
                symbol_key = compose_symbol_key(
                    symbol, "okx", bool(stats.get("isolate_sources", False))
                )
                slot = books[symbol_key]
                ts = ts_ms
                prev = slot.get(ts)
                if prev is None:
                    slot[ts] = row_obj
                    stats["okx_rows_kept"] += 1
                elif row_obj.priority > prev.priority:
                    slot[ts] = row_obj
                    stats["rows_replaced_by_priority"] += 1
                else:
                    stats["rows_dropped_lower_priority"] += 1
        if i % 200 == 0 or i == len(files):
            log(f"okx ingest progress {i}/{len(files)}")


def parse_binance_zip_meta(path: Path) -> Optional[Tuple[str, str, str]]:
    # Expect .../<market>/<symbol>/<timeframe>/<file>.zip
    parts = list(path.parts)
    if len(parts) < 4:
        return None
    market = None
    for idx, p in enumerate(parts):
        if p in {"spot", "um"} and idx + 2 < len(parts):
            market = p
            symbol = parts[idx + 1]
            timeframe = parts[idx + 2]
            return market, symbol, timeframe
    return None


def ingest_binance_dir(
    root_dir: Path,
    source_name: str,
    timeframe: str,
    quote: str,
    books: Dict[str, Dict[int, CandleRow]],
    stats: Dict[str, Any],
) -> None:
    files = sorted(root_dir.rglob("*.zip"))
    log(f"ingest {source_name} zip files: {len(files)}")
    priority = SOURCE_PRIORITY[source_name]
    for i, path in enumerate(files, 1):
        meta = parse_binance_zip_meta(path)
        if not meta:
            stats[f"{source_name}_files_bad_path"] += 1
            continue
        market, raw_symbol, tf = meta
        if tf != timeframe:
            stats[f"{source_name}_files_skip_tf"] += 1
            continue
        symbol = normalize_binance_symbol(raw_symbol, quote)
        if not symbol:
            stats[f"{source_name}_rows_skip_quote"] += 1
            continue

        try:
            with zipfile.ZipFile(path, "r") as zf:
                names = zf.namelist()
                if not names:
                    stats[f"{source_name}_files_empty"] += 1
                    continue
                with zf.open(names[0], "r") as raw:
                    text = raw.read().decode("utf-8", errors="ignore").splitlines()
        except Exception:
            stats[f"{source_name}_files_read_error"] += 1
            continue

        for line in text:
            if not line:
                continue
            cols = line.split(",")
            if not cols:
                continue
            # Skip possible header
            if cols[0].lower().startswith("open") or cols[0] == "open_time":
                continue
            if len(cols) < 6:
                stats[f"{source_name}_rows_invalid"] += 1
                continue
            ts = safe_int(cols[0])
            o = safe_float(cols[1])
            h = safe_float(cols[2])
            l = safe_float(cols[3])
            c = safe_float(cols[4])
            v = safe_float(cols[5])
            stats[f"{source_name}_rows_raw"] += 1
            if None in {ts, o, h, l, c, v}:
                stats[f"{source_name}_rows_invalid"] += 1
                continue
            assert ts is not None and o is not None and h is not None
            assert l is not None and c is not None and v is not None
            ts_ms = normalize_timestamp_ms(ts)
            if ts_ms is None:
                stats[f"{source_name}_rows_invalid"] += 1
                continue
            if not valid_bar(ts_ms, o, h, l, c, v):
                stats[f"{source_name}_rows_invalid"] += 1
                continue
            row_obj = CandleRow(
                open=o,
                high=h,
                low=l,
                close=c,
                volume=v,
                source=source_name,
                market=market,
                raw_symbol=raw_symbol,
                priority=priority,
            )
            symbol_key = compose_symbol_key(
                symbol, source_name, bool(stats.get("isolate_sources", False))
            )
            slot = books[symbol_key]
            ts = ts_ms
            prev = slot.get(ts)
            if prev is None:
                slot[ts] = row_obj
                stats[f"{source_name}_rows_kept"] += 1
            elif row_obj.priority > prev.priority:
                slot[ts] = row_obj
                stats["rows_replaced_by_priority"] += 1
            else:
                stats["rows_dropped_lower_priority"] += 1
        if i % 2000 == 0 or i == len(files):
            log(f"{source_name} ingest progress {i}/{len(files)}")


def load_ml_module(path: Path):
    spec = importlib.util.spec_from_file_location("ml_ensemble_v1", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module from {path}")
    module = importlib.util.module_from_spec(spec)
    # Python 3.13 dataclass internals expect the module to exist in sys.modules.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    if not hasattr(module, "fit_and_predict"):
        raise RuntimeError("ml_ensemble_v1 module missing fit_and_predict")
    return module


def write_clean_and_train(
    books: Dict[str, Dict[int, CandleRow]],
    args: argparse.Namespace,
    output_root: Path,
) -> Dict[str, Any]:
    clean_dir = output_root / "clean"
    symbols_dir = clean_dir / "symbols_1d"
    retrain_dir = output_root / "retrain"
    clean_dir.mkdir(parents=True, exist_ok=True)
    symbols_dir.mkdir(parents=True, exist_ok=True)
    retrain_dir.mkdir(parents=True, exist_ok=True)

    if not books:
        raise RuntimeError("no merged symbols after cleaning; abort")

    # Compute global max timestamp for delisted proxy.
    global_max_ts = max(ts for book in books.values() for ts in book.keys())
    delisted_cutoff = global_max_ts - args.delisted_days * 86_400_000

    module = load_ml_module(Path("scripts/ml_ensemble_v1.py"))
    include_models = [
        x.strip() for x in str(args.include_models).split(",") if x.strip()
    ]
    if not include_models:
        include_models = ["randomForest", "ridge", "pytorch"]
    effective_ensemble_mode = (
        "stacking" if len(include_models) <= 1 else str(args.ensemble_mode)
    )
    selection_metric = str(args.selection_objective or "accuracyLift")
    selection_mode = resolve_selection_mode(
        selection_metric, str(args.selection_mode or "auto")
    )
    nas_mode = resolve_selection_mode(
        str(args.nas_metric or selection_metric), str(args.nas_mode or "auto")
    )

    symbol_names = sorted(books.keys())
    allowlist_raw = [
        x.strip() for x in str(args.symbol_allowlist).split(",") if x.strip()
    ]
    if allowlist_raw:
        allowlist = set(allowlist_raw)
        symbol_names = [
            symbol_key
            for symbol_key in symbol_names
            if symbol_key in allowlist or split_symbol_key(symbol_key)[0] in allowlist
        ]
        if not symbol_names:
            raise RuntimeError(
                f"No symbols matched --symbol-allowlist. Requested={sorted(allowlist)}"
            )

    include_sources = set(getattr(args, "include_sources", []) or [])
    if include_sources:
        before = len(symbol_names)
        symbol_names = [
            symbol_key
            for symbol_key in symbol_names
            if (split_symbol_key(symbol_key)[1] or "") in include_sources
        ]
        log(
            "source include filter: "
            f"kept {len(symbol_names)}/{before} symbols for {sorted(include_sources)}"
        )
        if not symbol_names:
            raise RuntimeError(
                f"No symbols matched --include-sources. Requested={sorted(include_sources)}"
            )

    exclude_sources = set(getattr(args, "exclude_sources", []) or [])
    if exclude_sources:
        before = len(symbol_names)
        symbol_names = [
            symbol_key
            for symbol_key in symbol_names
            if (split_symbol_key(symbol_key)[1] or "") not in exclude_sources
        ]
        log(
            "source exclude filter: "
            f"kept {len(symbol_names)}/{before} symbols after excluding {sorted(exclude_sources)}"
        )
        if not symbol_names:
            raise RuntimeError(
                f"All symbols excluded by --exclude-sources={sorted(exclude_sources)}"
            )

    symbol_sort_mode = str(getattr(args, "symbol_sort_mode", "alpha") or "alpha")
    if symbol_sort_mode == "bars_desc":
        symbol_names = sorted(
            symbol_names,
            key=lambda symbol_key: (-len(books.get(symbol_key, {})), symbol_key),
        )
    else:
        symbol_names = sorted(symbol_names)

    max_symbols_per_source = int(getattr(args, "max_symbols_per_source", 0) or 0)
    if max_symbols_per_source > 0:
        src_counter: Dict[str, int] = defaultdict(int)
        filtered_symbol_names: List[str] = []
        for symbol_key in symbol_names:
            source_bucket = split_symbol_key(symbol_key)[1] or "mixed"
            if src_counter[source_bucket] >= max_symbols_per_source:
                continue
            filtered_symbol_names.append(symbol_key)
            src_counter[source_bucket] += 1
        log(
            "source quota filter: "
            f"kept {len(filtered_symbol_names)}/{len(symbol_names)} symbols with "
            f"max {max_symbols_per_source} per source ({dict(src_counter)})"
        )
        symbol_names = filtered_symbol_names
        if not symbol_names:
            raise RuntimeError(
                "No symbols remain after --max-symbols-per-source filtering"
            )

    if args.max_symbols and args.max_symbols > 0:
        symbol_names = symbol_names[: args.max_symbols]

    clean_summary: List[Dict[str, Any]] = []
    retrain_results: List[Dict[str, Any]] = []
    retrain_errors: List[Dict[str, Any]] = []
    partition_manifest: List[Dict[str, Any]] = []

    for idx, symbol_key in enumerate(symbol_names, 1):
        book = books[symbol_key]
        ts_sorted = sorted(book.keys())
        if not ts_sorted:
            continue
        base_symbol, source_bucket = split_symbol_key(symbol_key)
        last_ts = ts_sorted[-1]
        is_delisted_proxy = 1 if last_ts < delisted_cutoff else 0
        slug = sanitize_symbol(symbol_key)
        out_csv = symbols_dir / f"{slug}.csv"
        rows_ordered = [book[ts] for ts in ts_sorted]
        regime_labels = build_regime_labels(
            rows_ordered,
            str(args.regime_scheme),
            regime_kmeans_zclip=float(args.regime_kmeans_zclip),
            regime_kmeans_scale_floor=float(args.regime_kmeans_scale_floor),
            regime_kmeans_min_cluster_balance=float(
                args.regime_kmeans_min_cluster_balance
            ),
            regime_kmeans_balance_threshold_mode=str(
                args.regime_kmeans_balance_threshold_mode
            ),
        )
        if len(regime_labels) != len(ts_sorted):
            regime_labels = ["LowVolCarry" for _ in ts_sorted]
        latest_regime_label = regime_labels[-1] if regime_labels else "unknown"

        candles: List[Dict[str, Any]] = []
        src_counts: Dict[str, int] = defaultdict(int)
        with out_csv.open("w", encoding="utf-8", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(
                [
                    "timestamp",
                    "iso",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                    "symbol",
                    "source",
                    "market",
                    "raw_symbol",
                    "is_delisted_proxy",
                    "regime_label",
                    "regime_schema_version",
                ]
            )
            for row_idx, ts in enumerate(ts_sorted):
                row = book[ts]
                src_counts[row.source] += 1
                regime_label = regime_labels[row_idx]
                writer.writerow(
                    [
                        ts,
                        iso_from_ms(ts),
                        row.open,
                        row.high,
                        row.low,
                        row.close,
                        row.volume,
                        symbol_key,
                        row.source,
                        row.market,
                        row.raw_symbol,
                        is_delisted_proxy,
                        regime_label,
                        str(args.regime_schema_version),
                    ]
                )
                candles.append(
                    {
                        "symbol": symbol_key,
                        "baseSymbol": base_symbol,
                        "sourceBucket": source_bucket,
                        "time": int(ts // 1000),
                        "open": row.open,
                        "high": row.high,
                        "low": row.low,
                        "close": row.close,
                        "volume": row.volume,
                        "regimeLabel": regime_label,
                    }
                )

        exchange_bucket = source_bucket or (
            max(src_counts.items(), key=lambda kv: kv[1])[0]
            if src_counts
            else "unknown"
        )
        partition_id = resolve_partition_id(
            str(args.partition_mode), exchange_bucket, latest_regime_label
        )
        clean_summary.append(
            {
                "symbol": symbol_key,
                "baseSymbol": base_symbol,
                "sourceBucket": source_bucket,
                "exchange": exchange_bucket,
                "partitionMode": str(args.partition_mode),
                "partitionId": partition_id,
                "latestRegimeLabel": latest_regime_label,
                "rows": len(ts_sorted),
                "fromTimeMs": ts_sorted[0],
                "toTimeMs": ts_sorted[-1],
                "fromTimeIso": iso_from_ms(ts_sorted[0]),
                "toTimeIso": iso_from_ms(ts_sorted[-1]),
                "isDelistedProxy": is_delisted_proxy,
                "sourceCounts": dict(src_counts),
                "path": str(out_csv),
            }
        )
        partition_manifest.append(
            {
                "symbol": symbol_key,
                "baseSymbol": base_symbol,
                "sourceBucket": source_bucket,
                "exchange": exchange_bucket,
                "latestRegimeLabel": latest_regime_label,
                "partitionMode": str(args.partition_mode),
                "partitionId": partition_id,
                "rows": len(ts_sorted),
                "path": str(out_csv),
            }
        )

        if len(candles) < args.min_bars:
            continue

        payload = {
            "candles": candles,
            "horizonBars": int(args.horizon_bars),
            "trainRatio": float(args.train_ratio),
            "includeModels": include_models,
            "minConfidence": float(args.min_confidence),
            "minExpectedReturnPct": float(args.min_expected_return_pct),
            "seed": int(args.seed),
            "modelSelectionMetric": selection_metric,
            "modelSelectionMode": selection_mode,
            "ensembleMode": effective_ensemble_mode,
            "regimeCount": int(args.regime_count),
            "regimeMethod": str(args.regime_method),
            "regimeLabelingMode": str(args.regime_labeling_mode),
            "regimeKmeansZclip": float(args.regime_kmeans_zclip),
            "regimeKmeansScaleFloor": float(args.regime_kmeans_scale_floor),
            "regimeKmeansMinClusterBalance": float(
                args.regime_kmeans_min_cluster_balance
            ),
            "regimeKmeansBalanceThresholdMode": str(
                args.regime_kmeans_balance_threshold_mode
            ),
            "regimeKmeansDiagnosticsLevel": str(
                args.regime_kmeans_diagnostics_level
            ),
            "hybridWeights": {
                "accuracyLift": float(args.hybrid_weight_accuracy_lift),
                "robustCostAwareUtility": float(
                    args.hybrid_weight_robust_cost_aware_utility
                ),
                "netSharpeAfterCost": float(args.hybrid_weight_net_sharpe_after_cost),
                "rmsePct": float(args.hybrid_weight_rmse_pct),
                "winRateAfterCost": float(args.hybrid_weight_win_rate_after_cost),
                "turnoverPerBar": float(args.hybrid_weight_turnover_per_bar),
            },
            "oofMinCoverageSoft": float(args.oof_min_coverage_soft),
            "oofHardFloor": float(args.oof_hard_floor),
            "softFailMaxWeight": float(args.soft_fail_max_weight),
            "tscvGapBars": int(args.tscv_gap_bars),
            "testLockRatio": float(args.test_lock_ratio),
            "calibrationMethod": str(args.calibration_method),
            "riskClampOnSoftStatWarn": float(args.risk_clamp_on_soft_stat_warn),
            "labelingMode": str(args.labeling_mode),
            "barrierTakeProfitAtr": float(args.barrier_tp_atr),
            "barrierStopLossAtr": float(args.barrier_sl_atr),
            "barrierMaxHorizonBars": int(args.barrier_max_horizon_bars),
            "costFeeRate": float(args.cost_fee_rate),
            "costSlippageBps": float(args.cost_slippage_bps),
            "costLatencyBars": int(args.cost_latency_bars),
            "robustPerBarClip": float(args.robust_per_bar_clip),
            "conformalAlpha": float(args.conformal_alpha),
            "conformalMinRegimeSamples": int(args.conformal_min_regime_samples),
            "conformalShiftWeightClipMin": float(args.conformal_shift_weight_clip_min),
            "conformalShiftWeightClipMax": float(args.conformal_shift_weight_clip_max),
            "decisionUseConformalLowerBound": bool(
                args.decision_use_conformal_lower_bound
            ),
            "modelSafetyFilterEnabled": bool(args.model_safety_filter_enabled),
            "modelSafetyMinRobustCostAwareUtility": float(
                args.model_safety_min_robust_cost_aware_utility
            ),
            "modelSafetyMinCostAwareUtility": float(
                args.model_safety_min_cost_aware_utility
            ),
            "modelSafetyMinNetReturnPctAfterCost": float(
                args.model_safety_min_net_return_pct_after_cost
            ),
            "modelSafetyMaxTurnoverPerBar": float(
                args.model_safety_max_turnover_per_bar
            ),
            "nasEnabled": bool(args.nas_enabled),
            "nasTrials": int(args.nas_trials),
            "nasMetric": str(args.nas_metric or selection_metric),
            "nasMode": nas_mode,
        }

        try:
            result = module.fit_and_predict(payload)
            model_selection = result.get("modelSelection", {})
            if not isinstance(model_selection, dict):
                model_selection = {}
            objective_score = safe_float(model_selection.get("bestScore"))
            if objective_score is None:
                objective_score = safe_float(
                    (result.get("metrics", {}) or {}).get(selection_metric)
                )
            retrain_results.append(
                {
                    "symbol": symbol_key,
                    "isDelistedProxy": is_delisted_proxy,
                    "rows": len(candles),
                    "dataset": result.get("dataset"),
                    "modelsUsed": result.get("modelsUsed", []),
                    "droppedModels": result.get("droppedModels", []),
                    "intermediateModels": result.get("intermediateModels", []),
                    "modelSelection": model_selection,
                    "selectedModel": model_selection.get("bestModel", "ensemble"),
                    "objectiveMetric": selection_metric,
                    "objectiveMode": selection_mode,
                    "objectiveScore": objective_score,
                    "metrics": result.get("metrics", {}),
                    "validationMetrics": result.get("validationMetrics", {}),
                    "prediction": result.get("prediction", {}),
                    "trainingConfig": result.get("trainingConfig", {}),
                    "regimeSummary": result.get("regimeSummary", {}),
                    "hybridScore": result.get("hybridScore", {}),
                    "oofQuality": result.get("oofQuality", {}),
                    "selectionAudit": result.get("selectionAudit", {}),
                    "releaseGateDecision": result.get("releaseGateDecision", {}),
                }
            )
        except Exception as exc:
            retrain_errors.append(
                {
                    "symbol": symbol_key,
                    "rows": len(candles),
                    "error": str(exc),
                }
            )

        if idx % 25 == 0 or idx == len(symbol_names):
            log(
                f"clean/train progress {idx}/{len(symbol_names)} symbols, retrained={len(retrain_results)}, errors={len(retrain_errors)}"
            )

    # Aggregate retrain metrics.
    lifts = [
        float(r["metrics"].get("accuracyLift", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    dir_acc = [
        float(r["metrics"].get("directionAccuracy", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    baseline_acc = [
        float(r["metrics"].get("baselineDirectionAccuracy", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    cost_util = [
        float(r["metrics"].get("costAwareUtility", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    robust_cost_util = [
        float(r["metrics"].get("robustCostAwareUtility", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    net_return_after_cost = [
        float(r["metrics"].get("netReturnPctAfterCost", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    robust_annualized_return_after_cost = [
        float(r["metrics"].get("robustAnnualizedReturnPctAfterCost", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    turnover_per_bar = [
        float(r["metrics"].get("turnoverPerBar", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    conformal_coverage = [
        float(r["metrics"].get("conformalCoverage", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    conformal_coverage_shift = [
        float(r["metrics"].get("conformalCoverageShiftWeighted", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    conformal_sharpness_pct = [
        float(r["metrics"].get("conformalSharpnessPct", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    conformal_latest_lower_expected_return_pct = [
        float(r["metrics"].get("conformalLatestLowerExpectedReturnPct", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]
    conformal_latest_upper_expected_return_pct = [
        float(r["metrics"].get("conformalLatestUpperExpectedReturnPct", 0.0))
        for r in retrain_results
        if isinstance(r.get("metrics"), dict)
    ]

    def avg(xs: List[float]) -> float:
        return float(sum(xs) / len(xs)) if xs else 0.0

    positive_lift_ratio = (
        float(sum(1 for x in lifts if x > 0) / len(lifts)) if lifts else 0.0
    )
    objective_scores = [
        float(s)
        for s in (safe_float(r.get("objectiveScore")) for r in retrain_results)
        if s is not None
    ]
    regime_counts: Dict[str, int] = defaultdict(int)
    for row in retrain_results:
        regime_summary = row.get("regimeSummary", {})
        regime = None
        if isinstance(regime_summary, dict):
            regime = regime_summary.get("currentRegime")
        if isinstance(regime, str) and regime:
            regime_counts[regime] += 1

    fallback_applied_count = 0
    fallback_reason_counts: Dict[str, int] = defaultdict(int)
    cluster_balance_ratios: List[float] = []
    numeric_warning_counts: List[float] = []
    time_index_miss_counts: List[float] = []
    future_alignment_risks: List[float] = []
    diagnostics_sample_count = 0
    for row in retrain_results:
        regime_summary = row.get("regimeSummary", {})
        diagnostics = {}
        if isinstance(regime_summary, dict):
            diagnostics = regime_summary.get("diagnostics", {})
        if not isinstance(diagnostics, dict):
            diagnostics = {}
        if not diagnostics:
            continue
        diagnostics_sample_count += 1
        fallback_raw = diagnostics.get("fallbackApplied")
        fallback_applied = (
            bool(fallback_raw)
            if isinstance(fallback_raw, bool)
            else str(fallback_raw).strip().lower() in {"1", "true", "yes", "y"}
        )
        if fallback_applied:
            fallback_applied_count += 1
            reason = str(diagnostics.get("fallbackReason", "")).strip() or "unknown"
            fallback_reason_counts[reason] += 1
        balance_ratio = safe_float(diagnostics.get("clusterBalanceRatio"))
        if balance_ratio is not None:
            cluster_balance_ratios.append(balance_ratio)
        numeric_warnings = safe_float(diagnostics.get("numericWarningCount"))
        if numeric_warnings is not None:
            numeric_warning_counts.append(numeric_warnings)
        time_miss = safe_float(diagnostics.get("timeIndexMissCount"))
        if time_miss is not None:
            time_index_miss_counts.append(time_miss)
        future_risk = safe_float(diagnostics.get("futureAlignmentRisk"))
        if future_risk is not None:
            future_alignment_risks.append(future_risk)

    def row_objective_score(row: Dict[str, Any]) -> Optional[float]:
        v = safe_float(row.get("objectiveScore"))
        if v is not None:
            return v
        metrics = row.get("metrics", {})
        if isinstance(metrics, dict):
            return safe_float(metrics.get(selection_metric))
        return None

    def sort_score(row: Dict[str, Any]) -> float:
        v = row_objective_score(row)
        if v is None:
            return -1e99 if selection_mode == "max" else 1e99
        return float(v)

    leaderboard = sorted(
        retrain_results,
        key=sort_score,
        reverse=selection_mode == "max",
    )

    clean_summary_path = clean_dir / "summary.json"
    partition_manifest_path = (
        Path(str(args.partition_manifest_out)).resolve()
        if str(args.partition_manifest_out).strip()
        else clean_dir / "partition_manifest.json"
    )
    retrain_results_path = retrain_dir / "results.json"
    retrain_summary_path = retrain_dir / "summary.json"
    retrain_errors_path = retrain_dir / "errors.json"
    leaderboard_csv_path = retrain_dir / "leaderboard.csv"

    clean_summary_payload = {
        "generatedAt": utc_now(),
        "symbolCount": len(clean_summary),
        "globalMaxTimeMs": global_max_ts,
        "globalMaxTimeIso": iso_from_ms(global_max_ts),
        "symbols": clean_summary,
    }
    clean_summary_path.write_text(
        json.dumps(clean_summary_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    partition_counts: Dict[str, int] = defaultdict(int)
    for item in partition_manifest:
        pid = str(item.get("partitionId", "all"))
        partition_counts[pid] += 1
    partition_manifest_payload = {
        "generatedAt": utc_now(),
        "partitionMode": str(args.partition_mode),
        "regimeScheme": str(args.regime_scheme),
        "symbolCount": len(partition_manifest),
        "partitionCounts": dict(partition_counts),
        "symbols": partition_manifest,
    }
    partition_manifest_path.parent.mkdir(parents=True, exist_ok=True)
    partition_manifest_path.write_text(
        json.dumps(partition_manifest_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    retrain_results_path.write_text(
        json.dumps(retrain_results, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    retrain_errors_path.write_text(
        json.dumps(retrain_errors, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    retrain_summary = {
        "generatedAt": utc_now(),
        "trainedSymbols": len(retrain_results),
        "errorSymbols": len(retrain_errors),
        "objectiveMetric": selection_metric,
        "objectiveMode": selection_mode,
        "meanObjectiveScore": avg(objective_scores),
        "meanDirectionAccuracy": avg(dir_acc),
        "meanBaselineDirectionAccuracy": avg(baseline_acc),
        "meanAccuracyLift": avg(lifts),
        "meanCostAwareUtility": avg(cost_util),
        "meanRobustCostAwareUtility": avg(robust_cost_util),
        "meanNetReturnPctAfterCost": avg(net_return_after_cost),
        "meanRobustAnnualizedReturnPctAfterCost": avg(
            robust_annualized_return_after_cost
        ),
        "meanTurnoverPerBar": avg(turnover_per_bar),
        "meanConformalCoverageTest": avg(conformal_coverage),
        "meanConformalCoverageShiftWeightedTest": avg(conformal_coverage_shift),
        "meanConformalSharpnessPct": avg(conformal_sharpness_pct),
        "meanConformalLatestLowerExpectedReturnPct": avg(
            conformal_latest_lower_expected_return_pct
        ),
        "meanConformalLatestUpperExpectedReturnPct": avg(
            conformal_latest_upper_expected_return_pct
        ),
        "positiveLiftRatio": positive_lift_ratio,
        "ensembleMode": effective_ensemble_mode,
        "regimeMethod": str(args.regime_method),
        "regimeScheme": str(args.regime_scheme),
        "regimeCount": int(args.regime_count),
        "regimeLabelingMode": str(args.regime_labeling_mode),
        "partitionMode": str(args.partition_mode),
        "currentRegimeDistribution": dict(regime_counts),
        "regimeDiagnostics": {
            "summary": {
                "sampleCount": diagnostics_sample_count,
                "fallbackRatio": float(
                    fallback_applied_count / max(1, diagnostics_sample_count)
                ),
                "fallbackCount": fallback_applied_count,
                "avgClusterBalanceRatio": avg(cluster_balance_ratios),
                "minClusterBalanceRatio": (
                    float(min(cluster_balance_ratios))
                    if cluster_balance_ratios
                    else None
                ),
                "numericWarningTotal": float(sum(numeric_warning_counts)),
                "numericWarningMean": avg(numeric_warning_counts),
                "timeIndexMissTotal": float(sum(time_index_miss_counts)),
                "timeIndexMissMean": avg(time_index_miss_counts),
                "futureAlignmentRiskMean": avg(future_alignment_risks),
            },
            "detailed": {
                "fallbackReasonCounts": dict(fallback_reason_counts),
            },
        },
        # Compatibility aliases for lightweight dashboards / log parsers.
        "kmeansFallbackCount": int(fallback_applied_count),
        "kmeansFallbackReasonCounts": dict(fallback_reason_counts),
        "kmeansNumericWarningTotal": float(sum(numeric_warning_counts)),
        "labelingMode": str(args.labeling_mode),
        "nasEnabled": bool(args.nas_enabled),
        "nasTrials": int(args.nas_trials),
        "nasMetric": str(args.nas_metric or selection_metric),
        "nasMode": nas_mode,
        "costModel": {
            "feeRate": float(args.cost_fee_rate),
            "slippageBps": float(args.cost_slippage_bps),
            "latencyBars": int(args.cost_latency_bars),
            "robustPerBarClip": float(args.robust_per_bar_clip),
        },
        "top10ByObjective": [
            {
                "symbol": r["symbol"],
                "rows": r["rows"],
                "isDelistedProxy": r["isDelistedProxy"],
                "selectedModel": r.get("selectedModel", "ensemble"),
                "currentRegime": (r.get("regimeSummary", {}) or {}).get(
                    "currentRegime"
                ),
                "objectiveScore": row_objective_score(r),
                "accuracyLift": float(r.get("metrics", {}).get("accuracyLift", 0.0)),
                "costAwareUtility": float(
                    r.get("metrics", {}).get("costAwareUtility", 0.0)
                ),
                "robustCostAwareUtility": float(
                    r.get("metrics", {}).get("robustCostAwareUtility", 0.0)
                ),
                "netReturnPctAfterCost": float(
                    r.get("metrics", {}).get("netReturnPctAfterCost", 0.0)
                ),
                "robustAnnualizedReturnPctAfterCost": float(
                    r.get("metrics", {}).get("robustAnnualizedReturnPctAfterCost", 0.0)
                ),
                "conformalCoverage": float(
                    r.get("metrics", {}).get("conformalCoverage", 0.0)
                ),
                "conformalCoverageShiftWeighted": float(
                    r.get("metrics", {}).get("conformalCoverageShiftWeighted", 0.0)
                ),
                "conformalSharpnessPct": float(
                    r.get("metrics", {}).get("conformalSharpnessPct", 0.0)
                ),
                "directionAccuracy": float(
                    r.get("metrics", {}).get("directionAccuracy", 0.0)
                ),
                "baselineDirectionAccuracy": float(
                    r.get("metrics", {}).get("baselineDirectionAccuracy", 0.0)
                ),
            }
            for r in leaderboard[:10]
        ],
        "top10ByLift": [
            {
                "symbol": r["symbol"],
                "rows": r["rows"],
                "isDelistedProxy": r["isDelistedProxy"],
                "accuracyLift": float(r.get("metrics", {}).get("accuracyLift", 0.0)),
                "directionAccuracy": float(
                    r.get("metrics", {}).get("directionAccuracy", 0.0)
                ),
                "baselineDirectionAccuracy": float(
                    r.get("metrics", {}).get("baselineDirectionAccuracy", 0.0)
                ),
            }
            for r in leaderboard[:10]
        ],
        "paths": {
            "cleanSummary": str(clean_summary_path),
            "partitionManifest": str(partition_manifest_path),
            "retrainResults": str(retrain_results_path),
            "retrainErrors": str(retrain_errors_path),
            "leaderboardCsv": str(leaderboard_csv_path),
        },
    }
    retrain_summary_path.write_text(
        json.dumps(retrain_summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    with leaderboard_csv_path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "symbol",
                "rows",
                "is_delisted_proxy",
                "selected_model",
                "objective_metric",
                "objective_mode",
                "objective_score",
                "current_regime",
                "hybrid_global_winner",
                "accuracy_lift",
                "direction_accuracy",
                "baseline_direction_accuracy",
                "auc",
                "mae_pct",
                "rmse_pct",
                "cost_aware_utility",
                "robust_cost_aware_utility",
                "net_sharpe_after_cost",
                "robust_sharpe_after_cost",
                "robust_sortino_after_cost",
                "net_return_pct_after_cost",
                "robust_annualized_return_pct_after_cost",
                "gross_return_pct_before_cost",
                "turnover_per_bar",
                "trade_count",
                "win_rate_after_cost",
                "conformal_coverage",
                "conformal_coverage_shift_weighted",
                "conformal_sharpness_pct",
                "conformal_latest_lower_expected_return_pct",
                "conformal_latest_upper_expected_return_pct",
                "prediction_direction",
                "prediction_confidence",
                "prediction_expected_return_pct",
                "prediction_decision_expected_return_pct",
                "prediction_conformal_lower_expected_return_pct",
                "prediction_conformal_upper_expected_return_pct",
            ]
        )
        for r in leaderboard:
            m = r.get("metrics", {})
            p = r.get("prediction", {})
            writer.writerow(
                [
                    r.get("symbol"),
                    r.get("rows"),
                    r.get("isDelistedProxy"),
                    r.get("selectedModel"),
                    selection_metric,
                    selection_mode,
                    row_objective_score(r),
                    (r.get("regimeSummary", {}) or {}).get("currentRegime"),
                    (
                        (r.get("hybridScore", {}) or {}).get("globalWinner", {}) or {}
                    ).get("model"),
                    m.get("accuracyLift"),
                    m.get("directionAccuracy"),
                    m.get("baselineDirectionAccuracy"),
                    m.get("auc"),
                    m.get("maePct"),
                    m.get("rmsePct"),
                    m.get("costAwareUtility"),
                    m.get("robustCostAwareUtility"),
                    m.get("netSharpeAfterCost"),
                    m.get("robustSharpeAfterCost"),
                    m.get("robustSortinoAfterCost"),
                    m.get("netReturnPctAfterCost"),
                    m.get("robustAnnualizedReturnPctAfterCost"),
                    m.get("grossReturnPctBeforeCost"),
                    m.get("turnoverPerBar"),
                    m.get("tradeCount"),
                    m.get("winRateAfterCost"),
                    m.get("conformalCoverage"),
                    m.get("conformalCoverageShiftWeighted"),
                    m.get("conformalSharpnessPct"),
                    m.get("conformalLatestLowerExpectedReturnPct"),
                    m.get("conformalLatestUpperExpectedReturnPct"),
                    p.get("direction"),
                    p.get("confidence"),
                    p.get("expectedReturnPct"),
                    p.get("decisionExpectedReturnPct"),
                    p.get("conformalLowerExpectedReturnPct"),
                    p.get("conformalUpperExpectedReturnPct"),
                ]
            )

    return {
        "cleanSummaryPath": str(clean_summary_path),
        "partitionManifestPath": str(partition_manifest_path),
        "retrainSummaryPath": str(retrain_summary_path),
        "trainedSymbols": len(retrain_results),
        "errorSymbols": len(retrain_errors),
        "objectiveMetric": selection_metric,
        "objectiveMode": selection_mode,
        "includeSources": list(getattr(args, "include_sources", [])),
        "excludeSources": list(getattr(args, "exclude_sources", [])),
        "meanObjectiveScore": retrain_summary["meanObjectiveScore"],
        "meanAccuracyLift": retrain_summary["meanAccuracyLift"],
        "meanCostAwareUtility": retrain_summary["meanCostAwareUtility"],
        "meanRobustCostAwareUtility": retrain_summary["meanRobustCostAwareUtility"],
        "meanNetReturnPctAfterCost": retrain_summary["meanNetReturnPctAfterCost"],
        "meanConformalCoverageTest": retrain_summary["meanConformalCoverageTest"],
        "meanConformalCoverageShiftWeightedTest": retrain_summary[
            "meanConformalCoverageShiftWeightedTest"
        ],
        "meanConformalSharpnessPct": retrain_summary["meanConformalSharpnessPct"],
        "positiveLiftRatio": retrain_summary["positiveLiftRatio"],
    }


def main(argv: List[str]) -> int:
    args = parse_args(argv)
    args.wait_downloads = parse_bool(str(args.wait_downloads))
    args.isolate_sources = parse_bool(str(args.isolate_sources))
    args.include_sources = parse_source_filter_csv(
        str(args.include_sources), "--include-sources"
    )
    args.exclude_sources = parse_source_filter_csv(
        str(args.exclude_sources), "--exclude-sources"
    )
    if not args.isolate_sources and (args.include_sources or args.exclude_sources):
        raise ValueError(
            "source filters require --isolate-sources=true so source buckets remain explicit"
        )
    overlap = sorted(set(args.include_sources) & set(args.exclude_sources))
    if overlap:
        raise ValueError(
            f"sources appear in both include and exclude filters: {overlap}"
        )
    args.max_symbols_per_source = max(0, int(args.max_symbols_per_source))
    args.symbol_sort_mode = str(args.symbol_sort_mode).strip().lower()
    if args.symbol_sort_mode not in {"alpha", "bars_desc"}:
        args.symbol_sort_mode = "alpha"
    args.model_safety_filter_enabled = parse_bool(str(args.model_safety_filter_enabled))
    args.partition_mode = str(args.partition_mode).strip().lower()
    if args.partition_mode not in {"none", "exchange", "exchange_regime"}:
        args.partition_mode = "none"
    args.regime_scheme = str(args.regime_scheme).strip().lower()
    if args.regime_scheme not in {"rule_v1", "kmeans_v1"}:
        args.regime_scheme = "rule_v1"
    args.nas_enabled = parse_bool(str(args.nas_enabled))
    args.nas_trials = max(1, int(args.nas_trials))
    args.cost_fee_rate = max(0.0, float(args.cost_fee_rate))
    args.cost_slippage_bps = max(0.0, float(args.cost_slippage_bps))
    args.cost_latency_bars = max(0, int(args.cost_latency_bars))
    args.robust_per_bar_clip = max(0.01, min(0.5, float(args.robust_per_bar_clip)))
    args.conformal_alpha = max(0.01, min(0.40, float(args.conformal_alpha)))
    args.conformal_min_regime_samples = max(5, int(args.conformal_min_regime_samples))
    args.conformal_shift_weight_clip_min = max(
        0.05, min(1.0, float(args.conformal_shift_weight_clip_min))
    )
    args.conformal_shift_weight_clip_max = max(
        1.0, min(20.0, float(args.conformal_shift_weight_clip_max))
    )
    if args.conformal_shift_weight_clip_max < args.conformal_shift_weight_clip_min:
        args.conformal_shift_weight_clip_max = args.conformal_shift_weight_clip_min
    args.decision_use_conformal_lower_bound = parse_bool(
        str(args.decision_use_conformal_lower_bound)
    )
    args.model_safety_min_robust_cost_aware_utility = float(
        args.model_safety_min_robust_cost_aware_utility
    )
    args.model_safety_min_cost_aware_utility = float(
        args.model_safety_min_cost_aware_utility
    )
    args.model_safety_min_net_return_pct_after_cost = float(
        args.model_safety_min_net_return_pct_after_cost
    )
    args.model_safety_max_turnover_per_bar = max(
        0.0, float(args.model_safety_max_turnover_per_bar)
    )
    args.barrier_max_horizon_bars = max(1, int(args.barrier_max_horizon_bars))
    args.ensemble_mode = str(args.ensemble_mode).strip().lower()
    if args.ensemble_mode not in {"stacking", "regime_moe"}:
        args.ensemble_mode = "stacking"
    args.regime_count = max(3, min(4, int(args.regime_count)))
    args.regime_method = str(args.regime_method).strip().lower()
    if args.regime_method not in {"rule", "kmeans"}:
        args.regime_method = "rule"
    args.regime_labeling_mode = str(args.regime_labeling_mode).strip().lower()
    if args.regime_labeling_mode not in {"original", "strict"}:
        args.regime_labeling_mode = "original"
    args.regime_kmeans_zclip = max(2.0, min(25.0, float(args.regime_kmeans_zclip)))
    args.regime_kmeans_scale_floor = max(
        1e-8, min(1.0, float(args.regime_kmeans_scale_floor))
    )
    args.regime_kmeans_min_cluster_balance = max(
        0.01, min(0.90, float(args.regime_kmeans_min_cluster_balance))
    )
    args.regime_kmeans_balance_threshold_mode = (
        str(args.regime_kmeans_balance_threshold_mode).strip().lower()
    )
    if args.regime_kmeans_balance_threshold_mode not in {"static", "adaptive"}:
        args.regime_kmeans_balance_threshold_mode = "static"
    args.regime_kmeans_diagnostics_level = (
        str(args.regime_kmeans_diagnostics_level).strip().lower()
    )
    if args.regime_kmeans_diagnostics_level not in {"basic", "extended"}:
        args.regime_kmeans_diagnostics_level = "basic"
    # Keep regime method aligned with declared scheme for reproducible experiments.
    if args.regime_scheme == "kmeans_v1":
        args.regime_method = "kmeans"
    else:
        args.regime_method = "rule"
    args.oof_min_coverage_soft = max(0.2, min(0.95, float(args.oof_min_coverage_soft)))
    args.oof_hard_floor = max(0.05, min(0.9, float(args.oof_hard_floor)))
    if args.oof_hard_floor > args.oof_min_coverage_soft:
        args.oof_hard_floor = args.oof_min_coverage_soft
    args.soft_fail_max_weight = max(0.0, min(1.0, float(args.soft_fail_max_weight)))
    args.tscv_gap_bars = max(0, int(args.tscv_gap_bars))
    args.test_lock_ratio = max(0.05, min(0.30, float(args.test_lock_ratio)))
    args.calibration_method = str(args.calibration_method).strip().lower()
    if args.calibration_method not in {"none", "sigmoid", "isotonic"}:
        args.calibration_method = "sigmoid"
    args.risk_clamp_on_soft_stat_warn = max(
        0.05, min(1.0, float(args.risk_clamp_on_soft_stat_warn))
    )
    args.quote = str(args.quote).upper()
    if args.timeframe != "1d":
        raise ValueError("This pipeline currently supports timeframe=1d only.")

    output_root = Path(args.output_root).resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    run_manifest = {
        "startedAt": utc_now(),
        "args": vars(args),
    }
    (output_root / "run_manifest.json").write_text(
        json.dumps(run_manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    if args.wait_downloads:
        wait_for_downloads(args)

    books: Dict[str, Dict[int, CandleRow]] = defaultdict(dict)
    stats: Dict[str, Any] = defaultdict(int)
    stats["isolate_sources"] = bool(args.isolate_sources)

    ingest_okx(Path(args.okx_dir), args.timeframe, args.quote, books, stats)
    ingest_binance_dir(
        Path(args.binance_um_dir),
        "binance_um",
        args.timeframe,
        args.quote,
        books,
        stats,
    )
    ingest_binance_dir(
        Path(args.binance_spot_dir),
        "binance_spot",
        args.timeframe,
        args.quote,
        books,
        stats,
    )
    log(f"merge complete: symbols={len(books)}")

    stats_path = output_root / "clean" / "ingest_stats.json"
    stats_path.parent.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(
        json.dumps(dict(stats), ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    summary = write_clean_and_train(books, args, output_root)
    log(f"pipeline done: {json.dumps(summary, ensure_ascii=False)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except Exception as exc:
        sys.stderr.write(f"wait_clean_and_retrain failed: {exc}\n")
        raise
