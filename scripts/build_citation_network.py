#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DEFAULT_DIGEST = "data/research/strategy-watch/latest_digest.json"
DEFAULT_OUTPUT = "data/research/literature/citations/latest_citation_network.v1.json"
OPENALEX_WORK_ID_PATTERN = re.compile(r"^[Ww]\d+$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build citation_network.v1 from strategy watch digest papers."
    )
    parser.add_argument(
        "--digest",
        default=DEFAULT_DIGEST,
        help="Path to digest JSON that contains top_new/top_recent papers.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output path for citation network JSON.",
    )
    parser.add_argument(
        "--include-external-refs",
        action="store_true",
        help="Include placeholder nodes/edges for references missing from top_new.",
    )
    argv = [arg for arg in sys.argv[1:] if arg != "--"]
    return parser.parse_args(argv)


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("digest payload must be a JSON object")
    return payload


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def normalize_openalex_work_id(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if OPENALEX_WORK_ID_PATTERN.fullmatch(text):
        return text.upper()

    parse_target = text if "://" in text else f"https://{text}"
    parsed = urllib.parse.urlparse(parse_target)
    host = parsed.netloc.strip().lower()
    if host.startswith("www."):
        host = host[4:]
    if host != "openalex.org":
        return None

    for segment in [seg.strip() for seg in parsed.path.split("/")]:
        if OPENALEX_WORK_ID_PATTERN.fullmatch(segment):
            return segment.upper()
    return None


def normalize_paper_id(value: Any) -> str | None:
    if isinstance(value, str):
        paper_id = value.strip()
        if not paper_id:
            return None
        openalex_work_id = normalize_openalex_work_id(paper_id)
        if openalex_work_id:
            return openalex_work_id
        return paper_id
    if isinstance(value, (int, float)):
        paper_id = str(value).strip()
        return paper_id or None
    return None


def to_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str):
        candidate = value.strip()
        if not candidate:
            return None
        try:
            return int(candidate)
        except ValueError:
            return None
    return None


def to_optional_str(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text if text else None


def extract_reference_id(reference: Any) -> str | None:
    if isinstance(reference, str):
        return normalize_paper_id(reference)
    if not isinstance(reference, dict):
        return None

    for key in ("paper_id", "paperId", "id", "ref_id", "reference_id"):
        paper_id = normalize_paper_id(reference.get(key))
        if paper_id:
            return paper_id
    return None


def extract_reference_title(reference: Any) -> str | None:
    if not isinstance(reference, dict):
        return None
    for key in ("title", "paper_title", "name"):
        title = to_optional_str(reference.get(key))
        if title:
            return title
    return None


def extract_reference_source(reference: Any) -> str | None:
    if not isinstance(reference, dict):
        return None
    return to_optional_str(reference.get("source"))


def extract_reference_citation_count(reference: Any) -> int | None:
    if not isinstance(reference, dict):
        return None
    for key in ("citation_count", "citationCount"):
        citation_count = to_optional_int(reference.get(key))
        if citation_count is not None:
            return citation_count
    return None


def build_citation_network(
    *,
    digest_payload: dict[str, Any],
    source_digest: str,
    include_external_refs: bool,
) -> dict[str, Any]:
    raw_top_recent = digest_payload.get("top_recent")
    top_recent = raw_top_recent if isinstance(raw_top_recent, list) else []
    raw_top_new = digest_payload.get("top_new")
    top_new = raw_top_new if isinstance(raw_top_new, list) else []
    # Use recent papers as the primary network backbone, then append top_new as a
    # priority overlay. This avoids tiny citation graphs when top_new is sparse.
    seed_rows: list[Any] = list(top_recent) + list(top_new)
    if not seed_rows:
        seed_rows = list(top_new) if top_new else list(top_recent)

    nodes_by_id: dict[str, dict[str, Any]] = {}
    node_order: list[str] = []
    paper_rows: list[tuple[str, dict[str, Any]]] = []

    for item in seed_rows:
        if not isinstance(item, dict):
            continue
        paper_id = normalize_paper_id(item.get("paper_id"))
        if not paper_id:
            continue

        paper_rows.append((paper_id, item))
        existing = nodes_by_id.get(paper_id)

        node_payload = {
            "paperId": paper_id,
            "title": to_optional_str(item.get("title")) or paper_id,
            "source": to_optional_str(item.get("source")),
            "citationCount": to_optional_int(item.get("citation_count")),
            "isExternal": False,
        }

        if existing is None:
            nodes_by_id[paper_id] = node_payload
            node_order.append(paper_id)
            continue

        # Keep deterministic first-seen ordering and fill only missing fields.
        if existing.get("title") in (None, "", existing.get("paperId")) and node_payload["title"]:
            existing["title"] = node_payload["title"]
        if existing.get("source") is None and node_payload["source"] is not None:
            existing["source"] = node_payload["source"]
        if existing.get("citationCount") is None and node_payload["citationCount"] is not None:
            existing["citationCount"] = node_payload["citationCount"]
        existing["isExternal"] = False

    internal_ids = {paper_id for paper_id, _ in paper_rows}
    edges: list[dict[str, str]] = []
    edge_keys: set[tuple[str, str, str]] = set()

    for source_id, item in paper_rows:
        raw_refs = item.get("references")
        references = raw_refs if isinstance(raw_refs, list) else []
        for reference in references:
            target_id = extract_reference_id(reference)
            if not target_id or target_id == source_id:
                continue

            target_is_internal = target_id in internal_ids
            if not target_is_internal and not include_external_refs:
                continue

            if not target_is_internal and include_external_refs:
                existing_target = nodes_by_id.get(target_id)
                title = extract_reference_title(reference) or f"External reference {target_id}"
                source = extract_reference_source(reference)
                citation_count = extract_reference_citation_count(reference)
                if existing_target is None:
                    nodes_by_id[target_id] = {
                        "paperId": target_id,
                        "title": title,
                        "source": source,
                        "citationCount": citation_count,
                        "isExternal": True,
                    }
                    node_order.append(target_id)
                else:
                    if existing_target.get("title") in (
                        None,
                        "",
                        f"External reference {target_id}",
                    ) and title:
                        existing_target["title"] = title
                    if existing_target.get("source") is None and source is not None:
                        existing_target["source"] = source
                    if (
                        existing_target.get("citationCount") is None
                        and citation_count is not None
                    ):
                        existing_target["citationCount"] = citation_count

            edge_key = (source_id, target_id, "cites")
            if edge_key in edge_keys:
                continue
            edge_keys.add(edge_key)
            edges.append(
                {
                    "source": source_id,
                    "target": target_id,
                    "type": "cites",
                }
            )

    nodes = [nodes_by_id[node_id] for node_id in node_order]

    node_count = len(nodes)
    edge_count = len(edges)
    max_directed_edges = node_count * (node_count - 1)
    density = (edge_count / max_directed_edges) if max_directed_edges > 0 else 0.0
    avg_out_degree = (edge_count / node_count) if node_count > 0 else 0.0

    in_degree: dict[str, int] = defaultdict(int)
    for node_id in node_order:
        in_degree[node_id] = 0
    for edge in edges:
        in_degree[edge["target"]] += 1

    top_in_degree: list[dict[str, int | str]] = []
    for paper_id, degree in sorted(in_degree.items(), key=lambda item: (-item[1], item[0])):
        if degree <= 0:
            continue
        top_in_degree.append({"paperId": paper_id, "inDegree": degree})

    return {
        "schemaVersion": "citation_network.v1",
        "generatedAt": utc_now_iso(),
        "sourceDigest": source_digest,
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "nodeCount": node_count,
            "edgeCount": edge_count,
            "density": density,
            "avgOutDegree": avg_out_degree,
            "topInDegree": top_in_degree,
        },
    }


def main() -> int:
    args = parse_args()
    digest_path = Path(args.digest)
    output_path = Path(args.output)

    digest_payload = read_json_object(digest_path)
    network_payload = build_citation_network(
        digest_payload=digest_payload,
        source_digest=str(digest_path),
        include_external_refs=args.include_external_refs,
    )
    write_json(output_path, network_payload)
    print(
        json.dumps(
            {
                "output": str(output_path),
                "nodeCount": network_payload["stats"]["nodeCount"],
                "edgeCount": network_payload["stats"]["edgeCount"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
