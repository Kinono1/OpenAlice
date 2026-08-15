"""Explicitly opt-in local-only UDS fixture for the Node integration test.

This is deliberately not a sidecar entrypoint. It starts only when the
test-only environment marker is present and has no credential/config discovery,
broker, Nautilus, CCXT, or network dependency.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import signal
import sqlite3
from threading import Event

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .contract import (
    build_execution_command_v1,
    derive_okx_client_order_id,
    execution_permit_v2_signing_payload,
    sha256_canonical,
)
from .core import OfflineAdmissionBinding, PaperSidecarCore
from .environment import PAPER_LOCAL, StaticEnvironmentProvider, build_paper_environment_proof_v1
from .ledger import Ledger, Lease
from .offline_receipt import ed25519_public_key_fingerprint_sha256
from .offline_simulator import OfflineSimulatorStore
from .runtime import OfflineExecutionRuntimeConfig, RuntimeExecutor, RuntimeIdentity


_TEST_ONLY_ENV = "OPENALICE_UDS_CONTRACT_TEST_ONLY"
_NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
_SCHEMA_HASH = "a" * 64
_RUN_ID = "paper-local-uds-contract-test"
_PERMIT_KEY_ID = "rfc8032-test-1"
_CAPABILITY_KEY_ID = "offline-capability-test-key"
_RECEIPT_KEY_ID = "offline-receipt-test-key"
_SOURCE_KEY_ID = "offline-source-test-key"


def _fixed_private_key(seed_hex: str) -> Ed25519PrivateKey:
    """Create a fixture-only RFC 8032 key; never inspect environment."""
    return Ed25519PrivateKey.from_private_bytes(bytes.fromhex(seed_hex))


# Deterministic test-only roots, never loaded from a provider, parent env, or disk.
_PERMIT_PRIVATE_KEY = _fixed_private_key(
    "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
)
_CAPABILITY_PRIVATE_KEY = _fixed_private_key("aa" * 32)
_RECEIPT_PRIVATE_KEY = _fixed_private_key("bb" * 32)
_SOURCE_PRIVATE_KEY = _fixed_private_key("cc" * 32)
_PERMIT_PUBLIC_KEY_DER = _PERMIT_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)


def _absolute_path(value: str, label: str) -> Path:
    path = Path(value)
    if not path.is_absolute() or "\x00" in value:
        raise ValueError(f"{label}_must_be_absolute")
    return path


def _private_owner_path(path: Path, label: str) -> None:
    parent = path.parent
    stat_result = parent.stat()
    if stat_result.st_uid != os.getuid() or stat_result.st_mode & 0o077:
        raise ValueError(f"{label}_parent_must_be_owner_only")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="test-only PAPER_LOCAL UDS server")
    parser.add_argument("--socket-path", required=True)
    parser.add_argument("--sqlite-path", required=True)
    parser.add_argument("--simulator-path", required=True)
    parser.add_argument("--result-path", required=True)
    parser.add_argument("--seed-missing-effect", action="store_true")
    return parser.parse_args()


def _proof():
    return build_paper_environment_proof_v1(
        observed_at=_NOW - timedelta(seconds=1), expires_at=_NOW + timedelta(seconds=60),
        mode=PAPER_LOCAL, run_id=_RUN_ID, config_digest="b" * 64, schema_hash=_SCHEMA_HASH,
        endpoint_class="local_sandbox", credential_class="none", execution_client_registered=False,
        now=_NOW,
    )


def _policy() -> dict[str, object]:
    return {
        "schemaVersion": "openalice_offline_adapter_policy.v3",
        "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only", "mode": PAPER_LOCAL,
        "adapterId": "openalice.offline-simulator", "adapterBuildHash": "1" * 64,
        "adapterConfigHash": "2" * 64, "adapterRunId": _RUN_ID, "sourceNamespaceId": "3" * 64,
        "adapterKeyId": _RECEIPT_KEY_ID,
        "adapterPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(_RECEIPT_PRIVATE_KEY.public_key()),
        "permitAuthorityKeyId": _PERMIT_KEY_ID,
        "permitAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(_PERMIT_PUBLIC_KEY_DER),
        "simulatorCapabilityAuthorityKeyId": _CAPABILITY_KEY_ID,
        "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(_CAPABILITY_PRIVATE_KEY.public_key()),
        "simulatorStoreId": "4" * 64, "sourceAttestationKeyId": _SOURCE_KEY_ID,
        "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(_SOURCE_PRIVATE_KEY.public_key()),
        "capability": "offline_simulator.ensure_exact.v2", "ensureExact": True,
        "finalizationEligible": False,
    }


def _offline_config(simulator_path: Path) -> OfflineExecutionRuntimeConfig:
    return OfflineExecutionRuntimeConfig(
        policy=_policy(), simulator_database_path=simulator_path, permit_public_key=_PERMIT_PUBLIC_KEY_DER,
        capability_authority_key_id=_CAPABILITY_KEY_ID, capability_authority_private_key=_CAPABILITY_PRIVATE_KEY,
        receipt_signing_key_id=_RECEIPT_KEY_ID, receipt_signing_private_key=_RECEIPT_PRIVATE_KEY,
        source_attestation_key_id=_SOURCE_KEY_ID, source_attestation_private_key=_SOURCE_PRIVATE_KEY,
    )


def _provision_simulator(path: Path, config: OfflineExecutionRuntimeConfig) -> None:
    """Explicitly provision before RuntimeExecutor opens the immutable store."""
    store = OfflineSimulatorStore(
        path, store_id=str(config.policy["simulatorStoreId"]),
        capability_public_keys={config.capability_authority_key_id: config.capability_authority_private_key.public_key()},
        source_attestation_key_id=config.source_attestation_key_id,
        source_attestation_private_key=config.source_attestation_private_key,
        capability_clock=lambda: _NOW, allow_provision=True,
    )
    store.close()
    path.chmod(0o600)


def _make_core(config: OfflineExecutionRuntimeConfig):
    binding = OfflineAdmissionBinding(
        policy_hash=sha256_canonical(config.policy), permit_authority_key_id=_PERMIT_KEY_ID,
        permit_public_key=_PERMIT_PUBLIC_KEY_DER,
    )

    def create(ledger: Ledger, lease: Lease) -> PaperSidecarCore:
        return PaperSidecarCore(
            ledger, environment_provider=StaticEnvironmentProvider(_proof(), clock=lambda: _NOW),
            resolve_public_key=lambda key_id: _PERMIT_PUBLIC_KEY_DER if key_id == _PERMIT_KEY_ID else None,
            expected_schema_hash=_SCHEMA_HASH, run_id=_RUN_ID, expected_key_ids=(_PERMIT_KEY_ID,),
            offline_admission_binding=binding,
            resolve_offline_receipt_public_key=lambda key_id: _RECEIPT_PRIVATE_KEY.public_key() if key_id == _RECEIPT_KEY_ID else None,
            expected_offline_receipt_key_ids=(_RECEIPT_KEY_ID,), clock=lambda: _NOW,
        )

    return create


def _seed_missing_effect(ledger_path: Path, config: OfflineExecutionRuntimeConfig) -> str:
    """Leave one old-epoch dispatch IN_FLIGHT without a simulator effect."""
    ledger = Ledger(
        ledger_path, fencing_clock=lambda: _NOW.timestamp(),
        offline_capability_authority_private_key=config.capability_authority_private_key,
        offline_capability_authority_key_id=config.capability_authority_key_id,
        offline_receipt_signing_private_key=config.receipt_signing_private_key,
        offline_receipt_signing_key_id=config.receipt_signing_key_id,
        offline_source_attestation_public_keys={_SOURCE_KEY_ID: _SOURCE_PRIVATE_KEY.public_key()},
    )
    try:
        # Use RuntimeExecutor's exact lease namespace so startup becomes the
        # next fenced epoch and must reconcile this old-owner dispatch.
        lease = ledger.acquire_writer_lease(name="nautilus-paper-runtime", owner_id="seed-owner", ttl_seconds=30)
        ledger.register_offline_adapter_policy(policy=config.policy, writer_lease=lease)
        idempotency_key = "paper-local-missing-effect-seed"
        payload = {
            "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
            "idempotencyKey": idempotency_key, "mode": PAPER_LOCAL, "kind": "submit",
            "clientOrderId": derive_okx_client_order_id(idempotency_key), "side": "buy", "orderType": "limit",
            "quantity": "0.0005", "price": "100000.5", "timeInForce": "GTC", "reduceOnly": False,
            "maxNotionalUsd": "50.00025",
        }
        command = build_execution_command_v1(payload)
        permit = {
            "schemaVersion": "openalice_execution_permit.v2", "decisionId": "5" * 64,
            "candidateId": "paper-local-seed", "intentId": idempotency_key, "ticketId": "seed-ticket",
            "commandHash": command["commandId"], "action": "submit", "authorityAction": "open",
            "riskReducing": False, "scope": "paper_only", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venueInstrumentId": "BTC-USDT", "idempotencyKey": idempotency_key,
            "side": "buy", "authorizedNotionalUsd": "50.00025", "mode": PAPER_LOCAL,
            "sourceCommit": "6" * 40, "releaseManifestHash": "7" * 64, "authoritySnapshotHash": "8" * 64,
            "requiredChecks": ["offline_contract_test"], "approvalRefs": [],
            "issuedAt": "2026-08-15T00:00:00.000Z", "expiresAt": "2026-08-15T00:00:30.000Z",
            "keyId": _PERMIT_KEY_ID,
        }
        permit["permitId"] = sha256_canonical(permit)
        permit["signature"] = base64.b64encode(
            _PERMIT_PRIVATE_KEY.sign(execution_permit_v2_signing_payload(permit).encode("utf-8"))
        ).decode("ascii")
        core = _make_core(config)(ledger, lease)
        core.bind_writer_lease(lease)
        admitted = core.admit(
            command=command, permit=permit,
            command_payload_bytes=json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"),
            permit_bytes=json.dumps(permit, sort_keys=True, separators=(",", ":")).encode("utf-8"),
        )
        ledger.claim_offline_dispatch(
            command_hash=admitted.receipt.command.command_hash, writer_lease=lease,
            permit_public_key=_PERMIT_PUBLIC_KEY_DER,
        )
        ledger.release_writer_lease(lease)
    finally:
        ledger.close()
    ledger_path.chmod(0o600)
    return command["commandId"]


def _table_count(database_path: Path, table: str) -> int:
    with sqlite3.connect(database_path) as connection:
        return int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])


def _write_result(path: Path, ledger_path: Path, simulator_path: Path) -> None:
    path.write_text(json.dumps({
        "status": "stopped", "executionCommandCount": _table_count(ledger_path, "execution_commands"),
        "offlineReceiptCount": _table_count(ledger_path, "offline_execution_receipts"),
        "simulatorEffectCount": _table_count(simulator_path, "simulator_effect_attestations"),
    }, separators=(",", ":")), encoding="utf-8")
    path.chmod(0o600)


def main() -> int:
    if os.environ.get(_TEST_ONLY_ENV) != "1":
        raise SystemExit(f"{_TEST_ONLY_ENV}=1 is required for this test-only server")
    args = _parse_args()
    socket_path = _absolute_path(args.socket_path, "socket_path")
    ledger_path = _absolute_path(args.sqlite_path, "sqlite_path")
    simulator_path = _absolute_path(args.simulator_path, "simulator_path")
    result_path = _absolute_path(args.result_path, "result_path")
    for path, label in ((socket_path, "socket_path"), (ledger_path, "sqlite_path"), (simulator_path, "simulator_path"), (result_path, "result_path")):
        _private_owner_path(path, label)
    if socket_path.exists():
        raise SystemExit("test_socket_path_must_not_preexist")

    config = _offline_config(simulator_path)
    if not simulator_path.exists():
        _provision_simulator(simulator_path, config)
    seed_command_id = _seed_missing_effect(ledger_path, config) if args.seed_missing_effect else None
    runtime = RuntimeExecutor(
        ledger_path, socket_path, core_factory=_make_core(config),
        expected_identity=RuntimeIdentity(mode=PAPER_LOCAL, run_id=_RUN_ID,
            environment_proof_hash=_proof().proofHash, schema_hash=_SCHEMA_HASH),
        wall_clock=lambda: _NOW.timestamp(), offline_execution=config,
    )
    stop_requested = Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_requested.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    runtime.start()
    ready = {"status": "ready", "socketPath": str(socket_path)}
    if seed_command_id is not None:
        ready["seedCommandId"] = seed_command_id
    print(json.dumps(ready, separators=(",", ":")), flush=True)
    try:
        while not stop_requested.wait(0.05):
            pass
    finally:
        runtime.stop()
        _write_result(result_path, ledger_path, simulator_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
