"""Tests for the dependency-free paper environment attestation boundary."""

from __future__ import annotations

from dataclasses import FrozenInstanceError
from datetime import datetime, timedelta, timezone

import pytest

from sidecars.nautilus_paper.environment import (
    PAPER_ENVIRONMENT_PROOF_V1,
    PAPER_EXCHANGE,
    PAPER_LOCAL,
    DenyAllEnvironmentProvider,
    PaperEnvironmentDenied,
    PaperEnvironmentError,
    StaticEnvironmentProvider,
    build_paper_environment_proof_v1,
    canonical_sha256,
    validate_paper_environment_proof_v1,
)


NOW = datetime(2026, 8, 15, 0, 0, 1, tzinfo=timezone.utc)
OBSERVED = NOW - timedelta(seconds=1)
EXPIRES = NOW + timedelta(seconds=60)
DIGEST = "a" * 64
SCHEMA_HASH = "b" * 64


def build(mode: str = PAPER_LOCAL):
    return build_paper_environment_proof_v1(
        observed_at=OBSERVED,
        expires_at=EXPIRES,
        mode=mode,
        run_id="paper-run-1",
        config_digest=DIGEST,
        schema_hash=SCHEMA_HASH,
        endpoint_class="local_sandbox" if mode == PAPER_LOCAL else "okx_demo",
        credential_class="none" if mode == PAPER_LOCAL else "demo_only",
        execution_client_registered=mode == PAPER_EXCHANGE,
        now=NOW,
    )


def test_builds_immutable_hash_bound_canonical_proof() -> None:
    proof = build()
    assert proof.schemaVersion == PAPER_ENVIRONMENT_PROOF_V1
    assert proof.observedAt == "2026-08-15T00:00:00.000Z"
    assert proof.expiresAt == "2026-08-15T00:01:01.000Z"
    assert proof.proofHash == canonical_sha256(proof.core_dict())
    assert validate_paper_environment_proof_v1(proof, expected_mode=PAPER_LOCAL, now=NOW) == proof
    with pytest.raises(FrozenInstanceError):
        proof.venue = "OTHER"  # type: ignore[misc]


@pytest.mark.parametrize("mode", (PAPER_LOCAL, PAPER_EXCHANGE))
def test_only_the_two_explicit_mode_bindings_are_accepted(mode: str) -> None:
    proof = build(mode)
    assert validate_paper_environment_proof_v1(proof, expected_mode=mode, now=NOW).mode == mode


@pytest.mark.parametrize(
    ("field", "replacement"),
    (
        ("endpointClass", "okx_live"),
        ("credentialClass", "production"),
        ("liveTradingAllowed", True),
        ("liveExecutionArmed", True),
        ("paperOnly", False),
        ("venue", "BINANCE"),
    ),
)
def test_live_or_non_paper_values_fail_closed(field: str, replacement: object) -> None:
    value = build().to_dict()
    value[field] = replacement
    with pytest.raises(PaperEnvironmentError):
        validate_paper_environment_proof_v1(value, now=NOW)


def test_unknown_missing_bad_hash_and_mode_mismatch_fail_closed() -> None:
    proof = build().to_dict()
    proof["unexpected"] = "field"
    with pytest.raises(PaperEnvironmentError, match="unknown"):
        validate_paper_environment_proof_v1(proof, now=NOW)

    proof = build().to_dict()
    del proof["schemaHash"]
    with pytest.raises(PaperEnvironmentError, match="missing"):
        validate_paper_environment_proof_v1(proof, now=NOW)

    proof = build().to_dict()
    proof["proofHash"] = "0" * 64
    with pytest.raises(PaperEnvironmentError, match="proofHash"):
        validate_paper_environment_proof_v1(proof, now=NOW)

    with pytest.raises(PaperEnvironmentError, match="expected_mode"):
        validate_paper_environment_proof_v1(build(), expected_mode=PAPER_EXCHANGE, now=NOW)


def test_expired_future_and_noncanonical_timestamps_fail_closed() -> None:
    with pytest.raises(PaperEnvironmentError, match="expired"):
        validate_paper_environment_proof_v1(build(), now=EXPIRES)

    proof = build().to_dict()
    proof["observedAt"] = "2026-08-15T00:00:02.000Z"
    proof["proofHash"] = canonical_sha256({key: value for key, value in proof.items() if key != "proofHash"})
    with pytest.raises(PaperEnvironmentError, match="future"):
        validate_paper_environment_proof_v1(proof, now=NOW)

    proof = build().to_dict()
    proof["observedAt"] = "2026-08-15T00:00:00Z"
    with pytest.raises(PaperEnvironmentError, match="canonical"):
        validate_paper_environment_proof_v1(proof, now=NOW)


def test_providers_never_discover_credentials_and_revalidate() -> None:
    provider = StaticEnvironmentProvider(build(), clock=lambda: NOW)
    assert provider.get_proof(expected_mode=PAPER_LOCAL).mode == PAPER_LOCAL
    with pytest.raises(PaperEnvironmentDenied):
        DenyAllEnvironmentProvider().get_proof(expected_mode=PAPER_LOCAL, now=NOW)
