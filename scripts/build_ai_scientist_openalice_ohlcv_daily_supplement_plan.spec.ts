import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildAiScientistOhlcvDailySupplementPlanReport,
  parseAiScientistOhlcvDailySupplementPlanArgs,
  runAiScientistOhlcvDailySupplementPlan,
} from './build_ai_scientist_openalice_ohlcv_daily_supplement_plan.js'

describe('build_ai_scientist_openalice_ohlcv_daily_supplement_plan', () => {
  it('parses args and keeps package scripts wired planned-only by default', () => {
    expect(parseAiScientistOhlcvDailySupplementPlanArgs([
      '--planPath',
      '/tmp/plan.json',
      '--dataRoot',
      '/tmp/warehouse',
      '--output',
      'none',
      '--manifest',
      'null',
      '--probe',
      'true',
      '--download',
      'false',
      '--maxTasks',
      '2',
      '--maxEntries',
      '5',
      '--concurrency',
      '3',
      '--json',
      'true',
    ])).toMatchObject({
      planPath: '/tmp/plan.json',
      warehouseRoot: '/tmp/warehouse',
      outputPath: null,
      manifestPath: null,
      probe: true,
      download: false,
      maxTasks: 2,
      maxEntries: 5,
      concurrency: 3,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:ohlcv-daily-supplement-plan']).toContain(
      'build_ai_scientist_openalice_ohlcv_daily_supplement_plan.ts',
    )
    expect(scripts['research:ai-scientist:ohlcv-daily-supplement-plan']).not.toContain('--download true')
    expect(scripts['status:research-evidence']).toContain(
      'build_ai_scientist_openalice_ohlcv_daily_supplement_plan.ts',
    )
    expect(scripts['status:research-evidence']).not.toContain('--download true')
  })

  it('plans current-month daily archive supplements without probing or promotion claims', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-daily-plan-'))
    const report = await buildAiScientistOhlcvDailySupplementPlanReport({
      generatedAt: '2026-05-06T19:00:00.000Z',
      planPath: '/tmp/native-plan.json',
      warehouseRoot: root,
      manifestPath: join(root, 'manifest.jsonl'),
      plan: makePlan([makeMissingMonthTask({
        taskId: 'pit_rebuild.btc',
        rawSymbol: 'BTC_USDT_USDT',
        binanceSymbol: 'BTCUSDT',
        sourceStartTime: '2026-05-01T00:00:00.000Z',
        sourceEndTime: '2026-05-02T23:00:00.000Z',
      })]),
      args: {
        probe: false,
        download: false,
        maxTasks: 100,
        maxEntries: 0,
        concurrency: 2,
        connectTimeoutSec: 1,
        probeMaxTimeSec: 1,
        downloadMaxTimeSec: 1,
        proxy: undefined,
        networkInterface: undefined,
      },
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T19:00:00.000Z',
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'planned_research_only_daily_supplement',
      mode: {
        probe: false,
        download: false,
      },
      counts: {
        taskPlansRead: 1,
        tasksWithMissingMonthlyArchive: 1,
        uniqueSupplementEntries: 2,
        localExists: 0,
        downloaded: 0,
        remoteAvailable: 0,
        remoteMissing: 0,
        failed: 0,
        notChecked: 2,
        manifestRowsWritten: 2,
        distinctSymbols: 1,
        distinctDays: 2,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'daily_supplement_probe_not_run',
      'daily_supplement_not_checked:2',
      'daily_supplement_local_incomplete:0/2',
      'daily_supplement_research_only',
      'daily_supplement_not_promotion_grade',
    ]))
    expect(report.taskPlans[0]).toMatchObject({
      taskId: 'pit_rebuild.btc',
      supplementDays: ['2026-05-01', '2026-05-02'],
      supplementComplete: false,
      blockers: expect.arrayContaining([
        'daily_supplement_not_fully_local',
        'daily_supplement_research_only',
        'daily_supplement_not_promotion_grade',
      ]),
    })
    expect(report.manifestRows[0]).toMatchObject({
      schemaVersion: 'openalice.ai_scientist.ohlcv_daily_supplement_manifest.v1',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      exchange: 'binance',
      market: 'usdm',
      dataType: 'klines',
      cadence: 'daily',
      symbol: 'BTCUSDT',
      timeframe: '1h',
      day: '2026-05-01',
      localStatus: 'not_checked',
      httpStatus: null,
      observedAt: '2026-05-06T19:00:00.000Z',
      fetchedAt: null,
      availableAt: null,
      sourceEndpoint: 'https://data.binance.vision',
      lineageScope: 'archive_file',
      pitSuitability: 'daily_archive_download_lineage_only_not_row_pit',
      rowPITUsableForPromotion: false,
      quality: {
        promotionGrade: false,
        blockers: expect.arrayContaining([
          'daily_archive_lineage_only_not_row_pit',
          'daily_supplement_research_only',
          'row_pit_usable_for_promotion_false',
          'daily_archive_not_local',
        ]),
      },
    })
  })

  it('counts existing local daily zips but still keeps archive lineage research-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-daily-local-'))
    const zipPath = join(
      root,
      'market/binance-public/um-daily-usdt-klines-1h/um/BTCUSDT/1h/BTCUSDT-1h-2026-05-01.zip',
    )
    await mkdir(join(zipPath, '..'), { recursive: true })
    await writeFile(zipPath, 'placeholder', 'utf-8')

    const report = await buildAiScientistOhlcvDailySupplementPlanReport({
      generatedAt: '2026-05-06T19:10:00.000Z',
      planPath: '/tmp/native-plan.json',
      warehouseRoot: root,
      manifestPath: join(root, 'manifest.jsonl'),
      plan: makePlan([makeMissingMonthTask({
        taskId: 'pit_rebuild.btc',
        rawSymbol: 'BTC_USDT_USDT',
        binanceSymbol: 'BTCUSDT',
        sourceStartTime: '2026-05-01T00:00:00.000Z',
        sourceEndTime: '2026-05-01T23:00:00.000Z',
      })]),
      args: {
        probe: false,
        download: false,
        maxTasks: 100,
        maxEntries: 0,
        concurrency: 2,
        connectTimeoutSec: 1,
        probeMaxTimeSec: 1,
        downloadMaxTimeSec: 1,
        proxy: undefined,
        networkInterface: undefined,
      },
    })

    expect(report).toMatchObject({
      status: 'ready_daily_supplement_research_only',
      counts: {
        uniqueSupplementEntries: 1,
        localExists: 1,
        downloaded: 0,
        notChecked: 0,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'daily_supplement_probe_not_run',
      'daily_supplement_research_only',
      'daily_supplement_not_promotion_grade',
    ]))
    expect(report.manifestRows[0]).toMatchObject({
      zipPath,
      localStatus: 'exists',
      fetchedAt: '2026-05-06T19:10:00.000Z',
      availableAt: '2026-05-06T19:10:00.000Z',
      rowPITUsableForPromotion: false,
      quality: {
        promotionGrade: false,
        blockers: expect.arrayContaining([
          'archive_available_at_not_historical_decision_available_at',
          'row_pit_usable_for_promotion_false',
        ]),
      },
    })
  })

  it('writes report, manifest JSONL, and evidence sidecars', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-daily-write-'))
    const planPath = join(root, 'native-plan.json')
    const outputPath = join(root, 'daily-report.json')
    const manifestPath = join(root, 'daily-manifest.jsonl')
    await writeJson(planPath, makePlan([makeMissingMonthTask({
      taskId: 'pit_rebuild.eth',
      rawSymbol: 'ETH_USDT_USDT',
      binanceSymbol: 'ETHUSDT',
      sourceStartTime: '2026-05-01T00:00:00.000Z',
      sourceEndTime: '2026-05-01T23:00:00.000Z',
    })]))

    const report = await runAiScientistOhlcvDailySupplementPlan({
      planPath,
      outputPath,
      manifestPath,
      warehouseRoot: root,
      probe: false,
      download: false,
      maxTasks: 100,
      maxEntries: 0,
      concurrency: 1,
      connectTimeoutSec: 1,
      probeMaxTimeSec: 1,
      downloadMaxTimeSec: 1,
      proxy: undefined,
      networkInterface: undefined,
      json: false,
    })

    expect(report.status).toBe('planned_research_only_daily_supplement')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      status: 'planned_research_only_daily_supplement',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      counts: {
        uniqueSupplementEntries: 1,
      },
    })
    const manifestRows = (await readFile(manifestPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(manifestRows).toHaveLength(1)
    expect(manifestRows[0]).toMatchObject({
      symbol: 'ETHUSDT',
      day: '2026-05-01',
      localStatus: 'not_checked',
      rowPITUsableForPromotion: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_ohlcv_daily_supplement_plan_report',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
    expect(JSON.parse(await readFile(`${manifestPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_ohlcv_daily_supplement_plan',
      businessStatus: 'fail',
      recordsIn: 1,
      recordsOut: 1,
    })
  })
})

function makePlan(taskPlans: unknown[]) {
  return {
    schemaVersion: 1,
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status: 'blocked_missing_data_vision_archives',
    taskPlans,
  }
}

function makeMissingMonthTask(input: {
  taskId: string
  rawSymbol: string
  binanceSymbol: string
  sourceStartTime: string
  sourceEndTime: string
}) {
  return {
    taskId: input.taskId,
    rawSymbol: input.rawSymbol,
    binanceSymbol: input.binanceSymbol,
    symbol: `${input.rawSymbol.split('_')[0]}/USDT:USDT`,
    timeframe: '1h',
    sourceStartTime: input.sourceStartTime,
    sourceEndTime: input.sourceEndTime,
    missingArchiveMonths: ['2026-05'],
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
