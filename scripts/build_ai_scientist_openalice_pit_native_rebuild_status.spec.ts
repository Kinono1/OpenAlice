import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistPitNativeRebuildStatusReport,
  parseAiScientistPitNativeRebuildStatusArgs,
  runAiScientistPitNativeRebuildStatus,
} from './build_ai_scientist_openalice_pit_native_rebuild_status.js'
import { buildDownloadManifestRecord } from './fast_binance_data_vision_backfill.js'

describe('build_ai_scientist_openalice_pit_native_rebuild_status', () => {
  it('parses args and keeps package scripts wired research-only', () => {
    expect(parseAiScientistPitNativeRebuildStatusArgs([
      '--queuePath',
      '/tmp/rebuild-queue.json',
      '--catalogPath',
      '/tmp/catalog.json',
      '--derivativesRowsPath',
      '/tmp/derivatives.jsonl',
      '--output',
      'none',
      '--maxTasks',
      '9',
      '--maxManifestLines',
      '11',
      '--maxDerivativeRows',
      '13',
      '--json',
      'true',
    ])).toMatchObject({
      rebuildQueuePath: '/tmp/rebuild-queue.json',
      dataCatalogPath: '/tmp/catalog.json',
      normalizedDerivativesRowsPath: '/tmp/derivatives.jsonl',
      outputPath: null,
      maxTasks: 9,
      maxManifestLines: 11,
      maxDerivativeRows: 13,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:pit-native-rebuild-status']).toContain(
      'build_ai_scientist_openalice_pit_native_rebuild_status.ts',
    )
    expect(scripts['status:research-evidence']).toContain(
      'build_ai_scientist_openalice_pit_native_rebuild_status.ts',
    )
  })

  it('blocks OHLCV auto rebuild when raw kline zip manifest lacks collector timestamps', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-native-'))
    const manifestPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/manifest.fast-binance-download.jsonl')
    const summaryPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/summary.fast-binance-download.json')
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, [
      JSON.stringify({
        market: 'um',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        month: '2025-01',
        key: 'data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
        url: 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
        zipPath: join(root, 'BTCUSDT-1h-2025-01.zip'),
        status: 'downloaded',
        httpStatus: 200,
      }),
    ].join('\n') + '\n', 'utf-8')
    await writeJson(summaryPath, {
      startedAt: '2026-05-05T11:31:04.306Z',
      endedAt: '2026-05-05T11:34:55.923Z',
      coverage: 'complete',
      files: 1,
    })

    const report = await buildAiScientistPitNativeRebuildStatusReport({
      generatedAt: '2026-05-06T15:40:00.000Z',
      warehouseRoot: root,
      maxTasks: 100,
      maxManifestLines: 100,
      sourceArtifacts: {
        rebuildQueue: '/tmp/rebuild-queue.json',
        dataCatalog: '/tmp/catalog.json',
        normalizedDerivativesRows: '/tmp/derivatives.jsonl',
        warehouseRoot: root,
      },
      rebuildQueue: makeRebuildQueue([makeOhlcvTask()]),
      dataCatalog: makeDataCatalog(manifestPath, summaryPath),
      derivativesPitSource: {
        path: '/tmp/derivatives.jsonl',
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
        error: null,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T15:40:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_native_lineage_not_ready',
      counts: {
        assessedTasks: 1,
        ohlcvKlineTasks: 1,
        autoRebuildEligibleTasks: 0,
        requiredCollectorUpgradeTasks: 1,
        rawKlineManifestPresentTasks: 1,
        rawKlineManifestWithCollectorTimesTasks: 0,
        rawKlineManifestWithPromotionGradeTimeFieldsTasks: 0,
        rawKlineSummaryWithBatchWindowTasks: 1,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_native_rebuild_tasks_not_auto_eligible:0/1',
      'ai_scientist_pit_ohlcv_collector_upgrade_required:1',
      'ai_scientist_pit_raw_kline_manifest_lacks_promotion_grade_times:0/1',
      'ai_scientist_pit_native_rebuild_status_research_only',
    ]))
    expect(report.taskStatuses[0]).toMatchObject({
      sourceFamily: 'ohlcv_kline',
      binanceSymbol: 'BTCUSDT',
      matchedKlineDatasetId: 'binance-public:um:klines:1h:usdt',
      rawKlineZipManifestPresent: true,
      rawKlineZipManifestHasSymbolRows: true,
      rawKlineZipManifestHasCollectorTimes: false,
      rawKlineZipManifestHasPromotionGradeTimeFields: false,
      rawKlineSummaryHasBatchWindow: true,
      autoRebuildEligible: false,
      requiredCollectorUpgrade: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      blockers: expect.arrayContaining([
        'raw_kline_zip_manifest_lacks_collector_times',
        'raw_kline_zip_manifest_lacks_row_explicit_observed_or_available_times',
        'raw_kline_summary_batch_window_not_row_explicit_pit',
        'ohlcv_native_collector_upgrade_required',
      ]),
    })
  })

  it('recognizes archive-file Data Vision lineage but still blocks OHLCV promotion-grade PIT rebuilds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-native-archive-'))
    const manifestPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/manifest.fast-binance-download.jsonl')
    const summaryPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/summary.fast-binance-download.json')
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, [
      JSON.stringify(buildDownloadManifestRecord({
        market: 'um',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        month: '2025-01',
        key: 'data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
        url: 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
        zipPath: join(root, 'BTCUSDT-1h-2025-01.zip'),
        status: 'downloaded',
        httpStatus: 200,
      }, {
        generatedAt: '2026-05-06T16:00:00.000Z',
        jobId: 'fast_binance_data_vision_backfill',
        collectionRunId: 'fast_binance_data_vision_backfill:test',
      })),
    ].join('\n') + '\n', 'utf-8')
    await writeJson(summaryPath, {
      schemaVersion: 'openalice.binance_data_vision.download_manifest.v2',
      startedAt: '2026-05-06T15:59:00.000Z',
      endedAt: '2026-05-06T16:00:00.000Z',
      generatedAt: '2026-05-06T16:00:00.000Z',
      jobId: 'fast_binance_data_vision_backfill',
      collectionRunId: 'fast_binance_data_vision_backfill:test',
      lineageScope: 'archive_file',
      pitSuitability: 'archive_download_lineage_only_not_row_pit',
      rowPITUsableForPromotion: false,
      coverage: 'complete',
      files: 1,
    })

    const report = await buildAiScientistPitNativeRebuildStatusReport({
      generatedAt: '2026-05-06T16:01:00.000Z',
      warehouseRoot: root,
      maxTasks: 100,
      maxManifestLines: 100,
      sourceArtifacts: {
        rebuildQueue: '/tmp/rebuild-queue.json',
        dataCatalog: '/tmp/catalog.json',
        normalizedDerivativesRows: '/tmp/derivatives.jsonl',
        warehouseRoot: root,
      },
      rebuildQueue: makeRebuildQueue([makeOhlcvTask()]),
      dataCatalog: makeDataCatalog(manifestPath, summaryPath),
      derivativesPitSource: emptyDerivativesPitSource('/tmp/derivatives.jsonl'),
    })

    expect(report).toMatchObject({
      status: 'blocked_native_lineage_not_ready',
      counts: {
        assessedTasks: 1,
        autoRebuildEligibleTasks: 0,
        requiredCollectorUpgradeTasks: 1,
        rawKlineManifestWithCollectorTimesTasks: 1,
        rawKlineManifestWithPromotionGradeTimeFieldsTasks: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_raw_kline_manifest_lacks_promotion_grade_times:0/1',
      'ai_scientist_pit_native_rebuild_status_research_only',
    ]))
    expect(report.taskStatuses[0]).toMatchObject({
      rawKlineZipManifestPresent: true,
      rawKlineZipManifestHasSymbolRows: true,
      rawKlineZipManifestHasCollectorTimes: true,
      rawKlineZipManifestHasPromotionGradeTimeFields: false,
      autoRebuildEligible: false,
      requiredCollectorUpgrade: true,
      blockers: expect.arrayContaining([
        'raw_kline_zip_manifest_lacks_row_explicit_observed_or_available_times',
        'raw_kline_zip_manifest_is_archive_file_lineage_not_row_pit',
        'raw_kline_zip_manifest_lacks_row_level_pit_lineage',
        'ohlcv_native_collector_upgrade_required',
      ]),
    })
  })

  it('detects hypothetical row-level OHLCV lineage without authorizing trading by itself', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-native-row-'))
    const manifestPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/manifest.fast-binance-download.jsonl')
    const summaryPath = join(root, 'market/binance-public/um-all-usdt-klines-1h/summary.fast-binance-download.json')
    await mkdir(join(manifestPath, '..'), { recursive: true })
    await writeFile(manifestPath, [
      JSON.stringify({
        schemaVersion: 'openalice.ohlcv_row_pit_manifest.v1',
        market: 'um',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        timeframe: '1h',
        eventTime: '2025-01-01T00:00:00.000Z',
        observedAt: '2026-05-06T16:03:00.000Z',
        fetchedAt: '2026-05-06T16:03:00.000Z',
        availableAt: '2026-05-06T16:03:00.000Z',
        generatedAt: '2026-05-06T16:03:00.000Z',
        jobId: 'ohlcv_native_row_pit_rebuild',
        collectionRunId: 'ohlcv_native_row_pit_rebuild:test',
        sourceEndpoint: 'https://data.binance.vision',
        sourceManifestId: 'row:test',
        sourceRowHash: 'abc123',
        lineageScope: 'row',
        rowPITUsableForPromotion: true,
        pitSuitability: 'row_explicit_pit',
      }),
    ].join('\n') + '\n', 'utf-8')
    await writeJson(summaryPath, {
      coverage: 'complete',
      files: 1,
    })

    const report = await buildAiScientistPitNativeRebuildStatusReport({
      generatedAt: '2026-05-06T16:04:00.000Z',
      warehouseRoot: root,
      maxTasks: 100,
      maxManifestLines: 100,
      sourceArtifacts: {
        rebuildQueue: '/tmp/rebuild-queue.json',
        dataCatalog: '/tmp/catalog.json',
        normalizedDerivativesRows: '/tmp/derivatives.jsonl',
        warehouseRoot: root,
      },
      rebuildQueue: makeRebuildQueue([makeOhlcvTask()]),
      dataCatalog: makeDataCatalog(manifestPath, summaryPath),
      derivativesPitSource: emptyDerivativesPitSource('/tmp/derivatives.jsonl'),
    })

    expect(report).toMatchObject({
      status: 'blocked_native_lineage_not_ready',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        assessedTasks: 1,
        autoRebuildEligibleTasks: 0,
        requiredCollectorUpgradeTasks: 0,
        rawKlineManifestWithCollectorTimesTasks: 1,
        rawKlineManifestWithPromotionGradeTimeFieldsTasks: 1,
      },
    })
    expect(report.taskStatuses[0]).toMatchObject({
      rawKlineZipManifestHasPromotionGradeTimeFields: true,
      autoRebuildEligible: false,
      requiredCollectorUpgrade: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      blockers: expect.arrayContaining([
        'source_task_missing_availableAt',
        'source_task_missing_observedAt_or_fetchedAt',
        'source_task_missing_completeOpenAliceWarehouseLineage',
        'ohlcv_native_rebuild_not_implemented_research_only',
      ]),
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_native_rebuild_tasks_not_auto_eligible:0/1',
      'ai_scientist_pit_native_rebuild_status_research_only',
    ]))
    expect(report.blockers).not.toEqual(expect.arrayContaining([
      'ai_scientist_pit_ohlcv_collector_upgrade_required:1',
      'ai_scientist_pit_raw_kline_manifest_lacks_promotion_grade_times:0/1',
    ]))
  })

  it('allows derivatives PIT rows only for derivatives research rebuilds and still blocks execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ai-pit-native-deriv-'))
    const rowsPath = join(root, 'derivatives.normalized.jsonl')
    await writeFile(rowsPath, [
      JSON.stringify({
        schemaVersion: 'openalice.external_derivatives.normalized.v1',
        eventTime: '2026-05-02T00:00:00.000Z',
        exchange: 'binance',
        market: 'usdm',
        symbol: 'ETHUSDT',
        endpointId: 'fundingRate',
        sourceEndpoint: '/fapi/v1/fundingRate',
        fetchedAt: '2026-05-02T15:00:16.861Z',
        observedAt: '2026-05-02T15:00:17.011Z',
        availableAt: '2026-05-02T15:00:17.599Z',
        jobId: 'external_derivatives_data_collect_run',
        generatedAt: '2026-05-02T15:00:17.600Z',
        lineageStatus: 'recovered_from_run_ledger',
      }),
      JSON.stringify({
        schemaVersion: 'openalice.external_derivatives.normalized.v1',
        eventTime: '2026-05-02T00:05:00.000Z',
        exchange: 'binance',
        market: 'usdm',
        symbol: 'ETHUSDT',
        endpointId: 'openInterestHist',
        sourceEndpoint: '/futures/data/openInterestHist',
        fetchedAt: '2026-05-02T15:00:14.951Z',
        observedAt: '2026-05-02T15:00:15.838Z',
        availableAt: '2026-05-02T15:00:17.599Z',
        jobId: 'external_derivatives_data_collect_run',
        generatedAt: '2026-05-02T15:00:17.600Z',
        lineageStatus: 'recovered_from_run_ledger',
      }),
    ].join('\n') + '\n', 'utf-8')
    const outputPath = join(root, 'native-status.json')
    const queuePath = join(root, 'queue.json')
    const catalogPath = join(root, 'catalog.json')
    await writeJson(queuePath, makeRebuildQueue([{
      ...makeOhlcvTask(),
      taskId: 'pit_rebuild.derivatives.eth',
      family: 'funding_carry',
      symbol: 'ETH/USDT:USDT',
      rawSymbol: 'ETH_USDT_USDT',
      sourceRelativePath: 'features/funding_basis/ETH_USDT_USDT_funding_1h.csv',
    }]))
    await writeJson(catalogPath, makeDataCatalog('/tmp/no-manifest.jsonl', '/tmp/no-summary.json'))

    const report = await runAiScientistPitNativeRebuildStatus({
      rebuildQueuePath: queuePath,
      dataCatalogPath: catalogPath,
      normalizedDerivativesRowsPath: rowsPath,
      warehouseRoot: root,
      outputPath,
      maxTasks: 100,
      maxManifestLines: 100,
      maxDerivativeRows: 100,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'ready_for_derivatives_research_rebuild_only',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        assessedTasks: 1,
        derivativesFeatureTasks: 1,
        autoRebuildEligibleTasks: 1,
        derivativesPitRowsAvailableTasks: 1,
        derivativesPitUsableTasks: 1,
      },
      derivativesPitSource: {
        present: true,
        rowsRead: 2,
        pitSafeRows: 2,
        pitSafe: true,
        symbols: ['ETHUSDT'],
        endpointIds: ['fundingRate', 'openInterestHist'],
      },
    })
    expect(report.taskStatuses[0]).toMatchObject({
      sourceFamily: 'derivatives_feature',
      canUseDerivativesPITRows: true,
      autoRebuildEligible: true,
      requiredCollectorUpgrade: false,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      blockers: expect.arrayContaining([
        'derivatives_pit_rows_research_rebuild_only_not_promotion',
      ]),
    })
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'ready_for_derivatives_research_rebuild_only',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_pit_native_rebuild_status',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })

  it('fails closed when the rebuild queue is missing', async () => {
    const report = await buildAiScientistPitNativeRebuildStatusReport({
      generatedAt: '2026-05-06T15:41:00.000Z',
      warehouseRoot: '/tmp/warehouse',
      maxTasks: 100,
      maxManifestLines: 100,
      sourceArtifacts: {
        rebuildQueue: '/tmp/missing-queue.json',
        dataCatalog: '/tmp/catalog.json',
        normalizedDerivativesRows: '/tmp/derivatives.jsonl',
        warehouseRoot: '/tmp/warehouse',
      },
      rebuildQueue: null,
      dataCatalog: null,
      derivativesPitSource: {
        path: '/tmp/derivatives.jsonl',
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
        error: null,
      },
    })

    expect(report).toMatchObject({
      status: 'blocked_missing_rebuild_queue',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        assessedTasks: 0,
        autoRebuildEligibleTasks: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_pit_rebuild_queue_missing',
      'ai_scientist_pit_native_rebuild_status_research_only',
    ]))
  })
})

function makeRebuildQueue(tasks: Record<string, unknown>[]) {
  return {
    schemaVersion: 1,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_waiting_for_openalice_native_rebuild',
    counts: {
      rebuildTasks: tasks.length,
      openTasks: tasks.length,
    },
    tasks,
    blockers: ['ai_scientist_pit_rebuild_queue_research_only'],
  }
}

function makeOhlcvTask() {
  return {
    taskId: 'pit_rebuild.ohlcv.btc',
    status: 'open',
    runId: 'run_a',
    candidateId: 'direction_gbdt_regime',
    family: 'event_reversal',
    symbol: 'BTC/USDT:USDT',
    rawSymbol: 'BTC_USDT_USDT',
    timeframe: '1h',
    sourceRelativePath: 'data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
    missingFields: ['availableAt', 'observedAt_or_fetchedAt', 'completeOpenAliceWarehouseLineage'],
  }
}

function makeDataCatalog(manifestPath: string, summaryPath: string) {
  return {
    schemaVersion: 1,
    status: 'blocked',
    datasets: [{
      datasetId: 'binance-public:um:klines:1h:usdt',
      source: 'binance_data_vision',
      status: 'complete',
      provenance: {
        manifestPath,
        summaryPath,
      },
    }],
  }
}

function emptyDerivativesPitSource(path: string) {
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
    error: null,
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
