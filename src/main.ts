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
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ICryptoTradingEngine,
  WalletExportState,
} from './extension/crypto-trading/index.js'
import type {
  RiskCheckContext,
  RiskCheckResult,
} from './extension/crypto-trading/risk.js'
import {
  Wallet,
  createCryptoTradingEngine,
  createCryptoTradingTools,
  createCryptoOperationDispatcher,
  createCryptoWalletStateBridge,
  createGuardBatchPipeline,
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
import { DecisionTicketStore } from './extension/crypto-trading/decision-ticket.js'
import { IntentLedger } from './extension/crypto-trading/intent-ledger.js'
import { TradeIdempotencyStore } from './extension/crypto-trading/idempotency-store.js'
import { KillSwitch } from './extension/crypto-trading/kill-switch.js'
import { PnLTracker } from './extension/crypto-trading/pnl-tracker.js'
import type { SyncedCryptoOrderUpdate } from './extension/crypto-trading/adapter.js'
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
import type { IAnalysisContext } from './extension/analysis-tools/interfaces.js'
import type { MarketData } from './extension/analysis-kit/data/interfaces.js'
import { createTradingAgentsResearchTools, TradingAgentsSidecarRunner } from './extension/strategy-research-tradingagents/index.js'
import { loadTradingAgentsVerdict } from './runtime/tradingagents_advisory_scorecard.js'
import { SessionStore } from './core/session.js'
import { configureGlobalNetworkProxy } from './core/network-proxy.js'
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
import { createOpenBBCryptoLiveMarketContext } from './runtime/openbb_live_market_context.js'
import type { CryptoHistoricalData } from './openbb/crypto/types/price.js'

const WALLET_FILE = resolve("data/crypto-trading/commit.json");
const PNL_TRACKER_FILE = resolve("data/crypto-trading/pnl-fills.jsonl");
const SEC_WALLET_FILE = resolve("data/securities-trading/commit.json");
const BRAIN_FILE = resolve("data/brain/commit.json");
const FRONTAL_LOBE_FILE = resolve("data/brain/frontal-lobe.md");
const EMOTION_LOG_FILE = resolve("data/brain/emotion-log.md");
const PERSONA_FILE = resolve("data/brain/persona.md");
const PERSONA_DEFAULT = resolve("data/default/persona.default.md");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type CryptoLiveGateHooks = {
  beforePlaceOrder: (
    req: CryptoPlaceOrderRequest
  ) => Promise<RiskCheckResult | undefined>;
  buildRiskContext: () => Promise<RiskCheckContext | undefined>;
  estimateExpectedPrice: (req: CryptoPlaceOrderRequest) => Promise<number | undefined>;
  recordExecution: (
    req: CryptoPlaceOrderRequest,
    result: CryptoOrderResult,
    expectedPrice?: number
  ) => Promise<void>;
};

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

function timeframeToMs(timeframe: string): number {
  const match = timeframe.match(/^(\d+)([mhdw])$/i)
  if (!match) {
    return 60 * 60 * 1000
  }

  const value = Number(match[1])
  const unit = match[2].toLowerCase()
  switch (unit) {
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
    case 'w':
      return value * 7 * 24 * 60 * 60 * 1000
    default:
      return 60 * 60 * 1000
  }
}

function toOpenBBCryptoSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace('/', '-')
}

function mapHistoricalRowToMarketData(
  symbol: string,
  row: CryptoHistoricalData,
): MarketData | null {
  const ts = Date.parse(row.date)
  if (!Number.isFinite(ts)) {
    return null
  }
  return {
    symbol,
    time: Math.floor(ts / 1000),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume ?? 0,
  }
}

function createResearchAnalysisContext(params: {
  cryptoClient: OpenBBCryptoClient
  newsProvider: Pick<NewsCollectorStore, 'getNewsV2'>
  timeframe: string
}): IAnalysisContext {
  const barMs = timeframeToMs(params.timeframe)
  const getMarketDataRange = async (startTime: Date, endTime: Date, symbol: string) => {
    const rows = (await params.cryptoClient.getHistorical({
      symbol: toOpenBBCryptoSymbol(symbol),
      start_date: startTime.toISOString().slice(0, 10),
      end_date: endTime.toISOString().slice(0, 10),
      interval: params.timeframe,
    })) as CryptoHistoricalData[]

    return rows
      .map((row) => mapHistoricalRowToMarketData(symbol, row))
      .filter((row): row is MarketData => row !== null)
      .filter((row) => {
        const rowMs = row.time * 1000
        return rowMs >= startTime.getTime() - barMs && rowMs <= endTime.getTime()
      })
      .sort((a, b) => a.time - b.time)
  }

  return {
    marketDataProvider: {
      async getMarketData(time: Date, symbol: string) {
        const rows = await getMarketDataRange(time, time, symbol)
        const latest = rows[rows.length - 1]
        if (!latest) {
          throw new Error(`No market data available for ${symbol}.`)
        }
        return latest
      },
      getMarketDataRange,
    },
    getPlayheadTime() {
      return new Date()
    },
    calculatePreviousTime(lookbackBars: number) {
      return new Date(Date.now() - lookbackBars * barMs)
    },
    async getNewsV2(options) {
      return params.newsProvider.getNewsV2({
        endTime: options.endTime ?? new Date(),
        startTime: options.startTime,
        lookback: options.lookback,
        limit: options.limit,
      })
    },
  }
}

async function main() {
  const config = await loadConfig()

  const outboundProxy = configureGlobalNetworkProxy()
  if (outboundProxy) {
    console.log(`network: outbound proxy enabled (${outboundProxy})`)
  }

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

  const pnlTracker = await PnLTracker.create({
    reconciliationThresholdPct: config.reconciliation.thresholdPct,
    persistencePath: PNL_TRACKER_FILE,
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
  let liveGateManager: CryptoLiveGateHooks | null = null
  const getLiveGateManager = (): CryptoLiveGateHooks | null => liveGateManager

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
  if (config.researchDesk.tradingAgents.enabled) {
    try {
      const analysisContext = createResearchAnalysisContext({
        cryptoClient,
        newsProvider: newsStore,
        timeframe: config.engine.timeframe,
      })
      const runner = new TradingAgentsSidecarRunner({
        workingDirectory: resolve(config.researchDesk.tradingAgents.workingDirectory),
        entrypoint: config.researchDesk.tradingAgents.entrypoint,
        artifactDir: resolve(config.researchDesk.tradingAgents.artifactDir),
        timeoutMs: config.researchDesk.tradingAgents.timeoutMs,
        noOutputTimeoutMs: config.researchDesk.tradingAgents.noOutputTimeoutMs,
        mode: config.researchDesk.tradingAgents.mode,
        pythonBin: config.researchDesk.tradingAgents.pythonBin,
        envAllowlist: config.researchDesk.tradingAgents.envAllowlist,
        releaseGateStatusPath: resolve(config.governance.releaseGate.statusPath),
      })
      toolCenter.register(
        createTradingAgentsResearchTools(analysisContext, runner, {
          loadVerdict: async () =>
            loadTradingAgentsVerdict(
              resolve(config.researchDesk.tradingAgents.verdictPath),
            ),
        }),
        'research-sidecar',
      )
    } catch (err) {
      console.warn('tradingagents sidecar init failed (non-fatal, continuing without it):', err)
    }
  }

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
  const cronListener = createCronListener({
    connectorCenter,
    eventLog,
    engine,
    session: cronSession,
    cronEngine,
  })
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

  // ==================== Crypto Dispatcher Wiring ====================

  const appendTradingEvent = async (type: string, payload: unknown) => {
    await eventLog.append(type, payload).catch(() => {})
  }

  const recordPnlFill = async (fill: {
    symbol: string
    side: 'buy' | 'sell'
    size: number
    price: number
    timestamp: number
    orderId?: string
  }) => {
    pnlTracker.recordFill(fill)
    pnlTracker.updateMarkPrice(fill.symbol, fill.price)

    const reconciliation = pnlTracker.reconcile(fill.symbol)
    if (reconciliation.alert) {
      await appendTradingEvent('pnl.reconciliation.alert', {
        symbol: reconciliation.symbol,
        divergence: reconciliation.divergence,
        divergencePct: reconciliation.divergencePct,
        avgCostRealizedPnL: reconciliation.avgCostRealizedPnL,
        fifoRealizedPnL: reconciliation.fifoRealizedPnL,
      })
    }
  }

  const recordSyncedOrderFills = async (updates: SyncedCryptoOrderUpdate[]) => {
    for (const update of updates) {
      if (
        (update.currentStatus !== 'filled' &&
          update.currentStatus !== 'partially_filled') ||
        typeof update.filledPrice !== 'number' ||
        typeof update.filledSize !== 'number' ||
        update.filledSize <= 0 ||
        !update.side
      ) {
        continue
      }
      await recordPnlFill({
        symbol: update.symbol,
        side: update.side,
        size: update.filledSize,
        price: update.filledPrice,
        timestamp: update.exchangeUpdateTs ?? Date.now(),
        orderId: update.orderId,
      })
    }
  }

  const createLiveGateHooks = async (
    tradingEngine: ICryptoTradingEngine,
    effectiveConfig: typeof config
  ): Promise<CryptoLiveGateHooks> => {
    const marketContext = createOpenBBCryptoLiveMarketContext({
      client: new OpenBBCryptoClient(
        effectiveConfig.openbb.apiUrl,
        effectiveConfig.openbb.providers.crypto,
        effectiveConfig.openbb.providerKeys,
      ),
      // Live-gate market context should follow the configured trading universe,
      // not the separate canary/micro-live allowlist.
      symbols: [...effectiveConfig.engine.pairs],
      interval: effectiveConfig.engine.timeframe,
    })

    return LiveGateManager.create({
      engine: tradingEngine,
      marketContext,
      riskConfig: effectiveConfig.risk,
      eventLog,
      baseDir: 'data',
      config: {
        requireReleaseGatePass: effectiveConfig.governance.releaseGate.enabled,
        gateMode:
          effectiveConfig.crypto.provider.type === "ccxt" &&
          effectiveConfig.crypto.provider.demoTrading
            ? "paper"
            : "live",
        releaseGateStatusPath: effectiveConfig.governance.releaseGate.statusPath,
        liveCanary: {
          enabled: effectiveConfig.canary.enabled,
          statePath: effectiveConfig.canary.statePath,
        },
        rolloutReadiness: {
          enabled: effectiveConfig.governance.rolloutReadiness.enabled,
          statusPath: effectiveConfig.governance.rolloutReadiness.statusPath,
        },
      },
    })
  }

  const wireCryptoDispatcher = (
    tradingEngine: ICryptoTradingEngine,
    effectiveConfig: typeof config
  ) => {
    const effectiveExchangeId =
      effectiveConfig.crypto.provider.type === 'ccxt'
        ? effectiveConfig.crypto.provider.exchange
        : undefined

    return createCryptoOperationDispatcher(tradingEngine, {
      riskConfig: effectiveConfig.risk,
      ticketStore,
      intentLedger,
      idempotencyStore,
      killSwitch,
      exchangeId: effectiveExchangeId,
      slippageConfig: effectiveConfig.slippage,
      getRiskContext: async () => getLiveGateManager()?.buildRiskContext(),
      estimateExpectedPrice: async ({ request }) =>
        getLiveGateManager()?.estimateExpectedPrice(request),
      beforePlaceOrderGate: async ({ request }) =>
        getLiveGateManager()?.beforePlaceOrder(request),
      afterPlaceOrder: async ({ request, result, expectedPrice }) => {
        const manager = getLiveGateManager()
        if (manager) {
          await manager.recordExecution(request, result, expectedPrice)
        }
        if (
          !result.success ||
          typeof result.filledPrice !== 'number' ||
          typeof result.filledSize !== 'number' ||
          result.filledSize <= 0
        ) {
          return
        }

        await recordPnlFill({
          symbol: request.symbol,
          side: request.side,
          size: result.filledSize,
          price: result.filledPrice,
          timestamp: result.exchangeUpdateTs ?? result.completedAtMs ?? Date.now(),
          orderId: result.orderId,
        })
      },
      onRiskRejected: async ({ operation, request, reason, details }) => {
        await appendTradingEvent('risk.rejected', {
          action: operation.action,
          symbol: request.symbol,
          side: request.side,
          type: request.type,
          reduceOnly: !!request.reduceOnly,
          reason,
          details: details ?? null,
        })
      },
    })
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
        liveGateManager = null
        return { success: true, message: 'Crypto trading disabled (provider: none)' }
      }

      liveGateManager = await createLiveGateHooks(newResult.engine, freshConfig)
      const bridge = createCryptoWalletStateBridge(newResult.engine)
      const rawDispatcher = wireCryptoDispatcher(newResult.engine, freshConfig)
      const guards = resolveGuards(freshConfig.crypto.guards)
      const walletConfig = {
        executeOperation: createGuardPipeline(rawDispatcher, newResult.engine, guards),
        executeBatch: createGuardBatchPipeline(
          rawDispatcher,
          newResult.engine,
          guards,
        ),
        getWalletState: bridge,
        onCommit: onCryptoCommit,
      }
      const savedWallet = await readFile(WALLET_FILE, 'utf-8')
        .then((r) => JSON.parse(r) as WalletExportState).catch(() => undefined)
      const newWallet = savedWallet ? Wallet.restore(savedWallet, walletConfig) : new Wallet(walletConfig)
      currentCryptoWallet = newWallet

      toolCenter.register(createCryptoTradingTools(newResult.engine, newWallet, bridge, recordSyncedOrderFills), 'crypto-trading')
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
  const disableMcp = process.env.OPENALICE_DISABLE_MCP === '1'

  // MCP Server is always active when a port is set — Claude Code provider depends on it for tools
  if (config.connectors.mcp.port && !disableMcp) {
    corePlugins.push(new McpPlugin(toolCenter, config.connectors.mcp.port))
  } else if (disableMcp) {
    console.warn('mcp plugin disabled via OPENALICE_DISABLE_MCP=1')
  }

  // Web UI is always active (no enabled flag)
  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({ port: config.connectors.web.port }))
  }

  // Optional plugins — toggleable at runtime via reconnectConnectors()
  const optionalPlugins = new Map<string, Plugin>()

  if (config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port) {
    optionalPlugins.set('mcp-ask', new McpAskPlugin({ port: config.connectors.mcpAsk.port }))
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
        const p = new McpAskPlugin({ port: fresh.connectors.mcpAsk.port! })
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

  cryptoInitPromise.then(async (cryptoResult) => {
    cryptoResultRef = cryptoResult
    if (!cryptoResult) return
    try {
      liveGateManager = await createLiveGateHooks(cryptoResult.engine, config)
    } catch (err) {
      console.warn('live gate init failed (non-fatal, continuing without it):', err)
      liveGateManager = null
    }
    const bridge = createCryptoWalletStateBridge(cryptoResult.engine)
    const rawDispatcher = wireCryptoDispatcher(cryptoResult.engine, config)
    const guards = resolveGuards(config.crypto.guards)
    const realWalletConfig = {
      executeOperation: createGuardPipeline(rawDispatcher, cryptoResult.engine, guards),
      executeBatch: createGuardBatchPipeline(
        rawDispatcher,
        cryptoResult.engine,
        guards,
      ),
      getWalletState: bridge,
      onCommit: onCryptoCommit,
    }
    const realWallet = savedState
      ? Wallet.restore(savedState, realWalletConfig)
      : new Wallet(realWalletConfig)
    currentCryptoWallet = realWallet
    toolCenter.register(createCryptoTradingTools(cryptoResult.engine, realWallet, bridge, recordSyncedOrderFills), 'crypto-trading')
    console.log(`ccxt: crypto trading tools online (${toolCenter.list().length} tools total)`)
  })

  // ==================== Shutdown ====================

  let stopped = false;
  let shutdownInProgress = false;

  const shutdown = async () => {
    stopped = true
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
