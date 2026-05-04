#!/usr/bin/env python3
"""Monitor CVaR next matrix experiments (status, process, freshness, ETA)."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

STATUS_ORDER = ["running", "done", "failed", "pending", "waiting_champion"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Monitor run_cvar_next_matrix experiments with runtime/stale insights."
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
        default="",
        help="Specific experiment id. If omitted, use latest directory.",
    )
    parser.add_argument(
        "--stale-minutes",
        type=int,
        default=120,
        help="Mark running rows stale when no signal > this minutes.",
    )
    parser.add_argument(
        "--watch",
        action="store_true",
        help="Continuously print snapshots.",
    )
    parser.add_argument(
        "--interval-sec",
        type=int,
        default=30,
        help="Watch interval seconds.",
    )
    parser.add_argument(
        "--max-iterations",
        type=int,
        default=0,
        help="Max watch iterations (0 = unlimited).",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print JSON instead of human-friendly text.",
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


def read_manifest(path: Path) -> List[Dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def count_status(rows: Sequence[Dict[str, str]]) -> Dict[str, int]:
    counts: Dict[str, int] = {k: 0 for k in STATUS_ORDER}
    for row in rows:
        status = (row.get("status") or "").strip()
        counts[status] = counts.get(status, 0) + 1
    return counts


def list_active_training_cmdlines() -> List[str]:
    try:
        proc = subprocess.run(
            ["ps", "-axo", "command"],
            check=True,
            capture_output=True,
            text=True,
        )
    except Exception:
        return []
    out: List[str] = []
    for line in proc.stdout.splitlines():
        cmd = line.strip()
        if not cmd:
            continue
        if "wait_clean_and_retrain.py" in cmd:
            out.append(cmd)
    return out


def extract_output_root_from_cmdline(cmdline: str) -> Optional[str]:
    try:
        parts = shlex.split(cmdline)
    except Exception:
        return None
    for idx, token in enumerate(parts):
        if token == "--output-root" and idx + 1 < len(parts):
            return parts[idx + 1]
    return None


def find_last_artifact_time(
    repo_root: Path, row: Dict[str, str]
) -> Optional[dt.datetime]:
    output_root_raw = (row.get("output_root") or "").strip()
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
            t = dt.datetime.fromtimestamp(path.stat().st_mtime, tz=dt.timezone.utc)
        except Exception:
            continue
        if latest is None or t > latest:
            latest = t
    return latest


def parse_rank1_champion(board_main_csv: Path) -> Optional[str]:
    if not board_main_csv.exists():
        return None
    try:
        with board_main_csv.open("r", encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                rank = (row.get("rank") or "").strip()
                if rank == "1":
                    return (row.get("config_id") or "").strip() or None
    except Exception:
        return None
    return None


def average_done_runtime_minutes(
    rows: Sequence[Dict[str, str]],
    repo_root: Path,
) -> Optional[float]:
    durations: List[float] = []
    for row in rows:
        if (row.get("status") or "") != "done":
            continue
        started = parse_iso8601(row.get("started_at") or "")
        finished = parse_iso8601(row.get("finished_at") or "")
        if started is None or finished is None:
            continue
        delta = (finished - started).total_seconds()
        if delta > 0:
            durations.append(delta / 60.0)
    if durations:
        return sum(durations) / len(durations)

    # Fallback: infer per-run cadence from done-row artifact timestamps.
    done_artifacts = [
        find_last_artifact_time(repo_root, row)
        for row in rows
        if (row.get("status") or "") == "done"
    ]
    times = sorted([t for t in done_artifacts if t is not None], reverse=True)
    if len(times) < 2:
        return None
    inferred: List[float] = []
    for idx in range(len(times) - 1):
        delta_min = (times[idx] - times[idx + 1]).total_seconds() / 60.0
        if 0.1 <= delta_min <= 24 * 60:
            inferred.append(delta_min)
    if not inferred:
        return None
    return sum(inferred) / len(inferred)


def estimate_eta_minutes(
    rows: Sequence[Dict[str, str]],
    active_processes: int,
    repo_root: Path,
) -> Optional[float]:
    avg_runtime = average_done_runtime_minutes(rows, repo_root=repo_root)
    if avg_runtime is None:
        return None
    pending = sum(1 for r in rows if (r.get("status") or "") == "pending")
    running = sum(1 for r in rows if (r.get("status") or "") == "running")
    waiting = sum(1 for r in rows if (r.get("status") or "") == "waiting_champion")
    # stage2 waiting rows are not guaranteed to run; downweight by 0.5
    remaining_units = pending + running + int(round(waiting * 0.5))
    if remaining_units <= 0:
        return 0.0
    concurrency = max(active_processes, 1)
    return (avg_runtime * remaining_units) / concurrency


def gpu_snapshot() -> List[Dict[str, Any]]:
    cmd = [
        "nvidia-smi",
        "--query-gpu=index,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
        "--format=csv,noheader,nounits",
    ]
    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except Exception:
        return []
    rows: List[Dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 6:
            continue
        try:
            rows.append(
                {
                    "gpu": int(parts[0]),
                    "util_pct": float(parts[1]),
                    "mem_used_mb": float(parts[2]),
                    "mem_total_mb": float(parts[3]),
                    "temp_c": float(parts[4]),
                    "power_w": float(parts[5]),
                }
            )
        except Exception:
            continue
    return rows


def choose_experiment_dir(experiment_root: Path, experiment_id: str) -> Path:
    if experiment_id:
        path = experiment_root / experiment_id
        if not path.exists():
            raise FileNotFoundError(f"experiment not found: {path}")
        return path

    candidates = [p for p in experiment_root.glob("*") if p.is_dir()]
    if not candidates:
        raise FileNotFoundError(f"no experiments found under {experiment_root}")
    return sorted(candidates, key=lambda p: p.stat().st_mtime, reverse=True)[0]


def build_snapshot(
    repo_root: Path, experiment_dir: Path, stale_minutes: int
) -> Dict[str, Any]:
    now = dt.datetime.now(dt.timezone.utc)
    manifest_path = experiment_dir / "runs_manifest.csv"
    rows = read_manifest(manifest_path)
    counts = count_status(rows)
    active_cmds = list_active_training_cmdlines()
    active_output_roots = [
        v for v in (extract_output_root_from_cmdline(cmd) for cmd in active_cmds) if v
    ]
    active_run_ids = sorted(
        {
            row.get("run_id") or ""
            for row in rows
            if (row.get("output_root") or "").strip() in active_output_roots
        }
    )
    process_manifest_mismatch = sorted(
        run_id
        for run_id in active_run_ids
        if (
            next(
                (
                    (r.get("status") or "")
                    for r in rows
                    if (r.get("run_id") or "") == run_id
                ),
                "",
            )
            != "running"
        )
    )

    running_rows: List[Dict[str, Any]] = []
    stale_rows: List[str] = []
    for row in rows:
        if (row.get("status") or "") != "running":
            continue
        run_id = row.get("run_id") or ""
        started = parse_iso8601(row.get("started_at") or "")
        artifact = find_last_artifact_time(repo_root, row)
        signal_times = [t for t in [started, artifact] if t is not None]
        last_signal = max(signal_times) if signal_times else None
        idle_minutes = None
        if last_signal is not None:
            idle_minutes = (now - last_signal).total_seconds() / 60.0
        running_rows.append(
            {
                "run_id": run_id,
                "started_at": started.isoformat() if started else "",
                "last_artifact_at": artifact.isoformat() if artifact else "",
                "idle_minutes": idle_minutes,
            }
        )
        if (
            idle_minutes is not None
            and stale_minutes > 0
            and idle_minutes > stale_minutes
        ):
            stale_rows.append(run_id)

    recent_updates: List[Dict[str, Any]] = []
    for row in rows:
        artifact = find_last_artifact_time(repo_root, row)
        if artifact is None:
            continue
        recent_updates.append(
            {
                "run_id": row.get("run_id") or "",
                "status": row.get("status") or "",
                "artifact_at": artifact.isoformat(),
                "artifact_epoch": artifact.timestamp(),
            }
        )
    recent_updates.sort(key=lambda x: x["artifact_epoch"], reverse=True)
    for item in recent_updates:
        item.pop("artifact_epoch", None)

    board_main = experiment_dir / "board_main_aggregate.csv"
    board_mixed = experiment_dir / "board_mixed_aggregate.csv"
    decision_md = experiment_dir / "decision.md"

    eta_minutes = estimate_eta_minutes(
        rows,
        active_processes=len(active_cmds),
        repo_root=repo_root,
    )

    return {
        "generatedAt": now.isoformat(),
        "experimentDir": str(experiment_dir),
        "manifestPath": str(manifest_path),
        "status": counts,
        "activeTrainingProcesses": len(active_cmds),
        "activeTrainingCmds": active_cmds,
        "activeRunIdsFromProcess": active_run_ids,
        "processManifestMismatchRunIds": process_manifest_mismatch,
        "runningRows": running_rows,
        "staleRunningRows": stale_rows,
        "recentArtifactUpdates": recent_updates[:8],
        "championRank1": parse_rank1_champion(board_main),
        "hasMainAggregate": board_main.exists(),
        "hasMixedAggregate": board_mixed.exists(),
        "hasDecision": decision_md.exists(),
        "etaMinutesApprox": eta_minutes,
        "gpu": gpu_snapshot(),
    }


def format_snapshot(snapshot: Dict[str, Any]) -> str:
    status = snapshot.get("status", {})
    lines = [
        f"[{snapshot.get('generatedAt')}] {snapshot.get('experimentDir')}",
        "status: "
        + ", ".join(
            f"{k}={status.get(k, 0)}"
            for k in STATUS_ORDER
            if status.get(k, 0) or k in status
        ),
        f"activeTrainingProcesses: {snapshot.get('activeTrainingProcesses', 0)}",
        f"championRank1: {snapshot.get('championRank1') or 'n/a'}",
    ]
    active_run_ids = snapshot.get("activeRunIdsFromProcess", [])
    if active_run_ids:
        lines.append("activeRunIdsFromProcess: " + ", ".join(active_run_ids))
    mismatches = snapshot.get("processManifestMismatchRunIds", [])
    if mismatches:
        lines.append("processManifestMismatchRunIds: " + ", ".join(mismatches))

    eta = snapshot.get("etaMinutesApprox")
    if eta is None:
        lines.append("etaApprox: n/a (insufficient done-run timing)")
    else:
        lines.append(f"etaApprox: {eta:.1f} min")

    stale = snapshot.get("staleRunningRows", [])
    if stale:
        lines.append("staleRunningRows: " + ", ".join(stale))

    recent = snapshot.get("recentArtifactUpdates", [])
    if recent:
        lines.append("recentArtifactUpdates:")
        for item in recent[:5]:
            lines.append(
                f"  - {item.get('run_id')} ({item.get('status')}): {item.get('artifact_at')}"
            )

    gpu = snapshot.get("gpu", [])
    if gpu:
        lines.append("gpu:")
        for g in gpu:
            lines.append(
                "  - GPU{gpu}: util={util:.0f}% mem={used:.0f}/{total:.0f}MB temp={temp:.0f}C power={power:.0f}W".format(
                    gpu=g.get("gpu", -1),
                    util=g.get("util_pct", 0.0),
                    used=g.get("mem_used_mb", 0.0),
                    total=g.get("mem_total_mb", 0.0),
                    temp=g.get("temp_c", 0.0),
                    power=g.get("power_w", 0.0),
                )
            )

    return "\n".join(lines)


def run_once(args: argparse.Namespace) -> None:
    default_repo_root = Path(__file__).resolve().parents[1]
    repo_root = (
        resolve_path(default_repo_root, args.repo_root)
        if args.repo_root
        else default_repo_root
    )
    experiment_root = resolve_path(repo_root, args.experiment_root)
    experiment_dir = choose_experiment_dir(experiment_root, args.experiment_id)
    snapshot = build_snapshot(
        repo_root=repo_root,
        experiment_dir=experiment_dir,
        stale_minutes=args.stale_minutes,
    )
    if args.json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
    else:
        print(format_snapshot(snapshot))


def main() -> int:
    args = parse_args()
    if not args.watch:
        run_once(args)
        return 0

    iteration = 0
    while True:
        iteration += 1
        run_once(args)
        if args.max_iterations > 0 and iteration >= args.max_iterations:
            break
        time.sleep(max(args.interval_sec, 1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
