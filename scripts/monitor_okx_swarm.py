#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


DONE_RE = re.compile(r": done written=\d+ fetched=\d+ shards=\d+")
FAILED_RE = re.compile(r"\]\s+([A-Za-z0-9._-]+)\s+[A-Za-z0-9]+:\s+failed\b")
RETRY_RE = re.compile(r"\[retry\]")
RATE_RE = re.compile(r"(429|rate\W*limit|too many requests)", re.IGNORECASE)
SHARD_SYMBOL_CACHE: dict[str, list[str]] = {}


@dataclass
class AgentLogState:
    offset: int = 0
    done_count: int = 0
    failed_count: int = 0
    retry_count: int = 0
    rate_limit_count: int = 0
    failed_symbols: set[str] | None = None

    def __post_init__(self) -> None:
        if self.failed_symbols is None:
            self.failed_symbols = set()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor OKX swarm agents and emit progress reports.")
    parser.add_argument("--pids-file", required=True, help="Path to swarm_pids_*.json.")
    parser.add_argument("--watch", default="false", choices=("true", "false"), help="Watch until all agents exit.")
    parser.add_argument("--interval-seconds", type=int, default=30, help="Polling interval in seconds.")
    parser.add_argument("--stall-seconds", type=int, default=300, help="No-log-output threshold for stalled alert.")
    parser.add_argument(
        "--output",
        default="",
        help="Progress JSON output path (default: <pids_file_dir>/candles_swarm_progress.json).",
    )
    parser.add_argument(
        "--retry-sleep-ms",
        type=int,
        default=350,
        help="Suggested sleepMs in generated retry command.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


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


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def read_symbols_from_shard(path: Path) -> list[str]:
    key = str(path.resolve())
    cached = SHARD_SYMBOL_CACHE.get(key)
    if cached is not None:
        return cached
    if not path.exists():
        SHARD_SYMBOL_CACHE[key] = []
        return []
    symbols = [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    SHARD_SYMBOL_CACHE[key] = symbols
    return symbols


def latest_symbol_write_epoch(dataset_root: Path, symbol: str) -> float:
    candles_root = dataset_root / "candles"
    if not candles_root.exists():
        return 0.0
    latest = 0.0
    for symbol_dir in candles_root.glob(f"*/*/{symbol}"):
        if not symbol_dir.is_dir():
            continue
        try:
            for child in symbol_dir.iterdir():
                if not child.is_file():
                    continue
                mtime = child.stat().st_mtime
                if mtime > latest:
                    latest = mtime
        except OSError:
            continue
    return latest


def latest_shard_write_epoch(dataset_root: Path, shard_file: Path) -> float:
    latest = 0.0
    for symbol in read_symbols_from_shard(shard_file):
        symbol_latest = latest_symbol_write_epoch(dataset_root, symbol)
        if symbol_latest > latest:
            latest = symbol_latest
    return latest


def read_log_incremental(path: Path, state: AgentLogState) -> None:
    if not path.exists():
        return
    size = path.stat().st_size
    if size < state.offset:
        state.offset = 0
    if size == state.offset:
        return
    with path.open("rb") as handle:
        handle.seek(state.offset)
        chunk = handle.read()
    state.offset = size
    if not chunk:
        return
    text = chunk.decode("utf-8", errors="ignore")
    state.done_count += len(DONE_RE.findall(text))
    state.failed_count += len(FAILED_RE.findall(text))
    state.retry_count += len(RETRY_RE.findall(text))
    state.rate_limit_count += len(RATE_RE.findall(text))
    for symbol in FAILED_RE.findall(text):
        state.failed_symbols.add(symbol)


def collect_failed_symbols_from_summary(summary_path: Path) -> set[str]:
    out: set[str] = set()
    if not summary_path.exists():
        return out
    try:
        payload = load_json(summary_path)
    except Exception:
        return out
    for row in payload.get("results", []):
        if row.get("error"):
            inst_id = str(row.get("instId", "")).strip()
            if inst_id:
                out.add(inst_id)
    return out


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def finalize_retry_files(
    pids_payload: dict[str, Any],
    progress_output: Path,
    per_agent: list[dict[str, Any]],
    retry_sleep_ms: int,
) -> None:
    swarm_dir = progress_output.parent
    retry_symbols_path = swarm_dir / "retry_symbols.txt"
    retry_cmd_path = swarm_dir / "retry_command.txt"

    failed_symbols: set[str] = set()
    for item in per_agent:
        failed_symbols.update(item.get("failedSymbolsFromLog", []))
        summary_path = Path(item["summaryPath"])
        failed_symbols.update(collect_failed_symbols_from_summary(summary_path))

    retry_symbols = sorted(failed_symbols)
    retry_symbols_path.write_text(
        "\n".join(retry_symbols) + ("\n" if retry_symbols else ""),
        encoding="utf-8",
    )

    dataset_root = pids_payload.get("datasetRoot", "data/market/okx_historical")
    cmd = (
        f"SLEEP_MS={retry_sleep_ms} AGENTS={pids_payload.get('agentsRequested', 6)} "
        f"SYMBOLS_FILE={retry_symbols_path} DATASET_ROOT={dataset_root} "
        "bash scripts/run_okx_candles_swarm.sh"
    )
    retry_cmd_path.write_text(cmd + "\n", encoding="utf-8")


def monitor_once(
    pids_payload: dict[str, Any],
    log_states: dict[str, AgentLogState],
    stall_seconds: int,
) -> dict[str, Any]:
    now = time.time()
    dataset_root = Path(str(pids_payload.get("datasetRoot", "data/market/okx_historical"))).resolve()
    per_agent: list[dict[str, Any]] = []
    running_count = 0
    stalled_agents: list[str] = []
    total_done = 0
    total_failed = 0
    total_retry = 0
    total_rate = 0

    for entry in pids_payload.get("entries", []):
        agent_id = str(entry.get("agentId"))
        pid = int(entry.get("pid"))
        shard_file = Path(str(entry.get("shardFile")))
        log_file = Path(str(entry.get("logFile")))
        summary_path = Path(str(entry.get("summaryPath")))
        state_path = Path(str(entry.get("statePath")))
        report_dir = Path(str(entry.get("reportDir")))
        symbols_count = int(entry.get("symbolsCount", 0))

        log_state = log_states.setdefault(log_file.as_posix(), AgentLogState())
        read_log_incremental(log_file, log_state)

        alive = process_alive(pid)
        if alive:
            running_count += 1

        if log_file.exists():
            stat = log_file.stat()
            mtime_epoch = stat.st_mtime
            size_bytes = stat.st_size
        else:
            mtime_epoch = 0.0
            size_bytes = 0

        data_mtime_epoch = latest_shard_write_epoch(dataset_root, shard_file) if alive else 0.0
        has_recent_data_write = data_mtime_epoch > 0 and (now - data_mtime_epoch < stall_seconds)
        if log_file.exists():
            stalled = alive and (now - mtime_epoch >= stall_seconds) and not has_recent_data_write
        else:
            stalled = alive and not has_recent_data_write

        if stalled:
            stalled_agents.append(agent_id)

        total_done += log_state.done_count
        total_failed += log_state.failed_count
        total_retry += log_state.retry_count
        total_rate += log_state.rate_limit_count

        per_agent.append(
            {
                "agentId": agent_id,
                "pid": pid,
                "alive": alive,
                "stalled": stalled,
                "hasRecentDataWrite": has_recent_data_write,
                "symbolsCount": symbols_count,
                "doneCount": log_state.done_count,
                "failedCount": log_state.failed_count,
                "retryCount": log_state.retry_count,
                "rateLimitCount": log_state.rate_limit_count,
                "logFile": str(log_file),
                "logSizeBytes": size_bytes,
                "logMtime": datetime.fromtimestamp(mtime_epoch, timezone.utc).isoformat()
                if mtime_epoch > 0
                else None,
                "recentDataMtime": datetime.fromtimestamp(data_mtime_epoch, timezone.utc).isoformat()
                if data_mtime_epoch > 0
                else None,
                "shardFile": str(shard_file),
                "statePath": str(state_path),
                "summaryPath": str(summary_path),
                "reportDir": str(report_dir),
                "failedSymbolsFromLog": sorted(log_state.failed_symbols),
            }
        )

    exited_count = len(per_agent) - running_count
    alerts: list[str] = []
    if stalled_agents:
        alerts.append(f"stalled agents (>{stall_seconds}s no log growth): {', '.join(stalled_agents)}")
    if total_rate > 0:
        alerts.append(f"rate-limit signals detected: count={total_rate}")

    return {
        "schemaVersion": "okx_swarm_progress.v1",
        "generatedAt": utc_now_iso(),
        "runId": pids_payload.get("runId"),
        "pidsFile": pids_payload.get("pidsFile"),
        "datasetRoot": pids_payload.get("datasetRoot"),
        "totals": {
            "agents": len(per_agent),
            "runningAgents": running_count,
            "exitedAgents": exited_count,
            "stalledAgents": len(stalled_agents),
            "doneCount": total_done,
            "failedCount": total_failed,
            "retryCount": total_retry,
            "rateLimitCount": total_rate,
        },
        "alerts": alerts,
        "agents": per_agent,
    }


def main() -> None:
    args = parse_args()
    pids_file = Path(args.pids_file).resolve()
    payload = load_json(pids_file)
    payload["pidsFile"] = str(pids_file)

    output_path = (
        Path(args.output).resolve()
        if args.output
        else pids_file.parent / "candles_swarm_progress.json"
    )

    watch = args.watch == "true"
    interval_seconds = max(args.interval_seconds, 5)
    stall_seconds = max(args.stall_seconds, 30)
    log_states: dict[str, AgentLogState] = {}

    while True:
        progress = monitor_once(payload, log_states, stall_seconds)
        write_json(output_path, progress)
        totals = progress["totals"]
        print(
            f"[{progress['generatedAt']}] running={totals['runningAgents']} "
            f"exited={totals['exitedAgents']} done={totals['doneCount']} "
            f"failed={totals['failedCount']} retry={totals['retryCount']} "
            f"rate={totals['rateLimitCount']} stalled={totals['stalledAgents']}"
        )
        for alert in progress["alerts"]:
            print(f"ALERT: {alert}")

        all_exited = totals["runningAgents"] == 0
        if (not watch) or all_exited:
            finalize_retry_files(
                pids_payload=payload,
                progress_output=output_path,
                per_agent=progress["agents"],
                retry_sleep_ms=max(args.retry_sleep_ms, 1),
            )
            print(f"progress report saved: {output_path}")
            print(f"retry symbols saved: {output_path.parent / 'retry_symbols.txt'}")
            print(f"retry command saved: {output_path.parent / 'retry_command.txt'}")
            break

        time.sleep(interval_seconds)


if __name__ == "__main__":
    main()
