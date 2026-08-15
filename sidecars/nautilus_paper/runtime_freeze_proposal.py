#!/usr/bin/env python3
"""Create a non-executable candidate freeze proposal for PAPER_LOCAL.

This command deliberately *does not* create a runtime, install wheels, run a
candidate interpreter, or modify the release contract.  It is a local
inspection step which binds a pre-provisioned runtime and an operator-supplied
local artifact hash into a short-lived ``candidate`` proposal for
a later, separately-authorised freeze operation.  That hash does not prove
artifact review, CPython identity, or derivation of the inspected runtime.
"""
from __future__ import annotations

import argparse
import datetime as _datetime
import hashlib
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any, Mapping

from sidecars.nautilus_paper import verify_release_environment as verifier


SCHEMA_VERSION = "openalice_nautilus_runtime_freeze_proposal.v1"
_EXPIRES_AFTER = _datetime.timedelta(hours=1)
_HEX = set("0123456789abcdef")


class ProposalError(Exception):
    """Stable, path-free local inspection failure."""

    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def _fail(code: str) -> None:
    raise ProposalError(code)


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _sha256_file(path: Path) -> str:
    try:
        # Keep all filesystem byte hashes on the verifier's shared helper; a
        # proposal is not permitted to grow a parallel hash implementation.
        return verifier._sha256_file(path)
    except OSError:
        _fail("SOURCE_READ_FAILED")


def _is_hex(value: object) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= _HEX


def _absolute(path: Path, code: str) -> Path:
    if not path.is_absolute() or "\x00" in os.fspath(path):
        _fail(code)
    # ``resolve`` would hide a symlink.  This command requires a lexical,
    # explicitly supplied absolute pathname and then inspects every member.
    if os.path.normpath(os.fspath(path)) != os.fspath(path):
        _fail(code)
    return path


def _regular_private(path: Path, code: str, *, owner: int) -> None:
    try:
        status = path.lstat()
    except OSError:
        _fail(code)
    if (stat.S_ISLNK(status.st_mode) or not stat.S_ISREG(status.st_mode)
            or status.st_uid != owner or status.st_mode & 0o022):
        _fail(code)


def _regular_private_with_ancestors(path: Path, code: str, *, owner: int) -> None:
    try:
        verifier._private_tree(path.parent, code, owner=owner)
    except verifier.VerificationError as error:
        _fail(error.code)
    _regular_private(path, code, owner=owner)


def _private_tree(path: Path, code: str, *, owner: int) -> None:
    """Require an owner-private real directory hierarchy, including members."""
    try:
        verifier._private_tree(path, code, owner=owner)
    except verifier.VerificationError as error:
        _fail(error.code)
    pending = [path]
    while pending:
        current = pending.pop()
        try:
            status = current.lstat()
        except OSError:
            _fail(code)
        if (stat.S_ISLNK(status.st_mode) or not (stat.S_ISDIR(status.st_mode) or stat.S_ISREG(status.st_mode))
                or status.st_uid != owner or status.st_mode & 0o022):
            _fail(code)
        if stat.S_ISDIR(status.st_mode):
            try:
                pending.extend(current.iterdir())
            except OSError:
                _fail(code)


def _source_root(contract: Path) -> Path:
    # Contract is intentionally anchored at a checked-in sidecar path rather
    # than accepting an implicit CWD/release-root argument.
    if contract.parent.name != "nautilus_paper" or contract.parent.parent.name != "sidecars":
        _fail("CONTRACT_PATH_INVALID")
    return contract.parent.parent.parent


def _strict_contract(contract_path: Path, owner: int) -> tuple[dict[str, Any], str, Path]:
    _regular_private_with_ancestors(contract_path, "CONTRACT_UNSAFE", owner=owner)
    root = _source_root(contract_path)
    # Only contract-bound inputs are evidence.  Recursively rejecting unrelated
    # checkout members (for example an ignored node_modules symlink) would make
    # the inspector unusable without adding any provenance claim.
    try:
        verifier._private_tree(root, "SOURCE_TREE_UNSAFE", owner=owner)
        raw = contract_path.read_bytes()
    except verifier.VerificationError as error:
        _fail(error.code)
    except OSError:
        _fail("CONTRACT_READ_FAILED")
    try:
        contract = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        _fail("CONTRACT_PARSE_FAILED")
    if not isinstance(contract, dict) or raw not in (_canonical(contract), _canonical(contract) + b"\n"):
        _fail("CONTRACT_NOT_CANONICAL")
    try:
        verifier._validate_contract(contract)
    except verifier.VerificationError as error:
        _fail(error.code)
    provenance = contract["runtimeProvenance"]
    if provenance != {
        "status": "unfrozen",
        "interpreterSha256": None,
        "pyvenvCfgSha256": None,
        "installedAggregate": None,
        "baseRuntimeAggregate": None,
        "sitePackagesAggregate": None,
    }:
        _fail("CONTRACT_NOT_UNFROZEN")
    return contract, verifier._sha256_bytes(raw), root


def _bound_manifest(contract: Mapping[str, Any], root: Path, owner: int) -> tuple[Path, str, list[dict[str, str]]]:
    item = contract["boundFiles"]["wheelManifest"]
    try:
        relative = verifier._safe_relative(item["path"], "WHEEL_MANIFEST_PATH_INVALID")
    except verifier.VerificationError as error:
        _fail(error.code)
    manifest = root / relative
    _regular_private_with_ancestors(manifest, "WHEEL_MANIFEST_UNSAFE", owner=owner)
    digest = _sha256_file(manifest)
    if digest != item["sha256"]:
        _fail("WHEEL_MANIFEST_MISMATCH")
    try:
        entries = verifier._parse_wheel_manifest(manifest)
    except verifier.VerificationError as error:
        _fail(error.code)
    packages = contract["packages"]
    if [entry["sha256"] for entry in entries] != [package["sha256"] for package in packages]:
        _fail("WHEEL_MANIFEST_PACKAGE_MISMATCH")
    return manifest, digest, entries


def _bound_files_private(contract: Mapping[str, Any], root: Path, owner: int) -> None:
    files = contract["boundFiles"]
    items = [files["lock"], files["wheelManifest"], files["proto"], *files["generatedBindings"]]
    for item in items:
        try:
            relative = verifier._safe_relative(item["path"], "BOUND_FILE_PATH_INVALID")
        except verifier.VerificationError as error:
            _fail(error.code)
        _regular_private_with_ancestors(root / relative, "BOUND_FILE_UNSAFE", owner=owner)


def _wheelhouse(wheelhouse: Path, entries: list[dict[str, str]], owner: int) -> list[dict[str, str]]:
    _private_tree(wheelhouse, "WHEELHOUSE_UNSAFE", owner=owner)
    try:
        actual = sorted(wheelhouse.iterdir(), key=lambda path: path.name)
    except OSError:
        _fail("WHEELHOUSE_UNSAFE")
    expected = sorted(entries, key=lambda entry: entry["filename"])
    if [path.name for path in actual] != [entry["filename"] for entry in expected]:
        _fail("WHEELHOUSE_CONTENTS_MISMATCH")
    reviewed: list[dict[str, str]] = []
    for path, entry in zip(actual, expected, strict=True):
        _regular_private(path, "WHEELHOUSE_UNSAFE", owner=owner)
        digest = _sha256_file(path)
        if digest != entry["sha256"]:
            _fail("WHEEL_HASH_MISMATCH")
        reviewed.append({"filename": entry["filename"], "sha256": digest})
    return reviewed


def _runtime_provenance(runtime_root: Path, venv: Path, contract: Mapping[str, Any], owner: int) -> dict[str, str]:
    if venv != runtime_root / "venv":
        _fail("VENV_TOPOLOGY_INVALID")
    base = runtime_root / "base"
    config = venv / "pyvenv.cfg"
    interpreter = venv / "bin" / "python"
    try:
        verifier._private_tree(runtime_root, "RUNTIME_ROOT_UNSAFE", owner=owner)
        verifier._private_tree(venv, "VENV_UNSAFE", owner=owner)
        verifier._private_tree(config.parent, "PYVENV_CFG_UNSAFE", owner=owner)
        verifier._private_tree(interpreter.parent, "INTERPRETER_UNSAFE", owner=owner)
    except verifier.VerificationError as error:
        _fail(error.code)
    _regular_private_with_ancestors(config, "PYVENV_CFG_UNSAFE", owner=owner)
    try:
        configured_base = verifier._strict_pyvenv_base_prefix(config)
    except verifier.VerificationError as error:
        _fail(error.code)
    if configured_base != base:
        _fail("PYVENV_TOPOLOGY_INVALID")
    trust = verifier._runtime_trust("release-gate", None)
    try:
        runtime = {
            "implementation": "cpython", "python": "3.13.5", "cacheTag": "cpython-313",
            "system": "Darwin", "macosMajor": 26, "machine": "arm64", "prefix": venv,
            "basePrefix": base, "executable": interpreter,
        }
        _config, config_hash, interpreter_hash, resolved_interpreter, base_aggregate = (
            verifier._validate_runtime(runtime, trust)
        )
        verifier._private_tree(resolved_interpreter.parent, "INTERPRETER_UNSAFE", owner=owner)
        # The verifier returns its RECORD-bound installed aggregate together
        # with the post-closure site-packages tree aggregate.  Keeping this as
        # a direct call prevents a proposal-only reimplementation from drifting
        # from the release gate's static digest semantics.
        installed, site_aggregate = verifier._validate_distributions(venv, contract["packages"], trust=trust)
    except verifier.VerificationError as error:
        _fail(error.code)
    return {
        "interpreterSha256": interpreter_hash,
        "pyvenvCfgSha256": config_hash,
        "baseRuntimeAggregate": base_aggregate,
        "sitePackagesAggregate": site_aggregate,
        "installedAggregate": installed,
    }


def _output(path: Path, proposal: Mapping[str, Any], owner: int) -> None:
    parent = path.parent
    _private_tree(parent, "OUTPUT_PATH_UNSAFE", owner=owner)
    temporary: str | None = None
    published_identity: tuple[int, int] | None = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=".runtime-freeze-proposal-", dir=parent)
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "wb", closefd=True) as handle:
            handle.write(_canonical(proposal) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.link(temporary, path, follow_symlinks=False)
        except FileExistsError:
            _fail("OUTPUT_EXISTS")
        published = path.lstat()
        source = os.lstat(temporary)
        if (published.st_dev, published.st_ino) != (source.st_dev, source.st_ino):
            _fail("OUTPUT_PUBLISH_FAILED")
        published_identity = (published.st_dev, published.st_ino)
        directory = os.open(parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except OSError:
        _fail("OUTPUT_WRITE_FAILED")
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            except OSError:
                if published_identity is None:
                    _fail("OUTPUT_CLEANUP_FAILED")
        # A reported failure must not leave a file that looks like a completed
        # candidate.  Remove only the exact inode linked by this invocation.
        active_error = os.sys.exc_info()[0] is not None
        if active_error and published_identity is not None:
            try:
                status = path.lstat()
                if (status.st_dev, status.st_ino) == published_identity:
                    path.unlink()
            except FileNotFoundError:
                pass
            except OSError:
                _fail("OUTPUT_CLEANUP_FAILED")


def _overlaps(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def propose(
    *,
    contract_path: Path,
    runtime_root: Path,
    venv: Path,
    wheelhouse: Path,
    cpython_artifact: Path,
    expected_cpython_artifact_sha256: str,
    output: Path,
    now: _datetime.datetime | None = None,
) -> dict[str, Any]:
    """Inspect only local bytes and write one non-overwritable candidate proposal."""
    owner = os.getuid()
    for path, code in (
        (contract_path, "CONTRACT_PATH_INVALID"), (runtime_root, "RUNTIME_ROOT_PATH_INVALID"),
        (venv, "VENV_PATH_INVALID"), (wheelhouse, "WHEELHOUSE_PATH_INVALID"),
        (cpython_artifact, "CPYTHON_ARTIFACT_PATH_INVALID"), (output, "OUTPUT_PATH_INVALID"),
    ):
        _absolute(path, code)
    source_root = _source_root(contract_path)
    if (any(_overlaps(output, root) for root in (source_root, runtime_root, wheelhouse))
            or output == cpython_artifact):
        _fail("OUTPUT_OVERLAPS_INPUT")
    if not _is_hex(expected_cpython_artifact_sha256):
        _fail("CPYTHON_ARTIFACT_HASH_INVALID")
    contract, contract_hash, root = _strict_contract(contract_path, owner)
    # Bind every checked-in source input before relying on the wheel manifest;
    # this is the verifier's shared static contract/lock/proto implementation.
    trust = verifier._runtime_trust("release-gate", None)
    _bound_files_private(contract, root, owner)
    try:
        bound_hashes = verifier._validate_bound_inputs(root, contract, trust)
    except verifier.VerificationError as error:
        _fail(error.code)
    _manifest, manifest_hash, manifest_entries = _bound_manifest(contract, root, owner)
    reviewed_wheels = _wheelhouse(wheelhouse, manifest_entries, owner)
    _regular_private_with_ancestors(cpython_artifact, "CPYTHON_ARTIFACT_UNSAFE", owner=owner)
    artifact_hash = _sha256_file(cpython_artifact)
    if artifact_hash != expected_cpython_artifact_sha256:
        _fail("CPYTHON_ARTIFACT_HASH_MISMATCH")
    provenance = _runtime_provenance(runtime_root, venv, contract, owner)
    issued = now or _datetime.datetime.now(tz=_datetime.timezone.utc)
    if issued.tzinfo is None or issued.utcoffset() is None:
        _fail("CLOCK_INVALID")
    generated_at = issued.astimezone(_datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    expires_at = (issued.astimezone(_datetime.timezone.utc) + _EXPIRES_AFTER).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    core = {
        "schemaVersion": SCHEMA_VERSION,
        "status": "candidate",
        "contractHash": contract_hash,
        "target": contract["target"],
        "cpythonArtifact": {
            "filename": cpython_artifact.name,
            "sha256": artifact_hash,
            "sourceKind": "operator_supplied_local_artifact_hash",
        },
        "wheelManifest": {"sha256": manifest_hash, "files": reviewed_wheels},
        "proposedRuntimeProvenance": provenance,
        "generatedAt": generated_at,
        "expiresAt": expires_at,
    }
    proposal = {**core, "proposalId": hashlib.sha256(_canonical(core)).hexdigest()}
    # Re-read every evidence-bearing input immediately before publication.  A
    # same-publisher race is outside this non-authorising proposal's trust
    # boundary, but ordinary concurrent mutation must still fail closed.
    later_contract, later_contract_hash, later_root = _strict_contract(contract_path, owner)
    if later_contract_hash != contract_hash or later_contract != contract or later_root != root:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    _bound_files_private(contract, root, owner)
    try:
        later_bound = verifier._validate_bound_inputs(root, contract, trust)
    except verifier.VerificationError as error:
        _fail(error.code)
    if later_bound != bound_hashes:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    _later_manifest, later_manifest_hash, later_entries = _bound_manifest(contract, root, owner)
    if later_manifest_hash != manifest_hash or later_entries != manifest_entries:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    if _wheelhouse(wheelhouse, later_entries, owner) != reviewed_wheels:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    if _sha256_file(cpython_artifact) != artifact_hash:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    if _runtime_provenance(runtime_root, venv, contract, owner) != provenance:
        _fail("INPUT_CHANGED_DURING_INSPECTION")
    _output(output, proposal, owner)
    return proposal


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", required=True)
    parser.add_argument("--runtime-root", required=True)
    parser.add_argument("--venv", required=True)
    parser.add_argument("--wheelhouse", required=True)
    parser.add_argument("--cpython-artifact", required=True)
    parser.add_argument("--expected-cpython-artifact-sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(argv)
    try:
        proposal = propose(
            contract_path=Path(args.contract), runtime_root=Path(args.runtime_root), venv=Path(args.venv),
            wheelhouse=Path(args.wheelhouse), cpython_artifact=Path(args.cpython_artifact),
            expected_cpython_artifact_sha256=args.expected_cpython_artifact_sha256, output=Path(args.output),
        )
    except ProposalError as error:
        print(error.code, file=os.sys.stderr)
        return 2
    except Exception:
        print("PROPOSAL_INTERNAL_ERROR", file=os.sys.stderr)
        return 2
    print(_canonical(proposal).decode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
