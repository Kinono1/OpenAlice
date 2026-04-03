import { buildFactorSignal, clamp } from './helpers.js'
import type { FactorSignal } from './types.js'

export interface VolumeSurgeFactorInput {
  currentVolume: number
  averageVolume: number
  priceReturnPct: number
}

export function evaluateVolumeSurgeFactor(
  input: VolumeSurgeFactorInput,
): FactorSignal {
  const surgeRatio =
    input.averageVolume > 0 ? input.currentVolume / input.averageVolume : 0
  const surgeStrength = clamp((surgeRatio - 1) / 2, 0, 1)
  const returnStrength = clamp(Math.abs(input.priceReturnPct) / 5, 0, 1)
  const direction = input.priceReturnPct >= 0 ? 1 : -1
  const value = clamp(direction * Math.max(surgeStrength, returnStrength), -1, 1)
  const confidence = clamp((surgeStrength + returnStrength) / 2, 0, 1)

  return buildFactorSignal({
    name: 'volume-surge',
    rawValue: value,
    rawConfidence: confidence,
    metadata: {
      currentVolume: input.currentVolume,
      averageVolume: input.averageVolume,
      surgeRatio,
      priceReturnPct: input.priceReturnPct,
    },
  })
}
