import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { evaluateReleaseGate } from "../src/backtest/release_gate.js";
import { evaluateRiskSimulation } from "../src/backtest/risk_simulation.js";
import { evaluateSignificanceGate } from "../src/backtest/statistical_significance.js";
import { runStrategyWalkForward } from "../src/backtest/wfo.js";
import type { MarketData } from "../src/extension/analysis-kit/data/interfaces.js";
import { runStrategyBacktest } from "../src/extension/strategy-tools/backtest.js";
import type { StrategyName, StrategyParams } from "../src/extension/strategy-tools/types.js";
import { writeReleaseGateStatus } from "../src/runtime/release_gate_status.js";

interface CliArgs {
  inputCsv: string;
  symbol: string;
  strategy: StrategyName;
  lookbackBars: number;
  output: string;
  params: StrategyParams;
  candidates?: StrategyParams[];
  feeRate: number;
  slippageBps: number;
  latencyBars: number;
  trainBars: number;
  testBars: number;
  stepBars: number;
  degradationThreshold: number;
  significancePartitions: number;
  riskSimulationMethod: "iid_bootstrap" | "moving_block_bootstrap";
  riskSimulationCount: number;
  riskHorizonBars: number;
  riskBlockSize: number;
  riskRuinDrawdownPct: number;
  riskMaxRuinProbability: number;
  riskMinProfitProbability: number;
  writeReleaseGateStatus: boolean;
  releaseGateStatusPath: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const candles = (await loadCsvCandles(args.inputCsv, args.symbol)).slice(
    -args.lookbackBars,
  );
  if (candles.length < args.trainBars + args.testBars) {
    throw new Error(
      `Not enough candles for WFO. Need >= ${args.trainBars + args.testBars}, got ${candles.length}.`,
    );
  }

  const candidates = ensureCandidates(args.strategy, args.params, args.candidates);
  const reports = candidates.map((candidate) =>
    runStrategyBacktest({
      strategy: args.strategy,
      candles,
      params: candidate,
      costModel: {
        feeRate: args.feeRate,
        slippageBps: args.slippageBps,
        latencyBars: args.latencyBars,
      },
    }),
  );

  const selected = [...reports].sort((a, b) => b.metrics.sharpe - a.metrics.sharpe)[0];

  const wfo = runStrategyWalkForward({
    strategy: args.strategy,
    candles,
    candidates,
    costModel: {
      feeRate: args.feeRate,
      slippageBps: args.slippageBps,
      latencyBars: args.latencyBars,
    },
    config: {
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
      degradationThreshold: args.degradationThreshold,
      minTradesPerWindow: 1,
    },
  });

  const significance = evaluateSignificanceGate({
    candidateReturns: reports.map((report) => equityCurveToReturns(report.equityCurve)),
    selectedReturns: equityCurveToReturns(selected.equityCurve),
    partitions: args.significancePartitions,
    pboThreshold: 0.2,
    dsrMin: 0,
    trialCount: reports.length,
  });

  const riskSimulation = evaluateRiskSimulation(
    equityCurveToReturns(selected.equityCurve),
    {
      method: args.riskSimulationMethod,
      simulations: args.riskSimulationCount,
      horizonBars: args.riskHorizonBars,
      blockSize: args.riskBlockSize,
      ruinDrawdownPct: args.riskRuinDrawdownPct,
      maxRuinProbability: args.riskMaxRuinProbability,
      minProfitProbability: args.riskMinProfitProbability,
    },
  );

  const releaseGate = evaluateReleaseGate({
    wfo,
    significance,
    riskSimulation,
  });

  const summary = {
    generatedAt: new Date().toISOString(),
    input: {
      csv: resolve(args.inputCsv),
      symbol: args.symbol,
      strategy: args.strategy,
      lookbackBars: candles.length,
    },
    selectedParams: selected.params,
    selectedMetrics: selected.metrics,
    wfo: {
      overallPassed: wfo.overallPassed,
      failedWindows: wfo.failedWindows,
      windows: wfo.windows.map((window) => ({
        windowIndex: window.windowIndex,
        selectedCandidate: window.selectedCandidate.id,
        inSampleSharpe: window.inSample.sharpe,
        outOfSampleSharpe: window.outOfSample.sharpe,
        degradationRate: window.degradationRate,
        gatePassed: window.gatePassed,
        gateReason: window.gateReason ?? null,
      })),
    },
    significance: {
      passed: significance.passed,
      pbo: significance.pboResult.pbo,
      dsrValue: significance.dsrResult.dsrValue,
      dsrProbability: significance.dsrResult.dsrProbability,
    },
    riskSimulation,
    releaseGate,
  };

  const outputPath = resolve(args.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf-8");

  if (args.writeReleaseGateStatus) {
    await writeReleaseGateStatus(releaseGate, {
      filePath: args.releaseGateStatusPath,
      sourceReportPath: outputPath,
    });
  }

  console.log(
    [
      `validation report: ${outputPath}`,
      `releaseGateStatus=${args.writeReleaseGateStatus ? resolve(args.releaseGateStatusPath) : "skip"}`,
      `paper=${releaseGate.allowPaperTrading}`,
      `live=${releaseGate.allowLiveTrading}`,
      `failedChecks=${releaseGate.failedChecks.join(",") || "none"}`,
    ].join(" | "),
  );

  if (!releaseGate.allowPaperTrading) {
    process.exitCode = 2;
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  const strategy = parseStrategy(raw.get("strategy") ?? "trend");
  const params = parseJsonArg<StrategyParams>(raw.get("paramsJson"), {});
  const candidates = parseJsonArg<StrategyParams[] | undefined>(
    raw.get("candidatesJson"),
    undefined,
  );
  const output =
    raw.get("output") ??
    `logs/research/validation_${new Date().toISOString().replaceAll(":", "-")}.json`;

  const riskSimulationMethodRaw =
    raw.get("riskSimulationMethod") ?? "moving_block_bootstrap";
  const riskSimulationMethod =
    riskSimulationMethodRaw === "iid_bootstrap"
      ? "iid_bootstrap"
      : "moving_block_bootstrap";

  return {
    inputCsv: raw.get("inputCsv") ?? "data/market/okx/BTC_USDT_USDT_1h.csv",
    symbol: raw.get("symbol") ?? "BTC/USD",
    strategy,
    lookbackBars: parseIntArg(raw.get("lookbackBars"), 3000, "lookbackBars"),
    output,
    params,
    candidates,
    feeRate: parseNumberArg(raw.get("feeRate"), 0.0006, "feeRate"),
    slippageBps: parseNumberArg(raw.get("slippageBps"), 8, "slippageBps"),
    latencyBars: parseIntArg(raw.get("latencyBars"), 1, "latencyBars"),
    trainBars: parseIntArg(raw.get("trainBars"), 24 * 365, "trainBars"),
    testBars: parseIntArg(raw.get("testBars"), 24 * 90, "testBars"),
    stepBars: parseIntArg(raw.get("stepBars"), 24 * 90, "stepBars"),
    degradationThreshold: parseNumberArg(
      raw.get("degradationThreshold"),
      0.4,
      "degradationThreshold",
    ),
    significancePartitions: parseIntArg(
      raw.get("significancePartitions"),
      8,
      "significancePartitions",
    ),
    riskSimulationMethod,
    riskSimulationCount: parseIntArg(
      raw.get("riskSimulationCount"),
      5000,
      "riskSimulationCount",
    ),
    riskHorizonBars: parseIntArg(
      raw.get("riskHorizonBars"),
      24 * 90,
      "riskHorizonBars",
    ),
    riskBlockSize: parseIntArg(raw.get("riskBlockSize"), 24, "riskBlockSize"),
    riskRuinDrawdownPct: parseNumberArg(
      raw.get("riskRuinDrawdownPct"),
      30,
      "riskRuinDrawdownPct",
    ),
    riskMaxRuinProbability: parseNumberArg(
      raw.get("riskMaxRuinProbability"),
      0.02,
      "riskMaxRuinProbability",
    ),
    riskMinProfitProbability: parseNumberArg(
      raw.get("riskMinProfitProbability"),
      0.55,
      "riskMinProfitProbability",
    ),
    writeReleaseGateStatus: parseBoolArg(raw.get("writeReleaseGateStatus"), true),
    releaseGateStatusPath:
      raw.get("releaseGateStatusPath") ?? "data/runtime/release_gate_status.json",
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

function parseStrategy(value: string): StrategyName {
  if (
    value === "trend" ||
    value === "regimeTrend" ||
    value === "meanReversion" ||
    value === "breakout" ||
    value === "ensemble"
  ) {
    return value;
  }
  throw new Error(`Unsupported strategy: ${value}`);
}

function parseJsonArg<T>(raw: string | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw) as T;
}

function parseIntArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function parseNumberArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function ensureCandidates(
  strategy: StrategyName,
  base: StrategyParams,
  provided?: StrategyParams[],
): StrategyParams[] {
  if (provided && provided.length > 0) {
    return provided;
  }

  switch (strategy) {
    case "trend":
      return [
        { ...base },
        {
          ...base,
          trendFastPeriod: Math.max(5, (base.trendFastPeriod ?? 20) - 5),
          trendSlowPeriod: Math.max(15, (base.trendSlowPeriod ?? 50) + 5),
        },
        {
          ...base,
          trendFastPeriod: Math.max(6, (base.trendFastPeriod ?? 20) + 3),
          trendSlowPeriod: Math.max(18, (base.trendSlowPeriod ?? 50) + 12),
        },
      ];
    case "regimeTrend":
      return [
        { ...base },
        {
          ...base,
          allowedEntryRegimes: ["HighVolTrend"],
          exitOnRegimeMismatch: true,
        },
        {
          ...base,
          allowedEntryRegimes: ["HighVolTrend", "LowVolTrend"],
          exitOnRegimeMismatch: true,
        },
      ];
    case "meanReversion":
      return [
        { ...base },
        {
          ...base,
          rsiOversold: Math.max(10, (base.rsiOversold ?? 30) - 5),
          rsiOverbought: Math.min(90, (base.rsiOverbought ?? 70) + 5),
        },
        {
          ...base,
          bbStdDev: Math.max(1, (base.bbStdDev ?? 2) + 0.5),
        },
      ];
    case "breakout":
      return [
        { ...base },
        {
          ...base,
          breakoutPeriod: Math.max(10, (base.breakoutPeriod ?? 20) - 5),
          breakoutExitPeriod: Math.max(5, (base.breakoutExitPeriod ?? 10) - 2),
        },
        {
          ...base,
          breakoutPeriod: (base.breakoutPeriod ?? 20) + 5,
          breakoutExitPeriod: (base.breakoutExitPeriod ?? 10) + 3,
        },
      ];
    case "ensemble":
      return [
        { ...base },
        {
          ...base,
          ensembleThreshold: Math.min(0.9, (base.ensembleThreshold ?? 0.55) + 0.1),
        },
        {
          ...base,
          ensembleThreshold: Math.max(0.45, (base.ensembleThreshold ?? 0.55) - 0.1),
        },
      ];
    default:
      return [{ ...base }];
  }
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
  console.error("run_validation_pipeline failed:", err);
  process.exit(1);
});
