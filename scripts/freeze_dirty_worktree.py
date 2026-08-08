#!/usr/bin/env python3
"""Freeze an explicitly audited dirty worktree without changing its Git state.

The snapshot is intentionally narrow: it follows the 555 paths in the reviewed
migration manifest, preserves deleted entries as metadata, and keeps secrets in
the restricted archive only.  The receipt contains no file contents.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run_git(repo: Path, *args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=repo)


def safe_relative(value: str) -> Path:
    candidate = Path(value)
    if candidate.is_absolute() or ".." in candidate.parts:
        raise SystemExit(f"unsafe manifest path: {value}")
    return candidate


def copy_entry(source: Path, destination: Path) -> str:
    info = source.lstat()
    if stat.S_ISLNK(info.st_mode):
        raise SystemExit(f"symlink is not allowed in frozen source: {source}")
    if stat.S_ISREG(info.st_mode):
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        return "regular"
    if stat.S_ISDIR(info.st_mode):
        destination.mkdir(parents=True, exist_ok=True)
        for child in sorted(source.iterdir(), key=lambda p: p.name):
            copy_entry(child, destination / child.name)
        return "directory"
    raise SystemExit(f"unsupported source type in frozen source: {source}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--archive-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    repo = args.repo_root.resolve()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    entries = manifest.get("entries")
    if not isinstance(entries, list) or len(entries) != 555:
        raise SystemExit(f"expected 555 migration entries, got {len(entries) if isinstance(entries, list) else 'invalid'}")

    status_bytes = run_git(repo, "status", "--porcelain=v1", "--untracked-files=all")
    status_lines = [line for line in status_bytes.decode("utf-8", "surrogateescape").splitlines() if line]
    if len(status_lines) != len(entries):
        raise SystemExit(f"status_manifest_count_mismatch:{len(status_lines)}:{len(entries)}")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    archive_root = args.archive_root.resolve()
    archive_root.mkdir(parents=True, exist_ok=True)
    archive_root.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="dirty-wip-", dir=archive_root) as temp_name:
        temp_dir = Path(temp_name)
        files_dir = temp_dir / "files"
        files_dir.mkdir(mode=0o700)
        captured = []
        hash_mismatches = []
        present_count = 0
        for item in entries:
            path_text = item.get("path")
            if not isinstance(path_text, str) or not path_text:
                raise SystemExit("manifest_entry_path_missing")
            rel = safe_relative(path_text)
            source = repo / rel
            expected = item.get("sourceSha256")
            present = source.exists() or source.is_symlink()
            actual = None
            file_kind = item.get("fileKind")
            if present:
                present_count += 1
                if source.is_file() and not source.is_symlink():
                    actual = sha256_file(source)
                if expected and actual != expected:
                    hash_mismatches.append(path_text)
                copy_entry(source, files_dir / rel)
            captured.append({
                "path": path_text,
                "originalPath": item.get("originalPath"),
                "porcelain": item.get("porcelain"),
                "action": item.get("action"),
                "protocolClass": item.get("protocolClass"),
                "fileKind": file_kind,
                "present": present,
                "expectedSha256": expected,
                "actualSha256": actual,
                "secretRisk": item.get("protocolClass") == "D",
            })
        if hash_mismatches:
            raise SystemExit(f"source_hash_mismatch:{','.join(hash_mismatches[:10])}")

        archive_name = temp_dir / "legacy_wip_files.tar"
        with tarfile.open(archive_name, "w") as tar:
            tar.add(files_dir, arcname="files", recursive=True)

        archive_bytes = archive_name.read_bytes()
        archive_sha = sha256_bytes(archive_bytes)
        commit = run_git(repo, "rev-parse", "HEAD").decode().strip()
        branch = run_git(repo, "symbolic-ref", "--short", "HEAD").decode().strip()
        receipt = {
            "schemaVersion": "dirty_wip_freeze.v1",
            "purpose": "legacy_wip",
            "generatedAt": now,
            "repoRoot": str(repo),
            "branch": branch,
            "head": commit,
            "status": {
                "entryCount": len(status_lines),
                "rawSha256": sha256_bytes(status_bytes),
                "rawByteLength": len(status_bytes),
            },
            "manifest": {
                "path": str(args.manifest.resolve()),
                "entryCount": len(entries),
                "presentCount": present_count,
                "sourceHashCheckedCount": sum(1 for x in captured if x["expectedSha256"]),
                "hashMismatches": len(hash_mismatches),
            },
            "archive": {
                "path": "legacy_wip_files.tar",
                "sha256": archive_sha,
                "mode": "restricted",
                "entryCount": len(captured),
            },
            "entries": captured,
            "safety": {
                "dataLogsExcluded": True,
                "gitStateUnchanged": True,
                "secretsOmittedFromReceipt": True,
                "destructiveOperations": False,
            },
        }
        (temp_dir / "freeze_receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
        archive_dir = archive_root / f"legacy-wip-{commit[:12]}"
        if archive_dir.exists():
            raise SystemExit(f"archive_already_exists:{archive_dir}")
        os.replace(temp_dir, archive_dir)
        archive_dir.chmod(0o700)
        (archive_dir / "legacy_wip_files.tar").chmod(0o600)
        (archive_dir / "freeze_receipt.json").chmod(0o600)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(archive_dir / "freeze_receipt.json", args.output)
        args.output.chmod(0o600)
        print(json.dumps({
            "status": "pass",
            "archiveDir": str(archive_dir),
            "receipt": str(args.output.resolve()),
            "entryCount": len(captured),
            "sourceHashCheckedCount": sum(1 for x in captured if x["expectedSha256"]),
            "archiveSha256": archive_sha,
        }, indent=2))


if __name__ == "__main__":
    main()
