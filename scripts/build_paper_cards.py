#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build paper_card.v2 JSON files from deep-read manifest + note/text assets."
    )
    parser.add_argument(
        "--source-manifest",
        default="docs/research/papers/top_venue_20260228/deep_read_manifest.json",
        help="Path to deep_read_manifest.json",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/paper_cards",
        help="Directory to write paper card JSON files.",
    )
    parser.add_argument(
        "--max-papers",
        type=int,
        default=10,
        help="Maximum number of papers to process (default: 10).",
    )
    parser.add_argument(
        "--report-output",
        default="data/research/reports/paper_card_build_report.json",
        help="Path to build summary report.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any] | list[Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}\n",
        encoding="utf-8",
    )


def clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def first_sentence(text: str, default: str) -> str:
    candidates = re.split(r"[。.!?]\s+", clean_text(text))
    for candidate in candidates:
        if len(candidate) >= 20:
            return candidate.strip()
    return default


def parse_note_sections(note_text: str) -> dict[str, str]:
    key_map = {
        "problem": ("核心问题", "problem"),
        "method": ("方法机制", "method"),
        "evidence": ("证据与结果", "evidence"),
        "quant": ("定量线索", "quant"),
        "limitations": ("风险与局限", "limitation", "limitations"),
        "adaptation": ("直接改造", "adaptation", "改造"),
    }
    section_lines: dict[str, list[str]] = {k: [] for k in key_map}
    current_key: str | None = None

    for raw_line in note_text.splitlines():
        line = raw_line.strip()
        if line.startswith("## "):
            current_key = None
            lowered = line.lower()
            for key, markers in key_map.items():
                if any(marker.lower() in lowered for marker in markers):
                    current_key = key
                    break
            continue
        if not line:
            continue
        if current_key is None:
            continue
        if line.startswith("- "):
            section_lines[current_key].append(clean_text(line[2:]))
        else:
            section_lines[current_key].append(clean_text(line))

    return {k: clean_text(" ".join(v)) for k, v in section_lines.items()}


def derive_text_path(note_path: Path, paper_id: str) -> Path:
    by_structure = Path(str(note_path).replace("/notes/", "/text/")).with_suffix(".txt")
    if by_structure.exists():
        return by_structure
    sibling = note_path.parent.parent / "text" / f"{paper_id}.txt"
    return sibling


def infer_repo_root(source_manifest: Path) -> Path:
    for candidate in [source_manifest.parent, *source_manifest.parents]:
        if (candidate / "package.json").exists():
            return candidate
    return Path.cwd()


def resolve_note_path(raw_note_file: str, source_manifest: Path, repo_root: Path) -> Path:
    note_path = Path(raw_note_file)
    if note_path.is_absolute():
        return note_path

    candidates = [
        source_manifest.parent / note_path,
        Path.cwd() / note_path,
        repo_root / note_path,
        source_manifest.parent / note_path.name,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate

    return repo_root / note_path


def build_card(
    item: dict[str, Any],
    source_manifest: Path,
    repo_root: Path,
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []

    paper_id = str(item.get("paper", "")).strip()
    venue = str(item.get("venue", "")).strip() or "unknown"
    targets = item.get("targets") if isinstance(item.get("targets"), list) else []
    targets = [str(t).strip() for t in targets if str(t).strip()]
    if not targets:
        targets = ["unknown_target"]
        warnings.append("targets missing, fallback to unknown_target")

    note_file = str(item.get("note_file", "")).strip()
    note_path = resolve_note_path(note_file, source_manifest, repo_root)
    if not note_path.exists():
        raise FileNotFoundError(f"note file missing: {note_path}")
    note_text = note_path.read_text(encoding="utf-8")
    sections = parse_note_sections(note_text)

    text_path = derive_text_path(note_path, paper_id)
    text_payload = ""
    if text_path.exists():
        text_payload = text_path.read_text(encoding="utf-8")
    else:
        warnings.append(f"text file missing: {text_path}")

    problem = sections.get("problem") or first_sentence(
        text_payload, "Problem summary unavailable from source text."
    )
    method = sections.get("method") or first_sentence(
        text_payload, "Method summary unavailable from source text."
    )
    evidence_summary = sections.get("evidence") or first_sentence(
        text_payload, "Evidence summary unavailable from source text."
    )
    limitations = sections.get("limitations") or "No explicit limitations extracted."
    adaptation = sections.get("adaptation") or "No direct adaptation note extracted."
    quant = sections.get("quant") or ""

    evidence_lines = []
    if sections.get("evidence"):
        evidence_lines.extend(
            [s.strip() for s in re.split(r" - |;|。", sections["evidence"]) if s.strip()]
        )
    if not evidence_lines and text_payload:
        evidence_lines.extend(
            [s.strip() for s in re.split(r"[。.!?]\s+", text_payload) if len(s.strip()) > 30]
        )
    evidence_lines = evidence_lines[:5] if evidence_lines else [evidence_summary]

    evidence_items: list[dict[str, Any]] = []
    for idx, text in enumerate(evidence_lines, start=1):
        evidence_items.append(
            {
                "evidenceId": f"{paper_id}_E{idx}",
                "text": clean_text(text),
                "source": f"{text_path if text_path.exists() else note_path}:auto_extract",
            }
        )

    claim_seed = first_sentence(method, first_sentence(evidence_summary, "Core claim extracted from notes."))
    claims: list[dict[str, Any]] = []
    for idx, target in enumerate(targets, start=1):
        evidence_ref = evidence_items[(idx - 1) % len(evidence_items)]["evidenceId"]
        claims.append(
            {
                "claimId": f"{paper_id}_C{idx}",
                "text": f"{claim_seed} [target={target}]",
                "targetTags": [target],
                "evidenceRefs": [evidence_ref],
                "confidence": round(0.7 + 0.02 * min(idx, 10), 2),
            }
        )

    metrics: list[dict[str, Any]] = []
    if quant:
        numbers = re.findall(r"[-+]?\d*\.?\d+", quant)
        for idx, number in enumerate(numbers[:5], start=1):
            try:
                value = float(number)
            except ValueError:
                continue
            metrics.append(
                {
                    "name": f"extracted_metric_{idx}",
                    "value": value,
                    "unit": "unknown",
                    "context": "auto extracted from quant section",
                }
            )

    card = {
        "schemaVersion": "paper_card.v2",
        "paperId": paper_id,
        "title": paper_id,
        "venue": venue,
        "source": {
            "notePath": str(note_path),
            "textPath": str(text_path),
        },
        "targets": targets,
        "sections": {
            "problem": problem,
            "method": method,
            "evidence": evidence_summary,
            "limitations": limitations,
            "adaptation": adaptation,
        },
        "claims": claims,
        "evidence": evidence_items,
        "metrics": metrics,
        "trace": {
            "generatedAt": utc_now_iso(),
            "generator": "scripts/build_paper_cards.py",
            "inputManifest": str(source_manifest),
        },
    }
    return card, warnings


def main() -> int:
    args = parse_args()
    source_manifest = Path(args.source_manifest)
    out_dir = Path(args.out_dir)
    report_output = Path(args.report_output)
    repo_root = infer_repo_root(source_manifest)

    if not source_manifest.exists():
        raise FileNotFoundError(f"source manifest not found: {source_manifest}")
    payload = read_json(source_manifest)
    if not isinstance(payload, list):
        raise ValueError("source manifest must be a JSON array")

    selected = payload[: max(args.max_papers, 0)]
    out_dir.mkdir(parents=True, exist_ok=True)

    report_items: list[dict[str, Any]] = []
    built = 0
    failed = 0

    for item in selected:
        if not isinstance(item, dict):
            failed += 1
            report_items.append(
                {
                    "paperId": None,
                    "status": "failed",
                    "errors": ["manifest item is not an object"],
                }
            )
            continue

        paper_id = str(item.get("paper", "")).strip()
        try:
            card, warnings = build_card(item, source_manifest, repo_root)
            output_path = out_dir / f"{paper_id}.json"
            write_json(output_path, card)
            built += 1
            report_items.append(
                {
                    "paperId": paper_id,
                    "status": "built",
                    "output": str(output_path),
                    "warnings": warnings,
                }
            )
        except Exception as exc:  # noqa: BLE001
            failed += 1
            report_items.append(
                {
                    "paperId": paper_id or None,
                    "status": "failed",
                    "errors": [str(exc)],
                }
            )

    build_report = {
        "generatedAt": utc_now_iso(),
        "sourceManifest": str(source_manifest),
        "selectedCount": len(selected),
        "builtCount": built,
        "failedCount": failed,
        "items": report_items,
    }
    write_json(report_output, build_report)
    print(
        json.dumps(
            {
                "builtCount": built,
                "failedCount": failed,
                "outputDir": str(out_dir),
                "report": str(report_output),
            },
            ensure_ascii=False,
        )
    )

    return 0 if failed == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
