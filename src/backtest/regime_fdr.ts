import { applyFdr } from "./fdr.js";

export interface RegimeFdrSegmentInput {
  segmentId: string;
  bars: number;
  weight: number;
  pValues: number[];
}

export type RegimeFdrAggregation = "max" | "weighted_mean";

export interface RegimeFdrDetail {
  segmentId: string;
  pValue: number;
  qValue: number;
  rank: number;
  threshold: number;
  weight: number;
  bars: number;
}

export interface RegimeFdrItem {
  index: number;
  rank: number;
  pValue: number;
  qValue: number;
  threshold: number;
  passed: boolean;
  regimeDetails: RegimeFdrDetail[];
}

export interface RegimeFdrDiagnostics {
  method: "regime_segmented_bh";
  aggregation: RegimeFdrAggregation;
  segmentCount: number;
  positiveWeightSegmentCount: number;
  candidateCount: number;
  fallbackUsed: boolean;
  fallbackReason?: string;
}

export interface RegimeFdrApplyResult {
  items: RegimeFdrItem[];
  diagnostics: RegimeFdrDiagnostics;
}

export function applyRegimeSegmentedFdr(
  segments: RegimeFdrSegmentInput[],
  alpha = 0.1,
  aggregation: RegimeFdrAggregation = "max",
): RegimeFdrApplyResult {
  const candidateCount = validateRegimeInputs(segments, alpha, aggregation);

  const segmentFdrResults = segments.map((segment) => ({
    segment,
    items: applyFdr(segment.pValues, alpha, { method: "bh" }).items,
  }));

  let fallbackUsed = false;
  let fallbackReason: string | undefined;
  let effectiveAggregation = aggregation;
  const positiveWeightSegmentCount = segments.reduce(
    (count, segment) => count + (segment.weight > 0 ? 1 : 0),
    0,
  );
  if (aggregation === "weighted_mean") {
    if (positiveWeightSegmentCount <= 0) {
      effectiveAggregation = "max";
      fallbackUsed = true;
      fallbackReason =
        "weighted_mean requires at least one positive segment weight; fell back to max.";
    }
  }

  const baseItems = new Array<{
    index: number;
    pValue: number;
    qValue: number;
    regimeDetails: RegimeFdrDetail[];
  }>(candidateCount);

  for (let index = 0; index < candidateCount; index++) {
    const regimeDetails: RegimeFdrDetail[] = segmentFdrResults.map(({ segment, items }) => {
      const detail = items[index];
      return {
        segmentId: segment.segmentId,
        pValue: detail.pValue,
        qValue: detail.qValue,
        rank: detail.rank,
        threshold: detail.threshold,
        weight: segment.weight,
        bars: segment.bars,
      };
    });

    baseItems[index] = {
      index,
      pValue: aggregateMetric(regimeDetails, "pValue", effectiveAggregation),
      qValue: aggregateMetric(regimeDetails, "qValue", effectiveAggregation),
      regimeDetails,
    };
  }

  const ranked = [...baseItems].sort((a, b) => {
    if (a.qValue !== b.qValue) {
      return a.qValue - b.qValue;
    }
    if (a.pValue !== b.pValue) {
      return a.pValue - b.pValue;
    }
    return a.index - b.index;
  });

  const itemsByOriginal = new Array<RegimeFdrItem>(candidateCount);
  for (let order = 0; order < ranked.length; order++) {
    const rank = order + 1;
    const row = ranked[order];
    itemsByOriginal[row.index] = {
      index: row.index,
      rank,
      pValue: row.pValue,
      qValue: row.qValue,
      threshold: (rank / candidateCount) * alpha,
      passed: row.qValue <= alpha,
      regimeDetails: row.regimeDetails,
    };
  }

  return {
    items: itemsByOriginal,
    diagnostics: {
      method: "regime_segmented_bh",
      aggregation,
      segmentCount: segments.length,
      positiveWeightSegmentCount,
      candidateCount,
      fallbackUsed,
      ...(fallbackReason ? { fallbackReason } : {}),
    },
  };
}

function aggregateMetric(
  details: RegimeFdrDetail[],
  key: "pValue" | "qValue",
  aggregation: RegimeFdrAggregation,
): number {
  if (aggregation === "max") {
    let maxValue = Number.NEGATIVE_INFINITY;
    for (const detail of details) {
      if (detail[key] > maxValue) {
        maxValue = detail[key];
      }
    }
    return maxValue;
  }

  let weightedSum = 0;
  let weightSum = 0;
  for (const detail of details) {
    if (detail.weight > 0) {
      weightedSum += detail[key] * detail.weight;
      weightSum += detail.weight;
    }
  }
  return weightSum > 0 ? weightedSum / weightSum : 1;
}

// Test-only exposure for low-level aggregation behavior regression tests.
export const __testOnly = {
  aggregateMetric,
};

function validateRegimeInputs(
  segments: RegimeFdrSegmentInput[],
  alpha: number,
  aggregation: RegimeFdrAggregation,
): number {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error("segments must be a non-empty array.");
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) {
    throw new Error("alpha must be in (0, 1].");
  }
  if (aggregation !== "max" && aggregation !== "weighted_mean") {
    throw new Error(`unsupported aggregation: ${String(aggregation)}`);
  }

  const firstPValues = segments[0].pValues;
  if (!Array.isArray(firstPValues) || firstPValues.length === 0) {
    throw new Error("segments[0].pValues must be a non-empty array.");
  }
  const candidateCount = firstPValues.length;

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    if (typeof segment.segmentId !== "string" || segment.segmentId.length === 0) {
      throw new Error(`segments[${segmentIndex}].segmentId must be a non-empty string.`);
    }
    if (!Number.isFinite(segment.bars) || segment.bars <= 0) {
      throw new Error(`segments[${segmentIndex}].bars must be > 0.`);
    }
    if (!Number.isFinite(segment.weight) || segment.weight < 0) {
      throw new Error(`segments[${segmentIndex}].weight must be >= 0.`);
    }
    if (!Array.isArray(segment.pValues) || segment.pValues.length !== candidateCount) {
      throw new Error(
        `segments[${segmentIndex}].pValues must match candidate count (${candidateCount}).`,
      );
    }
    for (let candidateIndex = 0; candidateIndex < segment.pValues.length; candidateIndex++) {
      const pValue = segment.pValues[candidateIndex];
      if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
        throw new Error(
          `segments[${segmentIndex}].pValues[${candidateIndex}] must be within [0, 1].`,
        );
      }
    }
  }

  return candidateCount;
}
