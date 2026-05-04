import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ICryptoTradingEngine } from "../domain/trading/operation-dispatcher.types.js";
import {
  buildPortfolioTargetFromWeights,
  type PortfolioTarget,
} from "../portfolio/target.js";
import { loadChampionRegistry } from "./champion_registry.js";
import type { RuntimePlanningState } from "./live_gate_manager.js";
import { loadReleaseGateStatus } from "./release_gate_status.js";
import {
  evaluateRuntimeTruthPipeline,
  type RuntimeTruthPipelineResult,
} from "./runtime_truth_pipeline.js";
import {
  DEFAULT_PROMOTION_READINESS_V2_PATH,
  tryLoadPromotionReadinessV2,
  type PromotionReadinessV2LoadResult,
  tryLoadValidatedPromotionReadinessV2,
  type PromotionReadinessV2ValidatedLoadResult,
} from "./promotion_v2_artifacts.js";
import {
  DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR,
  writeRuntimeStatusSnapshot,
} from "./runtime_status_snapshot.js";
import type { RuntimeProofTrackingInput } from "./runtime_status_snapshot.js";

export interface RuntimeTruthMainlineOptions {
  symbols: string[];
  validationRunsPath?: string;
  verdictPath?: string;
  releaseGateStatusPath?: string;
  registryPath?: string;
  portfolioTargetPath?: string;
  runtimePublishStatePath?: string;
  snapshotBaseDir?: string;
  paperExecutorEnabled?: boolean;
  promotionReadinessV2Path?: string;
  requirePromotionV2?: boolean;
  validatePromotionV2Artifacts?: boolean;
  proofTracking?: RuntimeProofTrackingInput;
  now?: Date;
}

export interface RuntimeTruthPlanningStateProvider {
  buildRuntimePlanningState(): Promise<RuntimePlanningState>;
}

export interface RuntimeTruthMainlineResult {
  truth: RuntimeTruthPipelineResult;
  portfolioTargetSource: "file" | "fallback_zero_target";
  runtimeAvailability: {
    healthy: boolean;
    reason: string | null;
  };
  promotionV2: {
    required: boolean;
    path: string | null;
    loadStatus: "not_requested" | PromotionReadinessV2LoadResult["kind"] | PromotionReadinessV2ValidatedLoadResult["kind"];
    error: string | null;
  };
  phaseReadiness: RuntimeTruthPipelineResult["snapshot"]["phaseReadiness"];
}

const DEFAULT_VALIDATION_RUNS_PATH =
  "data/research/strategy/strategy_validation_runs.json";
const DEFAULT_VERDICT_PATH =
  "data/research/strategy/experiment_verdict.v2.json";
const DEFAULT_RELEASE_GATE_STATUS_PATH =
  "data/runtime/release_gate_status.json";
const DEFAULT_REGISTRY_PATH = "data/runtime/paper_champion_registry.json";
const DEFAULT_PORTFOLIO_TARGET_PATH = "data/runtime/paper_portfolio_target.json";
const DEFAULT_RUNTIME_PUBLISH_STATE_PATH =
  "data/runtime/runtime_publish_state.json";
const DEFAULT_SNAPSHOT_BASE_DIR = DEFAULT_RUNTIME_STATUS_SNAPSHOT_BASE_DIR;

export async function refreshRuntimeTruthMainline(
  engine: ICryptoTradingEngine,
  planningStateProvider: RuntimeTruthPlanningStateProvider,
  opts: RuntimeTruthMainlineOptions,
): Promise<RuntimeTruthMainlineResult> {
  const now = opts.now ?? new Date();
  const symbols = uniqueSymbols(opts.symbols);
  const snapshotBaseDir = opts.snapshotBaseDir ?? DEFAULT_SNAPSHOT_BASE_DIR;
  const [
    validationRuns,
    experimentVerdict,
    releaseGateStatus,
    championRegistry,
    planningState,
    currentPositions,
    pricesBySymbol,
    runtimePublishStateResult,
    promotionV2Load,
  ] = await Promise.all([
    readJsonOrNull(opts.validationRunsPath ?? DEFAULT_VALIDATION_RUNS_PATH),
    readJsonOrNull(opts.verdictPath ?? DEFAULT_VERDICT_PATH),
    loadReleaseGateStatus(
      opts.releaseGateStatusPath ?? DEFAULT_RELEASE_GATE_STATUS_PATH,
    ),
    loadChampionRegistry(opts.registryPath ?? DEFAULT_REGISTRY_PATH),
    planningStateProvider.buildRuntimePlanningState(),
    engine.getPositions(),
    loadPricesBySymbol(engine, symbols),
    loadRuntimePublishState(
      opts.runtimePublishStatePath ?? DEFAULT_RUNTIME_PUBLISH_STATE_PATH,
    ),
    resolvePromotionReadinessV2ForMainline(opts),
  ]);

  const runtimeAvailability = resolveRuntimeAvailability(runtimePublishStateResult)
  const portfolioTargetResult = await loadPortfolioTargetOrFallback({
    path: opts.portfolioTargetPath ?? DEFAULT_PORTFOLIO_TARGET_PATH,
    symbols,
    now,
    forceFallback: runtimeAvailability.healthy === false,
  })

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
    snapshotBaseDir,
    runtimeHealthy: runtimeAvailability.healthy,
    paperExecutorEnabled: runtimeAvailability.healthy
      ? (opts.paperExecutorEnabled ?? portfolioTargetResult.source === "file")
      : false,
    promotionReadinessV2:
      promotionV2Load.result?.kind === "loaded"
        ? promotionV2Load.result.readiness
        : promotionV2Load.result?.kind === "invalid" && promotionV2Load.result.readiness
          ? promotionV2Load.result.readiness
        : null,
    requirePromotionV2: opts.requirePromotionV2,
    proofTracking: opts.proofTracking,
    now,
  });

  if (!runtimeAvailability.healthy) {
    truth.snapshot.paperGateStatus = {
      ...truth.snapshot.paperGateStatus,
      runtimeHealthy: false,
    }
    const runtimeFaithfulSimulation = truth.snapshot
      .runtimeFaithfulSimulation as Record<string, unknown> & {
      paperGate?: Record<string, unknown>
    }
    if (runtimeFaithfulSimulation.paperGate) {
      runtimeFaithfulSimulation.paperGate = {
        ...runtimeFaithfulSimulation.paperGate,
        runtimeHealthy: false,
      }
    }
  }

  await writeRuntimeStatusSnapshot(truth.snapshot, {
    baseDir: snapshotBaseDir,
  });

  return {
    truth,
    portfolioTargetSource: portfolioTargetResult.source,
    runtimeAvailability,
    promotionV2: {
      required: opts.requirePromotionV2 === true,
      path: promotionV2Load.path,
      loadStatus: promotionV2Load.result?.kind ?? "not_requested",
      error:
        promotionV2Load.result && promotionV2Load.result.kind !== "loaded"
          ? promotionV2Load.result.error
          : null,
    },
    phaseReadiness: truth.snapshot.phaseReadiness,
  };
}

async function resolvePromotionReadinessV2ForMainline(
  opts: RuntimeTruthMainlineOptions,
): Promise<{
  path: string | null;
  result: PromotionReadinessV2LoadResult | PromotionReadinessV2ValidatedLoadResult | null;
}> {
  const shouldLoad = opts.requirePromotionV2 === true || Boolean(opts.promotionReadinessV2Path);
  if (!shouldLoad) {
    return {
      path: null,
      result: null,
    };
  }

  const path = opts.promotionReadinessV2Path ?? DEFAULT_PROMOTION_READINESS_V2_PATH;
  const validateArtifacts = opts.validatePromotionV2Artifacts ?? (opts.requirePromotionV2 === true);
  return {
    path,
    result: validateArtifacts
      ? await tryLoadValidatedPromotionReadinessV2(dirname(path), { now: opts.now })
      : await tryLoadPromotionReadinessV2(path),
  };
}

async function loadPortfolioTargetOrFallback(input: {
  path: string;
  symbols: string[];
  now: Date;
  forceFallback: boolean;
}): Promise<{ target: PortfolioTarget; source: "file" | "fallback_zero_target" }> {
  if (input.forceFallback) {
    return buildFallbackZeroTarget(input.symbols, input.now);
  }
  const raw = await readJsonOrNull(input.path);
  if (raw && isPortfolioTarget(raw)) {
    return {
      target: raw,
      source: "file",
    };
  }

  return buildFallbackZeroTarget(input.symbols, input.now)
}

interface RuntimePublishState {
  version: 1;
  generatedAt: string;
  mode: "publish";
  status: "pending" | "complete";
  bundleDir: string;
  backupDir: string;
  runtimeStatePath?: string | null;
  targets: Array<{
    name: string;
    sourcePath: string;
    targetPath: string;
    backupPath: string | null;
    existedBefore: boolean;
  }>;
}

type RuntimePublishStateLoadResult =
  | { kind: "missing"; state: null }
  | { kind: "invalid"; state: null }
  | { kind: "loaded"; state: RuntimePublishState };

async function loadRuntimePublishState(
  path: string,
): Promise<RuntimePublishStateLoadResult> {
  try {
    const raw = JSON.parse(await readFile(path, "utf-8")) as Partial<RuntimePublishState> & Record<string, unknown>;
    if (
      raw.version === 1 &&
      raw.mode === "publish" &&
      typeof raw.generatedAt === "string" &&
      typeof raw.bundleDir === "string" &&
      typeof raw.backupDir === "string" &&
      Array.isArray(raw.targets) &&
      (raw.status === "pending" || raw.status === "complete")
    ) {
      return {
        kind: "loaded",
        state: raw as RuntimePublishState,
      };
    }
    return { kind: "invalid", state: null };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { kind: "missing", state: null };
    }
    return { kind: "invalid", state: null };
  }
}

function resolveRuntimeAvailability(
  input: RuntimePublishStateLoadResult,
): { healthy: boolean; reason: string | null } {
  if (input.kind === "missing") {
    return { healthy: true, reason: null }
  }
  if (input.kind === "invalid") {
    return { healthy: false, reason: "runtime_publish_state_invalid" }
  }
  if (input.state.status !== "complete") {
    return {
      healthy: false,
      reason: "runtime_publish_state_pending",
    }
  }
  const expectedTargetNames = new Set([
    "validationRuns",
    "experimentVerdict",
    "releaseGateStatus",
    "championRegistry",
    "paperPortfolioTarget",
  ])
  const observedTargetNames = new Set(
    input.state.targets.map(target => target.name),
  )
  const targetsComplete =
    observedTargetNames.size === expectedTargetNames.size &&
    Array.from(expectedTargetNames).every(name => observedTargetNames.has(name))
  if (!targetsComplete) {
    return {
      healthy: false,
      reason: "runtime_publish_state_incomplete",
    }
  }
  return { healthy: true, reason: null }
}

function buildFallbackZeroTarget(
  symbols: string[],
  now: Date,
): { target: PortfolioTarget; source: "fallback_zero_target" } {
  return {
    target: buildPortfolioTargetFromWeights({
      basisEquityUsd: 1_000,
      generatedAt: now.toISOString(),
      maxTurnoverPct: 1,
      weights: Object.fromEntries(symbols.map(symbol => [symbol, 0])),
      sizingReasonBySymbol: Object.fromEntries(
        symbols.map(symbol => [symbol, "runtime_truth_fallback_zero_target"]),
      ),
      notes: [
        "source=runtime_truth_mainline",
        "fallback_zero_target=true",
      ],
    }),
    source: "fallback_zero_target",
  }
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
