import { buildFactorSignal } from './helpers.js'
import { evaluateMomentumComposite, type MomentumCompositeInput } from './momentum-composite.js'
import type { FactorSignal } from './types.js'

export function evaluateMeanReversion(
  input: MomentumCompositeInput,
): FactorSignal {
  const momentum = evaluateMomentumComposite(input)
  return buildFactorSignal({
    name: 'mean-reversion',
    rawValue: -momentum.value,
    rawConfidence: momentum.confidence,
    metadata: {
      baseMomentumValue: momentum.value,
      baseMomentumConfidence: momentum.confidence,
      ...momentum.metadata,
    },
  })
}
