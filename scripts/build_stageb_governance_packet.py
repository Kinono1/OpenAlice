#!/usr/bin/env python3
"""Build Stage-B governance packet from Stage-A and pre-continue diagnostics."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "stageb_governance_packet.v1"
DEFAULT_STAGEA = "data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json"
DEFAULT_PRECONTINUE = (
    "data/research/strategy/analysis/g3g4/precontinue_decision.v1.json"
)
DEFAULT_SENSITIVITY = (
    "data/research/strategy/analysis/g3g4/latest_threshold_sensitivity.v1.json"
)
DEFAULT_MATRIX = "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
DEFAULT_OUTPUT = (
    "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json"
)
DEFAULT_MARKDOWN = "docs/research/g3g4_stageB_governance_packet_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build Stage-B governance packet for business sign-off."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--stagea", default=DEFAULT_STAGEA, help="Stage-A gate JSON path.")
    parser.add_argument(
        "--precontinue",
        default=DEFAULT_PRECONTINUE,
        help="Pre-continue decision JSON path.",
    )
    parser.add_argument(
        "--sensitivity",
        default=DEFAULT_SENSITIVITY,
        help="Threshold sensitivity JSON path.",
    )
    parser.add_argument(
        "--matrix",
        default=DEFAULT_MATRIX,
        help="Multi-asset matrix JSON path.",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output JSON path.")
    parser.add_argument(
        "--markdown",
        default=DEFAULT_MARKDOWN,
        help="Output markdown path.",
    )
    raw_argv = list(argv if argv is not None else sys.argv[1:])
    parsed_argv = [token for token in raw_argv if token != "--"]
    return parser.parse_args(parsed_argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def resolve_path(root: Path, raw: str) -> Path:
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        return candidate
    return (root / candidate).resolve()


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def read_json_object(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"json root must be object: {path}")
    return payload


def to_float(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def find_scenario(
    sensitivity_payload: Dict[str, Any],
    scenario_id: str,
) -> Dict[str, Any]:
    scenarios = sensitivity_payload.get("scenarios", [])
    if not isinstance(scenarios, list):
        return {}
    for row in scenarios:
        if isinstance(row, dict) and row.get("scenarioId") == scenario_id:
            return row
    return {}


def build_markdown(packet: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# G3/G4 Stage-B Governance Packet")
    lines.append("")
    lines.append(f"- Generated at: `{packet.get('generatedAt')}`")
    lines.append(f"- Recommended decision: `{packet.get('decision', {}).get('recommendedOptionId')}`")
    lines.append("")
    lines.append("## Evidence Summary")
    evidence = packet.get("evidenceSummary", {})
    for key in [
        "stageAPassed",
        "stageANextStage",
        "precontinuePrimaryRecommendation",
        "matrixCompletedAssets",
        "matrixFdrQMedian",
        "prodFrozenJointPassRate",
        "researchFdr15JointPassRate",
    ]:
        lines.append(f"- {key}: `{evidence.get(key)}`")
    lines.append("")
    lines.append("## Decision Options")
    lines.append("| optionId | title | estimatedTime | successProbability | recommendationRank |")
    lines.append("| --- | --- | --- | --- | ---: |")
    for row in packet.get("options", []):
        lines.append(
            "| {id} | {title} | {time} | {prob} | {rank} |".format(
                id=row.get("optionId"),
                title=row.get("title"),
                time=row.get("estimatedTime"),
                prob=row.get("successProbability"),
                rank=row.get("recommendationRank"),
            )
        )
    lines.append("")
    lines.append("## Sign-Off Checklist")
    checklist = packet.get("signOffChecklist", [])
    for item in checklist:
        lines.append(
            "- [{state}] {item}".format(
                state="x" if bool(item.get("approved")) else " ",
                item=item.get("item"),
            )
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    stagea_path = resolve_path(repo_root, str(args.stagea))
    precontinue_path = resolve_path(repo_root, str(args.precontinue))
    sensitivity_path = resolve_path(repo_root, str(args.sensitivity))
    matrix_path = resolve_path(repo_root, str(args.matrix))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    missing = [
        str(path)
        for path in (stagea_path, precontinue_path, sensitivity_path, matrix_path)
        if not path.exists()
    ]
    if missing:
        print(
            json.dumps(
                {"status": "error", "message": "missing required inputs", "missing": missing},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    stagea_payload = read_json_object(stagea_path)
    precontinue_payload = read_json_object(precontinue_path)
    sensitivity_payload = read_json_object(sensitivity_path)
    matrix_payload = read_json_object(matrix_path)

    stagea_passed = bool((stagea_payload.get("decision") or {}).get("passed"))
    stagea_next_stage = str((stagea_payload.get("decision") or {}).get("nextStage") or "")
    precontinue_primary = str(
        (precontinue_payload.get("decision") or {}).get("primaryRecommendation") or ""
    )
    matrix_summary = matrix_payload.get("summary", {})
    if not isinstance(matrix_summary, dict):
        matrix_summary = {}

    prod = find_scenario(sensitivity_payload, "prod_frozen")
    fdr15 = find_scenario(sensitivity_payload, "research_fdr_15")
    prod_joint = to_float((prod.get("metrics") or {}).get("jointPassRate"))
    fdr15_joint = to_float((fdr15.get("metrics") or {}).get("jointPassRate"))
    fdr15_delta = to_float((fdr15.get("deltaVsProd") or {}).get("jointPassRate"))

    options = [
        {
            "optionId": "continue_current_framework",
            "title": "Continue current framework optimization",
            "estimatedTime": "1-2 months",
            "successProbability": "<20%",
            "businessRisk": "high",
            "recommendationRank": 3,
        },
        {
            "optionId": "launch_strategy_rebuild",
            "title": "Launch strategy rebuild project",
            "estimatedTime": "3-6 months",
            "successProbability": "unknown",
            "businessRisk": "medium",
            "recommendationRank": 1,
        },
        {
            "optionId": "accept_research_only_baseline",
            "title": "Accept current result as research-only baseline",
            "estimatedTime": "immediate",
            "successProbability": "n/a",
            "businessRisk": "medium-high",
            "recommendationRank": 2,
        },
    ]

    recommended_option = "launch_strategy_rebuild"
    if stagea_passed and precontinue_primary != "strategy_rebuild":
        recommended_option = "continue_current_framework"
    elif precontinue_primary == "continue_current_track_with_controls":
        recommended_option = "accept_research_only_baseline"

    decision_rationale: List[str] = []
    if not stagea_passed:
        decision_rationale.append("Stage-A gate failed under dual-condition policy.")
    if precontinue_primary == "strategy_rebuild":
        decision_rationale.append("Pre-continue recommendation is strategy_rebuild.")
    if prod_joint is not None and prod_joint <= 0:
        decision_rationale.append("Production-frozen joint pass rate remains zero.")
    if fdr15_joint is not None and fdr15_joint <= 0:
        decision_rationale.append("Research fdr=0.15 sensitivity does not unlock passing assets.")

    packet = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "inputs": {
            "stageaGateResult": str(stagea_path),
            "precontinueDecision": str(precontinue_path),
            "sensitivityReport": str(sensitivity_path),
            "matrixReport": str(matrix_path),
        },
        "evidenceSummary": {
            "stageAPassed": stagea_passed,
            "stageANextStage": stagea_next_stage,
            "precontinuePrimaryRecommendation": precontinue_primary,
            "matrixCompletedAssets": matrix_summary.get("completedAssets"),
            "matrixFdrQMedian": matrix_summary.get("fdrQMedian"),
            "prodFrozenJointPassRate": prod_joint,
            "researchFdr15JointPassRate": fdr15_joint,
            "researchFdr15DeltaVsProd": fdr15_delta,
        },
        "options": options,
        "decision": {
            "recommendedOptionId": recommended_option,
            "rationale": decision_rationale,
            "requiresBusinessSignOff": True,
            "deadline": "2026-03-07T23:59:59Z",
        },
        "signOffChecklist": [
            {
                "item": "Production threshold freeze confirmed (fdrQ<=0.10 unchanged).",
                "approved": False,
            },
            {
                "item": "Business acknowledges current framework cannot reach GO in Stage-A.",
                "approved": False,
            },
            {
                "item": "Decision approved: launch rebuild or accept research-only baseline.",
                "approved": False,
            },
        ],
    }

    write_json(output_path, packet)
    write_markdown(markdown_path, build_markdown(packet))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "recommendedOptionId": recommended_option,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
