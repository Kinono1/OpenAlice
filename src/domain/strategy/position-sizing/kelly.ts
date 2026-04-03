import { clamp } from '../factors/helpers.js'

export function fractionalKelly(
  winRate: number,
  avgWinLossRatio: number,
  fraction = 0.15,
): number {
  const p = clamp(winRate, 0, 1)
  const b = Math.max(avgWinLossRatio, 1e-6)
  const rawKelly = p - (1 - p) / b
  return clamp(rawKelly * fraction, 0, 1)
}
