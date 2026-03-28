#!/usr/bin/env python3
"""Tests for strategy_phaseb_family_search script helpers."""

from __future__ import annotations

import importlib.util
import random
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "strategy_phaseb_family_search.py"

_SPEC = importlib.util.spec_from_file_location(
    "strategy_phaseb_family_search", str(SCRIPT_PATH)
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - defensive import guard
    raise RuntimeError("Failed to load strategy_phaseb_family_search module spec.")
MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MODULE)


class TestStrategyPhaseBFamilySearch(unittest.TestCase):
    def test_generate_trial_candidates_has_three_entries(self) -> None:
        pools = MODULE.build_family_pools()
        template = ("trend", "meanReversion", "ensemble")
        rng = random.Random(123)
        rows = MODULE.generate_trial_candidates(
            rng=rng,
            pools=pools,
            template=template,
            trial_index=0,
        )
        self.assertEqual(len(rows), 3)
        self.assertEqual(
            [row["strategy"] for row in rows],
            ["trend", "meanReversion", "ensemble"],
        )
        self.assertEqual(len({row["strategyId"] for row in rows}), 3)

    def test_rank_key_prefers_lower_wfo_failure_density_before_sharpe(self) -> None:
        low_density_lower_sharpe = {
            "passCount": 0,
            "wfoPassCount": 1,
            "wfoFailureDensity": 0.25,
            "hardGapMagnitude": 0.10,
            "releaseGateFailCount": 2,
            "meanSharpe": 1.0,
        }
        high_density_higher_sharpe = {
            "passCount": 0,
            "wfoPassCount": 1,
            "wfoFailureDensity": 0.75,
            "hardGapMagnitude": 0.10,
            "releaseGateFailCount": 0,
            "meanSharpe": 9.0,
        }
        self.assertGreater(
            MODULE.rank_key(low_density_lower_sharpe),
            MODULE.rank_key(high_density_higher_sharpe),
        )

    def test_rank_key_prefers_smaller_hard_gap_before_sharpe(self) -> None:
        smaller_gap_lower_sharpe = {
            "passCount": 0,
            "wfoPassCount": 1,
            "wfoFailureDensity": 0.50,
            "hardGapMagnitude": 0.02,
            "hardGapScore": -0.02,
            "meanSharpe": 1.0,
        }
        larger_gap_higher_sharpe = {
            "passCount": 0,
            "wfoPassCount": 1,
            "wfoFailureDensity": 0.50,
            "hardGapMagnitude": 0.50,
            "hardGapScore": -0.50,
            "meanSharpe": 8.0,
        }
        self.assertGreater(
            MODULE.rank_key(smaller_gap_lower_sharpe),
            MODULE.rank_key(larger_gap_higher_sharpe),
        )

    def test_summarize_trial_computes_hard_gap_and_baseline_flag(self) -> None:
        summary = MODULE.summarize_trial(
            trial_id=0,
            template=("baseline", "baseline", "baseline"),
            is_baseline_anchor=True,
            candidates=[],
            thresholds={
                "meanPboMax": 0.2,
                "meanDsrProbabilityMin": 0.5,
                "fdrQMax": 0.1,
            },
            command_info={},
            runs_payload={"candidates": []},
            verdict_payload={
                "result": "NO_GO",
                "reasonCodes": ["HARD_FDR_THRESHOLD_FAIL"],
                "aggregateMetrics": {
                    "meanPbo": 0.25,
                    "meanDsrProbability": 0.4,
                    "fdrQ": 0.15,
                },
            },
        )
        self.assertTrue(summary["isBaselineAnchor"])
        self.assertAlmostEqual(summary["hardGapScore"], -(0.05 + 0.1 + 0.05))
        self.assertAlmostEqual(summary["hardGapMagnitude"], 0.05 + 0.1 + 0.05)
        self.assertEqual(summary["wfoFailureDensity"], 1.0)
        gaps = summary["thresholdGaps"]
        self.assertAlmostEqual(gaps["meanPboGap"], 0.05)
        self.assertAlmostEqual(gaps["meanDsrProbabilityGap"], 0.1)
        self.assertAlmostEqual(gaps["fdrQGap"], 0.05)


if __name__ == "__main__":
    unittest.main()
