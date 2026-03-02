#!/usr/bin/env bash
set -euo pipefail

# Daily strategy optimization loop:
# 1) refresh research watch outputs
# 2) select top cards
# 3) run cvar-next smoke/full loop with guard rails

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="${LOCK_DIR:-$ROOT_DIR/.locks}"
LOCK_FILE="${LOCK_FILE:-$LOCK_DIR/daily_strategy_optimize.lock}"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid=""
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "daily_strategy_optimize: another instance is running (pid=$existing_pid), skip."
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
  echo "daily_strategy_optimize: python3 not found" >&2
  exit 1
fi

SKIP_WATCH="${SKIP_WATCH:-0}"
DRAIN_QUEUE_FIRST="${DRAIN_QUEUE_FIRST:-1}"
DRAIN_MAX_ITEMS="${DRAIN_MAX_ITEMS:-1}"
DRAIN_ALLOW_CONCURRENT_TRAIN="${DRAIN_ALLOW_CONCURRENT_TRAIN:-0}"
DRAIN_CONTINUE_ON_ERROR="${DRAIN_CONTINUE_ON_ERROR:-0}"
TOP_K="${TOP_K:-2}"
MAX_PER_TAG="${MAX_PER_TAG:-1}"
MAX_PER_QUERY="${MAX_PER_QUERY:-1}"
MAX_RUNS_PER_CARD="${MAX_RUNS_PER_CARD:-4}"
QUEUE_MAX_ITEMS="${QUEUE_MAX_ITEMS:-24}"
QUEUE_MAX_AGE_DAYS="${QUEUE_MAX_AGE_DAYS:-30}"
QUEUE_LEGACY_MAX_ITEMS="${QUEUE_LEGACY_MAX_ITEMS:-8}"
OPTIMIZE_DIRECTION="${OPTIMIZE_DIRECTION:-balanced}"
OPTIMIZE_DIRECTION_SEQUENCE="${OPTIMIZE_DIRECTION_SEQUENCE:-regime,risk,execution,alpha,diversified}"
OPTIMIZE_DIRECTION_STATE_FILE="${OPTIMIZE_DIRECTION_STATE_FILE:-data/research/strategy-watch/optimize_direction_state.json}"
OPTIMIZE_DIRECTION_FAILURE_REPORT="${OPTIMIZE_DIRECTION_FAILURE_REPORT:-data/research/strategy-watch/analysis/latest_failure_breakdown.json}"
OPTIMIZE_DIRECTION_FAILURE_WINDOW="${OPTIMIZE_DIRECTION_FAILURE_WINDOW:-8}"
OPTIMIZE_DIRECTION_MIN_SIGNAL_SCORE="${OPTIMIZE_DIRECTION_MIN_SIGNAL_SCORE:-0.08}"
OPTIMIZE_DIRECTION_MAX_CONSECUTIVE="${OPTIMIZE_DIRECTION_MAX_CONSECUTIVE:-3}"
EXECUTE="${EXECUTE:-1}"
CONTINUE_ON_ERROR="${CONTINUE_ON_ERROR:-1}"
FORCE_RERUN_FAILED="${FORCE_RERUN_FAILED:-0}"
SKIP_STAGE2="${SKIP_STAGE2:-0}"
ALLOW_REPEAT_CARDS="${ALLOW_REPEAT_CARDS:-0}"
ALLOW_CONCURRENT_TRAIN="${ALLOW_CONCURRENT_TRAIN:-0}"
DRY_RUN="${DRY_RUN:-0}"
PROFILE_OVERRIDE="${PROFILE_OVERRIDE:-}"
PROFILE_DEFAULT="${PROFILE_DEFAULT:-baseline_v1}"
EXPERIMENT_PREFIX="${EXPERIMENT_PREFIX:-cvar24-strategy}"
STALE_RUNNING_MINUTES="${STALE_RUNNING_MINUTES:-120}"
STALE_RUNNING_TO="${STALE_RUNNING_TO:-failed}"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_optimize start"

if [[ "$OPTIMIZE_DIRECTION" == "cycle" || "$OPTIMIZE_DIRECTION" == "adaptive" ]]; then
  DIRECTION_CMD=(
    "$PYTHON_BIN" scripts/pick_optimize_direction.py
    --mode "$OPTIMIZE_DIRECTION"
    --state-file "$OPTIMIZE_DIRECTION_STATE_FILE"
    --sequence "$OPTIMIZE_DIRECTION_SEQUENCE"
  )
  if [[ "$OPTIMIZE_DIRECTION" == "adaptive" ]]; then
    DIRECTION_CMD+=(
      --failure-report "$OPTIMIZE_DIRECTION_FAILURE_REPORT"
      --failure-window "$OPTIMIZE_DIRECTION_FAILURE_WINDOW"
      --min-signal-score "$OPTIMIZE_DIRECTION_MIN_SIGNAL_SCORE"
      --max-consecutive "$OPTIMIZE_DIRECTION_MAX_CONSECUTIVE"
    )
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    DIRECTION_CMD+=(--dry-run)
  fi
  DIRECTION_JSON="$("${DIRECTION_CMD[@]}")"
  OPTIMIZE_DIRECTION="$(printf '%s' "$DIRECTION_JSON" | "$PYTHON_BIN" -c 'import json,sys; print(json.load(sys.stdin).get("direction","balanced"))')"
  DIRECTION_REASON="$(printf '%s' "$DIRECTION_JSON" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); print(d.get("decision_reason",""))')"
  CYCLE_DIRECTION="$(printf '%s' "$DIRECTION_JSON" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); print(d.get("cycle_direction",""))')"
  echo "resolved optimize direction: $OPTIMIZE_DIRECTION (reason=${DIRECTION_REASON:-n/a}, cycle=${CYCLE_DIRECTION:-n/a})"
fi

if [[ "$DRAIN_QUEUE_FIRST" == "1" ]]; then
  DRAIN_CMD=(
    "$PYTHON_BIN" scripts/drain_strategy_queue.py
    --max-items "$DRAIN_MAX_ITEMS"
    --prefer-direction "$OPTIMIZE_DIRECTION"
  )
  if [[ "$DRAIN_ALLOW_CONCURRENT_TRAIN" == "1" ]]; then
    DRAIN_CMD+=(--allow-concurrent-train)
  fi
  if [[ "$DRAIN_CONTINUE_ON_ERROR" == "1" ]]; then
    DRAIN_CMD+=(--continue-on-error)
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    DRAIN_CMD+=(--dry-run)
  fi
  echo "queue-drain command: ${DRAIN_CMD[*]}"
  "${DRAIN_CMD[@]}"
fi

if [[ "$SKIP_WATCH" != "1" ]]; then
  bash scripts/daily_strategy_watch.sh
fi

CMD=(
  "$PYTHON_BIN" scripts/strategy_optimize_loop.py
  --top-k "$TOP_K"
  --max-per-tag "$MAX_PER_TAG"
  --max-per-query "$MAX_PER_QUERY"
  --max-runs-per-card "$MAX_RUNS_PER_CARD"
  --queue-max-items "$QUEUE_MAX_ITEMS"
  --queue-max-age-days "$QUEUE_MAX_AGE_DAYS"
  --queue-legacy-max-items "$QUEUE_LEGACY_MAX_ITEMS"
  --optimize-direction "$OPTIMIZE_DIRECTION"
  --profile-default "$PROFILE_DEFAULT"
  --experiment-prefix "$EXPERIMENT_PREFIX"
  --stale-running-minutes "$STALE_RUNNING_MINUTES"
  --stale-running-to "$STALE_RUNNING_TO"
)

if [[ "$EXECUTE" == "1" ]]; then
  CMD+=(--execute)
fi
if [[ "$CONTINUE_ON_ERROR" == "1" ]]; then
  CMD+=(--continue-on-error)
fi
if [[ "$FORCE_RERUN_FAILED" == "1" ]]; then
  CMD+=(--force-rerun-failed)
fi
if [[ "$SKIP_STAGE2" == "1" ]]; then
  CMD+=(--skip-stage2)
fi
if [[ "$ALLOW_REPEAT_CARDS" == "1" ]]; then
  CMD+=(--allow-repeat-cards)
fi
if [[ "$ALLOW_CONCURRENT_TRAIN" == "1" ]]; then
  CMD+=(--allow-concurrent-train)
fi
if [[ "$DRY_RUN" == "1" ]]; then
  CMD+=(--dry-run)
fi
if [[ -n "$PROFILE_OVERRIDE" ]]; then
  CMD+=(--profile-override "$PROFILE_OVERRIDE")
fi

echo "command: ${CMD[*]}"
"${CMD[@]}"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_optimize done"
