#!/usr/bin/env python3
"""Run G3/G4 validation across a 10+ asset universe using a fixed protocol."""

from __future__ import annotations

import argparse
import copy
import csv
import datetime as dt
import json
import math
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


SCHEMA_VERSION = "multi_asset_matrix.v1"
DEFAULT_ASSET_UNIVERSE = "data/research/strategy/asset_universe_10plus.v1.json"
DEFAULT_BASE_CANDIDATES = "docs/research/strategy_candidates.v1.json"
DEFAULT_OUTPUT = "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.v1.json"
DEFAULT_MARKDOWN = "data/research/strategy/analysis/g3g4/latest_multi_asset_matrix.md"
DEFAULT_ARCHIVE_DIR = "data/research/strategy/analysis/g3g4/multi_asset/archive"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Execute multi-asset strategy validation matrix for G3/G4 diagnostics."
    )
    parser.add_argument(
        "--repo-root",
        default="",
        help="Repository root (default: parent of this script).",
    )
    parser.add_argument(
        "--asset-universe",
        default=DEFAULT_ASSET_UNIVERSE,
        help="Path to asset universe JSON.",
    )
    parser.add_argument(
        "--assets",
        default="",
        help=(
            "Optional comma-separated asset names (for example BTC,ETH,SOL). "
            "Filtering is applied before --max-assets."
        ),
    )
    parser.add_argument(
        "--base-candidates",
        default=DEFAULT_BASE_CANDIDATES,
        help="Path to base strategy_candidates.v1.json template.",
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
        help="FDR method forwarded to strategy validation.",
    )
    parser.add_argument(
        "--wfo-profile",
        default="shift",
        choices=["stable", "shift", "stress"],
        help="WFO profile forwarded to strategy validation.",
    )
    parser.add_argument(
        "--lookback-bars",
        type=int,
        default=3600,
        help="Dataset lookback bars overridden per asset.",
    )
    parser.add_argument(
        "--max-assets",
        type=int,
        default=0,
        help="Optional cap on number of assets (0 means all).",
    )
    parser.add_argument(
        "--min-assets-success",
        type=int,
        default=8,
        help="Minimum completed assets required for a successful matrix run.",
    )
    parser.add_argument(
        "--run-id",
        default="",
        help="Optional run id for report archive directory.",
    )
    parser.add_argument(
        "--output",
        default=DEFAULT_OUTPUT,
        help="Latest output JSON path.",
    )
    parser.add_argument(
        "--markdown",
        default=DEFAULT_MARKDOWN,
        help="Latest output markdown path.",
    )
    parser.add_argument(
        "--archive-dir",
        default=DEFAULT_ARCHIVE_DIR,
        help="Archive directory root.",
    )
    parser.add_argument(
        "--pnpm-bin",
        default="pnpm",
        help="pnpm executable for invoking strategy validation.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue after an execution error (default false).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Plan only; do not invoke strategy validation.",
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


def parse_assets_filter(raw: str) -> List[str]:
    selected: List[str] = []
    seen: set[str] = set()
    for token in str(raw).split(","):
        name = token.strip().upper()
        if not name or name in seen:
            continue
        selected.append(name)
        seen.add(name)
    return selected


def invalid_data_quality(reason: str) -> Dict[str, Any]:
    return {
        "rows": 0,
        "columnCount": 0,
        "missingCells": 0,
        "missingRate": None,
        "priceAnomalyCount": 0,
        "priceAnomalyRate": None,
        "isValid": False,
        "invalidReason": str(reason),
    }


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
        raise ValueError(f"json root must be object: {path}")
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


def analyze_csv_quality(path: Path) -> Dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8", newline="") as handle:
            reader = csv.DictReader(handle)
            fieldnames = [name for name in (reader.fieldnames or []) if name is not None]
            if not fieldnames:
                return invalid_data_quality("missing_header")

            header_map = {name.strip().lower(): name for name in fieldnames}
            rows = 0
            missing_cells = 0
            price_anomaly_count = 0
            for row in reader:
                if not isinstance(row, dict):
                    continue
                rows += 1
                for name in fieldnames:
                    value = row.get(name)
                    if value is None or not str(value).strip():
                        missing_cells += 1

                ohlc = {
                    key: to_float(row.get(header_map[key]))
                    for key in ("open", "high", "low", "close")
                    if key in header_map
                }
                if len(ohlc) == 4:
                    open_v = ohlc["open"]
                    high_v = ohlc["high"]
                    low_v = ohlc["low"]
                    close_v = ohlc["close"]
                    if (
                        open_v is None
                        or high_v is None
                        or low_v is None
                        or close_v is None
                        or open_v <= 0
                        or high_v <= 0
                        or low_v <= 0
                        or close_v <= 0
                        or low_v > high_v
                        or not (low_v <= open_v <= high_v)
                        or not (low_v <= close_v <= high_v)
                    ):
                        price_anomaly_count += 1

            if rows <= 0:
                return invalid_data_quality("empty_dataset")

            total_cells = rows * len(fieldnames)
            missing_rate = (
                (missing_cells / total_cells) if total_cells > 0 else 0.0
            )
            price_anomaly_rate = price_anomaly_count / rows

            reasons: List[str] = []
            if missing_rate > 0.10:
                reasons.append("missing_rate_gt_10pct")
            if price_anomaly_rate > 0.05:
                reasons.append("price_anomaly_rate_gt_5pct")

            return {
                "rows": rows,
                "columnCount": len(fieldnames),
                "missingCells": missing_cells,
                "missingRate": round(missing_rate, 6),
                "priceAnomalyCount": price_anomaly_count,
                "priceAnomalyRate": round(price_anomaly_rate, 6),
                "isValid": len(reasons) == 0,
                "invalidReason": ",".join(reasons) if reasons else None,
            }
    except Exception as exc:  # noqa: BLE001
        return invalid_data_quality(f"read_error:{exc}")


def percentile(values: Sequence[float], q: float) -> Optional[float]:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    idx = (len(ordered) - 1) * q
    lo = int(math.floor(idx))
    hi = int(math.ceil(idx))
    if lo == hi:
        return float(ordered[lo])
    w = idx - lo
    return float(ordered[lo] * (1.0 - w) + ordered[hi] * w)


def derive_symbol(asset: str) -> str:
    token = "".join(ch for ch in str(asset).upper() if ch.isalnum())
    return f"{token}/USD" if token else "UNKNOWN/USD"


def build_candidate_payload(
    *,
    base_payload: Dict[str, Any],
    input_csv: str,
    symbol: str,
    lookback_bars: int,
) -> Dict[str, Any]:
    payload = copy.deepcopy(base_payload)
    payload["schemaVersion"] = "strategy_candidates.v1"
    payload["generatedAt"] = iso(now_utc())
    payload["dataset"] = {
        "inputCsv": input_csv,
        "symbol": symbol,
        "lookbackBars": int(lookback_bars),
    }
    return payload


def collect_pvalue_summary(candidates: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    p_values: List[float] = []
    for row in candidates:
        fdr = row.get("fdr", {})
        p_value = to_float(fdr.get("pValue")) if isinstance(fdr, dict) else None
        if p_value is not None:
            p_values.append(float(p_value))
    return {
        "count": len(p_values),
        "min": min(p_values) if p_values else None,
        "max": max(p_values) if p_values else None,
        "median": percentile(p_values, 0.5),
        "countLt0_05": sum(1 for value in p_values if value < 0.05),
        "countLt0_10": sum(1 for value in p_values if value < 0.1),
    }


def collect_wfo_failure_density(candidates: Sequence[Dict[str, Any]]) -> Optional[float]:
    failed_total = 0
    window_total = 0
    for row in candidates:
        summary = row.get("wfoSummary", {})
        if not isinstance(summary, dict):
            continue
        failed = summary.get("failedWindows")
        total = summary.get("totalWindows")
        if isinstance(failed, int) and isinstance(total, int) and total > 0:
            failed_total += failed
            window_total += total
    if window_total <= 0:
        return None
    return failed_total / window_total


def collect_failed_checks(candidates: Sequence[Dict[str, Any]]) -> List[str]:
    checks: set[str] = set()
    for row in candidates:
        release_gate = row.get("releaseGate", {})
        items = release_gate.get("failedChecks", []) if isinstance(release_gate, dict) else []
        if not isinstance(items, list):
            continue
        for item in items:
            text = str(item).strip()
            if text:
                checks.add(text)
    return sorted(checks)


def execute_for_asset(
    *,
    repo_root: Path,
    asset: Dict[str, Any],
    base_payload: Dict[str, Any],
    args: argparse.Namespace,
) -> Dict[str, Any]:
    asset_name = str(asset.get("asset", "")).strip() or "UNKNOWN"
    input_csv_raw = str(asset.get("inputCsv", "")).strip()
    symbol = str(asset.get("symbol", "")).strip() or derive_symbol(asset_name)
    if not input_csv_raw:
        return {
            "asset": asset_name,
            "symbol": symbol,
            "inputCsv": input_csv_raw,
            "status": "missing_data",
            "error": "inputCsv missing in asset universe entry",
            "dataQuality": invalid_data_quality("missing_input_csv"),
        }

    input_csv_path = resolve_path(repo_root, input_csv_raw)
    if not input_csv_path.exists():
        return {
            "asset": asset_name,
            "symbol": symbol,
            "inputCsv": input_csv_raw,
            "status": "missing_data",
            "error": f"missing dataset file: {input_csv_path}",
            "dataQuality": invalid_data_quality("file_not_found"),
        }

    data_quality = analyze_csv_quality(input_csv_path)
    if not bool(data_quality.get("isValid")):
        reason = str(data_quality.get("invalidReason") or "invalid_data_quality")
        return {
            "asset": asset_name,
            "symbol": symbol,
            "inputCsv": input_csv_raw,
            "status": "missing_data",
            "error": f"invalid dataset quality: {reason}",
            "dataQuality": data_quality,
        }

    payload = build_candidate_payload(
        base_payload=base_payload,
        input_csv=input_csv_raw,
        symbol=symbol,
        lookback_bars=int(args.lookback_bars),
    )

    with tempfile.TemporaryDirectory(prefix=f"openalice-matrix-{asset_name.lower()}-") as tmp:
        tmp_dir = Path(tmp)
        candidates_path = tmp_dir / "strategy_candidates.v1.json"
        runs_path = tmp_dir / "strategy_validation_runs.json"
        verdict_path = tmp_dir / "experiment_verdict.v2.json"
        release_gate_path = tmp_dir / "release_gate_status.json"
        write_json(candidates_path, payload)

        command = [
            str(args.pnpm_bin),
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
            "--wfo-profile",
            str(args.wfo_profile),
            "--fdr-method",
            str(args.fdr_method),
        ]

        if args.dry_run:
            return {
                "asset": asset_name,
                "symbol": symbol,
                "inputCsv": input_csv_raw,
                "status": "dry_run",
                "command": " ".join(shlex.quote(part) for part in command),
                "dataQuality": data_quality,
            }

        proc = subprocess.run(
            command,
            cwd=str(repo_root),
            text=True,
            capture_output=True,
            check=False,
        )

        run_payload: Optional[Dict[str, Any]] = None
        verdict_payload: Optional[Dict[str, Any]] = None
        warnings: List[str] = []
        try:
            if runs_path.exists():
                run_payload = read_json_object(runs_path)
            else:
                warnings.append("missing strategy_validation_runs output")
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"invalid run output: {exc}")
        try:
            if verdict_path.exists():
                verdict_payload = read_json_object(verdict_path)
            else:
                warnings.append("missing experiment_verdict output")
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"invalid verdict output: {exc}")

        candidates = (
            run_payload.get("candidates", [])
            if isinstance(run_payload, dict)
            else []
        )
        if not isinstance(candidates, list):
            candidates = []

        aggregate = (
            run_payload.get("aggregateMetrics", {})
            if isinstance(run_payload, dict)
            else {}
        )
        if not isinstance(aggregate, dict):
            aggregate = {}
        result = (
            verdict_payload.get("result")
            if isinstance(verdict_payload, dict)
            else None
        )
        reason_codes = (
            verdict_payload.get("reasonCodes", [])
            if isinstance(verdict_payload, dict)
            else []
        )
        if not isinstance(reason_codes, list):
            reason_codes = []

        thresholds = (
            run_payload.get("config", {}).get("thresholds", {})
            if isinstance(run_payload, dict)
            and isinstance(run_payload.get("config"), dict)
            else {}
        )
        if not isinstance(thresholds, dict):
            thresholds = {}

        status = "completed" if proc.returncode in (0, 2) else "execution_error"
        if status == "completed" and not run_payload:
            status = "parse_error"

        return {
            "asset": asset_name,
            "symbol": symbol,
            "inputCsv": input_csv_raw,
            "status": status,
            "exitCode": int(proc.returncode),
            "command": " ".join(shlex.quote(part) for part in command),
            "result": result,
            "fdrQ": to_float(aggregate.get("fdrQ")),
            "meanPbo": to_float(aggregate.get("meanPbo")),
            "meanDsrProbability": to_float(aggregate.get("meanDsrProbability")),
            "pValueSummary": collect_pvalue_summary(candidates),
            "wfoFailureDensity": collect_wfo_failure_density(candidates),
            "reasonCodes": [str(code) for code in reason_codes],
            "failedChecks": collect_failed_checks(candidates),
            "dataQuality": data_quality,
            "thresholds": {
                "fdrQMax": to_float(thresholds.get("fdrQMax")),
                "meanPboMax": to_float(thresholds.get("meanPboMax")),
                "meanDsrProbabilityMin": to_float(
                    thresholds.get("meanDsrProbabilityMin")
                ),
            },
            "stdoutTail": (proc.stdout or "")[-3000:],
            "stderrTail": (proc.stderr or "")[-3000:],
            "warnings": warnings,
        }


def build_markdown(report: Dict[str, Any]) -> str:
    lines: List[str] = []
    lines.append("# Multi-Asset Matrix")
    lines.append("")
    lines.append(f"- Generated at: `{report.get('generatedAt')}`")
    lines.append(f"- Run ID: `{report.get('runId')}`")
    lines.append(
        f"- Completed assets: `{report.get('summary', {}).get('completedAssets', 0)}` / "
        f"`{report.get('summary', {}).get('totalAssets', 0)}`"
    )
    lines.append(
        f"- Meets min-assets-success: `{report.get('summary', {}).get('meetsMinAssetsSuccess', False)}`"
    )
    quality_summary = report.get("summary", {}).get("qualitySummary", {})
    lines.append(
        f"- Data quality valid assets: `{quality_summary.get('validAssets', 0)}` / "
        f"`{report.get('summary', {}).get('totalAssets', 0)}`"
    )
    lines.append("")
    lines.append("| asset | status | quality | missingRate | result | fdrQ | meanPbo | meanDsrProbability | wfoFailureDensity | p<0.1 |")
    lines.append("| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |")
    for row in report.get("assets", []):
        p_summary = row.get("pValueSummary", {})
        quality = row.get("dataQuality", {})
        quality_label = "n/a"
        if isinstance(quality, dict):
            if quality.get("isValid") is True:
                quality_label = "valid"
            elif quality.get("isValid") is False:
                quality_label = f"invalid:{quality.get('invalidReason')}"
        lines.append(
            "| {asset} | {status} | {quality} | {missing_rate} | {result} | {fdr_q} | {mean_pbo} | {mean_dsr} | {wfo} | {lt01} |".format(
                asset=row.get("asset", ""),
                status=row.get("status", ""),
                quality=quality_label,
                missing_rate=quality.get("missingRate") if isinstance(quality, dict) else None,
                result=row.get("result", ""),
                fdr_q=row.get("fdrQ"),
                mean_pbo=row.get("meanPbo"),
                mean_dsr=row.get("meanDsrProbability"),
                wfo=row.get("wfoFailureDensity"),
                lt01=p_summary.get("countLt0_10"),
            )
        )
    lines.append("")
    return "\n".join(lines)


def summarize_matrix(assets: Sequence[Dict[str, Any]], min_assets_success: int) -> Dict[str, Any]:
    total_assets = len(assets)
    completed = [row for row in assets if row.get("status") == "completed"]
    missing = [row for row in assets if row.get("status") == "missing_data"]
    failed = [
        row
        for row in assets
        if row.get("status") in {"execution_error", "parse_error"}
    ]
    fdr_values = [
        float(row["fdrQ"])
        for row in completed
        if isinstance(row.get("fdrQ"), (int, float))
    ]
    invalid_asset_names: List[str] = []
    valid_assets = 0
    for row in assets:
        quality = row.get("dataQuality", {})
        if not isinstance(quality, dict):
            continue
        if quality.get("isValid") is True:
            valid_assets += 1
        elif quality.get("isValid") is False:
            invalid_asset_names.append(str(row.get("asset", "")))
    return {
        "totalAssets": total_assets,
        "completedAssets": len(completed),
        "missingAssets": len(missing),
        "failedAssets": len(failed),
        "minAssetsSuccess": int(min_assets_success),
        "meetsMinAssetsSuccess": len(completed) >= int(min_assets_success),
        "fdrQMedian": percentile(fdr_values, 0.5),
        "fdrQQ25": percentile(fdr_values, 0.25),
        "fdrQQ75": percentile(fdr_values, 0.75),
        "qualitySummary": {
            "validAssets": valid_assets,
            "invalidAssets": len(invalid_asset_names),
            "invalidAssetNames": invalid_asset_names,
        },
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    repo_root = (
        Path(args.repo_root).expanduser().resolve()
        if str(args.repo_root).strip()
        else Path(__file__).resolve().parents[1]
    )
    asset_universe_path = resolve_path(repo_root, str(args.asset_universe))
    base_candidates_path = resolve_path(repo_root, str(args.base_candidates))
    output_path = resolve_path(repo_root, str(args.output))
    markdown_path = resolve_path(repo_root, str(args.markdown))
    archive_root = resolve_path(repo_root, str(args.archive_dir))
    run_id = str(args.run_id).strip() or now_utc().strftime("%Y%m%dT%H%M%SZ")

    if not asset_universe_path.exists():
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"asset universe file missing: {asset_universe_path}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    if not base_candidates_path.exists():
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": f"base candidates file missing: {base_candidates_path}",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2

    asset_universe_payload = read_json_object(asset_universe_path)
    assets_raw = asset_universe_payload.get("assets", [])
    if not isinstance(assets_raw, list) or not assets_raw:
        print(
            json.dumps(
                {
                    "status": "error",
                    "message": "asset universe must contain a non-empty assets array",
                },
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return 2
    assets: List[Dict[str, Any]] = [
        row for row in assets_raw if isinstance(row, dict)
    ]
    requested_assets = parse_assets_filter(str(args.assets))
    if requested_assets:
        by_name: Dict[str, Dict[str, Any]] = {}
        for row in assets:
            name = str(row.get("asset", "")).strip().upper()
            if not name:
                continue
            by_name[name] = row
        missing_requested = [name for name in requested_assets if name not in by_name]
        if missing_requested:
            available = sorted(by_name.keys())
            print(
                json.dumps(
                    {
                        "status": "error",
                        "message": "requested assets not found in asset universe",
                        "missingAssets": missing_requested,
                        "availableAssets": available,
                    },
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            return 2
        assets = [by_name[name] for name in requested_assets]

    if int(args.max_assets) > 0:
        assets = assets[: int(args.max_assets)]

    base_payload = read_json_object(base_candidates_path)
    rows: List[Dict[str, Any]] = []
    warnings: List[str] = []
    for asset in assets:
        row = execute_for_asset(
            repo_root=repo_root,
            asset=asset,
            base_payload=base_payload,
            args=args,
        )
        rows.append(row)
        if row.get("status") in {"execution_error", "parse_error"} and not args.continue_on_error:
            warnings.append(f"stopped early due to {row.get('status')} on {row.get('asset')}")
            break

    summary = summarize_matrix(rows, int(args.min_assets_success))
    report = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": iso(now_utc()),
        "runId": run_id,
        "executeMode": "dry_run" if bool(args.dry_run) else "execute",
        "source": {
            "assetUniverse": str(asset_universe_path),
            "requestedAssets": requested_assets,
            "baseCandidates": str(base_candidates_path),
            "fdrMethod": str(args.fdr_method),
            "wfoProfile": str(args.wfo_profile),
            "lookbackBars": int(args.lookback_bars),
        },
        "summary": summary,
        "assets": rows,
        "warnings": warnings,
    }

    archive_path = archive_root / run_id / "multi_asset_matrix.v1.json"
    write_json(output_path, report)
    write_json(archive_path, report)
    write_markdown(markdown_path, build_markdown(report))

    print(
        json.dumps(
            {
                "status": "ok",
                "output": str(output_path),
                "archive": str(archive_path),
                "markdown": str(markdown_path),
                "runId": run_id,
                "completedAssets": summary.get("completedAssets"),
                "totalAssets": summary.get("totalAssets"),
                "meetsMinAssetsSuccess": summary.get("meetsMinAssetsSuccess"),
            },
            ensure_ascii=False,
        )
    )
    return 0 if bool(summary.get("meetsMinAssetsSuccess")) else 2


if __name__ == "__main__":
    raise SystemExit(main())
