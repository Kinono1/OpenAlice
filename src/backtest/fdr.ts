export type FdrMethod =
  | "bh"
  | "by"
  | "cv_storey_bh"
  | "stepc"
  | "spa";

export interface FdrItem {
  index: number;
  rank: number;
  pValue: number;
  qValue: number;
  threshold: number;
  passed: boolean;
}

export interface FdrDiagnostics {
  method: FdrMethod;
  alpha: number;
  candidateCount: number;
  harmonicFactorCm: number | null;
  storeyPi0: number | null;
  storeyLambda: number | null;
  cvAggQuantile: number | null;
  candidateWindowCounts: number[] | null;
  approximation: string | null;
  orderedPValues: number[] | null;
  stepcCombinedPValues: number[] | null;
  selectionCutoff: number | null;
  benchmarkStrategyId: string | null;
  benchmarkStrategyIndex: number | null;
}

export interface RunFdrCorrectionInput {
  pValues: number[];
  alpha?: number;
  method?: FdrMethod;
  storeyLambda?: number;
  cvAggQuantile?: number;
  windowPValuesByCandidate?: number[][];
  benchmarkStrategyId?: string;
  benchmarkStrategyIndex?: number;
}

export interface RunFdrCorrectionResult {
  items: FdrItem[];
  diagnostics: FdrDiagnostics;
  effectivePValues: number[];
}

const DEFAULT_ALPHA = 0.1;
const DEFAULT_STOREY_LAMBDA = 0.5;
const DEFAULT_CV_AGG_QUANTILE = 0.9;

export function benjaminiHochberg(
  pValues: number[],
  alpha = DEFAULT_ALPHA,
): FdrItem[] {
  const validatedAlpha = validateAlpha(alpha);
  return runMonotonicCorrection({
    tuples: validatePValues(pValues),
    alpha: validatedAlpha,
    qScaleFactor: () => 1,
  });
}

export function benjaminiYekutieli(
  pValues: number[],
  alpha = DEFAULT_ALPHA,
): FdrItem[] {
  const validatedAlpha = validateAlpha(alpha);
  const tuples = validatePValues(pValues);
  const harmonicFactorCm = harmonicNumber(tuples.length);
  return runMonotonicCorrection({
    tuples,
    alpha: validatedAlpha,
    qScaleFactor: () => harmonicFactorCm,
  });
}

export function runFdrCorrection(
  input: RunFdrCorrectionInput,
): RunFdrCorrectionResult {
  const alpha = validateAlpha(input.alpha ?? DEFAULT_ALPHA);
  const method = input.method ?? "bh";
  const tuples = validatePValues(input.pValues);
  const effectivePValues =
    method === "cv_storey_bh"
      ? aggregateCvWindowPValues({
          tuples,
          cvAggQuantile: input.cvAggQuantile ?? DEFAULT_CV_AGG_QUANTILE,
          windowPValuesByCandidate: input.windowPValuesByCandidate,
        })
      : tuples.map((tuple) => tuple.pValue);
  const effectiveTuples = effectivePValues.map((pValue, index) => ({
    index,
    pValue,
  }));

  if (method === "bh") {
    return {
      items: benjaminiHochberg(effectivePValues, alpha),
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
      }),
      effectivePValues,
    };
  }

  if (method === "by") {
    const harmonicFactorCm = harmonicNumber(effectivePValues.length);
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
    };
  }

  if (method === "stepc") {
    const result = runStepwiseCauchyCombination(effectivePValues, alpha);
    return {
      items: result.items,
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
        approximation:
          "stepwise_cauchy_prefix_approximation",
        orderedPValues: result.orderedPValues,
        stepcCombinedPValues: result.combinedPValues,
        selectionCutoff: result.selectionCutoff,
      }),
      effectivePValues,
    };
  }

  if (method === "spa") {
    const items = runIdentityCorrection({
      tuples: effectiveTuples,
      alpha,
    });
    const orderedPValues = [...effectivePValues].sort((left, right) => left - right);
    const selectionCutoff = items.filter((item) => item.passed).length;
    return {
      items,
      diagnostics: buildBaseDiagnostics({
        method,
        alpha,
        candidateCount: effectivePValues.length,
        approximation:
          "spa_uses_validation_layer_benchmark_p_values",
        orderedPValues,
        selectionCutoff,
        benchmarkStrategyId: input.benchmarkStrategyId ?? null,
        benchmarkStrategyIndex:
          input.benchmarkStrategyIndex ?? null,
      }),
      effectivePValues,
    };
  }

  const storeyLambda = validateProbability(
    input.storeyLambda ?? DEFAULT_STOREY_LAMBDA,
    "storeyLambda",
  );
  const storeyPi0 = estimateStoreyPi0(effectivePValues, storeyLambda);
  const candidateWindowCounts = Array.isArray(input.windowPValuesByCandidate)
    ? input.windowPValuesByCandidate.map((value) =>
        Array.isArray(value) ? value.length : 0,
      )
    : null;

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
  };
}

function buildBaseDiagnostics(input: {
  method: FdrMethod;
  alpha: number;
  candidateCount: number;
  harmonicFactorCm?: number | null;
  storeyPi0?: number | null;
  storeyLambda?: number | null;
  cvAggQuantile?: number | null;
  candidateWindowCounts?: number[] | null;
  approximation?: string | null;
  orderedPValues?: number[] | null;
  stepcCombinedPValues?: number[] | null;
  selectionCutoff?: number | null;
  benchmarkStrategyId?: string | null;
  benchmarkStrategyIndex?: number | null;
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
  };
}

function aggregateCvWindowPValues(input: {
  tuples: Array<{ index: number; pValue: number }>;
  cvAggQuantile: number;
  windowPValuesByCandidate?: number[][];
}): number[] {
  const quantile = validateProbability(
    input.cvAggQuantile,
    "cvAggQuantile",
  );
  return input.tuples.map((tuple, index) => {
    const windowPValues = input.windowPValuesByCandidate?.[index];
    if (!Array.isArray(windowPValues) || windowPValues.length === 0) {
      return tuple.pValue;
    }
    const sorted = windowPValues
      .map((value, windowIndex) => {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          throw new Error(
            `windowPValuesByCandidate[${index}][${windowIndex}] must be within [0, 1].`,
          );
        }
        return value;
      })
      .sort((left, right) => left - right);
    const rank = Math.max(
      0,
      Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1),
    );
    return sorted[rank];
  });
}

function runStepwiseCauchyCombination(
  pValues: number[],
  alpha: number,
): {
  items: FdrItem[];
  orderedPValues: number[];
  combinedPValues: number[];
  selectionCutoff: number;
} {
  const tuples = validatePValues(pValues);
  const sorted = [...tuples].sort((left, right) => left.pValue - right.pValue);
  const orderedPValues = sorted.map((tuple) => tuple.pValue);
  const prefixCombined = orderedPValues.map((_, index) =>
    cauchyCombinedPValue(orderedPValues.slice(0, index + 1)),
  );
  const monotonicCombined = [...prefixCombined];
  for (let index = 1; index < monotonicCombined.length; index += 1) {
    monotonicCombined[index] = Math.max(
      monotonicCombined[index],
      monotonicCombined[index - 1],
    );
  }
  let selectionCutoff = 0;
  for (let index = 0; index < monotonicCombined.length; index += 1) {
    if (monotonicCombined[index] <= alpha) {
      selectionCutoff = index + 1;
    }
  }

  const byOriginal = new Array<FdrItem>(sorted.length);
  for (let index = 0; index < sorted.length; index += 1) {
    const rank = index + 1;
    const tuple = sorted[index];
    byOriginal[tuple.index] = {
      index: tuple.index,
      rank,
      pValue: tuple.pValue,
      qValue: monotonicCombined[index],
      threshold: alpha,
      passed: rank <= selectionCutoff,
    };
  }

  return {
    items: byOriginal,
    orderedPValues,
    combinedPValues: monotonicCombined,
    selectionCutoff,
  };
}

function cauchyCombinedPValue(pValues: number[]): number {
  const validated = validatePValues(pValues).map((item) =>
    clamp(item.pValue, 1e-12, 1 - 1e-12),
  );
  const statistic =
    validated.reduce(
      (sum, value) => sum + Math.tan((0.5 - value) * Math.PI),
      0,
    ) / validated.length;
  return clamp(0.5 - Math.atan(statistic) / Math.PI, 0, 1);
}

function runIdentityCorrection(input: {
  tuples: Array<{ index: number; pValue: number }>;
  alpha: number;
}): FdrItem[] {
  const sorted = [...input.tuples].sort((left, right) => left.pValue - right.pValue);
  const out = new Array<FdrItem>(sorted.length);
  for (let index = 0; index < sorted.length; index += 1) {
    const tuple = sorted[index];
    out[tuple.index] = {
      index: tuple.index,
      rank: index + 1,
      pValue: tuple.pValue,
      qValue: tuple.pValue,
      threshold: input.alpha,
      passed: tuple.pValue <= input.alpha,
    };
  }
  return out;
}

function runMonotonicCorrection(input: {
  tuples: Array<{ index: number; pValue: number }>;
  alpha: number;
  qScaleFactor: (rank: number, total: number) => number;
}): FdrItem[] {
  const sorted = [...input.tuples].sort((left, right) => left.pValue - right.pValue);
  const total = sorted.length;
  const qAdjusted = new Array<number>(total).fill(1);

  for (let index = 0; index < total; index += 1) {
    const rank = index + 1;
    qAdjusted[index] = Math.min(
      1,
      (sorted[index].pValue * total * input.qScaleFactor(rank, total)) / rank,
    );
  }

  for (let index = total - 2; index >= 0; index -= 1) {
    qAdjusted[index] = Math.min(qAdjusted[index], qAdjusted[index + 1]);
  }

  const byOriginal = new Array<FdrItem>(total);
  for (let index = 0; index < total; index += 1) {
    const rank = index + 1;
    const threshold = (rank / total) * input.alpha;
    const tuple = sorted[index];
    byOriginal[tuple.index] = {
      index: tuple.index,
      rank,
      pValue: tuple.pValue,
      qValue: qAdjusted[index],
      threshold,
      passed: qAdjusted[index] <= input.alpha,
    };
  }

  return byOriginal;
}

function estimateStoreyPi0(pValues: number[], lambda: number): number {
  const above = pValues.filter((value) => value > lambda).length;
  const denominator = Math.max(pValues.length * (1 - lambda), 1e-12);
  return Math.min(1, Math.max(0, above / denominator));
}

function harmonicNumber(n: number): number {
  let total = 0;
  for (let index = 1; index <= n; index += 1) {
    total += 1 / index;
  }
  return total;
}

function validatePValues(
  pValues: number[],
): Array<{ index: number; pValue: number }> {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("pValues must be a non-empty array.");
  }
  return pValues.map((pValue, index) => {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new Error(`pValues[${index}] must be within [0, 1].`);
    }
    return { index, pValue };
  });
}

function validateAlpha(alpha: number): number {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error("alpha must be in (0, 1].");
  }
  return alpha;
}

function validateProbability(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${field} must be in (0, 1).`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
