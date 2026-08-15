import { describe, expect, it } from 'vitest'
import {
  buildRankIcWalkForwardFilterValidationReport,
  parseRankIcWalkForwardFilterValidationArgs,
} from './build_rank_ic_walkforward_filter_validation.js'

function syntheticAssets() {
  const length = 420
  return ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'].map((symbol, assetIndex) => ({
    symbol,
    candles: Array.from({ length }, (_, index) => {
      const cycle = index % 60
      const drift = cycle < 30 ? assetIndex * 0.35 : (5 - assetIndex) * 0.35
      return {
        time: 1_700_000_000_000 + index * 3_600_000,
        close: 100 + index * 0.03 + drift,
        volume: 1_000_000 + assetIndex * 10_000,
      }
    }),
  }))
}

function rankIcReport() {
  return {
    schemaVersion: 1,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    commonPeriods: 420,
    symbolsLoaded: ['A-USDT', 'B-USDT', 'C-USDT', 'D-USDT', 'E-USDT', 'F-USDT'],
    dataCadence: {
      barMinutes: 60,
    },
    best: {
      lookbackHours: 24,
      secondaryLookbackHours: 48,
      forwardHours: 12,
      lookbackBars: 24,
      secondaryLookbackBars: 48,
      forwardBars: 12,
      mtfWeight: 0,
      factor: 'raw_reversal',
    },
    wfo: {
      status: 'fail',
      windows: [
        { windowIndex: 0, startTime: '2023-11-17T10:00:00.000Z', endTime: '2023-11-20T21:00:00.000Z', startIndex: 50, endIndexExclusive: 134 },
        { windowIndex: 1, startTime: '2023-11-20T22:00:00.000Z', endTime: '2023-11-24T09:00:00.000Z', startIndex: 134, endIndexExclusive: 218 },
        { windowIndex: 2, startTime: '2023-11-24T10:00:00.000Z', endTime: '2023-11-27T21:00:00.000Z', startIndex: 218, endIndexExclusive: 302 },
        { windowIndex: 3, startTime: '2023-11-27T22:00:00.000Z', endTime: '2023-12-01T09:00:00.000Z', startIndex: 302, endIndexExclusive: 386 },
      ],
    },
  }
}

describe('build_rank_ic_walkforward_filter_validation', () => {
  it('parses conservative defaults and package-script options', () => {
    expect(parseRankIcWalkForwardFilterValidationArgs([
      '--rankIcReportPath',
      'rank.json',
      '--dataDir',
      'data/live',
      '--output',
      'null',
      '--symbols',
      'BTC-USDT,ETH-USDT',
      '--minTrainWindows',
      '2',
      '--json',
      'true',
    ])).toMatchObject({
      rankIcReportPath: 'rank.json',
      dataDir: 'data/live',
      outputPath: null,
      symbols: ['BTC-USDT', 'ETH-USDT'],
      executionMode: 'paper',
      minTrainWindows: 2,
      json: true,
    })
  })

  it('fits validation filters from previous WFO windows only and never authorizes execution', () => {
    const report = buildRankIcWalkForwardFilterValidationReport({
      rankIcReportPath: '/repo/data/research/rank.json',
      rankIcReport: rankIcReport(),
      dataDir: '/repo/data/market/live_accumulated',
      barMinutes: 60,
      assets: syntheticAssets(),
      args: {
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 3,
        executionMode: 'paper',
        minTrainWindows: 1,
      },
      generatedAt: '2026-05-05T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      generatedAt: '2026-05-05T00:00:00.000Z',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      validationWindowCount: 3,
      trainingPolicy: {
        minTrainWindows: 1,
        thresholdSource: 'previous_wfo_windows_only',
        usesFutureRegimeDataForThresholds: false,
      },
      dataAlignment: {
        alignmentStatus: 'aligned',
        loadedCommonPeriods: 420,
      },
    })
    expect(report.baseline).toMatchObject({
      filterId: 'no_filter',
      validationWindowsEvaluated: 3,
      trainPolicy: 'previous_wfo_windows_only',
    })
    expect(report.candidates.length).toBeGreaterThan(1)
    const filtered = report.candidates.find(candidate => candidate.filterId !== 'no_filter')
    expect(filtered?.windows[0]).toMatchObject({
      trainWindowIndexes: [0],
      filter: {
        generatedFrom: 'walk_forward_training_quantile',
      },
    })
    expect(filtered?.windows[1].trainWindowIndexes).toEqual([0, 1])
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_promotion_evidence',
      'walk_forward_filter_diagnostic_only',
      'not_trial_ledger_fdr_validated',
      'not_runtime_fee_verified',
      'not_paper_execution_evidence',
    ]))
  })
})
