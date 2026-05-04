import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { appendJsonlSync } from './runtime_events.js'
import { acquireRuntimeLock } from './runtime_lock.js'

export const DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH =
  'data/paper_trading/paper_policy_shadow_ledger.jsonl'

export const PaperPolicyShadowCloseReasonSchema = z.enum([
  'shadow_horizon_expired',
  'shadow_stop_loss',
])

export const PaperPolicyShadowOpenSchema = z.object({
  counterfactualType: z.literal('trade_level_shadow'),
  eventType: z.literal('open'),
  shadowId: z.string().min(1),
  lane: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  entryPrice: z.number().positive(),
  openTs: z.string().min(1),
  openBarTime: z.number().int().nonnegative(),
  horizonMs: z.number().int().positive(),
  notionalUsd: z.number().positive().nullable().default(null),
  stopLossPrice: z.number().positive().nullable().default(null),
  blockReasons: z.array(z.string()).default([]),
  context: z.record(z.string(), z.unknown()).default({}),
  quality: z.record(z.string(), z.unknown()).default({}),
  cost: z.record(z.string(), z.unknown()).default({}),
})

export const PaperPolicyShadowOutcomeSchema = z.object({
  counterfactualType: z.literal('trade_level_shadow'),
  eventType: z.literal('closed'),
  shadowId: z.string().min(1),
  lane: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['long', 'short']),
  entryPrice: z.number().positive(),
  closePrice: z.number().positive(),
  openTs: z.string().min(1),
  openBarTime: z.number().int().nonnegative(),
  closeTs: z.string().min(1),
  closeBarTime: z.number().int().nonnegative(),
  horizonMs: z.number().int().positive(),
  pnlPct: z.number(),
  pnlUsd: z.number().nullable(),
  closeReason: PaperPolicyShadowCloseReasonSchema,
})

export const PaperPolicyShadowLedgerEntrySchema = z.union([
  PaperPolicyShadowOpenSchema,
  PaperPolicyShadowOutcomeSchema,
])

export type PaperPolicyShadowOpen = z.input<typeof PaperPolicyShadowOpenSchema>
export type ParsedPaperPolicyShadowOpen = z.infer<typeof PaperPolicyShadowOpenSchema>
export type PaperPolicyShadowOutcome = z.infer<typeof PaperPolicyShadowOutcomeSchema>
export type PaperPolicyShadowLedgerEntry = z.infer<typeof PaperPolicyShadowLedgerEntrySchema>
export type PaperPolicyShadowCloseReason = z.infer<typeof PaperPolicyShadowCloseReasonSchema>

export interface ShadowPriceObservation {
  symbol: string
  price: number
  barTime: number
  ts?: string
}

export interface AppendPaperPolicyShadowResult {
  appended: boolean
  shadowId: string
  reason?: 'duplicate_shadow_id' | 'missing_open_shadow_id' | 'invalid_v3_context' | 'ledger_locked'
  missingContextFields?: string[]
}

export interface AppendPaperPolicyShadowOptions {
  lockDir?: string
  lockWaitMs?: number
  lockPollMs?: number
}

export interface PaperPolicyShadowEvaluation {
  dueOutcomes: PaperPolicyShadowOutcome[]
  notDueShadows: ParsedPaperPolicyShadowOpen[]
}

export interface PaperPolicyShadowIdInput {
  tradeId: string
  shadowPolicyVersion: string
  entryTs: string | number
  policyId: string
}

export function buildPaperPolicyShadowId(input: PaperPolicyShadowIdInput): string {
  const payload = [
    input.tradeId,
    input.shadowPolicyVersion,
    String(input.entryTs),
    input.policyId,
  ].join('|')
  return createHash('sha256').update(payload).digest('hex')
}

export function appendPaperPolicyShadowOpen(
  input: PaperPolicyShadowOpen,
  path = DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  options: AppendPaperPolicyShadowOptions = {},
): AppendPaperPolicyShadowResult {
  const parsed = PaperPolicyShadowOpenSchema.parse({
    ...input,
    counterfactualType: 'trade_level_shadow',
    eventType: 'open',
  })
  const missingContextFields = paperPolicyShadowOpenMissingV3ContextFields(parsed.context)
  if (missingContextFields.length > 0) {
    return {
      appended: false,
      shadowId: parsed.shadowId,
      reason: 'invalid_v3_context',
      missingContextFields,
    }
  }
  return withPaperPolicyShadowAppendLock(path, parsed.shadowId, options, () => {
    const state = readPaperPolicyShadowState(path)
    if (state.openById.has(parsed.shadowId) || state.closedIds.has(parsed.shadowId)) {
      return { appended: false, shadowId: parsed.shadowId, reason: 'duplicate_shadow_id' }
    }
    appendJsonlSync(path, parsed)
    return { appended: true, shadowId: parsed.shadowId }
  })
}

export function appendPaperPolicyShadowOutcome(
  outcome: PaperPolicyShadowOutcome,
  path = DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
  options: AppendPaperPolicyShadowOptions = {},
): AppendPaperPolicyShadowResult {
  const parsed = PaperPolicyShadowOutcomeSchema.parse({
    ...outcome,
    counterfactualType: 'trade_level_shadow',
    eventType: 'closed',
  })
  return withPaperPolicyShadowAppendLock(path, parsed.shadowId, options, () => {
    const state = readPaperPolicyShadowState(path)
    if (state.closedIds.has(parsed.shadowId)) {
      return { appended: false, shadowId: parsed.shadowId, reason: 'duplicate_shadow_id' }
    }
    if (!state.openById.has(parsed.shadowId)) {
      return { appended: false, shadowId: parsed.shadowId, reason: 'missing_open_shadow_id' }
    }
    appendJsonlSync(path, parsed)
    return { appended: true, shadowId: parsed.shadowId }
  })
}

export function evaluatePaperPolicyShadowLedger(
  observations: ShadowPriceObservation[],
  path = DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
): PaperPolicyShadowEvaluation {
  const state = readPaperPolicyShadowState(path)
  return evaluatePaperPolicyShadowState([...state.openById.values()], observations)
}

export function evaluatePaperPolicyShadowState(
  openShadows: ParsedPaperPolicyShadowOpen[],
  observations: ShadowPriceObservation[],
): PaperPolicyShadowEvaluation {
  const observationBySymbol = new Map(observations.map(observation => [observation.symbol, observation]))
  const dueOutcomes: PaperPolicyShadowOutcome[] = []
  const notDueShadows: ParsedPaperPolicyShadowOpen[] = []

  for (const shadow of openShadows) {
    const observation = observationBySymbol.get(shadow.symbol)
    if (!observation || observation.price <= 0) {
      notDueShadows.push(shadow)
      continue
    }

    const stopHit = isShadowStopHit(shadow, observation.price)
    const horizonExpired = observation.barTime - shadow.openBarTime >= shadow.horizonMs
    if (!stopHit && !horizonExpired) {
      notDueShadows.push(shadow)
      continue
    }

    dueOutcomes.push(buildPaperPolicyShadowOutcome(
      shadow,
      observation,
      stopHit ? 'shadow_stop_loss' : 'shadow_horizon_expired',
    ))
  }

  return { dueOutcomes, notDueShadows }
}

export function readPaperPolicyShadowLedger(
  path = DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
): PaperPolicyShadowLedgerEntry[] {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [PaperPolicyShadowLedgerEntrySchema.parse(JSON.parse(line))]
      } catch {
        return []
      }
    })
}

export function readOpenPaperPolicyShadows(
  path = DEFAULT_PAPER_POLICY_SHADOW_LEDGER_PATH,
): ParsedPaperPolicyShadowOpen[] {
  return [...readPaperPolicyShadowState(path).openById.values()]
}

export function paperPolicyShadowOpenMissingV3ContextFields(
  context: Record<string, unknown>,
): string[] {
  const missing: string[] = []
  const requiredStringFields = [
    'contextSnapshotId',
    'decisionTime',
    'featureSchemaVersion',
    'flashContextStatus',
  ]
  for (const field of requiredStringFields) {
    if (!nonEmptyString(context[field])) missing.push(field)
  }
  if (!nonEmptyString(context.marketDataWatermarkAtDecisionTime) && !nonEmptyString(context.watermark)) {
    missing.push('marketDataWatermarkAtDecisionTime_or_watermark')
  }
  if (typeof context.featuresAvailableAtDecisionTime !== 'boolean') {
    missing.push('featuresAvailableAtDecisionTime')
  }
  if (nonEmptyString(context.featureSchemaVersion) !== 'paper_open_context.v3') {
    missing.push('featureSchemaVersion_v3')
  }
  if (numberOrNull(context.contextGenerationAtOpen) == null) {
    missing.push('contextGenerationAtOpen')
  }
  if (numberOrNull(context.flashConfidenceLowAtOpen) == null) {
    missing.push('flashConfidenceLowAtOpen')
  }
  return missing
}

function readPaperPolicyShadowState(path: string): {
  openById: Map<string, ParsedPaperPolicyShadowOpen>
  closedIds: Set<string>
} {
  const openById = new Map<string, ParsedPaperPolicyShadowOpen>()
  const closedIds = new Set<string>()
  for (const entry of readPaperPolicyShadowLedger(path)) {
    if (entry.eventType === 'open') {
      if (!openById.has(entry.shadowId) && !closedIds.has(entry.shadowId)) {
        openById.set(entry.shadowId, entry)
      }
      continue
    }
    closedIds.add(entry.shadowId)
    openById.delete(entry.shadowId)
  }
  return { openById, closedIds }
}

const DEFAULT_APPEND_LOCK_WAIT_MS = 1_000
const DEFAULT_APPEND_LOCK_POLL_MS = 25

function withPaperPolicyShadowAppendLock(
  path: string,
  shadowId: string,
  options: AppendPaperPolicyShadowOptions,
  fn: () => AppendPaperPolicyShadowResult,
): AppendPaperPolicyShadowResult {
  const lockDir = options.lockDir ?? `${path}.append.lock`
  const waitMs = Math.max(0, options.lockWaitMs ?? DEFAULT_APPEND_LOCK_WAIT_MS)
  const pollMs = Math.max(1, options.lockPollMs ?? DEFAULT_APPEND_LOCK_POLL_MS)
  const deadline = Date.now() + waitMs
  let lock = acquireRuntimeLock(lockDir, {
    purpose: 'paper_policy_shadow_ledger_append',
  })

  while (!lock && Date.now() < deadline) {
    sleepSync(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    lock = acquireRuntimeLock(lockDir, {
      purpose: 'paper_policy_shadow_ledger_append',
    })
  }

  if (!lock) return { appended: false, shadowId, reason: 'ledger_locked' }
  try {
    return fn()
  } finally {
    lock.release()
  }
}

function sleepSync(ms: number): void {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  const view = new Int32Array(buffer)
  Atomics.wait(view, 0, 0, ms)
}

function isShadowStopHit(shadow: ParsedPaperPolicyShadowOpen, price: number): boolean {
  if (shadow.stopLossPrice === null) return false
  return shadow.side === 'long'
    ? price <= shadow.stopLossPrice
    : price >= shadow.stopLossPrice
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function buildPaperPolicyShadowOutcome(
  shadow: ParsedPaperPolicyShadowOpen,
  observation: ShadowPriceObservation,
  closeReason: PaperPolicyShadowCloseReason,
): PaperPolicyShadowOutcome {
  const rawReturn = shadow.side === 'long'
    ? (observation.price - shadow.entryPrice) / shadow.entryPrice
    : (shadow.entryPrice - observation.price) / shadow.entryPrice
  const pnlPct = roundFinite(rawReturn * 100)
  return PaperPolicyShadowOutcomeSchema.parse({
    counterfactualType: 'trade_level_shadow',
    eventType: 'closed',
    shadowId: shadow.shadowId,
    lane: shadow.lane,
    symbol: shadow.symbol,
    side: shadow.side,
    entryPrice: shadow.entryPrice,
    closePrice: observation.price,
    openTs: shadow.openTs,
    openBarTime: shadow.openBarTime,
    closeTs: observation.ts ?? new Date(observation.barTime).toISOString(),
    closeBarTime: observation.barTime,
    horizonMs: shadow.horizonMs,
    pnlPct,
    pnlUsd: shadow.notionalUsd === null ? null : roundFinite(rawReturn * shadow.notionalUsd),
    closeReason,
  })
}

function roundFinite(value: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(10)) : value
}
