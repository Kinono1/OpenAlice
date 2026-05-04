#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="${REPO_ROOT:-${DEFAULT_REPO_ROOT}}"
PYTHON_BIN="${PYTHON_BIN:-${REPO_ROOT}/.venv/bin/python}"
SEARCH_ROOT="${SEARCH_ROOT:-data/training-data/cvar-search-live}"
EXPERIMENT_ROOT="${EXPERIMENT_ROOT:-data/training-data/cvar-next}"
EXPERIMENT_PREFIX="${EXPERIMENT_PREFIX:-cvar24-autosearch-live}"
MATRIX_SEEDS="${MATRIX_SEEDS:-7,13,42,87}"
RUNNER_SLEEP_SECONDS="${RUNNER_SLEEP_SECONDS:-3}"
CHECK_INTERVAL_SECONDS="${CHECK_INTERVAL_SECONDS:-45}"
RESTART_BACKOFF_SECONDS="${RESTART_BACKOFF_SECONDS:-15}"
LOG_DIR="${LOG_DIR:-logs/research}"
DRY_RUN="${DRY_RUN:-1}"

mkdir -p "${REPO_ROOT}/${LOG_DIR}"
LOG_FILE="${REPO_ROOT}/${LOG_DIR}/strategy-search-guard.log"

if [[ ! -d "${REPO_ROOT}/scripts" ]]; then
  echo "strategy_search_guard: invalid repo root '${REPO_ROOT}'" >&2
  exit 1
fi

RUNNER_PATTERN="continuous_strategy_search.py --repo-root ${REPO_ROOT} --search-root ${SEARCH_ROOT}"

ts() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

echo "[$(ts)] guard start repo=${REPO_ROOT} search_root=${SEARCH_ROOT}" | tee -a "${LOG_FILE}"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "[$(ts)] dry-run: continuous search guard would monitor and restart ${RUNNER_PATTERN}; set DRY_RUN=0 to start the loop" | tee -a "${LOG_FILE}"
  exit 0
fi

while true; do
  if pgrep -f "${RUNNER_PATTERN}" >/dev/null 2>&1; then
    echo "[$(ts)] runner active; next check in ${CHECK_INTERVAL_SECONDS}s" | tee -a "${LOG_FILE}"
    sleep "${CHECK_INTERVAL_SECONDS}"
    continue
  fi

  echo "[$(ts)] runner missing; starting continuous search" | tee -a "${LOG_FILE}"
  set +e
  (
    cd "${REPO_ROOT}"
    "${PYTHON_BIN}" scripts/continuous_strategy_search.py \
      --repo-root "${REPO_ROOT}" \
      --search-root "${SEARCH_ROOT}" \
      --experiment-root "${EXPERIMENT_ROOT}" \
      --experiment-prefix "${EXPERIMENT_PREFIX}" \
      --matrix-seeds "${MATRIX_SEEDS}" \
      --cycles 0 \
      --sleep-seconds "${RUNNER_SLEEP_SECONDS}"
  )
  runner_rc=$?
  set -e

  echo "[$(ts)] runner exited rc=${runner_rc}; restart in ${RESTART_BACKOFF_SECONDS}s" | tee -a "${LOG_FILE}"
  sleep "${RESTART_BACKOFF_SECONDS}"
done
