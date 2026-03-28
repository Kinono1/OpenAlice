#!/usr/bin/env python3
"""Compare BH baseline vs selective-inference prototype on Stage-C candidate sets."""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_CANDIDATES = "docs/research/stage_c_strategy_candidates.v1.json"
DEFAULT_BASELINE_VERDICT = "decision_packet/experiment_verdict.v2.json"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/selective_inference_v1_comparison.json"
DEFAULT_DOC_OUTPUT = "docs/research/selective_inference_v1_ab_20260311.md"

ASSET_DATASETS = {
    "BTC": {"symbol": "BTC/USD", "inputCsv": "data/market/okx/BTC_USDT_USDT_1h.csv"},
    "ETH": {"symbol": "ETH/USD", "inputCsv": "data/market/okx/ETH_USDT_USDT_1h.csv"},
    "SOL": {"symbol": "SOL/USD", "inputCsv": "data/market/okx/SOL_USDT_USDT_1h.csv"},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Compare BH baseline vs selective-inference on Stage-C candidates.")
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--candidates", default=DEFAULT_CANDIDATES, help="Candidate file to evaluate.")
    parser.add_argument("--baseline-verdict", default=DEFAULT_BASELINE_VERDICT, help="Baseline verdict for FDR config inheritance.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="JSON comparison output path.")
    parser.add_argument("--doc-output", default=DEFAULT_DOC_OUTPUT, help="Markdown summary output path.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw).expanduser()
    return path if path.is_absolute() else (root / path).resolve()


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


def metric(payload: Dict[str, Any], key: str) -> float:
    aggregate = payload.get("aggregateMetrics", {})
    value = aggregate.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"Missing numeric aggregateMetrics.{key}")
    return float(value)


def prepare_candidates(base_candidates: Dict[str, Any], asset: str) -> Dict[str, Any]:
    dataset = ASSET_DATASETS[asset]
    payload = copy.deepcopy(base_candidates)
    payload["dataset"] = {
        **payload.get("dataset", {}),
        "inputCsv": dataset["inputCsv"],
        "symbol": dataset["symbol"],
    }
    return payload


def run_validation(
    root: Path,
    candidates_payload: Dict[str, Any],
    baseline_verdict: Dict[str, Any],
    asset: str,
) -> tuple[Dict[str, Any], Dict[str, Any], subprocess.CompletedProcess[str]]:
    baseline_aggregate = baseline_verdict.get("aggregateMetrics", {})
    diagnostics = baseline_aggregate.get("fdrDiagnostics", {})
    method = str(baseline_aggregate.get("fdrMethod") or "bh")

    with tempfile.TemporaryDirectory(prefix=f"openalice-selective-{asset.lower()}-") as tmp:
        tmp_dir = Path(tmp)
        candidates_path = tmp_dir / "candidates.json"
        runs_path = tmp_dir / "strategy_validation_runs.json"
        verdict_path = tmp_dir / "experiment_verdict.v2.json"
        release_gate_status = tmp_dir / "release_gate_status.json"
        selective_path = tmp_dir / "selective_inference.v1.json"
        write_json(candidates_path, candidates_payload)

        cmd = [
            "node",
            "--import",
            "tsx",
            "scripts/run_strategy_mvp_validation.ts",
            "--candidates",
            str(candidates_path),
            "--output",
            str(runs_path),
            "--verdict-output",
            str(verdict_path),
            "--release-gate-status-path",
            str(release_gate_status),
            "--fdr-method",
            method,
        ]
        cv_agg = diagnostics.get("cvAggQuantile")
        if cv_agg is not None:
            cmd.extend(["--cv-agg-quantile", str(cv_agg)])
        storey_lambda = diagnostics.get("storeyLambda") or diagnostics.get("lambda")
        if storey_lambda is not None:
            cmd.extend(["--fdr-storey-lambda", str(storey_lambda)])

        proc = subprocess.run(cmd, cwd=str(root), text=True, capture_output=True, check=False)
        if proc.returncode not in (0, 2):
            raise RuntimeError(f"Validation failed for {asset}\nstdout:\n{proc.stdout}\n\nstderr:\n{proc.stderr}")

        selective_cmd = [
            sys.executable,
            "scripts/selective_inference.py",
            "--runs",
            str(runs_path),
            "--output",
            str(selective_path),
            "--alpha",
            str(candidates_payload.get("thresholds", {}).get("fdrQMax", 0.1)),
        ]
        selective_proc = subprocess.run(selective_cmd, cwd=str(root), text=True, capture_output=True, check=False)
        if selective_proc.returncode != 0:
            raise RuntimeError(
                f"Selective inference failed for {asset}\nstdout:\n{selective_proc.stdout}\n\nstderr:\n{selective_proc.stderr}"
            )

        verdict = read_json(verdict_path)
        selective = read_json(selective_path)
        selective["_stdout"] = selective_proc.stdout[-2000:]
        return verdict, selective, proc


def summarize_asset(
    asset: str,
    verdict: Dict[str, Any],
    selective: Dict[str, Any],
    proc: subprocess.CompletedProcess[str],
) -> Dict[str, Any]:
    bh_fdr = metric(verdict, "fdrQ")
    bh_mean_pbo = metric(verdict, "meanPbo")
    bh_mean_dsr = metric(verdict, "meanDsrProbability")
    champion = selective.get("champion", {})
    selective_q = float(champion.get("effectiveQ", 1.0))
    selective_pass = bool(champion.get("passed", False))
    return {
        "asset": asset,
        "symbol": ASSET_DATASETS[asset]["symbol"],
        "bh": {
            "result": verdict.get("result"),
            "meanPbo": bh_mean_pbo,
            "meanDsrProbability": bh_mean_dsr,
            "fdrQ": bh_fdr,
            "reasonCodes": verdict.get("reasonCodes", []),
        },
        "selectiveInference": {
            "method": selective.get("method"),
            "rejectCount": selective.get("rejectCount"),
            "championStrategyId": champion.get("strategyId"),
            "championEffectiveQ": selective_q,
            "championPValue": champion.get("pValue"),
            "championPassed": selective_pass,
        },
        "deltaSelectiveVsBh": {
            "effectiveQMinusBhFdrQ": selective_q - bh_fdr,
        },
        "runnerExitCode": proc.returncode,
        "stdoutTail": (proc.stdout or "")[-1500:],
        "stderrTail": (proc.stderr or "")[-1500:],
    }


def write_doc(path: Path, payload: Dict[str, Any]) -> None:
    lines: List[str] = []
    lines.append("# Selective-Inference V1 A/B")
    lines.append("")
    lines.append(f"Date: `{payload['generatedAt']}`")
    lines.append("")
    lines.append("## Scope")
    lines.append("")
    lines.append("- candidate set: `docs/research/stage_c_strategy_candidates.v1.json`")
    lines.append("- assets: `BTC`, `ETH`, `SOL`")
    lines.append("- baseline: current `BH / existing FDR path`")
    lines.append("- prototype: `e_bh_prototype`")
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append(f"- completed assets: `{payload['summary']['completedAssets']}`")
    lines.append(f"- assets where selective improved over BH: `{payload['summary']['assetsWhereSelectiveImproved']}`")
    lines.append(f"- assets where selective produced a pass: `{payload['summary']['assetsWhereSelectivePassed']}`")
    lines.append(f"- keep Workstream B: `{payload['summary']['keepWorkstreamB']}`")
    lines.append("")
    lines.append("## Per-Asset Snapshot")
    lines.append("")
    lines.append("| asset | BH fdrQ | selective effectiveQ | improved vs BH | selective pass |")
    lines.append("| --- | ---: | ---: | --- | --- |")
    for item in payload["assets"]:
        improved = item["deltaSelectiveVsBh"]["effectiveQMinusBhFdrQ"] < 0
        lines.append(
            f"| {item['asset']} | `{item['bh']['fdrQ']:.4f}` | `{item['selectiveInference']['championEffectiveQ']:.4f}` | "
            f"`{'yes' if improved else 'no'}` | `{'yes' if item['selectiveInference']['championPassed'] else 'no'}` |"
        )
    lines.append("")
    lines.append("## Interpretation")
    lines.append("")
    if payload["summary"]["assetsWhereSelectiveImproved"] > 0:
        lines.append(
            "Selective-inference shows at least some method-level value on the same weak candidate pool. "
            "That is not enough to rescue Workstream A, but it is enough to keep Workstream B active in parallel."
        )
    else:
        lines.append(
            "Selective-inference did not improve the same weak candidate pool in any decision-relevant way. "
            "Workstream B should be kept only as a lower-priority sidecar until the signal layer improves."
        )
    lines.append("")
    lines.append("## Decision")
    lines.append("")
    lines.append(f"- keep_workstream_b: `{'yes' if payload['summary']['keepWorkstreamB'] else 'no'}`")
    lines.append(
        "- note: this prototype does not override the BH verdict and does not by itself justify moving toward G3 release."
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    candidates_path = resolve_path(root, args.candidates)
    baseline_verdict_path = resolve_path(root, args.baseline_verdict)
    output_path = resolve_path(root, args.output)
    doc_output_path = resolve_path(root, args.doc_output)

    candidates_payload = read_json(candidates_path)
    baseline_verdict = read_json(baseline_verdict_path)
    assets: List[Dict[str, Any]] = []
    for asset in ("BTC", "ETH", "SOL"):
        verdict, selective, proc = run_validation(root, prepare_candidates(candidates_payload, asset), baseline_verdict, asset)
        assets.append(summarize_asset(asset, verdict, selective, proc))

    summary = {
        "completedAssets": len(assets),
        "assetsWhereSelectiveImproved": sum(
            1 for item in assets if item["deltaSelectiveVsBh"]["effectiveQMinusBhFdrQ"] < 0
        ),
        "assetsWhereSelectivePassed": sum(1 for item in assets if item["selectiveInference"]["championPassed"]),
    }
    summary["keepWorkstreamB"] = summary["assetsWhereSelectiveImproved"] > 0 or summary["assetsWhereSelectivePassed"] > 0
    payload = {
        "schemaVersion": "selective_inference_compare.v1",
        "generatedAt": utc_iso(),
        "candidateSet": str(candidates_path),
        "baselineVerdict": str(baseline_verdict_path),
        "assets": assets,
        "summary": summary,
    }
    write_json(output_path, payload)
    write_doc(doc_output_path, payload)
    print(json.dumps({"output": str(output_path), "summary": summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
