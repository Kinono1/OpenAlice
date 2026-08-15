import { describe, expect, it } from 'vitest'
import {
  buildLiquidityConditionedRegimeFilterSweepReport,
  parseLiquidityConditionedRegimeFilterSweepArgs,
} from './build_liquidity_conditioned_regime_filter_sweep.js'

function makeAsset(symbol: string, closes: number[]) {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: Date.parse('2026-01-01T00:00:00.000Z') + index * 3_600_000,
      close,
      volume: 1_000 + index,
    })),
  }
}

function trendSeries(start: number, steps: number[]): number[] {
  const out = [start]
  for (const step of steps) out.push(out[out.length - 1] + step)
  return out
}

describe('build_liquidity_conditioned_regime_filter_sweep', () => {
  it('parses safe research-only defaults', () => {
    expect(parseLiquidityConditionedRegimeFilterSweepArgs([])).toEqual({
      factorReportPath: 'data/research/liquidity_conditioned_factor_report.live_accumulated.latest.json',
      dataDir: 'data/market/live_accumulated',
      outputPath: 'data/research/liquidity_conditioned_regime_filter_sweep.live_accumulated.latest.json',
      candidateId: null,
      symbols: [],
      barMinutes: 60,
      maxRows: null,
      routeCostPct: null,
      minUniverseSize: 20,
      minBucketAssets: 5,
      topBottomFraction: 0.25,
      json: false,
    })
  })

  it('keeps regime-filter diagnostics fail-closed even when a filter improves WFO', () => {
    const stepsA = [
      ...Array(10).fill(-1),
      ...Array(10).fill(0.4),
      ...Array(10).fill(1.1),
      ...Array(10).fill(0.8),
    ]
    const stepsB = [
      ...Array(10).fill(-1.4),
      ...Array(10).fill(0.6),
      ...Array(10).fill(1.4),
      ...Array(10).fill(1.0),
    ]
    const stepsC = [
      ...Array(10).fill(-1.8),
      ...Array(10).fill(0.8),
      ...Array(10).fill(1.7),
      ...Array(10).fill(1.2),
    ]
    const stepsD = [
      ...Array(10).fill(-0.5),
      ...Array(10).fill(0.2),
      ...Array(10).fill(0.7),
      ...Array(10).fill(0.5),
    ]
    const stepsE = [
      ...Array(10).fill(-0.2),
      ...Array(10).fill(0.4),
      ...Array(10).fill(0.9),
      ...Array(10).fill(0.7),
    ]
    const stepsF = [
      ...Array(10).fill(-1.2),
      ...Array(10).fill(0.5),
      ...Array(10).fill(1.2),
      ...Array(10).fill(0.9),
    ]
    const assets = [
      makeAsset('BTC-USDT', trendSeries(100, stepsA)),
      makeAsset('ETH-USDT', trendSeries(100, stepsB)),
      makeAsset('SOL-USDT', trendSeries(100, stepsC)),
      makeAsset('BNB-USDT', trendSeries(100, stepsD)),
      makeAsset('DOGE-USDT', trendSeries(100, stepsE)),
      makeAsset('XRP-USDT', trendSeries(100, stepsF)),
    ]
    const factorReport = {
      routeCost: { pairRoundTripCostPct: 0 },
      best: {
        configId: 'liq_all_momentum_lb2_fwd1',
        liquidityBucket: 'all',
        factor: 'momentum',
        lookbackHours: 2,
        forwardHours: 1,
        lookbackBars: 2,
        forwardBars: 1,
        wfo: {
          status: 'fail',
          failedWindowRatio: 1,
          windows: [
            { windowIndex: 0, startIndex: 25, endIndexExclusive: 30, startTime: 'a', endTime: 'b' },
            { windowIndex: 1, startIndex: 30, endIndexExclusive: 35, startTime: 'b', endTime: 'c' },
            { windowIndex: 2, startIndex: 35, endIndexExclusive: 40, startTime: 'c', endTime: 'd' },
          ],
        },
      },
    }

    const report = buildLiquidityConditionedRegimeFilterSweepReport({
      factorReportPath: '/tmp/liquidity.json',
      dataDir: '/tmp/live',
      assets,
      factorReport,
      args: {
        candidateId: null,
        barMinutes: 60,
        routeCostPct: 0,
        minUniverseSize: 4,
        minBucketAssets: 2,
        topBottomFraction: 0.25,
      },
      generatedAt: '2026-01-02T00:00:00.000Z',
    })

    expect(report.researchOnly).toBe(true)
    expect(report.promotionEligible).toBe(false)
    expect(report.paperTradingAllowed).toBe(false)
    expect(report.liveTradingAllowed).toBe(false)
    expect(report.config).toMatchObject({
      configId: 'liq_all_momentum_lb2_fwd1',
      liquidityBucket: 'all',
      factor: 'momentum',
    })
    expect(report.baseline?.filter.id).toBe('no_filter')
    expect(report.candidates.length).toBeGreaterThan(1)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'filter_thresholds_in_sample_overfit_risk',
      'route_cost_manual_not_runtime_verified',
      'paper_live_execution_disabled',
    ]))
    expect(report.candidates.some(candidate =>
      candidate.filter.generatedFrom === 'in_sample_regime_quantile' &&
      candidate.warnings.includes('filter_thresholds_fit_in_sample'),
    )).toBe(true)
    expect(report.notes.join(' ')).toContain('cannot authorize paper orders')
    expect(report.nextActions.join(' ')).toContain('Do not enable paper/live')
  })
})
