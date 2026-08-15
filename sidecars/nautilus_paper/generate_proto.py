"""Verify that the checked-in Python protobuf bindings match the proto source.

The repository keeps the Python bindings next to the paper sidecar so that the
sidecar's import boundary is explicit.  ``grpcio-tools`` emits the generated
gRPC module with a top-level import for a proto that has no package directory;
the committed module needs the equivalent package-relative import instead.
That is the only normalization performed here.  Generation always happens in
a temporary directory and this module never writes the checked-in bindings.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys
import tempfile
from typing import Sequence


_MODULE_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _MODULE_DIR.parents[1]
_PROTO_SOURCE = _REPO_ROOT / "src" / "sidecar" / "proto" / "openalice_execution_v1.proto"
_GENERATED_DIR = _MODULE_DIR / "generated"
_PB2_NAME = "openalice_execution_v1_pb2.py"
_PB2_GRPC_NAME = "openalice_execution_v1_pb2_grpc.py"

# This is deliberately an exact line-level replacement.  Do not broaden it to
# rewrite arbitrary imports in generated output.
_ABSOLUTE_IMPORT = b"\nimport openalice_execution_v1_pb2 as openalice__execution__v1__pb2\n"
_RELATIVE_IMPORT = b"\nfrom . import openalice_execution_v1_pb2 as openalice__execution__v1__pb2\n"


class ProtoGenerationError(RuntimeError):
    """Raised when deterministic protobuf generation or comparison fails."""


def _require_file(path: Path, description: str) -> None:
    if not path.is_file():
        raise ProtoGenerationError(f"{description} not found: {path}")


def _normalize_grpc_import(generated: bytes) -> bytes:
    """Apply the one package-import adjustment required by the sidecar."""
    occurrences = generated.count(_ABSOLUTE_IMPORT)
    if occurrences != 1:
        raise ProtoGenerationError(
            "grpcio-tools output did not contain exactly one expected protobuf "
            f"import line (found {occurrences})"
        )
    return generated.replace(_ABSOLUTE_IMPORT, _RELATIVE_IMPORT, 1)


def _generate_into(output_dir: Path) -> tuple[bytes, bytes]:
    """Generate both Python modules into ``output_dir`` and return their bytes."""
    try:
        from grpc_tools import protoc
    except ModuleNotFoundError as exc:
        raise ProtoGenerationError(
            "grpc_tools.protoc is unavailable; run this check in the locked "
            "Python environment"
        ) from exc

    arguments = [
        "protoc",
        f"--proto_path={_PROTO_SOURCE.parent}",
        f"--python_out={output_dir}",
        f"--grpc_python_out={output_dir}",
        str(_PROTO_SOURCE),
    ]
    result = protoc.main(arguments)
    if result != 0:
        raise ProtoGenerationError(f"grpc_tools.protoc failed with exit code {result}")

    generated_pb2 = output_dir / _PB2_NAME
    generated_pb2_grpc = output_dir / _PB2_GRPC_NAME
    _require_file(generated_pb2, "generated protobuf module")
    _require_file(generated_pb2_grpc, "generated gRPC module")
    return generated_pb2.read_bytes(), _normalize_grpc_import(generated_pb2_grpc.read_bytes())


def _assert_matches(path: Path, generated: bytes) -> None:
    _require_file(path, "committed generated module")
    committed = path.read_bytes()
    if committed != generated:
        raise ProtoGenerationError(f"generated protobuf drift detected: {path}")


def check_generated_proto() -> None:
    """Fail if either committed Python binding drifts from the proto source."""
    _require_file(_PROTO_SOURCE, "protobuf source")
    with tempfile.TemporaryDirectory(prefix="openalice-proto-check-") as temporary:
        generated_pb2, generated_pb2_grpc = _generate_into(Path(temporary))
    _assert_matches(_GENERATED_DIR / _PB2_NAME, generated_pb2)
    _assert_matches(_GENERATED_DIR / _PB2_GRPC_NAME, generated_pb2_grpc)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check committed Python protobuf bindings against the proto source."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="check only (the default; committed generated files are never written)",
    )
    parser.parse_args(argv)

    try:
        check_generated_proto()
    except ProtoGenerationError as exc:
        print(f"protobuf generation check failed: {exc}", file=sys.stderr)
        return 1
    print("protobuf generated bindings are up to date")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
