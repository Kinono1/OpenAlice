#!/usr/bin/env python3
"""Research-to-experiment loop for continuous strategy optimization.

Flow:
1) Optionally refresh research cards by running strategy_research_watch.py.
2) Rank latest experiment cards (score + tag priority), with optional quota.
3) Optionally execute CVaR matrix smoke runs for top cards.
4) Persist loop report + execution state for de-duplication.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

TAG_PRIORITY_BASE: Dict[str, float] = {
    "risk_control": 1.40,
    "cost_execution": 1.30,
    "regime_detection": 1.20,
    "uncertainty_calibration": 1.10,
    "online_learning": 0.95,
    "feature_engineering": 0.90,
    "rl_policy": 0.80,
    "macro_news": 0.70,
    "general_alpha": 0.60,
}

DIRECTION_PRIORITY_DELTAS: Dict[str, Dict[str, float]] = {
    "balanced": {},
    "risk": {
        "risk_control": 0.85,
        "uncertainty_calibration": 0.35,
        "cost_execution": 0.20,
        "regime_detection": 0.10,
        "general_alpha": -0.15,
    },
    "execution": {
        "cost_execution": 0.95,
        "risk_control": 0.20,
        "regime_detection": 0.20,
        "macro_news": -0.10,
        "general_alpha": -0.15,
    },
    "regime": {
        "regime_detection": 0.95,
        "feature_engineering": 0.45,
        "online_learning": 0.30,
        "macro_news": 0.15,
        "cost_execution": -0.05,
    },
    "alpha": {
        "feature_engineering": 0.85,
        "online_learning": 0.60,
        "rl_policy": 0.45,
        "macro_news": 0.35,
        "regime_detection": 0.20,
        "risk_control": -0.10,
    },
    "diversified": {},
}
OPTIMIZE_DIRECTION_CHOICES = sorted(DIRECTION_PRIORITY_DELTAS.keys())

PROFILE_BY_TAG: Dict[str, str] = {
    "risk_control": "gates_v2",
    "cost_execution": "gates_v2",
    "regime_detection": "baseline_v1",
    "uncertainty_calibration": "baseline_v1",
    "online_learning": "baseline_v1",
    "feature_engineering": "baseline_v1",
    "rl_policy": "baseline_v1",
    "macro_news": "baseline_v1",
    "general_alpha": "baseline_v1",
}

PROFILE_CHOICES = sorted(set(PROFILE_BY_TAG.values()) | {"baseline_v1", "gates_v2"})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Continuously optimize strategy candidates by mapping latest research "
            "cards into cvar-next matrix runs."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--cards-json",
        default="data/research/strategy-watch/latest_experiment_cards.json",
        help="Path to latest_experiment_cards.json.",
    )
    parser.add_argument(
        "--digest-json",
        default="data/research/strategy-watch/latest_digest.json",
        help="Path to latest_digest.json (for paper scores).",
    )
    parser.add_argument(
        "--state-file",
        default="data/research/strategy-watch/execute_state.json",
        help="State file used to avoid repeatedly running same card.",
    )
    parser.add_argument(
        "--report-dir",
        default="data/research/strategy-watch/execution",
        help="Directory for latest/archive loop reports.",
    )
    parser.add_argument(
        "--queue-file",
        default="data/research/strategy-watch/execution/pending_queue.json",
        help="Queue file for blocked execute plans.",
    )
    parser.add_argument(
        "--python-bin",
        default="./.venv/bin/python",
        help="Python executable used to invoke watcher and matrix script.",
    )
    parser.add_argument(
        "--matrix-script",
        default="scripts/run_cvar_next_matrix.py",
        help="Path to run_cvar_next_matrix.py.",
    )
    parser.add_argument(
        "--watch-script",
        default="scripts/strategy_research_watch.py",
        help="Path to strategy_research_watch.py.",
    )
    parser.add_argument(
        "--run-watch",
        action="store_true",
        help="Refresh watcher outputs before selecting cards.",
    )
    parser.add_argument(
        "--watch-args",
        default="",
        help="Extra args passed to watcher when --run-watch is enabled.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=2,
        help="Max number of cards to execute per loop.",
    )
    parser.add_argument(
        "--max-per-tag",
        type=int,
        default=1,
        help="Quota per tag in top-k selection (0 disables quota).",
    )
    parser.add_argument(
        "--max-per-query",
        type=int,
        default=1,
        help="Quota per source_query in top-k selection (0 disables quota).",
    )
    parser.add_argument(
        "--max-runs-per-card",
        type=int,
        default=4,
        help="Passed to --max-runs of run_cvar_next_matrix.py.",
    )
    parser.add_argument(
        "--queue-max-items",
        type=int,
        default=24,
        help="Maximum queue entries to keep after merge/prune (0 disables cap).",
    )
    parser.add_argument(
        "--queue-max-age-days",
        type=int,
        default=30,
        help="Drop queue entries older than this many days (0 disables age prune).",
    )
    parser.add_argument(
        "--queue-legacy-max-items",
        type=int,
        default=8,
        help=(
            "Maximum legacy queue entries (missing optimize_direction) kept after "
            "merge/prune (0 disables legacy cap)."
        ),
    )
    parser.add_argument(
        "--optimize-direction",
        default="balanced",
        choices=OPTIMIZE_DIRECTION_CHOICES,
        help=(
            "Selection direction that changes tag priorities. "
            "Use risk/execution/regime/alpha/diversified for directional optimization."
        ),
    )
    parser.add_argument(
        "--experiment-prefix",
        default="cvar24-strategy",
        help="Prefix used to build experiment IDs.",
    )
    parser.add_argument(
        "--profile-default",
        default="baseline_v1",
        choices=PROFILE_CHOICES,
        help="Fallback profile when tag->profile mapping is missing.",
    )
    parser.add_argument(
        "--profile-override",
        default="",
        choices=[""] + PROFILE_CHOICES,
        help="Force one profile for all selected cards.",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Run matrix jobs. Without this flag, commands are planned only.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Pass --continue-on-error to matrix runner.",
    )
    parser.add_argument(
        "--force-rerun-failed",
        action="store_true",
        help="Pass --force-rerun-failed to matrix runner.",
    )
    parser.add_argument(
        "--skip-stage2",
        action="store_true",
        help="Pass --skip-stage2 to matrix runner.",
    )
    parser.add_argument(
        "--stale-running-minutes",
        type=int,
        default=120,
        help="Pass-through stale running recovery threshold.",
    )
    parser.add_argument(
        "--stale-running-to",
        choices=["failed", "pending"],
        default="failed",
        help="Pass-through stale running recovery target status.",
    )
    parser.add_argument(
        "--allow-repeat-cards",
        action="store_true",
        help="Allow selecting cards already executed in prior loops.",
    )
    parser.add_argument(
        "--allow-concurrent-train",
        action="store_true",
        help="Skip active-train guard (not recommended).",
    )
    parser.add_argument(
        "--enqueue-when-blocked",
        dest="enqueue_when_blocked",
        action="store_true",
        default=True,
        help="When execute is blocked by active training, enqueue plans for later.",
    )
    parser.add_argument(
        "--no-enqueue-when-blocked",
        dest="enqueue_when_blocked",
        action="store_false",
        help="Disable queueing when blocked by active training.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="No command execution and no state mutation.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def compact_run_id(ts: Optional[dt.datetime] = None) -> str:
    cur = ts or now_utc()
    ms = cur.microsecond // 1000
    return f"{cur.strftime('%Y%m%dT%H%M%S')}{ms:03d}Z"


def compact_batch_stamp(ts: Optional[dt.datetime] = None) -> str:
    cur = ts or now_utc()
    ms = cur.microsecond // 1000
    return f"{cur.strftime('%Y%m%dt%H%M%S').lower()}{ms:03d}"


def parse_iso8601(raw: str) -> Optional[dt.datetime]:
    text = (raw or "").strip()
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


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    if p.is_absolute():
        return p
    return (root / p).resolve()


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def safe_int(raw: Any, default: int = 0) -> int:
    try:
        return int(raw)
    except Exception:
        return int(default)


def normalize_active_experiments(raw: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for card_key_raw, payload in raw.items():
        card_key = str(card_key_raw or "").strip()
        if not card_key:
            continue
        if isinstance(payload, str):
            exp_id = payload.strip()
            if exp_id:
                out[card_key] = {
                    "experiment_id": exp_id,
                    "last_status": "unknown",
                    "updated_at": "",
                }
            continue
        if not isinstance(payload, dict):
            continue
        exp_id = str(payload.get("experiment_id", "")).strip()
        if not exp_id:
            continue
        out[card_key] = {
            "experiment_id": exp_id,
            "last_status": str(payload.get("last_status", "unknown")).strip()
            or "unknown",
            "updated_at": str(payload.get("updated_at", "")).strip(),
            "pending_runs": safe_int(payload.get("pending_runs", 0), 0),
            "waiting_champion_runs": safe_int(
                payload.get("waiting_champion_runs", 0), 0
            ),
            "failed_runs": safe_int(payload.get("failed_runs", 0), 0),
            "optimize_direction": str(payload.get("optimize_direction", "")).strip(),
            "tag": str(payload.get("tag", "")).strip(),
        }
    return out


def has_nonempty_cards_payload(payload: Any) -> bool:
    if not isinstance(payload, dict):
        return False
    cards = payload.get("cards")
    return isinstance(cards, list) and len(cards) > 0


def load_cards_payload_with_fallback(
    cards_path: Path, max_archives: int = 120
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    latest_payload = load_json(cards_path, {"cards": []})
    meta = {
        "cards_source": "latest",
        "cards_fallback_used": False,
        "cards_source_run_id": (
            str(latest_payload.get("run_id", ""))
            if isinstance(latest_payload, dict)
            else ""
        ),
        "cards_source_path": str(cards_path),
    }
    if has_nonempty_cards_payload(latest_payload):
        return latest_payload, meta

    archive_root = cards_path.parent / "archive"
    if not archive_root.exists():
        return (
            latest_payload if isinstance(latest_payload, dict) else {"cards": []},
            meta,
        )

    archive_dirs = sorted(
        [p for p in archive_root.iterdir() if p.is_dir()],
        key=lambda p: p.name,
        reverse=True,
    )
    for archive_dir in archive_dirs[: max(max_archives, 1)]:
        candidate = archive_dir / "experiment_cards.json"
        payload = load_json(candidate, {"cards": []})
        if has_nonempty_cards_payload(payload):
            return payload, {
                "cards_source": "archive",
                "cards_fallback_used": True,
                "cards_source_run_id": str(payload.get("run_id", archive_dir.name)),
                "cards_source_path": str(candidate),
            }
    return latest_payload if isinstance(latest_payload, dict) else {"cards": []}, meta


def save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def load_queue_entries(path: Path) -> List[Dict[str, Any]]:
    payload = load_json(path, [])
    if not isinstance(payload, list):
        return []
    out: List[Dict[str, Any]] = []
    for item in payload:
        if isinstance(item, dict):
            out.append(dict(item))
    return out


def queue_identity(item: Dict[str, Any]) -> str:
    card_key = str(item.get("card_key", "")).strip()
    if card_key:
        return card_key
    exp_id = str(item.get("experiment_id", "")).strip()
    if exp_id:
        return exp_id
    return ""


def merge_queue_entries(
    existing: Sequence[Dict[str, Any]],
    new_items: Sequence[Dict[str, Any]],
    *,
    prefer_direction: str,
    max_items: int,
    max_age_days: int,
    legacy_max_items: int,
) -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}

    def put(item: Dict[str, Any]) -> None:
        key = queue_identity(item)
        if not key:
            return
        by_key[key] = dict(item)

    for item in existing:
        put(item)
    for item in new_items:
        put(item)

    rows = list(by_key.values())
    now = now_utc()
    cutoff = (
        now - dt.timedelta(days=max(int(max_age_days), 0))
        if int(max_age_days) > 0
        else None
    )
    if cutoff is not None:
        kept: List[Dict[str, Any]] = []
        for row in rows:
            queued_raw = str(row.get("queued_at", "")).strip()
            queued_dt = parse_iso8601(queued_raw)
            if queued_dt is None or queued_dt >= cutoff:
                kept.append(row)
        rows = kept

    pref = str(prefer_direction or "").strip().lower()

    def sort_key(row: Dict[str, Any]) -> Tuple[int, int, float]:
        row_dir = str(row.get("optimize_direction", "")).strip().lower()
        dir_rank = 0 if pref and row_dir == pref else 1
        legacy_rank = 1 if not row_dir else 0
        queued_dt = parse_iso8601(str(row.get("queued_at", "")).strip())
        ts = queued_dt.timestamp() if queued_dt is not None else 0.0
        return (dir_rank, legacy_rank, -ts)

    rows.sort(key=sort_key)
    if int(legacy_max_items) > 0:
        legacy_seen = 0
        kept_rows: List[Dict[str, Any]] = []
        for row in rows:
            row_dir = str(row.get("optimize_direction", "")).strip().lower()
            if not row_dir:
                if legacy_seen >= int(legacy_max_items):
                    continue
                legacy_seen += 1
            kept_rows.append(row)
        rows = kept_rows
    if int(max_items) > 0:
        rows = rows[: int(max_items)]
    return rows


def queue_direction_counts(
    rows: Sequence[Dict[str, Any]],
) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for row in rows:
        raw = str(row.get("optimize_direction", "")).strip().lower()
        if not raw:
            key = "legacy"
        elif raw in OPTIMIZE_DIRECTION_CHOICES:
            key = raw
        else:
            key = f"other:{raw}"
        counts[key] = counts.get(key, 0) + 1

    ordered: Dict[str, int] = {}
    for key in OPTIMIZE_DIRECTION_CHOICES:
        val = counts.get(key, 0)
        if val > 0:
            ordered[key] = val
    if counts.get("legacy", 0) > 0:
        ordered["legacy"] = counts["legacy"]
    for key in sorted(k for k in counts.keys() if k.startswith("other:")):
        ordered[key] = counts[key]
    return ordered


def manifest_status_counts(manifest_path: Path) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    if not manifest_path.exists():
        return counts
    try:
        with manifest_path.open("r", encoding="utf-8") as fh:
            reader = csv.DictReader(fh)
            for row in reader:
                status = str((row or {}).get("status", "")).strip().lower()
                if not status:
                    continue
                counts[status] = counts.get(status, 0) + 1
    except Exception:
        return {}
    return counts


def find_latest_incomplete_experiment(
    repo_root: Path,
    experiment_prefix: str,
    tag: str,
    max_scan: int = 120,
) -> str:
    exp_root = repo_root / "data/training-data/cvar-next"
    if not exp_root.exists():
        return ""
    prefix_slug = f"{safe_slug(experiment_prefix, max_len=24)}-"
    tag_slug = safe_slug(tag, max_len=18)
    suffix = f"-{tag_slug}"
    dirs = [
        p
        for p in exp_root.iterdir()
        if p.is_dir() and p.name.startswith(prefix_slug) and p.name.endswith(suffix)
    ]
    if not dirs:
        return ""
    dirs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    for exp_dir in dirs[: max(max_scan, 1)]:
        manifest_path = exp_dir / "runs_manifest.csv"
        counts = manifest_status_counts(manifest_path)
        if not counts:
            continue
        pending = (
            safe_int(counts.get("pending", 0), 0)
            + safe_int(counts.get("running", 0), 0)
            + safe_int(counts.get("waiting_champion", 0), 0)
            + safe_int(counts.get("failed", 0), 0)
        )
        if pending > 0:
            return exp_dir.name
    return ""


def shell_join(parts: Sequence[str]) -> str:
    return " ".join(shlex.quote(x) for x in parts)


def parse_last_json_line(text: str) -> Optional[Dict[str, Any]]:
    for line in reversed((text or "").splitlines()):
        raw = line.strip()
        if not raw.startswith("{") or not raw.endswith("}"):
            continue
        try:
            data = json.loads(raw)
            if isinstance(data, dict):
                return data
        except Exception:
            continue
    return None


def safe_slug(raw: str, max_len: int = 32) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", raw.lower()).strip("-")
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
        if "strategy_optimize_loop.py" in cmd:
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


def read_score_map(digest_payload: Dict[str, Any]) -> Dict[str, float]:
    score_map: Dict[str, float] = {}
    for item in digest_payload.get("top_new", []) or []:
        if not isinstance(item, dict):
            continue
        pid = str(item.get("paper_id", "")).strip()
        if not pid:
            continue
        try:
            score_map[pid] = float(item.get("score", 0.0))
        except Exception:
            score_map[pid] = 0.0
    return score_map


def get_tag_priority(tag: str, optimize_direction: str) -> float:
    base = float(TAG_PRIORITY_BASE.get(tag, 0.0))
    deltas = DIRECTION_PRIORITY_DELTAS.get(optimize_direction, {})
    return base + float(deltas.get(tag, 0.0))


def build_candidates(
    cards_payload: Dict[str, Any],
    score_map: Dict[str, float],
    seen_keys: Sequence[str],
    allow_repeat_cards: bool,
    optimize_direction: str,
    active_card_keys: Sequence[str],
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    seen = set(str(x) for x in seen_keys if x)
    active_pending = set(str(x) for x in active_card_keys if x)
    candidates: List[Dict[str, Any]] = []
    skipped: List[Dict[str, Any]] = []
    for raw in cards_payload.get("cards", []) or []:
        if not isinstance(raw, dict):
            continue
        card_id = str(raw.get("card_id", "")).strip()
        paper_id = str(raw.get("source_paper_id", "")).strip()
        tag = str(raw.get("tag", "general_alpha")).strip() or "general_alpha"
        card_key = f"{paper_id}:{tag}" if paper_id else f"{card_id}:{tag}"
        raw_score = raw.get("source_score", 0.0)
        try:
            fallback_score = float(raw_score)
        except Exception:
            fallback_score = 0.0
        paper_score = float(score_map.get(paper_id, fallback_score))
        updated_at = str(raw.get("source_updated_at", "")).strip()
        updated_dt = parse_iso8601(updated_at)
        recency_bonus = 0.0
        if updated_dt is not None:
            days_old = max((now_utc() - updated_dt).total_seconds() / 86400.0, 0.0)
            # Small recency prior: decays to 0 by day 60.
            recency_bonus = max(0.0, 1.0 - (days_old / 60.0)) * 0.6
        tag_priority = get_tag_priority(
            tag=tag,
            optimize_direction=optimize_direction,
        )
        direction_bonus = 0.0
        pending_bonus = 0.75 if card_key in active_pending else 0.0
        rank_score = float(
            paper_score + tag_priority + recency_bonus + direction_bonus + pending_bonus
        )
        row = {
            "card_id": card_id,
            "card_key": card_key,
            "tag": tag,
            "source_paper_id": paper_id,
            "source_title": str(raw.get("source_title", "")).strip(),
            "source_updated_at": updated_at,
            "source_query": str(raw.get("source_query", "")).strip(),
            "source_categories": list(raw.get("source_categories", []) or []),
            "paper_score": paper_score,
            "tag_priority": tag_priority,
            "recency_bonus": recency_bonus,
            "direction_bonus": direction_bonus,
            "active_pending_bonus": pending_bonus,
            "active_pending": card_key in active_pending,
            "rank_score": rank_score,
            "suggested_commands": raw.get("suggested_commands", {}),
        }
        if (
            card_key in seen
            and not allow_repeat_cards
            and card_key not in active_pending
        ):
            skipped.append({**row, "skip_reason": "already_executed"})
            continue
        candidates.append(row)

    if optimize_direction == "diversified" and candidates:
        tag_freq: Dict[str, int] = {}
        for row in candidates:
            tag = str(row.get("tag", ""))
            tag_freq[tag] = tag_freq.get(tag, 0) + 1
        max_freq = max(tag_freq.values()) if tag_freq else 1
        for row in candidates:
            tag = str(row.get("tag", ""))
            freq = max(tag_freq.get(tag, 1), 1)
            rarity = max(1.0 - (freq / max_freq), 0.0)
            bonus = round(rarity * 0.45, 4)
            row["direction_bonus"] = bonus
            row["rank_score"] = float(row.get("rank_score", 0.0)) + bonus

    candidates.sort(
        key=lambda r: (
            float(r.get("rank_score", 0.0)),
            float(r.get("paper_score", 0.0)),
            str(r.get("source_updated_at", "")),
            str(r.get("card_id", "")),
        ),
        reverse=True,
    )
    return candidates, skipped


def select_top_cards(
    candidates: Sequence[Dict[str, Any]],
    top_k: int,
    max_per_tag: int,
    max_per_query: int,
) -> List[Dict[str, Any]]:
    if top_k <= 0:
        return []
    selected: List[Dict[str, Any]] = []
    tag_count: Dict[str, int] = {}
    query_count: Dict[str, int] = {}

    for row in candidates:
        if len(selected) >= top_k:
            break
        tag = str(row.get("tag", ""))
        query = str(row.get("source_query", ""))
        if max_per_tag > 0 and tag_count.get(tag, 0) >= max_per_tag:
            continue
        if query and max_per_query > 0 and query_count.get(query, 0) >= max_per_query:
            continue
        selected.append(dict(row))
        tag_count[tag] = tag_count.get(tag, 0) + 1
        if query:
            query_count[query] = query_count.get(query, 0) + 1

    if len(selected) < top_k:
        selected_keys = {str(r.get("card_key", "")) for r in selected}
        for row in candidates:
            if len(selected) >= top_k:
                break
            card_key = str(row.get("card_key", ""))
            if card_key in selected_keys:
                continue
            tag = str(row.get("tag", ""))
            query = str(row.get("source_query", ""))
            if max_per_tag > 0 and tag_count.get(tag, 0) >= max_per_tag:
                continue
            if (
                query
                and max_per_query > 0
                and query_count.get(query, 0) >= max_per_query
            ):
                continue
            selected.append(dict(row))
            selected_keys.add(card_key)
            tag_count[tag] = tag_count.get(tag, 0) + 1
            if query:
                query_count[query] = query_count.get(query, 0) + 1
    return selected


def render_report_markdown(report: Dict[str, Any]) -> str:
    lines = [
        "# Strategy Optimize Loop",
        "",
        f"- generatedAt: `{report.get('generated_at', '')}`",
        f"- runId: `{report.get('run_id', '')}`",
        f"- cardsSource: `{report.get('cards_source', '')}`",
        f"- cardsSourceRunId: `{report.get('cards_source_run_id', '')}`",
        f"- cardsFallbackUsed: `{report.get('cards_fallback_used', False)}`",
        f"- execute: `{report.get('execute', False)}`",
        f"- dryRun: `{report.get('dry_run', False)}`",
        f"- queueFile: `{report.get('queue_file', '')}`",
        f"- queuedCount: `{report.get('queued_count', 0)}`",
        f"- queueBefore: `{report.get('queue_before', 0)}`",
        f"- queueAfter: `{report.get('queue_after', 0)}`",
        f"- queueDropped: `{report.get('queue_dropped', 0)}`",
        f"- queueMaxItems: `{report.get('queue_max_items', 0)}`",
        f"- queueMaxAgeDays: `{report.get('queue_max_age_days', 0)}`",
        f"- queueLegacyMaxItems: `{report.get('queue_legacy_max_items', 0)}`",
        f"- queueLegacyBefore: `{report.get('queue_legacy_before', 0)}`",
        f"- queueLegacyAfter: `{report.get('queue_legacy_after', 0)}`",
        f"- queueLegacyDropped: `{report.get('queue_legacy_dropped', 0)}`",
        f"- queueBeforeByDirection: `{json.dumps(report.get('queue_before_by_direction', {}), ensure_ascii=False)}`",
        f"- queueAfterByDirection: `{json.dumps(report.get('queue_after_by_direction', {}), ensure_ascii=False)}`",
        f"- queuedByDirection: `{json.dumps(report.get('queued_by_direction', {}), ensure_ascii=False)}`",
        f"- optimizeDirection: `{report.get('optimize_direction', 'balanced')}`",
        f"- selectedCards: `{report.get('selected_count', 0)}`",
        f"- maxPerTag: `{report.get('max_per_tag', 0)}`",
        f"- maxPerQuery: `{report.get('max_per_query', 0)}`",
        f"- commandRuns: `{report.get('command_runs', 0)}`",
        f"- trainRuns: `{report.get('train_runs', 0)}`",
        f"- blockedByActiveTraining: `{report.get('blocked_by_active_training', False)}`",
        "",
        "## Selected Cards",
        "",
        "| rank | card_id | tag | paper_score | tag_priority | recency_bonus | direction_bonus | rank_score | profile | experiment_id |",
        "|---:|---|---|---:|---:|---:|---:|---:|---|---|",
    ]

    for idx, row in enumerate(report.get("selected", []) or [], start=1):
        lines.append(
            "| "
            f"{idx} | "
            f"{row.get('card_id', '')} | "
            f"{row.get('tag', '')} | "
            f"{float(row.get('paper_score', 0.0)):.4f} | "
            f"{float(row.get('tag_priority', 0.0)):.4f} | "
            f"{float(row.get('recency_bonus', 0.0)):.4f} | "
            f"{float(row.get('direction_bonus', 0.0)):.4f} | "
            f"{float(row.get('rank_score', 0.0)):.4f} | "
            f"{row.get('profile', '')} | "
            f"{row.get('experiment_id', '')} |"
        )

    lines.extend(["", "## Run Results", ""])
    for row in report.get("results", []) or []:
        lines.extend(
            [
                f"### {row.get('card_id', '')} -> {row.get('experiment_id', '')}",
                "",
                f"- profile: `{row.get('profile', '')}`",
                f"- returnCode: `{row.get('return_code', '')}`",
                f"- status: `{row.get('status', '')}`",
                f"- command: `{row.get('command', '')}`",
                "",
            ]
        )
        summary = row.get("matrix_summary")
        if isinstance(summary, dict) and summary:
            lines.append("- matrixSummary:")
            for k in sorted(summary.keys()):
                lines.append(f"  - `{k}`: `{summary.get(k)}`")
            lines.append("")

    if report.get("skipped"):
        lines.extend(["## Skipped", ""])
        for item in report.get("skipped", []):
            lines.append(
                "- "
                f"{item.get('card_id', '')} ({item.get('tag', '')}) - "
                f"{item.get('skip_reason', '')}"
            )
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def choose_profile(
    tag: str,
    profile_default: str,
    profile_override: str,
) -> str:
    if profile_override:
        return profile_override
    return PROFILE_BY_TAG.get(tag, profile_default)


def run_command(cmd: Sequence[str], cwd: Path) -> Dict[str, Any]:
    started = now_utc()
    proc = subprocess.run(
        list(cmd),
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )
    finished = now_utc()
    matrix_summary = parse_last_json_line(proc.stdout)
    return {
        "return_code": int(proc.returncode),
        "started_at": iso(started),
        "finished_at": iso(finished),
        "stdout_tail": "\n".join(proc.stdout.splitlines()[-40:]),
        "stderr_tail": "\n".join(proc.stderr.splitlines()[-40:]),
        "matrix_summary": matrix_summary,
    }


def main() -> int:
    args = parse_args()
    repo_root = Path(__file__).resolve().parents[1]
    if args.repo_root:
        repo_root = resolve_path(repo_root, args.repo_root)

    cards_path = resolve_path(repo_root, args.cards_json)
    digest_path = resolve_path(repo_root, args.digest_json)
    state_path = resolve_path(repo_root, args.state_file)
    report_dir = resolve_path(repo_root, args.report_dir)
    queue_path = resolve_path(repo_root, args.queue_file)
    matrix_script = resolve_path(repo_root, args.matrix_script)
    watch_script = resolve_path(repo_root, args.watch_script)
    python_bin = resolve_path(repo_root, args.python_bin)

    run_id = compact_run_id()
    state_payload = load_json(state_path, {"seen_card_keys": [], "history": []})
    if not isinstance(state_payload, dict):
        state_payload = {"seen_card_keys": [], "history": []}
    seen_card_keys = state_payload.get("seen_card_keys", [])
    if not isinstance(seen_card_keys, list):
        seen_card_keys = []
    active_experiments = normalize_active_experiments(
        state_payload.get("active_experiments", {})
    )
    active_card_keys = list(active_experiments.keys())

    watch_info: Dict[str, Any] = {}
    if args.run_watch:
        if not watch_script.exists():
            raise FileNotFoundError(f"watch script not found: {watch_script}")
        watch_cmd = [str(python_bin), str(watch_script)]
        if args.watch_args.strip():
            watch_cmd.extend(shlex.split(args.watch_args))
        if args.dry_run and "--dry-run" not in watch_cmd:
            watch_cmd.append("--dry-run")
        watch_result = run_command(watch_cmd, cwd=repo_root)
        watch_info = {
            "command": shell_join(watch_cmd),
            "return_code": watch_result["return_code"],
            "summary": watch_result.get("matrix_summary"),
        }
        if watch_result["return_code"] != 0:
            report_payload = {
                "generated_at": iso(now_utc()),
                "run_id": run_id,
                "execute": bool(args.execute),
                "dry_run": bool(args.dry_run),
                "optimize_direction": str(args.optimize_direction),
                "selected_count": 0,
                "command_runs": 0,
                "train_runs": 0,
                "blocked_by_active_training": False,
                "watch": watch_info,
                "selected": [],
                "results": [],
                "skipped": [{"skip_reason": "watch_failed"}],
            }
            if not args.dry_run:
                archive_dir = report_dir / "archive" / run_id
                save_json(report_dir / "latest_loop_report.json", report_payload)
                save_json(archive_dir / "loop_report.json", report_payload)
                (report_dir / "latest_loop_report.md").write_text(
                    render_report_markdown(report_payload),
                    encoding="utf-8",
                )
                (archive_dir / "loop_report.md").write_text(
                    render_report_markdown(report_payload),
                    encoding="utf-8",
                )
            print(
                json.dumps(
                    {
                        "runId": run_id,
                        "status": "watch_failed",
                        "watch": watch_info,
                    },
                    ensure_ascii=False,
                )
            )
            return 1

    cards_payload, cards_meta = load_cards_payload_with_fallback(cards_path)
    digest_payload = load_json(digest_path, {"top_new": []})
    score_map = read_score_map(
        digest_payload if isinstance(digest_payload, dict) else {}
    )
    candidates, skipped = build_candidates(
        cards_payload=cards_payload
        if isinstance(cards_payload, dict)
        else {"cards": []},
        score_map=score_map,
        seen_keys=seen_card_keys,
        allow_repeat_cards=bool(args.allow_repeat_cards),
        optimize_direction=str(args.optimize_direction),
        active_card_keys=active_card_keys,
    )
    selected = select_top_cards(
        candidates=candidates,
        top_k=max(int(args.top_k), 0),
        max_per_tag=int(args.max_per_tag),
        max_per_query=int(args.max_per_query),
    )

    active_cmdlines = active_train_cmds(experiment_prefix=str(args.experiment_prefix))
    blocked = bool(args.execute and active_cmdlines and not args.allow_concurrent_train)

    results: List[Dict[str, Any]] = []
    selected_with_plan: List[Dict[str, Any]] = []
    newly_seen: List[str] = []
    queued_items: List[Dict[str, Any]] = []
    batch_stamp = compact_batch_stamp()

    for idx, row in enumerate(selected, start=1):
        tag = str(row.get("tag", "general_alpha"))
        card_key = str(row.get("card_key", "")).strip()
        profile = choose_profile(
            tag=tag,
            profile_default=args.profile_default,
            profile_override=args.profile_override,
        )
        active_entry = active_experiments.get(card_key, {}) if card_key else {}
        active_exp_id = ""
        if isinstance(active_entry, dict):
            active_exp_id = str(active_entry.get("experiment_id", "")).strip()
        recovered_exp_id = ""
        if not active_exp_id:
            recovered_exp_id = find_latest_incomplete_experiment(
                repo_root=repo_root,
                experiment_prefix=str(args.experiment_prefix),
                tag=tag,
            )
        exp_reused = bool(active_exp_id or recovered_exp_id)
        exp_id = (
            active_exp_id
            or recovered_exp_id
            or (
                f"{safe_slug(args.experiment_prefix, max_len=24)}-"
                f"{batch_stamp}-{idx:02d}-{safe_slug(tag, max_len=18)}"
            )
        )
        matrix_cmd = [
            str(python_bin),
            str(matrix_script),
            "--experiment-id",
            exp_id,
            "--profile",
            profile,
            "--max-runs",
            str(max(int(args.max_runs_per_card), 0)),
            "--stale-running-minutes",
            str(int(args.stale_running_minutes)),
            "--stale-running-to",
            str(args.stale_running_to),
        ]
        if args.execute:
            matrix_cmd.append("--execute")
        if args.continue_on_error:
            matrix_cmd.append("--continue-on-error")
        if args.force_rerun_failed:
            matrix_cmd.append("--force-rerun-failed")
        if args.skip_stage2:
            matrix_cmd.append("--skip-stage2")

        planned = dict(row)
        planned["profile"] = profile
        planned["experiment_id"] = exp_id
        planned["experiment_reused"] = exp_reused
        planned["experiment_recovered"] = bool(recovered_exp_id and not active_exp_id)
        planned["command"] = shell_join(matrix_cmd)
        selected_with_plan.append(planned)

        if args.dry_run:
            results.append(
                {
                    "card_id": row.get("card_id", ""),
                    "card_key": row.get("card_key", ""),
                    "tag": tag,
                    "profile": profile,
                    "experiment_id": exp_id,
                    "experiment_reused": exp_reused,
                    "experiment_recovered": bool(
                        recovered_exp_id and not active_exp_id
                    ),
                    "command": planned["command"],
                    "status": "dry_run",
                    "return_code": "",
                    "matrix_summary": None,
                }
            )
            continue

        if blocked:
            queue_status = "blocked_active_training"
            if args.execute and args.enqueue_when_blocked:
                queued_items.append(
                    {
                        "queued_at": iso(now_utc()),
                        "run_id": run_id,
                        "optimize_direction": str(args.optimize_direction),
                        "card_key": row.get("card_key", ""),
                        "card_id": row.get("card_id", ""),
                        "tag": tag,
                        "source_paper_id": row.get("source_paper_id", ""),
                        "source_title": row.get("source_title", ""),
                        "profile": profile,
                        "experiment_id": exp_id,
                        "command": planned["command"],
                    }
                )
                queue_status = "blocked_queued"
            results.append(
                {
                    "card_id": row.get("card_id", ""),
                    "card_key": row.get("card_key", ""),
                    "tag": tag,
                    "profile": profile,
                    "experiment_id": exp_id,
                    "experiment_reused": exp_reused,
                    "experiment_recovered": bool(
                        recovered_exp_id and not active_exp_id
                    ),
                    "command": planned["command"],
                    "status": queue_status,
                    "return_code": "",
                    "matrix_summary": None,
                }
            )
            continue

        cmd_result = run_command(matrix_cmd, cwd=repo_root)
        status = "ok" if cmd_result["return_code"] == 0 else "failed"
        result_row = {
            "card_id": row.get("card_id", ""),
            "card_key": row.get("card_key", ""),
            "tag": tag,
            "profile": profile,
            "experiment_id": exp_id,
            "experiment_reused": exp_reused,
            "experiment_recovered": bool(recovered_exp_id and not active_exp_id),
            "command": planned["command"],
            "status": status,
            "return_code": cmd_result["return_code"],
            "started_at": cmd_result["started_at"],
            "finished_at": cmd_result["finished_at"],
            "matrix_summary": cmd_result.get("matrix_summary"),
        }
        if cmd_result["stderr_tail"]:
            result_row["stderr_tail"] = cmd_result["stderr_tail"]
        results.append(result_row)
        if cmd_result["return_code"] == 0 and args.execute:
            newly_seen.append(str(row.get("card_key", "")))
            matrix_summary = cmd_result.get("matrix_summary")
            pending_runs = 0
            waiting_runs = 0
            failed_runs = 0
            if isinstance(matrix_summary, dict):
                pending_runs = safe_int(matrix_summary.get("pendingRuns", 0), 0)
                waiting_runs = safe_int(matrix_summary.get("waitingChampionRuns", 0), 0)
                failed_runs = safe_int(matrix_summary.get("failedRuns", 0), 0)
            if card_key:
                if (pending_runs + waiting_runs) > 0:
                    active_experiments[card_key] = {
                        "experiment_id": exp_id,
                        "last_status": "running",
                        "updated_at": iso(now_utc()),
                        "pending_runs": pending_runs,
                        "waiting_champion_runs": waiting_runs,
                        "failed_runs": failed_runs,
                        "optimize_direction": str(args.optimize_direction),
                        "tag": tag,
                    }
                else:
                    active_experiments.pop(card_key, None)
        elif cmd_result["return_code"] != 0 and args.execute and card_key:
            active_experiments[card_key] = {
                "experiment_id": exp_id,
                "last_status": "failed",
                "updated_at": iso(now_utc()),
                "pending_runs": safe_int(active_entry.get("pending_runs", 0), 0)
                if isinstance(active_entry, dict)
                else 0,
                "waiting_champion_runs": safe_int(
                    active_entry.get("waiting_champion_runs", 0), 0
                )
                if isinstance(active_entry, dict)
                else 0,
                "failed_runs": safe_int(active_entry.get("failed_runs", 0), 0)
                if isinstance(active_entry, dict)
                else 0,
                "optimize_direction": str(args.optimize_direction),
                "tag": tag,
            }

    command_runs = sum(1 for x in results if x.get("status") in {"ok", "failed"})
    train_runs = command_runs if args.execute else 0
    queued_count = len(queued_items)
    existing_queue = load_queue_entries(queue_path)
    queue_before = len(existing_queue)
    queue_before_by_direction = queue_direction_counts(existing_queue)
    queued_by_direction = queue_direction_counts(queued_items)
    queue_after = queue_before
    queue_after_by_direction = dict(queue_before_by_direction)
    queue_legacy_before = int(queue_before_by_direction.get("legacy", 0))
    queue_legacy_after = queue_legacy_before
    queue_legacy_dropped = 0
    queue_dropped = 0
    report_payload = {
        "generated_at": iso(now_utc()),
        "run_id": run_id,
        "execute": bool(args.execute),
        "dry_run": bool(args.dry_run),
        "optimize_direction": str(args.optimize_direction),
        "cards_source": cards_meta.get("cards_source", ""),
        "cards_fallback_used": cards_meta.get("cards_fallback_used", False),
        "cards_source_run_id": cards_meta.get("cards_source_run_id", ""),
        "cards_source_path": cards_meta.get("cards_source_path", ""),
        "queue_file": str(queue_path),
        "queued_count": queued_count,
        "queue_before": queue_before,
        "queue_after": queue_after,
        "queue_dropped": queue_dropped,
        "queue_max_items": int(args.queue_max_items),
        "queue_max_age_days": int(args.queue_max_age_days),
        "queue_legacy_max_items": int(args.queue_legacy_max_items),
        "queue_legacy_before": queue_legacy_before,
        "queue_legacy_after": queue_legacy_after,
        "queue_legacy_dropped": queue_legacy_dropped,
        "queue_before_by_direction": queue_before_by_direction,
        "queue_after_by_direction": queue_after_by_direction,
        "queued_by_direction": queued_by_direction,
        "top_k": int(args.top_k),
        "max_per_tag": int(args.max_per_tag),
        "max_per_query": int(args.max_per_query),
        "max_runs_per_card": int(args.max_runs_per_card),
        "blocked_by_active_training": blocked,
        "active_training_cmds": active_cmdlines[:8],
        "active_experiments_tracked": len(active_experiments),
        "watch": watch_info,
        "selected_count": len(selected_with_plan),
        "command_runs": command_runs,
        "train_runs": train_runs,
        "selected": selected_with_plan,
        "results": results,
        "skipped": skipped,
    }

    if not args.dry_run:
        if queued_items or existing_queue:
            merged_queue = merge_queue_entries(
                existing=existing_queue,
                new_items=queued_items,
                prefer_direction=str(args.optimize_direction),
                max_items=int(args.queue_max_items),
                max_age_days=int(args.queue_max_age_days),
                legacy_max_items=int(args.queue_legacy_max_items),
            )
            queue_after = len(merged_queue)
            queue_after_by_direction = queue_direction_counts(merged_queue)
            queue_legacy_after = int(queue_after_by_direction.get("legacy", 0))
            queue_legacy_input = queue_legacy_before + int(
                queued_by_direction.get("legacy", 0)
            )
            queue_legacy_dropped = max(queue_legacy_input - queue_legacy_after, 0)
            queue_dropped = max(queue_before + len(queued_items) - queue_after, 0)
            save_json(queue_path, merged_queue)
            report_payload["queue_after"] = queue_after
            report_payload["queue_after_by_direction"] = queue_after_by_direction
            report_payload["queue_dropped"] = queue_dropped
            report_payload["queue_legacy_after"] = queue_legacy_after
            report_payload["queue_legacy_dropped"] = queue_legacy_dropped
        archive_dir = report_dir / "archive" / run_id
        save_json(report_dir / "latest_loop_report.json", report_payload)
        save_json(archive_dir / "loop_report.json", report_payload)
        (report_dir / "latest_loop_report.md").write_text(
            render_report_markdown(report_payload),
            encoding="utf-8",
        )
        (archive_dir / "loop_report.md").write_text(
            render_report_markdown(report_payload),
            encoding="utf-8",
        )

        merged_seen = list(dict.fromkeys(list(seen_card_keys) + newly_seen))
        merged_seen = [x for x in merged_seen if x][-5000:]
        history = state_payload.get("history", [])
        if not isinstance(history, list):
            history = []
        history.append(
            {
                "run_id": run_id,
                "run_at": iso(now_utc()),
                "execute": bool(args.execute),
                "selected_count": len(selected_with_plan),
                "command_runs": command_runs,
                "train_runs": train_runs,
                "blocked_by_active_training": blocked,
                "optimize_direction": str(args.optimize_direction),
            }
        )
        history = history[-300:]
        state_payload = {
            "last_run_at": iso(now_utc()),
            "seen_card_keys": merged_seen,
            "active_experiments": active_experiments,
            "history": history,
        }
        save_json(state_path, state_payload)

    print(
        json.dumps(
            {
                "runId": run_id,
                "selectedCards": len(selected_with_plan),
                "maxPerTag": int(args.max_per_tag),
                "maxPerQuery": int(args.max_per_query),
                "optimizeDirection": str(args.optimize_direction),
                "commandRuns": command_runs,
                "trainRuns": train_runs,
                "queuedCount": queued_count,
                "blockedByActiveTraining": blocked,
                "reportDir": str(report_dir),
                "dryRun": bool(args.dry_run),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
