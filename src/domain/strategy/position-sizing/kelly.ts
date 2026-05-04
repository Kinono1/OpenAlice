import { clamp } from '../factors/helpers.js'

export function fractionalKelly(
  winRate: number,
  avgWinLossRatio: number,
  fraction = 0.15,
  priorFraction = 0.15,
  sampleCount = 50,
): number {
  const p = clamp(winRate, 0, 1)
  const b = Math.max(avgWinLossRatio, 1e-6)
  const rawKelly = p - (1 - p) / b
  const observedFraction = clamp(rawKelly * fraction, 0, 1)

  const shrinkageWeight = clamp(sampleCount / (sampleCount + 100), 0, 1)
  const bayesianFraction = shrinkageWeight * observedFraction + (1 - shrinkageWeight) * priorFraction

  return clamp(bayesianFraction, 0, 1)
}
