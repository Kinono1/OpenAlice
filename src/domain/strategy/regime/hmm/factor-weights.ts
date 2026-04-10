import { clamp } from '../../factors/helpers.js'
import type {
  HmmFactorWeightConditioning,
  HmmRegimeOutput,
  HmmStateName,
} from './types.js'

const DEFAULT_STATE_MULTIPLIERS: Record<HmmStateName, Record<string, number>> = {
  bull: {
    'momentum-composite': 1.35,
    'volume-surge': 0.95,
    'funding-rate': 0.95,
    basis: 1.05,
  },
  bear: {
    'momentum-composite': 0.8,
    'volume-surge': 1.1,
    'funding-rate': 1.2,
    basis: 0.9,
  },
  calm: {
    'momentum-composite': 0.8,
    'volume-surge': 0.85,
    'funding-rate': 1.05,
    basis: 1.1,
  },
  stress: {
    'momentum-composite': 0.65,
    'volume-surge': 1.35,
    'funding-rate': 1.25,
    basis: 0.8,
  },
}

export const REGIME_FACTOR_DIRECTION: Record<HmmStateName, Record<string, 1 | -1>> = {
  bull: {
    'momentum-composite': 1,
    'mean-reversion': -1,
  },
  bear: {
    'momentum-composite': -1,
    'mean-reversion': 1,
  },
  calm: {
    'momentum-composite': -1,
    'mean-reversion': 1,
  },
  stress: {
    'momentum-composite': -1,
    'mean-reversion': 1,
  },
}

export interface FactorWeightCalibrationInput {
  baseWeights: Record<string, number>
  hmmOutput?: HmmRegimeOutput | null
  icSharpeByState?: Partial<Record<HmmStateName, Record<string, number>>>
}

export function calibrateStateConditionedFactorWeights(
  input: FactorWeightCalibrationInput,
): HmmFactorWeightConditioning {
  if (!input.hmmOutput) {
    return {
      weights: { ...input.baseWeights },
      multipliers: {},
      directions: {},
      reasons: [],
    }
  }

  const stateName = input.hmmOutput.stateName
  const defaultMultipliers = DEFAULT_STATE_MULTIPLIERS[stateName] ?? {}
  const icSharpeMultipliers = input.icSharpeByState?.[stateName] ?? {}
  const directions = REGIME_FACTOR_DIRECTION[stateName] ?? {}
  const multipliers = Object.fromEntries(
    Object.keys(input.baseWeights).map((factorName) => {
      const defaultMultiplier = defaultMultipliers[factorName] ?? 1
      const icSharpe = icSharpeMultipliers[factorName]
      const icMultiplier = Number.isFinite(icSharpe)
        ? clamp(1 + icSharpe * 0.2, 0.6, 1.4)
        : 1
      return [factorName, clamp(defaultMultiplier * icMultiplier, 0.5, 1.5)]
    }),
  )

  const weights = Object.fromEntries(
    Object.entries(input.baseWeights).map(([factorName, weight]) => [
      factorName,
      weight * (multipliers[factorName] ?? 1),
    ]),
  )

  return {
    weights,
    multipliers,
    directions,
    reasons: [
      `state-conditioned weights applied for ${stateName}`,
      `conditioning confidence=${input.hmmOutput.confidence.toFixed(2)}`,
    ],
  }
}
