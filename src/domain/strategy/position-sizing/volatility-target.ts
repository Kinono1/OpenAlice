/**
 * Volatility-Target Position Sizing.
 *
 * Practitioner-optimized parameters for crypto:
 *   - baselineVolOfVol: 15 (was 35, too conservative for crypto)
 *   - vol scaling floor: 0.25 (prevents near-zero sizing)
 *   - Garman-Klass and Parkinson vol estimators included
 */

import { clamp } from '../factors/helpers.js'

export function volatilityTargetSize(
  targetVolPct: number,
  currentVolPct: number,
  maxPct = 0.3,
  volOfVolPct?: number,
  baselineVolOfVol = 15,
  minVolFloor = 0.25,
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

  if (currentVolPct < 20) {
    return clamp(targetVolPct / 20, minVolFloor, maxPct)
  }

  let size = targetVolPct / currentVolPct

  if (typeof volOfVolPct === 'number' && Number.isFinite(volOfVolPct) && volOfVolPct > 0) {
    const excessVolOfVol = Math.max(0, volOfVolPct - baselineVolOfVol)
    size *= 1 / (1 + excessVolOfVol / Math.max(baselineVolOfVol * 2, 1e-6))
  }

  return clamp(size, minVolFloor, maxPct)
}

export function computeGarmanKlassVol(
  open: number,
  high: number,
  low: number,
  close: number,
): number {
  if (open <= 0) return 0
  const logHo = Math.log(high / open)
  const logLo = Math.log(low / open)
  const logCo = Math.log(close / open)
  const variance = 0.5 * (logHo - logLo) ** 2 - (2 * Math.log(2) - 1) * logCo ** 2
  return Math.sqrt(Math.max(0, variance))
}

export function computeParkinsonVol(high: number, low: number): number {
  if (high <= 0 || low <= 0) return 0
  const logHl = Math.log(high / low)
  return logHl / (2 * Math.sqrt(Math.log(2)))
}
