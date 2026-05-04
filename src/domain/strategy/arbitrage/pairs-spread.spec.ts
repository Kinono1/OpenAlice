import { describe, it, expect } from 'vitest'
import { computeSpreadSnapshot, evaluatePairsSignal } from './pairs-spread.js'
import type { CointegrationResult } from './types.js'

const mockCoint: CointegrationResult = {
  adfTStat: -3.5,
  pValue: 0.05,
  hedgeRatio: 1.5,
  halfLife: 20,
  spreadMean: 0,
  spreadStd: 2,
  isCointegrated: true,
}

describe('computeSpreadSnapshot', () => {
  it('computes spread = priceA - hedgeRatio * priceB', () => {
    const snap = computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, [])
    expect(snap.spread).toBeCloseTo(100 - 1.5 * 50)
  })

  it('uses offline stats when recentSpreads < 20', () => {
    const snap = computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, [1, 2, 3])
    expect(snap.spreadMean).toBe(mockCoint.spreadMean)
    expect(snap.spreadStd).toBe(mockCoint.spreadStd)
  })

  it('uses rolling stats when recentSpreads >= 20', () => {
    const spreads = Array.from({ length: 30 }, (_, i) => i - 15)
    const snap = computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, spreads)
    // rolling mean of [-15..14] = -0.5
    expect(snap.spreadMean).toBeCloseTo(-0.5, 1)
    expect(snap.spreadStd).toBeGreaterThan(0)
  })

  it('zScore is 0 when spread equals mean', () => {
    const coint = { ...mockCoint, spreadMean: 25, spreadStd: 2 }
    const snap = computeSpreadSnapshot('BTC', 'ETH', 100, 50, coint, [])
    expect(snap.zScore).toBeCloseTo(0)
  })

  it('zScore is positive when spread > mean', () => {
    const snap = computeSpreadSnapshot('BTC', 'ETH', 110, 50, mockCoint, [])
    expect(snap.zScore).toBeGreaterThan(0)
  })

  it('returns correct symbol labels', () => {
    const snap = computeSpreadSnapshot('SOL', 'AVAX', 100, 50, mockCoint, [])
    expect(snap.symbolA).toBe('SOL')
    expect(snap.symbolB).toBe('AVAX')
    expect(snap.symbol).toBe('SOL/AVAX')
  })
})

describe('evaluatePairsSignal', () => {
  it('enters long A / short B when zScore < -entryZScore', () => {
    const snap = computeSpreadSnapshot('BTC', 'ETH', 100 - 10, 50, mockCoint, [])
    // spread = 25, mean=0, std=2 -> z = 25/2 = 12.5... let's use a direct snapshot
    const directSnap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: -2.5 }
    const sig = evaluatePairsSignal(directSnap, 0)
    expect(sig.direction).toBe(1)
    expect(sig.confidence).toBeGreaterThan(0)
  })

  it('enters short A / long B when zScore > entryZScore', () => {
    const snap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 2.5 }
    const sig = evaluatePairsSignal(snap, 0)
    expect(sig.direction).toBe(-1)
  })

  it('stays flat when |zScore| < entryZScore', () => {
    const snap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 1.0 }
    const sig = evaluatePairsSignal(snap, 0)
    expect(sig.direction).toBe(0)
    expect(sig.confidence).toBe(0)
  })

  it('exits long position when zScore reverts past exitZScore', () => {
    const snap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 0.3 }
    const sig = evaluatePairsSignal(snap, 1, { exitZScore: 0.5 })
    expect(sig.direction).toBe(0)
  })

  it('holds long position when zScore has not reverted', () => {
    const snap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: -1.5 }
    const sig = evaluatePairsSignal(snap, 1)
    expect(sig.direction).toBe(1)
  })

  it('confidence is 0 when direction is 0', () => {
    const snap = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 0.5 }
    const sig = evaluatePairsSignal(snap, 0)
    expect(sig.confidence).toBe(0)
  })

  it('confidence increases with |zScore| beyond entry threshold', () => {
    const snap1 = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 2.5 }
    const snap2 = { ...computeSpreadSnapshot('BTC', 'ETH', 100, 50, mockCoint, []), zScore: 3.5 }
    const sig1 = evaluatePairsSignal(snap1, 0)
    const sig2 = evaluatePairsSignal(snap2, 0)
    expect(sig2.confidence).toBeGreaterThan(sig1.confidence)
  })
})
