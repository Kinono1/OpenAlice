from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "diagnose_binance_core7_alignment.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestDiagnoseBinanceCore7Alignment(unittest.TestCase):
    def test_reports_missing_merge_as_keep_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-binance-align-") as tmp:
            root = Path(tmp)
            raw_root = root / "raw"
            norm_root = root / "norm"
            feature_root = root / "feature"
            out = root / "diag.json"

            for market in ("spot", "um"):
                for symbol in ("BTCUSDT", "ETHUSDT", "SOLUSDT"):
                    write_text(raw_root / market / symbol / "1m" / "dummy.txt", "x")
                    write_text(norm_root / market / symbol / "1m" / "data.csv.zst", "")

            header = ",".join(
                [
                    "timestamp_ms",
                    "has_binance_spot_bar",
                    "has_binance_um_bar",
                    "spread_spot_pct",
                    "spread_um_pct",
                    "binance_basis_pct",
                ]
            )
            row = "1,0,0,,,"
            for symbol in ("BTC-USDT", "ETH-USDT", "SOL-USDT"):
                write_text(feature_root / f"okx_inst_id={symbol}" / "data.csv", header + "\n" + row + "\n")

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--raw-root",
                    str(raw_root),
                    "--norm-root",
                    str(norm_root),
                    "--feature-root",
                    str(feature_root),
                    "--output",
                    str(out),
                    "--symbols",
                    "BTC-USDT,ETH-USDT,SOL-USDT",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(out.read_text(encoding="utf-8"))
            self.assertEqual(payload["result"], "keep_arbitrage_closed")


if __name__ == "__main__":
    unittest.main()
