import { tool } from "ai";
import { z } from "zod";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import { runMlEnsemblePredict } from "./python-runner.js";
import type { MlEnsembleModelName } from "./types.js";

const MODEL_NAMES: MlEnsembleModelName[] = [
  "xgboost",
  "lightgbm",
  "catboost",
  "randomForest",
  "ridge",
  "pytorch",
];

const EnsembleModelSchema = z.enum([
  "xgboost",
  "lightgbm",
  "catboost",
  "randomForest",
  "ridge",
  "pytorch",
]);
const EnsembleModeSchema = z.enum(["stacking", "regime_moe"]);
const RegimeMethodSchema = z.enum(["rule", "kmeans"]);
const CalibrationMethodSchema = z.enum(["none", "sigmoid", "isotonic"]);

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

function formatMetrics(metrics: {
  directionAccuracy: number;
  baselineDirectionAccuracy: number;
  accuracyLift: number;
  auc: number | null;
  maePct: number;
  rmsePct: number;
  costAwareUtility: number;
  netSharpeAfterCost: number;
  netReturnPctAfterCost: number;
  grossReturnPctBeforeCost: number;
  turnoverPerBar: number;
  tradeCount: number;
  winRateAfterCost: number;
  robustCostAwareUtility: number;
  robustSharpeAfterCost: number;
  robustSortinoAfterCost: number;
  robustAnnualizedReturnPctAfterCost: number;
}) {
  return {
    directionAccuracyPct: Number((metrics.directionAccuracy * 100).toFixed(2)),
    baselineDirectionAccuracyPct: Number(
      (metrics.baselineDirectionAccuracy * 100).toFixed(2)
    ),
    accuracyLiftPct: Number((metrics.accuracyLift * 100).toFixed(2)),
    auc: metrics.auc === null ? null : Number(metrics.auc.toFixed(4)),
    maePct: Number(metrics.maePct.toFixed(4)),
    rmsePct: Number(metrics.rmsePct.toFixed(4)),
    costAwareUtility: Number(metrics.costAwareUtility.toFixed(6)),
    netSharpeAfterCost: Number(metrics.netSharpeAfterCost.toFixed(4)),
    netReturnPctAfterCost: Number(metrics.netReturnPctAfterCost.toFixed(4)),
    grossReturnPctBeforeCost: Number(
      metrics.grossReturnPctBeforeCost.toFixed(4)
    ),
    turnoverPerBar: Number(metrics.turnoverPerBar.toFixed(6)),
    tradeCount: Number(metrics.tradeCount.toFixed(2)),
    winRateAfterCostPct: Number((metrics.winRateAfterCost * 100).toFixed(2)),
    robustCostAwareUtility: Number(metrics.robustCostAwareUtility.toFixed(6)),
    robustSharpeAfterCost: Number(metrics.robustSharpeAfterCost.toFixed(4)),
    robustSortinoAfterCost: Number(metrics.robustSortinoAfterCost.toFixed(4)),
    robustAnnualizedReturnPctAfterCost: Number(
      metrics.robustAnnualizedReturnPctAfterCost.toFixed(4)
    ),
  };
}

export function createMlEnsembleTools(ctx: IAnalysisContext) {
  return {
    mlEnsemblePredict: tool({
      description: `
Run ML Ensemble V1 for crypto prediction using:
- XGBoost
- LightGBM
- CatBoost
- RandomForest
- Ridge/Logistic baseline
- PyTorch MLP

It trains on recent candles, reports test-set accuracy metrics, and returns
the latest predicted direction with confidence.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USD"'),
        lookbackBars: z
          .number()
          .int()
          .min(300)
          .max(20_000)
          .default(2000)
          .describe("How many recent candles to load for training/testing"),
        horizonBars: z
          .number()
          .int()
          .min(1)
          .max(24)
          .default(1)
          .describe("Prediction horizon in bars"),
        trainRatio: z
          .number()
          .min(0.5)
          .max(0.95)
          .default(0.8)
          .describe("Train/test split ratio"),
        includeModels: z
          .array(EnsembleModelSchema)
          .min(1)
          .max(6)
          .optional()
          .describe("Subset of models to use. Defaults to all V1 models."),
        minConfidence: z
          .number()
          .min(0.5)
          .max(0.9)
          .default(0.55)
          .describe("Minimum confidence threshold for actionable buy/sell"),
        minExpectedReturnPct: z
          .number()
          .min(0)
          .max(20)
          .default(0.03)
          .describe(
            "Minimum expected return percentage for actionable signals"
          ),
        seed: z.number().int().default(42),
        modelSelectionMetric: z
          .string()
          .default("accuracyLift")
          .describe(
            "Objective metric for selecting the best intermediate model"
          ),
        modelSelectionMode: z
          .enum(["auto", "max", "min"])
          .default("auto")
          .describe("Selection direction for objective metric"),
        ensembleMode: EnsembleModeSchema
          .default("regime_moe")
          .describe("Main ensemble mode: stacking or regime-based MoE"),
        regimeCount: z
          .union([z.literal(3), z.literal(4)])
          .default(3)
          .describe("Number of regimes used by regime_moe"),
        regimeMethod: RegimeMethodSchema
          .default("rule")
          .describe("Regime detector method: rule or kmeans"),
        hybridWeights: z
          .object({
            accuracyLift: z.number().min(0).default(0.2),
            robustCostAwareUtility: z.number().min(0).default(0.3),
            netSharpeAfterCost: z.number().min(0).default(0.2),
            rmsePct: z.number().min(0).default(0.1),
            winRateAfterCost: z.number().min(0).default(0.1),
            turnoverPerBar: z.number().min(0).default(0.1),
          })
          .default({
            accuracyLift: 0.2,
            robustCostAwareUtility: 0.3,
            netSharpeAfterCost: 0.2,
            rmsePct: 0.1,
            winRateAfterCost: 0.1,
            turnoverPerBar: 0.1,
          })
          .describe("Hybrid score weights used for model ranking/routing"),
        oofMinCoverageSoft: z
          .number()
          .min(0.2)
          .max(0.95)
          .default(0.6)
          .describe("OOF coverage threshold that marks model as soft-fail"),
        oofHardFloor: z
          .number()
          .min(0.05)
          .max(0.9)
          .default(0.25)
          .describe("OOF coverage threshold that hard-drops a model"),
        softFailMaxWeight: z
          .number()
          .min(0)
          .max(1)
          .default(0.15)
          .describe("Maximum routing weight for soft-fail models"),
        tscvGapBars: z
          .number()
          .int()
          .min(0)
          .max(20)
          .default(2)
          .describe("Gap bars between train and validation folds in OOF"),
        testLockRatio: z
          .number()
          .min(0.05)
          .max(0.3)
          .default(0.1)
          .describe("Locked test ratio kept out of model selection"),
        calibrationMethod: CalibrationMethodSchema
          .default("sigmoid")
          .describe("Probability calibration method on validation set"),
        riskClampOnSoftStatWarn: z
          .number()
          .min(0.05)
          .max(1)
          .default(0.35)
          .describe(
            "Max allocation cap applied when soft statistical gate warnings trigger"
          ),
        labelingMode: z
          .enum(["next_return_sign", "triple_barrier"])
          .default("next_return_sign")
          .describe("Labeling mode for classification/regression targets"),
        barrierTakeProfitAtr: z
          .number()
          .min(0.1)
          .max(10)
          .default(1.5)
          .describe(
            "TP barrier width (ATR multiplier) for triple-barrier labeling"
          ),
        barrierStopLossAtr: z
          .number()
          .min(0.1)
          .max(10)
          .default(1.0)
          .describe(
            "SL barrier width (ATR multiplier) for triple-barrier labeling"
          ),
        barrierMaxHorizonBars: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(6)
          .describe("Max holding bars for triple-barrier labeling"),
        costFeeRate: z
          .number()
          .min(0)
          .max(0.05)
          .default(0.0006)
          .describe("Fee rate used in cost-aware objective"),
        costSlippageBps: z
          .number()
          .min(0)
          .max(200)
          .default(8)
          .describe("Slippage bps used in cost-aware objective"),
        costLatencyBars: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(1)
          .describe("Latency bars used in cost-aware objective"),
        robustPerBarClip: z
          .number()
          .min(0.01)
          .max(0.5)
          .default(0.25)
          .describe("Per-bar return clip used by robust cost-aware objective"),
        nasEnabled: z
          .boolean()
          .default(false)
          .describe("Enable NAS-like model hyperparameter search"),
        nasTrials: z
          .number()
          .int()
          .min(1)
          .max(6)
          .default(2)
          .describe("Candidate trial count per model when NAS is enabled"),
        nasMetric: z
          .string()
          .default("costAwareUtility")
          .describe("Objective metric for NAS candidate selection"),
        nasMode: z
          .enum(["auto", "max", "min"])
          .default("auto")
          .describe("NAS objective optimization mode"),
      }),
      execute: async ({
        symbol,
        lookbackBars,
        horizonBars,
        trainRatio,
        includeModels,
        minConfidence,
        minExpectedReturnPct,
        seed,
        modelSelectionMetric,
        modelSelectionMode,
        ensembleMode,
        regimeCount,
        regimeMethod,
        hybridWeights,
        oofMinCoverageSoft,
        oofHardFloor,
        softFailMaxWeight,
        tscvGapBars,
        testLockRatio,
        calibrationMethod,
        riskClampOnSoftStatWarn,
        labelingMode,
        barrierTakeProfitAtr,
        barrierStopLossAtr,
        barrierMaxHorizonBars,
        costFeeRate,
        costSlippageBps,
        costLatencyBars,
        robustPerBarClip,
        nasEnabled,
        nasTrials,
        nasMetric,
        nasMode,
      }) => {
        const candles = await loadCandles(ctx, symbol, lookbackBars);
        const result = await runMlEnsemblePredict({
          candles,
          horizonBars,
          trainRatio,
          includeModels: includeModels ?? MODEL_NAMES,
          minConfidence,
          minExpectedReturnPct,
          seed,
          modelSelectionMetric,
          modelSelectionMode,
          ensembleMode,
          regimeCount,
          regimeMethod,
          hybridWeights,
          oofMinCoverageSoft,
          oofHardFloor,
          softFailMaxWeight,
          tscvGapBars,
          testLockRatio,
          calibrationMethod,
          riskClampOnSoftStatWarn,
          labelingMode,
          barrierTakeProfitAtr,
          barrierStopLossAtr,
          barrierMaxHorizonBars,
          costFeeRate,
          costSlippageBps,
          costLatencyBars,
          robustPerBarClip,
          nasEnabled,
          nasTrials,
          nasMetric,
          nasMode,
        });
        return {
          symbol,
          lookbackBars: candles.length,
          from: candles[0].time,
          to: candles[candles.length - 1].time,
          modelsRequested: result.modelsRequested,
          modelsUsed: result.modelsUsed,
          droppedModels: result.droppedModels,
          modelSelection: result.modelSelection ?? null,
          prediction: {
            ...result.prediction,
            pUp: Number(result.prediction.pUp.toFixed(4)),
            confidence: Number(result.prediction.confidence.toFixed(4)),
            expectedReturnPct: Number(
              result.prediction.expectedReturnPct.toFixed(4)
            ),
          },
          metrics: formatMetrics(result.metrics),
          validationMetrics: result.validationMetrics
            ? formatMetrics(result.validationMetrics)
            : null,
          regimeSummary: result.regimeSummary ?? null,
          hybridScore: result.hybridScore ?? null,
          oofQuality: result.oofQuality ?? null,
          selectionAudit: result.selectionAudit ?? null,
          releaseGateDecision: result.releaseGateDecision ?? null,
          dataset: {
            samples: result.dataset.samples,
            featureCount: result.dataset.featureCount,
            trainSize: result.dataset.trainSize,
            validationSize: result.dataset.validationSize ?? null,
            testSize: result.dataset.testSize,
            horizonBars: result.dataset.horizonBars,
            labeling: result.dataset.labeling ?? null,
          },
        };
      },
    }),
  };
}
