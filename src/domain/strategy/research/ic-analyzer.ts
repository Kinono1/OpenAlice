export interface IcSample {
  factorValue: number
  forwardReturn: number
  bucketKey?: string | number
}

export interface IcSummary {
  meanIc: number
  icStdDev: number
  icIr: number
  winRate: number
  observations: number
  periods: number
  passed: boolean
}

export interface IcThresholds {
  minMeanIc: number
  minIcIr: number
  minWinRate: number
}

const DEFAULT_THRESHOLDS: IcThresholds = {
  minMeanIc: 0.03,
  minIcIr: 0.5,
  minWinRate: 0.55,
}

function rank(values: number[]): number[] {
  const pairs = values.map((value, index) => ({ value, index }))
  pairs.sort((left, right) => left.value - right.value)
  const ranks = Array(values.length).fill(0)

  let cursor = 0
  while (cursor < pairs.length) {
    let next = cursor + 1
    while (next < pairs.length && pairs[next].value === pairs[cursor].value) {
      next += 1
    }
    const averageRank = (cursor + next - 1) / 2 + 1
    for (let index = cursor; index < next; index += 1) {
      ranks[pairs[index].index] = averageRank
    }
    cursor = next
  }

  return ranks
}

function pearsonCorrelation(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length < 2) {
    return 0
  }
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length
  let numerator = 0
  let leftVariance = 0
  let rightVariance = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftCentered = left[index] - leftMean
    const rightCentered = right[index] - rightMean
    numerator += leftCentered * rightCentered
    leftVariance += leftCentered ** 2
    rightVariance += rightCentered ** 2
  }
  const denominator = Math.sqrt(leftVariance * rightVariance)
  return denominator > 0 ? numerator / denominator : 0
}

export function spearmanIc(samples: IcSample[]): number {
  if (samples.length < 2) {
    return 0
  }
  const factorRanks = rank(samples.map((sample) => sample.factorValue))
  const returnRanks = rank(samples.map((sample) => sample.forwardReturn))
  return pearsonCorrelation(factorRanks, returnRanks)
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length,
  )
}

export function analyzeInformationCoefficient(
  samples: IcSample[],
  thresholds: Partial<IcThresholds> = {},
): IcSummary {
  const mergedThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...thresholds,
  }
  const grouped = new Map<string | number, IcSample[]>()
  samples.forEach((sample, index) => {
    const key = sample.bucketKey ?? index
    const bucket = grouped.get(key) ?? []
    bucket.push(sample)
    grouped.set(key, bucket)
  })

  const periodIcs = Array.from(grouped.values())
    .map((bucket) => spearmanIc(bucket))
    .filter((value) => Number.isFinite(value))
  const meanIc = periodIcs.length > 0
    ? periodIcs.reduce((sum, value) => sum + value, 0) / periodIcs.length
    : 0
  const icStdDev = standardDeviation(periodIcs)
  const icIr = icStdDev > 0
    ? meanIc / icStdDev
    : meanIc > 0
      ? Number.POSITIVE_INFINITY
      : meanIc < 0
        ? Number.NEGATIVE_INFINITY
        : 0
  const winRate = periodIcs.length > 0
    ? periodIcs.filter((value) => value > 0).length / periodIcs.length
    : 0

  return {
    meanIc,
    icStdDev,
    icIr,
    winRate,
    observations: samples.length,
    periods: periodIcs.length,
    passed:
      meanIc >= mergedThresholds.minMeanIc
      && icIr >= mergedThresholds.minIcIr
      && winRate >= mergedThresholds.minWinRate,
  }
}
