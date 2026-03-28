#!/usr/bin/env python3
"""Run and archive one G3/G4 recovery iteration for OpenAlice strategy MVP."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Sequence


@dataclass
class CommandSpec:
    name: str
    argv: List[str]
    allowed_exit_codes: Sequence[int]


PLAN_C_PHASEB_CONFLICT_ERROR = (
    "--with-phaseb-search cannot be used with --plan C; "
    "plan C forbids candidate expansion and phase-B search."
)
LOCKED_MODE_NO_EXPAND_CONFLICT_ERROR = (
    "--no-expand-candidates cannot be combined with "
    "--with-hypothesis-candidates --hypothesis-candidate-mode lock_best_triplet; "
    "disable --no-expand-candidates or switch candidate mode."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Execute one strategy recovery iteration (G3/G4 oriented), then archive outputs."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id. Default: UTC timestamp.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy/runs",
        help="Output root for latest/archive iteration reports.",
    )
    parser.add_argument(
        "--profile",
        default="full",
        choices=["full", "fast"],
        help=(
            "full=baseline/env/freeze/preflight + strategy chain; "
            "fast=strategy chain only."
        ),
    )
    parser.add_argument(
        "--execute-chain",
        action="store_true",
        help="Execute commands. Without this flag, only produce a planned report.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Keep running subsequent commands even after one command fails.",
    )
    parser.add_argument(
        "--python-bin",
        default="python3",
        help="Python executable used for breakdown script.",
    )
    parser.add_argument(
        "--pnpm-bin",
        default="pnpm",
        help="pnpm executable to run package scripts.",
    )
    parser.add_argument(
        "--protocol-profile",
        default="shift",
        choices=["stable", "shift", "stress"],
        help="WFO protocol profile forwarded to strategy:mvp.",
    )
    parser.add_argument(
        "--fdr-method",
        default="bh",
        choices=[
            "bh",
            "by",
            "storey_bh",
            "regime_segmented_bh",
            "cv_storey_bh",
            "stability_bh",
        ],
        help="FDR method forwarded to strategy:mvp.",
    )
    parser.add_argument(
        "--regime-method",
        default="change_point",
        help=(
            "Regime detector forwarded to strategy:mvp when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-max-segments",
        type=int,
        default=4,
        help=(
            "Upper bound on regime segments forwarded to strategy:mvp when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-min-segment-bars",
        type=int,
        default=240,
        help=(
            "Minimum bars per regime segment forwarded to strategy:mvp when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-min-windows",
        type=int,
        default=2,
        help=(
            "Minimum WFO windows per regime forwarded to strategy:mvp when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--regime-aggregation",
        default="weighted_mean",
        choices=["max", "weighted_mean"],
        help=(
            "Regime p-value aggregation forwarded to strategy:mvp when "
            "--fdr-method=regime_segmented_bh."
        ),
    )
    parser.add_argument(
        "--cv-agg-quantile",
        type=float,
        default=0.75,
        help=(
            "Window p-value quantile aggregation for --fdr-method=cv_storey_bh."
        ),
    )
    parser.add_argument(
        "--stability-bootstraps",
        type=int,
        default=120,
        help=(
            "Bootstrap rounds for --fdr-method=stability_bh."
        ),
    )
    parser.add_argument(
        "--stability-subsample-frac",
        type=float,
        default=0.7,
        help=(
            "Window subsample fraction for --fdr-method=stability_bh."
        ),
    )
    parser.add_argument(
        "--stability-min-frequency",
        type=float,
        default=0.7,
        help=(
            "Selection frequency threshold for --fdr-method=stability_bh."
        ),
    )
    parser.add_argument(
        "--stability-select-p",
        type=float,
        default=0.2,
        help=(
            "Bootstrap selection p-value cut for --fdr-method=stability_bh."
        ),
    )
    parser.add_argument(
        "--plan",
        default="legacy",
        choices=["legacy", "A", "B", "C"],
        help="Execution plan tag recorded in reports.",
    )
    parser.add_argument(
        "--with-phaseb-search",
        action="store_true",
        help="Run strategy:g3g4:phaseb-search before strategy:mvp.",
    )
    parser.add_argument(
        "--with-hypothesis-candidates",
        action="store_true",
        help="Compile strategy candidates from latest hypothesis backlog before strategy:mvp.",
    )
    parser.add_argument(
        "--hypothesis-candidate-mode",
        default="auto",
        choices=["auto", "lock_best_triplet", "blend"],
        help="Mode forwarded to research_hypothesis_to_candidates.py when enabled.",
    )
    parser.add_argument(
        "--best-triplet-path",
        default="data/research/strategy/local_search/best_trend_triplet.latest.v1.json",
        help="Best-triplet JSON path forwarded to hypothesis candidate compiler.",
    )
    parser.add_argument(
        "--candidate-complexity-profile",
        default="default",
        choices=["default", "low"],
        help=(
            "Candidate complexity profile forwarded to "
            "research_hypothesis_to_candidates.py."
        ),
    )
    parser.add_argument(
        "--no-expand-candidates",
        action="store_true",
        help="Disable candidate expansion, including phase-B search.",
    )
    parser.add_argument(
        "--plan-switch-reason",
        default="",
        help="Optional rationale for switching plan variant.",
    )
    parser.add_argument(
        "--research-digest-id",
        default="",
        help="Optional research digest identifier tied to this run.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Alias for planned mode; do not execute command chain.",
    )
    return parser.parse_args()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (root / path).resolve()


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def should_run_phaseb_search(args: argparse.Namespace) -> bool:
    return bool(args.with_phaseb_search) and not bool(args.no_expand_candidates)


def should_run_hypothesis_candidates(args: argparse.Namespace) -> bool:
    return bool(args.with_hypothesis_candidates) and not bool(args.no_expand_candidates) and args.plan != "C"


def build_specs(args: argparse.Namespace) -> List[CommandSpec]:
    pnpm = args.pnpm_bin
    strategy_chain: List[CommandSpec] = []
    if should_run_hypothesis_candidates(args):
        strategy_chain.append(
            CommandSpec(
                "hypothesis_candidates_compile",
                [
                    args.python_bin,
                    "scripts/research_hypothesis_to_candidates.py",
                    "--plan",
                    str(args.plan),
                    "--candidate-mode",
                    str(args.hypothesis_candidate_mode),
                    "--complexity-profile",
                    str(args.candidate_complexity_profile),
                    "--best-triplet",
                    str(args.best_triplet_path),
                ],
                [0],
            )
        )
    if should_run_phaseb_search(args):
        strategy_chain.append(
            CommandSpec(
                "phaseb_search",
                [pnpm, "run", "strategy:g3g4:phaseb-search"],
                [0],
            )
        )
    strategy_mvp_argv = [
        pnpm,
        "run",
        "strategy:mvp",
        "--",
        "--wfo-profile",
        str(args.protocol_profile),
        "--fdr-method",
        str(args.fdr_method),
    ]
    if str(args.fdr_method) == "regime_segmented_bh":
        strategy_mvp_argv.extend(
            [
                "--regime-method",
                str(args.regime_method),
                "--regime-max-segments",
                str(args.regime_max_segments),
                "--regime-min-segment-bars",
                str(args.regime_min_segment_bars),
                "--regime-min-windows",
                str(args.regime_min_windows),
                "--regime-aggregation",
                str(args.regime_aggregation),
            ]
        )
    if str(args.fdr_method) == "cv_storey_bh":
        strategy_mvp_argv.extend(
            [
                "--cv-agg-quantile",
                str(args.cv_agg_quantile),
            ]
        )
    if str(args.fdr_method) == "stability_bh":
        strategy_mvp_argv.extend(
            [
                "--stability-bootstraps",
                str(args.stability_bootstraps),
                "--stability-subsample-frac",
                str(args.stability_subsample_frac),
                "--stability-min-frequency",
                str(args.stability_min_frequency),
                "--stability-select-p",
                str(args.stability_select_p),
            ]
        )
    strategy_chain.extend(
        [
            # strategy:mvp may exit 2 when release gates block promotion (expected NO_GO path).
            CommandSpec(
                "strategy_mvp",
                strategy_mvp_argv,
                [0, 2],
            ),
            # Always refresh preflight status per run so G1 checkpoint reflects current
            # environment/policy state instead of stale reports.
            CommandSpec("gates_preflight", [pnpm, "run", "gates:preflight"], [0, 2]),
            CommandSpec("gates_checkpoints", [pnpm, "run", "gates:checkpoints"], [0]),
            CommandSpec("decision_build", [pnpm, "run", "decision:build"], [0]),
            # NO_GO baseline returns exit code 2; this is expected and must not stop archiving.
            CommandSpec("decision_validate", [pnpm, "run", "decision:validate"], [0, 2]),
        ]
    )

    if args.profile == "fast":
        return strategy_chain

    full_prefix = [
        CommandSpec("baseline_snapshot", [pnpm, "run", "baseline:snapshot"], [0]),
        CommandSpec("env_verify", [pnpm, "run", "env:verify"], [0]),
        CommandSpec("freeze_verify", [pnpm, "run", "freeze:verify"], [0]),
    ]
    return full_prefix + strategy_chain


def run_command(spec: CommandSpec, cwd: Path) -> Dict[str, Any]:
    proc = subprocess.run(
        spec.argv,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )
    ok = proc.returncode in set(spec.allowed_exit_codes)
    return {
        "name": spec.name,
        "command": " ".join(shlex.quote(part) for part in spec.argv),
        "exitCode": proc.returncode,
        "allowedExitCodes": list(spec.allowed_exit_codes),
        "ok": ok,
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-4000:],
    }


def archive_artifacts(repo_root: Path, archive_root: Path) -> List[Dict[str, Any]]:
    rel_paths = [
        "docs/research/strategy_candidates.v1.json",
        "data/research/strategy/strategy_validation_runs.json",
        "data/research/strategy/experiment_verdict.v2.json",
        "data/runtime/release_gate_status.json",
        "data/runtime/gates/gate_checkpoints_index.v1.json",
        "data/runtime/gates/G0.checkpoint.json",
        "data/runtime/gates/G1.checkpoint.json",
        "data/runtime/gates/G2.checkpoint.json",
        "data/runtime/gates/G3.checkpoint.json",
        "data/runtime/gates/G4.checkpoint.json",
        "decision_packet/verdict.json",
        "decision_packet/experiment_verdict.v2.json",
        "decision_packet/release_gate_status.json",
        "decision_packet/gates/gate_checkpoints_index.v1.json",
        "decision_packet/gates/G0.checkpoint.json",
        "decision_packet/gates/G1.checkpoint.json",
        "decision_packet/gates/G2.checkpoint.json",
        "decision_packet/gates/G3.checkpoint.json",
        "decision_packet/gates/G4.checkpoint.json",
        "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.json",
        "data/research/strategy/analysis/g3g4/latest_strategy_g3g4_breakdown.md",
    ]
    rows: List[Dict[str, Any]] = []
    for rel in rel_paths:
        src = repo_root / rel
        item: Dict[str, Any] = {"path": rel, "exists": src.exists(), "copied": False}
        if src.exists():
            dst = archive_root / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
            item["copied"] = True
        rows.append(item)
    return rows


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Strategy G3/G4 Iteration Report")
    lines.append("")
    lines.append(f"- run_id: `{payload.get('run_id', '')}`")
    lines.append(f"- generated_at: `{payload.get('generated_at', '')}`")
    lines.append(f"- mode: `{payload.get('mode', '')}`")
    lines.append(f"- profile: `{payload.get('profile', '')}`")
    lines.append(f"- protocol_profile: `{payload.get('protocol_profile', '')}`")
    lines.append(f"- fdr_method: `{payload.get('fdr_method', 'bh')}`")
    lines.append(f"- regime_method: `{payload.get('regime_method', 'change_point')}`")
    lines.append(
        f"- regime_max_segments: `{payload.get('regime_max_segments', 4)}`"
    )
    lines.append(
        f"- regime_min_segment_bars: `{payload.get('regime_min_segment_bars', 240)}`"
    )
    lines.append(
        f"- regime_min_windows: `{payload.get('regime_min_windows', 2)}`"
    )
    lines.append(
        f"- regime_aggregation: `{payload.get('regime_aggregation', 'weighted_mean')}`"
    )
    lines.append(
        f"- cv_agg_quantile: `{payload.get('cv_agg_quantile', 0.75)}`"
    )
    lines.append(
        f"- stability_bootstraps: `{payload.get('stability_bootstraps', 120)}`"
    )
    lines.append(
        f"- stability_subsample_frac: `{payload.get('stability_subsample_frac', 0.7)}`"
    )
    lines.append(
        f"- stability_min_frequency: `{payload.get('stability_min_frequency', 0.7)}`"
    )
    lines.append(
        f"- stability_select_p: `{payload.get('stability_select_p', 0.2)}`"
    )
    lines.append(f"- plan: `{payload.get('plan', 'legacy')}`")
    lines.append(
        f"- no_expand_candidates: `{payload.get('no_expand_candidates', False)}`"
    )
    lines.append(
        f"- plan_switch_reason: `{payload.get('plan_switch_reason', '')}`"
    )
    lines.append(
        f"- research_digest_id: `{payload.get('research_digest_id', '')}`"
    )
    lines.append(f"- with_phaseb_search: `{payload.get('with_phaseb_search', False)}`")
    lines.append(
        f"- with_hypothesis_candidates: `{payload.get('with_hypothesis_candidates', False)}`"
    )
    lines.append(
        f"- hypothesis_candidate_mode: `{payload.get('hypothesis_candidate_mode', 'auto')}`"
    )
    lines.append(
        f"- candidate_complexity_profile: `{payload.get('candidate_complexity_profile', 'default')}`"
    )
    lines.append(
        f"- best_triplet_path: `{payload.get('best_triplet_path', '')}`"
    )
    lines.append(
        f"- phaseb_search_effective: `{payload.get('phaseb_search_effective', False)}`"
    )
    lines.append(
        f"- hypothesis_candidates_effective: `{payload.get('hypothesis_candidates_effective', False)}`"
    )
    lines.append(f"- success: `{payload.get('success', False)}`")
    lines.append("")
    lines.append("## Commands")
    lines.append("")
    lines.append("| name | exit | allowed | ok | command |")
    lines.append("|---|---:|---|---|---|")
    for row in payload.get("commands", []):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(row.get("name", "")),
                    str(row.get("exitCode", "")),
                    ",".join(str(v) for v in row.get("allowedExitCodes", [])),
                    str(row.get("ok", "")),
                    str(row.get("command", "")),
                ]
            )
            + " |"
        )
    lines.append("")
    lines.append("## Archived Artifacts")
    lines.append("")
    lines.append("| path | exists | copied |")
    lines.append("|---|---|---|")
    for row in payload.get("artifacts", []):
        lines.append(
            "| "
            + " | ".join(
                [str(row.get("path", "")), str(row.get("exists", "")), str(row.get("copied", ""))]
            )
            + " |"
        )
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    if not (0 < float(args.cv_agg_quantile) <= 1):
        print("ERROR: --cv-agg-quantile must be in (0, 1].", file=sys.stderr)
        return 2
    if int(args.stability_bootstraps) < 1:
        print("ERROR: --stability-bootstraps must be >= 1.", file=sys.stderr)
        return 2
    if not (0 < float(args.stability_subsample_frac) <= 1):
        print("ERROR: --stability-subsample-frac must be in (0, 1].", file=sys.stderr)
        return 2
    if not (0 <= float(args.stability_min_frequency) <= 1):
        print("ERROR: --stability-min-frequency must be in [0, 1].", file=sys.stderr)
        return 2
    if not (0 <= float(args.stability_select_p) <= 1):
        print("ERROR: --stability-select-p must be in [0, 1].", file=sys.stderr)
        return 2
    if args.plan == "C" and args.with_phaseb_search:
        print(f"ERROR: {PLAN_C_PHASEB_CONFLICT_ERROR}", file=sys.stderr)
        return 2
    if (
        args.no_expand_candidates
        and args.with_hypothesis_candidates
        and args.hypothesis_candidate_mode == "lock_best_triplet"
    ):
        print(f"ERROR: {LOCKED_MODE_NO_EXPAND_CONFLICT_ERROR}", file=sys.stderr)
        return 2

    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if args.repo_root
        else Path(__file__).resolve().parents[1]
    )
    ts = now_utc()
    run_id = args.run_id.strip() or ts.strftime("%Y%m%dT%H%M%SZ")
    out_dir = resolve_path(repo_root, args.out_dir)
    archive_dir = out_dir / "archive" / run_id

    execute_chain = bool(args.execute_chain) and not bool(args.dry_run)
    phaseb_search_effective = should_run_phaseb_search(args)
    hypothesis_candidates_effective = should_run_hypothesis_candidates(args)
    specs = build_specs(args)
    command_results: List[Dict[str, Any]] = []
    success = True

    if execute_chain:
        for spec in specs:
            result = run_command(spec, cwd=repo_root)
            command_results.append(result)
            if not result["ok"]:
                success = False
                if not args.continue_on_error:
                    break

        breakdown_spec = CommandSpec(
            name="g3g4_failure_breakdown",
            argv=[args.python_bin, "scripts/strategy_g3g4_failure_breakdown.py", "--run-id", run_id],
            allowed_exit_codes=[0],
        )
        breakdown_result = run_command(breakdown_spec, cwd=repo_root)
        command_results.append(breakdown_result)
        if not breakdown_result["ok"]:
            success = False
    else:
        for spec in specs:
            command_results.append(
                {
                    "name": spec.name,
                    "command": " ".join(shlex.quote(part) for part in spec.argv),
                    "exitCode": None,
                    "allowedExitCodes": list(spec.allowed_exit_codes),
                    "ok": True,
                    "stdoutTail": "",
                    "stderrTail": "",
                }
            )
        command_results.append(
            {
                "name": "g3g4_failure_breakdown",
                "command": f"{shlex.quote(args.python_bin)} scripts/strategy_g3g4_failure_breakdown.py --run-id {shlex.quote(run_id)}",
                "exitCode": None,
                "allowedExitCodes": [0],
                "ok": True,
                "stdoutTail": "",
                "stderrTail": "",
            }
        )

    artifacts = archive_artifacts(repo_root, archive_dir) if execute_chain else []
    payload = {
        "schemaVersion": "strategy_g3g4_iteration.v1",
        "run_id": run_id,
        "generated_at": iso(ts),
        "mode": "execute" if execute_chain else "plan",
        "profile": args.profile,
        "protocol_profile": args.protocol_profile,
        "fdr_method": args.fdr_method,
        "regime_method": str(args.regime_method),
        "regime_max_segments": int(args.regime_max_segments),
        "regime_min_segment_bars": int(args.regime_min_segment_bars),
        "regime_min_windows": int(args.regime_min_windows),
        "regime_aggregation": str(args.regime_aggregation),
        "cv_agg_quantile": float(args.cv_agg_quantile),
        "stability_bootstraps": int(args.stability_bootstraps),
        "stability_subsample_frac": float(args.stability_subsample_frac),
        "stability_min_frequency": float(args.stability_min_frequency),
        "stability_select_p": float(args.stability_select_p),
        "plan": args.plan,
        "no_expand_candidates": bool(args.no_expand_candidates),
        "plan_switch_reason": args.plan_switch_reason,
        "research_digest_id": args.research_digest_id,
        "with_phaseb_search": bool(args.with_phaseb_search),
        "with_hypothesis_candidates": bool(args.with_hypothesis_candidates),
        "hypothesis_candidate_mode": str(args.hypothesis_candidate_mode),
        "candidate_complexity_profile": str(args.candidate_complexity_profile),
        "best_triplet_path": str(args.best_triplet_path),
        "phaseb_search_effective": phaseb_search_effective,
        "hypothesis_candidates_effective": hypothesis_candidates_effective,
        "success": success,
        "continue_on_error": bool(args.continue_on_error),
        "commands": command_results,
        "artifacts": artifacts,
        "archive_dir": str(archive_dir),
    }

    latest_json = out_dir / "latest_strategy_g3g4_iteration.json"
    latest_md = out_dir / "latest_strategy_g3g4_iteration.md"
    archive_json = archive_dir / "strategy_g3g4_iteration.json"
    archive_md = archive_dir / "strategy_g3g4_iteration.md"
    markdown = render_markdown(payload)

    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "mode": payload["mode"],
                "success": success,
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "archive_json": str(archive_json),
                "archive_md": str(archive_md),
            },
            ensure_ascii=False,
            indent=2,
        )
    )

    if execute_chain and not success:
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
