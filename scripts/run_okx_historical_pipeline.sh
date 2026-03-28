#!/usr/bin/env bash
set -euo pipefail

# End-to-end OKX historical pipeline runner.
# Default flow:
# 1) catalog + candles + index + trades (via data:download:okx:full)
# 2) coverage report
# 3) materialize training CSV (1h by default)
#
# Usage:
#   bash scripts/run_okx_historical_pipeline.sh
#
# Common overrides:
#   DATASET_ROOT=data/market/okx_historical
#   TIMEFRAMES=1h,15m,5m
#   INDEX_BARS=1H,1D,1Dutc
#   MAX_DISK_BYTES=120GB
#   MAX_SYMBOLS=300
#   WORKERS_CANDLES=1
#   WORKERS_INDEX=1
#   WORKERS_TRADES=2
#   FROM_PHASE=catalog
#   TO_PHASE=trades
#   INCLUDE_TRADES_IMPORT=0
#   TRADES_IMPORT_DIR=data/raw/okx/historical/trades
#   RUN_COVERAGE=1
#   COVERAGE_COUNT_ROWS=0
#   RUN_MATERIALIZE=1
#   MATERIALIZE_TIMEFRAME=1h
#   MATERIALIZE_OUTPUT_DIR=data/market/okx
#   LOAD_ENV=1
#   DRY_RUN=0

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM_CMD=("$(command -v pnpm)")
elif [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  PNPM_CMD=("$HOME/.local/share/pnpm/pnpm")
elif [[ -x "$HOME/Library/pnpm/pnpm" ]]; then
  PNPM_CMD=("$HOME/Library/pnpm/pnpm")
elif [[ -x "$HOME/.volta/bin/pnpm" ]]; then
  PNPM_CMD=("$HOME/.volta/bin/pnpm")
elif compgen -G "$HOME/.nvm/versions/node/*/bin/pnpm" >/dev/null; then
  NVM_PNPM="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/pnpm | sort -V | tail -n 1)"
  PNPM_CMD=("$NVM_PNPM")
elif [[ -x "/opt/homebrew/bin/pnpm" ]]; then
  PNPM_CMD=("/opt/homebrew/bin/pnpm")
elif command -v corepack >/dev/null 2>&1 && corepack pnpm --version >/dev/null 2>&1; then
  PNPM_CMD=(corepack pnpm)
elif command -v npm >/dev/null 2>&1 && npm exec --yes pnpm --version >/dev/null 2>&1; then
  PNPM_CMD=(npm exec --yes pnpm)
else
  echo "run_okx_historical_pipeline: pnpm not found. Install pnpm, or enable corepack." >&2
  echo "  Example: corepack enable && corepack prepare pnpm@latest --activate" >&2
  exit 1
fi

PNPM_DISPLAY="$(printf '%q ' "${PNPM_CMD[@]}")"
PNPM_DISPLAY="${PNPM_DISPLAY% }"

LOAD_ENV="${LOAD_ENV:-1}"
if [[ "$LOAD_ENV" == "1" ]] && [[ -f ".env" ]]; then
  # Export .env variables for this shell process.
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PROXY_URL="${HTTPS_PROXY:-${https_proxy:-${HTTP_PROXY:-${http_proxy:-${ALL_PROXY:-${all_proxy:-}}}}}}"
PROXY_ENV_SET=0
if [[ -n "$PROXY_URL" ]]; then
  PROXY_ENV_SET=1
fi

# Node fetch does not use proxy env unless NODE_USE_ENV_PROXY is enabled.
# Auto-enable it when proxy env vars are present, while allowing explicit override.
if [[ "$PROXY_ENV_SET" == "1" ]] && [[ -z "${NODE_USE_ENV_PROXY:-}" ]]; then
  export NODE_USE_ENV_PROXY=1
fi

DATASET_ROOT="${DATASET_ROOT:-data/market/okx_historical}"
TIMEFRAMES="${TIMEFRAMES:-1h,15m,5m}"
INDEX_BARS="${INDEX_BARS:-1H,1D,1Dutc}"
MAX_DISK_BYTES="${MAX_DISK_BYTES:-120GB}"
MAX_SYMBOLS="${MAX_SYMBOLS:-}"
WORKERS_CANDLES="${WORKERS_CANDLES:-1}"
WORKERS_INDEX="${WORKERS_INDEX:-1}"
WORKERS_TRADES="${WORKERS_TRADES:-2}"
FROM_PHASE="${FROM_PHASE:-catalog}"
TO_PHASE="${TO_PHASE:-trades}"
INCLUDE_TRADES_IMPORT="${INCLUDE_TRADES_IMPORT:-0}"
TRADES_IMPORT_DIR="${TRADES_IMPORT_DIR:-data/raw/okx/historical/trades}"

RUN_COVERAGE="${RUN_COVERAGE:-1}"
COVERAGE_COUNT_ROWS="${COVERAGE_COUNT_ROWS:-0}"

RUN_MATERIALIZE="${RUN_MATERIALIZE:-1}"
MATERIALIZE_TIMEFRAME="${MATERIALIZE_TIMEFRAME:-1h}"
MATERIALIZE_OUTPUT_DIR="${MATERIALIZE_OUTPUT_DIR:-data/market/okx}"

DRY_RUN="${DRY_RUN:-0}"

LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"
LOG_FILE="${LOG_FILE:-$LOG_DIR/okx_historical_pipeline_$(date -u +%Y%m%dT%H%M%SZ).log}"
touch "$LOG_FILE"

log() {
  local msg="$1"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$ts] $msg" | tee -a "$LOG_FILE"
}

run_step() {
  local name="$1"
  shift
  log "STEP START: $name"
  log "CMD: $*"
  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN=1, skip execution: $name"
    return 0
  fi
  if "$@" >>"$LOG_FILE" 2>&1; then
    log "STEP DONE:  $name"
    return 0
  else
    local rc=$?
    log "STEP FAIL:  $name (exit=$rc). See log: $LOG_FILE"
    return "$rc"
  fi
}

FULL_CMD=(
  "${PNPM_CMD[@]}" run data:download:okx:full -- --datasetRoot "$DATASET_ROOT"
  --fromPhase "$FROM_PHASE"
  --toPhase "$TO_PHASE"
  --resume true
  --timeframes "$TIMEFRAMES"
  --indexBars "$INDEX_BARS"
  --maxDiskBytes "$MAX_DISK_BYTES"
  --workersCandles "$WORKERS_CANDLES"
  --workersIndex "$WORKERS_INDEX"
  --workersTrades "$WORKERS_TRADES"
  --includeTradesImport "$INCLUDE_TRADES_IMPORT"
  --tradesImportDir "$TRADES_IMPORT_DIR"
)
if [[ -n "$MAX_SYMBOLS" ]]; then
  FULL_CMD+=(--maxSymbols "$MAX_SYMBOLS")
fi

log "Pipeline config:"
log "  DATASET_ROOT=$DATASET_ROOT"
log "  TIMEFRAMES=$TIMEFRAMES"
log "  INDEX_BARS=$INDEX_BARS"
log "  MAX_DISK_BYTES=$MAX_DISK_BYTES"
log "  FROM_PHASE=$FROM_PHASE TO_PHASE=$TO_PHASE"
log "  WORKERS candles/index/trades = $WORKERS_CANDLES/$WORKERS_INDEX/$WORKERS_TRADES"
log "  INCLUDE_TRADES_IMPORT=$INCLUDE_TRADES_IMPORT"
log "  RUN_COVERAGE=$RUN_COVERAGE RUN_MATERIALIZE=$RUN_MATERIALIZE"
log "  PROXY_ENV_SET=$PROXY_ENV_SET NODE_USE_ENV_PROXY=${NODE_USE_ENV_PROXY:-0}"
log "  PNPM_CMD=$PNPM_DISPLAY"
log "  LOG_FILE=$LOG_FILE"

run_step "okx_full_download" "${FULL_CMD[@]}"

if [[ "$RUN_COVERAGE" == "1" ]]; then
  COVERAGE_CMD=(
    "${PNPM_CMD[@]}" run data:report:okx:coverage -- --datasetRoot "$DATASET_ROOT"
    --countRows "$COVERAGE_COUNT_ROWS"
  )
  run_step "okx_coverage_report" "${COVERAGE_CMD[@]}"
fi

if [[ "$RUN_MATERIALIZE" == "1" ]]; then
  MATERIALIZE_CMD=(
    "${PNPM_CMD[@]}" run data:materialize:okx:training -- --datasetRoot "$DATASET_ROOT"
    --timeframe "$MATERIALIZE_TIMEFRAME"
    --outputDir "$MATERIALIZE_OUTPUT_DIR"
  )
  if [[ -n "$MAX_SYMBOLS" ]]; then
    MATERIALIZE_CMD+=(--maxSymbols "$MAX_SYMBOLS")
  fi
  run_step "okx_materialize_training_csv" "${MATERIALIZE_CMD[@]}"
fi

log "Pipeline finished successfully."
log "Key outputs:"
log "  $DATASET_ROOT/reports/full_run_summary.v1.json"
log "  $DATASET_ROOT/reports/coverage_report.v1.json"
log "  $DATASET_ROOT/reports/materialize_${MATERIALIZE_TIMEFRAME}_summary.v1.json"
