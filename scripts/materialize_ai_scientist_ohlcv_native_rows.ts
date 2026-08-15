import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const execFileAsync = promisify(execFile)

type UnknownRecord = Record<string, unknown>

type MaterializeStatus =
  | 'blocked_missing_plan'
  | 'blocked_no_materialization_candidates'
  | 'research_rows_materialized_pit_blocked'

interface CliArgs {
  planPath: string
  dailySupplementPlanPath?: string | null
  outputPath: string
  reportPath: string | null
  maxTasks: number
  maxRowsPerTask: number
  json: boolean
}

export interface NativeOhlcvRow {
  schemaVersion: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1'
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  runId: string | null
  candidateId: string | null
  family: string | null
  taskId: string
  sourceRelativePath: string | null
  exchange: 'binance'
  market: 'usdm'
  symbol: string
  rawSymbol: string
  binanceSymbol: string
  timeframe: string
  eventTime: string
  eventTimeMs: number
  eventTimeBasis: 'binance_kline_open_time'
  availableAt: string
  availableAtMs: number
  availableAtBasis: 'archive_materialization_time_research_only_not_historical_decision_available_at'
  observedAt: string
  observedAtBasis: 'materializer_observed_archive_row'
  fetchedAt: string
  fetchedAtBasis: 'materializer_read_local_archive'
  generatedAt: string
  jobId: string
  sourceEndpoint: string | null
  sourceManifestId: string
  sourceZipPath: string
  sourceZipMonth: string
  sourceZipStatus: string | null
  sourceRowIndex: number
  sourceRowHash: string
  lineageScope: 'row'
  rowPITUsableForPromotion: false
  pitSuitability: 'research_reproduction_only_archive_materialized_not_promotion_grade'
  openalicePitContractStatus: 'research_reproduction_archive_materialized_pit_blocked'
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number | null
  tradeCount: number | null
  takerBuyVolume: number | null
  takerBuyQuoteVolume: number | null
  quality: {
    promotionGrade: false
    pitLineageStatus: 'research_reproduction_archive_materialized_pit_blocked'
    blockers: string[]
  }
}

export interface AiScientistOhlcvMaterializeReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: MaterializeStatus
  sourceArtifacts: {
    plan: string
    dailySupplementPlan: string | null
  }
  outputPath: string
  jobId: string
  sampling: {
    maxTasks: number
    maxRowsPerTask: number
    sampled: boolean
  }
  counts: {
    planTasksRead: number
    materializationCandidateTasks: number
    nativeMaterializationCandidateTasks: number
    dailySupplementTaskPlansRead: number
    dailySupplementCandidateTasks: number
    dailySupplementZipFiles: number
    tasksMaterialized: number
    tasksSkipped: number
    zipFilesRead: number
    rowsRead: number
    rowsWritten: number
    promotionGradeRows: number
    distinctSymbols: number
  }
  symbols: string[]
  observedStartTime: string | null
  observedEndTime: string | null
  outputHash: string | null
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_PLAN_PATH = 'data/research/ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json'
const DEFAULT_DAILY_SUPPLEMENT_PLAN_PATH = 'data/research/ai_scientist_openalice_ohlcv_daily_supplement_plan.latest.json'
const DEFAULT_REPORT_PATH = 'data/research/ai_scientist_openalice_ohlcv_native_rows.latest.json'
const DEFAULT_MAX_TASKS = 72
const DEFAULT_MAX_ROWS_PER_TASK = 500

async function main(): Promise<void> {
  const args = parseAiScientistOhlcvMaterializeArgs(process.argv.slice(2))
  const report = await runAiScientistOhlcvMaterialize(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistOhlcvMaterializeArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const dataRoot = resolve(raw.get('dataRoot') ?? raw.get('warehouseRoot') ?? process.env.OPENALICE_DATA_ROOT ?? 'data')
  return {
    planPath: raw.get('planPath') ?? DEFAULT_PLAN_PATH,
    dailySupplementPlanPath: parseNullablePath(
      raw.get('dailySupplementPlanPath') ?? raw.get('dailySupplementPlan') ?? DEFAULT_DAILY_SUPPLEMENT_PLAN_PATH,
    ),
    outputPath: resolve(
      raw.get('outputPath') ??
      raw.get('output') ??
      resolve(dataRoot, 'normalized/research/ai_scientist/openalice_ohlcv_native_rows.research_only.jsonl'),
    ),
    reportPath: parseNullablePath(raw.get('reportPath') ?? raw.get('report') ?? DEFAULT_REPORT_PATH),
    maxTasks: parseNonNegativeInteger(raw.get('maxTasks'), DEFAULT_MAX_TASKS),
    maxRowsPerTask: parseNonNegativeInteger(raw.get('maxRowsPerTask'), DEFAULT_MAX_ROWS_PER_TASK),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistOhlcvMaterialize(args: CliArgs): Promise<AiScientistOhlcvMaterializeReport> {
  const startedAt = new Date()
  const generatedAt = new Date().toISOString()
  const jobId = `ai_scientist_ohlcv_native_materialize.${generatedAt.replace(/[:.]/g, '')}`
  const planPath = resolve(args.planPath)
  const dailySupplementPlanPath = args.dailySupplementPlanPath ? resolve(args.dailySupplementPlanPath) : null
  const plan = asRecord(await readJsonIfExists(planPath))
  const dailySupplementPlan = dailySupplementPlanPath ? asRecord(await readJsonIfExists(dailySupplementPlanPath)) : null
  const taskPlans = readRecordArray(plan?.taskPlans)
  const nativeCandidates = taskPlans.filter(task => readBoolean(task.materializationCandidate) === true)
  const dailySupplementCandidates = buildDailySupplementCandidates(taskPlans, dailySupplementPlan)
  const candidates = uniqueRecordsBy(
    [...nativeCandidates, ...dailySupplementCandidates],
    task => readString(task.taskId) ?? stableHash(task),
  ).slice(0, args.maxTasks > 0 ? args.maxTasks : undefined)
  const rows: NativeOhlcvRow[] = []
  let zipFilesRead = 0
  let rowsRead = 0
  let tasksMaterialized = 0

  if (plan && candidates.length > 0) {
    for (const task of candidates) {
      const beforeRows = rows.length
      const result = await materializeTask({
        task,
        generatedAt,
        jobId,
        maxRows: args.maxRowsPerTask,
      })
      zipFilesRead += result.zipFilesRead
      rowsRead += result.rowsRead
      rows.push(...result.rows)
      if (rows.length > beforeRows) tasksMaterialized++
    }
  }

  const output = rows.map(row => JSON.stringify(row)).join('\n')
  await atomicWrite(args.outputPath, output ? `${output}\n` : '')
  const outputHash = output ? sha256Hex(`${output}\n`) : null
  const symbols = uniqueStrings(rows.map(row => row.symbol))
  const eventTimes = rows.map(row => row.eventTime).sort()
  const blockers = uniqueStrings([
    ...(plan ? [] : ['ai_scientist_ohlcv_native_rebuild_plan_missing']),
    ...(plan && candidates.length > 0 ? [] : ['ohlcv_materialization_candidates_missing']),
    ...(rows.length > 0 ? [] : ['ohlcv_materialized_rows_missing']),
    'ohlcv_native_rows_research_only',
    'ohlcv_native_rows_not_promotion_grade',
    'row_pit_usable_for_promotion_false',
  ])
  const report: AiScientistOhlcvMaterializeReport = {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: !plan
      ? 'blocked_missing_plan'
      : candidates.length === 0
        ? 'blocked_no_materialization_candidates'
        : 'research_rows_materialized_pit_blocked',
    sourceArtifacts: {
      plan: planPath,
      dailySupplementPlan: dailySupplementPlanPath,
    },
    outputPath: args.outputPath,
    jobId,
    sampling: {
      maxTasks: args.maxTasks,
      maxRowsPerTask: args.maxRowsPerTask,
      sampled: args.maxTasks > 0 || args.maxRowsPerTask > 0,
    },
    counts: {
      planTasksRead: taskPlans.length,
      materializationCandidateTasks: candidates.length,
      nativeMaterializationCandidateTasks: nativeCandidates.length,
      dailySupplementTaskPlansRead: readRecordArray(dailySupplementPlan?.taskPlans).length,
      dailySupplementCandidateTasks: dailySupplementCandidates.length,
      dailySupplementZipFiles: uniqueStrings(dailySupplementCandidates.flatMap(task => readStringArray(task.dailySupplementZipPaths))).length,
      tasksMaterialized,
      tasksSkipped: Math.max(0, taskPlans.length - candidates.length),
      zipFilesRead,
      rowsRead,
      rowsWritten: rows.length,
      promotionGradeRows: 0,
      distinctSymbols: symbols.length,
    },
    symbols,
    observedStartTime: eventTimes[0] ?? null,
    observedEndTime: eventTimes.at(-1) ?? null,
    outputHash,
    blockers,
    nextActions: [
      'Use these rows only for research reproduction and contract plumbing; they are not promotion-grade PIT proof.',
      'Feed this output into a PIT contract report that explicitly keeps rowPITUsableForPromotion=false blocked.',
      'When daily supplement archives are present, materialize them only as archive-derived research rows, never as promotion-grade PIT proof.',
      'For promotion-grade evidence, collect or reconstruct row-explicit historical availability without using archive read time as decision-time availability.',
    ],
    safetyNotes: [
      'This materializer cannot authorize paper orders, live orders, promotion, leverage changes, best_config mutation, or non-flat target publication.',
      'Rows are archive-materialized from local Binance Data Vision zip files and remain research-only.',
      'No API key, secret, passphrase, or order target is read or emitted.',
    ],
  }

  await writeEvidenceManifestForArtifact({
    job: 'ai_scientist_openalice_ohlcv_native_rows',
    artifactPath: args.outputPath,
    startedAt,
    finishedAt: new Date(),
    exitCode: report.status === 'blocked_missing_plan' || report.status === 'blocked_no_materialization_candidates' ? 1 : 0,
    businessStatus: report.status === 'research_rows_materialized_pit_blocked' ? 'warn' : 'fail',
    recordsIn: rowsRead,
    recordsOut: rows.length,
    errorClass: report.blockers[0] ?? null,
    artifactHash: outputHash,
  })

  if (args.reportPath) {
    const reportPath = resolve(args.reportPath)
    await atomicWrite(reportPath, `${JSON.stringify(report, null, 2)}\n`)
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_ohlcv_native_rows_report',
      artifactPath: reportPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_plan' || report.status === 'blocked_no_materialization_candidates' ? 1 : 0,
      businessStatus: report.status === 'research_rows_materialized_pit_blocked' ? 'warn' : 'fail',
      recordsIn: rowsRead,
      recordsOut: rows.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

async function materializeTask(input: {
  task: UnknownRecord
  generatedAt: string
  jobId: string
  maxRows: number
}): Promise<{ zipFilesRead: number; rowsRead: number; rows: NativeOhlcvRow[] }> {
  const matchedZipPaths = readStringArray(input.task.matchedZipPaths)
  const sourceStartMs = parseIsoMs(readString(input.task.sourceStartTime))
  const sourceEndMs = parseIsoMs(readString(input.task.sourceEndTime))
  const rawSymbol = readString(input.task.rawSymbol) ?? 'UNKNOWN_USDT_USDT'
  const binanceSymbol = readString(input.task.binanceSymbol) ?? rawSymbolToBinanceSymbol(rawSymbol) ?? rawSymbol
  const timeframe = readString(input.task.timeframe) ?? '1h'
  const taskId = readString(input.task.taskId) ?? `task.${sha256Hex(JSON.stringify(input.task)).slice(0, 16)}`
  const rows: NativeOhlcvRow[] = []
  let zipFilesRead = 0
  let rowsRead = 0

  for (const zipPath of matchedZipPaths) {
    if (input.maxRows > 0 && rows.length >= input.maxRows) break
    const csv = await unzipCsv(zipPath)
    zipFilesRead++
    const lines = csv.split(/\r?\n/).filter(line => line.trim().length > 0)
    const header = splitCsvLine(lines[0] ?? '')
    for (let index = 1; index < lines.length; index += 1) {
      if (input.maxRows > 0 && rows.length >= input.maxRows) break
      const parsed = parseKlineRow(header, splitCsvLine(lines[index]))
      if (!parsed) continue
      rowsRead++
      if (sourceStartMs != null && parsed.eventTimeMs < sourceStartMs) continue
      if (sourceEndMs != null && parsed.eventTimeMs > sourceEndMs) continue
      const sourceZipMonth = zipPath.match(/-(\d{4}-\d{2})\.zip$/)?.[1] ?? parsed.eventTime.slice(0, 7)
      const sourceManifestId = `binance_data_vision:um:klines:${binanceSymbol}:${sourceZipMonth}:${sha256Hex(zipPath).slice(0, 16)}`
      rows.push({
        schemaVersion: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1',
        researchOnly: true,
        promotionEligible: false,
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        executionAllowed: false,
        runId: readString(input.task.runId),
        candidateId: readString(input.task.candidateId),
        family: readString(input.task.family),
        taskId,
        sourceRelativePath: readString(input.task.sourceRelativePath),
        exchange: 'binance',
        market: 'usdm',
        symbol: readString(input.task.symbol) ?? normalizeSymbol(rawSymbol),
        rawSymbol,
        binanceSymbol,
        timeframe,
        eventTime: parsed.eventTime,
        eventTimeMs: parsed.eventTimeMs,
        eventTimeBasis: 'binance_kline_open_time',
        availableAt: input.generatedAt,
        availableAtMs: Date.parse(input.generatedAt),
        availableAtBasis: 'archive_materialization_time_research_only_not_historical_decision_available_at',
        observedAt: input.generatedAt,
        observedAtBasis: 'materializer_observed_archive_row',
        fetchedAt: input.generatedAt,
        fetchedAtBasis: 'materializer_read_local_archive',
        generatedAt: input.generatedAt,
        jobId: input.jobId,
        sourceEndpoint: 'https://data.binance.vision',
        sourceManifestId,
        sourceZipPath: zipPath,
        sourceZipMonth,
        sourceZipStatus: 'downloaded_or_exists',
        sourceRowIndex: index - 1,
        sourceRowHash: sha256Hex(`${zipPath}\n${lines[index]}`),
        lineageScope: 'row',
        rowPITUsableForPromotion: false,
        pitSuitability: 'research_reproduction_only_archive_materialized_not_promotion_grade',
        openalicePitContractStatus: 'research_reproduction_archive_materialized_pit_blocked',
        open: parsed.open,
        high: parsed.high,
        low: parsed.low,
        close: parsed.close,
        volume: parsed.volume,
        quoteVolume: parsed.quoteVolume,
        tradeCount: parsed.tradeCount,
        takerBuyVolume: parsed.takerBuyVolume,
        takerBuyQuoteVolume: parsed.takerBuyQuoteVolume,
        quality: {
          promotionGrade: false,
          pitLineageStatus: 'research_reproduction_archive_materialized_pit_blocked',
          blockers: [
            'archive_materialization_time_not_historical_decision_available_at',
            'row_pit_usable_for_promotion_false',
            'research_only_not_execution_evidence',
          ],
        },
      })
    }
  }

  return { zipFilesRead, rowsRead, rows }
}

function buildDailySupplementCandidates(taskPlans: UnknownRecord[], dailySupplementPlan: UnknownRecord | null): UnknownRecord[] {
  if (!dailySupplementPlan) return []
  const supplementTaskPlans = readRecordArray(dailySupplementPlan.taskPlans)
    .filter(task => readBoolean(task.supplementComplete) === true)
  const supplementByTaskId = new Map(
    supplementTaskPlans
      .map(task => [readString(task.taskId), readStringArray(task.supplementZipPaths)] as const)
      .filter((entry): entry is readonly [string, string[]] => entry[0] != null && entry[1].length > 0),
  )
  return taskPlans.flatMap(task => {
    const taskId = readString(task.taskId)
    const supplementZipPaths = taskId ? supplementByTaskId.get(taskId) : undefined
    if (!supplementZipPaths || supplementZipPaths.length === 0) return []
    const matchedZipPaths = uniqueStrings([
      ...readStringArray(task.matchedZipPaths),
      ...supplementZipPaths,
    ])
    return [{
      ...task,
      materializationCandidate: true,
      matchedZipPaths,
      missingArchiveMonths: [],
      dailySupplementApplied: true,
      dailySupplementZipPaths: supplementZipPaths,
    }]
  })
}

async function unzipCsv(zipPath: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', zipPath], {
    maxBuffer: 64 * 1024 * 1024,
  })
  return stdout
}

function parseKlineRow(header: string[], values: string[]): {
  eventTime: string
  eventTimeMs: number
  open: number
  high: number
  low: number
  close: number
  volume: number
  quoteVolume: number | null
  tradeCount: number | null
  takerBuyVolume: number | null
  takerBuyQuoteVolume: number | null
} | null {
  const record = Object.fromEntries(header.map((key, index) => [key, values[index] ?? '']))
  const eventTimeMs = parseTimestampMs(record.open_time ?? record.timestamp)
  const open = parseFiniteNumber(record.open)
  const high = parseFiniteNumber(record.high)
  const low = parseFiniteNumber(record.low)
  const close = parseFiniteNumber(record.close)
  const volume = parseFiniteNumber(record.volume)
  if (eventTimeMs == null || open == null || high == null || low == null || close == null || volume == null) return null
  return {
    eventTime: new Date(eventTimeMs).toISOString(),
    eventTimeMs,
    open,
    high,
    low,
    close,
    volume,
    quoteVolume: parseFiniteNumber(record.quote_volume),
    tradeCount: parseFiniteNumber(record.count),
    takerBuyVolume: parseFiniteNumber(record.taker_buy_volume),
    takerBuyQuoteVolume: parseFiniteNumber(record.taker_buy_quote_volume),
  }
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
  await writeFile(outputPath, content, 'utf-8')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next == null || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      index += 1
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
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

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is UnknownRecord => item != null) : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : []
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function parseIsoMs(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return null
  if (parsed > 10_000_000_000_000) return Math.floor(parsed / 1000)
  return parsed
}

function parseFiniteNumber(value: string | undefined): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function splitCsvLine(line: string): string[] {
  return line.split(',').map(value => value.trim())
}

function rawSymbolToBinanceSymbol(rawSymbol: string | null): string | null {
  if (!rawSymbol) return null
  const parts = rawSymbol.split('_')
  if (parts.length < 2) return rawSymbol.replace(/_/g, '')
  return `${parts[0]}${parts[1]}`
}

function normalizeSymbol(rawSymbol: string): string {
  const parts = rawSymbol.split('_')
  if (parts.length >= 3 && parts.at(-1) === 'USDT') return `${parts[0]}/USDT:USDT`
  if (parts.length >= 2) return `${parts[0]}/${parts[1]}`
  return rawSymbol
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function uniqueRecordsBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const item of items) {
    const key = keyFn(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}

function stableJson(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => stableJson(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
}

function stableHash(value: unknown): string {
  return sha256Hex(stableJson(value))
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: AiScientistOhlcvMaterializeReport): string {
  return [
    `AI-Scientist OpenAlice OHLCV native rows: ${report.status}`,
    `rows=${report.counts.rowsWritten}/${report.counts.rowsRead} tasks=${report.counts.tasksMaterialized}/${report.counts.materializationCandidateTasks} zips=${report.counts.zipFilesRead}`,
    `symbols=${report.counts.distinctSymbols} promotionGradeRows=${report.counts.promotionGradeRows}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
