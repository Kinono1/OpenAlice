#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from importlib import metadata as importlib_metadata
except Exception:  # pragma: no cover
    importlib_metadata = None  # type: ignore[assignment]


EXIT_OK = 0
EXIT_POLICY_FAIL = 2
EXIT_TOOL_ERROR = 3


@dataclass
class CheckResult:
    name: str
    expected: str | None
    actual: str | None
    passed: bool
    required: bool = True
    detail: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "expected": self.expected,
            "actual": self.actual,
            "required": self.required,
            "passed": self.passed,
            "detail": self.detail,
        }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Verify runtime/toolchain lock for OpenAlice governance gates.",
    )
    parser.add_argument(
        "--lock",
        default="docs/research/templates/environment_lock.v1.json",
        help="Path to environment lock file.",
    )
    parser.add_argument(
        "--output",
        default="data/runtime/environment_verify_report.json",
        help="Path to machine-readable report.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


def read_json_object(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"{path} must be a JSON object.")
    return payload


def run_cmd(cmd: list[str]) -> str | None:
    try:
        proc = subprocess.run(
            cmd,
            text=True,
            capture_output=True,
            check=False,
        )
    except FileNotFoundError:
        return None
    if proc.returncode != 0:
        return None
    value = proc.stdout.strip()
    return value or None


def normalize_version(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        return None
    if trimmed.startswith("v"):
        trimmed = trimmed[1:]
    return trimmed


def normalize_version_from_range(value: str | None) -> str | None:
    if value is None:
        return None
    match = re.search(r"\d+(?:\.\d+){0,3}", value)
    return match.group(0) if match else None


def parse_version_tuple(value: str | None) -> tuple[int, ...] | None:
    if value is None:
        return None
    if not re.match(r"^\d+(?:\.\d+){0,3}$", value):
        return None
    return tuple(int(part) for part in value.split("."))


def compare_versions(a: str, b: str) -> int | None:
    pa = parse_version_tuple(a)
    pb = parse_version_tuple(b)
    if pa is None or pb is None:
        return None

    max_len = max(len(pa), len(pb))
    aa = pa + (0,) * (max_len - len(pa))
    bb = pb + (0,) * (max_len - len(pb))
    if aa < bb:
        return -1
    if aa > bb:
        return 1
    return 0


def match_single_condition(actual: str, condition: str) -> bool:
    cond = condition.strip()
    if not cond:
        return True

    if "x" in cond or "X" in cond:
        parts = cond.replace("X", "x").split(".")
        actual_parts = actual.split(".")
        if len(actual_parts) < len(parts):
            return False
        for idx, part in enumerate(parts):
            if part == "x":
                continue
            if actual_parts[idx] != part:
                return False
        return True

    for prefix in (">=", "<=", ">", "<", "=="):
        if cond.startswith(prefix):
            target = cond[len(prefix) :].strip()
            cmp = compare_versions(actual, target)
            if cmp is None:
                return False
            if prefix == ">=":
                return cmp >= 0
            if prefix == "<=":
                return cmp <= 0
            if prefix == ">":
                return cmp > 0
            if prefix == "<":
                return cmp < 0
            return cmp == 0

    return actual == cond


def match_version_spec(actual: str | None, spec: str | None) -> bool:
    if spec is None:
        return True
    if actual is None:
        return False

    normalized = normalize_version(actual)
    if normalized is None:
        return False

    conditions = [part.strip() for part in spec.split(",")]
    return all(match_single_condition(normalized, condition) for condition in conditions)


def get_python_package_version(name: str) -> str | None:
    if importlib_metadata is None:
        return None
    try:
        return normalize_version(importlib_metadata.version(name))
    except Exception:  # noqa: BLE001
        return None


def collect_actual_runtime() -> dict[str, str | None]:
    py = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    node = normalize_version(run_cmd(["node", "-v"]))
    pnpm = normalize_version(run_cmd(["pnpm", "-v"]))
    return {
        "python": py,
        "node": node,
        "pnpm": pnpm,
    }


def main() -> int:
    args = parse_args()
    lock_path = Path(args.lock)
    output_path = Path(args.output)

    try:
        if not lock_path.exists():
            report = {
                "passed": False,
                "generatedAt": utc_now_iso(),
                "lockPath": str(lock_path),
                "failures": [f"lock file not found: {lock_path}"],
            }
            write_json(output_path, report)
            return EXIT_POLICY_FAIL

        lock = read_json_object(lock_path)
        if lock.get("schemaVersion") != "environment_lock.v1":
            raise ValueError("environment lock schemaVersion must be environment_lock.v1")

        runtime_lock = lock.get("runtime")
        if not isinstance(runtime_lock, dict):
            raise ValueError("runtime must be an object")

        actual_runtime = collect_actual_runtime()
        checks: list[CheckResult] = []

        for key in ("python", "node", "pnpm"):
            expected_item = runtime_lock.get(key, {})
            if not isinstance(expected_item, dict):
                checks.append(
                    CheckResult(
                        name=f"runtime.{key}",
                        expected=None,
                        actual=actual_runtime.get(key),
                        passed=False,
                        required=True,
                        detail="missing runtime lock entry",
                    )
                )
                continue

            expected_spec = expected_item.get("versionSpec")
            required = bool(expected_item.get("required", True))
            if not isinstance(expected_spec, str) or not expected_spec.strip():
                checks.append(
                    CheckResult(
                        name=f"runtime.{key}",
                        expected=None,
                        actual=actual_runtime.get(key),
                        passed=not required,
                        required=required,
                        detail="invalid versionSpec",
                    )
                )
                continue

            actual = actual_runtime.get(key)
            passed = match_version_spec(actual, expected_spec)
            checks.append(
                CheckResult(
                    name=f"runtime.{key}",
                    expected=expected_spec,
                    actual=actual,
                    required=required,
                    passed=(passed or not required),
                    detail=None if passed else "version mismatch",
                )
            )

        package_json_path = Path(
            lock.get("project", {})
            .get("packageJsonPath", "package.json")
        )
        package_json: dict[str, Any] | None = None
        package_json_error: str | None = None
        if package_json_path.exists():
            package_json = read_json_object(package_json_path)
        else:
            package_json_error = f"package.json not found: {package_json_path}"

        project_lock = lock.get("project", {})
        if isinstance(project_lock, dict):
            pm_lock = project_lock.get("packageManager")
            if isinstance(pm_lock, dict):
                expected_pm_name = pm_lock.get("name")
                expected_pm_spec = pm_lock.get("versionSpec")
                declared_pm = None
                declared_pm_name = None
                declared_pm_version = None
                if package_json is not None:
                    declared_pm = package_json.get("packageManager")
                    if isinstance(declared_pm, str) and "@" in declared_pm:
                        declared_pm_name, declared_pm_version = declared_pm.split(
                            "@", 1
                        )
                detail = package_json_error
                name_passed = (
                    isinstance(expected_pm_name, str)
                    and declared_pm_name == expected_pm_name
                )
                version_passed = (
                    isinstance(expected_pm_spec, str)
                    and match_version_spec(declared_pm_version, expected_pm_spec)
                )
                passed = name_passed and version_passed and detail is None
                checks.append(
                    CheckResult(
                        name="project.packageManager",
                        expected=f"{expected_pm_name}@{expected_pm_spec}",
                        actual=declared_pm if isinstance(declared_pm, str) else None,
                        passed=passed,
                        required=True,
                        detail=detail if detail else ("mismatch" if not passed else None),
                    )
                )

            critical_deps = project_lock.get("criticalNodeDependencies")
            if isinstance(critical_deps, dict):
                dep_pool: dict[str, Any] = {}
                if package_json is not None:
                    deps = package_json.get("dependencies")
                    dev_deps = package_json.get("devDependencies")
                    if isinstance(deps, dict):
                        dep_pool.update(deps)
                    if isinstance(dev_deps, dict):
                        dep_pool.update(dev_deps)

                for dep_name, dep_spec in critical_deps.items():
                    expected_spec = dep_spec if isinstance(dep_spec, str) else None
                    declared_raw = dep_pool.get(dep_name)
                    declared_version = (
                        normalize_version_from_range(str(declared_raw))
                        if declared_raw is not None
                        else None
                    )
                    passed = (
                        expected_spec is not None
                        and match_version_spec(declared_version, expected_spec)
                    )
                    checks.append(
                        CheckResult(
                            name=f"project.dependency.{dep_name}",
                            expected=expected_spec,
                            actual=declared_version,
                            passed=passed,
                            required=True,
                            detail=(
                                package_json_error
                                if package_json_error
                                else ("dependency missing/mismatch" if not passed else None)
                            ),
                        )
                    )

        py_pkg_lock = lock.get("pythonPackages")
        if isinstance(py_pkg_lock, dict):
            for pkg_name, spec_item in py_pkg_lock.items():
                if not isinstance(spec_item, dict):
                    continue
                expected_spec = spec_item.get("versionSpec")
                required = bool(spec_item.get("required", True))
                actual_version = get_python_package_version(pkg_name)
                passed = (
                    isinstance(expected_spec, str)
                    and match_version_spec(actual_version, expected_spec)
                )
                checks.append(
                    CheckResult(
                        name=f"pythonPackage.{pkg_name}",
                        expected=expected_spec if isinstance(expected_spec, str) else None,
                        actual=actual_version,
                        passed=(passed or not required),
                        required=required,
                        detail=None
                        if passed or not required
                        else "python package missing/mismatch",
                    )
                )

        failed_checks = [check for check in checks if check.required and not check.passed]
        passed = len(failed_checks) == 0
        report = {
            "passed": passed,
            "generatedAt": utc_now_iso(),
            "lockPath": str(lock_path),
            "checks": [check.as_dict() for check in checks],
            "failedChecks": [check.as_dict() for check in failed_checks],
            "summary": {
                "total": len(checks),
                "requiredFailed": len(failed_checks),
                "requiredPassed": len(
                    [check for check in checks if check.required and check.passed]
                ),
                "optionalFailed": len(
                    [check for check in checks if not check.required and not check.passed]
                ),
            },
        }
        write_json(output_path, report)
        return EXIT_OK if passed else EXIT_POLICY_FAIL
    except Exception as exc:  # noqa: BLE001
        report = {
            "passed": False,
            "generatedAt": utc_now_iso(),
            "lockPath": str(lock_path),
            "failures": [f"tool_error: {exc}"],
        }
        write_json(output_path, report)
        return EXIT_TOOL_ERROR


if __name__ == "__main__":
    sys.exit(main())
