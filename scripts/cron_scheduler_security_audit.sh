#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

DATA_ROOT="${OPENALICE_DATA_DIR:-$REPO_ROOT/data}"
ARTIFACT_ROOT="${OPENALICE_ARTIFACT_DIR:-$DATA_ROOT/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
LOCK_DIR="$ARTIFACT_ROOT/locks/scheduler_security_audit.lock"
LOG_DIR="$LOG_ROOT/cron"
LOG_FILE="$LOG_DIR/scheduler_security_audit.log"
REPORT_PATH="$ARTIFACT_ROOT/scheduler_security_audit.latest.json"
NOTIFICATION_PATH="$ARTIFACT_ROOT/scheduler_security_audit_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")" "$(dirname "$NOTIFICATION_PATH")"

if ! openalice_acquire_cron_lock "scheduler_security_audit" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

AUDIT_EXIT=0
{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start scheduler_security_audit"
  cd "$REPO_ROOT"
  if ./node_modules/.bin/tsx scripts/audit_scheduler_security.ts --json true --outputPath "$REPORT_PATH" > "$REPORT_PATH.stdout"; then
    AUDIT_EXIT=0
  else
    AUDIT_EXIT=$?
  fi
  ./node_modules/.bin/tsx -e "const fs=require('fs'); const p=process.argv[1]; const out=process.argv[2]; const exitCode=Number(process.argv[3]||0); const r=JSON.parse(fs.readFileSync(p,'utf8')); const fail=r.status!=='pass'||exitCode!==0; const findings=(r.findings||[]).map(f=>f.check+':'+f.detail).join('; ') || 'none'; fs.writeFileSync(out, JSON.stringify({ shouldNotify: fail, deliveryDecision: fail ? 'notify' : 'suppress', headline: 'Scheduler security audit: ' + r.status, fullText: 'Scheduler security audit completed. status=' + r.status + ', exitCode=' + exitCode + ', findings=' + findings }, null, 2) + '\n') " "$REPORT_PATH" "$NOTIFICATION_PATH" "$AUDIT_EXIT"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end scheduler_security_audit exit=$AUDIT_EXIT"
} >>"$LOG_FILE" 2>&1

exit "$AUDIT_EXIT"
