import { describe, expect, it } from 'vitest'
import {
  buildCrossSectionalRankIcReport,
  extractPreferredConfig,
  parseCrossSectionalRankIcArgs,
} from './build_cross_sectional_rank_ic_report.js'

function syntheticAssets() {
  const length = 900
  return ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'].map((symbol, assetIndex) => {
    const candles = Array.from({ length }, (_, index) => {
      const cycle = index % 48
      const drift = cycle < 24 ? assetIndex * 0.3 : (5 - assetIndex) * 0.3
      return {
        time: 1_700_000_000_000 + index * 3_600_000,
        close: 100 + index * 0.01 + drift,
        volume: 1_000_000 + assetIndex * 10_000,
      }
    })
    return { symbol, candles }
  })
}

describe('build_cross_sectional_rank_ic_report', () => {
  it('parses conservative research-only defaults', () => {
    expect(parseCrossSectionalRankIcArgs([
      '--dataDir',
      'tmp/data',
      '--output',
      'null',
      '--symbols',
      'BTC-USDT,ETH-USDT',
      '--bestConfig',
      'best.json',
      '--lookbacks',
      '24,48',
      '--forwards',
      '12',
      '--mtfWeights',
      '0,0.5',
      '--maxRows',
      '1000',
      '--json',
      'true',
    ])).toMatchObject({
      dataDir: 'tmp/data',
      outputPath: null,
      bestConfigPath: 'best.json',
      symbols: ['BTC-USDT', 'ETH-USDT'],
      lookbackHours: [24, 48],
      forwardHours: [12],
      mtfWeights: [0, 0.5],
      barMinutes: 60,
      executionMode: 'paper',
      maxRows: 1000,
      json: true,
    })
  })

  it('emits a research-only report and never authorizes execution', () => {
    const report = buildCrossSectionalRankIcReport({
      assets: syntheticAssets(),
      generatedAt: '2026-05-04T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/multi_assets',
        outputPath: null,
        bestConfigPath: null,
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
        lookbackHours: [24],
        secondaryLookbackHours: [48],
        forwardHours: [12],
        mtfWeights: [0],
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 6,
        executionMode: 'paper',
        barMinutes: 60,
        maxRows: null,
        regimeFilter: null,
        json: true,
      },
    })

    expect(report).toMatchObject({
      generatedAt: '2026-05-04T00:00:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      symbolsLoaded: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
      executionShape: {
        mode: 'paper',
        topN: 1,
        bottomN: 1,
        minUniverseSizePolicy: 'paper_half_universe_min_2',
        effectiveMinUniverseSizeAtFullUniverse: 3,
      },
      dataCadence: {
        barMinutes: 60,
        promotionTimeframe: '1h_required',
        nonHourlyDiagnosticOnly: false,
        lookbackUnit: 'hours',
        barConversion: [
          { hours: 12, bars: 12 },
          { hours: 24, bars: 24 },
          { hours: 48, bars: 48 },
        ],
      },
    })
    expect(report.configsEvaluated).toBe(4)
    expect(report.topConfigs.length).toBeGreaterThan(0)
    expect(report.wfo).toMatchObject({
      windowCount: expect.any(Number),
      selectionSource: 'rank_ic_best',
      passedWindows: expect.any(Number),
      failedWindows: expect.any(Number),
      failWindowRatioThreshold: 0.3,
      minWindows: 3,
      minTotalPeriods: 30,
      minTotalSignalPeriods: 30,
      minPeriodsPerWindow: 3,
      minSignalPeriodsPerWindow: 3,
      windows: expect.any(Array),
    })
    expect(['pass', 'fail', 'insufficient_data']).toContain(report.wfo.status)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_route_cost_validated',
      'not_paper_execution_evidence',
    ]))
  })

  it('uses best_config spread and volatility filters when selecting a preferred WFO candidate', () => {
    const report = buildCrossSectionalRankIcReport({
      assets: syntheticAssets(),
      generatedAt: '2026-05-04T00:00:00.000Z',
      preferredConfig: {
        lookbackHours: 24,
        secondaryLookbackHours: 48,
        forwardHours: 12,
        mtfWeight: 0,
        minSpreadPct: 50,
        maxVolPct: 99,
      },
      args: {
        dataDir: '/repo/data/market/multi_assets',
        outputPath: null,
        bestConfigPath: null,
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
        lookbackHours: [24],
        secondaryLookbackHours: [48],
        forwardHours: [12],
        mtfWeights: [0],
        maxVolPct: 80,
        minSpreadPct: 0,
        minUniverseSize: 6,
        executionMode: 'paper',
        barMinutes: 60,
        maxRows: null,
        regimeFilter: null,
        json: true,
      },
    })

    expect(report.wfo.selectionSource).toBe('best_config_match')
    expect(report.wfo.testedConfig?.signalPeriods).toBe(0)
    expect(report.wfo.blockers).toEqual(expect.arrayContaining([
      'wfo_total_signal_periods_low:0<30',
    ]))
  })

  it('ignores no-passing best_config artifacts instead of binding WFO to stale winners', () => {
    expect(extractPreferredConfig({
      status: 'no_passing_config',
      selectedConfig: false,
      config: null,
      noPassingConfigReason: 'optimizer_hard_gate_passed_count_zero',
    })).toBeNull()
  })

  it('keeps legacy thirds available when explicitly requested for comparison only', () => {
    const report = buildCrossSectionalRankIcReport({
      assets: syntheticAssets(),
      generatedAt: '2026-05-04T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/multi_assets',
        outputPath: null,
        bestConfigPath: null,
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
        lookbackHours: [24],
        secondaryLookbackHours: [48],
        forwardHours: [12],
        mtfWeights: [0],
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 6,
        executionMode: 'legacy_thirds',
        barMinutes: 60,
        maxRows: null,
        regimeFilter: null,
        json: true,
      },
    })

    expect(report.executionShape).toEqual({
      mode: 'legacy_thirds',
      topN: 2,
      bottomN: 2,
      minUniverseSizePolicy: 'legacy_thirds_cli_min',
      effectiveMinUniverseSizeAtFullUniverse: 6,
    })
  })

  it('applies decision-time regime filters while keeping filtered RankIC research-only', () => {
    const report = buildCrossSectionalRankIcReport({
      assets: syntheticAssets(),
      generatedAt: '2026-05-04T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/multi_assets',
        outputPath: null,
        bestConfigPath: null,
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
        lookbackHours: [24],
        secondaryLookbackHours: [48],
        forwardHours: [12],
        mtfWeights: [0],
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 6,
        executionMode: 'paper',
        barMinutes: 60,
        maxRows: null,
        regimeFilter: {
          id: 'test_positive_breadth',
          minMedianReturnPct: 0.228,
          maxMedianReturnPct: null,
          minBreadthPositivePct: null,
          maxDispersionPct: null,
          maxAverageVolPct: null,
          source: 'cli_thresholds',
        },
        json: true,
      },
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.regimeFilter).toMatchObject({
      enabled: true,
      diagnosticOnly: true,
      spec: {
        id: 'test_positive_breadth',
        minMedianReturnPct: 0.228,
      },
      policy: 'decision_time_observables_only',
      regimePeriodsEvaluated: expect.any(Number),
      retainedRegimePeriods: expect.any(Number),
    })
    expect(report.regimeFilter.retainedRegimePeriods ?? 0).toBeLessThan(report.regimeFilter.regimePeriodsEvaluated ?? 0)
    expect(report.best?.retainedRegimePct).toBe(report.regimeFilter.retainedRegimePct)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'regime_filter_in_sample_research_only',
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_route_cost_validated',
      'not_paper_execution_evidence',
    ]))
  })

  it('converts hour parameters to 5m bars while keeping non-hourly diagnostics blocked', () => {
    const length = 700
    const assets = ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'].map((symbol, assetIndex) => ({
      symbol,
      candles: Array.from({ length }, (_, index) => ({
        time: 1_700_000_000_000 + index * 5 * 60_000,
        close: 100 + index * 0.01 + assetIndex,
        volume: 1_000_000 + assetIndex * 10_000,
      })),
    }))
    const report = buildCrossSectionalRankIcReport({
      assets,
      generatedAt: '2026-05-04T00:00:00.000Z',
      args: {
        dataDir: '/repo/data/market/live_5m',
        outputPath: null,
        bestConfigPath: null,
        symbols: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
        lookbackHours: [12],
        secondaryLookbackHours: [24],
        forwardHours: [6],
        mtfWeights: [0],
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 6,
        executionMode: 'paper',
        barMinutes: 5,
        maxRows: null,
        regimeFilter: null,
        json: true,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      dataCadence: {
        barMinutes: 5,
        promotionTimeframe: '1h_required',
        nonHourlyDiagnosticOnly: true,
        lookbackUnit: 'hours',
        barConversion: [
          { hours: 6, bars: 72 },
          { hours: 12, bars: 144 },
          { hours: 24, bars: 288 },
        ],
      },
    })
    expect(report.best).toMatchObject({
      lookbackHours: 12,
      secondaryLookbackHours: 24,
      forwardHours: 6,
      lookbackBars: 144,
      secondaryLookbackBars: 288,
      forwardBars: 72,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'non_hourly_rank_ic_cadence_research_only',
      'not_promotion_grade_wfo_validated',
      'not_trial_ledger_fdr_validated',
      'not_route_cost_validated',
      'not_paper_execution_evidence',
    ]))
  })
})
