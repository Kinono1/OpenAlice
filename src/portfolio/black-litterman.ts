/**
 * Black-Litterman model for posterior return estimation.
 *
 * He & Litterman (1999). Combines:
 *   - Prior: equilibrium returns π = δ * Σ * w_mkt
 *   - Views: P * μ = Q + ε, ε ~ N(0, Ω)
 *   - Posterior: μ_BL = [(τΣ)^-1 + P'Ω^-1P]^-1 * [(τΣ)^-1π + P'Ω^-1Q]
 */

export interface BLView {
  /** Asset names involved in this view */
  assets: string[]
  /** P row: portfolio weights for this view (e.g. [1, -1] for long A / short B) */
  weights: number[]
  /** Q: expected return for this view */
  expectedReturn: number
  /** Confidence in [0, 1]; maps to Ω diagonal entry */
  confidence: number
}

export interface BLResult {
  /** Posterior expected returns per asset */
  posteriorReturns: Record<string, number>
  /** Posterior covariance diagonal (variance per asset) */
  posteriorVariance: Record<string, number>
}

/** Minimal matrix operations (n×n dense). */
function matMul(A: number[][], B: number[][]): number[][] {
  const n = A.length, m = B[0]!.length, k = B.length
  const C = Array.from({ length: n }, () => new Array(m).fill(0))
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++)
      for (let l = 0; l < k; l++)
        C[i]![j] += A[i]![l]! * B[l]![j]!
  return C
}

function matAdd(A: number[][], B: number[][]): number[][] {
  return A.map((row, i) => row.map((v, j) => v + B[i]![j]!))
}

function matScale(A: number[][], s: number): number[][] {
  return A.map(row => row.map(v => v * s))
}

function transpose(A: number[][]): number[][] {
  return A[0]!.map((_, j) => A.map(row => row[j]!))
}

/** Gauss-Jordan matrix inversion for small n×n matrices. */
function invert(M: number[][]): number[][] {
  const n = M.length
  const aug = M.map((row, i) => {
    const id = new Array(n).fill(0)
    id[i] = 1
    return [...row, ...id]
  })
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let row = col + 1; row < n; row++)
      if (Math.abs(aug[row]![col]!) > Math.abs(aug[pivot]![col]!)) pivot = row;
    [aug[col], aug[pivot]] = [aug[pivot]!, aug[col]!]
    const div = aug[col]![col]!
    if (Math.abs(div) < 1e-12) continue
    for (let j = 0; j < 2 * n; j++) aug[col]![j]! /= div
    for (let row = 0; row < n; row++) {
      if (row === col) continue
      const factor = aug[row]![col]!
      for (let j = 0; j < 2 * n; j++) aug[row]![j]! -= factor * aug[col]![j]!
    }
  }
  return aug.map(row => row.slice(n))
}

/**
 * Compute Black-Litterman posterior returns.
 *
 * @param assets - ordered list of asset names
 * @param covMatrix - n×n covariance matrix (annualized)
 * @param mktWeights - market-cap or HCA risk-budget weights
 * @param views - analyst/factor views
 * @param tau - uncertainty scaling of prior (default 0.05)
 * @param riskAversion - δ for equilibrium returns (default 2.5)
 */
export function computeBlackLitterman(
  assets: string[],
  covMatrix: number[][],
  mktWeights: number[],
  views: BLView[],
  tau = 0.05,
  riskAversion = 2.5,
): BLResult {
  const n = assets.length

  // Prior equilibrium returns: π = δ * Σ * w
  const pi: number[] = covMatrix.map(row =>
    riskAversion * row.reduce((s, v, j) => s + v * mktWeights[j]!, 0)
  )

  if (views.length === 0) {
    return {
      posteriorReturns: Object.fromEntries(assets.map((a, i) => [a, pi[i]!])),
      posteriorVariance: Object.fromEntries(assets.map((a, i) => [a, covMatrix[i]![i]!])),
    }
  }

  const k = views.length

  // Build P matrix (k×n) and Q vector (k×1)
  const P: number[][] = Array.from({ length: k }, () => new Array(n).fill(0))
  const Q: number[] = []

  for (let v = 0; v < k; v++) {
    const view = views[v]!
    Q.push(view.expectedReturn)
    for (let ai = 0; ai < view.assets.length; ai++) {
      const idx = assets.indexOf(view.assets[ai]!)
      if (idx >= 0) P[v]![idx] = view.weights[ai]!
    }
  }

  // Ω diagonal: uncertainty = (1 - confidence) * P * τΣ * P'
  const tauSigma = matScale(covMatrix, tau)
  const Pt = transpose(P)
  const PtauSigmaPt = matMul(matMul(P, tauSigma), Pt)
  const Omega: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) =>
      i === j ? PtauSigmaPt[i]![i]! * (1 - views[i]!.confidence + 1e-6) : 0
    )
  )

  // Posterior: μ_BL = [(τΣ)^-1 + P'Ω^-1P]^-1 * [(τΣ)^-1π + P'Ω^-1Q]
  const tauSigmaInv = invert(tauSigma)
  const OmegaInv = invert(Omega)
  const PtOmegaInvP = matMul(matMul(Pt, OmegaInv), P)
  const M = invert(matAdd(tauSigmaInv, PtOmegaInvP))

  const tauSigmaInvPi = tauSigmaInv.map(row => row.reduce((s, v, j) => s + v * pi[j]!, 0))
  const OmegaInvQ = OmegaInv.map(row => row.reduce((s, v, j) => s + v * Q[j]!, 0))
  const PtOmegaInvQ = Pt.map(row => row.reduce((s, v, j) => s + v * OmegaInvQ[j]!, 0))
  const rhs = tauSigmaInvPi.map((v, i) => v + PtOmegaInvQ[i]!)
  const muBL = M.map(row => row.reduce((s, v, j) => s + v * rhs[j]!, 0))

  return {
    posteriorReturns: Object.fromEntries(assets.map((a, i) => [a, muBL[i]!])),
    posteriorVariance: Object.fromEntries(assets.map((a, i) => [a, covMatrix[i]![i]!])),
  }
}

/**
 * Convert factor signals (tStat, confidence) into BL views.
 * Each signal becomes a single-asset absolute return view.
 */
export function factorSignalsToBLViews(
  signalsByAsset: Record<string, { tStat: number; confidence: number; annualizedReturn?: number }>,
): BLView[] {
  return Object.entries(signalsByAsset).map(([asset, sig]) => ({
    assets: [asset],
    weights: [1],
    expectedReturn: sig.annualizedReturn ?? Math.tanh(sig.tStat / 3) * 0.20,
    confidence: Math.min(Math.max(sig.confidence, 0), 1),
  }))
}
