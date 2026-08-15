"""Foreground-only, fail-closed supervisor for one PAPER_LOCAL sidecar.

This module deliberately has no configuration discovery, daemonisation,
restart loop, shell invocation, network client, broker, or Nautilus import.
This module CLI is an internal child entry used only after the release launcher
has verified the frozen runtime provenance and sealed release.  Operators must
enter through ``ops/release/launch_nautilus_paper.sh``; invoking this module
directly is unsupported and does not constitute D1 admission.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import fcntl
import json
import os
from pathlib import Path
import secrets
import signal
import stat
import sys
from threading import Event
from typing import Any

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import load_der_private_key, load_pem_private_key

from .contract import load_ed25519_public_key, sha256_canonical
from .core import OfflineAdmissionBinding, PaperSidecarCore
from .environment import StaticEnvironmentProvider, build_paper_environment_proof_v1
from .ledger import Ledger
from .offline_receipt import ed25519_public_key_fingerprint_sha256
from .runtime import OfflineExecutionRuntimeConfig, RuntimeExecutor, RuntimeIdentity, RuntimeState


_CONFIG_VERSION = "openalice_paper_supervisor_config.v1"
_FIELDS = frozenset((
    "schemaVersion", "mode", "runRoot", "ledgerPath", "simulatorDatabasePath",
    "statusPath", "policyPath", "permitPublicKeyPath",
    "capabilityAuthorityPrivateKeyPath", "receiptSigningPrivateKeyPath",
    "sourceAttestationPrivateKeyPath", "runId", "schemaHash",
    "releaseManifestHash", "proofValiditySeconds", "leaseName", "ttlSeconds",
    "queueSize", "startupTimeoutSeconds", "shutdownTimeoutSeconds",
))
_MAX_CONFIG = 128 * 1024
_MAX_POLICY = 256 * 1024
_MAX_KEY = 64 * 1024
_HASH = __import__("re").compile(r"^[a-f0-9]{64}$")


class SupervisorError(ValueError):
    """A stable, non-sensitive startup failure code."""


@dataclass(frozen=True, slots=True)
class SupervisorConfig:
    raw: dict[str, Any]
    run_root: Path
    ledger_path: Path
    simulator_database_path: Path
    status_path: Path
    policy_path: Path
    permit_public_key_path: Path
    capability_private_key_path: Path
    receipt_private_key_path: Path
    source_private_key_path: Path
    run_id: str
    schema_hash: str
    release_manifest_hash: str
    proof_validity_seconds: float
    lease_name: str
    ttl_seconds: float
    queue_size: int
    startup_timeout_seconds: float
    shutdown_timeout_seconds: float


def _absolute(value: Any) -> Path:
    if not isinstance(value, str) or not value or "\x00" in value or not os.path.isabs(value):
        raise SupervisorError("invalid_config")
    return Path(os.path.normpath(value))


def _private_directory(path: Path) -> None:
    try:
        entry = path.lstat()
    except OSError:
        raise SupervisorError("unsafe_path") from None
    if (stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode)
            or entry.st_uid != os.getuid() or entry.st_mode & 0o077):
        raise SupervisorError("unsafe_path")
    current = Path("/")
    for piece in path.parts[1:]:
        current /= piece
        if current == Path("/"):
            continue
        try:
            ancestor = current.lstat()
        except OSError:
            raise SupervisorError("unsafe_path") from None
        if stat.S_ISLNK(ancestor.st_mode):
            raise SupervisorError("unsafe_path")


def _secure_read(path: Path, *, maximum: int) -> bytes:
    """Read one current-user private regular file without following its leaf."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise SupervisorError("unsafe_input_file") from None
    try:
        entry = os.fstat(fd)
        if (not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid()
                or entry.st_mode & 0o077 or entry.st_nlink != 1 or entry.st_size > maximum):
            raise SupervisorError("unsafe_input_file")
        chunks: list[bytes] = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        result = b"".join(chunks)
        if not result or len(result) > maximum:
            raise SupervisorError("unsafe_input_file")
        return result
    finally:
        os.close(fd)


def _parse_json(raw: bytes, *, code: str) -> dict[str, Any]:
    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        parsed: dict[str, Any] = {}
        for key, value in pairs:
            if key in parsed:
                raise SupervisorError(code)
            parsed[key] = value
        return parsed

    try:
        value = json.loads(raw.decode("utf-8"), object_pairs_hook=reject_duplicates)
    except SupervisorError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise SupervisorError(code) from None
    if not isinstance(value, dict):
        raise SupervisorError(code)
    return value


def _positive(value: Any, *, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= maximum:
        raise SupervisorError("invalid_config")
    return float(value)


def load_config(path: str | Path) -> SupervisorConfig:
    """Load exactly one explicitly named JSON config with no discovery fallback."""
    config_path = _absolute(os.fspath(path))
    _private_directory(config_path.parent)
    raw = _parse_json(_secure_read(config_path, maximum=_MAX_CONFIG), code="invalid_config")
    if frozenset(raw) != _FIELDS or raw.get("schemaVersion") != _CONFIG_VERSION or raw.get("mode") != "PAPER_LOCAL":
        raise SupervisorError("invalid_config")
    paths = {key: _absolute(raw[key]) for key in (
        "runRoot", "ledgerPath", "simulatorDatabasePath", "statusPath", "policyPath",
        "permitPublicKeyPath", "capabilityAuthorityPrivateKeyPath",
        "receiptSigningPrivateKeyPath", "sourceAttestationPrivateKeyPath",
    )}
    lock_path = paths["runRoot"] / ".paper-local-supervisor.lock"
    role_paths = (
        lock_path, paths["ledgerPath"], paths["simulatorDatabasePath"],
        paths["statusPath"], paths["policyPath"], paths["permitPublicKeyPath"],
        paths["capabilityAuthorityPrivateKeyPath"],
        paths["receiptSigningPrivateKeyPath"],
        paths["sourceAttestationPrivateKeyPath"],
    )
    if len(set(role_paths)) != len(role_paths):
        raise SupervisorError("invalid_config")
    _private_directory(paths["runRoot"])
    for key in ("ledgerPath", "simulatorDatabasePath", "statusPath"):
        _private_directory(paths[key].parent)
    for key in ("policyPath", "permitPublicKeyPath", "capabilityAuthorityPrivateKeyPath", "receiptSigningPrivateKeyPath", "sourceAttestationPrivateKeyPath"):
        _private_directory(paths[key].parent)
    hashes = (raw["schemaHash"], raw["releaseManifestHash"])
    if (not all(isinstance(item, str) and _HASH.fullmatch(item) for item in hashes)
            or not isinstance(raw["runId"], str) or not raw["runId"] or raw["runId"] != raw["runId"].strip() or len(raw["runId"]) > 300
            or not isinstance(raw["leaseName"], str) or not raw["leaseName"] or raw["leaseName"] != raw["leaseName"].strip() or len(raw["leaseName"]) > 200
            or type(raw["queueSize"]) is not int or not 0 < raw["queueSize"] <= 4096):
        raise SupervisorError("invalid_config")
    return SupervisorConfig(
        raw=raw, run_root=paths["runRoot"], ledger_path=paths["ledgerPath"],
        simulator_database_path=paths["simulatorDatabasePath"], status_path=paths["statusPath"],
        policy_path=paths["policyPath"], permit_public_key_path=paths["permitPublicKeyPath"],
        capability_private_key_path=paths["capabilityAuthorityPrivateKeyPath"],
        receipt_private_key_path=paths["receiptSigningPrivateKeyPath"],
        source_private_key_path=paths["sourceAttestationPrivateKeyPath"], run_id=raw["runId"],
        schema_hash=raw["schemaHash"], release_manifest_hash=raw["releaseManifestHash"],
        proof_validity_seconds=_positive(raw["proofValiditySeconds"], maximum=3600), lease_name=raw["leaseName"],
        ttl_seconds=_positive(raw["ttlSeconds"], maximum=3600), queue_size=raw["queueSize"],
        startup_timeout_seconds=_positive(raw["startupTimeoutSeconds"], maximum=120),
        shutdown_timeout_seconds=_positive(raw["shutdownTimeoutSeconds"], maximum=120),
    )


def _private_key(raw: bytes) -> Ed25519PrivateKey:
    for loader in (load_pem_private_key, load_der_private_key):
        try:
            value = loader(raw, password=None)
        except (TypeError, ValueError):
            continue
        if isinstance(value, Ed25519PrivateKey):
            return value
    raise SupervisorError("invalid_key_material")


def _validated_policy(config: SupervisorConfig) -> tuple[dict[str, Any], str, Any, Ed25519PrivateKey, Ed25519PrivateKey, Ed25519PrivateKey]:
    policy = _parse_json(_secure_read(config.policy_path, maximum=_MAX_POLICY), code="invalid_policy")
    try:
        policy = Ledger._offline_adapter_policy(policy)
    except Exception:
        raise SupervisorError("invalid_policy") from None
    if (policy.get("schemaVersion") != "openalice_offline_adapter_policy.v3"
            or policy.get("mode") != "PAPER_LOCAL" or policy.get("finalizationEligible") is not False
            or policy.get("adapterBuildHash") != config.release_manifest_hash
            or policy.get("adapterRunId") != config.run_id):
        raise SupervisorError("policy_binding_failed")
    policy_core = dict(policy)
    del policy_core["adapterConfigHash"]
    digest = sha256_canonical({"config": config.raw, "policyCore": policy_core})
    if policy["adapterConfigHash"] != digest:
        raise SupervisorError("policy_binding_failed")
    try:
        permit = load_ed25519_public_key(_secure_read(config.permit_public_key_path, maximum=_MAX_KEY))
    except Exception:
        raise SupervisorError("invalid_key_material") from None
    capability = _private_key(_secure_read(config.capability_private_key_path, maximum=_MAX_KEY))
    receipt = _private_key(_secure_read(config.receipt_private_key_path, maximum=_MAX_KEY))
    source = _private_key(_secure_read(config.source_private_key_path, maximum=_MAX_KEY))
    fingerprints = (
        ed25519_public_key_fingerprint_sha256(permit),
        ed25519_public_key_fingerprint_sha256(capability.public_key()),
        ed25519_public_key_fingerprint_sha256(receipt.public_key()),
        ed25519_public_key_fingerprint_sha256(source.public_key()),
    )
    expected = (
        policy["permitAuthorityPublicKeySpkiSha256"],
        policy["simulatorCapabilityAuthorityPublicKeySpkiSha256"],
        policy["adapterPublicKeySpkiSha256"],
        policy["sourceAttestationPublicKeySpkiSha256"],
    )
    if fingerprints != expected or len(set(fingerprints)) != 4:
        raise SupervisorError("key_policy_binding_failed")
    return policy, digest, permit, capability, receipt, source


def _existing_private_file(path: Path) -> None:
    try:
        entry = path.lstat()
    except OSError:
        raise SupervisorError("unsafe_runtime_path") from None
    if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077:
        raise SupervisorError("unsafe_runtime_path")


class PaperLocalSupervisor:
    """One foreground owner.  A disarmed runtime remains readable until stop."""

    def __init__(self, config: SupervisorConfig) -> None:
        self.config = config
        self.stop_event = Event()
        self.incarnation_id = secrets.token_hex(16)
        self.runtime: RuntimeExecutor | None = None
        self._lock_fd: int | None = None
        self.socket_path: Path | None = None
        self.config_digest: str | None = None
        self.policy_hash: str | None = None
        self._start_attempted = False

    def _acquire_lock(self) -> None:
        lock_path = self.config.run_root / ".paper-local-supervisor.lock"
        try:
            fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            entry = os.fstat(fd)
            if not stat.S_ISREG(entry.st_mode) or entry.st_uid != os.getuid() or entry.st_mode & 0o077 or entry.st_nlink != 1:
                raise SupervisorError("unsafe_supervisor_lock")
            os.fchmod(fd, 0o600)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except SupervisorError:
            raise
        except OSError:
            raise SupervisorError("supervisor_already_running") from None
        self._lock_fd = fd

    def _release_lock(self) -> None:
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = None

    def _write_status(self, state: str, *, reason: str | None = None) -> None:
        runtime_state = self.runtime.supervisor.state.value if self.runtime else None
        writer_epoch, latest_sequence, write_disarmed = 0, 0, False
        if self.runtime is not None:
            try:
                health = self.runtime.health()
                writer_epoch, latest_sequence = health.writer_epoch, health.latest_sequence
                write_disarmed = runtime_state == RuntimeState.WRITE_DISARMED.value
            except Exception:
                write_disarmed = runtime_state == RuntimeState.WRITE_DISARMED.value
        value = {
            "schemaVersion": "openalice_paper_supervisor_status.v1", "state": state,
            "reason": reason, "incarnationId": self.incarnation_id,
            "runId": self.config.run_id, "mode": "PAPER_LOCAL", "schemaHash": self.config.schema_hash,
            "releaseManifestHash": self.config.release_manifest_hash, "configDigest": self.config_digest,
            "policyHash": self.policy_hash, "socketPath": str(self.socket_path) if self.socket_path else None,
            "writerEpoch": writer_epoch, "latestSequence": latest_sequence,
            "flags": {
                "durableAdmissionAuthority": state == "READY_DURABLE_ONLY" and not write_disarmed,
                "brokerAuthority": False,
                "writeDisarmed": write_disarmed,
                "brokerSubmissionEnabled": False,
            },
        }
        encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
        parent = self.config.status_path.parent
        _private_directory(parent)
        temporary = parent / ("." + self.config.status_path.name + "." + secrets.token_hex(8) + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.write(fd, encoded)
            # macOS Python does not expose fdatasync; fsync is the stronger
            # equivalent there and keeps the publication protocol durable.
            sync = getattr(os, "fdatasync", os.fsync)
            sync(fd)
        finally:
            os.close(fd)
        os.replace(temporary, self.config.status_path)
        os.chmod(self.config.status_path, 0o600)
        directory_fd = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)

    def start(self) -> None:
        if self._start_attempted:
            raise SupervisorError("supervisor_restart_forbidden")
        self._start_attempted = True
        self._acquire_lock()
        try:
            self._write_status("STARTING")
            _existing_private_file(self.config.simulator_database_path)
            policy, digest, permit, capability, receipt, source = _validated_policy(self.config)
            self.config_digest, self.policy_hash = digest, sha256_canonical(policy)
            sockets = self.config.run_root / "sockets"
            try:
                sockets.mkdir(mode=0o700)
            except FileExistsError:
                pass
            _private_directory(sockets)
            # The gRPC publisher also creates a longer random staging sibling;
            # keep the public basename deliberately short for macOS UDS limits.
            self.socket_path = sockets / ("s-" + secrets.token_hex(8))
            now = datetime.now(timezone.utc)
            proof = build_paper_environment_proof_v1(
                observed_at=now, expires_at=now + timedelta(seconds=self.config.proof_validity_seconds),
                mode="PAPER_LOCAL", run_id=self.config.run_id, config_digest=digest,
                schema_hash=self.config.schema_hash, endpoint_class="local_sandbox",
                credential_class="none", execution_client_registered=False,
            )
            identity = RuntimeIdentity("PAPER_LOCAL", self.config.run_id, proof.proofHash, self.config.schema_hash)
            offline = OfflineExecutionRuntimeConfig(
                policy=policy, simulator_database_path=self.config.simulator_database_path,
                permit_public_key=permit, capability_authority_key_id=policy["simulatorCapabilityAuthorityKeyId"],
                capability_authority_private_key=capability, receipt_signing_key_id=policy["adapterKeyId"],
                receipt_signing_private_key=receipt, source_attestation_key_id=policy["sourceAttestationKeyId"],
                source_attestation_private_key=source,
            )
            binding = OfflineAdmissionBinding(self.policy_hash, policy["permitAuthorityKeyId"], permit)
            def core_factory(ledger: Ledger, _lease: Any) -> PaperSidecarCore:
                return PaperSidecarCore(
                    ledger, environment_provider=StaticEnvironmentProvider(proof),
                    resolve_public_key=lambda key_id: permit if key_id == policy["permitAuthorityKeyId"] else None,
                    expected_schema_hash=self.config.schema_hash, run_id=self.config.run_id,
                    expected_key_ids=(policy["permitAuthorityKeyId"],), offline_admission_binding=binding,
                    resolve_offline_receipt_public_key=lambda key_id: receipt.public_key() if key_id == policy["adapterKeyId"] else None,
                    expected_offline_receipt_key_ids=(policy["adapterKeyId"],),
                )
            self.runtime = RuntimeExecutor(
                self.config.ledger_path, self.socket_path, core_factory=core_factory,
                expected_identity=identity, lease_name=self.config.lease_name, ttl_seconds=self.config.ttl_seconds,
                queue_size=self.config.queue_size, offline_execution=offline,
                startup_timeout_seconds=self.config.startup_timeout_seconds,
                shutdown_timeout_seconds=self.config.shutdown_timeout_seconds,
            )
            self.runtime.start()
            state = "READ_ONLY_DISARMED" if self.runtime.supervisor.state is RuntimeState.WRITE_DISARMED else "READY_DURABLE_ONLY"
            self._write_status(state)
        except SupervisorError:
            if self.runtime is not None:
                try:
                    self.runtime.stop()
                except Exception:
                    pass
            try:
                self._write_status("FAILED", reason="startup_failed")
            except Exception:
                pass
            finally:
                self._release_lock()
            raise
        except Exception:
            if self.runtime is not None:
                try:
                    self.runtime.stop()
                except Exception:
                    pass
            try:
                self._write_status("FAILED", reason="startup_failed")
            except Exception:
                pass
            finally:
                self._release_lock()
            raise SupervisorError("startup_failed") from None

    def stop(self) -> None:
        first_error: Exception | None = None
        try:
            try:
                self._write_status("STOPPING")
            except Exception as error:
                first_error = error
            try:
                if self.runtime is not None:
                    self.runtime.stop()
            except Exception as error:
                if first_error is None:
                    first_error = error
            if first_error is None:
                self._write_status("STOPPED")
        finally:
            self._release_lock()
        if first_error is not None:
            raise first_error

    def run(self) -> int:
        try:
            self.start()
            disarmed_reported = (
                self.runtime is not None
                and self.runtime.supervisor.state is RuntimeState.WRITE_DISARMED
            )
            while not self.stop_event.wait(0.1):
                if (self.runtime is not None
                        and self.runtime.supervisor.state is RuntimeState.WRITE_DISARMED
                        and not disarmed_reported):
                    self._write_status("READ_ONLY_DISARMED")
                    disarmed_reported = True
            return 0
        except SupervisorError:
            return 3
        finally:
            if self._lock_fd is not None:
                try:
                    self.stop()
                except Exception:
                    self._release_lock()


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--check-config", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    os.umask(0o077)
    try:
        arguments = _arguments(argv)
        config = load_config(arguments.config)
        if arguments.check_config:
            _validated_policy(config)
            _existing_private_file(config.simulator_database_path)
            return 0
        supervisor = PaperLocalSupervisor(config)
        previous: dict[int, Any] = {}
        def request_stop(_signum: int, _frame: Any) -> None:
            supervisor.stop_event.set()
        for item in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP, signal.SIGQUIT):
            previous[item] = signal.signal(item, request_stop)
        try:
            return supervisor.run()
        finally:
            for item, handler in previous.items():
                signal.signal(item, handler)
    except SupervisorError as error:
        print(error.args[0], file=sys.stderr)
        return 2
    except (ValueError, OSError):
        print("invalid_config", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
