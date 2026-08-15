import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistOhlcvNativeRebuildPlanReport,
  parseAiScientistOhlcvNativeRebuildPlanArgs,
  runAiScientistOhlcvNativeRebuildPlan,
} from './build_ai_scientist_openalice_ohlcv_native_rebuild_plan.js'

describe('build_ai_scientist_openalice_ohlcv_native_rebuild_plan', () => {
  it('parses args and keeps package scripts wired research-only', () => {
    expect(parseAiScientistOhlcvNativeRebuildPlanArgs([
      '--queuePath',
      '/tmp/queue.json',
      '--catalogPath',
      '/tmp/catalog.json',
      '--dataRoot',
      '/tmp/warehouse',
      '--output',
      'none',
      '--maxTasks',
      '9',
      '--maxCsvRowsPerTask',
      '11',
      '--maxManifestLines',
      '13',
      '--json',
      'true',
    ])).toMatchObject({
      rebuildQueuePath: '/tmp/queue.json',
      dataCatalogPath: '/tmp/catalog.json',
      warehouseRoot: '/tmp/warehouse',
      outputPath: null,
      maxTasks: 9,
      maxCsvRowsPerTask: 11,
      maxManifestLines: 13,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:ohlcv-native-rebuild-plan']).toContain(
      'build_ai_scientist_openalice_ohlcv_native_rebuild_plan.ts',
    )
    expect(scripts['status:research-evidence']).toContain(
      'build_ai_scientist_openalice_ohlcv_native_rebuild_plan.ts',
    )
  })

  it('plans research-only OHLCV materialization when source CSV months are covered by Data Vision archives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-plan-'))
    const archiveRoot = join(root, 'warehouse/market/binance-public/um-all-usdt-klines-1h')
    const manifestPath = join(archiveRoot, 'manifest.fast-binance-download.jsonl')
    const summaryPath = join(archiveRoot, 'summary.fast-binance-download.json')
    const btcJanZip = join(archiveRoot, 'um/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip')
    const btcFebZip = join(archiveRoot, 'um/BTCUSDT/1h/BTCUSDT-1h-2024-02.zip')
    const csvPath = join(root, 'ai/BTC_USDT_USDT_1h.csv')
    await mkdir(join(btcJanZip, '..'), { recursive: true })
    await mkdir(join(csvPath, '..'), { recursive: true })
    await writeFile(btcJanZip, 'placeholder', 'utf-8')
    await writeFile(btcFebZip, 'placeholder', 'utf-8')
    await writeFile(manifestPath, [
      JSON.stringify(makeArchiveRecord('BTCUSDT', '2024-01', btcJanZip)),
      JSON.stringify(makeArchiveRecord('BTCUSDT', '2024-02', btcFebZip)),
    ].join('\n') + '\n', 'utf-8')
    await writeJson(summaryPath, { coverage: 'complete', files: 2 })
    await writeFile(csvPath, [
      'timestamp,datetime,open,high,low,close,volume,symbol',
      '1704067200000,2024-01-01 00:00:00+00:00,1,2,1,2,100,BTC_USDT_USDT',
      '1706745600000,2024-02-01 00:00:00+00:00,2,3,2,3,110,BTC_USDT_USDT',
    ].join('\n') + '\n', 'utf-8')

    const report = await buildAiScientistOhlcvNativeRebuildPlanReport({
      generatedAt: '2026-05-06T17:00:00.000Z',
      rebuildQueuePath: '/tmp/queue.json',
      dataCatalogPath: '/tmp/catalog.json',
      warehouseRoot: join(root, 'warehouse'),
      rebuildQueue: makeQueue([makeTask(csvPath)]),
      dataCatalog: makeCatalog(manifestPath, summaryPath),
      maxTasks: 100,
      maxCsvRowsPerTask: 0,
      maxManifestLines: 100,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T17:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_research_only_ohlcv_materialization',
      counts: {
        rebuildTasksRead: 1,
        ohlcvTasksAssessed: 1,
        uniqueTaskKeys: 1,
        materializationCandidateTasks: 1,
        tasksMissingArchiveMonths: 0,
        requiredMonths: 2,
        matchedArchiveMonths: 2,
        missingArchiveMonths: 0,
        matchedZipFiles: 2,
        archiveLineageRows: 2,
        rowPitPromotionZipRows: 0,
      },
      archiveInspection: {
        manifestPresent: true,
        manifestRowsRead: 2,
        zipRecords: 2,
        zipRecordsWithArchiveLineage: 2,
        zipRecordsWithRowPitPromotion: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_ohlcv_native_rebuild_plan_research_only',
      'ohlcv_materialization_required_before_pit_contract',
    ]))
    expect(report.taskPlans[0]).toMatchObject({
      rawSymbol: 'BTC_USDT_USDT',
      binanceSymbol: 'BTCUSDT',
      timeframe: '1h',
      sourceRowsRead: 2,
      sourceStartTime: '2024-01-01T00:00:00.000Z',
      sourceEndTime: '2024-02-01T00:00:00.000Z',
      requiredMonths: ['2024-01', '2024-02'],
      matchedArchiveMonths: ['2024-01', '2024-02'],
      missingArchiveMonths: [],
      matchedZipPaths: [btcJanZip, btcFebZip],
      materializationCandidate: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      blockers: expect.arrayContaining([
        'research_only_materialization_required',
        'not_promotion_evidence',
      ]),
      outputContract: {
        schema: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1',
        lineageScope: 'row',
        forbiddenShortcuts: expect.arrayContaining([
          'source_file_mtime_recovered',
          'derived_bar_close_time_as_promotion_grade_availableAt',
          'archive_file_availableAt_as_historical_decision_availableAt',
        ]),
      },
    })
  })

  it('blocks materialization when a source CSV month is missing from archives', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-plan-missing-'))
    const archiveRoot = join(root, 'warehouse/market/binance-public/um-all-usdt-klines-1h')
    const manifestPath = join(archiveRoot, 'manifest.fast-binance-download.jsonl')
    const summaryPath = join(archiveRoot, 'summary.fast-binance-download.json')
    const btcJanZip = join(archiveRoot, 'um/BTCUSDT/1h/BTCUSDT-1h-2024-01.zip')
    const csvPath = join(root, 'ai/BTC_USDT_USDT_1h.csv')
    await mkdir(join(btcJanZip, '..'), { recursive: true })
    await mkdir(join(csvPath, '..'), { recursive: true })
    await writeFile(btcJanZip, 'placeholder', 'utf-8')
    await writeFile(manifestPath, `${JSON.stringify(makeArchiveRecord('BTCUSDT', '2024-01', btcJanZip))}\n`, 'utf-8')
    await writeJson(summaryPath, { coverage: 'partial', files: 1 })
    await writeFile(csvPath, [
      'timestamp,datetime,open,high,low,close,volume,symbol',
      '1704067200000,2024-01-01 00:00:00+00:00,1,2,1,2,100,BTC_USDT_USDT',
      '1706745600000,2024-02-01 00:00:00+00:00,2,3,2,3,110,BTC_USDT_USDT',
    ].join('\n') + '\n', 'utf-8')

    const report = await buildAiScientistOhlcvNativeRebuildPlanReport({
      generatedAt: '2026-05-06T17:01:00.000Z',
      rebuildQueuePath: '/tmp/queue.json',
      dataCatalogPath: '/tmp/catalog.json',
      warehouseRoot: join(root, 'warehouse'),
      rebuildQueue: makeQueue([makeTask(csvPath)]),
      dataCatalog: makeCatalog(manifestPath, summaryPath),
      maxTasks: 100,
      maxCsvRowsPerTask: 0,
      maxManifestLines: 100,
    })

    expect(report).toMatchObject({
      status: 'blocked_missing_data_vision_archives',
      counts: {
        materializationCandidateTasks: 0,
        tasksMissingArchiveMonths: 1,
        requiredMonths: 2,
        matchedArchiveMonths: 1,
        missingArchiveMonths: 1,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'ai_scientist_ohlcv_archive_months_missing:1/2',
      'ai_scientist_ohlcv_materialization_candidates_incomplete:0/1',
      'ai_scientist_ohlcv_native_rebuild_plan_research_only',
    ]))
    expect(report.taskPlans[0]).toMatchObject({
      missingArchiveMonths: ['2024-02'],
      materializationCandidate: false,
      blockers: expect.arrayContaining([
        'binance_data_vision_archive_months_missing:1',
        'not_promotion_evidence',
      ]),
    })
  })

  it('writes the plan artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-plan-write-'))
    const outputPath = join(root, 'plan.json')
    const queuePath = join(root, 'queue.json')
    const catalogPath = join(root, 'catalog.json')
    const manifestPath = join(root, 'manifest.jsonl')
    const summaryPath = join(root, 'summary.json')
    const csvPath = join(root, 'ai/BTC_USDT_USDT_1h.csv')
    const zipPath = join(root, 'zip/BTCUSDT-1h-2024-01.zip')
    await mkdir(join(zipPath, '..'), { recursive: true })
    await mkdir(join(csvPath, '..'), { recursive: true })
    await writeFile(zipPath, 'placeholder', 'utf-8')
    await writeFile(manifestPath, `${JSON.stringify(makeArchiveRecord('BTCUSDT', '2024-01', zipPath))}\n`, 'utf-8')
    await writeJson(summaryPath, { coverage: 'complete', files: 1 })
    await writeFile(csvPath, [
      'timestamp,datetime,open,high,low,close,volume,symbol',
      '1704067200000,2024-01-01 00:00:00+00:00,1,2,1,2,100,BTC_USDT_USDT',
    ].join('\n') + '\n', 'utf-8')
    await writeJson(queuePath, makeQueue([makeTask(csvPath)]))
    await writeJson(catalogPath, makeCatalog(manifestPath, summaryPath))

    const report = await runAiScientistOhlcvNativeRebuildPlan({
      rebuildQueuePath: queuePath,
      dataCatalogPath: catalogPath,
      warehouseRoot: root,
      outputPath,
      maxTasks: 100,
      maxCsvRowsPerTask: 0,
      maxManifestLines: 100,
      json: false,
    })

    expect(report.status).toBe('ready_for_research_only_ohlcv_materialization')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'ready_for_research_only_ohlcv_materialization',
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_ohlcv_native_rebuild_plan',
      businessStatus: 'warn',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function makeArchiveRecord(symbol: string, month: string, zipPath: string) {
  return {
    schemaVersion: 'openalice.binance_data_vision.download_manifest.v2',
    market: 'um',
    dataType: 'klines',
    symbol,
    month,
    key: `data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`,
    url: `https://data.binance.vision/data/futures/um/monthly/klines/${symbol}/1h/${symbol}-1h-${month}.zip`,
    zipPath,
    status: 'downloaded',
    httpStatus: 200,
    generatedAt: '2026-05-06T17:00:00.000Z',
    jobId: 'fast_binance_data_vision_backfill',
    collectionRunId: 'fast_binance_data_vision_backfill:test',
    observedAt: '2026-05-06T17:00:00.000Z',
    fetchedAt: '2026-05-06T17:00:00.000Z',
    availableAt: '2026-05-06T17:00:00.000Z',
    sourceManifestId: `binance_data_vision:um:klines:${symbol}:${month}:test`,
    sourceRowHash: 'hash',
    lineageScope: 'archive_file',
    rowPITUsableForPromotion: false,
  }
}

function makeQueue(tasks: Record<string, unknown>[]) {
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

function makeTask(path: string) {
  return {
    taskId: 'pit_rebuild.btc',
    status: 'open',
    runId: 'run_a',
    candidateId: 'direction_gbdt_regime',
    family: 'event_reversal',
    symbol: 'BTC/USDT:USDT',
    rawSymbol: 'BTC_USDT_USDT',
    timeframe: '1h',
    sourceFilePath: path,
    sourceRelativePath: 'data/binance_usds_1h_2024_2026/BTC_USDT_USDT_1h.csv',
    missingFields: ['availableAt', 'observedAt_or_fetchedAt', 'completeOpenAliceWarehouseLineage'],
  }
}

function makeCatalog(manifestPath: string, summaryPath: string) {
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
