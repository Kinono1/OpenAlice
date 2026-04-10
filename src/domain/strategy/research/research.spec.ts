import { describe, expect, it } from 'vitest'
import { buildIcDecayCurve } from './decay-curve.js'
import { analyzeInformationCoefficient } from './ic-analyzer.js'
import { runQuantileTest } from './quantile-test.js'

function makeBucketedSamples() {
  return Array.from({ length: 25 }, (_, index) => {
    const cycle = index % 5
    return {
      factorValue: cycle - 2,
      forwardReturn: (cycle - 2) * 0.02 + index * 1e-4,
      bucketKey: Math.floor(index / 5),
    }
  })
}

describe('strategy research utilities', () => {
  it('computes positive IC statistics on aligned factor returns', () => {
    const result = analyzeInformationCoefficient(makeBucketedSamples())

    expect(result.meanIc).toBeGreaterThan(0)
    expect(result.winRate).toBeGreaterThan(0.5)
    expect(result.passed).toBe(true)
  })

  it('builds quantile spreads and monotonicity checks', () => {
    const result = runQuantileTest(
      makeBucketedSamples().map(({ factorValue, forwardReturn }) => ({
        factorValue,
        forwardReturn,
      })),
      5,
    )

    expect(result.buckets).toHaveLength(5)
    expect(result.topMinusBottomSpread).toBeGreaterThan(0)
    expect(result.monotonic).toBe(true)
  })

  it('builds an IC decay curve across horizons', () => {
    const base = makeBucketedSamples()
    const result = buildIcDecayCurve([
      { horizon: 1, samples: base },
      {
        horizon: 6,
        samples: base.map((sample) => ({
          ...sample,
          forwardReturn: sample.forwardReturn * 0.7 + (sample.bucketKey ?? 0) * 0.002,
        })),
      },
      {
        horizon: 24,
        samples: base.map((sample) => ({
          ...sample,
          forwardReturn:
            (sample.bucketKey ?? 0) % 2 === 0
              ? sample.forwardReturn * 0.15
              : -sample.forwardReturn * 0.05,
        })),
      },
    ])

    expect(result.points).toHaveLength(3)
    expect(result.points[0].meanIc).toBeGreaterThanOrEqual(result.points[1].meanIc)
    expect(result.halfLifeHorizon).toBeTruthy()
  })
})
