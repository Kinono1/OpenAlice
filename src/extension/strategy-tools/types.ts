import type { MarketData } from "../analysis-kit/data/interfaces.js";

export type StrategyName =
  | "trend"
  | "regimeTrend"
  | "meanReversion"
  | "breakout"
  | "ensemble";
export type PositionSignal = -1 | 0 | 1;
export type StrategyRegimeLabel =
  | "HighVolTrend"
  | "HighVolMeanRevert"
  | "LowVolTrend"
  | "LowVolCarry";

export interface StrategyEnsembleWeights {
  trend?: number;
  meanReversion?: number;
  breakout?: number;
}

export interface StrategyParams {
  allowShort?: boolean;

  trendFastPeriod?: number;
  trendSlowPeriod?: number;
  trendConfirmBars?: number;
  trendMinDiffPct?: number;
  regimeVolWindow?: number;
  regimeAtrPeriod?: number;
  regimeFastPeriod?: number;
  regimeSlowPeriod?: number;
  allowedEntryRegimes?: StrategyRegimeLabel[];
  exitOnRegimeMismatch?: boolean;

  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  bbPeriod?: number;
  bbStdDev?: number;

  breakoutPeriod?: number;
  breakoutExitPeriod?: number;

  ensembleThreshold?: number;
  ensembleWeights?: StrategyEnsembleWeights;
}

export interface StrategyDecision {
  strategy: StrategyName;
  signal: PositionSignal;
  reason: string;
  indicators: Record<string, number>;
}

export interface StrategyEvaluationInput {
  candles: MarketData[];
  index: number;
  currentPosition: PositionSignal;
  params?: StrategyParams;
}

export interface ResolvedStrategyParams {
  allowShort: boolean;
  trendFastPeriod: number;
  trendSlowPeriod: number;
  trendConfirmBars: number;
  trendMinDiffPct: number;
  regimeVolWindow: number;
  regimeAtrPeriod: number;
  regimeFastPeriod: number;
  regimeSlowPeriod: number;
  allowedEntryRegimes: StrategyRegimeLabel[];
  exitOnRegimeMismatch: boolean;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  bbPeriod: number;
  bbStdDev: number;
  breakoutPeriod: number;
  breakoutExitPeriod: number;
  ensembleThreshold: number;
  ensembleWeights: {
    trend: number;
    meanReversion: number;
    breakout: number;
  };
}

export const DEFAULT_STRATEGY_PARAMS: ResolvedStrategyParams = {
  allowShort: true,
  trendFastPeriod: 20,
  trendSlowPeriod: 50,
  trendConfirmBars: 1,
  trendMinDiffPct: 0,
  regimeVolWindow: 20,
  regimeAtrPeriod: 14,
  regimeFastPeriod: 12,
  regimeSlowPeriod: 48,
  allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
  exitOnRegimeMismatch: true,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  bbPeriod: 20,
  bbStdDev: 2,
  breakoutPeriod: 20,
  breakoutExitPeriod: 10,
  ensembleThreshold: 0.34,
  ensembleWeights: {
    trend: 1,
    meanReversion: 1,
    breakout: 1,
  },
};
