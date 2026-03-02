export interface FdrItem {
  index: number;
  rank: number;
  pValue: number;
  qValue: number;
  threshold: number;
  passed: boolean;
}

export function benjaminiHochberg(pValues: number[], alpha = 0.1): FdrItem[] {
  if (!Array.isArray(pValues) || pValues.length === 0) {
    throw new Error("pValues must be a non-empty array.");
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error("alpha must be in (0, 1].");
  }

  const tuples = pValues.map((pValue, index) => {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new Error(`pValues[${index}] must be within [0, 1].`);
    }
    return { index, pValue };
  });

  const sorted = [...tuples].sort((a, b) => a.pValue - b.pValue);
  const m = sorted.length;
  const qAdjusted = new Array<number>(m).fill(1);

  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    qAdjusted[i] = Math.min(1, (sorted[i].pValue * m) / rank);
  }

  for (let i = m - 2; i >= 0; i--) {
    qAdjusted[i] = Math.min(qAdjusted[i], qAdjusted[i + 1]);
  }

  const byOriginal = new Array<FdrItem>(m);
  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    const threshold = (rank / m) * alpha;
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

  return byOriginal;
}
