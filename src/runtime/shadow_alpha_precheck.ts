import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import type { ResearchDecisionV1 } from "./research_execution_contracts.js";

export interface ShadowAlphaFailureSummary {
  totalAttempts?: number;
  fallbackCount?: number;
  invalidCount?: number;
}

export interface ShadowAlphaPrecheckConfig {
  windowDays: number;
  lookaheadBars: number;
  neutralReturnBps: number;
  overlapHitRateMin: number;
  donorDeltaMin: number;
  fallbackInvalidKillRatioMax: number;
  fallbackInvalidPromotionRatioMax: number;
  coverageKillMin: number;
  coveragePromotionMin: number;
  explainabilityKillMin: number;
  explainabilityPromotionMin: number;
}

export interface ShadowAlphaSample {
  symbol: string;
  decisionKey: string;
  decisionWindowEnd: string;
  direction: -1 | 0 | 1;
  outcomeLabel: -1 | 0 | 1;
  returnBps: number;
  hit: boolean;
}

export interface ShadowAlphaPerSymbolSummary {
  symbol: string;
  baselineEvaluableCount: number;
  donorEvaluableCount: number;
  overlapCount: number;
  baselineHitRate: number | null;
  donorHitRate: number | null;
  hitRateDelta: number | null;
}

export interface ShadowAlphaPrecheckArtifact {
  schemaVersion: "shadow_alpha_precheck.v1";
  generatedAt: string;
  config: ShadowAlphaPrecheckConfig;
  counts: {
    baselineDecisionCount: number;
    donorDecisionCount: number;
    baselineEvaluableCount: number;
    donorEvaluableCount: number;
    overlapCount: number;
    donorFallbackCount: number;
    donorInvalidCount: number;
    donorAttemptCount: number;
  };
  metrics: {
    donorCoverageRatio: number;
    overlapCoverageRatio: number;
    baselineOverlapHitRate: number | null;
    donorOverlapHitRate: number | null;
    directionalHitRateDelta: number | null;
    fallbackRatio: number;
    invalidRatio: number;
    fallbackInvalidRatio: number;
    explainabilityCompleteness: number;
  };
  killCriterion: {
    shouldKill: boolean;
    reasons: string[];
  };
  promotionCheck: {
    eligible: boolean;
    reasons: string[];
  };
  perSymbol: ShadowAlphaPerSymbolSummary[];
  samples: {
    baselineOverlap: ShadowAlphaSample[];
    donorOverlap: ShadowAlphaSample[];
  };
}

export interface ShadowAlphaPrecheckInput {
  baselineDecisions: ResearchDecisionV1[];
  donorDecisions: ResearchDecisionV1[];
  priceBarsBySymbol: Record<string, MarketData[]>;
  donorFailures?: ShadowAlphaFailureSummary;
  config?: Partial<ShadowAlphaPrecheckConfig>;
  generatedAt?: string;
}

const DEFAULT_CONFIG: ShadowAlphaPrecheckConfig = {
  windowDays: 30,
  lookaheadBars: 4,
  neutralReturnBps: 20,
  overlapHitRateMin: 0.55,
  donorDeltaMin: 0,
  fallbackInvalidKillRatioMax: 0.1,
  fallbackInvalidPromotionRatioMax: 0.05,
  coverageKillMin: 0.25,
  coveragePromotionMin: 0.4,
  explainabilityKillMin: 0.85,
  explainabilityPromotionMin: 0.95,
};

interface LabeledDecision {
  decision: ResearchDecisionV1;
  decisionKey: string;
  direction: -1 | 0 | 1;
  label: -1 | 0 | 1;
  returnBps: number;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function toMsFromIso(value: string): number {
  return Date.parse(value);
}

function decisionKey(decision: ResearchDecisionV1): string {
  return `${decision.symbol}::${decision.marketContext.windowEnd}`;
}

function decisionDirection(decision: ResearchDecisionV1): -1 | 0 | 1 {
  return decision.strategy.signal;
}

function hasExplainableDecision(decision: ResearchDecisionV1): boolean {
  return (
    decision.strategy.reason.trim().length > 0 &&
    decision.decision.reasons.length > 0 &&
    decision.provenance.producer.trim().length > 0
  );
}

function normalizeBars(bars: MarketData[]): MarketData[] {
  return [...bars].sort((a, b) => a.time - b.time);
}

function findAnchorIndex(bars: MarketData[], windowEndMs: number): number {
  for (let idx = 0; idx < bars.length; idx += 1) {
    if (bars[idx].time * 1000 >= windowEndMs) {
      return idx;
    }
  }
  return -1;
}

function deriveOutcome(
  decision: ResearchDecisionV1,
  barsBySymbol: Record<string, MarketData[]>,
  config: ShadowAlphaPrecheckConfig,
): { label: -1 | 0 | 1; returnBps: number } | null {
  const bars = barsBySymbol[decision.symbol];
  if (!bars || bars.length === 0) {
    return null;
  }

  const anchor = findAnchorIndex(bars, toMsFromIso(decision.marketContext.windowEnd));
  if (anchor < 0) {
    return null;
  }

  const targetIdx = anchor + config.lookaheadBars;
  if (targetIdx >= bars.length) {
    return null;
  }

  const startPrice = bars[anchor].close;
  const endPrice = bars[targetIdx].close;
  if (!Number.isFinite(startPrice) || !Number.isFinite(endPrice) || startPrice <= 0) {
    return null;
  }

  const returnBps = ((endPrice - startPrice) / startPrice) * 10_000;
  if (Math.abs(returnBps) <= config.neutralReturnBps) {
    return { label: 0, returnBps: roundMetric(returnBps) };
  }

  return {
    label: returnBps > 0 ? 1 : -1,
    returnBps: roundMetric(returnBps),
  };
}

function hitRate(samples: ShadowAlphaSample[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  const hits = samples.filter((sample) => sample.hit).length;
  return roundMetric(hits / samples.length);
}

function buildLabeledDecisions(
  decisions: ResearchDecisionV1[],
  priceBarsBySymbol: Record<string, MarketData[]>,
  config: ShadowAlphaPrecheckConfig,
): LabeledDecision[] {
  const out: LabeledDecision[] = [];
  for (const decision of decisions) {
    const outcome = deriveOutcome(decision, priceBarsBySymbol, config);
    if (!outcome) {
      continue;
    }
    out.push({
      decision,
      decisionKey: decisionKey(decision),
      direction: decisionDirection(decision),
      label: outcome.label,
      returnBps: outcome.returnBps,
    });
  }
  return out;
}

function toSample(item: LabeledDecision): ShadowAlphaSample {
  return {
    symbol: item.decision.symbol,
    decisionKey: item.decisionKey,
    decisionWindowEnd: item.decision.marketContext.windowEnd,
    direction: item.direction,
    outcomeLabel: item.label,
    returnBps: item.returnBps,
    hit: item.direction === item.label,
  };
}

function summarizePerSymbol(
  baselineOverlap: ShadowAlphaSample[],
  donorOverlap: ShadowAlphaSample[],
): ShadowAlphaPerSymbolSummary[] {
  const symbols = new Set<string>();
  for (const sample of baselineOverlap) symbols.add(sample.symbol);
  for (const sample of donorOverlap) symbols.add(sample.symbol);

  return [...symbols]
    .sort((a, b) => a.localeCompare(b))
    .map((symbol) => {
      const baseline = baselineOverlap.filter((item) => item.symbol === symbol);
      const donor = donorOverlap.filter((item) => item.symbol === symbol);
      const overlapCount = Math.min(baseline.length, donor.length);
      const baselineRate = hitRate(baseline);
      const donorRate = hitRate(donor);
      return {
        symbol,
        baselineEvaluableCount: baseline.length,
        donorEvaluableCount: donor.length,
        overlapCount,
        baselineHitRate: baselineRate,
        donorHitRate: donorRate,
        hitRateDelta:
          baselineRate == null || donorRate == null
            ? null
            : roundMetric(donorRate - baselineRate),
      };
    });
}

export function runShadowAlphaPrecheck(
  input: ShadowAlphaPrecheckInput,
): ShadowAlphaPrecheckArtifact {
  const config: ShadowAlphaPrecheckConfig = {
    ...DEFAULT_CONFIG,
    ...input.config,
  };
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const normalizedBarsBySymbol = Object.fromEntries(
    Object.entries(input.priceBarsBySymbol).map(([symbol, bars]) => [
      symbol,
      normalizeBars(bars),
    ]),
  );

  const baselineLabeled = buildLabeledDecisions(
    input.baselineDecisions,
    normalizedBarsBySymbol,
    config,
  );
  const donorLabeled = buildLabeledDecisions(
    input.donorDecisions,
    normalizedBarsBySymbol,
    config,
  );

  const baselineByKey = new Map(
    baselineLabeled.map((decision) => [decision.decisionKey, decision] as const),
  );
  const donorByKey = new Map(
    donorLabeled.map((decision) => [decision.decisionKey, decision] as const),
  );

  const overlapKeys = [...baselineByKey.keys()].filter((key) => donorByKey.has(key));
  const baselineOverlap = overlapKeys.map((key) => toSample(baselineByKey.get(key)!));
  const donorOverlap = overlapKeys.map((key) => toSample(donorByKey.get(key)!));

  const donorAttemptCount =
    input.donorFailures?.totalAttempts ??
    input.donorDecisions.length +
      (input.donorFailures?.fallbackCount ?? 0) +
      (input.donorFailures?.invalidCount ?? 0);
  const donorFallbackCount = input.donorFailures?.fallbackCount ?? 0;
  const donorInvalidCount = input.donorFailures?.invalidCount ?? 0;

  const baselineEvaluableCount = baselineLabeled.length;
  const donorEvaluableCount = donorLabeled.length;
  const overlapCount = overlapKeys.length;
  const donorCoverageRatio =
    baselineEvaluableCount === 0
      ? 0
      : roundMetric(donorEvaluableCount / baselineEvaluableCount);
  const overlapCoverageRatio =
    baselineEvaluableCount === 0
      ? 0
      : roundMetric(overlapCount / baselineEvaluableCount);
  const baselineOverlapHitRate = hitRate(baselineOverlap);
  const donorOverlapHitRate = hitRate(donorOverlap);
  const directionalHitRateDelta =
    baselineOverlapHitRate == null || donorOverlapHitRate == null
      ? null
      : roundMetric(donorOverlapHitRate - baselineOverlapHitRate);
  const fallbackRatio =
    donorAttemptCount === 0
      ? 0
      : roundMetric(donorFallbackCount / donorAttemptCount);
  const invalidRatio =
    donorAttemptCount === 0
      ? 0
      : roundMetric(donorInvalidCount / donorAttemptCount);
  const fallbackInvalidRatio = roundMetric(fallbackRatio + invalidRatio);
  const explainableCount = input.donorDecisions.filter(hasExplainableDecision).length;
  const explainabilityCompleteness =
    input.donorDecisions.length === 0
      ? 0
      : roundMetric(explainableCount / input.donorDecisions.length);

  const killReasons: string[] = [];
  if (
    donorOverlapHitRate != null &&
    donorOverlapHitRate < config.overlapHitRateMin
  ) {
    killReasons.push("kill_overlap_hit_rate_below_min");
  }
  if (
    directionalHitRateDelta != null &&
    directionalHitRateDelta <= config.donorDeltaMin
  ) {
    killReasons.push("kill_donor_delta_not_positive");
  }
  if (fallbackInvalidRatio > config.fallbackInvalidKillRatioMax) {
    killReasons.push("kill_fallback_invalid_ratio_too_high");
  }
  if (donorCoverageRatio < config.coverageKillMin) {
    killReasons.push("kill_coverage_too_low");
  }
  if (explainabilityCompleteness < config.explainabilityKillMin) {
    killReasons.push("kill_explainability_too_low");
  }

  const promotionReasons: string[] = [];
  if (
    donorOverlapHitRate == null ||
    donorOverlapHitRate < config.overlapHitRateMin
  ) {
    promotionReasons.push("promotion_overlap_hit_rate_below_min");
  }
  if (
    directionalHitRateDelta == null ||
    directionalHitRateDelta <= config.donorDeltaMin
  ) {
    promotionReasons.push("promotion_donor_delta_not_positive");
  }
  if (fallbackInvalidRatio > config.fallbackInvalidPromotionRatioMax) {
    promotionReasons.push("promotion_fallback_invalid_ratio_too_high");
  }
  if (donorCoverageRatio < config.coveragePromotionMin) {
    promotionReasons.push("promotion_coverage_too_low");
  }
  if (explainabilityCompleteness < config.explainabilityPromotionMin) {
    promotionReasons.push("promotion_explainability_too_low");
  }

  return {
    schemaVersion: "shadow_alpha_precheck.v1",
    generatedAt,
    config,
    counts: {
      baselineDecisionCount: input.baselineDecisions.length,
      donorDecisionCount: input.donorDecisions.length,
      baselineEvaluableCount,
      donorEvaluableCount,
      overlapCount,
      donorFallbackCount,
      donorInvalidCount,
      donorAttemptCount,
    },
    metrics: {
      donorCoverageRatio,
      overlapCoverageRatio,
      baselineOverlapHitRate,
      donorOverlapHitRate,
      directionalHitRateDelta,
      fallbackRatio,
      invalidRatio,
      fallbackInvalidRatio,
      explainabilityCompleteness,
    },
    killCriterion: {
      shouldKill: killReasons.length > 0,
      reasons: killReasons,
    },
    promotionCheck: {
      eligible: promotionReasons.length === 0,
      reasons: promotionReasons,
    },
    perSymbol: summarizePerSymbol(baselineOverlap, donorOverlap),
    samples: {
      baselineOverlap,
      donorOverlap,
    },
  };
}
