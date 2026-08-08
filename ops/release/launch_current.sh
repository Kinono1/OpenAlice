#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The restricted env file is allowed to provide credentials and ordinary
# runtime defaults, but it must not be able to downgrade an explicitly
# selected research launch back to the legacy/source role or path. Capture
# launchd's enforced values before loading the env file, then restore them
# below for the research role.
ENFORCED_RUNTIME_ROLE="${OPENALICE_RUNTIME_ROLE:-}"
ENFORCED_RELEASE_DIR="${OPENALICE_RELEASE_DIR:-}"
ENFORCED_DATA_DIR="${OPENALICE_DATA_DIR:-}"
ENFORCED_SHARED_DATA_INPUT_DIR="${OPENALICE_SHARED_DATA_INPUT_DIR:-}"
ENFORCED_CONFIG_DIR="${OPENALICE_CONFIG_DIR:-}"
ENFORCED_MARKET_INPUT_DIR="${OPENALICE_MARKET_INPUT_DIR:-}"
ENFORCED_STATE_DIR="${OPENALICE_STATE_DIR:-}"
ENFORCED_ARTIFACT_DIR="${OPENALICE_ARTIFACT_DIR:-}"
ENFORCED_LOG_DIR="${OPENALICE_LOG_DIR:-}"
ENFORCED_LEGACY_WIP_ROOT="${OPENALICE_LEGACY_WIP_ROOT:-}"
ENFORCED_RESEARCH_WEB_PORT="${OPENALICE_RESEARCH_WEB_PORT:-}"
ENFORCED_RESEARCH_MCP_PORT="${OPENALICE_RESEARCH_MCP_PORT:-}"

verify_research_launch_assets() {
  if [[ "$ENFORCED_RUNTIME_ROLE" != "research" ]]; then
    return 0
  fi
  if [[ -z "$ENFORCED_RELEASE_DIR" || "$ENFORCED_RELEASE_DIR" != /* ]]; then
    echo "research runtime requires an explicit immutable release directory" >&2
    exit 78
  fi

  # launchd executes a materialized wrapper from runtime/bin.  Verify that
  # wrapper, its sibling launcher, and its sibling env loader are exactly the
  # artifacts declared by the currently selected research release before any
  # env file is sourced or Node is started.  This closes the gap where a
  # tampered stable wrapper could bypass launch_current.mjs's release checks.
  /usr/bin/python3 - "$ENFORCED_RELEASE_DIR" "$BIN_DIR" "$(basename "${BASH_SOURCE[0]}")" <<'PY'
import hashlib
import json
import os
import pathlib
import sys


def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(78)


release_root = pathlib.Path(sys.argv[1]).resolve(strict=True)
bin_dir = pathlib.Path(sys.argv[2]).resolve(strict=True)
script_name = sys.argv[3]
pointer = release_root / "research-current"
if pointer.is_symlink():
    release_path = pathlib.Path(os.path.realpath(pointer))
else:
    fail("research_release_pointer_must_be_symlink")
if not release_path.is_dir():
    fail("research_release_pointer_target_missing")
try:
    if os.path.commonpath((str(release_root), str(release_path))) != str(release_root):
        fail("research_release_pointer_outside_release_root")
except ValueError:
    fail("research_release_pointer_path_invalid")

manifest_path = release_path / "release_manifest.v1.json"
try:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
except Exception as exc:
    fail(f"research_release_manifest_unreadable:{exc}")
artifact_hashes = manifest.get("artifactHashes")
if not isinstance(artifact_hashes, dict):
    fail("research_release_artifact_hashes_missing")
release_id = manifest.get("releaseId")
if release_path != release_root / release_id:
    fail("research_release_pointer_target_mismatch")

if script_name == "launch_openalice_current.sh":
    observed = {
        "ops/release/launch_current.sh": bin_dir / script_name,
        "ops/release/launch_current.mjs": bin_dir / "launch_current.mjs",
        "scripts/openalice_env.sh": bin_dir / "openalice_env.sh",
    }
else:
    observed = {
        "ops/release/launch_current.sh": bin_dir / script_name,
        "ops/release/launch_current.mjs": bin_dir / "launch_current.mjs",
        "scripts/openalice_env.sh": release_path / "scripts/openalice_env.sh",
    }

for relative, path in observed.items():
    expected = artifact_hashes.get(relative)
    if not isinstance(expected, str):
        fail(f"research_launch_asset_hash_missing:{relative}")
    if path.is_symlink() or not path.is_file():
        fail(f"research_launch_asset_not_regular:{relative}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != expected:
        fail(f"research_launch_asset_hash_mismatch:{relative}")
PY
}

verify_research_launch_assets
source "$BIN_DIR/openalice_env.sh"

if [[ "$ENFORCED_RUNTIME_ROLE" == "research" ]]; then
  if [[ -z "$ENFORCED_RELEASE_DIR" || "$ENFORCED_RELEASE_DIR" != /* ]]; then
    echo "research runtime requires an explicit immutable release directory" >&2
    exit 78
  fi
  export OPENALICE_RUNTIME_ROLE="research"
  export OPENALICE_RELEASE_DIR="$ENFORCED_RELEASE_DIR"
  export OPENALICE_CONFIG_READ_ONLY="1"
  for enforced_pair in \
    "OPENALICE_DATA_DIR=$ENFORCED_DATA_DIR" \
    "OPENALICE_SHARED_DATA_INPUT_DIR=$ENFORCED_SHARED_DATA_INPUT_DIR" \
    "OPENALICE_CONFIG_DIR=$ENFORCED_CONFIG_DIR" \
    "OPENALICE_MARKET_INPUT_DIR=$ENFORCED_MARKET_INPUT_DIR" \
    "OPENALICE_STATE_DIR=$ENFORCED_STATE_DIR" \
    "OPENALICE_ARTIFACT_DIR=$ENFORCED_ARTIFACT_DIR" \
    "OPENALICE_LOG_DIR=$ENFORCED_LOG_DIR" \
    "OPENALICE_LEGACY_WIP_ROOT=$ENFORCED_LEGACY_WIP_ROOT" \
    "OPENALICE_RESEARCH_WEB_PORT=$ENFORCED_RESEARCH_WEB_PORT" \
    "OPENALICE_RESEARCH_MCP_PORT=$ENFORCED_RESEARCH_MCP_PORT"; do
    enforced_name="${enforced_pair%%=*}"
    enforced_value="${enforced_pair#*=}"
    if [[ -n "$enforced_value" ]]; then
      export "$enforced_name=$enforced_value"
    fi
  done
fi

exec /usr/bin/env node "$BIN_DIR/launch_current.mjs" "$@"
