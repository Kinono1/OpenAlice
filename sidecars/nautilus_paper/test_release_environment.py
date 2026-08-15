"""Synthetic, standard-library-only coverage for the D1 runtime verifier."""
from __future__ import annotations

import base64
import hashlib
import importlib.metadata
import json
import os
import stat
from pathlib import Path

import pytest

from sidecars.nautilus_paper import verify_release_environment as verifier


ROOT = Path(__file__).parents[2]
CONTRACT = ROOT / "sidecars/nautilus_paper/release_runtime_contract.v1.json"
CONTRACT_RELATIVE = Path("sidecars/nautilus_paper/release_runtime_contract.v1.json")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def b64digest(data: bytes) -> str:
    return base64.urlsafe_b64encode(hashlib.sha256(data).digest()).decode().rstrip("=")


def fixture_venv(tmp_path: Path) -> tuple[dict[str, object], list[importlib.metadata.Distribution]]:
    venv = tmp_path / "venv"
    base = tmp_path / "base"
    bin_dir = venv / "bin"
    site = venv / "lib" / "python3.13" / "site-packages"
    bin_dir.mkdir(parents=True)
    (base / "bin").mkdir(parents=True)
    (base / "bin" / "python").write_bytes(b"synthetic-base-interpreter")
    executable = bin_dir / "python"
    executable.write_bytes(b"synthetic-interpreter")
    (venv / "pyvenv.cfg").write_text("home = " + str(base / "bin") + "\n", encoding="utf-8")
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    dists: list[importlib.metadata.Distribution] = []
    for package in contract["packages"]:
        info = site / (package["name"].replace("-", "_") + "-" + package["version"] + ".dist-info")
        info.mkdir(parents=True, exist_ok=True)
        metadata = ("Metadata-Version: 2.1\nName: %s\nVersion: %s\n" % (package["name"], package["version"])).encode()
        (info / "METADATA").write_bytes(metadata)
        record_path = info.relative_to(site).as_posix() + "/METADATA"
        record = "%s,sha256=%s,%d\n" % (record_path, b64digest(metadata), len(metadata))
        if package["name"] == "cffi":
            entry_point = bin_dir / "cffi-gen-src"
            entry_point.write_bytes(b"synthetic-entry-point\n")
            record += "../../../bin/cffi-gen-src,sha256=%s,%d\n" % (
                b64digest(entry_point.read_bytes()),
                entry_point.stat().st_size,
            )
        record += "%s/RECORD,,\n" % info.relative_to(site).as_posix()
        (info / "RECORD").write_text(record, encoding="utf-8")
        dists.append(importlib.metadata.PathDistribution(info))
    runtime: dict[str, object] = {
        "implementation": "cpython", "python": "3.13.5", "cacheTag": "cpython-313",
        "system": "Darwin", "macosMajor": 26, "machine": "arm64", "prefix": venv,
        "basePrefix": base, "executable": executable,
    }
    return runtime, dists


def frozen_release(
    tmp_path: Path,
    runtime: dict[str, object],
    dists: list[importlib.metadata.Distribution],
    *,
    provenance: dict[str, object] | None = None,
) -> tuple[Path, Path]:
    """Build a synthetic release whose trust values are fixed outside verify()."""
    release = tmp_path / "release"
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    files = contract["boundFiles"]
    bound = [files["lock"], files["wheelManifest"], files["proto"], *files["generatedBindings"]]
    for item in bound:
        source = ROOT / item["path"]
        destination = release / item["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes())
    prefix = runtime["prefix"]
    executable = runtime["executable"]
    assert isinstance(prefix, Path) and isinstance(executable, Path)
    frozen: dict[str, object] = {
        "status": "frozen",
        "interpreterSha256": digest(executable.resolve().read_bytes()),
        "pyvenvCfgSha256": digest((prefix / "pyvenv.cfg").read_bytes()),
        "installedAggregate": verifier._validate_distributions(prefix, contract["packages"], dists)[0],
        "baseRuntimeAggregate": verifier._tree_aggregate(
            Path(runtime["basePrefix"]), "BASE_PREFIX_UNSAFE", trust=verifier._runtime_trust("release-gate", None),
        ),
        "sitePackagesAggregate": verifier._validate_distributions(prefix, contract["packages"], dists)[1],
    }
    if provenance:
        frozen.update(provenance)
    contract["runtimeProvenance"] = frozen
    contract_path = release / CONTRACT_RELATIVE
    contract_path.parent.mkdir(parents=True, exist_ok=True)
    contract_path.write_bytes(verifier._canonical(contract) + b"\n")
    return contract_path, release


@pytest.fixture(autouse=True)
def private_tmp(monkeypatch: pytest.MonkeyPatch) -> None:
    # /tmp is intentionally world-writable; unit fixtures replace only this OS
    # ownership/ancestor seam, never a CLI switch or production bypass.
    monkeypatch.setattr(verifier, "_private_tree", lambda *args, **kwargs: None)


def verify_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, **changes: object) -> dict[str, object]:
    runtime, dists = fixture_venv(tmp_path)
    runtime.update(changes.pop("runtime", {}))
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    return verifier.verify(
        contract_path,
        digest(contract_path.read_bytes()),
        release_root,
        environ=changes.pop("environ", {}), runtime=runtime, distributions=changes.pop("distributions", dists),
        smoke_importer=changes.pop("smoke_importer", lambda _venv: None),
    )


def test_positive_fixture_returns_canonical_path_free_receipt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    receipt = verify_fixture(tmp_path, monkeypatch)
    assert tuple(receipt) == (
        "schemaVersion", "contractHash", "interpreterHash", "pyvenvCfgHash", "installedAggregate",
        "baseRuntimeAggregate", "sitePackagesAggregate",
        "lockHash", "wheelManifestHash", "protoHash", "generatedAggregate", "target", "flags", "executedAt", "status",
    )
    assert receipt["schemaVersion"] == "openalice_sidecar_environment_receipt.v1"
    assert receipt["status"] == "pass"
    frozen = json.loads((tmp_path / "release" / CONTRACT_RELATIVE).read_text(encoding="utf-8"))["runtimeProvenance"]
    assert receipt["interpreterHash"] == frozen["interpreterSha256"]
    assert receipt["pyvenvCfgHash"] == frozen["pyvenvCfgSha256"]
    assert receipt["installedAggregate"] == frozen["installedAggregate"]
    assert receipt["baseRuntimeAggregate"] == frozen["baseRuntimeAggregate"]
    assert receipt["sitePackagesAggregate"] == frozen["sitePackagesAggregate"]
    payload = verifier._canonical(receipt).decode()
    assert str(tmp_path) not in payload and "PYTHONPATH" not in payload
    assert receipt["executedAt"].endswith("Z")


def test_deployment_trust_rejects_root_or_same_publisher_service(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(verifier.os, "getuid", lambda: 501)
    monkeypatch.setattr(verifier.os, "geteuid", lambda: 501)
    with pytest.raises(verifier.VerificationError, match="DEPLOYMENT_PUBLISHER_UID_UNSAFE"):
        verifier._runtime_trust("deployment", 501)
    monkeypatch.setattr(verifier.os, "getuid", lambda: 0)
    with pytest.raises(verifier.VerificationError, match="DEPLOYMENT_SERVICE_UID_UNSAFE"):
        verifier._runtime_trust("deployment", 700)


def test_deployment_runtime_rejects_base_prefix_outside_protected_runtime_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, _ = fixture_venv(tmp_path)
    base = tmp_path.parent / (tmp_path.name + "-outside") / "base"
    runtime["basePrefix"] = base
    prefix = runtime["prefix"]
    assert isinstance(prefix, Path)
    (prefix / "pyvenv.cfg").write_text("home = " + str(base / "bin") + "\n", encoding="utf-8")
    monkeypatch.setattr(verifier, "_deployment_path", lambda *args, **kwargs: None)
    trust = verifier._RuntimeTrust("deployment", 700, 501, 501)
    with pytest.raises(verifier.VerificationError, match="BASE_PREFIX_OUTSIDE_RUNTIME_ROOT"):
        verifier._validate_runtime(runtime, trust)


@pytest.mark.parametrize("attack", ("owner", "mode", "acl", "symlink"))
def test_deployment_base_tree_rejects_each_unsafe_member(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, attack: str,
) -> None:
    base = tmp_path / "base"
    member = base / "lib" / "python3.13" / "os.py"
    member.parent.mkdir(parents=True)
    member.write_text("safe\n", encoding="utf-8")
    publisher = os.getuid()
    trust = verifier._RuntimeTrust("deployment", publisher, publisher + 1, publisher + 1)
    monkeypatch.setattr(verifier.os, "access", lambda path, mode, **kwargs: False)
    if attack == "mode":
        member.chmod(0o664)
    elif attack == "acl":
        monkeypatch.setattr(verifier.os, "access", lambda path, mode, **kwargs: path == member)
    elif attack == "symlink":
        replacement = base / "replacement"
        replacement.write_text("unsafe\n", encoding="utf-8")
        member.unlink()
        member.symlink_to(replacement)
    elif attack == "owner":
        original_lstat = Path.lstat

        def forged_lstat(path: Path) -> os.stat_result:
            result = original_lstat(path)
            if path != member:
                return result
            fields = list(result)
            fields[4] = publisher + 1
            return os.stat_result(fields)

        monkeypatch.setattr(Path, "lstat", forged_lstat)
    with pytest.raises(verifier.VerificationError, match="BASE_PREFIX_UNSAFE"):
        verifier._tree_aggregate(base, "BASE_PREFIX_UNSAFE", trust=trust)


def test_checked_in_contract_is_explicitly_unfrozen_and_cannot_issue_pass_receipt(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, dists = fixture_venv(tmp_path)
    called = False

    def smoke(_venv: Path) -> None:
        nonlocal called
        called = True

    with pytest.raises(verifier.VerificationError, match="RUNTIME_PROVENANCE_NOT_FROZEN"):
        verifier.verify(
            CONTRACT,
            digest(CONTRACT.read_bytes()),
            ROOT,
            environ={},
            runtime=runtime,
            distributions=dists,
            smoke_importer=smoke,
        )
    assert called is False


@pytest.mark.parametrize(("field", "code"), (
    ("interpreterSha256", "INTERPRETER_PROVENANCE_MISMATCH"),
    ("pyvenvCfgSha256", "PYVENV_CFG_PROVENANCE_MISMATCH"),
    ("installedAggregate", "INSTALLED_PROVENANCE_MISMATCH"),
    ("baseRuntimeAggregate", "BASE_RUNTIME_PROVENANCE_MISMATCH"),
    ("sitePackagesAggregate", "SITE_PACKAGES_PROVENANCE_MISMATCH"),
))
def test_every_frozen_runtime_provenance_value_is_enforced(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    field: str,
    code: str,
) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(
        tmp_path,
        runtime,
        dists,
        provenance={field: "0" * 64},
    )
    with pytest.raises(verifier.VerificationError, match=code):
        verifier.verify(
            contract_path,
            digest(contract_path.read_bytes()),
            release_root,
            environ={},
            runtime=runtime,
            distributions=dists,
            smoke_importer=lambda _: None,
        )


def test_base_runtime_byte_drift_is_rejected_by_aggregate_provenance(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    base = runtime["basePrefix"]
    assert isinstance(base, Path)
    base_member = base / "bin" / "python"
    base_member.write_bytes(base_member.read_bytes() + b"-changed")
    with pytest.raises(verifier.VerificationError, match="BASE_RUNTIME_PROVENANCE_MISMATCH"):
        verifier.verify(
            contract_path, digest(contract_path.read_bytes()), release_root,
            environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None,
        )


def test_site_package_byte_drift_is_rejected_before_import(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    metadata = Path(dists[0]._path) / "METADATA"  # type: ignore[attr-defined]
    metadata.write_bytes(metadata.read_bytes() + b"-changed")
    with pytest.raises(verifier.VerificationError, match="RECORD_HASH_MISMATCH"):
        verifier.verify(
            contract_path, digest(contract_path.read_bytes()), release_root,
            environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None,
        )


def test_site_package_topology_and_special_mode_drift_are_aggregate_bound(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    prefix = runtime["prefix"]
    assert isinstance(prefix, Path)
    site = prefix / "lib" / "python3.13" / "site-packages"
    (site / "empty-topology-drift").mkdir()
    with pytest.raises(verifier.VerificationError, match="SITE_PACKAGES_PROVENANCE_MISMATCH"):
        verifier.verify(
            contract_path, digest(contract_path.read_bytes()), release_root,
            environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None,
        )

    runtime, dists = fixture_venv(tmp_path / "special-mode")
    contract_path, release_root = frozen_release(tmp_path / "special-mode", runtime, dists)
    metadata = Path(dists[0]._path) / "METADATA"  # type: ignore[attr-defined]
    metadata.chmod((metadata.stat().st_mode & 0o777) | stat.S_ISVTX)
    with pytest.raises(verifier.VerificationError, match="SITE_PACKAGES_PROVENANCE_MISMATCH"):
        verifier.verify(
            contract_path, digest(contract_path.read_bytes()), release_root,
            environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None,
        )


def test_release_gate_tree_aggregate_rejects_topology_escapes(tmp_path: Path) -> None:
    root = tmp_path / "base"
    root.mkdir()
    safe = root / "safe"
    safe.write_text("safe\n", encoding="utf-8")
    (root / "unsafe-link").symlink_to(safe)
    with pytest.raises(verifier.VerificationError, match="BASE_PREFIX_UNSAFE"):
        verifier._tree_aggregate(
            root, "BASE_PREFIX_UNSAFE", trust=verifier._runtime_trust("release-gate", None),
        )


def test_tree_aggregate_uses_utf8_and_unicode_code_point_order(tmp_path: Path) -> None:
    root = tmp_path / "base"
    root.mkdir()
    for name in ("é", "\ue000", "😀"):
        (root / name).write_text(name, encoding="utf-8")
    identities: list[dict[str, object]] = []
    for path in (root, root / "é", root / "\ue000", root / "😀"):
        status = path.lstat()
        identities.append({
            "path": "" if path == root else path.name,
            "type": "directory" if path == root else "file",
            "uid": status.st_uid,
            "mode": status.st_mode & 0o7777,
            "sha256": None if path == root else digest(path.read_bytes()),
        })
    expected_bytes = json.dumps(
        sorted(identities, key=lambda item: str(item["path"])),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    actual = verifier._tree_aggregate(
        root, "BASE_PREFIX_UNSAFE", trust=verifier._runtime_trust("release-gate", None),
    )
    assert actual == digest(expected_bytes)
    assert "é".encode() in expected_bytes and b"\\u00e9" not in expected_bytes


def test_runtime_provenance_contract_shape_is_strict() -> None:
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    contract["runtimeProvenance"] = {
        "status": "frozen",
        "interpreterSha256": None,
        "pyvenvCfgSha256": None,
        "installedAggregate": None,
        "baseRuntimeAggregate": None,
        "sitePackagesAggregate": None,
    }
    with pytest.raises(verifier.VerificationError, match="CONTRACT_RUNTIME_PROVENANCE_MISMATCH"):
        verifier._validate_contract(contract)
    contract = json.loads(CONTRACT.read_text(encoding="utf-8"))
    contract["runtimeProvenance"].pop("baseRuntimeAggregate")
    with pytest.raises(verifier.VerificationError, match="CONTRACT_RUNTIME_PROVENANCE_MISMATCH"):
        verifier._validate_contract(contract)


@pytest.mark.parametrize("field", ("implementation", "python", "cacheTag", "system", "macosMajor", "machine"))
def test_every_runtime_target_mismatch_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, field: str) -> None:
    with pytest.raises(verifier.VerificationError, match="RUNTIME_"):
        verify_fixture(tmp_path, monkeypatch, runtime={field: "wrong"})


def test_contract_hash_and_canonical_contract_are_required(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    with pytest.raises(verifier.VerificationError, match="CONTRACT_HASH_MISMATCH"):
        verifier.verify(contract_path, "0" * 64, release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)
    noncanonical = release_root / "noncanonical-contract.json"
    noncanonical.write_text(json.dumps(json.loads(contract_path.read_text(encoding="utf-8")), indent=2), encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="CONTRACT_NOT_CANONICAL"):
        verifier.verify(noncanonical, digest(noncanonical.read_bytes()), release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)


@pytest.mark.parametrize("environment", ({"PYTHONPATH": "x"}, {"PIP_INDEX_URL": "x"}, {"HTTPS_PROXY": "x"}, {"BROKER_TOKEN": "x"}))
def test_environment_pollution_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, environment: dict[str, str]) -> None:
    with pytest.raises(verifier.VerificationError, match="ENVIRONMENT_POLLUTED"):
        verify_fixture(tmp_path, monkeypatch, environ=environment)


def test_extra_distribution_and_record_tamper_are_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    with pytest.raises(verifier.VerificationError, match="DIST_SET_MISMATCH"):
        verifier.verify(contract_path, digest(contract_path.read_bytes()), release_root, environ={}, runtime=runtime, distributions=[*dists, dists[0]], smoke_importer=lambda _: None)
    record = Path(dists[0]._path) / "RECORD"  # type: ignore[attr-defined]
    record.write_text(record.read_text(encoding="utf-8").replace("METADATA", "MISSING", 1), encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="RECORD_PATH_ESCAPE"):
        verifier.verify(contract_path, digest(contract_path.read_bytes()), release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)


def test_record_hash_and_path_escape_are_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    record = Path(dists[0]._path) / "RECORD"  # type: ignore[attr-defined]
    original = record.read_text(encoding="utf-8")
    record.write_text(original.replace("sha256=", "sha256=" + "A"), encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="RECORD_HASH_MISMATCH|RECORD_HASH_INVALID"):
        verifier.verify(contract_path, digest(contract_path.read_bytes()), release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)
    record.write_text("../escape,sha256=" + b64digest(b"x") + ",1\n", encoding="utf-8")
    with pytest.raises(verifier.VerificationError, match="RECORD_PATH_ESCAPE"):
        verifier.verify(contract_path, digest(contract_path.read_bytes()), release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)


def test_record_symlink_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    info = Path(dists[0]._path)  # type: ignore[attr-defined]
    metadata = info / "METADATA"
    replacement = info / "replacement"
    replacement.write_bytes(metadata.read_bytes())
    metadata.unlink()
    metadata.symlink_to(replacement)
    with pytest.raises(verifier.VerificationError, match="RECORD_PATH_ESCAPE"):
        verifier.verify(contract_path, digest(contract_path.read_bytes()), release_root, environ={}, runtime=runtime, distributions=dists, smoke_importer=lambda _: None)


def test_undeclared_site_package_file_is_rejected(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, dists = fixture_venv(tmp_path)
    contract_path, release_root = frozen_release(tmp_path, runtime, dists)
    prefix = runtime["prefix"]
    assert isinstance(prefix, Path)
    (prefix / "lib/python3.13/site-packages/sitecustomize.py").write_text(
        "raise RuntimeError('must never execute')\n",
        encoding="utf-8",
    )
    with pytest.raises(verifier.VerificationError, match="DIST_UNDECLARED_FILE"):
        verifier.verify(
            contract_path,
            digest(contract_path.read_bytes()),
            release_root,
            environ={},
            runtime=runtime,
            distributions=dists,
            smoke_importer=lambda _: None,
        )


def test_smoke_runs_only_after_static_validation(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    called = False
    def smoke(_venv: Path) -> None:
        nonlocal called
        called = True
    with pytest.raises(verifier.VerificationError, match="ENVIRONMENT_POLLUTED"):
        verify_fixture(tmp_path, monkeypatch, environ={"PYTHONHOME": "bad"}, smoke_importer=smoke)
    assert called is False


def test_output_is_atomic_private_and_canonical(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    receipt = verify_fixture(tmp_path, monkeypatch)
    output = tmp_path / "receipt.json"
    verifier._atomic_output(output, receipt)
    assert output.stat().st_mode & 0o777 == 0o600
    assert output.read_bytes() == verifier._canonical(receipt) + b"\n"
    symlink = tmp_path / "link.json"
    symlink.symlink_to(output)
    with pytest.raises(verifier.VerificationError, match="OUTPUT_PATH_UNSAFE"):
        verifier._atomic_output(symlink, receipt)
