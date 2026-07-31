from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("control.py")
SPEC = importlib.util.spec_from_file_location("openalice_control", MODULE_PATH)
assert SPEC and SPEC.loader
control = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(control)


class ControlPlaneTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        subprocess.run(
            ["git", "-C", str(self.repo), "config", "user.email", "test@example.invalid"],
            check=True,
        )
        subprocess.run(
            ["git", "-C", str(self.repo), "config", "user.name", "Test"],
            check=True,
        )
        (self.repo / "artifact.json").write_text('{"ok":true}\n', encoding="utf-8")
        subprocess.run(["git", "-C", str(self.repo), "add", "artifact.json"], check=True)
        subprocess.run(["git", "-C", str(self.repo), "commit", "-qm", "baseline"], check=True)
        self.now = datetime(2026, 7, 31, 8, 0, tzinfo=timezone.utc)
        self.binding = control.source_binding(self.repo)
        self.check = {
            "id": "example",
            "required": True,
            "ttlSeconds": 3600,
            "command": ["python3", "-c", "print('ok')"],
            "artifactPaths": ["artifact.json"],
        }

    def tearDown(self) -> None:
        self.temp.cleanup()

    def receipt(self) -> dict:
        return {
            "schemaVersion": "validation_receipt.v1",
            "receiptId": "example:1",
            "checkId": "example",
            "startedAt": control.isoformat(self.now - timedelta(seconds=1)),
            "endedAt": control.isoformat(self.now),
            "executedAt": control.isoformat(self.now),
            "expiresAt": control.isoformat(self.now + timedelta(hours=1)),
            "exitCode": 0,
            "sourceCommit": self.binding["sourceCommit"],
            "dirtyStateHash": self.binding["dirtyStateHash"],
            "sourceClean": self.binding["sourceClean"],
            "commandDigest": "a" * 64,
            "inputSummary": [],
            "outputSummary": {
                "stdoutBytes": 0,
                "stderrBytes": 0,
                "stdoutSha256": control.sha256_bytes(b""),
                "stderrSha256": control.sha256_bytes(b""),
                "stdoutTail": [],
                "stderrTail": [],
                "timedOut": False,
            },
            "artifacts": [
                {
                    "path": "artifact.json",
                    "exists": True,
                    "sha256": control.sha256_file(self.repo / "artifact.json"),
                }
            ],
            "status": "pass",
        }

    def test_valid_receipt_is_accepted(self) -> None:
        self.assertEqual(
            control.validate_receipt(
                self.receipt(), self.check, self.binding, self.repo, now=self.now
            ),
            (True, "valid"),
        )

    def test_stale_missing_and_wrong_commit_are_blocked(self) -> None:
        stale = self.receipt()
        stale["expiresAt"] = control.isoformat(self.now)
        self.assertEqual(
            control.validate_receipt(stale, self.check, self.binding, self.repo, now=self.now)[1],
            "receipt_expired",
        )
        wrong_commit = self.receipt()
        wrong_commit["sourceCommit"] = "0" * 40
        self.assertEqual(
            control.validate_receipt(
                wrong_commit, self.check, self.binding, self.repo, now=self.now
            )[1],
            "receipt_source_commit_mismatch",
        )
        missing = self.receipt()
        del missing["commandDigest"]
        self.assertTrue(
            control.validate_receipt(
                missing, self.check, self.binding, self.repo, now=self.now
            )[1].startswith("receipt_schema_missing")
        )

    def test_artifact_mutation_is_blocked(self) -> None:
        receipt = self.receipt()
        (self.repo / "artifact.json").write_text('{"ok":false}\n', encoding="utf-8")
        self.assertEqual(
            control.validate_receipt(
                receipt, self.check, self.binding, self.repo, now=self.now
            )[1],
            "artifact_hash_mismatch:artifact.json",
        )

    def test_refresh_never_prefills_pass_without_receipts(self) -> None:
        registry = {
            "schemaVersion": "validation_check_registry.v1",
            "checks": [self.check],
        }
        state = control.build_controller_state(
            self.repo, self.repo / "runtime", registry, now=self.now
        )
        self.assertEqual(state["engineeringStatus"], "blocked")
        self.assertEqual(state["statusSource"], "missing")
        self.assertFalse(state["admission"]["paperTradingAllowed"])
        self.assertFalse(state["admission"]["liveTradingAllowed"])
        self.assertFalse(state["admission"]["liveExecutionArmed"])
        self.assertEqual(state["checks"][0]["status"], "missing")

    def test_run_receipt_redacts_secret_and_omits_command(self) -> None:
        runtime = self.repo / "runtime"
        check = {
            **self.check,
            "command": [
                "python3",
                "-c",
                "import os; print(os.environ['TEST_API_KEY'])",
            ],
            "artifactPaths": [],
        }
        receipt = control.run_check(
            self.repo,
            runtime,
            check,
            env={"PATH": "/usr/bin:/bin", "TEST_API_KEY": "sk_test_secret_value"},
        )
        serialized = json.dumps(receipt)
        self.assertNotIn("sk_test_secret_value", serialized)
        self.assertNotIn("command", receipt)
        self.assertEqual(receipt["outputSummary"]["stdoutTail"], ["[REDACTED]"])

    def test_receipts_created_from_dirty_source_cannot_admit_engineering(self) -> None:
        (self.repo / "dirty.txt").write_text("uncommitted\n", encoding="utf-8")
        with tempfile.TemporaryDirectory() as runtime_dir:
            runtime = Path(runtime_dir)
            receipt = control.run_check(
                self.repo,
                runtime,
                {**self.check, "artifactPaths": []},
            )
            self.assertFalse(receipt["sourceClean"])
            registry = {
                "schemaVersion": "validation_check_registry.v1",
                "checks": [{**self.check, "artifactPaths": []}],
            }
            state = control.build_controller_state(
                self.repo, runtime, registry, now=datetime.now(timezone.utc)
            )
            self.assertEqual(state["engineeringStatus"], "blocked")
            self.assertEqual(state["checks"][0]["reason"], "receipt_source_dirty")
            self.assertIn(
                "dirty_worktree",
                [item["blockerId"] for item in state["blockers"]["open"]],
            )


if __name__ == "__main__":
    unittest.main()
