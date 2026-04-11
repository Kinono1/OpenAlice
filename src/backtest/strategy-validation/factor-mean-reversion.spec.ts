import { describe, expect, it } from 'vitest'
import { runStrategyBacktest } from './backtest.js'
import { evaluateStrategy, getStrategyMinimumBars } from './strategies.js'
import type { MarketData, StrategyRegimeLabel } from './types.js'

function makeCandles(length: number): MarketData[] {
  return Array.from({ length }, (_, index) => {
    const base =
      index < 180
        ? 100 + index * 0.8
        : 244 - (index - 180) * 0.9
    return {
      symbol: 'BTC/USDT:USDT',
      time: index * 3600,
      open: base,
      high: base * 1.01,
      low: base * 0.99,
      close: base,
      volume: 1_000 + index * 5,
    }
  })
}

function toMillisecondCandles(candles: MarketData[]): MarketData[] {
  return candles.map((candle) => ({
    ...candle,
    time: candle.time * 1000,
  }))
}

describe('factorMeanReversion strategy', () => {
  it('increases minimum bars when regime indicators require more history', () => {
    const minimumBars = getStrategyMinimumBars('factorMeanReversion', {
      regimeFastPeriod: 220,
      regimeSlowPeriod: 180,
      regimeAtrPeriod: 60,
      regimeVolWindow: 80,
    })

    expect(minimumBars).toBe(220)
  })

  it('stays flat when factor mean reversion lacks enough bars for regime classification', () => {
    const candles = makeCandles(200)
    const decision = evaluateStrategy({
      strategy: 'factorMeanReversion',
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params: {
        regimeFastPeriod: 220,
        regimeSlowPeriod: 180,
        regimeAtrPeriod: 60,
        regimeVolWindow: 80,
      },
    })

    expect(decision.strategy).toBe('factorMeanReversion')
    expect(decision.signal).toBe(0)
    expect(decision.reason).toBe('Not enough bars for factor mean reversion signal.')
    expect(decision.indicators.requiredBars).toBe(220)
  })

  it('emits a contrarian signal once enough history is available', () => {
    const candles = makeCandles(220)
    const decision = evaluateStrategy({
      strategy: 'factorMeanReversion',
      candles,
      index: 200,
      currentPosition: 0,
      params: {
        factorEntryThreshold: 0.2,
        factorExitThreshold: 0.05,
      },
    })

    expect(decision.strategy).toBe('factorMeanReversion')
    expect(decision.signal).not.toBe(0)
    expect(decision.indicators.signal).toBeTypeOf('number')
  })

  it('runs a standalone backtest with factorMeanReversion parameters', () => {
    const candles = makeCandles(260)
    const result = runStrategyBacktest({
      strategy: 'factorMeanReversion',
      candles,
      params: {
        factorEntryThreshold: 0.25,
        factorExitThreshold: 0.08,
        factorMaxHoldingBars: 24,
        factorStopLossPct: 0.02,
      },
    })

    expect(result.strategy).toBe('factorMeanReversion')
    expect(result.metrics.tradeCount).toBeGreaterThan(0)
    expect(result.metrics.sortino).toBeTypeOf('number')
    expect(result.metrics.calmar).toBeTypeOf('number')
    expect(result.metrics.grossExpectancyPct).toBeTypeOf('number')
    expect(result.metrics.netExpectancyPct).toBeTypeOf('number')
    expect(result.metrics.feeExpectancyDragPct).toBeGreaterThanOrEqual(0)
    expect(result.metrics.slippageExpectancyDragPct).toBeGreaterThanOrEqual(0)
    expect(result.metrics.fundingExpectancyDragPct).toBeGreaterThanOrEqual(0)
    expect(result.metrics.regimeSummary).toBeTruthy()
    for (const summary of Object.values(result.metrics.regimeSummary)) {
      if (!summary) continue
      expect(summary.grossExpectancyPct).toBeTypeOf('number')
      expect(summary.netExpectancyPct).toBeTypeOf('number')
      expect(summary.totalCostExpectancyDragPct).toBeGreaterThanOrEqual(0)
      expect(summary.totalGrossReturnPct).toBeTypeOf('number')
      expect(summary.totalNetReturnPct).toBeTypeOf('number')
    }
    expect(result.lastDecision.strategy).toBe('factorMeanReversion')
  })

  it('applies regime gating as an additive A/B filter', () => {
    const candles = makeCandles(260)
    const params = {
      factorEntryThreshold: 0.25,
      factorExitThreshold: 0.08,
      factorMaxHoldingBars: 24,
      factorStopLossPct: 0.02,
    }
    const baseline = runStrategyBacktest({
      strategy: 'factorMeanReversion',
      candles,
      params,
    })
    const allowedEntryRegimes: StrategyRegimeLabel[] = ['HighVolMeanRevert', 'LowVolCarry']
    const gated = runStrategyBacktest({
      strategy: 'factorMeanReversion',
      candles,
      params,
      regimeGate: {
        allowedEntryRegimes: [...allowedEntryRegimes],
        exitOnMismatch: true,
      },
    })

    expect(gated.metrics.tradeCount).toBeLessThanOrEqual(baseline.metrics.tradeCount)
    expect(gated.trades.every((trade) => allowedEntryRegimes.includes(trade.entryRegime))).toBe(true)
  })

  it('keeps annualized metrics stable when candle timestamps are milliseconds', () => {
    const secondCandles = makeCandles(260)
    const millisecondCandles = toMillisecondCandles(secondCandles)
    const params = {
      factorEntryThreshold: 0.25,
      factorExitThreshold: 0.08,
      factorMaxHoldingBars: 24,
      factorStopLossPct: 0.02,
    }

    const secondResult = runStrategyBacktest({
      strategy: 'factorMeanReversion',
      candles: secondCandles,
      params,
    })
    const millisecondResult = runStrategyBacktest({
      strategy: 'factorMeanReversion',
      candles: millisecondCandles,
      params,
    })

    expect(millisecondResult.metrics.tradeCount).toBe(secondResult.metrics.tradeCount)
    expect(millisecondResult.metrics.totalReturnPct).toBeCloseTo(secondResult.metrics.totalReturnPct, 10)
    expect(millisecondResult.metrics.annualizedReturnPct).toBeCloseTo(
      secondResult.metrics.annualizedReturnPct,
      10,
    )
    expect(millisecondResult.metrics.sharpe).toBeCloseTo(secondResult.metrics.sharpe, 10)
  })
})
