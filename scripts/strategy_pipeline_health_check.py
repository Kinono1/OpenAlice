#!/usr/bin/env python3
"""Health checks for 24x7 strategy research/optimization pipeline."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

STATUS_RANK: Dict[str, int] = {"ok": 0, "warning": 1, "critical": 2}
RUN_ID_RE = re.compile(r"^(\d{8}T\d{6})(\d{1,6})?Z$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Check freshness and queue pressure of strategy-watch/optimize/"
            "queue-drain pipeline and emit low-noise alerts."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--watch-digest",
        default="data/research/strategy-watch/latest_digest.json",
        help="Path to watch digest JSON.",
    )
    parser.add_argument(
        "--optimize-report",
        default="data/research/strategy-watch/execution/latest_loop_report.json",
        help="Path to optimize loop latest report JSON.",
    )
    parser.add_argument(
        "--queue-drain-report",
        default=(
            "data/research/strategy-watch/execution/queue-drain/"
            "latest_queue_drain_report.json"
        ),
        help="Path to queue-drain latest report JSON.",
    )
    parser.add_argument(
        "--queue-file",
        default="data/research/strategy-watch/execution/pending_queue.json",
        help="Path to queue JSON.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy-watch/health",
        help="Output directory for health reports.",
    )
    parser.add_argument(
        "--state-file",
        default="data/research/strategy-watch/health/state.json",
        help="State file for alert cooldown and transition tracking.",
    )
    parser.add_argument(
        "--alerts-file",
        default="data/research/strategy-watch/health/alerts.ndjson",
        help="Alert event stream path (NDJSON).",
    )
    parser.add_argument(
        "--stale-watch-minutes",
        type=int,
        default=90,
        help="Mark watch stale when older than this many minutes.",
    )
    parser.add_argument(
        "--stale-optimize-minutes",
        type=int,
        default=20,
        help="Mark optimize stale when older than this many minutes.",
    )
    parser.add_argument(
        "--stale-queue-drain-minutes",
        type=int,
        default=20,
        help="Mark queue-drain stale when older than this many minutes.",
    )
    parser.add_argument(
        "--max-queue-items",
        type=int,
        default=36,
        help="Warn when queue length exceeds this threshold.",
    )
    parser.add_argument(
        "--max-legacy-ratio",
        type=float,
        default=0.65,
        help="Warn when legacy queue ratio exceeds this threshold (0~1).",
    )
    parser.add_argument(
        "--alert-cooldown-minutes",
        type=int,
        default=60,
        help="Minimum minutes between same-status alerts.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write report/state/alerts.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (root / p).resolve()


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def append_ndjson(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(payload, ensure_ascii=False) + "\n")


def parse_iso8601(raw: Any) -> Optional[dt.datetime]:
    text = str(raw or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(text)
    except Exception:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def parse_run_id_ts(run_id: Any) -> Optional[dt.datetime]:
    text = str(run_id or "").strip()
    if not text:
        return None
    m = RUN_ID_RE.match(text)
    if not m:
        return None
    base = m.group(1)
    frac = m.group(2) or ""
    try:
        parsed = dt.datetime.strptime(base, "%Y%m%dT%H%M%S").replace(
            tzinfo=dt.timezone.utc
        )
    except Exception:
        return None
    if frac:
        us = int((frac[:6]).ljust(6, "0"))
        parsed = parsed.replace(microsecond=us)
    return parsed


def timestamp_from_payload(payload: Any) -> Optional[dt.datetime]:
    if not isinstance(payload, dict):
        return None
    for key in ("generated_at", "last_run_at", "run_at", "finished_at"):
        parsed = parse_iso8601(payload.get(key))
        if parsed is not None:
            return parsed
    return parse_run_id_ts(payload.get("run_id"))


def stale_level(age_minutes: float, threshold: int) -> str:
    if threshold <= 0:
        return "ok"
    if age_minutes > threshold * 2:
        return "critical"
    if age_minutes > threshold:
        return "warning"
    return "ok"


def source_health(
    name: str,
    path: Path,
    stale_threshold_minutes: int,
    now: dt.datetime,
) -> Tuple[Dict[str, Any], List[Dict[str, str]]]:
    issues: List[Dict[str, str]] = []
    if not path.exists():
        issues.append(
            {
                "level": "critical",
                "code": f"{name}_missing",
                "message": f"{name} report missing: {path}",
            }
        )
        return (
            {
                "name": name,
                "path": str(path),
                "exists": False,
                "run_id": "",
                "generated_at": "",
                "age_minutes": None,
                "status": "critical",
            },
            issues,
        )

    payload = load_json(path, {})
    run_id = str(payload.get("run_id", "")) if isinstance(payload, dict) else ""
    ts = timestamp_from_payload(payload)
    if ts is None:
        issues.append(
            {
                "level": "warning",
                "code": f"{name}_timestamp_unknown",
                "message": f"{name} report has no parseable timestamp: {path}",
            }
        )
        return (
            {
                "name": name,
                "path": str(path),
                "exists": True,
                "run_id": run_id,
                "generated_at": "",
                "age_minutes": None,
                "status": "warning",
            },
            issues,
        )

    age_minutes = (now - ts).total_seconds() / 60.0
    status = stale_level(age_minutes, stale_threshold_minutes)
    if status != "ok":
        issues.append(
            {
                "level": status,
                "code": f"{name}_stale",
                "message": (
                    f"{name} stale: age={age_minutes:.1f}m > "
                    f"threshold={stale_threshold_minutes}m"
                ),
            }
        )
    return (
        {
            "name": name,
            "path": str(path),
            "exists": True,
            "run_id": run_id,
            "generated_at": iso(ts),
            "age_minutes": round(age_minutes, 3),
            "status": status,
        },
        issues,
    )


def queue_direction_counts(rows: Sequence[Dict[str, Any]]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        raw = str(row.get("optimize_direction", "")).strip().lower()
        key = raw if raw else "legacy"
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: (kv[0] != "legacy", kv[0])))


def active_train_cmds() -> List[str]:
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
        if "strategy_pipeline_health_check.py" in cmd:
            continue
        if "wait_clean_and_retrain.py" in cmd or "run_cvar_next_matrix.py" in cmd:
            out.append(cmd)
    return out


def max_status(left: str, right: str) -> str:
    return left if STATUS_RANK[left] >= STATUS_RANK[right] else right


def report_markdown(payload: Dict[str, Any]) -> str:
    lines = [
        "# Strategy Pipeline Health",
        "",
        f"- generatedAt: `{payload.get('generated_at', '')}`",
        f"- runId: `{payload.get('run_id', '')}`",
        f"- status: `{payload.get('status', 'ok')}`",
        f"- queueLength: `{payload.get('queue_length', 0)}`",
        f"- queueLegacyRatio: `{payload.get('queue_legacy_ratio', 0.0):.4f}`",
        f"- activeTrainingCount: `{payload.get('active_training_count', 0)}`",
        f"- staleWatchMinutes: `{payload.get('stale_watch_minutes', 0)}`",
        f"- staleOptimizeMinutes: `{payload.get('stale_optimize_minutes', 0)}`",
        f"- staleQueueDrainMinutes: `{payload.get('stale_queue_drain_minutes', 0)}`",
        "",
        "## Sources",
        "",
        "| source | status | age_minutes | run_id | path |",
        "|---|---|---:|---|---|",
    ]
    for key in ("watch", "optimize", "queue_drain"):
        row = payload.get("sources", {}).get(key, {})
        lines.append(
            "| "
            f"{key} | "
            f"{row.get('status', '')} | "
            f"{row.get('age_minutes', '')} | "
            f"{row.get('run_id', '')} | "
            f"{row.get('path', '')} |"
        )

    lines.extend(
        [
            "",
            "## Queue By Direction",
            "",
            f"`{json.dumps(payload.get('queue_by_direction', {}), ensure_ascii=False)}`",
            "",
            "## Issues",
            "",
        ]
    )
    issues = payload.get("issues", [])
    if isinstance(issues, list) and issues:
        for issue in issues:
            lines.append(
                "- "
                f"[{issue.get('level', '')}] "
                f"{issue.get('code', '')}: {issue.get('message', '')}"
            )
    else:
        lines.append("- none")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).resolve()
        if args.repo_root
        else Path(__file__).resolve().parent.parent
    )
    watch_path = resolve_path(repo_root, args.watch_digest)
    optimize_path = resolve_path(repo_root, args.optimize_report)
    queue_drain_path = resolve_path(repo_root, args.queue_drain_report)
    queue_path = resolve_path(repo_root, args.queue_file)
    out_dir = resolve_path(repo_root, args.out_dir)
    state_path = resolve_path(repo_root, args.state_file)
    alerts_path = resolve_path(repo_root, args.alerts_file)

    now = now_utc()
    run_id = now.strftime("%Y%m%dT%H%M%SZ")

    watch_check, watch_issues = source_health(
        name="watch",
        path=watch_path,
        stale_threshold_minutes=max(int(args.stale_watch_minutes), 1),
        now=now,
    )
    optimize_check, optimize_issues = source_health(
        name="optimize",
        path=optimize_path,
        stale_threshold_minutes=max(int(args.stale_optimize_minutes), 1),
        now=now,
    )
    drain_check, drain_issues = source_health(
        name="queue_drain",
        path=queue_drain_path,
        stale_threshold_minutes=max(int(args.stale_queue_drain_minutes), 1),
        now=now,
    )

    queue_payload = load_json(queue_path, [])
    queue_rows: List[Dict[str, Any]] = []
    if isinstance(queue_payload, list):
        queue_rows = [x for x in queue_payload if isinstance(x, dict)]
    queue_len = len(queue_rows)
    queue_by_direction = queue_direction_counts(queue_rows)
    legacy_count = int(queue_by_direction.get("legacy", 0))
    legacy_ratio = float(legacy_count / queue_len) if queue_len > 0 else 0.0

    issues: List[Dict[str, str]] = []
    issues.extend(watch_issues)
    issues.extend(optimize_issues)
    issues.extend(drain_issues)
    if queue_len > int(args.max_queue_items):
        level = "warning" if queue_len <= int(args.max_queue_items) * 2 else "critical"
        issues.append(
            {
                "level": level,
                "code": "queue_pressure",
                "message": (
                    f"queue length high: {queue_len} > max_queue_items="
                    f"{int(args.max_queue_items)}"
                ),
            }
        )
    if queue_len >= 5 and legacy_ratio > float(args.max_legacy_ratio):
        issues.append(
            {
                "level": "warning",
                "code": "legacy_queue_ratio_high",
                "message": (
                    f"legacy ratio high: {legacy_ratio:.3f} > "
                    f"max_legacy_ratio={float(args.max_legacy_ratio):.3f}"
                ),
            }
        )

    active_training = active_train_cmds()
    overall = "ok"
    for issue in issues:
        lvl = str(issue.get("level", "warning")).lower()
        if lvl not in STATUS_RANK:
            lvl = "warning"
        overall = max_status(overall, lvl)

    payload: Dict[str, Any] = {
        "generated_at": iso(now),
        "run_id": run_id,
        "status": overall,
        "stale_watch_minutes": int(args.stale_watch_minutes),
        "stale_optimize_minutes": int(args.stale_optimize_minutes),
        "stale_queue_drain_minutes": int(args.stale_queue_drain_minutes),
        "max_queue_items": int(args.max_queue_items),
        "max_legacy_ratio": float(args.max_legacy_ratio),
        "queue_length": queue_len,
        "queue_by_direction": queue_by_direction,
        "queue_legacy_count": legacy_count,
        "queue_legacy_ratio": round(legacy_ratio, 6),
        "active_training_count": len(active_training),
        "active_training_cmds": active_training[:8],
        "sources": {
            "watch": watch_check,
            "optimize": optimize_check,
            "queue_drain": drain_check,
        },
        "issues": issues,
        "dry_run": bool(args.dry_run),
    }

    state_payload = load_json(state_path, {})
    last_status = str(state_payload.get("last_status", ""))
    last_signature = str(state_payload.get("last_issue_signature", ""))
    last_alert_at = parse_iso8601(state_payload.get("last_alert_at", ""))
    issue_signature = "|".join(
        sorted(
            f"{str(x.get('level', '')).lower()}:{str(x.get('code', '')).lower()}"
            for x in issues
        )
    )

    cooldown_elapsed = True
    if last_alert_at is not None and int(args.alert_cooldown_minutes) > 0:
        age_minutes = (now - last_alert_at).total_seconds() / 60.0
        cooldown_elapsed = age_minutes >= int(args.alert_cooldown_minutes)

    should_alert = bool(
        overall != "ok"
        and (
            overall != last_status
            or issue_signature != last_signature
            or cooldown_elapsed
        )
    )
    should_resolve = bool(overall == "ok" and last_status in {"warning", "critical"})

    if not args.dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        archive_dir = out_dir / "archive" / run_id
        save_json(out_dir / "latest_health_report.json", payload)
        save_json(archive_dir / "health_report.json", payload)
        (out_dir / "latest_health_report.md").write_text(
            report_markdown(payload),
            encoding="utf-8",
        )
        (archive_dir / "health_report.md").write_text(
            report_markdown(payload),
            encoding="utf-8",
        )

        if should_alert:
            append_ndjson(
                alerts_path,
                {
                    "generated_at": iso(now),
                    "run_id": run_id,
                    "event": "alert",
                    "status": overall,
                    "issues": issues,
                    "queue_length": queue_len,
                    "queue_by_direction": queue_by_direction,
                },
            )
        elif should_resolve:
            append_ndjson(
                alerts_path,
                {
                    "generated_at": iso(now),
                    "run_id": run_id,
                    "event": "resolved",
                    "status": overall,
                    "prev_status": last_status,
                    "queue_length": queue_len,
                    "queue_by_direction": queue_by_direction,
                },
            )

        save_json(
            state_path,
            {
                "last_run_at": iso(now),
                "last_status": overall,
                "last_issue_signature": issue_signature,
                "last_alert_at": iso(now)
                if should_alert
                else state_payload.get("last_alert_at", ""),
                "last_alert_issued": bool(should_alert),
                "last_resolved_issued": bool(should_resolve),
                "history": (
                    list(state_payload.get("history", []))
                    if isinstance(state_payload.get("history", []), list)
                    else []
                )[-99:]
                + [
                    {
                        "run_id": run_id,
                        "run_at": iso(now),
                        "status": overall,
                        "issue_count": len(issues),
                        "queue_length": queue_len,
                    }
                ],
            },
        )

    print(
        json.dumps(
            {
                "runId": run_id,
                "status": overall,
                "issueCount": len(issues),
                "queueLength": queue_len,
                "queueByDirection": queue_by_direction,
                "activeTrainingCount": len(active_training),
                "alertIssued": bool(should_alert),
                "resolveIssued": bool(should_resolve),
                "dryRun": bool(args.dry_run),
                "outDir": str(out_dir),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
