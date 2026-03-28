#!/usr/bin/env python3
"""Tests for research_methodology_execute script."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_methodology_execute.py"


def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class TestResearchMethodologyExecute(unittest.TestCase):
    def test_selects_top_two_distinct_method_families_and_builds_commands(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-methodology-exec-") as tmp:
            root = Path(tmp)
            backlog_path = root / "backlog.v1.json"
            output_path = root / "latest_methodology_execution.v1.json"
            archive_root = root / "archive"
            write_json(
                backlog_path,
                {
                    "schemaVersion": "hypothesis_backlog.v1",
                    "hypotheses": [
                        {
                            "id": "HYP-001",
                            "paperId": "P1",
                            "title": "Robust baseline first",
                            "priority": 16.0,
                            "methodFamily": "robust-baseline",
                            "actionHint": "Apply conservative FDR baseline gate.",
                        },
                        {
                            "id": "HYP-002",
                            "paperId": "P2",
                            "title": "Duplicate robust baseline",
                            "priority": 15.0,
                            "methodFamily": "robust-baseline",
                            "actionHint": "Apply conservative FDR baseline gate.",
                        },
                        {
                            "id": "HYP-003",
                            "paperId": "P3",
                            "title": "Selective inference",
                            "priority": 14.0,
                            "methodFamily": "selective-inference",
                            "actionHint": "Prototype selective-inference gate.",
                        },
                    ],
                },
            )

            run = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--repo-root",
                    str(REPO_ROOT),
                    "--backlog",
                    str(backlog_path),
                    "--output",
                    str(output_path),
                    "--archive-dir",
                    str(archive_root),
                    "--run-id",
                    "unit-methodology",
                ],
                cwd=str(REPO_ROOT),
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(run.returncode, 0, msg=run.stderr)
            self.assertTrue(output_path.exists())

            payload = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertEqual(payload.get("schemaVersion"), "methodology_execution.v1")
            self.assertFalse(payload.get("executeChain"))
            self.assertEqual(payload.get("selection", {}).get("selectedCount"), 2)
            self.assertEqual(
                payload.get("selection", {}).get("selectedFamilies"),
                ["robust-baseline", "selective-inference"],
            )
            runs = payload.get("runs", [])
            self.assertEqual(len(runs), 2)

            first_cmd = (runs[0].get("execution") or {}).get("command", "")
            second_cmd = (runs[1].get("execution") or {}).get("command", "")
            self.assertIn("--protocol-profile shift", first_cmd)
            self.assertIn("--fdr-method by", first_cmd)
            self.assertIn("--fdr-method cv_storey_bh", second_cmd)
            self.assertIn("--cv-agg-quantile 0.9", second_cmd)
            self.assertIn("--dry-run", first_cmd)
            self.assertIn("--dry-run", second_cmd)

            archived = archive_root / "unit-methodology" / "methodology_execution.v1.json"
            self.assertTrue(archived.exists())


if __name__ == "__main__":
    unittest.main()

