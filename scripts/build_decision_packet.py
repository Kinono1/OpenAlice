#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from jsonschema import Draft202012Validator
except Exception:  # noqa: BLE001
    Draft202012Validator = None  # type: ignore[assignment]


EXIT_OK = 0
EXIT_MISSING_ARTIFACTS = 2
EXIT_TOOL_ERROR = 3

NON_COPY_ARTIFACT_KEYS = {"manifest", "evidencePack"}

STATE_SET = {
    "NORMAL",
    "WATCH",
    "DEGRADE_H0",
    "PAUSE_NEW_OPENS",
    "RECOVERY_SHADOW",
}

ALLOWED_TRANSITIONS = {
    "NORMAL": {"NORMAL", "WATCH", "DEGRADE_H0", "PAUSE_NEW_OPENS"},
    "WATCH": {"WATCH", "NORMAL", "DEGRADE_H0", "PAUSE_NEW_OPENS"},
    "DEGRADE_H0": {"DEGRADE_H0", "RECOVERY_SHADOW", "PAUSE_NEW_OPENS"},
    "PAUSE_NEW_OPENS": {"PAUSE_NEW_OPENS", "WATCH", "DEGRADE_H0", "RECOVERY_SHADOW"},
    "RECOVERY_SHADOW": {
        "RECOVERY_SHADOW",
        "NORMAL",
        "DEGRADE_H0",
        "PAUSE_NEW_OPENS",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build decision_packet artifacts for Go/No-Go validation."
    )
    parser.add_argument(
        "--template",
        default="docs/research/templates/go_no_go_evidence_pack.template.json",
    )
    parser.add_argument("--output-dir", default="decision_packet")
    parser.add_argument("--protocol-spec")
    parser.add_argument("--protocol-hash-file")
    parser.add_argument("--comparability-report")
    parser.add_argument("--champion-registry-snapshot")
    parser.add_argument("--release-gate-status")
    parser.add_argument("--offline-metrics")
    parser.add_argument("--live-shadow-metrics")
    parser.add_argument("--state-machine-log")
    parser.add_argument("--decision-markdown")
    parser.add_argument("--gate-checkpoints-dir")
    parser.add_argument("--experiment-verdict")
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must be a JSON object.")
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_artifact_rel_path(raw_path: str, output_dir_name: str) -> str:
    p = PurePosixPath(raw_path.replace("\\", "/"))
    parts = list(p.parts)
    if parts and parts[0] in (output_dir_name, "decision_packet"):
        parts = parts[1:]
    if not parts:
        return p.name
    return str(PurePosixPath(*parts))


def try_read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:  # noqa: BLE001
        return None


def maybe_get_number(payload: dict[str, Any], dotted_paths: list[str]) -> float | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, (int, float)):
            return float(current)
    return None


def maybe_get_bool(payload: dict[str, Any], dotted_paths: list[str]) -> bool | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, bool):
            return current
    return None


def maybe_get_string(payload: dict[str, Any], dotted_paths: list[str]) -> str | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, str) and current.strip():
            return current.strip()
    return None


def maybe_get_list(
    payload: dict[str, Any], dotted_paths: list[str]
) -> list[Any] | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, list):
            return current
    return None


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def set_metric_if_unset(
    measured: dict[str, Any], key: str, value: float | None
) -> None:
    if value is None:
        return
    existing = measured.get(key)
    if not is_number(existing):
        measured[key] = value


def read_nonempty_text(path: Path) -> str | None:
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def parse_comparability_status(payload: dict[str, Any]) -> tuple[bool, str]:
    status = maybe_get_bool(
        payload,
        [
            "allComparable",
            "all_comparable",
            "comparable",
            "summary.allComparable",
            "summary.all_comparable",
            "meta.allComparable",
        ],
    )
    if status is not None:
        return status, "derived from boolean comparability flag"

    failed_count = maybe_get_number(
        payload,
        [
            "failedCount",
            "failureCount",
            "incomparableCount",
            "nonComparableCount",
            "summary.failedCount",
            "summary.failureCount",
            "summary.incomparableCount",
        ],
    )
    if failed_count is not None:
        return failed_count <= 0.0, f"derived from failure count={failed_count}"

    failed_runs = maybe_get_list(
        payload,
        [
            "incomparableRuns",
            "failedRuns",
            "summary.incomparableRuns",
            "summary.failedRuns",
        ],
    )
    if failed_runs is not None:
        return len(
            failed_runs
        ) == 0, f"derived from failed runs count={len(failed_runs)}"

    return False, "comparability status is not inferable from report"


def normalize_state(raw: Any) -> str | None:
    if isinstance(raw, str) and raw.strip():
        value = raw.strip().upper()
        if value in STATE_SET:
            return value
    return None


def validate_state_machine_log(path: Path) -> tuple[bool, str]:
    lines = [
        line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    if not lines:
        return False, "state machine log has no events"

    current_state: str | None = None
    for idx, line in enumerate(lines, start=1):
        payload = json.loads(line)
        if not isinstance(payload, dict):
            return False, f"line {idx} is not a JSON object"
        from_state = normalize_state(
            payload.get("from")
            or payload.get("fromState")
            or payload.get("prevState")
            or payload.get("previousState")
        )
        to_state = normalize_state(
            payload.get("to")
            or payload.get("toState")
            or payload.get("nextState")
            or payload.get("state")
        )
        if to_state is None:
            return False, f"line {idx} missing target state"
        if from_state is None:
            from_state = current_state
        if from_state is not None:
            if to_state not in ALLOWED_TRANSITIONS.get(from_state, set()):
                return False, f"line {idx} invalid transition {from_state}->{to_state}"
        current_state = to_state

    return True, f"validated {len(lines)} transitions"


def validate_champion_registry_snapshot(payload: dict[str, Any]) -> tuple[bool, str]:
    schema_path = Path("docs/research/templates/champion_registry.schema.v1.json")

    if Draft202012Validator is not None and schema_path.exists():
        try:
            schema_payload = read_json(schema_path)
            validator = Draft202012Validator(
                schema_payload,
                format_checker=Draft202012Validator.FORMAT_CHECKER,
            )
            errors = sorted(
                validator.iter_errors(payload), key=lambda err: list(err.path)
            )
            if errors:
                first = errors[0]
                location = ".".join(str(part) for part in first.path) or "$"
                return False, f"schema validation failed at {location}: {first.message}"
        except Exception as exc:  # noqa: BLE001
            return False, f"schema validation error: {exc}"

    required_fields = (
        "schemaVersion",
        "version",
        "updatedAt",
        "writer",
        "protocolHash",
        "datasetSnapshotId",
        "championConfigId",
        "status",
        "fallbackConfigId",
    )
    missing = [field for field in required_fields if field not in payload]
    if missing:
        return False, f"missing required fields: {', '.join(missing)}"

    if payload.get("schemaVersion") != "v1":
        return False, "schemaVersion must be v1"
    if payload.get("fallbackConfigId") != "H0":
        return False, "fallbackConfigId must be H0"

    return True, "champion registry snapshot validated"


def upsert_hard_gate(
    hard_gate_checks: list[dict[str, Any]],
    name: str,
    passed: bool,
    reason: str,
) -> None:
    for item in hard_gate_checks:
        if isinstance(item, dict) and item.get("name") == name:
            item["passed"] = bool(passed)
            item["reason"] = reason
            return

    hard_gate_checks.append(
        {
            "name": name,
            "passed": bool(passed),
            "reason": reason,
        }
    )


def ensure_decision_shape(pack: dict[str, Any]) -> None:
    decision = pack.setdefault("decision", {})
    if not isinstance(decision, dict):
        decision = {}
        pack["decision"] = decision
    decision.setdefault("result", "NO_GO")
    decision.setdefault("mode", "hard_gate")
    decision.setdefault("verdictReasonCodes", [])
    decision.setdefault("notes", [])
    decision.setdefault("constraints", [])
    decision.setdefault("rollbackTriggers", [])
    decision.setdefault("expiryAt", None)
    decision.setdefault("maxDurationHours", None)


def collect_measured_metrics(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    measured = pack.setdefault("measured", {})
    if not isinstance(measured, dict):
        return

    offline = (
        try_read_json(copied_paths["offlineMetrics"])
        if "offlineMetrics" in copied_paths
        else None
    )
    live = (
        try_read_json(copied_paths["liveShadowMetrics14d"])
        if "liveShadowMetrics14d" in copied_paths
        else None
    )
    release = (
        try_read_json(copied_paths["releaseGateStatus"])
        if "releaseGateStatus" in copied_paths
        else None
    )

    if offline:
        set_metric_if_unset(
            measured,
            "winnerEligibleRatioRolling14d",
            maybe_get_number(
                offline,
                [
                    "winnerEligibleRatioRolling14d",
                    "strategyValidation.significancePassRatio",
                ],
            ),
        )
        set_metric_if_unset(
            measured,
            "meanPbo",
            maybe_get_number(offline, ["meanPbo", "strategyValidation.meanPbo"]),
        )
        set_metric_if_unset(
            measured,
            "meanDsrProbability",
            maybe_get_number(
                offline,
                ["meanDsrProbability", "strategyValidation.meanDsrProbability"],
            ),
        )
        set_metric_if_unset(
            measured,
            "fdrQ",
            maybe_get_number(offline, ["fdrQ", "statistics.fdrQ"]),
        )
        set_metric_if_unset(
            measured,
            "transferPassRatioRolling14d",
            maybe_get_number(
                offline,
                ["transferPassRatioRolling14d", "strategyValidation.paperPassRatio"],
            ),
        )

    if live:
        set_metric_if_unset(
            measured,
            "quoteAgeP95Ms",
            maybe_get_number(live, ["quoteAgeP95Ms", "quote_age_p95_ms"]),
        )
        set_metric_if_unset(
            measured,
            "decisionToSubmitP95Ms",
            maybe_get_number(
                live,
                ["decisionToSubmitP95Ms", "decision_to_submit_p95_ms"],
            ),
        )
        set_metric_if_unset(
            measured,
            "decisionToFirstFillP95Ms",
            maybe_get_number(
                live,
                ["decisionToFirstFillP95Ms", "decision_to_first_fill_p95_ms"],
            ),
        )

    if release:
        generated = release.get("generatedAt")
        if isinstance(generated, str):
            try:
                ts = datetime.fromisoformat(generated.replace("Z", "+00:00"))
                age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
                set_metric_if_unset(measured, "releaseGateStatusAgeHours", age_hours)
            except ValueError:
                pass


def collect_hard_gate_checks(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
    *,
    allow_legacy_missing: bool = False,
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    comparability_path = copied_paths.get("comparabilityReport")
    if comparability_path:
        comparability_payload = try_read_json(comparability_path)
        if comparability_payload is not None:
            passed, reason = parse_comparability_status(comparability_payload)
            upsert_hard_gate(
                hard_gate_checks, "comparability_all_runs_valid", passed, reason
            )
        else:
            upsert_hard_gate(
                hard_gate_checks,
                "comparability_all_runs_valid",
                False,
                "comparability report is not a valid JSON object",
            )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "comparability_all_runs_valid",
            allow_legacy_missing,
            (
                "comparability report missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "comparability report missing"
            ),
        )

    protocol_hash_path = copied_paths.get("protocolHashFile")
    protocol_spec_path = copied_paths.get("protocolSpec")
    protocol_hash = None
    protocol_hash_reason = "protocol hash missing"
    protocol_hash_ok = False
    if protocol_hash_path:
        protocol_hash = read_nonempty_text(protocol_hash_path)
        if protocol_hash:
            pack["protocolHash"] = protocol_hash
            protocol_hash_ok = True
            protocol_hash_reason = "protocol hash file present"
        else:
            protocol_hash_reason = "protocol hash file is empty"

    if protocol_hash_ok and protocol_spec_path:
        protocol_spec = try_read_json(protocol_spec_path)
        if protocol_spec is not None:
            expected_hash = maybe_get_string(
                protocol_spec,
                [
                    "runtimeProtocolHash",
                    "protocolHash",
                    "meta.runtimeProtocolHash",
                ],
            )
            if expected_hash and expected_hash != protocol_hash:
                protocol_hash_ok = False
                protocol_hash_reason = "protocol hash mismatch between protocol spec and protocol hash file"

    upsert_hard_gate(
        hard_gate_checks,
        "protocol_hash_matches_runtime",
        (protocol_hash_ok or allow_legacy_missing),
        (
            "protocol hash missing (ignored in v5 mode)"
            if allow_legacy_missing and not protocol_hash_ok
            else protocol_hash_reason
        ),
    )

    champion_path = copied_paths.get("championRegistrySnapshot")
    if champion_path:
        champion_payload = try_read_json(champion_path)
        if champion_payload is None:
            upsert_hard_gate(
                hard_gate_checks,
                "champion_registry_schema_valid",
                False,
                "champion registry snapshot is not a valid JSON object",
            )
        else:
            champion_ok, champion_reason = validate_champion_registry_snapshot(
                champion_payload
            )
            upsert_hard_gate(
                hard_gate_checks,
                "champion_registry_schema_valid",
                champion_ok,
                champion_reason,
            )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "champion_registry_schema_valid",
            allow_legacy_missing,
            (
                "champion registry snapshot missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "champion registry snapshot missing"
            ),
        )

    state_log_path = copied_paths.get("stateMachineLog")
    if state_log_path:
        try:
            state_ok, state_reason = validate_state_machine_log(state_log_path)
        except Exception as exc:  # noqa: BLE001
            state_ok = False
            state_reason = f"state machine log parsing error: {exc}"
        upsert_hard_gate(
            hard_gate_checks,
            "state_machine_drill_passed",
            state_ok,
            state_reason,
        )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "state_machine_drill_passed",
            allow_legacy_missing,
            (
                "state machine log missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "state machine log missing"
            ),
        )


def append_manifest_entry(
    manifest_entries: list[dict[str, Any]],
    key: str,
    source_path: Path,
    dest_path: Path,
    exists: bool,
    copied: bool = False,
) -> None:
    entry: dict[str, Any] = {
        "key": key,
        "sourcePath": str(source_path),
        "destinationPath": str(dest_path),
        "copied": copied,
        "exists": exists,
        "sha256": None,
        "sizeBytes": None,
    }
    if exists:
        entry["sizeBytes"] = dest_path.stat().st_size
        entry["sha256"] = sha256_file(dest_path)
    manifest_entries.append(entry)


def copy_optional_artifact(
    key: str,
    source_path: Path,
    dest_path: Path,
    manifest_entries: list[dict[str, Any]],
    missing: list[dict[str, str]],
) -> Path | None:
    if not source_path.exists():
        missing.append({"key": key, "sourcePath": str(source_path)})
        append_manifest_entry(
            manifest_entries,
            key,
            source_path,
            dest_path,
            exists=False,
            copied=False,
        )
        return None

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    copied = False
    if source_path.resolve() != dest_path.resolve():
        shutil.copy2(source_path, dest_path)
        copied = True
    append_manifest_entry(
        manifest_entries,
        key,
        source_path,
        dest_path,
        exists=True,
        copied=copied,
    )
    return dest_path


def ingest_experiment_verdict(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    verdict_path = copied_paths.get("experimentVerdict")
    if verdict_path is None:
        upsert_hard_gate(
            hard_gate_checks,
            "experiment_verdict_available",
            False,
            "experiment verdict artifact missing",
        )
        return

    verdict_payload = try_read_json(verdict_path)
    if verdict_payload is None:
        upsert_hard_gate(
            hard_gate_checks,
            "experiment_verdict_available",
            False,
            "experiment verdict is not a valid JSON object",
        )
        return

    result = maybe_get_string(verdict_payload, ["result"]) or "NO_GO"
    reason_codes = maybe_get_list(verdict_payload, ["reasonCodes"]) or []
    reason_codes_norm = [str(item) for item in reason_codes]
    aggregate = verdict_payload.get("aggregateMetrics")
    thresholds = verdict_payload.get("thresholds")
    pack["experimentVerdict"] = {
        "path": str(verdict_path),
        "schemaVersion": verdict_payload.get("schemaVersion"),
        "result": result,
        "reasonCodes": reason_codes_norm,
        "aggregateMetrics": aggregate if isinstance(aggregate, dict) else {},
        "thresholds": thresholds if isinstance(thresholds, dict) else {},
        "generatedAt": verdict_payload.get("generatedAt"),
    }

    decision = pack.get("decision")
    if isinstance(decision, dict):
        decision["result"] = result

    is_go = result in {"GO", "GO_WITH_CONSTRAINTS"}
    upsert_hard_gate(
        hard_gate_checks,
        "experiment_verdict_available",
        True,
        "experiment verdict artifact loaded",
    )
    upsert_hard_gate(
        hard_gate_checks,
        "experiment_verdict_result",
        is_go,
        f"result={result}; reasonCodes={','.join(reason_codes_norm)}",
    )


def ingest_gate_checkpoints(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    refs: list[dict[str, Any]] = []
    missing: list[str] = []
    hard_failed: list[str] = []
    for gate_id in ("G0", "G1", "G2", "G3", "G4"):
        key = f"gateCheckpoint{gate_id}"
        path = copied_paths.get(key)
        if path is None:
            missing.append(gate_id)
            upsert_hard_gate(
                hard_gate_checks,
                f"gate_checkpoint_{gate_id}",
                False,
                f"{gate_id} checkpoint missing",
            )
            continue

        payload = try_read_json(path)
        if payload is None:
            missing.append(gate_id)
            upsert_hard_gate(
                hard_gate_checks,
                f"gate_checkpoint_{gate_id}",
                False,
                f"{gate_id} checkpoint JSON invalid",
            )
            continue

        status = maybe_get_string(payload, ["status"]) or "unknown"
        hard_gate = maybe_get_bool(payload, ["hardGate"])
        reason_codes = maybe_get_list(payload, ["reasonCodes"]) or []
        reason_codes_norm = [str(item) for item in reason_codes]
        failed = status == "fail" and hard_gate is True
        if failed:
            hard_failed.append(gate_id)

        refs.append(
            {
                "gateId": gate_id,
                "path": str(path),
                "status": status,
                "hardGate": bool(hard_gate),
                "reasonCodes": reason_codes_norm,
            }
        )
        upsert_hard_gate(
            hard_gate_checks,
            f"gate_checkpoint_{gate_id}",
            not failed,
            f"status={status}; reasonCodes={','.join(reason_codes_norm)}",
        )

    upsert_hard_gate(
        hard_gate_checks,
        "gate_checkpoints_complete",
        len(missing) == 0,
        "all checkpoints available" if len(missing) == 0 else f"missing={','.join(missing)}",
    )
    upsert_hard_gate(
        hard_gate_checks,
        "gate_checkpoints_hard_pass",
        len(hard_failed) == 0,
        "all hard checkpoints passed"
        if len(hard_failed) == 0
        else f"hard-failed={','.join(hard_failed)}",
    )

    gate_dir = ""
    if len(refs) > 0:
        gate_dir = str(Path(refs[0]["path"]).parent)
    elif copied_paths.get("gateCheckpointsIndex") is not None:
        gate_dir = str(copied_paths["gateCheckpointsIndex"].parent)

    pack["gateCheckpoints"] = {
        "dir": gate_dir,
        "checkpoints": refs,
        "summary": {
            "total": len(refs),
            "missing": missing,
            "hardFailed": hard_failed,
            "overallHardPass": len(hard_failed) == 0 and len(missing) == 0,
        },
    }


def apply_v5_threshold_overlay(pack: dict[str, Any]) -> None:
    exp = pack.get("experimentVerdict")
    if not isinstance(exp, dict):
        return

    thresholds_src = exp.get("thresholds")
    metrics_src = exp.get("aggregateMetrics")
    if not isinstance(thresholds_src, dict) or not isinstance(metrics_src, dict):
        return

    thresholds: dict[str, Any] = {
        "meanPboMax": thresholds_src.get("meanPboMax"),
        "meanDsrProbabilityMin": thresholds_src.get("meanDsrProbabilityMin"),
        "fdrQMax": thresholds_src.get("fdrQMax"),
    }
    measured: dict[str, Any] = {
        "meanPbo": metrics_src.get("meanPbo"),
        "meanDsrProbability": metrics_src.get("meanDsrProbability"),
        "fdrQ": metrics_src.get("fdrQ"),
    }

    # Preserve release gate freshness check to avoid using stale gate statuses.
    current_thresholds = pack.get("thresholds")
    if isinstance(current_thresholds, dict) and "releaseGateStatusAgeHoursMax" in current_thresholds:
        thresholds["releaseGateStatusAgeHoursMax"] = current_thresholds["releaseGateStatusAgeHoursMax"]
    current_measured = pack.get("measured")
    if isinstance(current_measured, dict) and "releaseGateStatusAgeHours" in current_measured:
        measured["releaseGateStatusAgeHours"] = current_measured["releaseGateStatusAgeHours"]

    pack["thresholds"] = thresholds
    pack["measured"] = measured


def main() -> int:
    args = parse_args()
    template_path = Path(args.template)
    output_dir = Path(args.output_dir)

    try:
        template = read_json(template_path)
        artifacts = template.get("artifacts")
        if not isinstance(artifacts, dict):
            raise ValueError("template.artifacts must be an object.")

        overrides: dict[str, str | None] = {
            "protocolSpec": args.protocol_spec,
            "protocolHashFile": args.protocol_hash_file,
            "comparabilityReport": args.comparability_report,
            "championRegistrySnapshot": args.champion_registry_snapshot,
            "releaseGateStatus": args.release_gate_status,
            "offlineMetrics": args.offline_metrics,
            "liveShadowMetrics14d": args.live_shadow_metrics,
            "stateMachineLog": args.state_machine_log,
            "decisionMarkdown": args.decision_markdown,
        }

        v5_mode = bool(args.gate_checkpoints_dir or args.experiment_verdict)
        required_keys = (
            ["releaseGateStatus"]
            if v5_mode
            else [
                "protocolSpec",
                "protocolHashFile",
                "comparabilityReport",
                "championRegistrySnapshot",
                "releaseGateStatus",
                "offlineMetrics",
                "liveShadowMetrics14d",
                "stateMachineLog",
                "decisionMarkdown",
            ]
        )
        optional_missing_keys = (
            {
                "protocolSpec",
                "protocolHashFile",
                "comparabilityReport",
                "championRegistrySnapshot",
                "offlineMetrics",
                "liveShadowMetrics14d",
                "stateMachineLog",
                "decisionMarkdown",
            }
            if v5_mode
            else set()
        )
        for key in required_keys:
            if key not in artifacts and key != "releaseGateStatus":
                raise ValueError(f"template.artifacts missing required key: {key}")
            if key == "releaseGateStatus":
                release_cfg = template.get("releaseGateStatus")
                if key not in artifacts and not (
                    isinstance(release_cfg, dict)
                    and isinstance(release_cfg.get("path"), str)
                ):
                    raise ValueError(
                        "releaseGateStatus source/destination is not defined in template."
                    )

        output_dir.mkdir(parents=True, exist_ok=True)
        output_dir_name = output_dir.name
        copied_paths: dict[str, Path] = {}
        manifest_entries: list[dict[str, Any]] = []
        missing: list[dict[str, str]] = []
        missing_optional: list[dict[str, str]] = []

        for key, raw_dest in artifacts.items():
            if not isinstance(raw_dest, str):
                raise ValueError(f"artifacts.{key} must be string path.")

            rel_dest = normalize_artifact_rel_path(raw_dest, output_dir_name)
            dest_path = output_dir / rel_dest

            if key in NON_COPY_ARTIFACT_KEYS:
                continue

            override = overrides.get(key)
            if override:
                source_path = Path(override)
            elif key == "releaseGateStatus":
                release_cfg = template.get("releaseGateStatus")
                if isinstance(release_cfg, dict) and isinstance(
                    release_cfg.get("path"), str
                ):
                    source_path = Path(release_cfg["path"])
                else:
                    source_path = Path(raw_dest)
            else:
                source_path = Path(raw_dest)

            entry: dict[str, Any] = {
                "key": key,
                "sourcePath": str(source_path),
                "destinationPath": str(dest_path),
                "copied": False,
                "exists": False,
                "sha256": None,
                "sizeBytes": None,
            }

            if not source_path.exists():
                if key in optional_missing_keys:
                    missing_optional.append({"key": key, "sourcePath": str(source_path)})
                else:
                    missing.append({"key": key, "sourcePath": str(source_path)})
                manifest_entries.append(entry)
                continue

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            if source_path.resolve() != dest_path.resolve():
                shutil.copy2(source_path, dest_path)
                entry["copied"] = True
            entry["exists"] = True
            entry["sizeBytes"] = dest_path.stat().st_size
            entry["sha256"] = sha256_file(dest_path)
            manifest_entries.append(entry)
            copied_paths[key] = dest_path

        if args.experiment_verdict:
            exp_source = Path(args.experiment_verdict)
            exp_dest = output_dir / "experiment_verdict.v2.json"
            exp_copied = copy_optional_artifact(
                "experimentVerdict",
                exp_source,
                exp_dest,
                manifest_entries,
                missing,
            )
            if exp_copied:
                copied_paths["experimentVerdict"] = exp_copied

        if args.gate_checkpoints_dir:
            gate_dir = Path(args.gate_checkpoints_dir)
            for gate_id in ("G0", "G1", "G2", "G3", "G4"):
                source = gate_dir / f"{gate_id}.checkpoint.json"
                dest = output_dir / "gates" / f"{gate_id}.checkpoint.json"
                copied = copy_optional_artifact(
                    f"gateCheckpoint{gate_id}",
                    source,
                    dest,
                    manifest_entries,
                    missing,
                )
                if copied:
                    copied_paths[f"gateCheckpoint{gate_id}"] = copied
            index_source = gate_dir / "gate_checkpoints_index.v1.json"
            index_dest = output_dir / "gates" / "gate_checkpoints_index.v1.json"
            index_copied = copy_optional_artifact(
                "gateCheckpointsIndex",
                index_source,
                index_dest,
                manifest_entries,
                missing_optional,
            )
            if index_copied:
                copied_paths["gateCheckpointsIndex"] = index_copied

        evidence_pack = copy.deepcopy(template)
        evidence_pack["generatedAt"] = utc_now_iso()
        ensure_decision_shape(evidence_pack)
        collect_measured_metrics(evidence_pack, copied_paths)
        collect_hard_gate_checks(
            evidence_pack,
            copied_paths,
            allow_legacy_missing=v5_mode,
        )
        if args.experiment_verdict:
            ingest_experiment_verdict(evidence_pack, copied_paths)
        if args.gate_checkpoints_dir:
            ingest_gate_checkpoints(evidence_pack, copied_paths)
        if v5_mode:
            apply_v5_threshold_overlay(evidence_pack)

        normalized_artifacts: dict[str, str] = {}
        for key, raw_dest in artifacts.items():
            rel_dest = normalize_artifact_rel_path(str(raw_dest), output_dir_name)
            normalized_artifacts[key] = f"{output_dir_name}/{rel_dest}"
        if "experimentVerdict" in copied_paths:
            normalized_artifacts["experimentVerdict"] = (
                f"{output_dir_name}/experiment_verdict.v2.json"
            )
        for gate_id in ("G0", "G1", "G2", "G3", "G4"):
            key = f"gateCheckpoint{gate_id}"
            if key in copied_paths:
                normalized_artifacts[key] = (
                    f"{output_dir_name}/gates/{gate_id}.checkpoint.json"
                )
        if "gateCheckpointsIndex" in copied_paths:
            normalized_artifacts["gateCheckpointsIndex"] = (
                f"{output_dir_name}/gates/gate_checkpoints_index.v1.json"
            )
        evidence_pack["artifacts"] = normalized_artifacts

        release_status = evidence_pack.get("releaseGateStatus")
        if isinstance(release_status, dict):
            release_dest = normalized_artifacts.get(
                "releaseGateStatus", f"{output_dir_name}/release_gate_status.json"
            )
            release_status["path"] = release_dest
            copied_release = copied_paths.get("releaseGateStatus")
            if copied_release:
                release_payload = try_read_json(copied_release)
                if release_payload:
                    release_status["generatedAt"] = release_payload.get("generatedAt")
                    release_status["expiresAt"] = release_payload.get("expiresAt")
                    release_status["allowPaperTrading"] = release_payload.get(
                        "allowPaperTrading"
                    )
                    release_status["allowLiveTrading"] = release_payload.get(
                        "allowLiveTrading"
                    )

        evidence_pack_rel = normalize_artifact_rel_path(
            str(artifacts.get("evidencePack", f"{output_dir_name}/evidence_pack.json")),
            output_dir_name,
        )
        evidence_pack_path = output_dir / evidence_pack_rel
        evidence_pack_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_pack_path.write_text(
            f"{json.dumps(evidence_pack, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )

        manifest_rel = normalize_artifact_rel_path(
            str(artifacts.get("manifest", f"{output_dir_name}/manifest.json")),
            output_dir_name,
        )
        manifest_path = output_dir / manifest_rel
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_payload = {
            "version": "v1",
            "generatedAt": utc_now_iso(),
            "templatePath": str(template_path),
            "outputDir": str(output_dir),
            "missingCount": len(missing),
            "missing": missing,
            "missingOptionalCount": len(missing_optional),
            "missingOptional": missing_optional,
            "artifacts": manifest_entries,
            "evidencePackPath": str(evidence_pack_path),
        }
        manifest_path.write_text(
            f"{json.dumps(manifest_payload, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )

        print(
            json.dumps(
                {
                    "status": "built" if not missing else "incomplete",
                    "outputDir": str(output_dir),
                    "manifest": str(manifest_path),
                    "evidencePack": str(evidence_pack_path),
                    "missingCount": len(missing),
                    "missingOptionalCount": len(missing_optional),
                    "v5Mode": v5_mode,
                },
                ensure_ascii=False,
            )
        )
        return EXIT_OK if not missing else EXIT_MISSING_ARTIFACTS
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {"status": "tool_error", "message": str(exc)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return EXIT_TOOL_ERROR


if __name__ == "__main__":
    sys.exit(main())
