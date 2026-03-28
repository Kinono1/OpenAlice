#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "stage_c_eval_harness.py"


class TestStageCEvalHarness(unittest.TestCase):
    def test_harness_matches_frozen_baseline_metrics(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagec-harness-") as tmp:
            root = Path(tmp)
            output_path = root / "latest_eval_harness.v1.json"
            archive_dir = root / "archive"

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--candidates",
                    str(REPO_ROOT / "docs" / "research" / "strategy_candidates.v1.json"),
                    "--baseline-verdict",
                    str(REPO_ROOT / "decision_packet" / "experiment_verdict.v2.json"),
                    "--output",
                    str(output_path),
                    "--archive-dir",
                    str(archive_dir),
                    "--run-id",
                    "stagec-test-001",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertTrue(output_path.exists())

            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "stage_c_eval_harness.v1")
            self.assertEqual(payload["runId"], "stagec-test-001")
            self.assertEqual(payload["aggregateMetrics"]["result"], "NO_GO")
            self.assertAlmostEqual(payload["delta"]["meanPbo"], 0.0, places=12)
            self.assertAlmostEqual(payload["delta"]["meanDsrProbability"], 0.0, places=12)
            self.assertAlmostEqual(payload["delta"]["fdrQ"], 0.0, places=12)


if __name__ == "__main__":
    unittest.main()
