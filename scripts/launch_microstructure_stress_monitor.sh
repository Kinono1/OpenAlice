#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"

LOCK_ROOT="$REPO_ROOT/data/runtime/locks"
LOCK_DIR="$LOCK_ROOT/microstructure_stress_monitor.lock"
INTERVAL_SECONDS="${OPENALICE_SECOND_LEVEL_INTERVAL_SECONDS:-15}"

export PATH="/Users/kino/.nvm/versions/node/v24.15.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
export OPENALICE_SKIP_SECOND_LEVEL="false"

mkdir -p "$LOCK_ROOT" "$REPO_ROOT/logs"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] microstructure monitor already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

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

  echo "corepack or pnpm is required for launch_microstructure_stress_monitor.sh but was not found in PATH or known Node install locations" >&2
  return 127
}

run_microstructure_paper_lane() {
  if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" == "true" && "${OPENALICE_CRON_DIAGNOSTIC_MODE:-false}" != "true" ]]; then
    echo "ERROR: OPENALICE_ALLOW_UNGATED_PAPER_LANES requires OPENALICE_CRON_DIAGNOSTIC_MODE=true" >&2
    exit 78
  fi
  if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] skip paper:microstructure-stress: OPENALICE_ALLOW_UNGATED_PAPER_LANES is not true"
    return 0
  fi

  local -a microstructure_paper_cmd=(
    run_pnpm
    paper:microstructure-stress
    --
    --allowUngatedPaperLane
    true
  )

  if ! "${microstructure_paper_cmd[@]}"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] paper:microstructure-stress failed"
  fi
}

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start microstructure stress monitor interval=${INTERVAL_SECONDS}s"
while true; do
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[$started_at] cycle start"

  if ! run_pnpm data:accumulate-1s; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] data:accumulate-1s failed"
  fi

  run_microstructure_paper_lane

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle done"
  sleep "$INTERVAL_SECONDS"
done
