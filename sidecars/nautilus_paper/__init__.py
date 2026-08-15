"""Durable, fail-closed persistence primitives for the OpenAlice Nautilus paper sidecar.

This package deliberately contains no network, broker, or Nautilus dependencies.
"""

from .ledger import (
    Command,
    CommandReceipt,
    Event,
    IdempotencyConflict,
    Ledger,
    Lease,
    LeaseRejected,
    RuntimeSuspended,
    StaleLease,
)
from .contract import (
    ContractValidationError,
    PermitVerification,
    build_execution_command_v1,
    build_execution_event_v1,
    derive_okx_client_order_id,
    execution_permit_v2_id,
    execution_permit_v2_signing_payload,
    sha256_canonical,
    stable_stringify,
    validate_execution_command_payload_v1,
    validate_execution_command_v1,
    validate_execution_event_v1,
    validate_execution_permit_v2,
    verify_execution_permit_v2,
)

__all__ = [
    "Command",
    "CommandReceipt",
    "Event",
    "IdempotencyConflict",
    "Ledger",
    "Lease",
    "LeaseRejected",
    "RuntimeSuspended",
    "StaleLease",
    "ContractValidationError",
    "PermitVerification",
    "build_execution_command_v1",
    "build_execution_event_v1",
    "derive_okx_client_order_id",
    "execution_permit_v2_id",
    "execution_permit_v2_signing_payload",
    "sha256_canonical",
    "stable_stringify",
    "validate_execution_command_payload_v1",
    "validate_execution_command_v1",
    "validate_execution_event_v1",
    "validate_execution_permit_v2",
    "verify_execution_permit_v2",
]
