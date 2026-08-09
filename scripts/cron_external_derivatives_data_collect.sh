#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

source "$REPO_ROOT/scripts/openalice_env.sh"

DATA_ROOT="${OPENALICE_DATA_DIR:-$REPO_ROOT/data}"
ARTIFACT_ROOT="${OPENALICE_ARTIFACT_DIR:-$DATA_ROOT/runtime}"
LOG_ROOT="${OPENALICE_LOG_DIR:-$REPO_ROOT/logs}"
export OPENALICE_DATA_ROOT="${OPENALICE_DATA_ROOT:-$DATA_ROOT}"
LOG_DIR="$LOG_ROOT"
NOTIFICATION_PATH="$ARTIFACT_ROOT/external_derivatives_data_collect_notification.json"

mkdir -p "$LOG_DIR" "$(dirname "$NOTIFICATION_PATH")"
cd "$REPO_ROOT"

cleanup() {
  local exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] cleanup: script exited with code $exit_code" >> "$LOG_PATH"
  fi
}
trap cleanup EXIT INT TERM

LOG_PATH="$LOG_DIR/external_derivatives_data_collect.log"
REPORT_STDOUT_PATH="$ARTIFACT_ROOT/external_derivatives_data_collect.current.stdout.json"
COLLECT_OUTPUT_PATH="${OPENALICE_EXTERNAL_OUTPUT_PATH:-$DATA_ROOT/external/derivatives/okx_swap_derivatives_events.jsonl}"
COLLECT_REPORT_PATH="${OPENALICE_EXTERNAL_REPORT_PATH:-$ARTIFACT_ROOT/external_derivatives_data_collect.latest.json}"
RUN_LEDGER_PATH="${OPENALICE_EXTERNAL_RUN_LEDGER_PATH:-$ARTIFACT_ROOT/external_derivatives_data_collect.runs.jsonl}"
CHECKPOINT_PATH="${OPENALICE_EXTERNAL_CHECKPOINT_PATH:-$ARTIFACT_ROOT/external_derivatives_data_collect.checkpoint.json}"
COLLECTOR_LOCK_DIR="${OPENALICE_EXTERNAL_COLLECTOR_LOCK_DIR:-$ARTIFACT_ROOT/locks/external_derivatives_data_collect.collector.lock}"
NORMALIZED_OUTPUT_PATH="${OPENALICE_EXTERNAL_NORMALIZED_OUTPUT_PATH:-$DATA_ROOT/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl}"
NORMALIZE_REPORT_PATH="${OPENALICE_EXTERNAL_NORMALIZE_REPORT_PATH:-$ARTIFACT_ROOT/external_derivatives_data_normalize.latest.json}"
AUDIT_PATH="${OPENALICE_EXTERNAL_AUDIT_PATH:-$ARTIFACT_ROOT/external_derivatives_data_audit.latest.json}"
COLLECT_EXIT=0
NORMALIZE_EXIT=0
AUDIT_EXIT=0
COLLECT_ARGS=(
  --endpoint all
  --symbols "${OPENALICE_EXTERNAL_SYMBOLS:-all}"
  --period "${OPENALICE_EXTERNAL_PERIOD:-5m}"
  --fetchTimeoutMs "${OPENALICE_EXTERNAL_FETCH_TIMEOUT_MS:-8000}"
  --maxRetries "${OPENALICE_EXTERNAL_MAX_RETRIES:-1}"
  --symbolBatchSize "${OPENALICE_EXTERNAL_SYMBOL_BATCH_SIZE:-25}"
  --json true
)
COLLECT_ARGS+=(
  --outputPath "$COLLECT_OUTPUT_PATH"
  --reportPath "$COLLECT_REPORT_PATH"
  --runLedgerPath "$RUN_LEDGER_PATH"
  --checkpointPath "$CHECKPOINT_PATH"
  --collectorLockDir "$COLLECTOR_LOCK_DIR"
)
if [[ -n "${OPENALICE_OKX_PUBLIC_HOST:-}" ]]; then
  COLLECT_ARGS+=(--baseUrl "$OPENALICE_OKX_PUBLIC_HOST")
fi
if [[ -n "${OPENALICE_OKX_PROXY_URL:-}" ]]; then
  COLLECT_ARGS+=(--proxyUrl "$OPENALICE_OKX_PROXY_URL")
fi
{
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start external derivatives collect"
  if ./node_modules/.bin/tsx scripts/collect_okx_external_derivatives_data.ts "${COLLECT_ARGS[@]}" > "$REPORT_STDOUT_PATH"; then
    NORMALIZE_ARGS=(--json true)
    NORMALIZE_ARGS+=(
      --inputPath "$COLLECT_OUTPUT_PATH"
      --outputPath "$NORMALIZED_OUTPUT_PATH"
      --reportPath "$NORMALIZE_REPORT_PATH"
      --runLedgerPath "$RUN_LEDGER_PATH"
    )
    if ./node_modules/.bin/tsx scripts/normalize_external_derivatives_data.ts "${NORMALIZE_ARGS[@]}"; then
      :
    else
      NORMALIZE_EXIT=$?
      echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] external derivatives normalize failed exit=$NORMALIZE_EXIT"
    fi

    if [[ $NORMALIZE_EXIT -eq 0 ]]; then
      AUDIT_ARGS=(--json true)
      AUDIT_ARGS+=(--inputPath "$NORMALIZED_OUTPUT_PATH" --outputPath "$AUDIT_PATH")
      if ./node_modules/.bin/tsx scripts/audit_external_derivatives_data.ts "${AUDIT_ARGS[@]}"; then
        :
      else
        AUDIT_EXIT=$?
        echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] external derivatives audit failed exit=$AUDIT_EXIT"
      fi
    fi
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] done external derivatives collect normalize_exit=$NORMALIZE_EXIT audit_exit=$AUDIT_EXIT"
  else
    COLLECT_EXIT=$?
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] external derivatives collect failed exit=$COLLECT_EXIT"
  fi
} >> "$LOG_PATH" 2>&1

node --input-type=module - "$REPORT_STDOUT_PATH" "$COLLECT_REPORT_PATH" "$COLLECT_REPORT_PATH.manifest.json" "$NOTIFICATION_PATH" "$COLLECT_EXIT" "$NORMALIZE_EXIT" "$AUDIT_EXIT" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs'

const [stdoutReportPath, latestReportPath, latestManifestPath, notificationPath, exitCodeRaw, normalizeExitRaw, auditExitRaw] = process.argv.slice(2)
const exitCode = Number(exitCodeRaw ?? 0)
const normalizeExitCode = Number(normalizeExitRaw ?? 0)
const auditExitCode = Number(auditExitRaw ?? 0)
let notification = {
  shouldNotify: false,
  deliveryDecision: 'skip',
  headline: 'external derivatives collect completed',
  content: 'External derivatives collection completed without operator notification.',
}

try {
  let report
  let stdoutRunId = null
  try {
    report = JSON.parse(readFileSync(stdoutReportPath, 'utf-8'))
    stdoutRunId = typeof report.runId === 'string' ? report.runId : null
  } catch {
    report = JSON.parse(readFileSync(latestReportPath, 'utf-8'))
  }
  const errors = Array.isArray(report.errors) ? report.errors.length : 0
  const unavailable = Array.isArray(report.unavailableEndpoints) ? report.unavailableEndpoints.length : 0
  const conflicts = Number(report.conflictingDuplicateRows ?? 0)
  const fetchedRows = Number(report.fetchedRows ?? 0)
  const persistedRows = Number(report.persistedRows ?? report.appendedRows ?? 0)
  const runId = typeof report.runId === 'string' ? report.runId : 'unknown_run'
  let latestRunId = runId
  const lockStatus = typeof report.collectorLockStatus === 'string' ? report.collectorLockStatus : 'unknown_lock_status'
  const previousReportStale = Boolean(report.previousReportStale)
  const previousReportAgeMs = report.previousReportAgeMs == null ? 'none' : String(report.previousReportAgeMs)
  const firstError = Array.isArray(report.errors) && report.errors[0]
    ? `${report.errors[0].symbol}/${report.errors[0].endpoint}:${report.errors[0].errorClass ?? 'unclassified'}:${report.errors[0].error}`
    : null
  const firstDiagnostic = Array.isArray(report.endpointDiagnostics) ? report.endpointDiagnostics[0] : null
  const attempts = Number(firstDiagnostic?.attempts ?? 0)
  const baseUrl = typeof report.baseUrl === 'string' ? report.baseUrl : 'unknown_base_url'
  const proxy = report.proxyConfigured ? `proxy=${report.proxySource ?? 'configured'}` : 'proxy=none'
  let evidenceTrust = report.evidenceManifest?.evidenceTrust ?? null
  let dqStatus = report.evidenceManifest?.dqStatus ?? null
  let gitDirty = report.evidenceManifest?.git?.dirty
  let gitDirtyFilesCount = report.evidenceManifest?.git?.dirtyFilesCount
  try {
    const manifest = JSON.parse(readFileSync(latestManifestPath, 'utf-8'))
    evidenceTrust = typeof manifest.evidenceTrust === 'string' ? manifest.evidenceTrust : evidenceTrust
    dqStatus = typeof manifest.dqStatus === 'string' ? manifest.dqStatus : dqStatus
    gitDirty = typeof manifest.git?.dirty === 'boolean' ? manifest.git.dirty : gitDirty
    gitDirtyFilesCount = typeof manifest.git?.dirtyFilesCount === 'number' ? manifest.git.dirtyFilesCount : gitDirtyFilesCount
  } catch {}
  try {
    const latestReport = JSON.parse(readFileSync(latestReportPath, 'utf-8'))
    latestRunId = typeof latestReport.runId === 'string' ? latestReport.runId : latestRunId
  } catch {}
  const stdoutLatestMismatch = stdoutRunId != null && latestRunId !== stdoutRunId
  const trustNeedsReview = (evidenceTrust && evidenceTrust !== 'pass') || (dqStatus && dqStatus !== 'pass')
  if (exitCode !== 0 || normalizeExitCode !== 0 || auditExitCode !== 0 || errors > 0 || conflicts > 0 || unavailable > 0 || fetchedRows === 0 || previousReportStale || stdoutLatestMismatch || trustNeedsReview) {
    notification = {
      shouldNotify: true,
      deliveryDecision: 'notify',
      headline: 'external derivatives collect needs review',
      content: `runId=${runId} latestRunId=${latestRunId} stdoutRunId=${stdoutRunId ?? 'none'} stdoutLatestMismatch=${stdoutLatestMismatch} collectExit=${exitCode} normalizeExit=${normalizeExitCode} auditExit=${auditExitCode} evidenceTrust=${evidenceTrust ?? 'unknown'} dqStatus=${dqStatus ?? 'unknown'} gitDirty=${gitDirty ?? 'unknown'} gitDirtyFilesCount=${gitDirtyFilesCount ?? 'unknown'} lock=${lockStatus} previousReportStale=${previousReportStale} previousReportAgeMs=${previousReportAgeMs} errors=${errors} unavailable=${unavailable} firstError=${firstError ?? 'none'} attempts=${attempts} conflicts=${conflicts} fetchedRows=${fetchedRows} persistedRows=${persistedRows} baseUrl=${baseUrl} ${proxy}`,
    }
  } else {
    notification.content = `runId=${runId} latestRunId=${latestRunId} evidenceTrust=${evidenceTrust ?? 'unknown'} dqStatus=${dqStatus ?? 'unknown'} lock=${lockStatus} fetchedRows=${fetchedRows} persistedRows=${persistedRows} unavailable=${unavailable} skippedDuplicateRows=${Number(report.skippedDuplicateRows ?? 0)} baseUrl=${baseUrl} ${proxy}`
  }
} catch (error) {
  notification = {
    shouldNotify: true,
    deliveryDecision: 'notify',
    headline: 'external derivatives collect report missing or unreadable',
    content: error instanceof Error ? error.message : String(error),
  }
}

writeFileSync(notificationPath, `${JSON.stringify(notification, null, 2)}\n`)
NODE

FINAL_EXIT=$COLLECT_EXIT
if [[ $FINAL_EXIT -eq 0 && $NORMALIZE_EXIT -ne 0 ]]; then
  FINAL_EXIT=$NORMALIZE_EXIT
fi
if [[ $FINAL_EXIT -eq 0 && $AUDIT_EXIT -ne 0 ]]; then
  FINAL_EXIT=$AUDIT_EXIT
fi
exit "$FINAL_EXIT"
