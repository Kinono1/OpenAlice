#!/usr/bin/env python3
"""Tests for strategy_protocol_ablation script helpers."""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "strategy_protocol_ablation.py"

_SPEC = importlib.util.spec_from_file_location(
    "strategy_protocol_ablation", str(SCRIPT_PATH)
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - defensive import guard
    raise RuntimeError("Failed to load strategy_protocol_ablation module spec.")
MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MODULE)


class TestStrategyProtocolAblation(unittest.TestCase):
    def test_parse_profiles_deduplicates_and_validates(self) -> None:
        profiles = MODULE.parse_profiles("stable,shift,stable,stress")
        self.assertEqual(profiles, ["stable", "shift", "stress"])
        with self.assertRaises(ValueError):
            MODULE.parse_profiles("stable,invalid")

    def test_compute_hard_gap_matches_threshold_logic(self) -> None:
        hard_gap = MODULE.compute_hard_gap(
            mean_pbo=0.25,
            mean_dsr=0.4,
            fdr_q=0.15,
            thresholds={
                "meanPboMax": 0.2,
                "meanDsrProbabilityMin": 0.5,
                "fdrQMax": 0.1,
            },
        )
        self.assertAlmostEqual(hard_gap["pboGap"], 0.05)
        self.assertAlmostEqual(hard_gap["dsrGap"], 0.1)
        self.assertAlmostEqual(hard_gap["fdrGap"], 0.05)
        self.assertAlmostEqual(hard_gap["totalGap"], 0.2)

    def test_rank_key_prefers_lower_wfo_and_gap(self) -> None:
        better = {
            "hasMetrics": True,
            "wfoFailureDensity": 0.2,
            "hardGap": {"totalGap": 0.1, "fdrGap": 0.05},
            "meanSharpe": 1.0,
        }
        worse = {
            "hasMetrics": True,
            "wfoFailureDensity": 0.6,
            "hardGap": {"totalGap": 0.3, "fdrGap": 0.2},
            "meanSharpe": 2.0,
        }
        self.assertLess(MODULE.rank_key(better), MODULE.rank_key(worse))


if __name__ == "__main__":
    unittest.main()
