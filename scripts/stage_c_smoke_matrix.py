#!/usr/bin/env python3
"""Run a Stage-C smoke matrix across BTC/ETH/SOL using the existing strategy MVP validator."""

from __future__ import annotations

import argparse
import copy
import json
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List


DEFAULT_CANDIDATES = "docs/research/stage_c_strategy_candidates.v1.json"
DEFAULT_BASELINE_VERDICT = "decision_packet/experiment_verdict.v2.json"
DEFAULT_OUTPUT = "data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json"
DEFAULT_COMPARE_SMOKE = "data/research/strategy/analysis/stage_c/sprint1_smoke_matrix.json"
DEFAULT_ASSETS = "BTC,ETH,SOL"

ASSET_DATASETS = {
    "BTC": {
        "symbol": "BTC/USD",
        "inputCsv": "data/market/okx/BTC_USDT_USDT_1h.csv",
    },
    "ETH": {
        "symbol": "ETH/USD",
        "inputCsv": "data/market/okx/ETH_USDT_USDT_1h.csv",
    },
    "SOL": {
        "symbol": "SOL/USD",
        "inputCsv": "data/market/okx/SOL_USDT_USDT_1h.csv",
    },
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a Stage-C BTC/ETH/SOL smoke matrix."
    )
    parser.add_argument("--repo-root", default="", help="Repository root (default: parent of this script).")
    parser.add_argument("--candidates", default=DEFAULT_CANDIDATES, help="Stage-C candidate file.")
    parser.add_argument(
        "--baseline-verdict",
        default=DEFAULT_BASELINE_VERDICT,
        help="Baseline experiment verdict for delta comparison.",
    )
    parser.add_argument(
        "--compare-smoke",
        default="",
        help="Optional prior Stage-C smoke matrix used for delta-vs-previous comparison.",
    )
    parser.add_argument(
        "--sprint-label",
        default="",
        help="Optional label embedded into output metadata (for example sprint2-v2-bh).",
    )
    parser.add_argument("--fdr-method", default="", help="Optional FDR method override.")
    parser.add_argument("--assets", default=DEFAULT_ASSETS, help="Comma-separated assets from BTC,ETH,SOL.")
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Smoke matrix JSON output.")
    return parser.parse_args()


def repo_root(raw: str) -> Path:
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, raw: str) -> Path:
    value = Path(raw).expanduser()
    return value if value.is_absolute() else (root / value).resolve()


def read_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def metric(payload: Dict[str, Any], key: str) -> float:
    aggregate = payload.get("aggregateMetrics", {})
    value = aggregate.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"Missing numeric aggregateMetrics.{key}")
    return float(value)


def run_asset(
    root: Path,
    base_candidates: Dict[str, Any],
    asset: str,
    baseline_verdict: Dict[str, Any],
    previous_asset: Dict[str, Any] | None,
    fdr_method_override: str = "",
) -> Dict[str, Any]:
    dataset = ASSET_DATASETS[asset]
    payload = copy.deepcopy(base_candidates)
    payload["dataset"] = {
        **payload.get("dataset", {}),
        "inputCsv": dataset["inputCsv"],
        "symbol": dataset["symbol"],
    }
    baseline_aggregate = baseline_verdict.get("aggregateMetrics", {})
    baseline_fdr_diagnostics = baseline_aggregate.get("fdrDiagnostics", {})
    baseline_fdr_method = str(baseline_aggregate.get("fdrMethod") or "bh")
    effective_fdr_method = fdr_method_override.strip() or baseline_fdr_method

    with tempfile.TemporaryDirectory(prefix=f"openalice-stagec-{asset.lower()}-") as tmp:
        tmp_dir = Path(tmp)
        candidates_path = tmp_dir / "strategy_candidates.v1.json"
        verdict_path = tmp_dir / "experiment_verdict.v2.json"
        release_gate_path = tmp_dir / "release_gate_status.json"
        runs_path = tmp_dir / "strategy_validation_runs.json"
        write_json(candidates_path, payload)

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
            str(release_gate_path),
            "--fdr-method",
            effective_fdr_method,
        ]
        cv_agg = baseline_fdr_diagnostics.get("cvAggQuantile")
        if cv_agg is not None:
            cmd.extend(["--cv-agg-quantile", str(cv_agg)])
        storey_lambda = baseline_fdr_diagnostics.get("storeyLambda") or baseline_fdr_diagnostics.get("lambda")
        if storey_lambda is not None:
            cmd.extend(["--fdr-storey-lambda", str(storey_lambda)])
        proc = subprocess.run(
            cmd,
            cwd=str(root),
            text=True,
            capture_output=True,
            check=False,
        )
        verdict = read_json(verdict_path)

    current_metrics = {
        "meanPbo": metric(verdict, "meanPbo"),
        "meanDsrProbability": metric(verdict, "meanDsrProbability"),
        "fdrQ": metric(verdict, "fdrQ"),
    }
    output = {
        "asset": asset,
        "symbol": dataset["symbol"],
        "inputCsv": dataset["inputCsv"],
        "result": verdict.get("result"),
        "reasonCodes": verdict.get("reasonCodes", []),
        "metrics": current_metrics,
        "deltaVsFrozenBaseline": {
            "meanPbo": current_metrics["meanPbo"] - metric(baseline_verdict, "meanPbo"),
            "meanDsrProbability": current_metrics["meanDsrProbability"] - metric(baseline_verdict, "meanDsrProbability"),
            "fdrQ": current_metrics["fdrQ"] - metric(baseline_verdict, "fdrQ"),
        },
        "runnerExitCode": proc.returncode,
        "fdrMethod": effective_fdr_method,
        "stdoutTail": (proc.stdout or "")[-2000:],
        "stderrTail": (proc.stderr or "")[-2000:],
    }
    if previous_asset:
        previous_metrics = previous_asset.get("metrics", {})
        if all(isinstance(previous_metrics.get(key), (int, float)) for key in ("meanPbo", "meanDsrProbability", "fdrQ")):
            output["deltaVsPreviousSmoke"] = {
                "meanPbo": current_metrics["meanPbo"] - float(previous_metrics["meanPbo"]),
                "meanDsrProbability": current_metrics["meanDsrProbability"] - float(previous_metrics["meanDsrProbability"]),
                "fdrQ": current_metrics["fdrQ"] - float(previous_metrics["fdrQ"]),
            }
    return output


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    candidates_path = resolve_path(root, args.candidates)
    baseline_path = resolve_path(root, args.baseline_verdict)
    output_path = resolve_path(root, args.output)
    compare_smoke_path = resolve_path(root, args.compare_smoke) if args.compare_smoke.strip() else None

    candidates_payload = read_json(candidates_path)
    baseline_payload = read_json(baseline_path)
    previous_assets: Dict[str, Dict[str, Any]] = {}
    if compare_smoke_path and compare_smoke_path.exists():
        compare_payload = read_json(compare_smoke_path)
        previous_assets = {
            str(item.get("asset")): item
            for item in compare_payload.get("assets", [])
            if isinstance(item, dict) and item.get("asset")
        }

    assets_to_run = [asset.strip() for asset in args.assets.split(",") if asset.strip()]
    assets = [
        run_asset(
            root,
            candidates_payload,
            asset,
            baseline_payload,
            previous_assets.get(asset),
            fdr_method_override=args.fdr_method,
        )
        for asset in assets_to_run
    ]
    summary = {
        "completedAssets": len(assets),
        "assetsWithFdrBelowPointFive": sum(
            1 for asset in assets if asset["metrics"]["fdrQ"] < 0.5
        ),
        "assetsWithMeanPboBelowPointThree": sum(
            1 for asset in assets if asset["metrics"]["meanPbo"] < 0.3
        ),
        "assetsWithPboImprovementVsFrozenBaseline": sum(
            1 for asset in assets if asset["deltaVsFrozenBaseline"]["meanPbo"] < 0
        ),
        "assetsWithDsrImprovementVsFrozenBaseline": sum(
            1 for asset in assets if asset["deltaVsFrozenBaseline"]["meanDsrProbability"] > 0
        ),
        "assetsWithFdrImprovementVsFrozenBaseline": sum(
            1 for asset in assets if asset["deltaVsFrozenBaseline"]["fdrQ"] < 0
        ),
    }
    if previous_assets:
        summary["assetsWithPboImprovementVsPreviousSmoke"] = sum(
            1
            for asset in assets
            if asset.get("deltaVsPreviousSmoke", {}).get("meanPbo", 0) < 0
        )
        summary["assetsWithDsrImprovementVsPreviousSmoke"] = sum(
            1
            for asset in assets
            if asset.get("deltaVsPreviousSmoke", {}).get("meanDsrProbability", 0) > 0
        )
        summary["assetsWithFdrImprovementVsPreviousSmoke"] = sum(
            1
            for asset in assets
            if asset.get("deltaVsPreviousSmoke", {}).get("fdrQ", 0) < 0
        )
    payload = {
        "schemaVersion": "stage_c_smoke_matrix.v1",
        "generatedAt": utc_iso(),
        "sprintLabel": args.sprint_label.strip() or None,
        "candidates": str(candidates_path),
        "baselineVerdict": str(baseline_path),
        "compareSmoke": str(compare_smoke_path) if compare_smoke_path else None,
        "fdrMethod": args.fdr_method.strip() or str(baseline_payload.get("aggregateMetrics", {}).get("fdrMethod") or "bh"),
        "assets": assets,
        "summary": summary,
    }
    write_json(output_path, payload)
    print(
        json.dumps(
            {
                "output": str(output_path),
                "summary": summary,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
