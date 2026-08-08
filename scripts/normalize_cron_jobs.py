#!/usr/bin/env python3
"""Normalize legacy Cron state without moving active data.

The legacy jobs file contains absolute paths into the old source worktree. This
tool converts only executable/notification paths to release-relative forms,
preserves schedule and runtime state, and atomically replaces the file after a
0600 backup. It never starts Cron and never rewrites a file when any path cannot
be mapped to the verified release root.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--jobs", required=True)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--release-root", required=True)
    parser.add_argument("--registry", required=True)
    parser.add_argument("--backup", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--dry-run", action="store_true")
    return parser.parse_args()


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_relative(path: Path, root: Path) -> str | None:
    try:
        relative = path.resolve().relative_to(root.resolve())
    except ValueError:
        return None
    if not relative.parts:
        return "."
    return PurePosixPath(*relative.parts).as_posix()


def map_source_path(
    raw: Any,
    source_root: Path,
    release_root: Path,
    *,
    label: str,
    allow_missing: bool = False,
) -> tuple[str, str]:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"cron_path_missing:{label}")
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        source_path = (source_root / candidate).resolve()
    else:
        source_path = candidate.resolve()
    relative = safe_relative(source_path, source_root)
    if relative is None:
        raise ValueError(f"cron_path_outside_source_root:{label}:{raw}")
    release_path = (release_root / relative).resolve()
    if safe_relative(release_path, release_root) is None:
        raise ValueError(f"cron_path_release_escape:{label}:{relative}")
    if not allow_missing and not release_path.exists():
        raise ValueError(f"cron_entrypoint_not_in_release:{label}:{relative}")
    return relative, str(release_path)


def normalize_notification_path(raw: Any, source_root: Path, release_root: Path, label: str) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError(f"cron_notification_path_missing:{label}")
    candidate = Path(raw).expanduser()
    # Runtime notifications are data artifacts, not release files. Preserve a
    # logical data-relative path so the listener resolves it through
    # OPENALICE_ARTIFACT_DIR/OPENALICE_DATA_DIR at execution time.
    data_marker = "/data/"
    raw_posix = candidate.as_posix()
    marker_index = raw_posix.find(data_marker)
    if marker_index >= 0:
        logical = "data/" + raw_posix[marker_index + len(data_marker):]
        if logical.startswith("data/runtime/") or logical.startswith("data/"):
            return logical
    if not candidate.is_absolute():
        logical = PurePosixPath(raw_posix).as_posix()
        if logical.startswith("data/"):
            return logical
    # A notification under the source tree is allowed only if it maps into the
    # release; this is uncommon but keeps the conversion explicit.
    relative, _ = map_source_path(raw, source_root, release_root, label, allow_missing=True)
    return relative


def registry_roles(registry: dict[str, Any]) -> dict[str, list[str]]:
    roles: dict[str, list[str]] = {}
    for item in registry.get("jobs", []):
        if not isinstance(item, dict) or not isinstance(item.get("id"), str):
            continue
        allowed = item.get("allowedRuntimeRoles")
        if not isinstance(allowed, list) or not allowed or not all(isinstance(role, str) for role in allowed):
            raise ValueError(f"cron_registry_allowlist_missing:{item.get('id')}")
        roles[item["id"]] = list(dict.fromkeys(allowed))
    return roles


def normalize_document(
    document: dict[str, Any],
    source_root: Path,
    release_root: Path,
    registry: dict[str, Any],
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    jobs = document.get("jobs")
    if not isinstance(jobs, list):
        raise ValueError("cron_jobs_array_missing")
    role_map = registry_roles(registry)
    normalized_jobs: list[dict[str, Any]] = []
    mapped: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, value in enumerate(jobs):
        if not isinstance(value, dict):
            raise ValueError(f"cron_job_invalid:{index}")
        job = json.loads(json.dumps(value))
        job_id = job.get("id")
        if not isinstance(job_id, str) or not job_id:
            raise ValueError(f"cron_job_id_missing:{index}")
        if job_id in seen:
            raise ValueError(f"cron_job_id_duplicate:{job_id}")
        seen.add(job_id)
        script = job.get("script")
        if script is None and isinstance(job.get("entrypoint"), str):
            script = {"path": job["entrypoint"]}
            job["script"] = script
        if isinstance(script, dict):
            original = script.get("path")
            relative, resolved = map_source_path(
                original,
                source_root,
                release_root,
                label=f"{job_id}.script.path",
            )
            script["path"] = relative
            if isinstance(script.get("cwd"), str) and script["cwd"].strip():
                cwd, _ = map_source_path(
                    script["cwd"],
                    source_root,
                    release_root,
                    label=f"{job_id}.script.cwd",
                    allow_missing=False,
                )
                script["cwd"] = "." if cwd == "." else str(PurePosixPath(cwd))
            elif script.get("cwd") is not None:
                raise ValueError(f"cron_cwd_invalid:{job_id}")
            if script.get("notificationPath") is not None:
                script["notificationPath"] = normalize_notification_path(
                    script["notificationPath"], source_root, release_root, f"{job_id}.notificationPath"
                )
            allowed = role_map.get(job_id)
            if allowed is None:
                raise ValueError(f"cron_registry_entry_missing:{job_id}")
            script["allowedRuntimeRoles"] = allowed
            mapped.append({"jobId": job_id, "field": "script.path", "from": str(original), "to": relative})
        elif job.get("kind") == "script":
            raise ValueError(f"cron_script_path_missing:{job_id}")
        if job_id in role_map:
            job["allowedRuntimeRoles"] = role_map[job_id]
        normalized_jobs.append(job)

    out = {
        "schemaVersion": "cron_runtime_state.v1",
        "schedulerOwner": "openalice_cron_engine",
        "normalizedFrom": document.get("schemaVersion", "legacy"),
        "jobs": normalized_jobs,
    }
    return out, mapped


def write_atomic(path: Path, data: bytes, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, mode)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main() -> None:
    args = parse_args()
    jobs = Path(args.jobs).expanduser().resolve()
    source_root = Path(args.source_root).expanduser().resolve()
    release_root = Path(args.release_root).expanduser().resolve()
    registry_path = Path(args.registry).expanduser().resolve()
    backup = Path(args.backup).expanduser().resolve()
    receipt = Path(args.receipt).expanduser().resolve()
    if not jobs.is_file() or jobs.is_symlink():
        raise SystemExit("cron_jobs_must_be_regular_file")
    if not source_root.is_dir() or not release_root.is_dir():
        raise SystemExit("cron_source_or_release_root_missing")
    original = jobs.read_bytes()
    document = json.loads(original.decode("utf-8"))
    registry = load_json(registry_path)
    normalized, mappings = normalize_document(document, source_root, release_root, registry)
    normalized_bytes = (json.dumps(normalized, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    receipt_data = {
        "schemaVersion": "cron_jobs_normalization_receipt.v1",
        "status": "pass",
        "jobsPath": str(jobs),
        "sourceRoot": str(source_root),
        "releaseRoot": str(release_root),
        "originalSha256": sha256_bytes(original),
        "normalizedSha256": sha256_bytes(normalized_bytes),
        "jobCount": len(normalized.get("jobs", [])),
        "mappingCount": len(mappings),
        "mappings": mappings,
        "dryRun": bool(args.dry_run),
    }
    if not args.dry_run:
        backup.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(backup, original)
        write_atomic(jobs, normalized_bytes)
    receipt_data["backupPath"] = str(backup)
    receipt_data["outputPath"] = str(jobs)
    write_atomic(receipt, (json.dumps(receipt_data, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))
    print(json.dumps(receipt_data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
