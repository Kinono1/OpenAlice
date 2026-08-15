import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import { DEFAULT_COLLECTOR_PIT_ROWS_PATH } from './lib/ohlcv_collector_pit.js'

type UnknownRecord = Record<string, unknown>
type CollectorPitStatus =
  | 'blocked_collector_pit_rows_missing'
  | 'blocked_collector_pit_contract_stale'
  | 'ready_for_pit_audit_research_only'
  | 'blocked_collector_pit_contract_incomplete'

interface CliArgs {
  inputPath: string | null
  outputPath: string | null
  maxRows: number
  maxObservationAgeMinutes: number
  json: boolean
}

export interface OpenAliceOhlcvCollectorPitContractStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: CollectorPitStatus
  sourceArtifacts: {
    collectorPitRows: string | null
  }
  counts: {
    rowsScanned: number
    rowParseErrors: number
    rowsWithEventTime: number
    rowsWithAvailableAt: number
    rowsWithObservedAt: number
    rowsWithFetchedAt: number
    rowsWithRowExplicitAvailableAt: number
    rowsWithRowExplicitObservedOrFetchedAt: number
    rowsWithRowLineageScope: number
    rowsWithRowPITUsableForPromotionFalse: number
    rowsPromotionGrade: number
    rowsWithQualityBlockers: number
    distinctSymbols: number
    distinctInstIds: number
    distinctTimeframes: number
    distinctCollectionRuns: number
  }
  coverage: {
    eventTimePct: number
    availableAtPct: number
    observedAtPct: number
    fetchedAtPct: number
    rowExplicitAvailableAtPct: number
    rowExplicitObservedOrFetchedAtPct: number
    promotionGradePct: number
  }
  freshness: {
    latestEventTime: string | null
    latestObservedAt: string | null
    latestFetchedAt: string | null
    latestAvailableAt: string | null
    latestCollectorObservationAgeMinutes: number | null
    maxObservationAgeMinutes: number
    stale: boolean
    staleTimeframes: string[]
  }
  timeframeFreshness: Array<{
    timeframe: string
    rows: number
    latestEventTime: string | null
    latestObservedAt: string | null
    latestCollectorObservationAgeMinutes: number | null
    stale: boolean
  }>
  symbols: string[]
  instIds: string[]
  timeframes: string[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  sampleRows: Array<{
    collectionRunId: string | null
    symbol: string | null
    instId: string | null
    timeframe: string | null
    eventTime: string | null
    availableAtBasis: string | null
    observedAtBasis: string | null
    fetchedAtBasis: string | null
    promotionGrade: boolean | null
    blockers: string[]
  }>
}

const DEFAULT_OUTPUT_PATH = 'data/research/openalice_ohlcv_collector_pit_contract_status.latest.json'
const DEFAULT_MAX_ROWS = 5000
const DEFAULT_MAX_OBSERVATION_AGE_MINUTES = 180
const execFileAsync = promisify(execFile)

async function main(): Promise<void> {
  const args = parseOpenAliceOhlcvCollectorPitContractStatusArgs(process.argv.slice(2))
  const report = await runOpenAliceOhlcvCollectorPitContractStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseOpenAliceOhlcvCollectorPitContractStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    inputPath: parseNullablePath(raw.get('inputPath') ?? raw.get('input') ?? DEFAULT_COLLECTOR_PIT_ROWS_PATH),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxRows: parseNonNegativeInteger(raw.get('maxRows'), DEFAULT_MAX_ROWS),
    maxObservationAgeMinutes: parseNonNegativeInteger(raw.get('maxObservationAgeMinutes'), DEFAULT_MAX_OBSERVATION_AGE_MINUTES),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runOpenAliceOhlcvCollectorPitContractStatus(
  args: CliArgs,
): Promise<OpenAliceOhlcvCollectorPitContractStatusReport> {
  const startedAt = new Date()
  const rows = args.inputPath
    ? await readJsonlRows(resolve(args.inputPath), args.maxRows)
    : { rows: [], parseErrors: 0 }
  const report = buildOpenAliceOhlcvCollectorPitContractStatusReport({
    generatedAt: new Date().toISOString(),
    inputPath: args.inputPath ? resolve(args.inputPath) : null,
    rows: rows.rows,
    rowParseErrors: rows.parseErrors,
    maxObservationAgeMinutes: args.maxObservationAgeMinutes,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'openalice_ohlcv_collector_pit_contract_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_collector_pit_rows_missing' ? 1 : 0,
      businessStatus: report.status === 'ready_for_pit_audit_research_only' ? 'warn' : 'fail',
      recordsIn: report.counts.rowsScanned,
      recordsOut: report.counts.rowsScanned,
      errorClass: report.blockers[0] ?? null,
    })
  }
  if (args.inputPath && report.counts.rowsScanned > 0) {
    await writeEvidenceManifestForArtifact({
      job: 'openalice_ohlcv_collector_pit_rows_research_only_audit',
      artifactPath: resolve(args.inputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: 'warn',
      recordsIn: report.counts.rowsScanned,
      recordsOut: report.counts.rowsScanned,
      errorClass: 'collector_pit_contract_research_only',
    })
  }

  return report
}

export function buildOpenAliceOhlcvCollectorPitContractStatusReport(input: {
  generatedAt: string
  inputPath: string | null
  rows: UnknownRecord[]
  rowParseErrors: number
  maxObservationAgeMinutes?: number
}): OpenAliceOhlcvCollectorPitContractStatusReport {
  const rowsScanned = input.rows.length
  const maxObservationAgeMinutes = input.maxObservationAgeMinutes ?? DEFAULT_MAX_OBSERVATION_AGE_MINUTES
  const rowsWithEventTime = input.rows.filter(row => isIsoLike(readString(row.eventTime))).length
  const rowsWithAvailableAt = input.rows.filter(row => isIsoLike(readString(row.availableAt))).length
  const rowsWithObservedAt = input.rows.filter(row => isIsoLike(readString(row.observedAt))).length
  const rowsWithFetchedAt = input.rows.filter(row => isIsoLike(readString(row.fetchedAt))).length
  const rowsWithRowExplicitAvailableAt = input.rows.filter(row =>
    readString(row.availableAtBasis)?.startsWith('row_explicit_') === true).length
  const rowsWithRowExplicitObservedOrFetchedAt = input.rows.filter(row => isRowExplicitObservedOrFetched(row)).length
  const rowsWithRowLineageScope = input.rows.filter(row => readString(row.lineageScope) === 'row').length
  const rowsWithRowPITUsableForPromotionFalse = input.rows.filter(row => readBoolean(row.rowPITUsableForPromotion) === false).length
  const rowsPromotionGrade = input.rows.filter(row => readBoolean(asRecord(row.quality)?.promotionGrade) === true).length
  const rowsWithQualityBlockers = input.rows.filter(row => readStringArray(asRecord(row.quality)?.blockers).length > 0).length
  const symbols = uniqueStrings(input.rows.map(row => readString(row.symbol)).filter((value): value is string => value != null))
  const instIds = uniqueStrings(input.rows.map(row => readString(row.instId)).filter((value): value is string => value != null))
  const timeframes = uniqueStrings(input.rows.map(row => readString(row.timeframe)).filter((value): value is string => value != null))
  const collectionRuns = uniqueStrings(input.rows.map(row => readString(row.collectionRunId)).filter((value): value is string => value != null))
  const timeframeFreshness = buildTimeframeFreshness({
    rows: input.rows,
    generatedAt: input.generatedAt,
    maxObservationAgeMinutes,
  })
  const freshness = buildOverallFreshness({
    rows: input.rows,
    generatedAt: input.generatedAt,
    maxObservationAgeMinutes,
    timeframeFreshness,
  })
  const hasCompleteRowExplicitContract = rowsScanned > 0 &&
    rowsWithEventTime === rowsScanned &&
    rowsWithAvailableAt === rowsScanned &&
    rowsWithObservedAt === rowsScanned &&
    rowsWithFetchedAt === rowsScanned &&
    rowsWithRowExplicitAvailableAt === rowsScanned &&
    rowsWithRowExplicitObservedOrFetchedAt === rowsScanned &&
    rowsWithRowLineageScope === rowsScanned
  const blockers = uniqueStrings([
    ...(input.inputPath ? [] : ['collector_pit_rows_path_missing']),
    ...(rowsScanned > 0 ? [] : ['collector_pit_rows_missing']),
    ...(input.rowParseErrors === 0 ? [] : [`collector_pit_row_parse_errors:${input.rowParseErrors}`]),
    ...(rowsWithEventTime === rowsScanned && rowsScanned > 0 ? [] : [`event_time_coverage_incomplete:${rowsWithEventTime}/${rowsScanned}`]),
    ...(rowsWithAvailableAt === rowsScanned && rowsScanned > 0 ? [] : [`available_at_coverage_incomplete:${rowsWithAvailableAt}/${rowsScanned}`]),
    ...(rowsWithObservedAt === rowsScanned && rowsScanned > 0 ? [] : [`observed_at_coverage_incomplete:${rowsWithObservedAt}/${rowsScanned}`]),
    ...(rowsWithFetchedAt === rowsScanned && rowsScanned > 0 ? [] : [`fetched_at_coverage_incomplete:${rowsWithFetchedAt}/${rowsScanned}`]),
    ...(rowsWithRowExplicitAvailableAt === rowsScanned && rowsScanned > 0 ? [] : [`row_explicit_available_at_missing:${rowsWithRowExplicitAvailableAt}/${rowsScanned}`]),
    ...(rowsWithRowExplicitObservedOrFetchedAt === rowsScanned && rowsScanned > 0 ? [] : [`row_explicit_observed_or_fetched_at_missing:${rowsWithRowExplicitObservedOrFetchedAt}/${rowsScanned}`]),
    ...(rowsWithRowLineageScope === rowsScanned && rowsScanned > 0 ? [] : [`row_lineage_scope_missing:${rowsWithRowLineageScope}/${rowsScanned}`]),
    ...(rowsWithRowPITUsableForPromotionFalse === rowsScanned && rowsScanned > 0 ? ['row_pit_usable_for_promotion_false'] : []),
    ...(rowsPromotionGrade === 0 ? ['collector_rows_not_promotion_grade'] : [`collector_promotion_grade_rows_present_unexpected:${rowsPromotionGrade}`]),
    ...(rowsWithQualityBlockers > 0 ? [`quality_blockers_present:${rowsWithQualityBlockers}/${rowsScanned}`] : []),
    ...freshness.staleTimeframes.map(timeframe => {
      const item = timeframeFreshness.find(candidate => candidate.timeframe === timeframe)
      return `collector_pit_timeframe_stale:${timeframe}:${item?.latestCollectorObservationAgeMinutes ?? 'unknown'}>${maxObservationAgeMinutes}m`
    }),
    'collector_pit_contract_research_only',
  ])

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: rowsScanned === 0
      ? 'blocked_collector_pit_rows_missing'
      : freshness.stale
        ? 'blocked_collector_pit_contract_stale'
      : hasCompleteRowExplicitContract
        ? 'ready_for_pit_audit_research_only'
        : 'blocked_collector_pit_contract_incomplete',
    sourceArtifacts: {
      collectorPitRows: input.inputPath,
    },
    counts: {
      rowsScanned,
      rowParseErrors: input.rowParseErrors,
      rowsWithEventTime,
      rowsWithAvailableAt,
      rowsWithObservedAt,
      rowsWithFetchedAt,
      rowsWithRowExplicitAvailableAt,
      rowsWithRowExplicitObservedOrFetchedAt,
      rowsWithRowLineageScope,
      rowsWithRowPITUsableForPromotionFalse,
      rowsPromotionGrade,
      rowsWithQualityBlockers,
      distinctSymbols: symbols.length,
      distinctInstIds: instIds.length,
      distinctTimeframes: timeframes.length,
      distinctCollectionRuns: collectionRuns.length,
    },
    coverage: {
      eventTimePct: pct(rowsWithEventTime, rowsScanned),
      availableAtPct: pct(rowsWithAvailableAt, rowsScanned),
      observedAtPct: pct(rowsWithObservedAt, rowsScanned),
      fetchedAtPct: pct(rowsWithFetchedAt, rowsScanned),
      rowExplicitAvailableAtPct: pct(rowsWithRowExplicitAvailableAt, rowsScanned),
      rowExplicitObservedOrFetchedAtPct: pct(rowsWithRowExplicitObservedOrFetchedAt, rowsScanned),
      promotionGradePct: pct(rowsPromotionGrade, rowsScanned),
    },
    freshness,
    timeframeFreshness,
    symbols,
    instIds,
    timeframes,
    blockers,
    nextActions: [
      'Keep appending collector sidecar rows during OKX public OHLCV refreshes.',
      'Add a separate PIT audit that proves every strategy decision time is strictly after row availableAt before considering promotion-grade labeling.',
      'Continue WFO/FDR/route-cost/slippage/risk/prospective/paper-telemetry gates before any paper or live authority.',
    ],
    safetyNotes: [
      'This status is research-only and cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'Row-explicit collector timestamps make the data auditable; they do not prove profitability or execution readiness.',
    ],
    sampleRows: input.rows.slice(0, 3).map(row => ({
      collectionRunId: readString(row.collectionRunId),
      symbol: readString(row.symbol),
      instId: readString(row.instId),
      timeframe: readString(row.timeframe),
      eventTime: readString(row.eventTime),
      availableAtBasis: readString(row.availableAtBasis),
      observedAtBasis: readString(row.observedAtBasis),
      fetchedAtBasis: readString(row.fetchedAtBasis),
      promotionGrade: readBoolean(asRecord(row.quality)?.promotionGrade),
      blockers: readStringArray(asRecord(row.quality)?.blockers),
    })),
  }
}

async function readJsonlRows(path: string, maxRows: number): Promise<{ rows: UnknownRecord[]; parseErrors: number }> {
  try {
    const text = maxRows > 0
      ? await readTailLines(path, maxRows)
      : await readFile(path, 'utf-8')
    const rows: UnknownRecord[] = []
    let parseErrors = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line)
        const record = asRecord(parsed)
        if (record) rows.push(record)
        else parseErrors += 1
      } catch {
        parseErrors += 1
      }
    }
    return { rows, parseErrors }
  } catch {
    return { rows: [], parseErrors: 0 }
  }
}

async function readTailLines(path: string, maxRows: number): Promise<string> {
  const lines = Math.max(1, Math.trunc(maxRows))
  try {
    const result = await execFileAsync('tail', ['-n', String(lines), path], {
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return result.stdout
  } catch {
    return readFile(path, 'utf-8')
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const outputPath = resolve(path)
  await mkdir(dirname(outputPath), { recursive: true })
  const tmpPath = `${outputPath}.${process.pid}.tmp`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, outputPath)
}

function isRowExplicitObservedOrFetched(row: UnknownRecord): boolean {
  return readString(row.observedAtBasis)?.startsWith('row_explicit_') === true ||
    readString(row.fetchedAtBasis)?.startsWith('row_explicit_') === true
}

function buildOverallFreshness(input: {
  rows: UnknownRecord[]
  generatedAt: string
  maxObservationAgeMinutes: number
  timeframeFreshness: OpenAliceOhlcvCollectorPitContractStatusReport['timeframeFreshness']
}): OpenAliceOhlcvCollectorPitContractStatusReport['freshness'] {
  const latestEventTime = maxIso(input.rows.map(row => readString(row.eventTime)))
  const latestObservedAt = maxIso(input.rows.map(row => readString(row.observedAt)))
  const latestFetchedAt = maxIso(input.rows.map(row => readString(row.fetchedAt)))
  const latestAvailableAt = maxIso(input.rows.map(row => readString(row.availableAt)))
  const latestCollectorObservationAgeMinutes = latestObservedAt
    ? ageMinutes(input.generatedAt, latestObservedAt)
    : null
  const staleTimeframes = input.timeframeFreshness
    .filter(item => item.stale)
    .map(item => item.timeframe)
  return {
    latestEventTime,
    latestObservedAt,
    latestFetchedAt,
    latestAvailableAt,
    latestCollectorObservationAgeMinutes,
    maxObservationAgeMinutes: input.maxObservationAgeMinutes,
    stale: staleTimeframes.length > 0 || latestCollectorObservationAgeMinutes == null,
    staleTimeframes,
  }
}

function buildTimeframeFreshness(input: {
  rows: UnknownRecord[]
  generatedAt: string
  maxObservationAgeMinutes: number
}): OpenAliceOhlcvCollectorPitContractStatusReport['timeframeFreshness'] {
  const grouped = new Map<string, UnknownRecord[]>()
  for (const row of input.rows) {
    const timeframe = readString(row.timeframe) ?? 'unknown'
    grouped.set(timeframe, [...(grouped.get(timeframe) ?? []), row])
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([timeframe, rows]) => {
      const latestObservedAt = maxIso(rows.map(row => readString(row.observedAt)))
      const latestCollectorObservationAgeMinutes = latestObservedAt
        ? ageMinutes(input.generatedAt, latestObservedAt)
        : null
      return {
        timeframe,
        rows: rows.length,
        latestEventTime: maxIso(rows.map(row => readString(row.eventTime))),
        latestObservedAt,
        latestCollectorObservationAgeMinutes,
        stale: latestCollectorObservationAgeMinutes == null ||
          latestCollectorObservationAgeMinutes > input.maxObservationAgeMinutes,
      }
    })
}

function maxIso(values: Array<string | null>): string | null {
  let best: string | null = null
  let bestMs = Number.NEGATIVE_INFINITY
  for (const value of values) {
    if (!isIsoLike(value)) continue
    const ms = Date.parse(value)
    if (ms > bestMs) {
      bestMs = ms
      best = value
    }
  }
  return best
}

function ageMinutes(generatedAt: string, observedAt: string): number | null {
  const generatedAtMs = Date.parse(generatedAt)
  const observedAtMs = Date.parse(observedAt)
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(observedAtMs)) return null
  return Number(Math.max(0, (generatedAtMs - observedAtMs) / 60_000).toFixed(3))
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

function parseNullablePath(value: string | undefined | null): string | null {
  if (!value) return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'null' || normalized === 'none' ? null : resolve(value)
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

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function pct(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Number(((numerator / denominator) * 100).toFixed(6))
}

function isIsoLike(value: string | null): boolean {
  return value != null && Number.isFinite(Date.parse(value))
}

function renderConsoleSummary(report: OpenAliceOhlcvCollectorPitContractStatusReport): string {
  return [
    `OpenAlice OHLCV collector PIT contract status: ${report.status}`,
    `rows=${report.counts.rowsScanned} rowExplicitAvailableAt=${report.counts.rowsWithRowExplicitAvailableAt} rowExplicitObservedOrFetchedAt=${report.counts.rowsWithRowExplicitObservedOrFetchedAt} promotionGrade=${report.counts.rowsPromotionGrade}`,
    `latestObservedAt=${report.freshness.latestObservedAt ?? 'missing'} ageMin=${report.freshness.latestCollectorObservationAgeMinutes ?? 'missing'} stale=${report.freshness.stale}`,
    `coverage rowExplicitAvailableAt=${report.coverage.rowExplicitAvailableAtPct}% rowExplicitObservedOrFetchedAt=${report.coverage.rowExplicitObservedOrFetchedAtPct}% promotionGrade=${report.coverage.promotionGradePct}%`,
    'paper=false live=false promotion=false execution=false',
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
