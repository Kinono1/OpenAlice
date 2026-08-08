#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ -f "$BIN_DIR/openalice_env.sh" ]]; then
  # shellcheck disable=SC1091
  source "$BIN_DIR/openalice_env.sh"
else
  # Repository execution path; installed wrappers carry their own copy.
  # shellcheck disable=SC1091
  source "$BIN_DIR/../../scripts/openalice_env.sh"
fi

if [[ -z "${OPENALICE_CANARY_ROOT:-}" || "${OPENALICE_CANARY_ROOT}" != /* ]]; then
  echo "OPENALICE_CANARY_ROOT must be an explicit absolute path" >&2
  exit 78
fi
if [[ -z "${OPENALICE_CANARY_RELEASE_DIR:-}" || "${OPENALICE_CANARY_RELEASE_DIR}" != /* ]]; then
  echo "OPENALICE_CANARY_RELEASE_DIR must be an explicit independent absolute path" >&2
  exit 78
fi
if [[ -z "${OPENALICE_CANARY_SOURCE_RELEASE_DIR:-}" || "${OPENALICE_CANARY_SOURCE_RELEASE_DIR}" != /* ]]; then
  echo "OPENALICE_CANARY_SOURCE_RELEASE_DIR must point to the verified immutable release root" >&2
  exit 78
fi

export OPENALICE_RUNTIME_ROLE="canary"
export OPENALICE_CONFIG_READ_ONLY="1"
export OPENALICE_RELEASE_DIR="$OPENALICE_CANARY_RELEASE_DIR"
export OPENALICE_CANARY_SOURCE_RELEASE_DIR
export OPENALICE_CANARY_WEB_PORT="${OPENALICE_CANARY_WEB_PORT:-3102}"
export OPENALICE_CANARY_MCP_PORT="${OPENALICE_CANARY_MCP_PORT:-3101}"

# Every mutable runtime path must live below the isolated Canary root.  The
# runtime-path resolver uses the role-specific defaults for state/artifacts,
# while libraries imported before bootstrap (for example the Agent SDK logger)
# can still observe these explicit values at process start.
export OPENALICE_DATA_DIR="$OPENALICE_CANARY_ROOT/state"
export OPENALICE_STATE_DIR="$OPENALICE_CANARY_ROOT/state"
export OPENALICE_ARTIFACT_DIR="$OPENALICE_CANARY_ROOT/artifacts"
export OPENALICE_LOG_DIR="$OPENALICE_CANARY_ROOT/logs"
export OPENALICE_CONFIG_DIR="${OPENALICE_CONFIG_DIR:-$OPENALICE_CANARY_ROOT/config}"
export OPENALICE_MARKET_INPUT_DIR="${OPENALICE_MARKET_INPUT_DIR:-$OPENALICE_CANARY_ROOT/market}"
export OPENALICE_CANARY_SHARED_DATA_INPUT_DIR="${OPENALICE_CANARY_SHARED_DATA_INPUT_DIR:-$OPENALICE_CANARY_ROOT/input}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$OPENALICE_CANARY_ROOT/openclaw}"

exec /usr/bin/env node "$BIN_DIR/launch_current.mjs" "$@"
