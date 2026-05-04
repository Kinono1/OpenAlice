import { describe, it, expect } from 'vitest'
import { computeHCAWeights } from './hca.js'

function makeReturns(n: number, mean: number, std: number, seed: number): number[] {
  const r: number[] = []
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    r.push(mean + ((s & 0xffff) / 0xffff - 0.5) * 2 * std)
  }
  return r
}

describe('computeHCAWeights', () => {
  it('weights sum to 1', () => {
    const returns = {
      BTC: makeReturns(200, 0.001, 0.03, 1),
      ETH: makeReturns(200, 0.001, 0.04, 2),
      SOL: makeReturns(200, 0.001, 0.05, 3),
      BNB: makeReturns(200, 0.001, 0.02, 4),
    }
    const { weights } = computeHCAWeights(returns)
    const total = Object.values(weights).reduce((s, v) => s + v, 0)
    expect(total).toBeCloseTo(1, 5)
  })

  it('all weights are positive', () => {
    const returns = {
      A: makeReturns(200, 0, 0.02, 10),
      B: makeReturns(200, 0, 0.04, 20),
      C: makeReturns(200, 0, 0.01, 30),
    }
    const { weights } = computeHCAWeights(returns)
    for (const w of Object.values(weights)) {
      expect(w).toBeGreaterThan(0)
    }
  })

  it('lower-volatility asset gets higher weight', () => {
    // A has 2× lower vol than B → should get higher weight
    const returns = {
      A: makeReturns(300, 0, 0.01, 1),
      B: makeReturns(300, 0, 0.04, 2),
    }
    const { weights } = computeHCAWeights(returns)
    expect(weights['A']!).toBeGreaterThan(weights['B']!)
  })

  it('returns sortedOrder with correct length', () => {
    const returns = {
      X: makeReturns(200, 0, 0.02, 1),
      Y: makeReturns(200, 0, 0.03, 2),
      Z: makeReturns(200, 0, 0.01, 3),
    }
    const { sortedOrder } = computeHCAWeights(returns)
    expect(sortedOrder).toHaveLength(3)
    expect(new Set(sortedOrder).size).toBe(3)
  })

  it('correlation matrix is symmetric', () => {
    const returns = {
      A: makeReturns(200, 0, 0.02, 1),
      B: makeReturns(200, 0, 0.03, 2),
      C: makeReturns(200, 0, 0.01, 3),
    }
    const { correlationMatrix } = computeHCAWeights(returns)
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(correlationMatrix[i]![j]).toBeCloseTo(correlationMatrix[j]![i]!, 10)
      }
    }
  })

  it('diagonal of correlation matrix is 1', () => {
    const returns = {
      A: makeReturns(200, 0, 0.02, 1),
      B: makeReturns(200, 0, 0.03, 2),
    }
    const { correlationMatrix } = computeHCAWeights(returns)
    expect(correlationMatrix[0]![0]).toBeCloseTo(1)
    expect(correlationMatrix[1]![1]).toBeCloseTo(1)
  })

  it('throws for fewer than 2 assets', () => {
    expect(() => computeHCAWeights({ A: [0.01, 0.02] })).toThrow()
  })
})
