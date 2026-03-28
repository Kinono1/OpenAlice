from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "core7_feature_predictive_scan.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestCore7FeaturePredictiveScan(unittest.TestCase):
    def test_scan_reports_predictive_feature(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-core7-scan-") as tmp:
            root = Path(tmp)
            feature_root = root / "feature_root"
            output_path = root / "scan.json"
            doc_path = root / "scan.md"

            header = ",".join(
                [
                    "timestamp_ms",
                    "iso_utc",
                    "okx_inst_id",
                    "exchange",
                    "timeframe",
                    "okx_close",
                    "predictive_alpha",
                    "noise_feature",
                ]
            )

            def rows(symbol: str) -> str:
                values = [header]
                closes = []
                for i in range(400):
                    close = 100.0 + i * 0.1 + (i % 5) * 0.01
                    closes.append(close)
                for i, close in enumerate(closes):
                    future_60 = closes[min(len(closes) - 1, i + 60)]
                    predictive = (future_60 / close) - 1.0
                    noise = ((i * 17) % 11) / 10.0
                    values.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"2026-01-01T00:{i % 60:02d}:00Z",
                                symbol,
                                "okx",
                                "1m",
                                f"{close:.6f}",
                                f"{predictive:.8f}",
                                f"{noise:.6f}",
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
                    "--symbols",
                    "BTC-USDT,ETH-USDT,SOL-USDT",
                    "--tail-rows",
                    "300",
                    "--top-n",
                    "5",
                    "--output",
                    str(output_path),
                    "--doc-output",
                    str(doc_path),
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "core7_feature_predictive_scan.v1")
            self.assertIn("1h", payload["aggregate"])
            self.assertTrue(payload["aggregate"]["1h"]["signalStillExists"])
            rank_features = [row["feature"] for row in payload["aggregate"]["1h"]["topByMeanAbsRankIc"]]
            self.assertIn("predictive_alpha", rank_features)
            self.assertTrue(doc_path.exists())


if __name__ == "__main__":
    unittest.main()
