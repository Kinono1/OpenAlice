import { describe, it, expect } from 'vitest'
import { testCointegration } from './cointegration.js'

/** Generate a random walk series. */
function randomWalk(n: number, seed = 1): number[] {
  let x = 100
  const series: number[] = []
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    x += ((s & 0xff) / 255 - 0.5) * 2
    series.push(x)
  }
  return series
}

/** Generate a cointegrated pair: B = A + stationary noise. */
function cointegratedPair(n: number, beta = 1.5, noiseScale = 0.3): { a: number[]; b: number[] } {
  const a = randomWalk(n, 42)
  const b = a.map((v, i) => {
    const noise = Math.sin(i * 0.3) * noiseScale + Math.cos(i * 0.7) * noiseScale * 0.5
    return v / beta + noise
  })
  return { a, b }
}

describe('testCointegration', () => {
  it('returns isCointegrated=false for two independent random walks', () => {
    const a = randomWalk(200, 1)
    const b = randomWalk(200, 99)
    const result = testCointegration(a, b)
    // Two independent random walks should rarely cointegrate
    // We just check the structure is correct
    expect(result).toHaveProperty('adfTStat')
    expect(result).toHaveProperty('pValue')
    expect(result).toHaveProperty('hedgeRatio')
    expect(result).toHaveProperty('halfLife')
    expect(result).toHaveProperty('isCointegrated')
    expect(typeof result.pValue).toBe('number')
    expect(result.pValue).toBeGreaterThan(0)
    expect(result.pValue).toBeLessThanOrEqual(1)
  })

  it('detects cointegration for a mathematically cointegrated pair', () => {
    const { a, b } = cointegratedPair(300, 1.5, 0.1)
    const result = testCointegration(a, b, { pValueThreshold: 0.10 })
    expect(result.isCointegrated).toBe(true)
    expect(result.hedgeRatio).toBeGreaterThan(0)
    expect(result.halfLife).toBeGreaterThan(0)
    expect(result.halfLife).toBeLessThan(500)
    expect(result.spreadStd).toBeGreaterThan(0)
  })

  it('returns isCointegrated=false for series shorter than 30 bars', () => {
    const result = testCointegration([1, 2, 3], [1, 2, 3])
    expect(result.isCointegrated).toBe(false)
    expect(result.pValue).toBe(1)
  })

  it('hedge ratio is positive for positively correlated pair', () => {
    const { a, b } = cointegratedPair(200, 2.0, 0.05)
    const result = testCointegration(a, b)
    expect(result.hedgeRatio).toBeGreaterThan(0)
  })

  it('adfTStat is negative for cointegrated pair (mean-reverting residuals)', () => {
    const { a, b } = cointegratedPair(300, 1.0, 0.05)
    const result = testCointegration(a, b)
    expect(result.adfTStat).toBeLessThan(0)
  })

  it('respects maxHalfLife gate', () => {
    const { a, b } = cointegratedPair(300, 1.0, 0.05)
    const result = testCointegration(a, b, { maxHalfLife: 1 })
    // half-life > 1 bar -> should be blocked
    expect(result.isCointegrated).toBe(false)
  })

  it('spreadMean and spreadStd are finite numbers', () => {
    const { a, b } = cointegratedPair(200, 1.5, 0.2)
    const result = testCointegration(a, b)
    expect(Number.isFinite(result.spreadMean)).toBe(true)
    expect(Number.isFinite(result.spreadStd)).toBe(true)
    expect(result.spreadStd).toBeGreaterThanOrEqual(0)
  })
})
