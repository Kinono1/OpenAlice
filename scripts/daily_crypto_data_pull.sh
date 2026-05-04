#!/usr/bin/env bash
set -euo pipefail

# Daily crypto data pull (default: Binance UM 1d).
# Intended for cron usage with offline catch-up:
# - Tracks last successful month range in a state file.
# - On next run, auto-backfills missing months up to target end month.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
mkdir -p "$LOG_DIR"

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
elif [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/.local/share/pnpm/pnpm"
else
  echo "daily_crypto_data_pull: pnpm not found in PATH" >&2
  exit 1
fi

month_to_number() {
  local month="$1"
  local y="${month%-*}"
  local m="${month#*-}"
  echo $((10#$y * 12 + 10#$m - 1))
}

month_add_one() {
  local month="$1"
  local y="${month%-*}"
  local m="${month#*-}"
  m=$((10#$m + 1))
  if ((m > 12)); then
    y=$((10#$y + 1))
    m=1
  fi
  printf "%04d-%02d" "$y" "$m"
}

month_gt() {
  local a="$1"
  local b="$2"
  (( "$(month_to_number "$a")" > "$(month_to_number "$b")" ))
}

is_valid_month() {
  local month="$1"
  [[ "$month" =~ ^[0-9]{4}-[0-9]{2}$ ]]
}

current_month_utc() {
  date -u +%Y-%m
}

previous_month_utc() {
  local y
  local m
  y="$(date -u +%Y)"
  m="$(date -u +%m)"
  m=$((10#$m - 1))
  if ((m < 1)); then
    y=$((10#$y - 1))
    m=12
  fi
  printf "%04d-%02d" "$y" "$m"
}

extract_json_month_field() {
  local file_path="$1"
  local field="$2"
  if [[ ! -f "$file_path" ]]; then
    return 0
  fi
  local value
  value="$(sed -nE "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"([0-9]{4}-[0-9]{2})\".*/\1/p" "$file_path" | head -n 1)"
  if [[ -n "$value" ]]; then
    echo "$value"
  fi
}

MARKET="${MARKET:-um}"
SOURCE="${SOURCE:-binance-all-usdt}"
TIMEFRAME="${TIMEFRAME:-1d}"
OUT_DIR="${OUT_DIR:-data/market/binance-public/um-all-usdt-1d}"
CONCURRENCY="${CONCURRENCY:-4}"
MAX_RETRIES="${MAX_RETRIES:-3}"
SLEEP_MS="${SLEEP_MS:-30}"
SKIP_EXISTING="${SKIP_EXISTING:-true}"
END_MONTH_MODE="${END_MONTH_MODE:-prev}" # prev | current
BOOTSTRAP_START_MONTH="${BOOTSTRAP_START_MONTH:-}"
START_MONTH_OVERRIDE="${START_MONTH:-}"
END_MONTH_OVERRIDE="${END_MONTH:-}"
STATE_FILE="${STATE_FILE:-data/runtime/daily_crypto_pull_state.json}"

if [[ "$END_MONTH_MODE" == "current" ]]; then
  TARGET_END_MONTH="$(current_month_utc)"
else
  TARGET_END_MONTH="$(previous_month_utc)"
fi

if [[ -n "$END_MONTH_OVERRIDE" ]]; then
  if ! is_valid_month "$END_MONTH_OVERRIDE"; then
    echo "daily_crypto_data_pull: invalid END_MONTH '$END_MONTH_OVERRIDE' (expected YYYY-MM)" >&2
    exit 1
  fi
  TARGET_END_MONTH="$END_MONTH_OVERRIDE"
fi

if ! is_valid_month "$TARGET_END_MONTH"; then
  echo "daily_crypto_data_pull: computed invalid target end month '$TARGET_END_MONTH'" >&2
  exit 1
fi

LAST_STATE_END_MONTH="$(extract_json_month_field "$STATE_FILE" "last_successful_end_month" || true)"
LAST_END_MONTH="${LAST_STATE_END_MONTH:-}"

if [[ -n "$START_MONTH_OVERRIDE" ]]; then
  if ! is_valid_month "$START_MONTH_OVERRIDE"; then
    echo "daily_crypto_data_pull: invalid START_MONTH '$START_MONTH_OVERRIDE' (expected YYYY-MM)" >&2
    exit 1
  fi
  TARGET_START_MONTH="$START_MONTH_OVERRIDE"
elif [[ -n "$LAST_END_MONTH" ]]; then
  TARGET_START_MONTH="$(month_add_one "$LAST_END_MONTH")"
elif [[ -n "$BOOTSTRAP_START_MONTH" ]]; then
  if ! is_valid_month "$BOOTSTRAP_START_MONTH"; then
    echo "daily_crypto_data_pull: invalid BOOTSTRAP_START_MONTH '$BOOTSTRAP_START_MONTH' (expected YYYY-MM)" >&2
    exit 1
  fi
  TARGET_START_MONTH="$BOOTSTRAP_START_MONTH"
else
  TARGET_START_MONTH="$TARGET_END_MONTH"
fi

if ! is_valid_month "$TARGET_START_MONTH"; then
  echo "daily_crypto_data_pull: computed invalid target start month '$TARGET_START_MONTH'" >&2
  exit 1
fi

if month_gt "$TARGET_START_MONTH" "$TARGET_END_MONTH"; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_crypto_data_pull no-op"
  echo "reason: start month $TARGET_START_MONTH is after end month $TARGET_END_MONTH (already caught up)"
  exit 0
fi

CMD=(
  "$PNPM_BIN" data:download:binance -- --source "$SOURCE"
  --market "$MARKET"
  --timeframe "$TIMEFRAME"
  --startMonth "$TARGET_START_MONTH"
  --endMonth "$TARGET_END_MONTH"
  --outDir "$OUT_DIR"
  --concurrency "$CONCURRENCY"
  --maxRetries "$MAX_RETRIES"
  --sleepMs "$SLEEP_MS"
  --skipExisting "$SKIP_EXISTING"
)

if [[ "${MAX_SYMBOLS:-}" != "" ]]; then
  CMD+=(--maxSymbols "$MAX_SYMBOLS")
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_crypto_data_pull start"
echo "range: $TARGET_START_MONTH -> $TARGET_END_MONTH"
echo "state_file: $STATE_FILE"
echo "command: ${CMD[*]}"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 -> command not executed"
  exit 0
fi

"${CMD[@]}"

mkdir -p "$(dirname "$STATE_FILE")"
cat > "$STATE_FILE" <<EOF
{
  "updated_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "last_successful_start_month": "$TARGET_START_MONTH",
  "last_successful_end_month": "$TARGET_END_MONTH",
  "market": "$MARKET",
  "source": "$SOURCE",
  "timeframe": "$TIMEFRAME",
  "out_dir": "$OUT_DIR"
}
EOF

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] daily_crypto_data_pull done"
