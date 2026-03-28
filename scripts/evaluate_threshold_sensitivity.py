#!/usr/bin/env python3
"""Evaluate threshold sensitivity on top of a multi-asset matrix report."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "threshold_sensitivity.v1"
DEFAULT_MATRIX_REPORT = (
    "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
)
DEFAULT_OUTPUT = (
    "data/research/strategy/analysis/g3g4/latest_threshold_sensitivity.v1.json"
)
DEFAULT_MARKDOWN = (
    "data/research/strategy/analysis/g3g4/latest_threshold_sensitivity.md"
)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Compute pass/block rates under multiple threshold scenarios."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--matrix-report",
        default=DEFAULT_MATRIX_REPORT,
        help="Path to multi-asset matrix report.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output JSON path.",
    )
    parser.add_argument(
        "--markdown",
        default=DEFAULT_MARKDOWN,
        help="Output markdown path.",
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


def round_rate(numerator: int, denominator: int) -> Optional[float]:
    if denominator <= 0:
        return None
    return round(numerator / denominator, 6)


def scenario_definitions() -> List[Dict[str, Any]]:
    base = {
        "meanPboMax": 0.2,
        "meanDsrProbabilityMin": 0.5,
    }
    return [
        {
            "scenarioId": "prod_frozen",
            "description": "Production frozen thresholds.",
            "thresholds": {**base, "fdrQMax": 0.1},
        },
        {
            "scenarioId": "research_fdr_12",
            "description": "Research-only FDR sensitivity at 0.12.",
            "thresholds": {**base, "fdrQMax": 0.12},
        },
        {
            "scenarioId": "research_fdr_15",
            "description": "Research-only FDR sensitivity at 0.15.",
            "thresholds": {**base, "fdrQMax": 0.15},
        },
        {
            "scenarioId": "research_fdr_20",
            "description": "Research-only FDR sensitivity at 0.20.",
            "thresholds": {**base, "fdrQMax": 0.2},
        },
    ]


def evaluate_scenario(
    assets: Sequence[Dict[str, Any]],
    thresholds: Dict[str, float],
) -> Dict[str, Any]:
    eligible: List[Dict[str, Any]] = []
    for row in assets:
        if row.get("status") != "completed":
            continue
        if to_float(row.get("fdrQ")) is None:
            continue
        if to_float(row.get("meanPbo")) is None:
            continue
        if to_float(row.get("meanDsrProbability")) is None:
            continue
        eligible.append(row)

    pass_count = 0
    fdr_block_count = 0
    pbo_block_count = 0
    dsr_block_count = 0
    wfo_block_count = 0
    for row in eligible:
        fdr_q = float(row["fdrQ"])
        mean_pbo = float(row["meanPbo"])
        mean_dsr = float(row["meanDsrProbability"])
        failed_checks = row.get("failedChecks", [])
        if not isinstance(failed_checks, list):
            failed_checks = []

        fdr_ok = fdr_q <= thresholds["fdrQMax"]
        pbo_ok = mean_pbo <= thresholds["meanPboMax"]
        dsr_ok = mean_dsr >= thresholds["meanDsrProbabilityMin"]
        if not fdr_ok:
            fdr_block_count += 1
        if not pbo_ok:
            pbo_block_count += 1
        if not dsr_ok:
            dsr_block_count += 1
        if any(str(item).strip().lower() == "wfo" for item in failed_checks):
            wfo_block_count += 1
        if fdr_ok and pbo_ok and dsr_ok:
            pass_count += 1

    total = len(eligible)
    return {
        "eligibleAssetCount": total,
        "jointPassCount": pass_count,
        "jointPassRate": round_rate(pass_count, total),
        "fdrBlockRate": round_rate(fdr_block_count, total),
        "pboBlockRate": round_rate(pbo_block_count, total),
        "dsrBlockRate": round_rate(dsr_block_count, total),
        "wfoBlockRate": round_rate(wfo_block_count, total),
    }


def build_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Threshold Sensitivity")
    lines.append("")
    lines.append(f"- Generated at: `{report.get('generatedAt')}`")
    lines.append(f"- Source matrix: `{report.get('source', {}).get('matrixReport')}`")
    lines.append("")
    lines.append("| scenario | fdrQMax | jointPassRate | fdrBlockRate | wfoBlockRate | deltaVsProd |")
    lines.append("| --- | ---: | ---: | ---: | ---: | ---: |")
    for row in report.get("scenarios", []):
        thresholds = row.get("thresholds", {})
        delta = row.get("deltaVsProd", {})
        lines.append(
            "| {scenario} | {fdr_q_max} | {joint} | {fdr_block} | {wfo_block} | {delta_joint} |".format(
                scenario=row.get("scenarioId"),
                fdr_q_max=thresholds.get("fdrQMax"),
                joint=row.get("metrics", {}).get("jointPassRate"),
                fdr_block=row.get("metrics", {}).get("fdrBlockRate"),
                wfo_block=row.get("metrics", {}).get("wfoBlockRate"),
                delta_joint=delta.get("jointPassRate"),
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
    matrix_path = resolve_path(repo_root, str(args.matrix_report))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    if not matrix_path.exists():
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"matrix report missing: {matrix_path}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    matrix_payload = read_json_object(matrix_path)
    assets = matrix_payload.get("assets", [])
    if not isinstance(assets, list):
        assets = []

    scenarios = scenario_definitions()
    scenario_rows: List[Dict[str, Any]] = []
    for scenario in scenarios:
        metrics = evaluate_scenario(
            assets=assets,
            thresholds={
                "fdrQMax": float(scenario["thresholds"]["fdrQMax"]),
                "meanPboMax": float(scenario["thresholds"]["meanPboMax"]),
                "meanDsrProbabilityMin": float(
                    scenario["thresholds"]["meanDsrProbabilityMin"]
                ),
            },
        )
        scenario_rows.append(
            {
                "scenarioId": scenario["scenarioId"],
                "description": scenario["description"],
                "thresholds": scenario["thresholds"],
                "metrics": metrics,
            }
        )

    prod_metrics = (
        scenario_rows[0].get("metrics", {})
        if scenario_rows
        else {}
    )
    prod_joint = to_float(prod_metrics.get("jointPassRate"))
    prod_fdr_block = to_float(prod_metrics.get("fdrBlockRate"))
    for row in scenario_rows:
        metrics = row.get("metrics", {})
        joint = to_float(metrics.get("jointPassRate"))
        fdr_block = to_float(metrics.get("fdrBlockRate"))
        row["deltaVsProd"] = {
            "jointPassRate": (
                round(joint - prod_joint, 6)
                if joint is not None and prod_joint is not None
                else None
            ),
            "fdrBlockRate": (
                round(fdr_block - prod_fdr_block, 6)
                if fdr_block is not None and prod_fdr_block is not None
                else None
            ),
        }

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "source": {
            "matrixReport": str(matrix_path),
            "matrixRunId": matrix_payload.get("runId"),
        },
        "scenarios": scenario_rows,
    }
    write_json(output_path, report)
    write_markdown(markdown_path, build_markdown(report))
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "scenarioCount": len(scenario_rows),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

