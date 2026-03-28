#!/usr/bin/env python3
"""Build a single pre-continue decision artifact answering three blocking questions."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "precontinue_decision.v1"
DEFAULT_FDR_REPORT = (
    "data/research/strategy/analysis/g3g4/latest_fdr_bottleneck_report.v1.json"
)
DEFAULT_MATRIX_REPORT = (
    "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
)
DEFAULT_SENSITIVITY_REPORT = (
    "data/research/strategy/analysis/g3g4/latest_threshold_sensitivity.v1.json"
)
DEFAULT_OUTPUT = (
    "data/research/strategy/analysis/g3g4/precontinue_decision.v1.json"
)
DEFAULT_MARKDOWN = "docs/research/g3g4_precontinue_decision_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Synthesize a decision artifact before continuing any G3/G4 direction."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--fdr-report", default=DEFAULT_FDR_REPORT, help="FDR diagnosis report path.")
    parser.add_argument("--matrix-report", default=DEFAULT_MATRIX_REPORT, help="Multi-asset matrix report path.")
    parser.add_argument(
        "--sensitivity-report",
        default=DEFAULT_SENSITIVITY_REPORT,
        help="Threshold sensitivity report path.",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Output JSON path.")
    parser.add_argument("--markdown", default=DEFAULT_MARKDOWN, help="Output markdown path.")
    raw_argv = list(argv if argv is not None else sys.argv[1:])
    parsed_argv = [token for token in raw_argv if token != "--"]
    return parser.parse_args(parsed_argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def resolve_path(root: Path, raw: str) -> Path:
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        return candidate
    return (root / candidate).resolve()


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_markdown(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def read_json_object(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"json root must be object: {path}")
    return payload


def to_float(raw: Any) -> Optional[float]:
    try:
        if raw is None:
            return None
        text = str(raw).strip()
        if not text:
            return None
        return float(text)
    except Exception:
        return None


def percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    idx = (len(ordered) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(ordered[lo])
    w = idx - lo
    return float(ordered[lo] * (1.0 - w) + ordered[hi] * w)


def find_scenario(
    sensitivity_payload: Dict[str, Any],
    scenario_id: str,
) -> Dict[str, Any]:
    scenarios = sensitivity_payload.get("scenarios", [])
    if not isinstance(scenarios, list):
        return {}
    for row in scenarios:
        if isinstance(row, dict) and row.get("scenarioId") == scenario_id:
            return row
    return {}


def build_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# G3/G4 Pre-Continue Decision")
    lines.append("")
    lines.append(f"- Generated at: `{payload.get('generatedAt')}`")
    lines.append(f"- Primary recommendation: `{payload.get('decision', {}).get('primaryRecommendation')}`")
    lines.append("")
    lines.append("## Q1: Why fdrQ is stuck")
    q1 = payload.get("questionAnswers", {}).get("q1", {})
    lines.append(f"- Answer: {q1.get('answer')}")
    lines.append(f"- Evidence: {q1.get('evidence')}")
    lines.append("")
    lines.append("## Q2: Is single-BTC data enough")
    q2 = payload.get("questionAnswers", {}).get("q2", {})
    lines.append(f"- Answer: {q2.get('answer')}")
    lines.append(f"- Evidence: {q2.get('evidence')}")
    lines.append("")
    lines.append("## Q3: Are hard constraints reasonable")
    q3 = payload.get("questionAnswers", {}).get("q3", {})
    lines.append(f"- Answer: {q3.get('answer')}")
    lines.append(f"- Evidence: {q3.get('evidence')}")
    lines.append("")
    lines.append("## Rule Triggers")
    lines.append("")
    lines.append("| rule | triggered | evidence |")
    lines.append("| --- | --- | --- |")
    for row in payload.get("rules", []):
        lines.append(
            "| {rid} | {t} | {ev} |".format(
                rid=row.get("ruleId"),
                t=row.get("triggered"),
                ev=row.get("evidence"),
            )
        )
    lines.append("")
    lines.append("## Next Actions")
    for action in payload.get("decision", {}).get("nextActions", []):
        lines.append(f"- {action}")
    lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    fdr_report_path = resolve_path(repo_root, str(args.fdr_report))
    matrix_report_path = resolve_path(repo_root, str(args.matrix_report))
    sensitivity_report_path = resolve_path(repo_root, str(args.sensitivity_report))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    missing = [
        str(path)
        for path in (fdr_report_path, matrix_report_path, sensitivity_report_path)
        if not path.exists()
    ]
    if missing:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "missing required input report(s)",
                    "missing": missing,
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    fdr_payload = read_json_object(fdr_report_path)
    matrix_payload = read_json_object(matrix_report_path)
    sensitivity_payload = read_json_object(sensitivity_report_path)

    latest_fdr = fdr_payload.get("latest", {})
    if not isinstance(latest_fdr, dict):
        latest_fdr = {}
    latest_diag = str(latest_fdr.get("diagnosis", "unknown"))
    latest_why = str(latest_fdr.get("whyFdrQStuck", "")).strip()
    latest_fdr_q = to_float(latest_fdr.get("fdrQ"))

    assets = matrix_payload.get("assets", [])
    if not isinstance(assets, list):
        assets = []
    completed_assets = [
        row
        for row in assets
        if isinstance(row, dict) and row.get("status") == "completed"
    ]
    asset_count = len(completed_assets)

    asset_p_medians = [
        to_float((row.get("pValueSummary") or {}).get("median"))
        for row in completed_assets
    ]
    asset_p_medians = [value for value in asset_p_medians if value is not None]
    matrix_median_p = percentile(asset_p_medians, 0.5)

    low_p_assets = 0
    for row in completed_assets:
        p_summary = row.get("pValueSummary", {})
        lt_01 = p_summary.get("countLt0_10") if isinstance(p_summary, dict) else None
        if isinstance(lt_01, int) and lt_01 > 0:
            low_p_assets += 1
    low_p_share = (low_p_assets / asset_count) if asset_count > 0 else None

    btc_row = None
    for row in completed_assets:
        if str(row.get("asset", "")).strip().upper() == "BTC":
            btc_row = row
            break
    btc_fdr_q = to_float((btc_row or {}).get("fdrQ"))
    all_fdr = [to_float(row.get("fdrQ")) for row in completed_assets]
    all_fdr = [value for value in all_fdr if value is not None]
    median_fdr = percentile(all_fdr, 0.5)
    q25_fdr = percentile(all_fdr, 0.25)
    q75_fdr = percentile(all_fdr, 0.75)
    iqr_fdr = (q75_fdr - q25_fdr) if q75_fdr is not None and q25_fdr is not None else None

    prod_scenario = find_scenario(sensitivity_payload, "prod_frozen")
    fdr15_scenario = find_scenario(sensitivity_payload, "research_fdr_15")
    prod_fdr_block = to_float((prod_scenario.get("metrics") or {}).get("fdrBlockRate"))
    fdr15_delta_joint = to_float((fdr15_scenario.get("deltaVsProd") or {}).get("jointPassRate"))

    rules: List[Dict[str, Any]] = []

    r1 = (
        matrix_median_p is not None
        and matrix_median_p > 0.2
        and low_p_share is not None
        and low_p_share <= 0.2
    )
    rules.append(
        {
            "ruleId": "R1_strategy_rebuild",
            "triggered": r1,
            "evidence": (
                f"median_p={matrix_median_p}, low_p_asset_share={low_p_share}"
                if matrix_median_p is not None and low_p_share is not None
                else "insufficient matrix p-value evidence"
            ),
            "action": "Prioritize strategy signal redesign over FDR method swapping.",
        }
    )

    r2 = latest_diag == "correction_limited" or (
        low_p_share is not None
        and low_p_share >= 0.4
        and prod_fdr_block is not None
        and prod_fdr_block >= 0.5
    )
    rules.append(
        {
            "ruleId": "R2_fdr_method_upgrade",
            "triggered": r2,
            "evidence": (
                f"latest_diagnosis={latest_diag}, low_p_asset_share={low_p_share}, prod_fdr_block={prod_fdr_block}"
            ),
            "action": "Prioritize stronger selective-inference/FDR estimators.",
        }
    )

    r3 = fdr15_delta_joint is not None and fdr15_delta_joint >= 0.2
    rules.append(
        {
            "ruleId": "R3_threshold_governance_review",
            "triggered": r3,
            "evidence": f"research_fdr_15_delta_joint_pass={fdr15_delta_joint}",
            "action": "Open governance review for staged threshold policy.",
        }
    )

    r4 = (
        btc_fdr_q is not None
        and median_fdr is not None
        and iqr_fdr is not None
        and (btc_fdr_q - median_fdr) > iqr_fdr
    )
    rules.append(
        {
            "ruleId": "R4_data_expansion_priority",
            "triggered": r4,
            "evidence": (
                f"btc_fdrQ={btc_fdr_q}, median_fdrQ={median_fdr}, iqr_fdrQ={iqr_fdr}"
                if btc_fdr_q is not None and median_fdr is not None and iqr_fdr is not None
                else "insufficient BTC-vs-matrix comparison"
            ),
            "action": "Prioritize multi-asset protocol before further single-asset tuning.",
        }
    )

    if r1:
        primary_recommendation = "strategy_rebuild"
    elif r2:
        primary_recommendation = "fdr_method_upgrade"
    elif r4:
        primary_recommendation = "data_expansion_priority"
    elif r3:
        primary_recommendation = "threshold_governance_review"
    else:
        primary_recommendation = "continue_current_track_with_controls"

    next_actions: List[str] = []
    if primary_recommendation == "strategy_rebuild":
        next_actions.extend(
            [
                "Freeze parameter-only search for 48h and open strategy feature redesign cards.",
                "Rebuild candidate generator with stronger signal priors before next A/B cycle.",
            ]
        )
    elif primary_recommendation == "fdr_method_upgrade":
        next_actions.extend(
            [
                "Implement selective-inference grade controller (e-value/knockoff) in research branch.",
                "Benchmark against current BH baseline using identical candidate pools.",
            ]
        )
    elif primary_recommendation == "data_expansion_priority":
        next_actions.extend(
            [
                "Promote 10+ asset matrix as mandatory gate before selecting next primary plan.",
                "Demote BTC-only evidence to exploratory status.",
            ]
        )
    elif primary_recommendation == "threshold_governance_review":
        next_actions.extend(
            [
                "Keep production thresholds frozen, but draft governance memo with sensitivity evidence.",
                "Define explicit time-box and rollback criteria for any staged threshold policy.",
            ]
        )
    else:
        next_actions.extend(
            [
                "Continue current track with strict weekly evidence refresh.",
                "Re-run pre-continue decision after next completed A/B matrix.",
            ]
        )

    question_answers = {
        "q1": {
            "question": "Why is fdrQ around 0.355?",
            "answer": (
                "Current candidate p-values are mostly high, so no candidate reaches alpha-level significance."
                if latest_diag == "strategy_signal_limited"
                else latest_why or "Diagnosis requires manual inspection."
            ),
            "evidence": f"latest_diagnosis={latest_diag}, latest_fdrQ={latest_fdr_q}",
        },
        "q2": {
            "question": "Is single BTC data enough?",
            "answer": (
                "No. Multi-asset evidence is required before choosing the next primary direction."
            ),
            "evidence": (
                f"completed_assets={asset_count}, btc_fdrQ={btc_fdr_q}, matrix_median_fdrQ={median_fdr}"
            ),
        },
        "q3": {
            "question": "Are hard constraints reasonable?",
            "answer": (
                "Production thresholds stay frozen; research-only sensitivity is used to quantify trade-off, not to auto-relax gates."
            ),
            "evidence": (
                f"prod_fdr_block_rate={prod_fdr_block}, research_fdr_15_delta_joint_pass={fdr15_delta_joint}"
            ),
        },
    }

    payload = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "inputs": {
            "fdrReport": str(fdr_report_path),
            "matrixReport": str(matrix_report_path),
            "sensitivityReport": str(sensitivity_report_path),
        },
        "questionAnswers": question_answers,
        "rules": rules,
        "decision": {
            "primaryRecommendation": primary_recommendation,
            "triggeredRules": [row["ruleId"] for row in rules if row.get("triggered")],
            "nextActions": next_actions,
        },
    }
    write_json(output_path, payload)
    write_markdown(markdown_path, build_markdown(payload))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "primaryRecommendation": primary_recommendation,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

