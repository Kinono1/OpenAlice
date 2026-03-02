#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


EXIT_OK = 0
EXIT_POLICY_FAIL = 2
EXIT_TOOL_ERROR = 3


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run governance preflight gates in sequence: "
            "env:verify -> freeze:verify -> sync:post-pull(optional)."
        )
    )
    parser.add_argument(
        "--output",
        default="data/runtime/gates_preflight_report.json",
        help="Path to write preflight report JSON.",
    )
    parser.add_argument(
        "--skip-sync-post-pull",
        action="store_true",
        help="Do not run sync:post-pull even if the npm script exists.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


def load_scripts(package_json_path: Path) -> dict[str, str]:
    if not package_json_path.exists():
        return {}
    payload = json.loads(package_json_path.read_text(encoding="utf-8"))
    scripts = payload.get("scripts")
    return scripts if isinstance(scripts, dict) else {}


def run_step(name: str, cmd: list[str]) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as exc:
        return {
            "name": name,
            "command": " ".join(cmd),
            "exitCode": EXIT_TOOL_ERROR,
            "status": "tool_error",
            "stdout": "",
            "stderr": str(exc),
        }

    code = proc.returncode
    if code == 0:
        status = "pass"
    elif code == EXIT_TOOL_ERROR:
        status = "tool_error"
    else:
        status = "policy_fail"

    return {
        "name": name,
        "command": " ".join(cmd),
        "exitCode": code,
        "status": status,
        "stdout": proc.stdout[-2000:],
        "stderr": proc.stderr[-2000:],
    }


def main() -> int:
    args = parse_args()
    output_path = Path(args.output)
    package_json_path = Path("package.json")

    try:
        scripts = load_scripts(package_json_path)
        steps: list[dict[str, Any]] = []

        steps.append(run_step("env:verify", ["pnpm", "run", "env:verify"]))
        steps.append(run_step("freeze:verify", ["pnpm", "run", "freeze:verify"]))

        has_sync_script = "sync:post-pull" in scripts
        if not args.skip_sync_post_pull and has_sync_script:
            steps.append(
                run_step("sync:post-pull", ["pnpm", "run", "sync:post-pull"])
            )

        has_tool_error = any(step["exitCode"] == EXIT_TOOL_ERROR for step in steps)
        has_policy_fail = any(step["exitCode"] not in (0, EXIT_TOOL_ERROR) for step in steps)
        passed = not has_tool_error and not has_policy_fail
        final_exit = (
            EXIT_TOOL_ERROR
            if has_tool_error
            else (EXIT_POLICY_FAIL if has_policy_fail else EXIT_OK)
        )

        report = {
            "passed": passed,
            "generatedAt": utc_now_iso(),
            "steps": steps,
            "syncPostPullPresent": has_sync_script,
            "skipSyncPostPull": args.skip_sync_post_pull,
            "summary": {
                "total": len(steps),
                "pass": len([s for s in steps if s["exitCode"] == 0]),
                "policyFail": len(
                    [
                        s
                        for s in steps
                        if s["exitCode"] not in (0, EXIT_TOOL_ERROR)
                    ]
                ),
                "toolError": len([s for s in steps if s["exitCode"] == EXIT_TOOL_ERROR]),
            },
            "finalExitCode": final_exit,
        }
        write_json(output_path, report)
        return final_exit
    except Exception as exc:  # noqa: BLE001
        write_json(
            output_path,
            {
                "passed": False,
                "generatedAt": utc_now_iso(),
                "steps": [],
                "failures": [f"tool_error: {exc}"],
                "finalExitCode": EXIT_TOOL_ERROR,
            },
        )
        return EXIT_TOOL_ERROR


if __name__ == "__main__":
    sys.exit(main())
