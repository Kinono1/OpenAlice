import { mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { writeJsonAtomic } from './atomic_write.js'
import { appendJsonlSync } from './runtime_events.js'

export const PAPER_EVIDENCE_SCHEMA_VERSION = 'paper_evidence_report.v4_1'
export const PAPER_EVIDENCE_LEDGER_SCHEMA_VERSION = 'paper_evidence_ledger.v4_1'
export const PAPER_EVIDENCE_POINTER_SCHEMA_VERSION = 'paper_evidence_latest_pointer.v4_1'

export const DEFAULT_PAPER_EVIDENCE_ROOT = 'runtime/paper'
export const DEFAULT_MAX_REPORT_AGE_SECONDS = 900
export const PAPER_EVIDENCE_LEDGER_FILE_NAME = 'evidence_ledger.jsonl'

export type PaperDataMode = 'auto' | 'live_only'
export type PaperFreshnessStatus = 'fresh' | 'stale'
export type PaperEvidencePointerStatus = 'ok' | 'stale_report_halt' | 'missing_freshness_seal'

export interface PaperEvidenceBlockingReason {
  code: string
  source: string
  severity: 'hard_block'
  observed?: string
  required?: string
}

export interface PaperFreshnessSeal {
  maxAllowedAgeSeconds: number
  actualAgeSeconds: number
  status: PaperFreshnessStatus
}

export interface PaperEvidenceReport {
  schemaVersion: typeof PAPER_EVIDENCE_SCHEMA_VERSION
  reportId: string
  generatedAt: string
  sourceRunId: string
  runtimeCommit: string
  dataManifestHash: string
  paperDataMode: PaperDataMode
  freshness: PaperFreshnessSeal
  sourceSummaryPath: string
  sourceSummaryHash: string
  paperDecisionPath?: string | null
  paperDecisionHash?: string | null
  summary: unknown
}

export interface PaperEvidenceLedgerEntry {
  schemaVersion: typeof PAPER_EVIDENCE_LEDGER_SCHEMA_VERSION
  reportId: string
  generatedAt: string
  path: string
  sourceRunId: string
  paperDataMode: PaperDataMode
  freshnessStatus: PaperFreshnessStatus
  sourceSummaryHash: string
}

export interface LatestPaperEvidencePointer {
  schemaVersion: typeof PAPER_EVIDENCE_POINTER_SCHEMA_VERSION
  latestReportId: string
  path: string
  updatedAt: string
}

export interface PaperEvidenceWriteResult {
  reportPath: string
  ledgerPath: string
  latestPointerPath: string
  ledgerEntry: PaperEvidenceLedgerEntry
  latestPointer: LatestPaperEvidencePointer
}

export interface BuildPaperEvidenceReportInput {
  summary: unknown
  summaryPath: string
  sourceRunId?: string
  runtimeCommit?: string
  dataManifestHash?: string
  paperDataMode?: PaperDataMode
  paperDecisionPath?: string | null
  paperDecision?: unknown
  now?: Date
  maxAllowedAgeSeconds?: number
}

export interface WritePaperEvidenceReportInput {
  report: PaperEvidenceReport
  root?: string
}

export interface PaperEvidencePointerEvaluation {
  status: PaperEvidencePointerStatus
  blockNewOpens: boolean
  forceCloseExisting: boolean
  alert: boolean
  effectiveFreshness: PaperFreshnessSeal | null
  blockingReasons: PaperEvidenceBlockingReason[]
}

export interface PaperEvidenceLedgerBindingEvaluation {
  matchedEntry: PaperEvidenceLedgerEntry | null
  blockingReasons: PaperEvidenceBlockingReason[]
}

export function buildPaperFreshnessSeal(
  generatedAt: string,
  now = new Date(),
  maxAllowedAgeSeconds = DEFAULT_MAX_REPORT_AGE_SECONDS,
): PaperFreshnessSeal {
  const generatedMs = Date.parse(generatedAt)
  const nowMs = now.getTime()
  const actualAgeSeconds = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((nowMs - generatedMs) / 1000))
    : Number.MAX_SAFE_INTEGER

  return {
    maxAllowedAgeSeconds,
    actualAgeSeconds,
    status: actualAgeSeconds <= maxAllowedAgeSeconds ? 'fresh' : 'stale',
  }
}

export function buildPaperEvidenceReport(input: BuildPaperEvidenceReportInput): PaperEvidenceReport {
  const generatedAt = readGeneratedAt(input.summary) ?? (input.now ?? new Date()).toISOString()
  const sourceSummaryHash = hashStableJson(input.summary)
  const reportId = buildPaperReportId(generatedAt, sourceSummaryHash)
  const paperDataMode = input.paperDataMode ?? readPaperDataMode(input.summary) ?? 'auto'
  const sourceRunId = input.sourceRunId ?? reportId

  return {
    schemaVersion: PAPER_EVIDENCE_SCHEMA_VERSION,
    reportId,
    generatedAt,
    sourceRunId,
    runtimeCommit: input.runtimeCommit ?? 'unknown',
    dataManifestHash: input.dataManifestHash ?? 'unknown',
    paperDataMode,
    freshness: buildPaperFreshnessSeal(
      generatedAt,
      input.now ?? new Date(),
      input.maxAllowedAgeSeconds ?? DEFAULT_MAX_REPORT_AGE_SECONDS,
    ),
    sourceSummaryPath: normalizeArtifactPath(input.summaryPath),
    sourceSummaryHash,
    paperDecisionPath: input.paperDecisionPath ? normalizeArtifactPath(input.paperDecisionPath) : null,
    paperDecisionHash: input.paperDecision === undefined ? null : hashStableJson(input.paperDecision),
    summary: input.summary,
  }
}

export function writePaperEvidenceReport(input: WritePaperEvidenceReportInput): PaperEvidenceWriteResult {
  const root = input.root ?? DEFAULT_PAPER_EVIDENCE_ROOT
  const reportPath = resolve(root, 'reports', `${input.report.reportId}.json`)
  const ledgerPath = resolve(root, 'evidence_ledger.jsonl')
  const latestPointerPath = resolve(root, 'latest_pointer.json')
  const pointer: LatestPaperEvidencePointer = {
    schemaVersion: PAPER_EVIDENCE_POINTER_SCHEMA_VERSION,
    latestReportId: input.report.reportId,
    path: normalizeArtifactPath(reportPath),
    updatedAt: new Date().toISOString(),
  }
  const ledgerEntry: PaperEvidenceLedgerEntry = {
    schemaVersion: PAPER_EVIDENCE_LEDGER_SCHEMA_VERSION,
    reportId: input.report.reportId,
    generatedAt: input.report.generatedAt,
    path: normalizeArtifactPath(reportPath),
    sourceRunId: input.report.sourceRunId,
    paperDataMode: input.report.paperDataMode,
    freshnessStatus: input.report.freshness.status,
    sourceSummaryHash: input.report.sourceSummaryHash,
  }

  mkdirSync(join(root, 'reports'), { recursive: true })
  writeJsonAtomic(reportPath, paperEvidenceReportToJson(input.report))
  appendJsonlSync(ledgerPath, paperEvidenceLedgerEntryToJson(ledgerEntry))
  writeJsonAtomic(latestPointerPath, latestPaperEvidencePointerToJson(pointer))

  return {
    reportPath,
    ledgerPath,
    latestPointerPath,
    ledgerEntry,
    latestPointer: pointer,
  }
}

export function readLatestPaperEvidencePointer(path: string): LatestPaperEvidencePointer {
  return latestPaperEvidencePointerFromJson(JSON.parse(readFileSync(path, 'utf-8')) as unknown)
}

export function readPaperEvidenceLedger(path: string): PaperEvidenceLedgerEntry[] {
  assertPaperEvidenceLedgerPath(path)
  return parsePaperEvidenceLedgerJsonl(readFileSync(path, 'utf-8'))
}

export function assertPaperEvidenceLedgerPath(path: string): void {
  const normalized = normalizeArtifactPath(path)
  if (normalized.includes('paper_policy_shadow')) {
    throw new Error('PAPER_EVIDENCE_LEDGER_PATH_IS_SHADOW_LEDGER')
  }
  if (!normalized.endsWith(`/${PAPER_EVIDENCE_LEDGER_FILE_NAME}`) && normalized !== PAPER_EVIDENCE_LEDGER_FILE_NAME) {
    throw new Error('PAPER_EVIDENCE_LEDGER_PATH_NOT_CANONICAL')
  }
}

export function parsePaperEvidenceLedgerJsonl(raw: string): PaperEvidenceLedgerEntry[] {
  const entries: PaperEvidenceLedgerEntry[] = []
  const lines = raw.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      entries.push(paperEvidenceLedgerEntryFromJson(JSON.parse(line) as unknown))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`CORRUPT_PAPER_EVIDENCE_LEDGER line ${index + 1}: ${message}`)
    }
  }
  return entries
}

export function paperEvidenceReportFromJson(value: unknown): PaperEvidenceReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paper evidence report must be an object')
  }
  const raw = value as Record<string, unknown>
  const freshnessRaw = raw.freshness
  if (!freshnessRaw || typeof freshnessRaw !== 'object' || Array.isArray(freshnessRaw)) {
    throw new Error('freshness must be an object')
  }
  const freshness = freshnessRaw as Record<string, unknown>
  return {
    schemaVersion: requireLiteral(raw.schema_version, PAPER_EVIDENCE_SCHEMA_VERSION, 'schema_version'),
    reportId: requireString(raw.report_id, 'report_id'),
    generatedAt: requireString(raw.generated_at, 'generated_at'),
    sourceRunId: requireString(raw.source_run_id, 'source_run_id'),
    runtimeCommit: requireString(raw.runtime_commit, 'runtime_commit'),
    dataManifestHash: requireString(raw.data_manifest_hash, 'data_manifest_hash'),
    paperDataMode: requirePaperDataMode(raw.paper_data_mode),
    freshness: {
      maxAllowedAgeSeconds: requireNumber(freshness.max_allowed_age_seconds, 'max_allowed_age_seconds'),
      actualAgeSeconds: requireNumber(freshness.actual_age_seconds, 'actual_age_seconds'),
      status: requireFreshnessStatus(freshness.status),
    },
    sourceSummaryPath: requireString(raw.source_summary_path, 'source_summary_path'),
    sourceSummaryHash: requireString(raw.source_summary_hash, 'source_summary_hash'),
    paperDecisionPath: readNullableString(raw.paper_decision_path, 'paper_decision_path'),
    paperDecisionHash: readNullableString(raw.paper_decision_hash, 'paper_decision_hash'),
    summary: raw.summary,
  }
}

export function refreshPaperEvidenceReportFreshness(
  report: PaperEvidenceReport,
  now = new Date(),
): PaperEvidenceReport {
  return {
    ...report,
    freshness: buildPaperFreshnessSeal(
      report.generatedAt,
      now,
      report.freshness.maxAllowedAgeSeconds,
    ),
  }
}

export function evaluatePaperEvidencePointer(
  pointer: LatestPaperEvidencePointer | null,
  report: Pick<PaperEvidenceReport, 'freshness' | 'generatedAt' | 'reportId' | 'paperDataMode'> | null,
  now = new Date(),
): PaperEvidencePointerEvaluation {
  if (!pointer || !report) {
    return staleReportHalt('MISSING_PAPER_EVIDENCE_REPORT', 'paper_evidence_ledger', 'latest paper report')
  }
  if (!report.freshness) {
    return staleReportHalt('MISSING_FRESHNESS_SEAL', 'paper_evidence_report', 'freshness seal')
  }
  const effectiveFreshness = buildPaperFreshnessSeal(
    report.generatedAt,
    now,
    report.freshness.maxAllowedAgeSeconds,
  )
  const blockingReasons: PaperEvidencePointerEvaluation['blockingReasons'] = []
  if (pointer.latestReportId !== report.reportId) {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_POINTER_REPORT_MISMATCH',
      source: 'paper_evidence_latest_pointer',
      severity: 'hard_block',
      required: report.reportId,
      observed: pointer.latestReportId,
    })
  }
  if (report.paperDataMode !== 'live_only') {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_NOT_LIVE_ONLY',
      source: 'paper_evidence_report',
      severity: 'hard_block',
      required: 'paper_data_mode=live_only',
      observed: report.paperDataMode,
    })
  }
  if (effectiveFreshness.status === 'stale') {
    const stale = staleReportHalt(
      'STALE_PAPER_EVIDENCE_REPORT',
      'paper_evidence_report',
      'fresh paper report',
      effectiveFreshness,
    )
    return {
      ...stale,
      blockingReasons: [
        ...blockingReasons,
        ...stale.blockingReasons,
      ],
    }
  }
  if (blockingReasons.length > 0) {
    return {
      status: 'stale_report_halt',
      blockNewOpens: true,
      forceCloseExisting: false,
      alert: true,
      effectiveFreshness,
      blockingReasons,
    }
  }
  return {
    status: 'ok',
    blockNewOpens: false,
    forceCloseExisting: false,
    alert: false,
    effectiveFreshness,
    blockingReasons: [],
  }
}

export function evaluatePaperEvidenceLedgerBinding(
  pointer: LatestPaperEvidencePointer | null,
  report: Pick<PaperEvidenceReport, 'reportId' | 'generatedAt' | 'paperDataMode' | 'sourceSummaryHash'> | null,
  ledgerEntries: readonly PaperEvidenceLedgerEntry[] | null,
): PaperEvidenceLedgerBindingEvaluation {
  if (!pointer || !report) {
    return {
      matchedEntry: null,
      blockingReasons: [{
        code: 'MISSING_PAPER_EVIDENCE_LEDGER_CONTEXT',
        source: 'paper_evidence_ledger',
        severity: 'hard_block',
        required: 'latest pointer and paper evidence report',
        observed: 'missing',
      }],
    }
  }
  if (!ledgerEntries || ledgerEntries.length === 0) {
    return {
      matchedEntry: null,
      blockingReasons: [{
        code: 'MISSING_PAPER_EVIDENCE_LEDGER',
        source: 'paper_evidence_ledger',
        severity: 'hard_block',
        required: `ledger row for report_id=${report.reportId}`,
        observed: 'missing',
      }],
    }
  }

  const matches = ledgerEntries.filter((entry) => entry.reportId === report.reportId)
  const entry = matches.at(-1) ?? null
  if (!entry) {
    return {
      matchedEntry: null,
      blockingReasons: [{
        code: 'PAPER_EVIDENCE_REPORT_NOT_IN_LEDGER',
        source: 'paper_evidence_ledger',
        severity: 'hard_block',
        required: report.reportId,
        observed: ledgerEntries.at(-1)?.reportId ?? 'none',
      }],
    }
  }

  const blockingReasons: PaperEvidenceBlockingReason[] = []
  if (normalizeArtifactPath(entry.path) !== normalizeArtifactPath(pointer.path)) {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_LEDGER_PATH_MISMATCH',
      source: 'paper_evidence_ledger',
      severity: 'hard_block',
      required: normalizeArtifactPath(pointer.path),
      observed: normalizeArtifactPath(entry.path),
    })
  }
  if (entry.generatedAt !== report.generatedAt) {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_LEDGER_GENERATED_AT_MISMATCH',
      source: 'paper_evidence_ledger',
      severity: 'hard_block',
      required: report.generatedAt,
      observed: entry.generatedAt,
    })
  }
  if (entry.paperDataMode !== report.paperDataMode) {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_LEDGER_DATA_MODE_MISMATCH',
      source: 'paper_evidence_ledger',
      severity: 'hard_block',
      required: report.paperDataMode,
      observed: entry.paperDataMode,
    })
  }
  if (entry.sourceSummaryHash !== report.sourceSummaryHash) {
    blockingReasons.push({
      code: 'PAPER_EVIDENCE_LEDGER_SOURCE_SUMMARY_HASH_MISMATCH',
      source: 'paper_evidence_ledger',
      severity: 'hard_block',
      required: report.sourceSummaryHash,
      observed: entry.sourceSummaryHash,
    })
  }

  return {
    matchedEntry: blockingReasons.length === 0 ? entry : null,
    blockingReasons,
  }
}

export function paperEvidenceReportToJson(report: PaperEvidenceReport): Record<string, unknown> {
  return {
    schema_version: report.schemaVersion,
    report_id: report.reportId,
    generated_at: report.generatedAt,
    source_run_id: report.sourceRunId,
    runtime_commit: report.runtimeCommit,
    data_manifest_hash: report.dataManifestHash,
    paper_data_mode: report.paperDataMode,
    freshness: paperFreshnessSealToJson(report.freshness),
    source_summary_path: report.sourceSummaryPath,
    source_summary_hash: report.sourceSummaryHash,
    paper_decision_path: report.paperDecisionPath ?? null,
    paper_decision_hash: report.paperDecisionHash ?? null,
    summary: report.summary,
  }
}

export function paperEvidenceLedgerEntryToJson(entry: PaperEvidenceLedgerEntry): Record<string, unknown> {
  return {
    schema_version: entry.schemaVersion,
    report_id: entry.reportId,
    generated_at: entry.generatedAt,
    path: entry.path,
    source_run_id: entry.sourceRunId,
    paper_data_mode: entry.paperDataMode,
    freshness_status: entry.freshnessStatus,
    source_summary_hash: entry.sourceSummaryHash,
  }
}

export function paperEvidenceLedgerEntryFromJson(value: unknown): PaperEvidenceLedgerEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('paper evidence ledger entry must be an object')
  }
  const raw = value as Record<string, unknown>
  return {
    schemaVersion: requireLiteral(
      raw.schema_version,
      PAPER_EVIDENCE_LEDGER_SCHEMA_VERSION,
      'schema_version',
    ),
    reportId: requireString(raw.report_id, 'report_id'),
    generatedAt: requireString(raw.generated_at, 'generated_at'),
    path: requireString(raw.path, 'path'),
    sourceRunId: requireString(raw.source_run_id, 'source_run_id'),
    paperDataMode: requirePaperDataMode(raw.paper_data_mode),
    freshnessStatus: requireFreshnessStatus(raw.freshness_status),
    sourceSummaryHash: requireString(raw.source_summary_hash, 'source_summary_hash'),
  }
}

export function latestPaperEvidencePointerToJson(pointer: LatestPaperEvidencePointer): Record<string, unknown> {
  return {
    schema_version: pointer.schemaVersion,
    latest_report_id: pointer.latestReportId,
    path: pointer.path,
    updated_at: pointer.updatedAt,
  }
}

export function paperFreshnessSealToJson(seal: PaperFreshnessSeal): Record<string, unknown> {
  return {
    max_allowed_age_seconds: seal.maxAllowedAgeSeconds,
    actual_age_seconds: seal.actualAgeSeconds,
    status: seal.status,
  }
}

export function latestPaperEvidencePointerFromJson(value: unknown): LatestPaperEvidencePointer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('latest paper evidence pointer must be an object')
  }
  const raw = value as Record<string, unknown>
  return {
    schemaVersion: requireLiteral(
      raw.schema_version,
      PAPER_EVIDENCE_POINTER_SCHEMA_VERSION,
      'schema_version',
    ),
    latestReportId: requireString(raw.latest_report_id, 'latest_report_id'),
    path: requireString(raw.path, 'path'),
    updatedAt: requireString(raw.updated_at, 'updated_at'),
  }
}

function staleReportHalt(
  code: string,
  source: string,
  required: string,
  effectiveFreshness: PaperFreshnessSeal | null = null,
): PaperEvidencePointerEvaluation {
  return {
    status: code === 'MISSING_FRESHNESS_SEAL' ? 'missing_freshness_seal' : 'stale_report_halt',
    blockNewOpens: true,
    forceCloseExisting: false,
    alert: true,
    effectiveFreshness,
    blockingReasons: [{
      code,
      source,
      severity: 'hard_block',
      required,
      observed: 'missing_or_stale',
    }],
  }
}

function buildPaperReportId(generatedAt: string, sourceSummaryHash: string): string {
  const stamp = formatReportIdTimestamp(generatedAt)
  return `paper_${stamp}_${sourceSummaryHash.replace(/^sha256:/, '').slice(0, 16)}`
}

function formatReportIdTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/, 'Z')
  }
  return value.replaceAll(/[^0-9A-Za-z]/g, '').slice(0, 16) || 'unknown_time'
}

function readGeneratedAt(summary: unknown): string | undefined {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined
  const raw = summary as Record<string, unknown>
  return typeof raw.generatedAt === 'string' && raw.generatedAt.trim()
    ? raw.generatedAt
    : undefined
}

function readPaperDataMode(summary: unknown): PaperDataMode | undefined {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return undefined
  const raw = summary as Record<string, unknown>
  return raw.paperDataMode === 'auto' || raw.paperDataMode === 'live_only'
    ? raw.paperDataMode
    : undefined
}

function hashStableJson(value: unknown): string {
  return `sha256:${createHash('sha256').update(stableStringify(value), 'utf-8').digest('hex')}`
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value))
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize)
  if (!value || typeof value !== 'object') return value
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(raw).sort()) {
    const child = raw[key]
    if (child !== undefined) out[key] = stableNormalize(child)
  }
  return out
}

function normalizeArtifactPath(path: string): string {
  return resolve(path)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

function readNullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${field} must be a string or null`)
  return value
}

function requireLiteral<T extends string>(value: unknown, literal: T, field: string): T {
  if (value !== literal) {
    throw new Error(`${field} must be ${literal}`)
  }
  return literal
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`)
  }
  return value
}

function requirePaperDataMode(value: unknown): PaperDataMode {
  if (value === 'auto' || value === 'live_only') return value
  throw new Error('paper_data_mode must be auto or live_only')
}

function requireFreshnessStatus(value: unknown): PaperFreshnessStatus {
  if (value === 'fresh' || value === 'stale') return value
  throw new Error('freshness.status must be fresh or stale')
}
