#!/usr/bin/env python3

import argparse
import hashlib
import json
import os
import stat
import subprocess
from datetime import datetime, timezone
from pathlib import Path


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
        "inode": value.st_ino,
        "modifiedTimeUtc": datetime.fromtimestamp(value.st_mtime, timezone.utc).isoformat(),
        "sha256": sha256_path(path),
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()

    repo = Path(args.repo).resolve()
    evidence = Path(args.evidence).resolve()
    (evidence / "verification").mkdir(parents=True, exist_ok=True)
    audit = json.loads((evidence / "AUDIT_SUMMARY.json").read_text(encoding="utf-8"))
    source = Path(audit["source"]["path"])
    archive = Path(audit["archive"]["path"])
    report = Path(audit["replacementLineage"]["formalReportPath"])
    notification = Path(audit["replacementLineage"]["notificationPath"])
    current = metadata(source)
    archive_meta = metadata(archive)
    report_meta = metadata(report)
    notification_meta = metadata(notification)
    current_lines = int(subprocess.check_output(["wc", "-l", str(source)], text=True).split()[0])
    old_allocated = int(audit["source"]["allocatedBytes"])
    archive_allocated = int(audit["archive"]["allocatedBytes"])
    project_net_reduction = old_allocated - archive_allocated - current["allocatedBytes"]

    scheduler = json.loads((repo / "data/cron/jobs.json").read_text(encoding="utf-8"))
    jobs = [job for job in scheduler.get("jobs", []) if job.get("name") == "microstructure_stoploss_replay_hourly"]
    job_status = "PASS" if len(jobs) == 1 and jobs[0].get("enabled") is True else "FAIL"
    lock_absent = not (repo / "data/runtime/locks/microstructure_stoploss_replay.lock").exists()
    source_replaced = current["sha256"] != audit["source"]["sha256"] and current["sizeBytes"] <= 8388608
    archive_identity = archive_meta["sha256"] == audit["archive"]["sha256"]
    report_json = json.loads(report.read_text(encoding="utf-8"))
    notification_json = json.loads(notification.read_text(encoding="utf-8"))
    runtime_outputs_valid = (
        report_json.get("scope") == "microstructure_100x_lane_only"
        and notification_json.get("deliveryDecision") in {"notify", "suppress"}
    )
    status = "PASS" if all([source_replaced, archive_identity, lock_absent, job_status == "PASS", runtime_outputs_valid]) else "FAIL"

    receipt = {
        "schemaVersion": "OPENALICE-MICROSTRUCTURE-LOG-POST-CLEANUP-001",
        "createdAtUtc": datetime.now(timezone.utc).isoformat(),
        "cleanupStatus": status,
        "original": audit["source"],
        "currentBoundedLog": {**current, "lineCount": current_lines, "maximumBytes": 8388608, "status": "PASS" if current["sizeBytes"] <= 8388608 else "FAIL"},
        "completeRecoverableArchive": {**archive_meta, "restoredSha256": audit["archive"]["restoredSha256"], "identityStatus": "PASS" if archive_identity else "FAIL"},
        "runtimeOutputs": {
            "formalReport": report_meta,
            "notification": notification_meta,
            "status": "PASS" if runtime_outputs_valid else "FAIL",
            "softwareExecutionBoundary": "The wrapper completed and regenerated its software artifacts. This is not trading-performance, delivery, or real-world evidence.",
        },
        "schedulerContract": {
            "matchingJobCount": len(jobs),
            "status": job_status,
            "job": jobs[0] if len(jobs) == 1 else None,
            "lockReleased": lock_absent,
        },
        "spaceAccounting": {
            "originalAllocatedBytes": old_allocated,
            "archiveAllocatedBytes": archive_allocated,
            "currentLogAllocatedBytes": current["allocatedBytes"],
            "netProjectReductionBytes": project_net_reduction,
            "netProjectReductionGiB": project_net_reduction / (1024 ** 3),
        },
        "recoverability": "PASS_COMPLETE_GZIP_ARCHIVE_VERIFIED_BEFORE_REPLACEMENT",
        "originalPathReplacementStatus": "PASS" if source_replaced else "FAIL",
    }
    write_json(evidence / "POST_CLEANUP_RECEIPT.json", receipt)
    write_json(evidence / "verification" / "POST_CLEANUP_VERIFICATION.json", {
        "schemaVersion": "OPENALICE-MICROSTRUCTURE-LOG-POST-VERIFICATION-001",
        "status": status,
        "sourceReplacedByBoundedLog": source_replaced,
        "completeArchivePresentAndIdentical": archive_identity,
        "singleEnabledApprovedJob": job_status == "PASS",
        "lockReleased": lock_absent,
        "runtimeOutputsValid": runtime_outputs_valid,
    })
    (evidence / "GIT_STATUS_AFTER.txt").write_text(subprocess.check_output(["git", "status", "--short"], cwd=repo, text=True), encoding="utf-8")

    records = [path for path in evidence.rglob("*") if path.is_file() and path.name != "RECORD_PACKAGE_SHA256SUMS"]
    sums = [f"{sha256_path(path)}  {path.relative_to(evidence)}" for path in sorted(records)]
    (evidence / "RECORD_PACKAGE_SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")
    print(json.dumps({"status": status, "netProjectReductionBytes": project_net_reduction, "receipt": str(evidence / 'POST_CLEANUP_RECEIPT.json')}))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
