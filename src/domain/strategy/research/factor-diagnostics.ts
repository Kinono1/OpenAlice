import { spearmanIc, analyzeInformationCoefficient } from './ic-analyzer.js'
import type { IcSample, IcSummary } from './ic-analyzer.js'

export interface FactorTimeSeries {
  name: string
  values: number[]
  timestamps: number[]
}

export interface FactorDiagnosticsInput {
  factors: FactorTimeSeries[]
  returns: { values: number[]; timestamps: number[] }
  icHorizons: number[]
  minSamples: number
}

export interface PairwiseCorrelation {
  factorA: string
  factorB: string
  spearmanRho: number
}

export interface FactorIcProfile {
  factorName: string
  horizonBars: number
  ic: IcSummary
}

export interface AblationResult {
  removedFactor: string
  ensembleSharpe: number
  baselineSharpe: number
  marginalContribution: number
}

export interface FactorDiagnosticsReport {
  correlationMatrix: PairwiseCorrelation[]
  icProfiles: FactorIcProfile[]
  ablationResults: AblationResult[]
  redundantPairs: PairwiseCorrelation[]
  effectiveFactorCount: number
}

function rankArray(values: number[]): number[] {
  const pairs = values.map((v, i) => ({ v, i }))
  pairs.sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length).fill(0)
  let cursor = 0
  while (cursor < pairs.length) {
    let next = cursor + 1
    while (next < pairs.length && pairs[next].v === pairs[cursor].v) {
      next += 1
    }
    const avg = (cursor + next - 1) / 2 + 1
    for (let k = cursor; k < next; k++) {
      ranks[pairs[k].i] = avg
    }
    cursor = next
  }
  return ranks
}

function pearson(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return 0
  const mx = x.reduce((s, v) => s + v, 0) / x.length
  const my = y.reduce((s, v) => s + v, 0) / y.length
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < x.length; i++) {
    const cx = x[i] - mx, cy = y[i] - my
    num += cx * cy
    dx += cx * cx
    dy += cy * cy
  }
  const den = Math.sqrt(dx * dy)
  return den > 0 ? num / den : 0
}

function spearmanRho(a: number[], b: number[]): number {
  return pearson(rankArray(a), rankArray(b))
}

function alignTimeSeries(
  factor: FactorTimeSeries,
  returns: { values: number[]; timestamps: number[] },
  horizonBars: number,
): IcSample[] {
  const hourMs = 60 * 60 * 1000
  const horizonMs = horizonBars * hourMs
  const samples: IcSample[] = []

  for (let i = 0; i < factor.values.length; i++) {
    const sigTs = factor.timestamps[i]
    const forwardReturn = computeForwardReturn(returns, sigTs, horizonMs, hourMs)
    if (forwardReturn != null) {
      samples.push({
        factorValue: factor.values[i],
        forwardReturn,
        bucketKey: horizonBars,
      })
    }
  }
  return samples
}

function computeForwardReturn(
  returns: { values: number[]; timestamps: number[] },
  signalTimestampMs: number,
  horizonMs: number,
  barMs: number,
): number | null {
  const targetTs = signalTimestampMs + horizonMs
  const endIdx = returns.timestamps.findIndex(
    (timestamp) => Math.abs(timestamp - targetTs) < barMs * 0.5,
  )
  if (endIdx < 0) return null

  let compounded = 1
  let sampleCount = 0
  const endTs = returns.timestamps[endIdx]
  for (let index = 0; index <= endIdx; index += 1) {
    const timestamp = returns.timestamps[index]
    const value = returns.values[index]
    if (
      timestamp > signalTimestampMs &&
      timestamp <= endTs &&
      Number.isFinite(value)
    ) {
      compounded *= 1 + value
      sampleCount += 1
    }
  }

  return sampleCount > 0 ? compounded - 1 : null
}

function computeSimpleSharpe(returns: number[]): number {
  if (returns.length < 2) return 0
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length
  return variance > 0 ? mean / Math.sqrt(variance) : 0
}

function eigenvalueEntropy(correlations: PairwiseCorrelation[], factorNames: string[]): number {
  const n = factorNames.length
  if (n <= 1) return n

  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) matrix[i][i] = 1

  for (const c of correlations) {
    const ai = factorNames.indexOf(c.factorA)
    const bi = factorNames.indexOf(c.factorB)
    if (ai >= 0 && bi >= 0) {
      matrix[ai][bi] = c.spearmanRho
      matrix[bi][ai] = c.spearmanRho
    }
  }

  const eigenvalues = estimateEigenvalues(matrix)
  const total = eigenvalues.reduce((s, v) => s + Math.max(v, 0), 0)
  if (total <= 0) return 1

  let entropy = 0
  for (const ev of eigenvalues) {
    const p = Math.max(ev, 0) / total
    if (p > 1e-12) entropy -= p * Math.log(p)
  }
  return Math.exp(entropy)
}

function estimateEigenvalues(matrix: number[][]): number[] {
  const n = matrix.length
  const eigenvalues: number[] = []
  for (let i = 0; i < n; i++) {
    eigenvalues.push(matrix[i].reduce((s, v) => s + Math.abs(v), 0))
  }
  return eigenvalues.sort((a, b) => b - a)
}

export function runFactorDiagnostics(input: FactorDiagnosticsInput): FactorDiagnosticsReport {
  const { factors, returns, icHorizons, minSamples } = input
  const factorNames = factors.map((f) => f.name)

  const correlationMatrix: PairwiseCorrelation[] = []
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const a = factors[i], b = factors[j]
      const minLen = Math.min(a.values.length, b.values.length)
      const rho = spearmanRho(
        a.values.slice(-minLen),
        b.values.slice(-minLen),
      )
      correlationMatrix.push({ factorA: a.name, factorB: b.name, spearmanRho: rho })
    }
  }

  const icProfiles: FactorIcProfile[] = []
  for (const factor of factors) {
    for (const horizon of icHorizons) {
      const samples = alignTimeSeries(factor, returns, horizon)
      if (samples.length < minSamples) continue
      const ic = analyzeInformationCoefficient(samples)
      icProfiles.push({ factorName: factor.name, horizonBars: horizon, ic })
    }
  }

  const ablationResults: AblationResult[] = []
  if (factors.length >= 2 && returns.values.length >= minSamples) {
    const baselineReturns = computeEnsembleReturns(factors, returns)
    const baselineSharpe = computeSimpleSharpe(baselineReturns)

    for (const removedFactor of factors) {
      const remaining = factors.filter((f) => f.name !== removedFactor.name)
      const ablatedReturns = computeEnsembleReturns(remaining, returns)
      const ablatedSharpe = computeSimpleSharpe(ablatedReturns)
      ablationResults.push({
        removedFactor: removedFactor.name,
        ensembleSharpe: ablatedSharpe,
        baselineSharpe,
        marginalContribution: baselineSharpe - ablatedSharpe,
      })
    }
  }

  const redundantPairs = correlationMatrix.filter((c) => Math.abs(c.spearmanRho) > 0.5)
  const effectiveFactorCount = eigenvalueEntropy(correlationMatrix, factorNames)

  return {
    correlationMatrix,
    icProfiles,
    ablationResults,
    redundantPairs,
    effectiveFactorCount,
  }
}

function computeEnsembleReturns(
  factors: FactorTimeSeries[],
  returns: { values: number[]; timestamps: number[] },
): number[] {
  const minLen = Math.min(
    ...factors.map((f) => f.values.length),
    returns.values.length,
  )
  const result: number[] = []
  for (let i = 0; i < minLen; i++) {
    const signal = factors.reduce((s, f) => s + f.values[f.values.length - minLen + i], 0) / factors.length
    const direction = signal > 0 ? 1 : signal < 0 ? -1 : 0
    result.push(direction * returns.values[returns.values.length - minLen + i])
  }
  return result
}
