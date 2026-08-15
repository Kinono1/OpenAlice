"""Real-process crash/restart recovery tests for the local paper sidecar."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory

import pytest

from sidecars.nautilus_paper.runtime_crash_test_server import (
    CUT_AFTER_CLAIM,
    CUT_AFTER_EFFECT,
    CUT_AFTER_RECEIPT,
    CUT_BEFORE_CLAIM,
    TEST_ONLY_ENV,
)


_GRPC_FORK_DIAGNOSTIC = re.compile(
    r"^I\d{4} \d{2}:\d{2}:\d{2}\.\d+ \d+ ev_poll_posix\.cc:\d+\] "
    r"FD from fork parent still in poll list: fd\(\d+, generation: \d+\)$"
)


@pytest.fixture
def owner_only_run_dir():
    """Use a short owner-only path: macOS UDS names have a small limit."""
    with TemporaryDirectory(dir="/private/tmp", prefix="np-crash-") as value:
        path = Path(value)
        path.chmod(0o700)
        yield path


def _command(mode: str, run: Path, *, cut: str | None = None) -> list[str]:
    command = [
        sys.executable,
        "-B",
        "-m",
        "sidecars.nautilus_paper.runtime_crash_test_server",
        "--mode",
        mode,
        "--socket-path",
        str(run / ("admission-restart.sock" if mode == "recover" else "admission-crash.sock")),
        "--ledger-path",
        str(run / "ledger.sqlite3"),
        "--simulator-path",
        str(run / "simulator.sqlite3"),
    ]
    if cut is not None:
        command.extend(("--cut", cut))
    return command


def _environment() -> dict[str, str]:
    repository_root = Path(__file__).resolve().parents[2]
    inherited_python_path = os.environ.get("PYTHONPATH", "").strip()
    python_path = os.pathsep.join(
        part for part in (str(repository_root), inherited_python_path) if part
    )
    # The crash child needs code/dependencies, not the parent's provider or
    # broker environment. Keep its process boundary credential-free.
    return {
        TEST_ONLY_ENV: "1",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONPATH": python_path,
        "PATH": "/usr/bin:/bin",
    }


def _assert_no_unexpected_child_stderr(value: str) -> None:
    """Reject child errors while allowing gRPC's pre-exec at-fork INFO line.

    When this test runs after another gRPC test, the parent interpreter may
    still own poll descriptors. gRPC's at-fork handler writes this one exact
    diagnostic before ``exec`` replaces the child. It is not output from the
    crash harness; every other stderr line remains a test failure.
    """
    unexpected = [
        line
        for line in value.splitlines()
        if line and _GRPC_FORK_DIAGNOSTIC.fullmatch(line) is None
    ]
    assert unexpected == [], value


def _crash(run: Path, cut: str, *, parent_sigkill: bool) -> dict[str, object]:
    process = subprocess.Popen(
        _command("crash", run, cut=cut),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=_environment(),
    )
    assert process.stdout is not None
    try:
        readable, _, _ = select.select((process.stdout,), (), (), 10)
        assert readable, "crash child did not publish its durable barrier"
        line = process.stdout.readline()
        assert line, (
            process.stderr.read() if process.stderr is not None else "no child output"
        )
        barrier = json.loads(line)
        assert barrier == {
            "barrier": cut,
            "callerResponseSent": False,
            "commandHash": barrier["commandHash"],
        }
        if parent_sigkill:
            process.send_signal(signal.SIGKILL)
            assert process.wait(timeout=5) == -signal.SIGKILL
        else:
            assert process.wait(timeout=5) in {70, 71, 72}
        assert process.stderr is not None
        _assert_no_unexpected_child_stderr(process.stderr.read())
        return barrier
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)


def _restart(run: Path) -> dict[str, object]:
    result = subprocess.run(
        _command("recover", run),
        capture_output=True,
        text=True,
        env=_environment(),
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    _assert_no_unexpected_child_stderr(result.stderr)
    return json.loads(result.stdout)


@pytest.mark.parametrize(
    ("cut", "parent_sigkill", "expected"),
    (
        (
            CUT_BEFORE_CLAIM,
            False,
            {
                "runtimeState": "DURABLE_UDS_READY",
                "dispatchState": "RECEIPT_COMMITTED",
                "receiptFound": True,
                "counts": {
                    "commands": 1,
                    "dispatches": 1,
                    "attempts": 1,
                    "effects": 1,
                    "receipts": 1,
                    "lifecycle": 2,
                },
            },
        ),
        (
            CUT_AFTER_CLAIM,
            False,
            {
                "runtimeState": "WRITE_DISARMED",
                "dispatchState": "RECONCILIATION_REQUIRED",
                "receiptFound": False,
                "counts": {
                    "commands": 1,
                    "dispatches": 1,
                    "attempts": 1,
                    "effects": 0,
                    "receipts": 0,
                    "lifecycle": 1,
                },
            },
        ),
        (
            CUT_AFTER_EFFECT,
            False,
            {
                "runtimeState": "DURABLE_UDS_READY",
                "dispatchState": "RECEIPT_COMMITTED",
                "receiptFound": True,
                "counts": {
                    "commands": 1,
                    "dispatches": 1,
                    "attempts": 1,
                    "effects": 1,
                    "receipts": 1,
                    "lifecycle": 2,
                },
            },
        ),
        (
            CUT_AFTER_RECEIPT,
            True,
            {
                "runtimeState": "DURABLE_UDS_READY",
                "dispatchState": "RECEIPT_COMMITTED",
                "receiptFound": True,
                "counts": {
                    "commands": 1,
                    "dispatches": 1,
                    "attempts": 1,
                    "effects": 1,
                    "receipts": 1,
                    "lifecycle": 2,
                },
            },
        ),
    ),
)
def test_real_process_crash_recovery_is_exact(
    owner_only_run_dir: Path,
    cut: str,
    parent_sigkill: bool,
    expected: dict[str, object],
) -> None:
    """Each durable cut restarts without blind replay or effect duplication."""
    barrier = _crash(owner_only_run_dir, cut, parent_sigkill=parent_sigkill)
    assert len(str(barrier["commandHash"])) == 64
    restarted = _restart(owner_only_run_dir)
    assert restarted["status"] == "recovered"
    for key, value in expected.items():
        assert restarted[key] == value
