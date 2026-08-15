"""OpenAlice SQLite command ledger with idempotency and fenced single-writer leases.

The ledger records intents only.  It contains no service loop, network access,
broker integration, or order execution capability.  Every multi-row state
transition uses ``BEGIN IMMEDIATE`` so a process crash either commits the whole
transition or SQLite rolls it back.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import time
from typing import Any, Callable, Iterable, Iterator, Mapping

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    load_der_private_key,
    load_pem_private_key,
)

from .contract import (
    ContractValidationError,
    build_execution_event_v1,
    load_ed25519_public_key,
    sha256_canonical,
    stable_stringify,
    validate_execution_command_v1,
    validate_execution_event,
    validate_execution_event_v1,
    validate_execution_permit_v2,
    verify_execution_permit_v2,
)
from .offline_receipt import (
    OFFLINE_EXECUTION_RECEIPT_SCOPE,
    OFFLINE_EXECUTION_RECEIPT_V1,
    OFFLINE_SIMULATOR_CAPABILITY,
    OFFLINE_SIMULATOR_CAPABILITY_V1,
    OFFLINE_SIMULATOR_REQUEST_V1,
    OfflineReceiptTrustPolicy,
    build_execution_event_v2_from_offline_receipt,
    create_offline_execution_receipt_v1,
    create_offline_simulator_capability_v1,
    derive_offline_execution_attempt_id,
    ed25519_public_key_fingerprint_sha256,
    execution_event_v2_matches_offline_receipt,
    parse_offline_execution_receipt_json_utf8,
    parse_offline_simulator_capability_json_utf8,
    verify_offline_simulator_capability_v1,
    verify_offline_execution_receipt_v1,
    validate_offline_simulator_request_v1,
    validate_offline_simulator_response_v1,
)
from .offline_effect import (
    OfflineSimulatorEffectTrustPolicy,
    offline_simulator_effect_v1_matches,
    parse_offline_simulator_effect_json_utf8,
    verify_offline_simulator_effect_v1,
)


class LedgerError(RuntimeError):
    """Base error for ledger operations."""


class IdempotencyConflict(LedgerError):
    """The same idempotency key was presented with a different payload hash."""


class PayloadHashMismatch(LedgerError):
    """The caller-declared hash is not the canonical SHA-256 of its payload."""


class CommandHashMismatch(LedgerError):
    """commandId/payloadHash does not match the canonical payload SHA-256."""


class SnapshotCursorAhead(LedgerError):
    """A snapshot cannot claim an event cursor that the ledger has not accepted."""


class SnapshotRegression(LedgerError):
    """A snapshot cannot move its as-of cursor backwards."""


class LifecycleSequenceGap(LedgerError):
    """The dedicated execution lifecycle sequence is missing or discontinuous."""


class MalformedLifecycleRecord(LedgerError):
    """A stored lifecycle event or snapshot failed strict durable validation."""


class RuntimeSuspended(LedgerError):
    """A fail-closed circuit has suspended admission of new commands."""


class LeaseRejected(LedgerError):
    """A different owner holds a non-expired writer lease."""


class StaleLease(LedgerError):
    """A fenced or expired lease attempted a protected write."""


class EnvironmentAuthorityExpired(LedgerError):
    """The execution environment authority expired before admission."""


class PermitAuthorityExpired(LedgerError):
    """The execution permit authority expired before admission."""


class OfflineDispatchPolicyMismatch(LedgerError):
    """An admission attempted to change its already-bound offline policy."""


class OfflineDispatchUnavailable(LedgerError):
    """No pending offline dispatch exists, or its state is not claimable."""


class MalformedOfflineDispatchRecord(LedgerError):
    """Durable offline-dispatch state is non-canonical, inconsistent, or tampered."""


@dataclass(frozen=True)
class Command:
    id: int
    idempotency_key: str
    payload_hash: str
    command_type: str
    payload_json: str
    created_at: float

    @property
    def payload(self) -> Any:
        return json.loads(self.payload_json)


@dataclass(frozen=True)
class CommandReceipt:
    command: Command
    created: bool


@dataclass(frozen=True)
class Event:
    cursor: int
    event_type: str
    command_id: int | None
    payload_json: str
    created_at: float

    @property
    def payload(self) -> Any:
        return json.loads(self.payload_json)


@dataclass(frozen=True)
class Lease:
    name: str
    owner_id: str
    epoch: int
    expires_at: float


@dataclass(frozen=True)
class ExecutionCommand:
    id: int
    command_hash: str
    payload_hash: str
    idempotency_key: str
    kind: str
    payload_json: str
    command_json: str
    permit_json: str
    created_at: float
    accepted_cursor: int
    accepted_sequence: int

    @property
    def payload(self) -> Any:
        return json.loads(self.payload_json)

    @property
    def command(self) -> Any:
        return json.loads(self.command_json)

    @property
    def permit(self) -> Any:
        return json.loads(self.permit_json)


@dataclass(frozen=True)
class ExecutionCommandReceipt:
    command: ExecutionCommand
    accepted_event: Event
    accepted_lifecycle_event: LifecycleEvent
    created: bool


@dataclass(frozen=True)
class LifecycleEvent:
    """One hash-bound event on the execution-only contiguous sequence."""

    sequence: int
    event_id: str
    command_hash: str
    kind: str
    event_json: str
    created_at: float

    @property
    def event(self) -> dict[str, Any]:
        value = json.loads(self.event_json)
        parsed = validate_execution_event(value)
        return parsed

    @property
    def cursor(self) -> int:
        """Compatibility alias for pre-Phase-B receipt consumers."""
        return self.sequence


@dataclass(frozen=True)
class Snapshot:
    account_id: str
    symbol: str
    snapshot_json: str
    as_of_cursor: int
    updated_at: float

    @property
    def value(self) -> Any:
        return json.loads(self.snapshot_json)


@dataclass(frozen=True)
class LifecycleSnapshot:
    """Opaque canonical diagnostic state scoped to a lifecycle sequence."""

    account_id: str
    symbol: str
    snapshot_json: str
    as_of_sequence: int
    updated_at: float

    @property
    def value(self) -> Any:
        return json.loads(self.snapshot_json)


@dataclass(frozen=True)
class OfflineAdapterPolicy:
    policy_hash: str
    policy_json: str
    created_at: float

    @property
    def value(self) -> dict[str, Any]:
        return json.loads(self.policy_json)


@dataclass(frozen=True)
class ExecutionDispatch:
    command_hash: str
    policy_hash: str
    state: str
    original_attempt_id: str | None
    dispatch_armed_at: str | None
    reconciliation_claim_id: str | None
    receipt_head_id: str | None
    transition_number: str | None
    source_sequence: str | None
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class OfflineExecutionAttempt:
    attempt_id: str
    command_hash: str
    policy_hash: str
    adapter_epoch: str
    attempt_number: str
    canonical_request_json: str
    request_hash: str
    created_at: float

    @property
    def request(self) -> dict[str, Any]:
        return json.loads(self.canonical_request_json)


@dataclass(frozen=True)
class OfflineReconciliationClaim:
    claim_id: str
    command_hash: str
    original_attempt_id: str
    writer_name: str
    owner_id: str
    writer_epoch: int
    status: str
    created_at: float


@dataclass(frozen=True)
class OfflineExecutionReceipt:
    receipt_id: str
    command_hash: str
    policy_hash: str
    original_attempt_id: str
    reconciliation_claim_id: str | None
    source_namespace_id: str
    source_sequence: str
    lifecycle_sequence: int
    transition_number: str
    previous_receipt_id: str | None
    receipt_json: str
    canonical_request_json: str
    canonical_response_json: str
    source_effect_id: str
    canonical_source_effect_json: str
    source_store_id: str
    source_store_sequence: str
    source_store_chain_hash: str
    lifecycle_event_json: str
    created_at: float

    @property
    def receipt(self) -> dict[str, Any]:
        return json.loads(self.receipt_json)

    @property
    def lifecycle_event(self) -> dict[str, Any]:
        return json.loads(self.lifecycle_event_json)


@dataclass(frozen=True)
class OfflineSimulatorCapability:
    capability_id: str
    capability_json: str
    policy_hash: str
    command_hash: str
    original_attempt_id: str
    reconciliation_claim_id: str | None
    writer_name: str
    writer_owner_id: str
    writer_epoch: int
    expires_at: str
    created_at: float

    @property
    def value(self) -> dict[str, Any]:
        return json.loads(self.capability_json)


def _canonical_json(value: Any) -> str:
    """Canonical JSON shared with TypeScript: sorted, compact, UTF-8 text."""
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def _canonical_payload_hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


_SHA256_HEX = re.compile(r"[0-9a-f]{64}$")


def _load_ed25519_private_key(value: Any, *, field: str) -> Ed25519PrivateKey:
    if isinstance(value, Ed25519PrivateKey):
        return value
    raw = value.encode("utf-8") if isinstance(value, str) else value
    if not isinstance(raw, bytes):
        raise TypeError(f"{field} is invalid")
    for loader in (load_pem_private_key, load_der_private_key):
        try:
            loaded = loader(raw, password=None)
        except (TypeError, ValueError):
            continue
        if isinstance(loaded, Ed25519PrivateKey):
            return loaded
    raise ValueError(f"{field} is invalid")


class Ledger:
    """A local SQLite ledger whose write paths are atomic and fail closed."""

    def __init__(
        self,
        database_path: str | Path,
        *,
        busy_timeout_ms: int = 5_000,
        fencing_clock: Callable[[], float] = time.time,
        offline_capability_authority_private_key: Any | None = None,
        offline_capability_authority_key_id: str | None = None,
        offline_receipt_signing_private_key: Any | None = None,
        offline_receipt_signing_key_id: str | None = None,
        offline_source_attestation_public_keys: Mapping[str, Any] | None = None,
    ) -> None:
        if busy_timeout_ms <= 0:
            raise ValueError("busy_timeout_ms must be positive")
        if not callable(fencing_clock):
            raise TypeError("fencing_clock must be callable")
        self.database_path = str(database_path)
        # Fencing authority is a process-construction dependency.  It is never
        # accepted by a business/RPC write call, so a caller cannot backdate a
        # request to revive an expired lease after SQLite's lock is acquired.
        self._fencing_clock = fencing_clock
        if (offline_capability_authority_private_key is None) != (offline_capability_authority_key_id is None):
            raise ValueError("offline capability authority requires both private key and key id")
        if offline_capability_authority_key_id is not None and (
            not isinstance(offline_capability_authority_key_id, str)
            or re.fullmatch(r"[A-Za-z0-9._-]{1,100}", offline_capability_authority_key_id) is None
        ):
            raise ValueError("offline capability authority key id is invalid")
        self._offline_capability_authority_private_key = (
            None
            if offline_capability_authority_private_key is None
            else _load_ed25519_private_key(
                offline_capability_authority_private_key,
                field="offline_capability_authority_private_key",
            )
        )
        self._offline_capability_authority_key_id = offline_capability_authority_key_id
        if (offline_receipt_signing_private_key is None) != (
            offline_receipt_signing_key_id is None
        ):
            raise ValueError(
                "offline receipt signer requires both private key and key id"
            )
        if offline_receipt_signing_key_id is not None and (
            not isinstance(offline_receipt_signing_key_id, str)
            or re.fullmatch(
                r"[A-Za-z0-9._-]{1,100}", offline_receipt_signing_key_id
            )
            is None
        ):
            raise ValueError("offline receipt signing key id is invalid")
        self._offline_receipt_signing_private_key = (
            None
            if offline_receipt_signing_private_key is None
            else _load_ed25519_private_key(
                offline_receipt_signing_private_key,
                field="offline_receipt_signing_private_key",
            )
        )
        self._offline_receipt_signing_key_id = offline_receipt_signing_key_id
        if (
            self._offline_capability_authority_private_key is not None
            and self._offline_receipt_signing_private_key is not None
            and ed25519_public_key_fingerprint_sha256(
                self._offline_capability_authority_private_key.public_key()
            )
            == ed25519_public_key_fingerprint_sha256(
                self._offline_receipt_signing_private_key.public_key()
            )
        ):
            raise ValueError(
                "offline capability authority and receipt signer must be distinct"
            )
        source_keys = (
            {} if offline_source_attestation_public_keys is None else offline_source_attestation_public_keys
        )
        if not isinstance(source_keys, Mapping) or any(
            not isinstance(key_id, str)
            or re.fullmatch(r"[A-Za-z0-9._-]{1,100}", key_id) is None
            for key_id in source_keys
        ):
            raise ValueError("offline source attestation public key mapping is invalid")
        try:
            self._offline_source_attestation_public_keys = {
                key_id: load_ed25519_public_key(public_key)
                for key_id, public_key in source_keys.items()
            }
        except Exception:
            raise ValueError(
                "offline source attestation public key mapping is invalid"
            ) from None
        self._connection = sqlite3.connect(
            self.database_path,
            isolation_level=None,
            timeout=busy_timeout_ms / 1_000,
        )
        self._connection.row_factory = sqlite3.Row
        self._configure(busy_timeout_ms)
        self._create_schema()

    def close(self) -> None:
        self._connection.close()

    def __enter__(self) -> "Ledger":
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def _configure(self, busy_timeout_ms: int) -> None:
        # WAL persists in the database. FULL asks SQLite to synchronously flush
        # transaction durability boundaries rather than accepting NORMAL's risk.
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._connection.execute("PRAGMA synchronous=FULL")
        self._connection.execute("PRAGMA foreign_keys=ON")
        self._connection.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")

    def _create_schema(self) -> None:
        """Create and migrate the ledger as one crash-safe transaction.

        Phase B deliberately does not reinterpret ``events.cursor`` as an
        execution lifecycle sequence.  Existing execution admissions are
        deterministically backfilled onto the new, contiguous sequence while
        the same ``BEGIN IMMEDIATE`` transaction also adds
        ``accepted_sequence``.  A failed validation rolls the entire migration
        back, making repeated opens idempotent and fail closed.
        """
        statements = (
            """CREATE TABLE IF NOT EXISTS commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                idempotency_key TEXT NOT NULL UNIQUE,
                payload_hash TEXT NOT NULL,
                command_type TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS events (
                cursor INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                command_id INTEGER REFERENCES commands(id) ON DELETE RESTRICT,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS writer_lease (
                name TEXT PRIMARY KEY,
                owner_id TEXT NOT NULL,
                epoch INTEGER NOT NULL CHECK (epoch > 0),
                expires_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS runtime_state (
                state_key TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                circuit_reason TEXT,
                updated_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS execution_commands (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                command_hash TEXT NOT NULL UNIQUE,
                payload_hash TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                command_json TEXT NOT NULL,
                permit_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                accepted_cursor INTEGER NOT NULL UNIQUE REFERENCES events(cursor) ON DELETE RESTRICT,
                accepted_sequence INTEGER
            )""",
            """CREATE TABLE IF NOT EXISTS snapshots (
                account_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                as_of_cursor INTEGER NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY(account_id, symbol)
            )""",
            """CREATE TABLE IF NOT EXISTS lifecycle_events (
                sequence INTEGER PRIMARY KEY CHECK (sequence > 0),
                event_id TEXT NOT NULL UNIQUE,
                command_hash TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                event_json TEXT NOT NULL,
                evidence_schema_version TEXT,
                evidence_receipt_id TEXT,
                created_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS lifecycle_snapshots (
                account_id TEXT NOT NULL,
                symbol TEXT NOT NULL,
                snapshot_json TEXT NOT NULL,
                as_of_sequence INTEGER NOT NULL CHECK (as_of_sequence >= 0),
                updated_at REAL NOT NULL,
                PRIMARY KEY(account_id, symbol)
            )""",
            """CREATE TABLE IF NOT EXISTS offline_adapter_policies (
                policy_hash TEXT PRIMARY KEY NOT NULL,
                policy_json TEXT NOT NULL,
                created_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS execution_dispatches (
                command_hash TEXT PRIMARY KEY NOT NULL
                    REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                policy_hash TEXT NOT NULL
                    REFERENCES offline_adapter_policies(policy_hash) ON DELETE RESTRICT,
                state TEXT NOT NULL CHECK (state IN (
                    'DISPATCH_PENDING', 'IN_FLIGHT', 'RECONCILIATION_REQUIRED',
                    'RECEIPT_COMMITTED'
                )),
                original_attempt_id TEXT UNIQUE,
                dispatch_armed_at TEXT,
                reconciliation_claim_id TEXT,
                receipt_head_id TEXT,
                transition_number TEXT,
                source_sequence TEXT,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS execution_attempts (
                attempt_id TEXT PRIMARY KEY NOT NULL,
                command_hash TEXT NOT NULL
                    REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                policy_hash TEXT NOT NULL
                    REFERENCES offline_adapter_policies(policy_hash) ON DELETE RESTRICT,
                adapter_epoch TEXT NOT NULL,
                attempt_number TEXT NOT NULL,
                canonical_request_json TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(command_hash, attempt_number)
            )""",
            """CREATE TABLE IF NOT EXISTS execution_reconciliation_claims (
                claim_id TEXT PRIMARY KEY NOT NULL,
                command_hash TEXT NOT NULL
                    REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                original_attempt_id TEXT NOT NULL
                    REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
                writer_name TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'FENCED', 'COMPLETED')),
                created_at REAL NOT NULL
            )""",
            """CREATE UNIQUE INDEX IF NOT EXISTS
                execution_reconciliation_one_active
                ON execution_reconciliation_claims(command_hash)
                WHERE status = 'ACTIVE'
            """,
            """CREATE TABLE IF NOT EXISTS offline_execution_receipts (
                receipt_id TEXT PRIMARY KEY NOT NULL,
                command_hash TEXT NOT NULL
                    REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                attempt_id TEXT NOT NULL
                    REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
                policy_hash TEXT NOT NULL
                    REFERENCES offline_adapter_policies(policy_hash) ON DELETE RESTRICT,
                reconciliation_claim_id TEXT,
                source_namespace_id TEXT NOT NULL,
                source_sequence TEXT NOT NULL,
                receipt_json TEXT NOT NULL,
                canonical_request_json TEXT NOT NULL,
                canonical_response_json TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                response_hash TEXT NOT NULL,
                source_effect_id TEXT NOT NULL UNIQUE,
                canonical_source_effect_json TEXT NOT NULL,
                source_store_id TEXT NOT NULL,
                source_store_sequence TEXT NOT NULL,
                source_store_chain_hash TEXT NOT NULL,
                lifecycle_sequence INTEGER NOT NULL UNIQUE,
                lifecycle_event_json TEXT NOT NULL,
                lifecycle_event_id TEXT NOT NULL UNIQUE,
                transition_number TEXT NOT NULL,
                previous_receipt_id TEXT,
                created_at REAL NOT NULL,
                UNIQUE(attempt_id, source_sequence),
                UNIQUE(source_store_id, source_store_sequence)
            )""",
            """CREATE TABLE IF NOT EXISTS offline_source_store_heads (
                source_store_id TEXT PRIMARY KEY NOT NULL,
                source_store_sequence TEXT NOT NULL,
                source_store_chain_hash TEXT NOT NULL
            )""",
            """CREATE TABLE IF NOT EXISTS offline_simulator_capabilities (
                capability_id TEXT PRIMARY KEY NOT NULL,
                capability_json TEXT NOT NULL,
                policy_hash TEXT NOT NULL REFERENCES offline_adapter_policies(policy_hash) ON DELETE RESTRICT,
                command_hash TEXT NOT NULL REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                original_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
                reconciliation_claim_id TEXT,
                writer_name TEXT NOT NULL,
                writer_owner_id TEXT NOT NULL,
                writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                expires_at TEXT NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE(original_attempt_id, reconciliation_claim_id, writer_name, writer_owner_id, writer_epoch)
            )""",
            """CREATE UNIQUE INDEX IF NOT EXISTS offline_capability_original_unique
                ON offline_simulator_capabilities(original_attempt_id)
                WHERE reconciliation_claim_id IS NULL""",
            """CREATE UNIQUE INDEX IF NOT EXISTS offline_capability_reconciliation_unique
                ON offline_simulator_capabilities(reconciliation_claim_id)
                WHERE reconciliation_claim_id IS NOT NULL""",
            """CREATE TRIGGER IF NOT EXISTS offline_adapter_policies_immutable_update
                BEFORE UPDATE ON offline_adapter_policies
                BEGIN SELECT RAISE(ABORT, 'offline adapter policies are immutable'); END""",
            """CREATE TRIGGER IF NOT EXISTS offline_adapter_policies_immutable_delete
                BEFORE DELETE ON offline_adapter_policies
                BEGIN SELECT RAISE(ABORT, 'offline adapter policies are immutable'); END""",
            """CREATE TRIGGER IF NOT EXISTS execution_attempts_immutable_update
                BEFORE UPDATE ON execution_attempts
                BEGIN SELECT RAISE(ABORT, 'offline execution attempts are immutable'); END""",
            """CREATE TRIGGER IF NOT EXISTS execution_attempts_immutable_delete
                BEFORE DELETE ON execution_attempts
                BEGIN SELECT RAISE(ABORT, 'offline execution attempts are immutable'); END""",
        )
        with self._transaction() as connection:
            # A receipt history without its independently durable global-store
            # head cannot be made safe by guessing a head from receipt rows.
            # Capture this before CREATE TABLE IF NOT EXISTS so a reopen of a
            # legacy database cannot be mistaken for a new empty database.
            receipt_table_preexisted = connection.execute(
                """SELECT 1 FROM sqlite_master
                   WHERE type = 'table' AND name = 'offline_execution_receipts'"""
            ).fetchone() is not None
            store_heads_table_preexisted = connection.execute(
                """SELECT 1 FROM sqlite_master
                   WHERE type = 'table' AND name = 'offline_source_store_heads'"""
            ).fetchone() is not None
            receipt_rows_before_migration = (
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM offline_execution_receipts"
                    ).fetchone()[0]
                )
                if receipt_table_preexisted
                else 0
            )
            for statement in statements:
                connection.execute(statement)
            columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(execution_commands)")
            }
            if "accepted_sequence" not in columns:
                connection.execute(
                    "ALTER TABLE execution_commands ADD COLUMN accepted_sequence INTEGER"
                )
            lifecycle_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(lifecycle_events)")
            }
            if "evidence_schema_version" not in lifecycle_columns:
                connection.execute("ALTER TABLE lifecycle_events ADD COLUMN evidence_schema_version TEXT")
            if "evidence_receipt_id" not in lifecycle_columns:
                connection.execute("ALTER TABLE lifecycle_events ADD COLUMN evidence_receipt_id TEXT")
            receipt_columns = {
                str(row["name"])
                for row in connection.execute(
                    "PRAGMA table_info(offline_execution_receipts)"
                )
            }
            receipt_schema_changed = False
            for column in (
                "source_effect_id",
                "canonical_source_effect_json",
                "source_store_id",
                "source_store_sequence",
                "source_store_chain_hash",
            ):
                if column not in receipt_columns:
                    connection.execute(
                        f"ALTER TABLE offline_execution_receipts ADD COLUMN {column} TEXT"
                    )
                    receipt_schema_changed = True
            connection.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS
                   offline_receipt_source_effect_unique
                   ON offline_execution_receipts(source_effect_id)
                   WHERE source_effect_id IS NOT NULL"""
            )
            dispatch_sql_row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_dispatches'"
            ).fetchone()
            if dispatch_sql_row is not None and "RECEIPT_COMMITTED" not in str(dispatch_sql_row["sql"]):
                # SQLite cannot add a CHECK alternative in place. Preserve all
                # V1 dispatch rows exactly, without inventing receipt state.
                connection.execute("ALTER TABLE execution_dispatches RENAME TO execution_dispatches_v1")
                connection.execute(
                    """CREATE TABLE execution_dispatches (
                        command_hash TEXT PRIMARY KEY NOT NULL REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                        policy_hash TEXT NOT NULL REFERENCES offline_adapter_policies(policy_hash) ON DELETE RESTRICT,
                        state TEXT NOT NULL CHECK (state IN ('DISPATCH_PENDING','IN_FLIGHT','RECONCILIATION_REQUIRED','RECEIPT_COMMITTED')),
                        original_attempt_id TEXT UNIQUE, dispatch_armed_at TEXT,
                        reconciliation_claim_id TEXT, receipt_head_id TEXT,
                        transition_number TEXT, source_sequence TEXT,
                        created_at REAL NOT NULL, updated_at REAL NOT NULL
                    )"""
                )
                connection.execute(
                    """INSERT INTO execution_dispatches(
                        command_hash, policy_hash, state, original_attempt_id,
                        dispatch_armed_at, reconciliation_claim_id, receipt_head_id,
                        transition_number, source_sequence, created_at, updated_at
                    ) SELECT command_hash, policy_hash, state, original_attempt_id,
                        dispatch_armed_at, reconciliation_claim_id, NULL, NULL, NULL,
                        created_at, updated_at FROM execution_dispatches_v1"""
                )
                connection.execute("DROP TABLE execution_dispatches_v1")
            claim_sql_row = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'execution_reconciliation_claims'"
            ).fetchone()
            if claim_sql_row is not None and "COMPLETED" not in str(claim_sql_row["sql"]):
                connection.execute("ALTER TABLE execution_reconciliation_claims RENAME TO execution_reconciliation_claims_v1")
                connection.execute(
                    """CREATE TABLE execution_reconciliation_claims (
                        claim_id TEXT PRIMARY KEY NOT NULL,
                        command_hash TEXT NOT NULL REFERENCES execution_commands(command_hash) ON DELETE RESTRICT,
                        original_attempt_id TEXT NOT NULL REFERENCES execution_attempts(attempt_id) ON DELETE RESTRICT,
                        writer_name TEXT NOT NULL, owner_id TEXT NOT NULL,
                        writer_epoch INTEGER NOT NULL CHECK (writer_epoch > 0),
                        status TEXT NOT NULL CHECK (status IN ('ACTIVE','FENCED','COMPLETED')),
                        created_at REAL NOT NULL
                    )"""
                )
                connection.execute(
                    """INSERT INTO execution_reconciliation_claims(
                        claim_id, command_hash, original_attempt_id, writer_name,
                        owner_id, writer_epoch, status, created_at
                    ) SELECT claim_id, command_hash, original_attempt_id, writer_name,
                        owner_id, writer_epoch, status, created_at
                    FROM execution_reconciliation_claims_v1"""
                )
                connection.execute("DROP TABLE execution_reconciliation_claims_v1")
                connection.execute(
                    """CREATE UNIQUE INDEX IF NOT EXISTS execution_reconciliation_one_active
                    ON execution_reconciliation_claims(command_hash) WHERE status = 'ACTIVE'"""
                )
            receipt_columns = {
                str(row["name"])
                for row in connection.execute("PRAGMA table_info(offline_execution_receipts)")
            }
            for name, definition in (
                ("policy_hash", "TEXT"), ("reconciliation_claim_id", "TEXT"),
                ("request_hash", "TEXT"), ("response_hash", "TEXT"),
                ("lifecycle_sequence", "INTEGER"), ("lifecycle_event_json", "TEXT"),
                ("lifecycle_event_id", "TEXT"), ("transition_number", "TEXT"),
                ("previous_receipt_id", "TEXT"),
            ):
                if name not in receipt_columns:
                    connection.execute(f"ALTER TABLE offline_execution_receipts ADD COLUMN {name} {definition}")
                    receipt_schema_changed = True
            connection.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS offline_receipts_source_event_unique
                ON offline_execution_receipts(source_namespace_id, source_sequence)"""
            )
            connection.execute(
                """CREATE UNIQUE INDEX IF NOT EXISTS offline_receipts_source_store_event_unique
                ON offline_execution_receipts(source_store_id, source_store_sequence)"""
            )
            if receipt_rows_before_migration and (
                receipt_schema_changed or not store_heads_table_preexisted
            ):
                # No earlier phase was authorized to commit receipts. Existing
                # rows, and especially their global store-chain head, cannot
                # be safely upgraded by inference.
                raise MalformedOfflineDispatchRecord("legacy offline receipt rows cannot be upgraded")
            self._validate_offline_source_store_heads_in_transaction(connection)
            self._validate_lifecycle_sequence_in_transaction(connection)
            self._backfill_execution_lifecycle_in_transaction(connection)
            connection.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS
                    execution_commands_accepted_sequence_unique
                ON execution_commands(accepted_sequence)
                """
            )
            missing = int(
                connection.execute(
                    "SELECT COUNT(*) FROM execution_commands WHERE accepted_sequence IS NULL"
                ).fetchone()[0]
            )
            if missing:
                raise MalformedLifecycleRecord(
                    "execution command migration left an absent accepted_sequence"
                )

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        """Commit all writes together, or roll back the entire transition."""
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield self._connection
        except BaseException:
            self._connection.rollback()
            raise
        else:
            self._connection.commit()

    @staticmethod
    def _command_from_row(row: sqlite3.Row) -> Command:
        return Command(
            id=int(row["id"]),
            idempotency_key=str(row["idempotency_key"]),
            payload_hash=str(row["payload_hash"]),
            command_type=str(row["command_type"]),
            payload_json=str(row["payload_json"]),
            created_at=float(row["created_at"]),
        )

    @staticmethod
    def _event_from_row(row: sqlite3.Row) -> Event:
        return Event(
            cursor=int(row["cursor"]),
            event_type=str(row["event_type"]),
            command_id=None if row["command_id"] is None else int(row["command_id"]),
            payload_json=str(row["payload_json"]),
            created_at=float(row["created_at"]),
        )

    @staticmethod
    def _execution_command_from_row(row: sqlite3.Row) -> ExecutionCommand:
        accepted_sequence = row["accepted_sequence"]
        if accepted_sequence is None:
            raise MalformedLifecycleRecord("execution command has no accepted_sequence")
        return ExecutionCommand(
            id=int(row["id"]),
            command_hash=str(row["command_hash"]),
            payload_hash=str(row["payload_hash"]),
            idempotency_key=str(row["idempotency_key"]),
            kind=str(row["kind"]),
            payload_json=str(row["payload_json"]),
            command_json=str(row["command_json"]),
            permit_json=str(row["permit_json"]),
            created_at=float(row["created_at"]),
            accepted_cursor=int(row["accepted_cursor"]),
            accepted_sequence=int(accepted_sequence),
        )

    @staticmethod
    def _lifecycle_event_from_row(row: sqlite3.Row) -> LifecycleEvent:
        try:
            raw = str(row["event_json"])
            decoded = json.loads(raw)
            parsed = validate_execution_event(decoded)
            if stable_stringify(parsed) != raw:
                raise ContractValidationError("stored lifecycle event is not canonical")
            sequence = int(row["sequence"])
            event_id = str(row["event_id"])
            command_hash = str(row["command_hash"])
            kind = str(row["event_kind"])
            if (
                parsed["sequence"] != str(sequence)
                or parsed["eventId"] != event_id
                or parsed["commandId"] != command_hash
                or parsed["kind"] != kind
            ):
                raise ContractValidationError("stored lifecycle columns disagree with event")
            created_at = Ledger._required_epoch_seconds(
                row["created_at"], field="lifecycle_created_at"
            )
        except (ContractValidationError, TypeError, ValueError, KeyError, json.JSONDecodeError):
            raise MalformedLifecycleRecord("stored lifecycle event is malformed") from None
        return LifecycleEvent(
            sequence=sequence,
            event_id=event_id,
            command_hash=command_hash,
            kind=kind,
            event_json=raw,
            created_at=created_at,
        )

    @staticmethod
    def _snapshot_from_row(row: sqlite3.Row) -> Snapshot:
        return Snapshot(
            account_id=str(row["account_id"]),
            symbol=str(row["symbol"]),
            snapshot_json=str(row["snapshot_json"]),
            as_of_cursor=int(row["as_of_cursor"]),
            updated_at=float(row["updated_at"]),
        )

    @staticmethod
    def _lifecycle_snapshot_from_row(row: sqlite3.Row) -> LifecycleSnapshot:
        try:
            account_id = str(row["account_id"])
            symbol = str(row["symbol"])
            if (
                not account_id
                or account_id != account_id.strip()
                or len(account_id) > 200
                or symbol != "BTC/USDT"
            ):
                raise ValueError("invalid lifecycle snapshot scope")
            raw = str(row["snapshot_json"])
            decoded = json.loads(raw)
            if stable_stringify(decoded) != raw:
                raise ContractValidationError("stored lifecycle snapshot is not canonical")
            sequence = int(row["as_of_sequence"])
            if sequence < 0:
                raise ValueError("negative snapshot sequence")
            updated_at = Ledger._required_epoch_seconds(
                row["updated_at"], field="lifecycle_snapshot_updated_at"
            )
        except (ContractValidationError, TypeError, ValueError, json.JSONDecodeError):
            raise MalformedLifecycleRecord("stored lifecycle snapshot is malformed") from None
        return LifecycleSnapshot(
            account_id=account_id,
            symbol=symbol,
            snapshot_json=raw,
            as_of_sequence=sequence,
            updated_at=updated_at,
        )

    @staticmethod
    def _require_sha256_hex(value: str, *, field: str) -> None:
        if _SHA256_HEX.fullmatch(value) is None:
            raise ValueError(f"{field} must be exactly 64 lowercase hexadecimal characters")

    @staticmethod
    def _offline_adapter_policy_v1(policy: Mapping[str, Any] | Any) -> dict[str, Any]:
        """Validate the deliberately narrow, simulator-only policy identity."""
        if not isinstance(policy, Mapping):
            raise ValueError("offline adapter policy must be a mapping")
        required = {
            "schemaVersion", "receiptSchemaVersion", "receiptScope", "mode",
            "adapterId", "adapterBuildHash", "adapterConfigHash", "adapterRunId",
            "sourceNamespaceId", "adapterKeyId", "adapterPublicKeySpkiSha256",
            "permitAuthorityKeyId", "permitAuthorityPublicKeySpkiSha256",
            "capability", "ensureExact", "finalizationEligible",
        }
        if set(policy) != required:
            raise ValueError("offline adapter policy fields are not exact")
        value = dict(policy)
        literals = {
            "schemaVersion": "openalice_offline_adapter_policy.v1",
            "receiptSchemaVersion": OFFLINE_EXECUTION_RECEIPT_V1,
            "receiptScope": OFFLINE_EXECUTION_RECEIPT_SCOPE,
            "mode": "PAPER_LOCAL",
            "capability": "offline_simulator.ensure_exact.v1",
            "ensureExact": True,
            "finalizationEligible": False,
        }
        for field, expected in literals.items():
            if value.get(field) != expected:
                raise ValueError(f"offline adapter policy {field} is not the required literal")
        for field, maximum in (("adapterId", 200), ("adapterRunId", 300)):
            item = value.get(field)
            if not isinstance(item, str) or not item or item != item.strip() or len(item) > maximum:
                raise ValueError(f"offline adapter policy {field} is invalid")
        for field in (
            "adapterBuildHash", "adapterConfigHash", "sourceNamespaceId",
            "adapterPublicKeySpkiSha256", "permitAuthorityPublicKeySpkiSha256",
        ):
            item = value.get(field)
            if not isinstance(item, str):
                raise ValueError(f"offline adapter policy {field} must be a SHA-256 hash")
            Ledger._require_sha256_hex(item, field=field)
        for field in ("adapterKeyId", "permitAuthorityKeyId"):
            item = value.get(field)
            if (
                not isinstance(item, str)
                or re.fullmatch(r"[A-Za-z0-9._-]{1,100}", item) is None
            ):
                raise ValueError(f"offline adapter policy {field} is invalid")
        if value["adapterKeyId"] == value["permitAuthorityKeyId"]:
            raise ValueError("offline adapter and permit authority keys must be distinct")
        if (
            value["adapterPublicKeySpkiSha256"]
            == value["permitAuthorityPublicKeySpkiSha256"]
        ):
            raise ValueError(
                "offline adapter and permit authority key material must be distinct"
            )
        return value

    @staticmethod
    def _offline_adapter_policy(policy: Mapping[str, Any] | Any) -> dict[str, Any]:
        """Accept historical V1/V2 diagnostics or source-authenticated V3.

        V1/V2 remain readable solely for historical diagnosis.  Only V3 binds
        the independent simulator store and source-attestation trust root.
        """
        if not isinstance(policy, Mapping):
            raise ValueError("offline adapter policy must be a mapping")
        if policy.get("schemaVersion") == "openalice_offline_adapter_policy.v1":
            return Ledger._offline_adapter_policy_v1(policy)
        if policy.get("schemaVersion") == "openalice_offline_adapter_policy.v3":
            required_v3 = {
                "schemaVersion", "receiptSchemaVersion", "receiptScope", "mode",
                "adapterId", "adapterBuildHash", "adapterConfigHash", "adapterRunId",
                "sourceNamespaceId", "adapterKeyId", "adapterPublicKeySpkiSha256",
                "permitAuthorityKeyId", "permitAuthorityPublicKeySpkiSha256",
                "simulatorCapabilityAuthorityKeyId",
                "simulatorCapabilityAuthorityPublicKeySpkiSha256",
                "simulatorStoreId", "sourceAttestationKeyId",
                "sourceAttestationPublicKeySpkiSha256",
                "capability", "ensureExact", "finalizationEligible",
            }
            if set(policy) != required_v3:
                raise ValueError("offline adapter policy V3 fields are not exact")
            candidate_v3 = dict(policy)
            v2_projection = dict(candidate_v3)
            for field in (
                "simulatorStoreId",
                "sourceAttestationKeyId",
                "sourceAttestationPublicKeySpkiSha256",
            ):
                del v2_projection[field]
            v2_projection["schemaVersion"] = "openalice_offline_adapter_policy.v2"
            Ledger._offline_adapter_policy(v2_projection)
            simulator_store_id = candidate_v3["simulatorStoreId"]
            source_key_id = candidate_v3["sourceAttestationKeyId"]
            source_fingerprint = candidate_v3[
                "sourceAttestationPublicKeySpkiSha256"
            ]
            if not isinstance(simulator_store_id, str):
                raise ValueError("offline simulator store id is invalid")
            Ledger._require_sha256_hex(
                simulator_store_id, field="simulatorStoreId"
            )
            if (
                not isinstance(source_key_id, str)
                or re.fullmatch(r"[A-Za-z0-9._-]{1,100}", source_key_id) is None
            ):
                raise ValueError("offline source attestation key id is invalid")
            if not isinstance(source_fingerprint, str):
                raise ValueError(
                    "offline source attestation public key fingerprint is invalid"
                )
            Ledger._require_sha256_hex(
                source_fingerprint,
                field="sourceAttestationPublicKeySpkiSha256",
            )
            if source_key_id in {
                candidate_v3["adapterKeyId"],
                candidate_v3["permitAuthorityKeyId"],
                candidate_v3["simulatorCapabilityAuthorityKeyId"],
            }:
                raise ValueError("offline authority key ids must use four distinct roles")
            if source_fingerprint in {
                candidate_v3["adapterPublicKeySpkiSha256"],
                candidate_v3["permitAuthorityPublicKeySpkiSha256"],
                candidate_v3[
                    "simulatorCapabilityAuthorityPublicKeySpkiSha256"
                ],
            }:
                raise ValueError(
                    "offline authority key material must use four distinct roles"
                )
            return candidate_v3
        required = {
            "schemaVersion", "receiptSchemaVersion", "receiptScope", "mode",
            "adapterId", "adapterBuildHash", "adapterConfigHash", "adapterRunId",
            "sourceNamespaceId", "adapterKeyId", "adapterPublicKeySpkiSha256",
            "permitAuthorityKeyId", "permitAuthorityPublicKeySpkiSha256",
            "simulatorCapabilityAuthorityKeyId",
            "simulatorCapabilityAuthorityPublicKeySpkiSha256",
            "capability", "ensureExact", "finalizationEligible",
        }
        if set(policy) != required:
            raise ValueError("offline adapter policy V2 fields are not exact")
        candidate = dict(policy)
        if (
            candidate["schemaVersion"] != "openalice_offline_adapter_policy.v2"
            or candidate["capability"] != "offline_simulator.ensure_exact.v2"
        ):
            raise ValueError("offline adapter policy V2 literals are invalid")
        v1_projection = dict(candidate)
        del v1_projection["simulatorCapabilityAuthorityKeyId"]
        del v1_projection["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
        v1_projection["schemaVersion"] = "openalice_offline_adapter_policy.v1"
        v1_projection["capability"] = "offline_simulator.ensure_exact.v1"
        Ledger._offline_adapter_policy_v1(v1_projection)
        key_id = candidate["simulatorCapabilityAuthorityKeyId"]
        fingerprint = candidate["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
        if not isinstance(key_id, str) or re.fullmatch(r"[A-Za-z0-9._-]{1,100}", key_id) is None:
            raise ValueError("offline simulator capability authority key id is invalid")
        if not isinstance(fingerprint, str):
            raise ValueError("offline simulator capability authority fingerprint is invalid")
        Ledger._require_sha256_hex(fingerprint, field="simulatorCapabilityAuthorityPublicKeySpkiSha256")
        if key_id in {candidate["adapterKeyId"], candidate["permitAuthorityKeyId"]}:
            raise ValueError("offline authority key ids must use three distinct roles")
        if fingerprint in {
            candidate["adapterPublicKeySpkiSha256"],
            candidate["permitAuthorityPublicKeySpkiSha256"],
        }:
            raise ValueError("offline authority key material must use three distinct roles")
        return candidate

    def _assert_local_offline_policy_authorities(
        self, policy: Mapping[str, Any]
    ) -> tuple[Any, Any, Any]:
        """Return constructor-pinned receipt, capability, and source keys."""
        if policy.get("schemaVersion") != "openalice_offline_adapter_policy.v3":
            raise OfflineDispatchUnavailable(
                "offline execution requires source-authenticated V3 policy"
            )
        receipt_private_key = self._offline_receipt_signing_private_key
        if (
            receipt_private_key is None
            or self._offline_receipt_signing_key_id != policy["adapterKeyId"]
        ):
            raise OfflineDispatchUnavailable(
                "local receipt signer does not match frozen policy"
            )
        receipt_public_key = receipt_private_key.public_key()
        if (
            ed25519_public_key_fingerprint_sha256(receipt_public_key)
            != policy["adapterPublicKeySpkiSha256"]
        ):
            raise OfflineDispatchUnavailable(
                "local receipt signer does not match frozen policy"
            )
        if (
            self._offline_capability_authority_private_key is None
            or self._offline_capability_authority_key_id
            != policy["simulatorCapabilityAuthorityKeyId"]
        ):
            raise OfflineDispatchUnavailable(
                "local capability authority does not match frozen policy"
            )
        capability_public_key = (
            self._offline_capability_authority_private_key.public_key()
        )
        if (
            ed25519_public_key_fingerprint_sha256(capability_public_key)
            != policy["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
        ):
            raise OfflineDispatchUnavailable(
                "local capability authority does not match frozen policy"
            )
        source_public_key = self._offline_source_attestation_public_keys.get(
            policy["sourceAttestationKeyId"]
        )
        if source_public_key is None or (
            ed25519_public_key_fingerprint_sha256(source_public_key)
            != policy["sourceAttestationPublicKeySpkiSha256"]
        ):
            raise OfflineDispatchUnavailable(
                "local source attestation key does not match frozen policy"
            )
        return receipt_public_key, capability_public_key, source_public_key

    @staticmethod
    def _iso_timestamp_to_epoch(value: Any, *, field: str) -> float:
        if not isinstance(value, str) or re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z", value
        ) is None:
            raise MalformedOfflineDispatchRecord(f"{field} is not a canonical UTC timestamp")
        try:
            return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(
                tzinfo=timezone.utc
            ).timestamp()
        except ValueError:
            raise MalformedOfflineDispatchRecord(f"{field} is not a valid UTC timestamp") from None

    @staticmethod
    def _offline_policy_from_row(row: sqlite3.Row) -> OfflineAdapterPolicy:
        try:
            policy_hash = str(row["policy_hash"])
            Ledger._require_sha256_hex(policy_hash, field="policy_hash")
            policy_json = str(row["policy_json"])
            value = Ledger._offline_adapter_policy(json.loads(policy_json))
            if stable_stringify(value) != policy_json or sha256_canonical(value) != policy_hash:
                raise ValueError("offline adapter policy storage binding mismatch")
            created_at = Ledger._required_epoch_seconds(row["created_at"], field="policy_created_at")
        except (TypeError, ValueError, json.JSONDecodeError, ContractValidationError):
            raise MalformedOfflineDispatchRecord("stored offline adapter policy is malformed") from None
        return OfflineAdapterPolicy(policy_hash=policy_hash, policy_json=policy_json, created_at=created_at)

    @staticmethod
    def _dispatch_from_row(row: sqlite3.Row) -> ExecutionDispatch:
        try:
            command_hash = str(row["command_hash"])
            policy_hash = str(row["policy_hash"])
            Ledger._require_sha256_hex(command_hash, field="command_hash")
            Ledger._require_sha256_hex(policy_hash, field="policy_hash")
            state = str(row["state"])
            if state not in {"DISPATCH_PENDING", "IN_FLIGHT", "RECONCILIATION_REQUIRED", "RECEIPT_COMMITTED"}:
                raise ValueError("invalid offline dispatch state")
            original = row["original_attempt_id"]
            armed = row["dispatch_armed_at"]
            claim = row["reconciliation_claim_id"]
            if state == "DISPATCH_PENDING" and any(item is not None for item in (original, armed, claim, row["receipt_head_id"], row["transition_number"], row["source_sequence"])):
                raise ValueError("pending dispatch carries mutable execution evidence")
            if state != "DISPATCH_PENDING":
                Ledger._require_sha256_hex(str(original), field="original_attempt_id")
                Ledger._iso_timestamp_to_epoch(armed, field="dispatch_armed_at")
            if claim is not None:
                Ledger._require_sha256_hex(str(claim), field="reconciliation_claim_id")
            if state == "RECEIPT_COMMITTED":
                Ledger._require_sha256_hex(str(row["receipt_head_id"]), field="receipt_head_id")
                if not isinstance(row["transition_number"], str) or not re.fullmatch(r"[1-9][0-9]*", row["transition_number"]):
                    raise ValueError("invalid receipt transition number")
                if not isinstance(row["source_sequence"], str) or not re.fullmatch(r"[1-9][0-9]*", row["source_sequence"]):
                    raise ValueError("invalid receipt source sequence")
            elif any(row[field] is not None for field in ("receipt_head_id", "transition_number", "source_sequence")):
                raise ValueError("uncommitted dispatch carries receipt head")
            return ExecutionDispatch(
                command_hash=command_hash, policy_hash=policy_hash, state=state,
                original_attempt_id=None if original is None else str(original),
                dispatch_armed_at=None if armed is None else str(armed),
                reconciliation_claim_id=None if claim is None else str(claim),
                receipt_head_id=None if row["receipt_head_id"] is None else str(row["receipt_head_id"]),
                transition_number=None if row["transition_number"] is None else str(row["transition_number"]),
                source_sequence=None if row["source_sequence"] is None else str(row["source_sequence"]),
                created_at=Ledger._required_epoch_seconds(row["created_at"], field="dispatch_created_at"),
                updated_at=Ledger._required_epoch_seconds(row["updated_at"], field="dispatch_updated_at"),
            )
        except (TypeError, ValueError):
            raise MalformedOfflineDispatchRecord("stored execution dispatch is malformed") from None

    @staticmethod
    def _attempt_from_row(row: sqlite3.Row) -> OfflineExecutionAttempt:
        try:
            attempt_id = str(row["attempt_id"])
            command_hash = str(row["command_hash"])
            policy_hash = str(row["policy_hash"])
            adapter_epoch = str(row["adapter_epoch"])
            attempt_number = str(row["attempt_number"])
            request_hash = str(row["request_hash"])
            for field, value in (("attempt_id", attempt_id), ("command_hash", command_hash), ("policy_hash", policy_hash), ("request_hash", request_hash)):
                Ledger._require_sha256_hex(value, field=field)
            request_json = str(row["canonical_request_json"])
            request = validate_offline_simulator_request_v1(json.loads(request_json))
            if stable_stringify(request) != request_json or sha256_canonical(request) != request_hash:
                raise ValueError("offline request bytes/hash mismatch")
            if (
                request["attemptId"] != attempt_id or request["commandId"] != command_hash
                or request["adapterEpoch"] != adapter_epoch or request["attemptNumber"] != attempt_number
            ):
                raise ValueError("offline attempt columns disagree with request")
            created_at = Ledger._required_epoch_seconds(row["created_at"], field="attempt_created_at")
        except (TypeError, ValueError, json.JSONDecodeError, ContractValidationError):
            raise MalformedOfflineDispatchRecord("stored execution attempt is malformed") from None
        return OfflineExecutionAttempt(attempt_id, command_hash, policy_hash, adapter_epoch, attempt_number, request_json, request_hash, created_at)

    @staticmethod
    def _reconciliation_claim_from_row(row: sqlite3.Row) -> OfflineReconciliationClaim:
        try:
            claim_id = str(row["claim_id"])
            command_hash = str(row["command_hash"])
            original = str(row["original_attempt_id"])
            for field, value in (("claim_id", claim_id), ("command_hash", command_hash), ("original_attempt_id", original)):
                Ledger._require_sha256_hex(value, field=field)
            epoch = int(row["writer_epoch"])
            if epoch <= 0 or str(row["status"]) not in {"ACTIVE", "FENCED", "COMPLETED"}:
                raise ValueError("invalid reconciliation claim")
            owner = str(row["owner_id"])
            name = str(row["writer_name"])
            if not owner or owner != owner.strip() or not name or name != name.strip():
                raise ValueError("invalid claim lease identity")
            created_at = Ledger._required_epoch_seconds(row["created_at"], field="claim_created_at")
        except (TypeError, ValueError):
            raise MalformedOfflineDispatchRecord("stored reconciliation claim is malformed") from None
        return OfflineReconciliationClaim(claim_id, command_hash, original, name, owner, epoch, str(row["status"]), created_at)

    def _append_event_in_transaction(
        self,
        connection: sqlite3.Connection,
        event_type: str,
        payload: Any,
        *,
        command_id: int | None,
        now: float,
    ) -> Event:
        cursor = connection.execute(
            """
            INSERT INTO events(event_type, command_id, payload_json, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (event_type, command_id, _canonical_json(payload), now),
        ).lastrowid
        row = connection.execute("SELECT * FROM events WHERE cursor = ?", (cursor,)).fetchone()
        assert row is not None
        return self._event_from_row(row)

    def _append_lifecycle_event_in_transaction(
        self,
        connection: sqlite3.Connection,
        *,
        event_core: Mapping[str, Any],
        now: float,
    ) -> LifecycleEvent:
        """Build, validate, and append exactly the next lifecycle event."""
        expected_sequence = self._latest_lifecycle_sequence_in_transaction(connection) + 1
        candidate = dict(event_core)
        candidate["sequence"] = str(expected_sequence)
        try:
            event = build_execution_event_v1(candidate)
            parsed = validate_execution_event_v1(event)
            event_json = stable_stringify(parsed)
        except (ContractValidationError, TypeError, ValueError, KeyError):
            raise MalformedLifecycleRecord("lifecycle event construction failed") from None
        connection.execute(
            """
            INSERT INTO lifecycle_events(
                sequence, event_id, command_hash, event_kind, event_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                expected_sequence,
                parsed["eventId"],
                parsed["commandId"],
                parsed["kind"],
                event_json,
                now,
            ),
        )
        row = connection.execute(
            "SELECT * FROM lifecycle_events WHERE sequence = ?", (expected_sequence,)
        ).fetchone()
        assert row is not None
        return self._lifecycle_event_from_row(row)

    @staticmethod
    def _latest_lifecycle_sequence_in_transaction(connection: sqlite3.Connection) -> int:
        row = connection.execute(
            """
            SELECT COALESCE(MAX(sequence), 0) AS latest, COUNT(*) AS event_count
            FROM lifecycle_events
            """
        ).fetchone()
        latest = int(row["latest"])
        event_count = int(row["event_count"])
        # With a positive, unique integer primary key, count == max proves the
        # set is exactly 1..max. Never allocate beyond or advertise through a
        # gap introduced by corruption or an out-of-band writer.
        if latest != event_count:
            raise LifecycleSequenceGap(
                f"lifecycle sequence latest {latest} disagrees with count {event_count}"
            )
        return latest

    def _validate_lifecycle_sequence_in_transaction(
        self, connection: sqlite3.Connection
    ) -> None:
        rows = connection.execute(
            "SELECT * FROM lifecycle_events ORDER BY sequence ASC"
        ).fetchall()
        for expected, row in enumerate(rows, start=1):
            event = self._lifecycle_event_from_row(row)
            if event.sequence != expected:
                raise LifecycleSequenceGap(
                    f"lifecycle sequence expected {expected}, found {event.sequence}"
                )

    def _backfill_execution_lifecycle_in_transaction(
        self, connection: sqlite3.Connection
    ) -> None:
        """Deterministically migrate legacy execution admissions in audit order."""
        rows = connection.execute(
            """
            SELECT * FROM execution_commands
            ORDER BY accepted_cursor ASC, id ASC
            """
        ).fetchall()
        for row in rows:
            try:
                command = validate_execution_command_v1(
                    json.loads(str(row["command_json"]))
                )
                if stable_stringify(command) != str(row["command_json"]):
                    raise ContractValidationError("legacy command JSON is not canonical")
                if (
                    command["commandId"] != str(row["command_hash"])
                    or command["payloadHash"] != str(row["payload_hash"])
                    or command["payload"]["idempotencyKey"]
                    != str(row["idempotency_key"])
                    or command["payload"]["kind"] != str(row["kind"])
                    or stable_stringify(command["payload"]) != str(row["payload_json"])
                ):
                    raise ContractValidationError(
                        "legacy command columns disagree with command JSON"
                    )
                audit_row = connection.execute(
                    "SELECT * FROM events WHERE cursor = ?",
                    (int(row["accepted_cursor"]),),
                ).fetchone()
                if (
                    audit_row is None
                    or str(audit_row["event_type"]) != "execution_command_accepted"
                    or audit_row["command_id"] is not None
                    or float(audit_row["created_at"]) != float(row["created_at"])
                ):
                    raise ContractValidationError("legacy accepted audit event is missing")
                audit_payload = json.loads(str(audit_row["payload_json"]))
                expected_audit_payload = {
                    "command_hash": command["commandId"],
                    "payload_hash": command["payloadHash"],
                    "idempotency_key": command["payload"]["idempotencyKey"],
                    "kind": command["payload"]["kind"],
                }
                if (
                    audit_payload != expected_audit_payload
                    or _canonical_json(audit_payload) != str(audit_row["payload_json"])
                ):
                    raise ContractValidationError(
                        "legacy accepted audit payload is malformed"
                    )
            except (
                ContractValidationError,
                TypeError,
                ValueError,
                KeyError,
                json.JSONDecodeError,
            ):
                raise MalformedLifecycleRecord(
                    "legacy execution command cannot be backfilled"
                ) from None
            accepted_sequence = row["accepted_sequence"]
            if accepted_sequence is not None:
                stored_event = connection.execute(
                    "SELECT * FROM lifecycle_events WHERE sequence = ?",
                    (int(accepted_sequence),),
                ).fetchone()
                if stored_event is None:
                    raise LifecycleSequenceGap(
                        "accepted_sequence does not reference a lifecycle event"
                    )
                event = self._lifecycle_event_from_row(stored_event)
                if event.command_hash != str(row["command_hash"]) or event.kind != "acknowledged":
                    raise MalformedLifecycleRecord(
                        "accepted_sequence does not reference its acknowledged command"
                    )
                continue
            try:
                payload = command["payload"]
                event_core: dict[str, Any] = {
                    "schemaVersion": "openalice_execution_event.v1",
                    "commandId": command["commandId"],
                    "occurredAt": self._canonical_timestamp(float(row["created_at"])),
                    "kind": "acknowledged",
                }
                if payload["kind"] == "submit":
                    event_core["clientOrderId"] = payload["clientOrderId"]
            except (
                ContractValidationError,
                TypeError,
                ValueError,
                KeyError,
                json.JSONDecodeError,
                OverflowError,
                OSError,
            ):
                raise MalformedLifecycleRecord(
                    "legacy execution command cannot be backfilled"
                ) from None
            event = self._append_lifecycle_event_in_transaction(
                connection,
                event_core=event_core,
                now=float(row["created_at"]),
            )
            connection.execute(
                "UPDATE execution_commands SET accepted_sequence = ? WHERE id = ?",
                (event.sequence, int(row["id"])),
            )

    @staticmethod
    def _canonical_timestamp(epoch_seconds: float) -> str:
        value = Ledger._required_epoch_seconds(epoch_seconds, field="occurred_at")
        moment = datetime.fromtimestamp(value, tz=timezone.utc)
        return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"

    def _assert_lease_in_transaction(
        self,
        connection: sqlite3.Connection,
        lease: Lease,
        *,
        now: float,
    ) -> None:
        now = self._required_epoch_seconds(now, field="fencing_time")
        row = connection.execute(
            "SELECT owner_id, epoch, expires_at FROM writer_lease WHERE name = ?",
            (lease.name,),
        ).fetchone()
        if row is None:
            raise StaleLease(f"writer lease {lease.name!r} does not exist")
        if (
            row["owner_id"] != lease.owner_id
            or int(row["epoch"]) != lease.epoch
            or float(row["expires_at"]) <= now
        ):
            raise StaleLease(f"writer lease {lease.name!r} is stale or fenced")

    def _trusted_fencing_time(self) -> float:
        """Read the lease authority clock only after the write lock is held."""
        return self._required_epoch_seconds(self._fencing_clock(), field="fencing_clock")

    @staticmethod
    def _required_epoch_seconds(value: Any, *, field: str) -> float:
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            raise ValueError(f"{field} must be finite epoch seconds")
        return float(value)

    @staticmethod
    def _optional_epoch_seconds(value: float | None, *, field: str) -> float | None:
        if value is None:
            return None
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError(f"{field} must be finite epoch seconds or None")
        return Ledger._required_epoch_seconds(value, field=field)

    @staticmethod
    def _latest_cursor_in_transaction(connection: sqlite3.Connection) -> int:
        return int(connection.execute("SELECT COALESCE(MAX(cursor), 0) FROM events").fetchone()[0])

    def _raise_if_suspended_in_transaction(self, connection: sqlite3.Connection) -> None:
        state = connection.execute(
            "SELECT mode, circuit_reason FROM runtime_state WHERE state_key = 'global'"
        ).fetchone()
        if state is not None and state["mode"] == "suspended":
            reason = state["circuit_reason"] or "unspecified"
            raise RuntimeSuspended(f"runtime is suspended: {reason}")

    def _suspend_in_transaction(
        self,
        connection: sqlite3.Connection,
        *,
        reason: str,
        now: float,
        event_type: str,
        event_payload: Any,
    ) -> Event:
        connection.execute(
            """
            INSERT INTO runtime_state(state_key, mode, circuit_reason, updated_at)
            VALUES ('global', 'suspended', ?, ?)
            ON CONFLICT(state_key) DO UPDATE SET
                mode = excluded.mode,
                circuit_reason = excluded.circuit_reason,
                updated_at = excluded.updated_at
            """,
            (reason, now),
        )
        return self._append_event_in_transaction(
            connection, event_type, event_payload, command_id=None, now=now
        )

    def submit_command(
        self,
        *,
        idempotency_key: str,
        payload_hash: str,
        command_type: str,
        payload: Any,
        writer_lease: Lease,
        now: float | None = None,
    ) -> CommandReceipt:
        """Durably record one command without executing it.

        Repeating a key with the same hash returns the original command without
        emitting another event.  Repeating it with a different hash atomically
        suspends the runtime, records a circuit reason/event, and raises
        :class:`IdempotencyConflict` before any new command can be inserted.
        While suspended, only an exact replay of an already-recorded command is
        admitted; a new idempotency key raises :class:`RuntimeSuspended`.
        """
        if not idempotency_key or not payload_hash or not command_type:
            raise ValueError("idempotency_key, payload_hash, and command_type are required")
        self._require_sha256_hex(payload_hash, field="payload_hash")
        computed_payload_hash = _canonical_payload_hash(payload)
        conflict_message: str | None = None
        with self._transaction() as connection:
            # Event time may be deterministic; fencing authority must be
            # freshly sampled after BEGIN IMMEDIATE acquires the write lock.
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            existing = connection.execute(
                "SELECT * FROM commands WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
            if existing is not None:
                command = self._command_from_row(existing)
                # Compare canonical payload content before trusting the caller's
                # declaration. A caller cannot mask a changed payload by
                # replaying the original declared hash.
                if command.payload_hash == computed_payload_hash:
                    if payload_hash != computed_payload_hash:
                        raise PayloadHashMismatch(
                            "payload_hash does not match SHA-256(canonical payload JSON)"
                        )
                    return CommandReceipt(command=command, created=False)
                reason = "idempotency_key_payload_hash_mismatch"
                connection.execute(
                    """
                    INSERT INTO runtime_state(state_key, mode, circuit_reason, updated_at)
                    VALUES ('global', 'suspended', ?, ?)
                    ON CONFLICT(state_key) DO UPDATE SET
                        mode = excluded.mode,
                        circuit_reason = excluded.circuit_reason,
                        updated_at = excluded.updated_at
                    """,
                    (reason, timestamp),
                )
                self._append_event_in_transaction(
                    connection,
                    "idempotency_conflict",
                    {
                        "idempotency_key": idempotency_key,
                        "existing_payload_hash": command.payload_hash,
                        "received_payload_hash": computed_payload_hash,
                        "declared_payload_hash": payload_hash,
                        "reason": reason,
                    },
                    command_id=command.id,
                    now=timestamp,
                )
                # The fail-closed state must commit before the caller sees the
                # exception. Raising inside the context would roll it back.
                conflict_message = (
                    f"idempotency key {idempotency_key!r} was reused with a different payload hash"
                )
            else:
                self._raise_if_suspended_in_transaction(connection)
                if payload_hash != computed_payload_hash:
                    raise PayloadHashMismatch(
                        "payload_hash does not match SHA-256(canonical payload JSON)"
                    )
                command_id = connection.execute(
                    """
                    INSERT INTO commands(idempotency_key, payload_hash, command_type, payload_json, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        idempotency_key,
                        computed_payload_hash,
                        command_type,
                        _canonical_json(payload),
                        timestamp,
                    ),
                ).lastrowid
                row = connection.execute("SELECT * FROM commands WHERE id = ?", (command_id,)).fetchone()
                assert row is not None
                command = self._command_from_row(row)
                self._append_event_in_transaction(
                    connection,
                    "command_recorded",
                    {
                        "idempotency_key": idempotency_key,
                        "payload_hash": computed_payload_hash,
                        "command_type": command_type,
                    },
                    command_id=command.id,
                    now=timestamp,
                )
                return CommandReceipt(command=command, created=True)
        assert conflict_message is not None
        raise IdempotencyConflict(conflict_message)

    def get_command_by_hash(self, command_hash: str) -> ExecutionCommand | None:
        """Read a previously admitted execution command by its canonical hash."""
        self._require_sha256_hex(command_hash, field="command_hash")
        row = self._connection.execute(
            "SELECT * FROM execution_commands WHERE command_hash = ?", (command_hash,)
        ).fetchone()
        if row is None:
            return None
        stored = self._execution_command_from_row(row)
        event_row = self._connection.execute(
            "SELECT * FROM lifecycle_events WHERE sequence = ?",
            (stored.accepted_sequence,),
        ).fetchone()
        if event_row is None:
            raise LifecycleSequenceGap(
                "accepted_sequence does not reference a lifecycle event"
            )
        accepted = self._lifecycle_event_from_row(event_row)
        if accepted.command_hash != stored.command_hash or accepted.kind != "acknowledged":
            raise MalformedLifecycleRecord(
                "accepted_sequence does not reference its acknowledged command"
            )
        return stored

    def latest_cursor(self) -> int:
        """Return the latest durable event sequence, or zero before the first event."""
        return self._latest_cursor_in_transaction(self._connection)

    def latest_lifecycle_sequence(self) -> int:
        """Return only the execution lifecycle sequence, never a generic cursor."""
        latest = self._latest_lifecycle_sequence_in_transaction(self._connection)
        if latest < 0:
            raise LifecycleSequenceGap("latest lifecycle sequence is negative")
        return latest

    def upsert_snapshot(
        self,
        *,
        account_id: str,
        symbol: str,
        snapshot: Any,
        as_of_cursor: int,
        writer_lease: Lease,
        now: float | None = None,
    ) -> Snapshot:
        """Atomically store a non-regressing account/symbol snapshot under a lease."""
        if not account_id or not symbol or as_of_cursor < 0:
            raise ValueError("account_id, symbol, and a non-negative as_of_cursor are required")
        canonical_snapshot = _canonical_json(snapshot)
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            latest = self._latest_cursor_in_transaction(connection)
            if as_of_cursor > latest:
                raise SnapshotCursorAhead(
                    f"snapshot as_of_cursor {as_of_cursor} exceeds latest cursor {latest}"
                )
            current = connection.execute(
                "SELECT as_of_cursor FROM snapshots WHERE account_id = ? AND symbol = ?",
                (account_id, symbol),
            ).fetchone()
            if current is not None and as_of_cursor < int(current["as_of_cursor"]):
                raise SnapshotRegression(
                    f"snapshot cursor {as_of_cursor} regresses from {current['as_of_cursor']}"
                )
            connection.execute(
                """
                INSERT INTO snapshots(account_id, symbol, snapshot_json, as_of_cursor, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(account_id, symbol) DO UPDATE SET
                    snapshot_json = excluded.snapshot_json,
                    as_of_cursor = excluded.as_of_cursor,
                    updated_at = excluded.updated_at
                """,
                (account_id, symbol, canonical_snapshot, as_of_cursor, timestamp),
            )
            row = connection.execute(
                "SELECT * FROM snapshots WHERE account_id = ? AND symbol = ?", (account_id, symbol)
            ).fetchone()
            assert row is not None
            return self._snapshot_from_row(row)

    def get_snapshot(self, *, account_id: str, symbol: str) -> Snapshot | None:
        """Read the latest snapshot for one account/symbol identity."""
        row = self._connection.execute(
            "SELECT * FROM snapshots WHERE account_id = ? AND symbol = ?", (account_id, symbol)
        ).fetchone()
        return None if row is None else self._snapshot_from_row(row)

    def upsert_lifecycle_snapshot(
        self,
        *,
        account_id: str,
        symbol: str,
        snapshot: Any,
        as_of_sequence: int,
        writer_lease: Lease,
        now: float | None = None,
    ) -> LifecycleSnapshot:
        """Store opaque canonical diagnostics against the lifecycle sequence.

        This table is intentionally separate from legacy ``snapshots`` because
        ``snapshots.as_of_cursor`` is a generic audit cursor and cannot safely
        be exposed as an execution lifecycle sequence.
        """
        if (
            not isinstance(account_id, str)
            or not account_id
            or account_id != account_id.strip()
            or len(account_id) > 200
            or not isinstance(symbol, str)
            or symbol != "BTC/USDT"
            or type(as_of_sequence) is not int
            or as_of_sequence < 0
        ):
            raise ValueError(
                "account_id, symbol, and a non-negative integer as_of_sequence are required"
            )
        try:
            canonical_snapshot = stable_stringify(snapshot)
            # A round trip proves valid canonical UTF-8 JSON without attaching
            # any broker/order-terminal meaning to the opaque diagnostic.
            if stable_stringify(json.loads(canonical_snapshot)) != canonical_snapshot:
                raise ContractValidationError("snapshot canonicalization failed")
        except (ContractValidationError, TypeError, ValueError, json.JSONDecodeError):
            raise ValueError("snapshot must be canonicalizable JSON") from None
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            latest = self._latest_lifecycle_sequence_in_transaction(connection)
            if as_of_sequence > latest:
                raise SnapshotCursorAhead(
                    f"snapshot as_of_sequence {as_of_sequence} exceeds latest lifecycle sequence {latest}"
                )
            current = connection.execute(
                """
                SELECT as_of_sequence FROM lifecycle_snapshots
                WHERE account_id = ? AND symbol = ?
                """,
                (account_id, symbol),
            ).fetchone()
            if current is not None and as_of_sequence < int(current["as_of_sequence"]):
                raise SnapshotRegression(
                    f"snapshot sequence {as_of_sequence} regresses from {current['as_of_sequence']}"
                )
            connection.execute(
                """
                INSERT INTO lifecycle_snapshots(
                    account_id, symbol, snapshot_json, as_of_sequence, updated_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(account_id, symbol) DO UPDATE SET
                    snapshot_json = excluded.snapshot_json,
                    as_of_sequence = excluded.as_of_sequence,
                    updated_at = excluded.updated_at
                """,
                (account_id, symbol, canonical_snapshot, as_of_sequence, timestamp),
            )
            row = connection.execute(
                """
                SELECT * FROM lifecycle_snapshots
                WHERE account_id = ? AND symbol = ?
                """,
                (account_id, symbol),
            ).fetchone()
            assert row is not None
            return self._lifecycle_snapshot_from_row(row)

    def get_lifecycle_snapshot(
        self, *, account_id: str, symbol: str
    ) -> LifecycleSnapshot | None:
        """Read only the dedicated lifecycle snapshot representation."""
        row = self._connection.execute(
            """
            SELECT * FROM lifecycle_snapshots
            WHERE account_id = ? AND symbol = ?
            """,
            (account_id, symbol),
        ).fetchone()
        if row is None:
            return None
        snapshot = self._lifecycle_snapshot_from_row(row)
        latest = self._latest_lifecycle_sequence_in_transaction(self._connection)
        if snapshot.as_of_sequence > latest:
            raise MalformedLifecycleRecord(
                "stored lifecycle snapshot is ahead of the latest lifecycle sequence"
            )
        return snapshot

    def suspend(
        self,
        reason: str,
        *,
        writer_lease: Lease,
        now: float | None = None,
    ) -> Event:
        """Irreversibly suspend admission of new commands and record the reason."""
        if not reason:
            raise ValueError("suspension reason is required")
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            return self._suspend_in_transaction(
                connection,
                reason=reason,
                now=timestamp,
                event_type="runtime_suspended",
                event_payload={"reason": reason},
            )

    def admit_execution_command(
        self,
        *,
        command: Mapping[str, Any],
        permit: Mapping[str, Any],
        writer_lease: Lease,
        now: float | None = None,
        permit_expires_at: float | None = None,
        environment_expires_at: float | None = None,
        offline_adapter_policy_hash: str | None = None,
        permit_public_key: Any | None = None,
    ) -> ExecutionCommandReceipt:
        """Atomically admit one permit-bound execution command without executing it.

        This explicit Phase-3 admission path is separate from ``submit_command``.
        It accepts the public ``openalice_execution_command.v1`` mapping rather
        than an implementation-defined envelope. Exact duplicate admissions
        replay the stored accepted sequence without a new event; a changed
        command under an existing idempotency key fails closed.
        """
        required_keys = {"schemaVersion", "commandId", "payloadHash", "payload"}
        if set(command) != required_keys:
            raise ValueError("command keys must be exactly schemaVersion, commandId, payloadHash, payload")
        if command["schemaVersion"] != "openalice_execution_command.v1":
            raise ValueError("unsupported execution command schemaVersion")
        command_id = command["commandId"]
        declared_payload_hash = command["payloadHash"]
        payload = command["payload"]
        if not isinstance(command_id, str) or not isinstance(declared_payload_hash, str):
            raise ValueError("commandId and payloadHash must be strings")
        if not isinstance(payload, Mapping):
            raise ValueError("command payload must be a mapping")
        if not isinstance(permit, Mapping):
            raise ValueError("permit must be a mapping")
        idempotency_key = payload.get("idempotencyKey")
        kind = payload.get("kind")
        if not isinstance(idempotency_key, str) or not idempotency_key or not isinstance(kind, str) or not kind:
            raise ValueError("command payload requires non-empty idempotencyKey and kind")
        self._require_sha256_hex(command_id, field="commandId")
        self._require_sha256_hex(declared_payload_hash, field="payloadHash")
        permit_expiry = self._optional_epoch_seconds(
            permit_expires_at, field="permit_expires_at"
        )
        environment_expiry = self._optional_epoch_seconds(
            environment_expires_at, field="environment_expires_at"
        )
        if offline_adapter_policy_hash is not None:
            if not isinstance(offline_adapter_policy_hash, str):
                raise ValueError("offline_adapter_policy_hash must be a SHA-256 string or None")
            self._require_sha256_hex(
                offline_adapter_policy_hash, field="offline_adapter_policy_hash"
            )
            if kind != "submit" or payload.get("mode") != "PAPER_LOCAL":
                raise OfflineDispatchPolicyMismatch(
                    "offline adapter policy requires a PAPER_LOCAL submit command"
                )
        canonical_payload = _canonical_json(payload)
        computed_payload_hash = hashlib.sha256(canonical_payload.encode("utf-8")).hexdigest()
        canonical_command = _canonical_json(command)
        canonical_permit = _canonical_json(permit)

        timestamp = self._required_epoch_seconds(
            time.time() if now is None else now, field="now"
        )
        conflict_message: str | None = None
        with self._transaction() as connection:
            # Event time and fencing time have different semantics.  The core
            # may intentionally supply a deterministic event timestamp, while
            # lease authority must be sampled after the write lock is held.
            lease_timestamp = self._trusted_fencing_time()
            self._assert_lease_in_transaction(connection, writer_lease, now=lease_timestamp)
            # Environment authority is broader than a permit and therefore
            # takes precedence when both expire at the same sampled instant.
            if environment_expiry is not None and lease_timestamp >= environment_expiry:
                raise EnvironmentAuthorityExpired("execution environment authority expired")
            if permit_expiry is not None and lease_timestamp >= permit_expiry:
                raise PermitAuthorityExpired("execution permit authority expired")
            if offline_adapter_policy_hash is not None:
                policy_row = connection.execute(
                    "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?",
                    (offline_adapter_policy_hash,),
                ).fetchone()
                if policy_row is None:
                    raise OfflineDispatchPolicyMismatch("offline adapter policy is not registered")
                policy_value = self._offline_policy_from_row(policy_row).value
                if permit_public_key is None:
                    raise OfflineDispatchPolicyMismatch("offline admission requires the trusted permit public key")
                try:
                    if ed25519_public_key_fingerprint_sha256(permit_public_key) != policy_value["permitAuthorityPublicKeySpkiSha256"]:
                        raise ValueError("permit public key fingerprint mismatch")
                    proof = verify_execution_permit_v2(
                        permit=permit, command=command,
                        resolve_public_key=lambda key_id: permit_public_key if key_id == policy_value["permitAuthorityKeyId"] else None,
                        now=datetime.fromtimestamp(lease_timestamp, timezone.utc),
                    )
                    if not proof.valid:
                        raise ValueError(proof.reason or "permit verification failed")
                except (TypeError, ValueError):
                    raise OfflineDispatchPolicyMismatch("offline permit authority verification failed") from None
            existing = connection.execute(
                "SELECT * FROM execution_commands WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if existing is not None:
                stored = self._execution_command_from_row(existing)
                # Permit rotation must not alter the admitted command or its
                # original permit receipt. Command equality is permit-independent.
                if stored.command_json == canonical_command:
                    dispatch_row = connection.execute(
                        "SELECT * FROM execution_dispatches WHERE command_hash = ?",
                        (stored.command_hash,),
                    ).fetchone()
                    if dispatch_row is not None:
                        dispatch = self._dispatch_from_row(dispatch_row)
                        if (
                            offline_adapter_policy_hash is not None
                            and offline_adapter_policy_hash != dispatch.policy_hash
                        ):
                            raise OfflineDispatchPolicyMismatch(
                                "duplicate admission cannot change its offline adapter policy"
                            )
                    elif offline_adapter_policy_hash is not None:
                        raise OfflineDispatchPolicyMismatch(
                            "duplicate admission cannot attach a new offline adapter policy"
                        )
                    audit_row = connection.execute(
                        "SELECT * FROM events WHERE cursor = ?",
                        (stored.accepted_cursor,),
                    ).fetchone()
                    if audit_row is None:
                        raise MalformedLifecycleRecord(
                            "accepted_cursor does not reference its audit event"
                        )
                    audit_event = self._event_from_row(audit_row)
                    expected_audit_payload = {
                        "command_hash": stored.command_hash,
                        "payload_hash": stored.payload_hash,
                        "idempotency_key": stored.idempotency_key,
                        "kind": stored.kind,
                    }
                    if (
                        audit_event.event_type != "execution_command_accepted"
                        or audit_event.command_id is not None
                        or audit_event.created_at != stored.created_at
                        or audit_event.payload != expected_audit_payload
                        or _canonical_json(audit_event.payload) != audit_event.payload_json
                    ):
                        raise MalformedLifecycleRecord(
                            "accepted_cursor does not reference its audit event"
                        )
                    event_row = connection.execute(
                        "SELECT * FROM lifecycle_events WHERE sequence = ?",
                        (stored.accepted_sequence,),
                    ).fetchone()
                    if event_row is None:
                        raise LifecycleSequenceGap(
                            "accepted_sequence does not reference a lifecycle event"
                        )
                    accepted_event = self._lifecycle_event_from_row(event_row)
                    if (
                        accepted_event.command_hash != stored.command_hash
                        or accepted_event.kind != "acknowledged"
                    ):
                        raise MalformedLifecycleRecord(
                            "accepted_sequence does not reference its acknowledged command"
                        )
                    return ExecutionCommandReceipt(
                        command=stored,
                        accepted_event=audit_event,
                        accepted_lifecycle_event=accepted_event,
                        created=False,
                    )
                self._suspend_in_transaction(
                    connection,
                    reason="execution_idempotency_key_command_hash_mismatch",
                    now=timestamp,
                    event_type="execution_idempotency_conflict",
                    event_payload={
                        "idempotency_key": idempotency_key,
                        "existing_command_hash": stored.command_hash,
                        "received_command_hash": command_id,
                        "computed_payload_hash": computed_payload_hash,
                    },
                )
                conflict_message = (
                    f"execution idempotency key {idempotency_key!r} was reused with a different command"
                )
            else:
                if command_id != declared_payload_hash or command_id != computed_payload_hash:
                    raise CommandHashMismatch(
                        "commandId and payloadHash must equal SHA-256(canonical payload JSON)"
                    )
                self._raise_if_suspended_in_transaction(connection)
                audit_event = self._append_event_in_transaction(
                    connection,
                    "execution_command_accepted",
                    {
                        "command_hash": command_id,
                        "payload_hash": computed_payload_hash,
                        "idempotency_key": idempotency_key,
                        "kind": kind,
                    },
                    command_id=None,
                    now=timestamp,
                )
                lifecycle_core: dict[str, Any] = {
                    "schemaVersion": "openalice_execution_event.v1",
                    "commandId": command_id,
                    "occurredAt": self._canonical_timestamp(timestamp),
                    "kind": "acknowledged",
                }
                if kind == "submit":
                    client_order_id = payload.get("clientOrderId")
                    if not isinstance(client_order_id, str):
                        raise ValueError("submit command requires clientOrderId")
                    lifecycle_core["clientOrderId"] = client_order_id
                lifecycle_event = self._append_lifecycle_event_in_transaction(
                    connection,
                    event_core=lifecycle_core,
                    now=timestamp,
                )
                execution_row_id = connection.execute(
                    """
                    INSERT INTO execution_commands(
                        command_hash, payload_hash, idempotency_key, kind,
                        payload_json, command_json, permit_json, created_at,
                        accepted_cursor, accepted_sequence
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        command_id,
                        computed_payload_hash,
                        idempotency_key,
                        kind,
                        canonical_payload,
                        canonical_command,
                        canonical_permit,
                        timestamp,
                        audit_event.cursor,
                        lifecycle_event.sequence,
                    ),
                ).lastrowid
                row = connection.execute(
                    "SELECT * FROM execution_commands WHERE id = ?", (execution_row_id,)
                ).fetchone()
                assert row is not None
                # Existing callers retain their Phase-B behavior when no
                # policy is supplied.  An explicit policy binds only a newly
                # created local submit; retries cannot attach or replace it.
                if (
                    offline_adapter_policy_hash is not None
                    and kind == "submit"
                    and payload.get("mode") == "PAPER_LOCAL"
                ):
                    policy_row = connection.execute(
                        "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?",
                        (offline_adapter_policy_hash,),
                    ).fetchone()
                    assert policy_row is not None
                    policy = self._offline_policy_from_row(policy_row)
                    if (
                        policy.value["mode"] != "PAPER_LOCAL"
                        or policy.value["schemaVersion"]
                        != "openalice_offline_adapter_policy.v3"
                    ):
                        raise OfflineDispatchPolicyMismatch(
                            "offline dispatch requires PAPER_LOCAL V3 policy"
                        )
                    try:
                        self._assert_local_offline_policy_authorities(policy.value)
                    except OfflineDispatchUnavailable as error:
                        raise OfflineDispatchPolicyMismatch(str(error)) from error
                    connection.execute(
                        """
                        INSERT INTO execution_dispatches(
                            command_hash, policy_hash, state, original_attempt_id,
                            dispatch_armed_at, reconciliation_claim_id, created_at, updated_at
                        ) VALUES (?, ?, 'DISPATCH_PENDING', NULL, NULL, NULL, ?, ?)
                        """,
                        (command_id, policy.policy_hash, timestamp, timestamp),
                    )
                return ExecutionCommandReceipt(
                    command=self._execution_command_from_row(row),
                    accepted_event=audit_event,
                    accepted_lifecycle_event=lifecycle_event,
                    created=True,
                )
        assert conflict_message is not None
        raise IdempotencyConflict(conflict_message)

    def register_offline_adapter_policy(
        self,
        *,
        policy: Mapping[str, Any],
        writer_lease: Lease,
        now: float | None = None,
    ) -> OfflineAdapterPolicy:
        """Register one immutable simulator-only adapter identity under a lease."""
        parsed = self._offline_adapter_policy(policy)
        policy_json = stable_stringify(parsed)
        policy_hash = sha256_canonical(parsed)
        timestamp = self._required_epoch_seconds(
            time.time() if now is None else now, field="now"
        )
        with self._transaction() as connection:
            self._assert_lease_in_transaction(
                connection, writer_lease,
                now=self._trusted_fencing_time(),
            )
            existing = connection.execute(
                "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (policy_hash,)
            ).fetchone()
            if existing is None:
                connection.execute(
                    """
                    INSERT INTO offline_adapter_policies(policy_hash, policy_json, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (policy_hash, policy_json, timestamp),
                )
                existing = connection.execute(
                    "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (policy_hash,)
                ).fetchone()
                assert existing is not None
            return self._offline_policy_from_row(existing)

    def get_offline_adapter_policy(self, policy_hash: str) -> OfflineAdapterPolicy | None:
        self._require_sha256_hex(policy_hash, field="policy_hash")
        row = self._connection.execute(
            "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (policy_hash,)
        ).fetchone()
        return None if row is None else self._offline_policy_from_row(row)

    def require_local_offline_policy_authorities(
        self, policy_hash: str, *, permit_public_key: Any
    ) -> OfflineAdapterPolicy:
        """Require one registered V3 policy to match all local trust roots.

        This is a pure READY-time configuration check.  It deliberately
        accepts only the caller's public permit key; receipt signing,
        capability, and source-attestation authorities remain constructor
        dependencies and no private key is returned.
        """
        if not isinstance(policy_hash, str):
            raise ValueError("policy_hash must be exactly 64 lowercase hexadecimal characters")
        self._require_sha256_hex(policy_hash, field="policy_hash")
        row = self._connection.execute(
            "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?",
            (policy_hash,),
        ).fetchone()
        if row is None:
            raise OfflineDispatchUnavailable("offline adapter policy is not registered")
        policy = self._offline_policy_from_row(row)
        value = policy.value
        if value.get("schemaVersion") != "openalice_offline_adapter_policy.v3":
            raise OfflineDispatchUnavailable(
                "offline execution requires source-authenticated V3 policy"
            )
        self._assert_local_offline_policy_authorities(value)
        try:
            public_key = load_ed25519_public_key(permit_public_key)
            if (
                ed25519_public_key_fingerprint_sha256(public_key)
                != value["permitAuthorityPublicKeySpkiSha256"]
            ):
                raise ValueError("permit public key fingerprint mismatch")
        except (TypeError, ValueError):
            raise OfflineDispatchUnavailable(
                "permit public key does not match frozen offline policy"
            ) from None
        return policy

    def _validate_execution_dispatch_references(
        self,
        dispatch: ExecutionDispatch,
        *,
        receipt_public_key: Any | None = None,
    ) -> None:
        """Dereference every dispatch edge before returning durable state."""
        # Each reference is deliberately dereferenced on reads: a manually
        # altered foreign-key-disabled database must fail closed, not return a
        # plausible dispatch shell.
        if self.get_offline_adapter_policy(dispatch.policy_hash) is None:
            raise MalformedOfflineDispatchRecord("dispatch references absent offline policy")
        if dispatch.original_attempt_id is not None:
            attempt = self.get_offline_execution_attempt(dispatch.original_attempt_id)
            if (
                attempt is None
                or attempt.command_hash != dispatch.command_hash
                or attempt.policy_hash != dispatch.policy_hash
            ):
                raise MalformedOfflineDispatchRecord(
                    "dispatch original attempt does not bind its command and policy"
                )
        if dispatch.reconciliation_claim_id is not None:
            claim = self.get_offline_reconciliation_claim(dispatch.reconciliation_claim_id)
            if (
                claim is None
                or claim.command_hash != dispatch.command_hash
                or claim.original_attempt_id != dispatch.original_attempt_id
                or claim.status != ("COMPLETED" if dispatch.state == "RECEIPT_COMMITTED" else "ACTIVE")
            ):
                raise MalformedOfflineDispatchRecord(
                    "dispatch current reconciliation claim is malformed or fenced"
                )
        if dispatch.state == "RECEIPT_COMMITTED":
            assert dispatch.receipt_head_id is not None
            row = self._connection.execute(
                "SELECT * FROM offline_execution_receipts WHERE receipt_id = ?",
                (dispatch.receipt_head_id,),
            ).fetchone()
            if row is None:
                raise MalformedOfflineDispatchRecord("committed dispatch receipt head is absent")
            receipt = self._receipt_from_row(row)
            if (
                receipt.command_hash != dispatch.command_hash
                or receipt.policy_hash != dispatch.policy_hash
                or receipt.original_attempt_id != dispatch.original_attempt_id
                or receipt.transition_number != dispatch.transition_number
                or receipt.source_sequence != dispatch.source_sequence
            ):
                raise MalformedOfflineDispatchRecord("committed dispatch head does not bind receipt row")
            if receipt_public_key is None:
                raise ValueError("receipt_public_key is required for committed dispatch reads")
            verified = self.get_offline_execution_receipt(
                dispatch.receipt_head_id, receipt_public_key=receipt_public_key
            )
            if verified is None:
                raise MalformedOfflineDispatchRecord("committed dispatch verified receipt is absent")

    def get_execution_dispatch(
        self, command_hash: str, *, receipt_public_key: Any | None = None
    ) -> ExecutionDispatch | None:
        self._require_sha256_hex(command_hash, field="command_hash")
        row = self._connection.execute(
            "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
        ).fetchone()
        if row is None:
            return None
        dispatch = self._dispatch_from_row(row)
        self._validate_execution_dispatch_references(
            dispatch, receipt_public_key=receipt_public_key
        )
        return dispatch

    def list_incomplete_offline_dispatches(
        self, *, limit: int = 1_000
    ) -> list[ExecutionDispatch]:
        """List strict, nonterminal dispatches in accepted lifecycle order.

        The query has no lease or mutation surface.  Every returned row is
        reparsed and every dispatch and accepted-lifecycle reference is
        independently dereferenced before it is exposed to a recovery owner.
        """
        if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10_000:
            raise ValueError("limit must be an integer between 1 and 10000")
        missing = self._connection.execute(
            "SELECT 1 FROM execution_commands WHERE accepted_sequence IS NULL LIMIT 1"
        ).fetchone()
        if missing is not None:
            raise MalformedLifecycleRecord(
                "execution command has no accepted_sequence"
            )
        duplicate = self._connection.execute(
            """SELECT accepted_sequence FROM execution_commands
               GROUP BY accepted_sequence HAVING COUNT(*) > 1 LIMIT 1"""
        ).fetchone()
        if duplicate is not None:
            raise MalformedLifecycleRecord("execution commands have duplicate accepted_sequence")
        rows = self._connection.execute(
            """SELECT dispatch.*, command.accepted_sequence,
                      command.command_hash AS joined_command_hash
               FROM execution_dispatches AS dispatch
               JOIN execution_commands AS command
                 ON command.command_hash = dispatch.command_hash
               WHERE dispatch.state IN
                 ('DISPATCH_PENDING', 'IN_FLIGHT', 'RECONCILIATION_REQUIRED')
               ORDER BY command.accepted_sequence ASC, dispatch.command_hash ASC
               LIMIT ?""",
            (limit,),
        ).fetchall()
        dispatches: list[ExecutionDispatch] = []
        for row in rows:
            dispatch = self._dispatch_from_row(row)
            try:
                joined_command_hash = str(row["joined_command_hash"])
                self._require_sha256_hex(joined_command_hash, field="command_hash")
                accepted_sequence = row["accepted_sequence"]
                if (
                    isinstance(accepted_sequence, bool)
                    or not isinstance(accepted_sequence, int)
                    or accepted_sequence <= 0
                    or joined_command_hash != dispatch.command_hash
                ):
                    raise ValueError("dispatch command join is malformed")
            except (TypeError, ValueError):
                raise MalformedOfflineDispatchRecord(
                    "incomplete dispatch command reference is malformed"
                ) from None
            # Reuse the public strict command read for its lifecycle-event
            # binding instead of trusting the joined sequence column.
            command = self.get_command_by_hash(dispatch.command_hash)
            if command is None or command.accepted_sequence != accepted_sequence:
                raise MalformedOfflineDispatchRecord(
                    "incomplete dispatch accepted sequence is absent or changed"
                )
            self._validate_execution_dispatch_references(dispatch)
            dispatches.append(dispatch)
        return dispatches

    def get_offline_execution_attempt(self, attempt_id: str) -> OfflineExecutionAttempt | None:
        self._require_sha256_hex(attempt_id, field="attempt_id")
        row = self._connection.execute(
            "SELECT * FROM execution_attempts WHERE attempt_id = ?", (attempt_id,)
        ).fetchone()
        return None if row is None else self._attempt_from_row(row)

    def get_offline_reconciliation_claim(
        self, claim_id: str
    ) -> OfflineReconciliationClaim | None:
        self._require_sha256_hex(claim_id, field="claim_id")
        row = self._connection.execute(
            "SELECT * FROM execution_reconciliation_claims WHERE claim_id = ?", (claim_id,)
        ).fetchone()
        return None if row is None else self._reconciliation_claim_from_row(row)

    def claim_offline_dispatch(
        self,
        *,
        command_hash: str,
        writer_lease: Lease,
        now: float | None = None,
        permit_public_key: Any | None = None,
    ) -> OfflineExecutionAttempt:
        """Durably freeze the sole simulator request before any source effect.

        This method does not call the simulator.  It commits the immutable
        attempt and changes the dispatch to ``IN_FLIGHT`` in the same SQLite
        transaction, leaving the subsequent source effect for a separate,
        exactly-once ``ensure_exact`` operation.
        """
        self._require_sha256_hex(command_hash, field="command_hash")
        display_timestamp = self._required_epoch_seconds(
            time.time() if now is None else now, field="now"
        )
        with self._transaction() as connection:
            lease_timestamp = self._trusted_fencing_time()
            self._assert_lease_in_transaction(connection, writer_lease, now=lease_timestamp)
            dispatch_row = connection.execute(
                "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            if dispatch_row is None:
                raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")
            dispatch = self._dispatch_from_row(dispatch_row)
            if dispatch.state == "IN_FLIGHT":
                assert dispatch.original_attempt_id is not None
                row = connection.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id = ?",
                    (dispatch.original_attempt_id,),
                ).fetchone()
                if row is None:
                    raise MalformedOfflineDispatchRecord("in-flight dispatch lacks its immutable attempt")
                attempt = self._attempt_from_row(row)
                if attempt.adapter_epoch != str(writer_lease.epoch):
                    raise OfflineDispatchUnavailable(
                        "a newer writer must reconcile the original in-flight attempt"
                    )
                return attempt
            if dispatch.state != "DISPATCH_PENDING":
                raise OfflineDispatchUnavailable(f"offline dispatch state {dispatch.state} is not claimable")
            policy_row = connection.execute(
                "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (dispatch.policy_hash,)
            ).fetchone()
            if policy_row is None:
                raise MalformedOfflineDispatchRecord("dispatch references absent offline policy")
            policy = self._offline_policy_from_row(policy_row).value
            if policy["schemaVersion"] != "openalice_offline_adapter_policy.v3":
                raise OfflineDispatchUnavailable(
                    "legacy policy cannot claim a new offline dispatch"
                )
            self._assert_local_offline_policy_authorities(policy)
            command_row = connection.execute(
                "SELECT * FROM execution_commands WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            if command_row is None:
                raise MalformedOfflineDispatchRecord("dispatch references absent command")
            execution_command = self._execution_command_from_row(command_row)
            try:
                command = validate_execution_command_v1(json.loads(execution_command.command_json))
                permit = validate_execution_permit_v2(json.loads(execution_command.permit_json))
                if (
                    stable_stringify(command) != execution_command.command_json
                    or stable_stringify(permit) != execution_command.permit_json
                    or permit["commandHash"] != command_hash
                    or permit["keyId"] != policy["permitAuthorityKeyId"]
                    or command["payload"]["mode"] != "PAPER_LOCAL"
                    or command["payload"]["kind"] != "submit"
                ):
                    raise ContractValidationError("dispatch source binding mismatch")
                if permit_public_key is None:
                    raise OfflineDispatchUnavailable("offline dispatch claim requires the trusted permit public key")
                if lease_timestamp >= self._iso_timestamp_to_epoch(permit["expiresAt"], field="permit.expiresAt"):
                    raise PermitAuthorityExpired("execution permit authority expired before dispatch claim")
                if ed25519_public_key_fingerprint_sha256(permit_public_key) != policy["permitAuthorityPublicKeySpkiSha256"]:
                    raise OfflineDispatchUnavailable("permit public key does not match frozen offline policy")
                proof = verify_execution_permit_v2(
                    permit=permit, command=command,
                    resolve_public_key=lambda key_id: permit_public_key if key_id == policy["permitAuthorityKeyId"] else None,
                    now=datetime.fromtimestamp(lease_timestamp, timezone.utc),
                )
                if not proof.valid:
                    raise OfflineDispatchUnavailable(f"permit authority verification failed: {proof.reason}")
            except (ContractValidationError, TypeError, ValueError, KeyError, json.JSONDecodeError):
                raise MalformedOfflineDispatchRecord("dispatch command or permit is malformed") from None
            armed_at = self._canonical_timestamp(lease_timestamp)
            attempt_number = "1"
            adapter_epoch = str(writer_lease.epoch)
            attempt_id = derive_offline_execution_attempt_id(
                command_id=command_hash,
                adapter_id=policy["adapterId"],
                adapter_run_id=policy["adapterRunId"],
                adapter_epoch=adapter_epoch,
                attempt_number=attempt_number,
            )
            payload = command["payload"]
            request = validate_offline_simulator_request_v1(
                {
                    "schemaVersion": OFFLINE_SIMULATOR_REQUEST_V1,
                    "sourceNamespaceId": policy["sourceNamespaceId"],
                    "commandId": command_hash,
                    "payloadHash": command_hash,
                    "permitV2Id": permit["permitId"],
                    "permitKeyId": permit["keyId"],
                    "acceptedSequence": str(execution_command.accepted_sequence),
                    "idempotencyKey": payload["idempotencyKey"],
                    "accountId": payload["accountId"],
                    "canonicalSymbol": payload["canonicalSymbol"],
                    "venue": payload["venue"],
                    "venueInstrumentId": payload["venueInstrumentId"],
                    "mode": payload["mode"],
                    "clientOrderId": payload["clientOrderId"],
                    "side": payload["side"],
                    "orderType": payload["orderType"],
                    "timeInForce": payload["timeInForce"],
                    "reduceOnly": payload["reduceOnly"],
                    "quantity": payload["quantity"],
                    "price": payload["price"],
                    "maxNotionalUsd": payload["maxNotionalUsd"],
                    "adapterId": policy["adapterId"],
                    "adapterRunId": policy["adapterRunId"],
                    "adapterEpoch": adapter_epoch,
                    "attemptId": attempt_id,
                    "attemptNumber": attempt_number,
                    "permitIssuedAt": permit["issuedAt"],
                    "permitExpiresAt": permit["expiresAt"],
                    "dispatchArmedAt": armed_at,
                }
            )
            request_json = stable_stringify(request)
            request_hash = sha256_canonical(request)
            connection.execute(
                """
                INSERT INTO execution_attempts(
                    attempt_id, command_hash, policy_hash, adapter_epoch, attempt_number,
                    canonical_request_json, request_hash, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (attempt_id, command_hash, dispatch.policy_hash, adapter_epoch,
                 attempt_number, request_json, request_hash, display_timestamp),
            )
            connection.execute(
                """
                UPDATE execution_dispatches
                SET state = 'IN_FLIGHT', original_attempt_id = ?, dispatch_armed_at = ?,
                    updated_at = ?
                WHERE command_hash = ? AND state = 'DISPATCH_PENDING'
                """,
                (attempt_id, armed_at, display_timestamp, command_hash),
            )
            attempt_row = connection.execute(
                "SELECT * FROM execution_attempts WHERE attempt_id = ?", (attempt_id,)
            ).fetchone()
            assert attempt_row is not None
            return self._attempt_from_row(attempt_row)

    def mark_reconciliation_required(
        self,
        *,
        command_hash: str,
        writer_lease: Lease,
        now: float | None = None,
    ) -> ExecutionDispatch:
        """Move an unresolved source attempt into reconciliation without replacing it."""
        self._require_sha256_hex(command_hash, field="command_hash")
        timestamp = self._required_epoch_seconds(time.time() if now is None else now, field="now")
        with self._transaction() as connection:
            self._assert_lease_in_transaction(
                connection, writer_lease, now=self._trusted_fencing_time()
            )
            row = connection.execute(
                "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            if row is None:
                raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")
            dispatch = self._dispatch_from_row(row)
            if dispatch.state == "RECONCILIATION_REQUIRED":
                return dispatch
            if dispatch.state != "IN_FLIGHT" or dispatch.original_attempt_id is None:
                raise OfflineDispatchUnavailable("only an in-flight attempt may require reconciliation")
            connection.execute(
                """
                UPDATE execution_dispatches
                SET state = 'RECONCILIATION_REQUIRED', updated_at = ?
                WHERE command_hash = ? AND state = 'IN_FLIGHT'
                """,
                (timestamp, command_hash),
            )
            updated = connection.execute(
                "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            assert updated is not None
            return self._dispatch_from_row(updated)

    def claim_offline_reconciliation(
        self,
        *,
        command_hash: str,
        writer_lease: Lease,
        now: float | None = None,
    ) -> OfflineReconciliationClaim:
        """Issue/fence a current reconciliation authorizer, retaining original attempt."""
        self._require_sha256_hex(command_hash, field="command_hash")
        timestamp = self._required_epoch_seconds(time.time() if now is None else now, field="now")
        with self._transaction() as connection:
            self._assert_lease_in_transaction(
                connection, writer_lease, now=self._trusted_fencing_time()
            )
            row = connection.execute(
                "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            if row is None:
                raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")
            dispatch = self._dispatch_from_row(row)
            if dispatch.state != "RECONCILIATION_REQUIRED" or dispatch.original_attempt_id is None:
                raise OfflineDispatchUnavailable("offline dispatch is not awaiting reconciliation")
            active = connection.execute(
                """
                SELECT * FROM execution_reconciliation_claims
                WHERE command_hash = ? AND status = 'ACTIVE'
                """, (command_hash,)
            ).fetchone()
            if active is not None:
                existing = self._reconciliation_claim_from_row(active)
                if (
                    existing.writer_name == writer_lease.name
                    and existing.owner_id == writer_lease.owner_id
                    and existing.writer_epoch == writer_lease.epoch
                ):
                    return existing
                connection.execute(
                    "UPDATE execution_reconciliation_claims SET status = 'FENCED' WHERE claim_id = ?",
                    (existing.claim_id,),
                )
            claim_id = sha256_canonical(
                {
                    "domain": "openalice:offline-reconciliation-claim:v1",
                    "commandId": command_hash,
                    "originalAttemptId": dispatch.original_attempt_id,
                    "writerName": writer_lease.name,
                    "ownerId": writer_lease.owner_id,
                    "writerEpoch": str(writer_lease.epoch),
                }
            )
            connection.execute(
                """
                INSERT INTO execution_reconciliation_claims(
                    claim_id, command_hash, original_attempt_id, writer_name,
                    owner_id, writer_epoch, status, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?)
                """,
                (claim_id, command_hash, dispatch.original_attempt_id, writer_lease.name,
                 writer_lease.owner_id, writer_lease.epoch, timestamp),
            )
            connection.execute(
                """
                UPDATE execution_dispatches
                SET reconciliation_claim_id = ?, updated_at = ? WHERE command_hash = ?
                """, (claim_id, timestamp, command_hash),
            )
            claim_row = connection.execute(
                "SELECT * FROM execution_reconciliation_claims WHERE claim_id = ?", (claim_id,)
            ).fetchone()
            assert claim_row is not None
            return self._reconciliation_claim_from_row(claim_row)

    @staticmethod
    def _receipt_from_row(row: sqlite3.Row) -> OfflineExecutionReceipt:
        try:
            receipt_id = str(row["receipt_id"])
            command_hash = str(row["command_hash"])
            policy_hash = str(row["policy_hash"])
            attempt_id = str(row["attempt_id"])
            for field, value in (("receipt_id", receipt_id), ("command_hash", command_hash), ("policy_hash", policy_hash), ("attempt_id", attempt_id)):
                Ledger._require_sha256_hex(value, field=field)
            source_namespace_id = str(row["source_namespace_id"])
            Ledger._require_sha256_hex(source_namespace_id, field="source_namespace_id")
            source_sequence = str(row["source_sequence"])
            transition = str(row["transition_number"])
            if not re.fullmatch(r"[1-9][0-9]*", source_sequence) or not re.fullmatch(r"[1-9][0-9]*", transition):
                raise ValueError("receipt sequence is malformed")
            lifecycle_sequence = int(row["lifecycle_sequence"])
            if lifecycle_sequence <= 0:
                raise ValueError("receipt lifecycle sequence is malformed")
            previous = row["previous_receipt_id"]
            if previous is not None:
                Ledger._require_sha256_hex(str(previous), field="previous_receipt_id")
            claim = row["reconciliation_claim_id"]
            if claim is not None:
                Ledger._require_sha256_hex(str(claim), field="reconciliation_claim_id")
            receipt_json = str(row["receipt_json"])
            receipt = parse_offline_execution_receipt_json_utf8(receipt_json.encode("utf-8"))
            request_json = str(row["canonical_request_json"])
            response_json = str(row["canonical_response_json"])
            request = validate_offline_simulator_request_v1(json.loads(request_json))
            response = validate_offline_simulator_response_v1(json.loads(response_json))
            if stable_stringify(request) != request_json or stable_stringify(response) != response_json:
                raise ValueError("receipt raw evidence is non-canonical")
            source_effect_id = str(row["source_effect_id"])
            Ledger._require_sha256_hex(
                source_effect_id, field="source_effect_id"
            )
            source_effect_json = str(row["canonical_source_effect_json"])
            source_effect = parse_offline_simulator_effect_json_utf8(
                source_effect_json.encode("utf-8")
            )
            source_store_id = str(row["source_store_id"])
            source_store_sequence = str(row["source_store_sequence"])
            source_store_chain_hash = str(row["source_store_chain_hash"])
            Ledger._require_sha256_hex(source_store_id, field="source_store_id")
            Ledger._require_sha256_hex(
                source_store_chain_hash, field="source_store_chain_hash"
            )
            if not re.fullmatch(r"[1-9][0-9]*", source_store_sequence):
                raise ValueError("source store sequence is malformed")
            event_json = str(row["lifecycle_event_json"])
            event = validate_execution_event(json.loads(event_json))
            if stable_stringify(event) != event_json:
                raise ValueError("receipt lifecycle event is non-canonical")
            if (
                receipt["receiptId"] != receipt_id or receipt["commandId"] != command_hash
                or receipt["attemptId"] != attempt_id or receipt["sourceNamespaceId"] != source_namespace_id
                or receipt["sourceSequence"] != source_sequence
                or receipt["lifecycleSequence"] != str(lifecycle_sequence)
                or receipt["transitionNumber"] != transition
                or receipt.get("previousReceiptId") != previous
                or receipt["requestHash"] != str(row["request_hash"])
                or receipt["responseHash"] != str(row["response_hash"])
                or sha256_canonical(request) != str(row["request_hash"])
                or sha256_canonical(response) != str(row["response_hash"])
                or source_effect["effectId"] != source_effect_id
                or source_effect["storeId"] != source_store_id
                or source_effect["storeSequence"] != source_store_sequence
                or source_effect["storeChainHash"] != source_store_chain_hash
                or source_effect["commandId"] != command_hash
                or source_effect["attemptId"] != attempt_id
                or source_effect["sourceNamespaceId"] != source_namespace_id
                or source_effect["sourceSequence"] != source_sequence
                or source_effect["requestHash"] != str(row["request_hash"])
                or source_effect["responseHash"] != str(row["response_hash"])
                or str(row["lifecycle_event_id"]) != event["eventId"]
                or not execution_event_v2_matches_offline_receipt(receipt, event)
            ):
                raise ValueError("receipt row semantic binding mismatch")
            created_at = Ledger._required_epoch_seconds(row["created_at"], field="receipt_created_at")
        except (ContractValidationError, TypeError, ValueError, KeyError, json.JSONDecodeError):
            raise MalformedOfflineDispatchRecord("stored offline execution receipt is malformed") from None
        return OfflineExecutionReceipt(
            receipt_id, command_hash, policy_hash, attempt_id,
            None if claim is None else str(claim), source_namespace_id, source_sequence,
            lifecycle_sequence, transition, None if previous is None else str(previous),
            receipt_json, request_json, response_json, source_effect_id,
            source_effect_json, source_store_id, source_store_sequence,
            source_store_chain_hash, event_json, created_at,
        )

    @staticmethod
    def _receipt_expected_binding(receipt: Mapping[str, Any]) -> dict[str, Any]:
        return {
            field: receipt.get(field)
            for field in (
                "commandId", "payloadHash", "permitV2Id", "permitKeyId",
                "acceptedSequence", "lifecycleSequence", "lifecycleKind",
                "adapterEpoch", "attemptId", "attemptNumber", "sourceNamespaceId",
                "sourceSequence", "transitionNumber", "previousReceiptId",
                "idempotencyKey", "accountId", "canonicalSymbol", "venue",
                "venueInstrumentId", "mode", "clientOrderId", "side", "orderType",
                "timeInForce", "reduceOnly", "quantity", "price", "maxNotionalUsd",
            )
        }

    @staticmethod
    def _store_sequence_as_uint64(value: Any, *, field: str) -> int:
        """Parse one canonical positive uint64 without SQLite integer coercion."""
        text = str(value)
        if not re.fullmatch(r"[1-9][0-9]*", text):
            raise ValueError(f"{field} is malformed")
        parsed = int(text)
        if parsed > (1 << 64) - 1:
            raise ValueError(f"{field} exceeds uint64")
        return parsed

    @classmethod
    def _validate_offline_source_store_heads_in_transaction(
        cls, connection: sqlite3.Connection
    ) -> None:
        """Require durable global-store heads to exactly cover receipt history.

        This is intentionally a validation, not a backfill: a pre-anchor
        receipt database cannot establish which store-chain branch was
        previously accepted.
        """
        try:
            head_rows = connection.execute(
                """SELECT source_store_id, source_store_sequence,
                          source_store_chain_hash
                   FROM offline_source_store_heads"""
            ).fetchall()
            receipt_rows = connection.execute(
                """SELECT source_store_id, source_store_sequence,
                          source_store_chain_hash, canonical_source_effect_json
                   FROM offline_execution_receipts"""
            ).fetchall()
            heads: dict[str, tuple[int, str]] = {}
            for row in head_rows:
                store_id = str(row["source_store_id"])
                chain_hash = str(row["source_store_chain_hash"])
                cls._require_sha256_hex(store_id, field="source_store_id")
                cls._require_sha256_hex(
                    chain_hash, field="source_store_chain_hash"
                )
                if store_id in heads:
                    raise ValueError("duplicate source store head")
                heads[store_id] = (
                    cls._store_sequence_as_uint64(
                        row["source_store_sequence"],
                        field="source_store_sequence",
                    ),
                    chain_hash,
                )
            chains: dict[str, list[tuple[int, str, str, str]]] = {}
            for row in receipt_rows:
                store_id = str(row["source_store_id"])
                sequence = cls._store_sequence_as_uint64(
                    row["source_store_sequence"], field="source_store_sequence"
                )
                chain_hash = str(row["source_store_chain_hash"])
                cls._require_sha256_hex(store_id, field="source_store_id")
                cls._require_sha256_hex(
                    chain_hash, field="source_store_chain_hash"
                )
                raw = str(row["canonical_source_effect_json"])
                effect = parse_offline_simulator_effect_json_utf8(raw.encode("utf-8"))
                if (
                    effect["storeId"] != store_id
                    or effect["storeSequence"] != str(row["source_store_sequence"])
                    or effect["storeChainHash"] != chain_hash
                ):
                    raise ValueError("receipt source store fields disagree with effect")
                chains.setdefault(store_id, []).append(
                    (
                        sequence,
                        effect["previousStoreChainHash"],
                        effect["storeChainHash"],
                        effect["effectId"],
                    )
                )
            if set(heads) != set(chains):
                raise ValueError("source store heads do not exactly cover receipts")
            for store_id, links in chains.items():
                links.sort(key=lambda link: link[0])
                prior_hash = "0" * 64
                for expected_sequence, link in enumerate(links, start=1):
                    sequence, previous_hash, chain_hash, _ = link
                    if sequence != expected_sequence or previous_hash != prior_hash:
                        raise ValueError("source store receipt history is forked")
                    prior_hash = chain_hash
                if heads[store_id] != (len(links), prior_hash):
                    raise ValueError("source store head disagrees with receipt history")
        except (
            ContractValidationError,
            KeyError,
            TypeError,
            ValueError,
            sqlite3.DatabaseError,
        ) as error:
            raise MalformedOfflineDispatchRecord(
                "offline source store history is malformed"
            ) from error

    @classmethod
    def _advance_offline_source_store_head_in_transaction(
        cls,
        connection: sqlite3.Connection,
        *,
        source_effect: Mapping[str, Any],
    ) -> None:
        """Atomically admit exactly one next signed global-store chain link."""
        try:
            store_id = str(source_effect["storeId"])
            sequence_text = str(source_effect["storeSequence"])
            chain_hash = str(source_effect["storeChainHash"])
            previous_hash = str(source_effect["previousStoreChainHash"])
            cls._require_sha256_hex(store_id, field="source_store_id")
            cls._require_sha256_hex(chain_hash, field="source_store_chain_hash")
            cls._require_sha256_hex(previous_hash, field="previous_store_chain_hash")
            sequence = cls._store_sequence_as_uint64(
                sequence_text, field="source_store_sequence"
            )
            row = connection.execute(
                """SELECT source_store_sequence, source_store_chain_hash
                   FROM offline_source_store_heads WHERE source_store_id = ?""",
                (store_id,),
            ).fetchone()
            if row is None:
                if sequence != 1 or previous_hash != "0" * 64:
                    raise ValueError("first source store link is not the genesis link")
                connection.execute(
                    """INSERT INTO offline_source_store_heads(
                           source_store_id, source_store_sequence,
                           source_store_chain_hash
                       ) VALUES (?, ?, ?)""",
                    (store_id, sequence_text, chain_hash),
                )
                return
            prior_sequence = cls._store_sequence_as_uint64(
                row["source_store_sequence"], field="stored_source_store_sequence"
            )
            prior_hash = str(row["source_store_chain_hash"])
            cls._require_sha256_hex(
                prior_hash, field="stored_source_store_chain_hash"
            )
            if (
                prior_sequence == (1 << 64) - 1
                or sequence != prior_sequence + 1
                or previous_hash != prior_hash
            ):
                raise ValueError("source store chain does not extend its durable head")
            updated = connection.execute(
                """UPDATE offline_source_store_heads
                   SET source_store_sequence = ?, source_store_chain_hash = ?
                   WHERE source_store_id = ? AND source_store_sequence = ?
                     AND source_store_chain_hash = ?""",
                (sequence_text, chain_hash, store_id, str(row["source_store_sequence"]), prior_hash),
            )
            if updated.rowcount != 1:
                raise ValueError("source store head changed during update")
        except (KeyError, TypeError, ValueError, sqlite3.DatabaseError) as error:
            raise OfflineDispatchUnavailable(
                "offline source store chain is not the next durable link"
            ) from error

    def _verify_source_effect_binding(
        self,
        connection: sqlite3.Connection,
        *,
        policy: Mapping[str, Any],
        attempt: OfflineExecutionAttempt,
        response: Mapping[str, Any],
        source_effect: Mapping[str, Any],
    ) -> None:
        """Verify one signed simulator event against frozen Ledger authority."""
        try:
            _, capability_public_key, source_public_key = (
                self._assert_local_offline_policy_authorities(policy)
            )
            verification = verify_offline_simulator_effect_v1(
                effect=source_effect,
                trust_policy=OfflineSimulatorEffectTrustPolicy(
                    key_id=policy["sourceAttestationKeyId"],
                    store_id=policy["simulatorStoreId"],
                    public_key=source_public_key,
                ),
            )
            if not verification.valid:
                raise ValueError(
                    f"source effect verification failed: {verification.reason}"
                )
            capability_row = connection.execute(
                """SELECT * FROM offline_simulator_capabilities
                   WHERE capability_id = ?""",
                (source_effect["capabilityId"],),
            ).fetchone()
            if capability_row is None:
                raise ValueError("source effect capability is absent")
            capability = self._capability_from_row(capability_row)
            capability_value = capability.value
            if (
                capability.policy_hash != attempt.policy_hash
                or capability.command_hash != attempt.command_hash
                or capability.original_attempt_id != attempt.attempt_id
                or capability.reconciliation_claim_id is not None
                or capability_value["authorityKind"] != "original_dispatch"
                or capability_value["authorityKeyId"]
                != policy["simulatorCapabilityAuthorityKeyId"]
                or capability_value["simulatorStoreId"]
                != policy["simulatorStoreId"]
                or capability_value["sourceAttestationKeyId"]
                != policy["sourceAttestationKeyId"]
            ):
                raise ValueError(
                    "source effect does not reference the immutable original capability"
                )
            issued_at = datetime.fromtimestamp(
                self._iso_timestamp_to_epoch(
                    capability_value["issuedAt"], field="capability.issuedAt"
                ),
                timezone.utc,
            )
            capability_verification = verify_offline_simulator_capability_v1(
                capability=capability_value,
                public_key=capability_public_key,
                now=issued_at,
            )
            if not capability_verification.valid:
                raise ValueError(
                    "source effect capability signature is invalid"
                )
            if not offline_simulator_effect_v1_matches(
                source_effect, attempt.request, response, capability_value
            ):
                raise ValueError(
                    "source effect does not bind request, response, and capability"
                )
        except (
            ContractValidationError,
            KeyError,
            TypeError,
            ValueError,
            OfflineDispatchUnavailable,
        ) as error:
            raise MalformedOfflineDispatchRecord(
                "offline source effect signature or policy binding is invalid"
            ) from error

    def get_offline_execution_receipt(
        self, receipt_id: str, *, receipt_public_key: Any | None = None
    ) -> OfflineExecutionReceipt | None:
        """Read a strict receipt row; a caller must supply the trusted key to verify it."""
        self._require_sha256_hex(receipt_id, field="receipt_id")
        row = self._connection.execute(
            "SELECT * FROM offline_execution_receipts WHERE receipt_id = ?", (receipt_id,)
        ).fetchone()
        if row is None:
            return None
        stored = self._receipt_from_row(row)
        if receipt_public_key is None:
            raise ValueError("receipt_public_key is required for signature-verified receipt reads")
        policy = self.get_offline_adapter_policy(stored.policy_hash)
        attempt = self.get_offline_execution_attempt(stored.original_attempt_id)
        if policy is None or attempt is None:
            raise MalformedOfflineDispatchRecord("receipt references absent policy or attempt")
        policy_value = policy.value
        try:
            source_effect = parse_offline_simulator_effect_json_utf8(
                stored.canonical_source_effect_json.encode("utf-8")
            )
            response = validate_offline_simulator_response_v1(
                json.loads(stored.canonical_response_json)
            )
            self._verify_source_effect_binding(
                self._connection,
                policy=policy_value,
                attempt=attempt,
                response=response,
                source_effect=source_effect,
            )
            if ed25519_public_key_fingerprint_sha256(receipt_public_key) != policy_value["adapterPublicKeySpkiSha256"]:
                raise ValueError("untrusted receipt key")
            result = verify_offline_execution_receipt_v1(
                receipt=stored.receipt,
                canonical_request_json_utf8=stored.canonical_request_json.encode("utf-8"),
                canonical_response_json_utf8=stored.canonical_response_json.encode("utf-8"),
                trust_policy=OfflineReceiptTrustPolicy(
                    key_id=policy_value["adapterKeyId"], adapter_id=policy_value["adapterId"],
                    adapter_build_hash=policy_value["adapterBuildHash"], adapter_config_hash=policy_value["adapterConfigHash"],
                    adapter_run_id=policy_value["adapterRunId"],
                    permit_authority_key_ids=[policy_value["permitAuthorityKeyId"]],
                    permit_authority_public_key_fingerprints=[policy_value["permitAuthorityPublicKeySpkiSha256"]],
                    public_key=receipt_public_key,
                ),
                expected=self._receipt_expected_binding(stored.receipt),
                # Durable reads verify structural/provenance integrity.  They
                # do not reinterpret a historical receipt as invalid merely
                # because the local wall clock predates its stored observation.
                now=datetime.fromtimestamp(
                    self._iso_timestamp_to_epoch(
                        stored.receipt["adapterObservedAt"], field="adapterObservedAt"
                    ), timezone.utc
                ),
            )
            if not result.valid:
                raise ValueError(result.reason)
        except (TypeError, ValueError, ContractValidationError):
            raise MalformedOfflineDispatchRecord("offline receipt signature or policy binding is invalid") from None
        return stored

    def commit_offline_execution_receipt(
        self,
        *,
        command_hash: str,
        canonical_response_json_utf8: bytes,
        canonical_source_effect_json_utf8: bytes,
        writer_lease: Lease,
        reconciliation_claim_id: str | None = None,
        now: float | None = None,
    ) -> OfflineExecutionReceipt:
        """Atomically complete an already-dispatched simulator receipt.

        A failed equivalence check records a durable runtime suspension before
        raising.  This method never calls a simulator or a broker.
        """
        self._require_sha256_hex(command_hash, field="command_hash")
        if reconciliation_claim_id is not None:
            self._require_sha256_hex(reconciliation_claim_id, field="reconciliation_claim_id")
        try:
            if not isinstance(canonical_response_json_utf8, bytes):
                raise ValueError("canonical_response_json_utf8 must be bytes")
            response_text = canonical_response_json_utf8.decode("utf-8", errors="strict")
            response = validate_offline_simulator_response_v1(json.loads(response_text))
            if stable_stringify(response) != response_text:
                raise ValueError("canonical response bytes required")
        except (ContractValidationError, TypeError, ValueError, json.JSONDecodeError):
            raise ValueError("canonical_response_json_utf8 is invalid") from None
        try:
            source_effect = parse_offline_simulator_effect_json_utf8(
                canonical_source_effect_json_utf8
            )
            source_effect_text = canonical_source_effect_json_utf8.decode(
                "utf-8", errors="strict"
            )
        except (ContractValidationError, TypeError, ValueError, UnicodeError):
            raise ValueError(
                "canonical_source_effect_json_utf8 is invalid"
            ) from None
        timestamp = self._required_epoch_seconds(time.time() if now is None else now, field="now")
        conflict_message: str | None = None
        completed: OfflineExecutionReceipt | None = None
        with self._transaction() as connection:
            lease_timestamp = self._trusted_fencing_time()
            self._assert_lease_in_transaction(connection, writer_lease, now=lease_timestamp)
            dispatch_row = connection.execute(
                "SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)
            ).fetchone()
            if dispatch_row is None:
                raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")
            dispatch = self._dispatch_from_row(dispatch_row)
            if dispatch.state == "RECEIPT_COMMITTED":
                assert dispatch.receipt_head_id is not None
                existing_row = connection.execute(
                    "SELECT * FROM offline_execution_receipts WHERE receipt_id = ?", (dispatch.receipt_head_id,)
                ).fetchone()
                if existing_row is None:
                    raise MalformedOfflineDispatchRecord("receipt committed dispatch lacks head row")
                existing = self._receipt_from_row(existing_row)
                if (
                    existing.canonical_response_json != response_text
                    or existing.canonical_source_effect_json != source_effect_text
                    or existing.reconciliation_claim_id != reconciliation_claim_id
                ):
                    self._suspend_in_transaction(
                        connection, reason="offline_receipt_completion_equivocation", now=timestamp,
                        event_type="offline_receipt_completion_equivocation",
                        event_payload={"command_hash": command_hash, "receipt_id": existing.receipt_id},
                    )
                    conflict_message = "offline receipt completion conflicts with the committed receipt"
                else:
                    # A replay must not return a merely well-formed row as a
                    # successful completion.  Revalidate both durable trust
                    # anchors so signature/policy/raw-evidence or global-store
                    # history tampering cannot turn an exact retry into a
                    # successful completion.
                    self._validate_offline_source_store_heads_in_transaction(
                        connection
                    )
                    verified = self.get_offline_execution_receipt(
                        existing.receipt_id,
                        receipt_public_key=self._offline_receipt_signing_private_key.public_key()
                        if self._offline_receipt_signing_private_key is not None
                        else None,
                    )
                    if verified is None:
                        raise MalformedOfflineDispatchRecord("committed receipt vanished during exact retry")
                    completed = verified
            else:
                if dispatch.state not in {"IN_FLIGHT", "RECONCILIATION_REQUIRED"} or dispatch.original_attempt_id is None:
                    raise OfflineDispatchUnavailable("offline dispatch is not receipt-completable")
                attempt_row = connection.execute(
                    "SELECT * FROM execution_attempts WHERE attempt_id = ?", (dispatch.original_attempt_id,)
                ).fetchone()
                if attempt_row is None:
                    raise MalformedOfflineDispatchRecord("dispatch original attempt is absent")
                attempt = self._attempt_from_row(attempt_row)
                if dispatch.state == "IN_FLIGHT":
                    if reconciliation_claim_id is not None or attempt.adapter_epoch != str(writer_lease.epoch):
                        raise OfflineDispatchUnavailable("in-flight completion requires its original writer epoch and no claim")
                else:
                    if reconciliation_claim_id is None:
                        raise OfflineDispatchUnavailable("reconciliation completion requires the active claim")
                    claim_row = connection.execute(
                        "SELECT * FROM execution_reconciliation_claims WHERE claim_id = ?", (reconciliation_claim_id,)
                    ).fetchone()
                    if claim_row is None:
                        raise OfflineDispatchUnavailable("reconciliation claim is absent")
                    claim = self._reconciliation_claim_from_row(claim_row)
                    if (
                        claim.status != "ACTIVE" or claim.command_hash != command_hash
                        or claim.original_attempt_id != attempt.attempt_id
                        or claim.writer_name != writer_lease.name or claim.owner_id != writer_lease.owner_id
                        or claim.writer_epoch != writer_lease.epoch or dispatch.reconciliation_claim_id != claim.claim_id
                    ):
                        raise OfflineDispatchUnavailable("reconciliation claim is stale, fenced, or mismatched")
                policy_row = connection.execute(
                    "SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (dispatch.policy_hash,)
                ).fetchone()
                if policy_row is None:
                    raise MalformedOfflineDispatchRecord("dispatch policy is absent")
                policy = self._offline_policy_from_row(policy_row).value
                request = attempt.request
                if (
                    response["sourceNamespaceId"] != request["sourceNamespaceId"]
                    or response["commandId"] != command_hash or response["attemptId"] != attempt.attempt_id
                    or response["requestHash"] != attempt.request_hash
                    or response["clientOrderId"] != request["clientOrderId"]
                ):
                    self._suspend_in_transaction(
                        connection, reason="offline_receipt_source_binding_mismatch", now=timestamp,
                        event_type="offline_receipt_source_binding_mismatch",
                        event_payload={"command_hash": command_hash, "attempt_id": attempt.attempt_id},
                    )
                    conflict_message = "offline response does not bind the immutable dispatch attempt"
                else:
                    receipt_public_key, _, _ = (
                        self._assert_local_offline_policy_authorities(policy)
                    )
                    self._verify_source_effect_binding(
                        connection,
                        policy=policy,
                        attempt=attempt,
                        response=response,
                        source_effect=source_effect,
                    )
                    source_row = connection.execute(
                        """SELECT COALESCE(MAX(CAST(source_sequence AS INTEGER)), 0) AS latest,
                                   COUNT(*) AS count
                            FROM offline_execution_receipts
                            WHERE source_namespace_id = ?""",
                        (response["sourceNamespaceId"],),
                    ).fetchone()
                    latest_source = int(source_row["latest"])
                    source_count = int(source_row["count"])
                    if source_count != latest_source or int(response["sourceSequence"]) != latest_source + 1:
                        raise OfflineDispatchUnavailable(
                            "offline source sequence must be the next contiguous committed sequence"
                        )
                    # Namespace sequence continuity does not establish the
                    # simulator's global store history: two namespaces can
                    # otherwise each present a plausible branch.  The signed
                    # effect has already passed trust/capability/binding
                    # verification above; atomically anchor its store link
                    # before any receipt, lifecycle, or terminal-dispatch
                    # mutation is written.
                    self._advance_offline_source_store_head_in_transaction(
                        connection, source_effect=source_effect
                    )
                    next_sequence = self._latest_lifecycle_sequence_in_transaction(connection) + 1
                    previous = dispatch.receipt_head_id
                    # C1 receives exactly one terminal simulator source event.
                    # Multi-transition chains are intentionally not a supported
                    # state machine in this ledger release.
                    if previous is not None:
                        raise MalformedOfflineDispatchRecord("C1 dispatch cannot append a second receipt transition")
                    transition = "1"
                    observed_at = self._canonical_timestamp(lease_timestamp)
                    core: dict[str, Any] = {
                        "schemaVersion": OFFLINE_EXECUTION_RECEIPT_V1,
                        "scope": OFFLINE_EXECUTION_RECEIPT_SCOPE,
                        "commandId": command_hash, "payloadHash": command_hash,
                        "permitV2Id": request["permitV2Id"], "permitKeyId": request["permitKeyId"],
                        "acceptedSequence": request["acceptedSequence"], "lifecycleSequence": str(next_sequence),
                        "lifecycleKind": response["state"], "idempotencyKey": request["idempotencyKey"],
                        "accountId": request["accountId"], "canonicalSymbol": request["canonicalSymbol"],
                        "venue": request["venue"], "venueInstrumentId": request["venueInstrumentId"],
                        "mode": request["mode"], "clientOrderId": request["clientOrderId"], "side": request["side"],
                        "orderType": request["orderType"], "timeInForce": request["timeInForce"],
                        "reduceOnly": request["reduceOnly"], "quantity": request["quantity"], "price": request["price"],
                        "maxNotionalUsd": request["maxNotionalUsd"], "adapterId": policy["adapterId"],
                        "adapterBuildHash": policy["adapterBuildHash"], "adapterConfigHash": policy["adapterConfigHash"],
                        "adapterRunId": policy["adapterRunId"], "adapterEpoch": request["adapterEpoch"],
                        "adapterKeyId": policy["adapterKeyId"], "attemptId": attempt.attempt_id,
                        "attemptNumber": request["attemptNumber"], "sourceNamespaceId": response["sourceNamespaceId"],
                        "sourceSequence": response["sourceSequence"], "transitionNumber": transition,
                        "requestHash": attempt.request_hash, "responseHash": sha256_canonical(response),
                        "permitIssuedAt": request["permitIssuedAt"], "permitExpiresAt": request["permitExpiresAt"],
                        "dispatchArmedAt": request["dispatchArmedAt"], "adapterObservedAt": observed_at,
                        "simulatorOccurredAt": response["simulatorOccurredAt"],
                    }
                    for source in ("simulatedOrderId", "filledQuantity", "averagePrice", "reason"):
                        if source in response:
                            core[source] = response[source]
                    assert self._offline_receipt_signing_private_key is not None
                    receipt = create_offline_execution_receipt_v1(
                        core=core,
                        private_key=self._offline_receipt_signing_private_key,
                    )
                    event = build_execution_event_v2_from_offline_receipt(receipt)
                    verification = verify_offline_execution_receipt_v1(
                        receipt=receipt,
                        canonical_request_json_utf8=attempt.canonical_request_json.encode("utf-8"),
                        canonical_response_json_utf8=canonical_response_json_utf8,
                        trust_policy=OfflineReceiptTrustPolicy(
                            key_id=policy["adapterKeyId"], adapter_id=policy["adapterId"],
                            adapter_build_hash=policy["adapterBuildHash"], adapter_config_hash=policy["adapterConfigHash"],
                            adapter_run_id=policy["adapterRunId"],
                            permit_authority_key_ids=[policy["permitAuthorityKeyId"]],
                            permit_authority_public_key_fingerprints=[policy["permitAuthorityPublicKeySpkiSha256"]],
                            public_key=receipt_public_key,
                        ), expected=self._receipt_expected_binding(receipt),
                        now=datetime.fromtimestamp(lease_timestamp, timezone.utc),
                    )
                    if not verification.valid:
                        raise MalformedOfflineDispatchRecord(f"generated receipt failed verification: {verification.reason}")
                    receipt_json = stable_stringify(receipt)
                    event_json = stable_stringify(event)
                    connection.execute(
                        """INSERT INTO offline_execution_receipts(
                            receipt_id, command_hash, attempt_id, policy_hash, reconciliation_claim_id,
                            source_namespace_id, source_sequence, receipt_json, canonical_request_json,
                            canonical_response_json, request_hash, response_hash,
                            source_effect_id, canonical_source_effect_json,
                            source_store_id, source_store_sequence,
                            source_store_chain_hash, lifecycle_sequence,
                            lifecycle_event_json, lifecycle_event_id, transition_number, previous_receipt_id, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (receipt["receiptId"], command_hash, attempt.attempt_id, dispatch.policy_hash,
                         reconciliation_claim_id, response["sourceNamespaceId"], response["sourceSequence"],
                         receipt_json, attempt.canonical_request_json, response_text, attempt.request_hash,
                         sha256_canonical(response), source_effect["effectId"],
                         source_effect_text, source_effect["storeId"],
                         source_effect["storeSequence"],
                         source_effect["storeChainHash"], next_sequence,
                         event_json, event["eventId"], transition, previous, timestamp),
                    )
                    connection.execute(
                        """INSERT INTO lifecycle_events(
                            sequence, event_id, command_hash, event_kind, event_json,
                            evidence_schema_version, evidence_receipt_id, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                        (next_sequence, event["eventId"], command_hash, event["kind"], event_json,
                         event["evidenceSchemaVersion"], receipt["receiptId"], timestamp),
                    )
                    if reconciliation_claim_id is not None:
                        connection.execute(
                            "UPDATE execution_reconciliation_claims SET status = 'COMPLETED' WHERE claim_id = ? AND status = 'ACTIVE'",
                            (reconciliation_claim_id,),
                        )
                    connection.execute(
                        """UPDATE execution_dispatches SET state = 'RECEIPT_COMMITTED',
                            receipt_head_id = ?, transition_number = ?, source_sequence = ?, updated_at = ?
                            WHERE command_hash = ?""",
                        (receipt["receiptId"], transition, response["sourceSequence"], timestamp, command_hash),
                    )
                    receipt_row = connection.execute(
                        "SELECT * FROM offline_execution_receipts WHERE receipt_id = ?", (receipt["receiptId"],)
                    ).fetchone()
                    assert receipt_row is not None
                    completed = self._receipt_from_row(receipt_row)
        if conflict_message is not None:
            raise IdempotencyConflict(conflict_message)
        assert completed is not None
        return completed

    def _offline_capability_authority_public_key(self) -> Any:
        private_key = self._offline_capability_authority_private_key
        if private_key is None or not hasattr(private_key, "public_key"):
            raise OfflineDispatchUnavailable("ledger has no local offline capability authority")
        return private_key.public_key()

    @staticmethod
    def _capability_from_row(row: sqlite3.Row) -> OfflineSimulatorCapability:
        try:
            capability_id = str(row["capability_id"])
            Ledger._require_sha256_hex(capability_id, field="capability_id")
            raw = str(row["capability_json"])
            capability = parse_offline_simulator_capability_json_utf8(raw.encode("utf-8"))
            if stable_stringify(capability) != raw or capability["capabilityId"] != capability_id:
                raise ValueError("capability canonical identity mismatch")
            original = str(row["original_attempt_id"])
            policy_hash = str(row["policy_hash"])
            command_hash = str(row["command_hash"])
            for field, value in (("original_attempt_id", original), ("policy_hash", policy_hash), ("command_hash", command_hash)):
                Ledger._require_sha256_hex(value, field=field)
            claim = row["reconciliation_claim_id"]
            if claim is not None:
                Ledger._require_sha256_hex(str(claim), field="reconciliation_claim_id")
            if (
                capability["policyHash"] != policy_hash or capability["commandId"] != command_hash
                or capability["attemptId"] != original or capability.get("reconciliationClaimId") != claim
                or capability["writerName"] != str(row["writer_name"])
                or capability["writerOwnerId"] != str(row["writer_owner_id"])
                or capability["writerEpoch"] != str(row["writer_epoch"])
                or capability["expiresAt"] != str(row["expires_at"])
            ):
                raise ValueError("capability row binding mismatch")
            return OfflineSimulatorCapability(
                capability_id, raw, policy_hash, command_hash, original,
                None if claim is None else str(claim), str(row["writer_name"]),
                str(row["writer_owner_id"]), int(row["writer_epoch"]),
                str(row["expires_at"]), Ledger._required_epoch_seconds(row["created_at"], field="capability_created_at"),
            )
        except (ContractValidationError, TypeError, ValueError, KeyError, json.JSONDecodeError):
            raise MalformedOfflineDispatchRecord("stored offline simulator capability is malformed") from None

    def issue_offline_simulator_capability(
        self,
        *,
        command_hash: str,
        writer_lease: Lease,
        reconciliation_claim_id: str | None = None,
        now: float | None = None,
    ) -> OfflineSimulatorCapability:
        """Sign one local simulator capability from frozen dispatch authority."""
        self._require_sha256_hex(command_hash, field="command_hash")
        if reconciliation_claim_id is not None:
            self._require_sha256_hex(reconciliation_claim_id, field="reconciliation_claim_id")
        timestamp = self._required_epoch_seconds(time.time() if now is None else now, field="now")
        with self._transaction() as connection:
            lease_now = self._trusted_fencing_time()
            self._assert_lease_in_transaction(connection, writer_lease, now=lease_now)
            dispatch_row = connection.execute("SELECT * FROM execution_dispatches WHERE command_hash = ?", (command_hash,)).fetchone()
            if dispatch_row is None:
                raise OfflineDispatchUnavailable("no offline dispatch is bound to this command")
            dispatch = self._dispatch_from_row(dispatch_row)
            if dispatch.state not in {"IN_FLIGHT", "RECONCILIATION_REQUIRED"} or dispatch.original_attempt_id is None:
                raise OfflineDispatchUnavailable("offline dispatch is not capability-issuable")
            policy_row = connection.execute("SELECT * FROM offline_adapter_policies WHERE policy_hash = ?", (dispatch.policy_hash,)).fetchone()
            if policy_row is None:
                raise MalformedOfflineDispatchRecord("capability dispatch policy is absent")
            policy = self._offline_policy_from_row(policy_row).value
            if policy["schemaVersion"] != "openalice_offline_adapter_policy.v3":
                raise OfflineDispatchUnavailable(
                    "legacy policy cannot issue simulator capability"
                )
            _, public_key, _ = self._assert_local_offline_policy_authorities(
                policy
            )
            attempt_row = connection.execute("SELECT * FROM execution_attempts WHERE attempt_id = ?", (dispatch.original_attempt_id,)).fetchone()
            if attempt_row is None:
                raise MalformedOfflineDispatchRecord("capability dispatch attempt is absent")
            attempt = self._attempt_from_row(attempt_row)
            authority_kind: str
            if dispatch.state == "IN_FLIGHT":
                if reconciliation_claim_id is not None or attempt.adapter_epoch != str(writer_lease.epoch):
                    raise OfflineDispatchUnavailable("original capability requires original writer epoch and no claim")
                authority_kind = "original_dispatch"
            else:
                if reconciliation_claim_id is None or dispatch.reconciliation_claim_id != reconciliation_claim_id:
                    raise OfflineDispatchUnavailable("takeover capability requires current reconciliation claim")
                claim_row = connection.execute("SELECT * FROM execution_reconciliation_claims WHERE claim_id = ?", (reconciliation_claim_id,)).fetchone()
                if claim_row is None:
                    raise OfflineDispatchUnavailable("reconciliation claim is absent")
                claim = self._reconciliation_claim_from_row(claim_row)
                if claim.status != "ACTIVE" or claim.original_attempt_id != attempt.attempt_id or claim.writer_name != writer_lease.name or claim.owner_id != writer_lease.owner_id or claim.writer_epoch != writer_lease.epoch:
                    raise OfflineDispatchUnavailable("reconciliation claim is stale or fenced")
                authority_kind = "takeover_reconciliation"
            existing = connection.execute(
                """SELECT * FROM offline_simulator_capabilities
                   WHERE original_attempt_id = ? AND reconciliation_claim_id IS ?
                     AND writer_name = ? AND writer_owner_id = ? AND writer_epoch = ?""",
                (attempt.attempt_id, reconciliation_claim_id, writer_lease.name, writer_lease.owner_id, writer_lease.epoch),
            ).fetchone()
            if existing is not None:
                return self._capability_from_row(existing)
            expires_at = min(float(writer_lease.expires_at), lease_now + 300.0)
            core = {
                "schemaVersion": OFFLINE_SIMULATOR_CAPABILITY_V1,
                "scope": "offline_simulator_only",
                "capability": OFFLINE_SIMULATOR_CAPABILITY,
                "authorityKind": authority_kind,
                "authorityKeyId": self._offline_capability_authority_key_id,
                "policyHash": dispatch.policy_hash,
                "simulatorStoreId": policy["simulatorStoreId"],
                "sourceAttestationKeyId": policy["sourceAttestationKeyId"],
                "commandId": command_hash,
                "attemptId": attempt.attempt_id,
                "attemptAdapterEpoch": attempt.adapter_epoch,
                "sourceNamespaceId": attempt.request["sourceNamespaceId"],
                "clientOrderId": attempt.request["clientOrderId"],
                "requestHash": attempt.request_hash,
                "writerName": writer_lease.name,
                "writerOwnerId": writer_lease.owner_id,
                "writerEpoch": str(writer_lease.epoch),
                "issuedAt": self._canonical_timestamp(lease_now),
                "expiresAt": self._canonical_timestamp(expires_at),
            }
            if reconciliation_claim_id is not None:
                core["reconciliationClaimId"] = reconciliation_claim_id
            capability = create_offline_simulator_capability_v1(
                core=core, private_key=self._offline_capability_authority_private_key
            )
            verification = verify_offline_simulator_capability_v1(
                capability=capability, public_key=public_key,
                now=datetime.fromtimestamp(lease_now, timezone.utc),
            )
            if not verification.valid:
                raise MalformedOfflineDispatchRecord(f"generated capability did not verify: {verification.reason}")
            raw = stable_stringify(capability)
            connection.execute(
                """INSERT INTO offline_simulator_capabilities(
                    capability_id, capability_json, policy_hash, command_hash,
                    original_attempt_id, reconciliation_claim_id, writer_name,
                    writer_owner_id, writer_epoch, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (capability["capabilityId"], raw, dispatch.policy_hash, command_hash,
                 attempt.attempt_id, reconciliation_claim_id, writer_lease.name,
                 writer_lease.owner_id, writer_lease.epoch, capability["expiresAt"], timestamp),
            )
            row = connection.execute("SELECT * FROM offline_simulator_capabilities WHERE capability_id = ?", (capability["capabilityId"],)).fetchone()
            assert row is not None
            return self._capability_from_row(row)

    def get_offline_simulator_capability(self, capability_id: str) -> OfflineSimulatorCapability | None:
        self._require_sha256_hex(capability_id, field="capability_id")
        row = self._connection.execute("SELECT * FROM offline_simulator_capabilities WHERE capability_id = ?", (capability_id,)).fetchone()
        if row is None:
            return None
        stored = self._capability_from_row(row)
        public_key = self._offline_capability_authority_public_key()
        policy = self.get_offline_adapter_policy(stored.policy_hash)
        if policy is None or policy.value.get("schemaVersion") != "openalice_offline_adapter_policy.v3":
            raise MalformedOfflineDispatchRecord("capability references absent or legacy policy")
        self._assert_local_offline_policy_authorities(policy.value)
        if (
            stored.value["authorityKeyId"] != policy.value["simulatorCapabilityAuthorityKeyId"]
            or stored.value["simulatorStoreId"] != policy.value["simulatorStoreId"]
            or stored.value["sourceAttestationKeyId"]
            != policy.value["sourceAttestationKeyId"]
            or ed25519_public_key_fingerprint_sha256(public_key)
            != policy.value["simulatorCapabilityAuthorityPublicKeySpkiSha256"]
        ):
            raise MalformedOfflineDispatchRecord("capability authority does not match frozen policy")
        result = verify_offline_simulator_capability_v1(
            capability=stored.value, public_key=public_key,
            now=datetime.fromtimestamp(self._iso_timestamp_to_epoch(stored.value["issuedAt"], field="capability.issuedAt"), timezone.utc),
        )
        if not result.valid:
            raise MalformedOfflineDispatchRecord("stored capability signature is invalid")
        return stored

    def acquire_writer_lease(
        self,
        *,
        name: str,
        owner_id: str,
        ttl_seconds: float,
    ) -> Lease:
        """Acquire or renew a single-writer lease, advancing epoch after expiry."""
        if (
            not isinstance(name, str)
            or not name
            or name != name.strip()
            or not isinstance(owner_id, str)
            or not owner_id
            or owner_id != owner_id.strip()
            or isinstance(ttl_seconds, bool)
            or not isinstance(ttl_seconds, (int, float))
            or not math.isfinite(ttl_seconds)
            or ttl_seconds <= 0
        ):
            raise ValueError("name, owner_id, and a positive ttl_seconds are required")
        ttl = float(ttl_seconds)
        with self._transaction() as connection:
            timestamp = self._trusted_fencing_time()
            expires_at = timestamp + ttl
            current = connection.execute(
                "SELECT owner_id, epoch, expires_at FROM writer_lease WHERE name = ?", (name,)
            ).fetchone()
            if current is None:
                epoch = 1
                connection.execute(
                    "INSERT INTO writer_lease(name, owner_id, epoch, expires_at) VALUES (?, ?, ?, ?)",
                    (name, owner_id, epoch, expires_at),
                )
            elif float(current["expires_at"]) > timestamp and current["owner_id"] != owner_id:
                raise LeaseRejected(
                    f"writer lease {name!r} is held by {current['owner_id']!r} until {current['expires_at']}"
                )
            elif float(current["expires_at"]) > timestamp:
                epoch = int(current["epoch"])
                connection.execute(
                    "UPDATE writer_lease SET expires_at = ? WHERE name = ?", (expires_at, name)
                )
            else:
                epoch = int(current["epoch"]) + 1
                connection.execute(
                    "UPDATE writer_lease SET owner_id = ?, epoch = ?, expires_at = ? WHERE name = ?",
                    (owner_id, epoch, expires_at, name),
                )
            return Lease(name=name, owner_id=owner_id, epoch=epoch, expires_at=expires_at)

    def require_current_writer_lease(
        self,
        lease: Lease,
    ) -> None:
        """Fail if a bound writer lease is expired, replaced, or epoch-fenced.

        This read-only check is suitable for health snapshots. Every actual
        write still repeats the check inside its ``BEGIN IMMEDIATE``
        transaction, so a successful health check never grants write authority.
        """
        if not isinstance(lease, Lease):
            raise TypeError("lease must be a Ledger Lease")
        timestamp = self._trusted_fencing_time()
        self._assert_lease_in_transaction(self._connection, lease, now=timestamp)

    def release_writer_lease(
        self,
        lease: Lease,
    ) -> Lease:
        """Expire the current writer lease without deleting its fencing epoch.

        A managed runtime uses this only after closing its admission gate and
        draining already-authorized work.  Keeping the row means the next
        owner advances the epoch, while every handle retained by the stopped
        owner becomes stale immediately.
        """
        if not isinstance(lease, Lease):
            raise TypeError("lease must be a Ledger Lease")
        with self._transaction() as connection:
            timestamp = self._trusted_fencing_time()
            self._assert_lease_in_transaction(connection, lease, now=timestamp)
            connection.execute(
                "UPDATE writer_lease SET expires_at = ? WHERE name = ?",
                (timestamp, lease.name),
            )
        return Lease(
            name=lease.name,
            owner_id=lease.owner_id,
            epoch=lease.epoch,
            expires_at=timestamp,
        )

    def append_event(
        self,
        event_type: str,
        payload: Any,
        *,
        command_id: int | None = None,
        writer_lease: Lease,
        now: float | None = None,
    ) -> Event:
        """Append one event, optionally requiring a current fenced writer lease."""
        if not event_type:
            raise ValueError("event_type is required")
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            return self._append_event_in_transaction(
                connection,
                event_type,
                payload,
                command_id=command_id,
                now=timestamp,
            )

    def append_events_atomically(
        self,
        events: Iterable[tuple[str, Any, int | None]],
        *,
        writer_lease: Lease,
        now: float | None = None,
    ) -> list[Event]:
        """Append a batch as one crash-safe transaction boundary."""
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            return [
                self._append_event_in_transaction(
                    connection, event_type, payload, command_id=command_id, now=timestamp
                )
                for event_type, payload, command_id in events
            ]

    def append_lifecycle_event(
        self,
        event_core: Mapping[str, Any],
        *,
        writer_lease: Lease,
        now: float | None = None,
    ) -> LifecycleEvent:
        """Append one adapter-produced lifecycle event under the writer lease.

        The caller supplies the hash-bound event core but never ``sequence`` or
        ``eventId``.  The ledger assigns the next sequence while holding
        ``BEGIN IMMEDIATE``, builds and validates the event, and refuses events
        for commands that were not durably acknowledged first.  This is a
        Python-only future-adapter boundary; no wire RPC exposes it. Hash and
        lease checks prove integrity and writer identity, not broker provenance
        or terminal execution authenticity.
        """
        if not isinstance(event_core, Mapping):
            raise TypeError("event_core must be a mapping")
        candidate = dict(event_core)
        if "sequence" in candidate or "eventId" in candidate:
            raise ValueError("sequence and eventId are ledger-assigned")
        command_hash = candidate.get("commandId")
        if not isinstance(command_hash, str):
            raise ValueError("event_core requires commandId")
        self._require_sha256_hex(command_hash, field="commandId")
        if candidate.get("kind") == "acknowledged":
            raise ValueError("acknowledged events are created only by command admission")
        with self._transaction() as connection:
            timestamp = self._required_epoch_seconds(
                time.time() if now is None else now, field="now"
            )
            self._assert_lease_in_transaction(
                connection,
                writer_lease,
                now=self._trusted_fencing_time(),
            )
            command = connection.execute(
                "SELECT command_hash FROM execution_commands WHERE command_hash = ?",
                (command_hash,),
            ).fetchone()
            if command is None:
                raise ValueError("lifecycle event command is not durably acknowledged")
            return self._append_lifecycle_event_in_transaction(
                connection,
                event_core=candidate,
                now=timestamp,
            )

    def replay(self, *, after_cursor: int = 0, limit: int = 1_000) -> list[Event]:
        """Return events strictly after a cursor in durable cursor order."""
        if after_cursor < 0 or limit <= 0:
            raise ValueError("after_cursor must be non-negative and limit must be positive")
        rows = self._connection.execute(
            "SELECT * FROM events WHERE cursor > ? ORDER BY cursor ASC LIMIT ?",
            (after_cursor, limit),
        ).fetchall()
        return [self._event_from_row(row) for row in rows]

    def replay_lifecycle_events(
        self, *, after_sequence: int = 0, limit: int = 1_000
    ) -> list[LifecycleEvent]:
        """Return a strictly contiguous execution-only lifecycle batch."""
        if (
            type(after_sequence) is not int
            or after_sequence < 0
            or type(limit) is not int
            or not 1 <= limit <= 1_000
        ):
            raise ValueError(
                "after_sequence must be a non-negative integer and limit must be 1..1000"
            )
        latest = self._latest_lifecycle_sequence_in_transaction(self._connection)
        rows = self._connection.execute(
            """
            SELECT * FROM lifecycle_events
            WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
            """,
            (after_sequence, limit),
        ).fetchall()
        if after_sequence < latest and not rows:
            raise LifecycleSequenceGap("lifecycle replay encountered a missing sequence")
        events = [self._lifecycle_event_from_row(row) for row in rows]
        expected = after_sequence + 1
        for event in events:
            if event.sequence != expected:
                raise LifecycleSequenceGap(
                    f"lifecycle sequence expected {expected}, found {event.sequence}"
                )
            expected += 1
        return events

    def runtime_state(self, state_key: str = "global") -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT state_key, mode, circuit_reason, updated_at FROM runtime_state WHERE state_key = ?",
            (state_key,),
        ).fetchone()
        if row is None:
            return None
        return dict(row)

    def counts(self) -> dict[str, int]:
        """Small read-only inspection helper for tests and operational diagnostics."""
        return {
            table: int(self._connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0])
            for table in ("commands", "events", "writer_lease", "runtime_state")
        }

    def pragma_settings(self) -> dict[str, Any]:
        """Expose durability settings without exposing the underlying connection."""
        return {
            "journal_mode": self._connection.execute("PRAGMA journal_mode").fetchone()[0],
            "synchronous": int(self._connection.execute("PRAGMA synchronous").fetchone()[0]),
            "foreign_keys": int(self._connection.execute("PRAGMA foreign_keys").fetchone()[0]),
            "busy_timeout": int(self._connection.execute("PRAGMA busy_timeout").fetchone()[0]),
        }
