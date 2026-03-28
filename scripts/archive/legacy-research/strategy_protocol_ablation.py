#!/usr/bin/env python3
"""Run protocol ablation for G3/G4 recovery with fixed hard thresholds.

Compares multiple WFO protocol profiles against the same candidate set and
produces a protocol-first ranking:
1) lower WFO failure density
2) lower hard-threshold gap
3) lower FDR gap
4) higher mean Sharpe
"""

from __future__ import annotations

import argparse
import copy
import datetime as dt
import json
import math
import shlex
import subprocess
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple


WFO_PROFILE_OVERRIDES: Dict[str, Dict[str, int]] = {
    "stable": {},
    "shift": {"trainBars": 720, "testBars": 120, "stepBars": 120},
    "stress": {"trainBars": 600, "testBars": 120, "stepBars": 60},
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run protocol ablation on WFO profiles and rank by protocol-first objective."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--base-candidates",
        default="docs/research/strategy_candidates.v1.json",
        help="Base candidate config used for every profile.",
    )
    parser.add_argument(
        "--out-dir",
        default="data/research/strategy/analysis/g3g4",
        help="Output directory for latest/archive reports.",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id. Default uses UTC timestamp.",
    )
    parser.add_argument(
        "--profiles",
        default="stable,shift,stress",
        help="Comma-separated profile names. Allowed: stable,shift,stress.",
    )
    parser.add_argument(
        "--pnpm-bin",
        default="pnpm",
        help="pnpm executable used to call strategy validation.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan/report only without invoking strategy validation.",
    )
    return parser.parse_args()


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    p = Path(raw)
    return p if p.is_absolute() else (root / p).resolve()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def to_float(raw: Any, default: Optional[float] = None) -> Optional[float]:
    try:
        if raw is None:
            return default
        return float(raw)
    except Exception:
        return default


def parse_profiles(raw: str) -> List[str]:
    profiles = [part.strip() for part in raw.split(",") if part.strip()]
    if not profiles:
        raise ValueError("at least one profile is required.")
    invalid = [name for name in profiles if name not in WFO_PROFILE_OVERRIDES]
    if invalid:
        raise ValueError(
            f"invalid profile(s): {','.join(invalid)}; allowed=stable,shift,stress"
        )
    deduped: List[str] = []
    seen = set()
    for profile in profiles:
        if profile in seen:
            continue
        seen.add(profile)
        deduped.append(profile)
    return deduped


def apply_profile_to_config(base_cfg: Dict[str, Any], profile: str) -> Dict[str, Any]:
    cfg = copy.deepcopy(base_cfg)
    wfo = cfg.get("wfo", {})
    if not isinstance(wfo, dict):
        wfo = {}
    override = WFO_PROFILE_OVERRIDES.get(profile, {})
    wfo.update(override)
    cfg["wfo"] = wfo
    return cfg


def mean(values: Sequence[Optional[float]]) -> Optional[float]:
    filtered = [v for v in values if v is not None and math.isfinite(v)]
    if not filtered:
        return None
    return float(sum(filtered) / len(filtered))


def compute_hard_gap(
    *,
    mean_pbo: Optional[float],
    mean_dsr: Optional[float],
    fdr_q: Optional[float],
    thresholds: Dict[str, Any],
) -> Dict[str, Optional[float]]:
    pbo_max = to_float(thresholds.get("meanPboMax"), 0.2)
    dsr_min = to_float(thresholds.get("meanDsrProbabilityMin"), 0.5)
    fdr_max = to_float(thresholds.get("fdrQMax"), 0.1)
    if mean_pbo is None or mean_dsr is None or fdr_q is None:
        return {
            "pboGap": None,
            "dsrGap": None,
            "fdrGap": None,
            "totalGap": None,
            "fdrThreshold": fdr_max,
        }
    pbo_gap = max(0.0, mean_pbo - float(pbo_max))
    dsr_gap = max(0.0, float(dsr_min) - mean_dsr)
    fdr_gap = max(0.0, fdr_q - float(fdr_max))
    return {
        "pboGap": pbo_gap,
        "dsrGap": dsr_gap,
        "fdrGap": fdr_gap,
        "totalGap": pbo_gap + dsr_gap + fdr_gap,
        "fdrThreshold": fdr_max,
    }


def summarize_wfo_failure_density(runs_payload: Dict[str, Any]) -> Optional[float]:
    candidates = runs_payload.get("candidates", [])
    if not isinstance(candidates, list):
        return None
    failed_windows = 0
    total_windows = 0
    for row in candidates:
        if not isinstance(row, dict):
            continue
        wfo_summary = row.get("wfoSummary", {})
        if not isinstance(wfo_summary, dict):
            continue
        fw = wfo_summary.get("failedWindows")
        tw = wfo_summary.get("totalWindows")
        if isinstance(fw, int) and isinstance(tw, int) and tw > 0:
            failed_windows += fw
            total_windows += tw
    if total_windows <= 0:
        return None
    return failed_windows / total_windows


def run_validation(
    *,
    repo_root: Path,
    pnpm_bin: str,
    profile: str,
    candidates_path: Path,
    runs_out: Path,
    verdict_out: Path,
    release_out: Path,
) -> Dict[str, Any]:
    argv = [
        pnpm_bin,
        "tsx",
        "scripts/run_strategy_mvp_validation.ts",
        "--candidates",
        str(candidates_path),
        "--output",
        str(runs_out),
        "--verdict-output",
        str(verdict_out),
        "--release-gate-status-path",
        str(release_out),
        "--wfo-profile",
        profile,
    ]
    proc = subprocess.run(
        argv,
        cwd=str(repo_root),
        text=True,
        capture_output=True,
        check=False,
    )
    return {
        "command": " ".join(shlex.quote(part) for part in argv),
        "exitCode": proc.returncode,
        "stdoutTail": (proc.stdout or "")[-4000:],
        "stderrTail": (proc.stderr or "")[-4000:],
    }


def rank_key(row: Dict[str, Any]) -> Tuple[float, ...]:
    missing_penalty = 1.0 if row.get("hasMetrics") else 0.0
    wfo_failure_density = to_float(row.get("wfoFailureDensity"), 9.0) or 9.0
    total_gap = to_float((row.get("hardGap") or {}).get("totalGap"), 9.0) or 9.0
    fdr_gap = to_float((row.get("hardGap") or {}).get("fdrGap"), 9.0) or 9.0
    mean_sharpe = to_float(row.get("meanSharpe"), -9.0) or -9.0
    return (
        missing_penalty,
        wfo_failure_density,
        total_gap,
        fdr_gap,
        -mean_sharpe,
    )


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Strategy Protocol Ablation Report")
    lines.append("")
    lines.append(f"- run_id: `{payload.get('run_id', '')}`")
    lines.append(f"- generated_at: `{payload.get('generated_at', '')}`")
    lines.append(f"- dry_run: `{payload.get('dry_run', False)}`")
    lines.append(f"- profiles: `{','.join(payload.get('profilesRequested', []))}`")
    lines.append(f"- recommendedProfile: `{payload.get('recommendedProfile')}`")
    lines.append(f"- rankingObjective: `{payload.get('rankingObjective')}`")
    summary = payload.get("summary", {})
    lines.append(f"- validProfiles: `{summary.get('validProfiles', 0)}`")
    lines.append(f"- goProfiles: `{summary.get('goProfiles', 0)}`")
    lines.append("")
    lines.append(
        "| rank | profile | result | wfoFailureDensity | hardGapTotal | fdrGap | meanSharpe |"
    )
    lines.append("|---:|---|---|---:|---:|---:|---:|")
    for idx, row in enumerate(payload.get("rankedProfiles", []), start=1):
        lines.append(
            "| "
            + " | ".join(
                [
                    str(idx),
                    str(row.get("profile", "")),
                    str(row.get("result", "")),
                    str(row.get("wfoFailureDensity", "")),
                    str((row.get("hardGap") or {}).get("totalGap", "")),
                    str((row.get("hardGap") or {}).get("fdrGap", "")),
                    str(row.get("meanSharpe", "")),
                ]
            )
            + " |"
        )
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if args.repo_root
        else Path(__file__).resolve().parents[1]
    )
    ts = now_utc()
    run_id = args.run_id.strip() or ts.strftime("%Y%m%dT%H%M%SZ")
    profiles = parse_profiles(args.profiles)
    out_dir = resolve_path(repo_root, args.out_dir)
    archive_dir = out_dir / "archive" / run_id
    base_candidates_path = resolve_path(repo_root, args.base_candidates)
    base_cfg = read_json(base_candidates_path)
    if not isinstance(base_cfg, dict):
        raise ValueError("base candidates config must be a JSON object.")

    rows: List[Dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="openalice-protocol-ablation-") as temp_dir:
        tmp = Path(temp_dir)
        for profile in profiles:
            cfg = apply_profile_to_config(base_cfg, profile)
            candidate_path = tmp / f"protocol_{profile}_candidates.json"
            runs_path = tmp / f"protocol_{profile}_runs.json"
            verdict_path = tmp / f"protocol_{profile}_verdict.json"
            release_path = tmp / f"protocol_{profile}_release.json"
            candidate_path.write_text(
                json.dumps(cfg, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            command_info = {
                "command": "",
                "exitCode": None,
                "stdoutTail": "",
                "stderrTail": "",
            }
            runs_payload: Dict[str, Any] = {}
            verdict_payload: Dict[str, Any] = {}

            if not args.dry_run:
                command_info = run_validation(
                    repo_root=repo_root,
                    pnpm_bin=args.pnpm_bin,
                    profile=profile,
                    candidates_path=candidate_path,
                    runs_out=runs_path,
                    verdict_out=verdict_path,
                    release_out=release_path,
                )
                if runs_path.exists():
                    raw = read_json(runs_path)
                    if isinstance(raw, dict):
                        runs_payload = raw
                if verdict_path.exists():
                    raw = read_json(verdict_path)
                    if isinstance(raw, dict):
                        verdict_payload = raw

            verdict_metrics = verdict_payload.get("aggregateMetrics", {})
            if not isinstance(verdict_metrics, dict):
                verdict_metrics = {}
            verdict_thresholds = verdict_payload.get("thresholds", {})
            if not isinstance(verdict_thresholds, dict):
                verdict_thresholds = cfg.get("thresholds", {})
                if not isinstance(verdict_thresholds, dict):
                    verdict_thresholds = {}

            mean_pbo = to_float(verdict_metrics.get("meanPbo"))
            mean_dsr = to_float(verdict_metrics.get("meanDsrProbability"))
            fdr_q = to_float(verdict_metrics.get("fdrQ"))
            hard_gap = compute_hard_gap(
                mean_pbo=mean_pbo,
                mean_dsr=mean_dsr,
                fdr_q=fdr_q,
                thresholds=verdict_thresholds,
            )

            candidates = runs_payload.get("candidates", [])
            if not isinstance(candidates, list):
                candidates = []
            mean_sharpe = mean(
                [
                    to_float((row.get("backtestMetrics") or {}).get("sharpe"))
                    for row in candidates
                    if isinstance(row, dict)
                ]
            )
            row = {
                "profile": profile,
                "result": verdict_payload.get("result", "UNKNOWN"),
                "reasonCodes": verdict_payload.get("reasonCodes", []),
                "meanPbo": mean_pbo,
                "meanDsrProbability": mean_dsr,
                "fdrQ": fdr_q,
                "meanSharpe": mean_sharpe,
                "hardGap": hard_gap,
                "wfoFailureDensity": summarize_wfo_failure_density(runs_payload),
                "hasMetrics": bool(verdict_payload),
                "command": command_info,
            }
            rows.append(row)

    ranked_profiles = sorted(rows, key=rank_key)
    valid_profiles = [row for row in rows if row.get("hasMetrics")]
    go_profiles = sum(1 for row in valid_profiles if row.get("result") == "GO")
    recommended_profile = ranked_profiles[0]["profile"] if ranked_profiles else None

    payload = {
        "schemaVersion": "strategy_protocol_ablation.v1",
        "run_id": run_id,
        "generated_at": iso(ts),
        "dry_run": bool(args.dry_run),
        "baseCandidatesPath": str(base_candidates_path),
        "profilesRequested": profiles,
        "rankingObjective": (
            "min(wfoFailureDensity) -> min(hardGapTotal) -> "
            "min(fdrGap) -> max(meanSharpe)"
        ),
        "recommendedProfile": recommended_profile,
        "summary": {
            "profileCount": len(rows),
            "validProfiles": len(valid_profiles),
            "goProfiles": go_profiles,
        },
        "profiles": rows,
        "rankedProfiles": ranked_profiles,
    }
    markdown = render_markdown(payload)

    latest_json = out_dir / "latest_protocol_ablation.json"
    latest_md = out_dir / "latest_protocol_ablation.md"
    archive_json = archive_dir / "protocol_ablation.json"
    archive_md = archive_dir / "protocol_ablation.md"
    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "archive_json": str(archive_json),
                "archive_md": str(archive_md),
                "recommended_profile": recommended_profile,
                "valid_profiles": len(valid_profiles),
                "go_profiles": go_profiles,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
