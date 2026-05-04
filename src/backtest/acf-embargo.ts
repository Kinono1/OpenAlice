export interface AcfEmbargoInput {
  factorSeries: number[][]
  minEmbargoBars?: number
  maxEmbargoBars?: number
  acfDecayThreshold?: number
}

export interface AcfEmbargoResult {
  embargoBars: number
  perFactorLags: number[]
  method: 'acf_adaptive'
}

export function computeAcfEmbargo(input: AcfEmbargoInput): AcfEmbargoResult {
  const minBars = input.minEmbargoBars ?? 24
  const maxBars = input.maxEmbargoBars ?? 72
  const threshold = input.acfDecayThreshold ?? 0.05

  const perFactorLags: number[] = []

  for (const series of input.factorSeries) {
    const lag = findAcfDecayLag(series, threshold, maxBars)
    perFactorLags.push(lag)
  }

  const maxLag = perFactorLags.length > 0 ? Math.max(...perFactorLags) : minBars
  const embargoBars = Math.min(Math.max(maxLag, minBars), maxBars)

  return { embargoBars, perFactorLags, method: 'acf_adaptive' }
}

function findAcfDecayLag(series: number[], threshold: number, maxLag: number): number {
  if (series.length < 10) return 1

  const mean = series.reduce((s, v) => s + v, 0) / series.length
  const variance = series.reduce((s, v) => s + (v - mean) ** 2, 0) / series.length
  if (variance < 1e-12) return 1

  for (let lag = 1; lag <= Math.min(maxLag, Math.floor(series.length / 3)); lag++) {
    let cov = 0
    const n = series.length - lag
    for (let i = 0; i < n; i++) {
      cov += (series[i] - mean) * (series[i + lag] - mean)
    }
    cov /= n
    const acf = cov / variance
    if (Math.abs(acf) < threshold) return lag
  }

  return maxLag
}
