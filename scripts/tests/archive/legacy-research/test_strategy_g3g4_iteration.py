#!/usr/bin/env python3
"""Tests for strategy_g3g4_iteration script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "strategy_g3g4_iteration.py"


class TestStrategyG3G4Iteration(unittest.TestCase):
    def test_plan_mode_writes_latest_and_archive_reports(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter",
                    "--profile",
                    "fast",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            latest_json = out_dir / "latest_strategy_g3g4_iteration.json"
            archive_json = out_dir / "archive" / "unit-test-iter" / "strategy_g3g4_iteration.json"
            self.assertTrue(latest_json.exists())
            self.assertTrue(archive_json.exists())

            payload = json.loads(latest_json.read_text(encoding="utf-8"))
            self.assertEqual(payload["mode"], "plan")
            self.assertEqual(payload["run_id"], "unit-test-iter")
            self.assertEqual(payload["protocol_profile"], "shift")
            self.assertEqual(payload["fdr_method"], "bh")
            self.assertEqual(payload["regime_method"], "change_point")
            self.assertEqual(payload["regime_max_segments"], 4)
            self.assertEqual(payload["regime_min_segment_bars"], 240)
            self.assertEqual(payload["regime_min_windows"], 2)
            self.assertEqual(payload["regime_aggregation"], "weighted_mean")
            self.assertEqual(payload["plan"], "legacy")
            self.assertFalse(payload["no_expand_candidates"])
            self.assertEqual(payload["plan_switch_reason"], "")
            self.assertEqual(payload["research_digest_id"], "")
            self.assertFalse(payload["with_phaseb_search"])
            self.assertFalse(payload["with_hypothesis_candidates"])
            self.assertEqual(payload["hypothesis_candidate_mode"], "auto")
            self.assertEqual(payload["candidate_complexity_profile"], "default")
            self.assertEqual(
                payload["best_triplet_path"],
                "data/research/strategy/local_search/best_trend_triplet.latest.v1.json",
            )
            self.assertFalse(payload["phaseb_search_effective"])
            self.assertFalse(payload["hypothesis_candidates_effective"])
            command_names = [item["name"] for item in payload.get("commands", [])]
            self.assertNotIn("phaseb_search", command_names)
            self.assertNotIn("hypothesis_candidates_compile", command_names)
            self.assertIn("strategy_mvp", command_names)
            self.assertIn("decision_validate", command_names)
            self.assertIn("g3g4_failure_breakdown", command_names)
            strategy_mvp_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "strategy_mvp"
            )
            self.assertIn("--wfo-profile", strategy_mvp_cmd)
            self.assertIn("shift", strategy_mvp_cmd)
            self.assertIn("--fdr-method", strategy_mvp_cmd)
            self.assertIn("bh", strategy_mvp_cmd)
            self.assertNotIn("--regime-method", strategy_mvp_cmd)
            self.assertNotIn("--regime-max-segments", strategy_mvp_cmd)
            self.assertNotIn("--regime-min-segment-bars", strategy_mvp_cmd)
            self.assertNotIn("--regime-min-windows", strategy_mvp_cmd)
            self.assertNotIn("--regime-aggregation", strategy_mvp_cmd)

            latest_md = (out_dir / "latest_strategy_g3g4_iteration.md").read_text(encoding="utf-8")
            self.assertIn("- plan: `legacy`", latest_md)
            self.assertIn("- fdr_method: `bh`", latest_md)
            self.assertIn("- regime_method: `change_point`", latest_md)
            self.assertIn("- regime_max_segments: `4`", latest_md)
            self.assertIn("- regime_min_segment_bars: `240`", latest_md)
            self.assertIn("- regime_min_windows: `2`", latest_md)
            self.assertIn("- regime_aggregation: `weighted_mean`", latest_md)
            self.assertIn("- no_expand_candidates: `False`", latest_md)
            self.assertIn("- plan_switch_reason: ``", latest_md)
            self.assertIn("- research_digest_id: ``", latest_md)
            self.assertIn("- with_hypothesis_candidates: `False`", latest_md)
            self.assertIn("- hypothesis_candidate_mode: `auto`", latest_md)
            self.assertIn("- candidate_complexity_profile: `default`", latest_md)
            self.assertIn(
                "- best_triplet_path: `data/research/strategy/local_search/best_trend_triplet.latest.v1.json`",
                latest_md,
            )
            self.assertIn("- phaseb_search_effective: `False`", latest_md)
            self.assertIn("- hypothesis_candidates_effective: `False`", latest_md)

    def test_plan_mode_includes_phaseb_search_when_flag_enabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-phaseb",
                    "--profile",
                    "fast",
                    "--with-phaseb-search",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertTrue(payload["with_phaseb_search"])
            self.assertFalse(payload["with_hypothesis_candidates"])
            self.assertFalse(payload["no_expand_candidates"])
            self.assertTrue(payload["phaseb_search_effective"])
            self.assertFalse(payload["hypothesis_candidates_effective"])

            command_names = [item["name"] for item in payload.get("commands", [])]
            self.assertIn("phaseb_search", command_names)
            self.assertLess(command_names.index("phaseb_search"), command_names.index("strategy_mvp"))

            phaseb_cmd = next(
                item["command"] for item in payload.get("commands", []) if item.get("name") == "phaseb_search"
            )
            self.assertEqual(phaseb_cmd, "pnpm run strategy:g3g4:phaseb-search")

    def test_plan_mode_includes_hypothesis_compile_when_flag_enabled(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-hypothesis",
                    "--profile",
                    "fast",
                    "--plan",
                    "A",
                    "--fdr-method",
                    "storey_bh",
                    "--with-hypothesis-candidates",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertTrue(payload["with_hypothesis_candidates"])
            self.assertTrue(payload["hypothesis_candidates_effective"])
            self.assertEqual(payload["fdr_method"], "storey_bh")
            command_names = [item["name"] for item in payload.get("commands", [])]
            self.assertIn("hypothesis_candidates_compile", command_names)
            self.assertLess(
                command_names.index("hypothesis_candidates_compile"),
                command_names.index("strategy_mvp"),
            )
            compile_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "hypothesis_candidates_compile"
            )
            self.assertIn("scripts/research_hypothesis_to_candidates.py", compile_cmd)
            self.assertIn("--plan", compile_cmd)
            self.assertIn("A", compile_cmd)
            self.assertIn("--candidate-mode", compile_cmd)
            self.assertIn("auto", compile_cmd)
            self.assertIn("--complexity-profile", compile_cmd)
            self.assertIn("default", compile_cmd)
            self.assertIn("--best-triplet", compile_cmd)
            self.assertIn("best_trend_triplet.latest.v1.json", compile_cmd)
            strategy_mvp_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "strategy_mvp"
            )
            self.assertIn("--fdr-method", strategy_mvp_cmd)
            self.assertIn("storey_bh", strategy_mvp_cmd)

    def test_plan_mode_forwards_low_complexity_profile_to_hypothesis_compile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-hypothesis-low",
                    "--profile",
                    "fast",
                    "--plan",
                    "A",
                    "--with-hypothesis-candidates",
                    "--candidate-complexity-profile",
                    "low",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["candidate_complexity_profile"], "low")
            compile_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "hypothesis_candidates_compile"
            )
            self.assertIn("--complexity-profile", compile_cmd)
            self.assertIn("low", compile_cmd)

    def test_plan_mode_forwards_regime_segmented_fdr_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-regime",
                    "--profile",
                    "fast",
                    "--plan",
                    "A",
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
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["fdr_method"], "regime_segmented_bh")
            self.assertEqual(payload["regime_method"], "change_point")
            self.assertEqual(payload["regime_max_segments"], 5)
            self.assertEqual(payload["regime_min_segment_bars"], 288)
            self.assertEqual(payload["regime_min_windows"], 3)
            self.assertEqual(payload["regime_aggregation"], "weighted_mean")

            strategy_mvp_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "strategy_mvp"
            )
            self.assertIn("--fdr-method", strategy_mvp_cmd)
            self.assertIn("regime_segmented_bh", strategy_mvp_cmd)
            self.assertIn("--regime-method", strategy_mvp_cmd)
            self.assertIn("change_point", strategy_mvp_cmd)
            self.assertIn("--regime-max-segments", strategy_mvp_cmd)
            self.assertIn("5", strategy_mvp_cmd)
            self.assertIn("--regime-min-segment-bars", strategy_mvp_cmd)
            self.assertIn("288", strategy_mvp_cmd)
            self.assertIn("--regime-min-windows", strategy_mvp_cmd)
            self.assertIn("3", strategy_mvp_cmd)
            self.assertIn("--regime-aggregation", strategy_mvp_cmd)
            self.assertIn("weighted_mean", strategy_mvp_cmd)

    def test_plan_mode_forwards_cv_storey_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-cv",
                    "--profile",
                    "fast",
                    "--plan",
                    "A",
                    "--fdr-method",
                    "cv_storey_bh",
                    "--cv-agg-quantile",
                    "0.8",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["fdr_method"], "cv_storey_bh")
            self.assertEqual(payload["cv_agg_quantile"], 0.8)
            strategy_mvp_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "strategy_mvp"
            )
            self.assertIn("--fdr-method", strategy_mvp_cmd)
            self.assertIn("cv_storey_bh", strategy_mvp_cmd)
            self.assertIn("--cv-agg-quantile", strategy_mvp_cmd)
            self.assertIn("0.8", strategy_mvp_cmd)

    def test_plan_mode_forwards_stability_config(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-iter-stability",
                    "--profile",
                    "fast",
                    "--plan",
                    "A",
                    "--fdr-method",
                    "stability_bh",
                    "--stability-bootstraps",
                    "80",
                    "--stability-subsample-frac",
                    "0.6",
                    "--stability-min-frequency",
                    "0.65",
                    "--stability-select-p",
                    "0.15",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["fdr_method"], "stability_bh")
            self.assertEqual(payload["stability_bootstraps"], 80)
            self.assertEqual(payload["stability_subsample_frac"], 0.6)
            self.assertEqual(payload["stability_min_frequency"], 0.65)
            self.assertEqual(payload["stability_select_p"], 0.15)
            strategy_mvp_cmd = next(
                item["command"]
                for item in payload.get("commands", [])
                if item.get("name") == "strategy_mvp"
            )
            self.assertIn("--fdr-method", strategy_mvp_cmd)
            self.assertIn("stability_bh", strategy_mvp_cmd)
            self.assertIn("--stability-bootstraps", strategy_mvp_cmd)
            self.assertIn("80", strategy_mvp_cmd)
            self.assertIn("--stability-subsample-frac", strategy_mvp_cmd)
            self.assertIn("0.6", strategy_mvp_cmd)
            self.assertIn("--stability-min-frequency", strategy_mvp_cmd)
            self.assertIn("0.65", strategy_mvp_cmd)
            self.assertIn("--stability-select-p", strategy_mvp_cmd)
            self.assertIn("0.15", strategy_mvp_cmd)

    def test_no_expand_candidates_disables_phaseb_search(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-no-expand",
                    "--profile",
                    "fast",
                    "--plan",
                    "B",
                    "--with-phaseb-search",
                    "--with-hypothesis-candidates",
                    "--no-expand-candidates",
                    "--plan-switch-reason",
                    "keep-family-fixed",
                    "--research-digest-id",
                    "digest-20260303",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            payload = json.loads(
                (out_dir / "latest_strategy_g3g4_iteration.json").read_text(encoding="utf-8")
            )
            self.assertEqual(payload["plan"], "B")
            self.assertTrue(payload["with_phaseb_search"])
            self.assertTrue(payload["with_hypothesis_candidates"])
            self.assertEqual(payload["hypothesis_candidate_mode"], "auto")
            self.assertEqual(
                payload["best_triplet_path"],
                "data/research/strategy/local_search/best_trend_triplet.latest.v1.json",
            )
            self.assertTrue(payload["no_expand_candidates"])
            self.assertFalse(payload["phaseb_search_effective"])
            self.assertFalse(payload["hypothesis_candidates_effective"])
            self.assertEqual(payload["plan_switch_reason"], "keep-family-fixed")
            self.assertEqual(payload["research_digest_id"], "digest-20260303")

            command_names = [item["name"] for item in payload.get("commands", [])]
            self.assertNotIn("phaseb_search", command_names)
            self.assertNotIn("hypothesis_candidates_compile", command_names)
            self.assertIn("strategy_mvp", command_names)

            latest_md = (out_dir / "latest_strategy_g3g4_iteration.md").read_text(encoding="utf-8")
            self.assertIn("- plan: `B`", latest_md)
            self.assertIn("- no_expand_candidates: `True`", latest_md)
            self.assertIn("- plan_switch_reason: `keep-family-fixed`", latest_md)
            self.assertIn("- research_digest_id: `digest-20260303`", latest_md)
            self.assertIn("- with_hypothesis_candidates: `True`", latest_md)
            self.assertIn("- hypothesis_candidate_mode: `auto`", latest_md)
            self.assertIn("- candidate_complexity_profile: `default`", latest_md)
            self.assertIn(
                "- best_triplet_path: `data/research/strategy/local_search/best_trend_triplet.latest.v1.json`",
                latest_md,
            )
            self.assertIn("- hypothesis_candidates_effective: `False`", latest_md)

    def test_plan_c_with_phaseb_search_fails_fast(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-plan-c-conflict",
                    "--plan",
                    "C",
                    "--with-phaseb-search",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 2)
            self.assertIn("--with-phaseb-search cannot be used with --plan C", run.stderr)

            latest_json = out_dir / "latest_strategy_g3g4_iteration.json"
            self.assertFalse(latest_json.exists())

    def test_locked_mode_with_no_expand_candidates_fails_fast(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-g3g4-iteration-") as tmp:
            out_dir = Path(tmp) / "runs"
            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--out-dir",
                    str(out_dir),
                    "--run-id",
                    "unit-test-lock-no-expand-conflict",
                    "--plan",
                    "B",
                    "--with-hypothesis-candidates",
                    "--hypothesis-candidate-mode",
                    "lock_best_triplet",
                    "--no-expand-candidates",
                    "--dry-run",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 2)
            self.assertIn(
                "--no-expand-candidates cannot be combined with --with-hypothesis-candidates",
                run.stderr,
            )

            latest_json = out_dir / "latest_strategy_g3g4_iteration.json"
            self.assertFalse(latest_json.exists())


if __name__ == "__main__":
    unittest.main()
