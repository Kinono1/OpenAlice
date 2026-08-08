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
