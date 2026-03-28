#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="${SESSION_NAME:-okx_core7_trades_batches}"
DATASET_ROOT="${DATASET_ROOT:-data/market/okx_core7_trades}"
START_DATE="${START_DATE:-2025-01-01}"
END_DATE="${END_DATE:-2026-03-08}"
WORKERS="${WORKERS:-1}"
SLEEP_MS="${SLEEP_MS:-350}"
LIMIT="${LIMIT:-100}"
INACTIVITY_TIMEOUT_SECONDS="${INACTIVITY_TIMEOUT_SECONDS:-1800}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_trades_batches.log}"
LOAD_ENV="${LOAD_ENV:-1}"
DRY_RUN="${DRY_RUN:-0}"

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

mkdir -p "$(dirname "$LOG_FILE")" "$DATASET_ROOT/state" "$DATASET_ROOT/reports" "$DATASET_ROOT/state/batches"

RUNNER="/tmp/${SESSION_NAME}.runner.sh"
cat > "$RUNNER" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
export NODE_USE_ENV_PROXY=1
$(if [[ -n "${http_proxy:-}" ]]; then printf 'export http_proxy=%q\n' "$http_proxy"; fi)
$(if [[ -n "${https_proxy:-}" ]]; then printf 'export https_proxy=%q\n' "$https_proxy"; fi)
$(if [[ -n "${ALL_PROXY:-${all_proxy:-}}" ]]; then printf 'export ALL_PROXY=%q\n' "${ALL_PROXY:-${all_proxy:-}}"; fi)

run_batch() {
  local batch_name="\$1"
  local symbols_csv="\$2"
  local state_path="$DATASET_ROOT/state/batches/\${batch_name}.state.v1.json"
  local attempt=1

  newest_mtime() {
    local out=0
    if [[ -f "$ROOT_DIR/$LOG_FILE" ]]; then
      out=\$(stat -f %m "$ROOT_DIR/$LOG_FILE")
    fi
    if [[ -f "\$state_path" ]]; then
      local state_mtime
      state_mtime=\$(stat -f %m "\$state_path")
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
        echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] WATCHDOG \${batch_name} no state/log progress for ${INACTIVITY_TIMEOUT_SECONDS}s; killing pid=\$child_pid"
        kill "\$child_pid" 2>/dev/null || true
        wait "\$child_pid" 2>/dev/null || true
        return 124
      fi
    done
    wait "\$child_pid"
  }

  while true; do
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] START \${batch_name} attempt=\${attempt} symbols=\${symbols_csv}"
    "$PNPM_BIN" tsx scripts/okx_download_trades.ts \\
      --datasetRoot "$DATASET_ROOT" \\
      --symbols "\$symbols_csv" \\
      --start "$START_DATE" \\
      --end "$END_DATE" \\
      --workers "$WORKERS" \\
      --sleepMs "$SLEEP_MS" \\
      --limit "$LIMIT" \\
      --statePath "\$state_path" \\
      --summaryPath "$DATASET_ROOT/reports/\${batch_name}.summary.v1.json" \\
      --reportDir "$DATASET_ROOT/reports" &
    local child_pid=\$!
    if wait_with_watchdog "\$child_pid"; then
      echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] DONE \${batch_name}"
      break
    fi
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] RETRY \${batch_name} after failure"
    attempt=\$((attempt + 1))
    sleep 60
  done
}

run_batch batch01_btc "BTC-USDT,BTC-USDT-SWAP"
run_batch batch02_eth "ETH-USDT,ETH-USDT-SWAP"
run_batch batch03_xrp_sol "XRP-USDT,XRP-USDT-SWAP,SOL-USDT,SOL-USDT-SWAP"
run_batch batch04_ada_doge "ADA-USDT,ADA-USDT-SWAP,DOGE-USDT,DOGE-USDT-SWAP"
run_batch batch05_bnb "BNB-USDT,BNB-USDT-SWAP"

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] ALL_DONE okx_core7_trades_batches"
EOF
chmod +x "$RUNNER"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "runner=$RUNNER"
  sed -n '1,220p' "$RUNNER"
  exit 0
fi

tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true
tmux new-session -d -s "$SESSION_NAME" "/bin/bash -lc '$RUNNER 2>&1 | tee $ROOT_DIR/$LOG_FILE'"
sleep 2
echo "session=$SESSION_NAME"
echo "log=$ROOT_DIR/$LOG_FILE"
tmux capture-pane -pt "$SESSION_NAME" -S -20
