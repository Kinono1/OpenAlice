#!/usr/bin/env python3
"""Fail-closed verifier for the isolated PAPER_LOCAL sidecar runtime.

The command must be invoked by the candidate venv's interpreter.  It imports
only Python's standard library until the static filesystem and RECORD checks
have completed; smoke imports occur last and are not evidence of Nautilus use.
"""
from __future__ import annotations

import argparse
import base64
import csv
import datetime as _datetime
from dataclasses import dataclass
import hashlib
import importlib
import importlib.metadata
import json
import os
import platform
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterable, Mapping


SCHEMA = "openalice_sidecar_environment_receipt.v1"
EXPECTED_PACKAGES = (
    "cffi", "cryptography", "grpcio", "protobuf", "pycparser", "typing-extensions",
)
SMOKE_IMPORTS = ("cryptography", "grpc", "google.protobuf", "cffi")
EXPECTED_PRODUCTION_MODULES = (
    "sidecars.nautilus_paper.contract",
    "sidecars.nautilus_paper.core",
    "sidecars.nautilus_paper.environment",
    "sidecars.nautilus_paper.generated.openalice_execution_v1_pb2",
    "sidecars.nautilus_paper.generated.openalice_execution_v1_pb2_grpc",
    "sidecars.nautilus_paper.grpc_receiver",
    "sidecars.nautilus_paper.ledger",
    "sidecars.nautilus_paper.offline_effect",
    "sidecars.nautilus_paper.offline_execution",
    "sidecars.nautilus_paper.offline_receipt",
    "sidecars.nautilus_paper.offline_simulator",
    "sidecars.nautilus_paper.runtime",
    "sidecars.nautilus_paper.supervisor",
    "sidecars.nautilus_paper.verify_release_environment",
)
_HEX = set("0123456789abcdef")


class VerificationError(Exception):
    """A stable, path-free rejection reason suitable for an operator."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _fail(code: str) -> None:
    raise VerificationError(code)


@dataclass(frozen=True)
class _RuntimeTrust:
    """The verifier has only a local gate mode and a deployment mode.

    ``release-gate`` is deliberately limited to the invoking publisher's
    candidate venv.  ``deployment`` additionally establishes that the process
    is a non-root service distinct from the expected publisher and cannot
    rewrite any verified runtime pathname.
    """

    mode: str
    publisher_uid: int | None
    service_real_uid: int
    service_effective_uid: int


def _runtime_trust(mode: str, publisher_uid: int | None) -> _RuntimeTrust:
    real_uid, effective_uid = os.getuid(), os.geteuid()
    if mode == "release-gate":
        if publisher_uid is not None:
            _fail("TRUST_ARGUMENT_INVALID")
        return _RuntimeTrust(mode, None, real_uid, effective_uid)
    if mode != "deployment" or not isinstance(publisher_uid, int) or publisher_uid < 0:
        _fail("TRUST_ARGUMENT_INVALID")
    if real_uid == 0 or effective_uid == 0 or real_uid != effective_uid:
        _fail("DEPLOYMENT_SERVICE_UID_UNSAFE")
    if publisher_uid in {real_uid, effective_uid}:
        _fail("DEPLOYMENT_PUBLISHER_UID_UNSAFE")
    return _RuntimeTrust(mode, publisher_uid, real_uid, effective_uid)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _is_hex(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HEX


def _strict_json(path: Path) -> dict[str, Any]:
    def no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                _fail("CONTRACT_DUPLICATE_KEY")
            result[key] = value
        return result
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=no_duplicates)
    except VerificationError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError):
        _fail("CONTRACT_PARSE_FAILED")
    if not isinstance(parsed, dict):
        _fail("CONTRACT_NOT_OBJECT")
    return parsed


def _expect_exact_keys(value: Mapping[str, Any], keys: Iterable[str], code: str) -> None:
    if set(value) != set(keys):
        _fail(code)


def _safe_relative(value: object, code: str) -> Path:
    if not isinstance(value, str) or not value or "\\" in value:
        _fail(code)
    item = Path(value)
    if item.is_absolute() or ".." in item.parts or "." in item.parts:
        _fail(code)
    return item


def _regular_private(path: Path, code: str, *, owner: int | None = None) -> os.stat_result:
    try:
        status = path.lstat()
    except OSError:
        _fail(code)
    if stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode):
        _fail(code)
    if status.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
        _fail(code)
    if owner is not None and status.st_uid != owner:
        _fail(code)
    return status


def _private_tree(path: Path, code: str, *, owner: int) -> None:
    """Require every component from the subject up to filesystem root private."""
    current = path
    subject = True
    while True:
        try:
            status = current.lstat()
        except OSError:
            _fail(code)
        if stat.S_ISLNK(status.st_mode) or not stat.S_ISDIR(status.st_mode):
            _fail(code)
        if (subject and status.st_uid != owner) or status.st_mode & (stat.S_IWGRP | stat.S_IWOTH):
            _fail(code)
        if current.parent == current:
            return
        current = current.parent
        subject = False


def _deployment_path(
    path: Path,
    code: str,
    *,
    trust: _RuntimeTrust,
    leaf_kind: str,
    allow_leaf_symlink: bool = False,
) -> None:
    """Trust a runtime pathname only when its service cannot replace it.

    Every component is publisher/root owned, has no group/world write bit, and
    is not writable by the current effective service identity.  The requested
    venv Python leaf may be a symlink to a separately checked interpreter; no
    directory component and no resolved target component may be a symlink.
    """

    if trust.mode != "deployment" or trust.publisher_uid is None:
        _fail("TRUST_ARGUMENT_INVALID")
    if not path.is_absolute():
        _fail(code)
    components = [Path("/")]
    current = Path("/")
    for piece in path.parts[1:]:
        current /= piece
        components.append(current)
    for index, current in enumerate(components):
        is_leaf = index == len(components) - 1
        try:
            status = current.lstat()
        except OSError:
            _fail(code)
        if status.st_uid not in {0, trust.publisher_uid}:
            _fail(code)
        is_allowed_leaf_symlink = is_leaf and allow_leaf_symlink and stat.S_ISLNK(status.st_mode)
        if is_allowed_leaf_symlink:
            # A symlink's mode is not an access-control boundary; its checked
            # parent prevents replacement and the resolved regular target is
            # checked separately below.
            continue
        if status.st_mode & 0o022:
            _fail(code)
        try:
            writable = os.access(current, os.W_OK, effective_ids=True)
        except (NotImplementedError, OSError):
            _fail("DEPLOYMENT_EFFECTIVE_ACCESS_UNAVAILABLE")
        if writable:
            _fail(code)
        if stat.S_ISLNK(status.st_mode):
            _fail(code)
        if not is_leaf:
            if not stat.S_ISDIR(status.st_mode):
                _fail(code)
        elif leaf_kind == "directory" and not stat.S_ISDIR(status.st_mode):
            _fail(code)
        elif leaf_kind == "file" and not stat.S_ISREG(status.st_mode):
            _fail(code)


def _tree_aggregate(path: Path, code: str, *, trust: _RuntimeTrust) -> str:
    """Bind a trusted runtime tree to a deterministic, path-relative digest.

    The aggregate deliberately includes the root directory (with ``path ==
    ""``), directory topology, uid, all permission/special bits, and every
    regular-file byte digest.  A RECORD alone cannot bind undeclared
    directories, modes, or a base CPython runtime, so this is independently
    checked both at the release gate and at deployment.
    """
    _trusted_private_tree(path, code, trust=trust)
    identities: list[dict[str, Any]] = []
    pending = [path]
    while pending:
        current = pending.pop()
        try:
            status = current.lstat()
        except OSError:
            _fail(code)
        is_directory = stat.S_ISDIR(status.st_mode)
        is_regular = stat.S_ISREG(status.st_mode)
        if stat.S_ISLNK(status.st_mode) or not (is_directory or is_regular):
            _fail(code)
        if trust.mode == "release-gate":
            if status.st_uid != trust.service_real_uid or status.st_mode & 0o022:
                _fail(code)
        elif trust.mode == "deployment":
            if status.st_uid not in {0, trust.publisher_uid} or status.st_mode & 0o022:
                _fail(code)
            try:
                if os.access(current, os.W_OK, effective_ids=True):
                    _fail(code)
            except VerificationError:
                raise
            except (NotImplementedError, OSError):
                _fail("DEPLOYMENT_EFFECTIVE_ACCESS_UNAVAILABLE")
        else:
            _fail("TRUST_ARGUMENT_INVALID")
        relative = current.relative_to(path).as_posix()
        if relative == ".":
            relative = ""
        identities.append({
            "path": relative,
            "type": "directory" if is_directory else "file",
            "uid": status.st_uid,
            "mode": status.st_mode & 0o7777,
            "sha256": _sha256_file(current) if is_regular else None,
        })
        if is_directory:
            try:
                children = list(current.iterdir())
            except OSError:
                _fail(code)
            pending.extend(children)
    # Tree aggregates are shared with Node.  Encode valid Unicode path names as
    # UTF-8 (rather than Python's default ``ensure_ascii`` escapes) and sort by
    # Unicode scalar value; Node applies the same code-point ordering.  Invalid
    # surrogate-escaped filesystem names have no lossless Node representation
    # and therefore fail closed instead of producing a platform-specific hash.
    try:
        canonical_tree = json.dumps(
            sorted(identities, key=lambda item: item["path"]),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
    except UnicodeEncodeError:
        _fail(code)
    return _sha256_bytes(canonical_tree)


def _strict_pyvenv_base_prefix(config: Path) -> Path:
    try:
        lines = config.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        _fail("PYVENV_CFG_INVALID")
    homes = [line.removeprefix("home = ") for line in lines if line.startswith("home = ")]
    if (len(homes) != 1 or not homes[0].startswith("/") or homes[0] == "/"
            or "\x00" in homes[0] or os.path.normpath(homes[0]) != homes[0]):
        _fail("PYVENV_CFG_INVALID")
    return Path(homes[0]).parent


def _trusted_private_tree(path: Path, code: str, *, trust: _RuntimeTrust) -> None:
    if trust.mode == "release-gate":
        _private_tree(path, code, owner=trust.service_real_uid)
        return
    _deployment_path(path, code, trust=trust, leaf_kind="directory")


def _trusted_regular_file(path: Path, code: str, *, trust: _RuntimeTrust) -> os.stat_result:
    if trust.mode == "release-gate":
        return _regular_private(path, code, owner=trust.service_real_uid)
    _deployment_path(path, code, trust=trust, leaf_kind="file")
    try:
        return path.lstat()
    except OSError:
        _fail(code)


def _within(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _contains_symlink(path: Path, root: Path) -> bool:
    current = path
    while current != root:
        if current.is_symlink():
            return True
        current = current.parent
    return root.is_symlink()


def _parse_lock(lock: Path) -> list[dict[str, str]]:
    try:
        lines = lock.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        _fail("LOCK_READ_FAILED")
    if lines[:4] != [
        "# Minimal OpenAlice PAPER_LOCAL sidecar runtime.  This is a wheel-only,",
        "# hash-required installation input, not an assertion that any package is installed.",
        "--only-binary=:all:", "--require-hashes",
    ]:
        _fail("LOCK_FORMAT_MISMATCH")
    entries: list[dict[str, str]] = []
    index = 4
    while index < len(lines):
        if not lines[index]:
            index += 1
            continue
        if index + 1 >= len(lines) or not lines[index].endswith(" \\"):
            _fail("LOCK_FORMAT_MISMATCH")
        first, second = lines[index], lines[index + 1].strip()
        if "==" not in first or not second.startswith("--hash=sha256:"):
            _fail("LOCK_FORMAT_MISMATCH")
        name, version = first[:-2].split("==", 1)
        digest = second.removeprefix("--hash=sha256:")
        if not _is_hex(digest):
            _fail("LOCK_FORMAT_MISMATCH")
        entries.append({"name": name, "version": version, "sha256": digest})
        index += 2
    return entries


def _parse_wheel_manifest(manifest: Path) -> list[dict[str, str]]:
    try:
        lines = manifest.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError):
        _fail("WHEEL_MANIFEST_READ_FAILED")
    result: list[dict[str, str]] = []
    for line in lines:
        try:
            digest, filename = line.split("  ", 1)
        except ValueError:
            _fail("WHEEL_MANIFEST_FORMAT_MISMATCH")
        if not _is_hex(digest) or not filename.endswith(".whl") or "/" in filename or "\\" in filename:
            _fail("WHEEL_MANIFEST_FORMAT_MISMATCH")
        result.append({"sha256": digest, "filename": filename})
    if len(result) != 6 or len({entry["sha256"] for entry in result}) != 6:
        _fail("WHEEL_MANIFEST_FORMAT_MISMATCH")
    return result


def _validate_contract(contract: Mapping[str, Any]) -> None:
    _expect_exact_keys(contract, (
        "schemaVersion", "target", "flags", "protocol", "boundFiles", "packages",
        "allowedProductionModules", "smokeImports", "runtimeProvenance",
    ), "CONTRACT_FIELDS_MISMATCH")
    if contract["schemaVersion"] != "openalice_sidecar_release_runtime_contract.v1":
        _fail("CONTRACT_SCHEMA_MISMATCH")
    target = contract["target"]
    flags = contract["flags"]
    protocol = contract["protocol"]
    files = contract["boundFiles"]
    provenance = contract["runtimeProvenance"]
    if not all(isinstance(x, dict) for x in (target, flags, protocol, files, provenance)):
        _fail("CONTRACT_VALUE_MISMATCH")
    _expect_exact_keys(target, ("implementation", "python", "cacheTag", "system", "macosMajor", "machine"), "CONTRACT_TARGET_MISMATCH")
    _expect_exact_keys(flags, ("paperOnly", "liveTradingAllowed", "liveExecutionArmed"), "CONTRACT_FLAGS_MISMATCH")
    _expect_exact_keys(protocol, ("version", "serviceId"), "CONTRACT_PROTOCOL_MISMATCH")
    _expect_exact_keys(files, ("lock", "wheelManifest", "proto", "generatedBindings"), "CONTRACT_BOUND_FILES_MISMATCH")
    _expect_exact_keys(
        provenance,
        (
            "status", "interpreterSha256", "pyvenvCfgSha256", "installedAggregate",
            "baseRuntimeAggregate", "sitePackagesAggregate",
        ),
        "CONTRACT_RUNTIME_PROVENANCE_MISMATCH",
    )
    if target != {"implementation": "CPython", "python": "3.13.5", "cacheTag": "cpython-313", "system": "Darwin", "macosMajor": 26, "machine": "arm64"}:
        _fail("CONTRACT_TARGET_MISMATCH")
    if flags != {"paperOnly": True, "liveTradingAllowed": False, "liveExecutionArmed": False}:
        _fail("CONTRACT_FLAGS_MISMATCH")
    if protocol != {"version": "openalice.execution.v1", "serviceId": "openalice.nautilus_paper.durable_admission"}:
        _fail("CONTRACT_PROTOCOL_MISMATCH")
    if provenance["status"] == "unfrozen":
        if any(provenance[field] is not None for field in (
            "interpreterSha256", "pyvenvCfgSha256", "installedAggregate",
            "baseRuntimeAggregate", "sitePackagesAggregate",
        )):
            _fail("CONTRACT_RUNTIME_PROVENANCE_MISMATCH")
    elif provenance["status"] == "frozen":
        if not all(_is_hex(provenance[field]) for field in (
            "interpreterSha256", "pyvenvCfgSha256", "installedAggregate",
            "baseRuntimeAggregate", "sitePackagesAggregate",
        )):
            _fail("CONTRACT_RUNTIME_PROVENANCE_MISMATCH")
    else:
        _fail("CONTRACT_RUNTIME_PROVENANCE_MISMATCH")
    if (contract["smokeImports"] != list(SMOKE_IMPORTS)
            or contract["allowedProductionModules"] != list(EXPECTED_PRODUCTION_MODULES)):
        _fail("CONTRACT_MODULES_MISMATCH")
    packages = contract["packages"]
    if not isinstance(packages, list) or len(packages) != 6:
        _fail("CONTRACT_PACKAGES_MISMATCH")
    seen: set[str] = set()
    for item in packages:
        if not isinstance(item, dict):
            _fail("CONTRACT_PACKAGES_MISMATCH")
        _expect_exact_keys(item, ("name", "version", "sha256"), "CONTRACT_PACKAGES_MISMATCH")
        if item["name"] not in EXPECTED_PACKAGES or item["name"] in seen or not isinstance(item["version"], str) or not _is_hex(item["sha256"]):
            _fail("CONTRACT_PACKAGES_MISMATCH")
        seen.add(item["name"])
    if tuple(item["name"] for item in packages) != EXPECTED_PACKAGES:
        _fail("CONTRACT_PACKAGES_MISMATCH")
    for item in (files["lock"], files["wheelManifest"], files["proto"]):
        if not isinstance(item, dict):
            _fail("CONTRACT_BOUND_FILES_MISMATCH")
        _expect_exact_keys(item, ("path", "sha256"), "CONTRACT_BOUND_FILES_MISMATCH")
        _safe_relative(item["path"], "CONTRACT_BOUND_FILES_MISMATCH")
        if not _is_hex(item["sha256"]):
            _fail("CONTRACT_BOUND_FILES_MISMATCH")
    generated = files["generatedBindings"]
    if not isinstance(generated, list) or len(generated) != 2:
        _fail("CONTRACT_BOUND_FILES_MISMATCH")
    paths: set[str] = set()
    for item in generated:
        if not isinstance(item, dict):
            _fail("CONTRACT_BOUND_FILES_MISMATCH")
        _expect_exact_keys(item, ("path", "sha256"), "CONTRACT_BOUND_FILES_MISMATCH")
        path = item["path"]
        _safe_relative(path, "CONTRACT_BOUND_FILES_MISMATCH")
        if path in paths or not _is_hex(item["sha256"]):
            _fail("CONTRACT_BOUND_FILES_MISMATCH")
        paths.add(path)


def _runtime_snapshot() -> dict[str, Any]:
    executable = Path(sys.executable)
    base_prefix = Path(sys.base_prefix)
    prefix = Path(sys.prefix)
    # D1 invokes this verifier with -S so that an unverified .pth or
    # sitecustomize file cannot execute before the filesystem checks.  On
    # CPython 3.13, -S leaves sys.prefix at the base interpreter; recover the
    # explicit venv root from its required bin/python layout.
    if prefix == base_prefix:
        candidate = executable.parent.parent
        if (candidate / "pyvenv.cfg").is_file():
            prefix = candidate
    return {
        "implementation": sys.implementation.name,
        "python": ".".join(map(str, sys.version_info[:3])),
        "cacheTag": sys.implementation.cache_tag,
        "system": platform.system(),
        "macosMajor": int((platform.mac_ver()[0].split(".") or ["0"])[0]) if platform.mac_ver()[0] else 0,
        "machine": platform.machine(),
        "prefix": prefix,
        "basePrefix": base_prefix,
        "executable": executable,
    }


def _validate_runtime(runtime: Mapping[str, Any], trust: _RuntimeTrust) -> tuple[Path, str, str, Path, str]:
    expected = {"implementation": "cpython", "python": "3.13.5", "cacheTag": "cpython-313", "system": "Darwin", "macosMajor": 26, "machine": "arm64"}
    for key, value in expected.items():
        if runtime.get(key) != value:
            _fail("RUNTIME_%s_MISMATCH" % key.upper())
    prefix = runtime.get("prefix")
    base = runtime.get("basePrefix")
    executable = runtime.get("executable")
    if not all(isinstance(item, Path) for item in (prefix, base, executable)) or prefix == base:
        _fail("VENV_REQUIRED")
    if not executable.is_absolute() or not _within(executable, prefix / "bin"):
        _fail("INTERPRETER_NOT_VENV_BIN")
    _trusted_private_tree(prefix, "VENV_PATH_UNSAFE", trust=trust)
    config = prefix / "pyvenv.cfg"
    _trusted_regular_file(config, "PYVENV_CFG_UNSAFE", trust=trust)
    # A base interpreter elsewhere on the host would leave a loader/import
    # dependency outside the verified runtime hierarchy.  The release gate and
    # deployment both bind the same venv/base relationship; deployment adds
    # service-effective writability checks through ``_tree_aggregate``.
    derived_base = _strict_pyvenv_base_prefix(config)
    runtime_root = prefix.parent
    if base != derived_base:
        _fail("BASE_PREFIX_PYVENV_MISMATCH")
    if not _within(base, runtime_root):
        _fail("BASE_PREFIX_OUTSIDE_RUNTIME_ROOT")
    base_aggregate = _tree_aggregate(base, "BASE_PREFIX_UNSAFE", trust=trust)
    if trust.mode == "deployment":
        _deployment_path(
            executable,
            "INTERPRETER_UNSAFE",
            trust=trust,
            leaf_kind="file",
            allow_leaf_symlink=True,
        )
    else:
        try:
            requested_status = executable.lstat()
        except OSError:
            _fail("INTERPRETER_UNSAFE")
        if (requested_status.st_uid != trust.service_real_uid
                or not (stat.S_ISREG(requested_status.st_mode) or stat.S_ISLNK(requested_status.st_mode))
                or (stat.S_ISREG(requested_status.st_mode) and requested_status.st_mode & 0o022)):
            _fail("INTERPRETER_UNSAFE")
    try:
        resolved = executable.resolve(strict=True)
    except OSError:
        _fail("INTERPRETER_RESOLVE_FAILED")
    if trust.mode == "deployment":
        _deployment_path(resolved, "INTERPRETER_UNSAFE", trust=trust, leaf_kind="file")
    else:
        _regular_private(resolved, "INTERPRETER_UNSAFE", owner=trust.service_real_uid)
    if not _within(resolved, prefix) and not _within(resolved, base):
        _fail("INTERPRETER_OUTSIDE_RUNTIME_ROOT")
    return config, _sha256_file(config), _sha256_file(resolved), resolved, base_aggregate


def _validate_environment(environ: Mapping[str, str]) -> None:
    exact = {"PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP", "VIRTUAL_ENV"}
    for name in environ:
        upper = name.upper()
        if upper in exact or upper.startswith(("PIP_", "DYLD_", "LD_")) or any(token in upper for token in ("PROXY", "BROKER", "CREDENTIAL", "TOKEN", "SECRET", "API_KEY", "PRIVATE_KEY")):
            _fail("ENVIRONMENT_POLLUTED")


def _distribution_root(dist: importlib.metadata.Distribution) -> Path:
    # PathDistribution is the only stdlib distribution implementation used by CLI.
    root = getattr(dist, "_path", None)
    if not isinstance(root, Path):
        _fail("DIST_METADATA_INVALID")
    return root


def _normalise_name(value: str) -> str:
    return "-".join(value.lower().replace("_", "-").split("-"))


def _record_aggregate(
    dist: importlib.metadata.Distribution,
    venv: Path,
    trust: _RuntimeTrust,
    declared_paths: set[Path] | None = None,
) -> str:
    info = _distribution_root(dist)
    if info.is_symlink() or not _within(info.resolve(), venv.resolve()):
        _fail("DIST_PATH_UNSAFE")
    record = info / "RECORD"
    _trusted_regular_file(record, "RECORD_UNSAFE", trust=trust)
    try:
        rows = list(csv.reader(record.read_text(encoding="utf-8").splitlines()))
    except (OSError, UnicodeError, csv.Error):
        _fail("RECORD_PARSE_FAILED")
    if not rows:
        _fail("RECORD_EMPTY")
    hashes: list[dict[str, Any]] = []
    site_root = info.parent.resolve()
    for row in rows:
        if len(row) != 3 or not row[0]:
            _fail("RECORD_PARSE_FAILED")
        raw_path = row[0]
        relative = Path(raw_path)
        if relative.is_absolute() or "\\" in raw_path or "\x00" in raw_path:
            _fail("RECORD_PATH_ESCAPE")
        # Wheel RECORD entries may legitimately address venv/bin with paths
        # such as ../../../bin/tool.  Permit that shape only while the
        # normalized path remains inside the explicit venv.
        candidate = Path(os.path.normpath(site_root / relative))
        if (not _within(candidate, venv)
                or _contains_symlink(candidate, venv)
                or not _within(candidate.resolve(strict=False), venv.resolve())
                or not candidate.is_file()):
            _fail("RECORD_PATH_ESCAPE")
        if trust.mode == "deployment":
            _deployment_path(candidate, "RECORD_PATH_ESCAPE", trust=trust, leaf_kind="file")
        is_record = candidate.resolve() == record.resolve()
        encoded, size = row[1], row[2]
        if is_record and encoded == "" and size == "":
            # Wheel RECORD is conventionally self-unhashed; all other entries bind bytes.
            hashes.append({"path": row[0], "sha256": None, "size": None})
            continue
        if not encoded.startswith("sha256=") or not size.isdecimal():
            _fail("RECORD_HASH_MISSING")
        try:
            expected = base64.urlsafe_b64decode(encoded.removeprefix("sha256=") + "===").hex()
        except (ValueError, UnicodeError):
            _fail("RECORD_HASH_INVALID")
        if not _is_hex(expected) or candidate.stat().st_size != int(size) or _sha256_file(candidate) != expected:
            _fail("RECORD_HASH_MISMATCH")
        hashes.append({"path": row[0], "sha256": expected, "size": int(size)})
        if declared_paths is not None:
            declared_paths.add(candidate.resolve())
    if declared_paths is not None:
        declared_paths.add(record.resolve())
    return _sha256_bytes(_canonical(sorted(hashes, key=lambda item: item["path"])))


def _validate_distributions(
    venv: Path,
    packages: list[dict[str, str]],
    distributions: Iterable[importlib.metadata.Distribution] | None = None,
    *,
    trust: _RuntimeTrust | None = None,
) -> tuple[str, str]:
    trust = trust or _runtime_trust("release-gate", None)
    if distributions is None:
        distributions = importlib.metadata.distributions(
            path=[str(venv / "lib" / "python3.13" / "site-packages")],
        )
    expected = {item["name"]: item for item in packages}
    found: dict[str, importlib.metadata.Distribution] = {}
    for dist in distributions:
        try:
            name, version = dist.metadata["Name"], dist.version
        except Exception:
            _fail("DIST_METADATA_INVALID")
        normalised = _normalise_name(name)
        if normalised in found or normalised not in expected:
            _fail("DIST_SET_MISMATCH")
        if version != expected[normalised]["version"]:
            _fail("DIST_VERSION_MISMATCH")
        found[normalised] = dist
    if set(found) != set(expected):
        _fail("DIST_SET_MISMATCH")
    aggregate = []
    declared_paths: set[Path] = set()
    for name in EXPECTED_PACKAGES:
        aggregate.append({
            "name": name,
            "version": expected[name]["version"],
            "recordAggregate": _record_aggregate(found[name], venv, trust, declared_paths),
        })
    site_root = venv / "lib" / "python3.13" / "site-packages"
    _trusted_private_tree(site_root, "DIST_PATH_UNSAFE", trust=trust)
    try:
        entries = tuple(site_root.rglob("*"))
    except OSError:
        _fail("DIST_PATH_UNSAFE")
    for entry in entries:
        try:
            status = entry.lstat()
        except OSError:
            _fail("DIST_PATH_UNSAFE")
        if stat.S_ISLNK(status.st_mode) or not (stat.S_ISDIR(status.st_mode) or stat.S_ISREG(status.st_mode)):
            _fail("DIST_PATH_UNSAFE")
        if trust.mode == "deployment":
            _deployment_path(
                entry,
                "DIST_PATH_UNSAFE",
                trust=trust,
                leaf_kind="directory" if stat.S_ISDIR(status.st_mode) else "file",
            )
        if stat.S_ISREG(status.st_mode) and entry.resolve() not in declared_paths:
            _fail("DIST_UNDECLARED_FILE")
    # Only bind site topology after every file was confirmed by RECORD and no
    # undeclared regular file survived the closure check.
    site_aggregate = _tree_aggregate(site_root, "DIST_PATH_UNSAFE", trust=trust)
    return _sha256_bytes(_canonical(aggregate)), site_aggregate


def _smoke_import(venv: Path) -> None:
    site_packages = str(venv / "lib" / "python3.13" / "site-packages")
    sys.path.insert(0, site_packages)
    try:
        for name in SMOKE_IMPORTS:
            try:
                module = importlib.import_module(name)
                location = getattr(module, "__file__", None)
                if not isinstance(location, str) or not _within(Path(location).resolve(), venv.resolve()):
                    _fail("SMOKE_IMPORT_PATH_UNSAFE")
            except VerificationError:
                raise
            except Exception:
                _fail("SMOKE_IMPORT_FAILED")
    finally:
        if sys.path and sys.path[0] == site_packages:
            del sys.path[0]


def _bound_file(root: Path, item: Mapping[str, str], code: str, trust: _RuntimeTrust) -> tuple[Path, str]:
    path = root / _safe_relative(item["path"], code)
    _trusted_regular_file(path, code, trust=trust)
    digest = _sha256_file(path)
    if digest != item["sha256"]:
        _fail(code)
    return path, digest


def _validate_bound_inputs(root: Path, contract: Mapping[str, Any], trust: _RuntimeTrust) -> dict[str, str]:
    files = contract["boundFiles"]
    paths: dict[str, Path] = {}
    digests: dict[str, str] = {}
    for name in ("lock", "wheelManifest", "proto"):
        item = files[name]
        paths[name], digests[name] = _bound_file(root, item, "BOUND_FILE_MISMATCH", trust)
    generated = []
    for item in files["generatedBindings"]:
        _path, digest = _bound_file(root, item, "BOUND_FILE_MISMATCH", trust)
        generated.append({"path": item["path"], "sha256": digest})
    digests["generated"] = _sha256_bytes(_canonical(generated))
    lock = _parse_lock(paths["lock"])
    wheel = _parse_wheel_manifest(paths["wheelManifest"])
    if lock != contract["packages"] or [item["sha256"] for item in lock] != [item["sha256"] for item in wheel]:
        _fail("LOCK_PACKAGE_MISMATCH")
    return digests


def _atomic_output(path: Path, receipt: Mapping[str, Any]) -> None:
    owner = os.getuid()
    parent = path.parent
    _private_tree(parent, "OUTPUT_PATH_UNSAFE", owner=owner)
    if path.exists() and (path.is_symlink() or not path.is_file() or path.stat().st_uid != owner):
        _fail("OUTPUT_PATH_UNSAFE")
    payload = _canonical(receipt) + b"\n"
    descriptor, temporary = tempfile.mkstemp(prefix=".openalice-receipt-", dir=parent)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        directory = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def verify(
    contract_path: Path,
    expected_contract_sha256: str,
    release_root: Path,
    *,
    trust_mode: str = "release-gate",
    publisher_uid: int | None = None,
    environ: Mapping[str, str] | None = None,
    runtime: Mapping[str, Any] | None = None,
    distributions: Iterable[importlib.metadata.Distribution] | None = None,
    smoke_importer: Any = None,
) -> dict[str, Any]:
    """Internal seams are test-only; the CLI supplies none and has no bypass flags."""
    if not contract_path.is_absolute() or not release_root.is_absolute() or not _is_hex(expected_contract_sha256):
        _fail("ARGUMENT_INVALID")
    trust = _runtime_trust(trust_mode, publisher_uid)
    _trusted_private_tree(release_root, "RELEASE_ROOT_UNSAFE", trust=trust)
    _trusted_regular_file(contract_path, "CONTRACT_UNSAFE", trust=trust)
    if not _within(contract_path.resolve(), release_root.resolve()):
        _fail("CONTRACT_OUTSIDE_RELEASE_ROOT")
    contract_bytes = contract_path.read_bytes()
    contract_hash = _sha256_bytes(contract_bytes)
    if contract_hash != expected_contract_sha256:
        _fail("CONTRACT_HASH_MISMATCH")
    contract = _strict_json(contract_path)
    if contract_bytes not in (_canonical(contract), _canonical(contract) + b"\n"):
        _fail("CONTRACT_NOT_CANONICAL")
    _validate_contract(contract)
    _validate_environment(os.environ if environ is None else environ)
    provenance = contract["runtimeProvenance"]
    if provenance["status"] != "frozen":
        _fail("RUNTIME_PROVENANCE_NOT_FROZEN")
    runtime_state = _runtime_snapshot() if runtime is None else runtime
    config, config_hash, interpreter_hash, _canonical_python, base_runtime_aggregate = _validate_runtime(runtime_state, trust)
    hashes = _validate_bound_inputs(release_root, contract, trust)
    prefix = Path(runtime_state["prefix"])
    installed, site_packages_aggregate = _validate_distributions(prefix, contract["packages"], distributions, trust=trust)
    if interpreter_hash != provenance["interpreterSha256"]:
        _fail("INTERPRETER_PROVENANCE_MISMATCH")
    if config_hash != provenance["pyvenvCfgSha256"]:
        _fail("PYVENV_CFG_PROVENANCE_MISMATCH")
    if installed != provenance["installedAggregate"]:
        _fail("INSTALLED_PROVENANCE_MISMATCH")
    if base_runtime_aggregate != provenance["baseRuntimeAggregate"]:
        _fail("BASE_RUNTIME_PROVENANCE_MISMATCH")
    if site_packages_aggregate != provenance["sitePackagesAggregate"]:
        _fail("SITE_PACKAGES_PROVENANCE_MISMATCH")
    (smoke_importer or _smoke_import)(prefix)
    target = contract["target"]
    return {
        "schemaVersion": SCHEMA,
        "contractHash": contract_hash,
        "interpreterHash": interpreter_hash,
        "pyvenvCfgHash": config_hash,
        "installedAggregate": installed,
        "baseRuntimeAggregate": base_runtime_aggregate,
        "sitePackagesAggregate": site_packages_aggregate,
        "lockHash": hashes["lock"],
        "wheelManifestHash": hashes["wheelManifest"],
        "protoHash": hashes["proto"],
        "generatedAggregate": hashes["generated"],
        "target": target,
        "flags": contract["flags"],
        "executedAt": _datetime.datetime.now(tz=_datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "status": "pass",
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--expected-contract-sha256", required=True)
    parser.add_argument("--release-root", required=True)
    parser.add_argument("--trust-mode", choices=("release-gate", "deployment"), required=True)
    parser.add_argument("--publisher-uid")
    parser.add_argument("--output")
    args = parser.parse_args(argv)
    try:
        publisher_uid: int | None = None
        if args.publisher_uid is not None:
            if not args.publisher_uid.isdecimal():
                _fail("TRUST_ARGUMENT_INVALID")
            publisher_uid = int(args.publisher_uid)
        receipt = verify(
            Path(args.contract),
            args.expected_contract_sha256,
            Path(args.release_root),
            trust_mode=args.trust_mode,
            publisher_uid=publisher_uid,
        )
        if args.output:
            _atomic_output(Path(args.output), receipt)
        else:
            sys.stdout.buffer.write(_canonical(receipt) + b"\n")
        return 0
    except VerificationError as error:
        sys.stderr.write(error.code + "\n")
        return 2
    except Exception:
        # Deliberately do not expose a traceback, paths, or environment content.
        sys.stderr.write("VERIFICATION_INTERNAL_ERROR\n")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
