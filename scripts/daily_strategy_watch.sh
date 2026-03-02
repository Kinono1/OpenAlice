#!/usr/bin/env bash
set -euo pipefail

# Daily strategy research watch.
# Pulls recent arXiv strategy papers, updates digest + experiment cards.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="${LOCK_DIR:-$ROOT_DIR/.locks}"
LOCK_FILE="${LOCK_FILE:-$LOCK_DIR/daily_strategy_watch.lock}"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid=""
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "daily_strategy_watch: another instance is running (pid=$existing_pid), skip."
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

LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"

if [[ -x "$ROOT_DIR/.venv/bin/python" ]]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PYTHON_BIN="$(command -v python3)"
else
  echo "daily_strategy_watch: python3 not found" >&2
  exit 1
fi

OUT_DIR="${OUT_DIR:-data/research/strategy-watch}"
STATE_FILE="${STATE_FILE:-data/research/strategy-watch/state.json}"
LOOKBACK_DAYS="${LOOKBACK_DAYS:-180}"
MAX_RESULTS="${MAX_RESULTS:-140}"
MAX_CARDS="${MAX_CARDS:-8}"
QUERY_PROFILE="${QUERY_PROFILE:-crypto}"
MAX_CARDS_PER_QUERY="${MAX_CARDS_PER_QUERY:-2}"
MIN_SCORE="${MIN_SCORE:-2.2}"
MAX_DIGEST_ITEMS="${MAX_DIGEST_ITEMS:-20}"
TIMEOUT_SEC="${TIMEOUT_SEC:-25}"
REQUEST_DELAY_SEC="${REQUEST_DELAY_SEC:-1.2}"
MAX_RETRIES="${MAX_RETRIES:-3}"
RETRY_BACKOFF_SEC="${RETRY_BACKOFF_SEC:-2.0}"

CMD=(
  "$PYTHON_BIN" scripts/strategy_research_watch.py
  --query-profile "$QUERY_PROFILE"
  --out-dir "$OUT_DIR"
  --state-file "$STATE_FILE"
  --lookback-days "$LOOKBACK_DAYS"
  --max-results "$MAX_RESULTS"
  --max-cards "$MAX_CARDS"
  --max-cards-per-query "$MAX_CARDS_PER_QUERY"
  --min-score "$MIN_SCORE"
  --max-digest-items "$MAX_DIGEST_ITEMS"
  --timeout-sec "$TIMEOUT_SEC"
  --request-delay-sec "$REQUEST_DELAY_SEC"
  --max-retries "$MAX_RETRIES"
  --retry-backoff-sec "$RETRY_BACKOFF_SEC"
)

if [[ "${EXTRA_QUERY:-}" != "" ]]; then
  CMD+=(--query "$EXTRA_QUERY")
fi

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  CMD+=(--dry-run)
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_watch start"
echo "command: ${CMD[*]}"
"${CMD[@]}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_watch done"
