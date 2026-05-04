export interface PboInput {
  candidateReturns: number[][]
  partitions?: number
}

export interface PboResult {
  pbo: number
  logits: number[]
  splitsEvaluated: number
  partitions: number
}

export interface DeflatedSharpeInput {
  returns: number[]
  trialCount: number
  independentBetCount?: number
  minimumIndependentBets?: number
}

export interface DeflatedSharpeResult {
  observedSharpe: number
  benchmarkSharpe: number
  dsrValue: number
  dsrProbability: number | null
  skewness: number
  kurtosis: number
  trialCount: number
  independentBets?: number
  minimumIndependentBets?: number
  diagnosticQuality?: 'ok' | 'low_sample'
  promotionEligible?: boolean
  blockedReason?: string | null
}

export interface SignificanceGateInput {
  candidateReturns: number[][]
  selectedReturns: number[]
  partitions?: number
  trialCount?: number
  pboThreshold?: number
  dsrMin?: number
  trialLedger?: TrialLedgerSummary | null
  fdrDiagnostics?: {
    method?: string
    bootstrapDirectionStable?: boolean | null
    unstableBootstrapCandidateIndexes?: number[] | null
    blockSizeSet?: number[] | null
  } | null
}

export interface TrialLedgerSummary {
  rawM: number
  effectiveM?: number | null
  rawMComplete: boolean
  includesFailedTrials: boolean
  failedTrialCount: number
  survivingTrialCount: number
  fdrMethodPrimary?: 'BY_raw_m' | 'BY_effective_m' | 'BH_secondary' | string
}

export function buildTrialLedgerSummary(input: {
  rawM: number
  effectiveM?: number | null
  survivingTrialCount?: number
  rawMComplete?: boolean
  includesFailedTrials?: boolean
  fdrMethodPrimary?: TrialLedgerSummary['fdrMethodPrimary']
}): TrialLedgerSummary {
  const rawM = Math.max(0, Math.floor(input.rawM))
  const survivingTrialCount = Math.max(
    0,
    Math.min(rawM, Math.floor(input.survivingTrialCount ?? (rawM > 0 ? 1 : 0))),
  )
  return {
    rawM,
    effectiveM: input.effectiveM ?? null,
    rawMComplete: input.rawMComplete ?? false,
    includesFailedTrials: input.includesFailedTrials ?? false,
    failedTrialCount: Math.max(0, rawM - survivingTrialCount),
    survivingTrialCount,
    fdrMethodPrimary: input.fdrMethodPrimary ?? 'BY_raw_m',
  }
}

export interface SignificanceGateResult {
  passed: boolean
  pboResult: PboResult
  dsrResult: DeflatedSharpeResult
  pboThreshold: number
  dsrMin: number
  candidateTrialCount?: number
  fdrQ?: number | null
  trialLedger?: TrialLedgerSummary | null
  fdrDiagnostics?: SignificanceGateInput['fdrDiagnostics']
}

export interface SpaLikeInput {
  candidateReturns: number[][]
  benchmarkIndex: number
  bootstrapSamples?: number
  blockSize?: number
  blockSizeSet?: number[]
  alpha?: number
}

export interface SpaLikeCandidateResult {
  candidateIndex: number
  benchmarkIndex: number
  observedMeanExcess: number
  pValue: number
  bootstrapSamples: number
  blockSize: number
  blockSensitivity: Array<{
    blockSize: number
    observedMeanExcess: number
    pValue: number
    passed: boolean
  }>
  bootstrapDirectionStable: boolean
  unstableBootstrap: boolean
}

export interface SpaLikeResult {
  benchmarkIndex: number
  bootstrapSamples: number
  blockSize: number
  alpha: number
  blockSizeSet: number[]
  bootstrapDirectionStable: boolean
  unstableBootstrapCandidateIndexes: number[]
  items: SpaLikeCandidateResult[]
}

const EULER_GAMMA = 0.5772156649015329
const DEFAULT_SPA_BOOTSTRAP_SAMPLES = 400

export function estimatePboCscv(input: PboInput): PboResult {
  const candidateReturns = validateCandidateReturns(input.candidateReturns)
  const partitions = resolvePartitions(input.partitions ?? 8)

  const minLen = Math.min(...candidateReturns.map((series) => series.length))
  const blockSize = Math.floor(minLen / partitions)
  if (blockSize < 2) {
    throw new Error('Not enough observations for requested CSCV partitions.')
  }

  const truncated = candidateReturns.map((series) => series.slice(series.length - blockSize * partitions))
  const half = partitions / 2
  const trainCombos = chooseK([...Array(partitions).keys()], half)

  const logits: number[] = []

  for (const trainBlocks of trainCombos) {
    const trainSet = new Set(trainBlocks)
    const testBlocks: number[] = []
    for (let i = 0; i < partitions; i++) {
      if (!trainSet.has(i)) {
        testBlocks.push(i)
      }
    }

    const trainSharpes = truncated.map((series) => sharpe(concatBlocks(series, blockSize, trainBlocks)))
    const testSharpes = truncated.map((series) => sharpe(concatBlocks(series, blockSize, testBlocks)))

    const bestInSample = argMax(trainSharpes)
    const testRank = rankDescending(testSharpes, bestInSample)
    const relativeRank = (testRank + 1) / (testSharpes.length + 1)

    const clipped = clamp(relativeRank, 1e-6, 1 - 1e-6)
    logits.push(Math.log(clipped / (1 - clipped)))
  }

  const overfitCount = logits.filter((value) => value <= 0).length
  return {
    pbo: overfitCount / logits.length,
    logits,
    splitsEvaluated: logits.length,
    partitions,
  }
}

export function computeDeflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const returns = validateReturns(input.returns, 'selectedReturns')
  if (!Number.isFinite(input.trialCount) || input.trialCount <= 0) {
    throw new Error('trialCount must be > 0.')
  }
  const trialCount = Math.max(2, Math.floor(input.trialCount))
  const independentBets = Math.max(
    0,
    Math.floor(input.independentBetCount ?? input.returns.length),
  )
  const minimumIndependentBets = Math.max(
    1,
    Math.floor(input.minimumIndependentBets ?? 100),
  )

  const observedSharpe = sharpe(returns)
  const skewness = skew(returns)
  const kurtosis = kurt(returns)
  const sampleSize = returns.length

  const denominatorCore = Math.max(
    1e-12,
    1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe * observedSharpe,
  )

  const sigmaSharpe = Math.sqrt(denominatorCore / Math.max(sampleSize - 1, 1))

  const z1 = inverseNormalCdf(clamp(1 - 1 / trialCount, 1e-6, 1 - 1e-6))
  const z2 = inverseNormalCdf(clamp(1 - 1 / (trialCount * Math.E), 1e-6, 1 - 1e-6))
  const benchmarkSharpe = sigmaSharpe * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)

  const zScore = (observedSharpe - benchmarkSharpe) / Math.max(sigmaSharpe, 1e-12)
  const sampleEligible = independentBets >= minimumIndependentBets
  const dsrProbability = sampleEligible ? normalCdf(zScore) : null
  const dsrValue = observedSharpe - benchmarkSharpe

  return {
    observedSharpe,
    benchmarkSharpe,
    dsrValue,
    dsrProbability,
    skewness,
    kurtosis,
    trialCount,
    independentBets,
    minimumIndependentBets,
    diagnosticQuality: sampleEligible ? 'ok' : 'low_sample',
    promotionEligible: sampleEligible,
    blockedReason: sampleEligible
      ? null
      : `independent_bets_below_${minimumIndependentBets}`,
  }
}

export function evaluateSignificanceGate(input: SignificanceGateInput): SignificanceGateResult {
  const pboThreshold = clamp(input.pboThreshold ?? 0.1, 0, 1)
  const dsrMin = clamp(input.dsrMin ?? 0.95, 0, 1)
  const candidateTrialCount = Math.max(
    0,
    Math.floor(input.trialCount ?? input.candidateReturns.length),
  )

  const pboResult =
    input.candidateReturns.length < 2
      ? {
          pbo: 1,
          logits: [],
          splitsEvaluated: 0,
          partitions: resolvePartitions(input.partitions ?? 8),
        }
      : estimatePboCscv({
          candidateReturns: input.candidateReturns,
          partitions: input.partitions,
        })

  const dsrResult = computeDeflatedSharpe({
    returns: input.selectedReturns,
    trialCount: input.trialCount ?? input.candidateReturns.length,
  })

  const passed = pboResult.pbo <= pboThreshold && (dsrResult.dsrProbability ?? -Infinity) >= dsrMin

  return {
    passed,
    pboResult,
    dsrResult,
    pboThreshold,
    dsrMin,
    candidateTrialCount,
    fdrQ: null,
    trialLedger: input.trialLedger ?? null,
    fdrDiagnostics: input.fdrDiagnostics ?? null,
  }
}

export function computeSpaLikePValues(input: SpaLikeInput): SpaLikeResult {
  const candidateReturns = validateCandidateReturns(input.candidateReturns)
  const benchmarkIndex = resolveBenchmarkIndex(
    input.benchmarkIndex,
    candidateReturns.length,
  )
  const bootstrapSamples = resolveSpaBootstrapSamples(
    input.bootstrapSamples ?? DEFAULT_SPA_BOOTSTRAP_SAMPLES,
  )
  const alpha = validateSpaAlpha(input.alpha ?? 0.1)
  const minLen = Math.min(...candidateReturns.map((series) => series.length))
  const normalizedReturns = candidateReturns.map((series) =>
    series.slice(series.length - minLen),
  )
  const blockSize = resolveSpaBlockSize(
    input.blockSize ?? defaultSpaBlockSize(minLen),
    minLen,
  )
  const blockSizeSet = resolveSpaBlockSizeSet(
    [...(input.blockSizeSet ?? defaultSpaBlockSizeSet(blockSize)), blockSize],
    minLen,
  )
  const itemSets = blockSizeSet.map(size => computeSpaLikeItems({
    normalizedReturns,
    benchmarkIndex,
    bootstrapSamples,
    blockSize: size,
  }))
  const primaryItems = computeSpaLikeItems({
    normalizedReturns,
    benchmarkIndex,
    bootstrapSamples,
    blockSize,
  })
  const itemSetsByBlockSize = new Map<number, SpaLikeCandidateResult[]>(
    itemSets.map((items, index) => [blockSizeSet[index], items]),
  )
  itemSetsByBlockSize.set(blockSize, primaryItems)
  const enrichedItems = primaryItems.map(item => {
    const blockSensitivity = blockSizeSet.map(size => {
      const sensitivityItem = itemSetsByBlockSize.get(size)?.[item.candidateIndex] ?? item
      return {
        blockSize: size,
        observedMeanExcess: sensitivityItem.observedMeanExcess,
        pValue: sensitivityItem.pValue,
        passed: sensitivityItem.pValue <= alpha,
      }
    })
    const passStates = new Set(blockSensitivity.map(entry => entry.passed))
    const signStates = new Set(blockSensitivity.map(entry =>
      entry.observedMeanExcess > 0 ? 'positive' : entry.observedMeanExcess < 0 ? 'negative' : 'zero',
    ))
    const bootstrapDirectionStable = passStates.size <= 1 && signStates.size <= 1
    return {
      ...item,
      blockSensitivity,
      bootstrapDirectionStable,
      unstableBootstrap: !bootstrapDirectionStable,
    }
  })
  const unstableBootstrapCandidateIndexes = enrichedItems
    .filter(item => item.unstableBootstrap)
    .map(item => item.candidateIndex)

  return {
    benchmarkIndex,
    bootstrapSamples,
    blockSize,
    alpha,
    blockSizeSet,
    bootstrapDirectionStable: unstableBootstrapCandidateIndexes.length === 0,
    unstableBootstrapCandidateIndexes,
    items: enrichedItems,
  }
}

function computeSpaLikeItems(input: {
  normalizedReturns: number[][]
  benchmarkIndex: number
  bootstrapSamples: number
  blockSize: number
}): SpaLikeCandidateResult[] {
  const benchmarkReturns = input.normalizedReturns[input.benchmarkIndex]
  return input.normalizedReturns.map((returns, candidateIndex) => {
    if (candidateIndex === input.benchmarkIndex) {
      return {
        candidateIndex,
        benchmarkIndex: input.benchmarkIndex,
        observedMeanExcess: 0,
        pValue: 1,
        bootstrapSamples: input.bootstrapSamples,
        blockSize: input.blockSize,
        blockSensitivity: [],
        bootstrapDirectionStable: true,
        unstableBootstrap: false,
      }
    }

    const excessReturns = returns.map(
      (value, index) => value - benchmarkReturns[index],
    )
    const observedMeanExcess = mean(excessReturns)
    if (observedMeanExcess <= 0) {
      return {
        candidateIndex,
        benchmarkIndex: input.benchmarkIndex,
        observedMeanExcess,
        pValue: 1,
        bootstrapSamples: input.bootstrapSamples,
        blockSize: input.blockSize,
        blockSensitivity: [],
        bootstrapDirectionStable: true,
        unstableBootstrap: false,
      }
    }

    const centeredExcess = excessReturns.map(
      (value) => value - observedMeanExcess,
    )
    let exceedCount = 0
    for (
      let sampleIndex = 0;
      sampleIndex < input.bootstrapSamples;
      sampleIndex += 1
    ) {
      const sampled = sampleMovingBlocks(centeredExcess, input.blockSize, sampleIndex)
      if (mean(sampled) >= observedMeanExcess) {
        exceedCount += 1
      }
    }

    return {
      candidateIndex,
      benchmarkIndex: input.benchmarkIndex,
      observedMeanExcess,
      pValue: (exceedCount + 1) / (input.bootstrapSamples + 1),
      bootstrapSamples: input.bootstrapSamples,
      blockSize: input.blockSize,
      blockSensitivity: [],
      bootstrapDirectionStable: true,
      unstableBootstrap: false,
    }
  })
}

function validateCandidateReturns(candidateReturns: number[][]): number[][] {
  if (!Array.isArray(candidateReturns) || candidateReturns.length < 2) {
    throw new Error('candidateReturns must contain at least 2 candidates.')
  }
  return candidateReturns.map((series, idx) => validateReturns(series, `candidateReturns[${idx}]`))
}

function validateReturns(values: number[], label: string): number[] {
  if (!Array.isArray(values) || values.length < 4) {
    throw new Error(`${label} must contain at least 4 returns.`)
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`${label} contains non-finite value at index ${i}.`)
    }
  }
  return values
}

function resolveBenchmarkIndex(value: number, candidateCount: number): number {
  if (!Number.isInteger(value) || value < 0 || value >= candidateCount) {
    throw new Error('benchmarkIndex must reference a valid candidate.')
  }
  return value
}

function resolveSpaBootstrapSamples(value: number): number {
  if (!Number.isInteger(value) || value < 50) {
    throw new Error('spaBootstrapSamples must be an integer >= 50.')
  }
  return value
}

function defaultSpaBlockSize(seriesLength: number): number {
  return Math.max(5, Math.floor(seriesLength ** (1 / 3)))
}

function defaultSpaBlockSizeSet(baseBlockSize: number): number[] {
  return [
    Math.max(2, Math.floor(0.5 * baseBlockSize)),
    baseBlockSize,
    2 * baseBlockSize,
  ]
}

function resolveSpaBlockSize(value: number, seriesLength: number): number {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('spaBlockSize must be an integer >= 2.')
  }
  return Math.min(value, Math.max(2, seriesLength))
}

function resolveSpaBlockSizeSet(values: number[], seriesLength: number): number[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('spaBlockSizeSet must be a non-empty array.')
  }
  return [...new Set(values.map(value => resolveSpaBlockSize(value, seriesLength)))]
    .sort((left, right) => left - right)
}

function validateSpaAlpha(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error('spa alpha must be in (0, 1].')
  }
  return value
}

function resolvePartitions(value: number): number {
  if (!Number.isInteger(value) || value < 4 || value % 2 !== 0) {
    throw new Error('partitions must be an even integer >= 4.')
  }
  return value
}

function concatBlocks(series: number[], blockSize: number, blockIndexes: number[]): number[] {
  const out: number[] = []
  for (const blockIndex of blockIndexes) {
    const start = blockIndex * blockSize
    out.push(...series.slice(start, start + blockSize))
  }
  return out
}

function chooseK(values: number[], k: number): number[][] {
  const results: number[][] = []
  const current: number[] = []

  function backtrack(start: number): void {
    if (current.length === k) {
      results.push([...current])
      return
    }
    for (let i = start; i <= values.length - (k - current.length); i++) {
      current.push(values[i])
      backtrack(i + 1)
      current.pop()
    }
  }

  backtrack(0)
  return results
}

function rankDescending(values: number[], index: number): number {
  const sorted = values
    .map((value, idx) => ({ value, idx }))
    .sort((left, right) => right.value - left.value)
  const rank = sorted.findIndex((entry) => entry.idx === index)
  return rank < 0 ? values.length - 1 : rank
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function sharpe(values: number[]): number {
  if (values.length < 2) {
    return 0
  }
  const avg = mean(values)
  const variance = values.reduce((sum, value) => {
    const centered = value - avg
    return sum + centered * centered
  }, 0) / (values.length - 1)
  if (variance <= 0) {
    return 0
  }
  return avg / Math.sqrt(variance)
}

function skew(values: number[]): number {
  const n = values.length
  const avg = values.reduce((sum, value) => sum + value, 0) / n
  const m2 = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / n
  const m3 = values.reduce((sum, value) => sum + (value - avg) ** 3, 0) / n
  if (m2 <= 0) {
    return 0
  }
  return m3 / Math.pow(m2, 1.5)
}

function kurt(values: number[]): number {
  const n = values.length
  const avg = values.reduce((sum, value) => sum + value, 0) / n
  const m2 = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / n
  const m4 = values.reduce((sum, value) => sum + (value - avg) ** 4, 0) / n
  if (m2 <= 0) {
    return 3
  }
  return m4 / (m2 * m2)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function inverseNormalCdf(p: number): number {
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ]
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ]

  const plow = 0.02425
  const phigh = 1 - plow

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }

  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.sqrt(2)))
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1
  const ax = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * ax)
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax)
  return sign * y
}

function sampleMovingBlocks(
  values: number[],
  blockSize: number,
  seed: number,
): number[] {
  const out: number[] = []
  const targetLength = values.length
  let state = mixSeed(seed, targetLength, blockSize)
  while (out.length < targetLength) {
    state = nextSeed(state)
    const start = Math.floor((state / 0xffffffff) * values.length) % values.length
    for (let offset = 0; offset < blockSize && out.length < targetLength; offset += 1) {
      out.push(values[(start + offset) % values.length])
    }
  }
  return out
}

function mixSeed(seed: number, targetLength: number, blockSize: number): number {
  return (
    ((seed + 1) * 2654435761 + targetLength * 2246822519 + blockSize * 3266489917) >>>
    0
  )
}

function nextSeed(state: number): number {
  return (1664525 * state + 1013904223) >>> 0
}

function argMax(values: number[]): number {
  let idx = 0
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[idx]) {
      idx = i
    }
  }
  return idx
}
