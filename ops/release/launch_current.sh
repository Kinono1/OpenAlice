#!/usr/bin/env bash
set -euo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source "$BIN_DIR/openalice_env.sh"
exec /usr/bin/env node "$BIN_DIR/launch_current.mjs" "$@"
