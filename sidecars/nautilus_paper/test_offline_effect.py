"""Tests for the isolated signed offline simulator source-effect proof."""

from __future__ import annotations

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat, load_der_private_key
import pytest

from sidecars.nautilus_paper.contract import ContractValidationError, sha256_canonical, stable_stringify
from sidecars.nautilus_paper.offline_effect import (
    MAX_OFFLINE_SIMULATOR_EFFECT_JSON_BYTES,
    OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN,
    OFFLINE_SIMULATOR_EFFECT_SCOPE,
    OFFLINE_SIMULATOR_EFFECT_V1,
    OfflineSimulatorEffectTrustPolicy,
    create_offline_simulator_effect_v1,
    offline_simulator_effect_v1_id,
    offline_simulator_effect_v1_matches,
    offline_simulator_effect_v1_signing_payload,
    offline_simulator_store_chain_v1_hash,
    parse_offline_simulator_effect_json_utf8,
    validate_offline_simulator_effect_v1,
    verify_offline_simulator_effect_v1,
)
from sidecars.nautilus_paper.offline_receipt import (
    OFFLINE_SIMULATOR_CAPABILITY,
    OFFLINE_SIMULATOR_CAPABILITY_SCOPE,
    OFFLINE_SIMULATOR_CAPABILITY_V1,
    OFFLINE_SIMULATOR_REQUEST_V1,
    OFFLINE_SIMULATOR_RESPONSE_V1,
    create_offline_simulator_capability_v1,
    derive_offline_execution_attempt_id,
)


PRIVATE_KEY = load_der_private_key(
    bytes.fromhex("302e020100300506032b657004220420" "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"),
    password=None,
)
PUBLIC_KEY_DER = PRIVATE_KEY.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
COMMAND_ID = "a" * 64
SOURCE_NAMESPACE_ID = "e" * 64
ATTEMPT_ID = derive_offline_execution_attempt_id(
    command_id=COMMAND_ID,
    adapter_id="openalice.offline-simulator",
    adapter_run_id="offline-run-1",
    adapter_epoch="1",
    attempt_number="1",
)
REQUEST = {
    "schemaVersion": OFFLINE_SIMULATOR_REQUEST_V1, "sourceNamespaceId": SOURCE_NAMESPACE_ID,
    "commandId": COMMAND_ID, "payloadHash": COMMAND_ID, "permitV2Id": "b" * 64,
    "permitKeyId": "permit-test-key", "acceptedSequence": "1", "idempotencyKey": "offline-effect-1",
    "accountId": "paper-main", "canonicalSymbol": "BTC/USDT", "venue": "OKX",
    "venueInstrumentId": "BTC-USDT", "mode": "PAPER_LOCAL", "clientOrderId": "OA1234567890ABCDEF",
    "side": "buy", "orderType": "limit", "timeInForce": "GTC", "reduceOnly": False,
    "quantity": "0.001", "price": "100000", "maxNotionalUsd": "100",
    "adapterId": "openalice.offline-simulator", "adapterRunId": "offline-run-1", "adapterEpoch": "1",
    "attemptId": ATTEMPT_ID, "attemptNumber": "1", "permitIssuedAt": "2026-08-15T00:59:00.000Z",
    "permitExpiresAt": "2026-08-15T01:00:30.000Z", "dispatchArmedAt": "2026-08-15T00:59:59.000Z",
}
RESPONSE = {
    "schemaVersion": OFFLINE_SIMULATOR_RESPONSE_V1, "sourceNamespaceId": SOURCE_NAMESPACE_ID,
    "sourceSequence": "1", "commandId": COMMAND_ID, "attemptId": ATTEMPT_ID,
    "requestHash": sha256_canonical(REQUEST), "clientOrderId": REQUEST["clientOrderId"],
    "state": "submitted", "simulatorOccurredAt": "2026-08-15T01:00:00.000Z",
    "simulatedOrderId": "SIM0123456789ABCDEF",
}


def core(**changes):
    value = {
        "schemaVersion": OFFLINE_SIMULATOR_EFFECT_V1, "scope": OFFLINE_SIMULATOR_EFFECT_SCOPE,
        "storeId": "0" * 64, "storeSequence": "1", "previousStoreChainHash": "0" * 64,
        "storeChainHash": "0" * 64, "policyHash": "1" * 64, "capabilityId": "2" * 64,
        "sourceAttestationKeyId": "offline-source-key", "commandId": COMMAND_ID, "attemptId": ATTEMPT_ID,
        "attemptAdapterEpoch": "1", "sourceNamespaceId": SOURCE_NAMESPACE_ID, "sourceSequence": "1",
        "clientOrderId": REQUEST["clientOrderId"], "requestHash": sha256_canonical(REQUEST),
        "responseHash": sha256_canonical(RESPONSE), "simulatedOrderId": RESPONSE["simulatedOrderId"],
        "simulatorOccurredAt": RESPONSE["simulatorOccurredAt"], "authorityKind": "original_dispatch",
        "writerName": "offline-simulator-store", "writerOwnerId": "paper-sidecar", "writerEpoch": "1",
    }
    value.update(changes)
    value["storeChainHash"] = offline_simulator_store_chain_v1_hash(value)
    return value


def effect(**changes):
    return create_offline_simulator_effect_v1(core=core(**changes), private_key=PRIVATE_KEY)


def capability_core(**changes):
    value = {
        "schemaVersion": OFFLINE_SIMULATOR_CAPABILITY_V1,
        "scope": OFFLINE_SIMULATOR_CAPABILITY_SCOPE,
        "capability": OFFLINE_SIMULATOR_CAPABILITY,
        "authorityKind": "original_dispatch",
        "authorityKeyId": "offline-capability-key",
        "policyHash": "1" * 64,
        "simulatorStoreId": "0" * 64,
        "sourceAttestationKeyId": "offline-source-key",
        "commandId": COMMAND_ID,
        "attemptId": ATTEMPT_ID,
        "attemptAdapterEpoch": "1",
        "sourceNamespaceId": SOURCE_NAMESPACE_ID,
        "clientOrderId": REQUEST["clientOrderId"],
        "requestHash": sha256_canonical(REQUEST),
        "writerName": "offline-simulator-store",
        "writerOwnerId": "paper-sidecar",
        "writerEpoch": "1",
        "issuedAt": "2026-08-15T01:00:00.000Z",
        "expiresAt": "2026-08-15T01:01:00.000Z",
    }
    value.update(changes)
    return value


def capability(**changes):
    return create_offline_simulator_capability_v1(
        core=capability_core(**changes), private_key=PRIVATE_KEY
    )


def bound_effect(
    *, request=REQUEST, response=RESPONSE, simulator_capability=None, **changes
):
    simulator_capability = capability() if simulator_capability is None else simulator_capability
    bindings = {
        "storeId": simulator_capability["simulatorStoreId"],
        "policyHash": simulator_capability["policyHash"],
        "capabilityId": simulator_capability["capabilityId"],
        "sourceAttestationKeyId": simulator_capability["sourceAttestationKeyId"],
        "commandId": request["commandId"],
        "attemptId": request["attemptId"],
        "attemptAdapterEpoch": request["adapterEpoch"],
        "sourceNamespaceId": request["sourceNamespaceId"],
        "sourceSequence": response["sourceSequence"],
        "clientOrderId": request["clientOrderId"],
        "requestHash": sha256_canonical(request),
        "responseHash": sha256_canonical(response),
        "simulatedOrderId": response["simulatedOrderId"],
        "simulatorOccurredAt": response["simulatorOccurredAt"],
        "authorityKind": "original_dispatch",
        "writerName": simulator_capability["writerName"],
        "writerOwnerId": simulator_capability["writerOwnerId"],
        "writerEpoch": simulator_capability["writerEpoch"],
    }
    bindings.update(changes)
    return effect(**bindings)


def policy(value, **changes):
    values = {"key_id": value["sourceAttestationKeyId"], "store_id": value["storeId"], "public_key": PUBLIC_KEY_DER}
    values.update(changes)
    return OfflineSimulatorEffectTrustPolicy(**values)


def test_effect_is_deterministic_domain_separated_and_contains_no_private_key():
    value = effect()
    assert value == effect()
    assert value["effectId"] == offline_simulator_effect_v1_id(core())
    assert offline_simulator_effect_v1_signing_payload(value).startswith(OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN + "\0")
    assert "private" not in stable_stringify(value).lower()


def test_canonical_bytes_round_trip_and_rejects_noncanonical_or_oversized():
    value = effect()
    raw = stable_stringify(value).encode()
    assert parse_offline_simulator_effect_json_utf8(raw) == value
    with pytest.raises(ContractValidationError):
        parse_offline_simulator_effect_json_utf8(b" " + raw)
    with pytest.raises(ContractValidationError):
        parse_offline_simulator_effect_json_utf8(b" " * (MAX_OFFLINE_SIMULATOR_EFFECT_JSON_BYTES + 1))


@pytest.mark.parametrize("field,value", [
    ("storeId", "g" * 64), ("policyHash", "3" * 63), ("storeSequence", "01"),
    ("sourceSequence", "0"), ("attemptAdapterEpoch", str(1 << 64)),
    ("simulatorOccurredAt", "2026-08-15T01:00:00Z"), ("writerEpoch", 1),
])
def test_core_field_validation_fails_closed(field, value):
    with pytest.raises(ContractValidationError):
        effect(**{field: value})


def test_unknown_fields_and_effect_identity_or_signature_tamper_are_rejected():
    value = effect()
    with pytest.raises(ContractValidationError):
        validate_offline_simulator_effect_v1({**value, "unknown": True})
    with pytest.raises(ContractValidationError):
        validate_offline_simulator_effect_v1({**value, "effectId": "0" * 64})
    altered = {
        **value,
        "signature": ("A" if value["signature"][0] != "A" else "B")
        + value["signature"][1:],
    }
    result = verify_offline_simulator_effect_v1(effect=altered, trust_policy=policy(value))
    assert not result.valid and result.reason == "signature_invalid"


def test_pinned_key_and_store_tamper_are_not_trusted():
    value = effect()
    assert verify_offline_simulator_effect_v1(effect=value, trust_policy=policy(value)).valid
    assert verify_offline_simulator_effect_v1(effect=value, trust_policy=policy(value, key_id="wrong")).reason == "untrusted_source_attestation_key"
    assert verify_offline_simulator_effect_v1(effect=value, trust_policy=policy(value, store_id="f" * 64)).reason == "untrusted_store"
    wrong_key = Ed25519PrivateKey.generate().public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    assert verify_offline_simulator_effect_v1(effect=value, trust_policy=policy(value, public_key=wrong_key)).reason == "signature_invalid"


def test_store_chain_rules_and_hash_coverage_are_strict():
    first = core()
    assert first["previousStoreChainHash"] == "0" * 64
    second = core(storeSequence="2", previousStoreChainHash=first["storeChainHash"])
    assert second["storeChainHash"] != first["storeChainHash"]
    with pytest.raises(ContractValidationError):
        effect(storeSequence="2")
    with pytest.raises(ContractValidationError):
        effect(previousStoreChainHash="3" * 64)
    changed = core(storeSequence="2", previousStoreChainHash=first["storeChainHash"])
    changed["responseHash"] = "4" * 64
    with pytest.raises(ContractValidationError):
        create_offline_simulator_effect_v1(core=changed, private_key=PRIVATE_KEY)


def test_matcher_accepts_only_the_exact_effect_request_response_capability_binding():
    simulator_capability = capability()
    value = bound_effect(simulator_capability=simulator_capability)
    assert offline_simulator_effect_v1_matches(value, REQUEST, RESPONSE, simulator_capability)


@pytest.mark.parametrize("field,value", [
    ("storeId", "f" * 64), ("policyHash", "f" * 64),
    ("sourceAttestationKeyId", "other-source-key"), ("capabilityId", "f" * 64),
    ("commandId", "f" * 64), ("attemptId", "f" * 64),
    ("attemptAdapterEpoch", "2"), ("sourceNamespaceId", "f" * 64),
    ("sourceSequence", "2"), ("clientOrderId", "OA9999999999999999"),
    ("requestHash", "f" * 64), ("responseHash", "f" * 64),
    ("simulatedOrderId", "SIM9999999999999999"),
    ("simulatorOccurredAt", "2026-08-15T01:00:01.000Z"),
    ("writerName", "other-writer"), ("writerOwnerId", "other-owner"),
    ("writerEpoch", "2"),
])
def test_matcher_rejects_each_single_effect_binding_field_tamper(field, value):
    simulator_capability = capability()
    altered = bound_effect(simulator_capability=simulator_capability, **{field: value})
    assert not offline_simulator_effect_v1_matches(altered, REQUEST, RESPONSE, simulator_capability)


def test_matcher_rejects_a_single_request_response_or_capability_binding_tamper():
    simulator_capability = capability()
    value = bound_effect(simulator_capability=simulator_capability)
    assert not offline_simulator_effect_v1_matches(
        value, {**REQUEST, "quantity": "0.002"}, RESPONSE, simulator_capability
    )
    assert not offline_simulator_effect_v1_matches(
        value, REQUEST, {**RESPONSE, "simulatedOrderId": "SIM9999999999999999"}, simulator_capability
    )
    assert not offline_simulator_effect_v1_matches(
        value, REQUEST, RESPONSE, capability(policyHash="f" * 64)
    )
