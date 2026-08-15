"""Owner-thread orchestration for isolated offline paper execution.

This module deliberately contains only the durable recovery state machine.  It
does not know about runtime processes, transports, brokers, credentials, or
Nautilus.  The ledger owns durable authority and the simulator owns the sole
source-effect mutation.
"""

from __future__ import annotations

from dataclasses import dataclass
from threading import get_ident
from typing import Any, Literal

from .contract import load_ed25519_public_key
from .ledger import (
    Lease,
    OfflineDispatchUnavailable,
    OfflineExecutionReceipt,
)


@dataclass(frozen=True)
class OfflineExecutionOutcome:
    """The result of one idempotent execution/recovery decision."""

    state: Literal["RECEIPT_COMMITTED", "RECONCILIATION_REQUIRED"]
    receipt: OfflineExecutionReceipt | None
    source_created: bool
    recovered: bool


class OfflineExecutionCoordinator:
    """Execute or recover exactly one ledger-bound offline dispatch.

    Instances are deliberately single-thread objects.  They snapshot both
    public trust roots at construction and accept no call-level clocks, keys,
    stores, or policy resolvers.  Exceptions from either durable authority or
    simulator integrity checks intentionally propagate unchanged: callers must
    restart with a new coordinator and let durable state select recovery.
    """

    def __init__(
        self,
        ledger: Any,
        simulator: Any,
        *,
        writer_lease: Lease | None,
        permit_public_key: Any,
        receipt_public_key: Any,
    ) -> None:
        self._ledger = ledger
        self._simulator = simulator
        self._writer_lease = writer_lease
        self._owner_thread_id = get_ident()
        # Convert once so later caller mutation cannot swap a trust root.
        try:
            self._permit_public_key = load_ed25519_public_key(permit_public_key)
            self._receipt_public_key = load_ed25519_public_key(receipt_public_key)
        except Exception:
            raise ValueError("offline execution public key is invalid") from None

    def _assert_owner_thread(self) -> None:
        if get_ident() != self._owner_thread_id:
            raise RuntimeError("OfflineExecutionCoordinator is owner-thread-only")

    def _lease(self) -> Lease:
        if self._writer_lease is None:
            raise OfflineDispatchUnavailable("offline execution writer lease is not bound")
        return self._writer_lease

    def bind_writer_lease(self, lease: Lease) -> None:
        """Replace the current fenced lease from the coordinator owner thread."""
        self._assert_owner_thread()
        if not isinstance(lease, Lease):
            raise TypeError("lease must be a Ledger Lease")
        self._writer_lease = lease

    def execute_or_recover(self, command_hash: str) -> OfflineExecutionOutcome:
        """Run the strict durable state machine for one command hash.

        No catch-and-retry policy belongs here.  After an exception the caller
        must create a fresh coordinator (normally with a freshly acquired
        lease); the following call will inspect the durable state first.
        """
        self._assert_owner_thread()
        lease = self._lease()
        dispatch = self._ledger.get_execution_dispatch(
            command_hash, receipt_public_key=self._receipt_public_key
        )
        if dispatch is None:
            raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")

        if dispatch.state == "RECEIPT_COMMITTED":
            assert dispatch.receipt_head_id is not None
            receipt = self._ledger.get_offline_execution_receipt(
                dispatch.receipt_head_id, receipt_public_key=self._receipt_public_key
            )
            if receipt is None:
                # get_execution_dispatch has already checked this, but retain
                # the fail-closed boundary if a broken ledger implementation is
                # supplied to the coordinator.
                raise OfflineDispatchUnavailable("committed offline receipt is unavailable")
            return OfflineExecutionOutcome(
                "RECEIPT_COMMITTED", receipt, source_created=False, recovered=True
            )

        if dispatch.state == "DISPATCH_PENDING":
            attempt = self._ledger.claim_offline_dispatch(
                command_hash=command_hash,
                writer_lease=lease,
                permit_public_key=self._permit_public_key,
            )
            return self._execute_original(command_hash, attempt, lease)

        if dispatch.state == "IN_FLIGHT":
            assert dispatch.original_attempt_id is not None
            attempt = self._ledger.get_offline_execution_attempt(
                dispatch.original_attempt_id
            )
            if attempt is None:
                raise OfflineDispatchUnavailable("in-flight offline attempt is unavailable")
            found = self._simulator.lookup_exact(attempt.request)
            if found is not None:
                if attempt.adapter_epoch == str(lease.epoch):
                    receipt = self._commit(command_hash, found, lease)
                else:
                    self._ledger.mark_reconciliation_required(
                        command_hash=command_hash, writer_lease=lease
                    )
                    claim = self._ledger.claim_offline_reconciliation(
                        command_hash=command_hash, writer_lease=lease
                    )
                    receipt = self._commit(
                        command_hash, found, lease, reconciliation_claim_id=claim.claim_id
                    )
                return OfflineExecutionOutcome(
                    "RECEIPT_COMMITTED", receipt, source_created=False, recovered=True
                )
            if attempt.adapter_epoch != str(lease.epoch):
                self._ledger.mark_reconciliation_required(
                    command_hash=command_hash, writer_lease=lease
                )
                return OfflineExecutionOutcome(
                    "RECONCILIATION_REQUIRED", None, source_created=False, recovered=True
                )
            return self._execute_original(command_hash, attempt, lease)

        if dispatch.state == "RECONCILIATION_REQUIRED":
            assert dispatch.original_attempt_id is not None
            attempt = self._ledger.get_offline_execution_attempt(
                dispatch.original_attempt_id
            )
            if attempt is None:
                raise OfflineDispatchUnavailable("reconciliation offline attempt is unavailable")
            found = self._simulator.lookup_exact(attempt.request)
            if found is None:
                return OfflineExecutionOutcome(
                    "RECONCILIATION_REQUIRED", None, source_created=False, recovered=True
                )
            claim = self._ledger.claim_offline_reconciliation(
                command_hash=command_hash, writer_lease=lease
            )
            receipt = self._commit(
                command_hash, found, lease, reconciliation_claim_id=claim.claim_id
            )
            return OfflineExecutionOutcome(
                "RECEIPT_COMMITTED", receipt, source_created=False, recovered=True
            )

        raise OfflineDispatchUnavailable(
            f"offline dispatch state {dispatch.state} is not executable"
        )

    def _execute_original(self, command_hash: str, attempt: Any, lease: Lease) -> OfflineExecutionOutcome:
        """Issue the immutable original capability, source effect, then receipt."""
        capability = self._ledger.issue_offline_simulator_capability(
            command_hash=command_hash, writer_lease=lease
        )
        result = self._simulator.ensure_exact(
            attempt.request,
            canonical_capability_json_utf8=capability.capability_json.encode("utf-8"),
        )
        receipt = self._commit(command_hash, result, lease)
        return OfflineExecutionOutcome(
            "RECEIPT_COMMITTED",
            receipt,
            source_created=result.created,
            recovered=not result.created,
        )

    def _commit(
        self,
        command_hash: str,
        result: Any,
        lease: Lease,
        *,
        reconciliation_claim_id: str | None = None,
    ) -> OfflineExecutionReceipt:
        return self._ledger.commit_offline_execution_receipt(
            command_hash=command_hash,
            canonical_response_json_utf8=result.canonical_response_json_utf8,
            canonical_source_effect_json_utf8=result.canonical_effect_json_utf8,
            writer_lease=lease,
            reconciliation_claim_id=reconciliation_claim_id,
        )
