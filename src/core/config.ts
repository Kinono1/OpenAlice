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
  timeframe: z.string().default("1h"),
  dataRefreshInterval: z.number().int().positive().default(600_000),
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
  allowedSymbols: z.array(z.string()).default(["BTC/USD", "ETH/USD", "SOL/USD"]),
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

const canarySchema = z
  .object({
    enabled: z.boolean().default(true),
    statePath: z.string().default("data/runtime/canary_state.json"),
    paper: z
      .object({
        observationMinMinutes: z.number().int().positive().default(1440),
        maxHeartbeatErrors: z.number().int().min(0).default(0),
        maxGateCircuitOpen: z.number().int().min(0).default(0),
        maxCronPaused: z.number().int().min(0).default(0),
        maxPnlReconciliationAlerts: z.number().int().min(0).default(0),
        maxPaperExecutorFailures: z.number().int().min(0).default(0),
        maxIdempotencyDuplicates: z.number().int().min(0).default(0),
        maxPendingOrderAgeMinutes: z.number().int().positive().default(15),
      })
      .default({
        observationMinMinutes: 1440,
        maxHeartbeatErrors: 0,
        maxGateCircuitOpen: 0,
        maxCronPaused: 0,
        maxPnlReconciliationAlerts: 0,
        maxPaperExecutorFailures: 0,
        maxIdempotencyDuplicates: 0,
        maxPendingOrderAgeMinutes: 15,
      }),
    microLive: z
      .object({
        maxSymbols: z.number().int().positive().default(1),
        maxConcurrentOpens: z.number().int().positive().default(1),
        maxNotionalUsd: z.number().positive().default(25),
        maxEquityPct: z.number().positive().max(100).default(0.25),
        observationMinMinutes: z.number().int().positive().default(240),
        maxHeartbeatErrors: z.number().int().min(0).default(0),
        maxGateCircuitOpen: z.number().int().min(0).default(0),
        maxCronPaused: z.number().int().min(0).default(0),
        maxPnlReconciliationAlerts: z.number().int().min(0).default(0),
        maxIdempotencyDuplicates: z.number().int().min(0).default(0),
        maxStalePendingOrderAgeMinutes: z.number().int().positive().default(15),
        approvalTtlHours: z.number().int().positive().default(48),
      })
      .default({
        maxSymbols: 1,
        maxConcurrentOpens: 1,
        maxNotionalUsd: 25,
        maxEquityPct: 0.25,
        observationMinMinutes: 240,
        maxHeartbeatErrors: 0,
        maxGateCircuitOpen: 0,
        maxCronPaused: 0,
        maxPnlReconciliationAlerts: 0,
        maxIdempotencyDuplicates: 0,
        maxStalePendingOrderAgeMinutes: 15,
        approvalTtlHours: 48,
      }),
  })
  .default({
    enabled: true,
    statePath: "data/runtime/canary_state.json",
    paper: {
      observationMinMinutes: 1440,
      maxHeartbeatErrors: 0,
      maxGateCircuitOpen: 0,
      maxCronPaused: 0,
      maxPnlReconciliationAlerts: 0,
      maxPaperExecutorFailures: 0,
      maxIdempotencyDuplicates: 0,
      maxPendingOrderAgeMinutes: 15,
    },
    microLive: {
      maxSymbols: 1,
      maxConcurrentOpens: 1,
      maxNotionalUsd: 25,
      maxEquityPct: 0.25,
      observationMinMinutes: 240,
      maxHeartbeatErrors: 0,
      maxGateCircuitOpen: 0,
      maxCronPaused: 0,
      maxPnlReconciliationAlerts: 0,
      maxIdempotencyDuplicates: 0,
      maxStalePendingOrderAgeMinutes: 15,
      approvalTtlHours: 48,
    },
  });

const researchDeskSchema = z
  .object({
    tradingAgents: z
      .object({
        enabled: z.boolean().default(false),
        workingDirectory: z
          .string()
          .default("../TradingAgents"),
        entrypoint: z
          .string()
          .default("scripts/run_openalice_research_sidecar.py"),
        pythonBin: z.string().optional(),
        timeoutMs: z.number().int().positive().default(180_000),
        noOutputTimeoutMs: z.number().int().positive().default(60_000),
        mode: z.enum(["smoke", "full"]).default("full"),
        selectedAnalysts: z
          .array(
            z.enum(["market", "social", "news", "fundamentals"]),
          )
          .min(1)
          .default(["market", "social", "news", "fundamentals"]),
        researchDepth: z.number().int().min(0).max(5).default(1),
        newsLookback: z.string().default("72h"),
        envAllowlist: z
          .array(z.string().min(1))
          .default([
            "OPENAI_API_KEY",
            "OPENAI_BASE_URL",
            "OPENAI_MODEL",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_BASE_URL",
            "GOOGLE_API_KEY",
            "TRADINGAGENTS_LLM_PROVIDER",
            "TRADINGAGENTS_BACKEND_URL",
            "TRADINGAGENTS_DEEP_MODEL",
            "TRADINGAGENTS_QUICK_MODEL",
            "TRADINGAGENTS_OPENAI_REASONING_EFFORT",
            "TRADINGAGENTS_QUICK_OPENAI_REASONING_EFFORT",
            "TRADINGAGENTS_DEEP_OPENAI_REASONING_EFFORT",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
            "http_proxy",
            "https_proxy",
            "no_proxy",
          ]),
        verdictPath: z
          .string()
          .default("data/research/scorecards/tradingagents_verdict.latest.json"),
        artifactDir: z
          .string()
          .default("data/research"),
      })
      .default({
        enabled: false,
        workingDirectory: "../TradingAgents",
        entrypoint: "scripts/run_openalice_research_sidecar.py",
        timeoutMs: 180_000,
        noOutputTimeoutMs: 60_000,
        mode: "full",
        selectedAnalysts: ["market", "social", "news", "fundamentals"],
        researchDepth: 1,
        newsLookback: "72h",
        envAllowlist: [
          "OPENAI_API_KEY",
          "OPENAI_BASE_URL",
          "OPENAI_MODEL",
          "ANTHROPIC_API_KEY",
          "ANTHROPIC_BASE_URL",
          "GOOGLE_API_KEY",
          "TRADINGAGENTS_LLM_PROVIDER",
          "TRADINGAGENTS_BACKEND_URL",
          "TRADINGAGENTS_DEEP_MODEL",
          "TRADINGAGENTS_QUICK_MODEL",
          "TRADINGAGENTS_OPENAI_REASONING_EFFORT",
          "TRADINGAGENTS_QUICK_OPENAI_REASONING_EFFORT",
          "TRADINGAGENTS_DEEP_OPENAI_REASONING_EFFORT",
          "HTTP_PROXY",
          "HTTPS_PROXY",
          "NO_PROXY",
          "http_proxy",
          "https_proxy",
          "no_proxy",
        ],
        verdictPath: "data/research/scorecards/tradingagents_verdict.latest.json",
        artifactDir: "data/research",
      }),
  })
  .default({
    tradingAgents: {
      enabled: false,
      workingDirectory: "../TradingAgents",
      entrypoint: "scripts/run_openalice_research_sidecar.py",
      timeoutMs: 180_000,
      noOutputTimeoutMs: 60_000,
      mode: "full",
      selectedAnalysts: ["market", "social", "news", "fundamentals"],
      researchDepth: 1,
      newsLookback: "72h",
      envAllowlist: [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "OPENAI_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "GOOGLE_API_KEY",
        "TRADINGAGENTS_LLM_PROVIDER",
        "TRADINGAGENTS_BACKEND_URL",
        "TRADINGAGENTS_DEEP_MODEL",
        "TRADINGAGENTS_QUICK_MODEL",
        "TRADINGAGENTS_OPENAI_REASONING_EFFORT",
        "TRADINGAGENTS_QUICK_OPENAI_REASONING_EFFORT",
        "TRADINGAGENTS_DEEP_OPENAI_REASONING_EFFORT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "no_proxy",
      ],
      verdictPath: "data/research/scorecards/tradingagents_verdict.latest.json",
      artifactDir: "data/research",
    },
  });

const shutdownSchema = z
  .object({
    /** Max drain wait time in ms. */
    drainTimeoutMs: z.number().int().positive().default(5_000),
  })
  .default({ drainTimeoutMs: 5_000 });

const governanceSchema = z.object({
  enabled: z.boolean().default(true),
  fallbackConfigId: z.string().default("H0"),
  releaseGate: z
    .object({
      enabled: z.boolean().default(true),
      statusPath: z.string().default("data/runtime/release_gate_status.json"),
      maxStatusAgeHours: z.number().positive().default(24),
      blockOnExpired: z.boolean().default(true),
    })
    .default({
      enabled: true,
      statusPath: "data/runtime/release_gate_status.json",
      maxStatusAgeHours: 24,
      blockOnExpired: true,
    }),
  liveGate: z
    .object({
      enabled: z.boolean().default(true),
      quoteAgeP95MsMax: z.number().int().positive().default(2_000),
      decisionToSubmitP95MsMax: z.number().int().positive().default(800),
      decisionToFirstFillP95MsMax: z.number().int().positive().default(2_500),
    })
    .default({
      enabled: true,
      quoteAgeP95MsMax: 2_000,
      decisionToSubmitP95MsMax: 800,
      decisionToFirstFillP95MsMax: 2_500,
    }),
  rolloutReadiness: z
    .object({
      enabled: z.boolean().default(true),
      statusPath: z
        .string()
        .default("data/runtime/live_rollout_readiness.latest.json"),
      maxExecutionCostBps: z.number().positive().default(25),
      requireEdgeDecayStable: z.boolean().default(true),
      requirePromotedCandidateVerdict: z.boolean().default(true),
      requirePortfolioTargetsForExecutedOpens: z.boolean().default(true),
    })
    .default({
      enabled: true,
      statusPath: "data/runtime/live_rollout_readiness.latest.json",
      maxExecutionCostBps: 25,
      requireEdgeDecayStable: true,
      requirePromotedCandidateVerdict: true,
      requirePortfolioTargetsForExecutedOpens: true,
    }),
  statsGate: z
    .object({
      fdrQMax: z.number().min(0).max(1).default(0.1),
      transferPassRatioRolling14dMin: z.number().min(0).max(1).default(0.25),
      winnerEligibleRatioRolling14dMin: z.number().min(0).max(1).default(0.35),
      meanPboMax: z.number().min(0).max(1).default(0.2),
      meanDsrProbabilityMin: z.number().min(0).max(1).default(0.5),
    })
    .default({
      fdrQMax: 0.1,
      transferPassRatioRolling14dMin: 0.25,
      winnerEligibleRatioRolling14dMin: 0.35,
      meanPboMax: 0.2,
      meanDsrProbabilityMin: 0.5,
    }),
});

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
  heartbeat: z.infer<typeof heartbeatSchema>
  auth: z.infer<typeof authSchema>
  connectors: z.infer<typeof connectorsSchema>
  newsCollector: z.infer<typeof newsCollectorSchema>
  decisionTicket: z.infer<typeof decisionTicketSchema>
  killSwitch: z.infer<typeof killSwitchSchema>
  slippage: z.infer<typeof slippageSchema>
  reconciliation: z.infer<typeof reconciliationSchema>
  governance: z.infer<typeof governanceSchema>
  canary: z.infer<typeof canarySchema>
  researchDesk: z.infer<typeof researchDeskSchema>
  reviewGate: z.infer<typeof reviewGateSchema>
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
  const filenames = {
    engine: 'engine.json',
    agent: 'agent.json',
    crypto: 'crypto.json',
    securities: 'securities.json',
    openbb: 'openbb.json',
    compaction: 'compaction.json',
    risk: 'risk.json',
    news: 'news.json',
    aiProvider: 'ai-provider.json',
    heartbeat: 'heartbeat.json',
    auth: 'auth.json',
    connectors: 'connectors.json',
    newsCollector: 'news-collector.json',
    decisionTicket: 'decision-ticket.json',
    killSwitch: 'kill-switch.json',
    slippage: 'slippage.json',
    reconciliation: 'reconciliation.json',
    governance: 'governance.json',
    canary: 'canary.json',
    researchDesk: 'research-desk.json',
    reviewGate: 'review-gate.json',
    tools: 'tools.json',
  } as const

  const raws = {
    engine: await loadJsonFile(filenames.engine),
    agent: await loadJsonFile(filenames.agent),
    crypto: await loadJsonFile(filenames.crypto),
    securities: await loadJsonFile(filenames.securities),
    openbb: await loadJsonFile(filenames.openbb),
    compaction: await loadJsonFile(filenames.compaction),
    risk: await loadJsonFile(filenames.risk),
    news: await loadJsonFile(filenames.news),
    aiProvider: await loadJsonFile(filenames.aiProvider),
    heartbeat: await loadJsonFile(filenames.heartbeat),
    auth: await loadJsonFile(filenames.auth),
    connectors: await loadJsonFile(filenames.connectors),
    newsCollector: await loadJsonFile(filenames.newsCollector),
    decisionTicket: await loadJsonFile(filenames.decisionTicket),
    killSwitch: await loadJsonFile(filenames.killSwitch),
    slippage: await loadJsonFile(filenames.slippage),
    reconciliation: await loadJsonFile(filenames.reconciliation),
    governance: await loadJsonFile(filenames.governance),
    canary: await loadJsonFile(filenames.canary),
    researchDesk: await loadJsonFile(filenames.researchDesk),
    reviewGate: await loadJsonFile(filenames.reviewGate),
    tools: await loadJsonFile(filenames.tools),
  }

  // ---------- Migration: consolidate old ai-provider + model + api-keys → ai-provider ----------
  const aiProviderRaw = raws.aiProvider as Record<string, unknown> | undefined
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
    raws.aiProvider = migrated
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'ai-provider.json'), JSON.stringify(migrated, null, 2) + '\n')
    await removeJsonFile('model.json')
    await removeJsonFile('api-keys.json')
  }

  // ---------- Migration: consolidate old telegram.json + engine port fields ----------
  const connectorsRaw = raws.connectors as Record<string, unknown> | undefined
  if (connectorsRaw === undefined) {
    const oldTelegram = await loadJsonFile('telegram.json')
    const oldEngine = raws.engine as Record<string, unknown> | undefined
    const migrated: Record<string, unknown> = {}
    if (oldTelegram && typeof oldTelegram === 'object') {
      migrated.telegram = { ...(oldTelegram as Record<string, unknown>), enabled: true }
    }
    if (oldEngine) {
      if (oldEngine.webPort !== undefined) migrated.web = { port: oldEngine.webPort }
      if (oldEngine.mcpPort !== undefined) migrated.mcp = { port: oldEngine.mcpPort }
      if (oldEngine.askMcpPort !== undefined) migrated.mcpAsk = { enabled: true, port: oldEngine.askMcpPort }
      const { mcpPort: _m, askMcpPort: _a, webPort: _w, ...cleanEngine } = oldEngine
      raws.engine = cleanEngine
      await mkdir(CONFIG_DIR, { recursive: true })
      await writeFile(resolve(CONFIG_DIR, 'engine.json'), JSON.stringify(cleanEngine, null, 2) + '\n')
    }
    raws.connectors = Object.keys(migrated).length > 0 ? migrated : undefined
  }

  return {
    engine:         await parseAndSeed(filenames.engine, engineSchema, raws.engine),
    agent:          await parseAndSeed(filenames.agent, agentSchema, raws.agent),
    crypto:         await parseAndSeed(filenames.crypto, cryptoSchema, raws.crypto),
    securities:     await parseAndSeed(filenames.securities, securitiesSchema, raws.securities),
    openbb:         await parseAndSeed(filenames.openbb, openbbSchema, raws.openbb),
    compaction:     await parseAndSeed(filenames.compaction, compactionSchema, raws.compaction),
    risk:           await parseAndSeed(filenames.risk, riskSchema, raws.risk),
    news:           await parseAndSeed(filenames.news, newsSchema, raws.news),
    aiProvider:     await parseAndSeed(filenames.aiProvider, aiProviderSchema, raws.aiProvider),
    heartbeat:      await parseAndSeed(filenames.heartbeat, heartbeatSchema, raws.heartbeat),
    auth:           await parseAndSeed(filenames.auth, authSchema, raws.auth),
    connectors:     await parseAndSeed(filenames.connectors, connectorsSchema, raws.connectors),
    newsCollector:  await parseAndSeed(filenames.newsCollector, newsCollectorSchema, raws.newsCollector),
    decisionTicket: await parseAndSeed(filenames.decisionTicket, decisionTicketSchema, raws.decisionTicket),
    killSwitch:     await parseAndSeed(filenames.killSwitch, killSwitchSchema, raws.killSwitch),
    slippage:       await parseAndSeed(filenames.slippage, slippageSchema, raws.slippage),
    reconciliation: await parseAndSeed(filenames.reconciliation, reconciliationSchema, raws.reconciliation),
    governance:     await parseAndSeed(filenames.governance, governanceSchema, raws.governance),
    canary:         await parseAndSeed(filenames.canary, canarySchema, raws.canary),
    researchDesk:   await parseAndSeed(filenames.researchDesk, researchDeskSchema, raws.researchDesk),
    reviewGate:     await parseAndSeed(filenames.reviewGate, reviewGateSchema, raws.reviewGate),
    tools:          await parseAndSeed(filenames.tools, toolsSchema, raws.tools),
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
  auth: authSchema,
  connectors: connectorsSchema,
  newsCollector: newsCollectorSchema,
  decisionTicket: decisionTicketSchema,
  killSwitch: killSwitchSchema,
  slippage: slippageSchema,
  reconciliation: reconciliationSchema,
  governance: governanceSchema,
  canary: canarySchema,
  researchDesk: researchDeskSchema,
  reviewGate: reviewGateSchema,
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
  heartbeat: 'heartbeat.json',
  auth: 'auth.json',
  connectors: 'connectors.json',
  newsCollector: 'news-collector.json',
  decisionTicket: 'decision-ticket.json',
  killSwitch: 'kill-switch.json',
  slippage: 'slippage.json',
  reconciliation: 'reconciliation.json',
  governance: 'governance.json',
  canary: 'canary.json',
  researchDesk: 'research-desk.json',
  reviewGate: 'review-gate.json',
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
