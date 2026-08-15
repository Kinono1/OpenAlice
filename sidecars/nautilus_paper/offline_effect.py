"""Signed proof of one local offline-simulator source effect.

This contract is deliberately narrower than an execution receipt.  It proves
only a deterministic write in the isolated simulator source store; it is not
broker evidence and must never be treated as finalization authority.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import (
    Ed25519PrivateKey,
    Ed25519PublicKey,
)
from cryptography.hazmat.primitives.serialization import (
    load_der_private_key,
    load_pem_private_key,
)

from .contract import ContractValidationError, load_ed25519_public_key, sha256_canonical, stable_stringify
from .offline_receipt import (
    validate_offline_simulator_capability_v1,
    validate_offline_simulator_request_v1,
    validate_offline_simulator_response_v1,
)


OFFLINE_SIMULATOR_EFFECT_V1 = "openalice_offline_simulator_effect.v1"
OFFLINE_SIMULATOR_EFFECT_SCOPE = "offline_simulator_only"
OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN = "openalice:offline-simulator-effect:v1"
OFFLINE_SIMULATOR_STORE_CHAIN_DOMAIN = "openalice:offline-simulator-store-chain:v1"
MAX_OFFLINE_SIMULATOR_EFFECT_JSON_BYTES = 32_768

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_UINT64_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_ORDER_ID_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")
_SIMULATED_ORDER_ID_RE = re.compile(r"^SIM[A-Za-z0-9]{1,197}$")
_UTC_MILLISECOND_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_MAX_UINT64 = (1 << 64) - 1
_MAX_JSON_DEPTH = 16
_MAX_JSON_NODES = 512
_ZERO_HASH = "0" * 64

_CORE_KEYS = frozenset((
    "schemaVersion", "scope", "storeId", "storeSequence",
    "previousStoreChainHash", "storeChainHash", "policyHash", "capabilityId",
    "sourceAttestationKeyId", "commandId", "attemptId", "attemptAdapterEpoch",
    "sourceNamespaceId", "sourceSequence", "clientOrderId", "requestHash",
    "responseHash", "simulatedOrderId", "simulatorOccurredAt", "authorityKind",
    "writerName", "writerOwnerId", "writerEpoch",
))
_CHAIN_FIELDS = (
    "previousStoreChainHash", "storeSequence", "policyHash", "capabilityId",
    "commandId", "attemptId", "sourceNamespaceId", "sourceSequence",
    "requestHash", "responseHash",
)


@dataclass(frozen=True)
class OfflineSimulatorEffectTrustPolicy:
    """Pinned public trust root for one isolated simulator store."""

    key_id: str
    store_id: str
    public_key: Ed25519PublicKey | bytes | str


@dataclass(frozen=True)
class OfflineSimulatorEffectVerification:
    valid: bool
    reason: str
    effect: Mapping[str, Any] | None = None


def validate_offline_simulator_effect_core_v1(value: Any) -> dict[str, Any]:
    """Validate the unsigned source-effect core and its hash-chain binding."""
    core = _mapping(value, "offline simulator effect core")
    _assert_json_bounds(core)
    _exact_keys(core, _CORE_KEYS)
    _equals(core, "schemaVersion", OFFLINE_SIMULATOR_EFFECT_V1)
    _equals(core, "scope", OFFLINE_SIMULATOR_EFFECT_SCOPE)
    _hash(core.get("storeId"), "storeId")
    sequence = _positive_uint64(core.get("storeSequence"), "storeSequence")
    previous = _hash(core.get("previousStoreChainHash"), "previousStoreChainHash")
    if (sequence == "1") != (previous == _ZERO_HASH):
        raise ContractValidationError("store chain predecessor is invalid")
    _hash(core.get("storeChainHash"), "storeChainHash")
    _hash(core.get("policyHash"), "policyHash")
    _hash(core.get("capabilityId"), "capabilityId")
    _regex(core.get("sourceAttestationKeyId"), _KEY_ID_RE, "sourceAttestationKeyId")
    _hash(core.get("commandId"), "commandId")
    _hash(core.get("attemptId"), "attemptId")
    _positive_uint64(core.get("attemptAdapterEpoch"), "attemptAdapterEpoch")
    _hash(core.get("sourceNamespaceId"), "sourceNamespaceId")
    _positive_uint64(core.get("sourceSequence"), "sourceSequence")
    _regex(core.get("clientOrderId"), _ORDER_ID_RE, "clientOrderId")
    _hash(core.get("requestHash"), "requestHash")
    _hash(core.get("responseHash"), "responseHash")
    _regex(core.get("simulatedOrderId"), _SIMULATED_ORDER_ID_RE, "simulatedOrderId")
    _timestamp(core.get("simulatorOccurredAt"), "simulatorOccurredAt")
    _equals(core, "authorityKind", "original_dispatch")
    _text(core, "writerName", 200)
    _text(core, "writerOwnerId", 200)
    _positive_uint64(core.get("writerEpoch"), "writerEpoch")
    if offline_simulator_store_chain_v1_hash(core) != core["storeChainHash"]:
        raise ContractValidationError("offline_simulator_store_chain_hash_mismatch")
    return dict(core)


def offline_simulator_store_chain_v1_hash(core: Mapping[str, Any]) -> str:
    """Compute the domain-separated hash of a store-chain link."""
    value = _mapping(core, "offline simulator effect core")
    # Validate every constituent before hashing, without recursively requiring
    # the chain hash currently being calculated to be correct.
    stripped = dict(value)
    stripped["storeChainHash"] = _ZERO_HASH
    parsed = _validate_core_without_chain_hash(stripped)
    return sha256_canonical({
        "domain": OFFLINE_SIMULATOR_STORE_CHAIN_DOMAIN,
        "value": {field: parsed[field] for field in _CHAIN_FIELDS},
    })


def offline_simulator_effect_v1_id(core: Mapping[str, Any]) -> str:
    """Return the deterministic domain-separated identity of an effect core."""
    parsed = validate_offline_simulator_effect_core_v1(core)
    return sha256_canonical({"domain": OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN, "value": parsed})


def offline_simulator_effect_v1_signing_payload(effect: Mapping[str, Any]) -> str:
    """Return the exact domain-separated Ed25519 payload for an effect."""
    parsed = validate_offline_simulator_effect_v1(effect)
    core = {key: value for key, value in parsed.items() if key not in {"effectId", "signature"}}
    return f"{OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN}\0{stable_stringify({'effectId': parsed['effectId'], **core})}"


def create_offline_simulator_effect_v1(
    *, core: Any, private_key: Ed25519PrivateKey | bytes | str
) -> dict[str, Any]:
    """Create a signed local source-effect proof without I/O or network access."""
    parsed = validate_offline_simulator_effect_core_v1(core)
    effect_id = offline_simulator_effect_v1_id(parsed)
    payload = (
        f"{OFFLINE_SIMULATOR_EFFECT_ID_DOMAIN}\0"
        f"{stable_stringify({'effectId': effect_id, **parsed})}"
    ).encode("utf-8")
    return validate_offline_simulator_effect_v1({
        **parsed,
        "effectId": effect_id,
        "signature": base64.b64encode(_private_key(private_key).sign(payload)).decode("ascii"),
    })


def validate_offline_simulator_effect_v1(value: Any, *, verify_hash: bool = True) -> dict[str, Any]:
    """Strictly validate signed effect shape, identity, and canonical bounds."""
    effect = _mapping(value, "offline simulator effect")
    _assert_json_bounds(effect)
    _exact_keys(effect, _CORE_KEYS | {"effectId", "signature"})
    core = validate_offline_simulator_effect_core_v1({
        key: item for key, item in effect.items() if key not in {"effectId", "signature"}
    })
    effect_id = _hash(effect.get("effectId"), "effectId")
    _signature(effect.get("signature"))
    if verify_hash and offline_simulator_effect_v1_id(core) != effect_id:
        raise ContractValidationError("offline_simulator_effect_hash_mismatch")
    return {**core, "effectId": effect_id, "signature": effect["signature"]}


def parse_offline_simulator_effect_json_utf8(raw: bytes) -> dict[str, Any]:
    """Parse only bounded, exact canonical UTF-8 JSON effect bytes."""
    try:
        if not isinstance(raw, bytes) or len(raw) > MAX_OFFLINE_SIMULATOR_EFFECT_JSON_BYTES:
            raise ContractValidationError("effect bytes are invalid")
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(text)
        _assert_json_bounds(value)
        if stable_stringify(value) != text:
            raise ContractValidationError("effect bytes are not canonical")
        return validate_offline_simulator_effect_v1(value)
    except (ContractValidationError, TypeError, ValueError, UnicodeError):
        raise ContractValidationError("offline_simulator_effect_canonical_json_invalid") from None


def verify_offline_simulator_effect_v1(
    *, effect: Any, trust_policy: OfflineSimulatorEffectTrustPolicy
) -> OfflineSimulatorEffectVerification:
    """Verify a proof against a pinned source-attestation key and store id."""
    try:
        parsed = validate_offline_simulator_effect_v1(effect)
        if not isinstance(trust_policy, OfflineSimulatorEffectTrustPolicy):
            return OfflineSimulatorEffectVerification(False, "invalid_trust_policy")
        _regex(trust_policy.key_id, _KEY_ID_RE, "trust key id")
        _hash(trust_policy.store_id, "trust store id")
        public_key = load_ed25519_public_key(trust_policy.public_key)
    except (ContractValidationError, TypeError, ValueError):
        return OfflineSimulatorEffectVerification(False, "invalid_contract")
    if parsed["sourceAttestationKeyId"] != trust_policy.key_id:
        return OfflineSimulatorEffectVerification(False, "untrusted_source_attestation_key")
    if parsed["storeId"] != trust_policy.store_id:
        return OfflineSimulatorEffectVerification(False, "untrusted_store")
    try:
        public_key.verify(
            _signature(parsed["signature"]),
            offline_simulator_effect_v1_signing_payload(parsed).encode("utf-8"),
        )
    except InvalidSignature:
        return OfflineSimulatorEffectVerification(False, "signature_invalid")
    return OfflineSimulatorEffectVerification(True, "offline_simulator_only", parsed)


def offline_simulator_effect_v1_matches(
    effect: Any, request: Any, response: Any, capability: Any
) -> bool:
    """Return whether a source proof is exactly bound to its three inputs.

    This performs no trust-root lookup; callers must additionally use
    :func:`verify_offline_simulator_effect_v1` before relying on the proof.
    It does, however, validate all four contracts and compares every source
    proof field that is derivable from request, response, or capability.
    """
    try:
        parsed_effect = validate_offline_simulator_effect_v1(effect)
        parsed_request = validate_offline_simulator_request_v1(request)
        parsed_response = validate_offline_simulator_response_v1(response)
        parsed_capability = validate_offline_simulator_capability_v1(capability)
        expected = {
            "storeId": parsed_capability["simulatorStoreId"],
            "policyHash": parsed_capability["policyHash"],
            "capabilityId": parsed_capability["capabilityId"],
            "sourceAttestationKeyId": parsed_capability["sourceAttestationKeyId"],
            "commandId": parsed_request["commandId"],
            "attemptId": parsed_request["attemptId"],
            "attemptAdapterEpoch": parsed_request["adapterEpoch"],
            "sourceNamespaceId": parsed_request["sourceNamespaceId"],
            "sourceSequence": parsed_response["sourceSequence"],
            "clientOrderId": parsed_request["clientOrderId"],
            "requestHash": sha256_canonical(parsed_request),
            "responseHash": sha256_canonical(parsed_response),
            "simulatedOrderId": parsed_response["simulatedOrderId"],
            "simulatorOccurredAt": parsed_response["simulatorOccurredAt"],
            "authorityKind": "original_dispatch",
            "writerName": parsed_capability["writerName"],
            "writerOwnerId": parsed_capability["writerOwnerId"],
            "writerEpoch": parsed_capability["writerEpoch"],
        }
        return (
            parsed_capability["authorityKind"] == "original_dispatch"
            and parsed_response["commandId"] == expected["commandId"]
            and parsed_response["attemptId"] == expected["attemptId"]
            and parsed_response["sourceNamespaceId"] == expected["sourceNamespaceId"]
            and parsed_response["clientOrderId"] == expected["clientOrderId"]
            and parsed_response["requestHash"] == expected["requestHash"]
            and parsed_capability["commandId"] == expected["commandId"]
            and parsed_capability["attemptId"] == expected["attemptId"]
            and parsed_capability["attemptAdapterEpoch"] == expected["attemptAdapterEpoch"]
            and parsed_capability["sourceNamespaceId"] == expected["sourceNamespaceId"]
            and parsed_capability["clientOrderId"] == expected["clientOrderId"]
            and parsed_capability["requestHash"] == expected["requestHash"]
            and all(parsed_effect[field] == value for field, value in expected.items())
        )
    except (ContractValidationError, KeyError, TypeError, ValueError):
        return False


def _validate_core_without_chain_hash(value: Mapping[str, Any]) -> dict[str, Any]:
    """Validate all core constraints other than equality of its chain hash."""
    core = _mapping(value, "offline simulator effect core")
    _assert_json_bounds(core)
    _exact_keys(core, _CORE_KEYS)
    _equals(core, "schemaVersion", OFFLINE_SIMULATOR_EFFECT_V1)
    _equals(core, "scope", OFFLINE_SIMULATOR_EFFECT_SCOPE)
    _hash(core.get("storeId"), "storeId")
    sequence = _positive_uint64(core.get("storeSequence"), "storeSequence")
    previous = _hash(core.get("previousStoreChainHash"), "previousStoreChainHash")
    if (sequence == "1") != (previous == _ZERO_HASH):
        raise ContractValidationError("store chain predecessor is invalid")
    _hash(core.get("storeChainHash"), "storeChainHash")
    _hash(core.get("policyHash"), "policyHash")
    _hash(core.get("capabilityId"), "capabilityId")
    _regex(core.get("sourceAttestationKeyId"), _KEY_ID_RE, "sourceAttestationKeyId")
    _hash(core.get("commandId"), "commandId")
    _hash(core.get("attemptId"), "attemptId")
    _positive_uint64(core.get("attemptAdapterEpoch"), "attemptAdapterEpoch")
    _hash(core.get("sourceNamespaceId"), "sourceNamespaceId")
    _positive_uint64(core.get("sourceSequence"), "sourceSequence")
    _regex(core.get("clientOrderId"), _ORDER_ID_RE, "clientOrderId")
    _hash(core.get("requestHash"), "requestHash")
    _hash(core.get("responseHash"), "responseHash")
    _regex(core.get("simulatedOrderId"), _SIMULATED_ORDER_ID_RE, "simulatedOrderId")
    _timestamp(core.get("simulatorOccurredAt"), "simulatorOccurredAt")
    _equals(core, "authorityKind", "original_dispatch")
    _text(core, "writerName", 200)
    _text(core, "writerOwnerId", 200)
    _positive_uint64(core.get("writerEpoch"), "writerEpoch")
    return dict(core)


def _mapping(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"{name} must be an object")
    return value


def _exact_keys(value: Mapping[str, Any], expected: frozenset[str] | set[str]) -> None:
    if set(value) != set(expected):
        raise ContractValidationError("unknown or missing fields")


def _equals(value: Mapping[str, Any], field: str, expected: str) -> None:
    if value.get(field) != expected:
        raise ContractValidationError(f"{field} is invalid")


def _regex(value: Any, pattern: re.Pattern[str], field: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ContractValidationError(f"{field} is invalid")
    return value


def _hash(value: Any, field: str) -> str:
    return _regex(value, _SHA256_RE, field)


def _positive_uint64(value: Any, field: str) -> str:
    if not isinstance(value, str) or _UINT64_RE.fullmatch(value) is None or value == "0" or int(value) > _MAX_UINT64:
        raise ContractValidationError(f"{field} must be a canonical positive uint64")
    return value


def _text(value: Mapping[str, Any], field: str, maximum: int) -> str:
    item = value.get(field)
    if not isinstance(item, str) or not item or item != item.strip() or len(item.encode("utf-16-le")) // 2 > maximum:
        raise ContractValidationError(f"{field} must be trimmed non-empty text")
    return item


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or _UTC_MILLISECOND_RE.fullmatch(value) is None:
        raise ContractValidationError(f"{field} must be a canonical UTC timestamp")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractValidationError(f"{field} must be a canonical UTC timestamp") from error
    canonical = f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}T{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}.{parsed.microsecond // 1000:03d}Z"
    if parsed.tzinfo is None or parsed.utcoffset() != timezone.utc.utcoffset(parsed) or canonical != value:
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


def _assert_json_bounds(value: Any) -> None:
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
    if len(stable_stringify(value).encode("utf-8")) > MAX_OFFLINE_SIMULATOR_EFFECT_JSON_BYTES:
        raise ContractValidationError("effect JSON exceeds byte limit")
