import type { ResearchDecisionV1 } from "../../runtime/research_execution_contracts.js";

const MAX_REASON_PREVIEW = 3;

export interface ResearchDecisionOperatorSummary {
  sourceId: string;
  symbol: string;
  action: ResearchDecisionV1["decision"]["action"];
  signal: ResearchDecisionV1["strategy"]["signal"];
  confidence: number;
  tradeAllowed: boolean;
  blockedBy: string[];
  headline: string;
  topReasons: string[];
  topThemes: string[];
}

export interface ResearchDecisionDisagreementArtifact {
  schemaVersion: "research_disagreement.v1";
  generatedAt: string;
  symbol: string;
  baseline: ResearchDecisionOperatorSummary;
  donor: ResearchDecisionOperatorSummary;
  summary: {
    relation:
      | "agree"
      | "action_mismatch"
      | "trade_allowed_mismatch"
      | "blocked_by_mismatch"
      | "confidence_gap";
    headline: string;
    confidenceDelta: number;
    actionDelta: {
      baseline: ResearchDecisionV1["decision"]["action"];
      donor: ResearchDecisionV1["decision"]["action"];
    };
    tradeAllowedDelta: {
      baseline: boolean;
      donor: boolean;
    };
    blockedByOnlyInBaseline: string[];
    blockedByOnlyInDonor: string[];
  };
}

export interface TradingAgentsFallbackSummaryInput {
  sourceId: string;
  symbol: string;
  requestId: string;
  sidecarRunId: string;
  inputHash: string;
  failureCode: string;
  fallbackReason: string;
  operatorVisible?: boolean;
  stderrDigest?: string;
  timedOut?: boolean;
  generatedAt?: string;
}

export interface TradingAgentsFallbackSummary {
  schemaVersion: "tradingagents_fallback_summary.v1";
  generatedAt: string;
  sourceId: string;
  symbol: string;
  requestId: string;
  sidecarRunId: string;
  inputHash: string;
  failureCode: string;
  fallbackReason: string;
  timedOut: boolean;
  operatorVisible: boolean;
  headline: string;
  stderrDigest?: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function producerToSourceId(decision: ResearchDecisionV1): string {
  return (
    decision.provenance.sourceId?.trim() ||
    decision.provenance.producer.trim()
  );
}

export function buildResearchDecisionOperatorSummary(
  decision: ResearchDecisionV1,
): ResearchDecisionOperatorSummary {
  return {
    sourceId: producerToSourceId(decision),
    symbol: decision.symbol,
    action: decision.decision.action,
    signal: decision.strategy.signal,
    confidence: decision.decision.confidence,
    tradeAllowed: decision.decision.tradeAllowed,
    blockedBy: [...decision.decision.blockedBy],
    headline: `${decision.decision.action} @ ${decision.decision.confidence.toFixed(2)} (${decision.decision.tradeAllowed ? "tradable" : "advisory"})`,
    topReasons: decision.decision.reasons.slice(0, MAX_REASON_PREVIEW),
    topThemes: decision.news.topThemes.slice(0, 3).map((item) => item.theme),
  };
}

function classifyDisagreement(params: {
  baseline: ResearchDecisionV1;
  donor: ResearchDecisionV1;
  blockedByOnlyInBaseline: string[];
  blockedByOnlyInDonor: string[];
  confidenceDelta: number;
}): ResearchDecisionDisagreementArtifact["summary"]["relation"] {
  if (params.baseline.decision.action !== params.donor.decision.action) {
    return "action_mismatch";
  }
  if (
    params.baseline.decision.tradeAllowed !== params.donor.decision.tradeAllowed
  ) {
    return "trade_allowed_mismatch";
  }
  if (
    params.blockedByOnlyInBaseline.length > 0 ||
    params.blockedByOnlyInDonor.length > 0
  ) {
    return "blocked_by_mismatch";
  }
  if (Math.abs(params.confidenceDelta) >= 0.2) {
    return "confidence_gap";
  }
  return "agree";
}

function buildDisagreementHeadline(
  relation: ResearchDecisionDisagreementArtifact["summary"]["relation"],
  baseline: ResearchDecisionOperatorSummary,
  donor: ResearchDecisionOperatorSummary,
): string {
  switch (relation) {
    case "action_mismatch":
      return `Baseline=${baseline.action}, donor=${donor.action}.`;
    case "trade_allowed_mismatch":
      return `Baseline tradable=${baseline.tradeAllowed}, donor tradable=${donor.tradeAllowed}.`;
    case "blocked_by_mismatch":
      return "Baseline and donor disagree on blockers.";
    case "confidence_gap":
      return `Confidence gap baseline=${baseline.confidence.toFixed(2)} donor=${donor.confidence.toFixed(2)}.`;
    default:
      return "Baseline and donor agree on the current research verdict.";
  }
}

export function createResearchDecisionDisagreementArtifact(input: {
  baseline: ResearchDecisionV1;
  donor: ResearchDecisionV1;
  generatedAt?: string;
}): ResearchDecisionDisagreementArtifact {
  if (input.baseline.symbol !== input.donor.symbol) {
    throw new Error(
      `Cannot compare decisions for different symbols: ${input.baseline.symbol} vs ${input.donor.symbol}.`,
    );
  }

  const baselineSummary = buildResearchDecisionOperatorSummary(input.baseline);
  const donorSummary = buildResearchDecisionOperatorSummary(input.donor);
  const blockedByOnlyInBaseline = uniqueSorted(
    baselineSummary.blockedBy.filter(
      (item) => !donorSummary.blockedBy.includes(item),
    ),
  );
  const blockedByOnlyInDonor = uniqueSorted(
    donorSummary.blockedBy.filter(
      (item) => !baselineSummary.blockedBy.includes(item),
    ),
  );
  const confidenceDelta = Number(
    (donorSummary.confidence - baselineSummary.confidence).toFixed(4),
  );
  const relation = classifyDisagreement({
    baseline: input.baseline,
    donor: input.donor,
    blockedByOnlyInBaseline,
    blockedByOnlyInDonor,
    confidenceDelta,
  });

  return {
    schemaVersion: "research_disagreement.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    symbol: input.baseline.symbol,
    baseline: baselineSummary,
    donor: donorSummary,
    summary: {
      relation,
      headline: buildDisagreementHeadline(
        relation,
        baselineSummary,
        donorSummary,
      ),
      confidenceDelta,
      actionDelta: {
        baseline: baselineSummary.action,
        donor: donorSummary.action,
      },
      tradeAllowedDelta: {
        baseline: baselineSummary.tradeAllowed,
        donor: donorSummary.tradeAllowed,
      },
      blockedByOnlyInBaseline,
      blockedByOnlyInDonor,
    },
  };
}

export function buildTradingAgentsFallbackSummary(
  input: TradingAgentsFallbackSummaryInput,
): TradingAgentsFallbackSummary {
  const timedOut = input.timedOut === true;
  return {
    schemaVersion: "tradingagents_fallback_summary.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceId: input.sourceId,
    symbol: input.symbol,
    requestId: input.requestId,
    sidecarRunId: input.sidecarRunId,
    inputHash: input.inputHash,
    failureCode: input.failureCode,
    fallbackReason: input.fallbackReason,
    timedOut,
    operatorVisible: input.operatorVisible !== false,
    headline: timedOut
      ? `Fallback triggered after ${input.failureCode}.`
      : `Fallback triggered: ${input.failureCode}.`,
    stderrDigest: input.stderrDigest,
  };
}
