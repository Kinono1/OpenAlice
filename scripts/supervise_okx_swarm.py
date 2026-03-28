#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import os
import signal
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from shutil import which
from typing import Any


TARGET_BARS = ("1H", "15m", "5m")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Continuously supervise active OKX candle manifests, detect dead or stalled agents, "
            "and rebalance unfinished symbols into smaller retry batches."
        )
    )
    parser.add_argument(
        "--manifests",
        required=True,
        help="Comma-separated manifest paths to supervise.",
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_historical",
        help="Dataset root path.",
    )
    parser.add_argument(
        "--watch",
        default="true",
        choices=("true", "false"),
        help="Keep supervising until no active manifests remain.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=60,
        help="Polling interval.",
    )
    parser.add_argument(
        "--stall-seconds",
        type=int,
        default=600,
        help="No recent data write threshold before an alive agent is considered stalled.",
    )
    parser.add_argument(
        "--sleep-ms",
        type=int,
        default=1800,
        help="sleepMs for rebalanced retry workers.",
    )
    parser.add_argument(
        "--max-retries",
        type=int,
        default=12,
        help="maxRetries for rebalanced retry workers.",
    )
    parser.add_argument(
        "--max-rebalance-agents",
        type=int,
        default=3,
        help="Upper bound on agents launched for one rebalance wave.",
    )
    parser.add_argument(
        "--symbols-per-agent",
        type=int,
        default=6,
        help="Target max symbols per rebalanced agent.",
    )
    parser.add_argument(
        "--target-active-agents",
        type=int,
        default=6,
        help="Maintain at least this many healthy active agents by top-upping uncovered symbols.",
    )
    parser.add_argument(
        "--output",
        default="",
        help="Optional supervisor status JSON path.",
    )
    parser.add_argument(
        "--resume",
        default="true",
        choices=("true", "false"),
        help="Resume retired-agent state from existing supervisor status file if present.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_from_root(root: Path, value: str) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path
    return (root / path).resolve()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


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
    candidates = [os.environ.get("NODE_BIN", ""), which("node") or ""]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    nvm_root = Path(os.path.expanduser("~/.nvm/versions/node"))
    if nvm_root.exists():
        matches = sorted(nvm_root.glob("*/bin/node"))
        if matches:
            return str(matches[-1])
    raise SystemExit("supervise_okx_swarm: node not found")


def find_tsx_assets(root: Path) -> tuple[Path, Path]:
    preflights = sorted(root.glob("node_modules/.pnpm/tsx@*/node_modules/tsx/dist/preflight.cjs"))
    loaders = sorted(root.glob("node_modules/.pnpm/tsx@*/node_modules/tsx/dist/loader.mjs"))
    if not preflights or not loaders:
        raise SystemExit("supervise_okx_swarm: tsx loader assets not found")
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
    if pid <= 0 or not process_alive(pid):
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


def read_symbols_file(path: Path) -> list[str]:
    if not path.exists():
        return []
    out: list[str] = []
    seen: set[str] = set()
    for raw in path.read_text(encoding="utf-8", errors="ignore").splitlines():
        symbol = raw.strip()
        if not symbol or symbol.startswith("#") or symbol in seen:
            continue
        seen.add(symbol)
        out.append(symbol)
    return out


def latest_symbol_write_epoch(dataset_root: Path, symbol: str) -> float:
    latest = 0.0
    candles_root = dataset_root / "candles"
    if not candles_root.exists():
        return latest
    for symbol_dir in candles_root.glob(f"*/*/{symbol}"):
        if not symbol_dir.is_dir():
            continue
        try:
            for child in symbol_dir.iterdir():
                if child.is_file():
                    latest = max(latest, child.stat().st_mtime)
        except OSError:
            continue
    return latest


def latest_symbols_write_epoch(dataset_root: Path, symbols: list[str]) -> float:
    latest = 0.0
    for symbol in symbols:
        latest = max(latest, latest_symbol_write_epoch(dataset_root, symbol))
    return latest


def build_completion_truth(root: Path, dataset_root_arg: str) -> Path:
    subprocess.run(
        [
            "python3",
            "scripts/build_okx_completion_truth.py",
            "--dataset-root",
            dataset_root_arg,
            "--output-dir",
            f"{dataset_root_arg}/reports/swarm",
        ],
        cwd=root,
        check=True,
    )
    return resolve_from_root(root, f"{dataset_root_arg}/reports/swarm/completion_truth.v1.json")


def load_missing_symbols(truth_path: Path) -> set[str]:
    payload = load_json(truth_path)
    out: set[str] = set()
    for row in payload.get("symbols", []):
        inst_id = str(row.get("instId", "")).strip()
        missing = row.get("missingBars", [])
        if inst_id and isinstance(missing, list) and len(missing) > 0:
            out.add(inst_id)
    return out


def load_catalog_weights(dataset_root: Path, symbols: list[str]) -> list[tuple[str, float]]:
    catalog_path = dataset_root / "catalog" / "usdt_all.v1.json"
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    payload = load_json(catalog_path)
    catalog: dict[str, int | None] = {}
    for row in payload.get("items", []):
        inst_id = str(row.get("instId", "")).strip()
        if not inst_id:
            continue
        raw = str(row.get("listTime", "")).strip()
        list_time_ms = int(raw) if raw.isdigit() else None
        catalog[inst_id] = list_time_ms
    weighted: list[tuple[str, float]] = []
    month_ms = 30 * 24 * 3600 * 1000
    for symbol in symbols:
        list_time_ms = catalog.get(symbol)
        if list_time_ms is None or list_time_ms >= now_ms:
            months = 1
        else:
            months = max(1, math.ceil((now_ms - list_time_ms) / month_ms))
        weighted.append((symbol, float(months * len(TARGET_BARS))))
    weighted.sort(key=lambda item: (-item[1], item[0]))
    return weighted


def partition_symbols(
    dataset_root: Path,
    symbols: list[str],
    max_rebalance_agents: int,
    symbols_per_agent: int,
) -> list[list[str]]:
    if not symbols:
        return []
    desired = max(1, math.ceil(len(symbols) / max(symbols_per_agent, 1)))
    agents = max(1, min(max_rebalance_agents, desired, len(symbols)))
    buckets = [{"symbols": [], "weight": 0.0} for _ in range(agents)]
    for symbol, weight in load_catalog_weights(dataset_root, symbols):
        target = min(buckets, key=lambda row: (row["weight"], len(row["symbols"])))
        target["symbols"].append(symbol)
        target["weight"] += weight
    return [sorted(bucket["symbols"]) for bucket in buckets if bucket["symbols"]]


def launch_batches(
    root: Path,
    dataset_root_arg: str,
    batches: list[list[str]],
    node_bin: str,
    preflight_path: Path,
    loader_path: Path,
    sleep_ms: int,
    max_retries: int,
    source_manifest: Path,
) -> Path | None:
    if not batches:
        return None
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dataset_root_abs = resolve_from_root(root, dataset_root_arg)
    swarm_dir = dataset_root_abs / "reports" / "swarm"
    rebalance_dir = swarm_dir / "rebalances" / run_id
    logs_dir = rebalance_dir / "logs"
    shards_dir = rebalance_dir / "shards"
    reports_dir = rebalance_dir / "reports"
    state_dir = rebalance_dir / "state"
    for path in (logs_dir, shards_dir, reports_dir, state_dir):
        path.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, Any]] = []
    manifest_rows: list[str] = []
    for idx, symbols in enumerate(batches, start=1):
        agent_id = f"rebalance{idx:02d}"
        shard_file = shards_dir / f"{agent_id}.txt"
        shard_file.write_text("\n".join(symbols) + "\n", encoding="utf-8")
        state_path = state_dir / f"candles.{agent_id}.state.v1.json"
        summary_path = reports_dir / f"candles_summary.{agent_id}.v1.json"
        report_dir = reports_dir / agent_id
        report_dir.mkdir(parents=True, exist_ok=True)
        log_path = logs_dir / f"{agent_id}.log"
        cmd = [
            node_bin,
            "--require",
            str(preflight_path),
            "--import",
            loader_path.as_uri(),
            "scripts/okx_download_candles_historical.ts",
            "--datasetRoot",
            dataset_root_arg,
            "--symbols",
            ",".join(symbols),
            "--timeframes",
            "1h,15m,5m",
            "--workers",
            "1",
            "--append",
            "true",
            "--maxRetries",
            str(max(max_retries, 1)),
            "--sleepMs",
            str(max(sleep_ms, 0)),
            "--statePath",
            str(state_path.relative_to(root)),
            "--summaryPath",
            str(summary_path.relative_to(root)),
            "--reportDir",
            str(report_dir.relative_to(root)),
        ]
        log_handle = log_path.open("wb")
        process = subprocess.Popen(
            cmd,
            cwd=root,
            env=os.environ.copy(),
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        log_handle.close()
        entry = {
            "agentId": agent_id,
            "pid": process.pid,
            "shardFile": str(shard_file.relative_to(root)),
            "logFile": str(log_path),
            "statePath": str(state_path.relative_to(root)),
            "summaryPath": str(summary_path.relative_to(root)),
            "reportDir": str(report_dir.relative_to(root)),
            "symbolsCount": len(symbols),
            "retrySymbols": symbols,
            "sourceManifest": str(source_manifest),
        }
        entries.append(entry)
        manifest_rows.append(
            "\t".join(
                [
                    agent_id,
                    str(process.pid),
                    str(shard_file.relative_to(root)),
                    str(log_path),
                    str(state_path.relative_to(root)),
                    str(summary_path.relative_to(root)),
                    str(report_dir.relative_to(root)),
                    str(len(symbols)),
                ]
            )
        )

    manifest_path = swarm_dir / f"swarm_pids_rebalance_{run_id}.json"
    manifest_tsv = swarm_dir / f"swarm_manifest_rebalance_{run_id}.tsv"
    manifest_tsv.write_text("\n".join(manifest_rows) + "\n", encoding="utf-8")
    payload = {
        "schemaVersion": "okx_swarm_pids.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "runId": run_id,
        "datasetRoot": dataset_root_arg,
        "agentsRequested": len(entries),
        "rateLimitStrategy": "supervisor_rebalance",
        "sourceManifest": str(source_manifest),
        "entries": entries,
    }
    write_json(manifest_path, payload)
    return manifest_path


def collect_manifest_snapshot(
    root: Path,
    dataset_root_abs: Path,
    manifest_path: Path,
    retired_agents: set[str],
    stall_seconds: int,
) -> dict[str, Any]:
    payload = load_json(manifest_path)
    now = time.time()
    agents: list[dict[str, Any]] = []
    active_count = 0
    for entry in payload.get("entries", []):
        agent_id = str(entry.get("agentId", "")).strip()
        if not agent_id or agent_id in retired_agents:
            continue
        pid = int(entry.get("pid", 0))
        symbols = [str(sym).strip() for sym in entry.get("retrySymbols", []) if str(sym).strip()]
        if not symbols:
            symbols = read_symbols_file(resolve_from_root(root, str(entry.get("shardFile", ""))))
        alive = process_alive(pid)
        if alive:
            active_count += 1
        log_path = resolve_from_root(root, str(entry.get("logFile", "")))
        log_mtime = log_path.stat().st_mtime if log_path.exists() else 0.0
        data_mtime = latest_symbols_write_epoch(dataset_root_abs, symbols) if alive else 0.0
        stalled = alive and data_mtime > 0 and (now - data_mtime >= stall_seconds)
        if alive and data_mtime == 0.0 and log_mtime > 0 and (now - log_mtime >= stall_seconds):
            stalled = True
        agents.append(
            {
                "agentId": agent_id,
                "pid": pid,
                "alive": alive,
                "stalled": stalled,
                "symbols": symbols,
                "logFile": str(log_path),
                "logMtime": datetime.fromtimestamp(log_mtime, timezone.utc).isoformat() if log_mtime else None,
                "recentDataMtime": datetime.fromtimestamp(data_mtime, timezone.utc).isoformat() if data_mtime else None,
            }
        )
    return {
        "manifestPath": str(manifest_path),
        "runId": payload.get("runId"),
        "activeAgents": active_count,
        "agents": agents,
    }


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    args = parse_args()
    root = repo_root()
    os.chdir(root)
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

    dataset_root_arg = args.dataset_root
    dataset_root_abs = resolve_from_root(root, dataset_root_arg)
    output_path = (
        resolve_from_root(root, args.output)
        if args.output
        else resolve_from_root(root, f"{dataset_root_arg}/reports/swarm/supervisor_status.v1.json")
    )
    node_bin = choose_node_bin()
    preflight_path, loader_path = find_tsx_assets(root)
    interval_seconds = max(args.interval_seconds, 5)
    stall_seconds = max(args.stall_seconds, 60)
    watch = args.watch == "true"

    active_manifests: list[Path] = [resolve_from_root(root, value) for value in parse_csv(args.manifests)]
    retired_agents_by_manifest: dict[str, set[str]] = {}
    if args.resume == "true" and output_path.exists():
        try:
            previous = load_json(output_path)
            for item in previous.get("retiredAgentsHistory", []):
                manifest_key = str(resolve_from_root(root, str(item.get("manifestPath", ""))).resolve())
                agent_id = str(item.get("agentId", "")).strip()
                if manifest_key and agent_id:
                    retired_agents_by_manifest.setdefault(manifest_key, set()).add(agent_id)
        except Exception:
            pass

    retired_history: list[dict[str, Any]] = []
    if args.resume == "true" and output_path.exists():
        try:
            previous = load_json(output_path)
            raw_history = previous.get("retiredAgentsHistory", [])
            if isinstance(raw_history, list):
                retired_history = [row for row in raw_history if isinstance(row, dict)]
        except Exception:
            retired_history = []

    while True:
        manifest_snapshots: list[dict[str, Any]] = []
        problem_symbols: set[str] = set()
        healthy_symbols: set[str] = set()
        assigned_symbols: set[str] = set()
        retired_this_loop: list[dict[str, Any]] = []
        next_manifests: list[Path] = []
        healthy_agent_count = 0

        for manifest_path in active_manifests:
            manifest_key = str(manifest_path.resolve())
            retired = retired_agents_by_manifest.setdefault(manifest_key, set())
            if not manifest_path.exists():
                continue
            snapshot = collect_manifest_snapshot(
                root=root,
                dataset_root_abs=dataset_root_abs,
                manifest_path=manifest_path,
                retired_agents=retired,
                stall_seconds=stall_seconds,
            )
            manifest_snapshots.append(snapshot)
            for agent in snapshot["agents"]:
                if agent["alive"] and not agent["stalled"]:
                    healthy_agent_count += 1
                    healthy_symbols.update(agent["symbols"])
                    assigned_symbols.update(agent["symbols"])
                    continue
                if not agent["alive"] or agent["stalled"]:
                    retired.add(agent["agentId"])
                    retirement = {
                        "manifestPath": str(manifest_path),
                        "agentId": agent["agentId"],
                        "pid": agent["pid"],
                        "reason": "stalled" if agent["stalled"] else "dead",
                        "killStatus": terminate_process_group(agent["pid"]),
                        "symbolsCount": len(agent["symbols"]),
                        "retiredAt": utc_now_iso(),
                    }
                    retired_this_loop.append(retirement)
                    retired_history.append(retirement)
                    problem_symbols.update(agent["symbols"])
            still_active = any(
                agent["agentId"] not in retired and agent["alive"] for agent in snapshot["agents"]
            )
            if still_active:
                next_manifests.append(manifest_path)

        rebalance_manifest: Path | None = None
        truth_path = build_completion_truth(root, dataset_root_arg)
        incomplete_symbols = load_missing_symbols(truth_path)

        if problem_symbols:
            incomplete_symbols = load_missing_symbols(truth_path)
            symbols_to_reassign = sorted((problem_symbols - healthy_symbols) & incomplete_symbols)
            if symbols_to_reassign:
                batches = partition_symbols(
                    dataset_root=dataset_root_abs,
                    symbols=symbols_to_reassign,
                    max_rebalance_agents=max(args.max_rebalance_agents, 1),
                    symbols_per_agent=max(args.symbols_per_agent, 1),
                )
                rebalance_manifest = launch_batches(
                    root=root,
                    dataset_root_arg=dataset_root_arg,
                    batches=batches,
                    node_bin=node_bin,
                    preflight_path=preflight_path,
                    loader_path=loader_path,
                    sleep_ms=args.sleep_ms,
                    max_retries=args.max_retries,
                    source_manifest=Path(retired_this_loop[-1]["manifestPath"]) if retired_this_loop else active_manifests[0],
                )
                if rebalance_manifest is not None:
                    next_manifests.append(rebalance_manifest)
                    healthy_agent_count += len(batches)
                    for batch in batches:
                        assigned_symbols.update(batch)

        topup_manifest: Path | None = None
        active_deficit = max(args.target_active_agents - healthy_agent_count, 0)
        if active_deficit > 0:
            unassigned_symbols = sorted(incomplete_symbols - assigned_symbols)
            if unassigned_symbols:
                topup_batches = partition_symbols(
                    dataset_root=dataset_root_abs,
                    symbols=unassigned_symbols,
                    max_rebalance_agents=max(1, min(args.max_rebalance_agents, active_deficit)),
                    symbols_per_agent=max(args.symbols_per_agent, 1),
                )
                if topup_batches:
                    topup_manifest = launch_batches(
                        root=root,
                        dataset_root_arg=dataset_root_arg,
                        batches=topup_batches,
                        node_bin=node_bin,
                        preflight_path=preflight_path,
                        loader_path=loader_path,
                        sleep_ms=args.sleep_ms,
                        max_retries=args.max_retries,
                        source_manifest=Path(active_manifests[0]) if active_manifests else Path(truth_path),
                    )
                    if topup_manifest is not None:
                        next_manifests.append(topup_manifest)
                        healthy_agent_count += len(topup_batches)

        status = {
            "schemaVersion": "okx_swarm_supervisor_status.v1",
            "generatedAt": utc_now_iso(),
            "datasetRoot": str(dataset_root_abs),
            "params": {
                "intervalSeconds": interval_seconds,
                "stallSeconds": stall_seconds,
                "sleepMs": args.sleep_ms,
                "maxRetries": args.max_retries,
                "maxRebalanceAgents": args.max_rebalance_agents,
                "symbolsPerAgent": args.symbols_per_agent,
                "targetActiveAgents": args.target_active_agents,
            },
            "activeManifests": [str(path) for path in next_manifests],
            "manifestSnapshots": manifest_snapshots,
            "retiredAgents": retired_this_loop,
            "retiredAgentsHistory": retired_history[-500:],
            "healthyAgentCount": healthy_agent_count,
            "rebalancedSymbolsCount": len(problem_symbols),
            "rebalanceManifest": str(rebalance_manifest) if rebalance_manifest else None,
            "topupManifest": str(topup_manifest) if topup_manifest else None,
        }
        write_json(output_path, status)
        print(
            f"[{status['generatedAt']}] manifests={len(next_manifests)} "
            f"retired={len(retired_this_loop)} healthyAgents={healthy_agent_count} "
            f"rebalancedSymbols={len(problem_symbols)} topupManifest={topup_manifest or '-'} "
            f"rebalanceManifest={rebalance_manifest or '-'}"
        )

        active_manifests = next_manifests
        if not watch or not active_manifests:
            break
        time.sleep(interval_seconds)


if __name__ == "__main__":
    main()
