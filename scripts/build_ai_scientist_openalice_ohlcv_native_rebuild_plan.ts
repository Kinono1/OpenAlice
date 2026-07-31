import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type RebuildPlanStatus =
  | 'blocked_missing_rebuild_queue'
  | 'blocked_no_ohlcv_tasks'
  | 'blocked_missing_data_vision_archives'
  | 'ready_for_research_only_ohlcv_materialization'

interface CliArgs {
  rebuildQueuePath: string
  dataCatalogPath: string
  warehouseRoot: string
  outputPath: string | null
  maxTasks: number
  maxCsvRowsPerTask: number
  maxManifestLines: number
  json: boolean
}

interface ManifestZipRecord {
  symbol: string
  month: string
  zipPath: string
  status: string
  url: string | null
  key: string | null
  sourceManifestId: string | null
  lineageScope: string | null
  rowPITUsableForPromotion: boolean | null
  observedAt: string | null
  fetchedAt: string | null
  availableAt: string | null
}

interface KlineArchiveInspection {
  datasetId: string
  manifestPath: string
  summaryPath: string | null
  manifestPresent: boolean
  manifestRowsRead: number
  zipRecords: number
  zipRecordsWithArchiveLineage: number
  zipRecordsWithRowPitPromotion: number
  symbols: string[]
  error: string | null
}

export interface AiScientistOhlcvNativeRebuildPlanTask {
  taskId: string
  runId: string | null
  candidateId: string | null
  family: string | null
  rawSymbol: string | null
  binanceSymbol: string | null
  symbol: string | null
  timeframe: string | null
  sourceFilePath: string | null
  sourceRelativePath: string | null
  sourceRowsRead: number
  sourceStartTime: string | null
  sourceEndTime: string | null
  requiredMonths: string[]
  matchedArchiveMonths: string[]
  missingArchiveMonths: string[]
  matchedZipPaths: string[]
  matchedArchiveLineageRows: number
  matchedRowPitPromotionRows: number
  materializationCandidate: boolean
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  outputContract: {
    schema: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1'
    lineageScope: 'row'
    requiredRowFields: string[]
    availableAtRule: string
    observedOrFetchedAtRule: string
    forbiddenShortcuts: string[]
  }
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistOhlcvNativeRebuildPlanReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: RebuildPlanStatus
  sourceArtifacts: {
    rebuildQueue: string
    dataCatalog: string
    warehouseRoot: string
  }
  archiveInspection: KlineArchiveInspection
  counts: {
    rebuildTasksRead: number
    ohlcvTasksAssessed: number
    uniqueTaskKeys: number
    materializationCandidateTasks: number
    tasksMissingArchiveMonths: number
    requiredMonths: number
    matchedArchiveMonths: number
    missingArchiveMonths: number
    matchedZipFiles: number
    archiveLineageRows: number
    rowPitPromotionZipRows: number
  }
  taskPlans: AiScientistOhlcvNativeRebuildPlanTask[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_REBUILD_QUEUE_PATH = 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json'
const DEFAULT_DATA_CATALOG_PATH = 'data/runtime/openalice_data_catalog.latest.json'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_ohlcv_native_rebuild_plan.latest.json'
const DEFAULT_MAX_TASKS = 500
const DEFAULT_MAX_CSV_ROWS_PER_TASK = 0
const DEFAULT_MAX_MANIFEST_LINES = 200000

async function main(): Promise<void> {
  const args = parseAiScientistOhlcvNativeRebuildPlanArgs(process.argv.slice(2))
  const report = await runAiScientistOhlcvNativeRebuildPlan(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistOhlcvNativeRebuildPlanArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    rebuildQueuePath: raw.get('rebuildQueuePath') ?? raw.get('queuePath') ?? DEFAULT_REBUILD_QUEUE_PATH,
    dataCatalogPath: raw.get('dataCatalogPath') ?? raw.get('catalogPath') ?? DEFAULT_DATA_CATALOG_PATH,
    warehouseRoot: raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxTasks: parseNonNegativeInteger(raw.get('maxTasks'), DEFAULT_MAX_TASKS),
    maxCsvRowsPerTask: parseNonNegativeInteger(raw.get('maxCsvRowsPerTask'), DEFAULT_MAX_CSV_ROWS_PER_TASK),
    maxManifestLines: parseNonNegativeInteger(raw.get('maxManifestLines'), DEFAULT_MAX_MANIFEST_LINES),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistOhlcvNativeRebuildPlan(
  args: CliArgs,
): Promise<AiScientistOhlcvNativeRebuildPlanReport> {
  const startedAt = new Date()
  const rebuildQueuePath = resolve(args.rebuildQueuePath)
  const dataCatalogPath = resolve(args.dataCatalogPath)
  const warehouseRoot = resolve(args.warehouseRoot)
  const report = await buildAiScientistOhlcvNativeRebuildPlanReport({
    generatedAt: new Date().toISOString(),
    rebuildQueuePath,
    dataCatalogPath,
    warehouseRoot,
    rebuildQueue: asRecord(await readJsonIfExists(rebuildQueuePath)),
    dataCatalog: asRecord(await readJsonIfExists(dataCatalogPath)),
    maxTasks: args.maxTasks,
    maxCsvRowsPerTask: args.maxCsvRowsPerTask,
    maxManifestLines: args.maxManifestLines,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_ohlcv_native_rebuild_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_rebuild_queue' ? 1 : 0,
      businessStatus: report.status === 'ready_for_research_only_ohlcv_materialization' ? 'warn' : 'fail',
      recordsIn: report.counts.rebuildTasksRead,
      recordsOut: report.counts.ohlcvTasksAssessed,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistOhlcvNativeRebuildPlanReport(input: {
  generatedAt: string
  rebuildQueuePath: string
  dataCatalogPath: string
  warehouseRoot: string
  rebuildQueue: UnknownRecord | null
  dataCatalog: UnknownRecord | null
  maxTasks: number
  maxCsvRowsPerTask: number
  maxManifestLines: number
}): Promise<AiScientistOhlcvNativeRebuildPlanReport> {
  const allTasks = readRecordArray(input.rebuildQueue?.tasks)
  const ohlcvTasks = allTasks
    .filter(isOhlcvTask)
    .slice(0, input.maxTasks > 0 ? input.maxTasks : undefined)
  const klineDataset = findKlineDataset(input.dataCatalog, '1h', 'BTC_USDT_USDT', input.warehouseRoot)
  const archiveInspection = await inspectKlineArchiveManifest({
    datasetId: klineDataset.datasetId,
    manifestPath: klineDataset.manifestPath,
    summaryPath: klineDataset.summaryPath,
    maxManifestLines: input.maxManifestLines,
  })
  const archiveBySymbolMonth = new Map<string, ManifestZipRecord>()
  for (const row of archiveInspectionRowsCache.get(archiveInspection.manifestPath) ?? []) {
    archiveBySymbolMonth.set(`${row.symbol}\n${row.month}`, row)
  }
  const taskPlans = await Promise.all(ohlcvTasks.map(task => buildTaskPlan({
    task,
    archiveBySymbolMonth,
    maxCsvRowsPerTask: input.maxCsvRowsPerTask,
  })))
  const uniqueTaskKeys = new Set(taskPlans.map(task =>
    [task.rawSymbol, task.timeframe, task.sourceRelativePath].join('\n'))).size
  const allRequiredMonths = taskPlans.flatMap(task => task.requiredMonths.map(month => `${task.binanceSymbol ?? ''}:${month}`))
  const allMatchedMonths = taskPlans.flatMap(task => task.matchedArchiveMonths.map(month => `${task.binanceSymbol ?? ''}:${month}`))
  const allMissingMonths = taskPlans.flatMap(task => task.missingArchiveMonths.map(month => `${task.binanceSymbol ?? ''}:${month}`))
  const matchedZipPaths = uniqueStrings(taskPlans.flatMap(task => task.matchedZipPaths))
  const counts = {
    rebuildTasksRead: allTasks.length,
    ohlcvTasksAssessed: taskPlans.length,
    uniqueTaskKeys,
    materializationCandidateTasks: taskPlans.filter(task => task.materializationCandidate).length,
    tasksMissingArchiveMonths: taskPlans.filter(task => task.missingArchiveMonths.length > 0).length,
    requiredMonths: uniqueStrings(allRequiredMonths).length,
    matchedArchiveMonths: uniqueStrings(allMatchedMonths).length,
    missingArchiveMonths: uniqueStrings(allMissingMonths).length,
    matchedZipFiles: matchedZipPaths.length,
    archiveLineageRows: taskPlans.reduce((sum, task) => sum + task.matchedArchiveLineageRows, 0),
    rowPitPromotionZipRows: taskPlans.reduce((sum, task) => sum + task.matchedRowPitPromotionRows, 0),
  }
  const blockers = uniqueStrings([
    ...(input.rebuildQueue ? [] : ['ai_scientist_pit_rebuild_queue_missing']),
    ...(input.rebuildQueue && taskPlans.length === 0 ? ['ai_scientist_ohlcv_rebuild_tasks_missing'] : []),
    ...(archiveInspection.manifestPresent ? [] : ['binance_data_vision_ohlcv_manifest_missing']),
    ...(counts.missingArchiveMonths > 0
      ? [`ai_scientist_ohlcv_archive_months_missing:${counts.missingArchiveMonths}/${counts.requiredMonths}`]
      : []),
    ...(counts.materializationCandidateTasks === taskPlans.length && taskPlans.length > 0
      ? []
      : [`ai_scientist_ohlcv_materialization_candidates_incomplete:${counts.materializationCandidateTasks}/${taskPlans.length}`]),
    'ai_scientist_ohlcv_native_rebuild_plan_research_only',
    'ohlcv_materialization_required_before_pit_contract',
  ])
  const status: RebuildPlanStatus = !input.rebuildQueue
    ? 'blocked_missing_rebuild_queue'
    : taskPlans.length === 0
      ? 'blocked_no_ohlcv_tasks'
      : counts.missingArchiveMonths > 0 || counts.materializationCandidateTasks < taskPlans.length
        ? 'blocked_missing_data_vision_archives'
        : 'ready_for_research_only_ohlcv_materialization'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      rebuildQueue: resolve(input.rebuildQueuePath),
      dataCatalog: resolve(input.dataCatalogPath),
      warehouseRoot: resolve(input.warehouseRoot),
    },
    archiveInspection,
    counts,
    taskPlans,
    blockers,
    nextActions: [
      'Materialize research-only OHLCV rows from matched Binance Data Vision zip files into OpenAlice warehouse JSONL/Parquet with row-level lineage.',
      'For historical Data Vision archives, set row eventTime from bar open time and keep availability semantics explicit; do not backdate collector observation time.',
      'After materialization, rerun PIT input dataset, PIT contract status, native rebuild status, goal audit, and system reason-chain.',
      'Keep the output research-only until OpenAlice PIT/WFO/FDR/route-cost/prospective/paper gates independently pass.',
    ],
    safetyNotes: [
      'This plan does not authorize paper trading, live trading, promotion, leverage, best_config edits, or non-flat target publication.',
      'Archive zip availability is not the same as historical decision-time feature availability; a later materializer must keep that distinction visible in row quality fields.',
      'No API key, secret, passphrase, or order target is read or emitted.',
    ],
  }
}

const archiveInspectionRowsCache = new Map<string, ManifestZipRecord[]>()

async function inspectKlineArchiveManifest(input: {
  datasetId: string
  manifestPath: string
  summaryPath: string | null
  maxManifestLines: number
}): Promise<KlineArchiveInspection> {
  try {
    const text = await readFile(input.manifestPath, 'utf-8')
    const rows: ManifestZipRecord[] = []
    let manifestRowsRead = 0
    let zipRecordsWithArchiveLineage = 0
    let zipRecordsWithRowPitPromotion = 0
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (input.maxManifestLines > 0 && manifestRowsRead >= input.maxManifestLines) break
      manifestRowsRead++
      const parsed = asRecord(parseJson(trimmed))
      if (!parsed) continue
      const symbol = readString(parsed.symbol)
      const month = readString(parsed.month)
      const zipPath = readString(parsed.zipPath)
      const status = readString(parsed.status) ?? 'unknown'
      if (!symbol || !month || !zipPath || !['downloaded', 'exists'].includes(status)) continue
      const row = {
        symbol,
        month,
        zipPath,
        status,
        url: readString(parsed.url) ?? readString(parsed.sourceUrl),
        key: readString(parsed.key) ?? readString(parsed.sourcePath),
        sourceManifestId: readString(parsed.sourceManifestId),
        lineageScope: readString(parsed.lineageScope),
        rowPITUsableForPromotion: readBoolean(parsed.rowPITUsableForPromotion),
        observedAt: readString(parsed.observedAt) ?? readString(parsed.collectorObservedAt),
        fetchedAt: readString(parsed.fetchedAt),
        availableAt: readString(parsed.availableAt) ?? readString(parsed.archiveFileAvailableAt),
      }
      rows.push(row)
      if (row.lineageScope === 'archive_file') zipRecordsWithArchiveLineage++
      if (row.rowPITUsableForPromotion === true) zipRecordsWithRowPitPromotion++
    }
    archiveInspectionRowsCache.set(input.manifestPath, rows)
    return {
      datasetId: input.datasetId,
      manifestPath: input.manifestPath,
      summaryPath: input.summaryPath,
      manifestPresent: true,
      manifestRowsRead,
      zipRecords: rows.length,
      zipRecordsWithArchiveLineage,
      zipRecordsWithRowPitPromotion,
      symbols: uniqueStrings(rows.map(row => row.symbol)),
      error: null,
    }
  } catch (error) {
    archiveInspectionRowsCache.set(input.manifestPath, [])
    return {
      datasetId: input.datasetId,
      manifestPath: input.manifestPath,
      summaryPath: input.summaryPath,
      manifestPresent: false,
      manifestRowsRead: 0,
      zipRecords: 0,
      zipRecordsWithArchiveLineage: 0,
      zipRecordsWithRowPitPromotion: 0,
      symbols: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function buildTaskPlan(input: {
  task: UnknownRecord
  archiveBySymbolMonth: Map<string, ManifestZipRecord>
  maxCsvRowsPerTask: number
}): Promise<AiScientistOhlcvNativeRebuildPlanTask> {
  const rawSymbol = readString(input.task.rawSymbol)
  const binanceSymbol = rawSymbolToBinanceSymbol(rawSymbol) ?? symbolToBinanceSymbol(readString(input.task.symbol))
  const sourceFilePath = readString(input.task.sourceFilePath)
  const csvInspection = sourceFilePath
    ? await inspectSourceCsvMonths(sourceFilePath, input.maxCsvRowsPerTask)
    : { rowsRead: 0, months: [], startTime: null, endTime: null, error: 'source_file_path_missing' }
  const requiredMonths = csvInspection.months
  const matchedArchiveRows = requiredMonths
    .map(month => input.archiveBySymbolMonth.get(`${binanceSymbol ?? ''}\n${month}`))
    .filter((row): row is ManifestZipRecord => row != null && existsSync(row.zipPath))
  const matchedArchiveMonths = uniqueStrings(matchedArchiveRows.map(row => row.month))
  const missingArchiveMonths = requiredMonths.filter(month => !matchedArchiveMonths.includes(month))
  const materializationCandidate = Boolean(sourceFilePath && binanceSymbol) &&
    requiredMonths.length > 0 &&
    missingArchiveMonths.length === 0
  const blockers = uniqueStrings([
    ...(sourceFilePath ? [] : ['source_file_path_missing']),
    ...(sourceFilePath && existsSync(sourceFilePath) ? [] : [`source_file_missing:${sourceFilePath ?? 'missing'}`]),
    ...(binanceSymbol ? [] : [`binance_symbol_unresolved:${rawSymbol ?? 'missing'}`]),
    ...(csvInspection.error ? [`source_csv_inspection_failed:${csvInspection.error}`] : []),
    ...(requiredMonths.length > 0 ? [] : ['source_csv_months_missing']),
    ...(missingArchiveMonths.length > 0 ? [`binance_data_vision_archive_months_missing:${missingArchiveMonths.length}`] : []),
    'research_only_materialization_required',
    'not_promotion_evidence',
  ])
  return {
    taskId: readString(input.task.taskId) ?? stableTaskId(input.task),
    runId: readString(input.task.runId),
    candidateId: readString(input.task.candidateId),
    family: readString(input.task.family),
    rawSymbol,
    binanceSymbol,
    symbol: readString(input.task.symbol),
    timeframe: readString(input.task.timeframe),
    sourceFilePath,
    sourceRelativePath: readString(input.task.sourceRelativePath),
    sourceRowsRead: csvInspection.rowsRead,
    sourceStartTime: csvInspection.startTime,
    sourceEndTime: csvInspection.endTime,
    requiredMonths,
    matchedArchiveMonths,
    missingArchiveMonths,
    matchedZipPaths: uniqueStrings(matchedArchiveRows.map(row => row.zipPath)),
    matchedArchiveLineageRows: matchedArchiveRows.filter(row => row.lineageScope === 'archive_file').length,
    matchedRowPitPromotionRows: matchedArchiveRows.filter(row => row.rowPITUsableForPromotion === true).length,
    materializationCandidate,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    outputContract: {
      schema: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1',
      lineageScope: 'row',
      requiredRowFields: [
        'eventTime',
        'observedAt',
        'fetchedAt',
        'availableAt',
        'exchange',
        'market',
        'symbol',
        'timeframe',
        'open',
        'high',
        'low',
        'close',
        'volume',
        'sourceEndpoint',
        'captureJobId',
        'generatedAt',
        'sourceManifestId',
        'sourceRowHash',
        'rowPITUsableForPromotion',
      ],
      availableAtRule: 'availability must be explicit and auditable; do not reuse eventTime or bar close as promotion-grade availability proof',
      observedOrFetchedAtRule: 'historical archive materialization may record materializer observation time, but must label rows research-only unless promotion-grade availability is independently proven',
      forbiddenShortcuts: [
        'source_file_mtime_recovered',
        'derived_bar_close_time_as_promotion_grade_availableAt',
        'archive_file_availableAt_as_historical_decision_availableAt',
      ],
    },
    blockers,
    nextActions: materializationCandidate
      ? ['Use matchedZipPaths to materialize research-only OpenAlice OHLCV rows, then rerun PIT contract status.']
      : ['Fill missing source CSV or Binance Data Vision archive months before materialization.'],
  }
}

async function inspectSourceCsvMonths(path: string, maxRows: number): Promise<{
  rowsRead: number
  months: string[]
  startTime: string | null
  endTime: string | null
  error: string | null
}> {
  try {
    const text = await readFile(path, 'utf-8')
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
    const header = splitCsvLine(lines[0] ?? '')
    const timestampIndex = header.findIndex(key => ['timestamp', 'open_time', 'eventTime', 'event_time'].includes(key))
    const datetimeIndex = header.findIndex(key => ['datetime', 'date', 'time'].includes(key))
    const months = new Set<string>()
    let rowsRead = 0
    let startMs: number | null = null
    let endMs: number | null = null
    const dataLines = maxRows > 0 ? lines.slice(1, 1 + maxRows) : lines.slice(1)
    for (const line of dataLines) {
      const values = splitCsvLine(line)
      const eventMs = parseEventTimeMs(values[timestampIndex], values[datetimeIndex])
      if (eventMs == null) continue
      rowsRead++
      const iso = new Date(eventMs).toISOString()
      months.add(iso.slice(0, 7))
      startMs = startMs == null ? eventMs : Math.min(startMs, eventMs)
      endMs = endMs == null ? eventMs : Math.max(endMs, eventMs)
    }
    return {
      rowsRead,
      months: [...months].sort(),
      startTime: startMs == null ? null : new Date(startMs).toISOString(),
      endTime: endMs == null ? null : new Date(endMs).toISOString(),
      error: null,
    }
  } catch (error) {
    return {
      rowsRead: 0,
      months: [],
      startTime: null,
      endTime: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function findKlineDataset(
  dataCatalog: UnknownRecord | null,
  timeframe: string,
  rawSymbol: string | null,
  warehouseRoot: string,
): { datasetId: string; manifestPath: string; summaryPath: string | null } {
  const market = rawSymbol?.endsWith('_USDT_USDT') ? 'um' : 'spot'
  const datasetId = `binance-public:${market}:klines:${timeframe}:usdt`
  const datasets = readRecordArray(dataCatalog?.datasets)
  const dataset = datasets.find(row => readString(row.datasetId) === datasetId)
  const provenance = asRecord(dataset?.provenance)
  const directory = market === 'um' ? `um-all-usdt-klines-${timeframe}` : `spot-all-usdt-klines-${timeframe}`
  const fallbackRoot = resolve(warehouseRoot, 'market/binance-public', directory)
  return {
    datasetId,
    manifestPath: readString(provenance?.manifestPath) ?? resolve(fallbackRoot, 'manifest.fast-binance-download.jsonl'),
    summaryPath: readString(provenance?.summaryPath) ?? resolve(fallbackRoot, 'summary.fast-binance-download.json'),
  }
}

function isOhlcvTask(task: UnknownRecord): boolean {
  return readString(task.timeframe) != null && readString(task.rawSymbol)?.includes('_USDT') === true
}

function parseEventTimeMs(timestamp: string | undefined, datetime: string | undefined): number | null {
  if (timestamp) {
    const numeric = Number(timestamp)
    if (Number.isFinite(numeric)) {
      if (numeric > 10_000_000_000_000) return Math.floor(numeric / 1000)
      return numeric
    }
  }
  if (datetime) {
    const parsed = Date.parse(datetime)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
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

function symbolToBinanceSymbol(symbol: string | null): string | null {
  if (!symbol) return null
  const match = /^([^/]+)\/([^:]+)(?::.+)?$/.exec(symbol)
  return match ? `${match[1]}${match[2]}` : symbol.replace(/[^A-Za-z0-9]/g, '')
}

function stableTaskId(task: UnknownRecord): string {
  return `ohlcv_rebuild.${sha256Hex(JSON.stringify(task)).slice(0, 16)}`
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
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

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is UnknownRecord => item != null) : []
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function renderConsoleSummary(report: AiScientistOhlcvNativeRebuildPlanReport): string {
  return [
    `AI-Scientist OpenAlice OHLCV native rebuild plan: ${report.status}`,
    `tasks=${report.counts.materializationCandidateTasks}/${report.counts.ohlcvTasksAssessed} materializationCandidate uniqueKeys=${report.counts.uniqueTaskKeys}`,
    `months=${report.counts.matchedArchiveMonths}/${report.counts.requiredMonths} matched missing=${report.counts.missingArchiveMonths} zips=${report.counts.matchedZipFiles}`,
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
