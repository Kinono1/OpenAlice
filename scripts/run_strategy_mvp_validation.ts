import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runFdrCorrection,
  type FdrDiagnostics,
  type FdrItem,
  type FdrMethod,
} from "../src/backtest/fdr.js";
import {
  evaluateReleaseGate,
  type ReleaseGateCheck,
  type ReleaseGateResult,
  type ReleaseGateStatus,
} from "../src/backtest/release_gate.js";
import { evaluateRiskSimulation } from "../src/backtest/risk_simulation.js";
import {
  computeSpaLikePValues,
  computeDeflatedSharpe,
  evaluateSignificanceGate,
} from "../src/backtest/statistical_significance.js";
import { runStrategyWalkForward } from "../src/backtest/wfo.js";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import { runStrategyBacktest } from "../src/extension/strategy-tools/backtest.js";
import type {
  StrategyName,
  StrategyParams,
} from "../src/extension/strategy-tools/types.js";
import { writeReleaseGateStatus } from "../src/runtime/release_gate_status.js";

type BootstrapMethod = "iid_bootstrap" | "moving_block_bootstrap";
type MultipleTestingUnit = "candidate" | "family";
type WfoProfile = "stable" | "shift" | "stress";

interface CandidateConfig {
  strategyId: string;
  strategyName: string;
  strategy: StrategyName;
  params: StrategyParams;
  applicableSymbols?: string[];
  symbols?: string[];
  hypothesisFamily?: string;
  correlationBucket?: string;
  role?: "donor" | "benchmark_control" | "robustness_anchor" | "independent_guard";
}

interface DatasetSymbolConfig {
  inputCsv?: string;
  symbol?: string;
  lookbackBars?: number;
}

interface CandidatesFile {
  schemaVersion?: string;
  dataset?: {
    inputCsv?: string;
    symbol?: string;
    lookbackBars?: number;
    symbols?: DatasetSymbolConfig[];
  };
  thresholds?: {
    meanPboMax?: number;
    meanDsrProbabilityMin?: number;
    fdrQMax?: number;
  };
  wfo?: {
    trainBars?: number;
    testBars?: number;
    stepBars?: number;
    degradationThreshold?: number;
    profile?: WfoProfile;
  };
  significance?: {
    partitions?: number;
    pboThreshold?: number;
    dsrMin?: number;
    multipleTestingUnit?: MultipleTestingUnit;
    fdrMethod?: FdrMethod;
    storeyLambda?: number;
    cvAggQuantile?: number;
    spaBootstrapSamples?: number;
    spaBlockSize?: number;
    benchmarkStrategyIdBySymbol?: Record<string, string>;
  };
  riskSimulation?: {
    method?: BootstrapMethod;
    simulations?: number;
    horizonBars?: number;
    blockSize?: number;
    ruinDrawdownPct?: number;
    maxRuinProbability?: number;
    minProfitProbability?: number;
  };
  costModel?: {
    feeRate?: number;
    slippageBps?: number;
    latencyBars?: number;
  };
  candidates?: CandidateConfig[];
}

interface CliArgs {
  candidatesFile: string;
  output: string;
  verdictOutput: string;
  releaseGateStatusPath: string;
  multipleTestingUnit?: MultipleTestingUnit;
  fdrMethod?: FdrMethod;
  wfoProfile?: WfoProfile;
  storeyLambda?: number;
  cvAggQuantile?: number;
  selfCheck: boolean;
}

interface DatasetSymbolTarget {
  inputCsv: string;
  symbol: string;
  lookbackBars: number;
}

interface NormalizedCandidateConfig {
  strategyId: string;
  strategyName: string;
  strategy: StrategyName;
  params: StrategyParams;
  applicableSymbols: string[];
  hypothesisFamily?: string;
  correlationBucket?: string;
  role?: "donor" | "benchmark_control" | "robustness_anchor" | "independent_guard";
}

interface ThresholdConfig {
  meanPboMax: number;
  meanDsrProbabilityMin: number;
  fdrQMax: number;
}

interface WfoConfig {
  trainBars: number;
  testBars: number;
  stepBars: number;
  degradationThreshold: number;
  profile: WfoProfile;
}

interface SignificanceConfig {
  partitions: number;
  pboThreshold: number;
  dsrMin: number;
  multipleTestingUnit: MultipleTestingUnit;
  fdrMethod: FdrMethod;
  storeyLambda: number;
  cvAggQuantile: number;
  spaBootstrapSamples: number;
  spaBlockSize: number;
  benchmarkStrategyIdBySymbol: Record<string, string>;
}

interface RiskConfig {
  method: BootstrapMethod;
  simulations: number;
  horizonBars: number;
  blockSize: number;
  ruinDrawdownPct: number;
  maxRuinProbability: number;
  minProfitProbability: number;
}

interface CostModelConfig {
  feeRate: number;
  slippageBps: number;
  latencyBars: number;
}

type BacktestReport = ReturnType<typeof runStrategyBacktest>;
type WfoResult = ReturnType<typeof runStrategyWalkForward>;
type SignificanceResult = ReturnType<typeof evaluateSignificanceGate>;
type RiskSimulationResult = ReturnType<typeof evaluateRiskSimulation>;

interface RawRun {
  candidate: NormalizedCandidateConfig;
  backtest: BacktestReport;
  significance: SignificanceResult;
  riskSimulation: RiskSimulationResult;
  wfo: WfoResult;
  releaseGate: ReleaseGateResult;
  pValue: number;
}

interface EnrichedRun extends RawRun {
  familyKey: string;
  correlationBucket: string;
  familyRepresentative: boolean;
  familyRepresentativeStrategyId: string;
  candidateLevelFdr: FdrItem;
  admissionSignificance: SignificanceResult;
  fdr: FdrItem;
  candidatePass: boolean;
  failureReasons: string[];
}

interface SymbolSummary {
  symbol: string;
  inputCsv: string;
  lookbackBars: number;
  applicableCandidateCount: number;
  aggregateMetrics: {
    meanPbo: number;
    meanDsrProbability: number;
    fdrQ: number;
    fdrMethod: FdrMethod;
    fdrDiagnostics: FdrDiagnostics;
    wfoProfile: WfoProfile;
  };
  result: "GO" | "NO_GO";
  reasonCodes: string[];
  leader: EnrichedRun;
  champion: EnrichedRun | null;
  candidates: EnrichedRun[];
  candidatePoolDiagnostics: CandidatePoolDiagnostics;
}

interface CandidateFamilyMember {
  strategyId: string;
  strategyName: string;
  strategy: StrategyName;
}

interface CandidateFamilyGroup {
  familyKey: string;
  candidateCount: number;
  members: CandidateFamilyMember[];
}

interface CandidateCorrelationEntry {
  strategyId: string;
  strategyName: string;
  familyKey: string;
  correlationBucket: string;
}

interface CandidateCorrelationPair {
  leftStrategyId: string;
  rightStrategyId: string;
  leftFamilyKey: string;
  rightFamilyKey: string;
  leftCorrelationBucket: string;
  rightCorrelationBucket: string;
  correlation: number;
}

interface CandidatePoolDiagnostics {
  candidateOrder: CandidateCorrelationEntry[];
  familyGroups: CandidateFamilyGroup[];
  correlationMatrix: number[][];
  averageAbsoluteCorrelation: number;
  maxAbsoluteCorrelation: number;
  topCorrelatedPairs: CandidateCorrelationPair[];
}

interface AdmissionView {
  candidateLevelFdrItems: FdrItem[];
  candidateLevelFdrDiagnostics: FdrDiagnostics;
  admissionSignificanceByIndex: SignificanceResult[];
  admissionFdrByIndex: FdrItem[];
  admissionFdrDiagnostics: FdrDiagnostics;
  familyKeyByIndex: string[];
  correlationBucketByIndex: string[];
  familyRepresentativeIndexByFamily: Map<string, number>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    runSelfCheck();
    console.log("run_strategy_mvp_validation self-check: ok");
    return;
  }
  const cfg = await readCandidatesConfig(args.candidatesFile);

  const datasetSymbols = normalizeDatasetSymbols(cfg.dataset);
  const candidates = normalizeCandidates(
    cfg.candidates,
    datasetSymbols.map((item) => item.symbol)
  );
  if (candidates.length === 0) {
    throw new Error("candidates file must contain at least 1 candidate.");
  }

  const thresholds: ThresholdConfig = {
    meanPboMax: toFiniteNumber(cfg.thresholds?.meanPboMax, 0.2, "meanPboMax"),
    meanDsrProbabilityMin: toFiniteNumber(
      cfg.thresholds?.meanDsrProbabilityMin,
      0.5,
      "meanDsrProbabilityMin"
    ),
    fdrQMax: toFiniteNumber(cfg.thresholds?.fdrQMax, 0.1, "fdrQMax"),
  };

  const wfoConfig: WfoConfig = {
    trainBars: toPositiveInt(cfg.wfo?.trainBars, 24 * 365, "trainBars"),
    testBars: toPositiveInt(cfg.wfo?.testBars, 24 * 90, "testBars"),
    stepBars: toPositiveInt(cfg.wfo?.stepBars, 24 * 90, "stepBars"),
    degradationThreshold: toFiniteNumber(
      cfg.wfo?.degradationThreshold,
      0.4,
      "degradationThreshold"
    ),
    profile:
      args.wfoProfile ??
      (cfg.wfo?.profile === "shift" || cfg.wfo?.profile === "stress"
        ? cfg.wfo.profile
        : "stable"),
  };
  const effectiveWfoConfig = resolveWfoProfile(wfoConfig);

  const significanceConfig: SignificanceConfig = {
    partitions: toPositiveInt(cfg.significance?.partitions, 8, "partitions"),
    pboThreshold: toFiniteNumber(
      cfg.significance?.pboThreshold,
      0.2,
      "pboThreshold"
    ),
    dsrMin: toFiniteNumber(cfg.significance?.dsrMin, 0.0, "dsrMin"),
    multipleTestingUnit:
      args.multipleTestingUnit ??
      (cfg.significance?.multipleTestingUnit === "family"
        ? "family"
        : "candidate"),
    fdrMethod: resolveFdrMethod(
      args.fdrMethod ?? cfg.significance?.fdrMethod ?? "bh"
    ),
    storeyLambda: toProbability(
      args.storeyLambda ?? cfg.significance?.storeyLambda ?? 0.5,
      "storeyLambda"
    ),
    cvAggQuantile: toProbability(
      args.cvAggQuantile ?? cfg.significance?.cvAggQuantile ?? 0.9,
      "cvAggQuantile"
    ),
    spaBootstrapSamples: toPositiveInt(
      cfg.significance?.spaBootstrapSamples,
      400,
      "spaBootstrapSamples"
    ),
    spaBlockSize: toPositiveInt(
      cfg.significance?.spaBlockSize,
      12,
      "spaBlockSize"
    ),
    benchmarkStrategyIdBySymbol: normalizeBenchmarkStrategyIdBySymbol(
      cfg.significance?.benchmarkStrategyIdBySymbol,
      datasetSymbols.map((item) => item.symbol)
    ),
  };

  const riskConfig: RiskConfig = {
    method:
      cfg.riskSimulation?.method === "iid_bootstrap"
        ? "iid_bootstrap"
        : "moving_block_bootstrap",
    simulations: toPositiveInt(cfg.riskSimulation?.simulations, 5000, "simulations"),
    horizonBars: toPositiveInt(cfg.riskSimulation?.horizonBars, 24 * 90, "horizonBars"),
    blockSize: toPositiveInt(cfg.riskSimulation?.blockSize, 24, "blockSize"),
    ruinDrawdownPct: toFiniteNumber(
      cfg.riskSimulation?.ruinDrawdownPct,
      30,
      "ruinDrawdownPct"
    ),
    maxRuinProbability: toFiniteNumber(
      cfg.riskSimulation?.maxRuinProbability,
      0.02,
      "maxRuinProbability"
    ),
    minProfitProbability: toFiniteNumber(
      cfg.riskSimulation?.minProfitProbability,
      0.55,
      "minProfitProbability"
    ),
  };

  const costModel: CostModelConfig = {
    feeRate: toFiniteNumber(cfg.costModel?.feeRate, 0.0006, "feeRate"),
    slippageBps: toFiniteNumber(cfg.costModel?.slippageBps, 8, "slippageBps"),
    latencyBars: toPositiveInt(cfg.costModel?.latencyBars, 1, "latencyBars"),
  };

  const symbolSummaries = await Promise.all(
    datasetSymbols.map((dataset) =>
      evaluateSymbolSummary({
        dataset,
        candidates,
        thresholds,
        wfoConfig: effectiveWfoConfig,
        significanceConfig,
        riskConfig,
        costModel,
      })
    )
  );

  const championSet = symbolSummaries.reduce<
    Array<ReturnType<typeof buildChampionPayload>>
  >((acc, summary) => {
    if (summary.champion !== null) {
      acc.push(buildChampionPayload(summary.symbol, summary.champion));
    }
    return acc;
  }, []);
  const legacyChampion = resolveLegacyChampion(symbolSummaries);
  const portfolioReleaseGate = aggregateReleaseGate(symbolSummaries);

  const aggregateMetrics = {
    meanPbo: mean(symbolSummaries.map((summary) => summary.aggregateMetrics.meanPbo)),
    meanDsrProbability: mean(
      symbolSummaries.map((summary) => summary.aggregateMetrics.meanDsrProbability)
    ),
    fdrQ:
      championSet.length === datasetSymbols.length && championSet.length > 0
        ? Math.max(...championSet.map((item) => item.fdrQ))
        : 1,
    fdrMethod: significanceConfig.fdrMethod,
    fdrDiagnostics: {
      method: significanceConfig.fdrMethod,
      alpha: thresholds.fdrQMax,
      candidateCount: candidates.length,
      harmonicFactorCm: null,
      storeyPi0: null,
      storeyLambda:
        significanceConfig.fdrMethod === "cv_storey_bh"
          ? significanceConfig.storeyLambda
          : null,
      cvAggQuantile:
        significanceConfig.fdrMethod === "cv_storey_bh"
          ? significanceConfig.cvAggQuantile
          : null,
      candidateWindowCounts: null,
      approximation:
        significanceConfig.fdrMethod === "stepc"
          ? "stepwise_cauchy_prefix_approximation"
          : significanceConfig.fdrMethod === "spa"
            ? "spa_uses_validation_layer_benchmark_p_values"
            : null,
      orderedPValues: null,
      stepcCombinedPValues: null,
      selectionCutoff: null,
      benchmarkStrategyId: null,
      benchmarkStrategyIndex: null,
      symbolDiagnostics: Object.fromEntries(
        symbolSummaries.map((summary) => [summary.symbol, summary.aggregateMetrics.fdrDiagnostics])
      ),
    },
    wfoProfile: effectiveWfoConfig.profile,
  };

  const missingChampionSymbols = symbolSummaries
    .filter((summary) => summary.champion === null)
    .map((summary) => summary.symbol);

  const aggregatePass =
    aggregateMetrics.meanPbo <= thresholds.meanPboMax &&
    aggregateMetrics.meanDsrProbability >= thresholds.meanDsrProbabilityMin &&
    aggregateMetrics.fdrQ <= thresholds.fdrQMax &&
    symbolSummaries.every((summary) => summary.result === "GO") &&
    missingChampionSymbols.length === 0 &&
    championSet.length > 0 &&
    portfolioReleaseGate.allowPaperTrading;

  const reasonCodes = buildPortfolioReasonCodes({
    symbolSummaries,
    thresholds,
    aggregateMetrics,
    championSetCount: championSet.length,
    requiredChampionCount: datasetSymbols.length,
    portfolioReleaseGate,
    aggregatePass,
  });
  const diagnostics = buildDiagnostics({
    symbolSummaries,
    thresholds,
  });

  const datasetConfigPayload = buildDatasetConfigPayload(datasetSymbols);

  await mkdir(dirname(resolve(args.output)), { recursive: true });
  const runPayload = {
    schemaVersion: "strategy_validation_runs.v2",
    generatedAt: new Date().toISOString(),
    config: {
      dataset: datasetConfigPayload,
      thresholds,
      wfo: effectiveWfoConfig,
      significance: significanceConfig,
      riskSimulation: riskConfig,
      costModel,
    },
    aggregateMetrics,
    champion: legacyChampion,
    championSet,
    diagnostics: {
      ...diagnostics,
      meanAverageAbsoluteCorrelation: mean(
        symbolSummaries.map((summary) => summary.candidatePoolDiagnostics.averageAbsoluteCorrelation)
      ),
      maxAbsoluteCorrelation: Math.max(
        0,
        ...symbolSummaries.map((summary) => summary.candidatePoolDiagnostics.maxAbsoluteCorrelation)
      ),
      averageAbsoluteCorrelationBySymbol: Object.fromEntries(
        symbolSummaries.map((summary) => [
          summary.symbol,
          summary.candidatePoolDiagnostics.averageAbsoluteCorrelation,
        ])
      ),
    },
    portfolio: {
      requiredSymbols: datasetSymbols.map((item) => item.symbol),
      championSet,
      missingChampionSymbols,
      aggregateMetrics,
      releaseGate: portfolioReleaseGate,
      result: aggregatePass ? "GO" : "NO_GO",
      reasonCodes,
    },
    symbols: symbolSummaries.map((summary) => ({
      symbol: summary.symbol,
      inputCsv: summary.inputCsv,
      lookbackBars: summary.lookbackBars,
      applicableCandidateCount: summary.applicableCandidateCount,
      aggregateMetrics: summary.aggregateMetrics,
      candidatePoolDiagnostics: summary.candidatePoolDiagnostics,
      leader: buildChampionPayload(summary.symbol, summary.leader),
      champion:
        summary.champion === null
          ? null
          : buildChampionPayload(summary.symbol, summary.champion),
      result: summary.result,
      reasonCodes: summary.reasonCodes,
      candidates: summary.candidates.map((run) =>
        buildDetailedCandidatePayload(summary.symbol, run)
      ),
    })),
    candidates: candidates.map((candidate) => ({
      strategyId: candidate.strategyId,
      strategyName: candidate.strategyName,
      strategy: candidate.strategy,
      role: candidate.role ?? null,
      params: candidate.params,
      applicableSymbols: candidate.applicableSymbols,
      hypothesisFamily: candidate.hypothesisFamily ?? null,
      correlationBucket: candidate.correlationBucket ?? null,
    })),
    result: aggregatePass ? "GO" : "NO_GO",
    reasonCodes,
  };
  await writeFile(resolve(args.output), `${JSON.stringify(runPayload, null, 2)}\n`, "utf-8");

  await writeReleaseGateStatus(portfolioReleaseGate, {
    filePath: args.releaseGateStatusPath,
    sourceReportPath: resolve(args.output),
  });

  const verdictPayload = {
    schemaVersion: "experiment_verdict.v2",
    generatedAt: new Date().toISOString(),
    result: aggregatePass ? "GO" : "NO_GO",
    reasonCodes,
    thresholds: {
      meanPboMax: thresholds.meanPboMax,
      meanDsrProbabilityMin: thresholds.meanDsrProbabilityMin,
      fdrQMax: thresholds.fdrQMax,
    },
    aggregateMetrics,
    champion: legacyChampion,
    championSet,
    portfolio: {
      requiredSymbols: datasetSymbols.map((item) => item.symbol),
      championSet,
      missingChampionSymbols,
      aggregateMetrics,
      releaseGate: {
        allowPaperTrading: portfolioReleaseGate.allowPaperTrading,
        allowLiveTrading: portfolioReleaseGate.allowLiveTrading,
        failedChecks: portfolioReleaseGate.failedChecks,
      },
      result: aggregatePass ? "GO" : "NO_GO",
      reasonCodes,
    },
    symbols: symbolSummaries.map((summary) => ({
      symbol: summary.symbol,
      result: summary.result,
      reasonCodes: summary.reasonCodes,
      aggregateMetrics: summary.aggregateMetrics,
      champion:
        summary.champion === null
          ? null
          : buildChampionPayload(summary.symbol, summary.champion),
      leader: buildChampionPayload(summary.symbol, summary.leader),
      candidates: summary.candidates.map((run) => ({
        symbol: summary.symbol,
        strategyId: run.candidate.strategyId,
        strategyName: run.candidate.strategyName,
        strategy: run.candidate.strategy,
        role: run.candidate.role ?? null,
        familyKey: run.familyKey,
        correlationBucket: run.correlationBucket,
        familyRepresentative: run.familyRepresentative,
        familyRepresentativeStrategyId: run.familyRepresentativeStrategyId,
        status: run.candidatePass ? "pass" : "fail",
        metrics: {
          pbo: run.admissionSignificance.pboResult.pbo,
          dsrProbability: run.admissionSignificance.dsrResult.dsrProbability,
          fdrQ: run.fdr.qValue,
        },
        candidateLevelMetrics: {
          pbo: run.significance.pboResult.pbo,
          dsrProbability: run.significance.dsrResult.dsrProbability,
          fdrQ: run.candidateLevelFdr.qValue,
        },
        releaseGate: {
          allowPaperTrading: run.releaseGate.allowPaperTrading,
          allowLiveTrading: run.releaseGate.allowLiveTrading,
          failedChecks: run.releaseGate.failedChecks,
        },
        failureReasonCode: run.failureReasons[0],
      })),
    })),
    outputPaths: {
      validationRuns: resolve(args.output),
      releaseGateStatus: resolve(args.releaseGateStatusPath),
    },
    diagnostics,
    notes:
      championSet.length > 0
        ? `championSet=${championSet
            .map((item) => `${item.symbol}:${item.strategyId}`)
            .join(",")}; legacyChampion=${legacyChampion?.strategyId ?? "none"}`
        : `legacyChampion=${legacyChampion?.strategyId ?? "none"}`,
  };
  await mkdir(dirname(resolve(args.verdictOutput)), { recursive: true });
  await writeFile(
    resolve(args.verdictOutput),
    `${JSON.stringify(verdictPayload, null, 2)}\n`,
    "utf-8"
  );

  console.log(
    [
      `runs=${resolve(args.output)}`,
      `verdict=${resolve(args.verdictOutput)}`,
      `releaseGateStatus=${resolve(args.releaseGateStatusPath)}`,
      `result=${verdictPayload.result}`,
      `reasonCodes=${reasonCodes.join(",")}`,
    ].join(" | ")
  );

  if (!aggregatePass) {
    process.exitCode = 2;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const output =
    raw.get("output") ?? "data/research/strategy/strategy_validation_runs.json";
  const multipleTestingUnit =
    raw.get("multiple-testing-unit") === "family"
      ? "family"
      : raw.get("multiple-testing-unit") === "candidate"
        ? "candidate"
        : undefined;
  return {
    candidatesFile:
      raw.get("candidates") ?? "docs/research/strategy_candidates.v1.json",
    output,
    verdictOutput:
      raw.get("verdict-output") ??
      "data/research/strategy/experiment_verdict.v2.json",
    releaseGateStatusPath:
      raw.get("release-gate-status-path") ??
      "data/runtime/release_gate_status.json",
    multipleTestingUnit,
    fdrMethod: resolveOptionalFdrMethod(raw.get("fdr-method")),
    wfoProfile: resolveOptionalWfoProfile(raw.get("wfo-profile")),
    storeyLambda: toOptionalNumber(raw.get("storey-lambda")),
    cvAggQuantile: toOptionalNumber(raw.get("cv-agg-quantile")),
    selfCheck: raw.get("self-check") === "true",
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out.set(key, "true");
      continue;
    }
    out.set(key, next);
    i += 1;
  }
  return out;
}

async function readCandidatesConfig(path: string): Promise<CandidatesFile> {
  const raw = await readFile(resolve(path), "utf-8");
  const payload = JSON.parse(raw) as CandidatesFile;
  if (!payload || typeof payload !== "object") {
    throw new Error("candidates config must be a JSON object.");
  }
  return payload;
}

function normalizeDatasetSymbols(
  dataset: CandidatesFile["dataset"]
): DatasetSymbolTarget[] {
  const fallbackLookbackBars = toPositiveInt(
    dataset?.lookbackBars,
    3000,
    "lookbackBars"
  );
  const explicitSymbols = dataset?.symbols;
  if (Array.isArray(explicitSymbols) && explicitSymbols.length > 0) {
    const seen = new Set<string>();
    return explicitSymbols.map((item, idx) => {
      if (!item || typeof item !== "object") {
        throw new Error(`dataset.symbols[${idx}] must be an object.`);
      }
      const symbol = normalizeString(item.symbol, "");
      if (!symbol) {
        throw new Error(`dataset.symbols[${idx}].symbol is required.`);
      }
      if (seen.has(symbol)) {
        throw new Error(`dataset.symbols contains duplicate symbol "${symbol}".`);
      }
      seen.add(symbol);
      const inputCsv = normalizeString(item.inputCsv, "");
      if (!inputCsv) {
        throw new Error(`dataset.symbols[${idx}].inputCsv is required.`);
      }
      return {
        symbol,
        inputCsv,
        lookbackBars: toPositiveInt(
          item.lookbackBars,
          fallbackLookbackBars,
          `dataset.symbols[${idx}].lookbackBars`
        ),
      };
    });
  }

  return [
    {
      inputCsv: dataset?.inputCsv ?? "data/market/okx/BTC_USDT_USDT_1h.csv",
      symbol: normalizeString(dataset?.symbol, "BTC/USD"),
      lookbackBars: fallbackLookbackBars,
    },
  ];
}

function normalizeCandidates(
  raw: CandidatesFile["candidates"],
  datasetSymbols: string[]
): NormalizedCandidateConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error("candidates field must be an array.");
  }
  const datasetSymbolSet = new Set(datasetSymbols);
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`candidates[${idx}] must be an object.`);
    }
    if (!isStrategyName(item.strategy)) {
      throw new Error(`candidates[${idx}].strategy is invalid.`);
    }

    const declaredSymbols = normalizeSymbolList(
      item.applicableSymbols ?? item.symbols,
      datasetSymbols
    );
    for (const symbol of declaredSymbols) {
      if (!datasetSymbolSet.has(symbol)) {
        throw new Error(
          `candidates[${idx}] declares unsupported symbol "${symbol}".`
        );
      }
    }

    return {
      strategyId: normalizeString(item.strategyId, `S${idx + 1}`),
      strategyName: normalizeString(
        item.strategyName,
        item.strategyId ?? `S${idx + 1}`
      ),
      strategy: item.strategy,
      params: (item.params ?? {}) as StrategyParams,
      applicableSymbols: declaredSymbols,
      hypothesisFamily: normalizeOptionalString(item.hypothesisFamily),
      correlationBucket: normalizeOptionalString(item.correlationBucket),
      role: normalizeCandidateRole(item.role),
    };
  });
}

function normalizeCandidateRole(
  value: unknown,
): NormalizedCandidateConfig["role"] {
  return value === "donor" ||
    value === "benchmark_control" ||
    value === "robustness_anchor" ||
    value === "independent_guard"
    ? value
    : undefined;
}

function normalizeSymbolList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [...fallback];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out.length > 0 ? out : [...fallback];
}

async function evaluateSymbolSummary(input: {
  dataset: DatasetSymbolTarget;
  candidates: NormalizedCandidateConfig[];
  thresholds: ThresholdConfig;
  wfoConfig: WfoConfig;
  significanceConfig: SignificanceConfig;
  riskConfig: RiskConfig;
  costModel: CostModelConfig;
}): Promise<SymbolSummary> {
  const applicableCandidates = input.candidates.filter((candidate) =>
    candidate.applicableSymbols.includes(input.dataset.symbol)
  );
  if (applicableCandidates.length === 0) {
    throw new Error(
      `Need at least 1 applicable candidate for ${input.dataset.symbol}; got ${applicableCandidates.length}.`
    );
  }

  const candles = (await loadCsvCandles(input.dataset.inputCsv, input.dataset.symbol)).slice(
    -input.dataset.lookbackBars
  );
  if (candles.length < input.wfoConfig.trainBars + input.wfoConfig.testBars) {
    throw new Error(
      `Not enough candles for ${input.dataset.symbol} WFO. Need >= ${
        input.wfoConfig.trainBars + input.wfoConfig.testBars
      }, got ${candles.length}.`
    );
  }

  const backtests = applicableCandidates.map((candidate) =>
    runStrategyBacktest({
      strategy: candidate.strategy,
      candles,
      params: candidate.params,
      costModel: input.costModel,
    })
  );
  const returnsByCandidate = backtests.map((report) =>
    equityCurveToReturns(report.equityCurve)
  );
  const candidatePValues = buildCandidatePValues({
    rawCandidates: applicableCandidates,
    returnsByCandidate,
    significanceConfig: input.significanceConfig,
    symbol: input.dataset.symbol,
  });

  const rawRuns: RawRun[] = applicableCandidates.map((candidate, idx) => {
    const selectedReturns = returnsByCandidate[idx];
    const significance = evaluateSignificanceGate({
      candidateReturns: returnsByCandidate,
      selectedReturns,
      partitions: input.significanceConfig.partitions,
      pboThreshold: input.significanceConfig.pboThreshold,
      dsrMin: input.significanceConfig.dsrMin,
      trialCount: applicableCandidates.length,
    });
    const riskSimulation = evaluateRiskSimulation(selectedReturns, {
      method: input.riskConfig.method,
      simulations: input.riskConfig.simulations,
      horizonBars: input.riskConfig.horizonBars,
      blockSize: input.riskConfig.blockSize,
      ruinDrawdownPct: input.riskConfig.ruinDrawdownPct,
      maxRuinProbability: input.riskConfig.maxRuinProbability,
      minProfitProbability: input.riskConfig.minProfitProbability,
    });
    const wfo = runStrategyWalkForward({
      strategy: candidate.strategy,
      candles,
      candidates: [candidate.params],
      costModel: input.costModel,
      config: {
        trainBars: input.wfoConfig.trainBars,
        testBars: input.wfoConfig.testBars,
        stepBars: input.wfoConfig.stepBars,
        degradationThreshold: input.wfoConfig.degradationThreshold,
        minTradesPerWindow: 1,
      },
    });
    const releaseGate = evaluateReleaseGate({
      wfo,
      significance,
      riskSimulation,
    });

    return {
      candidate,
      backtest: backtests[idx],
      significance,
      riskSimulation,
      wfo,
      releaseGate,
      pValue: candidatePValues[idx],
    };
  });

  const admissionView = buildAdmissionView({
    rawRuns,
    rawCandidates: applicableCandidates,
    returnsByCandidate,
    symbol: input.dataset.symbol,
    significanceConfig: input.significanceConfig,
    fdrQMax: input.thresholds.fdrQMax,
  });

  const enrichedRuns: EnrichedRun[] = rawRuns.map((run, idx) => {
    const familyKey = admissionView.familyKeyByIndex[idx];
    const familyRepresentativeIndex =
      admissionView.familyRepresentativeIndexByFamily.get(familyKey) ?? idx;
    const admissionSignificance = admissionView.admissionSignificanceByIndex[idx];
    const fdr = admissionView.admissionFdrByIndex[idx];
    const familyRepresentative = familyRepresentativeIndex === idx;
    const candidatePass =
      admissionSignificance.pboResult.pbo <= input.thresholds.meanPboMax &&
      admissionSignificance.dsrResult.dsrProbability >=
        input.thresholds.meanDsrProbabilityMin &&
      fdr.qValue <= input.thresholds.fdrQMax &&
      run.releaseGate.allowPaperTrading &&
      (input.significanceConfig.multipleTestingUnit !== "family" ||
        familyRepresentative);

    const failureReasons: string[] = [];
    if (admissionSignificance.pboResult.pbo > input.thresholds.meanPboMax) {
      failureReasons.push("HARD_PBO_THRESHOLD_FAIL");
    }
    if (
      admissionSignificance.dsrResult.dsrProbability <
      input.thresholds.meanDsrProbabilityMin
    ) {
      failureReasons.push("HARD_DSR_PROBABILITY_THRESHOLD_FAIL");
    }
    if (fdr.qValue > input.thresholds.fdrQMax) {
      failureReasons.push("HARD_FDR_THRESHOLD_FAIL");
    }
    if (!run.releaseGate.allowPaperTrading) {
      failureReasons.push("HARD_RELEASE_GATE_BLOCKED");
    }
    if (
      input.significanceConfig.multipleTestingUnit === "family" &&
      !familyRepresentative
    ) {
      failureReasons.push("FAMILY_REPRESENTATIVE_NOT_SELECTED");
    }

    return {
      ...run,
      familyKey,
      correlationBucket: admissionView.correlationBucketByIndex[idx],
      familyRepresentative,
      familyRepresentativeStrategyId:
        rawRuns[familyRepresentativeIndex]?.candidate.strategyId ??
        run.candidate.strategyId,
      candidateLevelFdr: admissionView.candidateLevelFdrItems[idx],
      admissionSignificance,
      fdr,
      candidatePass,
      failureReasons,
    };
  });

  const leader = selectHighestSharpeRun(enrichedRuns);
  if (leader === null) {
    throw new Error(`No leader candidate resolved for ${input.dataset.symbol}.`);
  }
  const champion = selectHighestSharpeRun(
    enrichedRuns.filter((run) => run.candidatePass)
  );

  const aggregateRuns =
    input.significanceConfig.multipleTestingUnit === "family"
      ? enrichedRuns.filter((run) => run.familyRepresentative)
      : enrichedRuns;

  const aggregateMetrics = {
    meanPbo: mean(
      aggregateRuns.map((run) => run.admissionSignificance.pboResult.pbo)
    ),
    meanDsrProbability: mean(
      aggregateRuns.map(
        (run) => run.admissionSignificance.dsrResult.dsrProbability
      )
    ),
    fdrQ: champion ? champion.fdr.qValue : 1,
    fdrMethod: input.significanceConfig.fdrMethod,
    fdrDiagnostics: admissionView.admissionFdrDiagnostics,
    wfoProfile: input.wfoConfig.profile,
  };

  const aggregatePass =
    aggregateMetrics.meanPbo <= input.thresholds.meanPboMax &&
    aggregateMetrics.meanDsrProbability >=
      input.thresholds.meanDsrProbabilityMin &&
    aggregateMetrics.fdrQ <= input.thresholds.fdrQMax &&
    champion !== null &&
    champion.releaseGate.allowPaperTrading;

  const reasonCodes = buildSymbolReasonCodes({
    symbol: input.dataset.symbol,
    thresholds: input.thresholds,
    aggregateMetrics,
    champion,
    aggregatePass,
  });

  return {
    symbol: input.dataset.symbol,
    inputCsv: input.dataset.inputCsv,
    lookbackBars: input.dataset.lookbackBars,
    applicableCandidateCount: applicableCandidates.length,
    aggregateMetrics,
    result: aggregatePass ? "GO" : "NO_GO",
    reasonCodes,
    leader,
    champion,
    candidates: enrichedRuns,
    candidatePoolDiagnostics: buildCandidatePoolDiagnostics(enrichedRuns, returnsByCandidate),
  };
}

function selectHighestSharpeRun(runs: EnrichedRun[]): EnrichedRun | null {
  if (runs.length === 0) {
    return null;
  }
  return [...runs].sort(
    (a, b) => b.backtest.metrics.sharpe - a.backtest.metrics.sharpe
  )[0];
}

function resolveLegacyChampion(
  summaries: SymbolSummary[]
): ReturnType<typeof buildChampionPayload> | null {
  const selectedRuns = summaries
    .filter((summary) => summary.champion !== null)
    .map((summary) => ({
      symbol: summary.symbol,
      run: summary.champion as EnrichedRun,
    }));
  if (selectedRuns.length > 0) {
    const bestSelected = [...selectedRuns].sort(
      (a, b) => b.run.backtest.metrics.sharpe - a.run.backtest.metrics.sharpe
    )[0];
    return buildChampionPayload(bestSelected.symbol, bestSelected.run);
  }

  const leaders = summaries.map((summary) => ({
    symbol: summary.symbol,
    run: summary.leader,
  }));
  if (leaders.length === 0) {
    return null;
  }
  const bestLeader = [...leaders].sort(
    (a, b) => b.run.backtest.metrics.sharpe - a.run.backtest.metrics.sharpe
  )[0];
  return buildChampionPayload(bestLeader.symbol, bestLeader.run);
}

function aggregateReleaseGate(summaries: SymbolSummary[]): ReleaseGateResult {
  const selectedChampions = summaries
    .filter((summary) => summary.champion !== null)
    .map((summary) => ({
      symbol: summary.symbol,
      releaseGate: (summary.champion as EnrichedRun).releaseGate,
    }));
  const requiredSymbols = summaries.map((summary) => summary.symbol);
  const coverageComplete = selectedChampions.length === requiredSymbols.length;
  const symbolList = requiredSymbols.join(",");
  const missingSymbols = requiredSymbols.filter(
    (symbol) => !selectedChampions.some((item) => item.symbol === symbol)
  );

  const checkNames: ReleaseGateCheck["name"][] = [
    "wfo",
    "significance",
    "risk_simulation",
    "execution_quality",
    "ramp_up",
    "regime_shift",
  ];

  const checks: ReleaseGateCheck[] = checkNames.map((name) => {
    const sourceChecks = selectedChampions
      .map((item) => item.releaseGate.checks.find((check) => check.name === name))
      .filter((check): check is ReleaseGateCheck => Boolean(check));
    const status = mergeCheckStatus(sourceChecks.map((check) => check.status));
    const summaryParts = [`symbols=${symbolList}`];
    if (!coverageComplete) {
      summaryParts.push(`missing=${missingSymbols.join(",")}`);
    }
    summaryParts.push(`sources=${sourceChecks.length}`);
    return {
      name,
      status,
      summary: summaryParts.join(" | "),
      metrics: {
        symbols: symbolList,
        selectedCount: selectedChampions.length,
        requiredCount: requiredSymbols.length,
        coverageComplete,
        missingSymbols: missingSymbols.join(",") || null,
      },
    };
  });

  let failedChecks = checks
    .filter((check) => check.status === "fail")
    .map((check) => check.name);
  const warningChecks = checks
    .filter((check) => check.status === "warn")
    .map((check) => check.name);

  if (!coverageComplete && !failedChecks.includes("significance")) {
    failedChecks = [...failedChecks, "significance"];
  }

  const paperBlockingNames: ReleaseGateCheck["name"][] = [
    "wfo",
    "significance",
    "risk_simulation",
  ];
  const liveBlockingNames: ReleaseGateCheck["name"][] = [
    "wfo",
    "significance",
    "risk_simulation",
    "execution_quality",
    "ramp_up",
    "regime_shift",
  ];

  const allowPaperTrading =
    coverageComplete &&
    !checks.some(
      (check) => paperBlockingNames.includes(check.name) && check.status === "fail"
    );
  const allowLiveTrading =
    coverageComplete &&
    !checks.some(
      (check) => liveBlockingNames.includes(check.name) && check.status === "fail"
    );

  return {
    checks,
    failedChecks: uniqueReleaseCheckNames(failedChecks),
    warningChecks: uniqueReleaseCheckNames(warningChecks),
    hardFail: !coverageComplete || failedChecks.length > 0,
    allowPaperTrading,
    allowLiveTrading,
  };
}

function mergeCheckStatus(statuses: ReleaseGateStatus[]): ReleaseGateStatus {
  if (statuses.length === 0) {
    return "skipped";
  }
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  if (statuses.every((status) => status === "skipped")) {
    return "skipped";
  }
  return "pass";
}

function uniqueReleaseCheckNames(
  values: ReleaseGateCheck["name"][]
): ReleaseGateCheck["name"][] {
  return Array.from(new Set(values));
}

function buildChampionPayload(symbol: string, run: EnrichedRun) {
  return {
    symbol,
    strategyId: run.candidate.strategyId,
    strategyName: run.candidate.strategyName,
    strategy: run.candidate.strategy,
    role: run.candidate.role ?? null,
    sharpe: run.backtest.metrics.sharpe,
    releaseGateAllowPaper: run.releaseGate.allowPaperTrading,
    releaseGateAllowLive: run.releaseGate.allowLiveTrading,
    fdrQ: run.fdr.qValue,
    familyKey: run.familyKey,
    correlationBucket: run.correlationBucket,
    applicableSymbols: run.candidate.applicableSymbols,
  };
}

function buildDetailedCandidatePayload(symbol: string, run: EnrichedRun) {
  return {
    symbol,
    strategyId: run.candidate.strategyId,
    strategyName: run.candidate.strategyName,
    strategy: run.candidate.strategy,
    role: run.candidate.role ?? null,
    familyKey: run.familyKey,
    correlationBucket: run.correlationBucket,
    familyRepresentative: run.familyRepresentative,
    familyRepresentativeStrategyId: run.familyRepresentativeStrategyId,
    params: run.candidate.params,
    applicableSymbols: run.candidate.applicableSymbols,
    status: run.candidatePass ? "pass" : "fail",
    failureReasons: run.failureReasons,
    backtestMetrics: run.backtest.metrics,
    wfo: {
      config: run.wfo.config,
      overallPassed: run.wfo.overallPassed,
      failedWindows: run.wfo.failedWindows,
      windowCount: run.wfo.windows.length,
      windows: run.wfo.windows.map((window) => ({
        windowIndex: window.windowIndex,
        selectedCandidateId: window.selectedCandidate.id,
        inSample: window.inSample,
        outOfSample: window.outOfSample,
        degradationRate: window.degradationRate,
        gatePassed: window.gatePassed,
        gateReason: window.gateReason ?? null,
      })),
    },
    significance: {
      pbo: run.admissionSignificance.pboResult.pbo,
      dsrValue: run.admissionSignificance.dsrResult.dsrValue,
      dsrProbability: run.admissionSignificance.dsrResult.dsrProbability,
    },
    fdr: run.fdr,
    candidateLevelSignificance: {
      pbo: run.significance.pboResult.pbo,
      dsrValue: run.significance.dsrResult.dsrValue,
      dsrProbability: run.significance.dsrResult.dsrProbability,
    },
    candidateLevelFdr: run.candidateLevelFdr,
    releaseGate: run.releaseGate,
  };
}

function buildDatasetConfigPayload(datasetSymbols: DatasetSymbolTarget[]) {
  const primary = datasetSymbols[0];
  return {
    inputCsv: primary.inputCsv,
    symbol: primary.symbol,
    lookbackBars: primary.lookbackBars,
    symbols: datasetSymbols.map((item) => ({
      inputCsv: item.inputCsv,
      symbol: item.symbol,
      lookbackBars: item.lookbackBars,
    })),
  };
}

function buildDiagnostics(input: {
  symbolSummaries: SymbolSummary[];
  thresholds: ThresholdConfig;
}) {
  const entries = input.symbolSummaries.flatMap((summary) =>
    summary.candidates.map((run) => ({
      symbol: summary.symbol,
      strategyId: run.candidate.strategyId,
      strategyName: run.candidate.strategyName,
      strategy: run.candidate.strategy,
      role: run.candidate.role ?? null,
      sharpe: run.backtest.metrics.sharpe,
      pbo: run.admissionSignificance.pboResult.pbo,
      dsrProbability: run.admissionSignificance.dsrResult.dsrProbability,
      fdrQ: run.fdr.qValue,
      failedWindowRatio: extractFailedWindowRatio(run.releaseGate),
    }))
  );
  const donorEntries = entries.filter((entry) => entry.role === "donor");
  const nonControlEntries = entries.filter(
    (entry) => entry.role !== "benchmark_control",
  );
  const controlEntries = entries.filter(
    (entry) => entry.role !== null && entry.role !== "donor",
  );
  const strongestControl =
    rankDiagnosticEntries(controlEntries)[0] ?? null;
  const strongestNonControlBySymbol = new Map<string, typeof entries[number]>();
  const strongestDonorBySymbol = new Map<string, typeof entries[number]>();
  for (const summary of input.symbolSummaries) {
    const symbolEntries = entries.filter((entry) => entry.symbol === summary.symbol);
    const strongestNonControl = rankDiagnosticEntries(
      symbolEntries.filter((entry) => entry.role !== "benchmark_control"),
    )[0];
    if (strongestNonControl) {
      strongestNonControlBySymbol.set(summary.symbol, strongestNonControl);
    }
    const strongestDonor = rankDiagnosticEntries(
      symbolEntries.filter((entry) => entry.role === "donor"),
    )[0];
    if (strongestDonor) {
      strongestDonorBySymbol.set(summary.symbol, strongestDonor);
    }
  }

  return {
    donorOnlyAggregateMetrics: buildDiagnosticAggregateMetrics(donorEntries, {
      thresholds: input.thresholds,
      donorIsChampion:
        input.symbolSummaries.length > 0 &&
        input.symbolSummaries.every(
          (summary) => summary.champion?.candidate.role === "donor",
        ),
    }),
    nonControlAggregateMetrics: buildDiagnosticAggregateMetrics(nonControlEntries, {
      thresholds: input.thresholds,
    }),
    controlSetDiagnostics: {
      benchmarkControl:
        controlEntries.find((entry) => entry.role === "benchmark_control") ?? null,
      controls: controlEntries,
      strongestControl,
    },
    questions: {
      donorSelfPassesThresholds:
        donorEntries.length > 0 &&
        donorEntries.every(
          (entry) =>
            entry.pbo <= input.thresholds.meanPboMax &&
            entry.dsrProbability >= input.thresholds.meanDsrProbabilityMin &&
            entry.fdrQ <= input.thresholds.fdrQMax,
        ),
      donorLeadsNonControls:
        input.symbolSummaries.length > 0 &&
        input.symbolSummaries.every(
          (summary) =>
            strongestNonControlBySymbol.get(summary.symbol)?.role === "donor",
        ),
      controlsAreStrongerThanDonor:
        input.symbolSummaries.some((summary) => {
          const strongestNonControl = strongestNonControlBySymbol.get(summary.symbol);
          const strongestDonor = strongestDonorBySymbol.get(summary.symbol);
          return Boolean(
            strongestNonControl &&
              strongestNonControl.role !== "donor" &&
              strongestDonor &&
              compareDiagnosticEntries(strongestNonControl, strongestDonor) < 0,
          );
        }),
    },
  };
}

function buildDiagnosticAggregateMetrics(
  entries: Array<{
    pbo: number;
    dsrProbability: number;
    fdrQ: number;
    role: string | null;
    strategyId?: string;
    failedWindowRatio: number | null;
  }>,
  extras: {
    thresholds: ThresholdConfig;
    donorIsChampion?: boolean;
  },
) {
  if (entries.length < 1) {
    return null;
  }
  return {
    meanPbo: mean(entries.map((entry) => entry.pbo)),
    meanDsrProbability: mean(entries.map((entry) => entry.dsrProbability)),
    fdrQ: Math.max(...entries.map((entry) => entry.fdrQ)),
    maxFailedWindowRatio: entries
      .map((entry) => entry.failedWindowRatio)
      .filter((value): value is number => value !== null)
      .reduce((acc, value) => Math.max(acc, value), 0),
    donorIsChampion: extras.donorIsChampion ?? null,
    passesThresholds:
      entries.every((entry) => entry.pbo <= extras.thresholds.meanPboMax) &&
      entries.every(
        (entry) => entry.dsrProbability >= extras.thresholds.meanDsrProbabilityMin,
      ) &&
      entries.every((entry) => entry.fdrQ <= extras.thresholds.fdrQMax),
  };
}

function extractFailedWindowRatio(releaseGate: ReleaseGateResult): number | null {
  const wfoCheck = releaseGate.checks.find((check) => check.name === "wfo");
  const failedWindowRatio =
    wfoCheck && typeof wfoCheck.metrics?.failedWindowRatio === "number"
      ? wfoCheck.metrics.failedWindowRatio
      : Number(wfoCheck?.metrics?.failedWindowRatio);
  return Number.isFinite(failedWindowRatio) ? failedWindowRatio : null;
}

function rankDiagnosticEntries<T extends {
  fdrQ: number;
  sharpe: number;
  dsrProbability: number;
  pbo: number;
}>(entries: T[]): T[] {
  return [...entries].sort(compareDiagnosticEntries);
}

function compareDiagnosticEntries(
  left: { fdrQ: number; sharpe: number; dsrProbability: number; pbo: number },
  right: { fdrQ: number; sharpe: number; dsrProbability: number; pbo: number },
): number {
  if (left.fdrQ !== right.fdrQ) {
    return left.fdrQ - right.fdrQ;
  }
  if (left.sharpe !== right.sharpe) {
    return right.sharpe - left.sharpe;
  }
  if (left.dsrProbability !== right.dsrProbability) {
    return right.dsrProbability - left.dsrProbability;
  }
  if (left.pbo !== right.pbo) {
    return left.pbo - right.pbo;
  }
  return 0;
}

function buildCandidatePoolDiagnostics(
  runs: EnrichedRun[],
  returnsByCandidate: number[][]
): CandidatePoolDiagnostics {
  const candidateOrder = runs.map((run) => ({
    strategyId: run.candidate.strategyId,
    strategyName: run.candidate.strategyName,
    familyKey: run.familyKey,
    correlationBucket: run.correlationBucket,
  }));

  const correlationMatrix = returnsByCandidate.map((leftReturns, leftIdx) =>
    returnsByCandidate.map((rightReturns, rightIdx) => {
      if (leftIdx === rightIdx) {
        return 1;
      }
      return pearsonCorrelation(leftReturns, rightReturns);
    })
  );

  const pairs: CandidateCorrelationPair[] = [];
  const absoluteCorrelations: number[] = [];
  for (let i = 0; i < correlationMatrix.length; i++) {
    for (let j = i + 1; j < correlationMatrix[i].length; j++) {
      const correlation = correlationMatrix[i][j];
      absoluteCorrelations.push(Math.abs(correlation));
      pairs.push({
        leftStrategyId: candidateOrder[i].strategyId,
        rightStrategyId: candidateOrder[j].strategyId,
        leftFamilyKey: candidateOrder[i].familyKey,
        rightFamilyKey: candidateOrder[j].familyKey,
        leftCorrelationBucket: candidateOrder[i].correlationBucket,
        rightCorrelationBucket: candidateOrder[j].correlationBucket,
        correlation,
      });
    }
  }

  const familyGroups = Array.from(
    runs.reduce<Map<string, CandidateFamilyGroup>>((acc, run) => {
      const existing = acc.get(run.familyKey) ?? {
        familyKey: run.familyKey,
        candidateCount: 0,
        members: [],
      };
      existing.members.push({
        strategyId: run.candidate.strategyId,
        strategyName: run.candidate.strategyName,
        strategy: run.candidate.strategy,
      });
      existing.candidateCount = existing.members.length;
      acc.set(run.familyKey, existing);
      return acc;
    }, new Map()).values()
  ).sort((a, b) => b.candidateCount - a.candidateCount || a.familyKey.localeCompare(b.familyKey));

  return {
    candidateOrder,
    familyGroups,
    correlationMatrix: correlationMatrix.map((row) =>
      row.map((value) => Number(value.toFixed(6)))
    ),
    averageAbsoluteCorrelation: Number(mean(absoluteCorrelations).toFixed(6)),
    maxAbsoluteCorrelation: Number(
      Math.max(0, ...absoluteCorrelations).toFixed(6)
    ),
    topCorrelatedPairs: pairs
      .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))
      .slice(0, 10)
      .map((pair) => ({
        ...pair,
        correlation: Number(pair.correlation.toFixed(6)),
      })),
  };
}

function deriveCandidateFamilyKey(candidate: NormalizedCandidateConfig): string {
  if (candidate.hypothesisFamily) {
    return candidate.hypothesisFamily;
  }
  const rawTokens = `${candidate.strategyName} ${candidate.strategyId}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const ignoredTokens = new Set([
    candidate.strategy.toLowerCase(),
    "btc",
    "eth",
    "usd",
    "usdt",
    "dual",
    "route",
    "batch",
    "control",
    "classic",
  ]);
  const semanticTokens = rawTokens.filter((token) => {
    if (ignoredTokens.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    if (/^[a-z]\d+$/.test(token)) return false;
    if (/^v\d+$/.test(token)) return false;
    return true;
  });
  const deduped = Array.from(new Set(semanticTokens)).slice(0, 3);
  return deduped.length > 0
    ? [candidate.strategy, ...deduped].join(":")
    : candidate.strategy;
}

function deriveCandidateCorrelationBucket(
  candidate: NormalizedCandidateConfig
): string {
  return candidate.correlationBucket ?? deriveCandidateFamilyKey(candidate);
}

function buildAdmissionView(input: {
  rawRuns: RawRun[];
  rawCandidates: NormalizedCandidateConfig[];
  returnsByCandidate: number[][];
  symbol: string;
  significanceConfig: SignificanceConfig;
  fdrQMax: number;
}): AdmissionView {
  const familyKeyByIndex = input.rawRuns.map((run) =>
    deriveCandidateFamilyKey(run.candidate)
  );
  const correlationBucketByIndex = input.rawRuns.map((run) =>
    deriveCandidateCorrelationBucket(run.candidate)
  );
  const candidatePValues = buildCandidatePValues({
    rawCandidates: input.rawCandidates,
    returnsByCandidate: input.returnsByCandidate,
    significanceConfig: input.significanceConfig,
    symbol: input.symbol,
  });
  const candidateLevelWindowPValues =
    input.significanceConfig.fdrMethod === "cv_storey_bh"
      ? buildWindowPValuesByCandidate({
          returnsByCandidate: input.returnsByCandidate,
          trialCount: input.rawRuns.length,
          partitions: input.significanceConfig.partitions,
        })
      : undefined;
  const candidateLevelFdr = runFdrCorrection({
    pValues: candidatePValues,
    alpha: input.fdrQMax,
    method: input.significanceConfig.fdrMethod,
    storeyLambda: input.significanceConfig.storeyLambda,
    cvAggQuantile: input.significanceConfig.cvAggQuantile,
    windowPValuesByCandidate: candidateLevelWindowPValues,
    benchmarkStrategyId:
      input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol] ??
      input.rawCandidates[0]?.strategyId ??
      null,
    benchmarkStrategyIndex: resolveSymbolBenchmarkIndex({
      candidates: input.rawCandidates,
      significanceConfig: input.significanceConfig,
      symbol: input.symbol,
    }),
  });
  const familyRepresentativeIndexByFamily =
    resolveFamilyRepresentativeIndexByFamily(input.rawRuns, familyKeyByIndex);

  if (input.significanceConfig.multipleTestingUnit !== "family") {
    return {
      candidateLevelFdrItems: candidateLevelFdr.items,
      candidateLevelFdrDiagnostics: candidateLevelFdr.diagnostics,
      admissionSignificanceByIndex: input.rawRuns.map((run) => run.significance),
      admissionFdrByIndex: candidateLevelFdr.items,
      admissionFdrDiagnostics: candidateLevelFdr.diagnostics,
      familyKeyByIndex,
      correlationBucketByIndex,
      familyRepresentativeIndexByFamily,
    };
  }

  const representativeIndices = Array.from(
    familyRepresentativeIndexByFamily.values()
  ).sort((left, right) => left - right);
  if (representativeIndices.length < 3) {
    throw new Error(
      `Need at least 3 distinct hypothesis families for family admission; got ${representativeIndices.length}.`
    );
  }

  const representativeReturns = representativeIndices.map(
    (index) => input.returnsByCandidate[index]
  );
  const representativeCandidates = representativeIndices.map(
    (index) => input.rawCandidates[index]
  );
  const representativeSignificance = representativeIndices.map((_, index) =>
    evaluateSignificanceGate({
      candidateReturns: representativeReturns,
      selectedReturns: representativeReturns[index],
      partitions: input.significanceConfig.partitions,
      pboThreshold: input.significanceConfig.pboThreshold,
      dsrMin: input.significanceConfig.dsrMin,
      trialCount: representativeIndices.length,
    })
  );
  const representativeWindowPValues =
    input.significanceConfig.fdrMethod === "cv_storey_bh"
      ? buildWindowPValuesByCandidate({
          returnsByCandidate: representativeReturns,
          trialCount: representativeIndices.length,
          partitions: input.significanceConfig.partitions,
        })
      : undefined;
  const representativePValues = buildCandidatePValues({
    rawCandidates: representativeCandidates,
    returnsByCandidate: representativeReturns,
    significanceConfig: input.significanceConfig,
    symbol: input.symbol,
  });
  const representativeFdr = runFdrCorrection({
    pValues: representativePValues,
    alpha: input.fdrQMax,
    method: input.significanceConfig.fdrMethod,
    storeyLambda: input.significanceConfig.storeyLambda,
    cvAggQuantile: input.significanceConfig.cvAggQuantile,
    windowPValuesByCandidate: representativeWindowPValues,
    benchmarkStrategyId:
      input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol] ??
      representativeCandidates[0]?.strategyId ??
      null,
    benchmarkStrategyIndex: resolveSymbolBenchmarkIndex({
      candidates: representativeCandidates,
      significanceConfig: input.significanceConfig,
      symbol: input.symbol,
    }),
  });
  const familyRepresentativeRank = new Map<string, number>();
  representativeIndices.forEach((index, rank) => {
    familyRepresentativeRank.set(familyKeyByIndex[index], rank);
  });

  return {
    candidateLevelFdrItems: candidateLevelFdr.items,
    candidateLevelFdrDiagnostics: candidateLevelFdr.diagnostics,
    admissionSignificanceByIndex: input.rawRuns.map((_, index) => {
      const rank = familyRepresentativeRank.get(familyKeyByIndex[index]) ?? 0;
      return representativeSignificance[rank];
    }),
    admissionFdrByIndex: input.rawRuns.map((_, index) => {
      const rank = familyRepresentativeRank.get(familyKeyByIndex[index]) ?? 0;
      return representativeFdr.items[rank];
    }),
    admissionFdrDiagnostics: representativeFdr.diagnostics,
    familyKeyByIndex,
    correlationBucketByIndex,
    familyRepresentativeIndexByFamily,
  };
}

function buildCandidatePValues(input: {
  rawCandidates: NormalizedCandidateConfig[];
  returnsByCandidate: number[][];
  significanceConfig: SignificanceConfig;
  symbol: string;
}): number[] {
  if (input.significanceConfig.fdrMethod !== "spa") {
    return input.returnsByCandidate.map((_, index) =>
      clamp01(1 - computeDeflatedSharpe({
        returns: input.returnsByCandidate[index],
        trialCount: input.rawCandidates.length,
      }).dsrProbability)
    );
  }

  const benchmarkIndex = resolveSymbolBenchmarkIndex({
    candidates: input.rawCandidates,
    significanceConfig: input.significanceConfig,
    symbol: input.symbol,
  });
  const spa = computeSpaLikePValues({
    candidateReturns: input.returnsByCandidate,
    benchmarkIndex,
    bootstrapSamples: input.significanceConfig.spaBootstrapSamples,
    blockSize: input.significanceConfig.spaBlockSize,
  });
  return spa.items.map((item) => clamp01(item.pValue));
}

function resolveSymbolBenchmarkIndex(input: {
  candidates: NormalizedCandidateConfig[];
  significanceConfig: SignificanceConfig;
  symbol: string;
}): number {
  const configuredId =
    input.significanceConfig.benchmarkStrategyIdBySymbol[input.symbol];
  if (configuredId) {
    const configuredIndex = input.candidates.findIndex(
      (candidate) => candidate.strategyId === configuredId,
    );
    if (configuredIndex >= 0) {
      return configuredIndex;
    }
  }
  return 0;
}

function buildWindowPValuesByCandidate(input: {
  returnsByCandidate: number[][];
  trialCount: number;
  partitions: number;
}): number[][] {
  return input.returnsByCandidate.map((returns) => {
    const windows = splitReturnsIntoCvWindows(returns, input.partitions);
    return windows.map((windowReturns) =>
      clamp01(
        1 -
          computeDeflatedSharpe({
            returns: windowReturns,
            trialCount: input.trialCount,
          }).dsrProbability
      )
    );
  });
}

function splitReturnsIntoCvWindows(returns: number[], partitions: number): number[][] {
  const targetWindowCount = Math.max(3, partitions * 3);
  const maxWindowCount = Math.max(1, Math.floor(returns.length / 4));
  const windowCount = Math.max(1, Math.min(targetWindowCount, maxWindowCount));
  const blockSize = Math.max(4, Math.floor(returns.length / windowCount));
  const windows: number[][] = [];
  for (let index = 0; index < windowCount; index++) {
    const start = index * blockSize;
    const end = index === windowCount - 1 ? returns.length : Math.min(returns.length, start + blockSize);
    const slice = returns.slice(start, end);
    if (slice.length >= 4) {
      windows.push(slice);
    }
  }
  return windows.length > 0 ? windows : [returns];
}

function resolveFamilyRepresentativeIndexByFamily(
  runs: RawRun[],
  familyKeyByIndex: string[]
): Map<string, number> {
  const out = new Map<string, number>();
  familyKeyByIndex.forEach((familyKey, index) => {
    const existingIndex = out.get(familyKey);
    if (existingIndex === undefined) {
      out.set(familyKey, index);
      return;
    }
    if (isPreferredFamilyRepresentative(runs[index], runs[existingIndex])) {
      out.set(familyKey, index);
    }
  });
  return out;
}

function isPreferredFamilyRepresentative(
  candidate: RawRun,
  existing: RawRun
): boolean {
  const sharpeDelta =
    candidate.backtest.metrics.sharpe - existing.backtest.metrics.sharpe;
  if (Math.abs(sharpeDelta) > 1e-9) {
    return sharpeDelta > 0;
  }
  const pValueDelta = candidate.pValue - existing.pValue;
  if (Math.abs(pValueDelta) > 1e-9) {
    return pValueDelta < 0;
  }
  return candidate.candidate.strategyId.localeCompare(
    existing.candidate.strategyId
  ) < 0;
}

function buildSymbolReasonCodes(input: {
  symbol: string;
  thresholds: ThresholdConfig;
  aggregateMetrics: {
    meanPbo: number;
    meanDsrProbability: number;
    fdrQ: number;
  };
  champion: EnrichedRun | null;
  aggregatePass: boolean;
}): string[] {
  const reasonCodes: string[] = [];
  if (input.aggregateMetrics.meanPbo > input.thresholds.meanPboMax) {
    reasonCodes.push("HARD_MEAN_PBO_THRESHOLD_FAIL");
  }
  if (
    input.aggregateMetrics.meanDsrProbability <
    input.thresholds.meanDsrProbabilityMin
  ) {
    reasonCodes.push("HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL");
  }
  if (input.aggregateMetrics.fdrQ > input.thresholds.fdrQMax) {
    reasonCodes.push("HARD_FDR_THRESHOLD_FAIL");
  }
  if (input.champion === null) {
    reasonCodes.push("HARD_NO_CANDIDATE_PASS");
  } else if (!input.champion.releaseGate.allowPaperTrading) {
    reasonCodes.push("HARD_RELEASE_GATE_BLOCKED");
  }
  if (reasonCodes.length === 0 && input.aggregatePass) {
    reasonCodes.push("INFO_MVP_THRESHOLDS_PASS");
  }
  return reasonCodes;
}

function buildPortfolioReasonCodes(input: {
  symbolSummaries: SymbolSummary[];
  thresholds: ThresholdConfig;
  aggregateMetrics: {
    meanPbo: number;
    meanDsrProbability: number;
    fdrQ: number;
  };
  championSetCount: number;
  requiredChampionCount: number;
  portfolioReleaseGate: ReleaseGateResult;
  aggregatePass: boolean;
}): string[] {
  const reasonCodes: string[] = [];
  if (input.aggregateMetrics.meanPbo > input.thresholds.meanPboMax) {
    reasonCodes.push("HARD_MEAN_PBO_THRESHOLD_FAIL");
  }
  if (
    input.aggregateMetrics.meanDsrProbability <
    input.thresholds.meanDsrProbabilityMin
  ) {
    reasonCodes.push("HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL");
  }
  if (input.aggregateMetrics.fdrQ > input.thresholds.fdrQMax) {
    reasonCodes.push("HARD_FDR_THRESHOLD_FAIL");
  }
  if (input.championSetCount === 0) {
    reasonCodes.push("HARD_NO_CANDIDATE_PASS");
  }
  if (input.championSetCount < input.requiredChampionCount) {
    reasonCodes.push("HARD_PORTFOLIO_CHAMPION_SET_INCOMPLETE");
  }
  if (!input.portfolioReleaseGate.allowPaperTrading) {
    reasonCodes.push("HARD_RELEASE_GATE_BLOCKED");
  }
  for (const summary of input.symbolSummaries) {
    if (summary.result !== "GO") {
      reasonCodes.push(`HARD_SYMBOL_NO_GO:${summary.symbol}`);
    }
  }
  if (reasonCodes.length === 0 && input.aggregatePass) {
    reasonCodes.push("INFO_MVP_THRESHOLDS_PASS");
  }
  return Array.from(new Set(reasonCodes));
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function resolveFdrMethod(value: string): FdrMethod {
  if (
    value === "by" ||
    value === "cv_storey_bh" ||
    value === "stepc" ||
    value === "spa"
  ) {
    return value;
  }
  return "bh";
}

function resolveOptionalFdrMethod(value: unknown): FdrMethod | undefined {
  return typeof value === "string" && value.trim()
    ? resolveFdrMethod(value.trim())
    : undefined;
}

function normalizeBenchmarkStrategyIdBySymbol(
  value: unknown,
  allowedSymbols: string[],
): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const allowed = new Set(allowedSymbols);
  const out: Record<string, string> = {};
  for (const [symbol, strategyId] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (
      allowed.has(symbol) &&
      typeof strategyId === "string" &&
      strategyId.trim()
    ) {
      out[symbol] = strategyId.trim();
    }
  }
  return out;
}

function resolveOptionalWfoProfile(value: unknown): WfoProfile | undefined {
  if (value === "shift" || value === "stress" || value === "stable") {
    return value;
  }
  return undefined;
}

function resolveWfoProfile(config: WfoConfig): WfoConfig {
  if (config.profile === "shift") {
    return {
      ...config,
      trainBars: roundBars(
        Math.max(config.testBars * 3, Math.round(config.trainBars * 0.875))
      ),
      testBars: roundBars(config.testBars),
      stepBars: roundBars(Math.max(1, Math.round(config.testBars * 0.75))),
    };
  }
  if (config.profile === "stress") {
    return {
      ...config,
      trainBars: roundBars(Math.round(config.trainBars * 1.1)),
      testBars: roundBars(Math.max(config.testBars, Math.round(config.testBars * 1.5))),
      stepBars: roundBars(Math.max(config.stepBars, config.testBars)),
      degradationThreshold: Number(Math.max(0.2, config.degradationThreshold * 0.875).toFixed(6)),
    };
  }
  return config;
}

function roundBars(value: number): number {
  return Math.max(1, Math.round(value));
}

function toProbability(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${field} must be in (0, 1).`);
  }
  return value;
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isStrategyName(value: unknown): value is StrategyName {
  return (
    value === "trend" ||
    value === "regimeTrend" ||
    value === "meanReversion" ||
    value === "breakout" ||
    value === "ensemble"
  );
}

function toPositiveInt(value: unknown, fallback: number, label: string): number {
  if (value == null) return fallback;
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return num;
}

function toFiniteNumber(value: unknown, fallback: number, label: string): number {
  if (value == null) return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new Error(`${label} must be finite.`);
  }
  return num;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function pearsonCorrelation(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  if (length < 2) {
    return 0;
  }

  const leftAligned = left.slice(left.length - length);
  const rightAligned = right.slice(right.length - length);
  const leftMean = mean(leftAligned);
  const rightMean = mean(rightAligned);

  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let i = 0; i < length; i++) {
    const leftCentered = leftAligned[i] - leftMean;
    const rightCentered = rightAligned[i] - rightMean;
    covariance += leftCentered * rightCentered;
    leftVariance += leftCentered * leftCentered;
    rightVariance += rightCentered * rightCentered;
  }

  if (leftVariance <= 0 || rightVariance <= 0) {
    return 0;
  }

  return covariance / Math.sqrt(leftVariance * rightVariance);
}

function equityCurveToReturns(curve: Array<{ time: number; equity: number }>): number[] {
  const returns: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    const next = curve[i].equity;
    if (prev > 0 && Number.isFinite(prev) && Number.isFinite(next)) {
      returns.push(next / prev - 1);
    }
  }
  return returns;
}

async function loadCsvCandles(path: string, symbol: string): Promise<MarketData[]> {
  const raw = await readFile(resolve(path), "utf-8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error(`CSV has no rows: ${path}`);
  }

  const header = lines[0].split(",");
  const idx = {
    timestamp: header.indexOf("timestamp"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
    volume: header.indexOf("volume"),
  };
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0) {
      throw new Error(`CSV missing required column "${name}": ${path}`);
    }
  }

  const out: MarketData[] = [];
  for (const row of lines.slice(1)) {
    const cols = row.split(",");
    const tsMs = Number(cols[idx.timestamp]);
    const open = Number(cols[idx.open]);
    const high = Number(cols[idx.high]);
    const low = Number(cols[idx.low]);
    const close = Number(cols[idx.close]);
    const volume = Number(cols[idx.volume]);
    if (
      !Number.isFinite(tsMs) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      !Number.isFinite(volume)
    ) {
      continue;
    }
    out.push({
      symbol,
      time: Math.floor(tsMs / 1000),
      open,
      high,
      low,
      close,
      volume,
    });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

function runSelfCheck(): void {
  const trendFamily = deriveCandidateFamilyKey({
    strategyId: "C4",
    strategyName: "trend_eth_30_55_confirm3_band020",
    strategy: "trend",
    params: {},
    applicableSymbols: ["ETH/USD"],
  });
  if (trendFamily !== "trend:confirm3:band020") {
    throw new Error(`unexpected family key: ${trendFamily}`);
  }

  const explicitFamily = deriveCandidateFamilyKey({
    strategyId: "B3-ETH-01",
    strategyName: "trend_eth_30_55_confirm3_band020",
    strategy: "trend",
    params: {},
    applicableSymbols: ["ETH/USD"],
    hypothesisFamily: "eth_high_dsr_core",
  });
  if (explicitFamily !== "eth_high_dsr_core") {
    throw new Error(`unexpected explicit family key: ${explicitFamily}`);
  }

  const explicitBucket = deriveCandidateCorrelationBucket({
    strategyId: "B3-ETH-01",
    strategyName: "trend_eth_30_55_confirm3_band020",
    strategy: "trend",
    params: {},
    applicableSymbols: ["ETH/USD"],
    correlationBucket: "eth_confirmed_fast",
  });
  if (explicitBucket !== "eth_confirmed_fast") {
    throw new Error(`unexpected explicit correlation bucket: ${explicitBucket}`);
  }

  const corr = pearsonCorrelation([1, 2, 3, 4], [2, 4, 6, 8]);
  if (Math.abs(corr - 1) > 1e-9) {
    throw new Error(`unexpected perfect positive correlation: ${corr}`);
  }

  const diagnostics = buildCandidatePoolDiagnostics(
    [
      {
        candidate: {
          strategyId: "A1",
          strategyName: "trend_confirm2_band010",
          strategy: "trend",
          params: {},
          applicableSymbols: ["BTC/USD"],
          hypothesisFamily: "trend_confirm_family",
          correlationBucket: "confirm_bucket",
        },
        backtest: null as unknown as BacktestReport,
        significance: null as unknown as SignificanceResult,
        riskSimulation: null as unknown as RiskSimulationResult,
        wfo: null as unknown as WfoResult,
        releaseGate: null as unknown as ReleaseGateResult,
        pValue: 0.1,
        familyKey: "trend_confirm_family",
        correlationBucket: "confirm_bucket",
        familyRepresentative: true,
        familyRepresentativeStrategyId: "A1",
        candidateLevelFdr: {
          index: 0,
          rank: 1,
          pValue: 0.1,
          qValue: 0.1,
          threshold: 0.1,
          passed: true,
        },
        admissionSignificance: null as unknown as SignificanceResult,
        fdr: { index: 0, rank: 1, pValue: 0.1, qValue: 0.1, threshold: 0.1, passed: true },
        candidatePass: true,
        failureReasons: [],
      },
      {
        candidate: {
          strategyId: "A2",
          strategyName: "trend_confirm2_band010",
          strategy: "trend",
          params: {},
          applicableSymbols: ["BTC/USD"],
          hypothesisFamily: "trend_confirm_family",
          correlationBucket: "confirm_bucket",
        },
        backtest: null as unknown as BacktestReport,
        significance: null as unknown as SignificanceResult,
        riskSimulation: null as unknown as RiskSimulationResult,
        wfo: null as unknown as WfoResult,
        releaseGate: null as unknown as ReleaseGateResult,
        pValue: 0.2,
        familyKey: "trend_confirm_family",
        correlationBucket: "confirm_bucket",
        familyRepresentative: false,
        familyRepresentativeStrategyId: "A1",
        candidateLevelFdr: {
          index: 1,
          rank: 2,
          pValue: 0.2,
          qValue: 0.2,
          threshold: 0.2,
          passed: true,
        },
        admissionSignificance: null as unknown as SignificanceResult,
        fdr: { index: 1, rank: 2, pValue: 0.2, qValue: 0.2, threshold: 0.2, passed: true },
        candidatePass: true,
        failureReasons: [],
      },
    ],
    [
      [0.01, 0.02, 0.03, 0.04],
      [0.02, 0.04, 0.06, 0.08],
    ]
  );
  if (diagnostics.familyGroups.length !== 1) {
    throw new Error(`expected one family group, got ${diagnostics.familyGroups.length}`);
  }
  if (diagnostics.averageAbsoluteCorrelation < 0.99) {
    throw new Error(
      `expected strong average absolute correlation, got ${diagnostics.averageAbsoluteCorrelation}`
    );
  }

  const diagnosticSummary = buildDiagnostics({
    symbolSummaries: [
      {
        symbol: "BTC/USD",
        inputCsv: "x.csv",
        lookbackBars: 1000,
        applicableCandidateCount: 2,
        aggregateMetrics: {
          meanPbo: 0.1,
          meanDsrProbability: 0.6,
          fdrQ: 0.08,
          fdrMethod: "spa",
          fdrDiagnostics: null as unknown as FdrDiagnostics,
          wfoProfile: "stable",
        },
        result: "NO_GO",
        reasonCodes: [],
        leader: {
          candidate: {
            strategyId: "D1",
            strategyName: "donor",
            strategy: "trend",
            params: {},
            applicableSymbols: ["BTC/USD"],
            role: "donor",
          },
          backtest: { metrics: { sharpe: 2 } } as unknown as BacktestReport,
          significance: null as unknown as SignificanceResult,
          riskSimulation: null as unknown as RiskSimulationResult,
          wfo: null as unknown as WfoResult,
          releaseGate: {
            checks: [
              {
                name: "wfo",
                status: "fail",
                summary: "",
                metrics: { failedWindowRatio: 0.4 },
              },
            ],
            failedChecks: ["wfo"],
            warningChecks: [],
            hardFail: true,
            allowPaperTrading: false,
            allowLiveTrading: false,
          },
          pValue: 0.08,
          familyKey: "d",
          correlationBucket: "d",
          familyRepresentative: true,
          familyRepresentativeStrategyId: "D1",
          candidateLevelFdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
          admissionSignificance: {
            passed: true,
            pboResult: { pbo: 0.1, logits: [], splitsEvaluated: 0, partitions: 8 },
            dsrResult: {
              observedSharpe: 0,
              benchmarkSharpe: 0,
              dsrValue: 0.2,
              dsrProbability: 0.7,
              skewness: 0,
              kurtosis: 0,
              trialCount: 2,
            },
            pboThreshold: 0.2,
            dsrMin: 0,
          },
          fdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
          candidatePass: false,
          failureReasons: [],
        } as EnrichedRun,
        champion: {
          candidate: {
            strategyId: "D1",
            strategyName: "donor",
            strategy: "trend",
            params: {},
            applicableSymbols: ["BTC/USD"],
            role: "donor",
          },
          backtest: { metrics: { sharpe: 2 } } as unknown as BacktestReport,
          significance: null as unknown as SignificanceResult,
          riskSimulation: null as unknown as RiskSimulationResult,
          wfo: null as unknown as WfoResult,
          releaseGate: {
            checks: [],
            failedChecks: [],
            warningChecks: [],
            hardFail: false,
            allowPaperTrading: true,
            allowLiveTrading: false,
          },
          pValue: 0.08,
          familyKey: "d",
          correlationBucket: "d",
          familyRepresentative: true,
          familyRepresentativeStrategyId: "D1",
          candidateLevelFdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
          admissionSignificance: {
            passed: true,
            pboResult: { pbo: 0.1, logits: [], splitsEvaluated: 0, partitions: 8 },
            dsrResult: {
              observedSharpe: 0,
              benchmarkSharpe: 0,
              dsrValue: 0.2,
              dsrProbability: 0.7,
              skewness: 0,
              kurtosis: 0,
              trialCount: 2,
            },
            pboThreshold: 0.2,
            dsrMin: 0,
          },
          fdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
          candidatePass: true,
          failureReasons: [],
        } as EnrichedRun,
        candidates: [
          {
            candidate: {
              strategyId: "D1",
              strategyName: "donor",
              strategy: "trend",
              params: {},
              applicableSymbols: ["BTC/USD"],
              role: "donor",
            },
            backtest: { metrics: { sharpe: 2 } } as unknown as BacktestReport,
            significance: null as unknown as SignificanceResult,
            riskSimulation: null as unknown as RiskSimulationResult,
            wfo: null as unknown as WfoResult,
            releaseGate: {
              checks: [],
              failedChecks: [],
              warningChecks: [],
              hardFail: false,
              allowPaperTrading: true,
              allowLiveTrading: false,
            },
            pValue: 0.08,
            familyKey: "d",
            correlationBucket: "d",
            familyRepresentative: true,
            familyRepresentativeStrategyId: "D1",
            candidateLevelFdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
            admissionSignificance: {
              passed: true,
              pboResult: { pbo: 0.1, logits: [], splitsEvaluated: 0, partitions: 8 },
              dsrResult: {
                observedSharpe: 0,
                benchmarkSharpe: 0,
                dsrValue: 0.2,
                dsrProbability: 0.7,
                skewness: 0,
                kurtosis: 0,
                trialCount: 2,
              },
              pboThreshold: 0.2,
              dsrMin: 0,
            },
            fdr: { index: 0, rank: 1, pValue: 0.08, qValue: 0.08, threshold: 0.1, passed: true },
            candidatePass: true,
            failureReasons: [],
          } as EnrichedRun,
          {
            candidate: {
              strategyId: "C1",
              strategyName: "baseline",
              strategy: "trend",
              params: {},
              applicableSymbols: ["BTC/USD"],
              role: "benchmark_control",
            },
            backtest: { metrics: { sharpe: 0.1 } } as unknown as BacktestReport,
            significance: null as unknown as SignificanceResult,
            riskSimulation: null as unknown as RiskSimulationResult,
            wfo: null as unknown as WfoResult,
            releaseGate: {
              checks: [],
              failedChecks: [],
              warningChecks: [],
              hardFail: true,
              allowPaperTrading: false,
              allowLiveTrading: false,
            },
            pValue: 1,
            familyKey: "c",
            correlationBucket: "c",
            familyRepresentative: true,
            familyRepresentativeStrategyId: "C1",
            candidateLevelFdr: { index: 1, rank: 2, pValue: 1, qValue: 1, threshold: 0.1, passed: false },
            admissionSignificance: {
              passed: false,
              pboResult: { pbo: 0.8, logits: [], splitsEvaluated: 0, partitions: 8 },
              dsrResult: {
                observedSharpe: 0,
                benchmarkSharpe: 0,
                dsrValue: -0.1,
                dsrProbability: 0.1,
                skewness: 0,
                kurtosis: 0,
                trialCount: 2,
              },
              pboThreshold: 0.2,
              dsrMin: 0,
            },
            fdr: { index: 1, rank: 2, pValue: 1, qValue: 1, threshold: 0.1, passed: false },
            candidatePass: false,
            failureReasons: [],
          } as EnrichedRun,
        ],
        candidatePoolDiagnostics: diagnostics,
      },
    ],
    thresholds: {
      meanPboMax: 0.2,
      meanDsrProbabilityMin: 0.5,
      fdrQMax: 0.1,
    },
  });
  if (diagnosticSummary.donorOnlyAggregateMetrics?.passesThresholds !== true) {
    throw new Error("expected donor-only diagnostics to pass thresholds");
  }
  if (diagnosticSummary.questions.controlsAreStrongerThanDonor !== false) {
    throw new Error("expected controlsAreStrongerThanDonor to be false in self-check");
  }
}

main().catch((err) => {
  console.error("run_strategy_mvp_validation failed:", err);
  process.exit(1);
});
