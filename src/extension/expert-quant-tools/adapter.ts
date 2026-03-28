import { tool } from "ai";
import { z } from "zod";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import {
  runMlEnsemblePredict,
  type MlEnsembleModelName,
} from "../ml-ensemble-tools/index.js";
import {
  evaluateStrategy,
  getStrategyMinimumBars,
  type StrategyDecision,
  type StrategyName,
  type StrategyParams,
} from "../strategy-tools/index.js";
import { buildRegimeSnapshot } from "../../runtime/regime_snapshot.js";
import { buildModelSignalArtifact } from "../../runtime/ml_artifact_contracts.js";
import { analyzeNewsImpact } from "../../runtime/news_impact.js";
import { evaluateExpertDecision } from "../../runtime/expert_decision.js";
import { loadReleaseGateStatus } from "../../runtime/release_gate_status.js";
import { buildResearchDecisionV1FromExpertQuantArtifact } from "../../runtime/research_execution_contracts.js";

const StrategyParamsObjectSchema = z.object({
  allowShort: z.boolean().optional(),
  trendFastPeriod: z.number().int().positive().optional(),
  trendSlowPeriod: z.number().int().positive().optional(),
  rsiPeriod: z.number().int().positive().optional(),
  rsiOversold: z.number().positive().max(100).optional(),
  rsiOverbought: z.number().positive().max(100).optional(),
  bbPeriod: z.number().int().positive().optional(),
  bbStdDev: z.number().positive().optional(),
  breakoutPeriod: z.number().int().positive().optional(),
  breakoutExitPeriod: z.number().int().positive().optional(),
  ensembleThreshold: z.number().min(0).max(1).optional(),
  ensembleWeights: z
    .object({
      trend: z.number().positive().optional(),
      meanReversion: z.number().positive().optional(),
      breakout: z.number().positive().optional(),
    })
    .optional(),
});

const MlModelSchema = z.enum([
  "xgboost",
  "lightgbm",
  "catboost",
  "randomForest",
  "ridge",
  "pytorch",
]);

async function loadCandles(
  ctx: IAnalysisContext,
  symbol: string,
  lookbackBars: number
): Promise<MarketData[]> {
  const endTime = ctx.getPlayheadTime();
  const startTime = ctx.calculatePreviousTime(lookbackBars);
  const rows = await ctx.marketDataProvider.getMarketDataRange(
    startTime,
    endTime,
    symbol
  );
  if (!rows.length) {
    throw new Error(`No OHLCV data found for ${symbol}.`);
  }
  return rows.sort((a, b) => a.time - b.time);
}

function computeMlActionable(
  ml: Awaited<ReturnType<typeof runMlEnsemblePredict>>
) {
  const thresholds = ml.prediction.thresholds;
  if (ml.prediction.direction === "hold") {
    return false;
  }
  if (ml.prediction.confidence < thresholds.minConfidence) {
    return false;
  }
  if (
    Math.abs(ml.prediction.expectedReturnPct) < thresholds.minExpectedReturnPct
  ) {
    return false;
  }
  return true;
}

type StrategySelectionMode = "auto_rotate" | "ensemble_only";

interface RankedStrategyDecision {
  strategy: StrategyName;
  decision: StrategyDecision;
  strength: number;
}

const STRATEGY_CANDIDATES: StrategyName[] = [
  "trend",
  "meanReversion",
  "breakout",
  "ensemble",
];

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function strategyFamilyFor(strategy: StrategyName): string {
  switch (strategy) {
    case "trend":
      return "core_trend";
    case "meanReversion":
      return "core_mean_reversion";
    case "breakout":
      return "core_breakout";
    case "ensemble":
      return "core_ensemble";
    case "volBreakout":
    case "volTrend":
    case "volNoTradeFilter":
      return "volatility_gated";
  }
}

function computeStrategyStrength(
  strategy: StrategyName,
  decision: StrategyDecision
): number {
  const base = decision.signal === 0 ? 0.15 : 0.55;
  let bonus = 0;

  if (strategy === "ensemble") {
    const score = finiteOrUndefined(decision.indicators.ensembleScore) ?? 0;
    bonus = clamp01(Math.abs(score)) * 0.45;
  } else if (strategy === "trend") {
    const smaDiffPct = finiteOrUndefined(decision.indicators.smaDiffPct) ?? 0;
    bonus = clamp01(Math.abs(smaDiffPct) / 1.5) * 0.45;
  } else if (strategy === "meanReversion") {
    const rsi = finiteOrUndefined(decision.indicators.rsi);
    if (typeof rsi === "number") {
      const extreme = rsi <= 30 ? 30 - rsi : rsi >= 70 ? rsi - 70 : 0;
      bonus = clamp01(extreme / 20) * 0.45;
    }
  } else if (strategy === "breakout") {
    const close = finiteOrUndefined(decision.indicators.close);
    const breakoutHigh = finiteOrUndefined(decision.indicators.breakoutHigh);
    const breakoutLow = finiteOrUndefined(decision.indicators.breakoutLow);
    if (
      typeof close === "number" &&
      typeof breakoutHigh === "number" &&
      typeof breakoutLow === "number"
    ) {
      let breakoutDistance = 0;
      if (decision.signal > 0 && close > breakoutHigh) {
        breakoutDistance =
          (close - breakoutHigh) / Math.max(1e-6, breakoutHigh);
      } else if (decision.signal < 0 && close < breakoutLow) {
        breakoutDistance = (breakoutLow - close) / Math.max(1e-6, breakoutLow);
      }
      bonus = clamp01(breakoutDistance * 50) * 0.45;
    }
  }

  return Number(clamp01(base + bonus).toFixed(4));
}

function evaluateStrategyCandidates(
  candles: MarketData[],
  params: StrategyParams | undefined
): RankedStrategyDecision[] {
  const evaluated: RankedStrategyDecision[] = [];
  for (const strategy of STRATEGY_CANDIDATES) {
    const minBars = getStrategyMinimumBars(strategy, params);
    if (candles.length < minBars + 2) {
      continue;
    }
    const decision = evaluateStrategy({
      strategy,
      candles,
      index: candles.length - 1,
      currentPosition: 0,
      params,
    });
    evaluated.push({
      strategy,
      decision,
      strength: computeStrategyStrength(strategy, decision),
    });
  }
  return evaluated.sort((a, b) => b.strength - a.strength);
}

function pickActiveStrategy(
  ranked: RankedStrategyDecision[],
  mode: StrategySelectionMode,
  switchThreshold: number,
  switchMargin: number
): { selected: RankedStrategyDecision; reason: string } {
  if (!ranked.length) {
    throw new Error("No strategy candidates available for current lookback.");
  }

  const ensemble = ranked.find(item => item.strategy === "ensemble");
  const bestNonFlat = ranked.find(item => item.decision.signal !== 0);
  const fallback = bestNonFlat ?? ranked[0];

  if (mode === "ensemble_only") {
    return {
      selected: ensemble ?? fallback,
      reason: "selector=ensemble_only",
    };
  }

  if (!ensemble) {
    return {
      selected: fallback,
      reason: "selector=auto_rotate,ensemble_unavailable",
    };
  }

  if (ensemble.decision.signal !== 0 && ensemble.strength >= switchThreshold) {
    return {
      selected: ensemble,
      reason: `selector=auto_rotate,keep_ensemble(strength=${ensemble.strength.toFixed(3)})`,
    };
  }

  const switched = ranked.find(
    item =>
      item.strategy !== "ensemble" &&
      item.decision.signal !== 0 &&
      item.strength >= ensemble.strength + switchMargin
  );
  if (switched) {
    return {
      selected: switched,
      reason: `selector=auto_rotate,switch_from_ensemble(${ensemble.strength.toFixed(3)}->${switched.strategy}:${switched.strength.toFixed(3)})`,
    };
  }

  return {
    selected: fallback,
    reason: `selector=auto_rotate,fallback_best(${fallback.strategy}:${fallback.strength.toFixed(3)})`,
  };
}

export function createExpertQuantTools(ctx: IAnalysisContext) {
  return {
    expertQuantDecision: tool({
      description: `
Run a deterministic expert-level quant decision pipeline:
1) Evaluate multiple strategy signals (trend/mean-reversion/breakout/ensemble) and auto-rotate early when ensemble conviction is weak
2) Analyze recent news sentiment and risk impact
3) Run optional ML ensemble prediction
4) Apply release-gate and risk-off blockers

Returns a structured trade decision with confidence, reasons, and suggested exposure.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USD"'),
        lookbackBars: z
          .number()
          .int()
          .min(200)
          .max(20_000)
          .default(1500)
          .describe("How many candles to load"),
        strategyParams: StrategyParamsObjectSchema.optional(),
        strategySelection: z
          .enum(["auto_rotate", "ensemble_only"])
          .default("auto_rotate")
          .describe(
            "Strategy selector mode. auto_rotate switches earlier to stronger non-ensemble signals."
          ),
        strategySwitchThreshold: z
          .number()
          .min(0)
          .max(1)
          .default(0.35)
          .describe(
            "If ensemble strength is below this threshold, selector considers switching."
          ),
        strategySwitchMargin: z
          .number()
          .min(0)
          .max(0.5)
          .default(0.08)
          .describe(
            "Minimum strength advantage required for non-ensemble strategy takeover."
          ),
        newsLookback: z
          .string()
          .default("48h")
          .describe('Semantic lookback, e.g. "12h", "2d"'),
        newsLimit: z.number().int().min(1).max(500).default(300),
        useMl: z.boolean().default(true),
        ml: z
          .object({
            horizonBars: z.number().int().min(1).max(24).default(1),
            trainRatio: z.number().min(0.5).max(0.95).default(0.8),
            includeModels: z.array(MlModelSchema).min(1).max(6).optional(),
            minConfidence: z.number().min(0.5).max(0.95).default(0.55),
            minExpectedReturnPct: z.number().min(0).max(20).default(0.03),
            seed: z.number().int().default(42),
            ensembleMode: z
              .enum(["stacking", "regime_moe"])
              .default("regime_moe"),
            regimeCount: z.union([z.literal(3), z.literal(4)]).default(3),
            regimeMethod: z.enum(["rule", "kmeans"]).default("rule"),
            hybridWeights: z
              .object({
                accuracyLift: z.number().min(0).default(0.2),
                robustCostAwareUtility: z.number().min(0).default(0.3),
                netSharpeAfterCost: z.number().min(0).default(0.2),
                rmsePct: z.number().min(0).default(0.1),
                winRateAfterCost: z.number().min(0).default(0.1),
                turnoverPerBar: z.number().min(0).default(0.1),
              })
              .optional(),
            oofMinCoverageSoft: z.number().min(0.2).max(0.95).default(0.6),
            oofHardFloor: z.number().min(0.05).max(0.9).default(0.25),
            softFailMaxWeight: z.number().min(0).max(1).default(0.15),
            tscvGapBars: z.number().int().min(0).max(20).default(2),
            testLockRatio: z.number().min(0.05).max(0.3).default(0.1),
            calibrationMethod: z
              .enum(["none", "sigmoid", "isotonic"])
              .default("sigmoid"),
            riskClampOnSoftStatWarn: z
              .number()
              .min(0.05)
              .max(1)
              .default(0.35),
          })
          .optional(),
        requireReleaseGatePass: z.boolean().default(true),
        releaseGateStatusPath: z
          .string()
          .default("data/runtime/release_gate_status.json"),
        policy: z
          .object({
            requireMl: z.boolean().optional(),
            allowShort: z.boolean().optional(),
            minCompositeScore: z.number().min(0.05).max(1).optional(),
            minMlConfidence: z.number().min(0.5).max(0.95).optional(),
            minExpectedReturnPct: z.number().min(0.001).max(10).optional(),
            riskOffNewsScore: z.number().min(0.1).max(1).optional(),
          })
          .optional(),
      }),
      execute: async ({
        symbol,
        lookbackBars,
        strategyParams,
        strategySelection,
        strategySwitchThreshold,
        strategySwitchMargin,
        newsLookback,
        newsLimit,
        useMl,
        ml,
        requireReleaseGatePass,
        releaseGateStatusPath,
        policy,
      }) => {
        const candles = await loadCandles(ctx, symbol, lookbackBars);
        const params = strategyParams as StrategyParams | undefined;
        const minBars = Math.min(
          ...STRATEGY_CANDIDATES.map(strategy =>
            getStrategyMinimumBars(strategy, params)
          )
        );
        if (candles.length < minBars + 2) {
          throw new Error(
            `Strategy evaluation needs at least ${minBars + 2} candles. Got ${candles.length}.`
          );
        }

        const strategyCandidates = evaluateStrategyCandidates(candles, params);
        const news = await ctx.getNewsV2({
          lookback: newsLookback,
          limit: newsLimit,
        });
        const now = ctx.getPlayheadTime();
        const newsImpact = analyzeNewsImpact(news, { now });
        const eventIntensity = Math.min(1, newsImpact.riskScore);
        const regimeSnapshot = buildRegimeSnapshot({
          symbol,
          bars: candles,
          generatedAt: now.toISOString(),
          eventIntensity,
        });
        const eligibleStrategyCandidates = strategyCandidates.filter((item) =>
          regimeSnapshot.allowedStrategyFamilies.includes(
            strategyFamilyFor(item.strategy),
          ),
        );
        const selection = pickActiveStrategy(
          eligibleStrategyCandidates.length > 0
            ? eligibleStrategyCandidates
            : strategyCandidates,
          strategySelection,
          strategySwitchThreshold,
          strategySwitchMargin
        );
        const strategyDecision = selection.selected.decision;

        let mlSignal:
          | {
              available: boolean;
              direction: "buy" | "sell" | "hold";
              confidence?: number;
              expectedReturnPct?: number;
              actionable?: boolean;
              modelCount?: number;
              ensembleMode?: "stacking" | "regime_moe";
              currentRegime?: string;
              hybridGlobalWinner?: string;
              softFailModels?: string[];
              hardDroppedModels?: string[];
              error?: string;
            }
          | undefined;

        if (useMl) {
          try {
            const mlResult = await runMlEnsemblePredict({
              candles,
              horizonBars: ml?.horizonBars ?? 1,
              trainRatio: ml?.trainRatio ?? 0.8,
              includeModels: ml?.includeModels as
                | MlEnsembleModelName[]
                | undefined,
              minConfidence: ml?.minConfidence ?? 0.55,
              minExpectedReturnPct: ml?.minExpectedReturnPct ?? 0.03,
              seed: ml?.seed ?? 42,
              ensembleMode: ml?.ensembleMode ?? "regime_moe",
              regimeCount: ml?.regimeCount ?? 3,
              regimeMethod: ml?.regimeMethod ?? "rule",
              hybridWeights: ml?.hybridWeights,
              oofMinCoverageSoft: ml?.oofMinCoverageSoft ?? 0.6,
              oofHardFloor: ml?.oofHardFloor ?? 0.25,
              softFailMaxWeight: ml?.softFailMaxWeight ?? 0.15,
              tscvGapBars: ml?.tscvGapBars ?? 2,
              testLockRatio: ml?.testLockRatio ?? 0.1,
              calibrationMethod: ml?.calibrationMethod ?? "sigmoid",
              riskClampOnSoftStatWarn: ml?.riskClampOnSoftStatWarn ?? 0.35,
            });
            mlSignal = {
              available: true,
              direction: mlResult.prediction.direction,
              confidence: Number(mlResult.prediction.confidence.toFixed(4)),
              expectedReturnPct: Number(
                mlResult.prediction.expectedReturnPct.toFixed(4)
              ),
              actionable: computeMlActionable(mlResult),
              modelCount: mlResult.modelsUsed.length,
              ensembleMode: mlResult.trainingConfig?.ensembleMode as
                | "stacking"
                | "regime_moe"
                | undefined,
              currentRegime: mlResult.regimeSummary?.currentRegime,
              hybridGlobalWinner: mlResult.hybridScore?.globalWinner?.model,
              softFailModels: mlResult.oofQuality?.softFailModels ?? [],
              hardDroppedModels: mlResult.oofQuality?.hardDroppedModels ?? [],
            };
          } catch (err) {
            mlSignal = {
              available: false,
              direction: "hold",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        const releaseGateStatus = await loadReleaseGateStatus(
          releaseGateStatusPath
        );
        const ensembleScore =
          typeof strategyDecision.indicators?.ensembleScore === "number"
            ? strategyDecision.indicators.ensembleScore
            : Number(
                (strategyDecision.signal * selection.selected.strength).toFixed(
                  4
                )
              );

        const baseMinCompositeScore = policy?.minCompositeScore ?? 0.2;
        const decision = evaluateExpertDecision({
          symbol,
          strategy: {
            signal: strategyDecision.signal,
            reason: `${strategyDecision.reason} [${selection.reason}] [regime=${regimeSnapshot.regimeId}]`,
            ensembleScore,
          },
          ml: mlSignal,
          news: newsImpact,
          releaseGateStatus,
          policy: {
            ...(policy ?? {}),
            requireReleaseGatePass,
            minCompositeScore: clamp(
              baseMinCompositeScore +
                regimeSnapshot.thresholdProfile.minCompositeScoreBump,
              0.05,
              1,
            ),
          },
        });
        const scaledExposurePct = Number(
          (
            decision.suggestedExposurePct *
            regimeSnapshot.thresholdProfile.maxExposureScale
          ).toFixed(2),
        );

        const artifact = {
          symbol,
          generatedAt: now.toISOString(),
          lookbackBars: candles.length,
          window: {
            from: candles[0].time,
            to: candles[candles.length - 1].time,
          },
          strategy: {
            selectedStrategy: selection.selected.strategy,
            selectorMode: strategySelection,
            selectorReason: selection.reason,
            selectorThreshold: strategySwitchThreshold,
            selectorMargin: strategySwitchMargin,
            signal: strategyDecision.signal,
            reason: strategyDecision.reason,
            ensembleScore,
            indicators: strategyDecision.indicators,
            candidates: (eligibleStrategyCandidates.length > 0
              ? eligibleStrategyCandidates
              : strategyCandidates
            ).map(item => ({
              strategy: item.strategy,
              signal: item.decision.signal,
              strength: item.strength,
              reason: item.decision.reason,
            })),
          },
          regimeSnapshot,
          ml: mlSignal ?? {
            available: false,
            direction: "hold" as const,
            error: "ml_disabled",
          },
          modelSignal:
            mlSignal && mlSignal.available
              ? buildModelSignalArtifact({
                  generatedAt: now.toISOString(),
                  modelId:
                    mlSignal.hybridGlobalWinner ??
                    `ensemble:${mlSignal.ensembleMode ?? "unknown"}`,
                  symbol,
                  direction: mlSignal.direction,
                  confidence: mlSignal.confidence ?? 0,
                  expectedReturnPct: mlSignal.expectedReturnPct ?? 0,
                  applicableRegimes: [regimeSnapshot.regimeId],
                  invalidationReasons: mlSignal.actionable === false
                    ? ["ml_marked_non_actionable"]
                    : [],
                })
              : null,
          news: {
            ...newsImpact,
            latestHeadlines: news.slice(-5).map(item => ({
              time: item.time.toISOString(),
              title: item.title,
            })),
          },
          releaseGate: releaseGateStatus
            ? {
                generatedAt: releaseGateStatus.generatedAt,
                allowPaperTrading: releaseGateStatus.allowPaperTrading,
                allowLiveTrading: releaseGateStatus.allowLiveTrading,
                failedChecks: releaseGateStatus.failedChecks,
                warningChecks: releaseGateStatus.warningChecks,
                expiresAt: releaseGateStatus.expiresAt,
              }
            : null,
          decision: {
            ...decision,
            suggestedExposurePct: scaledExposurePct,
            reasons: [
              ...decision.reasons,
              `Regime ${regimeSnapshot.regimeId} exposureScale=${regimeSnapshot.thresholdProfile.maxExposureScale.toFixed(2)} minCompositeScoreBump=${regimeSnapshot.thresholdProfile.minCompositeScoreBump.toFixed(2)}.`,
            ],
          },
        };

        return {
          ...artifact,
          researchDecision: buildResearchDecisionV1FromExpertQuantArtifact(
            artifact,
          ),
        };
      },
    }),
  };
}
