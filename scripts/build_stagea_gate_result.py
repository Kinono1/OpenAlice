#!/usr/bin/env python3
"""Build Stage-A gate result for the G3/G4 BTC-ETH-SOL quick decision."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "stagea_gate_result.v1"
DEFAULT_MATRIX_REPORT = (
    "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
)
DEFAULT_OUTPUT = (
    "data/research/strategy/analysis/g3g4/stagea_gate_result.v1.json"
)
DEFAULT_MARKDOWN = "docs/research/g3g4_stageA_gate_result_latest.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute Stage-A pass/fail gate from multi-asset matrix report."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--matrix-report",
        default=DEFAULT_MATRIX_REPORT,
        help="Path to multi-asset matrix report JSON.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output Stage-A gate JSON path.",
    )
    parser.add_argument(
        "--markdown",
        default=DEFAULT_MARKDOWN,
        help="Output Stage-A gate markdown path.",
    )
    parser.add_argument(
        "--btc-baseline-fdrq",
        type=float,
        default=0.355,
        help="BTC baseline used by relative gate condition A.",
    )
    parser.add_argument(
        "--abs-fdrq-max",
        type=float,
        default=0.25,
        help="Absolute fdrQ cap used by gate condition B.",
    )
    parser.add_argument(
        "--pbo-max",
        type=float,
        default=0.20,
        help="Maximum meanPbo for both gate conditions.",
    )
    parser.add_argument(
        "--dsr-min",
        type=float,
        default=0.50,
        help="Minimum meanDsrProbability for both gate conditions.",
    )
    parser.add_argument(
        "--min-completed-assets",
        type=int,
        default=2,
        help="Minimum completed assets required for any pass decision.",
    )
    parser.add_argument(
        "--condition-a-min-assets",
        type=int,
        default=2,
        help="Minimum assets passing relative condition A.",
    )
    parser.add_argument(
        "--condition-b-min-assets",
        type=int,
        default=1,
        help="Minimum assets passing absolute condition B.",
    )
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


def build_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# G3/G4 Stage-A Gate Result")
    lines.append("")
    lines.append(f"- Generated at: `{report.get('generatedAt')}`")
    lines.append(f"- Matrix run: `{report.get('source', {}).get('matrixRunId')}`")
    lines.append(f"- Stage-A passed: `{report.get('decision', {}).get('passed')}`")
    lines.append(f"- Next stage: `{report.get('decision', {}).get('nextStage')}`")
    lines.append("")
    summary = report.get("summary", {})
    lines.append("## Gate Summary")
    lines.append("")
    lines.append(
        "- Completed assets: `{completed}` (min required `{min_required}`)".format(
            completed=summary.get("completedAssets"),
            min_required=summary.get("minCompletedAssets"),
        )
    )
    lines.append(
        "- Condition A count: `{count}` / `{required}`".format(
            count=summary.get("conditionACount"),
            required=summary.get("conditionAMinAssets"),
        )
    )
    lines.append(
        "- Condition B count: `{count}` / `{required}`".format(
            count=summary.get("conditionBCount"),
            required=summary.get("conditionBMinAssets"),
        )
    )
    lines.append(
        "- fdrQ dispersion ratio: `{value}`".format(
            value=summary.get("fdrQDispersionRatio")
        )
    )
    lines.append(
        "- Heterogeneity flag (S6): `{value}`".format(
            value=summary.get("heterogeneityFlag")
        )
    )
    lines.append("")
    lines.append("| asset | status | fdrQ | meanPbo | meanDsrProbability | condA | condB |")
    lines.append("| --- | --- | ---: | ---: | ---: | --- | --- |")
    for row in report.get("assets", []):
        lines.append(
            "| {asset} | {status} | {fdrq} | {pbo} | {dsr} | {a} | {b} |".format(
                asset=row.get("asset"),
                status=row.get("status"),
                fdrq=row.get("fdrQ"),
                pbo=row.get("meanPbo"),
                dsr=row.get("meanDsrProbability"),
                a=row.get("conditionA"),
                b=row.get("conditionB"),
            )
        )
    lines.append("")
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    matrix_report_path = resolve_path(repo_root, str(args.matrix_report))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    if not matrix_report_path.exists():
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"matrix report missing: {matrix_report_path}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    matrix_payload = read_json_object(matrix_report_path)
    raw_assets = matrix_payload.get("assets", [])
    if not isinstance(raw_assets, list):
        raw_assets = []

    rows: List[Dict[str, Any]] = []
    completed_assets = 0
    condition_a_count = 0
    condition_b_count = 0
    fdr_values: List[float] = []

    for row in raw_assets:
        if not isinstance(row, dict):
            continue
        asset = str(row.get("asset", "")).strip() or "UNKNOWN"
        status = str(row.get("status", "")).strip()
        fdr_q = to_float(row.get("fdrQ"))
        mean_pbo = to_float(row.get("meanPbo"))
        mean_dsr = to_float(row.get("meanDsrProbability"))

        is_completed = status == "completed"
        has_metrics = (
            fdr_q is not None and mean_pbo is not None and mean_dsr is not None
        )
        condition_a = False
        condition_b = False
        if is_completed and has_metrics:
            completed_assets += 1
            fdr_values.append(float(fdr_q))
            condition_a = (
                float(fdr_q) < float(args.btc_baseline_fdrq)
                and float(mean_pbo) <= float(args.pbo_max)
                and float(mean_dsr) >= float(args.dsr_min)
            )
            condition_b = (
                float(fdr_q) <= float(args.abs_fdrq_max)
                and float(mean_pbo) <= float(args.pbo_max)
                and float(mean_dsr) >= float(args.dsr_min)
            )
            if condition_a:
                condition_a_count += 1
            if condition_b:
                condition_b_count += 1

        rows.append(
            {
                "asset": asset,
                "status": status,
                "fdrQ": fdr_q,
                "meanPbo": mean_pbo,
                "meanDsrProbability": mean_dsr,
                "eligible": bool(is_completed and has_metrics),
                "conditionA": condition_a,
                "conditionB": condition_b,
            }
        )

    median_fdr = percentile(fdr_values, 0.5)
    dispersion_ratio = None
    if fdr_values and median_fdr is not None and median_fdr > 0:
        dispersion_ratio = (max(fdr_values) - min(fdr_values)) / median_fdr
    heterogeneity_flag = bool(
        dispersion_ratio is not None and dispersion_ratio > 0.5
    )

    has_min_completed = completed_assets >= int(args.min_completed_assets)
    pass_condition_a = condition_a_count >= int(args.condition_a_min_assets)
    pass_condition_b = condition_b_count >= int(args.condition_b_min_assets)
    passed = bool(has_min_completed and (pass_condition_a or pass_condition_b))
    next_stage = (
        "continue_current_framework"
        if passed
        else "stageB_governance_review"
    )

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "source": {
            "matrixReport": str(matrix_report_path),
            "matrixRunId": matrix_payload.get("runId"),
        },
        "thresholds": {
            "btcBaselineFdrQ": float(args.btc_baseline_fdrq),
            "absFdrQMax": float(args.abs_fdrq_max),
            "meanPboMax": float(args.pbo_max),
            "meanDsrProbabilityMin": float(args.dsr_min),
        },
        "summary": {
            "completedAssets": completed_assets,
            "minCompletedAssets": int(args.min_completed_assets),
            "conditionACount": condition_a_count,
            "conditionAMinAssets": int(args.condition_a_min_assets),
            "conditionBCount": condition_b_count,
            "conditionBMinAssets": int(args.condition_b_min_assets),
            "fdrQMedian": median_fdr,
            "fdrQDispersionRatio": dispersion_ratio,
            "heterogeneityFlag": heterogeneity_flag,
        },
        "assets": rows,
        "decision": {
            "passed": passed,
            "hasMinCompletedAssets": has_min_completed,
            "conditionAPassed": pass_condition_a,
            "conditionBPassed": pass_condition_b,
            "nextStage": next_stage,
        },
    }

    write_json(output_path, report)
    write_markdown(markdown_path, build_markdown(report))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "passed": passed,
                "nextStage": next_stage,
            },
            ensure_ascii=False,
        )
    )
    return 0 if passed else 2


if __name__ == "__main__":
    raise SystemExit(main())
