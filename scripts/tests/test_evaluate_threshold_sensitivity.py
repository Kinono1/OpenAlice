#!/usr/bin/env python3
"""Tests for evaluate_threshold_sensitivity script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "evaluate_threshold_sensitivity.py"


class TestEvaluateThresholdSensitivity(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_sensitivity(
        self,
        *,
        repo_root: Path,
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
                "--matrix-report",
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
        self.assertTrue(markdown_path.exists())
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_sensitivity_metrics_and_delta_vs_prod(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-threshold-sensitivity-") as tmp:
            root = Path(tmp)
            matrix_path = root / "in/latest_multi_asset_matrix.v1.json"
            self.write_json(
                matrix_path,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "runId": "TEST-MATRIX",
                    "assets": [
                        {
                            "asset": "A1",
                            "status": "completed",
                            "fdrQ": 0.09,
                            "meanPbo": 0.15,
                            "meanDsrProbability": 0.60,
                            "failedChecks": [],
                        },
                        {
                            "asset": "A2",
                            "status": "completed",
                            "fdrQ": 0.14,
                            "meanPbo": 0.10,
                            "meanDsrProbability": 0.70,
                            "failedChecks": ["wfo"],
                        },
                        {
                            "asset": "A3",
                            "status": "completed",
                            "fdrQ": 0.18,
                            "meanPbo": 0.25,
                            "meanDsrProbability": 0.80,
                            "failedChecks": [],
                        },
                        {
                            "asset": "A4",
                            "status": "completed",
                            "fdrQ": 0.08,
                            "meanPbo": 0.19,
                            "meanDsrProbability": 0.40,
                            "failedChecks": [],
                        },
                        {
                            "asset": "A5",
                            "status": "missing_data",
                            "fdrQ": 0.01,
                            "meanPbo": 0.01,
                            "meanDsrProbability": 0.99,
                            "failedChecks": [],
                        },
                    ],
                },
            )

            output_path = root / "out/latest_threshold_sensitivity.v1.json"
            markdown_path = root / "out/latest_threshold_sensitivity.md"
            payload = self.run_sensitivity(
                repo_root=root,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )

            self.assertEqual(payload["schemaVersion"], "threshold_sensitivity.v1")
            scenarios = {
                row["scenarioId"]: row
                for row in payload["scenarios"]
                if isinstance(row, dict)
            }
            self.assertEqual(set(scenarios.keys()), {
                "prod_frozen",
                "research_fdr_12",
                "research_fdr_15",
                "research_fdr_20",
            })

            prod_metrics = scenarios["prod_frozen"]["metrics"]
            self.assertEqual(prod_metrics["eligibleAssetCount"], 4)
            self.assertAlmostEqual(prod_metrics["jointPassRate"], 0.25, places=6)
            self.assertAlmostEqual(prod_metrics["fdrBlockRate"], 0.5, places=6)
            self.assertAlmostEqual(prod_metrics["wfoBlockRate"], 0.25, places=6)

            fdr15_metrics = scenarios["research_fdr_15"]["metrics"]
            self.assertAlmostEqual(fdr15_metrics["jointPassRate"], 0.5, places=6)
            self.assertAlmostEqual(fdr15_metrics["fdrBlockRate"], 0.25, places=6)
            self.assertAlmostEqual(
                scenarios["research_fdr_15"]["deltaVsProd"]["jointPassRate"],
                0.25,
                places=6,
            )


if __name__ == "__main__":
    unittest.main()
