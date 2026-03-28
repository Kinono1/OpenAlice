#!/usr/bin/env python3
"""Extract text from PDFs referenced by a strategy research digest."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Sequence

DEFAULT_DIGEST = "data/research/strategy-watch/latest_digest.json"
DEFAULT_OUT_DIR = "data/research/literature/pdf_extract"
REPORT_SCHEMA_VERSION = "pdf_extract_report.v1"

SAFE_ID_PATTERN = re.compile(r"[^a-z0-9._-]+")
MULTI_DASH_PATTERN = re.compile(r"-{2,}")

DownloadFn = Callable[[str, Path, int], None]
ExtractFn = Callable[[Path, int], Dict[str, Any]]


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Download PDFs from digest top_new and extract plain text.",
    )
    parser.add_argument(
        "--digest",
        default=DEFAULT_DIGEST,
        help="Digest JSON path (default: data/research/strategy-watch/latest_digest.json).",
    )
    parser.add_argument(
        "--out-dir",
        default=DEFAULT_OUT_DIR,
        help="Output directory (default: data/research/literature/pdf_extract).",
    )
    parser.add_argument(
        "--max-papers",
        type=int,
        default=10,
        help="Maximum papers to process (default: 10).",
    )
    parser.add_argument(
        "--timeout-sec",
        type=int,
        default=25,
        help="HTTP timeout in seconds for PDF download (default: 25).",
    )
    parser.add_argument(
        "--min-text-chars",
        type=int,
        default=800,
        help="Fallback to pdfplumber when pypdf chars are below this threshold (default: 800).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan-only mode; do not download/extract paper assets.",
    )
    parsed_argv: Sequence[str] | None = argv
    if parsed_argv is None:
        parsed_argv = sys.argv[1:]
    if parsed_argv and parsed_argv[0] == "--":
        parsed_argv = parsed_argv[1:]
    return parser.parse_args(parsed_argv)


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def utc_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def resolve_path(cwd: Path, raw_path: str) -> Path:
    candidate = Path(raw_path)
    if candidate.is_absolute():
        return candidate
    return cwd / candidate


def read_json_object(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must be a JSON object")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def normalize_safe_id(value: str) -> str:
    normalized = (
        unicodedata.normalize("NFKD", str(value))
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    normalized = normalized.replace("/", "-")
    normalized = SAFE_ID_PATTERN.sub("-", normalized)
    normalized = MULTI_DASH_PATTERN.sub("-", normalized).strip("-_.")
    return normalized or "paper"


def build_safe_id(entry: Dict[str, Any], index: int) -> str:
    for key in ("paper_id", "paperId", "paper", "id", "title"):
        raw = str(entry.get(key, "")).strip()
        if raw:
            safe = normalize_safe_id(raw)
            if safe != "paper":
                return safe
    return f"paper-{index:03d}"


def ensure_unique_safe_id(base: str, used: set[str]) -> str:
    if base not in used:
        used.add(base)
        return base

    suffix = 2
    while True:
        candidate = f"{base}-{suffix}"
        if candidate not in used:
            used.add(candidate)
            return candidate
        suffix += 1


def normalize_pdf_url(raw_url: Any) -> str:
    text = str(raw_url or "").strip()
    if not text:
        return ""
    lowered = text.lower()
    if lowered in {"none", "null", "nan", "n/a", "na"}:
        return ""
    parsed = urllib.parse.urlparse(text)
    if parsed.scheme not in {"http", "https"}:
        return ""
    if not parsed.netloc:
        return ""
    return text


def download_pdf(url: str, destination: Path, timeout_sec: int) -> None:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "OpenAlice-PDF-Extract/1.0"},
    )
    timeout = max(int(timeout_sec), 1)
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        payload = response.read()
    if not payload:
        raise RuntimeError(f"Downloaded empty payload from {url}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(payload)


def extract_text_pypdf(pdf_path: Path) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("pypdf is not available") from exc

    reader = PdfReader(str(pdf_path))
    chunks: List[str] = []
    for page in reader.pages:
        page_text = page.extract_text() or ""
        if page_text:
            chunks.append(page_text)
    return "\n\n".join(chunks).strip(), len(reader.pages)


def extract_text_pdfplumber(pdf_path: Path) -> tuple[str, int]:
    try:
        import pdfplumber
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("pdfplumber is not available") from exc

    with pdfplumber.open(str(pdf_path)) as pdf:
        chunks: List[str] = []
        for page in pdf.pages:
            page_text = page.extract_text() or ""
            if page_text:
                chunks.append(page_text)
        return "\n\n".join(chunks).strip(), len(pdf.pages)


def extract_text_pdftotext(pdf_path: Path) -> tuple[str, int]:
    binary = shutil.which("pdftotext")
    if not binary:
        raise RuntimeError("pdftotext is not available")
    proc = subprocess.run(
        [binary, "-layout", str(pdf_path), "-"],
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        raise RuntimeError(stderr or f"pdftotext exit code {proc.returncode}")
    text = (proc.stdout or "").strip()

    pages = 0
    pdfinfo_binary = shutil.which("pdfinfo")
    if pdfinfo_binary:
        info = subprocess.run(
            [pdfinfo_binary, str(pdf_path)],
            check=False,
            capture_output=True,
            text=True,
        )
        if info.returncode == 0:
            for line in (info.stdout or "").splitlines():
                if line.lower().startswith("pages:"):
                    try:
                        pages = int(line.split(":", 1)[1].strip())
                    except Exception:
                        pages = 0
                    break
    return text, pages


def extract_text_with_fallback(pdf_path: Path, min_text_chars: int) -> Dict[str, Any]:
    errors: List[str] = []
    fallback_attempted = False
    threshold = max(int(min_text_chars), 0)

    pypdf_text = ""
    pypdf_pages = 0
    pypdf_ok = False
    try:
        pypdf_text, pypdf_pages = extract_text_pypdf(pdf_path)
        pypdf_ok = True
    except Exception as exc:  # noqa: BLE001
        errors.append(f"pypdf: {exc}")

    pypdf_chars = len(pypdf_text)
    needs_fallback = (not pypdf_ok) or pypdf_chars < threshold
    if not needs_fallback:
        return {
            "text": pypdf_text,
            "method": "pypdf",
            "pages": pypdf_pages,
            "textChars": pypdf_chars,
            "errors": errors,
            "fallbackAttempted": False,
        }

    fallback_attempted = True
    try:
        plumber_text, plumber_pages = extract_text_pdfplumber(pdf_path)
        plumber_chars = len(plumber_text)
        if plumber_chars > 0:
            return {
                "text": plumber_text,
                "method": "pdfplumber",
                "pages": plumber_pages,
                "textChars": plumber_chars,
                "errors": errors,
                "fallbackAttempted": fallback_attempted,
            }
    except Exception as exc:  # noqa: BLE001
        errors.append(f"pdfplumber: {exc}")

    try:
        tool_text, tool_pages = extract_text_pdftotext(pdf_path)
        tool_chars = len(tool_text)
        if tool_chars > 0:
            return {
                "text": tool_text,
                "method": "pdftotext",
                "pages": tool_pages,
                "textChars": tool_chars,
                "errors": errors,
                "fallbackAttempted": fallback_attempted,
            }
    except Exception as exc:  # noqa: BLE001
        errors.append(f"pdftotext: {exc}")

    if pypdf_ok:
        return {
            "text": pypdf_text,
            "method": "pypdf",
            "pages": pypdf_pages,
            "textChars": pypdf_chars,
            "errors": errors,
            "fallbackAttempted": fallback_attempted,
        }

    error_msg = "; ".join(errors) if errors else "text extraction failed"
    raise RuntimeError(error_msg)


def select_pdf_entries(
    digest_payload: Dict[str, Any],
    max_papers: int,
) -> tuple[List[Dict[str, Any]], int, int]:
    rows_raw = digest_payload.get("top_new", [])
    rows = rows_raw if isinstance(rows_raw, list) else []
    if not rows:
        recent_raw = digest_payload.get("top_recent", [])
        rows = recent_raw if isinstance(recent_raw, list) else []
    with_pdf: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        pdf_url = normalize_pdf_url(row.get("pdf_url", ""))
        if pdf_url:
            row_copy = dict(row)
            row_copy["pdf_url"] = pdf_url
            with_pdf.append(row_copy)
    selected = with_pdf[: max(int(max_papers), 0)]
    return selected, len(rows), len(with_pdf)


def build_report(
    *,
    run_id: str,
    digest_path: Path,
    out_dir: Path,
    max_papers: int,
    timeout_sec: int,
    min_text_chars: int,
    dry_run: bool,
    total_digest_entries: int,
    with_pdf_url: int,
    paper_reports: List[Dict[str, Any]],
    downloaded: int,
    skipped_existing_pdf: int,
    global_errors: List[str],
) -> Dict[str, Any]:
    succeeded = sum(1 for item in paper_reports if item.get("status") == "success")
    failed = sum(1 for item in paper_reports if item.get("status") == "failed")
    dry_run_count = sum(1 for item in paper_reports if item.get("status") == "dry_run")

    return {
        "schemaVersion": REPORT_SCHEMA_VERSION,
        "generatedAt": utc_now_iso(),
        "runId": run_id,
        "digestPath": str(digest_path),
        "outDir": str(out_dir),
        "config": {
            "maxPapers": max(int(max_papers), 0),
            "timeoutSec": max(int(timeout_sec), 1),
            "minTextChars": max(int(min_text_chars), 0),
            "dryRun": bool(dry_run),
        },
        "summary": {
            "totalDigestEntries": int(total_digest_entries),
            "withPdfUrl": int(with_pdf_url),
            "selected": len(paper_reports),
            "processed": len(paper_reports),
            "succeeded": succeeded,
            "failed": failed,
            "downloaded": int(downloaded),
            "skippedExistingPdf": int(skipped_existing_pdf),
            "dryRunCount": dry_run_count,
        },
        "papers": paper_reports,
        "errors": global_errors,
    }


def write_report_files(out_dir: Path, run_id: str, report: Dict[str, Any]) -> tuple[Path, Path]:
    latest_path = out_dir / "latest_pdf_extract_report.v1.json"
    archive_path = out_dir / "archive" / run_id / "pdf_extract_report.v1.json"
    write_json(latest_path, report)
    write_json(archive_path, report)
    return latest_path, archive_path


def run_extraction_pipeline(
    *,
    digest_payload: Dict[str, Any],
    digest_path: Path,
    out_dir: Path,
    max_papers: int,
    timeout_sec: int,
    min_text_chars: int,
    dry_run: bool,
    run_id: str,
    download_pdf_fn: DownloadFn = download_pdf,
    extract_text_fn: ExtractFn = extract_text_with_fallback,
    global_errors: List[str] | None = None,
) -> Dict[str, Any]:
    selected, total_digest_entries, with_pdf_url = select_pdf_entries(
        digest_payload=digest_payload,
        max_papers=max_papers,
    )
    max_successes = max(int(max_papers), 0)
    if not dry_run and max_successes > 0 and with_pdf_url > max_successes:
        rows_raw = digest_payload.get("top_new", [])
        rows = rows_raw if isinstance(rows_raw, list) else []
        if not rows:
            recent_raw = digest_payload.get("top_recent", [])
            rows = recent_raw if isinstance(recent_raw, list) else []
        expanded: List[Dict[str, Any]] = []
        for row in rows:
            if not isinstance(row, dict):
                continue
            pdf_url = normalize_pdf_url(row.get("pdf_url", ""))
            if not pdf_url:
                continue
            row_copy = dict(row)
            row_copy["pdf_url"] = pdf_url
            expanded.append(row_copy)
        selected = expanded

    used_safe_ids: set[str] = set()
    paper_reports: List[Dict[str, Any]] = []

    downloaded = 0
    skipped_existing_pdf = 0
    success_count = 0
    run_errors: List[str] = list(global_errors or [])

    for index, entry in enumerate(selected, start=1):
        if not dry_run and max_successes > 0 and success_count >= max_successes:
            break

        safe_id = ensure_unique_safe_id(build_safe_id(entry, index), used_safe_ids)
        pdf_url = normalize_pdf_url(entry.get("pdf_url", ""))
        paper_id = str(entry.get("paper_id", "")).strip()
        title = str(entry.get("title", "")).strip()

        pdf_path = out_dir / "pdfs" / f"{safe_id}.pdf"
        text_path = out_dir / "text" / f"{safe_id}.txt"

        row: Dict[str, Any] = {
            "paperIndex": index,
            "safeId": safe_id,
            "paperId": paper_id,
            "title": title,
            "pdfUrl": pdf_url,
            "pdfPath": str(pdf_path),
            "textPath": str(text_path),
            "status": "pending",
            "downloadStatus": "pending",
            "method": "none",
            "pages": 0,
            "textChars": 0,
            "errors": [],
        }

        if dry_run:
            row["status"] = "dry_run"
            row["downloadStatus"] = "dry_run"
            paper_reports.append(row)
            continue

        if not pdf_url:
            row["status"] = "failed"
            row["downloadStatus"] = "failed"
            row["errors"].append("download: invalid pdf url")
            paper_reports.append(row)
            continue

        try:
            if pdf_path.exists():
                row["downloadStatus"] = "skipped_existing"
                skipped_existing_pdf += 1
            else:
                pdf_path.parent.mkdir(parents=True, exist_ok=True)
                download_pdf_fn(pdf_url, pdf_path, max(int(timeout_sec), 1))
                row["downloadStatus"] = "downloaded"
                downloaded += 1
        except Exception as exc:  # noqa: BLE001
            row["status"] = "failed"
            row["downloadStatus"] = "failed"
            row["errors"].append(f"download: {exc}")
            paper_reports.append(row)
            continue

        try:
            result = extract_text_fn(pdf_path, max(int(min_text_chars), 0))
            text = str(result.get("text", ""))
            text_chars = int(result.get("textChars", len(text)))
            text_path.parent.mkdir(parents=True, exist_ok=True)
            text_path.write_text(text, encoding="utf-8")

            row["status"] = "success"
            row["method"] = str(result.get("method", "none"))
            row["pages"] = int(result.get("pages", 0))
            row["textChars"] = text_chars
            success_count += 1
            errors = result.get("errors", [])
            if isinstance(errors, list):
                row["errors"].extend(str(item) for item in errors if str(item).strip())
        except Exception as exc:  # noqa: BLE001
            row["status"] = "failed"
            row["errors"].append(f"extract: {exc}")

        paper_reports.append(row)

    return build_report(
        run_id=run_id,
        digest_path=digest_path,
        out_dir=out_dir,
        max_papers=max_papers,
        timeout_sec=timeout_sec,
        min_text_chars=min_text_chars,
        dry_run=dry_run,
        total_digest_entries=total_digest_entries,
        with_pdf_url=with_pdf_url,
        paper_reports=paper_reports,
        downloaded=downloaded,
        skipped_existing_pdf=skipped_existing_pdf,
        global_errors=run_errors,
    )


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    cwd = Path.cwd()
    digest_path = resolve_path(cwd, args.digest)
    out_dir = resolve_path(cwd, args.out_dir)
    run_id = utc_run_id()

    digest_errors: List[str] = []
    try:
        digest_payload = read_json_object(digest_path)
    except Exception as exc:  # noqa: BLE001
        digest_payload = {"top_new": []}
        digest_errors.append(f"digest_read_error: {exc}")

    report = run_extraction_pipeline(
        digest_payload=digest_payload,
        digest_path=digest_path,
        out_dir=out_dir,
        max_papers=max(args.max_papers, 0),
        timeout_sec=max(args.timeout_sec, 1),
        min_text_chars=max(args.min_text_chars, 0),
        dry_run=bool(args.dry_run),
        run_id=run_id,
        global_errors=digest_errors,
    )
    latest_path, archive_path = write_report_files(out_dir, run_id, report)

    print(
        json.dumps(
            {
                "schemaVersion": REPORT_SCHEMA_VERSION,
                "runId": run_id,
                "latestReport": str(latest_path),
                "archiveReport": str(archive_path),
                "summary": report.get("summary", {}),
            },
            ensure_ascii=False,
        )
    )

    if digest_errors:
        print(
            f"ERROR: failed to load digest {digest_path}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
