import { z } from "zod";
import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve } from "path";

const CONFIG_DIR = resolve("data/config");

// ==================== Individual Schemas ====================

const engineSchema = z.object({
  pairs: z.array(z.string()).min(1).default(["BTC/USD", "ETH/USD", "SOL/USD"]),
  interval: z.number().int().positive().default(5000),
  port: z.number().int().positive().default(3000),
  mcpPort: z.number().int().positive().default(3001),
  askMcpPort: z.number().int().positive().optional(),
  webPort: z.number().int().positive().default(3002),
  timeframe: z.string().default("1h"),
  dataRefreshInterval: z.number().int().positive().default(600_000),
});

const modelSchema = z.object({
  provider: z.string().default("anthropic"),
  model: z.string().default("claude-sonnet-4-5-20250929"),
  baseURL: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  codexConfigPath: z.string().optional(),
  codexProvider: z.string().optional(),
});

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
  allowedSymbols: z
    .array(z.string())
    .min(1)
    .default([
      "BTC/USD",
      "ETH/USD",
      "SOL/USD",
      "BNB/USD",
      "APT/USD",
      "SUI/USD",
      "HYPE/USD",
      "DOGE/USD",
      "XRP/USD",
    ]),
  provider: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("ccxt"),
        exchange: z.string(),
        sandbox: z.boolean().default(false),
        demoTrading: z.boolean().default(false),
        defaultMarketType: z.enum(["spot", "swap"]).default("swap"),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
      z.object({
        type: z.literal("none"),
      }),
    ])
    .default({
      type: "ccxt",
      exchange: "bybit",
      sandbox: false,
      demoTrading: true,
      defaultMarketType: "swap",
    }),
});

const securitiesSchema = z.object({
  allowedSymbols: z
    .array(z.string())
    .default([
      "AAPL",
      "MSFT",
      "GOOGL",
      "AMZN",
      "NVDA",
      "META",
      "TSLA",
      "SPY",
      "QQQ",
    ]),
  provider: z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("alpaca"),
        paper: z.boolean().default(true),
      }),
      z.object({
        type: z.literal("none"),
      }),
    ])
    .default({ type: "alpaca", paper: true }),
});

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

export const aiProviderSchema = z.object({
  provider: z.enum(["claude-code", "vercel-ai-sdk"]).default("claude-code"),
});

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

// ==================== Unified Config Type ====================

export type Config = {
  engine: z.infer<typeof engineSchema>;
  model: z.infer<typeof modelSchema>;
  agent: z.infer<typeof agentSchema>;
  crypto: z.infer<typeof cryptoSchema>;
  securities: z.infer<typeof securitiesSchema>;
  compaction: z.infer<typeof compactionSchema>;
  risk: z.infer<typeof riskSchema>;
  news: z.infer<typeof newsSchema>;
  aiProvider: z.infer<typeof aiProviderSchema>;
  heartbeat: z.infer<typeof heartbeatSchema>;
  auth: z.infer<typeof authSchema>;
  decisionTicket: z.infer<typeof decisionTicketSchema>;
  killSwitch: z.infer<typeof killSwitchSchema>;
  slippage: z.infer<typeof slippageSchema>;
  reconciliation: z.infer<typeof reconciliationSchema>;
  reviewGate: z.infer<typeof reviewGateSchema>;
  shutdown: z.infer<typeof shutdownSchema>;
};

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
    "engine.json",
    "model.json",
    "agent.json",
    "crypto.json",
    "securities.json",
    "compaction.json",
    "risk.json",
    "news.json",
    "ai-provider.json",
    "heartbeat.json",
    "auth.json",
    "decision-ticket.json",
    "kill-switch.json",
    "slippage.json",
    "reconciliation.json",
    "review-gate.json",
    "shutdown.json",
  ] as const;
  const raws = await Promise.all(files.map(f => loadJsonFile(f)));

  return {
    engine: await parseAndSeed(files[0], engineSchema, raws[0]),
    model: await parseAndSeed(files[1], modelSchema, raws[1]),
    agent: await parseAndSeed(files[2], agentSchema, raws[2]),
    crypto: await parseAndSeed(files[3], cryptoSchema, raws[3]),
    securities: await parseAndSeed(files[4], securitiesSchema, raws[4]),
    compaction: await parseAndSeed(files[5], compactionSchema, raws[5]),
    risk: await parseAndSeed(files[6], riskSchema, raws[6]),
    news: await parseAndSeed(files[7], newsSchema, raws[7]),
    aiProvider: await parseAndSeed(files[8], aiProviderSchema, raws[8]),
    heartbeat: await parseAndSeed(files[9], heartbeatSchema, raws[9]),
    auth: await parseAndSeed(files[10], authSchema, raws[10]),
    decisionTicket: await parseAndSeed(
      files[11],
      decisionTicketSchema,
      raws[11]
    ),
    killSwitch: await parseAndSeed(files[12], killSwitchSchema, raws[12]),
    slippage: await parseAndSeed(files[13], slippageSchema, raws[13]),
    reconciliation: await parseAndSeed(
      files[14],
      reconciliationSchema,
      raws[14]
    ),
    reviewGate: await parseAndSeed(files[15], reviewGateSchema, raws[15]),
    shutdown: await parseAndSeed(files[16], shutdownSchema, raws[16]),
  };
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

// ==================== Writer ====================

export type ConfigSection = keyof Config;

const sectionSchemas: Record<ConfigSection, z.ZodTypeAny> = {
  engine: engineSchema,
  model: modelSchema,
  agent: agentSchema,
  crypto: cryptoSchema,
  securities: securitiesSchema,
  compaction: compactionSchema,
  risk: riskSchema,
  news: newsSchema,
  aiProvider: aiProviderSchema,
  heartbeat: heartbeatSchema,
  auth: authSchema,
  decisionTicket: decisionTicketSchema,
  killSwitch: killSwitchSchema,
  slippage: slippageSchema,
  reconciliation: reconciliationSchema,
  reviewGate: reviewGateSchema,
  shutdown: shutdownSchema,
};

const sectionFiles: Record<ConfigSection, string> = {
  engine: "engine.json",
  model: "model.json",
  agent: "agent.json",
  crypto: "crypto.json",
  securities: "securities.json",
  compaction: "compaction.json",
  risk: "risk.json",
  news: "news.json",
  aiProvider: "ai-provider.json",
  heartbeat: "heartbeat.json",
  auth: "auth.json",
  decisionTicket: "decision-ticket.json",
  killSwitch: "kill-switch.json",
  slippage: "slippage.json",
  reconciliation: "reconciliation.json",
  reviewGate: "review-gate.json",
  shutdown: "shutdown.json",
};

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
