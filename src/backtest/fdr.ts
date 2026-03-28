export interface FdrItem {
  index: number;
  rank: number;
  pValue: number;
  qValue: number;
  threshold: number;
  passed: boolean;
}

export type FdrMethod = "bh" | "by" | "storey_bh" | "e_bh";

export interface FdrApplyOptions {
  method?: FdrMethod;
  storeyLambda?: number;
}

export interface FdrDiagnostics {
  method: FdrMethod;
  alpha: number;
  candidateCount: number;
  harmonicFactorCm: number | null;
  storeyPi0: number | null;
  storeyLambda: number | null;
}

export interface FdrApplyResult {
  items: FdrItem[];
  diagnostics: FdrDiagnostics;
}

function validateFdrInput(pValues: number[], alpha: number): void {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("pValues must be a non-empty array.");
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error("alpha must be in (0, 1].");
  }

  for (let index = 0; index < pValues.length; index++) {
    const pValue = pValues[index];
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new Error(`pValues[${index}] must be within [0, 1].`);
    }
  }
}

function harmonicFactor(m: number): number {
  let total = 0;
  for (let i = 1; i <= m; i++) {
    total += 1 / i;
  }
  return total;
}

function estimateStoreyPi0(sortedPValues: number[], lambda: number): number {
  const m = sortedPValues.length;
  const above = sortedPValues.filter((p) => p > lambda).length;
  const denom = m * (1 - lambda);
  if (denom <= 0) {
    return 1;
  }
  const pi0 = above / denom;
  if (!Number.isFinite(pi0)) {
    return 1;
  }
  // Guard against degenerate pi0=0 for small samples, which can force q=0.
  const finiteSampleFloor = 1 / m;
  return Math.max(finiteSampleFloor, Math.min(1, pi0));
}

export function applyFdr(
  pValues: number[],
  alpha = 0.1,
  options: FdrApplyOptions = {}
): FdrApplyResult {
  validateFdrInput(pValues, alpha);

  const method = options.method ?? "bh";
  if (!["bh", "by", "storey_bh", "e_bh"].includes(method)) {
    throw new Error(`unsupported FDR method: ${String(method)}`);
  }
  const storeyLambdaRaw = options.storeyLambda ?? 0.5;
  if (!Number.isFinite(storeyLambdaRaw) || storeyLambdaRaw < 0 || storeyLambdaRaw >= 1) {
    throw new Error("storeyLambda must be in [0, 1).");
  }

  const tuples = pValues.map((pValue, index) => ({ index, pValue }));

  const sorted = [...tuples].sort((a, b) => a.pValue - b.pValue);
  const m = sorted.length;
  const qAdjusted = new Array<number>(m).fill(1);
  const sortedPValues = sorted.map((row) => row.pValue);

  const cm = method === "by" ? harmonicFactor(m) : 1;
  const storeyPi0 =
    method === "storey_bh" ? estimateStoreyPi0(sortedPValues, storeyLambdaRaw) : 1;

  if (method === "e_bh") {
    const eValues = sortedPValues.map((p) => 1 / Math.max(p, 1e-12));
    const qAdjusted = new Array<number>(m).fill(1);
    let runningRequiredAlpha = 0;

    for (let i = 0; i < m; i++) {
      const rank = i + 1;
      const requiredAlpha = Math.min(1, m / (rank * eValues[i]));
      runningRequiredAlpha = Math.max(runningRequiredAlpha, requiredAlpha);
      qAdjusted[i] = runningRequiredAlpha;
    }

    const byOriginal = new Array<FdrItem>(m);
    for (let i = 0; i < m; i++) {
      const rank = i + 1;
      const tuple = sorted[i];
      byOriginal[tuple.index] = {
        index: tuple.index,
        rank,
        pValue: tuple.pValue,
        qValue: qAdjusted[i],
        threshold: Math.max(0, Math.min(1, alpha * rank / m)),
        passed: qAdjusted[i] <= alpha,
      };
    }

    return {
      items: byOriginal,
      diagnostics: {
        method,
        alpha,
        candidateCount: m,
        harmonicFactorCm: null,
        storeyPi0: null,
        storeyLambda: null,
      },
    };
  }

  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    const scale =
      method === "by"
        ? cm
        : method === "storey_bh"
          ? storeyPi0
          : 1;
    qAdjusted[i] = Math.min(1, (sorted[i].pValue * m * scale) / rank);
  }

  for (let i = m - 2; i >= 0; i--) {
    qAdjusted[i] = Math.min(qAdjusted[i], qAdjusted[i + 1]);
  }

  const byOriginal = new Array<FdrItem>(m);
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    let threshold = (rank / m) * alpha;
    if (method === "by") {
      threshold = (rank / (m * cm)) * alpha;
    } else if (method === "storey_bh") {
      threshold = (rank / (m * storeyPi0)) * alpha;
    }
    threshold = Math.max(0, Math.min(1, threshold));
    const tuple = sorted[i];
    const item: FdrItem = {
      index: tuple.index,
      rank,
      pValue: tuple.pValue,
      qValue: qAdjusted[i],
      threshold,
      passed: qAdjusted[i] <= alpha,
    };
    byOriginal[tuple.index] = item;
  }

  return {
    items: byOriginal,
    diagnostics: {
      method,
      alpha,
      candidateCount: m,
      harmonicFactorCm: method === "by" ? cm : null,
      storeyPi0: method === "storey_bh" ? storeyPi0 : null,
      storeyLambda: method === "storey_bh" ? storeyLambdaRaw : null,
    },
  };
}

export function benjaminiHochberg(pValues: number[], alpha = 0.1): FdrItem[] {
  return applyFdr(pValues, alpha, { method: "bh" }).items;
}
