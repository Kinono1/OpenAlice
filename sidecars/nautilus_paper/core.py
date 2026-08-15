"""Offline, fail-closed durable-admission boundary for the paper sidecar.

``PaperSidecarCore`` deliberately ends at the SQLite ledger.  It has no
network, broker, Nautilus, gRPC, credential, environment-discovery, or resume
capability.  A successful decision means only that a signed paper command was
durably recorded; it never means that an execution client was invoked.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re
from typing import Any, Protocol

from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .contract import (
    ContractValidationError,
    load_ed25519_public_key,
    stable_stringify,
    validate_execution_command_v1,
    validate_execution_permit_v2,
    verify_execution_permit_v2,
)
from .environment import (
    DenyAllEnvironmentProvider,
    PaperEnvironmentDenied,
    PaperEnvironmentError,
    PaperEnvironmentProvider,
    require_paper_environment,
)
from .ledger import (
    EnvironmentAuthorityExpired,
    ExecutionCommand,
    ExecutionCommandReceipt,
    IdempotencyConflict,
    Ledger,
    Lease,
    LifecycleEvent,
    LifecycleSnapshot,
    OfflineExecutionReceipt,
    PermitAuthorityExpired,
    RuntimeSuspended,
    StaleLease,
)


class CoreAdmissionDenied(RuntimeError):
    """The core rejected a command before it could be durably admitted."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


@dataclass(frozen=True, slots=True)
class OfflineAdmissionBinding:
    """Constructor-supplied trust binding for PAPER_LOCAL dispatch admission.

    The core parses and pins ``permit_public_key`` during construction, then
    proves it is the same material as the configured permit authority when
    expected signing keys are frozen.  This value contains public material
    only; the core never accepts or retains a private key.
    """

    policy_hash: str
    permit_authority_key_id: str
    permit_public_key: Any


@dataclass(frozen=True, slots=True)
class _FrozenOfflineAdmissionBinding:
    """Internal, loader-normalized immutable PAPER_LOCAL admission binding."""

    policy_hash: str
    permit_authority_key_id: str
    permit_public_key: Any


@dataclass(frozen=True, slots=True)
class DurableAdmissionDecision:
    """Immutable result of a ledger-only admission decision."""

    receipt: ExecutionCommandReceipt
    disposition: str
    execution_client_invoked: bool = False
    broker_submission_enabled: bool = False


@dataclass(frozen=True, slots=True)
class CoreStatus:
    """Read-only capability status; no status implies broker submission."""

    status: str
    reason: str | None
    protocol_version: str = "openalice.execution.v1"
    service_id: str = "openalice.nautilus_paper.durable_admission"
    mode: str | None = None
    run_id: str | None = None
    environment_proof_hash: str | None = None
    schema_hash: str | None = None
    writer_epoch: int = 0
    latest_sequence: int = 0
    execution_client_invoked: bool = False
    broker_submission_enabled: bool = False
    writer_lease_bound: bool = False
    resume_supported: bool = False


class ExactEnvironmentIdentity(Protocol):
    """Structural identity pinned by the managed runtime for one admission."""

    mode: str
    run_id: str
    environment_proof_hash: str
    schema_hash: str


def _deny_public_key(_: str) -> None:
    """Default resolver: unknown keys are always denied."""
    return None


class PaperSidecarCore:
    """Validate signed paper commands and atomically persist them to ``Ledger``.

    The constructor is intentionally unusable for admission by default: it has
    a deny-all environment provider, no resolvable signing key, no lease, and
    no matching environment identity.  Callers must explicitly wire every one
    of those dependencies for an offline durable admission to become possible.
    """

    _ACCEPTED = "accepted_durable_not_submitted"
    _DUPLICATE = "duplicate_durable_not_submitted"
    _SUSPENDED_READ_ONLY = "suspended/read_only"
    _PROTOCOL_VERSION = "openalice.execution.v1"
    _SERVICE_ID = "openalice.nautilus_paper.durable_admission"
    _MAX_UINT64 = (1 << 64) - 1
    _SHA256_HEX = re.compile(r"[0-9a-f]{64}$")

    def __init__(
        self,
        ledger: Ledger,
        *,
        environment_provider: PaperEnvironmentProvider | None = None,
        resolve_public_key: Callable[[str], Any] | None = None,
        expected_schema_hash: str | None = None,
        run_id: str | None = None,
        expected_key_ids: tuple[str, ...] = (),
        offline_admission_binding: OfflineAdmissionBinding | None = None,
        resolve_offline_receipt_public_key: Callable[[str], Any] | None = None,
        expected_offline_receipt_key_ids: tuple[str, ...] = (),
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._ledger = ledger
        self._environment_provider = environment_provider or DenyAllEnvironmentProvider()
        self._resolve_public_key = resolve_public_key or _deny_public_key
        self._expected_schema_hash = expected_schema_hash
        self._run_id = run_id
        if any(not isinstance(item, str) or not item or item != item.strip() for item in expected_key_ids):
            raise ValueError("expected_key_ids must contain trimmed non-empty strings")
        if len(set(expected_key_ids)) != len(expected_key_ids):
            raise ValueError("expected_key_ids must be unique")
        self._expected_key_ids = frozenset(expected_key_ids)
        self._frozen_public_keys: dict[str, Any] | None = None
        self._offline_admission_binding = self._freeze_offline_admission_binding(
            offline_admission_binding
        )
        if any(
            not isinstance(item, str) or not item or item != item.strip()
            for item in expected_offline_receipt_key_ids
        ):
            raise ValueError(
                "expected_offline_receipt_key_ids must contain trimmed non-empty strings"
            )
        if len(set(expected_offline_receipt_key_ids)) != len(
            expected_offline_receipt_key_ids
        ):
            raise ValueError("expected_offline_receipt_key_ids must be unique")
        self._resolve_offline_receipt_public_key = (
            resolve_offline_receipt_public_key or _deny_public_key
        )
        self._expected_offline_receipt_key_ids = frozenset(
            expected_offline_receipt_key_ids
        )
        self._frozen_offline_receipt_public_keys: dict[str, Any] | None = None
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._writer_lease: Lease | None = None

    def bind_writer_lease(
        self,
        lease: Lease,
    ) -> None:
        """Bind a current lease; Ledger owns the constructor-pinned fence clock."""
        if not isinstance(lease, Lease):
            raise TypeError("lease must be a Ledger Lease")
        self._writer_lease = lease

    def freeze_expected_public_keys(self) -> None:
        """Resolve and pin every configured verification key for this process.

        A managed runtime calls this exactly once before publishing READY.  It
        prevents a mutable resolver from changing the key material behind an
        already-trusted ``keyId`` after readiness was established.
        """
        if self._frozen_public_keys is not None:
            return
        frozen: dict[str, Any] = {}
        try:
            for key_id in self._expected_key_ids:
                resolved = self._resolve_public_key(key_id)
                if resolved is None:
                    raise ValueError("missing expected public key")
                frozen[key_id] = load_ed25519_public_key(resolved)
        except Exception:
            raise CoreAdmissionDenied("signing_key_unavailable") from None
        if set(frozen) != set(self._expected_key_ids) or not frozen:
            raise CoreAdmissionDenied("signing_key_unavailable")
        self._verify_offline_admission_binding(frozen)
        self._frozen_public_keys = frozen
        self.freeze_offline_receipt_public_keys()

    def freeze_offline_receipt_public_keys(self) -> None:
        """Resolve and pin configured offline receipt verification public keys.

        ``Ledger.get_offline_execution_receipt`` currently accepts only one
        key and does not expose a separately authenticated policy key id for
        selecting among several keys.  Consequently multiple configured keys
        are deliberately rejected: choosing a key from receipt-controlled data
        would create a trust-selection vulnerability.  No private key is ever
        accepted or retained by this read path.
        """
        if self._frozen_offline_receipt_public_keys is not None:
            return
        if len(self._expected_offline_receipt_key_ids) > 1:
            raise CoreAdmissionDenied("offline_receipt_key_selection_ambiguous")
        frozen: dict[str, Any] = {}
        try:
            for key_id in self._expected_offline_receipt_key_ids:
                resolved = self._resolve_offline_receipt_public_key(key_id)
                if resolved is None:
                    raise ValueError("missing offline receipt public key")
                frozen[key_id] = load_ed25519_public_key(resolved)
        except Exception:
            raise CoreAdmissionDenied("offline_receipt_signing_key_unavailable") from None
        self._frozen_offline_receipt_public_keys = frozen

    def require_offline_receipt_binding(
        self, key_id: str, public_key: Any
    ) -> None:
        """Require one exact, already-frozen offline receipt verification key.

        Runtime readiness uses this as a check only: it neither resolves keys
        nor returns the pinned key material.  Every malformed, unavailable,
        ambiguous, or mismatched input shares one public failure reason.
        """
        frozen = self._frozen_offline_receipt_public_keys
        if frozen is None or len(frozen) != 1:
            raise CoreAdmissionDenied("offline_receipt_binding_unavailable")
        try:
            expected_key_id, expected_key = next(iter(frozen.items()))
            supplied_key = load_ed25519_public_key(public_key)
            matches = (
                isinstance(key_id, str)
                and key_id == expected_key_id
                and self._public_key_material(supplied_key)
                == self._public_key_material(expected_key)
            )
        except Exception:
            matches = False
        if not matches:
            raise CoreAdmissionDenied("offline_receipt_binding_unavailable")

    def admit(
        self,
        *,
        command: Mapping[str, Any],
        permit: Mapping[str, Any],
        command_payload_bytes: bytes,
        permit_bytes: bytes,
        now: datetime | None = None,
        expected_environment_identity: ExactEnvironmentIdentity | None = None,
    ) -> DurableAdmissionDecision:
        """Admit one signed ``submit`` command without invoking an execution client.

        Both byte inputs must be UTF-8 JSON and the exact TypeScript-compatible
        canonical encoding of the corresponding supplied object.  Validating
        that raw representation before signature verification prevents a caller
        from signing one projection while asking the core to persist another.
        """
        effective_now = self._effective_now(now)
        parsed_payload = self._canonical_bytes_object(
            command_payload_bytes, command.get("payload") if isinstance(command, Mapping) else None,
            "command_payload_bytes",
        )
        parsed_permit = self._canonical_bytes_object(permit_bytes, permit, "permit_bytes")

        try:
            parsed_command = validate_execution_command_v1(command)
            # This explicit validation gives malformed permits a deterministic
            # fail-closed path even before cryptographic verification.
            validate_execution_permit_v2(permit)
        except (ContractValidationError, TypeError, KeyError) as error:
            raise CoreAdmissionDenied("invalid_contract") from error

        if parsed_payload != parsed_command["payload"] or parsed_permit != permit:
            raise CoreAdmissionDenied("raw_projection_mismatch")
        if parsed_command["payload"]["kind"] != "submit":
            raise CoreAdmissionDenied("unsupported_command_kind")
        if parsed_permit["keyId"] not in self._expected_key_ids:
            raise CoreAdmissionDenied("untrusted_signing_key_id")
        if (
            parsed_command["payload"]["mode"] == "PAPER_LOCAL"
            and self._offline_admission_binding is not None
        ):
            # PAPER_LOCAL dispatch admission has one constructor-pinned trust
            # path: freeze it before permit verification so the mutable
            # resolver cannot supply different material later in this call.
            self.freeze_expected_public_keys()

        verification = verify_execution_permit_v2(
            permit=parsed_permit,
            command=parsed_command,
            resolve_public_key=self._verification_key,
            now=effective_now,
        )
        if not verification.valid:
            raise CoreAdmissionDenied(f"permit_{verification.reason or 'invalid'}")

        mode = parsed_command["payload"]["mode"]
        expected_mode = (
            expected_environment_identity.mode
            if expected_environment_identity is not None
            else mode
        )
        if mode != expected_mode:
            raise CoreAdmissionDenied("environment_identity_mismatch")
        try:
            proof = require_paper_environment(
                self._environment_provider,
                expected_mode=expected_mode,
                now=effective_now,
            )
        except PaperEnvironmentDenied as error:
            raise CoreAdmissionDenied("environment_denied") from error
        except PaperEnvironmentError as error:
            raise CoreAdmissionDenied("environment_unavailable") from error
        if expected_environment_identity is not None and (
            proof.mode != expected_environment_identity.mode
            or proof.runId != expected_environment_identity.run_id
            or proof.proofHash
            != expected_environment_identity.environment_proof_hash
            or proof.schemaHash != expected_environment_identity.schema_hash
        ):
            raise CoreAdmissionDenied("environment_identity_mismatch")
        if proof.schemaHash != self._expected_schema_hash:
            raise CoreAdmissionDenied("environment_schema_hash_mismatch")
        if proof.runId != self._run_id:
            raise CoreAdmissionDenied("environment_run_id_mismatch")
        if self._writer_lease is None:
            raise CoreAdmissionDenied("writer_lease_unbound")

        try:
            offline_binding = (
                self._offline_admission_binding
                if parsed_command["payload"]["mode"] == "PAPER_LOCAL"
                else None
            )
            receipt = self._ledger.admit_execution_command(
                command=parsed_command,
                permit=parsed_permit,
                writer_lease=self._writer_lease,
                now=effective_now.timestamp(),
                permit_expires_at=self._timestamp_seconds(parsed_permit["expiresAt"]),
                environment_expires_at=self._timestamp_seconds(proof.expiresAt),
                offline_adapter_policy_hash=(
                    offline_binding.policy_hash if offline_binding is not None else None
                ),
                permit_public_key=(
                    offline_binding.permit_public_key
                    if offline_binding is not None
                    else None
                ),
            )
        except EnvironmentAuthorityExpired as error:
            raise CoreAdmissionDenied("environment_authority_expired") from error
        except PermitAuthorityExpired as error:
            raise CoreAdmissionDenied("permit_expired") from error
        except RuntimeSuspended as error:
            raise CoreAdmissionDenied("suspended") from error
        except StaleLease as error:
            raise CoreAdmissionDenied("stale_writer_lease") from error
        except IdempotencyConflict as error:
            # The ledger committed the suspension and conflict event before it
            # raised; the core cannot resume it.
            raise CoreAdmissionDenied("idempotency_conflict") from error
        except (ValueError, TypeError) as error:
            raise CoreAdmissionDenied("ledger_rejected") from error
        return DurableAdmissionDecision(
            receipt=receipt,
            disposition=self._ACCEPTED if receipt.created else self._DUPLICATE,
        )

    def require_offline_admission_binding(
        self, policy_hash: str, permit_public_key: Any
    ) -> None:
        """Require the constructor-pinned PAPER_LOCAL binding after key freeze.

        This runtime-facing check deliberately accepts no resolver, clock, or
        per-call authority selection.  It returns no trust material and masks
        malformed caller input behind one stable public denial reason.
        """
        binding = self._offline_admission_binding
        if self._frozen_public_keys is None or binding is None:
            raise CoreAdmissionDenied("offline_admission_binding_unavailable")
        try:
            supplied_key = load_ed25519_public_key(permit_public_key)
            matches = (
                isinstance(policy_hash, str)
                and policy_hash == binding.policy_hash
                and self._public_key_material(supplied_key)
                == self._public_key_material(binding.permit_public_key)
            )
        except Exception:
            matches = False
        if not matches:
            raise CoreAdmissionDenied("offline_admission_binding_unavailable")

    def handshake(self, *, now: datetime | None = None) -> CoreStatus:
        """Return offline capability status without attempting any admission."""
        return self._status(now=now)

    def health(self, *, now: datetime | None = None) -> CoreStatus:
        """Return the same read-only safety status as :meth:`handshake`."""
        return self._status(now=now)

    def get_command(self, command_id: str) -> ExecutionCommand | None:
        """Read a durable command even when admission is suspended."""
        return self._ledger.get_command_by_hash(command_id)

    def get_snapshot(
        self, *, account_id: str, symbol: str
    ) -> LifecycleSnapshot | None:
        """Read opaque lifecycle diagnostics; never reinterpret legacy cursors."""
        return self._ledger.get_lifecycle_snapshot(account_id=account_id, symbol=symbol)

    def replay_lifecycle_events(
        self, *, after_sequence: int = 0, limit: int = 1_000
    ) -> list[LifecycleEvent]:
        """Replay only validated execution lifecycle events in sequence order."""
        return self._ledger.replay_lifecycle_events(
            after_sequence=after_sequence,
            limit=limit,
        )

    def get_offline_execution_receipt(
        self, receipt_id: str
    ) -> OfflineExecutionReceipt | None:
        """Read one signature-verified simulator-only receipt, never a raw row.

        A receipt is returned only after the ledger verifies its canonical
        request/response/receipt binding and V2 lifecycle binder with the
        process-pinned public key.  Receipt-controlled ``adapterKeyId`` is not
        used to choose trust material.
        """
        if self._frozen_offline_receipt_public_keys is None:
            self.freeze_offline_receipt_public_keys()
        assert self._frozen_offline_receipt_public_keys is not None
        if not self._frozen_offline_receipt_public_keys:
            raise CoreAdmissionDenied("offline_receipt_signing_key_unconfigured")
        if len(self._frozen_offline_receipt_public_keys) != 1:
            raise CoreAdmissionDenied("offline_receipt_key_selection_ambiguous")
        public_key = next(iter(self._frozen_offline_receipt_public_keys.values()))
        try:
            return self._ledger.get_offline_execution_receipt(
                receipt_id,
                receipt_public_key=public_key,
            )
        except Exception as error:
            # ``None`` remains the only authenticated not-found result.  A
            # malformed/id-mismatched/signature-invalid stored row must never
            # be downgraded to absence.
            if isinstance(error, (TypeError, ValueError)):
                raise CoreAdmissionDenied("offline_receipt_unavailable") from None
            raise

    def replay(self, *, after_cursor: int = 0, limit: int = 1_000):
        """Replay durable ledger events in cursor order, including after suspend."""
        return self._ledger.replay(after_cursor=after_cursor, limit=limit)

    def _status(self, *, now: datetime | None) -> CoreStatus:
        """Return only locally verified durable-admission identity and state.

        This method is intentionally read-only: in particular it never renews
        a writer lease.  A stale lease or expired/invalid environment proof is
        unavailable even when the durable ledger had previously been suspended.
        That ordering prevents stale process identity from being advertised as
        a valid suspended service.
        """
        try:
            latest_sequence = self._ledger.latest_lifecycle_sequence()
        except Exception:
            return self._unavailable("durable_read_unavailable")
        if not self._valid_uint64(latest_sequence):
            return self._unavailable("invalid_latest_sequence")
        base = {"latest_sequence": latest_sequence}
        if not self._expected_schema_hash or not self._run_id:
            return self._unavailable("environment_identity_unconfigured", **base)
        try:
            effective_now = self._effective_now(now)
            proof = require_paper_environment(self._environment_provider, now=effective_now)
        except (CoreAdmissionDenied, PaperEnvironmentDenied, PaperEnvironmentError):
            return self._unavailable("environment_unavailable", **base)
        except Exception:
            return self._unavailable("environment_unavailable", **base)
        identity = {
            **base,
            "mode": proof.mode,
            "run_id": proof.runId,
            "environment_proof_hash": proof.proofHash,
            "schema_hash": proof.schemaHash,
        }
        if proof.schemaHash != self._expected_schema_hash:
            return self._unavailable("environment_schema_hash_mismatch", **identity)
        if proof.runId != self._run_id:
            return self._unavailable("environment_run_id_mismatch", **identity)
        if self._writer_lease is None:
            return self._unavailable("writer_lease_unbound", **identity)
        if not self._valid_uint64(self._writer_lease.epoch):
            return self._unavailable("invalid_writer_epoch", **identity)
        try:
            self._ledger.require_current_writer_lease(self._writer_lease)
        except StaleLease:
            return self._unavailable("stale_writer_lease", writer_lease_bound=True, **identity)
        if not self._expected_key_ids:
            return self._unavailable("signing_key_identity_unconfigured", writer_lease_bound=True, **identity)
        if not self._has_resolvable_expected_key():
            return self._unavailable("signing_key_unavailable", writer_lease_bound=True, **identity)
        state = self._ledger.runtime_state()
        if state is not None and state["mode"] == "suspended":
            return self._core_status(
                status=self._SUSPENDED_READ_ONLY,
                reason="suspended",
                writer_lease_bound=True,
                writer_epoch=self._writer_lease.epoch,
                **identity,
            )
        return self._core_status(
            status="ready_for_durable_admission",
            reason=None,
            writer_lease_bound=True,
            writer_epoch=self._writer_lease.epoch,
            **identity,
        )

    def _unavailable(self, reason: str, **fields: Any) -> CoreStatus:
        return self._core_status(status="unavailable", reason=reason, **fields)

    def _core_status(self, *, status: str, reason: str | None, **fields: Any) -> CoreStatus:
        return CoreStatus(
            status=status,
            reason=reason,
            protocol_version=self._PROTOCOL_VERSION,
            service_id=self._SERVICE_ID,
            **fields,
        )

    @classmethod
    def _valid_uint64(cls, value: Any) -> bool:
        return type(value) is int and 0 <= value <= cls._MAX_UINT64

    def _has_resolvable_expected_key(self) -> bool:
        if self._frozen_public_keys is not None:
            return bool(self._frozen_public_keys)
        for key_id in self._expected_key_ids:
            try:
                resolved = self._resolve_public_key(key_id)
                if resolved is not None:
                    load_ed25519_public_key(resolved)
                    return True
            except (TypeError, ValueError, OSError):
                continue
            except Exception:
                continue
        return False

    def _freeze_offline_admission_binding(
        self, binding: OfflineAdmissionBinding | None
    ) -> _FrozenOfflineAdmissionBinding | None:
        """Validate constructor input and pin only Ed25519 public material."""
        if binding is None:
            return None
        if not isinstance(binding, OfflineAdmissionBinding):
            raise CoreAdmissionDenied("offline_admission_binding_invalid")
        if (
            not isinstance(binding.policy_hash, str)
            or self._SHA256_HEX.fullmatch(binding.policy_hash) is None
            or not isinstance(binding.permit_authority_key_id, str)
            or not binding.permit_authority_key_id
            or binding.permit_authority_key_id != binding.permit_authority_key_id.strip()
        ):
            raise CoreAdmissionDenied("offline_admission_binding_invalid")
        try:
            public_key = load_ed25519_public_key(binding.permit_public_key)
        except Exception:
            raise CoreAdmissionDenied("offline_admission_binding_invalid") from None
        return _FrozenOfflineAdmissionBinding(
            policy_hash=binding.policy_hash,
            permit_authority_key_id=binding.permit_authority_key_id,
            permit_public_key=public_key,
        )

    def _verify_offline_admission_binding(self, frozen: Mapping[str, Any]) -> None:
        """Bind PAPER_LOCAL dispatch trust to the frozen permit verifier only."""
        binding = self._offline_admission_binding
        if binding is None:
            return
        if binding.permit_authority_key_id not in self._expected_key_ids:
            raise CoreAdmissionDenied("offline_admission_binding_untrusted_key_id")
        trusted_key = frozen.get(binding.permit_authority_key_id)
        if trusted_key is None or (
            self._public_key_material(trusted_key)
            != self._public_key_material(binding.permit_public_key)
        ):
            raise CoreAdmissionDenied("offline_admission_binding_key_mismatch")

    @staticmethod
    def _public_key_material(public_key: Any) -> bytes:
        """Return the canonical SPKI bytes used for exact public-key equality."""
        return public_key.public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo)

    def _verification_key(self, key_id: str) -> Any:
        if self._frozen_public_keys is not None:
            return self._frozen_public_keys.get(key_id)
        return self._resolve_public_key(key_id)

    def _effective_now(self, supplied: datetime | None) -> datetime:
        value = self._clock() if supplied is None else supplied
        if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
            raise CoreAdmissionDenied("invalid_now")
        return value.astimezone(timezone.utc)

    @staticmethod
    def _timestamp_seconds(value: str) -> float:
        """Convert an already contract-validated canonical UTC timestamp."""
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
            tzinfo=timezone.utc
        ).timestamp()

    @staticmethod
    def _canonical_bytes_object(raw: bytes, typed: Any, label: str) -> dict[str, Any]:
        if type(raw) is not bytes:
            raise CoreAdmissionDenied(f"{label}_must_be_bytes")
        try:
            parsed = json.loads(raw.decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise CoreAdmissionDenied(f"{label}_invalid_utf8_json") from error
        if not isinstance(parsed, dict):
            raise CoreAdmissionDenied(f"{label}_must_be_object")
        try:
            canonical = stable_stringify(parsed).encode("utf-8")
        except ContractValidationError as error:
            raise CoreAdmissionDenied(f"{label}_invalid_contract_json") from error
        if raw != canonical:
            raise CoreAdmissionDenied(f"{label}_not_canonical")
        if not isinstance(typed, Mapping) or parsed != typed:
            raise CoreAdmissionDenied("raw_projection_mismatch")
        return parsed
