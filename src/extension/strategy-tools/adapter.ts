import { tool } from "ai";
import { z } from "zod";
import type { IAnalysisContext } from "../analysis-tools/interfaces.js";
import type { MarketData } from "../analysis-kit/data/interfaces.js";
import { runStrategyWalkForward } from "../../backtest/wfo.js";
import { evaluateSignificanceGate } from "../../backtest/statistical_significance.js";
import { buildInverseVolatilityPortfolioTarget } from "../../portfolio/target.js";
import { runStrategyBacktest } from "./backtest.js";
import { evaluateStrategy, getStrategyMinimumBars } from "./strategies.js";
import type { StrategyName, StrategyParams } from "./types.js";

const StrategyNameSchema = z.enum([
  "trend",
  "regimeTrend",
  "meanReversion",
  "factorMeanReversion",
  "shockFade",
  "breakout",
  "ensemble",
  "enhancedCarry",
  "liquidationAftermath",
]);

const StrategyParamsObjectSchema = z.object({
  allowShort: z.boolean().optional(),
  trendFastPeriod: z.number().int().positive().optional(),
  trendSlowPeriod: z.number().int().positive().optional(),
  trendConfirmBars: z.number().int().positive().optional(),
  trendMinDiffPct: z.number().min(0).optional(),
  regimeVolWindow: z.number().int().positive().optional(),
  regimeAtrPeriod: z.number().int().positive().optional(),
  regimeFastPeriod: z.number().int().positive().optional(),
  regimeSlowPeriod: z.number().int().positive().optional(),
  allowedEntryRegimes: z
    .array(
      z.enum([
        "HighVolTrend",
        "HighVolMeanRevert",
        "LowVolTrend",
        "LowVolCarry",
      ]),
    )
    .min(1)
    .optional(),
  exitOnRegimeMismatch: z.boolean().optional(),
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
  strategy: StrategyName,
  base: StrategyParams | undefined,
  explicit: StrategyParams[] | undefined,
  fromWfo: StrategyParams[] | undefined,
): StrategyParams[] {
  const source = explicit && explicit.length >= 2
    ? explicit
    : fromWfo && fromWfo.length >= 2
      ? fromWfo
      : buildFallbackCandidates(strategy, base);

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

  return buildFallbackCandidates(strategy, base);
}

function buildFallbackCandidates(
  strategy: StrategyName,
  base: StrategyParams | undefined,
): StrategyParams[] {
  const baseline = base ?? {};
  const fast = Math.max(3, (baseline.trendFastPeriod ?? 20) - 5);
  const slow = Math.max(fast + 5, (baseline.trendSlowPeriod ?? 50) + 5);

  if (strategy === "regimeTrend") {
    return [
      baseline,
      {
        ...baseline,
        trendFastPeriod: fast,
        trendSlowPeriod: slow,
        allowedEntryRegimes: ["HighVolTrend"],
      },
      {
        ...baseline,
        trendFastPeriod: Math.max(6, (baseline.trendFastPeriod ?? 20) + 3),
        trendSlowPeriod: Math.max(18, (baseline.trendSlowPeriod ?? 50) + 12),
        allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
      },
    ];
  }

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

const TREND_BASELINE_STRATEGY: StrategyName = "trend";

type BacktestSummary = ReturnType<typeof summarizeBacktest>;
type BacktestMetrics = BacktestSummary["metrics"];
type CompareSignificanceSummary = {
  passed: boolean;
  candidateSetSize: number;
  pbo: number;
  pboThreshold: number;
  dsrValue: number;
  dsrProbability: number | null;
  dsrMin: number;
};
type CompareDeltaSummary = {
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpe: number;
};
type RankedBacktestSummary = BacktestSummary & {
  vsTrendBaseline: CompareDeltaSummary;
  significance?: CompareSignificanceSummary;
};
type ResearchPortfolioSummary = {
  strategy: StrategyName;
  symbolCount: number;
  symbols: string[];
  metrics: ReturnType<typeof summarizeReturns>;
  symbolMetrics: Record<string, BacktestMetrics>;
  weights: Record<string, number>;
  leverage?: number;
  predictedAnnualVolatility?: number;
  portfolioTarget?: ReturnType<typeof buildInverseVolatilityPortfolioTarget>["target"];
  vsTrendBaseline: CompareDeltaSummary;
  significance?: CompareSignificanceSummary;
};

function resolveResearchSymbols(primarySymbol: string, symbols?: string[]): string[] {
  const ordered = [primarySymbol, ...(symbols ?? [])];
  const dedup = new Set<string>();
  const out: string[] = [];
  for (const symbol of ordered) {
    const trimmed = symbol.trim();
    if (!trimmed || dedup.has(trimmed)) {
      continue;
    }
    dedup.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function sortByPerformance<T extends { metrics: { sharpe: number; totalReturnPct: number } }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    if (b.metrics.sharpe !== a.metrics.sharpe) {
      return b.metrics.sharpe - a.metrics.sharpe;
    }
    return b.metrics.totalReturnPct - a.metrics.totalReturnPct;
  });
}

function summarizeSignificance(
  selectedReturns: number[],
  candidateReturns: number[][],
  significance: z.infer<typeof SignificanceConfigSchema> | undefined,
): CompareSignificanceSummary | undefined {
  if (!significance?.enabled) {
    return undefined;
  }
  if (significance.partitions % 2 !== 0) {
    throw new Error("significance.partitions must be even.");
  }
  if (candidateReturns.length < 2) {
    throw new Error(
      "strategyCompare significance requires at least 2 candidate return series.",
    );
  }

  const gate = evaluateSignificanceGate({
    candidateReturns,
    selectedReturns,
    partitions: significance.partitions,
    trialCount: significance.trialCount,
    pboThreshold: significance.pboThreshold,
    dsrMin: significance.dsrMin,
  });

  return {
    passed: gate.passed,
    candidateSetSize: candidateReturns.length,
    pbo: Number(gate.pboResult.pbo.toFixed(4)),
    pboThreshold: gate.pboThreshold,
    dsrValue: Number(gate.dsrResult.dsrValue.toFixed(4)),
    dsrProbability: gate.dsrResult.dsrProbability == null
      ? null
      : Number(gate.dsrResult.dsrProbability.toFixed(4)),
    dsrMin: gate.dsrMin,
  };
}

function summarizeDeltaAgainstTrend(
  metrics: BacktestMetrics | ReturnType<typeof summarizeReturns>,
  baseline: BacktestMetrics | ReturnType<typeof summarizeReturns>,
): CompareDeltaSummary {
  return {
    totalReturnPct: Number((metrics.totalReturnPct - baseline.totalReturnPct).toFixed(2)),
    annualizedReturnPct: Number(
      (metrics.annualizedReturnPct - baseline.annualizedReturnPct).toFixed(2),
    ),
    maxDrawdownPct: Number((metrics.maxDrawdownPct - baseline.maxDrawdownPct).toFixed(2)),
    sharpe: Number((metrics.sharpe - baseline.sharpe).toFixed(2)),
  };
}

function ensureTrendBaselineReport(
  reports: ReturnType<typeof runStrategyBacktest>[],
  candles: MarketData[],
  initialCapital: number,
  params: StrategyParams | undefined,
  costModel: z.infer<typeof CostModelSchema>,
): ReturnType<typeof runStrategyBacktest> {
  const existing = reports.find((report) => report.strategy === TREND_BASELINE_STRATEGY);
  if (existing) {
    return existing;
  }

  ensureStrategyData(TREND_BASELINE_STRATEGY, candles, params);
  return runStrategyBacktest({
    strategy: TREND_BASELINE_STRATEGY,
    candles,
    initialCapital,
    params,
    costModel,
  });
}

function buildRankedStrategySummaries(
  reports: ReturnType<typeof runStrategyBacktest>[],
  trendBaselineReport: ReturnType<typeof runStrategyBacktest>,
  significance: z.infer<typeof SignificanceConfigSchema> | undefined,
): RankedBacktestSummary[] {
  const returnsByStrategy = Object.fromEntries(
    reports.map((report) => [report.strategy, equityCurveToReturns(report.equityCurve)]),
  ) as Record<StrategyName, number[]>;
  const candidateReturns = reports.map((report) => returnsByStrategy[report.strategy]);
  const trendBaseline = summarizeBacktest(trendBaselineReport);

  return sortByPerformance(
    reports.map((report) => {
      const summary = summarizeBacktest(report);
      return {
        ...summary,
        vsTrendBaseline: summarizeDeltaAgainstTrend(summary.metrics, trendBaseline.metrics),
        significance: summarizeSignificance(
          returnsByStrategy[report.strategy],
          candidateReturns,
          significance,
        ),
      };
    }),
  );
}

function buildStrategyPortfolioResearch(
  strategyList: StrategyName[],
  symbols: string[],
  reportsBySymbol: Record<string, ReturnType<typeof runStrategyBacktest>[]>,
  trendBaselineBySymbol: Record<string, ReturnType<typeof runStrategyBacktest>>,
  annualizationFactor: number,
  initialCapital: number,
  portfolio: z.infer<typeof PortfolioCompareSchema>,
  significance: z.infer<typeof SignificanceConfigSchema> | undefined,
): {
  equalWeightedStrategyPortfolioRanking: ResearchPortfolioSummary[];
  inverseVolWeightedStrategyPortfolioRanking: ResearchPortfolioSummary[];
  baseline: {
    equalWeighted: ResearchPortfolioSummary;
    inverseVolWeighted: ResearchPortfolioSummary;
  };
  winner: {
    equalWeighted: ResearchPortfolioSummary;
    inverseVolWeighted: ResearchPortfolioSummary;
  };
} {
  const equalWeightedCandidates: ResearchPortfolioSummary[] = [];
  const inverseVolCandidates: ResearchPortfolioSummary[] = [];

  for (const strategy of strategyList) {
    const returnsBySymbol: Record<string, number[]> = {};
    const symbolMetrics: Record<string, BacktestMetrics> = {};

    for (const symbol of symbols) {
      const report = reportsBySymbol[symbol].find((entry) => entry.strategy === strategy);
      if (!report) {
        throw new Error(`Missing ${strategy} report for ${symbol}.`);
      }
      returnsBySymbol[symbol] = equityCurveToReturns(report.equityCurve);
      symbolMetrics[symbol] = summarizeBacktest(report).metrics;
    }

    const equalWeights = Object.fromEntries(
      symbols.map((symbol) => [symbol, 1 / symbols.length]),
    ) as Record<string, number>;
    const equalReturns = composePortfolioReturns(returnsBySymbol, equalWeights);
    equalWeightedCandidates.push({
      strategy,
      symbolCount: symbols.length,
      symbols,
      metrics: summarizeReturns(equalReturns, annualizationFactor),
      symbolMetrics,
      weights: equalWeights,
      vsTrendBaseline: {
        totalReturnPct: 0,
        annualizedReturnPct: 0,
        maxDrawdownPct: 0,
        sharpe: 0,
      },
    });

    const inverseVol = buildInverseVolatilityPortfolioTarget({
      basisEquityUsd: initialCapital,
      returnsByAsset: returnsBySymbol,
      allocatorConfig: {
        targetAnnualVolatility: portfolio?.targetAnnualVolatility,
        leverageCap: portfolio?.leverageCap,
        correlationThreshold: portfolio?.correlationThreshold,
        maxPairCombinedWeight: portfolio?.maxPairCombinedWeight,
        annualizationFactor,
      },
      sizingReasonBySymbol: Object.fromEntries(
        symbols.map((symbol) => [symbol, `strategy_compare_${strategy}_inverse_vol`]),
      ),
      notes: [
        `symbols=${symbols.join(",")}`,
        `strategy=${strategy}`,
        "source=strategyCompare",
      ],
    });
    const inverseReturns = composePortfolioReturns(
      returnsBySymbol,
      inverseVol.allocation.scaledWeights,
    );
    inverseVolCandidates.push({
      strategy,
      symbolCount: symbols.length,
      symbols,
      metrics: summarizeReturns(inverseReturns, annualizationFactor),
      symbolMetrics,
      weights: inverseVol.allocation.scaledWeights,
      leverage: Number(inverseVol.allocation.leverage.toFixed(3)),
      predictedAnnualVolatility: Number(
        inverseVol.allocation.predictedAnnualVolatility.toFixed(4),
      ),
      portfolioTarget: inverseVol.target,
      vsTrendBaseline: {
        totalReturnPct: 0,
        annualizedReturnPct: 0,
        maxDrawdownPct: 0,
        sharpe: 0,
      },
    });
  }

  const equalCandidateReturns = equalWeightedCandidates.map((item) =>
    composePortfolioReturns(
      Object.fromEntries(
        symbols.map((symbol) => {
          const report = reportsBySymbol[symbol].find((entry) => entry.strategy === item.strategy);
          if (!report) {
            throw new Error(`Missing ${item.strategy} report for ${symbol}.`);
          }
          return [symbol, equityCurveToReturns(report.equityCurve)];
        }),
      ),
      item.weights,
    ),
  );
  const inverseCandidateReturns = inverseVolCandidates.map((item) =>
    composePortfolioReturns(
      Object.fromEntries(
        symbols.map((symbol) => {
          const report = reportsBySymbol[symbol].find((entry) => entry.strategy === item.strategy);
          if (!report) {
            throw new Error(`Missing ${item.strategy} report for ${symbol}.`);
          }
          return [symbol, equityCurveToReturns(report.equityCurve)];
        }),
      ),
      item.weights,
    ),
  );

  const trendReturnsBySymbol = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      equityCurveToReturns(trendBaselineBySymbol[symbol].equityCurve),
    ]),
  ) as Record<string, number[]>;
  const trendSymbolMetrics = Object.fromEntries(
    symbols.map((symbol) => [
      symbol,
      summarizeBacktest(trendBaselineBySymbol[symbol]).metrics,
    ]),
  ) as Record<string, BacktestMetrics>;
  const trendEqualWeights = Object.fromEntries(
    symbols.map((symbol) => [symbol, 1 / symbols.length]),
  ) as Record<string, number>;
  const trendEqualBaseline: ResearchPortfolioSummary = {
    strategy: TREND_BASELINE_STRATEGY,
    symbolCount: symbols.length,
    symbols,
    metrics: summarizeReturns(
      composePortfolioReturns(trendReturnsBySymbol, trendEqualWeights),
      annualizationFactor,
    ),
    symbolMetrics: trendSymbolMetrics,
    weights: trendEqualWeights,
    vsTrendBaseline: {
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
    },
  };
  const trendInverseVol = buildInverseVolatilityPortfolioTarget({
    basisEquityUsd: initialCapital,
    returnsByAsset: trendReturnsBySymbol,
    allocatorConfig: {
      targetAnnualVolatility: portfolio?.targetAnnualVolatility,
      leverageCap: portfolio?.leverageCap,
      correlationThreshold: portfolio?.correlationThreshold,
      maxPairCombinedWeight: portfolio?.maxPairCombinedWeight,
      annualizationFactor,
    },
    sizingReasonBySymbol: Object.fromEntries(
      symbols.map((symbol) => [symbol, "strategy_compare_trend_inverse_vol"]),
    ),
    notes: [
      `symbols=${symbols.join(",")}`,
      "strategy=trend",
      "source=strategyCompare",
    ],
  });
  const trendInverseBaseline: ResearchPortfolioSummary = {
    strategy: TREND_BASELINE_STRATEGY,
    symbolCount: symbols.length,
    symbols,
    metrics: summarizeReturns(
      composePortfolioReturns(trendReturnsBySymbol, trendInverseVol.allocation.scaledWeights),
      annualizationFactor,
    ),
    symbolMetrics: trendSymbolMetrics,
    weights: trendInverseVol.allocation.scaledWeights,
    leverage: Number(trendInverseVol.allocation.leverage.toFixed(3)),
    predictedAnnualVolatility: Number(
      trendInverseVol.allocation.predictedAnnualVolatility.toFixed(4),
    ),
    portfolioTarget: trendInverseVol.target,
    vsTrendBaseline: {
      totalReturnPct: 0,
      annualizedReturnPct: 0,
      maxDrawdownPct: 0,
      sharpe: 0,
    },
  };

  const equalWeightedStrategyPortfolioRanking = sortByPerformance(
    equalWeightedCandidates.map((item, index) => ({
      ...item,
      vsTrendBaseline: summarizeDeltaAgainstTrend(
        item.metrics,
        trendEqualBaseline.metrics,
      ),
      significance: summarizeSignificance(
        equalCandidateReturns[index],
        equalCandidateReturns,
        significance,
      ),
    })),
  );
  const inverseVolWeightedStrategyPortfolioRanking = sortByPerformance(
    inverseVolCandidates.map((item, index) => ({
      ...item,
      vsTrendBaseline: summarizeDeltaAgainstTrend(
        item.metrics,
        trendInverseBaseline.metrics,
      ),
      significance: summarizeSignificance(
        inverseCandidateReturns[index],
        inverseCandidateReturns,
        significance,
      ),
    })),
  );

  return {
    equalWeightedStrategyPortfolioRanking,
    inverseVolWeightedStrategyPortfolioRanking,
    baseline: {
      equalWeighted: trendEqualBaseline,
      inverseVolWeighted: trendInverseBaseline,
    },
    winner: {
      equalWeighted: equalWeightedStrategyPortfolioRanking[0],
      inverseVolWeighted: inverseVolWeightedStrategyPortfolioRanking[0],
    },
  };
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
            strategy,
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
            dsrProbability: gate.dsrResult.dsrProbability == null
              ? null
              : Number(gate.dsrResult.dsrProbability.toFixed(4)),
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
        symbols: z
          .array(z.string())
          .min(1)
          .max(8)
          .optional()
          .describe("Optional research basket. Include BTC/USD + ETH/USD for dual-symbol portfolio research."),
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
        significance: SignificanceConfigSchema,
      }),
      execute: async ({
        symbol,
        symbols,
        strategies,
        lookbackBars,
        initialCapital,
        params,
        costModel,
        portfolio,
        significance,
      }) => {
        const strategyList: StrategyName[] =
          strategies && strategies.length
            ? strategies
            : ["trend", "meanReversion", "breakout", "ensemble"];

        const researchSymbols = resolveResearchSymbols(symbol, symbols);
        const candlesBySymbol = Object.fromEntries(
          await Promise.all(
            researchSymbols.map(async (researchSymbol) => [
              researchSymbol,
              await loadCandles(ctx, researchSymbol, lookbackBars),
            ]),
          ),
        ) as Record<string, MarketData[]>;

        const reportsBySymbol: Record<string, ReturnType<typeof runStrategyBacktest>[]> = {};
        const trendBaselineBySymbol: Record<string, ReturnType<typeof runStrategyBacktest>> = {};

        for (const researchSymbol of researchSymbols) {
          const candles = candlesBySymbol[researchSymbol];
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
          reportsBySymbol[researchSymbol] = reports;
          trendBaselineBySymbol[researchSymbol] = ensureTrendBaselineReport(
            reports,
            candles,
            initialCapital,
            params,
            costModel,
          );
        }

        const candles = candlesBySymbol[symbol];
        const reports = reportsBySymbol[symbol];
        const ranked = buildRankedStrategySummaries(
          reports,
          trendBaselineBySymbol[symbol],
          significance,
        );

        const response: Record<string, unknown> = {
          symbol,
          symbols: researchSymbols,
          baselineStrategy: TREND_BASELINE_STRATEGY,
          lookbackBars: candles.length,
          from: candles[0].time,
          to: candles[candles.length - 1].time,
          ranking: ranked,
          winner: ranked[0],
          trendBaseline:
            ranked.find((entry) => entry.strategy === TREND_BASELINE_STRATEGY) ??
            summarizeBacktest(trendBaselineBySymbol[symbol]),
          validation: significance?.enabled
            ? {
                mode: "research_surface_with_statistical_context",
                note: "Use strategyBacktest for promotion-grade WFO/significance validation.",
              }
            : {
                mode: "research_surface_only",
                note: "Use strategyBacktest for promotion-grade WFO/significance validation.",
              },
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

          const inverseVol = buildInverseVolatilityPortfolioTarget({
            basisEquityUsd: initialCapital,
            returnsByAsset,
            allocatorConfig: {
              targetAnnualVolatility: portfolio.targetAnnualVolatility,
              leverageCap: portfolio.leverageCap,
              correlationThreshold: portfolio.correlationThreshold,
              maxPairCombinedWeight: portfolio.maxPairCombinedWeight,
              annualizationFactor,
            },
            sizingReasonBySymbol: Object.fromEntries(
              Object.keys(returnsByAsset).map((name) => [name, "strategy_compare_inverse_vol"])
            ),
            notes: [
              `symbol=${symbol}`,
              "source=strategyCompare",
            ],
          });

          const equalReturns = composePortfolioReturns(returnsByAsset, equalWeights);
          const inverseReturns = composePortfolioReturns(
            returnsByAsset,
            inverseVol.allocation.scaledWeights
          );

          response.portfolioComparison = {
            equalWeighted: {
              weights: equalWeights,
              ...summarizeReturns(equalReturns, annualizationFactor),
            },
            inverseVolWeighted: {
              weights: inverseVol.allocation.scaledWeights,
              leverage: Number(inverseVol.allocation.leverage.toFixed(3)),
              predictedAnnualVolatility: Number(
                inverseVol.allocation.predictedAnnualVolatility.toFixed(4)
              ),
              portfolioTarget: inverseVol.target,
              ...summarizeReturns(inverseReturns, annualizationFactor),
            },
          };
        }

        if (researchSymbols.length >= 2) {
          const annualizationFactor = annualizationFactorFromCandles(candles);
          response.multiSymbolResearch = {
            symbols: researchSymbols,
            baselineStrategy: TREND_BASELINE_STRATEGY,
            perSymbol: researchSymbols.map((researchSymbol) => {
              const ranking = buildRankedStrategySummaries(
                reportsBySymbol[researchSymbol],
                trendBaselineBySymbol[researchSymbol],
                significance,
              );
              return {
                symbol: researchSymbol,
                lookbackBars: candlesBySymbol[researchSymbol].length,
                from: candlesBySymbol[researchSymbol][0].time,
                to: candlesBySymbol[researchSymbol][candlesBySymbol[researchSymbol].length - 1].time,
                ranking,
                winner: ranking[0],
                trendBaseline:
                  ranking.find((entry) => entry.strategy === TREND_BASELINE_STRATEGY) ??
                  summarizeBacktest(trendBaselineBySymbol[researchSymbol]),
              };
            }),
            ...buildStrategyPortfolioResearch(
              strategyList,
              researchSymbols,
              reportsBySymbol,
              trendBaselineBySymbol,
              annualizationFactor,
              initialCapital,
              portfolio,
              significance,
            ),
          };
        }

        return response;
      },
    }),
  };
}
