#!/usr/bin/env python3
"""Build advisor committee packet from frontier shortlist and governance artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "advisor_committee_packet.v1"
DEFAULT_SHORTLIST = "data/research/fdr/frontier_shortlist.latest.v1.json"
DEFAULT_BACKLOG = "data/research/hypotheses/backlog.v1.json"
DEFAULT_STAGEB = "data/research/strategy/analysis/g3g4/stageb_governance_packet.v1.json"
DEFAULT_MATRIX = "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
DEFAULT_OUTPUT = "data/research/strategy/governance/advisor_committee_packet.v1.json"
DEFAULT_MARKDOWN = "docs/research/advisor_committee_packet_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build advisor committee packet from latest research and governance artifacts."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--shortlist", default=DEFAULT_SHORTLIST, help="Frontier shortlist path.")
    parser.add_argument("--backlog", default=DEFAULT_BACKLOG, help="Hypothesis backlog path.")
    parser.add_argument("--stageb", default=DEFAULT_STAGEB, help="Stage-B packet path.")
    parser.add_argument("--matrix", default=DEFAULT_MATRIX, help="Latest matrix path.")
    parser.add_argument("--top-k", type=int, default=8, help="Maximum agenda methods.")
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
    lines.append("# Advisor Committee Packet")
    lines.append("")
    lines.append(f"- Generated at: `{payload.get('generatedAt')}`")
    lines.append(f"- Meeting objective: `{payload.get('meetingObjective')}`")
    lines.append(f"- Recommended option: `{payload.get('context', {}).get('stageBRecommendedOption')}`")
    lines.append("")
    lines.append("## Agenda Methods")
    lines.append("| rank | methodId | methodFamily | expectedImpactOnFdrQ | integrationCost |")
    lines.append("| ---: | --- | --- | --- | --- |")
    for idx, item in enumerate(payload.get("agendaMethods", []), start=1):
        lines.append(
            "| {idx} | {id} | {family} | {impact} | {cost} |".format(
                idx=idx,
                id=item.get("methodId"),
                family=item.get("methodFamily"),
                impact=item.get("expectedImpactOnFdrQ"),
                cost=item.get("integrationCost"),
            )
        )
    lines.append("")
    lines.append("## Key Questions")
    for row in payload.get("questionsForAdvisors", []):
        lines.append(f"- {row}")
    lines.append("")
    lines.append("## Action Owners")
    for row in payload.get("actionOwners", []):
        lines.append(
            "- {owner} ({role}): {task}".format(
                owner=row.get("owner"),
                role=row.get("role"),
                task=row.get("task"),
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
    shortlist_path = resolve_path(repo_root, str(args.shortlist))
    backlog_path = resolve_path(repo_root, str(args.backlog))
    stageb_path = resolve_path(repo_root, str(args.stageb))
    matrix_path = resolve_path(repo_root, str(args.matrix))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    missing = [
        str(path)
        for path in (shortlist_path, backlog_path, stageb_path, matrix_path)
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

    shortlist_payload = read_json_object(shortlist_path)
    backlog_payload = read_json_object(backlog_path)
    stageb_payload = read_json_object(stageb_path)
    matrix_payload = read_json_object(matrix_path)

    shortlist_rows = shortlist_payload.get("shortlist", [])
    if not isinstance(shortlist_rows, list):
        shortlist_rows = []
    hypotheses = backlog_payload.get("hypotheses", [])
    if not isinstance(hypotheses, list):
        hypotheses = []
    matrix_summary = matrix_payload.get("summary", {})
    if not isinstance(matrix_summary, dict):
        matrix_summary = {}
    stageb_recommended = str(
        (stageb_payload.get("decision") or {}).get("recommendedOptionId") or ""
    )

    by_paper_priority: Dict[str, float] = {}
    for row in hypotheses:
        if not isinstance(row, dict):
            continue
        paper_id = str(row.get("paperId") or "").strip()
        if not paper_id:
            continue
        by_paper_priority[paper_id] = to_float(row.get("priority")) or 0.0

    def shortlist_score(row: Dict[str, Any]) -> float:
        paper_id = str(row.get("paperId") or "").strip()
        base = by_paper_priority.get(paper_id, 0.0)
        citation_count = to_float(((row.get("citations") or {}).get("citationCount")))
        citation_boost = min(citation_count or 0.0, 50.0) / 50.0
        return base + citation_boost

    shortlist_typed = [row for row in shortlist_rows if isinstance(row, dict)]
    shortlist_typed.sort(key=shortlist_score, reverse=True)
    agenda_methods = shortlist_typed[: max(int(args.top_k), 1)]

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "meetingObjective": "Validate route-to-rebuild priorities and select first executable method track.",
        "inputs": {
            "shortlist": str(shortlist_path),
            "backlog": str(backlog_path),
            "stageBPacket": str(stageb_path),
            "matrixReport": str(matrix_path),
        },
        "context": {
            "stageBRecommendedOption": stageb_recommended,
            "matrixCompletedAssets": matrix_summary.get("completedAssets"),
            "matrixFdrQMedian": matrix_summary.get("fdrQMedian"),
            "matrixMeetsMinAssetsSuccess": matrix_summary.get("meetsMinAssetsSuccess"),
        },
        "agendaMethods": [
            {
                "methodId": row.get("methodId"),
                "paperId": row.get("paperId"),
                "title": row.get("title"),
                "methodFamily": row.get("methodFamily"),
                "expectedImpactOnFdrQ": row.get("expectedImpactOnFdrQ"),
                "expectedImpactOnWfo": row.get("expectedImpactOnWfo"),
                "integrationCost": row.get("integrationCost"),
                "riskLevel": row.get("riskLevel"),
                "actionHint": row.get("actionHint"),
            }
            for row in agenda_methods
        ],
        "questionsForAdvisors": [
            "Which two methods should enter the next 2-week executable card set?",
            "What is the minimum evidence needed before promoting a method into A/B core pipeline?",
            "How should selective-inference tracks be evaluated under execution-cost constraints?",
        ],
        "actionOwners": [
            {
                "owner": "internal_research_owner",
                "role": "quant_research",
                "task": "Prepare top-2 method experiment cards from agenda methods.",
            },
            {
                "owner": "risk_owner",
                "role": "risk_governance",
                "task": "Define rejection criteria for methods failing tradability checks.",
            },
            {
                "owner": "advisor_committee",
                "role": "external_advisors",
                "task": "Provide monthly route decision and conflict resolution recommendations.",
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
                "agendaMethodCount": len(payload.get("agendaMethods", [])),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
