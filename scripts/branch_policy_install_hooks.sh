#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

HOOK_FILE=".githooks/pre-push"

if [[ ! -f "$HOOK_FILE" ]]; then
  echo "ERROR: missing hook file: $HOOK_FILE"
  exit 1
fi

chmod +x "$HOOK_FILE"
git config core.hooksPath .githooks

CURRENT_HOOKS_PATH="$(git config --get core.hooksPath || true)"
echo "Installed branch workflow hooks."
echo "core.hooksPath=${CURRENT_HOOKS_PATH:-<unset>}"
echo "pre-push hook=${HOOK_FILE}"
