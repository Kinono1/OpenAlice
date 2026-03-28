#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "stage_c_candidate_generator_v2.py"


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class TestStageCCandidateGeneratorV2(unittest.TestCase):
    def test_generator_produces_15_strategy_candidates(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagec-gen-") as tmp:
            root = Path(tmp)
            base_path = root / "base_candidates.v1.json"
            feature_root = root / "feature_root"
            output_path = root / "stage_c_candidates.v1.json"

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
                    "okx_close",
                    "spread_spot_pct",
                    "okx_basis_pct",
                    "okx_volume_z20",
                    "okx_rv_5m",
                    "okx_close_vs_sma_5",
                    "okx_close_vs_sma_20",
                    "label_dir_fwd_5m",
                ]
            )

            def feature_rows(multiplier: float) -> str:
                rows = [header]
                for i in range(1, 41):
                    rows.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"{100 + i * multiplier:.6f}",
                                f"{0.001 * multiplier * ((i % 5) + 1):.6f}",
                                f"{0.002 * multiplier * ((i % 4) + 1):.6f}",
                                f"{0.2 * multiplier * ((i % 6) + 1):.6f}",
                                f"{0.003 * multiplier * ((i % 3) + 1):.6f}",
                                f"{1.0 + 0.01 * i * multiplier:.6f}",
                                f"{0.9 + 0.008 * i * multiplier:.6f}",
                                "1" if i % 2 == 0 else "0",
                            ]
                        )
                    )
                return "\n".join(rows) + "\n"

            write_text(feature_root / "okx_inst_id=BTC-USDT" / "data.csv", feature_rows(1.0))
            write_text(feature_root / "okx_inst_id=ETH-USDT" / "data.csv", feature_rows(1.2))
            write_text(feature_root / "okx_inst_id=SOL-USDT" / "data.csv", feature_rows(0.8))

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
                    "--output",
                    str(output_path),
                    "--tail-rows",
                    "32",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(payload["schemaVersion"], "strategy_candidates.v1")
            self.assertEqual(len(candidates), 15)
            strategies = {item["strategy"] for item in candidates}
            self.assertEqual(strategies, {"breakout", "trend", "ensemble"})
            stage_c = payload.get("stageCCompile", {})
            self.assertEqual(stage_c.get("outputCandidateCount"), 15)
            self.assertEqual(len(stage_c.get("families", [])), 3)

    def test_generator_supports_v2_rescope_profile(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-stagec-gen-v2-") as tmp:
            root = Path(tmp)
            base_path = root / "base_candidates.v1.json"
            feature_root = root / "feature_root"
            output_path = root / "stage_c_candidates.v2.json"

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
                "wfo": {"trainBars": 840, "testBars": 120, "stepBars": 180, "degradationThreshold": 0.4},
                "significance": {"partitions": 8, "pboThreshold": 0.2, "dsrMin": 0.0},
                "riskSimulation": {
                    "method": "moving_block_bootstrap",
                    "simulations": 1500,
                    "horizonBars": 240,
                    "blockSize": 12,
                    "ruinDrawdownPct": 30,
                    "maxRuinProbability": 0.02,
                    "minProfitProbability": 0.55,
                },
                "costModel": {"feeRate": 0.0004, "slippageBps": 3, "latencyBars": 1},
                "candidates": [],
            }
            write_text(base_path, json.dumps(base_payload, ensure_ascii=False, indent=2) + "\n")

            header = ",".join(
                [
                    "timestamp_ms",
                    "okx_close",
                    "spread_spot_pct",
                    "okx_basis_pct",
                    "okx_volume_z20",
                    "okx_rv_5m",
                    "okx_close_vs_sma_5",
                    "okx_close_vs_sma_20",
                    "label_dir_fwd_5m",
                ]
            )

            def feature_rows(multiplier: float) -> str:
                rows = [header]
                for i in range(1, 41):
                    rows.append(
                        ",".join(
                            [
                                str(1_700_000_000_000 + i * 60_000),
                                f"{100 + i * multiplier:.6f}",
                                f"{0.001 * multiplier * ((i % 5) + 1):.6f}",
                                f"{0.002 * multiplier * ((i % 4) + 1):.6f}",
                                f"{0.2 * multiplier * ((i % 6) + 1):.6f}",
                                f"{0.003 * multiplier * ((i % 3) + 1):.6f}",
                                f"{1.0 + 0.01 * i * multiplier:.6f}",
                                f"{0.9 + 0.008 * i * multiplier:.6f}",
                                "1" if i % 2 == 0 else "0",
                            ]
                        )
                    )
                return "\n".join(rows) + "\n"

            write_text(feature_root / "okx_inst_id=BTC-USDT" / "data.csv", feature_rows(1.0))
            write_text(feature_root / "okx_inst_id=ETH-USDT" / "data.csv", feature_rows(1.2))
            write_text(feature_root / "okx_inst_id=SOL-USDT" / "data.csv", feature_rows(0.8))

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
                    "--output",
                    str(output_path),
                    "--tail-rows",
                    "32",
                    "--profile",
                    "v2",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            candidates = payload.get("candidates", [])
            self.assertEqual(len(candidates), 15)
            self.assertEqual(payload["stageCCompile"]["profile"], "v2")
            self.assertTrue(all(item["params"]["allowShort"] is False for item in candidates))
            self.assertEqual(
                {item["family"] for item in payload["stageCCompile"]["families"]},
                {
                    "compressed_basis_breakout_long_only",
                    "volume_confirmed_trend_long_only",
                    "conservative_trend_dominant_ensemble",
                },
            )


if __name__ == "__main__":
    unittest.main()
