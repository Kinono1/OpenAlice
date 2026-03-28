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
SCRIPT_PATH = REPO_ROOT / "scripts" / "build_core7_feature_base.py"


class TestBuildCore7FeatureBase(unittest.TestCase):
    def write_csv(self, path: Path, frame: pd.DataFrame) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(path, index=False)

    def test_build_feature_base_joins_and_labels(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-feature-base-") as tmp:
            root = Path(tmp)
            okx_root = root / "okx_norm"
            binance_root = root / "binance_norm"
            output_root = root / "feature"
            summary = root / "summary.json"

            ts = [1700000000000 + 60000 * i for i in range(12)]
            okx_spot = pd.DataFrame(
                {
                    "timestamp_ms": ts,
                    "iso_utc": [f"t{i}" for i in range(12)],
                    "symbol": ["BTC-USDT"] * 12,
                    "market": ["spot"] * 12,
                    "exchange": ["okx"] * 12,
                    "timeframe": ["1m"] * 12,
                    "open": [100 + i for i in range(12)],
                    "high": [101 + i for i in range(12)],
                    "low": [99 + i for i in range(12)],
                    "close": [100 + i for i in range(12)],
                    "volume": [10 + i for i in range(12)],
                }
            )
            okx_swap = okx_spot.copy()
            okx_swap["symbol"] = "BTC-USDT-SWAP"
            okx_swap["market"] = "swap"
            okx_swap["close"] = [100.5 + i for i in range(12)]
            okx_swap["volume"] = [20 + i for i in range(12)]
            b_spot = pd.DataFrame(
                {
                    "timestamp_ms": ts,
                    "iso_utc": [f"t{i}" for i in range(12)],
                    "close_time_ms": ts,
                    "open": [200 + i for i in range(12)],
                    "high": [201 + i for i in range(12)],
                    "low": [199 + i for i in range(12)],
                    "close": [200 + i for i in range(12)],
                    "volume": [30 + i for i in range(12)],
                    "quote_volume": [300 + i for i in range(12)],
                    "trades_count": [40 + i for i in range(12)],
                    "taker_buy_base": [15 + i for i in range(12)],
                    "taker_buy_quote": [150 + i for i in range(12)],
                    "market": ["spot"] * 12,
                    "exchange": ["binance"] * 12,
                    "timeframe": ["1m"] * 12,
                    "symbol": ["BTCUSDT"] * 12,
                }
            )
            b_um = b_spot.copy()
            b_um["market"] = "um"
            b_um["close"] = [201 + i for i in range(12)]

            self.write_csv(okx_root / "spot" / "BTC-USDT" / "1m" / "data.csv", okx_spot)
            self.write_csv(okx_root / "swap" / "BTC-USDT-SWAP" / "1m" / "data.csv", okx_swap)
            self.write_csv(binance_root / "spot" / "BTCUSDT" / "1m" / "data.csv", b_spot)
            self.write_csv(binance_root / "um" / "BTCUSDT" / "1m" / "data.csv", b_um)

            cmd = [
                sys.executable,
                str(SCRIPT_PATH),
                "--okx-root",
                str(okx_root),
                "--binance-root",
                str(binance_root),
                "--output-root",
                str(output_root),
                "--symbols",
                "BTC-USDT",
                "--ret-windows",
                "1,2",
                "--rv-windows",
                "2,3",
                "--sma-windows",
                "2,3",
                "--volume-z-window",
                "3",
                "--label-horizons",
                "1,2",
                "--summary-output",
                str(summary),
            ]
            run = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True, check=False)
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            out = output_root / "okx_inst_id=BTC-USDT" / "data.csv.zst"
            self.assertTrue(out.exists())
            proc = subprocess.run(["zstd", "-q", "-d", "-c", str(out)], capture_output=True, text=True, check=True)
            df = pd.read_csv(pd.io.common.StringIO(proc.stdout))
            self.assertIn("spread_spot_close", df.columns)
            self.assertIn("binance_basis_pct", df.columns)
            self.assertIn("label_ret_fwd_1m", df.columns)
            self.assertIn("label_dir_fwd_1m", df.columns)
            self.assertIn("has_binance_spot_bar", df.columns)
            self.assertTrue((df["has_binance_spot_bar"] == 1).all())
            self.assertTrue(df["timestamp_ms"].is_monotonic_increasing)
            expected_label = (df.iloc[1]["okx_close"] / df.iloc[0]["okx_close"]) - 1.0
            self.assertAlmostEqual(df.iloc[0]["label_ret_fwd_1m"], expected_label, places=10)


if __name__ == "__main__":
    unittest.main()
