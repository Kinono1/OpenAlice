#!/usr/bin/env python3
"""Tests for build_problem_driven_paper_board script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_problem_driven_paper_board.py"


class TestBuildProblemDrivenPaperBoard(unittest.TestCase):
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
        digest_path: Path,
        shortlist_path: Path,
        backlog_path: Path,
        output_path: Path,
        markdown_path: Path,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--digest",
                str(digest_path),
                "--shortlist",
                str(shortlist_path),
                "--backlog",
                str(backlog_path),
                "--top-k",
                "10",
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

    def test_builds_non_empty_problem_buckets_from_backlog(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-paper-board-") as tmp:
            root = Path(tmp)
            digest_path = root / "in/latest_digest.json"
            shortlist_path = root / "in/frontier_shortlist.v1.json"
            backlog_path = root / "in/backlog.v1.json"
            output_path = root / "out/paper_board.v1.json"
            markdown_path = root / "out/paper_board.md"

            self.write_json(
                digest_path,
                {
                    "schemaVersion": "research_digest.v2",
                    "top_recent": [
                        {"paper_id": "P1", "title": "Adaptive FDR for Crypto Regimes"},
                        {"paper_id": "P2", "title": "Execution Slippage Modeling"},
                        {"paper_id": "P3", "title": "Unused"},
                    ],
                },
            )
            self.write_json(
                shortlist_path,
                {
                    "schemaVersion": "fdr_frontier_shortlist.v1",
                    "shortlist": [
                        {
                            "paperId": "P1",
                            "title": "Adaptive FDR for Crypto Regimes",
                            "methodFamily": "multiple-testing-control",
                        },
                        {
                            "paperId": "P2",
                            "title": "Execution Slippage Modeling",
                            "methodFamily": "execution-aware",
                        },
                    ],
                },
            )
            self.write_json(
                backlog_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "paperId": "P1",
                            "title": "Adaptive FDR for Crypto Regimes",
                            "priority": 0.9,
                            "actionHint": "test adaptive BH calibration",
                            "methodFamily": "multiple-testing-control",
                            "evidenceType": "frontier_shortlist",
                        },
                        {
                            "paperId": "P2",
                            "title": "Execution Slippage Modeling",
                            "priority": 0.7,
                            "actionHint": "stress execution with liquidity constraints",
                            "methodFamily": "execution-aware",
                            "evidenceType": "frontier_shortlist",
                        },
                        {
                            "paperId": "P3",
                            "title": "No Action Hint Paper",
                            "priority": 1.0,
                            "actionHint": "",
                            "methodFamily": "unknown",
                            "evidenceType": "frontier_shortlist",
                        },
                    ],
                },
            )

            payload = self.run_builder(
                repo_root=root,
                digest_path=digest_path,
                shortlist_path=shortlist_path,
                backlog_path=backlog_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(payload["schemaVersion"], "paper_board.v1")
            self.assertEqual(payload["summary"]["itemCount"], 2)
            self.assertEqual(payload["items"][0]["paperId"], "P1")
            self.assertEqual(payload["items"][0]["problemBucket"], "statistical_control")
            self.assertEqual(payload["items"][1]["paperId"], "P2")
            self.assertEqual(
                payload["items"][1]["problemBucket"],
                "execution_microstructure",
            )


if __name__ == "__main__":
    unittest.main()
