#!/usr/bin/env bash
set -euo pipefail

ROOT="/Users/kino/Files/work_projects/code/expCode/effeciency/crypto/OpenAlice"
cd "$ROOT"

DATA_ROOT="/Volumes/shield/cryptoData/openalice-data/market/binance-public"
RUNNER="scripts/run_fast_binance_data_vision_dataset.ts"
TSX="./node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs"

SMOKE_ONLY="${SMOKE_ONLY:-false}"

# Force proxy OFF
unset http_proxy https_proxy all_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY
PROXY_ENV_CLEAN=(-u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY)

PID=$$
START_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

check_disk() {
  local label="$1"
  local avail
  avail="$(df -h /Volumes/shield/ | awk 'NR==2{print $4}')"
  local avail_bytes
  avail_bytes="$(df /Volumes/shield/ | awk 'NR==2{print $4}')"
  log "DISK: $label — available $avail ($(( avail_bytes / 1024 / 1024 ))MB)"
  if [[ "$avail_bytes" -lt 52428800 ]]; then
    log "DISK: SKIP $label — only $avail free, need >= 50GB"
    return 1
  fi
  return 0
}

run_dataset() {
  local market="$1"
  local data_type="$2"
  local start_month="$3"
  local out_dir="$4"
  local concurrency="$5"
  local extra_args=("${@:6}")

  local args=(
    "$RUNNER"
    --market "$market"
    --dataType "$data_type"
    --quote USDT
    --startMonth "$start_month"
    --outDir "$out_dir"
    --listConcurrency 8
    --concurrency "$concurrency"
    --retryConcurrency 60
    --maxRetries 12
    --retryMaxRetries 12
    --connectTimeoutSec 10
    --listMaxTimeSec 120
    --downloadMaxTimeSec 180
    --retryRounds 2
    --proxy none
    --discovery s3
    "${extra_args[@]}"
  )

  log "START dataset: $market/$data_type -> $out_dir (concurrency=$concurrency)"
  env "${PROXY_ENV_CLEAN[@]}" node "$TSX" "${args[@]}"
  local rc=$?
  if [[ "$rc" -eq 0 || "$rc" -eq 2 ]]; then
    log "OK  dataset: $market/$data_type (exit=$rc)"
  else
    log "FAIL dataset: $market/$data_type (exit=$rc)"
    return "$rc"
  fi
}

# ============================================================
# MAIN
# ============================================================
log "=== DOWNLOAD MISSING DATASETS START ==="
log "PID: $PID"
log "ROOT: $ROOT"
log "DATA_ROOT: $DATA_ROOT"
log "SMOKE_ONLY: $SMOKE_ONLY"

mkdir -p "$DATA_ROOT"

if ! check_disk "initial"; then
  log "ABORT: insufficient disk at startup"
  exit 10
fi

# ============================================================
# Step 1: Smoke test bookTicker (tiny dataset, 2 symbols, 20 tasks)
# ============================================================
log "=== SMOKE: bookTicker (maxSymbols=2, maxTasks=20, concurrency=4) ==="
SMOKE_OUTDIR="$DATA_ROOT/um-all-usdt-bookTicker"
if check_disk "smoke-bookTicker"; then
  run_dataset um bookTicker 2019-09 "$SMOKE_OUTDIR" 4 \
    --maxSymbols 2 \
    --maxTasks 20
  SMOKE_RC=$?
else
  SMOKE_RC=99
fi

if [[ "$SMOKE_RC" -ne 0 && "$SMOKE_RC" -ne 2 ]]; then
  log "SMOKE FAILED with exit=$SMOKE_RC — aborting before full run"
  exit "$SMOKE_RC"
fi
log "SMOKE PASSED"

if [[ "$SMOKE_ONLY" == "true" ]]; then
  log "SMOKE_ONLY=true — skipping full datasets"
  log "=== DOWNLOAD MISSING DATASETS END ==="
  exit 0
fi

# ============================================================
# Step 2: Full bookTicker (small, fast)
# ============================================================
log "=== FULL: um-all-usdt-bookTicker ==="
if check_disk "full-bookTicker"; then
  run_dataset um bookTicker 2019-09 "$DATA_ROOT/um-all-usdt-bookTicker" 96
else
  log "SKIP full-bookTicker (disk space)"
fi

# ============================================================
# Step 3: spot trades (medium, ~4h)
# ============================================================
log "=== FULL: spot-all-usdt-trades (medium, ~4h) ==="
if check_disk "full-spot-trades"; then
  run_dataset spot trades 2017-08 "$DATA_ROOT/spot-all-usdt-trades" 16
else
  log "SKIP full-spot-trades (disk space)"
fi

# ============================================================
# Step 4: um trades (largest, ~6h)
# ============================================================
log "=== FULL: um-all-usdt-trades (largest, ~6h) ==="
if check_disk "full-um-trades"; then
  run_dataset um trades 2019-09 "$DATA_ROOT/um-all-usdt-trades" 16
else
  log "SKIP full-um-trades (disk space)"
fi

# ============================================================
END_TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "=== DOWNLOAD MISSING DATASETS END ==="
log "Started : $START_TS"
log "Finished: $END_TS"
log "PID: $PID"
