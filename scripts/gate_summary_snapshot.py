#!/usr/bin/env python3
"""Print a concise snapshot from daily gate summaries.

Default behavior:
- Read the latest file under data/runtime/gate_summaries/*.json
- Print one-line summary with execution/risk/idempotency highlights
- Exit 0 even when no summary file exists (non-blocking governance step)
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print latest daily gate summary snapshot."
    )
    parser.add_argument(
        "--summary-dir",
        default="data/runtime/gate_summaries",
        help="Directory containing daily gate summary JSON files.",
    )
    parser.add_argument(
        "--date",
        default="",
        help="Explicit date key (YYYY-MM-DD). Empty means latest available file.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Print normalized JSON instead of one-line text.",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="Return non-zero when no summary file is found.",
    )
    return parser.parse_args()


def resolve_summary_file(summary_dir: Path, date_key: str) -> Optional[Path]:
    if date_key:
        candidate = summary_dir / f"{date_key}.json"
        return candidate if candidate.exists() else None

    candidates = sorted(
        path
        for path in summary_dir.glob("*.json")
        if path.is_file() and len(path.stem) == 10
    )
    return candidates[-1] if candidates else None


def normalize(payload: Dict[str, Any]) -> Dict[str, Any]:
    exec_gate = payload.get("executionGateDecision") or {}
    risk_breaker = payload.get("riskBreaker") or {}
    idempotency = payload.get("idempotencyEvents") or {}
    regime_shift = payload.get("regimeShift") or {}

    return {
        "date": payload.get("date"),
        "capitalRampStage": payload.get("capitalRampStage"),
        "executionGateAction": exec_gate.get("action"),
        "executionBreakerActive": risk_breaker.get("executionBreakerActive"),
        "regimeShiftSeverity": regime_shift.get("severity"),
        "idempotencyDuplicateCount": idempotency.get("duplicateCount", 0),
        "idempotencyRetryOverrideCount": idempotency.get("retryOverrideCount", 0),
        "idempotencyRetryRejectedCount": idempotency.get("retryRejectedCount", 0),
        "idempotencyDuplicateKeys": idempotency.get("duplicateKeys") or [],
        "idempotencyRetryOverrideKeys": idempotency.get("retryOverrideKeys") or [],
        "idempotencyRetryRejectedKeys": idempotency.get("retryRejectedKeys") or [],
    }


def render_line(summary: Dict[str, Any]) -> str:
    return (
        "gate_summary_snapshot "
        f"date={summary.get('date')} "
        f"stage={summary.get('capitalRampStage')} "
        f"gate={summary.get('executionGateAction')} "
        f"breaker={summary.get('executionBreakerActive')} "
        f"regime={summary.get('regimeShiftSeverity')} "
        f"idemp_duplicate={summary.get('idempotencyDuplicateCount')} "
        f"idemp_retry_override={summary.get('idempotencyRetryOverrideCount')} "
        f"idemp_retry_rejected={summary.get('idempotencyRetryRejectedCount')}"
    )


def main() -> int:
    args = parse_args()
    summary_dir = Path(args.summary_dir)

    file_path = resolve_summary_file(summary_dir, args.date.strip())
    if file_path is None:
        message = f"gate_summary_snapshot: no summary file found under {summary_dir}"
        if args.strict:
            print(message)
            return 1
        print(message)
        return 0

    try:
        payload = json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as exc:  # pragma: no cover - defensive runtime guard
        print(f"gate_summary_snapshot: failed to read {file_path}: {exc}")
        return 1 if args.strict else 0

    summary = normalize(payload if isinstance(payload, dict) else {})
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(render_line(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
