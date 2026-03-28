#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="${SESSION_NAME:-okx_core7_trades}"
DATASET_ROOT="${DATASET_ROOT:-data/market/okx_core7_trades}"
SYMBOLS_FILE="${SYMBOLS_FILE:-data/market/okx_1m_core7/symbols_14.txt}"
START_DATE="${START_DATE:-2025-01-01}"
END_DATE="${END_DATE:-2026-03-08}"
WORKERS="${WORKERS:-2}"
SLEEP_MS="${SLEEP_MS:-200}"
LIMIT="${LIMIT:-100}"
INACTIVITY_TIMEOUT_SECONDS="${INACTIVITY_TIMEOUT_SECONDS:-1800}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_trades.log}"
PYTHON_BIN="${PYTHON_BIN:-/opt/miniconda3/bin/python}"
LOAD_ENV="${LOAD_ENV:-1}"

if [[ "$LOAD_ENV" == "1" ]] && [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
elif [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/.local/share/pnpm/pnpm"
elif [[ -x "$HOME/Library/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/Library/pnpm/pnpm"
elif compgen -G "$HOME/.nvm/versions/node/*/bin/pnpm" >/dev/null; then
  PNPM_BIN="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/pnpm | sort -V | tail -n 1)"
else
  echo "pnpm not found in PATH." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")" "$DATASET_ROOT/state" "$DATASET_ROOT/reports"
RUNNER="/tmp/${SESSION_NAME}.runner.sh"
cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
export NODE_USE_ENV_PROXY=1
$(if [[ -n "${http_proxy:-}" ]]; then printf 'export http_proxy=%q\n' "$http_proxy"; fi)
$(if [[ -n "${https_proxy:-}" ]]; then printf 'export https_proxy=%q\n' "$https_proxy"; fi)
$(if [[ -n "${ALL_PROXY:-${all_proxy:-}}" ]]; then printf 'export ALL_PROXY=%q\n' "${ALL_PROXY:-${all_proxy:-}}"; fi)
SYMS="\$(paste -sd, "$SYMBOLS_FILE")"
STATE_PATH="$DATASET_ROOT/state/trades.state.v1.json"

newest_mtime() {
  local out=0
  if [[ -f "$ROOT_DIR/$LOG_FILE" ]]; then
    out=\$(stat -f %m "$ROOT_DIR/$LOG_FILE")
  fi
  if [[ -f "\$STATE_PATH" ]]; then
    local state_mtime
    state_mtime=\$(stat -f %m "\$STATE_PATH")
    if (( state_mtime > out )); then
      out=\$state_mtime
    fi
  fi
  echo "\$out"
}

wait_with_watchdog() {
  local child_pid="\$1"
  local last_seen
  last_seen=\$(date +%s)
  while kill -0 "\$child_pid" 2>/dev/null; do
    sleep 30
    local newest
    newest=\$(newest_mtime)
    if (( newest > last_seen )); then
      last_seen=\$newest
      continue
    fi
    local now
    now=\$(date +%s)
    if (( now - last_seen >= $INACTIVITY_TIMEOUT_SECONDS )); then
      echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] WATCHDOG okx_core7_trades no state/log progress for ${INACTIVITY_TIMEOUT_SECONDS}s; killing pid=\$child_pid"
      kill "\$child_pid" 2>/dev/null || true
      wait "\$child_pid" 2>/dev/null || true
      return 124
    fi
  done
  wait "\$child_pid"
}

attempt=1
while true; do
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] START okx_core7_trades attempt=\$attempt"
  "$PNPM_BIN" tsx scripts/okx_download_trades.ts \
    --datasetRoot "$DATASET_ROOT" \
    --symbols "\$SYMS" \
    --start "$START_DATE" \
    --end "$END_DATE" \
    --workers "$WORKERS" \
    --sleepMs "$SLEEP_MS" \
    --limit "$LIMIT" \
    --statePath "\$STATE_PATH" \
    --summaryPath "$DATASET_ROOT/reports/trades_summary.v1.json" \
    --reportDir "$DATASET_ROOT/reports" &
  child_pid=\$!
  if wait_with_watchdog "\$child_pid"; then
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] DONE okx_core7_trades"
    break
  fi
  echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] RETRY okx_core7_trades after failure"
  attempt=\$((attempt + 1))
  sleep 60
done
EOF
chmod +x "$RUNNER"

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
tmux new-session -d -s "$SESSION_NAME" "/bin/bash -lc '$RUNNER 2>&1 | tee $ROOT_DIR/$LOG_FILE'"
sleep 2
echo "session=$SESSION_NAME"
echo "log=$ROOT_DIR/$LOG_FILE"
tmux capture-pane -pt "$SESSION_NAME" -S -20
