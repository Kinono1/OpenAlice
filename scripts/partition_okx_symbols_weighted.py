#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Partition remaining OKX symbols into weighted balanced shards."
    )
    parser.add_argument(
        "--dataset-root",
        default="data/market/okx_historical",
        help="Dataset root path.",
    )
    parser.add_argument(
        "--completion-truth",
        default="",
        help="Path to completion_truth.v1.json (default: <dataset-root>/reports/swarm/completion_truth.v1.json).",
    )
    parser.add_argument(
        "--output-dir",
        default="",
        help="Output dir (default: <dataset-root>/reports/swarm).",
    )
    parser.add_argument(
        "--agents",
        type=int,
        default=6,
        help="Number of shards/agents.",
    )
    parser.add_argument(
        "--symbols-file",
        default="",
        help="Optional symbols file (one symbol per line) to override remaining list.",
    )
    parser.add_argument(
        "--max-symbols",
        type=int,
        default=0,
        help="Optional cap for dry-run (0 means no cap).",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def parse_list_time_ms(raw: Any) -> int | None:
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or not text.isdigit():
        return None
    value = int(text)
    return value if value > 0 else None


def load_catalog(catalog_path: Path) -> dict[str, dict[str, Any]]:
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    items = payload.get("items", [])
    out: dict[str, dict[str, Any]] = {}
    for row in items:
        inst_id = str(row.get("instId", "")).strip()
        if not inst_id:
            continue
        out[inst_id] = {
            "listTimeMs": parse_list_time_ms(row.get("listTime")),
            "instType": str(row.get("instType", "")),
            "marketState": str(row.get("state", "")),
        }
    return out


def read_symbols_file(path: Path) -> list[str]:
    lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
    seen: set[str] = set()
    out: list[str] = []
    for line in lines:
        sym = line.strip()
        if not sym or sym.startswith("#"):
            continue
        if sym in seen:
            continue
        seen.add(sym)
        out.append(sym)
    return out


def months_since_listing(list_time_ms: int | None, now_ms: int) -> int:
    if list_time_ms is None:
        return 60
    if list_time_ms >= now_ms:
        return 1
    delta_ms = now_ms - list_time_ms
    month_ms = 30 * 24 * 3600 * 1000
    return max(1, int(math.ceil(delta_ms / month_ms)))


@dataclass
class WeightedSymbol:
    inst_id: str
    missing_bars_count: int
    list_time_ms: int | None
    months: int
    weight: float


def main() -> None:
    args = parse_args()
    if args.agents < 1:
        raise ValueError("--agents must be >= 1")

    root = repo_root()
    dataset_root = (root / args.dataset_root).resolve()
    output_dir = (
        Path(args.output_dir).resolve()
        if args.output_dir
        else (dataset_root / "reports" / "swarm")
    )
    output_dir.mkdir(parents=True, exist_ok=True)
    shards_dir = output_dir / "shards"
    shards_dir.mkdir(parents=True, exist_ok=True)

    catalog = load_catalog(dataset_root / "catalog" / "usdt_all.v1.json")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    symbol_missing_counts: dict[str, int] = {}

    if args.symbols_file:
        symbols = read_symbols_file(Path(args.symbols_file).resolve())
        for sym in symbols:
            symbol_missing_counts[sym] = 3
    else:
        completion_truth_path = (
            Path(args.completion_truth).resolve()
            if args.completion_truth
            else (output_dir / "completion_truth.v1.json")
        )
        payload = json.loads(completion_truth_path.read_text(encoding="utf-8"))
        for item in payload.get("symbols", []):
            inst_id = str(item.get("instId", "")).strip()
            if not inst_id:
                continue
            missing = item.get("missingBars", [])
            if not isinstance(missing, list):
                continue
            missing_count = len([x for x in missing if str(x).strip()])
            if missing_count > 0:
                symbol_missing_counts[inst_id] = missing_count

    items: list[WeightedSymbol] = []
    for inst_id, missing_count in symbol_missing_counts.items():
        meta = catalog.get(inst_id, {})
        months = months_since_listing(meta.get("listTimeMs"), now_ms)
        weight = float(months * max(1, missing_count))
        items.append(
            WeightedSymbol(
                inst_id=inst_id,
                missing_bars_count=max(1, missing_count),
                list_time_ms=meta.get("listTimeMs"),
                months=months,
                weight=weight,
            )
        )

    items.sort(key=lambda x: (-x.weight, x.inst_id))
    if args.max_symbols and args.max_symbols > 0:
        items = items[: args.max_symbols]

    shards: list[dict[str, Any]] = [
        {
            "shardIndex": i + 1,
            "symbols": [],
            "weightTotal": 0.0,
        }
        for i in range(args.agents)
    ]

    for item in items:
        target = min(shards, key=lambda x: (x["weightTotal"], x["shardIndex"]))
        target["symbols"].append(item.inst_id)
        target["weightTotal"] += item.weight

    for old in shards_dir.glob("symbols_shard_*.txt"):
        old.unlink(missing_ok=True)

    for shard in shards:
        shard_file = shards_dir / f"symbols_shard_{shard['shardIndex']:02d}.txt"
        symbols_sorted = sorted(shard["symbols"])
        shard_file.write_text(
            "\n".join(symbols_sorted) + ("\n" if symbols_sorted else ""),
            encoding="utf-8",
        )
        shard["symbolCount"] = len(symbols_sorted)
        shard["file"] = str(shard_file)
        shard["symbols"] = symbols_sorted
        shard["weightTotal"] = round(shard["weightTotal"], 3)

    symbol_weights = [
        {
            "instId": item.inst_id,
            "missingBarsCount": item.missing_bars_count,
            "listTimeMs": item.list_time_ms,
            "monthsSinceListing": item.months,
            "weight": round(item.weight, 3),
        }
        for item in items
    ]

    nonempty = [x for x in shards if x["symbolCount"] > 0]
    if nonempty:
        max_weight = max(x["weightTotal"] for x in nonempty)
        min_weight = min(x["weightTotal"] for x in nonempty)
        imbalance_ratio = round(max_weight / min_weight, 4) if min_weight > 0 else None
    else:
        imbalance_ratio = None

    payload = {
        "schemaVersion": "okx_weighted_partition_plan.v1",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "datasetRoot": str(dataset_root),
        "params": {
            "agents": args.agents,
            "symbolsFile": str(Path(args.symbols_file).resolve()) if args.symbols_file else None,
            "maxSymbols": args.max_symbols if args.max_symbols > 0 else None,
        },
        "totals": {
            "symbols": len(items),
            "shards": args.agents,
            "imbalanceRatio": imbalance_ratio,
        },
        "shards": shards,
        "symbolWeights": symbol_weights,
    }

    out_path = output_dir / "weighted_partition_plan.v1.json"
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "weighted partition built: "
        f"symbols={len(items)} shards={args.agents} imbalance={imbalance_ratio} output={out_path}"
    )


if __name__ == "__main__":
    main()

