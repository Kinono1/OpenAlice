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
