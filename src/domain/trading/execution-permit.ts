import { z } from 'zod'
import {
  admissionDecisionId,
  gatePassed,
  tryLoadAdmissionDecision,
  validateAdmissionDecision,
  type AdmissionDecisionV1,
} from '../../runtime/admission.js'
import {
  resolveDataPath,
  resolveRuntimeRole,
  type RuntimeRole,
} from '../../runtime/runtime-paths.js'
import { sha256Canonical } from '../../sidecar/contracts.js'

export const EXECUTION_PERMIT_V1 = 'execution_permit.v1' as const
export const EXECUTION_PERMIT_MAX_TTL_MS = 60_000
export const DEFAULT_EXECUTION_PERMIT_TTL_MS = 15_000

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/

export type CryptoExecutionMode = 'paper_only' | 'live_guarded'
export type ExecutionPermitAction =
  | 'open'
  | 'reduce'
  | 'close'
  | 'cancel'
  | 'adjust_leverage'
  | 'sync'

export const executionPermitV1Schema = z.object({
  schemaVersion: z.literal(EXECUTION_PERMIT_V1),
  permitId: z.string().regex(SHA256_RE),
  decisionId: z.string().regex(SHA256_RE),
  candidateId: z.string().trim().min(1).max(300).nullable(),
  intentId: z.string().trim().min(1).max(300),
  action: z.enum(['open', 'reduce', 'close', 'cancel', 'adjust_leverage', 'sync']),
  riskReducing: z.boolean(),
  accountId: z.string().trim().min(1).max(200),
  accountMode: z.enum(['paper_only', 'live_guarded']),
  symbol: z.string().trim().min(1).max(100),
  side: z.enum(['buy', 'sell']).optional(),
  notionalUsd: z.number().positive().finite().optional(),
  ticketId: z.string().trim().min(1).max(300),
  idempotencyKey: z.string().trim().min(1).max(500),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sourceCommit: z.string().regex(COMMIT_RE),
  releaseManifestHash: z.string().regex(SHA256_RE),
  authoritySnapshotHash: z.string().regex(SHA256_RE),
  requiredChecks: z.array(z.string().trim().min(1).max(200)),
  approvalRefs: z.array(z.string().trim().min(1).max(500)),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'expiresAt must be later than issuedAt',
    })
  }
  if (value.accountId === '*' || value.symbol === '*') {
    ctx.addIssue({
      code: 'custom',
      path: ['accountId'],
      message: 'wildcard execution scope is forbidden',
    })
  }
  if ((value.action === 'reduce' || value.action === 'close') && !value.riskReducing) {
    ctx.addIssue({
      code: 'custom',
      path: ['riskReducing'],
      message: `${value.action} permits must be risk-reducing`,
    })
  }
})

export type ExecutionPermitV1 = z.infer<typeof executionPermitV1Schema>

export interface ExecutionAuthorityIdentity {
  runtimeRole: RuntimeRole
  sourceCommit: string
  dirtyStateHash: string
  releaseManifestHash: string
}

export interface ExecutionAuthoritySnapshot {
  decision: AdmissionDecisionV1
  identity: ExecutionAuthorityIdentity
}

export type ExecutionAuthorityProvider = (
  now?: Date,
) => Promise<ExecutionAuthoritySnapshot>

export interface ExecutionPermitRequest {
  intentId: string
  action: ExecutionPermitAction
  riskReducing: boolean
  accountId: string
  accountMode: CryptoExecutionMode
  symbol: string
  side?: 'buy' | 'sell'
  notionalUsd?: number
  ticketId: string
  idempotencyKey: string
  completedChecks: string[]
  now?: Date
  ttlMs?: number
}

export type ExecutionPermitDecision =
  | { allowed: true; permit: ExecutionPermitV1 }
  | { allowed: false; reasonCodes: string[] }

export interface VerifyExecutionPermitInput {
  permit: ExecutionPermitV1
  request: ExecutionPermitRequest
  snapshot: ExecutionAuthoritySnapshot
  now?: Date
}

export function issueExecutionPermit(
  request: ExecutionPermitRequest,
  snapshot: ExecutionAuthoritySnapshot,
): ExecutionPermitDecision {
  const now = request.now ?? new Date()
  const reasons = validateAuthorityForRequest(request, snapshot, now)
  const requiredChecks = requiredChecksFor(request)
  const completedChecks = new Set(request.completedChecks)
  for (const check of requiredChecks) {
    if (!completedChecks.has(check)) reasons.push(`required_check_missing:${check}`)
  }
  if (reasons.length > 0) {
    return { allowed: false, reasonCodes: sortedUnique(reasons) }
  }

  const decision = validateAdmissionDecision(snapshot.decision)
  const ttlMs = clampPermitTtl(request.ttlMs)
  const expiresAtMs = Math.min(
    now.getTime() + ttlMs,
    Date.parse(decision.expiresAt),
  )
  if (expiresAtMs <= now.getTime()) {
    return { allowed: false, reasonCodes: ['authority_snapshot_expired'] }
  }
  const core = {
    decisionId: decision.decisionId,
    candidateId: decision.candidateId,
    intentId: request.intentId,
    action: request.action,
    riskReducing: request.riskReducing,
    accountId: request.accountId,
    accountMode: request.accountMode,
    symbol: request.symbol,
    ...(request.side ? { side: request.side } : {}),
    ...(request.notionalUsd !== undefined ? { notionalUsd: request.notionalUsd } : {}),
    ticketId: request.ticketId,
    idempotencyKey: request.idempotencyKey,
    issuedAt: now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    sourceCommit: snapshot.identity.sourceCommit,
    releaseManifestHash: snapshot.identity.releaseManifestHash,
    authoritySnapshotHash: decision.decisionId,
    requiredChecks: sortedUnique(requiredChecks),
    approvalRefs: sortedUnique(decision.approvalRefs),
  }
  return {
    allowed: true,
    permit: executionPermitV1Schema.parse({
      schemaVersion: EXECUTION_PERMIT_V1,
      permitId: executionPermitId(core),
      ...core,
    }),
  }
}

export function verifyExecutionPermit(
  input: VerifyExecutionPermitInput,
): ExecutionPermitDecision {
  const now = input.now ?? new Date()
  let permit: ExecutionPermitV1
  try {
    permit = validateExecutionPermit(input.permit)
  } catch (error) {
    return {
      allowed: false,
      reasonCodes: [error instanceof Error ? error.message : String(error)],
    }
  }
  const reasons = validateAuthorityForRequest(input.request, input.snapshot, now)
  const expected = {
    decisionId: input.snapshot.decision.decisionId,
    candidateId: input.snapshot.decision.candidateId,
    intentId: input.request.intentId,
    action: input.request.action,
    riskReducing: input.request.riskReducing,
    accountId: input.request.accountId,
    accountMode: input.request.accountMode,
    symbol: input.request.symbol,
    ticketId: input.request.ticketId,
    idempotencyKey: input.request.idempotencyKey,
  }
  for (const [field, value] of Object.entries(expected)) {
    if (permit[field as keyof ExecutionPermitV1] !== value) {
      reasons.push(`permit_scope_mismatch:${field}`)
    }
  }
  if (input.request.side !== undefined && permit.side !== input.request.side) {
    reasons.push('permit_scope_mismatch:side')
  }
  if (
    input.request.notionalUsd !== undefined
    && permit.notionalUsd !== input.request.notionalUsd
  ) {
    reasons.push('permit_scope_mismatch:notionalUsd')
  }
  if (Date.parse(permit.expiresAt) <= now.getTime()) reasons.push('execution_permit_expired')
  if (Date.parse(permit.issuedAt) > now.getTime() + 30_000) {
    reasons.push('execution_permit_from_future')
  }
  if (permit.sourceCommit !== input.snapshot.identity.sourceCommit) {
    reasons.push('permit_source_commit_mismatch')
  }
  if (permit.releaseManifestHash !== input.snapshot.identity.releaseManifestHash) {
    reasons.push('permit_release_manifest_mismatch')
  }
  if (permit.authoritySnapshotHash !== input.snapshot.decision.decisionId) {
    reasons.push('permit_authority_snapshot_mismatch')
  }
  const completedChecks = new Set(input.request.completedChecks)
  for (const check of permit.requiredChecks) {
    if (!completedChecks.has(check)) reasons.push(`required_check_missing:${check}`)
  }
  return reasons.length > 0
    ? { allowed: false, reasonCodes: sortedUnique(reasons) }
    : { allowed: true, permit }
}

export function validateExecutionPermit(input: unknown): ExecutionPermitV1 {
  const permit = executionPermitV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, permitId, ...core } = permit
  if (executionPermitId(core) !== permitId) {
    throw new Error('execution_permit_hash_mismatch')
  }
  return permit
}

export function executionPermitId(
  permit: Omit<ExecutionPermitV1, 'schemaVersion' | 'permitId'>,
): string {
  return sha256Canonical(permit)
}

export async function issueAndVerifyExecutionPermit(
  provider: ExecutionAuthorityProvider,
  request: ExecutionPermitRequest,
): Promise<ExecutionPermitDecision> {
  let issuedFrom: ExecutionAuthoritySnapshot
  try {
    issuedFrom = await provider(request.now)
  } catch (error) {
    return {
      allowed: false,
      reasonCodes: [`authority_provider_failed:${error instanceof Error ? error.message : String(error)}`],
    }
  }
  const issued = issueExecutionPermit(request, issuedFrom)
  if (!issued.allowed) return issued

  let current: ExecutionAuthoritySnapshot
  try {
    current = await provider(request.now)
  } catch (error) {
    return {
      allowed: false,
      reasonCodes: [`authority_recheck_failed:${error instanceof Error ? error.message : String(error)}`],
    }
  }
  return verifyExecutionPermit({
    permit: issued.permit,
    request,
    snapshot: current,
    now: request.now,
  })
}

export function createEnvironmentExecutionAuthorityProvider(options: {
  admissionDecisionPath?: string
  env?: NodeJS.ProcessEnv
} = {}): ExecutionAuthorityProvider {
  const env = options.env ?? process.env
  const admissionDecisionPath = options.admissionDecisionPath
    ?? resolveDataPath('runtime', 'admission_decision.v1.json')
  return async (now = new Date()) => {
    const loaded = await tryLoadAdmissionDecision(admissionDecisionPath, { now })
    if (loaded.kind !== 'loaded') {
      throw new Error(`${loaded.kind}:${loaded.error}`)
    }
    return {
      decision: loaded.decision,
      identity: {
        runtimeRole: resolveRuntimeRole(env.OPENALICE_RUNTIME_ROLE),
        sourceCommit: requiredEnv(env, 'OPENALICE_SOURCE_COMMIT', COMMIT_RE),
        dirtyStateHash: requiredEnv(env, 'OPENALICE_DIRTY_STATE_HASH', SHA256_RE),
        releaseManifestHash: requiredEnv(
          env,
          'OPENALICE_RELEASE_MANIFEST_HASH',
          SHA256_RE,
        ),
      },
    }
  }
}

function validateAuthorityForRequest(
  request: ExecutionPermitRequest,
  snapshot: ExecutionAuthoritySnapshot,
  now: Date,
): string[] {
  const reasons: string[] = []
  let decision: AdmissionDecisionV1
  try {
    decision = validateAdmissionDecision(snapshot.decision)
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)]
  }
  if (snapshot.identity.runtimeRole !== 'primary') reasons.push('runtime_role_not_primary')
  if (decision.sourceCommit !== snapshot.identity.sourceCommit) {
    reasons.push('authority_source_commit_mismatch')
  }
  if (decision.dirtyStateHash !== snapshot.identity.dirtyStateHash) {
    reasons.push('authority_dirty_state_hash_mismatch')
  }
  if (decision.releaseManifestHash !== snapshot.identity.releaseManifestHash) {
    reasons.push('authority_release_manifest_mismatch')
  }
  if (Date.parse(decision.expiresAt) <= now.getTime()) reasons.push('authority_snapshot_expired')
  if (Date.parse(decision.evaluatedAt) > now.getTime() + 30_000) {
    reasons.push('authority_snapshot_from_future')
  }
  if (!decision.accountScope.includes(request.accountId)) reasons.push('account_out_of_scope')
  if (!decision.assetScope.includes(request.symbol)) reasons.push('asset_out_of_scope')
  if (!request.ticketId.trim()) reasons.push('decision_ticket_missing')
  if (!request.idempotencyKey.trim()) reasons.push('idempotency_key_missing')

  const riskIncreasing = isRiskIncreasing(request)
  if (riskIncreasing) {
    for (const gateId of ['promotion_v2_6', 'risk', 'kill_switch', 'data_freshness']) {
      if (!gatePassed(decision, gateId)) reasons.push(`admission_gate_not_passed:${gateId}`)
    }
    if (request.accountMode === 'paper_only') {
      if (!decision.paperTradingAllowed) reasons.push('paper_trading_not_allowed')
    } else {
      if (!decision.liveTradingAllowed) reasons.push('live_trading_not_allowed')
      if (!decision.liveExecutionArmed) reasons.push('live_execution_not_armed')
      if (!gatePassed(decision, 'live_dual_approval')) {
        reasons.push('live_dual_approval_not_passed')
      }
      if (decision.approvalRefs.length < 2) reasons.push('live_dual_approval_refs_missing')
    }
  } else if (!request.riskReducing && request.action !== 'sync') {
    reasons.push('risk_reduction_not_proven')
  }
  return sortedUnique(reasons)
}

function requiredChecksFor(request: ExecutionPermitRequest): string[] {
  const checks = [
    'account_fresh',
    'authority_fresh',
    'idempotency_reserved',
    'market_data_fresh',
    'positions_fresh',
    'ticket_valid',
  ]
  if (request.action !== 'sync') checks.push('kill_switch_passed')
  if (isRiskIncreasing(request)) {
    checks.push(
      'limits_passed',
      'risk_passed',
    )
    if (request.action === 'open') checks.push('slippage_policy_loaded')
  } else if (request.action !== 'sync') {
    checks.push('risk_reduction_proven')
  }
  return checks
}

function isRiskIncreasing(request: ExecutionPermitRequest): boolean {
  return request.action === 'open'
    || ((request.action === 'adjust_leverage' || request.action === 'cancel')
      && !request.riskReducing)
}

function requiredEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp,
): string {
  const value = env[name]?.trim()
  if (!value || !pattern.test(value)) throw new Error(`${name}_missing_or_invalid`)
  return value
}

function clampPermitTtl(value: number | undefined): number {
  const requested = value ?? DEFAULT_EXECUTION_PERMIT_TTL_MS
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('execution permit TTL must be positive')
  }
  return Math.min(Math.floor(requested), EXECUTION_PERMIT_MAX_TTL_MS)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

export function assertAdmissionDecisionIntegrity(decision: AdmissionDecisionV1): void {
  const { schemaVersion: _schemaVersion, decisionId, ...core } = decision
  if (admissionDecisionId(core) !== decisionId) {
    throw new Error('admission_decision_hash_mismatch')
  }
}
