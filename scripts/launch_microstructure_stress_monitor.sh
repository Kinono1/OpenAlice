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

run_microstructure_paper_lane() {
  if [[ "${OPENALICE_ALLOW_UNGATED_PAPER_LANES:-false}" != "true" ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] skip paper:microstructure-stress: OPENALICE_ALLOW_UNGATED_PAPER_LANES is not true"
    return 0
  fi

  local -a microstructure_paper_cmd=(
    corepack
    pnpm
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

  if ! corepack pnpm data:accumulate-1s; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] data:accumulate-1s failed"
  fi

  run_microstructure_paper_lane

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cycle done"
  sleep "$INTERVAL_SECONDS"
done
