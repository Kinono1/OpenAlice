import type { MarketData, NewsItem } from "../analysis-kit/data/interfaces.js";
import type {
  ResearchDecisionV1,
} from "../../runtime/research_execution_contracts.js";
import type { ReleaseGateMode } from "../../runtime/release_gate_status.js";
import { canonicalJsonStringify, sha256Hex } from "./canonical-json.js";

export const TRADING_AGENTS_REQUEST_SCHEMA_VERSION =
  "tradingagents_sidecar_request.v1";
export const TRADING_AGENTS_SOURCE_ID = "tradingagents.sidecar";
export const TRADING_AGENTS_REQUEST_MAX_AGE_MS = 5 * 60 * 1000;

export type TradingAgentsAnalyst =
  | "market"
  | "social"
  | "news"
  | "fundamentals";

export interface TradingAgentsSerializableNewsItem {
  time: string;
  title: string;
  content: string;
  metadata?: Record<string, string | null | undefined>;
}

export interface TradingAgentsMarketContext {
  lookbackBars: number;
  windowStart: string;
  windowEnd: string;
  candles: MarketData[];
}

export interface TradingAgentsNewsContext {
  lookback: string;
  items: TradingAgentsSerializableNewsItem[];
}

export interface TradingAgentsDecisionContext {
  releaseGateMode: ReleaseGateMode | "auto";
  requireReleaseGatePass: boolean;
  selectedAnalysts: TradingAgentsAnalyst[];
  researchDepth: number;
}

export interface TradingAgentsDerivedContext {
  featureSummary?: string;
  promptReadySummary?: string;
  aggregatedIndicators?: Record<string, number>;
}

export interface TradingAgentsSupplementalContext {
  fundamentals?: string;
  macroSummary?: string;
  globalNewsSummary?: string;
  toolDiagnostics?: Record<string, string | number | boolean | null>;
  providerMetadata?: Record<string, string | number | boolean | null>;
}

export interface TradingAgentsResearchPayload {
  symbol: string;
  marketContext: TradingAgentsMarketContext;
  newsContext: TradingAgentsNewsContext;
  decisionContext: TradingAgentsDecisionContext;
  derivedContext?: TradingAgentsDerivedContext;
  supplementalContext?: TradingAgentsSupplementalContext;
}

export interface TradingAgentsResearchRequestMeta {
  schemaVersion: typeof TRADING_AGENTS_REQUEST_SCHEMA_VERSION;
  sourceId: typeof TRADING_AGENTS_SOURCE_ID;
  requestId: string;
  sidecarRunId: string;
  generatedAt: string;
  inputHash: string;
}

export interface TradingAgentsStrictResearchRequest {
  schemaVersion: typeof TRADING_AGENTS_REQUEST_SCHEMA_VERSION;
  requestMeta: TradingAgentsResearchRequestMeta;
  payload: TradingAgentsResearchPayload;
}

export interface TradingAgentsLegacyResearchRequest {
  schemaVersion: typeof TRADING_AGENTS_REQUEST_SCHEMA_VERSION;
  generatedAt: string;
  symbol: string;
  marketContext: TradingAgentsMarketContext;
  newsContext: TradingAgentsNewsContext;
  decisionContext: TradingAgentsDecisionContext;
}

export type TradingAgentsResearchRequest =
  | TradingAgentsStrictResearchRequest
  | TradingAgentsLegacyResearchRequest;

export interface TradingAgentsResearchInput {
  symbol: string;
  lookbackBars: number;
  newsLookback: string;
  selectedAnalysts: TradingAgentsAnalyst[];
  researchDepth: number;
  releaseGateMode: ReleaseGateMode | "auto";
  requireReleaseGatePass: boolean;
}

export interface TradingAgentsResearchResultEnvelope {
  researchDecision: ResearchDecisionV1;
  rawOutput?: unknown;
}

export interface ITradingAgentsResearchRunner {
  run(
    request: TradingAgentsResearchRequest,
  ): Promise<ResearchDecisionV1 | TradingAgentsResearchResultEnvelope>;
}

export interface TradingAgentsResearchToolResult {
  researchDecision: ResearchDecisionV1;
  request: {
    schemaVersion: typeof TRADING_AGENTS_REQUEST_SCHEMA_VERSION;
    sourceId: typeof TRADING_AGENTS_SOURCE_ID;
    requestId: string;
    sidecarRunId: string;
    inputHash: string;
    symbol: string;
    candleCount: number;
    newsCount: number;
    selectedAnalysts: TradingAgentsAnalyst[];
    researchDepth: number;
    releaseGateMode: ReleaseGateMode | "auto";
  };
  rawOutput?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function serializeNewsItems(
  items: NewsItem[],
): TradingAgentsSerializableNewsItem[] {
  return items.map((item) => ({
    time: item.time.toISOString(),
    title: item.title,
    content: item.content,
    metadata: item.metadata,
  }));
}

export function computeTradingAgentsRequestInputHash(
  payload: TradingAgentsResearchPayload,
): string {
  return sha256Hex(canonicalJsonStringify(payload));
}

export function createTradingAgentsRequestMeta(input: {
  requestId: string;
  sidecarRunId: string;
  generatedAt: string;
  payload: TradingAgentsResearchPayload;
  sourceId?: typeof TRADING_AGENTS_SOURCE_ID;
}): TradingAgentsResearchRequestMeta {
  return {
    schemaVersion: TRADING_AGENTS_REQUEST_SCHEMA_VERSION,
    sourceId: input.sourceId ?? TRADING_AGENTS_SOURCE_ID,
    requestId: input.requestId,
    sidecarRunId: input.sidecarRunId,
    generatedAt: input.generatedAt,
    inputHash: computeTradingAgentsRequestInputHash(input.payload),
  };
}

export function isStrictTradingAgentsResearchRequest(
  request: TradingAgentsResearchRequest,
): request is TradingAgentsStrictResearchRequest {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  if (!("requestMeta" in request) || !("payload" in request)) {
    return false;
  }

  const strictRequest = request as Partial<TradingAgentsStrictResearchRequest>;
  return (
    strictRequest.schemaVersion === TRADING_AGENTS_REQUEST_SCHEMA_VERSION &&
    typeof strictRequest.requestMeta === "object" &&
    strictRequest.requestMeta !== null &&
    typeof strictRequest.payload === "object" &&
    strictRequest.payload !== null
  );
}

export function getTradingAgentsResearchPayload(
  request: TradingAgentsResearchRequest,
): TradingAgentsResearchPayload {
  if (isStrictTradingAgentsResearchRequest(request)) {
    return request.payload;
  }

  return {
    symbol: request.symbol,
    marketContext: request.marketContext,
    newsContext: request.newsContext,
    decisionContext: request.decisionContext,
  };
}

export function normalizeTradingAgentsResearchRequest(
  request: TradingAgentsResearchRequest,
  identifiers?: {
    requestId?: string;
    sidecarRunId?: string;
  },
): TradingAgentsStrictResearchRequest & TradingAgentsLegacyResearchRequest {
  const payload = getTradingAgentsResearchPayload(request);

  const requestMeta = isStrictTradingAgentsResearchRequest(request)
    ? request.requestMeta
    : createTradingAgentsRequestMeta({
        requestId:
          identifiers?.requestId ??
          "legacy-request",
        sidecarRunId:
          identifiers?.sidecarRunId ??
          "legacy-sidecar-run",
        generatedAt: request.generatedAt,
        payload,
      });

  return {
    schemaVersion: TRADING_AGENTS_REQUEST_SCHEMA_VERSION,
    requestMeta,
    payload,
    generatedAt: requestMeta.generatedAt,
    symbol: payload.symbol,
    marketContext: payload.marketContext,
    newsContext: payload.newsContext,
    decisionContext: payload.decisionContext,
  };
}

export function validateTradingAgentsRequestMeta(
  meta: TradingAgentsResearchRequestMeta,
): string[] {
  const errors: string[] = [];

  if (meta.schemaVersion !== TRADING_AGENTS_REQUEST_SCHEMA_VERSION) {
    errors.push("invalid_schema_version");
  }
  if (meta.sourceId !== TRADING_AGENTS_SOURCE_ID) {
    errors.push("invalid_source_id");
  }
  if (!isNonEmptyString(meta.requestId)) {
    errors.push("missing_request_id");
  }
  if (!isNonEmptyString(meta.sidecarRunId)) {
    errors.push("missing_sidecar_run_id");
  }
  if (!isNonEmptyString(meta.generatedAt)) {
    errors.push("missing_generated_at");
  }
  if (!isNonEmptyString(meta.inputHash)) {
    errors.push("missing_input_hash");
  }

  return errors;
}

export function validateTradingAgentsStrictResearchRequest(
  request: TradingAgentsStrictResearchRequest,
): string[] {
  const errors = validateTradingAgentsRequestMeta(request.requestMeta);
  const payload = request.payload;

  if (!isNonEmptyString(payload.symbol)) {
    errors.push("missing_symbol");
  }
  if (!Array.isArray(payload.marketContext.candles)) {
    errors.push("missing_market_candles");
  }
  if (!isNonEmptyString(payload.marketContext.windowStart)) {
    errors.push("missing_market_window_start");
  }
  if (!isNonEmptyString(payload.marketContext.windowEnd)) {
    errors.push("missing_market_window_end");
  }
  if (!Array.isArray(payload.newsContext.items)) {
    errors.push("missing_news_items");
  }
  if (!isNonEmptyString(payload.newsContext.lookback)) {
    errors.push("missing_news_lookback");
  }
  if (!Array.isArray(payload.decisionContext.selectedAnalysts)) {
    errors.push("missing_selected_analysts");
  }
  if (!isNonEmptyString(payload.decisionContext.releaseGateMode)) {
    errors.push("missing_release_gate_mode");
  }
  if (
    computeTradingAgentsRequestInputHash(payload) !== request.requestMeta.inputHash
  ) {
    errors.push("input_hash_mismatch");
  }

  return errors;
}

export function validateTradingAgentsRequestFreshness(
  meta: TradingAgentsResearchRequestMeta,
  now: Date,
  maxAgeMs = TRADING_AGENTS_REQUEST_MAX_AGE_MS,
): string[] {
  const errors: string[] = [];
  const generatedAtMs = Date.parse(meta.generatedAt);
  if (!Number.isFinite(generatedAtMs)) {
    errors.push("invalid_generated_at");
    return errors;
  }
  if (now.getTime() - generatedAtMs > maxAgeMs) {
    errors.push("stale_context");
  }
  return errors;
}
