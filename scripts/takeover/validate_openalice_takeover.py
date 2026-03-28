#!/usr/bin/env python3
from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
TAKEOVER_DIR = ROOT / "docs" / "takeover" / "openalice"

REQUIRED_FILES = [
    "takeover.md",
    "system_assembly.md",
    "runtime_sequence.md",
    "layered_safety.md",
    "artifact_translation.md",
    "module_classification.md",
    "backlog.md",
    "validation_checklist.md",
    "watchlist.txt",
    "calibration_note.md",
    "runtime_executor_deep_dive.md",
    "dispatcher_hard_gates.md",
    "live_gate_governance.md",
    "strategy_runtime_semantics.md",
    "decision_packet_boundary.md",
    "openclaw_boundary.md",
]

REQUIRED_MD_SECTIONS = [
    "## Summary",
    "## Scope",
    "## Evidence",
    "## Stop Reason",
]


def fail(msg: str) -> None:
    print(f"[takeover-validate] ERROR: {msg}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    if not TAKEOVER_DIR.exists():
        fail(f"missing takeover dir: {TAKEOVER_DIR}")

    for rel in REQUIRED_FILES:
        path = TAKEOVER_DIR / rel
        if not path.exists():
            fail(f"missing required file: {rel}")

    md_files = [p for p in TAKEOVER_DIR.glob("*.md")]
    for path in md_files:
        text = path.read_text(encoding="utf-8")
        if path.name == "takeover.md":
            for heading in ("## Summary", "## Continuity Pack", "## Stop Reason"):
                if heading not in text:
                    fail(f"{path.name} missing heading: {heading}")
            continue
        for heading in REQUIRED_MD_SECTIONS:
            if heading not in text:
                fail(f"{path.name} missing heading: {heading}")

    validation = (TAKEOVER_DIR / "validation_checklist.md").read_text(encoding="utf-8")
    if "`drift` is not used as an evidence source class" not in validation:
        fail("validation checklist missing drift source-class assertion")

    backlog = (TAKEOVER_DIR / "backlog.md").read_text(encoding="utf-8")
    for title in re.findall(r"^### .+$", backlog, flags=re.MULTILINE):
        block = backlog.split(title, 1)[1]
        next_heading = re.search(r"^### .+$", block, flags=re.MULTILINE)
        if next_heading:
            block = block[: next_heading.start()]
        for required in ("- score:", "- evidence:", "- exit condition:"):
            if required not in block:
                fail(f"backlog item {title!r} missing {required.strip()}")

    watchlist = (TAKEOVER_DIR / "watchlist.txt").read_text(encoding="utf-8").splitlines()
    if not any(line.startswith("major_refresh_hint ") for line in watchlist):
        fail("watchlist missing major_refresh_hint entries")
    if not any(line.startswith("minor_refresh_hint ") for line in watchlist):
        fail("watchlist missing minor_refresh_hint entries")

    print("[takeover-validate] OK")


if __name__ == "__main__":
    main()
