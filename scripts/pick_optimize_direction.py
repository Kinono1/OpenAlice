#!/usr/bin/env python3
"""Pick next optimize direction from a configured sequence or adaptive signal."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ALLOWED_DIRECTIONS = {
    "balanced",
    "risk",
    "execution",
    "regime",
    "alpha",
    "diversified",
}

FAILURE_TO_DIRECTION_WEIGHTS: Dict[str, Dict[str, float]] = {
    "gate_pass_robust_uplift": {
        "risk": 1.0,
        "regime": 0.65,
        "diversified": 0.25,
    },
    "gate_pass_robust_ci": {
        "risk": 0.95,
        "regime": 0.55,
        "diversified": 0.2,
    },
    "gate_pass_variance": {
        "risk": 0.85,
        "execution": 0.35,
    },
    "gate_pass_lift": {
        "alpha": 1.0,
        "regime": 0.3,
    },
    "gate_pass_net_trim10": {
        "execution": 0.9,
        "alpha": 0.25,
    },
    "gate_pass_robust_delta": {
        "regime": 1.0,
        "diversified": 0.75,
        "risk": 0.35,
    },
    "gate_pass_turnover_cap": {
        "execution": 1.0,
        "risk": 0.2,
    },
    "gate_pass_error_ratio": {
        "execution": 0.55,
        "risk": 0.25,
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Rotate optimize direction (cycle) or choose by failure signal (adaptive)."
    )
    parser.add_argument(
        "--mode",
        choices=["cycle", "adaptive"],
        default="cycle",
        help="Direction selection mode.",
    )
    parser.add_argument(
        "--state-file",
        default="data/research/strategy-watch/optimize_direction_state.json",
        help="State file for cycle index.",
    )
    parser.add_argument(
        "--sequence",
        default="regime,risk,execution,alpha,diversified",
        help="Comma-separated optimize direction sequence.",
    )
    parser.add_argument(
        "--failure-report",
        default="data/research/strategy-watch/analysis/latest_failure_breakdown.json",
        help="Failure breakdown report used by adaptive mode.",
    )
    parser.add_argument(
        "--failure-window",
        type=int,
        default=8,
        help="Preferred window size from failure report for adaptive mode.",
    )
    parser.add_argument(
        "--min-signal-score",
        type=float,
        default=0.08,
        help="Minimum adaptive direction score; fallback to cycle if lower.",
    )
    parser.add_argument(
        "--max-consecutive",
        type=int,
        default=3,
        help="Max allowed consecutive same direction in adaptive mode.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute next direction without persisting state.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def parse_sequence(raw: str) -> List[str]:
    seq = [x.strip() for x in (raw or "").split(",") if x.strip()]
    if not seq:
        raise ValueError("empty optimize direction sequence")
    invalid = [x for x in seq if x not in ALLOWED_DIRECTIONS]
    if invalid:
        raise ValueError(f"invalid directions in sequence: {','.join(invalid)}")
    return seq


def load_json(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def load_state(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {"last_index": -1, "history": []}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"last_index": -1, "history": []}
    if not isinstance(payload, dict):
        return {"last_index": -1, "history": []}
    return payload


def save_state(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def recent_direction_streak(history: List[Any], direction: str) -> int:
    streak = 0
    for item in reversed(history):
        if not isinstance(item, dict):
            break
        if str(item.get("direction", "")).strip().lower() != direction:
            break
        streak += 1
    return streak


def pick_failure_window(
    windows: List[Dict[str, Any]],
    preferred_window: int,
) -> Optional[Dict[str, Any]]:
    if not windows:
        return None
    for item in windows:
        try:
            if int(item.get("window", -1)) == int(preferred_window):
                return item
        except Exception:
            continue
    # fallback: choose the smallest window for fresher signal
    ranked: List[Tuple[int, Dict[str, Any]]] = []
    for item in windows:
        try:
            ranked.append((int(item.get("window", 10**9)), item))
        except Exception:
            continue
    if not ranked:
        return None
    ranked.sort(key=lambda x: x[0])
    return ranked[0][1]


def compute_direction_scores(
    window_payload: Dict[str, Any],
) -> Tuple[Dict[str, float], Dict[str, float]]:
    direction_scores: Dict[str, float] = {k: 0.0 for k in ALLOWED_DIRECTIONS}
    gate_scores: Dict[str, float] = {}
    for section in ("main_gate_fail_ratio", "transfer_gate_fail_ratio"):
        data = window_payload.get(section, {})
        if not isinstance(data, dict):
            continue
        for gate, raw_val in data.items():
            try:
                fail_ratio = float(raw_val)
            except Exception:
                continue
            fail_ratio = max(min(fail_ratio, 1.0), 0.0)
            gate_scores[gate] = max(gate_scores.get(gate, 0.0), fail_ratio)
            for direction, weight in FAILURE_TO_DIRECTION_WEIGHTS.get(gate, {}).items():
                direction_scores[direction] = direction_scores.get(direction, 0.0) + (
                    fail_ratio * float(weight)
                )

    transfer_false_ratio = window_payload.get("transfer_false_ratio")
    try:
        transfer_ratio = max(min(float(transfer_false_ratio), 1.0), 0.0)
    except Exception:
        transfer_ratio = 0.0
    if transfer_ratio > 0:
        direction_scores["regime"] += transfer_ratio * 0.55
        direction_scores["diversified"] += transfer_ratio * 0.45

    champion_h0_ratio = window_payload.get("champion_h0_ratio")
    try:
        h0_ratio = max(min(float(champion_h0_ratio), 1.0), 0.0)
    except Exception:
        h0_ratio = 0.0
    if h0_ratio > 0:
        direction_scores["alpha"] += h0_ratio * 0.45
        direction_scores["regime"] += h0_ratio * 0.25

    return direction_scores, gate_scores


def sorted_direction_scores(direction_scores: Dict[str, float]) -> List[Tuple[str, float]]:
    ranked = [
        (k, float(v))
        for k, v in direction_scores.items()
        if k in ALLOWED_DIRECTIONS and k != "balanced"
    ]
    ranked.sort(key=lambda x: (x[1], x[0]), reverse=True)
    return ranked


def main() -> int:
    args = parse_args()
    state_path = Path(args.state_file).resolve()
    failure_report_path = Path(args.failure_report).resolve()
    sequence = parse_sequence(args.sequence)
    state = load_state(state_path)
    last_idx_raw = state.get("last_index", -1)
    try:
        last_idx = int(last_idx_raw)
    except Exception:
        last_idx = -1
    next_idx = (last_idx + 1) % len(sequence)
    cycle_direction = sequence[next_idx]
    direction = cycle_direction
    decision_reason = "cycle_rotation"
    adaptive_detail: Dict[str, Any] = {
        "enabled": args.mode == "adaptive",
        "failure_report": str(failure_report_path),
        "window": int(args.failure_window),
        "selected_window": None,
        "direction_scores": {},
        "gate_scores": {},
        "fallback_to_cycle": False,
    }
    history = state.get("history", [])
    if not isinstance(history, list):
        history = []

    if args.mode == "adaptive":
        report_payload = load_json(failure_report_path, {})
        windows = report_payload.get("windows", []) if isinstance(report_payload, dict) else []
        if not isinstance(windows, list):
            windows = []
        selected_window = pick_failure_window(
            [x for x in windows if isinstance(x, dict)],
            preferred_window=int(args.failure_window),
        )
        if selected_window is None:
            adaptive_detail["fallback_to_cycle"] = True
            decision_reason = "adaptive_missing_failure_window"
        else:
            try:
                adaptive_detail["selected_window"] = int(selected_window.get("window", -1))
            except Exception:
                adaptive_detail["selected_window"] = None
            direction_scores, gate_scores = compute_direction_scores(selected_window)
            ranked = sorted_direction_scores(direction_scores)
            adaptive_detail["direction_scores"] = {
                k: round(v, 6) for k, v in sorted(direction_scores.items())
            }
            adaptive_detail["gate_scores"] = {
                k: round(v, 6)
                for k, v in sorted(gate_scores.items(), key=lambda kv: kv[1], reverse=True)
            }
            if not ranked:
                adaptive_detail["fallback_to_cycle"] = True
                decision_reason = "adaptive_empty_scores"
            else:
                top_direction, top_score = ranked[0]
                if float(top_score) < float(args.min_signal_score):
                    adaptive_detail["fallback_to_cycle"] = True
                    decision_reason = "adaptive_signal_too_weak"
                else:
                    chosen = top_direction
                    streak = recent_direction_streak(history, chosen)
                    if int(args.max_consecutive) > 0 and streak >= int(args.max_consecutive):
                        alt = next((d for d, _ in ranked[1:] if d != chosen), "")
                        if alt:
                            chosen = alt
                            decision_reason = "adaptive_avoid_consecutive"
                        elif cycle_direction != chosen:
                            chosen = cycle_direction
                            decision_reason = "adaptive_fallback_cycle_due_to_streak"
                        else:
                            decision_reason = "adaptive_streak_no_alternative"
                    else:
                        decision_reason = "adaptive_top_signal"
                    direction = chosen

    result = {
        "direction": direction,
        "index": next_idx,
        "mode": str(args.mode),
        "cycle_direction": cycle_direction,
        "decision_reason": decision_reason,
        "sequence": sequence,
        "state_file": str(state_path),
        "failure_report": str(failure_report_path),
        "adaptive": adaptive_detail,
        "dry_run": bool(args.dry_run),
        "generated_at": now_iso(),
    }

    if not args.dry_run:
        history.append(
            {
                "at": now_iso(),
                "direction": direction,
                "index": next_idx,
                "mode": str(args.mode),
                "decision_reason": decision_reason,
            }
        )
        history = history[-200:]
        save_state(
            state_path,
            {
                "last_index": next_idx,
                "sequence": sequence,
                "updated_at": now_iso(),
                "history": history,
            },
        )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
