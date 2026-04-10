export const HMM_STATE_NAMES = ['bull', 'bear', 'calm', 'stress'] as const

export type HmmStateName = (typeof HMM_STATE_NAMES)[number]
export type HmmState = 0 | 1 | 2 | 3

export interface HmmObservation {
  return1h: number
  realizedVol: number
  volumeChangeRate: number
  sourceIndex?: number
  sourceDate?: string
}

export interface StudentTEmissionParams {
  mu: [number, number, number]
  sigma: [number, number, number]
  nu: number
}

export interface HmmParams {
  initialProbs: number[]
  transitionMatrix: number[][]
  emissionParams: StudentTEmissionParams[]
}

export type HmmColdStartMode =
  | 'threshold_only'
  | 'threshold_seeded'
  | 'regularized_em'
  | 'standard_em'

export interface HmmTrainingDiagnostics {
  observationCount: number
  iterations: number
  converged: boolean
  coldStartMode: HmmColdStartMode
  regularization: number
  logLikelihood: number
}

export interface HmmRegimeOutput {
  state: HmmState
  stateName: HmmStateName
  stateProbs: number[]
  confidence: number
  logLikelihood: number
  anomaly: boolean
  reasons: string[]
  method: 'threshold' | 'hmm'
  coldStartMode: HmmColdStartMode
  effectiveSampleSize: number
}

export interface RegimeHmmConfig {
  enabled: boolean
  minObservations: number
  seedObservations: number
  stableObservations: number
  trainingLookback: number
  maxIterations: number
  tolerance: number
  regularization: number
  confidenceFloor: number
  anomalyZScore: number
  zScoreWindow: number
  realizedVolWindow: number
  volumeBaselineWindow: number
}

export interface HmmFactorWeightConditioning {
  weights: Record<string, number>
  multipliers: Record<string, number>
  directions: Record<string, 1 | -1>
  reasons: string[]
}

export const DEFAULT_HMM_PARAMS: HmmParams = {
  initialProbs: [0.25, 0.25, 0.25, 0.25],
  transitionMatrix: [
    [0.82, 0.06, 0.1, 0.02],
    [0.06, 0.82, 0.04, 0.08],
    [0.12, 0.06, 0.74, 0.08],
    [0.08, 0.12, 0.08, 0.72],
  ],
  emissionParams: [
    { mu: [0.8, -0.4, 0.2], sigma: [0.7, 0.6, 0.7], nu: 5 },
    { mu: [-0.8, 0.5, 0.3], sigma: [0.8, 0.7, 0.7], nu: 5 },
    { mu: [0, -0.6, -0.2], sigma: [0.5, 0.45, 0.45], nu: 6 },
    { mu: [-0.2, 1.1, 1], sigma: [0.75, 0.8, 0.9], nu: 4.5 },
  ],
}

export const DEFAULT_REGIME_HMM_CONFIG: RegimeHmmConfig = {
  enabled: false,
  minObservations: 30,
  seedObservations: 168,
  stableObservations: 500,
  trainingLookback: 720,
  maxIterations: 24,
  tolerance: 1e-3,
  regularization: 1e-4,
  confidenceFloor: 0.4,
  anomalyZScore: 3,
  zScoreWindow: 48,
  realizedVolWindow: 24,
  volumeBaselineWindow: 24,
}

export function hmmStateName(state: HmmState): HmmStateName {
  return HMM_STATE_NAMES[state]
}
