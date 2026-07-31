import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { RankIcProspectiveObservationEvent } from './capture_rank_ic_prospective_observation.js'
import {
  buildRankIcProspectiveObservationSettleReport,
  parseRankIcProspectiveObservationSettleArgs,
  runRankIcProspectiveObservationSettle,
} from './settle_rank_ic_prospective_observations.js'

describe('settle_rank_ic_prospective_observations', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseRankIcProspectiveObservationSettleArgs([
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
    expect(scripts['research:cross-sectional:prospective-observation:settle']).toContain('settle_rank_ic_prospective_observations.ts')
    expect(scripts['research:cross-sectional:prospective-observation:settle']).toContain('rank_ic_prospective_observations.live_accumulated_fwd72_median_filter.jsonl')
  })

  it('leaves not-yet-due observations open without creating outcomes', async () => {
    const report = await buildRankIcProspectiveObservationSettleReport({
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
    const root = await mkdtemp(join(tmpdir(), 'oa-prospective-settle-'))
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

    const first = await runRankIcProspectiveObservationSettle({
      ledgerPath,
      dataDir,
      outputPath,
      barMinutes: 60,
      asOfMs: Date.parse('2026-05-05T06:00:00.000Z'),
      maxOutcomes: null,
      dryRun: false,
      json: false,
    })
    const second = await runRankIcProspectiveObservationSettle({
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
        eventType: 'prospective_decision_closed',
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

function makeOpenEvent(): RankIcProspectiveObservationEvent {
  return {
    schemaVersion: 1,
    eventType: 'prospective_decision_open',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: 'obs_1',
    laneId: 'lane_1',
    candidateId: 'candidate_1',
    strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
    filterId: 'median_return_gte_p33',
    decisionTime: '2026-05-05T03:00:00.000Z',
    decisionBarTime: Date.parse('2026-05-05T03:00:00.000Z'),
    labelDueTime: '2026-05-05T06:00:00.000Z',
    labelDueBarTime: Date.parse('2026-05-05T06:00:00.000Z'),
    labelDelayHours: 3,
    dataWatermark: '2026-05-05T03:00:00.000Z',
    dataDir: '/repo/market',
    config: {
      lookbackHours: 2,
      secondaryLookbackHours: 4,
      forwardHours: 3,
      lookbackBars: 2,
      secondaryLookbackBars: 4,
      forwardBars: 3,
      mtfWeight: 0.5,
      factor: 'signal_confidence',
    },
    filter: {
      filterId: 'median_return_gte_p33',
      description: 'test',
      thresholds: { minMedianReturnPct: -100 },
      thresholdSource: 'latest_walk_forward_validation_window',
      allowed: true,
    },
    regime: null,
    universe: {
      symbolsLoaded: ['AAA-USDT', 'BBB-USDT'],
      assetsAtDecision: 2,
      executionMode: 'paper',
      topN: 1,
      bottomN: 1,
      minUniverseSize: 2,
    },
    signalPair: {
      long: {
        symbol: 'AAA-USDT',
        side: 'long',
        currentPrice: 100,
        rank: 1,
        confidence: 0.7,
        factorValue: 0.7,
      },
      short: {
        symbol: 'BBB-USDT',
        side: 'short',
        currentPrice: 100,
        rank: 2,
        confidence: 0.7,
        factorValue: -0.7,
      },
      labelStatus: 'pending_future_close',
    },
    rankSnapshot: [],
    currentEvidence: {
      walkForwardWfoStatus: 'fail',
      walkForwardPassedWindows: 2,
      walkForwardWindowCount: 4,
      walkForwardFailedWindowRatio: 0.5,
      meanIc: 0.055734,
      icIr: 0.277431,
      netAfterRouteCostPct: 1.349672,
      feeSnapshotSource: 'manual_override',
      feeSnapshotVerifiedByRuntime: false,
    },
    blockers: [
      'prospective_observation_not_execution_evidence',
      'paper_live_execution_disabled',
      'future_label_pending',
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
