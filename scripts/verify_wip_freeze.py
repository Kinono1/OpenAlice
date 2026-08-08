#!/usr/bin/env python3
"""Read-only drift check for a frozen legacy WIP receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    repo = args.repo_root.resolve()
    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    entries = receipt.get("entries")
    if receipt.get("schemaVersion") != "dirty_wip_freeze.v1" or not isinstance(entries, list):
        raise SystemExit("freeze_receipt_invalid")
    raw = subprocess.check_output(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=repo
    )
    expected_status = receipt.get("status", {})
    mismatches: list[str] = []
    if len([line for line in raw.decode("utf-8", "surrogateescape").splitlines() if line]) != expected_status.get("entryCount"):
        mismatches.append("status_entry_count")
    if hashlib.sha256(raw).hexdigest() != expected_status.get("rawSha256"):
        mismatches.append("status_raw_sha256")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    branch = subprocess.check_output(["git", "symbolic-ref", "--short", "HEAD"], cwd=repo, text=True).strip()
    if head != receipt.get("head"):
        mismatches.append("head")
    if branch != receipt.get("branch"):
        mismatches.append("branch")
    hash_checked = 0
    for item in entries:
        path_text = item.get("path")
        if not isinstance(path_text, str) or Path(path_text).is_absolute() or ".." in Path(path_text).parts:
            mismatches.append(f"unsafe_path:{path_text}")
            continue
        path = repo / path_text
        present = path.exists() or path.is_symlink()
        if present != bool(item.get("present")):
            mismatches.append(f"presence:{path_text}")
            continue
        expected_hash = item.get("expectedSha256")
        if expected_hash and present:
            hash_checked += 1
            if not path.is_file() or path.is_symlink() or sha256_file(path) != expected_hash:
                mismatches.append(f"hash:{path_text}")
    status = "pass" if not mismatches else "blocked"
    print(json.dumps({
        "schemaVersion": "dirty_wip_freeze_verification.v1",
        "status": status,
        "repoRoot": str(repo),
        "receipt": str(args.receipt.resolve()),
        "expectedEntryCount": expected_status.get("entryCount"),
        "sourceHashCheckedCount": hash_checked,
        "mismatches": mismatches,
        "driftDetected": bool(mismatches),
    }, indent=2))
    if mismatches:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
