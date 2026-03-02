#!/usr/bin/env python3
"""Orchestrate the 24-run CVaR next experiment matrix and aggregate decisions.

This script implements the agreed robust-first protocol:
- Main board (UM-only): H0/H1/H2/H3 x 4 seeds = 16 runs
- Mixed board stage 1: S0 x 4 seeds = 4 runs
- Mixed board stage 2: S1 x 4 seeds = 4 runs (materialized from main champion)

Deliverables written under experiment root:
- runs_manifest.csv
- board_main_aggregate.csv
- board_mixed_aggregate.csv
- decision.md
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import random
import shlex
import statistics
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

MAIN_SYMBOLS = [
    "ADA/USDT::binance_um",
    "BCH/USDT::binance_um",
    "BTC/USDT::binance_um",
    "ETC/USDT::binance_um",
    "ETH/USDT::binance_um",
    "LINK/USDT::binance_um",
    "LTC/USDT::binance_um",
    "TRX/USDT::binance_um",
    "XLM/USDT::binance_um",
    "XRP/USDT::binance_um",
]

MIXED_SYMBOLS = [
    "ETH/USDT::binance_spot",
    "BTC/USDT::binance_um",
    "NEO/USDT::binance_spot",
    "BTC/USDT::binance_spot",
    "BNB/USDT::binance_spot",
    "LTC/USDT::binance_spot",
    "BCH/USDT::binance_um",
    "ETH/USDT::binance_um",
    "XRP/USDT::binance_um",
    "LTC/USDT::binance_um",
]

DEFAULT_SEEDS = [7, 13, 42, 87]

PROFILE_MAIN_CONFIGS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "baseline_v1": {
        "H0": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {},
        },
        "H1": {
            "calibration_method": "isotonic",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {},
        },
        "H2": {
            "calibration_method": "sigmoid",
            "regime_method": "kmeans",
            "regime_scheme": "kmeans_v1",
            "regime_schema_version": "v1_kmeans_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {},
        },
        "H3": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost,ridge",
            "extra_args": {},
        },
    },
    "gates_v2": {
        "H0": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {},
        },
        "H4": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {
                "--min-confidence": "0.60",
                "--min-expected-return-pct": "0.05",
            },
        },
        "H5": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {
                "--model-safety-min-robust-cost-aware-utility": "0.02",
                "--model-safety-min-cost-aware-utility": "0.00",
                "--model-safety-min-net-return-pct-after-cost": "0.0",
            },
        },
        "H6": {
            "calibration_method": "sigmoid",
            "regime_method": "rule",
            "regime_scheme": "rule_v1",
            "regime_schema_version": "v1_rule_3regime",
            "include_models": "randomForest,xgboost,lightgbm,catboost",
            "extra_args": {
                "--min-confidence": "0.60",
                "--min-expected-return-pct": "0.05",
                "--model-safety-min-robust-cost-aware-utility": "0.02",
                "--model-safety-min-cost-aware-utility": "0.00",
                "--model-safety-min-net-return-pct-after-cost": "0.0",
            },
        },
    },
}

PROFILE_MAIN_ORDER: Dict[str, List[str]] = {
    "baseline_v1": ["H0", "H1", "H2", "H3"],
    "gates_v2": ["H0", "H4", "H5", "H6"],
}

MAIN_CONFIGS: Dict[str, Dict[str, Any]] = {}
MAIN_CONFIG_ORDER: List[str] = []

BOARD_SPECS = {
    "main": {
        "include_sources": "binance_um",
        "max_symbols": "10",
        "max_symbols_per_source": "0",
        "symbol_allowlist": ",".join(MAIN_SYMBOLS),
    },
    "mixed": {
        "include_sources": "binance_spot,binance_um",
        "max_symbols": "10",
        "max_symbols_per_source": "5",
        "symbol_allowlist": ",".join(MIXED_SYMBOLS),
    },
}

BASE_PIPELINE_ARGS = {
    "--wait-downloads": "false",
    "--timeframe": "1d",
    "--quote": "USDT",
    "--min-bars": "220",
    "--horizon-bars": "1",
    "--train-ratio": "0.8",
    "--min-confidence": "0.55",
    "--min-expected-return-pct": "0.03",
    "--selection-objective": "robustCostAwareUtility",
    "--selection-mode": "max",
    "--ensemble-mode": "regime_moe",
    "--regime-count": "3",
    "--labeling-mode": "triple_barrier",
    "--barrier-tp-atr": "1.5",
    "--barrier-sl-atr": "1.0",
    "--barrier-max-horizon-bars": "4",
    "--cost-fee-rate": "0.0006",
    "--cost-slippage-bps": "8",
    "--cost-latency-bars": "1",
    "--robust-per-bar-clip": "0.25",
    "--conformal-alpha": "0.10",
    "--conformal-min-regime-samples": "25",
    "--conformal-shift-weight-clip-min": "0.25",
    "--conformal-shift-weight-clip-max": "4.0",
    "--decision-use-conformal-lower-bound": "true",
    "--model-safety-filter-enabled": "true",
    "--model-safety-min-robust-cost-aware-utility": "0.0",
    "--model-safety-min-cost-aware-utility": "-0.02",
    "--model-safety-min-net-return-pct-after-cost": "-20",
    "--oof-min-coverage-soft": "0.6",
    "--oof-hard-floor": "0.25",
    "--soft-fail-max-weight": "0.15",
    "--tscv-gap-bars": "2",
    "--test-lock-ratio": "0.1",
    "--risk-clamp-on-soft-stat-warn": "0.35",
    "--delisted-days": "90",
    "--isolate-sources": "true",
}

MANIFEST_FIELDS = [
    "run_id",
    "stage",
    "board",
    "config_id",
    "config_source",
    "seed",
    "output_root",
    "status",
    "exit_code",
    "started_at",
    "finished_at",
    "trained_symbols",
    "error_symbols",
    "error_ratio",
    "command",
]

STATUS_WAITING_CHAMPION = "waiting_champion"
STATUS_PENDING = "pending"
STATUS_RUNNING = "running"
STATUS_DONE = "done"
STATUS_FAILED = "failed"

MAIN_GATE_TURNOVER_CAP_MULTIPLIER = 1.10


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build/run/analyze the 24-run CVaR next experiment matrix and emit "
            "runs_manifest.csv + board aggregates + decision.md."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root. Default: parent of this script.",
    )
    parser.add_argument(
        "--experiment-root",
        default="data/training-data/cvar-next",
        help="Experiment root directory (absolute or repo-relative).",
    )
    parser.add_argument(
        "--experiment-id",
        default=f"cvar24-{dt.datetime.now().strftime('%Y%m%dT%H%M%S')}",
        help="Experiment ID directory name.",
    )
    parser.add_argument(
        "--profile",
        default="baseline_v1",
        choices=sorted(PROFILE_MAIN_CONFIGS.keys()),
        help="Main-board config profile.",
    )
    parser.add_argument(
        "--profile-file",
        default="",
        help=(
            "Optional JSON file describing custom main-board profile. "
            "When provided, it overrides --profile."
        ),
    )
    parser.add_argument(
        "--python-bin",
        default="./.venv/bin/python",
        help="Python executable used to run wait_clean_and_retrain.py.",
    )
    parser.add_argument(
        "--wait-script",
        default="scripts/wait_clean_and_retrain.py",
        help="Path to wait_clean_and_retrain.py (absolute or repo-relative).",
    )
    parser.add_argument(
        "--seeds",
        default="7,13,42,87",
        help="Comma-separated seeds. Default: 7,13,42,87",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Execute pending runs. Without this flag the script is planning/analyzing only.",
    )
    parser.add_argument(
        "--force-rerun-failed",
        action="store_true",
        help="Re-run runs currently marked failed.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue executing remaining runs after one run fails.",
    )
    parser.add_argument(
        "--max-runs",
        type=int,
        default=0,
        help="Optional cap on number of runs to execute this invocation (0 = unlimited).",
    )
    parser.add_argument(
        "--champion-config",
        default="",
        help="Optional manual champion override for S1 (must exist in selected --profile).",
    )
    parser.add_argument(
        "--skip-stage2",
        action="store_true",
        help="Skip executing stage2 (S1) even if champion is available.",
    )
    parser.add_argument(
        "--stale-running-minutes",
        type=int,
        default=120,
        help=(
            "Recover runs stuck in status=running when no process/artifact update "
            "for this many minutes. Set <=0 to disable."
        ),
    )
    parser.add_argument(
        "--stale-running-to",
        choices=["failed", "pending"],
        default="failed",
        help="Target status used when recovering stale running rows.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def parse_seed_csv(raw: str) -> List[int]:
    seeds: List[int] = []
    for token in raw.split(","):
        value = token.strip()
        if not value:
            continue
        seeds.append(int(value))
    if not seeds:
        return list(DEFAULT_SEEDS)
    return sorted(set(seeds))


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    return (root / p).resolve()


def normalize_main_config(raw: Dict[str, Any], config_id: str) -> Dict[str, Any]:
    required = [
        "calibration_method",
        "regime_method",
        "regime_scheme",
        "regime_schema_version",
        "include_models",
    ]
    missing = [key for key in required if key not in raw]
    if missing:
        raise ValueError(f"config {config_id} missing fields: {missing}")
    extra_args = raw.get("extra_args", {})
    if extra_args is None:
        extra_args = {}
    if not isinstance(extra_args, dict):
        raise ValueError(f"config {config_id} field extra_args must be object")
    return {
        "calibration_method": str(raw["calibration_method"]),
        "regime_method": str(raw["regime_method"]),
        "regime_scheme": str(raw["regime_scheme"]),
        "regime_schema_version": str(raw["regime_schema_version"]),
        "include_models": str(raw["include_models"]),
        "extra_args": {str(k): str(v) for k, v in extra_args.items()},
    }


def resolve_main_profile(
    args: argparse.Namespace,
) -> Tuple[str, Dict[str, Dict[str, Any]], List[str], str]:
    profile_file_raw = str(getattr(args, "profile_file", "") or "").strip()
    if not profile_file_raw:
        profile_name = str(args.profile)
        source = "builtin"
        configs = {
            key: normalize_main_config(value, key)
            for key, value in PROFILE_MAIN_CONFIGS[profile_name].items()
        }
        order = list(PROFILE_MAIN_ORDER[profile_name])
    else:
        profile_path = Path(profile_file_raw).resolve()
        if not profile_path.exists():
            raise FileNotFoundError(f"profile file not found: {profile_path}")
        payload = json.loads(profile_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError("profile file must be a JSON object")
        raw_configs = payload.get("mainConfigs")
        if not isinstance(raw_configs, dict) or not raw_configs:
            raise ValueError("profile file must include non-empty object mainConfigs")
        raw_order = payload.get("mainOrder")
        if raw_order is None:
            order = list(raw_configs.keys())
        elif isinstance(raw_order, list) and raw_order:
            order = [str(x) for x in raw_order]
        else:
            raise ValueError(
                "profile file field mainOrder must be non-empty array when provided"
            )
        unknown = [cid for cid in order if cid not in raw_configs]
        if unknown:
            raise ValueError(f"mainOrder contains unknown config ids: {unknown}")
        if "H0" not in raw_configs:
            raise ValueError("profile file mainConfigs must include baseline config H0")
        if "H0" not in order:
            order = ["H0"] + [cid for cid in order if cid != "H0"]
        configs = {
            cid: normalize_main_config(raw_configs[cid], cid) for cid in raw_configs
        }
        profile_name = str(payload.get("profileName") or profile_path.stem)
        source = str(profile_path)
    if not order:
        raise ValueError("resolved main config order is empty")
    return profile_name, configs, order, source


def parse_iso8601(raw: str) -> Optional[dt.datetime]:
    text = (raw or "").strip()
    if not text:
        return None
    try:
        parsed = dt.datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=dt.timezone.utc)
        return parsed
    except Exception:
        return None


def find_latest_artifact_time(
    row: Dict[str, str], repo_root: Path
) -> Optional[dt.datetime]:
    output_root_raw = row.get("output_root", "").strip()
    if not output_root_raw:
        return None
    output_root = resolve_path(repo_root, output_root_raw)
    candidates = [
        output_root / "retrain" / "leaderboard.csv",
        output_root / "retrain" / "summary.json",
        output_root / "retrain" / "errors.json",
    ]
    latest: Optional[dt.datetime] = None
    for path in candidates:
        if not path.exists():
            continue
        try:
            mtime = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
        except Exception:
            continue
        if latest is None or mtime > latest:
            latest = mtime
    return latest


def list_active_training_cmdlines(wait_script: Path) -> List[str]:
    script_name = wait_script.name
    try:
        proc = subprocess.run(
            ["ps", "-axo", "command"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return []
    lines = [line.strip() for line in proc.stdout.splitlines() if line.strip()]
    active: List[str] = []
    for line in lines:
        if script_name not in line:
            continue
        if "run_cvar_next_matrix.py" in line:
            continue
        active.append(line)
    return active


def recover_stale_running_rows(
    manifest: List[Dict[str, str]],
    repo_root: Path,
    wait_script: Path,
    stale_minutes: int,
    stale_to: str,
) -> List[str]:
    if stale_minutes <= 0:
        return []
    active_cmdlines = list_active_training_cmdlines(wait_script)
    now = dt.datetime.now(dt.timezone.utc)
    threshold = dt.timedelta(minutes=stale_minutes)
    recovered: List[str] = []

    for row in manifest:
        if row.get("status") != STATUS_RUNNING:
            continue
        output_root_raw = row.get("output_root", "").strip()
        if output_root_raw and any(output_root_raw in cmd for cmd in active_cmdlines):
            continue

        signal_times: List[dt.datetime] = []
        started = parse_iso8601(row.get("started_at", ""))
        finished = parse_iso8601(row.get("finished_at", ""))
        artifact = find_latest_artifact_time(row, repo_root=repo_root)
        if started is not None:
            signal_times.append(started)
        if finished is not None:
            signal_times.append(finished)
        if artifact is not None:
            signal_times.append(artifact)
        if not signal_times:
            continue
        last_signal = max(signal_times)
        if now - last_signal <= threshold:
            continue

        row["status"] = STATUS_FAILED if stale_to == "failed" else STATUS_PENDING
        row["exit_code"] = "stale-recovered"
        row["finished_at"] = utc_now()
        recovered.append(row.get("run_id", ""))

    return recovered


def mean_or_none(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return float(sum(values) / len(values))


def stdev_or_zero(values: Sequence[float]) -> float:
    if len(values) < 2:
        return 0.0
    return float(statistics.stdev(values))


def bootstrap_ci(
    values: Sequence[float],
    confidence: float = 0.95,
    samples: int = 2000,
    seed: int = 42,
) -> Tuple[Optional[float], Optional[float]]:
    vals = [float(v) for v in values if v is not None]
    if not vals:
        return None, None
    if len(vals) == 1:
        return vals[0], vals[0]
    rng = random.Random(seed)
    means: List[float] = []
    n = len(vals)
    for _ in range(samples):
        draw = [vals[rng.randrange(n)] for __ in range(n)]
        means.append(float(sum(draw) / n))
    means.sort()
    alpha = 1.0 - confidence
    lo_idx = max(0, int((alpha / 2) * len(means)))
    hi_idx = min(len(means) - 1, int((1 - alpha / 2) * len(means)) - 1)
    return means[lo_idx], means[hi_idx]


def trimmed_mean(values: Sequence[float], proportion: float = 0.10) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(float(v) for v in values)
    n = len(ordered)
    k = int(n * proportion)
    if n - 2 * k <= 0:
        core = ordered
    else:
        core = ordered[k : n - k]
    return float(sum(core) / len(core))


def to_float(value: Any) -> Optional[float]:
    try:
        if value is None or value == "":
            return None
        return float(value)
    except Exception:
        return None


def ensure_manifest(
    path: Path, seeds: Sequence[int], experiment_rel: str
) -> List[Dict[str, str]]:
    if path.exists():
        return read_manifest(path)
    manifest = build_initial_manifest(seeds, experiment_rel)
    write_manifest(path, manifest)
    return manifest


def build_initial_manifest(
    seeds: Sequence[int], experiment_rel: str
) -> List[Dict[str, str]]:
    records: List[Dict[str, str]] = []
    for config_id in MAIN_CONFIG_ORDER:
        for seed in seeds:
            run_id = f"main-{config_id}-seed{seed}"
            output_root = f"{experiment_rel}/runs/{run_id}"
            records.append(
                {
                    "run_id": run_id,
                    "stage": "1",
                    "board": "main",
                    "config_id": config_id,
                    "config_source": "",
                    "seed": str(seed),
                    "output_root": output_root,
                    "status": STATUS_PENDING,
                    "exit_code": "",
                    "started_at": "",
                    "finished_at": "",
                    "trained_symbols": "",
                    "error_symbols": "",
                    "error_ratio": "",
                    "command": "",
                }
            )
    for seed in seeds:
        run_id = f"mixed-S0-seed{seed}"
        output_root = f"{experiment_rel}/runs/{run_id}"
        records.append(
            {
                "run_id": run_id,
                "stage": "1",
                "board": "mixed",
                "config_id": "S0",
                "config_source": "H0",
                "seed": str(seed),
                "output_root": output_root,
                "status": STATUS_PENDING,
                "exit_code": "",
                "started_at": "",
                "finished_at": "",
                "trained_symbols": "",
                "error_symbols": "",
                "error_ratio": "",
                "command": "",
            }
        )
    for seed in seeds:
        run_id = f"mixed-S1-seed{seed}"
        records.append(
            {
                "run_id": run_id,
                "stage": "2",
                "board": "mixed",
                "config_id": "S1",
                "config_source": "",
                "seed": str(seed),
                "output_root": "",
                "status": STATUS_WAITING_CHAMPION,
                "exit_code": "",
                "started_at": "",
                "finished_at": "",
                "trained_symbols": "",
                "error_symbols": "",
                "error_ratio": "",
                "command": "",
            }
        )
    return records


def read_manifest(path: Path) -> List[Dict[str, str]]:
    rows: List[Dict[str, str]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for raw in reader:
            row = {field: raw.get(field, "") for field in MANIFEST_FIELDS}
            rows.append(row)
    return rows


def write_manifest(path: Path, rows: Sequence[Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=MANIFEST_FIELDS)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in MANIFEST_FIELDS})


def resolve_effective_config(config_id: str, config_source: str) -> Optional[str]:
    if config_id in MAIN_CONFIGS:
        return config_id
    if config_id == "S0":
        return "H0"
    if config_id == "S1":
        source = (config_source or "").strip()
        if source in MAIN_CONFIGS:
            return source
    return None


def build_command(
    row: Dict[str, str],
    repo_root: Path,
    python_bin: str,
    wait_script: Path,
) -> Optional[List[str]]:
    board = row["board"]
    config_id = row["config_id"]
    config_source = row["config_source"]
    seed = row["seed"]
    output_root = row["output_root"]
    if not output_root:
        return None
    effective_config = resolve_effective_config(config_id, config_source)
    if effective_config is None:
        return None
    board_spec = BOARD_SPECS.get(board)
    if board_spec is None:
        return None
    config = MAIN_CONFIGS[effective_config]
    cmd: List[str] = [python_bin, str(wait_script)]
    arg_pairs: List[Tuple[str, str]] = []
    for key, value in BASE_PIPELINE_ARGS.items():
        arg_pairs.append((key, value))
    arg_pairs.extend(
        [
            ("--output-root", output_root),
            ("--include-sources", board_spec["include_sources"]),
            ("--max-symbols", board_spec["max_symbols"]),
            ("--max-symbols-per-source", board_spec["max_symbols_per_source"]),
            ("--symbol-allowlist", board_spec["symbol_allowlist"]),
            ("--seed", str(seed)),
            ("--include-models", config["include_models"]),
            ("--calibration-method", config["calibration_method"]),
            ("--regime-method", config["regime_method"]),
            ("--regime-scheme", config["regime_scheme"]),
            ("--regime-schema-version", config["regime_schema_version"]),
        ]
    )
    extra_args = config.get("extra_args", {})
    if isinstance(extra_args, dict):
        for key, value in extra_args.items():
            arg_pairs.append((str(key), str(value)))
    for key, value in arg_pairs:
        cmd.extend([key, value])
    return cmd


def command_to_shell(cmd: Sequence[str]) -> str:
    return " ".join(shlex.quote(token) for token in cmd)


def summarize_run_artifacts(
    row: Dict[str, str], repo_root: Path
) -> Optional[Dict[str, Any]]:
    output_root_raw = row.get("output_root", "").strip()
    if not output_root_raw:
        return None
    output_root = resolve_path(repo_root, output_root_raw)
    leaderboard_path = output_root / "retrain" / "leaderboard.csv"
    summary_path = output_root / "retrain" / "summary.json"
    errors_path = output_root / "retrain" / "errors.json"
    if not leaderboard_path.exists():
        return None

    with leaderboard_path.open("r", encoding="utf-8", newline="") as f:
        leaderboard_rows = list(csv.DictReader(f))
    if not leaderboard_rows:
        return None

    robust_vals: List[float] = []
    cost_vals: List[float] = []
    net_vals: List[float] = []
    lift_vals: List[float] = []
    turnover_vals: List[float] = []

    for lr in leaderboard_rows:
        robust = to_float(lr.get("robust_cost_aware_utility"))
        cost = to_float(lr.get("cost_aware_utility"))
        net = to_float(lr.get("net_return_pct_after_cost"))
        lift = to_float(lr.get("accuracy_lift"))
        turnover = to_float(lr.get("turnover_per_bar"))
        if robust is not None:
            robust_vals.append(robust)
        if cost is not None:
            cost_vals.append(cost)
        if net is not None:
            net_vals.append(net)
        if lift is not None:
            lift_vals.append(lift)
        if turnover is not None:
            turnover_vals.append(turnover)

    if (
        not robust_vals
        or not cost_vals
        or not net_vals
        or not lift_vals
        or not turnover_vals
    ):
        return None

    errors_count = 0
    summary_payload: Dict[str, Any] = {}
    if errors_path.exists():
        try:
            errors_payload = json.loads(errors_path.read_text(encoding="utf-8"))
            if isinstance(errors_payload, list):
                errors_count = len(errors_payload)
        except Exception:
            errors_count = 0

    trained_symbols = len(leaderboard_rows)
    error_symbols = errors_count
    if summary_path.exists():
        try:
            loaded = json.loads(summary_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                summary_payload = loaded
            trained_symbols = int(
                summary_payload.get("trainedSymbols", trained_symbols)
            )
            error_symbols = int(summary_payload.get("errorSymbols", error_symbols))
        except Exception:
            pass

    denom = trained_symbols + error_symbols
    error_ratio = float(error_symbols / denom) if denom > 0 else 0.0
    conformal_coverage = to_float(summary_payload.get("meanConformalCoverageTest"))
    conformal_coverage_shift = to_float(
        summary_payload.get("meanConformalCoverageShiftWeightedTest")
    )
    conformal_sharpness_pct = to_float(summary_payload.get("meanConformalSharpnessPct"))
    conformal_latest_lower_expected_return_pct = to_float(
        summary_payload.get("meanConformalLatestLowerExpectedReturnPct")
    )
    regime_diagnostics = (
        summary_payload.get("regimeDiagnostics", {})
        if isinstance(summary_payload.get("regimeDiagnostics"), dict)
        else {}
    )
    regime_diag_summary = (
        regime_diagnostics.get("summary", {})
        if isinstance(regime_diagnostics.get("summary"), dict)
        else {}
    )
    regime_fallback_ratio = to_float(regime_diag_summary.get("fallbackRatio"))
    regime_numeric_warning_mean = to_float(regime_diag_summary.get("numericWarningMean"))
    regime_cluster_balance_min = to_float(regime_diag_summary.get("minClusterBalanceRatio"))
    regime_time_index_miss_mean = to_float(regime_diag_summary.get("timeIndexMissMean"))
    regime_future_alignment_risk_mean = to_float(
        regime_diag_summary.get("futureAlignmentRiskMean")
    )
    if regime_fallback_ratio is None:
        fallback_count = to_float(summary_payload.get("kmeansFallbackCount"))
        if fallback_count is not None and trained_symbols > 0:
            regime_fallback_ratio = float(fallback_count / float(trained_symbols))
    if regime_numeric_warning_mean is None:
        numeric_total = to_float(summary_payload.get("kmeansNumericWarningTotal"))
        if numeric_total is not None and trained_symbols > 0:
            regime_numeric_warning_mean = float(numeric_total / float(trained_symbols))

    return {
        "trained_symbols": trained_symbols,
        "error_symbols": error_symbols,
        "error_ratio": error_ratio,
        "run_robust_mean": float(sum(robust_vals) / len(robust_vals)),
        "run_cost_mean": float(sum(cost_vals) / len(cost_vals)),
        "run_net_median": float(statistics.median(net_vals)),
        "run_net_trim10": trimmed_mean(net_vals, 0.10),
        "run_lift_pos": float(sum(1 for v in lift_vals if v > 0) / len(lift_vals)),
        "run_turnover_mean": float(sum(turnover_vals) / len(turnover_vals)),
        "run_conformal_coverage_mean": conformal_coverage,
        "run_conformal_coverage_shift_mean": conformal_coverage_shift,
        "run_conformal_sharpness_pct_mean": conformal_sharpness_pct,
        "run_conformal_latest_lower_expected_return_pct_mean": conformal_latest_lower_expected_return_pct,
        "run_regime_fallback_ratio": regime_fallback_ratio,
        "run_regime_numeric_warning_mean": regime_numeric_warning_mean,
        "run_regime_cluster_balance_min": regime_cluster_balance_min,
        "run_regime_time_index_miss_mean": regime_time_index_miss_mean,
        "run_regime_future_alignment_risk": regime_future_alignment_risk_mean,
    }


def refresh_manifest_metrics(
    manifest: List[Dict[str, str]],
    repo_root: Path,
    python_bin: str,
    wait_script: Path,
) -> None:
    for row in manifest:
        cmd = build_command(
            row, repo_root=repo_root, python_bin=python_bin, wait_script=wait_script
        )
        row["command"] = command_to_shell(cmd) if cmd else ""
        metrics = summarize_run_artifacts(row, repo_root=repo_root)
        if metrics is None:
            if row["status"] == STATUS_DONE:
                row["status"] = STATUS_FAILED
            continue
        row["trained_symbols"] = str(metrics["trained_symbols"])
        row["error_symbols"] = str(metrics["error_symbols"])
        row["error_ratio"] = f"{metrics['error_ratio']:.8f}"
        row["status"] = STATUS_DONE
        if not row.get("finished_at"):
            row["finished_at"] = utc_now()


def select_locked_champion(manifest: Sequence[Dict[str, str]]) -> Optional[str]:
    locked = {
        row["config_source"]
        for row in manifest
        if row.get("config_id") == "S1" and row.get("config_source") in MAIN_CONFIGS
    }
    if not locked:
        return None
    if len(locked) == 1:
        return next(iter(locked))
    return None


def materialize_stage2(
    manifest: List[Dict[str, str]],
    champion: str,
    experiment_rel: str,
) -> None:
    suffix = champion.lower()
    for row in manifest:
        if row["config_id"] != "S1":
            continue
        if row["status"] == STATUS_DONE:
            continue
        row["config_source"] = champion
        if not row["output_root"]:
            row["output_root"] = (
                f"{experiment_rel}/runs/mixed-S1from-{suffix}-seed{row['seed']}"
            )
        if row["status"] == STATUS_WAITING_CHAMPION:
            row["status"] = STATUS_PENDING


def run_pending(
    manifest: List[Dict[str, str]],
    repo_root: Path,
    python_bin: str,
    wait_script: Path,
    manifest_path: Optional[Path],
    stage: str,
    max_runs: int,
    continue_on_error: bool,
    force_rerun_failed: bool,
) -> int:
    def flush_manifest() -> None:
        if manifest_path is not None:
            write_manifest(manifest_path, manifest)

    executed = 0
    ordered = sorted(
        (row for row in manifest if row["stage"] == stage),
        key=lambda r: (r["board"], r["config_id"], int(r["seed"])),
    )
    for row in ordered:
        status = row["status"]
        if status == STATUS_DONE:
            continue
        if status == STATUS_FAILED and not force_rerun_failed:
            continue
        if status not in {STATUS_PENDING, STATUS_FAILED}:
            continue
        cmd = build_command(
            row, repo_root=repo_root, python_bin=python_bin, wait_script=wait_script
        )
        if cmd is None:
            continue
        row["command"] = command_to_shell(cmd)
        row["status"] = STATUS_RUNNING
        row["started_at"] = utc_now()
        flush_manifest()
        proc = subprocess.run(cmd, cwd=str(repo_root))
        row["finished_at"] = utc_now()
        row["exit_code"] = str(proc.returncode)
        if proc.returncode == 0:
            row["status"] = STATUS_DONE
        else:
            row["status"] = STATUS_FAILED
        flush_manifest()
        if proc.returncode != 0:
            if not continue_on_error:
                executed += 1
                break
        executed += 1
        if max_runs > 0 and executed >= max_runs:
            break
    return executed


def collect_run_metric_rows(
    manifest: Sequence[Dict[str, str]],
    repo_root: Path,
) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for item in manifest:
        if item.get("status") != STATUS_DONE:
            continue
        metrics = summarize_run_artifacts(item, repo_root=repo_root)
        if metrics is None:
            continue
        rows.append(
            {
                "run_id": item["run_id"],
                "board": item["board"],
                "config_id": item["config_id"],
                "config_source": item["config_source"],
                "seed": int(item["seed"]),
                **metrics,
            }
        )
    return rows


def aggregate_config(
    run_rows: Sequence[Dict[str, Any]],
    board: str,
    config_id: str,
    config_source: str,
    expected_seeds: int,
) -> Dict[str, Any]:
    subset = [
        r
        for r in run_rows
        if r["board"] == board
        and r["config_id"] == config_id
        and (config_id != "S1" or r["config_source"] == config_source)
    ]
    robust_vals = [float(r["run_robust_mean"]) for r in subset]
    cost_vals = [float(r["run_cost_mean"]) for r in subset]
    net_median_vals = [float(r["run_net_median"]) for r in subset]
    net_trim_vals = [
        float(r["run_net_trim10"]) for r in subset if r["run_net_trim10"] is not None
    ]
    lift_pos_vals = [float(r["run_lift_pos"]) for r in subset]
    turnover_vals = [float(r["run_turnover_mean"]) for r in subset]
    error_ratio_vals = [float(r["error_ratio"]) for r in subset]
    conformal_coverage_vals = [
        float(r["run_conformal_coverage_mean"])
        for r in subset
        if r.get("run_conformal_coverage_mean") is not None
    ]
    conformal_coverage_shift_vals = [
        float(r["run_conformal_coverage_shift_mean"])
        for r in subset
        if r.get("run_conformal_coverage_shift_mean") is not None
    ]
    conformal_sharpness_vals = [
        float(r["run_conformal_sharpness_pct_mean"])
        for r in subset
        if r.get("run_conformal_sharpness_pct_mean") is not None
    ]
    conformal_latest_lower_expected_return_vals = [
        float(r["run_conformal_latest_lower_expected_return_pct_mean"])
        for r in subset
        if r.get("run_conformal_latest_lower_expected_return_pct_mean") is not None
    ]
    regime_fallback_ratio_vals = [
        float(r["run_regime_fallback_ratio"])
        for r in subset
        if r.get("run_regime_fallback_ratio") is not None
    ]
    regime_numeric_warning_vals = [
        float(r["run_regime_numeric_warning_mean"])
        for r in subset
        if r.get("run_regime_numeric_warning_mean") is not None
    ]
    regime_cluster_balance_min_vals = [
        float(r["run_regime_cluster_balance_min"])
        for r in subset
        if r.get("run_regime_cluster_balance_min") is not None
    ]
    regime_time_index_miss_vals = [
        float(r["run_regime_time_index_miss_mean"])
        for r in subset
        if r.get("run_regime_time_index_miss_mean") is not None
    ]
    regime_future_alignment_risk_vals = [
        float(r["run_regime_future_alignment_risk"])
        for r in subset
        if r.get("run_regime_future_alignment_risk") is not None
    ]
    robust_ci_lb95, robust_ci_ub95 = bootstrap_ci(robust_vals)
    cost_ci_lb95, cost_ci_ub95 = bootstrap_ci(cost_vals)
    net_trim10_ci_lb95, net_trim10_ci_ub95 = bootstrap_ci(net_trim_vals)

    return {
        "board": board,
        "config_id": config_id,
        "config_source": config_source,
        "expected_seeds": expected_seeds,
        "completed_seeds": len(subset),
        "robust_mean": mean_or_none(robust_vals),
        "robust_std": stdev_or_zero(robust_vals),
        "robust_ci_lb95": robust_ci_lb95,
        "robust_ci_ub95": robust_ci_ub95,
        "cost_mean": mean_or_none(cost_vals),
        "cost_ci_lb95": cost_ci_lb95,
        "cost_ci_ub95": cost_ci_ub95,
        "net_median_mean": mean_or_none(net_median_vals),
        "net_trim10_mean": mean_or_none(net_trim_vals),
        "net_trim10_ci_lb95": net_trim10_ci_lb95,
        "net_trim10_ci_ub95": net_trim10_ci_ub95,
        "lift_pos_mean": mean_or_none(lift_pos_vals),
        "turnover_mean": mean_or_none(turnover_vals),
        "error_ratio_mean": mean_or_none(error_ratio_vals),
        "conformal_coverage_mean": mean_or_none(conformal_coverage_vals),
        "conformal_coverage_shift_mean": mean_or_none(conformal_coverage_shift_vals),
        "conformal_sharpness_pct_mean": mean_or_none(conformal_sharpness_vals),
        "conformal_latest_lower_expected_return_pct_mean": mean_or_none(
            conformal_latest_lower_expected_return_vals
        ),
        "regime_fallback_ratio_mean": mean_or_none(regime_fallback_ratio_vals),
        "regime_numeric_warning_mean": mean_or_none(regime_numeric_warning_vals),
        "regime_cluster_balance_min": mean_or_none(regime_cluster_balance_min_vals),
        "regime_time_index_miss_mean": mean_or_none(regime_time_index_miss_vals),
        "regime_future_alignment_risk_mean": mean_or_none(
            regime_future_alignment_risk_vals
        ),
    }


def all_main_complete(main_rows: Sequence[Dict[str, Any]], expected_seeds: int) -> bool:
    index = {row["config_id"]: row for row in main_rows}
    for config_id in MAIN_CONFIG_ORDER:
        row = index.get(config_id)
        if not row or int(row["completed_seeds"]) < expected_seeds:
            return False
    return True


def summarize_gate_binding(passes: Dict[str, Any]) -> Tuple[int, int, Optional[float]]:
    bool_values = [bool(v) for v in passes.values() if isinstance(v, bool)]
    if not bool_values:
        return 0, 0, None
    total = len(bool_values)
    failed = sum(1 for v in bool_values if not v)
    return total, failed, (failed / float(total))


def evaluate_main_gates(
    main_rows: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Optional[str], str]:
    index = {row["config_id"]: row for row in main_rows}
    baseline = index.get("H0")
    if not baseline or baseline["robust_mean"] is None:
        for row in main_rows:
            row["gate_pass_robust_uplift"] = ""
            row["gate_pass_robust_ci"] = ""
            row["gate_pass_variance"] = ""
            row["gate_pass_lift"] = ""
            row["gate_pass_turnover"] = ""
            row["gate_pass_net_trim10"] = ""
            row["gate_pass_error_ratio"] = ""
            row["gate_pass_conformal_shift_diag"] = ""
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""
            row["eligible"] = ""
            row["rank"] = ""
            row["notes"] = "missing H0 baseline"
        return main_rows, None, "H0 baseline not complete yet"

    b_robust = float(baseline["robust_mean"])
    b_robust_ci_lb = (
        float(baseline["robust_ci_lb95"])
        if baseline["robust_ci_lb95"] is not None
        else b_robust
    )
    b_std = float(baseline["robust_std"])
    b_lift = (
        float(baseline["lift_pos_mean"])
        if baseline["lift_pos_mean"] is not None
        else None
    )
    b_trim = (
        float(baseline["net_trim10_mean"])
        if baseline["net_trim10_mean"] is not None
        else None
    )
    b_turnover = (
        float(baseline["turnover_mean"])
        if baseline["turnover_mean"] is not None
        else None
    )
    b_conformal_shift = (
        float(baseline["conformal_coverage_shift_mean"])
        if baseline.get("conformal_coverage_shift_mean") is not None
        else None
    )
    variance_cap = max(b_std * 1.15, 0.020)

    eligible: List[Dict[str, Any]] = []
    for row in main_rows:
        if row["config_id"] == "H0":
            row["gate_pass_robust_uplift"] = ""
            row["gate_pass_robust_ci"] = ""
            row["gate_pass_variance"] = ""
            row["gate_pass_lift"] = ""
            row["gate_pass_turnover"] = ""
            row["gate_pass_net_trim10"] = ""
            row["gate_pass_error_ratio"] = ""
            row["gate_pass_conformal_shift_diag"] = ""
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""
            row["eligible"] = False
            row["rank"] = ""
            row["notes"] = row.get("notes", "")
            continue

        if row["completed_seeds"] < row["expected_seeds"]:
            row["gate_pass_robust_uplift"] = ""
            row["gate_pass_robust_ci"] = ""
            row["gate_pass_variance"] = ""
            row["gate_pass_lift"] = ""
            row["gate_pass_turnover"] = ""
            row["gate_pass_net_trim10"] = ""
            row["gate_pass_error_ratio"] = ""
            row["gate_pass_conformal_shift_diag"] = ""
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""
            row["eligible"] = ""
            row["rank"] = ""
            row["notes"] = "incomplete seeds"
            continue

        robust = row["robust_mean"]
        robust_ci_lb = row.get("robust_ci_lb95")
        robust_std = row["robust_std"]
        lift = row["lift_pos_mean"]
        turnover = row["turnover_mean"]
        trim = row["net_trim10_mean"]
        error_ratio = row.get("error_ratio_mean")
        conformal_shift = row.get("conformal_coverage_shift_mean")
        passes = {
            "gate_pass_robust_uplift": (
                robust is not None and robust >= b_robust + 0.010
            ),
            "gate_pass_robust_ci": (
                robust_ci_lb is not None and robust_ci_lb >= b_robust_ci_lb + 0.002
            ),
            "gate_pass_variance": (
                robust is not None
                and robust_std is not None
                and robust_std <= variance_cap
            ),
            "gate_pass_lift": (
                lift is not None and b_lift is not None and lift >= b_lift - 0.03
            ),
            "gate_pass_turnover": (
                turnover is not None
                and b_turnover is not None
                and turnover <= (MAIN_GATE_TURNOVER_CAP_MULTIPLIER * b_turnover)
            ),
            "gate_pass_net_trim10": (
                trim is not None and b_trim is not None and trim >= b_trim - 10.0
            ),
            "gate_pass_error_ratio": (error_ratio is not None and error_ratio <= 0.2),
        }
        row.update(passes)
        gate_total_count, gate_failed_count, gate_bindingness_ratio = (
            summarize_gate_binding(passes)
        )
        row["gate_total_count"] = gate_total_count
        row["gate_failed_count"] = gate_failed_count
        row["gate_bindingness_ratio"] = gate_bindingness_ratio
        if conformal_shift is None or b_conformal_shift is None:
            row["gate_pass_conformal_shift_diag"] = ""
        else:
            row["gate_pass_conformal_shift_diag"] = conformal_shift >= max(
                0.55, b_conformal_shift - 0.03
            )
        row["eligible"] = all(v is True for v in passes.values())
        row["rank"] = ""
        note_bits: List[str] = []
        if row["completed_seeds"] < row["expected_seeds"]:
            note_bits.append("incomplete seeds")
        if error_ratio is not None and error_ratio > 0.2:
            note_bits.append("high error ratio >0.2")
        if row.get("gate_pass_turnover") is False:
            note_bits.append(
                f"turnover above {MAIN_GATE_TURNOVER_CAP_MULTIPLIER:.2f}x H0 cap"
            )
        if row.get("gate_pass_conformal_shift_diag") is False:
            note_bits.append("conformal shift-coverage below baseline-0.03")
        row["notes"] = "; ".join(note_bits)
        if row["eligible"]:
            eligible.append(row)

    eligible_sorted = sorted(
        eligible,
        key=lambda r: (
            -(r["robust_ci_lb95"] if r["robust_ci_lb95"] is not None else -1e99),
            -(r["robust_mean"] if r["robust_mean"] is not None else -1e99),
            (r["robust_std"] if r["robust_std"] is not None else 1e99),
            -(r["net_trim10_mean"] if r["net_trim10_mean"] is not None else -1e99),
        ),
    )
    for rank, row in enumerate(eligible_sorted, start=1):
        row["rank"] = rank

    if eligible_sorted:
        champion = eligible_sorted[0]["config_id"]
        reason = (
            "selected by robust_ci_lb95 desc, robust_mean desc, "
            "robust_std asc, net_trim10_mean desc"
        )
    else:
        champion = "H0"
        reason = "no config passed all gates; fallback to H0"
    return main_rows, champion, reason


def evaluate_mixed_gates(
    mixed_rows: List[Dict[str, Any]],
) -> Tuple[List[Dict[str, Any]], Optional[bool], str]:
    index = {row["config_id"]: row for row in mixed_rows}
    s0 = index.get("S0")
    s1 = index.get("S1")
    if not s0 or s0["robust_mean"] is None:
        for row in mixed_rows:
            row["delta_robust_vs_s0"] = ""
            row["gate_pass_robust_delta"] = ""
            row["gate_pass_robust_ci_delta"] = ""
            row["gate_pass_lift_floor"] = ""
            row["gate_pass_turnover_cap"] = ""
            row["gate_pass_net_trim10"] = ""
            row["gate_pass_error_ratio"] = ""
            row["gate_pass_shift_coverage"] = ""
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""
            row["transfer_pass"] = ""
        return mixed_rows, None, "S0 baseline not complete yet"

    s0_robust = float(s0["robust_mean"])
    s0_robust_ci_lb = (
        float(s0["robust_ci_lb95"]) if s0["robust_ci_lb95"] is not None else s0_robust
    )
    s0_turnover = (
        float(s0["turnover_mean"]) if s0["turnover_mean"] is not None else None
    )
    s0_trim = (
        float(s0["net_trim10_mean"]) if s0["net_trim10_mean"] is not None else None
    )
    s0_shift_coverage = (
        float(s0["conformal_coverage_shift_mean"])
        if s0.get("conformal_coverage_shift_mean") is not None
        else None
    )

    final_transfer_pass: Optional[bool] = None
    reason = "S1 not complete yet"
    for row in mixed_rows:
        robust = row["robust_mean"]
        robust_ci_lb = row.get("robust_ci_lb95")
        lift = row["lift_pos_mean"]
        turnover = row["turnover_mean"]
        trim = row["net_trim10_mean"]
        error_ratio = row.get("error_ratio_mean")
        shift_coverage = row.get("conformal_coverage_shift_mean")
        delta_robust = robust - s0_robust if robust is not None else None
        row["delta_robust_vs_s0"] = delta_robust
        if row["config_id"] == "S1" and row["completed_seeds"] < row["expected_seeds"]:
            row["gate_pass_robust_delta"] = ""
            row["gate_pass_robust_ci_delta"] = ""
            row["gate_pass_lift_floor"] = ""
            row["gate_pass_turnover_cap"] = ""
            row["gate_pass_net_trim10"] = ""
            row["gate_pass_error_ratio"] = ""
            row["gate_pass_shift_coverage"] = ""
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""
            existing = row.get("notes", "")
            row["notes"] = "; ".join(x for x in [existing, "incomplete seeds"] if x)
            continue
        row["gate_pass_robust_delta"] = (
            delta_robust is not None and delta_robust >= 0.005
            if row["config_id"] == "S1"
            else ""
        )
        row["gate_pass_robust_ci_delta"] = (
            robust_ci_lb is not None and robust_ci_lb >= s0_robust_ci_lb
            if row["config_id"] == "S1"
            else ""
        )
        row["gate_pass_lift_floor"] = (
            lift is not None and lift >= 0.02 if row["config_id"] == "S1" else ""
        )
        row["gate_pass_turnover_cap"] = (
            turnover is not None
            and s0_turnover is not None
            and turnover <= (1.15 * s0_turnover)
            if row["config_id"] == "S1"
            else ""
        )
        row["gate_pass_net_trim10"] = (
            trim is not None and s0_trim is not None and trim >= (s0_trim - 5.0)
            if row["config_id"] == "S1"
            else ""
        )
        row["gate_pass_error_ratio"] = (
            error_ratio is not None and error_ratio <= 0.2
            if row["config_id"] == "S1"
            else ""
        )
        if row["config_id"] == "S1":
            if shift_coverage is None or s0_shift_coverage is None:
                row["gate_pass_shift_coverage"] = True
                existing = row.get("notes", "")
                row["notes"] = "; ".join(
                    x
                    for x in [
                        existing,
                        "shift coverage gate skipped (missing conformal metrics)",
                    ]
                    if x
                )
            else:
                row["gate_pass_shift_coverage"] = shift_coverage >= max(
                    0.55, s0_shift_coverage - 0.03
                )
        else:
            row["gate_pass_shift_coverage"] = ""
        if error_ratio is not None and error_ratio > 0.2:
            existing = row.get("notes", "")
            row["notes"] = "; ".join(
                x for x in [existing, "high error ratio >0.2"] if x
            )
        if row["config_id"] == "S1":
            s1_passes = {
                "gate_pass_robust_delta": row["gate_pass_robust_delta"],
                "gate_pass_robust_ci_delta": row["gate_pass_robust_ci_delta"],
                "gate_pass_lift_floor": row["gate_pass_lift_floor"],
                "gate_pass_turnover_cap": row["gate_pass_turnover_cap"],
                "gate_pass_net_trim10": row["gate_pass_net_trim10"],
                "gate_pass_error_ratio": row["gate_pass_error_ratio"],
                "gate_pass_shift_coverage": row["gate_pass_shift_coverage"],
            }
            gate_total_count, gate_failed_count, gate_bindingness_ratio = (
                summarize_gate_binding(s1_passes)
            )
            row["gate_total_count"] = gate_total_count
            row["gate_failed_count"] = gate_failed_count
            row["gate_bindingness_ratio"] = gate_bindingness_ratio
        else:
            row["gate_total_count"] = ""
            row["gate_failed_count"] = ""
            row["gate_bindingness_ratio"] = ""

    if s1 and s1["robust_mean"] is not None:
        transfer_pass = bool(
            s1["gate_pass_robust_delta"]
            and s1["gate_pass_robust_ci_delta"]
            and s1["gate_pass_lift_floor"]
            and s1["gate_pass_turnover_cap"]
            and s1["gate_pass_net_trim10"]
            and s1["gate_pass_error_ratio"]
            and s1["gate_pass_shift_coverage"]
        )
        s1["transfer_pass"] = transfer_pass
        final_transfer_pass = transfer_pass
        reason = "S1 transfer gates evaluated"
    else:
        if s1 is not None:
            s1["transfer_pass"] = ""
    return mixed_rows, final_transfer_pass, reason


def write_csv(
    path: Path, rows: Sequence[Dict[str, Any]], columns: Sequence[str]
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(columns))
        writer.writeheader()
        for row in rows:
            payload: Dict[str, Any] = {}
            for col in columns:
                value = row.get(col, "")
                if isinstance(value, float):
                    payload[col] = f"{value:.8f}"
                else:
                    payload[col] = value
            writer.writerow(payload)


def format_metric(value: Any, digits: int = 6) -> str:
    if value is None or value == "":
        return "n/a"
    try:
        return f"{float(value):.{digits}f}"
    except Exception:
        return str(value)


def build_decision_markdown(
    manifest: Sequence[Dict[str, str]],
    main_rows: Sequence[Dict[str, Any]],
    mixed_rows: Sequence[Dict[str, Any]],
    champion: Optional[str],
    champion_reason: str,
    transfer_pass: Optional[bool],
    transfer_reason: str,
    output_dir: Path,
) -> str:
    total = len(manifest)
    done = sum(1 for r in manifest if r.get("status") == STATUS_DONE)
    failed = sum(1 for r in manifest if r.get("status") == STATUS_FAILED)
    pending = sum(1 for r in manifest if r.get("status") == STATUS_PENDING)
    waiting = sum(1 for r in manifest if r.get("status") == STATUS_WAITING_CHAMPION)
    running = sum(1 for r in manifest if r.get("status") == STATUS_RUNNING)
    failed_rows = [r for r in manifest if r.get("status") == STATUS_FAILED]
    top_failed = failed_rows[:8]

    lines: List[str] = [
        "# CVAR Next Decision",
        "",
        f"- generatedAt: `{utc_now()}`",
        f"- experimentDir: `{output_dir}`",
        f"- totalRuns: `{total}`",
        f"- completedRuns: `{done}`",
        f"- failedRuns: `{failed}`",
        f"- pendingRuns: `{pending}`",
        f"- waitingChampionRuns: `{waiting}`",
        f"- runningRuns: `{running}`",
        "",
        "## Main Board (UM-only)",
        "",
        "| config | completedSeeds | robust_mean | robust_ci_lb95 | robust_std | net_trim10_mean | lift_pos_mean | conformal_shift_cov | error_ratio_mean | eligible | rank | gate_fail_cnt | gate_bind_ratio | notes |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---|",
    ]
    ordered_main = sorted(
        main_rows, key=lambda r: MAIN_CONFIG_ORDER.index(r["config_id"])
    )
    for row in ordered_main:
        lines.append(
            "| "
            f"{row['config_id']} | "
            f"{row['completed_seeds']}/{row['expected_seeds']} | "
            f"{format_metric(row.get('robust_mean'))} | "
            f"{format_metric(row.get('robust_ci_lb95'))} | "
            f"{format_metric(row.get('robust_std'))} | "
            f"{format_metric(row.get('net_trim10_mean'))} | "
            f"{format_metric(row.get('lift_pos_mean'))} | "
            f"{format_metric(row.get('conformal_coverage_shift_mean'))} | "
            f"{format_metric(row.get('error_ratio_mean'))} | "
            f"{row.get('eligible', '')} | "
            f"{row.get('rank', '')} | "
            f"{row.get('gate_failed_count', '')} | "
            f"{format_metric(row.get('gate_bindingness_ratio'))} | "
            f"{row.get('notes', '')} |"
        )

    challenger_rows = [
        row
        for row in ordered_main
        if str(row.get("config_id", "")).strip()
        and str(row.get("config_id", "")).strip() != "H0"
    ]

    def mean_metric(rows: Sequence[Dict[str, Any]], key: str) -> Optional[float]:
        values: List[float] = []
        for row in rows:
            value = row.get(key)
            if value is None or value == "":
                continue
            try:
                values.append(float(value))
            except Exception:
                continue
        if not values:
            return None
        return float(sum(values) / len(values))

    main_fallback_ratio = mean_metric(challenger_rows, "regime_fallback_ratio_mean")
    main_numeric_warning = mean_metric(challenger_rows, "regime_numeric_warning_mean")
    main_future_alignment_risk = mean_metric(
        challenger_rows, "regime_future_alignment_risk_mean"
    )
    if main_fallback_ratio is None:
        regime_risk_level = "unknown"
    elif main_fallback_ratio < 0.10:
        regime_risk_level = "low"
    elif main_fallback_ratio < 0.30:
        regime_risk_level = "medium"
    else:
        regime_risk_level = "high"

    risk_flags: List[str] = []
    if isinstance(main_numeric_warning, float) and main_numeric_warning > 0.0:
        risk_flags.append(
            f"numeric warnings present (mean={main_numeric_warning:.6f})"
        )
    if isinstance(main_future_alignment_risk, float) and main_future_alignment_risk > 0.0:
        risk_flags.append(
            f"time-index fallback risk detected (mean={main_future_alignment_risk:.6f})"
        )
    if not risk_flags:
        risk_flags.append("no additional regime diagnostic warnings")

    lines.extend(
        [
            "",
            "## Regime Diagnostics Risk",
            "",
            f"- mainAvgRegimeFallbackRatio: `{format_metric(main_fallback_ratio)}`",
            f"- mainAvgRegimeNumericWarning: `{format_metric(main_numeric_warning)}`",
            f"- mainAvgFutureAlignmentRisk: `{format_metric(main_future_alignment_risk)}`",
            f"- regimeRiskLevel: `{regime_risk_level}`",
            f"- regimeRiskNotes: {'; '.join(risk_flags)}",
            "",
            "## Main Champion",
            "",
            f"- champion: `{champion or 'pending'}`",
            f"- rationale: {champion_reason}",
            "",
            "## Mixed Board (spot+um)",
            "",
            "| config | source | completedSeeds | robust_mean | robust_ci_lb95 | delta_robust_vs_s0 | net_trim10_mean | lift_pos_mean | turnover_mean | conformal_shift_cov | error_ratio_mean | gate_fail_cnt | gate_bind_ratio | transfer_pass | notes |",
            "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for row in sorted(mixed_rows, key=lambda r: r["config_id"]):
        lines.append(
            "| "
            f"{row['config_id']} | "
            f"{row.get('config_source', '')} | "
            f"{row['completed_seeds']}/{row['expected_seeds']} | "
            f"{format_metric(row.get('robust_mean'))} | "
            f"{format_metric(row.get('robust_ci_lb95'))} | "
            f"{format_metric(row.get('delta_robust_vs_s0'))} | "
            f"{format_metric(row.get('net_trim10_mean'))} | "
            f"{format_metric(row.get('lift_pos_mean'))} | "
            f"{format_metric(row.get('turnover_mean'))} | "
            f"{format_metric(row.get('conformal_coverage_shift_mean'))} | "
            f"{format_metric(row.get('error_ratio_mean'))} | "
            f"{row.get('gate_failed_count', '')} | "
            f"{format_metric(row.get('gate_bindingness_ratio'))} | "
            f"{row.get('transfer_pass', '')} | "
            f"{row.get('notes', '')} |"
        )

    recommendation = "pending"
    if transfer_pass is True and champion and champion != "H0":
        recommendation = f"promote `{champion}` as new main config; S1 transfer passed"
    elif transfer_pass is False and champion:
        recommendation = "keep current deployment baseline; transfer gate failed"
    elif champion == "H0":
        recommendation = "keep H0 baseline; no challenger passed main gates"

    refresh_cmd = f"pnpm train:cvar-next-matrix -- --experiment-id {output_dir.name}"
    rerun_failed_cmd = (
        "pnpm train:cvar-next-matrix -- "
        f"--experiment-id {output_dir.name} --execute --continue-on-error --force-rerun-failed"
    )
    lock_champion_cmd = (
        "pnpm train:cvar-next-matrix -- "
        f"--experiment-id {output_dir.name} --champion-config {champion} --skip-stage2"
        if champion and champion in MAIN_CONFIGS
        else "pending champion"
    )

    lines.extend(
        [
            "",
            "## Transfer Verdict",
            "",
            f"- transferPass: `{transfer_pass if transfer_pass is not None else 'pending'}`",
            f"- transferRationale: {transfer_reason}",
            "",
            "## Recommendation",
            "",
            f"- {recommendation}",
            "",
            "## Execution Package",
            "",
            f"- refreshAggregates: `{refresh_cmd}`",
            f"- rerunFailed: `{rerun_failed_cmd}`",
            f"- lockChampionForShadow: `{lock_champion_cmd}`",
            "",
            "## Release Checklist",
            "",
            "- Confirm all 16 main-board runs are done before promoting challenger.",
            "- Require transferPass=true for S1 before any mixed-source adoption.",
            "- If error_ratio_mean > 0.2 on any candidate, block promotion and rerun failures.",
            "- Keep one full paper/shadow cycle before increasing live capital stage.",
        ]
    )

    if top_failed:
        lines.extend(
            [
                "",
                "## Failed Runs Snapshot",
                "",
                "| run_id | status | exit_code | started_at | finished_at |",
                "|---|---|---|---|---|",
            ]
        )
        for row in top_failed:
            lines.append(
                "| "
                f"{row.get('run_id', '')} | "
                f"{row.get('status', '')} | "
                f"{row.get('exit_code', '')} | "
                f"{row.get('started_at', '')} | "
                f"{row.get('finished_at', '')} |"
            )

    lines.extend(
        [
            "",
            "## Health Checks",
            "",
            "- `error_ratio_mean > 0.2` is marked as high risk in notes.",
            f"- Main-board turnover gate blocks candidates above `{MAIN_GATE_TURNOVER_CAP_MULTIPLIER:.2f}x` H0 turnover.",
            "- Main champion selection uses bootstrap CI lower-bound and mean robustness.",
            "- Run-level metrics use leaderboard statistics: mean/median/trimmed mean.",
            "- Symbol comparability is enforced by fixed allowlists in this protocol.",
        ]
    )
    return "\n".join(lines) + "\n"


def analyze_and_write(
    manifest: List[Dict[str, str]],
    repo_root: Path,
    output_dir: Path,
    expected_seeds: int,
) -> Tuple[
    List[Dict[str, Any]], List[Dict[str, Any]], Optional[str], str, Optional[bool], str
]:
    run_rows = collect_run_metric_rows(manifest, repo_root=repo_root)

    main_rows: List[Dict[str, Any]] = []
    for config_id in MAIN_CONFIG_ORDER:
        main_rows.append(
            aggregate_config(
                run_rows=run_rows,
                board="main",
                config_id=config_id,
                config_source="",
                expected_seeds=expected_seeds,
            )
        )
    main_rows, champion, champion_reason = evaluate_main_gates(main_rows)

    s1_source = ""
    for row in manifest:
        if row["config_id"] == "S1" and row["config_source"] in MAIN_CONFIGS:
            s1_source = row["config_source"]
            break
    mixed_rows = [
        aggregate_config(
            run_rows=run_rows,
            board="mixed",
            config_id="S0",
            config_source="H0",
            expected_seeds=expected_seeds,
        ),
        aggregate_config(
            run_rows=run_rows,
            board="mixed",
            config_id="S1",
            config_source=s1_source,
            expected_seeds=expected_seeds,
        ),
    ]
    mixed_rows[0]["notes"] = ""
    mixed_rows[1]["notes"] = ""
    mixed_rows, transfer_pass, transfer_reason = evaluate_mixed_gates(mixed_rows)

    main_cols = [
        "board",
        "config_id",
        "config_source",
        "expected_seeds",
        "completed_seeds",
        "robust_mean",
        "robust_std",
        "robust_ci_lb95",
        "robust_ci_ub95",
        "cost_mean",
        "cost_ci_lb95",
        "cost_ci_ub95",
        "net_median_mean",
        "net_trim10_mean",
        "net_trim10_ci_lb95",
        "net_trim10_ci_ub95",
        "lift_pos_mean",
        "turnover_mean",
        "error_ratio_mean",
        "conformal_coverage_mean",
        "conformal_coverage_shift_mean",
        "conformal_sharpness_pct_mean",
        "conformal_latest_lower_expected_return_pct_mean",
        "regime_fallback_ratio_mean",
        "regime_numeric_warning_mean",
        "regime_cluster_balance_min",
        "regime_time_index_miss_mean",
        "regime_future_alignment_risk_mean",
        "gate_pass_robust_uplift",
        "gate_pass_robust_ci",
        "gate_pass_variance",
        "gate_pass_lift",
        "gate_pass_turnover",
        "gate_pass_net_trim10",
        "gate_pass_error_ratio",
        "gate_pass_conformal_shift_diag",
        "gate_total_count",
        "gate_failed_count",
        "gate_bindingness_ratio",
        "eligible",
        "rank",
        "notes",
    ]
    mixed_cols = [
        "board",
        "config_id",
        "config_source",
        "expected_seeds",
        "completed_seeds",
        "robust_mean",
        "robust_std",
        "robust_ci_lb95",
        "robust_ci_ub95",
        "cost_mean",
        "cost_ci_lb95",
        "cost_ci_ub95",
        "net_median_mean",
        "net_trim10_mean",
        "net_trim10_ci_lb95",
        "net_trim10_ci_ub95",
        "lift_pos_mean",
        "turnover_mean",
        "error_ratio_mean",
        "conformal_coverage_mean",
        "conformal_coverage_shift_mean",
        "conformal_sharpness_pct_mean",
        "conformal_latest_lower_expected_return_pct_mean",
        "regime_fallback_ratio_mean",
        "regime_numeric_warning_mean",
        "regime_cluster_balance_min",
        "regime_time_index_miss_mean",
        "regime_future_alignment_risk_mean",
        "delta_robust_vs_s0",
        "gate_pass_robust_delta",
        "gate_pass_robust_ci_delta",
        "gate_pass_lift_floor",
        "gate_pass_turnover_cap",
        "gate_pass_net_trim10",
        "gate_pass_error_ratio",
        "gate_pass_shift_coverage",
        "gate_total_count",
        "gate_failed_count",
        "gate_bindingness_ratio",
        "transfer_pass",
        "notes",
    ]
    write_csv(output_dir / "board_main_aggregate.csv", main_rows, main_cols)
    write_csv(output_dir / "board_mixed_aggregate.csv", mixed_rows, mixed_cols)

    decision_md = build_decision_markdown(
        manifest=manifest,
        main_rows=main_rows,
        mixed_rows=mixed_rows,
        champion=champion,
        champion_reason=champion_reason,
        transfer_pass=transfer_pass,
        transfer_reason=transfer_reason,
        output_dir=output_dir,
    )
    (output_dir / "decision.md").write_text(decision_md, encoding="utf-8")

    return (
        main_rows,
        mixed_rows,
        champion,
        champion_reason,
        transfer_pass,
        transfer_reason,
    )


def write_experiment_spec(
    path: Path,
    args: argparse.Namespace,
    seeds: Sequence[int],
    resolved_profile_name: str,
    resolved_profile_source: str,
) -> None:
    payload = {
        "generatedAt": utc_now(),
        "script": "scripts/run_cvar_next_matrix.py",
        "profile": str(resolved_profile_name),
        "profileSource": str(resolved_profile_source),
        "profileArg": str(args.profile),
        "profileFileArg": str(args.profile_file or ""),
        "seeds": list(seeds),
        "mainConfigs": MAIN_CONFIGS,
        "boardSpecs": BOARD_SPECS,
        "basePipelineArgs": BASE_PIPELINE_ARGS,
        "cli": {
            "execute": bool(args.execute),
            "forceRerunFailed": bool(args.force_rerun_failed),
            "continueOnError": bool(args.continue_on_error),
            "maxRuns": int(args.max_runs),
            "championConfig": str(args.champion_config or ""),
            "skipStage2": bool(args.skip_stage2),
            "staleRunningMinutes": int(args.stale_running_minutes),
            "staleRunningTo": str(args.stale_running_to),
        },
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def main() -> int:
    args = parse_args()
    global MAIN_CONFIGS, MAIN_CONFIG_ORDER
    (
        resolved_profile_name,
        resolved_main_configs,
        resolved_main_order,
        resolved_profile_source,
    ) = resolve_main_profile(args)
    MAIN_CONFIGS = resolved_main_configs
    MAIN_CONFIG_ORDER = resolved_main_order

    default_repo_root = Path(__file__).resolve().parents[1]
    repo_root = (
        resolve_path(default_repo_root, args.repo_root)
        if args.repo_root
        else default_repo_root
    )
    wait_script = resolve_path(repo_root, args.wait_script)
    if not wait_script.exists():
        raise FileNotFoundError(f"wait script not found: {wait_script}")

    seeds = parse_seed_csv(args.seeds)
    expected_seeds = len(seeds)

    experiment_root = resolve_path(repo_root, args.experiment_root)
    experiment_dir = (experiment_root / args.experiment_id).resolve()
    experiment_dir.mkdir(parents=True, exist_ok=True)
    experiment_rel = (
        str(experiment_dir.relative_to(repo_root))
        if experiment_dir.is_relative_to(repo_root)
        else str(experiment_dir)
    )

    manifest_path = experiment_dir / "runs_manifest.csv"
    spec_path = experiment_dir / "experiment_spec.json"
    manifest = ensure_manifest(
        manifest_path, seeds=seeds, experiment_rel=experiment_rel
    )
    write_experiment_spec(
        spec_path,
        args=args,
        seeds=seeds,
        resolved_profile_name=resolved_profile_name,
        resolved_profile_source=resolved_profile_source,
    )
    recovered = recover_stale_running_rows(
        manifest=manifest,
        repo_root=repo_root,
        wait_script=wait_script,
        stale_minutes=args.stale_running_minutes,
        stale_to=args.stale_running_to,
    )
    if recovered:
        print(
            json.dumps(
                {
                    "staleRecoveredRuns": recovered,
                    "staleRunningTo": args.stale_running_to,
                    "staleRunningMinutes": args.stale_running_minutes,
                },
                ensure_ascii=False,
            )
        )

    locked_champion = select_locked_champion(manifest)
    if args.champion_config:
        manual = args.champion_config.strip().upper()
        if manual not in MAIN_CONFIGS:
            raise ValueError(
                f"--champion-config must be one of {list(MAIN_CONFIGS.keys())}"
            )
        if locked_champion and locked_champion != manual:
            raise ValueError(
                f"S1 champion already locked to {locked_champion}; cannot override to {manual}"
            )
        locked_champion = manual

    if locked_champion:
        materialize_stage2(
            manifest, champion=locked_champion, experiment_rel=experiment_rel
        )

    refresh_manifest_metrics(
        manifest=manifest,
        repo_root=repo_root,
        python_bin=args.python_bin,
        wait_script=wait_script,
    )
    write_manifest(manifest_path, manifest)

    main_rows, _, champion, _, _, _ = analyze_and_write(
        manifest=manifest,
        repo_root=repo_root,
        output_dir=experiment_dir,
        expected_seeds=expected_seeds,
    )
    write_manifest(manifest_path, manifest)

    if args.execute:
        recovered = recover_stale_running_rows(
            manifest=manifest,
            repo_root=repo_root,
            wait_script=wait_script,
            stale_minutes=args.stale_running_minutes,
            stale_to=args.stale_running_to,
        )
        if recovered:
            print(
                json.dumps(
                    {
                        "staleRecoveredRuns": recovered,
                        "phase": "pre_stage1",
                    },
                    ensure_ascii=False,
                )
            )
        run_pending(
            manifest=manifest,
            repo_root=repo_root,
            python_bin=args.python_bin,
            wait_script=wait_script,
            manifest_path=manifest_path,
            stage="1",
            max_runs=args.max_runs,
            continue_on_error=args.continue_on_error,
            force_rerun_failed=args.force_rerun_failed,
        )
        recover_stale_running_rows(
            manifest=manifest,
            repo_root=repo_root,
            wait_script=wait_script,
            stale_minutes=args.stale_running_minutes,
            stale_to=args.stale_running_to,
        )
        refresh_manifest_metrics(
            manifest=manifest,
            repo_root=repo_root,
            python_bin=args.python_bin,
            wait_script=wait_script,
        )
        write_manifest(manifest_path, manifest)

        main_rows, _, champion, champion_reason, _, _ = analyze_and_write(
            manifest=manifest,
            repo_root=repo_root,
            output_dir=experiment_dir,
            expected_seeds=expected_seeds,
        )
        write_manifest(manifest_path, manifest)

        if not args.skip_stage2:
            locked_after_stage1 = select_locked_champion(manifest)
            if locked_after_stage1:
                champion = locked_after_stage1
            elif (
                all_main_complete(main_rows, expected_seeds=expected_seeds) and champion
            ):
                materialize_stage2(
                    manifest=manifest, champion=champion, experiment_rel=experiment_rel
                )
            refresh_manifest_metrics(
                manifest=manifest,
                repo_root=repo_root,
                python_bin=args.python_bin,
                wait_script=wait_script,
            )
            write_manifest(manifest_path, manifest)

            run_pending(
                manifest=manifest,
                repo_root=repo_root,
                python_bin=args.python_bin,
                wait_script=wait_script,
                manifest_path=manifest_path,
                stage="2",
                max_runs=args.max_runs,
                continue_on_error=args.continue_on_error,
                force_rerun_failed=args.force_rerun_failed,
            )
            recover_stale_running_rows(
                manifest=manifest,
                repo_root=repo_root,
                wait_script=wait_script,
                stale_minutes=args.stale_running_minutes,
                stale_to=args.stale_running_to,
            )
            refresh_manifest_metrics(
                manifest=manifest,
                repo_root=repo_root,
                python_bin=args.python_bin,
                wait_script=wait_script,
            )
            write_manifest(manifest_path, manifest)

            analyze_and_write(
                manifest=manifest,
                repo_root=repo_root,
                output_dir=experiment_dir,
                expected_seeds=expected_seeds,
            )
            write_manifest(manifest_path, manifest)

    done = sum(1 for row in manifest if row["status"] == STATUS_DONE)
    failed = sum(1 for row in manifest if row["status"] == STATUS_FAILED)
    pending = sum(1 for row in manifest if row["status"] == STATUS_PENDING)
    waiting = sum(1 for row in manifest if row["status"] == STATUS_WAITING_CHAMPION)
    print(
        json.dumps(
            {
                "experimentDir": str(experiment_dir),
                "manifestPath": str(manifest_path),
                "doneRuns": done,
                "failedRuns": failed,
                "pendingRuns": pending,
                "waitingChampionRuns": waiting,
                "mainAggregateCsv": str(experiment_dir / "board_main_aggregate.csv"),
                "mixedAggregateCsv": str(experiment_dir / "board_mixed_aggregate.csv"),
                "decisionPath": str(experiment_dir / "decision.md"),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
