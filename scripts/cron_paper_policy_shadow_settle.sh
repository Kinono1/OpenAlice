#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/paper_policy_shadow_settle.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/paper_policy_shadow_settle.log"
REPORT_PATH="$REPO_ROOT/data/runtime/paper_policy_shadow_settle.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/paper_policy_shadow_settle_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")"

if ! openalice_acquire_cron_lock "paper_policy_shadow_settle" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start paper_policy_shadow_settle"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/settle_paper_policy_shadow_ledger.ts \
    --timeframe 5m \
    --dryRun false \
    --outputPath "$REPORT_PATH" \
    --json true
  ./node_modules/.bin/tsx -e "const fs=require('fs'); const p=process.argv[1]; const out=process.argv[2]; const r=JSON.parse(fs.readFileSync(p,'utf8')); fs.writeFileSync(out, JSON.stringify({ shouldNotify: r.counts.appendedOutcomes > 0 || r.counts.missingCandleFiles > 0, deliveryDecision: r.counts.appendedOutcomes > 0 || r.counts.missingCandleFiles > 0 ? 'notify' : 'suppress', headline: 'Paper policy shadow settle: appended=' + r.counts.appendedOutcomes + ', due=' + r.counts.dueOutcomes + ', missingFiles=' + r.counts.missingCandleFiles, fullText: 'Paper policy shadow settle completed. appendedOutcomes=' + r.counts.appendedOutcomes + ', dueOutcomes=' + r.counts.dueOutcomes + ', notDue=' + r.counts.notDue + ', missingSymbols=' + r.missingSymbols.join(',') }, null, 2) + '\n')" "$REPORT_PATH" "$NOTIFICATION_PATH"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end paper_policy_shadow_settle"
} >>"$LOG_FILE" 2>&1
