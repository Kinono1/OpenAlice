#!/usr/bin/env python3
"""Strategy admission gate with layered whitelist policy.

Decision chain:
1) Route split (directional vs market_making)
2) License policy (permissive integration vs external-runner-only vs reject)
3) Main gate (eligible=true)
4) Transfer gate (transfer_pass=true)
5) Stability gate (consecutive cycles >= threshold)
6) Shadow gate (shadow_pass=true)
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

DEFAULT_EXTERNAL_REPORT = (
    "data/research/external-benchmark/latest_external_benchmark_report.json"
)
DEFAULT_OUT_DIR = "data/research/strategy-watch/admission"
DEFAULT_POLICY_FILE = (
    "data/research/strategy-watch/policies/strategy_admission_policy.json"
)

PERMISSIVE_LICENSES = {
    "MIT",
    "APACHE-2.0",
    "BSD-2-CLAUSE",
    "BSD-3-CLAUSE",
    "MPL-2.0",
}

RESTRICTED_LICENSE_HINTS = {
    "GPL",
    "AGPL",
    "LGPL",
    "COMMONS",
    "NOASSERTION",
    "OTHER",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Apply layered strategy admission policy and produce whitelist decisions."
        )
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--external-report",
        default=DEFAULT_EXTERNAL_REPORT,
        help="Path to latest external benchmark report JSON.",
    )
    parser.add_argument(
        "--policy-file",
        default=DEFAULT_POLICY_FILE,
        help="Policy JSON path (will be created from defaults if missing).",
    )
    parser.add_argument(
        "--out-dir",
        default=DEFAULT_OUT_DIR,
        help="Output directory for admission reports.",
    )
    parser.add_argument(
        "--min-stability-cycles",
        type=int,
        default=2,
        help="Minimum consecutive stable cycles required before shadow admit.",
    )
    parser.add_argument(
        "--create-policy-if-missing",
        action="store_true",
        default=True,
        help="Create default policy file when missing.",
    )
    parser.add_argument(
        "--no-create-policy-if-missing",
        dest="create_policy_if_missing",
        action="store_false",
        help="Do not create policy file automatically.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Do not write files; print JSON payload.",
    )
    argv = sys.argv[1:]
    if argv and argv[0] == "--":
        argv = argv[1:]
    return parser.parse_args(argv)


def now_utc() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso(ts: dt.datetime) -> str:
    return ts.astimezone(dt.timezone.utc).isoformat()


def resolve_path(root: Path, raw: str) -> Path:
    path = Path(raw)
    return path if path.is_absolute() else (root / path).resolve()


def parse_bool(value: Any) -> Optional[bool]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    return None


def to_int(value: Any, default: int = 0) -> int:
    try:
        if value is None or str(value).strip() == "":
            return default
        return int(value)
    except Exception:
        return default


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def load_json(path: Path) -> Tuple[Optional[Any], Optional[str]]:
    if not path.exists():
        return None, f"missing file: {path}"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return payload, None
    except Exception as exc:
        return None, f"invalid json {path}: {exc}"


def normalize_license(raw: Any) -> str:
    text = str(raw or "").strip().upper()
    return text


def is_permissive_license(license_id: str) -> bool:
    if license_id in PERMISSIVE_LICENSES:
        return True
    return False


def is_restricted_license(license_id: str) -> bool:
    if not license_id:
        return False
    if license_id in PERMISSIVE_LICENSES:
        return False
    for hint in RESTRICTED_LICENSE_HINTS:
        if hint in license_id:
            return True
    return False


def default_policy_payload(min_stability_cycles: int) -> Dict[str, Any]:
    return {
        "version": "2026-02-27-r1",
        "updated_at": iso(now_utc()),
        "default_min_stability_cycles": int(min_stability_cycles),
        "notes": [
            "directional策略必须串行通过 main->transfer->stability->shadow 才能进白名单",
            "market_making策略单独赛道，不与directional同门控",
            "GPL/AGPL/Commons类许可默认不允许代码级集成，可选外部runner模式",
        ],
        "strategies": [],
    }


def ensure_policy(
    policy_path: Path,
    create_if_missing: bool,
    min_stability_cycles: int,
) -> Tuple[Dict[str, Any], List[str]]:
    warnings: List[str] = []
    payload, err = load_json(policy_path)
    if err is None and isinstance(payload, dict):
        return payload, warnings
    if not create_if_missing:
        warnings.append(err or f"failed to load policy: {policy_path}")
        return default_policy_payload(min_stability_cycles), warnings
    default_payload = default_policy_payload(min_stability_cycles)
    write_json(policy_path, default_payload)
    warnings.append(f"created default policy file: {policy_path}")
    return default_payload, warnings


def policy_map(policy_payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    rows = policy_payload.get("strategies", [])
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        run_id = str(row.get("run_id") or "").strip()
        if not run_id:
            continue
        out[run_id] = row
    return out


def manifest_map(report_payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    manifest_raw = report_payload.get("manifest")
    if not manifest_raw:
        return result
    manifest_path = Path(str(manifest_raw))
    payload, err = load_json(manifest_path)
    if err is not None or not isinstance(payload, dict):
        return result
    runs = payload.get("runs")
    if not isinstance(runs, list):
        return result
    for row in runs:
        if not isinstance(row, dict):
            continue
        run_id = str(row.get("run_id") or "").strip()
        if not run_id:
            continue
        result[run_id] = row
    return result


def aggregate_map(report_payload: Dict[str, Any]) -> Dict[str, Dict[str, Any]]:
    out: Dict[str, Dict[str, Any]] = {}
    rows = report_payload.get("aggregate")
    if not isinstance(rows, list):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        run_id = str(row.get("run_id") or "").strip()
        if not run_id:
            continue
        out[run_id] = row
    return out


def strategy_ids(
    aggregate_rows: Dict[str, Dict[str, Any]],
    manifest_rows: Dict[str, Dict[str, Any]],
    policy_rows: Dict[str, Dict[str, Any]],
) -> List[str]:
    merged = list(
        dict.fromkeys(
            list(aggregate_rows.keys())
            + list(manifest_rows.keys())
            + list(policy_rows.keys())
        )
    )
    return merged


def pick_meta(
    run_id: str,
    aggregate_row: Dict[str, Any],
    manifest_row: Dict[str, Any],
    policy_row: Dict[str, Any],
) -> Dict[str, Any]:
    framework = (
        str(policy_row.get("framework") or "")
        or str(manifest_row.get("framework") or "")
        or str(aggregate_row.get("framework") or "")
    ).strip()
    strategy = (
        str(policy_row.get("strategy") or "")
        or str(manifest_row.get("strategy") or "")
        or str(aggregate_row.get("strategy") or "")
    ).strip()
    route = (
        (
            str(policy_row.get("route") or "")
            or str(manifest_row.get("route") or "")
            or "directional"
        )
        .strip()
        .lower()
    )
    license_id = normalize_license(
        policy_row.get("source_license") or manifest_row.get("source_license") or ""
    )
    allow_external_runner = parse_bool(
        policy_row.get("allow_external_runner")
        if "allow_external_runner" in policy_row
        else manifest_row.get("allow_external_runner")
    )
    transfer_pass = parse_bool(
        policy_row.get("transfer_pass")
        if "transfer_pass" in policy_row
        else manifest_row.get("transfer_pass")
    )
    stability_cycles = to_int(
        policy_row.get("stability_cycles_passed")
        if "stability_cycles_passed" in policy_row
        else manifest_row.get("stability_cycles_passed"),
        default=0,
    )
    shadow_pass = parse_bool(
        policy_row.get("shadow_pass")
        if "shadow_pass" in policy_row
        else manifest_row.get("shadow_pass")
    )
    min_stability_cycles = to_int(policy_row.get("min_stability_cycles"), default=0)

    return {
        "run_id": run_id,
        "framework": framework,
        "strategy": strategy,
        "route": route,
        "source_license": license_id,
        "allow_external_runner": bool(allow_external_runner is True),
        "transfer_pass": transfer_pass,
        "stability_cycles_passed": stability_cycles,
        "shadow_pass": shadow_pass,
        "min_stability_cycles": min_stability_cycles,
    }


def bool_to_text(value: Optional[bool]) -> str:
    if value is None:
        return "unknown"
    return "true" if value else "false"


def decide_strategy(
    meta: Dict[str, Any],
    aggregate_row: Dict[str, Any],
    default_min_stability_cycles: int,
) -> Dict[str, Any]:
    reasons: List[str] = []
    route = str(meta.get("route") or "directional").lower()
    license_id = str(meta.get("source_license") or "").upper()
    allow_external_runner = bool(meta.get("allow_external_runner") is True)
    main_eligible = parse_bool(aggregate_row.get("eligible"))
    transfer_pass = meta.get("transfer_pass")
    stability_cycles = int(meta.get("stability_cycles_passed") or 0)
    shadow_pass = meta.get("shadow_pass")
    required_stability = int(meta.get("min_stability_cycles") or 0)
    if required_stability <= 0:
        required_stability = int(default_min_stability_cycles)

    license_mode = "unknown"
    code_integration_allowed = False

    if route == "market_making":
        return {
            "license_mode": license_mode,
            "code_integration_allowed": False,
            "decision": "separate_track",
            "stage": "market_making_track",
            "main_eligible": main_eligible,
            "transfer_pass": transfer_pass,
            "stability_cycles_passed": stability_cycles,
            "shadow_pass": shadow_pass,
            "required_stability_cycles": required_stability,
            "reasons": [
                "market_making strategy must run in dedicated track and gate set"
            ],
        }

    if not license_id:
        license_mode = "unknown"
        reasons.append("source_license missing")
    elif is_permissive_license(license_id):
        license_mode = "permissive"
        code_integration_allowed = True
    elif is_restricted_license(license_id):
        if allow_external_runner:
            license_mode = "restricted_external_runner_only"
            code_integration_allowed = False
            reasons.append(
                "restricted license: only external-runner integration is allowed"
            )
        else:
            license_mode = "restricted_blocked"
            reasons.append(
                "restricted license without external_runner override: rejected"
            )
            return {
                "license_mode": license_mode,
                "code_integration_allowed": False,
                "decision": "reject_license",
                "stage": "license",
                "main_eligible": main_eligible,
                "transfer_pass": transfer_pass,
                "stability_cycles_passed": stability_cycles,
                "shadow_pass": shadow_pass,
                "required_stability_cycles": required_stability,
                "reasons": reasons,
            }
    else:
        license_mode = "non_permissive_unknown"
        if allow_external_runner:
            reasons.append("non-permissive/unknown license: external-runner-only")
        else:
            reasons.append("unknown license and no override")
            return {
                "license_mode": license_mode,
                "code_integration_allowed": False,
                "decision": "reject_license",
                "stage": "license",
                "main_eligible": main_eligible,
                "transfer_pass": transfer_pass,
                "stability_cycles_passed": stability_cycles,
                "shadow_pass": shadow_pass,
                "required_stability_cycles": required_stability,
                "reasons": reasons,
            }

    if main_eligible is not True:
        reasons.append("main gate not passed (eligible != true)")
        return {
            "license_mode": license_mode,
            "code_integration_allowed": code_integration_allowed,
            "decision": "hold_main_gate",
            "stage": "main",
            "main_eligible": main_eligible,
            "transfer_pass": transfer_pass,
            "stability_cycles_passed": stability_cycles,
            "shadow_pass": shadow_pass,
            "required_stability_cycles": required_stability,
            "reasons": reasons,
        }

    if transfer_pass is not True:
        reasons.append("transfer_pass != true")
        return {
            "license_mode": license_mode,
            "code_integration_allowed": code_integration_allowed,
            "decision": "hold_transfer_gate",
            "stage": "transfer",
            "main_eligible": main_eligible,
            "transfer_pass": transfer_pass,
            "stability_cycles_passed": stability_cycles,
            "shadow_pass": shadow_pass,
            "required_stability_cycles": required_stability,
            "reasons": reasons,
        }

    if stability_cycles < required_stability:
        reasons.append(
            f"stability cycles insufficient: {stability_cycles} < {required_stability}"
        )
        return {
            "license_mode": license_mode,
            "code_integration_allowed": code_integration_allowed,
            "decision": "hold_stability",
            "stage": "stability",
            "main_eligible": main_eligible,
            "transfer_pass": transfer_pass,
            "stability_cycles_passed": stability_cycles,
            "shadow_pass": shadow_pass,
            "required_stability_cycles": required_stability,
            "reasons": reasons,
        }

    if shadow_pass is not True:
        reasons.append("shadow_pass != true")
        return {
            "license_mode": license_mode,
            "code_integration_allowed": code_integration_allowed,
            "decision": "hold_shadow",
            "stage": "shadow",
            "main_eligible": main_eligible,
            "transfer_pass": transfer_pass,
            "stability_cycles_passed": stability_cycles,
            "shadow_pass": shadow_pass,
            "required_stability_cycles": required_stability,
            "reasons": reasons,
        }

    reasons.append("all layered gates passed")
    return {
        "license_mode": license_mode,
        "code_integration_allowed": code_integration_allowed,
        "decision": "admit_whitelist",
        "stage": "whitelist",
        "main_eligible": main_eligible,
        "transfer_pass": transfer_pass,
        "stability_cycles_passed": stability_cycles,
        "shadow_pass": shadow_pass,
        "required_stability_cycles": required_stability,
        "reasons": reasons,
    }


def rank_decision(decision: str) -> int:
    # lower is better (ready first)
    order = {
        "admit_whitelist": 0,
        "hold_shadow": 1,
        "hold_stability": 2,
        "hold_transfer_gate": 3,
        "hold_main_gate": 4,
        "separate_track": 5,
        "reject_license": 6,
    }
    return order.get(decision, 9)


def render_markdown(payload: Dict[str, Any]) -> str:
    lines: List[str] = [
        "# Strategy Admission Gate Report",
        "",
        f"- generatedAt: `{payload.get('generated_at', '')}`",
        f"- externalReport: `{payload.get('external_report', '')}`",
        f"- policyFile: `{payload.get('policy_file', '')}`",
        f"- totalCandidates: `{payload.get('total_candidates', 0)}`",
        "",
        "## Decisions",
        "",
        "| run_id | framework | strategy | route | license | decision | stage | main | transfer | stability | shadow |",
        "|---|---|---|---|---|---|---|---|---|---:|---|",
    ]
    for row in payload.get("rows", []):
        lines.append(
            f"| {row.get('run_id', '')} | {row.get('framework', '')} | "
            f"{row.get('strategy', '')} | {row.get('route', '')} | "
            f"{row.get('source_license', '') or 'unknown'} | "
            f"{row.get('decision', '')} | {row.get('stage', '')} | "
            f"{bool_to_text(parse_bool(row.get('main_eligible')))} | "
            f"{bool_to_text(parse_bool(row.get('transfer_pass')))} | "
            f"{row.get('stability_cycles_passed', 0)}/"
            f"{row.get('required_stability_cycles', 0)} | "
            f"{bool_to_text(parse_bool(row.get('shadow_pass')))} |"
        )
    lines.append("")

    lines.extend(["## Summary", ""])
    for key, value in payload.get("decision_counts", {}).items():
        lines.append(f"- `{key}`: {value}")
    lines.append("")

    lines.extend(["## Details", ""])
    for row in payload.get("rows", []):
        lines.append(f"### {row.get('run_id', '')}")
        for reason in row.get("reasons", []):
            lines.append(f"- {reason}")
        lines.append("")

    warnings = payload.get("warnings", [])
    if warnings:
        lines.extend(["## Warnings", ""])
        for warning in warnings:
            lines.append(f"- {warning}")
        lines.append("")

    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    repo_root = (
        Path(args.repo_root).resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    external_report_path = resolve_path(repo_root, args.external_report)
    policy_path = resolve_path(repo_root, args.policy_file)
    out_dir = resolve_path(repo_root, args.out_dir)

    warnings: List[str] = []
    external_payload, err = load_json(external_report_path)
    if err is not None or not isinstance(external_payload, dict):
        payload = {
            "generated_at": iso(now_utc()),
            "external_report": str(external_report_path),
            "policy_file": str(policy_path),
            "total_candidates": 0,
            "rows": [],
            "decision_counts": {},
            "warnings": [err or "invalid external report"],
        }
        if args.dry_run:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
            return 0
        run_id = now_utc().strftime("%Y%m%dT%H%M%SZ")
        write_json(out_dir / "latest_strategy_admission_report.json", payload)
        write_text(
            out_dir / "latest_strategy_admission_report.md", render_markdown(payload)
        )
        write_json(
            out_dir / "archive" / run_id / "strategy_admission_report.json", payload
        )
        write_text(
            out_dir / "archive" / run_id / "strategy_admission_report.md",
            render_markdown(payload),
        )
        return 0

    policy_payload, policy_warnings = ensure_policy(
        policy_path=policy_path,
        create_if_missing=bool(args.create_policy_if_missing),
        min_stability_cycles=int(args.min_stability_cycles),
    )
    warnings.extend(policy_warnings)

    agg_rows = aggregate_map(external_payload)
    man_rows = manifest_map(external_payload)
    pol_rows = policy_map(policy_payload)

    default_min = to_int(
        policy_payload.get("default_min_stability_cycles"),
        default=int(args.min_stability_cycles),
    )
    if default_min <= 0:
        default_min = int(args.min_stability_cycles)

    rows: List[Dict[str, Any]] = []
    for run_id in strategy_ids(agg_rows, man_rows, pol_rows):
        agg = agg_rows.get(run_id, {})
        man = man_rows.get(run_id, {})
        pol = pol_rows.get(run_id, {})
        meta = pick_meta(
            run_id=run_id, aggregate_row=agg, manifest_row=man, policy_row=pol
        )
        decision_row = decide_strategy(
            meta=meta,
            aggregate_row=agg,
            default_min_stability_cycles=default_min,
        )
        row = {
            **meta,
            **decision_row,
        }
        rows.append(row)

    rows = sorted(
        rows,
        key=lambda r: (
            rank_decision(str(r.get("decision", ""))),
            str(r.get("run_id", "")),
        ),
    )
    decision_counts: Dict[str, int] = {}
    for row in rows:
        key = str(row.get("decision", "unknown"))
        decision_counts[key] = decision_counts.get(key, 0) + 1

    ts = now_utc()
    run_id = ts.strftime("%Y%m%dT%H%M%SZ")
    payload = {
        "generated_at": iso(ts),
        "run_id": run_id,
        "external_report": str(external_report_path),
        "policy_file": str(policy_path),
        "default_min_stability_cycles": default_min,
        "total_candidates": len(rows),
        "rows": rows,
        "decision_counts": decision_counts,
        "warnings": warnings,
    }
    markdown = render_markdown(payload)

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    latest_json = out_dir / "latest_strategy_admission_report.json"
    latest_md = out_dir / "latest_strategy_admission_report.md"
    archive_json = out_dir / "archive" / run_id / "strategy_admission_report.json"
    archive_md = out_dir / "archive" / run_id / "strategy_admission_report.md"
    write_json(latest_json, payload)
    write_text(latest_md, markdown)
    write_json(archive_json, payload)
    write_text(archive_md, markdown)

    print(
        json.dumps(
            {
                "run_id": run_id,
                "external_report": str(external_report_path),
                "policy_file": str(policy_path),
                "out_dir": str(out_dir),
                "total_candidates": len(rows),
                "decision_counts": decision_counts,
                "latest_json": str(latest_json),
                "latest_md": str(latest_md),
                "dry_run": False,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
