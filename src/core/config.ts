import { z } from 'zod'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { resolve } from 'path'
import { newsCollectorSchema } from '../extension/news-collector/config.js'

const CONFIG_DIR = resolve("data/config");

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
  web: z.object({ port: z.number().int().positive().default(3002) }).default({ port: 3002 }),
  mcp: z.object({
    port: z.number().int().positive().default(3001),
  }).default({ port: 3001 }),
  mcpAsk: z.object({
    enabled: z.boolean().default(false),
    port: z.number().int().positive().optional(),
  }).default({ enabled: false }),
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
    enforceAuth: z.boolean().default(false),
    /** Token TTL for session tokens (future use). */
    sessionTtlMs: z.number().int().positive().default(86_400_000),
  })
  .default({ enforceAuth: false, sessionTtlMs: 86_400_000 });

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
  aiProvider: z.infer<typeof aiProviderSchema>
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
  const files = ['engine.json', 'agent.json', 'crypto.json', 'securities.json', 'openbb.json', 'compaction.json', 'ai-provider.json', 'heartbeat.json', 'connectors.json', 'news-collector.json', 'tools.json'] as const
  const raws = await Promise.all(files.map((f) => loadJsonFile(f)))

  // ---------- Migration: consolidate old ai-provider + model + api-keys → ai-provider ----------
  const aiProviderRaw = raws[6] as Record<string, unknown> | undefined
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
    raws[6] = migrated
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'ai-provider.json'), JSON.stringify(migrated, null, 2) + '\n')
    await removeJsonFile('model.json')
    await removeJsonFile('api-keys.json')
  }

  // ---------- Migration: consolidate old telegram.json + engine port fields ----------
  const connectorsRaw = raws[8] as Record<string, unknown> | undefined
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
    raws[8] = Object.keys(migrated).length > 0 ? migrated : undefined
  }

  return {
    engine:        await parseAndSeed(files[0], engineSchema, raws[0]),
    agent:         await parseAndSeed(files[1], agentSchema, raws[1]),
    crypto:        await parseAndSeed(files[2], cryptoSchema, raws[2]),
    securities:    await parseAndSeed(files[3], securitiesSchema, raws[3]),
    openbb:        await parseAndSeed(files[4], openbbSchema, raws[4]),
    compaction:    await parseAndSeed(files[5], compactionSchema, raws[5]),
    aiProvider:    await parseAndSeed(files[6], aiProviderSchema, raws[6]),
    heartbeat:     await parseAndSeed(files[7], heartbeatSchema, raws[7]),
    connectors:    await parseAndSeed(files[8], connectorsSchema, raws[8]),
    newsCollector: await parseAndSeed(files[9], newsCollectorSchema, raws[9]),
    tools:         await parseAndSeed(files[10], toolsSchema, raws[10]),
  }
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
    return aiProviderSchema.parse(raw)
  } catch {
    return aiProviderSchema.parse({})
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
  aiProvider: 'ai-provider.json',
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
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(
    resolve(CONFIG_DIR, sectionFiles[section]),
    JSON.stringify(validated, null, 2) + "\n"
  );
  return validated;
}
