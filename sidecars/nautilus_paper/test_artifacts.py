from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from .artifacts import (
    ArtifactInventoryError,
    load_artifact_inventory_v1,
    verify_wheel_file,
)


MANIFEST = Path(__file__).with_name("nautilus_artifacts.v1.json")
MANIFEST_SHA256 = "a39ac0c0794aac02c79f1ae6d4e24ae3dace5c91b254d3e91290e310eb9cbedf"


def test_loads_externally_pinned_inventory_without_claiming_readiness() -> None:
    inventory = load_artifact_inventory_v1(
        MANIFEST,
        expected_manifest_sha256=MANIFEST_SHA256,
        platform="macOS-26-arm64",
    )
    assert inventory.manifest_sha256 == MANIFEST_SHA256
    assert inventory.selected_wheel.filename.endswith("macosx_26_0_arm64.whl")
    assert inventory.selected_wheel.sha256 == (
        "b9312bd17cb068bd9407cf360103f7b23c09aaf6118a6321da3def2fe8edaa3d"
    )
    assert inventory.install_state == "not_installed"
    assert inventory.transitive_lock_verified is False
    assert inventory.release_attestation_verified is False
    assert inventory.wheel_file_verified is False
    assert inventory.installation_admission_ready is False


def test_rejects_manifest_tampering_before_trusting_fields(tmp_path: Path) -> None:
    tampered = tmp_path / MANIFEST.name
    tampered.write_bytes(MANIFEST.read_bytes().replace(b'"Beta"', b'"Stable"'))
    with pytest.raises(ArtifactInventoryError, match="external pin"):
        load_artifact_inventory_v1(
            tampered,
            expected_manifest_sha256=MANIFEST_SHA256,
            platform="macOS-26-arm64",
        )


def test_rejects_unknown_platform_and_wrong_external_pin() -> None:
    with pytest.raises(ArtifactInventoryError, match="no wheel"):
        load_artifact_inventory_v1(
            MANIFEST,
            expected_manifest_sha256=MANIFEST_SHA256,
            platform="macOS-25-arm64",
        )
    with pytest.raises(ArtifactInventoryError, match="external pin"):
        load_artifact_inventory_v1(
            MANIFEST,
            expected_manifest_sha256="0" * 64,
            platform="macOS-26-arm64",
        )


def test_rejects_duplicate_json_keys_even_with_a_matching_pin(tmp_path: Path) -> None:
    raw = MANIFEST.read_text(encoding="utf-8")
    duplicate = raw.replace(
        '"schemaVersion": "openalice_nautilus_artifacts.v1",',
        '"schemaVersion": "openalice_nautilus_artifacts.v1",\n  "schemaVersion": "openalice_nautilus_artifacts.v1",',
    ).encode("utf-8")
    path = tmp_path / MANIFEST.name
    path.write_bytes(duplicate)
    with pytest.raises(ArtifactInventoryError, match="duplicate JSON key"):
        load_artifact_inventory_v1(
            path,
            expected_manifest_sha256=hashlib.sha256(duplicate).hexdigest(),
            platform="macOS-26-arm64",
        )


def test_candidate_wheel_hash_is_checked_without_installing(tmp_path: Path) -> None:
    inventory = load_artifact_inventory_v1(
        MANIFEST,
        expected_manifest_sha256=MANIFEST_SHA256,
        platform="macOS-26-arm64",
    )
    candidate = tmp_path / inventory.selected_wheel.filename
    candidate.write_bytes(b"not the pinned wheel")
    with pytest.raises(ArtifactInventoryError, match="wheel SHA-256"):
        verify_wheel_file(candidate, inventory.selected_wheel)


def test_manifest_remains_valid_json_for_external_tools() -> None:
    assert json.loads(MANIFEST.read_text(encoding="utf-8"))["version"] == "1.231.0"
