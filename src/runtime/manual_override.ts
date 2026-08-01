import { readFile } from 'node:fs/promises'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { EventLog } from '../core/event-log.js'
import { resolveManualOverrideSecret } from '../core/manual-override-secret.js'

/**
 * Manual override — a control-plane file that can pause new opens and tighten
 * risk inputs. Legacy release/regime bypass fields remain parse-compatible,
 * but they never produce a permissive effect.
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
  candidateId?: string | null
  sourceCommit?: string
  releaseManifestHash?: string
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
const COMMIT_SHA = z.string().regex(/^[a-f0-9]{40}$/)
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/)

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
    candidateId: z.string().min(1).max(300).nullable().optional(),
    sourceCommit: COMMIT_SHA.optional(),
    releaseManifestHash: SHA256.optional(),
  })
  .strict()

export interface LoadManualOverrideOptions {
  filePath?: string
  eventLog?: EventLog
  env?: NodeJS.ProcessEnv
  now?: Date
  expectedCandidateId?: string | null
  expectedSourceCommit?: string
  expectedReleaseManifestHash?: string
}

export type LoadManualOverrideInput = LoadManualOverrideOptions | string

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
    'candidateId',
    'sourceCommit',
    'releaseManifestHash',
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
  input: LoadManualOverrideInput = {},
): Promise<ManualOverride> {
  const options = typeof input === 'string' ? { filePath: input } : input
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

  // 9) Candidate/release binding. When the caller supplies an authority
  // binding, the signed override must carry exactly the same values. Missing
  // bindings are treated as mismatches rather than implicit wildcards.
  const bindingMismatches = listBindingMismatches(parsed, options)
  if (bindingMismatches.length > 0) {
    await recordEvent(eventLog, 'manual_override.binding_mismatch', {
      filePath,
      issuedBy: parsed.issuedBy,
      fields: bindingMismatches,
    })
    return { ...DEFAULT_MANUAL_OVERRIDE }
  }

  // 10) Multi-sig required for high-risk fields
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

  // 11) Legacy permissive flags are audit-only. They remain in the signed
  // payload for compatibility, but are never copied to the effective result.
  const rejectedLegacyFields = [
    parsed.ignoreReleaseGate === true ? 'ignoreReleaseGate' : null,
    parsed.ignoreRegimeShift === true ? 'ignoreRegimeShift' : null,
  ].filter((field): field is string => field !== null)
  if (rejectedLegacyFields.length > 0) {
    await recordEvent(eventLog, 'manual_override.legacy_override_rejected', {
      filePath,
      issuedBy: parsed.issuedBy,
      reasonCode: 'legacy_override_rejected',
      fields: rejectedLegacyFields,
    })
  }

  // 12) Apply only monotonic, risk-tightening fields.
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

export interface ManualRiskBaseline {
  capitalRampStage: string
  volatilityQuantile?: number
  dailyLossPct?: number
  cvarDailyLossPct?: number
  consecutiveLossDays?: number
  consecutiveLossPct?: number
}

export interface MonotonicManualOverrideResult {
  value: ManualRiskBaseline
  appliedFields: string[]
  rejectedFields: string[]
}

/**
 * Merge a verified override into runtime risk inputs without ever making the
 * result less conservative. Higher volatility/loss-day values, more-negative
 * loss percentages, and lower capital allocation are the only accepted moves.
 */
export function applyMonotonicManualOverride(
  override: ManualOverride,
  baseline: ManualRiskBaseline,
): MonotonicManualOverrideResult {
  const value: ManualRiskBaseline = { ...baseline }
  const appliedFields: string[] = []
  const rejectedFields: string[] = []

  applyHigherSeverityNumber(
    'forceVolatilityQuantile',
    override.forceVolatilityQuantile,
    baseline.volatilityQuantile,
    (next) => { value.volatilityQuantile = next },
    appliedFields,
    rejectedFields,
  )
  applyLowerSeverityNumber(
    'forceDailyLossPct',
    override.forceDailyLossPct,
    baseline.dailyLossPct,
    (next) => { value.dailyLossPct = next },
    appliedFields,
    rejectedFields,
  )
  applyLowerSeverityNumber(
    'forceCvarDailyLossPct',
    override.forceCvarDailyLossPct,
    baseline.cvarDailyLossPct,
    (next) => { value.cvarDailyLossPct = next },
    appliedFields,
    rejectedFields,
  )
  applyHigherSeverityNumber(
    'forceConsecutiveLossDays',
    override.forceConsecutiveLossDays,
    baseline.consecutiveLossDays,
    (next) => { value.consecutiveLossDays = Math.floor(next) },
    appliedFields,
    rejectedFields,
  )
  applyLowerSeverityNumber(
    'forceConsecutiveLossPct',
    override.forceConsecutiveLossPct,
    baseline.consecutiveLossPct,
    (next) => { value.consecutiveLossPct = next },
    appliedFields,
    rejectedFields,
  )

  if (override.forceCapitalRampStage !== undefined) {
    const currentPct = parseRampStagePct(baseline.capitalRampStage)
    const requestedPct = parseRampStagePct(override.forceCapitalRampStage)
    if (
      currentPct !== null
      && requestedPct !== null
      && requestedPct <= currentPct
      && [5, 10, 25, 50, 100].includes(requestedPct)
    ) {
      value.capitalRampStage = `${requestedPct}%`
      appliedFields.push('forceCapitalRampStage')
    } else {
      rejectedFields.push('forceCapitalRampStage')
    }
  }

  return {
    value,
    appliedFields: sortedUnique(appliedFields),
    rejectedFields: sortedUnique(rejectedFields),
  }
}

function listBindingMismatches(
  parsed: SignedManualOverride,
  options: LoadManualOverrideOptions,
): string[] {
  const mismatches: string[] = []
  if (
    options.expectedCandidateId !== undefined
    && parsed.candidateId !== options.expectedCandidateId
  ) {
    mismatches.push('candidateId')
  }
  if (
    options.expectedSourceCommit !== undefined
    && parsed.sourceCommit !== options.expectedSourceCommit
  ) {
    mismatches.push('sourceCommit')
  }
  if (
    options.expectedReleaseManifestHash !== undefined
    && parsed.releaseManifestHash !== options.expectedReleaseManifestHash
  ) {
    mismatches.push('releaseManifestHash')
  }
  return mismatches.sort()
}

function applyHigherSeverityNumber(
  field: string,
  requested: number | undefined,
  baseline: number | undefined,
  apply: (value: number) => void,
  appliedFields: string[],
  rejectedFields: string[],
): void {
  if (requested === undefined) return
  if (baseline === undefined) {
    rejectedFields.push(field)
  } else if (requested >= baseline) {
    apply(requested)
    appliedFields.push(field)
  } else {
    rejectedFields.push(field)
  }
}

function applyLowerSeverityNumber(
  field: string,
  requested: number | undefined,
  baseline: number | undefined,
  apply: (value: number) => void,
  appliedFields: string[],
  rejectedFields: string[],
): void {
  if (requested === undefined) return
  if (baseline === undefined) {
    rejectedFields.push(field)
  } else if (requested <= baseline) {
    apply(requested)
    appliedFields.push(field)
  } else {
    rejectedFields.push(field)
  }
}

function parseRampStagePct(value: string): number | null {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/)
  if (!match) return null
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : null
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

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
