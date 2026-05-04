#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_FILE="${1:-$ROOT_DIR/logs/download_supervisor.log}"
INTERVAL_SEC="${INTERVAL_SEC:-60}"
OKX_PROGRESS_LOG="${OKX_PROGRESS_LOG:-}"
DRY_RUN="${DRY_RUN:-1}"

mkdir -p "$(dirname "$LOG_FILE")"

if [[ -z "$OKX_PROGRESS_LOG" ]]; then
  if [[ -f "$ROOT_DIR/logs/okx_download_all_1d.log" ]]; then
    OKX_PROGRESS_LOG="$ROOT_DIR/logs/okx_download_all_1d.log"
  else
    OKX_PROGRESS_LOG="$ROOT_DIR/logs/okx_all_1d_full.log"
  fi
fi

count_files() {
  local dir="$1"
  local name_glob="$2"
  find "$dir" -type f -name "$name_glob" 2>/dev/null | wc -l | tr -d ' '
}

last_match() {
  local file="$1"
  local regex="$2"
  if [[ -f "$file" ]]; then
    grep -E "$regex" "$file" | tail -n 1
  else
    echo ""
  fi
}

is_running() {
  local pattern="$1"
  if pgrep -f "$pattern" >/dev/null 2>&1; then
    echo 1
  else
    echo 0
  fi
}

{
  echo "===== supervisor start $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  echo "interval_sec=$INTERVAL_SEC"
} >> "$LOG_FILE"

if [[ "$DRY_RUN" == "1" ]]; then
  {
    echo "dry_run=1"
    echo "would watch Binance/OKX download processes and append supervisor progress; set DRY_RUN=0 to start polling"
    echo "===== supervisor dry-run done $(date -u +%Y-%m-%dT%H:%M:%SZ) ====="
  } >> "$LOG_FILE"
  cat "$LOG_FILE"
  exit 0
fi

while true; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  um_run="$(is_running "scripts/binance_public_download_klines.ts -- --source binance-all-usdt --market um --timeframe 1d --startMonth 2019-09 --outDir data/market/binance-public/um-all-usdt-1d")"
  spot_run="$(is_running "scripts/binance_public_download_klines.ts -- --source binance-all-usdt --market spot --timeframe 1d --startMonth 2017-08 --outDir data/market/binance-public/spot-all-usdt-1d")"
  okx_run="$(is_running "scripts/okx_download_ohlcv.ts -- --universe all --includeInactive true --timeframe 1d --start 2018-01-01")"

  um_zip="$(count_files "$ROOT_DIR/data/market/binance-public/um-all-usdt-1d" "*.zip")"
  spot_zip="$(count_files "$ROOT_DIR/data/market/binance-public/spot-all-usdt-1d" "*.zip")"
  okx_csv="$(count_files "$ROOT_DIR/data/market/okx" "*_1d.csv")"

  um_prog="$(last_match "$ROOT_DIR/logs/binance_um_all_usdt_1d.log" "progress .*\\/51168|done:|EXIT:")"
  spot_prog="$(last_match "$ROOT_DIR/logs/binance_spot_all_usdt_1d.log" "progress .*\\/66847|done:|EXIT:")"
  okx_prog="$(tail -n 1 "$OKX_PROGRESS_LOG" 2>/dev/null || true)"

  fs_line="$(df -h "$ROOT_DIR" | awk 'NR==2 {print $4 " free, " $5 " used"}')"

  {
    echo "[$ts] running um=$um_run spot=$spot_run okx=$okx_run | files um_zip=$um_zip spot_zip=$spot_zip okx_csv=$okx_csv | disk $fs_line"
    echo "  um:   ${um_prog:-n/a}"
    echo "  spot: ${spot_prog:-n/a}"
    echo "  okx_log: ${OKX_PROGRESS_LOG}"
    echo "  okx:  ${okx_prog:-n/a}"
  } >> "$LOG_FILE"

  if [[ "$um_run" == "0" && "$spot_run" == "0" && "$okx_run" == "0" ]]; then
    echo "===== supervisor done $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "$LOG_FILE"
    break
  fi

  sleep "$INTERVAL_SEC"
done
