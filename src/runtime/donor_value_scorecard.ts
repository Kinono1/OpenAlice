export interface DonorValueSample {
  baselineHit: boolean;
  donorHit: boolean;
  baselineExpectancyBps: number;
  donorExpectancyBps: number;
  regime?: string;
  explainable?: boolean;
  fallbackUsed?: boolean;
}

export interface DonorValueThresholds {
  minHitRateDelta: number;
  minExpectancyDeltaBps: number;
  maxFallbackRatio: number;
  minExplainability: number;
}

export interface DonorValueScorecard {
  schemaVersion: "donor_value_scorecard.v1";
  generatedAt: string;
  state: "killed" | "advisory_only" | "qualified_for_paper_influence";
  counts: {
    sampleCount: number;
    fallbackCount: number;
  };
  metrics: {
    baselineHitRate: number;
    donorHitRate: number;
    hitRateDelta: number;
    baselineExpectancyBps: number;
    donorExpectancyBps: number;
    expectancyDeltaBps: number;
    fallbackRatio: number;
    explainabilityCompleteness: number;
  };
  byRegime: Array<{
    regime: string;
    sampleCount: number;
    hitRateDelta: number;
    expectancyDeltaBps: number;
  }>;
  thresholds: DonorValueThresholds;
  reasons: string[];
}

const DEFAULT_THRESHOLDS: DonorValueThresholds = {
  minHitRateDelta: 0,
  minExpectancyDeltaBps: 0,
  maxFallbackRatio: 0.1,
  minExplainability: 0.85,
};

function round(value: number): number {
  return Number(value.toFixed(4));
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildDonorValueScorecard(input: {
  samples: DonorValueSample[];
  thresholds?: Partial<DonorValueThresholds>;
  generatedAt?: string;
}): DonorValueScorecard {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const sampleCount = input.samples.length;
  if (sampleCount === 0) {
    throw new Error("donor_value_scorecard requires at least one sample");
  }
  const fallbackCount = input.samples.filter((sample) => sample.fallbackUsed).length;
  const explainableCount = input.samples.filter((sample) => sample.explainable !== false).length;
  const baselineHitRate = mean(input.samples.map((sample) => (sample.baselineHit ? 1 : 0)));
  const donorHitRate = mean(input.samples.map((sample) => (sample.donorHit ? 1 : 0)));
  const baselineExpectancyBps = mean(
    input.samples.map((sample) => sample.baselineExpectancyBps),
  );
  const donorExpectancyBps = mean(
    input.samples.map((sample) => sample.donorExpectancyBps),
  );
  const hitRateDelta = donorHitRate - baselineHitRate;
  const expectancyDeltaBps = donorExpectancyBps - baselineExpectancyBps;
  const fallbackRatio = fallbackCount / sampleCount;
  const explainabilityCompleteness = explainableCount / sampleCount;

  const regimeMap = new Map<string, DonorValueSample[]>();
  for (const sample of input.samples) {
    const key = sample.regime ?? "unscoped";
    const bucket = regimeMap.get(key) ?? [];
    bucket.push(sample);
    regimeMap.set(key, bucket);
  }
  const byRegime = [...regimeMap.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([regime, samples]) => ({
      regime,
      sampleCount: samples.length,
      hitRateDelta: round(
        mean(samples.map((sample) => (sample.donorHit ? 1 : 0))) -
          mean(samples.map((sample) => (sample.baselineHit ? 1 : 0))),
      ),
      expectancyDeltaBps: round(
        mean(samples.map((sample) => sample.donorExpectancyBps)) -
          mean(samples.map((sample) => sample.baselineExpectancyBps)),
      ),
    }));

  const reasons: string[] = [];
  if (hitRateDelta < thresholds.minHitRateDelta) {
    reasons.push("donor_hit_rate_below_min");
  }
  if (expectancyDeltaBps < thresholds.minExpectancyDeltaBps) {
    reasons.push("donor_expectancy_below_min");
  }
  if (fallbackRatio > thresholds.maxFallbackRatio) {
    reasons.push("donor_fallback_ratio_too_high");
  }
  if (explainabilityCompleteness < thresholds.minExplainability) {
    reasons.push("donor_explainability_too_low");
  }

  let state: DonorValueScorecard["state"] = "qualified_for_paper_influence";
  if (reasons.includes("donor_fallback_ratio_too_high")) {
    state = "killed";
  } else if (reasons.length > 0) {
    state = "advisory_only";
  }

  return {
    schemaVersion: "donor_value_scorecard.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    state,
    counts: {
      sampleCount,
      fallbackCount,
    },
    metrics: {
      baselineHitRate: round(baselineHitRate),
      donorHitRate: round(donorHitRate),
      hitRateDelta: round(hitRateDelta),
      baselineExpectancyBps: round(baselineExpectancyBps),
      donorExpectancyBps: round(donorExpectancyBps),
      expectancyDeltaBps: round(expectancyDeltaBps),
      fallbackRatio: round(fallbackRatio),
      explainabilityCompleteness: round(explainabilityCompleteness),
    },
    byRegime,
    thresholds,
    reasons,
  };
}
