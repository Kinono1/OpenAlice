import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import type { RankIcProspectiveObservationEvent } from './capture_rank_ic_prospective_observation.js'
import type { RankIcProspectiveObservationOutcome } from './settle_rank_ic_prospective_observations.js'
import {
  buildRankIcProspectiveEvidenceStatusReport,
  parseRankIcProspectiveEvidenceStatusArgs,
  runRankIcProspectiveEvidenceStatus,
} from './build_rank_ic_prospective_evidence_status.js'

describe('build_rank_ic_prospective_evidence_status', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseRankIcProspectiveEvidenceStatusArgs([
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
    expect(scripts['research:cross-sectional:prospective-evidence:status']).toContain('build_rank_ic_prospective_evidence_status.ts')
    expect(scripts['research:cross-sectional:prospective-evidence:status']).toContain('rank_ic_prospective_observations.live_accumulated_fwd72_median_filter.jsonl')
  })

  it('reports collecting state for open pending observations without promotion eligibility', () => {
    const open = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-08T03:00:00.000Z')
    const report = buildRankIcProspectiveEvidenceStatusReport({
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
      },
      metrics: {
        closedOutcomes: 0,
        meanGrossLongShortSpreadPct: null,
        winRatePct: null,
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
    const report = buildRankIcProspectiveEvidenceStatusReport({
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
    const root = await mkdtemp(join(tmpdir(), 'oa-prospective-status-'))
    const ledgerPath = join(root, 'obs.jsonl')
    const outputPath = join(root, 'status.json')
    const open = makeOpen('obs-1', '2026-05-05T03:00:00.000Z', '2026-05-05T06:00:00.000Z')
    const closed = makeClosed(open, 9)
    await mkdir(root, { recursive: true })
    await writeFile(ledgerPath, `${JSON.stringify(open)}\n${JSON.stringify(closed)}\n`, 'utf-8')

    const report = await runRankIcProspectiveEvidenceStatus({
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
})

function makeOpen(
  observationId: string,
  decisionTime: string,
  labelDueTime: string,
): RankIcProspectiveObservationEvent {
  return {
    schemaVersion: 1,
    eventType: 'prospective_decision_open',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId,
    laneId: 'lane_1',
    candidateId: 'candidate_1',
    strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
    filterId: 'median_return_gte_p33',
    decisionTime,
    decisionBarTime: Date.parse(decisionTime),
    labelDueTime,
    labelDueBarTime: Date.parse(labelDueTime),
    labelDelayHours: 3,
    dataWatermark: decisionTime,
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

function makeClosed(
  open: RankIcProspectiveObservationEvent,
  grossLongShortSpreadPct: number,
): RankIcProspectiveObservationOutcome {
  return {
    schemaVersion: 1,
    eventType: 'prospective_decision_closed',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    observationId: open.observationId,
    outcomeId: `${open.observationId}_closed`,
    laneId: open.laneId,
    candidateId: open.candidateId,
    strategyFamily: open.strategyFamily,
    filterId: open.filterId,
    decisionTime: open.decisionTime,
    decisionBarTime: open.decisionBarTime,
    labelDueTime: open.labelDueTime,
    labelDueBarTime: open.labelDueBarTime,
    closeTime: open.labelDueTime,
    closeBarTime: open.labelDueBarTime,
    labelDelayHours: open.labelDelayHours,
    long: {
      symbol: 'AAA-USDT',
      entryPrice: 100,
      closePrice: 100 + grossLongShortSpreadPct,
      returnPct: grossLongShortSpreadPct,
    },
    short: {
      symbol: 'BBB-USDT',
      entryPrice: 100,
      closePrice: 100,
      spotReturnPct: 0,
      shortReturnPct: 0,
    },
    label: {
      grossLongShortSpreadPct,
      longOutperformedShort: grossLongShortSpreadPct > 0,
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
    },
  }
}
