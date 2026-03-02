import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { benjaminiHochberg } from "../src/backtest/fdr.js";
import { evaluateReleaseGate } from "../src/backtest/release_gate.js";
import { evaluateRiskSimulation } from "../src/backtest/risk_simulation.js";
import { evaluateSignificanceGate } from "../src/backtest/statistical_significance.js";
import { runStrategyWalkForward } from "../src/backtest/wfo.js";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import { runStrategyBacktest } from "../src/extension/strategy-tools/backtest.js";
import type {
  StrategyName,
  StrategyParams,
} from "../src/extension/strategy-tools/types.js";
import { writeReleaseGateStatus } from "../src/runtime/release_gate_status.js";

type BootstrapMethod = "iid_bootstrap" | "moving_block_bootstrap";

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

  const wfoConfig = {
    trainBars: toPositiveInt(cfg.wfo?.trainBars, 24 * 365, "trainBars"),
    testBars: toPositiveInt(cfg.wfo?.testBars, 24 * 90, "testBars"),
    stepBars: toPositiveInt(cfg.wfo?.stepBars, 24 * 90, "stepBars"),
    degradationThreshold: toFiniteNumber(
      cfg.wfo?.degradationThreshold,
      0.4,
      "degradationThreshold"
    ),
  };

  const significanceConfig = {
    partitions: toPositiveInt(cfg.significance?.partitions, 8, "partitions"),
    pboThreshold: toFiniteNumber(
      cfg.significance?.pboThreshold,
      0.2,
      "pboThreshold"
    ),
    dsrMin: toFiniteNumber(cfg.significance?.dsrMin, 0.0, "dsrMin"),
  };

  const riskConfig = {
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

  const fdrItems = benjaminiHochberg(
    rawRuns.map((run) => run.pValue),
    thresholds.fdrQMax
  );

  const enrichedRuns = rawRuns.map((run, idx) => {
    const fdr = fdrItems[idx];
    const candidatePass =
      run.significance.pboResult.pbo <= thresholds.meanPboMax &&
      run.significance.dsrResult.dsrProbability >= thresholds.meanDsrProbabilityMin &&
      fdr.qValue <= thresholds.fdrQMax &&
      run.releaseGate.allowPaperTrading;

    const failureReasons: string[] = [];
    if (run.significance.pboResult.pbo > thresholds.meanPboMax) {
      failureReasons.push("HARD_PBO_THRESHOLD_FAIL");
    }
    if (run.significance.dsrResult.dsrProbability < thresholds.meanDsrProbabilityMin) {
      failureReasons.push("HARD_DSR_PROBABILITY_THRESHOLD_FAIL");
    }
    if (fdr.qValue > thresholds.fdrQMax) {
      failureReasons.push("HARD_FDR_THRESHOLD_FAIL");
    }
    if (!run.releaseGate.allowPaperTrading) {
      failureReasons.push("HARD_RELEASE_GATE_BLOCKED");
    }

    return {
      ...run,
      fdr,
      candidatePass,
      failureReasons,
    };
  });

  const champion = [...enrichedRuns].sort(
    (a, b) => b.backtest.metrics.sharpe - a.backtest.metrics.sharpe
  )[0];

  const meanPbo = mean(enrichedRuns.map((run) => run.significance.pboResult.pbo));
  const meanDsrProbability = mean(
    enrichedRuns.map((run) => run.significance.dsrResult.dsrProbability)
  );
  const fdrQ = champion.fdr.qValue;

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
      wfo: wfoConfig,
      significance: significanceConfig,
      riskSimulation: riskConfig,
      costModel,
    },
    aggregateMetrics: {
      meanPbo,
      meanDsrProbability,
      fdrQ,
    },
    champion: {
      strategyId: champion.candidate.strategyId,
      strategyName: champion.candidate.strategyName,
      sharpe: champion.backtest.metrics.sharpe,
      releaseGateAllowPaper: champion.releaseGate.allowPaperTrading,
      releaseGateAllowLive: champion.releaseGate.allowLiveTrading,
    },
    candidates: enrichedRuns.map((run) => ({
      strategyId: run.candidate.strategyId,
      strategyName: run.candidate.strategyName,
      strategy: run.candidate.strategy,
      params: run.candidate.params,
      status: run.candidatePass ? "pass" : "fail",
      failureReasons: run.failureReasons,
      backtestMetrics: run.backtest.metrics,
      significance: {
        pbo: run.significance.pboResult.pbo,
        dsrValue: run.significance.dsrResult.dsrValue,
        dsrProbability: run.significance.dsrResult.dsrProbability,
      },
      fdr: run.fdr,
      releaseGate: run.releaseGate,
    })),
    result: aggregatePass ? "GO" : "NO_GO",
    reasonCodes,
  };
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
    },
    candidates: enrichedRuns.map((run) => ({
      strategyId: run.candidate.strategyId,
      strategyName: run.candidate.strategyName,
      status: run.candidatePass ? "pass" : "fail",
      metrics: {
        pbo: run.significance.pboResult.pbo,
        dsrProbability: run.significance.dsrResult.dsrProbability,
        fdrQ: run.fdr.qValue,
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
