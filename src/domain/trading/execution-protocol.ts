import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto'
import Decimal from 'decimal.js'
import { z } from 'zod'
import {
  validateExecutionPermit,
  verifyExecutionPermit,
  type ExecutionAuthorityProvider,
  type ExecutionPermitRequest,
  type ExecutionPermitV1,
} from './execution-permit.js'
import { sha256Canonical, stableStringify } from '../../sidecar/contracts.js'

export const EXECUTION_COMMAND_PAYLOAD_V1 = 'openalice_execution_command_payload.v1' as const
export const EXECUTION_COMMAND_V1 = 'openalice_execution_command.v1' as const
export const EXECUTION_PERMIT_V2 = 'openalice_execution_permit.v2' as const
export const EXECUTION_EVENT_V1 = 'openalice_execution_event.v1' as const
export const EXECUTION_EVENT_V2 = 'openalice_execution_event.v2' as const
export const OFFLINE_EXECUTION_RECEIPT_EVIDENCE_V1
  = 'openalice_offline_execution_receipt.v1' as const

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/
const OKX_CLIENT_ORDER_ID_RE = /^[A-Za-z0-9]{1,32}$/
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/
const UINT_RE = /^(?:0|[1-9][0-9]*)$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const UTC_MILLISECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const canonicalText = (max: number) => z.string().min(1).max(max).refine(
  value => value === value.trim(),
  'leading or trailing whitespace is not canonical',
)
const positiveDecimalString = z.string().regex(DECIMAL_RE, 'canonical positive decimal string')
  .refine(value => value !== '0', 'decimal must be positive')
const uint64String = z.string().regex(UINT_RE, 'canonical uint64 decimal string').refine(
  value => BigInt(value) <= 18_446_744_073_709_551_615n,
  'value exceeds uint64',
)
const positiveSequenceString = uint64String.refine(value => value !== '0', 'sequence must be positive')
const hash = z.string().regex(SHA256_RE)
const mode = z.enum(['PAPER_LOCAL', 'PAPER_EXCHANGE'])
const timeInForce = z.enum(['GTC', 'IOC', 'FOK'])
const okxClientOrderId = z.string().regex(
  OKX_CLIENT_ORDER_ID_RE,
  'OKX client_order_id must be ASCII alphanumeric and at most 32 characters',
)
const canonicalTimestamp = z.string().regex(UTC_MILLISECOND_RE).refine(
  value => {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
  },
  'timestamp must be a real canonical UTC timestamp with millisecond precision',
)
const canonicalBase64Signature = z.string().regex(BASE64_RE).refine(
  value => {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === 64 && decoded.toString('base64') === value
  },
  'Ed25519 signature must be canonical base64 encoding of 64 bytes',
)

const commandBase = {
  schemaVersion: z.literal(EXECUTION_COMMAND_PAYLOAD_V1),
  accountId: canonicalText(200),
  canonicalSymbol: z.literal('BTC/USDT'),
  venue: z.literal('OKX'),
  venueInstrumentId: z.literal('BTC-USDT'),
  idempotencyKey: canonicalText(500),
  mode,
} as const

const rawExecutionCommandPayloadV1Schema = z.discriminatedUnion('kind', [
  z.object({
    ...commandBase,
    kind: z.literal('submit'),
    clientOrderId: okxClientOrderId,
    side: z.enum(['buy', 'sell']),
    orderType: z.literal('limit'),
    quantity: positiveDecimalString,
    price: positiveDecimalString,
    timeInForce,
    reduceOnly: z.boolean(),
    maxNotionalUsd: positiveDecimalString,
  }).strict().superRefine((value, ctx) => {
    if (new Decimal(value.quantity).mul(value.price).gt(value.maxNotionalUsd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxNotionalUsd'],
        message: 'limit order notional exceeds authorized maximum; market orders are not supported',
      })
    }
  }),
  z.object({
    ...commandBase,
    kind: z.literal('cancel'),
    targetClientOrderId: okxClientOrderId,
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('replace'),
    targetClientOrderId: okxClientOrderId,
    replacementClientOrderId: okxClientOrderId,
    quantity: positiveDecimalString,
    price: positiveDecimalString,
    timeInForce,
    maxNotionalUsd: positiveDecimalString,
  }).strict().superRefine((value, ctx) => {
    if (value.targetClientOrderId === value.replacementClientOrderId) {
      ctx.addIssue({
        code: 'custom',
        path: ['replacementClientOrderId'],
        message: 'replace requires a new client order id',
      })
    }
    if (new Decimal(value.quantity).mul(value.price).gt(value.maxNotionalUsd)) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxNotionalUsd'],
        message: 'replacement notional exceeds authorized maximum',
      })
    }
  }),
  z.object({
    ...commandBase,
    kind: z.literal('reconcile'),
    afterSequence: uint64String.optional(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('suspend'),
    reason: canonicalText(500),
  }).strict(),
])

export const executionCommandPayloadV1Schema = rawExecutionCommandPayloadV1Schema
  .superRefine((value, ctx) => {
    const expectedInstrument = value.canonicalSymbol.replace('/', '-')
    if (value.venueInstrumentId !== expectedInstrument) {
      ctx.addIssue({
        code: 'custom',
        path: ['venueInstrumentId'],
        message: 'MVP accepts the exact OKX spot instrument derived from canonicalSymbol',
      })
    }
    if (value.kind === 'submit') {
      const expected = deriveOkxClientOrderId(value.idempotencyKey)
      if (value.clientOrderId !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['clientOrderId'],
          message: 'submit clientOrderId must be deterministically derived from idempotencyKey',
        })
      }
    }
    if (value.kind === 'replace') {
      const expected = deriveOkxClientOrderId(value.idempotencyKey)
      if (value.replacementClientOrderId !== expected) {
        ctx.addIssue({
          code: 'custom',
          path: ['replacementClientOrderId'],
          message: 'replacementClientOrderId must be deterministically derived from idempotencyKey',
        })
      }
    }
  })

export type ExecutionCommandPayloadV1 = z.infer<typeof executionCommandPayloadV1Schema>

export const executionCommandV1Schema = z.object({
  schemaVersion: z.literal(EXECUTION_COMMAND_V1),
  commandId: hash,
  payloadHash: hash,
  payload: executionCommandPayloadV1Schema,
}).strict().superRefine((value, ctx) => {
  const expected = sha256Canonical(value.payload)
  if (value.commandId !== expected || value.payloadHash !== expected) {
    ctx.addIssue({ code: 'custom', path: ['commandId'], message: 'command id must equal payload hash' })
  }
})

export type ExecutionCommandV1 = z.infer<typeof executionCommandV1Schema>

export const executionPermitV2Schema = z.object({
  schemaVersion: z.literal(EXECUTION_PERMIT_V2),
  permitId: hash,
  decisionId: hash,
  candidateId: canonicalText(300).nullable(),
  intentId: canonicalText(300),
  ticketId: canonicalText(300),
  commandHash: hash,
  action: z.literal('submit'),
  authorityAction: z.literal('open'),
  riskReducing: z.literal(false),
  scope: z.literal('paper_only'),
  accountId: canonicalText(200),
  canonicalSymbol: z.literal('BTC/USDT'),
  venueInstrumentId: z.literal('BTC-USDT'),
  idempotencyKey: canonicalText(500),
  side: z.literal('buy'),
  authorizedNotionalUsd: positiveDecimalString,
  mode,
  sourceCommit: z.string().regex(COMMIT_RE),
  releaseManifestHash: hash,
  authoritySnapshotHash: hash,
  requiredChecks: z.array(canonicalText(200)),
  approvalRefs: z.array(canonicalText(500)),
  issuedAt: canonicalTimestamp,
  expiresAt: canonicalTimestamp,
  keyId: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
  signature: canonicalBase64Signature,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be later than issuedAt' })
  }
})

export type ExecutionPermitV2 = z.infer<typeof executionPermitV2Schema>

const executionEventKind = z.enum([
  'acknowledged',
  'submitted',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'submission_unknown',
  'reconciled',
  'drift',
  'suspended',
])

const adapterExecutionEventKind = z.enum([
  'submitted',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'submission_unknown',
])

interface ExecutionEventProjection {
  readonly kind: string
  readonly clientOrderId?: string
  readonly venueOrderId?: string
  readonly filledQuantity?: string
  readonly averagePrice?: string
  readonly reason?: string
}

function refineExecutionEventProjection(
  value: ExecutionEventProjection,
  ctx: z.RefinementCtx,
  options: { readonly adapterEvidence: boolean },
): void {
  if (value.kind === 'partially_filled' || value.kind === 'filled') {
    if (!value.filledQuantity || !value.averagePrice) {
      ctx.addIssue({ code: 'custom', path: ['filledQuantity'], message: 'fill events require quantity and price' })
    }
  } else if (value.filledQuantity !== undefined || value.averagePrice !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['filledQuantity'], message: 'only fill events may carry fill fields' })
  }
  if (
    ['rejected', 'expired', 'submission_unknown', 'drift', 'suspended'].includes(value.kind)
    && value.reason === undefined
  ) {
    ctx.addIssue({ code: 'custom', path: ['reason'], message: `${value.kind} events require a reason` })
  }
  if (options.adapterEvidence) {
    if (value.clientOrderId === undefined) {
      ctx.addIssue({ code: 'custom', path: ['clientOrderId'], message: 'adapter events require client order identity' })
    }
    if (
      ['submitted', 'partially_filled', 'filled', 'canceled', 'expired'].includes(value.kind)
      && value.venueOrderId === undefined
    ) {
      ctx.addIssue({ code: 'custom', path: ['venueOrderId'], message: `${value.kind} requires source order identity` })
    }
  }
}

const executionEventCoreV1Schema = z.object({
  schemaVersion: z.literal(EXECUTION_EVENT_V1),
  commandId: hash,
  sequence: positiveSequenceString,
  occurredAt: canonicalTimestamp,
  kind: executionEventKind,
  clientOrderId: okxClientOrderId.optional(),
  venueOrderId: canonicalText(200).optional(),
  filledQuantity: positiveDecimalString.optional(),
  averagePrice: positiveDecimalString.optional(),
  reason: canonicalText(500).optional(),
}).strict().superRefine((value, ctx) => {
  refineExecutionEventProjection(value, ctx, { adapterEvidence: false })
})

export const executionEventV1Schema = executionEventCoreV1Schema.extend({
  eventId: hash,
}).strict().superRefine((value, ctx) => {
  const { eventId, ...core } = value
  if (sha256Canonical(core) !== eventId) {
    ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'event id must equal the event core hash' })
  }
})

export type ExecutionEventV1 = z.infer<typeof executionEventV1Schema>

/** Structural wire validation only; receipt semantics require the offline-receipt binder. */
export const executionEventV2Schema = z.object({
  schemaVersion: z.literal(EXECUTION_EVENT_V2),
  eventId: hash,
  commandId: hash,
  sequence: positiveSequenceString,
  occurredAt: canonicalTimestamp,
  kind: adapterExecutionEventKind,
  clientOrderId: okxClientOrderId,
  venueOrderId: canonicalText(200).optional(),
  filledQuantity: positiveDecimalString.optional(),
  averagePrice: positiveDecimalString.optional(),
  reason: canonicalText(500).optional(),
  evidenceSchemaVersion: z.literal(OFFLINE_EXECUTION_RECEIPT_EVIDENCE_V1),
  evidenceReceiptId: hash,
}).strict().superRefine((value, ctx) => {
  refineExecutionEventProjection(value, ctx, { adapterEvidence: true })
  const { eventId, ...core } = value
  if (sha256Canonical(core) !== eventId) {
    ctx.addIssue({ code: 'custom', path: ['eventId'], message: 'event id must equal the event core hash' })
  }
})

export type ExecutionEventV2 = z.infer<typeof executionEventV2Schema>
export type ExecutionEvent = ExecutionEventV1 | ExecutionEventV2
export const executionEventSchema = z.union([executionEventV1Schema, executionEventV2Schema])

export interface VerifyExecutionPermitV2Input {
  permit: unknown
  command: unknown
  resolvePublicKey: (keyId: string) => KeyObject | string | Buffer | undefined
  now?: Date
  maxTtlMs?: number
  maxFutureMs?: number
}

export type ExecutionPermitV2Verification =
  | { valid: true; permit: ExecutionPermitV2; command: ExecutionCommandV1 }
  | { valid: false; reason: string }

export interface CreateExecutionPermitV2SignerInput {
  authorityProvider: ExecutionAuthorityProvider
  mode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE'
  keyId: string
  privateKey: KeyObject | string | Buffer
}

export interface SignExecutionPermitV2Input {
  v1Permit: unknown
  v1Request: ExecutionPermitRequest
  payload: unknown
  now?: Date
}

export interface ExecutionPermitV2Signer {
  sign(input: SignExecutionPermitV2Input): Promise<ExecutionPermitV2>
}

/** Creates a deterministic OKX client ID with no UUID punctuation. */
export function deriveOkxClientOrderId(idempotencyKey: string): string {
  const canonicalKey = canonicalText(500).parse(idempotencyKey)
  return `OA${createHash('sha256')
    .update(`openalice:okx-client-order-id:v1:${canonicalKey}`, 'utf8')
    .digest('hex')
    .slice(0, 30)
    .toUpperCase()}`
}

/** Creates a deterministic command envelope; commandId is always the payload SHA-256. */
export function buildExecutionCommandV1(payload: unknown): ExecutionCommandV1 {
  const parsedPayload = executionCommandPayloadV1Schema.parse(payload)
  const payloadHash = sha256Canonical(parsedPayload)
  return executionCommandV1Schema.parse({
    schemaVersion: EXECUTION_COMMAND_V1,
    commandId: payloadHash,
    payloadHash,
    payload: parsedPayload,
  })
}

/** Creates an event whose ID binds every event field except the ID itself. */
export function buildExecutionEventV1(
  input: z.input<typeof executionEventCoreV1Schema>,
): ExecutionEventV1 {
  const core = executionEventCoreV1Schema.parse(input)
  return executionEventV1Schema.parse({ ...core, eventId: sha256Canonical(core) })
}

/** Strict structural validation including the deterministic permit identifier, but not its signature. */
export function validateExecutionPermitV2(input: unknown): ExecutionPermitV2 {
  const permit = executionPermitV2Schema.parse(input)
  if (executionPermitV2Id(permitCore(permit)) !== permit.permitId) {
    throw new Error('execution_permit_v2_hash_mismatch')
  }
  return permit
}

/** Verifies a paper-only permit against its exact command, current time, and Ed25519 key. */
export function verifyExecutionPermitV2(
  input: VerifyExecutionPermitV2Input,
): ExecutionPermitV2Verification {
  let permit: ExecutionPermitV2
  let command: ExecutionCommandV1
  try {
    permit = validateExecutionPermitV2(input.permit)
    command = executionCommandV1Schema.parse(input.command)
  } catch (error) {
    return { valid: false, reason: error instanceof Error ? error.message : 'invalid_contract' }
  }
  const now = input.now ?? new Date()
  const maxFutureMs = input.maxFutureMs ?? 30_000
  const maxTtlMs = input.maxTtlMs ?? 60_000
  if (permit.commandHash !== command.commandId) return { valid: false, reason: 'command_hash_mismatch' }
  if (permit.action !== command.payload.kind) return { valid: false, reason: 'permit_action_mismatch' }
  if (
    permit.accountId !== command.payload.accountId
    || permit.canonicalSymbol !== command.payload.canonicalSymbol
    || permit.venueInstrumentId !== command.payload.venueInstrumentId
    || permit.idempotencyKey !== command.payload.idempotencyKey
    || permit.mode !== command.payload.mode
  ) return { valid: false, reason: 'permit_scope_mismatch' }
  if (command.payload.kind === 'submit' && (
    permit.side !== command.payload.side
    || permit.riskReducing !== command.payload.reduceOnly
    || permit.authorizedNotionalUsd !== command.payload.maxNotionalUsd
  )) return { valid: false, reason: 'permit_economic_scope_mismatch' }
  const issuedAt = Date.parse(permit.issuedAt)
  const expiresAt = Date.parse(permit.expiresAt)
  if (issuedAt > now.getTime() + maxFutureMs) return { valid: false, reason: 'permit_from_future' }
  if (expiresAt <= now.getTime()) return { valid: false, reason: 'permit_expired' }
  if (expiresAt - issuedAt > maxTtlMs) return { valid: false, reason: 'permit_ttl_exceeded' }
  let publicKey: KeyObject
  try {
    const resolved = input.resolvePublicKey(permit.keyId)
    if (!resolved) return { valid: false, reason: 'unknown_key_id' }
    publicKey = resolved instanceof KeyObject ? resolved : createPublicKey(resolved)
    if (publicKey.asymmetricKeyType !== 'ed25519') {
      return { valid: false, reason: 'public_key_must_be_ed25519' }
    }
  } catch {
    return { valid: false, reason: 'invalid_public_key' }
  }
  try {
    const verified = verify(
      null,
      Buffer.from(executionPermitV2SigningPayload(permit), 'utf8'),
      publicKey,
      Buffer.from(permit.signature, 'base64'),
    )
    return verified
      ? { valid: true, permit, command }
      : { valid: false, reason: 'invalid_signature' }
  } catch {
    return { valid: false, reason: 'signature_verification_failed' }
  }
}

/**
 * Creates a signer that rechecks each V1 permit against a trusted current authority provider.
 * A bare V1 content hash is never accepted as authorization.
 */
export function createExecutionPermitV2Signer(
  input: CreateExecutionPermitV2SignerInput,
): ExecutionPermitV2Signer {
  const configuredMode = mode.parse(input.mode)
  const keyId = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/).parse(input.keyId)
  const privateKey = input.privateKey instanceof KeyObject
    ? input.privateKey
    : createPrivateKey(input.privateKey)
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('execution_permit_v2_private_key_must_be_ed25519')
  }

  return {
    async sign(signInput: SignExecutionPermitV2Input): Promise<ExecutionPermitV2> {
      const now = signInput.now ?? new Date()
      const v1 = validateExecutionPermit(signInput.v1Permit)
      if (v1.accountMode !== 'paper_only') throw new Error('live_guarded_v1_permit_forbidden')
      if (v1.action === 'adjust_leverage') throw new Error('adjust_leverage_forbidden')
      const command = buildExecutionCommandV1(signInput.payload)
      if (command.payload.mode !== configuredMode) throw new Error('configured_mode_command_mismatch')

      let snapshot
      try {
        snapshot = await input.authorityProvider(now)
      } catch (error) {
        throw new Error(
          `execution_authority_recheck_failed:${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const verifiedV1 = verifyExecutionPermit({
        permit: v1,
        request: { ...signInput.v1Request, now },
        snapshot,
        now,
      })
      if (!verifiedV1.allowed) {
        throw new Error(`v1_execution_permit_not_authorized:${verifiedV1.reasonCodes.join(',')}`)
      }

      assertV1CommandBinding(v1, command)
      if (command.payload.kind !== 'submit') {
        throw new Error('mvp_only_open_buy_submit_permitted')
      }
      const core = {
        schemaVersion: EXECUTION_PERMIT_V2,
        decisionId: v1.decisionId,
        candidateId: v1.candidateId,
        intentId: v1.intentId,
        ticketId: v1.ticketId,
        commandHash: command.commandId,
        action: 'submit' as const,
        authorityAction: 'open' as const,
        riskReducing: false as const,
        scope: 'paper_only' as const,
        accountId: command.payload.accountId,
        canonicalSymbol: command.payload.canonicalSymbol,
        venueInstrumentId: command.payload.venueInstrumentId,
        idempotencyKey: command.payload.idempotencyKey,
        side: 'buy' as const,
        authorizedNotionalUsd: command.payload.maxNotionalUsd,
        mode: configuredMode,
        sourceCommit: v1.sourceCommit,
        releaseManifestHash: v1.releaseManifestHash,
        authoritySnapshotHash: v1.authoritySnapshotHash,
        requiredChecks: [...v1.requiredChecks],
        approvalRefs: [...v1.approvalRefs],
        issuedAt: v1.issuedAt,
        expiresAt: v1.expiresAt,
        keyId,
      }
      const permitId = executionPermitV2Id(core)
      const signature = sign(
        null,
        Buffer.from(stableStringify({ permitId, ...core }), 'utf8'),
        privateKey,
      ).toString('base64')
      return executionPermitV2Schema.parse({ ...core, permitId, signature })
    },
  }
}

export function executionPermitV2Id(
  core: Omit<ExecutionPermitV2, 'permitId' | 'signature'>,
): string {
  return sha256Canonical(core)
}

export function executionPermitV2SigningPayload(permit: ExecutionPermitV2): string {
  return stableStringify({ permitId: permit.permitId, ...permitCore(permit) })
}

function permitCore(permit: ExecutionPermitV2): Omit<ExecutionPermitV2, 'permitId' | 'signature'> {
  const { permitId: _permitId, signature: _signature, ...core } = permit
  return core
}

function assertV1CommandBinding(v1: ExecutionPermitV1, command: ExecutionCommandV1): void {
  if (v1.action === 'adjust_leverage') throw new Error('adjust_leverage_forbidden')
  if (v1.action !== 'open') throw new Error('mvp_only_open_buy_submit_permitted')
  if (command.payload.kind !== 'submit') throw new Error('mvp_only_open_buy_submit_permitted')
  if (
    v1.accountId !== command.payload.accountId
    || v1.symbol !== command.payload.canonicalSymbol
    || v1.idempotencyKey !== command.payload.idempotencyKey
  ) throw new Error('v1_scope_command_mismatch')

  if (command.payload.kind === 'submit') {
    if (v1.side !== 'buy' || command.payload.side !== 'buy') {
      throw new Error('v1_side_command_mismatch')
    }
    if (v1.riskReducing || command.payload.reduceOnly) {
      throw new Error('v1_risk_direction_command_mismatch')
    }
    if (v1.notionalUsd === undefined) throw new Error('v1_notional_required_for_submit')
    const authorized = positiveDecimalString.parse(String(v1.notionalUsd))
    if (command.payload.maxNotionalUsd !== authorized) {
      throw new Error('v1_notional_command_mismatch')
    }
  }
}
