export interface CandidatePruningInput {
  candidateReturns: number[][]
  subsampleRatio?: number
  subsampleRounds?: number
}

export interface CandidatePruningResult {
  totalGeneratedCandidates: number
  prunedCandidates: number
  survivingIndices: number[]
  effectiveTrialCount: number
}

export function pruneCandidates(input: CandidatePruningInput): CandidatePruningResult {
  const { candidateReturns } = input
  const ratio = input.subsampleRatio ?? 0.5
  const rounds = input.subsampleRounds ?? 10
  const total = candidateReturns.length

  if (total < 2) {
    return {
      totalGeneratedCandidates: total,
      prunedCandidates: 0,
      survivingIndices: candidateReturns.map((_, i) => i),
      effectiveTrialCount: total,
    }
  }

  const survivingIndices: number[] = []

  for (let i = 0; i < total; i++) {
    const returns = candidateReturns[i]
    const medianSharpe = computeMedianSubsampleSharpe(returns, ratio, rounds, i)
    if (medianSharpe > 0) {
      survivingIndices.push(i)
    }
  }

  return {
    totalGeneratedCandidates: total,
    prunedCandidates: total - survivingIndices.length,
    survivingIndices,
    effectiveTrialCount: total,
  }
}

function computeMedianSubsampleSharpe(
  returns: number[],
  ratio: number,
  rounds: number,
  seed: number,
): number {
  const sampleSize = Math.max(2, Math.floor(returns.length * ratio))
  const sharpes: number[] = []

  for (let r = 0; r < rounds; r++) {
    const sample = deterministicSample(returns, sampleSize, seed * 1000 + r)
    sharpes.push(simpleSharpe(sample))
  }

  sharpes.sort((a, b) => a - b)
  return sharpes[Math.floor(sharpes.length / 2)]
}

function deterministicSample(values: number[], size: number, seed: number): number[] {
  const result: number[] = []
  let state = (seed + 1) * 2654435761 >>> 0
  for (let i = 0; i < size; i++) {
    state = (1664525 * state + 1013904223) >>> 0
    const idx = state % values.length
    result.push(values[idx])
  }
  return result
}

function simpleSharpe(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length
  return variance > 0 ? mean / Math.sqrt(variance) : 0
}
