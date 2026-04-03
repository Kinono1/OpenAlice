import {
  isReleaseGateStatusBlocking,
  type PersistedReleaseGateStatus,
} from "./release_gate_status.js";
import type { NewsImpactSummary } from "./news_impact.js";

export type ExpertAction = "long" | "short" | "flat";

export interface ExpertStrategySignal {
  signal: -1 | 0 | 1;
  reason: string;
  ensembleScore?: number;
}

export interface ExpertMlSignal {
  available: boolean;
  direction: "buy" | "sell" | "hold";
  confidence?: number;
  expectedReturnPct?: number;
  actionable?: boolean;
  error?: string;
}

export interface ExpertDecisionPolicy {
  requireReleaseGatePass: boolean;
  requireMl: boolean;
  allowShort: boolean;
  minCompositeScore: number;
  minMlConfidence: number;
  minExpectedReturnPct: number;
  riskOffNewsScore: number;
}

export interface ExpertDecisionInput {
  symbol: string;
  strategy: ExpertStrategySignal;
  ml?: ExpertMlSignal;
  news: NewsImpactSummary;
  releaseGateStatus?: PersistedReleaseGateStatus | null;
  policy?: Partial<ExpertDecisionPolicy>;
}

export interface ExpertDecisionResult {
  symbol: string;
  action: ExpertAction;
  confidence: number;
  tradeAllowed: boolean;
  blockedBy: string[];
  reasons: string[];
  suggestedExposurePct: number;
  overlays: {
    newsHardVeto: boolean;
    newsRiskRegime: NonNullable<NewsImpactSummary["overlay"]>["riskRegime"];
    newsExposureMultiplier: number;
    btcVsEthTilt: number;
    favoredAsset: NonNullable<NewsImpactSummary["overlay"]>["assetPreference"]["favoredAsset"];
  };
  components: {
    strategyScore: number;
    mlScore: number;
    newsScore: number;
    newsRiskPenalty: number;
    disagreementPenalty: number;
    directionalSupportScore: number;
    baseSuggestedExposurePct: number;
    symbolTiltMultiplier: number;
    totalScore: number;
  };
  policy: ExpertDecisionPolicy;
}

const DEFAULT_POLICY: ExpertDecisionPolicy = {
  requireReleaseGatePass: true,
  requireMl: false,
  allowShort: true,
  minCompositeScore: 0.2,
  minMlConfidence: 0.55,
  minExpectedReturnPct: 0.03,
  riskOffNewsScore: 0.65,
};

const DEFAULT_NEWS_OVERLAY: NonNullable<NewsImpactSummary["overlay"]> = {
  riskRegime: "normal",
  hardVeto: false,
  exposureMultiplier: 1,
  assetPreference: {
    favoredAsset: null,
    btcVsEthTilt: 0,
    reasons: [],
  },
  reasons: [],
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizePolicy(policy: Partial<ExpertDecisionPolicy> | undefined): ExpertDecisionPolicy {
  return {
    requireReleaseGatePass: policy?.requireReleaseGatePass ?? DEFAULT_POLICY.requireReleaseGatePass,
    requireMl: policy?.requireMl ?? DEFAULT_POLICY.requireMl,
    allowShort: policy?.allowShort ?? DEFAULT_POLICY.allowShort,
    minCompositeScore: clamp(
      policy?.minCompositeScore ?? DEFAULT_POLICY.minCompositeScore,
      0.05,
      1,
    ),
    minMlConfidence: clamp(
      policy?.minMlConfidence ?? DEFAULT_POLICY.minMlConfidence,
      0.5,
      0.95,
    ),
    minExpectedReturnPct: clamp(
      policy?.minExpectedReturnPct ?? DEFAULT_POLICY.minExpectedReturnPct,
      0.001,
      10,
    ),
    riskOffNewsScore: clamp(
      policy?.riskOffNewsScore ?? DEFAULT_POLICY.riskOffNewsScore,
      0.1,
      1,
    ),
  };
}

function computeStrategyScore(signal: ExpertStrategySignal): number {
  const normalizedSignal = clamp(signal.signal, -1, 1);
  const ensembleScore = clamp(
    typeof signal.ensembleScore === "number" ? signal.ensembleScore : normalizedSignal,
    -1,
    1,
  );
  const score = normalizedSignal * 0.55 + ensembleScore * 0.15;
  return clamp(score, -0.7, 0.7);
}

function computeMlScore(
  ml: ExpertMlSignal | undefined,
  policy: ExpertDecisionPolicy,
): {
  score: number;
  direction: -1 | 0 | 1;
  notes: string[];
} {
  if (!ml) {
    return { score: 0, direction: 0, notes: ["ml_unavailable"] };
  }
  if (!ml.available) {
    return {
      score: 0,
      direction: 0,
      notes: [ml.error ? `ml_error:${ml.error}` : "ml_unavailable"],
    };
  }

  const direction = ml.direction === "buy" ? 1 : ml.direction === "sell" ? -1 : 0;
  if (direction === 0) {
    return { score: 0, direction, notes: ["ml_direction_hold"] };
  }

  const confidence = typeof ml.confidence === "number" ? ml.confidence : 0;
  const expected = typeof ml.expectedReturnPct === "number" ? Math.abs(ml.expectedReturnPct) : 0;
  const confidenceNorm = clamp(
    (confidence - policy.minMlConfidence) / (1 - policy.minMlConfidence),
    0,
    1,
  );
  const expectedNorm = clamp(expected / policy.minExpectedReturnPct, 0, 2) / 2;
  const strength = (0.7 * confidenceNorm + 0.3 * expectedNorm) * (ml.actionable === false ? 0.4 : 1);
  const score = direction * 0.55 * strength;

  const notes: string[] = [];
  if (confidence < policy.minMlConfidence) {
    notes.push("ml_confidence_below_threshold");
  }
  if (expected < policy.minExpectedReturnPct) {
    notes.push("ml_expected_return_below_threshold");
  }
  if (ml.actionable === false) {
    notes.push("ml_marked_non_actionable");
  }

  return { score, direction, notes };
}

function computeSuggestedExposurePct(action: ExpertAction, score: number, minScore: number): number {
  if (action === "flat") {
    return 0;
  }
  const normalized = clamp((Math.abs(score) - minScore) / Math.max(1e-6, 1 - minScore), 0.05, 1);
  return Number((normalized * 100).toFixed(2));
}

function resolveTrendAction(
  signal: ExpertStrategySignal["signal"],
  allowShort: boolean,
  reasons: string[],
): ExpertAction {
  if (signal > 0) {
    return "long";
  }
  if (signal < 0) {
    if (allowShort) {
      return "short";
    }
    reasons.push("Short trend suppressed because allowShort=false.");
  }
  return "flat";
}

function resolveCoreAsset(symbol: string): "BTC" | "ETH" | null {
  const upper = symbol.toUpperCase();
  if (upper.includes("BTC") || upper.includes("XBT")) {
    return "BTC";
  }
  if (upper.includes("ETH")) {
    return "ETH";
  }
  return null;
}

function resolveSymbolTiltMultiplier(
  symbol: string,
  btcVsEthTilt: number,
): {
  asset: "BTC" | "ETH" | null;
  multiplier: number;
} {
  const asset = resolveCoreAsset(symbol);
  if (asset === "BTC") {
    return {
      asset,
      multiplier: Number(clamp(1 + btcVsEthTilt, 0.85, 1.15).toFixed(4)),
    };
  }
  if (asset === "ETH") {
    return {
      asset,
      multiplier: Number(clamp(1 - btcVsEthTilt, 0.85, 1.15).toFixed(4)),
    };
  }
  return { asset: null, multiplier: 1 };
}

export function evaluateExpertDecision(input: ExpertDecisionInput): ExpertDecisionResult {
  const policy = normalizePolicy(input.policy);
  const newsOverlay = input.news.overlay ?? DEFAULT_NEWS_OVERLAY;
  const reasons = [input.strategy.reason];
  const blockedBy: string[] = [];

  if (policy.requireReleaseGatePass) {
    const gate = isReleaseGateStatusBlocking(input.releaseGateStatus ?? null);
    if (gate.blocking) {
      blockedBy.push(gate.reason ?? "release_gate_blocked");
    }
  }

  if (policy.requireMl && (!input.ml || !input.ml.available)) {
    blockedBy.push("ml_required_but_unavailable");
  }

  const newsHardVeto = newsOverlay.hardVeto || input.news.riskScore >= policy.riskOffNewsScore;
  if (newsHardVeto) {
    blockedBy.push("news_risk_breaker");
    reasons.push(
      newsOverlay.hardVeto
        ? `News overlay raised a hard veto from severe risk events (${newsOverlay.reasons.join(", ") || "severe_risk_flag"}).`
        : `News risk score ${input.news.riskScore.toFixed(2)} >= threshold ${policy.riskOffNewsScore.toFixed(2)}.`,
    );
  } else if (newsOverlay.riskRegime === "elevated") {
    reasons.push(
      `News overlay scales exposure by ${newsOverlay.exposureMultiplier.toFixed(2)} due to elevated risk.`,
    );
  }

  const strategyScore = computeStrategyScore(input.strategy);
  const ml = computeMlScore(input.ml, policy);
  const newsScore = 0;
  const newsRiskPenalty = Number((1 - newsOverlay.exposureMultiplier).toFixed(4));

  const strategyDirection = input.strategy.signal;
  const disagreementPenalty =
    strategyDirection !== 0 && ml.direction !== 0 && strategyDirection !== ml.direction ? 0.2 : 0;

  const totalScore = Number((strategyScore + ml.score - disagreementPenalty).toFixed(4));
  const directionalSupportScore = Number(
    clamp(strategyDirection === 0 ? 0 : strategyDirection * totalScore, 0, 1).toFixed(4),
  );

  reasons.push(
    `Score breakdown: strategy=${strategyScore.toFixed(3)}, ml=${ml.score.toFixed(3)}, disagreementPenalty=${disagreementPenalty.toFixed(3)}, directionalSupport=${directionalSupportScore.toFixed(3)}.`,
  );
  reasons.push(...ml.notes);

  const trendAction = resolveTrendAction(strategyDirection, policy.allowShort, reasons);
  const coreAsset = resolveCoreAsset(input.symbol);
  let action: ExpertAction = "flat";
  if (blockedBy.length === 0) {
    if (trendAction !== "flat" && directionalSupportScore >= policy.minCompositeScore) {
      action = trendAction;
    } else if (trendAction === "flat") {
      reasons.push("Trend signal is flat, so news/ML overlays cannot create a new position.");
    } else {
      reasons.push("Trend direction lacked sufficient composite support after ML confirmation.");
    }

    if (
      newsOverlay.assetPreference.favoredAsset &&
      coreAsset === newsOverlay.assetPreference.favoredAsset
    ) {
      reasons.push(
        `News overlay mildly favors ${newsOverlay.assetPreference.favoredAsset} over the peer asset.`,
      );
    } else if (newsOverlay.assetPreference.favoredAsset && coreAsset) {
      reasons.push(
        `News overlay mildly disfavors ${input.symbol} versus ${newsOverlay.assetPreference.favoredAsset}.`,
      );
    }
  } else {
    reasons.push(`Execution blocked by: ${blockedBy.join(", ")}.`);
  }

  const baseSuggestedExposurePct = computeSuggestedExposurePct(
    action,
    directionalSupportScore,
    policy.minCompositeScore,
  );
  const symbolTilt = resolveSymbolTiltMultiplier(
    input.symbol,
    newsOverlay.assetPreference.btcVsEthTilt,
  );
  const suggestedExposurePct =
    action === "flat"
      ? 0
      : Number(
          clamp(
            baseSuggestedExposurePct *
              newsOverlay.exposureMultiplier *
              symbolTilt.multiplier,
            0,
            100,
          ).toFixed(2),
        );
  const confidence = Number(
    clamp(directionalSupportScore * newsOverlay.exposureMultiplier, 0, 1).toFixed(4),
  );
  const tradeAllowed = blockedBy.length === 0 && action !== "flat" && suggestedExposurePct > 0;

  return {
    symbol: input.symbol,
    action,
    confidence,
    tradeAllowed,
    blockedBy,
    reasons,
    suggestedExposurePct,
    overlays: {
      newsHardVeto,
      newsRiskRegime: newsOverlay.riskRegime,
      newsExposureMultiplier: newsOverlay.exposureMultiplier,
      btcVsEthTilt: newsOverlay.assetPreference.btcVsEthTilt,
      favoredAsset: newsOverlay.assetPreference.favoredAsset,
    },
    components: {
      strategyScore: Number(strategyScore.toFixed(4)),
      mlScore: Number(ml.score.toFixed(4)),
      newsScore: Number(newsScore.toFixed(4)),
      newsRiskPenalty,
      disagreementPenalty: Number(disagreementPenalty.toFixed(4)),
      directionalSupportScore,
      baseSuggestedExposurePct: Number(baseSuggestedExposurePct.toFixed(2)),
      symbolTiltMultiplier: symbolTilt.multiplier,
      totalScore,
    },
    policy,
  };
}
