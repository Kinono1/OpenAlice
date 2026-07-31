from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("build_registry.py")
SPEC = importlib.util.spec_from_file_location("openalice_pipeline_registry", MODULE_PATH)
assert SPEC and SPEC.loader
registry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(registry)


class PipelineRegistryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.repo = Path(self.temp.name)
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
        (self.repo / "scripts").mkdir()
        (self.repo / "scripts" / "cron_example.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (self.repo / "scripts" / "audit_example.ts").write_text("export {}\n", encoding="utf-8")
        (self.repo / "package.json").write_text(
            json.dumps(
                {
                    "scripts": {
                        "example": "bash scripts/cron_example.sh",
                        "audit": "tsx scripts/audit_example.ts",
                    }
                }
            ),
            encoding="utf-8",
        )
        subprocess.run(["git", "-C", str(self.repo), "add", "."], check=True)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_registry_declares_required_fields(self) -> None:
        cron = {
            "schemaVersion": "cron_definition_registry.v1",
            "jobs": [
                {
                    "id": "stable001",
                    "entrypoint": "scripts/cron_example.sh",
                    "notificationArtifact": "data/runtime/example.json",
                }
            ],
        }
        result = registry.build_pipeline_registry(self.repo, cron)
        self.assertEqual(result["entryCount"], 2)
        cron_entry = next(
            item for item in result["entries"] if item["entrypoint"].endswith(".sh")
        )
        self.assertEqual(cron_entry["schedulerOwner"], "openalice_cron_engine")
        self.assertEqual(cron_entry["cronTaskIds"], ["stable001"])
        self.assertEqual(cron_entry["compatibilityAliases"], ["example"])
        for field in (
            "id",
            "owner",
            "domain",
            "lifecycle",
            "entrypoint",
            "compatibilityAliases",
            "inputs",
            "outputs",
            "safetyLevel",
            "lock",
            "timeoutSeconds",
            "networkPolicy",
            "evidenceTtlSeconds",
            "schedulerOwner",
        ):
            self.assertIn(field, cron_entry)

    def test_cron_import_strips_runtime_state_and_pauses_external_dependencies(self) -> None:
        source = self.repo / "data" / "cron"
        source.mkdir(parents=True)
        state_path = source / "jobs.json"
        state_path.write_text(
            json.dumps(
                {
                    "jobs": [
                        {
                            "id": "ssd001",
                            "name": "okx_ssd_integrity_audit_weekly",
                            "enabled": True,
                            "kind": "script",
                            "schedule": {"kind": "every", "every": "1h"},
                            "payload": "",
                            "script": {
                                "path": str(self.repo / "scripts" / "cron_example.sh"),
                                "cwd": str(self.repo),
                            },
                            "state": {
                                "lastStatus": "error",
                                "consecutiveErrors": 4,
                            },
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )
        result = registry.import_cron_definitions(state_path, self.repo)
        job = result["jobs"][0]
        self.assertNotIn("state", job)
        self.assertFalse(job["enabled"])
        self.assertEqual(job["initialState"], "paused_external_dependency")
        self.assertEqual(job["entrypoint"], "scripts/cron_example.sh")
        self.assertTrue(job["operatorReceiptRequiredToCloseCircuit"])


if __name__ == "__main__":
    unittest.main()
