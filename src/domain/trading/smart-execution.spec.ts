import { describe, expect, it } from 'vitest'
import {
  buildTwapPlan,
  estimateSlippageFromDepth,
  selectBestExchange,
} from './smart-execution.js'

const NOW_MS = Date.UTC(2026, 4, 4, 0, 0, 0)

describe('smart execution helpers', () => {
  it('builds deterministic TWAP slices whose fractions sum to one', () => {
    const plan = buildTwapPlan({
      totalSize: 10,
      midPrice: 100,
      slices: 4,
      windowMs: 40_000,
      nowMs: NOW_MS,
    })

    expect(plan.slices).toHaveLength(4)
    expect(plan.totalFraction).toBeCloseTo(1)
    expect(plan.slices.map(slice => slice.targetExecTimeMs)).toEqual([
      NOW_MS + 10_000,
      NOW_MS + 20_000,
      NOW_MS + 30_000,
      NOW_MS + 40_000,
    ])
  })

  it('rejects invalid TWAP inputs instead of producing NaN plans', () => {
    expect(() => buildTwapPlan({
      totalSize: 0,
      midPrice: 100,
    })).toThrow('totalSize must be a positive finite number')
  })

  it('selects the exchange with the lowest fee plus depth impact and skips zero depth', () => {
    const best = selectBestExchange('buy', 1_000, 100, [
      { exchange: 'zero-depth-low-fee', bidDepth: 0, askDepth: 0, takerFeeBps: 1, makerRebateBps: 0 },
      { exchange: 'thin', bidDepth: 10_000, askDepth: 10_000, takerFeeBps: 2, makerRebateBps: 0 },
      { exchange: 'deep', bidDepth: 1_000_000, askDepth: 1_000_000, takerFeeBps: 4, makerRebateBps: 0 },
    ])

    expect(best).toMatchObject({
      exchange: 'deep',
      effectiveFeeBps: 4,
    })
    expect(best?.expectedSlippageBps).toBeCloseTo(0.5)
  })

  it('returns null when no exchange has usable depth', () => {
    expect(selectBestExchange('sell', 10, 100, [
      { exchange: 'bad', bidDepth: 0, askDepth: 0, takerFeeBps: 1, makerRebateBps: 0 },
    ])).toBeNull()
  })

  it('estimates depth slippage and respects max slippage before adding a violating level', () => {
    const capped = estimateSlippageFromDepth('buy', 10, 100, [
      { price: 100.02, volume: 5 },
      { price: 101, volume: 5 },
    ], 5)

    expect(capped.filledFraction).toBeCloseTo(0.5)
    expect(capped.avgPrice).toBeCloseTo(100.02)
    expect(capped.slippageBps).toBeCloseTo(2)
  })

  it('returns an empty fill for invalid size without throwing', () => {
    expect(estimateSlippageFromDepth('buy', 0, 100, [
      { price: 100, volume: 1 },
    ])).toEqual({
      filledFraction: 0,
      avgPrice: 100,
      slippageBps: 0,
    })
  })
})
