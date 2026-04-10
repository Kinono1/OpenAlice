import type { StrategyExecutionDecision } from '../runtime-types.js'
import type { RuntimeFactorSnapshot } from '../runtime-evaluator.js'

export interface MetaLabelFeatureVector {
  names: string[]
  values: number[]
  record: Record<string, number>
}

export function buildMetaLabelFeatureVector(input: {
  snapshot: RuntimeFactorSnapshot
  decision?: StrategyExecutionDecision
}): MetaLabelFeatureVector {
  const { snapshot, decision } = input
  const featureEntries: Array<[string, number]> = [
    ['ensemble-value', snapshot.ensemble.aggregateValue],
    ['ensemble-confidence', snapshot.ensemble.aggregateConfidence],
    ['consensus-score', snapshot.ensemble.consensusScore],
    ['governance-total-score', snapshot.governance.breakdown.totalScore],
    ['source-quality-score', snapshot.governance.breakdown.sourceQualityScore],
    ['market-structure-score', snapshot.governance.breakdown.marketStructureScore],
    ['event-safety-score', snapshot.governance.breakdown.eventSafetyScore],
    ['execution-clarity-score', snapshot.governance.breakdown.executionClarityScore],
    ['regime-confidence', snapshot.regimeEvaluation?.confidence ?? 0],
    ['hmm-confidence', snapshot.hmmRegime?.confidence ?? 0],
    ['hmm-stress-prob', snapshot.hmmRegime?.stateProbs[3] ?? 0],
    ['return-1h-pct', snapshot.derivedMetrics.return1hPct],
    ['return-24h-pct', snapshot.derivedMetrics.return24hPct],
    ['realized-vol-pct', snapshot.derivedMetrics.realizedVolPct],
    ['position-sizing-pct', snapshot.positionSizing.recommendedPctOfEquity],
    ['freeze-active', snapshot.freeze.active ? 1 : 0],
    ['decision-mode-applied', decision?.mode === 'applied' ? 1 : 0],
    ['decision-mode-blocked', decision?.mode === 'blocked' ? 1 : 0],
    ['decision-requested-notional', decision?.requestedNotionalUsd ?? 0],
    ['decision-effective-notional', decision?.effectiveNotionalUsd ?? 0],
  ]

  return {
    names: featureEntries.map(([name]) => name),
    values: featureEntries.map(([, value]) => value),
    record: Object.fromEntries(featureEntries),
  }
}
