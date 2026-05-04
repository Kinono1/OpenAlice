import { describe, expect, it } from 'vitest'
import { runStrategyBacktest } from './backtest.js'
import { evaluateStrategy, getStrategyMinimumBars } from './strategies.js'
import type { MarketData } from './types.js'

function makeShockFadeCandles(length: number): MarketData[] {
  return Array.from({ length }, (_, index) => {
    let close = 100 + index * 0.12
    let volume = 1_000 + index * 4

    if (index === 172) {
      close -= 4.5
      volume *= 2.1
    } else if (index === 173) {
      close -= 5.5
      volume *= 2.6
    } else if (index > 173 && index < 186) {
      close = 115 - (index - 173) * 0.6
      volume *= 1.5
    }

    return {
      symbol: 'BTC/USDT:USDT',
      time: index * 3600,
      open: close * 1.002,
      high: close * 1.008,
      low: close * 0.992,
      close,
      volume,
    }
  })
}

describe('shockFade strategy', () => {
  it('requires regime history before emitting signals', () => {
    const minimumBars = getStrategyMinimumBars('shockFade', {
      regimeFastPeriod: 220,
      regimeSlowPeriod: 180,
      regimeAtrPeriod: 60,
      regimeVolWindow: 80,
    })

    expect(minimumBars).toBe(220)
  })

  it('emits a long fade after a downside price-volume shock', () => {
    const candles = makeShockFadeCandles(220)
    const decision = evaluateStrategy({
      strategy: 'shockFade',
      candles,
      index: 173,
      currentPosition: 0,
      params: {
        allowShort: true,
        factorEntryThreshold: 0.2,
        factorExitThreshold: 0.05,
        shockMinVolumeRatio: 1.4,
        shockMinAbsReturnPct: 1.2,
      },
    })

    expect(decision.strategy).toBe('shockFade')
    expect(decision.signal).toBe(1)
    expect(decision.reason).toContain('long fade entry')
    expect(decision.indicators.volumeRatio).toBeGreaterThan(1.4)
  })

  it('runs a standalone backtest with shockFade parameters', () => {
    const candles = makeShockFadeCandles(260)
    const result = runStrategyBacktest({
      strategy: 'shockFade',
      candles,
      params: {
        allowShort: true,
        factorEntryThreshold: 0.2,
        factorExitThreshold: 0.05,
        factorMaxHoldingBars: 18,
        factorStopLossPct: 0.015,
        factorPositionPctOfEquity: 0.03,
        shockMinVolumeRatio: 1.3,
        shockMinAbsReturnPct: 1.0,
      },
    })

    expect(result.strategy).toBe('shockFade')
    expect(result.metrics.tradeCount).toBeGreaterThan(0)
    expect(result.metrics.netExpectancyPct).toBeTypeOf('number')
    expect(result.lastDecision.strategy).toBe('shockFade')
  })
})
