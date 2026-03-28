#!/usr/bin/env python3
"""Tests for build_quant_policy_pack script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_quant_policy_pack.py"


class TestBuildQuantPolicyPack(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_builder(
        self,
        *,
        repo_root: Path,
        stagea_path: Path,
        stageb_path: Path,
        precontinue_path: Path,
        output_path: Path,
        markdown_path: Path,
    ) -> dict[str, Any]:
        run = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--repo-root",
                str(repo_root),
                "--stagea",
                str(stagea_path),
                "--stageb",
                str(stageb_path),
                "--precontinue",
                str(precontinue_path),
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
        self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
        self.assertTrue(output_path.exists(), msg=run.stdout)
        self.assertTrue(markdown_path.exists(), msg=run.stdout)
        return json.loads(output_path.read_text(encoding="utf-8"))

    def test_rebuild_mode_when_stageb_recommends_rebuild(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-policy-pack-") as tmp:
            root = Path(tmp)
            stagea_path = root / "in/stagea.json"
            stageb_path = root / "in/stageb.json"
            precontinue_path = root / "in/precontinue.json"
            output_path = root / "out/quant_policy_pack.v1.json"
            markdown_path = root / "out/quant_policy_pack.md"

            self.write_json(stagea_path, {"decision": {"passed": False, "nextStage": "stageB"}})
            self.write_json(
                stageb_path,
                {
                    "decision": {
                        "recommendedOptionId": "launch_strategy_rebuild",
                        "deadline": "2026-03-07T23:59:59Z",
                    },
                    "evidenceSummary": {"matrixFdrQMedian": 0.88},
                },
            )
            self.write_json(
                precontinue_path,
                {"decision": {"primaryRecommendation": "strategy_rebuild"}},
            )

            payload = self.run_builder(
                repo_root=root,
                stagea_path=stagea_path,
                stageb_path=stageb_path,
                precontinue_path=precontinue_path,
                output_path=output_path,
                markdown_path=markdown_path,
            )
            self.assertEqual(payload["schemaVersion"], "quant_policy_pack.v1")
            self.assertEqual(payload["policyMode"], "rebuild_mode")
            self.assertEqual(payload["gatePolicy"]["recommendedRoute"], "stageC_rebuild")


if __name__ == "__main__":
    unittest.main()
