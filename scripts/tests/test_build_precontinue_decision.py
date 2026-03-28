#!/usr/bin/env python3
"""Tests for build_precontinue_decision script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_precontinue_decision.py"


class TestBuildPrecontinueDecision(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_decision(
        self,
        *,
        repo_root: Path,
        fdr_report: Path,
        matrix_report: Path,
        sensitivity_report: Path,
        output_path: Path,
        markdown_path: Path,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--fdr-report",
                str(fdr_report),
                "--matrix-report",
                str(matrix_report),
                "--sensitivity-report",
                str(sensitivity_report),
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
        self.assertTrue(markdown_path.exists())
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_strategy_rebuild_is_primary_when_rule_r1_triggers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-precontinue-") as tmp:
            root = Path(tmp)
            fdr_report = root / "in/fdr.json"
            matrix_report = root / "in/matrix.json"
            sensitivity_report = root / "in/sensitivity.json"

            self.write_json(
                fdr_report,
                {
                    "schemaVersion": "fdr_bottleneck_report.v1",
                    "latest": {
                        "diagnosis": "strategy_signal_limited",
                        "whyFdrQStuck": "Signal quality is weak.",
                        "fdrQ": 0.355,
                    },
                },
            )
            self.write_json(
                matrix_report,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "assets": [
                        {
                            "asset": "BTC",
                            "status": "completed",
                            "fdrQ": 0.45,
                            "pValueSummary": {"median": 0.35, "countLt0_10": 0},
                        },
                        {
                            "asset": "ETH",
                            "status": "completed",
                            "fdrQ": 0.30,
                            "pValueSummary": {"median": 0.28, "countLt0_10": 0},
                        },
                        {
                            "asset": "SOL",
                            "status": "completed",
                            "fdrQ": 0.32,
                            "pValueSummary": {"median": 0.31, "countLt0_10": 0},
                        },
                    ],
                },
            )
            self.write_json(
                sensitivity_report,
                {
                    "schemaVersion": "threshold_sensitivity.v1",
                    "scenarios": [
                        {
                            "scenarioId": "prod_frozen",
                            "metrics": {"fdrBlockRate": 0.8},
                            "deltaVsProd": {"jointPassRate": 0.0},
                        },
                        {
                            "scenarioId": "research_fdr_15",
                            "metrics": {"fdrBlockRate": 0.4},
                            "deltaVsProd": {"jointPassRate": 0.1},
                        },
                    ],
                },
            )

            output_path = root / "out/precontinue_decision.v1.json"
            markdown_path = root / "out/precontinue_decision.md"
            payload = self.run_decision(
                repo_root=root,
                fdr_report=fdr_report,
                matrix_report=matrix_report,
                sensitivity_report=sensitivity_report,
                output_path=output_path,
                markdown_path=markdown_path,
            )

            self.assertEqual(payload["schemaVersion"], "precontinue_decision.v1")
            self.assertEqual(
                payload["decision"]["primaryRecommendation"],
                "strategy_rebuild",
            )
            self.assertIn("R1_strategy_rebuild", payload["decision"]["triggeredRules"])

    def test_fdr_method_upgrade_is_primary_when_rule_r2_triggers(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-precontinue-") as tmp:
            root = Path(tmp)
            fdr_report = root / "in/fdr.json"
            matrix_report = root / "in/matrix.json"
            sensitivity_report = root / "in/sensitivity.json"

            self.write_json(
                fdr_report,
                {
                    "schemaVersion": "fdr_bottleneck_report.v1",
                    "latest": {
                        "diagnosis": "correction_limited",
                        "whyFdrQStuck": "Many low p-values are being corrected away.",
                        "fdrQ": 0.21,
                    },
                },
            )
            self.write_json(
                matrix_report,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "assets": [
                        {
                            "asset": "BTC",
                            "status": "completed",
                            "fdrQ": 0.19,
                            "pValueSummary": {"median": 0.09, "countLt0_10": 2},
                        },
                        {
                            "asset": "ETH",
                            "status": "completed",
                            "fdrQ": 0.20,
                            "pValueSummary": {"median": 0.10, "countLt0_10": 1},
                        },
                        {
                            "asset": "SOL",
                            "status": "completed",
                            "fdrQ": 0.23,
                            "pValueSummary": {"median": 0.11, "countLt0_10": 1},
                        },
                    ],
                },
            )
            self.write_json(
                sensitivity_report,
                {
                    "schemaVersion": "threshold_sensitivity.v1",
                    "scenarios": [
                        {
                            "scenarioId": "prod_frozen",
                            "metrics": {"fdrBlockRate": 0.7},
                            "deltaVsProd": {"jointPassRate": 0.0},
                        },
                        {
                            "scenarioId": "research_fdr_15",
                            "metrics": {"fdrBlockRate": 0.4},
                            "deltaVsProd": {"jointPassRate": 0.1},
                        },
                    ],
                },
            )

            output_path = root / "out/precontinue_decision.v1.json"
            markdown_path = root / "out/precontinue_decision.md"
            payload = self.run_decision(
                repo_root=root,
                fdr_report=fdr_report,
                matrix_report=matrix_report,
                sensitivity_report=sensitivity_report,
                output_path=output_path,
                markdown_path=markdown_path,
            )

            self.assertEqual(
                payload["decision"]["primaryRecommendation"],
                "fdr_method_upgrade",
            )
            self.assertIn("R2_fdr_method_upgrade", payload["decision"]["triggeredRules"])
            self.assertNotIn("R1_strategy_rebuild", payload["decision"]["triggeredRules"])


if __name__ == "__main__":
    unittest.main()
