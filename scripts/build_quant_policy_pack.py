#!/usr/bin/env python3
"""Build a mature quant policy pack from Stage-A/Stage-B governance evidence."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "quant_policy_pack.v1"
DEFAULT_STAGEA = "data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json"
DEFAULT_STAGEB = (
    "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json"
)
DEFAULT_PRECONTINUE = (
    "data/research/strategy/analysis/g3g4/precontinue_decision.v1.json"
)
DEFAULT_OUTPUT = "data/research/strategy/governance/quant_policy_pack.v1.json"
DEFAULT_MARKDOWN = "docs/research/quant_policy_pack_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build quant policy pack from governance artifacts."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--stagea", default=DEFAULT_STAGEA, help="Stage-A result path.")
    parser.add_argument("--stageb", default=DEFAULT_STAGEB, help="Stage-B packet path.")
    parser.add_argument(
        "--precontinue",
        default=DEFAULT_PRECONTINUE,
        help="Pre-continue decision path.",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output JSON path.")
    parser.add_argument("--markdown", default=DEFAULT_MARKDOWN, help="Output markdown path.")
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


def build_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Quant Policy Pack")
    lines.append("")
    lines.append(f"- Generated at: `{payload.get('generatedAt')}`")
    lines.append(f"- Policy mode: `{payload.get('policyMode')}`")
    lines.append(
        f"- Production threshold frozen: `{payload.get('productionPolicy', {}).get('thresholdFreeze', {}).get('enabled')}`"
    )
    lines.append("")
    lines.append("## Operating Principles")
    for item in payload.get("principles", []):
        lines.append(f"- {item}")
    lines.append("")
    lines.append("## Governance Cadence")
    cadence = payload.get("governanceCadence", {})
    lines.append(f"- Internal review: `{cadence.get('internalReview')}`")
    lines.append(f"- External advisor review: `{cadence.get('advisorReview')}`")
    lines.append("")
    lines.append("## Gate Policy")
    gate = payload.get("gatePolicy", {})
    lines.append(f"- Stage-A required path: `{gate.get('stageAResultPath')}`")
    lines.append(f"- Stage-B required path: `{gate.get('stageBPacketPath')}`")
    lines.append(f"- Recommended route: `{gate.get('recommendedRoute')}`")
    lines.append("")
    lines.append("## Escalation Rules")
    for row in payload.get("escalationRules", []):
        lines.append(
            "- `{id}`: {desc}".format(
                id=row.get("ruleId"),
                desc=row.get("description"),
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
    stageb_path = resolve_path(repo_root, str(args.stageb))
    precontinue_path = resolve_path(repo_root, str(args.precontinue))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    missing = [
        str(path)
        for path in (stagea_path, stageb_path, precontinue_path)
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
    stageb_payload = read_json_object(stageb_path)
    precontinue_payload = read_json_object(precontinue_path)

    stagea_passed = bool((stagea_payload.get("decision") or {}).get("passed"))
    stagea_next_stage = str((stagea_payload.get("decision") or {}).get("nextStage") or "")
    stageb_option = str(
        (stageb_payload.get("decision") or {}).get("recommendedOptionId") or ""
    )
    stageb_deadline = str((stageb_payload.get("decision") or {}).get("deadline") or "")
    precontinue_recommendation = str(
        (precontinue_payload.get("decision") or {}).get("primaryRecommendation") or ""
    )
    matrix_fdr_median = to_float(
        ((stageb_payload.get("evidenceSummary") or {}).get("matrixFdrQMedian"))
    )

    policy_mode = "rebuild_mode" if stageb_option == "launch_strategy_rebuild" else "optimize_mode"
    recommended_route = "stageC_rebuild" if policy_mode == "rebuild_mode" else "continue_current_framework"

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "policyMode": policy_mode,
        "inputs": {
            "stageAResult": str(stagea_path),
            "stageBPacket": str(stageb_path),
            "precontinueDecision": str(precontinue_path),
        },
        "principles": [
            "Tradability and execution feasibility outrank model novelty.",
            "Production threshold policy remains frozen unless governance approves exception.",
            "No route proceeds without auditable Stage-A/Stage-B evidence artifacts.",
        ],
        "productionPolicy": {
            "thresholdFreeze": {
                "enabled": True,
                "fdrQMax": 0.10,
                "meanPboMax": 0.20,
                "meanDsrProbabilityMin": 0.50,
            },
            "exceptionPolicy": {
                "allowed": False,
                "approvalRequiredFrom": ["business_owner", "risk_owner"],
            },
        },
        "governanceCadence": {
            "internalReview": "weekly",
            "advisorReview": "monthly",
            "decisionSLAHours": 24,
        },
        "gatePolicy": {
            "stageAResultPath": str(stagea_path),
            "stageAResultPassed": stagea_passed,
            "stageANextStage": stagea_next_stage,
            "stageBPacketPath": str(stageb_path),
            "stageBRecommendedOption": stageb_option,
            "precontinuePrimaryRecommendation": precontinue_recommendation,
            "matrixFdrQMedian": matrix_fdr_median,
            "recommendedRoute": recommended_route,
            "deadline": stageb_deadline,
        },
        "escalationRules": [
            {
                "ruleId": "ESCALATE_STAGEA_FAIL",
                "description": "If Stage-A gate fails, enforce Stage-B governance sign-off before any new optimization cycle.",
            },
            {
                "ruleId": "ESCALATE_ZERO_JOINT_PASS",
                "description": "If sensitivity scenarios show zero joint pass, route to rebuild planning.",
            },
            {
                "ruleId": "ESCALATE_TRADEABILITY_BLOCK",
                "description": "If execution feasibility constraints fail, reject candidate regardless of statistical metrics.",
            },
        ],
    }

    write_json(output_path, payload)
    write_markdown(markdown_path, build_markdown(payload))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "policyMode": policy_mode,
                "recommendedRoute": recommended_route,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
