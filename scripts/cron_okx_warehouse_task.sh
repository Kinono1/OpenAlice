#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"
if [[ -z "$TASK" ]]; then
  echo "usage: $0 <instrument|fast|broad|health|compact|universe|ssd_probe|ssd_reminder_weekly|ssd_reminder_followup|ssd_integrity|retention>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"
source "$REPO_ROOT/scripts/openalice_pnpm.sh"

export PATH="/Users/kino/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
DATA_ROOT="${OPENALICE_DATA_DIR:-$REPO_ROOT/data}"
ARTIFACT_ROOT="${OPENALICE_ARTIFACT_DIR:-$DATA_ROOT/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
export OPENALICE_DATA_ROOT="${OPENALICE_DATA_ROOT:-$DATA_ROOT}"

LOCK_DIR="$ARTIFACT_ROOT/locks/cron_okx_warehouse_${TASK}.lock"
LOG_FILE="$LOG_ROOT/cron_okx_warehouse_${TASK}.log"
NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/${TASK}_notification.json"

case "$TASK" in
  instrument) NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/okx_instrument_master_refresh_notification.json" ;;
  fast) NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/okx_public_fast_refresh_notification.json" ;;
  broad) NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/okx_public_broad_refresh_notification.json" ;;
  health) NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/okx_market_data_health_notification.json" ;;
  compact) NOTIFICATION_PATH="$ARTIFACT_ROOT/okx_warehouse/okx_warehouse_compact_notification.json" ;;
  ssd_probe) NOTIFICATION_PATH="$ARTIFACT_ROOT/storage/ssd_archive_notification.json" ;;
  ssd_reminder_weekly|ssd_reminder_followup) NOTIFICATION_PATH="$ARTIFACT_ROOT/storage/ssd_reminder_notification.json" ;;
  retention) NOTIFICATION_PATH="$ARTIFACT_ROOT/storage/okx_warehouse_retention_notification.json" ;;
esac

mkdir -p "$(dirname "$LOCK_DIR")" "$(dirname "$LOG_FILE")" "$(dirname "$NOTIFICATION_PATH")"
if ! openalice_acquire_cron_lock "okx_warehouse_${TASK}" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi
trap 'openalice_release_cron_lock "$LOCK_DIR"' EXIT INT TERM

cd "$REPO_ROOT"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start ${TASK}" >> "$LOG_FILE"
case "$TASK" in
  instrument) openalice_run_pnpm data:okx:warehouse:instrument >> "$LOG_FILE" 2>&1 ;;
  fast) openalice_run_pnpm data:okx:warehouse:fast >> "$LOG_FILE" 2>&1 ;;
  broad) openalice_run_pnpm data:okx:warehouse:broad >> "$LOG_FILE" 2>&1 ;;
  health) openalice_run_pnpm data:okx:warehouse:health >> "$LOG_FILE" 2>&1 || true ;;
  compact)
    openalice_run_pnpm data:okx:warehouse:compact >> "$LOG_FILE" 2>&1
    openalice_run_pnpm data:okx:warehouse:derive >> "$LOG_FILE" 2>&1
    openalice_run_pnpm data:okx:warehouse:compact >> "$LOG_FILE" 2>&1
    if [[ "${OPENALICE_OKX_COMPATIBILITY_MATERIALIZER_ENABLED:-false}" == "true" ]]; then
      openalice_run_pnpm data:okx:warehouse:materialize >> "$LOG_FILE" 2>&1
    fi
    ;;
  universe) openalice_run_pnpm data:okx:warehouse:universe >> "$LOG_FILE" 2>&1 ;;
  ssd_probe) openalice_run_pnpm data:okx:ssd:probe >> "$LOG_FILE" 2>&1 ;;
  ssd_reminder_weekly) openalice_run_pnpm data:okx:ssd:reminder -- --mode weekly >> "$LOG_FILE" 2>&1 ;;
  ssd_reminder_followup) openalice_run_pnpm data:okx:ssd:reminder -- --mode followup >> "$LOG_FILE" 2>&1 ;;
  ssd_integrity) openalice_run_pnpm data:okx:ssd:integrity >> "$LOG_FILE" 2>&1 ;;
  retention) openalice_run_pnpm data:okx:warehouse:retention >> "$LOG_FILE" 2>&1 ;;
  *) echo "unknown OKX warehouse task: $TASK" >&2; exit 64 ;;
esac

if [[ ! -f "$NOTIFICATION_PATH" ]]; then
  node --input-type=module - "$NOTIFICATION_PATH" "$TASK" <<'NODE'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
const [path, task] = process.argv.slice(2)
mkdirSync(dirname(path), { recursive: true })
writeFileSync(path, `${JSON.stringify({
  shouldNotify: false,
  deliveryDecision: 'suppress',
  headline: `OKX warehouse ${task}: complete`,
  fullText: `OKX warehouse task ${task} completed without a notification condition.`,
}, null, 2)}\n`)
NODE
fi
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end ${TASK}" >> "$LOG_FILE"
