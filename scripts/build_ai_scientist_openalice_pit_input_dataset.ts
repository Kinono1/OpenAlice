import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type DatasetStatus = 'research_dataset_ready_pit_blocked' | 'failed_no_rows' | 'blocked_missing_plan'

interface CliArgs {
  pitPlanPath: string
  outputPath: string
  reportPath: string | null
  maxCandidates: number
  maxRowsPerFile: number
  json: boolean
}

export interface NormalizedAiScientistPitInputRow {
  schemaVersion: 'openalice.ai_scientist.pit_input.normalized.v1'
  runId: string
  candidateId: string
  family: string
  source: 'ai_scientist_crypto_dl'
  exchange: 'binance' | 'unknown'
  market: 'usds_futures' | 'spot_or_unknown'
  symbol: string
  rawSymbol: string
  timeframe: string
  eventTime: string
  eventTimeMs: number
  eventTimeBasis: 'source_bar_open_time'
  availableAt: string
  availableAtMs: number
  availableAtBasis: 'row_explicit_available_at' | 'derived_bar_close_time'
  fetchedAt: string
  fetchedAtBasis: 'row_explicit_fetched_at' | 'source_file_mtime_recovered'
  observedAt: string
  observedAtBasis: 'row_explicit_observed_at' | 'row_explicit_observed_or_fetched_at' | 'source_file_mtime_recovered'
  generatedAt: string
  jobId: string
  sourceFilePath: string
  sourceFileMtime: string
  sourceFileSizeBytes: number
  sourceRowIndex: number
  sourceRowHash: string
  values: Record<string, number | string | null>
  quality: {
    promotionGrade: boolean
    pitLineageStatus: 'research_reproduction_ready' | 'research_reproduction_only_file_mtime_recovered'
    blockers: string[]
  }
}

export interface AiScientistPitInputDatasetReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: DatasetStatus
  sourceArtifacts: {
    pitPlan: string
  }
  outputPath: string
  jobId: string
  sampling: {
    maxCandidates: number
    maxRowsPerFile: number
    sampled: boolean
  }
  counts: {
    candidatesRead: number
    inputFilesRead: number
    csvFilesRead: number
    rowsRead: number
    rowsNormalized: number
    rowsDropped: number
    promotionGradeRows: number
    distinctSymbols: number
  }
  candidates: Array<{
    runId: string
    candidateId: string
    family: string
    files: number
    rowsNormalized: number
  }>
  symbols: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  outputHash: string | null
}

const DEFAULT_PIT_PLAN_PATH = 'data/research/ai_scientist_openalice_pit_reproduction_plan.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/normalized/research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl'
const DEFAULT_REPORT_PATH = 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json'
const DEFAULT_MAX_CANDIDATES = 1
const DEFAULT_MAX_ROWS_PER_FILE = 500

async function main(): Promise<void> {
  const args = parseAiScientistPitInputDatasetArgs(process.argv.slice(2))
  const report = await runAiScientistPitInputDataset(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistPitInputDatasetArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultOutputPath = dataRoot
    ? join(dataRoot, 'normalized/research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl')
    : DEFAULT_OUTPUT_PATH
  return {
    pitPlanPath: resolve(raw.get('pitPlanPath') ?? raw.get('planPath') ?? DEFAULT_PIT_PLAN_PATH),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutputPath),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    maxCandidates: parseNonNegativeInteger(raw.get('maxCandidates'), DEFAULT_MAX_CANDIDATES),
    maxRowsPerFile: parseNonNegativeInteger(raw.get('maxRowsPerFile'), DEFAULT_MAX_ROWS_PER_FILE),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistPitInputDataset(args: CliArgs): Promise<AiScientistPitInputDatasetReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const jobId = `ai_scientist_pit_input.${generatedAt.replace(/[:.]/g, '')}`
  const plan = asRecord(await readJsonIfExists(args.pitPlanPath))
  const rows: NormalizedAiScientistPitInputRow[] = []
  const candidateSummaries: AiScientistPitInputDatasetReport['candidates'] = []
  let inputFilesRead = 0
  let csvFilesRead = 0
  let rowsRead = 0
  let rowsDropped = 0

  const candidates = Array.isArray(plan?.candidates)
    ? plan.candidates.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  for (const candidate of candidates.slice(0, args.maxCandidates)) {
    const candidateRowsStart = rows.length
    const inputFiles = Array.isArray(candidate.inputFiles)
      ? candidate.inputFiles.map(asRecord).filter((item): item is UnknownRecord => item != null)
      : []
    const seenPaths = new Set<string>()
    for (const file of inputFiles) {
      const path = readString(file.path)
      if (!path || seenPaths.has(path) || readString(file.kind) !== 'csv') continue
      seenPaths.add(path)
      inputFilesRead += 1
      const result = await normalizeCsvFile({
        filePath: path,
        candidate,
        generatedAt,
        jobId,
        maxRowsPerFile: args.maxRowsPerFile,
      })
      csvFilesRead += result.fileRead ? 1 : 0
      rowsRead += result.rowsRead
      rowsDropped += result.rowsDropped
      rows.push(...result.rows)
    }
    candidateSummaries.push({
      runId: readString(candidate.runId) ?? 'unknown_run',
      candidateId: readString(candidate.candidateId) ?? 'unknown_candidate',
      family: readString(candidate.family) ?? 'unknown',
      files: seenPaths.size,
      rowsNormalized: rows.length - candidateRowsStart,
    })
  }

  const output = rows.map(row => JSON.stringify(row)).join('\n')
  await atomicWrite(args.outputPath, output ? `${output}\n` : '')
  const outputHash = output ? sha256Hex(`${output}\n`) : null
  const eventTimes = rows.map(row => row.eventTime).sort()
  const symbols = uniqueStrings(rows.map(row => row.symbol))
  const rowsWithRecoveredObservedAt = rows.filter(row => row.observedAtBasis === 'source_file_mtime_recovered').length
  const rowsWithRecoveredFetchedAt = rows.filter(row => row.fetchedAtBasis === 'source_file_mtime_recovered').length
  const rowsWithDerivedAvailableAt = rows.filter(row => row.availableAtBasis === 'derived_bar_close_time').length
  const promotionGradeRows = rows.filter(row => row.quality.promotionGrade).length
  const blockers = uniqueStrings([
    ...(plan ? [] : ['ai_scientist_pit_reproduction_plan_missing']),
    ...(rows.length > 0 ? [] : ['ai_scientist_pit_input_rows_missing']),
    'pit_input_dataset_research_only',
    ...(rowsWithRecoveredObservedAt > 0 || rowsWithRecoveredFetchedAt > 0
      ? ['pit_input_observed_at_recovered_from_file_mtime_not_row_explicit']
      : []),
    ...(rowsWithDerivedAvailableAt > 0
      ? ['pit_input_available_at_derived_from_bar_close_not_exchange_observed']
      : []),
    ...(promotionGradeRows === rows.length && rows.length > 0 ? [] : ['pit_input_not_promotion_grade']),
  ])
  const report: AiScientistPitInputDatasetReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: !plan ? 'blocked_missing_plan' : rows.length > 0 ? 'research_dataset_ready_pit_blocked' : 'failed_no_rows',
    sourceArtifacts: {
      pitPlan: args.pitPlanPath,
    },
    outputPath: args.outputPath,
    jobId,
    sampling: {
      maxCandidates: args.maxCandidates,
      maxRowsPerFile: args.maxRowsPerFile,
      sampled: args.maxRowsPerFile > 0,
    },
    counts: {
      candidatesRead: Math.min(candidates.length, args.maxCandidates),
      inputFilesRead,
      csvFilesRead,
      rowsRead,
      rowsNormalized: rows.length,
      rowsDropped,
      promotionGradeRows,
      distinctSymbols: symbols.length,
    },
    candidates: candidateSummaries,
    symbols,
    observedStartTime: eventTimes[0] ?? null,
    observedEndTime: eventTimes.at(-1) ?? null,
    blockers,
    nextActions: [
      'Use this dataset only for OpenAlice reproduction plumbing and feature-contract tests, not promotion.',
      'Replace file-mtime observedAt/fetchedAt with row-explicit collector observedAt/fetchedAt before PIT audit can pass.',
      'Tie normalized rows to complete OpenAlice warehouse manifests and rerun PIT reproduction planning before WFO/FDR.',
    ],
    safetyNotes: [
      'This dataset cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'Rows include explicit time fields for reproducibility; file-mtime lineage remains research-only and PIT-blocking.',
      'No API key, secret, or passphrase values are read or emitted by this script.',
    ],
    outputHash,
  }

  await writeEvidenceManifestForArtifact({
    job: 'ai_scientist_openalice_pit_input_rows',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: report.status === 'failed_no_rows' || report.status === 'blocked_missing_plan' ? 1 : 0,
    businessStatus: rows.length > 0 ? 'warn' : 'fail',
    recordsIn: rowsRead,
    recordsOut: rows.length,
    errorClass: report.blockers[0] ?? null,
    artifactHash: outputHash,
  })

  if (args.reportPath) {
    await atomicWrite(args.reportPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_pit_input_dataset_report',
      artifactPath: args.reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed_no_rows' || report.status === 'blocked_missing_plan' ? 1 : 0,
      businessStatus: rows.length > 0 ? 'warn' : 'fail',
      recordsIn: rowsRead,
      recordsOut: rows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

async function normalizeCsvFile(input: {
  filePath: string
  candidate: UnknownRecord
  generatedAt: string
  jobId: string
  maxRowsPerFile: number
}): Promise<{ fileRead: boolean; rowsRead: number; rowsDropped: number; rows: NormalizedAiScientistPitInputRow[] }> {
  try {
    const [info, text] = await Promise.all([stat(input.filePath), readFile(input.filePath, 'utf-8')])
    const fileMtime = new Date(info.mtimeMs).toISOString()
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
    const header = parseCsvLine(lines[0] ?? '')
    const dataLines = input.maxRowsPerFile > 0 ? lines.slice(1, 1 + input.maxRowsPerFile) : lines.slice(1)
    const rows: NormalizedAiScientistPitInputRow[] = []
    let rowsDropped = 0
    for (let index = 0; index < dataLines.length; index += 1) {
      const values = parseCsvLine(dataLines[index])
      const record = Object.fromEntries(header.map((key, valueIndex) => [key, values[valueIndex] ?? null]))
      const normalized = normalizeRecord({
        record,
        sourceRowRaw: dataLines[index],
        sourceRowIndex: index,
        sourceFilePath: input.filePath,
        sourceFileMtime: fileMtime,
        sourceFileSizeBytes: info.size,
        candidate: input.candidate,
        generatedAt: input.generatedAt,
        jobId: input.jobId,
      })
      if (normalized) rows.push(normalized)
      else rowsDropped += 1
    }
    return { fileRead: true, rowsRead: dataLines.length, rowsDropped, rows }
  } catch {
    return { fileRead: false, rowsRead: 0, rowsDropped: 0, rows: [] }
  }
}

function normalizeRecord(input: {
  record: Record<string, string | null>
  sourceRowRaw: string
  sourceRowIndex: number
  sourceFilePath: string
  sourceFileMtime: string
  sourceFileSizeBytes: number
  candidate: UnknownRecord
  generatedAt: string
  jobId: string
}): NormalizedAiScientistPitInputRow | null {
  const rawSymbol = input.record.symbol ?? inferRawSymbolFromPath(input.sourceFilePath)
  const eventTimeMs = parseEventTimeMs(input.record)
  if (!rawSymbol || eventTimeMs == null) return null
  const timeframe = inferTimeframe(input.sourceFilePath)
  const timeframeMs = timeframeToMs(timeframe)
  const eventTime = new Date(eventTimeMs).toISOString()
  const rowExplicitAvailableAtMs = parseFirstIsoTimeMs(input.record, ['availableAt', 'available_at'])
  const availableAtMs = rowExplicitAvailableAtMs ?? eventTimeMs + timeframeMs
  const availableAtBasis: NormalizedAiScientistPitInputRow['availableAtBasis'] =
    rowExplicitAvailableAtMs != null ? 'row_explicit_available_at' : 'derived_bar_close_time'
  const rowExplicitObservedAtMs = parseFirstIsoTimeMs(input.record, ['observedAt', 'observed_at'])
  const rowExplicitFetchedAtMs = parseFirstIsoTimeMs(input.record, ['fetchedAt', 'fetched_at'])
  const observedAtMs = rowExplicitObservedAtMs ?? rowExplicitFetchedAtMs
  const fetchedAtMs = rowExplicitFetchedAtMs
  const observedAtBasis: NormalizedAiScientistPitInputRow['observedAtBasis'] =
    rowExplicitObservedAtMs != null
      ? 'row_explicit_observed_at'
      : rowExplicitFetchedAtMs != null
        ? 'row_explicit_observed_or_fetched_at'
        : 'source_file_mtime_recovered'
  const fetchedAtBasis: NormalizedAiScientistPitInputRow['fetchedAtBasis'] =
    rowExplicitFetchedAtMs != null ? 'row_explicit_fetched_at' : 'source_file_mtime_recovered'
  const rowQualityBlockers = uniqueStrings([
    ...(observedAtMs != null ? [] : ['observed_at_recovered_from_file_mtime_not_row_explicit']),
    ...(fetchedAtMs != null ? [] : ['fetched_at_recovered_from_file_mtime_not_row_explicit']),
    ...(rowExplicitAvailableAtMs != null ? [] : ['available_at_derived_from_bar_close_not_exchange_observed']),
    ...(!isResearchReproductionReadyRow(input.record) ? ['row_not_promotion_grade'] : []),
  ])
  const promotionGrade = rowQualityBlockers.length === 0
  const symbol = normalizeSymbol(rawSymbol)
  return {
    schemaVersion: 'openalice.ai_scientist.pit_input.normalized.v1',
    runId: readString(input.candidate.runId) ?? 'unknown_run',
    candidateId: readString(input.candidate.candidateId) ?? 'unknown_candidate',
    family: readString(input.candidate.family) ?? 'unknown',
    source: 'ai_scientist_crypto_dl',
    exchange: input.sourceFilePath.includes('binance') ? 'binance' : 'unknown',
    market: rawSymbol.endsWith('_USDT') || rawSymbol.endsWith('_USDT_USDT') ? 'usds_futures' : 'spot_or_unknown',
    symbol,
    rawSymbol,
    timeframe,
    eventTime,
    eventTimeMs,
    eventTimeBasis: 'source_bar_open_time',
    availableAt: new Date(availableAtMs).toISOString(),
    availableAtMs,
    availableAtBasis,
    fetchedAt: new Date(fetchedAtMs ?? Date.parse(input.sourceFileMtime)).toISOString(),
    fetchedAtBasis,
    observedAt: new Date(observedAtMs ?? Date.parse(input.sourceFileMtime)).toISOString(),
    observedAtBasis,
    generatedAt: input.generatedAt,
    jobId: input.jobId,
    sourceFilePath: input.sourceFilePath,
    sourceFileMtime: input.sourceFileMtime,
    sourceFileSizeBytes: input.sourceFileSizeBytes,
    sourceRowIndex: input.sourceRowIndex,
    sourceRowHash: sha256Hex(input.sourceRowRaw),
    values: normalizeValues(input.record),
    quality: {
      promotionGrade,
      pitLineageStatus: promotionGrade
        ? 'research_reproduction_ready'
        : 'research_reproduction_only_file_mtime_recovered',
      blockers: rowQualityBlockers,
    },
  }
}

function parseEventTimeMs(record: Record<string, string | null>): number | null {
  const datetime = record.datetime ?? record.eventTime ?? record.event_time
  if (datetime) {
    const parsed = Date.parse(datetime)
    if (Number.isFinite(parsed)) return parsed
  }
  const timestamp = record.timestamp
  if (!timestamp) return null
  const parsed = Number(timestamp)
  if (!Number.isFinite(parsed)) return null
  return parsed > 10_000_000_000_000 ? Math.floor(parsed / 1_000) : parsed
}

function parseFirstIsoTimeMs(record: Record<string, string | null>, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key]
    if (!value) continue
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function isResearchReproductionReadyRow(record: Record<string, string | null>): boolean {
  const status = (record.openalicePitContractStatus ?? record.openalice_pit_contract_status ?? '').trim().toLowerCase()
  return [
    'research_reproduction_ready',
    'pit_research_reproduction_ready',
    'ready_for_research_reproduction',
  ].includes(status)
}

function normalizeValues(record: Record<string, string | null>): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {}
  for (const [key, value] of Object.entries(record)) {
    if (value == null || value === '') {
      out[key] = null
      continue
    }
    const numeric = Number(value)
    out[key] = Number.isFinite(numeric) ? numeric : value
  }
  return out
}

function parseCsvLine(line: string): string[] {
  return line.split(',').map(value => value.trim())
}

function inferRawSymbolFromPath(path: string): string | null {
  const file = path.split('/').at(-1) ?? ''
  const withoutExt = file.replace(/\.csv$/i, '')
  return withoutExt.replace(/_1[hm]$/i, '') || null
}

function inferTimeframe(path: string): string {
  const match = /_(\d+[mhdw])\.csv$/i.exec(path)
  return match?.[1].toLowerCase() ?? '1h'
}

function timeframeToMs(timeframe: string): number {
  const match = /^(\d+)([mhdw])$/.exec(timeframe)
  if (!match) return 60 * 60_000
  const value = Number(match[1])
  const unit = match[2]
  if (unit === 'm') return value * 60_000
  if (unit === 'h') return value * 60 * 60_000
  if (unit === 'd') return value * 24 * 60 * 60_000
  return value * 7 * 24 * 60 * 60_000
}

function normalizeSymbol(rawSymbol: string): string {
  const parts = rawSymbol.split('_')
  if (parts.length >= 3 && parts.at(-1) === 'USDT') return `${parts[0]}/USDT:USDT`
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  return rawSymbol
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    i += 1
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : value
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true
  if (['false', '0', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function renderConsoleSummary(report: AiScientistPitInputDatasetReport): string {
  return [
    `AI-Scientist OpenAlice PIT input dataset: ${report.status}`,
    `rows=${report.counts.rowsNormalized}/${report.counts.rowsRead} files=${report.counts.csvFilesRead} symbols=${report.counts.distinctSymbols} promotionGradeRows=${report.counts.promotionGradeRows}`,
    `sampled=${report.sampling.sampled} maxRowsPerFile=${report.sampling.maxRowsPerFile}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 6).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
