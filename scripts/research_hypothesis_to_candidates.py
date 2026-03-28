#!/usr/bin/env python3
"""Compile executable strategy candidates from hypothesis backlog."""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple


DEFAULT_HYPOTHESES = "data/research/hypotheses/backlog.v1.json"
DEFAULT_BASE_CANDIDATES = "docs/research/strategy_candidates.v1.json"
DEFAULT_OUTPUT = "docs/research/strategy_candidates.v1.json"
DEFAULT_ARCHIVE_ROOT = "data/research/strategy/candidate_compile/archive"
DEFAULT_BEST_TRIPLET = "data/research/strategy/local_search/best_trend_triplet.latest.v1.json"
COMPLEXITY_PROFILE_DEFAULT = "default"
COMPLEXITY_PROFILE_LOW = "low"

CANDIDATE_MODE_AUTO = "auto"
CANDIDATE_MODE_LOCK_BEST_TRIPLET = "lock_best_triplet"
CANDIDATE_MODE_BLEND = "blend"

THEME_REGIME = "regime"
THEME_COST = "cost"
THEME_RISK = "risk"
THEME_POLICY = "policy"
THEME_GENERAL = "general"

STRATEGY_TREND = "trend"
STRATEGY_MEAN_REVERSION = "meanReversion"
STRATEGY_BREAKOUT = "breakout"
STRATEGY_ENSEMBLE = "ensemble"

TREND_VARIANTS: List[Dict[str, Any]] = [
    {"trendFastPeriod": 34, "trendSlowPeriod": 75, "allowShort": True},
    {"trendFastPeriod": 18, "trendSlowPeriod": 80, "allowShort": True},
    {"trendFastPeriod": 34, "trendSlowPeriod": 65, "allowShort": True},
]

LOW_COMPLEXITY_TREND_VARIANTS: List[Dict[str, Any]] = [
    {"trendFastPeriod": 21, "trendSlowPeriod": 70, "allowShort": False},
    {"trendFastPeriod": 24, "trendSlowPeriod": 72, "allowShort": False},
    {"trendFastPeriod": 30, "trendSlowPeriod": 90, "allowShort": False},
    {"trendFastPeriod": 34, "trendSlowPeriod": 100, "allowShort": False},
]

MEAN_REVERSION_VARIANTS: List[Dict[str, Any]] = [
    {
        "rsiPeriod": 14,
        "rsiOversold": 30,
        "rsiOverbought": 70,
        "bbPeriod": 20,
        "bbStdDev": 2.0,
        "allowShort": False,
    },
    {
        "rsiPeriod": 12,
        "rsiOversold": 28,
        "rsiOverbought": 72,
        "bbPeriod": 20,
        "bbStdDev": 2.0,
        "allowShort": True,
    },
    {
        "rsiPeriod": 18,
        "rsiOversold": 30,
        "rsiOverbought": 75,
        "bbPeriod": 24,
        "bbStdDev": 2.2,
        "allowShort": False,
    },
]

BREAKOUT_VARIANTS: List[Dict[str, Any]] = [
    {"breakoutPeriod": 40, "breakoutExitPeriod": 12, "allowShort": True},
    {"breakoutPeriod": 48, "breakoutExitPeriod": 16, "allowShort": False},
    {"breakoutPeriod": 60, "breakoutExitPeriod": 20, "allowShort": True},
]

ENSEMBLE_VARIANTS: List[Dict[str, Any]] = [
    {
        "allowShort": False,
        "trendFastPeriod": 20,
        "trendSlowPeriod": 60,
        "rsiPeriod": 14,
        "rsiOversold": 30,
        "rsiOverbought": 70,
        "bbPeriod": 20,
        "bbStdDev": 2.0,
        "breakoutPeriod": 40,
        "breakoutExitPeriod": 12,
        "ensembleThreshold": 0.40,
        "ensembleWeights": {"trend": 2, "meanReversion": 1, "breakout": 2},
    },
    {
        "allowShort": True,
        "trendFastPeriod": 18,
        "trendSlowPeriod": 55,
        "rsiPeriod": 14,
        "rsiOversold": 30,
        "rsiOverbought": 70,
        "bbPeriod": 20,
        "bbStdDev": 2.0,
        "breakoutPeriod": 36,
        "breakoutExitPeriod": 10,
        "ensembleThreshold": 0.34,
        "ensembleWeights": {"trend": 2, "meanReversion": 1, "breakout": 1},
    },
    {
        "allowShort": False,
        "trendFastPeriod": 21,
        "trendSlowPeriod": 70,
        "rsiPeriod": 14,
        "rsiOversold": 30,
        "rsiOverbought": 70,
        "bbPeriod": 20,
        "bbStdDev": 2.0,
        "breakoutPeriod": 48,
        "breakoutExitPeriod": 14,
        "ensembleThreshold": 0.42,
        "ensembleWeights": {"trend": 1, "meanReversion": 1, "breakout": 2},
    },
]

VARIANT_BY_STRATEGY: Dict[str, List[Dict[str, Any]]] = {
    STRATEGY_TREND: TREND_VARIANTS,
    STRATEGY_MEAN_REVERSION: MEAN_REVERSION_VARIANTS,
    STRATEGY_BREAKOUT: BREAKOUT_VARIANTS,
    STRATEGY_ENSEMBLE: ENSEMBLE_VARIANTS,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compile strategy_candidates.v1 from research hypotheses.",
    )
    parser.add_argument(
        "--hypotheses",
        default=DEFAULT_HYPOTHESES,
        help="Path to hypothesis_backlog.v1.json.",
    )
    parser.add_argument(
        "--base-candidates",
        default=DEFAULT_BASE_CANDIDATES,
        help="Base strategy_candidates.v1 JSON used as immutable config template.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output path for compiled strategy_candidates.v1 JSON.",
    )
    parser.add_argument(
        "--archive-root",
        default=DEFAULT_ARCHIVE_ROOT,
        help="Archive root for emitted candidate sets.",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id (default: UTC timestamp).",
    )
    parser.add_argument(
        "--plan",
        default="A",
        choices=["A", "B", "legacy"],
        help="Compilation mode: A conservative, B exploratory, legacy fallback.",
    )
    parser.add_argument(
        "--candidate-count",
        type=int,
        default=3,
        help="Number of candidates to output (minimum 3 is recommended).",
    )
    parser.add_argument(
        "--max-hypotheses",
        type=int,
        default=20,
        help="Maximum hypotheses to inspect (sorted by priority).",
    )
    parser.add_argument(
        "--best-triplet",
        default=DEFAULT_BEST_TRIPLET,
        help="Path to best trend triplet JSON used by candidate-mode blend/lock_best_triplet.",
    )
    parser.add_argument(
        "--candidate-mode",
        default=CANDIDATE_MODE_AUTO,
        choices=[
            CANDIDATE_MODE_AUTO,
            CANDIDATE_MODE_LOCK_BEST_TRIPLET,
            CANDIDATE_MODE_BLEND,
        ],
        help="Candidate composition mode.",
    )
    parser.add_argument(
        "--complexity-profile",
        default=COMPLEXITY_PROFILE_DEFAULT,
        choices=[COMPLEXITY_PROFILE_DEFAULT, COMPLEXITY_PROFILE_LOW],
        help=(
            "Candidate complexity profile. "
            "low enforces long-only simplified trend candidates."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files; print compiled payload preview.",
    )
    argv = [arg for arg in sys.argv[1:] if arg != "--"]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def utc_run_id() -> str:
    return now_utc().strftime("%Y%m%dT%H%M%SZ")


def utc_iso() -> str:
    return now_utc().isoformat(timespec="seconds").replace("+00:00", "Z")


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


def load_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must be a JSON object")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_text(raw: Any) -> str:
    return " ".join(str(raw or "").split()).strip()


def to_float(raw: Any, default: float = 0.0) -> float:
    try:
        return float(raw)
    except Exception:
        return default


def nearest_choice(value: int, choices: Sequence[int]) -> int:
    if not choices:
        return int(value)
    return min((int(item) for item in choices), key=lambda item: (abs(item - int(value)), item))


def simplify_trend_params(raw: Dict[str, Any]) -> Dict[str, Any]:
    fast_choices = sorted({int(row["trendFastPeriod"]) for row in LOW_COMPLEXITY_TREND_VARIANTS})
    slow_choices = sorted({int(row["trendSlowPeriod"]) for row in LOW_COMPLEXITY_TREND_VARIANTS})
    fast_raw = int(raw.get("trendFastPeriod", 24))
    slow_raw = int(raw.get("trendSlowPeriod", 72))
    fast = nearest_choice(fast_raw, fast_choices)
    min_slow = fast + 24
    allowed_slows = [value for value in slow_choices if value >= min_slow] or [slow_choices[-1]]
    slow = nearest_choice(slow_raw, allowed_slows)
    if fast >= slow:
        slow = max(slow, fast + 1)
    return {
        "trendFastPeriod": int(fast),
        "trendSlowPeriod": int(slow),
        "allowShort": False,
    }


def rewrite_candidates_for_complexity(
    candidates: Sequence[Dict[str, Any]],
    *,
    complexity_profile: str,
    target_count: int,
) -> List[Dict[str, Any]]:
    if complexity_profile != COMPLEXITY_PROFILE_LOW:
        return [copy.deepcopy(row) for row in candidates[:target_count]]

    rewritten: List[Dict[str, Any]] = []
    used: set[str] = set()
    for index, row in enumerate(candidates):
        if len(rewritten) >= target_count:
            break
        if not isinstance(row, dict):
            continue
        strategy = normalize_text(row.get("strategy")) or STRATEGY_TREND
        params = row.get("params")
        if not isinstance(params, dict):
            continue
        if strategy != STRATEGY_TREND:
            params = copy.deepcopy(LOW_COMPLEXITY_TREND_VARIANTS[index % len(LOW_COMPLEXITY_TREND_VARIANTS)])
            strategy = STRATEGY_TREND
        else:
            params = simplify_trend_params(params)
        key = candidate_key(strategy, params)
        if key in used:
            continue
        used.add(key)
        row_copy = copy.deepcopy(row)
        row_copy["strategy"] = strategy
        row_copy["params"] = params
        rewritten.append(row_copy)

    idx = 0
    while len(rewritten) < target_count:
        params = copy.deepcopy(LOW_COMPLEXITY_TREND_VARIANTS[idx % len(LOW_COMPLEXITY_TREND_VARIANTS)])
        idx += 1
        key = candidate_key(STRATEGY_TREND, params)
        if key in used:
            continue
        used.add(key)
        rewritten.append(
            {
                "strategyId": f"HC{len(rewritten)+1:03d}_LOW",
                "strategyName": f"trend_low_complexity_{len(rewritten)+1:02d}",
                "strategy": STRATEGY_TREND,
                "params": params,
            }
        )
    return rewritten


def priority_sorted_hypotheses(payload: Dict[str, Any], max_items: int) -> List[Dict[str, Any]]:
    rows = payload.get("hypotheses", [])
    if not isinstance(rows, list):
        return []
    normalized: List[Dict[str, Any]] = []
    for item in rows:
        if not isinstance(item, dict):
            continue
        normalized.append(item)
    normalized.sort(
        key=lambda row: (
            to_float(row.get("priority"), 0.0),
            normalize_text(row.get("paperId")),
        ),
        reverse=True,
    )
    return normalized[: max(0, int(max_items))]


def classify_theme(hypothesis: Dict[str, Any]) -> str:
    text = " ".join(
        [
            normalize_text(hypothesis.get("title")),
            normalize_text(hypothesis.get("actionHint")),
            normalize_text(hypothesis.get("expectedImpact")),
            normalize_text(hypothesis.get("targetMetric")),
            normalize_text(hypothesis.get("testPlan")),
        ]
    ).lower()

    if any(token in text for token in ("regime", "change-point", "hmm", "wfofailuredensity")):
        return THEME_REGIME
    if any(token in text for token in ("transaction-cost", "slippage", "liquidity", "execution", "net_trim10")):
        return THEME_COST
    if any(token in text for token in ("cvar", "tail-risk", "drawdown", "fdr", "uncertainty")):
        return THEME_RISK
    if any(token in text for token in ("reinforcement", "policy", "bandit", "meta-learning")):
        return THEME_POLICY
    return THEME_GENERAL


def strategy_for_theme(theme: str, plan: str) -> str:
    if plan == "A":
        return {
            THEME_REGIME: STRATEGY_TREND,
            THEME_COST: STRATEGY_TREND,
            THEME_RISK: STRATEGY_TREND,
            THEME_POLICY: STRATEGY_TREND,
            THEME_GENERAL: STRATEGY_TREND,
        }.get(theme, STRATEGY_TREND)
    if plan == "B":
        return {
            THEME_REGIME: STRATEGY_TREND,
            THEME_COST: STRATEGY_TREND,
            THEME_RISK: STRATEGY_TREND,
            THEME_POLICY: STRATEGY_TREND,
            THEME_GENERAL: STRATEGY_TREND,
        }.get(theme, STRATEGY_TREND)
    return STRATEGY_TREND


def stable_seed(parts: Iterable[str]) -> int:
    joined = "|".join(parts)
    digest = hashlib.sha256(joined.encode("utf-8")).hexdigest()
    return int(digest[:8], 16)


def candidate_key(strategy: str, params: Dict[str, Any]) -> str:
    return f"{strategy}:{json.dumps(params, sort_keys=True, ensure_ascii=True)}"


def pick_variant(
    *,
    strategy: str,
    seed: int,
    used: set[str],
) -> Tuple[Dict[str, Any], bool]:
    variants = VARIANT_BY_STRATEGY.get(strategy, [])
    if not variants:
        return {}, False
    count = len(variants)
    for offset in range(count):
        idx = (seed + offset) % count
        params = copy.deepcopy(variants[idx])
        key = candidate_key(strategy, params)
        if key in used:
            continue
        used.add(key)
        return params, True
    return {}, False


def make_candidate(
    *,
    idx: int,
    hypothesis: Dict[str, Any],
    theme: str,
    strategy: str,
    params: Dict[str, Any],
) -> Dict[str, Any]:
    paper_id = normalize_text(hypothesis.get("paperId")) or f"paper-{idx:03d}"
    tag = theme[:3].upper()
    strategy_name = f"{strategy}_{theme}_{paper_id.replace('/', '_')[:24]}"
    return {
        "strategyId": f"HC{idx:03d}_{tag}",
        "strategyName": strategy_name,
        "strategy": strategy,
        "params": params,
    }


def normalize_base_candidates(base_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows = base_payload.get("candidates")
    if not isinstance(rows, list):
        return []
    out: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        strategy = normalize_text(row.get("strategy"))
        params = row.get("params")
        if strategy not in VARIANT_BY_STRATEGY:
            continue
        if not isinstance(params, dict):
            continue
        out.append(
            {
                "strategyId": normalize_text(row.get("strategyId")) or f"BASE{len(out)+1:03d}",
                "strategyName": normalize_text(row.get("strategyName")) or f"{strategy}_base",
                "strategy": strategy,
                "params": copy.deepcopy(params),
            }
        )
    return out


def load_best_triplet_candidates(path: Path) -> Tuple[List[Dict[str, Any]], Dict[str, Any]]:
    raw_payload = json.loads(path.read_text(encoding="utf-8"))
    rows: Any
    source_type = ""
    schema_version = ""
    if isinstance(raw_payload, dict):
        rows = raw_payload.get("triplet")
        if rows is None:
            rows = raw_payload.get("candidates")
        source_type = "object"
        schema_version = normalize_text(raw_payload.get("schemaVersion"))
    elif isinstance(raw_payload, list):
        rows = raw_payload
        source_type = "array"
    else:
        raise ValueError(f"{path} must be a JSON object or array")

    if not isinstance(rows, list):
        raise ValueError(f"{path} must contain a list under 'triplet' or 'candidates'")
    if len(rows) != 3:
        raise ValueError(f"{path} must contain exactly 3 candidates")

    seen: set[str] = set()
    triplet: List[Dict[str, Any]] = []
    for idx, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise ValueError(f"{path} candidate[{idx}] must be an object")
        strategy = normalize_text(row.get("strategy")) or STRATEGY_TREND
        if strategy != STRATEGY_TREND:
            raise ValueError(f"{path} candidate[{idx}] strategy must be '{STRATEGY_TREND}'")
        params = row.get("params")
        if not isinstance(params, dict):
            raise ValueError(f"{path} candidate[{idx}] params must be an object")
        params_copy = copy.deepcopy(params)
        key = candidate_key(strategy, params_copy)
        if key in seen:
            raise ValueError(f"{path} contains duplicate trend candidates")
        seen.add(key)
        triplet.append(
            {
                "strategyId": normalize_text(row.get("strategyId")) or f"BT{idx:03d}",
                "strategyName": normalize_text(row.get("strategyName")) or f"{strategy}_best_triplet_{idx}",
                "strategy": strategy,
                "params": params_copy,
            }
        )

    return triplet, {"schemaVersion": schema_version, "sourceType": source_type}


def summarize_theme_counts(themes_used: Sequence[str]) -> Dict[str, int]:
    theme_counts: Dict[str, int] = {}
    for theme in themes_used:
        theme_counts[theme] = theme_counts.get(theme, 0) + 1
    return theme_counts


def compile_candidates(
    *,
    hypotheses: Sequence[Dict[str, Any]],
    base_candidates: Sequence[Dict[str, Any]],
    candidate_count: int,
    plan: str,
    seed_candidates: Sequence[Dict[str, Any]] | None = None,
    strict_fill: bool = False,
) -> Tuple[List[Dict[str, Any]], Dict[str, int], List[str]]:
    target_count = max(int(candidate_count), 3)
    used: set[str] = set()
    chosen: List[Dict[str, Any]] = []
    themes_used: List[str] = []
    strategy_counts: Dict[str, int] = {}

    for row in seed_candidates or []:
        if len(chosen) >= target_count:
            break
        strategy = normalize_text(row.get("strategy"))
        params = row.get("params")
        if strategy not in VARIANT_BY_STRATEGY or not isinstance(params, dict):
            continue
        key = candidate_key(strategy, params)
        if key in used:
            continue
        used.add(key)
        row_copy = copy.deepcopy(row)
        row_copy["strategyId"] = normalize_text(row_copy.get("strategyId")) or f"HC{len(chosen)+1:03d}_BST"
        row_copy["strategyName"] = normalize_text(row_copy.get("strategyName")) or f"{strategy}_best_triplet"
        row_copy["strategy"] = strategy
        row_copy["params"] = copy.deepcopy(params)
        chosen.append(row_copy)
        themes_used.append("bestTriplet")
        strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1

    for row in hypotheses:
        if len(chosen) >= target_count:
            break
        theme = classify_theme(row)
        strategy = strategy_for_theme(theme, plan)
        if plan == "B" and strategy in {STRATEGY_BREAKOUT, STRATEGY_MEAN_REVERSION}:
            # Keep B track exploratory but prevent domination by one unstable family.
            if strategy_counts.get(strategy, 0) >= 1:
                strategy = STRATEGY_TREND
        seed = stable_seed(
            [
                normalize_text(row.get("id")),
                normalize_text(row.get("paperId")),
                theme,
                strategy,
                plan,
            ]
        )
        params, ok = pick_variant(strategy=strategy, seed=seed, used=used)
        if not ok:
            continue
        candidate = make_candidate(
            idx=len(chosen) + 1,
            hypothesis=row,
            theme=theme,
            strategy=strategy,
            params=params,
        )
        chosen.append(candidate)
        themes_used.append(theme)
        strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1

    for row in base_candidates:
        if len(chosen) >= target_count:
            break
        strategy = normalize_text(row.get("strategy"))
        params = row.get("params")
        if strategy not in VARIANT_BY_STRATEGY or not isinstance(params, dict):
            continue
        key = candidate_key(strategy, params)
        if key in used:
            continue
        used.add(key)
        row_copy = copy.deepcopy(row)
        row_copy["strategyId"] = f"HC{len(chosen)+1:03d}_BASE"
        chosen.append(row_copy)
        themes_used.append("base")
        strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1

    fallback_order = [
        STRATEGY_TREND,
        STRATEGY_MEAN_REVERSION,
        STRATEGY_BREAKOUT,
        STRATEGY_ENSEMBLE,
    ]
    while len(chosen) < target_count:
        if strict_fill:
            appended = False
            base_idx = len(chosen)
            for offset in range(len(fallback_order)):
                strategy = fallback_order[(base_idx + offset) % len(fallback_order)]
                seed = stable_seed([strategy, plan, str(base_idx), str(offset)])
                params, ok = pick_variant(strategy=strategy, seed=seed, used=used)
                if not ok:
                    continue
                chosen.append(
                    {
                        "strategyId": f"HC{len(chosen)+1:03d}_FBK",
                        "strategyName": f"{strategy}_fallback",
                        "strategy": strategy,
                        "params": params,
                    }
                )
                themes_used.append("fallback")
                strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1
                appended = True
                break
            if not appended:
                break
        else:
            strategy = fallback_order[len(chosen) % len(fallback_order)]
            seed = stable_seed([strategy, plan, str(len(chosen))])
            params, ok = pick_variant(strategy=strategy, seed=seed, used=used)
            if not ok:
                break
            chosen.append(
                {
                    "strategyId": f"HC{len(chosen)+1:03d}_FBK",
                    "strategyName": f"{strategy}_fallback",
                    "strategy": strategy,
                    "params": params,
                }
            )
            themes_used.append("fallback")
            strategy_counts[strategy] = strategy_counts.get(strategy, 0) + 1

    theme_counts = summarize_theme_counts(themes_used)
    return chosen, theme_counts, themes_used


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]

    hypotheses_path = resolve_path(repo_root, args.hypotheses)
    base_path = resolve_path(repo_root, args.base_candidates)
    output_path = resolve_path(repo_root, args.output)
    archive_root = resolve_path(repo_root, args.archive_root)
    best_triplet_path = resolve_path(repo_root, args.best_triplet)
    run_id = normalize_text(args.run_id) or utc_run_id()
    candidate_mode_requested = normalize_text(args.candidate_mode) or CANDIDATE_MODE_AUTO
    candidate_mode_effective = candidate_mode_requested
    complexity_profile = normalize_text(args.complexity_profile) or COMPLEXITY_PROFILE_DEFAULT

    hypotheses_payload = load_json(hypotheses_path)
    base_payload = load_json(base_path)

    hypotheses = priority_sorted_hypotheses(
        hypotheses_payload,
        max_items=max(int(args.max_hypotheses), 0),
    )
    base_candidates = normalize_base_candidates(base_payload)

    best_triplet_candidates: List[Dict[str, Any]] = []
    best_triplet_meta: Dict[str, Any] = {"schemaVersion": "", "sourceType": "unloaded", "loaded": False}
    if candidate_mode_requested == CANDIDATE_MODE_LOCK_BEST_TRIPLET:
        best_triplet_candidates, loaded_meta = load_best_triplet_candidates(best_triplet_path)
        best_triplet_meta.update(loaded_meta)
        best_triplet_meta["loaded"] = True
    elif candidate_mode_requested == CANDIDATE_MODE_BLEND:
        try:
            best_triplet_candidates, loaded_meta = load_best_triplet_candidates(best_triplet_path)
            best_triplet_meta.update(loaded_meta)
            best_triplet_meta["loaded"] = True
        except Exception as exc:  # noqa: BLE001
            # Blend mode is resilient: fallback to auto when no usable best-triplet is available.
            best_triplet_meta["error"] = normalize_text(exc)
            best_triplet_meta["loaded"] = False
            candidate_mode_effective = CANDIDATE_MODE_AUTO

    if candidate_mode_effective == CANDIDATE_MODE_LOCK_BEST_TRIPLET:
        compiled = copy.deepcopy(best_triplet_candidates)
        themes_used = ["bestTriplet"] * len(compiled)
        theme_counts = summarize_theme_counts(themes_used)
    elif candidate_mode_effective == CANDIDATE_MODE_BLEND:
        compiled, theme_counts, themes_used = compile_candidates(
            hypotheses=hypotheses,
            base_candidates=base_candidates,
            candidate_count=max(int(args.candidate_count), 3),
            plan=args.plan,
            seed_candidates=best_triplet_candidates,
            strict_fill=True,
        )
    else:
        compiled, theme_counts, themes_used = compile_candidates(
            hypotheses=hypotheses,
            base_candidates=base_candidates,
            candidate_count=max(int(args.candidate_count), 3),
            plan=args.plan,
            seed_candidates=[],
            strict_fill=False,
        )

    compiled = rewrite_candidates_for_complexity(
        compiled,
        complexity_profile=complexity_profile,
        target_count=max(int(args.candidate_count), 3),
    )

    output_payload = copy.deepcopy(base_payload)
    output_payload["schemaVersion"] = "strategy_candidates.v1"
    output_payload["generatedAt"] = utc_iso()
    output_payload["candidates"] = compiled
    output_payload["hypothesisCompile"] = {
        "schemaVersion": "hypothesis_candidate_compile.v1",
        "runId": run_id,
        "generatedAt": utc_iso(),
        "plan": args.plan,
        "inputs": {
            "hypotheses": str(hypotheses_path),
            "baseCandidates": str(base_path),
            "bestTripletSource": str(best_triplet_path),
            "bestTripletSchemaVersion": best_triplet_meta.get("schemaVersion", ""),
            "bestTripletSourceType": best_triplet_meta.get("sourceType", ""),
        },
        "stats": {
            "inspectedHypotheses": len(hypotheses),
            "outputCandidates": len(compiled),
            "themeCounts": theme_counts,
            "candidateModeRequested": candidate_mode_requested,
            "candidateModeEffective": candidate_mode_effective,
            "complexityProfile": complexity_profile,
            "bestTripletLoaded": bool(best_triplet_meta.get("loaded")),
            "bestTripletSeedCount": len(best_triplet_candidates),
            "bestTripletLoadError": best_triplet_meta.get("error", ""),
        },
        "themesUsed": themes_used,
    }

    archive_path = archive_root / run_id / "strategy_candidates.v1.json"
    latest_report_path = archive_root.parent / "latest_hypothesis_candidate_compile.v1.json"
    latest_report = {
        "schemaVersion": "hypothesis_candidate_compile_report.v1",
        "generatedAt": utc_iso(),
        "runId": run_id,
        "plan": args.plan,
        "output": str(output_path),
        "archive": str(archive_path),
        "candidateCount": len(compiled),
        "themeCounts": theme_counts,
        "candidateModeRequested": candidate_mode_requested,
        "candidateModeEffective": candidate_mode_effective,
        "complexityProfile": complexity_profile,
        "bestTripletSource": str(best_triplet_path),
    }

    if not args.dry_run:
        write_json(output_path, output_payload)
        write_json(archive_path, output_payload)
        write_json(latest_report_path, latest_report)

    print(
        json.dumps(
            {
                "runId": run_id,
                "plan": args.plan,
                "hypothesesInspected": len(hypotheses),
                "candidateCount": len(compiled),
                "output": str(output_path),
                "archive": str(archive_path),
                "themeCounts": theme_counts,
                "candidateModeRequested": candidate_mode_requested,
                "candidateModeEffective": candidate_mode_effective,
                "complexityProfile": complexity_profile,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
