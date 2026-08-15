"""Focused offline tests for the Phase-4 durable paper-sidecar core."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from cryptography.hazmat.primitives.serialization import load_der_private_key

from sidecars.nautilus_paper.contract import (
    build_execution_command_v1,
    execution_permit_v2_signing_payload,
    sha256_canonical,
    stable_stringify,
)
from sidecars.nautilus_paper.core import (
    CoreAdmissionDenied,
    OfflineAdmissionBinding,
    PaperSidecarCore,
)
from sidecars.nautilus_paper.environment import (
    PAPER_EXCHANGE,
    PAPER_LOCAL,
    StaticEnvironmentProvider,
    build_paper_environment_proof_v1,
)
from sidecars.nautilus_paper.ledger import Ledger
from sidecars.nautilus_paper.offline_receipt import (
    ed25519_public_key_fingerprint_sha256,
)


NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
SCHEMA_HASH = "a" * 64
RUN_ID = "paper-run-phase-4"
PUBLIC_KEY_DER = bytes.fromhex(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a"
    "0ee172f3daa62325af021a68f707511a"
)
PRIVATE_KEY = load_der_private_key(
    bytes.fromhex(
        "302e020100300506032b657004220420"
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    ),
    password=None,
)
OFFLINE_RECEIPT_PRIVATE_KEY = Ed25519PrivateKey.generate()
OFFLINE_RECEIPT_PUBLIC_KEY = OFFLINE_RECEIPT_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
OFFLINE_CAPABILITY_PRIVATE_KEY = Ed25519PrivateKey.generate()
OFFLINE_CAPABILITY_PUBLIC_KEY = OFFLINE_CAPABILITY_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
OFFLINE_SOURCE_PRIVATE_KEY = Ed25519PrivateKey.generate()
OFFLINE_SOURCE_PUBLIC_KEY = OFFLINE_SOURCE_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)


def golden_fixture() -> dict:
    path = Path(__file__).resolve().parents[2] / "src/sidecar/fixtures/openalice_execution_contract_v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


def canonical_bytes(value: object) -> bytes:
    return stable_stringify(value).encode("utf-8")


def proof(*, expires_at: datetime | None = None, schema_hash: str = SCHEMA_HASH, run_id: str = RUN_ID):
    return build_paper_environment_proof_v1(
        observed_at=NOW - timedelta(seconds=1),
        expires_at=expires_at or NOW + timedelta(seconds=60),
        mode=PAPER_EXCHANGE,
        run_id=run_id,
        config_digest="b" * 64,
        schema_hash=schema_hash,
        endpoint_class="okx_demo",
        credential_class="demo_only",
        execution_client_registered=True,
        now=NOW,
    )


def local_proof(*, expires_at: datetime | None = None):
    return build_paper_environment_proof_v1(
        observed_at=NOW - timedelta(seconds=1),
        expires_at=expires_at or NOW + timedelta(seconds=60),
        mode=PAPER_LOCAL,
        run_id=RUN_ID,
        config_digest="b" * 64,
        schema_hash=SCHEMA_HASH,
        endpoint_class="local_sandbox",
        credential_class="none",
        execution_client_registered=False,
        now=NOW,
    )


def paper_local_item() -> dict:
    fixture = golden_fixture()
    payload = dict(fixture["command"]["payload"])
    payload["mode"] = PAPER_LOCAL
    command = build_execution_command_v1(payload)
    permit = dict(fixture["permit"])
    permit["mode"] = PAPER_LOCAL
    permit["commandHash"] = command["commandId"]
    permit["permitId"] = sha256_canonical(
        {key: value for key, value in permit.items() if key not in {"permitId", "signature"}}
    )
    permit["signature"] = base64.b64encode(
        PRIVATE_KEY.sign(execution_permit_v2_signing_payload(permit).encode("utf-8"))
    ).decode("ascii")
    return {"command": command, "permit": permit}


def v3_policy() -> dict[str, object]:
    return {
        "schemaVersion": "openalice_offline_adapter_policy.v3",
        "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only",
        "mode": PAPER_LOCAL,
        "adapterId": "openalice.offline-simulator",
        "adapterBuildHash": "a" * 64,
        "adapterConfigHash": "b" * 64,
        "adapterRunId": "offline-run-core-test",
        "sourceNamespaceId": "c" * 64,
        "adapterKeyId": "offline-adapter-key",
        "adapterPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(OFFLINE_RECEIPT_PUBLIC_KEY),
        "permitAuthorityKeyId": "rfc8032-test-1",
        "permitAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(PUBLIC_KEY_DER),
        "simulatorCapabilityAuthorityKeyId": "offline-capability-key",
        "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(OFFLINE_CAPABILITY_PUBLIC_KEY),
        "simulatorStoreId": "f" * 64,
        "sourceAttestationKeyId": "offline-source-key",
        "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(OFFLINE_SOURCE_PUBLIC_KEY),
        "capability": "offline_simulator.ensure_exact.v2",
        "ensureExact": True,
        "finalizationEligible": False,
    }


@pytest.fixture
def ledger(tmp_path):
    clock = [NOW.timestamp()]
    instance = Ledger(
        tmp_path / "core.sqlite3",
        fencing_clock=lambda: clock[0],
        offline_capability_authority_private_key=OFFLINE_CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-key",
        offline_receipt_signing_private_key=OFFLINE_RECEIPT_PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={"offline-source-key": OFFLINE_SOURCE_PUBLIC_KEY},
    )
    instance._test_fencing_clock = clock  # type: ignore[attr-defined]
    yield instance
    instance.close()


def configured_core(
    ledger: Ledger,
    *,
    source_proof=None,
    clock=lambda: NOW,
    lease=None,
    offline_admission_binding: OfflineAdmissionBinding | None = None,
) -> PaperSidecarCore:
    core = PaperSidecarCore(
        ledger,
        environment_provider=StaticEnvironmentProvider(source_proof or proof(), clock=clock),
        resolve_public_key=lambda key_id: PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None,
        expected_schema_hash=SCHEMA_HASH,
        run_id=RUN_ID,
        expected_key_ids=("rfc8032-test-1",),
        offline_admission_binding=offline_admission_binding,
        clock=clock,
    )
    active = lease or ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=120
    )
    core.bind_writer_lease(active)
    return core


def admit(core: PaperSidecarCore, item: dict, *, now: datetime | None = None):
    return core.admit(
        command=item["command"],
        permit=item["permit"],
        command_payload_bytes=canonical_bytes(item["command"]["payload"]),
        permit_bytes=canonical_bytes(item["permit"]),
        now=now,
    )


def test_default_core_denies_and_never_advertises_broker_submission(ledger: Ledger) -> None:
    item = golden_fixture()
    core = PaperSidecarCore(ledger, clock=lambda: NOW)
    with pytest.raises(CoreAdmissionDenied):
        admit(core, item)
    status = core.handshake()
    assert status.status == "unavailable"
    assert status.execution_client_invoked is False
    assert status.broker_submission_enabled is False
    assert status.writer_lease_bound is False


def test_paper_local_binding_creates_one_pending_dispatch_and_duplicate_is_unique(
    ledger: Ledger,
) -> None:
    writer = ledger.acquire_writer_lease(
        name="offline-policy", owner_id="policy-a", ttl_seconds=120
    )
    registered = ledger.register_offline_adapter_policy(
        policy=v3_policy(), writer_lease=writer, now=NOW.timestamp()
    )
    binding = OfflineAdmissionBinding(
        policy_hash=registered.policy_hash,
        permit_authority_key_id="rfc8032-test-1",
        permit_public_key=PUBLIC_KEY_DER,
    )
    core = configured_core(
        ledger,
        source_proof=local_proof(),
        offline_admission_binding=binding,
    )
    item = paper_local_item()

    first = admit(core, item)
    dispatch = ledger.get_execution_dispatch(first.receipt.command.command_hash)
    assert dispatch is not None
    assert dispatch.policy_hash == registered.policy_hash
    assert dispatch.state == "DISPATCH_PENDING"

    duplicate = admit(core, item)
    assert duplicate.receipt.created is False
    assert ledger.get_execution_dispatch(first.receipt.command.command_hash) == dispatch
    assert ledger._connection.execute("SELECT COUNT(*) FROM execution_dispatches").fetchone()[0] == 1


def test_paper_local_without_binding_preserves_durable_only_admission(ledger: Ledger) -> None:
    core = configured_core(ledger, source_proof=local_proof())
    accepted = admit(core, paper_local_item())
    assert accepted.receipt.created is True
    assert ledger.get_execution_dispatch(accepted.receipt.command.command_hash) is None


def test_paper_exchange_never_binds_configured_offline_policy(ledger: Ledger) -> None:
    core = configured_core(
        ledger,
        offline_admission_binding=OfflineAdmissionBinding(
            policy_hash="a" * 64,
            permit_authority_key_id="rfc8032-test-1",
            permit_public_key=PUBLIC_KEY_DER,
        ),
    )
    accepted = admit(core, golden_fixture())
    assert accepted.receipt.created is True
    assert ledger.get_execution_dispatch(accepted.receipt.command.command_hash) is None


def test_offline_admission_binding_rejects_invalid_constructor_and_freeze_inputs(
    ledger: Ledger,
) -> None:
    with pytest.raises(CoreAdmissionDenied) as malformed:
        configured_core(
            ledger,
            offline_admission_binding=OfflineAdmissionBinding(
                policy_hash="not-a-sha256",
                permit_authority_key_id="rfc8032-test-1",
                permit_public_key=PUBLIC_KEY_DER,
            ),
        )
    assert malformed.value.reason == "offline_admission_binding_invalid"
    assert str(malformed.value) == "offline_admission_binding_invalid"

    untrusted = configured_core(
        ledger,
        offline_admission_binding=OfflineAdmissionBinding(
            policy_hash="a" * 64,
            permit_authority_key_id="unknown-key",
            permit_public_key=PUBLIC_KEY_DER,
        ),
    )
    with pytest.raises(CoreAdmissionDenied) as unknown_key:
        untrusted.freeze_expected_public_keys()
    assert unknown_key.value.reason == "offline_admission_binding_untrusted_key_id"
    assert str(unknown_key.value) == "offline_admission_binding_untrusted_key_id"

    mismatched = configured_core(
        ledger,
        offline_admission_binding=OfflineAdmissionBinding(
            policy_hash="a" * 64,
            permit_authority_key_id="rfc8032-test-1",
            permit_public_key=b"\x00" * 32,
        ),
    )
    with pytest.raises(CoreAdmissionDenied) as mismatch:
        mismatched.freeze_expected_public_keys()
    assert mismatch.value.reason == "offline_admission_binding_key_mismatch"
    assert str(mismatch.value) == "offline_admission_binding_key_mismatch"


def test_runtime_binding_check_requires_frozen_exact_policy_and_key(ledger: Ledger) -> None:
    binding = OfflineAdmissionBinding(
        policy_hash="a" * 64,
        permit_authority_key_id="rfc8032-test-1",
        permit_public_key=PUBLIC_KEY_DER,
    )
    core = configured_core(ledger, offline_admission_binding=binding)
    with pytest.raises(CoreAdmissionDenied, match="offline_admission_binding_unavailable"):
        core.require_offline_admission_binding(binding.policy_hash, PUBLIC_KEY_DER)

    core.freeze_expected_public_keys()
    assert core.require_offline_admission_binding(binding.policy_hash, PUBLIC_KEY_DER) is None
    with pytest.raises(CoreAdmissionDenied) as mismatch:
        core.require_offline_admission_binding("b" * 64, PUBLIC_KEY_DER)
    assert mismatch.value.reason == "offline_admission_binding_unavailable"
    with pytest.raises(CoreAdmissionDenied, match="offline_admission_binding_unavailable"):
        core.require_offline_admission_binding(binding.policy_hash, b"\x00" * 32)


def test_offline_receipt_public_key_is_frozen_and_multiple_keys_fail_closed(
    ledger: Ledger,
) -> None:
    resolved = {"offline-receipt-key": PUBLIC_KEY_DER}
    core = PaperSidecarCore(
        ledger,
        resolve_offline_receipt_public_key=resolved.get,
        expected_offline_receipt_key_ids=("offline-receipt-key",),
        clock=lambda: NOW,
    )
    core.freeze_offline_receipt_public_keys()
    assert set(core._frozen_offline_receipt_public_keys or {}) == {"offline-receipt-key"}
    resolved["offline-receipt-key"] = b"not-a-public-key"
    # A mutable resolver cannot replace key material after it is pinned.
    core.freeze_offline_receipt_public_keys()
    assert set(core._frozen_offline_receipt_public_keys or {}) == {"offline-receipt-key"}

    ambiguous = PaperSidecarCore(
        ledger,
        resolve_offline_receipt_public_key=lambda _: PUBLIC_KEY_DER,
        expected_offline_receipt_key_ids=("offline-a", "offline-b"),
        clock=lambda: NOW,
    )
    with pytest.raises(CoreAdmissionDenied, match="offline_receipt_key_selection_ambiguous"):
        ambiguous.freeze_offline_receipt_public_keys()


def test_runtime_receipt_binding_requires_one_frozen_exact_public_key(
    ledger: Ledger,
) -> None:
    core = PaperSidecarCore(
        ledger,
        resolve_offline_receipt_public_key=lambda _: PUBLIC_KEY_DER,
        expected_offline_receipt_key_ids=("receipt-key",),
        clock=lambda: NOW,
    )
    with pytest.raises(CoreAdmissionDenied) as unfrozen:
        core.require_offline_receipt_binding("receipt-key", PUBLIC_KEY_DER)
    assert unfrozen.value.reason == "offline_receipt_binding_unavailable"

    core.freeze_offline_receipt_public_keys()
    assert core.require_offline_receipt_binding("receipt-key", PUBLIC_KEY_DER) is None
    for key_id, public_key in (
        ("wrong-key", PUBLIC_KEY_DER),
        ("receipt-key", b"\x00" * 32),
        ("receipt-key", b"not-an-ed25519-public-key"),
    ):
        with pytest.raises(CoreAdmissionDenied) as mismatch:
            core.require_offline_receipt_binding(key_id, public_key)
        assert mismatch.value.reason == "offline_receipt_binding_unavailable"
        assert str(mismatch.value) == "offline_receipt_binding_unavailable"


def test_runtime_receipt_binding_rejects_empty_and_ambiguous_configurations(
    ledger: Ledger,
) -> None:
    empty = PaperSidecarCore(ledger, clock=lambda: NOW)
    empty.freeze_offline_receipt_public_keys()
    with pytest.raises(CoreAdmissionDenied, match="offline_receipt_binding_unavailable"):
        empty.require_offline_receipt_binding("receipt-key", PUBLIC_KEY_DER)

    ambiguous = PaperSidecarCore(
        ledger,
        resolve_offline_receipt_public_key=lambda _: PUBLIC_KEY_DER,
        expected_offline_receipt_key_ids=("receipt-a", "receipt-b"),
        clock=lambda: NOW,
    )
    with pytest.raises(CoreAdmissionDenied, match="offline_receipt_key_selection_ambiguous"):
        ambiguous.freeze_offline_receipt_public_keys()
    with pytest.raises(CoreAdmissionDenied) as unavailable:
        ambiguous.require_offline_receipt_binding("receipt-a", PUBLIC_KEY_DER)
    assert unavailable.value.reason == "offline_receipt_binding_unavailable"


def test_offline_receipt_read_uses_only_the_frozen_public_key_and_hides_bad_signature() -> None:
    class ReceiptLedger:
        public_key = None

        def get_offline_execution_receipt(self, receipt_id, *, receipt_public_key):
            assert receipt_id == "a" * 64
            self.public_key = receipt_public_key
            raise ValueError("invalid receipt signature")

    ledger = ReceiptLedger()
    core = PaperSidecarCore(
        ledger,  # type: ignore[arg-type]
        resolve_offline_receipt_public_key=lambda _: PUBLIC_KEY_DER,
        expected_offline_receipt_key_ids=("server-frozen-key",),
        clock=lambda: NOW,
    )
    with pytest.raises(CoreAdmissionDenied, match="offline_receipt_unavailable"):
        core.get_offline_execution_receipt("a" * 64)
    assert ledger.public_key is not None


def test_handshake_status_exposes_only_verified_durable_identity(ledger: Ledger) -> None:
    core = configured_core(ledger)
    status = core.handshake()

    assert status.status == "ready_for_durable_admission"
    assert status.protocol_version == "openalice.execution.v1"
    assert status.service_id == "openalice.nautilus_paper.durable_admission"
    assert status.mode == PAPER_EXCHANGE
    assert status.run_id == RUN_ID
    assert status.environment_proof_hash == proof().proofHash
    assert status.schema_hash == SCHEMA_HASH
    assert status.writer_epoch == 1
    assert status.latest_sequence == 0
    assert status.execution_client_invoked is False
    assert status.broker_submission_enabled is False


@pytest.mark.parametrize("raw", [b'{"x": 1}', b'\xff'])
def test_noncanonical_or_invalid_raw_payload_is_rejected(ledger: Ledger, raw: bytes) -> None:
    item = golden_fixture()
    core = configured_core(ledger)
    with pytest.raises(CoreAdmissionDenied):
        core.admit(
            command=item["command"], permit=item["permit"],
            command_payload_bytes=raw, permit_bytes=canonical_bytes(item["permit"]),
        )
    assert ledger.latest_cursor() == 0


def test_raw_projection_mismatch_is_rejected_without_write(ledger: Ledger) -> None:
    item = golden_fixture()
    altered = deepcopy(item["command"]["payload"])
    altered["accountId"] = "other-paper-account"
    core = configured_core(ledger)
    with pytest.raises(CoreAdmissionDenied, match="raw_projection_mismatch"):
        core.admit(
            command=item["command"], permit=item["permit"],
            command_payload_bytes=canonical_bytes(altered), permit_bytes=canonical_bytes(item["permit"]),
        )
    assert ledger.latest_cursor() == 0


def test_bad_signature_and_expired_permit_are_rejected(ledger: Ledger) -> None:
    bad = golden_fixture()
    signature = bad["permit"]["signature"]
    bad["permit"]["signature"] = ("A" if signature[0] != "A" else "B") + signature[1:]
    core = configured_core(ledger)
    with pytest.raises(CoreAdmissionDenied, match="permit_invalid_signature"):
        admit(core, bad)
    assert ledger.latest_cursor() == 0

    def expired_clock() -> datetime:
        return NOW + timedelta(seconds=31)

    expired_core = configured_core(
        ledger, source_proof=proof(expires_at=NOW + timedelta(seconds=90)), clock=expired_clock
    )
    with pytest.raises(CoreAdmissionDenied, match="permit_expired"):
        admit(expired_core, golden_fixture())
    assert ledger.latest_cursor() == 0

    expired_environment = build_paper_environment_proof_v1(
        observed_at=NOW - timedelta(seconds=3),
        expires_at=NOW - timedelta(seconds=1),
        mode=PAPER_EXCHANGE,
        run_id=RUN_ID,
        config_digest="b" * 64,
        schema_hash=SCHEMA_HASH,
        endpoint_class="okx_demo",
        credential_class="demo_only",
        execution_client_registered=True,
        now=NOW - timedelta(seconds=2),
    )
    expired_environment_core = configured_core(ledger, source_proof=expired_environment)
    with pytest.raises(CoreAdmissionDenied, match="environment_unavailable"):
        admit(expired_environment_core, golden_fixture())
    assert ledger.latest_cursor() == 0


@pytest.mark.parametrize("source_proof, expected", [
    (lambda: proof(schema_hash="c" * 64), "environment_schema_hash_mismatch"),
    (lambda: proof(run_id="other-run"), "environment_run_id_mismatch"),
])
def test_environment_schema_and_run_must_match_core_config(ledger: Ledger, source_proof, expected: str) -> None:
    core = configured_core(ledger, source_proof=source_proof())
    with pytest.raises(CoreAdmissionDenied, match=expected):
        admit(core, golden_fixture())
    assert ledger.latest_cursor() == 0


def test_core_revalidates_an_untrusted_environment_provider(ledger: Ledger) -> None:
    forged = proof().to_dict()
    forged.update({
        "mode": "LIVE",
        "paperOnly": False,
        "liveTradingAllowed": True,
        "liveExecutionArmed": True,
    })

    class ForgedProvider:
        def get_proof(self, **_kwargs):
            return forged

    core = PaperSidecarCore(
        ledger,
        environment_provider=ForgedProvider(),  # type: ignore[arg-type]
        resolve_public_key=lambda key_id: PUBLIC_KEY_DER if key_id == "rfc8032-test-1" else None,
        expected_schema_hash=SCHEMA_HASH,
        run_id=RUN_ID,
        expected_key_ids=("rfc8032-test-1",),
        clock=lambda: NOW,
    )
    core.bind_writer_lease(ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=120
    ))
    status = core.health()
    assert status.status == "unavailable"
    assert status.reason == "environment_unavailable"
    with pytest.raises(CoreAdmissionDenied, match="environment_unavailable"):
        admit(core, golden_fixture())
    assert ledger.latest_cursor() == 0


def test_health_requires_an_expected_resolvable_ed25519_key(ledger: Ledger) -> None:
    core = PaperSidecarCore(
        ledger,
        environment_provider=StaticEnvironmentProvider(proof(), clock=lambda: NOW),
        resolve_public_key=lambda _key_id: None,
        expected_schema_hash=SCHEMA_HASH,
        run_id=RUN_ID,
        expected_key_ids=("rfc8032-test-1",),
        clock=lambda: NOW,
    )
    core.bind_writer_lease(ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=120
    ))
    status = core.health()
    assert status.status == "unavailable"
    assert status.reason == "signing_key_unavailable"
    with pytest.raises(CoreAdmissionDenied, match="permit_unknown_key_id"):
        admit(core, golden_fixture())
    assert ledger.latest_cursor() == 0


def test_validly_shaped_permit_from_an_untrusted_key_id_is_rejected_before_resolution(
    ledger: Ledger,
) -> None:
    item = golden_fixture()
    item["permit"]["keyId"] = "untrusted-test-key"
    permit_core = {
        key: value
        for key, value in item["permit"].items()
        if key not in {"permitId", "signature"}
    }
    item["permit"]["permitId"] = sha256_canonical(permit_core)
    resolved: list[str] = []
    core = PaperSidecarCore(
        ledger,
        environment_provider=StaticEnvironmentProvider(proof(), clock=lambda: NOW),
        resolve_public_key=lambda key_id: resolved.append(key_id) or PUBLIC_KEY_DER,
        expected_schema_hash=SCHEMA_HASH,
        run_id=RUN_ID,
        expected_key_ids=("rfc8032-test-1",),
        clock=lambda: NOW,
    )
    core.bind_writer_lease(ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=120
    ))

    with pytest.raises(CoreAdmissionDenied, match="untrusted_signing_key_id"):
        admit(core, item)

    assert resolved == []
    assert ledger.latest_cursor() == 0


def test_valid_admission_is_durable_only_and_exact_duplicate_has_no_event(ledger: Ledger) -> None:
    item = golden_fixture()
    core = configured_core(ledger)
    first = admit(core, item)
    assert first.disposition == "accepted_durable_not_submitted"
    assert first.execution_client_invoked is False
    assert first.broker_submission_enabled is False
    assert first.receipt.command.command_hash == item["command"]["commandId"]
    assert core.get_command(item["command"]["commandId"]) == first.receipt.command
    cursor = ledger.latest_cursor()

    duplicate = admit(core, item)
    assert duplicate.disposition == "duplicate_durable_not_submitted"
    assert duplicate.receipt.created is False
    assert duplicate.receipt.command == first.receipt.command
    assert duplicate.receipt.accepted_event == first.receipt.accepted_event
    assert (
        duplicate.receipt.accepted_lifecycle_event
        == first.receipt.accepted_lifecycle_event
    )
    assert ledger.latest_cursor() == cursor


def test_core_status_and_reads_use_only_dedicated_lifecycle_state(ledger: Ledger) -> None:
    item = golden_fixture()
    core = configured_core(ledger)
    accepted = admit(core, item)
    ledger.append_event(
        "generic_only",
        {"notLifecycle": True},
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp() + 1,
    )
    ledger.upsert_snapshot(
        account_id="paper-main",
        symbol="BTC/USDT",
        snapshot={"legacy": True},
        as_of_cursor=ledger.latest_cursor(),
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp() + 2,
    )
    lifecycle = ledger.upsert_lifecycle_snapshot(
        account_id="paper-main",
        symbol="BTC/USDT",
        snapshot={"diagnostic": "only"},
        as_of_sequence=accepted.receipt.command.accepted_sequence,
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp() + 3,
    )

    assert core.health().latest_sequence == 1
    assert core.get_snapshot(account_id="paper-main", symbol="BTC/USDT") == lifecycle
    assert [event.kind for event in core.replay_lifecycle_events()] == ["acknowledged"]


def test_stale_bound_lease_is_rejected_by_ledger_fencing(ledger: Ledger) -> None:
    stale = ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=1
    )
    later = NOW + timedelta(seconds=2)
    core = configured_core(
        ledger,
        source_proof=proof(expires_at=NOW + timedelta(seconds=60)),
        clock=lambda: later,
        lease=stale,
    )
    ledger._test_fencing_clock[0] = later.timestamp()  # type: ignore[attr-defined]
    ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-b", ttl_seconds=60
    )
    status = core.health(now=later)
    assert status.status == "unavailable"
    assert status.reason == "stale_writer_lease"
    assert status.environment_proof_hash == proof().proofHash
    assert status.writer_epoch == 0
    with pytest.raises(CoreAdmissionDenied, match="stale_writer_lease"):
        admit(core, golden_fixture(), now=later)
    assert ledger.latest_cursor() == 0


def test_admit_resamples_fencing_clock_after_validation(ledger: Ledger) -> None:
    lease = ledger.acquire_writer_lease(
        name="paper-core", owner_id="core-a", ttl_seconds=1
    )
    after_expiry = NOW + timedelta(seconds=2)
    core = configured_core(
        ledger,
        clock=lambda: NOW,
        lease=lease,
    )
    ledger._test_fencing_clock[0] = after_expiry.timestamp()  # type: ignore[attr-defined]

    with pytest.raises(CoreAdmissionDenied, match="stale_writer_lease"):
        admit(core, golden_fixture(), now=NOW)
    assert ledger.latest_cursor() == 0


def test_suspension_keeps_read_only_apis_available(ledger: Ledger) -> None:
    item = golden_fixture()
    core = configured_core(ledger)
    accepted = admit(core, item)
    suspend_event = ledger.suspend(
        "operator_stop",
        writer_lease=core._writer_lease,  # type: ignore[arg-type]
        now=NOW.timestamp() + 1,
    )
    status = core.health()
    assert status.status == "suspended/read_only"
    assert status.reason == "suspended"
    assert status.writer_epoch == 1
    assert status.execution_client_invoked is False
    assert status.broker_submission_enabled is False
    assert core.get_command(item["command"]["commandId"]) == accepted.receipt.command
    assert core.get_snapshot(account_id="paper-main", symbol="BTC/USDT") is None
    assert core.replay(after_cursor=0)[-1] == suspend_event
    duplicate = admit(core, item)
    assert duplicate.disposition == "duplicate_durable_not_submitted"
