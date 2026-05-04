#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"
source "$REPO_ROOT/scripts/openalice_cron_lock.sh"

LOCK_DIR="$REPO_ROOT/data/runtime/locks/dirty_worktree_audit.lock"
LOG_DIR="$REPO_ROOT/logs/cron"
LOG_FILE="$LOG_DIR/dirty_worktree_audit.log"
REPORT_PATH="$REPO_ROOT/data/runtime/dirty_worktree_audit.latest.json"
PLAN_PATH="$REPO_ROOT/data/runtime/dirty_quarantine_plan.latest.json"
MANIFEST_COVERAGE_PATH="$REPO_ROOT/data/runtime/runtime_manifest_coverage.latest.json"
NOTIFICATION_PATH="$REPO_ROOT/data/runtime/dirty_worktree_audit_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_DIR")" "$(dirname "$REPORT_PATH")"

if ! openalice_acquire_cron_lock "dirty_worktree_audit" "$LOCK_DIR" "$NOTIFICATION_PATH" "$LOG_FILE"; then
  exit 0
fi

cleanup() {
  openalice_release_cron_lock "$LOCK_DIR"
}
trap cleanup EXIT INT TERM

{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start dirty_worktree_audit"
  cd "$REPO_ROOT"
  ./node_modules/.bin/tsx scripts/audit_dirty_worktree.ts --json --output "$REPORT_PATH" > "$REPORT_PATH.stdout"
  ./node_modules/.bin/tsx scripts/build_dirty_quarantine_plan.ts --input "$REPORT_PATH" --output "$PLAN_PATH" --json > "$PLAN_PATH.stdout"
  if ! ./node_modules/.bin/tsx scripts/audit_runtime_manifest_coverage.ts --json --output "$MANIFEST_COVERAGE_PATH" > "$MANIFEST_COVERAGE_PATH.stdout"; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] runtime_manifest_coverage reported blockers"
  fi
  node --input-type=module - "$REPORT_PATH" "$PLAN_PATH" "$MANIFEST_COVERAGE_PATH" "$NOTIFICATION_PATH" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'

const [reportPath, planPath, manifestCoveragePath, notificationPath] = process.argv.slice(2)
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const plan = JSON.parse(readFileSync(planPath, 'utf8'))
let manifestCoverage = null
try {
  manifestCoverage = JSON.parse(readFileSync(manifestCoveragePath, 'utf8'))
} catch {
  manifestCoverage = null
}
const counts = report.counts ?? {}
const byProtocolClass = counts.byProtocolClass ?? {}
const scopeCounts = counts.scopeCounts ?? {}
const total = Number(counts.total ?? 0)
const a = Number(byProtocolClass.A ?? 0)
const b = Number(byProtocolClass.B ?? 0)
const c = Number(byProtocolClass.C ?? 0)
const d = Number(byProtocolClass.D ?? 0)
const deletedTracked = Number(scopeCounts.deletedTrackedTotal ?? 0)
const promotionRelevant = Number(scopeCounts.promotionRelevantTotal ?? 0)
const planBlockers = Array.isArray(plan.blockingReasons) ? plan.blockingReasons : []
const manifestCoverageStatus = manifestCoverage?.status ?? 'missing'
const manifestCoverageBlockers = Array.isArray(manifestCoverage?.blockingReasons) ? manifestCoverage.blockingReasons : []
const shouldNotify = d > 0 || a > 0 || c > 0 || deletedTracked > 0 || promotionRelevant > 0 || manifestCoverageStatus !== 'complete'

writeFileSync(notificationPath, `${JSON.stringify({
  shouldNotify,
  deliveryDecision: shouldNotify ? 'notify' : 'suppress',
  headline: `Dirty worktree audit: total=${total}, A=${a}, B=${b}, C=${c}, D=${d}, manifestCoverage=${manifestCoverageStatus}`,
  fullText: `Dirty worktree audit completed. total=${total}, A=${a}, B=${b}, C=${c}, D=${d}, deletedTracked=${deletedTracked}, promotionRelevant=${promotionRelevant}. Runtime manifest coverage=${manifestCoverageStatus}. Manifest blockers=${manifestCoverageBlockers.slice(0, 8).join('|')}. Quarantine plan=${planPath}. Manifest coverage=${manifestCoveragePath}. Plan blockers=${planBlockers.join('|')}. Do not use git add .`,
}, null, 2)}\n`)
NODE
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] end dirty_worktree_audit"
} >>"$LOG_FILE" 2>&1
