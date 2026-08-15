"""Deterministic lease-expiry recovery tests for the paper runtime.

These are deliberately runtime-level tests.  The clock is supplied only when
the runtime/ledger is constructed; barriers merely choose the instant at which
that already-pinned authority clock crosses the held lease's expiry.  They do
not add a request-level clock or use timing sleeps.
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from threading import Event
from tempfile import TemporaryDirectory
from typing import Any, Iterator

import pytest

import sidecars.nautilus_paper.runtime as runtime_module

from sidecars.nautilus_paper.core import CoreAdmissionDenied
from sidecars.nautilus_paper.ledger import Ledger, Lease, StaleLease
from sidecars.nautilus_paper.offline_simulator import OfflineSimulatorStore
from sidecars.nautilus_paper.runtime import (
    RuntimeErrorCode,
    RuntimeExecutor,
    RuntimeState,
)
from sidecars.nautilus_paper.test_runtime import (
    NOW,
    _admit_offline,
    _offline_config,
    _offline_factory,
    _offline_identity,
    _offline_item,
    _private_dir,
    _provision_offline_store,
    canonical_bytes,
)


class _MutableFencingClock:
    """One constructor-pinned wall/fencing clock shared by each test runtime."""

    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value

    def expire(self, lease: Lease) -> None:
        # Lease validity is a strict ``expires_at > now`` comparison.
        self.value = lease.expires_at + 0.001


@pytest.fixture
def short_path() -> Iterator[Path]:
    """Use a short private directory because macOS constrains UDS path length."""
    with TemporaryDirectory(dir="/private/tmp", prefix="np-") as temporary:
        path = Path(temporary)
        path.chmod(0o700)
        yield path


class _ExpiryBarrier:
    """A deterministic owner-thread pause, controlled by the test thread."""

    def __init__(self, clock: _MutableFencingClock) -> None:
        self.clock = clock
        self.entered = Event()
        self.release = Event()
        self.stale_errors: list[str] = []

    def expire_before_ledger_begin(self, lease: Lease) -> None:
        self.entered.set()
        assert self.release.wait(3), "test barrier was not released"
        self.clock.expire(lease)


class _InertServer:
    """Test-only UDS publication stand-in; no socket or network is opened."""

    preserves_replaced_public_socket_on_stop = True
    published_identity = (1, 1)

    def start(self) -> None:
        return None

    def stop(self, _grace: int) -> "_InertServer":
        return self

    def wait(self, *, timeout: float) -> bool:
        del timeout
        return True


def _inert_server_factory(**_kwargs: Any) -> _InertServer:
    return _InertServer()


@contextmanager
def _inert_uds(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep the lease tests offline when the host forbids AF_UNIX binding."""
    monkeypatch.setattr(runtime_module, "_secure_started_socket", lambda _path: (1, 1))
    monkeypatch.setattr(RuntimeExecutor, "_owns_socket_path", lambda _self: True)
    monkeypatch.setattr(
        RuntimeExecutor,
        "_socket_path_has_different_identity",
        lambda _self: False,
    )
    yield


def _sqlite_counts(database: Path) -> dict[str, int]:
    tables = (
        "execution_reconciliation_claims",
        "offline_execution_receipts",
        "offline_source_store_heads",
        "lifecycle_events",
        "offline_simulator_capabilities",
    )
    with sqlite3.connect(database) as connection:
        return {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in tables
        }


def _simulator_counts(database: Path) -> dict[str, int]:
    tables = (
        "simulated_orders",
        "simulator_events",
        "simulator_capability_uses",
    )
    with sqlite3.connect(database) as connection:
        return {
            table: int(connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in tables
        }


def _dispatch_state(database: Path, command_hash: str) -> str:
    with sqlite3.connect(database) as connection:
        row = connection.execute(
            "SELECT state FROM execution_dispatches WHERE command_hash = ?",
            (command_hash,),
        ).fetchone()
    assert row is not None
    return str(row[0])


def _seed_old_epoch_inflight(
    run: Path,
    *,
    clock: _MutableFencingClock,
    source_effect: bool,
) -> tuple[Any, str]:
    """Create a crashed-owner dispatch without using a production runtime."""
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    ledger = Ledger(
        run / "ledger.sqlite3",
        fencing_clock=clock,
        offline_capability_authority_private_key=config.capability_authority_private_key,
        offline_capability_authority_key_id=config.capability_authority_key_id,
        offline_receipt_signing_private_key=config.receipt_signing_private_key,
        offline_receipt_signing_key_id=config.receipt_signing_key_id,
        offline_source_attestation_public_keys={
            config.source_attestation_key_id: (
                config.source_attestation_private_key.public_key()
            )
        },
    )
    simulator: OfflineSimulatorStore | None = None
    try:
        lease = ledger.acquire_writer_lease(
            name="nautilus-paper-runtime",
            owner_id="crashed-owner",
            ttl_seconds=30,
        )
        registered = ledger.register_offline_adapter_policy(
            policy=config.policy,
            writer_lease=lease,
        )
        core = _offline_factory(config)(ledger, lease)
        core.freeze_expected_public_keys()
        core.bind_writer_lease(lease)
        item = _offline_item(suffix="lease-expiry-recovery")
        admitted = core.admit(
            command=item["command"],
            permit=item["permit"],
            command_payload_bytes=canonical_bytes(item["command"]["payload"]),
            permit_bytes=canonical_bytes(item["permit"]),
        )
        command_hash = admitted.receipt.command.command_hash
        attempt = ledger.claim_offline_dispatch(
            command_hash=command_hash,
            writer_lease=lease,
            permit_public_key=config.permit_public_key,
        )
        assert registered.policy_hash == attempt.policy_hash
        if source_effect:
            simulator = OfflineSimulatorStore(
                config.simulator_database_path,
                store_id=config.policy["simulatorStoreId"],
                capability_public_keys={
                    config.capability_authority_key_id: (
                        config.capability_authority_private_key.public_key()
                    )
                },
                source_attestation_key_id=config.source_attestation_key_id,
                source_attestation_private_key=config.source_attestation_private_key,
                capability_clock=lambda: datetime.fromtimestamp(
                    clock(), timezone.utc
                ),
                allow_provision=False,
            )
            capability = ledger.issue_offline_simulator_capability(
                command_hash=command_hash,
                writer_lease=lease,
            )
            simulator.ensure_exact(
                attempt.request,
                canonical_capability_json_utf8=capability.capability_json.encode(
                    "utf-8"
                ),
            )
        ledger.release_writer_lease(lease)
        return config, command_hash
    finally:
        if simulator is not None:
            simulator.close()
        ledger.close()
        (run / "ledger.sqlite3").chmod(0o600)


def _runtime(run: Path, config: Any, clock: _MutableFencingClock) -> RuntimeExecutor:
    return RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_offline_factory(config),
        expected_identity=_offline_identity(),
        offline_execution=config,
        wall_clock=clock,
        ttl_seconds=1,
        server_factory=_inert_server_factory,
    )


@contextmanager
def _expire_before_ledger_begin(
    monkeypatch: pytest.MonkeyPatch,
    *,
    method_name: str,
    barrier: _ExpiryBarrier,
) -> Iterator[None]:
    """Pause after runtime/coordinator preflight but before the write ``BEGIN``."""
    original_method = getattr(Ledger, method_name)

    def scoped_write(self: Ledger, *args: Any, **kwargs: Any) -> Any:
        lease = kwargs["writer_lease"]
        assert isinstance(lease, Lease)
        barrier.expire_before_ledger_begin(lease)
        try:
            return original_method(self, *args, **kwargs)
        except StaleLease as error:
            barrier.stale_errors.append(str(error))
            raise

    monkeypatch.setattr(Ledger, method_name, scoped_write)
    try:
        yield
    finally:
        # The recovery replacement must exercise the genuine Ledger method;
        # pytest's fixture-level undo would otherwise leave this barrier live
        # until the entire test returns.
        setattr(Ledger, method_name, original_method)


def _start_fails_through_barrier(
    runtime: RuntimeExecutor,
    barrier: _ExpiryBarrier,
) -> None:
    with ThreadPoolExecutor(max_workers=1) as pool:
        started = pool.submit(runtime.start)
        assert barrier.entered.wait(3), "recovery did not reach the requested write"
        barrier.release.set()
        with pytest.raises(RuntimeErrorCode, match="runtime_startup_failed"):
            started.result(timeout=3)
    assert runtime.supervisor.state is RuntimeState.STOPPED
    assert runtime._server is None
    assert runtime._request_open is False
    assert runtime._admission_open is False
    assert barrier.stale_errors


def _assert_disarmed_reads(runtime: RuntimeExecutor, command_hash: str) -> None:
    status = runtime.health()
    assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
    assert (status.status, status.reason) == ("read_only", "runtime_write_disarmed")
    assert runtime.get_command(command_hash) is not None
    assert runtime.get_offline_execution_receipt("f" * 64) is None
    assert len(runtime.replay_lifecycle_events(after_sequence=0)) == 1
    with pytest.raises(CoreAdmissionDenied, match="runtime_write_disarmed"):
        _admit_offline(runtime, suffix="write-after-expiry")


def test_startup_existing_effect_receipt_anchor_lifecycle_commit_fails_closed(
    short_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Existing-effect recovery cannot write receipt, head, or lifecycle state."""
    run = _private_dir(short_path / "e")
    clock = _MutableFencingClock(NOW.timestamp())
    config, command_hash = _seed_old_epoch_inflight(
        run,
        clock=clock,
        source_effect=True,
    )
    before_ledger = _sqlite_counts(run / "ledger.sqlite3")
    before_simulator = _simulator_counts(config.simulator_database_path)
    runtime = _runtime(run, config, clock)
    barrier = _ExpiryBarrier(clock)
    with _expire_before_ledger_begin(
        monkeypatch,
        method_name="commit_offline_execution_receipt",
        barrier=barrier,
    ), _inert_uds(monkeypatch):
        _start_fails_through_barrier(runtime, barrier)
    # Marking and claiming reconciliation both precede the commit cut point
    # and were still authorized. The expired commit itself added no receipt,
    # global-store head, or terminal lifecycle record.
    assert _sqlite_counts(run / "ledger.sqlite3") == {
        **before_ledger,
        "execution_reconciliation_claims": (
            before_ledger["execution_reconciliation_claims"] + 1
        ),
    }
    assert _dispatch_state(run / "ledger.sqlite3", command_hash) == (
        "RECONCILIATION_REQUIRED"
    )
    assert _simulator_counts(config.simulator_database_path) == before_simulator
    replacement = _runtime(run, config, clock)
    with _inert_uds(monkeypatch):
        replacement.start()
    try:
        assert replacement.supervisor.state is RuntimeState.DURABLE_UDS_READY
        assert _sqlite_counts(run / "ledger.sqlite3")[
            "offline_execution_receipts"
        ] == 1
        assert replacement.get_command(command_hash) is not None
    finally:
        replacement.stop()


def test_startup_missing_effect_mark_fails_closed_before_begin_expiry(
    short_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A stale recovery lease cannot mark an old effect as reconcilable."""
    run = _private_dir(short_path / "m")
    clock = _MutableFencingClock(NOW.timestamp())
    config, command_hash = _seed_old_epoch_inflight(
        run,
        clock=clock,
        source_effect=False,
    )
    before_ledger = _sqlite_counts(run / "ledger.sqlite3")
    before_simulator = _simulator_counts(config.simulator_database_path)
    runtime = _runtime(run, config, clock)
    barrier = _ExpiryBarrier(clock)
    with _expire_before_ledger_begin(
        monkeypatch,
        method_name="mark_reconciliation_required",
        barrier=barrier,
    ), _inert_uds(monkeypatch):
        _start_fails_through_barrier(runtime, barrier)
    assert _sqlite_counts(run / "ledger.sqlite3") == before_ledger
    assert _dispatch_state(run / "ledger.sqlite3", command_hash) == "IN_FLIGHT"
    assert _simulator_counts(config.simulator_database_path) == before_simulator
    replacement = _runtime(run, config, clock)
    with _inert_uds(monkeypatch):
        replacement.start()
    try:
        _assert_disarmed_reads(replacement, command_hash)
        assert _sqlite_counts(run / "ledger.sqlite3") == before_ledger
        assert _simulator_counts(config.simulator_database_path) == before_simulator
    finally:
        replacement.stop()


def test_startup_reconciliation_claim_fails_closed_before_begin_expiry(
    short_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An existing source effect cannot receive a stale active claim."""
    run = _private_dir(short_path / "c")
    clock = _MutableFencingClock(NOW.timestamp())
    config, command_hash = _seed_old_epoch_inflight(
        run,
        clock=clock,
        source_effect=True,
    )
    before_ledger = _sqlite_counts(run / "ledger.sqlite3")
    before_simulator = _simulator_counts(config.simulator_database_path)
    runtime = _runtime(run, config, clock)
    barrier = _ExpiryBarrier(clock)
    with _expire_before_ledger_begin(
        monkeypatch,
        method_name="claim_offline_reconciliation",
        barrier=barrier,
    ), _inert_uds(monkeypatch):
        _start_fails_through_barrier(runtime, barrier)
    after = _sqlite_counts(run / "ledger.sqlite3")
    assert after == before_ledger
    # The preceding mark was legal; the expired transaction did not add the
    # ACTIVE claim, receipt, source-store head, or lifecycle event.
    assert _dispatch_state(run / "ledger.sqlite3", command_hash) == (
        "RECONCILIATION_REQUIRED"
    )
    assert _simulator_counts(config.simulator_database_path) == before_simulator


def test_rebind_cannot_authorize_a_later_dispatch_claim_after_expiry(
    short_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A renewal/rebind never lets its newly bound lease outlive the fence."""
    run = _private_dir(short_path / "r")
    config = _offline_config(run / "simulator.sqlite3")
    _provision_offline_store(config.simulator_database_path, config)
    clock = _MutableFencingClock(NOW.timestamp())
    monotonic = [10.0]
    actual = runtime_module.OfflineExecutionCoordinator
    rebound = Event()

    class _RecordingCoordinator:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            self._inner = actual(*args, **kwargs)

        def bind_writer_lease(self, lease: Lease) -> None:
            rebound.set()
            self._inner.bind_writer_lease(lease)

        def execute_or_recover(self, command_hash: str) -> Any:
            return self._inner.execute_or_recover(command_hash)

    monkeypatch.setattr(runtime_module.time, "monotonic", lambda: monotonic[0])
    monkeypatch.setattr(runtime_module, "OfflineExecutionCoordinator", _RecordingCoordinator)
    runtime = RuntimeExecutor(
        run / "ledger.sqlite3",
        run / "admission.sock",
        core_factory=_offline_factory(config),
        expected_identity=_offline_identity(),
        offline_execution=config,
        wall_clock=clock,
        ttl_seconds=3,
        server_factory=_inert_server_factory,
    )
    barrier = _ExpiryBarrier(clock)
    with _expire_before_ledger_begin(
        monkeypatch,
        method_name="claim_offline_dispatch",
        barrier=barrier,
    ), _inert_uds(monkeypatch):
        runtime.start()
        try:
            monotonic[0] = 11.1
            assert runtime.health().status == "ready_for_durable_admission"
            assert rebound.wait(3), "runtime did not rebind after renewal"
            decision = _admit_offline(runtime, suffix="after-renewal-expiry")
            assert decision.disposition == "accepted_durable_not_submitted"
            assert barrier.entered.wait(3), "post-rebind dispatch did not begin"
            barrier.release.set()
            assert runtime.health().reason == "runtime_write_disarmed"
            assert runtime.supervisor.state is RuntimeState.WRITE_DISARMED
            with sqlite3.connect(run / "ledger.sqlite3") as connection:
                dispatch = connection.execute(
                    "SELECT state FROM execution_dispatches WHERE command_hash = ?",
                    (decision.receipt.command.command_hash,),
                ).fetchone()
                assert dispatch == ("DISPATCH_PENDING",)
                assert connection.execute(
                    "SELECT COUNT(*) FROM offline_execution_receipts"
                ).fetchone() == (0,)
                assert connection.execute(
                    "SELECT COUNT(*) FROM offline_source_store_heads"
                ).fetchone() == (0,)
                assert connection.execute(
                    "SELECT COUNT(*) FROM lifecycle_events"
                ).fetchone() == (1,)
            assert _simulator_counts(config.simulator_database_path) == {
                "simulated_orders": 0,
                "simulator_events": 0,
                "simulator_capability_uses": 0,
            }
            assert runtime.get_command(decision.receipt.command.command_hash) is not None
        finally:
            barrier.release.set()
            runtime.stop()
