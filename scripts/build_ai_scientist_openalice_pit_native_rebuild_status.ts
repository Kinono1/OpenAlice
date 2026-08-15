import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type NativeRebuildStatus =
  | 'blocked_missing_rebuild_queue'
  | 'blocked_no_rebuild_tasks'
  | 'blocked_native_lineage_not_ready'
  | 'ready_for_derivatives_research_rebuild_only'

type SourceFamily = 'ohlcv_kline' | 'derivatives_feature' | 'unknown'

interface CliArgs {
  rebuildQueuePath: string
  dataCatalogPath: string
  normalizedDerivativesRowsPath: string
  warehouseRoot: string
  outputPath: string | null
  maxTasks: number
  maxManifestLines: number
  maxDerivativeRows: number
  json: boolean
}

interface ManifestInspection {
  path: string
  present: boolean
  linesRead: number
  jsonRows: number
  targetSymbolRows: number
  targetSymbolRowsWithCollectorTimes: number
  archiveFileLineageRows: number
  rowLineageRows: number
  rowPITUsableForPromotionRows: number
  promotionGradeRows: number
  fieldsPresent: string[]
  lineageScopes: string[]
  hasObservedOrFetchedAtField: boolean
  hasAvailableAtField: boolean
  hasCollectorJobField: boolean
  hasGeneratedAtField: boolean
  hasArchiveFileLineage: boolean
  hasRowLevelLineage: boolean
  hasPromotionGradeTimeFields: boolean
  hasCollectorTimes: boolean
  error: string | null
}

interface SummaryInspection {
  path: string
  present: boolean
  fieldsPresent: string[]
  hasBatchWindow: boolean
  startedAt: string | null
  endedAt: string | null
  coverage: string | null
  files: number | null
  error: string | null
}

interface DerivativesPitSourceInspection {
  path: string
  present: boolean
  rowsRead: number
  rowsWithEventTime: number
  rowsWithObservedOrFetchedAt: number
  rowsWithAvailableAt: number
  rowsWithSourceEndpoint: number
  rowsWithJobId: number
  rowsWithGeneratedAt: number
  rowsWithLineage: number
  pitSafeRows: number
  pitSafe: boolean
  symbols: string[]
  endpointIds: string[]
  error: string | null
}

export interface AiScientistPitNativeRebuildTaskStatus {
  taskId: string
  runId: string | null
  candidateId: string | null
  family: string | null
  symbol: string | null
  rawSymbol: string | null
  binanceSymbol: string | null
  timeframe: string | null
  sourceRelativePath: string | null
  sourceFamily: SourceFamily
  matchedKlineDatasetId: string | null
  matchedKlineDatasetStatus: string | null
  rawKlineManifestPath: string | null
  rawKlineSummaryPath: string | null
  rawKlineZipManifestPresent: boolean
  rawKlineZipManifestHasSymbolRows: boolean
  rawKlineZipManifestHasCollectorTimes: boolean
  rawKlineZipManifestHasPromotionGradeTimeFields: boolean
  rawKlineSummaryHasBatchWindow: boolean
  derivativesPitRowsAvailable: boolean
  derivativesPitEndpointIds: string[]
  canUseDerivativesPITRows: boolean
  autoRebuildEligible: boolean
  requiredCollectorUpgrade: boolean
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  blockers: string[]
  nextActions: string[]
}

export interface AiScientistPitNativeRebuildStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: NativeRebuildStatus
  sourceArtifacts: {
    rebuildQueue: string
    dataCatalog: string
    normalizedDerivativesRows: string
    warehouseRoot: string
  }
  counts: {
    rebuildTasksRead: number
    assessedTasks: number
    ohlcvKlineTasks: number
    derivativesFeatureTasks: number
    autoRebuildEligibleTasks: number
    requiredCollectorUpgradeTasks: number
    rawKlineManifestTasks: number
    rawKlineManifestPresentTasks: number
    rawKlineManifestWithCollectorTimesTasks: number
    rawKlineManifestWithPromotionGradeTimeFieldsTasks: number
    rawKlineSummaryWithBatchWindowTasks: number
    derivativesPitRowsAvailableTasks: number
    derivativesPitUsableTasks: number
  }
  derivativesPitSource: DerivativesPitSourceInspection
  taskStatuses: AiScientistPitNativeRebuildTaskStatus[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_REBUILD_QUEUE_PATH = 'data/research/ai_scientist_openalice_pit_rebuild_queue.latest.json'
const DEFAULT_DATA_CATALOG_PATH = 'data/runtime/openalice_data_catalog.latest.json'
const DEFAULT_WAREHOUSE_ROOT = 'data'
const DEFAULT_OUTPUT_PATH = 'data/research/ai_scientist_openalice_pit_native_rebuild_status.latest.json'
const DEFAULT_MAX_TASKS = 500
const DEFAULT_MAX_MANIFEST_LINES = 100000
const DEFAULT_MAX_DERIVATIVE_ROWS = 200000

async function main(): Promise<void> {
  const args = parseAiScientistPitNativeRebuildStatusArgs(process.argv.slice(2))
  const report = await runAiScientistPitNativeRebuildStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseAiScientistPitNativeRebuildStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const warehouseRoot = raw.get('warehouseRoot') ?? raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? DEFAULT_WAREHOUSE_ROOT
  return {
    rebuildQueuePath: raw.get('rebuildQueuePath') ?? raw.get('queuePath') ?? DEFAULT_REBUILD_QUEUE_PATH,
    dataCatalogPath: raw.get('dataCatalogPath') ?? raw.get('catalogPath') ?? DEFAULT_DATA_CATALOG_PATH,
    normalizedDerivativesRowsPath: raw.get('normalizedDerivativesRowsPath') ??
      raw.get('derivativesRowsPath') ??
      resolve(warehouseRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'),
    warehouseRoot,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxTasks: parseNonNegativeInteger(raw.get('maxTasks'), DEFAULT_MAX_TASKS),
    maxManifestLines: parseNonNegativeInteger(raw.get('maxManifestLines'), DEFAULT_MAX_MANIFEST_LINES),
    maxDerivativeRows: parseNonNegativeInteger(raw.get('maxDerivativeRows'), DEFAULT_MAX_DERIVATIVE_ROWS),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runAiScientistPitNativeRebuildStatus(
  args: CliArgs,
): Promise<AiScientistPitNativeRebuildStatusReport> {
  const startedAt = new Date()
  const rebuildQueuePath = resolve(args.rebuildQueuePath)
  const dataCatalogPath = resolve(args.dataCatalogPath)
  const normalizedDerivativesRowsPath = resolve(args.normalizedDerivativesRowsPath)
  const warehouseRoot = resolve(args.warehouseRoot)
  const rebuildQueue = asRecord(await readJsonIfExists(rebuildQueuePath))
  const dataCatalog = asRecord(await readJsonIfExists(dataCatalogPath))
  const derivativesPitSource = await inspectDerivativesPitSource(normalizedDerivativesRowsPath, args.maxDerivativeRows)
  const sourceArtifacts = {
    rebuildQueue: rebuildQueuePath,
    dataCatalog: dataCatalogPath,
    normalizedDerivativesRows: normalizedDerivativesRowsPath,
    warehouseRoot,
  }

  const report = await buildAiScientistPitNativeRebuildStatusReport({
    generatedAt: new Date().toISOString(),
    sourceArtifacts,
    rebuildQueue,
    dataCatalog,
    derivativesPitSource,
    warehouseRoot,
    maxTasks: args.maxTasks,
    maxManifestLines: args.maxManifestLines,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'ai_scientist_openalice_pit_native_rebuild_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: report.status === 'blocked_missing_rebuild_queue' ? 1 : 0,
      businessStatus: report.status === 'ready_for_derivatives_research_rebuild_only' ? 'warn' : 'fail',
      recordsIn: report.counts.rebuildTasksRead,
      recordsOut: report.counts.assessedTasks,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildAiScientistPitNativeRebuildStatusReport(input: {
  generatedAt: string
  sourceArtifacts: AiScientistPitNativeRebuildStatusReport['sourceArtifacts']
  rebuildQueue: UnknownRecord | null
  dataCatalog: UnknownRecord | null
  derivativesPitSource: DerivativesPitSourceInspection
  warehouseRoot: string
  maxTasks: number
  maxManifestLines: number
}): Promise<AiScientistPitNativeRebuildStatusReport> {
  const tasks = readRecordArray(input.rebuildQueue?.tasks)
    .filter(task => readString(task.status) === 'open')
    .slice(0, input.maxTasks > 0 ? input.maxTasks : undefined)
  const manifestCache = new Map<string, Promise<ManifestInspection>>()
  const summaryCache = new Map<string, Promise<SummaryInspection>>()
  const taskStatuses = await Promise.all(tasks.map(task => buildTaskStatus({
    task,
    dataCatalog: input.dataCatalog,
    derivativesPitSource: input.derivativesPitSource,
    warehouseRoot: input.warehouseRoot,
    maxManifestLines: input.maxManifestLines,
    manifestCache,
    summaryCache,
  })))
  const counts = {
    rebuildTasksRead: readNumber(asRecord(input.rebuildQueue?.counts)?.rebuildTasks) ?? tasks.length,
    assessedTasks: taskStatuses.length,
    ohlcvKlineTasks: taskStatuses.filter(task => task.sourceFamily === 'ohlcv_kline').length,
    derivativesFeatureTasks: taskStatuses.filter(task => task.sourceFamily === 'derivatives_feature').length,
    autoRebuildEligibleTasks: taskStatuses.filter(task => task.autoRebuildEligible).length,
    requiredCollectorUpgradeTasks: taskStatuses.filter(task => task.requiredCollectorUpgrade).length,
    rawKlineManifestTasks: taskStatuses.filter(task => task.rawKlineManifestPath != null).length,
    rawKlineManifestPresentTasks: taskStatuses.filter(task => task.rawKlineZipManifestPresent).length,
    rawKlineManifestWithCollectorTimesTasks: taskStatuses.filter(task => task.rawKlineZipManifestHasCollectorTimes).length,
    rawKlineManifestWithPromotionGradeTimeFieldsTasks: taskStatuses.filter(task =>
      task.rawKlineZipManifestHasPromotionGradeTimeFields).length,
    rawKlineSummaryWithBatchWindowTasks: taskStatuses.filter(task => task.rawKlineSummaryHasBatchWindow).length,
    derivativesPitRowsAvailableTasks: taskStatuses.filter(task => task.derivativesPitRowsAvailable).length,
    derivativesPitUsableTasks: taskStatuses.filter(task => task.canUseDerivativesPITRows).length,
  }
  const blockers = uniqueStrings([
    ...(input.rebuildQueue ? [] : ['ai_scientist_pit_rebuild_queue_missing']),
    ...(input.rebuildQueue && tasks.length === 0 ? ['ai_scientist_pit_rebuild_queue_has_no_open_tasks'] : []),
    ...(counts.assessedTasks > counts.autoRebuildEligibleTasks
      ? [`ai_scientist_pit_native_rebuild_tasks_not_auto_eligible:${counts.autoRebuildEligibleTasks}/${counts.assessedTasks}`]
      : []),
    ...(counts.requiredCollectorUpgradeTasks > 0
      ? [`ai_scientist_pit_ohlcv_collector_upgrade_required:${counts.requiredCollectorUpgradeTasks}`]
      : []),
    ...(counts.rawKlineManifestTasks > counts.rawKlineManifestWithPromotionGradeTimeFieldsTasks
      ? [`ai_scientist_pit_raw_kline_manifest_lacks_promotion_grade_times:${counts.rawKlineManifestWithPromotionGradeTimeFieldsTasks}/${counts.rawKlineManifestTasks}`]
      : []),
    ...(input.derivativesPitSource.present && !input.derivativesPitSource.pitSafe
      ? ['ai_scientist_pit_derivatives_source_not_pit_safe']
      : []),
    ...taskStatuses.flatMap(task => task.blockers.slice(0, 8).map(blocker => `${task.taskId}:${blocker}`)).slice(0, 48),
    'ai_scientist_pit_native_rebuild_status_research_only',
  ])
  const status: NativeRebuildStatus = !input.rebuildQueue
    ? 'blocked_missing_rebuild_queue'
    : tasks.length === 0
      ? 'blocked_no_rebuild_tasks'
      : counts.autoRebuildEligibleTasks > 0 && counts.autoRebuildEligibleTasks === counts.assessedTasks
        ? 'ready_for_derivatives_research_rebuild_only'
        : 'blocked_native_lineage_not_ready'

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
    sourceArtifacts: input.sourceArtifacts,
    counts,
    derivativesPitSource: input.derivativesPitSource,
    taskStatuses,
    blockers,
    nextActions: [
      'Upgrade OHLCV collectors or normalization jobs to emit row-explicit eventTime, observedAt/fetchedAt, availableAt, sourceEndpoint, captureJobId, generatedAt, sourceManifestId, and sourceRowHash.',
      'Use normalized derivatives PIT rows only for funding, open-interest, premium/basis, or long-short features; do not use them to certify OHLCV kline rows.',
      'After a native rebuild exists, rerun PIT input dataset, PIT contract status, OpenAlice goal audit, and system reason-chain.',
      'Keep this status artifact research-only; it is readiness plumbing, not profitability, paper, live, or promotion evidence.',
    ],
    safetyNotes: [
      'Binance Data Vision zip manifests without row-explicit observedAt/fetchedAt and availableAt remain insufficient for promotion-grade OpenAlice PIT rows.',
      'Batch summary startedAt/endedAt proves a download window, not feature availability at each historical decision time.',
      'No API key, secret, passphrase, order target, leverage setting, or best_config mutation is read or emitted by this script.',
    ],
  }
}

async function buildTaskStatus(input: {
  task: UnknownRecord
  dataCatalog: UnknownRecord | null
  derivativesPitSource: DerivativesPitSourceInspection
  warehouseRoot: string
  maxManifestLines: number
  manifestCache: Map<string, Promise<ManifestInspection>>
  summaryCache: Map<string, Promise<SummaryInspection>>
}): Promise<AiScientistPitNativeRebuildTaskStatus> {
  const taskId = readString(input.task.taskId) ?? 'unknown_task'
  const sourceRelativePath = readString(input.task.sourceRelativePath)
  const sourceFamily = classifySourceFamily(input.task)
  const rawSymbol = readString(input.task.rawSymbol)
  const symbol = readString(input.task.symbol)
  const binanceSymbol = rawSymbolToBinanceSymbol(rawSymbol) ?? symbolToBinanceSymbol(symbol)
  const timeframe = readString(input.task.timeframe)
  const klineDataset = sourceFamily === 'ohlcv_kline'
    ? findKlineDataset(input.dataCatalog, timeframe, rawSymbol, input.warehouseRoot)
    : null
  const manifestPath = klineDataset?.manifestPath ?? null
  const summaryPath = klineDataset?.summaryPath ?? null
  const manifest = manifestPath
    ? await cachedManifestInspection(input.manifestCache, manifestPath, binanceSymbol, input.maxManifestLines)
    : emptyManifestInspection(manifestPath)
  const summary = summaryPath
    ? await cachedSummaryInspection(input.summaryCache, summaryPath)
    : emptySummaryInspection(summaryPath)
  const derivativesPitRowsAvailable = binanceSymbol ? input.derivativesPitSource.symbols.includes(binanceSymbol) : false
  const canUseDerivativesPITRows = sourceFamily === 'derivatives_feature' &&
    input.derivativesPitSource.pitSafe &&
    derivativesPitRowsAvailable
  const autoRebuildEligible = canUseDerivativesPITRows
  const requiredCollectorUpgrade = sourceFamily === 'ohlcv_kline' && !manifest.hasPromotionGradeTimeFields
  const blockers = uniqueStrings([
    ...(readStringArray(input.task.missingFields).includes('availableAt') ? ['source_task_missing_availableAt'] : []),
    ...(readStringArray(input.task.missingFields).includes('observedAt_or_fetchedAt') ? ['source_task_missing_observedAt_or_fetchedAt'] : []),
    ...(readStringArray(input.task.missingFields).includes('completeOpenAliceWarehouseLineage') ? ['source_task_missing_completeOpenAliceWarehouseLineage'] : []),
    ...(sourceFamily === 'unknown' ? ['source_family_unknown'] : []),
    ...(sourceFamily === 'ohlcv_kline' && !manifest.present ? ['raw_kline_zip_manifest_missing'] : []),
    ...(sourceFamily === 'ohlcv_kline' && manifest.present && !manifest.hasCollectorTimes
      ? ['raw_kline_zip_manifest_lacks_collector_times']
      : []),
    ...(sourceFamily === 'ohlcv_kline' && manifest.present && !manifest.hasPromotionGradeTimeFields
      ? ['raw_kline_zip_manifest_lacks_row_explicit_observed_or_available_times']
      : []),
    ...(sourceFamily === 'ohlcv_kline' && manifest.present && manifest.hasArchiveFileLineage && !manifest.hasPromotionGradeTimeFields
      ? ['raw_kline_zip_manifest_is_archive_file_lineage_not_row_pit']
      : []),
    ...(sourceFamily === 'ohlcv_kline' && manifest.present && !manifest.hasRowLevelLineage
      ? ['raw_kline_zip_manifest_lacks_row_level_pit_lineage']
      : []),
    ...(sourceFamily === 'ohlcv_kline' && !manifest.targetSymbolRows ? [`raw_kline_zip_manifest_symbol_missing:${binanceSymbol ?? 'unknown'}`] : []),
    ...(sourceFamily === 'ohlcv_kline' && summary.hasBatchWindow
      ? ['raw_kline_summary_batch_window_not_row_explicit_pit']
      : []),
    ...(sourceFamily === 'ohlcv_kline' && requiredCollectorUpgrade ? ['ohlcv_native_collector_upgrade_required'] : []),
    ...(sourceFamily === 'ohlcv_kline' && !requiredCollectorUpgrade ? ['ohlcv_native_rebuild_not_implemented_research_only'] : []),
    ...(sourceFamily === 'derivatives_feature' && !derivativesPitRowsAvailable
      ? [`derivatives_pit_rows_missing_for_symbol:${binanceSymbol ?? 'unknown'}`]
      : []),
    ...(sourceFamily === 'derivatives_feature' && derivativesPitRowsAvailable && !input.derivativesPitSource.pitSafe
      ? ['derivatives_pit_source_lacks_required_pit_fields']
      : []),
    ...(sourceFamily === 'derivatives_feature' && canUseDerivativesPITRows
      ? ['derivatives_pit_rows_research_rebuild_only_not_promotion']
      : []),
  ])

  return {
    taskId,
    runId: readString(input.task.runId),
    candidateId: readString(input.task.candidateId),
    family: readString(input.task.family),
    symbol,
    rawSymbol,
    binanceSymbol,
    timeframe,
    sourceRelativePath,
    sourceFamily,
    matchedKlineDatasetId: klineDataset?.datasetId ?? null,
    matchedKlineDatasetStatus: klineDataset?.status ?? null,
    rawKlineManifestPath: manifestPath,
    rawKlineSummaryPath: summaryPath,
    rawKlineZipManifestPresent: manifest.present,
    rawKlineZipManifestHasSymbolRows: manifest.targetSymbolRows > 0,
    rawKlineZipManifestHasCollectorTimes: manifest.hasCollectorTimes,
    rawKlineZipManifestHasPromotionGradeTimeFields: manifest.hasPromotionGradeTimeFields,
    rawKlineSummaryHasBatchWindow: summary.hasBatchWindow,
    derivativesPitRowsAvailable,
    derivativesPitEndpointIds: input.derivativesPitSource.endpointIds,
    canUseDerivativesPITRows,
    autoRebuildEligible,
    requiredCollectorUpgrade,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    blockers,
    nextActions: canUseDerivativesPITRows
      ? ['Rebuild derivatives feature rows from normalized PIT-safe derivatives events, then rerun PIT contract status as research-only evidence.']
      : requiredCollectorUpgrade
        ? ['Add OpenAlice-native OHLCV row lineage before attempting to rebuild this AI-Scientist input file.']
        : ['Inspect source lineage manually before any rebuild; keep output research-only.'],
  }
}

function classifySourceFamily(task: UnknownRecord): SourceFamily {
  const path = `${readString(task.sourceRelativePath) ?? ''} ${readString(task.sourceFilePath) ?? ''}`.toLowerCase()
  if (/(funding|open[_-]?interest|long[_-]?short|basis|premium|mark[_-]?price|index[_-]?price)/i.test(path)) {
    return 'derivatives_feature'
  }
  if (readString(task.timeframe) || /_([0-9]+[a-z]+)\.csv$/i.test(path)) return 'ohlcv_kline'
  return 'unknown'
}

function findKlineDataset(
  dataCatalog: UnknownRecord | null,
  timeframe: string | null,
  rawSymbol: string | null,
  warehouseRoot: string,
): { datasetId: string; status: string | null; manifestPath: string | null; summaryPath: string | null } | null {
  if (!timeframe) return null
  const market = rawSymbol?.endsWith('_USDT_USDT') ? 'um' : 'spot'
  const expectedDatasetId = `binance-public:${market}:klines:${timeframe}:usdt`
  const datasets = readRecordArray(dataCatalog?.datasets)
  const dataset = datasets.find(item => readString(item.datasetId) === expectedDatasetId)
  if (dataset) {
    const provenance = asRecord(dataset.provenance)
    return {
      datasetId: expectedDatasetId,
      status: readString(dataset.status),
      manifestPath: readString(provenance?.manifestPath),
      summaryPath: readString(provenance?.summaryPath),
    }
  }
  const directory = market === 'um' ? `um-all-usdt-klines-${timeframe}` : `spot-all-usdt-klines-${timeframe}`
  const storagePath = resolve(warehouseRoot, 'market/binance-public', directory)
  return {
    datasetId: expectedDatasetId,
    status: null,
    manifestPath: resolve(storagePath, 'manifest.fast-binance-download.jsonl'),
    summaryPath: resolve(storagePath, 'summary.fast-binance-download.json'),
  }
}

async function cachedManifestInspection(
  cache: Map<string, Promise<ManifestInspection>>,
  path: string,
  targetSymbol: string | null,
  maxLines: number,
): Promise<ManifestInspection> {
  const cacheKey = `${path}\n${targetSymbol ?? ''}\n${maxLines}`
  const existing = cache.get(cacheKey)
  if (existing) return existing
  const promise = inspectJsonlManifest(path, targetSymbol, maxLines)
  cache.set(cacheKey, promise)
  return promise
}

async function cachedSummaryInspection(
  cache: Map<string, Promise<SummaryInspection>>,
  path: string,
): Promise<SummaryInspection> {
  const existing = cache.get(path)
  if (existing) return existing
  const promise = inspectSummary(path)
  cache.set(path, promise)
  return promise
}

async function inspectJsonlManifest(path: string, targetSymbol: string | null, maxLines: number): Promise<ManifestInspection> {
  try {
    const text = await readFile(path, 'utf-8')
    const fields = new Set<string>()
    const lineageScopes = new Set<string>()
    let linesRead = 0
    let jsonRows = 0
    let targetSymbolRows = 0
    let targetSymbolRowsWithCollectorTimes = 0
    let archiveFileLineageRows = 0
    let rowLineageRows = 0
    let rowPITUsableForPromotionRows = 0
    let promotionGradeRows = 0
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (maxLines > 0 && linesRead >= maxLines) break
      linesRead++
      const row = asRecord(parseJsonLine(trimmed))
      if (!row) continue
      jsonRows++
      Object.keys(row).forEach(key => fields.add(key))
      const symbolMatches = !targetSymbol || readString(row.symbol) === targetSymbol
      const lineageScope = readString(row.lineageScope)
      const hasObservedOrFetchedAt = readString(row.observedAt) != null ||
        readString(row.fetchedAt) != null ||
        readString(row.fetchTimestamp) != null ||
        readString(row.payloadReceivedAt) != null ||
        readString(row.downloadedAt) != null
      const hasAvailableAt = readString(row.availableAt) != null
      const hasCollectorJob = readString(row.jobId) != null ||
        readString(row.captureJobId) != null ||
        readString(row.collectionRunId) != null ||
        readString(row.sourceManifestId) != null
      const hasGeneratedAt = readString(row.generatedAt) != null
      const hasSourceEndpoint = readString(row.sourceEndpoint) != null
      const hasSourceRowHash = readString(row.sourceRowHash) != null
      const hasRowLevelLineage = lineageScope === 'row' ||
        lineageScope === 'row_pit' ||
        lineageScope === 'normalized_row' ||
        lineageScope === 'ohlcv_row'
      const rowPITUsableForPromotion = row.rowPITUsableForPromotion === true
      if (lineageScope) lineageScopes.add(lineageScope)
      if (targetSymbol && readString(row.symbol) === targetSymbol) targetSymbolRows++
      if (symbolMatches && (hasObservedOrFetchedAt || hasAvailableAt || hasGeneratedAt)) {
        targetSymbolRowsWithCollectorTimes++
      }
      if (symbolMatches && lineageScope === 'archive_file') archiveFileLineageRows++
      if (symbolMatches && hasRowLevelLineage) rowLineageRows++
      if (symbolMatches && rowPITUsableForPromotion) rowPITUsableForPromotionRows++
      if (
        symbolMatches &&
        hasObservedOrFetchedAt &&
        hasAvailableAt &&
        hasCollectorJob &&
        hasGeneratedAt &&
        hasSourceEndpoint &&
        hasSourceRowHash &&
        hasRowLevelLineage &&
        rowPITUsableForPromotion
      ) {
        promotionGradeRows++
      }
    }
    const fieldsPresent = [...fields].sort()
    const hasObservedOrFetchedAtField = fieldsPresent.some(field =>
      ['observedAt', 'fetchedAt', 'fetchTimestamp', 'payloadReceivedAt', 'downloadedAt'].includes(field))
    const hasAvailableAtField = fieldsPresent.includes('availableAt')
    const hasCollectorJobField = fieldsPresent.some(field =>
      ['jobId', 'captureJobId', 'collectionRunId', 'sourceManifestId'].includes(field))
    const hasGeneratedAtField = fieldsPresent.includes('generatedAt')
    const lineageScopesPresent = [...lineageScopes].sort()
    const hasCollectorTimes = targetSymbolRowsWithCollectorTimes > 0
    return {
      path,
      present: true,
      linesRead,
      jsonRows,
      targetSymbolRows,
      targetSymbolRowsWithCollectorTimes,
      archiveFileLineageRows,
      rowLineageRows,
      rowPITUsableForPromotionRows,
      promotionGradeRows,
      fieldsPresent,
      lineageScopes: lineageScopesPresent,
      hasObservedOrFetchedAtField,
      hasAvailableAtField,
      hasCollectorJobField,
      hasGeneratedAtField,
      hasArchiveFileLineage: archiveFileLineageRows > 0,
      hasRowLevelLineage: rowLineageRows > 0,
      hasPromotionGradeTimeFields: promotionGradeRows > 0,
      hasCollectorTimes,
      error: null,
    }
  } catch (error) {
    return {
      ...emptyManifestInspection(path),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function inspectSummary(path: string): Promise<SummaryInspection> {
  try {
    const row = asRecord(JSON.parse(await readFile(path, 'utf-8')))
    const fieldsPresent = row ? Object.keys(row).sort() : []
    return {
      path,
      present: true,
      fieldsPresent,
      hasBatchWindow: typeof row?.startedAt === 'string' && typeof row?.endedAt === 'string',
      startedAt: readString(row?.startedAt),
      endedAt: readString(row?.endedAt),
      coverage: readString(row?.coverage),
      files: readNumber(row?.files),
      error: null,
    }
  } catch (error) {
    return {
      ...emptySummaryInspection(path),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function inspectDerivativesPitSource(path: string, maxRows: number): Promise<DerivativesPitSourceInspection> {
  try {
    const text = await readFile(path, 'utf-8')
    let rowsRead = 0
    let rowsWithEventTime = 0
    let rowsWithObservedOrFetchedAt = 0
    let rowsWithAvailableAt = 0
    let rowsWithSourceEndpoint = 0
    let rowsWithJobId = 0
    let rowsWithGeneratedAt = 0
    let rowsWithLineage = 0
    let pitSafeRows = 0
    const symbols: string[] = []
    const endpointIds: string[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      if (maxRows > 0 && rowsRead >= maxRows) break
      rowsRead++
      const row = asRecord(parseJsonLine(trimmed))
      if (!row) continue
      const hasEventTime = readString(row.eventTime) != null
      const hasObservedOrFetchedAt = readString(row.observedAt) != null || readString(row.fetchedAt) != null
      const hasAvailableAt = readString(row.availableAt) != null
      const hasSourceEndpoint = readString(row.sourceEndpoint) != null
      const hasJobId = readString(row.jobId) != null || readString(row.collectionRunId) != null
      const hasGeneratedAt = readString(row.generatedAt) != null
      const hasLineage = readString(row.lineageStatus) != null || readString(row.reportPath) != null || readString(row.manifestPath) != null
      if (hasEventTime) rowsWithEventTime++
      if (hasObservedOrFetchedAt) rowsWithObservedOrFetchedAt++
      if (hasAvailableAt) rowsWithAvailableAt++
      if (hasSourceEndpoint) rowsWithSourceEndpoint++
      if (hasJobId) rowsWithJobId++
      if (hasGeneratedAt) rowsWithGeneratedAt++
      if (hasLineage) rowsWithLineage++
      if (hasEventTime && hasObservedOrFetchedAt && hasAvailableAt && hasSourceEndpoint && hasJobId && hasGeneratedAt && hasLineage) {
        pitSafeRows++
      }
      const symbol = readString(row.symbol)
      const endpointId = readString(row.endpointId)
      if (symbol) symbols.push(symbol)
      if (endpointId) endpointIds.push(endpointId)
    }
    return {
      path,
      present: true,
      rowsRead,
      rowsWithEventTime,
      rowsWithObservedOrFetchedAt,
      rowsWithAvailableAt,
      rowsWithSourceEndpoint,
      rowsWithJobId,
      rowsWithGeneratedAt,
      rowsWithLineage,
      pitSafeRows,
      pitSafe: rowsRead > 0 && pitSafeRows === rowsRead,
      symbols: uniqueStrings(symbols),
      endpointIds: uniqueStrings(endpointIds),
      error: null,
    }
  } catch (error) {
    return {
      path,
      present: false,
      rowsRead: 0,
      rowsWithEventTime: 0,
      rowsWithObservedOrFetchedAt: 0,
      rowsWithAvailableAt: 0,
      rowsWithSourceEndpoint: 0,
      rowsWithJobId: 0,
      rowsWithGeneratedAt: 0,
      rowsWithLineage: 0,
      pitSafeRows: 0,
      pitSafe: false,
      symbols: [],
      endpointIds: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function emptyManifestInspection(path: string | null): ManifestInspection {
  return {
    path: path ?? '',
    present: false,
    linesRead: 0,
    jsonRows: 0,
    targetSymbolRows: 0,
    targetSymbolRowsWithCollectorTimes: 0,
    archiveFileLineageRows: 0,
    rowLineageRows: 0,
    rowPITUsableForPromotionRows: 0,
    promotionGradeRows: 0,
    fieldsPresent: [],
    lineageScopes: [],
    hasObservedOrFetchedAtField: false,
    hasAvailableAtField: false,
    hasCollectorJobField: false,
    hasGeneratedAtField: false,
    hasArchiveFileLineage: false,
    hasRowLevelLineage: false,
    hasPromotionGradeTimeFields: false,
    hasCollectorTimes: false,
    error: null,
  }
}

function emptySummaryInspection(path: string | null): SummaryInspection {
  return {
    path: path ?? '',
    present: false,
    fieldsPresent: [],
    hasBatchWindow: false,
    startedAt: null,
    endedAt: null,
    coverage: null,
    files: null,
    error: null,
  }
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

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
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

function parseJsonLine(line: string): unknown | null {
  try {
    return JSON.parse(line)
  } catch {
    return null
  }
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
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))].sort()
}

function renderConsoleSummary(report: AiScientistPitNativeRebuildStatusReport): string {
  return [
    `AI-Scientist OpenAlice PIT native rebuild status: ${report.status}`,
    `tasks=${report.counts.autoRebuildEligibleTasks}/${report.counts.assessedTasks} autoEligible collectorUpgrade=${report.counts.requiredCollectorUpgradeTasks} derivativesUsable=${report.counts.derivativesPitUsableTasks}`,
    `derivativesPitRows=${report.derivativesPitSource.pitSafeRows}/${report.derivativesPitSource.rowsRead} pitSafe`,
    'paper=false live=false promotion=false execution=false',
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
