import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE,
  COLD_START_ROUNDS,
  DEFAULT_MARKET_INTEL_CONTEXT_PATH,
  DEFAULT_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE,
  MARKET_INTEL_SCHEMA_VERSION,
  MARKET_INTEL_LANES,
  ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE,
  type MarketIntelLane,
} from './market_intel_constants.js'
import { writeJsonAtomicWithGeneration } from './atomic_write.js'

const ConfidenceIntervalSchema = z.object({
  confidence: z.number().min(0).max(1),
  confidenceLow: z.number().min(0).max(1),
  confidenceHigh: z.number().min(0).max(1),
})

const LaneBooleanMapSchema = z.object({
  cross_sectional: z.boolean(),
  volume_breakout_1x: z.boolean(),
  volume_breakout_3x: z.boolean(),
  microstructure_10x: z.boolean(),
  microstructure_100x: z.boolean(),
}).strict()

const LaneExposureMapSchema = z.object({
  cross_sectional: z.number().min(0).max(1),
  volume_breakout_1x: z.number().min(0).max(1),
  volume_breakout_3x: z.number().min(0).max(1),
  microstructure_10x: z.number().min(0).max(1),
  microstructure_100x: z.number().min(0).max(1),
}).strict()

const LaneConfidenceMapSchema = z.object({
  cross_sectional: ConfidenceIntervalSchema.optional(),
  volume_breakout_1x: ConfidenceIntervalSchema.optional(),
  volume_breakout_3x: ConfidenceIntervalSchema.optional(),
  microstructure_10x: ConfidenceIntervalSchema.optional(),
  microstructure_100x: ConfidenceIntervalSchema.optional(),
}).strict()

export const MarketIntelContextSchema = z.object({
  schemaVersion: z.number().int().positive(),
  contextGeneration: z.number().int().nonnegative(),
  generatedAt: z.string(),
  validUntil: z.string(),
  riskMode: z.enum(['risk_on', 'risk_reduced', 'risk_off']),
  newsRiskRegime: z.enum(['normal', 'elevated', 'severe']),
  allowNewPositionsByLane: LaneBooleanMapSchema,
  exposureMultiplierByLane: LaneExposureMapSchema,
  bannedSymbols: z.array(z.string()),
  suggestedRuleThresholdByLane: z.record(z.string(), z.number().min(0).max(1)),
  coldStartRoundsRemaining: z.number().int().nonnegative(),
  flashConfidenceByLane: LaneConfidenceMapSchema,
  semanticValidation: z.object({
    passed: z.boolean(),
    violations: z.array(z.object({
      rule: z.string(),
      field: z.string(),
      action: z.enum(['clamp', 'fallback', 'block']),
    })),
  }),
  sourceEpoch: z.object({
    flashEpoch: z.number().int().nonnegative(),
    proEpoch: z.number().int().nonnegative(),
    newsEpoch: z.number().int().nonnegative(),
  }),
  autoApplyPolicy: z.enum(['risk_reduction_only', 'none', 'all']),
  bootstrap: z.boolean().optional(),
  trigger: z.string().optional(),
  modelLane: z.string().optional(),
  model: z.string().optional(),
  reasons: z.array(z.string()).optional(),
})

export type MarketIntelContext = z.infer<typeof MarketIntelContextSchema>

export function createBootstrapMarketIntelContext(now = new Date()): MarketIntelContext {
  const iso = now.toISOString()
  return {
    schemaVersion: MARKET_INTEL_SCHEMA_VERSION,
    contextGeneration: 0,
    generatedAt: iso,
    validUntil: iso,
    riskMode: 'risk_off',
    newsRiskRegime: 'normal',
    allowNewPositionsByLane: { ...BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE },
    exposureMultiplierByLane: { ...ZERO_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE },
    bannedSymbols: [],
    suggestedRuleThresholdByLane: {},
    coldStartRoundsRemaining: COLD_START_ROUNDS,
    flashConfidenceByLane: {},
    semanticValidation: { passed: true, violations: [] },
    sourceEpoch: { flashEpoch: 0, proEpoch: 0, newsEpoch: 0 },
    autoApplyPolicy: 'risk_reduction_only',
    bootstrap: true,
    trigger: 'bootstrap',
    modelLane: 'fallback',
    model: 'local',
    reasons: ['bootstrap_risk_off'],
  }
}

export function readMarketIntelContext(path = DEFAULT_MARKET_INTEL_CONTEXT_PATH): MarketIntelContext {
  if (!existsSync(path)) {
    const bootstrap = createBootstrapMarketIntelContext()
    writeMarketIntelContext(bootstrap, { path })
    return bootstrap
  }

  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    const migrated = normalizeMarketIntelContext(migrateMarketIntelContext(raw))
    const parsed = MarketIntelContextSchema.parse(migrated)
    if (migrated !== raw) writeMarketIntelContext(parsed, { path })
    return parsed
  } catch {
    return createBootstrapMarketIntelContext()
  }
}

export function writeMarketIntelContext(
  context: MarketIntelContext,
  opts: { path?: string; expectedGeneration?: number | null } = {},
): boolean {
  const path = opts.path ?? DEFAULT_MARKET_INTEL_CONTEXT_PATH
  const result = writeJsonAtomicWithGeneration({
    latestPath: path,
    lockDir: `${path}.lock`,
    value: context,
    expectedGeneration: opts.expectedGeneration,
    readGeneration: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const raw = (value as Record<string, unknown>).contextGeneration
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    },
    purpose: 'market_intel_context_write',
  })
  return result.written
}

export function nextMarketIntelContext(
  previous: MarketIntelContext,
  patch: Partial<MarketIntelContext>,
): MarketIntelContext {
  return MarketIntelContextSchema.parse({
    ...previous,
    ...patch,
    schemaVersion: MARKET_INTEL_SCHEMA_VERSION,
    contextGeneration: previous.contextGeneration + 1,
    generatedAt: patch.generatedAt ?? new Date().toISOString(),
    allowNewPositionsByLane: normalizeAllowNewPositionsByLane(
      patch.allowNewPositionsByLane ?? previous.allowNewPositionsByLane,
      previous.allowNewPositionsByLane,
    ),
    exposureMultiplierByLane: normalizeExposureMultiplierByLane(
      patch.exposureMultiplierByLane ?? previous.exposureMultiplierByLane,
      previous.exposureMultiplierByLane,
    ),
    flashConfidenceByLane: normalizeFlashConfidenceByLane(
      patch.flashConfidenceByLane ?? previous.flashConfidenceByLane,
      previous.flashConfidenceByLane,
    ),
    suggestedRuleThresholdByLane: normalizeRuleThresholdByLane(
      patch.suggestedRuleThresholdByLane ?? previous.suggestedRuleThresholdByLane,
    ),
    semanticValidation: patch.semanticValidation ?? previous.semanticValidation,
  })
}

export function migrateMarketIntelContext(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0
  if (version >= MARKET_INTEL_SCHEMA_VERSION) return raw

  const now = new Date().toISOString()
  return {
    ...createBootstrapMarketIntelContext(new Date(now)),
    ...record,
    schemaVersion: MARKET_INTEL_SCHEMA_VERSION,
    contextGeneration: typeof record.contextGeneration === 'number' ? record.contextGeneration : 0,
    generatedAt: typeof record.generatedAt === 'string' ? record.generatedAt : now,
    validUntil: typeof record.validUntil === 'string' ? record.validUntil : now,
    riskMode: isRiskMode(record.riskMode) ? record.riskMode : 'risk_off',
    newsRiskRegime: isNewsRiskRegime(record.newsRiskRegime) ? record.newsRiskRegime : 'normal',
    allowNewPositionsByLane: normalizeAllowNewPositionsByLane(record.allowNewPositionsByLane),
    exposureMultiplierByLane: normalizeExposureMultiplierByLane(record.exposureMultiplierByLane),
    flashConfidenceByLane: normalizeFlashConfidenceByLane(record.flashConfidenceByLane),
    bannedSymbols: normalizeBannedSymbols(record.bannedSymbols),
    suggestedRuleThresholdByLane: normalizeRuleThresholdByLane(record.suggestedRuleThresholdByLane),
    autoApplyPolicy: record.autoApplyPolicy === 'none' || record.autoApplyPolicy === 'all'
      ? record.autoApplyPolicy
      : 'risk_reduction_only',
  }
}

export function normalizeMarketIntelContext(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  return {
    ...record,
    allowNewPositionsByLane: normalizeAllowNewPositionsByLane(record.allowNewPositionsByLane),
    exposureMultiplierByLane: normalizeExposureMultiplierByLane(record.exposureMultiplierByLane),
    flashConfidenceByLane: normalizeFlashConfidenceByLane(record.flashConfidenceByLane),
    bannedSymbols: normalizeBannedSymbols(record.bannedSymbols),
    suggestedRuleThresholdByLane: normalizeRuleThresholdByLane(record.suggestedRuleThresholdByLane),
  }
}

export function normalizeAllowNewPositionsByLane(
  value: unknown,
  fallback: Record<MarketIntelLane, boolean> = BLOCKED_MARKET_INTEL_ALLOW_NEW_POSITIONS_BY_LANE,
): Record<MarketIntelLane, boolean> {
  const record = isRecord(value) ? value : {}
  return MARKET_INTEL_LANES.reduce((acc, lane) => {
    const raw = record[lane]
    acc[lane] = typeof raw === 'boolean' ? raw : fallback[lane]
    return acc
  }, {} as Record<MarketIntelLane, boolean>)
}

export function normalizeExposureMultiplierByLane(
  value: unknown,
  fallback: Record<MarketIntelLane, number> = DEFAULT_MARKET_INTEL_EXPOSURE_MULTIPLIER_BY_LANE,
): Record<MarketIntelLane, number> {
  const record = isRecord(value) ? value : {}
  return MARKET_INTEL_LANES.reduce((acc, lane) => {
    const raw = record[lane]
    acc[lane] = typeof raw === 'number' && Number.isFinite(raw)
      ? Math.max(0, Math.min(1, raw))
      : fallback[lane]
    return acc
  }, {} as Record<MarketIntelLane, number>)
}

export function normalizeFlashConfidenceByLane(
  value: unknown,
  fallback: Partial<Record<MarketIntelLane, z.infer<typeof ConfidenceIntervalSchema>>> = {},
): Partial<Record<MarketIntelLane, z.infer<typeof ConfidenceIntervalSchema>>> {
  const record = isRecord(value) ? value : {}
  return MARKET_INTEL_LANES.reduce((acc, lane) => {
    const parsed = ConfidenceIntervalSchema.safeParse(record[lane])
    if (parsed.success) acc[lane] = parsed.data
    else if (fallback[lane]) acc[lane] = fallback[lane]
    return acc
  }, {} as Partial<Record<MarketIntelLane, z.infer<typeof ConfidenceIntervalSchema>>>)
}

export function normalizeMarketIntelSymbol(value: string): string | null {
  const normalized = value.trim().toUpperCase()
    .replace(/\//g, '-')
    .replace(/_/g, '-')
    .replace(/-SWAP$/, '')
  if (!normalized) return null
  if (/^[A-Z0-9]+$/.test(normalized)) return `${normalized}-USDT`
  if (/^[A-Z0-9]+-USDT$/.test(normalized)) return normalized
  return null
}

export function normalizeBannedSymbols(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const symbol = normalizeMarketIntelSymbol(raw)
    if (!symbol || seen.has(symbol)) continue
    seen.add(symbol)
    out.push(symbol)
  }
  return out
}

export function isMarketIntelSymbolBanned(context: MarketIntelContext, symbol: string): boolean {
  const normalized = normalizeMarketIntelSymbol(symbol)
  if (!normalized) return false
  return normalizeBannedSymbols(context.bannedSymbols).includes(normalized)
}

export function normalizeRuleThresholdByLane(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [lane, raw] of Object.entries(value)) {
    if (!lane.trim() || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out[lane.trim()] = Math.max(0, Math.min(1, raw))
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isRiskMode(value: unknown): value is MarketIntelContext['riskMode'] {
  return value === 'risk_on' || value === 'risk_reduced' || value === 'risk_off'
}

function isNewsRiskRegime(value: unknown): value is MarketIntelContext['newsRiskRegime'] {
  return value === 'normal' || value === 'elevated' || value === 'severe'
}
