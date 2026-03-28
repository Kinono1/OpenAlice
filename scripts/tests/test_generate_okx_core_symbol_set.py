#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "generate_okx_core_symbol_set.py"


class TestGenerateOkxCoreSymbolSet(unittest.TestCase):
    def write_catalog(self, path: Path, items: list[dict[str, object]]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps({"items": items}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_script(
        self,
        *,
        catalog_path: Path,
        bases: str,
        output_path: Path,
        metadata_output_path: Path,
        require_live: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--catalog",
            str(catalog_path),
            "--bases",
            bases,
            "--quote",
            "USDT",
            "--markets",
            "spot,swap",
            "--require-live",
            "true" if require_live else "false",
            "--output",
            str(output_path),
            "--metadata-output",
            str(metadata_output_path),
        ]
        return subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )

    def test_generates_expected_inst_ids_and_metadata(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-symbol-set-") as tmp:
            root = Path(tmp)
            catalog_path = root / "catalog.json"
            output_path = root / "symbols.txt"
            metadata_output_path = root / "symbols.meta.json"
            self.write_catalog(
                catalog_path,
                [
                    {
                        "instId": "BTC-USDT",
                        "instType": "SPOT",
                        "state": "live",
                        "listTime": "1611907686000",
                    },
                    {
                        "instId": "BTC-USDT-SWAP",
                        "instType": "SWAP",
                        "state": "live",
                        "listTime": "1573557408000",
                    },
                    {
                        "instId": "ETH-USDT",
                        "instType": "SPOT",
                        "state": "live",
                        "listTime": "1611907686000",
                    },
                    {
                        "instId": "ETH-USDT-SWAP",
                        "instType": "SWAP",
                        "state": "live",
                        "listTime": "1573557408000",
                    },
                ],
            )

            run = self.run_script(
                catalog_path=catalog_path,
                bases="BTC,ETH",
                output_path=output_path,
                metadata_output_path=metadata_output_path,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertTrue(output_path.exists())
            self.assertTrue(metadata_output_path.exists())

            self.assertEqual(
                output_path.read_text(encoding="utf-8").splitlines(),
                ["BTC-USDT", "BTC-USDT-SWAP", "ETH-USDT", "ETH-USDT-SWAP"],
            )

            payload = json.loads(metadata_output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "okx_core_symbol_set.v1")
            self.assertEqual(payload["totals"]["instIds"], 4)
            self.assertEqual(
                [item["instId"] for item in payload["items"]],
                ["BTC-USDT", "BTC-USDT-SWAP", "ETH-USDT", "ETH-USDT-SWAP"],
            )
            self.assertEqual(payload["items"][1]["listTimeMs"], 1573557408000)
            self.assertTrue(payload["items"][1]["listTimeIso"].startswith("2019-11-12T"))

    def test_fails_when_required_market_missing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-okx-symbol-set-") as tmp:
            root = Path(tmp)
            catalog_path = root / "catalog.json"
            output_path = root / "symbols.txt"
            metadata_output_path = root / "symbols.meta.json"
            self.write_catalog(
                catalog_path,
                [
                    {
                        "instId": "BTC-USDT",
                        "instType": "SPOT",
                        "state": "live",
                        "listTime": "1611907686000",
                    }
                ],
            )

            run = self.run_script(
                catalog_path=catalog_path,
                bases="BTC",
                output_path=output_path,
                metadata_output_path=metadata_output_path,
            )
            self.assertNotEqual(run.returncode, 0)
            self.assertIn("Missing instrument", run.stderr)
            self.assertFalse(output_path.exists())


if __name__ == "__main__":
    unittest.main()
