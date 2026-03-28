#!/usr/bin/env python3
"""Tests for diagnose_fdr_bottleneck script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "diagnose_fdr_bottleneck.py"


class TestDiagnoseFdrBottleneck(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_diagnose(
        self,
        *,
        repo_root: Path,
        output_path: Path,
        markdown_path: Path,
        runs_glob: str | None = None,
    ) -> dict[str, Any]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--repo-root",
            str(repo_root),
            "--output",
            str(output_path),
            "--markdown",
            str(markdown_path),
        ]
        if runs_glob is not None:
            cmd.extend(["--runs-glob", runs_glob])

        run = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
        self.assertTrue(output_path.exists())
        self.assertTrue(markdown_path.exists())
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_strategy_signal_limited_classification(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-diag-fdr-") as tmp:
            root = Path(tmp)
            run_path = (
                root
                / "data/research/strategy/runs/archive/B-20260303T020000Z/data/research/strategy/strategy_validation_runs.json"
            )
            self.write_json(
                run_path,
                {
                    "generatedAt": "2026-03-03T02:00:00Z",
                    "config": {"thresholds": {"fdrQMax": 0.1}},
                    "aggregateMetrics": {"fdrQ": 0.355},
                    "candidates": [
                        {"fdr": {"pValue": 0.29, "qValue": 0.31}},
                        {"fdr": {"pValue": 0.33, "qValue": 0.35}},
                        {"fdr": {"pValue": 0.40, "qValue": 0.42}},
                    ],
                },
            )

            output_path = root / "out" / "latest_fdr_bottleneck_report.v1.json"
            markdown_path = root / "out" / "latest_fdr_bottleneck_report.md"
            payload = self.run_diagnose(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
            )

            self.assertEqual(payload["schemaVersion"], "fdr_bottleneck_report.v1")
            self.assertEqual(payload["summary"]["runCount"], 1)
            self.assertEqual(payload["summary"]["latestDiagnosis"], "strategy_signal_limited")

            latest = payload["latest"]
            self.assertEqual(latest["runId"], "B-20260303T020000Z")
            self.assertEqual(latest["counts"]["lt_0_10"], 0)
            self.assertEqual(latest["counts"]["ge_0_30"], 2)
            self.assertEqual(len(latest["bhFeasibility"]["rankThresholds"]), 3)

    def test_correction_limited_classification_with_low_raw_p(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-diag-fdr-") as tmp:
            root = Path(tmp)
            run_path = (
                root
                / "data/research/strategy/runs/archive/B-20260304T020000Z/data/research/strategy/strategy_validation_runs.json"
            )
            self.write_json(
                run_path,
                {
                    "generatedAt": "2026-03-04T02:00:00Z",
                    "config": {"thresholds": {"fdrQMax": 0.1}},
                    "aggregateMetrics": {"fdrQ": 0.16},
                    "candidates": [
                        {"fdr": {"pValue": 0.01, "qValue": 0.11}},
                        {"fdr": {"pValue": 0.03, "qValue": 0.12}},
                        {"fdr": {"pValue": 0.20, "qValue": 0.20}},
                    ],
                },
            )

            output_path = root / "out" / "latest_fdr_bottleneck_report.v1.json"
            markdown_path = root / "out" / "latest_fdr_bottleneck_report.md"
            payload = self.run_diagnose(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
            )

            latest = payload["latest"]
            self.assertEqual(latest["diagnosis"], "correction_limited")
            self.assertEqual(latest["counts"]["lt_0_05"], 2)
            self.assertEqual(latest["counts"]["lt_alpha"], 2)
            rank1_threshold = latest["bhFeasibility"]["rankThresholds"][0]["pThreshold"]
            self.assertAlmostEqual(rank1_threshold, 0.0333333333, places=10)


if __name__ == "__main__":
    unittest.main()
