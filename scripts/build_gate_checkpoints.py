#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from jsonschema import Draft202012Validator
except Exception:  # noqa: BLE001
    Draft202012Validator = None  # type: ignore[assignment]


EXIT_OK = 0
EXIT_POLICY_FAIL = 2
EXIT_TOOL_ERROR = 3

GATE_IDS = ("G0", "G1", "G2", "G3", "G4")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build machine-readable gate checkpoints (G0..G4) for decision packet traceability.",
    )
    parser.add_argument("--output-dir", default="data/runtime/gates")
    parser.add_argument(
        "--schema",
        default="docs/research/templates/gate_checkpoint.schema.v1.json",
    )
    parser.add_argument(
        "--env-report",
        default="data/runtime/environment_verify_report.json",
    )
    parser.add_argument(
        "--freeze-report",
        default="data/runtime/freeze_verify_report.json",
    )
    parser.add_argument(
        "--preflight-report",
        default="data/runtime/gates_preflight_report.json",
    )
    parser.add_argument(
        "--research-quality-report",
        default="data/research/reports/research_quality_report.json",
    )
    parser.add_argument(
        "--research-contract-report",
        default="data/runtime/research_contract_verify_report.json",
    )
    parser.add_argument(
        "--research-contract-report-legacy",
        default="data/runtime/research_contract_verify_outputs.json",
    )
    parser.add_argument(
        "--experiment-verdict",
        default="data/research/strategy/experiment_verdict.v2.json",
    )
    parser.add_argument(
        "--release-gate-status",
        default="data/runtime/release_gate_status.json",
    )
    parser.add_argument(
        "--paper-count-threshold",
        type=int,
        default=10,
    )
    parser.add_argument(
        "--evidence-link-rate-min",
        type=float,
        default=0.9,
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must be a JSON object.")
    return payload


def maybe_read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        return read_json_object(path)
    except Exception:  # noqa: BLE001
        return None


def resolve_contract_report_path(
    canonical: Path,
    legacy: Path,
) -> tuple[Path, bool]:
    if canonical.exists():
        return canonical, False
    if legacy.exists():
        return legacy, True
    return canonical, False


def to_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    return None


def to_number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return None


def unique_ordered(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def make_check(
    name: str,
    passed: bool,
    severity: str,
    reason_code: str,
    detail: str,
) -> dict[str, Any]:
    return {
        "name": name,
        "passed": bool(passed),
        "severity": severity,
        "reasonCode": reason_code,
        "detail": detail if detail.strip() else "-",
    }


def compute_status(checks: list[dict[str, Any]]) -> str:
    failed_hard = any(
        (item.get("severity") == "hard") and (item.get("passed") is not True)
        for item in checks
    )
    failed_warn = any(
        (item.get("severity") == "warn") and (item.get("passed") is not True)
        for item in checks
    )
    if failed_hard:
        return "fail"
    if failed_warn:
        return "warn"
    return "pass"


def build_checkpoint(
    gate_id: str,
    hard_gate: bool,
    checks: list[dict[str, Any]],
    inputs: dict[str, Any],
) -> dict[str, Any]:
    status = compute_status(checks)
    failed_items = [item for item in checks if item.get("passed") is not True]
    warned_items = [
        item
        for item in checks
        if item.get("severity") == "warn" and item.get("passed") is not True
    ]
    reason_codes = unique_ordered(
        [
            str(item.get("reasonCode"))
            for item in failed_items
            if isinstance(item.get("reasonCode"), str)
        ]
    )
    summary = {
        "total": len(checks),
        "passed": len([item for item in checks if item.get("passed") is True]),
        "failed": len(failed_items),
        "warned": len(warned_items),
    }
    return {
        "schemaVersion": "gate_checkpoint.v1",
        "gateId": gate_id,
        "generatedAt": utc_now_iso(),
        "hardGate": hard_gate,
        "status": status,
        "summary": summary,
        "checks": checks,
        "reasonCodes": reason_codes,
        "inputs": inputs,
    }


def schema_validate(
    payload: dict[str, Any],
    schema_payload: dict[str, Any] | None,
) -> list[str]:
    if schema_payload is None or Draft202012Validator is None:
        return []
    validator = Draft202012Validator(
        schema_payload,
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.path))
    out: list[str] = []
    for error in errors:
        location = ".".join(str(part) for part in error.path) or "$"
        out.append(f"{location}: {error.message}")
    return out


def gate0_checks(
    env_report_path: Path,
    freeze_report_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    env_report = maybe_read_json(env_report_path)
    freeze_report = maybe_read_json(freeze_report_path)

    env_exists = env_report is not None
    freeze_exists = freeze_report is not None
    env_passed = bool(env_report.get("passed")) if env_exists else False
    freeze_passed = bool(freeze_report.get("passed")) if freeze_exists else False

    checks = [
        make_check(
            "env_verify_report_exists",
            env_exists,
            "hard",
            "HARD_ENV_REPORT_MISSING",
            str(env_report_path),
        ),
        make_check(
            "env_verify_passed",
            env_passed,
            "hard",
            "HARD_ENV_VERIFY_FAIL",
            (
                "env:verify passed"
                if env_passed
                else f"env:verify failed or missing report ({env_report_path})"
            ),
        ),
        make_check(
            "freeze_verify_report_exists",
            freeze_exists,
            "hard",
            "HARD_FREEZE_REPORT_MISSING",
            str(freeze_report_path),
        ),
        make_check(
            "freeze_verify_passed",
            freeze_passed,
            "hard",
            "HARD_FREEZE_VERIFY_FAIL",
            (
                "freeze:verify passed"
                if freeze_passed
                else f"freeze:verify failed or missing report ({freeze_report_path})"
            ),
        ),
    ]

    inputs = {
        "envVerifyReport": {"path": str(env_report_path), "exists": env_exists},
        "freezeVerifyReport": {"path": str(freeze_report_path), "exists": freeze_exists},
    }
    return checks, inputs


def gate1_checks(preflight_report_path: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    preflight = maybe_read_json(preflight_report_path)
    exists = preflight is not None
    final_exit = int(preflight.get("finalExitCode", -1)) if exists else -1
    steps = preflight.get("steps") if exists else None
    step_items = steps if isinstance(steps, list) else []
    all_steps_pass = exists and all(
        isinstance(item, dict) and int(item.get("exitCode", 1)) == 0
        for item in step_items
    )

    checks = [
        make_check(
            "gates_preflight_report_exists",
            exists,
            "hard",
            "HARD_PREFLIGHT_REPORT_MISSING",
            str(preflight_report_path),
        ),
        make_check(
            "gates_preflight_exit_zero",
            exists and final_exit == 0,
            "hard",
            "HARD_PREFLIGHT_NONZERO",
            f"finalExitCode={final_exit}",
        ),
        make_check(
            "gates_preflight_steps_all_pass",
            all_steps_pass,
            "hard",
            "HARD_PREFLIGHT_STEP_FAILED",
            f"stepCount={len(step_items)}",
        ),
    ]

    inputs = {
        "preflightReport": {"path": str(preflight_report_path), "exists": exists},
    }
    return checks, inputs


def gate2_checks(
    quality_report_path: Path,
    contract_report_path: Path,
    paper_count_threshold: int,
    evidence_link_rate_min: float,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    quality = maybe_read_json(quality_report_path)
    contracts = maybe_read_json(contract_report_path)
    quality_exists = quality is not None
    contracts_exists = contracts is not None

    paper_count = int(quality.get("paperCount", -1)) if quality_exists else -1
    schema_pass_rate = to_number(quality.get("paperCardSchemaPassRate")) if quality_exists else None
    missing_required = (
        int(quality.get("missingRequiredFields", -1)) if quality_exists else -1
    )
    evidence_link_rate = to_number(quality.get("evidenceLinkRate")) if quality_exists else None
    overall_passed = to_bool(quality.get("overallPassed")) if quality_exists else None
    contracts_passed = bool(contracts.get("passed")) if contracts_exists else False

    checks = [
        make_check(
            "research_quality_report_exists",
            quality_exists,
            "hard",
            "HARD_RESEARCH_QUALITY_REPORT_MISSING",
            str(quality_report_path),
        ),
        make_check(
            "paper_count_threshold",
            quality_exists and paper_count >= paper_count_threshold,
            "hard",
            "HARD_PAPER_COUNT_BELOW_THRESHOLD",
            f"paperCount={paper_count}, required>={paper_count_threshold}",
        ),
        make_check(
            "paper_card_schema_pass_rate",
            quality_exists and schema_pass_rate is not None and schema_pass_rate >= 1.0,
            "hard",
            "HARD_PAPER_CARD_SCHEMA_FAIL",
            f"paperCardSchemaPassRate={schema_pass_rate}",
        ),
        make_check(
            "missing_required_fields_zero",
            quality_exists and missing_required == 0,
            "hard",
            "HARD_PAPER_CARD_MISSING_REQUIRED_FIELDS",
            f"missingRequiredFields={missing_required}",
        ),
        make_check(
            "evidence_link_rate_threshold",
            quality_exists
            and evidence_link_rate is not None
            and evidence_link_rate >= evidence_link_rate_min,
            "hard",
            "HARD_EVIDENCE_LINK_RATE_LOW",
            f"evidenceLinkRate={evidence_link_rate}, required>={evidence_link_rate_min}",
        ),
        make_check(
            "research_quality_overall_passed",
            quality_exists and overall_passed is True,
            "hard",
            "HARD_RESEARCH_QUALITY_GATE_FAILED",
            f"overallPassed={overall_passed}",
        ),
        make_check(
            "research_contract_verify_report_exists",
            contracts_exists,
            "hard",
            "HARD_RESEARCH_CONTRACT_REPORT_MISSING",
            str(contract_report_path),
        ),
        make_check(
            "research_contracts_passed",
            contracts_passed,
            "hard",
            "HARD_RESEARCH_CONTRACT_VALIDATION_FAILED",
            f"contracts.passed={contracts.get('passed') if contracts_exists else None}",
        ),
    ]

    inputs = {
        "researchQualityReport": {"path": str(quality_report_path), "exists": quality_exists},
        "researchContractReport": {"path": str(contract_report_path), "exists": contracts_exists},
    }
    return checks, inputs


def gate3_checks(
    experiment_verdict_path: Path,
    release_gate_status_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    verdict = maybe_read_json(experiment_verdict_path)
    release_status = maybe_read_json(release_gate_status_path)
    verdict_exists = verdict is not None
    release_exists = release_status is not None

    schema_ok = verdict_exists and verdict.get("schemaVersion") == "experiment_verdict.v2"
    result = str(verdict.get("result")) if verdict_exists else "MISSING"
    thresholds = verdict.get("thresholds") if verdict_exists else {}
    metrics = verdict.get("aggregateMetrics") if verdict_exists else {}
    thresholds_obj = thresholds if isinstance(thresholds, dict) else {}
    metrics_obj = metrics if isinstance(metrics, dict) else {}

    mean_pbo = to_number(metrics_obj.get("meanPbo"))
    mean_dsr = to_number(metrics_obj.get("meanDsrProbability"))
    fdr_q = to_number(metrics_obj.get("fdrQ"))
    mean_pbo_max = to_number(thresholds_obj.get("meanPboMax"))
    mean_dsr_min = to_number(thresholds_obj.get("meanDsrProbabilityMin"))
    fdr_q_max = to_number(thresholds_obj.get("fdrQMax"))

    mean_pbo_ok = (
        mean_pbo is not None and mean_pbo_max is not None and mean_pbo <= mean_pbo_max
    )
    mean_dsr_ok = (
        mean_dsr is not None and mean_dsr_min is not None and mean_dsr >= mean_dsr_min
    )
    fdr_q_ok = fdr_q is not None and fdr_q_max is not None and fdr_q <= fdr_q_max

    allow_live = (
        bool(release_status.get("allowLiveTrading")) if release_exists else False
    )

    checks = [
        make_check(
            "experiment_verdict_exists",
            verdict_exists,
            "hard",
            "HARD_EXPERIMENT_VERDICT_MISSING",
            str(experiment_verdict_path),
        ),
        make_check(
            "experiment_verdict_schema_valid",
            schema_ok,
            "hard",
            "HARD_EXPERIMENT_VERDICT_SCHEMA_INVALID",
            f"schemaVersion={verdict.get('schemaVersion') if verdict_exists else None}",
        ),
        make_check(
            "experiment_result_go",
            verdict_exists and result == "GO",
            "hard",
            "HARD_EXPERIMENT_NO_GO",
            f"result={result}",
        ),
        make_check(
            "mean_pbo_threshold",
            mean_pbo_ok,
            "hard",
            "HARD_MEAN_PBO_THRESHOLD_FAIL",
            f"meanPbo={mean_pbo}, threshold={mean_pbo_max}",
        ),
        make_check(
            "mean_dsr_probability_threshold",
            mean_dsr_ok,
            "hard",
            "HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL",
            f"meanDsrProbability={mean_dsr}, threshold={mean_dsr_min}",
        ),
        make_check(
            "fdr_q_threshold",
            fdr_q_ok,
            "hard",
            "HARD_FDR_THRESHOLD_FAIL",
            f"fdrQ={fdr_q}, threshold={fdr_q_max}",
        ),
        make_check(
            "release_gate_status_exists",
            release_exists,
            "hard",
            "HARD_RELEASE_GATE_STATUS_MISSING",
            str(release_gate_status_path),
        ),
        make_check(
            "release_gate_allows_live",
            release_exists and allow_live,
            "hard",
            "HARD_RELEASE_GATE_BLOCKED",
            (
                "allowLiveTrading=true"
                if release_exists and allow_live
                else f"allowLiveTrading={release_status.get('allowLiveTrading') if release_exists else None}"
            ),
        ),
    ]

    inputs = {
        "experimentVerdict": {"path": str(experiment_verdict_path), "exists": verdict_exists},
        "releaseGateStatus": {"path": str(release_gate_status_path), "exists": release_exists},
    }
    return checks, inputs


def gate4_checks(
    previous_checkpoints: dict[str, dict[str, Any]],
    experiment_verdict_path: Path,
    release_gate_status_path: Path,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    blocking_gates = [
        gate_id
        for gate_id in ("G0", "G1", "G2", "G3")
        if previous_checkpoints.get(gate_id, {}).get("status") == "fail"
    ]
    verdict_exists = experiment_verdict_path.exists()
    release_exists = release_gate_status_path.exists()

    checks = [
        make_check(
            "upstream_hard_gates_passed",
            len(blocking_gates) == 0,
            "hard",
            "HARD_UPSTREAM_GATE_FAILED",
            (
                "all upstream gates passed"
                if len(blocking_gates) == 0
                else f"failed gates={','.join(blocking_gates)}"
            ),
        ),
        make_check(
            "decision_inputs_experiment_verdict_present",
            verdict_exists,
            "hard",
            "HARD_EXPERIMENT_VERDICT_MISSING",
            str(experiment_verdict_path),
        ),
        make_check(
            "decision_inputs_release_gate_status_present",
            release_exists,
            "hard",
            "HARD_RELEASE_GATE_STATUS_MISSING",
            str(release_gate_status_path),
        ),
    ]

    inputs = {
        "checkpointSources": {
            gate_id: previous_checkpoints.get(gate_id, {}).get("status")
            for gate_id in ("G0", "G1", "G2", "G3")
        },
        "experimentVerdictPath": str(experiment_verdict_path),
        "releaseGateStatusPath": str(release_gate_status_path),
    }
    return checks, inputs


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir)
    schema_path = Path(args.schema)

    try:
        schema_payload = read_json_object(schema_path) if schema_path.exists() else None
        contract_report_canonical = Path(args.research_contract_report)
        contract_report_legacy = Path(args.research_contract_report_legacy)
        contract_report_used, contract_report_fallback_used = resolve_contract_report_path(
            contract_report_canonical,
            contract_report_legacy,
        )

        g0_checks, g0_inputs = gate0_checks(Path(args.env_report), Path(args.freeze_report))
        checkpoint_g0 = build_checkpoint("G0", True, g0_checks, g0_inputs)

        g1_checks, g1_inputs = gate1_checks(Path(args.preflight_report))
        checkpoint_g1 = build_checkpoint("G1", True, g1_checks, g1_inputs)

        g2_checks, g2_inputs = gate2_checks(
            Path(args.research_quality_report),
            contract_report_used,
            args.paper_count_threshold,
            args.evidence_link_rate_min,
        )
        g2_inputs["researchContractReport"]["canonicalPath"] = str(contract_report_canonical)
        g2_inputs["researchContractReport"]["legacyPath"] = str(contract_report_legacy)
        g2_inputs["researchContractReport"]["pathUsed"] = str(contract_report_used)
        g2_inputs["researchContractReport"]["fallbackUsed"] = contract_report_fallback_used
        checkpoint_g2 = build_checkpoint("G2", True, g2_checks, g2_inputs)

        g3_checks, g3_inputs = gate3_checks(
            Path(args.experiment_verdict),
            Path(args.release_gate_status),
        )
        checkpoint_g3 = build_checkpoint("G3", True, g3_checks, g3_inputs)

        partial = {
            "G0": checkpoint_g0,
            "G1": checkpoint_g1,
            "G2": checkpoint_g2,
            "G3": checkpoint_g3,
        }
        g4_checks, g4_inputs = gate4_checks(
            partial,
            Path(args.experiment_verdict),
            Path(args.release_gate_status),
        )
        checkpoint_g4 = build_checkpoint("G4", True, g4_checks, g4_inputs)

        checkpoints = {
            "G0": checkpoint_g0,
            "G1": checkpoint_g1,
            "G2": checkpoint_g2,
            "G3": checkpoint_g3,
            "G4": checkpoint_g4,
        }

        schema_failures: dict[str, list[str]] = {}
        for gate_id in GATE_IDS:
            payload = checkpoints[gate_id]
            errors = schema_validate(payload, schema_payload)
            if errors:
                schema_failures[gate_id] = errors
                payload["status"] = "fail"
                payload["checks"].append(
                    make_check(
                        "schema_validation",
                        False,
                        "hard",
                        "HARD_CHECKPOINT_SCHEMA_INVALID",
                        "; ".join(errors),
                    )
                )
                payload["reasonCodes"] = unique_ordered(
                    payload.get("reasonCodes", []) + ["HARD_CHECKPOINT_SCHEMA_INVALID"]
                )
                payload["summary"] = {
                    "total": len(payload["checks"]),
                    "passed": len(
                        [item for item in payload["checks"] if item.get("passed") is True]
                    ),
                    "failed": len(
                        [item for item in payload["checks"] if item.get("passed") is not True]
                    ),
                    "warned": len(
                        [
                            item
                            for item in payload["checks"]
                            if item.get("severity") == "warn"
                            and item.get("passed") is not True
                        ]
                    ),
                }

        output_dir.mkdir(parents=True, exist_ok=True)
        checkpoint_refs: list[dict[str, Any]] = []
        for gate_id in GATE_IDS:
            out_path = output_dir / f"{gate_id}.checkpoint.json"
            write_json(out_path, checkpoints[gate_id])
            checkpoint_refs.append(
                {
                    "gateId": gate_id,
                    "path": str(out_path),
                    "status": checkpoints[gate_id]["status"],
                    "hardGate": checkpoints[gate_id]["hardGate"],
                    "reasonCodes": checkpoints[gate_id]["reasonCodes"],
                }
            )

        hard_fail_gates = [
            gate_id
            for gate_id in GATE_IDS
            if checkpoints[gate_id]["hardGate"] and checkpoints[gate_id]["status"] == "fail"
        ]
        index_payload = {
            "schemaVersion": "gate_checkpoint_index.v1",
            "generatedAt": utc_now_iso(),
            "outputDir": str(output_dir),
            "overallHardPass": len(hard_fail_gates) == 0,
            "hardFailGates": hard_fail_gates,
            "schemaValidationFailures": schema_failures,
            "checkpoints": checkpoint_refs,
            "contractReportPathCanonical": str(contract_report_canonical),
            "contractReportPathLegacy": str(contract_report_legacy),
            "contractReportPathUsed": str(contract_report_used),
            "contractReportFallbackUsed": contract_report_fallback_used,
        }
        write_json(output_dir / "gate_checkpoints_index.v1.json", index_payload)

        print(
            json.dumps(
                {
                    "status": "pass" if len(hard_fail_gates) == 0 else "policy_fail",
                    "outputDir": str(output_dir),
                    "hardFailGates": hard_fail_gates,
                    "checkpoints": checkpoint_refs,
                },
                ensure_ascii=False,
            )
        )
        # Building checkpoints should be non-blocking for downstream decision assembly.
        # Hard failures are encoded in payload status/reason codes, not process exit code.
        return EXIT_OK
    except Exception as exc:  # noqa: BLE001
        output_dir.mkdir(parents=True, exist_ok=True)
        fallback = {
            "schemaVersion": "gate_checkpoint_index.v1",
            "generatedAt": utc_now_iso(),
            "status": "tool_error",
            "error": str(exc),
        }
        write_json(output_dir / "gate_checkpoints_index.v1.json", fallback)
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
