#!/usr/bin/env python3
"""Receipt-bound OpenAlice control plane.

The controller executes only registered argv arrays, writes redacted validation
receipts, and derives status from receipts bound to the current commit and
dirty-state hash. It has no command that mutates paper/live admission.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


RECEIPT_SCHEMA = "validation_receipt.v1"
STATE_SCHEMA = "controller_state.v1"
REGISTRY_SCHEMA = "validation_check_registry.v1"
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
SECRET_NAME_RE = re.compile(
    r"(?:secret|token|password|passwd|api[_-]?key|private[_-]?key|authorization)",
    re.IGNORECASE,
)
SECRET_LITERAL_RES = (
    re.compile(r"\b(?:sk|xox[baprs]|ghp)_[A-Za-z0-9_-]{12,}\b"),
    re.compile(r"\b[0-9]{8,12}:[A-Za-z0-9_-]{25,}\b"),
    re.compile(
        r"(?i)\b(api[_-]?key|secret|token|password|authorization)"
        r"\s*[:=]\s*([^\s,;]{6,})"
    ),
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_git(repo_root: Path, *args: str, binary: bool = False) -> str | bytes:
    completed = subprocess.run(
        ["git", "-C", str(repo_root), *args],
        check=True,
        capture_output=True,
    )
    if binary:
        return completed.stdout
    return completed.stdout.decode("utf-8", errors="strict").strip()


def source_binding(repo_root: Path) -> dict[str, Any]:
    raw_status = run_git(
        repo_root,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        binary=True,
    )
    assert isinstance(raw_status, bytes)
    commit = run_git(repo_root, "rev-parse", "HEAD")
    assert isinstance(commit, str)
    return {
        "sourceCommit": commit,
        "dirtyStateHash": sha256_bytes(raw_status),
        "sourceClean": raw_status == b"",
    }


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def load_registry(path: Path) -> dict[str, Any]:
    registry = load_json(path)
    if registry.get("schemaVersion") != REGISTRY_SCHEMA:
        raise ValueError(f"unsupported validation registry: {path}")
    checks = registry.get("checks")
    if not isinstance(checks, list) or not checks:
        raise ValueError("validation registry must contain checks")
    seen: set[str] = set()
    for raw in checks:
        if not isinstance(raw, dict):
            raise ValueError("validation registry check must be an object")
        check_id = raw.get("id")
        command = raw.get("command")
        if not isinstance(check_id, str) or not check_id or check_id in seen:
            raise ValueError(f"invalid or duplicate validation check id: {check_id!r}")
        if (
            not isinstance(command, list)
            or not command
            or not all(isinstance(item, str) and item for item in command)
        ):
            raise ValueError(f"check {check_id} must use a non-empty argv array")
        ttl = raw.get("ttlSeconds")
        if not isinstance(ttl, int) or ttl <= 0:
            raise ValueError(f"check {check_id} must declare a positive ttlSeconds")
        seen.add(check_id)
    return registry


def resolve_repo_path(repo_root: Path, raw: str) -> Path:
    candidate = Path(raw)
    resolved = candidate.resolve() if candidate.is_absolute() else (repo_root / candidate).resolve()
    try:
        resolved.relative_to(repo_root.resolve())
    except ValueError as exc:
        raise ValueError(f"path escapes repository: {raw}") from exc
    return resolved


def hash_declared_paths(repo_root: Path, paths: Iterable[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for raw in paths:
        if not isinstance(raw, str) or not raw:
            raise ValueError("declared path must be a non-empty string")
        path = resolve_repo_path(repo_root, raw)
        if not path.is_file():
            out.append({"path": raw, "exists": False, "sha256": None})
            continue
        out.append({"path": raw, "exists": True, "sha256": sha256_file(path)})
    return out


def redaction_values(env: dict[str, str]) -> list[str]:
    values = [
        value
        for key, value in env.items()
        if SECRET_NAME_RE.search(key) and isinstance(value, str) and len(value) >= 6
    ]
    return sorted(set(values), key=len, reverse=True)


def redact_text(raw: bytes, env: dict[str, str], max_lines: int = 12) -> list[str]:
    text = raw.decode("utf-8", errors="replace")
    for value in redaction_values(env):
        text = text.replace(value, "[REDACTED]")
    for pattern in SECRET_LITERAL_RES:
        if pattern.groups >= 2:
            text = pattern.sub(lambda match: f"{match.group(1)}=[REDACTED]", text)
        else:
            text = pattern.sub("[REDACTED]", text)
    lines = text.splitlines()[-max_lines:]
    return [line[:500] for line in lines]


def run_check(
    repo_root: Path,
    runtime_dir: Path,
    check: dict[str, Any],
    *,
    now: datetime | None = None,
    env: dict[str, str] | None = None,
) -> dict[str, Any]:
    started = now or utc_now()
    binding = source_binding(repo_root)
    check_id = str(check["id"])
    command = list(check["command"])
    timeout_seconds = int(check.get("timeoutSeconds", 1800))
    run_env = dict(os.environ if env is None else env)
    timed_out = False
    try:
        completed = subprocess.run(
            command,
            cwd=repo_root,
            env=run_env,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
        exit_code = completed.returncode
        stdout = completed.stdout
        stderr = completed.stderr
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        exit_code = 124
        stdout = exc.stdout or b""
        stderr = exc.stderr or b""
    ended = utc_now()
    inputs = hash_declared_paths(repo_root, check.get("inputPaths", []))
    artifacts = hash_declared_paths(repo_root, check.get("artifactPaths", []))
    missing_required_artifact = any(not item["exists"] for item in artifacts)
    status = "pass" if exit_code == 0 and not missing_required_artifact else "fail"
    receipt = {
        "schemaVersion": RECEIPT_SCHEMA,
        "receiptId": f"{check_id}:{int(started.timestamp() * 1000)}",
        "checkId": check_id,
        "startedAt": isoformat(started),
        "endedAt": isoformat(ended),
        "executedAt": isoformat(ended),
        "expiresAt": isoformat(ended + timedelta(seconds=int(check["ttlSeconds"]))),
        "exitCode": exit_code,
        "sourceCommit": binding["sourceCommit"],
        "dirtyStateHash": binding["dirtyStateHash"],
        "sourceClean": binding["sourceClean"],
        "commandDigest": sha256_bytes(
            json.dumps(command, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ),
        "inputSummary": inputs,
        "outputSummary": {
            "stdoutBytes": len(stdout),
            "stderrBytes": len(stderr),
            "stdoutSha256": sha256_bytes(stdout),
            "stderrSha256": sha256_bytes(stderr),
            "stdoutTail": redact_text(stdout, run_env),
            "stderrTail": redact_text(stderr, run_env),
            "timedOut": timed_out,
        },
        "artifacts": artifacts,
        "status": status,
    }
    receipt_path = runtime_dir / "receipts" / f"{check_id}.validation_receipt.v1.json"
    atomic_write_json(receipt_path, receipt)
    return receipt


def validate_receipt(
    receipt: dict[str, Any],
    check: dict[str, Any],
    binding: dict[str, Any],
    repo_root: Path,
    *,
    now: datetime | None = None,
) -> tuple[bool, str]:
    current_time = now or utc_now()
    required = {
        "schemaVersion",
        "receiptId",
        "checkId",
        "startedAt",
        "endedAt",
        "executedAt",
        "expiresAt",
        "exitCode",
        "sourceCommit",
        "dirtyStateHash",
        "sourceClean",
        "commandDigest",
        "inputSummary",
        "outputSummary",
        "artifacts",
        "status",
    }
    missing = sorted(required - receipt.keys())
    if missing:
        return False, f"receipt_schema_missing:{','.join(missing)}"
    if receipt.get("schemaVersion") != RECEIPT_SCHEMA:
        return False, "receipt_schema_version_mismatch"
    if receipt.get("checkId") != check.get("id"):
        return False, "receipt_check_id_mismatch"
    if receipt.get("sourceCommit") != binding["sourceCommit"]:
        return False, "receipt_source_commit_mismatch"
    if receipt.get("dirtyStateHash") != binding["dirtyStateHash"]:
        return False, "receipt_dirty_state_hash_mismatch"
    if receipt.get("sourceClean") is not binding["sourceClean"]:
        return False, "receipt_source_clean_mismatch"
    if receipt.get("sourceClean") is not True:
        return False, "receipt_source_dirty"
    if not HASH_RE.fullmatch(str(receipt.get("commandDigest", ""))):
        return False, "receipt_command_digest_invalid"
    ended_at = parse_time(receipt.get("endedAt"))
    executed_at = parse_time(receipt.get("executedAt"))
    expires_at = parse_time(receipt.get("expiresAt"))
    if ended_at is None or executed_at is None or expires_at is None:
        return False, "receipt_timestamp_invalid"
    if expires_at <= current_time:
        return False, "receipt_expired"
    if executed_at != ended_at:
        return False, "receipt_execution_timestamp_mismatch"
    exit_code = receipt.get("exitCode")
    status = receipt.get("status")
    if not isinstance(exit_code, int) or status not in {"pass", "fail"}:
        return False, "receipt_outcome_invalid"
    if (exit_code == 0) != (status == "pass"):
        return False, "receipt_outcome_inconsistent"
    expected_artifacts = {
        item["path"]: item
        for item in receipt.get("artifacts", [])
        if isinstance(item, dict) and isinstance(item.get("path"), str)
    }
    for raw in check.get("artifactPaths", []):
        recorded = expected_artifacts.get(raw)
        if not recorded or recorded.get("exists") is not True:
            return False, f"receipt_artifact_missing:{raw}"
        path = resolve_repo_path(repo_root, raw)
        if not path.is_file():
            return False, f"artifact_missing:{raw}"
        if recorded.get("sha256") != sha256_file(path):
            return False, f"artifact_hash_mismatch:{raw}"
    if status != "pass":
        return False, f"receipt_check_failed:{check['id']}"
    return True, "valid"


def receipt_path(runtime_dir: Path, check_id: str) -> Path:
    return runtime_dir / "receipts" / f"{check_id}.validation_receipt.v1.json"


def evaluate_checks(
    repo_root: Path,
    runtime_dir: Path,
    registry: dict[str, Any],
    binding: dict[str, Any],
    *,
    now: datetime | None = None,
) -> list[dict[str, Any]]:
    outcomes: list[dict[str, Any]] = []
    for check in registry["checks"]:
        path = receipt_path(runtime_dir, check["id"])
        if not path.is_file():
            outcomes.append(
                {
                    "checkId": check["id"],
                    "required": bool(check.get("required", True)),
                    "status": "missing",
                    "reason": "receipt_missing",
                    "receiptPath": str(path),
                }
            )
            continue
        try:
            receipt = load_json(path)
            valid, reason = validate_receipt(
                receipt,
                check,
                binding,
                repo_root,
                now=now,
            )
        except (OSError, ValueError, json.JSONDecodeError) as exc:
            receipt = {}
            valid, reason = False, f"receipt_unreadable:{type(exc).__name__}"
        outcomes.append(
            {
                "checkId": check["id"],
                "required": bool(check.get("required", True)),
                "status": "pass" if valid else "blocked",
                "reason": reason,
                "receiptPath": str(path),
                "executedAt": receipt.get("executedAt"),
                "expiresAt": receipt.get("expiresAt"),
            }
        )
    return outcomes


def build_controller_state(
    repo_root: Path,
    runtime_dir: Path,
    registry: dict[str, Any],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    generated_at = now or utc_now()
    binding = source_binding(repo_root)
    checks = evaluate_checks(repo_root, runtime_dir, registry, binding, now=generated_at)
    required_blocked = [
        item for item in checks if item["required"] and item["status"] != "pass"
    ]
    missing = any(item["status"] == "missing" for item in required_blocked)
    status_source = (
        "missing"
        if missing
        else "stale"
        if required_blocked
        else "executed_receipt"
    )
    receipt_times = [
        parse_time(item.get("executedAt"))
        for item in checks
        if item.get("executedAt")
    ]
    receipt_expiries = [
        parse_time(item.get("expiresAt"))
        for item in checks
        if item.get("expiresAt")
    ]
    executed = [value for value in receipt_times if value is not None]
    expiries = [value for value in receipt_expiries if value is not None]
    blockers = [
        {
            "blockerId": f"validation_{item['checkId']}",
            "severity": "critical" if item["required"] else "high",
            "status": "open",
            "summary": item["reason"],
            "evidencePath": item["receiptPath"],
        }
        for item in required_blocked
    ]
    if not binding["sourceClean"]:
        blockers.append(
            {
                "blockerId": "dirty_worktree",
                "severity": "critical",
                "status": "open",
                "summary": "Engineering admission requires a clean, committed source tree.",
                "evidencePath": str(repo_root),
            }
        )
    blockers.extend(
        [
            {
                "blockerId": "paper_time_evidence_incomplete",
                "severity": "critical",
                "status": "open",
                "summary": "A fresh continuous seven-day paper/shadow window has not been admitted by this controller.",
            },
            {
                "blockerId": "live_time_evidence_incomplete",
                "severity": "critical",
                "status": "open",
                "summary": "A fresh continuous thirty-day net-profit/risk window and two-person approval have not been admitted by this controller.",
            },
            {
                "blockerId": "credential_rotation_incomplete",
                "severity": "critical",
                "status": "open",
                "summary": "Credential rotation and old-credential revocation require an external operational receipt.",
            },
        ]
    )
    return {
        "schemaVersion": STATE_SCHEMA,
        "updatedAt": isoformat(generated_at),
        "workspace": "crypto",
        "goal": "Reach safe guarded deployment without weakening evidence or execution gates.",
        "sourceCommit": binding["sourceCommit"],
        "dirtyStateHash": binding["dirtyStateHash"],
        "sourceClean": binding["sourceClean"],
        "receiptPath": str(runtime_dir / "receipts"),
        "executedAt": isoformat(max(executed)) if executed else None,
        "expiresAt": isoformat(min(expiries)) if expiries else None,
        "statusSource": status_source,
        "engineeringStatus": (
            "blocked" if required_blocked or not binding["sourceClean"] else "pass"
        ),
        "candidate": {
            "candidateId": "openalice_architecture_v2",
            "status": "admission_pending",
            "authorityLevel": "paper_only",
        },
        "blockers": {
            "status": "blocked",
            "open": blockers,
            "closed": [],
        },
        "checks": checks,
        "admission": {
            "paperTradingAllowed": False,
            "liveTradingAllowed": False,
            "liveExecutionArmed": False,
            "reason": "time_evidence_and_operational_approval_not_established",
        },
    }


def validate_controller_state(
    state: dict[str, Any],
    binding: dict[str, Any],
) -> tuple[bool, str]:
    required = {
        "schemaVersion",
        "updatedAt",
        "workspace",
        "sourceCommit",
        "dirtyStateHash",
        "sourceClean",
        "receiptPath",
        "executedAt",
        "expiresAt",
        "statusSource",
        "engineeringStatus",
        "candidate",
        "blockers",
        "checks",
        "admission",
    }
    missing = sorted(required - state.keys())
    if missing:
        return False, f"controller_state_schema_missing:{','.join(missing)}"
    if state.get("schemaVersion") != STATE_SCHEMA:
        return False, "controller_state_schema_version_mismatch"
    if state.get("sourceCommit") != binding["sourceCommit"]:
        return False, "controller_state_source_commit_mismatch"
    if state.get("dirtyStateHash") != binding["dirtyStateHash"]:
        return False, "controller_state_dirty_state_hash_mismatch"
    if state.get("sourceClean") is not binding["sourceClean"]:
        return False, "controller_state_source_clean_mismatch"
    if state.get("statusSource") not in {"executed_receipt", "stale", "missing"}:
        return False, "controller_state_status_source_invalid"
    admission = state.get("admission")
    if not isinstance(admission, dict):
        return False, "controller_state_admission_invalid"
    if admission.get("liveExecutionArmed") is not False:
        return False, "controller_state_live_execution_arm_forbidden"
    return True, "valid"


def render_markdown(state: dict[str, Any]) -> str:
    lines = [
        "# OpenAlice control-plane status",
        "",
        f"- Engineering: `{state.get('engineeringStatus', 'unknown')}`",
        f"- Status source: `{state.get('statusSource', 'missing')}`",
        f"- Commit: `{state.get('sourceCommit', 'unknown')}`",
        f"- Dirty-state hash: `{state.get('dirtyStateHash', 'unknown')}`",
        f"- Source clean: `{str(state.get('sourceClean', False)).lower()}`",
        f"- Executed at: `{state.get('executedAt') or 'missing'}`",
        f"- Expires at: `{state.get('expiresAt') or 'missing'}`",
        "",
        "## Validation checks",
        "",
        "| Check | Required | Status | Reason |",
        "| --- | --- | --- | --- |",
    ]
    for check in state.get("checks", []):
        lines.append(
            f"| `{check.get('checkId')}` | `{str(check.get('required')).lower()}` "
            f"| `{check.get('status')}` | `{check.get('reason')}` |"
        )
    admission = state.get("admission", {})
    lines.extend(
        [
            "",
            "## Admission (read-only)",
            "",
            f"- paperTradingAllowed: `{str(admission.get('paperTradingAllowed', False)).lower()}`",
            f"- liveTradingAllowed: `{str(admission.get('liveTradingAllowed', False)).lower()}`",
            f"- liveExecutionArmed: `{str(admission.get('liveExecutionArmed', False)).lower()}`",
            f"- reason: `{admission.get('reason', 'missing')}`",
            "",
            "This report has no approval, reset, unlock, or order-execution control.",
            "",
        ]
    )
    return "\n".join(lines)


def default_repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenAlice receipt-bound control plane")
    parser.add_argument("--repo-root", type=Path, default=default_repo_root())
    parser.add_argument("--runtime-dir", type=Path)
    parser.add_argument("--registry", type=Path)
    subparsers = parser.add_subparsers(dest="action", required=True)

    run_parser = subparsers.add_parser("run", help="execute registered checks and write receipts")
    run_parser.add_argument("check_ids", nargs="*")
    run_parser.add_argument("--continue-on-failure", action="store_true")
    run_parser.add_argument("--json", action="store_true")

    for action in ("refresh", "check", "status", "render"):
        action_parser = subparsers.add_parser(action)
        action_parser.add_argument("--json", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    runtime_dir = (
        args.runtime_dir.resolve()
        if args.runtime_dir
        else Path(
            os.environ.get(
                "OPENALICE_CONTROL_RUNTIME_DIR",
                repo_root / "runtime" / "control-plane",
            )
        ).resolve()
    )
    registry_path = (
        args.registry.resolve()
        if args.registry
        else repo_root / "ops" / "control-plane" / "checks.v1.json"
    )
    registry = load_registry(registry_path)
    state_path = runtime_dir / "controller_state.v1.json"

    if args.action == "run":
        by_id = {check["id"]: check for check in registry["checks"]}
        selected = args.check_ids or list(by_id)
        unknown = [check_id for check_id in selected if check_id not in by_id]
        if unknown:
            print(f"unknown checks: {', '.join(unknown)}", file=sys.stderr)
            return 2
        receipts: list[dict[str, Any]] = []
        for check_id in selected:
            receipt = run_check(repo_root, runtime_dir, by_id[check_id])
            receipts.append(receipt)
            print(f"{check_id}: {receipt['status']} (exit={receipt['exitCode']})")
            if receipt["status"] != "pass" and not args.continue_on_failure:
                break
        state = build_controller_state(repo_root, runtime_dir, registry)
        atomic_write_json(state_path, state)
        if args.json:
            print(json.dumps({"receipts": receipts, "state": state}, indent=2))
        return 0 if all(receipt["status"] == "pass" for receipt in receipts) else 1

    if args.action == "refresh":
        state = build_controller_state(repo_root, runtime_dir, registry)
        atomic_write_json(state_path, state)
        if args.json:
            print(json.dumps(state, indent=2))
        else:
            print(
                f"engineering={state['engineeringStatus']} "
                f"source={state['statusSource']} "
                f"commit={state['sourceCommit'][:12]}"
            )
        return 0 if state["engineeringStatus"] == "pass" else 1

    if not state_path.is_file():
        print(f"controller state missing: {state_path}", file=sys.stderr)
        return 1
    state = load_json(state_path)

    if args.action == "check":
        binding = source_binding(repo_root)
        state_valid, state_reason = validate_controller_state(state, binding)
        checks = evaluate_checks(repo_root, runtime_dir, registry, binding)
        all_required = all(
            item["status"] == "pass" for item in checks if item["required"]
        )
        result = {
            "stateValid": state_valid,
            "stateReason": state_reason,
            "requiredReceiptsValid": all_required,
            "checks": checks,
        }
        if args.json:
            print(json.dumps(result, indent=2))
        else:
            print(
                f"state={state_reason} "
                f"required_receipts={'valid' if all_required else 'blocked'}"
            )
        return 0 if state_valid and all_required else 1

    if args.action == "status":
        if args.json:
            print(json.dumps(state, indent=2))
        else:
            admission = state.get("admission", {})
            print(
                f"engineering={state.get('engineeringStatus', 'unknown')} "
                f"source={state.get('statusSource', 'missing')} "
                f"paper={str(admission.get('paperTradingAllowed', False)).lower()} "
                f"live={str(admission.get('liveTradingAllowed', False)).lower()} "
                f"armed={str(admission.get('liveExecutionArmed', False)).lower()}"
            )
        return 0

    report_path = runtime_dir / "controller_status.md"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(render_markdown(state), encoding="utf-8")
    if args.json:
        print(json.dumps({"reportPath": str(report_path)}, indent=2))
    else:
        print(report_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
