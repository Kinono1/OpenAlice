from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).parent
LOCK = ROOT / "requirements-macos-arm64-cp313.lock"
MANIFEST = ROOT / "dependency_lock.v1.json"
ARTIFACTS = ROOT / "nautilus_artifacts.v1.json"
VERIFICATION = ROOT / "dependency_verification.v1.json"
WHEELHOUSE_MANIFEST = ROOT / "wheelhouse-macos-arm64-cp313.sha256"
HASH_RE = re.compile(r"--hash=sha256:([a-f0-9]{64})")


def lock_entries(text: str) -> dict[str, tuple[str, str]]:
    lines = text.splitlines()
    entries: dict[str, tuple[str, str]] = {}
    for index, line in enumerate(lines):
        if "==" not in line or not line.endswith("\\"):
            continue
        name, version = line[:-1].strip().split("==", 1)
        digest_match = HASH_RE.fullmatch(lines[index + 1].strip())
        assert digest_match is not None
        entries[name.lower().replace("_", "-")] = (version, digest_match.group(1))
    return entries


def test_dependency_lock_manifest_binds_the_exact_hash_required_lock() -> None:
    lock_bytes = LOCK.read_bytes()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert manifest["schemaVersion"] == "openalice_nautilus_dependency_lock.v1"
    assert hashlib.sha256(lock_bytes).hexdigest() == manifest["lockFileSha256"]
    assert manifest["packageCount"] == 23
    assert manifest["wheelOnly"] is True
    assert manifest["hashesRequired"] is True
    assert manifest["transitiveResolutionLocked"] is True
    assert manifest["downloadSetVerified"] is True
    assert manifest["releaseAttestationVerified"] is True
    assert manifest["verificationReceipt"] == VERIFICATION.name
    assert manifest["isolatedInstallVerified"] is True
    assert manifest["installState"] == "not_installed"
    assert manifest["runtimeImportVerified"] is True
    assert manifest["paperOnly"] is True
    assert manifest["liveTradingAllowed"] is False
    assert manifest["liveExecutionArmed"] is False


def test_all_23_packages_are_exactly_pinned_with_one_selected_wheel_hash() -> None:
    text = LOCK.read_text(encoding="utf-8")
    assert "--only-binary=:all:" in text
    assert "--require-hashes" in text
    entries = lock_entries(text)
    hashes = HASH_RE.findall(text)
    assert len(entries) == 23
    assert len(hashes) == 23
    assert len(set(hashes)) == 23
    assert entries["nautilus-trader"][0] == "1.231.0"
    assert entries["grpcio"][0] == "1.82.1"
    assert entries["grpcio-tools"][0] == "1.82.1"
    assert entries["protobuf"][0] == "7.35.1"
    assert entries["cryptography"][0] == "49.0.0"


def test_nautilus_selected_hash_matches_the_top_level_artifact_inventory() -> None:
    text = LOCK.read_text(encoding="utf-8")
    artifacts = json.loads(ARTIFACTS.read_text(encoding="utf-8"))
    expected = next(
        item["sha256"]
        for item in artifacts["wheels"]
        if item["platform"] == "macOS-26-arm64" and item["python"] == "cp313"
    )
    assert lock_entries(text)["nautilus-trader"] == ("1.231.0", expected)


def test_download_and_release_verification_receipt_is_bounded_and_hash_bound() -> None:
    receipt = json.loads(VERIFICATION.read_text(encoding="utf-8"))
    wheelhouse_manifest = WHEELHOUSE_MANIFEST.read_bytes()
    assert receipt["schemaVersion"] == "openalice_nautilus_dependency_verification.v1"
    assert receipt["resolution"]["lockFileSha256"] == hashlib.sha256(LOCK.read_bytes()).hexdigest()
    assert receipt["resolution"]["packageCount"] == 23
    assert receipt["downloadSet"]["verified"] is True
    assert receipt["downloadSet"]["packageCount"] == 23
    assert receipt["downloadSet"]["artifactBytesCommitted"] is False
    assert receipt["downloadSet"]["manifestFile"] == WHEELHOUSE_MANIFEST.name
    assert receipt["downloadSet"]["manifestSha256"] == hashlib.sha256(wheelhouse_manifest).hexdigest()

    wheel_lines = [line for line in wheelhouse_manifest.decode("utf-8").splitlines() if line]
    wheel_hashes = {line.split("  ", 1)[0] for line in wheel_lines}
    assert len(wheel_lines) == 23
    assert wheel_hashes == set(HASH_RE.findall(LOCK.read_text(encoding="utf-8")))

    release = receipt["nautilusRelease"]
    assert release["artifact"]["sha256"] == lock_entries(LOCK.read_text(encoding="utf-8"))["nautilus-trader"][1]
    assert release["githubRelease"]["assetDigestMatched"] is True
    assert release["pypiTrustedPublisher"]["verified"] is True
    assert release["pypiTrustedPublisher"]["predicateType"] == "https://docs.pypi.org/attestations/publish/v1"
    assert release["slsaProvenance"]["verified"] is True
    assert release["slsaProvenance"]["predicateType"] == "https://slsa.dev/provenance/v1"
    assert release["slsaProvenance"]["sourceRef"] == "refs/heads/master"
    assert len(release["slsaProvenance"]["sourceCommit"]) == 40
    assert receipt["isolatedInstall"]["verified"] is True
    assert receipt["isolatedInstall"]["pipCheck"] == "PASS"
    assert receipt["isolatedInstall"]["environmentClass"] == "ephemeral_test_venv"
    assert receipt["isolatedInstall"]["environmentCommitted"] is False
    assert receipt["runtimeImports"] == {
        "verified": True,
        "python": "3.13.5",
        "machine": "arm64",
        "nautilusTrader": "1.231.0",
        "grpcio": "1.82.1",
        "protobuf": "7.35.1",
        "cryptography": "49.0.0",
        "tradingNode": "PASS",
        "okxConfig": "PASS",
        "okxFactories": "PASS",
        "priceQuantityRoundTrip": "PASS",
    }
    assert receipt["installState"] == "not_installed"
    assert receipt["runtimeImportVerified"] is True
    assert receipt["sidecarStarted"] is False
    assert receipt["brokerConnected"] is False
    assert receipt["liveTradingAllowed"] is False
    assert receipt["liveExecutionArmed"] is False
