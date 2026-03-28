from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "core7_target_horizon_scan.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestCore7TargetHorizonScan(unittest.TestCase):
    def test_scan_emits_ranked_targets_and_recommendation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-target-scan-") as tmp:
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
                    "future_persistence_hint",
                    "noise_feature",
                ]
            )

            def rows(symbol: str) -> str:
                values = [header]
                closes = []
                for i in range(420):
                    drift = 0.18 if (i // 30) % 2 == 0 else -0.12
                    close = 100.0 + i * drift + (i % 5) * 0.01
                    closes.append(close)
                for i, close in enumerate(closes):
                    future_slice = closes[i + 1 : min(len(closes), i + 61)]
                    if len(future_slice) < 10:
                        persistence = 0.0
                    else:
                        diffs = [future_slice[j] - future_slice[j - 1] for j in range(1, len(future_slice))]
                        positives = sum(1 for d in diffs if d > 0)
                        negatives = sum(1 for d in diffs if d < 0)
                        persistence = (positives - negatives) / max(1, positives + negatives)
                    noise = ((i * 11) % 17) / 10.0
                    values.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"2026-01-01T00:{i % 60:02d}:00Z",
                                symbol,
                                "okx",
                                "1m",
                                f"{close:.6f}",
                                f"{persistence:.8f}",
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
                    "360",
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
            self.assertEqual(payload["schemaVersion"], "core7_target_horizon_scan.v1")
            self.assertIn("recommendation", payload)
            self.assertIn("recommendedTarget", payload["recommendation"])
            self.assertTrue(doc_path.exists())
            self.assertGreater(len(payload["recommendation"]["rankedTargets"]), 0)


if __name__ == "__main__":
    unittest.main()
