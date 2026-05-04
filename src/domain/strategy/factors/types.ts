import type {
  DecisionStrength,
  GovernanceEvaluation,
  SentimentCrowding,
  SourceTier,
  UseType,
} from '../governance/types.js'

export interface FactorSignal {
  name: string
  role?: 'alpha' | 'conditioning_filter' | 'diagnostic'
  value: number
  confidence: number
  sourceTier: SourceTier
  decisionStrength: DecisionStrength
  metadata: Record<string, number | string | boolean | null>
}

export interface FactorEnsembleResult {
  signals: FactorSignal[]
  weights: Record<string, number>
  aggregateValue: number
  aggregateConfidence: number
  consensusScore: number
  decisionStrength: DecisionStrength
}

export interface FactorWeightConditioning {
  multiplierBySignal: Record<string, number>
  reasons?: string[]
}

export interface FactorGovernanceInput {
  sourceTier: SourceTier
  useType: UseType
  sentiment: SentimentCrowding
}

export interface FactorGovernanceResult extends FactorEnsembleResult {
  governance: GovernanceEvaluation
}
