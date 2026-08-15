#!/usr/bin/env python3
"""
Point-in-Time audit scanner for Python training scripts.

Scans Python training scripts for common look-ahead bias patterns:
synthetic label construction via negative shift, silent NaN filling,
global normalization without train/test split, and arbitrary column
selection via iloc.  Results are advisory-only and include an
allowlist mechanism to suppress known-safe findings per file.

Usage:
    python scripts/train/pit_audit.py \\
        --scripts-dir scripts/train \\
        --report-path data/research/pit_audit_report.json
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

# ---------------------------------------------------------------------------
# Project root — scripts/train/pit_audit.py sits 3 levels under BASE
# ---------------------------------------------------------------------------
BASE = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------------------
# Check registry
#
# Each entry defines a regex pattern (grep-compatible) and a severity.
# ---------------------------------------------------------------------------
CHECKS = {
    "shift_negative": {
        "pattern": re.compile(r"\.shift\s*\(\s*-\d+\s*\)"),
        "severity": "high",
        "description": "Negative shift -- possible synthetic label construction (look-ahead bias)",
    },
    "fillna_zero": {
        "pattern": re.compile(r"fillna\s*\(\s*(?:0|[\"']ffill[\"'])\s*\)"),
        "severity": "high",
        "description": "Silent NaN filling -- may mask data quality issues",
    },
    "global_norm": {
        "pattern": re.compile(r"(?:StandardScaler\(\)|scaler)\s*\.\s*fit(?:_transform)?\s*\("),
        "severity": "medium",
        "description": "Global fit -- possible normalization without train/test split",
    },
    "iloc_selection": {
        "pattern": re.compile(r"iloc\s*\[\s*:\s*,\s*:\s*\w+\s*\]"),
        "severity": "medium",
        "description": "iloc column selection -- selecting first N columns arbitrarily",
    },
}

# ---------------------------------------------------------------------------
# Allowlist parsing
# ---------------------------------------------------------------------------
# Matches a line comment like:  # pit:allow=shift_negative, fillna_zero
_ALLOWLIST_RE = re.compile(r"#\s*pit:\s*allow\s*=\s*(\w+(?:\s*,\s*\w+)*)")


def _parse_allowlist(text: str) -> set[str]:
    """Extract allowlisted check names from the file's source text."""
    m = _ALLOWLIST_RE.search(text)
    if not m:
        return set()
    raw = m.group(1)
    return {token.strip() for token in raw.split(",")}


# ---------------------------------------------------------------------------
# File-level scanning
# ---------------------------------------------------------------------------
def _scan_file(filepath: Path) -> dict:
    """Run all checks against a single .py file and return a result dict.

    The result follows the report schema for one file entry:
        file, checks, allowlist_used, overall_verdict, n_findings
    An ``errors`` list is included only when the file could not be read.
    """
    try:
        relative = filepath.relative_to(BASE).as_posix()
    except ValueError:
        # File is outside the project tree (e.g., temp file in tests)
        relative = filepath.resolve().as_posix()

    # ---- Read with encoding fallback ---------------------------------------
    raw: str | None = None
    errors: list[str] = []
    for enc in ("utf-8", "latin-1"):
        try:
            raw = filepath.read_text(encoding=enc)
            break
        except UnicodeDecodeError:
            continue
        except (OSError, PermissionError) as exc:
            errors.append(f"Unreadable: {exc}")
            break

    if raw is None:
        errors.append("Unreadable: no suitable encoding found")

    if errors:
        return {
            "file": relative,
            "checks": {},
            "allowlist_used": [],
            "overall_verdict": "CLEAN",
            "n_findings": 0,
            "errors": errors,
        }

    # Empty file -> no findings
    if not raw.strip():
        return {
            "file": relative,
            "checks": {},
            "allowlist_used": [],
            "overall_verdict": "CLEAN",
            "n_findings": 0,
        }

    # ---- Parse allowlist ---------------------------------------------------
    allowed = _parse_allowlist(raw)

    # ---- Run regex checks --------------------------------------------------
    lines = raw.splitlines()
    checks_result: dict[str, dict] = {}
    any_triggered = False
    any_real_finding = False

    for check_name, check_def in CHECKS.items():
        pattern = check_def["pattern"]
        matches: list[tuple[int, str]] = []
        for lineno, line_text in enumerate(lines, start=1):
            if pattern.search(line_text):
                matches.append((lineno, line_text.strip()))

        if not matches:
            continue  # omit from output — nothing to report

        any_triggered = True
        line_nums = [m[0] for m in matches]
        snippets = [m[1] for m in matches]

        if check_name in allowed:
            verdict = "ALLOWLISTED"
        else:
            verdict = "FINDING"
            any_real_finding = True

        checks_result[check_name] = {
            "found": True,
            "lines": line_nums,
            "snippets": snippets,
            "severity": check_def["severity"],
            "verdict": verdict,
        }

    # ---- Derive verdicts ---------------------------------------------------
    if not any_triggered:
        overall_verdict = "CLEAN"
    elif any_real_finding:
        overall_verdict = "MANUAL_REVIEW_REQUIRED"
    else:
        overall_verdict = "CLEAN"  # all triggered checks were allowlisted

    n_findings = sum(
        1 for chk in checks_result.values() if chk["verdict"] == "FINDING"
    )

    return {
        "file": relative,
        "checks": checks_result,
        "allowlist_used": sorted(allowed),
        "overall_verdict": overall_verdict,
        "n_findings": n_findings,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="Point-in-Time audit scanner -- detect look-ahead bias in training scripts."
    )
    parser.add_argument(
        "--scripts-dir",
        default="scripts/train",
        help="Relative or absolute path to the scripts directory (default: scripts/train)",
    )
    parser.add_argument(
        "--report-path",
        default="data/research/pit_audit_report.json",
        help="Output path for the JSON report (default: data/research/pit_audit_report.json)",
    )
    args = parser.parse_args()

    # Resolve paths (relative = relative to project root BASE)
    scripts_dir = Path(args.scripts_dir)
    if not scripts_dir.is_absolute():
        scripts_dir = BASE / scripts_dir

    report_path = Path(args.report_path)
    if not report_path.is_absolute():
        report_path = BASE / report_path

    if not scripts_dir.is_dir():
        print(f"[FATAL] Scripts directory not found: {scripts_dir}", file=sys.stderr)
        sys.exit(1)

    # Ensure parent directory exists for the report
    report_path.parent.mkdir(parents=True, exist_ok=True)

    # Collect all .py files
    py_files = sorted(scripts_dir.glob("*.py"))
    if not py_files:
        print(f"[WARN] No .py files found in {scripts_dir}")

    # Scan every file
    results = [_scan_file(fpath) for fpath in py_files]

    # ---- Summary -----------------------------------------------------------
    n_files = len(py_files)
    n_clean = 0          # no check triggered at all
    n_findings = 0       # all triggered checks were allowlisted
    n_manual_review = 0  # at least one non-allowlisted finding

    for r in results:
        verdict = r.get("overall_verdict", "CLEAN")
        has_any_trigger = bool(r.get("checks"))
        if verdict == "MANUAL_REVIEW_REQUIRED":
            n_manual_review += 1
        elif has_any_trigger:
            n_findings += 1
        else:
            n_clean += 1

    report = {
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "scripts_dir": str(scripts_dir),
        "n_files": n_files,
        "results": results,
        "summary": {
            "n_files": n_files,
            "n_clean": n_clean,
            "n_findings": n_findings,
            "n_manual_review": n_manual_review,
        },
    }

    report_path.write_text(
        json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    print(f"[OK] PIT audit report written -> {report_path}")
    print(
        f"     {n_files} files | {n_clean} clean | "
        f"{n_findings} allowlisted | {n_manual_review} manual review"
    )


if __name__ == "__main__":
    main()
