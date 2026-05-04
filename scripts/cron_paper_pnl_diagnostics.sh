#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/paper_pnl_diagnostics.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/paper_pnl_diagnostics.log"
REPORT_PATH="$REPO_ROOT/data/research/paper_pnl_diagnostics.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/paper_pnl_diagnostics_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")" "$(dirname "$NOTIFICATION_PATH")"

if ! openalice_acquire_cron_lock "paper_pnl_diagnostics" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start paper_pnl_diagnostics"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/analyze_paper_pnl.ts \
    --output "$REPORT_PATH"
  ./node_modules/.bin/tsx -e "const fs=require('fs'); const p=process.argv[1]; const out=process.argv[2]; const r=JSON.parse(fs.readFileSync(p,'utf8')); const notify=Boolean(r.stopLossRollingDiagnostics && r.stopLossRollingDiagnostics.triggered) || (r.coverage && r.coverage.newMissingContextTrades > 0); fs.writeFileSync(out, JSON.stringify({ shouldNotify: notify, deliveryDecision: notify ? 'notify' : 'suppress', headline: 'Paper PnL diagnostics: closed=' + r.coverage.closedTrades + ', stopLossTriggered=' + Boolean(r.stopLossRollingDiagnostics && r.stopLossRollingDiagnostics.triggered), fullText: 'Paper PnL diagnostics completed. closedTrades=' + r.coverage.closedTrades + ', okContextTrades=' + r.coverage.okContextTrades + ', newMissingContextTrades=' + r.coverage.newMissingContextTrades + ', stopLossTriggered=' + Boolean(r.stopLossRollingDiagnostics && r.stopLossRollingDiagnostics.triggered) }, null, 2) + '\n')" "$REPORT_PATH" "$NOTIFICATION_PATH"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end paper_pnl_diagnostics"
} >>"$LOG_FILE" 2>&1
