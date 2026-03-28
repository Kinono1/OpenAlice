#!/usr/bin/env python3
"""Tests for research_plan_switch script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Dict, Iterable, Optional, Sequence, Tuple


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_plan_switch.py"


class TestResearchPlanSwitch(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def make_archive_run(
        self,
        *,
        archive_root: Path,
        dirname: str,
        run_id: str,
        generated_at: str,
        protocol_profile: str,
        fdr_q: float,
        regime_wfo_by_bucket: Dict[str, float],
        plan: Optional[str] = None,
        protocol_ablation_profiles: Optional[Sequence[Tuple[str, float]]] = None,
    ) -> None:
        run_dir = archive_root / dirname
        iteration_payload = {
            "run_id": run_id,
            "generated_at": generated_at,
            "protocol_profile": protocol_profile,
        }
        if plan is not None:
            iteration_payload["plan"] = plan

        breakdown_payload = {
            "verdict": {"aggregateMetrics": {"fdrQ": fdr_q}},
            "wfo_diagnostics": {
                "regimeBuckets": {
                    key: {"wfoFailureDensity": value}
                    for key, value in regime_wfo_by_bucket.items()
                }
            },
        }
        if protocol_ablation_profiles is not None:
            breakdown_payload["protocolAblation"] = {
                "profiles": [
                    {"profile": profile, "wfoFailureDensity": density}
                    for profile, density in protocol_ablation_profiles
                ]
            }

        self.write_json(run_dir / "strategy_g3g4_iteration.json", iteration_payload)
        self.write_json(
            run_dir
            / "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json",
            breakdown_payload,
        )

    def run_switchboard(
        self,
        *,
        archive_root: Path,
        output_path: Path,
        extra_args: Iterable[str] = (),
    ) -> Dict[str, object]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--archive-root",
            str(archive_root),
            "--output",
            str(output_path),
            *list(extra_args),
        ]
        run = subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr)
        self.assertTrue(output_path.exists(), msg=run.stdout)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_scores_and_selects_primary_from_run_id_prefix(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day1",
                run_id="A-20260301T090000Z",
                generated_at="2026-03-01T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.20,
                regime_wfo_by_bucket={"trend": 0.50},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day1",
                run_id="B-20260301T091000Z",
                generated_at="2026-03-01T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.20,
                regime_wfo_by_bucket={"trend": 0.50},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day2",
                run_id="A-20260302T090000Z",
                generated_at="2026-03-02T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.17,
                regime_wfo_by_bucket={"trend": 0.40},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day2",
                run_id="B-20260302T091000Z",
                generated_at="2026-03-02T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.22,
                regime_wfo_by_bucket={"trend": 0.55},
            )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertEqual(payload["schemaVersion"], "plan_switchboard.v1")
            self.assertEqual(payload["decision"]["nextPrimaryPlan"], "A")
            self.assertEqual(payload["decision"]["nextSecondaryPlan"], "B")
            self.assertFalse(payload["decision"]["forcedC"])
            self.assertGreater(payload["plans"]["A"]["score"], payload["plans"]["B"]["score"])
            self.assertIn(
                "INFO_PRIMARY_A_SCORE_HIGHER",
                payload["decision"]["reasonCodes"],
            )

    def test_forced_c_when_two_consecutive_days_non_positive(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            days = [
                ("2026-03-01", 0.30, 0.50, 0.30, 0.50),
                ("2026-03-02", 0.25, 0.40, 0.27, 0.45),
                ("2026-03-03", 0.27, 0.46, 0.29, 0.50),
                ("2026-03-04", 0.29, 0.50, 0.31, 0.54),
            ]
            for idx, (day, a_fdr, a_wfo, b_fdr, b_wfo) in enumerate(days, start=1):
                self.make_archive_run(
                    archive_root=archive_root,
                    dirname=f"a-day{idx}",
                    run_id=f"A-2026030{idx}T090000Z",
                    generated_at=f"{day}T09:00:00+00:00",
                    protocol_profile="shift",
                    fdr_q=a_fdr,
                    regime_wfo_by_bucket={"trend": a_wfo},
                )
                self.make_archive_run(
                    archive_root=archive_root,
                    dirname=f"b-day{idx}",
                    run_id=f"B-2026030{idx}T091000Z",
                    generated_at=f"{day}T09:10:00+00:00",
                    protocol_profile="shift",
                    fdr_q=b_fdr,
                    regime_wfo_by_bucket={"trend": b_wfo},
                )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertTrue(payload["decision"]["forcedC"])
            self.assertEqual(payload["decision"]["nextPrimaryPlan"], "C")
            self.assertIn(
                "HARD_FORCED_C_TWO_DAY_NON_POSITIVE",
                payload["decision"]["reasonCodes"],
            )
            self.assertNotIn(
                "HARD_FORCED_C_LOW_7D_FDR_IMPROVEMENT",
                payload["decision"]["reasonCodes"],
            )

    def test_forced_c_when_seven_day_best_fdr_improvement_is_too_low(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            days = [
                ("2026-03-01", 0.30, 0.50, 0.30, 0.50),
                ("2026-03-02", 0.29, 0.40, 0.295, 0.40),
                ("2026-03-03", 0.281, 0.35, 0.289, 0.36),
            ]
            for idx, (day, a_fdr, a_wfo, b_fdr, b_wfo) in enumerate(days, start=1):
                self.make_archive_run(
                    archive_root=archive_root,
                    dirname=f"a-day{idx}",
                    run_id=f"A-2026030{idx}T090000Z",
                    generated_at=f"{day}T09:00:00+00:00",
                    protocol_profile="shift",
                    fdr_q=a_fdr,
                    regime_wfo_by_bucket={"trend": a_wfo},
                )
                self.make_archive_run(
                    archive_root=archive_root,
                    dirname=f"b-day{idx}",
                    run_id=f"B-2026030{idx}T091000Z",
                    generated_at=f"{day}T09:10:00+00:00",
                    protocol_profile="shift",
                    fdr_q=b_fdr,
                    regime_wfo_by_bucket={"trend": b_wfo},
                )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertTrue(payload["decision"]["forcedC"])
            self.assertEqual(payload["decision"]["nextPrimaryPlan"], "C")
            self.assertIn(
                "HARD_FORCED_C_LOW_7D_FDR_IMPROVEMENT",
                payload["decision"]["reasonCodes"],
            )
            self.assertNotIn(
                "HARD_FORCED_C_TWO_DAY_NON_POSITIVE",
                payload["decision"]["reasonCodes"],
            )

    def test_wfo_prefers_run_level_regime_bucket_mean(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day1",
                run_id="A-20260301T090000Z",
                generated_at="2026-03-01T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.70},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day1",
                run_id="B-20260301T091000Z",
                generated_at="2026-03-01T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.70},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day2",
                run_id="A-20260302T090000Z",
                generated_at="2026-03-02T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.28,
                regime_wfo_by_bucket={"trend": 0.20, "ensemble": 0.30},
                protocol_ablation_profiles=(("stable", 0.11), ("shift", 0.83)),
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day2",
                run_id="B-20260302T091000Z",
                generated_at="2026-03-02T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.31,
                regime_wfo_by_bucket={"trend": 0.72},
            )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertAlmostEqual(payload["plans"]["A"]["wfoFailureDensity"], 0.25, places=6)
            self.assertEqual(payload["plans"]["A"]["runId"], "A-20260302T090000Z")

    def test_wfo_fallbacks_to_regime_bucket_mean(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day1",
                run_id="A-20260301T090000Z",
                generated_at="2026-03-01T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.60},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day1",
                run_id="B-20260301T091000Z",
                generated_at="2026-03-01T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.60},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day2",
                run_id="A-20260302T090000Z",
                generated_at="2026-03-02T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.29,
                regime_wfo_by_bucket={"trend": 0.30, "ensemble": 0.50},
                protocol_ablation_profiles=(("stable", 0.95),),
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day2",
                run_id="B-20260302T091000Z",
                generated_at="2026-03-02T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.28,
                regime_wfo_by_bucket={"trend": 0.58},
            )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertAlmostEqual(payload["plans"]["A"]["wfoFailureDensity"], 0.40, places=6)

    def test_wfo_fallbacks_to_protocol_ablation_when_regime_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-plan-switch-") as tmp:
            root = Path(tmp)
            archive_root = root / "archive"
            output_path = root / "switchboard.json"

            self.make_archive_run(
                archive_root=archive_root,
                dirname="a-day1",
                run_id="A-20260301T090000Z",
                generated_at="2026-03-01T09:00:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.60},
            )
            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day1",
                run_id="B-20260301T091000Z",
                generated_at="2026-03-01T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.30,
                regime_wfo_by_bucket={"trend": 0.60},
            )

            run_dir = archive_root / "a-day2"
            self.write_json(
                run_dir / "strategy_g3g4_iteration.json",
                {
                    "run_id": "A-20260302T090000Z",
                    "generated_at": "2026-03-02T09:00:00+00:00",
                    "protocol_profile": "shift",
                    "plan": "A",
                },
            )
            self.write_json(
                run_dir / "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json",
                {
                    "verdict": {"aggregateMetrics": {"fdrQ": 0.29}},
                    "protocolAblation": {
                        "profiles": [
                            {"profile": "stable", "wfoFailureDensity": 0.95},
                            {"profile": "shift", "wfoFailureDensity": 0.77},
                        ]
                    },
                },
            )

            self.make_archive_run(
                archive_root=archive_root,
                dirname="b-day2",
                run_id="B-20260302T091000Z",
                generated_at="2026-03-02T09:10:00+00:00",
                protocol_profile="shift",
                fdr_q=0.28,
                regime_wfo_by_bucket={"trend": 0.58},
            )

            payload = self.run_switchboard(
                archive_root=archive_root,
                output_path=output_path,
                extra_args=["--window", "1"],
            )

            self.assertAlmostEqual(payload["plans"]["A"]["wfoFailureDensity"], 0.77, places=6)


if __name__ == "__main__":
    unittest.main()
