#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PAPER_CARD_REQUIRED_FIELDS = {
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
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build evidence_graph.v1 from paper_card.v2 files."
    )
    parser.add_argument(
        "--cards-dir",
        default="data/research/paper_cards",
        help="Directory containing paper card JSON files.",
    )
    parser.add_argument(
        "--output",
        default="data/research/evidence/evidence_graph.v1.json",
        help="Output path for evidence graph JSON.",
    )
    parser.add_argument(
        "--quality-output",
        default="data/research/reports/research_quality_report.json",
        help="Output path for quality report JSON.",
    )
    parser.add_argument(
        "--expected-paper-count",
        type=int,
        default=10,
        help="Expected number of paper cards for MVP pass.",
    )
    parser.add_argument(
        "--min-evidence-link-rate",
        type=float,
        default=0.9,
        help="Minimum evidence link rate for MVP pass.",
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
        raise ValueError("JSON payload must be object")
    return payload


def main() -> int:
    args = parse_args()
    cards_dir = Path(args.cards_dir)
    output_path = Path(args.output)
    quality_output_path = Path(args.quality_output)

    card_files = sorted(cards_dir.glob("*.json")) if cards_dir.exists() else []

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    node_ids: set[str] = set()
    edge_keys: set[tuple[str, str, str]] = set()

    paper_count = 0
    claim_count = 0
    evidence_count = 0
    isolated_claim_count = 0
    linked_claim_count = 0
    schema_pass_count = 0
    missing_required_fields = 0
    card_errors: list[dict[str, Any]] = []

    for card_file in card_files:
      try:
        card = read_json_object(card_file)
      except Exception as exc:  # noqa: BLE001
        card_errors.append({"path": str(card_file), "error": str(exc)})
        continue

      required_missing = sorted(PAPER_CARD_REQUIRED_FIELDS - set(card.keys()))
      missing_required_fields += len(required_missing)
      schema_ok = (
          card.get("schemaVersion") == "paper_card.v2"
          and len(required_missing) == 0
      )
      if schema_ok:
          schema_pass_count += 1

      paper_id = str(card.get("paperId", card_file.stem))
      paper_node_id = f"paper:{paper_id}"
      if paper_node_id not in node_ids:
          nodes.append(
              {"id": paper_node_id, "type": "paper", "label": paper_id, "paperId": paper_id}
          )
          node_ids.add(paper_node_id)
      paper_count += 1

      raw_evidence = card.get("evidence")
      evidence_list = raw_evidence if isinstance(raw_evidence, list) else []
      evidence_id_set: set[str] = set()

      for evidence_item in evidence_list:
          if not isinstance(evidence_item, dict):
              continue
          evidence_id = str(evidence_item.get("evidenceId", "")).strip()
          if not evidence_id:
              continue
          evidence_node_id = f"evidence:{evidence_id}"
          if evidence_node_id not in node_ids:
              nodes.append(
                  {
                      "id": evidence_node_id,
                      "type": "evidence",
                      "label": str(evidence_item.get("text", evidence_id))[:160],
                      "paperId": paper_id,
                  }
              )
              node_ids.add(evidence_node_id)
          evidence_id_set.add(evidence_id)
          evidence_count += 1

          edge_key = (evidence_node_id, paper_node_id, "derived_from")
          if edge_key not in edge_keys:
              edges.append(
                  {
                      "source": evidence_node_id,
                      "target": paper_node_id,
                      "type": "derived_from",
                  }
              )
              edge_keys.add(edge_key)

      raw_claims = card.get("claims")
      claims = raw_claims if isinstance(raw_claims, list) else []
      for claim_item in claims:
          if not isinstance(claim_item, dict):
              continue
          claim_id = str(claim_item.get("claimId", "")).strip()
          if not claim_id:
              continue
          claim_node_id = f"claim:{claim_id}"
          if claim_node_id not in node_ids:
              nodes.append(
                  {
                      "id": claim_node_id,
                      "type": "claim",
                      "label": str(claim_item.get("text", claim_id))[:160],
                      "paperId": paper_id,
                  }
              )
              node_ids.add(claim_node_id)
          claim_count += 1

          claim_to_paper_key = (claim_node_id, paper_node_id, "derived_from")
          if claim_to_paper_key not in edge_keys:
              edges.append(
                  {
                      "source": claim_node_id,
                      "target": paper_node_id,
                      "type": "derived_from",
                  }
              )
              edge_keys.add(claim_to_paper_key)

          refs = claim_item.get("evidenceRefs")
          ref_list = [str(v).strip() for v in refs] if isinstance(refs, list) else []
          valid_ref_count = 0
          for ref in ref_list:
              if not ref or ref not in evidence_id_set:
                  continue
              evidence_node_id = f"evidence:{ref}"
              edge_key = (claim_node_id, evidence_node_id, "supports")
              if edge_key not in edge_keys:
                  edges.append(
                      {
                          "source": claim_node_id,
                          "target": evidence_node_id,
                          "type": "supports",
                      }
                  )
                  edge_keys.add(edge_key)
              valid_ref_count += 1

          if valid_ref_count > 0:
              linked_claim_count += 1
          else:
              isolated_claim_count += 1

          targets = claim_item.get("targetTags")
          target_tags = [str(v).strip() for v in targets] if isinstance(targets, list) else []
          for target in target_tags:
              if not target:
                  continue
              target_node_id = f"target:{target}"
              if target_node_id not in node_ids:
                  nodes.append(
                      {
                          "id": target_node_id,
                          "type": "target",
                          "label": target,
                          "paperId": paper_id,
                      }
                  )
                  node_ids.add(target_node_id)
              edge_key = (claim_node_id, target_node_id, "targets")
              if edge_key not in edge_keys:
                  edges.append(
                      {
                          "source": claim_node_id,
                          "target": target_node_id,
                          "type": "targets",
                      }
                  )
                  edge_keys.add(edge_key)

    evidence_link_rate = (
        linked_claim_count / claim_count if claim_count > 0 else 0.0
    )
    schema_pass_rate = (
        schema_pass_count / paper_count if paper_count > 0 else 1.0
    )

    quality_pass = (
        paper_count == args.expected_paper_count
        and abs(schema_pass_rate - 1.0) < 1e-12
        and missing_required_fields == 0
        and evidence_link_rate >= args.min_evidence_link_rate
    )

    graph_payload = {
        "schemaVersion": "evidence_graph.v1",
        "generatedAt": utc_now_iso(),
        "sourceCardsDir": str(cards_dir),
        "nodes": nodes,
        "edges": edges,
        "stats": {
            "paperCount": paper_count,
            "claimCount": claim_count,
            "evidenceCount": evidence_count,
            "edgeCount": len(edges),
            "evidenceLinkRate": evidence_link_rate,
            "isolatedClaimCount": isolated_claim_count,
        },
        "quality": {
            "passed": quality_pass,
            "thresholds": {"minEvidenceLinkRate": args.min_evidence_link_rate},
        },
    }

    quality_report = {
        "generatedAt": utc_now_iso(),
        "paperCount": paper_count,
        "expectedPaperCount": args.expected_paper_count,
        "paperCardSchemaPassRate": schema_pass_rate,
        "missingRequiredFields": missing_required_fields,
        "evidenceLinkRate": evidence_link_rate,
        "thresholds": {
            "paperCountEquals": args.expected_paper_count,
            "paperCardSchemaPassRateEquals": 1.0,
            "missingRequiredFieldsEquals": 0,
            "evidenceLinkRateMin": args.min_evidence_link_rate,
        },
        "checks": {
            "paperCountOk": paper_count == args.expected_paper_count,
            "schemaPassRateOk": abs(schema_pass_rate - 1.0) < 1e-12,
            "missingRequiredFieldsOk": missing_required_fields == 0,
            "evidenceLinkRateOk": evidence_link_rate >= args.min_evidence_link_rate,
        },
        "overallPassed": quality_pass,
        "cardErrors": card_errors,
        "sourceCardsDir": str(cards_dir),
    }

    write_json(output_path, graph_payload)
    write_json(quality_output_path, quality_report)
    print(
        json.dumps(
            {
                "graph": str(output_path),
                "qualityReport": str(quality_output_path),
                "overallPassed": quality_pass,
                "paperCount": paper_count,
            },
            ensure_ascii=False,
        )
    )

    return 0 if quality_pass else 2


if __name__ == "__main__":
    sys.exit(main())
