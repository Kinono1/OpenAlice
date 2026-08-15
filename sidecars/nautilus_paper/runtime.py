"""Single-owner runtime for the durable-only paper-admission sidecar.

This module owns process lifecycle, local filesystem checks, and the SQLite
writer lease.  It deliberately has no broker, credential, network, or
Nautilus dependency.  gRPC workers use :class:`RuntimeExecutor` as a narrow
gateway; all ledger and core work runs on one dedicated owner thread.
"""

from __future__ import annotations

from collections import deque
from collections.abc import Callable, Mapping
from concurrent.futures import Future, TimeoutError as FutureTimeout
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
import json
import math
import os
from pathlib import Path
from queue import Empty, Full, Queue
import stat
from threading import Event, Lock, Thread, get_ident
import time
from typing import Any
from uuid import uuid4

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from .contract import load_ed25519_public_key, sha256_canonical, stable_stringify
from .core import (
    CoreAdmissionDenied,
    CoreStatus,
    DurableAdmissionDecision,
    PaperSidecarCore,
)
from .grpc_receiver import build_uds_server
from .ledger import Ledger, Lease, LeaseRejected, StaleLease
from .offline_execution import OfflineExecutionCoordinator
from .offline_receipt import ed25519_public_key_fingerprint_sha256
from .offline_simulator import OfflineSimulatorStore


class RuntimeState(str, Enum):
    """Observable lifecycle state; ``READY`` is durable-only, never broker-ready."""

    STOPPED = "STOPPED"
    PRECHECKED = "PRECHECKED"
    LEASE_ACQUIRED = "LEASE_ACQUIRED"
    DURABLE_UDS_READY = "DURABLE_UDS_READY"
    DRAINING = "DRAINING"
    WRITE_DISARMED = "WRITE_DISARMED"


class RuntimeErrorCode(RuntimeError):
    """A public runtime failure represented only by a stable reason code."""


class RuntimeSupervisor:
    """Thread-safe, intentionally small lifecycle publication surface."""

    def __init__(self) -> None:
        self._state = RuntimeState.STOPPED
        self._lock = Lock()

    @property
    def state(self) -> RuntimeState:
        with self._lock:
            return self._state

    def _set(self, state: RuntimeState) -> None:
        with self._lock:
            self._state = state


@dataclass(frozen=True, slots=True)
class RuntimeIdentity:
    """The exact durable identity that a runtime must prove before READY."""

    mode: str
    run_id: str
    environment_proof_hash: str
    schema_hash: str
    protocol_version: str = "openalice.execution.v1"
    service_id: str = "openalice.nautilus_paper.durable_admission"


@dataclass(frozen=True, slots=True)
class OfflineExecutionRuntimeConfig:
    """Constructor-only trust and store inputs for local simulated execution.

    All private-key fields are deliberately excluded from ``repr``.  The
    runtime snapshots and validates this value before any owner thread starts;
    no request, gRPC worker, or coordinator call may replace these inputs.
    The simulator database must already have been explicitly provisioned.
    """

    policy: Mapping[str, Any]
    simulator_database_path: str | Path
    permit_public_key: Any = field(repr=False)
    capability_authority_key_id: str
    capability_authority_private_key: Ed25519PrivateKey = field(repr=False)
    receipt_signing_key_id: str
    receipt_signing_private_key: Ed25519PrivateKey = field(repr=False)
    source_attestation_key_id: str
    source_attestation_private_key: Ed25519PrivateKey = field(repr=False)


@dataclass(frozen=True, slots=True)
class _FrozenOfflineExecutionRuntimeConfig:
    """Canonical, key-normalized process identity for the owner thread."""

    policy_json: str
    policy_hash: str
    simulator_database_path: Path
    permit_public_key: Any = field(repr=False)
    capability_authority_key_id: str
    capability_authority_private_key: Ed25519PrivateKey = field(repr=False)
    capability_public_key: Any = field(repr=False)
    receipt_signing_key_id: str
    receipt_signing_private_key: Ed25519PrivateKey = field(repr=False)
    receipt_public_key: Any = field(repr=False)
    source_attestation_key_id: str
    source_attestation_private_key: Ed25519PrivateKey = field(repr=False)
    source_public_key: Any = field(repr=False)

    @property
    def policy(self) -> dict[str, Any]:
        return json.loads(self.policy_json)


class _Operation(str, Enum):
    HANDSHAKE = "handshake"
    HEALTH = "health"
    ADMIT = "admit"
    GET_COMMAND = "get_command"
    GET_OFFLINE_EXECUTION_RECEIPT = "get_offline_execution_receipt"
    GET_SNAPSHOT = "get_snapshot"
    REPLAY_LIFECYCLE_EVENTS = "replay_lifecycle_events"
    STOP = "stop"


@dataclass(slots=True)
class _Request:
    operation: _Operation
    values: tuple[Any, ...]
    result: Future[Any]


class LeaseController:
    """Owner-thread-only fenced writer lease with irreversible disarm semantics."""

    def __init__(
        self,
        ledger: Ledger,
        *,
        name: str,
        owner_id: str,
        ttl_seconds: float,
        wall_clock: Callable[[], float],
    ) -> None:
        self._ledger = ledger
        self._name = name
        self._owner_id = owner_id
        self._ttl_seconds = ttl_seconds
        self._wall_clock = wall_clock
        self._owner_thread_id = get_ident()
        self._lease: Lease | None = None
        self._next_renew_at = 0.0
        self._expires_monotonic = 0.0

    @property
    def lease(self) -> Lease:
        self._assert_owner_thread()
        if self._lease is None:
            raise RuntimeErrorCode("runtime_lease_unavailable")
        return self._lease

    def acquire(self) -> Lease:
        self._assert_owner_thread()
        # Do not pass a caller-sampled timestamp: the ledger is the authority
        # for the transaction's fencing time.
        self._lease = self._ledger.acquire_writer_lease(
            name=self._name,
            owner_id=self._owner_id,
            ttl_seconds=self._ttl_seconds,
        )
        monotonic_now = time.monotonic()
        self._next_renew_at = monotonic_now + self._ttl_seconds / 3.0
        self._expires_monotonic = monotonic_now + self._ttl_seconds
        return self._lease

    def require_current(self) -> None:
        self._assert_owner_thread()
        if time.monotonic() >= self._expires_monotonic:
            raise StaleLease("lease_monotonic_deadline_expired")
        self._ledger.require_current_writer_lease(self.lease)

    def renew_if_due(self) -> bool:
        """Renew only after proving the existing lease is still current.

        Returning ``False`` means no renewal was due.  Any exception is left
        to the executor, which transitions permanently to WRITE_DISARMED.
        """
        self._assert_owner_thread()
        if time.monotonic() < self._next_renew_at:
            return False
        self.require_current()
        prior = self.lease
        renewed = self._ledger.acquire_writer_lease(
            name=self._name,
            owner_id=self._owner_id,
            ttl_seconds=self._ttl_seconds,
        )
        if (
            renewed.name != prior.name
            or renewed.owner_id != prior.owner_id
            or renewed.epoch != prior.epoch
        ):
            raise StaleLease("lease_token_changed_during_renewal")
        self._lease = renewed
        monotonic_now = time.monotonic()
        self._next_renew_at = monotonic_now + self._ttl_seconds / 3.0
        self._expires_monotonic = monotonic_now + self._ttl_seconds
        return True

    def release(self) -> None:
        self._assert_owner_thread()
        # A clean release advances no epoch itself, but makes the retained
        # handle stale and lets a new process acquire the next epoch.
        self._ledger.release_writer_lease(self.lease)

    def _assert_owner_thread(self) -> None:
        if get_ident() != self._owner_thread_id:
            raise RuntimeErrorCode("runtime_owner_thread_violation")


CoreFactory = Callable[[Ledger, Lease], PaperSidecarCore]
ServerFactory = Callable[..., Any]


class RuntimeExecutor:
    """A bounded-queue gateway onto exactly one Ledger-owning thread.

    ``core_factory`` is invoked once, in the owner thread, after the runtime's
    lease is acquired.  It receives that exact lease and must return a fully
    configured ``PaperSidecarCore`` whose identity is already capable of
    returning ``ready_for_durable_admission``.  Factories must not acquire a
    second writer lease.
    """

    def __init__(
        self,
        database_path: str | Path,
        socket_path: str | Path,
        *,
        core_factory: CoreFactory,
        expected_identity: RuntimeIdentity,
        lease_name: str = "nautilus-paper-runtime",
        ttl_seconds: float = 30.0,
        queue_size: int = 64,
        server_factory: ServerFactory = build_uds_server,
        wall_clock: Callable[[], float] = time.time,
        offline_execution: OfflineExecutionRuntimeConfig | None = None,
        startup_timeout_seconds: float = 10.0,
        shutdown_timeout_seconds: float = 10.0,
    ) -> None:
        if (
            not callable(core_factory)
            or not callable(server_factory)
            or not _valid_runtime_identity(expected_identity)
            or not isinstance(lease_name, str)
            or not lease_name
            or lease_name != lease_name.strip()
            or len(lease_name) > 200
        ):
            raise ValueError("invalid_runtime_configuration")
        if (
            not _positive_finite_number(ttl_seconds)
            or type(queue_size) is not int
            or queue_size <= 0
            or not _positive_finite_number(startup_timeout_seconds)
            or not _positive_finite_number(shutdown_timeout_seconds)
            or not callable(wall_clock)
        ):
            raise ValueError("invalid_runtime_configuration")
        self._database_path = _absolute_path(database_path)
        self._socket_path = _absolute_path(socket_path)
        self._offline_execution_config = _freeze_offline_execution_runtime_config(
            offline_execution
        )
        if self._offline_execution_config is not None:
            if expected_identity.mode != "PAPER_LOCAL":
                raise ValueError("invalid_runtime_configuration")
            simulator_path = self._offline_execution_config.simulator_database_path
            if simulator_path in {self._database_path, self._socket_path}:
                raise ValueError("invalid_runtime_configuration")
        self._core_factory = core_factory
        self._expected_identity = expected_identity
        self._lease_name = lease_name
        self._ttl_seconds = float(ttl_seconds)
        self._queue: Queue[_Request] = Queue(maxsize=queue_size)
        self._server_factory = server_factory
        self._wall_clock = wall_clock
        self._startup_timeout_seconds = float(startup_timeout_seconds)
        self._shutdown_timeout_seconds = float(shutdown_timeout_seconds)
        self._supervisor = RuntimeSupervisor()
        # Public lifecycle calls are serialized independently of the shorter
        # locks used by queueing and status publication.
        self._start_stop_lock = Lock()
        self._lifecycle_lock = Lock()
        self._admission_lock = Lock()
        self._admission_open = False
        self._request_open = False
        self._thread: Thread | None = None
        self._booted = Event()
        self._socket_verified = Event()
        self._startup_published = Event()
        self._boot_error: str | None = None
        self._startup_cancelled = False
        self._server: Any | None = None
        self._socket_identity: tuple[int, int] | None = None
        self._owner_thread_id: int | None = None
        self._owner_id: str | None = None
        self._lease_controller: LeaseController | None = None
        self._core: PaperSidecarCore | None = None
        self._ledger: Ledger | None = None
        self._offline_simulator: OfflineSimulatorStore | None = None
        self._offline_coordinator: OfflineExecutionCoordinator | None = None
        self._offline_backlog: deque[str] = deque()
        self._offline_queued: set[str] = set()
        self._startup_read_only = False
        self._write_disarmed = False

    @property
    def supervisor(self) -> RuntimeSupervisor:
        return self._supervisor

    @property
    def owner_thread_id(self) -> int | None:
        return self._owner_thread_id

    @property
    def owner_id(self) -> str | None:
        return self._owner_id

    def start(self) -> None:
        """Serialize a start against any concurrent stop request."""
        with self._start_stop_lock:
            self._start_locked()

    def _start_locked(self) -> None:
        """Publish either writable READY or an explicit read-only disarmed UDS."""
        with self._lifecycle_lock:
            if self._supervisor.state is RuntimeState.DURABLE_UDS_READY:
                return
            if self._supervisor.state is RuntimeState.WRITE_DISARMED:
                raise RuntimeErrorCode("runtime_process_restart_required")
            if self._supervisor.state is not RuntimeState.STOPPED:
                raise RuntimeErrorCode("runtime_start_in_progress")
            _validate_start_paths(
                self._database_path,
                self._socket_path,
                simulator_database_path=(
                    None
                    if self._offline_execution_config is None
                    else self._offline_execution_config.simulator_database_path
                ),
            )
            self._supervisor._set(RuntimeState.PRECHECKED)
            self._booted.clear()
            self._socket_verified.clear()
            self._startup_published.clear()
            self._boot_error = None
            self._startup_cancelled = False
            self._startup_read_only = False
            self._write_disarmed = False
            self._owner_id = str(uuid4())
            self._thread = Thread(
                target=self._owner_main, name="nautilus-paper-owner", daemon=False
            )
            self._thread.start()

        if not self._booted.wait(timeout=self._startup_timeout_seconds):
            # A user factory can be buggy or blocked.  The caller gets a
            # bounded failure; if it returns later, the owner notices this
            # cancellation before serving a request and clean-releases itself.
            with self._admission_lock:
                self._startup_cancelled = True
                self._request_open = False
                self._admission_open = False
                self._write_disarmed = True
                self._supervisor._set(RuntimeState.WRITE_DISARMED)
                self._socket_verified.set()
                self._startup_published.set()
            raise RuntimeErrorCode("runtime_startup_timeout")
        if self._boot_error is not None:
            if self._join_owner(timeout=self._shutdown_timeout_seconds):
                self._supervisor._set(RuntimeState.STOPPED)
            else:
                self._supervisor._set(RuntimeState.WRITE_DISARMED)
            raise RuntimeErrorCode("runtime_startup_failed")

        server: Any | None = None
        try:
            server = self._server_factory(
                gateway=self, socket_path=self._socket_path, max_workers=4
            )
            server.start()
            identity = _secure_started_socket(self._socket_path)
            if (
                getattr(server, "preserves_replaced_public_socket_on_stop", False)
                is not True
                or getattr(server, "published_identity", None) != identity
            ):
                raise RuntimeErrorCode("unsafe_runtime_server")
            with self._admission_lock:
                if self._startup_cancelled:
                    raise RuntimeErrorCode("runtime_startup_cancelled")
                self._server = server
                self._socket_identity = identity
                # Only the owner thread may publish READY.  This signal says
                # the atomically published UDS inode has been permission- and
                # identity-checked; the owner must now recheck lease, proof,
                # and frozen signing keys before opening admission.
                self._socket_verified.set()
            if not self._startup_published.wait(timeout=self._startup_timeout_seconds):
                raise RuntimeErrorCode("runtime_startup_timeout")
            with self._admission_lock:
                writable_ready = (
                    self._supervisor.state is RuntimeState.DURABLE_UDS_READY
                    and self._admission_open
                    and self._request_open
                    and not self._write_disarmed
                )
                read_only_ready = (
                    self._startup_read_only
                    and self._supervisor.state is RuntimeState.WRITE_DISARMED
                    and not self._admission_open
                    and self._request_open
                    and self._write_disarmed
                )
                if self._startup_cancelled or not (writable_ready or read_only_ready):
                    raise RuntimeErrorCode("runtime_startup_failed")
            return
        except Exception as error:
            # No startup failure may leave a listener or owner behind while
            # publishing STOPPED.  A server that cannot prove termination is
            # an explicit process-restart boundary.
            with self._admission_lock:
                self._startup_cancelled = True
                self._admission_open = False
                self._request_open = False
                self._socket_verified.set()
                self._startup_published.set()
            server_stop_failed = False
            if server is not None:
                try:
                    if (
                        server.stop(0).wait(timeout=self._shutdown_timeout_seconds)
                        is False
                    ):
                        server_stop_failed = True
                except Exception:
                    server_stop_failed = True
            self._forget_socket_identity()
            self._server = None
            owner_joined = self._join_owner(timeout=self._shutdown_timeout_seconds)
            if owner_joined and not server_stop_failed:
                self._supervisor._set(RuntimeState.STOPPED)
            else:
                self._write_disarmed = True
                self._supervisor._set(RuntimeState.WRITE_DISARMED)
            if (
                isinstance(error, RuntimeErrorCode)
                and str(error) == "runtime_startup_timeout"
            ):
                raise error from None
            raise RuntimeErrorCode("runtime_startup_failed") from None

    def stop(self) -> None:
        """Serialize stop with start, then drain and clean-release safely."""
        with self._start_stop_lock:
            self._stop_locked()

    def _stop_locked(self) -> None:
        """Atomically close admission, drain queued work, then clean-release."""
        with self._lifecycle_lock:
            state = self._supervisor.state
            if state is RuntimeState.STOPPED:
                return
            with self._admission_lock:
                self._admission_open = False
                if state is not RuntimeState.WRITE_DISARMED:
                    self._supervisor._set(RuntimeState.DRAINING)
            self._request_open = False
            server = self._server
            self._server = None

        server_stop_failed = False
        socket_identity_changed = server is not None and not self._owns_socket_path()
        if server is not None:
            try:
                stopped = server.stop(0)
                if stopped.wait(timeout=self._shutdown_timeout_seconds) is False:
                    server_stop_failed = True
            except Exception:
                server_stop_failed = True
        try:
            self._request_owner_stop(clean_release=not self._write_disarmed)
        except RuntimeErrorCode:
            self._write_disarmed = True
            self._supervisor._set(RuntimeState.WRITE_DISARMED)
            raise
        if not self._join_owner(timeout=self._shutdown_timeout_seconds):
            self._write_disarmed = True
            self._supervisor._set(RuntimeState.WRITE_DISARMED)
            raise RuntimeErrorCode("runtime_shutdown_timeout")
        socket_identity_changed = (
            socket_identity_changed or self._socket_path_has_different_identity()
        )
        self._forget_socket_identity()
        if server_stop_failed or socket_identity_changed:
            self._write_disarmed = True
            self._supervisor._set(RuntimeState.WRITE_DISARMED)
            reason = (
                "runtime_server_shutdown_failed"
                if server_stop_failed
                else "runtime_socket_identity_changed"
            )
            raise RuntimeErrorCode(reason)
        if self._write_disarmed:
            self._supervisor._set(RuntimeState.WRITE_DISARMED)
        else:
            self._supervisor._set(RuntimeState.STOPPED)

    # Gateway methods called by gRPC's bounded worker pool. No arbitrary callbacks
    # cross this boundary: operation and copied data are explicitly enumerated.
    def handshake(self) -> CoreStatus:
        return self._submit(_Operation.HANDSHAKE)

    def health(self) -> CoreStatus:
        return self._submit(_Operation.HEALTH)

    def admit(
        self,
        *,
        command: Mapping[str, Any],
        permit: Mapping[str, Any],
        command_payload_bytes: bytes,
        permit_bytes: bytes,
        operation_timeout_seconds: float | None = None,
    ) -> DurableAdmissionDecision:
        # The gate lock covers both the decision and queue insertion.  Stop
        # cannot interleave and accidentally leave a post-stop write queued.
        with self._admission_lock:
            if self._write_disarmed:
                raise CoreAdmissionDenied("runtime_write_disarmed")
            if not self._admission_open:
                raise CoreAdmissionDenied("runtime_draining")
            request = _Request(
                _Operation.ADMIT,
                (
                    deepcopy(dict(command)),
                    deepcopy(dict(permit)),
                    bytes(command_payload_bytes),
                    bytes(permit_bytes),
                ),
                Future(),
            )
            try:
                self._queue.put_nowait(request)
            except Full:
                raise CoreAdmissionDenied("runtime_queue_full") from None
        if operation_timeout_seconds is None:
            timeout = self._shutdown_timeout_seconds
        elif _positive_finite_number(operation_timeout_seconds):
            timeout = min(
                float(operation_timeout_seconds), self._shutdown_timeout_seconds
            )
        else:
            if request.result.cancel():
                raise CoreAdmissionDenied("runtime_operation_timeout")
            self._disarm()
            raise CoreAdmissionDenied("runtime_submission_unknown")
        return self._admission_result(request, timeout=timeout)

    def get_command(self, command_id: str) -> Any:
        # Read-only access remains available after WRITE_DISARMED, until stop.
        return self._submit(_Operation.GET_COMMAND, command_id)

    def get_offline_execution_receipt(self, receipt_id: str) -> Any:
        """Read a verified offline receipt after disarm, but never after stop."""
        return self._submit(_Operation.GET_OFFLINE_EXECUTION_RECEIPT, receipt_id)

    def get_snapshot(self, *, account_id: str, symbol: str) -> Any:
        """Read lifecycle diagnostics after disarm, but never after stop."""
        return self._submit(_Operation.GET_SNAPSHOT, account_id, symbol)

    def replay_lifecycle_events(
        self, *, after_sequence: int = 0, limit: int = 1_000
    ) -> Any:
        """Replay a bounded lifecycle page on the SQLite owner thread."""
        return self._submit(
            _Operation.REPLAY_LIFECYCLE_EVENTS,
            after_sequence,
            limit,
        )

    def _submit(self, operation: _Operation, *values: Any) -> Any:
        request = _Request(operation, values, Future())
        with self._lifecycle_lock:
            if not self._request_open or self._supervisor.state in {
                RuntimeState.STOPPED,
                RuntimeState.DRAINING,
            }:
                raise RuntimeErrorCode("runtime_unavailable")
            try:
                self._queue.put_nowait(request)
            except Full:
                raise RuntimeErrorCode("runtime_unavailable") from None
        return _future_result(request.result, timeout=self._shutdown_timeout_seconds)

    def _open_owner_ledger(self) -> Ledger:
        """Open the one ledger with all offline authorities fixed at construction."""
        config = self._offline_execution_config
        if config is None:
            return Ledger(self._database_path, fencing_clock=self._wall_clock)
        return Ledger(
            self._database_path,
            fencing_clock=self._wall_clock,
            offline_capability_authority_private_key=(
                config.capability_authority_private_key
            ),
            offline_capability_authority_key_id=(config.capability_authority_key_id),
            offline_receipt_signing_private_key=config.receipt_signing_private_key,
            offline_receipt_signing_key_id=config.receipt_signing_key_id,
            offline_source_attestation_public_keys={
                config.source_attestation_key_id: config.source_public_key
            },
        )

    def _open_offline_execution_owner(
        self, ledger: Ledger, lease: Lease
    ) -> OfflineExecutionCoordinator | None:
        """Register policy and open the pre-provisioned simulator on this thread."""
        config = self._offline_execution_config
        if config is None:
            return None
        registered = ledger.register_offline_adapter_policy(
            policy=config.policy,
            writer_lease=lease,
        )
        if registered.policy_hash != config.policy_hash:
            raise RuntimeErrorCode("offline_policy_identity_mismatch")
        policy = ledger.require_local_offline_policy_authorities(
            config.policy_hash,
            permit_public_key=config.permit_public_key,
        ).value
        simulator = OfflineSimulatorStore(
            config.simulator_database_path,
            store_id=policy["simulatorStoreId"],
            capability_public_keys={
                config.capability_authority_key_id: config.capability_public_key
            },
            source_attestation_key_id=config.source_attestation_key_id,
            source_attestation_private_key=config.source_attestation_private_key,
            capability_clock=lambda: datetime.fromtimestamp(
                self._wall_clock(), timezone.utc
            ),
            allow_provision=False,
        )
        self._offline_simulator = simulator
        _secure_database_after_open(config.simulator_database_path)
        coordinator = OfflineExecutionCoordinator(
            ledger,
            simulator,
            writer_lease=lease,
            permit_public_key=config.permit_public_key,
            receipt_public_key=config.receipt_public_key,
        )
        self._offline_coordinator = coordinator
        return coordinator

    def _recover_offline_startup(self) -> bool:
        """Recover incomplete dispatches in admission order before opening writes.

        ``True`` means a signed original effect is still absent.  That is a
        successful fail-closed startup outcome: the UDS may expose verified
        reads, but admission must remain permanently disarmed in this process.
        """
        if self._offline_coordinator is None or self._ledger is None:
            return False
        while True:
            with self._admission_lock:
                if self._startup_cancelled:
                    raise RuntimeErrorCode("runtime_startup_cancelled")
            dispatches = self._ledger.list_incomplete_offline_dispatches(limit=10_000)
            if not dispatches:
                return False
            for dispatch in dispatches:
                with self._admission_lock:
                    if self._startup_cancelled:
                        raise RuntimeErrorCode("runtime_startup_cancelled")
                outcome = self._offline_coordinator.execute_or_recover(
                    dispatch.command_hash
                )
                if outcome.state == "RECONCILIATION_REQUIRED":
                    return True

    def _owner_main(self) -> None:
        self._owner_thread_id = get_ident()
        clean_release = False
        try:
            ledger = self._open_owner_ledger()
            self._ledger = ledger
            _secure_database_after_open(self._database_path)
            controller = LeaseController(
                ledger,
                name=self._lease_name,
                owner_id=self._owner_id or "",
                ttl_seconds=self._ttl_seconds,
                wall_clock=self._wall_clock,
            )
            self._lease_controller = controller
            lease = controller.acquire()
            self._supervisor._set(RuntimeState.LEASE_ACQUIRED)
            self._open_offline_execution_owner(ledger, lease)
            core = self._core_factory(ledger, lease)
            if not isinstance(core, PaperSidecarCore):
                raise TypeError("invalid_core_factory_result")
            # Resolver results are process identity, not per-request input.
            # Freeze all configured public keys before any READY publication.
            core.freeze_expected_public_keys()
            core.bind_writer_lease(lease)
            config = self._offline_execution_config
            if config is not None:
                core.require_offline_admission_binding(
                    config.policy_hash, config.permit_public_key
                )
                core.require_offline_receipt_binding(
                    config.receipt_signing_key_id, config.receipt_public_key
                )
            if not self._is_exact_ready(core.handshake(), lease):
                raise RuntimeErrorCode("core_not_ready")
            self._core = core
            self._startup_read_only = self._recover_offline_startup()
        except Exception:
            self._boot_error = "runtime_startup_failed"
            self._booted.set()
            self._close_owner(clean_release=True)
            return

        self._booted.set()
        if not self._socket_verified.wait(timeout=self._startup_timeout_seconds):
            with self._admission_lock:
                if not self._socket_verified.is_set():
                    self._startup_cancelled = True
                    self._admission_open = False
                    self._request_open = False
                    self._write_disarmed = True
                    self._supervisor._set(RuntimeState.WRITE_DISARMED)
                    self._startup_published.set()
        with self._admission_lock:
            startup_cancelled = self._startup_cancelled
        if startup_cancelled:
            self._close_owner(clean_release=True)
            return

        # The UDS is now atomically published but admission is still closed.
        # Re-sample every authority on the owner thread so a slow server start
        # cannot publish an expired lease or drifted proof as READY.
        try:
            assert self._lease_controller is not None
            renewed = self._lease_controller.renew_if_due()
            if renewed:
                core.bind_writer_lease(self._lease_controller.lease)
                if self._offline_coordinator is not None:
                    self._offline_coordinator.bind_writer_lease(
                        self._lease_controller.lease
                    )
            self._lease_controller.require_current()
            if not self._is_exact_ready(core.health(), self._lease_controller.lease):
                raise RuntimeErrorCode("core_not_ready")
        except Exception:
            self._boot_error = "runtime_startup_failed"
            with self._admission_lock:
                self._startup_cancelled = True
                self._admission_open = False
                self._request_open = False
                self._startup_published.set()
            self._close_owner(clean_release=True)
            return

        with self._admission_lock:
            if self._startup_cancelled:
                startup_cancelled = True
            else:
                startup_cancelled = False
                if self._startup_read_only:
                    self._write_disarmed = True
                    self._supervisor._set(RuntimeState.WRITE_DISARMED)
                    self._admission_open = False
                else:
                    self._supervisor._set(RuntimeState.DURABLE_UDS_READY)
                    self._admission_open = True
                self._request_open = True
                self._startup_published.set()
        if startup_cancelled:
            self._close_owner(clean_release=True)
            return
        while True:
            # This priority point runs before every ordinary operation, and
            # periodic polling performs automatic TTL/3 renewal while idle.
            if not self._write_disarmed:
                try:
                    assert self._lease_controller is not None
                    renewed = self._lease_controller.renew_if_due()
                    if renewed:
                        assert self._core is not None
                        self._core.bind_writer_lease(self._lease_controller.lease)
                        if self._offline_coordinator is not None:
                            self._offline_coordinator.bind_writer_lease(
                                self._lease_controller.lease
                            )
                        if not self._is_exact_ready(
                            self._core.health(), self._lease_controller.lease
                        ):
                            self._disarm()
                except Exception:
                    self._disarm()
            if self._offline_backlog and not self._write_disarmed:
                self._execute_one_offline_backlog_item()
                continue
            try:
                request = self._queue.get(timeout=min(self._ttl_seconds / 3.0, 0.1))
            except Empty:
                continue
            if request.operation is _Operation.STOP:
                clean_release = bool(request.values[0]) and not self._write_disarmed
                request.result.set_result(None)
                break
            self._execute_request(request)
        self._close_owner(clean_release=clean_release)

    def _enqueue_offline_command(self, command_hash: str) -> None:
        """Queue one post-ACK internal action without duplicating work."""
        if self._offline_coordinator is None or command_hash in self._offline_queued:
            return
        self._offline_queued.add(command_hash)
        self._offline_backlog.append(command_hash)

    def _execute_one_offline_backlog_item(self) -> None:
        """Advance one local-only command; any uncertainty poisons this process."""
        if self._offline_coordinator is None or not self._offline_backlog:
            return
        command_hash = self._offline_backlog.popleft()
        self._offline_queued.discard(command_hash)
        try:
            outcome = self._offline_coordinator.execute_or_recover(command_hash)
            if outcome.state == "RECONCILIATION_REQUIRED":
                self._disarm()
        except Exception:
            # The admission Future was completed before this internal action.
            # Do not rewrite that durable-only ACK or attempt another effect in
            # this process; reads remain available for the next recovery owner.
            self._disarm()

    def _execute_request(self, request: _Request) -> None:
        if not request.result.set_running_or_notify_cancel():
            # A gateway timeout canceled this request before the owner began
            # it.  Skipping it guarantees that a queued timeout cannot become
            # a later durable write.
            return
        try:
            assert self._core is not None
            if request.operation is _Operation.ADMIT:
                if self._write_disarmed:
                    raise CoreAdmissionDenied("runtime_write_disarmed")
                assert self._lease_controller is not None
                try:
                    self._lease_controller.require_current()
                except Exception:
                    self._disarm()
                    raise CoreAdmissionDenied("runtime_write_disarmed") from None
                status = self._core.health()
                if not self._is_exact_ready(status, self._lease_controller.lease):
                    self._disarm()
                    raise CoreAdmissionDenied("runtime_write_disarmed")
                command, permit, command_bytes, permit_bytes = request.values
                value = self._core.admit(
                    command=command,
                    permit=permit,
                    command_payload_bytes=command_bytes,
                    permit_bytes=permit_bytes,
                    expected_environment_identity=self._expected_identity,
                )
            elif request.operation is _Operation.HANDSHAKE:
                self._verify_lease_or_disarm()
                if self._write_disarmed:
                    value = self._read_only_status()
                else:
                    assert self._lease_controller is not None
                    status = self._core.handshake()
                    if not self._is_exact_ready(status, self._lease_controller.lease):
                        self._disarm()
                        value = self._read_only_status()
                    else:
                        value = status
            elif request.operation is _Operation.HEALTH:
                self._verify_lease_or_disarm()
                if self._write_disarmed:
                    value = self._read_only_status()
                else:
                    assert self._lease_controller is not None
                    status = self._core.health()
                    if not self._is_exact_ready(status, self._lease_controller.lease):
                        self._disarm()
                        value = self._read_only_status()
                    else:
                        value = status
            elif request.operation is _Operation.GET_COMMAND:
                value = self._core.get_command(request.values[0])
            elif request.operation is _Operation.GET_OFFLINE_EXECUTION_RECEIPT:
                value = self._core.get_offline_execution_receipt(request.values[0])
            elif request.operation is _Operation.GET_SNAPSHOT:
                value = self._core.get_snapshot(
                    account_id=request.values[0], symbol=request.values[1]
                )
            elif request.operation is _Operation.REPLAY_LIFECYCLE_EVENTS:
                value = self._core.replay_lifecycle_events(
                    after_sequence=request.values[0], limit=request.values[1]
                )
            else:
                raise RuntimeErrorCode("runtime_unavailable")
            request.result.set_result(value)
            if request.operation is _Operation.ADMIT:
                # Completion of this Future is the RuntimeExecutor caller's
                # durable-admission boundary. Simulator work is enqueued only
                # afterwards. A transport may deliver its response bytes later,
                # so this ordering deliberately makes no wire-delivery claim.
                self._enqueue_offline_command(value.receipt.command.command_hash)
        except CoreAdmissionDenied as error:
            if error.reason in {
                "stale_writer_lease",
                "writer_lease_unbound",
                "environment_unavailable",
                "environment_schema_hash_mismatch",
                "environment_run_id_mismatch",
                "environment_identity_mismatch",
                "environment_denied",
                "environment_authority_expired",
                "idempotency_conflict",
                "invalid_now",
                "ledger_rejected",
                "suspended",
            }:
                self._disarm()
                if not request.result.done():
                    request.result.set_exception(
                        CoreAdmissionDenied("runtime_write_disarmed")
                    )
            else:
                if not request.result.done():
                    request.result.set_exception(error)
        except Exception:
            # An unexpected owner-thread failure during a core operation makes
            # the durable outcome or future ledger health uncertain.  Never
            # continue accepting writes in the same process after it.
            self._disarm()
            if not request.result.done():
                request.result.set_exception(RuntimeErrorCode("runtime_unavailable"))

    def _admission_result(
        self, request: _Request, *, timeout: float
    ) -> DurableAdmissionDecision:
        try:
            return request.result.result(timeout=timeout)
        except FutureTimeout:
            if request.result.done():
                return _future_result(request.result, timeout=0)
            if request.result.cancel():
                raise CoreAdmissionDenied("runtime_operation_timeout") from None
            # The owner has already begun the operation.  Its eventual durable
            # outcome is unknown to this caller, so admission is irreversibly
            # disarmed until a new process reconciles by command ID.
            self._disarm()
            raise CoreAdmissionDenied("runtime_submission_unknown") from None
        except CoreAdmissionDenied:
            raise
        except RuntimeErrorCode:
            raise
        except Exception:
            raise RuntimeErrorCode("runtime_unavailable") from None

    def _verify_lease_or_disarm(self) -> None:
        if self._write_disarmed:
            return
        try:
            assert self._lease_controller is not None
            self._lease_controller.require_current()
        except Exception:
            self._disarm()

    def _read_only_status(self) -> CoreStatus:
        """Publish a pinned diagnostic identity without restoring authority.

        This method is reached only through the owner-thread request queue. It
        deliberately avoids the mutable environment provider and never checks,
        renews, or rebinds the lease. The retained epoch is an identity anchor,
        not permission to write.
        """
        if get_ident() != self._owner_thread_id:
            return _disarmed_status()
        try:
            if self._ledger is None or self._lease_controller is None:
                return _disarmed_status()
            latest_sequence = self._ledger.latest_lifecycle_sequence()
            lease = self._lease_controller.lease
            if (
                type(latest_sequence) is not int
                or not 0 <= latest_sequence <= (1 << 64) - 1
                or type(lease.epoch) is not int
                or not 1 <= lease.epoch <= (1 << 64) - 1
            ):
                return _disarmed_status()
        except Exception:
            return _disarmed_status()
        identity = self._expected_identity
        return CoreStatus(
            status="read_only",
            reason="runtime_write_disarmed",
            protocol_version=identity.protocol_version,
            service_id=identity.service_id,
            mode=identity.mode,
            run_id=identity.run_id,
            environment_proof_hash=identity.environment_proof_hash,
            schema_hash=identity.schema_hash,
            writer_epoch=lease.epoch,
            latest_sequence=latest_sequence,
            execution_client_invoked=False,
            broker_submission_enabled=False,
            writer_lease_bound=False,
            resume_supported=False,
        )

    def _is_exact_ready(self, status: CoreStatus, lease: Lease) -> bool:
        identity = self._expected_identity
        return (
            status.status == "ready_for_durable_admission"
            and status.reason is None
            and status.protocol_version == identity.protocol_version
            and status.service_id == identity.service_id
            and status.mode == identity.mode
            and status.run_id == identity.run_id
            and status.environment_proof_hash == identity.environment_proof_hash
            and status.schema_hash == identity.schema_hash
            and status.writer_epoch == lease.epoch
            and status.writer_lease_bound is True
            and status.execution_client_invoked is False
            and status.broker_submission_enabled is False
        )

    def _disarm(self) -> None:
        self._write_disarmed = True
        with self._admission_lock:
            self._admission_open = False
        self._supervisor._set(RuntimeState.WRITE_DISARMED)

    def _request_owner_stop(self, *, clean_release: bool) -> None:
        thread = self._thread
        if thread is None or not thread.is_alive():
            return
        request = _Request(_Operation.STOP, (clean_release,), Future())
        # Admission is closed before this method. FIFO makes every already
        # accepted operation complete before STOP and lease release.
        try:
            self._queue.put(request, timeout=self._shutdown_timeout_seconds)
            request.result.result(timeout=self._shutdown_timeout_seconds)
        except (Full, FutureTimeout):
            raise RuntimeErrorCode("runtime_shutdown_timeout") from None

    def _close_owner(self, *, clean_release: bool) -> None:
        try:
            self._offline_coordinator = None
            self._offline_backlog.clear()
            self._offline_queued.clear()
            if self._offline_simulator is not None:
                try:
                    self._offline_simulator.close()
                finally:
                    self._offline_simulator = None
        finally:
            try:
                if clean_release and self._lease_controller is not None:
                    try:
                        self._lease_controller.release()
                    except (StaleLease, LeaseRejected, RuntimeErrorCode):
                        pass
            finally:
                if self._ledger is not None:
                    try:
                        self._ledger.close()
                    finally:
                        self._ledger = None
                self._core = None
                self._lease_controller = None
                self._settle_pending_requests()

    def _settle_pending_requests(self) -> None:
        """Never strand a gateway caller if an owner exits unexpectedly."""
        while True:
            try:
                request = self._queue.get_nowait()
            except Empty:
                return
            if not request.result.done():
                request.result.set_exception(RuntimeErrorCode("runtime_unavailable"))

    def _join_owner(self, *, timeout: float | None = None) -> bool:
        thread = self._thread
        if thread is not None:
            thread.join(timeout=timeout)
            if thread.is_alive():
                return False
        self._thread = None
        return True

    def _forget_socket_identity(self) -> None:
        """Drop runtime bookkeeping after the safe UDS wrapper has stopped.

        Pathname cleanup belongs exclusively to the wrapper while it holds the
        per-publication file lock.  Repeating a check-then-unlink here would
        reopen a replacement race after that lock was released.
        """
        self._socket_identity = None

    def _owns_socket_path(self) -> bool:
        identity = self._socket_identity
        if identity is None:
            return False
        try:
            current = os.lstat(self._socket_path)
        except OSError:
            return False
        return (
            stat.S_ISSOCK(current.st_mode)
            and current.st_uid == os.getuid()
            and (current.st_dev, current.st_ino) == identity
        )

    def _socket_path_has_different_identity(self) -> bool:
        identity = self._socket_identity
        if identity is None:
            return False
        try:
            current = os.lstat(self._socket_path)
        except FileNotFoundError:
            return False
        except OSError:
            return True
        return (
            not stat.S_ISSOCK(current.st_mode)
            or current.st_uid != os.getuid()
            or (current.st_dev, current.st_ino) != identity
        )


def _future_result(result: Future[Any], *, timeout: float) -> Any:
    try:
        return result.result(timeout=timeout)
    except FutureTimeout:
        raise RuntimeErrorCode("runtime_operation_timeout") from None
    except CoreAdmissionDenied:
        raise
    except RuntimeErrorCode:
        raise
    except Exception:
        raise RuntimeErrorCode("runtime_unavailable") from None


def _disarmed_status() -> CoreStatus:
    return CoreStatus(status="unavailable", reason="runtime_write_disarmed")


def _freeze_offline_execution_runtime_config(
    value: OfflineExecutionRuntimeConfig | None,
) -> _FrozenOfflineExecutionRuntimeConfig | None:
    """Validate and snapshot every local execution authority before start."""
    if value is None:
        return None
    if not isinstance(value, OfflineExecutionRuntimeConfig):
        raise ValueError("invalid_runtime_configuration")
    try:
        if not isinstance(value.policy, Mapping):
            raise TypeError
        policy = Ledger._offline_adapter_policy(deepcopy(dict(value.policy)))
        if (
            policy["schemaVersion"] != "openalice_offline_adapter_policy.v3"
            or policy["mode"] != "PAPER_LOCAL"
        ):
            raise ValueError
        policy_json = stable_stringify(policy)
        policy_hash = sha256_canonical(policy)
        simulator_database_path = _absolute_path(value.simulator_database_path)
        private_keys = (
            value.capability_authority_private_key,
            value.receipt_signing_private_key,
            value.source_attestation_private_key,
        )
        if any(not isinstance(key, Ed25519PrivateKey) for key in private_keys):
            raise TypeError
        if (
            value.capability_authority_key_id
            != policy["simulatorCapabilityAuthorityKeyId"]
            or value.receipt_signing_key_id != policy["adapterKeyId"]
            or value.source_attestation_key_id != policy["sourceAttestationKeyId"]
        ):
            raise ValueError
        permit_public_key = load_ed25519_public_key(value.permit_public_key)
        capability_public_key = value.capability_authority_private_key.public_key()
        receipt_public_key = value.receipt_signing_private_key.public_key()
        source_public_key = value.source_attestation_private_key.public_key()
        expected_fingerprints = {
            "permitAuthorityPublicKeySpkiSha256": permit_public_key,
            "simulatorCapabilityAuthorityPublicKeySpkiSha256": (capability_public_key),
            "adapterPublicKeySpkiSha256": receipt_public_key,
            "sourceAttestationPublicKeySpkiSha256": source_public_key,
        }
        if any(
            ed25519_public_key_fingerprint_sha256(public_key) != policy[field_name]
            for field_name, public_key in expected_fingerprints.items()
        ):
            raise ValueError
    except Exception:
        raise ValueError("invalid_runtime_configuration") from None
    return _FrozenOfflineExecutionRuntimeConfig(
        policy_json=policy_json,
        policy_hash=policy_hash,
        simulator_database_path=simulator_database_path,
        permit_public_key=permit_public_key,
        capability_authority_key_id=value.capability_authority_key_id,
        capability_authority_private_key=value.capability_authority_private_key,
        capability_public_key=capability_public_key,
        receipt_signing_key_id=value.receipt_signing_key_id,
        receipt_signing_private_key=value.receipt_signing_private_key,
        receipt_public_key=receipt_public_key,
        source_attestation_key_id=value.source_attestation_key_id,
        source_attestation_private_key=value.source_attestation_private_key,
        source_public_key=source_public_key,
    )


def _valid_runtime_identity(value: Any) -> bool:
    if not isinstance(value, RuntimeIdentity):
        return False
    hashes = (value.environment_proof_hash, value.schema_hash)
    return (
        value.mode in {"PAPER_LOCAL", "PAPER_EXCHANGE"}
        and isinstance(value.run_id, str)
        and bool(value.run_id)
        and value.run_id == value.run_id.strip()
        and len(value.run_id) <= 300
        and all(
            isinstance(item, str)
            and len(item) == 64
            and all(character in "0123456789abcdef" for character in item)
            for item in hashes
        )
        and value.protocol_version == "openalice.execution.v1"
        and value.service_id == "openalice.nautilus_paper.durable_admission"
    )


def _positive_finite_number(value: Any) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
        and value > 0
    )


def _absolute_path(value: str | Path) -> Path:
    try:
        raw = os.fspath(value)
    except TypeError:
        raise ValueError("unsafe_runtime_path") from None
    if not isinstance(raw, str) or "\x00" in raw or not os.path.isabs(raw):
        raise ValueError("unsafe_runtime_path")
    return Path(os.path.normpath(raw))


def _validate_start_paths(
    database_path: Path,
    socket_path: Path,
    *,
    simulator_database_path: Path | None = None,
) -> None:
    _validate_private_directory(database_path.parent)
    _validate_private_directory(socket_path.parent)
    _reject_symlink_ancestors(database_path.parent)
    _reject_symlink_ancestors(socket_path.parent)
    if simulator_database_path is not None:
        _validate_private_directory(simulator_database_path.parent)
        _reject_symlink_ancestors(simulator_database_path.parent)
    try:
        socket_path.lstat()
    except FileNotFoundError:
        pass
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_path") from None
    else:
        # Do not unlink stale sockets: an existing inode is an explicit failure.
        raise RuntimeErrorCode("runtime_socket_already_exists")
    try:
        entry: os.stat_result | None = database_path.lstat()
    except FileNotFoundError:
        entry = None
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_path") from None
    if entry is not None and (
        not stat.S_ISREG(entry.st_mode)
        or entry.st_uid != os.getuid()
        or entry.st_mode & 0o077
    ):
        raise RuntimeErrorCode("unsafe_runtime_path")
    if simulator_database_path is not None:
        simulator_entry = _require_private_existing_file(simulator_database_path)
        if entry is not None and (entry.st_dev, entry.st_ino) == (
            simulator_entry.st_dev,
            simulator_entry.st_ino,
        ):
            raise RuntimeErrorCode("unsafe_runtime_path")


def _require_private_existing_file(path: Path) -> os.stat_result:
    try:
        entry = path.lstat()
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_path") from None
    if (
        not stat.S_ISREG(entry.st_mode)
        or entry.st_uid != os.getuid()
        or entry.st_mode & 0o077
    ):
        raise RuntimeErrorCode("unsafe_runtime_path")
    return entry


def _validate_private_directory(path: Path) -> None:
    try:
        entry = path.lstat()
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_path") from None
    if (
        stat.S_ISLNK(entry.st_mode)
        or not stat.S_ISDIR(entry.st_mode)
        or entry.st_uid != os.getuid()
        or entry.st_mode & 0o077
    ):
        raise RuntimeErrorCode("unsafe_runtime_path")


def _reject_symlink_ancestors(path: Path) -> None:
    # The root is necessarily not user-owned/private, and is the sole allowed
    # exception.  Every other lexical ancestor is checked without resolving it.
    current = Path("/")
    for part in path.parts[1:]:
        current /= part
        try:
            entry = current.lstat()
        except OSError:
            raise RuntimeErrorCode("unsafe_runtime_path") from None
        if stat.S_ISLNK(entry.st_mode):
            raise RuntimeErrorCode("unsafe_runtime_path")


def _secure_database_after_open(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
        entry = path.lstat()
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_path") from None
    if (
        not stat.S_ISREG(entry.st_mode)
        or entry.st_uid != os.getuid()
        or entry.st_mode & 0o077
    ):
        raise RuntimeErrorCode("unsafe_runtime_path")


def _secure_started_socket(path: Path) -> tuple[int, int]:
    try:
        entry = path.lstat()
        if not stat.S_ISSOCK(entry.st_mode) or entry.st_uid != os.getuid():
            raise OSError
        os.chmod(path, 0o600)
        entry = path.lstat()
    except OSError:
        raise RuntimeErrorCode("unsafe_runtime_socket") from None
    if (
        not stat.S_ISSOCK(entry.st_mode)
        or entry.st_uid != os.getuid()
        or stat.S_IMODE(entry.st_mode) != 0o600
    ):
        raise RuntimeErrorCode("unsafe_runtime_socket")
    return entry.st_dev, entry.st_ino
