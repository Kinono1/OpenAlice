#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STABLE_WRAPPER="${OPENALICE_STABLE_LAUNCH_WRAPPER:-$REPO_ROOT/runtime/bin/launch_openalice_current.sh}"
if [[ -x "$STABLE_WRAPPER" ]]; then
  exec "$STABLE_WRAPPER" "$@"
fi

if [[ "${OPENALICE_RUNTIME_ROLE:-primary}" == "research" ]]; then
  echo "research runtime requires a verified immutable release wrapper; source fallback is forbidden" >&2
  exit 78
fi

source "$REPO_ROOT/scripts/openalice_env.sh"

cd "$REPO_ROOT"
exec ./node_modules/.bin/tsx src/main.ts
