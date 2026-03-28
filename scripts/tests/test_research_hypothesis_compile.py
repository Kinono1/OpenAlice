#!/usr/bin/env python3
"""Tests for research_hypothesis_compile script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Dict, List


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_hypothesis_compile.py"


class TestResearchHypothesisCompile(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_compile(
        self,
        *,
        top_new: List[Dict[str, Any]],
        breakdown: Dict[str, Any],
        top_recent: List[Dict[str, Any]] | None = None,
        shortlist: List[Dict[str, Any]] | None = None,
        max_items: int = 30,
        min_method_family_diversity: int = 0,
    ) -> Dict[str, Any]:
        with tempfile.TemporaryDirectory(prefix="openalice-hypothesis-compile-") as tmp:
            root = Path(tmp)
            scan_path = root / "latest_digest.json"
            breakdown_path = root / "latest_breakdown.json"
            shortlist_path = root / "frontier_shortlist.latest.v1.json"
            output_path = root / "backlog.v1.json"

            payload = {"top_new": top_new}
            if top_recent is not None:
                payload["top_recent"] = top_recent
            self.write_json(scan_path, payload)
            self.write_json(breakdown_path, breakdown)
            self.write_json(
                shortlist_path,
                {
                    "schemaVersion": "fdr_frontier_shortlist.v1",
                    "shortlist": shortlist or [],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--scan",
                    str(scan_path),
                    "--breakdown",
                    str(breakdown_path),
                    "--shortlist",
                    str(shortlist_path),
                    "--output",
                    str(output_path),
                    "--max-items",
                    str(max_items),
                    "--min-method-family-diversity",
                    str(min_method_family_diversity),
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertTrue(output_path.exists(), msg=run.stdout)
            return json.loads(output_path.read_text(encoding="utf-8"))

    def test_action_hint_derives_from_keywords_when_missing(self) -> None:
        payload = self.run_compile(
            top_new=[
                {
                    "paper_id": "paper-slippage",
                    "title": "A slippage-aware execution optimizer for crypto",
                    "summary": "We model market impact and slippage in volatile order books.",
                    "score": 3.5,
                    "tags": [],
                    "actionHint": "",
                }
            ],
            breakdown={},
        )
        self.assertEqual(payload["schemaVersion"], "hypothesis_backlog.v1")
        self.assertEqual(len(payload["hypotheses"]), 1)
        hypothesis = payload["hypotheses"][0]
        self.assertTrue(hypothesis["actionHint"].strip())
        self.assertIn("slippage", hypothesis["actionHint"].lower())
        self.assertEqual(hypothesis["evidenceType"], "digest")

    def test_priority_is_sorted_descending(self) -> None:
        payload = self.run_compile(
            top_new=[
                {
                    "paper_id": "paper-high",
                    "title": "Top ranked method",
                    "summary": "Relevant and mature.",
                    "score": 8.0,
                    "citation_count": 120,
                    "venue": "NeurIPS",
                    "tags": ["feature_engineering"],
                },
                {
                    "paper_id": "paper-low",
                    "title": "Lower ranked method",
                    "summary": "Less evidence.",
                    "score": 2.0,
                    "citation_count": 2,
                    "venue": "Unknown workshop",
                    "tags": ["general_alpha"],
                },
            ],
            breakdown={},
        )
        hypotheses = payload["hypotheses"]
        self.assertEqual(hypotheses[0]["paperId"], "paper-high")
        priorities = [float(row["priority"]) for row in hypotheses]
        self.assertEqual(priorities, sorted(priorities, reverse=True))

    def test_wfo_failure_match_influences_ranking(self) -> None:
        payload = self.run_compile(
            top_new=[
                {
                    "paper_id": "z-match",
                    "title": "Execution policy with explicit slippage controls",
                    "summary": "Targets walk-forward degradation under stress.",
                    "score": 5.0,
                    "citation_count": 0,
                    "venue": "unknown",
                    "tags": ["cost_execution"],
                },
                {
                    "paper_id": "a-other",
                    "title": "Macro event narrative features",
                    "summary": "Broad market event embeddings.",
                    "score": 5.0,
                    "citation_count": 0,
                    "venue": "unknown",
                    "tags": ["macro_news"],
                },
            ],
            breakdown={
                "failure_breakdown": {
                    "releaseGateFailedChecks": {"wfo": 3},
                    "wfoGateReasons": {"degradation_exceeded": 7},
                }
            },
        )
        hypotheses = payload["hypotheses"]
        self.assertEqual(hypotheses[0]["paperId"], "z-match")
        self.assertGreater(hypotheses[0]["priority"], hypotheses[1]["priority"])

    def test_falls_back_to_top_recent_when_top_new_empty(self) -> None:
        payload = self.run_compile(
            top_new=[],
            top_recent=[
                {
                    "paper_id": "recent-paper",
                    "title": "Recent fallback paper",
                    "summary": "Recent entry should still produce a hypothesis.",
                    "score": 2.5,
                }
            ],
            breakdown={},
        )
        self.assertEqual(len(payload["hypotheses"]), 1)
        self.assertEqual(payload["hypotheses"][0]["paperId"], "recent-paper")

    def test_shortlist_fields_are_propagated_to_hypothesis(self) -> None:
        payload = self.run_compile(
            top_new=[
                {
                    "paper_id": "paper-fdr-1",
                    "title": "Method from digest",
                    "summary": "Baseline entry.",
                    "score": 1.0,
                }
            ],
            shortlist=[
                {
                    "paperId": "paper-fdr-1",
                    "methodFamily": "multiple-testing-control",
                    "experimentTemplateId": "tpl_fdr_bh_gate_v1",
                    "actionHint": "Use BH gate on candidate pool.",
                }
            ],
            breakdown={},
        )
        hypothesis = payload["hypotheses"][0]
        self.assertEqual(hypothesis["paperId"], "paper-fdr-1")
        self.assertEqual(hypothesis["methodFamily"], "multiple-testing-control")
        self.assertEqual(hypothesis["experimentTemplateId"], "tpl_fdr_bh_gate_v1")
        self.assertEqual(hypothesis["evidenceType"], "digest+shortlist")

    def test_diversity_selection_uses_shortlist_families(self) -> None:
        payload = self.run_compile(
            top_new=[
                {
                    "paper_id": "d1",
                    "title": "Digest 1",
                    "summary": "Digest item one",
                    "score": 1.0,
                },
                {
                    "paper_id": "d2",
                    "title": "Digest 2",
                    "summary": "Digest item two",
                    "score": 0.9,
                },
            ],
            shortlist=[
                {
                    "paperId": "s1",
                    "title": "Selective inference paper",
                    "methodId": "m-s1",
                    "methodFamily": "selective-inference",
                    "actionHint": "Run selective inference gate.",
                    "experimentTemplateId": "tpl_evalue_knockoff_v1",
                },
                {
                    "paperId": "s2",
                    "title": "Multiple testing paper",
                    "methodId": "m-s2",
                    "methodFamily": "multiple-testing-control",
                    "actionHint": "Run BH style gate.",
                    "experimentTemplateId": "tpl_fdr_bh_gate_v1",
                },
            ],
            breakdown={},
            max_items=2,
            min_method_family_diversity=2,
        )
        hypotheses = payload["hypotheses"]
        self.assertEqual(len(hypotheses), 2)
        families = {row.get("methodFamily") for row in hypotheses if row.get("methodFamily")}
        self.assertGreaterEqual(len(families), 2)


if __name__ == "__main__":
    unittest.main()
