export { evaluateFundingRateFactor } from './funding-rate.js'
export { evaluateBasisFactor } from './basis.js'
export { evaluateVolumeSurgeFactor } from './volume-surge.js'
export { evaluateMomentumComposite } from './momentum-composite.js'
export { combineFactorSignals, combineFactorSignalsWithGovernance } from './ensemble.js'
export type {
  FactorEnsembleResult,
  FactorGovernanceInput,
  FactorGovernanceResult,
  FactorSignal,
} from './types.js'
export type { FundingRateFactorInput } from './funding-rate.js'
export type { BasisFactorInput } from './basis.js'
export type { VolumeSurgeFactorInput } from './volume-surge.js'
export type { MomentumCompositeInput } from './momentum-composite.js'
