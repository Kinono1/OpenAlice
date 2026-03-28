#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "normalize_binance_core7_1m.py"


class TestNormalizeBinanceCore7(unittest.TestCase):
    def write_zip(self, path: Path, member_name: str, lines: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(member_name, "\n".join(lines) + "\n")

    def read_zst_lines(self, path: Path) -> list[str]:
        proc = subprocess.run(
            ["zstd", "-q", "-d", "-c", str(path)],
            capture_output=True,
            text=True,
            check=True,
        )
        return proc.stdout.splitlines()

    def test_normalize_binance_handles_spot_microseconds_and_um_header(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-binance-norm-") as tmp:
            root = Path(tmp)
            input_root = root / "binance"
            output_root = root / "binance_norm"
            summary = root / "summary.json"

            self.write_zip(
                input_root / "spot" / "BTCUSDT" / "1m" / "BTCUSDT-1m-2026-02.zip",
                "BTCUSDT-1m-2026-02.csv",
                [
                    "1769904000000000,78741.1,78774.27,78681.48,78683.61,11.3775,1769904059999999,895606.46023360,5610,3.57967000,281765.11959420,0",
                    "1769904060000000,78683.61,78683.61,78644.09,78673.09,12.81269,1769904119999999,1007849.66317000,5942,5.21634000,410302.91383040,0",
                ],
            )
            self.write_zip(
                input_root / "um" / "BTCUSDT" / "1m" / "BTCUSDT-1m-2026-02.zip",
                "BTCUSDT-1m-2026-02.csv",
                [
                    "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore",
                    "1769904000000,78706.70,78743.20,78643.80,78649.50,89.071,1769904059999,7008566.08670,4640,50.171,3947529.16430,0",
                ],
            )

            cmd = [
                sys.executable,
                str(SCRIPT_PATH),
                "--input-root",
                str(input_root),
                "--output-root",
                str(output_root),
                "--summary-output",
                str(summary),
            ]
            run = subprocess.run(cmd, cwd=str(REPO_ROOT), text=True, capture_output=True, check=False)
            self.assertEqual(run.returncode, 0, msg=run.stderr)

            spot_out = output_root / "spot" / "BTCUSDT" / "1m" / "data.csv.zst"
            um_out = output_root / "um" / "BTCUSDT" / "1m" / "data.csv.zst"
            self.assertTrue(spot_out.exists())
            self.assertTrue(um_out.exists())

            spot_lines = self.read_zst_lines(spot_out)
            um_lines = self.read_zst_lines(um_out)
            self.assertTrue(spot_lines[1].startswith("1769904000000,"))
            self.assertTrue(um_lines[1].startswith("1769904000000,"))
            self.assertIn("quote_volume", spot_lines[0])
            self.assertIn("trades_count", spot_lines[0])
            self.assertIn("taker_buy_base", spot_lines[0])
            self.assertIn("taker_buy_quote", spot_lines[0])

            payload = json.loads(summary.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["symbols"], 2)


if __name__ == "__main__":
    unittest.main()
