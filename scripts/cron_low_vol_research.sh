#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"

DATA_ROOT="${OPENALICE_DATA_DIR:-$REPO_ROOT/data}"
ARTIFACT_ROOT="${OPENALICE_ARTIFACT_DIR:-$DATA_ROOT/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
export OPENALICE_DATA_ROOT="${OPENALICE_DATA_ROOT:-$DATA_ROOT}"
LOG_PATH="$LOG_ROOT/low_vol_research_daily.log"

mkdir -p "$LOG_ROOT" "$ARTIFACT_ROOT" "$DATA_ROOT/research"
cd "$REPO_ROOT"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start low_vol_research_daily" >> "$LOG_PATH"
set +e
./node_modules/.bin/tsx scripts/low_vol_research_daily.ts --json true --outputPath "$DATA_ROOT/research/low_vol_research_daily.latest.json" >> "$LOG_PATH" 2>&1
EXIT_CODE=$?
set -e
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] done low_vol_research_daily exit=$EXIT_CODE" >> "$LOG_PATH"

exit "$EXIT_CODE"
