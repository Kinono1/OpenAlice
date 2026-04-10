export type SourceTier = 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
export type UseType = 'U1' | 'U2' | 'U3' | 'U4'
export type DecisionStrength = 'D1' | 'D2' | 'D3' | 'D4' | 'D5'
export type SentimentCrowding = 'S+2' | 'S+1' | 'S0' | 'S-1' | 'S-2'
export type ActionStatus =
  | 'attack'
  | 'attack-lite'
  | 'probe'
  | 'hold'
  | 'reduce'
  | 'exit'
  | 'no-trade'

export interface SignalScore {
  sourceTier: SourceTier
  useType: UseType
  decisionStrength: DecisionStrength
  sentiment: SentimentCrowding
}

export interface ConfidenceBreakdown {
  sourceQualityScore: number
  marketStructureScore: number
  eventSafetyScore: number
  sentimentAlignmentScore: number
  executionClarityScore: number
  totalScore: number
}

export interface GovernanceContext {
  staleData?: boolean
  eventWindowFrozen?: boolean
  eventSeverity?: 'high' | 'medium' | 'low' | 'none'
  maxActionDuringFreeze?: Extract<ActionStatus, 'reduce' | 'exit' | 'no-trade' | 'hold'>
  preferReduceOnWeakSignal?: boolean
}

export interface GovernanceEvaluation {
  breakdown: ConfidenceBreakdown
  actionStatus: ActionStatus
  baseActionStatus: Exclude<ActionStatus, 'reduce' | 'exit'>
  cappedByEventWindow: boolean
  staleDataApplied: boolean
  context: {
    eventWindowFrozen: boolean
    eventSeverity: 'high' | 'medium' | 'low' | 'none'
  }
}
