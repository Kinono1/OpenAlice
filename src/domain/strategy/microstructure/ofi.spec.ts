import { describe, it, expect } from 'vitest'
import { computeOFI } from './ofi.js'
import type { LOBSnapshot } from './types.js'

function makeSnap(bids: [number, number][], asks: [number, number][], ts = 0): LOBSnapshot {
  return {
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    timestamp: ts,
  }
}

describe('computeOFI', () => {
  it('returns zero OFI when book is unchanged', () => {
    const snap = makeSnap([[100, 10], [99, 8]], [[101, 10], [102, 8]])
    const result = computeOFI(snap, snap)
    expect(result.ofi).toBeCloseTo(0)
    expect(result.normalizedOfi).toBeCloseTo(0)
  })

  it('positive OFI when bid size increases at same price', () => {
    const prev = makeSnap([[100, 10]], [[101, 10]])
    const curr = makeSnap([[100, 15]], [[101, 10]])
    const result = computeOFI(prev, curr)
    expect(result.ofi).toBeGreaterThan(0)
    expect(result.normalizedOfi).toBeGreaterThan(0)
  })

  it('negative OFI when ask size increases at same price', () => {
    const prev = makeSnap([[100, 10]], [[101, 10]])
    const curr = makeSnap([[100, 10]], [[101, 15]])
    const result = computeOFI(prev, curr)
    expect(result.ofi).toBeLessThan(0)
    expect(result.normalizedOfi).toBeLessThan(0)
  })

  it('positive OFI when bid price increases (aggressive buy)', () => {
    const prev = makeSnap([[100, 10]], [[101, 10]])
    const curr = makeSnap([[101, 8]], [[102, 10]])
    const result = computeOFI(prev, curr)
    expect(result.ofi).toBeGreaterThan(0)
  })

  it('negative OFI when ask price decreases (aggressive sell)', () => {
    const prev = makeSnap([[100, 10]], [[102, 10]])
    const curr = makeSnap([[100, 10]], [[101, 8]])
    const result = computeOFI(prev, curr)
    expect(result.ofi).toBeLessThan(0)
  })

  it('normalizedOfi is in [-1, 1]', () => {
    const prev = makeSnap([[100, 1]], [[101, 1]])
    const curr = makeSnap([[100, 1000]], [[101, 1]])
    const result = computeOFI(prev, curr)
    expect(result.normalizedOfi).toBeGreaterThanOrEqual(-1)
    expect(result.normalizedOfi).toBeLessThanOrEqual(1)
  })

  it('levelOfi has correct length', () => {
    const prev = makeSnap([[100, 10], [99, 8], [98, 6]], [[101, 10], [102, 8], [103, 6]])
    const curr = makeSnap([[100, 12], [99, 8], [98, 6]], [[101, 10], [102, 8], [103, 6]])
    const result = computeOFI(prev, curr, { levels: 3 })
    expect(result.levelOfi).toHaveLength(3)
  })

  it('timestamp matches current snapshot', () => {
    const prev = makeSnap([[100, 10]], [[101, 10]], 1000)
    const curr = makeSnap([[100, 10]], [[101, 10]], 2000)
    const result = computeOFI(prev, curr)
    expect(result.timestamp).toBe(2000)
  })
})
