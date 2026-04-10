import { buildEmissionLogLikelihoods } from './forward-backward.js'
import type { HmmObservation, HmmParams, HmmState } from './types.js'

const EPSILON = 1e-12

export interface ViterbiResult {
  path: HmmState[]
  logLikelihood: number
}

export function decodeViterbiPath(
  observations: HmmObservation[],
  params: HmmParams,
): ViterbiResult {
  if (observations.length === 0) {
    return { path: [], logLikelihood: Number.NEGATIVE_INFINITY }
  }

  const stateCount = params.initialProbs.length
  const emissionLogLikelihoods = buildEmissionLogLikelihoods(observations, params)
  const delta = Array.from({ length: observations.length }, () => Array(stateCount).fill(0))
  const psi = Array.from({ length: observations.length }, () => Array(stateCount).fill(0))
  const logInitial = params.initialProbs.map((value) => Math.log(Math.max(value, EPSILON)))
  const logTransition = params.transitionMatrix.map((row) => (
    row.map((value) => Math.log(Math.max(value, EPSILON)))
  ))

  for (let state = 0; state < stateCount; state += 1) {
    delta[0][state] = logInitial[state] + emissionLogLikelihoods[0][state]
    psi[0][state] = 0
  }

  for (let time = 1; time < observations.length; time += 1) {
    for (let state = 0; state < stateCount; state += 1) {
      let bestScore = Number.NEGATIVE_INFINITY
      let bestState = 0
      for (let previousState = 0; previousState < stateCount; previousState += 1) {
        const candidate = delta[time - 1][previousState] + logTransition[previousState][state]
        if (candidate > bestScore) {
          bestScore = candidate
          bestState = previousState
        }
      }
      delta[time][state] = bestScore + emissionLogLikelihoods[time][state]
      psi[time][state] = bestState
    }
  }

  let bestTerminalState = 0
  let bestTerminalScore = Number.NEGATIVE_INFINITY
  for (let state = 0; state < stateCount; state += 1) {
    if (delta[observations.length - 1][state] > bestTerminalScore) {
      bestTerminalScore = delta[observations.length - 1][state]
      bestTerminalState = state
    }
  }

  const path = Array.from({ length: observations.length }, () => 0 as HmmState)
  path[observations.length - 1] = bestTerminalState as HmmState
  for (let time = observations.length - 2; time >= 0; time -= 1) {
    path[time] = psi[time + 1][path[time + 1]] as HmmState
  }

  return {
    path,
    logLikelihood: bestTerminalScore,
  }
}
