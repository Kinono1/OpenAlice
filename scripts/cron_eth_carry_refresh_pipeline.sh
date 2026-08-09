#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

DATA_ROOT="${OPENALICE_DATA_DIR:-$REPO_ROOT/data}"
ARTIFACT_ROOT="${OPENALICE_ARTIFACT_DIR:-$DATA_ROOT/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
export OPENALICE_DATA_ROOT="${OPENALICE_DATA_ROOT:-$DATA_ROOT}"
LOCK_DIR="$ARTIFACT_ROOT/locks/eth_carry_refresh_pipeline.lock"
LOG_DIR="$LOG_ROOT/cron"
LOG_FILE="$LOG_DIR/eth_carry_refresh_pipeline.log"
DERIVATIVES_DIR="$DATA_ROOT/research/derivatives_history"
NORMALIZED_DERIVATIVES_PATH="${OPENALICE_ETH_CARRY_NORMALIZED_PATH:-$DATA_ROOT/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl}"
ETH_FUNDING_PATH="$DERIVATIVES_DIR/okx_ETH_USDT_USDT_funding_history.json"
BTC_FUNDING_PATH="$DERIVATIVES_DIR/okx_BTC_USDT_USDT_funding_history.json"
NOTIFICATION_PATH="$ARTIFACT_ROOT/eth_carry_status/eth_carry_actionability_notification.json"

mkdir -p "$LOG_DIR"
mkdir -p "$(dirname "$LOCK_DIR")"

if ! openalice_acquire_cron_lock "eth_carry_refresh_pipeline" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start eth_carry_refresh_pipeline"
  cd "$REPO_ROOT"
  mkdir -p "$DERIVATIVES_DIR"
  ./node_modules/.bin/tsx scripts/normalize_external_derivatives_data.ts --json true
  ./node_modules/.bin/tsx scripts/audit_external_derivatives_data.ts --json true
  ./node_modules/.bin/tsx scripts/export_okx_funding_history.ts \
    --normalizedPath "$NORMALIZED_DERIVATIVES_PATH" --symbol ETHUSDT --outputPath "$ETH_FUNDING_PATH"
  ./node_modules/.bin/tsx scripts/export_okx_funding_history.ts \
    --normalizedPath "$NORMALIZED_DERIVATIVES_PATH" --symbol BTCUSDT --outputPath "$BTC_FUNDING_PATH"
  if [ ! -s "$ETH_FUNDING_PATH" ] || [ ! -s "$BTC_FUNDING_PATH" ]; then
    echo "eth_carry_refresh_pipeline: missing derivatives funding inputs under $DERIVATIVES_DIR"
    exit 2
  fi
  ./node_modules/.bin/tsx scripts/refresh_eth_carry_pipeline.ts \
    --ethFundingPath "$ETH_FUNDING_PATH" \
    --btcFundingPath "$BTC_FUNDING_PATH" \
    --snapshotBaseDir "$ARTIFACT_ROOT/eth_carry_status" \
    "$@"
  status=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end eth_carry_refresh_pipeline exit=$status"
  exit "$status"
} >>"$LOG_FILE" 2>&1
