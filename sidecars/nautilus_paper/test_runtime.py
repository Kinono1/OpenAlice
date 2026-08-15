"""Focused lifecycle tests for the single-owner durable-admission runtime."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
import base64
import json
import os
from pathlib import Path
import socket
import sqlite3
from threading import Event, get_ident
import time
from tempfile import TemporaryDirectory

import grpc
import pytest

import sidecars.nautilus_paper.runtime as runtime_module

from sidecars.nautilus_paper.core import CoreAdmissionDenied, PaperSidecarCore
from sidecars.nautilus_paper.contract import (
    build_execution_command_v1,
    derive_okx_client_order_id,
    execution_permit_v2_signing_payload,
    sha256_canonical,
    verify_execution_permit_v2,
)
from sidecars.nautilus_paper.core import OfflineAdmissionBinding
from sidecars.nautilus_paper.environment import build_paper_environment_proof_v1
from sidecars.nautilus_paper.environment import StaticEnvironmentProvider
from sidecars.nautilus_paper.grpc_receiver import build_uds_server
from sidecars.nautilus_paper.generated import (
    openalice_execution_v1_pb2 as execution_pb2,
)
from sidecars.nautilus_paper.generated import (
    openalice_execution_v1_pb2_grpc as execution_pb2_grpc,
)
from sidecars.nautilus_paper.ledger import Ledger
from sidecars.nautilus_paper.runtime import (
    LeaseController,
    OfflineExecutionRuntimeConfig,
    RuntimeErrorCode,
    RuntimeExecutor,
    RuntimeIdentity,
    RuntimeState,
)
from sidecars.nautilus_paper.offline_simulator import OfflineSimulatorStore
from sidecars.nautilus_paper.test_grpc_receiver import (
    NOW,
    PUBLIC_KEY_DER,
    canonical_bytes,
    configured_core,
    golden_fixture,
    request_from_fixture,
)
from sidecars.nautilus_paper.test_core import (
    OFFLINE_CAPABILITY_PRIVATE_KEY,
    OFFLINE_RECEIPT_PRIVATE_KEY,
    OFFLINE_SOURCE_PRIVATE_KEY,
    PRIVATE_KEY as LOCAL_PERMIT_PRIVATE_KEY,
    RUN_ID as LOCAL_RUN_ID,
    SCHEMA_HASH as LOCAL_SCHEMA_HASH,
    local_proof,
    paper_local_item,
    v3_policy,
)


_CLOCK_ORIGIN = time.monotonic()
EXPECTED_IDENTITY = RuntimeIdentity(
    mode="PAPER_EXCHANGE",
    run_id="paper-grpc-test-run",
    environment_proof_hash="4b66fc221c1298d36b67d922b67197a0c2c52cb0e9c972833b480cb3690f0f7a",
    schema_hash="a" * 64,
)


def _wall_clock() -> float:
    return NOW.timestamp() + (time.monotonic() - _CLOCK_ORIGIN)


def _runtime_proof(*, config_digest: str = "b" * 64):
    return build_paper_environment_proof_v1(
        observed_at=NOW - timedelta(seconds=1),
        expires_at=NOW + timedelta(seconds=60),
        mode=EXPECTED_IDENTITY.mode,
        run_id=EXPECTED_IDENTITY.run_id,
        config_digest=config_digest,
        schema_hash=EXPECTED_IDENTITY.schema_hash,
        endpoint_class="okx_demo",
        credential_class="demo_only",
        execution_client_registered=True,
        now=NOW,
    )


class _SequencedProofProvider:
    def __init__(self) -> None:
        self.current = _runtime_proof()
        self.sequence: list[object] = []

    def get_proof(self, **_kwargs):
        if self.sequence:
            self.current = self.sequence.pop(0)  # type: ignore[assignment]
        return self.current


@pytest.fixture
def short_path():
    """macOS UDS path limit requires a short, private test-only run path."""
    with TemporaryDirectory(dir="/private/tmp", prefix="np-") as temporary:
        path = Path(temporary)
        path.chmod(0o700)
        yield path


def _private_dir(path: Path) -> Path:
    path.mkdir()
    path.chmod(0o700)
    return path


def _factory(*, seen: list[int] | None = None):
    def create(ledger: Ledger, lease):
        if seen is not None:
            seen.append(get_ident())
        return configured_core(ledger, lease=lease)

    return create


def _seeded_factory():
    def create(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)
        fixture = golden_fixture()
        decision = core.admit(
            command=fixture["command"],
            permit=fixture["permit"],
            command_payload_bytes=canonical_bytes(fixture["command"]["payload"]),
            permit_bytes=canonical_bytes(fixture["permit"]),
        )
        ledger.upsert_lifecycle_snapshot(
            account_id=fixture["command"]["payload"]["accountId"],
            symbol="BTC/USDT",
            snapshot={"diagnostic": "seeded", "terminalBrokerState": None},
            as_of_sequence=decision.receipt.command.accepted_sequence,
            writer_lease=lease,
        )
        return core

    return create


def _runtime(tmp_path: Path, **kwargs: object) -> RuntimeExecutor:
    run = _private_dir(tmp_path / "runtime")
    return RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        **kwargs,
    )


def _admit(runtime: RuntimeExecutor):
    fixture = golden_fixture()
    command = deepcopy(fixture["command"])
    permit = deepcopy(fixture["permit"])
    return runtime.admit(
        command=command,
        permit=permit,
        command_payload_bytes=canonical_bytes(command["payload"]),
        permit_bytes=canonical_bytes(permit),
    )


def _offline_identity() -> RuntimeIdentity:
    proof = local_proof()
    return RuntimeIdentity(
        mode="PAPER_LOCAL",
        run_id=LOCAL_RUN_ID,
        environment_proof_hash=proof.proofHash,
        schema_hash=LOCAL_SCHEMA_HASH,
    )


def _offline_config(
    simulator_path: Path, *, policy: dict[str, object] | None = None
) -> OfflineExecutionRuntimeConfig:
    value = v3_policy() if policy is None else policy
    return OfflineExecutionRuntimeConfig(
        policy=value,
        simulator_database_path=simulator_path,
        permit_public_key=PUBLIC_KEY_DER,
        capability_authority_key_id="offline-capability-key",
        capability_authority_private_key=OFFLINE_CAPABILITY_PRIVATE_KEY,
        receipt_signing_key_id="offline-adapter-key",
        receipt_signing_private_key=OFFLINE_RECEIPT_PRIVATE_KEY,
        source_attestation_key_id="offline-source-key",
        source_attestation_private_key=OFFLINE_SOURCE_PRIVATE_KEY,
    )


def _provision_offline_store(path: Path, config: OfflineExecutionRuntimeConfig) -> None:
    policy = config.policy
    store = OfflineSimulatorStore(
        path,
        store_id=policy["simulatorStoreId"],  # type: ignore[index]
        capability_public_keys={
            config.capability_authority_key_id: config.capability_authority_private_key.public_key()
        },
        source_attestation_key_id=config.source_attestation_key_id,
        source_attestation_private_key=config.source_attestation_private_key,
        capability_clock=lambda: NOW,
        allow_provision=True,
    )
    store.close()
    path.chmod(0o600)


def _offline_factory(config: OfflineExecutionRuntimeConfig):
    policy_hash = sha256_canonical(config.policy)
    binding = OfflineAdmissionBinding(
        policy_hash=policy_hash,
        permit_authority_key_id="rfc8032-test-1",
        permit_public_key=config.permit_public_key,
    )

    def create(ledger: Ledger, lease):
        return PaperSidecarCore(
            ledger,
            environment_provider=StaticEnvironmentProvider(
                local_proof(), clock=lambda: NOW
            ),
            resolve_public_key=lambda key_id: (
                PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None
            ),
            expected_schema_hash=LOCAL_SCHEMA_HASH,
            run_id=LOCAL_RUN_ID,
            expected_key_ids=("rfc8032-test-1",),
            offline_admission_binding=binding,
            resolve_offline_receipt_public_key=lambda key_id: (
                config.receipt_signing_private_key.public_key()
                if key_id == config.receipt_signing_key_id
                else None
            ),
            expected_offline_receipt_key_ids=(config.receipt_signing_key_id,),
            clock=lambda: NOW,
        )

    return create


def _offline_runtime(
    run: Path, config: OfflineExecutionRuntimeConfig
) -> RuntimeExecutor:
    return RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_offline_factory(config),
        expected_identity=_offline_identity(),
        wall_clock=_wall_clock,
        offline_execution=config,
    )


def _admit_offline(runtime: RuntimeExecutor, *, suffix: str = "one"):
    item = _offline_item(suffix=suffix)
    return runtime.admit(
        command=item["command"],
        permit=item["permit"],
        command_payload_bytes=canonical_bytes(item["command"]["payload"]),
        permit_bytes=canonical_bytes(item["permit"]),
    )


def _offline_item(*, suffix: str = "one") -> dict:
    item = paper_local_item()
    payload = dict(item["command"]["payload"])
    payload["idempotencyKey"] = f"offline-runtime-{suffix}"
    payload["clientOrderId"] = derive_okx_client_order_id(payload["idempotencyKey"])
    command = build_execution_command_v1(payload)
    permit = dict(item["permit"])
    # Permit V2 intentionally does not carry ``venue``; its exact scope is
    # the remaining command identity fields plus submit economics below.
    for field in (
        "accountId",
        "canonicalSymbol",
        "venueInstrumentId",
        "idempotencyKey",
        "mode",
    ):
        permit[field] = payload[field]
    permit["side"] = payload["side"]
    permit["riskReducing"] = payload["reduceOnly"]
    permit["authorizedNotionalUsd"] = payload["maxNotionalUsd"]
    permit["commandHash"] = command["commandId"]
    permit["permitId"] = sha256_canonical(
        {
            key: value
            for key, value in permit.items()
            if key not in {"permitId", "signature"}
        }
    )
    permit["signature"] = base64.b64encode(
        LOCAL_PERMIT_PRIVATE_KEY.sign(
            execution_permit_v2_signing_payload(permit).encode("utf-8")
        )
    ).decode("ascii")
    verified = verify_execution_permit_v2(
        permit=permit,
        command=command,
        resolve_public_key=lambda key_id: (
            PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None
        ),
        now=NOW,
    )
    assert verified.valid, verified.reason
    return {"command": command, "permit": permit}


def _wait_until(predicate, *, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("condition did not become true")
        time.sleep(0.01)


def test_offline_runtime_requires_exact_config_and_preprovisioned_store(
    short_path: Path,
) -> None:
    """The process freezes all local authorities and never provisions a store."""
    run = _private_dir(short_path / "offline-config")
    simulator = run / "simulator.sqlite3"
    config = _offline_config(simulator)

    with pytest.raises(ValueError, match="invalid_runtime_configuration"):
        RuntimeExecutor(
            run / "ledger.sqlite3",
            run / "admission.sock",
            core_factory=_offline_factory(config),
            expected_identity=_offline_identity(),
            wall_clock=_wall_clock,
            offline_execution=object(),  # type: ignore[arg-type]
        )
    with pytest.raises(ValueError, match="invalid_runtime_configuration"):
        RuntimeExecutor(
            run / "ledger.sqlite3",
            run / "admission.sock",
            core_factory=_offline_factory(config),
            expected_identity=EXPECTED_IDENTITY,
            wall_clock=_wall_clock,
            offline_execution=config,
        )

    unprovisioned = _offline_runtime(run, config)
    with pytest.raises(RuntimeErrorCode, match="unsafe_runtime_path"):
        unprovisioned.start()
    assert not simulator.exists()

    _provision_offline_store(simulator, config)
    runtime = _offline_runtime(run, config)
    runtime.start()
    try:
        status = runtime.health()
        assert status.status == "ready_for_durable_admission"
        assert status.mode == "PAPER_LOCAL"
        accepted = _admit_offline(runtime)
        assert accepted.disposition == "accepted_durable_not_submitted"
        _wait_until(lambda: _offline_receipt_count(run / "ledger.sqlite3") == 1)
        assert (
            runtime.get_offline_execution_receipt(
                _offline_receipt_id(run / "ledger.sqlite3")
            )
            is not None
        )
    finally:
        runtime.stop()


def _offline_receipt_count(database: Path) -> int:
    with sqlite3.connect(database) as connection:
        return int(
            connection.execute(
                "SELECT COUNT(*) FROM offline_execution_receipts"
            ).fetchone()[0]
        )


def _offline_receipt_id(database: Path) -> str:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT receipt_id FROM offline_execution_receipts"
        ).fetchone()
    assert row is not None
    return str(row[0])


def test_owner_thread_affinity_and_real_durable_duplicate(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    seen: list[int] = []
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_factory(seen=seen),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    try:
        assert runtime.owner_thread_id is not None
        assert seen == [runtime.owner_thread_id]
        assert runtime.owner_thread_id != get_ident()
        first = _admit(runtime)
        second = _admit(runtime)
        assert first.disposition == "accepted_durable_not_submitted"
        assert second.disposition == "duplicate_durable_not_submitted"
        assert runtime.health().status == "ready_for_durable_admission"
    finally:
        runtime.stop()


def test_second_owner_rejected_and_clean_restart_advances_epoch(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    database = run / "ledger.sqlite3"
    first = RuntimeExecutor(
        database,
        run / "one.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    second = RuntimeExecutor(
        database,
        run / "two.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    first.start()
    try:
        with pytest.raises(RuntimeErrorCode, match="runtime_startup_failed"):
            second.start()
    finally:
        first.stop()
    replacement = RuntimeExecutor(
        database,
        run / "three.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    replacement.start()
    try:
        with sqlite3.connect(database) as connection:
            row = connection.execute("SELECT epoch FROM writer_lease").fetchone()
        assert row == (2,)
    finally:
        replacement.stop()


def test_takeover_disarms_without_rearm_and_keeps_reads(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    database = run / "ledger.sqlite3"
    runtime = RuntimeExecutor(
        database,
        run / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        ttl_seconds=60,
    )
    runtime.start()
    try:
        # A separate owner takes the lease only after its then-current expiry.
        takeover_clock = [_wall_clock()]
        takeover = Ledger(database, fencing_clock=lambda: takeover_clock[0])
        try:
            current = takeover._connection.execute(
                "SELECT expires_at FROM writer_lease"
            ).fetchone()[0]
            takeover_clock[0] = float(current) + 1
            takeover.acquire_writer_lease(
                name="nautilus-paper-runtime",
                owner_id="replacement",
                ttl_seconds=60,
            )
        finally:
            takeover.close()
        status = runtime.health()
        assert status.status == "read_only"
        assert status.reason == "runtime_write_disarmed"
        assert status.protocol_version == EXPECTED_IDENTITY.protocol_version
        assert status.service_id == EXPECTED_IDENTITY.service_id
        assert status.mode == EXPECTED_IDENTITY.mode
        assert status.run_id == EXPECTED_IDENTITY.run_id
        assert status.environment_proof_hash == EXPECTED_IDENTITY.environment_proof_hash
        assert status.schema_hash == EXPECTED_IDENTITY.schema_hash
        assert status.writer_epoch == 1
        assert status.writer_lease_bound is False
        assert status.resume_supported is False
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
        assert runtime.handshake() == status
        assert runtime.get_command("0" * 64) is None
    finally:
        runtime.stop()


def test_write_disarmed_runtime_keeps_lifecycle_replay_and_snapshot_reads(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    database = run / "ledger.sqlite3"
    runtime = RuntimeExecutor(
        database,
        run / "admission.sock",
        core_factory=_seeded_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        ttl_seconds=60,
    )
    runtime.start()
    try:
        with sqlite3.connect(database) as connection:
            connection.execute(
                "UPDATE writer_lease SET expires_at = ?",
                (_wall_clock() - 1,),
            )
        assert runtime.health().reason == "runtime_write_disarmed"
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED

        replay = runtime.replay_lifecycle_events(after_sequence=0, limit=1000)
        assert [event.kind for event in replay] == ["acknowledged"]
        snapshot = runtime.get_snapshot(account_id="paper-main", symbol="BTC/USDT")
        assert snapshot is not None
        assert snapshot.as_of_sequence == 1
        assert snapshot.value == {
            "diagnostic": "seeded",
            "terminalBrokerState": None,
        }
    finally:
        runtime.stop()


def test_offline_receipt_read_reaches_owner_after_disarm_but_not_after_stop(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime-receipt-read")
    database = run / "ledger.sqlite3"
    runtime = RuntimeExecutor(
        database,
        run / "admission.sock",
        core_factory=_seeded_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        ttl_seconds=60,
    )
    runtime.start()
    with sqlite3.connect(database) as connection:
        connection.execute(
            "UPDATE writer_lease SET expires_at = ?", (_wall_clock() - 1,)
        )
    assert runtime.health().reason == "runtime_write_disarmed"
    # This reaches the owner/core and therefore proves the read gate remains
    # open; its frozen public key is used even though this receipt is absent.
    assert runtime.get_offline_execution_receipt("f" * 64) is None
    runtime.stop()
    with pytest.raises(RuntimeErrorCode, match="runtime_unavailable"):
        runtime.get_offline_execution_receipt("f" * 64)
    with pytest.raises(RuntimeErrorCode, match="runtime_unavailable"):
        runtime.health()


def test_owner_automatically_renews_a_current_lease(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    database = run / "ledger.sqlite3"
    runtime = RuntimeExecutor(
        database,
        run / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        ttl_seconds=0.15,
    )
    runtime.start()
    try:
        with sqlite3.connect(database) as connection:
            first_expiry = connection.execute(
                "SELECT expires_at FROM writer_lease"
            ).fetchone()[0]
        time.sleep(0.12)
        with sqlite3.connect(database) as connection:
            renewed_expiry = connection.execute(
                "SELECT expires_at FROM writer_lease"
            ).fetchone()[0]
        assert renewed_expiry > first_expiry
        assert runtime.supervisor.state is RuntimeState.DURABLE_UDS_READY
    finally:
        runtime.stop()


def test_lease_controller_rejects_cross_thread_access(short_path: Path) -> None:
    database = short_path / "owner-thread.sqlite3"
    ledger = Ledger(database)
    controller = LeaseController(
        ledger,
        name="owner-thread",
        owner_id="owner-a",
        ttl_seconds=30,
        wall_clock=_wall_clock,
    )
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            attempt = pool.submit(controller.acquire)
            with pytest.raises(
                RuntimeErrorCode, match="runtime_owner_thread_violation"
            ):
                attempt.result(timeout=3)
        assert ledger.counts()["writer_lease"] == 0
    finally:
        ledger.close()


def test_health_identity_drift_disarms_runtime(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    drift = Event()

    def drifting_factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)
        original = core.health

        def drifting_health(**kwargs):
            status = original(**kwargs)
            return replace(status, schema_hash="b" * 64) if drift.is_set() else status

        core.health = drifting_health  # type: ignore[method-assign]
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=drifting_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    channel = grpc.insecure_channel(f"unix://{runtime._socket_path}")
    try:
        drift.set()
        stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
        status = stub.Health(execution_pb2.HealthRequest(), timeout=3)
        assert status.status == execution_pb2.SERVICE_STATUS_READ_ONLY
        assert status.circuit_reason == "runtime_write_disarmed"
        assert status.detail == "durable_admission_read_only"
        assert status.mode == execution_pb2.PAPER_MODE_EXCHANGE
        assert status.run_id == EXPECTED_IDENTITY.run_id
        assert status.writer_epoch == 1
        assert status.environment_proof_hash == EXPECTED_IDENTITY.environment_proof_hash
        assert status.schema_hash == EXPECTED_IDENTITY.schema_hash
        direct = runtime.health()
        assert direct.status == "read_only"
        assert direct.reason == "runtime_write_disarmed"
        assert direct.mode == EXPECTED_IDENTITY.mode
        assert direct.run_id == EXPECTED_IDENTITY.run_id
        assert direct.environment_proof_hash == EXPECTED_IDENTITY.environment_proof_hash
        assert direct.schema_hash == EXPECTED_IDENTITY.schema_hash
        assert direct.writer_epoch == 1
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
    finally:
        channel.close()
        runtime.stop()


def test_admit_pins_exact_proof_across_precheck_and_write(short_path: Path) -> None:
    """A provider drift between precheck and core validation cannot be written."""
    run = _private_dir(short_path / "runtime")
    providers: list[_SequencedProofProvider] = []

    def factory(ledger: Ledger, lease):
        provider = _SequencedProofProvider()
        providers.append(provider)
        core = PaperSidecarCore(
            ledger,
            environment_provider=provider,
            resolve_public_key=lambda key_id: (
                PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None
            ),
            expected_schema_hash=EXPECTED_IDENTITY.schema_hash,
            run_id=EXPECTED_IDENTITY.run_id,
            expected_key_ids=("rfc8032-test-1",),
            clock=lambda: NOW,
        )
        core.bind_writer_lease(lease)
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    try:
        # health() sees the original identity; the same admit() call then sees
        # a still-valid proof with the same mode/run/schema but another hash.
        providers[0].sequence = [
            _runtime_proof(),
            _runtime_proof(config_digest="c" * 64),
        ]
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM execution_commands"
            ).fetchone() == (0,)
            assert connection.execute("SELECT COUNT(*) FROM events").fetchone() == (0,)
    finally:
        runtime.stop()


def test_runtime_freezes_verification_key_material_before_ready(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    resolved: list[str] = []
    available = {"value": PUBLIC_KEY_DER}

    def factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)

        def resolver(key_id: str):
            resolved.append(key_id)
            return available["value"] if key_id == "rfc8032-test-1" else None

        core._resolve_public_key = resolver
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    try:
        assert resolved == ["rfc8032-test-1"]
        available["value"] = None
        assert _admit(runtime).disposition == "accepted_durable_not_submitted"
        assert resolved == ["rfc8032-test-1"]
    finally:
        runtime.stop()


def test_unexpected_admission_failure_poison_disarms_without_leaking_detail(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")

    def failing_factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)

        def fail(**_kwargs):
            raise RuntimeError("credential=must-not-leak")

        core.admit = fail  # type: ignore[method-assign]
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=failing_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    try:
        with pytest.raises(RuntimeErrorCode) as failed:
            _admit(runtime)
        assert str(failed.value) == "runtime_unavailable"
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
    finally:
        runtime.stop()


def test_post_lock_environment_expiry_disarms_without_write(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    fencing_time = {"value": NOW.timestamp()}
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=lambda: fencing_time["value"],
        ttl_seconds=120,
    )
    runtime.start()
    try:
        # Core business validation still observes NOW, but the authoritative
        # post-BEGIN sample has crossed the environment proof's expiry.
        fencing_time["value"] = (NOW + timedelta(seconds=61)).timestamp()
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            assert connection.execute(
                "SELECT COUNT(*) FROM execution_commands"
            ).fetchone() == (0,)
            assert connection.execute("SELECT COUNT(*) FROM events").fetchone() == (0,)
    finally:
        runtime.stop()


def test_authority_clock_failure_after_precheck_permanently_disarms(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    sequence = {"values": []}

    def authority_clock():
        values = sequence["values"]
        return values.pop(0) if values else NOW

    def factory(ledger: Ledger, lease):
        return configured_core(ledger, lease=lease, clock=authority_clock)

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    try:
        sequence["values"] = [NOW, NOW.replace(tzinfo=None)]
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            assert connection.execute("SELECT COUNT(*) FROM events").fetchone() == (0,)
    finally:
        runtime.stop()


def test_identity_mismatch_never_publishes_ready_or_creates_socket(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    socket_path = run / "admission.sock"
    mismatched = RuntimeIdentity(
        mode=EXPECTED_IDENTITY.mode,
        run_id=EXPECTED_IDENTITY.run_id,
        environment_proof_hash=EXPECTED_IDENTITY.environment_proof_hash,
        schema_hash="b" * 64,
    )
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        socket_path,
        core_factory=_factory(),
        expected_identity=mismatched,
        wall_clock=_wall_clock,
    )
    with pytest.raises(RuntimeErrorCode, match="runtime_startup_failed"):
        runtime.start()
    assert runtime.supervisor.state is RuntimeState.STOPPED
    assert not socket_path.exists()


def test_stop_closes_admission_gate_before_queueing(short_path: Path) -> None:
    runtime = _runtime(short_path)
    runtime.start()
    runtime.stop()
    with pytest.raises(CoreAdmissionDenied, match="runtime_draining"):
        _admit(runtime)
    assert runtime.supervisor.state is RuntimeState.STOPPED
    runtime.stop()  # idempotent


def test_existing_socket_is_never_unlinked_and_unsafe_parent_is_rejected(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    socket_path = run / "admission.sock"
    socket_path.write_text("do-not-delete", encoding="utf-8")
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        socket_path,
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    with pytest.raises(RuntimeErrorCode, match="runtime_socket_already_exists"):
        runtime.start()
    assert socket_path.read_text(encoding="utf-8") == "do-not-delete"

    unsafe = short_path / "unsafe"
    unsafe.mkdir(mode=0o755)
    unsafe.chmod(0o755)
    blocked = RuntimeExecutor(
        unsafe / "ledger.sqlite3",
        unsafe / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    with pytest.raises(RuntimeErrorCode, match="unsafe_runtime_path"):
        blocked.start()


def test_symlink_in_runtime_path_ancestor_is_rejected_before_ledger_open(
    short_path: Path,
) -> None:
    actual = _private_dir(short_path / "actual")
    run = _private_dir(actual / "runtime")
    link = short_path / "linked"
    link.symlink_to(actual, target_is_directory=True)
    runtime = RuntimeExecutor(
        link / run.name / "ledger.sqlite3",
        link / run.name / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )

    with pytest.raises(RuntimeErrorCode, match="unsafe_runtime_path"):
        runtime.start()
    assert not (run / "ledger.sqlite3").exists()


def test_stop_never_unlinks_a_replacement_socket(short_path: Path) -> None:
    runtime = _runtime(short_path)
    runtime.start()
    socket_path = runtime._socket_path
    os.unlink(socket_path)
    replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    replacement.bind(str(socket_path))
    try:
        with pytest.raises(RuntimeErrorCode, match="runtime_socket_identity_changed"):
            runtime.stop()
        assert socket_path.exists()
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        runtime.stop()
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with pytest.raises(RuntimeErrorCode, match="runtime_process_restart_required"):
            runtime.start()
        assert socket_path.exists()
    finally:
        replacement.close()
        if socket_path.exists():
            os.unlink(socket_path)


def test_start_stop_idempotence_and_real_uds_round_trip(short_path: Path) -> None:
    runtime = _runtime(short_path)
    runtime.start()
    runtime.start()
    channel = grpc.insecure_channel(f"unix://{runtime._socket_path}")
    try:
        stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
        health = stub.Health(execution_pb2.HealthRequest(), timeout=3)
        assert health.status == execution_pb2.SERVICE_STATUS_READY
        response = stub.Execute(request_from_fixture(golden_fixture()), timeout=3)
        assert response.disposition == execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
        assert response.reason == "accepted_durable_not_submitted"
    finally:
        channel.close()
        runtime.stop()
        runtime.stop()
    runtime.start()
    try:
        assert runtime.health().writer_epoch == 2
    finally:
        runtime.stop()


def test_concurrent_start_then_stop_cannot_revive_listener(short_path: Path) -> None:
    run = _private_dir(short_path / "runtime")
    entered, release = Event(), Event()

    def delayed_factory(ledger: Ledger, lease):
        entered.set()
        assert release.wait(3)
        return configured_core(ledger, lease=lease)

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=delayed_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    with ThreadPoolExecutor(max_workers=2) as pool:
        started = pool.submit(runtime.start)
        assert entered.wait(3)
        stopped = pool.submit(runtime.stop)
        release.set()
        started.result(timeout=3)
        stopped.result(timeout=3)
    assert runtime.supervisor.state is RuntimeState.STOPPED
    assert not runtime._socket_path.exists()


def test_runtime_uds_read_model_stream_is_live_bounded_and_nonstarving(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_seeded_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    channel = grpc.insecure_channel(f"unix://{runtime._socket_path}")
    try:
        grpc.channel_ready_future(channel).result(timeout=3)
        stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
        fixture = golden_fixture()
        account_id = fixture["command"]["payload"]["accountId"]

        # This is an actual UDS gRPC call through the owner-thread gateway,
        # rather than a direct service invocation.  Absence is the only
        # non-error read result after the receipt public key was frozen.
        missing_receipt = stub.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id="f" * 64),
            timeout=3,
        )
        assert missing_receipt.found is False

        snapshot = stub.GetSnapshot(
            execution_pb2.GetSnapshotRequest(
                account_id=account_id, canonical_symbol="BTC/USDT"
            ),
            timeout=3,
        )
        assert snapshot.found is True
        assert snapshot.as_of_sequence == 1
        assert json.loads(snapshot.snapshot_json_utf8) == {
            "diagnostic": "seeded",
            "terminalBrokerState": None,
        }
        replay = stub.ReplayEvents(
            execution_pb2.ReplayEventsRequest(after_sequence=0, limit=1000),
            timeout=3,
        )
        assert [event.sequence for event in replay.events] == [1]
        assert replay.events[0].kind == execution_pb2.EXECUTION_EVENT_KIND_ACKNOWLEDGED

        first_stream = stub.StreamEvents(
            execution_pb2.StreamEventsRequest(after_sequence=0), timeout=3
        )
        assert next(first_stream).sequence == 1

        # Occupy the second bounded stream slot after catch-up. The call must
        # remain live rather than returning EOF, while two workers stay free.
        second_stream = stub.StreamEvents(
            execution_pb2.StreamEventsRequest(after_sequence=1), timeout=3
        )
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(next, second_stream)
            time.sleep(0.1)
            assert waiting.done() is False

            health = stub.Health(execution_pb2.HealthRequest(), timeout=1)
            assert health.status == execution_pb2.SERVICE_STATUS_READY
            duplicate = stub.Execute(request_from_fixture(fixture), timeout=1)
            assert duplicate.disposition == execution_pb2.EXECUTE_DISPOSITION_DUPLICATE

            third_stream = stub.StreamEvents(
                execution_pb2.StreamEventsRequest(after_sequence=1), timeout=1
            )
            with pytest.raises(grpc.RpcError) as exhausted:
                next(third_stream)
            assert exhausted.value.code() == grpc.StatusCode.RESOURCE_EXHAUSTED

            second_stream.cancel()
            with pytest.raises((grpc.RpcError, StopIteration)):
                waiting.result(timeout=2)
        first_stream.cancel()

        with pytest.raises(grpc.RpcError) as deadline:
            list(
                stub.StreamEvents(
                    execution_pb2.StreamEventsRequest(after_sequence=1),
                    timeout=0.1,
                )
            )
        assert deadline.value.code() == grpc.StatusCode.DEADLINE_EXCEEDED
    finally:
        channel.close()
        runtime.stop()


def test_owner_startup_timeout_can_never_be_overwritten_by_ready(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")

    class DelayedStartServer:
        preserves_replaced_public_socket_on_stop = True

        def __init__(self, server):
            self._server = server

        @property
        def published_identity(self):
            return self._server.published_identity

        def start(self):
            time.sleep(0.12)
            return self._server.start()

        def stop(self, grace):
            return self._server.stop(grace)

    def delayed_server_factory(**kwargs):
        return DelayedStartServer(build_uds_server(**kwargs))

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_factory(),
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        server_factory=delayed_server_factory,
        startup_timeout_seconds=0.05,
    )
    with pytest.raises(RuntimeErrorCode, match="runtime_startup_failed"):
        runtime.start()
    assert runtime.supervisor.state is RuntimeState.STOPPED
    assert runtime._admission_open is False
    assert runtime._request_open is False
    assert not runtime._socket_path.exists()


def test_drain_waits_for_a_previously_queued_admission(short_path: Path) -> None:
    """The gate rejects post-stop work while a queued owner operation drains."""
    run = _private_dir(short_path / "runtime")
    entered, release = Event(), Event()

    def slow_factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)
        original = core.admit

        def slow_admit(**kwargs):
            entered.set()
            assert release.wait(3)
            return original(**kwargs)

        core.admit = slow_admit  # type: ignore[method-assign]
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=slow_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
    )
    runtime.start()
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(_admit, runtime)
        assert entered.wait(3)
        stopping = pool.submit(runtime.stop)
        time.sleep(0.05)
        with pytest.raises(CoreAdmissionDenied, match="runtime_draining"):
            _admit(runtime)
        release.set()
        assert pending.result(timeout=3).disposition == "accepted_durable_not_submitted"
        stopping.result(timeout=3)


def test_inflight_admission_timeout_is_unknown_and_permanently_disarms(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    entered, release = Event(), Event()

    def slow_factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)
        original = core.admit

        def slow_admit(**kwargs):
            entered.set()
            assert release.wait(3)
            return original(**kwargs)

        core.admit = slow_admit  # type: ignore[method-assign]
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=slow_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        shutdown_timeout_seconds=0.05,
    )
    runtime.start()
    fixture = golden_fixture()
    with ThreadPoolExecutor(max_workers=1) as pool:
        pending = pool.submit(_admit, runtime)
        assert entered.wait(3)
        with pytest.raises(CoreAdmissionDenied, match="runtime_submission_unknown"):
            pending.result(timeout=3)
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit(runtime)
        release.set()

    deadline = time.monotonic() + 3
    durable_count = 0
    while durable_count == 0 and time.monotonic() < deadline:
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            durable_count = connection.execute(
                "SELECT COUNT(*) FROM execution_commands"
            ).fetchone()[0]
        if durable_count == 0:
            time.sleep(0.01)
    assert durable_count == 1
    command = runtime.get_command(fixture["command"]["commandId"])
    assert command is not None
    assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
    runtime.stop()
    assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED


def test_offline_backlog_effect_starts_only_after_durable_admission_ack(
    short_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The API ACK is observable before the coordinator may mutate the store."""
    run = _private_dir(short_path / "offline-ack")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    actual = runtime_module.OfflineExecutionCoordinator
    effect_entered, ack_observed, release = Event(), Event(), Event()

    class AckOrderedCoordinator:
        def __init__(self, *args, **kwargs) -> None:
            self._inner = actual(*args, **kwargs)

        def bind_writer_lease(self, lease) -> None:
            self._inner.bind_writer_lease(lease)

        def execute_or_recover(self, command_hash):
            effect_entered.set()
            assert ack_observed.wait(3), (
                "effect began before the admission caller received ACK"
            )
            assert release.wait(3)
            return self._inner.execute_or_recover(command_hash)

    monkeypatch.setattr(
        runtime_module, "OfflineExecutionCoordinator", AckOrderedCoordinator
    )
    runtime = _offline_runtime(run, config)
    runtime.start()
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            acknowledged = pool.submit(_admit_offline, runtime)
            decision = acknowledged.result(timeout=3)
            assert decision.disposition == "accepted_durable_not_submitted"
            ack_observed.set()
            assert effect_entered.wait(3)
            release.set()
        _wait_until(lambda: _offline_receipt_count(run / "ledger.sqlite3") == 1)
    finally:
        ack_observed.set()
        release.set()
        runtime.stop()


def test_offline_backlog_commits_two_commands_in_global_store_sequence(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "offline-sequence")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    runtime = _offline_runtime(run, config)
    runtime.start()
    try:
        first = _admit_offline(runtime, suffix="one")
        second = _admit_offline(runtime, suffix="two")
        # Lifecycle sequence is global: each command contributes its ACK and
        # its asynchronously committed simulator receipt.
        assert [
            first.receipt.command.accepted_sequence,
            second.receipt.command.accepted_sequence,
        ] == [1, 3]
        _wait_until(lambda: _offline_receipt_count(run / "ledger.sqlite3") == 2)
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            rows = connection.execute(
                "SELECT command_hash, source_store_sequence, lifecycle_sequence "
                "FROM offline_execution_receipts ORDER BY lifecycle_sequence"
            ).fetchall()
        assert [row[0] for row in rows] == [
            first.receipt.command.command_hash,
            second.receipt.command.command_hash,
        ]
        assert [row[1] for row in rows] == ["1", "2"]
        assert [row[2] for row in rows] == [2, 4]
    finally:
        runtime.stop()


def test_execution_proto_service_exposes_no_new_mutation_rpc() -> None:
    service = execution_pb2.DESCRIPTOR.services_by_name["OpenAliceExecutionService"]
    assert [method.name for method in service.methods] == [
        "Handshake",
        "Execute",
        "GetCommand",
        "GetOfflineExecutionReceipt",
        "GetSnapshot",
        "ReplayEvents",
        "StreamEvents",
        "Health",
    ]


def test_offline_coordinator_rebinds_the_renewed_owner_lease(
    short_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Renewal is owner-thread-only and re-fences later simulator dispatches."""
    run = _private_dir(short_path / "offline-renew-rebind")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    real_monotonic = time.monotonic
    monotonic = [10.0]
    wall = [NOW.timestamp()]
    monkeypatch.setattr(runtime_module.time, "monotonic", lambda: monotonic[0])
    actual = runtime_module.OfflineExecutionCoordinator
    bound: list[tuple[int, object]] = []
    rebound = Event()

    class RecordingCoordinator:
        def __init__(self, *args, **kwargs) -> None:
            self._inner = actual(*args, **kwargs)

        def bind_writer_lease(self, lease) -> None:
            bound.append((get_ident(), lease))
            rebound.set()
            self._inner.bind_writer_lease(lease)

        def execute_or_recover(self, command_hash):
            return self._inner.execute_or_recover(command_hash)

    monkeypatch.setattr(
        runtime_module, "OfflineExecutionCoordinator", RecordingCoordinator
    )
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_offline_factory(config),
        expected_identity=_offline_identity(),
        wall_clock=lambda: wall[0],
        offline_execution=config,
        ttl_seconds=3,
    )
    runtime.start()
    try:
        # The first read wakes an owner that may already be blocked in
        # Queue.get; the second necessarily follows its next loop-top renewal
        # point.  Wall time remains safely inside the original lease.
        monotonic[0] = 11.1
        wall[0] += 1.0
        assert runtime.health().status == "ready_for_durable_admission"
        assert runtime.health().status == "ready_for_durable_admission"
        assert rebound.wait(1)
        assert len(bound) == 1
        bound_thread, renewed = bound[0]
        assert bound_thread == runtime.owner_thread_id
        assert renewed.name == "nautilus-paper-runtime"
        assert renewed.owner_id == runtime.owner_id
        with sqlite3.connect(run / "ledger.sqlite3") as connection:
            row = connection.execute(
                "SELECT owner_id, epoch, expires_at FROM writer_lease"
            ).fetchone()
        assert row == (renewed.owner_id, renewed.epoch, renewed.expires_at)

        _admit_offline(runtime, suffix="after-renewal")
        deadline = real_monotonic() + 3
        while _offline_receipt_count(run / "ledger.sqlite3") != 1:
            if real_monotonic() >= deadline:
                raise AssertionError("post-renewal offline receipt was not committed")
            Event().wait(0.01)
        assert runtime.supervisor.state is RuntimeState.DURABLE_UDS_READY
    finally:
        runtime.stop()


def _seed_offline_inflight(
    run: Path, config: OfflineExecutionRuntimeConfig, *, source_effect: bool
) -> tuple[str, str]:
    """Leave an old-epoch dispatch either with or without its source effect."""
    ledger = Ledger(
        run / "ledger.sqlite3",
        fencing_clock=_wall_clock,
        offline_capability_authority_private_key=config.capability_authority_private_key,
        offline_capability_authority_key_id=config.capability_authority_key_id,
        offline_receipt_signing_private_key=config.receipt_signing_private_key,
        offline_receipt_signing_key_id=config.receipt_signing_key_id,
        offline_source_attestation_public_keys={
            config.source_attestation_key_id: config.source_attestation_private_key.public_key()
        },
    )
    simulator = None
    try:
        lease = ledger.acquire_writer_lease(
            name="nautilus-paper-runtime", owner_id="crashed-owner", ttl_seconds=30
        )
        registered = ledger.register_offline_adapter_policy(
            policy=config.policy, writer_lease=lease
        )
        assert registered.policy_hash == sha256_canonical(config.policy)
        core = _offline_factory(config)(ledger, lease)
        core.freeze_expected_public_keys()
        core.bind_writer_lease(lease)
        admitted = core.admit(
            command=_offline_item(suffix="recovery")["command"],
            permit=_offline_item(suffix="recovery")["permit"],
            command_payload_bytes=canonical_bytes(
                _offline_item(suffix="recovery")["command"]["payload"]
            ),
            permit_bytes=canonical_bytes(_offline_item(suffix="recovery")["permit"]),
        )
        command_hash = admitted.receipt.command.command_hash
        attempt = ledger.claim_offline_dispatch(
            command_hash=command_hash,
            writer_lease=lease,
            permit_public_key=config.permit_public_key,
        )
        if source_effect:
            simulator = OfflineSimulatorStore(
                config.simulator_database_path,
                store_id=config.policy["simulatorStoreId"],  # type: ignore[index]
                capability_public_keys={
                    config.capability_authority_key_id: config.capability_authority_private_key.public_key()
                },
                source_attestation_key_id=config.source_attestation_key_id,
                source_attestation_private_key=config.source_attestation_private_key,
                capability_clock=lambda: NOW,
                allow_provision=False,
            )
            capability = ledger.issue_offline_simulator_capability(
                command_hash=command_hash, writer_lease=lease
            )
            simulator.ensure_exact(
                attempt.request,
                canonical_capability_json_utf8=capability.capability_json.encode(
                    "utf-8"
                ),
            )
        ledger.release_writer_lease(lease)
        return command_hash, admitted.receipt.command.command_hash
    finally:
        if simulator is not None:
            simulator.close()
        ledger.close()
        # This seed stands in for a previous managed runtime, which has
        # already applied the same private-ledger hardening before restart.
        (run / "ledger.sqlite3").chmod(0o600)


def test_offline_startup_recovers_existing_effect_before_opening_admission(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "offline-recover-effect")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    command_hash, _ = _seed_offline_inflight(run, config, source_effect=True)
    runtime = _offline_runtime(run, config)
    runtime.start()
    try:
        assert runtime.supervisor.state is RuntimeState.DURABLE_UDS_READY
        _wait_until(lambda: _offline_receipt_count(run / "ledger.sqlite3") == 1)
        stored = runtime.get_offline_execution_receipt(
            _offline_receipt_id(run / "ledger.sqlite3")
        )
        assert stored is not None and stored.command_hash == command_hash
    finally:
        runtime.stop()


def test_old_epoch_missing_effect_starts_read_only_but_keeps_read_rpcs(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "offline-recover-missing")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    _, command_id = _seed_offline_inflight(run, config, source_effect=False)
    runtime = _offline_runtime(run, config)
    runtime.start()
    channel = grpc.insecure_channel(f"unix://{runtime._socket_path}")
    try:
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        assert runtime.get_command(command_id) is not None
        assert runtime.get_offline_execution_receipt("f" * 64) is None
        with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
            _admit_offline(runtime, suffix="after-read-only")
        stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
        identity = _offline_identity()
        handshake = stub.Handshake(
            execution_pb2.HandshakeRequest(
                protocol_version="openalice.execution.v1",
                client_id="openalice.read-only-runtime-test",
            ),
            timeout=3,
        )
        assert handshake.protocol_version == identity.protocol_version
        assert handshake.service_id == identity.service_id
        assert handshake.mode == execution_pb2.PAPER_MODE_LOCAL
        assert handshake.run_id == LOCAL_RUN_ID
        assert handshake.environment_proof_hash == identity.environment_proof_hash
        assert handshake.schema_hash == LOCAL_SCHEMA_HASH
        assert handshake.writer_epoch == 2
        health = stub.Health(execution_pb2.HealthRequest(), timeout=3)
        assert health.status == execution_pb2.SERVICE_STATUS_READ_ONLY
        assert health.detail == "durable_admission_read_only"
        assert health.circuit_reason == "runtime_write_disarmed"
        assert health.mode == execution_pb2.PAPER_MODE_LOCAL
        assert health.run_id == LOCAL_RUN_ID
        assert health.environment_proof_hash == identity.environment_proof_hash
        assert health.schema_hash == LOCAL_SCHEMA_HASH
        assert health.writer_epoch == 2
        command = stub.GetCommand(
            execution_pb2.GetCommandRequest(command_id=command_id), timeout=3
        )
        assert command.found is True
        missing = stub.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id="f" * 64),
            timeout=3,
        )
        assert missing.found is False
    finally:
        channel.close()
        runtime.stop()


def test_grpc_deadline_propagates_to_runtime_submission_unknown(
    short_path: Path,
) -> None:
    run = _private_dir(short_path / "runtime")
    entered, release = Event(), Event()

    def slow_factory(ledger: Ledger, lease):
        core = configured_core(ledger, lease=lease)
        original = core.admit

        def slow_admit(**kwargs):
            entered.set()
            assert release.wait(3)
            return original(**kwargs)

        core.admit = slow_admit  # type: ignore[method-assign]
        return core

    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=slow_factory,
        expected_identity=EXPECTED_IDENTITY,
        wall_clock=_wall_clock,
        shutdown_timeout_seconds=3,
    )
    runtime.start()
    channel = grpc.insecure_channel(f"unix://{runtime._socket_path}")
    try:
        stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
        try:
            response = stub.Execute(
                request_from_fixture(golden_fixture()),
                timeout=0.05,
            )
        except grpc.RpcError as timeout:
            # Transport scheduling may let the wire deadline win the race.
            assert timeout.code() == grpc.StatusCode.DEADLINE_EXCEEDED
        else:
            # The runtime uses the remaining wire deadline and may publish its
            # explicit unknown response just before gRPC closes the call.
            assert response.disposition == execution_pb2.EXECUTE_DISPOSITION_UNAVAILABLE
            assert response.reason == "runtime_submission_unknown"
        assert entered.is_set()
        deadline = time.monotonic() + 1
        while (
            runtime.supervisor.state is not RuntimeState.WRITE_DISARMED
            and time.monotonic() < deadline
        ):
            time.sleep(0.01)
        assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
        release.set()
    finally:
        release.set()
        channel.close()
        runtime.stop()
    assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
