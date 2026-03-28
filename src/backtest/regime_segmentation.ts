export interface RegimeSegment {
  id: string;
  startIndex: number;
  endExclusive: number;
  bars: number;
  weight: number;
  meanReturn: number;
  volatility: number;
  score?: number;
}

export interface RegimeSegmentationConfig {
  method: "none" | "change_point";
  maxSegments: number;
  minSegmentBars: number;
}

export interface RegimeSegmentationDiagnostics {
  method: RegimeSegmentationConfig["method"];
  totalBars: number;
  maxSegments: number;
  minSegmentBars: number;
  attemptedSplits: number;
  acceptedSplits: number;
  suppressedShortSegments: number;
  minScoreThreshold: number;
  stopReason:
    | "method_none"
    | "insufficient_bars"
    | "max_segments_reached"
    | "no_split_candidate";
}

export interface RegimeSegmentationResult {
  segments: RegimeSegment[];
  diagnostics: RegimeSegmentationDiagnostics;
}

const DEFAULT_CONFIG: RegimeSegmentationConfig = {
  method: "none",
  maxSegments: 3,
  minSegmentBars: 24,
};

const MIN_SPLIT_SCORE = 2;
const NUMERICAL_EPSILON = 1e-12;

interface SegmentBounds {
  startIndex: number;
  endExclusive: number;
}

interface ReturnStats {
  count: number;
  mean: number;
  variance: number;
  volatility: number;
}

interface SplitSearchResult {
  splitIndex: number | null;
  score: number;
  evaluated: number;
}

type CandleLike = {
  close: number;
  time: unknown;
};

export function segmentRegimes<T extends CandleLike>(
  candles: T[],
  config: Partial<RegimeSegmentationConfig> = {},
): RegimeSegmentationResult {
  validateCandles(candles);

  const resolved = resolveConfig(config);
  const totalBars = candles.length;
  const closes = candles.map((bar) => bar.close);
  const logReturns = buildLogReturns(closes);
  const { prefixSums, prefixSquares } = buildReturnPrefixes(logReturns);

  let segments: SegmentBounds[] = [{ startIndex: 0, endExclusive: totalBars }];
  let attemptedSplits = 0;
  let acceptedSplits = 0;
  let stopReason: RegimeSegmentationDiagnostics["stopReason"] | null = null;

  if (resolved.method === "none") {
    stopReason = "method_none";
  } else if (totalBars < resolved.minSegmentBars * 2 || resolved.maxSegments <= 1) {
    stopReason = "insufficient_bars";
  } else {
    while (segments.length < resolved.maxSegments) {
      let bestSegmentIdx = -1;
      let bestSplitIdx = -1;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let i = 0; i < segments.length; i++) {
        const candidate = findBestSplit(
          segments[i],
          resolved.minSegmentBars,
          prefixSums,
          prefixSquares,
        );
        attemptedSplits += candidate.evaluated;
        if (
          candidate.splitIndex !== null &&
          candidate.score > bestScore &&
          Number.isFinite(candidate.score)
        ) {
          bestScore = candidate.score;
          bestSplitIdx = candidate.splitIndex;
          bestSegmentIdx = i;
        }
      }

      if (bestSegmentIdx < 0 || bestSplitIdx < 0 || bestScore < MIN_SPLIT_SCORE) {
        stopReason = "no_split_candidate";
        break;
      }

      const picked = segments[bestSegmentIdx];
      const left: SegmentBounds = {
        startIndex: picked.startIndex,
        endExclusive: bestSplitIdx,
      };
      const right: SegmentBounds = {
        startIndex: bestSplitIdx,
        endExclusive: picked.endExclusive,
      };
      segments.splice(bestSegmentIdx, 1, left, right);
      acceptedSplits += 1;
    }

    if (stopReason === null) {
      stopReason =
        segments.length >= resolved.maxSegments
          ? "max_segments_reached"
          : "no_split_candidate";
    }
  }

  const merged = mergeShortSegments(segments, resolved.minSegmentBars);
  segments = merged.segments;

  const outputSegments: RegimeSegment[] = segments.map((segment, idx) => {
    const bars = segment.endExclusive - segment.startIndex;
    const stats = statsForBars(
      segment.startIndex,
      segment.endExclusive,
      prefixSums,
      prefixSquares,
    );
    const segmentSplit = findBestSplit(
      segment,
      resolved.minSegmentBars,
      prefixSums,
      prefixSquares,
    );
    return {
      id: `regime_${idx + 1}`,
      startIndex: segment.startIndex,
      endExclusive: segment.endExclusive,
      bars,
      weight: bars / totalBars,
      meanReturn: stats.mean,
      volatility: stats.volatility,
      score:
        segmentSplit.splitIndex !== null && Number.isFinite(segmentSplit.score)
          ? segmentSplit.score
          : undefined,
    };
  });

  return {
    segments: outputSegments,
    diagnostics: {
      method: resolved.method,
      totalBars,
      maxSegments: resolved.maxSegments,
      minSegmentBars: resolved.minSegmentBars,
      attemptedSplits,
      acceptedSplits,
      suppressedShortSegments: merged.merges,
      minScoreThreshold: MIN_SPLIT_SCORE,
      stopReason: stopReason ?? "no_split_candidate",
    },
  };
}

function resolveConfig(
  config: Partial<RegimeSegmentationConfig>,
): RegimeSegmentationConfig {
  const method = config.method ?? DEFAULT_CONFIG.method;
  if (method !== "none" && method !== "change_point") {
    throw new Error(`Unsupported segmentation method: ${String(method)}`);
  }

  return {
    method,
    maxSegments: toInt(config.maxSegments ?? DEFAULT_CONFIG.maxSegments, "maxSegments", 1),
    minSegmentBars: toInt(
      config.minSegmentBars ?? DEFAULT_CONFIG.minSegmentBars,
      "minSegmentBars",
      1,
    ),
  };
}

function validateCandles(candles: CandleLike[]): void {
  if (!Array.isArray(candles) || candles.length < 1) {
    throw new Error("candles must contain at least one bar.");
  }
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (!Number.isFinite(bar.close) || bar.close <= 0) {
      throw new Error(`candles[${i}].close must be a finite positive number.`);
    }
    if (!("time" in bar)) {
      throw new Error(`candles[${i}] must include a time field.`);
    }
  }
}

function buildLogReturns(closes: number[]): number[] {
  if (closes.length < 2) {
    return [];
  }
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(Math.log(closes[i] / closes[i - 1]));
  }
  return out;
}

function buildReturnPrefixes(logReturns: number[]): {
  prefixSums: number[];
  prefixSquares: number[];
} {
  const prefixSums = new Array<number>(logReturns.length + 1).fill(0);
  const prefixSquares = new Array<number>(logReturns.length + 1).fill(0);

  for (let i = 0; i < logReturns.length; i++) {
    const value = logReturns[i];
    prefixSums[i + 1] = prefixSums[i] + value;
    prefixSquares[i + 1] = prefixSquares[i] + value * value;
  }

  return { prefixSums, prefixSquares };
}

function findBestSplit(
  segment: SegmentBounds,
  minSegmentBars: number,
  prefixSums: number[],
  prefixSquares: number[],
): SplitSearchResult {
  const bars = segment.endExclusive - segment.startIndex;
  if (bars < minSegmentBars * 2) {
    return { splitIndex: null, score: Number.NEGATIVE_INFINITY, evaluated: 0 };
  }

  let bestSplitIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let evaluated = 0;

  const minSplit = segment.startIndex + minSegmentBars;
  const maxSplit = segment.endExclusive - minSegmentBars;

  for (let split = minSplit; split <= maxSplit; split++) {
    const left = statsForBars(segment.startIndex, split, prefixSums, prefixSquares);
    const right = statsForBars(split, segment.endExclusive, prefixSums, prefixSquares);
    if (left.count < 2 || right.count < 2) {
      continue;
    }

    const score = meanShiftScore(left, right);
    evaluated += 1;
    if (score > bestScore && Number.isFinite(score)) {
      bestScore = score;
      bestSplitIndex = split;
    }
  }

  return {
    splitIndex: bestSplitIndex,
    score: bestScore,
    evaluated,
  };
}

function statsForBars(
  startIndex: number,
  endExclusive: number,
  prefixSums: number[],
  prefixSquares: number[],
): ReturnStats {
  const returnStart = startIndex;
  const returnEndExclusive = Math.max(returnStart, endExclusive - 1);
  return statsForRange(returnStart, returnEndExclusive, prefixSums, prefixSquares);
}

function statsForRange(
  fromInclusive: number,
  toExclusive: number,
  prefixSums: number[],
  prefixSquares: number[],
): ReturnStats {
  const count = Math.max(0, toExclusive - fromInclusive);
  if (count < 1) {
    return {
      count: 0,
      mean: 0,
      variance: 0,
      volatility: 0,
    };
  }

  const sum = prefixSums[toExclusive] - prefixSums[fromInclusive];
  const sumSquares = prefixSquares[toExclusive] - prefixSquares[fromInclusive];
  const mean = sum / count;
  const variance = Math.max(0, sumSquares / count - mean * mean);
  return {
    count,
    mean,
    variance,
    volatility: Math.sqrt(variance),
  };
}

function meanShiftScore(left: ReturnStats, right: ReturnStats): number {
  const meanGap = Math.abs(left.mean - right.mean);
  if (meanGap <= 0) {
    return 0;
  }

  const pooledVariance =
    (left.variance * Math.max(1, left.count - 1) +
      right.variance * Math.max(1, right.count - 1)) /
    Math.max(1, left.count + right.count - 2);
  const pooledVolatility = Math.sqrt(Math.max(pooledVariance, NUMERICAL_EPSILON));
  const balance = Math.sqrt((left.count * right.count) / (left.count + right.count));
  return (meanGap * balance) / pooledVolatility;
}

function mergeShortSegments(
  segments: SegmentBounds[],
  minSegmentBars: number,
): { segments: SegmentBounds[]; merges: number } {
  if (segments.length < 2 || minSegmentBars <= 1) {
    return { segments: segments.slice(), merges: 0 };
  }

  const merged = segments.map((segment) => ({ ...segment }));
  let merges = 0;

  while (merged.length > 1) {
    const shortIdx = merged.findIndex(
      (segment) => segment.endExclusive - segment.startIndex < minSegmentBars,
    );
    if (shortIdx < 0) {
      break;
    }

    merges += 1;

    if (shortIdx === 0) {
      merged[1] = {
        startIndex: merged[0].startIndex,
        endExclusive: merged[1].endExclusive,
      };
      merged.splice(0, 1);
      continue;
    }

    if (shortIdx === merged.length - 1) {
      merged[shortIdx - 1] = {
        startIndex: merged[shortIdx - 1].startIndex,
        endExclusive: merged[shortIdx].endExclusive,
      };
      merged.splice(shortIdx, 1);
      continue;
    }

    const leftBars = merged[shortIdx - 1].endExclusive - merged[shortIdx - 1].startIndex;
    const rightBars = merged[shortIdx + 1].endExclusive - merged[shortIdx + 1].startIndex;

    if (leftBars >= rightBars) {
      merged[shortIdx - 1] = {
        startIndex: merged[shortIdx - 1].startIndex,
        endExclusive: merged[shortIdx].endExclusive,
      };
      merged.splice(shortIdx, 1);
    } else {
      merged[shortIdx + 1] = {
        startIndex: merged[shortIdx].startIndex,
        endExclusive: merged[shortIdx + 1].endExclusive,
      };
      merged.splice(shortIdx, 1);
    }
  }

  return { segments: merged, merges };
}

function toInt(value: number, field: string, min: number): number {
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${field} must be an integer >= ${min}`);
  }
  return value;
}
