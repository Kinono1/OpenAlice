#!/usr/bin/env python3
"""Tests for build_stageb_governance_packet script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_stageb_governance_packet.py"


class TestBuildStageBGovernancePacket(unittest.TestCase):
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
        stagea_path: Path,
        precontinue_path: Path,
        sensitivity_path: Path,
        matrix_path: Path,
        output_path: Path,
        markdown_path: Path,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--stagea",
                str(stagea_path),
                "--precontinue",
                str(precontinue_path),
                "--sensitivity",
                str(sensitivity_path),
                "--matrix",
                str(matrix_path),
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

    def test_recommends_rebuild_when_stagea_fails(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stageb-") as tmp:
            root = Path(tmp)
            stagea_path = root / "in/stagea.json"
            precontinue_path = root / "in/precontinue.json"
            sensitivity_path = root / "in/sensitivity.json"
            matrix_path = root / "in/matrix.json"
            output_path = root / "out/stageb_packet.json"
            markdown_path = root / "out/stageb_packet.md"

            self.write_json(
                stagea_path,
                {"decision": {"passed": False, "nextStage": "stageB_governance_review"}},
            )
            self.write_json(
                precontinue_path,
                {"decision": {"primaryRecommendation": "strategy_rebuild"}},
            )
            self.write_json(
                sensitivity_path,
                {
                    "scenarios": [
                        {"scenarioId": "prod_frozen", "metrics": {"jointPassRate": 0.0}},
                        {
                            "scenarioId": "research_fdr_15",
                            "metrics": {"jointPassRate": 0.0},
                            "deltaVsProd": {"jointPassRate": 0.0},
                        },
                    ]
                },
            )
            self.write_json(
                matrix_path,
                {"summary": {"completedAssets": 3, "fdrQMedian": 0.88}},
            )

            payload = self.run_builder(
                repo_root=root,
                stagea_path=stagea_path,
                precontinue_path=precontinue_path,
                sensitivity_path=sensitivity_path,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(payload["schemaVersion"], "stageb_governance_packet.v1")
            self.assertEqual(
                payload["decision"]["recommendedOptionId"],
                "launch_strategy_rebuild",
            )
            self.assertTrue(payload["decision"]["requiresBusinessSignOff"])

    def test_recommends_continue_when_stagea_passes(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stageb-") as tmp:
            root = Path(tmp)
            stagea_path = root / "in/stagea.json"
            precontinue_path = root / "in/precontinue.json"
            sensitivity_path = root / "in/sensitivity.json"
            matrix_path = root / "in/matrix.json"
            output_path = root / "out/stageb_packet.json"
            markdown_path = root / "out/stageb_packet.md"

            self.write_json(
                stagea_path,
                {"decision": {"passed": True, "nextStage": "continue_current_framework"}},
            )
            self.write_json(
                precontinue_path,
                {"decision": {"primaryRecommendation": "continue_current_track_with_controls"}},
            )
            self.write_json(
                sensitivity_path,
                {
                    "scenarios": [
                        {"scenarioId": "prod_frozen", "metrics": {"jointPassRate": 0.2}},
                        {
                            "scenarioId": "research_fdr_15",
                            "metrics": {"jointPassRate": 0.4},
                            "deltaVsProd": {"jointPassRate": 0.2},
                        },
                    ]
                },
            )
            self.write_json(
                matrix_path,
                {"summary": {"completedAssets": 3, "fdrQMedian": 0.2}},
            )

            payload = self.run_builder(
                repo_root=root,
                stagea_path=stagea_path,
                precontinue_path=precontinue_path,
                sensitivity_path=sensitivity_path,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(
                payload["decision"]["recommendedOptionId"],
                "continue_current_framework",
            )


if __name__ == "__main__":
    unittest.main()
