#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


TARGET_BARS = ("1H", "15m", "5m")
BAR_TO_TIMEFRAME = {
    "1H": "1h",
    "15m": "15m",
    "5m": "5m",
}

STRICT_DONE_RE = re.compile(
    r"^\[(\d+)/(\d+)\]\s+([A-Za-z0-9._-]+)\s+([A-Za-z0-9]+):\s+done\s+written=(\d+)\s+fetched=(\d+)\s+shards=(\d+)\s*$"
)


@dataclass(frozen=True)
class CatalogSymbol:
    inst_id: str
    inst_type_dir: str
    market_state: str
    list_time_ms: int | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Build robust completion truth for OKX candles using summary/state/log sources "
            "plus file-level verification."
        )
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_historical",
        help="Path to OKX historical dataset root.",
    )
    parser.add_argument(
        "--logs-glob",
        default="logs/okx_historical_pipeline_*.log",
        help="Glob pattern for pipeline logs (resolved from repo root).",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Output directory (default: <dataset-root>/reports/swarm).",
    )
    parser.add_argument(
        "--require-recent-shard-for-live",
        default="true",
        choices=("true", "false"),
        help="For live symbols, require current/previous month shard to pass verification.",
    )
    parser.add_argument(
        "--min-nonempty-shards",
        type=int,
        default=1,
        help="Minimum non-empty shard files required for a bar to be considered valid.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def sanitize_segment(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", value)


def normalize_bar(raw: str | None) -> str | None:
    if not raw:
        return None
    text = str(raw).strip()
    if not text:
        return None
    lowered = text.lower()
    if lowered == "1h":
        return "1H"
    if lowered == "15m":
        return "15m"
    if lowered == "5m":
        return "5m"
    return text if text in TARGET_BARS else None


def month_keys_recent() -> set[str]:
    now = datetime.now(timezone.utc)
    prev = (now.replace(day=1) - timedelta(days=1)).replace(day=1)
    return {now.strftime("%Y-%m"), prev.strftime("%Y-%m")}


def parse_list_time_ms(raw: Any) -> int | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text:
        return None
    if not text.isdigit():
        return None
    value = int(text)
    return value if value > 0 else None


def load_catalog(catalog_path: Path) -> dict[str, CatalogSymbol]:
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    rows = payload.get("items", [])
    out: dict[str, CatalogSymbol] = {}
    for row in rows:
        inst_id = str(row.get("instId", "")).strip()
        if not inst_id:
            continue
        inst_type = str(row.get("instType", "")).upper()
        inst_type_dir = "swap" if inst_type == "SWAP" else "spot"
        market_state = str(row.get("state", "")).lower() or "unknown"
        out[inst_id] = CatalogSymbol(
            inst_id=inst_id,
            inst_type_dir=inst_type_dir,
            market_state=market_state,
            list_time_ms=parse_list_time_ms(row.get("listTime")),
        )
    return out


def iter_json_files(paths: Iterable[Path]) -> Iterable[tuple[Path, dict[str, Any]]]:
    for path in paths:
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(payload, dict):
            yield path, payload


def verify_bar_files(
    dataset_root: Path,
    symbol: CatalogSymbol,
    bar: str,
    min_nonempty_shards: int,
    require_recent_for_live: bool,
    recent_months: set[str],
) -> dict[str, Any]:
    timeframe = BAR_TO_TIMEFRAME[bar]
    symbol_dir = (
        dataset_root
        / "candles"
        / timeframe
        / symbol.inst_type_dir
        / sanitize_segment(symbol.inst_id)
    )
    shards = sorted(
        [
            *symbol_dir.glob("*.csv"),
            *symbol_dir.glob("*.csv.zst"),
        ]
    )
    nonempty = [p for p in shards if p.exists() and p.stat().st_size > 0]
    recent_hits = [
        p
        for p in nonempty
        if any(p.name.startswith(f"{month}.") for month in recent_months)
    ]
    has_recent = len(recent_hits) > 0
    needs_recent = require_recent_for_live and symbol.market_state == "live"
    valid = (
        symbol_dir.exists()
        and len(nonempty) >= min_nonempty_shards
        and ((not needs_recent) or has_recent)
    )
    return {
        "dir": str(symbol_dir),
        "exists": symbol_dir.exists(),
        "shardCount": len(shards),
        "nonEmptyShardCount": len(nonempty),
        "recentMonths": sorted(recent_months),
        "recentShardFound": has_recent,
        "needsRecentShard": needs_recent,
        "valid": valid,
    }


def main() -> None:
    args = parse_args()
    root = repo_root()
    dataset_root = (root / args.dataset_root).resolve()
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else (dataset_root / "reports" / "swarm")
    )
    output_dir.mkdir(parents=True, exist_ok=True)

    catalog_path = dataset_root / "catalog" / "usdt_all.v1.json"
    if not catalog_path.exists():
        raise FileNotFoundError(f"Catalog not found: {catalog_path}")
    catalog = load_catalog(catalog_path)

    summary_paths = sorted((dataset_root / "reports").glob("candles_summary*.v1.json"))
    summary_paths += sorted((dataset_root / "reports").glob("agent*/candles_summary*.v1.json"))
    summary_paths = sorted(set(summary_paths))
    state_paths = sorted((dataset_root / "state").glob("candles*.state.v1.json"))
    log_paths = sorted((root).glob(args.logs_glob))

    bar_sources: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))

    for path, payload in iter_json_files(summary_paths):
        for row in payload.get("results", []):
            if row.get("error"):
                continue
            inst_id = str(row.get("instId", "")).strip()
            if inst_id not in catalog:
                continue
            bar = normalize_bar(row.get("bar"))
            if not bar:
                key = str(row.get("key", "")).strip()
                if "::" in key:
                    _, key_bar = key.split("::", 1)
                    bar = normalize_bar(key_bar)
            if bar in TARGET_BARS:
                bar_sources[inst_id][bar].add(f"summary:{path.name}")

    for path, payload in iter_json_files(state_paths):
        items = payload.get("items", {})
        if not isinstance(items, dict):
            continue
        for key, value in items.items():
            if not isinstance(value, dict):
                continue
            if not value.get("completed"):
                continue
            key_text = str(key).strip()
            if "::" not in key_text:
                continue
            inst_id, key_bar = key_text.split("::", 1)
            inst_id = inst_id.strip()
            if inst_id not in catalog:
                continue
            bar = normalize_bar(key_bar)
            if bar in TARGET_BARS:
                bar_sources[inst_id][bar].add(f"state:{path.name}")

    for path in log_paths:
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except Exception:
            continue
        for line in lines:
            match = STRICT_DONE_RE.match(line.strip())
            if not match:
                continue
            _, _, inst_id, raw_bar, _, _, _ = match.groups()
            if inst_id not in catalog:
                continue
            bar = normalize_bar(raw_bar)
            if bar in TARGET_BARS:
                bar_sources[inst_id][bar].add(f"log:{path.name}")

    recent_months = month_keys_recent()
    require_recent_for_live = args.require_recent_shard_for_live == "true"

    entries: list[dict[str, Any]] = []
    completed_symbols: list[str] = []
    remaining_symbols: list[str] = []

    for inst_id in sorted(catalog):
        symbol_meta = catalog[inst_id]
        completed_bars: list[str] = []
        missing_bars: list[str] = []
        bar_details: dict[str, Any] = {}
        for bar in TARGET_BARS:
            sources = sorted(bar_sources.get(inst_id, {}).get(bar, set()))
            verify = verify_bar_files(
                dataset_root=dataset_root,
                symbol=symbol_meta,
                bar=bar,
                min_nonempty_shards=max(args.min_nonempty_shards, 1),
                require_recent_for_live=require_recent_for_live,
                recent_months=recent_months,
            )
            is_complete = bool(sources) and bool(verify["valid"])
            if is_complete:
                completed_bars.append(bar)
            else:
                missing_bars.append(bar)
            bar_details[bar] = {
                "complete": is_complete,
                "sources": sources,
                "fileVerification": verify,
            }

        symbol_complete = len(missing_bars) == 0
        if symbol_complete:
            completed_symbols.append(inst_id)
        else:
            remaining_symbols.append(inst_id)

        entries.append(
            {
                "instId": inst_id,
                "instTypeDir": symbol_meta.inst_type_dir,
                "marketState": symbol_meta.market_state,
                "listTimeMs": symbol_meta.list_time_ms,
                "completedBars": completed_bars,
                "missingBars": missing_bars,
                "symbolComplete": symbol_complete,
                "barDetails": bar_details,
            }
        )

    truth_payload = {
        "schemaVersion": "okx_completion_truth.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRoot": str(dataset_root),
        "inputs": {
            "catalogPath": str(catalog_path),
            "summaryFiles": [str(p) for p in summary_paths],
            "stateFiles": [str(p) for p in state_paths],
            "logFiles": [str(p) for p in log_paths],
            "requireRecentShardForLive": require_recent_for_live,
            "minNonEmptyShards": max(args.min_nonempty_shards, 1),
        },
        "totals": {
            "symbols": len(entries),
            "completedSymbolsFull3": len(completed_symbols),
            "remainingSymbols": len(remaining_symbols),
        },
        "targetBars": list(TARGET_BARS),
        "symbols": entries,
    }

    truth_path = output_dir / "completion_truth.v1.json"
    completed_path = output_dir / "completed_symbols_full3.txt"
    remaining_path = output_dir / "remaining_symbols.txt"
    missing_map_path = output_dir / "remaining_symbols_missing_bars.v1.json"

    truth_path.write_text(
        json.dumps(truth_payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    completed_path.write_text("\n".join(sorted(completed_symbols)) + ("\n" if completed_symbols else ""), encoding="utf-8")
    remaining_path.write_text("\n".join(sorted(remaining_symbols)) + ("\n" if remaining_symbols else ""), encoding="utf-8")
    missing_map_path.write_text(
        json.dumps(
            {
                "schemaVersion": "okx_remaining_missing_bars.v1",
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "items": [
                    {
                        "instId": row["instId"],
                        "missingBars": row["missingBars"],
                    }
                    for row in entries
                    if row["missingBars"]
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    print(
        "completion truth built: "
        f"symbols={len(entries)} completed={len(completed_symbols)} remaining={len(remaining_symbols)} "
        f"output={truth_path}"
    )


if __name__ == "__main__":
    main()

