import { z } from "zod";
import type { ExpertAction, ExpertDecisionResult, ExpertMlSignal } from "./expert_decision.js";
import {
  isExecutionIntentStale,
  validateExecutionIntent,
  type ExecutionIntent,
} from "./execution_semantics.js";
import type { NewsImpactSummary } from "./news_impact.js";
import type {
  PersistedReleaseGateStatus,
  ReleaseGateMode,
} from "./release_gate_status.js";

const STRICT_UTC_ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

const isoUtcSchema = z
  .string()
  .regex(STRICT_UTC_ISO_8601, "must be a strict ISO-8601 UTC timestamp");

const positionSignalSchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const expertActionSchema = z.enum(["long", "short", "flat"]);
const producerModeSchema = z.enum(["native", "sidecar"]);
const releaseGateModeSchema = z.enum(["paper", "live", "auto"]);

const researchDecisionV1Schema = z
  .object({
    schemaVersion: z.literal("research_decision.v1"),
    generatedAt: isoUtcSchema,
    symbol: z.string().min(1),
    decisionContext: z
      .object({
        releaseGateMode: releaseGateModeSchema,
      })
      .strict(),
    marketContext: z
      .object({
        lookbackBars: z.number().int().positive(),
        windowStart: isoUtcSchema,
        windowEnd: isoUtcSchema,
      })
      .strict(),
    provenance: z
      .object({
        producer: z.string().min(1),
        mode: producerModeSchema,
        sourceId: z.string().min(1).optional(),
        requestId: z.string().min(1).optional(),
        sidecarRunId: z.string().min(1).optional(),
        inputHash: z.string().min(1).optional(),
        sourceRequestSchemaVersion: z.string().min(1).optional(),
      })
      .strict(),
    strategy: z
      .object({
        signal: positionSignalSchema,
        reason: z.string().min(1),
        ensembleScore: z.number().min(-1).max(1).optional(),
        selectedStrategy: z.string().min(1).optional(),
        selectorMode: z.string().min(1).optional(),
        selectorReason: z.string().min(1).optional(),
        indicators: z.record(z.string(), z.number()).optional(),
        candidates: z
          .array(
            z
              .object({
                strategy: z.string().min(1),
                signal: positionSignalSchema,
                strength: z.number(),
                reason: z.string().min(1),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    ml: z
      .object({
        available: z.boolean(),
        direction: z.enum(["buy", "sell", "hold"]),
        confidence: z.number().min(0).max(1).optional(),
        expectedReturnPct: z.number().optional(),
        actionable: z.boolean().optional(),
        error: z.string().min(1).optional(),
      })
      .strict(),
    news: z
      .object({
        totalNews: z.number().int().min(0),
        positiveNews: z.number().int().min(0),
        negativeNews: z.number().int().min(0),
        neutralNews: z.number().int().min(0),
        highRiskNews: z.number().int().min(0),
        sentimentScore: z.number(),
        riskScore: z.number(),
        topThemes: z.array(
          z
            .object({
              theme: z.string().min(1),
              count: z.number().int().min(0),
            })
            .strict(),
        ),
        flags: z.array(
          z
            .object({
              time: isoUtcSchema,
              title: z.string().min(1),
              reason: z.string().min(1),
            })
            .strict(),
        ),
        latestHeadlines: z
          .array(
            z
              .object({
                time: isoUtcSchema,
                title: z.string().min(1),
              })
              .strict(),
          )
          .optional(),
      })
      .strict(),
    releaseGate: z
      .object({
        generatedAt: isoUtcSchema,
        allowPaperTrading: z.boolean(),
        allowLiveTrading: z.boolean(),
        failedChecks: z.array(z.string()),
        warningChecks: z.array(z.string()),
        expiresAt: isoUtcSchema.optional(),
      })
      .strict()
      .nullable(),
    decision: z
      .object({
        action: expertActionSchema,
        confidence: z.number().min(0).max(1),
        tradeAllowed: z.boolean(),
        blockedBy: z.array(z.string()),
        reasons: z.array(z.string()),
        suggestedExposurePct: z.number().min(0).max(100),
      })
      .strict(),
  })
  .strict();

const executionIntentV1Schema = z
  .object({
    schemaVersion: z.literal("execution_intent.v1"),
    generatedAt: isoUtcSchema,
    symbol: z.string().min(1),
    action: z.enum(["placeOrder", "closePosition"]),
    decisionContext: z
      .object({
        releaseGateMode: releaseGateModeSchema,
      })
      .strict(),
    provenance: z
      .object({
        producer: z.string().min(1),
        strategyFamily: z.string().min(1).optional(),
        edgeScore: z.number().optional(),
        sourceDecisionSchemaVersion: z.string().min(1).optional(),
        sourceDecisionAction: expertActionSchema.optional(),
      })
      .strict(),
    order: z
      .object({
        side: z.enum(["buy", "sell"]),
        type: z.enum(["market", "limit"]),
        reduceOnly: z.boolean().default(false),
        size: z.number().positive().optional(),
        usdSize: z.number().positive().optional(),
        price: z.number().positive().optional(),
        expectedPrice: z.number().positive().optional(),
      })
      .strict(),
    semantics: z
      .object({
        idempotencyKey: z.string().min(1),
        signalBarCloseTs: z.number().int().nonnegative(),
        submitDecisionTs: z.number().int().nonnegative(),
        submitDeadlineMs: z.number().int().positive(),
        orderStaleMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type ResearchDecisionV1 = z.infer<typeof researchDecisionV1Schema>;
export type ExecutionIntentV1 = z.infer<typeof executionIntentV1Schema>;

export interface ContractValidationResult<T> {
  valid: boolean;
  blockingReasons: string[];
  value?: T;
}

export interface ExpertQuantDecisionArtifact {
  symbol: string;
  generatedAt: string;
  lookbackBars: number;
  window: {
    from: number;
    to: number;
  };
  strategy: {
    signal: -1 | 0 | 1;
    reason: string;
    ensembleScore?: number;
    selectedStrategy?: string;
    selectorMode?: string;
    selectorReason?: string;
    indicators?: Record<string, number>;
    candidates?: Array<{
      strategy: string;
      signal: -1 | 0 | 1;
      strength: number;
      reason: string;
    }>;
  };
  ml: ExpertMlSignal;
  news: NewsImpactSummary & {
    latestHeadlines?: Array<{
      time: string;
      title: string;
    }>;
  };
  releaseGate:
    | null
    | Pick<
        PersistedReleaseGateStatus,
        | "generatedAt"
        | "allowPaperTrading"
        | "allowLiveTrading"
        | "failedChecks"
        | "warningChecks"
        | "expiresAt"
      >;
  decision: ExpertDecisionResult;
}

export interface ExecutionIntentV1BuildInput {
  generatedAt?: string;
  symbol: string;
  action: "placeOrder" | "closePosition";
  side: "buy" | "sell";
  type: "market" | "limit";
  reduceOnly?: boolean;
  size?: number;
  usdSize?: number;
  price?: number;
  expectedPrice?: number;
  idempotencyKey: string;
  signalBarCloseTs: number;
  submitDecisionTs: number;
  submitDeadlineMs: number;
  orderStaleMs: number;
  producer?: string;
  strategyFamily?: string;
  edgeScore?: number;
  releaseGateMode?: ReleaseGateMode | "auto";
  sourceDecisionSchemaVersion?: string;
  sourceDecisionAction?: ExpertAction;
}

function toBlockingReasons(
  prefix: string,
  issues: readonly z.ZodIssue[],
): string[] {
  return issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "root";
    return `${prefix}:${path}:${issue.message}`;
  });
}

function toEpochMs(value: number): number {
  return value >= 1_000_000_000_000 ? value : value * 1000;
}

function toIsoUtcFromUnknownEpoch(value: number): string {
  return new Date(toEpochMs(value)).toISOString();
}

function toExecutionSemanticsIntent(payload: ExecutionIntentV1): ExecutionIntent {
  return {
    symbol: payload.symbol,
    side: payload.order.side,
    reduceOnly: payload.order.reduceOnly,
    idempotencyKey: payload.semantics.idempotencyKey,
    signalBarCloseTs: payload.semantics.signalBarCloseTs,
    submitDecisionTs: payload.semantics.submitDecisionTs,
    submitDeadlineMs: payload.semantics.submitDeadlineMs,
    orderStaleMs: payload.semantics.orderStaleMs,
  };
}

export function validateResearchDecisionV1(
  payload: unknown,
): ContractValidationResult<ResearchDecisionV1> {
  const parsed = researchDecisionV1Schema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      blockingReasons: toBlockingReasons(
        "research_decision_schema_invalid",
        parsed.error.issues,
      ),
    };
  }

  return {
    valid: true,
    blockingReasons: [],
    value: parsed.data,
  };
}

export function validateExecutionIntentV1(
  payload: unknown,
  options?: { nowMs?: number; rejectStale?: boolean },
): ContractValidationResult<ExecutionIntentV1> {
  const parsed = executionIntentV1Schema.safeParse(payload);
  if (!parsed.success) {
    return {
      valid: false,
      blockingReasons: toBlockingReasons(
        "execution_intent_schema_invalid",
        parsed.error.issues,
      ),
    };
  }

  const value = parsed.data;
  const blockingReasons = [...validateExecutionIntent(toExecutionSemanticsIntent(value)).blockingReasons];

  if (value.action === "placeOrder" && value.order.size == null && value.order.usdSize == null) {
    blockingReasons.push("execution_intent_missing_order_size");
  }
  if (value.order.type === "limit" && value.order.price == null) {
    blockingReasons.push("execution_intent_limit_price_missing");
  }
  if (value.action === "closePosition" && value.order.reduceOnly !== true) {
    blockingReasons.push("execution_intent_close_position_must_reduce_only");
  }

  if (
    options?.rejectStale === true &&
    isExecutionIntentStale(
      {
        signalBarCloseTs: value.semantics.signalBarCloseTs,
        orderStaleMs: value.semantics.orderStaleMs,
      },
      options.nowMs ?? value.semantics.submitDecisionTs,
    )
  ) {
    blockingReasons.push("execution_intent_stale");
  }

  return {
    valid: blockingReasons.length === 0,
    blockingReasons,
    value,
  };
}

export function buildResearchDecisionV1FromExpertQuantArtifact(
  artifact: ExpertQuantDecisionArtifact,
  options?: {
    producer?: string;
    mode?: "native" | "sidecar";
    releaseGateMode?: ReleaseGateMode | "auto";
    sourceId?: string;
    requestId?: string;
    sidecarRunId?: string;
    inputHash?: string;
    sourceRequestSchemaVersion?: string;
  },
): ResearchDecisionV1 {
  const payload: ResearchDecisionV1 = {
    schemaVersion: "research_decision.v1",
    generatedAt: artifact.generatedAt,
    symbol: artifact.symbol,
    decisionContext: {
      releaseGateMode: options?.releaseGateMode ?? "auto",
    },
    marketContext: {
      lookbackBars: artifact.lookbackBars,
      windowStart: toIsoUtcFromUnknownEpoch(artifact.window.from),
      windowEnd: toIsoUtcFromUnknownEpoch(artifact.window.to),
    },
    provenance: {
      producer: options?.producer ?? "openalice.expert_quant_tools",
      mode: options?.mode ?? "native",
      sourceId: options?.sourceId,
      requestId: options?.requestId,
      sidecarRunId: options?.sidecarRunId,
      inputHash: options?.inputHash,
      sourceRequestSchemaVersion: options?.sourceRequestSchemaVersion,
    },
    strategy: {
      signal: artifact.strategy.signal,
      reason: artifact.strategy.reason,
      ensembleScore: artifact.strategy.ensembleScore,
      selectedStrategy: artifact.strategy.selectedStrategy,
      selectorMode: artifact.strategy.selectorMode,
      selectorReason: artifact.strategy.selectorReason,
      indicators: artifact.strategy.indicators,
      candidates: artifact.strategy.candidates,
    },
    ml: {
      available: artifact.ml.available,
      direction: artifact.ml.direction,
      confidence: artifact.ml.confidence,
      expectedReturnPct: artifact.ml.expectedReturnPct,
      actionable: artifact.ml.actionable,
      error: artifact.ml.error,
    },
    news: {
      totalNews: artifact.news.totalNews,
      positiveNews: artifact.news.positiveNews,
      negativeNews: artifact.news.negativeNews,
      neutralNews: artifact.news.neutralNews,
      highRiskNews: artifact.news.highRiskNews,
      sentimentScore: artifact.news.sentimentScore,
      riskScore: artifact.news.riskScore,
      topThemes: artifact.news.topThemes.map((item) => ({
        theme: item.theme,
        count: item.count,
      })),
      flags: artifact.news.flags.map((item) => ({
        time: item.time,
        title: item.title,
        reason: item.reason,
      })),
      latestHeadlines: artifact.news.latestHeadlines?.map((item) => ({
        time: item.time,
        title: item.title,
      })),
    },
    releaseGate: artifact.releaseGate
      ? {
          generatedAt: artifact.releaseGate.generatedAt,
          allowPaperTrading: artifact.releaseGate.allowPaperTrading,
          allowLiveTrading: artifact.releaseGate.allowLiveTrading,
          failedChecks: [...artifact.releaseGate.failedChecks],
          warningChecks: [...artifact.releaseGate.warningChecks],
          expiresAt: artifact.releaseGate.expiresAt,
        }
      : null,
    decision: {
      action: artifact.decision.action,
      confidence: artifact.decision.confidence,
      tradeAllowed: artifact.decision.tradeAllowed,
      blockedBy: [...artifact.decision.blockedBy],
      reasons: [...artifact.decision.reasons],
      suggestedExposurePct: artifact.decision.suggestedExposurePct,
    },
  };

  const validation = validateResearchDecisionV1(payload);
  if (!validation.valid || !validation.value) {
    throw new Error(validation.blockingReasons.join("; "));
  }
  return validation.value;
}

export function buildExecutionIntentV1(
  input: ExecutionIntentV1BuildInput,
): ExecutionIntentV1 {
  const payload: ExecutionIntentV1 = {
    schemaVersion: "execution_intent.v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    symbol: input.symbol,
    action: input.action,
    decisionContext: {
      releaseGateMode: input.releaseGateMode ?? "auto",
    },
    provenance: {
      producer: input.producer ?? "openalice.runtime",
      strategyFamily: input.strategyFamily,
      edgeScore: input.edgeScore,
      sourceDecisionSchemaVersion: input.sourceDecisionSchemaVersion,
      sourceDecisionAction: input.sourceDecisionAction,
    },
    order: {
      side: input.side,
      type: input.type,
      reduceOnly: input.reduceOnly ?? false,
      size: input.size,
      usdSize: input.usdSize,
      price: input.price,
      expectedPrice: input.expectedPrice,
    },
    semantics: {
      idempotencyKey: input.idempotencyKey,
      signalBarCloseTs: input.signalBarCloseTs,
      submitDecisionTs: input.submitDecisionTs,
      submitDeadlineMs: input.submitDeadlineMs,
      orderStaleMs: input.orderStaleMs,
    },
  };

  const validation = validateExecutionIntentV1(payload);
  if (!validation.valid || !validation.value) {
    throw new Error(validation.blockingReasons.join("; "));
  }
  return validation.value;
}
