import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  AdmissionIntent,
  SourceValidity,
} from "../../src/runtime/source_eligibility.js";
import type { StrategyBacktestInput } from "../../src/backtest/strategy-validation/backtest.js";
import type { StrategyName } from "../../src/backtest/strategy-validation/types.js";

export interface CandidateManifest {
  schemaVersion?: string;
  generatedAt?: string;
  batchId?: string;
  batchGoal?: string;
  notes?: string[];
  dataset?: Record<string, unknown>;
  thresholds?: Record<string, unknown>;
  wfo?: Record<string, unknown>;
  significance?: Record<string, unknown>;
  riskSimulation?: Record<string, unknown>;
  costModel?: Record<string, unknown>;
  candidates?: CandidateConfig[];
}

export interface CandidateConfig {
  strategyId: string;
  strategyName: string;
  strategy: StrategyName;
  applicableSymbols: string[];
  hypothesisFamily: string;
  correlationBucket: string;
  role?: "donor" | "benchmark_control" | "robustness_anchor" | "independent_guard";
  params: Record<string, unknown>;
  sourceValidity?: SourceValidity;
  donorNative?: boolean;
  promotionEligible?: boolean;
  admissionIntent?: AdmissionIntent;
  eligibilityBlockers?: string[];
  regimeGate?: StrategyBacktestInput["regimeGate"];
  volatilityGate?: StrategyBacktestInput["volatilityGate"];
}

export interface CompilerProvenance {
  schemaVersion: string;
  generatedAt: string;
  paradigmId: string;
  donorRepo: string;
  compiler: string;
  status: "compiled" | "unavailable";
  symbol: string;
  candidateCap: number;
  inputArtifact: string | null;
  baseManifest: string;
  manifestOutput: string;
  provenanceOutput: string;
  noteOutput: string;
  failureCode?: string | null;
  failureMessage?: string | null;
  sourceLogic: string[];
  emittedCandidateIds?: string[];
  inputsSnapshot?: Record<string, unknown>;
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(resolve(path), "utf-8");
  return JSON.parse(raw) as T;
}

export async function tryReadJson<T>(path: string | undefined): Promise<T | null> {
  if (!path) {
    return null;
  }
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

export function buildManifestFromBase(input: {
  baseManifest: CandidateManifest;
  batchId: string;
  batchGoal: string;
  notes: string[];
  candidates: CandidateConfig[];
}): CandidateManifest {
  return {
    ...input.baseManifest,
    schemaVersion: "strategy_candidates.v1",
    generatedAt: new Date().toISOString(),
    batchId: input.batchId,
    batchGoal: input.batchGoal,
    notes: [
      ...(Array.isArray(input.baseManifest.notes) ? input.baseManifest.notes : []),
      ...input.notes,
    ],
    candidates: input.candidates,
  };
}

export async function writeCompilerArtifacts(input: {
  manifest: CandidateManifest;
  manifestOutput: string;
  provenance: CompilerProvenance;
  provenanceOutput: string;
  note: string;
  noteOutput: string;
}): Promise<void> {
  await Promise.all([
    writeJsonFile(input.manifestOutput, input.manifest),
    writeJsonFile(input.provenanceOutput, input.provenance),
    writeTextFile(input.noteOutput, input.note),
  ]);
}

export async function writeUnavailableArtifacts(input: {
  provenance: CompilerProvenance;
  provenanceOutput: string;
  note: string;
  noteOutput: string;
}): Promise<void> {
  await Promise.all([
    writeJsonFile(input.provenanceOutput, input.provenance),
    writeTextFile(input.noteOutput, input.note),
  ]);
}

export function normalizeSymbolKey(symbol: string): string {
  return symbol.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function buildTrendCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  role?: CandidateConfig["role"];
  fast: number;
  slow: number;
  confirmBars: number;
  minDiffPct: number;
  allowShort: boolean;
  volatilityGate?: CandidateConfig["volatilityGate"];
}): CandidateConfig {
  const symbolKey = normalizeSymbolKey(input.symbol);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "trend",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    role: input.role,
    params: {
      trendFastPeriod: input.fast,
      trendSlowPeriod: input.slow,
      trendConfirmBars: input.confirmBars,
      trendMinDiffPct: input.minDiffPct,
      allowShort: input.allowShort,
    },
    volatilityGate: input.volatilityGate,
  };
}

export function buildRegimeTrendCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  role?: CandidateConfig["role"];
  fast: number;
  slow: number;
  allowShort: boolean;
  allowedEntryRegimes: string[];
  exitOnRegimeMismatch?: boolean;
  regimeGate?: CandidateConfig["regimeGate"];
  volatilityGate?: CandidateConfig["volatilityGate"];
}): CandidateConfig {
  const symbolKey = normalizeSymbolKey(input.symbol);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "regimeTrend",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    role: input.role,
    params: {
      regimeFastPeriod: input.fast,
      regimeSlowPeriod: input.slow,
      allowShort: input.allowShort,
      allowedEntryRegimes: input.allowedEntryRegimes,
      exitOnRegimeMismatch: input.exitOnRegimeMismatch ?? true,
    },
    regimeGate: input.regimeGate,
    volatilityGate: input.volatilityGate,
  };
}

export function buildMeanReversionCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  role?: CandidateConfig["role"];
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  bbPeriod: number;
  bbStdDev: number;
  allowShort: boolean;
  regimeGate?: CandidateConfig["regimeGate"];
  volatilityGate?: CandidateConfig["volatilityGate"];
}): CandidateConfig {
  const symbolKey = normalizeSymbolKey(input.symbol);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "meanReversion",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    role: input.role,
    params: {
      rsiPeriod: input.rsiPeriod,
      rsiOversold: input.rsiOversold,
      rsiOverbought: input.rsiOverbought,
      bbPeriod: input.bbPeriod,
      bbStdDev: input.bbStdDev,
      allowShort: input.allowShort,
    },
    regimeGate: input.regimeGate,
    volatilityGate: input.volatilityGate,
  };
}

export function buildBreakoutCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  role?: CandidateConfig["role"];
  breakoutPeriod: number;
  exitPeriod: number;
  allowShort: boolean;
  regimeGate?: CandidateConfig["regimeGate"];
  volatilityGate?: CandidateConfig["volatilityGate"];
}): CandidateConfig {
  const symbolKey = normalizeSymbolKey(input.symbol);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "breakout",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    role: input.role,
    params: {
      breakoutPeriod: input.breakoutPeriod,
      breakoutExitPeriod: input.exitPeriod,
      allowShort: input.allowShort,
    },
    regimeGate: input.regimeGate,
    volatilityGate: input.volatilityGate,
  };
}

export function buildEnsembleCandidate(input: {
  symbol: string;
  strategyId: string;
  strategyName: string;
  familySuffix: string;
  bucketSuffix: string;
  role?: CandidateConfig["role"];
  threshold: number;
  allowShort: boolean;
  weights: {
    trend: number;
    meanReversion: number;
    breakout: number;
  };
  regimeGate?: CandidateConfig["regimeGate"];
  volatilityGate?: CandidateConfig["volatilityGate"];
}): CandidateConfig {
  const symbolKey = normalizeSymbolKey(input.symbol);
  return {
    strategyId: input.strategyId,
    strategyName: input.strategyName,
    strategy: "ensemble",
    applicableSymbols: [input.symbol],
    hypothesisFamily: `${symbolKey}_${input.familySuffix}`,
    correlationBucket: `${symbolKey}_${input.bucketSuffix}`,
    role: input.role,
    params: {
      ensembleThreshold: input.threshold,
      allowShort: input.allowShort,
      ensembleWeights: input.weights,
    },
    regimeGate: input.regimeGate,
    volatilityGate: input.volatilityGate,
  };
}

export function renderCompilerNote(input: {
  paradigmId: string;
  donorRepo: string;
  status: "compiled" | "unavailable";
  sourceLogic: string[];
  failureCode?: string | null;
  failureMessage?: string | null;
  manifestOutput?: string;
  provenanceOutput: string;
  emittedCandidateIds?: string[];
}): string {
  const lines = [
    `# ${input.paradigmId}`,
    "",
    `- donorRepo: ${input.donorRepo}`,
    `- status: ${input.status}`,
    `- provenanceOutput: ${resolve(input.provenanceOutput)}`,
  ];
  if (input.manifestOutput) {
    lines.push(`- manifestOutput: ${resolve(input.manifestOutput)}`);
  }
  if (input.failureCode) {
    lines.push(`- failureCode: ${input.failureCode}`);
  }
  if (input.failureMessage) {
    lines.push(`- failureMessage: ${input.failureMessage}`);
  }
  if (Array.isArray(input.emittedCandidateIds) && input.emittedCandidateIds.length > 0) {
    lines.push(`- emittedCandidates: ${input.emittedCandidateIds.join(", ")}`);
  }
  lines.push("", "## Source Logic", "");
  for (const item of input.sourceLogic) {
    lines.push(`- ${item}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function writeTextFile(path: string, payload: string): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), payload, "utf-8");
}
