#!/usr/bin/env python3
"""Regression tests for governance pre-flight scripts.

Coverage:
- build_decision_packet + validate_decision_packet happy path
- verify_freeze_manifest schema enforcement
- python_fallback argument forwarding with `--` separator
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"
TEMPLATE_PATH = (
    REPO_ROOT / "docs/research/templates/go_no_go_evidence_pack.template.json"
)
FREEZE_SCHEMA_PATH = (
    REPO_ROOT / "docs/research/templates/freeze_manifest.schema.v1.json"
)
GATE_INDEX_SCHEMA_PATH = (
    REPO_ROOT / "docs/research/templates/gate_checkpoint_index.schema.v1.json"
)


def now_utc_iso() -> str:
    return (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def run_script(
    args: list[str], cwd: Path = REPO_ROOT
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        cwd=str(cwd),
        text=True,
        capture_output=True,
        check=False,
    )


class TestGovernancePipeline(unittest.TestCase):
    def make_freeze_manifest(
        self, *, with_extra_field: bool = False
    ) -> dict[str, object]:
        payload: dict[str, object] = {
            "manifestVersion": "v1",
            "frozenAt": now_utc_iso(),
            "versions": {
                "sm": "sm-v1",
                "stats": "stats-v1",
                "hash": "hash-v1",
                "evidence": "evidence-v1",
            },
            "thresholds": {
                "transferPassRatioRolling14dMin": 0.25,
                "winnerEligibleRatioRolling14dMin": 0.35,
            },
            "raciSnapshot": {
                "E7": {"dri": "alice", "backup": "bob", "nightOnCall": "carol"},
                "E8": {"dri": "dave", "backup": "erin", "nightOnCall": "frank"},
                "E9": {"dri": "grace", "backup": "heidi", "nightOnCall": "ivan"},
            },
            "incidentCommander": "judy",
            "l2OverrideAllowlist": ["lead1"],
            "signOff": {"approvedBy": ["cto"], "approvedAt": now_utc_iso()},
        }
        if with_extra_field:
            payload["unexpectedTopLevel"] = "should-fail-schema"
        return payload

    def write_json_file(self, path: Path, payload: dict[str, object]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def make_checkpoint_setup(self, root: Path) -> dict[str, Path]:
        paths = {
            "output_dir": root / "gates",
            "env_report": root / "environment_verify_report.json",
            "freeze_report": root / "freeze_verify_report.json",
            "preflight_report": root / "gates_preflight_report.json",
            "quality_report": root / "research_quality_report.json",
            "verdict_report": root / "experiment_verdict.v2.json",
            "release_gate_status": root / "release_gate_status.json",
            "contract_report": root / "research_contract_verify_report.json",
            "contract_report_legacy": root / "research_contract_verify_outputs.json",
            "contract_validate_out": root / "contract_validate_report.json",
        }

        self.write_json_file(
            paths["env_report"],
            {
                "passed": True,
                "generatedAt": now_utc_iso(),
                "failedChecks": [],
            },
        )
        self.write_json_file(
            paths["freeze_report"],
            {
                "passed": True,
                "generatedAt": now_utc_iso(),
                "failures": [],
            },
        )
        self.write_json_file(
            paths["preflight_report"],
            {
                "passed": True,
                "generatedAt": now_utc_iso(),
                "steps": [
                    {"name": "env:verify", "exitCode": 0},
                    {"name": "freeze:verify", "exitCode": 0},
                ],
                "finalExitCode": 0,
            },
        )
        self.write_json_file(
            paths["quality_report"],
            {
                "generatedAt": now_utc_iso(),
                "paperCount": 10,
                "paperCardSchemaPassRate": 1.0,
                "missingRequiredFields": 0,
                "evidenceLinkRate": 1.0,
                "overallPassed": True,
            },
        )
        self.write_json_file(
            paths["verdict_report"],
            {
                "schemaVersion": "experiment_verdict.v2",
                "generatedAt": now_utc_iso(),
                "result": "GO",
                "reasonCodes": ["INFO_MVP_THRESHOLDS_PASS"],
                "thresholds": {
                    "meanPboMax": 0.2,
                    "meanDsrProbabilityMin": 0.5,
                    "fdrQMax": 0.1,
                },
                "aggregateMetrics": {
                    "meanPbo": 0.1,
                    "meanDsrProbability": 0.7,
                    "fdrQ": 0.05,
                },
                "candidates": [
                    {
                        "strategyId": "S1",
                        "strategyName": "demo",
                        "status": "pass",
                        "metrics": {
                            "pbo": 0.1,
                            "dsrProbability": 0.7,
                            "fdrQ": 0.05,
                        },
                        "releaseGate": {
                            "allowPaperTrading": True,
                            "allowLiveTrading": True,
                            "failedChecks": [],
                        },
                    }
                ],
                "outputPaths": {
                    "validationRuns": str(root / "strategy_validation_runs.json"),
                    "releaseGateStatus": str(paths["release_gate_status"]),
                },
            },
        )
        self.write_json_file(
            paths["release_gate_status"],
            {
                "version": 1,
                "generatedAt": now_utc_iso(),
                "allowPaperTrading": True,
                "allowLiveTrading": True,
                "failedChecks": [],
                "warningChecks": [],
            },
        )

        return paths

    def test_build_and_validate_happy_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-gov-pass-") as tmp:
            tmp_dir = Path(tmp)
            packet_dir = tmp_dir / "packet"
            packet_dir.mkdir(parents=True, exist_ok=True)

            protocol_hash = f"phash:v1:{'a' * 64}"
            dataset_snapshot = f"dsnap:v1:{'b' * 24}"
            now = datetime.now(timezone.utc)

            protocol_spec = tmp_dir / "protocol_spec.json"
            protocol_spec.write_text(
                json.dumps(
                    {
                        "version": "v1",
                        "runtimeProtocolHash": protocol_hash,
                        "seed": 42,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            protocol_hash_file = tmp_dir / "protocol_hash.txt"
            protocol_hash_file.write_text(f"{protocol_hash}\n", encoding="utf-8")

            comparability_report = tmp_dir / "comparability_report.json"
            comparability_report.write_text(
                json.dumps(
                    {"allComparable": True, "incomparableRuns": []},
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            champion_registry = tmp_dir / "champion_registry_snapshot.json"
            champion_registry.write_text(
                json.dumps(
                    {
                        "schemaVersion": "v1",
                        "version": 3,
                        "updatedAt": now_utc_iso(),
                        "writer": "pipeline",
                        "protocolHash": protocol_hash,
                        "datasetSnapshotId": dataset_snapshot,
                        "championConfigId": "H1",
                        "status": "active",
                        "fallbackConfigId": "H0",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            release_gate_status = tmp_dir / "release_gate_status.json"
            release_gate_status.write_text(
                json.dumps(
                    {
                        "generatedAt": (now - timedelta(hours=1))
                        .isoformat(timespec="seconds")
                        .replace("+00:00", "Z"),
                        "expiresAt": (now + timedelta(hours=23))
                        .isoformat(timespec="seconds")
                        .replace("+00:00", "Z"),
                        "allowPaperTrading": True,
                        "allowLiveTrading": True,
                        "result": "GO",
                        "reasonCodes": ["INFO_RELEASE_GATE_PASS"],
                        "checks": [
                            {
                                "name": "wfo",
                                "status": "pass",
                                "summary": "all windows passed",
                                "metrics": {"failedWindows": 0, "windowCount": 15},
                            }
                        ],
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            offline_metrics = tmp_dir / "offline_metrics.json"
            offline_metrics.write_text(
                json.dumps(
                    {
                        "transferPassRatioRolling14d": 0.33,
                        "winnerEligibleRatioRolling14d": 0.45,
                        "meanPbo": 0.14,
                        "meanDsrProbability": 0.66,
                        "fdrQ": 0.08,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            live_shadow_metrics = tmp_dir / "live_shadow_metrics.json"
            live_shadow_metrics.write_text(
                json.dumps(
                    {
                        "quoteAgeP95Ms": 1100,
                        "decisionToSubmitP95Ms": 600,
                        "decisionToFirstFillP95Ms": 1700,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            state_machine_log = tmp_dir / "state_machine_log.jsonl"
            state_machine_log.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "timestamp": now_utc_iso(),
                                "from": "NORMAL",
                                "to": "WATCH",
                                "event": "warn",
                            },
                            ensure_ascii=False,
                        ),
                        json.dumps(
                            {
                                "timestamp": now_utc_iso(),
                                "from": "WATCH",
                                "to": "NORMAL",
                                "event": "recover",
                            },
                            ensure_ascii=False,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            decision_md = tmp_dir / "decision.md"
            decision_md.write_text(
                "# decision\n\nall checks passed\n", encoding="utf-8"
            )

            build_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_decision_packet.py"),
                    "--template",
                    str(TEMPLATE_PATH),
                    "--output-dir",
                    str(packet_dir),
                    "--protocol-spec",
                    str(protocol_spec),
                    "--protocol-hash-file",
                    str(protocol_hash_file),
                    "--comparability-report",
                    str(comparability_report),
                    "--champion-registry-snapshot",
                    str(champion_registry),
                    "--release-gate-status",
                    str(release_gate_status),
                    "--offline-metrics",
                    str(offline_metrics),
                    "--live-shadow-metrics",
                    str(live_shadow_metrics),
                    "--state-machine-log",
                    str(state_machine_log),
                    "--decision-markdown",
                    str(decision_md),
                ]
            )
            self.assertEqual(0, build_proc.returncode, msg=build_proc.stderr)

            evidence_pack = json.loads(
                (packet_dir / "evidence_pack.json").read_text(encoding="utf-8")
            )
            measured = evidence_pack.get("measured", {})
            self.assertGreater(float(measured.get("quoteAgeP95Ms", 0.0)), 0.0)
            self.assertGreater(
                float(measured.get("transferPassRatioRolling14d", 0.0)), 0.0
            )
            release_status = evidence_pack.get("releaseGateStatus", {})
            self.assertEqual("GO", release_status.get("result"))
            self.assertEqual(
                ["INFO_RELEASE_GATE_PASS"], release_status.get("reasonCodes")
            )
            self.assertEqual(
                [
                    {
                        "name": "wfo",
                        "status": "pass",
                        "summary": "all windows passed",
                        "metrics": {"failedWindows": 0, "windowCount": 15},
                    }
                ],
                release_status.get("checks"),
            )

            hard_checks = evidence_pack.get("hardGateChecks", [])
            self.assertIsInstance(hard_checks, list)
            for item in hard_checks:
                if isinstance(item, dict) and isinstance(item.get("name"), str):
                    self.assertIs(
                        item.get("passed"), True, msg=f"hard gate not passed: {item}"
                    )

            freeze_manifest_path = tmp_dir / "freeze_manifest.json"
            freeze_manifest_path.write_text(
                json.dumps(self.make_freeze_manifest(), ensure_ascii=False, indent=2)
                + "\n",
                encoding="utf-8",
            )

            validate_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "validate_decision_packet.py"),
                    "--packet-dir",
                    str(packet_dir),
                    "--freeze-manifest",
                    str(freeze_manifest_path),
                    "--output",
                    str(packet_dir / "verdict.json"),
                ]
            )
            self.assertEqual(0, validate_proc.returncode, msg=validate_proc.stderr)

            verdict = json.loads(
                (packet_dir / "verdict.json").read_text(encoding="utf-8")
            )
            self.assertEqual("GO", verdict.get("verdict"))

    def test_verify_freeze_manifest_rejects_schema_violation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-freeze-schema-") as tmp:
            tmp_dir = Path(tmp)
            manifest_path = tmp_dir / "freeze_manifest.invalid.json"
            report_path = tmp_dir / "freeze_verify_report.json"
            manifest_path.write_text(
                json.dumps(
                    self.make_freeze_manifest(with_extra_field=True),
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "verify_freeze_manifest.py"),
                    "--manifest",
                    str(manifest_path),
                    "--schema",
                    str(FREEZE_SCHEMA_PATH),
                    "--output",
                    str(report_path),
                ]
            )
            self.assertEqual(2, proc.returncode)

            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertFalse(bool(report.get("passed")))
            errors = report.get("schemaValidationErrors", [])
            self.assertTrue(any("schema:" in str(item) for item in errors))

    def test_v5_gate_checkpoint_traceability(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-v5-checkpoints-") as tmp:
            tmp_dir = Path(tmp)
            packet_dir = tmp_dir / "packet"
            gate_dir = tmp_dir / "gates"
            packet_dir.mkdir(parents=True, exist_ok=True)
            gate_dir.mkdir(parents=True, exist_ok=True)

            now = datetime.now(timezone.utc)
            experiment_verdict = tmp_dir / "experiment_verdict.v2.json"
            validation_runs = tmp_dir / "runs.json"
            release_gate_status = tmp_dir / "release_gate_status.json"
            release_gate_status.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "generatedAt": now_utc_iso(),
                        "allowPaperTrading": False,
                        "allowLiveTrading": False,
                        "failedChecks": [],
                        "warningChecks": [],
                        "result": "NO_GO",
                        "reasonCodes": [
                            "HARD_MEAN_PBO_THRESHOLD_FAIL",
                            "HARD_RELEASE_GATE_BLOCKED",
                        ],
                        "checks": [
                            {"name": "wfo", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                            {"name": "significance", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                            {"name": "risk_simulation", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                            {"name": "execution_quality", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                            {"name": "ramp_up", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                            {"name": "regime_shift", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                        ],
                        "sourceReportPath": str(validation_runs),
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            freeze_manifest_path = tmp_dir / "freeze_manifest.json"
            validation_runs.write_text(
                json.dumps(
                    {
                        "schemaVersion": "strategy_validation_runs.v1",
                        "generatedAt": now_utc_iso(),
                        "symbols": [
                            {
                                "symbol": "BTC/USD",
                                "result": "NO_GO",
                                "reasonCodes": [
                                    "HARD_FDR_THRESHOLD_FAIL",
                                    "HARD_NO_CANDIDATE_PASS",
                                ],
                                "leader": {
                                    "strategyId": "S1",
                                    "strategyName": "demo",
                                    "status": "fail",
                                    "failureReasons": [
                                        "HARD_FDR_THRESHOLD_FAIL",
                                        "HARD_RELEASE_GATE_BLOCKED",
                                    ],
                                    "blockerSummary": {
                                        "primaryBlocker": "fdr",
                                        "fdr": {
                                            "passed": False,
                                            "qValue": 0.4,
                                            "threshold": 0.1,
                                        },
                                        "releaseGate": {
                                            "allowPaperTrading": False,
                                            "allowLiveTrading": False,
                                            "failedChecks": ["wfo"],
                                        },
                                        "wfo": {
                                            "passed": False,
                                            "failedWindows": 11,
                                            "windowCount": 15,
                                            "failedWindowRatio": 11 / 15,
                                        },
                                    },
                                },
                                "candidates": [
                                    {
                                        "strategyId": "S1",
                                        "strategyName": "demo",
                                        "status": "fail",
                                        "failureReasons": [
                                            "HARD_FDR_THRESHOLD_FAIL",
                                            "HARD_RELEASE_GATE_BLOCKED",
                                        ],
                                        "blockerSummary": {
                                            "primaryBlocker": "fdr",
                                            "fdr": {
                                                "passed": False,
                                                "qValue": 0.4,
                                                "threshold": 0.1,
                                            },
                                            "releaseGate": {
                                                "allowPaperTrading": False,
                                                "allowLiveTrading": False,
                                                "failedChecks": ["wfo"],
                                            },
                                            "wfo": {
                                                "passed": False,
                                                "failedWindows": 11,
                                                "windowCount": 15,
                                                "failedWindowRatio": 11 / 15,
                                            },
                                        },
                                    },
                                    {
                                        "strategyId": "S2",
                                        "strategyName": "demo2",
                                        "status": "fail",
                                        "failureReasons": ["HARD_FDR_THRESHOLD_FAIL"],
                                        "blockerSummary": {
                                            "primaryBlocker": "fdr",
                                            "fdr": {
                                                "passed": False,
                                                "qValue": 0.4,
                                                "threshold": 0.1,
                                            },
                                        },
                                    },
                                    {
                                        "strategyId": "S3",
                                        "strategyName": "demo3",
                                        "status": "fail",
                                        "failureReasons": ["HARD_RELEASE_GATE_BLOCKED"],
                                        "blockerSummary": {
                                            "primaryBlocker": "releaseGate",
                                            "releaseGate": {
                                                "allowPaperTrading": False,
                                                "allowLiveTrading": False,
                                                "failedChecks": ["wfo"],
                                            },
                                        },
                                    },
                                ],
                            }
                        ],
                        "portfolio": {
                            "result": "NO_GO",
                            "reasonCodes": [
                                "HARD_MEAN_PBO_THRESHOLD_FAIL",
                                "HARD_RELEASE_GATE_BLOCKED",
                            ],
                            "championSet": [],
                            "releaseGate": {
                                "allowPaperTrading": False,
                                "allowLiveTrading": False,
                                "failedChecks": [],
                                "warningChecks": [],
                                "checks": [
                                    {"name": "wfo", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                    {"name": "significance", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                    {"name": "risk_simulation", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                    {"name": "execution_quality", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                    {"name": "ramp_up", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                    {"name": "regime_shift", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                                ],
                            },
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            experiment_verdict.write_text(
                json.dumps(
                    {
                        "schemaVersion": "experiment_verdict.v2",
                        "generatedAt": now_utc_iso(),
                        "result": "NO_GO",
                        "reasonCodes": [
                            "HARD_MEAN_PBO_THRESHOLD_FAIL",
                            "HARD_RELEASE_GATE_BLOCKED",
                        ],
                        "thresholds": {
                            "meanPboMax": 0.2,
                            "meanDsrProbabilityMin": 0.5,
                            "fdrQMax": 0.1,
                        },
                        "aggregateMetrics": {
                            "meanPbo": 0.9,
                            "meanDsrProbability": 0.1,
                            "fdrQ": 0.4,
                        },
                        "candidates": [
                            {
                                "strategyId": "S1",
                                "strategyName": "demo",
                                "status": "fail",
                                "metrics": {
                                    "pbo": 0.9,
                                    "dsrProbability": 0.1,
                                    "fdrQ": 0.4,
                                },
                                "releaseGate": {
                                    "allowPaperTrading": False,
                                    "allowLiveTrading": False,
                                    "failedChecks": ["significance"],
                                },
                                "failureReasonCode": "HARD_MEAN_PBO_THRESHOLD_FAIL",
                            }
                        ],
                        "outputPaths": {
                            "validationRuns": str(validation_runs),
                            "releaseGateStatus": str(release_gate_status),
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )

            for gate_id, status in (
                ("G0", "pass"),
                ("G1", "pass"),
                ("G2", "pass"),
                ("G3", "fail"),
                ("G4", "fail"),
            ):
                payload = {
                    "schemaVersion": "gate_checkpoint.v1",
                    "gateId": gate_id,
                    "generatedAt": now_utc_iso(),
                    "hardGate": True,
                    "status": status,
                    "summary": {"total": 1, "passed": 0 if status == "fail" else 1, "failed": 1 if status == "fail" else 0, "warned": 0},
                    "checks": [
                        {
                            "name": "demo_check",
                            "passed": status != "fail",
                            "severity": "hard",
                            "reasonCode": "HARD_DEMO_FAIL" if status == "fail" else "INFO_DEMO_PASS",
                            "detail": f"{gate_id}:{status}",
                        }
                    ],
                    "reasonCodes": ["HARD_DEMO_FAIL"] if status == "fail" else [],
                    "inputs": {},
                }
                (gate_dir / f"{gate_id}.checkpoint.json").write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )

            build_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_decision_packet.py"),
                    "--template",
                    str(TEMPLATE_PATH),
                    "--output-dir",
                    str(packet_dir),
                    "--release-gate-status",
                    str(release_gate_status),
                    "--gate-checkpoints-dir",
                    str(gate_dir),
                    "--experiment-verdict",
                    str(experiment_verdict),
                ]
            )
            self.assertEqual(0, build_proc.returncode, msg=build_proc.stderr)

            evidence_pack = json.loads(
                (packet_dir / "evidence_pack.json").read_text(encoding="utf-8")
            )
            experiment_section = evidence_pack.get("experimentVerdict", {})
            self.assertEqual("NO_GO", experiment_section.get("result"))
            self.assertEqual(
                {"kind": "validation_runs", "path": str(validation_runs)},
                experiment_section.get("symbolDiagnosticsSource"),
            )
            symbol_diagnostics = experiment_section.get("symbolDiagnostics", [])
            self.assertEqual(1, len(symbol_diagnostics))
            self.assertEqual("BTC/USD", symbol_diagnostics[0].get("symbol"))
            self.assertEqual("fdr", symbol_diagnostics[0].get("primaryBlocker"))
            top_release_gate = evidence_pack.get("releaseGateStatus", {})
            self.assertEqual("packet/release_gate_status.json", top_release_gate.get("path"))
            self.assertEqual("NO_GO", top_release_gate.get("result"))
            self.assertEqual([], top_release_gate.get("failedChecks"))
            self.assertEqual([], top_release_gate.get("warningChecks"))
            self.assertEqual(
                ["HARD_MEAN_PBO_THRESHOLD_FAIL", "HARD_RELEASE_GATE_BLOCKED"],
                top_release_gate.get("reasonCodes"),
            )
            self.assertEqual(str(validation_runs), top_release_gate.get("sourceReportPath"))
            self.assertEqual(
                [
                    {"name": "wfo", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "significance", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "risk_simulation", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "execution_quality", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "ramp_up", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "regime_shift", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                ],
                top_release_gate.get("checks"),
            )
            blocker_diagnostics = evidence_pack.get("blockerDiagnostics", {})
            self.assertEqual("NO_GO", blocker_diagnostics.get("summary", {}).get("result"))
            self.assertEqual(1, blocker_diagnostics.get("summary", {}).get("blockedSymbolCount"))
            self.assertGreaterEqual(
                blocker_diagnostics.get("summary", {}).get("blockedCandidateCount", 0),
                1,
            )
            self.assertEqual(
                {
                    "experimentVerdict": experiment_section.get("path"),
                    "validationRuns": str(validation_runs),
                    "releaseGateStatus": str(release_gate_status),
                },
                blocker_diagnostics.get("sourcePaths"),
            )
            portfolio_diagnostics = blocker_diagnostics.get("portfolio", {})
            self.assertEqual(
                ["HARD_MEAN_PBO_THRESHOLD_FAIL", "HARD_RELEASE_GATE_BLOCKED"],
                blocker_diagnostics.get("summary", {}).get("reasonCodes"),
            )
            self.assertEqual(
                ["HARD_MEAN_PBO_THRESHOLD_FAIL", "HARD_RELEASE_GATE_BLOCKED"],
                portfolio_diagnostics.get("reasonCodes"),
            )
            release_gate = portfolio_diagnostics.get("releaseGate", {})
            self.assertEqual([], release_gate.get("failedChecks"))
            self.assertEqual(
                [
                    {"name": "wfo", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "significance", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "risk_simulation", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "execution_quality", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "ramp_up", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                    {"name": "regime_shift", "status": "skipped", "summary": "missing=BTC/USD | sources=0"},
                ],
                release_gate.get("blockingChecks"),
            )
            symbol_blockers = blocker_diagnostics.get("symbols", [])
            self.assertEqual(1, len(symbol_blockers))
            self.assertEqual("BTC/USD", symbol_blockers[0].get("symbol"))
            self.assertEqual("leader", symbol_blockers[0].get("candidateSource"))
            self.assertEqual("fdr", symbol_blockers[0].get("primaryCandidate", {}).get("primaryBlocker"))
            self.assertEqual(
                ["wfo"],
                symbol_blockers[0]
                .get("primaryCandidate", {})
                .get("releaseGate", {})
                .get("failedChecks"),
            )
            self.assertEqual(3, len(symbol_blockers[0].get("blockedCandidates", [])))

            freeze_manifest_path.write_text(
                json.dumps(self.make_freeze_manifest(), ensure_ascii=False, indent=2)
                + "\n",
                encoding="utf-8",
            )

            validate_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "validate_decision_packet.py"),
                    "--packet-dir",
                    str(packet_dir),
                    "--freeze-manifest",
                    str(freeze_manifest_path),
                    "--output",
                    str(packet_dir / "verdict.json"),
                ]
            )
            self.assertEqual(2, validate_proc.returncode, msg=validate_proc.stderr)

            verdict = json.loads((packet_dir / "verdict.json").read_text(encoding="utf-8"))
            self.assertEqual("NO_GO", verdict.get("verdict"))
            trace = verdict.get("hardGateFailureTrace", [])
            self.assertTrue(
                any(item.get("name") == "gate_checkpoint_G3" for item in trace if isinstance(item, dict))
            )

    def test_gate_checkpoint_index_contract_validation_pass(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-gate-index-pass-") as tmp:
            tmp_dir = Path(tmp)
            paths = self.make_checkpoint_setup(tmp_dir)
            self.write_json_file(
                paths["contract_report"],
                {
                    "passed": True,
                    "generatedAt": now_utc_iso(),
                    "summary": {"totalFiles": 6, "passedFiles": 6, "failedFiles": 0},
                    "files": [],
                },
            )

            build_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_gate_checkpoints.py"),
                    "--output-dir",
                    str(paths["output_dir"]),
                    "--env-report",
                    str(paths["env_report"]),
                    "--freeze-report",
                    str(paths["freeze_report"]),
                    "--preflight-report",
                    str(paths["preflight_report"]),
                    "--research-quality-report",
                    str(paths["quality_report"]),
                    "--research-contract-report",
                    str(paths["contract_report"]),
                    "--research-contract-report-legacy",
                    str(paths["contract_report_legacy"]),
                    "--experiment-verdict",
                    str(paths["verdict_report"]),
                    "--release-gate-status",
                    str(paths["release_gate_status"]),
                ]
            )
            self.assertEqual(0, build_proc.returncode, msg=build_proc.stderr)

            validate_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "validate_research_contracts.py"),
                    "--inputs",
                    str(paths["output_dir"] / "gate_checkpoints_index.v1.json"),
                    "--output",
                    str(paths["contract_validate_out"]),
                ]
            )
            self.assertEqual(0, validate_proc.returncode, msg=validate_proc.stderr)

            report = json.loads(
                paths["contract_validate_out"].read_text(encoding="utf-8")
            )
            self.assertTrue(bool(report.get("passed")))
            files = report.get("files", [])
            self.assertTrue(
                any(
                    isinstance(item, dict)
                    and item.get("schemaVersion") == "gate_checkpoint_index.v1"
                    and item.get("passed") is True
                    for item in files
                )
            )

    def test_gate_checkpoint_contract_report_fallback_to_legacy(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-gate-fallback-") as tmp:
            tmp_dir = Path(tmp)
            paths = self.make_checkpoint_setup(tmp_dir)
            self.write_json_file(
                paths["contract_report_legacy"],
                {
                    "passed": True,
                    "generatedAt": now_utc_iso(),
                    "summary": {"totalFiles": 3, "passedFiles": 3, "failedFiles": 0},
                    "files": [],
                },
            )

            build_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_gate_checkpoints.py"),
                    "--output-dir",
                    str(paths["output_dir"]),
                    "--env-report",
                    str(paths["env_report"]),
                    "--freeze-report",
                    str(paths["freeze_report"]),
                    "--preflight-report",
                    str(paths["preflight_report"]),
                    "--research-quality-report",
                    str(paths["quality_report"]),
                    "--research-contract-report",
                    str(paths["contract_report"]),
                    "--research-contract-report-legacy",
                    str(paths["contract_report_legacy"]),
                    "--experiment-verdict",
                    str(paths["verdict_report"]),
                    "--release-gate-status",
                    str(paths["release_gate_status"]),
                ]
            )
            self.assertEqual(0, build_proc.returncode, msg=build_proc.stderr)

            index_payload = json.loads(
                (paths["output_dir"] / "gate_checkpoints_index.v1.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                str(paths["contract_report_legacy"]),
                index_payload.get("contractReportPathUsed"),
            )
            self.assertTrue(bool(index_payload.get("contractReportFallbackUsed")))

            g2_payload = json.loads(
                (paths["output_dir"] / "G2.checkpoint.json").read_text(encoding="utf-8")
            )
            rc_inputs = (
                g2_payload.get("inputs", {}).get("researchContractReport", {})
                if isinstance(g2_payload.get("inputs"), dict)
                else {}
            )
            self.assertEqual(
                str(paths["contract_report_legacy"]),
                rc_inputs.get("pathUsed"),
            )
            self.assertTrue(bool(rc_inputs.get("fallbackUsed")))

    def test_gate_checkpoint_contract_report_prefers_canonical(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-gate-canonical-") as tmp:
            tmp_dir = Path(tmp)
            paths = self.make_checkpoint_setup(tmp_dir)
            self.write_json_file(
                paths["contract_report"],
                {
                    "passed": False,
                    "generatedAt": now_utc_iso(),
                    "summary": {"totalFiles": 3, "passedFiles": 2, "failedFiles": 1},
                    "files": [{"path": "x.json", "passed": False}],
                },
            )
            self.write_json_file(
                paths["contract_report_legacy"],
                {
                    "passed": True,
                    "generatedAt": now_utc_iso(),
                    "summary": {"totalFiles": 3, "passedFiles": 3, "failedFiles": 0},
                    "files": [],
                },
            )

            build_proc = run_script(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "build_gate_checkpoints.py"),
                    "--output-dir",
                    str(paths["output_dir"]),
                    "--env-report",
                    str(paths["env_report"]),
                    "--freeze-report",
                    str(paths["freeze_report"]),
                    "--preflight-report",
                    str(paths["preflight_report"]),
                    "--research-quality-report",
                    str(paths["quality_report"]),
                    "--research-contract-report",
                    str(paths["contract_report"]),
                    "--research-contract-report-legacy",
                    str(paths["contract_report_legacy"]),
                    "--experiment-verdict",
                    str(paths["verdict_report"]),
                    "--release-gate-status",
                    str(paths["release_gate_status"]),
                ]
            )
            self.assertEqual(0, build_proc.returncode, msg=build_proc.stderr)

            index_payload = json.loads(
                (paths["output_dir"] / "gate_checkpoints_index.v1.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(
                str(paths["contract_report"]),
                index_payload.get("contractReportPathUsed"),
            )
            self.assertFalse(bool(index_payload.get("contractReportFallbackUsed")))
            self.assertFalse(bool(index_payload.get("overallHardPass")))

            g2_payload = json.loads(
                (paths["output_dir"] / "G2.checkpoint.json").read_text(encoding="utf-8")
            )
            self.assertEqual("fail", g2_payload.get("status"))

    def test_python_fallback_accepts_double_dash_separator(self) -> None:
        with tempfile.TemporaryDirectory(prefix="openalice-fallback-sep-") as tmp:
            tmp_dir = Path(tmp)
            manifest_path = tmp_dir / "freeze_manifest.valid.json"
            output_path = tmp_dir / "freeze_verify_report.json"
            manifest_path.write_text(
                json.dumps(self.make_freeze_manifest(), ensure_ascii=False, indent=2)
                + "\n",
                encoding="utf-8",
            )

            proc = run_script(
                [
                    "node",
                    "--import",
                    "tsx",
                    "scripts/python_fallback.ts",
                    "scripts/verify_freeze_manifest.py",
                    "--",
                    "--manifest",
                    str(manifest_path),
                    "--schema",
                    str(FREEZE_SCHEMA_PATH),
                    "--output",
                    str(output_path),
                ]
            )
            self.assertEqual(0, proc.returncode, msg=proc.stderr)
            report = json.loads(output_path.read_text(encoding="utf-8"))
            self.assertTrue(bool(report.get("passed")))


if __name__ == "__main__":
    unittest.main()
