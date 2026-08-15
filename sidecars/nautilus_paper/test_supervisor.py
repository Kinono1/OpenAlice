"""Focused contract tests for the foreground PAPER_LOCAL supervisor."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
from tempfile import TemporaryDirectory

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, NoEncryption, PrivateFormat, PublicFormat

from sidecars.nautilus_paper.contract import sha256_canonical
from sidecars.nautilus_paper.offline_receipt import ed25519_public_key_fingerprint_sha256
from sidecars.nautilus_paper.offline_simulator import OfflineSimulatorStore
from sidecars.nautilus_paper.supervisor import (
    PaperLocalSupervisor,
    SupervisorError,
    _validated_policy,
    load_config,
)


def _write(path: Path, value: bytes | str, mode: int = 0o600) -> None:
    path.write_bytes(value if isinstance(value, bytes) else value.encode())
    path.chmod(mode)


def _config(tmp_path: Path) -> Path:
    root = tmp_path / "run"
    root.mkdir(mode=0o700)
    keys = tmp_path / "keys"
    keys.mkdir(mode=0o700)
    permit = Ed25519PrivateKey.generate()
    capability = Ed25519PrivateKey.generate()
    receipt = Ed25519PrivateKey.generate()
    source = Ed25519PrivateKey.generate()
    _write(keys / "permit.pub", permit.public_key().public_bytes(Encoding.DER, PublicFormat.SubjectPublicKeyInfo))
    for name, key in (("cap.key", capability), ("receipt.key", receipt), ("source.key", source)):
        _write(keys / name, key.private_bytes(Encoding.DER, PrivateFormat.PKCS8, NoEncryption()))
    policy = {
        "schemaVersion": "openalice_offline_adapter_policy.v3", "receiptSchemaVersion": "openalice_offline_execution_receipt.v1",
        "receiptScope": "offline_simulator_only", "mode": "PAPER_LOCAL", "adapterId": "test.adapter",
        "adapterBuildHash": "a" * 64, "adapterConfigHash": "0" * 64, "adapterRunId": "supervisor-test",
        "sourceNamespaceId": "b" * 64, "adapterKeyId": "receipt", "adapterPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(receipt.public_key()),
        "permitAuthorityKeyId": "permit", "permitAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(permit.public_key()),
        "simulatorCapabilityAuthorityKeyId": "capability", "simulatorCapabilityAuthorityPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(capability.public_key()),
        "simulatorStoreId": "c" * 64, "sourceAttestationKeyId": "source", "sourceAttestationPublicKeySpkiSha256": ed25519_public_key_fingerprint_sha256(source.public_key()),
        "capability": "offline_simulator.ensure_exact.v2", "ensureExact": True, "finalizationEligible": False,
    }
    raw = {
        "schemaVersion": "openalice_paper_supervisor_config.v1", "mode": "PAPER_LOCAL", "runRoot": str(root),
        "ledgerPath": str(root / "ledger.sqlite3"), "simulatorDatabasePath": str(root / "simulator.sqlite3"),
        "statusPath": str(root / "status.json"), "policyPath": str(root / "policy.json"),
        "permitPublicKeyPath": str(keys / "permit.pub"), "capabilityAuthorityPrivateKeyPath": str(keys / "cap.key"),
        "receiptSigningPrivateKeyPath": str(keys / "receipt.key"), "sourceAttestationPrivateKeyPath": str(keys / "source.key"),
        "runId": "supervisor-test", "schemaHash": "d" * 64, "releaseManifestHash": "a" * 64,
        "proofValiditySeconds": 60, "leaseName": "test-supervisor", "ttlSeconds": 30, "queueSize": 8,
        "startupTimeoutSeconds": 5, "shutdownTimeoutSeconds": 5,
    }
    core = dict(policy)
    del core["adapterConfigHash"]
    policy["adapterConfigHash"] = sha256_canonical({"config": raw, "policyCore": core})
    _write(root / "policy.json", json.dumps(policy, separators=(",", ":")))
    store = OfflineSimulatorStore(root / "simulator.sqlite3", store_id=policy["simulatorStoreId"], capability_public_keys={"capability": capability.public_key()}, source_attestation_key_id="source", source_attestation_private_key=source, allow_provision=True)
    store.close()
    (root / "simulator.sqlite3").chmod(0o600)
    config = root / "config.json"
    _write(config, json.dumps(raw, separators=(",", ":")))
    return config


def test_exact_config_and_policy_binding(tmp_path: Path) -> None:
    config_path = _config(tmp_path)
    original = config_path.read_text()
    config = load_config(config_path)
    assert config.run_id == "supervisor-test"
    policy = config.policy_path.read_text()
    _write(config.policy_path, policy.replace("{", '{"adapterRunId":"ambiguous",', 1))
    with pytest.raises(SupervisorError, match="invalid_policy"):
        _validated_policy(config)
    _write(config.policy_path, policy)
    _write(config_path, original.replace("{", '{"runId":"ambiguous",', 1))
    with pytest.raises(SupervisorError, match="invalid_config"):
        load_config(config_path)
    _write(config_path, original)
    bad = json.loads(config_path.read_text())
    bad["unknown"] = True
    _write(config_path, json.dumps(bad))
    with pytest.raises(SupervisorError, match="invalid_config"):
        load_config(config_path)


def test_reserved_paths_and_in_process_restart_are_rejected(tmp_path: Path) -> None:
    config_path = _config(tmp_path)
    raw = json.loads(config_path.read_text())
    raw["statusPath"] = str(Path(raw["runRoot"]) / ".paper-local-supervisor.lock")
    _write(config_path, json.dumps(raw, separators=(",", ":")))
    with pytest.raises(SupervisorError, match="invalid_config"):
        load_config(config_path)

    fresh = tmp_path / "fresh"
    fresh.mkdir()
    config_path = _config(fresh)
    config = load_config(config_path)
    supervisor = PaperLocalSupervisor(config)
    os.chmod(config.policy_path, 0o644)
    with pytest.raises(SupervisorError, match="unsafe_input_file"):
        supervisor.start()
    os.chmod(config.policy_path, 0o600)
    with pytest.raises(SupervisorError, match="supervisor_restart_forbidden"):
        supervisor.start()


def test_private_files_and_lock_are_required(tmp_path: Path) -> None:
    config_path = _config(tmp_path)
    config = load_config(config_path)
    os.chmod(config.policy_path, 0o644)
    with pytest.raises(SupervisorError, match="unsafe_input_file"):
        PaperLocalSupervisor(config).start()
    os.chmod(config.policy_path, 0o600)
    one, two = PaperLocalSupervisor(config), PaperLocalSupervisor(config)
    one._acquire_lock()
    try:
        with pytest.raises(SupervisorError, match="supervisor_already_running"):
            two._acquire_lock()
    finally:
        one._release_lock()


def test_start_status_random_socket_and_clean_stop(tmp_path: Path) -> None:
    del tmp_path
    # UDS paths have a small kernel limit; production configs must account for
    # it too, so use a deliberately short private root for the real bind test.
    with TemporaryDirectory(dir="/private/tmp", prefix="ps-") as directory:
        root = Path(directory)
        root.chmod(0o700)
        config = load_config(_config(root))
        # The managed sandbox can prohibit UDS bind even in /private/tmp.
        # Keep static safety coverage green there; an unrestricted CI/macOS
        # runner still performs the full RuntimeExecutor listener exercise.
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            try:
                probe.bind(str(config.run_root / "bind-probe"))
            except PermissionError:
                pytest.skip("sandbox denies local UDS bind")
        finally:
            probe.close()
        supervisor = PaperLocalSupervisor(config)
        supervisor.start()
        try:
            assert supervisor.socket_path is not None and supervisor.socket_path.exists()
            assert supervisor.socket_path.parent.name == "sockets"
            status = json.loads(config.status_path.read_text())
            assert status["state"] == "READY_DURABLE_ONLY"
            assert status["flags"]["brokerSubmissionEnabled"] is False
            assert stat_mode(config.status_path) == 0o600
        finally:
            supervisor.stop()
        assert json.loads(config.status_path.read_text())["state"] == "STOPPED"


def stat_mode(path: Path) -> int:
    return path.stat().st_mode & 0o777
