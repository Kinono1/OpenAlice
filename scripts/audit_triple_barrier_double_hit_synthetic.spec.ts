import { describe, expect, it } from 'vitest'
import { evaluateTripleBarrierLabel } from '../src/domain/strategy/meta-labeling/triple-barrier.js'
import type { OhlcvData } from '../src/domain/analysis/indicator/types.js'

/**
 * Synthesize the conservative sibling logic from C2 script.
 * Same-bar double hit → always stop-loss / label 0.
 */
function evaluateConservative(candles: OhlcvData[], entryIndex: number, upper: number, lower: number, holding: number, side: 'long' | 'short') {
  const entryPrice = candles[entryIndex].close
  const upperPrice = entryPrice * (1 + upper / 100)
  const lowerPrice = entryPrice * (1 - lower / 100)
  const final = Math.min(candles.length - 1, entryIndex + Math.max(1, holding))
  for (let i = entryIndex + 1; i <= final; i++) {
    const b = candles[i]
    if (!b) break
    const uh = b.high >= upperPrice
    const lh = b.low <= lowerPrice
    if (uh && lh) return { label: 0 as 0, doubleHit: true }
    if (uh) return { label: (side === 'long' ? 1 : 0) as 0 | 1, doubleHit: false }
    if (lh) return { label: (side === 'long' ? 0 : 1) as 0 | 1, doubleHit: false }
  }
  const signed = side === 'long'
    ? ((candles[final].close - entryPrice) / entryPrice) * 100
    : ((entryPrice - candles[final].close) / entryPrice) * 100
  return { label: (signed > 0 ? 1 : 0) as 0 | 1, doubleHit: false }
}

function makeBar(open: number, high: number, low: number, close: number): OhlcvData {
  return { timestamp: Date.now(), open, high, low, close, volume: 1000 }
}

describe('audit_triple_barrier_double_hit_synthetic', () => {
  it('imports evaluateTripleBarrierLabel', () => {
    expect(evaluateTripleBarrierLabel).toBeDefined()
    expect(typeof evaluateTripleBarrierLabel).toBe('function')
  })

  it('detects same-bar double hit: long', () => {
    // Bar 0 entry at 100. Bar 1: high=110 (≤-upper 105), low=90 (≤-lower 95)
    const bars = [
      makeBar(100, 100, 100, 100), // entry
      makeBar(95, 110, 90, 105),    // same bar hits both
    ]
    const current = evaluateTripleBarrierLabel({
      candles: bars, entryIndex: 0,
      upperBarrierPct: 5, lowerBarrierPct: 5,
      maxHoldingBars: 10, side: 'long', barrierMode: 'static_pct',
    })
    const conservative = evaluateConservative(bars, 0, 5, 5, 10, 'long')
    expect(current.label).toBe(1)  // current hits upper first → take-profit
    expect(conservative.label).toBe(0)  // conservative sees both → stop-loss
    expect(conservative.doubleHit).toBe(true)
  })

  it('detects same-bar double hit: short', () => {
    // Short: entry at 100; same bar high=110 (stop-loss for short), low=90 (take-profit for short)
    const bars = [
      makeBar(100, 100, 100, 100),
      makeBar(95, 110, 90, 105),
    ]
    const current = evaluateTripleBarrierLabel({
      candles: bars, entryIndex: 0,
      upperBarrierPct: 5, lowerBarrierPct: 5,
      maxHoldingBars: 10, side: 'short', barrierMode: 'static_pct',
    })
    const conservative = evaluateConservative(bars, 0, 5, 5, 10, 'short')
    expect(current.label).toBe(0)   // short: upper is stop-loss
    expect(conservative.label).toBe(0)  // both would see stop-loss → no flip
    expect(conservative.doubleHit).toBe(true)
  })

  it('no double-hit: only upper triggers', () => {
    const bars = [
      makeBar(100, 100, 100, 100),
      makeBar(98, 108, 99, 107),  // hits upper (105) only; low=99 > 95
    ]
    const current = evaluateTripleBarrierLabel({
      candles: bars, entryIndex: 0,
      upperBarrierPct: 5, lowerBarrierPct: 5,
      maxHoldingBars: 10, side: 'long', barrierMode: 'static_pct',
    })
    expect(current.label).toBe(1)
    expect(current.exitReason).toBe('take-profit')
  })

  it('no double-hit: only lower triggers', () => {
    const bars = [
      makeBar(100, 100, 100, 100),
      makeBar(102, 103, 94, 101),  // hits lower (95) only; high=103 < 105
    ]
    const current = evaluateTripleBarrierLabel({
      candles: bars, entryIndex: 0,
      upperBarrierPct: 5, lowerBarrierPct: 5,
      maxHoldingBars: 10, side: 'long', barrierMode: 'static_pct',
    })
    expect(current.label).toBe(0)
    expect(current.exitReason).toBe('stop-loss')
  })

  it('time-expiry label uses signed return (profitable long → 1)', () => {
    const bars = [
      makeBar(100, 100, 100, 100),
      makeBar(101, 101, 99, 101), // drift up but never hit 105/95
      makeBar(102, 102, 100, 102),
    ]
    const current = evaluateTripleBarrierLabel({
      candles: bars, entryIndex: 0,
      upperBarrierPct: 5, lowerBarrierPct: 5,
      maxHoldingBars: 2, side: 'long', barrierMode: 'static_pct',
    })
    expect(current.label).toBe(1)
    expect(current.exitReason).toBe('time-expiry')
  })
})
