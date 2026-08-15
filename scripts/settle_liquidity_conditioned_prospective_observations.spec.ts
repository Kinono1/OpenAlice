import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildLiquidityConditionedProspectiveObservationSettleReport,
  parseLiquidityConditionedProspectiveObservationSettleArgs,
  runLiquidityConditionedProspectiveObservationSettle,
} from './settle_liquidity_conditioned_prospective_observations.js'

describe('settle_liquidity_conditioned_prospective_observations', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseLiquidityConditionedProspectiveObservationSettleArgs([
      '--ledger',
      'obs.jsonl',
      '--output',
      'null',
      '--asOf',
      '2026-05-08T03:00:00.000Z',
      '--dryRun',
      'false',
      '--json',
      'true',
    ])).toMatchObject({
      ledgerPath: 'obs.jsonl',
      outputPath: null,
      asOfMs: Date.parse('2026-05-08T03:00:00.000Z'),
      dryRun: false,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:liquidity-conditioned:prospective-observation:settle']).toContain('settle_liquidity_conditioned_prospective_observations.ts')
    expect(scripts['research:liquidity-conditioned:prospective-observation:settle']).toContain('liquidity_conditioned_prospective_observations.live_accumulated.jsonl')
  })

  it('leaves not-yet-due observations open without creating outcomes', async () => {
    const report = await buildLiquidityConditionedProspectiveObservationSettleReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      ledgerPath: '/repo/obs.jsonl',
      dataDir: '/repo/market',
      outputPath: null,
      openEvents: [makeOpenEvent()],
      closedEvents: [],
      args: {
        barMinutes: 60,
        asOfMs: Date.parse('2026-05-05T05:00:00.000Z'),
        maxOutcomes: null,
        dryRun: true,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
      counts: {
        openEventsLoaded: 1,
        dueOpenEvents: 0,
        notDueOpenEvents: 1,
        outcomesBuilt: 0,
      },
    })
    expect(report.blockers).toContain('prospective_observation_ledger_missing')
  })

  it('settles due observations into research-only gross labels and appends idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-liquidity-prospective-settle-'))
    const dataDir = join(root, 'market')
    const ledgerPath = join(root, 'obs.jsonl')
    const outputPath = join(root, 'settle.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(ledgerPath, `${JSON.stringify(makeOpenEvent())}\n`, 'utf-8')
    await writeFile(join(dataDir, 'AAA_USDT_USDT_1h.csv'), toCsv('AAA-USDT', [
      ['2026-05-05T03:00:00.000Z', 100],
      ['2026-05-05T06:00:00.000Z', 111],
    ]), 'utf-8')
    await writeFile(join(dataDir, 'BBB_USDT_USDT_1h.csv'), toCsv('BBB-USDT', [
      ['2026-05-05T03:00:00.000Z', 100],
      ['2026-05-05T06:00:00.000Z', 92],
    ]), 'utf-8')

    const first = await runLiquidityConditionedProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      outputPath,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T06:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })
    const second = await runLiquidityConditionedProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      outputPath,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T06:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })

    expect(first).toMatchObject({
      status: 'settled',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        dueOpenEvents: 1,
        outcomesBuilt: 1,
        appendedOutcomes: 1,
      },
      outcomes: [expect.objectContaining({
        eventType: 'liquidity_conditioned_prospective_decision_closed',
        paperTradingAllowed: false,
        liveTradingAllowed: false,
        label: expect.objectContaining({
          grossLongShortSpreadPct: 19,
          longOutperformedShort: true,
          routeCostAdjusted: false,
          routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified',
        }),
        blockers: expect.arrayContaining([
          'prospective_outcome_not_execution_evidence',
          'runtime_fee_not_verified',
        ]),
      })],
    })
    expect(second).toMatchObject({
      status: 'nothing_due',
      counts: {
        openEventsLoaded: 1,
        closedEventsLoaded: 1,
        openEventsConsidered: 0,
        outcomesBuilt: 0,
        appendedOutcomes: 0,
      },
    })
    const lines = (await readFile(ledgerPath, 'utf-8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      status: 'nothing_due',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
  })
})

function makeOpenEvent() {
  return {
    schemaVersion: 1,
    eventType: 'liquidity_conditioned_prospective_decision_open',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: 'obs_1',
    candidateId: 'liq_high_reversal_lb168_fwd72',
    strategyFamily: 'liquidity_conditioned_momentum_reversal',
    strategy: 'high_reversal',
    decisionTime: '2026-05-05T03:00:00.000Z',
    decisionBarTime: Date.parse('2026-05-05T03:00:00.000Z'),
    labelDueTime: '2026-05-05T06:00:00.000Z',
    labelDueBarTime: Date.parse('2026-05-05T06:00:00.000Z'),
    labelDelayHours: 3,
    dataWatermark: '2026-05-05T03:00:00.000Z',
    dataDir: '/repo/market',
    config: {
      liquidityBucket: 'high',
      factor: 'reversal',
      lookbackHours: 168,
      forwardHours: 72,
      lookbackBars: 168,
      forwardBars: 72,
      routeCostPct: 0.36,
      topBottomFraction: 0.2,
      minUniverseSize: 2,
      minBucketAssets: 1,
      barMinutes: 60,
    },
    liquiditySnapshot: {
      metric: 'trailing_24h_daily_volume_usd',
      totalAssetsAtDecision: 2,
      bucketAssetsAtDecision: 2,
      bucket: 'high',
      minBucketAssets: 1,
      lowEnd: 1,
      highStart: 1,
      minBucketVolumeUsd: 100,
      maxBucketVolumeUsd: 200,
    },
    signalPair: {
      long: {
        symbol: 'AAA-USDT',
        side: 'long',
        currentPrice: 100,
        lookbackReturnPct: -20,
        factorValue: 20,
        dailyVolumeUsd: 200,
        rank: 1,
      },
      short: {
        symbol: 'BBB-USDT',
        side: 'short',
        currentPrice: 100,
        lookbackReturnPct: 10,
        factorValue: -10,
        dailyVolumeUsd: 100,
        rank: 2,
      },
      labelStatus: 'pending_future_close',
    },
    rankSnapshot: [],
    currentEvidence: {
      candidateVerdict: 'incubate_observation',
      wfoStatus: 'fail',
      wfoFailedWindowRatio: 0.6,
      wfoPassedWindows: 2,
      wfoWindowCount: 5,
      meanIc: 0.04925,
      icIr: 0.144898,
      averageLongShortSpreadPct: 2.95443,
      longShortWinRate: 0.596455,
      netAfterManualRouteCostPct: 2.59443,
      routeCostSource: 'manual_diagnostic_override',
      routeCostRuntimeVerified: false,
    },
    blockers: [
      'liquidity_conditioned_prospective_observation_not_execution_evidence',
      'paper_live_execution_disabled',
      'future_label_pending',
      'runtime_fee_not_verified',
    ],
    notes: [],
  }
}

function toCsv(symbol: string, rows: Array<[string, number]>): string {
  const lines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
  for (const [iso, close] of rows) {
    const ts = Date.parse(iso)
    lines.push([
      ts,
      iso,
      close,
      close,
      close,
      close,
      1000,
      symbol.replace('-', '_'),
      '1h',
      'okx',
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}
