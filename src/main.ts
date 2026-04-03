import { readFile, writeFile, appendFile, mkdir } from 'fs/promises'
import { resolve, dirname } from 'path'
import { Engine } from './core/engine.js'
import { loadConfig } from './core/config.js'
import type { Plugin, EngineContext, ReconnectResult } from './core/types.js'
import { McpPlugin } from './plugins/mcp.js'
import { TelegramPlugin } from './connectors/telegram/index.js'
import { WebPlugin } from './connectors/web/index.js'
import { McpAskPlugin } from './connectors/mcp-ask/index.js'
import { createThinkingTools } from './extension/thinking-kit/index.js'
import type { WalletExportState } from './extension/crypto-trading/index.js'
import {
  Wallet,
  createCryptoTradingEngine,
  createCryptoTradingTools,
  createCryptoOperationDispatcher,
  createCryptoWalletStateBridge,
  createGuardPipeline,
  resolveGuards,
} from './extension/crypto-trading/index.js'
import type { SecOperation, SecWalletExportState } from './extension/securities-trading/index.js'
import {
  SecWallet,
  createSecuritiesTradingEngine,
  createSecuritiesTradingTools,
  createSecOperationDispatcher,
  createSecWalletStateBridge,
  createSecGuardPipeline,
  resolveSecGuards,
} from './extension/securities-trading/index.js'
import { Brain, createBrainTools } from './extension/brain/index.js'
import type { BrainExportState } from './extension/brain/index.js'
import { createBrowserTools } from './extension/browser/index.js'
import { OpenBBEquityClient, SymbolIndex } from './openbb/equity/index.js'
import { createEquityTools } from './extension/equity/index.js'
import { OpenBBCryptoClient } from './openbb/crypto/index.js'
import { OpenBBCurrencyClient } from './openbb/currency/index.js'
import { OpenBBEconomyClient } from './openbb/economy/index.js'
import { OpenBBCommodityClient } from './openbb/commodity/index.js'
import { OpenBBNewsClient } from './openbb/news/index.js'
import { createCryptoTools } from './extension/crypto/index.js'
import { createCurrencyTools } from './extension/currency/index.js'
import { createNewsTools } from './extension/news/index.js'
import { createAnalysisTools } from './extension/analysis-kit/index.js'
import type { KlineStore } from './extension/analysis-kit/kline/KlineStore.js'
import type { MarketData } from './extension/analysis-kit/data/interfaces.js'
import { DecisionTicketStore } from './extension/crypto-trading/decision-ticket.js'
import { IntentLedger } from './extension/crypto-trading/intent-ledger.js'
import { TradeIdempotencyStore } from './extension/crypto-trading/idempotency-store.js'
import { KillSwitch } from './extension/crypto-trading/kill-switch.js'
import { PnLTracker } from './extension/crypto-trading/pnl-tracker.js'
import { SessionStore } from './core/session.js'
import { ConnectorCenter } from './core/connector-center.js'
import { ToolCenter } from './core/tool-center.js'
import { AgentCenter } from './core/agent-center.js'
import { ProviderRouter } from './core/ai-provider.js'
import { VercelAIProvider } from './ai-providers/vercel-ai-sdk/vercel-provider.js'
import { ClaudeCodeProvider } from './ai-providers/claude-code/claude-code-provider.js'
import { createEventLog } from './core/event-log.js'
import { createCronEngine, createCronListener, createCronTools } from './task/cron/index.js'
import { createHeartbeat } from './task/heartbeat/index.js'
import { NewsCollectorStore, NewsCollector, wrapNewsToolsForPiggyback, createNewsArchiveTools } from './extension/news-collector/index.js'
import { LiveGateManager } from './runtime/live_gate_manager.js'
import { loadRuntimeProofTracking } from './runtime/live_proof_status.js'
import { writePaperPortfolioTarget } from './runtime/paper_portfolio_target_builder.js'
import { refreshRuntimeTruthMainline } from './runtime/runtime_truth_mainline.js'
import type { CryptoHistoricalData } from './openbb/crypto/types/index.js'
import type { ICryptoTradingEngine } from './extension/crypto-trading/interfaces.js'

const WALLET_FILE = resolve("data/crypto-trading/commit.json");
const SEC_WALLET_FILE = resolve("data/securities-trading/commit.json");
const BRAIN_FILE = resolve("data/brain/commit.json");
const FRONTAL_LOBE_FILE = resolve("data/brain/frontal-lobe.md");
const EMOTION_LOG_FILE = resolve("data/brain/emotion-log.md");
const PERSONA_FILE = resolve("data/brain/persona.md");
const PERSONA_DEFAULT = resolve("data/default/persona.default.md");
const DEFAULT_RUNTIME_VALIDATION_RUNS = resolve(
  "data/research/strategy/strategy_validation_runs.json"
);
const DEFAULT_RUNTIME_VERDICT = resolve(
  "data/research/strategy/experiment_verdict.v2.json"
);
const DEFAULT_RUNTIME_RELEASE_GATE = resolve("data/runtime/release_gate_status.json");
const DEFAULT_RUNTIME_REGISTRY = resolve("data/runtime/paper_champion_registry.json");
const DEFAULT_RUNTIME_PORTFOLIO_TARGET = resolve(
  "data/runtime/paper_portfolio_target.json"
);
const DEFAULT_RUNTIME_SNAPSHOT_DIR = resolve("data/runtime");
const DEFAULT_RUNTIME_CANDIDATES = resolve("docs/research/strategy_candidates.v1.json");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const DEFAULT_KLINE_INTERVAL = '1h'

/** Read a file, copying from default if it doesn't exist yet. */
async function readWithDefault(
  target: string,
  defaultFile: string
): Promise<string> {
  try {
    return await readFile(target, "utf-8");
  } catch {
    /* not found — copy default */
  }
  try {
    const content = await readFile(defaultFile, "utf-8");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    return content;
  } catch {
    return "";
  }
}

function normalizeOpenbbCryptoSymbol(symbol: string): string {
  return symbol.replace(/\//g, '').replace(/-/g, '')
}

function buildKlineStore(
  cryptoClient: OpenBBCryptoClient,
  symbols: string[],
  interval = DEFAULT_KLINE_INTERVAL
): KlineStore {
  return {
    marketDataProvider: {
      async getMarketData(time: Date, symbol: string): Promise<MarketData> {
        const rows = await this.getMarketDataRange(time, time, symbol)
        const latest = rows[rows.length - 1]
        if (!latest) {
          throw new Error(`No market data available for ${symbol}`)
        }
        return latest
      },
      async getMarketDataRange(startTime: Date, endTime: Date, symbol: string): Promise<MarketData[]> {
        const rows = await cryptoClient.getHistorical({
          symbol: normalizeOpenbbCryptoSymbol(symbol),
          start_date: startTime.toISOString().slice(0, 10),
          end_date: endTime.toISOString().slice(0, 10),
          interval,
        }) as CryptoHistoricalData[]

        return rows
          .map((row) => ({
            symbol,
            time: Math.floor(Date.parse(row.date) / 1000),
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume ?? 0,
          }))
          .filter((row) =>
            Number.isFinite(row.time) &&
            Number.isFinite(row.open) &&
            Number.isFinite(row.high) &&
            Number.isFinite(row.low) &&
            Number.isFinite(row.close)
          )
      },
      getAvailableSymbols(): string[] {
        return [...symbols]
      },
    },
    getPlayheadTime(): Date {
      return new Date()
    },
    calculatePreviousTime(lookbackBars: number): Date {
      const now = new Date()
      now.setHours(now.getHours() - lookbackBars)
      return now
    },
    getAvailableSymbols(): string[] {
      return [...symbols]
    },
  }
}

async function createCryptoDispatcherRuntime(params: {
  engine: ICryptoTradingEngine
  config: Awaited<ReturnType<typeof loadConfig>>
  eventLog: Awaited<ReturnType<typeof createEventLog>>
  klineStore: KlineStore
  ticketStore: DecisionTicketStore
  intentLedger: IntentLedger
  idempotencyStore: TradeIdempotencyStore
  killSwitch: KillSwitch
  exchangeId?: string
}) {
  const liveGateManager = await LiveGateManager.create({
    engine: params.engine,
    klineStore: params.klineStore,
    riskConfig: params.config.risk,
    eventLog: params.eventLog,
    baseDir: "data",
  })

  const rawDispatcher = createCryptoOperationDispatcher(params.engine, {
    riskConfig: params.config.risk,
    getRiskContext: () => liveGateManager.buildRiskContext(),
    estimateExpectedPrice: ({ request }) =>
      liveGateManager.estimateExpectedPrice(request),
    beforePlaceOrderGate: ({ request }) =>
      liveGateManager.beforePlaceOrder(request),
    afterPlaceOrder: ({ request, result, expectedPrice }) =>
      liveGateManager.recordExecution(request, result, expectedPrice),
    ticketStore: params.ticketStore,
    intentLedger: params.intentLedger,
    idempotencyStore: params.idempotencyStore,
    killSwitch: params.killSwitch,
    exchangeId: params.exchangeId,
    slippageConfig: params.config.slippage,
    eventLog: params.eventLog,
  })

  return { liveGateManager, rawDispatcher }
}

async function refreshCryptoRuntimeTruth(params: {
  engine: ICryptoTradingEngine
  liveGateManager: LiveGateManager
  klineStore: KlineStore
  newsStore: NewsCollectorStore
  symbols: string[]
}) {
  try {
    const planningState = await params.liveGateManager.buildRuntimePlanningState()
    const proofTracking = await loadRuntimeProofTracking()
    await writePaperPortfolioTarget({
      engine: params.engine,
      klineStore: params.klineStore,
      newsProvider: params.newsStore,
      options: {
        symbols: params.symbols,
        releaseGateStatus: planningState.releaseGateStatus,
        outputPath: DEFAULT_RUNTIME_PORTFOLIO_TARGET,
        candidateConfigPath: DEFAULT_RUNTIME_CANDIDATES,
      },
    })

    const result = await refreshRuntimeTruthMainline(
      params.engine,
      params.liveGateManager,
      {
        symbols: params.symbols,
        validationRunsPath: DEFAULT_RUNTIME_VALIDATION_RUNS,
        verdictPath: DEFAULT_RUNTIME_VERDICT,
        releaseGateStatusPath: DEFAULT_RUNTIME_RELEASE_GATE,
        registryPath: DEFAULT_RUNTIME_REGISTRY,
        portfolioTargetPath: DEFAULT_RUNTIME_PORTFOLIO_TARGET,
        snapshotBaseDir: DEFAULT_RUNTIME_SNAPSHOT_DIR,
        proofTracking,
      },
    )

    console.log(
      `runtime-truth: refreshed (${result.truth.executionPlan.kind}, portfolioTarget=${result.portfolioTargetSource}, phases=${JSON.stringify(result.phaseReadiness)})`,
    )
  } catch (err) {
    console.error('runtime-truth: refresh failed:', err)
  }
}

async function main() {
  const config = await loadConfig()

  // ==================== Infrastructure ====================

  // Start CCXT init in background — do NOT await here, letting everything else proceed immediately
  const cryptoInitPromise = createCryptoTradingEngine(config).catch((err) => {
    console.warn('crypto trading engine init failed (non-fatal, continuing without it):', err)
    return null
  })

  // Run Securities init + all local file reads in parallel
  const [
    secResultOrNull,
    savedState,
    secSavedState,
    brainExport,
    persona,
  ] = await Promise.all([
    createSecuritiesTradingEngine(config).catch((err) => {
      console.warn('securities trading engine init failed (non-fatal, continuing without it):', err)
      return null
    }),
    readFile(WALLET_FILE, 'utf-8').then((r) => JSON.parse(r) as WalletExportState).catch(() => undefined),
    readFile(SEC_WALLET_FILE, 'utf-8').then((r) => JSON.parse(r) as SecWalletExportState).catch(() => undefined),
    readFile(BRAIN_FILE, 'utf-8').then((r) => JSON.parse(r) as BrainExportState).catch(() => undefined),
    readWithDefault(PERSONA_FILE, PERSONA_DEFAULT),
  ])

  let secResultRef = secResultOrNull

  // ==================== Commit callbacks ====================

  const onCryptoCommit = async (state: WalletExportState) => {
    await mkdir(resolve("data/crypto-trading"), { recursive: true });
    await writeFile(WALLET_FILE, JSON.stringify(state, null, 2));
  };

  // Safety infrastructure (must be created before dispatcher)
  const ticketStore = new DecisionTicketStore({
    required: config.decisionTicket.required,
    ttlMs: config.decisionTicket.ttlMs,
  });
  const ticketCleanupInterval = setInterval(() => {
    try {
      ticketStore.cleanup();
    } catch (err) {
      console.warn(
        "decision-ticket cleanup failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }, Math.max(60_000, Math.min(config.decisionTicket.ttlMs, 300_000)));

  const intentLedger = new IntentLedger(
    resolve("data/crypto-trading/intents.jsonl")
  );
  await intentLedger.init();
  const idempotencyStore = new TradeIdempotencyStore(
    resolve("data/runtime/trade_idempotency.json")
  );

  const killSwitch = new KillSwitch({
    defaultPolicy: config.killSwitch.defaultPolicy,
  });

  const pnlTracker = new PnLTracker({
    reconciliationThresholdPct: config.reconciliation.thresholdPct,
  });

  // Derive exchange ID from crypto config
  const exchangeId =
    config.crypto.provider.type === "ccxt"
      ? config.crypto.provider.exchange
      : undefined;

  const onSecCommit = async (state: SecWalletExportState) => {
    await mkdir(resolve("data/securities-trading"), { recursive: true });
    await writeFile(SEC_WALLET_FILE, JSON.stringify(state, null, 2));
  };

  // ==================== Securities Trading ====================

  const secWalletStateBridge = secResultRef
    ? createSecWalletStateBridge(secResultRef.engine)
    : undefined

  const secGuards = resolveSecGuards(config.securities.guards)

  const secWalletConfig = secResultRef
    ? {
        executeOperation: createSecGuardPipeline(
          createSecOperationDispatcher(secResultRef.engine),
          secResultRef.engine,
          secGuards,
        ),
        getWalletState: secWalletStateBridge!,
        onCommit: onSecCommit,
      }
    : {
        executeOperation: async (_op: SecOperation) => {
          throw new Error("Securities trading service not connected");
        },
        getWalletState: async () => {
          throw new Error("Securities trading service not connected");
        },
        onCommit: onSecCommit,
      };

  const secWallet = secSavedState
    ? SecWallet.restore(secSavedState, secWalletConfig)
    : new SecWallet(secWalletConfig);

  // Mutable wallet references — updated on reconnect so REST getters always return current instance
  let currentCryptoWallet: InstanceType<typeof Wallet> | null = null
  let currentSecWallet: InstanceType<typeof SecWallet> = secWallet

  // Kept for shutdown cleanup reference (populated when CCXT resolves)
  let cryptoResultRef: Awaited<ReturnType<typeof createCryptoTradingEngine>> = null

  // ==================== Brain ====================

  const brainDir = resolve('data/brain')
  const brainOnCommit = async (state: BrainExportState) => {
    await mkdir(brainDir, { recursive: true });
    await writeFile(BRAIN_FILE, JSON.stringify(state, null, 2));
    await writeFile(FRONTAL_LOBE_FILE, state.state.frontalLobe);
    const latest = state.commits[state.commits.length - 1];
    if (latest?.type === "emotion") {
      const prev =
        state.commits.length > 1
          ? (state.commits[state.commits.length - 2]?.stateAfter.emotion ??
            "unknown")
          : "unknown";
      await appendFile(
        EMOTION_LOG_FILE,
        `## ${latest.timestamp}\n**${prev} → ${latest.stateAfter.emotion}**\n${latest.message}\n\n`
      );
    }
  };

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit: brainOnCommit })
    : new Brain({ onCommit: brainOnCommit });

  const frontalLobe = brain.getFrontalLobe()
  const emotion = brain.getEmotion().current
  const instructions = [
    persona,
    "---",
    "## Current Brain State",
    "",
    `**Frontal Lobe:** ${frontalLobe || "(empty)"}`,
    "",
    `**Emotion:** ${emotion}`,
  ].join("\n");

  // ==================== Event Log ====================

  const eventLog = await createEventLog();

  // ==================== Cron ====================

  const cronEngine = createCronEngine({ eventLog });

  // ==================== News Collector Store ====================

  const newsStore = new NewsCollectorStore({
    maxInMemory: config.newsCollector.maxInMemory,
    retentionDays: config.newsCollector.retentionDays,
  })
  await newsStore.init()

  // ==================== OpenBB Clients ====================

  const providerKeys = config.openbb.providerKeys
  const { providers } = config.openbb
  const equityClient = new OpenBBEquityClient(config.openbb.apiUrl, providers.equity, providerKeys)
  const cryptoClient = new OpenBBCryptoClient(config.openbb.apiUrl, providers.crypto, providerKeys)
  const currencyClient = new OpenBBCurrencyClient(config.openbb.apiUrl, providers.currency, providerKeys)
  const commodityClient = new OpenBBCommodityClient(config.openbb.apiUrl, undefined, providerKeys)
  const economyClient = new OpenBBEconomyClient(config.openbb.apiUrl, undefined, providerKeys)
  const newsClient = new OpenBBNewsClient(config.openbb.apiUrl, undefined, providerKeys)
  const klineStore = buildKlineStore(cryptoClient, config.engine.pairs)

  // ==================== Equity Symbol Index ====================

  const symbolIndex = new SymbolIndex()
  await symbolIndex.load(equityClient)

  // ==================== Tool Center ====================

  const toolCenter = new ToolCenter()
  toolCenter.register(createThinkingTools(), 'thinking')
  // Crypto trading tools are injected later in the background when CCXT resolves
  if (secResultRef) {
    toolCenter.register(createSecuritiesTradingTools(secResultRef.engine, secWallet, secWalletStateBridge), 'securities-trading')
  }
  toolCenter.register(createBrainTools(brain), 'brain')
  toolCenter.register(createBrowserTools(), 'browser')
  toolCenter.register(createCronTools(cronEngine), 'cron')
  toolCenter.register(createEquityTools(symbolIndex, equityClient), 'equity')
  toolCenter.register(createCryptoTools(cryptoClient), 'crypto-data')
  toolCenter.register(createCurrencyTools(currencyClient), 'currency-data')
  let newsTools = createNewsTools(newsClient, {
    companyProvider: providers.newsCompany,
    worldProvider: providers.newsWorld,
  })
  if (config.newsCollector.piggybackOpenBB) {
    newsTools = wrapNewsToolsForPiggyback(newsTools, newsStore)
  }
  toolCenter.register(newsTools, 'news')
  if (config.newsCollector.enabled) {
    toolCenter.register(createNewsArchiveTools(newsStore), 'news-archive')
  }
  toolCenter.register(createAnalysisTools(equityClient, cryptoClient, currencyClient), 'analysis')

  console.log(`tool-center: ${toolCenter.list().length} tools registered (crypto trading pending ccxt)`)

  // ==================== AI Provider Chain ====================

  const vercelProvider = new VercelAIProvider(
    () => toolCenter.getVercelTools(),
    instructions,
    config.agent.maxSteps,
    config.compaction,
  )
  const claudeCodeProvider = new ClaudeCodeProvider(config.compaction, instructions)
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider)

  const agentCenter = new AgentCenter(router);
  const engine = new Engine({ agentCenter });

  // ==================== Connector Center ====================

  const connectorCenter = new ConnectorCenter(eventLog)

  // ==================== Cron Lifecycle ====================

  await cronEngine.start()
  const cronSession = new SessionStore('cron/default')
  await cronSession.restore()
  const cronListener = createCronListener({ connectorCenter, eventLog, engine, session: cronSession })
  cronListener.start()
  console.log('cron: engine + listener started')

  // ==================== Heartbeat ====================

  const heartbeat = createHeartbeat({
    config: config.heartbeat,
    connectorCenter, cronEngine, eventLog, engine,
  })
  await heartbeat.start()
  if (config.heartbeat.enabled) {
    console.log(`heartbeat: enabled (every ${config.heartbeat.every})`);
  }

  // ==================== News Collector ====================

  let newsCollector: NewsCollector | null = null
  if (config.newsCollector.enabled && config.newsCollector.feeds.length > 0) {
    newsCollector = new NewsCollector({
      store: newsStore,
      feeds: config.newsCollector.feeds,
      intervalMs: config.newsCollector.intervalMinutes * 60 * 1000,
    })
    newsCollector.start()
    console.log(`news-collector: started (${config.newsCollector.feeds.length} feeds, every ${config.newsCollector.intervalMinutes}m)`)
  }

  // ==================== Engine Reconnect ====================

  let cryptoReconnecting = false
  const reconnectCrypto = async (): Promise<ReconnectResult> => {
    if (cryptoReconnecting) return { success: false, error: 'Reconnect already in progress' }
    cryptoReconnecting = true
    try {
      const freshConfig = await loadConfig()

      // Create new engine FIRST — if this fails, old engine stays functional
      const newResult = await createCryptoTradingEngine(freshConfig)
      await cryptoResultRef?.close()
      cryptoResultRef = newResult

      if (!newResult) {
        return { success: true, message: 'Crypto trading disabled (provider: none)' }
      }

      const bridge = createCryptoWalletStateBridge(newResult.engine)
      const { liveGateManager, rawDispatcher } = await createCryptoDispatcherRuntime({
        engine: newResult.engine,
        config: freshConfig,
        eventLog,
        klineStore,
        ticketStore,
        intentLedger,
        idempotencyStore,
        killSwitch,
        exchangeId:
          freshConfig.crypto.provider.type === "ccxt"
            ? freshConfig.crypto.provider.exchange
            : undefined,
      })
      const guards = resolveGuards(freshConfig.crypto.guards)
      const walletConfig = {
        executeOperation: createGuardPipeline(rawDispatcher, newResult.engine, guards),
        getWalletState: bridge,
        onCommit: onCryptoCommit,
      }
      const savedWallet = await readFile(WALLET_FILE, 'utf-8')
        .then((r) => JSON.parse(r) as WalletExportState).catch(() => undefined)
      const newWallet = savedWallet ? Wallet.restore(savedWallet, walletConfig) : new Wallet(walletConfig)
      currentCryptoWallet = newWallet

      toolCenter.register(createCryptoTradingTools(newResult.engine, newWallet, bridge), 'crypto-trading')
      await refreshCryptoRuntimeTruth({
        engine: newResult.engine,
        liveGateManager,
        klineStore,
        newsStore,
        symbols: freshConfig.engine.pairs,
      })
      console.log(`reconnect: crypto trading engine online (${toolCenter.list().length} tools)`)
      return { success: true, message: 'Crypto trading engine reconnected' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('reconnect: crypto failed:', msg)
      return { success: false, error: msg }
    } finally {
      cryptoReconnecting = false
    }
  }

  let secReconnecting = false
  const reconnectSecurities = async (): Promise<ReconnectResult> => {
    if (secReconnecting) return { success: false, error: 'Reconnect already in progress' }
    secReconnecting = true
    try {
      const freshConfig = await loadConfig()

      const newResult = await createSecuritiesTradingEngine(freshConfig)
      await secResultRef?.close()
      secResultRef = newResult

      if (!newResult) {
        return { success: true, message: 'Securities trading disabled (provider: none)' }
      }

      const bridge = createSecWalletStateBridge(newResult.engine)
      const rawDispatcher = createSecOperationDispatcher(newResult.engine)
      const guards = resolveSecGuards(freshConfig.securities.guards)
      const walletConfig = {
        executeOperation: createSecGuardPipeline(rawDispatcher, newResult.engine, guards),
        getWalletState: bridge,
        onCommit: onSecCommit,
      }
      const savedWallet = await readFile(SEC_WALLET_FILE, 'utf-8')
        .then((r) => JSON.parse(r) as SecWalletExportState).catch(() => undefined)
      const newWallet = savedWallet ? SecWallet.restore(savedWallet, walletConfig) : new SecWallet(walletConfig)
      currentSecWallet = newWallet

      toolCenter.register(createSecuritiesTradingTools(newResult.engine, newWallet, bridge), 'securities-trading')
      console.log(`reconnect: securities trading engine online (${toolCenter.list().length} tools)`)
      return { success: true, message: 'Securities trading engine reconnected' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('reconnect: securities failed:', msg)
      return { success: false, error: msg }
    } finally {
      secReconnecting = false
    }
  }

  // ==================== Plugins ====================

  // Core plugins — always-on, not toggleable at runtime
  const corePlugins: Plugin[] = []

  // MCP Server is always active when a port is set — Claude Code provider depends on it for tools
  if (config.connectors.mcp.port) {
    corePlugins.push(
      new McpPlugin(
        toolCenter,
        config.connectors.mcp.port,
        config.connectors.mcp.allowOrigins,
      ),
    )
  }

  // Web UI is always active (no enabled flag)
  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({
      port: config.connectors.web.port,
      allowOrigins: config.connectors.web.allowOrigins,
      maxSseClients: config.connectors.web.maxSseClients,
      sseMaxDurationMs: config.connectors.web.sseMaxDurationMs,
    }))
  }

  // Optional plugins — toggleable at runtime via reconnectConnectors()
  const optionalPlugins = new Map<string, Plugin>()

  if (config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port) {
    optionalPlugins.set('mcp-ask', new McpAskPlugin({
      port: config.connectors.mcpAsk.port,
      allowOrigins: config.connectors.mcpAsk.allowOrigins,
    }))
  }

  if (config.connectors.telegram.enabled && config.connectors.telegram.botToken) {
    optionalPlugins.set('telegram', new TelegramPlugin({
      token: config.connectors.telegram.botToken,
      allowedChatIds: config.connectors.telegram.chatIds,
    }))
  }

  // ==================== Connector Reconnect ====================

  let connectorsReconnecting = false
  const reconnectConnectors = async (): Promise<ReconnectResult> => {
    if (connectorsReconnecting) return { success: false, error: 'Reconnect already in progress' }
    connectorsReconnecting = true
    try {
      const fresh = await loadConfig()
      const changes: string[] = []

      // --- MCP Ask ---
      const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
      const mcpAskRunning = optionalPlugins.has('mcp-ask')
      if (mcpAskRunning && !mcpAskWanted) {
        await optionalPlugins.get('mcp-ask')!.stop()
        optionalPlugins.delete('mcp-ask')
        changes.push('mcp-ask stopped')
      } else if (!mcpAskRunning && mcpAskWanted) {
        const p = new McpAskPlugin({
          port: fresh.connectors.mcpAsk.port!,
          allowOrigins: fresh.connectors.mcpAsk.allowOrigins,
        })
        await p.start(ctx)
        optionalPlugins.set('mcp-ask', p)
        changes.push('mcp-ask started')
      }

      // --- Telegram ---
      const telegramWanted = fresh.connectors.telegram.enabled && !!fresh.connectors.telegram.botToken
      const telegramRunning = optionalPlugins.has('telegram')
      if (telegramRunning && !telegramWanted) {
        await optionalPlugins.get('telegram')!.stop()
        optionalPlugins.delete('telegram')
        changes.push('telegram stopped')
      } else if (!telegramRunning && telegramWanted) {
        const p = new TelegramPlugin({
          token: fresh.connectors.telegram.botToken!,
          allowedChatIds: fresh.connectors.telegram.chatIds,
        })
        await p.start(ctx)
        optionalPlugins.set('telegram', p)
        changes.push('telegram started')
      }

      if (changes.length > 0) {
        console.log(`reconnect: connectors — ${changes.join(', ')}`)
      }
      return { success: true, message: changes.length > 0 ? changes.join(', ') : 'no changes' }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('reconnect: connectors failed:', msg)
      return { success: false, error: msg }
    } finally {
      connectorsReconnecting = false
    }
  }

  const ctx: EngineContext = {
    config, connectorCenter, engine, cryptoEngine: null, eventLog, heartbeat, cronEngine,
    reconnectCrypto, reconnectSecurities, reconnectConnectors,
    getCryptoEngine: () => cryptoResultRef?.engine ?? null,
    getSecuritiesEngine: () => secResultRef?.engine ?? null,
    getCryptoWallet: () => currentCryptoWallet,
    getSecWallet: () => currentSecWallet,
    toolCenter,
  }

  for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
    await plugin.start(ctx)
    console.log(`plugin started: ${plugin.name}`)
  }

  console.log('engine: started (crypto trading tools pending ccxt init)')

  // ==================== CCXT Background Injection ====================
  // When the CCXT engine is ready, register crypto trading tools so the next
  // agent call picks them up automatically (VercelAIProvider re-checks tool count).

  cryptoInitPromise.then((cryptoResult) => {
    cryptoResultRef = cryptoResult
    if (!cryptoResult) return
    const bridge = createCryptoWalletStateBridge(cryptoResult.engine)
    createCryptoDispatcherRuntime({
      engine: cryptoResult.engine,
      config,
      eventLog,
      klineStore,
      ticketStore,
      intentLedger,
      idempotencyStore,
      killSwitch,
      exchangeId,
    }).then(async ({ liveGateManager, rawDispatcher }) => {
      const guards = resolveGuards(config.crypto.guards)
      const realWalletConfig = {
        executeOperation: createGuardPipeline(rawDispatcher, cryptoResult.engine, guards),
        getWalletState: bridge,
        onCommit: onCryptoCommit,
      }
      const realWallet = savedState
        ? Wallet.restore(savedState, realWalletConfig)
        : new Wallet(realWalletConfig)
      currentCryptoWallet = realWallet
      toolCenter.register(createCryptoTradingTools(cryptoResult.engine, realWallet, bridge), 'crypto-trading')
      await refreshCryptoRuntimeTruth({
        engine: cryptoResult.engine,
        liveGateManager,
        klineStore,
        newsStore,
        symbols: config.engine.pairs,
      })
      console.log(`ccxt: crypto trading tools online (${toolCenter.list().length} tools total)`)
    }).catch((err) => {
      console.error('ccxt: crypto runtime wiring failed:', err)
    })
  })

  // ==================== Shutdown ====================

  let stopped = false;
  let shutdownInProgress = false;

  const shutdown = async () => {
    stopped = true
    clearInterval(ticketCleanupInterval)
    newsCollector?.stop()
    heartbeat.stop()
    cronListener.stop()
    cronEngine.stop()
    for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
      await plugin.stop()
    }
    await newsStore.close()
    await eventLog.close()
    await cryptoResultRef?.close()
    await secResultRef?.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  // ==================== Tick Loop ====================

  while (!stopped) {
    await sleep(config.engine.interval)
  }
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
