import type {
  HmmParams,
  HmmRegimeOutput,
  HmmState,
  HmmStateName,
} from './hmm/types.js'

/**
 * Forecast of regime state evolution over a future horizon.
 *
 * This structure captures the predicted evolution of market regimes,
 * enabling proactive risk management and position adjustments before
 * regime transitions materialize.
 */
export interface RegimeTransitionForecast {
  /** Current decoded HMM state index */
  currentState: HmmState
  /** Human-readable current state name (bull/bear/calm/stress) */
  currentStateName: HmmStateName
  /** Probability distribution over states at t=0 (current belief) */
  stateProbs: number[]
  /** Predicted probability distribution at t=1 (next step) */
  nextStateProbs: number[]
  /** Most probable single-step transition with probability mass */
  mostLikelyTransition: {
    from: HmmState
    to: HmmState
    probability: number
  }
  /** Optional k-step-ahead probability matrices for k=1..horizon */
  kStepProbs?: number[][]
  /** Long-run equilibrium distribution (if ergodic) */
  steadyStateProbs?: number[]
  /** Number of steps to reach ~steady state (mixing rate) */
  mixingTime?: number
  /** Confidence in the transition forecast (based on HMM fit quality) */
  confidence: number
  /** Number of steps forecast into the future */
  forecastHorizon: number
  /** Whether this forecast came from full HMM or threshold fallback */
  source: 'hmm' | 'threshold'
}

/**
 * Predict the next-step regime distribution and identify the most
 * probable transition from current state.
 *
 * @param hmmOutput - Current HMM classification output
 * @param hmmParams - Trained HMM parameters (transition matrix, etc.)
 * @param horizon - Optional forecast horizon (default: 1)
 * @returns Regime transition forecast with probability distributions
 */
export function predictRegimeTransition(
  hmmOutput: HmmRegimeOutput,
  hmmParams: HmmParams,
  horizon = 1,
): RegimeTransitionForecast {
  const currentState = hmmOutput.state
  const currentStateName = hmmOutput.stateName
  const stateProbs = hmmOutput.stateProbs

  const transitionMatrix = hmmParams.transitionMatrix

  const nextStateProbs = predictOneStep(stateProbs, transitionMatrix)

  const mostLikelyTransition = findMostLikelyTransition(
    currentState,
    stateProbs,
    transitionMatrix,
  )

  const kStepProbs = horizon > 1
    ? predictKStep(hmmOutput, hmmParams, horizon)
    : undefined

  const steadyStateResult = computeSteadyState(transitionMatrix)

  const confidence = computeTransitionConfidence(
    hmmOutput.confidence,
    hmmOutput.method,
    hmmOutput.effectiveSampleSize,
  )

  return {
    currentState,
    currentStateName,
    stateProbs,
    nextStateProbs,
    mostLikelyTransition,
    kStepProbs,
    steadyStateProbs: steadyStateResult.probs,
    mixingTime: steadyStateResult.mixingTime,
    confidence,
    forecastHorizon: horizon,
    source: hmmOutput.method,
  }
}

/**
 * Predict the state probability distribution k steps into the future.
 *
 * Uses matrix exponentiation via repeated multiplication:
 *   P(X_{t+k}) = P(X_t) * T^k
 * where T is the transition matrix.
 *
 * @param hmmOutput - Current HMM output with state probabilities
 * @param hmmParams - HMM parameters containing transition matrix
 * @param k - Number of steps to forecast
 * @returns Array of probability distributions for steps 1..k
 */
export function predictKStep(
  hmmOutput: HmmRegimeOutput,
  hmmParams: HmmParams,
  k: number,
): number[][] {
  if (k <= 0) {
    return []
  }

  const transitionMatrix = hmmParams.transitionMatrix
  const numStates = transitionMatrix.length
  const results: number[][] = []

  let currentProbs = hmmOutput.stateProbs.slice()

  for (let step = 1; step <= k; step += 1) {
    currentProbs = predictOneStep(currentProbs, transitionMatrix)
    results.push(currentProbs.slice())
  }

  return results
}

/**
 * Compute the steady-state (stationary) distribution of the Markov chain.
 *
 * Solves π = πT for the left eigenvector with eigenvalue 1 using power
 * iteration, which is numerically stable for stochastic matrices.
 *
 * Also estimates mixing time: the number of steps needed for the chain
 * to converge to within ε of the stationary distribution.
 *
 * @param transitionMatrix - Row-stochastic transition probability matrix
 * @param tolerance - Convergence tolerance for power iteration (default: 1e-8)
 * @param maxIterations - Maximum power iteration steps (default: 1000)
 * @returns Steady-state probabilities and estimated mixing time
 */
export function computeSteadyState(
  transitionMatrix: number[][],
  tolerance = 1e-8,
  maxIterations = 1000,
): { probs: number[]; mixingTime: number } {
  const numStates = transitionMatrix.length

  const initial = Array.from({ length: numStates }, () => 1 / numStates)

  let current = initial.slice()
  let prev = initial.slice()

  let converged = false
  let iterations = 0

  while (!converged && iterations < maxIterations) {
    current = predictOneStep(prev, transitionMatrix)

    const maxDiff = Math.max(
      ...current.map((prob, index) => Math.abs(prob - prev[index])),
    )

    if (maxDiff < tolerance) {
      converged = true
    }

    prev = current.slice()
    iterations += 1
  }

  const mixingTime = estimateMixingTime(transitionMatrix, current)

  return {
    probs: current,
    mixingTime,
  }
}

/**
 * Predict one-step-ahead state probabilities.
 *
 * @param currentProbs - Current state probability distribution
 * @param transitionMatrix - Row-stochastic transition matrix
 * @returns Next-step probability distribution
 */
function predictOneStep(
  currentProbs: number[],
  transitionMatrix: number[][],
): number[] {
  const numStates = transitionMatrix.length
  const result: number[] = Array(numStates).fill(0)

  for (let j = 0; j < numStates; j += 1) {
    for (let i = 0; i < numStates; i += 1) {
      result[j] += currentProbs[i] * transitionMatrix[i][j]
    }
  }

  return normalize(result)
}

/**
 * Find the most probable single-step transition.
 *
 * Considers both the current state and the full state probability
 * distribution to identify the transition with highest probability mass.
 *
 * @param currentState - Current most likely state
 * @param stateProbs - Current state probability distribution
 * @param transitionMatrix - Transition probability matrix
 * @returns Most probable transition with from/to states and probability
 */
function findMostLikelyTransition(
  currentState: HmmState,
  stateProbs: number[],
  transitionMatrix: number[][],
): { from: HmmState; to: HmmState; probability: number } {
  const numStates = transitionMatrix.length
  let maxProb = 0
  let bestFrom: HmmState = currentState
  let bestTo: HmmState = currentState

  for (let i = 0; i < numStates; i += 1) {
    for (let j = 0; j < numStates; j += 1) {
      const jointProb = stateProbs[i] * transitionMatrix[i][j]
      if (jointProb > maxProb) {
        maxProb = jointProb
        bestFrom = i as HmmState
        bestTo = j as HmmState
      }
    }
  }

  return {
    from: bestFrom,
    to: bestTo,
    probability: maxProb,
  }
}

/**
 * Compute confidence in the transition forecast.
 *
 * Adjusts the raw HMM confidence based on:
 * - Sample size (more observations → higher confidence)
 * - Source method (HMM > threshold)
 *
 * @param rawConfidence - Raw HMM classification confidence
 * @param method - Whether HMM or threshold was used
 * @param sampleSize - Number of observations used for training
 * @returns Adjusted confidence in [0, 1]
 */
function computeTransitionConfidence(
  rawConfidence: number,
  method: 'hmm' | 'threshold',
  sampleSize: number,
): number {
  const methodPenalty = method === 'threshold' ? 0.3 : 0

  const sampleSizeBoost = Math.min(0.1, Math.log10(Math.max(sampleSize, 1)) * 0.02)

  const adjusted = rawConfidence + sampleSizeBoost - methodPenalty

  return Math.max(0, Math.min(1, adjusted))
}

/**
 * Estimate the mixing time of the Markov chain.
 *
 * Uses the second-largest eigenvalue magnitude (SLEM) approximation:
 *   τ_mix ≈ 1 / (1 - λ_2)
 *
 * For ergodic chains, this gives the characteristic relaxation time.
 *
 * @param transitionMatrix - Transition probability matrix
 * @param steadyState - Stationary distribution (for numerical stability)
 * @returns Estimated mixing time in steps
 */
function estimateMixingTime(
  transitionMatrix: number[][],
  steadyState: number[],
): number {
  const numStates = transitionMatrix.length

  let maxOffDiag = 0
  for (let i = 0; i < numStates; i += 1) {
    for (let j = 0; j < numStates; j += 1) {
      if (i !== j) {
        maxOffDiag = Math.max(maxOffDiag, transitionMatrix[i][j])
      }
    }
  }

  const slem = maxOffDiag
  if (slem >= 1) {
    return 100
  }

  const mixingTime = Math.ceil(1 / (1 - slem))

  return Math.min(mixingTime, 100)
}

/**
 * Normalize a probability vector to sum to 1.
 */
function normalize(probs: number[]): number[] {
  const sum = probs.reduce((total, prob) => total + prob, 0)
  if (sum <= 0) {
    const uniform = 1 / probs.length
    return probs.map(() => uniform)
  }
  return probs.map((prob) => prob / sum)
}
