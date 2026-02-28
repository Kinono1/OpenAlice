#!/usr/bin/env bash
set -euo pipefail

# Strategy pipeline health check loop.
# Evaluates freshness/queue pressure and emits low-noise alerts.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="${LOCK_DIR:-$ROOT_DIR/.locks}"
LOCK_FILE="${LOCK_FILE:-$LOCK_DIR/daily_strategy_health_check.lock}"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid=""
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "daily_strategy_health_check: another instance is running (pid=$existing_pid), skip."
      return 1
    fi
    rm -f "$LOCK_FILE"
  fi
  echo "$$" > "$LOCK_FILE"
  return 0
}

release_lock() {
  if [[ -f "$LOCK_FILE" ]] && [[ "$(cat "$LOCK_FILE" 2>/dev/null || true)" == "$$" ]]; then
    rm -f "$LOCK_FILE"
  fi
}

if ! acquire_lock; then
  exit 0
fi
trap release_lock EXIT INT TERM

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "daily_strategy_health_check: python3 not found" >&2
  exit 1
fi

WATCH_DIGEST="${WATCH_DIGEST:-data/research/strategy-watch/latest_digest.json}"
OPTIMIZE_REPORT="${OPTIMIZE_REPORT:-data/research/strategy-watch/execution/latest_loop_report.json}"
QUEUE_DRAIN_REPORT="${QUEUE_DRAIN_REPORT:-data/research/strategy-watch/execution/queue-drain/latest_queue_drain_report.json}"
QUEUE_FILE="${QUEUE_FILE:-data/research/strategy-watch/execution/pending_queue.json}"
OUT_DIR="${OUT_DIR:-data/research/strategy-watch/health}"
STATE_FILE="${STATE_FILE:-data/research/strategy-watch/health/state.json}"
ALERTS_FILE="${ALERTS_FILE:-data/research/strategy-watch/health/alerts.ndjson}"
STALE_WATCH_MINUTES="${STALE_WATCH_MINUTES:-90}"
STALE_OPTIMIZE_MINUTES="${STALE_OPTIMIZE_MINUTES:-20}"
STALE_QUEUE_DRAIN_MINUTES="${STALE_QUEUE_DRAIN_MINUTES:-20}"
MAX_QUEUE_ITEMS="${MAX_QUEUE_ITEMS:-36}"
MAX_LEGACY_RATIO="${MAX_LEGACY_RATIO:-0.65}"
ALERT_COOLDOWN_MINUTES="${ALERT_COOLDOWN_MINUTES:-60}"
DRY_RUN="${DRY_RUN:-0}"

CMD=(
  "$PYTHON_BIN" scripts/strategy_pipeline_health_check.py
  --watch-digest "$WATCH_DIGEST"
  --optimize-report "$OPTIMIZE_REPORT"
  --queue-drain-report "$QUEUE_DRAIN_REPORT"
  --queue-file "$QUEUE_FILE"
  --out-dir "$OUT_DIR"
  --state-file "$STATE_FILE"
  --alerts-file "$ALERTS_FILE"
  --stale-watch-minutes "$STALE_WATCH_MINUTES"
  --stale-optimize-minutes "$STALE_OPTIMIZE_MINUTES"
  --stale-queue-drain-minutes "$STALE_QUEUE_DRAIN_MINUTES"
  --max-queue-items "$MAX_QUEUE_ITEMS"
  --max-legacy-ratio "$MAX_LEGACY_RATIO"
  --alert-cooldown-minutes "$ALERT_COOLDOWN_MINUTES"
)

if [[ "$DRY_RUN" == "1" ]]; then
  CMD+=(--dry-run)
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_health_check start"
echo "command: ${CMD[*]}"
"${CMD[@]}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_health_check done"
