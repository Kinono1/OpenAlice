import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>
type ContractStatus = 'blocked_no_dataset' | 'blocked_pit_contract_missing' | 'ready_for_research_reproduction'

interface CliArgs {
  datasetReportPath: string
  inputPath: string | null
  nativeOhlcvRowsReportPath: string | null
  nativeOhlcvRowsPath: string | null
  outputPath: string | null
  maxRows: number
  json: boolean
}

export interface AiScientistPitContractStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ContractStatus
  sourceArtifacts: {
    datasetReport: string
    inputDataset: string | null
    nativeOhlcvRowsReport: string | null
    nativeOhlcvRows: string | null
  }
  counts: {
    datasetRowsReported: number
    nativeOhlcvRowsReported: number
    nativeOhlcvRowsScanned: number
    rowsScanned: number
    rowParseErrors: number
    rowsWithEventTime: number
    rowsWithAvailableAt: number
    rowsWithAvailableAtFieldButNotPromotionGrade: number
    rowsWithRowExplicitAvailableAt: number
    rowsWithObservedAt: number
    rowsWithFetchedAt: number
    rowsWithObservedOrFetchedFieldButNotPromotionGrade: number
    rowsWithRowLineageScope: number
    rowsWithRowPITUsableForPromotionFalse: number
    rowsWithRowExplicitObservedOrFetchedAt: number
    rowsPromotionGrade: number
    rowsWithQualityBlockers: number
    distinctSymbols: number
  }
  coverage: {
    eventTimePct: number
    availableAtPct: number
    rowExplicitAvailableAtPct: number
    observedOrFetchedAtPct: number
    rowExplicitObservedOrFetchedAtPct: number
    promotionGradePct: number
  }
  symbols: string[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
  sampleRows: Array<{
    runId: string | null
    candidateId: string | null
    symbol: string | null
    eventTime: string | null
    availableAtBasis: string | null
    observedAtBasis: string | null
    promotionGrade: boolean | null
    blockers: string[]
  }>
}

const DEFAULT_DATASET_REPORT_PATH = 'data/research/ai_scientist_openalice_pit_input_dataset.latest.json'
const DEFAULT_NATIVE_OHLCV_ROWS_REPORT_PATH = 'data/research/ai_scientist_openalice_ohlcv_native_rows.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_pit_contract_status.latest.json'
const DEFAULT_MAX_ROWS = 0

async function main(): Promise<void> {
  const args = parseAiScientistPitContractStatusArgs(process.argv.slice(2))
  const report = await runAiScientistPitContractStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistPitContractStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const datasetReportPath = resolve(raw.get('datasetReportPath') ?? raw.get('reportPath') ?? DEFAULT_DATASET_REPORT_PATH)
  return {
    datasetReportPath,
    inputPath: parseNullablePath(raw.get('inputPath') ?? raw.get('input') ?? null),
    nativeOhlcvRowsReportPath: parseNullablePath(raw.get('nativeOhlcvRowsReportPath') ?? raw.get('nativeReportPath') ?? DEFAULT_NATIVE_OHLCV_ROWS_REPORT_PATH),
    nativeOhlcvRowsPath: parseNullablePath(raw.get('nativeOhlcvRowsPath') ?? raw.get('nativeRowsPath') ?? null),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxRows: parseNonNegativeInteger(raw.get('maxRows'), DEFAULT_MAX_ROWS),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistPitContractStatus(
  args: CliArgs,
): Promise<AiScientistPitContractStatusReport> {
  const startedAt = new Date()
  const datasetReport = asRecord(await readJsonIfExists(args.datasetReportPath))
  const nativeOhlcvRowsReport = args.nativeOhlcvRowsReportPath
    ? asRecord(await readJsonIfExists(args.nativeOhlcvRowsReportPath))
    : null
  const inputPath = args.inputPath ? resolve(args.inputPath) : readString(datasetReport?.outputPath)
  const nativeOhlcvRowsPath = args.nativeOhlcvRowsPath
    ? resolve(args.nativeOhlcvRowsPath)
    : readString(nativeOhlcvRowsReport?.outputPath)
  const rows = inputPath ? await readJsonlRows(inputPath, args.maxRows, 'pit_input_dataset') : { rows: [], parseErrors: 0 }
  const nativeRows = nativeOhlcvRowsPath
    ? await readJsonlRows(nativeOhlcvRowsPath, args.maxRows, 'native_ohlcv_rows')
    : { rows: [], parseErrors: 0 }
  const report = buildAiScientistPitContractStatusReport({
    generatedAt: new Date().toISOString(),
    datasetReportPath: args.datasetReportPath,
    inputPath,
    nativeOhlcvRowsReportPath: args.nativeOhlcvRowsReportPath,
    nativeOhlcvRowsPath,
    datasetReport,
    nativeOhlcvRowsReport,
    rows: [
      ...rows.rows,
      ...nativeRows.rows,
    ],
    nativeOhlcvRowsScanned: nativeRows.rows.length,
    rowParseErrors: rows.parseErrors + nativeRows.parseErrors,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await atomicWrite(outputPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_pit_contract_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_no_dataset' ? 1 : 0,
      businessStatus: report.status === 'ready_for_research_reproduction' ? 'warn' : 'fail',
      recordsIn: report.counts.rowsScanned,
      recordsOut: report.counts.rowsScanned,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildAiScientistPitContractStatusReport(input: {
  generatedAt: string
  datasetReportPath: string
  inputPath: string | null
  nativeOhlcvRowsReportPath: string | null
  nativeOhlcvRowsPath: string | null
  datasetReport: UnknownRecord | null
  nativeOhlcvRowsReport: UnknownRecord | null
  rows: UnknownRecord[]
  nativeOhlcvRowsScanned: number
  rowParseErrors: number
}): AiScientistPitContractStatusReport {
  const datasetCounts = asRecord(input.datasetReport?.counts)
  const nativeOhlcvRowsReportCounts = asRecord(input.nativeOhlcvRowsReport?.counts)
  const datasetRowsReported = readNumber(datasetCounts?.rowsNormalized) ?? 0
  const nativeOhlcvRowsReported = readNumber(nativeOhlcvRowsReportCounts?.rowsWritten) ?? 0
  const symbols = uniqueStrings(input.rows.map(row => readString(row.symbol)).filter((value): value is string => value != null))
  const rowsWithEventTime = input.rows.filter(row => isIsoLike(readString(row.eventTime))).length
  const rowsWithAvailableAt = input.rows.filter(row => isIsoLike(readString(row.availableAt))).length
  const rowsWithAvailableAtFieldButNotPromotionGrade = input.rows.filter(row =>
    isIsoLike(readString(row.availableAt)) &&
    readString(row.availableAtBasis) !== 'row_explicit_available_at').length
  const rowsWithRowExplicitAvailableAt = input.rows.filter(row => readString(row.availableAtBasis) === 'row_explicit_available_at').length
  const rowsWithObservedAt = input.rows.filter(row => isIsoLike(readString(row.observedAt))).length
  const rowsWithFetchedAt = input.rows.filter(row => isIsoLike(readString(row.fetchedAt))).length
  const rowsWithObservedOrFetchedFieldButNotPromotionGrade = input.rows.filter(row =>
    (isIsoLike(readString(row.observedAt)) || isIsoLike(readString(row.fetchedAt))) &&
    !isPromotionGradeObservedOrFetchedBasis(row)).length
  const rowsWithRowLineageScope = input.rows.filter(row => readString(row.lineageScope) === 'row').length
  const rowsWithRowPITUsableForPromotionFalse = input.rows.filter(row => readBoolean(row.rowPITUsableForPromotion) === false).length
  const rowsWithRowExplicitObservedOrFetchedAt = input.rows.filter(row =>
    isPromotionGradeObservedOrFetchedBasis(row)).length
  const rowsPromotionGrade = input.rows.filter(row => readBoolean(asRecord(row.quality)?.promotionGrade) === true).length
  const rowsWithQualityBlockers = input.rows.filter(row => readStringArray(asRecord(row.quality)?.blockers).length > 0).length
  const rowsScanned = input.rows.length
  const blockers = uniqueStrings([
    ...(input.datasetReport ? [] : ['ai_scientist_pit_input_dataset_report_missing']),
    ...(input.inputPath ? [] : ['ai_scientist_pit_input_dataset_path_missing']),
    ...(rowsScanned > 0 ? [] : ['ai_scientist_pit_input_rows_missing']),
    ...(input.rowParseErrors === 0 ? [] : [`ai_scientist_pit_input_row_parse_errors:${input.rowParseErrors}`]),
    ...(rowsWithEventTime === rowsScanned && rowsScanned > 0 ? [] : [`event_time_coverage_incomplete:${rowsWithEventTime}/${rowsScanned}`]),
    ...(rowsWithAvailableAt === rowsScanned && rowsScanned > 0 ? [] : [`available_at_coverage_incomplete:${rowsWithAvailableAt}/${rowsScanned}`]),
    ...(rowsWithObservedAt + rowsWithFetchedAt >= rowsScanned && rowsScanned > 0 ? [] : [`observed_or_fetched_at_coverage_incomplete:${rowsWithObservedAt + rowsWithFetchedAt}/${rowsScanned}`]),
    ...(rowsWithRowExplicitAvailableAt === rowsScanned && rowsScanned > 0 ? [] : [`row_explicit_available_at_missing:${rowsWithRowExplicitAvailableAt}/${rowsScanned}`]),
    ...(rowsWithRowExplicitObservedOrFetchedAt === rowsScanned && rowsScanned > 0 ? [] : [`row_explicit_observed_or_fetched_at_missing:${rowsWithRowExplicitObservedOrFetchedAt}/${rowsScanned}`]),
    ...(rowsWithRowPITUsableForPromotionFalse === 0 ? [] : [`row_pit_usable_for_promotion_false:${rowsWithRowPITUsableForPromotionFalse}/${rowsScanned}`]),
    ...(rowsPromotionGrade === rowsScanned && rowsScanned > 0 ? [] : [`promotion_grade_rows_missing:${rowsPromotionGrade}/${rowsScanned}`]),
    ...(rowsWithQualityBlockers === 0 ? [] : [`quality_blockers_present:${rowsWithQualityBlockers}/${rowsScanned}`]),
    'ai_scientist_pit_contract_research_only',
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
    status: !input.datasetReport || !input.inputPath || rowsScanned === 0
      ? 'blocked_no_dataset'
      : rowsWithRowExplicitAvailableAt === rowsScanned &&
        rowsWithRowExplicitObservedOrFetchedAt === rowsScanned &&
        rowsPromotionGrade === rowsScanned &&
        rowsWithQualityBlockers === 0
          ? 'ready_for_research_reproduction'
          : 'blocked_pit_contract_missing',
    sourceArtifacts: {
      datasetReport: input.datasetReportPath,
      inputDataset: input.inputPath,
      nativeOhlcvRowsReport: input.nativeOhlcvRowsReportPath,
      nativeOhlcvRows: input.nativeOhlcvRowsPath,
    },
    counts: {
      datasetRowsReported,
      nativeOhlcvRowsReported,
      nativeOhlcvRowsScanned: input.nativeOhlcvRowsScanned,
      rowsScanned,
      rowParseErrors: input.rowParseErrors,
      rowsWithEventTime,
      rowsWithAvailableAt,
      rowsWithAvailableAtFieldButNotPromotionGrade,
      rowsWithRowExplicitAvailableAt,
      rowsWithObservedAt,
      rowsWithFetchedAt,
      rowsWithObservedOrFetchedFieldButNotPromotionGrade,
      rowsWithRowLineageScope,
      rowsWithRowPITUsableForPromotionFalse,
      rowsWithRowExplicitObservedOrFetchedAt,
      rowsPromotionGrade,
      rowsWithQualityBlockers,
      distinctSymbols: symbols.length,
    },
    coverage: {
      eventTimePct: pct(rowsWithEventTime, rowsScanned),
      availableAtPct: pct(rowsWithAvailableAt, rowsScanned),
      rowExplicitAvailableAtPct: pct(rowsWithRowExplicitAvailableAt, rowsScanned),
      observedOrFetchedAtPct: pct(Math.min(rowsScanned, rowsWithObservedAt + rowsWithFetchedAt), rowsScanned),
      rowExplicitObservedOrFetchedAtPct: pct(rowsWithRowExplicitObservedOrFetchedAt, rowsScanned),
      promotionGradePct: pct(rowsPromotionGrade, rowsScanned),
    },
    symbols,
    blockers,
    nextActions: [
      'Replace file-mtime observedAt/fetchedAt with row-explicit collector observedAt/fetchedAt before PIT audit can pass.',
      'Replace derived bar-close availableAt with row-explicit availableAt from the data capture contract.',
      'Treat native OHLCV archive-materialized rows as row-lineage research reproduction data only until historical decision-time availability is proven.',
      'Keep this artifact research-only until OpenAlice-native WFO/FDR/route-cost/slippage/risk gates pass.',
    ],
    safetyNotes: [
      'This contract status cannot authorize paper orders, live orders, promotion, leverage changes, or best_config mutations.',
      'A complete contract here would only make the dataset eligible for research reproduction, not trading.',
    ],
    sampleRows: input.rows.slice(0, 3).map(row => ({
      runId: readString(row.runId),
      candidateId: readString(row.candidateId),
      symbol: readString(row.symbol),
      eventTime: readString(row.eventTime),
      availableAtBasis: readString(row.availableAtBasis),
      observedAtBasis: readString(row.observedAtBasis),
      promotionGrade: readBoolean(asRecord(row.quality)?.promotionGrade),
      blockers: readStringArray(asRecord(row.quality)?.blockers),
    })),
  }
}

async function readJsonlRows(
  path: string,
  maxRows: number,
  rowSource: 'pit_input_dataset' | 'native_ohlcv_rows',
): Promise<{ rows: UnknownRecord[]; parseErrors: number }> {
  try {
    const text = await readFile(path, 'utf-8')
    const out: UnknownRecord[] = []
    let parseErrors = 0
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      if (maxRows > 0 && out.length >= maxRows) break
      try {
        const parsed = JSON.parse(line)
        const record = asRecord(parsed)
        if (record) out.push({
          ...record,
          contractRowSource: rowSource,
        })
        else parseErrors += 1
      } catch {
        parseErrors += 1
      }
    }
    return { rows: out, parseErrors }
  } catch {
    return { rows: [], parseErrors: 0 }
  }
}

function isPromotionGradeObservedOrFetchedBasis(row: UnknownRecord): boolean {
  return ['row_explicit_observed_at', 'row_explicit_fetched_at', 'row_explicit_observed_or_fetched_at'].includes(readString(row.observedAtBasis) ?? '') ||
    readString(row.fetchedAtBasis)?.startsWith('row_explicit_') === true
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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
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

function renderConsoleSummary(report: AiScientistPitContractStatusReport): string {
  return [
    `AI-Scientist OpenAlice PIT contract status: ${report.status}`,
    `rows=${report.counts.rowsScanned}/${report.counts.datasetRowsReported} rowExplicitAvailableAt=${report.counts.rowsWithRowExplicitAvailableAt} rowExplicitObservedOrFetchedAt=${report.counts.rowsWithRowExplicitObservedOrFetchedAt} promotionGrade=${report.counts.rowsPromotionGrade}`,
    `coverage availableAt=${report.coverage.availableAtPct}% rowExplicitAvailableAt=${report.coverage.rowExplicitAvailableAtPct}% promotionGrade=${report.coverage.promotionGradePct}%`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error)
    process.exitCode = 1
  })
}
