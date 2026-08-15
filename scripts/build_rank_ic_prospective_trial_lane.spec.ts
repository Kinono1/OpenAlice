import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import { assertValidTrialRecord } from '../src/evidence/trial_registry.js'
import {
  buildRankIcProspectiveTrialLaneReport,
  parseRankIcProspectiveTrialLaneArgs,
  runRankIcProspectiveTrialLane,
} from './build_rank_ic_prospective_trial_lane.js'

describe('build_rank_ic_prospective_trial_lane', () => {
  it('parses defaults and keeps package script wired to explicit artifacts', () => {
    expect(parseRankIcProspectiveTrialLaneArgs([
      '--walkForward',
      'wf.json',
      '--routeCost',
      'route.json',
      '--output',
      'null',
      '--registryDraft',
      'draft.json',
      '--json',
      'true',
    ])).toEqual({
      walkForwardPath: 'wf.json',
      routeCostPath: 'route.json',
      outputPath: null,
      registryDraftPath: 'draft.json',
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:cross-sectional:prospective-lane:live-fwd72-median-filter']).toContain('rank_ic_walkforward_filter_validation.live_accumulated_fwd72.latest.json')
    expect(scripts['research:cross-sectional:prospective-lane:live-fwd72-median-filter']).toContain('rank_ic_route_cost_validation.live_accumulated_fwd72_median_filter.latest.json')
  })

  it('builds a prospective-only lane and appendable registry draft without enabling execution', () => {
    const report = buildRankIcProspectiveTrialLaneReport({
      generatedAt: '2026-05-05T05:00:00.000Z',
      walkForwardPath: '/repo/data/research/wf.json',
      routeCostPath: '/repo/data/research/route.json',
      walkForward: makeWalkForward(),
      routeCost: makeRouteCost(),
    })

    expect(report).toMatchObject({
      researchOnly: true,
      prospectiveOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      laneStatus: 'ready_for_future_collection',
      candidate: {
        strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
        filterId: 'median_return_gte_p33',
        factor: 'signal_confidence',
        forwardHours: 72,
        primaryMetric: 'route_cost_adjusted_long_short_spread_pct',
      },
      currentEvidence: {
        walkForwardVerdict: 'walk_forward_improved_candidate',
        walkForwardWfoStatus: 'fail',
        walkForwardPassedWindows: 2,
        walkForwardWindowCount: 4,
        netAfterRouteCostPct: 1.349672,
        feeSnapshotSource: 'manual_override',
        feeSnapshotVerifiedByRuntime: false,
      },
      prospectiveProtocol: {
        orderExecutionAllowed: false,
        requiresRuntimeVerifiedFees: true,
        requiresCompleteTrialUniverseBeforePromotion: true,
        requiresPitAuditBeforePromotion: true,
      },
    })

    expect(report.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'route_cost_adjusted_net', status: 'pass' }),
      expect.objectContaining({ code: 'walk_forward_wfo_status', status: 'blocked' }),
      expect.objectContaining({ code: 'runtime_fee_snapshot', status: 'blocked' }),
      expect.objectContaining({ code: 'future_trial_outcomes', status: 'blocked' }),
      expect.objectContaining({ code: 'complete_trial_universe', status: 'blocked' }),
      expect.objectContaining({ code: 'by_fdr_ready', status: 'blocked' }),
      expect.objectContaining({ code: 'pit_audit_ready', status: 'blocked' }),
    ]))
    expect(report.blockers).toEqual(expect.arrayContaining([
      'prospective_lane_not_execution_evidence',
      'paper_live_execution_disabled',
      'walk_forward_wfo_status:fail',
      'fee_snapshot_not_runtime_verified',
      'future_live_only_trial_outcomes_missing',
      'complete_trial_universe_missing',
      'by_fdr_not_ready',
      'pit_audit_not_ready',
    ]))
    expect(report.registryDraft).toMatchObject({
      trialType: 'diagnostic_factor',
      strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
      pValue: null,
      includedInFdr: false,
      promotionEligible: false,
      status: 'registered',
      failureCodes: expect.arrayContaining([
        'MISSING_LIVE_ONLY_EVIDENCE',
        'FDR_INPUTS_INCOMPLETE',
        'PIT_AUDIT_NOT_IMPLEMENTED',
        'COST_FRAGILE',
        'WFO_DEGRADED',
      ]),
      metadata: {
        prospective_only: true,
        order_execution_allowed: false,
        fdr_p_values_available: false,
        pit_audit_status: 'blocked',
      },
    })
    expect(() => assertValidTrialRecord(report.registryDraft!)).not.toThrow()
    expect(report.registryDraftJson).toMatchObject({
      trial_type: 'diagnostic_factor',
      included_in_fdr: false,
      promotion_eligible: false,
    })
  })

  it('writes the lane artifact and separate registry draft without mutating the runtime registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-prospective-lane-'))
    const wfPath = join(root, 'wf.json')
    const routePath = join(root, 'route.json')
    const outputPath = join(root, 'lane.json')
    const draftPath = join(root, 'draft.json')
    await mkdir(root, { recursive: true })
    await writeFile(wfPath, `${JSON.stringify(makeWalkForward())}\n`, 'utf-8')
    await writeFile(routePath, `${JSON.stringify(makeRouteCost())}\n`, 'utf-8')

    const report = await runRankIcProspectiveTrialLane({
      walkForwardPath: wfPath,
      routeCostPath: routePath,
      outputPath,
      registryDraftPath: draftPath,
      json: false,
    })

    expect(report.registryDraft).not.toBeNull()
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      prospectiveOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
    })
    const draft = JSON.parse(await readFile(draftPath, 'utf-8'))
    expect(draft).toMatchObject({
      included_in_fdr: false,
      promotion_eligible: false,
      metadata: {
        prospective_only: true,
      },
    })
  })
})

function makeWalkForward() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T04:41:00.000Z',
    researchOnly: true,
    promotionEligible: false,
    config: {
      lookbackHours: 120,
      secondaryLookbackHours: 336,
      forwardHours: 72,
      lookbackBars: 120,
      secondaryLookbackBars: 336,
      forwardBars: 72,
      mtfWeight: 0.5,
      factor: 'signal_confidence',
    },
    bestWalkForwardCandidate: {
      filterId: 'median_return_gte_p33',
      diagnosticVerdict: 'walk_forward_improved_candidate',
      aggregate: {
        observations: 13505,
        periods: 432,
        signalPeriods: 417,
        retainedPct: 0.683544,
        meanIc: 0.055734,
        icIr: 0.277431,
        averageLongShortSpreadPct: 1.88475,
      },
      wfo: {
        status: 'fail',
        windowCount: 4,
        passedWindows: 2,
        failedWindowRatio: 0.5,
      },
      windows: [{
        windowIndex: 1,
        startTime: '2026-04-05T20:00:00.000Z',
        endTime: '2026-04-12T09:00:00.000Z',
        trainWindowIndexes: [0],
        filter: {
          thresholds: {
            minMedianReturnPct: -1.744203,
          },
        },
        summary: {
          periods: 155,
          signalPeriods: 151,
          meanIc: -0.059659,
          icIr: -0.443178,
          averageLongShortSpreadPct: -0.77269,
        },
        passed: false,
        blockers: ['rank_ic_thresholds_not_passed'],
      }],
    },
    blockers: [
      'walk_forward_filter_diagnostic_only',
      'not_trial_ledger_fdr_validated',
      'not_runtime_fee_verified',
      'best_walk_forward_candidate_wfo_fail',
    ],
  }
}

function makeRouteCost() {
  return {
    schemaVersion: 1,
    generatedAt: '2026-05-05T04:41:30.000Z',
    researchOnly: true,
    promotionEligible: false,
    candidate: {
      candidateId: 'rank_ic_signal_confidence_best_lb120_sec336_fwd72_mtf0.5',
      factor: 'signal_confidence',
      forwardHours: 72,
    },
    routeCostValidationStatus: 'insufficient_data',
    bestDiagnosticRoute: {
      route: 'passive_passive',
      netAfterRouteCostPct: 1.349672,
      grossToPairCostRatio: 4.749089,
      positiveAfterCost: true,
    },
    feeSnapshot: {
      source: 'manual_override',
      verifiedByRuntime: false,
    },
    blockers: [
      'rank_ic_wfo_status:fail',
      'fee_snapshot_manual_override',
      'fee_snapshot_not_runtime_verified',
      'not_trial_ledger_fdr_validated',
      'not_paper_execution_evidence',
    ],
  }
}
