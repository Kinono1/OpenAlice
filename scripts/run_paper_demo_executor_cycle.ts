import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig } from "../src/core/config.js";
import { createEventLog, type EventLog } from "../src/core/event-log.js";
import { OpenBBCryptoClient } from "../src/openbb/crypto/index.js";
import {
  Wallet,
  createCryptoOperationDispatcher,
  createCryptoTradingEngine,
  createCryptoWalletStateBridge,
  createGuardBatchPipeline,
  createGuardPipeline,
  resolveGuards,
  type WalletExportState,
} from "../src/extension/crypto-trading/index.js";
import { DecisionTicketStore } from "../src/extension/crypto-trading/decision-ticket.js";
import { IntentLedger } from "../src/extension/crypto-trading/intent-ledger.js";
import { TradeIdempotencyStore } from "../src/extension/crypto-trading/idempotency-store.js";
import { KillSwitch } from "../src/extension/crypto-trading/kill-switch.js";
import { buildGateSummary, formatGateSummary } from "../src/runtime/gate_summary.js";
import { LiveGateManager } from "../src/runtime/live_gate_manager.js";
import { createOpenBBCryptoLiveMarketContext } from "../src/runtime/openbb_live_market_context.js";
import { loadReleaseGateStatus } from "../src/runtime/release_gate_status.js";
import { writePaperGateStatus } from "../src/runtime/paper_gate_status.js";
import { loadPaperChampionRegistry } from "../src/runtime/paper_champion_registry.js";
import { getStrategyMinimumBars } from "../src/extension/strategy-tools/strategies.js";
import {
  runRuntimeFaithfulSimulation,
} from "../src/runtime/runtime_faithful_simulation.js";
import {
  executePaperExecutorCycle,
} from "../src/runtime/paper_demo_executor.js";
import {
  loadPaperExecutorJournal,
  writePaperExecutorJournal,
} from "../src/runtime/paper_executor_journal.js";

interface CliArgs {
  registryPath: string;
  releaseGateStatusPath: string;
  paperGateStatusPath: string;
  simulationOutput: string;
  journalPath: string;
  walletPath: string;
  statusOutput: string;
  runtimeHealthy: boolean;
  dataFresh: boolean;
  connectorHealthy: boolean;
  riskLimitsLoaded: boolean;
  paperExecutorEnabled: boolean;
  lookbackBars?: number;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const registry = await loadPaperChampionRegistry(resolve(args.registryPath));
  const releaseGateStatus = await loadReleaseGateStatus(
    resolve(args.releaseGateStatusPath),
  );
  const engineResult = await createCryptoTradingEngine(config);
  if (!engineResult) {
    throw new Error("Crypto trading engine unavailable.");
  }
  const eventLog = await createEventLog();

  try {
    const engine = engineResult.engine;
    const ticketStore = createDecisionTicketStore(config);
    const wallet = await loadOrCreateWallet(
      config,
      engine,
      args.walletPath,
      ticketStore,
      eventLog,
    );
    const symbols = resolveExecutorSymbols(config, registry);
    const marketContext = createOpenBBCryptoLiveMarketContext({
      client: new OpenBBCryptoClient(
        config.openbb.apiUrl,
        config.openbb.providers.crypto,
        config.openbb.providerKeys,
      ),
      symbols,
      interval: config.engine.timeframe,
    });

    const liveGateManager = await LiveGateManager.create({
      engine,
      marketContext,
      riskConfig: config.risk,
      eventLog,
      baseDir: "data",
      config: {
        requireReleaseGatePass: config.governance.releaseGate.enabled,
        gateMode:
          config.crypto.provider.type === "ccxt" && config.crypto.provider.demoTrading
            ? "paper"
            : "live",
        releaseGateStatusPath: config.governance.releaseGate.statusPath,
      },
    });

    const lookbackBars = resolveExecutorLookbackBars(registry, args.lookbackBars);

    const barsBySymbol = await loadBarsBySymbol(
      marketContext,
      symbols,
      lookbackBars,
    );

    const artifact = runRuntimeFaithfulSimulation({
      registry,
      releaseGateStatus,
      barsBySymbol,
      runtimeFlags: {
        runtimeHealthy: args.runtimeHealthy,
        dataFresh: args.dataFresh,
        connectorHealthy: args.connectorHealthy,
        riskLimitsLoaded: args.riskLimitsLoaded,
        paperExecutorEnabled: args.paperExecutorEnabled,
      },
      expectations: {
        symbols: registry?.symbols,
        resolvedMarketIdentity: registry
          ? Object.fromEntries(
              registry.symbols.map((symbol) => [
                symbol,
                registry.resolved_market_identity[symbol],
              ]),
            )
          : undefined,
        vetoPolicyVersion: registry?.veto_policy_version,
        runtimeSchemaVersion: registry?.runtime_schema_version,
        signalCodeCommitHash: registry?.signal_code_commit_hash,
      },
    });

    await writeJson(args.simulationOutput, artifact);
    await writePaperGateStatus(artifact.paperGate, {
      filePath: resolve(args.paperGateStatusPath),
    });

    const journal = await loadPaperExecutorJournal(resolve(args.journalPath));
    const equity = (await engine.getAccount()).equity;
    const result = await executePaperExecutorCycle({
      artifact,
      journal,
      wallet,
      ticketStore,
      accountEquity: equity,
      idempotencyStore,
    });

    await syncPendingOrders(wallet, engine);
    await writePaperExecutorJournal(result.journal, resolve(args.journalPath));
    const summary = buildGateSummary(artifact, result);
    await writeJson(args.statusOutput, {
      generatedAt: new Date().toISOString(),
      mode: "executor",
      simulationOutput: resolve(args.simulationOutput),
      paperGateStatusPath: resolve(args.paperGateStatusPath),
      journalPath: resolve(args.journalPath),
      blockingReasons: result.blockingReasons,
      summary,
    });

    console.log(formatGateSummary(summary));
    console.log(
      JSON.stringify(
        {
          simulationOutput: resolve(args.simulationOutput),
          paperGateStatusPath: resolve(args.paperGateStatusPath),
          journalPath: resolve(args.journalPath),
          statusOutput: resolve(args.statusOutput),
          executedCommits: result.executedCommits.length,
          skippedCommitIds: result.skippedCommitIds,
          blockingReasons: result.blockingReasons,
        },
        null,
        2,
      ),
    );
  } finally {
    await eventLog.close();
    await engineResult.close();
  }
}

async function loadBarsBySymbol(
  marketContext: ReturnType<typeof createOpenBBCryptoLiveMarketContext>,
  symbols: string[],
  lookbackBars: number,
) {
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

function strategyFamilyToRuntime(strategyFamily: string | undefined) {
  if (strategyFamily === "vol_gated_breakout") return "volBreakout" as const;
  if (strategyFamily === "vol_gated_trend") return "volTrend" as const;
  return null;
}

function resolveExecutorSymbols(
  config: Awaited<ReturnType<typeof loadConfig>>,
  registry: Awaited<ReturnType<typeof loadPaperChampionRegistry>>,
) {
  if (registry?.symbols.length) {
    return registry.symbols;
  }
  if (config.crypto.allowedSymbols.length > 0) {
    return config.crypto.allowedSymbols;
  }
  return config.engine.pairs;
}

function resolveExecutorLookbackBars(
  registry: Awaited<ReturnType<typeof loadPaperChampionRegistry>>,
  override?: number,
) {
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }
  const runtimeStrategy = strategyFamilyToRuntime(registry?.strategy_family);
  if (!registry || !runtimeStrategy) {
    return 200;
  }
  return Math.max(
    200,
    getStrategyMinimumBars(runtimeStrategy, registry.strategy_params) + 48,
  );
}

function createDecisionTicketStore(config: Awaited<ReturnType<typeof loadConfig>>) {
  return new DecisionTicketStore({
    required: config.decisionTicket.required,
    ttlMs: config.decisionTicket.ttlMs,
  });
}

async function loadOrCreateWallet(
  config: Awaited<ReturnType<typeof loadConfig>>,
  engine: NonNullable<Awaited<ReturnType<typeof createCryptoTradingEngine>>>["engine"],
  walletPath: string,
  ticketStore: DecisionTicketStore,
  eventLog: EventLog,
) {
  const resolvedWalletPath = resolve(walletPath);
  const onCommit = async (state: WalletExportState) => {
    await mkdir(dirname(resolvedWalletPath), { recursive: true });
    await writeFile(resolvedWalletPath, JSON.stringify(state, null, 2));
  };

  const intentLedger = new IntentLedger(resolve("data/crypto-trading/intents.jsonl"));
  await intentLedger.init();
  const idempotencyStore = new TradeIdempotencyStore(
    resolve("data/runtime/trade_idempotency.json"),
  );
  const killSwitch = new KillSwitch({
    defaultPolicy: config.killSwitch.defaultPolicy,
  });
  const liveGateManager = await LiveGateManager.create({
    engine,
    marketContext: createOpenBBCryptoLiveMarketContext({
      client: new OpenBBCryptoClient(
        config.openbb.apiUrl,
        config.openbb.providers.crypto,
        config.openbb.providerKeys,
      ),
      symbols:
        config.crypto.allowedSymbols.length > 0
          ? config.crypto.allowedSymbols
          : config.engine.pairs,
      interval: config.engine.timeframe,
    }),
    riskConfig: config.risk,
    eventLog,
    baseDir: "data",
    config: {
      requireReleaseGatePass: config.governance.releaseGate.enabled,
      gateMode:
        config.crypto.provider.type === "ccxt" && config.crypto.provider.demoTrading
          ? "paper"
          : "live",
      releaseGateStatusPath: config.governance.releaseGate.statusPath,
    },
  });
  const dispatcher = createCryptoOperationDispatcher(engine, {
    riskConfig: config.risk,
    ticketStore,
    intentLedger,
    idempotencyStore,
    killSwitch,
    eventLog,
    exchangeId:
      config.crypto.provider.type === "ccxt"
        ? config.crypto.provider.exchange
        : undefined,
    slippageConfig: config.slippage,
    getRiskContext: async () => liveGateManager.buildRiskContext(),
    estimateExpectedPrice: async ({ request }) =>
      liveGateManager.estimateExpectedPrice(request),
    beforePlaceOrderGate: async ({ request }) =>
      liveGateManager.beforePlaceOrder(request),
  });
  const guards = resolveGuards(config.crypto.guards);
  const bridge = createCryptoWalletStateBridge(engine);
  const walletConfig = {
    executeOperation: createGuardPipeline(dispatcher, engine, guards),
    executeBatch: createGuardBatchPipeline(dispatcher, engine, guards),
    getWalletState: bridge,
    onCommit,
  };

  try {
    const raw = await readFile(resolvedWalletPath, "utf-8");
    return Wallet.restore(JSON.parse(raw) as WalletExportState, walletConfig);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return new Wallet(walletConfig);
  }
}

async function syncPendingOrders(
  wallet: Wallet,
  engine: NonNullable<Awaited<ReturnType<typeof createCryptoTradingEngine>>>["engine"],
) {
  const pendingOrders = wallet.getPendingOrderIds();
  if (pendingOrders.length === 0) return;

  const exchangeOrders = await engine.getOrders();
  const updates = [];
  for (const { orderId, symbol } of pendingOrders) {
    const exchangeOrder = exchangeOrders.find((order) => order.id === orderId);
    if (!exchangeOrder) continue;
    if (exchangeOrder.status === "pending") continue;
    updates.push({
      orderId,
      symbol,
      previousStatus: "pending" as const,
      currentStatus: exchangeOrder.status,
      filledPrice: exchangeOrder.filledPrice,
      filledSize: exchangeOrder.filledSize,
      previousFilledSize: 0,
      currentFilledSize: exchangeOrder.filledSize,
      remainingSize: exchangeOrder.remainingSize,
      exchangeUpdateTs: exchangeOrder.exchangeUpdateTs,
    });
  }
  if (updates.length === 0) return;
  const currentState = await createCryptoWalletStateBridge(engine)();
  await wallet.sync(updates, currentState);
}

async function writeJson(path: string, payload: unknown) {
  const resolvedPath = resolve(path);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv);
  return {
    registryPath:
      raw.get("registryPath") ?? "data/runtime/paper_champion_registry.json",
    releaseGateStatusPath:
      raw.get("releaseGateStatusPath") ?? "data/runtime/release_gate_status.json",
    paperGateStatusPath:
      raw.get("paperGateStatusPath") ?? "data/runtime/paper_gate_status.json",
    simulationOutput:
      raw.get("simulationOutput") ?? "data/runtime/runtime_faithful_simulation.latest.json",
    journalPath:
      raw.get("journalPath") ?? "data/runtime/paper_executor_journal.json",
    walletPath:
      raw.get("walletPath") ?? "data/crypto-trading/commit.json",
    statusOutput:
      raw.get("statusOutput") ?? "data/runtime/paper_executor_status.latest.json",
    runtimeHealthy: parseBoolArg(raw.get("runtimeHealthy"), true),
    dataFresh: parseBoolArg(raw.get("dataFresh"), true),
    connectorHealthy: parseBoolArg(raw.get("connectorHealthy"), true),
    riskLimitsLoaded: parseBoolArg(raw.get("riskLimitsLoaded"), true),
    paperExecutorEnabled: parseBoolArg(raw.get("paperExecutorEnabled"), true),
    lookbackBars: raw.get("lookbackBars") ? Number(raw.get("lookbackBars")) : undefined,
  };
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${raw}`);
}

main().catch((err) => {
  console.error("run_paper_demo_executor_cycle failed:", err);
  process.exit(1);
});
