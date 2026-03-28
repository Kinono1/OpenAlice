#!/usr/bin/env python3
"""Unit tests for research_pdf_extract script."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "research_pdf_extract.py"

_SPEC = importlib.util.spec_from_file_location("research_pdf_extract", str(SCRIPT_PATH))
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - defensive import guard
    raise RuntimeError("Failed to load research_pdf_extract module spec.")
MODULE = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(MODULE)


class TestResearchPdfExtract(unittest.TestCase):
    def test_normalize_safe_id(self) -> None:
        self.assertEqual(
            MODULE.normalize_safe_id(" arXiv:CS/9901001 v2 "),
            "arxiv-cs-9901001-v2",
        )
        self.assertEqual(MODULE.normalize_safe_id("  ++  "), "paper")

    def test_build_report_on_empty_digest(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-pdf-extract-empty-") as tmp:
            root = Path(tmp)
            out_dir = root / "out"

            report = MODULE.run_extraction_pipeline(
                digest_payload={"run_id": "digest-empty", "top_new": []},
                digest_path=root / "digest.json",
                out_dir=out_dir,
                max_papers=10,
                timeout_sec=25,
                min_text_chars=800,
                dry_run=False,
                run_id="unit-empty",
            )
            latest_path, archive_path = MODULE.write_report_files(
                out_dir=out_dir,
                run_id="unit-empty",
                report=report,
            )

            self.assertEqual(report["schemaVersion"], "pdf_extract_report.v1")
            self.assertEqual(report["summary"]["totalDigestEntries"], 0)
            self.assertEqual(report["summary"]["withPdfUrl"], 0)
            self.assertEqual(report["summary"]["selected"], 0)
            self.assertEqual(report["summary"]["succeeded"], 0)
            self.assertEqual(report["summary"]["failed"], 0)
            self.assertEqual(report["papers"], [])
            self.assertTrue(latest_path.exists())
            self.assertTrue(archive_path.exists())
            loaded_latest = json.loads(latest_path.read_text(encoding="utf-8"))
            self.assertEqual(loaded_latest["runId"], "unit-empty")

    def test_pipeline_with_mocked_download_and_extract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-pdf-extract-pipeline-") as tmp:
            root = Path(tmp)
            out_dir = root / "out"
            counters = {"download": 0, "extract": 0}

            def fake_download(url: str, destination: Path, timeout_sec: int) -> None:
                counters["download"] += 1
                self.assertEqual(url, "https://example.test/paper-a.pdf")
                self.assertEqual(timeout_sec, 12)
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"%PDF-1.4 mock payload")

            def fake_extract(pdf_path: Path, min_text_chars: int) -> dict[str, object]:
                counters["extract"] += 1
                self.assertTrue(pdf_path.exists())
                self.assertEqual(min_text_chars, 100)
                return {
                    "text": "x" * 1200,
                    "method": "pypdf",
                    "pages": 4,
                    "textChars": 1200,
                    "errors": [],
                }

            digest_payload = {
                "run_id": "digest-run",
                "top_new": [
                    {
                        "paper_id": "ArXiv:2501.00001v2",
                        "title": "Paper A",
                        "pdf_url": "https://example.test/paper-a.pdf",
                    },
                    {
                        "paper_id": "paper-without-pdf",
                        "title": "Paper B",
                    },
                ],
            }

            report = MODULE.run_extraction_pipeline(
                digest_payload=digest_payload,
                digest_path=root / "digest.json",
                out_dir=out_dir,
                max_papers=10,
                timeout_sec=12,
                min_text_chars=100,
                dry_run=False,
                run_id="unit-pipeline",
                download_pdf_fn=fake_download,
                extract_text_fn=fake_extract,
            )
            latest_path, archive_path = MODULE.write_report_files(
                out_dir=out_dir,
                run_id="unit-pipeline",
                report=report,
            )

            self.assertEqual(counters["download"], 1)
            self.assertEqual(counters["extract"], 1)
            self.assertEqual(report["summary"]["totalDigestEntries"], 2)
            self.assertEqual(report["summary"]["withPdfUrl"], 1)
            self.assertEqual(report["summary"]["selected"], 1)
            self.assertEqual(report["summary"]["downloaded"], 1)
            self.assertEqual(report["summary"]["succeeded"], 1)
            self.assertEqual(report["summary"]["failed"], 0)
            self.assertTrue(latest_path.exists())
            self.assertTrue(archive_path.exists())

            item = report["papers"][0]
            self.assertEqual(item["status"], "success")
            self.assertEqual(item["method"], "pypdf")
            self.assertEqual(item["pages"], 4)
            self.assertEqual(item["textChars"], 1200)
            safe_id = item["safeId"]
            self.assertTrue((out_dir / "pdfs" / f"{safe_id}.pdf").exists())
            self.assertTrue((out_dir / "text" / f"{safe_id}.txt").exists())

    def test_select_pdf_entries_filters_invalid_url_tokens(self) -> None:
        digest_payload = {
            "top_new": [
                {"paper_id": "p1", "pdf_url": "None"},
                {"paper_id": "p2", "pdf_url": "  "},
                {"paper_id": "p3", "pdf_url": "ftp://example.test/a.pdf"},
                {"paper_id": "p4", "pdf_url": "https://example.test/a.pdf"},
            ]
        }
        selected, total, with_pdf = MODULE.select_pdf_entries(
            digest_payload=digest_payload,
            max_papers=10,
        )
        self.assertEqual(total, 4)
        self.assertEqual(with_pdf, 1)
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0]["paper_id"], "p4")
        self.assertEqual(
            MODULE.normalize_pdf_url("None"),
            "",
        )
        self.assertEqual(
            MODULE.normalize_pdf_url("https://example.test/x.pdf"),
            "https://example.test/x.pdf",
        )

    def test_pipeline_backfills_after_failed_download_until_success_target(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-pdf-extract-backfill-") as tmp:
            root = Path(tmp)
            out_dir = root / "out"
            calls: list[str] = []

            def fake_download(url: str, destination: Path, timeout_sec: int) -> None:
                calls.append(url)
                if "fail-first" in url:
                    raise RuntimeError("blocked")
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(b"%PDF-1.4 mock payload")

            def fake_extract(pdf_path: Path, min_text_chars: int) -> dict[str, object]:
                return {
                    "text": "x" * 900,
                    "method": "pypdf",
                    "pages": 1,
                    "textChars": 900,
                    "errors": [],
                }

            digest_payload = {
                "top_new": [
                    {
                        "paper_id": "p1",
                        "title": "Fail first",
                        "pdf_url": "https://example.test/fail-first.pdf",
                    },
                    {
                        "paper_id": "p2",
                        "title": "Success second",
                        "pdf_url": "https://example.test/success-second.pdf",
                    },
                ]
            }
            report = MODULE.run_extraction_pipeline(
                digest_payload=digest_payload,
                digest_path=root / "digest.json",
                out_dir=out_dir,
                max_papers=1,
                timeout_sec=10,
                min_text_chars=100,
                dry_run=False,
                run_id="unit-backfill",
                download_pdf_fn=fake_download,
                extract_text_fn=fake_extract,
            )

            self.assertEqual(report["summary"]["succeeded"], 1)
            self.assertEqual(report["summary"]["failed"], 1)
            self.assertEqual(report["summary"]["processed"], 2)
            self.assertEqual(len(calls), 2)


if __name__ == "__main__":
    unittest.main()
