import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { Engine } from "./core/engine.js";
import { loadConfig } from "./core/config.js";
import type { Plugin, EngineContext } from "./core/types.js";
import { HttpPlugin } from "./plugins/http.js";
import { McpPlugin } from "./plugins/mcp.js";
import { TelegramPlugin } from "./connectors/telegram/index.js";
import { WebPlugin } from "./connectors/web/index.js";
import { McpAskPlugin } from "./connectors/mcp-ask/index.js";
import {
  KlineStore,
  NewsStore,
  RealMarketDataProvider,
  RealNewsProvider,
  fetchRealtimeData,
} from "./extension/analysis-kit/index.js";
import type { MarketData, NewsItem } from "./extension/analysis-kit/index.js";
import { createThinkingTools } from "./extension/thinking-kit/index.js";
import { createAnalysisTools } from "./extension/analysis-tools/index.js";
import { createStrategyTools } from "./extension/strategy-tools/index.js";
import { createMlEnsembleTools } from "./extension/ml-ensemble-tools/index.js";
import { createExpertQuantTools } from "./extension/expert-quant-tools/index.js";
import type {
  Operation,
  WalletExportState,
} from "./extension/crypto-trading/index.js";
import {
  Wallet,
  initCryptoAllowedSymbols,
  createCryptoTradingEngine,
  createCryptoTradingTools,
  createCryptoOperationDispatcher,
  createCryptoWalletStateBridge,
} from "./extension/crypto-trading/index.js";
import type {
  SecOperation,
  SecWalletExportState,
} from "./extension/securities-trading/index.js";
import {
  SecWallet,
  initSecAllowedSymbols,
  createSecuritiesTradingEngine,
  createSecuritiesTradingTools,
  createSecOperationDispatcher,
  createSecWalletStateBridge,
} from "./extension/securities-trading/index.js";
import { Brain, createBrainTools } from "./extension/brain/index.js";
import type { BrainExportState } from "./extension/brain/index.js";
import { createBrowserTools } from "./extension/browser/index.js";
import { SessionStore } from "./core/session.js";
import { ToolCenter } from "./core/tool-center.js";
import { AgentCenter } from "./core/agent-center.js";
import { ProviderRouter } from "./core/ai-provider.js";
import { createAgent } from "./providers/vercel-ai-sdk/index.js";
import { VercelAIProvider } from "./providers/vercel-ai-sdk/vercel-provider.js";
import { ClaudeCodeProvider } from "./providers/claude-code/claude-code-provider.js";
import { createConfiguredModel } from "./providers/vercel-ai-sdk/model-factory.js";
import { createEventLog } from "./core/event-log.js";
import {
  createCronEngine,
  createCronListener,
  createCronTools,
} from "./task/cron/index.js";
import { createHeartbeat } from "./task/heartbeat/index.js";
import { LiveGateManager } from "./runtime/live_gate_manager.js";
import { DecisionTicketStore } from "./extension/crypto-trading/decision-ticket.js";
import { IntentLedger } from "./extension/crypto-trading/intent-ledger.js";
import { TradeIdempotencyStore } from "./extension/crypto-trading/idempotency-store.js";
import { KillSwitch } from "./extension/crypto-trading/kill-switch.js";
import { PnLTracker } from "./extension/crypto-trading/pnl-tracker.js";

const WALLET_FILE = resolve("data/crypto-trading/commit.json");
const SEC_WALLET_FILE = resolve("data/securities-trading/commit.json");
const BRAIN_FILE = resolve("data/brain/commit.json");
const FRONTAL_LOBE_FILE = resolve("data/brain/frontal-lobe.md");
const EMOTION_LOG_FILE = resolve("data/brain/emotion-log.md");
const PERSONA_FILE = resolve("data/brain/persona.md");
const PERSONA_DEFAULT = resolve("data/default/persona.default.md");

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

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

async function main() {
  const config = await loadConfig();
  const model = await createConfiguredModel(config.model);
  let liveGateManager: LiveGateManager | null = null;

  // ==================== Infrastructure ====================

  // Initialize crypto trading symbol whitelist from config
  initCryptoAllowedSymbols(config.crypto.allowedSymbols);

  // Crypto trading engine (CCXT or none) — non-fatal on failure
  let cryptoResult: Awaited<ReturnType<typeof createCryptoTradingEngine>> =
    null;
  try {
    cryptoResult = await createCryptoTradingEngine(config);
  } catch (err) {
    console.warn(
      "crypto trading engine init failed (non-fatal, continuing without it):",
      err
    );
  }
  const cryptoEngine = cryptoResult?.engine ?? null;

  // Wallet: wire callbacks to crypto trading engine (or throw stubs if no provider)
  const cryptoWalletStateBridge = cryptoResult
    ? createCryptoWalletStateBridge(cryptoResult.engine)
    : undefined;

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

  const pnlTracker = new PnLTracker({
    reconciliationThresholdPct: config.reconciliation.thresholdPct,
  });

  // Derive exchange ID from crypto config
  const exchangeId =
    config.crypto.provider.type === "ccxt"
      ? config.crypto.provider.exchange
      : undefined;

  const cryptoWalletConfig = cryptoResult
    ? {
        executeOperation: createCryptoOperationDispatcher(cryptoResult.engine, {
          riskConfig: config.risk,
          getRiskContext: async () => liveGateManager?.buildRiskContext(),
          beforePlaceOrderGate: async ({ request }) =>
            liveGateManager?.beforePlaceOrder(request),
          estimateExpectedPrice: async ({ request }) =>
            liveGateManager?.estimateExpectedPrice(request),
          afterPlaceOrder: async ({ request, result, expectedPrice }) => {
            await liveGateManager?.recordExecution(
              request,
              result,
              expectedPrice
            );
            // Record fill in PnL tracker
            if (result.success && result.filledPrice && result.filledSize) {
              pnlTracker.recordFill({
                symbol: request.symbol,
                side: request.side,
                size: result.filledSize,
                price: result.filledPrice,
                timestamp: Date.now(),
                orderId: result.orderId,
              });
            }
          },
          ticketStore,
          intentLedger,
          idempotencyStore,
          killSwitch,
          exchangeId,
          slippageConfig: {
            maxSlippagePct: config.slippage.maxSlippagePct,
            reduceOnlyMultiplier: config.slippage.reduceOnlyMultiplier,
          },
          eventLog: {
            append: async (type: string, payload: unknown) =>
              eventLog.append(type, payload),
          },
        }).dispatch,
        getWalletState: cryptoWalletStateBridge!,
        onCommit: onCryptoCommit,
      }
    : {
        executeOperation: async (_op: Operation) => {
          throw new Error("Crypto trading service not connected");
        },
        getWalletState: async () => {
          throw new Error("Crypto trading service not connected");
        },
        onCommit: onCryptoCommit,
      };

  // Restore wallet from disk if available
  let savedState: WalletExportState | undefined;
  try {
    const raw = await readFile(WALLET_FILE, "utf-8");
    savedState = JSON.parse(raw);
  } catch {
    /* file not found → fresh start */
  }

  const wallet = savedState
    ? Wallet.restore(savedState, cryptoWalletConfig)
    : new Wallet(cryptoWalletConfig);

  // ==================== Securities Trading ====================

  initSecAllowedSymbols(config.securities.allowedSymbols);

  let secResult: Awaited<ReturnType<typeof createSecuritiesTradingEngine>> =
    null;
  try {
    secResult = await createSecuritiesTradingEngine(config);
  } catch (err) {
    console.warn(
      "securities trading engine init failed (non-fatal, continuing without it):",
      err
    );
  }

  const secWalletStateBridge = secResult
    ? createSecWalletStateBridge(secResult.engine)
    : undefined;

  const onSecCommit = async (state: SecWalletExportState) => {
    await mkdir(resolve("data/securities-trading"), { recursive: true });
    await writeFile(SEC_WALLET_FILE, JSON.stringify(state, null, 2));
  };

  const secWalletConfig = secResult
    ? {
        executeOperation: createSecOperationDispatcher(secResult.engine),
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

  let secSavedState: SecWalletExportState | undefined;
  try {
    const raw = await readFile(SEC_WALLET_FILE, "utf-8");
    secSavedState = JSON.parse(raw);
  } catch {
    /* file not found → fresh start */
  }

  const secWallet = secSavedState
    ? SecWallet.restore(secSavedState, secWalletConfig)
    : new SecWallet(secWalletConfig);

  // Data stores (realtime market & news data)
  let marketData: Record<string, MarketData[]> = {};
  let news: NewsItem[] = [];
  try {
    const realtimeData = await fetchRealtimeData({ news: config.news });
    marketData = realtimeData.marketData;
    news = realtimeData.news;
  } catch (err) {
    console.warn(
      "DotAPI initial fetch failed (non-fatal, starting with empty data):",
      err
    );
  }
  const marketProvider = new RealMarketDataProvider(marketData);
  const newsProvider = new RealNewsProvider(news);

  const klineStore = new KlineStore(
    { timeframe: config.engine.timeframe },
    marketProvider
  );
  const newsStore = new NewsStore(newsProvider);

  // Brain: cognitive state with commit-based tracking
  const brainDir = resolve("data/brain");
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

  let brainExport: BrainExportState | undefined;
  try {
    const raw = await readFile(BRAIN_FILE, "utf-8");
    brainExport = JSON.parse(raw);
  } catch {
    /* not found → fresh start */
  }

  const brain = brainExport
    ? Brain.restore(brainExport, { onCommit: brainOnCommit })
    : new Brain({ onCommit: brainOnCommit });

  // Build system prompt: persona + current brain state
  const persona = await readWithDefault(PERSONA_FILE, PERSONA_DEFAULT);

  const frontalLobe = brain.getFrontalLobe();
  const emotion = brain.getEmotion().current;
  const instructions = [
    persona,
    "---",
    "## Current Brain State",
    "",
    `**Frontal Lobe:** ${frontalLobe || "(empty)"}`,
    "",
    `**Emotion:** ${emotion}`,
  ].join("\n");

  // Refresh market data & news periodically
  setInterval(async () => {
    try {
      const { marketData, news } = await fetchRealtimeData({
        news: config.news,
      });
      marketProvider.reload(marketData);
      newsProvider.reload(news);
    } catch (err) {
      console.error("DotAPI refresh failed:", err);
    }
  }, config.engine.dataRefreshInterval);

  // ==================== Event Log ====================

  const eventLog = await createEventLog();

  if (cryptoEngine) {
    liveGateManager = await LiveGateManager.create({
      engine: cryptoEngine,
      klineStore,
      riskConfig: config.risk,
      eventLog,
      baseDir: "data",
    });
  }

  // ==================== Cron ====================

  const cronEngine = createCronEngine({ eventLog });

  // ==================== Tool Center ====================

  const toolCenter = new ToolCenter();
  toolCenter.register(createThinkingTools());
  const analysisContext = {
    getPlayheadTime: () => klineStore.getPlayheadTime(),
    getLatestOHLCV: (s: string[]) => klineStore.getLatestOHLCV(s),
    getAvailableSymbols: () => klineStore.getAvailableSymbols(),
    calculatePreviousTime: (l: number) => klineStore.calculatePreviousTime(l),
    marketDataProvider: klineStore.marketDataProvider,
    getNewsV2: (o: { lookback?: string; limit?: number }) =>
      newsStore.getNewsV2(o),
  };
  toolCenter.register(createAnalysisTools(analysisContext));
  toolCenter.register(createStrategyTools(analysisContext));
  toolCenter.register(createMlEnsembleTools(analysisContext));
  toolCenter.register(createExpertQuantTools(analysisContext));
  if (cryptoEngine) {
    toolCenter.register(
      createCryptoTradingTools(cryptoEngine, wallet, cryptoWalletStateBridge)
    );
  }
  if (secResult) {
    toolCenter.register(
      createSecuritiesTradingTools(
        secResult.engine,
        secWallet,
        secWalletStateBridge
      )
    );
  }
  toolCenter.register(createBrainTools(brain));
  toolCenter.register(createBrowserTools());
  toolCenter.register(createCronTools(cronEngine));

  console.log(`tool-center: ${toolCenter.list().length} tools registered`);

  // ==================== AI Provider Chain ====================

  const agent = createAgent(
    model,
    toolCenter.getVercelTools(),
    instructions,
    config.agent.maxSteps
  );
  const vercelProvider = new VercelAIProvider(
    agent,
    config.compaction,
    config.model.provider.toLowerCase() === "gmn" ? "force-false" : "default"
  );
  const claudeCodeProvider = new ClaudeCodeProvider(
    config.compaction,
    instructions
  );
  const router = new ProviderRouter(vercelProvider, claudeCodeProvider);

  const agentCenter = new AgentCenter(router);
  const engine = new Engine({ agentCenter });

  // ==================== Cron Lifecycle ====================

  await cronEngine.start();
  const cronSession = new SessionStore("cron/default");
  await cronSession.restore();
  const cronListener = createCronListener({
    eventLog,
    engine,
    session: cronSession,
  });
  cronListener.start();
  console.log("cron: engine + listener started");

  // ==================== Heartbeat ====================

  const heartbeat = createHeartbeat({
    config: config.heartbeat,
    cronEngine,
    eventLog,
    engine,
  });
  await heartbeat.start();
  if (config.heartbeat.enabled) {
    console.log(`heartbeat: enabled (every ${config.heartbeat.every})`);
  }

  // ==================== Plugins ====================

  const plugins: Plugin[] = [new HttpPlugin()];

  if (config.engine.mcpPort) {
    plugins.push(
      new McpPlugin(toolCenter.getMcpTools(), config.engine.mcpPort)
    );
  }

  if (config.engine.askMcpPort) {
    plugins.push(new McpAskPlugin({ port: config.engine.askMcpPort }));
  }

  if (config.engine.webPort) {
    plugins.push(new WebPlugin({ port: config.engine.webPort }));
  }

  if (process.env.TELEGRAM_BOT_TOKEN) {
    plugins.push(
      new TelegramPlugin({
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowedChatIds: process.env.TELEGRAM_CHAT_ID
          ? process.env.TELEGRAM_CHAT_ID.split(",").map(Number)
          : [],
      })
    );
  }

  const ctx: EngineContext = {
    config,
    engine,
    klineStore,
    newsStore,
    cryptoEngine,
    eventLog,
    heartbeat,
    cronEngine,
    stopped: false,
    ticketStore,
    intentLedger,
    killSwitch,
    pnlTracker,
  };

  for (const plugin of plugins) {
    await plugin.start(ctx);
    console.log(`plugin started: ${plugin.name}`);
  }

  // ==================== Shutdown ====================

  let stopped = false;
  let shutdownInProgress = false;

  const shutdown = async () => {
    // Double SIGINT: force exit immediately
    if (shutdownInProgress) {
      console.log("shutdown: forced exit (double signal)");
      process.exit(1);
    }
    shutdownInProgress = true;

    // 1. stopped = true → tick loop exits, middleware returns 503
    stopped = true;
    ctx.stopped = true;
    console.log("shutdown: stopping...");

    // 2. Stop accepting new work
    heartbeat.stop();
    cronListener.stop();
    cronEngine.stop();

    // 3. server.close() on all plugins (stops new connections, drains existing)
    for (const plugin of plugins) {
      try {
        await plugin.stop();
      } catch (err) {
        console.error(`shutdown: plugin ${plugin.name} stop error:`, err);
      }
    }

    // 4. Drain write queues (max 5s)
    const drainTimeout = config.shutdown.drainTimeoutMs;
    try {
      await Promise.race([
        (async () => {
          await intentLedger.close();
          await eventLog.close();
          await cryptoResult?.close();
          await secResult?.close();
        })(),
        sleep(drainTimeout).then(() => {
          console.warn(`shutdown: drain timeout (${drainTimeout}ms) exceeded`);
        }),
      ]);
    } catch (err) {
      console.error("shutdown: drain error:", err);
    }

    // 5. Exit
    console.log("shutdown: complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // ==================== Tick Loop ====================

  // Reconciliation interval tracking
  let lastReconcileMs = Date.now();
  const reconcileIntervalMs = config.reconciliation.intervalMs;
  let reconcileFailCount = 0;
  let lastIdempotencyCleanupMs = Date.now();
  const idempotencyCleanupIntervalMs = 60 * 60_000;

  console.log("engine: started");
  while (!stopped) {
    const now = new Date();
    klineStore.setPlayheadTime(now);
    newsStore.setPlayheadTime(now);
    try {
      await liveGateManager?.tick(now);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("live-gate: tick failed:", message);
      try {
        await eventLog.append("gate.tick.failed", {
          error: message,
          nowIso: now.toISOString(),
        });
      } catch (appendErr) {
        console.error(
          "live-gate: failed to append tick failure event:",
          appendErr
        );
      }
    }

    // Periodic ticket cleanup
    ticketStore.cleanup();

    // Periodic PnL reconciliation
    const nowMs = Date.now();
    if (nowMs - lastReconcileMs >= reconcileIntervalMs) {
      lastReconcileMs = nowMs;
      try {
        // Update mark prices from engine
        if (cryptoEngine) {
          const positions = await cryptoEngine.getPositions();
          for (const pos of positions) {
            pnlTracker.updateMarkPrice(pos.symbol, pos.markPrice);
          }
        }
        const results = pnlTracker.reconcileAll();
        const alerts = results.filter(r => r.alert);
        if (alerts.length > 0) {
          reconcileFailCount++;
          await eventLog.append("pnl.reconciliation.alert", {
            alerts,
            consecutiveAlerts: reconcileFailCount,
          });
          if (reconcileFailCount >= config.reconciliation.consecutiveBreaches) {
            console.error(
              `pnl: ${reconcileFailCount} consecutive reconciliation alerts — review required`
            );
          }
        } else {
          reconcileFailCount = 0;
        }
      } catch (err) {
        console.error("pnl: reconciliation error:", err);
      }
    }

    if (nowMs - lastIdempotencyCleanupMs >= idempotencyCleanupIntervalMs) {
      lastIdempotencyCleanupMs = nowMs;
      try {
        await idempotencyStore.cleanup(nowMs);
      } catch (err) {
        console.error("idempotency: cleanup error:", err);
      }
    }

    await sleep(config.engine.interval);
  }
}

main().catch(err => {
  console.error("fatal:", err);
  process.exit(1);
});
