#!/usr/bin/env python3
"""Tests for research_hypothesis_to_candidates script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_hypothesis_to_candidates.py"


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class TestResearchHypothesisToCandidates(unittest.TestCase):
    def test_compile_from_hypotheses_produces_three_candidates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            output_path = root / "out_candidates.v1.json"
            archive_root = root / "archive"

            write_json(
                hypotheses_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-001",
                            "paperId": "p-regime",
                            "title": "Regime detection for crypto trading",
                            "actionHint": "Strengthen regime segmentation with HMM.",
                            "expectedImpact": "",
                            "targetMetric": "wfoFailureDensity",
                            "testPlan": "",
                            "priority": 9.5,
                        },
                        {
                            "id": "HYP-002",
                            "paperId": "p-risk",
                            "title": "Tail risk controls with CVaR",
                            "actionHint": "Increase tail-risk controls.",
                            "expectedImpact": "",
                            "targetMetric": "fdrQ",
                            "testPlan": "",
                            "priority": 8.2,
                        },
                        {
                            "id": "HYP-003",
                            "paperId": "p-cost",
                            "title": "Execution slippage-aware strategy",
                            "actionHint": "Refine transaction-cost and slippage modeling.",
                            "expectedImpact": "",
                            "targetMetric": "net_trim10_mean",
                            "testPlan": "",
                            "priority": 7.4,
                        },
                    ],
                },
            )
            write_json(
                base_path,
                {
                    "schemaVersion": "strategy_candidates.v1",
                    "candidates": [
                        {
                            "strategyId": "B1",
                            "strategyName": "base-trend",
                            "strategy": "trend",
                            "params": {
                                "trendFastPeriod": 21,
                                "trendSlowPeriod": 70,
                                "allowShort": True,
                            },
                        }
                    ],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--output",
                    str(output_path),
                    "--archive-root",
                    str(archive_root),
                    "--run-id",
                    "unit-h2c-001",
                    "--plan",
                    "B",
                    "--candidate-count",
                    "3",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertTrue(output_path.exists())
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 3)
            strategies = {row.get("strategy") for row in candidates}
            self.assertIn("trend", strategies)
            self.assertEqual(strategies, {"trend"})
            hypothesis_compile = payload.get("hypothesisCompile", {})
            self.assertEqual(hypothesis_compile.get("plan"), "B")
            self.assertIn("inputs", hypothesis_compile)
            self.assertIn("stats", hypothesis_compile)
            self.assertIn("hypotheses", hypothesis_compile.get("inputs", {}))
            self.assertIn("baseCandidates", hypothesis_compile.get("inputs", {}))
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeRequested"),
                "auto",
            )
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeEffective"),
                "auto",
            )
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("complexityProfile"),
                "default",
            )
            self.assertFalse(hypothesis_compile.get("stats", {}).get("bestTripletLoaded"))
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletSeedCount"), 0)
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletLoadError"), "")

    def test_plan_a_prefers_trend_anchor_set(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-plan-a-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(
                hypotheses_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-REG",
                            "paperId": "p-regime",
                            "title": "Regime shifts",
                            "actionHint": "regime detection",
                            "priority": 9.0,
                        },
                        {
                            "id": "HYP-RISK",
                            "paperId": "p-risk",
                            "title": "Tail-risk controls",
                            "actionHint": "uncertainty calibration",
                            "priority": 8.0,
                        },
                        {
                            "id": "HYP-COST",
                            "paperId": "p-cost",
                            "title": "Execution costs",
                            "actionHint": "transaction-cost modeling",
                            "priority": 7.0,
                        },
                    ],
                },
            )
            write_json(
                base_path,
                {
                    "schemaVersion": "strategy_candidates.v1",
                    "candidates": [
                        {
                            "strategyId": "B1",
                            "strategyName": "base-breakout",
                            "strategy": "breakout",
                            "params": {
                                "breakoutPeriod": 40,
                                "breakoutExitPeriod": 12,
                                "allowShort": True,
                            },
                        }
                    ],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--output",
                    str(output_path),
                    "--plan",
                    "A",
                    "--candidate-count",
                    "3",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 3)
            self.assertTrue(all(row.get("strategy") == "trend" for row in candidates))

    def test_empty_hypotheses_falls_back_to_base_and_templates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-empty-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(hypotheses_path, {"schemaVersion": "hypothesis_backlog.v1", "hypotheses": []})
            write_json(
                base_path,
                {
                    "schemaVersion": "strategy_candidates.v1",
                    "candidates": [],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--output",
                    str(output_path),
                    "--plan",
                    "A",
                    "--candidate-count",
                    "3",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 3)
            self.assertTrue(all(isinstance(row.get("params"), dict) for row in candidates))

    def test_lock_best_triplet_emits_exact_three_trend_candidates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-lock-best-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            best_triplet_path = root / "best_trend_triplet.latest.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(hypotheses_path, {"schemaVersion": "hypothesis_backlog.v1", "hypotheses": []})
            write_json(base_path, {"schemaVersion": "strategy_candidates.v1", "candidates": []})

            best_triplet_rows = [
                {
                    "strategyId": "BT001",
                    "strategyName": "trend_best_1",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 34, "trendSlowPeriod": 75, "allowShort": True},
                },
                {
                    "strategyId": "BT002",
                    "strategyName": "trend_best_2",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 18, "trendSlowPeriod": 80, "allowShort": True},
                },
                {
                    "strategyId": "BT003",
                    "strategyName": "trend_best_3",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 34, "trendSlowPeriod": 65, "allowShort": True},
                },
            ]
            write_json(
                best_triplet_path,
                {
                    "schemaVersion": "best_trend_triplet.v1",
                    "triplet": best_triplet_rows,
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--best-triplet",
                    str(best_triplet_path),
                    "--candidate-mode",
                    "lock_best_triplet",
                    "--output",
                    str(output_path),
                    "--candidate-count",
                    "9",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 3)
            self.assertTrue(all(row.get("strategy") == "trend" for row in candidates))
            self.assertEqual([row.get("params") for row in candidates], [row.get("params") for row in best_triplet_rows])
            hypothesis_compile = payload.get("hypothesisCompile", {})
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeRequested"),
                "lock_best_triplet",
            )
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeEffective"),
                "lock_best_triplet",
            )
            self.assertTrue(hypothesis_compile.get("stats", {}).get("bestTripletLoaded"))
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletSeedCount"), 3)
            self.assertEqual(hypothesis_compile.get("inputs", {}).get("bestTripletSource"), str(best_triplet_path))
            self.assertEqual(
                hypothesis_compile.get("inputs", {}).get("bestTripletSchemaVersion"),
                "best_trend_triplet.v1",
            )
            self.assertEqual(hypothesis_compile.get("inputs", {}).get("bestTripletSourceType"), "object")
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletLoadError"), "")

    def test_blend_mode_starts_from_best_triplet_and_keeps_target_count(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-blend-best-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            best_triplet_path = root / "best_trend_triplet.latest.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(
                hypotheses_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-REG",
                            "paperId": "p-regime",
                            "title": "Regime adaptation",
                            "actionHint": "regime detection",
                            "priority": 9.1,
                        },
                        {
                            "id": "HYP-COST",
                            "paperId": "p-cost",
                            "title": "Execution slippage controls",
                            "actionHint": "transaction-cost modeling",
                            "priority": 8.7,
                        },
                    ],
                },
            )
            write_json(base_path, {"schemaVersion": "strategy_candidates.v1", "candidates": []})

            best_triplet_rows = [
                {
                    "strategyId": "BT001",
                    "strategyName": "trend_best_1",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 34, "trendSlowPeriod": 75, "allowShort": True},
                },
                {
                    "strategyId": "BT002",
                    "strategyName": "trend_best_2",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 18, "trendSlowPeriod": 80, "allowShort": True},
                },
                {
                    "strategyId": "BT003",
                    "strategyName": "trend_best_3",
                    "strategy": "trend",
                    "params": {"trendFastPeriod": 34, "trendSlowPeriod": 65, "allowShort": True},
                },
            ]
            write_json(best_triplet_path, {"schemaVersion": "best_trend_triplet.v1", "triplet": best_triplet_rows})

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--best-triplet",
                    str(best_triplet_path),
                    "--candidate-mode",
                    "blend",
                    "--output",
                    str(output_path),
                    "--candidate-count",
                    "5",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 5)
            self.assertEqual([row.get("params") for row in candidates[:3]], [row.get("params") for row in best_triplet_rows])

            dedupe_keys = {
                f"{row.get('strategy')}:{json.dumps(row.get('params', {}), sort_keys=True)}" for row in candidates
            }
            self.assertEqual(len(dedupe_keys), len(candidates))

            hypothesis_compile = payload.get("hypothesisCompile", {})
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeRequested"),
                "blend",
            )
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeEffective"),
                "blend",
            )
            self.assertEqual(hypothesis_compile.get("stats", {}).get("outputCandidates"), 5)
            self.assertTrue(hypothesis_compile.get("stats", {}).get("bestTripletLoaded"))
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletSeedCount"), 3)
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletLoadError"), "")

    def test_blend_mode_falls_back_to_auto_when_best_triplet_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-blend-fallback-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            best_triplet_path = root / "missing_best_trend_triplet.latest.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(
                hypotheses_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-REG",
                            "paperId": "p-regime",
                            "title": "Regime adaptation",
                            "actionHint": "regime detection",
                            "priority": 9.1,
                        }
                    ],
                },
            )
            write_json(base_path, {"schemaVersion": "strategy_candidates.v1", "candidates": []})

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--best-triplet",
                    str(best_triplet_path),
                    "--candidate-mode",
                    "blend",
                    "--output",
                    str(output_path),
                    "--candidate-count",
                    "3",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            hypothesis_compile = payload.get("hypothesisCompile", {})
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeRequested"),
                "blend",
            )
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("candidateModeEffective"),
                "auto",
            )
            self.assertFalse(hypothesis_compile.get("stats", {}).get("bestTripletLoaded"))
            self.assertEqual(hypothesis_compile.get("stats", {}).get("bestTripletSeedCount"), 0)
            self.assertTrue(bool(hypothesis_compile.get("stats", {}).get("bestTripletLoadError", "")))

    def test_low_complexity_profile_enforces_long_only_trend(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-hyp2cand-low-complexity-") as tmp:
            root = Path(tmp)
            hypotheses_path = root / "backlog.v1.json"
            base_path = root / "base_candidates.v1.json"
            output_path = root / "out_candidates.v1.json"

            write_json(
                hypotheses_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-REG",
                            "paperId": "p-regime",
                            "title": "Regime adaptation",
                            "actionHint": "regime detection",
                            "priority": 9.1,
                        }
                    ],
                },
            )
            write_json(
                base_path,
                {
                    "schemaVersion": "strategy_candidates.v1",
                    "candidates": [
                        {
                            "strategyId": "B-ENSEMBLE",
                            "strategyName": "base-ensemble",
                            "strategy": "ensemble",
                            "params": {
                                "allowShort": True,
                                "trendFastPeriod": 18,
                                "trendSlowPeriod": 55,
                            },
                        }
                    ],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--hypotheses",
                    str(hypotheses_path),
                    "--base-candidates",
                    str(base_path),
                    "--output",
                    str(output_path),
                    "--plan",
                    "A",
                    "--candidate-count",
                    "3",
                    "--complexity-profile",
                    "low",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 3)
            for row in candidates:
                self.assertEqual(row.get("strategy"), "trend")
                params = row.get("params", {})
                self.assertFalse(params.get("allowShort", True))
                self.assertGreaterEqual(int(params.get("trendFastPeriod", 0)), 18)
                self.assertLessEqual(int(params.get("trendFastPeriod", 999)), 34)
                self.assertGreaterEqual(int(params.get("trendSlowPeriod", 0)), 60)
                self.assertLessEqual(int(params.get("trendSlowPeriod", 999)), 120)
            hypothesis_compile = payload.get("hypothesisCompile", {})
            self.assertEqual(
                hypothesis_compile.get("stats", {}).get("complexityProfile"),
                "low",
            )


if __name__ == "__main__":
    unittest.main()
