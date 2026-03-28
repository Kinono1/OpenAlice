#!/usr/bin/env python3
"""Diagnose why G3/G4 FDR gets stuck by inspecting candidate p-value distributions."""

from __future__ import annotations

import argparse
import datetime as dt
import glob
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


SCHEMA_VERSION = "fdr_bottleneck_report.v1"
DEFAULT_RUNS_GLOB = (
    "data/research/strategy/runs/archive/B-*/data/research/strategy/strategy_validation_runs.json"
)
DEFAULT_OUTPUT = "data/research/strategy/analysis/g3g4/latest_fdr_bottleneck_report.v1.json"
DEFAULT_MARKDOWN = "data/research/strategy/analysis/g3g4/latest_fdr_bottleneck_report.md"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Diagnose FDR bottlenecks from archived strategy_validation_runs payloads."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--runs-glob",
        default=DEFAULT_RUNS_GLOB,
        help="Glob pattern for strategy_validation_runs JSON files.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Output JSON report path.",
    )
    parser.add_argument(
        "--markdown",
        default=DEFAULT_MARKDOWN,
        help="Output markdown report path.",
    )
    parser.add_argument(
        "--default-alpha",
        type=float,
        default=0.1,
        help="Fallback FDR alpha when a run payload has no threshold.",
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
        raise ValueError(f"json root is not object: {path}")
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


def percentile(values: Sequence[float], q: float) -> float:
    if not values:
        return math.nan
    if len(values) == 1:
        return float(values[0])
    sorted_values = sorted(values)
    index = (len(sorted_values) - 1) * q
    lo = int(math.floor(index))
    hi = int(math.ceil(index))
    if lo == hi:
        return float(sorted_values[lo])
    weight = index - lo
    return float(sorted_values[lo] * (1 - weight) + sorted_values[hi] * weight)


def infer_run_id(path: Path) -> str:
    parts = list(path.parts)
    if "archive" in parts:
        idx = parts.index("archive")
        if idx + 1 < len(parts):
            return parts[idx + 1]
    return path.parent.name


def infer_generated_at(payload: Dict[str, Any]) -> str:
    raw = payload.get("generatedAt")
    if isinstance(raw, str) and raw.strip():
        return raw.strip()
    return ""


def derive_alpha(payload: Dict[str, Any], default_alpha: float) -> float:
    config = payload.get("config", {})
    thresholds = config.get("thresholds", {}) if isinstance(config, dict) else {}
    alpha = to_float(thresholds.get("fdrQMax")) if isinstance(thresholds, dict) else None
    if alpha is not None and 0 < alpha <= 1:
        return alpha
    aggregate = payload.get("aggregateMetrics", {})
    fdr_diag = aggregate.get("fdrDiagnostics", {}) if isinstance(aggregate, dict) else {}
    alpha = to_float(fdr_diag.get("alpha")) if isinstance(fdr_diag, dict) else None
    if alpha is not None and 0 < alpha <= 1:
        return alpha
    return float(default_alpha)


def collect_p_values(payload: Dict[str, Any]) -> Tuple[List[float], List[float]]:
    candidates = payload.get("candidates", [])
    if not isinstance(candidates, list):
        return [], []
    p_values: List[float] = []
    q_values: List[float] = []
    for row in candidates:
        if not isinstance(row, dict):
            continue
        fdr = row.get("fdr", {})
        p_value = to_float(fdr.get("pValue")) if isinstance(fdr, dict) else None
        if p_value is None:
            significance = row.get("significance", {})
            dsr_probability = (
                to_float(significance.get("dsrProbability"))
                if isinstance(significance, dict)
                else None
            )
            if dsr_probability is not None:
                p_value = max(0.0, min(1.0, 1.0 - dsr_probability))
        q_value = to_float(fdr.get("qValue")) if isinstance(fdr, dict) else None
        if p_value is not None:
            p_values.append(float(p_value))
        if q_value is not None:
            q_values.append(float(q_value))
    return p_values, q_values


def build_rank_thresholds(alpha: float, candidate_count: int) -> List[Dict[str, Any]]:
    if candidate_count <= 0:
        return []
    rows: List[Dict[str, Any]] = []
    for rank in range(1, candidate_count + 1):
        p_threshold = (rank * alpha) / candidate_count
        rows.append(
            {
                "rank": rank,
                "pThreshold": round(p_threshold, 10),
                "requiredMinDsrProbability": round(1.0 - p_threshold, 10),
            }
        )
    return rows


def classify_diagnosis(
    *,
    alpha: float,
    p_values: Sequence[float],
    fdr_q: Optional[float],
) -> Tuple[str, str]:
    if not p_values:
        return "insufficient_data", "No candidate p-values are available for FDR diagnosis."

    p_median = percentile(p_values, 0.5)
    lt_alpha = sum(1 for value in p_values if value < alpha)
    lt_alpha_half = sum(1 for value in p_values if value < (alpha / 2.0))

    if lt_alpha == 0 and p_median > 0.2:
        return (
            "strategy_signal_limited",
            "All candidate p-values are above alpha and median p-value is high (>0.2), "
            "so the candidate signal itself is not statistically strong enough.",
        )
    if lt_alpha_half > 0 and fdr_q is not None and fdr_q > alpha:
        return (
            "correction_limited",
            "There are low raw p-values but q-values remain above alpha, indicating "
            "multiple-testing correction and ranking are the binding bottlenecks.",
        )
    return (
        "mixed_limited",
        "The run shows mixed constraints across p-value quality and correction effects.",
    )


def summarize_one_run(path: Path, default_alpha: float) -> Dict[str, Any]:
    payload = read_json_object(path)
    run_id = infer_run_id(path)
    generated_at = infer_generated_at(payload)
    alpha = derive_alpha(payload, default_alpha)
    p_values, q_values = collect_p_values(payload)
    aggregate = payload.get("aggregateMetrics", {})
    fdr_q = to_float(aggregate.get("fdrQ")) if isinstance(aggregate, dict) else None
    if fdr_q is None and q_values:
        fdr_q = max(q_values)

    candidate_count = len(p_values)
    diagnosis, why = classify_diagnosis(alpha=alpha, p_values=p_values, fdr_q=fdr_q)

    p_stats = {
        "min": min(p_values) if p_values else None,
        "max": max(p_values) if p_values else None,
        "mean": (sum(p_values) / len(p_values)) if p_values else None,
        "median": percentile(p_values, 0.5) if p_values else None,
        "q25": percentile(p_values, 0.25) if p_values else None,
        "q75": percentile(p_values, 0.75) if p_values else None,
    }

    counts = {
        "lt_0_05": sum(1 for value in p_values if value < 0.05),
        "lt_0_10": sum(1 for value in p_values if value < 0.1),
        "lt_alpha": sum(1 for value in p_values if value < alpha),
        "ge_0_30": sum(1 for value in p_values if value >= 0.3),
    }

    return {
        "runId": run_id,
        "path": str(path),
        "generatedAt": generated_at,
        "alpha": alpha,
        "candidateCount": candidate_count,
        "fdrQ": fdr_q,
        "pValues": p_values,
        "qValues": q_values,
        "pValueStats": p_stats,
        "counts": counts,
        "diagnosis": diagnosis,
        "whyFdrQStuck": why,
        "bhFeasibility": {
            "alpha": alpha,
            "candidateCount": candidate_count,
            "rankThresholds": build_rank_thresholds(alpha=alpha, candidate_count=candidate_count),
        },
    }


def build_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# FDR Bottleneck Diagnosis")
    lines.append("")
    lines.append(f"- Generated at: `{report.get('generatedAt')}`")
    lines.append(f"- Runs inspected: `{report.get('summary', {}).get('runCount', 0)}`")
    lines.append(
        f"- Latest diagnosis: `{report.get('summary', {}).get('latestDiagnosis', 'n/a')}`"
    )
    lines.append("")
    lines.append("| runId | fdrQ | alpha | p<0.1 | median p | diagnosis |")
    lines.append("| --- | ---: | ---: | ---: | ---: | --- |")
    for row in report.get("runs", []):
        counts = row.get("counts", {})
        p_stats = row.get("pValueStats", {})
        lines.append(
            "| {run} | {fdr_q} | {alpha} | {lt01} | {median_p} | {diag} |".format(
                run=row.get("runId", ""),
                fdr_q=row.get("fdrQ"),
                alpha=row.get("alpha"),
                lt01=counts.get("lt_0_10"),
                median_p=p_stats.get("median"),
                diag=row.get("diagnosis", ""),
            )
        )
    latest = report.get("latest", {})
    if isinstance(latest, dict) and latest:
        lines.append("")
        lines.append("## Latest Run Diagnosis")
        lines.append("")
        lines.append(f"- runId: `{latest.get('runId')}`")
        lines.append(f"- why_fdrq_stuck: {latest.get('whyFdrQStuck')}")
        lines.append("- rank thresholds:")
        for row in latest.get("bhFeasibility", {}).get("rankThresholds", []):
            lines.append(
                "  - rank {rank}: p <= {pth}, requires dsrProbability >= {dsr}".format(
                    rank=row.get("rank"),
                    pth=row.get("pThreshold"),
                    dsr=row.get("requiredMinDsrProbability"),
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
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))

    matched_paths = [
        Path(raw).resolve()
        for raw in glob.glob(str(resolve_path(repo_root, str(args.runs_glob))), recursive=True)
    ]
    matched_paths = [path for path in matched_paths if path.is_file()]
    matched_paths.sort()

    runs: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for path in matched_paths:
        try:
            runs.append(summarize_one_run(path=path, default_alpha=float(args.default_alpha)))
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"failed to parse {path}: {exc}")

    runs.sort(key=lambda row: (str(row.get("generatedAt") or ""), str(row.get("runId") or "")))
    latest = runs[-1] if runs else {}

    diagnosis_counts: Dict[str, int] = {}
    for row in runs:
        key = str(row.get("diagnosis", "unknown"))
        diagnosis_counts[key] = diagnosis_counts.get(key, 0) + 1

    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "source": {
            "runsGlob": str(args.runs_glob),
            "matchedRuns": len(matched_paths),
        },
        "summary": {
            "runCount": len(runs),
            "latestRunId": latest.get("runId") if isinstance(latest, dict) else None,
            "latestDiagnosis": latest.get("diagnosis") if isinstance(latest, dict) else None,
            "diagnosisCounts": diagnosis_counts,
        },
        "latest": latest,
        "runs": runs,
        "warnings": warnings,
    }
    write_json(output_path, report)
    write_markdown(markdown_path, build_markdown(report))

    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "markdown": str(markdown_path),
                "runCount": len(runs),
                "latestRunId": latest.get("runId") if isinstance(latest, dict) else None,
                "latestDiagnosis": latest.get("diagnosis") if isinstance(latest, dict) else None,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

