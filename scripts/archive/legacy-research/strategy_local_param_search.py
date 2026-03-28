#!/usr/bin/env python3
"""Trend-only local parameter search for strategy MVP validation.

This script executes real trial runs against:
  pnpm tsx scripts/run_strategy_mvp_validation.ts

Design constraints:
- exactly 3 trend candidates per trial
- enforce trendFastPeriod < trendSlowPeriod for every candidate
- include two fixed anchor trials (baseline + known_best)
- deterministic trial generation via --seed
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import random
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


CANDIDATE_COUNT = 3
BASELINE_FDRQ = 0.3697723252360454
THRESHOLD_BREAK_TARGET = 0.3497723252360454
PBO_THRESHOLD_TARGET = 0.2
BASE_CANDIDATES_REL = "docs/research/strategy_candidates.v1.json"
DEFAULT_REPORT_OUTPUT = "data/research/strategy/local_search/latest_local_param_search.v1.json"
DEFAULT_BEST_OUTPUT = "data/research/strategy/local_search/best_trend_triplet.latest.v1.json"
COMPLEXITY_PROFILE_DEFAULT = "default"
COMPLEXITY_PROFILE_LOW = "low"

MIN_FAST = 6
MAX_FAST = 90
MIN_SLOW = 16
MAX_SLOW = 220

LOW_COMPLEXITY_FAST_CHOICES: Tuple[int, ...] = (18, 21, 24, 30, 34)
LOW_COMPLEXITY_SLOW_CHOICES: Tuple[int, ...] = (60, 70, 72, 80, 90, 100, 120)

# Baseline anchor from legacy stable trend trio.
BASELINE_ANCHOR: List[Dict[str, Any]] = [
    {"trendFastPeriod": 21, "trendSlowPeriod": 70, "allowShort": True},
    {"trendFastPeriod": 34, "trendSlowPeriod": 89, "allowShort": True},
    {"trendFastPeriod": 24, "trendSlowPeriod": 72, "allowShort": True},
]

# Known-best anchor found via recent local search.
KNOWN_BEST_ANCHOR: List[Dict[str, Any]] = [
    {"trendFastPeriod": 34, "trendSlowPeriod": 75, "allowShort": True},
    {"trendFastPeriod": 18, "trendSlowPeriod": 80, "allowShort": True},
    {"trendFastPeriod": 34, "trendSlowPeriod": 65, "allowShort": True},
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run trend-only local parameter search (3 candidates/trial) "
            "with baseline/known_best anchors."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--trials",
        type=int,
        default=60,
        help="Number of trials to run. Must be >= 2 (baseline + known_best anchors).",
    )
    parser.add_argument(
        "--iterations",
        type=int,
        default=0,
        help="Alias of --trials for compatibility with orchestration commands.",
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=20260303,
        help="Deterministic RNG seed for candidate generation.",
    )
    parser.add_argument(
        "--wfo-profile",
        default="shift",
        choices=["stable", "shift", "stress"],
        help="WFO profile forwarded to run_strategy_mvp_validation.ts.",
    )
    parser.add_argument(
        "--mode",
        default="local",
        choices=["local", "wide"],
        help="Search radius mode for non-anchor trials.",
    )
    parser.add_argument(
        "--aggressive",
        action="store_true",
        help="Compatibility flag: force wide search mode.",
    )
    parser.add_argument(
        "--plan",
        default="A",
        choices=["A", "B", "C"],
        help="Plan label attached to report metadata.",
    )
    parser.add_argument(
        "--focus-range",
        default="",
        help="Optional compatibility metadata (e.g. 0.8-1.2).",
    )
    parser.add_argument(
        "--target",
        default="fdr",
        choices=["fdr", "pbo", "wfo", "composite"],
        help="Ranking target for best trial selection.",
    )
    parser.add_argument(
        "--constraint",
        default="none",
        choices=["none", "fdr", "pbo", "both"],
        help="Optional hard-priority constraint during ranking.",
    )
    parser.add_argument(
        "--fdr-max",
        type=float,
        default=0.1,
        help="FDR upper bound used by constrained/composite ranking.",
    )
    parser.add_argument(
        "--pbo-max",
        type=float,
        default=PBO_THRESHOLD_TARGET,
        help="PBO upper bound used by constrained/composite ranking.",
    )
    parser.add_argument(
        "--fdr-weight",
        type=float,
        default=0.5,
        help="FDR weight for composite target.",
    )
    parser.add_argument(
        "--pbo-weight",
        type=float,
        default=0.5,
        help="PBO weight for composite target.",
    )
    parser.add_argument(
        "--complexity-profile",
        default=COMPLEXITY_PROFILE_DEFAULT,
        choices=[COMPLEXITY_PROFILE_DEFAULT, COMPLEXITY_PROFILE_LOW],
        help=(
            "Candidate complexity profile. "
            "low enforces simpler long-only trend params for better generalization."
        ),
    )
    parser.add_argument(
        "--fdr-method",
        default="bh",
        choices=[
            "bh",
            "by",
            "storey_bh",
            "regime_segmented_bh",
            "cv_storey_bh",
            "stability_bh",
        ],
        help="FDR method forwarded to run_strategy_mvp_validation.ts.",
    )
    parser.add_argument(
        "--fdr-storey-lambda",
        type=float,
        default=0.5,
        help="Storey lambda in [0, 1); used only when --fdr-method=storey_bh.",
    )
    parser.add_argument(
        "--regime-method",
        default="change_point",
        help=(
            "Regime detector forwarded to run_strategy_mvp_validation.ts when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-max-segments",
        type=int,
        default=4,
        help=(
            "Upper bound on regime segments forwarded when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-min-segment-bars",
        type=int,
        default=240,
        help=(
            "Minimum bars per regime segment forwarded when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-min-windows",
        type=int,
        default=2,
        help=(
            "Minimum WFO windows per regime forwarded when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-aggregation",
        default="weighted_mean",
        choices=["max", "weighted_mean"],
        help=(
            "Regime p-value aggregation forwarded when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--cv-agg-quantile",
        type=float,
        default=0.75,
        help="Window p-value quantile aggregation for --fdr-method=cv_storey_bh.",
    )
    parser.add_argument(
        "--stability-bootstraps",
        type=int,
        default=120,
        help="Bootstrap rounds for --fdr-method=stability_bh.",
    )
    parser.add_argument(
        "--stability-subsample-frac",
        type=float,
        default=0.7,
        help="Window subsample fraction for --fdr-method=stability_bh.",
    )
    parser.add_argument(
        "--stability-min-frequency",
        type=float,
        default=0.7,
        help="Selection frequency threshold for --fdr-method=stability_bh.",
    )
    parser.add_argument(
        "--stability-select-p",
        type=float,
        default=0.2,
        help="Bootstrap selection p-value cut for --fdr-method=stability_bh.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_REPORT_OUTPUT,
        help="Output path for local_param_search_report.v1 JSON.",
    )
    parser.add_argument(
        "--best-output",
        default=DEFAULT_BEST_OUTPUT,
        help="Output path for best_trend_triplet.v1 JSON.",
    )
    argv = [arg for arg in sys.argv[1:] if arg != "--"]
    args = parser.parse_args(argv)
    if int(getattr(args, "iterations", 0)) > 0:
        args.trials = int(args.iterations)
    if bool(getattr(args, "aggressive", False)):
        args.mode = "wide"
    if not (0 < float(args.fdr_max) <= 1):
        raise SystemExit("--fdr-max must be in (0, 1].")
    if not (0 < float(args.pbo_max) <= 1):
        raise SystemExit("--pbo-max must be in (0, 1].")
    if float(args.fdr_weight) < 0 or float(args.pbo_weight) < 0:
        raise SystemExit("--fdr-weight/--pbo-weight must be >= 0.")
    if float(args.fdr_weight) + float(args.pbo_weight) <= 0:
        raise SystemExit("--fdr-weight + --pbo-weight must be > 0.")
    if not (0 <= float(args.fdr_storey_lambda) < 1):
        raise SystemExit("--fdr-storey-lambda must be in [0, 1).")
    if int(args.regime_max_segments) < 1:
        raise SystemExit("--regime-max-segments must be >= 1.")
    if int(args.regime_min_segment_bars) < 1:
        raise SystemExit("--regime-min-segment-bars must be >= 1.")
    if int(args.regime_min_windows) < 1:
        raise SystemExit("--regime-min-windows must be >= 1.")
    if not (0 < float(args.cv_agg_quantile) <= 1):
        raise SystemExit("--cv-agg-quantile must be in (0, 1].")
    if int(args.stability_bootstraps) < 1:
        raise SystemExit("--stability-bootstraps must be >= 1.")
    if not (0 < float(args.stability_subsample_frac) <= 1):
        raise SystemExit("--stability-subsample-frac must be in (0, 1].")
    if not (0 <= float(args.stability_min_frequency) <= 1):
        raise SystemExit("--stability-min-frequency must be in [0, 1].")
    if not (0 <= float(args.stability_select_p) <= 1):
        raise SystemExit("--stability-select-p must be in [0, 1].")
    return args


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (root / path).resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_json_if_exists(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists():
        return None
    try:
        payload = read_json(path)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    return payload


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def to_finite_number(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        value = float(raw)
    except Exception:
        return None
    if not math.isfinite(value):
        return None
    return value


def clamp_int(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def nearest_choice(value: int, choices: Sequence[int]) -> int:
    if not choices:
        return int(value)
    return min(choices, key=lambda item: (abs(int(item) - int(value)), int(item)))


def simplify_trend_params(raw: Dict[str, Any]) -> Dict[str, Any]:
    fast_raw = int(raw.get("trendFastPeriod", 24))
    slow_raw = int(raw.get("trendSlowPeriod", 72))

    fast = nearest_choice(fast_raw, LOW_COMPLEXITY_FAST_CHOICES)
    min_slow = fast + 24
    slow_candidates = [value for value in LOW_COMPLEXITY_SLOW_CHOICES if value >= min_slow]
    if not slow_candidates:
        slow_candidates = [LOW_COMPLEXITY_SLOW_CHOICES[-1]]
    slow = nearest_choice(slow_raw, slow_candidates)
    if fast >= slow:
        slow = max(slow, fast + 1)
    return {
        "trendFastPeriod": int(fast),
        "trendSlowPeriod": int(slow),
        "allowShort": False,
    }


def apply_complexity_profile_to_params(
    raw: Dict[str, Any],
    complexity_profile: str,
) -> Dict[str, Any]:
    if complexity_profile == COMPLEXITY_PROFILE_LOW:
        return simplify_trend_params(raw)
    return normalize_trend_params(raw)


def normalize_trend_params(raw: Dict[str, Any]) -> Dict[str, Any]:
    fast = int(raw.get("trendFastPeriod", 20))
    slow = int(raw.get("trendSlowPeriod", 50))
    allow_short = bool(raw.get("allowShort", True))
    fast = clamp_int(fast, MIN_FAST, MAX_FAST)
    slow = clamp_int(slow, MIN_SLOW, MAX_SLOW)
    if fast >= slow:
        slow = min(MAX_SLOW, fast + 1)
        if fast >= slow:
            fast = max(MIN_FAST, slow - 1)
    return {
        "trendFastPeriod": int(fast),
        "trendSlowPeriod": int(slow),
        "allowShort": allow_short,
    }


def candidate_from_params(
    trial_id: int,
    slot: int,
    params: Dict[str, Any],
    label: str,
    complexity_profile: str = COMPLEXITY_PROFILE_DEFAULT,
) -> Dict[str, Any]:
    p = apply_complexity_profile_to_params(params, complexity_profile)
    suffix = "ls" if p["allowShort"] else "lo"
    return {
        "strategyId": f"LPS_T{trial_id:03d}_C{slot + 1}",
        "strategyName": (
            f"{label}_trend_{p['trendFastPeriod']}_{p['trendSlowPeriod']}_{suffix}"
        ),
        "strategy": "trend",
        "params": p,
    }


def validate_triplet_candidates(candidates: Sequence[Dict[str, Any]]) -> None:
    if len(candidates) != CANDIDATE_COUNT:
        raise ValueError(
            f"Each trial must contain exactly {CANDIDATE_COUNT} candidates; got={len(candidates)}."
        )
    for idx, row in enumerate(candidates):
        if row.get("strategy") != "trend":
            raise ValueError(f"candidates[{idx}] must be trend strategy.")
        params = row.get("params")
        if not isinstance(params, dict):
            raise ValueError(f"candidates[{idx}].params must be an object.")
        fast = int(params.get("trendFastPeriod", 0))
        slow = int(params.get("trendSlowPeriod", 0))
        if fast >= slow:
            raise ValueError(
                f"candidates[{idx}] violates fast<slow: fast={fast}, slow={slow}."
            )


def build_anchor_trial(
    trial_id: int,
    trial_label: str,
    anchor_type: str,
    anchor_params: Sequence[Dict[str, Any]],
    complexity_profile: str = COMPLEXITY_PROFILE_DEFAULT,
) -> Dict[str, Any]:
    if len(anchor_params) != CANDIDATE_COUNT:
        raise ValueError("Anchor params must have exactly 3 entries.")
    candidates = [
        candidate_from_params(
            trial_id=trial_id,
            slot=slot,
            params=anchor_params[slot],
            label=trial_label,
            complexity_profile=complexity_profile,
        )
        for slot in range(CANDIDATE_COUNT)
    ]
    validate_triplet_candidates(candidates)
    return {
        "trialId": trial_id,
        "trialLabel": trial_label,
        "anchorType": anchor_type,
        "candidates": candidates,
    }


def sample_mutated_params(
    base: Dict[str, Any],
    used: set[Tuple[int, int, bool]],
    rng: random.Random,
    mode: str,
    complexity_profile: str = COMPLEXITY_PROFILE_DEFAULT,
) -> Dict[str, Any]:
    if complexity_profile == COMPLEXITY_PROFILE_LOW:
        fast_span = 3 if mode == "local" else 6
        slow_span = 8 if mode == "local" else 16
    else:
        fast_span = 4 if mode == "local" else 12
        slow_span = 12 if mode == "local" else 30
    max_attempts = 128
    base_fast = int(base["trendFastPeriod"])
    base_slow = int(base["trendSlowPeriod"])
    base_short = bool(base.get("allowShort", True))
    if complexity_profile == COMPLEXITY_PROFILE_LOW:
        base_short = False

    for _ in range(max_attempts):
        fast = clamp_int(base_fast + rng.randint(-fast_span, fast_span), MIN_FAST, MAX_FAST)
        slow = clamp_int(base_slow + rng.randint(-slow_span, slow_span), MIN_SLOW, MAX_SLOW)

        if fast >= slow:
            gap = rng.randint(6, 24 if mode == "local" else 48)
            if rng.random() < 0.5:
                slow = min(MAX_SLOW, fast + gap)
            else:
                fast = max(MIN_FAST, slow - gap)
        if fast >= slow:
            slow = min(MAX_SLOW, fast + 1)
            if fast >= slow:
                fast = max(MIN_FAST, slow - 1)
        raw_candidate = {
            "trendFastPeriod": fast,
            "trendSlowPeriod": slow,
            "allowShort": base_short,
        }
        candidate = apply_complexity_profile_to_params(raw_candidate, complexity_profile)
        fast = int(candidate["trendFastPeriod"])
        slow = int(candidate["trendSlowPeriod"])
        allow_short = bool(candidate["allowShort"])

        key = (fast, slow, allow_short)
        if key in used:
            continue
        used.add(key)
        return candidate

    # Deterministic fallback to avoid hard failure in dense neighborhoods.
    for gap in range(2, 80):
        fast = clamp_int(base_fast - gap, MIN_FAST, MAX_FAST)
        slow = clamp_int(base_slow + gap, MIN_SLOW, MAX_SLOW)
        if fast >= slow:
            continue
        raw_candidate = {
            "trendFastPeriod": fast,
            "trendSlowPeriod": slow,
            "allowShort": base_short,
        }
        candidate = apply_complexity_profile_to_params(raw_candidate, complexity_profile)
        key = (
            int(candidate["trendFastPeriod"]),
            int(candidate["trendSlowPeriod"]),
            bool(candidate["allowShort"]),
        )
        if key in used:
            continue
        used.add(key)
        return candidate
    raise RuntimeError("Unable to sample a unique mutated trend parameter set.")


def generate_trial_definitions(
    trials: int,
    seed: int,
    mode: str,
    complexity_profile: str = COMPLEXITY_PROFILE_DEFAULT,
) -> List[Dict[str, Any]]:
    if trials < 2:
        raise ValueError("trials must be >= 2 to include baseline and known_best anchors.")
    if mode not in {"local", "wide"}:
        raise ValueError(f"Unsupported mode={mode}")

    generated: List[Dict[str, Any]] = [
        build_anchor_trial(
            trial_id=0,
            trial_label="baseline_anchor",
            anchor_type="baseline",
            anchor_params=BASELINE_ANCHOR,
            complexity_profile=complexity_profile,
        ),
        build_anchor_trial(
            trial_id=1,
            trial_label="known_best_anchor",
            anchor_type="known_best",
            anchor_params=KNOWN_BEST_ANCHOR,
            complexity_profile=complexity_profile,
        ),
    ]

    rng = random.Random(seed)
    anchor_sets = [BASELINE_ANCHOR, KNOWN_BEST_ANCHOR]
    while len(generated) < trials:
        trial_id = len(generated)
        anchor_idx = rng.randint(0, len(anchor_sets) - 1)
        anchor = anchor_sets[anchor_idx]
        anchor_name = "baseline" if anchor_idx == 0 else "known_best"
        used: set[Tuple[int, int, bool]] = set()
        candidates: List[Dict[str, Any]] = []
        for slot in range(CANDIDATE_COUNT):
            params = sample_mutated_params(
                base=anchor[slot],
                used=used,
                rng=rng,
                mode=mode,
                complexity_profile=complexity_profile,
            )
            candidates.append(
                candidate_from_params(
                    trial_id=trial_id,
                    slot=slot,
                    params=params,
                    label=f"search_{mode}_{anchor_name}",
                    complexity_profile=complexity_profile,
                )
            )
        validate_triplet_candidates(candidates)
        generated.append(
            {
                "trialId": trial_id,
                "trialLabel": f"search_{mode}_{trial_id:03d}",
                "anchorType": f"search_from_{anchor_name}",
                "candidates": candidates,
            }
        )
    return generated[:trials]


def build_trial_candidates_payload(
    base_cfg: Dict[str, Any],
    trial_candidates: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    validate_triplet_candidates(trial_candidates)
    payload = copy.deepcopy(base_cfg) if isinstance(base_cfg, dict) else {}
    payload["schemaVersion"] = "strategy_candidates.v1"
    payload["generatedAt"] = iso(now_utc())
    payload["candidates"] = [copy.deepcopy(row) for row in trial_candidates]
    if "hypothesisCompile" in payload:
        payload.pop("hypothesisCompile", None)
    return payload


def extract_trial_metrics(
    runs_payload: Optional[Dict[str, Any]],
    verdict_payload: Optional[Dict[str, Any]],
) -> Dict[str, Optional[float]]:
    aggregate: Dict[str, Any] = {}
    if isinstance(runs_payload, dict):
        raw = runs_payload.get("aggregateMetrics")
        if isinstance(raw, dict):
            aggregate = raw
    if not aggregate and isinstance(verdict_payload, dict):
        raw = verdict_payload.get("aggregateMetrics")
        if isinstance(raw, dict):
            aggregate = raw

    fdr_q = to_finite_number(aggregate.get("fdrQ"))
    mean_pbo = to_finite_number(aggregate.get("meanPbo"))
    mean_dsr_probability = to_finite_number(aggregate.get("meanDsrProbability"))

    if fdr_q is None and isinstance(runs_payload, dict):
        champion = runs_payload.get("champion")
        if isinstance(champion, dict):
            fdr_q = to_finite_number(champion.get("fdrQ"))

    wfo_failure_density: Optional[float] = None
    if isinstance(runs_payload, dict):
        candidates = runs_payload.get("candidates", [])
        if isinstance(candidates, list):
            failed = 0
            total = 0
            for row in candidates:
                if not isinstance(row, dict):
                    continue
                wfo_summary = row.get("wfoSummary", {})
                if not isinstance(wfo_summary, dict):
                    continue
                failed_windows = wfo_summary.get("failedWindows")
                total_windows = wfo_summary.get("totalWindows")
                if isinstance(failed_windows, int) and isinstance(total_windows, int) and total_windows > 0:
                    failed += failed_windows
                    total += total_windows
            if total > 0:
                wfo_failure_density = failed / total

    return {
        "fdrQ": fdr_q,
        "meanPbo": mean_pbo,
        "meanDsrProbability": mean_dsr_probability,
        "wfoFailureDensity": wfo_failure_density,
    }


def run_trial_validation(
    repo_root: Path,
    base_cfg: Dict[str, Any],
    trial: Dict[str, Any],
    wfo_profile: str,
    fdr_method: str,
    fdr_storey_lambda: float,
    regime_method: str = "change_point",
    regime_max_segments: int = 4,
    regime_min_segment_bars: int = 240,
    regime_min_windows: int = 2,
    regime_aggregation: str = "weighted_mean",
    cv_agg_quantile: float = 0.75,
    stability_bootstraps: int = 120,
    stability_subsample_frac: float = 0.7,
    stability_min_frequency: float = 0.7,
    stability_select_p: float = 0.2,
) -> Dict[str, Any]:
    trial_id = int(trial["trialId"])
    candidates = trial["candidates"]
    validate_triplet_candidates(candidates)

    with tempfile.TemporaryDirectory(prefix=f"openalice-local-search-t{trial_id:03d}-") as tmp:
        tmp_dir = Path(tmp)
        candidates_path = tmp_dir / "candidates.json"
        runs_out_path = tmp_dir / "strategy_validation_runs.json"
        verdict_out_path = tmp_dir / "experiment_verdict.v2.json"
        release_gate_status_path = tmp_dir / "release_gate_status.json"

        write_json(
            candidates_path,
            build_trial_candidates_payload(
                base_cfg=base_cfg,
                trial_candidates=candidates,
            ),
        )

        command = [
            "pnpm",
            "tsx",
            "scripts/run_strategy_mvp_validation.ts",
            "--candidates",
            str(candidates_path),
            "--output",
            str(runs_out_path),
            "--verdict-output",
            str(verdict_out_path),
            "--release-gate-status-path",
            str(release_gate_status_path),
            "--wfo-profile",
            wfo_profile,
            "--fdr-method",
            fdr_method,
        ]
        if fdr_method == "storey_bh":
            command.extend(["--fdr-storey-lambda", str(fdr_storey_lambda)])
        if fdr_method == "regime_segmented_bh":
            command.extend(
                [
                    "--regime-method",
                    str(regime_method),
                    "--regime-max-segments",
                    str(regime_max_segments),
                    "--regime-min-segment-bars",
                    str(regime_min_segment_bars),
                    "--regime-min-windows",
                    str(regime_min_windows),
                    "--regime-aggregation",
                    str(regime_aggregation),
                ]
            )
        if fdr_method == "cv_storey_bh":
            command.extend(
                [
                    "--cv-agg-quantile",
                    str(cv_agg_quantile),
                ]
            )
        if fdr_method == "stability_bh":
            command.extend(
                [
                    "--stability-bootstraps",
                    str(stability_bootstraps),
                    "--stability-subsample-frac",
                    str(stability_subsample_frac),
                    "--stability-min-frequency",
                    str(stability_min_frequency),
                    "--stability-select-p",
                    str(stability_select_p),
                ]
            )

        try:
            proc = subprocess.run(
                command,
                cwd=str(repo_root),
                text=True,
                capture_output=True,
                check=False,
            )
            exit_code = int(proc.returncode)
            stdout_tail = (proc.stdout or "")[-4000:]
            stderr_tail = (proc.stderr or "")[-4000:]
        except FileNotFoundError as exc:
            exit_code = 127
            stdout_tail = ""
            stderr_tail = str(exc)

        runs_payload = read_json_if_exists(runs_out_path)
        verdict_payload = read_json_if_exists(verdict_out_path)
        metrics = extract_trial_metrics(runs_payload=runs_payload, verdict_payload=verdict_payload)

        return {
            "trialId": trial_id,
            "trialLabel": trial.get("trialLabel"),
            "anchorType": trial.get("anchorType"),
            "exitCode": exit_code,
            "params": [copy.deepcopy(row.get("params", {})) for row in candidates],
            "candidates": [copy.deepcopy(row) for row in candidates],
            "metrics": metrics,
            "command": " ".join(shlex.quote(part) for part in command),
            "runOutputPresent": runs_payload is not None,
            "verdictOutputPresent": verdict_payload is not None,
            "stdoutTail": stdout_tail,
            "stderrTail": stderr_tail,
        }


def metric_violation(value: Optional[float], upper_bound: float) -> float:
    if value is None:
        return math.inf
    return max(0.0, float(value) - float(upper_bound))


def constraint_violation_score(
    *,
    constraint: str,
    fdr_q: Optional[float],
    mean_pbo: Optional[float],
    fdr_max: float,
    pbo_max: float,
) -> float:
    if constraint == "fdr":
        return metric_violation(fdr_q, fdr_max)
    if constraint == "pbo":
        return metric_violation(mean_pbo, pbo_max)
    if constraint == "both":
        return metric_violation(fdr_q, fdr_max) + metric_violation(mean_pbo, pbo_max)
    return 0.0


def trial_sort_key(
    trial_result: Dict[str, Any],
    target: str = "fdr",
    constraint: str = "none",
    fdr_max: float = 0.1,
    pbo_max: float = PBO_THRESHOLD_TARGET,
    fdr_weight: float = 0.5,
    pbo_weight: float = 0.5,
) -> Tuple[Any, ...]:
    metrics = trial_result.get("metrics", {})
    fdr_q = to_finite_number(metrics.get("fdrQ"))
    mean_pbo = to_finite_number(metrics.get("meanPbo"))
    mean_dsr = to_finite_number(metrics.get("meanDsrProbability"))
    wfo_failure_density = to_finite_number(metrics.get("wfoFailureDensity"))
    exit_code = int(trial_result.get("exitCode", 9999))
    constraint_violation = constraint_violation_score(
        constraint=constraint,
        fdr_q=fdr_q,
        mean_pbo=mean_pbo,
        fdr_max=fdr_max,
        pbo_max=pbo_max,
    )

    norm_fdr = (
        (fdr_q / fdr_max)
        if fdr_q is not None and fdr_max > 0
        else math.inf
    )
    norm_pbo = (
        (mean_pbo / pbo_max)
        if mean_pbo is not None and pbo_max > 0
        else math.inf
    )
    composite = (fdr_weight * norm_fdr) + (pbo_weight * norm_pbo)

    if target == "composite":
        return (
            constraint_violation,
            not math.isfinite(composite),
            composite,
            fdr_q is None,
            fdr_q if fdr_q is not None else math.inf,
            mean_pbo is None,
            mean_pbo if mean_pbo is not None else math.inf,
            -(mean_dsr if mean_dsr is not None else -1.0),
            exit_code,
            int(trial_result.get("trialId", 10**9)),
        )

    if target == "pbo":
        return (
            constraint_violation,
            mean_pbo is None,
            mean_pbo if mean_pbo is not None else math.inf,
            fdr_q is None,
            fdr_q if fdr_q is not None else math.inf,
            -(mean_dsr if mean_dsr is not None else -1.0),
            exit_code,
            int(trial_result.get("trialId", 10**9)),
        )

    if target == "wfo":
        return (
            constraint_violation,
            wfo_failure_density is None,
            wfo_failure_density if wfo_failure_density is not None else math.inf,
            fdr_q is None,
            fdr_q if fdr_q is not None else math.inf,
            mean_pbo if mean_pbo is not None else math.inf,
            -(mean_dsr if mean_dsr is not None else -1.0),
            exit_code,
            int(trial_result.get("trialId", 10**9)),
        )

    return (
        constraint_violation,
        fdr_q is None,
        fdr_q if fdr_q is not None else math.inf,
        mean_pbo if mean_pbo is not None else math.inf,
        -(mean_dsr if mean_dsr is not None else -1.0),
        exit_code,
        int(trial_result.get("trialId", 10**9)),
    )


def rank_trials(
    trial_results: Sequence[Dict[str, Any]],
    target: str = "fdr",
    constraint: str = "none",
    fdr_max: float = 0.1,
    pbo_max: float = PBO_THRESHOLD_TARGET,
    fdr_weight: float = 0.5,
    pbo_weight: float = 0.5,
) -> List[Dict[str, Any]]:
    return sorted(
        trial_results,
        key=lambda row: trial_sort_key(
            row,
            target=target,
            constraint=constraint,
            fdr_max=fdr_max,
            pbo_max=pbo_max,
            fdr_weight=fdr_weight,
            pbo_weight=pbo_weight,
        ),
    )


def trial_satisfies_constraint(
    trial_result: Dict[str, Any],
    *,
    constraint: str,
    fdr_max: float,
    pbo_max: float,
) -> bool:
    metrics = trial_result.get("metrics", {})
    fdr_q = to_finite_number(metrics.get("fdrQ"))
    mean_pbo = to_finite_number(metrics.get("meanPbo"))
    if constraint == "fdr":
        return fdr_q is not None and fdr_q <= fdr_max
    if constraint == "pbo":
        return mean_pbo is not None and mean_pbo <= pbo_max
    if constraint == "both":
        return (
            fdr_q is not None
            and mean_pbo is not None
            and fdr_q <= fdr_max
            and mean_pbo <= pbo_max
        )
    return True


def summarize_trial_for_report(trial_result: Dict[str, Any]) -> Dict[str, Any]:
    metrics = trial_result.get("metrics", {}) if isinstance(trial_result, dict) else {}
    out = {
        "trialId": int(trial_result.get("trialId", -1)),
        "trialLabel": trial_result.get("trialLabel", ""),
        "anchorType": trial_result.get("anchorType", ""),
        "exitCode": int(trial_result.get("exitCode", 0)),
        "fdrQ": to_finite_number(metrics.get("fdrQ")),
        "meanPbo": to_finite_number(metrics.get("meanPbo")),
        "meanDsrProbability": to_finite_number(metrics.get("meanDsrProbability")),
        "wfoFailureDensity": to_finite_number(metrics.get("wfoFailureDensity")),
        "params": copy.deepcopy(trial_result.get("params", [])),
    }
    return out


def build_report_payload(
    *,
    repo_root: Path,
    mode: str,
    wfo_profile: str,
    seed: int,
    trials_requested: int,
    trial_results: Sequence[Dict[str, Any]],
    fdr_method: str = "bh",
    fdr_storey_lambda: float = 0.5,
    regime_method: str = "change_point",
    regime_max_segments: int = 4,
    regime_min_segment_bars: int = 240,
    regime_min_windows: int = 2,
    regime_aggregation: str = "weighted_mean",
    cv_agg_quantile: float = 0.75,
    stability_bootstraps: int = 120,
    stability_subsample_frac: float = 0.7,
    stability_min_frequency: float = 0.7,
    stability_select_p: float = 0.2,
    plan: str = "A",
    focus_range: str = "",
    aggressive: bool = False,
    target: str = "fdr",
    constraint: str = "none",
    fdr_max: float = 0.1,
    pbo_max: float = PBO_THRESHOLD_TARGET,
    fdr_weight: float = 0.5,
    pbo_weight: float = 0.5,
    complexity_profile: str = COMPLEXITY_PROFILE_DEFAULT,
) -> Dict[str, Any]:
    ranked = rank_trials(
        trial_results,
        target=target,
        constraint=constraint,
        fdr_max=fdr_max,
        pbo_max=pbo_max,
        fdr_weight=fdr_weight,
        pbo_weight=pbo_weight,
    )
    best_trial = ranked[0] if ranked else None

    best_fdr_q: Optional[float] = None
    best_mean_pbo: Optional[float] = None
    best_wfo_failure_density: Optional[float] = None
    if isinstance(best_trial, dict):
        best_fdr_q = to_finite_number(best_trial.get("metrics", {}).get("fdrQ"))
        best_mean_pbo = to_finite_number(best_trial.get("metrics", {}).get("meanPbo"))
        best_wfo_failure_density = to_finite_number(
            best_trial.get("metrics", {}).get("wfoFailureDensity")
        )

    if best_fdr_q is None:
        improvement_abs = None
        improvement_pct = None
        threshold_break = False
    else:
        improvement_abs = BASELINE_FDRQ - best_fdr_q
        improvement_pct = (improvement_abs / BASELINE_FDRQ) * 100.0
        threshold_break = bool(best_fdr_q < THRESHOLD_BREAK_TARGET)

    pbo_threshold_break = (
        best_mean_pbo is not None and best_mean_pbo <= PBO_THRESHOLD_TARGET
    )
    feasible_count = sum(
        1
        for row in trial_results
        if trial_satisfies_constraint(
            row,
            constraint=constraint,
            fdr_max=fdr_max,
            pbo_max=pbo_max,
        )
    )
    best_trial_constraint_satisfied = (
        trial_satisfies_constraint(
            best_trial,
            constraint=constraint,
            fdr_max=fdr_max,
            pbo_max=pbo_max,
        )
        if isinstance(best_trial, dict)
        else False
    )

    return {
        "schemaVersion": "local_param_search_report.v1",
        "generatedAt": iso(now_utc()),
        "repoRoot": str(repo_root),
        "mode": mode,
        "target": target,
        "constraint": constraint,
        "wfoProfile": wfo_profile,
        "plan": plan,
        "focusRange": focus_range or None,
        "aggressive": aggressive,
        "complexityProfile": str(complexity_profile),
        "seed": int(seed),
        "fdrMethod": fdr_method,
        "fdrStoreyLambda": (
            float(fdr_storey_lambda) if fdr_method == "storey_bh" else None
        ),
        "regimeMethod": str(regime_method),
        "regimeMaxSegments": int(regime_max_segments),
        "regimeMinSegmentBars": int(regime_min_segment_bars),
        "regimeMinWindows": int(regime_min_windows),
        "regimeAggregation": str(regime_aggregation),
        "regimeConfig": {
            "method": str(regime_method),
            "maxSegments": int(regime_max_segments),
            "minSegmentBars": int(regime_min_segment_bars),
            "minWindows": int(regime_min_windows),
            "aggregation": str(regime_aggregation),
        },
        "cvAggQuantile": float(cv_agg_quantile),
        "stabilityBootstraps": int(stability_bootstraps),
        "stabilitySubsampleFrac": float(stability_subsample_frac),
        "stabilityMinFrequency": float(stability_min_frequency),
        "stabilitySelectP": float(stability_select_p),
        "trialsRequested": int(trials_requested),
        "trialCount": len(trial_results),
        "baselineFdrQ": BASELINE_FDRQ,
        "thresholdBreakTarget": THRESHOLD_BREAK_TARGET,
        "fdrMax": float(fdr_max),
        "pboMax": float(pbo_max),
        "fdrWeight": float(fdr_weight),
        "pboWeight": float(pbo_weight),
        "pboThresholdTarget": float(pbo_max),
        "bestFdrQ": best_fdr_q,
        "bestMeanPbo": best_mean_pbo,
        "bestWfoFailureDensity": best_wfo_failure_density,
        "improvementAbs": improvement_abs,
        "improvementPct": improvement_pct,
        "thresholdBreak": threshold_break,
        "pboThresholdBreak": pbo_threshold_break,
        "feasibleCount": int(feasible_count),
        "bestTrialConstraintSatisfied": bool(best_trial_constraint_satisfied),
        "bestTrial": summarize_trial_for_report(best_trial) if best_trial else None,
        "top10": [summarize_trial_for_report(row) for row in ranked[:10]],
        "trials": [summarize_trial_for_report(row) for row in trial_results],
    }


def build_best_triplet_payload(
    *,
    report_path: Path,
    report_payload: Dict[str, Any],
    trial_results: Sequence[Dict[str, Any]],
) -> Dict[str, Any]:
    target = str(report_payload.get("target", "fdr"))
    ranked = rank_trials(
        trial_results,
        target=target,
        constraint=str(report_payload.get("constraint", "none")),
        fdr_max=float(report_payload.get("fdrMax", 0.1)),
        pbo_max=float(report_payload.get("pboMax", PBO_THRESHOLD_TARGET)),
        fdr_weight=float(report_payload.get("fdrWeight", 0.5)),
        pbo_weight=float(report_payload.get("pboWeight", 0.5)),
    )
    if not ranked:
        raise ValueError("No trial results available to build best triplet payload.")
    best = ranked[0]
    candidates = [copy.deepcopy(row) for row in best.get("candidates", [])]
    validate_triplet_candidates(candidates)

    metrics = best.get("metrics", {})
    return {
        "schemaVersion": "best_trend_triplet.v1",
        "generatedAt": iso(now_utc()),
        "sourceReport": str(report_path),
        "trialId": int(best.get("trialId", -1)),
        "trialLabel": best.get("trialLabel", ""),
        "anchorType": best.get("anchorType", ""),
        "candidateCount": len(candidates),
        "metrics": {
            "fdrQ": to_finite_number(metrics.get("fdrQ")),
            "meanPbo": to_finite_number(metrics.get("meanPbo")),
            "meanDsrProbability": to_finite_number(metrics.get("meanDsrProbability")),
            "exitCode": int(best.get("exitCode", 0)),
        },
        "params": [copy.deepcopy(row.get("params", {})) for row in candidates],
        "candidates": candidates,
        "searchSummary": {
            "mode": report_payload.get("mode"),
            "target": report_payload.get("target"),
            "constraint": report_payload.get("constraint"),
            "complexityProfile": report_payload.get("complexityProfile"),
            "wfoProfile": report_payload.get("wfoProfile"),
            "regimeConfig": copy.deepcopy(report_payload.get("regimeConfig")),
            "cvAggQuantile": report_payload.get("cvAggQuantile"),
            "stabilityBootstraps": report_payload.get("stabilityBootstraps"),
            "stabilitySubsampleFrac": report_payload.get("stabilitySubsampleFrac"),
            "stabilityMinFrequency": report_payload.get("stabilityMinFrequency"),
            "stabilitySelectP": report_payload.get("stabilitySelectP"),
            "seed": report_payload.get("seed"),
            "bestFdrQ": report_payload.get("bestFdrQ"),
            "bestMeanPbo": report_payload.get("bestMeanPbo"),
            "bestWfoFailureDensity": report_payload.get("bestWfoFailureDensity"),
            "improvementAbs": report_payload.get("improvementAbs"),
            "improvementPct": report_payload.get("improvementPct"),
            "thresholdBreak": report_payload.get("thresholdBreak"),
            "pboThresholdBreak": report_payload.get("pboThresholdBreak"),
            "feasibleCount": report_payload.get("feasibleCount"),
        },
    }


def load_base_candidates_config(repo_root: Path) -> Dict[str, Any]:
    base_path = repo_root / BASE_CANDIDATES_REL
    if base_path.exists():
        payload = read_json(base_path)
        if isinstance(payload, dict):
            return payload
    return {"schemaVersion": "strategy_candidates.v1"}


def main() -> int:
    args = parse_args()
    repo_root = (
        resolve_path(default_repo_root(), args.repo_root)
        if args.repo_root
        else default_repo_root()
    )
    if args.trials < 2:
        raise SystemExit("--trials must be >= 2 to include baseline and known_best anchors.")

    base_cfg = load_base_candidates_config(repo_root)
    trial_defs = generate_trial_definitions(
        trials=int(args.trials),
        seed=int(args.seed),
        mode=str(args.mode),
        complexity_profile=str(args.complexity_profile),
    )

    trial_results: List[Dict[str, Any]] = []
    for trial in trial_defs:
        trial_results.append(
            run_trial_validation(
                repo_root=repo_root,
                base_cfg=base_cfg,
                trial=trial,
                wfo_profile=str(args.wfo_profile),
                fdr_method=str(args.fdr_method),
                fdr_storey_lambda=float(args.fdr_storey_lambda),
                regime_method=str(args.regime_method),
                regime_max_segments=int(args.regime_max_segments),
                regime_min_segment_bars=int(args.regime_min_segment_bars),
                regime_min_windows=int(args.regime_min_windows),
                regime_aggregation=str(args.regime_aggregation),
                cv_agg_quantile=float(args.cv_agg_quantile),
                stability_bootstraps=int(args.stability_bootstraps),
                stability_subsample_frac=float(args.stability_subsample_frac),
                stability_min_frequency=float(args.stability_min_frequency),
                stability_select_p=float(args.stability_select_p),
            )
        )

    report_payload = build_report_payload(
        repo_root=repo_root,
        mode=str(args.mode),
        wfo_profile=str(args.wfo_profile),
        seed=int(args.seed),
        trials_requested=int(args.trials),
        trial_results=trial_results,
        fdr_method=str(args.fdr_method),
        fdr_storey_lambda=float(args.fdr_storey_lambda),
        regime_method=str(args.regime_method),
        regime_max_segments=int(args.regime_max_segments),
        regime_min_segment_bars=int(args.regime_min_segment_bars),
        regime_min_windows=int(args.regime_min_windows),
        regime_aggregation=str(args.regime_aggregation),
        cv_agg_quantile=float(args.cv_agg_quantile),
        stability_bootstraps=int(args.stability_bootstraps),
        stability_subsample_frac=float(args.stability_subsample_frac),
        stability_min_frequency=float(args.stability_min_frequency),
        stability_select_p=float(args.stability_select_p),
        plan=str(args.plan),
        focus_range=str(args.focus_range),
        aggressive=bool(args.aggressive),
        target=str(args.target),
        constraint=str(args.constraint),
        fdr_max=float(args.fdr_max),
        pbo_max=float(args.pbo_max),
        fdr_weight=float(args.fdr_weight),
        pbo_weight=float(args.pbo_weight),
        complexity_profile=str(args.complexity_profile),
    )

    output_path = resolve_path(repo_root, str(args.output))
    best_output_path = resolve_path(repo_root, str(args.best_output))
    write_json(output_path, report_payload)

    best_payload = build_best_triplet_payload(
        report_path=output_path,
        report_payload=report_payload,
        trial_results=trial_results,
    )
    write_json(best_output_path, best_payload)

    print(
        " | ".join(
            [
                f"report={output_path}",
                f"best={best_output_path}",
                f"trials={len(trial_results)}",
                f"plan={args.plan}",
                f"target={args.target}",
                f"constraint={args.constraint}",
                f"complexityProfile={args.complexity_profile}",
                f"fdrMethod={args.fdr_method}",
                f"bestFdrQ={report_payload.get('bestFdrQ')}",
                f"bestMeanPbo={report_payload.get('bestMeanPbo')}",
                f"bestWfoFailureDensity={report_payload.get('bestWfoFailureDensity')}",
                f"feasibleCount={report_payload.get('feasibleCount')}",
                f"thresholdBreak={report_payload.get('thresholdBreak')}",
            ]
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
