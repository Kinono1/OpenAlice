#!/usr/bin/env python3
"""Collect a minimal R1 rollout health snapshot from the local OpenAlice runtime."""

from __future__ import annotations

import argparse
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


DEFAULT_BASE_URL = "http://127.0.0.1:3002"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/rollout_r1_snapshot.v1.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Collect rollout R1 runtime health snapshot.")
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL, help="OpenAlice base URL.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output JSON file.")
    parser.add_argument("--event-limit", type=int, default=30, help="Recent event limit.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    value = Path(raw).expanduser()
    return value if value.is_absolute() else (root / value).resolve()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def fetch_json(url: str) -> Dict[str, Any]:
    proc = subprocess.run(
        ["curl", "-sS", url],
        text=True,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"curl failed for {url}: {proc.stderr.strip()}")
    return json.loads(proc.stdout)


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    output_path = resolve_path(root, args.output)
    base = args.base_url.rstrip("/")

    registry = fetch_json(f"{base}/api/dev/registry")
    heartbeat = fetch_json(f"{base}/api/heartbeat/status")
    account = fetch_json(f"{base}/api/crypto/account")
    events = fetch_json(f"{base}/api/events/recent?limit={args.event_limit}")

    payload = {
        "schemaVersion": "rollout_r1_snapshot.v1",
        "generatedAt": utc_iso(),
        "baseUrl": base,
        "registry": registry,
        "heartbeat": heartbeat,
        "account": account,
        "events": events,
    }
    write_json(output_path, payload)
    print(json.dumps({"output": str(output_path), "connectors": len(registry.get("connectors", []))}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
