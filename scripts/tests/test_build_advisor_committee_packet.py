#!/usr/bin/env python3
"""Tests for build_advisor_committee_packet script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_advisor_committee_packet.py"


class TestBuildAdvisorCommitteePacket(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_builder(
        self,
        *,
        repo_root: Path,
        shortlist_path: Path,
        backlog_path: Path,
        stageb_path: Path,
        matrix_path: Path,
        output_path: Path,
        markdown_path: Path,
        top_k: int,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--shortlist",
                str(shortlist_path),
                "--backlog",
                str(backlog_path),
                "--stageb",
                str(stageb_path),
                "--matrix",
                str(matrix_path),
                "--top-k",
                str(top_k),
                "--output",
                str(output_path),
                "--markdown",
                str(markdown_path),
            ],
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
        self.assertTrue(output_path.exists(), msg=run.stdout)
        self.assertTrue(markdown_path.exists(), msg=run.stdout)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_ranks_agenda_methods_by_backlog_priority_and_citation_boost(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-advisor-packet-") as tmp:
            root = Path(tmp)
            shortlist_path = root / "in/frontier_shortlist.v1.json"
            backlog_path = root / "in/backlog.v1.json"
            stageb_path = root / "in/stageb.v1.json"
            matrix_path = root / "in/matrix.v1.json"
            output_path = root / "out/advisor_committee_packet.v1.json"
            markdown_path = root / "out/advisor_committee_packet.md"

            self.write_json(
                shortlist_path,
                {
                    "schemaVersion": "fdr_frontier_shortlist.v1",
                    "shortlist": [
                        {
                            "methodId": "M1",
                            "paperId": "P1",
                            "title": "Paper 1",
                            "methodFamily": "adaptive_fdr",
                            "expectedImpactOnFdrQ": "high",
                            "expectedImpactOnWfo": "medium",
                            "integrationCost": "low",
                            "riskLevel": "low",
                            "actionHint": "try adaptive threshold",
                            "citations": {"citationCount": 50},
                        },
                        {
                            "methodId": "M2",
                            "paperId": "P2",
                            "title": "Paper 2",
                            "methodFamily": "stability",
                            "expectedImpactOnFdrQ": "medium",
                            "expectedImpactOnWfo": "high",
                            "integrationCost": "medium",
                            "riskLevel": "medium",
                            "actionHint": "try stability selection",
                            "citations": {"citationCount": 0},
                        },
                        {
                            "methodId": "M3",
                            "paperId": "P3",
                            "title": "Paper 3",
                            "methodFamily": "knockoff",
                            "expectedImpactOnFdrQ": "medium",
                            "expectedImpactOnWfo": "low",
                            "integrationCost": "high",
                            "riskLevel": "high",
                            "actionHint": "try model-x knockoff",
                            "citations": {"citationCount": 5},
                        },
                    ],
                },
            )
            self.write_json(
                backlog_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {"paperId": "P1", "priority": 0.2},
                        {"paperId": "P2", "priority": 0.8},
                        {"paperId": "P3", "priority": 0.1},
                    ],
                },
            )
            self.write_json(
                stageb_path,
                {
                    "schemaVersion": "stageb_governance_packet.v1",
                    "decision": {"recommendedOptionId": "launch_strategy_rebuild"},
                },
            )
            self.write_json(
                matrix_path,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "summary": {
                        "completedAssets": 3,
                        "fdrQMedian": 0.34,
                        "meetsMinAssetsSuccess": False,
                    },
                },
            )

            payload = self.run_builder(
                repo_root=root,
                shortlist_path=shortlist_path,
                backlog_path=backlog_path,
                stageb_path=stageb_path,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
                top_k=2,
            )
            self.assertEqual(payload["schemaVersion"], "advisor_committee_packet.v1")
            self.assertEqual(
                payload["context"]["stageBRecommendedOption"],
                "launch_strategy_rebuild",
            )
            self.assertEqual(len(payload["agendaMethods"]), 2)
            self.assertEqual(payload["agendaMethods"][0]["methodId"], "M1")
            self.assertEqual(payload["agendaMethods"][1]["methodId"], "M2")


if __name__ == "__main__":
    unittest.main()
