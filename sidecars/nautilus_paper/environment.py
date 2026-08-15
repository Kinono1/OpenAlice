"""Offline, fail-closed attestation for the paper execution environment.

This module intentionally has no configuration discovery, credential loading,
network access, or Nautilus dependency.  A caller must provide a complete,
hash-bound proof; anything not explicitly allowed is rejected.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import re
from typing import Any, Protocol


PAPER_ENVIRONMENT_PROOF_V1 = "openalice_paper_environment_proof.v1"
PAPER_LOCAL = "PAPER_LOCAL"
PAPER_EXCHANGE = "PAPER_EXCHANGE"

_MODES = frozenset((PAPER_LOCAL, PAPER_EXCHANGE))
_HASH_RE = re.compile(r"^[a-f0-9]{64}$")
_TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")
_FIELDS = frozenset((
    "schemaVersion", "proofHash", "observedAt", "expiresAt", "mode", "venue",
    "runId", "configDigest", "schemaHash", "paperOnly", "liveTradingAllowed",
    "liveExecutionArmed", "endpointClass", "credentialClass",
    "executionClientRegistered",
))


class PaperEnvironmentError(ValueError):
    """A proof is malformed or does not attest to a safe paper environment."""


class PaperEnvironmentDenied(PaperEnvironmentError):
    """No environment proof is available from the configured provider."""


@dataclass(frozen=True, slots=True)
class PaperEnvironmentProofV1:
    """Immutable, complete statement of the paper-only execution boundary."""

    schemaVersion: str
    proofHash: str
    observedAt: str
    expiresAt: str
    mode: str
    venue: str
    runId: str
    configDigest: str
    schemaHash: str
    paperOnly: bool
    liveTradingAllowed: bool
    liveExecutionArmed: bool
    endpointClass: str
    credentialClass: str
    executionClientRegistered: bool

    def to_dict(self) -> dict[str, Any]:
        """Return the exact wire representation, including its proof hash."""
        return {
            "schemaVersion": self.schemaVersion,
            "proofHash": self.proofHash,
            "observedAt": self.observedAt,
            "expiresAt": self.expiresAt,
            "mode": self.mode,
            "venue": self.venue,
            "runId": self.runId,
            "configDigest": self.configDigest,
            "schemaHash": self.schemaHash,
            "paperOnly": self.paperOnly,
            "liveTradingAllowed": self.liveTradingAllowed,
            "liveExecutionArmed": self.liveExecutionArmed,
            "endpointClass": self.endpointClass,
            "credentialClass": self.credentialClass,
            "executionClientRegistered": self.executionClientRegistered,
        }

    def core_dict(self) -> dict[str, Any]:
        """Return the hashed proof fields, excluding the self-referential hash."""
        value = self.to_dict()
        del value["proofHash"]
        return value


class PaperEnvironmentProvider(Protocol):
    """Minimal source of an already-created environment proof."""

    def get_proof(
        self, *, expected_mode: str | None = None, now: datetime | str | None = None
    ) -> PaperEnvironmentProofV1: ...


def canonical_json(value: Any) -> str:
    """Encode the limited JSON domain used by proofs deterministically.

    Floats and integers outside JavaScript's safe integer range are refused to
    avoid a proof hash that different runtimes can interpret differently.
    """
    if value is None or isinstance(value, (bool, str)):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > 9_007_199_254_740_991:
            raise PaperEnvironmentError("integer outside JavaScript safe range")
        return str(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonical_json(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if not all(isinstance(key, str) for key in value):
            raise PaperEnvironmentError("proof object keys must be strings")
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False, separators=(',', ':'))}:{canonical_json(value[key])}"
            for key in sorted(value)
        ) + "}"
    raise PaperEnvironmentError(f"unsupported canonical JSON type: {type(value).__name__}")


def canonical_sha256(value: Any) -> str:
    """Return the lowercase SHA-256 digest of canonical JSON UTF-8 bytes."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def build_paper_environment_proof_v1(
    *,
    observed_at: datetime | str,
    expires_at: datetime | str,
    mode: str,
    run_id: str,
    config_digest: str,
    schema_hash: str,
    endpoint_class: str,
    credential_class: str,
    execution_client_registered: bool,
    now: datetime | str | None = None,
) -> PaperEnvironmentProofV1:
    """Build and immediately validate a complete paper-only environment proof."""
    core = {
        "schemaVersion": PAPER_ENVIRONMENT_PROOF_V1,
        "observedAt": _format_timestamp(observed_at, "observedAt"),
        "expiresAt": _format_timestamp(expires_at, "expiresAt"),
        "mode": mode,
        "venue": "OKX",
        "runId": run_id,
        "configDigest": config_digest,
        "schemaHash": schema_hash,
        "paperOnly": True,
        "liveTradingAllowed": False,
        "liveExecutionArmed": False,
        "endpointClass": endpoint_class,
        "credentialClass": credential_class,
        "executionClientRegistered": execution_client_registered,
    }
    return validate_paper_environment_proof_v1(
        {**core, "proofHash": canonical_sha256(core)}, now=now
    )


def validate_paper_environment_proof_v1(
    input_value: PaperEnvironmentProofV1 | Mapping[str, Any],
    *,
    expected_mode: str | None = None,
    now: datetime | str | None = None,
) -> PaperEnvironmentProofV1:
    """Validate every proof field, freshness, mode, and its canonical hash.

    `now` exists for deterministic offline tests.  Production callers should
    leave it unset so freshness is compared with the current UTC time.
    """
    value = input_value.to_dict() if isinstance(input_value, PaperEnvironmentProofV1) else _object(input_value)
    if frozenset(value) != _FIELDS:
        missing, unknown = _FIELDS - frozenset(value), frozenset(value) - _FIELDS
        detail = []
        if missing:
            detail.append("missing=" + ",".join(sorted(missing)))
        if unknown:
            detail.append("unknown=" + ",".join(sorted(unknown)))
        raise PaperEnvironmentError("proof fields must be exact: " + "; ".join(detail))

    _exact_text(value, "schemaVersion", PAPER_ENVIRONMENT_PROOF_V1)
    proof_hash = _hash(value["proofHash"], "proofHash")
    observed = _parse_canonical_timestamp(value["observedAt"], "observedAt")
    expires = _parse_canonical_timestamp(value["expiresAt"], "expiresAt")
    mode = _one_of(value["mode"], "mode", _MODES)
    if expected_mode is not None:
        _one_of(expected_mode, "expected_mode", _MODES)
        if mode != expected_mode:
            raise PaperEnvironmentError("proof mode does not match expected_mode")
    _exact_text(value, "venue", "OKX")
    _text(value["runId"], "runId")
    _hash(value["configDigest"], "configDigest")
    _hash(value["schemaHash"], "schemaHash")
    _exact_bool(value["paperOnly"], "paperOnly", True)
    _exact_bool(value["liveTradingAllowed"], "liveTradingAllowed", False)
    _exact_bool(value["liveExecutionArmed"], "liveExecutionArmed", False)
    _mode_binding(value, mode)

    current = _as_utc_datetime(now, "now") if now is not None else datetime.now(timezone.utc)
    if observed > current:
        raise PaperEnvironmentError("proof observedAt is in the future")
    if expires <= observed:
        raise PaperEnvironmentError("expiresAt must be later than observedAt")
    if expires <= current:
        raise PaperEnvironmentError("proof has expired")

    core = {key: item for key, item in value.items() if key != "proofHash"}
    if canonical_sha256(core) != proof_hash:
        raise PaperEnvironmentError("proofHash must equal SHA-256 of the canonical proof core")
    return PaperEnvironmentProofV1(**value)


def build_paper_environment_proof(**kwargs: Any) -> PaperEnvironmentProofV1:
    """Compatibility spelling for the V1 builder."""
    return build_paper_environment_proof_v1(**kwargs)


def validate_paper_environment_proof(
    input_value: PaperEnvironmentProofV1 | Mapping[str, Any], **kwargs: Any
) -> PaperEnvironmentProofV1:
    """Compatibility spelling for the V1 validator."""
    return validate_paper_environment_proof_v1(input_value, **kwargs)


class DenyAllEnvironmentProvider:
    """Provider for deployments that intentionally admit no paper execution."""

    def get_proof(
        self, *, expected_mode: str | None = None, now: datetime | str | None = None
    ) -> PaperEnvironmentProofV1:
        del expected_mode, now
        raise PaperEnvironmentDenied("no paper environment proof provider is configured")

    attest = get_proof


class StaticEnvironmentProvider:
    """Offline test provider that serves one fixed proof and revalidates it."""

    def __init__(
        self,
        proof: PaperEnvironmentProofV1 | Mapping[str, Any],
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._proof = proof
        self._clock = clock

    def get_proof(
        self, *, expected_mode: str | None = None, now: datetime | str | None = None
    ) -> PaperEnvironmentProofV1:
        effective_now = now if now is not None else (self._clock() if self._clock else None)
        return validate_paper_environment_proof_v1(
            self._proof, expected_mode=expected_mode, now=effective_now
        )

    attest = get_proof


# Explicit long spellings keep call sites self-documenting while the shorter
# names remain convenient in focused tests.
DenyAllPaperEnvironmentProvider = DenyAllEnvironmentProvider
StaticPaperEnvironmentProvider = StaticEnvironmentProvider


def require_paper_environment(
    provider: PaperEnvironmentProvider,
    *,
    expected_mode: str | None = None,
    now: datetime | str | None = None,
) -> PaperEnvironmentProofV1:
    """Obtain and independently revalidate a provider-supplied proof.

    Providers are dependency-injection boundaries, not trust boundaries.  A
    custom provider cannot bypass strict fields, hashes, freshness, paper-only
    flags, or mode binding by returning an already-constructed object.
    """
    raw = provider.get_proof(expected_mode=expected_mode, now=now)
    return validate_paper_environment_proof_v1(
        raw,
        expected_mode=expected_mode,
        now=now,
    )


def _object(value: Any) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PaperEnvironmentError("proof must be an object")
    if not all(isinstance(key, str) for key in value):
        raise PaperEnvironmentError("proof keys must be strings")
    return value


def _text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip() or len(value) > 300:
        raise PaperEnvironmentError(f"{name} must be trimmed non-empty text of at most 300 characters")
    return value


def _exact_text(value: Mapping[str, Any], name: str, expected: str) -> None:
    if value[name] != expected or not isinstance(value[name], str):
        raise PaperEnvironmentError(f"{name} must equal {expected!r}")


def _hash(value: Any, name: str) -> str:
    if not isinstance(value, str) or not _HASH_RE.fullmatch(value):
        raise PaperEnvironmentError(f"{name} must be 64 lowercase hexadecimal characters")
    return value


def _one_of(value: Any, name: str, permitted: frozenset[str]) -> str:
    if not isinstance(value, str) or value not in permitted:
        raise PaperEnvironmentError(f"{name} is not permitted")
    return value


def _exact_bool(value: Any, name: str, expected: bool) -> None:
    if type(value) is not bool or value is not expected:
        raise PaperEnvironmentError(f"{name} must be {str(expected).lower()}")


def _mode_binding(value: Mapping[str, Any], mode: str) -> None:
    endpoint, credential, registered = (
        value["endpointClass"], value["credentialClass"], value["executionClientRegistered"]
    )
    if not isinstance(endpoint, str) or not isinstance(credential, str) or type(registered) is not bool:
        raise PaperEnvironmentError("endpoint, credential, and registration classes have invalid types")
    required = (
        ("local_sandbox", "none", False)
        if mode == PAPER_LOCAL
        else ("okx_demo", "demo_only", True)
    )
    if (endpoint, credential, registered) != required:
        raise PaperEnvironmentError("mode requires its exact safe endpoint, credential, and client binding")


def _format_timestamp(value: datetime | str, name: str) -> str:
    if isinstance(value, str):
        _parse_canonical_timestamp(value, name)
        return value
    instant = _as_utc_datetime(value, name)
    return instant.strftime("%Y-%m-%dT%H:%M:%S.") + f"{instant.microsecond // 1000:03d}Z"


def _parse_canonical_timestamp(value: Any, name: str) -> datetime:
    if not isinstance(value, str) or not _TIMESTAMP_RE.fullmatch(value):
        raise PaperEnvironmentError(f"{name} must be canonical UTC ISO-8601 milliseconds ending in Z")
    try:
        return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise PaperEnvironmentError(f"{name} is not a real UTC timestamp") from exc


def _as_utc_datetime(value: datetime | str | None, name: str) -> datetime:
    if isinstance(value, str):
        return _parse_canonical_timestamp(value, name)
    if not isinstance(value, datetime) or value.tzinfo is None or value.utcoffset() is None:
        raise PaperEnvironmentError(f"{name} must be a timezone-aware datetime or canonical UTC timestamp")
    return value.astimezone(timezone.utc)
