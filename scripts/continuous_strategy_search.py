#!/usr/bin/env python3
"""Continuously explore strategy profiles and optimize via matrix experiments."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

SEARCH_STATE_SCHEMA_VERSION = "2.1.0"
CYCLE_REPORT_SCHEMA_VERSION = "2.1.0"
SEARCH_STATE_SCHEMA_FEATURES = [
    "stage2Fields",
    "selectionMeta",
    "historyBackfill",
    "candidateSurvivalMetrics",
]
CYCLE_REPORT_SCHEMA_FEATURES = [
    "stage2Fields",
    "selectionMeta",
    "candidateSurvivalMetrics",
]

BASELINE_H0 = {
    "calibration_method": "sigmoid",
    "regime_method": "rule",
    "regime_scheme": "rule_v1",
    "regime_schema_version": "v1_rule_3regime",
    "include_models": "randomForest,xgboost,lightgbm,catboost",
    "extra_args": {},
}

REGIME_OPTIONS = [
    {
        "regime_method": "rule",
        "regime_scheme": "rule_v1",
        "regime_schema_version": "v1_rule_3regime",
    },
    {
        "regime_method": "kmeans",
        "regime_scheme": "kmeans_v1",
        "regime_schema_version": "v1_kmeans_3regime",
    },
]

CALIBRATION_OPTIONS = ["sigmoid", "isotonic"]
MODEL_OPTIONS = [
    "randomForest,xgboost,lightgbm,catboost",
    "randomForest,xgboost,lightgbm,catboost,ridge",
]

EXTRA_RECIPES = [
    {"name": "base", "args": {}},
    {
        "name": "gate_mid",
        "args": {
            "--min-confidence": "0.60",
            "--min-expected-return-pct": "0.05",
        },
    },
    {
        "name": "gate_high",
        "args": {
            "--min-confidence": "0.62",
            "--min-expected-return-pct": "0.08",
        },
    },
    {
        "name": "safety_mid",
        "args": {
            "--model-safety-min-robust-cost-aware-utility": "0.01",
            "--model-safety-min-cost-aware-utility": "0.00",
            "--model-safety-min-net-return-pct-after-cost": "0.0",
        },
    },
    {
        "name": "safety_high",
        "args": {
            "--model-safety-min-robust-cost-aware-utility": "0.02",
            "--model-safety-min-cost-aware-utility": "0.00",
            "--model-safety-min-net-return-pct-after-cost": "0.0",
        },
    },
    {
        "name": "barrier_wide",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
        },
    },
    {
        "name": "barrier_medium",
        "args": {
            "--barrier-tp-atr": "1.8",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "5",
        },
    },
    {
        "name": "barrier_medium_gate",
        "args": {
            "--barrier-tp-atr": "1.8",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "5",
            "--min-confidence": "0.58",
            "--min-expected-return-pct": "0.04",
        },
    },
    {
        "name": "barrier_wide_soft_gate",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.55",
            "--min-expected-return-pct": "0.02",
        },
    },
    {
        "name": "barrier_wide_soft_gate_turnover",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.56",
            "--min-expected-return-pct": "0.03",
            "--risk-clamp-on-soft-stat-warn": "0.30",
            "--soft-fail-max-weight": "0.12",
        },
    },
    {
        "name": "barrier_wide_soft_gate_turnover_plus",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.58",
            "--min-expected-return-pct": "0.04",
            "--risk-clamp-on-soft-stat-warn": "0.25",
            "--soft-fail-max-weight": "0.10",
            "--model-safety-min-robust-cost-aware-utility": "0.01",
            "--model-safety-min-cost-aware-utility": "0.00",
            "--model-safety-min-net-return-pct-after-cost": "0.0",
        },
    },
    {
        "name": "barrier_wide_hybrid_turnover",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.58",
            "--min-expected-return-pct": "0.04",
            "--selection-objective": "hybrid",
            "--hybrid-weight-accuracy-lift": "0.20",
            "--hybrid-weight-robust-cost-aware-utility": "0.25",
            "--hybrid-weight-net-sharpe-after-cost": "0.20",
            "--hybrid-weight-rmse-pct": "0.05",
            "--hybrid-weight-win-rate-after-cost": "0.10",
            "--hybrid-weight-turnover-per-bar": "0.40",
        },
    },
    {
        "name": "barrier_wide_hybrid_turnover_strict",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.62",
            "--min-expected-return-pct": "0.05",
            "--selection-objective": "hybrid",
            "--hybrid-weight-accuracy-lift": "0.20",
            "--hybrid-weight-robust-cost-aware-utility": "0.20",
            "--hybrid-weight-net-sharpe-after-cost": "0.20",
            "--hybrid-weight-rmse-pct": "0.05",
            "--hybrid-weight-win-rate-after-cost": "0.05",
            "--hybrid-weight-turnover-per-bar": "0.50",
        },
    },
    {
        "name": "barrier_wide_turnover_hard",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.66",
            "--min-expected-return-pct": "0.08",
            "--risk-clamp-on-soft-stat-warn": "0.22",
            "--soft-fail-max-weight": "0.08",
        },
    },
    {
        "name": "barrier_wide_turnover_harder",
        "args": {
            "--barrier-tp-atr": "2.0",
            "--barrier-sl-atr": "1.0",
            "--barrier-max-horizon-bars": "6",
            "--min-confidence": "0.70",
            "--min-expected-return-pct": "0.10",
            "--risk-clamp-on-soft-stat-warn": "0.20",
            "--soft-fail-max-weight": "0.06",
        },
    },
    {
        "name": "friction_12bps",
        "args": {
            "--cost-slippage-bps": "12",
        },
    },
    {
        "name": "robust_clip_020",
        "args": {
            "--robust-per-bar-clip": "0.20",
        },
    },
    {
        "name": "turnover_guard",
        "args": {
            "--min-confidence": "0.65",
            "--min-expected-return-pct": "0.10",
            "--risk-clamp-on-soft-stat-warn": "0.25",
            "--soft-fail-max-weight": "0.10",
        },
    },
    {
        "name": "turnover_guard_plus",
        "args": {
            "--min-confidence": "0.68",
            "--min-expected-return-pct": "0.12",
            "--risk-clamp-on-soft-stat-warn": "0.20",
            "--soft-fail-max-weight": "0.08",
            "--model-safety-min-robust-cost-aware-utility": "0.02",
            "--model-safety-min-cost-aware-utility": "0.00",
            "--model-safety-min-net-return-pct-after-cost": "0.0",
        },
    },
]


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Continuously generate new strategy profiles and run "
            "run_cvar_next_matrix.py for optimization."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root. Default: parent of this script.",
    )
    parser.add_argument(
        "--matrix-script",
        default="scripts/run_cvar_next_matrix.py",
        help="Matrix runner script path (absolute or repo-relative).",
    )
    parser.add_argument(
        "--python-bin",
        default="./.venv/bin/python",
        help="Python executable used to run scripts.",
    )
    parser.add_argument(
        "--search-root",
        default="data/training-data/cvar-search",
        help="Root directory for search state and artifacts.",
    )
    parser.add_argument(
        "--experiment-root",
        default="data/training-data/cvar-next",
        help="Experiment root passed to run_cvar_next_matrix.py.",
    )
    parser.add_argument(
        "--experiment-prefix",
        default="cvar24-autosearch",
        help="Prefix for generated experiment IDs.",
    )
    parser.add_argument(
        "--cycles",
        type=int,
        default=1,
        help="Number of search cycles. Use 0 for endless loop.",
    )
    parser.add_argument(
        "--candidates-per-cycle",
        type=int,
        default=3,
        help="Number of challenger configs per cycle (default 3 => H4/H5/H6).",
    )
    parser.add_argument(
        "--matrix-seeds",
        default="7,13,42,87",
        help="Seeds forwarded to matrix runner.",
    )
    parser.add_argument(
        "--search-seed",
        type=int,
        default=20260227,
        help="Random seed for candidate selection.",
    )
    parser.add_argument(
        "--sleep-seconds",
        type=int,
        default=5,
        help="Sleep time between cycles.",
    )
    parser.add_argument(
        "--history-window-cycles",
        type=int,
        default=14,
        help="Number of most recent cycles used for efficiency pruning statistics.",
    )
    parser.add_argument(
        "--min-recipe-trials",
        type=int,
        default=3,
        help="Minimum historical trials before a recipe can be considered for pruning.",
    )
    parser.add_argument(
        "--min-recipe-lift-pass-rate",
        type=float,
        default=0.35,
        help="Recipe prune threshold for gate_pass_lift rate.",
    )
    parser.add_argument(
        "--min-recipe-eligible-rate",
        type=float,
        default=0.10,
        help="Recipe prune threshold for eligible rate.",
    )
    parser.add_argument(
        "--disable-history-prune",
        action="store_true",
        help="Disable history-based candidate pruning.",
    )
    parser.add_argument(
        "--stage2-on-eligible-only",
        action=argparse.BooleanOptionalAction,
        default=True,
        help=(
            "When executing, run stage2 only after stage1 main board confirms an "
            "eligible challenger winner."
        ),
    )
    parser.add_argument(
        "--no-execute",
        action="store_true",
        help="Plan only: generate profiles and commands without launching experiments.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    return (root / p).resolve()


def candidate_fingerprint(config: Dict[str, Any]) -> str:
    normalized = {
        "calibration_method": config["calibration_method"],
        "regime_method": config["regime_method"],
        "regime_scheme": config["regime_scheme"],
        "regime_schema_version": config["regime_schema_version"],
        "include_models": config["include_models"],
        "extra_args": dict(sorted(config.get("extra_args", {}).items())),
    }
    return json.dumps(normalized, sort_keys=True, separators=(",", ":"))


def parse_fingerprint(raw: Any) -> Optional[Dict[str, Any]]:
    if raw is None:
        return None
    try:
        payload = json.loads(str(raw))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def resolve_anchor_from_state(state: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    history = state.get("history")
    if isinstance(history, list):
        for entry in reversed(history):
            if not isinstance(entry, dict):
                continue
            if not bool(entry.get("winnerEligible")):
                continue
            report_path_raw = str(entry.get("reportPath", "")).strip()
            if report_path_raw:
                report_path = Path(report_path_raw)
                if report_path.exists():
                    try:
                        report_payload = json.loads(report_path.read_text(encoding="utf-8"))
                    except Exception:
                        report_payload = {}
                    if isinstance(report_payload, dict):
                        anchor = parse_fingerprint(report_payload.get("winnerFingerprint"))
                        if anchor:
                            return anchor
                        winner_id = str(report_payload.get("winnerConfig", "")).strip()
                        selected = report_payload.get("selectedById")
                        if (
                            winner_id
                            and isinstance(selected, dict)
                            and isinstance(selected.get(winner_id), dict)
                        ):
                            return selected.get(winner_id)
    return parse_fingerprint((state.get("best") or {}).get("winnerFingerprint"))


def build_candidate_pool() -> List[Dict[str, Any]]:
    pool: List[Dict[str, Any]] = []
    for calibration in CALIBRATION_OPTIONS:
        for regime in REGIME_OPTIONS:
            for models in MODEL_OPTIONS:
                for recipe in EXTRA_RECIPES:
                    candidate = {
                        "calibration_method": calibration,
                        "regime_method": regime["regime_method"],
                        "regime_scheme": regime["regime_scheme"],
                        "regime_schema_version": regime["regime_schema_version"],
                        "include_models": models,
                        "extra_args": dict(recipe["args"]),
                        "meta": {
                            "recipe": recipe["name"],
                            "calibration": calibration,
                            "regime": regime["regime_method"],
                            "models": models,
                        },
                    }
                    candidate["fingerprint"] = candidate_fingerprint(candidate)
                    pool.append(candidate)
    return pool


def similarity_score(candidate: Dict[str, Any], anchor: Dict[str, Any]) -> float:
    score = 0.0
    if candidate.get("calibration_method") == anchor.get("calibration_method"):
        score += 4.0
    if candidate.get("regime_method") == anchor.get("regime_method"):
        score += 3.0
    if candidate.get("regime_scheme") == anchor.get("regime_scheme"):
        score += 2.0
    if candidate.get("regime_schema_version") == anchor.get("regime_schema_version"):
        score += 2.0
    if candidate.get("include_models") == anchor.get("include_models"):
        score += 4.0
    candidate_args = candidate.get("extra_args", {})
    anchor_args = anchor.get("extra_args", {})
    if isinstance(candidate_args, dict) and isinstance(anchor_args, dict):
        for key, value in candidate_args.items():
            if anchor_args.get(key) == value:
                score += 1.0
        score -= 0.1 * abs(len(candidate_args) - len(anchor_args))
    return score


def select_candidates(
    pool: Sequence[Dict[str, Any]],
    tried: set[str],
    count: int,
    rng: random.Random,
    anchor: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    fresh = [item for item in pool if item["fingerprint"] not in tried]
    if not fresh:
        return []
    if not anchor:
        rng.shuffle(fresh)
        return fresh[:count]

    scored: List[Tuple[float, float, Dict[str, Any]]] = []
    for item in fresh:
        scored.append((similarity_score(item, anchor), rng.random(), item))
    scored.sort(key=lambda x: (x[0], x[1]), reverse=True)

    selected: List[Dict[str, Any]] = []
    # Exploit around anchor: keep at least count-1 high-sim candidates.
    exploit_target = max(1, count - 1)
    for _, _, item in scored:
        if len(selected) >= exploit_target:
            break
        selected.append(item)

    remaining = [item for _, _, item in scored if item not in selected]
    if len(selected) < count and remaining:
        # One exploration slot from the lower-similarity half.
        split = max(1, len(remaining) // 2)
        exploration_pool = remaining[split:] if len(remaining) > 1 else remaining
        rng.shuffle(exploration_pool)
        selected.append(exploration_pool[0])

    if len(selected) < count:
        refill = [item for item in remaining if item not in selected]
        selected.extend(refill[: count - len(selected)])
    return selected[:count]


def parse_matrix_seeds(raw: str) -> List[int]:
    seeds: List[int] = []
    for token in str(raw).split(","):
        value = token.strip()
        if not value:
            continue
        seeds.append(int(value))
    if not seeds:
        return [7, 13, 42, 87]
    return sorted(set(seeds))


def make_gate_stats() -> Dict[str, int]:
    return {
        "trials": 0,
        "eligiblePass": 0,
        "liftPass": 0,
        "robustUpliftPass": 0,
        "robustCiPass": 0,
    }


def update_gate_stats(bucket: Dict[str, Dict[str, int]], key: str, row: Dict[str, Any]) -> None:
    stats = bucket.setdefault(key, make_gate_stats())
    stats["trials"] += 1
    if to_bool(row.get("eligible")):
        stats["eligiblePass"] += 1
    if to_bool(row.get("gate_pass_lift")):
        stats["liftPass"] += 1
    if to_bool(row.get("gate_pass_robust_uplift")):
        stats["robustUpliftPass"] += 1
    if to_bool(row.get("gate_pass_robust_ci")):
        stats["robustCiPass"] += 1


def collect_history_gate_stats(
    state: Dict[str, Any],
    max_cycles: int,
) -> Dict[str, Any]:
    history = state.get("history", [])
    if not isinstance(history, list) or not history:
        return {
            "windowCycles": max_cycles,
            "reportsUsed": 0,
            "samplesUsed": 0,
            "byRecipe": {},
            "byFamily": {},
        }

    entries = [item for item in history if isinstance(item, dict)]
    entries.sort(key=lambda item: int(item.get("cycleIndex", 0)), reverse=True)
    if max_cycles > 0:
        entries = entries[:max_cycles]

    by_recipe: Dict[str, Dict[str, int]] = {}
    by_family: Dict[str, Dict[str, int]] = {}
    reports_used = 0
    samples_used = 0

    for entry in entries:
        report_path_raw = str(entry.get("reportPath", "")).strip()
        if not report_path_raw:
            continue
        report_path = Path(report_path_raw)
        if not report_path.exists():
            continue
        try:
            payload = json.loads(report_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        selected = payload.get("selectedById")
        main_rows = payload.get("mainRows")
        if not isinstance(selected, dict) or not isinstance(main_rows, dict):
            continue
        reports_used += 1
        for config_id in ("H4", "H5", "H6"):
            candidate = selected.get(config_id)
            row = main_rows.get(config_id)
            if not isinstance(candidate, dict) or not isinstance(row, dict):
                continue
            meta = candidate.get("meta")
            if isinstance(meta, dict):
                recipe = str(meta.get("recipe") or "unknown")
            else:
                recipe = "unknown"
            family = "|".join(
                [
                    str(candidate.get("calibration_method", "")),
                    str(candidate.get("regime_method", "")),
                    str(candidate.get("include_models", "")),
                ]
            )
            update_gate_stats(by_recipe, recipe, row)
            update_gate_stats(by_family, family, row)
            samples_used += 1

    return {
        "windowCycles": max_cycles,
        "reportsUsed": reports_used,
        "samplesUsed": samples_used,
        "byRecipe": by_recipe,
        "byFamily": by_family,
    }


def apply_history_prune(
    *,
    pool: Sequence[Dict[str, Any]],
    tried: set[str],
    count: int,
    history_stats: Dict[str, Any],
    min_trials: int,
    min_lift_pass_rate: float,
    min_eligible_rate: float,
    enabled: bool,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    fresh = [item for item in pool if item["fingerprint"] not in tried]
    selection_meta: Dict[str, Any] = {
        "historyPruneEnabled": bool(enabled),
        "freshPoolSize": len(fresh),
        "poolAfterPrune": len(fresh),
        "prunedCount": 0,
        "restoredCount": 0,
        "prunedByRecipe": {},
    }
    if not enabled or not fresh:
        return fresh, selection_meta

    by_recipe = (
        history_stats.get("byRecipe", {})
        if isinstance(history_stats.get("byRecipe"), dict)
        else {}
    )
    kept: List[Dict[str, Any]] = []
    dropped: List[Tuple[Dict[str, Any], str, float, float, int]] = []
    for candidate in fresh:
        meta = candidate.get("meta")
        recipe = str(meta.get("recipe") if isinstance(meta, dict) else "unknown")
        recipe_stats = by_recipe.get(recipe)
        if not isinstance(recipe_stats, dict):
            kept.append(candidate)
            continue
        trials = int(recipe_stats.get("trials", 0))
        if trials < min_trials:
            kept.append(candidate)
            continue
        lift_pass = int(recipe_stats.get("liftPass", 0))
        eligible_pass = int(recipe_stats.get("eligiblePass", 0))
        lift_rate = lift_pass / float(trials)
        eligible_rate = eligible_pass / float(trials)
        if lift_rate < min_lift_pass_rate and eligible_rate < min_eligible_rate:
            dropped.append((candidate, recipe, lift_rate, eligible_rate, trials))
            continue
        kept.append(candidate)

    restored_count = 0
    if len(kept) < count and dropped:
        # If pruning becomes too aggressive, restore least-bad dropped recipes first.
        dropped.sort(key=lambda x: (x[3], x[2], -x[4]), reverse=True)
        needed = count - len(kept)
        for _ in range(min(needed, len(dropped))):
            restored = dropped.pop(0)
            kept.append(restored[0])
            restored_count += 1

    pruned_by_recipe: Dict[str, Dict[str, Any]] = {}
    for _, recipe, lift_rate, eligible_rate, trials in dropped:
        item = pruned_by_recipe.setdefault(
            recipe,
            {
                "count": 0,
                "trials": trials,
                "liftPassRate": round(lift_rate, 6),
                "eligibleRate": round(eligible_rate, 6),
            },
        )
        item["count"] += 1

    selection_meta["poolAfterPrune"] = len(kept)
    selection_meta["prunedCount"] = len(dropped)
    selection_meta["restoredCount"] = restored_count
    selection_meta["prunedByRecipe"] = pruned_by_recipe
    return kept, selection_meta


def parse_main_aggregate(path: Path) -> Dict[str, Dict[str, Any]]:
    rows: Dict[str, Dict[str, Any]] = {}
    if not path.exists():
        return rows
    with path.open("r", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            rows[row["config_id"]] = row
    return rows


def to_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def to_int(value: Any) -> Optional[int]:
    try:
        if value is None or value == "":
            return None
        return int(str(value).strip())
    except Exception:
        return None


def to_bool(value: Any) -> bool:
    return str(value).strip().lower() in {"true", "1", "yes"}


def same_float(a: Optional[float], b: Optional[float], tol: float = 1e-12) -> bool:
    if a is None or b is None:
        return a is None and b is None
    return abs(a - b) <= tol


def read_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {
            "createdAt": utc_now(),
            "cyclesCompleted": 0,
            "triedFingerprints": [],
            "best": {},
            "history": [],
            "searchStateSchemaVersion": SEARCH_STATE_SCHEMA_VERSION,
            "searchStateSchemaFeatures": list(SEARCH_STATE_SCHEMA_FEATURES),
        }
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"invalid state file payload: {path}")
    payload.setdefault("triedFingerprints", [])
    payload.setdefault("history", [])
    payload.setdefault("cyclesCompleted", 0)
    payload.setdefault("best", {})
    payload.setdefault("searchStateSchemaVersion", SEARCH_STATE_SCHEMA_VERSION)
    payload.setdefault("searchStateSchemaFeatures", list(SEARCH_STATE_SCHEMA_FEATURES))
    return payload


def write_state(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def ensure_leaderboard(path: Path) -> None:
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(
            [
                "cycle_index",
                "experiment_id",
                "config_id",
                "candidate_fingerprint",
                "robust_mean",
                "robust_std",
                "net_trim10_mean",
                "lift_pos_mean",
                "eligible",
                "rank",
                "error_ratio_mean",
                "profile_path",
                "decision_path",
                "generated_at",
            ]
        )


def append_leaderboard(
    path: Path,
    cycle_index: int,
    experiment_id: str,
    profile_path: Path,
    decision_path: Path,
    selected_candidates: Dict[str, Dict[str, Any]],
    main_rows: Dict[str, Dict[str, Any]],
) -> None:
    with path.open("a", encoding="utf-8", newline="") as f:
        writer = csv.writer(f)
        for config_id, row in sorted(main_rows.items()):
            candidate = selected_candidates.get(config_id)
            fingerprint = candidate["fingerprint"] if candidate else ""
            writer.writerow(
                [
                    cycle_index,
                    experiment_id,
                    config_id,
                    fingerprint,
                    row.get("robust_mean", ""),
                    row.get("robust_std", ""),
                    row.get("net_trim10_mean", ""),
                    row.get("lift_pos_mean", ""),
                    row.get("eligible", ""),
                    row.get("rank", ""),
                    row.get("error_ratio_mean", ""),
                    str(profile_path),
                    str(decision_path),
                    utc_now(),
                ]
            )


def choose_cycle_winner(
    main_rows: Dict[str, Dict[str, Any]],
) -> Tuple[str, Optional[float], bool]:
    # Keep winner selection aligned with run_cvar_next_matrix.py:
    # 1) choose top-ranked eligible config (gate-pass),
    # 2) if none eligible, fallback to H0.
    eligible: List[Tuple[Tuple[float, ...], str]] = []
    for config_id, row in main_rows.items():
        if not to_bool(row.get("eligible")):
            continue
        rank = to_int(row.get("rank"))
        robust_ci_lb = to_float(row.get("robust_ci_lb95"))
        robust_mean = to_float(row.get("robust_mean"))
        robust_std = to_float(row.get("robust_std"))
        net_trim10 = to_float(row.get("net_trim10_mean"))
        sort_key = (
            float(rank if rank is not None else 10**9),
            -(robust_ci_lb if robust_ci_lb is not None else -1e99),
            -(robust_mean if robust_mean is not None else -1e99),
            (robust_std if robust_std is not None else 1e99),
            -(net_trim10 if net_trim10 is not None else -1e99),
        )
        eligible.append((sort_key, config_id))
    if eligible:
        eligible.sort(key=lambda x: x[0])
        winner_id = eligible[0][1]
        winner_score = to_float(main_rows.get(winner_id, {}).get("robust_mean"))
        return winner_id, winner_score, True

    if "H0" in main_rows:
        winner_score = to_float(main_rows.get("H0", {}).get("robust_mean"))
        return "H0", winner_score, to_bool(main_rows.get("H0", {}).get("eligible"))

    # Defensive fallback for partial/invalid aggregates.
    best_id = ""
    best_value: Optional[float] = None
    for config_id, row in main_rows.items():
        robust = to_float(row.get("robust_mean"))
        if robust is None:
            continue
        if best_value is None or robust > best_value:
            best_value = robust
            best_id = config_id
    return best_id or "H0", best_value, False


def winner_fingerprint(
    winner_config: str,
    selected_by_id: Dict[str, Dict[str, Any]],
) -> str:
    winner_candidate = selected_by_id.get(winner_config)
    if not isinstance(winner_candidate, dict):
        return ""
    fp = winner_candidate.get("fingerprint")
    return str(fp) if fp is not None else ""


def challenger_survival_stats(
    main_rows: Dict[str, Dict[str, Any]],
) -> Tuple[int, int, float]:
    challenger_count = 0
    eligible_challenger_count = 0
    for config_id in ("H4", "H5", "H6"):
        row = main_rows.get(config_id)
        if not isinstance(row, dict):
            continue
        challenger_count += 1
        if to_bool(row.get("eligible")):
            eligible_challenger_count += 1
    survival_rate = float(eligible_challenger_count / max(1, challenger_count))
    return challenger_count, eligible_challenger_count, survival_rate


def run_cycle(
    *,
    cycle_index: int,
    repo_root: Path,
    python_bin: str,
    matrix_script: Path,
    experiment_root: str,
    experiment_prefix: str,
    matrix_seeds: str,
    profile_dir: Path,
    execute: bool,
    selected: List[Dict[str, Any]],
    stage2_on_eligible_only: bool,
) -> Dict[str, Any]:
    timestamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    experiment_id = f"{experiment_prefix}-cycle{cycle_index:03d}-{timestamp}"
    profile_name = f"search_cycle_{cycle_index:03d}"
    profile_path = profile_dir / f"{profile_name}.json"

    main_configs = {
        "H0": BASELINE_H0,
        "H4": selected[0],
        "H5": selected[1],
        "H6": selected[2],
    }
    profile_payload = {
        "profileName": profile_name,
        "mainOrder": ["H0", "H4", "H5", "H6"],
        "mainConfigs": main_configs,
    }
    profile_path.parent.mkdir(parents=True, exist_ok=True)
    profile_path.write_text(
        json.dumps(profile_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    base_cmd = [
        python_bin,
        str(matrix_script),
        "--experiment-root",
        experiment_root,
        "--experiment-id",
        experiment_id,
        "--profile-file",
        str(profile_path),
        "--seeds",
        matrix_seeds,
    ]
    stage1_cmd = list(base_cmd)
    stage2_cmd: List[str] = []
    stage1_max_runs = 0
    if execute and stage2_on_eligible_only:
        seed_count = len(parse_matrix_seeds(matrix_seeds))
        stage1_max_runs = len(main_configs) * seed_count
        stage1_cmd.extend(
            [
                "--execute",
                "--continue-on-error",
                "--max-runs",
                str(stage1_max_runs),
                "--skip-stage2",
            ]
        )
    elif execute:
        stage1_cmd.extend(["--execute", "--continue-on-error"])

    started = utc_now()
    stage1_proc = subprocess.run(stage1_cmd, cwd=str(repo_root))
    final_exit_code = stage1_proc.returncode

    experiment_dir = resolve_path(repo_root, experiment_root) / experiment_id
    main_csv = experiment_dir / "board_main_aggregate.csv"
    decision_md = experiment_dir / "decision.md"
    main_rows = parse_main_aggregate(main_csv)
    winner_id, winner_score, winner_eligible = choose_cycle_winner(main_rows)
    stage2_executed = bool(execute and not stage2_on_eligible_only)
    stage2_skip_reason = ""
    if execute and stage2_on_eligible_only and stage1_proc.returncode == 0:
        if winner_id != "H0" and winner_eligible:
            stage2_cmd = list(base_cmd)
            stage2_cmd.extend(["--execute", "--continue-on-error"])
            stage2_proc = subprocess.run(stage2_cmd, cwd=str(repo_root))
            stage2_executed = True
            final_exit_code = stage2_proc.returncode
            main_rows = parse_main_aggregate(main_csv)
            winner_id, winner_score, winner_eligible = choose_cycle_winner(main_rows)
        else:
            stage2_skip_reason = (
                f"skip stage2 because no eligible challenger winner "
                f"(winner={winner_id}, eligible={winner_eligible})"
            )

    finished = utc_now()

    selected_by_id = {"H4": selected[0], "H5": selected[1], "H6": selected[2]}
    winner_fp = winner_fingerprint(winner_id, selected_by_id)
    challenger_count, eligible_challenger_count, candidate_survival_rate = (
        challenger_survival_stats(main_rows)
    )
    commands = [stage1_cmd]
    if stage2_executed:
        commands.append(stage2_cmd)

    return {
        "schemaVersion": CYCLE_REPORT_SCHEMA_VERSION,
        "schemaFeatures": list(CYCLE_REPORT_SCHEMA_FEATURES),
        "cycleIndex": cycle_index,
        "experimentId": experiment_id,
        "profilePath": str(profile_path),
        "experimentDir": str(experiment_dir),
        "command": stage1_cmd,
        "commands": commands,
        "startedAt": started,
        "finishedAt": finished,
        "exitCode": final_exit_code,
        "stage1MaxRuns": stage1_max_runs,
        "stage2Executed": stage2_executed,
        "stage2SkipReason": stage2_skip_reason,
        "winnerConfig": winner_id,
        "winnerRobustMean": winner_score,
        "winnerEligible": winner_eligible,
        "winnerFingerprint": winner_fp,
        "challengerCount": challenger_count,
        "eligibleChallengerCount": eligible_challenger_count,
        "candidateSurvivalRate": candidate_survival_rate,
        "mainCsvPath": str(main_csv),
        "decisionPath": str(decision_md),
        "mainRows": main_rows,
        "selectedById": selected_by_id,
    }


def reconcile_state(
    *,
    state: Dict[str, Any],
    repo_root: Path,
    experiment_root: str,
) -> Tuple[Dict[str, Any], bool]:
    history_raw = state.get("history", [])
    if not isinstance(history_raw, list) or not history_raw:
        return state, False

    experiment_root_path = resolve_path(repo_root, experiment_root)
    history_sorted = sorted(
        [h for h in history_raw if isinstance(h, dict)],
        key=lambda h: int(h.get("cycleIndex", 0)),
    )
    if not history_sorted:
        return state, False

    changed = False
    rebuilt_history: List[Dict[str, Any]] = []
    best_payload: Dict[str, Any] = {}
    best_score: Optional[float] = None

    for entry in history_sorted:
        row = dict(entry)
        legacy_backfilled = bool(row.get("legacyBackfilled", False))
        experiment_id = str(row.get("experimentId", "")).strip()
        report_path_raw = row.get("reportPath")
        report_path = Path(str(report_path_raw)) if report_path_raw else None
        report_payload: Dict[str, Any] = {}
        if report_path and report_path.exists():
            try:
                parsed = json.loads(report_path.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    report_payload = parsed
            except Exception:
                report_payload = {}

        main_rows: Dict[str, Dict[str, Any]] = {}
        if isinstance(report_payload.get("mainRows"), dict):
            main_rows = report_payload["mainRows"]
        if not main_rows:
            main_csv_raw = report_payload.get("mainCsvPath")
            main_csv_path = Path(str(main_csv_raw)) if main_csv_raw else None
            if main_csv_path is None and experiment_id:
                main_csv_path = experiment_root_path / experiment_id / "board_main_aggregate.csv"
            if main_csv_path:
                main_rows = parse_main_aggregate(main_csv_path)

        winner_id, winner_score, winner_eligible = choose_cycle_winner(main_rows)
        selected_by_id = report_payload.get("selectedById")
        if not isinstance(selected_by_id, dict):
            selected_by_id = {}
        winner_fp = winner_fingerprint(winner_id, selected_by_id)

        old_winner = str(row.get("winnerConfig", "")).strip()
        old_score = to_float(row.get("winnerRobustMean"))
        if old_winner != winner_id or not same_float(old_score, winner_score):
            changed = True
        row["winnerConfig"] = winner_id
        row["winnerRobustMean"] = winner_score
        row["winnerEligible"] = winner_eligible
        if "stage2Executed" not in row:
            row["stage2Executed"] = False
            legacy_backfilled = True
            changed = True
        if "stage2SkipReason" not in row:
            row["stage2SkipReason"] = "legacy_report_without_stage2_fields"
            legacy_backfilled = True
            changed = True
        if not isinstance(row.get("selectionMeta"), dict):
            row["selectionMeta"] = {}
            legacy_backfilled = True
            changed = True
        if row.get("schemaVersion") != CYCLE_REPORT_SCHEMA_VERSION:
            row["schemaVersion"] = CYCLE_REPORT_SCHEMA_VERSION
            changed = True
        if row.get("schemaFeatures") != CYCLE_REPORT_SCHEMA_FEATURES:
            row["schemaFeatures"] = list(CYCLE_REPORT_SCHEMA_FEATURES)
            changed = True
        challenger_count, eligible_challenger_count, candidate_survival_rate = (
            challenger_survival_stats(main_rows)
        )
        if row.get("challengerCount") != challenger_count:
            row["challengerCount"] = challenger_count
            changed = True
        if row.get("eligibleChallengerCount") != eligible_challenger_count:
            row["eligibleChallengerCount"] = eligible_challenger_count
            changed = True
        old_survival = to_float(row.get("candidateSurvivalRate"))
        if not same_float(old_survival, candidate_survival_rate):
            row["candidateSurvivalRate"] = candidate_survival_rate
            changed = True
        if legacy_backfilled and not row.get("legacyBackfilled"):
            row["legacyBackfilled"] = True
            changed = True

        if (
            winner_score is not None
            and (best_score is None or winner_score > best_score)
        ):
            best_score = winner_score
            best_payload = {
                "cycleIndex": row.get("cycleIndex"),
                "experimentId": experiment_id,
                "configId": winner_id,
                "robustMean": winner_score,
                "winnerFingerprint": winner_fp,
            }
            improved = True
        else:
            improved = False
        if row.get("improvedOverBest") != improved:
            changed = True
        row["improvedOverBest"] = improved
        rebuilt_history.append(row)

        if report_payload:
            report_changed = False
            if report_payload.get("schemaVersion") != CYCLE_REPORT_SCHEMA_VERSION:
                report_payload["schemaVersion"] = CYCLE_REPORT_SCHEMA_VERSION
                report_changed = True
            if report_payload.get("schemaFeatures") != CYCLE_REPORT_SCHEMA_FEATURES:
                report_payload["schemaFeatures"] = list(CYCLE_REPORT_SCHEMA_FEATURES)
                report_changed = True
            if "stage2Executed" not in report_payload:
                report_payload["stage2Executed"] = False
                report_changed = True
            if "stage2SkipReason" not in report_payload:
                report_payload["stage2SkipReason"] = (
                    "legacy_report_without_stage2_fields"
                )
                report_changed = True
            if not isinstance(report_payload.get("selectionMeta"), dict):
                report_payload["selectionMeta"] = {}
                report_changed = True
            if report_payload.get("challengerCount") != challenger_count:
                report_payload["challengerCount"] = challenger_count
                report_changed = True
            if report_payload.get("eligibleChallengerCount") != eligible_challenger_count:
                report_payload["eligibleChallengerCount"] = eligible_challenger_count
                report_changed = True
            report_survival = to_float(report_payload.get("candidateSurvivalRate"))
            if not same_float(report_survival, candidate_survival_rate):
                report_payload["candidateSurvivalRate"] = candidate_survival_rate
                report_changed = True
            if report_payload.get("winnerConfig") != winner_id:
                report_payload["winnerConfig"] = winner_id
                report_changed = True
            if not same_float(to_float(report_payload.get("winnerRobustMean")), winner_score):
                report_payload["winnerRobustMean"] = winner_score
                report_changed = True
            if report_payload.get("winnerEligible") != winner_eligible:
                report_payload["winnerEligible"] = winner_eligible
                report_changed = True
            if report_payload.get("winnerFingerprint", "") != winner_fp:
                report_payload["winnerFingerprint"] = winner_fp
                report_changed = True
            if report_changed and report_path:
                report_path.write_text(
                    json.dumps(report_payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                changed = True

    cycles_completed = max(int(h.get("cycleIndex", 0)) for h in rebuilt_history)
    state_best = state.get("best")
    if state_best != best_payload:
        changed = True

    next_state = dict(state)
    next_state["history"] = rebuilt_history
    next_state["cyclesCompleted"] = cycles_completed
    next_state["best"] = best_payload
    next_state["searchStateSchemaVersion"] = SEARCH_STATE_SCHEMA_VERSION
    next_state["searchStateSchemaFeatures"] = list(SEARCH_STATE_SCHEMA_FEATURES)
    next_state["lastReconciledAt"] = utc_now()
    if next_state.get("lastReconciledAt") != state.get("lastReconciledAt"):
        changed = True
    return next_state, changed


def main() -> int:
    args = parse_args()
    default_repo_root = Path(__file__).resolve().parents[1]
    repo_root = (
        resolve_path(default_repo_root, args.repo_root)
        if args.repo_root
        else default_repo_root
    )
    matrix_script = resolve_path(repo_root, args.matrix_script)
    if not matrix_script.exists():
        raise FileNotFoundError(f"matrix script not found: {matrix_script}")
    if args.candidates_per_cycle != 3:
        raise ValueError("currently candidates-per-cycle must be 3 (maps to H4/H5/H6)")
    if args.history_window_cycles < 0:
        raise ValueError("--history-window-cycles must be >= 0")
    if args.min_recipe_trials < 1:
        raise ValueError("--min-recipe-trials must be >= 1")
    if not (0.0 <= args.min_recipe_lift_pass_rate <= 1.0):
        raise ValueError("--min-recipe-lift-pass-rate must be in [0, 1]")
    if not (0.0 <= args.min_recipe_eligible_rate <= 1.0):
        raise ValueError("--min-recipe-eligible-rate must be in [0, 1]")

    search_root = resolve_path(repo_root, args.search_root)
    search_root.mkdir(parents=True, exist_ok=True)
    state_path = search_root / "search_state.json"
    leaderboard_path = search_root / "search_leaderboard.csv"
    cycle_reports_dir = search_root / "cycle-reports"
    profiles_dir = search_root / "profiles"

    ensure_leaderboard(leaderboard_path)
    state = read_state(state_path)
    state, reconciled = reconcile_state(
        state=state,
        repo_root=repo_root,
        experiment_root=args.experiment_root,
    )
    if reconciled:
        write_state(state_path, state)
    tried = set(str(x) for x in state.get("triedFingerprints", []))

    pool = build_candidate_pool()
    rng = random.Random(args.search_seed + int(state.get("cyclesCompleted", 0)))
    best_anchor = resolve_anchor_from_state(state)
    total_cycles = int(args.cycles)
    execute = not bool(args.no_execute)

    cycle_counter = int(state.get("cyclesCompleted", 0))
    while True:
        if total_cycles > 0 and cycle_counter >= total_cycles:
            break
        history_stats = collect_history_gate_stats(
            state=state, max_cycles=args.history_window_cycles
        )
        selected_pool, selection_meta = apply_history_prune(
            pool=pool,
            tried=tried,
            count=args.candidates_per_cycle,
            history_stats=history_stats,
            min_trials=args.min_recipe_trials,
            min_lift_pass_rate=args.min_recipe_lift_pass_rate,
            min_eligible_rate=args.min_recipe_eligible_rate,
            enabled=not args.disable_history_prune,
        )
        selection_meta.update(
            {
                "historyWindowCycles": history_stats.get("windowCycles"),
                "historyReportsUsed": history_stats.get("reportsUsed"),
                "historySamplesUsed": history_stats.get("samplesUsed"),
            }
        )
        selection_meta["pruneEffectivenessRatio"] = float(
            selection_meta.get("prunedCount", 0)
            / max(1, int(selection_meta.get("freshPoolSize", 0)))
        )
        selected = select_candidates(
            pool=selected_pool,
            tried=set(),
            count=args.candidates_per_cycle,
            rng=rng,
            anchor=best_anchor,
        )
        if len(selected) < args.candidates_per_cycle:
            print(
                json.dumps(
                    {
                        "status": "exhausted",
                        "message": "candidate pool exhausted, stopping search",
                        "cyclesCompleted": cycle_counter,
                        "selectionMeta": selection_meta,
                    },
                    ensure_ascii=False,
                )
            )
            break

        cycle_index = cycle_counter + 1
        cycle_result = run_cycle(
            cycle_index=cycle_index,
            repo_root=repo_root,
            python_bin=args.python_bin,
            matrix_script=matrix_script,
            experiment_root=args.experiment_root,
            experiment_prefix=args.experiment_prefix,
            matrix_seeds=args.matrix_seeds,
            profile_dir=profiles_dir,
            execute=execute,
            selected=selected,
            stage2_on_eligible_only=bool(args.stage2_on_eligible_only),
        )
        cycle_result["selectionMeta"] = selection_meta

        report_path = cycle_reports_dir / f"cycle-{cycle_index:03d}.json"
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(cycle_result, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        selected_by_id = cycle_result["selectedById"]
        main_rows = cycle_result["mainRows"]
        append_leaderboard(
            leaderboard_path,
            cycle_index=cycle_index,
            experiment_id=cycle_result["experimentId"],
            profile_path=Path(cycle_result["profilePath"]),
            decision_path=Path(cycle_result["decisionPath"]),
            selected_candidates=selected_by_id,
            main_rows=main_rows,
        )

        for candidate in selected:
            tried.add(candidate["fingerprint"])

        previous_best = to_float((state.get("best") or {}).get("robustMean"))
        current_best = cycle_result["winnerRobustMean"]
        improved = current_best is not None and (
            previous_best is None or current_best > previous_best
        )
        if improved:
            state["best"] = {
                "cycleIndex": cycle_index,
                "experimentId": cycle_result["experimentId"],
                "configId": cycle_result["winnerConfig"],
                "robustMean": current_best,
                "winnerFingerprint": cycle_result["winnerFingerprint"],
            }
            anchor_candidate = parse_fingerprint(cycle_result.get("winnerFingerprint"))
            if anchor_candidate:
                best_anchor = anchor_candidate

        state["cyclesCompleted"] = cycle_index
        state["triedFingerprints"] = sorted(tried)
        state["searchStateSchemaVersion"] = SEARCH_STATE_SCHEMA_VERSION
        state["searchStateSchemaFeatures"] = list(SEARCH_STATE_SCHEMA_FEATURES)
        state.setdefault("history", []).append(
            {
                "cycleIndex": cycle_index,
                "experimentId": cycle_result["experimentId"],
                "schemaVersion": CYCLE_REPORT_SCHEMA_VERSION,
                "schemaFeatures": list(CYCLE_REPORT_SCHEMA_FEATURES),
                "winnerConfig": cycle_result["winnerConfig"],
                "winnerRobustMean": cycle_result["winnerRobustMean"],
                "winnerEligible": cycle_result["winnerEligible"],
                "challengerCount": cycle_result.get("challengerCount", 0),
                "eligibleChallengerCount": cycle_result.get(
                    "eligibleChallengerCount", 0
                ),
                "candidateSurvivalRate": cycle_result.get("candidateSurvivalRate", 0.0),
                "exitCode": cycle_result["exitCode"],
                "profilePath": cycle_result["profilePath"],
                "reportPath": str(report_path),
                "improvedOverBest": improved,
                "stage2Executed": cycle_result.get("stage2Executed", False),
                "stage2SkipReason": cycle_result.get("stage2SkipReason", ""),
                "selectionMeta": selection_meta,
                "generatedAt": utc_now(),
            }
        )
        write_state(state_path, state)

        print(
            json.dumps(
                {
                    "cycleIndex": cycle_index,
                    "experimentId": cycle_result["experimentId"],
                    "exitCode": cycle_result["exitCode"],
                    "winnerConfig": cycle_result["winnerConfig"],
                    "winnerRobustMean": cycle_result["winnerRobustMean"],
                    "winnerEligible": cycle_result["winnerEligible"],
                    "stage2Executed": cycle_result.get("stage2Executed", False),
                    "stage2SkipReason": cycle_result.get("stage2SkipReason", ""),
                    "selectionMeta": selection_meta,
                    "bestSoFar": state.get("best", {}),
                    "searchRoot": str(search_root),
                },
                ensure_ascii=False,
            )
        )

        cycle_counter = cycle_index
        if cycle_result["exitCode"] != 0:
            print(
                json.dumps(
                    {
                        "status": "stopped_on_failure",
                        "cycleIndex": cycle_index,
                        "experimentId": cycle_result["experimentId"],
                    },
                    ensure_ascii=False,
                )
            )
            break

        if total_cycles > 0 and cycle_counter >= total_cycles:
            break
        if args.sleep_seconds > 0:
            time.sleep(args.sleep_seconds)

    print(
        json.dumps(
            {
                "status": "done",
                "cyclesCompleted": state.get("cyclesCompleted", cycle_counter),
                "best": state.get("best", {}),
                "statePath": str(state_path),
                "leaderboardPath": str(leaderboard_path),
                "searchRoot": str(search_root),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
