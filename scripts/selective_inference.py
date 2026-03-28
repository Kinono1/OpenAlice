#!/usr/bin/env python3
"""Minimal e-BH style selective-inference prototype over strategy_validation_runs."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


@dataclass
class CandidateStat:
    index: int
    strategy_id: str
    strategy_name: str
    p_value: float


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run minimal e-BH prototype on strategy validation runs.")
    parser.add_argument("--runs", required=True, help="strategy_validation_runs.json path.")
    parser.add_argument("--output", required=True, help="Output JSON path.")
    parser.add_argument("--alpha", type=float, default=0.1, help="Selection alpha.")
    return parser.parse_args()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def extract_candidates(runs_payload: Dict[str, Any]) -> List[CandidateStat]:
    candidates: List[CandidateStat] = []
    for idx, row in enumerate(runs_payload.get("candidates", [])):
        if not isinstance(row, dict):
            continue
        fdr = row.get("fdr", {})
        p_value = fdr.get("pValue")
        if not isinstance(p_value, (int, float)):
            continue
        candidates.append(
            CandidateStat(
                index=idx,
                strategy_id=str(row.get("strategyId") or f"C{idx}"),
                strategy_name=str(row.get("strategyName") or f"candidate_{idx}"),
                p_value=float(p_value),
            )
        )
    if not candidates:
        raise ValueError("No candidate p-values found in runs payload.")
    return candidates


def run_ebh(candidates: List[CandidateStat], alpha: float = 0.1) -> Dict[str, Any]:
    ordered = sorted(candidates, key=lambda item: item.p_value)
    m = len(ordered)
    results: List[Dict[str, Any]] = []
    running_required_alpha = 0.0
    reject_count = 0

    for rank, candidate in enumerate(ordered, start=1):
        e_value = 1.0 / max(candidate.p_value, 1e-12)
        required_alpha = min(1.0, m / (rank * e_value))
        running_required_alpha = max(running_required_alpha, required_alpha)
        passed = running_required_alpha <= alpha
        if passed:
            reject_count += 1
        results.append(
            {
                "index": candidate.index,
                "strategyId": candidate.strategy_id,
                "strategyName": candidate.strategy_name,
                "pValue": candidate.p_value,
                "rank": rank,
                "eValue": e_value,
                "effectiveQ": running_required_alpha,
                "passed": passed,
            }
        )

    champion = results[0]
    return {
        "schemaVersion": "selective_inference.v1",
        "generatedAt": utc_iso(),
        "method": "e_bh_prototype",
        "alpha": alpha,
        "candidateCount": m,
        "rejectCount": reject_count,
        "champion": champion,
        "candidates": results,
    }


def main() -> int:
    args = parse_args()
    runs_payload = read_json(Path(args.runs).expanduser())
    candidates = extract_candidates(runs_payload)
    payload = run_ebh(candidates, alpha=args.alpha)
    write_json(Path(args.output).expanduser(), payload)
    print(json.dumps({"output": str(Path(args.output).expanduser()), "rejectCount": payload["rejectCount"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
