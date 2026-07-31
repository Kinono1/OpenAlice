import { describe, expect, it } from 'vitest'
import {
  buildRankIcRouteCostValidationReport,
  parseRankIcRouteCostValidationArgs,
} from './build_rank_ic_route_cost_validation.js'

describe('build_rank_ic_route_cost_validation', () => {
  it('parses conservative diagnostic-only defaults', () => {
    expect(parseRankIcRouteCostValidationArgs([
      '--rankIc',
      'rank_ic.json',
      '--routeCostBudget',
      'route_cost.json',
      '--feeSnapshot',
      'fee.json',
      '--bestConfig',
      'best.json',
      '--output',
      'null',
      '--json',
      'true',
    ])).toEqual({
      rankIcReportPath: 'rank_ic.json',
      routeCostBudgetPath: 'route_cost.json',
      feeSnapshotPath: 'fee.json',
      bestConfigPath: 'best.json',
      outputPath: null,
      asOf: null,
      json: true,
    })
  })

  it('keeps a positive gross RankIC candidate research-only when fee and WFO evidence are weak', () => {
    const report = buildRankIcRouteCostValidationReport({
      generatedAt: '2026-05-04T12:00:00.000Z',
      asOf: '2026-05-04T12:00:00.000Z',
      rankIcReportPath: '/repo/data/research/cross_sectional_rank_ic.latest.json',
      routeCostBudgetPath: '/repo/data/runtime/route_cost_budget.latest.json',
      feeSnapshotPath: '/repo/data/runtime/fee_snapshot.latest.json',
      rankIcReport: {
        commonPeriods: 396,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 48,
          mtfWeight: 0,
          observations: 176,
          periods: 10,
          signalPeriods: 10,
          meanIc: 0.504167,
          icIr: 2.11975,
          averageLongShortSpreadPct: 5.68661,
        },
        wfo: { status: 'insufficient_data' },
      },
      feeSnapshot: {
        source: 'manual_override',
        verifiedByRuntime: false,
        sourceFetchedAt: '2026-05-03T08:44:10.025Z',
        expiresAt: '2026-05-04T08:44:10.025Z',
        makerFeeBps: 2,
        takerFeeBps: 6,
      },
      routeCostBudget: {
        routes: {
          passive_passive: {
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 18,
          },
          taker_taker: {
            totalExpectedCostBps: 43,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 43,
          },
        },
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      routeCostValidationStatus: 'insufficient_data',
      candidate: {
        candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd48_mtf0',
        averageLongShortSpreadPct: 5.68661,
        wfoStatus: 'insufficient_data',
        selectionSource: 'rank_ic_best',
      },
      feeSnapshot: {
        source: 'manual_override',
        verifiedByRuntime: false,
        stale: true,
      },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        pairRoundTripCostBps: 36,
        pairRoundTripCostPct: 0.36,
        netAfterRouteCostPct: 5.32661,
        positiveAfterCost: true,
        diagnosticEligible: true,
      },
      blockers: expect.arrayContaining([
        'rank_ic_common_periods_low:396<1000',
        'rank_ic_periods_low:10<30',
        'rank_ic_signal_periods_low:10<30',
        'rank_ic_wfo_status:insufficient_data',
        'fee_snapshot_stale',
        'fee_snapshot_manual_override',
        'fee_snapshot_not_runtime_verified',
        'route_cost_budget_exceeded:taker_taker',
        'not_promotion_grade_route_cost_validated',
        'not_trial_ledger_fdr_validated',
        'not_paper_execution_evidence',
      ]),
    })
    expect(report.routes.find(route => route.route === 'taker_taker')).toMatchObject({
      pairRoundTripCostBps: 86,
      pairRoundTripCostPct: 0.86,
      netAfterRouteCostPct: 4.82661,
      routeBudgetExceeded: true,
    })
  })

  it('marks negative after-cost candidates when sample and fee evidence are otherwise usable', () => {
    const report = buildRankIcRouteCostValidationReport({
      generatedAt: '2026-05-04T12:00:00.000Z',
      asOf: '2026-05-04T12:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic.json',
      routeCostBudgetPath: '/repo/route_cost.json',
      feeSnapshotPath: '/repo/fee.json',
      rankIcReport: {
        commonPeriods: 1200,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 48,
          mtfWeight: 0,
          observations: 900,
          periods: 40,
          signalPeriods: 40,
          meanIc: 0.08,
          icIr: 1.2,
          averageLongShortSpreadPct: 0.2,
        },
        wfo: { status: 'pass' },
      },
      feeSnapshot: {
        source: 'runtime',
        verifiedByRuntime: true,
        sourceFetchedAt: '2026-05-04T11:55:00.000Z',
        expiresAt: '2026-05-04T13:00:00.000Z',
        makerFeeBps: 2,
        takerFeeBps: 6,
      },
      routeCostBudget: {
        routes: {
          passive_passive: {
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 18,
          },
        },
      },
    })

    expect(report.routeCostValidationStatus).toBe('negative_after_cost')
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.routes[0]).toMatchObject({
      route: 'passive_passive',
      pairRoundTripCostPct: 0.36,
      netAfterRouteCostPct: -0.16,
      positiveAfterCost: false,
      blockers: ['route_net_edge_non_positive:passive_passive'],
    })
  })

  it('keeps non-hourly RankIC candidates blocked even when route cost is positive', () => {
    const report = buildRankIcRouteCostValidationReport({
      generatedAt: '2026-05-04T12:00:00.000Z',
      asOf: '2026-05-04T12:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic_5m.json',
      routeCostBudgetPath: '/repo/route_cost.json',
      feeSnapshotPath: '/repo/fee.json',
      rankIcReport: {
        commonPeriods: 1200,
        dataCadence: {
          barMinutes: 5,
          promotionTimeframe: '1h_required',
          nonHourlyDiagnosticOnly: true,
        },
        best: {
          factor: 'raw_reversal',
          lookbackHours: 12,
          secondaryLookbackHours: 24,
          forwardHours: 6,
          mtfWeight: 0,
          observations: 900,
          periods: 40,
          signalPeriods: 40,
          meanIc: 0.08,
          icIr: 1.2,
          averageLongShortSpreadPct: 1.2,
        },
        wfo: { status: 'pass' },
      },
      feeSnapshot: {
        source: 'runtime',
        verifiedByRuntime: true,
        sourceFetchedAt: '2026-05-04T11:55:00.000Z',
        expiresAt: '2026-05-04T13:00:00.000Z',
        makerFeeBps: 2,
        takerFeeBps: 6,
      },
      routeCostBudget: {
        routes: {
          passive_passive: {
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 18,
          },
        },
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      routeCostValidationStatus: 'positive_after_cost_diagnostic',
      candidate: {
        barMinutes: 5,
        nonHourlyDiagnosticOnly: true,
        forwardHours: 6,
      },
      bestDiagnosticRoute: {
        route: 'passive_passive',
        netAfterRouteCostPct: 0.84,
        positiveAfterCost: true,
      },
      blockers: expect.arrayContaining([
        'non_hourly_rank_ic_cadence_research_only',
        'not_promotion_grade_route_cost_validated',
        'not_trial_ledger_fdr_validated',
        'not_paper_execution_evidence',
      ]),
    })
    expect(report.notes.join('\n')).toContain('Non-1h RankIC cadence')
  })

  it('prefers the paper best_config matched RankIC candidate over a tie-sorted RankIC best row', () => {
    const report = buildRankIcRouteCostValidationReport({
      generatedAt: '2026-05-04T12:00:00.000Z',
      asOf: '2026-05-04T12:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic.json',
      routeCostBudgetPath: '/repo/route_cost.json',
      feeSnapshotPath: '/repo/fee.json',
      bestConfigPath: '/repo/best_config.json',
      rankIcReport: {
        commonPeriods: 1200,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 336,
          secondaryLookbackHours: 336,
          forwardHours: 24,
          mtfWeight: 0,
          observations: 1666,
          periods: 50,
          signalPeriods: 50,
          meanIc: 0.063917,
          icIr: 0.310493,
          averageLongShortSpreadPct: 0.234009,
        },
        topConfigs: [
          {
            factor: 'raw_reversal',
            lookbackHours: 336,
            secondaryLookbackHours: 336,
            forwardHours: 24,
            mtfWeight: 0,
            observations: 1666,
            periods: 50,
            signalPeriods: 50,
            meanIc: 0.063917,
            icIr: 0.310493,
            averageLongShortSpreadPct: 0.234009,
          },
          {
            factor: 'raw_reversal',
            lookbackHours: 336,
            secondaryLookbackHours: 336,
            forwardHours: 24,
            mtfWeight: 0.5,
            observations: 1666,
            periods: 50,
            signalPeriods: 50,
            meanIc: 0.063917,
            icIr: 0.310493,
            averageLongShortSpreadPct: 0.234009,
          },
        ],
        wfo: { status: 'fail' },
      },
      bestConfig: {
        config: {
          lookbackHours: 336,
          secondaryLookback: 336,
          forwardHours: 24,
          mtfWeight: 0.5,
        },
      },
      feeSnapshot: {
        source: 'runtime',
        verifiedByRuntime: true,
        sourceFetchedAt: '2026-05-04T11:55:00.000Z',
        expiresAt: '2026-05-04T13:00:00.000Z',
      },
      routeCostBudget: {
        routes: {
          passive_passive: {
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 18,
          },
        },
      },
    })

    expect(report.candidate).toMatchObject({
      candidateId: 'rank_ic_raw_reversal_best_lb336_sec336_fwd24_mtf0.5',
      mtfWeight: 0.5,
      selectionSource: 'best_config_match',
    })
  })

  it('uses the highest gross-spread passing candidate for route-cost diagnostics when no best_config is active', () => {
    const report = buildRankIcRouteCostValidationReport({
      generatedAt: '2026-05-04T12:00:00.000Z',
      asOf: '2026-05-04T12:00:00.000Z',
      rankIcReportPath: '/repo/rank_ic.json',
      routeCostBudgetPath: '/repo/route_cost.json',
      feeSnapshotPath: '/repo/fee.json',
      bestConfigPath: '/repo/best_config.json',
      rankIcReport: {
        commonPeriods: 1200,
        best: {
          factor: 'raw_reversal',
          lookbackHours: 240,
          secondaryLookbackHours: 336,
          forwardHours: 72,
          mtfWeight: 0,
          observations: 102,
          periods: 3,
          signalPeriods: 3,
          meanIc: 0.304304,
          icIr: 3.992814,
          averageLongShortSpreadPct: -1.504664,
        },
        topConfigs: [
          {
            factor: 'raw_reversal',
            lookbackHours: 240,
            secondaryLookbackHours: 336,
            forwardHours: 72,
            mtfWeight: 0,
            observations: 102,
            periods: 3,
            signalPeriods: 3,
            meanIc: 0.304304,
            icIr: 3.992814,
            averageLongShortSpreadPct: -1.504664,
            passed: true,
          },
          {
            factor: 'raw_reversal',
            lookbackHours: 240,
            secondaryLookbackHours: 336,
            forwardHours: 72,
            mtfWeight: 0.5,
            observations: 102,
            periods: 3,
            signalPeriods: 3,
            meanIc: 0.304304,
            icIr: 3.992814,
            averageLongShortSpreadPct: 11.736377,
            passed: true,
          },
        ],
        wfo: { status: 'insufficient_data' },
      },
      bestConfig: {
        status: 'no_passing_config',
        selectedConfig: false,
        config: null,
      },
      feeSnapshot: {
        source: 'api',
        verifiedByRuntime: true,
        sourceFetchedAt: '2026-05-04T11:55:00.000Z',
        expiresAt: '2026-05-04T13:00:00.000Z',
      },
      routeCostBudget: {
        routes: {
          passive_passive: {
            totalExpectedCostBps: 18,
            maxAllowedCostBps: 20,
            breakEvenEdgeBps: 18,
          },
        },
      },
    })

    expect(report.candidate).toMatchObject({
      candidateId: 'rank_ic_raw_reversal_best_lb240_sec336_fwd72_mtf0.5',
      mtfWeight: 0.5,
      averageLongShortSpreadPct: 11.736377,
      selectionSource: 'rank_ic_economic_best',
    })
    expect(report.bestDiagnosticRoute).toMatchObject({
      route: 'passive_passive',
      netAfterRouteCostPct: 11.376377,
      positiveAfterCost: true,
    })
    expect(report.routeCostValidationStatus).toBe('insufficient_data')
  })
})
