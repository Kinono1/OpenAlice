#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"
if [[ -z "$TASK" ]]; then
  echo "usage: $0 <accumulate_live_data|accumulate_5m_data|continuous_improvement_loop|paper_pnl_diagnostics|paper_trade_cross_sectional|paper_trade_volume_breakout|refresh_market_intel_context>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_ROOT="$REPO_ROOT/data/runtime/locks"
LOCK_DIR="$LOCK_ROOT/cron_${TASK}.lock"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

export PATH="/Users/kino/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

mkdir -p "$LOCK_ROOT" "$REPO_ROOT/logs"

NOTIFICATION_PATH="$REPO_ROOT/data/runtime/cron_openalice_task/${TASK}_notification.json"
LOG_FILE="$REPO_ROOT/logs/cron_openalice_task_${TASK}.log"

if ! openalice_acquire_cron_lock "cron_openalice_task_${TASK}" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi
trap 'openalice_release_cron_lock "$LOCK_DIR"' EXIT

export OPENALICE_LLM_PROVIDER="${OPENALICE_LLM_PROVIDER:-openai-compatible}"
export OPENALICE_DEEPSEEK_BASE_URL="${OPENALICE_DEEPSEEK_BASE_URL:-https://api.deepseek.com/v1}"
export OPENALICE_LLM_REGULAR_MODEL="${OPENALICE_LLM_REGULAR_MODEL:-deepseek-v4-flash}"
export OPENALICE_LLM_EVENT_MODEL="${OPENALICE_LLM_EVENT_MODEL:-${OPENALICE_LLM_REGULAR_MODEL}}"
export OPENALICE_LLM_ANALYSIS_MODEL="${OPENALICE_LLM_ANALYSIS_MODEL:-deepseek-v4-pro}"
export OPENALICE_LLM_TTL_PROVIDER="${OPENALICE_LLM_TTL_PROVIDER:-openai-compatible}"
export OPENALICE_LLM_TTL_MODEL="${OPENALICE_LLM_TTL_MODEL:-deepseek-v4-flash}"
export OPENALICE_LLM_CONTEXT_WINDOW_TOKENS="${OPENALICE_LLM_CONTEXT_WINDOW_TOKENS:-1000000}"
export OPENALICE_SKIP_SECOND_LEVEL="${OPENALICE_SKIP_SECOND_LEVEL:-true}"

cd "$REPO_ROOT"

run_pnpm() {
  corepack pnpm "$@"
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start ${TASK}"
case "$TASK" in
  accumulate_live_data)
    run_pnpm data:accumulate
    ;;
  accumulate_5m_data)
    run_pnpm data:accumulate-5m
    ;;
  continuous_improvement_loop)
    run_pnpm improve:loop
    ;;
  paper_pnl_diagnostics)
    run_pnpm paper:pnl:diagnose
    ;;
  paper_trade_cross_sectional)
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
      run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 true
    else
      run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 false
    fi
    ;;
  paper_trade_volume_breakout)
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] skip ${TASK}: paper:volume-breakout is not promotion-v2 gated"
      exit 0
    fi
    run_pnpm paper:volume-breakout -- --allowUngatedPaperLane true
    ;;
  refresh_market_intel_context)
    run_pnpm market:intel:refresh
    ;;
  cp_intake)
    run_pnpm cp:intake
    ;;
  *)
    echo "unknown task: ${TASK}" >&2
    exit 64
    ;;
esac
