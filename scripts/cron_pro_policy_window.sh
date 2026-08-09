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
LOCK_DIR="$ARTIFACT_ROOT/locks/pro_policy_window.lock"
LOG_DIR="$LOG_ROOT/cron"
LOG_FILE="$LOG_DIR/pro_policy_window.log"
REPORT_PATH="$ARTIFACT_ROOT/pro_policy_window.latest.json"
NOTIFICATION_PATH="$ARTIFACT_ROOT/pro_policy_window_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")"

if ! openalice_acquire_cron_lock "pro_policy_window" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start pro_policy_window"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/analyze_pro_policy_window.ts \
    --paperDir "$DATA_ROOT/paper_trading" \
    --policyPath "$ARTIFACT_ROOT/pro_risk_policy.latest.json" \
    --outputPath "$REPORT_PATH"
  ./node_modules/.bin/tsx -e "const fs=require('fs'); const p=process.argv[1]; const out=process.argv[2]; const r=JSON.parse(fs.readFileSync(p,'utf8')); const m=r.metrics || r; const post=m.postTrades ?? r.postTrades ?? 0; fs.writeFileSync(out, JSON.stringify({ shouldNotify: post > 0, deliveryDecision: post > 0 ? 'notify' : 'suppress', headline: 'Pro policy window: postTrades=' + post, fullText: 'Pro policy window completed. preTrades=' + (m.preTrades ?? r.preTrades ?? 'unknown') + ', postTrades=' + post + ', counterfactualType=' + (r.counterfactualType ?? 'historical_baseline') }, null, 2) + '\n')" "$REPORT_PATH" "$NOTIFICATION_PATH"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end pro_policy_window"
} >>"$LOG_FILE" 2>&1
