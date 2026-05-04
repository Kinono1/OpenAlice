import type { DecisionStrength, SourceTier } from '../governance/types.js'
import type { FactorSignal } from './types.js'

/**
 * Safe division. Returns fallback (default 0) when denominator is zero,
 * NaN, or Infinity. Prevents NaN propagation through factor calculations.
 *
 * Do NOT blindly replace all "/" with safeDivide.
 * Each factor needs individual fallback semantics audit.
 */
export function safeDivide(num: number, denom: number, fallback = 0): number {
  if (!Number.isFinite(num) || !Number.isFinite(denom) || denom === 0) return fallback
  const result = num / denom
  return Number.isFinite(result) ? result : fallback
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function safeZScore(
  value: number,
  mean: number,
  stdDev: number,
): number {
  if (!Number.isFinite(stdDev) || stdDev <= 1e-12) {
    return 0
  }
  return (value - mean) / stdDev
}

export function winsorizedPercentileRank(
  value: number,
  history: number[],
  lowerTail = 0.01,
  upperTail = 0.99,
): number | null {
  const values = history.filter(Number.isFinite).sort((a, b) => a - b)
  if (values.length < 10 || !Number.isFinite(value)) {
    return null
  }

  const lower = quantileSorted(values, lowerTail)
  const upper = quantileSorted(values, upperTail)
  const winsorized = values.map((item) => clamp(item, lower, upper))
  const clippedValue = clamp(value, lower, upper)
  const less = winsorized.filter((item) => item < clippedValue).length
  const equal = winsorized.filter((item) => item === clippedValue).length
  return clamp((less + equal / 2) / winsorized.length, 0, 1)
}

export function detectPeggedPercentileRegime(input: {
  current: number
  history: number[]
  lookback?: number
  extremeRank?: number
}): { pegged: boolean; direction: -1 | 0 | 1; consecutiveExtreme: number } {
  const lookback = Math.max(2, Math.floor(input.lookback ?? 6))
  const extremeRank = clamp(input.extremeRank ?? 0.9, 0.5, 0.999)
  const series = [...input.history.filter(Number.isFinite), input.current]
  if (series.length < lookback + 10 || !Number.isFinite(input.current)) {
    return { pegged: false, direction: 0, consecutiveExtreme: 0 }
  }

  const recent = series.slice(-lookback)
  const direction = Math.sign(input.current) as -1 | 0 | 1
  if (direction === 0 || recent.some((item) => Math.sign(item) !== direction)) {
    return { pegged: false, direction: 0, consecutiveExtreme: 0 }
  }

  let consecutiveExtreme = 0
  for (let index = series.length - lookback; index < series.length; index += 1) {
    const value = series[index]
    const prior = series.slice(0, index)
    const rank = winsorizedPercentileRank(value, prior)
    const isExtreme = direction > 0
      ? rank !== null && rank >= extremeRank
      : rank !== null && rank <= 1 - extremeRank
    if (!isExtreme) {
      return { pegged: false, direction: 0, consecutiveExtreme }
    }
    consecutiveExtreme += 1
  }

  return { pegged: true, direction, consecutiveExtreme }
}

export function quantile(values: number[], q: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length === 0) return 0
  return quantileSorted(sorted, q)
}

function quantileSorted(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  const position = clamp(q, 0, 1) * (sorted.length - 1)
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  const weight = position - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

export function decisionStrengthFromMagnitude(magnitude: number): DecisionStrength {
  if (magnitude >= 0.85) return 'D1'
  if (magnitude >= 0.65) return 'D2'
  if (magnitude >= 0.45) return 'D3'
  if (magnitude >= 0.25) return 'D4'
  return 'D5'
}

export function buildFactorSignal(input: {
  name: string
  rawValue: number
  rawConfidence: number
  role?: FactorSignal['role']
  sourceTier?: SourceTier
  metadata?: Record<string, number | string | boolean | null>
}): FactorSignal {
  const value = clamp(input.rawValue, -1, 1)
  const confidence = clamp(input.rawConfidence, 0, 1)
  const magnitude = Math.abs(value) * confidence
  return {
    name: input.name,
    role: input.role ?? 'alpha',
    value,
    confidence,
    sourceTier: input.sourceTier ?? 'L2',
    decisionStrength: decisionStrengthFromMagnitude(magnitude),
    metadata: input.metadata ?? {},
  }
}

export function decisionStrengthWeight(decisionStrength: DecisionStrength): number {
  switch (decisionStrength) {
    case 'D1':
      return 1
    case 'D2':
      return 0.8
    case 'D3':
      return 0.6
    case 'D4':
      return 0.3
    case 'D5':
      return 0
  }
}
