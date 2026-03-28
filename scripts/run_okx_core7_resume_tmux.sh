#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage:
  bash scripts/run_okx_core7_resume_tmux.sh

Environment overrides:
  SESSION_NAME=okx_core7_full
  RESTART_SESSION=0|1         default 1
  DATASET_ROOT=data/market/okx_1m_core7
  LOG_FILE=logs/okx_core7_tmux.log

This script:
1. Detects which OKX core7 symbols are already complete from local shards.
2. Builds resume state only for the remaining symbols in each cohort.
3. Starts/refreshes a tmux session that runs the remaining OKX core7 pipeline.
3. Leaves logs under LOG_FILE for monitoring.
EOF
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SESSION_NAME="${SESSION_NAME:-okx_core7_full}"
RESTART_SESSION="${RESTART_SESSION:-1}"
DATASET_ROOT="${DATASET_ROOT:-data/market/okx_1m_core7}"
LOG_FILE="${LOG_FILE:-logs/okx_core7_tmux.log}"
LOAD_ENV="${LOAD_ENV:-1}"

if [[ "$LOAD_ENV" == "1" ]] && [[ -f ".env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not found in PATH." >&2
  exit 1
fi

if command -v pnpm >/dev/null 2>&1; then
  PNPM_BIN="$(command -v pnpm)"
elif [[ -x "$HOME/.local/share/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/.local/share/pnpm/pnpm"
elif [[ -x "$HOME/Library/pnpm/pnpm" ]]; then
  PNPM_BIN="$HOME/Library/pnpm/pnpm"
elif [[ -x "$HOME/.volta/bin/pnpm" ]]; then
  PNPM_BIN="$HOME/.volta/bin/pnpm"
elif compgen -G "$HOME/.nvm/versions/node/*/bin/pnpm" >/dev/null; then
  PNPM_BIN="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin/pnpm | sort -V | tail -n 1)"
else
  echo "pnpm not found in PATH." >&2
  exit 1
fi

mkdir -p "$(dirname "$LOG_FILE")" "$DATASET_ROOT/state" "$DATASET_ROOT/reports/validation"
RUNNER_PATH="/tmp/${SESSION_NAME}.runner.sh"
cat > "$RUNNER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$ROOT_DIR"
export NODE_USE_ENV_PROXY=1
$(if [[ -n "${http_proxy:-}" ]]; then printf 'export http_proxy=%q\n' "$http_proxy"; fi)
$(if [[ -n "${https_proxy:-}" ]]; then printf 'export https_proxy=%q\n' "$https_proxy"; fi)
$(if [[ -n "${ALL_PROXY:-${all_proxy:-}}" ]]; then printf 'export ALL_PROXY=%q\n' "${ALL_PROXY:-${all_proxy:-}}"; fi)

END_MONTH="2026-03"

symbol_market() {
  local symbol="\$1"
  if [[ "\$symbol" == *-SWAP ]]; then
    printf 'swap\n'
  else
    printf 'spot\n'
  fi
}

is_symbol_complete() {
  local symbol="\$1"
  local start_month="\$2"
  local market
  market="\$(symbol_market "\$symbol")"
  local symbol_dir="$DATASET_ROOT/candles/1m/\$market/\$symbol"
  if [[ ! -d "\$symbol_dir" ]]; then
    return 1
  fi
  local first_file
  first_file="\$(find "\$symbol_dir" -maxdepth 1 -type f \\( -name '*.csv' -o -name '*.csv.zst' \\) | sort | head -n 1)"
  local end_file
  end_file="\$(find "\$symbol_dir" -maxdepth 1 -type f \\( -name "\${END_MONTH}.csv" -o -name "\${END_MONTH}.csv.zst" \\) | head -n 1)"
  if [[ -z "\$first_file" || -z "\$end_file" ]]; then
    return 1
  fi
  local first_name first_month
  first_name="\$(basename "\$first_file")"
  first_month="\${first_name%%.csv*}"
  [[ "\$first_month" < "\$start_month" || "\$first_month" == "\$start_month" ]]
}

build_pending_symbols_file() {
  local src_symbols_file="\$1"
  local start_month="\$2"
  local out_symbols_file="\$3"
  : > "\$out_symbols_file"
  while IFS= read -r symbol; do
    [[ -z "\$symbol" ]] && continue
    if is_symbol_complete "\$symbol" "\$start_month"; then
      continue
    fi
    printf '%s\n' "\$symbol" >> "\$out_symbols_file"
  done < "\$src_symbols_file"
}

run_okx_if_needed() {
  local tag="\$1"
  local start_date="\$2"
  local source_symbols_file="\$3"
  local workers="\$4"
  local sleep_ms="\$5"
  local state_path="\$6"
  local start_month="\${start_date:0:7}"
  local pending_symbols_file="$DATASET_ROOT/state/\${tag}.pending_symbols.txt"
  build_pending_symbols_file "\$source_symbols_file" "\$start_month" "\$pending_symbols_file"
  if [[ ! -s "\$pending_symbols_file" ]]; then
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] SKIP \${tag} all symbols already complete"
    return 0
  fi
  python3 scripts/build_okx_resume_state.py \\
    --dataset-root "$DATASET_ROOT" \\
    --symbols-file "\$pending_symbols_file" \\
    --timeframe 1m \\
    --output "\$state_path"
  local attempt=1
  local symbols_csv
  symbols_csv="\$(paste -sd, "\$pending_symbols_file")"
  while true; do
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] START \${tag} attempt=\${attempt} start=\${start_date} workers=\${workers} sleep=\${sleep_ms}"
    if "$PNPM_BIN" tsx scripts/okx_download_candles_historical.ts \\
      --datasetRoot "$DATASET_ROOT" \\
      --symbols "\$symbols_csv" \\
      --timeframes 1m \\
      --workers "\$workers" \\
      --append true \\
      --maxRetries 8 \\
      --sleepMs "\$sleep_ms" \\
      --start "\$start_date" \\
      --end 2026-03-08 \\
      --statePath "\$state_path" \\
      --summaryPath "$DATASET_ROOT/reports/\${tag}.summary.v1.json" \\
      --reportDir "$DATASET_ROOT/reports/\${tag}"
    then
      echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] DONE \${tag}"
      break
    fi
    echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] RETRY \${tag} after failure"
    attempt=\$((attempt + 1))
    sleep 60
  done
}

run_okx_if_needed cohort_01 2019-11-01 "$DATASET_ROOT/cohort_01.txt" 2 350 "$DATASET_ROOT/state/candles.cohort_01.resume2.state.v1.json"
run_okx_if_needed cohort_02 2020-02-01 "$DATASET_ROOT/cohort_02.txt" 1 500 "$DATASET_ROOT/state/candles.cohort_02.state.v1.json"
run_okx_if_needed cohort_03 2021-01-01 "$DATASET_ROOT/cohort_03.txt" 2 500 "$DATASET_ROOT/state/candles.cohort_03.state.v1.json"
run_okx_if_needed cohort_04 2022-12-01 "$DATASET_ROOT/cohort_04.txt" 1 450 "$DATASET_ROOT/state/candles.cohort_04.state.v1.json"

SYMS="\$(paste -sd, "$DATASET_ROOT/symbols_14.txt")"
python3 scripts/check_and_dedup_risk_symbols.py \\
  --dataset-root "$DATASET_ROOT" \\
  --symbols "\$SYMS" \\
  --timeframes 1m \\
  --apply true \\
  --output "$DATASET_ROOT/reports/validation/dedup_report.v1.json"

python3 scripts/verify_okx_candles_completion.py \\
  --dataset-root "$DATASET_ROOT" \\
  --symbols-file "$DATASET_ROOT/symbols_14.txt" \\
  --timeframes 1m \\
  --end-date 2026-03-08 \\
  --output "$DATASET_ROOT/reports/validation/validation.v1.json"

echo "[\$(date -u +%Y-%m-%dT%H:%M:%SZ)] ALL_DONE"
EOF
chmod +x "$RUNNER_PATH"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  if [[ "$RESTART_SESSION" != "1" ]]; then
    echo "tmux session '$SESSION_NAME' already exists. Set RESTART_SESSION=1 to restart." >&2
    exit 1
  fi
  tmux kill-session -t "$SESSION_NAME"
fi

tmux new-session -d -s "$SESSION_NAME" "/bin/bash -lc '$RUNNER_PATH 2>&1 | tee $ROOT_DIR/$LOG_FILE'"
sleep 2
echo "session=$SESSION_NAME"
echo "log=$ROOT_DIR/$LOG_FILE"
tmux capture-pane -pt "$SESSION_NAME" -S -20
