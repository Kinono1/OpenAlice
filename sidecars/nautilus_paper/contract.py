"""Offline, fail-closed mirror of OpenAlice's paper execution contract."""

from __future__ import annotations

import base64
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from decimal import Decimal
from datetime import datetime, timezone
import hashlib
import json
import math
import re
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from cryptography.hazmat.primitives.serialization import load_der_public_key, load_pem_public_key

EXECUTION_COMMAND_PAYLOAD_V1 = "openalice_execution_command_payload.v1"
EXECUTION_COMMAND_V1 = "openalice_execution_command.v1"
EXECUTION_PERMIT_V2 = "openalice_execution_permit.v2"
EXECUTION_EVENT_V1 = "openalice_execution_event.v1"
EXECUTION_EVENT_V2 = "openalice_execution_event.v2"
OFFLINE_EXECUTION_RECEIPT_EVIDENCE_V1 = "openalice_offline_execution_receipt.v1"
_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_COMMIT_RE = re.compile(r"^[a-f0-9]{40}$")
_ORDER_ID_RE = re.compile(r"^[A-Za-z0-9]{1,32}$")
_DECIMAL_RE = re.compile(r"^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
_UINT_RE = re.compile(r"^(?:0|[1-9][0-9]*)$")
_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")
_ISO_UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_MODES = frozenset(("PAPER_LOCAL", "PAPER_EXCHANGE"))
_KINDS = frozenset(("submit", "cancel", "replace", "reconcile", "suspend"))
_TIME_IN_FORCE = frozenset(("GTC", "IOC", "FOK"))
_EVENT_KINDS = frozenset((
    "acknowledged", "submitted", "partially_filled", "filled", "canceled",
    "rejected", "expired", "submission_unknown", "reconciled", "drift", "suspended",
))
_FILL_EVENT_KINDS = frozenset(("partially_filled", "filled"))
_REASON_EVENT_KINDS = frozenset(("rejected", "expired", "submission_unknown", "drift", "suspended"))
_ADAPTER_EVENT_KINDS = frozenset((
    "submitted", "partially_filled", "filled", "canceled", "rejected",
    "expired", "submission_unknown",
))


class ContractValidationError(ValueError):
    """Input violates the strict paper execution contract."""


@dataclass(frozen=True)
class PermitVerification:
    valid: bool
    reason: str | None = None
    permit: Mapping[str, Any] | None = None
    command: Mapping[str, Any] | None = None


def stable_stringify(value: Any) -> str:
    """TS-compatible canonical JSON (UTF-8, sorted keys, no whitespace)."""
    if value is None or isinstance(value, (bool, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9_007_199_254_740_991:
            raise ContractValidationError("integer outside JavaScript safe range")
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractValidationError("non-finite number in contract")
        if value == 0:
            return "0"
        rendered = json.dumps(value, ensure_ascii=False, allow_nan=False)
        if "e" in rendered:
            mantissa, exponent = rendered.split("e")
            rendered = f"{mantissa}e{int(exponent)}"
        return rendered
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_stringify(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise ContractValidationError("contract object keys must be strings")
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False, separators=(',', ':'))}:{stable_stringify(value[key])}"
            for key in sorted(value)
        ) + "}"
    raise ContractValidationError(f"unsupported contract value: {type(value).__name__}")


def sha256_canonical(value: Any) -> str:
    return hashlib.sha256(stable_stringify(value).encode("utf-8")).hexdigest()


def derive_okx_client_order_id(idempotency_key: str) -> str:
    """Return the exact deterministic, punctuation-free OKX client identifier."""
    if not isinstance(idempotency_key, str) or not idempotency_key or idempotency_key != idempotency_key.strip() or len(idempotency_key) > 500:
        raise ContractValidationError("idempotencyKey must be trimmed non-empty text")
    digest = hashlib.sha256(
        f"openalice:okx-client-order-id:v1:{idempotency_key}".encode("utf-8")
    ).hexdigest()[:30].upper()
    return f"OA{digest}"


def validate_execution_command_payload_v1(input_value: Any) -> dict[str, Any]:
    value = _object(input_value, "payload")
    kind = _literal(value, "kind", _KINDS)
    base = {"schemaVersion", "accountId", "canonicalSymbol", "venue", "venueInstrumentId", "idempotencyKey", "mode", "kind"}
    _equals(value, "schemaVersion", EXECUTION_COMMAND_PAYLOAD_V1)
    _text(value, "accountId", 200)
    _equals(value, "canonicalSymbol", "BTC/USDT")
    _equals(value, "venue", "OKX")
    _equals(value, "venueInstrumentId", "BTC-USDT")
    idempotency_key = _text(value, "idempotencyKey", 500)
    _literal(value, "mode", _MODES)
    if kind == "submit":
        _keys(value, base | {"clientOrderId", "side", "orderType", "quantity", "price", "timeInForce", "reduceOnly", "maxNotionalUsd"})
        if _order_id(value, "clientOrderId") != derive_okx_client_order_id(idempotency_key):
            raise ContractValidationError("submit clientOrderId must be deterministically derived from idempotencyKey")
        _literal(value, "side", frozenset(("buy", "sell")))
        _equals(value, "orderType", "limit")
        _literal(value, "timeInForce", _TIME_IN_FORCE)
        quantity = _decimal(value, "quantity")
        price = _decimal(value, "price")
        _bool(value, "reduceOnly")
        maximum_notional = _decimal(value, "maxNotionalUsd")
        if Decimal(quantity) * Decimal(price) > Decimal(maximum_notional):
            raise ContractValidationError("limit submit exceeds maxNotionalUsd; market orders are not supported")
    elif kind == "cancel":
        _keys(value, base | {"targetClientOrderId"})
        _order_id(value, "targetClientOrderId")
    elif kind == "replace":
        _keys(value, base | {"targetClientOrderId", "replacementClientOrderId", "quantity", "price", "timeInForce", "maxNotionalUsd"})
        target = _order_id(value, "targetClientOrderId")
        replacement = _order_id(value, "replacementClientOrderId")
        if target == replacement:
            raise ContractValidationError("replace requires a new client order id")
        if replacement != derive_okx_client_order_id(idempotency_key):
            raise ContractValidationError("replacementClientOrderId must be deterministically derived from idempotencyKey")
        quantity = _decimal(value, "quantity")
        price = _decimal(value, "price")
        maximum_notional = _decimal(value, "maxNotionalUsd")
        _literal(value, "timeInForce", _TIME_IN_FORCE)
        if Decimal(quantity) * Decimal(price) > Decimal(maximum_notional):
            raise ContractValidationError("replacement exceeds maxNotionalUsd")
    elif kind == "reconcile":
        _keys(value, base | {"afterSequence"}, optional={"afterSequence"})
        if "afterSequence" in value:
            _uint64(value["afterSequence"], "afterSequence")
    else:
        _keys(value, base | {"reason"})
        _text(value, "reason", 500)
    return dict(value)


def build_execution_command_v1(payload: Any) -> dict[str, Any]:
    parsed = validate_execution_command_payload_v1(payload)
    digest = sha256_canonical(parsed)
    return {"schemaVersion": EXECUTION_COMMAND_V1, "commandId": digest, "payloadHash": digest, "payload": parsed}


def validate_execution_command_v1(input_value: Any) -> dict[str, Any]:
    value = _object(input_value, "command")
    _keys(value, {"schemaVersion", "commandId", "payloadHash", "payload"})
    _equals(value, "schemaVersion", EXECUTION_COMMAND_V1)
    command_id = _hash(value.get("commandId"), "commandId")
    payload_hash = _hash(value.get("payloadHash"), "payloadHash")
    payload = validate_execution_command_payload_v1(value.get("payload"))
    if command_id != sha256_canonical(payload) or payload_hash != command_id:
        raise ContractValidationError("command id must equal payload hash")
    return {**value, "payload": payload}


def build_execution_event_v1(input_value: Any) -> dict[str, Any]:
    """Build an event whose ID hashes every event-core field."""
    core = _validate_execution_event_core_v1(input_value)
    return {**core, "eventId": sha256_canonical(core)}


def validate_execution_event_v1(input_value: Any) -> dict[str, Any]:
    """Strictly validate a hash-bound paper execution lifecycle event."""
    value = _object(input_value, "event")
    expected = {
        "schemaVersion", "eventId", "commandId", "sequence", "occurredAt", "kind",
        "clientOrderId", "venueOrderId", "filledQuantity", "averagePrice", "reason",
    }
    _keys(value, expected, optional={"clientOrderId", "venueOrderId", "filledQuantity", "averagePrice", "reason"})
    event_id = _hash(value.get("eventId"), "eventId")
    core = {key: item for key, item in value.items() if key != "eventId"}
    parsed_core = _validate_execution_event_core_v1(core)
    if sha256_canonical(parsed_core) != event_id:
        raise ContractValidationError("event id must equal the event core hash")
    return {**parsed_core, "eventId": event_id}


def validate_execution_event_v2(input_value: Any) -> dict[str, Any]:
    """Validate V2 wire structure; receipt semantics require the receipt binder."""
    value = _object(input_value, "event")
    expected = {
        "schemaVersion", "eventId", "commandId", "sequence", "occurredAt", "kind",
        "clientOrderId", "venueOrderId", "filledQuantity", "averagePrice", "reason",
        "evidenceSchemaVersion", "evidenceReceiptId",
    }
    _keys(
        value,
        expected,
        optional={"venueOrderId", "filledQuantity", "averagePrice", "reason"},
    )
    event_id = _hash(value.get("eventId"), "eventId")
    core = {key: item for key, item in value.items() if key != "eventId"}
    parsed_core = _validate_execution_event_core_v2(core)
    if sha256_canonical(parsed_core) != event_id:
        raise ContractValidationError("event id must equal the event core hash")
    return {**parsed_core, "eventId": event_id}


def validate_execution_event(input_value: Any) -> dict[str, Any]:
    """Validate exactly one supported lifecycle schema without source upgrade."""
    value = _object(input_value, "event")
    schema_version = value.get("schemaVersion")
    if schema_version == EXECUTION_EVENT_V1:
        return validate_execution_event_v1(value)
    if schema_version == EXECUTION_EVENT_V2:
        return validate_execution_event_v2(value)
    raise ContractValidationError("unsupported execution event schema")


def _validate_execution_event_core_v2(input_value: Any) -> dict[str, Any]:
    value = _object(input_value, "event")
    expected = {
        "schemaVersion", "commandId", "sequence", "occurredAt", "kind",
        "clientOrderId", "venueOrderId", "filledQuantity", "averagePrice", "reason",
        "evidenceSchemaVersion", "evidenceReceiptId",
    }
    _keys(
        value,
        expected,
        optional={"venueOrderId", "filledQuantity", "averagePrice", "reason"},
    )
    _equals(value, "schemaVersion", EXECUTION_EVENT_V2)
    _hash(value.get("commandId"), "commandId")
    _uint64(value.get("sequence"), "sequence", positive=True)
    _timestamp(value.get("occurredAt"), "occurredAt")
    kind = _literal(value, "kind", _ADAPTER_EVENT_KINDS)
    _order_id(value, "clientOrderId")
    if "venueOrderId" in value:
        _text(value, "venueOrderId", 200)
    has_quantity = "filledQuantity" in value
    has_price = "averagePrice" in value
    if kind in _FILL_EVENT_KINDS:
        if not has_quantity or not has_price:
            raise ContractValidationError("fill events require quantity and price")
        _decimal(value, "filledQuantity")
        _decimal(value, "averagePrice")
    elif has_quantity or has_price:
        raise ContractValidationError("only fill events may carry fill fields")
    if kind in {"submitted", "partially_filled", "filled", "canceled", "expired"}:
        if "venueOrderId" not in value:
            raise ContractValidationError(f"{kind} requires source order identity")
    if kind in {"rejected", "expired", "submission_unknown"} and "reason" not in value:
        raise ContractValidationError(f"{kind} events require a reason")
    if "reason" in value:
        _text(value, "reason", 500)
    _equals(
        value,
        "evidenceSchemaVersion",
        OFFLINE_EXECUTION_RECEIPT_EVIDENCE_V1,
    )
    _hash(value.get("evidenceReceiptId"), "evidenceReceiptId")
    return dict(value)


def _validate_execution_event_core_v1(input_value: Any) -> dict[str, Any]:
    value = _object(input_value, "event")
    expected = {
        "schemaVersion", "commandId", "sequence", "occurredAt", "kind", "clientOrderId",
        "venueOrderId", "filledQuantity", "averagePrice", "reason",
    }
    _keys(value, expected, optional={"clientOrderId", "venueOrderId", "filledQuantity", "averagePrice", "reason"})
    _equals(value, "schemaVersion", EXECUTION_EVENT_V1)
    _hash(value.get("commandId"), "commandId")
    _uint64(value.get("sequence"), "sequence", positive=True)
    _timestamp(value.get("occurredAt"), "occurredAt")
    kind = _literal(value, "kind", _EVENT_KINDS)
    if "clientOrderId" in value:
        _order_id(value, "clientOrderId")
    if "venueOrderId" in value:
        _text(value, "venueOrderId", 200)
    has_quantity, has_price = "filledQuantity" in value, "averagePrice" in value
    if kind in _FILL_EVENT_KINDS:
        if not has_quantity or not has_price:
            raise ContractValidationError("fill events require quantity and price")
        _decimal(value, "filledQuantity")
        _decimal(value, "averagePrice")
    elif has_quantity or has_price:
        raise ContractValidationError("only fill events may carry fill fields")
    if kind in _REASON_EVENT_KINDS and "reason" not in value:
        raise ContractValidationError(f"{kind} events require a reason")
    if "reason" in value:
        _text(value, "reason", 500)
    return dict(value)


def execution_permit_v2_id(core: Mapping[str, Any]) -> str:
    return sha256_canonical(core)


def validate_execution_permit_v2(input_value: Any) -> dict[str, Any]:
    value = _object(input_value, "permit")
    keys = {"schemaVersion", "permitId", "decisionId", "candidateId", "intentId", "ticketId", "commandHash", "action", "authorityAction", "riskReducing", "scope", "accountId", "canonicalSymbol", "venueInstrumentId", "idempotencyKey", "side", "authorizedNotionalUsd", "mode", "sourceCommit", "releaseManifestHash", "authoritySnapshotHash", "requiredChecks", "approvalRefs", "issuedAt", "expiresAt", "keyId", "signature"}
    _keys(value, keys)
    _equals(value, "schemaVersion", EXECUTION_PERMIT_V2)
    _hash(value.get("permitId"), "permitId")
    _hash(value.get("decisionId"), "decisionId")
    _nullable_text(value, "candidateId", 300)
    _text(value, "intentId", 300)
    _text(value, "ticketId", 300)
    _hash(value.get("commandHash"), "commandHash")
    _equals(value, "action", "submit")
    _equals(value, "authorityAction", "open")
    if value.get("riskReducing") is not False:
        raise ContractValidationError("riskReducing must equal False")
    _equals(value, "scope", "paper_only")
    _text(value, "accountId", 200)
    _equals(value, "canonicalSymbol", "BTC/USDT")
    _equals(value, "venueInstrumentId", "BTC-USDT")
    _text(value, "idempotencyKey", 500)
    _equals(value, "side", "buy")
    _decimal(value, "authorizedNotionalUsd")
    _literal(value, "mode", _MODES)
    _regex(value.get("sourceCommit"), _COMMIT_RE, "sourceCommit")
    _hash(value.get("releaseManifestHash"), "releaseManifestHash")
    _hash(value.get("authoritySnapshotHash"), "authoritySnapshotHash")
    _text_array(value, "requiredChecks", 200)
    _text_array(value, "approvalRefs", 500)
    issued = _timestamp(value.get("issuedAt"), "issuedAt")
    expires = _timestamp(value.get("expiresAt"), "expiresAt")
    if expires <= issued:
        raise ContractValidationError("expiresAt must be later than issuedAt")
    _regex(value.get("keyId"), _KEY_ID_RE, "keyId")
    _signature(value.get("signature"))
    if execution_permit_v2_id(_core(value)) != value["permitId"]:
        raise ContractValidationError("execution_permit_v2_hash_mismatch")
    return dict(value)


def execution_permit_v2_signing_payload(permit: Mapping[str, Any]) -> str:
    return stable_stringify({"permitId": permit["permitId"], **_core(permit)})


def verify_execution_permit_v2(*, permit: Any, command: Any, resolve_public_key: Callable[[str], Ed25519PublicKey | bytes | str | None], now: datetime | None = None, max_ttl_ms: int = 60_000, max_future_ms: int = 30_000) -> PermitVerification:
    """Fail closed on every structural, binding, temporal, key, or signature error."""
    try:
        parsed_permit = validate_execution_permit_v2(permit)
        parsed_command = validate_execution_command_v1(command)
    except (ContractValidationError, KeyError, TypeError) as error:
        return PermitVerification(False, str(error) or "invalid_contract")
    payload = parsed_command["payload"]
    if parsed_permit["commandHash"] != parsed_command["commandId"]:
        return PermitVerification(False, "command_hash_mismatch")
    if parsed_permit["action"] != payload["kind"]:
        return PermitVerification(False, "permit_action_mismatch")
    if any(parsed_permit[field] != payload[field] for field in ("accountId", "canonicalSymbol", "venueInstrumentId", "idempotencyKey", "mode")):
        return PermitVerification(False, "permit_scope_mismatch")
    if payload["kind"] == "submit" and (
        parsed_permit.get("side") != payload["side"]
        or parsed_permit["riskReducing"] != payload["reduceOnly"]
        or parsed_permit.get("authorizedNotionalUsd") != payload["maxNotionalUsd"]
    ):
        return PermitVerification(False, "permit_economic_scope_mismatch")
    reference = _now(now)
    issued, expires = _timestamp(parsed_permit["issuedAt"], "issuedAt"), _timestamp(parsed_permit["expiresAt"], "expiresAt")
    if issued.timestamp() * 1000 > reference.timestamp() * 1000 + max_future_ms:
        return PermitVerification(False, "permit_from_future")
    if expires <= reference:
        return PermitVerification(False, "permit_expired")
    if (expires - issued).total_seconds() * 1000 > max_ttl_ms:
        return PermitVerification(False, "permit_ttl_exceeded")
    try:
        resolved = resolve_public_key(parsed_permit["keyId"])
    except Exception:
        return PermitVerification(False, "invalid_public_key")
    if resolved is None:
        return PermitVerification(False, "unknown_key_id")
    try:
        public_key = _public_key(resolved)
    except (TypeError, ValueError):
        return PermitVerification(False, "invalid_public_key")
    try:
        public_key.verify(_signature(parsed_permit["signature"]), execution_permit_v2_signing_payload(parsed_permit).encode("utf-8"))
    except InvalidSignature:
        return PermitVerification(False, "invalid_signature")
    return PermitVerification(True, permit=parsed_permit, command=parsed_command)


def _object(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ContractValidationError(f"{name} must be an object")
    return value


def _keys(value: Mapping[str, Any], expected: set[str], *, optional: set[str] | None = None) -> None:
    optional = optional or set()
    actual = set(value)
    if actual - expected or (expected - optional) - actual:
        raise ContractValidationError("unknown or missing fields")


def _literal(value: Mapping[str, Any], field: str, allowed: frozenset[str]) -> str:
    item = value.get(field)
    if not isinstance(item, str) or item not in allowed:
        raise ContractValidationError(f"{field} is invalid")
    return item


def _equals(value: Mapping[str, Any], field: str, expected: str) -> None:
    if value.get(field) != expected:
        raise ContractValidationError(f"{field} must equal {expected}")


def _text(value: Mapping[str, Any], field: str, maximum: int) -> str:
    item = value.get(field)
    if not isinstance(item, str) or item != item.strip() or not item or len(item) > maximum:
        raise ContractValidationError(f"{field} must be trimmed non-empty text")
    return item


def _nullable_text(value: Mapping[str, Any], field: str, maximum: int) -> str | None:
    if value.get(field) is None:
        return None
    return _text(value, field, maximum)


def _text_array(value: Mapping[str, Any], field: str, maximum: int) -> list[str]:
    items = value.get(field)
    if not isinstance(items, list):
        raise ContractValidationError(f"{field} must be an array")
    for index, item in enumerate(items):
        if not isinstance(item, str) or item != item.strip() or not item or len(item) > maximum:
            raise ContractValidationError(f"{field}[{index}] must be trimmed non-empty text")
    return items


def _regex(value: Any, pattern: re.Pattern[str], field: str) -> str:
    if not isinstance(value, str) or pattern.fullmatch(value) is None:
        raise ContractValidationError(f"{field} is invalid")
    return value


def _hash(value: Any, field: str) -> str:
    return _regex(value, _SHA256_RE, field)


def _order_id(value: Mapping[str, Any], field: str) -> str:
    return _regex(value.get(field), _ORDER_ID_RE, field)


def _decimal(value: Mapping[str, Any], field: str) -> str:
    item = value.get(field)
    if not isinstance(item, str) or _DECIMAL_RE.fullmatch(item) is None or item == "0":
        raise ContractValidationError(f"{field} must be a canonical positive decimal string")
    return item


def _uint64(value: Any, field: str, *, positive: bool = False) -> str:
    if not isinstance(value, str) or _UINT_RE.fullmatch(value) is None:
        raise ContractValidationError(f"{field} must be a canonical uint64 decimal string")
    if int(value) > 18_446_744_073_709_551_615 or (positive and value == "0"):
        raise ContractValidationError(f"{field} is outside its allowed uint64 range")
    return value


def _bool(value: Mapping[str, Any], field: str) -> bool:
    item = value.get(field)
    if not isinstance(item, bool):
        raise ContractValidationError(f"{field} must be boolean")
    return item


def _timestamp(value: Any, field: str) -> datetime:
    if not isinstance(value, str) or _ISO_UTC_RE.fullmatch(value) is None:
        raise ContractValidationError(f"{field} must be an ISO UTC datetime")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ContractValidationError(f"{field} must be an ISO UTC datetime") from error
    canonical = (
        f"{parsed.year:04d}-{parsed.month:02d}-{parsed.day:02d}T"
        f"{parsed.hour:02d}:{parsed.minute:02d}:{parsed.second:02d}."
        f"{parsed.microsecond // 1000:03d}Z"
    )
    if canonical != value:
        raise ContractValidationError(f"{field} must be an ISO UTC datetime")
    return parsed


def _signature(value: Any) -> bytes:
    if not isinstance(value, str):
        raise ContractValidationError("signature is invalid")
    try:
        decoded = base64.b64decode(value, validate=True)
    except (TypeError, ValueError) as error:
        raise ContractValidationError("signature is invalid") from error
    if len(decoded) != 64 or base64.b64encode(decoded).decode("ascii") != value:
        raise ContractValidationError("Ed25519 signature must be 64 bytes")
    return decoded


def _core(permit: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in permit.items() if key not in {"permitId", "signature"}}


def _now(value: datetime | None) -> datetime:
    if value is None:
        return datetime.now(timezone.utc)
    if value.tzinfo is None:
        raise ContractValidationError("now must be timezone-aware")
    return value.astimezone(timezone.utc)


def _public_key(value: Ed25519PublicKey | bytes | str) -> Ed25519PublicKey:
    if isinstance(value, Ed25519PublicKey):
        return value
    raw = value.encode("ascii") if isinstance(value, str) else value
    if not isinstance(raw, bytes):
        raise TypeError("public key must be Ed25519, bytes, or text")
    if len(raw) == 32:
        return Ed25519PublicKey.from_public_bytes(raw)
    loaded = load_pem_public_key(raw) if raw.startswith(b"-----BEGIN") else load_der_public_key(raw)
    if not isinstance(loaded, Ed25519PublicKey):
        raise ValueError("public key is not Ed25519")
    return loaded


def load_ed25519_public_key(value: Ed25519PublicKey | bytes | str) -> Ed25519PublicKey:
    """Parse a configured public key and require the Ed25519 algorithm."""
    return _public_key(value)
