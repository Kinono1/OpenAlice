#!/usr/bin/env python3
"""Thin Stage-C wrapper around the existing strategy MVP validation pipeline."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict


SCHEMA_VERSION = "stage_c_eval_harness.v1"
DEFAULT_CANDIDATES = "docs/research/strategy_candidates.v1.json"
DEFAULT_BASELINE_VERDICT = "decision_packet/experiment_verdict.v2.json"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/latest_eval_harness.v1.json"
DEFAULT_ARCHIVE_DIR = "data/research/strategy/analysis/stage_c/archive"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run Stage-C evaluation through the current strategy MVP validation chain."
    )
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--candidates", default=DEFAULT_CANDIDATES, help="Path to strategy_candidates.v1 JSON.")
    parser.add_argument(
        "--baseline-verdict",
        default=DEFAULT_BASELINE_VERDICT,
        help="Baseline experiment verdict used for delta comparison.",
    )
    parser.add_argument("--run-id", default="", help="Optional run id.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Latest harness summary path.")
    parser.add_argument("--archive-dir", default=DEFAULT_ARCHIVE_DIR, help="Archive directory root.")
    parser.add_argument("--fdr-method", default="", help="Optional FDR method override.")
    parser.add_argument("--cv-agg-quantile", default="", help="Optional cv_storey_bh quantile override.")
    parser.add_argument("--fdr-storey-lambda", default="", help="Optional storey lambda override.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    value = Path(raw).expanduser()
    return value if value.is_absolute() else (root / value).resolve()


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def default_run_id() -> str:
    return "stagec-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def read_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def metric(payload: Dict[str, Any], key: str) -> float:
    aggregate = payload.get("aggregateMetrics", {})
    value = aggregate.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"Missing numeric aggregateMetrics.{key}")
    return float(value)


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    candidates_path = resolve_path(root, args.candidates)
    baseline_verdict_path = resolve_path(root, args.baseline_verdict)
    latest_output_path = resolve_path(root, args.output)
    archive_root = resolve_path(root, args.archive_dir)
    run_id = args.run_id.strip() or default_run_id()
    run_dir = archive_root / run_id
    baseline_payload = read_json(baseline_verdict_path)
    baseline_aggregate = baseline_payload.get("aggregateMetrics", {})
    baseline_fdr_diagnostics = baseline_aggregate.get("fdrDiagnostics", {})
    baseline_fdr_method = str(baseline_aggregate.get("fdrMethod") or "bh")

    validation_runs_path = run_dir / "strategy_validation_runs.json"
    experiment_verdict_path = run_dir / "experiment_verdict.v2.json"
    release_gate_status_path = run_dir / "release_gate_status.json"
    archived_summary_path = run_dir / "stage_c_eval_harness.v1.json"

    cmd = [
        "node",
        "--import",
        "tsx",
        "scripts/run_strategy_mvp_validation.ts",
        "--candidates",
        str(candidates_path),
        "--output",
        str(validation_runs_path),
        "--verdict-output",
        str(experiment_verdict_path),
        "--release-gate-status-path",
        str(release_gate_status_path),
    ]
    effective_fdr_method = args.fdr_method.strip() or baseline_fdr_method
    if effective_fdr_method:
        cmd.extend(["--fdr-method", effective_fdr_method])

    effective_cv_agg_quantile = (
        args.cv_agg_quantile.strip()
        or str(baseline_fdr_diagnostics.get("cvAggQuantile") or "")
    )
    if effective_cv_agg_quantile:
        cmd.extend(["--cv-agg-quantile", effective_cv_agg_quantile])

    effective_storey_lambda = (
        args.fdr_storey_lambda.strip()
        or str(
            baseline_fdr_diagnostics.get("storeyLambda")
            or baseline_fdr_diagnostics.get("lambda")
            or ""
        )
    )
    if effective_storey_lambda:
        cmd.extend(["--fdr-storey-lambda", effective_storey_lambda])

    run = subprocess.run(
        cmd,
        cwd=str(root),
        text=True,
        capture_output=True,
        check=False,
    )

    if run.returncode not in (0, 2):
        raise RuntimeError(
            "stage_c_eval_harness failed to run strategy MVP validation\n"
            f"stdout:\n{run.stdout}\n\nstderr:\n{run.stderr}"
        )

    verdict_payload = read_json(experiment_verdict_path)

    current_mean_pbo = metric(verdict_payload, "meanPbo")
    current_mean_dsr = metric(verdict_payload, "meanDsrProbability")
    current_fdr_q = metric(verdict_payload, "fdrQ")

    baseline_mean_pbo = metric(baseline_payload, "meanPbo")
    baseline_mean_dsr = metric(baseline_payload, "meanDsrProbability")
    baseline_fdr_q = metric(baseline_payload, "fdrQ")

    summary = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": utc_iso(),
        "runId": run_id,
        "inputs": {
            "candidates": str(candidates_path),
            "baselineVerdict": str(baseline_verdict_path),
        },
        "artifacts": {
            "validationRuns": str(validation_runs_path),
            "experimentVerdict": str(experiment_verdict_path),
            "releaseGateStatus": str(release_gate_status_path),
        },
        "aggregateMetrics": {
            "meanPbo": current_mean_pbo,
            "meanDsrProbability": current_mean_dsr,
            "fdrQ": current_fdr_q,
            "result": verdict_payload.get("result"),
            "reasonCodes": verdict_payload.get("reasonCodes", []),
        },
        "baselineMetrics": {
            "meanPbo": baseline_mean_pbo,
            "meanDsrProbability": baseline_mean_dsr,
            "fdrQ": baseline_fdr_q,
            "result": baseline_payload.get("result"),
        },
        "delta": {
            "meanPbo": current_mean_pbo - baseline_mean_pbo,
            "meanDsrProbability": current_mean_dsr - baseline_mean_dsr,
            "fdrQ": current_fdr_q - baseline_fdr_q,
        },
        "improvement": {
            "meanPboImproved": current_mean_pbo < baseline_mean_pbo,
            "meanDsrProbabilityImproved": current_mean_dsr > baseline_mean_dsr,
            "fdrQImproved": current_fdr_q < baseline_fdr_q,
        },
        "command": cmd,
        "runnerExitCode": run.returncode,
        "effectiveFdrConfig": {
            "fdrMethod": effective_fdr_method,
            "cvAggQuantile": effective_cv_agg_quantile or None,
            "fdrStoreyLambda": effective_storey_lambda or None,
        },
    }

    write_json(archived_summary_path, summary)
    copy_file(archived_summary_path, latest_output_path)

    print(
        json.dumps(
            {
                "runId": run_id,
                "output": str(latest_output_path),
                "result": summary["aggregateMetrics"]["result"],
                "delta": summary["delta"],
            },
            ensure_ascii=False,
        )
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
