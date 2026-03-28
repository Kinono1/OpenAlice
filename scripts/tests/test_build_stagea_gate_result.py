#!/usr/bin/env python3
"""Tests for build_stagea_gate_result script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_stagea_gate_result.py"


class TestBuildStageAGateResult(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_stagea(
        self,
        *,
        repo_root: Path,
        matrix_path: Path,
        output_path: Path,
        markdown_path: Path,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
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

    def test_stagea_passes_on_dual_condition(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagea-") as tmp:
            root = Path(tmp)
            matrix_path = root / "in/latest_multi_asset_matrix.v1.json"
            output_path = root / "out/stagea_gate_result.v1.json"
            markdown_path = root / "out/stagea_gate_result.md"
            self.write_json(
                matrix_path,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "runId": "MA3-TEST",
                    "assets": [
                        {
                            "asset": "BTC",
                            "status": "completed",
                            "fdrQ": 0.34,
                            "meanPbo": 0.18,
                            "meanDsrProbability": 0.63,
                        },
                        {
                            "asset": "ETH",
                            "status": "completed",
                            "fdrQ": 0.30,
                            "meanPbo": 0.17,
                            "meanDsrProbability": 0.66,
                        },
                        {
                            "asset": "SOL",
                            "status": "completed",
                            "fdrQ": 0.41,
                            "meanPbo": 0.25,
                            "meanDsrProbability": 0.45,
                        },
                    ],
                },
            )

            run = self.run_stagea(
                repo_root=root,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertTrue(payload["decision"]["passed"])
            self.assertTrue(payload["decision"]["conditionAPassed"])
            self.assertFalse(payload["decision"]["conditionBPassed"])
            self.assertEqual(payload["decision"]["nextStage"], "continue_current_framework")

    def test_stagea_fails_when_no_condition_hits(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagea-") as tmp:
            root = Path(tmp)
            matrix_path = root / "in/latest_multi_asset_matrix.v1.json"
            output_path = root / "out/stagea_gate_result.v1.json"
            markdown_path = root / "out/stagea_gate_result.md"
            self.write_json(
                matrix_path,
                {
                    "schemaVersion": "multi_asset_matrix.v1",
                    "runId": "MA3-TEST",
                    "assets": [
                        {
                            "asset": "BTC",
                            "status": "completed",
                            "fdrQ": 0.44,
                            "meanPbo": 0.29,
                            "meanDsrProbability": 0.40,
                        },
                        {
                            "asset": "ETH",
                            "status": "completed",
                            "fdrQ": 0.42,
                            "meanPbo": 0.31,
                            "meanDsrProbability": 0.39,
                        },
                        {
                            "asset": "SOL",
                            "status": "completed",
                            "fdrQ": 0.45,
                            "meanPbo": 0.28,
                            "meanDsrProbability": 0.41,
                        },
                    ],
                },
            )

            run = self.run_stagea(
                repo_root=root,
                matrix_path=matrix_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(run.returncode, 2, msg=run.stderr or run.stdout)
            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertFalse(payload["decision"]["passed"])
            self.assertEqual(payload["decision"]["nextStage"], "stageB_governance_review")


if __name__ == "__main__":
    unittest.main()
