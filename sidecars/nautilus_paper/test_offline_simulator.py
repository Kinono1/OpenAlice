"""Tests for signed-capability deterministic offline simulator storage."""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from sidecars.nautilus_paper.contract import ContractValidationError, sha256_canonical, stable_stringify
from sidecars.nautilus_paper.offline_receipt import (
    OFFLINE_SIMULATOR_REQUEST_V1,
    create_offline_simulator_capability_v1,
    derive_offline_execution_attempt_id,
)
from sidecars.nautilus_paper.offline_effect import (
    OfflineSimulatorEffectTrustPolicy,
    offline_simulator_effect_v1_matches,
    verify_offline_simulator_effect_v1,
)
from sidecars.nautilus_paper.offline_simulator import (
    OfflineSimulatorStore,
    SimulatorCapabilityRejected,
    SimulatorEquivocation,
    SimulatorIntegrityError,
)


NAMESPACE = "a" * 64
COMMAND = "b" * 64
PERMIT = "c" * 64
AUTHORITY_KEY_ID = "capability-authority"
STORE_ID = "9" * 64
NOW = datetime(2026, 8, 15, 0, 1, tzinfo=timezone.utc)
PRIVATE_KEY = Ed25519PrivateKey.generate()
PUBLIC_KEYS = {AUTHORITY_KEY_ID: PRIVATE_KEY.public_key()}
SOURCE_KEY_ID = "offline-source-key"
SOURCE_PRIVATE_KEY = Ed25519PrivateKey.generate()


class _PinnedTestClock:
    def __init__(self, value: datetime = NOW) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value


def open_store(
    path: Path,
    *,
    capability_public_keys=PUBLIC_KEYS,
    busy_timeout_ms: int = 5_000,
    now: datetime = NOW,
) -> OfflineSimulatorStore:
    clock = _PinnedTestClock(now)
    instance = OfflineSimulatorStore(
        path,
        store_id=STORE_ID,
        capability_public_keys=capability_public_keys,
        source_attestation_key_id=SOURCE_KEY_ID,
        source_attestation_private_key=SOURCE_PRIVATE_KEY,
        capability_clock=clock,
        allow_provision=True,
        busy_timeout_ms=busy_timeout_ms,
    )
    instance._test_clock = clock  # type: ignore[attr-defined]
    return instance


def request(*, client_order_id: str = "ORDER001", attempt_number: str = "1", namespace: str = NAMESPACE) -> dict[str, object]:
    adapter_epoch = "1"
    return {
        "schemaVersion": OFFLINE_SIMULATOR_REQUEST_V1, "sourceNamespaceId": namespace,
        "commandId": COMMAND, "payloadHash": COMMAND, "permitV2Id": PERMIT,
        "permitKeyId": "permit-key", "acceptedSequence": "7", "idempotencyKey": "idempotency-1",
        "accountId": "paper-account", "canonicalSymbol": "BTC/USDT", "venue": "OKX",
        "venueInstrumentId": "BTC-USDT", "mode": "PAPER_LOCAL", "clientOrderId": client_order_id,
        "side": "buy", "orderType": "limit", "timeInForce": "GTC", "reduceOnly": False,
        "quantity": "0.01", "price": "100000", "maxNotionalUsd": "1000",
        "adapterId": "offline-simulator", "adapterRunId": "run-001", "adapterEpoch": adapter_epoch,
        "attemptId": derive_offline_execution_attempt_id(
            command_id=COMMAND, adapter_id="offline-simulator", adapter_run_id="run-001",
            adapter_epoch=adapter_epoch, attempt_number=attempt_number,
        ),
        "attemptNumber": attempt_number, "permitIssuedAt": "2026-08-15T00:00:00.000Z",
        "permitExpiresAt": "2026-08-15T00:10:00.000Z", "dispatchArmedAt": "2026-08-15T00:01:00.000Z",
    }


def capability(
    value: dict[str, object],
    *,
    authority_kind: str = "original_dispatch",
    writer_owner_id: str = "owner-a",
    writer_epoch: str = "1",
    expires_at: str = "2026-08-15T00:02:00.000Z",
    private_key: Ed25519PrivateKey = PRIVATE_KEY,
    simulator_store_id: str = STORE_ID,
    source_attestation_key_id: str = SOURCE_KEY_ID,
) -> bytes:
    core: dict[str, object] = {
        "schemaVersion": "openalice_offline_simulator_capability.v1", "scope": "offline_simulator_only",
        "capability": "offline_simulator.ensure_exact.v2", "authorityKind": authority_kind,
        "authorityKeyId": AUTHORITY_KEY_ID, "policyHash": "d" * 64, "commandId": value["commandId"],
        "simulatorStoreId": simulator_store_id,
        "sourceAttestationKeyId": source_attestation_key_id,
        "attemptId": value["attemptId"], "attemptAdapterEpoch": value["adapterEpoch"],
        "sourceNamespaceId": value["sourceNamespaceId"], "clientOrderId": value["clientOrderId"],
        "requestHash": sha256_canonical(value), "writerName": "paper-writer",
        "writerOwnerId": writer_owner_id, "writerEpoch": writer_epoch,
        "issuedAt": "2026-08-15T00:00:00.000Z", "expiresAt": expires_at,
    }
    if authority_kind == "takeover_reconciliation":
        core["reconciliationClaimId"] = "e" * 64
    return stable_stringify(create_offline_simulator_capability_v1(core=core, private_key=private_key)).encode("utf-8")


@pytest.fixture
def store(tmp_path: Path):
    instance = open_store(
        tmp_path / "offline-simulator.sqlite3", busy_timeout_ms=1_234
    )
    yield instance
    instance.close()


def dispatch(store: OfflineSimulatorStore, value: dict[str, object], token: bytes, *, now: datetime = NOW):
    store._test_clock.value = now  # type: ignore[attr-defined]
    return store.ensure_exact(value, canonical_capability_json_utf8=token)


def expected_counts(*, namespaces: int, orders: int, events: int, uses: int) -> dict[str, int]:
    return {"namespaces": namespaces, "orders": orders, "events": events, "capability_uses": uses}


def test_exact_retry_is_single_effect_and_single_capability_use(store: OfflineSimulatorStore) -> None:
    value, token = request(), capability(request())
    first = dispatch(store, value, token)
    retry = dispatch(store, value, token)
    assert (first.created, retry.created, retry.source_sequence) == (True, False, "1")
    assert retry.canonical_request_json_utf8 == first.canonical_request_json_utf8
    assert retry.canonical_response_json_utf8 == first.canonical_response_json_utf8
    assert retry.canonical_effect_json_utf8 == first.canonical_effect_json_utf8
    effect = first.effect
    response = first.response
    parsed_capability = json.loads(token.decode("utf-8"))
    verification = verify_offline_simulator_effect_v1(
        effect=effect,
        trust_policy=OfflineSimulatorEffectTrustPolicy(
            key_id=SOURCE_KEY_ID,
            store_id=STORE_ID,
            public_key=SOURCE_PRIVATE_KEY.public_key(),
        ),
    )
    assert verification.valid is True
    assert offline_simulator_effect_v1_matches(
        effect, value, response, parsed_capability
    )
    assert store._connection.execute(
        "SELECT COUNT(*) FROM simulator_effect_attestations"
    ).fetchone()[0] == 1
    assert store.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=1)


def test_lookup_exact_distinguishes_verified_absence_existing_and_equivocation(
    store: OfflineSimulatorStore,
) -> None:
    value = request()
    assert store.lookup_exact(value) is None
    created = dispatch(store, value, capability(value))
    found = store.lookup_exact(value)
    assert found is not None
    assert found.created is False
    assert found.canonical_response_json_utf8 == created.canonical_response_json_utf8
    altered = dict(value)
    altered["price"] = "99999"
    with pytest.raises(SimulatorEquivocation):
        store.lookup_exact(altered)
    assert store.counts() == expected_counts(
        namespaces=1, orders=1, events=1, uses=1
    )


def test_legacy_lease_and_caller_supplied_resolver_apis_are_unavailable(store: OfflineSimulatorStore) -> None:
    with pytest.raises(TypeError):
        store.ensure_exact(request(), writer_lease=object())
    with pytest.raises(TypeError):
        store.ensure_exact(request(), canonical_capability_json_utf8=capability(request()), resolve_capability_public_key=PUBLIC_KEYS)
    with pytest.raises(TypeError):
        store.ensure_exact(
            request(),
            canonical_capability_json_utf8=capability(request()),
            capability_clock=lambda: NOW,
        )


def test_constructor_snapshots_its_public_key_trust_root(tmp_path: Path) -> None:
    keys = dict(PUBLIC_KEYS)
    instance = open_store(
        tmp_path / "snapshot.sqlite3", capability_public_keys=keys
    )
    keys[AUTHORITY_KEY_ID] = Ed25519PrivateKey.generate().public_key()
    try:
        assert dispatch(instance, request(), capability(request())).created is True
    finally:
        instance.close()


def test_constructor_rejects_source_and_capability_key_role_collision(
    tmp_path: Path,
) -> None:
    with pytest.raises(ValueError, match="distinct"):
        OfflineSimulatorStore(
            tmp_path / "key-role-collision.sqlite3",
            store_id=STORE_ID,
            capability_public_keys=PUBLIC_KEYS,
            source_attestation_key_id=SOURCE_KEY_ID,
            source_attestation_private_key=PRIVATE_KEY,
            capability_clock=lambda: NOW,
            allow_provision=True,
        )


@pytest.mark.parametrize(
    "token",
    (
        lambda value: capability(value, simulator_store_id="8" * 64),
        lambda value: capability(
            value, source_attestation_key_id="another-source-key"
        ),
    ),
)
def test_capability_must_bind_constructor_store_and_source_key(
    store: OfflineSimulatorStore,
    token,
) -> None:
    value = request()
    with pytest.raises(SimulatorCapabilityRejected, match="store or source"):
        dispatch(store, value, token(value))
    assert store.counts() == expected_counts(
        namespaces=0, orders=0, events=0, uses=0
    )


def test_store_identity_requires_explicit_new_path_provision_and_matches_on_reopen(
    tmp_path: Path,
) -> None:
    unprovisioned_path = tmp_path / "unprovisioned.sqlite3"
    with pytest.raises(SimulatorIntegrityError, match="provisioning"):
        OfflineSimulatorStore(
            unprovisioned_path,
            store_id=STORE_ID,
            capability_public_keys=PUBLIC_KEYS,
            source_attestation_key_id=SOURCE_KEY_ID,
            source_attestation_private_key=SOURCE_PRIVATE_KEY,
            capability_clock=lambda: NOW,
        )
    path = tmp_path / "identity.sqlite3"
    provisioned = open_store(path)
    provisioned.close()
    with pytest.raises(SimulatorIntegrityError, match="identity"):
        OfflineSimulatorStore(
            path,
            store_id="8" * 64,
            capability_public_keys=PUBLIC_KEYS,
            source_attestation_key_id=SOURCE_KEY_ID,
            source_attestation_private_key=SOURCE_PRIVATE_KEY,
            capability_clock=lambda: NOW,
        )


def test_signed_writer_epoch_outside_sqlite_range_cannot_create_effect(store: OfflineSimulatorStore) -> None:
    value = request()
    with pytest.raises(SimulatorCapabilityRejected, match="SQLite integer range"):
        dispatch(store, value, capability(value, writer_epoch=str(1 << 63)))
    assert store.counts() == expected_counts(namespaces=0, orders=0, events=0, uses=0)


@pytest.mark.parametrize("kind", ("wrong-signature", "wrong-key", "wrong-binding", "expired"))
def test_invalid_capability_rolls_back_without_effect(store: OfflineSimulatorStore, tmp_path: Path, kind: str) -> None:
    value = request()
    if kind == "wrong-signature":
        token = capability(value, private_key=Ed25519PrivateKey.generate())
    elif kind == "wrong-key":
        token = capability(value)
        wrong_key_store = open_store(
            tmp_path / "wrong-key.sqlite3",
            capability_public_keys={AUTHORITY_KEY_ID: Ed25519PrivateKey.generate().public_key()},
        )
        try:
            with pytest.raises(SimulatorCapabilityRejected):
                dispatch(wrong_key_store, value, token)
            assert wrong_key_store.counts() == expected_counts(namespaces=0, orders=0, events=0, uses=0)
        finally:
            wrong_key_store.close()
        return
    elif kind == "wrong-binding":
        token = capability(request(client_order_id="ORDER002", attempt_number="2"))
    else:
        token = capability(value, expires_at="2026-08-15T00:00:30.000Z")
    with pytest.raises(SimulatorCapabilityRejected):
        dispatch(store, value, token)
    assert store.counts() == expected_counts(namespaces=0, orders=0, events=0, uses=0)


def test_reopen_and_takeover_capability_return_existing_effect(tmp_path: Path) -> None:
    path, value = tmp_path / "reopen.sqlite3", request()
    original = capability(value)
    first_store = open_store(path)
    first = dispatch(first_store, value, original)
    first_store.close()
    reopened = open_store(path)
    try:
        retry = dispatch(reopened, value, original)
        takeover = dispatch(reopened, value, capability(value, authority_kind="takeover_reconciliation", writer_owner_id="owner-b", writer_epoch="2"))
        assert (retry.created, takeover.created, retry.source_sequence, takeover.source_sequence) == (False, False, first.source_sequence, first.source_sequence)
        assert reopened.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=2)
    finally:
        reopened.close()


def test_takeover_cannot_create_and_different_request_is_equivocation(store: OfflineSimulatorStore) -> None:
    value = request()
    with pytest.raises(SimulatorCapabilityRejected, match="cannot create"):
        dispatch(store, value, capability(value, authority_kind="takeover_reconciliation"))
    first = dispatch(store, value, capability(value))
    altered = request()
    altered["price"] = "99999"
    with pytest.raises(SimulatorEquivocation):
        dispatch(store, altered, capability(altered))
    assert first.created is True
    assert store.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=1)


def test_expired_original_retry_and_tampered_capability_use_fail_closed(store: OfflineSimulatorStore) -> None:
    value, token = request(), capability(request())
    dispatch(store, value, token)
    with pytest.raises(SimulatorCapabilityRejected, match="capability_expired"):
        dispatch(store, value, token, now=datetime(2026, 8, 15, 0, 2, tzinfo=timezone.utc))
    store._connection.execute("UPDATE simulator_capability_uses SET canonical_capability_json = ?", (b"{}",))
    with pytest.raises(SimulatorIntegrityError, match="capability"):
        dispatch(store, value, token)
    assert store.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=1)


@pytest.mark.parametrize("column, value", (("request_hash", "f" * 64), ("writer_epoch", "99"), ("source_sequence", 2)))
def test_tampered_capability_use_columns_fail_closed(store: OfflineSimulatorStore, column: str, value: object) -> None:
    request_value, token = request(), capability(request())
    dispatch(store, request_value, token)
    if column == "source_sequence":
        store._connection.execute("PRAGMA foreign_keys = OFF")
    store._connection.execute(f"UPDATE simulator_capability_uses SET {column} = ?", (value,))
    if column == "source_sequence":
        store._connection.execute("PRAGMA foreign_keys = ON")
    with pytest.raises(SimulatorIntegrityError, match="capability"):
        dispatch(store, request_value, token)
    assert store.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=1)


def test_historical_capability_use_reverifies_signature_even_if_hash_is_recomputed(
    store: OfflineSimulatorStore,
) -> None:
    first = request()
    dispatch(store, first, capability(first))
    forged_raw = capability(first, private_key=Ed25519PrivateKey.generate())
    forged = json.loads(forged_raw.decode("utf-8"))
    store._connection.execute(
        """UPDATE simulator_capability_uses
           SET canonical_capability_json = ?, canonical_capability_hash = ?""",
        (forged_raw, sha256_canonical(forged)),
    )
    second = request(client_order_id="ORDER002", attempt_number="2")

    with pytest.raises(SimulatorIntegrityError, match="signature"):
        dispatch(store, second, capability(second))
    assert store.counts() == expected_counts(
        namespaces=1, orders=1, events=1, uses=1
    )


def test_missing_capability_use_blocks_new_dispatch(store: OfflineSimulatorStore) -> None:
    first, second = request(), request(client_order_id="ORDER002", attempt_number="2")
    dispatch(store, first, capability(first))
    dispatch(store, second, capability(second))
    store._connection.execute("DELETE FROM simulator_capability_uses WHERE source_sequence = 1")
    with pytest.raises(SimulatorIntegrityError, match="capability use"):
        dispatch(store, second, capability(second))
    assert store.counts() == expected_counts(namespaces=1, orders=2, events=2, uses=1)


@pytest.mark.parametrize("tamper", ("signature", "delete"))
def test_signed_effect_attestation_tampering_fails_closed(
    store: OfflineSimulatorStore, tamper: str
) -> None:
    value = request()
    dispatch(store, value, capability(value))
    if tamper == "signature":
        row = store._connection.execute(
            "SELECT canonical_effect_json FROM simulator_effect_attestations"
        ).fetchone()
        effect = json.loads(bytes(row[0]).decode("utf-8"))
        effect["signature"] = base64.b64encode(b"\0" * 64).decode("ascii")
        store._connection.execute(
            "UPDATE simulator_effect_attestations SET canonical_effect_json = ?",
            (stable_stringify(effect).encode("utf-8"),),
        )
        expected = "attestation is invalid"
    else:
        store._connection.execute("PRAGMA foreign_keys = OFF")
        store._connection.execute("DELETE FROM simulator_effect_attestations")
        store._connection.execute("PRAGMA foreign_keys = ON")
        expected = "exactly one signed effect"
    with pytest.raises(SimulatorIntegrityError, match=expected):
        store.lookup_exact(value)


def test_deleted_complete_namespace_history_is_detected_by_the_persisted_head(
    store: OfflineSimulatorStore,
) -> None:
    value, token = request(), capability(request())
    dispatch(store, value, token)
    store._connection.execute("PRAGMA foreign_keys = OFF")
    store._connection.execute("DELETE FROM simulator_effect_attestations")
    store._connection.execute("DELETE FROM simulator_capability_uses")
    store._connection.execute("DELETE FROM simulator_events")
    store._connection.execute("DELETE FROM simulated_orders")
    store._connection.execute("PRAGMA foreign_keys = ON")

    with pytest.raises(SimulatorIntegrityError, match="history head"):
        dispatch(store, value, token)
    assert store.counts() == expected_counts(
        namespaces=1, orders=0, events=0, uses=0
    )


def test_deleting_namespace_and_all_children_still_conflicts_with_global_store_head(
    store: OfflineSimulatorStore,
) -> None:
    value, token = request(), capability(request())
    dispatch(store, value, token)
    store._connection.execute("PRAGMA foreign_keys = OFF")
    store._connection.execute("DELETE FROM simulator_effect_attestations")
    store._connection.execute("DELETE FROM simulator_capability_uses")
    store._connection.execute("DELETE FROM simulator_events")
    store._connection.execute("DELETE FROM simulated_orders")
    store._connection.execute("DELETE FROM simulator_namespaces")
    store._connection.execute("PRAGMA foreign_keys = ON")

    with pytest.raises(SimulatorIntegrityError, match="global store history head"):
        dispatch(store, value, token)
    assert store.counts() == expected_counts(
        namespaces=0, orders=0, events=0, uses=0
    )


def test_event_sequence_gap_still_blocks_new_effect(store: OfflineSimulatorStore) -> None:
    first, second = request(), request(client_order_id="ORDER002", attempt_number="2")
    dispatch(store, first, capability(first))
    dispatch(store, second, capability(second))
    store._connection.execute("PRAGMA foreign_keys = OFF")
    store._connection.execute("UPDATE simulator_events SET source_sequence = 3 WHERE source_sequence = 2")
    store._connection.execute("PRAGMA foreign_keys = ON")
    third = request(client_order_id="ORDER003", attempt_number="3")
    with pytest.raises(SimulatorIntegrityError, match="integrity failure"):
        dispatch(store, third, capability(third))
    assert store.counts() == expected_counts(namespaces=1, orders=2, events=2, uses=2)


def test_concurrent_exact_dispatch_has_one_effect_and_use(tmp_path: Path) -> None:
    path, value, token = tmp_path / "concurrent.sqlite3", request(), capability(request())
    initialized = open_store(path)
    initialized.close()
    def invoke() -> bool:
        instance = open_store(path, busy_timeout_ms=5_000)
        try:
            return dispatch(instance, value, token).created
        finally:
            instance.close()
    with ThreadPoolExecutor(max_workers=2) as executor:
        created = list(executor.map(lambda _: invoke(), range(2)))
    verifier = open_store(path)
    try:
        assert sum(created) == 1
        assert verifier.counts() == expected_counts(namespaces=1, orders=1, events=1, uses=1)
    finally:
        verifier.close()


def test_request_contract_remains_strict(store: OfflineSimulatorStore) -> None:
    invalid = request()
    invalid["payloadHash"] = "f" * 64
    with pytest.raises(ContractValidationError, match="payloadHash"):
        dispatch(store, invalid, capability(request()))
