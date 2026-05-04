import { trainBaumWelch } from './baum-welch.js'
import { runForwardBackward } from './forward-backward.js'
import {
  DEFAULT_HMM_PARAMS,
  DEFAULT_REGIME_HMM_CONFIG,
  hmmStateName,
  type HmmColdStartMode,
  type HmmObservation,
  type HmmParams,
  type HmmRegimeOutput,
  type HmmState,
  type RegimeHmmConfig,
} from './types.js'
import { matchHmmStateIdentity } from './state-identity.js'
import { decodeViterbiPath } from './viterbi.js'

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function detectColdStartMode(
  observationCount: number,
  config: RegimeHmmConfig,
): HmmColdStartMode {
  if (observationCount < config.minObservations) {
    return 'threshold_only'
  }
  if (observationCount < config.seedObservations) {
    return 'threshold_seeded'
  }
  if (observationCount < config.stableObservations) {
    return 'regularized_em'
  }
  return 'standard_em'
}

function heuristicStateForObservation(observation: HmmObservation): HmmState {
  if (observation.realizedVol >= 1 || observation.volumeChangeRate >= 1) {
    return 3
  }
  if (observation.return1h >= 0.4 && observation.realizedVol <= 0.5) {
    return 0
  }
  if (observation.return1h <= -0.4) {
    return 1
  }
  if (Math.abs(observation.return1h) <= 0.25 && observation.realizedVol <= 0.2) {
    return 2
  }
  return observation.return1h >= 0 ? 0 : 1
}

function normalizeRow(values: number[]): number[] {
  const safe = values.map((value) => (Number.isFinite(value) && value > 0 ? value : 1e-6))
  const total = safe.reduce((sum, value) => sum + value, 0)
  return total > 0 ? safe.map((value) => value / total) : Array.from(
    { length: values.length },
    () => 1 / values.length,
  )
}

function empiricalParamsFromHeuristics(
  observations: HmmObservation[],
): HmmParams {
  const assignments = observations.map(heuristicStateForObservation)
  const grouped = Array.from({ length: 4 }, () => [] as HmmObservation[])
  assignments.forEach((state, index) => {
    grouped[state].push(observations[index])
  })

  const emissionParams = grouped.map((group, state) => {
    if (group.length === 0) {
      return { ...DEFAULT_HMM_PARAMS.emissionParams[state] }
    }

    const dimensions = [
      group.map((item) => item.return1h),
      group.map((item) => item.realizedVol),
      group.map((item) => item.volumeChangeRate),
    ] as const

    const mu = dimensions.map((values) => (
      values.reduce((sum, value) => sum + value, 0) / values.length
    )) as [number, number, number]
    const sigma = dimensions.map((values) => {
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length
      const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
      return Math.max(Math.sqrt(Math.max(variance, 0)), 0.15)
    }) as [number, number, number]
    return {
      mu,
      sigma,
      nu: DEFAULT_HMM_PARAMS.emissionParams[state].nu,
    }
  })

  const initialCounts = Array(4).fill(1e-3)
  initialCounts[assignments[0] ?? 0] += 1
  const initialProbs = normalizeRow(initialCounts)

  const transitionCounts = Array.from({ length: 4 }, () => Array(4).fill(1e-3))
  for (let index = 1; index < assignments.length; index += 1) {
    transitionCounts[assignments[index - 1]][assignments[index]] += 1
  }

  return {
    initialProbs,
    transitionMatrix: transitionCounts.map(normalizeRow),
    emissionParams,
  }
}

function thresholdOutput(
  observations: HmmObservation[],
  config: RegimeHmmConfig,
): HmmRegimeOutput | null {
  if (observations.length === 0) {
    return null
  }
  const latest = observations[observations.length - 1]
  const state = heuristicStateForObservation(latest)
  const scores = [
    Math.max(0, latest.return1h - Math.max(latest.realizedVol, 0) * 0.25),
    Math.max(0, -latest.return1h + latest.realizedVol * 0.15),
    Math.max(0, 1 - Math.abs(latest.return1h) - Math.max(latest.realizedVol, 0)),
    Math.max(0, latest.realizedVol + latest.volumeChangeRate),
  ]
  const scoreTotal = scores.reduce((sum, value) => sum + value, 0)
  const stateProbs = scoreTotal > 0
    ? scores.map((value) => value / scoreTotal)
    : [0.25, 0.25, 0.25, 0.25]
  return {
    state,
    stateName: hmmStateName(state),
    stateProbs,
    confidence: Math.max(...stateProbs),
    logLikelihood: Number.NaN,
    anomaly:
      Math.abs(latest.return1h) >= config.anomalyZScore
      || latest.realizedVol >= config.anomalyZScore
      || latest.volumeChangeRate >= config.anomalyZScore,
    reasons: ['insufficient observations for full HMM training', `heuristic state=${hmmStateName(state)}`],
    method: 'threshold',
    coldStartMode: 'threshold_only',
    effectiveSampleSize: observations.length,
  }
}

export class RegimeHmm {
  private readonly config: RegimeHmmConfig

  constructor(config?: Partial<RegimeHmmConfig>) {
    this.config = {
      ...DEFAULT_REGIME_HMM_CONFIG,
      ...config,
    }
  }

  classify(observations: HmmObservation[]): HmmRegimeOutput | null {
    const usableObservations = observations.slice(-this.config.trainingLookback)
    const coldStartMode = detectColdStartMode(usableObservations.length, this.config)

    if (coldStartMode === 'threshold_only') {
      return thresholdOutput(usableObservations, this.config)
    }

    const seededParams = empiricalParamsFromHeuristics(usableObservations)
    if (coldStartMode === 'threshold_seeded') {
      const threshold = thresholdOutput(usableObservations, this.config)
      return threshold
        ? {
            ...threshold,
            coldStartMode,
            reasons: [...threshold.reasons, 'empirical seed prepared for later EM handoff'],
          }
        : null
    }

    const trained = trainBaumWelch(usableObservations, seededParams, {
      coldStartMode,
      maxIterations: this.config.maxIterations,
      tolerance: this.config.tolerance,
      regularization:
        coldStartMode === 'regularized_em' ? this.config.regularization : 0,
    })
    const fb = runForwardBackward(usableObservations, trained.params)
    const viterbi = decodeViterbiPath(usableObservations, trained.params)
    const rawState = viterbi.path[viterbi.path.length - 1] ?? 2
    const rawStateProbs = fb.gamma[fb.gamma.length - 1] ?? [0.25, 0.25, 0.25, 0.25]
    const stateIdentity = matchHmmStateIdentity({
      params: trained.params,
      rawState,
      stateProbs: rawStateProbs,
    })
    const state = stateIdentity.matchedState
    const stateProbs = stateIdentity.canonicalStateProbs
    const confidence = clampProbability(Math.max(...stateProbs))
    const latest = usableObservations[usableObservations.length - 1]
    const anomaly =
      Math.abs(latest.return1h) >= this.config.anomalyZScore
      || latest.realizedVol >= this.config.anomalyZScore
      || latest.volumeChangeRate >= this.config.anomalyZScore

    return {
      state,
      rawState,
      stateName: hmmStateName(state),
      stateProbs: stateProbs.map(clampProbability),
      confidence,
      logLikelihood: fb.logLikelihood,
      anomaly,
      reasons: [
        `cold-start mode=${coldStartMode}`,
        `baum-welch iterations=${trained.diagnostics.iterations}`,
        `viterbi terminal state=${hmmStateName(rawState)}`,
        `wasserstein identity=${hmmStateName(rawState)}→${hmmStateName(state)} d=${stateIdentity.wassersteinDistance.toFixed(3)}`,
      ],
      method: 'hmm',
      coldStartMode,
      effectiveSampleSize: usableObservations.length,
      stateIdentity,
    }
  }

  train(observations: HmmObservation[]): HmmParams {
    const usableObservations = observations.slice(-this.config.trainingLookback)
    if (usableObservations.length === 0) {
      return DEFAULT_HMM_PARAMS
    }
    const seededParams = empiricalParamsFromHeuristics(usableObservations)
    const coldStartMode = detectColdStartMode(usableObservations.length, this.config)
    if (coldStartMode === 'threshold_only' || coldStartMode === 'threshold_seeded') {
      return seededParams
    }
    return trainBaumWelch(usableObservations, seededParams, {
      coldStartMode,
      maxIterations: this.config.maxIterations,
      tolerance: this.config.tolerance,
      regularization:
        coldStartMode === 'regularized_em' ? this.config.regularization : 0,
    }).params
  }

  update(observations: HmmObservation[]): HmmRegimeOutput | null {
    return this.classify(observations)
  }
}
