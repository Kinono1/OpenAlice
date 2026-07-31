#!/usr/bin/env bash
set -euo pipefail

TASK="${1:-}"
if [[ -z "$TASK" ]]; then
  echo "usage: $0 <accumulate_live_data|accumulate_5m_data|accumulate_1s_data|live_data_freshness_audit|runtime_fee_auth_tick|prospective_evidence_tick|eth_carry_prospective_tick|continuous_improvement_loop|paper_pnl_diagnostics|paper_trade_cross_sectional|paper_trade_volume_breakout|refresh_market_intel_context>" >&2
  exit 64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCK_ROOT="$REPO_ROOT/data/runtime/locks"
LOCK_DIR="$LOCK_ROOT/cron_${TASK}.lock"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

export PATH="/Users/kino/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export OPENALICE_DATA_ROOT="${OPENALICE_DATA_ROOT:-$REPO_ROOT/data}"

mkdir -p "$LOCK_ROOT" "$REPO_ROOT/logs"

NOTIFICATION_PATH="$REPO_ROOT/data/runtime/cron_openalice_task/${TASK}_notification.json"
LOG_FILE="$REPO_ROOT/logs/cron_openalice_task_${TASK}.log"

if ! openalice_acquire_cron_lock "cron_openalice_task_${TASK}" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi
trap 'openalice_release_cron_lock "$LOCK_DIR"' EXIT

export OPENALICE_LLM_PROVIDER="${OPENALICE_LLM_PROVIDER:-anthropic}"
export OPENALICE_LLM_BASE_URL="${OPENALICE_LLM_BASE_URL:-https://newapis.xyz/v1}"
export OPENALICE_LLM_API_KEY_ENV="${OPENALICE_LLM_API_KEY_ENV:-NEWAPIS_API_KEY}"
export OPENALICE_LLM_REGULAR_MODEL="${OPENALICE_LLM_REGULAR_MODEL:-deepseek-v4-pro}"
export OPENALICE_LLM_EVENT_MODEL="${OPENALICE_LLM_EVENT_MODEL:-${OPENALICE_LLM_REGULAR_MODEL}}"
export OPENALICE_LLM_ANALYSIS_MODEL="${OPENALICE_LLM_ANALYSIS_MODEL:-deepseek-v4-pro}"
export OPENALICE_LLM_TTL_PROVIDER="${OPENALICE_LLM_TTL_PROVIDER:-anthropic}"
export OPENALICE_LLM_TTL_BASE_URL="${OPENALICE_LLM_TTL_BASE_URL:-https://newapis.xyz/v1}"
export OPENALICE_LLM_TTL_API_KEY_ENV="${OPENALICE_LLM_TTL_API_KEY_ENV:-NEWAPIS_API_KEY}"
export OPENALICE_LLM_TTL_MODEL="${OPENALICE_LLM_TTL_MODEL:-deepseek-v4-pro}"
export OPENALICE_LLM_CONTEXT_WINDOW_TOKENS="${OPENALICE_LLM_CONTEXT_WINDOW_TOKENS:-1000000}"
export OPENALICE_SKIP_SECOND_LEVEL="${OPENALICE_SKIP_SECOND_LEVEL:-true}"

cd "$REPO_ROOT"

run_pnpm() {
  if command -v corepack >/dev/null 2>&1; then
    corepack pnpm "$@"
    return
  fi

  local corepack_candidate
  for corepack_candidate in \
    /opt/homebrew/Cellar/node/*/bin/corepack \
    /usr/local/Cellar/node/*/bin/corepack \
    /opt/pkg/env/active/bin/corepack \
    /opt/pmk/env/global/bin/corepack; do
    if [[ -x "$corepack_candidate" ]]; then
      "$corepack_candidate" pnpm "$@"
      return
    fi
  done

  if command -v pnpm >/dev/null 2>&1; then
    pnpm "$@"
    return
  fi

  echo "corepack or pnpm is required for cron_openalice_task.sh but was not found in PATH or known Node install locations" >&2
  return 127
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start ${TASK}"
case "$TASK" in
  accumulate_live_data)
    run_pnpm data:accumulate
    ;;
  accumulate_5m_data)
    run_pnpm data:accumulate-5m
    ;;
  accumulate_1s_data)
    run_pnpm data:accumulate-1s
    ;;
  live_data_freshness_audit)
    run_pnpm data:freshness:audit
    ;;
  runtime_fee_auth_tick)
    run_pnpm fees:okx:auth-diagnose
    run_pnpm fees:runtime:snapshot
    run_pnpm research:okx:runtime-route-cost-budget
    run_pnpm research:okx:route-cost-slippage-readiness
    run_pnpm research:cross-sectional:route-cost:live-fwd72-median-filter
    run_pnpm research:liquidity-conditioned:live-factors
    run_pnpm research:candidates:summarize
    run_pnpm research:incubation-plan
    run_pnpm research:cross-sectional:prospective-lane:live-fwd72-median-filter
    run_pnpm status:reason-chain
    ;;
  prospective_evidence_tick)
    run_pnpm research:eth-carry:okx-snapshot
    run_pnpm research:okx:orderbook-spread-snapshot
    run_pnpm paper:execution-quality
    run_pnpm paper:execution-producer-contract
    run_pnpm paper:execution-future-telemetry-watchdog
    run_pnpm research:okx:runtime-route-cost-budget
    run_pnpm research:okx:route-cost-slippage-readiness
    run_pnpm research:eth-carry:pit-features
    run_pnpm data:features:eth-carry:materialize
    run_pnpm research:eth-carry:pit-audit
    run_pnpm research:liquidity-conditioned:prospective-observation:capture
    run_pnpm research:liquidity-conditioned:prospective-observation:settle
    run_pnpm research:liquidity-conditioned:prospective-evidence:status
    run_pnpm research:cross-sectional:prospective-observation:capture
    run_pnpm research:cross-sectional:prospective-observation:settle
    run_pnpm research:cross-sectional:prospective-evidence:status
    run_pnpm research:eth-carry:prospective-observation:settle
    run_pnpm research:eth-carry:prospective-observation:capture
    run_pnpm research:eth-carry:prospective-evidence:status
    run_pnpm research:eth-carry:signal-diagnostics
    run_pnpm research:eth-carry:data-gap-status
    run_pnpm research:eth-carry:prospective-watchdog
    run_pnpm research:eth-carry:evidence-status
    run_pnpm research:ai-scientist:crypto-intake
    run_pnpm research:ai-scientist:second-validation-queue
    run_pnpm research:ai-scientist:source-manifest
    run_pnpm research:ai-scientist:second-validation-readiness
    run_pnpm research:ai-scientist:pit-reproduction-plan
    run_pnpm research:ai-scientist:pit-input-dataset
    run_pnpm research:ai-scientist:pit-contract-status
    run_pnpm data:warehouse:manifest-index
    run_pnpm data:warehouse:normalized-index
    run_pnpm data:warehouse:catalog -- --allowBlockedExitZero true
    run_pnpm data:monitor
    run_pnpm research:strategy:defect-monitor
    run_pnpm research:strategy:defect-registry
    run_pnpm research:quant-framework:benchmark
    run_pnpm status:reason-chain
    ;;
  eth_carry_prospective_tick)
    run_pnpm research:eth-carry:prospective-tick
    ;;
  continuous_improvement_loop)
    run_pnpm improve:gated -- --mode observe --json true
    ;;
  paper_pnl_diagnostics)
    run_pnpm paper:pnl:diagnose
    ;;
  paper_trade_cross_sectional)
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" == "true" && "${OPENALICE_CRON_DIAGNOSTIC_MODE:-false}" != "true" ]]; then
      echo "ERROR: OPENALICE_ALLOW_UNGATED_PAPER_LANES requires OPENALICE_CRON_DIAGNOSTIC_MODE=true" >&2
      exit 78
    fi
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
      run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 true --dryRun false
    else
      run_pnpm paper:cross-sectional -- --dataMode live_only --skipSecondLevel true --requirePromotionV2 false --dryRun false
    fi
    ;;
  paper_trade_volume_breakout)
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" == "true" && "${OPENALICE_CRON_DIAGNOSTIC_MODE:-false}" != "true" ]]; then
      echo "ERROR: OPENALICE_ALLOW_UNGATED_PAPER_LANES requires OPENALICE_CRON_DIAGNOSTIC_MODE=true" >&2
      exit 78
    fi
    if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] skip ${TASK}: paper:volume-breakout is not promotion-v2 gated"
      exit 0
    fi
    run_pnpm paper:volume-breakout -- --allowUngatedPaperLane true
    ;;
  refresh_market_intel_context)
    run_pnpm market:intel:refresh -- --dryRun false
    ;;
  cp_intake|crypto_dl_predict)
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] archived_manual_only ${TASK}: automatic execution entry is retired" >&2
    exit 78
    ;;
  *)
    echo "unknown task: ${TASK}" >&2
    exit 64
    ;;
esac
