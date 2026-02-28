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
  components: {
    strategyScore: number;
    mlScore: number;
    newsScore: number;
    newsRiskPenalty: number;
    disagreementPenalty: number;
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

export function evaluateExpertDecision(input: ExpertDecisionInput): ExpertDecisionResult {
  const policy = normalizePolicy(input.policy);
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

  if (input.news.riskScore >= policy.riskOffNewsScore) {
    blockedBy.push("news_risk_breaker");
    reasons.push(
      `News risk score ${input.news.riskScore.toFixed(2)} >= threshold ${policy.riskOffNewsScore.toFixed(2)}.`,
    );
  }

  const strategyScore = computeStrategyScore(input.strategy);
  const ml = computeMlScore(input.ml, policy);
  const newsScore = clamp(input.news.sentimentScore, -1, 1) * 0.25;
  const newsRiskPenalty = input.news.riskScore * 0.45;

  const strategyDirection = input.strategy.signal;
  const disagreementPenalty =
    strategyDirection !== 0 && ml.direction !== 0 && strategyDirection !== ml.direction ? 0.2 : 0;

  const totalScore = Number(
    (strategyScore + ml.score + newsScore - newsRiskPenalty - disagreementPenalty).toFixed(4),
  );

  reasons.push(
    `Score breakdown: strategy=${strategyScore.toFixed(3)}, ml=${ml.score.toFixed(3)}, news=${newsScore.toFixed(3)}, riskPenalty=${newsRiskPenalty.toFixed(3)}, disagreementPenalty=${disagreementPenalty.toFixed(3)}.`,
  );
  reasons.push(...ml.notes);

  let action: ExpertAction = "flat";
  if (blockedBy.length === 0) {
    if (totalScore >= policy.minCompositeScore) {
      action = "long";
    } else if (totalScore <= -policy.minCompositeScore) {
      if (policy.allowShort) {
        action = "short";
      } else {
        action = "flat";
        reasons.push("Short signal suppressed because allowShort=false.");
      }
    }
  } else {
    reasons.push(`Execution blocked by: ${blockedBy.join(", ")}.`);
  }

  const confidence = Number(clamp(Math.abs(totalScore), 0, 1).toFixed(4));
  const tradeAllowed = blockedBy.length === 0 && action !== "flat";
  const suggestedExposurePct = computeSuggestedExposurePct(action, totalScore, policy.minCompositeScore);

  return {
    symbol: input.symbol,
    action,
    confidence,
    tradeAllowed,
    blockedBy,
    reasons,
    suggestedExposurePct,
    components: {
      strategyScore: Number(strategyScore.toFixed(4)),
      mlScore: Number(ml.score.toFixed(4)),
      newsScore: Number(newsScore.toFixed(4)),
      newsRiskPenalty: Number(newsRiskPenalty.toFixed(4)),
      disagreementPenalty: Number(disagreementPenalty.toFixed(4)),
      totalScore,
    },
    policy,
  };
}

