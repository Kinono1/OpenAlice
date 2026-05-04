#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/p1_trading_evidence.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/p1_trading_evidence.log"
INDEX_PATH="$REPO_ROOT/data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json"
META_LABEL_READINESS_PATH="$REPO_ROOT/data/runtime/meta_labeling_shadow_readiness.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/p1_trading_evidence_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$INDEX_PATH")" "$(dirname "$META_LABEL_READINESS_PATH")" "$(dirname "$NOTIFICATION_PATH")"

if ! openalice_acquire_cron_lock "p1_trading_evidence" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start p1_trading_evidence"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/build_p1_trading_evidence.ts --json true > "$INDEX_PATH.stdout"
  ./node_modules/.bin/tsx scripts/build_meta_labeling_shadow_readiness.ts --json true > "$META_LABEL_READINESS_PATH.stdout"
  ./node_modules/.bin/tsx scripts/build_p1_trading_evidence_notification.ts --indexPath "$INDEX_PATH" --metaLabelReadinessPath "$META_LABEL_READINESS_PATH" --output "$NOTIFICATION_PATH" --json true > "$NOTIFICATION_PATH.stdout"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end p1_trading_evidence"
} >>"$LOG_FILE" 2>&1
