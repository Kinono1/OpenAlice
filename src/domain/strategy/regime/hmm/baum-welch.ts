import { scaleMixtureWeight } from './emissions.js'
import {
  normalizeProbabilities,
  runForwardBackward,
} from './forward-backward.js'
import type {
  HmmObservation,
  HmmParams,
  HmmTrainingDiagnostics,
} from './types.js'

const EPSILON = 1e-12

export interface BaumWelchOptions {
  maxIterations?: number
  tolerance?: number
  regularization?: number
  coldStartMode: HmmTrainingDiagnostics['coldStartMode']
}

export interface BaumWelchResult {
  params: HmmParams
  diagnostics: HmmTrainingDiagnostics
}

function cloneParams(params: HmmParams): HmmParams {
  return {
    initialProbs: [...params.initialProbs],
    transitionMatrix: params.transitionMatrix.map((row) => [...row]),
    emissionParams: params.emissionParams.map((emission) => ({
      mu: [...emission.mu] as [number, number, number],
      sigma: [...emission.sigma] as [number, number, number],
      nu: emission.nu,
    })),
  }
}

export function trainBaumWelch(
  observations: HmmObservation[],
  initialParams: HmmParams,
  options: BaumWelchOptions,
): BaumWelchResult {
  if (observations.length === 0) {
    return {
      params: cloneParams(initialParams),
      diagnostics: {
        observationCount: 0,
        iterations: 0,
        converged: true,
        coldStartMode: options.coldStartMode,
        regularization: options.regularization ?? 0,
        logLikelihood: Number.NEGATIVE_INFINITY,
      },
    }
  }

  const stateCount = initialParams.initialProbs.length
  const regularization = options.regularization ?? 0
  const maxIterations = options.maxIterations ?? 16
  const tolerance = options.tolerance ?? 1e-3
  let params = cloneParams(initialParams)
  let previousLogLikelihood = Number.NEGATIVE_INFINITY
  let lastLogLikelihood = Number.NEGATIVE_INFINITY
  let converged = false
  let iteration = 0

  for (iteration = 0; iteration < maxIterations; iteration += 1) {
    const fb = runForwardBackward(observations, params)
    lastLogLikelihood = fb.logLikelihood

    const nextParams = cloneParams(params)
    nextParams.initialProbs = normalizeProbabilities(
      fb.gamma[0].map((value) => value + regularization),
    )

    for (let state = 0; state < stateCount; state += 1) {
      const denominator = fb.gamma
        .slice(0, Math.max(observations.length - 1, 0))
        .reduce((sum, row) => sum + row[state], 0)
      const row = Array.from({ length: stateCount }, (_, nextState) => {
        const numerator = fb.xi.reduce((sum, plane) => sum + plane[state][nextState], 0)
        return (numerator + regularization) / Math.max(
          denominator + regularization * stateCount,
          EPSILON,
        )
      })
      nextParams.transitionMatrix[state] = normalizeProbabilities(row)
    }

    for (let state = 0; state < stateCount; state += 1) {
      for (let dimension = 0; dimension < 3; dimension += 1) {
        let weightedSum = 0
        let weightedCount = 0
        let gammaSum = 0
        for (let time = 0; time < observations.length; time += 1) {
          const gamma = fb.gamma[time][state]
          const lambda = scaleMixtureWeight(
            observations[time],
            params.emissionParams[state],
          )
          const value = dimension === 0
            ? observations[time].return1h
            : dimension === 1
              ? observations[time].realizedVol
              : observations[time].volumeChangeRate
          weightedSum += gamma * lambda * value
          weightedCount += gamma * lambda
          gammaSum += gamma
        }

        const mean = weightedCount > EPSILON
          ? weightedSum / weightedCount
          : params.emissionParams[state].mu[dimension]

        let varianceNumerator = 0
        for (let time = 0; time < observations.length; time += 1) {
          const gamma = fb.gamma[time][state]
          const lambda = scaleMixtureWeight(
            observations[time],
            params.emissionParams[state],
          )
          const value = dimension === 0
            ? observations[time].return1h
            : dimension === 1
              ? observations[time].realizedVol
              : observations[time].volumeChangeRate
          varianceNumerator += gamma * lambda * (value - mean) ** 2
        }

        nextParams.emissionParams[state].mu[dimension] = mean
        nextParams.emissionParams[state].sigma[dimension] = Math.sqrt(
          Math.max(
            varianceNumerator / Math.max(gammaSum, EPSILON) + regularization,
            1e-3,
          ),
        ) as 0.001
      }
    }

    params = nextParams

    if (
      Number.isFinite(previousLogLikelihood)
      && Math.abs(lastLogLikelihood - previousLogLikelihood) <= tolerance
    ) {
      converged = true
      iteration += 1
      break
    }
    previousLogLikelihood = lastLogLikelihood
  }

  return {
    params,
    diagnostics: {
      observationCount: observations.length,
      iterations: iteration,
      converged,
      coldStartMode: options.coldStartMode,
      regularization,
      logLikelihood: lastLogLikelihood,
    },
  }
}
