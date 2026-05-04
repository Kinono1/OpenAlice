import type { FactorTimeSeries } from './factor-diagnostics.js'

export interface DecorrelationWeights {
  weights: Record<string, number>
  effectiveNumberOfBets: number
  eigenvalues: number[]
  calibratedAt: string
}

export function calibrateDecorrelationWeights(
  factors: FactorTimeSeries[],
): DecorrelationWeights {
  const n = factors.length
  if (n === 0) {
    return { weights: {}, effectiveNumberOfBets: 0, eigenvalues: [], calibratedAt: new Date().toISOString() }
  }
  if (n === 1) {
    return {
      weights: { [factors[0].name]: 1 },
      effectiveNumberOfBets: 1,
      eigenvalues: [1],
      calibratedAt: new Date().toISOString(),
    }
  }

  const minLen = Math.min(...factors.map((f) => f.values.length))
  const matrix = buildCorrelationMatrix(factors, minLen)
  const eigenvalues = estimateEigenvaluesGershgorin(matrix)
  const enb = computeEnb(eigenvalues)

  const weights: Record<string, number> = {}
  for (let i = 0; i < n; i++) {
    const rowAbsSum = matrix[i].reduce((s, v, j) => s + (i === j ? 0 : Math.abs(v)), 0)
    const isolation = 1 / (1 + rowAbsSum / (n - 1))
    weights[factors[i].name] = isolation
  }

  const totalWeight = Object.values(weights).reduce((s, v) => s + v, 0)
  if (totalWeight > 0) {
    for (const key of Object.keys(weights)) {
      weights[key] /= totalWeight
      weights[key] *= n
    }
  }

  return {
    weights,
    effectiveNumberOfBets: enb,
    eigenvalues,
    calibratedAt: new Date().toISOString(),
  }
}

function buildCorrelationMatrix(factors: FactorTimeSeries[], minLen: number): number[][] {
  const n = factors.length
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) matrix[i][i] = 1

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = factors[i].values.slice(-minLen)
      const b = factors[j].values.slice(-minLen)
      const rho = spearman(a, b)
      matrix[i][j] = rho
      matrix[j][i] = rho
    }
  }
  return matrix
}

function spearman(a: number[], b: number[]): number {
  const ra = rank(a), rb = rank(b)
  return pearson(ra, rb)
}

function rank(values: number[]): number[] {
  const pairs = values.map((v, i) => ({ v, i }))
  pairs.sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length).fill(0)
  let c = 0
  while (c < pairs.length) {
    let j = c + 1
    while (j < pairs.length && pairs[j].v === pairs[c].v) j++
    const avg = (c + j - 1) / 2 + 1
    for (let k = c; k < j; k++) ranks[pairs[k].i] = avg
    c = j
  }
  return ranks
}

function pearson(x: number[], y: number[]): number {
  const n = x.length
  if (n < 2) return 0
  const mx = x.reduce((s, v) => s + v, 0) / n
  const my = y.reduce((s, v) => s + v, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    const cx = x[i] - mx, cy = y[i] - my
    num += cx * cy; dx += cx * cx; dy += cy * cy
  }
  const den = Math.sqrt(dx * dy)
  return den > 0 ? num / den : 0
}

function estimateEigenvaluesGershgorin(matrix: number[][]): number[] {
  return matrix.map((row, i) => {
    const radius = row.reduce((s, v, j) => s + (i === j ? 0 : Math.abs(v)), 0)
    return Math.max(row[i] + radius, 0)
  }).sort((a, b) => b - a)
}

function computeEnb(eigenvalues: number[]): number {
  const total = eigenvalues.reduce((s, v) => s + Math.max(v, 0), 0)
  if (total <= 0) return 1
  let entropy = 0
  for (const ev of eigenvalues) {
    const p = Math.max(ev, 0) / total
    if (p > 1e-12) entropy -= p * Math.log(p)
  }
  return Math.exp(entropy)
}
