#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "verify_okx_candles_completion.py"


class TestVerifyOkxCandlesCompletion(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def write_symbols_file(self, path: Path, symbols: list[str]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(symbols) + "\n", encoding="utf-8")

    def write_csv(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "timestamp,iso,open,high,low,close,volume,symbol,timeframe,exchange\n"
            "1709251200000,2024-03-01T00:00:00+00:00,1,2,0.5,1.5,10,BTC-USDT,1m,okx\n",
            encoding="utf-8",
        )

    def run_verify(
        self,
        *,
        dataset_root: Path,
        symbols_file: Path,
        output_path: Path,
        end_date: str = "2024-03-15",
    ) -> subprocess.CompletedProcess[str]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--dataset-root",
            str(dataset_root),
            "--symbols-file",
            str(symbols_file),
            "--timeframes",
            "1m",
            "--end-date",
            end_date,
            "--output",
            str(output_path),
        ]
        return subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_verify_passes_for_completed_state_and_end_month_shard(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-verify-") as tmp:
            root = Path(tmp)
            dataset_root = root / "okx_1m_core7"
            symbols_file = root / "symbols.txt"
            output_path = root / "validation.json"
            self.write_symbols_file(symbols_file, ["BTC-USDT", "BTC-USDT-SWAP"])

            self.write_json(
                dataset_root / "state" / "candles.agent01.state.v1.json",
                {
                    "schemaVersion": "okx_candles_state.v1",
                    "updatedAt": "2026-03-01T00:00:00Z",
                    "items": {
                        "BTC-USDT::1m": {"completed": True, "lastWrittenTs": 1709251200000},
                        "BTC-USDT-SWAP::1m": {
                            "completed": True,
                            "lastWrittenTs": 1709251200000,
                        },
                    },
                },
            )
            self.write_csv(
                dataset_root / "candles" / "1m" / "spot" / "BTC-USDT" / "2024-03.csv"
            )
            self.write_csv(
                dataset_root
                / "candles"
                / "1m"
                / "swap"
                / "BTC-USDT-SWAP"
                / "2024-03.csv"
            )

            run = self.run_verify(
                dataset_root=dataset_root,
                symbols_file=symbols_file,
                output_path=output_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["invalidTasks"], 0)
            self.assertTrue(all(item["valid"] for item in payload["items"]))

    def test_verify_passes_when_state_completed_even_if_end_month_shard_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-verify-") as tmp:
            root = Path(tmp)
            dataset_root = root / "okx_1m_core7"
            symbols_file = root / "symbols.txt"
            output_path = root / "validation.json"
            self.write_symbols_file(symbols_file, ["BTC-USDT"])

            self.write_json(
                dataset_root / "state" / "candles.agent01.state.v1.json",
                {
                    "schemaVersion": "okx_candles_state.v1",
                    "updatedAt": "2026-03-01T00:00:00Z",
                    "items": {
                        "BTC-USDT::1m": {"completed": True, "lastWrittenTs": 1706745600000},
                    },
                },
            )
            self.write_csv(
                dataset_root / "candles" / "1m" / "spot" / "BTC-USDT" / "2024-02.csv"
            )

            run = self.run_verify(
                dataset_root=dataset_root,
                symbols_file=symbols_file,
                output_path=output_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["invalidTasks"], 0)
            self.assertTrue(payload["items"][0]["stateCompleted"])
            self.assertFalse(payload["items"][0]["coverageComplete"])
            self.assertTrue(payload["items"][0]["valid"])
            self.assertEqual(payload["items"][0]["endMonthNonEmptyShardCount"], 0)

    def test_verify_passes_for_complete_coverage_without_state(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-verify-") as tmp:
            root = Path(tmp)
            dataset_root = root / "okx_1m_core7"
            symbols_file = root / "symbols.txt"
            output_path = root / "validation.json"
            self.write_symbols_file(symbols_file, ["BTC-USDT"])

            self.write_csv(
                dataset_root / "candles" / "1m" / "spot" / "BTC-USDT" / "2024-03.csv"
            )

            run = self.run_verify(
                dataset_root=dataset_root,
                symbols_file=symbols_file,
                output_path=output_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["totals"]["invalidTasks"], 0)
            self.assertTrue(payload["items"][0]["coverageComplete"])
            self.assertFalse(payload["items"][0]["stateCompleted"])
            self.assertTrue(payload["items"][0]["valid"])


if __name__ == "__main__":
    unittest.main()
