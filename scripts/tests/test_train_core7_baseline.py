#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "train_core7_baseline.py"


class TestTrainCore7Baseline(unittest.TestCase):
    def test_train_baseline_reads_feature_table_and_writes_summary(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-train-core7-") as tmp:
            root = Path(tmp)
            data_path = root / "features.csv"
            summary_path = root / "summary.json"
            rows = []
            for i in range(120):
                rows.append(
                    {
                        "timestamp_ms": 1700000000000 + i * 60000,
                        "okx_inst_id": "BTC-USDT",
                        "okx_market": "spot",
                        "base": "BTC",
                        "quote": "USDT",
                        "okx_ret_1m": float(i % 5) / 100.0,
                        "spread_spot_pct": float(i % 7) / 100.0,
                        "spot_volume_ratio": float(i % 3) + 1.0,
                        "label_dir_fwd_5m": 1 if i % 2 == 0 else 0,
                    }
                )
            pd.DataFrame(rows).to_csv(data_path, index=False)

            cmd = [
                sys.executable,
                str(SCRIPT_PATH),
                "--input",
                str(data_path),
                "--label-col",
                "label_dir_fwd_5m",
                "--output",
                str(summary_path),
            ]
            run = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True, check=False)
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["labelCol"], "label_dir_fwd_5m")
            self.assertGreater(payload["splits"]["trainRows"], 0)
            self.assertGreater(payload["features"]["count"], 0)
            self.assertIn("test_accuracy", payload["metrics"])


if __name__ == "__main__":
    unittest.main()
