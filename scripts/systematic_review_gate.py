#!/usr/bin/env python3
"""Systematic review gate for local and CI usage.

Generates:
1) Machine-readable JSON report.
2) Human-readable Markdown report.

Exit code is non-zero when at least one finding matches configured
blocking severities.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Sequence


SCAN_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".sh"}
DEFAULT_BLOCK_SEVERITIES = ("critical", "high")
DEFAULT_OUTPUT_JSON = "logs/review/latest.json"
DEFAULT_OUTPUT_MD = "systematic_code_review_report.md"

SKIP_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "dist",
    "build",
    "logs",
    "data",
    "__pycache__",
}


@dataclass(frozen=True)
class Rule:
    rule_id: str
    severity: str
    description: str
    pattern: re.Pattern[str]
    include_paths: Sequence[str] = ()
    exclude_paths: Sequence[str] = ()


RULES: Sequence[Rule] = (
    Rule(
        rule_id="CRIT001",
        severity="critical",
        description="Potential hardcoded production API key/secret token",
        pattern=re.compile(
            r"(?i)\b(api[_-]?key|secret|access[_-]?token)\b\s*[:=]\s*['\"][A-Za-z0-9_\-]{20,}['\"]"
        ),
    ),
    Rule(
        rule_id="CRIT002",
        severity="critical",
        description="Potential dynamic code execution via eval/new Function",
        pattern=re.compile(r"(?<![\w$.])eval\s*\(|\bnew\s+Function\s*\("),
    ),
    Rule(
        rule_id="HIGH001",
        severity="high",
        description="Potential command execution via child_process.exec",
        pattern=re.compile(r"\bchild_process\.exec(?:Sync)?\s*\("),
    ),
    Rule(
        rule_id="HIGH002",
        severity="high",
        description="TLS verification appears disabled",
        pattern=re.compile(
            r"NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]?0|rejectUnauthorized\s*:\s*false"
        ),
    ),
    Rule(
        rule_id="HIGH003",
        severity="high",
        description="Hardcoded risk-gate bypass flag detected in non-test source",
        pattern=re.compile(
            r"\b(ignoreReleaseGate|ignoreRegimeShift)\s*:\s*true\b"
            r"|\brequireReleaseGatePass\s*:\s*false\b"
        ),
        include_paths=("src/**/*.ts", "src/**/*.tsx", "src/**/*.js", "src/**/*.jsx"),
        exclude_paths=("**/*.spec.*", "**/*.test.*", "**/__tests__/**"),
    ),
)

OP_DISPATCHER_PATH = "src/extension/crypto-trading/operation-dispatcher.ts"
LIVE_GATE_MANAGER_PATH = "src/runtime/live_gate_manager.ts"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run systematic code-review gate and emit JSON/Markdown reports."
    )
    parser.add_argument("--repo", default=".", help="Repository root path.")
    parser.add_argument(
        "--mode",
        choices=("repo", "changed"),
        default="repo",
        help="Scan entire repository or only changed files.",
    )
    parser.add_argument(
        "--output-json",
        default=DEFAULT_OUTPUT_JSON,
        help="Path to write machine-readable JSON report.",
    )
    parser.add_argument(
        "--output-md",
        default=DEFAULT_OUTPUT_MD,
        help="Path to write human-readable Markdown report.",
    )
    parser.add_argument(
        "--block-severities",
        default=",".join(DEFAULT_BLOCK_SEVERITIES),
        help="Comma-separated severities that should fail the gate.",
    )
    parser.add_argument(
        "--include-tests",
        action="store_true",
        help="Include *_test/spec files and test directories.",
    )
    return parser.parse_args()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_review_gate_config(repo_root: Path) -> Dict[str, object]:
    config_path = repo_root / "data" / "config" / "review-gate.json"
    if not config_path.exists():
        return {}
    try:
        return json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def is_test_path(path: Path) -> bool:
    parts = set(path.parts)
    name = path.name.lower()
    return (
        ".spec." in name
        or ".test." in name
        or name.endswith("_test.py")
        or "tests" in parts
        or "__tests__" in parts
    )


def path_matches(path: Path, patterns: Sequence[str]) -> bool:
    path_str = path.as_posix()
    return any(fnmatch.fnmatch(path_str, pattern) for pattern in patterns)


def should_apply_rule(path: Path, rule: Rule) -> bool:
    if rule.include_paths and not path_matches(path, rule.include_paths):
        return False
    if rule.exclude_paths and path_matches(path, rule.exclude_paths):
        return False
    return True


def build_finding(
    *,
    rule_id: str,
    severity: str,
    description: str,
    file: Path,
    line: int,
    match: str,
    source: str,
) -> Dict[str, object]:
    return {
        "ruleId": rule_id,
        "severity": severity,
        "description": description,
        "file": file.as_posix(),
        "line": line,
        "match": match.strip()[:240],
        "source": source,
    }


def line_number_from_offset(text: str, offset: int) -> int:
    return text[:offset].count("\n") + 1


def check_connector_direct_place_order(path: Path, text: str) -> List[Dict[str, object]]:
    path_str = path.as_posix()
    if is_test_path(path):
        return []
    if not (path_str.startswith("src/connectors/") or path_str.startswith("src/plugins/")):
        return []

    findings: List[Dict[str, object]] = []
    for match in re.finditer(
        r"\b(?:ctx\.cryptoEngine|engine)\.placeOrder\s*\(\s*\{",
        text,
        flags=re.MULTILINE,
    ):
        block_end = text.find("})", match.end(), match.end() + 900)
        block = text[match.end() : block_end if block_end != -1 else match.end() + 900]
        if re.search(r"\breduceOnly\s*:\s*true\b", block):
            continue
        findings.append(
            build_finding(
                rule_id="HIGH004",
                severity="high",
                description=(
                    "Direct placeOrder in connector/plugin must be reduceOnly emergency flow "
                    "or go through dispatcher risk gate"
                ),
                file=path,
                line=line_number_from_offset(text, match.start()),
                match=match.group(0),
                source="structural",
            )
        )
    return findings


def check_dispatcher_guard_anchors(path: Path, text: str) -> List[Dict[str, object]]:
    if path.as_posix() != OP_DISPATCHER_PATH:
        return []

    findings: List[Dict[str, object]] = []
    required_anchors = (
        ("HIGH005", "getIdempotencyPolicy(", "Idempotency policy guard anchor missing"),
        ("HIGH006", "withPlaceOrderLock", "Order lock guard anchor missing"),
        ("HIGH007", "preTradeRiskCheck(", "Risk pre-check anchor missing"),
    )
    for rule_id, anchor, description in required_anchors:
        idx = text.find(anchor)
        if idx >= 0:
            continue
        findings.append(
            build_finding(
                rule_id=rule_id,
                severity="high",
                description=description,
                file=path,
                line=1,
                match=anchor,
                source="structural",
            )
        )
    return findings


def check_live_gate_release_anchor(path: Path, text: str) -> List[Dict[str, object]]:
    if path.as_posix() != LIVE_GATE_MANAGER_PATH:
        return []

    required = ("isReleaseGateStatusBlocking(", "requireReleaseGatePass")
    missing = [anchor for anchor in required if anchor not in text]
    if not missing:
        return []
    return [
        build_finding(
            rule_id="HIGH008",
            severity="high",
            description="Live gate release-status guard anchor missing",
            file=path,
            line=1,
            match=", ".join(missing),
            source="structural",
        )
    ]


def run_structural_checks(path: Path, text: str) -> List[Dict[str, object]]:
    findings: List[Dict[str, object]] = []
    findings.extend(check_connector_direct_place_order(path, text))
    findings.extend(check_dispatcher_guard_anchors(path, text))
    findings.extend(check_live_gate_release_anchor(path, text))
    return findings


def is_scan_target(path: Path, include_tests: bool) -> bool:
    if path.suffix.lower() not in SCAN_EXTENSIONS:
        return False
    if not include_tests and is_test_path(path):
        return False
    return True


def iter_repo_files(repo_root: Path, include_tests: bool) -> Iterable[Path]:
    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        root_path = Path(root)
        for file_name in files:
            file_path = root_path / file_name
            rel = file_path.relative_to(repo_root)
            if is_scan_target(rel, include_tests):
                yield rel


def git_changed_files(repo_root: Path) -> List[Path]:
    changed: List[str] = []

    diff_cmd = [
        "git",
        "diff",
        "--name-only",
        "--diff-filter=ACMRTUXB",
        "HEAD",
    ]
    untracked_cmd = ["git", "ls-files", "--others", "--exclude-standard"]

    for cmd in (diff_cmd, untracked_cmd):
        try:
            out = subprocess.check_output(
                cmd,
                cwd=str(repo_root),
                text=True,
                stderr=subprocess.DEVNULL,
            )
        except subprocess.CalledProcessError:
            continue
        changed.extend([line.strip() for line in out.splitlines() if line.strip()])

    deduped: List[Path] = []
    seen = set()
    for raw in changed:
        if raw in seen:
            continue
        seen.add(raw)
        p = Path(raw)
        if p.exists():
            deduped.append(p)
    return deduped


def read_lines(path: Path) -> List[str]:
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1").splitlines()


def run_scan(
    repo_root: Path,
    files: Sequence[Path],
    block_severities: Sequence[str],
) -> Dict[str, object]:
    findings: List[Dict[str, object]] = []

    for rel in files:
        abs_path = repo_root / rel
        try:
            lines = read_lines(abs_path)
        except Exception:
            continue
        text = "\n".join(lines)

        for lineno, line in enumerate(lines, start=1):
            for rule in RULES:
                if not should_apply_rule(rel, rule):
                    continue
                if rule.pattern.search(line):
                    findings.append(
                        build_finding(
                            rule_id=rule.rule_id,
                            severity=rule.severity,
                            description=rule.description,
                            file=rel,
                            line=lineno,
                            match=line,
                            source="regex",
                        )
                    )

        findings.extend(run_structural_checks(rel, text))

    counts: Dict[str, int] = {"critical": 0, "high": 0, "medium": 0, "low": 0}
    for finding in findings:
        sev = str(finding["severity"]).lower()
        counts[sev] = counts.get(sev, 0) + 1

    blocking = [f for f in findings if str(f["severity"]).lower() in block_severities]

    return {
        "generatedAt": utc_now(),
        "rulesVersion": "review-gate-v2",
        "scannedFiles": len(files),
        "counts": counts,
        "blockSeverities": list(block_severities),
        "blockingFindings": len(blocking),
        "status": "failed" if blocking else "passed",
        "findings": findings,
    }


def write_json(path: Path, payload: Dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_markdown(path: Path, payload: Dict[str, object]) -> None:
    lines: List[str] = []
    lines.append("# Systematic Code Review Report")
    lines.append("")
    lines.append(f"- generatedAt: `{payload['generatedAt']}`")
    lines.append(f"- status: `{payload['status']}`")
    lines.append(f"- scannedFiles: `{payload['scannedFiles']}`")
    lines.append(
        "- counts: "
        + ", ".join(
            f"{k}={v}" for k, v in (payload.get("counts") or {}).items()  # type: ignore[arg-type]
        )
    )
    lines.append(
        "- blockSeverities: "
        + ",".join(payload.get("blockSeverities", []))  # type: ignore[arg-type]
    )
    lines.append(f"- blockingFindings: `{payload['blockingFindings']}`")
    lines.append("")
    lines.append("## Findings")
    lines.append("")
    lines.append("| Rule | Severity | File | Line | Description | Snippet |")
    lines.append("|---|---|---|---:|---|---|")

    findings = payload.get("findings", [])
    if not findings:
        lines.append("| - | - | - | - | No findings | - |")
    else:
        for finding in findings:  # type: ignore[assignment]
            f = finding  # type: ignore[assignment]
            description = str(f["description"]).replace("|", "/")
            snippet = str(f["match"]).replace("`", "'").replace("|", "/").strip()
            lines.append(
                "| "
                + f"{f['ruleId']} | {f['severity']} | {f['file']} | {f['line']} | "
                + f"{description} | "
                + f"`{snippet}` |"
            )

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    repo_root = Path(args.repo).resolve()
    cfg = load_review_gate_config(repo_root)

    raw_block_severities = cfg.get("blockSeverities", args.block_severities)
    if isinstance(raw_block_severities, list):
        block_severities = [
            str(s).strip().lower() for s in raw_block_severities if str(s).strip()
        ]
    else:
        block_severities = [
            s.strip().lower()
            for s in str(raw_block_severities).split(",")
            if s.strip()
        ]
    scope = str(cfg.get("scope", args.mode))
    if scope not in {
        "repo",
        "changed",
        "repo_full_scan_once_then_changed_files",
        "repo_full_scan",
        "changed_only",
    }:
        scope = args.mode

    output_json = Path(str(cfg.get("reportPath", args.output_json)))
    if not output_json.is_absolute():
        output_json = repo_root / output_json
    output_md = Path(args.output_md)
    if not output_md.is_absolute():
        output_md = repo_root / output_md

    if scope == "repo_full_scan_once_then_changed_files":
        effective_mode = "changed" if output_json.exists() else "repo"
    elif scope in {"repo", "repo_full_scan"}:
        effective_mode = "repo"
    else:
        effective_mode = "changed"

    if effective_mode == "changed":
        candidates = [p for p in git_changed_files(repo_root) if is_scan_target(p, args.include_tests)]
        if not candidates:
            # Changed-mode fallback to avoid false green when no changes are detected by git.
            candidates = list(iter_repo_files(repo_root, args.include_tests))
    else:
        candidates = list(iter_repo_files(repo_root, args.include_tests))

    report = run_scan(repo_root, candidates, block_severities)
    write_json(output_json, report)
    write_markdown(output_md, report)

    print(
        json.dumps(
            {
                "status": report["status"],
                "scannedFiles": report["scannedFiles"],
                "blockingFindings": report["blockingFindings"],
                "jsonReport": str(output_json),
                "markdownReport": str(output_md),
            }
        )
    )
    return 1 if report["status"] == "failed" else 0


if __name__ == "__main__":
    raise SystemExit(main())
