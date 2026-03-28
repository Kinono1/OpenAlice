#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "run_core7_feature_pipeline.sh"


class TestRunCore7FeaturePipeline(unittest.TestCase):
    def test_pipeline_dry_run_constructs_steps(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-pipeline-dryrun-") as tmp:
            env = {
                "DRY_RUN": "1",
                "OKX_INPUT_ROOT": f"{tmp}/okx",
                "BINANCE_INPUT_ROOT": f"{tmp}/binance",
                "OKX_NORM_ROOT": f"{tmp}/okx_norm",
                "BINANCE_NORM_ROOT": f"{tmp}/binance_norm",
                "FEATURE_ROOT": f"{tmp}/feature",
                "TRAIN_ROOT": f"{tmp}/models",
            }
            run = subprocess.run(
                ["bash", str(SCRIPT_PATH)],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
                env={**env, **dict()},
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertIn("=== normalize_okx ===", run.stdout)
            self.assertIn("=== normalize_binance ===", run.stdout)
            self.assertIn("=== build_feature_base ===", run.stdout)
            self.assertIn("=== train_baseline ===", run.stdout)


if __name__ == "__main__":
    unittest.main()
