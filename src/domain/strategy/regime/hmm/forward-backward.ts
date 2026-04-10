import { multivariateStudentTLogLikelihood } from './emissions.js'
import type { HmmObservation, HmmParams } from './types.js'

const EPSILON = 1e-12

export interface ForwardBackwardResult {
  logAlpha: number[][]
  logBeta: number[][]
  gamma: number[][]
  xi: number[][][]
  emissionLogLikelihoods: number[][]
  logLikelihood: number
}

export function logSumExp(values: number[]): number {
  const finiteValues = values.filter(Number.isFinite)
  if (finiteValues.length === 0) {
    return Number.NEGATIVE_INFINITY
  }

  const pivot = Math.max(...finiteValues)
  if (!Number.isFinite(pivot)) {
    return Number.NEGATIVE_INFINITY
  }

  const scaled = finiteValues.reduce((sum, value) => sum + Math.exp(value - pivot), 0)
  return pivot + Math.log(Math.max(scaled, EPSILON))
}

export function normalizeProbabilities(values: number[]): number[] {
  const safe = values.map((value) => (
    Number.isFinite(value) && value > 0 ? value : EPSILON
  ))
  const total = safe.reduce((sum, value) => sum + value, 0)
  return total > 0
    ? safe.map((value) => value / total)
    : Array.from({ length: values.length }, () => 1 / values.length)
}

export function buildEmissionLogLikelihoods(
  observations: HmmObservation[],
  params: HmmParams,
): number[][] {
  return observations.map((observation) => params.emissionParams.map((emission) => (
    multivariateStudentTLogLikelihood(observation, emission)
  )))
}

export function runForwardBackward(
  observations: HmmObservation[],
  params: HmmParams,
): ForwardBackwardResult {
  if (observations.length === 0) {
    return {
      logAlpha: [],
      logBeta: [],
      gamma: [],
      xi: [],
      emissionLogLikelihoods: [],
      logLikelihood: Number.NEGATIVE_INFINITY,
    }
  }

  const stateCount = params.initialProbs.length
  const emissionLogLikelihoods = buildEmissionLogLikelihoods(observations, params)
  const logInitial = params.initialProbs.map((value) => Math.log(Math.max(value, EPSILON)))
  const logTransition = params.transitionMatrix.map((row) => (
    row.map((value) => Math.log(Math.max(value, EPSILON)))
  ))

  const logAlpha = Array.from({ length: observations.length }, () => Array(stateCount).fill(0))
  const logBeta = Array.from({ length: observations.length }, () => Array(stateCount).fill(0))

  for (let state = 0; state < stateCount; state += 1) {
    logAlpha[0][state] = logInitial[state] + emissionLogLikelihoods[0][state]
  }

  for (let time = 1; time < observations.length; time += 1) {
    for (let state = 0; state < stateCount; state += 1) {
      const candidates = Array.from({ length: stateCount }, (_, previousState) => (
        logAlpha[time - 1][previousState] + logTransition[previousState][state]
      ))
      logAlpha[time][state] = emissionLogLikelihoods[time][state] + logSumExp(candidates)
    }
  }

  const finalAlpha = logAlpha[observations.length - 1]
  const logLikelihood = logSumExp(finalAlpha)

  for (let state = 0; state < stateCount; state += 1) {
    logBeta[observations.length - 1][state] = 0
  }

  for (let time = observations.length - 2; time >= 0; time -= 1) {
    for (let state = 0; state < stateCount; state += 1) {
      const candidates = Array.from({ length: stateCount }, (_, nextState) => (
        logTransition[state][nextState]
        + emissionLogLikelihoods[time + 1][nextState]
        + logBeta[time + 1][nextState]
      ))
      logBeta[time][state] = logSumExp(candidates)
    }
  }

  const gamma = logAlpha.map((row, time) => {
    const normalized = row.map((value, state) => Math.exp(value + logBeta[time][state] - logLikelihood))
    return normalizeProbabilities(normalized)
  })

  const xi = Array.from(
    { length: Math.max(observations.length - 1, 0) },
    () => Array.from({ length: stateCount }, () => Array(stateCount).fill(0)),
  )

  for (let time = 0; time < observations.length - 1; time += 1) {
    const flatValues: number[] = []
    for (let state = 0; state < stateCount; state += 1) {
      for (let nextState = 0; nextState < stateCount; nextState += 1) {
        flatValues.push(
          logAlpha[time][state]
          + logTransition[state][nextState]
          + emissionLogLikelihoods[time + 1][nextState]
          + logBeta[time + 1][nextState],
        )
      }
    }
    const normalizer = logSumExp(flatValues)
    for (let state = 0; state < stateCount; state += 1) {
      for (let nextState = 0; nextState < stateCount; nextState += 1) {
        xi[time][state][nextState] = Math.exp(
          logAlpha[time][state]
          + logTransition[state][nextState]
          + emissionLogLikelihoods[time + 1][nextState]
          + logBeta[time + 1][nextState]
          - normalizer,
        )
      }
      xi[time][state] = normalizeProbabilities(xi[time][state])
    }
  }

  return {
    logAlpha,
    logBeta,
    gamma,
    xi,
    emissionLogLikelihoods,
    logLikelihood,
  }
}
