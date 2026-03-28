#!/usr/bin/env python3
"""Tests for strategy_local_param_search helper behavior."""

from __future__ import annotations

import importlib.util
import subprocess
import unittest
from pathlib import Path
from unittest import mock


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "strategy_local_param_search.py"

_SPEC = importlib.util.spec_from_file_location(
    "strategy_local_param_search", str(SCRIPT_PATH)
)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import guard
    raise RuntimeError("Failed to load strategy_local_param_search module spec.")
MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MODULE)


class TestStrategyLocalParamSearch(unittest.TestCase):
    def test_parse_args_accepts_regime_segmented_settings(self) -> None:
        with mock.patch.object(
            MODULE.sys,
            "argv",
            [
                "strategy_local_param_search.py",
                "--fdr-method",
                "regime_segmented_bh",
                "--regime-method",
                "change_point",
                "--regime-max-segments",
                "5",
                "--regime-min-segment-bars",
                "288",
                "--regime-min-windows",
                "3",
                "--regime-aggregation",
                "weighted_mean",
            ],
        ):
            args = MODULE.parse_args()

        self.assertEqual(args.fdr_method, "regime_segmented_bh")
        self.assertEqual(args.regime_method, "change_point")
        self.assertEqual(args.regime_max_segments, 5)
        self.assertEqual(args.regime_min_segment_bars, 288)
        self.assertEqual(args.regime_min_windows, 3)
        self.assertEqual(args.regime_aggregation, "weighted_mean")

    def test_parse_args_accepts_cv_and_stability_settings(self) -> None:
        with mock.patch.object(
            MODULE.sys,
            "argv",
            [
                "strategy_local_param_search.py",
                "--fdr-method",
                "stability_bh",
                "--cv-agg-quantile",
                "0.8",
                "--stability-bootstraps",
                "80",
                "--stability-subsample-frac",
                "0.6",
                "--stability-min-frequency",
                "0.65",
                "--stability-select-p",
                "0.15",
            ],
        ):
            args = MODULE.parse_args()

        self.assertEqual(args.fdr_method, "stability_bh")
        self.assertAlmostEqual(args.cv_agg_quantile, 0.8)
        self.assertEqual(args.stability_bootstraps, 80)
        self.assertAlmostEqual(args.stability_subsample_frac, 0.6)
        self.assertAlmostEqual(args.stability_min_frequency, 0.65)
        self.assertAlmostEqual(args.stability_select_p, 0.15)

    def test_parse_args_accepts_wfo_target_and_low_complexity_profile(self) -> None:
        with mock.patch.object(
            MODULE.sys,
            "argv",
            [
                "strategy_local_param_search.py",
                "--target",
                "wfo",
                "--complexity-profile",
                "low",
            ],
        ):
            args = MODULE.parse_args()

        self.assertEqual(args.target, "wfo")
        self.assertEqual(args.complexity_profile, "low")

    def test_generate_trial_definitions_enforces_three_trend_candidates_with_fast_lt_slow(
        self,
    ) -> None:
        trials = MODULE.generate_trial_definitions(trials=8, seed=11, mode="local")
        self.assertEqual(len(trials), 8)
        self.assertEqual(trials[0]["anchorType"], "baseline")
        self.assertEqual(trials[1]["anchorType"], "known_best")

        for trial in trials:
            candidates = trial["candidates"]
            self.assertEqual(len(candidates), 3)
            for row in candidates:
                self.assertEqual(row["strategy"], "trend")
                params = row["params"]
                self.assertLess(params["trendFastPeriod"], params["trendSlowPeriod"])

    def test_generation_is_deterministic_for_same_seed(self) -> None:
        a = MODULE.generate_trial_definitions(trials=10, seed=2026, mode="local")
        b = MODULE.generate_trial_definitions(trials=10, seed=2026, mode="local")
        c = MODULE.generate_trial_definitions(trials=10, seed=2027, mode="local")

        self.assertEqual(a, b)
        self.assertNotEqual(a[2:], c[2:])

    def test_low_complexity_profile_enforces_long_only_simpler_ranges(self) -> None:
        trials = MODULE.generate_trial_definitions(
            trials=8,
            seed=2026,
            mode="local",
            complexity_profile="low",
        )
        for trial in trials:
            for row in trial["candidates"]:
                params = row["params"]
                self.assertFalse(params["allowShort"])
                self.assertGreaterEqual(params["trendFastPeriod"], 18)
                self.assertLessEqual(params["trendFastPeriod"], 34)
                self.assertGreaterEqual(params["trendSlowPeriod"], 60)
                self.assertLessEqual(params["trendSlowPeriod"], 120)

    def test_build_report_payload_contains_required_fields_and_improvement_math(self) -> None:
        trial_results = [
            {
                "trialId": 0,
                "trialLabel": "baseline_anchor",
                "anchorType": "baseline",
                "exitCode": 2,
                "metrics": {
                    "fdrQ": 0.3697723252360454,
                    "meanPbo": 0.15,
                    "meanDsrProbability": 0.66,
                },
                "params": MODULE.BASELINE_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(0, i, p, "baseline")
                    for i, p in enumerate(MODULE.BASELINE_ANCHOR)
                ],
            },
            {
                "trialId": 1,
                "trialLabel": "known_best_anchor",
                "anchorType": "known_best",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.33,
                    "meanPbo": 0.14,
                    "meanDsrProbability": 0.70,
                },
                "params": MODULE.KNOWN_BEST_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(1, i, p, "known_best")
                    for i, p in enumerate(MODULE.KNOWN_BEST_ANCHOR)
                ],
            },
        ]
        payload = MODULE.build_report_payload(
            repo_root=REPO_ROOT,
            mode="local",
            wfo_profile="shift",
            seed=20260303,
            trials_requested=2,
            trial_results=trial_results,
            fdr_method="regime_segmented_bh",
            regime_method="change_point",
            regime_max_segments=5,
            regime_min_segment_bars=288,
            regime_min_windows=3,
            regime_aggregation="weighted_mean",
        )

        self.assertEqual(payload["schemaVersion"], "local_param_search_report.v1")
        self.assertIn("top10", payload)
        self.assertIn("bestTrial", payload)
        self.assertIn("bestFdrQ", payload)
        self.assertIn("improvementAbs", payload)
        self.assertIn("improvementPct", payload)
        self.assertIn("thresholdBreak", payload)
        self.assertEqual(payload["bestFdrQ"], 0.33)
        self.assertAlmostEqual(payload["improvementAbs"], 0.03977232523604542)
        self.assertGreater(payload["improvementPct"], 0.0)
        self.assertTrue(payload["thresholdBreak"])
        self.assertEqual(len(payload["top10"]), 2)
        self.assertEqual(payload["fdrMethod"], "regime_segmented_bh")
        self.assertEqual(payload["regimeMethod"], "change_point")
        self.assertEqual(payload["regimeMaxSegments"], 5)
        self.assertEqual(payload["regimeMinSegmentBars"], 288)
        self.assertEqual(payload["regimeMinWindows"], 3)
        self.assertEqual(payload["regimeAggregation"], "weighted_mean")
        self.assertEqual(
            payload["regimeConfig"],
            {
                "method": "change_point",
                "maxSegments": 5,
                "minSegmentBars": 288,
                "minWindows": 3,
                "aggregation": "weighted_mean",
            },
        )

    def test_build_report_payload_supports_pbo_target_ranking(self) -> None:
        trial_results = [
            {
                "trialId": 10,
                "trialLabel": "low_fdr_high_pbo",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.08,
                    "meanPbo": 0.45,
                    "meanDsrProbability": 0.60,
                },
                "params": MODULE.BASELINE_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(10, i, p, "t10")
                    for i, p in enumerate(MODULE.BASELINE_ANCHOR)
                ],
            },
            {
                "trialId": 11,
                "trialLabel": "higher_fdr_lower_pbo",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.12,
                    "meanPbo": 0.19,
                    "meanDsrProbability": 0.55,
                },
                "params": MODULE.KNOWN_BEST_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(11, i, p, "t11")
                    for i, p in enumerate(MODULE.KNOWN_BEST_ANCHOR)
                ],
            },
        ]
        payload = MODULE.build_report_payload(
            repo_root=REPO_ROOT,
            mode="local",
            wfo_profile="shift",
            seed=20260303,
            trials_requested=2,
            trial_results=trial_results,
            target="pbo",
        )

        self.assertEqual(payload["target"], "pbo")
        self.assertEqual(payload["bestTrial"]["trialId"], 11)
        self.assertEqual(payload["bestMeanPbo"], 0.19)
        self.assertTrue(payload["pboThresholdBreak"])

    def test_build_report_payload_supports_wfo_target_ranking(self) -> None:
        trial_results = [
            {
                "trialId": 30,
                "trialLabel": "lower_fdr_higher_wfo",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.06,
                    "meanPbo": 0.18,
                    "meanDsrProbability": 0.65,
                    "wfoFailureDensity": 0.71,
                },
                "params": MODULE.BASELINE_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(30, i, p, "t30")
                    for i, p in enumerate(MODULE.BASELINE_ANCHOR)
                ],
            },
            {
                "trialId": 31,
                "trialLabel": "slightly_higher_fdr_lower_wfo",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.07,
                    "meanPbo": 0.19,
                    "meanDsrProbability": 0.62,
                    "wfoFailureDensity": 0.58,
                },
                "params": MODULE.KNOWN_BEST_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(31, i, p, "t31")
                    for i, p in enumerate(MODULE.KNOWN_BEST_ANCHOR)
                ],
            },
        ]
        payload = MODULE.build_report_payload(
            repo_root=REPO_ROOT,
            mode="local",
            wfo_profile="shift",
            seed=20260303,
            trials_requested=2,
            trial_results=trial_results,
            target="wfo",
        )

        self.assertEqual(payload["target"], "wfo")
        self.assertEqual(payload["bestTrial"]["trialId"], 31)
        self.assertAlmostEqual(payload["bestWfoFailureDensity"], 0.58)

    def test_constraint_fdr_prioritizes_feasible_trials(self) -> None:
        trial_results = [
            {
                "trialId": 20,
                "trialLabel": "best_pbo_but_fdr_fail",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.12,
                    "meanPbo": 0.10,
                    "meanDsrProbability": 0.60,
                },
                "params": MODULE.BASELINE_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(20, i, p, "t20")
                    for i, p in enumerate(MODULE.BASELINE_ANCHOR)
                ],
            },
            {
                "trialId": 21,
                "trialLabel": "fdr_feasible",
                "anchorType": "random",
                "exitCode": 0,
                "metrics": {
                    "fdrQ": 0.09,
                    "meanPbo": 0.18,
                    "meanDsrProbability": 0.55,
                },
                "params": MODULE.KNOWN_BEST_ANCHOR,
                "candidates": [
                    MODULE.candidate_from_params(21, i, p, "t21")
                    for i, p in enumerate(MODULE.KNOWN_BEST_ANCHOR)
                ],
            },
        ]
        payload = MODULE.build_report_payload(
            repo_root=REPO_ROOT,
            mode="local",
            wfo_profile="shift",
            seed=20260303,
            trials_requested=2,
            trial_results=trial_results,
            target="pbo",
            constraint="fdr",
            fdr_max=0.1,
        )

        self.assertEqual(payload["constraint"], "fdr")
        self.assertEqual(payload["feasibleCount"], 1)
        self.assertTrue(payload["bestTrialConstraintSatisfied"])
        self.assertEqual(payload["bestTrial"]["trialId"], 21)

    def test_run_trial_validation_forwards_regime_segmented_args(self) -> None:
        trial = MODULE.build_anchor_trial(
            trial_id=0,
            trial_label="baseline_anchor",
            anchor_type="baseline",
            anchor_params=MODULE.BASELINE_ANCHOR,
        )

        with mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(args=["pnpm"], returncode=0),
        ):
            result = MODULE.run_trial_validation(
                repo_root=REPO_ROOT,
                base_cfg={"schemaVersion": "strategy_candidates.v1"},
                trial=trial,
                wfo_profile="shift",
                fdr_method="regime_segmented_bh",
                fdr_storey_lambda=0.5,
                regime_method="change_point",
                regime_max_segments=5,
                regime_min_segment_bars=288,
                regime_min_windows=3,
                regime_aggregation="weighted_mean",
            )

        command = result["command"]
        self.assertIn("--fdr-method", command)
        self.assertIn("regime_segmented_bh", command)
        self.assertIn("--regime-method", command)
        self.assertIn("change_point", command)
        self.assertIn("--regime-max-segments", command)
        self.assertIn("5", command)
        self.assertIn("--regime-min-segment-bars", command)
        self.assertIn("288", command)
        self.assertIn("--regime-min-windows", command)
        self.assertIn("3", command)
        self.assertIn("--regime-aggregation", command)
        self.assertIn("weighted_mean", command)

    def test_run_trial_validation_forwards_cv_args(self) -> None:
        trial = MODULE.build_anchor_trial(
            trial_id=0,
            trial_label="baseline_anchor",
            anchor_type="baseline",
            anchor_params=MODULE.BASELINE_ANCHOR,
        )
        with mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(args=["pnpm"], returncode=0),
        ):
            result = MODULE.run_trial_validation(
                repo_root=REPO_ROOT,
                base_cfg={"schemaVersion": "strategy_candidates.v1"},
                trial=trial,
                wfo_profile="shift",
                fdr_method="cv_storey_bh",
                fdr_storey_lambda=0.5,
                cv_agg_quantile=0.8,
            )
        command = result["command"]
        self.assertIn("--fdr-method", command)
        self.assertIn("cv_storey_bh", command)
        self.assertIn("--cv-agg-quantile", command)
        self.assertIn("0.8", command)

    def test_run_trial_validation_forwards_stability_args(self) -> None:
        trial = MODULE.build_anchor_trial(
            trial_id=0,
            trial_label="baseline_anchor",
            anchor_type="baseline",
            anchor_params=MODULE.BASELINE_ANCHOR,
        )
        with mock.patch.object(
            MODULE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(args=["pnpm"], returncode=0),
        ):
            result = MODULE.run_trial_validation(
                repo_root=REPO_ROOT,
                base_cfg={"schemaVersion": "strategy_candidates.v1"},
                trial=trial,
                wfo_profile="shift",
                fdr_method="stability_bh",
                fdr_storey_lambda=0.5,
                stability_bootstraps=80,
                stability_subsample_frac=0.6,
                stability_min_frequency=0.65,
                stability_select_p=0.15,
            )
        command = result["command"]
        self.assertIn("--fdr-method", command)
        self.assertIn("stability_bh", command)
        self.assertIn("--stability-bootstraps", command)
        self.assertIn("80", command)
        self.assertIn("--stability-subsample-frac", command)
        self.assertIn("0.6", command)
        self.assertIn("--stability-min-frequency", command)
        self.assertIn("0.65", command)
        self.assertIn("--stability-select-p", command)
        self.assertIn("0.15", command)


if __name__ == "__main__":
    unittest.main()
