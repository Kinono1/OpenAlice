#!/usr/bin/env python3
"""Tests for research_fdr_shortlist script."""

from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_fdr_shortlist.py"

REQUIRED_FIELDS = [
    "methodId",
    "paperId",
    "title",
    "venue",
    "year",
    "methodFamily",
    "fdrMechanism",
    "assumptions",
    "expectedImpactOnFdrQ",
    "expectedImpactOnWfo",
    "integrationCost",
    "riskLevel",
    "actionHint",
    "experimentTemplateId",
    "citations",
]

DIGEST_FIXTURE: dict[str, Any] = {
    "schemaVersion": "research_digest.v2",
    "generated_at": "2026-03-03T00:00:00Z",
    "run_id": "digest-unit",
    "top_new": [
        {
            "paper_id": "P-REG-002",
            "title": "Regime segmentation for robust walk-forward validation",
            "summary": "Walk-forward stability improves with explicit market regimes.",
            "tags": ["regime_detection", "wfo"],
            "venue": "arXiv",
            "source": "arxiv",
            "published_at": "2025-12-01",
            "references": ["X1", "X2", "X3"],
        },
        {
            "paper_id": "P-FDR-001",
            "title": "False Discovery Rate Control via Multiple Testing",
            "summary": (
                "We study Benjamini-Hochberg q-value control and data-snooping stress tests."
            ),
            "tags": ["multiple_testing", "risk_control"],
            "venue": "NeurIPS",
            "source": "neurips",
            "published_at": "2025-11-15",
            "references_count": 1,
        },
        {
            "paper_id": "P-EXEC-003",
            "title": "Execution cost modeling for crypto market making",
            "summary": "Estimate slippage and liquidity shocks under volatile conditions.",
            "tags": ["transaction_cost"],
            "venue": "Journal of Finance",
            "source": "openalex",
            "published_at": "2024-01-10",
            "references": [],
        },
    ],
    "top_recent": [],
}

CITATION_FIXTURE: dict[str, Any] = {
    "schemaVersion": "citation_network.v1",
    "generatedAt": "2026-03-03T00:00:00Z",
    "sourceDigest": "fixture",
    "nodes": [
        {
            "paperId": "P-FDR-001",
            "title": "False Discovery Rate Control via Multiple Testing",
            "source": "neurips",
            "citationCount": 12,
            "isExternal": False,
        },
        {
            "paperId": "P-REG-002",
            "title": "Regime segmentation for robust walk-forward validation",
            "source": "arxiv",
            "citationCount": 25,
            "isExternal": False,
        },
        {
            "paperId": "P-EXEC-003",
            "title": "Execution cost modeling for crypto market making",
            "source": "openalex",
            "citationCount": 8,
            "isExternal": False,
        },
    ],
    "edges": [
        {"source": "P-REG-002", "target": "P-FDR-001", "type": "cites"},
        {"source": "P-EXEC-003", "target": "P-FDR-001", "type": "cites"},
        {"source": "P-FDR-001", "target": "P-REG-002", "type": "cites"},
    ],
    "stats": {},
}

PDF_FIXTURE: dict[str, Any] = {
    "schemaVersion": "pdf_extract_report.v1",
    "generatedAt": "2026-03-03T00:00:00Z",
    "runId": "pdf-unit",
    "summary": {
        "selected": 2,
        "processed": 2,
        "succeeded": 2,
        "failed": 0,
    },
    "papers": [
        {
            "paperId": "P-FDR-001",
            "title": "False Discovery Rate Control via Multiple Testing",
            "status": "success",
            "textChars": 12000,
        },
        {
            "paperId": "P-REG-002",
            "title": "Regime segmentation for robust walk-forward validation",
            "status": "success",
            "textChars": 9500,
        },
    ],
}

HYPOTHESIS_FIXTURE: dict[str, Any] = {
    "schemaVersion": "hypothesis_backlog.v1",
    "generatedAt": "2026-03-03T00:00:00Z",
    "inputs": {},
    "failureModes": [],
    "hypotheses": [
        {
            "id": "H-FDR-1",
            "paperId": "P-FDR-001",
            "title": "FDR gate for candidate portfolio selection",
            "actionHint": (
                "Apply multiple-testing correction and track fdrQ under stress windows."
            ),
            "expectedImpact": "Lower false discoveries and reduce fdrQ.",
            "targetMetric": "fdrQ",
            "testPlan": "Replay candidates with and without BH gate.",
            "priority": 10.0,
        },
        {
            "id": "H-REG-1",
            "paperId": "P-REG-002",
            "title": "Regime segmentation with WFO robustness",
            "actionHint": "Strengthen regime segmentation and rolling-window WFO checks.",
            "expectedImpact": "Improve walk-forward stability.",
            "targetMetric": "wfoFailureDensity",
            "testPlan": "Run segmentation ablation under shift profile.",
            "priority": 40.0,
        },
        {
            "id": "H-ORPHAN-1",
            "paperId": "P-ORPHAN-004",
            "title": "E-value stopping for sequential multiple testing",
            "actionHint": "Introduce e-value thresholding for repeated candidate scans.",
            "expectedImpact": "Lower FDR under repeated testing.",
            "targetMetric": "fdrQ",
            "testPlan": "Compare e-value gates against static q-value thresholds.",
            "priority": 8.0,
        },
    ],
}


class TestResearchFdrShortlist(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_shortlist(
        self,
        *,
        digest_path: Path,
        citation_path: Path,
        pdf_path: Path,
        hypothesis_path: Path,
        output_path: Path,
        markdown_path: Path,
        top_k: int = 8,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--digest",
                str(digest_path),
                "--citation-network",
                str(citation_path),
                "--pdf-extract-report",
                str(pdf_path),
                "--hypotheses",
                str(hypothesis_path),
                "--output",
                str(output_path),
                "--markdown",
                str(markdown_path),
                "--top-k",
                str(top_k),
            ],
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr)
        self.assertTrue(output_path.exists(), msg=run.stdout)
        self.assertTrue(markdown_path.exists(), msg=run.stdout)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_non_empty_shortlist_and_required_fields(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-fdr-shortlist-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            citation_path = root / "citation.json"
            pdf_path = root / "pdf_extract.json"
            hypothesis_path = root / "hypotheses.json"
            output_path = root / "frontier_shortlist.latest.v1.json"
            markdown_path = root / "fdr_frontier_shortlist_20260303.md"

            self.write_json(digest_path, DIGEST_FIXTURE)
            self.write_json(citation_path, CITATION_FIXTURE)
            self.write_json(pdf_path, PDF_FIXTURE)
            self.write_json(hypothesis_path, HYPOTHESIS_FIXTURE)

            payload = self.run_shortlist(
                digest_path=digest_path,
                citation_path=citation_path,
                pdf_path=pdf_path,
                hypothesis_path=hypothesis_path,
                output_path=output_path,
                markdown_path=markdown_path,
                top_k=6,
            )

            self.assertEqual(payload["schemaVersion"], "fdr_frontier_shortlist.v1")
            shortlist = payload.get("shortlist", [])
            self.assertGreater(len(shortlist), 0)
            for row in shortlist:
                for field in REQUIRED_FIELDS:
                    self.assertIn(field, row)
                self.assertIsInstance(row["citations"], dict)
                self.assertIn("citationCount", row["citations"])
                self.assertIn("inDegree", row["citations"])
                self.assertIn("outDegree", row["citations"])

            # FDR signals should dominate despite lower hypothesis priority.
            self.assertEqual(shortlist[0]["paperId"], "P-FDR-001")

    def test_ordering_stability_with_shuffled_inputs(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-fdr-shortlist-order-") as tmp:
            root = Path(tmp)

            digest_a = copy.deepcopy(DIGEST_FIXTURE)
            citation_a = copy.deepcopy(CITATION_FIXTURE)
            pdf_a = copy.deepcopy(PDF_FIXTURE)
            hypotheses_a = copy.deepcopy(HYPOTHESIS_FIXTURE)

            digest_b = copy.deepcopy(DIGEST_FIXTURE)
            digest_b["top_new"] = list(reversed(digest_b["top_new"]))
            hypotheses_b = copy.deepcopy(HYPOTHESIS_FIXTURE)
            hypotheses_b["hypotheses"] = list(reversed(hypotheses_b["hypotheses"]))

            digest_a_path = root / "digest_a.json"
            digest_b_path = root / "digest_b.json"
            citation_path = root / "citation.json"
            pdf_path = root / "pdf.json"
            hypotheses_a_path = root / "hypotheses_a.json"
            hypotheses_b_path = root / "hypotheses_b.json"
            output_a = root / "shortlist_a.json"
            output_b = root / "shortlist_b.json"
            markdown_a = root / "shortlist_a.md"
            markdown_b = root / "shortlist_b.md"

            self.write_json(digest_a_path, digest_a)
            self.write_json(digest_b_path, digest_b)
            self.write_json(citation_path, citation_a)
            self.write_json(pdf_path, pdf_a)
            self.write_json(hypotheses_a_path, hypotheses_a)
            self.write_json(hypotheses_b_path, hypotheses_b)

            payload_a = self.run_shortlist(
                digest_path=digest_a_path,
                citation_path=citation_path,
                pdf_path=pdf_path,
                hypothesis_path=hypotheses_a_path,
                output_path=output_a,
                markdown_path=markdown_a,
                top_k=6,
            )
            payload_b = self.run_shortlist(
                digest_path=digest_b_path,
                citation_path=citation_path,
                pdf_path=pdf_path,
                hypothesis_path=hypotheses_b_path,
                output_path=output_b,
                markdown_path=markdown_b,
                top_k=6,
            )

            order_a = [row["methodId"] for row in payload_a.get("shortlist", [])]
            order_b = [row["methodId"] for row in payload_b.get("shortlist", [])]
            self.assertEqual(order_a, order_b)

    def test_missing_optional_inputs_still_produce_shortlist(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-fdr-shortlist-fallback-") as tmp:
            root = Path(tmp)
            digest_path = root / "digest.json"
            output_path = root / "shortlist.json"
            markdown_path = root / "shortlist.md"

            self.write_json(digest_path, DIGEST_FIXTURE)

            payload = self.run_shortlist(
                digest_path=digest_path,
                citation_path=root / "missing_citation.json",
                pdf_path=root / "missing_pdf.json",
                hypothesis_path=root / "missing_hypotheses.json",
                output_path=output_path,
                markdown_path=markdown_path,
                top_k=4,
            )

            shortlist = payload.get("shortlist", [])
            self.assertGreater(len(shortlist), 0)
            self.assertGreaterEqual(len(payload.get("warnings", [])), 1)


if __name__ == "__main__":
    unittest.main()
