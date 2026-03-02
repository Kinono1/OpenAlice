import { tool } from "ai";
import { z } from "zod";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import { runStrategyWalkForward } from "../../backtest/wfo.js";
import { evaluateSignificanceGate } from "../../backtest/statistical_significance.js";
import { allocateInverseVolatilityPortfolio } from "../../portfolio/allocator.js";
import { runStrategyBacktest } from "./backtest.js";
import { evaluateStrategy, getStrategyMinimumBars } from "./strategies.js";
import type { StrategyName, StrategyParams } from "./types.js";

const StrategyNameSchema = z.enum([
  "trend",
  "meanReversion",
  "breakout",
  "ensemble",
]);

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

const StrategyParamsSchema = StrategyParamsObjectSchema.optional();

const CostModelSchema = z
  .object({
    feeRate: z.number().min(0).max(0.01).optional(),
    slippageBps: z.number().min(0).max(500).optional(),
    latencyBars: z.number().int().min(0).max(20).optional(),
    fundingRatePer8h: z.number().min(-0.05).max(0.05).optional(),
  })
  .optional();

const WfoConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    trainBars: z.number().int().min(50).max(20000).default(24 * 365),
    testBars: z.number().int().min(20).max(10000).default(24 * 90),
    stepBars: z.number().int().min(20).max(10000).optional(),
    degradationThreshold: z.number().min(-5).max(5).default(0.4),
    minTradesPerWindow: z.number().int().min(0).max(1000).default(1),
    candidates: z.array(StrategyParamsObjectSchema).min(1).max(64).optional(),
  })
  .optional();

const SignificanceConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    partitions: z.number().int().min(4).max(12).default(8),
    trialCount: z.number().int().min(2).max(10000).optional(),
    pboThreshold: z.number().min(0).max(1).default(0.2),
    dsrMin: z.number().default(0),
    candidates: z.array(StrategyParamsObjectSchema).min(2).max(64).optional(),
  })
  .optional();

const PortfolioCompareSchema = z
  .object({
    enabled: z.boolean().default(false),
    targetAnnualVolatility: z.number().positive().optional(),
    leverageCap: z.number().positive().max(10).optional(),
    correlationThreshold: z.number().min(-1).max(1).optional(),
    maxPairCombinedWeight: z.number().min(0).max(1).optional(),
  })
  .optional();

async function loadCandles(
  ctx: IAnalysisContext,
  symbol: string,
  lookbackBars: number,
): Promise<MarketData[]> {
  const endTime = ctx.getPlayheadTime();
  const startTime = ctx.calculatePreviousTime(lookbackBars);
  const rows = await ctx.marketDataProvider.getMarketDataRange(startTime, endTime, symbol);
  if (!rows.length) {
    throw new Error(`No OHLCV data found for ${symbol}.`);
  }
  return rows.sort((a, b) => a.time - b.time);
}

function summarizeBacktest(result: ReturnType<typeof runStrategyBacktest>) {
  const r = result.metrics;
  return {
    strategy: result.strategy,
    params: result.params,
    metrics: {
      totalReturnPct: Number(r.totalReturnPct.toFixed(2)),
      annualizedReturnPct: Number(r.annualizedReturnPct.toFixed(2)),
      maxDrawdownPct: Number(r.maxDrawdownPct.toFixed(2)),
      sharpe: Number(r.sharpe.toFixed(2)),
      winRatePct: Number(r.winRatePct.toFixed(2)),
      profitFactor: Number(r.profitFactor.toFixed(2)),
      tradeCount: r.tradeCount,
      totalFeesPaid: Number(r.totalFeesPaid.toFixed(2)),
      totalSlippagePaid: Number(r.totalSlippagePaid.toFixed(2)),
      totalFundingPaid: Number(r.totalFundingPaid.toFixed(2)),
      finalEquity: Number(r.finalEquity.toFixed(2)),
    },
    lastDecision: result.lastDecision,
    recentTrades: result.trades.slice(-5),
  };
}

function ensureStrategyData(
  strategy: StrategyName,
  candles: MarketData[],
  params?: StrategyParams,
): void {
  const minBars = getStrategyMinimumBars(strategy, params);
  if (candles.length < minBars + 2) {
    throw new Error(
      `${strategy} requires at least ${minBars + 2} candles, got ${candles.length}. Increase lookbackBars.`,
    );
  }
}

function equityCurveToReturns(curve: Array<{ time: number; equity: number }>): number[] {
  const out: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    const next = curve[i].equity;
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
      out.push(next / prev - 1);
    }
  }
  return out;
}

function annualizationFactorFromCandles(candles: MarketData[]): number {
  if (candles.length < 2) {
    return 365;
  }
  const barSeconds = Math.max(1, candles[1].time - candles[0].time);
  return (365 * 24 * 3600) / barSeconds;
}

function summarizeReturns(returns: number[], annualizationFactor: number) {
  if (returns.length === 0) {
    return {
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
    };
  }

  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const r of returns) {
    equity *= 1 + r;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, (peak - equity) / peak);
  }

  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => {
    const centered = value - mean;
    return sum + centered * centered;
  }, 0) / returns.length;
  const std = Math.sqrt(Math.max(variance, 0));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(annualizationFactor) : 0;

  const totalReturn = equity - 1;
  const annualized = Math.pow(Math.max(equity, 1e-9), annualizationFactor / returns.length) - 1;

  return {
    totalReturnPct: Number((totalReturn * 100).toFixed(2)),
    annualizedReturnPct: Number((annualized * 100).toFixed(2)),
    maxDrawdownPct: Number((maxDrawdown * 100).toFixed(2)),
    sharpe: Number(sharpe.toFixed(2)),
  };
}

function composePortfolioReturns(
  returnsByAsset: Record<string, number[]>,
  weights: Record<string, number>,
): number[] {
  const names = Object.keys(weights).filter((name) => returnsByAsset[name]?.length);
  if (names.length === 0) {
    return [];
  }

  const minLen = Math.min(...names.map((name) => returnsByAsset[name].length));
  if (minLen < 1) {
    return [];
  }

  const out: number[] = [];
  for (let i = 0; i < minLen; i++) {
    let step = 0;
    for (const name of names) {
      const aligned = returnsByAsset[name][returnsByAsset[name].length - minLen + i];
      step += aligned * weights[name];
    }
    out.push(step);
  }
  return out;
}

function ensureSignificanceCandidates(
  base: StrategyParams | undefined,
  explicit: StrategyParams[] | undefined,
  fromWfo: StrategyParams[] | undefined,
): StrategyParams[] {
  const source = explicit && explicit.length >= 2
    ? explicit
    : fromWfo && fromWfo.length >= 2
      ? fromWfo
      : buildFallbackCandidates(base);

  const dedup = new Map<string, StrategyParams>();
  for (const item of source) {
    const key = JSON.stringify(item ?? {});
    if (!dedup.has(key)) {
      dedup.set(key, item);
    }
  }

  if (dedup.size >= 2) {
    return [...dedup.values()];
  }

  return buildFallbackCandidates(base);
}

function buildFallbackCandidates(base: StrategyParams | undefined): StrategyParams[] {
  const baseline = base ?? {};
  const fast = Math.max(3, (baseline.trendFastPeriod ?? 20) - 5);
  const slow = Math.max(fast + 5, (baseline.trendSlowPeriod ?? 50) + 5);

  return [
    baseline,
    {
      ...baseline,
      trendFastPeriod: fast,
      trendSlowPeriod: slow,
      breakoutPeriod: (baseline.breakoutPeriod ?? 20) + 5,
    },
  ];
}

export function createStrategyTools(ctx: IAnalysisContext) {
  return {
    strategyGetSignal: tool({
      description: `
Get the latest signal from a built-in strategy (trend / meanReversion / breakout).
Also supports ensemble mode that combines these strategies with weighted voting.

Use this to make rule-based decisions before asking the LLM to place orders.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USD"'),
        strategy: StrategyNameSchema.describe("Strategy to evaluate"),
        lookbackBars: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .default(500)
          .describe("How many recent candles to load"),
        params: StrategyParamsSchema,
      }),
      execute: async ({ symbol, strategy, lookbackBars, params }) => {
        const candles = await loadCandles(ctx, symbol, lookbackBars);
        ensureStrategyData(strategy, candles, params);
        const decision = evaluateStrategy({
          strategy,
          candles,
          index: candles.length - 1,
          currentPosition: 0,
          params,
        });
        return {
          symbol,
          strategy,
          candleTime: candles[candles.length - 1].time,
          signal: decision.signal,
          action:
            decision.signal === 1
              ? "buy_or_hold_long"
              : decision.signal === -1
                ? "sell_or_hold_short"
                : "hold_flat",
          reason: decision.reason,
          indicators: decision.indicators,
        };
      },
    }),

    strategyBacktest: tool({
      description: `
Backtest one strategy on historical candles with realistic costs.

Cost model includes:
- feeRate (maker/taker approximation)
- slippageBps
- latencyBars
- fundingRatePer8h (for perpetual futures)

Optional advanced modes:
- Walk-forward validation (WFO)
- Statistical significance gates (PBO + DSR)
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USD"'),
        strategy: StrategyNameSchema,
        lookbackBars: z.number().int().min(100).max(20_000).default(2000),
        initialCapital: z.number().positive().default(10_000),
        params: StrategyParamsSchema,
        costModel: CostModelSchema,
        wfo: WfoConfigSchema,
        significance: SignificanceConfigSchema,
      }),
      execute: async ({
        symbol,
        strategy,
        lookbackBars,
        initialCapital,
        params,
        costModel,
        wfo,
        significance,
      }) => {
        const candles = await loadCandles(ctx, symbol, lookbackBars);
        ensureStrategyData(strategy, candles, params);

        const result = runStrategyBacktest({
          strategy,
          candles,
          initialCapital,
          params,
          costModel,
        });

        const output: Record<string, unknown> = {
          symbol,
          lookbackBars: candles.length,
          from: candles[0].time,
          to: candles[candles.length - 1].time,
          ...summarizeBacktest(result),
        };

        if (wfo?.enabled) {
          const candidates = wfo.candidates && wfo.candidates.length > 0 ? wfo.candidates : [params ?? {}];
          const wfoResult = runStrategyWalkForward({
            strategy,
            candles,
            candidates,
            initialCapital,
            costModel,
            config: {
              trainBars: wfo.trainBars,
              testBars: wfo.testBars,
              stepBars: wfo.stepBars,
              degradationThreshold: wfo.degradationThreshold,
              minTradesPerWindow: wfo.minTradesPerWindow,
            },
          });

          output.wfo = {
            overallPassed: wfoResult.overallPassed,
            failedWindows: wfoResult.failedWindows,
            windows: wfoResult.windows.map((window) => ({
              windowIndex: window.windowIndex,
              selectedCandidate: window.selectedCandidate.id,
              inSampleSharpe: Number(window.inSample.sharpe.toFixed(3)),
              outOfSampleSharpe: Number(window.outOfSample.sharpe.toFixed(3)),
              degradationRate: Number(window.degradationRate.toFixed(3)),
              gatePassed: window.gatePassed,
              gateReason: window.gateReason,
            })),
          };
        }

        if (significance?.enabled) {
          if (significance.partitions % 2 !== 0) {
            throw new Error("significance.partitions must be even.");
          }

          const significanceCandidates = ensureSignificanceCandidates(
            params,
            significance.candidates,
            wfo?.candidates,
          );

          const candidateReturns = significanceCandidates.map((candidate) =>
            equityCurveToReturns(
              runStrategyBacktest({
                strategy,
                candles,
                initialCapital,
                params: candidate,
                costModel,
              }).equityCurve,
            ),
          );

          const selectedReturns = equityCurveToReturns(result.equityCurve);
          const gate = evaluateSignificanceGate({
            candidateReturns,
            selectedReturns,
            partitions: significance.partitions,
            trialCount: significance.trialCount,
            pboThreshold: significance.pboThreshold,
            dsrMin: significance.dsrMin,
          });

          output.significance = {
            passed: gate.passed,
            pbo: Number(gate.pboResult.pbo.toFixed(4)),
            pboThreshold: gate.pboThreshold,
            dsrValue: Number(gate.dsrResult.dsrValue.toFixed(4)),
            dsrProbability: Number(gate.dsrResult.dsrProbability.toFixed(4)),
            dsrMin: gate.dsrMin,
          };
        }

        return output;
      },
    }),

    strategyCompare: tool({
      description: `
Compare multiple built-in strategies on the same symbol and cost model.

Returns a ranked summary so you can choose the current best-performing baseline.
Optional portfolio view compares equal-weight vs inverse-vol strategy baskets.
      `.trim(),
      inputSchema: z.object({
        symbol: z.string().describe('Trading pair, e.g. "BTC/USD"'),
        strategies: z
          .array(StrategyNameSchema)
          .min(1)
          .max(4)
          .optional()
          .describe("Subset to compare. Defaults to all."),
        lookbackBars: z.number().int().min(200).max(20_000).default(3000),
        initialCapital: z.number().positive().default(10_000),
        params: StrategyParamsSchema,
        costModel: CostModelSchema,
        portfolio: PortfolioCompareSchema,
      }),
      execute: async ({
        symbol,
        strategies,
        lookbackBars,
        initialCapital,
        params,
        costModel,
        portfolio,
      }) => {
        const strategyList: StrategyName[] =
          strategies && strategies.length
            ? strategies
            : ["trend", "meanReversion", "breakout", "ensemble"];

        const candles = await loadCandles(ctx, symbol, lookbackBars);
        const reports = strategyList.map((name) => {
          ensureStrategyData(name, candles, params);
          return runStrategyBacktest({
            strategy: name,
            candles,
            initialCapital,
            params,
            costModel,
          });
        });

        const ranked = reports
          .map((report) => summarizeBacktest(report))
          .sort((a, b) => {
            if (b.metrics.sharpe !== a.metrics.sharpe) {
              return b.metrics.sharpe - a.metrics.sharpe;
            }
            return b.metrics.totalReturnPct - a.metrics.totalReturnPct;
          });

        const response: Record<string, unknown> = {
          symbol,
          lookbackBars: candles.length,
          from: candles[0].time,
          to: candles[candles.length - 1].time,
          ranking: ranked,
          winner: ranked[0],
        };

        if (portfolio?.enabled && strategyList.length >= 2) {
          const annualizationFactor = annualizationFactorFromCandles(candles);
          const returnsByAsset: Record<string, number[]> = {};
          for (const report of reports) {
            returnsByAsset[report.strategy] = equityCurveToReturns(report.equityCurve);
          }

          const names = Object.keys(returnsByAsset);
          const equalWeights: Record<string, number> = {};
          for (const name of names) {
            equalWeights[name] = 1 / names.length;
          }

          const inverseVol = allocateInverseVolatilityPortfolio(returnsByAsset, {
            targetAnnualVolatility: portfolio.targetAnnualVolatility,
            leverageCap: portfolio.leverageCap,
            correlationThreshold: portfolio.correlationThreshold,
            maxPairCombinedWeight: portfolio.maxPairCombinedWeight,
            annualizationFactor,
          });

          const equalReturns = composePortfolioReturns(returnsByAsset, equalWeights);
          const inverseReturns = composePortfolioReturns(returnsByAsset, inverseVol.scaledWeights);

          response.portfolioComparison = {
            equalWeighted: {
              weights: equalWeights,
              ...summarizeReturns(equalReturns, annualizationFactor),
            },
            inverseVolWeighted: {
              weights: inverseVol.scaledWeights,
              leverage: Number(inverseVol.leverage.toFixed(3)),
              predictedAnnualVolatility: Number(inverseVol.predictedAnnualVolatility.toFixed(4)),
              ...summarizeReturns(inverseReturns, annualizationFactor),
            },
          };
        }

        return response;
      },
    }),
  };
}
