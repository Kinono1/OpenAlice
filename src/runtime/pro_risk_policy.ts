import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  DEFAULT_PRO_RISK_POLICY_PATH,
  PRO_MAX_FALLBACK_AGE_MS,
  PRO_RISK_POLICY_SCHEMA_VERSION,
} from './market_intel_constants.js'
import { writeJsonAtomicWithGeneration } from './atomic_write.js'

export const ProRiskPolicySchema = z.object({
  schemaVersion: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  proEpoch: z.number().int().nonnegative(),
  generatedAt: z.string(),
  validUntil: z.string(),
  verdict: z.string(),
  confidenceScore: z.number().min(0).max(1).nullable(),
  pauseLaneRecommendations: z.record(z.string(), z.boolean()),
  symbolBlocks: z.array(z.string()),
  suggestedRuleThresholdByLane: z.record(z.string(), z.number().min(0).max(1)),
  riskReductionActions: z.array(z.string()),
  autoApplyPolicy: z.enum(['risk_reduction_only', 'none', 'all']),
  source: z.object({
    reportPath: z.string().nullable(),
    model: z.string().nullable(),
  }),
})

export type ProRiskPolicy = z.infer<typeof ProRiskPolicySchema>

export function createEmptyProRiskPolicy(now = new Date()): ProRiskPolicy {
  const iso = now.toISOString()
  return {
    schemaVersion: PRO_RISK_POLICY_SCHEMA_VERSION,
    generation: 0,
    proEpoch: 0,
    generatedAt: iso,
    validUntil: iso,
    verdict: 'unavailable',
    confidenceScore: null,
    pauseLaneRecommendations: {},
    symbolBlocks: [],
    suggestedRuleThresholdByLane: {},
    riskReductionActions: [],
    autoApplyPolicy: 'risk_reduction_only',
    source: {
      reportPath: null,
      model: null,
    },
  }
}

export function readProRiskPolicy(path = DEFAULT_PRO_RISK_POLICY_PATH): ProRiskPolicy {
  if (!existsSync(path)) return createEmptyProRiskPolicy()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return ProRiskPolicySchema.parse(normalizeProRiskPolicy(migrateProRiskPolicy(raw)))
  } catch {
    return createEmptyProRiskPolicy()
  }
}

export function writeProRiskPolicy(
  policy: ProRiskPolicy,
  opts: { path?: string; expectedGeneration?: number | null } = {},
): boolean {
  const path = opts.path ?? DEFAULT_PRO_RISK_POLICY_PATH
  const result = writeJsonAtomicWithGeneration({
    latestPath: path,
    lockDir: `${path}.lock`,
    value: ProRiskPolicySchema.parse(normalizeProRiskPolicy(policy)),
    expectedGeneration: opts.expectedGeneration,
    readGeneration: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const raw = (value as Record<string, unknown>).generation
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    },
    purpose: 'pro_risk_policy_write',
  })
  return result.written
}

export function nextProRiskPolicy(
  previous: ProRiskPolicy,
  patch: Omit<Partial<ProRiskPolicy>, 'generation' | 'schemaVersion'>,
): ProRiskPolicy {
  return ProRiskPolicySchema.parse(normalizeProRiskPolicy({
    ...previous,
    ...patch,
    schemaVersion: PRO_RISK_POLICY_SCHEMA_VERSION,
    generation: previous.generation + 1,
  }))
}

export function isProRiskPolicyActive(policy: ProRiskPolicy, nowMs = Date.now()): boolean {
  if (policy.proEpoch <= 0) return false
  const validUntilMs = Date.parse(policy.validUntil)
  const generatedAtMs = Date.parse(policy.generatedAt)
  if (!Number.isFinite(validUntilMs) || validUntilMs <= nowMs) return false
  if (!Number.isFinite(generatedAtMs)) return false
  if (nowMs - generatedAtMs > PRO_MAX_FALLBACK_AGE_MS) return false
  return policy.autoApplyPolicy !== 'none'
}

export function migrateProRiskPolicy(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  const version = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0
  if (version >= PRO_RISK_POLICY_SCHEMA_VERSION) return raw
  return {
    ...createEmptyProRiskPolicy(),
    ...record,
    schemaVersion: PRO_RISK_POLICY_SCHEMA_VERSION,
    generation: typeof record.generation === 'number' && Number.isFinite(record.generation)
      ? record.generation
      : 0,
    proEpoch: typeof record.proEpoch === 'number' && Number.isFinite(record.proEpoch)
      ? record.proEpoch
      : 0,
    autoApplyPolicy: record.autoApplyPolicy === 'none' || record.autoApplyPolicy === 'all'
      ? record.autoApplyPolicy
      : 'risk_reduction_only',
  }
}

export function normalizeProRiskPolicy(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  return {
    ...record,
    pauseLaneRecommendations: normalizeBooleanRecord(record.pauseLaneRecommendations),
    symbolBlocks: normalizeSymbolList(record.symbolBlocks),
    suggestedRuleThresholdByLane: normalizeThresholdRecord(record.suggestedRuleThresholdByLane),
    riskReductionActions: Array.isArray(record.riskReductionActions)
      ? record.riskReductionActions.filter((value): value is string => typeof value === 'string')
      : [],
    confidenceScore: typeof record.confidenceScore === 'number' && Number.isFinite(record.confidenceScore)
      ? Math.max(0, Math.min(1, record.confidenceScore))
      : null,
  }
}

function normalizeBooleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, boolean> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim() || typeof raw !== 'boolean') continue
    out[key.trim()] = raw
  }
  return out
}

function normalizeThresholdRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim() || typeof raw !== 'number' || !Number.isFinite(raw)) continue
    out[key.trim()] = Math.max(0, Math.min(1, raw))
  }
  return out
}

function normalizeSymbolList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const symbol = raw.trim().toUpperCase()
    if (!/^[A-Z0-9]+-USDT$/.test(symbol) || seen.has(symbol)) continue
    seen.add(symbol)
    out.push(symbol)
  }
  return out
}
