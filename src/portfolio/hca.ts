/**
 * Hierarchical Clustering Allocation (HCA) — risk-parity via recursive bisection.
 *
 * Based on López de Prado (2016) "Building Diversified Portfolios that Outperform Out-of-Sample".
 * Distance metric: d_ij = sqrt(0.5 * (1 - ρ_ij))
 */

export interface HCAResult {
  /** Risk-budget weights in [0, 1], sum = 1 */
  weights: Record<string, number>
  /** Dendrogram linkage order (leaf indices) */
  sortedOrder: number[]
  /** Correlation matrix used */
  correlationMatrix: number[][]
}

/** Pearson correlation matrix from return series. */
function correlationMatrix(returnsByAsset: Record<string, number[]>): { assets: string[]; matrix: number[][] } {
  const assets = Object.keys(returnsByAsset)
  const n = assets.length
  const matrix: number[][] = Array.from({ length: n }, () => new Array(n).fill(0))

  for (let i = 0; i < n; i++) {
    matrix[i]![i] = 1
    for (let j = i + 1; j < n; j++) {
      const xi = returnsByAsset[assets[i]!]!
      const xj = returnsByAsset[assets[j]!]!
      const len = Math.min(xi.length, xj.length)
      const a = xi.slice(-len)
      const b = xj.slice(-len)
      const meanA = a.reduce((s, v) => s + v, 0) / len
      const meanB = b.reduce((s, v) => s + v, 0) / len
      let num = 0, da = 0, db = 0
      for (let k = 0; k < len; k++) {
        const dA = a[k]! - meanA
        const dB = b[k]! - meanB
        num += dA * dB
        da += dA * dA
        db += dB * dB
      }
      const rho = da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0
      matrix[i]![j] = rho
      matrix[j]![i] = rho
    }
  }
  return { assets, matrix }
}

/** Convert correlation to distance: d = sqrt(0.5 * (1 - rho)) */
function toDistanceMatrix(corr: number[][]): number[][] {
  return corr.map(row => row.map(rho => Math.sqrt(0.5 * (1 - rho))))
}

/** Single-linkage hierarchical clustering. Returns sorted leaf order. */
function singleLinkageSortedOrder(dist: number[][]): number[] {
  const n = dist.length
  // Quasi-diagonalization via seriation (greedy nearest-neighbor)
  const visited = new Set<number>()
  const order: number[] = [0]
  visited.add(0)

  while (order.length < n) {
    const last = order[order.length - 1]!
    let nearest = -1
    let minDist = Infinity
    for (let j = 0; j < n; j++) {
      if (!visited.has(j) && dist[last]![j]! < minDist) {
        minDist = dist[last]![j]!
        nearest = j
      }
    }
    if (nearest === -1) {
      // Pick any unvisited
      for (let j = 0; j < n; j++) {
        if (!visited.has(j)) { nearest = j; break }
      }
    }
    order.push(nearest)
    visited.add(nearest)
  }
  return order
}

/** Inverse-variance weight for a cluster of assets. */
function inverseVarianceWeights(variances: number[]): number[] {
  const invVar = variances.map(v => v > 0 ? 1 / v : 0)
  const total = invVar.reduce((s, v) => s + v, 0)
  return total > 0 ? invVar.map(v => v / total) : variances.map(() => 1 / variances.length)
}

/** Recursive bisection: allocate weight to left/right clusters by inverse variance. */
function recursiveBisection(
  sortedOrder: number[],
  variances: number[],
): number[] {
  const weights = new Array(sortedOrder.length).fill(1)

  function bisect(indices: number[], w: number): void {
    if (indices.length <= 1) return
    const mid = Math.floor(indices.length / 2)
    const left = indices.slice(0, mid)
    const right = indices.slice(mid)

    const varLeft = left.reduce((s, i) => s + variances[i]!, 0) / left.length
    const varRight = right.reduce((s, i) => s + variances[i]!, 0) / right.length
    const [wLeft, wRight] = inverseVarianceWeights([varLeft, varRight])

    for (const i of left) weights[i] *= wLeft! * w
    for (const i of right) weights[i] *= wRight! * w

    bisect(left, 1)
    bisect(right, 1)
  }

  bisect(sortedOrder, 1)
  const total = weights.reduce((s, v) => s + v, 0)
  return total > 0 ? weights.map(v => v / total) : weights.map(() => 1 / weights.length)
}

/**
 * Compute HCA risk-budget weights.
 * Returns normalized weights summing to 1 (long-only risk budget).
 */
export function computeHCAWeights(returnsByAsset: Record<string, number[]>): HCAResult {
  if (Object.keys(returnsByAsset).length < 2) throw new Error('At least 2 assets required for HCA.')
  const { assets, matrix: corrMatrix } = correlationMatrix(returnsByAsset)
  const distMatrix = toDistanceMatrix(corrMatrix)
  const sortedOrder = singleLinkageSortedOrder(distMatrix)

  // Asset variances (annualized)
  const variances = assets.map(a => {
    const r = returnsByAsset[a]!
    const mean = r.reduce((s, v) => s + v, 0) / r.length
    return r.reduce((s, v) => s + (v - mean) ** 2, 0) / r.length
  })

  const rawWeights = recursiveBisection(sortedOrder, variances)

  // Map back to asset names
  const weights: Record<string, number> = {}
  for (let i = 0; i < assets.length; i++) {
    weights[assets[i]!] = rawWeights[i]!
  }

  return { weights, sortedOrder, correlationMatrix: corrMatrix }
}
