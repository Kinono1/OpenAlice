"""Deterministic, local-only source store for offline paper simulation.

This module intentionally owns a database separate from the OpenAlice command
ledger.  It has no network, broker, credential, or Nautilus dependency.  Its
only mutation is :meth:`OfflineSimulatorStore.ensure_exact`, which turns one
strictly validated simulator request into one deterministic ``submitted``
source event.
"""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any, Callable, Iterator, Mapping

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    PublicFormat,
    load_der_private_key,
    load_pem_private_key,
)

from .contract import (
    ContractValidationError,
    load_ed25519_public_key,
    sha256_canonical,
    stable_stringify,
)
from .offline_receipt import (
    OFFLINE_SIMULATOR_RESPONSE_V1,
    parse_offline_simulator_capability_json_utf8,
    validate_offline_simulator_request_v1,
    validate_offline_simulator_response_v1,
    verify_offline_simulator_capability_v1,
)
from .offline_effect import (
    OFFLINE_SIMULATOR_EFFECT_SCOPE,
    OFFLINE_SIMULATOR_EFFECT_V1,
    OfflineSimulatorEffectTrustPolicy,
    create_offline_simulator_effect_v1,
    offline_simulator_effect_v1_matches,
    offline_simulator_store_chain_v1_hash,
    parse_offline_simulator_effect_json_utf8,
    verify_offline_simulator_effect_v1,
)


_KEY_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,100}$")


class OfflineSimulatorError(RuntimeError):
    """Base exception for the simulator source store."""


class SimulatorCapabilityRejected(OfflineSimulatorError):
    """The signed simulator capability is invalid, expired, or not bound."""


class SimulatorEquivocation(OfflineSimulatorError):
    """A client order identity was reused with a different request binding."""


class SimulatorIntegrityError(OfflineSimulatorError):
    """Persisted simulator source data no longer has its required binding."""


@dataclass(frozen=True)
class OfflineSimulatorResult:
    """The one source event returned for an idempotent simulator dispatch."""

    created: bool
    source_namespace_id: str
    source_sequence: str
    command_id: str
    attempt_id: str
    client_order_id: str
    simulated_order_id: str
    canonical_request_json_utf8: bytes
    canonical_response_json_utf8: bytes
    canonical_effect_json_utf8: bytes

    @property
    def response(self) -> dict[str, Any]:
        """Strictly parse the stored canonical response bytes."""
        import json

        return validate_offline_simulator_response_v1(
            json.loads(self.canonical_response_json_utf8.decode("utf-8"))
        )

    @property
    def effect(self) -> dict[str, Any]:
        """Strictly parse the stored signed source-effect proof bytes."""
        return parse_offline_simulator_effect_json_utf8(
            self.canonical_effect_json_utf8
        )


class OfflineSimulatorStore:
    """SQLite-backed, fenced deterministic simulator event source.

    Mutations require an independently signed capability that the store
    verifies locally against a constructor-pinned public-key mapping.  The
    writer identity and epoch in that capability provide the namespace fence;
    a caller cannot mint authority by constructing a legacy lease object.
    """

    def __init__(
        self,
        database_path: str | Path,
        *,
        store_id: str,
        capability_public_keys: Mapping[str, Any],
        source_attestation_key_id: str,
        source_attestation_private_key: Ed25519PrivateKey | bytes | str,
        capability_clock: Callable[[], datetime] | None = None,
        allow_provision: bool = False,
        busy_timeout_ms: int = 5_000,
    ) -> None:
        if isinstance(busy_timeout_ms, bool) or not isinstance(busy_timeout_ms, int) or busy_timeout_ms <= 0:
            raise ValueError("busy_timeout_ms must be a positive integer")
        if (
            not isinstance(store_id, str)
            or len(store_id) != 64
            or any(character not in "0123456789abcdef" for character in store_id)
        ):
            raise ValueError("store_id must be a lowercase SHA-256 identity")
        if type(allow_provision) is not bool:
            raise TypeError("allow_provision must be a boolean")
        if not isinstance(capability_public_keys, Mapping) or not all(
            isinstance(key, str) for key in capability_public_keys
        ):
            raise TypeError("capability_public_keys must be a public-key mapping")
        if (
            not isinstance(source_attestation_key_id, str)
            or _KEY_ID_RE.fullmatch(source_attestation_key_id) is None
        ):
            raise ValueError("source_attestation_key_id is invalid")
        self.database_path = str(database_path)
        self.store_id = store_id
        self._source_attestation_key_id = source_attestation_key_id
        database_preexisted = Path(self.database_path).exists()
        # Snapshot the trust root once.  Individual ensure_exact callers cannot
        # replace it with a signer/key pair of their choosing.
        try:
            self._capability_public_keys = {
                key: load_ed25519_public_key(value)
                for key, value in capability_public_keys.items()
            }
        except Exception:
            raise ValueError("capability_public_keys contains an invalid public key") from None
        self._source_attestation_private_key = self._load_source_private_key(
            source_attestation_private_key
        )
        source_public_key = self._source_attestation_private_key.public_key()
        source_public_bytes = source_public_key.public_bytes(
            Encoding.Raw, PublicFormat.Raw
        )
        if any(
            public_key.public_bytes(Encoding.Raw, PublicFormat.Raw)
            == source_public_bytes
            for public_key in self._capability_public_keys.values()
        ):
            raise ValueError(
                "source attestation key must be distinct from capability authority keys"
            )
        self._source_effect_trust_policy = OfflineSimulatorEffectTrustPolicy(
            key_id=source_attestation_key_id,
            store_id=store_id,
            public_key=source_public_key,
        )
        if capability_clock is not None and not callable(capability_clock):
            raise TypeError("capability_clock must be callable")
        # Time is an authority dependency, not request data.  Snapshot the
        # callable at construction so an ensure_exact caller cannot backdate
        # an expired signed capability.
        self._capability_clock = capability_clock or (
            lambda: datetime.now(timezone.utc)
        )
        self._connection = sqlite3.connect(
            self.database_path,
            isolation_level=None,
            timeout=busy_timeout_ms / 1_000,
        )
        self._connection.row_factory = sqlite3.Row
        # Configure waiting before WAL/synchronous pragmas: concurrent process
        # startup otherwise can fail at the WAL transition before a transaction
        # has a chance to honor the configured timeout.
        self._connection.execute(f"PRAGMA busy_timeout = {busy_timeout_ms}")
        self._connection.execute("PRAGMA journal_mode = WAL")
        self._connection.execute("PRAGMA synchronous = FULL")
        self._connection.execute("PRAGMA foreign_keys = ON")
        try:
            self._create_schema()
            self._initialize_store_identity(
                database_preexisted=database_preexisted,
                allow_provision=allow_provision,
            )
        except BaseException:
            self._connection.close()
            raise

    def close(self) -> None:
        self._connection.close()

    def pragma_settings(self) -> dict[str, int | str]:
        return {
            "journal_mode": str(self._connection.execute("PRAGMA journal_mode").fetchone()[0]),
            "synchronous": int(self._connection.execute("PRAGMA synchronous").fetchone()[0]),
            "foreign_keys": int(self._connection.execute("PRAGMA foreign_keys").fetchone()[0]),
            "busy_timeout": int(self._connection.execute("PRAGMA busy_timeout").fetchone()[0]),
        }

    def counts(self) -> dict[str, int]:
        return {
            "namespaces": int(self._connection.execute("SELECT COUNT(*) FROM simulator_namespaces").fetchone()[0]),
            "orders": int(self._connection.execute("SELECT COUNT(*) FROM simulated_orders").fetchone()[0]),
            "events": int(self._connection.execute("SELECT COUNT(*) FROM simulator_events").fetchone()[0]),
            "capability_uses": int(self._connection.execute("SELECT COUNT(*) FROM simulator_capability_uses").fetchone()[0]),
        }

    def lookup_exact(
        self, request: Mapping[str, Any] | Any
    ) -> OfflineSimulatorResult | None:
        """Return an integrity-checked existing effect without create authority.

        Recovery uses this read before considering any capability-bearing
        operation.  Absence is returned only after auditing the complete
        namespace history under a stable SQLite transaction; a different
        request already bound to the client-order identity is equivocation,
        not absence.
        """
        parsed_request = validate_offline_simulator_request_v1(request)
        request_json = stable_stringify(parsed_request).encode("utf-8")
        request_hash = sha256_canonical(parsed_request)
        namespace_id = parsed_request["sourceNamespaceId"]
        client_order_id = parsed_request["clientOrderId"]
        with self._transaction() as connection:
            self._assert_store_integrity(connection)
            self._assert_namespace_integrity(
                connection, source_namespace_id=namespace_id
            )
            existing = connection.execute(
                """
                SELECT o.source_namespace_id, o.client_order_id, o.command_id,
                       o.attempt_id, o.request_hash, o.canonical_request_json,
                       e.store_sequence, e.source_sequence, e.simulated_order_id,
                       e.canonical_response_json, a.canonical_effect_json
                FROM simulated_orders AS o
                JOIN simulator_events AS e
                  ON e.source_namespace_id = o.source_namespace_id
                 AND e.client_order_id = o.client_order_id
                JOIN simulator_effect_attestations AS a
                  ON a.store_sequence = e.store_sequence
                WHERE o.source_namespace_id = ? AND o.client_order_id = ?
                """,
                (namespace_id, client_order_id),
            ).fetchone()
            if existing is None:
                return None
            if (
                existing["request_hash"] != request_hash
                or existing["command_id"] != parsed_request["commandId"]
                or existing["attempt_id"] != parsed_request["attemptId"]
                or bytes(existing["canonical_request_json"]) != request_json
            ):
                raise SimulatorEquivocation(
                    "sourceNamespaceId/clientOrderId is already bound to a different canonical request"
                )
            return self._result_from_row(existing, created=False)

    def ensure_exact(
        self,
        request: Mapping[str, Any] | Any,
        *,
        canonical_capability_json_utf8: bytes,
    ) -> OfflineSimulatorResult:
        """Atomically create or return the one exact source event for *request*.

        The trusted capability clock is read only after ``BEGIN IMMEDIATE``.
        Public-key resolution is constructor-pinned; this API accepts no
        signer or private-key material.  Returned request/response values are
        raw canonical UTF-8 bytes for receipt binding.
        """
        parsed_request = validate_offline_simulator_request_v1(request)
        request_json = stable_stringify(parsed_request).encode("utf-8")
        request_hash = sha256_canonical(parsed_request)
        namespace_id = parsed_request["sourceNamespaceId"]
        client_order_id = parsed_request["clientOrderId"]

        with self._transaction() as connection:
            now = self._trusted_capability_time()
            capability = self._verify_capability(
                canonical_capability_json_utf8=canonical_capability_json_utf8,
                now=now,
                parsed_request=parsed_request,
                request_hash=request_hash,
            )
            # Check persisted state before advancing the fence.  A corrupt
            # namespace cannot gain an event, capability use, or fence update.
            self._assert_store_integrity(connection)
            self._assert_namespace_integrity(connection, source_namespace_id=namespace_id)
            self._advance_or_assert_namespace_fence(
                connection,
                source_namespace_id=namespace_id,
                capability=capability,
                now=now,
            )
            capability_id = capability["capabilityId"]
            existing_use = connection.execute(
                "SELECT * FROM simulator_capability_uses WHERE capability_id = ?",
                (capability_id,),
            ).fetchone()
            if existing_use is not None:
                self._assert_capability_use(
                    existing_use,
                    capability=capability,
                    canonical_capability_json_utf8=canonical_capability_json_utf8,
                    parsed_request=parsed_request,
                    request_hash=request_hash,
                )
                existing = self._event_row_for_sequence(
                    connection,
                    source_namespace_id=namespace_id,
                    source_sequence=int(existing_use["source_sequence"]),
                )
                if existing is None:
                    self._integrity_failure("capability use has no source event")
                return self._result_from_row(existing, created=False)
            existing = connection.execute(
                """
                SELECT o.source_namespace_id, o.client_order_id, o.command_id,
                       o.attempt_id, o.request_hash, o.canonical_request_json,
                       e.store_sequence, e.source_sequence, e.simulated_order_id,
                       e.canonical_response_json, a.canonical_effect_json
                FROM simulated_orders AS o
                JOIN simulator_events AS e
                  ON e.source_namespace_id = o.source_namespace_id
                 AND e.client_order_id = o.client_order_id
                JOIN simulator_effect_attestations AS a
                  ON a.store_sequence = e.store_sequence
                WHERE o.source_namespace_id = ? AND o.client_order_id = ?
                """,
                (namespace_id, client_order_id),
            ).fetchone()
            if existing is not None:
                if (
                    existing["request_hash"] != request_hash
                    or existing["command_id"] != parsed_request["commandId"]
                    or existing["attempt_id"] != parsed_request["attemptId"]
                    or bytes(existing["canonical_request_json"]) != request_json
                ):
                    raise SimulatorEquivocation(
                        "sourceNamespaceId/clientOrderId is already bound to a different canonical request"
                    )
                if capability["authorityKind"] != "takeover_reconciliation":
                    raise SimulatorCapabilityRejected(
                        "existing source effect requires its original capability or a takeover reconciliation capability"
                    )
                self._insert_capability_use(
                    connection,
                    capability=capability,
                    canonical_capability_json_utf8=canonical_capability_json_utf8,
                    source_sequence=int(existing["source_sequence"]),
                    now=now,
                )
                return self._result_from_row(existing, created=False)

            if capability["authorityKind"] != "original_dispatch":
                raise SimulatorCapabilityRejected(
                    "takeover reconciliation capability cannot create a source effect"
                )

            # The integrity audit above establishes that MAX is the end of a
            # strict 1..MAX sequence and that every event has one matching
            # order.  Do not allocate from a gap even if SQLite constraints
            # would permit a later insertion.
            sequence = int(
                connection.execute(
                    "SELECT COALESCE(MAX(source_sequence), 0) + 1 FROM simulator_events WHERE source_namespace_id = ?",
                    (namespace_id,),
                ).fetchone()[0]
            )
            simulated_order_id = self._simulated_order_id(
                source_namespace_id=namespace_id,
                client_order_id=client_order_id,
            )
            response = validate_offline_simulator_response_v1(
                {
                    "schemaVersion": OFFLINE_SIMULATOR_RESPONSE_V1,
                    "sourceNamespaceId": namespace_id,
                    "sourceSequence": str(sequence),
                    "commandId": parsed_request["commandId"],
                    "attemptId": parsed_request["attemptId"],
                    "requestHash": request_hash,
                    "clientOrderId": client_order_id,
                    "state": "submitted",
                    # The armed point is a signed, canonical request value. It
                    # makes the simulator event deterministic and never claims
                    # a wall-clock broker observation.
                    "simulatorOccurredAt": parsed_request["dispatchArmedAt"],
                    "simulatedOrderId": simulated_order_id,
                }
            )
            response_json = stable_stringify(response).encode("utf-8")
            response_hash = sha256_canonical(response)
            store_head = self._store_identity_row(connection)
            store_sequence = int(store_head["latest_store_sequence"]) + 1
            previous_store_chain_hash = str(store_head["store_chain_hash"])
            effect_core: dict[str, Any] = {
                "schemaVersion": OFFLINE_SIMULATOR_EFFECT_V1,
                "scope": OFFLINE_SIMULATOR_EFFECT_SCOPE,
                "storeId": self.store_id,
                "storeSequence": str(store_sequence),
                "previousStoreChainHash": previous_store_chain_hash,
                "storeChainHash": "0" * 64,
                "policyHash": capability["policyHash"],
                "capabilityId": capability["capabilityId"],
                "sourceAttestationKeyId": self._source_attestation_key_id,
                "commandId": parsed_request["commandId"],
                "attemptId": parsed_request["attemptId"],
                "attemptAdapterEpoch": parsed_request["adapterEpoch"],
                "sourceNamespaceId": namespace_id,
                "sourceSequence": str(sequence),
                "clientOrderId": client_order_id,
                "requestHash": request_hash,
                "responseHash": response_hash,
                "simulatedOrderId": simulated_order_id,
                "simulatorOccurredAt": response["simulatorOccurredAt"],
                "authorityKind": "original_dispatch",
                "writerName": capability["writerName"],
                "writerOwnerId": capability["writerOwnerId"],
                "writerEpoch": capability["writerEpoch"],
            }
            effect_core["storeChainHash"] = offline_simulator_store_chain_v1_hash(
                effect_core
            )
            effect = create_offline_simulator_effect_v1(
                core=effect_core,
                private_key=self._source_attestation_private_key,
            )
            effect_json = stable_stringify(effect).encode("utf-8")
            next_store_chain_hash = effect["storeChainHash"]
            connection.execute(
                """
                INSERT INTO simulated_orders(
                    source_namespace_id, client_order_id, command_id, attempt_id,
                    request_hash, canonical_request_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    namespace_id,
                    client_order_id,
                    parsed_request["commandId"],
                    parsed_request["attemptId"],
                    request_hash,
                    request_json,
                    now.timestamp(),
                ),
            )
            connection.execute(
                """
                INSERT INTO simulator_events(
                    store_sequence, source_namespace_id, source_sequence, client_order_id,
                    command_id, attempt_id, request_hash, state,
                    simulated_order_id, canonical_response_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    store_sequence,
                    namespace_id,
                    sequence,
                    client_order_id,
                    parsed_request["commandId"],
                    parsed_request["attemptId"],
                    request_hash,
                    "submitted",
                    simulated_order_id,
                    response_json,
                    now.timestamp(),
                ),
            )
            self._insert_capability_use(
                connection,
                capability=capability,
                canonical_capability_json_utf8=canonical_capability_json_utf8,
                source_sequence=sequence,
                now=now,
            )
            connection.execute(
                """
                INSERT INTO simulator_effect_attestations(
                    effect_id, store_sequence, source_namespace_id,
                    source_sequence, canonical_effect_json, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    effect["effectId"],
                    store_sequence,
                    namespace_id,
                    sequence,
                    effect_json,
                    now.timestamp(),
                ),
            )
            self._advance_namespace_history_head(
                connection,
                source_namespace_id=namespace_id,
                source_sequence=sequence,
                capability_id=capability["capabilityId"],
                request_hash=request_hash,
                response_hash=response_hash,
                now=now,
            )
            self._advance_store_history_head(
                connection,
                prior_sequence=store_sequence - 1,
                prior_hash=previous_store_chain_hash,
                next_sequence=store_sequence,
                next_hash=next_store_chain_hash,
                now=now,
            )
            return OfflineSimulatorResult(
                created=True,
                source_namespace_id=namespace_id,
                source_sequence=str(sequence),
                command_id=parsed_request["commandId"],
                attempt_id=parsed_request["attemptId"],
                client_order_id=client_order_id,
                simulated_order_id=simulated_order_id,
                canonical_request_json_utf8=request_json,
                canonical_response_json_utf8=response_json,
                canonical_effect_json_utf8=effect_json,
            )

    def _create_schema(self) -> None:
        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS simulator_namespaces (
                source_namespace_id TEXT PRIMARY KEY NOT NULL,
                writer_name TEXT NOT NULL,
                owner_id TEXT NOT NULL,
                epoch INTEGER NOT NULL CHECK (epoch > 0),
                capability_expires_at TEXT NOT NULL,
                latest_source_sequence INTEGER NOT NULL
                    CHECK (latest_source_sequence >= 0),
                source_chain_hash TEXT NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS simulator_store_identity (
                singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
                store_id TEXT NOT NULL,
                latest_store_sequence INTEGER NOT NULL
                    CHECK (latest_store_sequence >= 0),
                store_chain_hash TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );

            CREATE TABLE IF NOT EXISTS simulated_orders (
                source_namespace_id TEXT NOT NULL,
                client_order_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                canonical_request_json BLOB NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (source_namespace_id, client_order_id),
                UNIQUE (source_namespace_id, attempt_id),
                FOREIGN KEY (source_namespace_id)
                    REFERENCES simulator_namespaces(source_namespace_id)
            );

            CREATE TABLE IF NOT EXISTS simulator_events (
                store_sequence INTEGER NOT NULL UNIQUE CHECK (store_sequence > 0),
                source_namespace_id TEXT NOT NULL,
                source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
                client_order_id TEXT NOT NULL,
                command_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state = 'submitted'),
                simulated_order_id TEXT NOT NULL,
                canonical_response_json BLOB NOT NULL,
                created_at REAL NOT NULL,
                PRIMARY KEY (source_namespace_id, source_sequence),
                UNIQUE (source_namespace_id, client_order_id),
                FOREIGN KEY (source_namespace_id, client_order_id)
                    REFERENCES simulated_orders(source_namespace_id, client_order_id)
            );

            CREATE TABLE IF NOT EXISTS simulator_capability_uses (
                capability_id TEXT PRIMARY KEY NOT NULL,
                canonical_capability_hash TEXT NOT NULL,
                canonical_capability_json BLOB NOT NULL,
                source_namespace_id TEXT NOT NULL,
                source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
                command_id TEXT NOT NULL,
                attempt_id TEXT NOT NULL,
                attempt_adapter_epoch TEXT NOT NULL,
                client_order_id TEXT NOT NULL,
                request_hash TEXT NOT NULL,
                authority_kind TEXT NOT NULL,
                writer_name TEXT NOT NULL,
                writer_owner_id TEXT NOT NULL,
                writer_epoch TEXT NOT NULL,
                reconciliation_claim_id TEXT,
                created_at REAL NOT NULL,
                FOREIGN KEY (source_namespace_id, source_sequence)
                    REFERENCES simulator_events(source_namespace_id, source_sequence)
            );

            CREATE TABLE IF NOT EXISTS simulator_effect_attestations (
                effect_id TEXT PRIMARY KEY NOT NULL,
                store_sequence INTEGER NOT NULL UNIQUE CHECK (store_sequence > 0),
                source_namespace_id TEXT NOT NULL,
                source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
                canonical_effect_json BLOB NOT NULL,
                created_at REAL NOT NULL,
                UNIQUE (source_namespace_id, source_sequence),
                FOREIGN KEY (store_sequence)
                    REFERENCES simulator_events(store_sequence),
                FOREIGN KEY (source_namespace_id, source_sequence)
                    REFERENCES simulator_events(source_namespace_id, source_sequence)
            );
            """
        )

    def _initialize_store_identity(
        self, *, database_preexisted: bool, allow_provision: bool
    ) -> None:
        """Provision only a brand-new path; never heal a missing identity row."""
        with self._transaction() as connection:
            rows = connection.execute(
                "SELECT * FROM simulator_store_identity"
            ).fetchall()
            if not rows:
                if database_preexisted or not allow_provision:
                    raise SimulatorIntegrityError(
                        "offline simulator store identity is absent; explicit new-store provisioning is required"
                    )
                now = self._trusted_capability_time().timestamp()
                connection.execute(
                    """INSERT INTO simulator_store_identity(
                           singleton, store_id, latest_store_sequence,
                           store_chain_hash, created_at, updated_at
                       ) VALUES (1, ?, 0, ?, ?, ?)""",
                    (self.store_id, "0" * 64, now, now),
                )
            elif len(rows) != 1 or str(rows[0]["store_id"]) != self.store_id:
                raise SimulatorIntegrityError(
                    "offline simulator store identity does not match the configured store"
                )
            self._store_identity_row(connection)

    def _store_identity_row(self, connection: sqlite3.Connection) -> sqlite3.Row:
        rows = connection.execute(
            "SELECT * FROM simulator_store_identity"
        ).fetchall()
        if len(rows) != 1:
            self._integrity_failure("store identity cardinality is invalid")
        row = rows[0]
        try:
            if int(row["singleton"]) != 1 or str(row["store_id"]) != self.store_id:
                raise ValueError
            latest = int(row["latest_store_sequence"])
            chain_hash = str(row["store_chain_hash"])
            if latest < 0 or len(chain_hash) != 64 or any(
                character not in "0123456789abcdef" for character in chain_hash
            ):
                raise ValueError
        except (TypeError, ValueError):
            self._integrity_failure("store identity or history head is malformed")
        return row

    def _assert_store_integrity(self, connection: sqlite3.Connection) -> None:
        identity = self._store_identity_row(connection)
        events = connection.execute(
            """SELECT e.store_sequence, e.source_namespace_id,
                      e.source_sequence, e.command_id, e.attempt_id,
                      e.client_order_id, e.request_hash, e.simulated_order_id,
                      e.canonical_response_json, o.canonical_request_json,
                      a.effect_id, a.canonical_effect_json
               FROM simulator_events AS e
               JOIN simulated_orders AS o
                 ON o.source_namespace_id = e.source_namespace_id
                AND o.client_order_id = e.client_order_id
               JOIN simulator_effect_attestations AS a
                 ON a.store_sequence = e.store_sequence
                AND a.source_namespace_id = e.source_namespace_id
                AND a.source_sequence = e.source_sequence
               ORDER BY e.store_sequence ASC"""
        ).fetchall()
        effect_count = int(
            connection.execute(
                "SELECT COUNT(*) FROM simulator_effect_attestations"
            ).fetchone()[0]
        )
        raw_event_count = int(
            connection.execute("SELECT COUNT(*) FROM simulator_events").fetchone()[0]
        )
        if len(events) != raw_event_count or effect_count != raw_event_count:
            self._integrity_failure(
                "every global source event must have exactly one signed effect attestation"
            )
        store_sequences = [row["store_sequence"] for row in events]
        if store_sequences != list(range(1, len(events) + 1)):
            self._integrity_failure("global store sequence is not contiguous")
        reconstructed = "0" * 64
        for event in events:
            original_uses = connection.execute(
                """SELECT * FROM simulator_capability_uses
                   WHERE source_namespace_id = ? AND source_sequence = ?
                     AND authority_kind = 'original_dispatch'""",
                (event["source_namespace_id"], event["source_sequence"]),
            ).fetchall()
            if len(original_uses) != 1:
                self._integrity_failure(
                    "global source event capability use is missing or source sequence is non-contiguous"
                )
            use = original_uses[0]
            try:
                capability = parse_offline_simulator_capability_json_utf8(
                    bytes(use["canonical_capability_json"])
                )
            except (ContractValidationError, TypeError, ValueError) as error:
                raise SimulatorIntegrityError(
                    "stored global capability use is not canonical"
                ) from error
            self._assert_stored_capability_signature(capability)
            request = self._parse_canonical_request(
                event["canonical_request_json"]
            )
            response = self._parse_canonical_response(
                event["canonical_response_json"]
            )
            try:
                effect = parse_offline_simulator_effect_json_utf8(
                    bytes(event["canonical_effect_json"])
                )
            except (ContractValidationError, TypeError, ValueError) as error:
                raise SimulatorIntegrityError(
                    "stored source effect attestation is not canonical"
                ) from error
            verification = verify_offline_simulator_effect_v1(
                effect=effect,
                trust_policy=self._source_effect_trust_policy,
            )
            if not verification.valid:
                self._integrity_failure(
                    f"stored source effect attestation is invalid: {verification.reason}"
                )
            if (
                use["capability_id"] != capability["capabilityId"]
                or use["request_hash"] != event["request_hash"]
                or capability["sourceNamespaceId"] != event["source_namespace_id"]
                or response["sourceSequence"] != str(event["source_sequence"])
                or str(event["effect_id"]) != effect["effectId"]
                or effect["storeSequence"] != str(event["store_sequence"])
                or effect["previousStoreChainHash"] != reconstructed
                or not offline_simulator_effect_v1_matches(
                    effect, request, response, capability
                )
            ):
                self._integrity_failure(
                    "global source chain capability/effect inputs are semantically unbound"
                )
            reconstructed = effect["storeChainHash"]
        if (
            int(identity["latest_store_sequence"]) != len(events)
            or str(identity["store_chain_hash"]) != reconstructed
        ):
            self._integrity_failure(
                "global store history head does not match its source events"
            )

    def _advance_store_history_head(
        self,
        connection: sqlite3.Connection,
        *,
        prior_sequence: int,
        prior_hash: str,
        next_sequence: int,
        next_hash: str,
        now: datetime,
    ) -> None:
        updated = connection.execute(
            """UPDATE simulator_store_identity
               SET latest_store_sequence = ?, store_chain_hash = ?, updated_at = ?
               WHERE singleton = 1 AND store_id = ?
                 AND latest_store_sequence = ? AND store_chain_hash = ?""",
            (
                next_sequence,
                next_hash,
                now.timestamp(),
                self.store_id,
                prior_sequence,
                prior_hash,
            ),
        )
        if updated.rowcount != 1:
            self._integrity_failure("global store history head update was not atomic")

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield self._connection
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        else:
            self._connection.execute("COMMIT")

    @staticmethod
    def _load_source_private_key(
        value: Ed25519PrivateKey | bytes | str,
    ) -> Ed25519PrivateKey:
        if isinstance(value, Ed25519PrivateKey):
            return value
        raw = value.encode("utf-8") if isinstance(value, str) else value
        if not isinstance(raw, bytes):
            raise TypeError("source_attestation_private_key is invalid")
        for loader in (load_pem_private_key, load_der_private_key):
            try:
                loaded = loader(raw, password=None)
            except (TypeError, ValueError):
                continue
            if isinstance(loaded, Ed25519PrivateKey):
                return loaded
        raise ValueError("source_attestation_private_key is invalid")

    def _trusted_capability_time(self) -> datetime:
        value = self._capability_clock()
        if (
            not isinstance(value, datetime)
            or value.tzinfo is None
            or value.utcoffset() != timezone.utc.utcoffset(value)
        ):
            raise ValueError("capability_clock must return a UTC datetime")
        return value

    @staticmethod
    def _capability_writer_epoch(capability: Mapping[str, Any]) -> int:
        epoch = int(capability["writerEpoch"])
        if epoch > (1 << 63) - 1:
            raise SimulatorCapabilityRejected("writer epoch exceeds SQLite integer range")
        return epoch

    def _verify_capability(
        self,
        *,
        canonical_capability_json_utf8: bytes,
        now: datetime,
        parsed_request: Mapping[str, Any],
        request_hash: str,
    ) -> dict[str, Any]:
        try:
            capability = parse_offline_simulator_capability_json_utf8(
                canonical_capability_json_utf8
            )
        except (ContractValidationError, TypeError, ValueError) as error:
            raise SimulatorCapabilityRejected("capability canonical JSON is invalid") from error
        verification = verify_offline_simulator_capability_v1(
            capability=capability,
            key_resolver=self._capability_public_keys,
            now=now,
        )
        if not verification.valid or verification.capability is None:
            raise SimulatorCapabilityRejected(
                f"capability verification failed: {verification.reason}"
            )
        parsed = dict(verification.capability)
        if (
            parsed.get("simulatorStoreId") != self.store_id
            or parsed.get("sourceAttestationKeyId")
            != self._source_attestation_key_id
        ):
            raise SimulatorCapabilityRejected(
                "capability simulator store or source attestation key does not match"
            )
        expected = {
            "commandId": parsed_request["commandId"],
            "attemptId": parsed_request["attemptId"],
            "attemptAdapterEpoch": parsed_request["adapterEpoch"],
            "sourceNamespaceId": parsed_request["sourceNamespaceId"],
            "clientOrderId": parsed_request["clientOrderId"],
            "requestHash": request_hash,
        }
        if any(parsed.get(field) != value for field, value in expected.items()):
            raise SimulatorCapabilityRejected("capability binding does not match request")
        self._capability_writer_epoch(parsed)
        return parsed

    def _advance_or_assert_namespace_fence(
        self,
        connection: sqlite3.Connection,
        *,
        source_namespace_id: str,
        capability: Mapping[str, Any],
        now: datetime,
    ) -> None:
        writer_epoch = self._capability_writer_epoch(capability)
        row = connection.execute(
            "SELECT writer_name, owner_id, epoch FROM simulator_namespaces WHERE source_namespace_id = ?",
            (source_namespace_id,),
        ).fetchone()
        if row is None:
            connection.execute(
                """
                INSERT INTO simulator_namespaces(
                    source_namespace_id, writer_name, owner_id, epoch,
                    capability_expires_at, latest_source_sequence,
                    source_chain_hash, updated_at
                ) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
                """,
                (
                    source_namespace_id,
                    capability["writerName"],
                    capability["writerOwnerId"],
                    writer_epoch,
                    capability["expiresAt"],
                    "0" * 64,
                    now.timestamp(),
                ),
            )
            return
        if str(row["writer_name"]) != capability["writerName"]:
            raise SimulatorCapabilityRejected("capability writer name does not own this source namespace")
        stored_epoch = int(row["epoch"])
        if writer_epoch < stored_epoch or (
            writer_epoch == stored_epoch and str(row["owner_id"]) != capability["writerOwnerId"]
        ):
            raise SimulatorCapabilityRejected("capability writer is stale or fenced by this source namespace")
        connection.execute(
            """
            UPDATE simulator_namespaces
            SET owner_id = ?, epoch = ?, capability_expires_at = ?, updated_at = ?
            WHERE source_namespace_id = ?
            """,
            (
                capability["writerOwnerId"],
                writer_epoch,
                capability["expiresAt"],
                now.timestamp(),
                source_namespace_id,
            ),
        )

    @staticmethod
    def _next_source_chain_hash(
        *,
        previous_hash: str,
        source_namespace_id: str,
        source_sequence: int,
        capability_id: str,
        request_hash: str,
        response_hash: str,
    ) -> str:
        return sha256_canonical(
            {
                "domain": "openalice:offline-simulator-source-chain:v1",
                "previousHash": previous_hash,
                "sourceNamespaceId": source_namespace_id,
                "sourceSequence": str(source_sequence),
                "capabilityId": capability_id,
                "requestHash": request_hash,
                "responseHash": response_hash,
            }
        )

    def _advance_namespace_history_head(
        self,
        connection: sqlite3.Connection,
        *,
        source_namespace_id: str,
        source_sequence: int,
        capability_id: str,
        request_hash: str,
        response_hash: str,
        now: datetime,
    ) -> None:
        row = connection.execute(
            """SELECT latest_source_sequence, source_chain_hash
               FROM simulator_namespaces WHERE source_namespace_id = ?""",
            (source_namespace_id,),
        ).fetchone()
        if row is None or int(row["latest_source_sequence"]) + 1 != source_sequence:
            self._integrity_failure("namespace history head cannot advance contiguously")
        previous_hash = str(row["source_chain_hash"])
        next_hash = self._next_source_chain_hash(
            previous_hash=previous_hash,
            source_namespace_id=source_namespace_id,
            source_sequence=source_sequence,
            capability_id=capability_id,
            request_hash=request_hash,
            response_hash=response_hash,
        )
        updated = connection.execute(
            """UPDATE simulator_namespaces
               SET latest_source_sequence = ?, source_chain_hash = ?, updated_at = ?
               WHERE source_namespace_id = ? AND latest_source_sequence = ?
                 AND source_chain_hash = ?""",
            (
                source_sequence,
                next_hash,
                now.timestamp(),
                source_namespace_id,
                source_sequence - 1,
                previous_hash,
            ),
        )
        if updated.rowcount != 1:
            self._integrity_failure("namespace history head update was not atomic")

    @staticmethod
    def _capability_hash(capability: Mapping[str, Any]) -> str:
        return sha256_canonical(capability)

    def _insert_capability_use(
        self,
        connection: sqlite3.Connection,
        *,
        capability: Mapping[str, Any],
        canonical_capability_json_utf8: bytes,
        source_sequence: int,
        now: datetime,
    ) -> None:
        connection.execute(
            """
            INSERT INTO simulator_capability_uses(
                capability_id, canonical_capability_hash, canonical_capability_json,
                source_namespace_id, source_sequence, command_id, attempt_id,
                attempt_adapter_epoch, client_order_id, request_hash, authority_kind,
                writer_name, writer_owner_id, writer_epoch, reconciliation_claim_id,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                capability["capabilityId"],
                self._capability_hash(capability),
                canonical_capability_json_utf8,
                capability["sourceNamespaceId"],
                source_sequence,
                capability["commandId"],
                capability["attemptId"],
                capability["attemptAdapterEpoch"],
                capability["clientOrderId"],
                capability["requestHash"],
                capability["authorityKind"],
                capability["writerName"],
                capability["writerOwnerId"],
                capability["writerEpoch"],
                capability.get("reconciliationClaimId"),
                now.timestamp(),
            ),
        )

    def _assert_capability_use(
        self,
        use: sqlite3.Row,
        *,
        capability: Mapping[str, Any],
        canonical_capability_json_utf8: bytes,
        parsed_request: Mapping[str, Any],
        request_hash: str,
    ) -> None:
        try:
            stored_capability = parse_offline_simulator_capability_json_utf8(
                bytes(use["canonical_capability_json"])
            )
        except (ContractValidationError, TypeError, ValueError) as error:
            raise SimulatorIntegrityError("stored capability use is not canonical") from error
        if (
            bytes(use["canonical_capability_json"]) != canonical_capability_json_utf8
            or stored_capability != dict(capability)
            or use["canonical_capability_hash"] != self._capability_hash(stored_capability)
        ):
            self._integrity_failure("capability use canonical bytes/hash mismatch")
        expected = {
            "capability_id": capability["capabilityId"],
            "source_namespace_id": parsed_request["sourceNamespaceId"],
            "command_id": parsed_request["commandId"],
            "attempt_id": parsed_request["attemptId"],
            "attempt_adapter_epoch": parsed_request["adapterEpoch"],
            "client_order_id": parsed_request["clientOrderId"],
            "request_hash": request_hash,
            "authority_kind": capability["authorityKind"],
            "writer_name": capability["writerName"],
            "writer_owner_id": capability["writerOwnerId"],
            "writer_epoch": capability["writerEpoch"],
            "reconciliation_claim_id": capability.get("reconciliationClaimId"),
        }
        for column, value in expected.items():
            if use[column] != value:
                self._integrity_failure(f"capability use {column} mismatch")

    @staticmethod
    def _event_row_for_sequence(
        connection: sqlite3.Connection,
        *,
        source_namespace_id: str,
        source_sequence: int,
    ) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT o.source_namespace_id, o.client_order_id, o.command_id,
                   o.attempt_id, o.request_hash, o.canonical_request_json,
                   e.store_sequence, e.source_sequence, e.simulated_order_id,
                   e.canonical_response_json, a.canonical_effect_json
            FROM simulated_orders AS o
            JOIN simulator_events AS e
              ON e.source_namespace_id = o.source_namespace_id
             AND e.client_order_id = o.client_order_id
            JOIN simulator_effect_attestations AS a
              ON a.store_sequence = e.store_sequence
            WHERE e.source_namespace_id = ? AND e.source_sequence = ?
            """,
            (source_namespace_id, source_sequence),
        ).fetchone()

    def _assert_namespace_integrity(
        self,
        connection: sqlite3.Connection,
        *,
        source_namespace_id: str,
    ) -> None:
        """Fail closed unless one namespace is a canonical event/order log.

        SQLite constraints protect normal writes, not an attacker or operator
        who alters individual rows.  This audit deliberately re-derives all
        bindings from canonical bytes for both retries and new allocations.
        Coordinated replacement of the entire database remains a separate
        store-identity/witness boundary and is not claimed here.
        """
        namespace = connection.execute(
            """SELECT latest_source_sequence, source_chain_hash
               FROM simulator_namespaces WHERE source_namespace_id = ?""",
            (source_namespace_id,),
        ).fetchone()
        orders = connection.execute(
            """
            SELECT source_namespace_id, client_order_id, command_id, attempt_id,
                   request_hash, canonical_request_json
            FROM simulated_orders
            WHERE source_namespace_id = ?
            """,
            (source_namespace_id,),
        ).fetchall()
        events = connection.execute(
            """
            SELECT source_namespace_id, source_sequence, client_order_id,
                   command_id, attempt_id, request_hash, state,
                   simulated_order_id, canonical_response_json
            FROM simulator_events
            WHERE source_namespace_id = ?
            ORDER BY source_sequence ASC
            """,
            (source_namespace_id,),
        ).fetchall()
        uses = connection.execute(
            "SELECT * FROM simulator_capability_uses WHERE source_namespace_id = ?",
            (source_namespace_id,),
        ).fetchall()

        if namespace is None:
            if orders or events or uses:
                self._integrity_failure("source history exists without its namespace head")
            return
        try:
            persisted_latest = int(namespace["latest_source_sequence"])
            persisted_chain_hash = str(namespace["source_chain_hash"])
            if persisted_latest < 0 or len(persisted_chain_hash) != 64 or any(
                character not in "0123456789abcdef"
                for character in persisted_chain_hash
            ):
                raise ValueError
        except (TypeError, ValueError):
            self._integrity_failure("namespace history head is malformed")

        if len(orders) != len(events):
            self._integrity_failure("orders/events cardinality mismatch")

        sequences = [row["source_sequence"] for row in events]
        if any(isinstance(sequence, bool) or not isinstance(sequence, int) for sequence in sequences):
            self._integrity_failure("source sequence is not an integer")
        if sequences != list(range(1, len(sequences) + 1)):
            self._integrity_failure("source sequence is not strictly contiguous")

        event_sequences = set(sequences)
        uses_by_sequence: dict[int, list[sqlite3.Row]] = {}
        for use in uses:
            source_sequence = use["source_sequence"]
            if (
                isinstance(source_sequence, bool)
                or not isinstance(source_sequence, int)
                or source_sequence not in event_sequences
            ):
                self._integrity_failure("capability use has an invalid source sequence")
            try:
                capability = parse_offline_simulator_capability_json_utf8(
                    bytes(use["canonical_capability_json"])
                )
            except (ContractValidationError, TypeError, ValueError) as error:
                raise SimulatorIntegrityError("stored capability use is not canonical") from error
            self._assert_stored_capability_signature(capability)
            if use["canonical_capability_hash"] != self._capability_hash(capability):
                self._integrity_failure("capability use canonical hash mismatch")
            expected_columns = {
                "capability_id": capability["capabilityId"],
                "source_namespace_id": capability["sourceNamespaceId"],
                "command_id": capability["commandId"],
                "attempt_id": capability["attemptId"],
                "attempt_adapter_epoch": capability["attemptAdapterEpoch"],
                "client_order_id": capability["clientOrderId"],
                "request_hash": capability["requestHash"],
                "authority_kind": capability["authorityKind"],
                "writer_name": capability["writerName"],
                "writer_owner_id": capability["writerOwnerId"],
                "writer_epoch": capability["writerEpoch"],
                "reconciliation_claim_id": capability.get("reconciliationClaimId"),
            }
            if any(use[column] != value for column, value in expected_columns.items()):
                self._integrity_failure("capability use bindings differ from canonical capability")
            uses_by_sequence.setdefault(source_sequence, []).append(use)

        orders_by_client_order_id: dict[object, sqlite3.Row] = {}
        for order in orders:
            client_order_id = order["client_order_id"]
            if client_order_id in orders_by_client_order_id:
                self._integrity_failure("duplicate simulated order identity")
            orders_by_client_order_id[client_order_id] = order

        if set(orders_by_client_order_id) != {event["client_order_id"] for event in events}:
            self._integrity_failure("orders/events client order identities differ")

        reconstructed_chain_hash = "0" * 64
        for event in events:
            order = orders_by_client_order_id.get(event["client_order_id"])
            if order is None:
                self._integrity_failure("event has no matching simulated order")
            request = self._parse_canonical_request(order["canonical_request_json"])
            request_hash = sha256_canonical(request)
            self._assert_exact_columns(
                order,
                request,
                request_hash=request_hash,
                source_namespace_id=source_namespace_id,
                label="simulated order",
            )
            for column in ("command_id", "attempt_id", "request_hash"):
                if event[column] != order[column]:
                    self._integrity_failure(f"event/order {column} mismatch")
            if event["source_namespace_id"] != source_namespace_id:
                self._integrity_failure("event namespace mismatch")
            if event["client_order_id"] != order["client_order_id"]:
                self._integrity_failure("event/order client order mismatch")

            expected_response = validate_offline_simulator_response_v1(
                {
                    "schemaVersion": OFFLINE_SIMULATOR_RESPONSE_V1,
                    "sourceNamespaceId": source_namespace_id,
                    "sourceSequence": str(event["source_sequence"]),
                    "commandId": request["commandId"],
                    "attemptId": request["attemptId"],
                    "requestHash": request_hash,
                    "clientOrderId": request["clientOrderId"],
                    "state": "submitted",
                    "simulatorOccurredAt": request["dispatchArmedAt"],
                    "simulatedOrderId": self._simulated_order_id(
                        source_namespace_id=source_namespace_id,
                        client_order_id=request["clientOrderId"],
                    ),
                }
            )
            response = self._parse_canonical_response(event["canonical_response_json"])
            if response != expected_response:
                self._integrity_failure("event response is not its exact canonical projection")
            if event["state"] != response["state"]:
                self._integrity_failure("event state differs from response")
            if event["simulated_order_id"] != response["simulatedOrderId"]:
                self._integrity_failure("event simulated order id differs from response")
            event_uses = uses_by_sequence.get(event["source_sequence"], [])
            if not event_uses:
                self._integrity_failure("source event has no capability use")
            for use in event_uses:
                if any(
                    use[column] != value
                    for column, value in {
                        "source_namespace_id": source_namespace_id,
                        "command_id": request["commandId"],
                        "attempt_id": request["attemptId"],
                        "attempt_adapter_epoch": request["adapterEpoch"],
                        "client_order_id": request["clientOrderId"],
                        "request_hash": request_hash,
                    }.items()
                ):
                    self._integrity_failure("capability use does not bind its source event")
            original_uses = [
                use
                for use in event_uses
                if use["authority_kind"] == "original_dispatch"
            ]
            if len(original_uses) != 1:
                self._integrity_failure(
                    "source event must have exactly one original capability use"
                )
            reconstructed_chain_hash = self._next_source_chain_hash(
                previous_hash=reconstructed_chain_hash,
                source_namespace_id=source_namespace_id,
                source_sequence=int(event["source_sequence"]),
                capability_id=str(original_uses[0]["capability_id"]),
                request_hash=request_hash,
                response_hash=sha256_canonical(response),
            )

        if (
            persisted_latest != len(events)
            or persisted_chain_hash != reconstructed_chain_hash
        ):
            self._integrity_failure(
                "namespace history head does not match its complete source chain"
            )

    def _assert_stored_capability_signature(
        self, capability: Mapping[str, Any]
    ) -> None:
        """Reverify historical authority without applying current-time expiry.

        A capability that was valid when consumed remains historical evidence
        after expiry.  Sampling its signed ``issuedAt`` rechecks the signature,
        trusted key, interval ordering, and maximum TTL without pretending the
        expired token still authorizes a new effect.
        """
        try:
            issued_at = datetime.strptime(
                str(capability["issuedAt"]), "%Y-%m-%dT%H:%M:%S.%fZ"
            ).replace(tzinfo=timezone.utc)
        except (KeyError, TypeError, ValueError):
            self._integrity_failure("capability use issuedAt is invalid")
        verification = verify_offline_simulator_capability_v1(
            capability=capability,
            key_resolver=self._capability_public_keys,
            now=issued_at,
        )
        if not verification.valid:
            self._integrity_failure(
                f"capability use signature is invalid: {verification.reason}"
            )
        if (
            capability.get("simulatorStoreId") != self.store_id
            or capability.get("sourceAttestationKeyId")
            != self._source_attestation_key_id
        ):
            self._integrity_failure(
                "capability use simulator store or source attestation key differs"
            )

    @staticmethod
    def _assert_exact_columns(
        order: sqlite3.Row,
        request: Mapping[str, Any],
        *,
        request_hash: str,
        source_namespace_id: str,
        label: str,
    ) -> None:
        expected = {
            "source_namespace_id": source_namespace_id,
            "client_order_id": request["clientOrderId"],
            "command_id": request["commandId"],
            "attempt_id": request["attemptId"],
            "request_hash": request_hash,
        }
        for column, value in expected.items():
            if order[column] != value:
                raise SimulatorIntegrityError(f"{label} {column} differs from canonical request")

    @classmethod
    def _parse_canonical_request(cls, value: object) -> dict[str, Any]:
        return cls._parse_canonical_json(
            value,
            validator=validate_offline_simulator_request_v1,
            label="canonical request",
        )

    @classmethod
    def _parse_canonical_response(cls, value: object) -> dict[str, Any]:
        return cls._parse_canonical_json(
            value,
            validator=validate_offline_simulator_response_v1,
            label="canonical response",
        )

    @staticmethod
    def _parse_canonical_json(
        value: object,
        *,
        validator: Callable[[Any], dict[str, Any]],
        label: str,
    ) -> dict[str, Any]:
        try:
            raw = bytes(value)
            parsed = validator(json.loads(raw.decode("utf-8")))
            if stable_stringify(parsed).encode("utf-8") != raw:
                raise SimulatorIntegrityError(f"{label} is not canonical UTF-8 JSON")
            return parsed
        except SimulatorIntegrityError:
            raise
        except (ContractValidationError, TypeError, UnicodeError, ValueError, OverflowError) as error:
            raise SimulatorIntegrityError(f"{label} cannot be parsed and validated") from error

    @staticmethod
    def _integrity_failure(reason: str) -> None:
        raise SimulatorIntegrityError(f"offline simulator source integrity failure: {reason}")

    @staticmethod
    def _simulated_order_id(*, source_namespace_id: str, client_order_id: str) -> str:
        digest = hashlib.sha256(
            stable_stringify(
                {
                    "domain": "openalice:offline-simulator-order:v1",
                    "sourceNamespaceId": source_namespace_id,
                    "clientOrderId": client_order_id,
                }
            ).encode("utf-8")
        ).hexdigest().upper()
        return "SIM" + digest[:40]

    @staticmethod
    def _result_from_row(row: sqlite3.Row, *, created: bool) -> OfflineSimulatorResult:
        return OfflineSimulatorResult(
            created=created,
            source_namespace_id=str(row["source_namespace_id"]),
            source_sequence=str(row["source_sequence"]),
            command_id=str(row["command_id"]),
            attempt_id=str(row["attempt_id"]),
            client_order_id=str(row["client_order_id"]),
            simulated_order_id=str(row["simulated_order_id"]),
            canonical_request_json_utf8=bytes(row["canonical_request_json"]),
            canonical_response_json_utf8=bytes(row["canonical_response_json"]),
            canonical_effect_json_utf8=bytes(row["canonical_effect_json"]),
        )
