export interface QuantileSample {
  factorValue: number
  forwardReturn: number
}

export interface QuantileBucketResult {
  quantile: number
  count: number
  meanFactorValue: number
  meanForwardReturn: number
  hitRate: number
}

export interface QuantileTestResult {
  quantiles: number
  buckets: QuantileBucketResult[]
  topMinusBottomSpread: number
  monotonic: boolean
}

function mean(values: number[]): number {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0
}

export function runQuantileTest(
  samples: QuantileSample[],
  quantiles = 5,
): QuantileTestResult {
  if (samples.length === 0) {
    return {
      quantiles,
      buckets: [],
      topMinusBottomSpread: 0,
      monotonic: false,
    }
  }

  const ordered = [...samples].sort((left, right) => left.factorValue - right.factorValue)
  const buckets = Array.from({ length: quantiles }, (_, bucketIndex) => {
    const start = Math.floor((bucketIndex * ordered.length) / quantiles)
    const end = Math.floor(((bucketIndex + 1) * ordered.length) / quantiles)
    const slice = ordered.slice(start, Math.max(end, start + 1))
    return {
      quantile: bucketIndex + 1,
      count: slice.length,
      meanFactorValue: mean(slice.map((sample) => sample.factorValue)),
      meanForwardReturn: mean(slice.map((sample) => sample.forwardReturn)),
      hitRate:
        slice.length > 0
          ? slice.filter((sample) => sample.forwardReturn > 0).length / slice.length
          : 0,
    }
  })

  const meanReturns = buckets.map((bucket) => bucket.meanForwardReturn)
  const monotonic = meanReturns.every((value, index) => (
    index === 0 || value >= meanReturns[index - 1]
  ))

  return {
    quantiles,
    buckets,
    topMinusBottomSpread:
      (buckets[buckets.length - 1]?.meanForwardReturn ?? 0)
      - (buckets[0]?.meanForwardReturn ?? 0),
    monotonic,
  }
}
