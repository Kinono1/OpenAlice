"""Tests for the signed simulator-only Python receipt mirror."""

from __future__ import annotations

import base64
from datetime import datetime, timezone
import json

from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_private_key,
)
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
import pytest

from sidecars.nautilus_paper.contract import (
    ContractValidationError,
    sha256_canonical,
    stable_stringify,
)
from sidecars.nautilus_paper.offline_receipt import (
    MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES,
    MAX_OFFLINE_SIMULATOR_CAPABILITY_JSON_BYTES,
    OFFLINE_EXECUTION_RECEIPT_SCOPE,
    OFFLINE_EXECUTION_RECEIPT_V1,
    OFFLINE_SIMULATOR_CAPABILITY,
    OFFLINE_SIMULATOR_CAPABILITY_SCOPE,
    OFFLINE_SIMULATOR_CAPABILITY_V1,
    OFFLINE_SIMULATOR_REQUEST_V1,
    OFFLINE_SIMULATOR_RESPONSE_V1,
    OfflineReceiptTrustPolicy,
    build_execution_event_v2_from_offline_receipt,
    create_offline_execution_receipt_v1,
    create_offline_simulator_capability_v1,
    derive_offline_execution_attempt_id,
    ed25519_public_key_fingerprint_sha256,
    execution_event_v2_matches_offline_receipt,
    parse_offline_execution_receipt_json_utf8,
    parse_offline_simulator_capability_json_utf8,
    offline_simulator_capability_v1_id,
    offline_simulator_capability_v1_signing_payload,
    validate_offline_simulator_request_v1,
    validate_offline_simulator_response_v1,
    verify_offline_execution_receipt_v1,
    verify_offline_simulator_capability_v1,
)


PRIVATE_KEY = load_der_private_key(
    bytes.fromhex(
        "302e020100300506032b657004220420"
        "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    ),
    password=None,
)
PUBLIC_KEY_DER = PRIVATE_KEY.public_key().public_bytes(
    Encoding.DER, PublicFormat.SubjectPublicKeyInfo
)
NOW = datetime(2026, 8, 15, 1, 0, 2, tzinfo=timezone.utc)
COMMAND_ID = "a" * 64
SOURCE_NAMESPACE_ID = "e" * 64
ADAPTER_ID = "openalice.offline-simulator"
ADAPTER_RUN_ID = "offline-run-1"
ATTEMPT_ID = derive_offline_execution_attempt_id(
    command_id=COMMAND_ID,
    adapter_id=ADAPTER_ID,
    adapter_run_id=ADAPTER_RUN_ID,
    adapter_epoch="1",
    attempt_number="1",
)
REQUEST = {
    "schemaVersion": OFFLINE_SIMULATOR_REQUEST_V1,
    "sourceNamespaceId": SOURCE_NAMESPACE_ID,
    "commandId": COMMAND_ID,
    "payloadHash": COMMAND_ID,
    "permitV2Id": "b" * 64,
    "permitKeyId": "permit-test-key",
    "acceptedSequence": "1",
    "idempotencyKey": "offline-receipt-1",
    "accountId": "paper-main",
    "canonicalSymbol": "BTC/USDT",
    "venue": "OKX",
    "venueInstrumentId": "BTC-USDT",
    "mode": "PAPER_LOCAL",
    "clientOrderId": "OA1234567890ABCDEF",
    "side": "buy",
    "orderType": "limit",
    "timeInForce": "GTC",
    "reduceOnly": False,
    "quantity": "0.001",
    "price": "100000",
    "maxNotionalUsd": "100",
    "adapterId": ADAPTER_ID,
    "adapterRunId": ADAPTER_RUN_ID,
    "adapterEpoch": "1",
    "attemptId": ATTEMPT_ID,
    "attemptNumber": "1",
    "permitIssuedAt": "2026-08-15T00:59:00.000Z",
    "permitExpiresAt": "2026-08-15T01:00:30.000Z",
    "dispatchArmedAt": "2026-08-15T00:59:59.000Z",
}
REQUEST_HASH = sha256_canonical(REQUEST)
RESPONSE = {
    "schemaVersion": OFFLINE_SIMULATOR_RESPONSE_V1,
    "sourceNamespaceId": SOURCE_NAMESPACE_ID,
    "sourceSequence": "1",
    "commandId": COMMAND_ID,
    "attemptId": ATTEMPT_ID,
    "requestHash": REQUEST_HASH,
    "clientOrderId": REQUEST["clientOrderId"],
    "state": "submitted",
    "simulatorOccurredAt": "2026-08-15T01:00:00.000Z",
    "simulatedOrderId": "SIM0123456789ABCDEF",
}
REQUEST_BYTES = stable_stringify(REQUEST).encode()
RESPONSE_BYTES = stable_stringify(RESPONSE).encode()


def core(**changes):
    value = {
        "schemaVersion": OFFLINE_EXECUTION_RECEIPT_V1,
        "scope": OFFLINE_EXECUTION_RECEIPT_SCOPE,
        "commandId": COMMAND_ID,
        "payloadHash": COMMAND_ID,
        "permitV2Id": "b" * 64,
        "permitKeyId": "permit-test-key",
        "acceptedSequence": "1",
        "lifecycleSequence": "2",
        "lifecycleKind": "submitted",
        "idempotencyKey": "offline-receipt-1",
        "accountId": "paper-main",
        "canonicalSymbol": "BTC/USDT",
        "venue": "OKX",
        "venueInstrumentId": "BTC-USDT",
        "mode": "PAPER_LOCAL",
        "clientOrderId": REQUEST["clientOrderId"],
        "side": "buy",
        "orderType": "limit",
        "timeInForce": "GTC",
        "reduceOnly": False,
        "quantity": "0.001",
        "price": "100000",
        "maxNotionalUsd": "100",
        "adapterId": ADAPTER_ID,
        "adapterBuildHash": "c" * 64,
        "adapterConfigHash": "d" * 64,
        "adapterRunId": ADAPTER_RUN_ID,
        "adapterEpoch": "1",
        "adapterKeyId": "offline-simulator-test-key",
        "attemptId": ATTEMPT_ID,
        "attemptNumber": "1",
        "sourceNamespaceId": SOURCE_NAMESPACE_ID,
        "sourceSequence": "1",
        "transitionNumber": "1",
        "simulatedOrderId": RESPONSE["simulatedOrderId"],
        "requestHash": REQUEST_HASH,
        "responseHash": sha256_canonical(RESPONSE),
        "permitIssuedAt": REQUEST["permitIssuedAt"],
        "permitExpiresAt": REQUEST["permitExpiresAt"],
        "dispatchArmedAt": REQUEST["dispatchArmedAt"],
        "adapterObservedAt": "2026-08-15T01:00:01.000Z",
        "simulatorOccurredAt": RESPONSE["simulatorOccurredAt"],
    }
    value.update(changes)
    return value


def receipt(**changes):
    return create_offline_execution_receipt_v1(
        core=core(**changes), private_key=PRIVATE_KEY
    )


def expected(value):
    fields = (
        "commandId",
        "payloadHash",
        "permitV2Id",
        "permitKeyId",
        "acceptedSequence",
        "lifecycleSequence",
        "lifecycleKind",
        "adapterEpoch",
        "attemptId",
        "attemptNumber",
        "sourceNamespaceId",
        "sourceSequence",
        "transitionNumber",
        "idempotencyKey",
        "accountId",
        "canonicalSymbol",
        "venue",
        "venueInstrumentId",
        "mode",
        "clientOrderId",
        "side",
        "orderType",
        "timeInForce",
        "reduceOnly",
        "quantity",
        "price",
        "maxNotionalUsd",
    )
    result = {field: value[field] for field in fields}
    result["previousReceiptId"] = value.get("previousReceiptId")
    return result


def policy(value, **changes):
    values = {
        "key_id": value["adapterKeyId"],
        "adapter_id": value["adapterId"],
        "adapter_build_hash": value["adapterBuildHash"],
        "adapter_config_hash": value["adapterConfigHash"],
        "adapter_run_id": value["adapterRunId"],
        "permit_authority_key_ids": [value["permitKeyId"]],
        "permit_authority_public_key_fingerprints": ["f" * 64],
        "public_key": PUBLIC_KEY_DER,
    }
    values.update(changes)
    return OfflineReceiptTrustPolicy(**values)


def verify(value, **changes):
    return verify_offline_execution_receipt_v1(
        receipt=value,
        canonical_request_json_utf8=changes.get("request_bytes", REQUEST_BYTES),
        canonical_response_json_utf8=changes.get("response_bytes", RESPONSE_BYTES),
        trust_policy=changes.get("trust_policy", policy(value)),
        expected=changes.get("expected_binding", expected(value)),
        now=changes.get("now", NOW),
    )


def test_build_parse_verify_is_simulator_only_and_never_finalization_eligible():
    value = receipt()
    assert (
        parse_offline_execution_receipt_json_utf8(stable_stringify(value).encode())
        == value
    )
    result = verify(value)
    assert (
        result.valid,
        result.reason,
        result.finalization_eligible,
        result.receipt,
    ) == (True, "offline_simulator_only", False, value)
    event = build_execution_event_v2_from_offline_receipt(value)
    assert event["commandId"] == value["commandId"]
    assert event["sequence"] == value["lifecycleSequence"]
    assert event["kind"] == value["lifecycleKind"]
    assert event["evidenceReceiptId"] == value["receiptId"]
    assert execution_event_v2_matches_offline_receipt(value, event)
    wrong_core = {
        key: item for key, item in event.items() if key != "eventId"
    }
    wrong_core["sequence"] = "3"
    assert not execution_event_v2_matches_offline_receipt(
        value,
        {**wrong_core, "eventId": sha256_canonical(wrong_core)},
    )


def test_strict_request_response_schema_and_semantic_evidence_cross_binding():
    assert validate_offline_simulator_request_v1(REQUEST) == REQUEST
    assert validate_offline_simulator_response_v1(RESPONSE) == RESPONSE
    with pytest.raises(ContractValidationError):
        validate_offline_simulator_request_v1({**REQUEST, "unknown": True})
    with pytest.raises(ContractValidationError):
        validate_offline_simulator_response_v1({**RESPONSE, "state": "filled"})
    assert (
        verify(
            receipt(
                lifecycleKind="filled", filledQuantity="0.001", averagePrice="100000"
            )
        ).reason
        == "raw_evidence_mismatch"
    )


def test_noncanonical_duplicate_and_oversized_receipt_json_are_rejected():
    value = receipt()
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_execution_receipt_json_utf8(json.dumps(value, indent=2).encode())
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_execution_receipt_json_utf8(
            stable_stringify(value)
            .replace("{", '{"scope":"offline_simulator_only",', 1)
            .encode()
        )
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_execution_receipt_json_utf8(
            b" " * (MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES + 1)
        )


@pytest.mark.parametrize(
    "change",
    (
        {"scope": "broker_terminal"},
        {"mode": "PAPER_EXCHANGE"},
        {"lifecycleSequence": "1"},
        {"attemptNumber": "01"},
        {"attemptId": "0" * 64},
        {"sourceSequence": "0"},
        {"transitionNumber": "2"},
        {"previousReceiptId": "f" * 64},
        {"adapterObservedAt": "2026-08-15T01:00:01Z"},
        {"unknown": True},
    ),
)
def test_core_rejects_bad_provenance_transition_or_shape(change):
    with pytest.raises(ContractValidationError):
        receipt(**change)


def test_transition_two_requires_predecessor_and_uses_new_source_sequence():
    value = receipt(
        transitionNumber="2",
        sourceSequence="2",
        lifecycleSequence="3",
        previousReceiptId="f" * 64,
    )
    assert value["transitionNumber"] == "2"
    assert value["previousReceiptId"] == "f" * 64


def test_permit_window_and_event_ordering_are_fail_closed():
    with pytest.raises(ContractValidationError, match="dispatch must be armed"):
        receipt(dispatchArmedAt="2026-08-15T01:00:30.000Z")
    with pytest.raises(ContractValidationError, match="cannot precede"):
        receipt(simulatorOccurredAt="2026-08-15T00:59:58.000Z")
    with pytest.raises(ContractValidationError, match="cannot occur after"):
        receipt(adapterObservedAt="2026-08-15T00:59:59.000Z")


def test_fill_price_and_notional_are_bounded_for_buy_limit_receipts():
    with pytest.raises(ContractValidationError, match="fill receipts require"):
        receipt(lifecycleKind="filled")
    with pytest.raises(ContractValidationError, match="authorized price or notional"):
        receipt(lifecycleKind="filled", filledQuantity="0.001", averagePrice="100001")
    assert (
        receipt(lifecycleKind="filled", filledQuantity="0.001", averagePrice="100000")[
            "lifecycleKind"
        ]
        == "filled"
    )


def test_decimal_precision_json_complexity_and_raw_evidence_boundaries_fail_closed():
    with pytest.raises(ContractValidationError):
        receipt(quantity="1" * 33, price="1", maxNotionalUsd="9" * 32)
    with pytest.raises(ContractValidationError):
        receipt(quantity="0." + "1" * 19)
    nested = "[" * 17 + "0" + "]" * 17
    assert (
        verify(receipt(), request_bytes=nested.encode()).reason
        == "raw_evidence_mismatch"
    )
    assert (
        verify(receipt(), response_bytes=b" " * 32769).reason == "raw_evidence_mismatch"
    )


def test_hash_signature_identity_key_id_and_key_material_alias_fail_closed():
    value = receipt()
    assert verify({**value, "receiptId": "0" * 64}).reason == "receipt_hash_mismatch"
    assert (
        verify({**value, "signature": base64.b64encode(b"\x01" * 64).decode()}).reason
        == "signature_invalid"
    )
    assert (
        verify(value, trust_policy=policy(value, adapter_id="different")).reason
        == "adapter_identity_mismatch"
    )
    assert (
        verify(
            value,
            trust_policy=policy(
                value,
                permit_authority_key_ids=[value["permitKeyId"], value["adapterKeyId"]],
            ),
        ).reason
        == "untrusted_adapter_key"
    )
    fingerprint = ed25519_public_key_fingerprint_sha256(PUBLIC_KEY_DER)
    assert (
        verify(
            value,
            trust_policy=policy(
                value, permit_authority_public_key_fingerprints=[fingerprint]
            ),
        ).reason
        == "untrusted_adapter_key"
    )


def test_expected_binding_requires_all_fields_including_absent_predecessor():
    value = receipt()
    incomplete = expected(value)
    del incomplete["previousReceiptId"]
    assert (
        verify(value, expected_binding=incomplete).reason == "expected_binding_mismatch"
    )
    changed = expected(value)
    changed["sourceSequence"] = "2"
    assert verify(value, expected_binding=changed).reason == "expected_binding_mismatch"


def test_future_receipt_is_rejected_and_cross_language_attempt_is_fixed():
    assert (
        verify(receipt(), now=datetime(2026, 8, 15, 0, 59, tzinfo=timezone.utc)).reason
        == "receipt_from_future"
    )
    assert (
        ATTEMPT_ID == "b62ad7d11e8bc3a39091c82386382d75b1424d56a786c9a9df2d0187576e40b7"
    )
    value = receipt()
    assert (
        value["receiptId"]
        == "2c509851f987ae32a70265224f1b77dece93e0509753f3170e2e0863c0f22ce4"
    )
    assert value["signature"] == (
        "PdBoo7H6jntjJlAFGknpiQTKPPV5TNOG9UFnhtSalYx59aSxPUWULUWCec5bYwZ"
        "GhXCfsOLLQoIemD7Iyj1TCQ=="
    )


def capability_core(**changes):
    value = {
        "schemaVersion": OFFLINE_SIMULATOR_CAPABILITY_V1,
        "scope": OFFLINE_SIMULATOR_CAPABILITY_SCOPE,
        "capability": OFFLINE_SIMULATOR_CAPABILITY,
        "authorityKind": "original_dispatch",
        "authorityKeyId": "offline-authority-test-key",
        "policyHash": "1" * 64,
        "simulatorStoreId": "2" * 64,
        "sourceAttestationKeyId": "offline-source-test-key",
        "commandId": COMMAND_ID,
        "attemptId": ATTEMPT_ID,
        "attemptAdapterEpoch": "1",
        "sourceNamespaceId": SOURCE_NAMESPACE_ID,
        "clientOrderId": REQUEST["clientOrderId"],
        "requestHash": REQUEST_HASH,
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


def verify_capability(value, **changes):
    return verify_offline_simulator_capability_v1(
        capability=value,
        key_resolver=changes.get(
            "key_resolver", {value["authorityKeyId"]: PUBLIC_KEY_DER}
        ),
        public_key=changes.get("public_key"),
        now=changes.get("now", NOW),
        max_ttl_ms=changes.get("max_ttl_ms", 120_000),
        max_future_ms=changes.get("max_future_ms", 30_000),
    )


def test_offline_capability_valid_domain_separated_and_direct_public_key_verification():
    value = capability()
    assert value["capabilityId"] == offline_simulator_capability_v1_id(
        {key: item for key, item in value.items() if key not in {"capabilityId", "signature"}}
    )
    assert offline_simulator_capability_v1_signing_payload(value).startswith(
        "openalice:offline-simulator-capability:v1\0"
    )
    result = verify_capability(value)
    assert (result.valid, result.reason, result.capability) == (
        True,
        "offline_simulator_only",
        value,
    )
    direct = verify_offline_simulator_capability_v1(
        capability=value,
        public_key=PUBLIC_KEY_DER,
        now=NOW,
        max_ttl_ms=120_000,
        max_future_ms=30_000,
    )
    assert (direct.valid, direct.reason) == (True, "offline_simulator_only")


def test_offline_capability_requires_canonical_bounded_json():
    value = capability()
    raw = stable_stringify(value).encode()
    assert parse_offline_simulator_capability_json_utf8(raw) == value
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_simulator_capability_json_utf8(json.dumps(value, indent=2).encode())
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_simulator_capability_json_utf8(
            raw.replace(b"{", b'{"scope":"offline_simulator_only",', 1)
        )
    with pytest.raises(ContractValidationError, match="canonical_json_invalid"):
        parse_offline_simulator_capability_json_utf8(
            b" " * (MAX_OFFLINE_SIMULATOR_CAPABILITY_JSON_BYTES + 1)
        )


def test_offline_capability_hash_signature_unknown_and_wrong_key_fail_closed():
    value = capability()
    assert (
        verify_capability({**value, "capabilityId": "0" * 64}).reason
        == "capability_hash_mismatch"
    )
    assert (
        verify_capability(
            {**value, "signature": base64.b64encode(b"\x01" * 64).decode()}
        ).reason
        == "signature_invalid"
    )
    assert verify_capability(value, key_resolver={}).reason == "unknown_authority_key"
    assert (
        verify_capability(
            value,
            key_resolver={
                value["authorityKeyId"]: Ed25519PrivateKey.generate().public_key()
            },
        ).reason
        == "signature_invalid"
    )


def test_offline_capability_expiry_future_and_ttl_bounds_fail_closed():
    expired = capability(expiresAt="2026-08-15T01:00:01.000Z")
    assert verify_capability(expired).reason == "capability_expired"
    future = capability(
        issuedAt="2026-08-15T01:01:00.000Z",
        expiresAt="2026-08-15T01:02:00.000Z",
    )
    assert verify_capability(future, max_future_ms=0).reason == "capability_from_future"
    ttl = capability(expiresAt="2026-08-15T01:05:01.000Z")
    assert verify_capability(ttl, max_ttl_ms=120_000).reason == "capability_ttl_exceeded"


def test_offline_capability_authority_kind_claim_invariant_is_strict():
    with pytest.raises(ContractValidationError, match="forbids"):
        capability(reconciliationClaimId="2" * 64)
    with pytest.raises(ContractValidationError, match="requires"):
        capability(authorityKind="takeover_reconciliation")
    takeover = capability(
        authorityKind="takeover_reconciliation", reconciliationClaimId="2" * 64
    )
    assert verify_capability(takeover).valid


@pytest.mark.parametrize(
    "field,replacement",
    (
        ("schemaVersion", "unsupported.v1"),
        ("scope", "broker_terminal"),
        ("capability", "offline_simulator.ensure_exact.v1"),
        ("authorityKind", "takeover_reconciliation"),
        ("authorityKeyId", "different-authority-key"),
        ("policyHash", "2" * 64),
        ("commandId", "b" * 64),
        ("attemptId", "c" * 64),
        ("attemptAdapterEpoch", "2"),
        ("sourceNamespaceId", "d" * 64),
        ("clientOrderId", "OA0987654321ABCDEF"),
        ("requestHash", "e" * 64),
        ("writerName", "different-writer"),
        ("writerOwnerId", "different-owner"),
        ("writerEpoch", "2"),
        ("issuedAt", "2026-08-15T01:00:01.000Z"),
        ("expiresAt", "2026-08-15T01:01:01.000Z"),
    ),
)
def test_offline_capability_each_binding_tamper_fails(field, replacement):
    value = capability()
    altered = {**value, field: replacement}
    result = verify_capability(altered)
    assert not result.valid
    assert result.reason in {"capability_hash_mismatch", "invalid_contract"}
