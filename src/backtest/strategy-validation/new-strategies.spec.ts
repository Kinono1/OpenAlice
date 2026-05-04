import { describe, expect, it } from 'vitest'
import {
  evaluateEnhancedCarry,
  evaluateLiquidationAftermath,
} from './strategies.js'
import type { MarketData, PositionSignal } from './types.js'
import { resolveStrategyParams } from './types.js'

function makeCandles(
  count: number,
  overrides?: Partial<Record<number, Partial<MarketData>>>,
): MarketData[] {
  const base: MarketData[] = []
  for (let i = 0; i < count; i++) {
    base.push({
      symbol: 'BTC-USDT',
      time: (i + 1) * 3600_000,
      open: 50000 + i * 10,
      high: 50100 + i * 10,
      low: 49900 + i * 10,
      close: 50010 + i * 10,
      volume: 100,
      fundingRate: 0.0001,
    })
  }
  for (const [i, o] of Object.entries(overrides ?? {})) {
    Object.assign(base[Number(i)], o)
  }
  return base
}

describe('enhancedCarry', () => {
  it('returns 0 when funding rate is near zero', () => {
    const candles = makeCandles(60)
    const params = resolveStrategyParams({})
    const result = evaluateEnhancedCarry(candles, 55, 0, params)
    expect(result.signal).toBe(0)
  })

  it('signals short when funding rate z-score is high positive', () => {
    const candles = makeCandles(60)
    // Make last funding rate extreme (> 2 sigma above mean)
    for (let i = 0; i < 55; i++) {
      candles[i].fundingRate = 0.0001
    }
    candles[55].fundingRate = 0.002 // extreme positive
    candles[56].fundingRate = 0.002
    candles[57].fundingRate = 0.002
    const params = resolveStrategyParams({ carryZEntry: 2.0 })
    const result = evaluateEnhancedCarry(candles, 57, 0, params)
    expect(result.signal).toBe(-1)
    expect(result.strategy).toBe('enhancedCarry')
  })

  it('signals long when funding rate z-score is extreme negative', () => {
    const candles = makeCandles(60)
    for (let i = 0; i < 55; i++) {
      candles[i].fundingRate = 0.0001
    }
    candles[55].fundingRate = -0.002
    candles[56].fundingRate = -0.002
    candles[57].fundingRate = -0.002
    const params = resolveStrategyParams({ carryZEntry: 2.0, allowShort: true })
    const result = evaluateEnhancedCarry(candles, 57, 0, params)
    expect(result.signal).toBe(1)
  })

  it('exits when funding z-score mean-reverts', () => {
    const candles = makeCandles(60, {
      55: { fundingRate: 0.0001 },
      56: { fundingRate: 0.0001 },
      57: { fundingRate: 0.0001 },
    })
    const params = resolveStrategyParams({ carryZExit: 0.5 })
    const result = evaluateEnhancedCarry(candles, 57, -1, params)
    expect(result.signal).toBe(0)
  })

  it('exits when funding sign flips', () => {
    const candles = makeCandles(60)
    for (let i = 0; i < 55; i++) {
      candles[i].fundingRate = 0.001
    }
    candles[55].fundingRate = -0.0005
    candles[56].fundingRate = -0.0005
    candles[57].fundingRate = -0.0005
    const params = resolveStrategyParams({ carryZExit: 0.5 })
    // Position is short (-1), but funding is now negative — sign flipped
    const result = evaluateEnhancedCarry(candles, 57, -1, params)
    expect(result.signal).toBe(0)
  })

  it('rejects insufficient bars', () => {
    const candles = makeCandles(10)
    const params = resolveStrategyParams({ carryMinFundingBars: 48 })
    const result = evaluateEnhancedCarry(candles, 5, 0, params)
    expect(result.signal).toBe(0)
    expect(result.reason).toContain('Need at least')
  })
})

describe('liquidationAftermath', () => {
  it('detects cascade: volume surge + price drop with recovery', () => {
    const candles = makeCandles(30)
    candles[28] = {
      ...candles[28],
      volume: 350, // 3.5x surge
      open: 50000,
      high: 50050,
      low: 48500, // drop = 3% from open
      close: 49400, // above midpoint (49275) = recovery confirmation
    }
    const params = resolveStrategyParams({
      cascadeMinVolSurge: 3.0,
      cascadeMinDropPct: 2.5,
    })
    const result = evaluateLiquidationAftermath(candles, 28, 0, params)
    expect(result.signal).toBe(1)
    expect(result.strategy).toBe('liquidationAftermath')
  })

  it('no signal without volume surge', () => {
    const candles = makeCandles(30)
    candles[28] = {
      ...candles[28],
      volume: 150,
      open: 50000,
      low: 48500,
    }
    const params = resolveStrategyParams({ cascadeMinVolSurge: 3.0 })
    const result = evaluateLiquidationAftermath(candles, 28, 0, params)
    expect(result.signal).toBe(0)
  })

  it('exits on new low after cascade', () => {
    const candles = makeCandles(30)
    // Simulate holding a long position, then new low made
    candles[27] = { ...candles[27], volume: 200, low: 49000, close: 49100 }
    candles[28] = { ...candles[28], volume: 200, open: 49100, high: 49200, low: 48900, close: 48950 }
    const result = evaluateLiquidationAftermath(candles, 28, 1, resolveStrategyParams({ cascadeMinVolSurge: 3.0 }))
    expect(result.signal).toBe(0)
    expect(result.reason).toContain('Reversal failed')
  })

  it('exits when volume normalizes', () => {
    const candles = makeCandles(30)
    candles[28] = { ...candles[28], volume: 50 }
    const result = evaluateLiquidationAftermath(candles, 28, 1, resolveStrategyParams({ cascadeMinVolSurge: 3.0 }))
    expect(result.signal).toBe(0)
    expect(result.reason).toContain('Volume normalized')
  })
})
