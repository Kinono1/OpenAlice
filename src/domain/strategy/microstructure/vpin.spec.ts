import { describe, it, expect } from 'vitest'
import { VPINCalculator } from './vpin.js'
import type { TradeTick } from './types.js'

function tick(price: number, size: number, isBuy: boolean, ts = Date.now()): TradeTick {
  return { price, size, isBuy, timestamp: ts }
}

describe('VPINCalculator', () => {
  it('returns null until enough buckets are filled', () => {
    const calc = new VPINCalculator(10, 5)
    const result = calc.update(tick(100, 5, true))
    expect(result).toBeNull()
  })

  it('returns a result after enough volume buckets', () => {
    const calc = new VPINCalculator(10, 5)
    // Fill 6 buckets of size 10 with pure buy volume
    for (let i = 0; i < 60; i++) {
      calc.update(tick(100, 1, true, i))
    }
    const result = calc.compute(Date.now())
    expect(result).not.toBeNull()
    expect(result.bucketsUsed).toBeGreaterThanOrEqual(2)
  })

  it('VPIN is high for one-sided order flow', () => {
    const calc = new VPINCalculator(10, 20)
    // All buys -> |buyVol - sellVol| = bucketSize -> VPIN = 1
    for (let i = 0; i < 300; i++) {
      calc.update(tick(100, 1, true, i))
    }
    const result = calc.compute(Date.now())
    expect(result.vpin).toBeCloseTo(1, 1)
  })

  it('VPIN is low for balanced order flow', () => {
    const calc = new VPINCalculator(10, 20)
    // Alternating buy/sell -> balanced
    for (let i = 0; i < 300; i++) {
      calc.update(tick(100, 1, i % 2 === 0, i))
    }
    const result = calc.compute(Date.now())
    expect(result.vpin).toBeLessThan(0.3)
  })

  it('VPIN is in [0, 1]', () => {
    const calc = new VPINCalculator(10, 10)
    for (let i = 0; i < 200; i++) {
      calc.update(tick(100 + (i % 5), 1, i % 3 === 0, i))
    }
    const result = calc.compute(Date.now())
    expect(result.vpin).toBeGreaterThanOrEqual(0)
    expect(result.vpin).toBeLessThanOrEqual(1)
  })

  it('uses tick rule when price changes', () => {
    const calc = new VPINCalculator(5, 5)
    // Price going up -> tick rule classifies as buy
    calc.update(tick(100, 1, false, 1))  // first tick, uses isBuy=false
    calc.update(tick(101, 1, false, 2))  // price up -> tick rule: buy
    calc.update(tick(102, 1, false, 3))  // price up -> tick rule: buy
    // No assertion on VPIN value, just ensure no crash
    expect(() => calc.compute(Date.now())).not.toThrow()
  })

  it('reset clears all state', () => {
    const calc = new VPINCalculator(10, 5)
    for (let i = 0; i < 100; i++) calc.update(tick(100, 1, true, i))
    calc.reset()
    const result = calc.update(tick(100, 1, true, 200))
    expect(result).toBeNull()
  })
})
