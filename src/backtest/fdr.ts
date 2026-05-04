export type FdrMethod =
  | 'bh'
  | 'by'
  | 'cv_storey_bh'
  | 'stepc'
  | 'spa'

export interface FdrItem {
  index: number
  rank: number
  pValue: number
  qValue: number
  threshold: number
  passed: boolean
}

export interface FdrDiagnostics {
  method: FdrMethod
  alpha: number
  candidateCount: number
  harmonicFactorCm: number | null
  storeyPi0: number | null
  storeyLambda: number | null
  cvAggQuantile: number | null
  candidateWindowCounts: number[] | null
  approximation: string | null
  orderedPValues: number[] | null
  stepcCombinedPValues: number[] | null
  selectionCutoff: number | null
  benchmarkStrategyId: string | null
  benchmarkStrategyIndex: number | null
  bootstrapDirectionStable?: boolean | null
  unstableBootstrapCandidateIndexes?: number[] | null
  blockSizeSet?: number[] | null
  blockSensitivityByCandidate?: Array<{
    candidateIndex: number
    blockSensitivity: Array<{
      blockSize: number
      observedMeanExcess: number
      pValue: number
      passed: boolean
    }>
    bootstrapDirectionStable: boolean
    unstableBootstrap: boolean
  }> | null
}

export interface RunFdrCorrectionInput {
  pValues: number[]
  alpha?: number
  method?: FdrMethod
  storeyLambda?: number
  cvAggQuantile?: number
  windowPValuesByCandidate?: number[][]
  benchmarkStrategyId?: string
  benchmarkStrategyIndex?: number
  spaBootstrapDiagnostics?: Pick<
    FdrDiagnostics,
    | 'bootstrapDirectionStable'
    | 'unstableBootstrapCandidateIndexes'
    | 'blockSizeSet'
    | 'blockSensitivityByCandidate'
  >
}

export interface RunFdrCorrectionResult {
  items: FdrItem[]
  diagnostics: FdrDiagnostics
  effectivePValues: number[]
}

export interface LedgerBoundFdrTrialLedger {
  rawM: number
  effectiveM?: number | null
  rawMComplete: boolean
  includesFailedTrials: boolean
  failedTrialCount?: number | null
  survivingTrialCount?: number | null
  fdrMethodPrimary: 'BY_raw_m' | string
}

export interface RunLedgerBoundFdrCorrectionInput extends RunFdrCorrectionInput {
  trialLedger: LedgerBoundFdrTrialLedger
}

const DEFAULT_ALPHA = 0.1
const DEFAULT_STOREY_LAMBDA = 0.5
const DEFAULT_CV_AGG_QUANTILE = 0.9

export function benjaminiHochberg(
  pValues: number[],
  alpha = DEFAULT_ALPHA,
): FdrItem[] {
  const validatedAlpha = validateAlpha(alpha)
  return runMonotonicCorrection({
    tuples: validatePValues(pValues),
    alpha: validatedAlpha,
    qScaleFactor: () => 1,
  })
}

export function benjaminiYekutieli(
  pValues: number[],
  alpha = DEFAULT_ALPHA,
): FdrItem[] {
  const validatedAlpha = validateAlpha(alpha)
  const tuples = validatePValues(pValues)
  const harmonicFactorCm = harmonicNumber(tuples.length)
  return runMonotonicCorrection({
    tuples,
    alpha: validatedAlpha,
    qScaleFactor: () => harmonicFactorCm,
  })
}

export function runFdrCorrection(
  input: RunFdrCorrectionInput,
): RunFdrCorrectionResult {
  const alpha = validateAlpha(input.alpha ?? DEFAULT_ALPHA)
  const method = input.method ?? 'bh'
  const tuples = validatePValues(input.pValues)
  const effectivePValues =
    method === 'cv_storey_bh'
      ? aggregateCvWindowPValues({
          tuples,
          cvAggQuantile: input.cvAggQuantile ?? DEFAULT_CV_AGG_QUANTILE,
          windowPValuesByCandidate: input.windowPValuesByCandidate,
        })
      : tuples.map((tuple) => tuple.pValue)
  const effectiveTuples = effectivePValues.map((pValue, index) => ({
    index,
    pValue,
  }))

  if (method === 'bh') {
    return {
      items: benjaminiHochberg(effectivePValues, alpha),
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
      }),
      effectivePValues,
    }
  }

  if (method === 'by') {
    const harmonicFactorCm = harmonicNumber(effectivePValues.length)
    return {
      items: runMonotonicCorrection({
        tuples: effectiveTuples,
        alpha,
        qScaleFactor: () => harmonicFactorCm,
      }),
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
        harmonicFactorCm,
      }),
      effectivePValues,
    }
  }

  if (method === 'stepc') {
    const result = runStepwiseCauchyCombination(effectivePValues, alpha)
    return {
      items: result.items,
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
        approximation: 'stepwise_cauchy_prefix_approximation',
        orderedPValues: result.orderedPValues,
        stepcCombinedPValues: result.combinedPValues,
        selectionCutoff: result.selectionCutoff,
      }),
      effectivePValues,
    }
  }

  if (method === 'spa') {
    const spaBootstrapDiagnostics = validateSpaBootstrapDiagnostics(
      input.spaBootstrapDiagnostics,
      effectivePValues.length,
    )
    const items = runIdentityCorrection({
      tuples: effectiveTuples,
      alpha,
    })
    const orderedPValues = [...effectivePValues].sort((left, right) => left - right)
    const selectionCutoff = items.filter((item) => item.passed).length
    return {
      items,
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
        approximation: 'spa_uses_validation_layer_benchmark_p_values',
        orderedPValues,
        selectionCutoff,
        benchmarkStrategyId: input.benchmarkStrategyId ?? null,
        benchmarkStrategyIndex: input.benchmarkStrategyIndex ?? null,
        spaBootstrapDiagnostics,
      }),
      effectivePValues,
    }
  }

  const storeyLambda = validateProbability(
    input.storeyLambda ?? DEFAULT_STOREY_LAMBDA,
    'storeyLambda',
  )
  const storeyPi0 = estimateStoreyPi0(effectivePValues, storeyLambda)
  const candidateWindowCounts = Array.isArray(input.windowPValuesByCandidate)
    ? input.windowPValuesByCandidate.map((value) =>
        Array.isArray(value) ? value.length : 0,
      )
    : null

  return {
    items: runMonotonicCorrection({
      tuples: effectiveTuples,
      alpha,
      qScaleFactor: () => storeyPi0,
    }),
    diagnostics: buildBaseDiagnostics({
      method,
      alpha,
      candidateCount: effectivePValues.length,
      storeyPi0,
      storeyLambda,
      cvAggQuantile: input.cvAggQuantile ?? DEFAULT_CV_AGG_QUANTILE,
      candidateWindowCounts,
    }),
    effectivePValues,
  }
}

export function runLedgerBoundFdrCorrection(
  input: RunLedgerBoundFdrCorrectionInput,
): RunFdrCorrectionResult {
  validateLedgerBoundFdrInput(input)
  return runFdrCorrection({
    ...input,
    method: input.method ?? 'by',
  })
}

function buildBaseDiagnostics(input: {
  method: FdrMethod
  alpha: number
  candidateCount: number
  harmonicFactorCm?: number | null
  storeyPi0?: number | null
  storeyLambda?: number | null
  cvAggQuantile?: number | null
  candidateWindowCounts?: number[] | null
  approximation?: string | null
  orderedPValues?: number[] | null
  stepcCombinedPValues?: number[] | null
  selectionCutoff?: number | null
  benchmarkStrategyId?: string | null
  benchmarkStrategyIndex?: number | null
  spaBootstrapDiagnostics?: RunFdrCorrectionInput['spaBootstrapDiagnostics']
}): FdrDiagnostics {
  return {
    method: input.method,
    alpha: input.alpha,
    candidateCount: input.candidateCount,
    harmonicFactorCm: input.harmonicFactorCm ?? null,
    storeyPi0: input.storeyPi0 ?? null,
    storeyLambda: input.storeyLambda ?? null,
    cvAggQuantile: input.cvAggQuantile ?? null,
    candidateWindowCounts: input.candidateWindowCounts ?? null,
    approximation: input.approximation ?? null,
    orderedPValues: input.orderedPValues ?? null,
    stepcCombinedPValues: input.stepcCombinedPValues ?? null,
    selectionCutoff: input.selectionCutoff ?? null,
    benchmarkStrategyId: input.benchmarkStrategyId ?? null,
    benchmarkStrategyIndex: input.benchmarkStrategyIndex ?? null,
    bootstrapDirectionStable: input.spaBootstrapDiagnostics?.bootstrapDirectionStable ?? null,
    unstableBootstrapCandidateIndexes: input.spaBootstrapDiagnostics?.unstableBootstrapCandidateIndexes ?? null,
    blockSizeSet: input.spaBootstrapDiagnostics?.blockSizeSet ?? null,
    blockSensitivityByCandidate: input.spaBootstrapDiagnostics?.blockSensitivityByCandidate ?? null,
  }
}

function validateLedgerBoundFdrInput(input: RunLedgerBoundFdrCorrectionInput): void {
  const tuples = validatePValues(input.pValues)
  const trialLedger = input.trialLedger
  if (!trialLedger || typeof trialLedger !== 'object') {
    throw new Error('trialLedger is required for ledger-bound FDR.')
  }
  if (trialLedger.fdrMethodPrimary !== 'BY_raw_m') {
    throw new Error('trialLedger.fdrMethodPrimary must be BY_raw_m for ledger-bound FDR.')
  }
  if (trialLedger.rawMComplete !== true) {
    throw new Error('trialLedger.rawMComplete must be true for ledger-bound FDR.')
  }
  if (trialLedger.includesFailedTrials !== true) {
    throw new Error('trialLedger.includesFailedTrials must be true for ledger-bound FDR.')
  }
  if (!Number.isFinite(trialLedger.rawM) || trialLedger.rawM <= 0) {
    throw new Error('trialLedger.rawM must be a positive finite number.')
  }
  if (trialLedger.rawM < tuples.length) {
    throw new Error('trialLedger.rawM must be >= pValues length for ledger-bound FDR.')
  }
  if (trialLedger.effectiveM != null && (!Number.isFinite(trialLedger.effectiveM) || trialLedger.effectiveM <= 0)) {
    throw new Error('trialLedger.effectiveM must be a positive finite number when provided.')
  }
  if (
    trialLedger.failedTrialCount != null &&
    (!Number.isFinite(trialLedger.failedTrialCount) || trialLedger.failedTrialCount < 0)
  ) {
    throw new Error('trialLedger.failedTrialCount must be a non-negative finite number when provided.')
  }
  if (
    trialLedger.survivingTrialCount != null &&
    (!Number.isFinite(trialLedger.survivingTrialCount) || trialLedger.survivingTrialCount < 0)
  ) {
    throw new Error('trialLedger.survivingTrialCount must be a non-negative finite number when provided.')
  }
  if (
    trialLedger.failedTrialCount != null &&
    trialLedger.survivingTrialCount != null &&
    trialLedger.failedTrialCount + trialLedger.survivingTrialCount > trialLedger.rawM
  ) {
    throw new Error('trialLedger failed + surviving counts must not exceed rawM.')
  }
  if (input.method != null && input.method !== 'by') {
    throw new Error('ledger-bound FDR must use BY_raw_m; set method to by or omit it.')
  }
}

function aggregateCvWindowPValues(input: {
  tuples: Array<{ index: number; pValue: number }>
  cvAggQuantile: number
  windowPValuesByCandidate?: number[][]
}): number[] {
  const quantile = validateProbability(
    input.cvAggQuantile,
    'cvAggQuantile',
  )
  return input.tuples.map((tuple, index) => {
    const windowPValues = input.windowPValuesByCandidate?.[index]
    if (!Array.isArray(windowPValues) || windowPValues.length === 0) {
      return tuple.pValue
    }
    const sorted = windowPValues
      .map((value, windowIndex) => {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(
            `windowPValuesByCandidate[${index}][${windowIndex}] must be within [0, 1].`,
          )
        }
        return value
      })
      .sort((left, right) => left - right)
    const rank = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1),
    )
    return sorted[rank]
  })
}

function runStepwiseCauchyCombination(
  pValues: number[],
  alpha: number,
): {
  items: FdrItem[]
  orderedPValues: number[]
  combinedPValues: number[]
  selectionCutoff: number
} {
  const tuples = validatePValues(pValues)
  const sorted = [...tuples].sort((left, right) => left.pValue - right.pValue)
  const orderedPValues = sorted.map((tuple) => tuple.pValue)
  const prefixCombined = orderedPValues.map((_, index) =>
    cauchyCombinedPValue(orderedPValues.slice(0, index + 1)),
  )
  const monotonicCombined = [...prefixCombined]
  for (let index = 1; index < monotonicCombined.length; index += 1) {
    monotonicCombined[index] = Math.max(
      monotonicCombined[index],
      monotonicCombined[index - 1],
    )
  }
  let selectionCutoff = 0
  for (let index = 0; index < monotonicCombined.length; index += 1) {
    if (monotonicCombined[index] <= alpha) {
      selectionCutoff = index + 1
    }
  }

  const byOriginal = new Array<FdrItem>(sorted.length)
  for (let index = 0; index < sorted.length; index += 1) {
    const rank = index + 1
    const tuple = sorted[index]
    byOriginal[tuple.index] = {
      index: tuple.index,
      rank,
      pValue: tuple.pValue,
      qValue: monotonicCombined[index],
      threshold: alpha,
      passed: rank <= selectionCutoff,
    }
  }

  return {
    items: byOriginal,
    orderedPValues,
    combinedPValues: monotonicCombined,
    selectionCutoff,
  }
}

function cauchyCombinedPValue(pValues: number[]): number {
  const validated = validatePValues(pValues).map((item) =>
    clamp(item.pValue, 1e-12, 1 - 1e-12),
  )
  const statistic =
    validated.reduce(
      (sum, value) => sum + Math.tan((0.5 - value) * Math.PI),
      0,
    ) / validated.length
  return clamp(0.5 - Math.atan(statistic) / Math.PI, 0, 1)
}

function runIdentityCorrection(input: {
  tuples: Array<{ index: number; pValue: number }>
  alpha: number
}): FdrItem[] {
  const sorted = [...input.tuples].sort((left, right) => left.pValue - right.pValue)
  const out = new Array<FdrItem>(sorted.length)
  for (let index = 0; index < sorted.length; index += 1) {
    const tuple = sorted[index]
    out[tuple.index] = {
      index: tuple.index,
      rank: index + 1,
      pValue: tuple.pValue,
      qValue: tuple.pValue,
      threshold: input.alpha,
      passed: tuple.pValue <= input.alpha,
    }
  }
  return out
}

function runMonotonicCorrection(input: {
  tuples: Array<{ index: number; pValue: number }>
  alpha: number
  qScaleFactor: (rank: number, total: number) => number
}): FdrItem[] {
  const sorted = [...input.tuples].sort((left, right) => left.pValue - right.pValue)
  const total = sorted.length
  const qAdjusted = new Array<number>(total).fill(1)

  for (let index = 0; index < total; index += 1) {
    const rank = index + 1
    qAdjusted[index] = Math.min(
      1,
      (sorted[index].pValue * total * input.qScaleFactor(rank, total)) / rank,
    )
  }

  for (let index = total - 2; index >= 0; index -= 1) {
    qAdjusted[index] = Math.min(qAdjusted[index], qAdjusted[index + 1])
  }

  const byOriginal = new Array<FdrItem>(total)
  for (let index = 0; index < total; index += 1) {
    const rank = index + 1
    const threshold = (rank / total) * input.alpha
    const tuple = sorted[index]
    byOriginal[tuple.index] = {
      index: tuple.index,
      rank,
      pValue: tuple.pValue,
      qValue: qAdjusted[index],
      threshold,
      passed: qAdjusted[index] <= input.alpha,
    }
  }

  return byOriginal
}

function estimateStoreyPi0(pValues: number[], lambda: number): number {
  const above = pValues.filter((value) => value > lambda).length
  const denominator = Math.max(pValues.length * (1 - lambda), 1e-12)
  return Math.min(1, Math.max(0, above / denominator))
}

function harmonicNumber(n: number): number {
  let total = 0
  for (let index = 1; index <= n; index += 1) {
    total += 1 / index
  }
  return total
}

function validatePValues(
  pValues: number[],
): Array<{ index: number; pValue: number }> {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error('pValues must be a non-empty array.')
  }
  return pValues.map((pValue, index) => {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new Error(`pValues[${index}] must be within [0, 1].`)
    }
    return { index, pValue }
  })
}

function validateAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error('alpha must be in (0, 1].')
  }
  return alpha
}

function validateProbability(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${field} must be in (0, 1).`)
  }
  return value
}

function validateSpaBootstrapDiagnostics(
  diagnostics: RunFdrCorrectionInput['spaBootstrapDiagnostics'],
  candidateCount: number,
): RunFdrCorrectionInput['spaBootstrapDiagnostics'] {
  if (!diagnostics) return diagnostics
  const blockSensitivity = diagnostics.blockSensitivityByCandidate
  const blockSizeSet = diagnostics.blockSizeSet
  if (blockSensitivity != null) {
    if (!Array.isArray(blockSensitivity) || blockSensitivity.length !== candidateCount) {
      throw new Error('spaBootstrapDiagnostics.blockSensitivityByCandidate length must match pValues length.')
    }
    const seen = new Set<number>()
    for (const [rowIndex, row] of blockSensitivity.entries()) {
      if (!Number.isInteger(row.candidateIndex) || row.candidateIndex < 0 || row.candidateIndex >= candidateCount) {
        throw new Error(`spaBootstrapDiagnostics.blockSensitivityByCandidate[${rowIndex}].candidateIndex is out of range.`)
      }
      if (seen.has(row.candidateIndex)) {
        throw new Error(`spaBootstrapDiagnostics.blockSensitivityByCandidate[${rowIndex}].candidateIndex is duplicated.`)
      }
      seen.add(row.candidateIndex)
      if (blockSizeSet != null) {
        const rowBlockSizes = row.blockSensitivity.map(item => item.blockSize)
        if (!sameNumberArray(rowBlockSizes, blockSizeSet)) {
          throw new Error(`spaBootstrapDiagnostics.blockSensitivityByCandidate[${rowIndex}].blockSensitivity block sizes must match blockSizeSet.`)
        }
      }
    }
  }
  if (diagnostics.unstableBootstrapCandidateIndexes != null) {
    const covered = new Set(blockSensitivity?.map(row => row.candidateIndex))
    for (const [index, candidateIndex] of diagnostics.unstableBootstrapCandidateIndexes.entries()) {
      if (!Number.isInteger(candidateIndex) || candidateIndex < 0 || candidateIndex >= candidateCount) {
        throw new Error(`spaBootstrapDiagnostics.unstableBootstrapCandidateIndexes[${index}] is out of range.`)
      }
      if (blockSensitivity != null && !covered.has(candidateIndex)) {
        throw new Error(`spaBootstrapDiagnostics.unstableBootstrapCandidateIndexes[${index}] is not covered by blockSensitivityByCandidate.`)
      }
    }
  }
  return diagnostics
}

function sameNumberArray(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
