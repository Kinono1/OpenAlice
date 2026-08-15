import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  parseAiScientistOhlcvMaterializeArgs,
  runAiScientistOhlcvMaterialize,
} from './materialize_ai_scientist_ohlcv_native_rows.js'

const execFileAsync = promisify(execFile)

describe('materialize_ai_scientist_ohlcv_native_rows', () => {
  it('parses args and keeps package scripts wired research-only', () => {
    expect(parseAiScientistOhlcvMaterializeArgs([
      '--planPath',
      '/tmp/plan.json',
      '--dailySupplementPlanPath',
      '/tmp/daily.json',
      '--output',
      '/tmp/output.jsonl',
      '--report',
      'none',
      '--maxTasks',
      '3',
      '--maxRowsPerTask',
      '7',
      '--json',
      'true',
    ])).toMatchObject({
      planPath: '/tmp/plan.json',
      dailySupplementPlanPath: '/tmp/daily.json',
      outputPath: '/tmp/output.jsonl',
      reportPath: null,
      maxTasks: 3,
      maxRowsPerTask: 7,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:ai-scientist:ohlcv-native-materialize']).toContain(
      'materialize_ai_scientist_ohlcv_native_rows.ts',
    )
  })

  it('materializes Data Vision zip rows as research-only non-promotion PIT-blocked rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-materialize-'))
    const zipPath = join(root, 'BTCUSDT-1h-2024-01.zip')
    const planPath = join(root, 'plan.json')
    const outputPath = join(root, 'rows.jsonl')
    const reportPath = join(root, 'report.json')
    await makeZip(zipPath, 'BTCUSDT-1h-2024-01.csv', [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1704067200000,42314.0,42603.2,42289.6,42503.5,8459.477,1704070799999,1000.5,42,123.4,567.8,0',
      '1704070800000,42503.5,42832.0,42462.0,42647.9,9043.411,1704074399999,1001.5,43,124.4,568.8,0',
    ].join('\n') + '\n')
    await writeJson(planPath, {
      schemaVersion: 1,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_for_research_only_ohlcv_materialization',
      taskPlans: [{
        taskId: 'pit_rebuild.btc',
        runId: 'run_a',
        candidateId: 'direction_gbdt_regime',
        family: 'event_reversal',
        rawSymbol: 'BTC_USDT_USDT',
        binanceSymbol: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        timeframe: '1h',
        sourceRelativePath: 'fold_01_data/BTC_USDT_USDT_1h.csv',
        sourceStartTime: '2024-01-01T00:00:00.000Z',
        sourceEndTime: '2024-01-01T01:00:00.000Z',
        materializationCandidate: true,
        matchedZipPaths: [zipPath],
      }],
    })

    const report = await runAiScientistOhlcvMaterialize({
      planPath,
      outputPath,
      reportPath,
      maxTasks: 1,
      maxRowsPerTask: 10,
      json: false,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_rows_materialized_pit_blocked',
      counts: {
        planTasksRead: 1,
        materializationCandidateTasks: 1,
        tasksMaterialized: 1,
        zipFilesRead: 1,
        rowsWritten: 2,
        promotionGradeRows: 0,
        distinctSymbols: 1,
      },
      symbols: ['BTC/USDT:USDT'],
      blockers: expect.arrayContaining([
        'ohlcv_native_rows_research_only',
        'ohlcv_native_rows_not_promotion_grade',
        'row_pit_usable_for_promotion_false',
      ]),
    })

    const rows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      schemaVersion: 'openalice.ai_scientist.ohlcv_native_row_rebuild.v1',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      runId: 'run_a',
      candidateId: 'direction_gbdt_regime',
      taskId: 'pit_rebuild.btc',
      exchange: 'binance',
      market: 'usdm',
      symbol: 'BTC/USDT:USDT',
      rawSymbol: 'BTC_USDT_USDT',
      binanceSymbol: 'BTCUSDT',
      timeframe: '1h',
      eventTime: '2024-01-01T00:00:00.000Z',
      availableAtBasis: 'archive_materialization_time_research_only_not_historical_decision_available_at',
      observedAtBasis: 'materializer_observed_archive_row',
      fetchedAtBasis: 'materializer_read_local_archive',
      sourceEndpoint: 'https://data.binance.vision',
      sourceZipPath: zipPath,
      sourceZipMonth: '2024-01',
      lineageScope: 'row',
      rowPITUsableForPromotion: false,
      pitSuitability: 'research_reproduction_only_archive_materialized_not_promotion_grade',
      openalicePitContractStatus: 'research_reproduction_archive_materialized_pit_blocked',
      open: 42314,
      high: 42603.2,
      low: 42289.6,
      close: 42503.5,
      volume: 8459.477,
      quality: {
        promotionGrade: false,
        pitLineageStatus: 'research_reproduction_archive_materialized_pit_blocked',
        blockers: expect.arrayContaining([
          'archive_materialization_time_not_historical_decision_available_at',
          'row_pit_usable_for_promotion_false',
          'research_only_not_execution_evidence',
        ]),
      },
    })
    expect(JSON.parse(await readFile(reportPath, 'utf-8'))).toMatchObject({
      status: 'research_rows_materialized_pit_blocked',
      executionAllowed: false,
      counts: {
        rowsWritten: 2,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'ai_scientist_openalice_ohlcv_native_rows',
      businessStatus: 'warn',
      recordsOut: 2,
    })
  })

  it('materializes complete local daily supplement zips as research-only PIT-blocked rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-materialize-daily-'))
    const zipPath = join(root, 'BTCUSDT-1h-2026-05-01.zip')
    const planPath = join(root, 'plan.json')
    const dailySupplementPlanPath = join(root, 'daily-plan.json')
    const outputPath = join(root, 'rows.jsonl')
    const reportPath = join(root, 'report.json')
    await makeZip(zipPath, 'BTCUSDT-1h-2026-05-01.csv', [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1777593600000,60000.0,61000.0,59000.0,60500.0,100.5,1777597199999,1000.5,42,50.1,500.2,0',
    ].join('\n') + '\n')
    await writeJson(planPath, {
      schemaVersion: 1,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked_missing_data_vision_archives',
      taskPlans: [{
        taskId: 'pit_rebuild.btc.daily',
        runId: 'run_a',
        candidateId: 'direction_gbdt_regime',
        family: 'event_reversal',
        rawSymbol: 'BTC_USDT_USDT',
        binanceSymbol: 'BTCUSDT',
        symbol: 'BTC/USDT:USDT',
        timeframe: '1h',
        sourceRelativePath: 'fold_01_data/BTC_USDT_USDT_1h.csv',
        sourceStartTime: '2026-05-01T00:00:00.000Z',
        sourceEndTime: '2026-05-01T00:00:00.000Z',
        materializationCandidate: false,
        matchedZipPaths: [],
        missingArchiveMonths: ['2026-05'],
      }],
    })
    await writeJson(dailySupplementPlanPath, {
      schemaVersion: 1,
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'ready_daily_supplement_research_only',
      taskPlans: [{
        taskId: 'pit_rebuild.btc.daily',
        supplementComplete: true,
        supplementZipPaths: [zipPath],
      }],
      counts: {
        taskPlansRead: 1,
        uniqueSupplementEntries: 1,
        localExists: 1,
        downloaded: 0,
        notChecked: 0,
      },
      blockers: [
        'daily_supplement_research_only',
        'daily_supplement_not_promotion_grade',
      ],
    })

    const report = await runAiScientistOhlcvMaterialize({
      planPath,
      dailySupplementPlanPath,
      outputPath,
      reportPath,
      maxTasks: 10,
      maxRowsPerTask: 10,
      json: false,
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'research_rows_materialized_pit_blocked',
      sourceArtifacts: {
        dailySupplementPlan: dailySupplementPlanPath,
      },
      counts: {
        planTasksRead: 1,
        nativeMaterializationCandidateTasks: 0,
        dailySupplementTaskPlansRead: 1,
        dailySupplementCandidateTasks: 1,
        dailySupplementZipFiles: 1,
        materializationCandidateTasks: 1,
        tasksMaterialized: 1,
        zipFilesRead: 1,
        rowsWritten: 1,
        promotionGradeRows: 0,
      },
      blockers: expect.arrayContaining([
        'ohlcv_native_rows_research_only',
        'ohlcv_native_rows_not_promotion_grade',
        'row_pit_usable_for_promotion_false',
      ]),
    })

    const rows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      taskId: 'pit_rebuild.btc.daily',
      eventTime: '2026-05-01T00:00:00.000Z',
      sourceZipPath: zipPath,
      sourceZipMonth: '2026-05',
      availableAtBasis: 'archive_materialization_time_research_only_not_historical_decision_available_at',
      rowPITUsableForPromotion: false,
      quality: {
        promotionGrade: false,
        blockers: expect.arrayContaining([
          'archive_materialization_time_not_historical_decision_available_at',
          'research_only_not_execution_evidence',
        ]),
      },
    })
  })
})

async function makeZip(zipPath: string, name: string, content: string): Promise<void> {
  const dir = join(zipPath, '..')
  await mkdir(dir, { recursive: true })
  const csvPath = join(dir, name)
  await writeFile(csvPath, content, 'utf-8')
  await execFileAsync('zip', ['-j', basename(zipPath), basename(csvPath)], { cwd: dir })
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}
