#!/usr/bin/env python3
"""Build hiring scorecard for execution+statistics hybrid quant researcher role."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence


SCHEMA_VERSION = "quant_hiring_scorecard.v1"
DEFAULT_STAGEB = "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json"
DEFAULT_OUTPUT = "data/research/strategy/governance/quant_hiring_scorecard.v1.json"
DEFAULT_MARKDOWN = "docs/research/quant_hiring_scorecard_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build quant hiring scorecard for stage-C rebuild hiring loop."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--stageb", default=DEFAULT_STAGEB, help="Stage-B packet path.")
    parser.add_argument(
        "--target-role",
        default="execution_statistics_hybrid_quant_researcher",
        help="Role identifier for hiring scorecard.",
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


def build_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Quant Hiring Scorecard")
    lines.append("")
    lines.append(f"- Generated at: `{payload.get('generatedAt')}`")
    lines.append(f"- Role: `{payload.get('roleId')}`")
    lines.append("")
    lines.append("## Evaluation Dimensions")
    lines.append("| dimension | weight | minPassScore |")
    lines.append("| --- | ---: | ---: |")
    for row in payload.get("dimensions", []):
        lines.append(
            "| {name} | {w} | {m} |".format(
                name=row.get("name"),
                w=row.get("weight"),
                m=row.get("minPassScore"),
            )
        )
    lines.append("")
    lines.append("## Hard Rejection Rules")
    for row in payload.get("hardRejectRules", []):
        lines.append(f"- {row}")
    lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    stageb_path = resolve_path(repo_root, str(args.stageb))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    if not stageb_path.exists():
        print(
            json.dumps(
                {"status": "error", "message": f"stageb packet missing: {stageb_path}"},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    stageb_payload = read_json_object(stageb_path)
    recommended = str(
        (stageb_payload.get("decision") or {}).get("recommendedOptionId") or ""
    )

    dimensions = [
        {
            "name": "statistical_inference_and_experiment_design",
            "weight": 0.30,
            "minPassScore": 3,
            "description": "FDR/PBO awareness, selection-bias handling, and robust evaluation protocol design.",
        },
        {
            "name": "execution_microstructure_and_cost_modeling",
            "weight": 0.30,
            "minPassScore": 3,
            "description": "Slippage, liquidity, impact, and tradability constraints in real execution context.",
        },
        {
            "name": "strategy_engineering_and_data_pipeline",
            "weight": 0.20,
            "minPassScore": 3,
            "description": "Ability to build reproducible research artifacts and robust pipeline tooling.",
        },
        {
            "name": "risk_governance_and_operational_discipline",
            "weight": 0.20,
            "minPassScore": 3,
            "description": "Threshold policy discipline, escalation behavior, and release gate rigor.",
        },
    ]

    interview_stages = [
        {
            "stage": "screening_call",
            "owner": "hiring_manager",
            "focus": "role-fit and communication quality",
        },
        {
            "stage": "technical_case",
            "owner": "quant_research_owner",
            "focus": "design a tradable experiment under frozen thresholds",
        },
        {
            "stage": "deep_dive_panel",
            "owner": "advisor_committee_delegate",
            "focus": "statistical rigor + execution realism tradeoff",
        },
        {
            "stage": "final_decision",
            "owner": "business_and_risk_owner",
            "focus": "hire/no-hire decision against scorecard and rejection rules",
        },
    ]

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "roleId": str(args.target_role),
        "context": {
            "stageBPacketPath": str(stageb_path),
            "stageBRecommendedOption": recommended,
            "hiringRationale": "Need execution+statistics hybrid capability to support strategy rebuild route.",
        },
        "dimensions": dimensions,
        "scoringScale": {
            "type": "integer_1_to_5",
            "description": "1=insufficient, 3=acceptable, 5=strong",
        },
        "hardRejectRules": [
            "Any dimension score below its minPassScore.",
            "Candidate proposes threshold relaxation without governance controls.",
            "Candidate cannot articulate tradability constraints in strategy evaluation.",
        ],
        "decisionRule": {
            "minWeightedScore": 3.6,
            "requireNoHardReject": True,
            "approvalRequiredFrom": ["quant_research_owner", "risk_owner"],
        },
        "interviewStages": interview_stages,
    }

    write_json(output_path, payload)
    write_markdown(markdown_path, build_markdown(payload))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "roleId": payload.get("roleId"),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
