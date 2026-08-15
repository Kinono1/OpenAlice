"""Explicitly opt-in PAPER_EXCHANGE UDS fixture for the Node contract test.

This file is test-only and is deliberately excluded from the D1 production
release allowlist.  It has no Broker, CCXT, Nautilus, network, credential
discovery, or fallback configuration path.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import signal
import sqlite3
from threading import Event

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .core import PaperSidecarCore
from .environment import StaticEnvironmentProvider, build_paper_environment_proof_v1
from .ledger import Ledger, Lease
from .runtime import RuntimeExecutor, RuntimeIdentity


_TEST_ONLY_ENV = "OPENALICE_UDS_CONTRACT_TEST_ONLY"
_NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
_RUN_ID = "paper-grpc-contract-test-run"
_SCHEMA_HASH = "a" * 64
_KEY_ID = "rfc8032-test-1"
_PRIVATE_KEY = Ed25519PrivateKey.from_private_bytes(
    bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
)
_PUBLIC_KEY_DER = _PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER,
    PublicFormat.SubjectPublicKeyInfo,
)


def _proof():
    return build_paper_environment_proof_v1(
        observed_at=_NOW - timedelta(seconds=1),
        expires_at=_NOW + timedelta(seconds=60),
        mode="PAPER_EXCHANGE",
        run_id=_RUN_ID,
        config_digest="b" * 64,
        schema_hash=_SCHEMA_HASH,
        endpoint_class="okx_demo",
        credential_class="demo_only",
        execution_client_registered=True,
        now=_NOW,
    )


def _core_factory(ledger: Ledger, _lease: Lease) -> PaperSidecarCore:
    return PaperSidecarCore(
        ledger,
        environment_provider=StaticEnvironmentProvider(_proof(), clock=lambda: _NOW),
        resolve_public_key=lambda key_id: _PUBLIC_KEY_DER if key_id == _KEY_ID else None,
        expected_schema_hash=_SCHEMA_HASH,
        run_id=_RUN_ID,
        expected_key_ids=(_KEY_ID,),
        clock=lambda: _NOW,
    )


def _absolute(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or "\x00" in value:
        raise ValueError(f"{label}_must_be_absolute")
    return path


def _private_parent(path: Path, label: str) -> None:
    status = path.parent.lstat()
    if (
        path.parent.is_symlink()
        or not path.parent.is_dir()
        or status.st_uid != os.getuid()
        or status.st_mode & 0o077
    ):
        raise ValueError(f"{label}_parent_must_be_owner_only")


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="test-only PAPER_EXCHANGE UDS server")
    parser.add_argument("--socket-path", required=True)
    parser.add_argument("--sqlite-path", required=True)
    parser.add_argument("--result-path", required=True)
    parser.add_argument("--fixture-path", required=True)
    return parser.parse_args()


def _count(path: Path, table: str) -> int:
    with sqlite3.connect(path) as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def main() -> int:
    if os.environ.get(_TEST_ONLY_ENV) != "1":
        raise SystemExit(f"{_TEST_ONLY_ENV}=1 is required for this test-only server")
    args = _arguments()
    socket_path = _absolute(args.socket_path, "socket_path")
    ledger_path = _absolute(args.sqlite_path, "sqlite_path")
    result_path = _absolute(args.result_path, "result_path")
    fixture_path = _absolute(args.fixture_path, "fixture_path")
    for path, label in (
        (socket_path, "socket_path"),
        (ledger_path, "sqlite_path"),
        (result_path, "result_path"),
    ):
        _private_parent(path, label)
    if socket_path.exists() or not fixture_path.is_file():
        raise SystemExit("invalid_test_fixture_paths")

    proof = _proof()
    runtime = RuntimeExecutor(
        ledger_path,
        socket_path,
        core_factory=_core_factory,
        expected_identity=RuntimeIdentity(
            mode="PAPER_EXCHANGE",
            run_id=_RUN_ID,
            environment_proof_hash=proof.proofHash,
            schema_hash=_SCHEMA_HASH,
        ),
        wall_clock=lambda: _NOW.timestamp(),
    )
    stop_requested = Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_requested.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    runtime.start()
    print(json.dumps({"status": "ready", "socketPath": str(socket_path)}), flush=True)
    try:
        while not stop_requested.wait(0.05):
            pass
    finally:
        runtime.stop()
        result_path.write_text(
            json.dumps(
                {
                    "status": "stopped",
                    "executionCommandCount": _count(ledger_path, "execution_commands"),
                    "latestCursor": _count(ledger_path, "lifecycle_events"),
                },
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )
        result_path.chmod(0o600)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
