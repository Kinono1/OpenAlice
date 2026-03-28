#!/usr/bin/env python3
"""Tests for strategy_g3g4_failure_breakdown script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "strategy_g3g4_failure_breakdown.py"


class TestStrategyG3G4FailureBreakdown(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def test_breakdown_outputs_expected_fields_and_counts(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-breakdown-") as tmp:
            root = Path(tmp)
            validation_runs = root / "strategy_validation_runs.json"
            verdict = root / "experiment_verdict.v2.json"
            g3 = root / "G3.checkpoint.json"
            g4 = root / "G4.checkpoint.json"
            out_dir = root / "analysis"

            self.write_json(
                validation_runs,
                {
                    "candidates": [
                        {
                            "strategyId": "T1",
                            "strategyName": "trend_a",
                            "strategy": "trend",
                            "status": "fail",
                            "candidatePass": False,
                            "significance": {
                                "pbo": 1.0,
                                "dsrValue": -0.3,
                                "dsrProbability": 0.1,
                            },
                            "fdr": {"qValue": 1.0, "pValue": 0.9, "rank": 2},
                            "backtestMetrics": {"sharpe": -0.4, "totalReturnPct": -10.0},
                            "wfoSummary": {
                                "overallPassed": False,
                                "totalWindows": 3,
                                "failedWindows": 2,
                                "failedWindowRatio": 0.666667,
                                "failByReason": {"degradation_exceeded": 2},
                            },
                            "wfoGatePassed": False,
                            "releaseGate": {"failedChecks": ["wfo", "significance"]},
                            "failureReasons": ["HARD_PBO_THRESHOLD_FAIL"],
                        },
                        {
                            "strategyId": "E1",
                            "strategyName": "ensemble_a",
                            "strategy": "ensemble",
                            "status": "pass",
                            "candidatePass": True,
                            "significance": {
                                "pbo": 0.1,
                                "dsrValue": 0.2,
                                "dsrProbability": 0.7,
                            },
                            "fdr": {"qValue": 0.05, "pValue": 0.04, "rank": 1},
                            "backtestMetrics": {"sharpe": 1.2, "totalReturnPct": 8.0},
                            "wfoSummary": {
                                "overallPassed": True,
                                "totalWindows": 3,
                                "failedWindows": 0,
                                "failedWindowRatio": 0.0,
                                "failByReason": {},
                            },
                            "wfoGatePassed": True,
                            "releaseGate": {"failedChecks": []},
                            "failureReasons": [],
                        },
                    ]
                },
            )
            self.write_json(
                verdict,
                {
                    "result": "NO_GO",
                    "reasonCodes": ["HARD_MEAN_PBO_THRESHOLD_FAIL"],
                    "thresholds": {
                        "meanPboMax": 0.2,
                        "meanDsrProbabilityMin": 0.5,
                        "fdrQMax": 0.1,
                    },
                    "aggregateMetrics": {
                        "meanPbo": 0.55,
                        "meanDsrProbability": 0.4,
                        "fdrQ": 0.525,
                    },
                },
            )
            self.write_json(g3, {"status": "fail", "reasonCodes": ["HARD_EXPERIMENT_NO_GO"]})
            self.write_json(g4, {"status": "fail", "reasonCodes": ["HARD_UPSTREAM_GATE_FAILED"]})

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--validation-runs",
                    str(validation_runs),
                    "--experiment-verdict",
                    str(verdict),
                    "--g3-checkpoint",
                    str(g3),
                    "--g4-checkpoint",
                    str(g4),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(run.returncode, 0, msg=run.stderr)

            latest_json_path = out_dir / "latest_strategy_g3g4_breakdown.json"
            self.assertTrue(latest_json_path.exists())
            payload = json.loads(latest_json_path.read_text(encoding="utf-8"))

            self.assertEqual(payload["run_id"], "unit-test-run")
            self.assertTrue(payload["no_decision"]["triggered"])
            self.assertEqual(payload["candidate_summary"]["count"], 2)
            self.assertEqual(payload["candidate_summary"]["passCount"], 1)
            self.assertEqual(
                payload["failure_breakdown"]["releaseGateFailedChecks"]["wfo"], 1
            )
            self.assertEqual(
                payload["failure_breakdown"]["wfoGateReasons"]["degradation_exceeded"], 2
            )
            self.assertEqual(payload["gates"]["G3"]["status"], "fail")
            self.assertEqual(payload["gates"]["G4"]["status"], "fail")
            self.assertIn("wfo_diagnostics", payload)
            self.assertIn("windowQuantiles", payload["wfo_diagnostics"])
            self.assertIn("regimeBuckets", payload["wfo_diagnostics"])
            self.assertIn("protocolAblation", payload)
            self.assertAlmostEqual(
                payload["fdr_feasibility"]["bestCaseMinDsrProbabilityForQPass"], 0.95
            )
            self.assertEqual(
                payload["fdr_feasibility"]["champion"]["strategyId"], "E1"
            )
            self.assertAlmostEqual(
                payload["fdr_feasibility"]["champion"][
                    "requiredMinDsrProbabilityForCurrentRankQPass"
                ],
                0.95,
            )

            archive_json_path = (
                out_dir / "archive" / "unit-test-run" / "strategy_g3g4_breakdown.json"
            )
            archive_md_path = (
                out_dir / "archive" / "unit-test-run" / "strategy_g3g4_breakdown.md"
            )
            self.assertTrue(archive_json_path.exists())
            self.assertTrue(archive_md_path.exists())


if __name__ == "__main__":
    unittest.main()
