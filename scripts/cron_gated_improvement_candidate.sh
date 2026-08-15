#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PATH="$REPO_ROOT/logs/gated_improvement_candidate.log"
source "$REPO_ROOT/scripts/openalice_env.sh"
mkdir -p "$REPO_ROOT/logs" "$REPO_ROOT/data/runtime"
cd "$REPO_ROOT"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start gated_improvement candidate" >> "$LOG_PATH"
set +e
./node_modules/.bin/tsx scripts/gated_improvement.ts --mode candidate --json true >> "$LOG_PATH" 2>&1
EXIT_CODE=$?
set -e
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] done gated_improvement candidate exit=$EXIT_CODE" >> "$LOG_PATH"
exit "$EXIT_CODE"
