import type { MarketData } from "../analysis-kit/data/interfaces.js";

export type MlEnsembleModelName =
  | "xgboost"
  | "lightgbm"
  | "catboost"
  | "randomForest"
  | "ridge"
  | "pytorch";

export type MlEnsembleMode = "stacking" | "regime_moe";
export type MlRegimeMethod = "rule" | "kmeans";
export type MlCalibrationMethod = "none" | "sigmoid" | "isotonic";

export interface MlHybridWeights {
  accuracyLift?: number;
  robustCostAwareUtility?: number;
  netSharpeAfterCost?: number;
  rmsePct?: number;
  winRateAfterCost?: number;
  turnoverPerBar?: number;
}

export interface MlMetrics {
  directionAccuracy: number;
  baselineDirectionAccuracy: number;
  accuracyLift: number;
  auc: number | null;
  maePct: number;
  rmsePct: number;
  testUpRate: number;
  testSamples: number;
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
}

export interface MlEnsemblePredictInput {
  candles: MarketData[];
  horizonBars?: number;
  trainRatio?: number;
  includeModels?: MlEnsembleModelName[];
  minConfidence?: number;
  minExpectedReturnPct?: number;
  seed?: number;
  modelSelectionMetric?: string;
  modelSelectionMode?: "auto" | "max" | "min";
  ensembleMode?: MlEnsembleMode;
  regimeCount?: 3 | 4;
  regimeMethod?: MlRegimeMethod;
  hybridWeights?: MlHybridWeights;
  oofMinCoverageSoft?: number;
  oofHardFloor?: number;
  softFailMaxWeight?: number;
  tscvGapBars?: number;
  testLockRatio?: number;
  calibrationMethod?: MlCalibrationMethod;
  riskClampOnSoftStatWarn?: number;
  labelingMode?: "next_return_sign" | "triple_barrier";
  barrierTakeProfitAtr?: number;
  barrierStopLossAtr?: number;
  barrierMaxHorizonBars?: number;
  costFeeRate?: number;
  costSlippageBps?: number;
  costLatencyBars?: number;
  robustPerBarClip?: number;
  nasEnabled?: boolean;
  nasTrials?: number;
  nasMetric?: string;
  nasMode?: "auto" | "max" | "min";
}

export interface MlEnsemblePredictResult {
  dataset: {
    samples: number;
    featureCount: number;
    trainSize: number;
    validationSize?: number;
    testSize: number;
    fromTime: number;
    toTime: number;
    latestTime: number;
    horizonBars: number;
    featureNames: string[];
    labeling?: {
      mode: string;
      horizonBars: number;
      avgLabelHorizonBars: number;
      labelDistribution: {
        positiveRate: number;
        tpRate: number;
        slRate: number;
        timeoutRate: number;
        horizonRate: number;
      };
      barrier?: {
        takeProfitAtr: number;
        stopLossAtr: number;
        maxHorizonBars: number;
      };
    };
  };
  modelsRequested: MlEnsembleModelName[];
  modelsUsed: string[];
  droppedModels: Array<{ model: string; reason: string }>;
  intermediateModels?: Array<{
    model: string;
    metrics: MlMetrics;
    lockedTestMetrics?: MlMetrics;
    latest: {
      pUp: number;
      expectedReturnPct: number;
    };
    stackingMetaTrain?: {
      mode: string;
      coverage: number;
      state?: string;
      gapBars?: number;
      gapCount?: number;
      gaps?: Array<{
        fold: number;
        trainEnd: number;
        valStart: number;
        gapBars: number;
      }>;
      softCapped?: boolean;
    };
    objectiveScore: number | null;
  }>;
  modelSelection?: {
    metric: string;
    mode: "max" | "min";
    bestModel: string;
    bestScore: number | null;
    ranking: Array<{
      model: string;
      objectiveScore: number | null;
      metrics: MlMetrics;
      lockedTestMetrics?: MlMetrics;
      latest: {
        pUp: number;
        expectedReturnPct: number;
      };
    }>;
  };
  prediction: {
    direction: "buy" | "sell" | "hold";
    pUp: number;
    confidence: number;
    expectedReturnPct: number;
    baseModelVotes: Record<
      string,
      {
        pUp: number;
        expectedReturnPct: number;
      }
    >;
    weightedBaseVotes?: Record<
      string,
      {
        weight: number;
        pUp: number;
        expectedReturnPct: number;
        state?: string;
      }
    >;
    thresholds: {
      minConfidence: number;
      minExpectedReturnPct: number;
    };
  };
  metrics: MlMetrics;
  validationMetrics?: MlMetrics;
  regimeSummary?: {
    detectorMethod: string;
    regimeDistributionTrain: Record<string, number>;
    regimeDistributionTest: Record<string, number>;
    currentRegime: string;
  };
  hybridScore?: {
    weights: Required<MlHybridWeights>;
    perModel: Record<string, number>;
    perRegimeWinner: Record<
      string,
      {
        winner?: string | null;
        runnerUp?: string | null;
        winnerScore?: number | null;
        runnerUpScore?: number | null;
        sampleCount?: number;
      }
    >;
    globalWinner: {
      model: string;
      score: number;
    };
  };
  oofQuality?: {
    coveragePerModel: Record<
      string,
      {
        coverage: number;
        state: string;
        softCapped: boolean;
        gapCount: number;
        gaps: Array<{
          fold: number;
          trainEnd: number;
          valStart: number;
          gapBars: number;
        }>;
      }
    >;
    softFailModels: string[];
    hardDroppedModels: string[];
  };
  selectionAudit?: {
    trainWindow: { fromTime: number | null; toTime: number | null; size: number };
    validationWindow: {
      fromTime: number | null;
      toTime: number | null;
      size: number;
    };
    lockedTestWindow: {
      fromTime: number | null;
      toTime: number | null;
      size: number;
    };
    forbiddenDataUsageViolations: string[];
  };
  releaseGateDecision?: {
    hardBlocks: string[];
    softWarnings: string[];
    riskClampApplied: boolean;
    maxAllocAfterClamp: number;
  };
  trainingConfig?: Record<string, unknown>;
}
