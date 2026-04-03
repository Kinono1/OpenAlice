import { z } from 'zod'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { resolve } from 'path'
import { newsCollectorSchema } from '../extension/news-collector/config.js'

const CONFIG_DIR = resolve("data/config");
const REDACTED_SECRET = "[redacted]";

// ==================== Individual Schemas ====================

const engineSchema = z.object({
  pairs: z.array(z.string()).min(1).default(["BTC/USD", "ETH/USD", "SOL/USD"]),
  interval: z.number().int().positive().default(5000),
  port: z.number().int().positive().default(3000),
})

export const aiProviderSchema = z.object({
  backend: z.enum(['claude-code', 'vercel-ai-sdk']).default('claude-code'),
  provider: z.string().default('anthropic'),
  model: z.string().default('claude-sonnet-4-6'),
  baseUrl: z.string().min(1).optional(),
  apiKeys: z.object({
    anthropic: z.string().optional(),
    openai: z.string().optional(),
    google: z.string().optional(),
  }).default({}),
})

const agentSchema = z.object({
  maxSteps: z.number().int().positive().default(20),
  evolutionMode: z.boolean().default(false),
  claudeCode: z
    .object({
      allowedTools: z.array(z.string()).optional(),
      disallowedTools: z
        .array(z.string())
        .default([
          "Task",
          "TaskOutput",
          "AskUserQuestion",
          "TodoWrite",
          "NotebookEdit",
          "Skill",
          "EnterPlanMode",
          "ExitPlanMode",
          "mcp__claude_ai_Figma__*",
        ]),
      maxTurns: z.number().int().positive().default(20),
    })
    .default({
      disallowedTools: [
        "Task",
        "TaskOutput",
        "AskUserQuestion",
        "TodoWrite",
        "NotebookEdit",
        "Skill",
        "EnterPlanMode",
        "ExitPlanMode",
        "mcp__claude_ai_Figma__*",
      ],
      maxTurns: 20,
    }),
});

const cryptoSchema = z.object({
  provider: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('ccxt'),
      exchange: z.string(),
      apiKey: z.string().optional(),
      apiSecret: z.string().optional(),
      password: z.string().optional(),
      sandbox: z.boolean().default(false),
      demoTrading: z.boolean().default(false),
      defaultMarketType: z.enum(['spot', 'swap']).default('swap'),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
    z.object({
      type: z.literal('none'),
    }),
  ]).default({
    type: 'ccxt', exchange: 'bybit', sandbox: false, demoTrading: true, defaultMarketType: 'swap',
    // Only load linear (USDT-margined) markets from ccxt.
    // Default is ['spot', 'linear', 'inverse', 'option'] — the extra categories
    // add unnecessary parallel requests during loadMarkets(), and any single failure
    // (common on bybit demo API) aborts the entire init.
    options: { fetchMarkets: { types: ['linear'] } },
  }),
  guards: z.array(z.object({
    type: z.string(),
    options: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
})

const securitiesSchema = z.object({
  provider: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('alpaca'),
      apiKey: z.string().optional(),
      secretKey: z.string().optional(),
      paper: z.boolean().default(true),
    }),
    z.object({
      type: z.literal('none'),
    }),
  ]).default({ type: 'alpaca', paper: true }),
  guards: z.array(z.object({
    type: z.string(),
    options: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
})

const openbbSchema = z.object({
  enabled: z.boolean().default(true),
  apiUrl: z.string().default('http://localhost:6900'),
  providers: z.object({
    equity: z.string().default('yfinance'),
    crypto: z.string().default('yfinance'),
    currency: z.string().default('yfinance'),
    newsCompany: z.string().default('yfinance'),
    newsWorld: z.string().default('fmp'),
  }).default({
    equity: 'yfinance',
    crypto: 'yfinance',
    currency: 'yfinance',
    newsCompany: 'yfinance',
    newsWorld: 'fmp',
  }),
  providerKeys: z.object({
    fred: z.string().optional(),
    fmp: z.string().optional(),
    eia: z.string().optional(),
    bls: z.string().optional(),
    nasdaq: z.string().optional(),
    tradingeconomics: z.string().optional(),
    econdb: z.string().optional(),
    intrinio: z.string().optional(),
    benzinga: z.string().optional(),
    tiingo: z.string().optional(),
    biztoc: z.string().optional(),
  }).default({}),
})

const compactionSchema = z.object({
  maxContextTokens: z.number().default(200_000),
  maxOutputTokens: z.number().default(20_000),
  autoCompactBuffer: z.number().default(13_000),
  microcompactKeepRecent: z.number().default(3),
});

const riskSchema = z.object({
  enabled: z.boolean().default(true),
  killSwitch: z.boolean().default(false),
  maxOpenPositions: z.number().int().positive().default(5),
  maxLeverage: z.number().int().positive().default(5),
  maxOrderUsd: z.number().positive().default(5_000),
  maxPositionPctOfEquity: z.number().positive().max(100).default(30),
  maxDailyLossUsd: z.number().positive().default(1_000),
  enforceRealizedPnlConfidence: z.boolean().default(true),
  minRealizedPnlConfidence: z.number().min(0).max(1).default(0.7),
  trustedRealizedPnlSources: z
    .array(z.enum(["balance_payload", "closed_trades_ledger"]))
    .min(1)
    .default(["balance_payload", "closed_trades_ledger"]),
  dailyLossPctSoftCap: z.number().negative().optional(),
  cvarLossPctSoftCap: z.number().negative().optional(),
  cvarLookbackDays: z.number().int().positive().default(30),
  cvarTailAlpha: z.number().positive().max(0.5).default(0.2),
  consecutiveLossDaysLimit: z.number().int().positive().optional(),
  consecutiveLossPctThreshold: z.number().negative().optional(),
  highVolatilityQuantileCut: z.number().min(0).max(1).optional(),
  capitalScaleRules: z
    .array(
      z.object({
        stage: z.string().min(1),
        maxOpenPositions: z.number().int().positive().optional(),
        maxLeverage: z.number().positive().optional(),
        maxOrderUsd: z.number().positive().optional(),
        maxPositionPctOfEquity: z.number().positive().max(100).optional(),
        highVolatilityMaxLeverage: z.number().positive().optional(),
      })
    )
    .optional(),
});

const defaultNewsSources = [
  {
    id: "coindesk_rss",
    enabled: true,
    type: "rss",
    source: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    timeoutMs: 5000,
    maxItems: 80,
    category: "institutional-news",
    priority: 0.9,
  },
  {
    id: "cointelegraph_rss",
    enabled: true,
    type: "rss",
    source: "Cointelegraph",
    url: "https://cointelegraph.com/rss",
    timeoutMs: 5000,
    maxItems: 80,
    category: "institutional-news",
    priority: 0.85,
  },
  {
    id: "sec_press_rss",
    enabled: true,
    type: "rss",
    source: "SEC",
    url: "https://www.sec.gov/news/pressreleases.rss",
    timeoutMs: 5000,
    maxItems: 40,
    category: "regulatory-news",
    priority: 1.0,
  },
  {
    id: "federal_reserve_rss",
    enabled: true,
    type: "rss",
    source: "FederalReserve",
    url: "https://www.federalreserve.gov/feeds/press_all.xml",
    timeoutMs: 5000,
    maxItems: 40,
    category: "macro-news",
    priority: 0.95,
  },
] as const;

const newsSourceSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  type: z.literal("rss").default("rss"),
  source: z.string().min(1),
  url: z.string().url(),
  timeoutMs: z.number().int().positive().max(30_000).default(5000),
  maxItems: z.number().int().positive().max(200).default(80),
  category: z.string().default("institutional-news"),
  priority: z.number().min(0).max(1).default(0.8),
});

const newsSchema = z.object({
  enabled: z.boolean().default(true),
  lookbackHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 14)
    .default(72),
  maxTotalItems: z.number().int().min(50).max(5000).default(800),
  dedupeByTitleHours: z.number().int().min(1).max(48).default(6),
  requestTimeoutMs: z.number().int().min(1000).max(30_000).default(6000),
  dotApiSourcePriority: z.number().min(0).max(1.5).default(0.75),
  sources: z
    .array(newsSourceSchema)
    .default(
      defaultNewsSources as unknown as z.infer<typeof newsSourceSchema>[]
    ),
});

const activeHoursSchema = z
  .object({
    start: z.string().regex(/^\d{1,2}:\d{2}$/, "Expected HH:MM format"),
    end: z.string().regex(/^\d{1,2}:\d{2}$/, "Expected HH:MM format"),
    timezone: z.string().default("local"),
  })
  .nullable()
  .default(null);


const connectorsSchema = z.object({
  web: z.object({
    port: z.number().int().positive().default(3002),
    allowOrigins: z.array(z.string()).default([]),
    maxSseClients: z.number().int().positive().max(1000).default(100),
    sseMaxDurationMs: z.number().int().positive().max(86_400_000).default(900_000),
  }).default({
    port: 3002,
    allowOrigins: [],
    maxSseClients: 100,
    sseMaxDurationMs: 900_000,
  }),
  mcp: z.object({
    port: z.number().int().positive().default(3001),
    allowOrigins: z.array(z.string()).default([]),
  }).default({ port: 3001, allowOrigins: [] }),
  mcpAsk: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().optional(),
    allowOrigins: z.array(z.string()).default([]),
  }).default({ enabled: false, allowOrigins: [] }),
  telegram: z.object({
    enabled: z.boolean().default(false),
    botToken: z.string().optional(),
    botUsername: z.string().optional(),
    chatIds: z.array(z.number()).default([]),
  }).default({ enabled: false, chatIds: [] }),
})

const heartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  every: z.string().default("30m"),
  prompt: z
    .string()
    .default(
      "Read data/brain/heartbeat.md (or data/default/heartbeat.default.md if not found) and follow the instructions inside."
    ),
  activeHours: activeHoursSchema,
});

const authSchema = z
  .object({
    /** If true, auth is enforced even if env tokens are not set (rejects all). */
    enforceAuth: z.boolean().default(true),
    /** Token TTL for session tokens (future use). */
    sessionTtlMs: z.number().int().positive().default(86_400_000),
  })
  .default({ enforceAuth: true, sessionTtlMs: 86_400_000 });

const decisionTicketSchema = z
  .object({
    /** Whether decision tickets are required before trade execution. */
    required: z.boolean().default(true),
    /** Ticket TTL in ms (default: 10 minutes). */
    ttlMs: z.number().int().positive().default(600_000),
  })
  .default({ required: true, ttlMs: 600_000 });

const killSwitchSchema = z
  .object({
    /** Default policy when kill switch is triggered. */
    defaultPolicy: z
      .enum(["block_new_only", "block_all"])
      .default("block_new_only"),
  })
  .default({ defaultPolicy: "block_new_only" });

const slippageSchema = z
  .object({
    /** Max slippage percentage for normal orders. */
    maxSlippagePct: z.number().min(0).max(1).default(0.005),
    /** Multiplier for reduceOnly slippage tolerance. */
    reduceOnlyMultiplier: z.number().min(1).max(10).default(2),
  })
  .default({ maxSlippagePct: 0.005, reduceOnlyMultiplier: 2 });

const reconciliationSchema = z
  .object({
    /** Interval in ms between reconciliation checks. */
    intervalMs: z.number().int().positive().default(900_000),
    /** Threshold percentage for position mismatch. */
    thresholdPct: z.number().min(0).max(1).default(0.05),
    /** Number of consecutive breaches to trigger alert. */
    consecutiveBreaches: z.number().int().positive().default(3),
    /** Window size for consecutive breach check. */
    windowSize: z.number().int().positive().default(5),
  })
  .default({
    intervalMs: 900_000,
    thresholdPct: 0.05,
    consecutiveBreaches: 3,
    windowSize: 5,
  });

const reviewGateSchema = z
  .object({
    enabled: z.boolean().default(true),
    blockSeverities: z
      .array(z.enum(["critical", "high", "medium", "low"]))
      .default(["critical", "high"]),
    scope: z
      .enum(["repo_full_scan_once_then_changed_files", "repo_full_scan", "changed_only"])
      .default("repo_full_scan_once_then_changed_files"),
    reportPath: z.string().default("logs/review/latest.json"),
  })
  .default({
    enabled: true,
    blockSeverities: ["critical", "high"],
    scope: "repo_full_scan_once_then_changed_files",
    reportPath: "logs/review/latest.json",
  });

const shutdownSchema = z
  .object({
    /** Max drain wait time in ms. */
    drainTimeoutMs: z.number().int().positive().default(5_000),
  })
  .default({ drainTimeoutMs: 5_000 });

export const toolsSchema = z.object({
  /** Tool names that are disabled. Tools not listed are enabled by default. */
  disabled: z.array(z.string()).default([]),
})

// ==================== Unified Config Type ====================

export type Config = {
  engine: z.infer<typeof engineSchema>
  agent: z.infer<typeof agentSchema>
  crypto: z.infer<typeof cryptoSchema>
  securities: z.infer<typeof securitiesSchema>
  openbb: z.infer<typeof openbbSchema>
  compaction: z.infer<typeof compactionSchema>
  risk: z.infer<typeof riskSchema>
  news: z.infer<typeof newsSchema>
  aiProvider: z.infer<typeof aiProviderSchema>
  auth: z.infer<typeof authSchema>
  decisionTicket: z.infer<typeof decisionTicketSchema>
  killSwitch: z.infer<typeof killSwitchSchema>
  slippage: z.infer<typeof slippageSchema>
  reconciliation: z.infer<typeof reconciliationSchema>
  reviewGate: z.infer<typeof reviewGateSchema>
  shutdown: z.infer<typeof shutdownSchema>
  heartbeat: z.infer<typeof heartbeatSchema>
  connectors: z.infer<typeof connectorsSchema>
  newsCollector: z.infer<typeof newsCollectorSchema>
  tools: z.infer<typeof toolsSchema>
}

// ==================== Loader ====================

/** Read a JSON config file. Returns undefined if file does not exist. */
async function loadJsonFile(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(resolve(CONFIG_DIR, filename), "utf-8"));
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw err;
  }
}

/** Silently remove a config file (ignore if missing). */
async function removeJsonFile(filename: string): Promise<void> {
  try { await unlink(resolve(CONFIG_DIR, filename)) } catch { /* ENOENT ok */ }
}

function readFirstEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function sanitizeSecretsForClient(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSecretsForClient(item, parentKey));
  }
  if (!value || typeof value !== "object") {
    if (
      typeof value === "string" &&
      (parentKey === "apiKeys" || parentKey === "providerKeys")
    ) {
      return REDACTED_SECRET;
    }
    return value;
  }

  const secretFields = new Set([
    "apiKey",
    "apiSecret",
    "secretKey",
    "password",
    "botToken",
  ]);

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => {
      if (secretFields.has(key)) {
        if (typeof child === "string" && child.length > 0) {
          return [key, REDACTED_SECRET];
        }
        return [key, child];
      }

      if (
        (key === "apiKeys" || key === "providerKeys") &&
        child &&
        typeof child === "object"
      ) {
        return [key, sanitizeSecretsForClient(child, key)];
      }

      return [key, sanitizeSecretsForClient(child, key)];
    }),
  );
}

function stripSecretsForPersistence(
  section: ConfigSection,
  value: unknown,
): unknown {
  if (section === "crypto" && value && typeof value === "object") {
    const crypto = value as z.infer<typeof cryptoSchema>;
    if (crypto.provider.type === "ccxt") {
      return {
        ...crypto,
        provider: {
          ...crypto.provider,
          apiKey: undefined,
          apiSecret: undefined,
          password: undefined,
        },
      };
    }
  }

  if (section === "securities" && value && typeof value === "object") {
    const securities = value as z.infer<typeof securitiesSchema>;
    if (securities.provider.type === "alpaca") {
      return {
        ...securities,
        provider: {
          ...securities.provider,
          apiKey: undefined,
          secretKey: undefined,
        },
      };
    }
  }

  if (section === "aiProvider" && value && typeof value === "object") {
    const aiProvider = value as z.infer<typeof aiProviderSchema>;
    return {
      ...aiProvider,
      apiKeys: {},
    };
  }

  if (section === "connectors" && value && typeof value === "object") {
    const connectors = value as z.infer<typeof connectorsSchema>;
    return {
      ...connectors,
      telegram: {
        ...connectors.telegram,
        botToken: undefined,
      },
    };
  }

  return value;
}

function hydrateSecrets(config: Config): Config {
  const aiProvider = {
    ...config.aiProvider,
    apiKeys: {
      anthropic:
        config.aiProvider.apiKeys.anthropic ??
        readFirstEnv("ANTHROPIC_API_KEY"),
      openai:
        config.aiProvider.apiKeys.openai ??
        readFirstEnv("OPENAI_API_KEY"),
      google:
        config.aiProvider.apiKeys.google ??
        readFirstEnv("GOOGLE_API_KEY"),
    },
  };

  const crypto =
    config.crypto.provider.type === "ccxt"
      ? {
          ...config.crypto,
          provider: {
            ...config.crypto.provider,
            apiKey:
              config.crypto.provider.apiKey ??
              readFirstEnv("EXCHANGE_API_KEY"),
            apiSecret:
              config.crypto.provider.apiSecret ??
              readFirstEnv("EXCHANGE_API_SECRET"),
            password:
              config.crypto.provider.password ??
              readFirstEnv("EXCHANGE_PASSWORD"),
          },
        }
      : config.crypto;

  const securities =
    config.securities.provider.type === "alpaca"
      ? {
          ...config.securities,
          provider: {
            ...config.securities.provider,
            apiKey:
              config.securities.provider.apiKey ??
              readFirstEnv("ALPACA_API_KEY"),
            secretKey:
              config.securities.provider.secretKey ??
              readFirstEnv("ALPACA_SECRET_KEY"),
          },
        }
      : config.securities;

  const connectors = {
    ...config.connectors,
    telegram: {
      ...config.connectors.telegram,
      botToken:
        config.connectors.telegram.botToken ??
        readFirstEnv("TELEGRAM_BOT_TOKEN"),
    },
  };

  return {
    ...config,
    aiProvider,
    crypto,
    securities,
    connectors,
  };
}

export function sanitizeConfigForClient(config: Config): unknown {
  return sanitizeSecretsForClient(config);
}

export function sanitizeConfigSectionForClient(value: unknown): unknown {
  return sanitizeSecretsForClient(value);
}

/** Parse with Zod; if the file was missing, seed it to disk with defaults. */
async function parseAndSeed<T>(
  filename: string,
  schema: z.ZodType<T>,
  raw: unknown | undefined
): Promise<T> {
  const parsed = schema.parse(raw ?? {});
  if (raw === undefined) {
    await mkdir(CONFIG_DIR, { recursive: true });
    await writeFile(
      resolve(CONFIG_DIR, filename),
      JSON.stringify(parsed, null, 2) + "\n"
    );
  }
  return parsed;
}

export async function loadConfig(): Promise<Config> {
  const files = [
    'engine.json',
    'agent.json',
    'crypto.json',
    'securities.json',
    'openbb.json',
    'compaction.json',
    'risk.json',
    'news.json',
    'ai-provider.json',
    'auth.json',
    'decision-ticket.json',
    'kill-switch.json',
    'slippage.json',
    'reconciliation.json',
    'review-gate.json',
    'shutdown.json',
    'heartbeat.json',
    'connectors.json',
    'news-collector.json',
    'tools.json',
  ] as const
  const raws = await Promise.all(files.map((f) => loadJsonFile(f)))

  // ---------- Migration: consolidate old ai-provider + model + api-keys → ai-provider ----------
  const aiProviderRaw = raws[8] as Record<string, unknown> | undefined
  if (aiProviderRaw && !('backend' in aiProviderRaw)) {
    // Old format detected — merge model.json + api-keys.json into ai-provider.json
    const oldModel = await loadJsonFile('model.json') as Record<string, unknown> | undefined
    const oldKeys = await loadJsonFile('api-keys.json') as Record<string, unknown> | undefined
    const migrated = {
      backend: aiProviderRaw.provider ?? 'claude-code',
      provider: oldModel?.provider ?? 'anthropic',
      model: oldModel?.model ?? 'claude-sonnet-4-6',
      ...(oldModel?.baseUrl ? { baseUrl: oldModel.baseUrl } : {}),
      apiKeys: oldKeys ?? {},
    }
    raws[8] = migrated
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'ai-provider.json'), JSON.stringify(migrated, null, 2) + '\n')
    await removeJsonFile('model.json')
    await removeJsonFile('api-keys.json')
  }

  // ---------- Migration: consolidate old telegram.json + engine port fields ----------
  const connectorsRaw = raws[17] as Record<string, unknown> | undefined
  if (connectorsRaw === undefined) {
    const oldTelegram = await loadJsonFile('telegram.json')
    const oldEngine = raws[0] as Record<string, unknown> | undefined
    const migrated: Record<string, unknown> = {}
    if (oldTelegram && typeof oldTelegram === 'object') {
      migrated.telegram = { ...(oldTelegram as Record<string, unknown>), enabled: true }
    }
    if (oldEngine) {
      if (oldEngine.webPort !== undefined) migrated.web = { port: oldEngine.webPort }
      if (oldEngine.mcpPort !== undefined) migrated.mcp = { port: oldEngine.mcpPort }
      if (oldEngine.askMcpPort !== undefined) migrated.mcpAsk = { enabled: true, port: oldEngine.askMcpPort }
      const { mcpPort: _m, askMcpPort: _a, webPort: _w, ...cleanEngine } = oldEngine
      raws[0] = cleanEngine
      await mkdir(CONFIG_DIR, { recursive: true })
      await writeFile(resolve(CONFIG_DIR, 'engine.json'), JSON.stringify(cleanEngine, null, 2) + '\n')
    }
    raws[17] = Object.keys(migrated).length > 0 ? migrated : undefined
  }

  const parsedConfig: Config = {
    engine:        await parseAndSeed(files[0], engineSchema, raws[0]),
    agent:         await parseAndSeed(files[1], agentSchema, raws[1]),
    crypto:        await parseAndSeed(files[2], cryptoSchema, raws[2]),
    securities:    await parseAndSeed(files[3], securitiesSchema, raws[3]),
    openbb:        await parseAndSeed(files[4], openbbSchema, raws[4]),
    compaction:    await parseAndSeed(files[5], compactionSchema, raws[5]),
    risk:          await parseAndSeed(files[6], riskSchema, raws[6]),
    news:          await parseAndSeed(files[7], newsSchema, raws[7]),
    aiProvider:    await parseAndSeed(files[8], aiProviderSchema, raws[8]),
    auth:          await parseAndSeed(files[9], authSchema, raws[9]),
    decisionTicket: await parseAndSeed(files[10], decisionTicketSchema, raws[10]),
    killSwitch:    await parseAndSeed(files[11], killSwitchSchema, raws[11]),
    slippage:      await parseAndSeed(files[12], slippageSchema, raws[12]),
    reconciliation: await parseAndSeed(files[13], reconciliationSchema, raws[13]),
    reviewGate:    await parseAndSeed(files[14], reviewGateSchema, raws[14]),
    shutdown:      await parseAndSeed(files[15], shutdownSchema, raws[15]),
    heartbeat:     await parseAndSeed(files[16], heartbeatSchema, raws[16]),
    connectors:    await parseAndSeed(files[17], connectorsSchema, raws[17]),
    newsCollector: await parseAndSeed(files[18], newsCollectorSchema, raws[18]),
    tools:         await parseAndSeed(files[19], toolsSchema, raws[19]),
  }

  return hydrateSecrets(parsedConfig)
}

// ==================== Hot-read helpers ====================

/** Read agent config from disk (called per-request for hot-reload). */
export async function readAgentConfig() {
  try {
    const raw = JSON.parse(
      await readFile(resolve(CONFIG_DIR, "agent.json"), "utf-8")
    );
    return agentSchema.parse(raw);
  } catch {
    return agentSchema.parse({});
  }
}

/** Read AI provider config from disk (called per-request for hot-reload). */
export async function readAIProviderConfig() {
  try {
    const raw = JSON.parse(await readFile(resolve(CONFIG_DIR, 'ai-provider.json'), 'utf-8'))
    return hydrateSecrets({
      engine: engineSchema.parse({}),
      agent: agentSchema.parse({}),
      crypto: cryptoSchema.parse({}),
      securities: securitiesSchema.parse({}),
      openbb: openbbSchema.parse({}),
      compaction: compactionSchema.parse({}),
      risk: riskSchema.parse({}),
      news: newsSchema.parse({}),
      aiProvider: aiProviderSchema.parse(raw),
      auth: authSchema.parse({}),
      decisionTicket: decisionTicketSchema.parse({}),
      killSwitch: killSwitchSchema.parse({}),
      slippage: slippageSchema.parse({}),
      reconciliation: reconciliationSchema.parse({}),
      reviewGate: reviewGateSchema.parse({}),
      shutdown: shutdownSchema.parse({}),
      heartbeat: heartbeatSchema.parse({}),
      connectors: connectorsSchema.parse({}),
      newsCollector: newsCollectorSchema.parse({}),
      tools: toolsSchema.parse({}),
    }).aiProvider
  } catch {
    return hydrateSecrets({
      engine: engineSchema.parse({}),
      agent: agentSchema.parse({}),
      crypto: cryptoSchema.parse({}),
      securities: securitiesSchema.parse({}),
      openbb: openbbSchema.parse({}),
      compaction: compactionSchema.parse({}),
      risk: riskSchema.parse({}),
      news: newsSchema.parse({}),
      aiProvider: aiProviderSchema.parse({}),
      auth: authSchema.parse({}),
      decisionTicket: decisionTicketSchema.parse({}),
      killSwitch: killSwitchSchema.parse({}),
      slippage: slippageSchema.parse({}),
      reconciliation: reconciliationSchema.parse({}),
      reviewGate: reviewGateSchema.parse({}),
      shutdown: shutdownSchema.parse({}),
      heartbeat: heartbeatSchema.parse({}),
      connectors: connectorsSchema.parse({}),
      newsCollector: newsCollectorSchema.parse({}),
      tools: toolsSchema.parse({}),
    }).aiProvider
  }
}

/** Read OpenBB config from disk (called per-request for hot-reload). */
export async function readOpenbbConfig() {
  try {
    const raw = JSON.parse(await readFile(resolve(CONFIG_DIR, 'openbb.json'), 'utf-8'))
    return openbbSchema.parse(raw)
  } catch {
    return openbbSchema.parse({})
  }
}

/** Read tools config from disk (called per-request for hot-reload). */
export async function readToolsConfig() {
  try {
    const raw = JSON.parse(await readFile(resolve(CONFIG_DIR, 'tools.json'), 'utf-8'))
    return toolsSchema.parse(raw)
  } catch {
    return toolsSchema.parse({})
  }
}

// ==================== Writer ====================

export type ConfigSection = keyof Config;

const sectionSchemas: Record<ConfigSection, z.ZodTypeAny> = {
  engine: engineSchema,
  agent: agentSchema,
  crypto: cryptoSchema,
  securities: securitiesSchema,
  openbb: openbbSchema,
  compaction: compactionSchema,
  risk: riskSchema,
  news: newsSchema,
  aiProvider: aiProviderSchema,
  auth: authSchema,
  decisionTicket: decisionTicketSchema,
  killSwitch: killSwitchSchema,
  slippage: slippageSchema,
  reconciliation: reconciliationSchema,
  reviewGate: reviewGateSchema,
  shutdown: shutdownSchema,
  heartbeat: heartbeatSchema,
  connectors: connectorsSchema,
  newsCollector: newsCollectorSchema,
  tools: toolsSchema,
}

const sectionFiles: Record<ConfigSection, string> = {
  engine: 'engine.json',
  agent: 'agent.json',
  crypto: 'crypto.json',
  securities: 'securities.json',
  openbb: 'openbb.json',
  compaction: 'compaction.json',
  risk: 'risk.json',
  news: 'news.json',
  aiProvider: 'ai-provider.json',
  auth: 'auth.json',
  decisionTicket: 'decision-ticket.json',
  killSwitch: 'kill-switch.json',
  slippage: 'slippage.json',
  reconciliation: 'reconciliation.json',
  reviewGate: 'review-gate.json',
  shutdown: 'shutdown.json',
  heartbeat: 'heartbeat.json',
  connectors: 'connectors.json',
  newsCollector: 'news-collector.json',
  tools: 'tools.json',
}

/** All valid config section names (derived from sectionSchemas). */
export const validSections = Object.keys(sectionSchemas) as ConfigSection[]

/** Validate and write a config section to disk. Returns the validated config. */
export async function writeConfigSection(
  section: ConfigSection,
  data: unknown
): Promise<unknown> {
  const schema = sectionSchemas[section];
  const validated = schema.parse(data);
  const persisted = stripSecretsForPersistence(section, validated);
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(
    resolve(CONFIG_DIR, sectionFiles[section]),
    JSON.stringify(persisted, null, 2) + "\n"
  );
  return persisted;
}
