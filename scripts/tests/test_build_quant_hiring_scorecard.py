#!/usr/bin/env python3
"""Tests for build_quant_hiring_scorecard script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_quant_hiring_scorecard.py"


class TestBuildQuantHiringScorecard(unittest.TestCase):
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
        stageb_path: Path,
        output_path: Path,
        markdown_path: Path,
        target_role: str,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--stageb",
                str(stageb_path),
                "--target-role",
                target_role,
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

    def test_builds_execution_statistics_hybrid_scorecard(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hiring-scorecard-") as tmp:
            root = Path(tmp)
            stageb_path = root / "in/stageb.v1.json"
            output_path = root / "out/quant_hiring_scorecard.v1.json"
            markdown_path = root / "out/quant_hiring_scorecard.md"

            self.write_json(
                stageb_path,
                {
                    "schemaVersion": "stageb_governance_packet.v1",
                    "decision": {"recommendedOptionId": "launch_strategy_rebuild"},
                },
            )

            payload = self.run_builder(
                repo_root=root,
                stageb_path=stageb_path,
                output_path=output_path,
                markdown_path=markdown_path,
                target_role="execution_stats_hybrid_quant",
            )
            self.assertEqual(payload["schemaVersion"], "quant_hiring_scorecard.v1")
            self.assertEqual(payload["roleId"], "execution_stats_hybrid_quant")
            self.assertEqual(
                payload["context"]["stageBRecommendedOption"],
                "launch_strategy_rebuild",
            )
            self.assertGreaterEqual(len(payload.get("dimensions", [])), 4)
            self.assertTrue(bool(payload.get("hardRejectRules")))
            self.assertTrue(bool(payload.get("interviewStages")))


if __name__ == "__main__":
    unittest.main()
