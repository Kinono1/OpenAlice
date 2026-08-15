import { readFile } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { EventLog } from '../core/event-log.js'
import { resolveManualOverrideSecret } from '../core/manual-override-secret.js'

/**
 * Manual override — a control-plane file that can pause new opens, bypass
 * release/regime gates, and inject force-overrides for risk inputs.
 *
 * Because the override is a privileged short-circuit around the gate manager,
 * the loader requires the file to be:
 *   1. Signed (HMAC-SHA256 of canonical JSON, hex)
 *   2. Bounded by `issuedAt` and `expiresAt` (≤ 1h TTL)
 *   3. Tagged with `reason` and `issuedBy` for audit
 *   4. Multi-signed (`approvedBy.length >= 2` after dedupe) when any
 *      high-risk field is set
 *
 * Any failed precondition causes the loader to fall back to
 * `DEFAULT_MANUAL_OVERRIDE` (no override) and emit an event log entry.
 * The `manual_override.applied` event is emitted only when ALL preconditions
 * — including signature and multi-sig — are satisfied.
 */
export interface ManualOverride {
  pauseNewOpens: boolean
  ignoreReleaseGate?: boolean
  ignoreRegimeShift?: boolean
  forceCapitalRampStage?: string
  forceVolatilityQuantile?: number
  forceDailyLossPct?: number
  forceCvarDailyLossPct?: number
  forceConsecutiveLossDays?: number
  forceConsecutiveLossPct?: number
  note?: string
  updatedAt?: string
}

export interface SignedManualOverride extends ManualOverride {
  reason: string
  issuedBy: string
  issuedAt: string
  expiresAt: string
  signature: string
  approvedBy?: string[]
}

export const DEFAULT_MANUAL_OVERRIDE: ManualOverride = {
  pauseNewOpens: false,
}

export const HIGH_RISK_FIELDS = [
  'forceCapitalRampStage',
  'forceVolatilityQuantile',
  'forceDailyLossPct',
  'forceCvarDailyLossPct',
  'forceConsecutiveLossDays',
  'forceConsecutiveLossPct',
  'ignoreReleaseGate',
  'ignoreRegimeShift',
] as const

export type HighRiskField = (typeof HIGH_RISK_FIELDS)[number]

/** Maximum allowed gap between issuedAt and expiresAt — 1 hour. */
export const MANUAL_OVERRIDE_TTL_MAX_MS = 3_600_000

const ISO_DATETIME = z.string().datetime({ offset: true })

const SIGNED_OVERRIDE_SCHEMA = z
  .object({
    pauseNewOpens: z.boolean().optional(),
    ignoreReleaseGate: z.boolean().optional(),
    ignoreRegimeShift: z.boolean().optional(),
    forceCapitalRampStage: z.string().min(1).max(100).optional(),
    forceVolatilityQuantile: z.number().min(0).max(1).optional(),
    // Daily PnL / CVaR / cumulative loss fields accept negative values
    // because they represent realized losses (e.g., -2 means 2% daily loss).
    forceDailyLossPct: z.number().min(-100).max(100).optional(),
    forceCvarDailyLossPct: z.number().min(-100).max(100).optional(),
    forceConsecutiveLossDays: z.number().int().min(0).max(365).optional(),
    forceConsecutiveLossPct: z.number().min(-100).max(100).optional(),
    note: z.string().max(2000).optional(),
    updatedAt: z.string().optional(),
    reason: z.string().min(1).max(500),
    issuedBy: z.string().min(1).max(200),
    issuedAt: ISO_DATETIME,
    expiresAt: ISO_DATETIME,
    signature: z.string().min(1),
    approvedBy: z.array(z.string().min(1).max(200)).optional(),
  })
  .strict()

export interface LoadManualOverrideOptions {
  filePath?: string
  eventLog?: EventLog
  env?: NodeJS.ProcessEnv
  now?: Date
}

/**
 * Canonical JSON used as the HMAC payload. Stable against:
 *   1. Field reordering (top-level keys are sorted alphabetically)
 *   2. Date formatting variance (issuedAt/expiresAt re-emitted as ISO 8601 UTC)
 *   3. approvedBy ordering and duplicates (deduped + sorted)
 *   4. Unknown / additional fields (only allow-listed fields are included)
 *
 * Exported so the signing CLI (`scripts/sign_manual_override.ts`) can use
 * the exact same payload representation as the loader.
 */
export function canonicalizeManualOverride(parsed: SignedManualOverride): string {
  const allowedFields = [
    'pauseNewOpens',
    'ignoreReleaseGate',
    'ignoreRegimeShift',
    'forceCapitalRampStage',
    'forceVolatilityQuantile',
    'forceDailyLossPct',
    'forceCvarDailyLossPct',
    'forceConsecutiveLossDays',
    'forceConsecutiveLossPct',
    'note',
    'reason',
    'issuedBy',
    'issuedAt',
    'expiresAt',
    'approvedBy',
  ] as const
  const out: Record<string, unknown> = {}
  for (const k of allowedFields) {
    const value = (parsed as unknown as Record<string, unknown>)[k]
    if (value === undefined) continue
    if (k === 'approvedBy' && Array.isArray(value)) {
      const trimmed = value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
      out[k] = [...new Set(trimmed)].sort()
      continue
    }
    if ((k === 'issuedAt' || k === 'expiresAt') && typeof value === 'string') {
      const ms = Date.parse(value)
      if (Number.isFinite(ms)) {
        out[k] = new Date(ms).toISOString()
        continue
      }
    }
    out[k] = value
  }
  const sorted = Object.keys(out)
    .sort()
    .reduce((acc, k) => {
      acc[k] = out[k]
      return acc
    }, {} as Record<string, unknown>)
  return JSON.stringify(sorted)
}

/** Compute the HMAC-SHA256 hex digest of the canonical payload. */
export function signManualOverridePayload(
  secret: string,
  parsed: SignedManualOverride,
): string {
  return createHmac('sha256', secret)
    .update(canonicalizeManualOverride(parsed), 'utf8')
    .digest('hex')
}

/** Constant-time signature verification (returns false on any structural error). */
export function verifyManualOverrideSignature(
  secret: string,
  parsed: SignedManualOverride,
): boolean {
  if (typeof parsed.signature !== 'string' || parsed.signature.length === 0) {
    return false
  }
  let actualBuf: Buffer
  try {
    actualBuf = Buffer.from(parsed.signature, 'hex')
  } catch {
    return false
  }
  const expected = signManualOverridePayload(secret, parsed)
  const expectedBuf = Buffer.from(expected, 'hex')
  if (
    expectedBuf.length === 0 ||
    actualBuf.length === 0 ||
    expectedBuf.length !== actualBuf.length
  ) {
    return false
  }
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * Compute which high-risk fields are actually set (not undefined / not the
 * "no-op" default). Used to decide whether multi-sig is required.
 */
export function listSetHighRiskFields(parsed: SignedManualOverride): HighRiskField[] {
  const out: HighRiskField[] = []
  for (const field of HIGH_RISK_FIELDS) {
    const value = (parsed as unknown as Record<string, unknown>)[field]
    if (value === undefined || value === null) continue
    if (typeof value === 'boolean' && value === false) continue
    out.push(field)
  }
  return out
}

async function recordEvent(
  eventLog: EventLog | undefined,
  type: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!eventLog) return
  try {
    await eventLog.append(type, payload)
  } catch {
    // Audit log failure must not block the main verification logic.
  }
}

export async function loadManualOverride(
  options: LoadManualOverrideOptions = {},
): Promise<ManualOverride> {
  const filePath = options.filePath ?? 'data/runtime/manual_override.json'
  const eventLog = options.eventLog
  const env = options.env ?? process.env
  const now = options.now ?? new Date()

  // 1) ENOENT — no override; do not emit any audit event.
  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { ...DEFAULT_MANUAL_OVERRIDE }
    }
    await recordEvent(eventLog, 'manual_override.read_error', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 2) JSON parse
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(raw)
  } catch (err) {
    await recordEvent(eventLog, 'manual_override.invalid_json', {
      filePath,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 3) Schema validation
  const parseResult = SIGNED_OVERRIDE_SCHEMA.safeParse(parsedJson)
  if (!parseResult.success) {
    await recordEvent(eventLog, 'manual_override.schema_invalid', {
      filePath,
      issues: parseResult.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message,
      })),
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }
  const parsed = parseResult.data as SignedManualOverride

  // 4) Timestamp validity
  const issuedMs = Date.parse(parsed.issuedAt)
  const expiresMs = Date.parse(parsed.expiresAt)
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs) || expiresMs <= issuedMs) {
    await recordEvent(eventLog, 'manual_override.timestamp_invalid', {
      filePath,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 5) Expired
  const nowMs = now.getTime()
  if (expiresMs <= nowMs) {
    await recordEvent(eventLog, 'manual_override.expired', {
      filePath,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      issuedBy: parsed.issuedBy,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 6) TTL upper bound
  if (expiresMs - issuedMs > MANUAL_OVERRIDE_TTL_MAX_MS) {
    await recordEvent(eventLog, 'manual_override.ttl_exceeded', {
      filePath,
      issuedAt: parsed.issuedAt,
      expiresAt: parsed.expiresAt,
      ttlMs: expiresMs - issuedMs,
      ttlMaxMs: MANUAL_OVERRIDE_TTL_MAX_MS,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 7) Secret missing (only after a syntactically valid, non-expired override exists)
  const secret = resolveManualOverrideSecret(env)
  if (!secret) {
    await recordEvent(eventLog, 'manual_override.secret_missing', {
      filePath,
      issuedBy: parsed.issuedBy,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 8) Signature
  if (!verifyManualOverrideSignature(secret, parsed)) {
    await recordEvent(eventLog, 'manual_override.signature_invalid', {
      filePath,
      issuedBy: parsed.issuedBy,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 9) Multi-sig required for high-risk fields
  const setHighRiskFields = listSetHighRiskFields(parsed)
  if (setHighRiskFields.length > 0) {
    const dedupedApprovers = new Set(
      (parsed.approvedBy ?? [])
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0),
    )
    if (dedupedApprovers.size < 2) {
      await recordEvent(eventLog, 'manual_override.multi_sig_required', {
        filePath,
        issuedBy: parsed.issuedBy,
        highRiskFields: setHighRiskFields,
        approvedByCount: dedupedApprovers.size,
        requiredApprovers: 2,
      })
      return { ...DEFAULT_MANUAL_OVERRIDE }
    }
  }

  // 10) Apply
  const effective = normalizeManualOverride(parsed)
  await recordEvent(eventLog, 'manual_override.applied', {
    filePath,
    issuedBy: parsed.issuedBy,
    reason: parsed.reason,
    issuedAt: parsed.issuedAt,
    expiresAt: parsed.expiresAt,
    setHighRiskFields,
    effectiveFields: pickDefinedFields(effective),
  })
  return effective
}

export function normalizeManualOverride(raw: unknown): ManualOverride {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }
  const value = raw as Record<string, unknown>
  const out: ManualOverride = {
    pauseNewOpens: Boolean(value.pauseNewOpens),
  }
  if (value.ignoreReleaseGate !== undefined) {
    out.ignoreReleaseGate = Boolean(value.ignoreReleaseGate)
  }
  if (value.ignoreRegimeShift !== undefined) {
    out.ignoreRegimeShift = Boolean(value.ignoreRegimeShift)
  }
  if (
    typeof value.forceCapitalRampStage === 'string' &&
    value.forceCapitalRampStage.trim()
  ) {
    out.forceCapitalRampStage = value.forceCapitalRampStage.trim()
  }
  if (isFiniteNumber(value.forceVolatilityQuantile)) {
    out.forceVolatilityQuantile = value.forceVolatilityQuantile
  }
  if (isFiniteNumber(value.forceDailyLossPct)) {
    out.forceDailyLossPct = value.forceDailyLossPct
  }
  if (isFiniteNumber(value.forceCvarDailyLossPct)) {
    out.forceCvarDailyLossPct = value.forceCvarDailyLossPct
  }
  if (isFiniteNumber(value.forceConsecutiveLossDays)) {
    out.forceConsecutiveLossDays = Math.max(
      0,
      Math.floor(value.forceConsecutiveLossDays),
    )
  }
  if (isFiniteNumber(value.forceConsecutiveLossPct)) {
    out.forceConsecutiveLossPct = value.forceConsecutiveLossPct
  }
  if (typeof value.note === 'string' && value.note.trim()) {
    out.note = value.note.trim()
  }
  if (typeof value.updatedAt === 'string' && value.updatedAt.trim()) {
    out.updatedAt = value.updatedAt.trim()
  }
  return out
}

function pickDefinedFields(value: ManualOverride): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
