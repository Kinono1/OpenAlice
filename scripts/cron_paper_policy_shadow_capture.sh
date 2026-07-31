#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/paper_policy_shadow_capture.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_PATH="$LOG_DIR/paper_policy_shadow_capture.log"
REPORT_PATH="$REPO_ROOT/data/runtime/paper_policy_shadow_capture.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/paper_policy_shadow_capture_notification.json"

if ! openalice_acquire_cron_lock "paper_policy_shadow_capture" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_PATH"; then
  exit 0
fi
trap 'openalice_release_cron_lock "$LOCK_DIR"' EXIT

mkdir -p "$LOG_DIR" "$(dirname "$NOTIFICATION_PATH")"
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

  echo "corepack or pnpm is required for cron_paper_policy_shadow_capture.sh but was not found in PATH or known Node install locations" >&2
  return 127
}

CAPTURE_EXIT=0
{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start paper policy shadow capture"
  if run_pnpm paper:policy-shadow:capture -- --json true --outputPath "$REPORT_PATH"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] done paper policy shadow capture"
  else
    CAPTURE_EXIT=$?
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] paper policy shadow capture failed exit=$CAPTURE_EXIT"
  fi
} >> "$LOG_PATH" 2>&1

node --input-type=module - "$REPORT_PATH" "$NOTIFICATION_PATH" "$CAPTURE_EXIT" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'

const [reportPath, notificationPath, exitCodeRaw] = process.argv.slice(2)
const exitCode = Number(exitCodeRaw ?? 0)
let notification

try {
  const report = JSON.parse(readFileSync(reportPath, 'utf-8'))
  const counts = report.counts ?? {}
  const recorded = Number(counts.recorded ?? 0)
  const duplicateSkipped = Number(counts.duplicateSkipped ?? 0)
  const candidatesSeen = Number(counts.candidatesSeen ?? 0)
  const shouldNotify = exitCode !== 0 || recorded > 0
  notification = {
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'suppress',
    headline: `Paper policy shadow capture: recorded=${recorded}, candidates=${candidatesSeen}`,
    fullText: `Paper policy shadow capture completed. exitCode=${exitCode}, recorded=${recorded}, duplicateSkipped=${duplicateSkipped}, candidatesSeen=${candidatesSeen}, capDropped=${Number(counts.capDropped ?? 0)}, flatUniverseDropped=${Number(counts.flatUniverseDropped ?? 0)}.`,
  }
} catch (error) {
  notification = {
    shouldNotify: true,
    deliveryDecision: 'notify',
    headline: 'paper policy shadow capture report missing or unreadable',
    fullText: error instanceof Error ? error.message : String(error),
  }
}

writeFileSync(notificationPath, `${JSON.stringify(notification, null, 2)}\n`)
NODE

exit "$CAPTURE_EXIT"
