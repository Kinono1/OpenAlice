import { evaluateSignalGovernance } from '../governance/index.js'
import { clamp, decisionStrengthFromMagnitude, decisionStrengthWeight } from './helpers.js'
import type {
  FactorEnsembleResult,
  FactorGovernanceInput,
  FactorGovernanceResult,
  FactorSignal,
} from './types.js'

export function combineFactorSignals(
  signals: FactorSignal[],
  weights: Record<string, number> = {},
): FactorEnsembleResult {
  if (signals.length === 0) {
    return {
      signals: [],
      weights: {},
      aggregateValue: 0,
      aggregateConfidence: 0,
      consensusScore: 0,
      decisionStrength: 'D5',
    }
  }

  const weightedSignals = signals.map((signal) => {
    const configWeight = weights[signal.name] ?? 1
    const weight = decisionStrengthWeight(signal.decisionStrength) * Math.max(configWeight, 0)
    return {
      signal,
      weight,
    }
  })
  const totalWeight = weightedSignals.reduce((sum, item) => sum + item.weight, 0)
  const aggregateValue =
    totalWeight > 0
      ? weightedSignals.reduce(
          (sum, item) => sum + item.signal.value * item.weight,
          0,
        ) / totalWeight
      : 0
  const meanConfidence =
    signals.reduce((sum, signal) => sum + signal.confidence, 0) / signals.length
  const positiveCount = signals.filter((signal) => signal.value > 0.1).length
  const negativeCount = signals.filter((signal) => signal.value < -0.1).length
  const consensusScore =
    signals.length <= 1
      ? 1
      : clamp(1 - Math.min(positiveCount, negativeCount) / signals.length, 0, 1)
  const aggregateConfidence = clamp(meanConfidence * consensusScore, 0, 1)
  const decisionStrength = decisionStrengthFromMagnitude(
    Math.abs(aggregateValue) * aggregateConfidence,
  )

  return {
    signals,
    weights: Object.fromEntries(signals.map((signal) => [signal.name, weights[signal.name] ?? 1])),
    aggregateValue,
    aggregateConfidence,
    consensusScore,
    decisionStrength,
  }
}

export function combineFactorSignalsWithGovernance(
  signals: FactorSignal[],
  input: FactorGovernanceInput,
  weights: Record<string, number> = {},
): FactorGovernanceResult {
  const ensemble = combineFactorSignals(signals, weights)
  return {
    ...ensemble,
    governance: evaluateSignalGovernance({
      sourceTier: input.sourceTier,
      useType: input.useType,
      decisionStrength: ensemble.decisionStrength,
      sentiment: input.sentiment,
    }),
  }
}
