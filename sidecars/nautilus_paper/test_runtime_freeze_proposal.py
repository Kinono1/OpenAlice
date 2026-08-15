"""No-install coverage for the PAPER_LOCAL runtime freeze proposal inspector."""
from __future__ import annotations

import base64
import datetime as datetime
import hashlib
import json
import stat
from pathlib import Path

import pytest

from sidecars.nautilus_paper import runtime_freeze_proposal as proposal


PACKAGES = (
    ("cffi", "2.1.1"), ("cryptography", "49.0.0"), ("grpcio", "1.82.1"),
    ("protobuf", "7.35.1"), ("pycparser", "3.0"), ("typing-extensions", "4.16.0"),
)


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def record_digest(value: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(value).digest()).decode().rstrip("=")


@pytest.fixture(autouse=True)
def private_tmp(monkeypatch: pytest.MonkeyPatch) -> None:
    # macOS /tmp is intentionally world-writable.  This fixture only removes
    # the parent-directory seam; each proposal input tree is still checked by
    # the tool's own recursive no-symlink/private-member inspection.
    monkeypatch.setattr(proposal.verifier, "_private_tree", lambda *args, **kwargs: None)


def fixture(tmp_path: Path) -> dict[str, Path | str]:
    release = tmp_path / "release"
    sidecar = release / "sidecars" / "nautilus_paper"
    sidecar.mkdir(parents=True)
    wheelhouse = tmp_path / "wheelhouse"
    wheelhouse.mkdir()
    package_items: list[dict[str, str]] = []
    manifest_rows: list[str] = []
    for name, version in PACKAGES:
        filename = f"{name}-{version}-synthetic.whl"
        payload = ("reviewed wheel " + name + "\n").encode()
        (wheelhouse / filename).write_bytes(payload)
        package_items.append({"name": name, "version": version, "sha256": digest(payload)})
        manifest_rows.append(f"{digest(payload)}  {filename}")
    manifest = "\n".join(manifest_rows) + "\n"
    manifest_path = sidecar / "wheelhouse-paper-local-runtime-macos-arm64-cp313.sha256"
    manifest_path.write_text(manifest, encoding="utf-8")
    lock_rows = [
        "# Minimal OpenAlice PAPER_LOCAL sidecar runtime.  This is a wheel-only,",
        "# hash-required installation input, not an assertion that any package is installed.",
        "--only-binary=:all:", "--require-hashes",
    ]
    for package in package_items:
        lock_rows += [f'{package["name"]}=={package["version"]} \\', f'    --hash=sha256:{package["sha256"]}']
    lock_path = sidecar / "requirements-paper-local-runtime-macos-arm64-cp313.lock"
    lock_path.write_text("\n".join(lock_rows) + "\n", encoding="utf-8")
    proto = release / "src" / "sidecar" / "proto" / "openalice_execution_v1.proto"
    proto.parent.mkdir(parents=True)
    proto.write_text("syntax = \"proto3\";\n", encoding="utf-8")
    generated = []
    for filename in ("openalice_execution_v1_pb2.py", "openalice_execution_v1_pb2_grpc.py"):
        path = sidecar / "generated" / filename
        path.parent.mkdir(exist_ok=True)
        path.write_text("# generated\n", encoding="utf-8")
        generated.append({"path": "sidecars/nautilus_paper/generated/" + filename, "sha256": digest(path.read_bytes())})
    contract = {
        "schemaVersion": "openalice_sidecar_release_runtime_contract.v1",
        "target": {"implementation": "CPython", "python": "3.13.5", "cacheTag": "cpython-313", "system": "Darwin", "macosMajor": 26, "machine": "arm64"},
        "flags": {"paperOnly": True, "liveTradingAllowed": False, "liveExecutionArmed": False},
        "protocol": {"version": "openalice.execution.v1", "serviceId": "openalice.nautilus_paper.durable_admission"},
        "boundFiles": {
            "lock": {"path": "sidecars/nautilus_paper/requirements-paper-local-runtime-macos-arm64-cp313.lock", "sha256": digest(lock_path.read_bytes())},
            "wheelManifest": {"path": "sidecars/nautilus_paper/wheelhouse-paper-local-runtime-macos-arm64-cp313.sha256", "sha256": digest(manifest_path.read_bytes())},
            "proto": {"path": "src/sidecar/proto/openalice_execution_v1.proto", "sha256": digest(proto.read_bytes())},
            "generatedBindings": generated,
        },
        "packages": package_items,
        "allowedProductionModules": list(proposal.verifier.EXPECTED_PRODUCTION_MODULES),
        "smokeImports": list(proposal.verifier.SMOKE_IMPORTS),
        "runtimeProvenance": {
            "status": "unfrozen", "interpreterSha256": None, "pyvenvCfgSha256": None,
            "installedAggregate": None, "baseRuntimeAggregate": None, "sitePackagesAggregate": None,
        },
    }
    contract_path = sidecar / "release_runtime_contract.v1.json"
    contract_path.write_bytes(proposal._canonical(contract) + b"\n")

    runtime_root = tmp_path / "runtime"
    base = runtime_root / "base"
    (base / "bin").mkdir(parents=True)
    (base / "bin" / "python").write_bytes(b"not invoked base python\n")
    venv = runtime_root / "venv"
    candidate = venv / "bin" / "python"
    candidate.parent.mkdir(parents=True)
    candidate.write_text("#!/bin/sh\ntouch candidate-ran\n", encoding="utf-8")
    candidate.chmod(0o700)
    (venv / "pyvenv.cfg").write_text("home = " + str(base / "bin") + "\n", encoding="utf-8")
    site = venv / "lib" / "python3.13" / "site-packages"
    for package in package_items:
        info = site / (package["name"].replace("-", "_") + "-" + package["version"] + ".dist-info")
        info.mkdir(parents=True)
        metadata = ("Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (package["name"], package["version"])).encode()
        (info / "METADATA").write_bytes(metadata)
        relative = info.relative_to(site).as_posix()
        (info / "RECORD").write_text(
            f"{relative}/METADATA,sha256={record_digest(metadata)},{len(metadata)}\n{relative}/RECORD,,\n",
            encoding="utf-8",
        )
    artifact = tmp_path / "CPython-3.13.5-reviewed.pkg"
    artifact.write_bytes(b"reviewed local cpython artifact\n")
    output_parent = tmp_path / "proposals"
    output_parent.mkdir()
    return {
        "contract": contract_path, "runtime_root": runtime_root, "venv": venv, "wheelhouse": wheelhouse,
        "artifact": artifact, "expected": digest(artifact.read_bytes()), "output": output_parent / "proposal.json",
        "candidate_marker": tmp_path / "candidate-ran",
    }


def propose_fixture(values: dict[str, Path | str], **changes: object) -> dict[str, object]:
    arguments = {
        "contract_path": values["contract"], "runtime_root": values["runtime_root"], "venv": values["venv"],
        "wheelhouse": values["wheelhouse"], "cpython_artifact": values["artifact"],
        "expected_cpython_artifact_sha256": values["expected"], "output": values["output"],
        "now": datetime.datetime(2026, 8, 15, 2, 3, 4, 567000, tzinfo=datetime.timezone.utc),
    }
    arguments.update(changes)
    return proposal.propose(**arguments)  # type: ignore[arg-type]


def test_proposal_is_canonical_candidate_and_never_executes_candidate_python(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    result = propose_fixture(values)
    output = values["output"]
    assert isinstance(output, Path)
    raw = output.read_bytes()
    assert raw == proposal._canonical(result) + b"\n"
    assert tuple(result) == (
        "schemaVersion", "status", "contractHash", "target", "cpythonArtifact", "wheelManifest",
        "proposedRuntimeProvenance", "generatedAt", "expiresAt", "proposalId",
    )
    core = dict(result)
    proposal_id = core.pop("proposalId")
    assert proposal_id == hashlib.sha256(proposal._canonical(core)).hexdigest()
    assert result["status"] == "candidate"
    assert result["generatedAt"] == "2026-08-15T02:03:04.567Z"
    assert result["expiresAt"] == "2026-08-15T03:03:04.567Z"
    assert result["cpythonArtifact"]["sourceKind"] == "operator_supplied_local_artifact_hash"  # type: ignore[index]
    assert not values["candidate_marker"].exists()
    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    assert b'"status":"pass"' not in raw and b"frozen" not in raw and b"deployed" not in raw


def test_safe_venv_python_symlink_hashes_target_without_execution(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    venv = values["venv"]
    assert isinstance(venv, Path)
    requested = venv / "bin" / "python"
    target = requested.with_name("python3.13")
    requested.rename(target)
    requested.symlink_to(target.name)
    result = propose_fixture(values)
    provenance = result["proposedRuntimeProvenance"]
    assert isinstance(provenance, dict)
    assert provenance["interpreterSha256"] == digest(target.read_bytes())
    assert not values["candidate_marker"].exists()

    escaped = fixture(tmp_path / "escape")
    escaped_venv = escaped["venv"]
    assert isinstance(escaped_venv, Path)
    escaped_python = escaped_venv / "bin" / "python"
    outside = tmp_path / "outside-python"
    outside.write_bytes(escaped_python.read_bytes())
    escaped_python.unlink()
    escaped_python.symlink_to(outside)
    with pytest.raises(proposal.ProposalError, match="INTERPRETER_OUTSIDE_RUNTIME_ROOT"):
        propose_fixture(escaped)


@pytest.mark.parametrize("attack,code", (("missing", "WHEELHOUSE_CONTENTS_MISMATCH"), ("extra", "WHEELHOUSE_CONTENTS_MISMATCH"), ("hash", "WHEEL_HASH_MISMATCH")))
def test_wheelhouse_requires_exact_six_reviewed_files(tmp_path: Path, attack: str, code: str) -> None:
    values = fixture(tmp_path)
    wheelhouse = values["wheelhouse"]
    assert isinstance(wheelhouse, Path)
    first = next(wheelhouse.iterdir())
    if attack == "missing":
        first.unlink()
    elif attack == "extra":
        (wheelhouse / "extra.whl").write_bytes(b"extra")
    else:
        first.write_bytes(b"changed")
    with pytest.raises(proposal.ProposalError, match=code):
        propose_fixture(values)
    assert not values["output"].exists()


def test_rejects_relative_symlink_and_wrong_pyvenv_topology(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    with pytest.raises(proposal.ProposalError, match="RUNTIME_ROOT_PATH_INVALID"):
        propose_fixture(values, runtime_root=Path("relative"))
    values = fixture(tmp_path / "symlink")
    artifact = values["artifact"]
    assert isinstance(artifact, Path)
    target = artifact.with_name("real-artifact")
    artifact.rename(target)
    artifact.symlink_to(target)
    with pytest.raises(proposal.ProposalError, match="CPYTHON_ARTIFACT_UNSAFE"):
        propose_fixture(values)
    values = fixture(tmp_path / "topology")
    runtime_root, venv = values["runtime_root"], values["venv"]
    assert isinstance(runtime_root, Path) and isinstance(venv, Path)
    wrong = runtime_root / "other"
    venv.rename(wrong)
    with pytest.raises(proposal.ProposalError, match="VENV_TOPOLOGY_INVALID"):
        propose_fixture(values, venv=wrong)
    values = fixture(tmp_path / "pyvenv-home")
    venv = values["venv"]
    assert isinstance(venv, Path)
    (venv / "pyvenv.cfg").write_text("home = /outside/base/bin\n", encoding="utf-8")
    with pytest.raises(proposal.ProposalError, match="PYVENV_TOPOLOGY_INVALID"):
        propose_fixture(values)


def test_operator_supplied_cpython_artifact_hash_is_required_and_exact(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    with pytest.raises(proposal.ProposalError, match="CPYTHON_ARTIFACT_HASH_MISMATCH"):
        propose_fixture(values, expected_cpython_artifact_sha256="0" * 64)
    assert not values["output"].exists()


def test_output_is_exclusive_and_never_overwrites_existing_bytes(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    output = values["output"]
    assert isinstance(output, Path)
    output.write_bytes(b"preserve-me")
    with pytest.raises(proposal.ProposalError, match="OUTPUT_EXISTS"):
        propose_fixture(values)
    assert output.read_bytes() == b"preserve-me"


@pytest.mark.parametrize("location", ("source", "runtime", "wheelhouse", "artifact"))
def test_output_cannot_mutate_any_inspected_input(tmp_path: Path, location: str) -> None:
    values = fixture(tmp_path)
    contract = values["contract"]
    runtime_root = values["runtime_root"]
    wheelhouse = values["wheelhouse"]
    artifact = values["artifact"]
    assert all(isinstance(item, Path) for item in (contract, runtime_root, wheelhouse, artifact))
    candidates = {
        "source": contract.parent.parent.parent / "proposal.json",  # type: ignore[union-attr]
        "runtime": runtime_root / "proposal.json",  # type: ignore[operator]
        "wheelhouse": wheelhouse / "proposal.json",  # type: ignore[operator]
        "artifact": artifact,
    }
    with pytest.raises(proposal.ProposalError, match="OUTPUT_OVERLAPS_INPUT"):
        propose_fixture(values, output=candidates[location])


def test_output_failure_leaves_no_candidate_and_generic_cli_error_is_path_free(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    values = fixture(tmp_path)
    monkeypatch.setattr(proposal.os, "fsync", lambda _descriptor: (_ for _ in ()).throw(OSError("disk")))
    with pytest.raises(proposal.ProposalError, match="OUTPUT_WRITE_FAILED"):
        propose_fixture(values)
    output = values["output"]
    assert isinstance(output, Path)
    assert not output.exists()
    assert list(output.parent.iterdir()) == []

    monkeypatch.setattr(proposal, "propose", lambda **_kwargs: (_ for _ in ()).throw(OSError("secret /private/path")))
    code = proposal.main([
        "--contract", "/contract", "--runtime-root", "/runtime", "--venv", "/runtime/venv",
        "--wheelhouse", "/wheelhouse", "--cpython-artifact", "/artifact",
        "--expected-cpython-artifact-sha256", "0" * 64, "--output", "/output",
    ])
    assert code == 2
    assert capsys.readouterr().err == "PROPOSAL_INTERNAL_ERROR\n"


def test_unrelated_source_symlink_is_not_claimed_or_scanned(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    contract = values["contract"]
    wheelhouse = values["wheelhouse"]
    assert isinstance(contract, Path) and isinstance(wheelhouse, Path)
    (contract.parent.parent.parent / "unrelated-node-modules").symlink_to(wheelhouse)
    assert propose_fixture(values)["status"] == "candidate"


def test_artifact_private_ancestor_rejection_is_propagated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    values = fixture(tmp_path)
    artifact = values["artifact"]
    assert isinstance(artifact, Path)

    def reject_artifact_parent(path: Path, code: str, *, owner: int) -> None:
        del owner
        if path == artifact.parent:
            raise proposal.verifier.VerificationError("CPYTHON_ARTIFACT_UNSAFE")
        if code == "CPYTHON_ARTIFACT_UNSAFE":
            raise AssertionError("artifact ancestor check used an unexpected path")

    monkeypatch.setattr(proposal.verifier, "_private_tree", reject_artifact_parent)
    with pytest.raises(proposal.ProposalError, match="CPYTHON_ARTIFACT_UNSAFE"):
        propose_fixture(values)


def test_schema_is_closed_and_matches_exact_candidate_shape(tmp_path: Path) -> None:
    values = fixture(tmp_path)
    result = propose_fixture(values)
    schema = json.loads((Path(__file__).with_name("runtime_freeze_proposal.v1.schema.json")).read_text(encoding="utf-8"))
    assert schema["additionalProperties"] is False
    assert set(schema["required"]) == set(result)
    assert schema["properties"]["schemaVersion"]["const"] == proposal.SCHEMA_VERSION
    assert schema["properties"]["status"]["const"] == "candidate"
    provenance = schema["properties"]["proposedRuntimeProvenance"]
    assert provenance["additionalProperties"] is False
    assert set(provenance["required"]) == set(result["proposedRuntimeProvenance"])
