"""Deterministic protobuf binding freshness check."""

from __future__ import annotations

from .generate_proto import check_generated_proto


def test_committed_proto_bindings_match_deterministic_generation() -> None:
    check_generated_proto()
