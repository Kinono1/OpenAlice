#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

try:
    from jsonschema import Draft202012Validator
except Exception:  # noqa: BLE001
    Draft202012Validator = None  # type: ignore[assignment]


EXIT_OK = 0
EXIT_MISSING_ARTIFACTS = 2
EXIT_TOOL_ERROR = 3

NON_COPY_ARTIFACT_KEYS = {"manifest", "evidencePack"}

STATE_SET = {
    "NORMAL",
    "WATCH",
    "DEGRADE_H0",
    "PAUSE_NEW_OPENS",
    "RECOVERY_SHADOW",
}

ALLOWED_TRANSITIONS = {
    "NORMAL": {"NORMAL", "WATCH", "DEGRADE_H0", "PAUSE_NEW_OPENS"},
    "WATCH": {"WATCH", "NORMAL", "DEGRADE_H0", "PAUSE_NEW_OPENS"},
    "DEGRADE_H0": {"DEGRADE_H0", "RECOVERY_SHADOW", "PAUSE_NEW_OPENS"},
    "PAUSE_NEW_OPENS": {"PAUSE_NEW_OPENS", "WATCH", "DEGRADE_H0", "RECOVERY_SHADOW"},
    "RECOVERY_SHADOW": {
        "RECOVERY_SHADOW",
        "NORMAL",
        "DEGRADE_H0",
        "PAUSE_NEW_OPENS",
    },
}


def env_default(name: str, fallback: str) -> str:
    value = os.environ.get(name)
    return value if value and value.strip() else fallback


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build decision_packet artifacts for Go/No-Go validation."
    )
    parser.add_argument(
        "--template",
        default=env_default(
            "OPENALICE_DECISION_PACKET_TEMPLATE",
            "docs/research/templates/go_no_go_evidence_pack.template.json",
        ),
    )
    parser.add_argument(
        "--output-dir",
        default=env_default("OPENALICE_DECISION_PACKET_DIR", "decision_packet"),
    )
    parser.add_argument("--protocol-spec")
    parser.add_argument("--protocol-hash-file")
    parser.add_argument("--comparability-report")
    parser.add_argument("--champion-registry-snapshot")
    parser.add_argument("--release-gate-status")
    parser.add_argument("--offline-metrics")
    parser.add_argument("--live-shadow-metrics")
    parser.add_argument("--state-machine-log")
    parser.add_argument("--decision-markdown")
    parser.add_argument("--gate-checkpoints-dir")
    parser.add_argument("--experiment-verdict")
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def read_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path} must be a JSON object.")
    return data


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_artifact_rel_path(raw_path: str, output_dir_name: str) -> str:
    p = PurePosixPath(raw_path.replace("\\", "/"))
    parts = list(p.parts)
    if parts and parts[0] in (output_dir_name, "decision_packet"):
        parts = parts[1:]
    if not parts:
        return p.name
    return str(PurePosixPath(*parts))


def try_read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except Exception:  # noqa: BLE001
        return None


def maybe_get_number(payload: dict[str, Any], dotted_paths: list[str]) -> float | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, (int, float)):
            return float(current)
    return None


def maybe_get_bool(payload: dict[str, Any], dotted_paths: list[str]) -> bool | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, bool):
            return current
    return None


def maybe_get_string(payload: dict[str, Any], dotted_paths: list[str]) -> str | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, str) and current.strip():
            return current.strip()
    return None


def maybe_get_list(
    payload: dict[str, Any], dotted_paths: list[str]
) -> list[Any] | None:
    for dotted in dotted_paths:
        current: Any = payload
        ok = True
        for part in dotted.split("."):
            if not isinstance(current, dict) or part not in current:
                ok = False
                break
            current = current[part]
        if ok and isinstance(current, list):
            return current
    return None


def normalize_string_list(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    return [str(item) for item in raw]


def resolve_sidecar_path(raw_path: Any, *, anchor_path: Path) -> Path | None:
    if not isinstance(raw_path, str) or not raw_path.strip():
        return None

    candidate = Path(raw_path.strip())
    if candidate.is_absolute():
        return candidate
    if candidate.exists():
        return candidate
    return anchor_path.parent / candidate


def load_sidecar_payload(
    verdict_payload: dict[str, Any],
    verdict_path: Path,
    key: str,
) -> tuple[Path | None, dict[str, Any] | None]:
    output_paths = verdict_payload.get("outputPaths")
    output_paths = output_paths if isinstance(output_paths, dict) else {}
    sidecar_path = resolve_sidecar_path(output_paths.get(key), anchor_path=verdict_path)
    if sidecar_path is None or not sidecar_path.exists():
        return sidecar_path, None
    return sidecar_path, try_read_json(sidecar_path)


def build_validation_symbol_diagnostics(
    validation_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    symbols = validation_payload.get("symbols")
    if not isinstance(symbols, list):
        return []

    diagnostics: list[dict[str, Any]] = []
    for item in symbols:
        if not isinstance(item, dict):
            continue

        primary_candidate = item.get("champion")
        candidate_source = "champion"
        if not isinstance(primary_candidate, dict):
            primary_candidate = item.get("leader")
            candidate_source = "leader"
        if not isinstance(primary_candidate, dict):
            continue

        blocker_summary = primary_candidate.get("blockerSummary")
        blocker_summary = blocker_summary if isinstance(blocker_summary, dict) else {}
        fdr = blocker_summary.get("fdr")
        fdr = fdr if isinstance(fdr, dict) else {}
        release_gate = blocker_summary.get("releaseGate")
        release_gate = release_gate if isinstance(release_gate, dict) else {}
        wfo = blocker_summary.get("wfo")
        wfo = wfo if isinstance(wfo, dict) else {}

        diagnostics.append(
            {
                "symbol": maybe_get_string(item, ["symbol"]),
                "result": maybe_get_string(item, ["result"]),
                "reasonCodes": normalize_string_list(item.get("reasonCodes")),
                "candidateSource": candidate_source,
                "strategyId": maybe_get_string(primary_candidate, ["strategyId"]),
                "strategyName": maybe_get_string(primary_candidate, ["strategyName"]),
                "status": maybe_get_string(primary_candidate, ["status"]),
                "failureReasons": normalize_string_list(
                    primary_candidate.get("failureReasons")
                ),
                "primaryBlocker": maybe_get_string(blocker_summary, ["primaryBlocker"]),
                "fdr": {
                    "passed": maybe_get_bool(fdr, ["passed"]),
                    "qValue": maybe_get_number(fdr, ["qValue"]),
                    "threshold": maybe_get_number(fdr, ["threshold"]),
                },
                "releaseGate": {
                    "allowPaperTrading": maybe_get_bool(
                        release_gate, ["allowPaperTrading"]
                    ),
                    "allowLiveTrading": maybe_get_bool(
                        release_gate, ["allowLiveTrading"]
                    ),
                    "failedChecks": normalize_string_list(
                        release_gate.get("failedChecks")
                    ),
                },
                "wfo": {
                    "passed": maybe_get_bool(wfo, ["passed"]),
                    "failedWindows": maybe_get_number(wfo, ["failedWindows"]),
                    "windowCount": maybe_get_number(wfo, ["windowCount"]),
                    "failedWindowRatio": maybe_get_number(wfo, ["failedWindowRatio"]),
                },
            }
        )

    return diagnostics


def build_verdict_symbol_diagnostics(
    verdict_payload: dict[str, Any],
) -> list[dict[str, Any]]:
    symbols = verdict_payload.get("symbols")
    if not isinstance(symbols, list):
        return []

    diagnostics: list[dict[str, Any]] = []
    for item in symbols:
        if not isinstance(item, dict):
            continue

        primary_candidate = item.get("champion")
        candidate_source = "champion"
        if not isinstance(primary_candidate, dict):
            primary_candidate = item.get("leader")
            candidate_source = "leader"
        if not isinstance(primary_candidate, dict):
            continue

        strategy_id = maybe_get_string(primary_candidate, ["strategyId"])
        failure_reasons: list[str] = []
        candidates = item.get("candidates")
        if isinstance(candidates, list):
            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                candidate_id = maybe_get_string(candidate, ["strategyId"])
                if strategy_id is not None and candidate_id == strategy_id:
                    failure_reasons = normalize_string_list(candidate.get("failureReasons"))
                    break

        diagnostics.append(
            {
                "symbol": maybe_get_string(item, ["symbol"]),
                "result": maybe_get_string(item, ["result"]),
                "reasonCodes": normalize_string_list(item.get("reasonCodes")),
                "candidateSource": candidate_source,
                "strategyId": strategy_id,
                "strategyName": maybe_get_string(primary_candidate, ["strategyName"]),
                "status": maybe_get_string(primary_candidate, ["status"]),
                "failureReasons": failure_reasons,
                "primaryBlocker": None,
                "fdr": {
                    "passed": None,
                    "qValue": maybe_get_number(primary_candidate, ["fdrQ"]),
                    "threshold": None,
                },
                "releaseGate": {
                    "allowPaperTrading": maybe_get_bool(
                        primary_candidate, ["releaseGateAllowPaper"]
                    ),
                    "allowLiveTrading": maybe_get_bool(
                        primary_candidate, ["releaseGateAllowLive"]
                    ),
                    "failedChecks": [],
                },
                "wfo": {
                    "passed": None,
                    "failedWindows": None,
                    "windowCount": None,
                    "failedWindowRatio": None,
                },
            }
        )

    return diagnostics


def attach_symbol_diagnostics(
    experiment_verdict: dict[str, Any],
    verdict_payload: dict[str, Any],
    verdict_path: Path,
) -> None:
    validation_runs_path, validation_payload = load_sidecar_payload(
        verdict_payload,
        verdict_path,
        "validationRuns",
    )

    if validation_runs_path is not None and validation_payload is not None:
        diagnostics = build_validation_symbol_diagnostics(validation_payload)
        if diagnostics:
            experiment_verdict["symbolDiagnosticsSource"] = {
                "kind": "validation_runs",
                "path": str(validation_runs_path),
            }
            experiment_verdict["symbolDiagnostics"] = diagnostics
            return

    diagnostics = build_verdict_symbol_diagnostics(verdict_payload)
    if diagnostics:
        experiment_verdict["symbolDiagnosticsSource"] = {
            "kind": "experiment_verdict",
            "path": str(verdict_path),
        }
        experiment_verdict["symbolDiagnostics"] = diagnostics



def extract_blocking_checks(raw_checks: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_checks, list):
        return []

    blocking_checks: list[dict[str, Any]] = []
    for item in raw_checks:
        if not isinstance(item, dict):
            continue
        status = maybe_get_string(item, ["status"])
        if status not in {"fail", "skipped"}:
            continue
        blocking_checks.append(
            {
                "name": maybe_get_string(item, ["name"]),
                "status": status,
                "summary": maybe_get_string(item, ["summary"]),
            }
        )
    return blocking_checks



def build_candidate_blocker_entry(candidate: dict[str, Any]) -> dict[str, Any]:
    blocker_summary_raw = candidate.get("blockerSummary")
    blocker_summary = blocker_summary_raw if isinstance(blocker_summary_raw, dict) else {}

    fdr = blocker_summary.get("candidateLevelFdr")
    if not isinstance(fdr, dict):
        fdr = blocker_summary.get("fdr")
    if not isinstance(fdr, dict):
        fdr = candidate.get("candidateLevelFdr")
    if not isinstance(fdr, dict):
        fdr = candidate.get("fdr")
    if not isinstance(fdr, dict):
        fdr = {}

    significance = candidate.get("candidateLevelSignificance")
    if not isinstance(significance, dict):
        significance = candidate.get("significance")
    if not isinstance(significance, dict):
        significance = {}

    release_gate = blocker_summary.get("releaseGate")
    if not isinstance(release_gate, dict):
        release_gate = candidate.get("releaseGate")
    if not isinstance(release_gate, dict):
        release_gate = {}

    wfo = blocker_summary.get("wfo")
    if not isinstance(wfo, dict):
        wfo = candidate.get("wfo")
    if not isinstance(wfo, dict):
        wfo = {}

    return {
        "strategyId": maybe_get_string(candidate, ["strategyId"]),
        "strategyName": maybe_get_string(candidate, ["strategyName"]),
        "status": maybe_get_string(candidate, ["status"]),
        "failureReasons": normalize_string_list(candidate.get("failureReasons")),
        "primaryBlocker": maybe_get_string(blocker_summary, ["primaryBlocker"]),
        "fdr": {
            "passed": maybe_get_bool(fdr, ["passed"]),
            "qValue": maybe_get_number(fdr, ["qValue"]),
            "threshold": maybe_get_number(fdr, ["threshold"]),
        },
        "significance": {
            "pbo": maybe_get_number(significance, ["pbo"]),
            "dsrProbability": maybe_get_number(significance, ["dsrProbability"]),
        },
        "releaseGate": {
            "allowPaperTrading": maybe_get_bool(release_gate, ["allowPaperTrading"]),
            "allowLiveTrading": maybe_get_bool(release_gate, ["allowLiveTrading"]),
            "failedChecks": normalize_string_list(release_gate.get("failedChecks")),
            "blockingChecks": extract_blocking_checks(release_gate.get("checks")),
        },
        "wfo": {
            "passed": maybe_get_bool(wfo, ["passed", "overallPassed"]),
            "failedWindows": maybe_get_number(wfo, ["failedWindows"]),
            "windowCount": maybe_get_number(wfo, ["windowCount"]),
            "failedWindowRatio": maybe_get_number(wfo, ["failedWindowRatio"]),
        },
    }



def is_blocked_candidate(entry: dict[str, Any]) -> bool:
    if entry.get("status") == "fail":
        return True
    if len(normalize_string_list(entry.get("failureReasons"))) > 0:
        return True
    if isinstance(entry.get("primaryBlocker"), str) and entry.get("primaryBlocker"):
        return True

    fdr = entry.get("fdr")
    if isinstance(fdr, dict) and fdr.get("passed") is False:
        return True

    release_gate = entry.get("releaseGate")
    if isinstance(release_gate, dict):
        if release_gate.get("allowPaperTrading") is False:
            return True
        if release_gate.get("allowLiveTrading") is False:
            return True
        if len(normalize_string_list(release_gate.get("failedChecks"))) > 0:
            return True

    wfo = entry.get("wfo")
    if isinstance(wfo, dict) and wfo.get("passed") is False:
        return True

    return False



def build_symbol_blocker_entry(item: dict[str, Any]) -> dict[str, Any]:
    primary_candidate = item.get("champion")
    candidate_source = "champion"
    if not isinstance(primary_candidate, dict):
        primary_candidate = item.get("leader")
        candidate_source = "leader"

    primary_entry = (
        build_candidate_blocker_entry(primary_candidate)
        if isinstance(primary_candidate, dict)
        else None
    )

    blocked_candidates: list[dict[str, Any]] = []
    raw_candidates = item.get("candidates")
    if isinstance(raw_candidates, list):
        for candidate in raw_candidates:
            if not isinstance(candidate, dict):
                continue
            candidate_entry = build_candidate_blocker_entry(candidate)
            if is_blocked_candidate(candidate_entry):
                blocked_candidates.append(candidate_entry)

    return {
        "symbol": maybe_get_string(item, ["symbol"]),
        "result": maybe_get_string(item, ["result"]),
        "reasonCodes": normalize_string_list(item.get("reasonCodes")),
        "candidateSource": candidate_source if primary_entry is not None else None,
        "primaryCandidate": primary_entry,
        "blockedCandidates": blocked_candidates,
    }



def count_blocked_candidates(
    symbols: list[dict[str, Any]],
    ungrouped_candidates: list[dict[str, Any]],
) -> int:
    seen_keys: set[tuple[str | None, str | None, str | None]] = set()
    count = 0

    def include(entry: Any, symbol: str | None = None) -> None:
        nonlocal count
        if not isinstance(entry, dict) or not is_blocked_candidate(entry):
            return

        key = (
            symbol,
            maybe_get_string(entry, ["strategyId"]),
            maybe_get_string(entry, ["strategyName"]),
        )
        if key in seen_keys:
            return
        seen_keys.add(key)
        count += 1

    for entry in ungrouped_candidates:
        include(entry)

    for item in symbols:
        if not isinstance(item, dict):
            continue
        symbol = maybe_get_string(item, ["symbol"])
        include(item.get("primaryCandidate"), symbol)
        blocked_candidates = item.get("blockedCandidates")
        if not isinstance(blocked_candidates, list):
            continue
        for entry in blocked_candidates:
            include(entry, symbol)

    return count



def build_portfolio_blocker_entry(
    result: str,
    reason_codes: list[str],
    verdict_payload: dict[str, Any],
    portfolio_payload: dict[str, Any] | None,
    release_gate_payload: dict[str, Any] | None,
) -> dict[str, Any]:
    verdict_portfolio = verdict_payload.get("portfolio")
    verdict_portfolio = verdict_portfolio if isinstance(verdict_portfolio, dict) else {}
    portfolio = portfolio_payload if isinstance(portfolio_payload, dict) else {}

    release_gate = portfolio.get("releaseGate")
    if not isinstance(release_gate, dict):
        release_gate = verdict_portfolio.get("releaseGate")
    if not isinstance(release_gate, dict):
        release_gate = release_gate_payload if isinstance(release_gate_payload, dict) else {}

    portfolio_reason_codes = normalize_string_list(portfolio.get("reasonCodes"))
    if not portfolio_reason_codes:
        portfolio_reason_codes = normalize_string_list(verdict_portfolio.get("reasonCodes"))
    if not portfolio_reason_codes:
        portfolio_reason_codes = reason_codes

    champion_set = portfolio.get("championSet")
    if not isinstance(champion_set, list):
        champion_set = verdict_portfolio.get("championSet")
    champion_count = len(champion_set) if isinstance(champion_set, list) else 0

    return {
        "result": (
            maybe_get_string(portfolio, ["result"])
            or maybe_get_string(verdict_portfolio, ["result"])
            or result
        ),
        "reasonCodes": portfolio_reason_codes,
        "requiredSymbols": normalize_string_list(verdict_portfolio.get("requiredSymbols")),
        "championCount": champion_count,
        "releaseGate": {
            "allowPaperTrading": maybe_get_bool(release_gate, ["allowPaperTrading"]),
            "allowLiveTrading": maybe_get_bool(release_gate, ["allowLiveTrading"]),
            "failedChecks": normalize_string_list(release_gate.get("failedChecks")),
            "warningChecks": normalize_string_list(release_gate.get("warningChecks")),
            "blockingChecks": extract_blocking_checks(release_gate.get("checks")),
        },
    }



def build_validation_blocker_diagnostics(
    validation_payload: dict[str, Any],
    validation_path: Path,
    verdict_payload: dict[str, Any],
    verdict_path: Path,
) -> dict[str, Any]:
    result = maybe_get_string(verdict_payload, ["result"]) or "NO_GO"
    reason_codes = normalize_string_list(verdict_payload.get("reasonCodes"))
    release_gate_status_path, release_gate_status_payload = load_sidecar_payload(
        verdict_payload,
        verdict_path,
        "releaseGateStatus",
    )

    raw_symbols = validation_payload.get("symbols")
    symbols: list[dict[str, Any]] = []
    if isinstance(raw_symbols, list):
        symbols = [
            build_symbol_blocker_entry(item)
            for item in raw_symbols
            if isinstance(item, dict)
        ]

    ungrouped_candidates: list[dict[str, Any]] = []
    raw_candidates = validation_payload.get("candidates")
    if isinstance(raw_candidates, list):
        for candidate in raw_candidates:
            if not isinstance(candidate, dict):
                continue
            candidate_entry = build_candidate_blocker_entry(candidate)
            if is_blocked_candidate(candidate_entry):
                ungrouped_candidates.append(candidate_entry)

    blocked_symbol_count = sum(
        1
        for item in symbols
        if item.get("result") not in {None, "GO", "GO_WITH_CONSTRAINTS", "pass"}
    )
    blocked_candidate_count = count_blocked_candidates(symbols, ungrouped_candidates)

    source_paths = {
        "experimentVerdict": str(verdict_path),
        "validationRuns": str(validation_path),
    }
    if release_gate_status_path is not None:
        source_paths["releaseGateStatus"] = str(release_gate_status_path)

    portfolio = build_portfolio_blocker_entry(
        result,
        reason_codes,
        verdict_payload,
        validation_payload.get("portfolio") if isinstance(validation_payload.get("portfolio"), dict) else None,
        release_gate_status_payload,
    )

    return {
        "sourcePaths": source_paths,
        "summary": {
            "result": result,
            "reasonCodes": reason_codes,
            "blockedSymbolCount": blocked_symbol_count,
            "blockedCandidateCount": blocked_candidate_count,
        },
        "portfolio": portfolio,
        "symbols": symbols,
        "ungroupedCandidates": ungrouped_candidates,
    }



def build_verdict_blocker_diagnostics(
    verdict_payload: dict[str, Any],
    verdict_path: Path,
) -> dict[str, Any]:
    result = maybe_get_string(verdict_payload, ["result"]) or "NO_GO"
    reason_codes = normalize_string_list(verdict_payload.get("reasonCodes"))
    release_gate_status_path, release_gate_status_payload = load_sidecar_payload(
        verdict_payload,
        verdict_path,
        "releaseGateStatus",
    )

    raw_symbols = verdict_payload.get("symbols")
    symbols: list[dict[str, Any]] = []
    if isinstance(raw_symbols, list):
        symbols = [
            build_symbol_blocker_entry(item)
            for item in raw_symbols
            if isinstance(item, dict)
        ]

    ungrouped_candidates: list[dict[str, Any]] = []
    raw_candidates = verdict_payload.get("candidates")
    if isinstance(raw_candidates, list):
        for candidate in raw_candidates:
            if not isinstance(candidate, dict):
                continue
            candidate_entry = build_candidate_blocker_entry(candidate)
            if is_blocked_candidate(candidate_entry):
                ungrouped_candidates.append(candidate_entry)

    blocked_symbol_count = sum(
        1
        for item in symbols
        if item.get("result") not in {None, "GO", "GO_WITH_CONSTRAINTS", "pass"}
    )
    blocked_candidate_count = count_blocked_candidates(symbols, ungrouped_candidates)

    source_paths = {"experimentVerdict": str(verdict_path)}
    if release_gate_status_path is not None:
        source_paths["releaseGateStatus"] = str(release_gate_status_path)

    portfolio = build_portfolio_blocker_entry(
        result,
        reason_codes,
        verdict_payload,
        verdict_payload.get("portfolio") if isinstance(verdict_payload.get("portfolio"), dict) else None,
        release_gate_status_payload,
    )

    return {
        "sourcePaths": source_paths,
        "summary": {
            "result": result,
            "reasonCodes": reason_codes,
            "blockedSymbolCount": blocked_symbol_count,
            "blockedCandidateCount": blocked_candidate_count,
        },
        "portfolio": portfolio,
        "symbols": symbols,
        "ungroupedCandidates": ungrouped_candidates,
    }



def collect_blocker_diagnostics(
    verdict_payload: dict[str, Any],
    verdict_path: Path,
) -> dict[str, Any] | None:
    validation_runs_path, validation_payload = load_sidecar_payload(
        verdict_payload,
        verdict_path,
        "validationRuns",
    )
    if validation_runs_path is not None and validation_payload is not None:
        return build_validation_blocker_diagnostics(
            validation_payload,
            validation_runs_path,
            verdict_payload,
            verdict_path,
        )

    diagnostics = build_verdict_blocker_diagnostics(verdict_payload, verdict_path)
    if diagnostics["symbols"] or diagnostics["ungroupedCandidates"]:
        return diagnostics
    return None



def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def set_metric_if_unset(
    measured: dict[str, Any], key: str, value: float | None
) -> None:
    if value is None:
        return
    existing = measured.get(key)
    if not is_number(existing):
        measured[key] = value


def read_nonempty_text(path: Path) -> str | None:
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def parse_comparability_status(payload: dict[str, Any]) -> tuple[bool, str]:
    status = maybe_get_bool(
        payload,
        [
            "allComparable",
            "all_comparable",
            "comparable",
            "summary.allComparable",
            "summary.all_comparable",
            "meta.allComparable",
        ],
    )
    if status is not None:
        return status, "derived from boolean comparability flag"

    failed_count = maybe_get_number(
        payload,
        [
            "failedCount",
            "failureCount",
            "incomparableCount",
            "nonComparableCount",
            "summary.failedCount",
            "summary.failureCount",
            "summary.incomparableCount",
        ],
    )
    if failed_count is not None:
        return failed_count <= 0.0, f"derived from failure count={failed_count}"

    failed_runs = maybe_get_list(
        payload,
        [
            "incomparableRuns",
            "failedRuns",
            "summary.incomparableRuns",
            "summary.failedRuns",
        ],
    )
    if failed_runs is not None:
        return len(
            failed_runs
        ) == 0, f"derived from failed runs count={len(failed_runs)}"

    return False, "comparability status is not inferable from report"


def normalize_state(raw: Any) -> str | None:
    if isinstance(raw, str) and raw.strip():
        value = raw.strip().upper()
        if value in STATE_SET:
            return value
    return None


def validate_state_machine_log(path: Path) -> tuple[bool, str]:
    lines = [
        line for line in path.read_text(encoding="utf-8").splitlines() if line.strip()
    ]
    if not lines:
        return False, "state machine log has no events"

    current_state: str | None = None
    for idx, line in enumerate(lines, start=1):
        payload = json.loads(line)
        if not isinstance(payload, dict):
            return False, f"line {idx} is not a JSON object"
        from_state = normalize_state(
            payload.get("from")
            or payload.get("fromState")
            or payload.get("prevState")
            or payload.get("previousState")
        )
        to_state = normalize_state(
            payload.get("to")
            or payload.get("toState")
            or payload.get("nextState")
            or payload.get("state")
        )
        if to_state is None:
            return False, f"line {idx} missing target state"
        if from_state is None:
            from_state = current_state
        if from_state is not None:
            if to_state not in ALLOWED_TRANSITIONS.get(from_state, set()):
                return False, f"line {idx} invalid transition {from_state}->{to_state}"
        current_state = to_state

    return True, f"validated {len(lines)} transitions"


def validate_champion_registry_snapshot(payload: dict[str, Any]) -> tuple[bool, str]:
    schema_path = Path("docs/research/templates/champion_registry.schema.v1.json")

    if Draft202012Validator is not None and schema_path.exists():
        try:
            schema_payload = read_json(schema_path)
            validator = Draft202012Validator(
                schema_payload,
                format_checker=Draft202012Validator.FORMAT_CHECKER,
            )
            errors = sorted(
                validator.iter_errors(payload), key=lambda err: list(err.path)
            )
            if errors:
                first = errors[0]
                location = ".".join(str(part) for part in first.path) or "$"
                return False, f"schema validation failed at {location}: {first.message}"
        except Exception as exc:  # noqa: BLE001
            return False, f"schema validation error: {exc}"

    required_fields = (
        "schemaVersion",
        "version",
        "updatedAt",
        "writer",
        "protocolHash",
        "datasetSnapshotId",
        "championConfigId",
        "status",
        "fallbackConfigId",
    )
    missing = [field for field in required_fields if field not in payload]
    if missing:
        return False, f"missing required fields: {', '.join(missing)}"

    if payload.get("schemaVersion") != "v1":
        return False, "schemaVersion must be v1"
    if payload.get("fallbackConfigId") != "H0":
        return False, "fallbackConfigId must be H0"

    return True, "champion registry snapshot validated"


def upsert_hard_gate(
    hard_gate_checks: list[dict[str, Any]],
    name: str,
    passed: bool,
    reason: str,
) -> None:
    for item in hard_gate_checks:
        if isinstance(item, dict) and item.get("name") == name:
            item["passed"] = bool(passed)
            item["reason"] = reason
            return

    hard_gate_checks.append(
        {
            "name": name,
            "passed": bool(passed),
            "reason": reason,
        }
    )


def ensure_decision_shape(pack: dict[str, Any]) -> None:
    decision = pack.setdefault("decision", {})
    if not isinstance(decision, dict):
        decision = {}
        pack["decision"] = decision
    decision.setdefault("result", "NO_GO")
    decision.setdefault("mode", "hard_gate")
    decision.setdefault("verdictReasonCodes", [])
    decision.setdefault("notes", [])
    decision.setdefault("constraints", [])
    decision.setdefault("rollbackTriggers", [])
    decision.setdefault("expiryAt", None)
    decision.setdefault("maxDurationHours", None)


def collect_measured_metrics(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    measured = pack.setdefault("measured", {})
    if not isinstance(measured, dict):
        return

    offline = (
        try_read_json(copied_paths["offlineMetrics"])
        if "offlineMetrics" in copied_paths
        else None
    )
    live = (
        try_read_json(copied_paths["liveShadowMetrics14d"])
        if "liveShadowMetrics14d" in copied_paths
        else None
    )
    release = (
        try_read_json(copied_paths["releaseGateStatus"])
        if "releaseGateStatus" in copied_paths
        else None
    )

    if offline:
        set_metric_if_unset(
            measured,
            "winnerEligibleRatioRolling14d",
            maybe_get_number(
                offline,
                [
                    "winnerEligibleRatioRolling14d",
                    "strategyValidation.significancePassRatio",
                ],
            ),
        )
        set_metric_if_unset(
            measured,
            "meanPbo",
            maybe_get_number(offline, ["meanPbo", "strategyValidation.meanPbo"]),
        )
        set_metric_if_unset(
            measured,
            "meanDsrProbability",
            maybe_get_number(
                offline,
                ["meanDsrProbability", "strategyValidation.meanDsrProbability"],
            ),
        )
        set_metric_if_unset(
            measured,
            "fdrQ",
            maybe_get_number(offline, ["fdrQ", "statistics.fdrQ"]),
        )
        set_metric_if_unset(
            measured,
            "transferPassRatioRolling14d",
            maybe_get_number(
                offline,
                ["transferPassRatioRolling14d", "strategyValidation.paperPassRatio"],
            ),
        )

    if live:
        set_metric_if_unset(
            measured,
            "quoteAgeP95Ms",
            maybe_get_number(live, ["quoteAgeP95Ms", "quote_age_p95_ms"]),
        )
        set_metric_if_unset(
            measured,
            "decisionToSubmitP95Ms",
            maybe_get_number(
                live,
                ["decisionToSubmitP95Ms", "decision_to_submit_p95_ms"],
            ),
        )
        set_metric_if_unset(
            measured,
            "decisionToFirstFillP95Ms",
            maybe_get_number(
                live,
                ["decisionToFirstFillP95Ms", "decision_to_first_fill_p95_ms"],
            ),
        )

    if release:
        generated = release.get("generatedAt")
        if isinstance(generated, str):
            try:
                ts = datetime.fromisoformat(generated.replace("Z", "+00:00"))
                age_hours = (datetime.now(timezone.utc) - ts).total_seconds() / 3600
                set_metric_if_unset(measured, "releaseGateStatusAgeHours", age_hours)
            except ValueError:
                pass


def collect_hard_gate_checks(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
    *,
    allow_legacy_missing: bool = False,
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    comparability_path = copied_paths.get("comparabilityReport")
    if comparability_path:
        comparability_payload = try_read_json(comparability_path)
        if comparability_payload is not None:
            passed, reason = parse_comparability_status(comparability_payload)
            upsert_hard_gate(
                hard_gate_checks, "comparability_all_runs_valid", passed, reason
            )
        else:
            upsert_hard_gate(
                hard_gate_checks,
                "comparability_all_runs_valid",
                False,
                "comparability report is not a valid JSON object",
            )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "comparability_all_runs_valid",
            allow_legacy_missing,
            (
                "comparability report missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "comparability report missing"
            ),
        )

    protocol_hash_path = copied_paths.get("protocolHashFile")
    protocol_spec_path = copied_paths.get("protocolSpec")
    protocol_hash = None
    protocol_hash_reason = "protocol hash missing"
    protocol_hash_ok = False
    if protocol_hash_path:
        protocol_hash = read_nonempty_text(protocol_hash_path)
        if protocol_hash:
            pack["protocolHash"] = protocol_hash
            protocol_hash_ok = True
            protocol_hash_reason = "protocol hash file present"
        else:
            protocol_hash_reason = "protocol hash file is empty"

    if protocol_hash_ok and protocol_spec_path:
        protocol_spec = try_read_json(protocol_spec_path)
        if protocol_spec is not None:
            expected_hash = maybe_get_string(
                protocol_spec,
                [
                    "runtimeProtocolHash",
                    "protocolHash",
                    "meta.runtimeProtocolHash",
                ],
            )
            if expected_hash and expected_hash != protocol_hash:
                protocol_hash_ok = False
                protocol_hash_reason = "protocol hash mismatch between protocol spec and protocol hash file"

    upsert_hard_gate(
        hard_gate_checks,
        "protocol_hash_matches_runtime",
        (protocol_hash_ok or allow_legacy_missing),
        (
            "protocol hash missing (ignored in v5 mode)"
            if allow_legacy_missing and not protocol_hash_ok
            else protocol_hash_reason
        ),
    )

    champion_path = copied_paths.get("championRegistrySnapshot")
    if champion_path:
        champion_payload = try_read_json(champion_path)
        if champion_payload is None:
            upsert_hard_gate(
                hard_gate_checks,
                "champion_registry_schema_valid",
                False,
                "champion registry snapshot is not a valid JSON object",
            )
        else:
            champion_ok, champion_reason = validate_champion_registry_snapshot(
                champion_payload
            )
            upsert_hard_gate(
                hard_gate_checks,
                "champion_registry_schema_valid",
                champion_ok,
                champion_reason,
            )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "champion_registry_schema_valid",
            allow_legacy_missing,
            (
                "champion registry snapshot missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "champion registry snapshot missing"
            ),
        )

    state_log_path = copied_paths.get("stateMachineLog")
    if state_log_path:
        try:
            state_ok, state_reason = validate_state_machine_log(state_log_path)
        except Exception as exc:  # noqa: BLE001
            state_ok = False
            state_reason = f"state machine log parsing error: {exc}"
        upsert_hard_gate(
            hard_gate_checks,
            "state_machine_drill_passed",
            state_ok,
            state_reason,
        )
    else:
        upsert_hard_gate(
            hard_gate_checks,
            "state_machine_drill_passed",
            allow_legacy_missing,
            (
                "state machine log missing (ignored in v5 mode)"
                if allow_legacy_missing
                else "state machine log missing"
            ),
        )


def append_manifest_entry(
    manifest_entries: list[dict[str, Any]],
    key: str,
    source_path: Path,
    dest_path: Path,
    exists: bool,
    copied: bool = False,
) -> None:
    entry: dict[str, Any] = {
        "key": key,
        "sourcePath": str(source_path),
        "destinationPath": str(dest_path),
        "copied": copied,
        "exists": exists,
        "sha256": None,
        "sizeBytes": None,
    }
    if exists:
        entry["sizeBytes"] = dest_path.stat().st_size
        entry["sha256"] = sha256_file(dest_path)
    manifest_entries.append(entry)


def copy_optional_artifact(
    key: str,
    source_path: Path,
    dest_path: Path,
    manifest_entries: list[dict[str, Any]],
    missing: list[dict[str, str]],
) -> Path | None:
    if not source_path.exists():
        missing.append({"key": key, "sourcePath": str(source_path)})
        append_manifest_entry(
            manifest_entries,
            key,
            source_path,
            dest_path,
            exists=False,
            copied=False,
        )
        return None

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    copied = False
    if source_path.resolve() != dest_path.resolve():
        shutil.copy2(source_path, dest_path)
        copied = True
    append_manifest_entry(
        manifest_entries,
        key,
        source_path,
        dest_path,
        exists=True,
        copied=copied,
    )
    return dest_path


def ingest_experiment_verdict(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    verdict_path = copied_paths.get("experimentVerdict")
    if verdict_path is None:
        upsert_hard_gate(
            hard_gate_checks,
            "experiment_verdict_available",
            False,
            "experiment verdict artifact missing",
        )
        return

    verdict_payload = try_read_json(verdict_path)
    if verdict_payload is None:
        upsert_hard_gate(
            hard_gate_checks,
            "experiment_verdict_available",
            False,
            "experiment verdict is not a valid JSON object",
        )
        return

    result = maybe_get_string(verdict_payload, ["result"]) or "NO_GO"
    reason_codes = maybe_get_list(verdict_payload, ["reasonCodes"]) or []
    reason_codes_norm = [str(item) for item in reason_codes]
    aggregate = verdict_payload.get("aggregateMetrics")
    thresholds = verdict_payload.get("thresholds")
    experiment_verdict = {
        "path": str(verdict_path),
        "schemaVersion": verdict_payload.get("schemaVersion"),
        "result": result,
        "reasonCodes": reason_codes_norm,
        "aggregateMetrics": aggregate if isinstance(aggregate, dict) else {},
        "thresholds": thresholds if isinstance(thresholds, dict) else {},
        "generatedAt": verdict_payload.get("generatedAt"),
    }
    attach_symbol_diagnostics(experiment_verdict, verdict_payload, verdict_path)
    blocker_diagnostics = collect_blocker_diagnostics(verdict_payload, verdict_path)
    if blocker_diagnostics is not None:
        pack["blockerDiagnostics"] = blocker_diagnostics
    pack["experimentVerdict"] = experiment_verdict

    decision = pack.get("decision")
    if isinstance(decision, dict):
        decision["result"] = result

    is_go = result in {"GO", "GO_WITH_CONSTRAINTS"}
    upsert_hard_gate(
        hard_gate_checks,
        "experiment_verdict_available",
        True,
        "experiment verdict artifact loaded",
    )
    upsert_hard_gate(
        hard_gate_checks,
        "experiment_verdict_result",
        is_go,
        f"result={result}; reasonCodes={','.join(reason_codes_norm)}",
    )


def ingest_gate_checkpoints(
    pack: dict[str, Any],
    copied_paths: dict[str, Path],
) -> None:
    hard_gate_checks = pack.setdefault("hardGateChecks", [])
    if not isinstance(hard_gate_checks, list):
        hard_gate_checks = []
        pack["hardGateChecks"] = hard_gate_checks

    refs: list[dict[str, Any]] = []
    missing: list[str] = []
    hard_failed: list[str] = []
    for gate_id in ("G0", "G1", "G2", "G3", "G4"):
        key = f"gateCheckpoint{gate_id}"
        path = copied_paths.get(key)
        if path is None:
            missing.append(gate_id)
            upsert_hard_gate(
                hard_gate_checks,
                f"gate_checkpoint_{gate_id}",
                False,
                f"{gate_id} checkpoint missing",
            )
            continue

        payload = try_read_json(path)
        if payload is None:
            missing.append(gate_id)
            upsert_hard_gate(
                hard_gate_checks,
                f"gate_checkpoint_{gate_id}",
                False,
                f"{gate_id} checkpoint JSON invalid",
            )
            continue

        status = maybe_get_string(payload, ["status"]) or "unknown"
        hard_gate = maybe_get_bool(payload, ["hardGate"])
        reason_codes = maybe_get_list(payload, ["reasonCodes"]) or []
        reason_codes_norm = [str(item) for item in reason_codes]
        failed = status == "fail" and hard_gate is True
        if failed:
            hard_failed.append(gate_id)

        refs.append(
            {
                "gateId": gate_id,
                "path": str(path),
                "status": status,
                "hardGate": bool(hard_gate),
                "reasonCodes": reason_codes_norm,
            }
        )
        upsert_hard_gate(
            hard_gate_checks,
            f"gate_checkpoint_{gate_id}",
            not failed,
            f"status={status}; reasonCodes={','.join(reason_codes_norm)}",
        )

    upsert_hard_gate(
        hard_gate_checks,
        "gate_checkpoints_complete",
        len(missing) == 0,
        "all checkpoints available" if len(missing) == 0 else f"missing={','.join(missing)}",
    )
    upsert_hard_gate(
        hard_gate_checks,
        "gate_checkpoints_hard_pass",
        len(hard_failed) == 0,
        "all hard checkpoints passed"
        if len(hard_failed) == 0
        else f"hard-failed={','.join(hard_failed)}",
    )

    gate_dir = ""
    if len(refs) > 0:
        gate_dir = str(Path(refs[0]["path"]).parent)
    elif copied_paths.get("gateCheckpointsIndex") is not None:
        gate_dir = str(copied_paths["gateCheckpointsIndex"].parent)

    pack["gateCheckpoints"] = {
        "dir": gate_dir,
        "checkpoints": refs,
        "summary": {
            "total": len(refs),
            "missing": missing,
            "hardFailed": hard_failed,
            "overallHardPass": len(hard_failed) == 0 and len(missing) == 0,
        },
    }


def apply_v5_threshold_overlay(pack: dict[str, Any]) -> None:
    exp = pack.get("experimentVerdict")
    if not isinstance(exp, dict):
        return

    thresholds_src = exp.get("thresholds")
    metrics_src = exp.get("aggregateMetrics")
    if not isinstance(thresholds_src, dict) or not isinstance(metrics_src, dict):
        return

    thresholds: dict[str, Any] = {
        "meanPboMax": thresholds_src.get("meanPboMax"),
        "meanDsrProbabilityMin": thresholds_src.get("meanDsrProbabilityMin"),
        "fdrQMax": thresholds_src.get("fdrQMax"),
    }
    measured: dict[str, Any] = {
        "meanPbo": metrics_src.get("meanPbo"),
        "meanDsrProbability": metrics_src.get("meanDsrProbability"),
        "fdrQ": metrics_src.get("fdrQ"),
    }

    current_thresholds = pack.get("thresholds")
    if isinstance(current_thresholds, dict) and "releaseGateStatusAgeHoursMax" in current_thresholds:
        thresholds["releaseGateStatusAgeHoursMax"] = current_thresholds["releaseGateStatusAgeHoursMax"]
    current_measured = pack.get("measured")
    if isinstance(current_measured, dict) and "releaseGateStatusAgeHours" in current_measured:
        measured["releaseGateStatusAgeHours"] = current_measured["releaseGateStatusAgeHours"]

    pack["thresholds"] = thresholds
    pack["measured"] = measured


def main() -> int:
    args = parse_args()
    template_path = Path(args.template)
    output_dir = Path(args.output_dir)

    try:
        template = read_json(template_path)
        artifacts = template.get("artifacts")
        if not isinstance(artifacts, dict):
            raise ValueError("template.artifacts must be an object.")

        overrides: dict[str, str | None] = {
            "protocolSpec": args.protocol_spec,
            "protocolHashFile": args.protocol_hash_file,
            "comparabilityReport": args.comparability_report,
            "championRegistrySnapshot": args.champion_registry_snapshot,
            "releaseGateStatus": args.release_gate_status,
            "offlineMetrics": args.offline_metrics,
            "liveShadowMetrics14d": args.live_shadow_metrics,
            "stateMachineLog": args.state_machine_log,
            "decisionMarkdown": args.decision_markdown,
        }

        v5_mode = bool(args.gate_checkpoints_dir or args.experiment_verdict)
        required_keys = (
            ["releaseGateStatus"]
            if v5_mode
            else [
                "protocolSpec",
                "protocolHashFile",
                "comparabilityReport",
                "championRegistrySnapshot",
                "releaseGateStatus",
                "offlineMetrics",
                "liveShadowMetrics14d",
                "stateMachineLog",
                "decisionMarkdown",
            ]
        )
        optional_missing_keys = (
            {
                "protocolSpec",
                "protocolHashFile",
                "comparabilityReport",
                "championRegistrySnapshot",
                "offlineMetrics",
                "liveShadowMetrics14d",
                "stateMachineLog",
                "decisionMarkdown",
            }
            if v5_mode
            else set()
        )
        for key in required_keys:
            if key not in artifacts and key != "releaseGateStatus":
                raise ValueError(f"template.artifacts missing required key: {key}")
            if key == "releaseGateStatus":
                release_cfg = template.get("releaseGateStatus")
                if key not in artifacts and not (
                    isinstance(release_cfg, dict)
                    and isinstance(release_cfg.get("path"), str)
                ):
                    raise ValueError(
                        "releaseGateStatus source/destination is not defined in template."
                    )

        output_dir.mkdir(parents=True, exist_ok=True)
        output_dir_name = output_dir.name
        copied_paths: dict[str, Path] = {}
        manifest_entries: list[dict[str, Any]] = []
        missing: list[dict[str, str]] = []
        missing_optional: list[dict[str, str]] = []

        for key, raw_dest in artifacts.items():
            if not isinstance(raw_dest, str):
                raise ValueError(f"artifacts.{key} must be string path.")

            rel_dest = normalize_artifact_rel_path(raw_dest, output_dir_name)
            dest_path = output_dir / rel_dest

            if key in NON_COPY_ARTIFACT_KEYS:
                continue

            override = overrides.get(key)
            if override:
                source_path = Path(override)
            elif key == "releaseGateStatus":
                release_cfg = template.get("releaseGateStatus")
                if isinstance(release_cfg, dict) and isinstance(
                    release_cfg.get("path"), str
                ):
                    source_path = Path(release_cfg["path"])
                else:
                    source_path = Path(raw_dest)
            else:
                source_path = Path(raw_dest)

            entry: dict[str, Any] = {
                "key": key,
                "sourcePath": str(source_path),
                "destinationPath": str(dest_path),
                "copied": False,
                "exists": False,
                "sha256": None,
                "sizeBytes": None,
            }

            if not source_path.exists():
                if key in optional_missing_keys:
                    missing_optional.append({"key": key, "sourcePath": str(source_path)})
                else:
                    missing.append({"key": key, "sourcePath": str(source_path)})
                manifest_entries.append(entry)
                continue

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            if source_path.resolve() != dest_path.resolve():
                shutil.copy2(source_path, dest_path)
                entry["copied"] = True
            entry["exists"] = True
            entry["sizeBytes"] = dest_path.stat().st_size
            entry["sha256"] = sha256_file(dest_path)
            manifest_entries.append(entry)
            copied_paths[key] = dest_path

        if args.experiment_verdict:
            exp_source = Path(args.experiment_verdict)
            exp_dest = output_dir / "experiment_verdict.v2.json"
            exp_copied = copy_optional_artifact(
                "experimentVerdict",
                exp_source,
                exp_dest,
                manifest_entries,
                missing,
            )
            if exp_copied:
                copied_paths["experimentVerdict"] = exp_copied

        if args.gate_checkpoints_dir:
            gate_dir = Path(args.gate_checkpoints_dir)
            for gate_id in ("G0", "G1", "G2", "G3", "G4"):
                source = gate_dir / f"{gate_id}.checkpoint.json"
                dest = output_dir / "gates" / f"{gate_id}.checkpoint.json"
                copied = copy_optional_artifact(
                    f"gateCheckpoint{gate_id}",
                    source,
                    dest,
                    manifest_entries,
                    missing,
                )
                if copied:
                    copied_paths[f"gateCheckpoint{gate_id}"] = copied
            index_source = gate_dir / "gate_checkpoints_index.v1.json"
            index_dest = output_dir / "gates" / "gate_checkpoints_index.v1.json"
            index_copied = copy_optional_artifact(
                "gateCheckpointsIndex",
                index_source,
                index_dest,
                manifest_entries,
                missing_optional,
            )
            if index_copied:
                copied_paths["gateCheckpointsIndex"] = index_copied

        evidence_pack = copy.deepcopy(template)
        evidence_pack["generatedAt"] = utc_now_iso()
        ensure_decision_shape(evidence_pack)
        collect_measured_metrics(evidence_pack, copied_paths)
        collect_hard_gate_checks(
            evidence_pack,
            copied_paths,
            allow_legacy_missing=v5_mode,
        )
        if args.experiment_verdict:
            ingest_experiment_verdict(evidence_pack, copied_paths)
        if args.gate_checkpoints_dir:
            ingest_gate_checkpoints(evidence_pack, copied_paths)
        if v5_mode:
            apply_v5_threshold_overlay(evidence_pack)

        normalized_artifacts: dict[str, str] = {}
        for key, raw_dest in artifacts.items():
            rel_dest = normalize_artifact_rel_path(str(raw_dest), output_dir_name)
            normalized_artifacts[key] = f"{output_dir_name}/{rel_dest}"
        if "experimentVerdict" in copied_paths:
            normalized_artifacts["experimentVerdict"] = (
                f"{output_dir_name}/experiment_verdict.v2.json"
            )
        for gate_id in ("G0", "G1", "G2", "G3", "G4"):
            key = f"gateCheckpoint{gate_id}"
            if key in copied_paths:
                normalized_artifacts[key] = (
                    f"{output_dir_name}/gates/{gate_id}.checkpoint.json"
                )
        if "gateCheckpointsIndex" in copied_paths:
            normalized_artifacts["gateCheckpointsIndex"] = (
                f"{output_dir_name}/gates/gate_checkpoints_index.v1.json"
            )
        evidence_pack["artifacts"] = normalized_artifacts

        release_status = evidence_pack.get("releaseGateStatus")
        if isinstance(release_status, dict):
            release_dest = normalized_artifacts.get(
                "releaseGateStatus", f"{output_dir_name}/release_gate_status.json"
            )
            release_status["path"] = release_dest
            copied_release = copied_paths.get("releaseGateStatus")
            if copied_release:
                release_payload = try_read_json(copied_release)
                if release_payload:
                    release_status["generatedAt"] = release_payload.get("generatedAt")
                    release_status["expiresAt"] = release_payload.get("expiresAt")
                    release_status["allowPaperTrading"] = release_payload.get(
                        "allowPaperTrading"
                    )
                    release_status["allowLiveTrading"] = release_payload.get(
                        "allowLiveTrading"
                    )
                    release_status["failedChecks"] = normalize_string_list(
                        release_payload.get("failedChecks")
                    )
                    release_status["warningChecks"] = normalize_string_list(
                        release_payload.get("warningChecks")
                    )
                    release_result = maybe_get_string(release_payload, ["result"])
                    if release_result in {"GO", "GO_WITH_CONSTRAINTS", "NO_GO"}:
                        release_status["result"] = release_result
                    raw_reason_codes = release_payload.get("reasonCodes")
                    if isinstance(raw_reason_codes, list):
                        release_status["reasonCodes"] = normalize_string_list(
                            raw_reason_codes
                        )
                    raw_checks = release_payload.get("checks")
                    if isinstance(raw_checks, list):
                        release_status["checks"] = [
                            item for item in raw_checks if isinstance(item, dict)
                        ]
                    source_report_path = maybe_get_string(
                        release_payload, ["sourceReportPath"]
                    )
                    if source_report_path is not None:
                        release_status["sourceReportPath"] = source_report_path

        evidence_pack_rel = normalize_artifact_rel_path(
            str(artifacts.get("evidencePack", f"{output_dir_name}/evidence_pack.json")),
            output_dir_name,
        )
        evidence_pack_path = output_dir / evidence_pack_rel
        evidence_pack_path.parent.mkdir(parents=True, exist_ok=True)
        evidence_pack_path.write_text(
            f"{json.dumps(evidence_pack, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )

        manifest_rel = normalize_artifact_rel_path(
            str(artifacts.get("manifest", f"{output_dir_name}/manifest.json")),
            output_dir_name,
        )
        manifest_path = output_dir / manifest_rel
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_payload = {
            "version": "v1",
            "generatedAt": utc_now_iso(),
            "templatePath": str(template_path),
            "outputDir": str(output_dir),
            "missingCount": len(missing),
            "missing": missing,
            "missingOptionalCount": len(missing_optional),
            "missingOptional": missing_optional,
            "artifacts": manifest_entries,
            "evidencePackPath": str(evidence_pack_path),
        }
        manifest_path.write_text(
            f"{json.dumps(manifest_payload, ensure_ascii=False, indent=2)}\n",
            encoding="utf-8",
        )

        print(
            json.dumps(
                {
                    "status": "built" if not missing else "incomplete",
                    "outputDir": str(output_dir),
                    "manifest": str(manifest_path),
                    "evidencePack": str(evidence_pack_path),
                    "missingCount": len(missing),
                    "missingOptionalCount": len(missing_optional),
                    "v5Mode": v5_mode,
                },
                ensure_ascii=False,
            )
        )
        return EXIT_OK if not missing else EXIT_MISSING_ARTIFACTS
    except Exception as exc:  # noqa: BLE001
        print(
            json.dumps(
                {"status": "tool_error", "message": str(exc)},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        return EXIT_TOOL_ERROR


if __name__ == "__main__":
    sys.exit(main())
