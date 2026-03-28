#!/usr/bin/env python3
"""Execute top-priority methodology hypotheses as real G3/G4 iteration runs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple


SCHEMA_VERSION = "methodology_execution.v1"
DEFAULT_BACKLOG = "data/research/hypotheses/backlog.v1.json"
DEFAULT_OUTPUT = "data/research/strategy/analysis/g3g4/latest_methodology_execution.v1.json"
DEFAULT_ARCHIVE_DIR = "data/research/strategy/analysis/g3g4/methodology/archive"
DEFAULT_BEST_TRIPLET = "data/research/strategy/local_search/best_trend_triplet.latest.v1.json"

METHOD_PRESETS: Dict[str, Dict[str, Any]] = {
    "robust-baseline": {
        "fdrMethod": "by",
        "extraArgs": [],
        "hypothesis": "Conservative baseline to minimize false discoveries before expansion.",
    },
    "selective-inference": {
        "fdrMethod": "cv_storey_bh",
        "extraArgs": ["--cv-agg-quantile", "0.9"],
        "hypothesis": "Selective inference proxy via cross-window quantile aggregation.",
    },
}


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run top methodology hypotheses (robust-baseline/selective-inference) "
            "through strategy_g3g4_iteration."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--backlog",
        default=DEFAULT_BACKLOG,
        help="Path to hypothesis backlog JSON.",
    )
    parser.add_argument(
        "--top-k",
        type=int,
        default=2,
        help="Number of hypotheses to execute (default: 2).",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Latest output report path.",
    )
    parser.add_argument(
        "--archive-dir",
        default=DEFAULT_ARCHIVE_DIR,
        help="Archive directory root for run reports.",
    )
    parser.add_argument(
        "--best-triplet-path",
        default=DEFAULT_BEST_TRIPLET,
        help="Best-triplet path forwarded into strategy iteration.",
    )
    parser.add_argument(
        "--python-bin",
        default="python3",
        help="Python executable used to invoke strategy_g3g4_iteration.py.",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional report run id. Default uses UTC timestamp.",
    )
    parser.add_argument(
        "--execute-chain",
        action="store_true",
        help="Execute real runs; otherwise produce dry-run plan.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue executing remaining hypotheses after one failure.",
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


def load_json_obj(path: Path) -> Dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"JSON root must be an object: {path}")
    return payload


def write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_text(raw: Any) -> str:
    return " ".join(str(raw or "").split()).strip()


def normalize_method_family(raw: Any) -> str:
    return normalize_text(raw).lower()


def to_float(raw: Any, default: float = 0.0) -> float:
    try:
        if raw is None:
            return default
        return float(str(raw).strip())
    except Exception:
        return default


def select_hypotheses(backlog: Dict[str, Any], top_k: int) -> List[Dict[str, Any]]:
    hypotheses = backlog.get("hypotheses")
    if not isinstance(hypotheses, list):
        return []

    scored: List[Tuple[float, str, Dict[str, Any]]] = []
    for row in hypotheses:
        if not isinstance(row, dict):
            continue
        family = normalize_method_family(row.get("methodFamily"))
        if family not in METHOD_PRESETS:
            continue
        priority = to_float(row.get("priority"), 0.0)
        row_id = normalize_text(row.get("id")) or normalize_text(row.get("paperId"))
        scored.append((-priority, row_id, row))

    scored.sort(key=lambda item: (item[0], item[1]))

    selected: List[Dict[str, Any]] = []
    seen_families: set[str] = set()
    target = max(1, int(top_k))
    for _, _, row in scored:
        family = normalize_method_family(row.get("methodFamily"))
        if family in seen_families:
            continue
        selected.append(row)
        seen_families.add(family)
        if len(selected) >= target:
            return selected

    if len(selected) < target:
        for _, _, row in scored:
            if row in selected:
                continue
            selected.append(row)
            if len(selected) >= target:
                break

    return selected


def build_iteration_command(
    *,
    repo_root: Path,
    python_bin: str,
    run_id: str,
    fdr_method: str,
    extra_args: Sequence[str],
    best_triplet_path: str,
    execute_chain: bool,
) -> List[str]:
    command = [
        python_bin,
        "scripts/strategy_g3g4_iteration.py",
        "--repo-root",
        str(repo_root),
        "--plan",
        "legacy",
        "--profile",
        "fast",
        "--protocol-profile",
        "shift",
        "--fdr-method",
        fdr_method,
        "--with-hypothesis-candidates",
        "--hypothesis-candidate-mode",
        "blend",
        "--best-triplet-path",
        str(best_triplet_path),
        "--run-id",
        run_id,
    ]
    command.extend(list(extra_args))
    command.append("--execute-chain" if execute_chain else "--dry-run")
    return command


def read_verdict_metrics(repo_root: Path, run_id: str) -> Dict[str, Any]:
    verdict_path = (
        repo_root
        / "data/research/strategy/runs/archive"
        / run_id
        / "decision_packet/experiment_verdict.v2.json"
    )
    if not verdict_path.exists():
        return {
            "path": str(verdict_path),
            "exists": False,
            "result": None,
            "fdrQ": None,
            "meanPbo": None,
            "reasonCodes": [],
        }
    payload = load_json_obj(verdict_path)
    aggregate = payload.get("aggregateMetrics")
    if not isinstance(aggregate, dict):
        aggregate = {}
    reason_codes = payload.get("reasonCodes")
    if not isinstance(reason_codes, list):
        reason_codes = []
    return {
        "path": str(verdict_path),
        "exists": True,
        "result": payload.get("result"),
        "fdrQ": aggregate.get("fdrQ"),
        "meanPbo": aggregate.get("meanPbo"),
        "reasonCodes": [normalize_text(code) for code in reason_codes if normalize_text(code)],
    }


def execute_one(
    *,
    repo_root: Path,
    command: Sequence[str],
    execute_chain: bool,
    run_id: str,
) -> Dict[str, Any]:
    if execute_chain:
        proc = subprocess.run(
            list(command),
            cwd=str(repo_root),
            text=True,
            capture_output=True,
            check=False,
        )
        exit_code = int(proc.returncode)
        stdout_tail = (proc.stdout or "")[-4000:]
        stderr_tail = (proc.stderr or "")[-4000:]
    else:
        exit_code = 0
        stdout_tail = "dry-run: command not executed."
        stderr_tail = ""
    verdict = read_verdict_metrics(repo_root, run_id) if execute_chain else {}
    return {
        "runId": run_id,
        "command": " ".join(shlex.quote(part) for part in command),
        "exitCode": exit_code,
        "ok": exit_code in (0, 2),
        "stdoutTail": stdout_tail,
        "stderrTail": stderr_tail,
        "verdict": verdict,
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    backlog_path = resolve_path(repo_root, str(args.backlog))
    output_path = resolve_path(repo_root, str(args.output))
    archive_root = resolve_path(repo_root, str(args.archive_dir))
    best_triplet_path = str(args.best_triplet_path)
    report_run_id = (
        normalize_text(args.run_id) or now_utc().strftime("%Y%m%dT%H%M%SZ")
    )

    if not backlog_path.exists():
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"missing backlog file: {backlog_path}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    backlog_payload = load_json_obj(backlog_path)
    selected = select_hypotheses(backlog_payload, int(args.top_k))
    if not selected:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "no runnable hypotheses matched supported method families",
                    "supportedFamilies": sorted(METHOD_PRESETS.keys()),
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    runs: List[Dict[str, Any]] = []
    stop_early = False
    for index, row in enumerate(selected, start=1):
        family = normalize_method_family(row.get("methodFamily"))
        preset = METHOD_PRESETS[family]
        strategy_run_id = f"A-meth-{family.replace('-', '_')}-{report_run_id}-{index:02d}"
        command = build_iteration_command(
            repo_root=repo_root,
            python_bin=str(args.python_bin),
            run_id=strategy_run_id,
            fdr_method=str(preset["fdrMethod"]),
            extra_args=[str(token) for token in preset.get("extraArgs", [])],
            best_triplet_path=best_triplet_path,
            execute_chain=bool(args.execute_chain),
        )
        execution = execute_one(
            repo_root=repo_root,
            command=command,
            execute_chain=bool(args.execute_chain),
            run_id=strategy_run_id,
        )
        runs.append(
            {
                "hypothesis": {
                    "id": normalize_text(row.get("id")),
                    "paperId": normalize_text(row.get("paperId")),
                    "title": normalize_text(row.get("title")),
                    "priority": to_float(row.get("priority"), 0.0),
                    "methodFamily": family,
                    "actionHint": normalize_text(row.get("actionHint")),
                    "experimentTemplateId": normalize_text(row.get("experimentTemplateId")),
                },
                "preset": {
                    "fdrMethod": str(preset.get("fdrMethod")),
                    "extraArgs": [str(token) for token in preset.get("extraArgs", [])],
                    "note": normalize_text(preset.get("hypothesis")),
                },
                "execution": execution,
            }
        )
        if execution.get("exitCode", 1) not in (0, 2) and not bool(args.continue_on_error):
            stop_early = True
            break

    payload: Dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "reportRunId": report_run_id,
        "executeChain": bool(args.execute_chain),
        "source": {
            "backlog": str(backlog_path),
            "bestTripletPath": best_triplet_path,
        },
        "selection": {
            "requestedTopK": int(args.top_k),
            "selectedCount": len(selected),
            "selectedFamilies": [
                normalize_method_family(row.get("methodFamily")) for row in selected
            ],
        },
        "runs": runs,
        "summary": {
            "stoppedEarly": stop_early,
            "okCount": sum(
                1 for row in runs if bool((row.get("execution") or {}).get("ok"))
            ),
            "errorCount": sum(
                1 for row in runs if not bool((row.get("execution") or {}).get("ok"))
            ),
        },
    }

    archive_path = archive_root / report_run_id / "methodology_execution.v1.json"
    write_json(output_path, payload)
    write_json(archive_path, payload)
    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "archive": str(archive_path),
                "reportRunId": report_run_id,
                "executeChain": bool(args.execute_chain),
                "selectedCount": len(selected),
                "runCount": len(runs),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
