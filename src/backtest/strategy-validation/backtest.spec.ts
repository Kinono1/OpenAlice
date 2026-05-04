import { describe, expect, it } from 'vitest'
import { runStrategyBacktest } from './backtest.js'
import type { MarketData } from './types.js'
import { normalizePositionSignal } from './types.js'

function trendCandles(length: number): MarketData[] {
  return Array.from({ length }, (_, index) => {
    const close = 100 + index
    return {
      symbol: 'BTC/USD',
      time: index * 3600,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000,
    }
  })
}

describe('strategy-validation backtest execution accounting', () => {
  it('charges both entry and final close fees for an open trade', () => {
    const withFees = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(24),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: false,
      },
      costModel: {
        feeRate: 0.01,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
      initialCapital: 10_000,
    })
    const noFees = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(24),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: false,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
      initialCapital: 10_000,
    })

    expect(withFees.metrics.tradeCount).toBeGreaterThan(0)
    expect(withFees.metrics.feeExpectancyDragPct).toBeGreaterThanOrEqual(2)
    expect(withFees.metrics.totalFeesPaid).toBeGreaterThan(100)
    expect(withFees.metrics.finalEquity).toBeLessThan(noFees.metrics.finalEquity)
    expect(withFees.equityCurve.at(-1)?.equity).toBe(withFees.metrics.finalEquity)
    expect(withFees.metrics.totalTurnoverUsd).toBeGreaterThan(0)
    expect(withFees.metrics.turnoverPctOfInitialCapital).toBeGreaterThan(0)
    expect(withFees.metrics.sideSummary.long.tradeCount).toBe(withFees.metrics.longTradeCount)
  })

  it('normalizes numeric and string full-position actions', () => {
    expect(normalizePositionSignal(1)).toBe(1)
    expect(normalizePositionSignal('1')).toBe(1)
    expect(normalizePositionSignal(-1)).toBe(-1)
    expect(normalizePositionSignal('-1')).toBe(-1)
    expect(normalizePositionSignal('flat')).toBe(0)
  })

  it('blocks new entries when the volatility gate is not satisfied', () => {
    const baseline = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(80),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: false,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    })
    const gated = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(80),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: false,
      },
      volatilityGate: {
        minVolatilityPct: 999,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    })

    expect(baseline.metrics.tradeCount).toBeGreaterThan(0)
    expect(gated.metrics.tradeCount).toBe(0)
  })

  it('preserves no-entry behavior when the volatility gate blocks all trend entries', () => {
    const gated = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(80),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: true,
      },
      volatilityGate: {
        minVolatilityPct: 999,
        exitOnMismatch: false,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    })

    expect(gated.metrics.tradeCount).toBe(0)
    expect(gated.trades).toEqual([])
  })

  it('preserves no-entry behavior when the volatility gate blocks all trend entries even with exitOnMismatch=true', () => {
    const gated = runStrategyBacktest({
      strategy: 'trend',
      candles: trendCandles(80),
      params: {
        trendFastPeriod: 2,
        trendSlowPeriod: 4,
        trendConfirmBars: 1,
        allowShort: true,
      },
      volatilityGate: {
        minVolatilityPct: 999,
        exitOnMismatch: true,
      },
      costModel: {
        feeRate: 0,
        slippageBps: 0,
        latencyBars: 0,
        fundingRatePer8h: 0,
      },
    })

    expect(gated.metrics.tradeCount).toBe(0)
    expect(gated.trades).toEqual([])
  })
})
