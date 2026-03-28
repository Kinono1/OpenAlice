#!/usr/bin/env python3
"""Tests for run_g3g4_multi_asset_matrix script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_PATH = REPO_ROOT / "scripts" / "archive" / "legacy-research" / "run_g3g4_multi_asset_matrix.py"


class TestRunG3G4MultiAssetMatrix(unittest.TestCase):
    def write_json(self, path: Path, payload: object) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def run_matrix(
        self,
        *,
        repo_root: Path,
        output_path: Path,
        markdown_path: Path,
        extra_args: list[str] | None = None,
    ) -> subprocess.CompletedProcess[str]:
        cmd = [
            sys.executable,
            str(SCRIPT_PATH),
            "--repo-root",
            str(repo_root),
            "--output",
            str(output_path),
            "--markdown",
            str(markdown_path),
            "--run-id",
            "TEST-RUN",
        ]
        if extra_args:
            cmd.extend(extra_args)
        return subprocess.run(
            cmd,
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )

    def prepare_fixture_files(self, root: Path) -> None:
        self.write_json(
            root / "docs/research/strategy_candidates.v1.json",
            {"schemaVersion": "strategy_candidates.v1", "candidates": []},
        )
        self.write_json(
            root / "data/research/strategy/asset_universe_10plus.v1.json",
            {
                "schemaVersion": "asset_universe.v1",
                "assets": [
                    {
                        "asset": "BTC",
                        "symbol": "BTC/USD",
                        "inputCsv": "data/market/okx/BTC_USDT_USDT_1h.csv",
                    },
                    {
                        "asset": "ETH",
                        "symbol": "ETH/USD",
                        "inputCsv": "data/market/okx/ETH_USDT_USDT_1h.csv",
                    },
                    {
                        "asset": "SOL",
                        "symbol": "SOL/USD",
                        "inputCsv": "data/market/okx/SOL_USDT_USDT_1h.csv",
                    },
                ],
            },
        )
        csv_path = root / "data/market/okx/BTC_USDT_USDT_1h.csv"
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        csv_path.write_text(
            "timestamp,open,high,low,close,volume\n"
            "2026-03-01T00:00:00Z,1,1,1,1,1\n",
            encoding="utf-8",
        )

    def test_dry_run_handles_existing_and_missing_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-matrix-") as tmp:
            root = Path(tmp)
            self.prepare_fixture_files(root)

            output_path = root / "out/latest_multi_asset_matrix.v1.json"
            markdown_path = root / "out/latest_multi_asset_matrix.md"
            run = self.run_matrix(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
                extra_args=[
                    "--dry-run",
                    "--min-assets-success",
                    "0",
                ],
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            self.assertTrue(output_path.exists(), msg=run.stdout)
            self.assertTrue(markdown_path.exists())

            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["schemaVersion"], "multi_asset_matrix.v1")
            self.assertEqual(payload["executeMode"], "dry_run")
            self.assertEqual(payload["summary"]["totalAssets"], 3)
            self.assertEqual(payload["summary"]["completedAssets"], 0)
            self.assertEqual(payload["summary"]["missingAssets"], 2)
            self.assertEqual(payload["summary"]["qualitySummary"]["validAssets"], 1)
            self.assertEqual(payload["summary"]["qualitySummary"]["invalidAssets"], 2)

            by_asset = {row["asset"]: row for row in payload["assets"]}
            self.assertEqual(by_asset["BTC"]["status"], "dry_run")
            self.assertIn("run_strategy_mvp_validation.ts", by_asset["BTC"]["command"])
            self.assertEqual(by_asset["ETH"]["status"], "missing_data")
            self.assertIn("dataQuality", by_asset["BTC"])
            self.assertTrue(by_asset["BTC"]["dataQuality"]["isValid"])
            self.assertFalse(by_asset["ETH"]["dataQuality"]["isValid"])

    def test_dry_run_returns_policy_fail_when_min_assets_not_met(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-matrix-") as tmp:
            root = Path(tmp)
            self.prepare_fixture_files(root)

            output_path = root / "out/latest_multi_asset_matrix.v1.json"
            markdown_path = root / "out/latest_multi_asset_matrix.md"
            run = self.run_matrix(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
                extra_args=[
                    "--dry-run",
                    "--min-assets-success",
                    "1",
                    "--max-assets",
                    "1",
                ],
            )
            self.assertEqual(run.returncode, 2, msg=run.stderr or run.stdout)
            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertFalse(payload["summary"]["meetsMinAssetsSuccess"])

    def test_assets_filter_selects_only_requested_assets(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-matrix-") as tmp:
            root = Path(tmp)
            self.prepare_fixture_files(root)
            sol_csv = root / "data/market/okx/SOL_USDT_USDT_1h.csv"
            sol_csv.parent.mkdir(parents=True, exist_ok=True)
            sol_csv.write_text(
                "timestamp,open,high,low,close,volume\n"
                "2026-03-01T00:00:00Z,2,2,2,2,1\n",
                encoding="utf-8",
            )

            output_path = root / "out/latest_multi_asset_matrix.v1.json"
            markdown_path = root / "out/latest_multi_asset_matrix.md"
            run = self.run_matrix(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
                extra_args=[
                    "--dry-run",
                    "--assets",
                    "SOL,BTC",
                    "--min-assets-success",
                    "0",
                ],
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            assets = [row["asset"] for row in payload["assets"]]
            self.assertEqual(assets, ["SOL", "BTC"])
            self.assertEqual(payload["source"]["requestedAssets"], ["SOL", "BTC"])

    def test_assets_filter_returns_error_for_unknown_asset(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-matrix-") as tmp:
            root = Path(tmp)
            self.prepare_fixture_files(root)
            output_path = root / "out/latest_multi_asset_matrix.v1.json"
            markdown_path = root / "out/latest_multi_asset_matrix.md"
            run = self.run_matrix(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
                extra_args=["--dry-run", "--assets", "BTC,UNKNOWN"],
            )
            self.assertEqual(run.returncode, 2, msg=run.stderr or run.stdout)
            self.assertIn("requested assets not found", run.stderr)

    def test_invalid_data_quality_is_marked_missing_data(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-matrix-") as tmp:
            root = Path(tmp)
            self.prepare_fixture_files(root)
            bad_csv = root / "data/market/okx/ETH_USDT_USDT_1h.csv"
            bad_csv.parent.mkdir(parents=True, exist_ok=True)
            bad_csv.write_text(
                "timestamp,open,high,low,close,volume\n"
                "2026-03-01T00:00:00Z,,2,1,2,1\n",
                encoding="utf-8",
            )

            output_path = root / "out/latest_multi_asset_matrix.v1.json"
            markdown_path = root / "out/latest_multi_asset_matrix.md"
            run = self.run_matrix(
                repo_root=root,
                output_path=output_path,
                markdown_path=markdown_path,
                extra_args=[
                    "--dry-run",
                    "--assets",
                    "ETH",
                    "--min-assets-success",
                    "0",
                ],
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr or run.stdout)
            payload: dict[str, Any] = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload["assets"][0]["status"], "missing_data")
            self.assertFalse(payload["assets"][0]["dataQuality"]["isValid"])
            self.assertIn(
                "missing_rate_gt_10pct",
                str(payload["assets"][0]["dataQuality"]["invalidReason"]),
            )


if __name__ == "__main__":
    unittest.main()
