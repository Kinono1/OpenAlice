from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from build_manifest import (
    GitEntry,
    classify_action,
    classify_protocol,
    is_secret_risk_path,
    normalize_repo_path,
    parse_status,
    scan_secret_rules,
)


class BuildManifestTest(unittest.TestCase):
    def test_parse_nul_status_preserves_unicode_and_spaces(self) -> None:
        entries = parse_status(" M docs/架构 说明.md\0?? src/new.ts\0".encode())
        self.assertEqual([entry.path for entry in entries], ["docs/架构 说明.md", "src/new.ts"])
        self.assertEqual(entries[0].porcelain, " M")
        self.assertEqual(entries[1].porcelain, "??")

    def test_unsafe_path_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            normalize_repo_path("../outside")

    def test_secret_paths_fail_closed(self) -> None:
        self.assertTrue(is_secret_risk_path(".env.production"))
        self.assertTrue(is_secret_risk_path("src/private-key.ts"))
        entry = GitEntry(
            path="src/private-key.ts",
            original_path=None,
            porcelain="??",
            index_status="?",
            worktree_status="?",
        )
        action, _ = classify_action(entry, classify_protocol(entry.path, True))
        self.assertEqual(action, "secret-isolate")

    def test_secret_scanner_returns_rule_id_not_value(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "candidate.ts"
            path.write_text(
                'const providerKey = "sk_' + "A1b2C3d4E5f6G7h8I9j0K1l2" + '"\n',
                encoding="utf-8",
            )
            rules = scan_secret_rules(path)
        self.assertEqual(rules, ["provider_key_literal"])
        self.assertNotIn("A1b2", repr(rules))

    def test_deleted_source_is_retained(self) -> None:
        entry = GitEntry(
            path="src/runtime/atomic-write.ts",
            original_path=None,
            porcelain=" D",
            index_status=" ",
            worktree_status="D",
        )
        action, _ = classify_action(entry, "A")
        self.assertEqual(action, "retain-original")


if __name__ == "__main__":
    unittest.main()
