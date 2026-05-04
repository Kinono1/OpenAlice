import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { ProxyAgent, request } from 'undici'
import { appendJsonlSync } from '../src/runtime/runtime_events.js'
import {
  readGitEvidenceSnapshot,
  writeEvidenceManifestForArtifact,
} from '../src/runtime/evidence_manifest.js'
import type {
  EvidenceManifest,
  GitEvidenceSnapshot,
} from '../src/runtime/evidence_manifest.js'
import { acquireRuntimeLock, type RuntimeLock } from '../src/runtime/runtime_lock.js'

const DEFAULT_OUTPUT_PATH = 'data/external/derivatives/binance_usdm_derivatives_events.jsonl'
const DEFAULT_CONFLICT_AUDIT_PATH = 'data/runtime/external_derivatives_dedup_conflicts.jsonl'
const DEFAULT_RUN_LEDGER_PATH = 'data/runtime/external_derivatives_data_collect.runs.jsonl'
const BINANCE_USDM_BASE_URL = 'https://fapi.binance.com'
const SCHEMA_VERSION = 'external_derivatives_event.v1'
const DEFAULT_FETCH_TIMEOUT_MS = 12_000
const DEFAULT_MAX_RETRIES = 1
export const DEFAULT_STALE_REPORT_MS = 10 * 60 * 60 * 1000
const DEFAULT_COLLECTOR_LOCK_STALE_MS = 6 * 60 * 60 * 1000
export const EXTERNAL_DERIVATIVES_COLLECTOR_SIDE_EFFECT_POLICY = 'read_only_external_fetch_append_only_local_storage'

export type ExternalDerivativesEndpoint =
  | 'fundingRate'
  | 'premiumIndex'
  | 'openInterest'
  | 'openInterestHist'
  | 'longShort'
  | 'all'

export interface ExternalDerivativesCollectArgs {
  symbols: string[]
  endpoints: Exclude<ExternalDerivativesEndpoint, 'all'>[]
  period: string
  outputPath: string
  reportPath?: string
  runLedgerPath?: string
  collectorLockDir?: string
  collectorLockStaleMs?: number
  staleReportMs?: number
  baseUrl?: string
  proxyUrl?: string
  proxySource?: string
  fetchTimeoutMs?: number
  maxRetries?: number
  dryRun: boolean
  json: boolean
}

export interface ExternalDerivativesRow {
  schemaVersion: string
  exchange: 'binance'
  market: 'usdm'
  symbol: string
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampBasis: 'exchange_event' | 'fetch_bucket'
  fetchTimestamp: string
  payloadReceivedAt: string
  ingestedAt: string
  fetchLatencyMs: number
  decodeLatencyMs: number
  processingLatencyMs: number
  processingLatencyBasis: 'fetch_start_to_row_built'
  appendLatencyMs: number | null
  appendLatencyBasis: 'payload_received_to_jsonl_append' | null
  ingestionLatencyMs: number | null
  ingestionLatencyBasis: 'payload_received_to_jsonl_append' | null
  collectionRunId?: string
  reportPath?: string
  manifestPath?: string
  evidenceTrust?: EvidenceManifest['evidenceTrust']
  dqStatus?: EvidenceManifest['dqStatus']
  businessStatus?: EvidenceManifest['businessStatus']
  gitCommit?: string | null
  gitDirty?: boolean
  gitDirtyFilesCount?: number
  gitDirtyHash?: string
  dedupKey: string
  rawPayloadHash: string
  payloadHashBasis: 'canonical_json_payload'
  rawBodyHash: string
  payload: unknown
}

export type ExternalFetchErrorClass =
  | 'timeout'
  | 'http'
  | 'dns'
  | 'proxy'
  | 'tls'
  | 'json_parse'
  | 'payload_schema'
  | 'collector_lock'
  | 'network_or_unknown'

export interface ExternalDerivativesCollectReport {
  schemaVersion: 1
  runId: string
  generatedAt: string
  outputPath: string
  reportPath: string
  runLedgerPath: string | null
  dryRun: boolean
  sideEffectPolicy: typeof EXTERNAL_DERIVATIVES_COLLECTOR_SIDE_EFFECT_POLICY
  collectorLockStatus: 'acquired' | 'skipped_lock_held' | 'disabled_dry_run'
  collectorLockDir: string | null
  previousReportAgeMs: number | null
  previousReportStale: boolean
  previousReportRunId: string | null
  baseUrl: string
  proxyConfigured: boolean
  proxySource: string | null
  fetchTimeoutMs: number
  maxRetries: number
  symbols: string[]
  endpoints: string[]
  period: string
  fetchedRows: number
  appendedRows: number
  wouldAppendRows: number
  persistedRows: number
  skippedDuplicateRows: number
  conflictingDuplicateRows: number
  conflictAuditPath: string | null
  errorSummary: Partial<Record<ExternalFetchErrorClass, number>>
  errors: Array<{ symbol: string; endpoint: string; error: string; errorClass: ExternalFetchErrorClass }>
  evidenceManifest: ExternalDerivativesManifestSummary | null
  endpointDiagnostics: Array<{
    symbol: string
    endpoint: string
    sourceEndpoint: string
    url: string
    attempts: number
    status: 'ok' | 'error'
    fetchedRows: number
    error: string | null
    errorClass: ExternalFetchErrorClass | null
    attemptErrors: Array<{ attempt: number; error: string; errorClass: ExternalFetchErrorClass }>
    startedAt: string
    finishedAt: string
    fetchLatencyMs: number | null
    decodeLatencyMs: number | null
    processingLatencyMs: number | null
    processingLatencyBasis: ExternalDerivativesRow['processingLatencyBasis'] | null
  }>
}

export interface ExternalDerivativesManifestSummary {
  manifestPath: string
  evidenceTrust: EvidenceManifest['evidenceTrust']
  dqStatus: EvidenceManifest['dqStatus']
  businessStatus: EvidenceManifest['businessStatus']
  exitCode: number
  artifactHashBasis: 'manifest_sidecar_hashes_report' | 'hash_available_in_manifest_sidecar'
  artifactHash: string | null
  git: {
    commit: string | null
    dirty: boolean
    dirtyFilesCount: number
    dirtyHash: string
  }
}

interface FetchLikeResponse {
  ok: boolean
  status: number
  text(): Promise<string>
}

export type FetchLike = (url: string) => Promise<FetchLikeResponse>

const proxyDispatchers = new Map<string, ProxyAgent>()

export function parseExternalDerivativesCollectArgs(argv: string[]): ExternalDerivativesCollectArgs {
  const raw = parseRawArgs(argv)
  const endpoint = (raw.get('endpoint') ?? 'all') as ExternalDerivativesEndpoint
  const proxy = resolveProxyConfig(raw)
  return {
    symbols: parseSymbols(raw.get('symbols') ?? 'BTCUSDT,ETHUSDT'),
    endpoints: expandEndpoints(endpoint),
    period: raw.get('period') ?? '5m',
    outputPath: raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH,
    reportPath: raw.get('reportPath') ?? defaultReportPath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    runLedgerPath: raw.get('runLedgerPath') ?? defaultRunLedgerPath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    collectorLockDir: raw.get('collectorLockDir') ?? undefined,
    collectorLockStaleMs: parsePositiveNumber(
      raw.get('collectorLockStaleMs') ?? process.env.OPENALICE_EXTERNAL_COLLECTOR_LOCK_STALE_MS,
      DEFAULT_COLLECTOR_LOCK_STALE_MS,
    ),
    staleReportMs: parsePositiveNumber(raw.get('staleReportMs') ?? process.env.OPENALICE_EXTERNAL_STALE_REPORT_MS, DEFAULT_STALE_REPORT_MS),
    baseUrl: normalizeBaseUrl(raw.get('baseUrl') ?? process.env.OPENALICE_BINANCE_USDM_BASE_URL ?? BINANCE_USDM_BASE_URL),
    proxyUrl: proxy.proxyUrl,
    proxySource: proxy.proxySource,
    fetchTimeoutMs: parsePositiveNumber(raw.get('fetchTimeoutMs') ?? process.env.OPENALICE_EXTERNAL_FETCH_TIMEOUT_MS, DEFAULT_FETCH_TIMEOUT_MS),
    maxRetries: parseNonNegativeInteger(raw.get('maxRetries') ?? process.env.OPENALICE_EXTERNAL_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    dryRun: parseBool(raw.get('dryRun'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function collectExternalDerivativesData(
  args: ExternalDerivativesCollectArgs,
  fetchImpl?: FetchLike,
): Promise<ExternalDerivativesCollectReport> {
  const startedAt = new Date()
  const runId = `external_derivatives_data_collect_${startedAt.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z')}_${randomUUID()}`
  const outputPath = resolve(args.outputPath)
  const reportPath = resolve(args.reportPath ?? defaultReportPath(args.outputPath))
  const runLedgerPath = resolve(args.runLedgerPath ?? defaultRunLedgerPath(args.outputPath))
  const baseUrl = normalizeBaseUrl(args.baseUrl ?? BINANCE_USDM_BASE_URL)
  const fetchTimeoutMs = args.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const maxRetries = args.maxRetries ?? DEFAULT_MAX_RETRIES
  const staleReportMs = args.staleReportMs ?? DEFAULT_STALE_REPORT_MS
  const effectiveFetch = fetchImpl ?? buildDefaultExternalFetch(args.proxyUrl)
  const conflictAuditPath = resolve(
    args.outputPath === DEFAULT_OUTPUT_PATH
      ? DEFAULT_CONFLICT_AUDIT_PATH
      : join(dirname(outputPath), 'external_derivatives_dedup_conflicts.jsonl'),
  )
  const previousReport = await readPreviousExternalDerivativesReportStatus(reportPath, startedAt.getTime(), staleReportMs)
  const collectorLockDir = args.dryRun ? null : resolve(args.collectorLockDir ?? defaultCollectorLockDir(args.outputPath))
  let collectorLock: RuntimeLock | null = null
  let collectorLockStatus: ExternalDerivativesCollectReport['collectorLockStatus'] = args.dryRun ? 'disabled_dry_run' : 'acquired'
  if (!args.dryRun && collectorLockDir) {
    collectorLock = acquireRuntimeLock(collectorLockDir, {
      purpose: 'external_derivatives_data_collect',
      staleMs: args.collectorLockStaleMs,
    })
    if (!collectorLock) {
      collectorLockStatus = 'skipped_lock_held'
      const lockError = 'collector lock held; external derivatives collection skipped'
      const report = buildExternalDerivativesCollectReport({
        runId,
        generatedAt: new Date().toISOString(),
        outputPath,
        reportPath,
        runLedgerPath: args.dryRun ? null : runLedgerPath,
        dryRun: args.dryRun,
        collectorLockStatus,
        collectorLockDir,
        previousReport,
        baseUrl,
        proxyConfigured: Boolean(args.proxyUrl),
        proxySource: args.proxyUrl ? args.proxySource ?? 'programmatic' : null,
        fetchTimeoutMs,
        maxRetries,
        symbols: args.symbols,
        endpoints: args.endpoints,
        period: args.period,
        fetchedRows: 0,
        appendedRows: 0,
        wouldAppendRows: 0,
        persistedRows: 0,
        skippedDuplicateRows: 0,
        conflictingDuplicateRows: 0,
        conflictAuditPath: null,
        errors: [{
          symbol: '*',
          endpoint: 'collector',
          error: lockError,
          errorClass: 'collector_lock',
        }],
        endpointDiagnostics: [],
      })
      if (previousReport.stale || previousReport.runId === null) {
        await writeExternalDerivativesLatestReportAndManifest({
          report,
          reportPath,
          startedAt,
          exitCode: 1,
          businessStatus: 'fail',
          recordsIn: 0,
          recordsOut: 0,
          errorClass: 'collector_lock',
        })
      }
      await appendExternalDerivativesRunLedgerIfEnabled(report, runLedgerPath, args.dryRun)
      return report
    }
  }

  try {
    const existingDedup = await readExistingDedupRows(outputPath)
    const rows: ExternalDerivativesRow[] = []
    const errors: ExternalDerivativesCollectReport['errors'] = []
    const endpointDiagnostics: ExternalDerivativesCollectReport['endpointDiagnostics'] = []

    for (const symbol of args.symbols) {
      for (const endpoint of args.endpoints) {
        const result = await fetchEndpointRowsWithRetries({
          symbol,
          endpoint,
          period: args.period,
          baseUrl,
          fetchImpl: effectiveFetch,
          fetchTimeoutMs,
          maxRetries,
        })
        rows.push(...result.rows)
        endpointDiagnostics.push(result.diagnostic)
        if (result.error) {
          errors.push({
            symbol,
            endpoint,
            error: result.error,
            errorClass: result.errorClass ?? classifyExternalFetchError(result.error),
          })
        }
      }
    }

    let appendedRows = 0
    let wouldAppendRows = 0
    let persistedRows = 0
    let skippedDuplicateRows = 0
    let conflictingDuplicateRows = 0
    const rowsToAppend: ExternalDerivativesRow[] = []
    const conflictAuditRows: Array<Record<string, unknown>> = []
    if (!args.dryRun) {
      await mkdir(dirname(outputPath), { recursive: true })
      await mkdir(dirname(conflictAuditPath), { recursive: true })
    }
    for (const row of rows) {
      const existingHash = existingDedup.get(row.dedupKey)
      if (existingDedup.has(row.dedupKey)) {
        skippedDuplicateRows += 1
        if (existingHash && existingHash !== row.rawPayloadHash) {
          conflictingDuplicateRows += 1
          conflictAuditRows.push({
            schemaVersion: 'external_derivatives_dedup_conflict.v1',
            detectedAt: new Date().toISOString(),
            dedupKey: row.dedupKey,
            existingRawPayloadHash: existingHash,
            incomingRawPayloadHash: row.rawPayloadHash,
            exchange: row.exchange,
            market: row.market,
            symbol: row.symbol,
            sourceEndpoint: row.sourceEndpoint,
            sourceTimestamp: row.sourceTimestamp,
            action: 'skipped_incoming_row_preserved_existing_append_only_record',
          })
        }
        continue
      }
      existingDedup.set(row.dedupKey, row.rawPayloadHash)
      wouldAppendRows += 1
      if (!args.dryRun) {
        rowsToAppend.push(row)
      } else {
        appendedRows = 0
      }
    }

    if (!args.dryRun) {
      appendedRows = rowsToAppend.length
      persistedRows = rowsToAppend.length
    }

    const businessStatus = errors.length > 0
      ? 'fail'
      : conflictingDuplicateRows > 0
        ? 'warn'
        : appendedRows > 0
          ? 'pass'
          : 'warn'
    const exitCode = errors.length > 0 ? 1 : 0
    const gitSnapshot = args.dryRun ? null : readGitEvidenceSnapshot()
    const rowEvidence = gitSnapshot
      ? buildExternalDerivativesRowEvidence({
          runId,
          reportPath,
          exitCode,
          businessStatus,
          gitSnapshot,
        })
      : null
    if (!args.dryRun) {
      for (const conflict of conflictAuditRows) {
        appendJsonlSync(conflictAuditPath, rowEvidence ? { ...conflict, ...rowEvidence } : conflict)
      }
      for (const row of rowsToAppend) {
        appendJsonlSync(outputPath, withIngestionTimestamps(row, rowEvidence ?? undefined))
      }
    }

    const report = buildExternalDerivativesCollectReport({
      runId,
      generatedAt: new Date().toISOString(),
      outputPath,
      reportPath,
      runLedgerPath: args.dryRun ? null : runLedgerPath,
      dryRun: args.dryRun,
      collectorLockStatus,
      collectorLockDir,
      previousReport,
      baseUrl,
      proxyConfigured: Boolean(args.proxyUrl),
      proxySource: args.proxyUrl ? args.proxySource ?? 'programmatic' : null,
      fetchTimeoutMs,
      maxRetries,
      symbols: args.symbols,
      endpoints: args.endpoints,
      period: args.period,
      fetchedRows: rows.length,
      appendedRows,
      wouldAppendRows,
      persistedRows,
      skippedDuplicateRows,
      conflictingDuplicateRows,
      conflictAuditPath: args.dryRun || conflictingDuplicateRows === 0 ? null : conflictAuditPath,
      errors,
      endpointDiagnostics,
    })

    if (!args.dryRun) {
      await writeExternalDerivativesLatestReportAndManifest({
        report,
        reportPath,
        startedAt,
        exitCode,
        businessStatus,
        recordsIn: rows.length,
        recordsOut: appendedRows,
        errorClass: errors.length > 0
          ? 'external_fetch_error'
          : conflictingDuplicateRows > 0
            ? 'dedup_key_payload_hash_conflict'
            : null,
        gitSnapshot: gitSnapshot ?? undefined,
      })
      await appendExternalDerivativesRunLedgerIfEnabled(report, runLedgerPath, args.dryRun)
    }

    return report
  } finally {
    collectorLock?.release()
  }
}

async function writeExternalDerivativesLatestReportAndManifest(input: {
  report: ExternalDerivativesCollectReport
  reportPath: string
  startedAt: Date
  exitCode: number
  businessStatus: 'pass' | 'warn' | 'fail' | 'unknown'
  recordsIn: number
  recordsOut: number
  errorClass: string | null
  gitSnapshot?: GitEvidenceSnapshot
}): Promise<void> {
  await mkdir(dirname(input.reportPath), { recursive: true })
  const gitSnapshot = input.gitSnapshot ?? readGitEvidenceSnapshot()
  input.report.evidenceManifest = buildExternalDerivativesManifestSummaryForReport({
    reportPath: input.reportPath,
    exitCode: input.exitCode,
    businessStatus: input.businessStatus,
    gitSnapshot,
  })
  await writeFile(input.reportPath, `${JSON.stringify(input.report, null, 2)}\n`, 'utf-8')
  const manifest = await writeEvidenceManifestForArtifact({
    job: 'external_derivatives_data_collect',
    artifactPath: input.reportPath,
    startedAt: input.startedAt,
    finishedAt: new Date(),
    exitCode: input.exitCode,
    businessStatus: input.businessStatus,
    recordsIn: input.recordsIn,
    recordsOut: input.recordsOut,
    errorClass: input.errorClass,
    gitSnapshot,
  })
  input.report.evidenceManifest = summarizeExternalDerivativesManifest(manifest, input.report.evidenceManifest)
}

function buildExternalDerivativesRowEvidence(input: {
  runId: string
  reportPath: string
  exitCode: number
  businessStatus: EvidenceManifest['businessStatus']
  gitSnapshot: GitEvidenceSnapshot
}): Pick<
  ExternalDerivativesRow,
  | 'collectionRunId'
  | 'reportPath'
  | 'manifestPath'
  | 'evidenceTrust'
  | 'dqStatus'
  | 'businessStatus'
  | 'gitCommit'
  | 'gitDirty'
  | 'gitDirtyFilesCount'
  | 'gitDirtyHash'
> {
  const manifest = buildExternalDerivativesManifestSummaryForReport({
    reportPath: input.reportPath,
    exitCode: input.exitCode,
    businessStatus: input.businessStatus,
    gitSnapshot: input.gitSnapshot,
  })
  return {
    collectionRunId: input.runId,
    reportPath: resolve(input.reportPath),
    manifestPath: manifest.manifestPath,
    evidenceTrust: manifest.evidenceTrust,
    dqStatus: manifest.dqStatus,
    businessStatus: input.businessStatus,
    gitCommit: input.gitSnapshot.commit,
    gitDirty: input.gitSnapshot.dirty,
    gitDirtyFilesCount: input.gitSnapshot.dirtyFilesCount,
    gitDirtyHash: input.gitSnapshot.dirtyHash,
  }
}

export function buildExternalDerivativesDedupKey(input: {
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>
  symbol: string
  sourceTimestampMs: number
  period?: string
  fetchBucketMs?: number
}): string {
  if (input.endpoint === 'fundingRate') {
    return `binance|usdm|fundingRate|${input.symbol}|${input.sourceTimestampMs}`
  }
  if (input.endpoint === 'premiumIndex') {
    return `binance|usdm|premiumIndex|${input.symbol}|${input.fetchBucketMs ?? input.sourceTimestampMs}`
  }
  if (input.endpoint === 'openInterest') {
    return `binance|usdm|openInterest|${input.symbol}|${input.fetchBucketMs ?? input.sourceTimestampMs}`
  }
  if (input.endpoint === 'openInterestHist') {
    return `binance|usdm|openInterestHist|${input.symbol}|${input.period ?? '5m'}|${input.sourceTimestampMs}`
  }
  return `binance|usdm|globalLongShortAccountRatio|${input.symbol}|${input.period ?? '5m'}|${input.sourceTimestampMs}`
}

function buildExternalDerivativesCollectReport(input: {
  runId: string
  generatedAt: string
  outputPath: string
  reportPath: string
  runLedgerPath: string | null
  dryRun: boolean
  collectorLockStatus: ExternalDerivativesCollectReport['collectorLockStatus']
  collectorLockDir: string | null
  previousReport: PreviousExternalDerivativesReportStatus
  baseUrl: string
  proxyConfigured: boolean
  proxySource: string | null
  fetchTimeoutMs: number
  maxRetries: number
  symbols: string[]
  endpoints: string[]
  period: string
  fetchedRows: number
  appendedRows: number
  wouldAppendRows: number
  persistedRows: number
  skippedDuplicateRows: number
  conflictingDuplicateRows: number
  conflictAuditPath: string | null
  errors: ExternalDerivativesCollectReport['errors']
  endpointDiagnostics: ExternalDerivativesCollectReport['endpointDiagnostics']
}): ExternalDerivativesCollectReport {
  return {
    schemaVersion: 1,
    runId: input.runId,
    generatedAt: input.generatedAt,
    outputPath: input.outputPath,
    reportPath: input.reportPath,
    runLedgerPath: input.runLedgerPath,
    dryRun: input.dryRun,
    sideEffectPolicy: EXTERNAL_DERIVATIVES_COLLECTOR_SIDE_EFFECT_POLICY,
    collectorLockStatus: input.collectorLockStatus,
    collectorLockDir: input.collectorLockDir,
    previousReportAgeMs: input.previousReport.ageMs,
    previousReportStale: input.previousReport.stale,
    previousReportRunId: input.previousReport.runId,
    baseUrl: input.baseUrl,
    proxyConfigured: input.proxyConfigured,
    proxySource: input.proxySource,
    fetchTimeoutMs: input.fetchTimeoutMs,
    maxRetries: input.maxRetries,
    symbols: input.symbols,
    endpoints: input.endpoints,
    period: input.period,
    fetchedRows: input.fetchedRows,
    appendedRows: input.appendedRows,
    wouldAppendRows: input.wouldAppendRows,
    persistedRows: input.persistedRows,
    skippedDuplicateRows: input.skippedDuplicateRows,
    conflictingDuplicateRows: input.conflictingDuplicateRows,
    conflictAuditPath: input.conflictAuditPath,
    errorSummary: summarizeExternalFetchErrors(input.errors),
    errors: input.errors,
    evidenceManifest: null,
    endpointDiagnostics: input.endpointDiagnostics,
  }
}

function summarizeExternalDerivativesManifest(
  manifest: EvidenceManifest,
  summary: ExternalDerivativesManifestSummary | null,
): ExternalDerivativesManifestSummary {
  return {
    manifestPath: manifest.manifestPath,
    evidenceTrust: manifest.evidenceTrust,
    dqStatus: manifest.dqStatus,
    businessStatus: manifest.businessStatus,
    exitCode: manifest.exitCode,
    artifactHashBasis: 'manifest_sidecar_hashes_report',
    artifactHash: readManifestSidecarArtifactHash(manifest.manifestPath) ?? summary?.artifactHash ?? null,
    git: summary?.git ?? {
      commit: manifest.git.commit,
      dirty: manifest.git.dirty,
      dirtyFilesCount: manifest.git.dirtyFilesCount,
      dirtyHash: manifest.git.dirtyHash,
    },
  }
}

function readManifestSidecarArtifactHash(manifestPath: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    return typeof manifest.artifactHash === 'string' && manifest.artifactHash
      ? manifest.artifactHash
      : null
  } catch {
    return null
  }
}

function buildExternalDerivativesManifestSummaryForReport(input: {
  reportPath: string
  exitCode: number
  businessStatus: EvidenceManifest['businessStatus']
  gitSnapshot: GitEvidenceSnapshot
}): ExternalDerivativesManifestSummary {
  const evidenceTrust = input.exitCode !== 0
    ? 'fail'
    : input.gitSnapshot.dirty
      ? 'quarantine'
      : 'pass'
  return {
    manifestPath: resolve(`${input.reportPath}.manifest.json`),
    evidenceTrust,
    dqStatus: evidenceTrust,
    businessStatus: input.businessStatus,
    exitCode: input.exitCode,
    artifactHashBasis: 'hash_available_in_manifest_sidecar',
    artifactHash: null,
    git: {
      commit: input.gitSnapshot.commit,
      dirty: input.gitSnapshot.dirty,
      dirtyFilesCount: input.gitSnapshot.dirtyFilesCount,
      dirtyHash: input.gitSnapshot.dirtyHash,
    },
  }
}

function summarizeExternalFetchErrors(
  errors: ExternalDerivativesCollectReport['errors'],
): Partial<Record<ExternalFetchErrorClass, number>> {
  const summary: Partial<Record<ExternalFetchErrorClass, number>> = {}
  for (const error of errors) {
    summary[error.errorClass] = (summary[error.errorClass] ?? 0) + 1
  }
  return summary
}

function buildExternalDerivativesRunLedgerRow(report: ExternalDerivativesCollectReport): Record<string, unknown> {
  return {
    schemaVersion: 'external_derivatives_data_collect_run.v1',
    runId: report.runId,
    generatedAt: report.generatedAt,
    outputPath: report.outputPath,
    reportPath: report.reportPath,
    manifestPath: report.evidenceManifest?.manifestPath ?? null,
    evidenceTrust: report.evidenceManifest?.evidenceTrust ?? null,
    dqStatus: report.evidenceManifest?.dqStatus ?? null,
    businessStatus: report.evidenceManifest?.businessStatus ?? null,
    artifactHash: report.evidenceManifest?.artifactHash ?? null,
    gitCommit: report.evidenceManifest?.git.commit ?? null,
    gitDirty: report.evidenceManifest?.git.dirty ?? null,
    gitDirtyFilesCount: report.evidenceManifest?.git.dirtyFilesCount ?? null,
    gitDirtyHash: report.evidenceManifest?.git.dirtyHash ?? null,
    dryRun: report.dryRun,
    collectorLockStatus: report.collectorLockStatus,
    collectorLockDir: report.collectorLockDir,
    previousReportAgeMs: report.previousReportAgeMs,
    previousReportStale: report.previousReportStale,
    previousReportRunId: report.previousReportRunId,
    sideEffectPolicy: report.sideEffectPolicy,
    baseUrl: report.baseUrl,
    proxyConfigured: report.proxyConfigured,
    proxySource: report.proxySource,
    fetchTimeoutMs: report.fetchTimeoutMs,
    maxRetries: report.maxRetries,
    symbols: report.symbols,
    endpoints: report.endpoints,
    period: report.period,
    fetchedRows: report.fetchedRows,
    appendedRows: report.appendedRows,
    wouldAppendRows: report.wouldAppendRows,
    persistedRows: report.persistedRows,
    skippedDuplicateRows: report.skippedDuplicateRows,
    conflictingDuplicateRows: report.conflictingDuplicateRows,
    conflictAuditPath: report.conflictAuditPath,
    errorSummary: report.errorSummary,
    errorCount: report.errors.length,
    endpointDiagnostics: report.endpointDiagnostics.map(diagnostic => ({
      symbol: diagnostic.symbol,
      endpoint: diagnostic.endpoint,
      sourceEndpoint: diagnostic.sourceEndpoint,
      url: diagnostic.url,
      attempts: diagnostic.attempts,
      status: diagnostic.status,
      fetchedRows: diagnostic.fetchedRows,
      error: diagnostic.error,
      errorClass: diagnostic.errorClass,
      attemptErrors: diagnostic.attemptErrors,
      fetchLatencyMs: diagnostic.fetchLatencyMs,
      decodeLatencyMs: diagnostic.decodeLatencyMs,
      processingLatencyMs: diagnostic.processingLatencyMs,
      processingLatencyBasis: diagnostic.processingLatencyBasis,
    })),
  }
}

async function appendExternalDerivativesRunLedgerIfEnabled(
  report: ExternalDerivativesCollectReport,
  runLedgerPath: string,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) return
  await mkdir(dirname(runLedgerPath), { recursive: true })
  appendJsonlSync(runLedgerPath, buildExternalDerivativesRunLedgerRow(report))
}

interface PreviousExternalDerivativesReportStatus {
  ageMs: number | null
  stale: boolean
  runId: string | null
}

async function readPreviousExternalDerivativesReportStatus(
  reportPath: string,
  nowMs: number,
  staleReportMs: number,
): Promise<PreviousExternalDerivativesReportStatus> {
  if (!existsSync(reportPath)) return { ageMs: null, stale: false, runId: null }
  try {
    const parsed = JSON.parse(await readFile(reportPath, 'utf-8')) as Record<string, unknown>
    const generatedAtRaw = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null
    const generatedAtMs = generatedAtRaw ? Date.parse(generatedAtRaw) : NaN
    const ageMs = Number.isFinite(generatedAtMs) ? Math.max(0, nowMs - generatedAtMs) : null
    return {
      ageMs,
      stale: ageMs == null ? true : ageMs > staleReportMs,
      runId: typeof parsed.runId === 'string' && parsed.runId ? parsed.runId : null,
    }
  } catch {
    return { ageMs: null, stale: true, runId: null }
  }
}

function defaultCollectorLockDir(outputPath: string): string {
  return outputPath === DEFAULT_OUTPUT_PATH
    ? 'data/runtime/locks/external_derivatives_data_collect.collector.lock'
    : join(dirname(resolve(outputPath)), 'external_derivatives_data_collect.collector.lock')
}

async function fetchEndpointRowsWithRetries(input: {
  symbol: string
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>
  period: string
  baseUrl: string
  fetchImpl: FetchLike
  fetchTimeoutMs: number
  maxRetries: number
}): Promise<{
  rows: ExternalDerivativesRow[]
  error: string | null
  errorClass: ExternalFetchErrorClass | null
  diagnostic: ExternalDerivativesCollectReport['endpointDiagnostics'][number]
}> {
  const url = buildEndpointUrl(input.symbol, input.endpoint, input.period, input.baseUrl)
  const sourceEndpoint = sourceEndpointPath(input.endpoint)
  const startedAtMs = Date.now()
  let attempts = 0
  let lastError: string | null = null
  let lastErrorClass: ExternalFetchErrorClass | null = null
  const attemptErrors: Array<{ attempt: number; error: string; errorClass: ExternalFetchErrorClass }> = []
  const maxAttempts = Math.max(1, input.maxRetries + 1)
  const diagnosticUrl = redactExternalDiagnosticText(url)
  while (attempts < maxAttempts) {
    attempts += 1
    try {
      const rows = await fetchEndpointRows(input)
      const firstRow = rows[0]
      return {
        rows,
        error: null,
        errorClass: null,
        diagnostic: {
          symbol: input.symbol,
          endpoint: input.endpoint,
          sourceEndpoint,
          url: diagnosticUrl,
          attempts,
          status: 'ok',
          fetchedRows: rows.length,
          error: null,
          errorClass: null,
          attemptErrors,
          startedAt: new Date(startedAtMs).toISOString(),
          finishedAt: new Date().toISOString(),
          fetchLatencyMs: firstRow?.fetchLatencyMs ?? null,
          decodeLatencyMs: firstRow?.decodeLatencyMs ?? null,
          processingLatencyMs: firstRow?.processingLatencyMs ?? null,
          processingLatencyBasis: firstRow?.processingLatencyBasis ?? null,
        },
      }
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error)
      lastError = redactExternalDiagnosticText(rawError)
      lastErrorClass = classifyExternalFetchError(error)
      attemptErrors.push({
        attempt: attempts,
        error: lastError,
        errorClass: lastErrorClass,
      })
      if (attempts < maxAttempts) await sleep(Math.min(250, attempts * 50))
    }
  }
  const finishedAtMs = Date.now()
  return {
    rows: [],
    error: lastError ?? 'unknown fetch error',
    errorClass: lastErrorClass ?? classifyExternalFetchError(lastError ?? 'unknown fetch error'),
    diagnostic: {
      symbol: input.symbol,
      endpoint: input.endpoint,
      sourceEndpoint,
      url: diagnosticUrl,
      attempts,
      status: 'error',
      fetchedRows: 0,
      error: lastError ?? 'unknown fetch error',
      errorClass: lastErrorClass ?? classifyExternalFetchError(lastError ?? 'unknown fetch error'),
      attemptErrors,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(finishedAtMs).toISOString(),
      fetchLatencyMs: null,
      decodeLatencyMs: null,
      processingLatencyMs: Math.max(0, finishedAtMs - startedAtMs),
      processingLatencyBasis: 'fetch_start_to_row_built',
    },
  }
}

async function fetchEndpointRows(input: {
  symbol: string
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>
  period: string
  baseUrl: string
  fetchImpl: FetchLike
  fetchTimeoutMs: number
}): Promise<ExternalDerivativesRow[]> {
  const fetchStartedAtMs = Date.now()
  const fetchTimestamp = new Date(fetchStartedAtMs).toISOString()
  const url = buildEndpointUrl(input.symbol, input.endpoint, input.period, input.baseUrl)
  const response = await fetchWithTimeout(input.fetchImpl, url, input.fetchTimeoutMs)
  const payloadReceivedAtMs = Date.now()
  const payloadReceivedAt = new Date(payloadReceivedAtMs).toISOString()
  const text = await response.text()
  const rawBodyHash = sha256Hex(text)
  const payloadDecodedAtMs = Date.now()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${url}: ${text.slice(0, 240)}`)
  }
  const parsed = JSON.parse(text) as unknown
  const payloadParsedAtMs = Date.now()
  const payloads = Array.isArray(parsed) ? parsed : [parsed]
  const fetchBucketMs = floorToBucket(fetchStartedAtMs, 5 * 60_000)
  return payloads.flatMap(payload => {
    assertPayloadSymbolMatches(payload, input.symbol, input.endpoint)
    const sourceTimestamp = extractSourceTimestampMs(input.endpoint, payload, fetchBucketMs)
    if (sourceTimestamp === null) return []
    const row = buildExternalDerivativesRow({
      endpoint: input.endpoint,
      symbol: input.symbol,
      period: input.period,
      payload,
      rawBodyHash,
      sourceTimestampMs: sourceTimestamp.value,
      sourceTimestampBasis: sourceTimestamp.basis,
      fetchTimestamp,
      payloadReceivedAt,
      fetchLatencyMs: Math.max(0, payloadReceivedAtMs - fetchStartedAtMs),
      decodeLatencyMs: Math.max(0, payloadParsedAtMs - payloadReceivedAtMs),
      processingLatencyMs: Math.max(0, Date.now() - fetchStartedAtMs),
      fetchBucketMs,
    })
    return [row]
  })
}

function buildExternalDerivativesRow(input: {
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>
  symbol: string
  period: string
  payload: unknown
  rawBodyHash: string
  sourceTimestampMs: number
  sourceTimestampBasis: 'exchange_event' | 'fetch_bucket'
  fetchTimestamp: string
  payloadReceivedAt: string
  fetchLatencyMs: number
  decodeLatencyMs: number
  processingLatencyMs: number
  fetchBucketMs: number
}): ExternalDerivativesRow {
  const rawPayload = stableJson(input.payload)
  return {
    schemaVersion: SCHEMA_VERSION,
    exchange: 'binance',
    market: 'usdm',
    symbol: input.symbol,
    sourceEndpoint: sourceEndpointPath(input.endpoint),
    sourceTimestamp: new Date(input.sourceTimestampMs).toISOString(),
    sourceTimestampBasis: input.sourceTimestampBasis,
    fetchTimestamp: input.fetchTimestamp,
    payloadReceivedAt: input.payloadReceivedAt,
    ingestedAt: new Date().toISOString(),
    fetchLatencyMs: input.fetchLatencyMs,
    decodeLatencyMs: input.decodeLatencyMs,
    processingLatencyMs: input.processingLatencyMs,
    processingLatencyBasis: 'fetch_start_to_row_built',
    appendLatencyMs: null,
    appendLatencyBasis: null,
    ingestionLatencyMs: null,
    ingestionLatencyBasis: null,
    dedupKey: buildExternalDerivativesDedupKey({
      endpoint: input.endpoint,
      symbol: input.symbol,
      period: input.period,
      sourceTimestampMs: input.sourceTimestampMs,
      fetchBucketMs: input.sourceTimestampBasis === 'fetch_bucket' ? input.fetchBucketMs : undefined,
    }),
    rawPayloadHash: sha256Hex(rawPayload),
    payloadHashBasis: 'canonical_json_payload',
    rawBodyHash: input.rawBodyHash,
    payload: input.payload,
  }
}

function buildEndpointUrl(
  symbol: string,
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>,
  period: string,
  baseUrl = BINANCE_USDM_BASE_URL,
): string {
  const params = new URLSearchParams({ symbol })
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl)
  if (endpoint === 'fundingRate') {
    params.set('limit', '3')
    return `${normalizedBaseUrl}/fapi/v1/fundingRate?${params.toString()}`
  }
  if (endpoint === 'premiumIndex') {
    return `${normalizedBaseUrl}/fapi/v1/premiumIndex?${params.toString()}`
  }
  if (endpoint === 'openInterest') {
    return `${normalizedBaseUrl}/fapi/v1/openInterest?${params.toString()}`
  }
  params.set('period', period)
  params.set('limit', '3')
  if (endpoint === 'openInterestHist') {
    return `${normalizedBaseUrl}/futures/data/openInterestHist?${params.toString()}`
  }
  return `${normalizedBaseUrl}/futures/data/globalLongShortAccountRatio?${params.toString()}`
}

function extractSourceTimestampMs(
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>,
  payload: unknown,
  fetchBucketMs: number,
): { value: number; basis: 'exchange_event' | 'fetch_bucket' } | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  const raw = endpoint === 'fundingRate'
    ? record.fundingTime
    : endpoint === 'openInterest' || endpoint === 'premiumIndex'
      ? record.time
      : record.timestamp
  const timestamp = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return { value: timestamp, basis: 'exchange_event' }
  }
  if (endpoint === 'openInterest' || endpoint === 'premiumIndex') {
    return { value: fetchBucketMs, basis: 'fetch_bucket' }
  }
  return null
}

function assertPayloadSymbolMatches(
  payload: unknown,
  requestedSymbol: string,
  endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>,
): void {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return
  const record = payload as Record<string, unknown>
  const rawSymbol = typeof record.symbol === 'string'
    ? record.symbol
    : typeof record.pair === 'string'
      ? record.pair
      : null
  if (!rawSymbol) return
  if (rawSymbol.toUpperCase() !== requestedSymbol.toUpperCase()) {
    throw new Error(`payload symbol mismatch endpoint=${endpoint} requested=${requestedSymbol} payload=${rawSymbol}`)
  }
}

function classifyExternalFetchError(error: unknown): ExternalFetchErrorClass {
  const message = error instanceof SyntaxError
    ? `json_parse ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error)
  const lower = message.toLowerCase()
  if (error instanceof SyntaxError || lower.includes('json_parse') || lower.includes('unexpected token')) return 'json_parse'
  if (lower.includes('payload symbol mismatch') || lower.includes('invalid payload')) return 'payload_schema'
  if (lower.includes('timeout') || lower.includes('aborted') || lower.includes('etimedout')) return 'timeout'
  if (lower.includes('http 4') || lower.includes('http 5')) return 'http'
  if (lower.includes('enotfound') || lower.includes('eai_again') || lower.includes('getaddrinfo')) return 'dns'
  if (lower.includes('proxy')) return 'proxy'
  if (lower.includes('tls') || lower.includes('certificate') || lower.includes('ssl')) return 'tls'
  return 'network_or_unknown'
}

function redactExternalDiagnosticText(value: string): string {
  let redacted = value
  redacted = redacted.replace(/\bhttps?:\/\/[^\s/@:]+:[^\s/@]+@/gi, match => {
    const protocol = match.match(/^https?:\/\//i)?.[0] ?? ''
    return `${protocol}***:***@`
  })
  redacted = redacted.replace(
    /([?&](?:api[_-]?key|apikey|signature|token|secret|key|password|pass)=)[^&\s]+/gi,
    '$1***',
  )
  return redacted
}

function withIngestionTimestamps(
  row: ExternalDerivativesRow,
  evidence: Partial<ExternalDerivativesRow> = {},
): ExternalDerivativesRow {
  const ingestedAtMs = Date.now()
  const payloadReceivedAtMs = Date.parse(row.payloadReceivedAt)
  const appendLatencyMs = Number.isFinite(payloadReceivedAtMs)
    ? Math.max(0, ingestedAtMs - payloadReceivedAtMs)
    : row.processingLatencyMs
  return {
    ...row,
    ...evidence,
    ingestedAt: new Date(ingestedAtMs).toISOString(),
    processingLatencyMs: row.processingLatencyMs,
    processingLatencyBasis: row.processingLatencyBasis,
    appendLatencyMs,
    appendLatencyBasis: 'payload_received_to_jsonl_append',
    ingestionLatencyMs: appendLatencyMs,
    ingestionLatencyBasis: 'payload_received_to_jsonl_append',
  }
}

function sourceEndpointPath(endpoint: Exclude<ExternalDerivativesEndpoint, 'all'>): string {
  if (endpoint === 'fundingRate') return '/fapi/v1/fundingRate'
  if (endpoint === 'premiumIndex') return '/fapi/v1/premiumIndex'
  if (endpoint === 'openInterest') return '/fapi/v1/openInterest'
  if (endpoint === 'openInterestHist') return '/futures/data/openInterestHist'
  return '/futures/data/globalLongShortAccountRatio'
}

async function readExistingDedupRows(path: string): Promise<Map<string, string | null>> {
  const rows = new Map<string, string | null>()
  if (!existsSync(path)) return rows
  const stream = createReadStream(path, { encoding: 'utf-8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      if (typeof parsed.dedupKey === 'string' && parsed.dedupKey) {
        rows.set(
          parsed.dedupKey,
          typeof parsed.rawPayloadHash === 'string' && parsed.rawPayloadHash ? parsed.rawPayloadHash : null,
        )
      }
    } catch {
      // Ignore corrupt historical rows; they are diagnostics, not dedup anchors.
    }
  }
  return rows
}

function expandEndpoints(endpoint: ExternalDerivativesEndpoint): Exclude<ExternalDerivativesEndpoint, 'all'>[] {
  if (endpoint === 'all') return ['fundingRate', 'premiumIndex', 'openInterest', 'openInterestHist', 'longShort']
  if (endpoint === 'fundingRate' || endpoint === 'premiumIndex' || endpoint === 'openInterest' || endpoint === 'openInterestHist' || endpoint === 'longShort') {
    return [endpoint]
  }
  throw new Error(`Unsupported endpoint: ${endpoint}`)
}

function parseSymbols(raw: string): string[] {
  return raw.split(',')
    .map(symbol => symbol.trim().toUpperCase())
    .filter(Boolean)
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const keyValue = token.slice(2)
    const eq = keyValue.indexOf('=')
    if (eq >= 0) {
      out.set(keyValue.slice(0, eq), keyValue.slice(eq + 1))
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(keyValue, next)
      index += 1
    } else {
      out.set(keyValue, 'true')
    }
  }
  return out
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function parseNonNegativeInteger(raw: string | undefined, fallback: number): number {
  if (raw == null) return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function normalizeBaseUrl(raw: string): string {
  const url = new URL(raw.trim())
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported Binance base URL protocol: ${url.protocol}`)
  }
  return url.toString().replace(/\/$/, '')
}

function resolveProxyConfig(raw: Map<string, string>): { proxyUrl?: string; proxySource?: string } {
  const cliProxy = normalizeOptionalString(raw.get('proxyUrl'))
  if (cliProxy) return { proxyUrl: cliProxy, proxySource: 'cli' }
  const envCandidates: Array<[string, string | undefined]> = [
    ['OPENALICE_BINANCE_PROXY_URL', process.env.OPENALICE_BINANCE_PROXY_URL],
    ['HTTPS_PROXY', process.env.HTTPS_PROXY],
    ['https_proxy', process.env.https_proxy],
    ['HTTP_PROXY', process.env.HTTP_PROXY],
    ['http_proxy', process.env.http_proxy],
  ]
  for (const [source, value] of envCandidates) {
    const normalized = normalizeOptionalString(value)
    if (normalized) return { proxyUrl: normalized, proxySource: `env:${source}` }
  }
  return {}
}

function normalizeOptionalString(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function buildDefaultExternalFetch(proxyUrl: string | undefined): FetchLike {
  if (!proxyUrl) return globalThis.fetch as FetchLike
  return async (url: string) => {
    const dispatcher = proxyDispatcher(proxyUrl)
    const response = await request(url, { dispatcher })
    const body = await response.body.text()
    return {
      ok: response.statusCode >= 200 && response.statusCode < 300,
      status: response.statusCode,
      text: async () => body,
    }
  }
}

function proxyDispatcher(proxyUrl: string): ProxyAgent {
  const existing = proxyDispatchers.get(proxyUrl)
  if (existing) return existing
  const dispatcher = new ProxyAgent(proxyUrl)
  proxyDispatchers.set(proxyUrl, dispatcher)
  return dispatcher
}

async function fetchWithTimeout(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<FetchLikeResponse> {
  let timeout: NodeJS.Timeout | null = null
  try {
    return await Promise.race([
      fetchImpl(url),
      new Promise<FetchLikeResponse>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`fetch timeout after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function defaultReportPath(outputPath: string): string {
  return outputPath === DEFAULT_OUTPUT_PATH
    ? 'data/runtime/external_derivatives_data_collect.latest.json'
    : join(dirname(resolve(outputPath)), 'external_derivatives_data_collect.latest.json')
}

function defaultRunLedgerPath(outputPath: string): string {
  return outputPath === DEFAULT_OUTPUT_PATH
    ? DEFAULT_RUN_LEDGER_PATH
    : join(dirname(resolve(outputPath)), 'external_derivatives_data_collect.runs.jsonl')
}

function floorToBucket(value: number, bucketMs: number): number {
  return Math.floor(value / bucketMs) * bucketMs
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJsonValue(item)]),
  )
}

async function main(): Promise<void> {
  const args = parseExternalDerivativesCollectArgs(process.argv.slice(2))
  const report = await collectExternalDerivativesData(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`external derivatives collect: appended=${report.appendedRows} skippedDuplicate=${report.skippedDuplicateRows} errors=${report.errors.length}`)
  }
  if (report.errors.length > 0) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
