import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { NewsItem } from "../extension/analysis-kit/data/interfaces.js";
import type { KlineStore } from "../extension/analysis-kit/kline/KlineStore.js";
import type { ICryptoTradingEngine } from "../extension/crypto-trading/interfaces.js";
import {
  evaluateStrategy,
  type StrategyParams,
} from "../extension/strategy-tools/index.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";
import {
  analyzeNewsImpact,
  type NewsImpactSummary,
} from "./news_impact.js";
import {
  evaluateExpertDecision,
  type ExpertDecisionResult,
} from "./expert_decision.js";
import type { PersistedReleaseGateStatus } from "./release_gate_status.js";

interface NewsProviderLike {
  getNewsV2(options: {
    endTime: Date;
    lookback?: string;
    limit?: number;
  }): Promise<NewsItem[]>;
}

interface CandidateManifest {
  dataset?: {
    symbols?: Array<{
      inputCsv?: string;
      symbol?: string;
    }>;
  };
  candidates?: Array<{
    strategy?: string;
    params?: StrategyParams;
    applicableSymbols?: string[];
    symbols?: string[];
  }>;
}

export interface PaperPortfolioTargetBuilderOptions {
  symbols: string[];
  releaseGateStatus: PersistedReleaseGateStatus | null;
  outputPath?: string;
  candidateConfigPath?: string;
  lookbackBars?: number;
  newsLookbackHours?: number;
  newsLimit?: number;
  maxGrossExposure?: number;
  maxTurnoverPct?: number;
  now?: Date;
}

export interface PaperPortfolioTargetBuilderResult {
  target: PortfolioTarget;
  decisions: Array<{
    symbol: string;
    decision: ExpertDecisionResult;
  }>;
  newsImpact: NewsImpactSummary;
}

const DEFAULT_OUTPUT_PATH = "data/runtime/paper_portfolio_target.json";
const DEFAULT_CANDIDATES_PATH = "docs/research/strategy_candidates.v1.json";
const DEFAULT_LOOKBACK_BARS = 1500;
const DEFAULT_NEWS_LOOKBACK_HOURS = 48;
const DEFAULT_NEWS_LIMIT = 300;
const DEFAULT_MAX_GROSS_EXPOSURE = 1;
const DEFAULT_MAX_TURNOVER_PCT = 1;
const DEFAULT_TREND_PARAMS: StrategyParams = {
  trendFastPeriod: 20,
  trendSlowPeriod: 55,
  allowShort: true,
};

export async function writePaperPortfolioTarget(params: {
  engine: ICryptoTradingEngine;
  klineStore: KlineStore;
  newsProvider: NewsProviderLike;
  options: PaperPortfolioTargetBuilderOptions;
}): Promise<PaperPortfolioTargetBuilderResult> {
  const result = await buildPaperPortfolioTarget(params);
  const outputPath = params.options.outputPath ?? DEFAULT_OUTPUT_PATH;
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result.target, null, 2)}\n`, "utf-8");
  return result;
}

export async function buildPaperPortfolioTarget(params: {
  engine: ICryptoTradingEngine;
  klineStore: KlineStore;
  newsProvider: NewsProviderLike;
  options: PaperPortfolioTargetBuilderOptions;
}): Promise<PaperPortfolioTargetBuilderResult> {
  const now = params.options.now ?? new Date();
  const symbols = uniqueSymbols(params.options.symbols);
  const lookbackBars = params.options.lookbackBars ?? DEFAULT_LOOKBACK_BARS;
  const news = await params.newsProvider.getNewsV2({
    endTime: now,
    lookback: `${params.options.newsLookbackHours ?? DEFAULT_NEWS_LOOKBACK_HOURS}h`,
    limit: params.options.newsLimit ?? DEFAULT_NEWS_LIMIT,
  });
  const newsImpact = analyzeNewsImpact(news, { now });
  const candidateManifest = await readCandidateManifest(
    params.options.candidateConfigPath ?? DEFAULT_CANDIDATES_PATH,
  );

  const decisions = await Promise.all(
    symbols.map(async symbol => {
      const candles = await loadCandles(
        params.klineStore,
        candidateManifest,
        symbol,
        lookbackBars,
        now,
      );
      const trendParams = resolveTrendParamsForSymbol(candidateManifest, symbol);
      const strategyDecision = evaluateStrategy({
        strategy: "trend",
        candles,
        index: candles.length - 1,
        currentPosition: 0,
        params: trendParams,
      });
      const decision = evaluateExpertDecision({
        symbol,
        strategy: {
          signal: strategyDecision.signal,
          reason: strategyDecision.reason,
          ensembleScore:
            typeof strategyDecision.indicators?.smaDiffPct === "number"
              ? strategyDecision.indicators.smaDiffPct
              : strategyDecision.signal,
        },
        news: newsImpact,
        releaseGateStatus: params.options.releaseGateStatus,
        policy: {
          requireReleaseGatePass: true,
          allowShort: true,
          minCompositeScore: 0.15,
        },
      });
      return { symbol, decision };
    }),
  );

  const grossCap = params.options.maxGrossExposure ?? DEFAULT_MAX_GROSS_EXPOSURE;
  const rawWeights = Object.fromEntries(
    decisions.map(({ symbol, decision }) => [
      symbol,
      decision.action === "long"
        ? decision.suggestedExposurePct / 100
        : decision.action === "short"
          ? -(decision.suggestedExposurePct / 100)
          : 0,
    ]),
  ) as Record<string, number>;
  const scaledWeights = scaleWeightsToGrossCap(rawWeights, grossCap);

  const account = await params.engine.getAccount();
  const basisEquityUsd =
    account.equity > 0 ? account.equity : account.balance > 0 ? account.balance : 1_000;

  const target = buildPortfolioTargetFromWeights({
    basisEquityUsd,
    weights: scaledWeights,
    generatedAt: now.toISOString(),
    maxTurnoverPct: params.options.maxTurnoverPct ?? DEFAULT_MAX_TURNOVER_PCT,
    confidenceBySymbol: Object.fromEntries(
      decisions.map(({ symbol, decision }) => [symbol, decision.confidence]),
    ),
    sizingReasonBySymbol: Object.fromEntries(
      decisions.map(({ symbol, decision }) => [
        symbol,
        `paper_portfolio_builder:${decision.action}`,
      ]),
    ),
    regimeTagBySymbol: Object.fromEntries(
      decisions.map(({ symbol, decision }) => [
        symbol,
        decision.overlays.newsRiskRegime,
      ]),
    ),
    notes: [
      "source=paper_portfolio_target_builder",
      `symbols=${symbols.join(",")}`,
      `newsRiskRegime=${newsImpact.overlay?.riskRegime ?? "normal"}`,
    ],
  });

  return {
    target,
    decisions,
    newsImpact,
  };
}

async function loadCandles(
  klineStore: KlineStore,
  manifest: CandidateManifest | null,
  symbol: string,
  lookbackBars: number,
  endTime: Date,
) {
  const startTime = new Date(endTime.getTime());
  startTime.setHours(startTime.getHours() - lookbackBars);
  let rows;
  try {
    rows = await klineStore.marketDataProvider.getMarketDataRange(
      startTime,
      endTime,
      symbol,
    );
  } catch (error) {
    const fallbackCsv = resolveFallbackCsv(manifest, symbol);
    if (!fallbackCsv) {
      throw error;
    }
    rows = await loadCandlesFromCsv(fallbackCsv, symbol);
  }
  if (rows.length < 3) {
    throw new Error(`Insufficient candles for ${symbol}.`);
  }
  return rows.sort((a, b) => a.time - b.time);
}

async function readCandidateManifest(path: string): Promise<CandidateManifest | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as CandidateManifest;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function resolveTrendParamsForSymbol(
  manifest: CandidateManifest | null,
  symbol: string,
): StrategyParams {
  const trendCandidate = manifest?.candidates?.find(candidate => {
    if (candidate?.strategy !== "trend" || !candidate.params) {
      return false;
    }
    const applicableSymbols = candidate.applicableSymbols ?? candidate.symbols;
    return !applicableSymbols || applicableSymbols.includes(symbol);
  });
  return trendCandidate?.params ?? DEFAULT_TREND_PARAMS;
}

function resolveFallbackCsv(
  manifest: CandidateManifest | null,
  symbol: string,
): string | null {
  const datasetSymbols = manifest?.dataset?.symbols;
  if (!datasetSymbols) {
    return null;
  }
  const matched = datasetSymbols.find(item => item.symbol === symbol);
  return matched?.inputCsv ?? null;
}

async function loadCandlesFromCsv(path: string, symbol: string) {
  const raw = await readFile(path, "utf-8");
  const lines = raw.trim().split(/\r?\n/);
  if (lines.length < 2) {
    return [];
  }
  const headers = lines[0].split(",").map(header => header.trim().toLowerCase());
  const index = {
    timestamp: headers.findIndex(header => ["timestamp", "time", "date"].includes(header)),
    open: headers.indexOf("open"),
    high: headers.indexOf("high"),
    low: headers.indexOf("low"),
    close: headers.indexOf("close"),
    volume: headers.indexOf("volume"),
  };

  return lines.slice(1).map(line => {
    const columns = line.split(",");
    const rawTime = columns[index.timestamp] ?? "";
    const parsedTime = Number.isFinite(Number(rawTime))
      ? Number(rawTime)
      : Math.floor(Date.parse(rawTime) / 1000);
    return {
      symbol,
      time: parsedTime,
      open: Number(columns[index.open] ?? 0),
      high: Number(columns[index.high] ?? 0),
      low: Number(columns[index.low] ?? 0),
      close: Number(columns[index.close] ?? 0),
      volume: Number(columns[index.volume] ?? 0),
    };
  }).filter(row =>
    Number.isFinite(row.time) &&
    Number.isFinite(row.open) &&
    Number.isFinite(row.high) &&
    Number.isFinite(row.low) &&
    Number.isFinite(row.close),
  );
}

function scaleWeightsToGrossCap(
  weights: Record<string, number>,
  grossCap: number,
): Record<string, number> {
  const gross = Object.values(weights).reduce(
    (sum, value) => sum + Math.abs(value),
    0,
  );
  if (gross <= grossCap || gross === 0) {
    return weights;
  }
  const scale = grossCap / gross;
  return Object.fromEntries(
    Object.entries(weights).map(([symbol, value]) => [
      symbol,
      Number((value * scale).toFixed(6)),
    ]),
  );
}

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(
    new Set(symbols.map(symbol => symbol.trim()).filter(Boolean)),
  );
}
