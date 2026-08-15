"""Tests for the fail-closed Nautilus paper ledger."""

from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sqlite3
import time

import pytest

from sidecars.nautilus_paper.ledger import (
    EnvironmentAuthorityExpired,
    IdempotencyConflict,
    Ledger,
    LedgerError,
    LeaseRejected,
    MalformedLifecycleRecord,
    SnapshotCursorAhead,
    SnapshotRegression,
    PayloadHashMismatch,
    PermitAuthorityExpired,
    RuntimeSuspended,
    StaleLease,
)
from sidecars.nautilus_paper.contract import stable_stringify


def payload_hash(payload) -> str:
    canonical = json.dumps(
        payload,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def fixture_contract() -> dict:
    fixture_path = (
        Path(__file__).resolve().parents[2]
        / "src/sidecar/fixtures/openalice_execution_contract_v1.json"
    )
    return json.loads(fixture_path.read_text(encoding="utf-8"))


def command_for_payload(payload: dict) -> dict:
    digest = payload_hash(payload)
    return {
        "schemaVersion": "openalice_execution_command.v1",
        "commandId": digest,
        "payloadHash": digest,
        "payload": payload,
    }


class MutableFencingClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


@pytest.fixture
def ledger(tmp_path):
    clock = MutableFencingClock(time.time())
    instance = Ledger(
        tmp_path / "ledger.sqlite3", busy_timeout_ms=1_234, fencing_clock=clock
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    yield instance
    instance.close()


@pytest.fixture
def writer_lease(ledger: Ledger):
    return ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=10_000
    )


def test_durability_pragmas_and_required_tables(ledger: Ledger) -> None:
    assert ledger.pragma_settings() == {
        "journal_mode": "wal",
        "synchronous": 2,  # SQLite FULL
        "foreign_keys": 1,
        "busy_timeout": 1_234,
    }
    assert ledger.counts() == {
        "commands": 0,
        "events": 0,
        "writer_lease": 0,
        "runtime_state": 0,
    }


def test_same_idempotency_key_and_hash_returns_original_without_second_event(
    ledger: Ledger, writer_lease
) -> None:
    payload = {"symbol": "BTC-USDT", "target": 0}
    first = ledger.submit_command(
        idempotency_key="decision-1",
        payload_hash=payload_hash(payload),
        command_type="target_position",
        payload=payload,
        writer_lease=writer_lease,
        now=100.0,
    )
    repeated = ledger.submit_command(
        idempotency_key="decision-1",
        payload_hash=payload_hash(payload),
        command_type="target_position",
        payload={"target": 0, "symbol": "BTC-USDT"},
        writer_lease=writer_lease,
        now=101.0,
    )

    assert first.created is True
    assert repeated.created is False
    assert repeated.command == first.command
    assert repeated.command.payload == {"symbol": "BTC-USDT", "target": 0}
    assert ledger.counts() == {
        "commands": 1,
        "events": 1,
        "writer_lease": 1,
        "runtime_state": 0,
    }


def test_idempotency_hash_conflict_suspends_and_records_circuit_reason(
    ledger: Ledger, writer_lease
) -> None:
    original_payload = {"target": 0}
    original = ledger.submit_command(
        idempotency_key="decision-2",
        payload_hash=payload_hash(original_payload),
        command_type="target_position",
        payload=original_payload,
        writer_lease=writer_lease,
        now=100.0,
    )

    # Reusing the old declared hash cannot hide the changed canonical payload.
    with pytest.raises(IdempotencyConflict):
        ledger.submit_command(
            idempotency_key="decision-2",
            payload_hash=payload_hash(original_payload),
            command_type="target_position",
            payload={"target": 1},
            writer_lease=writer_lease,
            now=101.0,
        )

    assert ledger.counts() == {
        "commands": 1,
        "events": 2,
        "writer_lease": 1,
        "runtime_state": 1,
    }
    assert ledger.runtime_state() == {
        "state_key": "global",
        "mode": "suspended",
        "circuit_reason": "idempotency_key_payload_hash_mismatch",
        "updated_at": 101.0,
    }
    conflict = ledger.replay(after_cursor=1)
    assert len(conflict) == 1
    assert conflict[0].event_type == "idempotency_conflict"
    assert conflict[0].command_id == original.command.id
    assert conflict[0].payload["existing_payload_hash"] == payload_hash(original_payload)
    assert conflict[0].payload["received_payload_hash"] == payload_hash({"target": 1})
    assert conflict[0].payload["declared_payload_hash"] == payload_hash(original_payload)

    # Exact replays remain readable, but the suspended circuit admits no new key.
    replay = ledger.submit_command(
        idempotency_key="decision-2",
        payload_hash=payload_hash(original_payload),
        command_type="target_position",
        payload=original_payload,
        writer_lease=writer_lease,
        now=102.0,
    )
    assert replay.created is False
    assert replay.command == original.command

    with pytest.raises(RuntimeSuspended, match="idempotency_key_payload_hash_mismatch"):
        ledger.submit_command(
            idempotency_key="decision-4",
            payload_hash=payload_hash({"target": 0}),
            command_type="target_position",
            payload={"target": 0},
            writer_lease=writer_lease,
            now=103.0,
        )

    assert ledger.counts() == {
        "commands": 1,
        "events": 2,
        "writer_lease": 1,
        "runtime_state": 1,
    }


def test_unicode_canonical_json_uses_unescaped_utf8_and_sorted_keys(ledger: Ledger, writer_lease) -> None:
    payload = {"z": "中文", "a": "é", "nested": {"beta": 1, "alpha": True}}
    expected_json = '{"a":"é","nested":{"alpha":true,"beta":1},"z":"中文"}'
    expected_hash = hashlib.sha256(expected_json.encode("utf-8")).hexdigest()

    receipt = ledger.submit_command(
        idempotency_key="unicode-1",
        payload_hash=expected_hash,
        command_type="target_position",
        payload=payload,
        writer_lease=writer_lease,
        now=100.0,
    )

    assert payload_hash(payload) == expected_hash
    assert receipt.command.payload_json == expected_json
    assert receipt.command.payload_hash == expected_hash


def test_new_key_declared_hash_mismatch_has_no_command_or_event_side_effect(ledger: Ledger, writer_lease) -> None:
    payload = {"target": 0}
    declared_but_wrong = "0" * 64
    assert declared_but_wrong != payload_hash(payload)

    with pytest.raises(PayloadHashMismatch):
        ledger.submit_command(
            idempotency_key="new-mismatch",
            payload_hash=declared_but_wrong,
            command_type="target_position",
            payload=payload,
            writer_lease=writer_lease,
            now=100.0,
        )

    assert ledger.counts() == {
        "commands": 0,
        "events": 0,
        "writer_lease": 1,
        "runtime_state": 0,
    }


def test_second_owner_is_rejected_until_the_writer_lease_expires(ledger: Ledger) -> None:
    clock = ledger._test_fencing_clock  # type: ignore[attr-defined]
    clock.value = 100.0
    first = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=30
    )
    clock.value = 129.999
    with pytest.raises(LeaseRejected):
        ledger.acquire_writer_lease(
            name="paper-writer", owner_id="owner-b", ttl_seconds=30
        )
    clock.value = 130.0
    replacement = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-b", ttl_seconds=30
    )
    assert first.epoch == 1
    assert replacement.epoch == 2


def test_acquire_samples_injected_clock_only_after_write_transaction_begins(
    ledger: Ledger, monkeypatch: pytest.MonkeyPatch
) -> None:
    transaction_started = False
    original_transaction = ledger._transaction  # type: ignore[attr-defined]

    @contextmanager
    def observed_transaction():
        nonlocal transaction_started
        with original_transaction() as connection:
            transaction_started = True
            yield connection

    def fencing_clock() -> float:
        assert transaction_started is True
        return 100.0

    ledger._fencing_clock = fencing_clock  # type: ignore[attr-defined]
    monkeypatch.setattr(ledger, "_transaction", observed_transaction)
    acquired = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=30
    )
    assert acquired.expires_at == 130.0


def test_stale_epoch_is_fenced_after_lease_takeover(ledger: Ledger) -> None:
    clock = ledger._test_fencing_clock  # type: ignore[attr-defined]
    clock.value = 100.0
    first = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=10
    )
    clock.value = 110.0
    second = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-b", ttl_seconds=10
    )

    with pytest.raises(StaleLease):
        ledger.append_event("old_writer", {}, writer_lease=first, now=110.0)
    with pytest.raises(StaleLease):
        ledger.require_current_writer_lease(first)
    ledger.require_current_writer_lease(second)
    accepted = ledger.append_event(
        "new_writer",
        {},
        writer_lease=second,
        now=110.0,
    )
    assert accepted.cursor == 1
    assert [event.event_type for event in ledger.replay()] == ["new_writer"]


def test_clean_release_expires_current_lease_and_preserves_epoch_fencing(
    ledger: Ledger,
) -> None:
    clock = ledger._test_fencing_clock  # type: ignore[attr-defined]
    clock.value = 100.0
    first = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=30
    )
    clock.value = 101.0
    released = ledger.release_writer_lease(first)

    assert released.epoch == first.epoch
    assert released.expires_at == 101.0
    with pytest.raises(StaleLease):
        ledger.require_current_writer_lease(first)
    replacement = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-b", ttl_seconds=30
    )
    assert replacement.epoch == first.epoch + 1
    with pytest.raises(StaleLease):
        ledger.append_event("released_writer", {}, writer_lease=first, now=101.0)


def test_events_have_monotonic_cursors_and_replay_after_cursor(ledger: Ledger, writer_lease) -> None:
    first = ledger.append_event("first", {"n": 1}, writer_lease=writer_lease, now=100.0)
    second = ledger.append_event("second", {"n": 2}, writer_lease=writer_lease, now=101.0)
    third = ledger.append_event("third", {"n": 3}, writer_lease=writer_lease, now=102.0)

    assert [first.cursor, second.cursor, third.cursor] == [1, 2, 3]
    assert [event.cursor for event in ledger.replay(after_cursor=first.cursor)] == [2, 3]
    assert [event.event_type for event in ledger.replay(after_cursor=second.cursor, limit=1)] == ["third"]


def test_deterministic_event_time_is_independent_of_default_fencing_clock(
    ledger: Ledger, writer_lease
) -> None:
    event = ledger.append_event("event_time", {}, writer_lease=writer_lease, now=123.0)

    assert event.created_at == 123.0


def test_per_call_lease_clock_is_rejected_before_any_write(ledger: Ledger, writer_lease) -> None:
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        ledger.append_event(
            "caller_clock",
            {},
            writer_lease=writer_lease,
            now=1.0,
            **{"lease_clock": lambda: 0.0},
        )
    assert ledger.latest_cursor() == 0


@pytest.mark.parametrize(
    "api_name",
    (
        "submit_command",
        "upsert_snapshot",
        "suspend",
        "admit_execution_command",
        "append_event",
        "append_events_atomically",
    ),
)
def test_expired_trusted_clock_rejects_backdated_event_times_without_writes(
    ledger: Ledger, api_name: str
) -> None:
    clock = ledger._test_fencing_clock  # type: ignore[attr-defined]
    clock.value = 0.0
    expired_lease = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=10
    )
    clock.value = 10.0
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]
    command_payload = {"target": 0}

    operations = {
        "submit_command": lambda: ledger.submit_command(
            idempotency_key="backdated-command",
            payload_hash=payload_hash(command_payload),
            command_type="target_position",
            payload=command_payload,
            writer_lease=expired_lease,
            now=1.0,
        ),
        "upsert_snapshot": lambda: ledger.upsert_snapshot(
            account_id="paper-1",
            symbol="BTC-USDT",
            snapshot={"equity": 1000},
            as_of_cursor=0,
            writer_lease=expired_lease,
            now=1.0,
        ),
        "suspend": lambda: ledger.suspend(
            "backdated-suspend",
            writer_lease=expired_lease,
            now=1.0,
        ),
        "admit_execution_command": lambda: ledger.admit_execution_command(
            command=command,
            permit=permit,
            writer_lease=expired_lease,
            now=1.0,
        ),
        "append_event": lambda: ledger.append_event(
            "backdated-event",
            {},
            writer_lease=expired_lease,
            now=1.0,
        ),
        "append_events_atomically": lambda: ledger.append_events_atomically(
            [("backdated-batch-event", {}, None)],
            writer_lease=expired_lease,
            now=1.0,
        ),
    }
    expected_counts = {
        "commands": 0,
        "events": 0,
        "writer_lease": 1,
        "runtime_state": 0,
    }

    with pytest.raises(StaleLease):
        operations[api_name]()
    assert ledger.counts() == expected_counts
    assert ledger.get_snapshot(account_id="paper-1", symbol="BTC-USDT") is None
    assert ledger.get_command_by_hash(command["commandId"]) is None


@pytest.mark.parametrize("invalid_time", (float("nan"), float("inf"), True, "10"))
def test_invalid_fencing_clock_never_authorizes_a_write(
    ledger: Ledger, writer_lease, invalid_time: object
) -> None:
    ledger._fencing_clock = lambda: invalid_time  # type: ignore[attr-defined,return-value]
    with pytest.raises(ValueError, match="fencing_clock"):
        ledger.append_event(
            "invalid-clock",
            {},
            writer_lease=writer_lease,
            now=1.0,
        )
    assert ledger.latest_cursor() == 0


@pytest.mark.parametrize(
    ("environment_expires_at", "permit_expires_at", "expected_exception"),
    (
        (10.0, 20.0, EnvironmentAuthorityExpired),
        (20.0, 10.0, PermitAuthorityExpired),
        (10.0, 10.0, EnvironmentAuthorityExpired),
    ),
    ids=("environment", "permit", "environment_precedes_permit"),
)
@pytest.mark.parametrize("duplicate", (False, True), ids=("new", "duplicate"))
def test_admission_authority_expiry_uses_post_lock_clock_without_writes(
    ledger: Ledger,
    monkeypatch: pytest.MonkeyPatch,
    environment_expires_at: float,
    permit_expires_at: float,
    expected_exception: type[LedgerError],
    duplicate: bool,
) -> None:
    clock = ledger._test_fencing_clock  # type: ignore[attr-defined]
    clock.value = 0.0
    lease = ledger.acquire_writer_lease(
        name="paper-writer", owner_id="owner-a", ttl_seconds=20
    )
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]
    if duplicate:
        ledger.admit_execution_command(
            command=command,
            permit=permit,
            writer_lease=lease,
            now=1.0,
            permit_expires_at=100.0,
            environment_expires_at=100.0,
        )

    expected_counts = ledger.counts()
    transaction_started = False
    original_transaction = ledger._transaction  # type: ignore[attr-defined]

    @contextmanager
    def observed_transaction():
        nonlocal transaction_started
        with original_transaction() as connection:
            transaction_started = True
            yield connection

    def post_lock_fencing_clock() -> float:
        assert transaction_started is True
        return 10.0

    ledger._fencing_clock = post_lock_fencing_clock  # type: ignore[attr-defined]
    monkeypatch.setattr(ledger, "_transaction", observed_transaction)
    with pytest.raises(expected_exception):
        ledger.admit_execution_command(
            command=command,
            permit=permit,
            writer_lease=lease,
            now=1.0,
            permit_expires_at=permit_expires_at,
            environment_expires_at=environment_expires_at,
        )

    assert ledger.counts() == expected_counts
    assert (ledger.get_command_by_hash(command["commandId"]) is not None) is duplicate


def test_batch_rolls_back_when_later_event_breaks_foreign_key(ledger: Ledger, writer_lease) -> None:
    payload = {"target": 0}
    command = ledger.submit_command(
        idempotency_key="decision-3",
        payload_hash=payload_hash(payload),
        command_type="target_position",
        payload=payload,
        writer_lease=writer_lease,
        now=100.0,
    )

    with pytest.raises(sqlite3.IntegrityError):
        ledger.append_events_atomically(
            [
                ("valid_but_should_rollback", {}, command.command.id),
                ("invalid_foreign_key", {}, 999_999),
            ],
            writer_lease=writer_lease,
            now=101.0,
        )

    # Only submit_command's own event remains: the batch is all-or-nothing.
    assert [event.event_type for event in ledger.replay()] == ["command_recorded"]


def test_admit_execution_command_roundtrip_and_exact_duplicate_no_event(ledger: Ledger, writer_lease) -> None:
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]

    first = ledger.admit_execution_command(
        command=command,
        permit=permit,
        writer_lease=writer_lease,
        now=100.0,
    )
    assert first.created is True
    assert first.accepted_event.cursor == 1
    assert first.accepted_event.event_type == "execution_command_accepted"
    assert first.accepted_lifecycle_event.sequence == 1
    assert first.accepted_lifecycle_event.kind == "acknowledged"
    assert first.command.accepted_cursor == 1
    assert first.command.accepted_sequence == 1
    assert first.command.command_hash == command["commandId"]
    assert first.command.payload_hash == command["payloadHash"]
    assert command["commandId"] == command["payloadHash"] == payload_hash(command["payload"])
    assert first.command.payload == command["payload"]
    assert first.command.permit == permit
    assert first.command.command == command
    assert ledger.get_command_by_hash(command["commandId"]) == first.command
    assert ledger.latest_cursor() == 1
    assert ledger.latest_lifecycle_sequence() == 1

    re_signed_permit = dict(permit)
    re_signed_permit["signature"] = "new-signature-is-not-persisted-on-replay"
    duplicate = ledger.admit_execution_command(
        command={
            "payload": command["payload"],
            "payloadHash": command["payloadHash"],
            "schemaVersion": command["schemaVersion"],
            "commandId": command["commandId"],
        },
        permit=re_signed_permit,
        writer_lease=writer_lease,
        now=101.0,
    )
    assert duplicate.created is False
    assert duplicate.command == first.command
    assert duplicate.accepted_event == first.accepted_event
    assert duplicate.accepted_lifecycle_event == first.accepted_lifecycle_event
    assert duplicate.command.permit == permit
    assert ledger.latest_cursor() == 1
    assert ledger.latest_lifecycle_sequence() == 1


def test_execution_audit_acknowledgement_and_command_are_one_transaction(
    ledger: Ledger,
    writer_lease,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture = fixture_contract()

    def fail_lifecycle(*_args, **_kwargs):
        raise MalformedLifecycleRecord("injected lifecycle failure")

    monkeypatch.setattr(
        ledger,
        "_append_lifecycle_event_in_transaction",
        fail_lifecycle,
    )
    with pytest.raises(MalformedLifecycleRecord, match="injected"):
        ledger.admit_execution_command(
            command=fixture["command"],
            permit=fixture["permit"],
            writer_lease=writer_lease,
            now=1_786_752_001.0,
        )
    assert ledger.latest_cursor() == 0
    assert ledger.latest_lifecycle_sequence() == 0
    assert ledger.get_command_by_hash(fixture["command"]["commandId"]) is None

def test_lifecycle_sequence_is_contiguous_hash_bound_and_not_polluted_by_audit_events(
    ledger: Ledger, writer_lease
) -> None:
    fixture = fixture_contract()
    command = fixture["command"]
    ledger.append_event(
        "generic_before_admission",
        {"doesNotBelongToLifecycle": True},
        writer_lease=writer_lease,
        now=1_786_752_000.0,
    )
    accepted = ledger.admit_execution_command(
        command=command,
        permit=fixture["permit"],
        writer_lease=writer_lease,
        now=1_786_752_001.0,
    )
    ledger.append_event(
        "generic_after_admission",
        {"doesNotBelongToLifecycle": True},
        writer_lease=writer_lease,
        now=1_786_752_002.0,
    )
    client_order_id = command["payload"]["clientOrderId"]
    submitted = ledger.append_lifecycle_event(
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": command["commandId"],
            "occurredAt": "2026-08-15T00:00:02.000Z",
            "kind": "submitted",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
        },
        writer_lease=writer_lease,
        now=1_786_752_002.0,
    )
    partial = ledger.append_lifecycle_event(
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": command["commandId"],
            "occurredAt": "2026-08-15T00:00:03.000Z",
            "kind": "partially_filled",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
            "filledQuantity": "0.0001",
            "averagePrice": "65000",
        },
        writer_lease=writer_lease,
        now=1_786_752_003.0,
    )
    filled = ledger.append_lifecycle_event(
        {
            "schemaVersion": "openalice_execution_event.v1",
            "commandId": command["commandId"],
            "occurredAt": "2026-08-15T00:00:04.000Z",
            "kind": "filled",
            "clientOrderId": client_order_id,
            "venueOrderId": "paper-order-1",
            "filledQuantity": "0.0005",
            "averagePrice": "65001",
        },
        writer_lease=writer_lease,
        now=1_786_752_004.0,
    )

    assert accepted.accepted_event.cursor == 2
    assert accepted.command.accepted_cursor == 2
    assert accepted.accepted_lifecycle_event.sequence == 1
    assert accepted.command.accepted_sequence == 1
    assert [submitted.sequence, partial.sequence, filled.sequence] == [2, 3, 4]
    assert ledger.latest_cursor() == 3
    assert ledger.latest_lifecycle_sequence() == 4
    replayed = ledger.replay_lifecycle_events(after_sequence=0, limit=1000)
    assert [event.sequence for event in replayed] == [1, 2, 3, 4]
    assert [event.kind for event in replayed] == [
        "acknowledged",
        "submitted",
        "partially_filled",
        "filled",
    ]
    for event in replayed:
        assert stable_stringify(event.event) == event.event_json
        assert event.event["eventId"] == event.event_id

    with pytest.raises(ValueError, match="not durably acknowledged"):
        ledger.append_lifecycle_event(
            {
                "schemaVersion": "openalice_execution_event.v1",
                "commandId": "f" * 64,
                "occurredAt": "2026-08-15T00:00:05.000Z",
                "kind": "submitted",
            },
            writer_lease=writer_lease,
            now=1_786_752_005.0,
        )


def test_lifecycle_snapshot_is_separate_and_preserves_exact_canonical_utf8(
    ledger: Ledger, writer_lease
) -> None:
    fixture = fixture_contract()
    accepted = ledger.admit_execution_command(
        command=fixture["command"],
        permit=fixture["permit"],
        writer_lease=writer_lease,
        now=1_786_752_001.0,
    )
    legacy = ledger.upsert_snapshot(
        account_id="paper-main",
        symbol="BTC/USDT",
        snapshot={"legacy": True},
        as_of_cursor=accepted.command.accepted_cursor,
        writer_lease=writer_lease,
        now=1_786_752_002.0,
    )
    lifecycle = ledger.upsert_lifecycle_snapshot(
        account_id="paper-main",
        symbol="BTC/USDT",
        snapshot={"说明": "诊断", "positions": []},
        as_of_sequence=accepted.command.accepted_sequence,
        writer_lease=writer_lease,
        now=1_786_752_003.0,
    )

    assert legacy.as_of_cursor == 1
    assert lifecycle.as_of_sequence == 1
    assert lifecycle.snapshot_json.encode("utf-8") == (
        '{"positions":[],"说明":"诊断"}'.encode("utf-8")
    )
    assert ledger.get_snapshot(account_id="paper-main", symbol="BTC/USDT") == legacy
    assert (
        ledger.get_lifecycle_snapshot(account_id="paper-main", symbol="BTC/USDT")
        == lifecycle
    )
    ledger._connection.execute(  # type: ignore[attr-defined]
        """
        UPDATE lifecycle_snapshots SET as_of_sequence = 2
        WHERE account_id = 'paper-main' AND symbol = 'BTC/USDT'
        """
    )
    with pytest.raises(MalformedLifecycleRecord, match="ahead"):
        ledger.get_lifecycle_snapshot(account_id="paper-main", symbol="BTC/USDT")


def test_legacy_execution_rows_are_atomically_and_idempotently_backfilled(
    tmp_path: Path,
) -> None:
    database = tmp_path / "legacy.sqlite3"
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            PRAGMA foreign_keys=ON;
            CREATE TABLE events (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                command_id INTEGER,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE execution_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command_hash TEXT NOT NULL UNIQUE,
                payload_hash TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                command_json TEXT NOT NULL,
                permit_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                accepted_cursor INTEGER NOT NULL UNIQUE REFERENCES events(cursor)
            );
            """
        )
        cursor = connection.execute(
            """
            INSERT INTO events(event_type, command_id, payload_json, created_at)
            VALUES ('execution_command_accepted', NULL, ?, ?)
            """,
            (
                stable_stringify(
                    {
                        "command_hash": command["commandId"],
                        "payload_hash": command["payloadHash"],
                        "idempotency_key": command["payload"]["idempotencyKey"],
                        "kind": command["payload"]["kind"],
                    }
                ),
                1_786_752_001.0,
            ),
        ).lastrowid
        connection.execute(
            """
            INSERT INTO execution_commands(
                command_hash, payload_hash, idempotency_key, kind,
                payload_json, command_json, permit_json, created_at, accepted_cursor
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                command["commandId"],
                command["payloadHash"],
                command["payload"]["idempotencyKey"],
                command["payload"]["kind"],
                stable_stringify(command["payload"]),
                stable_stringify(command),
                stable_stringify(permit),
                1_786_752_001.0,
                cursor,
            ),
        )

    with Ledger(database) as migrated:
        stored = migrated.get_command_by_hash(command["commandId"])
        assert stored is not None
        assert stored.accepted_cursor == 1
        assert stored.accepted_sequence == 1
        events = migrated.replay_lifecycle_events()
        assert len(events) == 1
        assert events[0].kind == "acknowledged"
        assert events[0].command_hash == command["commandId"]
        original_json = events[0].event_json

    with Ledger(database) as reopened:
        events = reopened.replay_lifecycle_events()
        assert len(events) == 1
        assert events[0].event_json == original_json
        with sqlite3.connect(database) as inspection:
            columns = {
                row[1]
                for row in inspection.execute("PRAGMA table_info(execution_commands)")
            }
            assert "accepted_sequence" in columns
            assert inspection.execute(
                "SELECT COUNT(*) FROM lifecycle_events"
            ).fetchone() == (1,)


def test_failed_legacy_backfill_rolls_back_schema_migration(tmp_path: Path) -> None:
    database = tmp_path / "corrupt-legacy.sqlite3"
    with sqlite3.connect(database) as connection:
        connection.executescript(
            """
            CREATE TABLE events (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                command_id INTEGER,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL
            );
            CREATE TABLE execution_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command_hash TEXT NOT NULL UNIQUE,
                payload_hash TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                command_json TEXT NOT NULL,
                permit_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                accepted_cursor INTEGER NOT NULL UNIQUE REFERENCES events(cursor)
            );
            INSERT INTO events(event_type, command_id, payload_json, created_at)
            VALUES ('execution_command_accepted', NULL, '{}', 1);
            INSERT INTO execution_commands(
                command_hash, payload_hash, idempotency_key, kind,
                payload_json, command_json, permit_json, created_at, accepted_cursor
            ) VALUES (
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                'legacy-corrupt', 'submit', '{}', '{}', '{}', 1, 1
            );
            """
        )

    with pytest.raises(MalformedLifecycleRecord, match="cannot be backfilled"):
        Ledger(database)
    with sqlite3.connect(database) as inspection:
        columns = {
            row[1]
            for row in inspection.execute("PRAGMA table_info(execution_commands)")
        }
        tables = {
            row[0]
            for row in inspection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
    assert "accepted_sequence" not in columns
    assert "lifecycle_events" not in tables


def test_fixture_command_conflict_suspends_on_same_idempotency_key(ledger: Ledger, writer_lease) -> None:
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]
    ledger.admit_execution_command(command=command, permit=permit, writer_lease=writer_lease, now=100.0)

    changed_payload = dict(command["payload"])
    changed_payload["price"] = "99999.5"
    changed = command_for_payload(changed_payload)
    with pytest.raises(IdempotencyConflict):
        ledger.admit_execution_command(
            command=changed,
            permit=permit,
            writer_lease=writer_lease,
            now=101.0,
        )

    assert ledger.runtime_state()["mode"] == "suspended"
    assert ledger.latest_cursor() == 2
    conflict = ledger.replay(after_cursor=1)[0]
    assert conflict.event_type == "execution_idempotency_conflict"
    assert conflict.payload["existing_command_hash"] == command["commandId"]
    assert conflict.payload["received_command_hash"] == changed["commandId"]


def test_snapshot_cursor_guard_and_no_regression(ledger: Ledger, writer_lease) -> None:
    event = ledger.append_event("seed", {}, writer_lease=writer_lease, now=100.0)
    first = ledger.upsert_snapshot(
        account_id="paper-1",
        symbol="BTC-USDT",
        snapshot={"equity": 1000, "positions": []},
        as_of_cursor=event.cursor,
        writer_lease=writer_lease,
        now=101.0,
    )
    assert first.as_of_cursor == 1
    assert ledger.get_snapshot(account_id="paper-1", symbol="BTC-USDT") == first

    with pytest.raises(SnapshotCursorAhead):
        ledger.upsert_snapshot(
            account_id="paper-1",
            symbol="BTC-USDT",
            snapshot={"equity": 1001},
            as_of_cursor=2,
            writer_lease=writer_lease,
            now=102.0,
        )

    next_event = ledger.append_event("next", {}, writer_lease=writer_lease, now=103.0)
    advanced = ledger.upsert_snapshot(
        account_id="paper-1",
        symbol="BTC-USDT",
        snapshot={"equity": 1002},
        as_of_cursor=next_event.cursor,
        writer_lease=writer_lease,
        now=104.0,
    )
    assert advanced.as_of_cursor == 2
    assert advanced.value == {"equity": 1002}

    with pytest.raises(SnapshotRegression):
        ledger.upsert_snapshot(
            account_id="paper-1",
            symbol="BTC-USDT",
            snapshot={"equity": 999},
            as_of_cursor=event.cursor,
            writer_lease=writer_lease,
            now=105.0,
        )
    assert ledger.get_snapshot(account_id="paper-1", symbol="BTC-USDT") == advanced


def test_explicit_suspend_is_irreversible_for_admission_but_reads_and_duplicates_work(
    ledger: Ledger, writer_lease
) -> None:
    fixture = fixture_contract()
    command = fixture["command"]
    permit = fixture["permit"]
    accepted = ledger.admit_execution_command(
        command=command,
        permit=permit,
        writer_lease=writer_lease,
        now=100.0,
    )
    snapshot = ledger.upsert_snapshot(
        account_id="paper-2",
        symbol="BTC/USDT",
        snapshot={"equity": 500},
        as_of_cursor=accepted.accepted_event.cursor,
        writer_lease=writer_lease,
        now=101.0,
    )
    suspension = ledger.suspend("operator_stop", writer_lease=writer_lease, now=102.0)
    assert suspension.event_type == "runtime_suspended"
    assert ledger.runtime_state()["mode"] == "suspended"
    assert ledger.get_command_by_hash(command["commandId"]) == accepted.command
    assert ledger.get_snapshot(account_id="paper-2", symbol="BTC/USDT") == snapshot
    assert ledger.latest_cursor() == suspension.cursor

    replay = ledger.admit_execution_command(
        command=command,
        permit=permit,
        writer_lease=writer_lease,
        now=103.0,
    )
    assert replay.created is False

    new_payload = dict(command["payload"])
    new_payload["idempotencyKey"] = "intent-2"
    new_payload["clientOrderId"] = "OA4CB52A4F8F31DC709E10A49AAC03CE"
    new_command = command_for_payload(new_payload)
    with pytest.raises(RuntimeSuspended, match="operator_stop"):
        ledger.admit_execution_command(
            command=new_command,
            permit=permit,
            writer_lease=writer_lease,
            now=104.0,
        )
    assert ledger.get_command_by_hash(new_command["commandId"]) is None
    assert ledger.latest_cursor() == suspension.cursor
