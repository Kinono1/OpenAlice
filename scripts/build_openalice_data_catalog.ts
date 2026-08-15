import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type CatalogStatus =
  | 'complete'
  | 'partial'
  | 'missing'
  | 'in_progress'
  | 'needs_retry'
  | 'failed'

type CatalogFamily =
  | 'market'
  | 'derivatives'
  | 'onchain'
  | 'asset_metadata'
  | 'quality_audit'
  | 'resume'
  | 'normalized'
  | 'feature_backtest_input'
  | 'research_candidates'

type CatalogLayer = 'raw' | 'normalized/parquet' | 'audit' | 'runtime' | 'derived'

type TimeGranularity = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'event'

type BinanceMarket = 'spot' | 'um'
type BlockerActionCategory =
  | 'download_gap'
  | 'pit_or_normalized_gap'
  | 'derivatives_audit_gap'
  | 'asset_metadata_gap'
  | 'manifest_or_trust_gap'
  | 'ai_scientist_validation_gate'
  | 'research_only_safety_gate'
  | 'resume_contract_gap'
  | 'other'

interface CliArgs {
  warehouseRoot: string
  repoDataRoot: string
  aiScientistRoot: string
  outputPath: string | null
  json: boolean
  allowBlockedExitZero: boolean
  monitorOfflineBackfills: boolean
}

interface BinanceDatasetSpec {
  datasetId: string
  market: BinanceMarket
  dataType: string
  timeframe?: string
  startMonth: string
  directory: string
}

interface DownloadSummary {
  coverage?: string
  files?: number
  targetSymbols?: number
  totals?: {
    downloaded?: number
    exists?: number
    missing?: number
    failed?: number
  }
}

interface FileStats {
  files: number
  bytes: number
}

export interface OpenAliceCatalogDataset {
  datasetId: string
  source: string
  family: CatalogFamily
  layer: CatalogLayer
  storagePath: string
  present: boolean
  status: CatalogStatus
  reason: string
  format: string
  cadence: {
    granularity: TimeGranularity
    timeframe: string | null
  }
  timeSpan: {
    start: string | null
    end: string | null
    policy: string
  }
  provenance: {
    sourceUrl: string | null
    license: string
    downloadScript: string | null
    auditScript: string | null
    resumeScript: string | null
    summaryPath: string | null
    retrySummaryPath: string | null
    manifestPath: string | null
  }
  quality: {
    summaryPresent: boolean
    retrySummaryPresent: boolean
    auditPresent: boolean
    manifestPresent: boolean
    files: number
    bytes: number
    zipFiles: number
    partFiles: number
    expectedFiles: number | null
    failedFiles: number | null
    missingFiles: number | null
    targetSymbols: number | null
    complete: boolean
  }
  blockers: string[]
  nextActions: string[]
  lifecycle?: 'active' | 'offline_manual' | 'retired'
  runtimeBlocking?: boolean
}

export interface OpenAliceDataCatalogReport {
  schemaVersion: 1
  generatedAt: string
  warehouseRoot: string
  repoDataRoot: string
  aiScientistRoot: string
  monitorOfflineBackfills: boolean
  status: 'complete' | 'blocked'
  objectiveCoverage: {
    timeGranularitiesRequired: TimeGranularity[]
    timeGranularitiesObserved: TimeGranularity[]
    requiredFamilies: CatalogFamily[]
    observedFamilies: CatalogFamily[]
    requiredLayers: CatalogLayer[]
    observedLayers: CatalogLayer[]
    binanceSpotStartPolicy: '2017-08_to_latest_available'
    binanceUsdmStartPolicy: '2019-09_to_latest_available'
  }
  summary: {
    datasets: number
    complete: number
    partial: number
    missing: number
    inProgress: number
    needsRetry: number
    failed: number
    rawDatasets: number
    normalizedDatasets: number
    auditDatasets: number
    runtimeDatasets: number
    verifiedBinancePublicDatasets: number
    plannedBinancePublicDatasets: number
  }
  blockerActionability: {
    totalBlockers: number
    primaryCategory: BlockerActionCategory | null
    categories: Array<{
      category: BlockerActionCategory
      count: number
      sampleBlockers: string[]
      nextAction: string
    }>
  }
  datasets: OpenAliceCatalogDataset[]
  blockers: string[]
  nextActions: string[]
  notes: string[]
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/openalice_data_catalog.latest.json'
const DEFAULT_AI_SCIENTIST_ROOT =
  '/Users/kino/Files/work_projects/code/expCode/effeciency/AI-Scientist/templates/crypto_dl'
const KLINE_INTERVALS = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
  '3d',
  '1w',
  '1mo',
] as const
const DERIVATIVE_KLINE_TYPES = ['markPriceKlines', 'indexPriceKlines', 'premiumIndexKlines'] as const
const REQUIRED_FAMILIES: CatalogFamily[] = [
  'market',
  'derivatives',
  'onchain',
  'asset_metadata',
  'quality_audit',
  'resume',
  'normalized',
  'feature_backtest_input',
  'research_candidates',
]
const REQUIRED_LAYERS: CatalogLayer[] = ['raw', 'normalized/parquet', 'audit', 'runtime', 'derived']
const REQUIRED_GRANULARITIES: TimeGranularity[] = ['second', 'minute', 'hour', 'day']

export function parseOpenAliceDataCatalogArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    warehouseRoot: resolve(
      raw.get('warehouseRoot') ??
      raw.get('dataRoot') ??
      process.env.OPENALICE_DATA_ROOT ??
      'data',
    ),
    repoDataRoot: resolve(raw.get('repoDataRoot') ?? raw.get('repoData') ?? 'data'),
    aiScientistRoot: resolve(raw.get('aiScientistRoot') ?? raw.get('aiRoot') ?? DEFAULT_AI_SCIENTIST_ROOT),
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
    allowBlockedExitZero: parseBool(raw.get('allowBlockedExitZero'), false),
    monitorOfflineBackfills: parseBool(raw.get('monitorOfflineBackfills'), false),
  }
}

export async function runOpenAliceDataCatalog(args: CliArgs): Promise<OpenAliceDataCatalogReport> {
  const startedAt = new Date()
  const report = await buildOpenAliceDataCatalogReport({
    warehouseRoot: args.warehouseRoot,
    repoDataRoot: args.repoDataRoot,
    aiScientistRoot: args.aiScientistRoot,
    monitorOfflineBackfills: args.monitorOfflineBackfills,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'openalice_data_catalog',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'complete' ? 'pass' : 'warn',
      recordsIn: report.datasets.length,
      recordsOut: report.datasets.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export async function buildOpenAliceDataCatalogReport(input: {
  warehouseRoot: string
  repoDataRoot: string
  aiScientistRoot?: string
  monitorOfflineBackfills?: boolean
  generatedAt?: string
}): Promise<OpenAliceDataCatalogReport> {
  const warehouseRoot = resolve(input.warehouseRoot)
  const repoDataRoot = resolve(input.repoDataRoot)
  const aiScientistRoot = resolve(input.aiScientistRoot ?? DEFAULT_AI_SCIENTIST_ROOT)
  const monitorOfflineBackfills = input.monitorOfflineBackfills === true
  const datasets = [
    ...await buildBinancePublicDatasets(warehouseRoot),
    ...await buildRepoLocalMarketDatasets(repoDataRoot),
    ...await buildExternalDerivativesDatasets(repoDataRoot, warehouseRoot),
    await buildAiScientistCryptoCandidateDataset(aiScientistRoot, repoDataRoot),
    ...await buildWarehouseRequirementDatasets(warehouseRoot, repoDataRoot),
  ].sort((left, right) => left.datasetId.localeCompare(right.datasetId))

  const blockers = buildGlobalBlockers(datasets, monitorOfflineBackfills)
  const summary = summarizeDatasets(datasets)
  const blockerActionability = summarizeBlockerActionability(blockers)
  const status = blockers.length === 0 ? 'complete' : 'blocked'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    warehouseRoot,
    repoDataRoot,
    aiScientistRoot,
    monitorOfflineBackfills,
    status,
    objectiveCoverage: {
      timeGranularitiesRequired: REQUIRED_GRANULARITIES,
      timeGranularitiesObserved: observedValues(
        datasets.filter(dataset => dataset.present).map(dataset => dataset.cadence.granularity),
        REQUIRED_GRANULARITIES,
      ),
      requiredFamilies: REQUIRED_FAMILIES,
      observedFamilies: observedValues(datasets.filter(dataset => dataset.present).map(dataset => dataset.family), REQUIRED_FAMILIES),
      requiredLayers: REQUIRED_LAYERS,
      observedLayers: observedValues(datasets.filter(dataset => dataset.present).map(dataset => dataset.layer), REQUIRED_LAYERS),
      binanceSpotStartPolicy: '2017-08_to_latest_available',
      binanceUsdmStartPolicy: '2019-09_to_latest_available',
    },
    summary,
    blockerActionability,
    datasets,
    blockers,
    nextActions: buildNextActions(blockers),
    notes: [
      'This catalog is an inventory and quality gate input. It does not authorize paper trading, live trading, or profitability claims.',
      'Status is blocked until every required data family, layer, and validator has a concrete local artifact and complete audit evidence.',
      monitorOfflineBackfills
        ? 'Offline Binance Data Vision inventory is in strict audit mode, so incomplete historical backfills are included in global blockers.'
        : 'Offline Binance Data Vision inventory remains visible but is non-blocking for runtime health; use --monitorOfflineBackfills true for a strict historical-backfill audit.',
      'AI-Scientist crypto_dl outputs are cataloged as research candidates only; they are not trading authority and still require OpenAlice second validation.',
    ],
  }
}

function plannedBinanceDatasets(): BinanceDatasetSpec[] {
  const specs: BinanceDatasetSpec[] = []
  for (const timeframe of KLINE_INTERVALS) {
    specs.push({
      datasetId: `binance-public:spot:klines:${timeframe}:usdt`,
      market: 'spot',
      dataType: 'klines',
      timeframe,
      startMonth: '2017-08',
      directory: `spot-all-usdt-klines-${timeframe}`,
    })
    specs.push({
      datasetId: `binance-public:um:klines:${timeframe}:usdt`,
      market: 'um',
      dataType: 'klines',
      timeframe,
      startMonth: '2019-09',
      directory: `um-all-usdt-klines-${timeframe}`,
    })
  }

  for (const dataType of ['aggTrades', 'trades'] as const) {
    specs.push({
      datasetId: `binance-public:spot:${dataType}:usdt`,
      market: 'spot',
      dataType,
      startMonth: '2017-08',
      directory: `spot-all-usdt-${dataType}`,
    })
    specs.push({
      datasetId: `binance-public:um:${dataType}:usdt`,
      market: 'um',
      dataType,
      startMonth: '2019-09',
      directory: `um-all-usdt-${dataType}`,
    })
  }

  for (const dataType of ['fundingRate', 'bookTicker'] as const) {
    specs.push({
      datasetId: `binance-public:um:${dataType}:usdt`,
      market: 'um',
      dataType,
      startMonth: '2019-09',
      directory: `um-all-usdt-${dataType}`,
    })
  }

  for (const dataType of DERIVATIVE_KLINE_TYPES) {
    for (const timeframe of KLINE_INTERVALS) {
      specs.push({
        datasetId: `binance-public:um:${dataType}:${timeframe}:usdt`,
        market: 'um',
        dataType,
        timeframe,
        startMonth: '2019-09',
        directory: `um-all-usdt-${dataType}-${timeframe}`,
      })
    }
  }

  return specs
}

async function buildBinancePublicDatasets(warehouseRoot: string): Promise<OpenAliceCatalogDataset[]> {
  const root = resolve(warehouseRoot, 'market/binance-public')
  return Promise.all(plannedBinanceDatasets().map(async spec => {
    const storagePath = resolve(root, spec.directory)
    const summaryPath = resolve(storagePath, 'summary.fast-binance-download.json')
    const retrySummaryPath = resolve(storagePath, 'summary.fast-binance-download.retry.json')
    const manifestPath = resolve(storagePath, 'manifest.fast-binance-download.jsonl')
    const [stats, zipFiles, partFiles, summaryResult, retrySummaryResult] = await Promise.all([
      statTree(storagePath),
      countFilesWithSuffix(storagePath, '.zip'),
      countFilesWithSuffix(storagePath, '.part'),
      readJsonIfExists<DownloadSummary>(summaryPath),
      readJsonIfExists<DownloadSummary>(retrySummaryPath),
    ])
    const present = await pathExists(storagePath)
    const classification = classifyBinanceDataset({
      present,
      zipFiles,
      partFiles,
      summaryResult,
    })
    const summary = summaryResult.value
    const blockers = classification.complete ? [] : [`binance_dataset_${classification.status}:${spec.directory}`]

    return {
      datasetId: spec.datasetId,
      source: 'binance_data_vision',
      family: binanceFamily(spec),
      layer: 'raw',
      storagePath,
      present,
      status: classification.status,
      reason: classification.reason,
      format: 'zip/csv',
      cadence: {
        granularity: granularityForTimeframe(spec.timeframe, spec.dataType),
        timeframe: spec.timeframe ?? null,
      },
      timeSpan: {
        start: spec.startMonth,
        end: null,
        policy: `${spec.market === 'spot' ? 'Binance spot' : 'Binance USD-M futures'} earliest planned month to latest available Data Vision file`,
      },
      provenance: {
        sourceUrl: binanceSourceUrl(spec),
        license: 'Binance public data terms',
        downloadScript: 'scripts/fast_binance_data_vision_backfill.ts',
        auditScript: 'scripts/audit_fast_binance_data_vision_downloads.ts',
        resumeScript: 'scripts/run_fast_binance_data_vision_dataset.ts',
        summaryPath,
        retrySummaryPath: existsSync(retrySummaryPath) ? retrySummaryPath : null,
        manifestPath: existsSync(manifestPath) ? manifestPath : null,
      },
      quality: {
        summaryPresent: summaryResult.exists,
        retrySummaryPresent: retrySummaryResult.exists,
        auditPresent: true,
        manifestPresent: existsSync(manifestPath),
        files: stats.files,
        bytes: stats.bytes,
        zipFiles,
        partFiles,
        expectedFiles: summary?.files ?? null,
        failedFiles: summary?.totals?.failed ?? null,
        missingFiles: summary?.totals?.missing ?? null,
        targetSymbols: summary?.targetSymbols ?? null,
        complete: classification.complete,
      },
      blockers,
      nextActions: binanceNextActions(classification.status, spec.directory),
      lifecycle: 'offline_manual',
      runtimeBlocking: false,
    }
  }))
}

async function buildRepoLocalMarketDatasets(repoDataRoot: string): Promise<OpenAliceCatalogDataset[]> {
  const collectorPitStatusPath = resolve(repoDataRoot, 'research/openalice_ohlcv_collector_pit_contract_status.latest.json')
  const collectorPitStatus = await readJsonIfExists<Record<string, unknown>>(collectorPitStatusPath)
  const collectorPitManifestPath = `${collectorPitStatusPath}.manifest.json`
  const collectorTimeframes = new Set(
    Array.isArray(collectorPitStatus.value?.timeframeFreshness)
      ? collectorPitStatus.value.timeframeFreshness
        .map(item => asRecord(item))
        .filter((item): item is Record<string, unknown> => item != null)
        .filter(item => item.stale === false && (readNumber(item.rows) ?? 0) > 0)
        .map(item => readString(item.timeframe))
        .filter((value): value is string => value != null)
      : [],
  )
  const specs = [
    { id: 'repo-live-market:live_1s', directory: 'market/live_1s', timeframe: '1s', layer: 'raw' as CatalogLayer },
    { id: 'repo-live-market:live_5m', directory: 'market/live_5m', timeframe: '5m', layer: 'raw' as CatalogLayer },
    { id: 'repo-live-market:live_accumulated_1h', directory: 'market/live_accumulated', timeframe: '1h', layer: 'raw' as CatalogLayer },
    { id: 'repo-live-market:multi_assets_1h', directory: 'market/multi_assets', timeframe: '1h', layer: 'raw' as CatalogLayer },
    { id: 'repo-live-market:gate_1h', directory: 'market/gate', timeframe: '1h', layer: 'raw' as CatalogLayer },
  ]
  return Promise.all(specs.map(async spec => {
    const storagePath = resolve(repoDataRoot, spec.directory)
    const stats = await statTree(storagePath)
    const present = stats.files > 0
    const csvFiles = await countFilesWithSuffix(storagePath, '.csv')
    const collectorPitReady = present &&
      (spec.timeframe === '5m' || spec.timeframe === '1h') &&
      readString(collectorPitStatus.value?.status) === 'ready_for_pit_audit_research_only' &&
      collectorTimeframes.has(spec.timeframe) &&
      existsSync(collectorPitManifestPath)
    const status: CatalogStatus = collectorPitReady ? 'complete' : present ? 'partial' : 'missing'
    return {
      datasetId: spec.id,
      source: 'openalice_repo_local',
      family: 'market',
      layer: spec.layer,
      storagePath,
      present,
      status,
      reason: collectorPitReady
        ? 'local OKX market CSV is covered by row-explicit collector PIT sidecar rows for research backtest inputs'
        : present
        ? 'local CSV market data exists; freshness audit determines runtime usability'
        : 'local market data directory is missing or empty',
      format: 'csv',
      cadence: {
        granularity: granularityForTimeframe(spec.timeframe, 'klines'),
        timeframe: spec.timeframe,
      },
      timeSpan: {
        start: null,
        end: null,
        policy: 'derive from CSV timestamp columns during normalization/audit',
      },
      provenance: {
        sourceUrl: null,
        license: 'local runtime data',
        downloadScript: 'scripts/download_multi_assets.ts',
        auditScript: collectorPitReady
          ? 'scripts/build_openalice_ohlcv_collector_pit_contract_status.ts'
          : 'scripts/audit_live_data_freshness.ts',
        resumeScript: 'scripts/accumulate_live_data.ts',
        summaryPath: collectorPitReady
          ? collectorPitStatusPath
          : resolve(repoDataRoot, 'runtime/live_data_freshness.latest.json'),
        retrySummaryPath: null,
        manifestPath: collectorPitReady && existsSync(collectorPitManifestPath)
          ? collectorPitManifestPath
          : existsSync(resolve(repoDataRoot, 'runtime/live_data_freshness.latest.json.manifest.json'))
          ? resolve(repoDataRoot, 'runtime/live_data_freshness.latest.json.manifest.json')
          : null,
      },
      quality: {
        summaryPresent: collectorPitReady ? collectorPitStatus.exists : existsSync(resolve(repoDataRoot, 'runtime/live_data_freshness.latest.json')),
        retrySummaryPresent: false,
        auditPresent: true,
        manifestPresent: collectorPitReady
          ? existsSync(collectorPitManifestPath)
          : existsSync(resolve(repoDataRoot, 'runtime/live_data_freshness.latest.json.manifest.json')),
        files: stats.files,
        bytes: stats.bytes,
        zipFiles: 0,
        partFiles: 0,
        expectedFiles: null,
        failedFiles: null,
        missingFiles: null,
        targetSymbols: csvFiles,
        complete: collectorPitReady,
      },
      blockers: collectorPitReady
        ? ['local_market_pit_rows_research_only_not_promotion_evidence']
        : present
          ? ['local_market_requires_normalized_point_in_time_snapshot']
          : [`local_market_missing:${spec.id}`],
      nextActions: collectorPitReady
        ? ['Use only for research decisions strictly after availableAt; promotion still requires strategy-specific PIT, WFO, FDR, route-cost, slippage, risk, prospective, and paper telemetry gates.']
        : ['Run live freshness audit, normalize CSVs to point-in-time parquet, then register feature snapshot inputs.'],
    }
  }))
}

async function buildExternalDerivativesDatasets(repoDataRoot: string, warehouseRoot: string): Promise<OpenAliceCatalogDataset[]> {
  const outputPath = resolve(repoDataRoot, 'external/derivatives/okx_swap_derivatives_events.jsonl')
  const reportPath = resolve(repoDataRoot, 'runtime/external_derivatives_data_collect.latest.json')
  const normalizedPath = resolve(repoDataRoot, 'normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
  const normalizedReportPath = resolve(repoDataRoot, 'runtime/external_derivatives_data_normalize.latest.json')
  const auditPath = resolve(repoDataRoot, 'runtime/external_derivatives_data_audit.latest.json')
  const stats = await statTree(outputPath)
  const normalizedStats = await statTree(normalizedPath)
  const present = stats.files > 0
  const rawReport = await readJsonIfExists<Record<string, unknown>>(reportPath)
  const normalizedReport = await readJsonIfExists<Record<string, unknown>>(normalizedReportPath)
  const auditReport = await readJsonIfExists<Record<string, unknown>>(auditPath)
  const rawComplete = rawReport.value?.dryRun === false && (readNumber(rawReport.value?.appendedRows) ?? 0) > 0
  const normalizedComplete = readString(normalizedReport.value?.status) === 'complete'
  const auditComplete = readString(auditReport.value?.status) === 'complete'
  return [{
    datasetId: 'external-derivatives:okx-swap-events',
    source: 'okx_public_rest',
    family: 'derivatives',
    layer: 'raw',
    storagePath: outputPath,
    present,
    status: rawComplete ? 'complete' : present ? 'partial' : 'missing',
    reason: rawComplete
      ? 'append-only external derivatives JSONL collected with runtime report'
      : present
        ? 'append-only derivatives JSONL exists but normalized/audit flow is still incomplete'
        : 'external derivatives JSONL has not been collected',
    format: 'jsonl',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'derive from sourceTimestamp per endpoint and symbol',
    },
    provenance: {
      sourceUrl: 'https://www.okx.com/api/v5',
      license: 'OKX API terms',
      downloadScript: 'scripts/collect_okx_external_derivatives_data.ts',
      auditScript: 'scripts/collect_okx_external_derivatives_data.ts',
      resumeScript: 'scripts/collect_okx_external_derivatives_data.ts',
      summaryPath: rawReport.exists ? reportPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(`${reportPath}.manifest.json`) ? `${reportPath}.manifest.json` : null,
    },
    quality: {
      summaryPresent: rawReport.exists,
      retrySummaryPresent: false,
      auditPresent: rawReport.exists,
      manifestPresent: existsSync(`${reportPath}.manifest.json`),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete: rawComplete,
    },
    blockers: rawComplete ? [] : present ? ['external_derivatives_requires_normalized_schema_and_coverage_audit'] : ['external_derivatives_missing'],
    nextActions: ['Promote derivatives JSONL into normalized parquet partitions with endpoint coverage audit.'],
  }, {
    datasetId: 'external-derivatives:okx-swap-events:normalized',
    source: 'okx_public_rest',
    family: 'derivatives',
    layer: 'normalized/parquet',
    storagePath: normalizedPath,
    present: normalizedStats.files > 0,
    status: normalizedComplete ? 'complete' : normalizedStats.files > 0 ? 'partial' : 'missing',
    reason: normalizedComplete
      ? 'external derivatives normalized rows are available'
      : normalizedStats.files > 0
        ? 'normalized derivatives rows exist but normalization report is not complete'
        : 'normalized derivatives rows are missing',
    format: 'jsonl/parquet',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: readString(normalizedReport.value?.observedStartTime),
      end: readString(normalizedReport.value?.observedEndTime),
      policy: 'normalized derivatives preserve sourceTimestamp and PIT metadata per event',
    },
    provenance: {
      sourceUrl: 'https://www.okx.com/api/v5',
      license: 'OKX API terms',
      downloadScript: null,
      auditScript: 'scripts/normalize_external_derivatives_data.ts',
      resumeScript: 'scripts/normalize_external_derivatives_data.ts',
      summaryPath: normalizedReport.exists ? normalizedReportPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(`${normalizedReportPath}.manifest.json`) ? `${normalizedReportPath}.manifest.json` : null,
    },
    quality: {
      summaryPresent: normalizedReport.exists,
      retrySummaryPresent: false,
      auditPresent: normalizedReport.exists,
      manifestPresent: existsSync(`${normalizedReportPath}.manifest.json`),
      files: normalizedStats.files,
      bytes: normalizedStats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete: normalizedComplete,
    },
    blockers: normalizedComplete ? [] : ['external_derivatives_normalized_missing'],
    nextActions: ['Keep normalized derivatives rows refreshed from the append-only collector output.'],
  }, {
    datasetId: 'external-derivatives:okx-swap-events:audit',
    source: 'okx_public_rest',
    family: 'derivatives',
    layer: 'audit',
    storagePath: auditPath,
    present: auditReport.exists,
    status: auditComplete ? 'complete' : auditReport.exists ? 'partial' : 'missing',
    reason: auditComplete
      ? 'external derivatives coverage audit passed'
      : auditReport.exists
        ? 'external derivatives coverage audit exists but still has blockers'
        : 'external derivatives coverage audit is missing',
    format: 'json',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'audit summarizes normalized derivatives rows and metadata coverage',
    },
    provenance: {
      sourceUrl: 'https://www.okx.com/api/v5',
      license: 'OKX API terms',
      downloadScript: null,
      auditScript: 'scripts/audit_external_derivatives_data.ts',
      resumeScript: 'scripts/audit_external_derivatives_data.ts',
      summaryPath: auditReport.exists ? auditPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(`${auditPath}.manifest.json`) ? `${auditPath}.manifest.json` : null,
    },
    quality: {
      summaryPresent: auditReport.exists,
      retrySummaryPresent: false,
      auditPresent: auditReport.exists,
      manifestPresent: existsSync(`${auditPath}.manifest.json`),
      files: auditReport.exists ? 1 : 0,
      bytes: auditReport.exists ? Buffer.byteLength(JSON.stringify(auditReport.value ?? {}), 'utf-8') : 0,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: auditReport.exists ? 1 : null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete: auditComplete,
    },
    blockers: auditComplete ? [] : auditReport.exists ? readStringArray(auditReport.value?.blockers) : ['external_derivatives_audit_missing'],
    nextActions: ['Fill missing metadata coverage on normalized derivatives rows until the audit passes.'],
  }]
}

async function buildAiScientistCryptoCandidateDataset(
  aiScientistRoot: string,
  repoDataRoot: string,
): Promise<OpenAliceCatalogDataset> {
  const intakePath = resolve(repoDataRoot, 'research/ai_scientist_crypto_candidate_intake.latest.json')
  const intakeManifestPath = `${intakePath}.manifest.json`
  const [stats, intake] = await Promise.all([
    statTree(aiScientistRoot),
    readJsonIfExists<{
      status?: string
      counts?: {
        candidatesFound?: number
        runsWithWalkForward?: number
        runsWithFundingFeatures?: number
        safetyViolations?: number
      }
      blockers?: string[]
    }>(intakePath),
  ])
  const present = stats.files > 0 || intake.exists
  const candidatesFound = intake.value?.counts?.candidatesFound ?? null
  const safetyViolations = intake.value?.counts?.safetyViolations ?? 0
  const blockers = uniqueStrings([
    ...(present ? [] : ['ai_scientist_crypto_dl_root_missing_or_empty']),
    ...(intake.exists ? [] : ['ai_scientist_crypto_candidate_intake_missing']),
    ...(candidatesFound != null && candidatesFound > 0 ? [] : ['ai_scientist_crypto_candidates_missing']),
    ...(safetyViolations > 0 ? [`ai_scientist_candidate_safety_violations:${safetyViolations}`] : []),
    ...readStringArray(intake.value?.blockers).slice(0, 16).map(blocker => `ai_scientist_intake:${blocker}`),
    'ai_scientist_candidates_require_openalice_second_validation',
    'ai_scientist_candidates_require_pit_wfo_fdr_route_cost_prospective_gates',
    'ai_scientist_candidates_are_not_trading_authority',
  ])
  return {
    datasetId: 'ai-scientist:crypto-dl:candidate-runs',
    source: 'ai_scientist_crypto_dl',
    family: 'research_candidates',
    layer: 'derived',
    storagePath: aiScientistRoot,
    present,
    status: present ? 'partial' : 'missing',
    reason: present
      ? 'AI-Scientist crypto_dl candidate runs are visible for research intake; OpenAlice second validation remains required'
      : 'AI-Scientist crypto_dl candidate root is missing or empty',
    format: 'json/python/research-artifacts',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'per AI-Scientist run timestamp and OpenAlice intake artifact generatedAt',
    },
    provenance: {
      sourceUrl: null,
      license: 'local research artifact',
      downloadScript: null,
      auditScript: 'scripts/build_ai_scientist_crypto_candidate_intake.ts',
      resumeScript: null,
      summaryPath: intake.exists ? intakePath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(intakeManifestPath) ? intakeManifestPath : null,
    },
    quality: {
      summaryPresent: intake.exists,
      retrySummaryPresent: false,
      auditPresent: intake.exists,
      manifestPresent: existsSync(intakeManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: null,
      failedFiles: safetyViolations > 0 ? safetyViolations : null,
      missingFiles: null,
      targetSymbols: candidatesFound,
      complete: false,
    },
    blockers,
    nextActions: [
      'Keep AI-Scientist outputs research-only and import only locked-source candidate summaries into OpenAlice.',
      'Run OpenAlice PIT, WFO, FDR, route-cost, slippage stress, risk simulation, trial ledger, prospective ledger, and paper telemetry before any promotion review.',
    ],
  }
}

async function buildWarehouseRequirementDatasets(
  warehouseRoot: string,
  repoDataRoot: string,
): Promise<OpenAliceCatalogDataset[]> {
  const normalizedRoot = resolve(warehouseRoot, 'normalized')
  const manifestsRoot = resolve(warehouseRoot, 'manifests')
  const onchainRoot = resolve(warehouseRoot, 'onchain/coinmetrics')
  const onchainNormalizedRoot = resolve(warehouseRoot, 'normalized/onchain/coinmetrics')
  const metadataRoot = resolve(warehouseRoot, 'metadata/assets')
  const featureRoot = resolve(warehouseRoot, 'derived/features')
  const featureMaterializeReportPath = resolve(repoDataRoot, 'runtime/eth_carry_feature_store_materialize.latest.json')
  const runtimeRoot = resolve(repoDataRoot, 'runtime')
  const coinMetricsCollectReportPath = resolve(repoDataRoot, 'runtime/openalice_coinmetrics_onchain_collect.latest.json')
  const coinMetricsNormalizeReportPath = resolve(repoDataRoot, 'runtime/openalice_coinmetrics_onchain_normalize.latest.json')
  const coinMetricsAuditReportPath = resolve(repoDataRoot, 'runtime/openalice_coinmetrics_onchain_audit.latest.json')
  return [
    await normalizedWarehouseIndexDataset(warehouseRoot, normalizedRoot),
    await warehouseManifestIndexDataset(manifestsRoot),
    await runtimeManifestCoverageDataset(runtimeRoot),
    await coinMetricsWarehouseDataset({
      datasetId: 'onchain:coinmetrics-community',
      layer: 'raw',
      storagePath: onchainRoot,
      reportPath: coinMetricsCollectReportPath,
      format: 'jsonl',
      blocker: 'coinmetrics_community_onchain_not_collected',
      nextAction: 'Add a Coin Metrics Community collector and audit coverage for BTC, ETH, stablecoin, network, fee, supply, and activity metrics.',
    }),
    await coinMetricsWarehouseDataset({
      datasetId: 'onchain:coinmetrics-community:normalized',
      layer: 'normalized/parquet',
      storagePath: onchainNormalizedRoot,
      reportPath: coinMetricsNormalizeReportPath,
      format: 'jsonl/parquet',
      blocker: 'coinmetrics_community_normalized_missing',
      nextAction: 'Normalize raw Coin Metrics rows into canonical point-in-time warehouse tables.',
    }),
    await coinMetricsAuditDataset({
      storagePath: coinMetricsAuditReportPath,
      blocker: 'coinmetrics_community_audit_missing',
      nextAction: 'Run Coin Metrics on-chain audit and persist machine-readable acceptance results.',
    }),
    await assetMetadataRegistryDataset({
      metadataRoot,
      repoDataRoot,
    }),
    await featureBacktestInputDataset({
      featureRoot,
      reportPath: featureMaterializeReportPath,
    }),
    await syntheticResumeContractDataset(warehouseRoot, repoDataRoot),
  ]
}

async function featureBacktestInputDataset(input: {
  featureRoot: string
  reportPath: string
}): Promise<OpenAliceCatalogDataset> {
  const stats = await statTree(input.featureRoot)
  const report = await readJsonIfExists<Record<string, unknown>>(input.reportPath)
  const reportManifestPath = `${input.reportPath}.manifest.json`
  const reportBlockers = readStringArray(report.value?.blockers)
  const outputPath = readString(report.value?.outputPath)
  const outputManifestPath = outputPath == null ? null : `${outputPath}.manifest.json`
  const rowsWritten = readNumber(report.value?.rowsWritten) ?? 0
  const complete = report.exists &&
    readString(report.value?.status) === 'complete' &&
    rowsWritten > 0 &&
    outputPath != null &&
    existsSync(outputPath) &&
    existsSync(outputManifestPath ?? '') &&
    existsSync(reportManifestPath)
  const present = stats.files > 0 || report.exists
  return {
    datasetId: 'features:point-in-time-backtest-input',
    source: 'openalice_feature_store',
    family: 'feature_backtest_input',
    layer: 'derived',
    storagePath: input.featureRoot,
    present,
    status: complete ? 'complete' : present ? 'partial' : 'missing',
    reason: complete
      ? 'research feature-store backtest input exists with materialization report and sidecar manifests'
      : present
        ? 'feature-store files or reports exist but materialization contract is incomplete'
        : 'required feature-store backtest input directory is missing or empty',
    format: 'jsonl/parquet',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: readString(report.value?.observedStartTime),
      end: readString(report.value?.observedEndTime),
      policy: 'feature rows must use normalized inputs and carry availableAt for point-in-time backtests',
    },
    provenance: {
      sourceUrl: null,
      license: 'local repository policy',
      downloadScript: null,
      auditScript: 'scripts/materialize_eth_carry_feature_store.ts',
      resumeScript: 'scripts/materialize_eth_carry_feature_store.ts',
      summaryPath: report.exists ? input.reportPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(reportManifestPath)
        ? reportManifestPath
        : outputManifestPath && existsSync(outputManifestPath)
          ? outputManifestPath
          : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(reportManifestPath) || Boolean(outputManifestPath && existsSync(outputManifestPath)),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: rowsWritten > 0 ? rowsWritten : null,
      failedFiles: reportBlockers.length,
      missingFiles: complete ? 0 : null,
      targetSymbols: 2,
      complete,
    },
    blockers: complete
      ? ['feature_backtest_input_research_only_not_promotion_evidence']
      : reportBlockers.length > 0
        ? reportBlockers
        : present
          ? ['point_in_time_feature_snapshot_incomplete']
          : ['point_in_time_feature_snapshot_missing'],
    nextActions: complete
      ? ['Run strategy-specific PIT audit, WFO, FDR, route-cost, slippage stress, risk simulation, prospective ledger, and paper telemetry gates before promotion review.']
      : ['Build feature/backtest snapshots from normalized data with point-in-time joins and no raw-file direct reads.'],
  }
}

async function normalizedWarehouseIndexDataset(
  warehouseRoot: string,
  normalizedRoot: string,
): Promise<OpenAliceCatalogDataset> {
  const indexPath = resolve(warehouseRoot, 'manifests/openalice_normalized_warehouse_index.latest.json')
  const indexManifestPath = `${indexPath}.manifest.json`
  const stats = await statTree(normalizedRoot)
  const report = await readJsonIfExists<Record<string, unknown>>(indexPath)
  const summary = report.value == null ? null : asRecord(report.value.summary)
  const reportBlockers = readStringArray(report.value?.blockers)
  const normalizedFiles = readNumber(summary?.normalizedFiles) ?? 0
  const filesWithSidecarManifest = readNumber(summary?.filesWithSidecarManifest) ?? 0
  const sampledFiles = readNumber(summary?.sampledFiles) ?? 0
  const pitContractCompleteFiles = readNumber(summary?.pitContractCompleteFiles) ?? 0
  const coverageComplete = report.exists &&
    readString(report.value?.coverageStatus) === 'complete' &&
    normalizedFiles > 0 &&
    existsSync(indexManifestPath)
  const present = stats.files > 0 || report.exists
  return {
    datasetId: 'warehouse-normalized:parquet-root',
    source: 'openalice_warehouse',
    family: 'normalized',
    layer: 'normalized/parquet',
    storagePath: normalizedRoot,
    present,
    status: coverageComplete ? 'complete' : present ? 'partial' : 'missing',
    reason: coverageComplete
      ? 'normalized warehouse index has complete file and sidecar coverage; PIT/trust blockers remain separate quality signals'
      : present
        ? 'normalized warehouse files exist but the normalized index contract is incomplete'
        : 'normalized warehouse root is missing or empty',
    format: 'jsonl/parquet',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: report.value == null ? null : readString(report.value.generatedAt),
      policy: 'normalized warehouse index samples row-level PIT fields and sidecar manifest coverage at index generation time',
    },
    provenance: {
      sourceUrl: null,
      license: 'local repository policy',
      downloadScript: null,
      auditScript: 'scripts/build_openalice_normalized_warehouse_index.ts',
      resumeScript: 'scripts/build_openalice_normalized_warehouse_index.ts',
      summaryPath: report.exists ? indexPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(indexManifestPath) ? indexManifestPath : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(indexManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: normalizedFiles > 0 ? normalizedFiles : null,
      failedFiles: reportBlockers.length,
      missingFiles: normalizedFiles > 0 ? Math.max(0, normalizedFiles - filesWithSidecarManifest) : null,
      targetSymbols: null,
      complete: coverageComplete,
    },
    blockers: coverageComplete
      ? reportBlockers.map(blocker => `normalized_warehouse_trust_or_pit_blocked:${blocker}`)
      : reportBlockers.length > 0
        ? reportBlockers
        : present
          ? ['normalized_warehouse_index_incomplete']
          : ['normalized_parquet_root_missing_or_empty'],
    nextActions: coverageComplete
      ? [
        sampledFiles === pitContractCompleteFiles
          ? 'Keep normalized warehouse index refreshed; resolve evidence trust blockers before promotion use.'
          : 'Keep coverage refreshed and normalize remaining row families to full PIT contract before promotion use.',
      ]
      : ['Run data:warehouse:normalized-index to summarize normalized file coverage, manifests, and PIT-safe row fields.'],
  }
}

async function runtimeManifestCoverageDataset(runtimeRoot: string): Promise<OpenAliceCatalogDataset> {
  const coveragePath = resolve(runtimeRoot, 'runtime_manifest_coverage.latest.json')
  const coverageManifestPath = `${coveragePath}.manifest.json`
  const stats = await statTree(runtimeRoot)
  const report = await readJsonIfExists<Record<string, unknown>>(coveragePath)
  const coverage = report.value == null ? null : asRecord(report.value.coverage)
  const trustBlockingReasons = readStringArray(report.value?.trustBlockingReasons)
  const blockingReasons = readStringArray(report.value?.blockingReasons)
  const reportStatus = readString(report.value?.status)
  const coverageStatus = readString(report.value?.coverageStatus)
  const evidenceUsabilityStatus = readString(report.value?.evidenceUsabilityStatus)
  const complete = report.exists &&
    reportStatus === 'complete' &&
    coverageStatus === 'complete' &&
    readNumber(coverage?.requiredArtifacts) === readNumber(coverage?.existingArtifacts) &&
    readNumber(coverage?.missingArtifacts) === 0 &&
    readNumber(coverage?.missingManifests) === 0 &&
    readNumber(coverage?.hashMismatchManifests) === 0 &&
    existsSync(coverageManifestPath)
  const present = stats.files > 0 || report.exists
  const trustBlocked = evidenceUsabilityStatus !== 'pass'
  return {
    datasetId: 'warehouse-runtime:openalice-runtime-artifacts',
    source: 'openalice_repo_local',
    family: 'quality_audit',
    layer: 'runtime',
    storagePath: runtimeRoot,
    present,
    status: complete ? 'complete' : present ? 'partial' : 'missing',
    reason: complete
      ? 'runtime artifact manifest coverage is complete; trust status remains a separate promotion blocker'
      : present
        ? 'runtime artifacts exist but manifest coverage is incomplete'
        : 'runtime root is missing or empty',
    format: 'json',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: report.value == null ? null : readString(report.value.generatedAt),
      policy: 'runtime manifest coverage audit verifies required runtime artifact sidecars and hashes',
    },
    provenance: {
      sourceUrl: null,
      license: 'local repository policy',
      downloadScript: null,
      auditScript: 'scripts/audit_runtime_manifest_coverage.ts',
      resumeScript: 'scripts/audit_runtime_manifest_coverage.ts',
      summaryPath: report.exists ? coveragePath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(coverageManifestPath) ? coverageManifestPath : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(coverageManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: readNumber(coverage?.requiredArtifacts),
      failedFiles: trustBlocked ? trustBlockingReasons.length : 0,
      missingFiles: readNumber(coverage?.missingArtifacts),
      targetSymbols: null,
      complete,
    },
    blockers: complete
      ? trustBlockingReasons.map(reason => `runtime_manifest_trust_blocked:${reason}`)
      : blockingReasons.length > 0
        ? blockingReasons
        : present
          ? ['runtime_manifest_coverage_incomplete']
          : ['runtime_root_missing_or_empty'],
    nextActions: complete
      ? ['Keep runtime manifest coverage refreshed; resolve trust blockers separately before using runtime artifacts as promotion evidence.']
      : ['Run scripts/audit_runtime_manifest_coverage.ts to verify runtime artifact sidecars and hashes.'],
  }
}

async function warehouseManifestIndexDataset(manifestsRoot: string): Promise<OpenAliceCatalogDataset> {
  const indexPath = resolve(manifestsRoot, 'openalice_warehouse_manifest_index.latest.json')
  const indexManifestPath = `${indexPath}.manifest.json`
  const stats = await statTree(manifestsRoot)
  const report = await readJsonIfExists<Record<string, unknown>>(indexPath)
  const summary = report.value == null ? null : asRecord(report.value.summary)
  const reportBlockers = readStringArray(report.value?.blockers)
  const manifestFiles = readNumber(summary?.manifestFiles) ?? 0
  const readableFiles = readNumber(summary?.readableFiles) ?? 0
  const complete = report.exists &&
    readString(report.value?.status) === 'complete' &&
    manifestFiles > 0 &&
    readableFiles === manifestFiles &&
    existsSync(indexManifestPath)
  const present = stats.files > 0 || report.exists
  return {
    datasetId: 'warehouse-audit:manifests-root',
    source: 'openalice_warehouse',
    family: 'quality_audit',
    layer: 'audit',
    storagePath: manifestsRoot,
    present,
    status: complete ? 'complete' : present ? 'partial' : 'missing',
    reason: complete
      ? 'warehouse manifest index is complete and has a sidecar evidence manifest'
      : present
        ? 'warehouse manifests exist but the manifest index contract is incomplete'
        : 'warehouse manifest root is missing or empty',
    format: 'json/jsonl',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: report.value == null ? null : readString(report.value.generatedAt),
      policy: 'manifest index summarizes all local warehouse manifests at index generation time',
    },
    provenance: {
      sourceUrl: null,
      license: 'local repository policy',
      downloadScript: null,
      auditScript: 'scripts/build_openalice_warehouse_manifest_index.ts',
      resumeScript: 'scripts/build_openalice_warehouse_manifest_index.ts',
      summaryPath: report.exists ? indexPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(indexManifestPath) ? indexManifestPath : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(indexManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: manifestFiles > 0 ? manifestFiles : null,
      failedFiles: readNumber(summary?.unreadableFiles) ?? readNumber(summary?.notJsonFiles),
      missingFiles: null,
      targetSymbols: null,
      complete,
    },
    blockers: complete
      ? []
      : reportBlockers.length > 0
        ? reportBlockers
        : present
          ? ['warehouse_manifest_index_incomplete']
          : ['warehouse_manifest_root_missing_or_empty'],
    nextActions: complete
      ? ['Keep the warehouse manifest index refreshed after data collectors, normalizers, or audits write new manifests.']
      : ['Run data:warehouse:manifest-index to summarize local warehouse manifests into a machine-readable contract.'],
  }
}

async function assetMetadataRegistryDataset(input: {
  metadataRoot: string
  repoDataRoot: string
}): Promise<OpenAliceCatalogDataset> {
  const registryPath = resolve(input.metadataRoot, 'openalice_asset_registry.latest.json')
  const reportPath = resolve(input.repoDataRoot, 'runtime/openalice_asset_metadata_registry.latest.json')
  const reportManifestPath = `${reportPath}.manifest.json`
  const stats = await statTree(input.metadataRoot)
  const report = await readJsonIfExists<{
    status?: string
    summary?: {
      assets?: number
      missingContractAddresses?: number
      missingDecimals?: number
    }
    blockers?: string[]
  }>(reportPath)
  const present = stats.files > 0 || report.exists
  const complete = report.value?.status === 'complete'
  const status: CatalogStatus = complete ? 'complete' : present ? 'partial' : 'missing'
  const blockers = complete
    ? []
    : report.value?.blockers?.length
      ? report.value.blockers
      : present
        ? ['asset_metadata_registry_incomplete']
        : ['asset_metadata_registry_missing']
  return {
    datasetId: 'metadata:asset-registry',
    source: 'openalice_asset_metadata',
    family: 'asset_metadata',
    layer: 'raw',
    storagePath: input.metadataRoot,
    present,
    status,
    reason: complete
      ? 'asset metadata registry is complete'
      : present
        ? 'asset metadata registry exists but required fields remain unresolved'
        : 'asset metadata registry is missing',
    format: 'json/parquet',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'source-specific earliest available history to latest available point',
    },
    provenance: {
      sourceUrl: null,
      license: 'local repository policy',
      downloadScript: 'scripts/build_openalice_asset_metadata_registry.ts',
      auditScript: 'scripts/build_openalice_asset_metadata_registry.ts',
      resumeScript: 'scripts/build_openalice_asset_metadata_registry.ts',
      summaryPath: report.exists ? reportPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(reportManifestPath) ? reportManifestPath : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(reportManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: report.value?.summary?.assets ?? null,
      failedFiles: report.value?.summary?.missingContractAddresses ?? null,
      missingFiles: report.value?.summary?.missingDecimals ?? null,
      targetSymbols: report.value?.summary?.assets ?? null,
      complete,
    },
    blockers,
    nextActions: complete
      ? ['Keep asset metadata registry refreshed as new Binance symbols appear.']
      : ['Resolve contract addresses, decimals, listing/delisting events, and source-provider mappings.'],
  }
}

async function coinMetricsWarehouseDataset(input: {
  datasetId: string
  layer: CatalogLayer
  storagePath: string
  reportPath: string
  format: string
  blocker: string
  nextAction: string
}): Promise<OpenAliceCatalogDataset> {
  const stats = await statTree(input.storagePath)
  const report = await readJsonIfExists<Record<string, unknown>>(input.reportPath)
  const reportManifestPath = `${input.reportPath}.manifest.json`
  const storageManifestPath = `${input.storagePath}.manifest.json`
  const reportStatus = readString(report.value?.status)
  const reportBlockers = readStringArray(report.value?.blockers)
  const present = stats.files > 0 || report.exists
  const complete = present && reportStatus === 'complete'
  const status: CatalogStatus = complete ? 'complete' : present ? 'partial' : 'missing'
  return {
    datasetId: input.datasetId,
    source: 'coinmetrics_community',
    family: 'onchain',
    layer: input.layer,
    storagePath: input.storagePath,
    present,
    status,
    reason: complete
      ? 'Coin Metrics warehouse dataset is collected and verified by its runtime report'
      : present
        ? 'Coin Metrics warehouse dataset exists but its runtime report is not complete'
        : 'Coin Metrics warehouse dataset is missing',
    format: input.format,
    cadence: {
      granularity: 'day',
      timeframe: '1d',
    },
    timeSpan: {
      start: readString(report.value?.observedStartTime),
      end: readString(report.value?.observedEndTime),
      policy: 'Coin Metrics asset-metric daily history with point-in-time availability recorded by runtime reports',
    },
    provenance: {
      sourceUrl: 'https://community-api.coinmetrics.io',
      license: 'Coin Metrics Community terms',
      downloadScript: 'scripts/collect_coinmetrics_community_onchain.ts',
      auditScript: input.layer === 'raw'
        ? 'scripts/collect_coinmetrics_community_onchain.ts'
        : 'scripts/normalize_coinmetrics_community_onchain.ts',
      resumeScript: input.layer === 'raw'
        ? 'scripts/collect_coinmetrics_community_onchain.ts'
        : 'scripts/normalize_coinmetrics_community_onchain.ts',
      summaryPath: report.exists ? input.reportPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(storageManifestPath)
        ? storageManifestPath
        : existsSync(reportManifestPath)
          ? reportManifestPath
          : null,
    },
    quality: {
      summaryPresent: report.exists,
      retrySummaryPresent: false,
      auditPresent: report.exists,
      manifestPresent: existsSync(storageManifestPath) || existsSync(reportManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete,
    },
    blockers: complete ? [] : reportBlockers.length > 0 ? reportBlockers : [input.blocker],
    nextActions: complete
      ? ['Keep Coin Metrics runtime reports refreshed as new on-chain rows are appended.']
      : [input.nextAction],
  }
}

async function coinMetricsAuditDataset(input: {
  storagePath: string
  blocker: string
  nextAction: string
}): Promise<OpenAliceCatalogDataset> {
  const report = await readJsonIfExists<Record<string, unknown>>(input.storagePath)
  const reportManifestPath = `${input.storagePath}.manifest.json`
  const reportStatus = readString(report.value?.status)
  const reportBlockers = readStringArray(report.value?.blockers)
  const present = report.exists
  const complete = present && reportStatus === 'complete'
  const status: CatalogStatus = complete ? 'complete' : present ? 'partial' : 'missing'
  const bytes = present ? Buffer.byteLength(JSON.stringify(report.value ?? {}), 'utf-8') : 0
  return {
    datasetId: 'onchain:coinmetrics-community:audit',
    source: 'coinmetrics_community',
    family: 'onchain',
    layer: 'audit',
    storagePath: input.storagePath,
    present,
    status,
    reason: complete
      ? 'Coin Metrics audit artifact passed'
      : present
        ? 'Coin Metrics audit artifact exists but is not complete'
        : 'Coin Metrics audit artifact is missing',
    format: 'json',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: readString(report.value?.observedStartTime),
      end: readString(report.value?.observedEndTime),
      policy: 'Audit covers the normalized Coin Metrics warehouse snapshot referenced by inputPath',
    },
    provenance: {
      sourceUrl: 'https://community-api.coinmetrics.io',
      license: 'Coin Metrics Community terms',
      downloadScript: null,
      auditScript: 'scripts/audit_coinmetrics_community_onchain.ts',
      resumeScript: 'scripts/audit_coinmetrics_community_onchain.ts',
      summaryPath: report.exists ? input.storagePath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(reportManifestPath) ? reportManifestPath : null,
    },
    quality: {
      summaryPresent: present,
      retrySummaryPresent: false,
      auditPresent: present,
      manifestPresent: existsSync(reportManifestPath),
      files: present ? 1 : 0,
      bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: present ? 1 : null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete,
    },
    blockers: complete ? [] : reportBlockers.length > 0 ? reportBlockers : [input.blocker],
    nextActions: complete
      ? ['Keep Coin Metrics audit refreshed after each normalized warehouse update.']
      : [input.nextAction],
  }
}

async function directoryRequirementDataset(input: {
  datasetId: string
  source: string
  family: CatalogFamily
  layer: CatalogLayer
  storagePath: string
  format: string
  blocker: string
  nextAction: string
  sourceUrl?: string
  license?: string
}): Promise<OpenAliceCatalogDataset> {
  const stats = await statTree(input.storagePath)
  const present = stats.files > 0
  return {
    datasetId: input.datasetId,
    source: input.source,
    family: input.family,
    layer: input.layer,
    storagePath: input.storagePath,
    present,
    status: present ? 'partial' : 'missing',
    reason: present ? 'directory has files but no complete warehouse contract yet' : 'required warehouse directory is missing or empty',
    format: input.format,
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'source-specific earliest available history to latest available point',
    },
    provenance: {
      sourceUrl: input.sourceUrl ?? null,
      license: input.license ?? 'local repository policy',
      downloadScript: null,
      auditScript: null,
      resumeScript: null,
      summaryPath: null,
      retrySummaryPath: null,
      manifestPath: null,
    },
    quality: {
      summaryPresent: false,
      retrySummaryPresent: false,
      auditPresent: false,
      manifestPresent: false,
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete: false,
    },
    blockers: [input.blocker],
    nextActions: [input.nextAction],
  }
}

async function reportRequirementDataset(input: {
  datasetId: string
  source: string
  family: CatalogFamily
  layer: CatalogLayer
  storagePath: string
  format: string
  blocker: string
  nextAction: string
  sourceUrl?: string
  license?: string
}): Promise<OpenAliceCatalogDataset> {
  const report = await readJsonIfExists<Record<string, unknown>>(input.storagePath)
  const present = report.exists
  const bytes = present ? Buffer.byteLength(JSON.stringify(report.value ?? {}), 'utf-8') : 0
  return {
    datasetId: input.datasetId,
    source: input.source,
    family: input.family,
    layer: input.layer,
    storagePath: input.storagePath,
    present,
    status: present ? 'partial' : 'missing',
    reason: present ? 'artifact exists but warehouse contract is not yet complete' : 'required warehouse artifact is missing',
    format: input.format,
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'source-specific earliest available history to latest available point',
    },
    provenance: {
      sourceUrl: input.sourceUrl ?? null,
      license: input.license ?? 'local repository policy',
      downloadScript: null,
      auditScript: null,
      resumeScript: null,
      summaryPath: null,
      retrySummaryPath: null,
      manifestPath: existsSync(`${input.storagePath}.manifest.json`) ? `${input.storagePath}.manifest.json` : null,
    },
    quality: {
      summaryPresent: present,
      retrySummaryPresent: false,
      auditPresent: present,
      manifestPresent: existsSync(`${input.storagePath}.manifest.json`),
      files: present ? 1 : 0,
      bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: present ? 1 : null,
      failedFiles: null,
      missingFiles: null,
      targetSymbols: null,
      complete: false,
    },
    blockers: [input.blocker],
    nextActions: [input.nextAction],
  }
}

async function syntheticResumeContractDataset(warehouseRoot: string, repoDataRoot: string): Promise<OpenAliceCatalogDataset> {
  const logsRoot = resolve(warehouseRoot, 'logs')
  const contractPath = resolve(repoDataRoot, 'runtime/openalice_resume_finalize_contract.latest.json')
  const contractManifestPath = `${contractPath}.manifest.json`
  const stats = await statTree(logsRoot)
  const contract = await readJsonIfExists<Record<string, unknown>>(contractPath)
  const summary = contract.value == null ? null : asRecord(contract.value.summary)
  const sources = readNumber(summary?.sources) ?? 0
  const completeSources = readNumber(summary?.completeSources) ?? 0
  const contractBlockers = readStringArray(contract.value?.blockers)
  const complete = contract.exists &&
    readString(contract.value?.status) === 'complete' &&
    readString(contract.value?.contractVersion) === 'openalice.resume_finalize_contract.v1' &&
    readBoolean(contract.value?.startsDownload) === false &&
    readBoolean(contract.value?.executionAllowed) === false &&
    sources > 0 &&
    completeSources === sources &&
    existsSync(contractManifestPath)
  const present = stats.files > 0 || contract.exists
  return {
    datasetId: 'warehouse-resume:retry-finalize-contract',
    source: 'openalice_warehouse',
    family: 'resume',
    layer: 'runtime',
    storagePath: contract.exists ? contractPath : logsRoot,
    present,
    status: complete ? 'complete' : present ? 'partial' : 'missing',
    reason: complete
      ? 'source-agnostic resume/finalize contract exists for data collectors and candidate imports'
      : present
      ? 'download logs or resume contract artifact exist but source-agnostic contract is incomplete'
      : 'warehouse retry/finalize logs are missing',
    format: 'logs/json/jsonl',
    cadence: {
      granularity: 'event',
      timeframe: null,
    },
    timeSpan: {
      start: null,
      end: null,
      policy: 'per collector run ledger',
    },
    provenance: {
      sourceUrl: null,
      license: 'local runtime data',
      downloadScript: null,
      auditScript: 'scripts/build_openalice_resume_finalize_contract.ts',
      resumeScript: 'scripts/build_openalice_resume_finalize_contract.ts',
      summaryPath: contract.exists ? contractPath : null,
      retrySummaryPath: null,
      manifestPath: existsSync(contractManifestPath) ? contractManifestPath : null,
    },
    quality: {
      summaryPresent: contract.exists,
      retrySummaryPresent: false,
      auditPresent: contract.exists,
      manifestPresent: existsSync(contractManifestPath),
      files: stats.files,
      bytes: stats.bytes,
      zipFiles: 0,
      partFiles: 0,
      expectedFiles: sources > 0 ? sources : null,
      failedFiles: sources > 0 ? Math.max(0, sources - completeSources) : null,
      missingFiles: null,
      targetSymbols: null,
      complete,
    },
    blockers: complete
      ? []
      : contractBlockers.length > 0
        ? contractBlockers.map(blocker => `resume_finalize_contract:${blocker}`)
        : ['cross_source_resume_finalize_contract_missing'],
    nextActions: complete
      ? ['Keep the resume/finalize contract refreshed when adding new collectors or candidate import sources.']
      : ['Run data:warehouse:resume-finalize-contract to produce a source-agnostic collector resume/finalize contract.'],
  }
}

function classifyBinanceDataset(input: {
  present: boolean
  zipFiles: number
  partFiles: number
  summaryResult: JsonReadResult<DownloadSummary>
}): { status: CatalogStatus; complete: boolean; reason: string } {
  if (!input.present) return { status: 'missing', complete: false, reason: 'dataset directory does not exist' }
  if (input.partFiles > 0) return { status: 'in_progress', complete: false, reason: 'part files are present' }
  if (input.summaryResult.error) {
    return { status: 'failed', complete: false, reason: `summary unreadable: ${input.summaryResult.error}` }
  }
  const summary = input.summaryResult.value
  if (!summary) return { status: 'partial', complete: false, reason: 'authoritative download summary is missing' }
  const failed = summary.totals?.failed ?? 0
  const missing = summary.totals?.missing ?? 0
  if (failed > 0 || missing > 0) {
    return { status: 'needs_retry', complete: false, reason: `summary has failed=${failed} missing=${missing}` }
  }
  if (summary.coverage !== 'complete') {
    return { status: 'partial', complete: false, reason: `summary coverage is ${summary.coverage ?? 'unknown'}` }
  }
  if (input.zipFiles !== (summary.files ?? -1)) {
    return {
      status: 'partial',
      complete: false,
      reason: `zip count ${input.zipFiles} does not match summary.files ${summary.files ?? 'unknown'}`,
    }
  }
  return {
    status: 'complete',
    complete: true,
    reason: 'complete summary, zero failed/missing, zip count matches',
  }
}

function binanceFamily(spec: BinanceDatasetSpec): CatalogFamily {
  if (spec.market === 'um' && (
    spec.dataType === 'fundingRate' ||
    spec.dataType === 'bookTicker' ||
    DERIVATIVE_KLINE_TYPES.includes(spec.dataType as typeof DERIVATIVE_KLINE_TYPES[number])
  )) {
    return 'derivatives'
  }
  return 'market'
}

function binanceSourceUrl(spec: BinanceDatasetSpec): string {
  const marketPrefix = spec.market === 'spot' ? 'data/spot' : 'data/futures/um'
  const cadence = spec.dataType === 'fundingRate' || spec.dataType === 'bookTicker' ? 'daily' : 'monthly'
  const timeframe = spec.timeframe ? `/{symbol}/${spec.timeframe}` : '/{symbol}'
  return `https://data.binance.vision/?prefix=${marketPrefix}/${cadence}/${spec.dataType}${timeframe}/`
}

function binanceNextActions(status: CatalogStatus, directory: string): string[] {
  if (status === 'complete') return ['Keep scheduled audit refreshed as new daily/monthly Data Vision files appear.']
  if (status === 'in_progress') return ['Wait for active downloader to finish before starting another runner for this directory.']
  if (status === 'needs_retry') return [`Run managed dataset retry/finalize for ${directory}.`]
  if (status === 'missing') return [`Run managed Data Vision backfill for ${directory}.`]
  return [`Run final discovery, retry, and local reconcile finalize for ${directory}.`]
}

function granularityForTimeframe(timeframe: string | undefined, dataType: string): TimeGranularity {
  if (!timeframe) return dataType === 'trades' || dataType === 'aggTrades' ? 'event' : 'event'
  if (timeframe === '1mo') return 'month'
  if (timeframe.endsWith('s')) return 'second'
  if (timeframe.endsWith('m')) return 'minute'
  if (timeframe.endsWith('h')) return 'hour'
  if (timeframe.endsWith('d')) return 'day'
  if (timeframe.endsWith('w')) return 'week'
  return 'event'
}

function summarizeDatasets(datasets: OpenAliceCatalogDataset[]): OpenAliceDataCatalogReport['summary'] {
  const binance = datasets.filter(dataset => dataset.source === 'binance_data_vision')
  return {
    datasets: datasets.length,
    complete: datasets.filter(dataset => dataset.status === 'complete').length,
    partial: datasets.filter(dataset => dataset.status === 'partial').length,
    missing: datasets.filter(dataset => dataset.status === 'missing').length,
    inProgress: datasets.filter(dataset => dataset.status === 'in_progress').length,
    needsRetry: datasets.filter(dataset => dataset.status === 'needs_retry').length,
    failed: datasets.filter(dataset => dataset.status === 'failed').length,
    rawDatasets: datasets.filter(dataset => dataset.layer === 'raw').length,
    normalizedDatasets: datasets.filter(dataset => dataset.layer === 'normalized/parquet').length,
    auditDatasets: datasets.filter(dataset => dataset.layer === 'audit').length,
    runtimeDatasets: datasets.filter(dataset => dataset.layer === 'runtime').length,
    verifiedBinancePublicDatasets: binance.filter(dataset => dataset.status === 'complete').length,
    plannedBinancePublicDatasets: binance.length,
  }
}

function buildGlobalBlockers(
  datasets: OpenAliceCatalogDataset[],
  monitorOfflineBackfills: boolean,
): string[] {
  const blockers = new Set<string>()
  const presentFamilies = new Set(datasets.filter(dataset => dataset.present).map(dataset => dataset.family))
  const presentLayers = new Set(datasets.filter(dataset => dataset.present).map(dataset => dataset.layer))
  const observedGranularities = new Set(datasets.filter(dataset => dataset.present).map(dataset => dataset.cadence.granularity))

  for (const family of REQUIRED_FAMILIES) {
    if (!presentFamilies.has(family)) blockers.add(`required_family_missing:${family}`)
  }
  for (const layer of REQUIRED_LAYERS) {
    if (!presentLayers.has(layer)) blockers.add(`required_layer_missing:${layer}`)
  }
  for (const granularity of REQUIRED_GRANULARITIES) {
    if (!observedGranularities.has(granularity)) blockers.add(`required_granularity_missing:${granularity}`)
  }

  const binance = datasets.filter(dataset => dataset.source === 'binance_data_vision')
  const incompleteBinance = binance.filter(dataset => dataset.status !== 'complete')
  if (monitorOfflineBackfills && incompleteBinance.length > 0) {
    blockers.add(`binance_public_incomplete:${binance.length - incompleteBinance.length}/${binance.length}`)
  }

  for (const dataset of datasets) {
    if (dataset.runtimeBlocking === false && !monitorOfflineBackfills) continue
    for (const blocker of dataset.blockers) blockers.add(blocker)
  }

  return [...blockers].sort()
}

function summarizeBlockerActionability(blockers: string[]): OpenAliceDataCatalogReport['blockerActionability'] {
  const buckets = new Map<BlockerActionCategory, string[]>()
  for (const blocker of blockers) {
    const category = classifyCatalogBlocker(blocker)
    const list = buckets.get(category) ?? []
    list.push(blocker)
    buckets.set(category, list)
  }
  const categories = [...buckets.entries()]
    .map(([category, values]) => ({
      category,
      count: values.length,
      sampleBlockers: values.slice(0, 12),
      nextAction: nextActionForBlockerCategory(category),
    }))
    .sort((left, right) => {
      const countDiff = right.count - left.count
      if (countDiff !== 0) return countDiff
      return categoryPriority(left.category) - categoryPriority(right.category)
    })
  return {
    totalBlockers: blockers.length,
    primaryCategory: categories[0]?.category ?? null,
    categories,
  }
}

function classifyCatalogBlocker(blocker: string): BlockerActionCategory {
  if (
    blocker.startsWith('binance_dataset_missing:') ||
    blocker.startsWith('binance_dataset_in_progress:') ||
    blocker.startsWith('binance_dataset_needs_retry:') ||
    blocker.startsWith('binance_public_incomplete:')
  ) {
    return 'download_gap'
  }
  if (
    blocker.includes('point_in_time') ||
    blocker.includes('pit_') ||
    blocker.includes('normalized_parquet') ||
    blocker.includes('normalized_warehouse_field_coverage') ||
    blocker.includes('normalized_warehouse_index_incomplete') ||
    blocker.includes('local_market_requires_normalized') ||
    blocker.includes('feature_backtest_input')
  ) {
    return 'pit_or_normalized_gap'
  }
  if (
    blocker.includes('external_derivatives') ||
    blocker.includes('fundingRate') ||
    blocker.includes('markPriceKlines') ||
    blocker.includes('indexPriceKlines') ||
    blocker.includes('premiumIndexKlines') ||
    blocker.includes('bookTicker')
  ) {
    return 'derivatives_audit_gap'
  }
  if (
    blocker.includes('asset_metadata') ||
    blocker.includes('contract_address') ||
    blocker.includes('decimals') ||
    blocker.includes('listing') ||
    blocker.includes('delisting')
  ) {
    return 'asset_metadata_gap'
  }
  if (
    blocker.includes('manifest') ||
    blocker.includes('evidence_trust') ||
    blocker.includes('trust_blocked') ||
    blocker.includes('quarantine')
  ) {
    return 'manifest_or_trust_gap'
  }
  if (blocker.startsWith('ai_scientist_') || blocker.includes('ai_scientist')) {
    return 'ai_scientist_validation_gate'
  }
  if (
    blocker.includes('research_only') ||
    blocker.includes('not_trading_authority') ||
    blocker.includes('not_promotion_evidence') ||
    blocker.includes('not_execution_authority') ||
    blocker.includes('paper_execution_telemetry_missing')
  ) {
    return 'research_only_safety_gate'
  }
  if (blocker.includes('resume') || blocker.includes('finalize_contract')) return 'resume_contract_gap'
  return 'other'
}

function nextActionForBlockerCategory(category: BlockerActionCategory): string {
  switch (category) {
    case 'download_gap':
      return 'Continue managed Data Vision backfill/retry/finalize for missing or in-progress raw datasets; do not use partial downloads for promotion evidence.'
    case 'pit_or_normalized_gap':
      return 'Normalize raw rows into row-explicit PIT datasets with observedAt/fetchedAt/availableAt and sidecar manifests before backtest or strategy evidence use.'
    case 'derivatives_audit_gap':
      return 'Complete derivatives coverage and audit for funding, mark/index/premium basis, order-book/liquidity, and route-cost inputs.'
    case 'asset_metadata_gap':
      return 'Fill symbol mapping, contract address, decimals, listing/delisting, and exchange mapping metadata with explicit source provenance.'
    case 'manifest_or_trust_gap':
      return 'Refresh manifest coverage and evidence trust audits; quarantine remains a promotion blocker until explicitly resolved.'
    case 'ai_scientist_validation_gate':
      return 'Treat AI-Scientist outputs as candidates only; run OpenAlice second validation, PIT, WFO, FDR, route-cost, risk, prospective, and paper telemetry gates.'
    case 'research_only_safety_gate':
      return 'Keep research-only artifacts blocked from execution; this is an intentional safety gate, not a data download task.'
    case 'resume_contract_gap':
      return 'Extract source-agnostic retry/finalize contracts so collectors are resumable and auditable across data sources.'
    case 'other':
      return 'Inspect blocker details and add a more specific catalog action category if it recurs.'
  }
}

function categoryPriority(category: BlockerActionCategory): number {
  return [
    'download_gap',
    'pit_or_normalized_gap',
    'derivatives_audit_gap',
    'manifest_or_trust_gap',
    'asset_metadata_gap',
    'ai_scientist_validation_gate',
    'research_only_safety_gate',
    'resume_contract_gap',
    'other',
  ].indexOf(category)
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function buildNextActions(blockers: string[]): string[] {
  const actions = new Set<string>()
  if (blockers.some(blocker => blocker.startsWith('binance_public_incomplete'))) {
    actions.add('Continue the managed Binance Data Vision queue until all planned public market and derivatives datasets are complete.')
  }
  if (blockers.some(blocker => blocker.includes('normalized_parquet'))) {
    actions.add('Add canonical parquet materializers for raw Binance, live market, derivatives, on-chain, and metadata datasets.')
  }
  if (blockers.some(blocker => blocker.includes('coinmetrics'))) {
    actions.add('Implement a Coin Metrics Community collector with summary, manifest, retry, and coverage audit outputs.')
  }
  if (blockers.some(blocker => blocker.includes('asset_metadata'))) {
    actions.add('Create the asset metadata registry covering symbol mapping, listing/delisting, contracts, decimals, exchange mappings, and timestamp precision.')
  }
  if (blockers.some(blocker => blocker.includes('feature') || blocker.includes('point_in_time'))) {
    actions.add('Build point-in-time feature and backtest input snapshots from normalized data only.')
  }
  if (actions.size === 0) actions.add('Keep scheduled data freshness and manifest coverage audits refreshed.')
  return [...actions]
}

function observedValues<T extends string>(values: T[], ordered: T[]): T[] {
  const present = new Set(values)
  return ordered.filter(value => present.has(value))
}

interface JsonReadResult<T> {
  exists: boolean
  value: T | null
  error: string | null
}

async function readJsonIfExists<T>(path: string): Promise<JsonReadResult<T>> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf-8')) as T, error: null }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { exists: false, value: null, error: null }
    return { exists: true, value: null, error: (error as Error).message }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function countFilesWithSuffix(root: string, suffix: string): Promise<number> {
  if (!(await pathExists(root))) return 0
  let count = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const currentStat = await stat(current)
    if (currentStat.isFile()) {
      if (current.endsWith(suffix)) count += 1
      continue
    }
    if (!currentStat.isDirectory()) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name)
      if (entry.isDirectory()) stack.push(child)
      else if (entry.isFile() && entry.name.endsWith(suffix)) count += 1
    }
  }
  return count
}

async function statTree(root: string): Promise<FileStats> {
  if (!(await pathExists(root))) return { files: 0, bytes: 0 }
  const rootStat = await stat(root)
  if (rootStat.isFile()) return { files: 1, bytes: rootStat.size }
  let files = 0
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = resolve(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(child)
      } else if (entry.isFile()) {
        const childStat = await stat(child)
        files += 1
        bytes += childStat.size
      }
    }
  }
  return { files, bytes }
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

export function renderOpenAliceDataCatalogMarkdown(report: OpenAliceDataCatalogReport): string {
  const lines: string[] = []
  lines.push('# OpenAlice Data Catalog')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Warehouse root: \`${report.warehouseRoot}\``)
  lines.push(`Repo data root: \`${report.repoDataRoot}\``)
  lines.push(`AI-Scientist root: \`${report.aiScientistRoot}\``)
  lines.push(`Offline backfill strict audit: \`${report.monitorOfflineBackfills}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push('')
  lines.push('## Summary')
  lines.push('')
  lines.push(`- Datasets: ${report.summary.datasets}`)
  lines.push(`- Complete: ${report.summary.complete}`)
  lines.push(`- Partial: ${report.summary.partial}`)
  lines.push(`- Missing: ${report.summary.missing}`)
  lines.push(`- In progress: ${report.summary.inProgress}`)
  lines.push(`- Binance verified: ${report.summary.verifiedBinancePublicDatasets}/${report.summary.plannedBinancePublicDatasets}`)
  lines.push('')
  if (report.blockers.length > 0) {
    lines.push('## Blockers')
    lines.push('')
    for (const blocker of report.blockers.slice(0, 80)) lines.push(`- \`${blocker}\``)
    if (report.blockers.length > 80) lines.push(`- ... ${report.blockers.length - 80} more`)
    lines.push('')
  }
  lines.push('## Next Actions')
  lines.push('')
  for (const action of report.nextActions) lines.push(`- ${action}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseOpenAliceDataCatalogArgs(argv)
  const report = await runOpenAliceDataCatalog(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderOpenAliceDataCatalogMarkdown(report))
  }
  if (report.status === 'blocked' && !args.allowBlockedExitZero) process.exitCode = 2
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_openalice_data_catalog failed:', error)
    process.exit(1)
  })
}
