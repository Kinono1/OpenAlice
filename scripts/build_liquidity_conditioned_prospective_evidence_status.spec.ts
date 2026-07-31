import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildLiquidityConditionedProspectiveEvidenceStatusReport,
  parseLiquidityConditionedProspectiveEvidenceStatusArgs,
  runLiquidityConditionedProspectiveEvidenceStatus,
} from './build_liquidity_conditioned_prospective_evidence_status.js'

describe('build_liquidity_conditioned_prospective_evidence_status', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseLiquidityConditionedProspectiveEvidenceStatusArgs([
      '--ledger',
      'obs.jsonl',
      '--output',
      'null',
      '--asOf',
      '2026-05-08T03:00:00.000Z',
      '--minClosedOutcomes',
      '7',
      '--json',
      'true',
    ])).toMatchObject({
      ledgerPath: 'obs.jsonl',
      outputPath: null,
      asOfMs: Date.parse('2026-05-08T03:00:00.000Z'),
      minClosedOutcomes: 7,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:liquidity-conditioned:prospective-evidence:status']).toContain('build_liquidity_conditioned_prospective_evidence_status.ts')
    expect(scripts['research:liquidity-conditioned:prospective-evidence:status']).toContain('liquidity_conditioned_prospective_observations.live_accumulated.jsonl')
  })

  it('reports collecting state for open pending observations without promotion eligibility', () => {
    const open = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-08T03:00:00.000Z')
    const report = buildLiquidityConditionedProspectiveEvidenceStatusReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      ledgerPath: '/repo/obs.jsonl',
      ledgerExists: true,
      openEvents: [open],
      closedEvents: [],
      asOfMs: Date.parse('2026-05-06T03:00:00.000Z'),
      thresholds: {
        minClosedOutcomes: 100,
        minNonOverlappingWindows: 3,
        requireRuntimeVerifiedFees: true,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      prospectiveOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'collecting',
      counts: {
        openEvents: 1,
        closedEvents: 0,
        pendingOpenEvents: 1,
        dueOpenEventsWithoutClose: 0,
        openDecisionWindows: 1,
        closedDecisionWindows: 0,
      },
      metrics: {
        closedOutcomes: 0,
        meanGrossLongShortSpreadPct: null,
        winRatePct: null,
        meanOpenEventsPerDecisionWindow: 1,
      },
      latestOpen: {
        observationId: 'obs-1',
        signalPair: 'AAA-USDT/BBB-USDT',
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'prospective_closed_outcomes_low:0<100',
      'prospective_closed_windows_low:0<3',
      'prospective_route_cost_adjusted_labels_missing',
      'runtime_fee_not_verified',
    ]))
  })

  it('summarizes closed labels while keeping route-cost and promotion blockers', () => {
    const open1 = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-05T06:00:00.000Z')
    const open2 = makeOpen('obs-2', '2026-05-06T03:00:00.000Z', '2026-05-06T06:00:00.000Z')
    const closed1 = makeClosed(open1, 12)
    const closed2 = makeClosed(open2, -4)
    const report = buildLiquidityConditionedProspectiveEvidenceStatusReport({
      generatedAt: '2026-05-07T06:00:00.000Z',
      ledgerPath: '/repo/obs.jsonl',
      ledgerExists: true,
      openEvents: [open1, open2],
      closedEvents: [closed1, closed2],
      asOfMs: Date.parse('2026-05-07T06:00:00.000Z'),
      thresholds: {
        minClosedOutcomes: 2,
        minNonOverlappingWindows: 2,
        requireRuntimeVerifiedFees: true,
      },
    })

    expect(report).toMatchObject({
      status: 'has_closed_labels',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        openEvents: 2,
        closedEvents: 2,
        pendingOpenEvents: 0,
        dueOpenEventsWithoutClose: 0,
        closedMatchedToOpen: 2,
        openDecisionWindows: 2,
        closedDecisionWindows: 2,
      },
      metrics: {
        closedOutcomes: 2,
        meanGrossLongShortSpreadPct: 4,
        medianGrossLongShortSpreadPct: 4,
        winRatePct: 50,
        positiveGrossOutcomes: 1,
        negativeGrossOutcomes: 1,
        bestGrossLongShortSpreadPct: 12,
        worstGrossLongShortSpreadPct: -4,
        meanOpenEventsPerDecisionWindow: 1,
      },
      latestClosed: {
        observationId: 'obs-2',
        grossLongShortSpreadPct: -4,
        longOutperformedShort: false,
      },
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'prospective_route_cost_adjusted_labels_missing',
      'runtime_fee_not_verified',
      'not_paper_execution_evidence',
    ]))
    expect(report.blockers).not.toContain('prospective_closed_outcomes_low:2<2')
  })

  it('reads a ledger, writes status artifact, and remains research-only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-liquidity-prospective-status-'))
    const ledgerPath = join(root, 'obs.jsonl')
    const outputPath = join(root, 'status.json')
    const open = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-05T06:00:00.000Z')
    const closed = makeClosed(open, 9)
    await mkdir(root, { recursive: true })
    await writeFile(ledgerPath, `${JSON.stringify(open)}\n${JSON.stringify(closed)}\n`, 'utf-8')

    const report = await runLiquidityConditionedProspectiveEvidenceStatus({
      ledgerPath,
      outputPath,
      asOfMs: Date.parse('2026-05-06T06:00:00.000Z'),
      minClosedOutcomes: 10,
      minNonOverlappingWindows: 3,
      requireRuntimeVerifiedFees: true,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'has_closed_labels',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      metrics: {
        closedOutcomes: 1,
        meanGrossLongShortSpreadPct: 9,
      },
    })
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'has_closed_labels',
    })
  })

  it('reports correlated same-decision observations as one decision window', () => {
    const open1 = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-05T06:00:00.000Z')
    const open2 = makeOpen('obs-2', '2026-05-05T03:00:00.000Z', '2026-05-05T06:00:00.000Z')
    const report = buildLiquidityConditionedProspectiveEvidenceStatusReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      ledgerPath: '/repo/obs.jsonl',
      ledgerExists: true,
      openEvents: [open1, open2],
      closedEvents: [],
      asOfMs: Date.parse('2026-05-05T04:00:00.000Z'),
      thresholds: {
        minClosedOutcomes: 100,
        minNonOverlappingWindows: 3,
        requireRuntimeVerifiedFees: true,
      },
    })

    expect(report).toMatchObject({
      counts: {
        openEvents: 2,
        openDecisionWindows: 1,
      },
      metrics: {
        meanOpenEventsPerDecisionWindow: 2,
      },
    })
    expect(report.notes.join(' ')).toContain('same decisionBarTime')
  })
})

function makeOpen(
  observationId: string,
  decisionTime: string,
  labelDueTime: string,
) {
  return {
    schemaVersion: 1,
    eventType: 'liquidity_conditioned_prospective_decision_open',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId,
    candidateId: 'liq_high_reversal_lb168_fwd72',
    strategyFamily: 'liquidity_conditioned_momentum_reversal',
    strategy: 'high_reversal',
    decisionTime,
    decisionBarTime: Date.parse(decisionTime),
    labelDueTime,
    labelDueBarTime: Date.parse(labelDueTime),
    labelDelayHours: 3,
    dataWatermark: decisionTime,
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

function makeClosed(open: ReturnType<typeof makeOpen>, grossSpread: number) {
  const closeBarTime = open.labelDueBarTime + 3 * 60 * 60 * 1000
  return {
    schemaVersion: 1,
    eventType: 'liquidity_conditioned_prospective_decision_closed',
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: open.observationId,
    outcomeId: `${open.observationId}-closed`,
    candidateId: open.candidateId,
    strategyFamily: open.strategyFamily,
    strategy: open.strategy,
    decisionTime: open.decisionTime,
    decisionBarTime: open.decisionBarTime,
    labelDueTime: open.labelDueTime,
    labelDueBarTime: open.labelDueBarTime,
    closeTime: new Date(closeBarTime).toISOString(),
    closeBarTime,
    labelDelayHours: 3,
    long: {
      symbol: 'AAA-USDT',
      entryPrice: 100,
      closePrice: 100 + grossSpread,
      returnPct: grossSpread,
    },
    short: {
      symbol: 'BBB-USDT',
      entryPrice: 100,
      closePrice: 100,
      spotReturnPct: 0,
      shortReturnPct: 0,
    },
    label: {
      grossLongShortSpreadPct: grossSpread,
      longOutperformedShort: grossSpread > 0,
      routeCostAdjusted: false,
      routeCostAdjustedNetPct: null,
      routeCostAdjustmentStatus: 'blocked_runtime_fee_not_verified',
    },
    blockers: [
      'prospective_outcome_not_execution_evidence',
      'paper_live_execution_disabled',
      'runtime_fee_not_verified',
      'route_cost_adjusted_label_missing',
    ],
    sourceOpenEvent: {
      dataWatermark: open.dataWatermark,
      filterAllowed: true,
      signalPairPending: true,
      liquidityBucket: open.config.liquidityBucket,
    },
  }
}
