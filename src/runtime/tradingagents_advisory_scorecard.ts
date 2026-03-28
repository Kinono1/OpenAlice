import { readFile } from "node:fs/promises";
import { segmentRegimes } from "../backtest/regime_segmentation.js";
import type { MarketData } from "../extension/analysis-kit/data/interfaces.js";
import type { ResearchDecisionDisagreementArtifact } from "../extension/strategy-research-tradingagents/disagreement.js";
import {
  runShadowAlphaPrecheck,
  type ShadowAlphaFailureSummary,
  type ShadowAlphaPrecheckArtifact,
  type ShadowAlphaSample,
} from "./shadow_alpha_precheck.js";
import type { DonorValueScorecard } from "./donor_value_scorecard.js";
import type { PersistedPaperExecutorJournal } from "./paper_executor_journal.js";
import type { RuntimeFaithfulSimulationArtifact } from "./runtime_faithful_simulation.js";
import type { ResearchDecisionV1 } from "./research_execution_contracts.js";

export const TRADING_AGENTS_SCORECARD_SCHEMA_VERSION =
  "tradingagents_advisory_scorecard.v1";
export const TRADING_AGENTS_VERDICT_SCHEMA_VERSION =
  "tradingagents_verdict.v1";
export const TRADING_AGENTS_VERDICT_SOURCE_ID = "tradingagents.sidecar";

export type TradingAgentsVerdictState =
  | "insufficient_evidence"
  | "killed"
  | "qualified_for_paper_influence";

export interface TradingAgentsWilsonInterval {
  low: number;
  high: number;
  confidenceLevel: number;
  sampleSize: number;
}

export interface TradingAgentsAdvisoryThresholds {
  shadowActionableOverlapMin: number;
  effectivePaperDaysMin: number;
  donorAttemptCountMin: number;
  overlapHitRateMin: number;
  donorDeltaMin: number;
  fallbackInvalidKillRatioMax: number;
  fallbackInvalidPromotionRatioMax: number;
  coverageKillMin: number;
  coveragePromotionMin: number;
  explainabilityKillMin: number;
  explainabilityPromotionMin: number;
  expectancyDeltaMinBps: number;
  maxDrawdownWorsePctMax: number;
  exposureVolatilityWorsePctMax: number;
  regimeSegmentation: {
    method: "change_point";
    maxSegments: number;
    minSegmentBars: number;
  };
}

export interface TradingAgentsRegimeBucketSummary {
  symbol: string;
  regimeId: string;
  overlapCount: number;
  weight: number;
  bars: number;
  baselineHitRate: number | null;
  donorHitRate: number | null;
  directionalHitRateDelta: number | null;
  baselineExpectancyBps: number | null;
  donorExpectancyBps: number | null;
}

export interface TradingAgentsAdvisoryScorecardArtifact {
  schemaVersion: typeof TRADING_AGENTS_SCORECARD_SCHEMA_VERSION;
  generatedAt: string;
  sourceId: typeof TRADING_AGENTS_VERDICT_SOURCE_ID;
  thresholds: TradingAgentsAdvisoryThresholds;
  counts: {
    effectivePaperDays: number;
    baselineDecisionCount: number;
    donorDecisionCount: number;
    donorAttemptCount: number;
    donorFallbackCount: number;
    donorInvalidCount: number;
    overlapCount: number;
    disagreementCount: number;
    journalEntryCount: number;
    simulationCommitCount: number;
    simulationOperationCount: number;
  };
  metrics: {
    donorCoverageRatio: number;
    overlapCoverageRatio: number;
    baselineOverlapHitRate: number | null;
    donorOverlapHitRate: number | null;
    baselineOverlapHitRateCI95: TradingAgentsWilsonInterval | null;
    donorOverlapHitRateCI95: TradingAgentsWilsonInterval | null;
    directionalHitRateDelta: number | null;
    baselineExpectancyBps: number | null;
    donorExpectancyBps: number | null;
    expectancyDeltaBps: number | null;
    baselineMaxDrawdownBps: number | null;
    donorMaxDrawdownBps: number | null;
    baselineExposureVolatility: number | null;
    donorExposureVolatility: number | null;
    fallbackRatio: number;
    invalidRatio: number;
    fallbackInvalidRatio: number;
    explainabilityCompleteness: number;
  };
  disagreementSummary: {
    total: number;
    byRelation: Record<
      ResearchDecisionDisagreementArtifact["summary"]["relation"],
      number
    >;
  };
  executionObservation: {
    journalEntryCount: number;
    simulationCommitCount: number;
    simulationOperationCount: number;
  };
  regimeBuckets: TradingAgentsRegimeBucketSummary[];
  shadowPrecheck: ShadowAlphaPrecheckArtifact;
}

export interface TradingAgentsVerdictArtifact {
  schemaVersion: typeof TRADING_AGENTS_VERDICT_SCHEMA_VERSION;
  generatedAt: string;
  sourceId: typeof TRADING_AGENTS_VERDICT_SOURCE_ID;
  state: TradingAgentsVerdictState;
  automaticRunsBlocked: boolean;
  paperInfluenceAllowed: boolean;
  reasons: string[];
  evidence: {
    effectivePaperDays: number;
    donorAttemptCount: number;
    overlapCount: number;
    donorOverlapHitRate: number | null;
    directionalHitRateDelta: number | null;
    fallbackInvalidRatio: number;
  };
}

export interface TradingAgentsAdvisoryScorecardInput {
  baselineDecisions: ResearchDecisionV1[];
  donorDecisions: ResearchDecisionV1[];
  priceBarsBySymbol: Record<string, MarketData[]>;
  donorFailures?: ShadowAlphaFailureSummary;
  disagreements?: ResearchDecisionDisagreementArtifact[];
  paperExecutorJournal?: PersistedPaperExecutorJournal | null;
  runtimeSimulation?: RuntimeFaithfulSimulationArtifact | null;
  generatedAt?: string;
  thresholds?: Partial<TradingAgentsAdvisoryThresholds>;
  shadowConfig?: Parameters<typeof runShadowAlphaPrecheck>[0]["config"];
}

const DEFAULT_THRESHOLDS: TradingAgentsAdvisoryThresholds = {
  shadowActionableOverlapMin: 20,
  effectivePaperDaysMin: 30,
  donorAttemptCountMin: 100,
  overlapHitRateMin: 0.55,
  donorDeltaMin: 0,
  fallbackInvalidKillRatioMax: 0.1,
  fallbackInvalidPromotionRatioMax: 0.05,
  coverageKillMin: 0.25,
  coveragePromotionMin: 0.4,
  explainabilityKillMin: 0.85,
  explainabilityPromotionMin: 0.95,
  expectancyDeltaMinBps: 0,
  maxDrawdownWorsePctMax: 0.1,
  exposureVolatilityWorsePctMax: 0.15,
  regimeSegmentation: {
    method: "change_point",
    maxSegments: 3,
    minSegmentBars: 24,
  },
};

type SamplePair = {
  baseline: ShadowAlphaSample;
  donor: ShadowAlphaSample;
};

export function buildTradingAgentsAdvisoryScorecard(
  input: TradingAgentsAdvisoryScorecardInput,
): TradingAgentsAdvisoryScorecardArtifact {
  const thresholds: TradingAgentsAdvisoryThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...input.thresholds,
    regimeSegmentation: {
      ...DEFAULT_THRESHOLDS.regimeSegmentation,
      ...input.thresholds?.regimeSegmentation,
    },
  };
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const shadowPrecheck = runShadowAlphaPrecheck({
    baselineDecisions: input.baselineDecisions,
    donorDecisions: input.donorDecisions,
    priceBarsBySymbol: input.priceBarsBySymbol,
    donorFailures: input.donorFailures,
    generatedAt,
    config: input.shadowConfig,
  });
  const samplePairs = buildSamplePairs(
    shadowPrecheck.samples.baselineOverlap,
    shadowPrecheck.samples.donorOverlap,
  );
  const effectivePaperDays = countUniqueUtcDays(
    input.donorDecisions.map((decision) => decision.marketContext.windowEnd),
  );
  const baselineSignedReturns = samplePairs.map((pair) =>
    signedReturnBps(pair.baseline),
  );
  const donorSignedReturns = samplePairs.map((pair) => signedReturnBps(pair.donor));
  const baselineExpectancyBps = meanOrNull(baselineSignedReturns);
  const donorExpectancyBps = meanOrNull(donorSignedReturns);
  const expectancyDeltaBps =
    baselineExpectancyBps == null || donorExpectancyBps == null
      ? null
      : roundMetric(donorExpectancyBps - baselineExpectancyBps);
  const baselineMaxDrawdownBps = maxDrawdownOrNull(baselineSignedReturns);
  const donorMaxDrawdownBps = maxDrawdownOrNull(donorSignedReturns);
  const baselineExposureVolatility = stdevOrNull(
    samplePairs.map((pair) => pair.baseline.direction),
  );
  const donorExposureVolatility = stdevOrNull(
    samplePairs.map((pair) => pair.donor.direction),
  );
  const disagreementSummary = summarizeDisagreements(input.disagreements ?? []);
  const regimeBuckets = summarizeRegimeBuckets({
    pairs: samplePairs,
    priceBarsBySymbol: input.priceBarsBySymbol,
    thresholds,
  });
  const baselineHits = samplePairs.filter((pair) => pair.baseline.hit).length;
  const donorHits = samplePairs.filter((pair) => pair.donor.hit).length;

  return {
    schemaVersion: TRADING_AGENTS_SCORECARD_SCHEMA_VERSION,
    generatedAt,
    sourceId: TRADING_AGENTS_VERDICT_SOURCE_ID,
    thresholds,
    counts: {
      effectivePaperDays,
      baselineDecisionCount: input.baselineDecisions.length,
      donorDecisionCount: input.donorDecisions.length,
      donorAttemptCount: shadowPrecheck.counts.donorAttemptCount,
      donorFallbackCount: shadowPrecheck.counts.donorFallbackCount,
      donorInvalidCount: shadowPrecheck.counts.donorInvalidCount,
      overlapCount: shadowPrecheck.counts.overlapCount,
      disagreementCount: disagreementSummary.total,
      journalEntryCount: input.paperExecutorJournal?.entries.length ?? 0,
      simulationCommitCount: input.runtimeSimulation?.commits.length ?? 0,
      simulationOperationCount: input.runtimeSimulation?.summary.operationCount ?? 0,
    },
    metrics: {
      donorCoverageRatio: shadowPrecheck.metrics.donorCoverageRatio,
      overlapCoverageRatio: shadowPrecheck.metrics.overlapCoverageRatio,
      baselineOverlapHitRate: shadowPrecheck.metrics.baselineOverlapHitRate,
      donorOverlapHitRate: shadowPrecheck.metrics.donorOverlapHitRate,
      baselineOverlapHitRateCI95: wilsonInterval95(
        baselineHits,
        samplePairs.length,
      ),
      donorOverlapHitRateCI95: wilsonInterval95(donorHits, samplePairs.length),
      directionalHitRateDelta: shadowPrecheck.metrics.directionalHitRateDelta,
      baselineExpectancyBps,
      donorExpectancyBps,
      expectancyDeltaBps,
      baselineMaxDrawdownBps,
      donorMaxDrawdownBps,
      baselineExposureVolatility,
      donorExposureVolatility,
      fallbackRatio: shadowPrecheck.metrics.fallbackRatio,
      invalidRatio: shadowPrecheck.metrics.invalidRatio,
      fallbackInvalidRatio: shadowPrecheck.metrics.fallbackInvalidRatio,
      explainabilityCompleteness: shadowPrecheck.metrics.explainabilityCompleteness,
    },
    disagreementSummary,
    executionObservation: {
      journalEntryCount: input.paperExecutorJournal?.entries.length ?? 0,
      simulationCommitCount: input.runtimeSimulation?.commits.length ?? 0,
      simulationOperationCount: input.runtimeSimulation?.summary.operationCount ?? 0,
    },
    regimeBuckets,
    shadowPrecheck,
  };
}

export function buildTradingAgentsVerdict(
  scorecard: TradingAgentsAdvisoryScorecardArtifact,
  donorValueScorecard?: DonorValueScorecard | null,
): TradingAgentsVerdictArtifact {
  if (donorValueScorecard?.state === "killed") {
    return finalizeVerdict(scorecard, "killed", [
      "donor_value_killed",
      ...donorValueScorecard.reasons,
    ]);
  }

  const reasons: string[] = [];
  const shadowActionable =
    scorecard.counts.overlapCount >= scorecard.thresholds.shadowActionableOverlapMin;
  const mainlineActionable =
    scorecard.counts.effectivePaperDays >=
      scorecard.thresholds.effectivePaperDaysMin &&
    scorecard.counts.donorAttemptCount >=
      scorecard.thresholds.donorAttemptCountMin;

  if (shadowActionable && scorecard.shadowPrecheck.killCriterion.shouldKill) {
    reasons.push(
      ...scorecard.shadowPrecheck.killCriterion.reasons.map(
        (reason) => `shadow_${reason}`,
      ),
    );
    return finalizeVerdict(scorecard, "killed", reasons);
  }

  if (!mainlineActionable) {
    if (
      scorecard.counts.effectivePaperDays < scorecard.thresholds.effectivePaperDaysMin
    ) {
      reasons.push("mainline_effective_paper_days_below_min");
    }
    if (
      scorecard.counts.donorAttemptCount < scorecard.thresholds.donorAttemptCountMin
    ) {
      reasons.push("mainline_donor_attempt_count_below_min");
    }
    return finalizeVerdict(scorecard, "insufficient_evidence", reasons);
  }

  const killReasons = evaluateMainlineKillReasons(scorecard);
  if (killReasons.length > 0) {
    return finalizeVerdict(scorecard, "killed", killReasons);
  }

  const promotionReasons = evaluatePromotionReasons(scorecard);
  if (promotionReasons.length === 0) {
    if (donorValueScorecard?.state === "advisory_only") {
      return finalizeVerdict(scorecard, "insufficient_evidence", [
        "donor_value_advisory_only",
        ...donorValueScorecard.reasons,
      ]);
    }
    return finalizeVerdict(scorecard, "qualified_for_paper_influence", []);
  }

  return finalizeVerdict(scorecard, "insufficient_evidence", promotionReasons);
}

export async function loadTradingAgentsVerdict(
  filePath: string,
): Promise<TradingAgentsVerdictArtifact | null> {
  try {
    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<TradingAgentsVerdictArtifact>;
    if (
      parsed.schemaVersion !== TRADING_AGENTS_VERDICT_SCHEMA_VERSION ||
      parsed.sourceId !== TRADING_AGENTS_VERDICT_SOURCE_ID ||
      typeof parsed.generatedAt !== "string" ||
      (parsed.state !== "insufficient_evidence" &&
        parsed.state !== "killed" &&
        parsed.state !== "qualified_for_paper_influence") ||
      typeof parsed.automaticRunsBlocked !== "boolean" ||
      typeof parsed.paperInfluenceAllowed !== "boolean" ||
      !Array.isArray(parsed.reasons) ||
      !parsed.evidence ||
      typeof parsed.evidence !== "object"
    ) {
      return null;
    }
    return parsed as TradingAgentsVerdictArtifact;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function evaluateMainlineKillReasons(
  scorecard: TradingAgentsAdvisoryScorecardArtifact,
): string[] {
  const reasons: string[] = [];
  if (
    scorecard.metrics.donorOverlapHitRate != null &&
    scorecard.metrics.donorOverlapHitRate <
      scorecard.thresholds.overlapHitRateMin
  ) {
    reasons.push("kill_overlap_hit_rate_below_min");
  }
  if (
    scorecard.metrics.directionalHitRateDelta != null &&
    scorecard.metrics.directionalHitRateDelta <=
      scorecard.thresholds.donorDeltaMin
  ) {
    reasons.push("kill_donor_delta_not_positive");
  }
  if (
    scorecard.metrics.fallbackInvalidRatio >
    scorecard.thresholds.fallbackInvalidKillRatioMax
  ) {
    reasons.push("kill_fallback_invalid_ratio_too_high");
  }
  if (
    scorecard.metrics.donorCoverageRatio < scorecard.thresholds.coverageKillMin
  ) {
    reasons.push("kill_coverage_too_low");
  }
  if (
    scorecard.metrics.explainabilityCompleteness <
    scorecard.thresholds.explainabilityKillMin
  ) {
    reasons.push("kill_explainability_too_low");
  }
  return reasons;
}

function evaluatePromotionReasons(
  scorecard: TradingAgentsAdvisoryScorecardArtifact,
): string[] {
  const reasons: string[] = [];
  if (
    scorecard.metrics.donorOverlapHitRate == null ||
    scorecard.metrics.donorOverlapHitRate <
      scorecard.thresholds.overlapHitRateMin
  ) {
    reasons.push("promotion_overlap_hit_rate_below_min");
  }
  if (
    scorecard.metrics.directionalHitRateDelta == null ||
    scorecard.metrics.directionalHitRateDelta <=
      scorecard.thresholds.donorDeltaMin
  ) {
    reasons.push("promotion_donor_delta_not_positive");
  }
  if (
    scorecard.metrics.fallbackInvalidRatio >
    scorecard.thresholds.fallbackInvalidPromotionRatioMax
  ) {
    reasons.push("promotion_fallback_invalid_ratio_too_high");
  }
  if (
    scorecard.metrics.donorCoverageRatio <
    scorecard.thresholds.coveragePromotionMin
  ) {
    reasons.push("promotion_coverage_too_low");
  }
  if (
    scorecard.metrics.explainabilityCompleteness <
    scorecard.thresholds.explainabilityPromotionMin
  ) {
    reasons.push("promotion_explainability_too_low");
  }
  if (
    scorecard.metrics.expectancyDeltaBps == null ||
    scorecard.metrics.expectancyDeltaBps <
      scorecard.thresholds.expectancyDeltaMinBps
  ) {
    reasons.push("promotion_expectancy_delta_below_min");
  }
  if (
    exceedsRelativeWorsening(
      scorecard.metrics.baselineMaxDrawdownBps,
      scorecard.metrics.donorMaxDrawdownBps,
      scorecard.thresholds.maxDrawdownWorsePctMax,
    )
  ) {
    reasons.push("promotion_max_drawdown_worse_than_allowed");
  }
  if (
    exceedsRelativeWorsening(
      scorecard.metrics.baselineExposureVolatility,
      scorecard.metrics.donorExposureVolatility,
      scorecard.thresholds.exposureVolatilityWorsePctMax,
    )
  ) {
    reasons.push("promotion_exposure_volatility_worse_than_allowed");
  }
  return reasons;
}

function finalizeVerdict(
  scorecard: TradingAgentsAdvisoryScorecardArtifact,
  state: TradingAgentsVerdictState,
  reasons: string[],
): TradingAgentsVerdictArtifact {
  return {
    schemaVersion: TRADING_AGENTS_VERDICT_SCHEMA_VERSION,
    generatedAt: scorecard.generatedAt,
    sourceId: scorecard.sourceId,
    state,
    automaticRunsBlocked: state === "killed",
    paperInfluenceAllowed: state === "qualified_for_paper_influence",
    reasons: [...new Set(reasons)],
    evidence: {
      effectivePaperDays: scorecard.counts.effectivePaperDays,
      donorAttemptCount: scorecard.counts.donorAttemptCount,
      overlapCount: scorecard.counts.overlapCount,
      donorOverlapHitRate: scorecard.metrics.donorOverlapHitRate,
      directionalHitRateDelta: scorecard.metrics.directionalHitRateDelta,
      fallbackInvalidRatio: scorecard.metrics.fallbackInvalidRatio,
    },
  };
}

function summarizeDisagreements(
  disagreements: ResearchDecisionDisagreementArtifact[],
): TradingAgentsAdvisoryScorecardArtifact["disagreementSummary"] {
  const byRelation = {
    agree: 0,
    action_mismatch: 0,
    trade_allowed_mismatch: 0,
    blocked_by_mismatch: 0,
    confidence_gap: 0,
  } satisfies Record<
    ResearchDecisionDisagreementArtifact["summary"]["relation"],
    number
  >;
  for (const disagreement of disagreements) {
    byRelation[disagreement.summary.relation] += 1;
  }
  return {
    total: disagreements.length,
    byRelation,
  };
}

function buildSamplePairs(
  baseline: ShadowAlphaSample[],
  donor: ShadowAlphaSample[],
): SamplePair[] {
  const donorByKey = new Map(donor.map((sample) => [sample.decisionKey, sample]));
  return baseline
    .map((baselineSample) => {
      const donorSample = donorByKey.get(baselineSample.decisionKey);
      if (!donorSample) {
        return null;
      }
      return {
        baseline: baselineSample,
        donor: donorSample,
      };
    })
    .filter((value): value is SamplePair => value !== null)
    .sort((a, b) =>
      a.baseline.decisionWindowEnd.localeCompare(b.baseline.decisionWindowEnd),
    );
}

function summarizeRegimeBuckets(input: {
  pairs: SamplePair[];
  priceBarsBySymbol: Record<string, MarketData[]>;
  thresholds: TradingAgentsAdvisoryThresholds;
}): TradingAgentsRegimeBucketSummary[] {
  const output: TradingAgentsRegimeBucketSummary[] = [];
  const symbols = [...new Set(input.pairs.map((pair) => pair.donor.symbol))].sort(
    (a, b) => a.localeCompare(b),
  );

  for (const symbol of symbols) {
    const bars = input.priceBarsBySymbol[symbol];
    if (!bars || bars.length === 0) {
      continue;
    }
    const regimeResult = segmentRegimes(bars, input.thresholds.regimeSegmentation);
    const symbolPairs = input.pairs.filter((pair) => pair.donor.symbol === symbol);
    const bucketMap = new Map<string, { baseline: ShadowAlphaSample[]; donor: ShadowAlphaSample[]; weight: number; bars: number }>();

    for (const pair of symbolPairs) {
      const segment = resolveRegimeSegmentForSample(
        bars,
        pair.donor.decisionWindowEnd,
        regimeResult.segments,
      );
      const segmentId = segment?.id ?? "regime_unmapped";
      const existing =
        bucketMap.get(segmentId) ??
        {
          baseline: [],
          donor: [],
          weight: segment?.weight ?? 0,
          bars: segment?.bars ?? 0,
        };
      existing.baseline.push(pair.baseline);
      existing.donor.push(pair.donor);
      bucketMap.set(segmentId, existing);
    }

    for (const [regimeId, bucket] of bucketMap) {
      const baselineScores = bucket.baseline.map(signedReturnBps);
      const donorScores = bucket.donor.map(signedReturnBps);
      const baselineHitRate = hitRate(bucket.baseline);
      const donorHitRate = hitRate(bucket.donor);
      output.push({
        symbol,
        regimeId,
        overlapCount: bucket.donor.length,
        weight: roundMetric(bucket.weight),
        bars: bucket.bars,
        baselineHitRate,
        donorHitRate,
        directionalHitRateDelta:
          baselineHitRate == null || donorHitRate == null
            ? null
            : roundMetric(donorHitRate - baselineHitRate),
        baselineExpectancyBps: meanOrNull(baselineScores),
        donorExpectancyBps: meanOrNull(donorScores),
      });
    }
  }

  return output.sort((a, b) =>
    `${a.symbol}:${a.regimeId}`.localeCompare(`${b.symbol}:${b.regimeId}`),
  );
}

function resolveRegimeSegmentForSample(
  bars: MarketData[],
  windowEnd: string,
  segments: Array<{ id: string; startIndex: number; endExclusive: number; weight: number; bars: number }>,
) {
  const targetMs = Date.parse(windowEnd);
  if (!Number.isFinite(targetMs)) {
    return null;
  }
  const barIndex = bars.findIndex((bar) => bar.time * 1000 >= targetMs);
  if (barIndex < 0) {
    return null;
  }
  return (
    segments.find(
      (segment) =>
        barIndex >= segment.startIndex && barIndex < segment.endExclusive,
    ) ?? null
  );
}

function countUniqueUtcDays(values: string[]): number {
  return new Set(
    values
      .map((value) => {
        const ts = Date.parse(value);
        if (!Number.isFinite(ts)) {
          return null;
        }
        return new Date(ts).toISOString().slice(0, 10);
      })
      .filter((value): value is string => value !== null),
  ).size;
}

function signedReturnBps(sample: ShadowAlphaSample): number {
  return roundMetric(sample.direction * sample.returnBps);
}

function meanOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return roundMetric(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function maxDrawdownOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of values) {
    cumulative += value;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return roundMetric(maxDrawdown);
}

function stdevOrNull(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return roundMetric(Math.sqrt(variance));
}

function hitRate(samples: ShadowAlphaSample[]): number | null {
  if (samples.length === 0) {
    return null;
  }
  return roundMetric(
    samples.filter((sample) => sample.hit).length / samples.length,
  );
}

function wilsonInterval95(
  hits: number,
  total: number,
): TradingAgentsWilsonInterval | null {
  if (total <= 0) {
    return null;
  }
  const z = 1.96;
  const p = hits / total;
  const denom = 1 + (z * z) / total;
  const center =
    (p + (z * z) / (2 * total)) / denom;
  const margin =
    (z / denom) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    low: roundMetric(Math.max(0, center - margin)),
    high: roundMetric(Math.min(1, center + margin)),
    confidenceLevel: 0.95,
    sampleSize: total,
  };
}

function exceedsRelativeWorsening(
  baseline: number | null,
  donor: number | null,
  maxRelativeIncrease: number,
): boolean {
  if (baseline == null || donor == null) {
    return true;
  }
  if (baseline === 0) {
    return donor > 0;
  }
  return donor > baseline * (1 + maxRelativeIncrease);
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}
