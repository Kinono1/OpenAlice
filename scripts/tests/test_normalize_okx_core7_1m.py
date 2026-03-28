#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "normalize_okx_core7_1m.py"


class TestNormalizeOkxCore7(unittest.TestCase):
    def write_csv(self, path: Path, rows: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        content = "\n".join(
            ["timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange", *rows]
        ) + "\n"
        path.write_text(content, encoding="utf-8")

    def compress_zst(self, path: Path) -> Path:
        subprocess.run(["zstd", "-q", "-f", str(path)], check=True)
        zst = path.with_suffix(path.suffix + ".zst")
        path.unlink()
        return zst

    def read_zst_lines(self, path: Path) -> list[str]:
        proc = subprocess.run(
            ["zstd", "-q", "-d", "-c", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.splitlines()

    def test_normalize_okx_mixed_csv_and_zst(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-norm-") as tmp:
            root = Path(tmp)
            dataset_root = root / "okx"
            output_root = root / "okx_norm"
            summary = root / "summary.json"

            csv_plain = dataset_root / "candles" / "1m" / "spot" / "BTC-USDT" / "2026-02.csv"
            self.write_csv(
                csv_plain,
                [
                    "1709251200000,2024-03-01T00:00:00+00:00,1,2,0.5,1.5,10,BTC-USDT,1m,okx",
                    "1709251260000,2024-03-01T00:01:00+00:00,1.5,2.1,1.4,1.8,12,BTC-USDT,1m,okx",
                ],
            )
            csv_compressed = dataset_root / "candles" / "1m" / "spot" / "BTC-USDT" / "2026-03.csv"
            self.write_csv(
                csv_compressed,
                [
                    "1709251320000,2024-03-01T00:02:00+00:00,1.8,2.2,1.7,2.0,15,BTC-USDT,1m,okx",
                    "1709251320000,2024-03-01T00:02:00+00:00,1.8,2.2,1.7,2.0,15,BTC-USDT,1m,okx",
                ],
            )
            self.compress_zst(csv_compressed)

            cmd = [
                sys.executable,
                str(SCRIPT_PATH),
                "--dataset-root",
                str(dataset_root),
                "--output-root",
                str(output_root),
                "--summary-output",
                str(summary),
            ]
            run = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True, check=False)
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            output_path = output_root / "spot" / "BTC-USDT" / "1m" / "data.csv.zst"
            self.assertTrue(output_path.exists())
            lines = self.read_zst_lines(output_path)
            self.assertEqual(lines[0].split(",")[:6], ["timestamp_ms", "iso_utc", "symbol", "market", "exchange", "timeframe"])
            self.assertEqual(len(lines) - 1, 3)
            self.assertIn("BTC-USDT,spot,okx,1m", lines[1])

            payload = json.loads(summary.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["symbols"], 1)
            self.assertEqual(payload["items"][0]["rowsKept"], 3)


if __name__ == "__main__":
    unittest.main()
