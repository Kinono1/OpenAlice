#!/usr/bin/env python3
"""Build and verify the OpenAlice pipeline and Cron definition registries."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath
from typing import Any


PIPELINE_SCHEMA = "pipeline_registry.v1"
CRON_SCHEMA = "cron_definition_registry.v1"
SCRIPT_REF_RE = re.compile(
    r"(?<![A-Za-z0-9_./-])"
    r"(scripts/[A-Za-z0-9_./-]+\.(?:ts|js|mjs|py|sh|json|plist|md|txt))"
)
NETWORK_PUBLIC_MARKERS = (
    "collect",
    "download",
    "backfill",
    "okx",
    "binance",
    "coinmetrics",
    "market",
    "yfinance",
)
PRIVATE_NETWORK_MARKERS = ("private", "telegram", "provider", "auth")
WRITE_MARKERS = (
    "build_",
    "capture_",
    "collect_",
    "compact_",
    "export_",
    "manage_",
    "materialize_",
    "publish_",
    "repair_",
    "settle_",
    "train_",
    "write_",
)

PIPELINE_IO_OVERRIDES: dict[str, dict[str, list[str]]] = {
    "scripts/manage_local_release.ts": {
        "inputs": [
            "runtime/security/credential_rotation/<receipt>.json",
            "ops/pipeline/pipeline_registry.v1.json",
            "ops/release/strategy_release_config.v1.json",
            "pnpm-lock.yaml",
            "runtime/control-plane/receipts",
        ],
        "outputs": [
            "runtime/releases/<sourceCommit>",
            "runtime/releases/current",
            "runtime/releases/previous",
            "runtime/releases/receipts",
        ],
    },
    "scripts/audit_credential_rotation.ts": {
        "inputs": [
            "<external-env-file>",
            "<process-table>",
            "<launch-agent-plists>",
            "logs",
            "src/connectors/web",
            "ui/src",
            "runtime/control-plane",
            "src/sidecar/fixtures",
            "<git-diff>",
        ],
        "outputs": ["runtime/security/credential_rotation"],
    },
    "scripts/run_canary_rollback_drill.ts": {
        "inputs": [
            "src/runtime/canary_governance.ts",
            "src/runtime/release_manager.ts",
        ],
        "outputs": ["runtime/canary-drills"],
    },
}
PIPELINE_SAFETY_OVERRIDES = {
    # The audit is read-only with respect to operational state, but it appends an
    # immutable evidence receipt and therefore needs the normal artifact lock.
    "scripts/audit_credential_rotation.ts": "artifact_write",
    "scripts/run_canary_rollback_drill.ts": "artifact_write",
}
READ_MARKERS = (
    "audit_",
    "check_",
    "compare_",
    "diagnose_",
    "inspect_",
    "summarize_",
    "validate_",
    ".spec.",
    "/test",
)
EXTERNAL_DEPENDENCY_JOB_MARKERS = ("_ssd_", "_retention_")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def normalize_path(raw: str) -> str:
    path = PurePosixPath(raw.replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        raise ValueError(f"unsafe repository path: {raw}")
    return path.as_posix()


def git_script_paths(repo_root: Path) -> list[str]:
    completed = subprocess.run(
        [
            "git",
            "-C",
            str(repo_root),
            "ls-files",
            "-co",
            "--exclude-standard",
            "--",
            "scripts",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    paths = []
    for line in completed.stdout.splitlines():
        path = normalize_path(line.strip())
        if not path or "/__pycache__/" in f"/{path}/" or path.endswith((".pyc", ".pyo")):
            continue
        if (repo_root / path).is_file():
            paths.append(path)
    return sorted(set(paths))


def package_aliases(repo_root: Path) -> dict[str, list[str]]:
    package_path = repo_root / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    scripts = package.get("scripts", {})
    aliases: dict[str, set[str]] = {}
    for alias, command in scripts.items():
        if not isinstance(alias, str) or not isinstance(command, str):
            continue
        for match in SCRIPT_REF_RE.findall(command):
            path = normalize_path(match)
            aliases.setdefault(path, set()).add(alias)
    return {path: sorted(values) for path, values in aliases.items()}


def stable_id(path: str) -> str:
    return "pipeline." + re.sub(r"[^a-z0-9]+", "_", path.lower()).strip("_")


def infer_domain(path: str) -> str:
    lower = path.lower()
    if any(marker in lower for marker in ("risk", "kill_switch", "stoploss", "drawdown")):
        return "risk"
    if any(marker in lower for marker in ("paper", "trade", "execution", "order")):
        return "execution"
    if any(marker in lower for marker in ("cron", "scheduler", "launchd", "service")):
        return "scheduling"
    if any(marker in lower for marker in ("okx", "market", "ohlcv", "funding", "derivatives")):
        return "market-data"
    if any(marker in lower for marker in ("promotion", "gate", "evidence", "receipt")):
        return "evidence"
    if any(marker in lower for marker in ("sidecar", "tradingagents", "alphaswarm")):
        return "sidecar"
    if any(marker in lower for marker in ("research", "factor", "signal", "strategy", "ic", "wfo")):
        return "research"
    if ".spec." in lower or "/test" in lower:
        return "testing"
    return "operations"


def infer_owner(domain: str) -> str:
    return {
        "risk": "risk-governance",
        "execution": "execution-governance",
        "scheduling": "runtime-operations",
        "market-data": "market-data",
        "evidence": "evidence-governance",
        "sidecar": "research-integrations",
        "research": "research",
        "testing": "engineering",
        "operations": "runtime-operations",
    }[domain]


def infer_lifecycle(path: str, aliases: list[str]) -> str:
    lower = path.lower()
    if "/archive/" in lower:
        return "archived"
    if lower.endswith(".plist") or "compat" in lower or "legacy" in lower:
        return "compatibility"
    if ".spec." in lower or "/test" in lower:
        return "manual"
    if Path(path).name.startswith("cron_") or aliases:
        return "active"
    if "retired" in lower:
        return "retired"
    return "manual"


def infer_safety(path: str) -> str:
    if path in PIPELINE_SAFETY_OVERRIDES:
        return PIPELINE_SAFETY_OVERRIDES[path]
    lower = path.lower()
    if any(
        marker in lower
        for marker in (
            "live_trade",
            "execute_order",
            "gated_improvement",
            "install_openalice_launchd",
            "private_auth",
        )
    ):
        return "live_forbidden"
    if "paper_trade" in lower or "paper_execution" in lower or "paper_policy" in lower:
        return "paper"
    if any(marker in lower for marker in READ_MARKERS):
        return "read_only"
    if Path(path).name.startswith(WRITE_MARKERS):
        return "artifact_write"
    return "live_forbidden"


def infer_network_policy(path: str) -> str:
    lower = path.lower()
    # "authority" is a governance term, not an authentication dependency.
    private_scope = lower.replace("authority", "")
    if any(marker in private_scope for marker in PRIVATE_NETWORK_MARKERS):
        return "declared_required"
    if any(marker in lower for marker in NETWORK_PUBLIC_MARKERS):
        return "readonly_public"
    return "denied"


def infer_timeout(path: str, safety: str) -> int:
    lower = path.lower()
    if any(marker in lower for marker in ("train", "backfill", "download", "full_")):
        return 3600
    if safety in {"artifact_write", "paper", "live_forbidden"}:
        return 900
    return 300


def load_cron_definitions(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != CRON_SCHEMA:
        raise ValueError(f"invalid Cron definition registry: {path}")
    return value


def build_pipeline_registry(
    repo_root: Path,
    cron_registry: dict[str, Any],
) -> dict[str, Any]:
    aliases = package_aliases(repo_root)
    cron_by_entrypoint: dict[str, list[dict[str, Any]]] = {}
    for job in cron_registry.get("jobs", []):
        entrypoint = job.get("entrypoint")
        if isinstance(entrypoint, str):
            cron_by_entrypoint.setdefault(entrypoint, []).append(job)

    entries = []
    seen_ids: set[str] = set()
    for path in git_script_paths(repo_root):
        entry_aliases = aliases.get(path, [])
        domain = infer_domain(path)
        safety = infer_safety(path)
        jobs = cron_by_entrypoint.get(path, [])
        item_id = stable_id(path)
        if item_id in seen_ids:
            raise ValueError(f"pipeline id collision: {item_id}")
        seen_ids.add(item_id)
        io_override = PIPELINE_IO_OVERRIDES.get(path, {})
        inputs = sorted(io_override.get("inputs", []))
        outputs = sorted(
            {
                str(job["notificationArtifact"])
                for job in jobs
                if isinstance(job.get("notificationArtifact"), str)
            }.union(io_override.get("outputs", []))
        )
        scheduler_owner = "openalice_cron_engine" if jobs else "manual"
        entries.append(
            {
                "id": item_id,
                "owner": infer_owner(domain),
                "domain": domain,
                "lifecycle": infer_lifecycle(path, entry_aliases),
                "entrypoint": path,
                "compatibilityAliases": entry_aliases,
                "inputs": inputs,
                "outputs": outputs,
                "safetyLevel": safety,
                "lock": {
                    "policy": "required"
                    if jobs or safety in {"artifact_write", "paper"}
                    else "none",
                    "key": f"pipeline:{item_id}"
                    if jobs or safety in {"artifact_write", "paper"}
                    else None,
                },
                "timeoutSeconds": infer_timeout(path, safety),
                "networkPolicy": infer_network_policy(path),
                "evidenceTtlSeconds": 86400 if jobs or entry_aliases else 604800,
                "schedulerOwner": scheduler_owner,
                "cronTaskIds": sorted(str(job["id"]) for job in jobs),
            }
        )
    return {
        "schemaVersion": PIPELINE_SCHEMA,
        "scriptRoot": "scripts",
        "entryCount": len(entries),
        "entries": entries,
    }


def normalize_source_path(raw: Any, source_repo: Path) -> str | None:
    if not isinstance(raw, str) or not raw:
        return None
    path = Path(raw)
    if path.is_absolute():
        try:
            return path.resolve().relative_to(source_repo.resolve()).as_posix()
        except ValueError as exc:
            raise ValueError(f"Cron path escapes source repository: {raw}") from exc
    return normalize_path(raw)


def import_cron_definitions(source_path: Path, source_repo: Path) -> dict[str, Any]:
    raw_bytes = source_path.read_bytes()
    source = json.loads(raw_bytes)
    raw_jobs = source.get("jobs") if isinstance(source, dict) else None
    if not isinstance(raw_jobs, list):
        raise ValueError("legacy Cron state must contain jobs")
    jobs = []
    seen: set[str] = set()
    for raw in raw_jobs:
        if not isinstance(raw, dict):
            raise ValueError("Cron job must be an object")
        job_id = raw.get("id")
        name = raw.get("name")
        if not isinstance(job_id, str) or not job_id or job_id in seen:
            raise ValueError(f"invalid or duplicate Cron job id: {job_id!r}")
        if not isinstance(name, str) or not name:
            raise ValueError(f"invalid Cron name for {job_id}")
        seen.add(job_id)
        script = raw.get("script") if isinstance(raw.get("script"), dict) else {}
        entrypoint = normalize_source_path(script.get("path"), source_repo)
        notification = normalize_source_path(script.get("notificationPath"), source_repo)
        external_dependency = any(marker in name for marker in EXTERNAL_DEPENDENCY_JOB_MARKERS)
        gated_improvement = name == "gated_improvement_candidate_daily"
        enabled = bool(raw.get("enabled", True)) and not external_dependency and not gated_improvement
        jobs.append(
            {
                "id": job_id,
                "name": name,
                "enabled": enabled,
                "initialState": (
                    "paused_external_dependency"
                    if external_dependency
                    else "disabled_pending_independent_evidence"
                    if gated_improvement
                    else "scheduled"
                ),
                "kind": raw.get("kind", "agent"),
                "schedule": raw.get("schedule"),
                "payload": raw.get("payload", ""),
                "entrypoint": entrypoint,
                "args": list(script.get("args", []))
                if isinstance(script.get("args", []), list)
                else [],
                "cwd": "." if entrypoint else None,
                "notificationArtifact": notification,
                "retryPolicy": raw.get("retryPolicy"),
                "schedulerOwner": "openalice_cron_engine",
                "operatorReceiptRequiredToCloseCircuit": True,
                "externalDependency": (
                    {
                        "id": "external_ssd",
                        "missingState": "paused_external_dependency",
                        "archiveCreationAllowed": False,
                        "localDeletionAllowed": False,
                    }
                    if external_dependency
                    else None
                ),
            }
        )
    jobs.sort(key=lambda item: item["id"])
    return {
        "schemaVersion": CRON_SCHEMA,
        "source": {
            "legacyStatePath": "data/cron/jobs.json",
            "legacyStateSha256": sha256_bytes(raw_bytes),
            "jobCount": len(jobs),
        },
        "schedulerOwner": "openalice_cron_engine",
        "retiredDependencies": [
            {
                "id": "TradingAgents-crypto",
                "status": "retired_missing_dependency",
                "legacyStatusBytesMutable": False,
            }
        ],
        "jobs": jobs,
    }


def validate_cron_registry(repo_root: Path, registry: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    jobs = registry.get("jobs")
    if not isinstance(jobs, list):
        return ["cron_jobs_missing"]
    if len(jobs) != 32:
        errors.append(f"cron_job_count:{len(jobs)}")
    ids = [job.get("id") for job in jobs if isinstance(job, dict)]
    if len(ids) != len(set(ids)):
        errors.append("cron_duplicate_id")
    for job in jobs:
        if not isinstance(job, dict):
            errors.append("cron_job_not_object")
            continue
        if "state" in job:
            errors.append(f"cron_definition_contains_state:{job.get('id')}")
        if job.get("schedulerOwner") != "openalice_cron_engine":
            errors.append(f"cron_wrong_owner:{job.get('id')}")
        entrypoint = job.get("entrypoint")
        if entrypoint is not None:
            if not isinstance(entrypoint, str) or Path(entrypoint).is_absolute():
                errors.append(f"cron_entrypoint_not_relative:{job.get('id')}")
            elif not (repo_root / entrypoint).is_file():
                errors.append(f"cron_entrypoint_missing:{job.get('id')}:{entrypoint}")
        if job.get("name") == "gated_improvement_candidate_daily" and job.get("enabled"):
            errors.append("gated_improvement_must_be_disabled")
        dependency = job.get("externalDependency")
        if dependency and (
            job.get("enabled")
            or job.get("initialState") != "paused_external_dependency"
        ):
            errors.append(f"external_dependency_not_paused:{job.get('id')}")
    return errors


def validate_pipeline_registry(
    expected: dict[str, Any],
    actual: dict[str, Any],
    cron_registry: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    if actual != expected:
        expected_paths = {item["entrypoint"] for item in expected["entries"]}
        actual_paths = {
            item.get("entrypoint")
            for item in actual.get("entries", [])
            if isinstance(item, dict)
        }
        for path in sorted(expected_paths - actual_paths):
            errors.append(f"unregistered_script:{path}")
        for path in sorted(actual_paths - expected_paths):
            errors.append(f"stale_registry_entry:{path}")
        if not errors:
            errors.append("pipeline_registry_content_mismatch")
    registered = {item["entrypoint"] for item in expected["entries"]}
    for job in cron_registry.get("jobs", []):
        entrypoint = job.get("entrypoint")
        if entrypoint and entrypoint not in registered:
            errors.append(f"cron_entrypoint_unregistered:{job.get('id')}:{entrypoint}")
    return errors


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--write", action="store_true")
    parser.add_argument("--import-cron-state", type=Path)
    parser.add_argument("--source-repo", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = args.repo_root.resolve()
    pipeline_path = repo_root / "ops" / "pipeline" / "pipeline_registry.v1.json"
    cron_path = repo_root / "ops" / "pipeline" / "cron_definitions.v1.json"

    if args.import_cron_state:
        source_repo = (args.source_repo or args.import_cron_state.resolve().parents[2]).resolve()
        cron_registry = import_cron_definitions(
            args.import_cron_state.resolve(),
            source_repo,
        )
        if not args.write:
            print(json.dumps(cron_registry, indent=2))
            return 0
        cron_path.write_text(
            json.dumps(cron_registry, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    else:
        cron_registry = load_cron_definitions(cron_path)

    expected = build_pipeline_registry(repo_root, cron_registry)
    if args.write:
        pipeline_path.write_text(
            json.dumps(expected, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    if args.check:
        actual = json.loads(pipeline_path.read_text(encoding="utf-8"))
        errors = validate_cron_registry(repo_root, cron_registry)
        errors.extend(validate_pipeline_registry(expected, actual, cron_registry))
        if errors:
            for error in errors:
                print(error, file=sys.stderr)
            return 1
        print(
            f"pipeline_registry=pass entries={expected['entryCount']} "
            f"cron_jobs={len(cron_registry['jobs'])}"
        )
    elif not args.write:
        print(json.dumps(expected, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
