#!/usr/bin/env python3
"""Run the full Round 4 mapping comparison using the existing Stage-C pipeline."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


DEFAULT_BASELINE_VERDICT = "decision_packet/experiment_verdict.v2.json"
DEFAULT_FEATURE_ROOT = "data/research/strategy/analysis/stage_c/target_tables"
DEFAULT_SUMMARY_OUTPUT = "data/research/strategy/analysis/stage_c/round4/latest_round4_summary.v1.json"
DEFAULT_MEMO_OUTPUT = "chatgpt/round4_mapping_decision_latest.md"

MAPPINGS = ("no_trade", "breakout", "trend")
MAPPING_VARIANTS = {
    "no_trade": "vol_as_no_trade_filter",
    "breakout": "vol_as_breakout_enable_flag",
    "trend": "vol_as_trend_enable_flag",
}


@dataclass
class MappingArtifacts:
    mapping: str
    variant: str
    candidates: Path
    smoke: Path
    eval_latest: Path
    eval_archive_dir: Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run the Stage-C Round 4 mapping comparison."
    )
    parser.add_argument("--repo-root", default="", help="Repository root.")
    parser.add_argument("--baseline-verdict", default=DEFAULT_BASELINE_VERDICT, help="Frozen baseline verdict.")
    parser.add_argument("--feature-root", default=DEFAULT_FEATURE_ROOT, help="Round 4 target tables root.")
    parser.add_argument("--mappings", default=",".join(MAPPINGS), help="Comma-separated mapping keys.")
    parser.add_argument("--summary-output", default=DEFAULT_SUMMARY_OUTPUT, help="Machine-readable summary path.")
    parser.add_argument("--memo-output", default=DEFAULT_MEMO_OUTPUT, help="Decision memo path.")
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


def split_mappings(raw: str) -> List[str]:
    items = [item.strip() for item in raw.split(",") if item.strip()]
    invalid = [item for item in items if item not in MAPPINGS]
    if invalid:
        raise ValueError(f"Unsupported mappings: {', '.join(invalid)}")
    if not items:
        raise ValueError("At least one mapping must be provided.")
    return items


def read_json(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def artifacts_for_mapping(root: Path, mapping: str) -> MappingArtifacts:
    slug = {
        "no_trade": "no_trade_filter",
        "breakout": "breakout_enable_flag",
        "trend": "trend_enable_flag",
    }[mapping]
    round4_root = root / "data" / "research" / "strategy" / "analysis" / "stage_c" / "round4"
    return MappingArtifacts(
        mapping=mapping,
        variant=MAPPING_VARIANTS[mapping],
        candidates=root / "docs" / "research" / f"stage_c_round4_candidates.{slug}.v1.json",
        smoke=round4_root / f"{mapping}.smoke_matrix.v1.json",
        eval_latest=round4_root / f"{mapping}.eval_harness.v1.json",
        eval_archive_dir=round4_root / "archive" / mapping,
    )


def run_command(label: str, cmd: List[str], cwd: Path) -> subprocess.CompletedProcess[str]:
    run = subprocess.run(
        cmd,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )
    if run.returncode != 0:
        raise RuntimeError(
            f"{label} failed with exit code {run.returncode}\n"
            f"stdout:\n{run.stdout}\n\nstderr:\n{run.stderr}"
        )
    return run


def compute_mapping_score(smoke_payload: Dict[str, Any], eval_payload: Dict[str, Any]) -> Dict[str, Any]:
    smoke_summary = smoke_payload.get("summary", {})
    delta = eval_payload.get("delta", {})
    score = (
        3 * int(smoke_summary.get("assetsWithFdrBelowPointFive", 0))
        + 2 * int(smoke_summary.get("assetsWithFdrImprovementVsFrozenBaseline", 0))
        + int(smoke_summary.get("assetsWithPboImprovementVsFrozenBaseline", 0))
        + int(smoke_summary.get("assetsWithDsrImprovementVsFrozenBaseline", 0))
        + 2 * int(float(delta.get("fdrQ", 0.0)) < 0)
        + int(float(delta.get("meanPbo", 0.0)) < 0)
        + int(float(delta.get("meanDsrProbability", 0.0)) > 0)
    )
    kill_like = (
        int(smoke_summary.get("assetsWithFdrImprovementVsFrozenBaseline", 0)) == 0
        and int(smoke_summary.get("assetsWithPboImprovementVsFrozenBaseline", 0)) == 0
        and int(smoke_summary.get("assetsWithDsrImprovementVsFrozenBaseline", 0)) == 0
        and float(delta.get("fdrQ", 0.0)) >= 0
        and float(delta.get("meanPbo", 0.0)) >= 0
        and float(delta.get("meanDsrProbability", 0.0)) <= 0
    )
    promotable = (
        int(smoke_summary.get("assetsWithFdrBelowPointFive", 0)) > 0
        or int(smoke_summary.get("assetsWithFdrImprovementVsFrozenBaseline", 0)) > 0
        or float(delta.get("fdrQ", 0.0)) < 0
    )
    return {
        "score": score,
        "killLike": kill_like,
        "promotable": promotable,
    }


def decide_round4(mapping_results: List[Dict[str, Any]]) -> Dict[str, Any]:
    ordered = sorted(mapping_results, key=lambda item: item["score"]["score"], reverse=True)
    if ordered and all(item["score"]["killLike"] for item in ordered):
        return {
            "decision": "kill_all_mappings",
            "selectedMapping": None,
            "reason": "All mappings failed the Round 4 kill screen with no credible smoke or harness improvement.",
        }

    if ordered:
        best = ordered[0]
        second_score = ordered[1]["score"]["score"] if len(ordered) > 1 else -1
        if best["score"]["promotable"] and best["score"]["score"] > second_score:
            return {
                "decision": "promote_mapping",
                "selectedMapping": best["mapping"],
                "reason": f"{best['variant']} produced the strongest unique improvement signal across smoke and harness outputs.",
            }

    return {
        "decision": "return_to_architecture_review",
        "selectedMapping": None,
        "reason": "Round 4 produced mixed or non-unique evidence, so mapping promotion is not yet justified.",
    }


def render_decision_memo(summary: Dict[str, Any]) -> str:
    decision = summary["decision"]
    lines = [
        "# Stage-C Round 4 Mapping Decision",
        "",
        f"Generated: `{summary['generatedAt']}`",
        "",
        "## Decision",
        "",
        f"- outcome: `{decision['decision']}`",
        f"- selected mapping: `{decision['selectedMapping'] or 'none'}`",
        f"- reason: {decision['reason']}",
        "",
        "## Mapping Summary",
        "",
    ]
    for item in summary["mappings"]:
        smoke = item["smoke"]["summary"]
        eval_delta = item["eval"]["delta"]
        lines.extend(
            [
                f"### `{item['variant']}`",
                f"- score: `{item['score']['score']}`",
                f"- smoke assets with FDR improvement: `{smoke.get('assetsWithFdrImprovementVsFrozenBaseline', 0)}`",
                f"- smoke assets with PBO improvement: `{smoke.get('assetsWithPboImprovementVsFrozenBaseline', 0)}`",
                f"- smoke assets with DSR improvement: `{smoke.get('assetsWithDsrImprovementVsFrozenBaseline', 0)}`",
                f"- harness delta fdrQ: `{eval_delta.get('fdrQ')}`",
                f"- harness delta meanPbo: `{eval_delta.get('meanPbo')}`",
                f"- harness delta meanDsrProbability: `{eval_delta.get('meanDsrProbability')}`",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def execute_mapping(root: Path, baseline_verdict: Path, feature_root: Path, artifacts: MappingArtifacts) -> Dict[str, Any]:
    generator_script = root / "scripts" / "stage_c_round4_candidate_generator.py"
    smoke_script = root / "scripts" / "stage_c_smoke_matrix.py"
    eval_script = root / "scripts" / "stage_c_eval_harness.py"
    run_id = f"round4-{artifacts.mapping}-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"

    run_command(
        f"round4 generator ({artifacts.mapping})",
        [
            sys.executable,
            str(generator_script),
            "--repo-root",
            str(root),
            "--feature-root",
            str(feature_root),
            "--mapping",
            artifacts.mapping,
            "--output",
            str(artifacts.candidates),
        ],
        root,
    )
    run_command(
        f"round4 smoke ({artifacts.mapping})",
        [
            sys.executable,
            str(smoke_script),
            "--repo-root",
            str(root),
            "--candidates",
            str(artifacts.candidates),
            "--baseline-verdict",
            str(baseline_verdict),
            "--sprint-label",
            f"round4-{artifacts.mapping}",
            "--output",
            str(artifacts.smoke),
        ],
        root,
    )
    run_command(
        f"round4 eval ({artifacts.mapping})",
        [
            sys.executable,
            str(eval_script),
            "--repo-root",
            str(root),
            "--candidates",
            str(artifacts.candidates),
            "--baseline-verdict",
            str(baseline_verdict),
            "--output",
            str(artifacts.eval_latest),
            "--archive-dir",
            str(artifacts.eval_archive_dir),
            "--run-id",
            run_id,
        ],
        root,
    )

    smoke_payload = read_json(artifacts.smoke)
    eval_payload = read_json(artifacts.eval_latest)
    score = compute_mapping_score(smoke_payload, eval_payload)
    return {
        "mapping": artifacts.mapping,
        "variant": artifacts.variant,
        "artifacts": {
            "candidates": str(artifacts.candidates),
            "smoke": str(artifacts.smoke),
            "evalLatest": str(artifacts.eval_latest),
        },
        "smoke": smoke_payload,
        "eval": eval_payload,
        "score": score,
    }


def main() -> int:
    args = parse_args()
    root = repo_root(args.repo_root)
    baseline_verdict = resolve_path(root, args.baseline_verdict)
    feature_root = resolve_path(root, args.feature_root)
    summary_output = resolve_path(root, args.summary_output)
    memo_output = resolve_path(root, args.memo_output)

    mapping_results = [
        execute_mapping(root, baseline_verdict, feature_root, artifacts_for_mapping(root, mapping))
        for mapping in split_mappings(args.mappings)
    ]
    decision = decide_round4(mapping_results)
    summary = {
        "schemaVersion": "stage_c_round4_summary.v1",
        "generatedAt": utc_iso(),
        "baselineVerdict": str(baseline_verdict),
        "featureRoot": str(feature_root),
        "decision": decision,
        "mappings": mapping_results,
    }
    write_json(summary_output, summary)
    write_text(memo_output, render_decision_memo(summary))
    print(
        json.dumps(
            {
                "summaryOutput": str(summary_output),
                "memoOutput": str(memo_output),
                "decision": decision["decision"],
                "selectedMapping": decision["selectedMapping"],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
