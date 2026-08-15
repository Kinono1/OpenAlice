"""Durable-only local UDS gRPC adapter for ``PaperSidecarCore``.

This adapter is deliberately a narrow wire boundary: ``Execute`` reconstructs
and checks the protobuf projection, then calls the existing durable admission
core.  It neither owns a process loop nor imports Nautilus, credentials, a
broker SDK, or any network client.  Starting a server is an explicit caller
action, and tests use only a temporary Unix-domain socket.
"""

from __future__ import annotations

from collections.abc import Mapping
from concurrent import futures
import fcntl
import json
import math
import os
from pathlib import Path
import secrets
import stat
from threading import BoundedSemaphore, Lock, get_ident
from threading import Event, Thread
from typing import Any, Callable, Protocol

import grpc

from .contract import (
    ContractValidationError,
    stable_stringify,
    validate_execution_command_v1,
    validate_execution_event,
)
from .core import (
    CoreAdmissionDenied,
    CoreStatus,
    DurableAdmissionDecision,
    PaperSidecarCore,
)
from .generated import openalice_execution_v1_pb2 as execution_pb2
from .generated import openalice_execution_v1_pb2_grpc as execution_pb2_grpc
from .offline_receipt import (
    execution_event_v2_matches_offline_receipt,
    validate_offline_execution_receipt_v1,
)


_MODE = {
    execution_pb2.PAPER_MODE_LOCAL: "PAPER_LOCAL",
    execution_pb2.PAPER_MODE_EXCHANGE: "PAPER_EXCHANGE",
}
_VENUE = {execution_pb2.VENUE_OKX: "OKX"}
_KIND = {
    execution_pb2.COMMAND_KIND_SUBMIT: "submit",
    execution_pb2.COMMAND_KIND_CANCEL: "cancel",
    execution_pb2.COMMAND_KIND_REPLACE: "replace",
    execution_pb2.COMMAND_KIND_RECONCILE: "reconcile",
    execution_pb2.COMMAND_KIND_SUSPEND: "suspend",
}
_SIDE = {
    execution_pb2.ORDER_SIDE_BUY: "buy",
    execution_pb2.ORDER_SIDE_SELL: "sell",
}
_ORDER_TYPE = {execution_pb2.ORDER_TYPE_LIMIT: "limit"}
_TIME_IN_FORCE = {
    execution_pb2.TIME_IN_FORCE_GTC: "GTC",
    execution_pb2.TIME_IN_FORCE_IOC: "IOC",
    execution_pb2.TIME_IN_FORCE_FOK: "FOK",
}
_MODE_PROTO = {value: key for key, value in _MODE.items()}
_VENUE_PROTO = {value: key for key, value in _VENUE.items()}
_KIND_PROTO = {value: key for key, value in _KIND.items()}
_SIDE_PROTO = {value: key for key, value in _SIDE.items()}
_ORDER_TYPE_PROTO = {value: key for key, value in _ORDER_TYPE.items()}
_TIME_IN_FORCE_PROTO = {value: key for key, value in _TIME_IN_FORCE.items()}
_EVENT_KIND_PROTO = {
    "acknowledged": execution_pb2.EXECUTION_EVENT_KIND_ACKNOWLEDGED,
    "submitted": execution_pb2.EXECUTION_EVENT_KIND_SUBMITTED,
    "partially_filled": execution_pb2.EXECUTION_EVENT_KIND_PARTIALLY_FILLED,
    "filled": execution_pb2.EXECUTION_EVENT_KIND_FILLED,
    "canceled": execution_pb2.EXECUTION_EVENT_KIND_CANCELED,
    "rejected": execution_pb2.EXECUTION_EVENT_KIND_REJECTED,
    "expired": execution_pb2.EXECUTION_EVENT_KIND_EXPIRED,
    "submission_unknown": execution_pb2.EXECUTION_EVENT_KIND_SUBMISSION_UNKNOWN,
    "reconciled": execution_pb2.EXECUTION_EVENT_KIND_RECONCILED,
    "drift": execution_pb2.EXECUTION_EVENT_KIND_DRIFT,
    "suspended": execution_pb2.EXECUTION_EVENT_KIND_SUSPENDED,
}
_PROTOCOL_VERSION = "openalice.execution.v1"
_MAX_CLIENT_ID_LENGTH = 128
_MAX_UINT64 = (1 << 64) - 1
_MAX_REPLAY_LIMIT = 1_000
_MAX_CONCURRENT_STREAMS = 2
_STREAM_POLL_SECONDS = 0.05
# macOS allows 104 bytes including the trailing NUL.  Keep one byte below the
# pathname portion limit so the same explicitly local contract is portable to
# the sidecar's supported macOS runner.  The staged name is validated too.
_MAX_UDS_PATH_BYTES = 103
_STAGING_ATTEMPTS = 32
_PUBLICATION_LOCK_SUFFIX = ".publication.lock"


def _is_valid_client_id(client_id: str) -> bool:
    """Require a bounded, printable client identifier for local audit scope."""
    if not client_id or client_id != client_id.strip() or len(client_id) > _MAX_CLIENT_ID_LENGTH:
        return False
    return all(character.isascii() and (character.isalnum() or character in "._:-") for character in client_id)


def _paper_mode_to_proto(mode: str | None) -> int:
    return _MODE_PROTO.get(mode or "", execution_pb2.PAPER_MODE_UNSPECIFIED)


def _service_status_to_proto(status: CoreStatus) -> int:
    if status.status == "ready_for_durable_admission":
        return execution_pb2.SERVICE_STATUS_READY
    if status.status == "suspended/read_only":
        return execution_pb2.SERVICE_STATUS_SUSPENDED
    if status.status in {"read_only", "deny"}:
        return execution_pb2.SERVICE_STATUS_READ_ONLY
    return execution_pb2.SERVICE_STATUS_UNAVAILABLE


def _health_detail(status: CoreStatus) -> str:
    """Keep health text stable and never surface provider or exception text."""
    if status.status == "ready_for_durable_admission":
        return "durable_admission_ready_not_broker_ready"
    if status.status == "suspended/read_only":
        return "durable_admission_suspended_read_only"
    if status.status in {"read_only", "deny"}:
        return "durable_admission_read_only"
    return "durable_admission_unavailable"


def _handshake_response(status: CoreStatus) -> execution_pb2.HandshakeResponse:
    return execution_pb2.HandshakeResponse(
        protocol_version=status.protocol_version,
        service_id=status.service_id,
        mode=_paper_mode_to_proto(status.mode),
        run_id=status.run_id or "",
        environment_proof_hash=status.environment_proof_hash or "",
        schema_hash=status.schema_hash or "",
        writer_epoch=status.writer_epoch,
    )


def _health_response(status: CoreStatus) -> execution_pb2.HealthResponse:
    return execution_pb2.HealthResponse(
        status=_service_status_to_proto(status),
        mode=_paper_mode_to_proto(status.mode),
        run_id=status.run_id or "",
        writer_epoch=status.writer_epoch,
        latest_sequence=status.latest_sequence,
        circuit_reason=status.reason or "",
        environment_proof_hash=status.environment_proof_hash or "",
        schema_hash=status.schema_hash or "",
        detail=_health_detail(status),
    )


def _enum_value(table: Mapping[int, str], value: int) -> str | None:
    """Map only a defined non-unspecified protobuf enum to its contract value."""
    return table.get(value)


def execution_command_from_proto(command: execution_pb2.ExecutionCommand) -> dict[str, Any]:
    """Reconstruct the exact JSON command projection represented by protobuf.

    Proto3 scalar fields lack presence bits.  The contract disallows empty or
    unspecified required fields, so a missing value reconstructs to an invalid
    projection and is rejected before durable admission.  Optional fields are
    included only in the command kind that defines them.
    """
    payload_message = command.payload
    kind = _enum_value(_KIND, payload_message.kind)
    payload: dict[str, Any] = {
        "schemaVersion": payload_message.schema_version,
        "kind": kind,
        "accountId": payload_message.account_id,
        "canonicalSymbol": payload_message.canonical_symbol,
        "venue": _enum_value(_VENUE, payload_message.venue),
        "venueInstrumentId": payload_message.venue_instrument_id,
        "idempotencyKey": payload_message.idempotency_key,
        "mode": _enum_value(_MODE, payload_message.mode),
    }
    if kind == "submit":
        payload.update({
            "clientOrderId": payload_message.client_order_id,
            "side": _enum_value(_SIDE, payload_message.side),
            "orderType": _enum_value(_ORDER_TYPE, payload_message.order_type),
            "quantity": payload_message.quantity,
            "price": payload_message.price,
            "timeInForce": _enum_value(_TIME_IN_FORCE, payload_message.time_in_force),
            "reduceOnly": payload_message.reduce_only,
            "maxNotionalUsd": payload_message.max_notional_usd,
        })
    elif kind == "cancel":
        payload["targetClientOrderId"] = payload_message.target_client_order_id
    elif kind == "replace":
        payload.update({
            "targetClientOrderId": payload_message.target_client_order_id,
            "replacementClientOrderId": payload_message.replacement_client_order_id,
            "quantity": payload_message.quantity,
            "price": payload_message.price,
            "timeInForce": _enum_value(_TIME_IN_FORCE, payload_message.time_in_force),
            "maxNotionalUsd": payload_message.max_notional_usd,
        })
    elif kind == "reconcile":
        if payload_message.after_sequence:
            payload["afterSequence"] = str(payload_message.after_sequence)
    elif kind == "suspend":
        payload["reason"] = payload_message.reason

    return {
        "schemaVersion": command.schema_version,
        "commandId": command.command_id,
        "payloadHash": command.payload_hash,
        "payload": payload,
    }


def _disposition_for_denial(reason: str) -> int:
    """Do not expose a sidecar-side error as durable acceptance.

    Only an actual durable admission reaches ACCEPTED or DUPLICATE.  A known
    ledger suspension maps to SUSPENDED; conditions where retrying after local
    recovery could be meaningful map to UNAVAILABLE; all malformed, unsigned,
    unauthorised, or out-of-scope requests map to REJECTED.
    """
    if reason == "suspended":
        return execution_pb2.EXECUTE_DISPOSITION_SUSPENDED
    if reason in {
        "writer_lease_unbound",
        "stale_writer_lease",
        "runtime_write_disarmed",
        "runtime_draining",
        "runtime_operation_timeout",
        "runtime_submission_unknown",
        "environment_unavailable",
        "invalid_now",
    }:
        return execution_pb2.EXECUTE_DISPOSITION_UNAVAILABLE
    return execution_pb2.EXECUTE_DISPOSITION_REJECTED


CoreSource = PaperSidecarCore | Callable[[], PaperSidecarCore]


class DurableAdmissionCoreGateway(Protocol):
    """Thread-safe gateway onto one owner-thread ``PaperSidecarCore``.

    The gRPC worker may call this protocol, but the implementation must route
    every operation to the thread which owns the SQLite ledger.  The managed
    runtime implements this boundary without giving the wire adapter direct
    access to its ledger or writer lease.
    """

    def handshake(self) -> CoreStatus: ...

    def health(self) -> CoreStatus: ...

    def admit(
        self,
        *,
        command: Mapping[str, Any],
        permit: Mapping[str, Any],
        command_payload_bytes: bytes,
        permit_bytes: bytes,
        operation_timeout_seconds: float | None = None,
    ) -> DurableAdmissionDecision: ...

    def get_command(self, command_id: str) -> Any: ...

    def get_offline_execution_receipt(self, receipt_id: str) -> Any: ...

    def get_snapshot(self, *, account_id: str, symbol: str) -> Any: ...

    def replay_lifecycle_events(
        self, *, after_sequence: int = 0, limit: int = 1_000
    ) -> Any: ...


class _CoreThreadUnavailable(RuntimeError):
    """A SQLite-bound core was asked to cross a gRPC worker-thread boundary."""


class DurableAdmissionExecutionService(execution_pb2_grpc.OpenAliceExecutionServiceServicer):
    """gRPC receiver whose sole write effect is ``PaperSidecarCore.admit``."""

    def __init__(
        self,
        core: CoreSource | None = None,
        *,
        gateway: DurableAdmissionCoreGateway | None = None,
        max_concurrent_streams: int = _MAX_CONCURRENT_STREAMS,
    ) -> None:
        """Accept one direct core source or an owner-thread runtime gateway.

        ``Ledger`` deliberately uses a thread-affine SQLite connection.  The
        explicit factory form lets the UDS worker construct that core in its
        own one-worker executor; an already-created core is instead fail-closed
        if a later request attempts to use it from a different thread.  The
        gateway form is reserved for the managed runtime, which serializes all
        calls on a separate owner thread and performs lease renewal there.
        """
        if (core is None) == (gateway is None):
            raise TypeError("exactly one of core or gateway is required")
        if (
            type(max_concurrent_streams) is not int
            or not 0 <= max_concurrent_streams <= _MAX_CONCURRENT_STREAMS
        ):
            raise ValueError("max_concurrent_streams must be an integer from zero to two")
        self._gateway = gateway
        if gateway is not None:
            required = (
                "handshake",
                "health",
                "admit",
                "get_command",
                "get_offline_execution_receipt",
                "get_snapshot",
                "replay_lifecycle_events",
            )
            if any(not callable(getattr(gateway, name, None)) for name in required):
                raise TypeError("gateway does not implement the durable admission contract")
            self._core = None
            self._core_factory = None
            self._core_thread_id = None
        elif isinstance(core, PaperSidecarCore):
            self._core: PaperSidecarCore | None = core
            self._core_factory: Callable[[], PaperSidecarCore] | None = None
            self._core_thread_id: int | None = get_ident()
        elif callable(core):
            self._core = None
            self._core_factory = core
            self._core_thread_id = None
        else:
            raise TypeError("core must be a PaperSidecarCore or zero-argument factory")
        self._core_lock = Lock()
        self._stream_slots = BoundedSemaphore(max_concurrent_streams)

    def _invoke(self, method: str, *args: Any, **kwargs: Any) -> Any:
        if self._gateway is not None:
            return getattr(self._gateway, method)(*args, **kwargs)
        return getattr(self._current_core(), method)(*args, **kwargs)

    def _current_core(self) -> PaperSidecarCore:
        with self._core_lock:
            current_thread_id = get_ident()
            if self._core is None:
                assert self._core_factory is not None
                created = self._core_factory()
                if not isinstance(created, PaperSidecarCore):
                    raise _CoreThreadUnavailable("core_factory_returned_invalid_core")
                self._core = created
                self._core_thread_id = current_thread_id
            if self._core_thread_id != current_thread_id:
                raise _CoreThreadUnavailable("core_thread_affinity_violation")
            return self._core

    def Handshake(
        self,
        request: execution_pb2.HandshakeRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.HandshakeResponse:
        """Negotiate exactly one durable-only protocol version.

        Handshake performs no lease renewal, no environment discovery, and no
        execution action.  A response describes only core-verified durable
        admission identity; it never indicates broker readiness.
        """
        if request.protocol_version != _PROTOCOL_VERSION:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, "unsupported_protocol_version")
            raise AssertionError("grpc context.abort returned unexpectedly")
        if not _is_valid_client_id(request.client_id):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid_client_id")
            raise AssertionError("grpc context.abort returned unexpectedly")
        try:
            return _handshake_response(self._invoke("handshake"))
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_status_unavailable")
        raise AssertionError("grpc context.abort returned unexpectedly")

    def Health(
        self,
        request: execution_pb2.HealthRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.HealthResponse:
        """Expose durable admission health, explicitly not broker health."""
        del request
        try:
            return _health_response(self._invoke("health"))
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_status_unavailable")
        raise AssertionError("grpc context.abort returned unexpectedly")

    def Execute(
        self,
        request: execution_pb2.ExecuteRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.ExecuteResponse:
        command_id = request.command.command_id
        try:
            command = execution_command_from_proto(request.command)
            # Validate the typed projection before it is compared with the raw
            # canonical bytes inside the core.  This makes an enum/default
            # projection failure deterministic and prevents any ledger write.
            validate_execution_command_v1(command)
            admission_kwargs: dict[str, Any] = {
                "command": command,
                "permit": _strict_json_object(
                    request.permit_json_utf8, "permit_json_utf8"
                ),
                "command_payload_bytes": bytes(
                    request.command.canonical_payload_json_utf8
                ),
                "permit_bytes": bytes(request.permit_json_utf8),
            }
            if self._gateway is not None and context is not None:
                try:
                    remaining = context.time_remaining()
                except Exception:
                    remaining = None
                if (
                    isinstance(remaining, (int, float))
                    and not isinstance(remaining, bool)
                    and math.isfinite(remaining)
                ):
                    admission_kwargs["operation_timeout_seconds"] = max(
                        float(remaining), 0.001
                    )
            decision = self._invoke(
                "admit",
                **admission_kwargs,
            )
        except CoreAdmissionDenied as error:
            return execution_pb2.ExecuteResponse(
                command_id=command_id,
                disposition=_disposition_for_denial(error.reason),
                reason=error.reason,
            )
        except (ContractValidationError, TypeError, ValueError, UnicodeError) as error:
            return execution_pb2.ExecuteResponse(
                command_id=command_id,
                disposition=execution_pb2.EXECUTE_DISPOSITION_REJECTED,
                reason=_safe_contract_reason(error),
            )
        except _CoreThreadUnavailable as error:
            return execution_pb2.ExecuteResponse(
                command_id=command_id,
                disposition=execution_pb2.EXECUTE_DISPOSITION_UNAVAILABLE,
                reason=str(error),
            )
        except Exception:
            # No partial gRPC error can be interpreted as an execution result.
            # The core either committed its single SQLite transition or raised;
            # callers must query by command ID after this unavailable response.
            return execution_pb2.ExecuteResponse(
                command_id=command_id,
                disposition=execution_pb2.EXECUTE_DISPOSITION_UNAVAILABLE,
                reason="durable_admission_unavailable",
            )

        return execution_pb2.ExecuteResponse(
            command_id=decision.receipt.command.command_hash,
            disposition=(
                execution_pb2.EXECUTE_DISPOSITION_ACCEPTED
                if decision.disposition == "accepted_durable_not_submitted"
                else execution_pb2.EXECUTE_DISPOSITION_DUPLICATE
            ),
            reason=decision.disposition,
            accepted_sequence=decision.receipt.accepted_lifecycle_event.sequence,
        )

    def GetCommand(
        self,
        request: execution_pb2.GetCommandRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.GetCommandResponse:
        """Read one durable command; absence never implies broker failure."""
        command_id = request.command_id
        if (
            len(command_id) != 64
            or any(character not in "0123456789abcdef" for character in command_id)
        ):
            return execution_pb2.GetCommandResponse(found=False)
        try:
            stored = self._invoke("get_command", command_id)
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_read_unavailable")
        if stored is None:
            return execution_pb2.GetCommandResponse(found=False)
        return execution_pb2.GetCommandResponse(
            found=True,
            command=execution_command_to_proto(stored.command),
            permit_json_utf8=stored.permit_json.encode("utf-8"),
            disposition=execution_pb2.EXECUTE_DISPOSITION_ACCEPTED,
            accepted_sequence=stored.accepted_sequence,
        )

    def GetOfflineExecutionReceipt(
        self,
        request: execution_pb2.GetOfflineExecutionReceiptRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.GetOfflineExecutionReceiptResponse:
        """Return only a fully verified simulator-only receipt and its evidence.

        A syntactically valid but absent id is the sole ``found=False`` case.
        Signature, stored-row, canonical-byte, typed-projection, and V2
        lifecycle-binder failures are service-unavailable and never expose a
        partial evidence payload.
        """
        if not _is_sha256_hex(request.receipt_id):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid_offline_receipt_id")
            raise AssertionError("grpc context.abort returned unexpectedly")
        try:
            stored = self._invoke("get_offline_execution_receipt", request.receipt_id)
            if stored is None:
                return execution_pb2.GetOfflineExecutionReceiptResponse(found=False)
            if getattr(stored, "receipt_id", None) != request.receipt_id:
                raise ValueError("verified receipt does not match the requested identity")
            return _offline_execution_receipt_to_proto(stored)
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_offline_receipt_unavailable")
        raise AssertionError("grpc context.abort returned unexpectedly")

    def GetSnapshot(
        self,
        request: execution_pb2.GetSnapshotRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.GetSnapshotResponse:
        """Return opaque canonical diagnostics from the lifecycle snapshot table."""
        if not _valid_read_scope(request.account_id, request.canonical_symbol):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid_snapshot_scope")
            raise AssertionError("grpc context.abort returned unexpectedly")
        try:
            snapshot = self._invoke(
                "get_snapshot",
                account_id=request.account_id,
                symbol=request.canonical_symbol,
            )
            if snapshot is None:
                return execution_pb2.GetSnapshotResponse(found=False)
            if (
                getattr(snapshot, "account_id", None) != request.account_id
                or getattr(snapshot, "symbol", None) != request.canonical_symbol
            ):
                raise ValueError("stored snapshot scope mismatch")
            raw = snapshot.snapshot_json.encode("utf-8", errors="strict")
            _validate_canonical_json_bytes(raw, label="stored_snapshot")
            if not _valid_uint64(snapshot.as_of_sequence):
                raise ValueError("invalid stored snapshot sequence")
            return execution_pb2.GetSnapshotResponse(
                found=True,
                as_of_sequence=snapshot.as_of_sequence,
                snapshot_json_utf8=raw,
            )
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_snapshot_unavailable")
        raise AssertionError("grpc context.abort returned unexpectedly")

    def ReplayEvents(
        self,
        request: execution_pb2.ReplayEventsRequest,
        context: grpc.ServicerContext,
    ) -> execution_pb2.ReplayEventsResponse:
        """Replay one bounded, gap-free lifecycle page after a uint64 sequence.

        Hash validity and sequence continuity do not establish broker source
        authenticity; this raw read RPC never declares an idempotency terminal.
        """
        if not _valid_uint64(request.after_sequence) or not (
            type(request.limit) is int and 1 <= request.limit <= _MAX_REPLAY_LIMIT
        ):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid_replay_request")
            raise AssertionError("grpc context.abort returned unexpectedly")
        try:
            events = self._invoke(
                "replay_lifecycle_events",
                after_sequence=request.after_sequence,
                limit=request.limit,
            )
            projected = _validated_event_page(
                events,
                after_sequence=request.after_sequence,
                max_events=request.limit,
            )
            return execution_pb2.ReplayEventsResponse(events=projected)
        except _CoreThreadUnavailable:
            context.abort(grpc.StatusCode.UNAVAILABLE, "core_thread_affinity_violation")
        except Exception:
            context.abort(grpc.StatusCode.UNAVAILABLE, "durable_event_replay_unavailable")
        raise AssertionError("grpc context.abort returned unexpectedly")

    def StreamEvents(
        self,
        request: execution_pb2.StreamEventsRequest,
        context: grpc.ServicerContext,
    ):
        """Catch up, then bounded-poll until cancellation or deadline.

        At most two streams may occupy the runtime's four gRPC workers, leaving
        at least two workers for Health and Execute.  Direct-core servers remain
        deliberately single-worker and therefore are intended only for focused
        local tests, not managed live streaming.
        """
        if not _valid_uint64(request.after_sequence):
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid_stream_request")
            return
        if not self._stream_slots.acquire(blocking=False):
            context.abort(grpc.StatusCode.RESOURCE_EXHAUSTED, "stream_limit_reached")
            return
        wake = Event()
        try:
            try:
                context.add_callback(wake.set)
            except Exception:
                pass
            cursor = request.after_sequence
            while _context_is_active(context):
                try:
                    events = self._invoke(
                        "replay_lifecycle_events",
                        after_sequence=cursor,
                        limit=_MAX_REPLAY_LIMIT,
                    )
                    projected = _validated_event_page(
                        events,
                        after_sequence=cursor,
                        max_events=_MAX_REPLAY_LIMIT,
                    )
                except _CoreThreadUnavailable:
                    context.abort(
                        grpc.StatusCode.UNAVAILABLE,
                        "core_thread_affinity_violation",
                    )
                    return
                except Exception:
                    context.abort(
                        grpc.StatusCode.UNAVAILABLE,
                        "durable_event_stream_unavailable",
                    )
                    return
                for event in projected:
                    if not _context_is_active(context):
                        return
                    cursor = event.sequence
                    yield event
                if len(projected) == _MAX_REPLAY_LIMIT:
                    continue
                wake.wait(_stream_wait_seconds(context))
                wake.clear()
            # Returning normally at the exact deadline races gRPC's own
            # cancellation publication and can present a clean EOF to the
            # client. Preserve the RPC contract by publishing the terminal
            # deadline status explicitly; ordinary client cancellation still
            # returns without manufacturing an error.
            if _context_deadline_expired(context):
                context.abort(
                    grpc.StatusCode.DEADLINE_EXCEEDED,
                    "stream_deadline_exceeded",
                )
        finally:
            self._stream_slots.release()


def _valid_uint64(value: Any) -> bool:
    return type(value) is int and 0 <= value <= _MAX_UINT64


def _is_sha256_hex(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _valid_read_scope(account_id: Any, canonical_symbol: Any) -> bool:
    return (
        isinstance(account_id, str)
        and bool(account_id)
        and account_id == account_id.strip()
        and len(account_id) <= 200
        and canonical_symbol == "BTC/USDT"
    )


def _validate_canonical_json_bytes(raw: bytes, *, label: str) -> Any:
    try:
        decoded = json.loads(raw.decode("utf-8", errors="strict"))
        canonical = stable_stringify(decoded).encode("utf-8")
    except (UnicodeDecodeError, json.JSONDecodeError, ContractValidationError, TypeError):
        raise ValueError(f"{label}_malformed") from None
    if canonical != raw:
        raise ValueError(f"{label}_not_canonical")
    return decoded


def _validated_event_page(
    events: Any, *, after_sequence: int, max_events: int
) -> list[Any]:
    """Revalidate stored hash-bound JSON and reject every gap or projection drift."""
    if not isinstance(events, (list, tuple)):
        raise ValueError("stored lifecycle page must be a sequence")
    if len(events) > max_events:
        raise ValueError("stored lifecycle page exceeds the requested bound")
    expected = after_sequence + 1
    projected: list[Any] = []
    for stored in events:
        raw_text = getattr(stored, "event_json", None)
        if not isinstance(raw_text, str):
            raise ValueError("stored lifecycle event JSON is missing")
        raw = raw_text.encode("utf-8", errors="strict")
        decoded = _validate_canonical_json_bytes(raw, label="stored_lifecycle_event")
        parsed = validate_execution_event(decoded)
        if (
            parsed["sequence"] != str(expected)
            or getattr(stored, "sequence", None) != expected
            or getattr(stored, "event_id", None) != parsed["eventId"]
            or getattr(stored, "command_hash", None) != parsed["commandId"]
            or getattr(stored, "kind", None) != parsed["kind"]
        ):
            raise ValueError("stored lifecycle event gap or projection mismatch")
        kind = _EVENT_KIND_PROTO.get(parsed["kind"])
        if kind is None:
            raise ValueError("stored lifecycle event kind is unsupported")
        projected.append(
            execution_pb2.ExecutionEvent(
                schema_version=parsed["schemaVersion"],
                event_id=parsed["eventId"],
                command_id=parsed["commandId"],
                sequence=expected,
                occurred_at=parsed["occurredAt"],
                kind=kind,
                client_order_id=parsed.get("clientOrderId", ""),
                venue_order_id=parsed.get("venueOrderId", ""),
                filled_quantity=parsed.get("filledQuantity", ""),
                average_price=parsed.get("averagePrice", ""),
                reason=parsed.get("reason", ""),
                evidence_schema_version=parsed.get("evidenceSchemaVersion", ""),
                evidence_receipt_id=parsed.get("evidenceReceiptId", ""),
            )
        )
        expected += 1
    return projected


def _offline_execution_receipt_to_proto(stored: Any) -> execution_pb2.GetOfflineExecutionReceiptResponse:
    """Project one ledger-verified receipt without weakening its bindings."""
    receipt_raw = getattr(stored, "receipt_json", None)
    request_raw = getattr(stored, "canonical_request_json", None)
    response_raw = getattr(stored, "canonical_response_json", None)
    lifecycle_raw = getattr(stored, "lifecycle_event_json", None)
    if not all(isinstance(value, str) for value in (receipt_raw, request_raw, response_raw, lifecycle_raw)):
        raise ValueError("stored offline receipt evidence is missing")
    receipt_bytes = receipt_raw.encode("utf-8", errors="strict")
    request_bytes = request_raw.encode("utf-8", errors="strict")
    response_bytes = response_raw.encode("utf-8", errors="strict")
    lifecycle_bytes = lifecycle_raw.encode("utf-8", errors="strict")
    receipt = validate_offline_execution_receipt_v1(json.loads(receipt_raw))
    if stable_stringify(receipt).encode("utf-8") != receipt_bytes:
        raise ValueError("stored offline receipt is non-canonical")
    # These checks deliberately happen again at the wire boundary.  The core
    # has already asked Ledger to signature-verify the receipt with its frozen
    # public key; the receiver additionally refuses any stale/malformed typed
    # projection or a V2 evidence binder detached from that receipt.
    _strict_json_object(request_bytes, "stored_offline_receipt_request")
    _strict_json_object(response_bytes, "stored_offline_receipt_response")
    lifecycle = validate_execution_event(json.loads(lifecycle_raw))
    if stable_stringify(lifecycle).encode("utf-8") != lifecycle_bytes:
        raise ValueError("stored offline receipt lifecycle event is non-canonical")
    if (
        receipt["receiptId"] != getattr(stored, "receipt_id", None)
        or receipt["lifecycleSequence"] != str(getattr(stored, "lifecycle_sequence", None))
        or lifecycle["eventId"] != getattr(stored, "lifecycle_event", {}).get("eventId")
        or lifecycle["commandId"] != receipt["commandId"]
        or lifecycle["sequence"] != receipt["lifecycleSequence"]
        or lifecycle["kind"] != receipt["lifecycleKind"]
        or lifecycle.get("evidenceSchemaVersion")
        != "openalice_offline_execution_receipt.v1"
        or lifecycle.get("evidenceReceiptId") != receipt["receiptId"]
        or not execution_event_v2_matches_offline_receipt(receipt, lifecycle)
    ):
        raise ValueError("stored offline receipt lifecycle binding mismatch")
    receipt_id = receipt["receiptId"]
    if not _is_sha256_hex(receipt_id):
        raise ValueError("stored offline receipt id is invalid")
    kind = _EVENT_KIND_PROTO.get(receipt["lifecycleKind"])
    if kind is None:
        raise ValueError("stored offline receipt lifecycle kind is unsupported")
    try:
        projected_receipt = execution_pb2.OfflineExecutionReceipt(
            schema_version=receipt["schemaVersion"],
            scope=receipt["scope"],
            command_id=receipt["commandId"],
            payload_hash=receipt["payloadHash"],
            permit_v2_id=receipt["permitV2Id"],
            permit_key_id=receipt["permitKeyId"],
            accepted_sequence=int(receipt["acceptedSequence"]),
            lifecycle_sequence=int(receipt["lifecycleSequence"]),
            lifecycle_kind=kind,
            idempotency_key=receipt["idempotencyKey"],
            account_id=receipt["accountId"],
            canonical_symbol=receipt["canonicalSymbol"],
            venue=_VENUE_PROTO[receipt["venue"]],
            venue_instrument_id=receipt["venueInstrumentId"],
            mode=_MODE_PROTO[receipt["mode"]],
            client_order_id=receipt["clientOrderId"],
            side=_SIDE_PROTO[receipt["side"]],
            order_type=_ORDER_TYPE_PROTO[receipt["orderType"]],
            time_in_force=_TIME_IN_FORCE_PROTO[receipt["timeInForce"]],
            reduce_only=receipt["reduceOnly"],
            quantity=receipt["quantity"],
            price=receipt["price"],
            max_notional_usd=receipt["maxNotionalUsd"],
            adapter_id=receipt["adapterId"],
            adapter_build_hash=receipt["adapterBuildHash"],
            adapter_config_hash=receipt["adapterConfigHash"],
            adapter_run_id=receipt["adapterRunId"],
            adapter_epoch=int(receipt["adapterEpoch"]),
            adapter_key_id=receipt["adapterKeyId"],
            attempt_id=receipt["attemptId"],
            attempt_number=int(receipt["attemptNumber"]),
            source_namespace_id=receipt["sourceNamespaceId"],
            source_sequence=int(receipt["sourceSequence"]),
            transition_number=int(receipt["transitionNumber"]),
            simulated_order_id=receipt.get("simulatedOrderId", ""),
            request_hash=receipt["requestHash"],
            response_hash=receipt["responseHash"],
            permit_issued_at=receipt["permitIssuedAt"],
            permit_expires_at=receipt["permitExpiresAt"],
            dispatch_armed_at=receipt["dispatchArmedAt"],
            adapter_observed_at=receipt["adapterObservedAt"],
            simulator_occurred_at=receipt["simulatorOccurredAt"],
            previous_receipt_id=receipt.get("previousReceiptId", ""),
            filled_quantity=receipt.get("filledQuantity", ""),
            average_price=receipt.get("averagePrice", ""),
            reason=receipt.get("reason", ""),
            receipt_id=receipt_id,
            signature=receipt["signature"],
        )
        lifecycle_event = execution_pb2.ExecutionEvent(
            schema_version=lifecycle["schemaVersion"],
            event_id=lifecycle["eventId"],
            command_id=lifecycle["commandId"],
            sequence=int(lifecycle["sequence"]),
            occurred_at=lifecycle["occurredAt"],
            kind=_EVENT_KIND_PROTO[lifecycle["kind"]],
            client_order_id=lifecycle.get("clientOrderId", ""),
            venue_order_id=lifecycle.get("venueOrderId", ""),
            filled_quantity=lifecycle.get("filledQuantity", ""),
            average_price=lifecycle.get("averagePrice", ""),
            reason=lifecycle.get("reason", ""),
            evidence_schema_version=lifecycle.get("evidenceSchemaVersion", ""),
            evidence_receipt_id=lifecycle.get("evidenceReceiptId", ""),
        )
    except (KeyError, TypeError, ValueError, OverflowError) as error:
        raise ValueError("stored offline receipt projection is invalid") from error
    return execution_pb2.GetOfflineExecutionReceiptResponse(
        found=True,
        receipt=projected_receipt,
        canonical_receipt_json_utf8=receipt_bytes,
        canonical_request_json_utf8=request_bytes,
        canonical_response_json_utf8=response_bytes,
        lifecycle_event=lifecycle_event,
    )


def _context_is_active(context: grpc.ServicerContext) -> bool:
    try:
        if not context.is_active():
            return False
    except Exception:
        return False
    return not _context_deadline_expired(context)


def _context_deadline_expired(context: grpc.ServicerContext) -> bool:
    try:
        remaining = context.time_remaining()
    except Exception:
        return False
    return (
        isinstance(remaining, (int, float))
        and not isinstance(remaining, bool)
        and math.isfinite(remaining)
        and remaining <= 0
    )


def _stream_wait_seconds(context: grpc.ServicerContext) -> float:
    try:
        remaining = context.time_remaining()
    except Exception:
        return _STREAM_POLL_SECONDS
    if (
        isinstance(remaining, (int, float))
        and not isinstance(remaining, bool)
        and math.isfinite(remaining)
    ):
        return max(0.001, min(_STREAM_POLL_SECONDS, float(remaining)))
    return _STREAM_POLL_SECONDS


def execution_command_to_proto(command: Mapping[str, Any]) -> execution_pb2.ExecutionCommand:
    """Project a validated JSON command back onto the protobuf wire contract."""
    parsed = validate_execution_command_v1(command)
    payload = parsed["payload"]
    kind = payload["kind"]
    projected = execution_pb2.ExecutionCommandPayload(
        schema_version=payload["schemaVersion"],
        kind=_KIND_PROTO[kind],
        account_id=payload["accountId"],
        canonical_symbol=payload["canonicalSymbol"],
        venue=_VENUE_PROTO[payload["venue"]],
        venue_instrument_id=payload["venueInstrumentId"],
        idempotency_key=payload["idempotencyKey"],
        mode=_MODE_PROTO[payload["mode"]],
    )
    if kind == "submit":
        projected.client_order_id = payload["clientOrderId"]
        projected.side = _SIDE_PROTO[payload["side"]]
        projected.order_type = _ORDER_TYPE_PROTO[payload["orderType"]]
        projected.quantity = payload["quantity"]
        projected.price = payload["price"]
        projected.time_in_force = _TIME_IN_FORCE_PROTO[payload["timeInForce"]]
        projected.reduce_only = payload["reduceOnly"]
        projected.max_notional_usd = payload["maxNotionalUsd"]
    elif kind == "cancel":
        projected.target_client_order_id = payload["targetClientOrderId"]
    elif kind == "replace":
        projected.target_client_order_id = payload["targetClientOrderId"]
        projected.replacement_client_order_id = payload["replacementClientOrderId"]
        projected.quantity = payload["quantity"]
        projected.price = payload["price"]
        projected.time_in_force = _TIME_IN_FORCE_PROTO[payload["timeInForce"]]
        projected.max_notional_usd = payload["maxNotionalUsd"]
    elif kind == "reconcile" and "afterSequence" in payload:
        projected.after_sequence = int(payload["afterSequence"])
    elif kind == "suspend":
        projected.reason = payload["reason"]
    return execution_pb2.ExecutionCommand(
        schema_version=parsed["schemaVersion"],
        command_id=parsed["commandId"],
        payload_hash=parsed["payloadHash"],
        payload=projected,
        canonical_payload_json_utf8=stable_stringify(payload).encode("utf-8"),
    )


def _strict_json_object(raw: bytes, label: str) -> dict[str, Any]:
    """Decode and require the same canonical JSON byte representation as core."""
    if not raw:
        raise ContractValidationError(f"{label}_missing")
    try:
        parsed = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ContractValidationError(f"{label}_invalid_utf8_json") from error
    if not isinstance(parsed, dict):
        raise ContractValidationError(f"{label}_must_be_object")
    try:
        canonical = stable_stringify(parsed).encode("utf-8")
    except ContractValidationError as error:
        raise ContractValidationError(f"{label}_invalid_contract_json") from error
    if raw != canonical:
        raise ContractValidationError(f"{label}_not_canonical")
    return parsed


def _safe_contract_reason(error: Exception) -> str:
    """Return a bounded non-secret reason code for malformed client input."""
    detail = str(error)
    if not detail or len(detail) > 160 or not detail.replace("_", "").replace("-", "").isalnum():
        return "invalid_execution_request"
    return detail


def _socket_identity(path: Path) -> tuple[int, int] | None:
    """Return the identity of a socket entry, never following a symlink."""
    try:
        entry = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISSOCK(entry.st_mode):
        return None
    return entry.st_dev, entry.st_ino


def _unlink_socket_if_identity(path: Path, identity: tuple[int, int] | None) -> None:
    """Remove only the exact socket this wrapper previously observed."""
    if identity is None or _socket_identity(path) != identity:
        return
    try:
        os.unlink(path)
    except FileNotFoundError:
        pass
    except OSError:
        # A stop must never turn inability to remove a pathname into deletion
        # of a later replacement.  The identity guard remains fail-closed.
        pass


def _validate_uds_path(path: Path, *, label: str) -> None:
    try:
        encoded = os.fsencode(path)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{label}_invalid") from error
    if len(encoded) > _MAX_UDS_PATH_BYTES:
        raise ValueError(f"{label}_too_long")


def _validate_private_uds_parent(path: Path) -> None:
    """Require an owner-only, non-symlink directory for pathname authority."""
    parent = path.parent
    try:
        entry = parent.lstat()
    except OSError as error:
        raise ValueError("socket_path_parent_unavailable") from error
    if (
        not stat.S_ISDIR(entry.st_mode)
        or entry.st_uid != os.getuid()
        or stat.S_IMODE(entry.st_mode) & 0o077
    ):
        raise ValueError("socket_path_parent_must_be_owner_private")
    current = parent
    while current != current.parent:
        try:
            ancestor = current.lstat()
        except OSError as error:
            raise ValueError("socket_path_parent_unavailable") from error
        if stat.S_ISLNK(ancestor.st_mode):
            raise ValueError("socket_path_parent_symlink_forbidden")
        current = current.parent


def _acquire_publication_lock(public_path: Path) -> int:
    """Serialize all cooperating publishers and cleanup for one public path."""
    lock_path = public_path.with_name(public_path.name + _PUBLICATION_LOCK_SUFFIX)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(lock_path, flags, 0o600)
    except OSError as error:
        raise RuntimeError("uds_publication_lock_unavailable") from error
    try:
        entry = os.fstat(descriptor)
        if (
            not stat.S_ISREG(entry.st_mode)
            or entry.st_uid != os.getuid()
            or entry.st_nlink != 1
        ):
            raise RuntimeError("uds_publication_lock_unsafe")
        os.fchmod(descriptor, 0o600)
        entry = os.fstat(descriptor)
        if stat.S_IMODE(entry.st_mode) != 0o600:
            raise RuntimeError("uds_publication_lock_unsafe")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def _release_publication_lock(descriptor: int | None) -> None:
    if descriptor is None:
        return
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def _new_staging_socket_path(public_path: Path) -> Path:
    """Choose an absent sibling path without ever inspecting the public one."""
    for _ in range(_STAGING_ATTEMPTS):
        candidate = public_path.with_name(
            f".{public_path.name}.grpc-staging-{secrets.token_hex(8)}"
        )
        _validate_uds_path(candidate, label="staging_socket_path")
        if not os.path.lexists(candidate):
            return candidate
    raise RuntimeError("failed_to_reserve_staging_uds_path")


class _PublishedUdsStopEvent:
    """Event-compatible stop result which also settles public-path cleanup."""

    def __init__(self, completion: Event, cleanup: Callable[[], None]) -> None:
        self._completion = completion
        self._cleanup = cleanup

    def wait(self, timeout: float | None = None) -> bool:
        finished = self._completion.wait(timeout)
        if finished:
            self._cleanup()
        return finished

    def is_set(self) -> bool:
        finished = self._completion.is_set()
        if finished:
            self._cleanup()
        return finished

    def __getattr__(self, name: str) -> Any:
        return getattr(self._completion, name)


class _PublishedUdsServer:
    """Publish a gRPC UDS listener only through an atomic hard-link operation.

    gRPC unlinks its configured UDS pathname both while binding and during
    shutdown.  It is therefore configured exclusively with a random sibling
    staging pathname.  ``start`` hard-links that live socket into the public
    location only after gRPC has started; hard-link creation fails atomically
    when another process already owns the public pathname.
    """

    # This guarantee assumes the documented trust boundary: the parent is
    # owner-only and every legitimate publisher cooperates on the lock held by
    # this wrapper. A hostile process under the same UID is outside that
    # filesystem boundary and can mutate any pathname owned by the account.
    preserves_replaced_public_socket_on_stop = True

    def __init__(
        self,
        server: grpc.Server,
        *,
        public_path: Path,
        staging_path: Path,
        publication_lock_fd: int,
    ) -> None:
        self._server = server
        self._public_path = public_path
        self._staging_path = staging_path
        self._lock = Lock()
        self._started = False
        self._stopped = False
        self._cleanup_complete = False
        self._staging_identity: tuple[int, int] | None = _socket_identity(staging_path)
        self._published_identity: tuple[int, int] | None = None
        self._stop_event: _PublishedUdsStopEvent | None = None
        self._publication_lock_fd: int | None = publication_lock_fd

    @property
    def published_identity(self) -> tuple[int, int] | None:
        """The device/inode currently published by this server, if any."""
        with self._lock:
            return self._published_identity

    def start(self) -> None:
        """Start staging first, then atomically publish it at the public path."""
        with self._lock:
            if self._started:
                raise RuntimeError("uds_server_already_started")
            self._started = True
        try:
            self._server.start()
            staging_identity = _socket_identity(self._staging_path)
            if staging_identity is None:
                raise RuntimeError("staging_uds_socket_missing_after_start")
            os.chmod(self._staging_path, 0o600, follow_symlinks=False)
            secured = os.lstat(self._staging_path)
            if (
                not stat.S_ISSOCK(secured.st_mode)
                or secured.st_uid != os.getuid()
                or stat.S_IMODE(secured.st_mode) != 0o600
                or (secured.st_dev, secured.st_ino) != staging_identity
            ):
                raise RuntimeError("staging_uds_socket_security_mismatch")
            with self._lock:
                self._staging_identity = staging_identity
            # The destination is deliberately not pre-checked: os.link is the
            # single atomic first-publication operation and EEXIST preserves
            # the old inode and listener without a transient unlink window.
            os.link(self._staging_path, self._public_path, follow_symlinks=False)
            if _socket_identity(self._public_path) != staging_identity:
                raise RuntimeError("published_uds_socket_identity_mismatch")
            with self._lock:
                self._published_identity = staging_identity
        except Exception:
            # No failed publication may leave this process' staging socket
            # reachable.  Public cleanup remains identity-bound, so a racing
            # replacement is never removed.
            self._stop_and_cleanup_synchronously()
            raise

    def stop(self, grace: float | None) -> _PublishedUdsStopEvent:
        """Stop gRPC on staging, then remove only this publication's inode."""
        with self._lock:
            if self._stop_event is not None:
                return self._stop_event
            self._stopped = True
            completion = self._server.stop(grace)
            event = _PublishedUdsStopEvent(completion, self._cleanup_after_stop)
            self._stop_event = event
        Thread(target=event.wait, name="nautilus-paper-uds-cleanup", daemon=True).start()
        return event

    def close(self) -> None:
        """Release an unstarted or stopped builder and its publication lock."""
        self.stop(0).wait()

    def wait_for_termination(self, timeout: float | None = None) -> bool:
        finished = self._server.wait_for_termination(timeout=timeout)
        if finished:
            self._cleanup_after_stop()
        return finished

    def _stop_and_cleanup_synchronously(self) -> None:
        try:
            completion = self._server.stop(0)
            completion.wait()
        finally:
            self._cleanup_after_stop()

    def _cleanup_after_stop(self) -> None:
        with self._lock:
            if self._cleanup_complete:
                return
            if not self._stopped:
                self._stopped = True
            published_identity = self._published_identity
            staging_identity = self._staging_identity
            self._published_identity = None
            self._staging_identity = None
            # gRPC owns only staging and is allowed to remove it.  These
            # guarded fallbacks cover an incomplete gRPC shutdown without
            # touching another process' replacement at either pathname. Hold
            # the lock across cleanup so a caller whose stop Event has become
            # set cannot observe the public path between two cleanup threads.
            _unlink_socket_if_identity(self._staging_path, staging_identity)
            _unlink_socket_if_identity(self._public_path, published_identity)
            publication_lock_fd = self._publication_lock_fd
            self._publication_lock_fd = None
            self._cleanup_complete = True
        _release_publication_lock(publication_lock_fd)

    def __getattr__(self, name: str) -> Any:
        """Preserve gRPC server methods not involved in UDS publication."""
        return getattr(self._server, name)


def build_uds_server(
    core: CoreSource | None = None,
    *,
    gateway: DurableAdmissionCoreGateway | None = None,
    socket_path: str | Path,
    max_workers: int = 1,
) -> _PublishedUdsServer:
    """Build, but do not start, a local Unix-domain-socket gRPC server.

    This helper is intentionally explicit about the local socket path and does
    not start, daemonize, register credentials, open a TCP listener, or pass
    the public path to gRPC's unlink-on-bind implementation. The returned
    wrapper atomically publishes and identity-cleans only its own socket while
    holding the per-path lock.
    A factory constructs a direct core in the one gRPC worker. A gateway may
    use two to four workers; its stream capacity is ``max_workers - 2`` capped
    at two, reserving two workers for unary Health/Execute traffic. A managed
    runtime uses four workers and forwards every database operation onto the
    single ledger-owner thread. Test callers own the temporary directory and
    call ``start``/``stop``.
    """
    path = Path(socket_path)
    worker_count_valid = (
        type(max_workers) is int and max_workers == 1
        if gateway is None
        else type(max_workers) is int and 2 <= max_workers <= 4
    )
    if not path.is_absolute() or not path.name or not worker_count_valid:
        raise ValueError(
            "socket_path must be absolute; direct core requires one worker and gateway requires 2..4"
        )
    _validate_private_uds_parent(path)
    _validate_uds_path(path, label="socket_path")
    publication_lock_fd = _acquire_publication_lock(path)
    try:
        staging_path = _new_staging_socket_path(path)
        server = grpc.server(futures.ThreadPoolExecutor(max_workers=max_workers))
        execution_pb2_grpc.add_OpenAliceExecutionServiceServicer_to_server(
            DurableAdmissionExecutionService(
                core,
                gateway=gateway,
                max_concurrent_streams=(1 if gateway is None else max_workers - 2),
            ),
            server,
        )
        try:
            if server.add_insecure_port(f"unix://{staging_path}") == 0:
                raise RuntimeError("failed_to_bind_local_uds")
        except Exception:
            staging_identity = _socket_identity(staging_path)
            try:
                server.stop(0).wait()
            finally:
                _unlink_socket_if_identity(staging_path, staging_identity)
            raise
    except Exception:
        _release_publication_lock(publication_lock_fd)
        raise
    return _PublishedUdsServer(
        server,
        public_path=path,
        staging_path=staging_path,
        publication_lock_fd=publication_lock_fd,
    )
