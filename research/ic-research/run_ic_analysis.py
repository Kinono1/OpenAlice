"""Gate-based IC research pipeline for OpenAlice factors."""

from __future__ import annotations

import argparse
import itertools
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats as sp_stats

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common.data_fetcher import (
    CACHE_DIR,
    compute_liquidation_pressure_factor,
    compute_volatility_regime_factor,
    dataset_quality_report,
    prepare_research_dataset,
)

HORIZONS = [1, 6, 24, 72, 168]
MIN_MEAN_IC = 0.03
MIN_IC_IR = 0.5
MIN_WIN_RATE = 0.55
QUANTILES = 5
MIN_CORRELATION_SAMPLES = 10
MIN_UNIQUE_VALUES = 2

FACTOR_NAMES = [
    "factor_funding_rate",
    "factor_basis",
    "factor_volume_surge",
    "factor_momentum",
    "factor_mean_reversion",
    "factor_volatility_regime",
    "factor_liquidation_pressure",
    "factor_cross_timeframe_divergence",
]

FACTOR_FAMILIES = {
    "factor_funding_rate": "funding-rate",
    "factor_basis": "basis",
    "factor_volume_surge": "volume-surge",
    "factor_momentum": "momentum-composite",
    "factor_mean_reversion": "momentum-transform",
    "factor_volatility_regime": "volatility-regime",
    "factor_liquidation_pressure": "liquidation-pressure",
    "factor_cross_timeframe_divergence": "cross-timeframe-divergence",
}

OUTPUT_DIR = CACHE_DIR / "ic_results"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def build_output_name(symbol: str, start: str, end: str) -> str:
    safe_symbol = symbol.replace("/", "_").replace(":", "_")
    return f"ic_{safe_symbol}_{start}_{end}"


def _rank(values: np.ndarray) -> np.ndarray:
    arr = values.copy()
    order = np.argsort(arr)
    ranks = np.empty_like(order, dtype=float)
    ranks[order] = np.arange(1, len(arr) + 1, dtype=float)
    i = 0
    while i < len(arr):
        j = i
        while j < len(arr) - 1 and arr[order[j]] == arr[order[j + 1]]:
            j += 1
        if j > i:
            avg_rank = np.mean(ranks[order[i:j + 1]])
            for k in range(i, j + 1):
                ranks[order[k]] = avg_rank
        i = j + 1
    return ranks


def assess_series_quality(
    factor_values: np.ndarray,
    forward_returns: np.ndarray,
    min_samples: int = MIN_CORRELATION_SAMPLES,
) -> dict:
    mask = np.isfinite(factor_values) & np.isfinite(forward_returns)
    sample_count = int(mask.sum())
    if sample_count < min_samples:
        return {"status": "insufficient_data", "sample_count": sample_count}

    finite_factor = factor_values[mask]
    finite_returns = forward_returns[mask]
    factor_unique = int(np.unique(np.round(finite_factor, 12)).size)
    return_unique = int(np.unique(np.round(finite_returns, 12)).size)
    factor_std = float(np.std(finite_factor))
    return_std = float(np.std(finite_returns))

    if factor_unique < MIN_UNIQUE_VALUES or factor_std <= 1e-12:
        return {
            "status": "insufficient_variation",
            "sample_count": sample_count,
            "constant_side": "factor",
            "factor_unique_values": factor_unique,
            "return_unique_values": return_unique,
            "factor_std": factor_std,
            "return_std": return_std,
        }
    if return_unique < MIN_UNIQUE_VALUES or return_std <= 1e-12:
        return {
            "status": "insufficient_variation",
            "sample_count": sample_count,
            "constant_side": "returns",
            "factor_unique_values": factor_unique,
            "return_unique_values": return_unique,
            "factor_std": factor_std,
            "return_std": return_std,
        }
    return {
        "status": "ok",
        "sample_count": sample_count,
        "factor_unique_values": factor_unique,
        "return_unique_values": return_unique,
        "factor_std": factor_std,
        "return_std": return_std,
    }


def spearman_ic(factor_values: np.ndarray, forward_returns: np.ndarray) -> tuple[float, float]:
    quality = assess_series_quality(factor_values, forward_returns)
    if quality["status"] != "ok":
        return np.nan, np.nan
    mask = np.isfinite(factor_values) & np.isfinite(forward_returns)
    correlation, p_value = sp_stats.spearmanr(factor_values[mask], forward_returns[mask])
    return (
        float(correlation) if np.isfinite(correlation) else np.nan,
        float(p_value) if np.isfinite(p_value) else np.nan,
    )


def compute_periodic_ic(
    factor_col: np.ndarray,
    forward_returns: np.ndarray,
    period: int = 24,
) -> dict:
    ic_values: list[float] = []
    skipped = {"insufficient_data": 0, "insufficient_variation": 0}
    n = len(factor_col)
    for start in range(0, n - period, period):
        window_factor = factor_col[start:start + period]
        window_returns = forward_returns[start:start + period]
        quality = assess_series_quality(window_factor, window_returns)
        if quality["status"] != "ok":
            skipped[quality["status"]] = skipped.get(quality["status"], 0) + 1
            continue
        ic, _ = spearman_ic(window_factor, window_returns)
        if np.isfinite(ic):
            ic_values.append(ic)
    if len(ic_values) < 3:
        return {
            "mean_ic": np.nan,
            "ic_std": np.nan,
            "ic_ir": np.nan,
            "win_rate": np.nan,
            "n_periods": 0,
            "skipped_periods": skipped,
        }
    ic_arr = np.array(ic_values)
    mean_ic = np.mean(ic_arr)
    ic_std = np.std(ic_arr, ddof=1) if len(ic_arr) > 1 else 0.0
    ic_ir = mean_ic / ic_std if ic_std > 1e-12 else 0.0
    win_rate = np.mean(ic_arr > 0)
    return {
        "mean_ic": float(mean_ic),
        "ic_std": float(ic_std) if np.isfinite(ic_std) else np.nan,
        "ic_ir": float(ic_ir) if np.isfinite(ic_ir) else np.nan,
        "win_rate": float(win_rate),
        "n_periods": int(len(ic_values)),
        "skipped_periods": skipped,
    }


def compute_quantile_test(factor_values: np.ndarray, forward_returns: np.ndarray, n_quantiles: int = QUANTILES) -> dict:
    quality = assess_series_quality(factor_values, forward_returns, min_samples=n_quantiles * 10)
    if quality["status"] != "ok":
        return quality
    mask = np.isfinite(factor_values) & np.isfinite(forward_returns)
    fv = factor_values[mask]
    fr = forward_returns[mask]
    quantile_edges = np.percentile(fv, np.linspace(0, 100, n_quantiles + 1))
    bucket_means = []
    bucket_sizes = []
    for index in range(n_quantiles):
        lo = quantile_edges[index]
        hi = quantile_edges[index + 1]
        bucket_mask = (fv >= lo) & (fv <= hi) if index == n_quantiles - 1 else (fv >= lo) & (fv < hi)
        bucket_returns = fr[bucket_mask]
        bucket_means.append(np.mean(bucket_returns) if len(bucket_returns) > 0 else np.nan)
        bucket_sizes.append(int(len(bucket_returns)))
    valid_means = [value for value in bucket_means if np.isfinite(value)]
    if len(valid_means) < 3:
        return {"status": "insufficient_quantiles"}
    monotonicity, _ = sp_stats.spearmanr(range(len(valid_means)), valid_means)
    return {
        "bucket_means": [float(value) if np.isfinite(value) else None for value in bucket_means],
        "bucket_sizes": bucket_sizes,
        "monotonicity": float(monotonicity) if np.isfinite(monotonicity) else 0.0,
        "spread": float(max(valid_means) - min(valid_means)),
    }


def benjamini_hochberg(items: list[tuple[str, float]]) -> dict[str, dict]:
    valid = [(name, p) for name, p in items if np.isfinite(p)]
    ordered = sorted(valid, key=lambda item: item[1])
    total = len(ordered)
    if total == 0:
        return {}
    raw_q = {}
    for rank, (name, p_value) in enumerate(ordered, start=1):
        raw_q[name] = p_value * total / rank
    adjusted = {}
    running = 1.0
    for name, _ in reversed(ordered):
        running = min(running, raw_q[name])
        adjusted[name] = running
    return {
        name: {
            "p_value": p_value,
            "q_value": float(adjusted[name]),
            "passed": bool(adjusted[name] <= 0.1),
        }
        for name, p_value in items
        if np.isfinite(p_value)
    }


def simplex_weights(step: float = 0.1):
    values = [round(step * idx, 10) for idx in range(int(1 / step) + 1)]
    for a, b, c in itertools.product(values, repeat=3):
        if abs((a + b + c) - 1.0) <= 1e-9:
            yield (a, b, c)


def forward_returns(df: pd.DataFrame, horizon: int) -> np.ndarray:
    return df["close"].pct_change(horizon).shift(-horizon).values


def analyze_factor_series(series: np.ndarray, returns: np.ndarray) -> dict:
    quality = assess_series_quality(series, returns)
    periodic = compute_periodic_ic(series, returns, period=24)
    if quality["status"] != "ok":
        return {
            "status": quality["status"],
            "overall_ic": None,
            "p_value": None,
            "mean_ic": None,
            "ic_std": None,
            "ic_ir": None,
            "win_rate": None,
            "n_periods": periodic["n_periods"],
            "skipped_periods": periodic["skipped_periods"],
            "sample_count": quality["sample_count"],
            "factor_unique_values": quality.get("factor_unique_values"),
            "return_unique_values": quality.get("return_unique_values"),
            "factor_std": quality.get("factor_std"),
            "return_std": quality.get("return_std"),
            "constant_side": quality.get("constant_side"),
            "quantile_test": compute_quantile_test(series, returns),
            "passed": False,
        }
    overall_ic, p_value = spearman_ic(series, returns)
    return {
        "status": "ok",
        "overall_ic": float(overall_ic) if np.isfinite(overall_ic) else None,
        "p_value": float(p_value) if np.isfinite(p_value) else None,
        "mean_ic": periodic["mean_ic"] if np.isfinite(periodic["mean_ic"]) else None,
        "ic_std": periodic["ic_std"] if np.isfinite(periodic["ic_std"]) else None,
        "ic_ir": periodic["ic_ir"] if np.isfinite(periodic["ic_ir"]) else None,
        "win_rate": periodic["win_rate"] if np.isfinite(periodic["win_rate"]) else None,
        "n_periods": periodic["n_periods"],
        "skipped_periods": periodic["skipped_periods"],
        "sample_count": quality["sample_count"],
        "factor_unique_values": quality.get("factor_unique_values"),
        "return_unique_values": quality.get("return_unique_values"),
        "factor_std": quality.get("factor_std"),
        "return_std": quality.get("return_std"),
        "quantile_test": compute_quantile_test(series, returns),
        "passed": bool(
            np.isfinite(periodic["mean_ic"])
            and np.isfinite(periodic["ic_ir"])
            and np.isfinite(periodic["win_rate"])
            and abs(periodic["mean_ic"]) >= MIN_MEAN_IC
            and abs(periodic["ic_ir"]) >= MIN_IC_IR
            and periodic["win_rate"] >= MIN_WIN_RATE
        ),
    }


def compute_conditional_ic(df: pd.DataFrame, factor_name: str, horizon: int) -> dict:
    returns = forward_returns(df, horizon)
    output = {}
    for regime in ("bull", "bear", "calm", "stress"):
        regime_df = df[df["regime_state"] == regime]
        if len(regime_df) < 20:
            output[regime] = {"status": "insufficient_data", "sample_count": int(len(regime_df))}
            continue
        regime_returns = forward_returns(regime_df, horizon)
        metrics = analyze_factor_series(regime_df[factor_name].values, regime_returns)
        metrics["sample_count"] = int(len(regime_df))
        output[regime] = metrics
    return output


def scan_composite_weights(df: pd.DataFrame, factor_name: str) -> dict:
    window_returns = forward_returns(df, 24)
    best = None
    for weights in simplex_weights():
        if factor_name == "factor_volatility_regime":
            values = []
            for _, row in df.iterrows():
                value, _, _ = compute_volatility_regime_factor(
                    row.get("realized_vol_pct", 0) or 0,
                    row.get("previous_realized_vol_pct", row.get("realized_vol_pct", 0)) or 0,
                    row.get("vol_of_vol_pct", 0) or 0,
                    row.get("consecutive_high_vol", 0) or 0,
                    weights=weights,
                )
                values.append(value)
        else:
            values = []
            for _, row in df.iterrows():
                value, _, _ = compute_liquidation_pressure_factor(
                    row.get("funding_rate_zscore", 0) or 0,
                    row.get("volume_surge_strength", 0) or 0,
                    row.get("vol_expansion_score", 0) or 0,
                    row.get("return_1h_pct", 0) or 0,
                    0.0,
                    weights=weights,
                )
                values.append(value)

        metrics = analyze_factor_series(np.array(values), window_returns)
        score = (
            abs(metrics["mean_ic"]) if metrics["mean_ic"] is not None else -1,
            abs(metrics["ic_ir"]) if metrics["ic_ir"] is not None else -1,
            -sum(1 for item in weights if item > 0),
        )
        if best is None or score > best["score"]:
            best = {
                "weights": weights,
                "metrics": metrics,
                "score": score,
            }
    return {
        "weights": {
            "first": best["weights"][0],
            "second": best["weights"][1],
            "third": best["weights"][2],
        },
        "metrics": best["metrics"],
    }


def representative_windows(df: pd.DataFrame) -> list[tuple[str, pd.DataFrame]]:
    windows = []
    windows.append(("2023", df[(df.index >= "2023-01-01") & (df.index < "2024-01-01")]))
    windows.append(("2024", df[(df.index >= "2024-01-01") & (df.index < "2025-01-01")]))
    windows.append(("2025_current", df[df.index >= "2025-02-11"]))
    return [(name, window.copy()) for name, window in windows if len(window) >= 200]


def rolling_windows(df: pd.DataFrame, window_days: int = 90, step_days: int = 14) -> list[tuple[str, pd.DataFrame]]:
    windows = []
    if df.empty:
        return windows
    start = df.index.min()
    end = df.index.max()
    current = start
    while current + pd.Timedelta(days=window_days) <= end:
        next_end = current + pd.Timedelta(days=window_days)
        window = df[(df.index >= current) & (df.index < next_end)]
        if len(window) >= 200:
            windows.append((f"{current.date()}_{next_end.date()}", window.copy()))
        current += pd.Timedelta(days=step_days)
    return windows


def analyze_window(df: pd.DataFrame, factor_names: list[str]) -> dict:
    results = {}
    for factor_name in factor_names:
        horizon_results = {}
        for horizon in HORIZONS:
            metrics = analyze_factor_series(df[factor_name].values, forward_returns(df, horizon))
            metrics["conditional_ic"] = compute_conditional_ic(df, factor_name, horizon)
            horizon_results[f"{horizon}h"] = metrics
        results[factor_name] = horizon_results
    return results


def summarize_protocol(protocol_results: list[tuple[str, dict]]) -> dict:
    stability = {}
    p_values = []
    raw_pass = {}
    for window_name, results in protocol_results:
        for factor_name, horizons in results.items():
            primary = horizons["24h"]
            key = f"{window_name}:{factor_name}:24h"
            if primary["p_value"] is not None:
                p_values.append((key, primary["p_value"]))
            raw_pass[key] = bool(primary["passed"])
            stability.setdefault(factor_name, []).append(primary["mean_ic"])
    fdr = benjamini_hochberg(p_values)
    robust = {
        key: {
            "raw_passed": raw_pass.get(key, False),
            "fdr_passed": payload["passed"],
            "robust_passed": bool(raw_pass.get(key, False) and payload["passed"]),
        }
        for key, payload in fdr.items()
    }
    raw_pass_windows = {}
    robust_pass_windows = {}
    for factor_name in stability:
        factor_raw = [
            key
            for key, passed in raw_pass.items()
            if f":{factor_name}:24h" in key and passed
        ]
        factor_robust = [
            key
            for key, payload in robust.items()
            if f":{factor_name}:24h" in key and payload["robust_passed"]
        ]
        raw_pass_windows[factor_name] = {
            "count": len(factor_raw),
            "total_windows": len(protocol_results),
            "window_keys": factor_raw,
        }
        robust_pass_windows[factor_name] = {
            "count": len(factor_robust),
            "total_windows": len(protocol_results),
            "window_keys": factor_robust,
        }
    return {
        "windows": {name: results for name, results in protocol_results},
        "sign_stability": {
            factor_name: {
                "observations": values,
                "all_same_sign": all(np.sign(value or 0) == np.sign(values[0] or 0) for value in values if value is not None),
            }
            for factor_name, values in stability.items()
        },
        "raw_pass_windows": raw_pass_windows,
        "robust_pass_windows": robust_pass_windows,
        "fdr": fdr,
        "window_pass_detail": robust,
    }


def orthogonality_report(df: pd.DataFrame, factor_names: list[str]) -> dict:
    corr = df[factor_names].corr().fillna(0)
    return {
        "correlation_matrix": {
            row: {column: float(value) for column, value in values.items()}
            for row, values in corr.to_dict(orient="index").items()
        },
        "high_correlation_pairs": [
            {
                "left": left,
                "right": right,
                "correlation": float(corr.loc[left, right]),
            }
            for index, left in enumerate(factor_names)
            for right in factor_names[index + 1 :]
            if abs(corr.loc[left, right]) >= 0.8
        ],
    }


def run_research_pipeline(df: pd.DataFrame) -> dict:
    gate0 = dataset_quality_report(df)
    representative = representative_windows(df)
    gate1 = {
        "representative_windows": [name for name, _ in representative],
        "composite_weight_scan": {
            "factor_volatility_regime": scan_composite_weights(representative[-1][1], "factor_volatility_regime") if representative else None,
            "factor_liquidation_pressure": scan_composite_weights(representative[-1][1], "factor_liquidation_pressure") if representative else None,
        },
        "window_results": {
            name: analyze_window(window, FACTOR_NAMES)
            for name, window in representative
        },
    }
    stage_wfo = summarize_protocol(
        [(name, analyze_window(window, FACTOR_NAMES)) for name, window in representative]
    )
    rolling = rolling_windows(df)
    rolling_wfo = summarize_protocol(
        [(name, analyze_window(window, FACTOR_NAMES)) for name, window in rolling]
    )
    gate2 = {
        "three_stage_wfo": stage_wfo,
        "rolling_wfo": rolling_wfo,
        "orthogonality": orthogonality_report(df, FACTOR_NAMES),
        "factor_families": FACTOR_FAMILIES,
    }
    return {
        "gate0": gate0,
        "gate1": gate1,
        "gate2": gate2,
    }


def print_report(report: dict) -> None:
    print("\n" + "=" * 80)
    print("OPENALICE FACTOR RESEARCH REPORT")
    print("=" * 80)
    print("\nGate 0:")
    print(json.dumps(report["gate0"], indent=2))

    print("\nGate 1 representative windows:")
    print(", ".join(report["gate1"]["representative_windows"]))
    print(json.dumps(report["gate1"]["composite_weight_scan"], indent=2))

    print("\nGate 2 high-correlation pairs:")
    for item in report["gate2"]["orthogonality"]["high_correlation_pairs"]:
        print(f"  {item['left']} vs {item['right']}: {item['correlation']:+.3f}")


def write_research_artifacts(
    *,
    report: dict,
    df: pd.DataFrame,
    output_name: str,
    output_dir: Path = OUTPUT_DIR,
) -> dict[str, str]:
    json_path = output_dir / f"{output_name}.json"
    json_path.write_text(json.dumps(report, indent=2, default=str), encoding="utf-8")

    factor_cols = [column for column in df.columns if column.startswith("factor_")]
    factors_csv_path = output_dir / f"{output_name}_factors.csv"
    df[factor_cols + ["close", "regime_state"]].to_csv(factors_csv_path)

    rows = []
    for protocol_name, protocol in (
        ("three_stage_wfo", report["gate2"]["three_stage_wfo"]),
        ("rolling_wfo", report["gate2"]["rolling_wfo"]),
    ):
        for window_name, window_results in protocol["windows"].items():
            for factor_name, horizons in window_results.items():
                for horizon, metrics in horizons.items():
                    rows.append(
                        {
                            "protocol": protocol_name,
                            "window": window_name,
                            "factor": factor_name,
                            "horizon": horizon,
                            "mean_ic": metrics["mean_ic"],
                            "ic_ir": metrics["ic_ir"],
                            "win_rate": metrics["win_rate"],
                        }
                    )
    decay_csv_path = output_dir / f"{output_name}_decay.csv"
    if rows:
        pd.DataFrame(rows).to_csv(decay_csv_path, index=False)

    return {
        "json": str(json_path),
        "factors_csv": str(factors_csv_path),
        "decay_csv": str(decay_csv_path),
    }


def main():
    parser = argparse.ArgumentParser(description="IC Factor Empirical Research")
    parser.add_argument("--symbol", default="BTC/USDT:USDT")
    parser.add_argument("--timeframe", default="1h")
    parser.add_argument("--start", default="2024-01-01")
    parser.add_argument("--end", default="2025-12-31")
    parser.add_argument("--exchange", default="gate")
    args = parser.parse_args()

    df = prepare_research_dataset(args.symbol, args.timeframe, args.start, args.end, args.exchange)
    report = run_research_pipeline(df)
    print_report(report)

    output_name = build_output_name(args.symbol, args.start, args.end)
    write_research_artifacts(report=report, df=df, output_name=output_name)


if __name__ == "__main__":
    main()
