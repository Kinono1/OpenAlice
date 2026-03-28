#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

FAILED_RE = re.compile(r"\]\s+([A-Za-z0-9._-]+)\s+[A-Za-z0-9]+:\s+failed\b")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Restart failed OKX candle agents while preserving per-agent state."
    )
    parser.add_argument(
        "--pids-file",
        required=True,
        help="Path to an existing swarm_pids*.json manifest.",
    )
    parser.add_argument(
        "--progress-file",
        default="",
        help="Optional candles_swarm_progress.json used to recover failed symbols from monitor output.",
    )
    parser.add_argument(
        "--kill-pids-file",
        default="",
        help="Optional manifest that provides currently running PIDs to terminate before relaunch.",
    )
    parser.add_argument(
        "--agent-ids",
        default="",
        help="Optional comma-separated subset such as agent01,agent05.",
    )
    parser.add_argument(
        "--timeframes",
        default="1h,15m,5m",
        help="Comma-separated candle timeframes to retry.",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=1,
        help="Workers passed to okx_download_candles_historical.ts.",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=1200,
        help="Throttle between history requests for restarted agents.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=12,
        help="Max retry attempts per HTTP request.",
    )
    parser.add_argument(
        "--append",
        default="true",
        choices=("true", "false"),
        help="Whether to resume from existing state.",
    )
    parser.add_argument(
        "--load-env",
        default="true",
        choices=("true", "false"),
        help="Load .env from repo root before launch.",
    )
    parser.add_argument(
        "--update-latest",
        default="true",
        choices=("true", "false"),
        help="Update swarm_pids.latest.json to point at the restarted run.",
    )
    parser.add_argument(
        "--dry-run",
        default="false",
        choices=("true", "false"),
        help="Print launch plan without starting processes.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def resolve_from_root(root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (root / path).resolve()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_csv(text: str) -> list[str]:
    return [part.strip() for part in text.split(",") if part.strip()]


def load_env_file(root: Path) -> None:
    env_path = root / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def choose_node_bin() -> str:
    candidates = [
        os.environ.get("NODE_BIN", ""),
        shutil_which("node"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate

    nvm_root = Path(os.path.expanduser("~/.nvm/versions/node"))
    if nvm_root.exists():
        matches = sorted(nvm_root.glob("*/bin/node"))
        if matches:
            return str(matches[-1])
    raise SystemExit("restart_okx_failed_agents: node not found")


def shutil_which(binary: str) -> str:
    from shutil import which

    return which(binary) or ""


def find_tsx_assets(root: Path) -> tuple[Path, Path]:
    preflights = sorted(root.glob("node_modules/.pnpm/tsx@*/node_modules/tsx/dist/preflight.cjs"))
    loaders = sorted(root.glob("node_modules/.pnpm/tsx@*/node_modules/tsx/dist/loader.mjs"))
    if not preflights or not loaders:
        raise SystemExit("restart_okx_failed_agents: tsx loader assets not found")
    return preflights[-1].resolve(), loaders[-1].resolve()


def process_alive(pid: int) -> bool:
    try:
        out = subprocess.check_output(
            ["ps", "-p", str(pid), "-o", "state="],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip()
    except subprocess.CalledProcessError:
        return False
    if not out:
        return False
    return not out.startswith("Z")


def terminate_process_group(pid: int, grace_seconds: float = 8.0) -> str:
    if not process_alive(pid):
        return "not_running"

    try:
        pgid = os.getpgid(pid)
    except ProcessLookupError:
        return "not_running"

    try:
        os.killpg(pgid, signal.SIGTERM)
    except ProcessLookupError:
        return "not_running"

    deadline = time.time() + max(grace_seconds, 0.5)
    while time.time() < deadline:
        if not process_alive(pid):
            return "terminated"
        time.sleep(0.25)

    try:
        os.killpg(pgid, signal.SIGKILL)
    except ProcessLookupError:
        return "terminated"

    return "killed"


def collect_failed_symbols_from_summary(path: Path) -> set[str]:
    out: set[str] = set()
    if not path.exists():
        return out
    try:
        payload = load_json(path)
    except Exception:
        return out
    for row in payload.get("results", []):
        if row.get("error"):
            inst_id = str(row.get("instId", "")).strip()
            if inst_id:
                out.add(inst_id)
    return out


def collect_failed_symbols_from_progress(path: Path) -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    if not path.exists():
        return out
    try:
        payload = load_json(path)
    except Exception:
        return out
    for row in payload.get("agents", []):
        agent_id = str(row.get("agentId", "")).strip()
        if not agent_id:
            continue
        failed = {
            str(symbol).strip()
            for symbol in row.get("failedSymbolsFromLog", [])
            if str(symbol).strip()
        }
        out[agent_id] = failed
    return out


def collect_failed_symbols_from_log(path: Path) -> set[str]:
    if not path.exists():
        return set()
    text = path.read_text(encoding="utf-8", errors="ignore")
    return {match.strip() for match in FAILED_RE.findall(text) if match.strip()}


def format_command(cmd: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in cmd)


def relative_or_absolute(root: Path, path: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)


def main() -> None:
    args = parse_args()
    root = repo_root()
    os.chdir(root)

    if args.load_env == "true":
        load_env_file(root)

    proxy_url = (
        os.environ.get("HTTPS_PROXY")
        or os.environ.get("https_proxy")
        or os.environ.get("HTTP_PROXY")
        or os.environ.get("http_proxy")
        or os.environ.get("ALL_PROXY")
        or os.environ.get("all_proxy")
        or ""
    )
    if proxy_url and not os.environ.get("NODE_USE_ENV_PROXY"):
        os.environ["NODE_USE_ENV_PROXY"] = "1"

    pids_path = resolve_from_root(root, args.pids_file)
    pids_payload = load_json(pids_path)
    kill_pids_payload = (
        load_json(resolve_from_root(root, args.kill_pids_file))
        if args.kill_pids_file
        else pids_payload
    )
    kill_entries = {
        str(entry.get("agentId", "")).strip(): entry
        for entry in kill_pids_payload.get("entries", [])
        if str(entry.get("agentId", "")).strip()
    }
    dataset_root_raw = str(pids_payload.get("datasetRoot", "data/market/okx_historical"))
    dataset_root_abs = resolve_from_root(root, dataset_root_raw)
    swarm_dir = dataset_root_abs / "reports" / "swarm"
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    restart_dir = swarm_dir / "restarts" / run_id
    restart_logs_dir = restart_dir / "logs"
    restart_shards_dir = restart_dir / "shards"

    progress_path = (
        resolve_from_root(root, args.progress_file)
        if args.progress_file
        else swarm_dir / "candles_swarm_progress.json"
    )
    failed_from_progress = collect_failed_symbols_from_progress(progress_path)
    target_agents = set(parse_csv(args.agent_ids)) if args.agent_ids else None
    node_bin = choose_node_bin()
    preflight_path, loader_path = find_tsx_assets(root)
    append_mode = args.append == "true"
    dry_run = args.dry_run == "true"
    update_latest = args.update_latest == "true"

    restart_dir.mkdir(parents=True, exist_ok=True)
    restart_logs_dir.mkdir(parents=True, exist_ok=True)
    restart_shards_dir.mkdir(parents=True, exist_ok=True)

    launched_entries: list[dict[str, Any]] = []
    manifest_rows: list[str] = []

    for entry in pids_payload.get("entries", []):
        agent_id = str(entry.get("agentId", "")).strip()
        if not agent_id:
            continue
        if target_agents is not None and agent_id not in target_agents:
            continue

        summary_path = resolve_from_root(root, str(entry.get("summaryPath", "")))
        log_path = resolve_from_root(root, str(entry.get("logFile", "")))
        failed_symbols = set(failed_from_progress.get(agent_id, set()))
        failed_symbols.update(collect_failed_symbols_from_summary(summary_path))
        failed_symbols.update(collect_failed_symbols_from_log(log_path))
        if not failed_symbols:
            continue

        failed_list = sorted(failed_symbols)
        retry_shard = restart_shards_dir / f"{agent_id}.txt"
        retry_shard.write_text("\n".join(failed_list) + "\n", encoding="utf-8")

        kill_entry = kill_entries.get(agent_id, entry)
        old_pid = int(kill_entry.get("pid", 0))
        kill_status = terminate_process_group(old_pid) if old_pid > 0 else "not_running"

        state_path = resolve_from_root(root, str(entry.get("statePath", "")))
        retry_summary_path = restart_dir / f"candles_summary.{agent_id}.retry.v1.json"
        retry_report_dir = restart_dir / agent_id
        retry_report_dir.mkdir(parents=True, exist_ok=True)
        retry_log = restart_logs_dir / f"{agent_id}.log"

        cmd = [
            node_bin,
            "--require",
            str(preflight_path),
            "--import",
            loader_path.as_uri(),
            "scripts/okx_download_candles_historical.ts",
            "--datasetRoot",
            dataset_root_raw,
            "--symbols",
            ",".join(failed_list),
            "--timeframes",
            args.timeframes,
            "--workers",
            str(max(args.workers, 1)),
            "--append",
            "true" if append_mode else "false",
            "--maxRetries",
            str(max(args.max_retries, 1)),
            "--sleepMs",
            str(max(args.sleep_ms, 0)),
            "--statePath",
            relative_or_absolute(root, state_path),
            "--summaryPath",
            relative_or_absolute(root, retry_summary_path),
            "--reportDir",
            relative_or_absolute(root, retry_report_dir),
        ]

        if dry_run:
            print(
                f"DRY_RUN {agent_id}: symbols={len(failed_list)} "
                f"kill={kill_status} cmd={format_command(cmd)}"
            )
            continue

        log_handle = retry_log.open("wb")
        process = subprocess.Popen(
            cmd,
            cwd=root,
            env=os.environ.copy(),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log_handle.close()

        launched_entry = {
            "agentId": agent_id,
            "pid": process.pid,
            "shardFile": relative_or_absolute(root, retry_shard),
            "logFile": str(retry_log),
            "statePath": relative_or_absolute(root, state_path),
            "summaryPath": relative_or_absolute(root, retry_summary_path),
            "reportDir": relative_or_absolute(root, retry_report_dir),
            "symbolsCount": len(failed_list),
            "sourceRunId": pids_payload.get("runId"),
            "restartedFromPid": old_pid,
            "restartKillStatus": kill_status,
            "retrySymbols": failed_list,
        }
        launched_entries.append(launched_entry)
        manifest_rows.append(
            "\t".join(
                [
                    agent_id,
                    str(process.pid),
                    relative_or_absolute(root, retry_shard),
                    str(retry_log),
                    relative_or_absolute(root, state_path),
                    relative_or_absolute(root, retry_summary_path),
                    relative_or_absolute(root, retry_report_dir),
                    str(len(failed_list)),
                ]
            )
        )
        print(
            f"START {agent_id}: pid={process.pid} symbols={len(failed_list)} "
            f"kill={kill_status} log={retry_log}"
        )

    if dry_run:
        return

    if not launched_entries:
        raise SystemExit("No failed agents matched the restart criteria.")

    manifest_path = swarm_dir / f"swarm_pids_restart_{run_id}.json"
    latest_path = swarm_dir / "swarm_pids.latest.json"
    manifest_tsv = swarm_dir / f"swarm_manifest_restart_{run_id}.tsv"
    manifest_tsv.write_text("\n".join(manifest_rows) + ("\n" if manifest_rows else ""), encoding="utf-8")

    payload = {
        "schemaVersion": "okx_swarm_pids.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "datasetRoot": dataset_root_raw,
        "agentsRequested": len(launched_entries),
        "rateLimitStrategy": "restart_failed_agents",
        "sourceRunId": pids_payload.get("runId"),
        "entries": launched_entries,
    }
    write_json(manifest_path, payload)
    if update_latest:
        write_json(latest_path, payload)

    print(f"wrote restart manifest: {manifest_path}")
    if update_latest:
        print(f"updated latest manifest: {latest_path}")
    print(
        "monitor command: "
        f"python3 scripts/monitor_okx_swarm.py --pids-file {relative_or_absolute(root, manifest_path)} --watch true"
    )


if __name__ == "__main__":
    main()
