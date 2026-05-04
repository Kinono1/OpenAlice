import type {
  ConfidenceBreakdown,
  GovernanceContext,
  SignalScore,
  SentimentCrowding,
  SourceTier,
  UseType,
  DecisionStrength,
} from './types.js'

const SOURCE_QUALITY_SCORE: Record<SourceTier, number> = {
  L1: 25,
  L2: 20,
  L3: 15,
  L4: 10,
  L5: 5,
}

const MARKET_STRUCTURE_SCORE: Record<UseType, number> = {
  U1: 25,
  U2: 18,
  U3: 10,
  U4: 4,
}

const EXECUTION_CLARITY_SCORE: Record<DecisionStrength, number> = {
  D1: 20,
  D2: 16,
  D3: 12,
  D4: 8,
  D5: 4,
}

const SENTIMENT_ALIGNMENT_SCORE: Record<SentimentCrowding, number> = {
  'S+2': 2,
  'S+1': 6,
  S0: 10,
  'S-1': 6,
  'S-2': 2,
}

const EVENT_SAFETY_SCORE: Record<NonNullable<GovernanceContext['eventSeverity']>, number> = {
  none: 20,
  low: 16,
  medium: 10,
  high: 4,
}

export function computeConfidenceBreakdown(
  signalScore: SignalScore,
  context: GovernanceContext = {},
): ConfidenceBreakdown {
  const staleDataApplied = context.staleData === true
  const eventSeverity = context.eventSeverity ?? 'none'

  const sourceQualityScore = SOURCE_QUALITY_SCORE[signalScore.sourceTier]
  const marketStructureScore = MARKET_STRUCTURE_SCORE[signalScore.useType]
  const eventSafetyScore = EVENT_SAFETY_SCORE[eventSeverity]
  const sentimentAlignmentScore = SENTIMENT_ALIGNMENT_SCORE[signalScore.sentiment]
  const baseExecutionClarity = EXECUTION_CLARITY_SCORE[signalScore.decisionStrength]
  const executionClarityScore = staleDataApplied
    ? Math.min(baseExecutionClarity, 4)
    : baseExecutionClarity

  return {
    sourceQualityScore,
    marketStructureScore,
    eventSafetyScore,
    sentimentAlignmentScore,
    executionClarityScore,
    totalScore:
      sourceQualityScore +
      marketStructureScore +
      eventSafetyScore +
      sentimentAlignmentScore +
      executionClarityScore,
  }
}
