"""Test-only crash harness for the local durable offline-execution runtime.

This module is deliberately *not* a sidecar entrypoint.  Pytest launches it
only with ``OPENALICE_RUNTIME_CRASH_TEST_ONLY=1`` and with caller-provided,
owner-only UDS and SQLite paths.  It has fixed RFC 8032 fixture keys and no
configuration discovery, broker, Nautilus, CCXT, credential, or network code.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sqlite3
import time
from threading import Event, Thread
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .contract import (
    build_execution_command_v1,
    derive_okx_client_order_id,
    execution_permit_v2_signing_payload,
    sha256_canonical,
    stable_stringify,
)
from .core import OfflineAdmissionBinding, PaperSidecarCore
from .environment import PAPER_LOCAL, StaticEnvironmentProvider, build_paper_environment_proof_v1
from .ledger import Ledger, Lease
from .offline_receipt import ed25519_public_key_fingerprint_sha256
from .offline_simulator import OfflineSimulatorStore
from .runtime import OfflineExecutionRuntimeConfig, RuntimeExecutor, RuntimeIdentity


TEST_ONLY_ENV = "OPENALICE_RUNTIME_CRASH_TEST_ONLY"
CUT_BEFORE_CLAIM = "before_claim"
CUT_AFTER_CLAIM = "after_claim_before_effect"
CUT_AFTER_EFFECT = "after_effect_before_receipt"
CUT_AFTER_RECEIPT = "after_receipt_before_response"
CUT_POINTS = (
    CUT_BEFORE_CLAIM,
    CUT_AFTER_CLAIM,
    CUT_AFTER_EFFECT,
    CUT_AFTER_RECEIPT,
)

_NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
# The restart must be later than the crashed writer's 30-second lease while
# remaining inside the permit's protocol-wide 60-second maximum TTL.
_RECOVERY_NOW = _NOW + timedelta(seconds=45)
_SCHEMA_HASH = "a" * 64
_RUN_ID = "paper-local-runtime-crash-test"
_PERMIT_KEY_ID = "runtime-crash-permit-key"
_CAPABILITY_KEY_ID = "runtime-crash-capability-key"
_RECEIPT_KEY_ID = "runtime-crash-receipt-key"
_SOURCE_KEY_ID = "runtime-crash-source-key"
_STORE_ID = "4" * 64


def _key(seed_hex: str) -> Ed25519PrivateKey:
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))


_PERMIT_PRIVATE_KEY = _key("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
_CAPABILITY_PRIVATE_KEY = _key("aa" * 32)
_RECEIPT_PRIVATE_KEY = _key("bb" * 32)
_SOURCE_PRIVATE_KEY = _key("cc" * 32)
_PERMIT_PUBLIC_KEY_DER = _PERMIT_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)


def _absolute(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or "\x00" in value:
        raise ValueError(f"{label}_must_be_absolute")
    return path


def _owner_only_parent(path: Path, label: str) -> None:
    parent = path.parent
    details = parent.stat()
    if details.st_uid != os.getuid() or details.st_mode & 0o077:
        raise ValueError(f"{label}_parent_must_be_owner_only")


def _policy() -> dict[str, object]:
    return {
        "schemaVersion": "openalice_offline_adapter_policy.v3",
        "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only",
        "mode": PAPER_LOCAL,
        "adapterId": "openalice.offline-simulator",
        "adapterBuildHash": "1" * 64,
        "adapterConfigHash": "2" * 64,
        "adapterRunId": _RUN_ID,
        "sourceNamespaceId": "3" * 64,
        "adapterKeyId": _RECEIPT_KEY_ID,
        "adapterPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(
            _RECEIPT_PRIVATE_KEY.public_key()
        ),
        "permitAuthorityKeyId": _PERMIT_KEY_ID,
        "permitAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(
            _PERMIT_PUBLIC_KEY_DER
        ),
        "simulatorCapabilityAuthorityKeyId": _CAPABILITY_KEY_ID,
        "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(
            _CAPABILITY_PRIVATE_KEY.public_key()
        ),
        "simulatorStoreId": _STORE_ID,
        "sourceAttestationKeyId": _SOURCE_KEY_ID,
        "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(
            _SOURCE_PRIVATE_KEY.public_key()
        ),
        "capability": "offline_simulator.ensure_exact.v2",
        "ensureExact": True,
        "finalizationEligible": False,
    }


def _config(simulator_path: Path) -> OfflineExecutionRuntimeConfig:
    return OfflineExecutionRuntimeConfig(
        policy=_policy(),
        simulator_database_path=simulator_path,
        permit_public_key=_PERMIT_PUBLIC_KEY_DER,
        capability_authority_key_id=_CAPABILITY_KEY_ID,
        capability_authority_private_key=_CAPABILITY_PRIVATE_KEY,
        receipt_signing_key_id=_RECEIPT_KEY_ID,
        receipt_signing_private_key=_RECEIPT_PRIVATE_KEY,
        source_attestation_key_id=_SOURCE_KEY_ID,
        source_attestation_private_key=_SOURCE_PRIVATE_KEY,
    )


def _proof():
    return build_paper_environment_proof_v1(
        observed_at=_NOW - timedelta(seconds=1),
        expires_at=_NOW + timedelta(seconds=60),
        mode=PAPER_LOCAL,
        run_id=_RUN_ID,
        config_digest="b" * 64,
        schema_hash=_SCHEMA_HASH,
        endpoint_class="local_sandbox",
        credential_class="none",
        execution_client_registered=False,
        now=_NOW,
    )


def _core_factory(config: OfflineExecutionRuntimeConfig):
    binding = OfflineAdmissionBinding(
        policy_hash=sha256_canonical(config.policy),
        permit_authority_key_id=_PERMIT_KEY_ID,
        permit_public_key=_PERMIT_PUBLIC_KEY_DER,
    )

    def create(ledger: Ledger, lease: Lease) -> PaperSidecarCore:
        return PaperSidecarCore(
            ledger,
            environment_provider=StaticEnvironmentProvider(_proof(), clock=lambda: _NOW),
            resolve_public_key=lambda key_id: (
                _PERMIT_PUBLIC_KEY_DER if key_id == _PERMIT_KEY_ID else None
            ),
            expected_schema_hash=_SCHEMA_HASH,
            run_id=_RUN_ID,
            expected_key_ids=(_PERMIT_KEY_ID,),
            offline_admission_binding=binding,
            resolve_offline_receipt_public_key=lambda key_id: (
                _RECEIPT_PRIVATE_KEY.public_key() if key_id == _RECEIPT_KEY_ID else None
            ),
            expected_offline_receipt_key_ids=(_RECEIPT_KEY_ID,),
            clock=lambda: _NOW,
        )

    return create


def _item() -> tuple[dict[str, Any], dict[str, Any]]:
    idempotency_key = "runtime-crash-single-command"
    payload = {
        "schemaVersion": "openalice_execution_command_payload.v1",
        "accountId": "paper-main",
        "canonicalSymbol": "BTC/USDT",
        "venue": "OKX",
        "venueInstrumentId": "BTC-USDT",
        "idempotencyKey": idempotency_key,
        "mode": PAPER_LOCAL,
        "kind": "submit",
        "clientOrderId": derive_okx_client_order_id(idempotency_key),
        "side": "buy",
        "orderType": "limit",
        "quantity": "0.0005",
        "price": "100000.5",
        "timeInForce": "GTC",
        "reduceOnly": False,
        "maxNotionalUsd": "50.00025",
    }
    command = build_execution_command_v1(payload)
    permit: dict[str, Any] = {
        "schemaVersion": "openalice_execution_permit.v2",
        "decisionId": "5" * 64,
        "candidateId": "runtime-crash-test",
        "intentId": idempotency_key,
        "ticketId": "runtime-crash-ticket",
        "commandHash": command["commandId"],
        "action": "submit",
        "authorityAction": "open",
        "riskReducing": False,
        "scope": "paper_only",
        "accountId": "paper-main",
        "canonicalSymbol": "BTC/USDT",
        "venueInstrumentId": "BTC-USDT",
        "idempotencyKey": idempotency_key,
        "side": "buy",
        "authorizedNotionalUsd": "50.00025",
        "mode": PAPER_LOCAL,
        "sourceCommit": "6" * 40,
        "releaseManifestHash": "7" * 64,
        "authoritySnapshotHash": "8" * 64,
        "requiredChecks": ["runtime_crash_test_only"],
        "approvalRefs": [],
        "issuedAt": "2026-08-15T00:00:00.000Z",
        # Recovery advances beyond the crashed writer lease but remains inside
        # this fixed test permit's protocol-wide 60-second maximum TTL.
        "expiresAt": "2026-08-15T00:01:00.000Z",
        "keyId": _PERMIT_KEY_ID,
    }
    permit["permitId"] = sha256_canonical(permit)
    permit["signature"] = base64.b64encode(
        _PERMIT_PRIVATE_KEY.sign(
            execution_permit_v2_signing_payload(permit).encode("utf-8")
        )
    ).decode("ascii")
    return command, permit


def _provision(path: Path, config: OfflineExecutionRuntimeConfig) -> None:
    store = OfflineSimulatorStore(
        path,
        store_id=_STORE_ID,
        capability_public_keys={
            config.capability_authority_key_id: config.capability_authority_private_key.public_key()
        },
        source_attestation_key_id=config.source_attestation_key_id,
        source_attestation_private_key=config.source_attestation_private_key,
        capability_clock=lambda: _NOW,
        allow_provision=True,
    )
    store.close()
    path.chmod(0o600)


def _emit(value: dict[str, object]) -> None:
    print(json.dumps(value, sort_keys=True, separators=(",", ":")), flush=True)


def _secure_sqlite_family(path: Path) -> None:
    """Keep the crash fixture's durable SQLite files owner-only before exit."""
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        if candidate.exists():
            candidate.chmod(0o600)


def _crash_at(
    cut: str, ledger_path: Path, simulator_path: Path, socket_path: Path
) -> None:
    """Run the real owner/backlog path, then die after one returned write.

    The wrappers below exist only in this separately invoked test module.  No
    production object has a crash hook: each wrapper calls the original
    durable method first, emits the barrier only after it returns, then exits.
    ``RuntimeExecutor._admission_result`` is held after its Future resolves so
    the RuntimeExecutor caller cannot receive an admission response before a
    later backlog cut point is reached.  This harness calls RuntimeExecutor
    directly and makes no claim about an RPC wire response.
    """
    config = _config(simulator_path)
    _provision(simulator_path, config)
    runtime = RuntimeExecutor(
        ledger_path,
        socket_path,
        core_factory=_core_factory(config),
        expected_identity=RuntimeIdentity(
            mode=PAPER_LOCAL,
            run_id=_RUN_ID,
            environment_proof_hash=_proof().proofHash,
            schema_hash=_SCHEMA_HASH,
        ),
        wall_clock=lambda: _NOW.timestamp(),
        offline_execution=config,
    )
    caller_returned = Event()
    response_gate = Event()
    command_hash: str | None = None

    original_admission_result = RuntimeExecutor._admission_result

    def hold_caller_response(self, request, *, timeout):
        value = original_admission_result(self, request, timeout=timeout)
        response_gate.wait()
        caller_returned.set()
        return value

    RuntimeExecutor._admission_result = hold_caller_response  # type: ignore[method-assign]

    def barrier(command_hash: str, *, exit_code: int | None) -> None:
        _secure_sqlite_family(ledger_path)
        _secure_sqlite_family(simulator_path)
        _emit(
            {
                "barrier": cut,
                "callerResponseSent": caller_returned.is_set(),
                "commandHash": command_hash,
            }
        )
        if exit_code is not None:
            os._exit(exit_code)
        while True:
            time.sleep(1)

    if cut == CUT_BEFORE_CLAIM:
        original_admit = PaperSidecarCore.admit

        def after_admission(self, *args, **kwargs):
            value = original_admit(self, *args, **kwargs)
            barrier(value.receipt.command.command_hash, exit_code=70)
            raise AssertionError("unreachable")

        PaperSidecarCore.admit = after_admission  # type: ignore[method-assign]
    elif cut == CUT_AFTER_CLAIM:
        original_claim = Ledger.claim_offline_dispatch

        def after_claim(self, *args, **kwargs):
            original_claim(self, *args, **kwargs)
            barrier(kwargs["command_hash"], exit_code=71)
            raise AssertionError("unreachable")

        Ledger.claim_offline_dispatch = after_claim  # type: ignore[method-assign]
    elif cut == CUT_AFTER_EFFECT:
        original_ensure = OfflineSimulatorStore.ensure_exact

        def after_effect(self, request, *, canonical_capability_json_utf8):
            original_ensure(
                self,
                request,
                canonical_capability_json_utf8=canonical_capability_json_utf8,
            )
            assert command_hash is not None
            barrier(command_hash, exit_code=72)
            raise AssertionError("unreachable")

        OfflineSimulatorStore.ensure_exact = after_effect  # type: ignore[method-assign]
    elif cut == CUT_AFTER_RECEIPT:
        original_commit = Ledger.commit_offline_execution_receipt

        def after_receipt(self, *args, **kwargs):
            original_commit(self, *args, **kwargs)
            barrier(kwargs["command_hash"], exit_code=None)
            raise AssertionError("unreachable")

        Ledger.commit_offline_execution_receipt = after_receipt  # type: ignore[method-assign]
    else:
        raise ValueError("unsupported_cut_point")

    runtime.start()
    command, permit = _item()
    command_hash = str(command["commandId"])

    def invoke() -> None:
        runtime.admit(
            command=command,
            permit=permit,
            command_payload_bytes=stable_stringify(command["payload"]).encode("utf-8"),
            permit_bytes=stable_stringify(permit).encode("utf-8"),
        )

    thread = Thread(target=invoke, name="runtime-crash-test-caller", daemon=True)
    thread.start()
    # The real runtime owner executes the patched returned durable operation.
    thread.join(timeout=30)
    raise RuntimeError("crash_barrier_was_not_reached")


def _count(path: Path, table: str) -> int:
    with sqlite3.connect(path) as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _counts(ledger_path: Path, simulator_path: Path) -> dict[str, int]:
    return {
        "commands": _count(ledger_path, "execution_commands"),
        "dispatches": _count(ledger_path, "execution_dispatches"),
        "attempts": _count(ledger_path, "execution_attempts"),
        "receipts": _count(ledger_path, "offline_execution_receipts"),
        "lifecycle": _count(ledger_path, "lifecycle_events"),
        "effects": _count(simulator_path, "simulator_effect_attestations"),
    }


def _recover(ledger_path: Path, simulator_path: Path, socket_path: Path) -> None:
    config = _config(simulator_path)
    runtime = RuntimeExecutor(
        ledger_path,
        socket_path,
        core_factory=_core_factory(config),
        expected_identity=RuntimeIdentity(
            mode=PAPER_LOCAL,
            run_id=_RUN_ID,
            environment_proof_hash=_proof().proofHash,
            schema_hash=_SCHEMA_HASH,
        ),
        wall_clock=lambda: _RECOVERY_NOW.timestamp(),
        offline_execution=config,
    )
    runtime.start()
    try:
        command, _ = _item()
        dispatch_state = None
        receipt_found = False
        with sqlite3.connect(ledger_path) as connection:
            row = connection.execute(
                "SELECT state, receipt_head_id FROM execution_dispatches WHERE command_hash = ?",
                (command["commandId"],),
            ).fetchone()
            if row is not None:
                dispatch_state = str(row[0])
                receipt_found = row[1] is not None
        _emit(
            {
                "status": "recovered",
                "runtimeState": runtime.supervisor.state.value,
                "dispatchState": dispatch_state,
                "receiptFound": receipt_found,
                "counts": _counts(ledger_path, simulator_path),
            }
        )
    finally:
        runtime.stop()


def _args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="test-only runtime crash harness")
    parser.add_argument("--mode", required=True, choices=("crash", "recover"))
    parser.add_argument("--cut", choices=CUT_POINTS)
    parser.add_argument("--socket-path", required=True)
    parser.add_argument("--ledger-path", required=True)
    parser.add_argument("--simulator-path", required=True)
    return parser.parse_args()


def main() -> int:
    if os.environ.get(TEST_ONLY_ENV) != "1":
        raise SystemExit(f"{TEST_ONLY_ENV}=1 is required")
    args = _args()
    socket_path = _absolute(args.socket_path, "socket_path")
    ledger_path = _absolute(args.ledger_path, "ledger_path")
    simulator_path = _absolute(args.simulator_path, "simulator_path")
    for path, label in (
        (socket_path, "socket_path"),
        (ledger_path, "ledger_path"),
        (simulator_path, "simulator_path"),
    ):
        _owner_only_parent(path, label)
    if args.mode == "crash":
        if args.cut is None or socket_path.exists() or ledger_path.exists() or simulator_path.exists():
            raise SystemExit("fresh_paths_and_cut_are_required_for_crash")
        _crash_at(args.cut, ledger_path, simulator_path, socket_path)
        raise AssertionError("os._exit_or_sigkill_was_required")
    if args.cut is not None or not ledger_path.exists() or not simulator_path.exists():
        raise SystemExit("existing_databases_and_no_cut_are_required_for_recover")
    _recover(ledger_path, simulator_path, socket_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
