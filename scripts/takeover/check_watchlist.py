#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fnmatch
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WATCHLIST = ROOT / "docs" / "takeover" / "openalice" / "watchlist.txt"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Emit takeover refresh hints for changed files.")
    parser.add_argument("--base", default="", help="Base git revision or SHA")
    parser.add_argument("--head", default="HEAD", help="Head git revision or SHA")
    return parser.parse_args()


def load_rules() -> list[tuple[str, str]]:
    rules: list[tuple[str, str]] = []
    for raw in WATCHLIST.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        hint, pattern = line.split(maxsplit=1)
        rules.append((hint, pattern))
    return rules


def changed_files(base: str, head: str) -> list[str]:
    if base:
        cmd = ["git", "diff", "--name-only", base, head]
    else:
        cmd = ["git", "diff", "--name-only", "HEAD~1", head]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, capture_output=True)
    if proc.returncode != 0:
        fallback = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            check=False,
        )
        if fallback.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or "git diff failed")
        files: list[str] = []
        for line in fallback.stdout.splitlines():
            if not line.strip():
                continue
            path = line[3:].strip()
            if path:
                files.append(path)
        return files
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def main() -> None:
    args = parse_args()
    rules = load_rules()
    files = changed_files(args.base, args.head)
    matched: list[tuple[str, str, str]] = []
    for path in files:
        for hint, pattern in rules:
            if fnmatch.fnmatch(path, pattern):
                matched.append((hint, pattern, path))

    if not matched:
        print("[takeover-watchlist] no takeover watchlist hits")
        return

    print("[takeover-watchlist] matched refresh hints:")
    for hint, pattern, path in matched:
        print(f"- {hint}: {path} (rule: {pattern})")


if __name__ == "__main__":
    main()
