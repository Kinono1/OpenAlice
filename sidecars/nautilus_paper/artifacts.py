"""Strict, offline validation for the Nautilus top-level artifact inventory.

This module deliberately does not download, install, import, or execute
Nautilus.  Version 1 of the inventory records candidate wheel hashes only; it
cannot prove a transitive lock, release attestation, installation, or runtime
readiness.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
from typing import Any


NAUTILUS_ARTIFACTS_V1 = "openalice_nautilus_artifacts.v1"
NAUTILUS_PACKAGE = "nautilus_trader"
NAUTILUS_VERSION = "1.231.0"

_SHA256_RE = re.compile(r"^[a-f0-9]{64}$")
_ROOT_KEYS = frozenset((
    "schemaVersion", "resolvedAt", "package", "version", "developmentStatus",
    "requiresPython", "license", "releaseUrl", "indexMetadataUrl", "wheels",
    "admission",
))
_WHEEL_KEYS = frozenset(("platform", "python", "filename", "sha256"))
_ADMISSION_KEYS = frozenset((
    "allowedModes", "liveTradingAllowed", "liveExecutionArmed", "installState",
    "notes",
))
_SUPPORTED_PLATFORMS = frozenset((
    "macOS-26-arm64",
    "manylinux_2_35-x86_64",
    "manylinux_2_35-aarch64",
))


class ArtifactInventoryError(ValueError):
    """The pinned inventory or a candidate wheel failed closed."""


@dataclass(frozen=True, slots=True)
class WheelArtifact:
    platform: str
    python: str
    filename: str
    sha256: str


@dataclass(frozen=True, slots=True)
class ArtifactInventory:
    manifest_sha256: str
    selected_wheel: WheelArtifact
    install_state: str
    transitive_lock_verified: bool = False
    release_attestation_verified: bool = False
    wheel_file_verified: bool = False

    @property
    def installation_admission_ready(self) -> bool:
        """V1 is inventory-only and therefore can never authorize installation."""
        return (
            self.install_state == "installed_verified"
            and self.transitive_lock_verified
            and self.release_attestation_verified
            and self.wheel_file_verified
        )


def load_artifact_inventory_v1(
    path: str | Path,
    *,
    expected_manifest_sha256: str,
    platform: str,
    python_tag: str = "cp313",
) -> ArtifactInventory:
    """Load one externally hash-pinned inventory and select an exact wheel."""
    _require_sha256(expected_manifest_sha256, "expected_manifest_sha256")
    raw = Path(path).read_bytes()
    actual_manifest_sha256 = hashlib.sha256(raw).hexdigest()
    if actual_manifest_sha256 != expected_manifest_sha256:
        raise ArtifactInventoryError("artifact inventory SHA-256 does not match the external pin")
    try:
        text = raw.decode("utf-8", errors="strict")
        value = json.loads(text, object_pairs_hook=_object_without_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ArtifactInventoryError("artifact inventory must be strict UTF-8 JSON") from error
    if not isinstance(value, dict) or frozenset(value) != _ROOT_KEYS:
        raise ArtifactInventoryError("artifact inventory root fields must be exact")

    _equal(value, "schemaVersion", NAUTILUS_ARTIFACTS_V1)
    _aware_timestamp(value.get("resolvedAt"), "resolvedAt")
    _equal(value, "package", NAUTILUS_PACKAGE)
    _equal(value, "version", NAUTILUS_VERSION)
    _equal(value, "developmentStatus", "Beta")
    _equal(value, "requiresPython", ">=3.12,<3.15")
    _equal(value, "license", "LGPL-3.0-or-later")
    _equal(
        value,
        "releaseUrl",
        "https://github.com/nautechsystems/nautilus_trader/releases/tag/v1.231.0",
    )
    _equal(
        value,
        "indexMetadataUrl",
        "https://pypi.org/pypi/nautilus_trader/1.231.0/json",
    )

    wheels_value = value.get("wheels")
    if not isinstance(wheels_value, list) or len(wheels_value) != 3:
        raise ArtifactInventoryError("artifact inventory must contain exactly three MVP wheels")
    wheels: list[WheelArtifact] = []
    for item in wheels_value:
        if not isinstance(item, dict) or frozenset(item) != _WHEEL_KEYS:
            raise ArtifactInventoryError("wheel fields must be exact")
        item_platform = _text(item.get("platform"), "platform")
        if item_platform not in _SUPPORTED_PLATFORMS:
            raise ArtifactInventoryError("wheel platform is not in the MVP allowlist")
        item_python = _text(item.get("python"), "python")
        if item_python != "cp313":
            raise ArtifactInventoryError("only cp313 wheels are admitted by this inventory")
        filename = _text(item.get("filename"), "filename")
        expected_filename = _wheel_filename(item_platform)
        if filename != expected_filename:
            raise ArtifactInventoryError("wheel filename does not match package/version/platform")
        digest = _require_sha256(item.get("sha256"), "wheel sha256")
        wheels.append(WheelArtifact(item_platform, item_python, filename, digest))
    if len({item.platform for item in wheels}) != len(wheels):
        raise ArtifactInventoryError("wheel platforms must be unique")

    admission = value.get("admission")
    if not isinstance(admission, dict) or frozenset(admission) != _ADMISSION_KEYS:
        raise ArtifactInventoryError("artifact admission fields must be exact")
    if admission.get("allowedModes") != ["PAPER_LOCAL", "PAPER_EXCHANGE"]:
        raise ArtifactInventoryError("artifact modes must be the exact paper-only allowlist")
    if admission.get("liveTradingAllowed") is not False:
        raise ArtifactInventoryError("artifact inventory must deny live trading")
    if admission.get("liveExecutionArmed") is not False:
        raise ArtifactInventoryError("artifact inventory must deny live execution")
    if admission.get("installState") != "not_installed":
        raise ArtifactInventoryError("V1 inventory may only attest not_installed")
    notes = _text(admission.get("notes"), "notes")
    if "Transitive dependency locking" not in notes or "release-attestation" not in notes:
        raise ArtifactInventoryError("inventory must disclose its unresolved supply-chain gates")

    selected = next(
        (item for item in wheels if item.platform == platform and item.python == python_tag),
        None,
    )
    if selected is None:
        raise ArtifactInventoryError("no wheel matches the requested platform and Python tag")
    return ArtifactInventory(
        manifest_sha256=actual_manifest_sha256,
        selected_wheel=selected,
        install_state=admission["installState"],
    )


def verify_wheel_file(path: str | Path, artifact: WheelArtifact) -> None:
    """Verify a downloaded candidate without installing or importing it."""
    candidate = Path(path)
    if candidate.name != artifact.filename:
        raise ArtifactInventoryError("candidate wheel filename does not match the selected artifact")
    digest = hashlib.sha256()
    with candidate.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != artifact.sha256:
        raise ArtifactInventoryError("candidate wheel SHA-256 does not match the selected artifact")


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ArtifactInventoryError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _wheel_filename(platform: str) -> str:
    suffixes = {
        "macOS-26-arm64": "macosx_26_0_arm64",
        "manylinux_2_35-x86_64": "manylinux_2_35_x86_64",
        "manylinux_2_35-aarch64": "manylinux_2_35_aarch64",
    }
    return f"nautilus_trader-1.231.0-cp313-cp313-{suffixes[platform]}.whl"


def _equal(value: dict[str, Any], field: str, expected: str) -> None:
    if value.get(field) != expected:
        raise ArtifactInventoryError(f"{field} must equal {expected}")


def _text(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise ArtifactInventoryError(f"{field} must be trimmed non-empty text")
    return value


def _require_sha256(value: Any, field: str) -> str:
    if not isinstance(value, str) or _SHA256_RE.fullmatch(value) is None:
        raise ArtifactInventoryError(f"{field} must be a lowercase SHA-256")
    return value


def _aware_timestamp(value: Any, field: str) -> datetime:
    text = _text(value, field)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as error:
        raise ArtifactInventoryError(f"{field} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ArtifactInventoryError(f"{field} must include a UTC offset")
    return parsed
