import type { MarketData } from "../analysis-kit/data/interfaces.js";
import {
  evaluateStrategy,
  getStrategyMinimumBars,
  resolveStrategyParams,
} from "./strategies.js";
import type {
  PositionSignal,
  StrategyDecision,
  StrategyName,
  StrategyParams,
} from "./types.js";

export interface BacktestCostModel {
  feeRate: number;
  slippageBps: number;
  latencyBars: number;
  fundingRatePer8h: number;
}

export interface BacktestTrade {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  rawReturnPct: number;
  netReturnPct: number;
}

export interface BacktestMetrics {
  initialCapital: number;
  finalEquity: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
  winRatePct: number;
  profitFactor: number;
  tradeCount: number;
  totalFeesPaid: number;
  totalSlippagePaid: number;
  totalFundingPaid: number;
}

export interface BacktestResult {
  strategy: StrategyName;
  params: Required<StrategyParams>;
  costModel: BacktestCostModel;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: Array<{ time: number; equity: number }>;
  lastDecision: StrategyDecision;
}

export interface StrategyBacktestInput {
  strategy: StrategyName;
  candles: MarketData[];
  params?: StrategyParams;
  initialCapital?: number;
  costModel?: Partial<BacktestCostModel>;
}

interface ActiveTrade {
  direction: "long" | "short";
  entryTime: number;
  entryPrice: number;
}

const DEFAULT_COST_MODEL: BacktestCostModel = {
  feeRate: 0.0005,
  slippageBps: 3,
  latencyBars: 1,
  fundingRatePer8h: 0,
};

function toExecutionPrice(
  close: number,
  delta: number,
  slippageRate: number
): number {
  if (delta > 0) {
    // Buy side pays the ask
    return close * (1 + slippageRate);
  }
  if (delta < 0) {
    // Sell side hits the bid
    return close * (1 - slippageRate);
  }
  return close;
}

function assertValidCandles(candles: MarketData[]): MarketData[] {
  if (!Array.isArray(candles) || candles.length < 3) {
    throw new Error("Backtest requires at least 3 candles.");
  }
  const sorted = [...candles].sort((a, b) => a.time - b.time);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].time <= sorted[i - 1].time) {
      throw new Error("Candles must have strictly increasing timestamps.");
    }
  }
  return sorted;
}

function toRequiredParams(
  params: StrategyParams | undefined
): Required<StrategyParams> {
  const r = resolveStrategyParams(params);
  return {
    allowShort: r.allowShort,
    trendFastPeriod: r.trendFastPeriod,
    trendSlowPeriod: r.trendSlowPeriod,
    rsiPeriod: r.rsiPeriod,
    rsiOversold: r.rsiOversold,
    rsiOverbought: r.rsiOverbought,
    bbPeriod: r.bbPeriod,
    bbStdDev: r.bbStdDev,
    breakoutPeriod: r.breakoutPeriod,
    breakoutExitPeriod: r.breakoutExitPeriod,
    volWindowBars: r.volWindowBars,
    volBaselineBars: r.volBaselineBars,
    volTriggerRatio: r.volTriggerRatio,
    volCooldownBars: r.volCooldownBars,
    ensembleThreshold: r.ensembleThreshold,
    ensembleWeights: r.ensembleWeights,
  };
}

function closeTrade(
  activeTrade: ActiveTrade,
  exitTime: number,
  exitPrice: number,
  sidePosition: PositionSignal,
  roundTripCostRate: number
): BacktestTrade {
  const directionMultiplier = sidePosition === 1 ? 1 : -1;
  const rawReturn =
    directionMultiplier *
    ((exitPrice - activeTrade.entryPrice) / activeTrade.entryPrice);
  return {
    direction: activeTrade.direction,
    entryTime: activeTrade.entryTime,
    entryPrice: activeTrade.entryPrice,
    exitTime,
    exitPrice,
    rawReturnPct: rawReturn * 100,
    netReturnPct: (rawReturn - roundTripCostRate) * 100,
  };
}

export function runStrategyBacktest(
  input: StrategyBacktestInput
): BacktestResult {
  const candles = assertValidCandles(input.candles);
  const params = toRequiredParams(input.params);
  const minBars = getStrategyMinimumBars(input.strategy, params);
  if (candles.length < minBars + 2) {
    throw new Error(
      `Not enough candles for ${input.strategy}: requires >= ${minBars + 2}, got ${candles.length}.`
    );
  }

  const costModel: BacktestCostModel = {
    ...DEFAULT_COST_MODEL,
    ...(input.costModel ?? {}),
    latencyBars: Math.max(
      0,
      Math.floor(input.costModel?.latencyBars ?? DEFAULT_COST_MODEL.latencyBars)
    ),
  };
  const feeRate = Math.max(0, costModel.feeRate);
  const slippageRate = Math.max(0, costModel.slippageBps) / 10_000;

  let equity = input.initialCapital ?? 10_000;
  const initialCapital = equity;
  let peak = equity;
  let maxDrawdown = 0;

  let position: PositionSignal = 0;
  let activeTrade: ActiveTrade | null = null;
  let roundTripCostRate = 0;

  let totalFeesPaid = 0;
  let totalSlippagePaid = 0;
  let totalFundingPaid = 0;

  const pendingSignals = new Map<number, PositionSignal>();
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ time: number; equity: number }> = [
    { time: candles[0].time, equity },
  ];

  const stepReturns: number[] = [];
  let lastDecision: StrategyDecision = {
    strategy: input.strategy,
    signal: 0,
    reason: "No decision yet.",
    indicators: {},
  };

  const barSeconds =
    candles.length > 1 ? candles[1].time - candles[0].time : 3600;
  const fundingPerBar = costModel.fundingRatePer8h * (barSeconds / (8 * 3600));
  let liquidated = false;

  for (let i = 1; i < candles.length; i++) {
    const barStart = candles[i - 1];
    const barEnd = candles[i];

    const queuedSignal = pendingSignals.get(i);
    if (queuedSignal !== undefined && queuedSignal !== position) {
      const prevPosition = position;
      position = queuedSignal;

      const delta = position - prevPosition;
      const feeCost = equity * Math.abs(delta) * feeRate;
      const slippageCost = equity * Math.abs(delta) * slippageRate;
      totalFeesPaid += feeCost;
      totalSlippagePaid += slippageCost;
      equity -= feeCost + slippageCost;
      roundTripCostRate += Math.abs(delta) * (feeRate + slippageRate);

      const executionPrice = toExecutionPrice(
        barStart.close,
        delta,
        slippageRate
      );

      if (
        prevPosition !== 0 &&
        (position === 0 || Math.sign(position) !== Math.sign(prevPosition))
      ) {
        if (activeTrade) {
          trades.push(
            closeTrade(
              activeTrade,
              barStart.time,
              executionPrice,
              prevPosition,
              roundTripCostRate
            )
          );
        }
        activeTrade = null;
        roundTripCostRate = 0;
      }

      if (
        position !== 0 &&
        (prevPosition === 0 || Math.sign(position) !== Math.sign(prevPosition))
      ) {
        activeTrade = {
          direction: position === 1 ? "long" : "short",
          entryTime: barStart.time,
          entryPrice: executionPrice,
        };
      }
    }

    const priceReturn = (barEnd.close - barStart.close) / barStart.close;
    const grossReturn = position * priceReturn;
    const fundingReturn = position !== 0 ? -(position * fundingPerBar) : 0;
    if (fundingReturn < 0) totalFundingPaid += Math.abs(equity * fundingReturn);
    const netReturn = grossReturn + fundingReturn;

    const nextEquity = equity * (1 + netReturn);
    if (!Number.isFinite(nextEquity) || nextEquity <= 0) {
      // Treat non-finite / below-zero equity as liquidation and stop compounding.
      equity = 0;
      stepReturns.push(-1);
      maxDrawdown = Math.max(maxDrawdown, 1);
      equityCurve.push({ time: barEnd.time, equity });
      activeTrade = null;
      position = 0;
      roundTripCostRate = 0;
      liquidated = true;
      break;
    }

    equity = nextEquity;

    stepReturns.push(netReturn);
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
    equityCurve.push({ time: barEnd.time, equity });

    lastDecision = evaluateStrategy({
      strategy: input.strategy,
      candles,
      index: i,
      currentPosition: position,
      params,
    });
    const executeAt = i + 1 + costModel.latencyBars;
    if (executeAt < candles.length) {
      pendingSignals.set(executeAt, lastDecision.signal);
    }
  }

  if (activeTrade && !liquidated) {
    const last = candles[candles.length - 1];
    trades.push(
      closeTrade(
        activeTrade,
        last.time,
        last.close,
        position,
        roundTripCostRate
      )
    );
  }

  const totalReturn = equity / initialCapital - 1;
  const totalYears =
    (candles[candles.length - 1].time - candles[0].time) / (365 * 24 * 3600);
  const annualized =
    totalYears > 0
      ? Math.pow(Math.max(1 + totalReturn, 0.000_001), 1 / totalYears) - 1
      : totalReturn;

  const meanStep =
    stepReturns.length > 0
      ? stepReturns.reduce((sum, x) => sum + x, 0) / stepReturns.length
      : 0;
  const stdStep =
    stepReturns.length > 1
      ? Math.sqrt(
          stepReturns.reduce((sum, x) => sum + (x - meanStep) ** 2, 0) /
            stepReturns.length
        )
      : 0;
  const periodsPerYear = barSeconds > 0 ? (365 * 24 * 3600) / barSeconds : 0;
  const sharpe =
    stdStep > 0 && periodsPerYear > 0
      ? (meanStep / stdStep) * Math.sqrt(periodsPerYear)
      : 0;

  const wins = trades.filter(t => t.netReturnPct > 0).length;
  const grossProfit = trades
    .map(t => t.netReturnPct)
    .filter(x => x > 0)
    .reduce((sum, x) => sum + x, 0);
  const grossLoss = trades
    .map(t => t.netReturnPct)
    .filter(x => x < 0)
    .reduce((sum, x) => sum + Math.abs(x), 0);
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;

  return {
    strategy: input.strategy,
    params,
    costModel,
    trades,
    equityCurve,
    lastDecision,
    metrics: {
      initialCapital,
      finalEquity: equity,
      totalReturnPct: totalReturn * 100,
      annualizedReturnPct: annualized * 100,
      maxDrawdownPct: maxDrawdown * 100,
      sharpe,
      winRatePct: trades.length > 0 ? (wins / trades.length) * 100 : 0,
      profitFactor,
      tradeCount: trades.length,
      totalFeesPaid,
      totalSlippagePaid,
      totalFundingPaid,
    },
  };
}
