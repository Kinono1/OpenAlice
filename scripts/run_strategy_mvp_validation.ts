import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { applyFdr } from "../src/backtest/fdr.js";
import type { FdrDiagnostics, FdrMethod } from "../src/backtest/fdr.js";
import {
  applyRegimeSegmentedFdr,
  type RegimeFdrAggregation,
  type RegimeFdrDiagnostics,
  type RegimeFdrItem,
  type RegimeFdrSegmentInput,
} from "../src/backtest/regime_fdr.js";
import {
  segmentRegimes,
  type RegimeSegment,
  type RegimeSegmentationDiagnostics,
} from "../src/backtest/regime_segmentation.js";
import { evaluateReleaseGate } from "../src/backtest/release_gate.js";
import { evaluateRiskSimulation } from "../src/backtest/risk_simulation.js";
import {
  computeDeflatedSharpe,
  evaluateSignificanceGate,
} from "../src/backtest/statistical_significance.js";
import { runStrategyWalkForward } from "../src/backtest/wfo.js";
import type { WfoResult } from "../src/backtest/wfo.js";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import { runStrategyBacktest } from "../src/extension/strategy-tools/backtest.js";
import type {
  StrategyName,
  StrategyParams,
} from "../src/extension/strategy-tools/types.js";
import { buildPromotionMetadata } from "../src/runtime/paper_promotion_metadata.js";
import { writeReleaseGateStatus } from "../src/runtime/release_gate_status.js";

type BootstrapMethod = "iid_bootstrap" | "moving_block_bootstrap";
type WfoProfile = "stable" | "shift" | "stress";
type CliFdrMethod =
  | FdrMethod
  | "regime_segmented_bh"
  | "cv_storey_bh"
  | "stability_bh";
type RegimeMethod = "none" | "change_point";

interface CandidateConfig {
  strategyId: string;
  strategyName: string;
  strategy: StrategyName;
  params: StrategyParams;
}

interface CandidatesFile {
  schemaVersion?: string;
  dataset?: {
    inputCsv?: string;
    symbol?: string;
    lookbackBars?: number;
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
  };
  significance?: {
    partitions?: number;
    pboThreshold?: number;
    dsrMin?: number;
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
  wfoProfile: WfoProfile;
  fdrMethod: CliFdrMethod;
  fdrStoreyLambda: number;
  regimeMethod: RegimeMethod;
  regimeMaxSegments: number;
  regimeMinSegmentBars: number;
  regimeMinWindows: number;
  regimeAggregation: RegimeFdrAggregation;
  cvAggQuantile: number;
  stabilityBootstraps: number;
  stabilitySubsampleFrac: number;
  stabilityMinFrequency: number;
  stabilitySelectP: number;
}

interface RegimeConfigSnapshot {
  method: RegimeMethod;
  maxSegments: number;
  minSegmentBars: number;
  minWindows: number;
  aggregation: RegimeFdrAggregation;
}

interface CvAwareConfigSnapshot {
  aggQuantile: number;
}

interface StabilityConfigSnapshot {
  bootstraps: number;
  subsampleFrac: number;
  minFrequency: number;
  selectP: number;
  seed: number;
}

interface RegimeFdrDiagnosticsSnapshot {
  enabled: boolean;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  weightedMeanNoPositiveWeightFallback: boolean;
  method: RegimeMethod;
  aggregation: RegimeFdrAggregation;
  maxSegments: number;
  minSegmentBars: number;
  minWindows: number;
  minUsableSegmentCount: number;
  segmentationDiagnostics: RegimeSegmentationDiagnostics | null;
  candidateCount: number;
  segmentCount: number;
  usableSegmentCount: number;
  shortSegmentCount: number;
  droppedSegments: Array<{
    segmentId: string;
    bars: number;
    reason: string;
  }>;
  segmentedFdrDiagnostics: RegimeFdrDiagnostics | null;
  fallbackFdrDiagnostics: FdrDiagnostics | null;
}

type FdrItemLike = {
  index: number;
  rank: number;
  pValue: number;
  qValue: number;
  threshold: number;
  passed: boolean;
  regimeDetails?: RegimeFdrItem["regimeDetails"];
};

interface FdrRawRun {
  pValue: number;
  wfo: WfoResult<StrategyParams>;
}

interface WfoSummary {
  overallPassed: boolean;
  totalWindows: number;
  failedWindows: number;
  failedWindowRatio: number;
  failByReason: Record<string, number>;
  meanInSampleSharpe: number | null;
  meanOutOfSampleSharpe: number | null;
  meanDegradationRate: number | null;
  medianDegradationRate: number | null;
  worstDegradationRate: number | null;
  worstWindowIndex: number | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await readCandidatesConfig(args.candidatesFile);
  const candidates = normalizeCandidates(cfg.candidates);
  if (candidates.length < 3) {
    throw new Error("candidates file must contain at least 3 candidates.");
  }

  const dataset = {
    inputCsv: cfg.dataset?.inputCsv ?? "data/market/okx/BTC_USDT_USDT_1h.csv",
    symbol: cfg.dataset?.symbol ?? "BTC/USD",
    lookbackBars: toPositiveInt(cfg.dataset?.lookbackBars, 3000, "lookbackBars"),
  };

  const thresholds = {
    meanPboMax: toFiniteNumber(cfg.thresholds?.meanPboMax, 0.2, "meanPboMax"),
    meanDsrProbabilityMin: toFiniteNumber(
      cfg.thresholds?.meanDsrProbabilityMin,
      0.5,
      "meanDsrProbabilityMin"
    ),
    fdrQMax: toFiniteNumber(cfg.thresholds?.fdrQMax, 0.1, "fdrQMax"),
  };

  const baseWfoConfig = {
    trainBars: toPositiveInt(cfg.wfo?.trainBars, 24 * 365, "trainBars"),
    testBars: toPositiveInt(cfg.wfo?.testBars, 24 * 90, "testBars"),
    stepBars: toPositiveInt(cfg.wfo?.stepBars, 24 * 90, "stepBars"),
    degradationThreshold: toFiniteNumber(
      cfg.wfo?.degradationThreshold,
      0.4,
      "degradationThreshold"
    ),
  };
  const wfoConfig = applyWfoProfile(baseWfoConfig, args.wfoProfile);

  const significanceConfig = {
    partitions: toPositiveInt(cfg.significance?.partitions, 8, "partitions"),
    pboThreshold: toFiniteNumber(
      cfg.significance?.pboThreshold,
      0.2,
      "pboThreshold"
    ),
    dsrMin: toFiniteNumber(cfg.significance?.dsrMin, 0.0, "dsrMin"),
  };

  const riskConfig: {
    method: BootstrapMethod;
    simulations: number;
    horizonBars: number;
    blockSize: number;
    ruinDrawdownPct: number;
    maxRuinProbability: number;
    minProfitProbability: number;
  } = {
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

  const costModel = {
    feeRate: toFiniteNumber(cfg.costModel?.feeRate, 0.0006, "feeRate"),
    slippageBps: toFiniteNumber(cfg.costModel?.slippageBps, 8, "slippageBps"),
    latencyBars: toPositiveInt(cfg.costModel?.latencyBars, 1, "latencyBars"),
  };
  const regimeConfig: RegimeConfigSnapshot = {
    method: args.regimeMethod,
    maxSegments: args.regimeMaxSegments,
    minSegmentBars: args.regimeMinSegmentBars,
    minWindows: args.regimeMinWindows,
    aggregation: args.regimeAggregation,
  };
  const cvAwareConfig: CvAwareConfigSnapshot = {
    aggQuantile: args.cvAggQuantile,
  };
  const stabilityConfig: StabilityConfigSnapshot = {
    bootstraps: args.stabilityBootstraps,
    subsampleFrac: args.stabilitySubsampleFrac,
    minFrequency: args.stabilityMinFrequency,
    selectP: args.stabilitySelectP,
    seed: 20260303,
  };

  const candles = (await loadCsvCandles(dataset.inputCsv, dataset.symbol)).slice(
    -dataset.lookbackBars
  );
  if (candles.length < wfoConfig.trainBars + wfoConfig.testBars) {
    throw new Error(
      `Not enough candles for WFO. Need >= ${
        wfoConfig.trainBars + wfoConfig.testBars
      }, got ${candles.length}.`
    );
  }

  const backtests = candidates.map((candidate) =>
    runStrategyBacktest({
      strategy: candidate.strategy,
      candles,
      params: candidate.params,
      costModel,
    })
  );
  const returnsByCandidate = backtests.map((report) =>
    equityCurveToReturns(report.equityCurve)
  );

  const rawRuns = candidates.map((candidate, idx) => {
    const selectedReturns = returnsByCandidate[idx];
    const significance = evaluateSignificanceGate({
      candidateReturns: returnsByCandidate,
      selectedReturns,
      partitions: significanceConfig.partitions,
      pboThreshold: significanceConfig.pboThreshold,
      dsrMin: significanceConfig.dsrMin,
      trialCount: candidates.length,
    });
    const riskSimulation = evaluateRiskSimulation(selectedReturns, {
      method: riskConfig.method,
      simulations: riskConfig.simulations,
      horizonBars: riskConfig.horizonBars,
      blockSize: riskConfig.blockSize,
      ruinDrawdownPct: riskConfig.ruinDrawdownPct,
      maxRuinProbability: riskConfig.maxRuinProbability,
      minProfitProbability: riskConfig.minProfitProbability,
    });
    const wfo = runStrategyWalkForward({
      strategy: candidate.strategy,
      candles,
      candidates: [candidate.params],
      costModel,
      config: {
        trainBars: wfoConfig.trainBars,
        testBars: wfoConfig.testBars,
        stepBars: wfoConfig.stepBars,
        degradationThreshold: wfoConfig.degradationThreshold,
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
      pValue: clamp01(1 - significance.dsrResult.dsrProbability),
    };
  });

  const fdrComputation = computeFdrResults({
    fdrMethod: args.fdrMethod,
    fdrStoreyLambda: args.fdrStoreyLambda,
    alpha: thresholds.fdrQMax,
    rawRuns: rawRuns.map((run) => ({
      pValue: run.pValue,
      wfo: run.wfo,
    })),
    candles,
    candidates,
    costModel,
    regime: regimeConfig,
    cvAware: cvAwareConfig,
    stability: stabilityConfig,
  });
  const { items: fdrItems, fdrDiagnostics, regimeFdrDiagnostics, storeyMeta } = fdrComputation;

  const enrichedRuns = rawRuns.map((run, idx) => {
    const fdrBase = fdrItems[idx];
    const fdr = {
      ...fdrBase,
      method: args.fdrMethod,
      ...(storeyMeta.pi0 == null
        ? {}
        : {
            pi0: storeyMeta.pi0,
            lambda: storeyMeta.lambda,
          }),
    };
    const wfoSummary = summarizeWfo(run.wfo);
    const hardGap = computeHardGap({
      pbo: run.significance.pboResult.pbo,
      dsrProbability: run.significance.dsrResult.dsrProbability,
      fdrQ: fdrBase.qValue,
      thresholds,
    });
    const wfoPenaltyBreakdown = buildWfoPenaltyBreakdown(wfoSummary);
    const wfoRiskScore = computeWfoRiskScore(wfoPenaltyBreakdown);
    const wfoGatePassed =
      run.wfo.overallPassed && !run.releaseGate.failedChecks.includes("wfo");
    const candidatePass =
      run.significance.pboResult.pbo <= thresholds.meanPboMax &&
      run.significance.dsrResult.dsrProbability >= thresholds.meanDsrProbabilityMin &&
      fdrBase.qValue <= thresholds.fdrQMax &&
      run.releaseGate.allowPaperTrading;

    const failureReasons: string[] = [];
    if (run.significance.pboResult.pbo > thresholds.meanPboMax) {
      failureReasons.push("HARD_PBO_THRESHOLD_FAIL");
    }
    if (run.significance.dsrResult.dsrProbability < thresholds.meanDsrProbabilityMin) {
      failureReasons.push("HARD_DSR_PROBABILITY_THRESHOLD_FAIL");
    }
    if (fdrBase.qValue > thresholds.fdrQMax) {
      failureReasons.push("HARD_FDR_THRESHOLD_FAIL");
    }
    if (!run.releaseGate.allowPaperTrading) {
      failureReasons.push("HARD_RELEASE_GATE_BLOCKED");
    }

    return {
      ...run,
      fdr,
      wfoSummary,
      hardGap,
      wfoPenaltyBreakdown,
      wfoRiskScore,
      wfoGatePassed,
      candidatePass,
      failureReasons,
    };
  });

  const champion = [...enrichedRuns].sort((a, b) => {
    // Phase-A gate-aware ranking:
    // 1) prefer WFO-passed candidates
    // 2) then prefer release-gate paper-trading allowed
    // 3) within the same gate bucket, rank by Sharpe and DSR
    if (a.wfoGatePassed !== b.wfoGatePassed) {
      return a.wfoGatePassed ? -1 : 1;
    }
    if (a.releaseGate.allowPaperTrading !== b.releaseGate.allowPaperTrading) {
      return a.releaseGate.allowPaperTrading ? -1 : 1;
    }

    // 3) hard-threshold gap minimization (protocol-first objective)
    const hardGapDelta = a.hardGap.totalGap - b.hardGap.totalGap;
    if (Math.abs(hardGapDelta) > 1e-12) return hardGapDelta;

    // 4) lower WFO risk score preferred
    const wfoRiskDelta = a.wfoRiskScore - b.wfoRiskScore;
    if (Math.abs(wfoRiskDelta) > 1e-12) return wfoRiskDelta;

    const sharpeDelta = b.backtest.metrics.sharpe - a.backtest.metrics.sharpe;
    if (Math.abs(sharpeDelta) > 1e-12) return sharpeDelta;

    const dsrDelta =
      b.significance.dsrResult.dsrProbability -
      a.significance.dsrResult.dsrProbability;
    if (Math.abs(dsrDelta) > 1e-12) return dsrDelta;

    const pboDelta = a.significance.pboResult.pbo - b.significance.pboResult.pbo;
    if (Math.abs(pboDelta) > 1e-12) return pboDelta;

    const fdrDelta = a.fdr.qValue - b.fdr.qValue;
    if (Math.abs(fdrDelta) > 1e-12) return fdrDelta;
    return 0;
  })[0];

  const meanPbo = mean(enrichedRuns.map((run) => run.significance.pboResult.pbo));
  const meanDsrProbability = mean(
    enrichedRuns.map((run) => run.significance.dsrResult.dsrProbability)
  );
  const fdrQ = champion.fdr.qValue;
  const hardGapTotals = enrichedRuns.map((run) => run.hardGap.totalGap);
  const hardGapSummary = {
    meanTotalGap: mean(hardGapTotals),
    minTotalGap: Math.min(...hardGapTotals),
    maxTotalGap: Math.max(...hardGapTotals),
    meanPboGap: mean(enrichedRuns.map((run) => run.hardGap.pboGap)),
    meanDsrGap: mean(enrichedRuns.map((run) => run.hardGap.dsrGap)),
    meanFdrGap: mean(enrichedRuns.map((run) => run.hardGap.fdrGap)),
  };
  const fdrFeasibility = buildFdrFeasibility({
    alpha: thresholds.fdrQMax,
    candidateCount: enrichedRuns.length,
    championFdrRank: champion.fdr.rank,
    championFdrQ: champion.fdr.qValue,
    championDsrProbability: champion.significance.dsrResult.dsrProbability,
  });

  const aggregatePass =
    meanPbo <= thresholds.meanPboMax &&
    meanDsrProbability >= thresholds.meanDsrProbabilityMin &&
    fdrQ <= thresholds.fdrQMax &&
    champion.releaseGate.allowPaperTrading &&
    enrichedRuns.some((run) => run.candidatePass);

  const reasonCodes: string[] = [];
  if (meanPbo > thresholds.meanPboMax) {
    reasonCodes.push("HARD_MEAN_PBO_THRESHOLD_FAIL");
  }
  if (meanDsrProbability < thresholds.meanDsrProbabilityMin) {
    reasonCodes.push("HARD_MEAN_DSR_PROBABILITY_THRESHOLD_FAIL");
  }
  if (fdrQ > thresholds.fdrQMax) {
    reasonCodes.push("HARD_FDR_THRESHOLD_FAIL");
  }
  if (!champion.releaseGate.allowPaperTrading) {
    reasonCodes.push("HARD_RELEASE_GATE_BLOCKED");
  }
  if (!enrichedRuns.some((run) => run.candidatePass)) {
    reasonCodes.push("HARD_NO_CANDIDATE_PASS");
  }
  if (reasonCodes.length === 0) {
    reasonCodes.push("INFO_MVP_THRESHOLDS_PASS");
  }

  await mkdir(dirname(resolve(args.output)), { recursive: true });
  const runPayload = {
    schemaVersion: "strategy_validation_runs.v1",
    generatedAt: new Date().toISOString(),
    config: {
      dataset,
      thresholds,
      wfoProfile: args.wfoProfile,
      fdr: {
        method: args.fdrMethod,
        storeyLambda: args.fdrStoreyLambda,
        cvAggQuantile: args.cvAggQuantile,
        stabilityBootstraps: args.stabilityBootstraps,
        stabilitySubsampleFrac: args.stabilitySubsampleFrac,
        stabilityMinFrequency: args.stabilityMinFrequency,
        stabilitySelectP: args.stabilitySelectP,
      },
      regime: regimeConfig,
      baseWfo: baseWfoConfig,
      wfo: wfoConfig,
      significance: significanceConfig,
      riskSimulation: riskConfig,
      costModel,
    },
    aggregateMetrics: {
      meanPbo,
      meanDsrProbability,
      fdrQ,
      fdrMethod: args.fdrMethod,
      fdrDiagnostics,
      regimeFdrDiagnostics,
      hardGapSummary,
      fdrFeasibility,
    },
    ranking: {
      version: "protocol-first.v1",
      primaryObjective: "wfo_pass > release_gate > hard_gap_min",
      secondaryObjective: "wfo_risk_min > sharpe > dsr > pbo > fdr",
    },
    champion: {
      strategyId: champion.candidate.strategyId,
      strategyName: champion.candidate.strategyName,
      strategy: champion.candidate.strategy,
      params: champion.candidate.params,
      sharpe: champion.backtest.metrics.sharpe,
      dsrProbability: champion.significance.dsrResult.dsrProbability,
      fdrQ: champion.fdr.qValue,
      wfoGatePassed: champion.wfoGatePassed,
      hardGapTotal: champion.hardGap.totalGap,
      wfoRiskScore: champion.wfoRiskScore,
      releaseGateAllowPaper: champion.releaseGate.allowPaperTrading,
      releaseGateAllowLive: champion.releaseGate.allowLiveTrading,
      fdrMethod: args.fdrMethod,
    },
    candidates: enrichedRuns.map((run) => ({
      strategyId: run.candidate.strategyId,
      strategyName: run.candidate.strategyName,
      strategy: run.candidate.strategy,
      params: run.candidate.params,
      status: run.candidatePass ? "pass" : "fail",
      candidatePass: run.candidatePass,
      failureReasons: run.failureReasons,
      backtestMetrics: run.backtest.metrics,
      significance: {
        pbo: run.significance.pboResult.pbo,
        dsrValue: run.significance.dsrResult.dsrValue,
        dsrProbability: run.significance.dsrResult.dsrProbability,
      },
      fdr: run.fdr,
      hardGap: run.hardGap,
      wfoRiskScore: run.wfoRiskScore,
      wfoPenaltyBreakdown: run.wfoPenaltyBreakdown,
      wfoSummary: run.wfoSummary,
      wfoGatePassed: run.wfoGatePassed,
      releaseGate: run.releaseGate,
    })),
    result: aggregatePass ? "GO" : "NO_GO",
    reasonCodes,
    promotionMetadataReady: false,
    promotionMetadata: null,
    promotionMetadataBlockingReasons: [] as string[],
  };
  const promotionMetadataResult = await buildPromotionMetadata({
    repoRoot: process.cwd(),
    candidatesFilePath: args.candidatesFile,
    candidatesFilePayload: cfg as Record<string, unknown>,
    datasetInputCsvPath: dataset.inputCsv,
    costModel,
    fdrMethod: args.fdrMethod,
  });
  runPayload.promotionMetadataReady = promotionMetadataResult.ready;
  runPayload.promotionMetadata = promotionMetadataResult.metadata;
  runPayload.promotionMetadataBlockingReasons =
    promotionMetadataResult.blockingReasons;

  await writeFile(resolve(args.output), `${JSON.stringify(runPayload, null, 2)}\n`, "utf-8");

  await writeReleaseGateStatus(champion.releaseGate, {
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
    aggregateMetrics: {
      meanPbo,
      meanDsrProbability,
      fdrQ,
      fdrMethod: args.fdrMethod,
      fdrDiagnostics,
      regimeFdrDiagnostics,
    },
    candidates: enrichedRuns.map((run) => ({
      strategyId: run.candidate.strategyId,
      strategyName: run.candidate.strategyName,
      status: run.candidatePass ? "pass" : "fail",
      metrics: {
        pbo: run.significance.pboResult.pbo,
        dsrProbability: run.significance.dsrResult.dsrProbability,
        fdrQ: run.fdr.qValue,
        hardGapTotal: run.hardGap.totalGap,
        wfoRiskScore: run.wfoRiskScore,
      },
      releaseGate: {
        allowPaperTrading: run.releaseGate.allowPaperTrading,
        allowLiveTrading: run.releaseGate.allowLiveTrading,
        failedChecks: run.releaseGate.failedChecks,
      },
      failureReasonCode: run.failureReasons[0],
    })),
    outputPaths: {
      validationRuns: resolve(args.output),
      releaseGateStatus: resolve(args.releaseGateStatusPath),
    },
    notes: `champion=${champion.candidate.strategyId}`,
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
      `wfoProfile=${args.wfoProfile}`,
      `fdrMethod=${args.fdrMethod}`,
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
  const wfoProfileRaw = raw.get("wfo-profile") ?? "shift";
  if (!isWfoProfile(wfoProfileRaw)) {
    throw new Error(
      `--wfo-profile must be one of stable|shift|stress. got=${wfoProfileRaw}`
    );
  }
  const fdrMethodRaw = (raw.get("fdr-method") ?? "bh").trim();
  if (!isFdrMethod(fdrMethodRaw)) {
    throw new Error(
      `--fdr-method must be one of bh|by|storey_bh|e_bh|regime_segmented_bh|cv_storey_bh|stability_bh. got=${fdrMethodRaw}`
    );
  }
  const fdrStoreyLambda = toFiniteNumber(
    raw.get("fdr-storey-lambda"),
    0.5,
    "fdr-storey-lambda"
  );
  if (fdrStoreyLambda < 0 || fdrStoreyLambda >= 1) {
    throw new Error("--fdr-storey-lambda must be in [0, 1).");
  }
  const regimeMethodRaw = (raw.get("regime-method") ?? "none").trim();
  if (!isRegimeMethod(regimeMethodRaw)) {
    throw new Error(
      `--regime-method must be one of none|change_point. got=${regimeMethodRaw}`
    );
  }
  const regimeMaxSegments = toPositiveInt(
    raw.get("regime-max-segments"),
    3,
    "regime-max-segments"
  );
  const regimeMinSegmentBars = toPositiveInt(
    raw.get("regime-min-segment-bars"),
    720,
    "regime-min-segment-bars"
  );
  const regimeMinWindows = toPositiveInt(
    raw.get("regime-min-windows"),
    4,
    "regime-min-windows"
  );
  const regimeAggregationRaw = (raw.get("regime-aggregation") ?? "max").trim();
  if (!isRegimeAggregation(regimeAggregationRaw)) {
    throw new Error(
      `--regime-aggregation must be one of max|weighted_mean. got=${regimeAggregationRaw}`
    );
  }
  const cvAggQuantile = toFiniteNumber(
    raw.get("cv-agg-quantile"),
    0.75,
    "cv-agg-quantile"
  );
  if (cvAggQuantile <= 0 || cvAggQuantile > 1) {
    throw new Error("--cv-agg-quantile must be in (0, 1].");
  }
  const stabilityBootstraps = toPositiveInt(
    raw.get("stability-bootstraps"),
    120,
    "stability-bootstraps"
  );
  const stabilitySubsampleFrac = toFiniteNumber(
    raw.get("stability-subsample-frac"),
    0.7,
    "stability-subsample-frac"
  );
  if (stabilitySubsampleFrac <= 0 || stabilitySubsampleFrac > 1) {
    throw new Error("--stability-subsample-frac must be in (0, 1].");
  }
  const stabilityMinFrequency = toFiniteNumber(
    raw.get("stability-min-frequency"),
    0.7,
    "stability-min-frequency"
  );
  if (stabilityMinFrequency < 0 || stabilityMinFrequency > 1) {
    throw new Error("--stability-min-frequency must be in [0, 1].");
  }
  const stabilitySelectP = toFiniteNumber(
    raw.get("stability-select-p"),
    0.2,
    "stability-select-p"
  );
  if (stabilitySelectP < 0 || stabilitySelectP > 1) {
    throw new Error("--stability-select-p must be in [0, 1].");
  }
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
    wfoProfile: wfoProfileRaw,
    fdrMethod: fdrMethodRaw,
    fdrStoreyLambda,
    regimeMethod: regimeMethodRaw,
    regimeMaxSegments,
    regimeMinSegmentBars,
    regimeMinWindows,
    regimeAggregation: regimeAggregationRaw,
    cvAggQuantile,
    stabilityBootstraps,
    stabilitySubsampleFrac,
    stabilityMinFrequency,
    stabilitySelectP,
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--") {
      continue;
    }
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

function normalizeCandidates(raw: CandidatesFile["candidates"]): CandidateConfig[] {
  if (!Array.isArray(raw)) {
    throw new Error("candidates field must be an array.");
  }
  return raw.map((item, idx) => {
    if (!item || typeof item !== "object") {
      throw new Error(`candidates[${idx}] must be an object.`);
    }
    if (!isStrategyName(item.strategy)) {
      throw new Error(`candidates[${idx}].strategy is invalid.`);
    }
    return {
      strategyId: normalizeString(item.strategyId, `S${idx + 1}`),
      strategyName: normalizeString(item.strategyName, item.strategyId ?? `S${idx + 1}`),
      strategy: item.strategy,
      params: (item.params ?? {}) as StrategyParams,
    };
  });
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function isStrategyName(value: unknown): value is StrategyName {
  return (
    value === "trend" ||
    value === "meanReversion" ||
    value === "breakout" ||
    value === "ensemble" ||
    value === "volBreakout" ||
    value === "volNoTradeFilter" ||
    value === "volTrend"
  );
}

function isWfoProfile(value: unknown): value is WfoProfile {
  return value === "stable" || value === "shift" || value === "stress";
}

function isFdrMethod(value: unknown): value is CliFdrMethod {
  return (
    value === "bh" ||
    value === "by" ||
    value === "storey_bh" ||
    value === "e_bh" ||
    value === "regime_segmented_bh" ||
    value === "cv_storey_bh" ||
    value === "stability_bh"
  );
}

function isRegimeMethod(value: unknown): value is RegimeMethod {
  return value === "none" || value === "change_point";
}

function isRegimeAggregation(value: unknown): value is RegimeFdrAggregation {
  return value === "max" || value === "weighted_mean";
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

function computeFdrResults(input: {
  fdrMethod: CliFdrMethod;
  fdrStoreyLambda: number;
  alpha: number;
  rawRuns: FdrRawRun[];
  candles: MarketData[];
  candidates: CandidateConfig[];
  costModel: {
    feeRate: number;
    slippageBps: number;
    latencyBars: number;
  };
  regime: RegimeConfigSnapshot;
  cvAware: CvAwareConfigSnapshot;
  stability: StabilityConfigSnapshot;
}): {
  items: FdrItemLike[];
  fdrDiagnostics: Record<string, unknown>;
  regimeFdrDiagnostics: RegimeFdrDiagnosticsSnapshot;
  storeyMeta: {
    pi0: number | null;
    lambda: number | null;
  };
} {
  const rawPValues = input.rawRuns.map((row) => row.pValue);
  const baselineBh = applyFdr(rawPValues, input.alpha, { method: "bh" });
  const minUsableSegmentCount = 2;
  const disabledRegimeDiagnostics: RegimeFdrDiagnosticsSnapshot = {
    enabled: false,
    fallbackUsed: false,
    fallbackReason: null,
    weightedMeanNoPositiveWeightFallback: false,
    method: input.regime.method,
    aggregation: input.regime.aggregation,
    maxSegments: input.regime.maxSegments,
    minSegmentBars: input.regime.minSegmentBars,
    minWindows: input.regime.minWindows,
    minUsableSegmentCount,
    segmentationDiagnostics: null,
    candidateCount: rawPValues.length,
    segmentCount: 0,
    usableSegmentCount: 0,
    shortSegmentCount: 0,
    droppedSegments: [],
    segmentedFdrDiagnostics: null,
    fallbackFdrDiagnostics: null,
  };

  if (
    input.fdrMethod === "bh" ||
    input.fdrMethod === "by" ||
    input.fdrMethod === "storey_bh" ||
    input.fdrMethod === "e_bh"
  ) {
    const applied = applyFdr(rawPValues, input.alpha, {
      method: input.fdrMethod,
      storeyLambda: input.fdrStoreyLambda,
    });
    return {
      items: applied.items,
      fdrDiagnostics: applied.diagnostics,
      regimeFdrDiagnostics: disabledRegimeDiagnostics,
      storeyMeta: {
        pi0: applied.diagnostics.storeyPi0,
        lambda: applied.diagnostics.storeyLambda,
      },
    };
  }

  if (input.fdrMethod === "cv_storey_bh") {
    const perCandidateWindowPValues = input.rawRuns.map((run) =>
      run.wfo.windows.map((window) => oosSharpeToPseudoPValue(window.outOfSample.sharpe))
    );
    const candidateWindowCounts = perCandidateWindowPValues.map((values) => values.length);
    const aggregatedPValues = perCandidateWindowPValues.map((values) =>
      quantile(values, input.cvAware.aggQuantile)
    );
    const applied = applyFdr(aggregatedPValues, input.alpha, {
      method: "storey_bh",
      storeyLambda: input.fdrStoreyLambda,
    });
    return {
      items: applied.items,
      fdrDiagnostics: {
        method: "cv_storey_bh",
        alpha: input.alpha,
        candidateCount: aggregatedPValues.length,
        harmonicFactorCm: null,
        storeyPi0: applied.diagnostics.storeyPi0,
        storeyLambda: applied.diagnostics.storeyLambda,
        cvAggQuantile: input.cvAware.aggQuantile,
        candidateWindowCounts,
      },
      regimeFdrDiagnostics: disabledRegimeDiagnostics,
      storeyMeta: {
        pi0: applied.diagnostics.storeyPi0,
        lambda: applied.diagnostics.storeyLambda,
      },
    };
  }

  if (input.fdrMethod === "stability_bh") {
    const perCandidateWindowPValues = input.rawRuns.map((run) =>
      run.wfo.windows.map((window) => oosSharpeToPseudoPValue(window.outOfSample.sharpe))
    );
    const minWindowCount = perCandidateWindowPValues.reduce(
      (acc, values) => Math.min(acc, values.length),
      Number.POSITIVE_INFINITY
    );
    const candidateCount = perCandidateWindowPValues.length;

    if (!Number.isFinite(minWindowCount) || minWindowCount <= 0) {
      return {
        items: baselineBh.items,
        fdrDiagnostics: {
          method: "stability_bh",
          alpha: input.alpha,
          candidateCount,
          harmonicFactorCm: null,
          storeyPi0: null,
          storeyLambda: null,
          stabilityBootstraps: input.stability.bootstraps,
          stabilitySubsampleFrac: input.stability.subsampleFrac,
          stabilityMinFrequency: input.stability.minFrequency,
          stabilitySelectP: input.stability.selectP,
          stabilitySeed: input.stability.seed,
          fallbackUsed: true,
          fallbackReason: "no_wfo_windows",
        },
        regimeFdrDiagnostics: disabledRegimeDiagnostics,
        storeyMeta: {
          pi0: null,
          lambda: null,
        },
      };
    }

    const sampleSize = Math.max(
      1,
      Math.min(minWindowCount, Math.floor(minWindowCount * input.stability.subsampleFrac))
    );
    const rng = createSeededRng(input.stability.seed);
    const selectedCounts = new Array<number>(candidateCount).fill(0);
    const candidateMedianP = perCandidateWindowPValues.map((values) => median(values));

    for (let b = 0; b < input.stability.bootstraps; b++) {
      const sampledIndices = sampleWithoutReplacement(minWindowCount, sampleSize, rng);
      for (let idx = 0; idx < candidateCount; idx++) {
        const sampledValues = sampledIndices.map(
          (windowIdx) => perCandidateWindowPValues[idx][windowIdx]
        );
        const sampledMedian = median(sampledValues);
        if (sampledMedian <= input.stability.selectP) {
          selectedCounts[idx] += 1;
        }
      }
    }

    const selectionFrequency = selectedCounts.map(
      (count) => count / input.stability.bootstraps
    );
    const retainedIndices = selectionFrequency
      .map((frequency, idx) => ({ frequency, idx }))
      .filter((row) => row.frequency >= input.stability.minFrequency)
      .map((row) => row.idx);

    if (retainedIndices.length === 0) {
      return {
        items: baselineBh.items,
        fdrDiagnostics: {
          method: "stability_bh",
          alpha: input.alpha,
          candidateCount,
          harmonicFactorCm: null,
          storeyPi0: null,
          storeyLambda: null,
          stabilityBootstraps: input.stability.bootstraps,
          stabilitySubsampleFrac: input.stability.subsampleFrac,
          stabilityMinFrequency: input.stability.minFrequency,
          stabilitySelectP: input.stability.selectP,
          stabilitySeed: input.stability.seed,
          sampleSize,
          retainedCandidateCount: 0,
          selectionFrequencyByCandidate: selectionFrequency,
          fallbackUsed: true,
          fallbackReason: "no_candidates_retained",
        },
        regimeFdrDiagnostics: disabledRegimeDiagnostics,
        storeyMeta: {
          pi0: null,
          lambda: null,
        },
      };
    }

    const retainedPValues = retainedIndices.map((idx) => candidateMedianP[idx]);
    const retainedBh = applyFdr(retainedPValues, input.alpha, { method: "bh" });
    const qValues = new Array<number>(candidateCount).fill(1);
    for (let localIdx = 0; localIdx < retainedIndices.length; localIdx++) {
      const globalIdx = retainedIndices[localIdx];
      qValues[globalIdx] = retainedBh.items[localIdx].qValue;
    }

    return {
      items: buildRankedFdrItems(candidateMedianP, qValues, input.alpha),
      fdrDiagnostics: {
        method: "stability_bh",
        alpha: input.alpha,
        candidateCount,
        harmonicFactorCm: null,
        storeyPi0: null,
        storeyLambda: null,
        stabilityBootstraps: input.stability.bootstraps,
        stabilitySubsampleFrac: input.stability.subsampleFrac,
        stabilityMinFrequency: input.stability.minFrequency,
        stabilitySelectP: input.stability.selectP,
        stabilitySeed: input.stability.seed,
        sampleSize,
        retainedCandidateCount: retainedIndices.length,
        retainedCandidateIndices: retainedIndices,
        selectionFrequencyByCandidate: selectionFrequency,
      },
      regimeFdrDiagnostics: disabledRegimeDiagnostics,
      storeyMeta: {
        pi0: null,
        lambda: null,
      },
    };
  }

  const minBarsForUsableSegment = Math.max(
    input.regime.minSegmentBars,
    input.regime.minSegmentBars * input.regime.minWindows
  );
  const segmentation = segmentRegimes(input.candles, {
    method: input.regime.method,
    maxSegments: input.regime.maxSegments,
    minSegmentBars: input.regime.minSegmentBars,
  });
  const droppedSegments: RegimeFdrDiagnosticsSnapshot["droppedSegments"] = [];
  const segmentInputs: RegimeFdrSegmentInput[] = [];

  for (const segment of segmentation.segments) {
    if (segment.bars < minBarsForUsableSegment) {
      droppedSegments.push({
        segmentId: segment.id,
        bars: segment.bars,
        reason: "below_min_windows",
      });
      continue;
    }
    const pValues = computeSegmentPValues({
      candles: input.candles,
      segment,
      candidates: input.candidates,
      costModel: input.costModel,
    });
    segmentInputs.push({
      segmentId: segment.id,
      bars: segment.bars,
      weight: segment.weight,
      pValues,
    });
  }
  const shortSegmentCount = droppedSegments.filter(
    (segment) => segment.reason === "below_min_windows",
  ).length;

  if (segmentInputs.length < minUsableSegmentCount) {
    return {
      items: baselineBh.items,
      fdrDiagnostics: baselineBh.diagnostics,
      regimeFdrDiagnostics: {
        enabled: true,
        fallbackUsed: true,
        fallbackReason:
          segmentInputs.length === 0
            ? "no_usable_segments"
            : "insufficient_usable_segment_count",
        weightedMeanNoPositiveWeightFallback: false,
        method: input.regime.method,
        aggregation: input.regime.aggregation,
        maxSegments: input.regime.maxSegments,
        minSegmentBars: input.regime.minSegmentBars,
        minWindows: input.regime.minWindows,
        minUsableSegmentCount,
        segmentationDiagnostics: segmentation.diagnostics,
        candidateCount: rawPValues.length,
        segmentCount: segmentation.segments.length,
        usableSegmentCount: segmentInputs.length,
        shortSegmentCount,
        droppedSegments,
        segmentedFdrDiagnostics: null,
        fallbackFdrDiagnostics: baselineBh.diagnostics,
      },
      storeyMeta: {
        pi0: null,
        lambda: null,
      },
    };
  }

  try {
    const segmented = applyRegimeSegmentedFdr(
      segmentInputs,
      input.alpha,
      input.regime.aggregation
    );
    const fallbackUsed = segmented.diagnostics.fallbackUsed;
    const weightedMeanNoPositiveWeightFallback =
      segmented.diagnostics.fallbackUsed &&
      segmented.diagnostics.fallbackReason?.includes("positive segment weight") === true;
    return {
      items: segmented.items,
      fdrDiagnostics: baselineBh.diagnostics,
      regimeFdrDiagnostics: {
        enabled: true,
        fallbackUsed,
        fallbackReason: segmented.diagnostics.fallbackReason ?? null,
        weightedMeanNoPositiveWeightFallback,
        method: input.regime.method,
        aggregation: input.regime.aggregation,
        maxSegments: input.regime.maxSegments,
        minSegmentBars: input.regime.minSegmentBars,
        minWindows: input.regime.minWindows,
        minUsableSegmentCount,
        segmentationDiagnostics: segmentation.diagnostics,
        candidateCount: rawPValues.length,
        segmentCount: segmentation.segments.length,
        usableSegmentCount: segmentInputs.length,
        shortSegmentCount,
        droppedSegments,
        segmentedFdrDiagnostics: segmented.diagnostics,
        fallbackFdrDiagnostics: fallbackUsed ? baselineBh.diagnostics : null,
      },
      storeyMeta: {
        pi0: null,
        lambda: null,
      },
    };
  } catch (error) {
    return {
      items: baselineBh.items,
      fdrDiagnostics: baselineBh.diagnostics,
      regimeFdrDiagnostics: {
        enabled: true,
        fallbackUsed: true,
        fallbackReason:
          error instanceof Error
            ? `segmented_fdr_error:${error.message}`
            : "segmented_fdr_error",
        weightedMeanNoPositiveWeightFallback: false,
        method: input.regime.method,
        aggregation: input.regime.aggregation,
        maxSegments: input.regime.maxSegments,
        minSegmentBars: input.regime.minSegmentBars,
        minWindows: input.regime.minWindows,
        minUsableSegmentCount,
        segmentationDiagnostics: segmentation.diagnostics,
        candidateCount: rawPValues.length,
        segmentCount: segmentation.segments.length,
        usableSegmentCount: segmentInputs.length,
        shortSegmentCount,
        droppedSegments,
        segmentedFdrDiagnostics: null,
        fallbackFdrDiagnostics: baselineBh.diagnostics,
      },
      storeyMeta: {
        pi0: null,
        lambda: null,
      },
    };
  }
}

function buildRankedFdrItems(
  pValues: number[],
  qValues: number[],
  alpha: number
): FdrItemLike[] {
  const tuples = pValues.map((pValue, index) => ({
    index,
    pValue,
    qValue: qValues[index],
  }));
  const sorted = [...tuples].sort((a, b) => {
    if (a.qValue !== b.qValue) return a.qValue - b.qValue;
    if (a.pValue !== b.pValue) return a.pValue - b.pValue;
    return a.index - b.index;
  });
  const total = sorted.length;
  const out = new Array<FdrItemLike>(total);
  for (let i = 0; i < total; i++) {
    const rank = i + 1;
    const row = sorted[i];
    out[row.index] = {
      index: row.index,
      rank,
      pValue: row.pValue,
      qValue: row.qValue,
      threshold: (rank / total) * alpha,
      passed: row.qValue <= alpha,
    };
  }
  return out;
}

function oosSharpeToPseudoPValue(sharpe: number): number {
  if (!Number.isFinite(sharpe)) return 1;
  const p = 1 / (1 + Math.exp(2 * sharpe));
  return clamp01(p);
}

function quantile(values: number[], q: number): number {
  if (!Array.isArray(values) || values.length === 0) return 1;
  const clippedQ = Math.max(0, Math.min(1, q));
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clippedQ * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const weight = idx - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function median(values: number[]): number {
  return quantile(values, 0.5);
}

function createSeededRng(seed: number): () => number {
  let state = (Math.floor(seed) >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function sampleWithoutReplacement(
  n: number,
  k: number,
  rng: () => number
): number[] {
  const out = Array.from({ length: n }, (_, idx) => idx);
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out.slice(0, k);
}

function computeSegmentPValues(input: {
  candles: MarketData[];
  segment: RegimeSegment;
  candidates: CandidateConfig[];
  costModel: {
    feeRate: number;
    slippageBps: number;
    latencyBars: number;
  };
}): number[] {
  const segmentCandles = input.candles.slice(
    input.segment.startIndex,
    input.segment.endExclusive
  );
  return input.candidates.map((candidate) => {
    try {
      const report = runStrategyBacktest({
        strategy: candidate.strategy,
        candles: segmentCandles,
        params: candidate.params,
        costModel: input.costModel,
      });
      const returns = equityCurveToReturns(report.equityCurve);
      if (returns.length < 4) {
        return 1;
      }
      const dsr = computeDeflatedSharpe({
        returns,
        trialCount: input.candidates.length,
      });
      return clamp01(1 - dsr.dsrProbability);
    } catch {
      return 1;
    }
  });
}

function applyWfoProfile(
  baseConfig: {
    trainBars: number;
    testBars: number;
    stepBars: number;
    degradationThreshold: number;
  },
  profile: WfoProfile
): {
  trainBars: number;
  testBars: number;
  stepBars: number;
  degradationThreshold: number;
} {
  if (profile === "stable") {
    return { ...baseConfig };
  }
  if (profile === "shift") {
    return {
      ...baseConfig,
      trainBars: 720,
      testBars: 120,
      stepBars: 120,
    };
  }
  return {
    ...baseConfig,
    trainBars: 600,
    testBars: 120,
    stepBars: 60,
  };
}

function computeHardGap(input: {
  pbo: number;
  dsrProbability: number;
  fdrQ: number;
  thresholds: {
    meanPboMax: number;
    meanDsrProbabilityMin: number;
    fdrQMax: number;
  };
}): {
  pboGap: number;
  dsrGap: number;
  fdrGap: number;
  totalGap: number;
} {
  const pboGap = Math.max(0, input.pbo - input.thresholds.meanPboMax);
  const dsrGap = Math.max(
    0,
    input.thresholds.meanDsrProbabilityMin - input.dsrProbability
  );
  const fdrGap = Math.max(0, input.fdrQ - input.thresholds.fdrQMax);
  return {
    pboGap,
    dsrGap,
    fdrGap,
    totalGap: pboGap + dsrGap + fdrGap,
  };
}

function buildWfoPenaltyBreakdown(wfoSummary: WfoSummary): {
  failedWindowRatio: number;
  degradationExceededRatio: number;
  nonPositiveSharpeRatio: number;
  meanDegradationRatePenalty: number;
} {
  const totalWindows = Math.max(1, wfoSummary.totalWindows);
  const degradationExceededCount =
    wfoSummary.failByReason["degradation_exceeded"] ?? 0;
  const nonPositiveSharpeCount =
    wfoSummary.failByReason["is_non_positive_sharpe"] ?? 0;
  return {
    failedWindowRatio: wfoSummary.failedWindowRatio,
    degradationExceededRatio: degradationExceededCount / totalWindows,
    nonPositiveSharpeRatio: nonPositiveSharpeCount / totalWindows,
    meanDegradationRatePenalty: Math.max(0, wfoSummary.meanDegradationRate ?? 0),
  };
}

function computeWfoRiskScore(breakdown: {
  failedWindowRatio: number;
  degradationExceededRatio: number;
  nonPositiveSharpeRatio: number;
  meanDegradationRatePenalty: number;
}): number {
  return (
    breakdown.failedWindowRatio +
    breakdown.degradationExceededRatio +
    breakdown.nonPositiveSharpeRatio +
    breakdown.meanDegradationRatePenalty
  );
}

function buildFdrFeasibility(input: {
  alpha: number;
  candidateCount: number;
  championFdrRank: number | null | undefined;
  championFdrQ: number;
  championDsrProbability: number;
}): {
  alpha: number;
  candidateCount: number;
  bestCaseMinDsrProbabilityForQPass: number | null;
  championRequiredMinDsrForCurrentRankQPass: number | null;
  championDsrGapToRequirement: number | null;
  championQGapToThreshold: number | null;
} {
  if (input.candidateCount <= 0) {
    return {
      alpha: input.alpha,
      candidateCount: input.candidateCount,
      bestCaseMinDsrProbabilityForQPass: null,
      championRequiredMinDsrForCurrentRankQPass: null,
      championDsrGapToRequirement: null,
      championQGapToThreshold: null,
    };
  }
  const bestCaseMinDsrProbabilityForQPass =
    1 - input.alpha / input.candidateCount;
  const validRank =
    Number.isFinite(input.championFdrRank) &&
    input.championFdrRank > 0 &&
    input.championFdrRank <= input.candidateCount;
  const championRequiredMinDsrForCurrentRankQPass = validRank
    ? 1 - input.alpha * (input.championFdrRank / input.candidateCount)
    : null;
  return {
    alpha: input.alpha,
    candidateCount: input.candidateCount,
    bestCaseMinDsrProbabilityForQPass,
    championRequiredMinDsrForCurrentRankQPass,
    championDsrGapToRequirement:
      championRequiredMinDsrForCurrentRankQPass == null
        ? null
        : championRequiredMinDsrForCurrentRankQPass - input.championDsrProbability,
    championQGapToThreshold: input.championFdrQ - input.alpha,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function meanNullable(values: number[]): number | null {
  if (values.length === 0) return null;
  return mean(values);
}

function medianNullable(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function summarizeWfo(wfo: WfoResult<StrategyParams>): WfoSummary {
  const failByReason = new Map<string, number>();
  const inSampleSharpes: number[] = [];
  const outOfSampleSharpes: number[] = [];
  const degradations: number[] = [];
  let worstDegradationRate: number | null = null;
  let worstWindowIndex: number | null = null;

  for (const window of wfo.windows) {
    if (Number.isFinite(window.inSample.sharpe)) {
      inSampleSharpes.push(window.inSample.sharpe);
    }
    if (Number.isFinite(window.outOfSample.sharpe)) {
      outOfSampleSharpes.push(window.outOfSample.sharpe);
    }
    if (Number.isFinite(window.degradationRate)) {
      degradations.push(window.degradationRate);
      if (
        worstDegradationRate === null ||
        window.degradationRate > worstDegradationRate
      ) {
        worstDegradationRate = window.degradationRate;
        worstWindowIndex = window.windowIndex;
      }
    }
    if (!window.gatePassed) {
      const reason = window.gateReason ?? "unknown";
      failByReason.set(reason, (failByReason.get(reason) ?? 0) + 1);
    }
  }

  const totalWindows = wfo.windows.length;
  const failedWindows = wfo.failedWindows;
  return {
    overallPassed: wfo.overallPassed,
    totalWindows,
    failedWindows,
    failedWindowRatio: totalWindows > 0 ? failedWindows / totalWindows : 0,
    failByReason: Object.fromEntries(
      Array.from(failByReason.entries()).sort((a, b) => b[1] - a[1])
    ),
    meanInSampleSharpe: meanNullable(inSampleSharpes),
    meanOutOfSampleSharpe: meanNullable(outOfSampleSharpes),
    meanDegradationRate: meanNullable(degradations),
    medianDegradationRate: medianNullable(degradations),
    worstDegradationRate,
    worstWindowIndex,
  };
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

main().catch((err) => {
  console.error("run_strategy_mvp_validation failed:", err);
  process.exit(1);
});
