import { clamp } from '../factors/helpers.js'

export function volatilityTargetSize(
  targetVolPct: number,
  currentVolPct: number,
  maxPct = 0.3,
): number {
  if (!Number.isFinite(targetVolPct) || targetVolPct <= 0) {
    throw new Error('targetVolPct must be > 0')
  }
  if (!Number.isFinite(currentVolPct) || currentVolPct <= 0) {
    throw new Error('currentVolPct must be > 0')
  }
  if (!Number.isFinite(maxPct) || maxPct <= 0) {
    throw new Error('maxPct must be > 0')
  }

  return clamp(targetVolPct / currentVolPct, 0, maxPct)
}
