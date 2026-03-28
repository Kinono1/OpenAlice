import type { MarketData } from "../analysis-kit/data/interfaces.js";

export type StrategyName =
  | "trend"
  | "meanReversion"
  | "breakout"
  | "ensemble"
  | "volBreakout"
  | "volNoTradeFilter"
  | "volTrend";
export type PositionSignal = -1 | 0 | 1;

export interface StrategyEnsembleWeights {
  trend?: number;
  meanReversion?: number;
  breakout?: number;
}

export interface StrategyParams {
  allowShort?: boolean;

  trendFastPeriod?: number;
  trendSlowPeriod?: number;

  rsiPeriod?: number;
  rsiOversold?: number;
  rsiOverbought?: number;
  bbPeriod?: number;
  bbStdDev?: number;

  breakoutPeriod?: number;
  breakoutExitPeriod?: number;
  volWindowBars?: number;
  volBaselineBars?: number;
  volTriggerRatio?: number;
  volCooldownBars?: number;

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
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  bbPeriod: number;
  bbStdDev: number;
  breakoutPeriod: number;
  breakoutExitPeriod: number;
  volWindowBars: number;
  volBaselineBars: number;
  volTriggerRatio: number;
  volCooldownBars: number;
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
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  bbPeriod: 20,
  bbStdDev: 2,
  breakoutPeriod: 20,
  breakoutExitPeriod: 10,
  volWindowBars: 60,
  volBaselineBars: 240,
  volTriggerRatio: 1.5,
  volCooldownBars: 0,
  ensembleThreshold: 0.34,
  ensembleWeights: {
    trend: 1,
    meanReversion: 1,
    breakout: 1,
  },
};
