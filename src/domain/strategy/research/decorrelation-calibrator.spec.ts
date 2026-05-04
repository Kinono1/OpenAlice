import { describe, expect, it } from 'vitest'
import { calibrateDecorrelationWeights } from './decorrelation-calibrator.js'
import type { FactorTimeSeries } from './factor-diagnostics.js'

function factor(name: string, values: number[]): FactorTimeSeries {
  return {
    name,
    values,
    timestamps: values.map((_, index) => index),
  }
}

describe('calibrateDecorrelationWeights', () => {
  it('returns empty weights for an empty factor set', () => {
    expect(calibrateDecorrelationWeights([])).toMatchObject({
      weights: {},
      effectiveNumberOfBets: 0,
      eigenvalues: [],
    })
  })

  it('keeps one factor at full weight', () => {
    expect(calibrateDecorrelationWeights([
      factor('solo', [1, 2, 3]),
    ])).toMatchObject({
      weights: { solo: 1 },
      effectiveNumberOfBets: 1,
      eigenvalues: [1],
    })
  })

  it('reports fewer effective bets when factors are highly correlated', () => {
    const correlated = calibrateDecorrelationWeights([
      factor('a', [1, 2, 3, 4, 5]),
      factor('b', [2, 4, 6, 8, 10]),
      factor('c', [1, 3, 2, 5, 4]),
    ])

    expect(correlated.effectiveNumberOfBets).toBeGreaterThan(1)
    expect(correlated.effectiveNumberOfBets).toBeLessThanOrEqual(3)
    expect(Object.values(correlated.weights).reduce((sum, value) => sum + value, 0)).toBeCloseTo(3)
  })
})
