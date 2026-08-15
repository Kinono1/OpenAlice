import { describe, expect, it } from 'vitest'
import {
  buildFilteredRankIcCandidateReport,
  parseFilteredRankIcExportArgs,
} from './export_filtered_rank_ic_candidate.js'

const baseSweep = {
  dataDir: '/tmp/live',
  barMinutes: 60,
  symbolsLoaded: ['BTC-USDT', 'ETH-USDT'],
  dataAlignment: { loadedCommonPeriods: 1200 },
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
  candidates: [{}, {}],
  baseline: {
    filter: {
      id: 'no_filter',
      description: 'baseline',
      thresholds: {},
      generatedFrom: 'baseline',
    },
    summary: {
      observations: 100,
      periods: 20,
      signalPeriods: 18,
      meanIc: 0.02,
      icIr: 0.1,
      winRate: 0.5,
      passed: false,
      averageLongShortSpreadPct: 1.5,
      longShortWinRate: 0.55,
    },
    wfo: {
      status: 'fail',
      windowCount: 3,
      passedWindows: 1,
      failedWindows: 2,
      failedWindowRatio: 0.666667,
      failWindowRatioThreshold: 0.3,
      directionStable: false,
      windows: [],
      blockers: ['wfo_failed_window_ratio:0.666667>0.3'],
    },
    warnings: ['internal_wfo_fail'],
  },
}

describe('export_filtered_rank_ic_candidate', () => {
  it('parses route-cost-compatible export defaults', () => {
    expect(parseFilteredRankIcExportArgs([])).toEqual({
      filterSweepPath: 'data/research/rank_ic_regime_filter_sweep.live_accumulated_fwd72.latest.json',
      outputPath: 'data/research/cross_sectional_rank_ic.filtered_candidate.latest.json',
      json: false,
    })
  })

  it('exports an improved filtered candidate without enabling promotion', () => {
    const report = buildFilteredRankIcCandidateReport({
      filterSweepPath: '/tmp/filter.json',
      generatedAt: '2026-01-02T00:00:00.000Z',
      filterSweep: {
        ...baseSweep,
        bestDiagnosticCandidate: {
          filter: {
            id: 'median_return_gte_p33',
            description: 'keep stronger regimes',
            thresholds: { minMedianReturnPct: -0.7 },
            generatedFrom: 'in_sample_regime_quantile',
          },
          summary: {
            observations: 200,
            periods: 60,
            signalPeriods: 58,
            meanIc: 0.05,
            icIr: 0.27,
            winRate: 0.56,
            passed: false,
            averageLongShortSpreadPct: 1.7,
            longShortWinRate: 0.58,
          },
          wfo: {
            status: 'fail',
            windowCount: 5,
            passedWindows: 2,
            failedWindows: 3,
            failedWindowRatio: 0.6,
            failWindowRatioThreshold: 0.3,
            directionStable: false,
            windows: [],
            blockers: ['wfo_failed_window_ratio:0.6>0.3'],
          },
          warnings: ['filter_thresholds_fit_in_sample', 'internal_wfo_fail'],
        },
      },
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.selectedFilter?.id).toBe('median_return_gte_p33')
    expect(report.commonPeriods).toBe(1200)
    expect(report.best).toMatchObject({
      factor: 'signal_confidence',
      lookbackHours: 120,
      forwardHours: 72,
      observations: 200,
      periods: 60,
      signalPeriods: 58,
      averageLongShortSpreadPct: 1.7,
      filterId: 'median_return_gte_p33',
    })
    expect(report.wfo).toMatchObject({
      status: 'fail',
      selectionSource: 'filtered_regime_sweep_best_diagnostic',
      passedWindows: 2,
      failedWindows: 3,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_promotion_evidence',
      'filtered_candidate_in_sample_overfit_risk',
      'filter_warning:filter_thresholds_fit_in_sample',
      'rank_ic_wfo_status:fail',
    ]))
  })

  it('falls back to baseline when no improved filter exists and records that blocker', () => {
    const report = buildFilteredRankIcCandidateReport({
      filterSweepPath: '/tmp/filter.json',
      filterSweep: baseSweep,
      generatedAt: '2026-01-02T00:00:00.000Z',
    })

    expect(report.selectedFilter?.id).toBe('no_filter')
    expect(report.wfo).toMatchObject({
      selectionSource: 'filtered_regime_sweep_baseline_fallback',
      status: 'fail',
    })
    expect(report.blockers).toContain('no_improved_wfo_filter_candidate')
  })
})
