from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "stage_c_candidate_generator_seed_family.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestStageCCandidateGeneratorSeedFamily(unittest.TestCase):
    def test_generator_produces_nine_vol_breakout_candidates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagec-seed-") as tmp:
            root = Path(tmp)
            base_path = root / "base_candidates.v1.json"
            feature_root = root / "target_tables"
            output_path = root / "seed_candidates.v1.json"

            base_payload = {
                "schemaVersion": "strategy_candidates.v1",
                "dataset": {
                    "inputCsv": "data/market/okx/BTC_USDT_USDT_1h.csv",
                    "symbol": "BTC/USD",
                    "lookbackBars": 3600,
                },
                "thresholds": {
                    "meanPboMax": 0.2,
                    "meanDsrProbabilityMin": 0.5,
                    "fdrQMax": 0.1,
                },
                "wfo": {
                    "trainBars": 840,
                    "testBars": 120,
                    "stepBars": 180,
                    "degradationThreshold": 0.4,
                },
                "significance": {
                    "partitions": 8,
                    "pboThreshold": 0.2,
                    "dsrMin": 0.0,
                },
                "riskSimulation": {
                    "method": "moving_block_bootstrap",
                    "simulations": 1500,
                    "horizonBars": 240,
                    "blockSize": 12,
                    "ruinDrawdownPct": 30,
                    "maxRuinProbability": 0.02,
                    "minProfitProbability": 0.55,
                },
                "costModel": {
                    "feeRate": 0.0004,
                    "slippageBps": 3,
                    "latencyBars": 1,
                },
                "candidates": [],
            }
            write_text(base_path, json.dumps(base_payload, ensure_ascii=False, indent=2) + "\n")

            header = ",".join(
                [
                    "timestamp_ms",
                    "iso_utc",
                    "okx_inst_id",
                    "exchange",
                    "timeframe",
                    "okx_close",
                    "okx_rv_60m",
                    "target_realized_vol_1h",
                    "okx_range_pct",
                ]
            )

            def rows(symbol: str, scale: float) -> str:
                values = [header]
                for i in range(1, 121):
                    values.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"2026-01-01T00:{i % 60:02d}:00Z",
                                symbol,
                                "okx",
                                "1m",
                                f"{100 + i * scale:.6f}",
                                f"{0.003 * scale * ((i % 5) + 1):.6f}",
                                f"{0.005 * scale * ((i % 7) + 1):.6f}",
                                f"{0.001 * scale * ((i % 3) + 1):.6f}",
                            ]
                        )
                    )
                return "\n".join(values) + "\n"

            for symbol, scale in (("BTC-USDT", 1.0), ("ETH-USDT", 1.2), ("SOL-USDT", 0.8)):
                write_text(feature_root / f"okx_inst_id={symbol}" / "data.csv", rows(symbol, scale))

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--base-candidates",
                    str(base_path),
                    "--feature-root",
                    str(feature_root),
                    "--symbols",
                    "BTC-USDT,ETH-USDT,SOL-USDT",
                    "--tail-rows",
                    "100",
                    "--output",
                    str(output_path),
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "strategy_candidates.v1")
            candidates = payload["candidates"]
            self.assertEqual(len(candidates), 9)
            self.assertEqual({row["strategy"] for row in candidates}, {"volBreakout"})
            self.assertTrue(all(row["params"]["allowShort"] is False for row in candidates))


if __name__ == "__main__":
    unittest.main()
