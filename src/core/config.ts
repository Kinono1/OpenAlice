import { z } from 'zod'
import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { resolve } from 'path'
import { newsCollectorSchema } from '../domain/news/config.js'
import { AI_PROVIDER_DEFAULT_MODELS } from '../generated/approvedModelRegistry.js'

const CONFIG_DIR = resolve('data/config')

// ==================== Individual Schemas ====================

const engineSchema = z.object({
  pairs: z.array(z.string()).min(1).default(['BTC/USD', 'ETH/USD', 'SOL/USD']),
  interval: z.number().int().positive().default(5000),
  port: z.number().int().positive().default(3000),
})

const loginMethodSchema = z.enum(['api-key', 'claudeai'])

export const aiProviderSchema = z.object({
  backend: z.enum(['claude-code', 'vercel-ai-sdk', 'agent-sdk']).default('claude-code'),
  provider: z.string().default('anthropic'),
  model: z.string().default(AI_PROVIDER_DEFAULT_MODELS.anthropic),
  baseUrl: z.string().min(1).optional(),
  /** Authentication method for Agent SDK: api-key (default), oauth (Console), claudeai (Pro/Max). */
  loginMethod: loginMethodSchema.default('api-key'),
  apiKeys: z.object({
    anthropic: z.string().optional(),
    openai: z.string().optional(),
    google: z.string().optional(),
  }).default({}),
})

const agentSchema = z.object({
  maxSteps: z.number().int().positive().default(20),
  evolutionMode: z.boolean().default(false),
  claudeCode: z.object({
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).default([
      'Task', 'TaskOutput',
      'AskUserQuestion', 'TodoWrite',
      'NotebookEdit', 'Skill',
      'EnterPlanMode', 'ExitPlanMode',
      'mcp__claude_ai_Figma__*',
    ]),
    maxTurns: z.number().int().positive().default(20),
  }).default({
    disallowedTools: [
      'Task', 'TaskOutput',
      'AskUserQuestion', 'TodoWrite',
      'NotebookEdit', 'Skill',
      'EnterPlanMode', 'ExitPlanMode',
      'mcp__claude_ai_Figma__*',
    ],
    maxTurns: 20,
  }),
})

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
      options: z.record(z.string(), z.unknown()).optional(),
    }).passthrough(),
    z.object({
      type: z.literal('none'),
    }),
  ]).default({ type: 'none' }),
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
  ]).default({ type: 'none' }),
  guards: z.array(z.object({
    type: z.string(),
    options: z.record(z.string(), z.unknown()).default({}),
  })).default([]),
})

const marketDataSchema = z.object({
  enabled: z.boolean().default(true),
  apiUrl: z.string().default('http://localhost:6900'),
  providers: z.object({
    equity: z.string().default('yfinance'),
    crypto: z.string().default('yfinance'),
    currency: z.string().default('yfinance'),
  }).default({
    equity: 'yfinance',
    crypto: 'yfinance',
    currency: 'yfinance',
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
  backend: z.enum(['typebb-sdk', 'openbb-api']).default('typebb-sdk'),
  apiServer: z.object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1024).max(65535).default(6901),
  }).default({ enabled: true, port: 6901 }),
})

const compactionSchema = z.object({
  maxContextTokens: z.number().default(200_000),
  maxOutputTokens: z.number().default(20_000),
  autoCompactBuffer: z.number().default(13_000),
  microcompactKeepRecent: z.number().default(3),
})

const activeHoursSchema = z.object({
  start: z.string().regex(/^\d{1,2}:\d{2}$/, 'Expected HH:MM format'),
  end: z.string().regex(/^\d{1,2}:\d{2}$/, 'Expected HH:MM format'),
  timezone: z.string().default('local'),
}).nullable().default(null)

const authSchema = z.object({
  /** If true, auth is enforced even if env tokens are not set (rejects all). */
  enforceAuth: z.boolean().default(true),
  /** Token TTL for session tokens (future use). */
  sessionTtlMs: z.number().int().positive().default(86_400_000),
})


const connectorsSchema = z.object({
  web: z.object({
    port: z.number().int().positive().default(3002),
    allowOrigins: z.array(z.string()).default([]),
    maxSseClients: z.number().int().positive().max(1000).default(100),
    sseMaxDurationMs: z.number().int().positive().max(86_400_000).default(900_000),
  }).default({ port: 3002, allowOrigins: [], maxSseClients: 100, sseMaxDurationMs: 900_000 }),
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
    botTokenEnv: z.string().min(1).default('TELEGRAM_BOT_TOKEN'),
    /** Legacy read-only compatibility. New writes must use botTokenEnv. */
    botToken: z.string().optional(),
    botUsername: z.string().optional(),
    chatIds: z.array(z.number()).default([]),
  }).default({ enabled: false, botTokenEnv: 'TELEGRAM_BOT_TOKEN', chatIds: [] }),
})

const heartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  every: z.string().default('30m'),
  prompt: z.string().default('Read data/brain/heartbeat.md (or default/heartbeat.default.md if not found) and follow the instructions inside.'),
  activeHours: activeHoursSchema,
})

const snapshotSchema = z.object({
  enabled: z.boolean().default(true),
  every: z.string().default('15m'),
})

export const toolsSchema = z.object({
  /** Tool names that are disabled. Tools not listed are enabled by default. */
  disabled: z.array(z.string()).default([]),
})

const strategyFactorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  weight: z.number().nonnegative().default(1),
})

const strategyCompositeFactorConfigSchema = strategyFactorConfigSchema.extend({
  componentWeights: z.object({
    first: z.number().nonnegative(),
    second: z.number().nonnegative(),
    third: z.number().nonnegative(),
  }).optional(),
})

const strategyLayerConfigSchema = z.object({
  layer: z.enum(['core', 'extended', 'watch-only']),
  maxPositions: z.number().int().nonnegative(),
  maxPositionPctOfEquity: z.number().nonnegative(),
  minActionStatusToTrade: z.enum(['attack', 'attack-lite', 'probe', 'hold', 'reduce', 'exit', 'no-trade']),
  requiresCoreNotRiskOff: z.boolean(),
})

const strategyFreezeRuleSchema = z.object({
  preFreezeHours: z.number().nonnegative().default(2),
  postFreezeHours: z.number().nonnegative().default(0.5),
  maxActionDuringFreeze: z.enum(['reduce', 'exit', 'no-trade', 'hold']).default('reduce'),
})

const strategyMacroEventSchema = z.object({
  name: z.string().min(1),
  releaseTimeUtc: z.number().int(),
  severity: z.enum(['high', 'medium', 'low']),
  marketScope: z.array(z.enum(['crypto', 'a-share'])).min(1),
  freezeRule: strategyFreezeRuleSchema,
})

const strategyRegimeHmmSchema = z.object({
  enabled: z.boolean().default(false),
  minObservations: z.number().int().positive().default(30),
  seedObservations: z.number().int().positive().default(168),
  stableObservations: z.number().int().positive().default(500),
  trainingLookback: z.number().int().positive().default(720),
  maxIterations: z.number().int().positive().default(24),
  tolerance: z.number().positive().default(1e-3),
  regularization: z.number().nonnegative().default(1e-4),
  confidenceFloor: z.number().min(0).max(1).default(0.4),
  anomalyZScore: z.number().positive().default(3),
  zScoreWindow: z.number().int().positive().default(48),
  realizedVolWindow: z.number().int().positive().default(24),
  volumeBaselineWindow: z.number().int().positive().default(24),
})

const strategyResearchIcSchema = z.object({
  enabled: z.boolean().default(false),
  minMeanIc: z.number().default(0.03),
  minIcIr: z.number().default(0.5),
  minWinRate: z.number().default(0.55),
  quantiles: z.number().int().min(3).max(10).default(5),
  decayHorizons: z.array(z.number().int().positive()).default([1, 6, 24, 72, 168]),
})

const strategyMlSchema = z.object({
  enabled: z.boolean().default(false),
  architecture: z.enum(['lstm', 'patchtst']).default('lstm'),
  modelPath: z.string().optional(),
  lookbackSteps: z.number().int().positive().default(48),
  forecastHorizonHours: z.number().int().positive().default(24),
  decisionThreshold: z.number().positive().default(0.05),
})

const strategyMetaLabelingSchema = z.object({
  enabled: z.boolean().default(false),
  enforcementMode: z.enum(['shadow_only', 'gate']).default('shadow_only'),
  upperBarrierPct: z.number().positive().default(2),
  lowerBarrierPct: z.number().positive().default(1),
  maxHoldingBars: z.number().int().positive().default(24),
  minConfidenceToTrade: z.number().min(0).max(1).default(0.55),
})

export const strategySchema = z.object({
  enabled: z.boolean().default(true),
  governance: z.object({
    useGovernanceGate: z.boolean().default(true),
    staleDataCapsExecution: z.boolean().default(true),
    preferReduceOnWeakSignal: z.boolean().default(false),
  }).default({
    useGovernanceGate: true,
    staleDataCapsExecution: true,
    preferReduceOnWeakSignal: false,
  }),
  runtime: z.object({
    marketScope: z.enum(['crypto', 'a-share']).default('crypto'),
    runtimeIntegrationEnabled: z.boolean().default(false),
  }).default({
    marketScope: 'crypto',
    runtimeIntegrationEnabled: false,
  }),
  eventCalendar: z.object({
    enabled: z.boolean().default(true),
    events: z.array(strategyMacroEventSchema).default([]),
  }).default({
    enabled: true,
    events: [],
  }),
  regime: z.object({
    hmm: strategyRegimeHmmSchema.optional(),
  }).optional(),
  factors: z.object({
    fundingRate: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
    basis: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
    volumeSurge: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
    momentumComposite: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
    meanReversion: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
    volatilityRegime: strategyCompositeFactorConfigSchema.default({ enabled: true, weight: 1 }),
    liquidationPressure: strategyCompositeFactorConfigSchema.default({ enabled: true, weight: 1 }),
    crossTimeframeDivergence: strategyFactorConfigSchema.default({ enabled: true, weight: 1 }),
  }).default({
    fundingRate: { enabled: true, weight: 1 },
    basis: { enabled: true, weight: 1 },
    volumeSurge: { enabled: true, weight: 1 },
    momentumComposite: { enabled: true, weight: 1 },
    meanReversion: { enabled: true, weight: 1 },
    volatilityRegime: { enabled: true, weight: 1 },
    liquidationPressure: { enabled: true, weight: 1 },
    crossTimeframeDivergence: { enabled: true, weight: 1 },
  }),
  positionSizing: z.object({
    enabled: z.boolean().default(true),
    method: z.enum(['fixed', 'kelly', 'volTarget']).default('fixed'),
    defaultAssetLayer: z.enum(['core', 'extended', 'watch-only']).default('core'),
    targetVolPct: z.number().positive().default(10),
    maxPctOfEquity: z.number().positive().default(0.3),
    kellyFraction: z.number().positive().default(0.15),
    layerConfigs: z.array(strategyLayerConfigSchema).default([
      {
        layer: 'core',
        maxPositions: 5,
        maxPositionPctOfEquity: 0.3,
        minActionStatusToTrade: 'probe',
        requiresCoreNotRiskOff: false,
      },
      {
        layer: 'extended',
        maxPositions: 3,
        maxPositionPctOfEquity: 0.15,
        minActionStatusToTrade: 'attack-lite',
        requiresCoreNotRiskOff: true,
      },
      {
        layer: 'watch-only',
        maxPositions: 1,
        maxPositionPctOfEquity: 0.05,
        minActionStatusToTrade: 'attack',
        requiresCoreNotRiskOff: true,
      },
    ]),
    portfolioRiskOverlay: z.object({
      enabled: z.boolean().default(false),
      maxGrossExposurePctOfEquity: z.number().positive().default(3),
      maxNetExposurePctOfEquity: z.number().positive().default(1),
      maxSingleAssetPctOfEquity: z.number().positive().default(0.5),
    }).optional(),
  }).default({
    enabled: true,
    method: 'fixed',
    defaultAssetLayer: 'core',
    targetVolPct: 10,
    maxPctOfEquity: 0.3,
    kellyFraction: 0.15,
    layerConfigs: [
      {
        layer: 'core',
        maxPositions: 5,
        maxPositionPctOfEquity: 0.3,
        minActionStatusToTrade: 'probe',
        requiresCoreNotRiskOff: false,
      },
      {
        layer: 'extended',
        maxPositions: 3,
        maxPositionPctOfEquity: 0.15,
        minActionStatusToTrade: 'attack-lite',
        requiresCoreNotRiskOff: true,
      },
      {
        layer: 'watch-only',
        maxPositions: 1,
        maxPositionPctOfEquity: 0.05,
        minActionStatusToTrade: 'attack',
        requiresCoreNotRiskOff: true,
      },
    ],
  }),
  research: z.object({
    ic: strategyResearchIcSchema.optional(),
  }).optional(),
  ml: strategyMlSchema.optional(),
  metaLabeling: strategyMetaLabelingSchema.optional(),
})

export type StrategyConfig = z.infer<typeof strategySchema>

/** Vercel AI SDK model override — per-channel provider/model/key/endpoint. */
export const vercelAiSdkOverrideSchema = z.object({
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
})

/** Agent SDK model override — per-channel model/key/endpoint. */
export const agentSdkOverrideSchema = z.object({
  model: z.string().optional(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  loginMethod: loginMethodSchema.optional(),
})

export const webSubchannelSchema = z.object({
  /** URL-safe identifier. Used as session path segment: data/sessions/web/{id}.jsonl */
  id: z.string().regex(/^[a-z0-9-_]+$/, 'id must be lowercase alphanumeric with hyphens/underscores'),
  label: z.string().min(1),
  /** System prompt override for this channel. */
  systemPrompt: z.string().optional(),
  /** AI backend override. Falls back to global config if omitted. */
  provider: z.enum(['claude-code', 'vercel-ai-sdk', 'agent-sdk']).optional(),
  /** Vercel AI SDK model override. Only used when provider is 'vercel-ai-sdk'. */
  vercelAiSdk: vercelAiSdkOverrideSchema.optional(),
  /** Agent SDK model override. Only used when provider is 'agent-sdk'. */
  agentSdk: agentSdkOverrideSchema.optional(),
  /** Tool names to disable in addition to the global disabled list. */
  disabledTools: z.array(z.string()).optional(),
})

export const webSubchannelsSchema = z.array(webSubchannelSchema)

export type WebChannel = z.infer<typeof webSubchannelSchema>

// ==================== Account Config ====================

const guardConfigSchema = z.object({
  type: z.string(),
  options: z.record(z.string(), z.unknown()).default({}),
})

const cryptoExecutionSchema = z.object({
  mode: z.literal('paper_only').default('paper_only'),
  enableCryptoDispatcher: z.boolean().default(true),
  requireDecisionTicket: z.boolean().default(false),
  ticketTtlMs: z.number().int().positive().default(600_000),
  idempotencyTtlMs: z.number().int().positive().default(1_800_000),
  killSwitchDefaultPolicy: z.enum(['block_new_only', 'block_all']).default('block_new_only'),
  killSwitchStatePath: z.string().default('data/runtime/kill-switch.sqlite'),
  operationTimeoutMs: z.number().int().positive().default(30_000),
})

export const accountConfigSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  type: z.string(),
  enabled: z.boolean().default(true),
  guards: z.array(guardConfigSchema).default([]),
  brokerConfig: z.record(z.string(), z.unknown()).default({}),
  cryptoExecution: cryptoExecutionSchema.optional(),
})

export const accountsFileSchema = z.array(accountConfigSchema)

export type AccountConfig = z.infer<typeof accountConfigSchema>

// ==================== Unified Config Type ====================

export type Config = {
  engine: z.infer<typeof engineSchema>
  agent: z.infer<typeof agentSchema>
  crypto: z.infer<typeof cryptoSchema>
  securities: z.infer<typeof securitiesSchema>
  marketData: z.infer<typeof marketDataSchema>
  compaction: z.infer<typeof compactionSchema>
  aiProvider: z.infer<typeof aiProviderSchema>
  auth: z.infer<typeof authSchema>
  heartbeat: z.infer<typeof heartbeatSchema>
  snapshot: z.infer<typeof snapshotSchema>
  strategy: z.infer<typeof strategySchema>
  connectors: z.infer<typeof connectorsSchema>
  news: z.infer<typeof newsCollectorSchema>
  tools: z.infer<typeof toolsSchema>
}

// ==================== Loader ====================

/** Read a JSON config file. Returns undefined if file does not exist. */
async function loadJsonFile(filename: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(resolve(CONFIG_DIR, filename), 'utf-8'))
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}

/** Silently remove a config file (ignore if missing). */
async function removeJsonFile(filename: string): Promise<void> {
  try { await unlink(resolve(CONFIG_DIR, filename)) } catch { /* ENOENT ok */ }
}

/** Parse with Zod; if the file was missing, seed it to disk with defaults. */
async function parseAndSeed<T>(filename: string, schema: z.ZodType<T>, raw: unknown | undefined): Promise<T> {
  const parsed = schema.parse(raw ?? {})
  if (raw === undefined) {
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, filename), JSON.stringify(parsed, null, 2) + '\n')
  }
  return parsed
}

export async function loadConfig(): Promise<Config> {
  const files = ['engine.json', 'agent.json', 'crypto.json', 'securities.json', 'market-data.json', 'compaction.json', 'ai-provider-manager.json', 'auth.json', 'heartbeat.json', 'snapshot.json', 'strategy.json', 'connectors.json', 'news.json', 'tools.json'] as const
  const raws = await Promise.all(files.map((f) => loadJsonFile(f)))

  // TODO: remove all migration blocks before v1.0 — no stable release yet, breaking changes are fine
  // ---------- Migration: consolidate old ai-provider + model + api-keys → ai-provider ----------
  const aiProviderRaw = raws[6] as Record<string, unknown> | undefined
  if (aiProviderRaw && !('backend' in aiProviderRaw)) {
    // Old format detected — merge model.json + api-keys.json into ai-provider-manager.json
    const oldModel = await loadJsonFile('model.json') as Record<string, unknown> | undefined
    const oldKeys = await loadJsonFile('api-keys.json') as Record<string, unknown> | undefined
    const migrated = {
      backend: aiProviderRaw.provider ?? 'claude-code',
      provider: oldModel?.provider ?? 'anthropic',
      model: oldModel?.model ?? AI_PROVIDER_DEFAULT_MODELS.anthropic,
      ...(oldModel?.baseUrl ? { baseUrl: oldModel.baseUrl } : {}),
      apiKeys: oldKeys ?? {},
    }
    raws[6] = migrated
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'ai-provider-manager.json'), JSON.stringify(migrated, null, 2) + '\n')
    await removeJsonFile('model.json')
    await removeJsonFile('api-keys.json')
  }

  // ---------- Migration: claude-code backend → agent-sdk + claudeai ----------
  if (aiProviderRaw && (aiProviderRaw as Record<string, unknown>).backend === 'claude-code') {
    const patched = { ...(aiProviderRaw as Record<string, unknown>), backend: 'agent-sdk', loginMethod: 'claudeai' }
    raws[6] = patched
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'ai-provider-manager.json'), JSON.stringify(patched, null, 2) + '\n')
  }

  // ---------- Migration: consolidate old telegram.json + engine port fields ----------
  const connectorsRaw = raws[11] as Record<string, unknown> | undefined
  const telegramRaw = connectorsRaw?.telegram as Record<string, unknown> | undefined
  if (typeof telegramRaw?.botToken === 'string' && telegramRaw.botToken.length > 0) {
    console.warn('[config] connectors.telegram.botToken is deprecated; move the rotated token to the botTokenEnv environment variable')
  }
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
    raws[11] = Object.keys(migrated).length > 0 ? migrated : undefined
  }

  return {
    engine:        await parseAndSeed(files[0], engineSchema, raws[0]),
    agent:         await parseAndSeed(files[1], agentSchema, raws[1]),
    crypto:        await parseAndSeed(files[2], cryptoSchema, raws[2]),
    securities:    await parseAndSeed(files[3], securitiesSchema, raws[3]),
    marketData:    await parseAndSeed(files[4], marketDataSchema, raws[4]),
    compaction:    await parseAndSeed(files[5], compactionSchema, raws[5]),
    aiProvider:    await parseAndSeed(files[6], aiProviderSchema, raws[6]),
    auth:          await parseAndSeed(files[7], authSchema, raws[7]),
    heartbeat:     await parseAndSeed(files[8], heartbeatSchema, raws[8]),
    snapshot:      await parseAndSeed(files[9], snapshotSchema, raws[9]),
    strategy:      await parseAndSeed(files[10], strategySchema, raws[10]),
    connectors:    await parseAndSeed(files[11], connectorsSchema, raws[11]),
    news:          await parseAndSeed(files[12], newsCollectorSchema, raws[12]),
    tools:         await parseAndSeed(files[13], toolsSchema, raws[13]),
  }
}

// ==================== Account Config Loader ====================

/** Common fields that live at the top level, not inside brokerConfig. */
const BASE_FIELDS = new Set(['id', 'label', 'type', 'guards', 'brokerConfig'])

/**
 * Migrate flat account config (legacy) to nested brokerConfig format.
 * Any field not in BASE_FIELDS gets moved into brokerConfig.
 */
function migrateAccountConfig(raw: Record<string, unknown>): Record<string, unknown> {
  if (raw.brokerConfig) return raw  // already migrated
  const migrated: Record<string, unknown> = {}
  const brokerConfig: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (BASE_FIELDS.has(k)) {
      migrated[k] = v
    } else {
      brokerConfig[k] = v
    }
  }
  migrated.brokerConfig = brokerConfig
  return migrated
}

export async function readAccountsConfig(): Promise<AccountConfig[]> {
  const raw = await loadJsonFile('accounts.json')
  if (raw === undefined) {
    // Seed empty file on first run
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(resolve(CONFIG_DIR, 'accounts.json'), '[]\n')
    return []
  }
  // Migrate legacy flat format → nested brokerConfig
  const migrated = (raw as unknown[]).map((item) => migrateAccountConfig(item as Record<string, unknown>))
  return accountsFileSchema.parse(migrated)
}

export async function writeAccountsConfig(accounts: AccountConfig[]): Promise<void> {
  const validated = accountsFileSchema.parse(accounts)
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(resolve(CONFIG_DIR, 'accounts.json'), JSON.stringify(validated, null, 2) + '\n')
}

// ==================== Hot-read helpers ====================

/** Read a typed config section from disk, returning defaults on any failure (with logging for non-ENOENT errors). */
async function readConfigSection<T>(filename: string, schema: z.ZodType<T>): Promise<T> {
  try {
    const raw = JSON.parse(await readFile(resolve(CONFIG_DIR, filename), 'utf-8'))
    return schema.parse(raw)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[config] error reading ${filename}, falling back to defaults:`, err)
    }
    return schema.parse({})
  }
}

/** Read agent config from disk (called per-request for hot-reload). */
export async function readAgentConfig() {
  return readConfigSection('agent.json', agentSchema)
}

/** Read AI provider config from disk (called per-request for hot-reload). */
export async function readAIProviderConfig() {
  return readConfigSection('ai-provider-manager.json', aiProviderSchema)
}

/** Read market data config from disk (called per-request for hot-reload). */
export async function readMarketDataConfig() {
  return readConfigSection('market-data.json', marketDataSchema)
}

/** Read strategy config from disk (called per-request for hot-reload). */
export async function readStrategyConfig() {
  return readConfigSection('strategy.json', strategySchema)
}

/** Read tools config from disk (called per-request for hot-reload). */
export async function readToolsConfig() {
  return readConfigSection('tools.json', toolsSchema)
}

// ==================== AI Backend Helpers ====================

export type AIBackend = 'claude-code' | 'vercel-ai-sdk' | 'agent-sdk'

/** Read the current AI backend from ai-provider-manager.json. */
export async function readAIBackend(): Promise<{ backend: AIBackend }> {
  const config = await readAIProviderConfig()
  return { backend: config.backend }
}

/** Switch the AI backend in ai-provider-manager.json (preserves other fields). */
export async function writeAIBackend(backend: AIBackend): Promise<void> {
  const current = await readAIProviderConfig()
  const updated = { ...current, backend }
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(resolve(CONFIG_DIR, 'ai-provider-manager.json'), JSON.stringify(updated, null, 2) + '\n')
}

// ==================== Writer ====================

export type ConfigSection = keyof Config

const sectionSchemas: Record<ConfigSection, z.ZodTypeAny> = {
  engine: engineSchema,
  agent: agentSchema,
  crypto: cryptoSchema,
  securities: securitiesSchema,
  marketData: marketDataSchema,
  compaction: compactionSchema,
  aiProvider: aiProviderSchema,
  auth: authSchema,
  heartbeat: heartbeatSchema,
  snapshot: snapshotSchema,
  strategy: strategySchema,
  connectors: connectorsSchema,
  news: newsCollectorSchema,
  tools: toolsSchema,
}

const sectionFiles: Record<ConfigSection, string> = {
  engine: 'engine.json',
  agent: 'agent.json',
  crypto: 'crypto.json',
  securities: 'securities.json',
  marketData: 'market-data.json',
  compaction: 'compaction.json',
  aiProvider: 'ai-provider-manager.json',
  auth: 'auth.json',
  heartbeat: 'heartbeat.json',
  snapshot: 'snapshot.json',
  strategy: 'strategy.json',
  connectors: 'connectors.json',
  news: 'news.json',
  tools: 'tools.json',
}

/** All valid config section names (derived from sectionSchemas). */
export const validSections = Object.keys(sectionSchemas) as ConfigSection[]

/** Validate and write a config section to disk. Returns the validated config. */
export async function writeConfigSection(section: ConfigSection, data: unknown): Promise<unknown> {
  if (section === 'connectors' && data && typeof data === 'object') {
    const telegram = (data as { telegram?: Record<string, unknown> }).telegram
    if (telegram && Object.hasOwn(telegram, 'botToken')) {
      delete telegram.botToken
    }
  }
  const schema = sectionSchemas[section]
  const validated = schema.parse(data)
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(resolve(CONFIG_DIR, sectionFiles[section]), JSON.stringify(validated, null, 2) + '\n')
  return validated
}

export function resolveTelegramBotToken(config: Config['connectors']['telegram']): string | undefined {
  const envName = config.botTokenEnv || 'TELEGRAM_BOT_TOKEN'
  const fromEnv = process.env[envName]?.trim()
  if (fromEnv) return fromEnv
  return config.botToken?.trim() || undefined
}

/** Read web sub-channel definitions from disk. Returns empty array if file missing. */
export async function readWebSubchannels(): Promise<WebChannel[]> {
  const raw = await loadJsonFile('web-subchannels.json')
  return webSubchannelsSchema.parse(raw ?? [])
}

/** Write web sub-channel definitions to disk. */
export async function writeWebSubchannels(channels: WebChannel[]): Promise<void> {
  const validated = webSubchannelsSchema.parse(channels)
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(resolve(CONFIG_DIR, 'web-subchannels.json'), JSON.stringify(validated, null, 2) + '\n')
}
