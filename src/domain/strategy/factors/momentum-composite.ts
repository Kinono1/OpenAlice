import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface MomentumCompositeInput {
  return1hPct: number
  return6hPct: number
  return24hPct: number
  return7dPct: number
  realizedVolPct?: number
}

export function evaluateMomentumComposite(
  input: MomentumCompositeInput,
): FactorSignal {
  const weightedScore =
    input.return1hPct * 0.15 +
    input.return6hPct * 0.2 +
    input.return24hPct * 0.3 +
    input.return7dPct * 0.35
  const normalized = clamp(weightedScore / 8, -1, 1)
  const volPenalty =
    typeof input.realizedVolPct === 'number'
      ? clamp(1 - input.realizedVolPct / 20, 0.2, 1)
      : 1
  const confidence = clamp(Math.abs(normalized) * volPenalty, 0, 1)

  return buildFactorSignal({
    name: 'momentum-composite',
    rawValue: normalized,
    rawConfidence: confidence,
    metadata: {
      return1hPct: input.return1hPct,
      return6hPct: input.return6hPct,
      return24hPct: input.return24hPct,
      return7dPct: input.return7dPct,
      realizedVolPct: input.realizedVolPct ?? 0,
      weightedScore,
      volPenalty,
    },
  })
}
