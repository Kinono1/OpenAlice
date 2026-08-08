#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

RUNTIME_ROOT="${OPENALICE_ARTIFACT_DIR:-$REPO_ROOT/data/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
LOCK_DIR="$RUNTIME_ROOT/locks/dirty_worktree_audit.lock"
LOG_DIR="$LOG_ROOT/cron"
LOG_FILE="$LOG_DIR/dirty_worktree_audit.log"
REPORT_PATH="$RUNTIME_ROOT/dirty_worktree_audit.latest.json"
PLAN_PATH="$RUNTIME_ROOT/dirty_quarantine_plan.latest.json"
MANIFEST_COVERAGE_PATH="$RUNTIME_ROOT/runtime_manifest_coverage.latest.json"
NOTIFICATION_PATH="$RUNTIME_ROOT/dirty_worktree_audit_notification.json"
LEGACY_REPORT_PATH="$RUNTIME_ROOT/dirty_worktree_audit.original_wip.latest.json"
LEGACY_PLAN_PATH="$RUNTIME_ROOT/dirty_quarantine_plan.original_wip.latest.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")"

if ! openalice_acquire_cron_lock "dirty_worktree_audit" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() { openalice_release_cron_lock "$LOCK_DIR"; }
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start dirty_worktree_audit"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/audit_dirty_worktree.ts \
    --json \
    --repoRoot "$REPO_ROOT" \
    --purpose canonical_release \
    --sourceMode verified_release \
    --output "$REPORT_PATH" > "$REPORT_PATH.stdout"
  ./node_modules/.bin/tsx scripts/build_dirty_quarantine_plan.ts \
    --input "$REPORT_PATH" --output "$PLAN_PATH" --json > "$PLAN_PATH.stdout"
  if ! ./node_modules/.bin/tsx scripts/audit_runtime_manifest_coverage.ts \
    --json --runtimeDir "$RUNTIME_ROOT" --sourceKind verified_release \
    --output "$MANIFEST_COVERAGE_PATH" > "$MANIFEST_COVERAGE_PATH.stdout"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] runtime_manifest_coverage reported blockers"
  fi
  echo "Runtime manifest coverage=$MANIFEST_COVERAGE_PATH"
  LEGACY_ARGS=()
  if [[ -n "${OPENALICE_LEGACY_WIP_ROOT:-}" && -d "${OPENALICE_LEGACY_WIP_ROOT}" ]]; then
    ./node_modules/.bin/tsx scripts/audit_dirty_worktree.ts \
      --json \
      --repoRoot "$OPENALICE_LEGACY_WIP_ROOT" \
      --purpose legacy_wip \
      --sourceMode git_worktree \
      --output "$LEGACY_REPORT_PATH" > "$LEGACY_REPORT_PATH.stdout"
    ./node_modules/.bin/tsx scripts/build_dirty_quarantine_plan.ts \
      --input "$LEGACY_REPORT_PATH" --output "$LEGACY_PLAN_PATH" --json > "$LEGACY_PLAN_PATH.stdout"
    LEGACY_ARGS=(--legacy-report "$LEGACY_REPORT_PATH")
  fi
  ./node_modules/.bin/tsx scripts/build_dirty_worktree_notification.ts \
    --report "$REPORT_PATH" \
    --plan "$PLAN_PATH" \
    --coverage "$MANIFEST_COVERAGE_PATH" \
    --notification "$NOTIFICATION_PATH" \
    --state "$RUNTIME_ROOT/dirty_worktree_audit_notification.state.json" \
    "${LEGACY_ARGS[@]}" \
    > "$NOTIFICATION_PATH.stdout"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end dirty_worktree_audit"
} >>"$LOG_FILE" 2>&1
