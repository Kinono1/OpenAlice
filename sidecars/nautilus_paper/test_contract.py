"""Cross-language tests for the offline paper execution contract mirror."""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path

import pytest

from sidecars.nautilus_paper.contract import (
    ContractValidationError,
    build_execution_command_v1,
    build_execution_event_v1,
    derive_okx_client_order_id,
    execution_permit_v2_id,
    sha256_canonical,
    stable_stringify,
    validate_execution_command_payload_v1,
    validate_execution_event_v1,
    validate_execution_event_v2,
    validate_execution_event,
    validate_execution_permit_v2,
    verify_execution_permit_v2,
)


NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
PUBLIC_KEY_DER = bytes.fromhex(
    "302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a"
    "0ee172f3daa62325af021a68f707511a"
)
FIXTURE_PATH = Path(__file__).parents[2] / "src/sidecar/fixtures/openalice_execution_contract_v1.json"


@pytest.fixture
def golden() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def _rebind_id(permit: dict) -> dict:
    permit["permitId"] = execution_permit_v2_id({
        key: value for key, value in permit.items() if key not in {"permitId", "signature"}
    })
    return permit


def _verify(golden: dict, *, permit: object | None = None, command: object | None = None, key=True, now=NOW):
    return verify_execution_permit_v2(
        permit=golden["permit"] if permit is None else permit,
        command=golden["command"] if command is None else command,
        now=now,
        resolve_public_key=lambda _key_id: PUBLIC_KEY_DER if key else None,
    )


def test_golden_fixture_passes_byte_identical_hashing_and_ed25519(golden: dict) -> None:
    command = golden["command"]
    canonical = stable_stringify(command["payload"])
    assert canonical == stable_stringify(json.loads(canonical))
    assert sha256_canonical(command["payload"]) == command["commandId"] == command["payloadHash"]
    assert build_execution_command_v1(command["payload"]) == command
    assert validate_execution_event_v1(golden["event"]) == golden["event"]
    result = _verify(golden)
    assert result.valid is True
    assert result.reason is None


def test_hash_signature_command_scope_and_unknown_key_tampering_fail_closed(golden: dict) -> None:
    hash_tampered = deepcopy(golden["permit"])
    hash_tampered["permitId"] = "0" * 64
    assert _verify(golden, permit=hash_tampered).reason == "execution_permit_v2_hash_mismatch"

    signature_tampered = deepcopy(golden["permit"])
    signature_tampered["signature"] = "A" * 86 + "=="
    assert _verify(golden, permit=signature_tampered).reason == "invalid_signature"

    command_tampered = build_execution_command_v1({**golden["command"]["payload"], "quantity": "0.0004"})
    assert _verify(golden, command=command_tampered).reason == "command_hash_mismatch"

    scope_tampered = _rebind_id(deepcopy(golden["permit"]))
    scope_tampered["accountId"] = "different-paper-account"
    _rebind_id(scope_tampered)
    assert _verify(golden, permit=scope_tampered).reason == "permit_scope_mismatch"

    unknown_key = _rebind_id(deepcopy(golden["permit"]))
    unknown_key["keyId"] = "unknown-key"
    _rebind_id(unknown_key)
    assert _verify(golden, permit=unknown_key, key=False).reason == "unknown_key_id"


def test_expired_future_and_live_permits_fail_closed(golden: dict) -> None:
    assert _verify(golden, now=datetime(2026, 8, 15, 0, 1, tzinfo=timezone.utc)).reason == "permit_expired"
    assert _verify(golden, now=datetime(2026, 8, 14, 23, 59, tzinfo=timezone.utc)).reason == "permit_from_future"

    live = _rebind_id(deepcopy(golden["permit"]))
    live["mode"] = "LIVE"
    _rebind_id(live)
    assert _verify(golden, permit=live).valid is False


@pytest.mark.parametrize(
    "change",
    [
        {"mode": "LIVE"},
        {"clientOrderId": "bad-id"},
        {"quantity": "01.2"},
        {"quantity": "1.20"},
        {"price": "100.0"},
        {"orderType": "market", "price": "1"},
        {"orderType": "market", "quantity": "999999999", "price": "1", "maxNotionalUsd": "1"},
        {"timeInForce": "DAY"},
        {"orderType": "market", "timeInForce": "GTC"},
        {"reduceOnly": "false"},
        {"maxNotionalUsd": "1.20"},
    ],
)
def test_live_noncanonical_and_invalid_order_ids_are_rejected(golden: dict, change: dict) -> None:
    with pytest.raises(ContractValidationError):
        validate_execution_command_payload_v1({**golden["command"]["payload"], **change})


def test_limit_submit_cannot_exceed_its_signed_notional_cap(golden: dict) -> None:
    payload = {
        **golden["command"]["payload"],
        "quantity": "2",
        "price": "100",
        "maxNotionalUsd": "199",
    }
    with pytest.raises(ContractValidationError, match="maxNotionalUsd"):
        validate_execution_command_payload_v1(payload)


def test_only_btc_usdt_is_admitted_in_both_paper_modes(golden: dict) -> None:
    with pytest.raises(ContractValidationError, match="canonicalSymbol"):
        validate_execution_command_payload_v1({
            **golden["command"]["payload"],
            "mode": "PAPER_LOCAL",
            "canonicalSymbol": "ETH/USDT",
            "venueInstrumentId": "ETH-USDT",
        })


def test_permit_authority_and_economic_invariants_fail_closed(golden: dict) -> None:
    missing_notional = _rebind_id(deepcopy(golden["permit"]))
    del missing_notional["authorizedNotionalUsd"]
    _rebind_id(missing_notional)
    assert _verify(golden, permit=missing_notional).valid is False

    economic = _rebind_id(deepcopy(golden["permit"]))
    economic["riskReducing"] = True
    _rebind_id(economic)
    assert _verify(golden, permit=economic).valid is False


@pytest.mark.parametrize("authority", ("reduce", "close", "cancel"))
def test_v2_broker_permit_rejects_reduce_close_and_cancel(authority: str, golden: dict) -> None:
    permit = _rebind_id(deepcopy(golden["permit"]))
    permit["authorityAction"] = authority
    _rebind_id(permit)
    with pytest.raises(ContractValidationError, match="authorityAction"):
        validate_execution_permit_v2(permit)


def test_spot_id_determinism_and_canonical_wire_text(golden: dict) -> None:
    payload = golden["command"]["payload"]
    assert derive_okx_client_order_id(payload["idempotencyKey"]) == payload["clientOrderId"]
    for change in (
        {"clientOrderId": "OA202608150001"},
        {"venueInstrumentId": "BTC-USDT-SWAP"},
        {"issuedAt": "2026-08-15T00:00:00Z"},
    ):
        if "issuedAt" in change:
            permit = _rebind_id(deepcopy(golden["permit"]))
            permit.update(change)
            _rebind_id(permit)
            assert _verify(golden, permit=permit).valid is False
        else:
            with pytest.raises(ContractValidationError):
                validate_execution_command_payload_v1({**payload, **change})


@pytest.mark.parametrize(
    "payload",
    [
        {
            "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
            "idempotencyKey": "cancel-1", "mode": "PAPER_LOCAL", "kind": "cancel", "targetClientOrderId": "OLD1",
        },
        {
            "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
            "idempotencyKey": "replace-1", "mode": "PAPER_EXCHANGE", "kind": "replace",
            "targetClientOrderId": "OLD1", "replacementClientOrderId": derive_okx_client_order_id("replace-1"), "quantity": "2", "price": "1.5", "timeInForce": "GTC", "maxNotionalUsd": "3",
        },
        {
            "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
            "idempotencyKey": "reconcile-1", "mode": "PAPER_LOCAL", "kind": "reconcile", "afterSequence": "18446744073709551615",
        },
        {
            "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
            "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
            "idempotencyKey": "suspend-1", "mode": "PAPER_LOCAL", "kind": "suspend", "reason": "test circuit",
        },
    ],
)
def test_all_non_submit_command_kinds_are_strictly_validated(payload: dict) -> None:
    assert build_execution_command_v1(payload)["payload"] == payload


@pytest.mark.parametrize("after_sequence", ["01", "-1", "18446744073709551616", 1])
def test_reconcile_after_sequence_must_be_canonical_uint64(golden: dict, after_sequence: object) -> None:
    payload = {
        "schemaVersion": "openalice_execution_command_payload.v1", "accountId": "paper-main",
        "canonicalSymbol": "BTC/USDT", "venue": "OKX", "venueInstrumentId": "BTC-USDT",
        "idempotencyKey": "reconcile-uint64", "mode": "PAPER_LOCAL", "kind": "reconcile",
        "afterSequence": after_sequence,
    }
    with pytest.raises(ContractValidationError):
        validate_execution_command_payload_v1(payload)


def test_execution_event_hash_binds_max_uint64_sequence(golden: dict) -> None:
    event = build_execution_event_v1({
        "schemaVersion": "openalice_execution_event.v1",
        "commandId": golden["command"]["commandId"],
        "sequence": "18446744073709551615",
        "occurredAt": "2026-08-15T00:00:01.000Z",
        "kind": "submission_unknown",
        "clientOrderId": golden["command"]["payload"]["clientOrderId"],
        "reason": "broker_ack_timeout",
    })
    assert validate_execution_event_v1(event) == event
    tampered = {**event, "reason": "tampered"}
    with pytest.raises(ContractValidationError, match="event core hash"):
        validate_execution_event_v1(tampered)


def test_execution_event_v2_binds_offline_receipt_and_matches_typescript_hash(
    golden: dict,
) -> None:
    core = {
        "schemaVersion": "openalice_execution_event.v2",
        "commandId": golden["command"]["commandId"],
        "sequence": "2",
        "occurredAt": "2026-08-15T00:00:01.000Z",
        "kind": "submitted",
        "clientOrderId": derive_okx_client_order_id("intent-1"),
        "venueOrderId": "SIM0123456789ABCDEF",
        "evidenceSchemaVersion": "openalice_offline_execution_receipt.v1",
        "evidenceReceiptId": "b" * 64,
    }
    event = validate_execution_event_v2(
        {**core, "eventId": sha256_canonical(core)}
    )
    assert validate_execution_event_v2(event) == event
    assert validate_execution_event(event) == event
    assert event["eventId"] == (
        "9fcd55d1c093ea16d2d7bc7d956673901bf3dc9f076c2e7c1f09993e0fc29171"
    )
    with pytest.raises(ContractValidationError, match="event core hash"):
        validate_execution_event_v2({**event, "evidenceReceiptId": "c" * 64})
    with pytest.raises(ContractValidationError):
        validate_execution_event_v1(event)
    with pytest.raises(ContractValidationError, match="reason"):
        invalid_core = {
            "schemaVersion": "openalice_execution_event.v2",
            "commandId": golden["command"]["commandId"],
            "sequence": "3",
            "occurredAt": "2026-08-15T00:00:01.000Z",
            "kind": "rejected",
            "clientOrderId": derive_okx_client_order_id("intent-1"),
            "evidenceSchemaVersion": "openalice_offline_execution_receipt.v1",
            "evidenceReceiptId": "b" * 64,
        }
        validate_execution_event_v2(
            {**invalid_core, "eventId": sha256_canonical(invalid_core)}
        )


@pytest.mark.parametrize(
    "event",
    [
        {"sequence": "0", "kind": "acknowledged"},
        {"sequence": "18446744073709551616", "kind": "acknowledged"},
        {"sequence": "1", "kind": "filled", "filledQuantity": "1"},
        {"sequence": "1", "kind": "acknowledged", "filledQuantity": "1", "averagePrice": "2"},
        {"sequence": "1", "kind": "drift"},
        {"sequence": "1", "kind": "rejected", "reason": " noncanonical"},
    ],
)
def test_execution_event_rejects_invalid_lifecycle_fields(golden: dict, event: dict) -> None:
    core = {
        "schemaVersion": "openalice_execution_event.v1",
        "commandId": golden["command"]["commandId"],
        "sequence": "1",
        "occurredAt": "2026-08-15T00:00:01.000Z",
        "kind": "acknowledged",
        **event,
    }
    with pytest.raises(ContractValidationError):
        build_execution_event_v1(core)
