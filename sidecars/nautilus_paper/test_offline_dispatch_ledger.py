"""C1 persistence foundation tests; no receipt or lifecycle finalization occurs."""

from __future__ import annotations

from datetime import datetime, timezone
import base64
import json
from pathlib import Path
import sqlite3

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_private_key

from sidecars.nautilus_paper.contract import (
    build_execution_command_v1,
    derive_okx_client_order_id,
    execution_permit_v2_signing_payload,
    sha256_canonical,
    stable_stringify,
)
from sidecars.nautilus_paper.ledger import (
    IdempotencyConflict,
    LifecycleSequenceGap,
    MalformedLifecycleRecord,
    MalformedOfflineDispatchRecord,
    OfflineDispatchUnavailable,
    OfflineDispatchPolicyMismatch,
    PermitAuthorityExpired,
    Ledger,
    StaleLease,
)
from sidecars.nautilus_paper.offline_receipt import ed25519_public_key_fingerprint_sha256
from sidecars.nautilus_paper.offline_effect import (
    create_offline_simulator_effect_v1,
    offline_simulator_store_chain_v1_hash,
)
from sidecars.nautilus_paper.offline_simulator import OfflineSimulatorStore


def epoch(value: str) -> float:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=timezone.utc
    ).timestamp()


T0 = epoch("2026-08-15T00:00:01.000Z")
PRIVATE_KEY = load_der_private_key(
    bytes.fromhex("302e020100300506032b657004220420" "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
    password=None,
)
PUBLIC_KEY = PRIVATE_KEY.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
PERMIT_PRIVATE_KEY = Ed25519PrivateKey.generate()
PERMIT_PUBLIC_KEY = PERMIT_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
CAPABILITY_PRIVATE_KEY = Ed25519PrivateKey.generate()
CAPABILITY_PUBLIC_KEY = CAPABILITY_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
SOURCE_PRIVATE_KEY = Ed25519PrivateKey.generate()
SOURCE_PUBLIC_KEY = SOURCE_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
SIMULATOR_STORE_ID = "9" * 64
SOURCE_KEY_ID = "offline-source-attestation"


def fixture_contract() -> dict:
    path = Path(__file__).resolve().parents[2] / "src/sidecar/fixtures/openalice_execution_contract_v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


def policy(**changes: object) -> dict[str, object]:
    value: dict[str, object] = {
        "schemaVersion": "openalice_offline_adapter_policy.v3",
        "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only",
        "mode": "PAPER_LOCAL",
        "adapterId": "openalice.offline-simulator",
        "adapterBuildHash": "a" * 64,
        "adapterConfigHash": "b" * 64,
        "adapterRunId": "offline-run-1",
        "sourceNamespaceId": "c" * 64,
        "adapterKeyId": "offline-adapter-key",
        "adapterPublicKeySpkiSha256": "d" * 64,
        "permitAuthorityKeyId": "rfc8032-test-1",
        "permitAuthorityPublicKeySpkiSha256": "e" * 64,
        "simulatorCapabilityAuthorityKeyId": "offline-capability-authority",
        "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(CAPABILITY_PUBLIC_KEY),
        "simulatorStoreId": SIMULATOR_STORE_ID,
        "sourceAttestationKeyId": SOURCE_KEY_ID,
        "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(
            SOURCE_PUBLIC_KEY
        ),
        "capability": "offline_simulator.ensure_exact.v2",
        "ensureExact": True,
        "finalizationEligible": False,
    }
    value.update(changes)
    return value


class MutableFencingClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


@pytest.fixture
def ledger(tmp_path: Path):
    clock = MutableFencingClock(T0)
    instance = Ledger(
        tmp_path / "ledger.sqlite3",
        busy_timeout_ms=1_234,
        fencing_clock=clock,
        offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    yield instance
    instance.close()


def lease(ledger: Ledger, *, owner: str = "owner-a", now: float = T0, ttl: float = 120.0):
    ledger._test_fencing_clock.value = now  # type: ignore[attr-defined]
    return ledger.acquire_writer_lease(
        name="paper-writer", owner_id=owner, ttl_seconds=ttl
    )


def admitted_dispatch(
    ledger: Ledger, writer_lease, *, idempotency_key: str | None = None
):
    registered = ledger.register_offline_adapter_policy(
        policy=policy(
            adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PUBLIC_KEY),
            permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PERMIT_PUBLIC_KEY),
        ),
        writer_lease=writer_lease, now=T0
    )
    fixture = fixture_contract()
    payload = dict(fixture["command"]["payload"])
    payload["mode"] = "PAPER_LOCAL"
    if idempotency_key is not None:
        payload["idempotencyKey"] = idempotency_key
        payload["clientOrderId"] = derive_okx_client_order_id(idempotency_key)
    command = build_execution_command_v1(payload)
    permit = dict(fixture["permit"])
    permit["commandHash"] = command["commandId"]
    permit["mode"] = "PAPER_LOCAL"
    if idempotency_key is not None:
        permit["idempotencyKey"] = idempotency_key
    permit["permitId"] = sha256_canonical(
        {key: value for key, value in permit.items() if key not in {"permitId", "signature"}}
    )
    permit["signature"] = base64.b64encode(
        PERMIT_PRIVATE_KEY.sign(execution_permit_v2_signing_payload(permit).encode("utf-8"))
    ).decode("ascii")
    receipt = ledger.admit_execution_command(
        command=command, permit=permit, writer_lease=writer_lease,
        now=T0, offline_adapter_policy_hash=registered.policy_hash,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    return {"command": command, "permit": permit}, registered, receipt


def test_legacy_style_admission_migrates_without_inventing_dispatch(ledger: Ledger) -> None:
    writer = lease(ledger)
    fixture = fixture_contract()
    accepted = ledger.admit_execution_command(
        command=fixture["command"], permit=fixture["permit"], writer_lease=writer,
        now=T0,
    )
    assert ledger.get_execution_dispatch(accepted.command.command_hash) is None
    registered = ledger.register_offline_adapter_policy(
        policy=policy(), writer_lease=writer, now=T0
    )
    with pytest.raises(OfflineDispatchPolicyMismatch):
        ledger.admit_execution_command(
            command=fixture["command"], permit=fixture["permit"], writer_lease=writer,
            now=T0 + 1,
            offline_adapter_policy_hash=registered.policy_hash,
        )
    database = ledger.database_path
    ledger.close()
    reopened = Ledger(database)
    try:
        assert reopened.get_execution_dispatch(accepted.command.command_hash) is None
    finally:
        reopened.close()


def test_atomic_pending_dispatch_and_duplicate_cannot_replace_policy(ledger: Ledger) -> None:
    writer = lease(ledger)
    fixture, registered, accepted = admitted_dispatch(ledger, writer)
    dispatch = ledger.get_execution_dispatch(accepted.command.command_hash)
    assert dispatch is not None
    assert (dispatch.state, dispatch.policy_hash, dispatch.original_attempt_id) == (
        "DISPATCH_PENDING", registered.policy_hash, None
    )
    with pytest.raises(OfflineDispatchPolicyMismatch):
        ledger.admit_execution_command(
            command=fixture["command"], permit=fixture["permit"], writer_lease=writer,
            now=T0 + 1,
            offline_adapter_policy_hash="f" * 64,
        )
    # An unknown requested hash cannot alter a pre-bound policy; it is rejected
    # rather than creating a second dispatch.
    assert ledger.get_execution_dispatch(accepted.command.command_hash) == dispatch
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_dispatches").fetchone()[0] == 1
    assert registered.policy_hash == sha256_canonical(
        policy(
            adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PUBLIC_KEY),
            permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PERMIT_PUBLIC_KEY),
        )
    )


def test_policy_rejects_key_alias_and_nonlocal_dispatch_binding(ledger: Ledger) -> None:
    writer = lease(ledger)
    with pytest.raises(ValueError, match="key material"):
        ledger.register_offline_adapter_policy(
            policy=policy(permitAuthorityPublicKeySpkiSha256="d" * 64),
            writer_lease=writer, now=T0,
        )
    with pytest.raises(ValueError, match="four distinct roles"):
        ledger.register_offline_adapter_policy(
            policy=policy(sourceAttestationKeyId="offline-adapter-key"),
            writer_lease=writer,
            now=T0,
        )
    with pytest.raises(ValueError, match="four distinct roles"):
        ledger.register_offline_adapter_policy(
            policy=policy(
                sourceAttestationPublicKeySpkiSha256=policy()[
                    "simulatorCapabilityAuthorityPublicKeySpkiSha256"
                ]
            ),
            writer_lease=writer,
            now=T0,
        )
    registered = ledger.register_offline_adapter_policy(
        policy=policy(), writer_lease=writer, now=T0
    )
    fixture = fixture_contract()
    with pytest.raises(OfflineDispatchPolicyMismatch, match="PAPER_LOCAL submit"):
        ledger.admit_execution_command(
            command=fixture["command"], permit=fixture["permit"], writer_lease=writer,
            now=T0,
            offline_adapter_policy_hash=registered.policy_hash,
        )


@pytest.mark.parametrize("missing", ("receipt", "capability", "source"))
def test_v3_admission_requires_all_constructor_pinned_authorities(
    tmp_path: Path, missing: str
) -> None:
    clock = MutableFencingClock(T0)
    kwargs: dict[str, object] = {
        "fencing_clock": clock,
        "offline_capability_authority_private_key": CAPABILITY_PRIVATE_KEY,
        "offline_capability_authority_key_id": "offline-capability-authority",
        "offline_receipt_signing_private_key": PRIVATE_KEY,
        "offline_receipt_signing_key_id": "offline-adapter-key",
        "offline_source_attestation_public_keys": {
            SOURCE_KEY_ID: SOURCE_PUBLIC_KEY
        },
    }
    if missing == "receipt":
        del kwargs["offline_receipt_signing_private_key"]
        del kwargs["offline_receipt_signing_key_id"]
    elif missing == "capability":
        del kwargs["offline_capability_authority_private_key"]
        del kwargs["offline_capability_authority_key_id"]
    else:
        kwargs["offline_source_attestation_public_keys"] = {}
    instance = Ledger(tmp_path / f"missing-{missing}.sqlite3", **kwargs)
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    try:
        writer = lease(instance)
        with pytest.raises(OfflineDispatchPolicyMismatch, match="local"):
            admitted_dispatch(instance, writer)
        assert instance._connection.execute(
            "SELECT COUNT(*) FROM execution_dispatches"
        ).fetchone()[0] == 0
    finally:
        instance.close()


def test_offline_admission_rejects_wrong_permit_signature_without_any_write(ledger: Ledger) -> None:
    writer = lease(ledger)
    registered = ledger.register_offline_adapter_policy(
        policy=policy(
            adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PUBLIC_KEY),
            permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PERMIT_PUBLIC_KEY),
        ), writer_lease=writer, now=T0,
    )
    fixture = fixture_contract()
    payload = dict(fixture["command"]["payload"])
    payload["mode"] = "PAPER_LOCAL"
    command = build_execution_command_v1(payload)
    permit = dict(fixture["permit"])
    permit["mode"] = "PAPER_LOCAL"
    permit["commandHash"] = command["commandId"]
    permit["permitId"] = sha256_canonical({key: value for key, value in permit.items() if key not in {"permitId", "signature"}})
    permit["signature"] = base64.b64encode(b"not-a-valid-ed25519-signature".ljust(64, b"x")).decode("ascii")
    with pytest.raises(OfflineDispatchPolicyMismatch, match="verification failed"):
        ledger.admit_execution_command(
            command=command, permit=permit, writer_lease=writer, now=T0,
            offline_adapter_policy_hash=registered.policy_hash,
            permit_public_key=PERMIT_PUBLIC_KEY,
        )
    assert ledger.latest_cursor() == 0
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_commands").fetchone()[0] == 0
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_dispatches").fetchone()[0] == 0


def test_claim_freezes_one_attempt_before_any_source_effect_and_rejects_expired_permit(ledger: Ledger) -> None:
    writer = lease(ledger)
    fixture, _, accepted = admitted_dispatch(ledger, writer)
    ledger._test_fencing_clock.value = epoch("2026-08-15T00:00:31.000Z")  # type: ignore[attr-defined]
    with pytest.raises(PermitAuthorityExpired):
        ledger.claim_offline_dispatch(
            command_hash=accepted.command.command_hash, writer_lease=writer,
            now=epoch("2026-08-15T00:00:31.000Z"),
            permit_public_key=PERMIT_PUBLIC_KEY,
        )
    assert ledger.get_execution_dispatch(accepted.command.command_hash).state == "DISPATCH_PENDING"
    ledger._test_fencing_clock.value = T0 + 1  # type: ignore[attr-defined]
    first = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    repeat = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 2,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    assert repeat == first
    assert first.request["schemaVersion"] == "openalice_offline_simulator_request.v1"
    assert first.request["dispatchArmedAt"] == "2026-08-15T00:00:02.000Z"
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_attempts").fetchone()[0] == 1
    assert ledger.get_execution_dispatch(accepted.command.command_hash).state == "IN_FLIGHT"
    assert fixture["command"]["commandId"] == first.command_hash


def test_takeover_fences_old_lease_and_reconciliation_retains_original_attempt(ledger: Ledger) -> None:
    first_lease = lease(ledger, ttl=1.0)
    _, _, accepted = admitted_dispatch(ledger, first_lease)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=first_lease,
        now=T0 + 0.5,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    second_lease = lease(ledger, owner="owner-b", now=T0 + 2)
    with pytest.raises(OfflineDispatchUnavailable, match="must reconcile"):
        ledger.claim_offline_dispatch(
            command_hash=accepted.command.command_hash, writer_lease=second_lease,
            now=T0 + 2,
            permit_public_key=PERMIT_PUBLIC_KEY,
        )
    with pytest.raises(StaleLease):
        ledger.mark_reconciliation_required(
            command_hash=accepted.command.command_hash, writer_lease=first_lease,
            now=T0 + 2,
        )
    marked = ledger.mark_reconciliation_required(
        command_hash=accepted.command.command_hash, writer_lease=second_lease,
        now=T0 + 2,
    )
    claim = ledger.claim_offline_reconciliation(
        command_hash=accepted.command.command_hash, writer_lease=second_lease,
        now=T0 + 3,
    )
    assert marked.original_attempt_id == attempt.attempt_id
    assert claim.original_attempt_id == attempt.attempt_id
    assert claim.writer_epoch == second_lease.epoch
    dispatch = ledger.get_execution_dispatch(accepted.command.command_hash)
    assert dispatch.reconciliation_claim_id == claim.claim_id
    assert dispatch.original_attempt_id == attempt.attempt_id


def test_tampered_policy_or_attempt_rows_fail_closed_on_read(ledger: Ledger) -> None:
    writer = lease(ledger)
    _, registered, accepted = admitted_dispatch(ledger, writer)
    # The normal SQLite trigger rejects mutation.  Simulate an out-of-process
    # privileged tamper that first removed that trigger; strict read parsing
    # still must not return a plausible dispatch.
    ledger._connection.execute("DROP TRIGGER offline_adapter_policies_immutable_update")
    ledger._connection.execute(
        "UPDATE offline_adapter_policies SET policy_json = ? WHERE policy_hash = ?",
        ("{}", registered.policy_hash),
    )
    with pytest.raises(MalformedOfflineDispatchRecord):
        ledger.get_execution_dispatch(accepted.command.command_hash)


def simulator_response(attempt) -> bytes:
    request = attempt.request
    value = {
        "schemaVersion": "openalice_offline_simulator_response.v1",
        "sourceNamespaceId": request["sourceNamespaceId"],
        "sourceSequence": "1",
        "commandId": request["commandId"],
        "attemptId": request["attemptId"],
        "requestHash": attempt.request_hash,
        "clientOrderId": request["clientOrderId"],
        "state": "submitted",
        "simulatorOccurredAt": request["dispatchArmedAt"],
        "simulatedOrderId": "SIM0123456789ABCDEF",
    }
    return stable_stringify(value).encode("utf-8")


def simulator_result(
    ledger: Ledger,
    attempt,
    writer_lease,
    *,
    now: float = T0 + 2,
):
    ledger._test_fencing_clock.value = now  # type: ignore[attr-defined]
    capability = ledger.issue_offline_simulator_capability(
        command_hash=attempt.command_hash,
        writer_lease=writer_lease,
        now=now,
    )
    simulator_path = Path(ledger.database_path).with_name("offline-simulator.sqlite3")
    simulator = OfflineSimulatorStore(
        simulator_path,
        store_id=SIMULATOR_STORE_ID,
        capability_public_keys={
            "offline-capability-authority": CAPABILITY_PUBLIC_KEY
        },
        source_attestation_key_id=SOURCE_KEY_ID,
        source_attestation_private_key=SOURCE_PRIVATE_KEY,
        capability_clock=lambda: datetime.fromtimestamp(now, timezone.utc),
        allow_provision=not simulator_path.exists(),
    )
    try:
        return simulator.ensure_exact(
            attempt.request,
            canonical_capability_json_utf8=capability.capability_json.encode(
                "utf-8"
            ),
        )
    finally:
        simulator.close()


def signed_effect_with_store_link(
    result, *, store_sequence: str, previous_store_chain_hash: str
) -> bytes:
    """Create a cryptographically valid source proof with a chosen store link.

    The signer is the fixture's pinned source-attestation authority, so this
    exercises Ledger's durable-anchor rejection rather than an earlier
    malformed/signature rejection.
    """
    core = {
        key: value
        for key, value in result.effect.items()
        if key not in {"effectId", "signature"}
    }
    core["storeSequence"] = store_sequence
    core["previousStoreChainHash"] = previous_store_chain_hash
    core["storeChainHash"] = "0" * 64
    core["storeChainHash"] = offline_simulator_store_chain_v1_hash(core)
    return stable_stringify(
        create_offline_simulator_effect_v1(
            core=core, private_key=SOURCE_PRIVATE_KEY
        )
    ).encode("utf-8")


def test_source_proven_commit_is_atomic_idempotent_and_signature_verified(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    committed = ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )
    repeated = ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 3,
    )
    assert repeated == committed
    first_head = ledger._connection.execute(
        """SELECT source_store_sequence, source_store_chain_hash
           FROM offline_source_store_heads WHERE source_store_id = ?""",
        (SIMULATOR_STORE_ID,),
    ).fetchone()
    assert first_head is not None
    assert tuple(first_head) == ("1", result.effect["storeChainHash"])
    assert ledger.get_offline_execution_receipt(committed.receipt_id, receipt_public_key=PUBLIC_KEY) == committed
    with pytest.raises(ValueError, match="receipt_public_key"):
        ledger.get_execution_dispatch(accepted.command.command_hash)
    assert ledger.get_execution_dispatch(
        accepted.command.command_hash, receipt_public_key=PUBLIC_KEY
    ).state == "RECEIPT_COMMITTED"
    assert ledger._connection.execute("SELECT COUNT(*) FROM offline_execution_receipts").fetchone()[0] == 1
    assert ledger.latest_lifecycle_sequence() == 2

    with pytest.raises(TypeError):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            receipt_private_key=PRIVATE_KEY,
            writer_lease=writer,
        )


def test_source_store_anchor_rejects_forks_without_terminal_side_effects(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    # It is signed and binds the issued capability/request/response, but it
    # claims a non-genesis store link.  Anchor admission must reject it with
    # no receipt, lifecycle, terminal dispatch, or head mutation.
    forged = signed_effect_with_store_link(
        result, store_sequence="2", previous_store_chain_hash="f" * 64
    )
    with pytest.raises(OfflineDispatchUnavailable, match="source store chain"):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=forged,
            writer_lease=writer,
            now=T0 + 2,
        )
    assert ledger._connection.execute(
        "SELECT COUNT(*) FROM offline_execution_receipts"
    ).fetchone()[0] == 0
    assert ledger._connection.execute(
        "SELECT COUNT(*) FROM offline_source_store_heads"
    ).fetchone()[0] == 0
    assert ledger.latest_lifecycle_sequence() == 1
    assert ledger.get_execution_dispatch(accepted.command.command_hash).state == "IN_FLIGHT"


def test_source_store_anchor_advances_second_effect_and_survives_reopen(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, first_accepted = admitted_dispatch(ledger, writer)
    first_attempt = ledger.claim_offline_dispatch(
        command_hash=first_accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    first_result = simulator_result(ledger, first_attempt, writer)
    first_receipt = ledger.commit_offline_execution_receipt(
        command_hash=first_accepted.command.command_hash,
        canonical_response_json_utf8=first_result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=first_result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )

    _, _, second_accepted = admitted_dispatch(
        ledger, writer, idempotency_key="intent-2"
    )
    second_attempt = ledger.claim_offline_dispatch(
        command_hash=second_accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 3,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    second_result = simulator_result(ledger, second_attempt, writer, now=T0 + 4)
    assert second_result.effect["storeSequence"] == "2"
    # The second real simulator proof is forked only by replacing its signed
    # predecessor.  It is otherwise a valid trusted source proof.
    forged = signed_effect_with_store_link(
        second_result,
        store_sequence="2",
        previous_store_chain_hash="e" * 64,
    )
    with pytest.raises(OfflineDispatchUnavailable, match="source store chain"):
        ledger.commit_offline_execution_receipt(
            command_hash=second_accepted.command.command_hash,
            canonical_response_json_utf8=second_result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=forged,
            writer_lease=writer,
            now=T0 + 5,
        )
    assert ledger._connection.execute(
        "SELECT COUNT(*) FROM offline_execution_receipts"
    ).fetchone()[0] == 1
    assert ledger.get_execution_dispatch(second_accepted.command.command_hash).state == "IN_FLIGHT"

    second_receipt = ledger.commit_offline_execution_receipt(
        command_hash=second_accepted.command.command_hash,
        canonical_response_json_utf8=second_result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=second_result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 6,
    )
    second_head = ledger._connection.execute(
        """SELECT source_store_sequence, source_store_chain_hash
           FROM offline_source_store_heads WHERE source_store_id = ?""",
        (SIMULATOR_STORE_ID,),
    ).fetchone()
    assert second_head is not None
    assert tuple(second_head) == ("2", second_result.effect["storeChainHash"])

    database = ledger.database_path
    ledger.close()
    reopened = Ledger(
        database,
        fencing_clock=MutableFencingClock(T0 + 6),
        offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
    )
    try:
        assert reopened.get_execution_dispatch(
            first_accepted.command.command_hash, receipt_public_key=PUBLIC_KEY
        ).state == "RECEIPT_COMMITTED"
        assert reopened.get_offline_execution_receipt(
            first_receipt.receipt_id, receipt_public_key=PUBLIC_KEY
        ) == first_receipt
        assert reopened.get_offline_execution_receipt(
            second_receipt.receipt_id, receipt_public_key=PUBLIC_KEY
        ) == second_receipt
    finally:
        reopened.close()


def test_committed_receipts_without_a_store_anchor_fail_closed_on_reopen(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )
    database = ledger.database_path
    ledger.close()
    with sqlite3.connect(database) as connection:
        connection.execute("DROP TABLE offline_source_store_heads")
    with pytest.raises(MalformedOfflineDispatchRecord, match="legacy offline receipt"):
        Ledger(database)


def test_response_without_matching_source_proof_is_rejected_before_any_write(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1, permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    bad = json.loads(result.canonical_response_json_utf8)
    bad["sourceSequence"] = "999"
    with pytest.raises(MalformedOfflineDispatchRecord, match="source effect"):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=stable_stringify(bad).encode(),
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            writer_lease=writer,
            now=T0 + 2,
        )
    assert ledger._connection.execute("SELECT COUNT(*) FROM offline_execution_receipts").fetchone()[0] == 0
    assert ledger.latest_lifecycle_sequence() == 1


@pytest.mark.parametrize(
    "tamper",
    ("signature", "wrong-store", "missing-capability"),
)
def test_source_effect_requires_signature_store_and_ledger_issued_capability(
    ledger: Ledger, tamper: str
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    effect = result.effect
    if tamper == "signature":
        effect["signature"] = base64.b64encode(b"x" * 64).decode("ascii")
    elif tamper == "wrong-store":
        core = {
            key: value
            for key, value in effect.items()
            if key not in {"effectId", "signature"}
        }
        core["storeId"] = "8" * 64
        effect = create_offline_simulator_effect_v1(
            core=core, private_key=SOURCE_PRIVATE_KEY
        )
    else:
        ledger._connection.execute(
            "DELETE FROM offline_simulator_capabilities WHERE capability_id = ?",
            (effect["capabilityId"],),
        )
    with pytest.raises(MalformedOfflineDispatchRecord, match="source effect"):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=stable_stringify(effect).encode(
                "utf-8"
            ),
            writer_lease=writer,
            now=T0 + 3,
        )
    assert ledger._connection.execute(
        "SELECT COUNT(*) FROM offline_execution_receipts"
    ).fetchone()[0] == 0
    assert ledger.latest_lifecycle_sequence() == 1


def test_tampered_committed_signature_fails_read_and_exact_retry(ledger: Ledger) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1, permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    receipt = ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )
    altered = receipt.receipt
    altered["signature"] = base64.b64encode(b"x" * 64).decode("ascii")
    ledger._connection.execute("UPDATE offline_execution_receipts SET receipt_json = ? WHERE receipt_id = ?", (json.dumps(altered, sort_keys=True, separators=(",", ":")), receipt.receipt_id))
    with pytest.raises(MalformedOfflineDispatchRecord):
        ledger.get_offline_execution_receipt(receipt.receipt_id, receipt_public_key=PUBLIC_KEY)
    with pytest.raises(MalformedOfflineDispatchRecord):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            writer_lease=writer,
            now=T0 + 3,
        )


def test_tampered_committed_source_effect_fails_read_and_exact_retry(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    receipt = ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )
    altered = result.effect
    altered["signature"] = base64.b64encode(b"x" * 64).decode("ascii")
    altered_bytes = stable_stringify(altered).encode("utf-8")
    ledger._connection.execute(
        """UPDATE offline_execution_receipts
           SET canonical_source_effect_json = ? WHERE receipt_id = ?""",
        (altered_bytes.decode("utf-8"), receipt.receipt_id),
    )
    with pytest.raises(MalformedOfflineDispatchRecord, match="source effect"):
        ledger.get_offline_execution_receipt(
            receipt.receipt_id, receipt_public_key=PUBLIC_KEY
        )
    with pytest.raises(MalformedOfflineDispatchRecord, match="source effect"):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=altered_bytes,
            writer_lease=writer,
            now=T0 + 3,
        )


def test_signed_capability_is_exact_reopenable_and_keeps_private_key_out_of_db(tmp_path: Path) -> None:
    path = tmp_path / "capability.sqlite3"
    clock = MutableFencingClock(T0)
    instance = Ledger(
        path, offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
        fencing_clock=clock,
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    writer = lease(instance)
    _, _, accepted = admitted_dispatch(instance, writer)
    attempt = instance.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1, permit_public_key=PERMIT_PUBLIC_KEY,
    )
    first = instance.issue_offline_simulator_capability(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 2,
    )
    repeat = instance.issue_offline_simulator_capability(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 3,
    )
    assert repeat == first
    assert first.value["attemptId"] == attempt.attempt_id
    assert first.value["attemptAdapterEpoch"] == attempt.adapter_epoch
    assert first.value["writerEpoch"] == str(writer.epoch)
    assert first.value["reconciliationClaimId"] if "reconciliationClaimId" in first.value else None is None
    assert CAPABILITY_PRIVATE_KEY.private_bytes_raw() not in instance._connection.execute(
        "SELECT capability_json FROM offline_simulator_capabilities"
    ).fetchone()[0].encode()
    instance.close()
    reopened = Ledger(
        path, offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
        fencing_clock=clock,
    )
    try:
        assert reopened.get_offline_simulator_capability(first.capability_id) == first
    finally:
        reopened.close()


def test_takeover_capability_uses_original_attempt_and_current_writer(tmp_path: Path) -> None:
    clock = MutableFencingClock(T0)
    instance = Ledger(
        tmp_path / "takeover-capability.sqlite3",
        offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
        fencing_clock=clock,
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    try:
        first_lease = lease(instance, ttl=1.0)
        _, _, accepted = admitted_dispatch(instance, first_lease)
        attempt = instance.claim_offline_dispatch(
            command_hash=accepted.command.command_hash, writer_lease=first_lease,
            now=T0 + 0.5, permit_public_key=PERMIT_PUBLIC_KEY,
        )
        second_lease = lease(instance, owner="owner-b", now=T0 + 2)
        instance.mark_reconciliation_required(
            command_hash=accepted.command.command_hash, writer_lease=second_lease,
            now=T0 + 2,
        )
        claim = instance.claim_offline_reconciliation(
            command_hash=accepted.command.command_hash, writer_lease=second_lease,
            now=T0 + 3,
        )
        with pytest.raises(OfflineDispatchUnavailable):
            instance.issue_offline_simulator_capability(
                command_hash=accepted.command.command_hash, writer_lease=second_lease,
                now=T0 + 4,
            )
        capability = instance.issue_offline_simulator_capability(
            command_hash=accepted.command.command_hash, writer_lease=second_lease,
            reconciliation_claim_id=claim.claim_id, now=T0 + 4,
        )
        assert capability.value["attemptId"] == attempt.attempt_id
        assert capability.value["attemptAdapterEpoch"] == "1"
        assert capability.value["writerEpoch"] == str(second_lease.epoch)
        assert capability.value["reconciliationClaimId"] == claim.claim_id
    finally:
        instance.close()


def test_v1_policy_is_diagnostic_only_and_cannot_create_dispatch(ledger: Ledger) -> None:
    writer = lease(ledger)
    legacy = policy(
        schemaVersion="openalice_offline_adapter_policy.v1",
        capability="offline_simulator.ensure_exact.v1",
        adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PUBLIC_KEY),
        permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(PERMIT_PUBLIC_KEY),
    )
    del legacy["simulatorCapabilityAuthorityKeyId"]
    del legacy["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
    del legacy["simulatorStoreId"]
    del legacy["sourceAttestationKeyId"]
    del legacy["sourceAttestationPublicKeySpkiSha256"]
    registered = ledger.register_offline_adapter_policy(
        policy=legacy, writer_lease=writer, now=T0
    )
    fixture = fixture_contract()
    payload = dict(fixture["command"]["payload"])
    payload["mode"] = "PAPER_LOCAL"
    command = build_execution_command_v1(payload)
    permit = dict(fixture["permit"])
    permit["mode"] = "PAPER_LOCAL"
    permit["commandHash"] = command["commandId"]
    permit["permitId"] = sha256_canonical({key: value for key, value in permit.items() if key not in {"permitId", "signature"}})
    permit["signature"] = base64.b64encode(PERMIT_PRIVATE_KEY.sign(execution_permit_v2_signing_payload(permit).encode())).decode()
    with pytest.raises(OfflineDispatchPolicyMismatch, match="V3"):
        ledger.admit_execution_command(
            command=command, permit=permit, writer_lease=writer, now=T0,
            offline_adapter_policy_hash=registered.policy_hash,
            permit_public_key=PERMIT_PUBLIC_KEY,
        )
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_dispatches").fetchone()[0] == 0


def test_v2_policy_is_diagnostic_only_and_cannot_create_dispatch(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    legacy = policy(
        schemaVersion="openalice_offline_adapter_policy.v2",
        adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
            PUBLIC_KEY
        ),
        permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
            PERMIT_PUBLIC_KEY
        ),
    )
    del legacy["simulatorStoreId"]
    del legacy["sourceAttestationKeyId"]
    del legacy["sourceAttestationPublicKeySpkiSha256"]
    registered = ledger.register_offline_adapter_policy(
        policy=legacy, writer_lease=writer, now=T0
    )
    fixture = fixture_contract()
    payload = dict(fixture["command"]["payload"])
    payload["mode"] = "PAPER_LOCAL"
    command = build_execution_command_v1(payload)
    permit = dict(fixture["permit"])
    permit["mode"] = "PAPER_LOCAL"
    permit["commandHash"] = command["commandId"]
    permit["permitId"] = sha256_canonical(
        {
            key: value
            for key, value in permit.items()
            if key not in {"permitId", "signature"}
        }
    )
    permit["signature"] = base64.b64encode(
        PERMIT_PRIVATE_KEY.sign(
            execution_permit_v2_signing_payload(permit).encode()
        )
    ).decode()
    with pytest.raises(OfflineDispatchPolicyMismatch, match="V3"):
        ledger.admit_execution_command(
            command=command,
            permit=permit,
            writer_lease=writer,
            now=T0,
            offline_adapter_policy_hash=registered.policy_hash,
            permit_public_key=PERMIT_PUBLIC_KEY,
        )
    assert ledger._connection.execute(
        "SELECT COUNT(*) FROM execution_dispatches"
    ).fetchone()[0] == 0


def test_require_local_offline_policy_authorities_is_strict_and_public_only(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, registered, _ = admitted_dispatch(ledger, writer)

    ready = ledger.require_local_offline_policy_authorities(
        registered.policy_hash, permit_public_key=PERMIT_PUBLIC_KEY
    )
    assert ready == registered
    assert PRIVATE_KEY.private_bytes_raw() not in ready.policy_json.encode("utf-8")
    assert not hasattr(ready, "private_key")

    with pytest.raises(OfflineDispatchUnavailable, match="not registered"):
        ledger.require_local_offline_policy_authorities(
            "f" * 64, permit_public_key=PERMIT_PUBLIC_KEY
        )
    with pytest.raises(ValueError, match="lowercase"):
        ledger.require_local_offline_policy_authorities(
            "F" * 64, permit_public_key=PERMIT_PUBLIC_KEY
        )
    with pytest.raises(OfflineDispatchUnavailable, match="permit public key"):
        ledger.require_local_offline_policy_authorities(
            registered.policy_hash,
            permit_public_key=Ed25519PrivateKey.generate().public_key(),
        )


def test_require_local_offline_policy_authorities_rejects_legacy_policy(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    legacy = policy(
        schemaVersion="openalice_offline_adapter_policy.v1",
        capability="offline_simulator.ensure_exact.v1",
        adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
            PUBLIC_KEY
        ),
        permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
            PERMIT_PUBLIC_KEY
        ),
    )
    del legacy["simulatorCapabilityAuthorityKeyId"]
    del legacy["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
    del legacy["simulatorStoreId"]
    del legacy["sourceAttestationKeyId"]
    del legacy["sourceAttestationPublicKeySpkiSha256"]
    registered = ledger.register_offline_adapter_policy(
        policy=legacy, writer_lease=writer, now=T0
    )
    with pytest.raises(OfflineDispatchUnavailable, match="V3"):
        ledger.require_local_offline_policy_authorities(
            registered.policy_hash, permit_public_key=PERMIT_PUBLIC_KEY
        )


@pytest.mark.parametrize("mismatch", ("receipt", "capability", "source"))
def test_require_local_offline_policy_authorities_rejects_wrong_constructor_authority(
    tmp_path: Path, mismatch: str
) -> None:
    clock = MutableFencingClock(T0)
    kwargs: dict[str, object] = {
        "fencing_clock": clock,
        "offline_capability_authority_private_key": CAPABILITY_PRIVATE_KEY,
        "offline_capability_authority_key_id": "offline-capability-authority",
        "offline_receipt_signing_private_key": PRIVATE_KEY,
        "offline_receipt_signing_key_id": "offline-adapter-key",
        "offline_source_attestation_public_keys": {SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
    }
    if mismatch == "receipt":
        kwargs["offline_receipt_signing_private_key"] = Ed25519PrivateKey.generate()
    elif mismatch == "capability":
        kwargs["offline_capability_authority_private_key"] = Ed25519PrivateKey.generate()
    else:
        kwargs["offline_source_attestation_public_keys"] = {
            SOURCE_KEY_ID: Ed25519PrivateKey.generate().public_key()
        }
    instance = Ledger(tmp_path / f"wrong-{mismatch}.sqlite3", **kwargs)
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    try:
        writer = lease(instance)
        registered = instance.register_offline_adapter_policy(
            policy=policy(
                adapterPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
                    PUBLIC_KEY
                ),
                permitAuthorityPublicKeySpkiSha256=ed25519_public_key_fingerprint_sha256(
                    PERMIT_PUBLIC_KEY
                ),
            ),
            writer_lease=writer,
            now=T0,
        )
        with pytest.raises(OfflineDispatchUnavailable, match="local"):
            instance.require_local_offline_policy_authorities(
                registered.policy_hash, permit_public_key=PERMIT_PUBLIC_KEY
            )
    finally:
        instance.close()


def test_list_incomplete_offline_dispatches_orders_filters_and_limits(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, pending = admitted_dispatch(ledger, writer, idempotency_key="list-pending")
    _, _, in_flight = admitted_dispatch(ledger, writer, idempotency_key="list-in-flight")
    ledger.claim_offline_dispatch(
        command_hash=in_flight.command.command_hash,
        writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    _, _, reconciling = admitted_dispatch(ledger, writer, idempotency_key="list-reconciling")
    ledger.claim_offline_dispatch(
        command_hash=reconciling.command.command_hash,
        writer_lease=writer,
        now=T0 + 2,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    ledger.mark_reconciliation_required(
        command_hash=reconciling.command.command_hash, writer_lease=writer, now=T0 + 3
    )
    ledger.claim_offline_reconciliation(
        command_hash=reconciling.command.command_hash, writer_lease=writer, now=T0 + 4
    )
    _, _, committed = admitted_dispatch(ledger, writer, idempotency_key="list-committed")
    attempt = ledger.claim_offline_dispatch(
        command_hash=committed.command.command_hash,
        writer_lease=writer,
        now=T0 + 5,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer, now=T0 + 6)
    ledger.commit_offline_execution_receipt(
        command_hash=committed.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 7,
    )

    dispatches = ledger.list_incomplete_offline_dispatches()
    assert [(item.command_hash, item.state) for item in dispatches] == [
        (pending.command.command_hash, "DISPATCH_PENDING"),
        (in_flight.command.command_hash, "IN_FLIGHT"),
        (reconciling.command.command_hash, "RECONCILIATION_REQUIRED"),
    ]
    assert ledger.list_incomplete_offline_dispatches(limit=1) == [dispatches[0]]
    assert committed.command.command_hash not in {
        item.command_hash for item in dispatches
    }


@pytest.mark.parametrize("limit", (True, 0, -1, 10_001, 1.0, "1"))
def test_list_incomplete_offline_dispatches_rejects_non_strict_limits(
    ledger: Ledger, limit: object
) -> None:
    with pytest.raises(ValueError, match="limit"):
        ledger.list_incomplete_offline_dispatches(limit=limit)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "tamper", ("missing-sequence", "missing-lifecycle", "missing-policy")
)
def test_list_incomplete_offline_dispatches_fails_closed_on_missing_reference(
    ledger: Ledger, tamper: str
) -> None:
    writer = lease(ledger)
    _, registered, accepted = admitted_dispatch(ledger, writer)
    if tamper == "missing-sequence":
        ledger._connection.execute(
            "UPDATE execution_commands SET accepted_sequence = NULL WHERE command_hash = ?",
            (accepted.command.command_hash,),
        )
        with pytest.raises(MalformedLifecycleRecord, match="no accepted_sequence"):
            ledger.list_incomplete_offline_dispatches()
    elif tamper == "missing-lifecycle":
        ledger._connection.execute(
            "UPDATE execution_commands SET accepted_sequence = ? WHERE command_hash = ?",
            (99_999, accepted.command.command_hash),
        )
        with pytest.raises((LifecycleSequenceGap, MalformedLifecycleRecord)):
            ledger.list_incomplete_offline_dispatches()
    else:
        ledger._connection.execute("PRAGMA foreign_keys = OFF")
        ledger._connection.execute(
            "DROP TRIGGER offline_adapter_policies_immutable_delete"
        )
        ledger._connection.execute(
            "DELETE FROM offline_adapter_policies WHERE policy_hash = ?",
            (registered.policy_hash,),
        )
        ledger._connection.execute("PRAGMA foreign_keys = ON")
        with pytest.raises(MalformedOfflineDispatchRecord, match="absent offline policy"):
            ledger.list_incomplete_offline_dispatches()


def test_list_incomplete_offline_dispatches_rejects_duplicate_accepted_sequence(
    ledger: Ledger,
) -> None:
    writer = lease(ledger)
    _, _, first = admitted_dispatch(ledger, writer, idempotency_key="list-duplicate-1")
    _, _, second = admitted_dispatch(ledger, writer, idempotency_key="list-duplicate-2")
    first_sequence = ledger.get_command_by_hash(first.command.command_hash).accepted_sequence
    ledger._connection.execute("DROP INDEX execution_commands_accepted_sequence_unique")
    ledger._connection.execute(
        "UPDATE execution_commands SET accepted_sequence = ? WHERE command_hash = ?",
        (first_sequence, second.command.command_hash),
    )
    with pytest.raises(MalformedLifecycleRecord, match="duplicate"):
        ledger.list_incomplete_offline_dispatches()


def test_reconciliation_commit_allows_historical_permit_and_requires_current_claim(ledger: Ledger) -> None:
    first = lease(ledger, ttl=1.0)
    _, _, accepted = admitted_dispatch(ledger, first)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=first,
        now=T0 + 0.5,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, first, now=T0 + 0.6)
    second = lease(ledger, owner="owner-b", now=T0 + 40)
    ledger.mark_reconciliation_required(
        command_hash=accepted.command.command_hash, writer_lease=second,
        now=T0 + 40,
    )
    claim = ledger.claim_offline_reconciliation(
        command_hash=accepted.command.command_hash, writer_lease=second,
        now=T0 + 41,
    )
    with pytest.raises(Exception):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            writer_lease=second,
            now=T0 + 42,
        )
    committed = ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=result.canonical_response_json_utf8,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=second,
        reconciliation_claim_id=claim.claim_id, now=T0 + 42,
    )
    assert committed.original_attempt_id == attempt.attempt_id
    assert committed.reconciliation_claim_id == claim.claim_id
    assert ledger.get_offline_reconciliation_claim(claim.claim_id).status == "COMPLETED"


def test_changed_source_response_after_commit_suspends_without_second_receipt(ledger: Ledger) -> None:
    writer = lease(ledger)
    _, _, accepted = admitted_dispatch(ledger, writer)
    attempt = ledger.claim_offline_dispatch(
        command_hash=accepted.command.command_hash, writer_lease=writer,
        now=T0 + 1,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    result = simulator_result(ledger, attempt, writer)
    response = result.canonical_response_json_utf8
    ledger.commit_offline_execution_receipt(
        command_hash=accepted.command.command_hash,
        canonical_response_json_utf8=response,
        canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
        writer_lease=writer,
        now=T0 + 2,
    )
    altered = json.loads(response)
    altered["sourceSequence"] = "2"
    with pytest.raises(IdempotencyConflict):
        ledger.commit_offline_execution_receipt(
            command_hash=accepted.command.command_hash,
            canonical_response_json_utf8=stable_stringify(altered).encode(),
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            writer_lease=writer,
            now=T0 + 3,
        )
    assert ledger._connection.execute("SELECT COUNT(*) FROM offline_execution_receipts").fetchone()[0] == 1
    assert ledger.runtime_state()["mode"] == "suspended"
