#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/eth_carry_refresh_pipeline.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/eth_carry_refresh_pipeline.log"
DERIVATIVES_DIR="$REPO_ROOT/data/research/derivatives_history"
ETH_FUNDING_PATH="$DERIVATIVES_DIR/binance_ETH_USDT_USDT_funding_history.json"
BTC_FUNDING_PATH="$DERIVATIVES_DIR/binance_BTC_USDT_USDT_funding_history.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/eth_carry_status/eth_carry_actionability_notification.json"

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
  if [ "${OPENALICE_ETH_CARRY_REFRESH_DERIVATIVES:-true}" = "true" ] || [ ! -s "$ETH_FUNDING_PATH" ] || [ ! -s "$BTC_FUNDING_PATH" ]; then
    ./node_modules/.bin/tsx scripts/export_ccxt_derivatives_history.ts \
      --exchange binance \
      --symbol ETH/USDT:USDT \
      --kind funding \
      --outputDir data/research/derivatives_history
    ./node_modules/.bin/tsx scripts/export_ccxt_derivatives_history.ts \
      --exchange binance \
      --symbol BTC/USDT:USDT \
      --kind funding \
      --outputDir data/research/derivatives_history
  fi
  if [ ! -s "$ETH_FUNDING_PATH" ] || [ ! -s "$BTC_FUNDING_PATH" ]; then
    echo "eth_carry_refresh_pipeline: missing derivatives funding inputs under $DERIVATIVES_DIR"
    exit 2
  fi
  ./node_modules/.bin/tsx scripts/refresh_eth_carry_pipeline.ts \
    --ethFundingPath data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json \
    --btcFundingPath data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json \
    "$@"
  status=$?
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end eth_carry_refresh_pipeline exit=$status"
  exit "$status"
} >>"$LOG_FILE" 2>&1
