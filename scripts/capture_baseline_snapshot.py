#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Capture baseline snapshot for V5 execution plan."
    )
    parser.add_argument(
        "--output-dir",
        default="data/runtime",
        help="Directory to write baseline snapshot JSON.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def run_cmd(cmd: list[str]) -> tuple[int, str, str]:
    proc = subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def run_gate_command(name: str, cmd: list[str]) -> dict[str, Any]:
    code, stdout, stderr = run_cmd(cmd)
    return {
        "name": name,
        "command": " ".join(cmd),
        "exitCode": code,
        "passed": code == 0,
        "stdoutTail": stdout[-500:],
        "stderrTail": stderr[-500:],
    }


def main() -> int:
    args = parse_args()
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = output_dir / f"baseline_snapshot_{stamp}.json"

    _, branch, _ = run_cmd(["git", "branch", "--show-current"])
    _, head, _ = run_cmd(["git", "rev-parse", "HEAD"])

    key_paths = [
        "scripts/verify_freeze_manifest.py",
        "scripts/verify_environment_lock.py",
        "scripts/gates_preflight.py",
        "scripts/run_validation_pipeline.ts",
        "scripts/build_decision_packet.py",
        "scripts/validate_decision_packet.py",
        "docs/research/freeze_manifest.json",
        "docs/research/templates/freeze_manifest.schema.v1.json",
        "docs/research/templates/environment_lock.v1.json",
    ]

    path_status = {
        path: Path(path).exists()
        for path in key_paths
    }

    gate_checks = [
        run_gate_command(
            "env:verify",
            [
                "python3",
                "scripts/verify_environment_lock.py",
                "--lock",
                "docs/research/templates/environment_lock.v1.json",
                "--output",
                "data/runtime/environment_verify_report.json",
            ],
        ),
        run_gate_command(
            "freeze:verify",
            [
                "python3",
                "scripts/verify_freeze_manifest.py",
                "--manifest",
                "docs/research/freeze_manifest.json",
                "--schema",
                "docs/research/templates/freeze_manifest.schema.v1.json",
                "--output",
                "data/runtime/freeze_verify_report.json",
            ],
        ),
    ]

    payload = {
        "schemaVersion": "baseline_snapshot.v1",
        "generatedAt": utc_now_iso(),
        "branch": branch,
        "head": head,
        "keyPathExists": path_status,
        "gateChecks": gate_checks,
    }
    output_path.write_text(
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )
    print(str(output_path))
    return 0


if __name__ == "__main__":
    sys.exit(main())
