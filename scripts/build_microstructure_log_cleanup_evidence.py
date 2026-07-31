#!/usr/bin/env python3

import argparse
import gzip
import hashlib
import json
import os
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path


CHUNK_BYTES = 64 * 1024 * 1024


def sha256_path(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def metadata(path: Path) -> dict:
    value = path.stat()
    return {
        "path": str(path),
        "sizeBytes": value.st_size,
        "allocatedBytes": value.st_blocks * 512,
        "mode": stat.filemode(value.st_mode),
        "modeOctal": oct(stat.S_IMODE(value.st_mode)),
        "uid": value.st_uid,
        "gid": value.st_gid,
        "inode": value.st_ino,
        "birthTimeUtc": datetime.fromtimestamp(value.st_birthtime, timezone.utc).isoformat(),
        "modifiedTimeUtc": datetime.fromtimestamp(value.st_mtime, timezone.utc).isoformat(),
        "accessTimeUtc": datetime.fromtimestamp(value.st_atime, timezone.utc).isoformat(),
        "fileType": "regular_file" if path.is_file() else "unknown",
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def command_output(args: list[str], cwd: Path) -> str:
    result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--source", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    source = Path(args.source).resolve()
    evidence = Path(args.evidence).resolve()
    archive = evidence / "archive" / f"{source.name}.gz"
    chunks_path = evidence / "SOURCE_CHUNK_SHA256.jsonl"

    if not source.is_file():
        raise SystemExit(f"source is not a regular file: {source}")
    if evidence.exists():
        raise SystemExit(f"evidence path already exists: {evidence}")

    (evidence / "archive").mkdir(parents=True, mode=0o700)
    source_meta = metadata(source)
    source_digest = hashlib.sha256()
    chunk_records = []

    with source.open("rb") as src, gzip.GzipFile(filename=source.name, mode="wb", fileobj=archive.open("wb"), mtime=0) as dst:
        index = 0
        offset = 0
        while True:
            chunk = src.read(CHUNK_BYTES)
            if not chunk:
                break
            digest = hashlib.sha256(chunk).hexdigest()
            source_digest.update(chunk)
            dst.write(chunk)
            chunk_records.append({
                "index": index,
                "offsetBytes": offset,
                "sizeBytes": len(chunk),
                "sha256": digest,
            })
            index += 1
            offset += len(chunk)

    source_sha256 = source_digest.hexdigest()
    with chunks_path.open("w", encoding="utf-8") as handle:
        for record in chunk_records:
            handle.write(json.dumps(record, separators=(",", ":")) + "\n")

    restored_digest = hashlib.sha256()
    restored_bytes = 0
    with gzip.open(archive, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            restored_digest.update(chunk)
            restored_bytes += len(chunk)
    restored_sha256 = restored_digest.hexdigest()
    archive_sha256 = sha256_path(archive)

    if restored_sha256 != source_sha256 or restored_bytes != source_meta["sizeBytes"]:
        raise SystemExit("compressed archive verification failed")

    line_count = int(command_output(["wc", "-l", str(source)], repo).strip().split()[0])
    git_head = command_output(["git", "rev-parse", "HEAD"], repo).strip()
    git_branch = command_output(["git", "branch", "--show-current"], repo).strip()
    git_status = command_output(["git", "status", "--short"], repo)

    audit = {
        "schemaVersion": "OPENALICE-MICROSTRUCTURE-LOG-CLEANUP-AUDIT-001",
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "status": "PRE_CLEANUP_VERIFIED",
        "source": {**source_meta, "sha256": source_sha256, "lineCount": line_count},
        "archive": {
            **metadata(archive),
            "sha256": archive_sha256,
            "compression": "gzip_mtime_zero",
            "restoredSha256": restored_sha256,
            "restoredBytes": restored_bytes,
            "identityStatus": "PASS",
        },
        "chunkManifest": {
            "path": str(chunks_path),
            "chunkBytes": CHUNK_BYTES,
            "chunkCount": len(chunk_records),
            "sha256": sha256_path(chunks_path),
        },
        "rootCause": {
            "status": "CONFIRMED_FROM_SOURCE_AND_RUNTIME_EVIDENCE",
            "reasonCode": "FULL_JSON_REPORT_DUPLICATED_TO_APPEND_ONLY_CRON_LOG",
            "description": "The formal JSON report was written to microstructure_stoploss_replay.latest.json and also printed to stdout with --json true; the wrapper redirected stdout into an append-only hourly cron log.",
            "failureInterpretation": "The scheduler state reports successful execution. This is a log-retention defect, not evidence that the research computation failed.",
        },
        "replacementLineage": {
            "formalReportPath": str(repo / "data/runtime/microstructure_stoploss_replay.latest.json"),
            "notificationPath": str(repo / "data/runtime/microstructure_stoploss_replay_notification.json"),
            "wrapperPath": str(repo / "scripts/cron_microstructure_stoploss_replay.sh"),
            "newLogPolicy": {"maximumBytes": 8388608, "retainedLines": 2000},
        },
        "repository": {"path": str(repo), "branch": git_branch, "head": git_head, "dirty": bool(git_status.strip())},
        "decisionBoundary": {
            "softwareExecutionStatus": "PASS_AS_RECORDED_BY_SCHEDULER",
            "formalPublicationStatus": "NOT_APPLICABLE",
            "deliveryStatus": "NO_DECISION",
            "physicalRealWorldStatus": "NO_DECISION",
        },
    }
    write_json(evidence / "AUDIT_SUMMARY.json", audit)
    write_json(evidence / "PRE_CLEANUP_VERIFICATION.json", {
        "schemaVersion": "OPENALICE-MICROSTRUCTURE-LOG-PRE-CLEANUP-001",
        "status": "PASS",
        "sourceExists": source.exists(),
        "sourceSha256": source_sha256,
        "archiveExists": archive.exists(),
        "archiveSha256": archive_sha256,
        "restoredIdentityStatus": "PASS",
        "restoredSha256": restored_sha256,
        "sourceBytes": source_meta["sizeBytes"],
        "restoredBytes": restored_bytes,
        "chunkManifestStatus": "PASS",
    })
    write_json(evidence / "DELETION_PLAN.json", {
        "schemaVersion": "OPENALICE-MICROSTRUCTURE-LOG-DELETION-PLAN-001",
        "status": "APPROVED_BY_USER_REQUEST_AND_PRE_CLEANUP_VERIFIED",
        "exactTarget": str(source),
        "operation": "REPLACE_OVERSIZED_SOURCE_WITH_BOUNDED_CURRENT_LOG_AFTER_VERIFIED_FULL_GZIP_ARCHIVE",
        "recoverability": "RECOVERABLE_FROM_VERIFIED_GZIP_ARCHIVE_IN_EVIDENCE_PACKAGE",
        "reasonCode": "SUPERSEDED_BY_FORMAL_LATEST_JSON_AND_BOUNDED_CRON_LOG_POLICY",
        "unknownReasonPolicy": "UNKNOWN_NOT_RECORDED",
    })
    (evidence / "GIT_STATUS_BEFORE.txt").write_text(git_status, encoding="utf-8")
    (evidence / "README.md").write_text(
        "# OpenAlice microstructure replay log cleanup evidence\n\n"
        "This package preserves the complete original oversized cron log as a deterministic gzip archive, a full-file SHA-256, a 64 MiB chunk SHA-256 manifest, file metadata, the verified root cause, replacement lineage, pre-cleanup checks, and a post-cleanup receipt.\n\n"
        "The scheduler recorded software execution success. The cleanup fixes duplicated report output and retention; it does not establish trading, delivery, physical, or real-world performance.\n",
        encoding="utf-8",
    )

    records = [p for p in evidence.rglob("*") if p.is_file() and p.name != "RECORD_PACKAGE_SHA256SUMS"]
    sums = []
    for path in sorted(records):
        sums.append(f"{sha256_path(path)}  {path.relative_to(evidence)}")
    (evidence / "RECORD_PACKAGE_SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print(json.dumps({"status": "PASS", "sourceSha256": source_sha256, "archiveSha256": archive_sha256, "evidence": str(evidence)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
