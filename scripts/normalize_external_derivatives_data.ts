import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

interface CliArgs {
  inputPath: string
  outputPath: string
  reportPath: string | null
  runLedgerPath: string | null
  json: boolean
}

export interface NormalizedExternalDerivativesRow {
  schemaVersion: 'openalice.external_derivatives.normalized.v1'
  eventTime: string
  eventTimeMs: number
  exchange: string
  market: string
  symbol: string
  endpointId: 'fundingRate' | 'premiumIndex' | 'openInterest' | 'openInterestHist' | 'globalLongShortAccountRatio' | 'unknown'
  sourceEndpoint: string
  sourceTimestamp: string
  sourceTimestampMs: number
  sourceTimestampBasis: string | null
  fetchedAt: string | null
  observedAt: string | null
  availableAt: string | null
  ingestedAt: string | null
  jobId: string | null
  generatedAt: string | null
  lineageStatus: 'explicit_row_lineage' | 'recovered_from_run_ledger' | 'missing'
  dedupKey: string | null
  rawPayloadHash: string | null
  collectionRunId: string | null
  reportPath: string | null
  manifestPath: string | null
  normalizedPayloadHash: string
  fields: Record<string, number | string | null>
}

export interface NormalizeExternalDerivativesReport {
  schemaVersion: 1
  generatedAt: string
  status: 'complete' | 'partial' | 'failed'
  inputPath: string
  outputPath: string
  runLedgerPath: string | null
  rowsRead: number
  rowsNormalized: number
  rowsDropped: number
  lineage: {
    explicitRows: number
    recoveredRows: number
    missingRows: number
    eventTimeCoveragePct: number
    jobIdCoveragePct: number
    generatedAtCoveragePct: number
    reportPathCoveragePct: number
    manifestPathCoveragePct: number
  }
  endpointIds: string[]
  symbols: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  blockers: string[]
  nextActions: string[]
  outputHash: string | null
}

const DEFAULT_INPUT_PATH = 'data/external/derivatives/okx_swap_derivatives_events.jsonl'
const DEFAULT_OUTPUT_PATH = 'data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'
const DEFAULT_REPORT_PATH = 'data/runtime/external_derivatives_data_normalize.latest.json'
const DEFAULT_RUN_LEDGER_PATH = 'data/runtime/external_derivatives_data_collect.runs.jsonl'

async function main(): Promise<void> {
  const args = parseNormalizeExternalDerivativesArgs(process.argv.slice(2))
  const report = await runNormalizeExternalDerivatives(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseNormalizeExternalDerivativesArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT
  const defaultInput = dataRoot
    ? resolve(dataRoot, 'external/derivatives/okx_swap_derivatives_events.jsonl')
    : DEFAULT_INPUT_PATH
  const defaultOutput = dataRoot
    ? resolve(dataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
    : DEFAULT_OUTPUT_PATH
  return {
    inputPath: resolve(raw.get('inputPath') ?? raw.get('input') ?? defaultInput),
    outputPath: resolve(raw.get('outputPath') ?? raw.get('output') ?? defaultOutput),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? (dataRoot ? resolve(dataRoot, 'runtime/external_derivatives_data_normalize.latest.json') : DEFAULT_REPORT_PATH)),
    runLedgerPath: parseNullablePath(raw.get('runLedgerPath') ?? raw.get('runLedger') ?? (dataRoot ? resolve(dataRoot, 'runtime/external_derivatives_data_collect.runs.jsonl') : DEFAULT_RUN_LEDGER_PATH)),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runNormalizeExternalDerivatives(args: CliArgs): Promise<NormalizeExternalDerivativesReport> {
  const startedAt = new Date()
  const runLedgerLineage = await readRunLedgerLineage(args.runLedgerPath)
  const outputPath = resolve(args.outputPath)
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await mkdir(dirname(outputPath), { recursive: true })
  const writer = createWriteStream(tmpPath, { encoding: 'utf-8' })
  const outputHashState = createHash('sha256')
  const endpointIds = new Set<string>()
  const symbols = new Set<string>()
  let rowsRead = 0
  let rowsNormalized = 0
  let rowsDropped = 0
  let observedStartTime: string | null = null
  let observedEndTime: string | null = null
  const lineageCounts = emptyLineageCounts()
  const lines = createInterface({ input: createReadStream(args.inputPath, 'utf-8'), crlfDelay: Infinity })
  try {
    for await (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue
      const rowIndex = rowsRead++
      const row = normalizeExternalDerivativesRow(line, lineageAt(runLedgerLineage, rowIndex))
      if (!row) { rowsDropped += 1; continue }
      rowsNormalized += 1
      updateLineageCounts(lineageCounts, row)
      endpointIds.add(row.endpointId)
      symbols.add(row.symbol)
      observedStartTime = observedStartTime == null || row.sourceTimestamp < observedStartTime ? row.sourceTimestamp : observedStartTime
      observedEndTime = observedEndTime == null || row.sourceTimestamp > observedEndTime ? row.sourceTimestamp : observedEndTime
      const serialized = `${JSON.stringify(row)}\n`
      outputHashState.update(serialized)
      if (!writer.write(serialized)) await once(writer, 'drain')
    }
    writer.end()
    await once(writer, 'finish')
    await rename(tmpPath, outputPath)
  } catch (error) {
    writer.destroy()
    throw error
  }
  const outputHash = rowsNormalized > 0 ? outputHashState.digest('hex') : null
  const report: NormalizeExternalDerivativesReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: rowsNormalized > 0 ? (rowsDropped > 0 ? 'partial' : 'complete') : 'failed',
    inputPath: args.inputPath,
    outputPath: args.outputPath,
    runLedgerPath: args.runLedgerPath,
    rowsRead,
    rowsNormalized,
    rowsDropped,
    lineage: finalizeLineageSummary(lineageCounts),
    endpointIds: [...endpointIds].sort(),
    symbols: [...symbols].sort(),
    observedStartTime,
    observedEndTime,
    blockers: rowsNormalized > 0 ? [] : ['external_derivatives_normalized_rows_missing'],
    nextActions: rowsNormalized > 0
      ? ['Run external derivatives audit to validate endpoint coverage, availableAt coverage, and PIT-safe field presence.']
      : ['Collect external derivatives rows before attempting normalization.'],
    outputHash,
  }

  await writeEvidenceManifestForArtifact({
    job: 'external_derivatives_data_normalize_rows',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: report.status === 'failed' ? 1 : 0,
    businessStatus: report.status === 'complete' ? 'pass' : report.status === 'partial' ? 'warn' : 'fail',
    recordsIn: report.rowsRead,
    recordsOut: report.rowsNormalized,
    errorClass: report.blockers[0] ?? null,
    artifactHash: outputHash,
  })

  if (args.reportPath) {
    await atomicWrite(resolve(args.reportPath), `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'external_derivatives_data_normalize_report',
      artifactPath: resolve(args.reportPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'failed' ? 1 : 0,
      businessStatus: report.status === 'complete' ? 'pass' : report.status === 'partial' ? 'warn' : 'fail',
      recordsIn: report.rowsRead,
      recordsOut: report.rowsNormalized,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

interface RunLedgerLineage {
  runId: string
  generatedAt: string | null
  reportPath: string | null
  manifestPath: string | null
}

function normalizeExternalDerivativesRow(line: string, runLedgerLineage: RunLedgerLineage | null): NormalizedExternalDerivativesRow | null {
  const record = asRecord(JSON.parse(line))
  const payload = asRecord(record?.payload)
  const exchange = readString(record?.exchange)
  const market = readString(record?.market)
  const symbol = readString(record?.symbol)
  const sourceEndpoint = readString(record?.sourceEndpoint)
  const sourceTimestamp = readString(record?.sourceTimestamp)
  const sourceTimestampMs =
    readNumber(record?.sourceTimestampMs) ??
    (sourceTimestamp ? Date.parse(sourceTimestamp) : null) ??
    readNumber(payload?.timestamp)
  if (!payload || !exchange || !market || !symbol || !sourceEndpoint || !sourceTimestamp || sourceTimestampMs == null) return null
  const endpointId = mapEndpointId(sourceEndpoint)
  const explicitCollectionRunId = readString(record?.collectionRunId)
  const explicitReportPath = readString(record?.reportPath)
  const explicitManifestPath = readString(record?.manifestPath)
  const jobId = explicitCollectionRunId ?? runLedgerLineage?.runId ?? null
  const reportPath = explicitReportPath ?? runLedgerLineage?.reportPath ?? null
  const manifestPath = explicitManifestPath ?? runLedgerLineage?.manifestPath ?? null
  const generatedAt = readString(record?.generatedAt) ?? runLedgerLineage?.generatedAt ?? null
  const lineageStatus: NormalizedExternalDerivativesRow['lineageStatus'] =
    explicitCollectionRunId && explicitReportPath && explicitManifestPath
      ? 'explicit_row_lineage'
      : runLedgerLineage != null
        ? 'recovered_from_run_ledger'
        : 'missing'
  const fields: Record<string, number | string | null> = {}
  for (const [key, value] of Object.entries(payload)) {
    if (value == null) fields[key] = null
    else if (typeof value === 'number') fields[key] = value
    else if (typeof value === 'string') {
      const asNumber = Number(value)
      fields[key] = Number.isFinite(asNumber) ? asNumber : value
    }
  }
  const normalizedPayloadHash = sha256Hex(JSON.stringify(fields))
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: sourceTimestamp,
    eventTimeMs: sourceTimestampMs,
    exchange,
    market,
    symbol,
    endpointId,
    sourceEndpoint,
    sourceTimestamp,
    sourceTimestampMs,
    sourceTimestampBasis: readString(record?.sourceTimestampBasis),
    fetchedAt: readString(record?.fetchTimestamp) ?? readString(record?.fetchedAt),
    observedAt: readString(record?.payloadReceivedAt) ?? readString(record?.observedAt),
    availableAt: readString(record?.ingestedAt) ?? readString(record?.availableAt),
    ingestedAt: readString(record?.ingestedAt),
    jobId,
    generatedAt,
    lineageStatus,
    dedupKey: readString(record?.dedupKey),
    rawPayloadHash: readString(record?.rawPayloadHash),
    collectionRunId: jobId,
    reportPath,
    manifestPath,
    normalizedPayloadHash,
    fields,
  }
}

interface LineageRange extends RunLedgerLineage { start: number; end: number }

async function readRunLedgerLineage(path: string | null): Promise<LineageRange[]> {
  if (!path) return []
  try {
    const ranges: LineageRange[] = []
    let cursor = 0
    const lines = createInterface({ input: createReadStream(path, 'utf-8'), crlfDelay: Infinity })
    for await (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const row = asRecord(JSON.parse(trimmed))
      const appendedRows = readNumber(row?.appendedRows) ?? 0
      if (appendedRows <= 0) continue
      ranges.push({
        runId: readString(row?.runId) ?? 'unknown_external_derivatives_collect_run',
        generatedAt: readString(row?.generatedAt),
        reportPath: readString(row?.reportPath),
        manifestPath: readString(row?.manifestPath),
        start: cursor,
        end: cursor + appendedRows,
      })
      cursor += appendedRows
    }
    return ranges
  } catch {
    return []
  }
}

function lineageAt(ranges: LineageRange[], index: number): RunLedgerLineage | null {
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const range = ranges[middle]
    if (index < range.start) high = middle - 1
    else if (index >= range.end) low = middle + 1
    else return range
  }
  return null
}

function summarizeNormalizedLineage(rows: NormalizedExternalDerivativesRow[]): NormalizeExternalDerivativesReport['lineage'] {
  return {
    explicitRows: rows.filter(row => row.lineageStatus === 'explicit_row_lineage').length,
    recoveredRows: rows.filter(row => row.lineageStatus === 'recovered_from_run_ledger').length,
    missingRows: rows.filter(row => row.lineageStatus === 'missing').length,
    eventTimeCoveragePct: coveragePct(rows, row => readString(row.eventTime) != null && readNumber(row.eventTimeMs) != null),
    jobIdCoveragePct: coveragePct(rows, row => readString(row.jobId) != null),
    generatedAtCoveragePct: coveragePct(rows, row => readString(row.generatedAt) != null),
    reportPathCoveragePct: coveragePct(rows, row => readString(row.reportPath) != null),
    manifestPathCoveragePct: coveragePct(rows, row => readString(row.manifestPath) != null),
  }
}

interface LineageCounts {
  total: number
  explicitRows: number
  recoveredRows: number
  missingRows: number
  eventTime: number
  jobId: number
  generatedAt: number
  reportPath: number
  manifestPath: number
}

function emptyLineageCounts(): LineageCounts {
  return { total: 0, explicitRows: 0, recoveredRows: 0, missingRows: 0, eventTime: 0, jobId: 0, generatedAt: 0, reportPath: 0, manifestPath: 0 }
}

function updateLineageCounts(counts: LineageCounts, row: NormalizedExternalDerivativesRow): void {
  counts.total += 1
  if (row.lineageStatus === 'explicit_row_lineage') counts.explicitRows += 1
  else if (row.lineageStatus === 'recovered_from_run_ledger') counts.recoveredRows += 1
  else counts.missingRows += 1
  if (readString(row.eventTime) != null && readNumber(row.eventTimeMs) != null) counts.eventTime += 1
  if (readString(row.jobId) != null) counts.jobId += 1
  if (readString(row.generatedAt) != null) counts.generatedAt += 1
  if (readString(row.reportPath) != null) counts.reportPath += 1
  if (readString(row.manifestPath) != null) counts.manifestPath += 1
}

function finalizeLineageSummary(counts: LineageCounts): NormalizeExternalDerivativesReport['lineage'] {
  const pct = (value: number) => counts.total === 0 ? 0 : Math.round((value / counts.total) * 1000000) / 10000
  return {
    explicitRows: counts.explicitRows,
    recoveredRows: counts.recoveredRows,
    missingRows: counts.missingRows,
    eventTimeCoveragePct: pct(counts.eventTime),
    jobIdCoveragePct: pct(counts.jobId),
    generatedAtCoveragePct: pct(counts.generatedAt),
    reportPathCoveragePct: pct(counts.reportPath),
    manifestPathCoveragePct: pct(counts.manifestPath),
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
}

function coveragePct<T>(rows: T[], predicate: (row: T) => boolean): number {
  if (rows.length === 0) return 0
  const covered = rows.filter(predicate).length
  return Math.round((covered / rows.length) * 1000000) / 10000
}

function mapEndpointId(sourceEndpoint: string): NormalizedExternalDerivativesRow['endpointId'] {
  if (sourceEndpoint.endsWith('/fundingRate') || sourceEndpoint.endsWith('/funding-rate') || sourceEndpoint.endsWith('/funding-rate-history')) return 'fundingRate'
  if (sourceEndpoint.endsWith('/premiumIndex') || sourceEndpoint.includes('/mark-price')) return 'premiumIndex'
  if (sourceEndpoint.endsWith('/openInterest') || sourceEndpoint.endsWith('/open-interest')) return 'openInterest'
  if (sourceEndpoint.endsWith('/openInterestHist') || sourceEndpoint.endsWith('/open-interest-volume')) return 'openInterestHist'
  if (sourceEndpoint.endsWith('/globalLongShortAccountRatio') || sourceEndpoint.endsWith('/long-short-account-ratio')) return 'globalLongShortAccountRatio'
  return 'unknown'
}

function renderConsoleSummary(report: NormalizeExternalDerivativesReport): string {
  return [
    `external derivatives normalize: ${report.status}`,
    `rowsRead=${report.rowsRead} rowsNormalized=${report.rowsNormalized} rowsDropped=${report.rowsDropped}`,
    `symbols=${report.symbols.join(',') || 'none'} endpoints=${report.endpointIds.join(',') || 'none'}`,
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      out.set(key, inlineValue)
      continue
    }
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('normalize_external_derivatives_data failed:', error)
    process.exit(1)
  })
}
