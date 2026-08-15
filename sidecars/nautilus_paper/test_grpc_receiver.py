"""Contract and local-UDS tests for the durable-only gRPC admission adapter."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import stat
import tempfile
from types import SimpleNamespace

import grpc
import pytest

from sidecars.nautilus_paper.contract import sha256_canonical, stable_stringify
from sidecars.nautilus_paper.core import CoreAdmissionDenied, CoreStatus, PaperSidecarCore
from sidecars.nautilus_paper.environment import (
    PAPER_EXCHANGE,
    StaticEnvironmentProvider,
    build_paper_environment_proof_v1,
)
from sidecars.nautilus_paper.grpc_receiver import (
    DurableAdmissionExecutionService,
    _validated_event_page,
    _handshake_response,
    _health_response,
    build_uds_server,
)
from sidecars.nautilus_paper.generated import openalice_execution_v1_pb2 as execution_pb2
from sidecars.nautilus_paper.generated import openalice_execution_v1_pb2_grpc as execution_pb2_grpc
from sidecars.nautilus_paper.ledger import Ledger
from sidecars.nautilus_paper.offline_receipt import (
    build_execution_event_v2_from_offline_receipt,
)
from sidecars.nautilus_paper.test_offline_receipt import (
    REQUEST_BYTES as OFFLINE_REQUEST_BYTES,
    RESPONSE_BYTES as OFFLINE_RESPONSE_BYTES,
    receipt as offline_receipt_fixture,
)


NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
SCHEMA_HASH = "a" * 64
RUN_ID = "paper-grpc-test-run"
PUBLIC_KEY_DER = bytes.fromhex(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a"
    "0ee172f3daa62325af021a68f707511a"
)


def golden_fixture() -> dict:
    fixture = Path(__file__).resolve().parents[2] / "src/sidecar/fixtures/openalice_execution_contract_v1.json"
    return json.loads(fixture.read_text(encoding="utf-8"))


def canonical_bytes(value: object) -> bytes:
    return stable_stringify(value).encode("utf-8")


def socket_identity(path: Path) -> tuple[int, int]:
    entry = path.lstat()
    assert stat.S_ISSOCK(entry.st_mode)
    return entry.st_dev, entry.st_ino


def assert_uds_reachable(path: Path) -> None:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        client.settimeout(1)
        client.connect(str(path))
    finally:
        client.close()


@pytest.fixture
def ledger(tmp_path: Path):
    clock = [NOW.timestamp()]
    instance = Ledger(
        tmp_path / "grpc-receiver.sqlite3", fencing_clock=lambda: clock[0]
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    yield instance
    instance.close()


def configured_core(
    ledger: Ledger,
    *,
    clock=lambda: NOW,
    lease=None,
) -> PaperSidecarCore:
    proof = build_paper_environment_proof_v1(
        observed_at=NOW - timedelta(seconds=1),
        expires_at=NOW + timedelta(seconds=60),
        mode=PAPER_EXCHANGE,
        run_id=RUN_ID,
        config_digest="b" * 64,
        schema_hash=SCHEMA_HASH,
        endpoint_class="okx_demo",
        credential_class="demo_only",
        execution_client_registered=True,
        now=NOW,
    )
    core = PaperSidecarCore(
        ledger,
        environment_provider=StaticEnvironmentProvider(proof, clock=clock),
        resolve_public_key=lambda key_id: PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None,
        expected_schema_hash=SCHEMA_HASH,
        run_id=RUN_ID,
        expected_key_ids=("rfc8032-test-1",),
        resolve_offline_receipt_public_key=lambda key_id: (
            PUBLIC_KEY_DER if key_id == "offline-receipt-test-1" else None
        ),
        expected_offline_receipt_key_ids=("offline-receipt-test-1",),
        clock=clock,
    )
    core.bind_writer_lease(lease or ledger.acquire_writer_lease(
        name="paper-grpc", owner_id="grpc-a", ttl_seconds=120
    ))
    return core


def request_from_fixture(item: dict) -> execution_pb2.ExecuteRequest:
    payload = item["command"]["payload"]
    command = execution_pb2.ExecutionCommand(
        schema_version=item["command"]["schemaVersion"],
        command_id=item["command"]["commandId"],
        payload_hash=item["command"]["payloadHash"],
        canonical_payload_json_utf8=canonical_bytes(payload),
        payload=execution_pb2.ExecutionCommandPayload(
            schema_version=payload["schemaVersion"],
            kind=execution_pb2.COMMAND_KIND_SUBMIT,
            account_id=payload["accountId"],
            canonical_symbol=payload["canonicalSymbol"],
            venue=execution_pb2.VENUE_OKX,
            venue_instrument_id=payload["venueInstrumentId"],
            idempotency_key=payload["idempotencyKey"],
            mode=execution_pb2.PAPER_MODE_EXCHANGE,
            client_order_id=payload["clientOrderId"],
            side=execution_pb2.ORDER_SIDE_BUY,
            order_type=execution_pb2.ORDER_TYPE_LIMIT,
            quantity=payload["quantity"],
            price=payload["price"],
            time_in_force=execution_pb2.TIME_IN_FORCE_GTC,
            reduce_only=payload["reduceOnly"],
            max_notional_usd=payload["maxNotionalUsd"],
        ),
    )
    return execution_pb2.ExecuteRequest(command=command, permit_json_utf8=canonical_bytes(item["permit"]))


class _DirectGateway:
    def __init__(self, core: PaperSidecarCore) -> None:
        self.core = core

    def handshake(self):
        return self.core.handshake()

    def health(self):
        return self.core.health()

    def admit(self, **kwargs):
        kwargs.pop("operation_timeout_seconds", None)
        return self.core.admit(**kwargs)

    def get_command(self, command_id: str):
        return self.core.get_command(command_id)

    def get_offline_execution_receipt(self, receipt_id: str):
        return self.core.get_offline_execution_receipt(receipt_id)

    def get_snapshot(self, *, account_id: str, symbol: str):
        return self.core.get_snapshot(account_id=account_id, symbol=symbol)

    def replay_lifecycle_events(self, *, after_sequence: int = 0, limit: int = 1_000):
        return self.core.replay_lifecycle_events(
            after_sequence=after_sequence, limit=limit
        )


class _ReceiptGateway(_DirectGateway):
    """Small read-only gateway fixture for RPC projection/error tests."""

    def __init__(self, core: PaperSidecarCore, value: object) -> None:
        super().__init__(core)
        self.value = value

    def get_offline_execution_receipt(self, receipt_id: str):
        if isinstance(self.value, Exception):
            raise self.value
        if self.value is None:
            return None
        assert isinstance(self.value, SimpleNamespace)
        if receipt_id != self.value.receipt_id:
            return None
        return self.value


def _stored_offline_receipt() -> SimpleNamespace:
    receipt = offline_receipt_fixture()
    event = build_execution_event_v2_from_offline_receipt(receipt)
    return SimpleNamespace(
        receipt_id=receipt["receiptId"],
        lifecycle_sequence=int(receipt["lifecycleSequence"]),
        receipt_json=stable_stringify(receipt),
        canonical_request_json=OFFLINE_REQUEST_BYTES.decode("utf-8"),
        canonical_response_json=OFFLINE_RESPONSE_BYTES.decode("utf-8"),
        lifecycle_event_json=stable_stringify(event),
        lifecycle_event=event,
    )


def test_direct_execute_maps_durable_acceptance_and_duplicate_without_broker(ledger: Ledger) -> None:
    service = DurableAdmissionExecutionService(configured_core(ledger))
    request = request_from_fixture(golden_fixture())

    first = service.Execute(request, None)  # type: ignore[arg-type]
    assert first.disposition == execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
    assert first.command_id == request.command.command_id
    assert first.accepted_sequence == 1
    assert first.reason == "accepted_durable_not_submitted"
    assert ledger.latest_cursor() == 1

    read = service.GetCommand(  # type: ignore[arg-type]
        execution_pb2.GetCommandRequest(command_id=request.command.command_id), None
    )
    assert read.found is True
    assert read.command == request.command
    assert read.permit_json_utf8 == request.permit_json_utf8
    assert read.disposition == execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
    assert read.accepted_sequence == 1

    missing = service.GetCommand(  # type: ignore[arg-type]
        execution_pb2.GetCommandRequest(command_id="f" * 64), None
    )
    assert missing.found is False

    duplicate = service.Execute(request, None)  # type: ignore[arg-type]
    assert duplicate.disposition == execution_pb2.EXECUTE_DISPOSITION_DUPLICATE
    assert duplicate.accepted_sequence == first.accepted_sequence
    assert duplicate.reason == "duplicate_durable_not_submitted"
    assert ledger.latest_cursor() == 1


def test_offline_receipt_rpc_is_exact_for_missing_valid_and_invalid_ids(ledger: Ledger) -> None:
    stored = _stored_offline_receipt()
    service = DurableAdmissionExecutionService(
        gateway=_ReceiptGateway(configured_core(ledger), stored)
    )
    missing = service.GetOfflineExecutionReceipt(  # type: ignore[arg-type]
        execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id="f" * 64), None
    )
    assert missing == execution_pb2.GetOfflineExecutionReceiptResponse(found=False)

    found = service.GetOfflineExecutionReceipt(  # type: ignore[arg-type]
        execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id=stored.receipt_id), None
    )
    assert found.found is True
    assert found.receipt.receipt_id == stored.receipt_id
    assert len(found.receipt.DESCRIPTOR.fields) == 48
    assert found.canonical_receipt_json_utf8 == stored.receipt_json.encode("utf-8")
    assert found.canonical_request_json_utf8 == OFFLINE_REQUEST_BYTES
    assert found.canonical_response_json_utf8 == OFFLINE_RESPONSE_BYTES
    assert found.lifecycle_event.schema_version == "openalice_execution_event.v2"
    assert found.lifecycle_event.evidence_receipt_id == stored.receipt_id

    with pytest.raises(_DirectAbort) as invalid:
        service.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id="not-a-receipt"),
            _AbortContext(),  # type: ignore[arg-type]
        )
    assert invalid.value.code == grpc.StatusCode.INVALID_ARGUMENT
    assert invalid.value.detail == "invalid_offline_receipt_id"


@pytest.mark.parametrize(
    "failure",
    (
        CoreAdmissionDenied("offline_receipt_unavailable"),
        CoreAdmissionDenied("offline_receipt_signing_key_unavailable"),
    ),
)
def test_offline_receipt_rpc_never_returns_partial_payload_on_signature_or_key_failure(
    ledger: Ledger, failure: Exception
) -> None:
    stored = _stored_offline_receipt()
    service = DurableAdmissionExecutionService(
        gateway=_ReceiptGateway(configured_core(ledger), failure)
    )
    with pytest.raises(_DirectAbort) as unavailable:
        service.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id=stored.receipt_id),
            _AbortContext(),  # type: ignore[arg-type]
        )
    assert unavailable.value.code == grpc.StatusCode.UNAVAILABLE
    assert unavailable.value.detail == "durable_offline_receipt_unavailable"


def test_offline_receipt_rpc_rejects_a_gateway_result_for_another_receipt(
    ledger: Ledger,
) -> None:
    stored = _stored_offline_receipt()

    class _MisdirectedReceiptGateway(_ReceiptGateway):
        def get_offline_execution_receipt(self, receipt_id: str):
            return self.value

    service = DurableAdmissionExecutionService(
        gateway=_MisdirectedReceiptGateway(configured_core(ledger), stored)
    )
    with pytest.raises(_DirectAbort) as unavailable:
        service.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(receipt_id="f" * 64),
            _AbortContext(),  # type: ignore[arg-type]
        )
    assert unavailable.value.code == grpc.StatusCode.UNAVAILABLE
    assert unavailable.value.detail == "durable_offline_receipt_unavailable"


def test_offline_receipt_rpc_rejects_a_hash_valid_but_receipt_unbound_v2_event(
    ledger: Ledger,
) -> None:
    stored = _stored_offline_receipt()
    lifecycle = dict(stored.lifecycle_event)
    lifecycle["venueOrderId"] = "simulator-order-unbound"
    lifecycle_core = {
        key: value for key, value in lifecycle.items() if key != "eventId"
    }
    lifecycle["eventId"] = sha256_canonical(lifecycle_core)
    stored.lifecycle_event = lifecycle
    stored.lifecycle_event_json = stable_stringify(lifecycle)
    service = DurableAdmissionExecutionService(
        gateway=_ReceiptGateway(configured_core(ledger), stored)
    )

    with pytest.raises(_DirectAbort) as unavailable:
        service.GetOfflineExecutionReceipt(
            execution_pb2.GetOfflineExecutionReceiptRequest(
                receipt_id=stored.receipt_id
            ),
            _AbortContext(),  # type: ignore[arg-type]
        )
    assert unavailable.value.code == grpc.StatusCode.UNAVAILABLE
    assert unavailable.value.detail == "durable_offline_receipt_unavailable"


def test_replay_projection_accepts_v2_events_and_preserves_receipt_evidence() -> None:
    receipt = offline_receipt_fixture()
    event = build_execution_event_v2_from_offline_receipt(receipt)
    stored = SimpleNamespace(
        event_json=stable_stringify(event),
        sequence=int(event["sequence"]),
        event_id=event["eventId"],
        command_hash=event["commandId"],
        kind=event["kind"],
    )
    projected = _validated_event_page(
        [stored],
        after_sequence=stored.sequence - 1,
        max_events=1,
    )
    assert projected[0].sequence == stored.sequence
    assert projected[0].evidence_schema_version == "openalice_offline_execution_receipt.v1"
    assert projected[0].evidence_receipt_id == receipt["receiptId"]


def test_explicit_gateway_routes_all_core_calls_without_exposing_ledger(
    ledger: Ledger,
) -> None:
    core = configured_core(ledger)
    service = DurableAdmissionExecutionService(gateway=_DirectGateway(core))
    request = request_from_fixture(golden_fixture())

    assert service.Handshake(  # type: ignore[arg-type]
        execution_pb2.HandshakeRequest(
            protocol_version="openalice.execution.v1", client_id="runtime-gateway"
        ),
        None,
    ).writer_epoch == 1
    assert service.Health(  # type: ignore[arg-type]
        execution_pb2.HealthRequest(), None
    ).detail == "durable_admission_ready_not_broker_ready"
    accepted = service.Execute(request, None)  # type: ignore[arg-type]
    assert accepted.disposition == execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
    assert service.GetCommand(  # type: ignore[arg-type]
        execution_pb2.GetCommandRequest(command_id=request.command.command_id), None
    ).found is True


def test_service_requires_exactly_one_direct_core_source_or_gateway(ledger: Ledger) -> None:
    core = configured_core(ledger)
    gateway = _DirectGateway(core)
    with pytest.raises(TypeError, match="exactly one"):
        DurableAdmissionExecutionService()
    with pytest.raises(TypeError, match="exactly one"):
        DurableAdmissionExecutionService(core, gateway=gateway)
    with pytest.raises(ValueError, match="zero to two"):
        DurableAdmissionExecutionService(core, max_concurrent_streams=3)


class _DirectAbort(RuntimeError):
    def __init__(self, code: grpc.StatusCode, detail: str) -> None:
        self.code = code
        self.detail = detail
        super().__init__(detail)


class _AbortContext:
    def abort(self, code: grpc.StatusCode, detail: str) -> None:
        raise _DirectAbort(code, detail)


class _FiniteStreamContext(_AbortContext):
    def __init__(self, active_checks: int) -> None:
        self._remaining_checks = active_checks
        self._callback = None

    def is_active(self) -> bool:
        self._remaining_checks -= 1
        return self._remaining_checks >= 0

    def time_remaining(self) -> float:
        return 1.0

    def add_callback(self, callback) -> bool:
        self._callback = callback
        return True


def test_direct_handshake_is_version_bound_and_durable_only(ledger: Ledger) -> None:
    core = configured_core(ledger)
    service = DurableAdmissionExecutionService(core)
    context = _AbortContext()

    with pytest.raises(_DirectAbort) as unsupported:
        service.Handshake(
            execution_pb2.HandshakeRequest(protocol_version="openalice.execution.v0", client_id="test"),
            context,  # type: ignore[arg-type]
        )
    assert unsupported.value.code == grpc.StatusCode.FAILED_PRECONDITION
    assert unsupported.value.detail == "unsupported_protocol_version"

    with pytest.raises(_DirectAbort) as invalid_client:
        service.Handshake(
            execution_pb2.HandshakeRequest(protocol_version="openalice.execution.v1", client_id="bad client"),
            context,  # type: ignore[arg-type]
        )
    assert invalid_client.value.code == grpc.StatusCode.INVALID_ARGUMENT
    assert invalid_client.value.detail == "invalid_client_id"

    response = service.Handshake(
        execution_pb2.HandshakeRequest(protocol_version="openalice.execution.v1", client_id="test.client-1"),
        None,  # type: ignore[arg-type]
    )
    assert response.protocol_version == "openalice.execution.v1"
    assert response.service_id == "openalice.nautilus_paper.durable_admission"
    assert response.mode == execution_pb2.PAPER_MODE_EXCHANGE
    assert response.run_id == RUN_ID
    assert response.environment_proof_hash == core.handshake().environment_proof_hash
    assert response.schema_hash == SCHEMA_HASH
    assert response.writer_epoch == 1

    health = service.Health(execution_pb2.HealthRequest(), None)  # type: ignore[arg-type]
    assert health.status == execution_pb2.SERVICE_STATUS_READY
    assert health.latest_sequence == 0
    assert health.detail == "durable_admission_ready_not_broker_ready"


def test_direct_snapshot_replay_and_stream_project_strict_lifecycle_records(
    ledger: Ledger,
) -> None:
    core = configured_core(ledger)
    service = DurableAdmissionExecutionService(core)
    request = request_from_fixture(golden_fixture())
    accepted = service.Execute(request, None)  # type: ignore[arg-type]
    assert accepted.accepted_sequence == 1
    client_order_id = request.command.payload.client_order_id
    lease = core._writer_lease  # type: ignore[attr-defined]
    lifecycle_cores = [
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:02.000Z",
            "kind": "submitted",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:03.000Z",
            "kind": "partially_filled",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
            "filledQuantity": "0.0001",
            "averagePrice": "65000",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:04.000Z",
            "kind": "filled",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
            "filledQuantity": "0.0005",
            "averagePrice": "65001",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:05.000Z",
            "kind": "canceled",
            "clientOrderId": client_order_id,
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:06.000Z",
            "kind": "rejected",
            "reason": "paper_reject",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:07.000Z",
            "kind": "expired",
            "reason": "paper_expired",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:08.000Z",
            "kind": "submission_unknown",
            "reason": "paper_timeout",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:09.000Z",
            "kind": "reconciled",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:10.000Z",
            "kind": "drift",
            "reason": "paper_drift",
        },
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": request.command.command_id,
            "occurredAt": "2026-08-15T00:00:11.000Z",
            "kind": "suspended",
            "reason": "paper_suspended",
        },
    ]
    for offset, event_core in enumerate(lifecycle_cores, start=2):
        ledger.append_lifecycle_event(
            event_core,
            writer_lease=lease,
            now=NOW.timestamp() + offset,
        )
    snapshot = ledger.upsert_lifecycle_snapshot(
        account_id=request.command.payload.account_id,
        symbol="BTC/USDT",
        snapshot={"positions": [], "说明": "opaque diagnostic only"},
        as_of_sequence=11,
        writer_lease=lease,
        now=NOW.timestamp() + 5,
    )

    replay = service.ReplayEvents(  # type: ignore[arg-type]
        execution_pb2.ReplayEventsRequest(after_sequence=0, limit=1000), None
    )
    assert [event.sequence for event in replay.events] == list(range(1, 12))
    assert [event.kind for event in replay.events] == [
        execution_pb2.EXECUTION_EVENT_KIND_ACKNOWLEDGED,
        execution_pb2.EXECUTION_EVENT_KIND_SUBMITTED,
        execution_pb2.EXECUTION_EVENT_KIND_PARTIALLY_FILLED,
        execution_pb2.EXECUTION_EVENT_KIND_FILLED,
        execution_pb2.EXECUTION_EVENT_KIND_CANCELED,
        execution_pb2.EXECUTION_EVENT_KIND_REJECTED,
        execution_pb2.EXECUTION_EVENT_KIND_EXPIRED,
        execution_pb2.EXECUTION_EVENT_KIND_SUBMISSION_UNKNOWN,
        execution_pb2.EXECUTION_EVENT_KIND_RECONCILED,
        execution_pb2.EXECUTION_EVENT_KIND_DRIFT,
        execution_pb2.EXECUTION_EVENT_KIND_SUSPENDED,
    ]
    assert replay.events[2].filled_quantity == "0.0001"
    assert replay.events[3].average_price == "65001"
    assert all(event.event_id for event in replay.events)

    read_snapshot = service.GetSnapshot(  # type: ignore[arg-type]
        execution_pb2.GetSnapshotRequest(
            account_id=request.command.payload.account_id,
            canonical_symbol="BTC/USDT",
        ),
        None,
    )
    assert read_snapshot.found is True
    assert read_snapshot.as_of_sequence == 11
    assert read_snapshot.snapshot_json_utf8 == snapshot.snapshot_json.encode("utf-8")
    assert b"opaque diagnostic only" in read_snapshot.snapshot_json_utf8

    # The direct form remains one-worker by design, but the implementation is
    # still live: after catch-up it performs another empty poll before the fake
    # context cancels instead of returning EOF immediately.
    stream_context = _FiniteStreamContext(active_checks=10)
    streamed = list(
        service.StreamEvents(
            execution_pb2.StreamEventsRequest(after_sequence=3),
            stream_context,  # type: ignore[arg-type]
        )
    )
    assert [event.sequence for event in streamed] == list(range(4, 12))

    ledger._connection.execute(  # type: ignore[attr-defined]
        """
        UPDATE lifecycle_snapshots SET as_of_sequence = 12
        WHERE account_id = ? AND symbol = 'BTC/USDT'
        """,
        (request.command.payload.account_id,),
    )
    with pytest.raises(_DirectAbort) as ahead_snapshot:
        service.GetSnapshot(
            execution_pb2.GetSnapshotRequest(
                account_id=request.command.payload.account_id,
                canonical_symbol="BTC/USDT",
            ),
            _AbortContext(),  # type: ignore[arg-type]
        )
    assert ahead_snapshot.value.code == grpc.StatusCode.UNAVAILABLE
    assert ahead_snapshot.value.detail == "durable_snapshot_unavailable"


def test_read_rpcs_reject_invalid_scope_limit_and_malformed_storage(
    ledger: Ledger,
) -> None:
    core = configured_core(ledger)
    service = DurableAdmissionExecutionService(core)
    context = _AbortContext()
    request = request_from_fixture(golden_fixture())
    assert service.Execute(request, None).accepted_sequence == 1  # type: ignore[arg-type]

    with pytest.raises(_DirectAbort) as bad_scope:
        service.GetSnapshot(
            execution_pb2.GetSnapshotRequest(
                account_id=" paper-main ", canonical_symbol="BTC/USDT"
            ),
            context,  # type: ignore[arg-type]
        )
    assert bad_scope.value.code == grpc.StatusCode.INVALID_ARGUMENT

    for limit in (0, 1001):
        with pytest.raises(_DirectAbort) as invalid_limit:
            service.ReplayEvents(
                execution_pb2.ReplayEventsRequest(after_sequence=0, limit=limit),
                context,  # type: ignore[arg-type]
            )
        assert invalid_limit.value.code == grpc.StatusCode.INVALID_ARGUMENT

    original = ledger._connection.execute(  # type: ignore[attr-defined]
        "SELECT event_json FROM lifecycle_events WHERE sequence = 1"
    ).fetchone()[0]
    ledger._connection.execute(  # type: ignore[attr-defined]
        "UPDATE lifecycle_events SET event_json = '{}' WHERE sequence = 1"
    )
    with pytest.raises(_DirectAbort) as malformed:
        service.ReplayEvents(
            execution_pb2.ReplayEventsRequest(after_sequence=0, limit=1000),
            context,  # type: ignore[arg-type]
        )
    assert malformed.value.code == grpc.StatusCode.UNAVAILABLE
    assert malformed.value.detail == "durable_event_replay_unavailable"

    ledger._connection.execute(  # type: ignore[attr-defined]
        "UPDATE lifecycle_events SET event_json = ? WHERE sequence = 1", (original,)
    )
    command = golden_fixture()["command"]
    ledger.append_lifecycle_event(
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": command["commandId"],
            "occurredAt": "2026-08-15T00:00:02.000Z",
            "kind": "submitted",
            "clientOrderId": command["payload"]["clientOrderId"],
        },
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp() + 1,
    )
    ledger._connection.execute(  # type: ignore[attr-defined]
        "DELETE FROM lifecycle_events WHERE sequence = 1"
    )
    with pytest.raises(_DirectAbort) as gap:
        service.ReplayEvents(
            execution_pb2.ReplayEventsRequest(after_sequence=0, limit=1000),
            context,  # type: ignore[arg-type]
        )
    assert gap.value.code == grpc.StatusCode.UNAVAILABLE


def test_direct_health_maps_suspension_stale_and_unavailable(ledger: Ledger) -> None:
    suspended_core = configured_core(ledger)
    suspended_core._ledger.suspend(  # type: ignore[attr-defined]
        "operator_stop",
        writer_lease=suspended_core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp(),
    )
    suspended = DurableAdmissionExecutionService(suspended_core).Health(
        execution_pb2.HealthRequest(), None  # type: ignore[arg-type]
    )
    assert suspended.status == execution_pb2.SERVICE_STATUS_SUSPENDED
    assert suspended.circuit_reason == "suspended"
    assert suspended.detail == "durable_admission_suspended_read_only"

    unavailable = DurableAdmissionExecutionService(PaperSidecarCore(ledger, clock=lambda: NOW)).Health(
        execution_pb2.HealthRequest(), None  # type: ignore[arg-type]
    )
    assert unavailable.status == execution_pb2.SERVICE_STATUS_UNAVAILABLE
    assert unavailable.detail == "durable_admission_unavailable"


def test_direct_health_stale_writer_lease_is_unavailable(ledger: Ledger) -> None:
    stale = ledger.acquire_writer_lease(
        name="paper-grpc", owner_id="grpc-a", ttl_seconds=1
    )
    later = NOW + timedelta(seconds=2)
    core = configured_core(ledger, clock=lambda: later, lease=stale)
    ledger._test_fencing_clock[0] = later.timestamp()  # type: ignore[attr-defined]
    ledger.acquire_writer_lease(
        name="paper-grpc", owner_id="grpc-b", ttl_seconds=60
    )

    response = DurableAdmissionExecutionService(core).Health(
        execution_pb2.HealthRequest(), None  # type: ignore[arg-type]
    )
    assert response.status == execution_pb2.SERVICE_STATUS_UNAVAILABLE
    assert response.circuit_reason == "stale_writer_lease"
    assert response.detail == "durable_admission_unavailable"


def test_status_responses_preserve_uint64_boundaries_without_float_conversion() -> None:
    maximum = (1 << 64) - 1
    status = CoreStatus(
        status="ready_for_durable_admission",
        reason=None,
        mode=PAPER_EXCHANGE,
        run_id=RUN_ID,
        environment_proof_hash="b" * 64,
        schema_hash=SCHEMA_HASH,
        writer_epoch=maximum,
        latest_sequence=maximum,
    )
    assert _handshake_response(status).writer_epoch == maximum
    health = _health_response(status)
    assert health.writer_epoch == maximum
    assert health.latest_sequence == maximum


@pytest.mark.parametrize("mutate", ["typed_projection", "noncanonical_permit", "missing_payload_bytes"])
def test_invalid_wire_input_is_rejected_before_ledger_write(
    ledger: Ledger, mutate: str
) -> None:
    service = DurableAdmissionExecutionService(configured_core(ledger))
    request = request_from_fixture(golden_fixture())
    if mutate == "typed_projection":
        request.command.payload.quantity = "0.0006"
    elif mutate == "noncanonical_permit":
        request.permit_json_utf8 = b'{"x": 1}'
    else:
        request.command.canonical_payload_json_utf8 = b""

    response = service.Execute(request, None)  # type: ignore[arg-type]
    assert response.disposition == execution_pb2.EXECUTE_DISPOSITION_REJECTED
    assert response.command_id == request.command.command_id
    assert response.accepted_sequence == 0
    assert ledger.latest_cursor() == 0


def test_suspended_core_maps_only_to_suspended(ledger: Ledger) -> None:
    core = configured_core(ledger)
    core._ledger.suspend(  # type: ignore[attr-defined]
        "test_stop",
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp(),
    )
    response = DurableAdmissionExecutionService(core).Execute(
        request_from_fixture(golden_fixture()), None  # type: ignore[arg-type]
    )
    assert response.disposition == execution_pb2.EXECUTE_DISPOSITION_SUSPENDED
    assert response.reason == "suspended"
    assert response.accepted_sequence == 0


def test_inprocess_local_uds_round_trip_is_durable_only() -> None:
    # macOS limits Unix socket paths to 103 bytes; pytest's normal nested
    # temporary path is longer, so deliberately use a short system temp name.
    with tempfile.TemporaryDirectory(prefix="oa-uds-", dir="/private/tmp") as temporary:
        socket_path = Path(temporary) / "sidecar.sock"
        worker_db_path = Path(temporary) / "worker.sqlite3"
        # The service factory is evaluated by gRPC's sole worker thread, which
        # preserves Ledger's intentional SQLite thread affinity.
        server = build_uds_server(
            lambda: configured_core(
                Ledger(worker_db_path, fencing_clock=lambda: NOW.timestamp())
            ),
            socket_path=socket_path,
        )
        assert server.published_identity is None  # type: ignore[attr-defined]
        assert server.preserves_replaced_public_socket_on_stop is True  # type: ignore[attr-defined]
        server.start()
        assert stat.S_IMODE(os.lstat(socket_path).st_mode) == 0o600
        with pytest.raises(BlockingIOError):
            build_uds_server(
                lambda: configured_core(
                    Ledger(
                        Path(temporary) / "other.sqlite3",
                        fencing_clock=lambda: NOW.timestamp(),
                    )
                ),
                socket_path=socket_path,
            )
        channel = grpc.insecure_channel(f"unix://{socket_path}")
        try:
            published_identity = socket_identity(socket_path)
            assert server.published_identity == published_identity  # type: ignore[attr-defined]
            grpc.channel_ready_future(channel).result(timeout=3)
            stub = execution_pb2_grpc.OpenAliceExecutionServiceStub(channel)
            handshake = stub.Handshake(
                execution_pb2.HandshakeRequest(
                    protocol_version="openalice.execution.v1", client_id="uds-loopback"
                ),
                timeout=3,
            )
            assert handshake.service_id == "openalice.nautilus_paper.durable_admission"
            assert handshake.writer_epoch == 1
            ready = stub.Health(execution_pb2.HealthRequest(), timeout=3)
            assert ready.status == execution_pb2.SERVICE_STATUS_READY
            assert ready.detail == "durable_admission_ready_not_broker_ready"
            with pytest.raises(grpc.RpcError) as mismatch:
                stub.Handshake(
                    execution_pb2.HandshakeRequest(
                        protocol_version="openalice.execution.v0", client_id="uds-loopback"
                    ),
                    timeout=3,
                )
            assert mismatch.value.code() == grpc.StatusCode.FAILED_PRECONDITION
            assert mismatch.value.details() == "unsupported_protocol_version"
            wire_request = request_from_fixture(golden_fixture())
            response = stub.Execute(wire_request, timeout=3)
            assert response.disposition == execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
            assert response.accepted_sequence == 1
            assert response.reason == "accepted_durable_not_submitted"
            read = stub.GetCommand(
                execution_pb2.GetCommandRequest(command_id=wire_request.command.command_id),
                timeout=3,
            )
            assert read.found is True
            assert read.command == wire_request.command
            assert read.permit_json_utf8 == wire_request.permit_json_utf8
            assert read.accepted_sequence == 1
        finally:
            channel.close()
            server.stop(0).wait(timeout=3)
        assert not socket_path.exists()
        assert server.published_identity is None  # type: ignore[attr-defined]
        with Ledger(worker_db_path) as persisted:
            assert persisted.latest_cursor() == 1


def test_uds_builder_and_failed_publication_preserve_prebound_victim() -> None:
    with tempfile.TemporaryDirectory(prefix="oa-uds-", dir="/private/tmp") as temporary:
        directory = Path(temporary)
        victim_path = directory / "victim.sock"
        victim = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        victim.bind(str(victim_path))
        victim.listen(5)
        try:
            victim_identity = socket_identity(victim_path)
            assert_uds_reachable(victim_path)
            server = build_uds_server(
                lambda: configured_core(
                    Ledger(
                        directory / "worker.sqlite3",
                        fencing_clock=lambda: NOW.timestamp(),
                    )
                ),
                socket_path=victim_path,
            )
            # Construction configures only a random sibling staging name; it
            # must never expose gRPC's unlink-on-bind behavior at public path.
            assert socket_identity(victim_path) == victim_identity
            assert_uds_reachable(victim_path)
            with pytest.raises(FileExistsError):
                server.start()
            assert socket_identity(victim_path) == victim_identity
            assert_uds_reachable(victim_path)
            assert not list(directory.glob(".victim.sock.grpc-staging-*"))
        finally:
            victim.close()
            victim_path.unlink(missing_ok=True)


def test_uds_stop_preserves_a_replacement_public_socket() -> None:
    with tempfile.TemporaryDirectory(prefix="oa-uds-", dir="/private/tmp") as temporary:
        directory = Path(temporary)
        socket_path = directory / "sidecar.sock"
        server = build_uds_server(
            lambda: configured_core(
                Ledger(
                    directory / "worker.sqlite3",
                    fencing_clock=lambda: NOW.timestamp(),
                )
            ),
            socket_path=socket_path,
        )
        server.start()
        published_identity = socket_identity(socket_path)
        os.unlink(socket_path)
        replacement = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        replacement.bind(str(socket_path))
        replacement.listen(1)
        try:
            replacement_identity = socket_identity(socket_path)
            assert replacement_identity != published_identity
            server.stop(0).wait(timeout=3)
            assert socket_identity(socket_path) == replacement_identity
            assert_uds_reachable(socket_path)
            assert server.published_identity is None  # type: ignore[attr-defined]
        finally:
            replacement.close()
            socket_path.unlink(missing_ok=True)


def test_uds_server_rejects_nonlocal_or_invalid_configuration(ledger: Ledger, tmp_path: Path) -> None:
    core = configured_core(ledger)
    gateway = _DirectGateway(core)
    with pytest.raises(ValueError):
        build_uds_server(core, socket_path="relative.sock")
    with pytest.raises(ValueError):
        build_uds_server(core, socket_path=tmp_path / "socket", max_workers=0)
    with pytest.raises(ValueError):
        build_uds_server(core, socket_path=tmp_path / "socket", max_workers=2)
    with pytest.raises(ValueError):
        build_uds_server(
            gateway=gateway, socket_path=tmp_path / "socket", max_workers=1
        )
    with pytest.raises(ValueError):
        build_uds_server(
            gateway=gateway, socket_path=tmp_path / "socket", max_workers=5
        )
    with pytest.raises(ValueError, match="owner_private"):
        build_uds_server(
            core,
            socket_path=Path("/private/tmp/openalice-direct-public.sock"),
        )


def test_unstarted_builder_close_releases_publication_lock(ledger: Ledger) -> None:
    core = configured_core(ledger)
    with tempfile.TemporaryDirectory(prefix="oa-uds-", dir="/private/tmp") as temporary:
        socket_path = Path(temporary) / "unstarted.sock"
        held = build_uds_server(core, socket_path=socket_path)
        with pytest.raises(BlockingIOError):
            build_uds_server(core, socket_path=socket_path)
        held.close()

        replacement = build_uds_server(core, socket_path=socket_path)
        replacement.close()
