#!/usr/bin/env python3
"""Generate baseline-vs-replay comparison report for V2 protocol replay."""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
from pathlib import Path
from typing import Any, Dict, List, Optional


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description=(
            "Compare baseline training/completion artifacts with a replay run and "
            "emit markdown + JSON reports."
        )
    )
    p.add_argument(
        "--baseline-root",
        default="data/training-data/full-v2",
        help="Baseline training root (contains retrain/summary.json).",
    )
    p.add_argument(
        "--replay-root",
        default="",
        help="Replay training root (contains retrain/summary.json).",
    )
    p.add_argument(
        "--matrix-root",
        default="",
        help="Optional matrix root; when set, generate matrix summary from all cases.",
    )
    p.add_argument(
        "--baseline-completion",
        default="",
        help="Optional explicit baseline completion JSON path.",
    )
    p.add_argument(
        "--replay-completion",
        default="",
        help="Optional explicit replay completion JSON path.",
    )
    p.add_argument(
        "--logs-dir",
        default="logs/research",
        help="Directory to scan openalice_completion_*.json when completion paths are omitted.",
    )
    p.add_argument(
        "--output-dir",
        required=True,
        help="Output directory for comparison artifacts.",
    )
    p.add_argument(
        "--report-template",
        default="docs/research/templates/v2-replay-report-template.md",
        help="Path to template reference (embedded in report metadata).",
    )
    return p.parse_args()


def read_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def metric(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except Exception:
        return None


def fmt_num(value: Optional[float], digits: int = 4) -> str:
    if value is None:
        return "n/a"
    return f"{value:.{digits}f}"


def fmt_delta(base: Optional[float], replay: Optional[float], digits: int = 4) -> str:
    if base is None or replay is None:
        return "n/a"
    delta = replay - base
    sign = "+" if delta >= 0 else ""
    return f"{sign}{delta:.{digits}f}"


def fmt_text(value: Any) -> str:
    if value is None:
        return "n/a"
    return str(value)


def abs_resolve(path: str) -> str:
    return str(Path(path).resolve())


def choose_latest_completion(
    training_root: str, logs_dir: Path
) -> tuple[Optional[Path], Optional[Dict[str, Any]]]:
    expected = abs_resolve(training_root)
    best_path: Optional[Path] = None
    best_data: Optional[Dict[str, Any]] = None
    best_time: Optional[str] = None

    for raw in glob.glob(str(logs_dir / "openalice_completion_*.json")):
        path = Path(raw)
        try:
            data = read_json(path)
        except Exception:
            continue
        candidate_root = data.get("input", {}).get("trainingRoot")
        if not isinstance(candidate_root, str):
            continue
        if abs_resolve(candidate_root) != expected:
            continue
        generated_at = str(data.get("generatedAt", ""))
        if best_time is None or generated_at > best_time:
            best_time = generated_at
            best_path = path
            best_data = data
    return best_path, best_data


def completion_metrics(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    if not data:
        return {
            "score": None,
            "readiness": None,
            "paperPassRatio": None,
            "livePassRatio": None,
            "significancePassRatio": None,
            "meanPbo": None,
            "meanDsrProbability": None,
            "hardGateApplied": None,
        }
    comp = data.get("completion", {})
    sv = data.get("strategyValidation", {})
    return {
        "score": metric(comp.get("score")),
        "readiness": comp.get("readiness"),
        "paperPassRatio": metric(sv.get("paperPassRatio")),
        "livePassRatio": metric(sv.get("livePassRatio")),
        "significancePassRatio": metric(sv.get("significancePassRatio")),
        "meanPbo": metric(sv.get("meanPbo")),
        "meanDsrProbability": metric(sv.get("meanDsrProbability")),
        "hardGateApplied": comp.get("hardGateApplied"),
    }


def summary_metrics(data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "objectiveMetric": data.get("objectiveMetric"),
        "objectiveMode": data.get("objectiveMode"),
        "trainedSymbols": data.get("trainedSymbols"),
        "errorSymbols": data.get("errorSymbols"),
        "meanObjectiveScore": metric(data.get("meanObjectiveScore")),
        "meanDirectionAccuracy": metric(data.get("meanDirectionAccuracy")),
        "meanBaselineDirectionAccuracy": metric(
            data.get("meanBaselineDirectionAccuracy")
        ),
        "meanAccuracyLift": metric(data.get("meanAccuracyLift")),
        "positiveLiftRatio": metric(data.get("positiveLiftRatio")),
    }


def collect_matrix_cases(matrix_root: Path) -> List[Dict[str, Any]]:
    cases: List[Dict[str, Any]] = []
    for completion_path in sorted(matrix_root.rglob("completion_replay.json")):
        try:
            completion_data = read_json(completion_path)
        except Exception:
            continue

        if completion_path.parent.name == "report":
            case_root = completion_path.parent.parent
            default_training_root = case_root / "training"
        else:
            case_root = completion_path.parent
            default_training_root = case_root / "training"
        case_id = case_root.name
        input_data = completion_data.get("input", {}) if isinstance(completion_data, dict) else {}
        experiment = input_data.get("experiment", {}) if isinstance(input_data, dict) else {}
        training_root_raw = input_data.get("trainingRoot")
        if isinstance(training_root_raw, str) and training_root_raw.strip():
            training_root = Path(training_root_raw)
        else:
            training_root = default_training_root

        summary_path = training_root / "retrain" / "summary.json"
        summary_data: Dict[str, Any]
        if summary_path.exists():
            try:
                summary_data = summary_metrics(read_json(summary_path))
            except Exception:
                summary_data = summary_metrics({})
        else:
            summary_data = summary_metrics({})

        completion = completion_metrics(completion_data)
        cases.append(
            {
                "caseId": case_id,
                "trainingRoot": str(training_root),
                "summaryPath": str(summary_path),
                "completionPath": str(completion_path),
                "partitionMode": experiment.get("partitionMode")
                if isinstance(experiment, dict)
                else None,
                "regimeScheme": experiment.get("regimeScheme")
                if isinstance(experiment, dict)
                else None,
                "gateProfile": experiment.get("gateProfile")
                if isinstance(experiment, dict)
                else None,
                "topSymbols": input_data.get("topSymbols")
                if isinstance(input_data, dict)
                else None,
                "summary": summary_data,
                "completion": completion,
            }
        )
    return cases


def build_matrix_markdown(
    matrix_root: Path,
    baseline_root: Path,
    baseline_summary_path: Path,
    baseline_completion_path: Optional[Path],
    baseline_summary: Dict[str, Any],
    baseline_completion: Dict[str, Any],
    cases: List[Dict[str, Any]],
    template_path: str,
) -> str:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    ordered = sorted(
        cases,
        key=lambda c: (
            metric(c.get("completion", {}).get("score")) is None,
            -(metric(c.get("completion", {}).get("score")) or 0.0),
        ),
    )

    lines = [
        "# V2 Replay Matrix Comparison",
        "",
        f"- generatedAt: `{now}`",
        f"- templateReference: `{template_path}`",
        f"- baselineRoot: `{baseline_root}`",
        f"- matrixRoot: `{matrix_root}`",
        f"- baselineSummary: `{baseline_summary_path}`",
        f"- baselineCompletion: `{baseline_completion_path}`",
        f"- totalCases: `{len(ordered)}`",
        "",
        "## Baseline",
        "",
        f"- meanAccuracyLift: `{fmt_num(baseline_summary.get('meanAccuracyLift'))}`",
        f"- positiveLiftRatio: `{fmt_num(baseline_summary.get('positiveLiftRatio'))}`",
        f"- score: `{fmt_num(baseline_completion.get('score'), 2)}`",
        f"- significancePassRatio: `{fmt_num(baseline_completion.get('significancePassRatio'))}`",
        f"- meanPbo: `{fmt_num(baseline_completion.get('meanPbo'))}`",
        f"- meanDsrProbability: `{fmt_num(baseline_completion.get('meanDsrProbability'))}`",
        "",
        "## Case Table",
        "",
        "| caseId | partitionMode | regimeScheme | gateProfile | topSymbols | score | Δscore | meanAccuracyLift | Δlift | positiveLiftRatio | significancePassRatio | meanPbo | meanDsrProbability | readiness |",
        "|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ]
    for case in ordered:
        summary = case.get("summary", {})
        completion = case.get("completion", {})
        lines.append(
            "| "
            + f"{fmt_text(case.get('caseId'))} | "
            + f"{fmt_text(case.get('partitionMode'))} | "
            + f"{fmt_text(case.get('regimeScheme'))} | "
            + f"{fmt_text(case.get('gateProfile'))} | "
            + f"{fmt_text(case.get('topSymbols'))} | "
            + f"{fmt_num(metric(completion.get('score')), 2)} | "
            + f"{fmt_delta(metric(baseline_completion.get('score')), metric(completion.get('score')), 2)} | "
            + f"{fmt_num(metric(summary.get('meanAccuracyLift')))} | "
            + f"{fmt_delta(metric(baseline_summary.get('meanAccuracyLift')), metric(summary.get('meanAccuracyLift')))} | "
            + f"{fmt_num(metric(summary.get('positiveLiftRatio')))} | "
            + f"{fmt_num(metric(completion.get('significancePassRatio')))} | "
            + f"{fmt_num(metric(completion.get('meanPbo')))} | "
            + f"{fmt_num(metric(completion.get('meanDsrProbability')))} | "
            + f"{fmt_text(completion.get('readiness'))} |"
        )

    lines.extend(
        [
            "",
            "## Notes",
            "",
            "- `stage1` should be interpreted as directional evidence, not deployment readiness.",
            "- Compare `meanAccuracyLift` + `meanPbo` jointly to avoid one-metric bias.",
            "- For deployment decisions, always re-check `hard` profile gates.",
        ]
    )
    return "\n".join(lines) + "\n"


def build_comparison_markdown(
    baseline_root: str,
    replay_root: str,
    baseline_summary_path: Path,
    replay_summary_path: Path,
    baseline_completion_path: Optional[Path],
    replay_completion_path: Optional[Path],
    baseline_summary: Dict[str, Any],
    replay_summary: Dict[str, Any],
    baseline_completion: Dict[str, Any],
    replay_completion: Dict[str, Any],
    template_path: str,
) -> str:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    lines = [
        "# V2 Protocol Replay Comparison",
        "",
        f"- generatedAt: `{now}`",
        f"- templateReference: `{template_path}`",
        f"- baselineRoot: `{baseline_root}`",
        f"- replayRoot: `{replay_root}`",
        f"- baselineSummary: `{baseline_summary_path}`",
        f"- replaySummary: `{replay_summary_path}`",
        f"- baselineCompletion: `{baseline_completion_path}`",
        f"- replayCompletion: `{replay_completion_path}`",
        "",
        "## Training Metrics",
        "",
        "| Metric | Baseline | Replay | Delta (Replay-Baseline) |",
        "|---|---:|---:|---:|",
        (
            f"| meanDirectionAccuracy | {fmt_num(baseline_summary['meanDirectionAccuracy'])} | "
            f"{fmt_num(replay_summary['meanDirectionAccuracy'])} | "
            f"{fmt_delta(baseline_summary['meanDirectionAccuracy'], replay_summary['meanDirectionAccuracy'])} |"
        ),
        (
            f"| meanBaselineDirectionAccuracy | {fmt_num(baseline_summary['meanBaselineDirectionAccuracy'])} | "
            f"{fmt_num(replay_summary['meanBaselineDirectionAccuracy'])} | "
            f"{fmt_delta(baseline_summary['meanBaselineDirectionAccuracy'], replay_summary['meanBaselineDirectionAccuracy'])} |"
        ),
        (
            f"| meanAccuracyLift | {fmt_num(baseline_summary['meanAccuracyLift'])} | "
            f"{fmt_num(replay_summary['meanAccuracyLift'])} | "
            f"{fmt_delta(baseline_summary['meanAccuracyLift'], replay_summary['meanAccuracyLift'])} |"
        ),
        (
            f"| positiveLiftRatio | {fmt_num(baseline_summary['positiveLiftRatio'])} | "
            f"{fmt_num(replay_summary['positiveLiftRatio'])} | "
            f"{fmt_delta(baseline_summary['positiveLiftRatio'], replay_summary['positiveLiftRatio'])} |"
        ),
        (
            f"| meanObjectiveScore | {fmt_num(baseline_summary['meanObjectiveScore'])} | "
            f"{fmt_num(replay_summary['meanObjectiveScore'])} | "
            f"{fmt_delta(baseline_summary['meanObjectiveScore'], replay_summary['meanObjectiveScore'])} |"
        ),
        "",
        "## Completion Metrics",
        "",
        "| Metric | Baseline | Replay | Delta (Replay-Baseline) |",
        "|---|---:|---:|---:|",
        (
            f"| score | {fmt_num(baseline_completion['score'], 2)} | "
            f"{fmt_num(replay_completion['score'], 2)} | "
            f"{fmt_delta(baseline_completion['score'], replay_completion['score'], 2)} |"
        ),
        (
            f"| paperPassRatio | {fmt_num(baseline_completion['paperPassRatio'])} | "
            f"{fmt_num(replay_completion['paperPassRatio'])} | "
            f"{fmt_delta(baseline_completion['paperPassRatio'], replay_completion['paperPassRatio'])} |"
        ),
        (
            f"| livePassRatio | {fmt_num(baseline_completion['livePassRatio'])} | "
            f"{fmt_num(replay_completion['livePassRatio'])} | "
            f"{fmt_delta(baseline_completion['livePassRatio'], replay_completion['livePassRatio'])} |"
        ),
        (
            f"| significancePassRatio | {fmt_num(baseline_completion['significancePassRatio'])} | "
            f"{fmt_num(replay_completion['significancePassRatio'])} | "
            f"{fmt_delta(baseline_completion['significancePassRatio'], replay_completion['significancePassRatio'])} |"
        ),
        (
            f"| meanPbo | {fmt_num(baseline_completion['meanPbo'])} | "
            f"{fmt_num(replay_completion['meanPbo'])} | "
            f"{fmt_delta(baseline_completion['meanPbo'], replay_completion['meanPbo'])} |"
        ),
        (
            f"| meanDsrProbability | {fmt_num(baseline_completion['meanDsrProbability'])} | "
            f"{fmt_num(replay_completion['meanDsrProbability'])} | "
            f"{fmt_delta(baseline_completion['meanDsrProbability'], replay_completion['meanDsrProbability'])} |"
        ),
        (
            f"| readiness | {fmt_text(baseline_completion['readiness'])} | "
            f"{fmt_text(replay_completion['readiness'])} | n/a |"
        ),
        (
            f"| hardGateApplied | {fmt_text(baseline_completion['hardGateApplied'])} | "
            f"{fmt_text(replay_completion['hardGateApplied'])} | n/a |"
        ),
        "",
        "## Interpretation Checklist",
        "",
        "- If replay keeps `labelingMode=next_return_sign` + `objectiveMetric=accuracyLift`, this is same-protocol evidence.",
        "- Prioritize `meanAccuracyLift` and `positiveLiftRatio` for model directional edge.",
        "- Use completion `significancePassRatio/meanPbo/meanDsrProbability` to separate overfit vs robust gains.",
        "- If training metrics are similar but completion degrades, investigate validation protocol and gating interactions first.",
    ]
    return "\n".join(lines) + "\n"


def ensure_output(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def main() -> None:
    args = parse_args()

    baseline_root = Path(args.baseline_root)
    output_dir = Path(args.output_dir)
    logs_dir = Path(args.logs_dir)

    baseline_summary_path = baseline_root / "retrain" / "summary.json"
    if not baseline_summary_path.exists():
        raise FileNotFoundError(f"baseline summary not found: {baseline_summary_path}")

    baseline_summary_data = summary_metrics(read_json(baseline_summary_path))
    baseline_completion_data: Optional[Dict[str, Any]] = None
    baseline_completion_path: Optional[Path] = None

    if args.baseline_completion:
        baseline_completion_path = Path(args.baseline_completion)
        baseline_completion_data = read_json(baseline_completion_path)
    else:
        baseline_completion_path, baseline_completion_data = choose_latest_completion(
            str(baseline_root), logs_dir
        )
    baseline_completion = completion_metrics(baseline_completion_data)

    ensure_output(output_dir)

    if args.matrix_root:
        matrix_root = Path(args.matrix_root)
        if not matrix_root.exists():
            raise FileNotFoundError(f"matrix root not found: {matrix_root}")
        cases = collect_matrix_cases(matrix_root)
        if not cases:
            raise RuntimeError(
                f"no completion_replay.json found under matrix root: {matrix_root}"
            )

        report_markdown = build_matrix_markdown(
            matrix_root=matrix_root,
            baseline_root=baseline_root,
            baseline_summary_path=baseline_summary_path,
            baseline_completion_path=baseline_completion_path,
            baseline_summary=baseline_summary_data,
            baseline_completion=baseline_completion,
            cases=cases,
            template_path=args.report_template,
        )
        (output_dir / "replay_comparison_matrix.md").write_text(
            report_markdown, encoding="utf-8"
        )
        matrix_payload = {
            "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
            "baseline": {
                "root": str(baseline_root),
                "summaryPath": str(baseline_summary_path),
                "completionPath": str(baseline_completion_path)
                if baseline_completion_path
                else None,
                "summary": baseline_summary_data,
                "completion": baseline_completion,
            },
            "matrix": {
                "root": str(matrix_root),
                "caseCount": len(cases),
                "cases": cases,
            },
            "reportTemplate": args.report_template,
        }
        (output_dir / "replay_comparison_matrix.json").write_text(
            json.dumps(matrix_payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        print(f"[compare] wrote markdown: {output_dir / 'replay_comparison_matrix.md'}")
        print(f"[compare] wrote json: {output_dir / 'replay_comparison_matrix.json'}")
        return

    if not args.replay_root:
        raise ValueError("replay root is required when --matrix-root is not provided")

    replay_root = Path(args.replay_root)
    replay_summary_path = replay_root / "retrain" / "summary.json"
    if not replay_summary_path.exists():
        raise FileNotFoundError(f"replay summary not found: {replay_summary_path}")
    replay_summary_data = summary_metrics(read_json(replay_summary_path))

    replay_completion_data: Optional[Dict[str, Any]] = None
    replay_completion_path: Optional[Path] = None

    if args.replay_completion:
        replay_completion_path = Path(args.replay_completion)
        replay_completion_data = read_json(replay_completion_path)
    else:
        replay_completion_path, replay_completion_data = choose_latest_completion(
            str(replay_root), logs_dir
        )
    replay_completion = completion_metrics(replay_completion_data)

    report_markdown = build_comparison_markdown(
        baseline_root=str(baseline_root),
        replay_root=str(replay_root),
        baseline_summary_path=baseline_summary_path,
        replay_summary_path=replay_summary_path,
        baseline_completion_path=baseline_completion_path,
        replay_completion_path=replay_completion_path,
        baseline_summary=baseline_summary_data,
        replay_summary=replay_summary_data,
        baseline_completion=baseline_completion,
        replay_completion=replay_completion,
        template_path=args.report_template,
    )

    (output_dir / "replay_comparison.md").write_text(report_markdown, encoding="utf-8")
    payload = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "baseline": {
            "root": str(baseline_root),
            "summaryPath": str(baseline_summary_path),
            "completionPath": str(baseline_completion_path)
            if baseline_completion_path
            else None,
            "summary": baseline_summary_data,
            "completion": baseline_completion,
        },
        "replay": {
            "root": str(replay_root),
            "summaryPath": str(replay_summary_path),
            "completionPath": str(replay_completion_path)
            if replay_completion_path
            else None,
            "summary": replay_summary_data,
            "completion": replay_completion,
        },
        "reportTemplate": args.report_template,
    }
    (output_dir / "replay_comparison.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(f"[compare] wrote markdown: {output_dir / 'replay_comparison.md'}")
    print(f"[compare] wrote json: {output_dir / 'replay_comparison.json'}")


if __name__ == "__main__":
    main()
