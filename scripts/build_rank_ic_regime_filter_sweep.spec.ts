import { describe, expect, it } from 'vitest'
import {
  buildRankIcRegimeFilterSweepReport,
  parseRankIcRegimeFilterSweepArgs,
} from './build_rank_ic_regime_filter_sweep.js'

function makeAsset(symbol: string, closes: number[]) {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000,
      close,
      volume: 100 + index,
    })),
  }
}

describe('build_rank_ic_regime_filter_sweep', () => {
  it('parses safe research-only defaults', () => {
    expect(parseRankIcRegimeFilterSweepArgs([])).toEqual({
      rankIcReportPath: 'data/research/cross_sectional_rank_ic.live_accumulated_fwd72.latest.json',
      dataDir: 'data/market/live_accumulated',
      outputPath: 'data/research/rank_ic_regime_filter_sweep.latest.json',
      symbols: [],
      barMinutes: null,
      maxRows: null,
      maxVolPct: 99,
      minSpreadPct: 0,
      minUniverseSize: 20,
      executionMode: 'paper',
      json: false,
    })
  })

  it('keeps filter sweep diagnostic-only and flags in-sample threshold risk', () => {
    const assets = [
      makeAsset('BTC-USDT', [100, 98, 99, 101, 103, 104, 105, 106, 108, 109]),
      makeAsset('ETH-USDT', [100, 97, 96, 98, 101, 102, 103, 105, 106, 107]),
      makeAsset('SOL-USDT', [100, 92, 91, 94, 98, 99, 100, 102, 104, 105]),
      makeAsset('BNB-USDT', [100, 99, 98, 99, 100, 101, 102, 103, 104, 106]),
    ]
    const report = buildRankIcRegimeFilterSweepReport({
      rankIcReportPath: '/tmp/rank_ic.json',
      dataDir: '/tmp/live',
      barMinutes: 60,
      assets,
      args: {
        maxVolPct: 99,
        minSpreadPct: 0,
        minUniverseSize: 2,
        executionMode: 'paper',
      },
      generatedAt: '2026-01-02T00:00:00.000Z',
      rankIcReport: {
        commonPeriods: 10,
        symbolsLoaded: assets.map(asset => asset.symbol),
        dataCadence: { barMinutes: 60 },
        best: {
          lookbackHours: 2,
          secondaryLookbackHours: 3,
          forwardHours: 1,
          lookbackBars: 2,
          secondaryLookbackBars: 3,
          forwardBars: 1,
          mtfWeight: 0.5,
          factor: 'signal_confidence',
        },
        wfo: {
          status: 'fail',
          windows: [
            { windowIndex: 0, startIndex: 5, endIndexExclusive: 6, startTime: 'a', endTime: 'b' },
            { windowIndex: 1, startIndex: 6, endIndexExclusive: 7, startTime: 'b', endTime: 'c' },
            { windowIndex: 2, startIndex: 7, endIndexExclusive: 9, startTime: 'c', endTime: 'd' },
          ],
        },
      },
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.blockers).toContain('research_only_not_promotion_evidence')
    expect(report.blockers).toContain('filter_thresholds_in_sample_overfit_risk')
    expect(report.baseline?.filter.id).toBe('no_filter')
    expect(report.candidates.length).toBeGreaterThan(1)
    expect(report.candidates.some(candidate =>
      candidate.filter.generatedFrom === 'in_sample_regime_quantile' &&
      candidate.warnings.includes('filter_thresholds_fit_in_sample'),
    )).toBe(true)
    expect(report.candidates.some(candidate =>
      candidate.diagnosticVerdict === 'improved_wfo_candidate' &&
      candidate.wfo.status === 'insufficient_data',
    )).toBe(false)
    expect(report.nextActions.join(' ')).toContain('Do not enable paper/live')
  })
})
