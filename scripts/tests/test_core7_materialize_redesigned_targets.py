from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "core7_materialize_redesigned_targets.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestCore7MaterializeRedesignedTargets(unittest.TestCase):
    def test_materializes_target_columns(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-materialize-targets-") as tmp:
            root = Path(tmp)
            feature_root = root / "feature_root"
            output_root = root / "target_tables"
            summary_path = root / "summary.json"
            doc_path = root / "summary.md"

            header = ",".join(
                [
                    "timestamp_ms",
                    "iso_utc",
                    "okx_inst_id",
                    "exchange",
                    "timeframe",
                    "okx_close",
                    "okx_volume",
                ]
            )

            def rows(symbol: str) -> str:
                values = [header]
                for i in range(320):
                    close = 100 + i * 0.1 + (i % 7) * 0.02
                    volume = 1000 + (i % 13) * 7
                    values.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"2026-01-01T00:{i % 60:02d}:00Z",
                                symbol,
                                "okx",
                                "1m",
                                f"{close:.6f}",
                                f"{volume:.6f}",
                            ]
                        )
                    )
                return "\n".join(values) + "\n"

            for symbol in ("BTC-USDT", "ETH-USDT", "SOL-USDT"):
                write_text(feature_root / f"okx_inst_id={symbol}" / "data.csv", rows(symbol))

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--feature-root",
                    str(feature_root),
                    "--output-root",
                    str(output_root),
                    "--summary-output",
                    str(summary_path),
                    "--doc-output",
                    str(doc_path),
                    "--symbols",
                    "BTC-USDT,ETH-USDT,SOL-USDT",
                    "--tail-rows",
                    "300",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(summary_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "core7_target_materialization.v1")
            btc_output = output_root / "okx_inst_id=BTC-USDT" / "data.csv"
            self.assertTrue(btc_output.exists())
            with btc_output.open("r", encoding="utf-8", newline="") as handle:
                reader = csv.DictReader(handle)
                row = next(reader)
            self.assertIn("target_realized_vol_1h", row)
            self.assertIn("target_abs_return_1h", row)
            self.assertIn("target_forward_return_4h", row)
            self.assertIn("target_directional_persistence_1h", row)
            self.assertTrue(doc_path.exists())


if __name__ == "__main__":
    unittest.main()
