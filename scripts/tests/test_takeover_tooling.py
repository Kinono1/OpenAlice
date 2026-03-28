from __future__ import annotations

import importlib.util
import io
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[2]
VALIDATOR_PATH = REPO_ROOT / "scripts" / "takeover" / "validate_openalice_takeover.py"
WATCHLIST_PATH = REPO_ROOT / "scripts" / "takeover" / "check_watchlist.py"


def load_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class TestTakeoverTooling(unittest.TestCase):
    def test_validator_passes_against_current_takeover_pack(self) -> None:
        run = subprocess.run(
            [sys.executable, str(VALIDATOR_PATH)],
            cwd=str(REPO_ROOT),
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(run.returncode, 0, msg=run.stderr)
        self.assertIn("[takeover-validate] OK", run.stdout)

    def test_watchlist_matches_changed_paths(self) -> None:
        module = load_module(WATCHLIST_PATH, "check_watchlist_test")

        def fake_run(cmd, cwd=None, text=None, capture_output=None, check=None):
            if cmd[:3] == ["git", "diff", "--name-only"]:
                return subprocess.CompletedProcess(cmd, 0, "src/main.ts\nREADME.md\n", "")
            raise AssertionError(f"unexpected command: {cmd}")

        with patch.object(module.subprocess, "run", side_effect=fake_run):
            files = module.changed_files("base", "head")
            self.assertEqual(files, ["src/main.ts", "README.md"])

            buf = io.StringIO()
            with patch.object(sys, "argv", ["check_watchlist.py", "--base", "base", "--head", "head"]):
                with redirect_stdout(buf):
                    module.main()
            output = buf.getvalue()
            self.assertIn("major_refresh_hint: src/main.ts", output)
            self.assertIn("minor_refresh_hint: README.md", output)


if __name__ == "__main__":
    unittest.main()
