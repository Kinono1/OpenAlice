#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/microstructure_stoploss_replay.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/microstructure_stoploss_replay.log"
REPORT_PATH="$REPO_ROOT/data/runtime/microstructure_stoploss_replay.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/microstructure_stoploss_replay_notification.json"
LOG_MAX_BYTES="${OPENALICE_CRON_LOG_MAX_BYTES:-8388608}"
LOG_KEEP_LINES="${OPENALICE_CRON_LOG_KEEP_LINES:-2000}"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")"

if ! openalice_acquire_cron_lock "microstructure_stoploss_replay" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

compact_log_if_oversized() {
  local log_size compact_path

  [[ -f "$LOG_FILE" ]] || return 0
  log_size="$(stat -f '%z' "$LOG_FILE" 2>/dev/null || stat -c '%s' "$LOG_FILE" 2>/dev/null || printf '0')"
  [[ "$log_size" =~ ^[0-9]+$ ]] || log_size=0
  (( log_size > LOG_MAX_BYTES )) || return 0

  compact_path="${LOG_FILE}.compact.$$"
  tail -n "$LOG_KEEP_LINES" "$LOG_FILE" > "$compact_path"
  chmod 600 "$compact_path"
  mv "$compact_path" "$LOG_FILE"
}

compact_log_if_oversized

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start microstructure_stoploss_replay"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/run_microstructure_stoploss_replay.ts \
    --outputPath "$REPORT_PATH" \
    --json true >/dev/null
  ./node_modules/.bin/tsx -e "const fs=require('fs'); const p=process.argv[1]; const out=process.argv[2]; const r=JSON.parse(fs.readFileSync(p,'utf8')); const baseline=(r.variants||[]).find(v=>v.name==='baseline'); const triggered=baseline && baseline.metrics && baseline.metrics.stopLossCount >= 20; fs.writeFileSync(out, JSON.stringify({ shouldNotify: Boolean(triggered), deliveryDecision: triggered ? 'notify' : 'suppress', headline: 'Microstructure stop-loss replay: 100x trades=' + r.coverage.microstructure100xClosedTrades, fullText: 'Microstructure stop-loss replay completed. scope=' + r.scope + ', metricBasis=' + r.metricBasis + ', microstructure100xClosedTrades=' + r.coverage.microstructure100xClosedTrades + ', baselineStopLossCount=' + (baseline && baseline.metrics ? baseline.metrics.stopLossCount : 'unknown') }, null, 2) + '\n')" "$REPORT_PATH" "$NOTIFICATION_PATH"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end microstructure_stoploss_replay"
} >>"$LOG_FILE" 2>&1
