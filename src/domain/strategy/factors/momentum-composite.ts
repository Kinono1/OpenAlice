import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface MomentumCompositeInput {
  return1hPct: number
  return6hPct: number
  return24hPct: number
  return7dPct: number
  realizedVolPct?: number
  /** Fallback vol (annualized %) when realizedVolPct is missing. Default 8. */
  fallbackVolPct?: number
}

export function evaluateMomentumComposite(
  input: MomentumCompositeInput,
): FactorSignal {
  const weightedScore =
    input.return1hPct * 0.15 +
    input.return6hPct * 0.2 +
    input.return24hPct * 0.3 +
    input.return7dPct * 0.35
  const weightedHorizonHours = 1 * 0.15 + 6 * 0.2 + 24 * 0.3 + 168 * 0.35
  const fallbackVol =
    typeof input.fallbackVolPct === 'number' && Number.isFinite(input.fallbackVolPct) && input.fallbackVolPct > 0
      ? input.fallbackVolPct
      : 8
  const horizonVolPct =
    typeof input.realizedVolPct === 'number' && Number.isFinite(input.realizedVolPct) && input.realizedVolPct > 0
      ? input.realizedVolPct / Math.sqrt((24 * 365) / weightedHorizonHours)
      : fallbackVol
  const standardErrorPct = Math.max(horizonVolPct, 0.25)
  const tStat = weightedScore / standardErrorPct
  const normalized = Math.tanh(tStat / 3)
  const confidence = clamp(Math.abs(normalized), 0, 1)

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
      weightedHorizonHours,
      standardErrorPct,
      tStat,
    },
  })
}
