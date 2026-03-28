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

SCHEMA_MAP = {
    "research_digest.v2": "research_digest.schema.v2.json",
    "hypothesis_backlog.v1": "hypothesis_backlog.schema.v1.json",
    "citation_network.v1": "citation_network.schema.v1.json",
    "pdf_extract_report.v1": "pdf_extract_report.schema.v1.json",
    "local_param_search_report.v1": "local_param_search_report.schema.v1.json",
    "fdr_frontier_shortlist.v1": "fdr_frontier_shortlist.schema.v1.json",
    "fdr_bottleneck_report.v1": "fdr_bottleneck_report.schema.v1.json",
    "multi_asset_matrix.v1": "multi_asset_matrix.schema.v1.json",
    "threshold_sensitivity.v1": "threshold_sensitivity.schema.v1.json",
    "precontinue_decision.v1": "precontinue_decision.schema.v1.json",
    "stagea_gate_result.v1": "stagea_gate_result.schema.v1.json",
    "stageb_governance_packet.v1": "stageb_governance_packet.schema.v1.json",
    "quant_policy_pack.v1": "quant_policy_pack.schema.v1.json",
    "advisor_committee_packet.v1": "advisor_committee_packet.schema.v1.json",
    "quant_hiring_scorecard.v1": "quant_hiring_scorecard.schema.v1.json",
    "paper_board.v1": "paper_board.schema.v1.json",
    "plan_switchboard.v1": "plan_switchboard.schema.v1.json",
    "paper_card.v2": "paper_card.schema.v2.json",
    "evidence_graph.v1": "evidence_graph.schema.v1.json",
    "gate_checkpoint.v1": "gate_checkpoint.schema.v1.json",
    "gate_checkpoint_index.v1": "gate_checkpoint_index.schema.v1.json",
    "experiment_verdict.v2": "experiment_verdict.schema.v2.json",
    "provisional_baseline.v1": "provisional_baseline.schema.v1.json",
}

FALLBACK_REQUIRED_FIELDS = {
    "research_digest.v2": [
        "schemaVersion",
        "generated_at",
        "run_id",
        "query_count",
        "query_profile",
        "queries",
        "lookback_days",
        "fetched_papers",
        "filtered_papers",
        "new_papers",
        "cards_source_mode",
        "cards_fallback_used",
        "card_candidate_count",
        "errors",
        "top_new",
    ],
    "hypothesis_backlog.v1": [
        "schemaVersion",
        "generatedAt",
        "hypotheses",
    ],
    "citation_network.v1": [
        "schemaVersion",
        "generatedAt",
        "sourceDigest",
        "nodes",
        "edges",
        "stats",
    ],
    "pdf_extract_report.v1": [
        "schemaVersion",
        "generatedAt",
        "runId",
        "digestPath",
        "outDir",
        "config",
        "summary",
        "papers",
        "errors",
    ],
    "local_param_search_report.v1": [
        "schemaVersion",
        "generatedAt",
        "repoRoot",
        "mode",
        "target",
        "constraint",
        "wfoProfile",
        "plan",
        "focusRange",
        "aggressive",
        "seed",
        "fdrMethod",
        "fdrStoreyLambda",
        "trialsRequested",
        "trialCount",
        "baselineFdrQ",
        "thresholdBreakTarget",
        "fdrMax",
        "pboMax",
        "fdrWeight",
        "pboWeight",
        "pboThresholdTarget",
        "bestFdrQ",
        "bestMeanPbo",
        "improvementAbs",
        "improvementPct",
        "thresholdBreak",
        "pboThresholdBreak",
        "feasibleCount",
        "bestTrialConstraintSatisfied",
        "bestTrial",
        "top10",
        "trials",
    ],
    "best_trend_triplet.v1": [
        "schemaVersion",
        "generatedAt",
        "sourceReport",
        "trialId",
        "trialLabel",
        "anchorType",
        "candidateCount",
        "metrics",
        "params",
        "candidates",
        "searchSummary",
    ],
    "fdr_frontier_shortlist.v1": [
        "schemaVersion",
        "generatedAt",
        "generatedDate",
        "inputs",
        "shortlist",
    ],
    "fdr_bottleneck_report.v1": [
        "schemaVersion",
        "generatedAt",
        "source",
        "summary",
        "latest",
        "runs",
    ],
    "multi_asset_matrix.v1": [
        "schemaVersion",
        "generatedAt",
        "runId",
        "executeMode",
        "source",
        "summary",
        "assets",
    ],
    "threshold_sensitivity.v1": [
        "schemaVersion",
        "generatedAt",
        "source",
        "scenarios",
    ],
    "precontinue_decision.v1": [
        "schemaVersion",
        "generatedAt",
        "inputs",
        "questionAnswers",
        "rules",
        "decision",
    ],
    "stagea_gate_result.v1": [
        "schemaVersion",
        "generatedAt",
        "source",
        "thresholds",
        "summary",
        "assets",
        "decision",
    ],
    "stageb_governance_packet.v1": [
        "schemaVersion",
        "generatedAt",
        "inputs",
        "evidenceSummary",
        "options",
        "decision",
        "signOffChecklist",
    ],
    "quant_policy_pack.v1": [
        "schemaVersion",
        "generatedAt",
        "policyMode",
        "inputs",
        "principles",
        "productionPolicy",
        "governanceCadence",
        "gatePolicy",
        "escalationRules",
    ],
    "advisor_committee_packet.v1": [
        "schemaVersion",
        "generatedAt",
        "meetingObjective",
        "inputs",
        "context",
        "agendaMethods",
        "questionsForAdvisors",
        "actionOwners",
    ],
    "quant_hiring_scorecard.v1": [
        "schemaVersion",
        "generatedAt",
        "roleId",
        "context",
        "dimensions",
        "scoringScale",
        "hardRejectRules",
        "decisionRule",
        "interviewStages",
    ],
    "paper_board.v1": [
        "schemaVersion",
        "generatedAt",
        "inputs",
        "summary",
        "items",
    ],
    "plan_switchboard.v1": [
        "schemaVersion",
        "generatedAt",
        "mode",
        "windowDays",
        "weights",
        "plans",
        "streaks",
        "decision",
        "source",
    ],
    "paper_card.v2": [
        "schemaVersion",
        "paperId",
        "title",
        "venue",
        "source",
        "targets",
        "sections",
        "claims",
        "evidence",
        "trace",
    ],
    "evidence_graph.v1": [
        "schemaVersion",
        "generatedAt",
        "sourceCardsDir",
        "nodes",
        "edges",
        "stats",
    ],
    "gate_checkpoint.v1": [
        "schemaVersion",
        "gateId",
        "generatedAt",
        "hardGate",
        "status",
        "summary",
        "checks",
        "reasonCodes",
        "inputs",
    ],
    "gate_checkpoint_index.v1": [
        "schemaVersion",
        "generatedAt",
        "outputDir",
        "overallHardPass",
        "hardFailGates",
        "schemaValidationFailures",
        "checkpoints",
    ],
    "experiment_verdict.v2": [
        "schemaVersion",
        "generatedAt",
        "result",
        "reasonCodes",
        "thresholds",
        "aggregateMetrics",
        "candidates",
        "outputPaths",
    ],
    "provisional_baseline.v1": [
        "schemaVersion",
        "generatedAt",
        "status",
        "summary",
        "thresholds",
        "source",
        "notes",
    ],
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate research JSON outputs against contract schemas."
    )
    parser.add_argument(
        "--schema-dir",
        default="docs/research/templates",
        help="Directory containing contract schema files.",
    )
    parser.add_argument(
        "--inputs",
        nargs="*",
        default=[
            "docs/research/templates/examples",
            "data/research/paper_cards",
            "data/research/evidence",
            "data/research/strategy",
            "data/runtime/gates",
        ],
        help="Files or directories to scan for JSON payloads.",
    )
    parser.add_argument(
        "--output",
        default="data/runtime/research_contract_verify_report.json",
        help="Path to write machine-readable report.",
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
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


def expand_json_targets(paths: list[str]) -> tuple[list[Path], list[str]]:
    targets: list[Path] = []
    warnings: list[str] = []
    seen: set[Path] = set()

    for raw in paths:
        path = Path(raw)
        if not path.exists():
            warnings.append(f"input path missing: {path}")
            continue
        if path.is_file():
            if path.suffix.lower() == ".json" and path not in seen:
                targets.append(path)
                seen.add(path)
            continue
        for candidate in sorted(path.rglob("*.json")):
            if candidate not in seen:
                targets.append(candidate)
                seen.add(candidate)
    return targets, warnings


def read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("JSON payload must be an object.")
    return payload


def validate_with_schema(
    payload: dict[str, Any],
    schema_payload: dict[str, Any] | None,
    schema_version: str,
) -> list[str]:
    if Draft202012Validator is None or schema_payload is None:
        required_fields = FALLBACK_REQUIRED_FIELDS.get(schema_version, [])
        failures: list[str] = []
        for field in required_fields:
            if field not in payload:
                failures.append(f"missing required field: {field}")
        return failures

    validator = Draft202012Validator(
        schema_payload,
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )
    errors = sorted(validator.iter_errors(payload), key=lambda err: list(err.path))
    formatted: list[str] = []
    for error in errors:
        location = ".".join(str(part) for part in error.path) or "$"
        formatted.append(f"{location}: {error.message}")
    return formatted


def main() -> int:
    args = parse_args()
    schema_dir = Path(args.schema_dir)
    output_path = Path(args.output)

    try:
        schema_cache: dict[str, dict[str, Any]] = {}
        for schema_version, schema_file in SCHEMA_MAP.items():
            schema_path = schema_dir / schema_file
            if not schema_path.exists():
                raise FileNotFoundError(f"schema missing: {schema_path}")
            schema_payload = read_json_object(schema_path)
            schema_cache[schema_version] = schema_payload

        targets, input_warnings = expand_json_targets(args.inputs)
        file_reports: list[dict[str, Any]] = []

        for path in targets:
            rel_path = str(path)
            try:
                payload = read_json_object(path)
                schema_version = payload.get("schemaVersion")
                if not isinstance(schema_version, str):
                    file_reports.append(
                        {
                            "path": rel_path,
                            "passed": False,
                            "schemaVersion": None,
                            "errors": ["missing schemaVersion"],
                        }
                    )
                    continue

                schema_payload = schema_cache.get(schema_version)
                if schema_payload is None and schema_version not in FALLBACK_REQUIRED_FIELDS:
                    file_reports.append(
                        {
                            "path": rel_path,
                            "passed": False,
                            "schemaVersion": schema_version,
                            "errors": [f"unsupported schemaVersion: {schema_version}"],
                        }
                    )
                    continue

                errors = validate_with_schema(
                    payload,
                    schema_payload,
                    schema_version,
                )
                file_reports.append(
                    {
                        "path": rel_path,
                        "passed": len(errors) == 0,
                        "schemaVersion": schema_version,
                        "errors": errors,
                    }
                )
            except Exception as exc:  # noqa: BLE001
                file_reports.append(
                    {
                        "path": rel_path,
                        "passed": False,
                        "schemaVersion": None,
                        "errors": [f"tool_error: {exc}"],
                    }
                )

        failed = [report for report in file_reports if not report["passed"]]
        report = {
            "passed": len(failed) == 0,
            "generatedAt": utc_now_iso(),
            "schemaDir": str(schema_dir),
            "inputs": args.inputs,
            "inputWarnings": input_warnings,
            "summary": {
                "totalFiles": len(file_reports),
                "passedFiles": len(file_reports) - len(failed),
                "failedFiles": len(failed),
            },
            "files": file_reports,
        }

        # Empty input set is a valid no-op scenario.
        if len(file_reports) == 0:
            report["passed"] = True
            report["summary"]["emptyInput"] = True

        write_json(output_path, report)
        return EXIT_OK if report["passed"] else EXIT_POLICY_FAIL
    except Exception as exc:  # noqa: BLE001
        write_json(
            output_path,
            {
                "passed": False,
                "generatedAt": utc_now_iso(),
                "schemaDir": str(schema_dir),
                "failures": [f"tool_error: {exc}"],
            },
        )
        return EXIT_TOOL_ERROR


if __name__ == "__main__":
    sys.exit(main())
