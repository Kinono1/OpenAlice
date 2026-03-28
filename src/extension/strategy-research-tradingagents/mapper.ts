import { z } from "zod";
import type { PersistedReleaseGateStatus } from "../../runtime/release_gate_status.js";
import { isReleaseGateStatusBlocking } from "../../runtime/release_gate_status.js";
import type { ResearchDecisionV1 } from "../../runtime/research_execution_contracts.js";
import type {
  TradingAgentsResearchRequest,
  TradingAgentsSerializableNewsItem,
} from "./types.js";
import { getTradingAgentsResearchPayload } from "./types.js";

const SidecarReportSchema = z
  .object({
    schemaVersion: z.literal("tradingagents_sidecar_report.v1"),
    generatedAt: z.string().min(1),
    symbol: z.string().min(1),
    tradeDate: z.string().min(1),
    provenance: z
      .object({
        producer: z.string().min(1),
        entrypoint: z.string().min(1).optional(),
        mode: z.string().min(1),
      })
      .passthrough(),
    config: z
      .object({
        selectedAnalysts: z.array(z.string()).optional(),
      })
      .passthrough(),
    reports: z
      .object({
        market: z.string().optional(),
        sentiment: z.string().optional(),
        news: z.string().optional(),
        fundamentals: z.string().optional(),
      })
      .passthrough(),
    research: z
      .object({
        investmentDebate: z.unknown().optional(),
        investmentPlan: z.string().optional(),
        traderPlan: z.string().optional(),
        riskDebate: z.unknown().optional(),
        portfolioManagerDecision: z.string().optional(),
        normalizedRecommendation: z
          .object({
            rating: z.string().nullable().optional(),
            parser: z.string().optional(),
            matchedText: z.string().optional(),
            matched_text: z.string().optional(),
            supportsAutomation: z.boolean().optional(),
            supports_automation: z.boolean().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type TradingAgentsSidecarReportV1 = z.infer<typeof SidecarReportSchema>;

const POSITIVE_TERMS = [
  "approval",
  "breakout",
  "bull",
  "buy",
  "constructive",
  "demand",
  "etf",
  "flow",
  "gain",
  "growth",
  "inflow",
  "partnership",
  "positive",
  "rally",
  "surge",
  "upgrade",
];

const NEGATIVE_TERMS = [
  "ban",
  "bear",
  "crackdown",
  "down",
  "downgrade",
  "exploit",
  "hack",
  "investigation",
  "lawsuit",
  "liquidation",
  "loss",
  "negative",
  "outflow",
  "risk",
  "selloff",
  "shock",
];

const HIGH_RISK_TERMS = [
  "bankruptcy",
  "breach",
  "delist",
  "exploit",
  "fraud",
  "hack",
  "halt",
  "investigation",
  "liquidation",
  "sanction",
  "suspend",
];

function countMatches(text: string, terms: readonly string[]): number {
  const normalized = text.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (normalized.includes(term)) {
      count += 1;
    }
  }
  return count;
}

function classifyNews(items: TradingAgentsSerializableNewsItem[]) {
  let positiveNews = 0;
  let negativeNews = 0;
  let neutralNews = 0;
  let highRiskNews = 0;
  let sentimentAccumulator = 0;
  const themeCounts = new Map<string, number>();
  const flags: Array<{ time: string; title: string; reason: string }> = [];

  for (const item of items) {
    const body = `${item.title}\n${item.content}`;
    const positive = countMatches(body, POSITIVE_TERMS);
    const negative = countMatches(body, NEGATIVE_TERMS);
    const highRisk = countMatches(body, HIGH_RISK_TERMS);

    if (positive > negative) {
      positiveNews += 1;
      sentimentAccumulator += 1;
    } else if (negative > positive) {
      negativeNews += 1;
      sentimentAccumulator -= 1;
    } else {
      neutralNews += 1;
    }

    if (highRisk > 0) {
      highRiskNews += 1;
      flags.push({
        time: item.time,
        title: item.title,
        reason: "headline_high_risk_keyword",
      });
    }

    const theme =
      item.metadata?.category ??
      item.metadata?.source ??
      item.metadata?.ingestSource ??
      "unclassified";
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
  }

  const totalNews = items.length;
  const denominator = Math.max(1, totalNews);
  const sentimentScore = Number(
    Math.max(-1, Math.min(1, sentimentAccumulator / denominator)).toFixed(4),
  );
  const riskScore = Number(
    Math.max(0, Math.min(1, highRiskNews / denominator)).toFixed(4),
  );
  const topThemes = [...themeCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([theme, count]) => ({ theme, count }));

  return {
    totalNews,
    positiveNews,
    negativeNews,
    neutralNews,
    highRiskNews,
    sentimentScore,
    riskScore,
    topThemes,
    flags,
    latestHeadlines: items.slice(-5).map((item) => ({
      time: item.time,
      title: item.title,
    })),
  };
}

function mapSidecarRatingToSignal(
  rating: string | null | undefined,
): { signal: -1 | 0 | 1; action: "long" | "flat"; blockedBy: string[]; reasons: string[] } {
  const normalized = rating?.trim().toUpperCase() ?? null;
  if (normalized === "BUY") {
    return {
      signal: 1,
      action: "long",
      blockedBy: [],
      reasons: ["TradingAgents sidecar produced BUY."],
    };
  }
  if (normalized === "HOLD") {
    return {
      signal: 0,
      action: "flat",
      blockedBy: [],
      reasons: ["TradingAgents sidecar produced HOLD; no execution intent created."],
    };
  }
  if (normalized === "SELL") {
    return {
      signal: -1,
      action: "flat",
      blockedBy: ["tradingagents_sell_requires_manual_translation"],
      reasons: [
        "TradingAgents sidecar produced SELL, but OpenAlice does not infer short execution from this source.",
      ],
    };
  }
  if (normalized === "OVERWEIGHT") {
    return {
      signal: 1,
      action: "flat",
      blockedBy: ["tradingagents_rating_not_directly_executable:OVERWEIGHT"],
      reasons: [
        "TradingAgents sidecar produced OVERWEIGHT, which is treated as advisory-only in OpenAlice v1.",
      ],
    };
  }
  if (normalized === "UNDERWEIGHT") {
    return {
      signal: -1,
      action: "flat",
      blockedBy: ["tradingagents_rating_not_directly_executable:UNDERWEIGHT"],
      reasons: [
        "TradingAgents sidecar produced UNDERWEIGHT, which is treated as advisory-only in OpenAlice v1.",
      ],
    };
  }
  return {
    signal: 0,
    action: "flat",
    blockedBy: ["tradingagents_rating_missing"],
    reasons: [
      "TradingAgents sidecar did not emit a supported normalized recommendation.",
    ],
  };
}

function buildStrategyReason(report: TradingAgentsSidecarReportV1): string {
  return (
    report.research.portfolioManagerDecision?.trim() ||
    report.research.investmentPlan?.trim() ||
    report.reports.market?.trim() ||
    "TradingAgents sidecar returned an advisory research view."
  );
}

function summarizeReleaseGate(
  status: PersistedReleaseGateStatus | null,
): ResearchDecisionV1["releaseGate"] {
  if (!status) {
    return null;
  }
  return {
    generatedAt: status.generatedAt,
    allowPaperTrading: status.allowPaperTrading,
    allowLiveTrading: status.allowLiveTrading,
    failedChecks: [...status.failedChecks],
    warningChecks: [...status.warningChecks],
    expiresAt: status.expiresAt,
  };
}

export function parseTradingAgentsSidecarReport(
  payload: unknown,
): TradingAgentsSidecarReportV1 {
  return SidecarReportSchema.parse(payload);
}

export function toTradingAgentsTicker(symbol: string): string {
  return symbol.trim().toUpperCase().replace("/", "-");
}

export function mapTradingAgentsSidecarReportToResearchDecision(input: {
  report: TradingAgentsSidecarReportV1;
  request: TradingAgentsResearchRequest;
  releaseGateStatus: PersistedReleaseGateStatus | null;
  now?: Date;
}): ResearchDecisionV1 {
  const { report, request, releaseGateStatus } = input;
  const payload = getTradingAgentsResearchPayload(request);
  const gateMode =
    payload.decisionContext.releaseGateMode === "auto"
      ? "paper"
      : payload.decisionContext.releaseGateMode;
  const rating = report.research.normalizedRecommendation.rating;
  const mapped = mapSidecarRatingToSignal(rating);
  const gateBlock =
    payload.decisionContext.requireReleaseGatePass === true
      ? isReleaseGateStatusBlocking(
          releaseGateStatus,
          input.now ?? new Date(),
          gateMode,
        )
      : { blocking: false as const };

  const news = classifyNews(payload.newsContext.items);
  const blockedBy = [...mapped.blockedBy];
  const reasons = [...mapped.reasons];

  if (gateBlock.blocking) {
    blockedBy.push(gateBlock.reason ?? "release_gate_blocked");
    reasons.push(
      `Release gate blocked ${gateMode} research execution: ${gateBlock.reason ?? "unknown"}.`,
    );
  }

  reasons.push(
    "TradingAgents sidecar currently performs its own upstream market/news fetches; OpenAlice request context is persisted for audit but not enforced inside the sidecar runtime.",
  );

  const tradeAllowed =
    blockedBy.length === 0 && mapped.action !== "flat";

  return {
    schemaVersion: "research_decision.v1",
    generatedAt: report.generatedAt,
    symbol: payload.symbol,
    decisionContext: {
      releaseGateMode: payload.decisionContext.releaseGateMode,
    },
    marketContext: {
      lookbackBars: payload.marketContext.lookbackBars,
      windowStart: payload.marketContext.windowStart,
      windowEnd: payload.marketContext.windowEnd,
    },
    provenance: {
      producer: "tradingagents.sidecar",
      mode: "sidecar",
      sourceId:
        "requestMeta" in request ? request.requestMeta.sourceId : "tradingagents.sidecar",
      requestId:
        "requestMeta" in request ? request.requestMeta.requestId : undefined,
      sidecarRunId:
        "requestMeta" in request ? request.requestMeta.sidecarRunId : undefined,
      inputHash:
        "requestMeta" in request ? request.requestMeta.inputHash : undefined,
      sourceRequestSchemaVersion:
        "requestMeta" in request ? request.requestMeta.schemaVersion : request.schemaVersion,
    },
    strategy: {
      signal: mapped.signal,
      reason: buildStrategyReason(report),
      selectedStrategy: "tradingagents_sidecar",
      selectorMode: "external_sidecar",
      selectorReason: report.research.normalizedRecommendation.parser,
      indicators:
        typeof rating === "string"
          ? { sidecarRatingPresent: 1 }
          : { sidecarRatingPresent: 0 },
    },
    ml: {
      available: false,
      direction: "hold",
      actionable: false,
      error: "tradingagents_sidecar_does_not_emit_structured_ml_signal",
    },
    news,
    releaseGate: summarizeReleaseGate(releaseGateStatus),
    decision: {
      action: tradeAllowed ? mapped.action : "flat",
      confidence:
        mapped.signal === 0 ? 0.5 : blockedBy.length === 0 ? 0.6 : 0.55,
      tradeAllowed,
      blockedBy,
      reasons,
      suggestedExposurePct: tradeAllowed ? 25 : 0,
    },
  };
}
