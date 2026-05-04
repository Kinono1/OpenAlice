import { clamp } from '../../factors/helpers.js'
import {
  DEFAULT_HMM_PARAMS,
  hmmStateName,
  type HmmParams,
  type HmmState,
  type HmmStateIdentity,
  type StudentTEmissionParams,
} from './types.js'

const HMM_STATES: HmmState[] = [0, 1, 2, 3]

export function wassersteinDistanceSquared(
  left: StudentTEmissionParams,
  right: StudentTEmissionParams,
): number {
  let meanDistance = 0
  let covarianceDistance = 0
  for (let dimension = 0; dimension < left.mu.length; dimension += 1) {
    meanDistance += (left.mu[dimension] - right.mu[dimension]) ** 2
    covarianceDistance += (
      Math.abs(left.sigma[dimension]) - Math.abs(right.sigma[dimension])
    ) ** 2
  }
  return meanDistance + covarianceDistance
}

export function matchHmmStateIdentity(input: {
  params: Pick<HmmParams, 'emissionParams'>
  rawState: HmmState
  stateProbs: number[]
  templateParams?: Pick<HmmParams, 'emissionParams'>
}): HmmStateIdentity {
  const template = input.templateParams ?? DEFAULT_HMM_PARAMS
  const distanceMatrix = input.params.emissionParams.map((emission) =>
    template.emissionParams.map((templateEmission) =>
      wassersteinDistanceSquared(emission, templateEmission),
    ),
  )
  const rawToCanonicalState = findBestStatePermutation(distanceMatrix)
  const matchedState = rawToCanonicalState[input.rawState] ?? input.rawState
  const rawDistances = distanceMatrix[input.rawState] ?? []
  const sortedDistances = [...rawDistances].sort((left, right) => left - right)
  const bestDistance = rawDistances[matchedState] ?? sortedDistances[0] ?? 0
  const secondBestDistance = sortedDistances.find((value) => value > bestDistance + 1e-12)
    ?? sortedDistances[1]
    ?? bestDistance
  const canonicalStateProbs = canonicalizeStateProbs(input.stateProbs, rawToCanonicalState)

  return {
    method: 'wasserstein_template',
    rawState: input.rawState,
    rawStateName: hmmStateName(input.rawState),
    matchedState,
    matchedStateName: hmmStateName(matchedState),
    wassersteinDistance: Math.sqrt(Math.max(bestDistance, 0)),
    identityConfidence:
      secondBestDistance > 0
        ? clamp((secondBestDistance - bestDistance) / secondBestDistance, 0, 1)
        : 1,
    activeStateCount: canonicalStateProbs.filter((probability) => probability >= 0.05).length,
    canonicalStateProbs,
    rawToCanonicalState,
  }
}

function canonicalizeStateProbs(
  stateProbs: number[],
  rawToCanonicalState: HmmState[],
): number[] {
  const out = Array.from({ length: HMM_STATES.length }, () => 0)
  stateProbs.forEach((probability, rawState) => {
    const canonicalState = rawToCanonicalState[rawState]
    if (canonicalState == null || !Number.isFinite(probability)) {
      return
    }
    out[canonicalState] += Math.max(0, probability)
  })
  const total = out.reduce((sum, value) => sum + value, 0)
  return total > 0 ? out.map((value) => value / total) : HMM_STATES.map(() => 1 / HMM_STATES.length)
}

function findBestStatePermutation(distanceMatrix: number[][]): HmmState[] {
  let bestPermutation = HMM_STATES
  let bestDistance = Number.POSITIVE_INFINITY
  for (const permutation of permutations(HMM_STATES)) {
    const distance = permutation.reduce<number>((sum, canonicalState, rawState) => (
      sum + (distanceMatrix[rawState]?.[canonicalState] ?? Number.POSITIVE_INFINITY)
    ), 0)
    if (distance < bestDistance) {
      bestDistance = distance
      bestPermutation = permutation
    }
  }
  return bestPermutation
}

function permutations(values: HmmState[]): HmmState[][] {
  if (values.length <= 1) {
    return [values]
  }
  return values.flatMap((value, index) => {
    const rest = [...values.slice(0, index), ...values.slice(index + 1)]
    return permutations(rest).map((permutation) => [value, ...permutation])
  })
}
