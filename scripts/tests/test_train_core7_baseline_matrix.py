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
MATRIX_SCRIPT = REPO_ROOT / "scripts" / "train_core7_baseline_matrix.py"
TRAIN_SCRIPT = REPO_ROOT / "scripts" / "train_core7_baseline.py"


class TestTrainCore7BaselineMatrix(unittest.TestCase):
    def write_zst_csv(self, path: Path, frame: pd.DataFrame) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        plain = path.with_suffix("")
        frame.to_csv(plain, index=False)
        subprocess.run(["zstd", "-q", "-f", str(plain), "-o", str(path)], check=True)
        plain.unlink(missing_ok=True)

    def test_matrix_runs_over_multiple_inst_ids(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-core7-matrix-") as tmp:
            root = Path(tmp)
            feature_root = root / "feature"
            output_dir = root / "models"
            for inst_id in ("BTC-USDT", "ETH-USDT"):
                rows = []
                for i in range(120):
                    rows.append(
                        {
                            "timestamp_ms": 1700000000000 + i * 60000,
                            "okx_inst_id": inst_id,
                            "okx_market": "spot",
                            "base": inst_id.split("-")[0],
                            "quote": "USDT",
                            "okx_ret_1m": float(i % 5) / 100.0,
                            "spread_spot_pct": float(i % 7) / 100.0,
                            "spot_volume_ratio": float(i % 3) + 1.0,
                            "label_dir_fwd_5m": 1 if i % 2 == 0 else 0,
                        }
                    )
                self.write_zst_csv(
                    feature_root / f"okx_inst_id={inst_id}" / "data.csv.zst",
                    pd.DataFrame(rows),
                )

            cmd = [
                sys.executable,
                str(MATRIX_SCRIPT),
                "--feature-root",
                str(feature_root),
                "--output-dir",
                str(output_dir),
                "--labels",
                "label_dir_fwd_5m",
                "--python-bin",
                sys.executable,
            ]
            run = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True, check=False)
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            summary_path = output_dir / "core7_baseline_matrix.summary.json"
            self.assertTrue(summary_path.exists())
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["jobs"], 2)
            self.assertEqual(payload["totals"]["successfulJobs"], 2)
            self.assertEqual(len(payload["leaderboard"]), 2)


if __name__ == "__main__":
    unittest.main()
