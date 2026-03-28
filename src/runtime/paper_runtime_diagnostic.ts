import { resolve } from "node:path";
import { loadConfig } from "../core/config.js";
import { getStrategyMinimumBars } from "../extension/strategy-tools/strategies.js";
import { OpenBBCryptoClient } from "../openbb/crypto/index.js";
import { buildGateSummary, type GateSummary } from "./gate_summary.js";
import type { LiveMarketContext, LiveMarketDataBar } from "./live_gate_manager.js";
import { createOpenBBCryptoLiveMarketContext } from "./openbb_live_market_context.js";
import {
  loadPaperChampionRegistry,
  type PaperChampionRegistry,
} from "./paper_champion_registry.js";
import {
  isPaperReleaseGateStatusBlocking,
  loadReleaseGateStatus,
  type PersistedReleaseGateStatus,
} from "./release_gate_status.js";
import {
  runRuntimeFaithfulSimulation,
  type RuntimeFaithfulSimulationArtifact,
  type RuntimeFaithfulSimulationInput,
} from "./runtime_faithful_simulation.js";

export interface PaperRuntimeDiagnosticArgs {
  registryPath?: string;
  releaseGateStatusPath?: string;
  runtimeHealthy?: boolean;
  dataFresh?: boolean;
  connectorHealthy?: boolean;
  riskLimitsLoaded?: boolean;
  paperExecutorEnabled?: boolean;
  lookbackBars?: number;
}

export interface PaperRuntimeDiagnosticStatusArtifact {
  generatedAt: string;
  mode: "diagnostic";
  symbolSetUsed: string[];
  lookbackBars: number;
  preflight: {
    releaseGateState: "missing" | "blocked" | "pass";
    releaseGateReason?: string;
    championRegistryState: "missing" | "blocked" | "pass";
    championRegistryReasons: string[];
  };
  summary: GateSummary;
}

export interface PaperRuntimeDiagnosticResult {
  artifact: RuntimeFaithfulSimulationArtifact;
  summary: GateSummary;
  statusArtifact: PaperRuntimeDiagnosticStatusArtifact;
}

type LoadedConfig = Awaited<ReturnType<typeof loadConfig>>;

export interface PaperRuntimeDiagnosticDeps {
  loadConfig: () => Promise<LoadedConfig>;
  loadPaperChampionRegistry: (
    filePath?: string,
  ) => Promise<PaperChampionRegistry | null>;
  loadReleaseGateStatus: (
    filePath?: string,
  ) => Promise<PersistedReleaseGateStatus | null>;
  createMarketContext: (
    config: LoadedConfig,
    symbols: string[],
  ) => LiveMarketContext;
  now: () => Date;
}

const DEFAULT_LOOKBACK_BARS = 200;

export async function runPaperRuntimeDiagnostic(
  args: PaperRuntimeDiagnosticArgs = {},
  deps: PaperRuntimeDiagnosticDeps = createDefaultDeps(),
): Promise<PaperRuntimeDiagnosticResult> {
  const config = await deps.loadConfig();
  const registryPath = resolve(
    args.registryPath ?? "data/runtime/paper_champion_registry.json",
  );
  const releaseGateStatusPath = resolve(
    args.releaseGateStatusPath ?? "data/runtime/release_gate_status.json",
  );

  const registry = await deps.loadPaperChampionRegistry(registryPath);
  const releaseGateStatus = await deps.loadReleaseGateStatus(releaseGateStatusPath);
  const symbolSetUsed = resolveDiagnosticSymbols(registry, config);
  const lookbackBars = resolveDiagnosticLookbackBars(registry, args.lookbackBars);
  const marketContext = deps.createMarketContext(config, symbolSetUsed);
  const barsBySymbol = await loadBarsBySymbol(
    marketContext,
    symbolSetUsed,
    lookbackBars,
  );

  const simulationInput: RuntimeFaithfulSimulationInput = {
    registry,
    releaseGateStatus,
    barsBySymbol,
    runtimeFlags: {
      runtimeHealthy: args.runtimeHealthy ?? true,
      dataFresh: args.dataFresh ?? true,
      connectorHealthy: args.connectorHealthy ?? true,
      riskLimitsLoaded: args.riskLimitsLoaded ?? true,
      paperExecutorEnabled: args.paperExecutorEnabled ?? true,
    },
    expectations: buildRuntimeExpectations(registry),
  };

  const artifact = runRuntimeFaithfulSimulation(simulationInput);
  const summary = buildGateSummary(artifact);
  const releaseGateBlock = isPaperReleaseGateStatusBlocking(
    releaseGateStatus,
    deps.now(),
  );

  const statusArtifact: PaperRuntimeDiagnosticStatusArtifact = {
    generatedAt: deps.now().toISOString(),
    mode: "diagnostic",
    symbolSetUsed,
    lookbackBars,
    preflight: {
      releaseGateState: !releaseGateStatus
        ? "missing"
        : releaseGateBlock.blocking
          ? "blocked"
          : "pass",
      releaseGateReason: releaseGateBlock.reason,
      championRegistryState: !registry
        ? "missing"
        : artifact.championValidation.blockingReasons.length > 0
          ? "blocked"
          : "pass",
      championRegistryReasons: [...artifact.championValidation.blockingReasons],
    },
    summary,
  };

  return {
    artifact,
    summary,
    statusArtifact,
  };
}

export function resolveDiagnosticSymbols(
  registry: PaperChampionRegistry | null,
  config: LoadedConfig,
): string[] {
  if (registry?.symbols.length) {
    return [...registry.symbols];
  }
  if (config.crypto.allowedSymbols.length > 0) {
    return [...config.crypto.allowedSymbols];
  }
  return [...config.engine.pairs];
}

export function resolveDiagnosticLookbackBars(
  registry: PaperChampionRegistry | null,
  override?: number,
): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  const strategyName = toRuntimeStrategyName(registry?.strategy_family);
  if (!registry || !strategyName) {
    return DEFAULT_LOOKBACK_BARS;
  }

  return Math.max(
    DEFAULT_LOOKBACK_BARS,
    getStrategyMinimumBars(strategyName, registry.strategy_params) + 48,
  );
}

async function loadBarsBySymbol(
  marketContext: LiveMarketContext,
  symbols: string[],
  lookbackBars: number,
): Promise<Record<string, LiveMarketDataBar[]>> {
  const end = marketContext.getPlayheadTime();
  const start = marketContext.calculatePreviousTime(lookbackBars);
  const entries = await Promise.all(
    symbols.map(async (symbol) => [
      symbol,
      await marketContext.marketDataProvider.getMarketDataRange(start, end, symbol),
    ] as const),
  );
  return Object.fromEntries(entries);
}

function buildRuntimeExpectations(registry: PaperChampionRegistry | null) {
  if (!registry) {
    return undefined;
  }
  return {
    symbols: registry.symbols,
    resolvedMarketIdentity: Object.fromEntries(
      registry.symbols.map((symbol) => [
        symbol,
        registry.resolved_market_identity[symbol],
      ]),
    ),
    vetoPolicyVersion: registry.veto_policy_version,
    runtimeSchemaVersion: registry.runtime_schema_version,
    signalCodeCommitHash: registry.signal_code_commit_hash,
  };
}

function toRuntimeStrategyName(strategyFamily: string | undefined) {
  if (strategyFamily === "vol_gated_breakout") {
    return "volBreakout" as const;
  }
  if (strategyFamily === "vol_gated_trend") {
    return "volTrend" as const;
  }
  return null;
}

function createDefaultDeps(): PaperRuntimeDiagnosticDeps {
  return {
    loadConfig,
    loadPaperChampionRegistry,
    loadReleaseGateStatus,
    createMarketContext: (config, symbols) =>
      createOpenBBCryptoLiveMarketContext({
        client: new OpenBBCryptoClient(
          config.openbb.apiUrl,
          config.openbb.providers.crypto,
          config.openbb.providerKeys,
        ),
        symbols,
        interval: config.engine.timeframe,
      }),
    now: () => new Date(),
  };
}
