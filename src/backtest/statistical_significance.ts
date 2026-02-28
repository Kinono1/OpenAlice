export interface PboInput {
  candidateReturns: number[][];
  partitions?: number;
}

export interface PboResult {
  pbo: number;
  logits: number[];
  splitsEvaluated: number;
  partitions: number;
}

export interface DeflatedSharpeInput {
  returns: number[];
  trialCount: number;
}

export interface DeflatedSharpeResult {
  observedSharpe: number;
  benchmarkSharpe: number;
  dsrValue: number;
  dsrProbability: number;
  skewness: number;
  kurtosis: number;
  trialCount: number;
}

export interface SignificanceGateInput {
  candidateReturns: number[][];
  selectedReturns: number[];
  partitions?: number;
  trialCount?: number;
  pboThreshold?: number;
  dsrMin?: number;
}

export interface SignificanceGateResult {
  passed: boolean;
  pboResult: PboResult;
  dsrResult: DeflatedSharpeResult;
  pboThreshold: number;
  dsrMin: number;
}

const EULER_GAMMA = 0.5772156649015329;

export function estimatePboCscv(input: PboInput): PboResult {
  const candidateReturns = validateCandidateReturns(input.candidateReturns);
  const partitions = resolvePartitions(input.partitions ?? 8);

  const minLen = Math.min(...candidateReturns.map((series) => series.length));
  const blockSize = Math.floor(minLen / partitions);
  if (blockSize < 2) {
    throw new Error("Not enough observations for requested CSCV partitions.");
  }

  const truncated = candidateReturns.map((series) => series.slice(series.length - blockSize * partitions));
  const half = partitions / 2;
  const trainCombos = chooseK([...Array(partitions).keys()], half);

  const logits: number[] = [];

  for (const trainBlocks of trainCombos) {
    const trainSet = new Set(trainBlocks);
    const testBlocks: number[] = [];
    for (let i = 0; i < partitions; i++) {
      if (!trainSet.has(i)) {
        testBlocks.push(i);
      }
    }

    const trainSharpes = truncated.map((series) => sharpe(concatBlocks(series, blockSize, trainBlocks)));
    const testSharpes = truncated.map((series) => sharpe(concatBlocks(series, blockSize, testBlocks)));

    const bestInSample = argMax(trainSharpes);
    const testRank = rankDescending(testSharpes, bestInSample);
    const relativeRank = (testRank + 1) / (testSharpes.length + 1);

    const clipped = clamp(relativeRank, 1e-6, 1 - 1e-6);
    logits.push(Math.log(clipped / (1 - clipped)));
  }

  const overfitCount = logits.filter((value) => value <= 0).length;
  return {
    pbo: overfitCount / logits.length,
    logits,
    splitsEvaluated: logits.length,
    partitions,
  };
}

export function computeDeflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const returns = validateReturns(input.returns, "selectedReturns");
  const trialCount = Math.max(2, Math.floor(input.trialCount));
  if (!Number.isFinite(input.trialCount) || input.trialCount < 2) {
    throw new Error("trialCount must be >= 2.");
  }

  const observedSharpe = sharpe(returns);
  const skewness = skew(returns);
  const kurtosis = kurt(returns);
  const sampleSize = returns.length;

  const denominatorCore = Math.max(
    1e-12,
    1 - skewness * observedSharpe + ((kurtosis - 1) / 4) * observedSharpe * observedSharpe,
  );

  const sigmaSharpe = Math.sqrt(denominatorCore / Math.max(sampleSize - 1, 1));

  const z1 = inverseNormalCdf(clamp(1 - 1 / trialCount, 1e-6, 1 - 1e-6));
  const z2 = inverseNormalCdf(clamp(1 - 1 / (trialCount * Math.E), 1e-6, 1 - 1e-6));
  const benchmarkSharpe = sigmaSharpe * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2);

  const zScore = (observedSharpe - benchmarkSharpe) / Math.max(sigmaSharpe, 1e-12);
  const dsrProbability = normalCdf(zScore);
  const dsrValue = observedSharpe - benchmarkSharpe;

  return {
    observedSharpe,
    benchmarkSharpe,
    dsrValue,
    dsrProbability,
    skewness,
    kurtosis,
    trialCount,
  };
}

export function evaluateSignificanceGate(input: SignificanceGateInput): SignificanceGateResult {
  const pboThreshold = clamp(input.pboThreshold ?? 0.2, 0, 1);
  const dsrMin = input.dsrMin ?? 0;

  const pboResult = estimatePboCscv({
    candidateReturns: input.candidateReturns,
    partitions: input.partitions,
  });

  const dsrResult = computeDeflatedSharpe({
    returns: input.selectedReturns,
    trialCount: input.trialCount ?? input.candidateReturns.length,
  });

  const passed = pboResult.pbo < pboThreshold && dsrResult.dsrValue > dsrMin;

  return {
    passed,
    pboResult,
    dsrResult,
    pboThreshold,
    dsrMin,
  };
}

function validateCandidateReturns(candidateReturns: number[][]): number[][] {
  if (!Array.isArray(candidateReturns) || candidateReturns.length < 2) {
    throw new Error("candidateReturns must contain at least 2 candidates.");
  }
  return candidateReturns.map((series, idx) => validateReturns(series, `candidateReturns[${idx}]`));
}

function validateReturns(values: number[], label: string): number[] {
  if (!Array.isArray(values) || values.length < 4) {
    throw new Error(`${label} must contain at least 4 returns.`);
  }
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) {
      throw new Error(`${label} contains non-finite value at index ${i}.`);
    }
  }
  return values;
}

function resolvePartitions(value: number): number {
  if (!Number.isInteger(value) || value < 4 || value % 2 !== 0) {
    throw new Error("partitions must be an even integer >= 4.");
  }
  return value;
}

function concatBlocks(series: number[], blockSize: number, blockIndexes: number[]): number[] {
  const out: number[] = [];
  for (const blockIndex of blockIndexes) {
    const start = blockIndex * blockSize;
    out.push(...series.slice(start, start + blockSize));
  }
  return out;
}

function chooseK(values: number[], k: number): number[][] {
  const out: number[][] = [];
  const acc: number[] = [];

  function rec(start: number): void {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i <= values.length - (k - acc.length); i++) {
      acc.push(values[i]);
      rec(i + 1);
      acc.pop();
    }
  }

  rec(0);
  return out;
}

function sharpe(returns: number[]): number {
  if (returns.length < 2) {
    return 0;
  }
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => {
    const centered = value - mean;
    return sum + centered * centered;
  }, 0) / returns.length;
  if (variance <= 0) {
    return 0;
  }
  return mean / Math.sqrt(variance);
}

function skew(returns: number[]): number {
  const n = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / n;
  const m2 = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const m3 = returns.reduce((sum, value) => sum + (value - mean) ** 3, 0) / n;
  if (m2 <= 0) {
    return 0;
  }
  return m3 / Math.pow(m2, 1.5);
}

function kurt(returns: number[]): number {
  const n = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / n;
  const m2 = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / n;
  const m4 = returns.reduce((sum, value) => sum + (value - mean) ** 4, 0) / n;
  if (m2 <= 0) {
    return 3;
  }
  return m4 / (m2 * m2);
}

function argMax(values: number[]): number {
  let idx = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[idx]) {
      idx = i;
    }
  }
  return idx;
}

function rankDescending(values: number[], index: number): number {
  const sorted = values
    .map((value, idx) => ({ value, idx }))
    .sort((a, b) => b.value - a.value);
  const rank = sorted.findIndex((entry) => entry.idx === index);
  return rank < 0 ? values.length - 1 : rank;
}

function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  // Abramowitz and Stegun formula 7.1.26
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t) *
      Math.exp(-ax * ax);
  return sign * y;
}

function inverseNormalCdf(p: number): number {
  // Peter John Acklam's approximation
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];

  const plow = 0.02425;
  const phigh = 1 - plow;

  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
