"""Recovery state-machine tests for :mod:`offline_execution` only."""

from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_private_key

from sidecars.nautilus_paper.contract import (
    build_execution_command_v1,
    execution_permit_v2_signing_payload,
    sha256_canonical,
)
from sidecars.nautilus_paper.ledger import Ledger
from sidecars.nautilus_paper.offline_execution import OfflineExecutionCoordinator
from sidecars.nautilus_paper.offline_receipt import ed25519_public_key_fingerprint_sha256
from sidecars.nautilus_paper.offline_simulator import OfflineSimulatorStore


def epoch(value: str) -> float:
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
        tzinfo=timezone.utc
    ).timestamp()


T0 = epoch("2026-08-15T00:00:01.000Z")
RECEIPT_PRIVATE_KEY = load_der_private_key(
    bytes.fromhex("302e020100300506032b657004220420" "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
    password=None,
)
RECEIPT_PUBLIC_KEY = RECEIPT_PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
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


class MutableClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class CountingSimulator:
    def __init__(self, inner: OfflineSimulatorStore) -> None:
        self.inner = inner
        self.lookup_calls = 0
        self.ensure_calls = 0

    def lookup_exact(self, request):
        self.lookup_calls += 1
        return self.inner.lookup_exact(request)

    def ensure_exact(self, request, *, canonical_capability_json_utf8: bytes):
        self.ensure_calls += 1
        return self.inner.ensure_exact(
            request, canonical_capability_json_utf8=canonical_capability_json_utf8
        )


def fixture_contract() -> dict:
    path = Path(__file__).resolve().parents[2] / "src/sidecar/fixtures/openalice_execution_contract_v1.json"
    return json.loads(path.read_text(encoding="utf-8"))


def offline_policy() -> dict[str, object]:
    return {
        "schemaVersion": "openalice_offline_adapter_policy.v3",
        "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only", "mode": "PAPER_LOCAL",
        "adapterId": "openalice.offline-simulator", "adapterBuildHash": "a" * 64,
        "adapterConfigHash": "b" * 64, "adapterRunId": "offline-run-1",
        "sourceNamespaceId": "c" * 64, "adapterKeyId": "offline-adapter-key",
        "adapterPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(RECEIPT_PUBLIC_KEY),
        "permitAuthorityKeyId": "rfc8032-test-1",
        "permitAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(PERMIT_PUBLIC_KEY),
        "simulatorCapabilityAuthorityKeyId": "offline-capability-authority",
        "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(CAPABILITY_PUBLIC_KEY),
        "simulatorStoreId": SIMULATOR_STORE_ID, "sourceAttestationKeyId": SOURCE_KEY_ID,
        "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(SOURCE_PUBLIC_KEY),
        "capability": "offline_simulator.ensure_exact.v2", "ensureExact": True,
        "finalizationEligible": False,
    }


@pytest.fixture
def environment(tmp_path: Path):
    clock = MutableClock(T0)
    ledger = Ledger(
        tmp_path / "ledger.sqlite3", fencing_clock=clock,
        offline_capability_authority_private_key=CAPABILITY_PRIVATE_KEY,
        offline_capability_authority_key_id="offline-capability-authority",
        offline_receipt_signing_private_key=RECEIPT_PRIVATE_KEY,
        offline_receipt_signing_key_id="offline-adapter-key",
        offline_source_attestation_public_keys={SOURCE_KEY_ID: SOURCE_PUBLIC_KEY},
    )
    simulator = OfflineSimulatorStore(
        tmp_path / "simulator.sqlite3", store_id=SIMULATOR_STORE_ID,
        capability_public_keys={"offline-capability-authority": CAPABILITY_PUBLIC_KEY},
        source_attestation_key_id=SOURCE_KEY_ID,
        source_attestation_private_key=SOURCE_PRIVATE_KEY,
        capability_clock=lambda: datetime.fromtimestamp(clock.value, timezone.utc),
        allow_provision=True,
    )
    try:
        yield ledger, CountingSimulator(simulator), clock
    finally:
        simulator.close()
        ledger.close()


def lease(ledger: Ledger, clock: MutableClock, *, owner: str = "owner-a", ttl: float = 120.0):
    return ledger.acquire_writer_lease(
        name="paper-writer", owner_id=owner, ttl_seconds=ttl
    )


def admit(ledger: Ledger, writer) -> str:
    registered = ledger.register_offline_adapter_policy(
        policy=offline_policy(), writer_lease=writer, now=T0
    )
    fixture = fixture_contract()
    payload = {**fixture["command"]["payload"], "mode": "PAPER_LOCAL"}
    command = build_execution_command_v1(payload)
    permit = {**fixture["permit"], "commandHash": command["commandId"], "mode": "PAPER_LOCAL"}
    permit["permitId"] = sha256_canonical(
        {key: value for key, value in permit.items() if key not in {"permitId", "signature"}}
    )
    permit["signature"] = base64.b64encode(
        PERMIT_PRIVATE_KEY.sign(execution_permit_v2_signing_payload(permit).encode("utf-8"))
    ).decode("ascii")
    receipt = ledger.admit_execution_command(
        command=command, permit=permit, writer_lease=writer, now=T0,
        offline_adapter_policy_hash=registered.policy_hash,
        permit_public_key=PERMIT_PUBLIC_KEY,
    )
    return receipt.command.command_hash


def coordinator(ledger, simulator, writer):
    return OfflineExecutionCoordinator(
        ledger, simulator, writer_lease=writer,
        permit_public_key=PERMIT_PUBLIC_KEY, receipt_public_key=RECEIPT_PUBLIC_KEY,
    )


def take_over(ledger: Ledger, clock: MutableClock):
    clock.value = T0 + 2
    return lease(ledger, clock, owner="owner-b")


def commit_source_once(ledger, simulator, writer, command_hash: str):
    attempt = ledger.claim_offline_dispatch(
        command_hash=command_hash, writer_lease=writer, permit_public_key=PERMIT_PUBLIC_KEY
    )
    capability = ledger.issue_offline_simulator_capability(
        command_hash=command_hash, writer_lease=writer
    )
    result = simulator.ensure_exact(
        attempt.request, canonical_capability_json_utf8=capability.capability_json.encode("utf-8")
    )
    return attempt, result


def test_pending_commits_one_effect_and_repeat_returns_same_receipt(environment) -> None:
    ledger, simulator, clock = environment
    writer = lease(ledger, clock)
    command_hash = admit(ledger, writer)
    first = coordinator(ledger, simulator, writer).execute_or_recover(command_hash)
    second = coordinator(ledger, simulator, writer).execute_or_recover(command_hash)
    assert first.state == second.state == "RECEIPT_COMMITTED"
    assert first.receipt is not None and second.receipt is not None
    assert first.receipt.receipt_id == second.receipt.receipt_id
    assert (first.source_created, first.recovered) == (True, False)
    assert simulator.inner.counts()["events"] == 1
    assert simulator.ensure_calls == 1


def test_in_flight_looks_up_before_original_capability_or_ensure(environment) -> None:
    ledger, simulator, clock = environment
    writer = lease(ledger, clock)
    command_hash = admit(ledger, writer)
    attempt, result = commit_source_once(ledger, simulator, writer, command_hash)
    outcome = coordinator(ledger, simulator, writer).execute_or_recover(command_hash)
    assert outcome.receipt is not None and outcome.recovered
    assert simulator.lookup_calls == 1 and simulator.ensure_calls == 1
    assert result.created and ledger.get_execution_dispatch(
        command_hash, receipt_public_key=RECEIPT_PUBLIC_KEY
    ).state == "RECEIPT_COMMITTED"
    assert attempt.adapter_epoch == str(writer.epoch)


def test_new_epoch_missing_source_marks_reconciliation_without_issue_or_ensure(environment, monkeypatch) -> None:
    ledger, simulator, clock = environment
    first = lease(ledger, clock, ttl=1.0)
    command_hash = admit(ledger, first)
    ledger.claim_offline_dispatch(command_hash=command_hash, writer_lease=first, permit_public_key=PERMIT_PUBLIC_KEY)
    current = take_over(ledger, clock)
    issued = 0
    original = ledger.issue_offline_simulator_capability

    def issue(*args, **kwargs):
        nonlocal issued
        issued += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(ledger, "issue_offline_simulator_capability", issue)
    outcome = coordinator(ledger, simulator, current).execute_or_recover(command_hash)
    assert outcome.state == "RECONCILIATION_REQUIRED"
    assert (issued, simulator.ensure_calls) == (0, 0)
    assert ledger.get_execution_dispatch(command_hash).state == "RECONCILIATION_REQUIRED"


def test_new_epoch_found_source_claims_current_reconciliation_and_commits(environment) -> None:
    ledger, simulator, clock = environment
    first = lease(ledger, clock, ttl=1.0)
    command_hash = admit(ledger, first)
    _, result = commit_source_once(ledger, simulator, first, command_hash)
    current = take_over(ledger, clock)
    outcome = coordinator(ledger, simulator, current).execute_or_recover(command_hash)
    assert outcome.receipt is not None and outcome.recovered
    dispatch = ledger.get_execution_dispatch(command_hash, receipt_public_key=RECEIPT_PUBLIC_KEY)
    assert dispatch.state == "RECEIPT_COMMITTED"
    assert outcome.receipt.reconciliation_claim_id is not None
    assert result.created and simulator.inner.counts()["events"] == 1


def test_reconciliation_missing_does_not_claim_issue_or_ensure(environment, monkeypatch) -> None:
    ledger, simulator, clock = environment
    first = lease(ledger, clock, ttl=1.0)
    command_hash = admit(ledger, first)
    ledger.claim_offline_dispatch(command_hash=command_hash, writer_lease=first, permit_public_key=PERMIT_PUBLIC_KEY)
    current = take_over(ledger, clock)
    ledger.mark_reconciliation_required(command_hash=command_hash, writer_lease=current)
    calls = 0
    original = ledger.claim_offline_reconciliation

    def claim(*args, **kwargs):
        nonlocal calls
        calls += 1
        return original(*args, **kwargs)

    monkeypatch.setattr(ledger, "claim_offline_reconciliation", claim)
    outcome = coordinator(ledger, simulator, current).execute_or_recover(command_hash)
    assert outcome.state == "RECONCILIATION_REQUIRED"
    assert (calls, simulator.ensure_calls) == (0, 0)


def test_committed_recovery_never_accesses_simulator(environment) -> None:
    ledger, simulator, clock = environment
    writer = lease(ledger, clock)
    command_hash = admit(ledger, writer)
    first = coordinator(ledger, simulator, writer).execute_or_recover(command_hash)
    before = (simulator.lookup_calls, simulator.ensure_calls)
    recovered = coordinator(ledger, simulator, writer).execute_or_recover(command_hash)
    assert recovered.receipt == first.receipt
    assert (simulator.lookup_calls, simulator.ensure_calls) == before


def test_thread_affinity_rejects_execute_and_rebind(environment) -> None:
    ledger, simulator, clock = environment
    writer = lease(ledger, clock)
    command_hash = admit(ledger, writer)
    instance = coordinator(ledger, simulator, writer)
    with ThreadPoolExecutor(max_workers=1) as pool:
        execute_error = pool.submit(instance.execute_or_recover, command_hash).exception()
        bind_error = pool.submit(instance.bind_writer_lease, writer).exception()
    assert isinstance(execute_error, RuntimeError)
    assert isinstance(bind_error, RuntimeError)
    assert simulator.ensure_calls == 0


@pytest.mark.parametrize("cut", ("claim", "capability", "effect", "commit"))
def test_crash_cut_points_recover_from_durable_state(environment, monkeypatch, cut: str) -> None:
    ledger, simulator, clock = environment
    first = lease(ledger, clock, ttl=1.0)
    command_hash = admit(ledger, first)

    class Crash(RuntimeError):
        pass

    if cut == "claim":
        original = ledger.claim_offline_dispatch
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(ledger, "claim_offline_dispatch", crash)
    elif cut == "capability":
        original = ledger.issue_offline_simulator_capability
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(ledger, "issue_offline_simulator_capability", crash)
    elif cut == "effect":
        original = simulator.ensure_exact
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(simulator, "ensure_exact", crash)
    else:
        original = ledger.commit_offline_execution_receipt
        def crash(*args, **kwargs):
            original(*args, **kwargs)
            raise Crash()
        monkeypatch.setattr(ledger, "commit_offline_execution_receipt", crash)

    with pytest.raises(Crash):
        coordinator(ledger, simulator, first).execute_or_recover(command_hash)
    monkeypatch.undo()
    current = take_over(ledger, clock)
    outcome = coordinator(ledger, simulator, current).execute_or_recover(command_hash)
    if cut in {"claim", "capability"}:
        assert outcome.state == "RECONCILIATION_REQUIRED"
        assert simulator.inner.counts()["events"] == 0
    else:
        assert outcome.state == "RECEIPT_COMMITTED"
        assert outcome.receipt is not None
        assert simulator.inner.counts()["events"] == 1
