#!/usr/bin/env bash
set -euo pipefail

# Daily strategy governance loop:
# 0) run systematic code-review gate
# 1) pull crypto market data (with catch-up support)
# 2) refresh external benchmark leaderboard
# 3) run layered admission gate
# 4) refresh failure breakdown report
# 5) run strategy optimize loop (adaptive by default)
# 6) refresh pipeline health report
# 7) print latest gate summary snapshot (execution + idempotency governance)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCK_DIR="${LOCK_DIR:-$ROOT_DIR/.locks}"
LOCK_FILE="${LOCK_FILE:-$LOCK_DIR/daily_strategy_governance.lock}"
mkdir -p "$LOCK_DIR"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local existing_pid=""
    existing_pid="$(cat "$LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$existing_pid" ]] && kill -0 "$existing_pid" 2>/dev/null; then
      echo "daily_strategy_governance: another instance is running (pid=$existing_pid), skip."
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
  echo "daily_strategy_governance: python3 not found" >&2
  exit 1
fi

RUN_DATA_PULL="${RUN_DATA_PULL:-1}"
RUN_EXTERNAL_BENCHMARK="${RUN_EXTERNAL_BENCHMARK:-1}"
RUN_ADMISSION="${RUN_ADMISSION:-1}"
RUN_FAILURE_BREAKDOWN="${RUN_FAILURE_BREAKDOWN:-1}"
RUN_OPTIMIZE_LOOP="${RUN_OPTIMIZE_LOOP:-1}"
RUN_HEALTH_CHECK="${RUN_HEALTH_CHECK:-1}"
RUN_GATE_SUMMARY="${RUN_GATE_SUMMARY:-1}"
RUN_REVIEW_GATE="${RUN_REVIEW_GATE:-1}"
CONTINUE_ON_ERROR="${CONTINUE_ON_ERROR:-1}"
DRY_RUN="${DRY_RUN:-0}"
REVIEW_GATE_MODE="${REVIEW_GATE_MODE:-changed}"
REVIEW_GATE_BLOCK_SEVERITIES="${REVIEW_GATE_BLOCK_SEVERITIES:-critical,high}"

EXTERNAL_BENCHMARK_PROBE="${EXTERNAL_BENCHMARK_PROBE:-1}"
EXTERNAL_BENCHMARK_MANIFEST="${EXTERNAL_BENCHMARK_MANIFEST:-}"
EXTERNAL_BENCHMARK_OUT_DIR="${EXTERNAL_BENCHMARK_OUT_DIR:-}"
FAILURE_WINDOWS="${FAILURE_WINDOWS:-8,20,30}"
FAILURE_SAMPLE_CYCLES="${FAILURE_SAMPLE_CYCLES:-10}"
ADMISSION_MIN_STABILITY_CYCLES="${ADMISSION_MIN_STABILITY_CYCLES:-2}"
OPTIMIZE_DIRECTION_MODE="${OPTIMIZE_DIRECTION_MODE:-adaptive}"
OPTIMIZE_TOP_K="${OPTIMIZE_TOP_K:-2}"
OPTIMIZE_MAX_RUNS_PER_CARD="${OPTIMIZE_MAX_RUNS_PER_CARD:-2}"
OPTIMIZE_SKIP_WATCH="${OPTIMIZE_SKIP_WATCH:-1}"
OPTIMIZE_DRAIN_QUEUE_FIRST="${OPTIMIZE_DRAIN_QUEUE_FIRST:-1}"
OPTIMIZE_EXECUTE="${OPTIMIZE_EXECUTE:-1}"
OPTIMIZE_CONTINUE_ON_ERROR="${OPTIMIZE_CONTINUE_ON_ERROR:-1}"
OPTIMIZE_ALLOW_REPEAT_CARDS="${OPTIMIZE_ALLOW_REPEAT_CARDS:-0}"

FAILED_STEPS=()

run_step() {
  local step_name="$1"
  shift

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] step start: ${step_name}"
  if "$@"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] step done:  ${step_name}"
    return 0
  else
    local rc=$?
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] step fail:  ${step_name} (exit=${rc})" >&2
    FAILED_STEPS+=("${step_name}")
    if [[ "$CONTINUE_ON_ERROR" == "1" ]]; then
      return 0
    fi
    return "$rc"
  fi
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_governance start"

if [[ "$RUN_REVIEW_GATE" == "1" ]]; then
  REVIEW_CMD=(
    "$PYTHON_BIN" scripts/systematic_review_gate.py
    --mode "$REVIEW_GATE_MODE"
    --block-severities "$REVIEW_GATE_BLOCK_SEVERITIES"
  )
  run_step "systematic_review_gate" "${REVIEW_CMD[@]}"
fi

if [[ "$RUN_DATA_PULL" == "1" ]]; then
  run_step "daily_crypto_data_pull" env DRY_RUN="$DRY_RUN" bash scripts/daily_crypto_data_pull.sh
fi

if [[ "$RUN_EXTERNAL_BENCHMARK" == "1" ]]; then
  EXTERNAL_CMD=("$PYTHON_BIN" scripts/external_benchmark_harness.py)
  if [[ "$EXTERNAL_BENCHMARK_PROBE" == "1" ]]; then
    EXTERNAL_CMD+=(--probe-tools)
  fi
  if [[ -n "$EXTERNAL_BENCHMARK_MANIFEST" ]]; then
    EXTERNAL_CMD+=(--manifest "$EXTERNAL_BENCHMARK_MANIFEST")
  fi
  if [[ -n "$EXTERNAL_BENCHMARK_OUT_DIR" ]]; then
    EXTERNAL_CMD+=(--out-dir "$EXTERNAL_BENCHMARK_OUT_DIR")
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    EXTERNAL_CMD+=(--dry-run)
  fi
  run_step "external_benchmark_harness" "${EXTERNAL_CMD[@]}"
fi

if [[ "$RUN_ADMISSION" == "1" ]]; then
  ADMISSION_CMD=(
    "$PYTHON_BIN" scripts/strategy_admission_gate.py
    --min-stability-cycles "$ADMISSION_MIN_STABILITY_CYCLES"
  )
  if [[ "$DRY_RUN" == "1" ]]; then
    ADMISSION_CMD+=(--dry-run)
  fi
  run_step "strategy_admission_gate" "${ADMISSION_CMD[@]}"
fi

if [[ "$RUN_FAILURE_BREAKDOWN" == "1" ]]; then
  BREAKDOWN_CMD=(
    "$PYTHON_BIN" scripts/failure_breakdown.py
    --windows "$FAILURE_WINDOWS"
    --sample-cycles "$FAILURE_SAMPLE_CYCLES"
  )
  if [[ "$DRY_RUN" == "1" ]]; then
    BREAKDOWN_CMD+=(--dry-run)
  fi
  run_step "failure_breakdown" "${BREAKDOWN_CMD[@]}"
fi

if [[ "$RUN_OPTIMIZE_LOOP" == "1" ]]; then
  run_step \
    "daily_strategy_optimize" \
    env \
      OPTIMIZE_DIRECTION="$OPTIMIZE_DIRECTION_MODE" \
      TOP_K="$OPTIMIZE_TOP_K" \
      MAX_RUNS_PER_CARD="$OPTIMIZE_MAX_RUNS_PER_CARD" \
      SKIP_WATCH="$OPTIMIZE_SKIP_WATCH" \
      DRAIN_QUEUE_FIRST="$OPTIMIZE_DRAIN_QUEUE_FIRST" \
      EXECUTE="$OPTIMIZE_EXECUTE" \
      CONTINUE_ON_ERROR="$OPTIMIZE_CONTINUE_ON_ERROR" \
      ALLOW_REPEAT_CARDS="$OPTIMIZE_ALLOW_REPEAT_CARDS" \
      DRY_RUN="$DRY_RUN" \
      bash scripts/daily_strategy_optimize.sh
fi

if [[ "$RUN_HEALTH_CHECK" == "1" ]]; then
  run_step "strategy_health_check" env DRY_RUN="$DRY_RUN" bash scripts/daily_strategy_health_check.sh
fi

if [[ "$RUN_GATE_SUMMARY" == "1" ]]; then
  run_step "gate_summary_snapshot" "$PYTHON_BIN" scripts/gate_summary_snapshot.py
fi

if [[ "${#FAILED_STEPS[@]}" -gt 0 ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_governance completed with failures: ${FAILED_STEPS[*]}" >&2
  if [[ "$CONTINUE_ON_ERROR" == "1" ]]; then
    exit 0
  fi
  exit 1
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_strategy_governance done"
