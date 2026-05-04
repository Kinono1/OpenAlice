import type { DecisionStrength, SourceTier } from '../governance/types.js'
import type { FactorSignal } from './types.js'

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
  sourceTier?: SourceTier
  metadata?: Record<string, number>
}): FactorSignal {
  const value = clamp(input.rawValue, -1, 1)
  const confidence = clamp(input.rawConfidence, 0, 1)
  const magnitude = Math.abs(value) * confidence
  return {
    name: input.name,
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
