"""Signed simulator-only execution receipts; no network or broker access."""

from __future__ import annotations

import base64
import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
import json
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_private_key,
    load_der_public_key,
    load_pem_private_key,
    load_pem_public_key,
)

from .contract import ContractValidationError, sha256_canonical, stable_stringify

OFFLINE_EXECUTION_RECEIPT_V1 = "openalice_offline_execution_receipt.v1"
OFFLINE_EXECUTION_ATTEMPT_V1 = "openalice_execution_attempt.v1"
OFFLINE_SIMULATOR_REQUEST_V1 = "openalice_offline_simulator_request.v1"
OFFLINE_SIMULATOR_RESPONSE_V1 = "openalice_offline_simulator_response.v1"
OFFLINE_SIMULATOR_CAPABILITY_V1 = "openalice_offline_simulator_capability.v1"
OFFLINE_EXECUTION_RECEIPT_SCOPE = "offline_simulator_only"
OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN = "openalice:offline-execution-receipt:v1"
OFFLINE_SIMULATOR_CAPABILITY_SCOPE = "offline_simulator_only"
OFFLINE_SIMULATOR_CAPABILITY = "offline_simulator.ensure_exact.v2"
OFFLINE_SIMULATOR_CAPABILITY_SIGNATURE_DOMAIN = (
    "openalice:offline-simulator-capability:v1"
)
MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES = 65_536
MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES = 32_768
MAX_OFFLINE_SIMULATOR_RESPONSE_JSON_BYTES = 32_768
MAX_OFFLINE_SIMULATOR_CAPABILITY_JSON_BYTES = 32_768

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
_UINT64_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
_ORDER_ID_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")
_SIMULATED_ORDER_ID_RE = re.compile(r"^SIM[A-Za-z0-9]{1,197}$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_UTC_MILLISECOND_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_MAX_UINT64 = (1 << 64) - 1
_MAX_DECIMAL_INTEGER_DIGITS = 32
_MAX_DECIMAL_FRACTION_DIGITS = 18
_MAX_JSON_DEPTH = 16
_MAX_JSON_NODES = 512
_KINDS = frozenset(
    (
        "submitted",
        "partially_filled",
        "filled",
        "canceled",
        "rejected",
        "expired",
        "submission_unknown",
    )
)
_TIME_IN_FORCE = frozenset(("GTC", "IOC", "FOK"))
_CAPABILITY_AUTHORITY_KINDS = frozenset(
    ("original_dispatch", "takeover_reconciliation")
)

_REQUEST_KEYS = frozenset(
    (
        "schemaVersion",
        "sourceNamespaceId",
        "commandId",
        "payloadHash",
        "permitV2Id",
        "permitKeyId",
        "acceptedSequence",
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
        "adapterId",
        "adapterRunId",
        "adapterEpoch",
        "attemptId",
        "attemptNumber",
        "permitIssuedAt",
        "permitExpiresAt",
        "dispatchArmedAt",
    )
)
_RESPONSE_KEYS = frozenset(
    (
        "schemaVersion",
        "sourceNamespaceId",
        "sourceSequence",
        "commandId",
        "attemptId",
        "requestHash",
        "clientOrderId",
        "state",
        "simulatorOccurredAt",
        "simulatedOrderId",
        "filledQuantity",
        "averagePrice",
        "reason",
    )
)
_OPTIONAL_RESPONSE_KEYS = frozenset(
    ("simulatedOrderId", "filledQuantity", "averagePrice", "reason")
)
_CORE_KEYS = frozenset(
    (
        "schemaVersion",
        "scope",
        "commandId",
        "payloadHash",
        "permitV2Id",
        "permitKeyId",
        "acceptedSequence",
        "lifecycleSequence",
        "lifecycleKind",
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
        "adapterId",
        "adapterBuildHash",
        "adapterConfigHash",
        "adapterRunId",
        "adapterEpoch",
        "adapterKeyId",
        "attemptId",
        "attemptNumber",
        "sourceNamespaceId",
        "sourceSequence",
        "transitionNumber",
        "simulatedOrderId",
        "requestHash",
        "responseHash",
        "permitIssuedAt",
        "permitExpiresAt",
        "dispatchArmedAt",
        "adapterObservedAt",
        "simulatorOccurredAt",
        "previousReceiptId",
        "filledQuantity",
        "averagePrice",
        "reason",
    )
)
_OPTIONAL_CORE_KEYS = frozenset(
    (
        "simulatedOrderId",
        "previousReceiptId",
        "filledQuantity",
        "averagePrice",
        "reason",
    )
)
_EXPECTED_BINDING_FIELDS = (
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
    "previousReceiptId",
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
_CAPABILITY_CORE_KEYS = frozenset(
    (
        "schemaVersion",
        "scope",
        "capability",
        "authorityKind",
        "authorityKeyId",
        "policyHash",
        "simulatorStoreId",
        "sourceAttestationKeyId",
        "commandId",
        "attemptId",
        "attemptAdapterEpoch",
        "sourceNamespaceId",
        "clientOrderId",
        "requestHash",
        "writerName",
        "writerOwnerId",
        "writerEpoch",
        "issuedAt",
        "expiresAt",
        "reconciliationClaimId",
    )
)
_OPTIONAL_CAPABILITY_CORE_KEYS = frozenset(("reconciliationClaimId",))


@dataclass(frozen=True)
class OfflineReceiptTrustPolicy:
    key_id: str
    adapter_id: str
    adapter_build_hash: str
    adapter_config_hash: str
    adapter_run_id: str
    permit_authority_key_ids: Sequence[str]
    permit_authority_public_key_fingerprints: Sequence[str]
    public_key: Ed25519PublicKey | bytes | str


@dataclass(frozen=True)
class OfflineReceiptVerification:
    valid: bool
    reason: str
    finalization_eligible: bool = False
    receipt: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class OfflineSimulatorCapabilityVerification:
    """Fail-closed result for a simulator mutation authority capability."""

    valid: bool
    reason: str
    capability: Mapping[str, Any] | None = None


def derive_offline_execution_attempt_id(
    *,
    command_id: str,
    adapter_id: str,
    adapter_run_id: str,
    adapter_epoch: str,
    attempt_number: str,
) -> str:
    return sha256_canonical(
        {
            "schemaVersion": OFFLINE_EXECUTION_ATTEMPT_V1,
            "commandId": command_id,
            "adapterId": adapter_id,
            "adapterRunId": adapter_run_id,
            "adapterEpoch": adapter_epoch,
            "attemptNumber": attempt_number,
        }
    )


def ed25519_public_key_fingerprint_sha256(value: Ed25519PublicKey | bytes | str) -> str:
    """Return the SHA-256 of the canonical SPKI DER encoding for an Ed25519 key."""
    public_key = _public_key(value)
    return hashlib.sha256(
        public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)
    ).hexdigest()


def validate_offline_simulator_request_v1(value: Any) -> dict[str, Any]:
    request = _mapping(value, "offline simulator request")
    _exact_keys(request, _REQUEST_KEYS)
    _equals(request, "schemaVersion", OFFLINE_SIMULATOR_REQUEST_V1)
    _hash(request.get("sourceNamespaceId"), "sourceNamespaceId")
    command_id = _hash(request.get("commandId"), "commandId")
    if _hash(request.get("payloadHash"), "payloadHash") != command_id:
        raise ContractValidationError("payloadHash must equal commandId")
    _hash(request.get("permitV2Id"), "permitV2Id")
    _regex(request.get("permitKeyId"), _KEY_ID_RE, "permitKeyId")
    _positive_uint64(request.get("acceptedSequence"), "acceptedSequence")
    _common_order_fields(request)
    adapter_id = _text(request, "adapterId", 200)
    adapter_run_id = _text(request, "adapterRunId", 300)
    epoch = _positive_uint64(request.get("adapterEpoch"), "adapterEpoch")
    number = _positive_uint64(request.get("attemptNumber"), "attemptNumber")
    if _hash(
        request.get("attemptId"), "attemptId"
    ) != derive_offline_execution_attempt_id(
        command_id=command_id,
        adapter_id=adapter_id,
        adapter_run_id=adapter_run_id,
        adapter_epoch=epoch,
        attempt_number=number,
    ):
        raise ContractValidationError(
            "attemptId does not match its deterministic binding"
        )
    _permit_interval(request)
    return dict(request)


def validate_offline_simulator_response_v1(value: Any) -> dict[str, Any]:
    response = _mapping(value, "offline simulator response")
    _exact_keys(response, _RESPONSE_KEYS, optional=_OPTIONAL_RESPONSE_KEYS)
    _equals(response, "schemaVersion", OFFLINE_SIMULATOR_RESPONSE_V1)
    _hash(response.get("sourceNamespaceId"), "sourceNamespaceId")
    _positive_uint64(response.get("sourceSequence"), "sourceSequence")
    _hash(response.get("commandId"), "commandId")
    _hash(response.get("attemptId"), "attemptId")
    _hash(response.get("requestHash"), "requestHash")
    _regex(response.get("clientOrderId"), _ORDER_ID_RE, "clientOrderId")
    state = _literal(response, "state", _KINDS)
    _timestamp(response.get("simulatorOccurredAt"), "simulatorOccurredAt")
    _validate_outcome_fields(response, state, label="response")
    return dict(response)


def validate_offline_execution_receipt_core_v1(value: Any) -> dict[str, Any]:
    core = _mapping(value, "offline receipt core")
    _exact_keys(core, _CORE_KEYS, optional=_OPTIONAL_CORE_KEYS)
    _equals(core, "schemaVersion", OFFLINE_EXECUTION_RECEIPT_V1)
    _equals(core, "scope", OFFLINE_EXECUTION_RECEIPT_SCOPE)
    command_id = _hash(core.get("commandId"), "commandId")
    if _hash(core.get("payloadHash"), "payloadHash") != command_id:
        raise ContractValidationError("payloadHash must equal commandId")
    _hash(core.get("permitV2Id"), "permitV2Id")
    _regex(core.get("permitKeyId"), _KEY_ID_RE, "permitKeyId")
    accepted = _positive_uint64(core.get("acceptedSequence"), "acceptedSequence")
    lifecycle = _positive_uint64(core.get("lifecycleSequence"), "lifecycleSequence")
    if int(lifecycle) <= int(accepted):
        raise ContractValidationError(
            "adapter lifecycle sequence must follow durable acknowledgement"
        )
    kind = _literal(core, "lifecycleKind", _KINDS)
    _common_order_fields(core)
    adapter_id = _text(core, "adapterId", 200)
    _hash(core.get("adapterBuildHash"), "adapterBuildHash")
    _hash(core.get("adapterConfigHash"), "adapterConfigHash")
    adapter_run_id = _text(core, "adapterRunId", 300)
    epoch = _positive_uint64(core.get("adapterEpoch"), "adapterEpoch")
    _regex(core.get("adapterKeyId"), _KEY_ID_RE, "adapterKeyId")
    number = _positive_uint64(core.get("attemptNumber"), "attemptNumber")
    if _hash(core.get("attemptId"), "attemptId") != derive_offline_execution_attempt_id(
        command_id=command_id,
        adapter_id=adapter_id,
        adapter_run_id=adapter_run_id,
        adapter_epoch=epoch,
        attempt_number=number,
    ):
        raise ContractValidationError(
            "attemptId does not match its deterministic binding"
        )
    _hash(core.get("sourceNamespaceId"), "sourceNamespaceId")
    _positive_uint64(core.get("sourceSequence"), "sourceSequence")
    transition = _positive_uint64(core.get("transitionNumber"), "transitionNumber")
    if (transition == "1" and "previousReceiptId" in core) or (
        transition != "1" and "previousReceiptId" not in core
    ):
        raise ContractValidationError(
            "receipt predecessor does not match its transition number"
        )
    if "previousReceiptId" in core:
        _hash(core.get("previousReceiptId"), "previousReceiptId")
    _hash(core.get("requestHash"), "requestHash")
    _hash(core.get("responseHash"), "responseHash")
    _permit_interval(core)
    observed = _timestamp(core.get("adapterObservedAt"), "adapterObservedAt")
    occurred = _timestamp(core.get("simulatorOccurredAt"), "simulatorOccurredAt")
    armed = _timestamp(core.get("dispatchArmedAt"), "dispatchArmedAt")
    if occurred > observed:
        raise ContractValidationError(
            "simulator event cannot occur after adapter observation"
        )
    if occurred < armed:
        raise ContractValidationError(
            "simulator event cannot precede the armed dispatch"
        )
    _validate_outcome_fields(core, kind, label="receipt")
    return dict(core)


def offline_execution_receipt_v1_id(core: Mapping[str, Any]) -> str:
    return sha256_canonical(
        {
            "domain": OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN,
            "value": validate_offline_execution_receipt_core_v1(core),
        }
    )


def offline_execution_receipt_v1_signing_payload(receipt: Mapping[str, Any]) -> str:
    parsed = validate_offline_execution_receipt_v1(receipt)
    core = {
        key: value
        for key, value in parsed.items()
        if key not in {"receiptId", "signature"}
    }
    return f"{OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN}\0{stable_stringify({'receiptId': parsed['receiptId'], **core})}"


def create_offline_execution_receipt_v1(
    *, core: Any, private_key: Ed25519PrivateKey | bytes | str
) -> dict[str, Any]:
    parsed = validate_offline_execution_receipt_core_v1(core)
    receipt_id = offline_execution_receipt_v1_id(parsed)
    payload = f"{OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN}\0{stable_stringify({'receiptId': receipt_id, **parsed})}".encode(
        "utf-8"
    )
    return validate_offline_execution_receipt_v1(
        {
            **parsed,
            "receiptId": receipt_id,
            "signature": base64.b64encode(
                _private_key(private_key).sign(payload)
            ).decode("ascii"),
        }
    )


def validate_offline_execution_receipt_v1(
    value: Any, *, verify_hash: bool = True
) -> dict[str, Any]:
    receipt = _mapping(value, "offline receipt")
    _exact_keys(
        receipt, _CORE_KEYS | {"receiptId", "signature"}, optional=_OPTIONAL_CORE_KEYS
    )
    core = validate_offline_execution_receipt_core_v1(
        {
            key: item
            for key, item in receipt.items()
            if key not in {"receiptId", "signature"}
        }
    )
    receipt_id = _hash(receipt.get("receiptId"), "receiptId")
    _signature(receipt.get("signature"))
    if verify_hash and offline_execution_receipt_v1_id(core) != receipt_id:
        raise ContractValidationError("offline_execution_receipt_hash_mismatch")
    return {**core, "receiptId": receipt_id, "signature": receipt["signature"]}


def build_execution_event_v2_from_offline_receipt(value: Any) -> dict[str, Any]:
    """Derive the only semantically valid V2 lifecycle event for a receipt."""
    from .contract import validate_execution_event_v2

    receipt = validate_offline_execution_receipt_v1(value)
    core: dict[str, Any] = {
        "schemaVersion": "openalice_execution_event.v2",
        "commandId": receipt["commandId"],
        "sequence": receipt["lifecycleSequence"],
        "occurredAt": receipt["simulatorOccurredAt"],
        "kind": receipt["lifecycleKind"],
        "clientOrderId": receipt["clientOrderId"],
        "evidenceSchemaVersion": OFFLINE_EXECUTION_RECEIPT_V1,
        "evidenceReceiptId": receipt["receiptId"],
    }
    for source, target in (
        ("simulatedOrderId", "venueOrderId"),
        ("filledQuantity", "filledQuantity"),
        ("averagePrice", "averagePrice"),
        ("reason", "reason"),
    ):
        if source in receipt:
            core[target] = receipt[source]
    return validate_execution_event_v2(
        {**core, "eventId": sha256_canonical(core)}
    )


def execution_event_v2_matches_offline_receipt(
    receipt: Any, event: Any
) -> bool:
    """Return true only for the exact receipt-derived V2 event projection."""
    from .contract import validate_execution_event_v2

    try:
        parsed_event = validate_execution_event_v2(event)
        expected = build_execution_event_v2_from_offline_receipt(receipt)
    except (ContractValidationError, TypeError, ValueError):
        return False
    return stable_stringify(parsed_event) == stable_stringify(expected)


def parse_offline_execution_receipt_json_utf8(raw: bytes) -> dict[str, Any]:
    try:
        return validate_offline_execution_receipt_v1(
            _canonical_json_bytes(raw, MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES)
        )
    except (ContractValidationError, TypeError, ValueError):
        raise ContractValidationError(
            "offline_execution_receipt_canonical_json_invalid"
        ) from None


def verify_offline_execution_receipt_v1(
    *,
    receipt: Any,
    canonical_request_json_utf8: bytes,
    canonical_response_json_utf8: bytes,
    trust_policy: OfflineReceiptTrustPolicy,
    expected: Mapping[str, Any],
    now: datetime | None = None,
    max_future_ms: int = 30_000,
) -> OfflineReceiptVerification:
    try:
        parsed = validate_offline_execution_receipt_v1(receipt)
    except ContractValidationError as error:
        return OfflineReceiptVerification(
            False,
            "receipt_hash_mismatch"
            if str(error) == "offline_execution_receipt_hash_mismatch"
            else "invalid_contract",
        )
    if (
        not isinstance(trust_policy, OfflineReceiptTrustPolicy)
        or parsed["adapterKeyId"] != trust_policy.key_id
    ):
        return OfflineReceiptVerification(False, "untrusted_adapter_key")
    authorities = trust_policy.permit_authority_key_ids
    fingerprints = trust_policy.permit_authority_public_key_fingerprints
    if (
        not isinstance(authorities, Sequence)
        or isinstance(authorities, (str, bytes))
        or not all(
            isinstance(item, str) and _KEY_ID_RE.fullmatch(item) for item in authorities
        )
        or not isinstance(fingerprints, Sequence)
        or isinstance(fingerprints, (str, bytes))
        or not fingerprints
        or not all(
            isinstance(item, str) and _SHA256_RE.fullmatch(item)
            for item in fingerprints
        )
        or parsed["permitKeyId"] not in authorities
        or parsed["adapterKeyId"] in authorities
        or parsed["permitKeyId"] == parsed["adapterKeyId"]
    ):
        return OfflineReceiptVerification(False, "untrusted_adapter_key")
    if any(
        (
            parsed["adapterId"] != trust_policy.adapter_id,
            parsed["adapterBuildHash"] != trust_policy.adapter_build_hash,
            parsed["adapterConfigHash"] != trust_policy.adapter_config_hash,
            parsed["adapterRunId"] != trust_policy.adapter_run_id,
        )
    ):
        return OfflineReceiptVerification(False, "adapter_identity_mismatch")
    try:
        request = validate_offline_simulator_request_v1(
            _canonical_json_bytes(
                canonical_request_json_utf8, MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES
            )
        )
        response = validate_offline_simulator_response_v1(
            _canonical_json_bytes(
                canonical_response_json_utf8, MAX_OFFLINE_SIMULATOR_RESPONSE_JSON_BYTES
            )
        )
    except (ContractValidationError, TypeError, ValueError):
        return OfflineReceiptVerification(False, "raw_evidence_mismatch")
    if (
        sha256_canonical(request) != parsed["requestHash"]
        or sha256_canonical(response) != parsed["responseHash"]
        or not _request_matches_receipt(request, parsed)
        or not _response_matches_receipt(response, parsed)
    ):
        return OfflineReceiptVerification(False, "raw_evidence_mismatch")
    try:
        public_key = _public_key(trust_policy.public_key)
    except (TypeError, ValueError):
        return OfflineReceiptVerification(False, "untrusted_adapter_key")
    if ed25519_public_key_fingerprint_sha256(public_key) in fingerprints:
        return OfflineReceiptVerification(False, "untrusted_adapter_key")
    try:
        public_key.verify(
            _signature(parsed["signature"]),
            offline_execution_receipt_v1_signing_payload(parsed).encode("utf-8"),
        )
    except InvalidSignature:
        return OfflineReceiptVerification(False, "signature_invalid")
    if not isinstance(expected, Mapping) or any(
        field not in expected or parsed.get(field) != expected[field]
        for field in _EXPECTED_BINDING_FIELDS
    ):
        return OfflineReceiptVerification(False, "expected_binding_mismatch")
    reference = datetime.now(timezone.utc) if now is None else now
    if (
        not isinstance(reference, datetime)
        or reference.tzinfo is None
        or reference.utcoffset() != timezone.utc.utcoffset(reference)
        or isinstance(max_future_ms, bool)
        or not isinstance(max_future_ms, int)
        or max_future_ms < 0
        or _timestamp(parsed["adapterObservedAt"], "adapterObservedAt").timestamp()
        * 1000
        > reference.timestamp() * 1000 + max_future_ms
    ):
        return OfflineReceiptVerification(False, "receipt_from_future")
    return OfflineReceiptVerification(True, "offline_simulator_only", False, parsed)


def validate_offline_simulator_capability_core_v1(value: Any) -> dict[str, Any]:
    """Validate an unsigned, simulator-only mutation capability core."""
    core = _mapping(value, "offline simulator capability core")
    _assert_capability_json_bounds(core)
    _exact_keys(
        core, _CAPABILITY_CORE_KEYS, optional=_OPTIONAL_CAPABILITY_CORE_KEYS
    )
    _equals(core, "schemaVersion", OFFLINE_SIMULATOR_CAPABILITY_V1)
    _equals(core, "scope", OFFLINE_SIMULATOR_CAPABILITY_SCOPE)
    _equals(core, "capability", OFFLINE_SIMULATOR_CAPABILITY)
    authority_kind = _literal(core, "authorityKind", _CAPABILITY_AUTHORITY_KINDS)
    _regex(core.get("authorityKeyId"), _KEY_ID_RE, "authorityKeyId")
    _hash(core.get("policyHash"), "policyHash")
    _hash(core.get("simulatorStoreId"), "simulatorStoreId")
    _regex(
        core.get("sourceAttestationKeyId"),
        _KEY_ID_RE,
        "sourceAttestationKeyId",
    )
    _hash(core.get("commandId"), "commandId")
    _hash(core.get("attemptId"), "attemptId")
    _positive_uint64(core.get("attemptAdapterEpoch"), "attemptAdapterEpoch")
    _hash(core.get("sourceNamespaceId"), "sourceNamespaceId")
    _regex(core.get("clientOrderId"), _ORDER_ID_RE, "clientOrderId")
    _hash(core.get("requestHash"), "requestHash")
    _text(core, "writerName", 200)
    _text(core, "writerOwnerId", 200)
    _positive_uint64(core.get("writerEpoch"), "writerEpoch")
    issued = _timestamp(core.get("issuedAt"), "issuedAt")
    expires = _timestamp(core.get("expiresAt"), "expiresAt")
    if issued >= expires:
        raise ContractValidationError("capability issuedAt must precede expiresAt")
    has_claim = "reconciliationClaimId" in core
    if authority_kind == "takeover_reconciliation":
        if not has_claim:
            raise ContractValidationError(
                "takeover reconciliation capability requires reconciliationClaimId"
            )
        _hash(core.get("reconciliationClaimId"), "reconciliationClaimId")
    elif has_claim:
        raise ContractValidationError(
            "original dispatch capability forbids reconciliationClaimId"
        )
    return dict(core)


def offline_simulator_capability_v1_id(core: Mapping[str, Any]) -> str:
    """Return the domain-separated canonical identity of a capability core."""
    return sha256_canonical(
        {
            "domain": OFFLINE_SIMULATOR_CAPABILITY_SIGNATURE_DOMAIN,
            "value": validate_offline_simulator_capability_core_v1(core),
        }
    )


def offline_simulator_capability_v1_signing_payload(
    capability: Mapping[str, Any],
) -> str:
    """Return the exact domain-separated UTF-8 payload that Ed25519 signs."""
    parsed = validate_offline_simulator_capability_v1(capability)
    core = {
        key: item
        for key, item in parsed.items()
        if key not in {"capabilityId", "signature"}
    }
    return (
        f"{OFFLINE_SIMULATOR_CAPABILITY_SIGNATURE_DOMAIN}\0"
        f"{stable_stringify({'capabilityId': parsed['capabilityId'], **core})}"
    )


def create_offline_simulator_capability_v1(
    *, core: Any, private_key: Ed25519PrivateKey | bytes | str
) -> dict[str, Any]:
    """Create a signed, bounded simulator mutation capability without I/O."""
    parsed = validate_offline_simulator_capability_core_v1(core)
    capability_id = offline_simulator_capability_v1_id(parsed)
    payload = (
        f"{OFFLINE_SIMULATOR_CAPABILITY_SIGNATURE_DOMAIN}\0"
        f"{stable_stringify({'capabilityId': capability_id, **parsed})}"
    ).encode("utf-8")
    return validate_offline_simulator_capability_v1(
        {
            **parsed,
            "capabilityId": capability_id,
            "signature": base64.b64encode(_private_key(private_key).sign(payload)).decode(
                "ascii"
            ),
        }
    )


def validate_offline_simulator_capability_v1(
    value: Any, *, verify_hash: bool = True
) -> dict[str, Any]:
    """Strictly validate the signed capability shape and deterministic identity."""
    capability = _mapping(value, "offline simulator capability")
    _assert_capability_json_bounds(capability)
    _exact_keys(
        capability,
        _CAPABILITY_CORE_KEYS | {"capabilityId", "signature"},
        optional=_OPTIONAL_CAPABILITY_CORE_KEYS,
    )
    core = validate_offline_simulator_capability_core_v1(
        {
            key: item
            for key, item in capability.items()
            if key not in {"capabilityId", "signature"}
        }
    )
    capability_id = _hash(capability.get("capabilityId"), "capabilityId")
    _signature(capability.get("signature"))
    if verify_hash and offline_simulator_capability_v1_id(core) != capability_id:
        raise ContractValidationError("offline_simulator_capability_hash_mismatch")
    return {**core, "capabilityId": capability_id, "signature": capability["signature"]}


def parse_offline_simulator_capability_json_utf8(raw: bytes) -> dict[str, Any]:
    """Parse only canonical UTF-8 JSON within the capability's fixed bounds."""
    try:
        return validate_offline_simulator_capability_v1(
            _canonical_json_bytes(raw, MAX_OFFLINE_SIMULATOR_CAPABILITY_JSON_BYTES)
        )
    except (ContractValidationError, TypeError, ValueError):
        raise ContractValidationError(
            "offline_simulator_capability_canonical_json_invalid"
        ) from None


def verify_offline_simulator_capability_v1(
    *,
    capability: Any,
    key_resolver: Any = None,
    public_key: Ed25519PublicKey | bytes | str | None = None,
    now: datetime | None = None,
    max_ttl_ms: int = 300_000,
    max_future_ms: int = 30_000,
) -> OfflineSimulatorCapabilityVerification:
    """Verify local authority, signature, and time bounds without external access.

    ``key_resolver`` can be a callable keyed by ``authorityKeyId`` or a mapping.
    A direct ``public_key`` is permitted only when no resolver is supplied, so a
    caller that has already pinned a key can use the same fail-closed checks.
    """
    try:
        parsed = validate_offline_simulator_capability_v1(capability)
    except ContractValidationError as error:
        return OfflineSimulatorCapabilityVerification(
            False,
            "capability_hash_mismatch"
            if str(error) == "offline_simulator_capability_hash_mismatch"
            else "invalid_contract",
        )
    if not _valid_capability_verification_bounds(max_ttl_ms, max_future_ms):
        return OfflineSimulatorCapabilityVerification(False, "invalid_verification_bounds")
    reference = datetime.now(timezone.utc) if now is None else now
    if not _is_utc_datetime(reference):
        return OfflineSimulatorCapabilityVerification(False, "invalid_verification_bounds")
    resolved_key = _resolve_capability_public_key(
        key_resolver=key_resolver,
        public_key=public_key,
        authority_key_id=parsed["authorityKeyId"],
    )
    if resolved_key is None:
        return OfflineSimulatorCapabilityVerification(False, "unknown_authority_key")
    try:
        resolved_key.verify(
            _signature(parsed["signature"]),
            offline_simulator_capability_v1_signing_payload(parsed).encode("utf-8"),
        )
    except InvalidSignature:
        return OfflineSimulatorCapabilityVerification(False, "signature_invalid")
    issued = _timestamp(parsed["issuedAt"], "issuedAt")
    expires = _timestamp(parsed["expiresAt"], "expiresAt")
    reference_ms = _datetime_ms(reference)
    if _datetime_ms(issued) > reference_ms + max_future_ms:
        return OfflineSimulatorCapabilityVerification(False, "capability_from_future")
    if _datetime_ms(expires) <= reference_ms:
        return OfflineSimulatorCapabilityVerification(False, "capability_expired")
    if _datetime_ms(expires) - _datetime_ms(issued) > max_ttl_ms:
        return OfflineSimulatorCapabilityVerification(False, "capability_ttl_exceeded")
    return OfflineSimulatorCapabilityVerification(True, "offline_simulator_only", parsed)


def _assert_capability_json_bounds(value: Any) -> None:
    _assert_bounded_json_complexity(value)
    if (
        len(stable_stringify(value).encode("utf-8"))
        > MAX_OFFLINE_SIMULATOR_CAPABILITY_JSON_BYTES
    ):
        raise ContractValidationError("capability JSON exceeds byte limit")


def _valid_capability_verification_bounds(max_ttl_ms: Any, max_future_ms: Any) -> bool:
    return all(
        isinstance(value, int) and not isinstance(value, bool) and value >= 0
        for value in (max_ttl_ms, max_future_ms)
    )


def _is_utc_datetime(value: Any) -> bool:
    return (
        isinstance(value, datetime)
        and value.tzinfo is not None
        and value.utcoffset() == timezone.utc.utcoffset(value)
    )


def _datetime_ms(value: datetime) -> int:
    return int(value.timestamp() * 1000)


def _resolve_capability_public_key(
    *, key_resolver: Any, public_key: Ed25519PublicKey | bytes | str | None,
    authority_key_id: str,
) -> Ed25519PublicKey | None:
    try:
        if key_resolver is not None:
            if callable(key_resolver):
                resolved = key_resolver(authority_key_id)
            elif isinstance(key_resolver, Mapping):
                resolved = key_resolver.get(authority_key_id)
            else:
                return None
        elif public_key is not None:
            resolved = public_key
        else:
            return None
        return _public_key(resolved)
    except Exception:
        return None


def _common_order_fields(value: Mapping[str, Any]) -> None:
    _text(value, "idempotencyKey", 500)
    _text(value, "accountId", 200)
    _equals(value, "canonicalSymbol", "BTC/USDT")
    _equals(value, "venue", "OKX")
    _equals(value, "venueInstrumentId", "BTC-USDT")
    _equals(value, "mode", "PAPER_LOCAL")
    _regex(value.get("clientOrderId"), _ORDER_ID_RE, "clientOrderId")
    _equals(value, "side", "buy")
    _equals(value, "orderType", "limit")
    _literal(value, "timeInForce", _TIME_IN_FORCE)
    if value.get("reduceOnly") is not False:
        raise ContractValidationError("reduceOnly must equal false")
    quantity = _positive_decimal(value.get("quantity"), "quantity")
    price = _positive_decimal(value.get("price"), "price")
    maximum = _positive_decimal(value.get("maxNotionalUsd"), "maxNotionalUsd")
    if Decimal(quantity) * Decimal(price) > Decimal(maximum):
        raise ContractValidationError(
            "receipt order notional exceeds the authorized maximum"
        )


def _permit_interval(value: Mapping[str, Any]) -> None:
    issued = _timestamp(value.get("permitIssuedAt"), "permitIssuedAt")
    expires = _timestamp(value.get("permitExpiresAt"), "permitExpiresAt")
    armed = _timestamp(value.get("dispatchArmedAt"), "dispatchArmedAt")
    if issued > armed or armed >= expires:
        raise ContractValidationError(
            "dispatch must be armed within the permit authority interval"
        )


def _validate_outcome_fields(
    value: Mapping[str, Any], state: str, *, label: str
) -> None:
    has_quantity, has_price = "filledQuantity" in value, "averagePrice" in value
    if state in {"partially_filled", "filled"}:
        if not has_quantity or not has_price or "simulatedOrderId" not in value:
            raise ContractValidationError(
                f"fill {label}s require quantity, price, and simulated order identity"
            )
        filled = _positive_decimal(value.get("filledQuantity"), "filledQuantity")
        _positive_decimal(value.get("averagePrice"), "averagePrice")
        if label == "receipt":
            ordered = Decimal(value["quantity"])
            average = Decimal(value["averagePrice"])
            if (
                Decimal(filled) > ordered
                or (state == "filled" and Decimal(filled) != ordered)
                or (state == "partially_filled" and Decimal(filled) >= ordered)
            ):
                raise ContractValidationError(
                    "filled quantity is inconsistent with the lifecycle kind"
                )
            if average > Decimal(value["price"]) or Decimal(filled) * average > Decimal(
                value["maxNotionalUsd"]
            ):
                raise ContractValidationError(
                    "buy-limit fill exceeds the authorized price or notional"
                )
    elif has_quantity or has_price:
        raise ContractValidationError("only fill responses may carry fill fields")
    if (
        state in {"submitted", "canceled", "expired"}
        and "simulatedOrderId" not in value
    ):
        raise ContractValidationError(f"{state} requires simulated order identity")
    if state in {"rejected", "expired", "submission_unknown"} and "reason" not in value:
        raise ContractValidationError(f"{state} requires a reason")
    if "simulatedOrderId" in value:
        _regex(
            value.get("simulatedOrderId"), _SIMULATED_ORDER_ID_RE, "simulatedOrderId"
        )
    if "reason" in value:
        _text(value, "reason", 500)


def _request_matches_receipt(
    request: Mapping[str, Any], receipt: Mapping[str, Any]
) -> bool:
    fields = (
        "sourceNamespaceId",
        "commandId",
        "payloadHash",
        "permitV2Id",
        "permitKeyId",
        "acceptedSequence",
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
        "adapterId",
        "adapterRunId",
        "adapterEpoch",
        "attemptId",
        "attemptNumber",
        "permitIssuedAt",
        "permitExpiresAt",
        "dispatchArmedAt",
    )
    return all(request[field] == receipt[field] for field in fields)


def _response_matches_receipt(
    response: Mapping[str, Any], receipt: Mapping[str, Any]
) -> bool:
    fields = (
        ("sourceNamespaceId", "sourceNamespaceId"),
        ("sourceSequence", "sourceSequence"),
        ("commandId", "commandId"),
        ("attemptId", "attemptId"),
        ("requestHash", "requestHash"),
        ("clientOrderId", "clientOrderId"),
        ("state", "lifecycleKind"),
        ("simulatorOccurredAt", "simulatorOccurredAt"),
        ("simulatedOrderId", "simulatedOrderId"),
        ("filledQuantity", "filledQuantity"),
        ("averagePrice", "averagePrice"),
        ("reason", "reason"),
    )
    return all(response.get(source) == receipt.get(target) for source, target in fields)


def _canonical_json_bytes(raw: bytes, maximum_bytes: int) -> Any:
    if not isinstance(raw, bytes) or len(raw) > maximum_bytes:
        raise ContractValidationError("canonical evidence bytes required")
    text = raw.decode("utf-8", errors="strict")
    value = json.loads(text)
    _assert_bounded_json_complexity(value)
    if stable_stringify(value) != text:
        raise ContractValidationError("canonical evidence bytes required")
    return value


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"{name} must be an object")
    return value


def _exact_keys(
    value: Mapping[str, Any],
    expected: frozenset[str] | set[str],
    *,
    optional: frozenset[str] = frozenset(),
) -> None:
    actual, expected_set = set(value), set(expected)
    if actual - expected_set or (expected_set - set(optional)) - actual:
        raise ContractValidationError("unknown or missing fields")


def _equals(value: Mapping[str, Any], field: str, expected: str) -> None:
    if value.get(field) != expected:
        raise ContractValidationError(f"{field} must equal {expected}")


def _literal(value: Mapping[str, Any], field: str, allowed: frozenset[str]) -> str:
    item = value.get(field)
    if not isinstance(item, str) or item not in allowed:
        raise ContractValidationError(f"{field} is invalid")
    return item


def _text(value: Mapping[str, Any], field: str, maximum: int) -> str:
    item = value.get(field)
    if (
        not isinstance(item, str)
        or not item
        or item != item.strip()
        or len(item.encode("utf-16-le")) // 2 > maximum
    ):
        raise ContractValidationError(f"{field} must be trimmed non-empty text")
    return item


def _regex(value: Any, pattern: re.Pattern[str], field: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ContractValidationError(f"{field} is invalid")
    return value


def _hash(value: Any, field: str) -> str:
    return _regex(value, _SHA256_RE, field)


def _positive_uint64(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or _UINT64_RE.fullmatch(value) is None
        or value == "0"
        or int(value) > _MAX_UINT64
    ):
        raise ContractValidationError(f"{field} must be a canonical positive uint64")
    return value


def _positive_decimal(value: Any, field: str) -> str:
    if (
        not isinstance(value, str)
        or _DECIMAL_RE.fullmatch(value) is None
        or value == "0"
    ):
        raise ContractValidationError(f"{field} must be a canonical positive decimal")
    integer, _, fraction = value.partition(".")
    if (
        len(integer) > _MAX_DECIMAL_INTEGER_DIGITS
        or len(fraction) > _MAX_DECIMAL_FRACTION_DIGITS
    ):
        raise ContractValidationError(f"{field} must be a canonical positive decimal")
    return value


def _assert_bounded_json_complexity(value: Any) -> None:
    pending: list[tuple[Any, int]] = [(value, 0)]
    nodes = 0
    while pending:
        current, depth = pending.pop()
        nodes += 1
        if nodes > _MAX_JSON_NODES or depth > _MAX_JSON_DEPTH:
            raise ContractValidationError("canonical JSON exceeds complexity limits")
        if isinstance(current, list):
            pending.extend((item, depth + 1) for item in current)
        elif isinstance(current, Mapping):
            pending.extend((item, depth + 1) for item in current.values())


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or _UTC_MILLISECOND_RE.fullmatch(value) is None:
        raise ContractValidationError(f"{field} must be a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractValidationError(
            f"{field} must be a canonical UTC timestamp"
        ) from error
    canonical = f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}T{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}.{parsed.microsecond // 1000:03d}Z"
    if (
        parsed.tzinfo is None
        or parsed.utcoffset() != timezone.utc.utcoffset(parsed)
        or canonical != value
    ):
        raise ContractValidationError(f"{field} must be a canonical UTC timestamp")
    return parsed


def _signature(value: Any) -> bytes:
    if not isinstance(value, str):
        raise ContractValidationError("signature is invalid")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (TypeError, ValueError) as error:
        raise ContractValidationError("signature is invalid") from error
    if len(decoded) != 64 or base64.b64encode(decoded).decode("ascii") != value:
        raise ContractValidationError("signature is invalid")
    return decoded


def _private_key(value: Ed25519PrivateKey | bytes | str) -> Ed25519PrivateKey:
    if isinstance(value, Ed25519PrivateKey):
        return value
    raw = value.encode("utf-8") if isinstance(value, str) else value
    if not isinstance(raw, bytes):
        raise TypeError("private key is invalid")
    for loader in (load_pem_private_key, load_der_private_key):
        try:
            loaded = loader(raw, password=None)
        except (TypeError, ValueError):
            continue
        if isinstance(loaded, Ed25519PrivateKey):
            return loaded
    raise ValueError("private key is invalid")


def _public_key(value: Ed25519PublicKey | bytes | str) -> Ed25519PublicKey:
    if isinstance(value, Ed25519PublicKey):
        return value
    raw = value.encode("utf-8") if isinstance(value, str) else value
    if not isinstance(raw, bytes):
        raise TypeError("public key is invalid")
    for loader in (load_pem_public_key, load_der_public_key):
        try:
            loaded = loader(raw)
        except (TypeError, ValueError):
            continue
        if isinstance(loaded, Ed25519PublicKey):
            return loaded
    raise ValueError("public key is invalid")
