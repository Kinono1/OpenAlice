import type { CointegrationResult } from './types.js'

/** OLS regression: y = alpha + beta * x. Returns { alpha, beta, residuals }. */
function ols(y: number[], x: number[]): { alpha: number; beta: number; residuals: number[] } {
  const n = y.length
  const meanX = x.reduce((s, v) => s + v, 0) / n
  const meanY = y.reduce((s, v) => s + v, 0) / n
  const ssXX = x.reduce((s, v) => s + (v - meanX) ** 2, 0)
  const ssXY = x.reduce((s, v, i) => s + (v - meanX) * (y[i]! - meanY), 0)
  const beta = ssXX > 0 ? ssXY / ssXX : 0
  const alpha = meanY - beta * meanX
  const residuals = y.map((v, i) => v - alpha - beta * x[i]!)
  return { alpha, beta, residuals }
}

/** ADF test (no trend, no constant) on a series. Returns t-stat. */
function adfTStat(series: number[]): number {
  const n = series.length
  if (n < 4) return 0
  const diff: number[] = []
  const lagged: number[] = []
  for (let i = 1; i < n; i++) {
    diff.push(series[i]! - series[i - 1]!)
    lagged.push(series[i - 1]!)
  }
  const { beta, residuals } = ols(diff, lagged)
  const ssRes = residuals.reduce((s, v) => s + v * v, 0)
  const se = Math.sqrt(ssRes / Math.max(residuals.length - 2, 1))
  const meanLag = lagged.reduce((s, v) => s + v, 0) / lagged.length
  const ssLag = lagged.reduce((s, v) => s + (v - meanLag) ** 2, 0)
  const seBeta = ssLag > 0 ? se / Math.sqrt(ssLag) : Infinity
  return seBeta > 0 ? beta / seBeta : 0
}

/**
 * Approximate ADF p-value using MacKinnon (1994) critical value table.
 * Returns p-value in [0, 1]; < 0.05 = reject unit root.
 */
function adfPValue(tStat: number): number {
  // MacKinnon 1% / 5% / 10% critical values for no-constant ADF
  if (tStat < -3.43) return 0.01
  if (tStat < -2.86) return 0.05
  if (tStat < -2.57) return 0.10
  if (tStat < -1.94) return 0.20
  return 0.50
}

/** Estimate mean-reversion half-life via AR(1) on spread. */
function halfLifeFromSpread(spread: number[]): number {
  const n = spread.length
  if (n < 3) return Infinity
  const y = spread.slice(1)
  const x = spread.slice(0, -1)
  const { beta } = ols(y, x)
  // AR(1): spread_t = beta * spread_{t-1} + eps
  // half-life = -ln(2) / ln(beta)
  if (beta <= 0 || beta >= 1) return Infinity
  return -Math.LN2 / Math.log(beta)
}

/**
 * Engle-Granger two-step cointegration test for a pair (pricesA, pricesB).
 * Both series must be the same length and in chronological order.
 */
export function testCointegration(
  pricesA: number[],
  pricesB: number[],
  options: { minHalfLife?: number; maxHalfLife?: number; pValueThreshold?: number } = {},
): CointegrationResult {
  const { minHalfLife = 1, maxHalfLife = 500, pValueThreshold = 0.10 } = options
  const n = Math.min(pricesA.length, pricesB.length)
  if (n < 30) {
    return { adfTStat: 0, pValue: 1, hedgeRatio: 1, halfLife: Infinity, spreadMean: 0, spreadStd: 0, isCointegrated: false }
  }

  const a = pricesA.slice(-n)
  const b = pricesB.slice(-n)

  // Step 1: OLS regression to get hedge ratio
  const { beta: hedgeRatio, residuals: spread } = ols(a, b)

  // Step 2: ADF test on residuals
  const tStat = adfTStat(spread)
  const pValue = adfPValue(tStat)

  // Step 3: half-life
  const halfLife = halfLifeFromSpread(spread)

  const spreadMean = spread.reduce((s, v) => s + v, 0) / spread.length
  const spreadVar = spread.reduce((s, v) => s + (v - spreadMean) ** 2, 0) / spread.length
  const spreadStd = Math.sqrt(spreadVar)

  const isCointegrated =
    pValue <= pValueThreshold &&
    halfLife >= minHalfLife &&
    halfLife <= maxHalfLife &&
    spreadStd > 0

  return { adfTStat: tStat, pValue, hedgeRatio, halfLife, spreadMean, spreadStd, isCointegrated }
}
