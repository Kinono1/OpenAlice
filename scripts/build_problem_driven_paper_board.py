#!/usr/bin/env python3
"""Build a problem-driven paper board from digest, shortlist, and backlog artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "paper_board.v1"
DEFAULT_DIGEST = "data/research/strategy-watch/latest_digest.json"
DEFAULT_SHORTLIST = "data/research/fdr/frontier_shortlist.latest.v1.json"
DEFAULT_BACKLOG = "data/research/hypotheses/backlog.v1.json"
DEFAULT_OUTPUT = "data/research/strategy/governance/paper_board.v1.json"
DEFAULT_MARKDOWN = "docs/research/paper_board_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build a problem-driven paper board with action-ready buckets."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--digest", default=DEFAULT_DIGEST, help="Latest digest JSON path.")
    parser.add_argument("--shortlist", default=DEFAULT_SHORTLIST, help="Frontier shortlist JSON path.")
    parser.add_argument("--backlog", default=DEFAULT_BACKLOG, help="Hypothesis backlog JSON path.")
    parser.add_argument("--top-k", type=int, default=20, help="Max board items.")
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


def infer_problem_bucket(*, method_family: str, action_hint: str, title: str) -> str:
    hay = " ".join([method_family, action_hint, title]).lower()
    if re.search(r"\b(fdr|q-?value|bh|knockoff|e-?value|selective|multiple testing)\b", hay):
        return "statistical_control"
    if re.search(r"\b(slippage|liquidity|execution|cost|impact)\b", hay):
        return "execution_microstructure"
    if re.search(r"\b(cvar|tail|drawdown|risk)\b", hay):
        return "risk_tail_control"
    if re.search(r"\b(regime|change[- ]?point|hmm)\b", hay):
        return "regime_modeling"
    return "signal_quality"


def build_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Problem-Driven Paper Board")
    lines.append("")
    lines.append(f"- Generated at: `{payload.get('generatedAt')}`")
    lines.append(f"- Item count: `{payload.get('summary', {}).get('itemCount')}`")
    lines.append("")
    lines.append("| rank | paperId | source | bucket | methodFamily | priority | actionHint |")
    lines.append("| ---: | --- | --- | --- | --- | ---: | --- |")
    for idx, row in enumerate(payload.get("items", []), start=1):
        lines.append(
            "| {idx} | {paper} | {src} | {bucket} | {family} | {priority} | {hint} |".format(
                idx=idx,
                paper=row.get("paperId"),
                src=row.get("source"),
                bucket=row.get("problemBucket"),
                family=row.get("methodFamily"),
                priority=row.get("priority"),
                hint=row.get("actionHint"),
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
    digest_path = resolve_path(repo_root, str(args.digest))
    shortlist_path = resolve_path(repo_root, str(args.shortlist))
    backlog_path = resolve_path(repo_root, str(args.backlog))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    missing = [
        str(path)
        for path in (digest_path, shortlist_path, backlog_path)
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

    digest_payload = read_json_object(digest_path)
    shortlist_payload = read_json_object(shortlist_path)
    backlog_payload = read_json_object(backlog_path)

    top_recent = digest_payload.get("top_recent", [])
    if not isinstance(top_recent, list):
        top_recent = []
    shortlist_rows = shortlist_payload.get("shortlist", [])
    if not isinstance(shortlist_rows, list):
        shortlist_rows = []
    hypotheses = backlog_payload.get("hypotheses", [])
    if not isinstance(hypotheses, list):
        hypotheses = []

    digest_by_id: Dict[str, Dict[str, Any]] = {}
    for row in top_recent:
        if not isinstance(row, dict):
            continue
        paper_id = str(row.get("paper_id") or row.get("paperId") or "").strip()
        if paper_id:
            digest_by_id[paper_id] = row

    shortlist_by_id: Dict[str, Dict[str, Any]] = {}
    for row in shortlist_rows:
        if not isinstance(row, dict):
            continue
        paper_id = str(row.get("paperId") or "").strip()
        if paper_id:
            shortlist_by_id[paper_id] = row

    rows: List[Dict[str, Any]] = []
    for h in hypotheses:
        if not isinstance(h, dict):
            continue
        paper_id = str(h.get("paperId") or "").strip()
        if not paper_id:
            continue
        action_hint = str(h.get("actionHint") or "").strip()
        if not action_hint:
            continue
        shortlist = shortlist_by_id.get(paper_id, {})
        digest = digest_by_id.get(paper_id, {})
        title = str(h.get("title") or shortlist.get("title") or digest.get("title") or "")
        method_family = str(
            h.get("methodFamily") or shortlist.get("methodFamily") or "unknown"
        )
        priority = to_float(h.get("priority")) or 0.0
        source = str(h.get("evidenceType") or "hypothesis_backlog")
        bucket = infer_problem_bucket(
            method_family=method_family,
            action_hint=action_hint,
            title=title,
        )
        rows.append(
            {
                "paperId": paper_id,
                "title": title,
                "source": source,
                "methodFamily": method_family,
                "priority": round(priority, 6),
                "actionHint": action_hint,
                "problemBucket": bucket,
            }
        )

    rows.sort(key=lambda row: float(row.get("priority") or 0.0), reverse=True)
    top_k = max(int(args.top_k), 1)
    rows = rows[:top_k]

    bucket_counts: Dict[str, int] = {}
    for row in rows:
        bucket = str(row.get("problemBucket") or "unknown")
        bucket_counts[bucket] = bucket_counts.get(bucket, 0) + 1

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "inputs": {
            "digest": str(digest_path),
            "shortlist": str(shortlist_path),
            "backlog": str(backlog_path),
            "topK": top_k,
        },
        "summary": {
            "itemCount": len(rows),
            "bucketCounts": bucket_counts,
        },
        "items": rows,
    }

    write_json(output_path, payload)
    write_markdown(markdown_path, build_markdown(payload))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "itemCount": len(rows),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
