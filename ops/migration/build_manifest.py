#!/usr/bin/env python3
"""Build a fail-closed migration inventory for an existing dirty worktree.

The inventory records filenames, Git state, hashes for approved source files,
and secret-rule identifiers. It never records matching secret content.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import subprocess
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Iterable


SCHEMA_VERSION = "openalice_migration_manifest.v1"
ALLOWED_ACTIONS = {
    "port",
    "supersede",
    "retain-original",
    "secret-isolate",
    "retire",
}
MAX_SECRET_SCAN_BYTES = 2 * 1024 * 1024

SECRET_PATH_RE = re.compile(
    r"(^|[._/-])"
    r"(secret|secrets|credential|credentials|token|api[_-]?key|private[_-]?key|"
    r"id_rsa|id_dsa|id_ed25519)"
    r"([._/-]|$)",
    re.IGNORECASE,
)
SECRET_ASSIGNMENT_RE = re.compile(
    rb"""(?ix)
    (?:api[_-]?key|secret|token|password|passwd|private[_-]?key)
    \s*(?:=|:)\s*
    ["']
    ([A-Za-z0-9_./+=:@-]{24,})
    ["']
    """,
)
HIGH_CONFIDENCE_SECRET_RULES: tuple[tuple[str, re.Pattern[bytes]], ...] = (
    (
        "private_key_pem",
        re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ),
    ("aws_access_key_id", re.compile(rb"\bAKIA[0-9A-Z]{16}\b")),
    (
        "telegram_bot_token",
        re.compile(rb"\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b"),
    ),
    (
        "provider_key_literal",
        re.compile(rb"\b(?:sk|xox[baprs]|ghp|github_pat)_[A-Za-z0-9_-]{20,}\b"),
    ),
)
PLACEHOLDER_MARKERS = (
    b"example",
    b"placeholder",
    b"dummy",
    b"test",
    b"fake",
    b"redacted",
    b"changeme",
    b"your_",
    b"your-",
)


@dataclass(frozen=True)
class GitEntry:
    path: str
    original_path: str | None
    porcelain: str
    index_status: str
    worktree_status: str


def run_git(repo: Path, *args: str, binary: bool = False) -> bytes | str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=True,
        capture_output=True,
    )
    if binary:
        return result.stdout
    return result.stdout.decode("utf-8", errors="strict").strip()


def read_status(repo: Path) -> bytes:
    return run_git(
        repo,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        binary=True,
    )


def parse_status(raw: bytes) -> list[GitEntry]:
    records = raw.split(b"\0")
    entries: list[GitEntry] = []
    index = 0
    while index < len(records):
        record = records[index]
        index += 1
        if not record:
            continue
        if len(record) < 4:
            raise ValueError("malformed porcelain-v1 record")
        index_status = chr(record[0])
        worktree_status = chr(record[1])
        if record[2:3] != b" ":
            raise ValueError("unexpected porcelain-v1 separator")
        path = os.fsdecode(record[3:])
        original_path: str | None = None
        if index_status in {"R", "C"} or worktree_status in {"R", "C"}:
            if index >= len(records) or not records[index]:
                raise ValueError(f"missing rename source for {path!r}")
            original_path = os.fsdecode(records[index])
            index += 1
        entries.append(
            GitEntry(
                path=normalize_repo_path(path),
                original_path=normalize_repo_path(original_path)
                if original_path
                else None,
                porcelain=f"{index_status}{worktree_status}",
                index_status=index_status,
                worktree_status=worktree_status,
            )
        )
    return entries


def normalize_repo_path(raw_path: str) -> str:
    path = PurePosixPath(raw_path.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe repository path: {raw_path!r}")
    normalized = path.as_posix()
    if normalized in {"", "."}:
        raise ValueError(f"empty repository path: {raw_path!r}")
    return normalized


def status_kinds(entry: GitEntry) -> list[str]:
    raw = entry.porcelain
    out: list[str] = []
    if raw == "??":
        out.append("untracked")
    mapping = (
        ("M", "modified"),
        ("D", "deleted"),
        ("A", "added"),
        ("R", "renamed"),
        ("C", "copied"),
        ("T", "typechange"),
        ("U", "unmerged"),
    )
    for marker, label in mapping:
        if marker in raw:
            out.append(label)
    return out


def is_secret_risk_path(path: str) -> bool:
    basename = PurePosixPath(path).name.lower()
    if (
        basename == ".env"
        or basename.startswith(".env.")
        or basename.endswith((".pem", ".key", ".p12", ".pfx", ".kubeconfig"))
    ):
        return True
    return bool(SECRET_PATH_RE.search(path))


def classify_protocol(path: str, secret_path: bool) -> str:
    if secret_path:
        return "D"
    if path.startswith(("data/", "runtime/", "generated/", ".cache/", "coverage/")):
        return "B"
    if path.startswith("logs/") or "/logs/" in path or path.endswith((".log", ".jsonl")):
        return "B"
    if path.startswith("docs/") or "/archive/" in path:
        return "C"
    return "A"


def classify_action(entry: GitEntry, protocol: str) -> tuple[str, str]:
    path = entry.path
    kinds = status_kinds(entry)
    if protocol == "D":
        return "secret-isolate", "credential-like filename; reimplement after isolated review"
    if "unmerged" in kinds:
        return "retain-original", "unmerged state is not safe to forward-port"
    if "deleted" in kinds:
        return "retain-original", "tracked deletion requires an explicit replacement decision"
    if protocol == "B":
        return "retain-original", "runtime/generated artifact is not source"
    if path.startswith((".understand-anything/", "models/", "scripts/archive/")):
        return "retain-original", "generated, trained, or archived material stays in the original"
    if path in {"FINAL_FIX_REPORT.txt", "FIXES_2026-05-15.md"}:
        return "retire", "stale one-off repair report is not versioned architecture source"
    if path.startswith("decision_packet/"):
        return "supersede", "stale decision packet is superseded by executed validation receipts"
    if path.startswith(("src/", "scripts/", "ui/", "docs/", "default/")):
        return "port", "reviewed source, test, compatibility, documentation, or default config lane"
    if path in {".gitignore", "package.json", "pnpm-lock.yaml"}:
        return "port", "repository configuration required by reviewed source changes"
    return "retain-original", "unclassified path is retained until an explicit decision"


def shannon_entropy(value: bytes) -> float:
    if not value:
        return 0.0
    counts = Counter(value)
    size = len(value)
    return -sum((count / size) * math.log2(count / size) for count in counts.values())


def scan_secret_rules(path: Path) -> list[str]:
    try:
        file_stat = path.lstat()
    except FileNotFoundError:
        return []
    if not stat.S_ISREG(file_stat.st_mode) or file_stat.st_size > MAX_SECRET_SCAN_BYTES:
        return []
    raw = path.read_bytes()
    rules = [rule for rule, pattern in HIGH_CONFIDENCE_SECRET_RULES if pattern.search(raw)]
    for match in SECRET_ASSIGNMENT_RE.finditer(raw):
        candidate = match.group(1)
        lowered = candidate.lower()
        if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
            continue
        if shannon_entropy(candidate) >= 3.6:
            rules.append("high_entropy_secret_assignment")
            break
    return sorted(set(rules))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_entry(repo: Path, entry: GitEntry) -> dict[str, object]:
    kinds = status_kinds(entry)
    source_path = repo / entry.path
    secret_path = is_secret_risk_path(entry.path) or bool(
        entry.original_path and is_secret_risk_path(entry.original_path)
    )
    protocol = classify_protocol(entry.path, secret_path)
    action, reason = classify_action(entry, protocol)
    scan_rules = [] if "deleted" in kinds else scan_secret_rules(source_path)
    if scan_rules:
        action = "secret-isolate"
        reason = "high-confidence secret pattern detected; matching content intentionally omitted"

    file_kind = "missing"
    source_hash: str | None = None
    source_mode: str | None = None
    if source_path.exists() or source_path.is_symlink():
        file_stat = source_path.lstat()
        source_mode = oct(stat.S_IMODE(file_stat.st_mode))
        if stat.S_ISREG(file_stat.st_mode):
            file_kind = "regular"
            if action == "port":
                source_hash = sha256_file(source_path)
        elif stat.S_ISLNK(file_stat.st_mode):
            file_kind = "symlink"
            if action == "port":
                action = "retain-original"
                reason = "symlink requires an explicit target review"
        elif stat.S_ISDIR(file_stat.st_mode):
            file_kind = "directory"
        else:
            file_kind = "special"
            if action == "port":
                action = "retain-original"
                reason = "special file cannot be forward-ported"

    if action not in ALLOWED_ACTIONS:
        raise AssertionError(f"invalid action {action!r}")
    return {
        "path": entry.path,
        "originalPath": entry.original_path,
        "porcelain": entry.porcelain,
        "statusKinds": kinds,
        "protocolClass": protocol,
        "action": action,
        "reason": reason,
        "fileKind": file_kind,
        "sourceMode": source_mode,
        "sourceSha256": source_hash,
        "secretScanRuleIds": scan_rules,
    }


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def build_manifest(repo: Path, generated_at: str) -> dict[str, object]:
    repo = repo.resolve(strict=True)
    raw_status = read_status(repo)
    entries = [build_entry(repo, entry) for entry in parse_status(raw_status)]
    action_counts = Counter(str(entry["action"]) for entry in entries)
    protocol_counts = Counter(str(entry["protocolClass"]) for entry in entries)
    status_counts = Counter(
        kind for entry in entries for kind in entry["statusKinds"]  # type: ignore[index]
    )
    head = str(run_git(repo, "rev-parse", "HEAD"))
    branch = str(run_git(repo, "branch", "--show-current"))
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "source": {
            "repository": repo.name,
            "branch": branch,
            "commit": head,
            "dirtyStateHash": hashlib.sha256(raw_status).hexdigest(),
        },
        "policy": {
            "copyActions": ["port"],
            "destructiveOperationsAllowed": False,
            "secretContentRecorded": False,
            "sourceWorktreeMutationAllowed": False,
        },
        "counts": {
            "total": len(entries),
            "byAction": {key: action_counts.get(key, 0) for key in sorted(ALLOWED_ACTIONS)},
            "byProtocolClass": {
                key: protocol_counts.get(key, 0) for key in ("A", "B", "C", "D")
            },
            "byStatusKind": dict(sorted(status_counts.items())),
        },
        "entries": entries,
    }


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--generated-at", default=None)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    generated_at = args.generated_at or utc_now()
    manifest = build_manifest(args.source, generated_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        json.dumps(
            {
                "schemaVersion": manifest["schemaVersion"],
                "output": str(args.output),
                "counts": manifest["counts"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
