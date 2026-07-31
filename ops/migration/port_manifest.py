#!/usr/bin/env python3
"""Forward-port only entries explicitly approved by a migration manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable

from build_manifest import SCHEMA_VERSION, read_status


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def git_text(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def safe_join(root: Path, repo_path: str) -> Path:
    pure_path = PurePosixPath(repo_path)
    if pure_path.is_absolute() or ".." in pure_path.parts:
        raise ValueError(f"unsafe manifest path: {repo_path!r}")
    candidate = root.joinpath(*pure_path.parts)
    candidate.relative_to(root)
    return candidate


def copy_manifest(
    manifest_path: Path,
    source: Path,
    target: Path,
) -> dict[str, object]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("schemaVersion") != SCHEMA_VERSION:
        raise ValueError("unsupported migration manifest schema")

    source = source.resolve(strict=True)
    target = target.resolve(strict=True)
    expected_commit = manifest["source"]["commit"]
    observed_commit = git_text(source, "rev-parse", "HEAD")
    if observed_commit != expected_commit:
        raise RuntimeError("source commit no longer matches the migration manifest")
    observed_dirty_hash = hashlib.sha256(read_status(source)).hexdigest()
    if observed_dirty_hash != manifest["source"]["dirtyStateHash"]:
        raise RuntimeError("source dirty-state hash no longer matches the migration manifest")

    copied: list[dict[str, str]] = []
    unchanged: list[dict[str, str]] = []
    for entry in manifest["entries"]:
        if entry["action"] != "port":
            continue
        if entry["secretScanRuleIds"]:
            raise RuntimeError(f"refusing secret-flagged port entry: {entry['path']}")
        if entry["fileKind"] != "regular" or not entry["sourceSha256"]:
            raise RuntimeError(f"refusing non-regular port entry: {entry['path']}")

        source_path = safe_join(source, entry["path"])
        target_path = safe_join(target, entry["path"])
        source_stat = source_path.lstat()
        if not stat.S_ISREG(source_stat.st_mode) or source_path.is_symlink():
            raise RuntimeError(f"source type changed for {entry['path']}")
        source_hash = sha256_file(source_path)
        if source_hash != entry["sourceSha256"]:
            raise RuntimeError(f"source hash changed for {entry['path']}")

        if target_path.exists() and target_path.is_file():
            if sha256_file(target_path) == source_hash:
                unchanged.append({"path": entry["path"], "sha256": source_hash})
                continue
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path, follow_symlinks=False)
        os.chmod(target_path, stat.S_IMODE(source_stat.st_mode))
        copied.append({"path": entry["path"], "sha256": source_hash})

    return {
        "schemaVersion": "openalice_migration_port_receipt.v1",
        "executedAt": utc_now(),
        "source": {
            "repository": source.name,
            "commit": observed_commit,
            "dirtyStateHash": observed_dirty_hash,
        },
        "target": {
            "repository": target.name,
            "commitBeforePort": git_text(target, "rev-parse", "HEAD"),
        },
        "manifestSha256": sha256_file(manifest_path),
        "copiedCount": len(copied),
        "unchangedCount": len(unchanged),
        "copied": copied,
        "unchanged": unchanged,
        "deletedCount": 0,
        "secretEntriesCopied": 0,
    }


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    receipt = copy_manifest(args.manifest, args.source, args.target)
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_text(
        json.dumps(receipt, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "schemaVersion": receipt["schemaVersion"],
                "copiedCount": receipt["copiedCount"],
                "unchangedCount": receipt["unchangedCount"],
                "deletedCount": receipt["deletedCount"],
                "secretEntriesCopied": receipt["secretEntriesCopied"],
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
