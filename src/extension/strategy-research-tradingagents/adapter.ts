import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import { createExpertQuantTools } from "../expert-quant-tools/index.js";
import {
  validateResearchDecisionV1,
  type ResearchDecisionV1,
} from "../../runtime/research_execution_contracts.js";
import type { TradingAgentsVerdictArtifact } from "../../runtime/tradingagents_advisory_scorecard.js";
import { getContextId, resolveContext } from "../../core/trusted-context.js";
import type {
  ITradingAgentsResearchRunner,
  TradingAgentsAnalyst,
  TradingAgentsResearchInput,
  TradingAgentsResearchRequest,
  TradingAgentsResearchToolResult,
} from "./types.js";
import {
  createTradingAgentsRequestMeta,
  normalizeTradingAgentsResearchRequest,
  serializeNewsItems,
} from "./types.js";
import {
  buildResearchDecisionOperatorSummary,
  buildTradingAgentsFallbackSummary,
  createResearchDecisionDisagreementArtifact,
  type ResearchDecisionDisagreementArtifact,
} from "./disagreement.js";
import { TradingAgentsSidecarRunError } from "./runner.js";

const TradingAgentsAnalystSchema = z.enum([
  "market",
  "social",
  "news",
  "fundamentals",
]);

const TradingAgentsResearchInputSchema = z.object({
  symbol: z.string().min(1).describe("Trading symbol, e.g. BTC/USD"),
  lookbackBars: z
    .number()
    .int()
    .positive()
    .max(5000)
    .default(240)
    .describe("Number of market bars to include in the sidecar request."),
  newsLookback: z
    .string()
    .default("72h")
    .describe("News lookback window forwarded to the analysis context."),
  selectedAnalysts: z
    .array(TradingAgentsAnalystSchema)
    .min(1)
    .default(["market", "social", "news", "fundamentals"])
    .describe("Analyst teams to request from the TradingAgents sidecar."),
  researchDepth: z
    .number()
    .int()
    .min(0)
    .max(5)
    .default(1)
    .describe("Sidecar debate/research depth. Keep low for now."),
  releaseGateMode: z
    .enum(["paper", "live", "auto"])
    .default("auto")
    .describe("Execution mode context used by downstream consumers."),
  requireReleaseGatePass: z
    .boolean()
    .default(true)
    .describe("Whether the returned decision is expected to honor release-gate checks."),
});

async function loadCandles(
  ctx: IAnalysisContext,
  symbol: string,
  lookbackBars: number,
) {
  const endTime = ctx.getPlayheadTime();
  const startTime = ctx.calculatePreviousTime(lookbackBars);
  const candles = await ctx.marketDataProvider.getMarketDataRange(
    startTime,
    endTime,
    symbol,
  );
  if (!candles.length) {
    throw new Error(`No OHLCV data found for ${symbol}.`);
  }
  return {
    candles: candles.sort((a, b) => a.time - b.time),
    startTime,
    endTime,
  };
}

function resolveCurrentRequestId(): string {
  const contextId = getContextId();
  if (!contextId) {
    return randomUUID();
  }
  return resolveContext(contextId)?.requestId ?? randomUUID();
}

function sidecarRunId(): string {
  return randomUUID();
}

export async function buildTradingAgentsResearchRequest(
  ctx: IAnalysisContext,
  input: TradingAgentsResearchInput,
): Promise<TradingAgentsResearchRequest> {
  const generatedAt = ctx.getPlayheadTime().toISOString();
  const { candles, startTime, endTime } = await loadCandles(
    ctx,
    input.symbol,
    input.lookbackBars,
  );
  const news = await ctx.getNewsV2({
    lookback: input.newsLookback,
    endTime,
    limit: 200,
  });

  const payload = {
    symbol: input.symbol,
    marketContext: {
      lookbackBars: input.lookbackBars,
      windowStart: startTime.toISOString(),
      windowEnd: endTime.toISOString(),
      candles,
    },
    newsContext: {
      lookback: input.newsLookback,
      items: serializeNewsItems(news),
    },
    decisionContext: {
      releaseGateMode: input.releaseGateMode,
      requireReleaseGatePass: input.requireReleaseGatePass,
      selectedAnalysts: input.selectedAnalysts,
      researchDepth: input.researchDepth,
    },
    derivedContext: {
      featureSummary: `candles=${candles.length};news=${news.length};symbol=${input.symbol}`,
      promptReadySummary: `${input.symbol} with ${candles.length} candles and ${news.length} news items.`,
    },
  };

  return normalizeTradingAgentsResearchRequest({
    schemaVersion: "tradingagents_sidecar_request.v1",
    requestMeta: createTradingAgentsRequestMeta({
      requestId: resolveCurrentRequestId(),
      sidecarRunId: sidecarRunId(),
      generatedAt,
      payload,
    }),
    payload,
  });
}

function unwrapResearchDecision(
  result: ResearchDecisionV1 | { researchDecision: ResearchDecisionV1; rawOutput?: unknown },
): { researchDecision: ResearchDecisionV1; rawOutput?: unknown } {
  if ("researchDecision" in result) {
    return result;
  }
  return {
    researchDecision: result,
  };
}

function getDisagreementArtifactPath(rawOutput: unknown): string | null {
  if (typeof rawOutput !== "object" || rawOutput === null) {
    return null;
  }
  const artifactPaths = (rawOutput as { artifactPaths?: unknown }).artifactPaths;
  if (typeof artifactPaths !== "object" || artifactPaths === null) {
    return null;
  }
  const disagreementPath = (artifactPaths as { disagreementPath?: unknown })
    .disagreementPath;
  return typeof disagreementPath === "string" && disagreementPath.trim().length > 0
    ? disagreementPath
    : null;
}

async function persistDisagreementArtifact(
  disagreementPath: string | null,
  disagreement: ResearchDecisionDisagreementArtifact,
): Promise<string | undefined> {
  if (!disagreementPath) {
    return undefined;
  }

  try {
    await mkdir(dirname(disagreementPath), { recursive: true });
    await writeFile(
      disagreementPath,
      `${JSON.stringify(disagreement, null, 2)}\n`,
      "utf-8",
    );
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function createTradingAgentsResearchTools(
  ctx: IAnalysisContext,
  runner: ITradingAgentsResearchRunner,
  options?: {
    loadVerdict?: () => Promise<TradingAgentsVerdictArtifact | null>;
  },
) {
  const expertQuantTools = createExpertQuantTools(ctx);

  return {
    tradingAgentsResearchAnalyze: tool({
      description:
        "Run the TradingAgents sidecar as a research-only engine and return a normalized research_decision.v1 payload.",
      inputSchema: TradingAgentsResearchInputSchema,
      execute: async (input): Promise<TradingAgentsResearchToolResult> => {
        const request = normalizeTradingAgentsResearchRequest(
          await buildTradingAgentsResearchRequest(ctx, input),
        );
        const baselineResult = await (expertQuantTools.expertQuantDecision as any).execute({
          symbol: input.symbol,
          lookbackBars: Math.max(200, input.lookbackBars),
          newsLookback: input.newsLookback,
          requireReleaseGatePass: input.requireReleaseGatePass,
          policy: {
            allowShort: false,
          },
        });

        const baselineValidation = validateResearchDecisionV1(
          baselineResult.researchDecision,
        );
        if (!baselineValidation.valid || !baselineValidation.value) {
          throw new Error(baselineValidation.blockingReasons.join("; "));
        }

        const verdict = (await options?.loadVerdict?.()) ?? null;
        if (verdict?.automaticRunsBlocked) {
          const fallbackSummary = buildTradingAgentsFallbackSummary({
            sourceId: request.requestMeta.sourceId,
            symbol: request.payload.symbol,
            requestId: request.requestMeta.requestId,
            sidecarRunId: request.requestMeta.sidecarRunId,
            inputHash: request.requestMeta.inputHash,
            failureCode: "blocked_by_source_role",
            fallbackReason: `tradingagents_verdict_blocked:${verdict.state}:${verdict.reasons.join(",")}`,
            operatorVisible: true,
          });

          return {
            researchDecision: baselineValidation.value,
            request: {
              schemaVersion: request.requestMeta.schemaVersion,
              sourceId: request.requestMeta.sourceId,
              requestId: request.requestMeta.requestId,
              sidecarRunId: request.requestMeta.sidecarRunId,
              inputHash: request.requestMeta.inputHash,
              symbol: request.payload.symbol,
              candleCount: request.payload.marketContext.candles.length,
              newsCount: request.payload.newsContext.items.length,
              selectedAnalysts: [...request.payload.decisionContext.selectedAnalysts],
              researchDepth: request.payload.decisionContext.researchDepth,
              releaseGateMode: request.payload.decisionContext.releaseGateMode,
            },
            rawOutput: {
              status: "blocked_by_verdict",
              sourceId: request.requestMeta.sourceId,
              requestMeta: request.requestMeta,
              verdict,
              fallback: fallbackSummary,
              baseline: buildResearchDecisionOperatorSummary(
                baselineValidation.value,
              ),
            },
          };
        }

        try {
          const result = unwrapResearchDecision(await runner.run(request));
          const validation = validateResearchDecisionV1(result.researchDecision);
          if (!validation.valid || !validation.value) {
            throw new Error(validation.blockingReasons.join("; "));
          }

          const disagreement = createResearchDecisionDisagreementArtifact({
            baseline: baselineValidation.value,
            donor: validation.value,
            generatedAt: request.requestMeta.generatedAt,
          });
          const disagreementArtifactPath = getDisagreementArtifactPath(
            result.rawOutput,
          );
          const disagreementPersistError = await persistDisagreementArtifact(
            disagreementArtifactPath,
            disagreement,
          );

          return {
            researchDecision: validation.value,
            request: {
              schemaVersion: request.requestMeta.schemaVersion,
              sourceId: request.requestMeta.sourceId,
              requestId: request.requestMeta.requestId,
              sidecarRunId: request.requestMeta.sidecarRunId,
              inputHash: request.requestMeta.inputHash,
              symbol: request.payload.symbol,
              candleCount: request.payload.marketContext.candles.length,
              newsCount: request.payload.newsContext.items.length,
              selectedAnalysts: [...request.payload.decisionContext.selectedAnalysts],
              researchDepth: request.payload.decisionContext.researchDepth,
              releaseGateMode: request.payload.decisionContext.releaseGateMode,
            },
            rawOutput: {
              status: "completed",
              sourceId: request.requestMeta.sourceId,
              requestMeta: request.requestMeta,
              baseline: buildResearchDecisionOperatorSummary(
                baselineValidation.value,
              ),
              donor: buildResearchDecisionOperatorSummary(validation.value),
              disagreement,
              disagreementArtifactPath,
              disagreementPersistError,
              sidecar: result.rawOutput,
            },
          };
        } catch (error) {
          const fallbackSummary =
            error instanceof TradingAgentsSidecarRunError
              ? buildTradingAgentsFallbackSummary({
                  sourceId: error.artifact.sourceId,
                  symbol: error.artifact.symbol,
                  requestId: error.artifact.requestId,
                  sidecarRunId: error.artifact.sidecarRunId,
                  inputHash: error.artifact.inputHash,
                  failureCode: error.artifact.failureCode,
                  fallbackReason: error.artifact.fallbackReason,
                  operatorVisible: error.artifact.operatorVisible,
                  timedOut: error.artifact.timedOut,
                  stderrDigest: error.artifact.stderrDigest,
                  generatedAt: error.artifact.generatedAt,
                })
              : buildTradingAgentsFallbackSummary({
                  sourceId: request.requestMeta.sourceId,
                  symbol: request.payload.symbol,
                  requestId: request.requestMeta.requestId,
                  sidecarRunId: request.requestMeta.sidecarRunId,
                  inputHash: request.requestMeta.inputHash,
                  failureCode: "sidecar_boot_failed",
                  fallbackReason:
                    error instanceof Error ? error.message : String(error),
                  operatorVisible: true,
                });

          return {
            researchDecision: baselineValidation.value,
            request: {
              schemaVersion: request.requestMeta.schemaVersion,
              sourceId: request.requestMeta.sourceId,
              requestId: request.requestMeta.requestId,
              sidecarRunId: request.requestMeta.sidecarRunId,
              inputHash: request.requestMeta.inputHash,
              symbol: request.payload.symbol,
              candleCount: request.payload.marketContext.candles.length,
              newsCount: request.payload.newsContext.items.length,
              selectedAnalysts: [...request.payload.decisionContext.selectedAnalysts],
              researchDepth: request.payload.decisionContext.researchDepth,
              releaseGateMode: request.payload.decisionContext.releaseGateMode,
            },
            rawOutput: {
              status: "fallback_triggered",
              sourceId: request.requestMeta.sourceId,
              requestMeta: request.requestMeta,
              fallback: fallbackSummary,
              baseline: buildResearchDecisionOperatorSummary(
                baselineValidation.value,
              ),
              error:
                error instanceof TradingAgentsSidecarRunError
                  ? {
                      failureCode: error.artifact.failureCode,
                      artifactPaths: error.artifact.artifactPaths,
                    }
                  : undefined,
            },
          };
        }
      },
    }),
  };
}
