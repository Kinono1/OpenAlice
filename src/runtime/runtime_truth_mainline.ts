import { readFile } from "node:fs/promises";
import type { ICryptoTradingEngine } from "../extension/crypto-trading/interfaces.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";
import { loadChampionRegistry } from "./champion_registry.js";
import type { LiveGateManager } from "./live_gate_manager.js";
import { loadReleaseGateStatus } from "./release_gate_status.js";
import {
  evaluateRuntimeTruthPipeline,
  type RuntimeTruthPipelineResult,
} from "./runtime_truth_pipeline.js";
import { writeRuntimeStatusSnapshot } from "./runtime_status_snapshot.js";
import type { RuntimeProofTrackingInput } from "./runtime_status_snapshot.js";

export interface RuntimeTruthMainlineOptions {
  symbols: string[];
  validationRunsPath?: string;
  verdictPath?: string;
  releaseGateStatusPath?: string;
  registryPath?: string;
  portfolioTargetPath?: string;
  snapshotBaseDir?: string;
  paperExecutorEnabled?: boolean;
  proofTracking?: RuntimeProofTrackingInput;
  now?: Date;
}

export interface RuntimeTruthMainlineResult {
  truth: RuntimeTruthPipelineResult;
  portfolioTargetSource: "file" | "fallback_zero_target";
  phaseReadiness: RuntimeTruthPipelineResult["snapshot"]["phaseReadiness"];
}

type RuntimePlanningStateBuilder = Pick<LiveGateManager, "buildRuntimePlanningState">;

const DEFAULT_VALIDATION_RUNS_PATH =
  "data/research/strategy/strategy_validation_runs.json";
const DEFAULT_VERDICT_PATH =
  "data/research/strategy/experiment_verdict.v2.json";
const DEFAULT_RELEASE_GATE_STATUS_PATH =
  "data/runtime/release_gate_status.json";
const DEFAULT_REGISTRY_PATH = "data/runtime/paper_champion_registry.json";
const DEFAULT_PORTFOLIO_TARGET_PATH = "data/runtime/paper_portfolio_target.json";
const DEFAULT_SNAPSHOT_BASE_DIR = "data/runtime";

export async function refreshRuntimeTruthMainline(
  engine: ICryptoTradingEngine,
  liveGateManager: RuntimePlanningStateBuilder,
  opts: RuntimeTruthMainlineOptions,
): Promise<RuntimeTruthMainlineResult> {
  const now = opts.now ?? new Date();
  const symbols = uniqueSymbols(opts.symbols);
  const [
    validationRuns,
    experimentVerdict,
    releaseGateStatus,
    championRegistry,
    planningState,
    currentPositions,
    portfolioTargetResult,
    pricesBySymbol,
  ] = await Promise.all([
    readJsonOrNull(opts.validationRunsPath ?? DEFAULT_VALIDATION_RUNS_PATH),
    readJsonOrNull(opts.verdictPath ?? DEFAULT_VERDICT_PATH),
    loadReleaseGateStatus(
      opts.releaseGateStatusPath ?? DEFAULT_RELEASE_GATE_STATUS_PATH,
    ),
    loadChampionRegistry(opts.registryPath ?? DEFAULT_REGISTRY_PATH),
    liveGateManager.buildRuntimePlanningState(),
    engine.getPositions(),
    loadPortfolioTargetOrFallback({
      path: opts.portfolioTargetPath ?? DEFAULT_PORTFOLIO_TARGET_PATH,
      symbols,
      now,
    }),
    loadPricesBySymbol(engine, symbols),
  ]);

  const truth = evaluateRuntimeTruthPipeline({
    validationRuns,
    experimentVerdict,
    releaseGateStatus,
    championRegistry,
    planningState,
    portfolioTarget: portfolioTargetResult.target,
    currentPositions,
    pricesBySymbol,
    validationRunsPath: opts.validationRunsPath ?? DEFAULT_VALIDATION_RUNS_PATH,
    verdictPath: opts.verdictPath ?? DEFAULT_VERDICT_PATH,
    releaseGateStatusPath:
      opts.releaseGateStatusPath ?? DEFAULT_RELEASE_GATE_STATUS_PATH,
    registryPath: opts.registryPath ?? DEFAULT_REGISTRY_PATH,
    paperExecutorEnabled:
      opts.paperExecutorEnabled ?? portfolioTargetResult.source === "file",
    proofTracking: opts.proofTracking,
    now,
  });

  await writeRuntimeStatusSnapshot(truth.snapshot, {
    baseDir: opts.snapshotBaseDir ?? DEFAULT_SNAPSHOT_BASE_DIR,
  });

  return {
    truth,
    portfolioTargetSource: portfolioTargetResult.source,
    phaseReadiness: truth.snapshot.phaseReadiness,
  };
}

async function loadPortfolioTargetOrFallback(input: {
  path: string;
  symbols: string[];
  now: Date;
}): Promise<{ target: PortfolioTarget; source: "file" | "fallback_zero_target" }> {
  const raw = await readJsonOrNull(input.path);
  if (raw && isPortfolioTarget(raw)) {
    return {
      target: raw,
      source: "file",
    };
  }

  return {
    target: buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      generatedAt: input.now.toISOString(),
      maxTurnoverPct: 1,
      weights: Object.fromEntries(input.symbols.map(symbol => [symbol, 0])),
      sizingReasonBySymbol: Object.fromEntries(
        input.symbols.map(symbol => [symbol, "runtime_truth_fallback_zero_target"]),
      ),
      notes: [
        "source=runtime_truth_mainline",
        "fallback_zero_target=true",
      ],
    }),
    source: "fallback_zero_target",
  };
}

async function loadPricesBySymbol(
  engine: ICryptoTradingEngine,
  symbols: string[],
): Promise<Record<string, number>> {
  const prices = await Promise.all(
    symbols.map(async symbol => {
      try {
        const ticker = await engine.getTicker(symbol);
        if (Number.isFinite(ticker.last) && ticker.last > 0) {
          return [symbol, ticker.last] as const;
        }
      } catch {
        // no-op: omit unavailable symbols from price map
      }
      return null;
    }),
  );

  return Object.fromEntries(
    prices.filter((entry): entry is readonly [string, number] => entry !== null),
  );
}

async function readJsonOrNull(path: string): Promise<unknown | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
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

function uniqueSymbols(symbols: string[]): string[] {
  return Array.from(
    new Set(
      symbols
        .map(symbol => symbol.trim())
        .filter(Boolean),
    ),
  );
}

function isPortfolioTarget(value: unknown): value is PortfolioTarget {
  if (!value || typeof value !== "object") {
    return false;
  }

  const target = value as Partial<PortfolioTarget>;
  return (
    target.version === 1 &&
    typeof target.generatedAt === "string" &&
    typeof target.basisEquityUsd === "number" &&
    typeof target.targetGrossExposure === "number" &&
    typeof target.targetNetExposure === "number" &&
    typeof target.maxTurnoverPct === "number" &&
    Array.isArray(target.positions)
  );
}
