#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DATA_ROOT="${OPENALICE_DATA_ROOT:-/Volumes/shield/cryptoData/openalice-data}"
OUT_ROOT="$DATA_ROOT/market/binance-public"
TSX="node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs"
RUNNER="scripts/run_fast_binance_data_vision_dataset.ts"

CONCURRENCY="${BINANCE_BACKFILL_CONCURRENCY:-96}"
RETRY_CONCURRENCY="${BINANCE_BACKFILL_RETRY_CONCURRENCY:-60}"
LIST_CONCURRENCY="${BINANCE_BACKFILL_LIST_CONCURRENCY:-8}"
MAX_RETRIES="${BINANCE_BACKFILL_MAX_RETRIES:-12}"
RETRY_MAX_RETRIES="${BINANCE_BACKFILL_RETRY_MAX_RETRIES:-12}"
RETRY_ROUNDS="${BINANCE_BACKFILL_RETRY_ROUNDS:-2}"
CONNECT_TIMEOUT_SEC="${BINANCE_BACKFILL_CONNECT_TIMEOUT_SEC:-10}"
LIST_MAX_TIME_SEC="${BINANCE_BACKFILL_LIST_MAX_TIME_SEC:-120}"
DOWNLOAD_MAX_TIME_SEC="${BINANCE_BACKFILL_DOWNLOAD_MAX_TIME_SEC:-180}"
DISCOVERY="${BINANCE_BACKFILL_DISCOVERY:-s3}"
SYMBOL_SOURCE_DIR="${BINANCE_BACKFILL_SYMBOL_SOURCE_DIR:-}"

PROXY_URL="none"
if [[ "${BINANCE_BACKFILL_ALLOW_PROXY:-0}" == "1" ]]; then
  PROXY_URL="${BINANCE_BACKFILL_PROXY_URL:-none}"
fi
NETWORK_INTERFACE="${BINANCE_BACKFILL_INTERFACE:-en0}"
ALLOW_SYSTEM_PROXY="${BINANCE_BACKFILL_ALLOW_SYSTEM_PROXY:-0}"

system_proxy_enabled() {
  if ! command -v scutil >/dev/null 2>&1; then
    return 1
  fi
  scutil --proxy 2>/dev/null | grep -Eq 'HTTPEnable : 1|HTTPSEnable : 1|SOCKSEnable : 1'
}

if [[ "$ALLOW_SYSTEM_PROXY" != "1" ]] && system_proxy_enabled; then
  echo "refusing to start Binance backfill because macOS system proxy is enabled" >&2
  echo "disable the system proxy/VPN proxy first, or set BINANCE_BACKFILL_ALLOW_SYSTEM_PROXY=1 intentionally" >&2
  exit 4
fi

run_dataset() {
  local market="$1"
  local data_type="$2"
  local start_month="$3"
  local out_dir="$4"
  local timeframe="${5:-}"

  local args=(
    "$RUNNER"
    --market "$market"
    --dataType "$data_type"
    --quote USDT
    --startMonth "$start_month"
    --outDir "$out_dir"
    --listConcurrency "$LIST_CONCURRENCY"
    --concurrency "$CONCURRENCY"
    --retryConcurrency "$RETRY_CONCURRENCY"
    --maxRetries "$MAX_RETRIES"
    --retryMaxRetries "$RETRY_MAX_RETRIES"
    --connectTimeoutSec "$CONNECT_TIMEOUT_SEC"
    --listMaxTimeSec "$LIST_MAX_TIME_SEC"
    --downloadMaxTimeSec "$DOWNLOAD_MAX_TIME_SEC"
    --retryRounds "$RETRY_ROUNDS"
    --proxy "$PROXY_URL"
    --interface "$NETWORK_INTERFACE"
    --discovery "$DISCOVERY"
  )

  if [[ -n "$SYMBOL_SOURCE_DIR" ]]; then
    args+=(--symbolSourceDir "$SYMBOL_SOURCE_DIR")
  fi

  if [[ -n "$timeframe" ]]; then
    args+=(--timeframe "$timeframe")
  fi

  echo "===== managed binance dataset start market=$market dataType=$data_type timeframe=${timeframe:-none} proxy=$PROXY_URL interface=$NETWORK_INTERFACE discovery=$DISCOVERY outDir=$out_dir $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node "$TSX" "${args[@]}"
  echo "===== managed binance dataset end market=$market dataType=$data_type timeframe=${timeframe:-none} proxy=$PROXY_URL interface=$NETWORK_INTERFACE discovery=$DISCOVERY outDir=$out_dir $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
}

run_audit() {
  env -u http_proxy -u https_proxy -u all_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY node "$TSX" \
    scripts/audit_fast_binance_data_vision_downloads.ts \
    --root "$OUT_ROOT" \
    --jsonOut data/runtime/binance_public_download_audit.latest.json
}

mkdir -p "$OUT_ROOT" data/runtime

echo "full Binance Data Vision backfill started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "root: $OUT_ROOT"
echo "concurrency: download=$CONCURRENCY retry=$RETRY_CONCURRENCY list=$LIST_CONCURRENCY retryRounds=$RETRY_ROUNDS discovery=$DISCOVERY"

run_audit || true

KLINE_INTERVALS=(1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 3d 1w 1mo)
for tf in "${KLINE_INTERVALS[@]}"; do
  run_dataset spot klines 2017-08 "$OUT_ROOT/spot-all-usdt-klines-$tf" "$tf"
  run_dataset um klines 2019-09 "$OUT_ROOT/um-all-usdt-klines-$tf" "$tf"
  run_audit || true
done

for data_type in aggTrades trades; do
  run_dataset spot "$data_type" 2017-08 "$OUT_ROOT/spot-all-usdt-$data_type"
  run_dataset um "$data_type" 2019-09 "$OUT_ROOT/um-all-usdt-$data_type"
  run_audit || true
done

for data_type in fundingRate bookTicker; do
  run_dataset um "$data_type" 2019-09 "$OUT_ROOT/um-all-usdt-$data_type"
  run_audit || true
done

for data_type in markPriceKlines indexPriceKlines premiumIndexKlines; do
  for tf in "${KLINE_INTERVALS[@]}"; do
    run_dataset um "$data_type" 2019-09 "$OUT_ROOT/um-all-usdt-$data_type-$tf" "$tf"
    run_audit || true
  done
done

run_audit
echo "full Binance Data Vision backfill finished $(date -u +%Y-%m-%dT%H:%M:%SZ)"
