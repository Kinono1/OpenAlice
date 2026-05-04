#!/usr/bin/env python3
"""Drain queued strategy optimization commands when training slots are free."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Execute queued strategy optimization commands from "
            "pending_queue.json when training is not busy."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--queue-file",
        default="data/research/strategy-watch/execution/pending_queue.json",
        help="Queue file populated by strategy_optimize_loop.py.",
    )
    parser.add_argument(
        "--experiment-prefix",
        default="cvar24-strategy",
        help=(
            "Only treat active training commands that match this experiment prefix "
            "as blocking. Empty value means block on any training command."
        ),
    )
    parser.add_argument(
        "--report-dir",
        default="data/research/strategy-watch/execution/queue-drain",
        help="Directory for queue drain reports.",
    )
    parser.add_argument(
        "--max-items",
        type=int,
        default=1,
        help="Max queue items to execute per drain run.",
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=3,
        help="Drop a queue item after this many failed attempts.",
    )
    parser.add_argument(
        "--prefer-direction",
        default="",
        help=(
            "Prefer queue items matching this optimize direction "
            "(risk/execution/regime/alpha/diversified)."
        ),
    )
    parser.add_argument(
        "--newest-first",
        dest="newest_first",
        action="store_true",
        default=True,
        help="Prioritize newer queued items first.",
    )
    parser.add_argument(
        "--oldest-first",
        dest="newest_first",
        action="store_false",
        help="Prioritize older queued items first.",
    )
    parser.add_argument(
        "--allow-concurrent-train",
        action="store_true",
        help="Run queued commands even when another training process is active.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue draining subsequent items when one item fails.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not execute commands or mutate queue file.",
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


def load_queue(path: Path) -> List[Dict[str, Any]]:
    payload = load_json(path, [])
    if not isinstance(payload, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in payload:
        if isinstance(item, dict):
            out.append(dict(item))
    return out


def safe_slug(raw: str, max_len: int = 32) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", str(raw or "").lower()).strip("-")
    if not slug:
        slug = "x"
    return slug[:max_len].strip("-") or "x"


def active_train_cmds(experiment_prefix: str = "") -> List[str]:
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
    prefix = (experiment_prefix or "").strip().lower()
    prefix_slug = safe_slug(prefix, max_len=24) if prefix else ""
    for line in proc.stdout.splitlines():
        cmd = line.strip()
        if not cmd:
            continue
        if "drain_strategy_queue.py" in cmd:
            continue
        if (
            "wait_clean_and_retrain.py" not in cmd
            and "run_cvar_next_matrix.py" not in cmd
        ):
            continue
        if prefix_slug:
            cmd_lower = cmd.lower()
            if prefix_slug not in cmd_lower and f"{prefix_slug}-" not in cmd_lower:
                continue
        out.append(cmd)
    return out


def run_command(parts: Sequence[str], cwd: Path) -> Dict[str, Any]:
    started_at = now_utc()
    proc = subprocess.run(
        list(parts),
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    finished_at = now_utc()
    stderr_lines = [x for x in (proc.stderr or "").splitlines() if x.strip()]
    return {
        "return_code": int(proc.returncode),
        "started_at": iso(started_at),
        "finished_at": iso(finished_at),
        "stderr_tail": "\n".join(stderr_lines[-40:]),
    }


def parse_attempts(value: Any) -> int:
    try:
        return max(int(value), 0)
    except Exception:
        return 0


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


def queue_identity(item: Dict[str, Any]) -> str:
    card_key = str(item.get("card_key", "")).strip()
    if card_key:
        return card_key
    exp_id = str(item.get("experiment_id", "")).strip()
    if exp_id:
        return exp_id
    return str(id(item))


def order_queue(
    queue: Sequence[Dict[str, Any]],
    prefer_direction: str,
    newest_first: bool,
) -> List[Dict[str, Any]]:
    direction_pref = str(prefer_direction or "").strip().lower()

    def key(item: Dict[str, Any]) -> Any:
        item_dir = str(item.get("optimize_direction", "")).strip().lower()
        direction_rank = 0 if direction_pref and item_dir == direction_pref else 1
        attempts = parse_attempts(item.get("attempts", 0))
        queued_at = parse_iso8601(item.get("queued_at", ""))
        ts = queued_at.timestamp() if queued_at else 0.0
        time_rank = -ts if newest_first else ts
        return (direction_rank, attempts, time_rank)

    return [dict(x) for x in sorted(queue, key=key)]


def format_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# Strategy Queue Drain",
        "",
        f"- runId: `{report.get('run_id', '')}`",
        f"- generatedAt: `{report.get('generated_at', '')}`",
        f"- blockedByActiveTraining: `{report.get('blocked_by_active_training', False)}`",
        f"- allowConcurrentTrain: `{report.get('allow_concurrent_train', False)}`",
        f"- preferDirection: `{report.get('prefer_direction', '')}`",
        f"- newestFirst: `{report.get('newest_first', True)}`",
        f"- dryRun: `{report.get('dry_run', False)}`",
        f"- queueBefore: `{report.get('queue_before', 0)}`",
        f"- queueAfter: `{report.get('queue_after', 0)}`",
        f"- maxItems: `{report.get('max_items', 0)}`",
        f"- executedCount: `{report.get('executed_count', 0)}`",
        f"- successCount: `{report.get('success_count', 0)}`",
        f"- failedCount: `{report.get('failed_count', 0)}`",
        f"- droppedCount: `{report.get('dropped_count', 0)}`",
        "",
        "## Results",
    ]
    results = report.get("results", [])
    if not isinstance(results, list) or not results:
        lines.append("- no results")
        return "\n".join(lines) + "\n"
    for row in results:
        if not isinstance(row, dict):
            continue
        lines.append(
            "- "
            + " | ".join(
                [
                    f"status=`{row.get('status', '')}`",
                    f"experiment=`{row.get('experiment_id', '')}`",
                    f"tag=`{row.get('tag', '')}`",
                    f"cardKey=`{row.get('card_key', '')}`",
                    f"attempts=`{row.get('attempts', '')}`",
                    f"returnCode=`{row.get('return_code', '')}`",
                ]
            )
        )
    return "\n".join(lines) + "\n"


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).resolve()
        if args.repo_root
        else Path(__file__).resolve().parent.parent
    )
    queue_path = resolve_path(repo_root, args.queue_file)
    report_dir = resolve_path(repo_root, args.report_dir)
    report_dir.mkdir(parents=True, exist_ok=True)

    queue = load_queue(queue_path)
    ordered_queue = order_queue(
        queue=queue,
        prefer_direction=str(args.prefer_direction),
        newest_first=bool(args.newest_first),
    )
    queue_before = len(queue)
    run_id = now_utc().strftime("%Y%m%dT%H%M%SZ")
    blocked_cmds = active_train_cmds(experiment_prefix=str(args.experiment_prefix))
    blocked = bool(blocked_cmds and not args.allow_concurrent_train)

    results: List[Dict[str, Any]] = []
    remaining: List[Dict[str, Any]] = []
    executed_count = 0
    success_count = 0
    failed_count = 0
    dropped_count = 0

    selected_identities: set[str] = set()
    if not blocked and ordered_queue:
        for idx, item in enumerate(ordered_queue):
            if idx < max(int(args.max_items), 0):
                selected_identities.add(queue_identity(item))
                cmd_text = str(item.get("command", "")).strip()
                attempts = parse_attempts(item.get("attempts", 0))
                base_row = {
                    "card_key": str(item.get("card_key", "")),
                    "card_id": str(item.get("card_id", "")),
                    "tag": str(item.get("tag", "")),
                    "experiment_id": str(item.get("experiment_id", "")),
                    "command": cmd_text,
                    "attempts": attempts,
                }
                if not cmd_text:
                    failed_count += 1
                    dropped_count += 1
                    results.append(
                        {
                            **base_row,
                            "status": "invalid_command_drop",
                            "return_code": "",
                            "error": "empty command",
                        }
                    )
                    continue

                if args.dry_run:
                    results.append(
                        {
                            **base_row,
                            "status": "dry_run",
                            "return_code": "",
                        }
                    )
                    remaining.append(dict(item))
                    continue

                try:
                    cmd_parts = shlex.split(cmd_text)
                except Exception as exc:
                    failed_count += 1
                    attempts += 1
                    updated = dict(item)
                    updated["attempts"] = attempts
                    updated["last_attempt_at"] = iso(now_utc())
                    updated["last_error"] = f"shlex_error: {exc}"
                    if attempts >= max(int(args.max_attempts), 1):
                        dropped_count += 1
                        results.append(
                            {
                                **base_row,
                                "status": "parse_error_drop",
                                "attempts": attempts,
                                "return_code": "",
                                "error": str(exc),
                            }
                        )
                    else:
                        remaining.append(updated)
                        results.append(
                            {
                                **base_row,
                                "status": "parse_error_requeue",
                                "attempts": attempts,
                                "return_code": "",
                                "error": str(exc),
                            }
                        )
                    if not args.continue_on_error:
                        remaining.extend(ordered_queue[idx + 1 :])
                        break
                    continue

                cmd_result = run_command(cmd_parts, cwd=repo_root)
                executed_count += 1
                rc = int(cmd_result["return_code"])
                if rc == 0:
                    success_count += 1
                    results.append(
                        {
                            **base_row,
                            "status": "ok",
                            "return_code": rc,
                            "started_at": cmd_result["started_at"],
                            "finished_at": cmd_result["finished_at"],
                        }
                    )
                else:
                    failed_count += 1
                    attempts += 1
                    updated = dict(item)
                    updated["attempts"] = attempts
                    updated["last_attempt_at"] = cmd_result["finished_at"]
                    updated["last_return_code"] = rc
                    if cmd_result["stderr_tail"]:
                        updated["last_stderr_tail"] = cmd_result["stderr_tail"]
                    if attempts >= max(int(args.max_attempts), 1):
                        dropped_count += 1
                        results.append(
                            {
                                **base_row,
                                "status": "failed_drop",
                                "attempts": attempts,
                                "return_code": rc,
                                "started_at": cmd_result["started_at"],
                                "finished_at": cmd_result["finished_at"],
                            }
                        )
                    else:
                        remaining.append(updated)
                        results.append(
                            {
                                **base_row,
                                "status": "failed_requeue",
                                "attempts": attempts,
                                "return_code": rc,
                                "started_at": cmd_result["started_at"],
                                "finished_at": cmd_result["finished_at"],
                            }
                        )
                    if not args.continue_on_error:
                        remaining.extend(ordered_queue[idx + 1 :])
                        break
            else:
                remaining.append(dict(item))
    else:
        remaining = [dict(x) for x in ordered_queue]

    if not blocked and ordered_queue:
        seen_remaining = {queue_identity(x) for x in remaining}
        for item in ordered_queue:
            ident = queue_identity(item)
            if ident in selected_identities:
                continue
            if ident in seen_remaining:
                continue
            remaining.append(dict(item))
            seen_remaining.add(ident)

    queue_after = len(remaining)
    report = {
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "dry_run": bool(args.dry_run),
        "blocked_by_active_training": blocked,
        "allow_concurrent_train": bool(args.allow_concurrent_train),
        "prefer_direction": str(args.prefer_direction or ""),
        "newest_first": bool(args.newest_first),
        "active_training_cmds": blocked_cmds[:8],
        "queue_file": str(queue_path),
        "queue_before": queue_before,
        "queue_after": queue_after,
        "max_items": max(int(args.max_items), 0),
        "max_attempts": max(int(args.max_attempts), 1),
        "executed_count": executed_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "dropped_count": dropped_count,
        "results": results,
    }

    if not args.dry_run:
        save_json(queue_path, remaining)
        archive_dir = report_dir / "archive" / run_id
        save_json(report_dir / "latest_queue_drain_report.json", report)
        save_json(archive_dir / "queue_drain_report.json", report)
        (report_dir / "latest_queue_drain_report.md").write_text(
            format_markdown(report),
            encoding="utf-8",
        )
        (archive_dir / "queue_drain_report.md").write_text(
            format_markdown(report),
            encoding="utf-8",
        )

    print(
        json.dumps(
            {
                "runId": run_id,
                "blockedByActiveTraining": blocked,
                "queueBefore": queue_before,
                "queueAfter": queue_after,
                "executedCount": executed_count,
                "successCount": success_count,
                "failedCount": failed_count,
                "droppedCount": dropped_count,
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
