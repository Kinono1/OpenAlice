import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
  sign,
  verify,
} from 'node:crypto'
import { TextDecoder } from 'node:util'
import Decimal from 'decimal.js'
import { z } from 'zod'
import { sha256Canonical, stableStringify } from '../../sidecar/contracts.js'
import {
  executionEventV2Schema,
  type ExecutionEventV2,
} from './execution-protocol.js'

export const OFFLINE_EXECUTION_RECEIPT_V1 = 'openalice_offline_execution_receipt.v1' as const
export const OFFLINE_EXECUTION_ATTEMPT_V1 = 'openalice_execution_attempt.v1' as const
export const OFFLINE_SIMULATOR_REQUEST_V1 = 'openalice_offline_simulator_request.v1' as const
export const OFFLINE_SIMULATOR_RESPONSE_V1 = 'openalice_offline_simulator_response.v1' as const
export const OFFLINE_EXECUTION_RECEIPT_SCOPE = 'offline_simulator_only' as const
export const OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN
  = 'openalice:offline-execution-receipt:v1' as const
export const MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES = 65_536
export const MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES = 32_768
export const MAX_OFFLINE_SIMULATOR_RESPONSE_JSON_BYTES = 32_768

const SHA256_RE = /^[a-f0-9]{64}$/
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/
const UINT64_RE = /^(?:0|[1-9][0-9]*)$/
const ORDER_ID_RE = /^[A-Za-z0-9]{1,32}$/
const SIMULATED_ORDER_ID_RE = /^SIM[A-Za-z0-9]{1,197}$/
const KEY_ID_RE = /^[A-Za-z0-9._-]{1,100}$/
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const UTC_MILLISECOND_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_UINT64 = 18_446_744_073_709_551_615n
const MAX_DECIMAL_INTEGER_DIGITS = 32
const MAX_DECIMAL_FRACTION_DIGITS = 18
const MAX_JSON_DEPTH = 16
const MAX_JSON_NODES = 512
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

const hash = z.string().regex(SHA256_RE)
const canonicalText = (maximum: number) => z.string().min(1).max(maximum).refine(
  value => value === value.trim(),
  'leading or trailing whitespace is not canonical',
)
const positiveDecimal = z.string().regex(DECIMAL_RE).refine(
  value => {
    if (value === '0') return false
    const [integer, fraction = ''] = value.split('.')
    return integer.length <= MAX_DECIMAL_INTEGER_DIGITS
      && fraction.length <= MAX_DECIMAL_FRACTION_DIGITS
  },
  'decimal must be positive and within the bounded canonical precision',
)
const positiveUint64 = z.string().regex(UINT64_RE).refine(
  value => value !== '0' && BigInt(value) <= MAX_UINT64,
  'value must be a canonical positive uint64',
)
const canonicalTimestamp = z.string().regex(UTC_MILLISECOND_RE).refine(
  value => {
    const parsed = new Date(value)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
  },
  'timestamp must be canonical UTC with millisecond precision',
)
const canonicalSignature = z.string().regex(BASE64_RE).refine(
  value => {
    const decoded = Buffer.from(value, 'base64')
    return decoded.length === 64 && decoded.toString('base64') === value
  },
  'signature must be canonical Ed25519 base64',
)

const offlineReceiptKind = z.enum([
  'submitted',
  'partially_filled',
  'filled',
  'canceled',
  'rejected',
  'expired',
  'submission_unknown',
])

const offlineSimulatorRequestShape = {
  schemaVersion: z.literal(OFFLINE_SIMULATOR_REQUEST_V1),
  sourceNamespaceId: hash,
  commandId: hash,
  payloadHash: hash,
  permitV2Id: hash,
  permitKeyId: z.string().regex(KEY_ID_RE),
  acceptedSequence: positiveUint64,
  idempotencyKey: canonicalText(500),
  accountId: canonicalText(200),
  canonicalSymbol: z.literal('BTC/USDT'),
  venue: z.literal('OKX'),
  venueInstrumentId: z.literal('BTC-USDT'),
  mode: z.literal('PAPER_LOCAL'),
  clientOrderId: z.string().regex(ORDER_ID_RE),
  side: z.literal('buy'),
  orderType: z.literal('limit'),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK']),
  reduceOnly: z.literal(false),
  quantity: positiveDecimal,
  price: positiveDecimal,
  maxNotionalUsd: positiveDecimal,
  adapterId: canonicalText(200),
  adapterRunId: canonicalText(300),
  adapterEpoch: positiveUint64,
  attemptId: hash,
  attemptNumber: positiveUint64,
  permitIssuedAt: canonicalTimestamp,
  permitExpiresAt: canonicalTimestamp,
  dispatchArmedAt: canonicalTimestamp,
} as const

export const offlineSimulatorRequestV1Schema = z
  .object(offlineSimulatorRequestShape)
  .strict()
  .superRefine((value, context) => {
    if (value.commandId !== value.payloadHash) {
      context.addIssue({ code: 'custom', path: ['payloadHash'], message: 'payloadHash must equal commandId' })
    }
    if (new Decimal(value.quantity).mul(value.price).gt(value.maxNotionalUsd)) {
      context.addIssue({
        code: 'custom',
        path: ['maxNotionalUsd'],
        message: 'simulator request exceeds the authorized maximum',
      })
    }
    if (
      Date.parse(value.permitIssuedAt) > Date.parse(value.dispatchArmedAt)
      || Date.parse(value.dispatchArmedAt) >= Date.parse(value.permitExpiresAt)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['dispatchArmedAt'],
        message: 'dispatch must be armed within the permit authority interval',
      })
    }
    if (value.attemptId !== deriveOfflineExecutionAttemptId({
      commandId: value.commandId,
      adapterId: value.adapterId,
      adapterRunId: value.adapterRunId,
      adapterEpoch: value.adapterEpoch,
      attemptNumber: value.attemptNumber,
    })) {
      context.addIssue({
        code: 'custom',
        path: ['attemptId'],
        message: 'attemptId does not match its deterministic binding',
      })
    }
  })

export type OfflineSimulatorRequestV1 = z.infer<typeof offlineSimulatorRequestV1Schema>

const offlineSimulatorResponseShape = {
  schemaVersion: z.literal(OFFLINE_SIMULATOR_RESPONSE_V1),
  sourceNamespaceId: hash,
  sourceSequence: positiveUint64,
  commandId: hash,
  attemptId: hash,
  requestHash: hash,
  clientOrderId: z.string().regex(ORDER_ID_RE),
  state: offlineReceiptKind,
  simulatorOccurredAt: canonicalTimestamp,
  simulatedOrderId: z.string().regex(SIMULATED_ORDER_ID_RE).optional(),
  filledQuantity: positiveDecimal.optional(),
  averagePrice: positiveDecimal.optional(),
  reason: canonicalText(500).optional(),
} as const

export const offlineSimulatorResponseV1Schema = z
  .object(offlineSimulatorResponseShape)
  .strict()
  .superRefine((value, context) => {
    const fill = value.state === 'partially_filled' || value.state === 'filled'
    if (fill) {
      if (!value.filledQuantity || !value.averagePrice || !value.simulatedOrderId) {
        context.addIssue({
          code: 'custom',
          path: ['filledQuantity'],
          message: 'fill response requires quantity, price, and simulated order identity',
        })
      }
    } else if (value.filledQuantity !== undefined || value.averagePrice !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: 'only fill responses may carry fill fields',
      })
    }
    if (
      ['submitted', 'canceled', 'expired'].includes(value.state)
      && value.simulatedOrderId === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['simulatedOrderId'],
        message: `${value.state} requires simulated order identity`,
      })
    }
    if (
      ['rejected', 'expired', 'submission_unknown'].includes(value.state)
      && value.reason === undefined
    ) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `${value.state} requires a reason`,
      })
    }
  })

export type OfflineSimulatorResponseV1 = z.infer<typeof offlineSimulatorResponseV1Schema>

const offlineExecutionReceiptCoreShape = {
  schemaVersion: z.literal(OFFLINE_EXECUTION_RECEIPT_V1),
  scope: z.literal(OFFLINE_EXECUTION_RECEIPT_SCOPE),
  commandId: hash,
  payloadHash: hash,
  permitV2Id: hash,
  permitKeyId: z.string().regex(KEY_ID_RE),
  acceptedSequence: positiveUint64,
  lifecycleSequence: positiveUint64,
  lifecycleKind: offlineReceiptKind,
  idempotencyKey: canonicalText(500),
  accountId: canonicalText(200),
  canonicalSymbol: z.literal('BTC/USDT'),
  venue: z.literal('OKX'),
  venueInstrumentId: z.literal('BTC-USDT'),
  mode: z.literal('PAPER_LOCAL'),
  clientOrderId: z.string().regex(ORDER_ID_RE),
  side: z.literal('buy'),
  orderType: z.literal('limit'),
  timeInForce: z.enum(['GTC', 'IOC', 'FOK']),
  reduceOnly: z.literal(false),
  quantity: positiveDecimal,
  price: positiveDecimal,
  maxNotionalUsd: positiveDecimal,
  adapterId: canonicalText(200),
  adapterBuildHash: hash,
  adapterConfigHash: hash,
  adapterRunId: canonicalText(300),
  adapterEpoch: positiveUint64,
  adapterKeyId: z.string().regex(KEY_ID_RE),
  attemptId: hash,
  attemptNumber: positiveUint64,
  sourceNamespaceId: hash,
  sourceSequence: positiveUint64,
  transitionNumber: positiveUint64,
  simulatedOrderId: z.string().regex(SIMULATED_ORDER_ID_RE).optional(),
  requestHash: hash,
  responseHash: hash,
  permitIssuedAt: canonicalTimestamp,
  permitExpiresAt: canonicalTimestamp,
  dispatchArmedAt: canonicalTimestamp,
  adapterObservedAt: canonicalTimestamp,
  simulatorOccurredAt: canonicalTimestamp,
  previousReceiptId: hash.optional(),
  filledQuantity: positiveDecimal.optional(),
  averagePrice: positiveDecimal.optional(),
  reason: canonicalText(500).optional(),
} as const

function refineOfflineReceiptCore(
  value: z.infer<z.ZodObject<typeof offlineExecutionReceiptCoreShape>>,
  context: z.RefinementCtx,
): void {
  if (value.commandId !== value.payloadHash) {
    context.addIssue({
      code: 'custom',
      path: ['payloadHash'],
      message: 'payloadHash must equal commandId',
    })
  }
  if (
    Date.parse(value.permitIssuedAt) > Date.parse(value.dispatchArmedAt)
    || Date.parse(value.dispatchArmedAt) >= Date.parse(value.permitExpiresAt)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['dispatchArmedAt'],
      message: 'dispatch must be armed within the permit authority interval',
    })
  }
  if (BigInt(value.lifecycleSequence) <= BigInt(value.acceptedSequence)) {
    context.addIssue({
      code: 'custom',
      path: ['lifecycleSequence'],
      message: 'adapter lifecycle sequence must follow durable acknowledgement',
    })
  }
  if (new Decimal(value.quantity).mul(value.price).gt(value.maxNotionalUsd)) {
    context.addIssue({
      code: 'custom',
      path: ['maxNotionalUsd'],
      message: 'receipt order notional exceeds the authorized maximum',
    })
  }
  const expectedAttemptId = deriveOfflineExecutionAttemptId({
    commandId: value.commandId,
    adapterId: value.adapterId,
    adapterRunId: value.adapterRunId,
    adapterEpoch: value.adapterEpoch,
    attemptNumber: value.attemptNumber,
  })
  if (value.attemptId !== expectedAttemptId) {
    context.addIssue({
      code: 'custom',
      path: ['attemptId'],
      message: 'attemptId does not match its deterministic binding',
    })
  }
  if (Date.parse(value.simulatorOccurredAt) > Date.parse(value.adapterObservedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['simulatorOccurredAt'],
      message: 'simulator event cannot occur after adapter observation',
    })
  }
  if (Date.parse(value.simulatorOccurredAt) < Date.parse(value.dispatchArmedAt)) {
    context.addIssue({
      code: 'custom',
      path: ['simulatorOccurredAt'],
      message: 'simulator event cannot precede the armed dispatch',
    })
  }
  if (
    (value.transitionNumber === '1' && value.previousReceiptId !== undefined)
    || (value.transitionNumber !== '1' && value.previousReceiptId === undefined)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['previousReceiptId'],
      message: 'receipt predecessor does not match its transition number',
    })
  }
  const isFill = value.lifecycleKind === 'partially_filled' || value.lifecycleKind === 'filled'
  if (isFill) {
    if (!value.filledQuantity || !value.averagePrice || !value.simulatedOrderId) {
      context.addIssue({
        code: 'custom',
        path: ['filledQuantity'],
        message: 'fill receipts require quantity, price, and simulated order identity',
      })
    }
    if (value.filledQuantity) {
      const filled = new Decimal(value.filledQuantity)
      const ordered = new Decimal(value.quantity)
      if (
        filled.gt(ordered)
        || (value.lifecycleKind === 'filled' && !filled.eq(ordered))
        || (value.lifecycleKind === 'partially_filled' && !filled.lt(ordered))
      ) {
        context.addIssue({
          code: 'custom',
          path: ['filledQuantity'],
          message: 'filled quantity is inconsistent with the lifecycle kind',
        })
      }
      if (
        value.averagePrice
        && (
          new Decimal(value.averagePrice).gt(value.price)
          || filled.mul(value.averagePrice).gt(value.maxNotionalUsd)
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['averagePrice'],
          message: 'buy-limit fill exceeds the authorized price or notional',
        })
      }
    }
  } else if (value.filledQuantity !== undefined || value.averagePrice !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['filledQuantity'],
      message: 'only fill receipts may carry fill fields',
    })
  }
  if (
    ['submitted', 'canceled', 'expired'].includes(value.lifecycleKind)
    && value.simulatedOrderId === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['simulatedOrderId'],
      message: `${value.lifecycleKind} requires simulated order identity`,
    })
  }
  if (
    ['rejected', 'expired', 'submission_unknown'].includes(value.lifecycleKind)
    && value.reason === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['reason'],
      message: `${value.lifecycleKind} requires a reason`,
    })
  }
}

export const offlineExecutionReceiptCoreV1Schema = z
  .object(offlineExecutionReceiptCoreShape)
  .strict()
  .superRefine(refineOfflineReceiptCore)

export type OfflineExecutionReceiptCoreV1 = z.infer<
  typeof offlineExecutionReceiptCoreV1Schema
>

export const offlineExecutionReceiptV1Schema = z.object({
  ...offlineExecutionReceiptCoreShape,
  receiptId: hash,
  signature: canonicalSignature,
}).strict().superRefine((value, context) => {
  refineOfflineReceiptCore(value, context)
  if (offlineExecutionReceiptV1Id(offlineReceiptCore(value)) !== value.receiptId) {
    context.addIssue({
      code: 'custom',
      path: ['receiptId'],
      message: 'receiptId must equal the domain-separated canonical core hash',
    })
  }
})

export type OfflineExecutionReceiptV1 = z.infer<typeof offlineExecutionReceiptV1Schema>

export interface OfflineExecutionReceiptTrustPolicy {
  readonly keyId: string
  readonly adapterId: string
  readonly adapterBuildHash: string
  readonly adapterConfigHash: string
  readonly adapterRunId: string
  /** Permit-authority roles are disjoint from the simulator receipt signer. */
  readonly permitAuthorityKeyIds: readonly string[]
  /** SHA-256 fingerprints of canonical SPKI DER for every permit-authority key. */
  readonly permitAuthorityPublicKeyFingerprints: readonly string[]
  readonly publicKey: KeyObject | string | Buffer
}

export interface OfflineExecutionReceiptExpectedBinding {
  readonly commandId: string
  readonly payloadHash: string
  readonly permitV2Id: string
  readonly permitKeyId: string
  readonly acceptedSequence: string
  readonly lifecycleSequence: string
  readonly lifecycleKind: OfflineExecutionReceiptV1['lifecycleKind']
  readonly adapterEpoch: string
  readonly attemptId: string
  readonly attemptNumber: string
  readonly sourceNamespaceId: string
  readonly sourceSequence: string
  readonly transitionNumber: string
  readonly previousReceiptId: string | undefined
  readonly idempotencyKey: string
  readonly accountId: string
  readonly canonicalSymbol: 'BTC/USDT'
  readonly venue: 'OKX'
  readonly venueInstrumentId: 'BTC-USDT'
  readonly mode: 'PAPER_LOCAL'
  readonly clientOrderId: string
  readonly side: 'buy'
  readonly orderType: 'limit'
  readonly timeInForce: 'GTC' | 'IOC' | 'FOK'
  readonly reduceOnly: false
  readonly quantity: string
  readonly price: string
  readonly maxNotionalUsd: string
}

export type OfflineExecutionReceiptVerification =
  | {
      readonly valid: true
      readonly finalizationEligible: false
      readonly reason: 'offline_simulator_only'
      readonly receipt: OfflineExecutionReceiptV1
    }
  | {
      readonly valid: false
      readonly reason:
        | 'invalid_contract'
        | 'receipt_hash_mismatch'
        | 'untrusted_adapter_key'
        | 'adapter_identity_mismatch'
        | 'raw_evidence_mismatch'
        | 'signature_invalid'
        | 'expected_binding_mismatch'
        | 'receipt_from_future'
    }

export interface VerifyOfflineExecutionReceiptV1Input {
  readonly receipt: unknown
  readonly canonicalRequestJsonUtf8: Uint8Array
  readonly canonicalResponseJsonUtf8: Uint8Array
  readonly trustPolicy: OfflineExecutionReceiptTrustPolicy
  readonly expected: OfflineExecutionReceiptExpectedBinding
  readonly now?: Date
  readonly maxFutureMs?: number
}

const EXPECTED_BINDING_FIELDS = [
  'commandId',
  'payloadHash',
  'permitV2Id',
  'permitKeyId',
  'acceptedSequence',
  'lifecycleSequence',
  'lifecycleKind',
  'adapterEpoch',
  'attemptId',
  'attemptNumber',
  'sourceNamespaceId',
  'sourceSequence',
  'transitionNumber',
  'previousReceiptId',
  'idempotencyKey',
  'accountId',
  'canonicalSymbol',
  'venue',
  'venueInstrumentId',
  'mode',
  'clientOrderId',
  'side',
  'orderType',
  'timeInForce',
  'reduceOnly',
  'quantity',
  'price',
  'maxNotionalUsd',
] as const satisfies readonly (keyof OfflineExecutionReceiptExpectedBinding)[]

export function deriveOfflineExecutionAttemptId(input: {
  commandId: string
  adapterId: string
  adapterRunId: string
  adapterEpoch: string
  attemptNumber: string
}): string {
  return sha256Canonical({
    schemaVersion: OFFLINE_EXECUTION_ATTEMPT_V1,
    commandId: input.commandId,
    adapterId: input.adapterId,
    adapterRunId: input.adapterRunId,
    adapterEpoch: input.adapterEpoch,
    attemptNumber: input.attemptNumber,
  })
}

/** Canonical key-material identity used to keep permit and simulator roles disjoint. */
export function ed25519PublicKeyFingerprintSha256(
  value: KeyObject | string | Buffer,
): string {
  const publicKey = value instanceof KeyObject ? value : createPublicKey(value)
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('offline_execution_receipt_public_key_must_be_ed25519')
  }
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  return createHash('sha256').update(spki).digest('hex')
}

export function offlineExecutionReceiptV1Id(core: OfflineExecutionReceiptCoreV1): string {
  return sha256DomainSeparated(OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN, core)
}

export function offlineExecutionReceiptV1SigningPayload(
  receipt: OfflineExecutionReceiptV1,
): string {
  return `${OFFLINE_EXECUTION_RECEIPT_SIGNATURE_DOMAIN}\0${stableStringify({
    receiptId: receipt.receiptId,
    ...offlineReceiptCore(receipt),
  })}`
}

export function createOfflineExecutionReceiptV1(input: {
  core: unknown
  privateKey: KeyObject | string | Buffer
}): OfflineExecutionReceiptV1 {
  const core = offlineExecutionReceiptCoreV1Schema.parse(input.core)
  const receiptId = offlineExecutionReceiptV1Id(core)
  const unsigned = offlineExecutionReceiptV1Schema.parse({
    ...core,
    receiptId,
    signature: Buffer.alloc(64).toString('base64'),
  })
  const privateKey = input.privateKey instanceof KeyObject
    ? input.privateKey
    : createPrivateKey(input.privateKey)
  if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('offline_execution_receipt_private_key_must_be_ed25519')
  }
  const signature = sign(
    null,
    Buffer.from(offlineExecutionReceiptV1SigningPayload(unsigned), 'utf8'),
    privateKey,
  ).toString('base64')
  return offlineExecutionReceiptV1Schema.parse({ ...core, receiptId, signature })
}

/** Derives the only semantically valid V2 lifecycle projection for this receipt. */
export function buildExecutionEventV2FromOfflineReceipt(
  input: unknown,
): ExecutionEventV2 {
  const receipt = offlineExecutionReceiptV1Schema.parse(input)
  const core = {
    schemaVersion: 'openalice_execution_event.v2' as const,
    commandId: receipt.commandId,
    sequence: receipt.lifecycleSequence,
    occurredAt: receipt.simulatorOccurredAt,
    kind: receipt.lifecycleKind,
    clientOrderId: receipt.clientOrderId,
    ...(receipt.simulatedOrderId === undefined
      ? {}
      : { venueOrderId: receipt.simulatedOrderId }),
    ...(receipt.filledQuantity === undefined
      ? {}
      : { filledQuantity: receipt.filledQuantity }),
    ...(receipt.averagePrice === undefined
      ? {}
      : { averagePrice: receipt.averagePrice }),
    ...(receipt.reason === undefined ? {} : { reason: receipt.reason }),
    evidenceSchemaVersion: OFFLINE_EXECUTION_RECEIPT_V1,
    evidenceReceiptId: receipt.receiptId,
  }
  return executionEventV2Schema.parse({
    ...core,
    eventId: sha256Canonical(core),
  })
}

/** Requires an exact field-for-field event projection of the referenced receipt. */
export function executionEventV2MatchesOfflineReceipt(
  receipt: unknown,
  event: unknown,
): boolean {
  try {
    return stableStringify(executionEventV2Schema.parse(event))
      === stableStringify(buildExecutionEventV2FromOfflineReceipt(receipt))
  } catch {
    return false
  }
}

export function parseOfflineExecutionReceiptJsonUtf8(
  raw: Uint8Array,
): OfflineExecutionReceiptV1 {
  if (!(raw instanceof Uint8Array) || raw.byteLength > MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES) {
    throw new Error('offline_execution_receipt_canonical_json_invalid')
  }
  const bytes = Buffer.from(raw)
  let parsed: unknown
  try {
    const text = STRICT_UTF8_DECODER.decode(bytes)
    parsed = JSON.parse(text)
    assertBoundedJsonComplexity(parsed)
    if (stableStringify(parsed) !== text) throw new Error('noncanonical')
  } catch {
    throw new Error('offline_execution_receipt_canonical_json_invalid')
  }
  return offlineExecutionReceiptV1Schema.parse(parsed)
}

export function verifyOfflineExecutionReceiptV1(
  input: VerifyOfflineExecutionReceiptV1Input,
): OfflineExecutionReceiptVerification {
  let receipt: OfflineExecutionReceiptV1
  try {
    receipt = offlineExecutionReceiptV1Schema.parse(input.receipt)
  } catch (error) {
    if (
      error instanceof z.ZodError
      && error.issues.some(issue => issue.path[0] === 'receiptId')
    ) {
      return { valid: false, reason: 'receipt_hash_mismatch' }
    }
    return { valid: false, reason: 'invalid_contract' }
  }
  const trust = input.trustPolicy
  if (!trust || typeof trust !== 'object') {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (receipt.adapterKeyId !== trust.keyId) {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (
    !Array.isArray(trust.permitAuthorityKeyIds)
    || !trust.permitAuthorityKeyIds.every(keyId => typeof keyId === 'string' && KEY_ID_RE.test(keyId))
    || !Array.isArray(trust.permitAuthorityPublicKeyFingerprints)
    || trust.permitAuthorityPublicKeyFingerprints.length === 0
    || !trust.permitAuthorityPublicKeyFingerprints.every(
      fingerprint => typeof fingerprint === 'string' && SHA256_RE.test(fingerprint),
    )
    || !trust.permitAuthorityKeyIds.includes(receipt.permitKeyId)
    || trust.permitAuthorityKeyIds.includes(receipt.adapterKeyId)
    || receipt.permitKeyId === receipt.adapterKeyId
  ) {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (
    receipt.adapterId !== trust.adapterId
    || receipt.adapterBuildHash !== trust.adapterBuildHash
    || receipt.adapterConfigHash !== trust.adapterConfigHash
    || receipt.adapterRunId !== trust.adapterRunId
  ) {
    return { valid: false, reason: 'adapter_identity_mismatch' }
  }
  let request: OfflineSimulatorRequestV1
  let response: OfflineSimulatorResponseV1
  try {
    request = offlineSimulatorRequestV1Schema.parse(
      parseCanonicalJsonBytes(
        input.canonicalRequestJsonUtf8,
        MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES,
      ),
    )
    response = offlineSimulatorResponseV1Schema.parse(
      parseCanonicalJsonBytes(
        input.canonicalResponseJsonUtf8,
        MAX_OFFLINE_SIMULATOR_RESPONSE_JSON_BYTES,
      ),
    )
  } catch {
    return { valid: false, reason: 'raw_evidence_mismatch' }
  }
  if (
    sha256Canonical(request) !== receipt.requestHash
    || sha256Canonical(response) !== receipt.responseHash
    || !simulatorRequestMatchesReceipt(request, receipt)
    || !simulatorResponseMatchesReceipt(response, receipt)
  ) {
    return { valid: false, reason: 'raw_evidence_mismatch' }
  }
  let publicKey: KeyObject
  try {
    publicKey = trust.publicKey instanceof KeyObject
      ? trust.publicKey
      : createPublicKey(trust.publicKey)
  } catch {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (
    trust.permitAuthorityPublicKeyFingerprints.includes(
      ed25519PublicKeyFingerprintSha256(publicKey),
    )
  ) {
    return { valid: false, reason: 'untrusted_adapter_key' }
  }
  if (!verify(
    null,
    Buffer.from(offlineExecutionReceiptV1SigningPayload(receipt), 'utf8'),
    publicKey,
    Buffer.from(receipt.signature, 'base64'),
  )) {
    return { valid: false, reason: 'signature_invalid' }
  }
  if (!input.expected || typeof input.expected !== 'object') {
    return { valid: false, reason: 'expected_binding_mismatch' }
  }
  for (const field of EXPECTED_BINDING_FIELDS) {
    if (
      !Object.prototype.hasOwnProperty.call(input.expected, field)
      || receipt[field] !== input.expected[field]
    ) {
      return { valid: false, reason: 'expected_binding_mismatch' }
    }
  }
  const now = input.now ?? new Date()
  const maxFutureMs = input.maxFutureMs ?? 30_000
  if (
    !(now instanceof Date)
    || !Number.isFinite(now.getTime())
    || !Number.isFinite(maxFutureMs)
    || maxFutureMs < 0
    || Date.parse(receipt.adapterObservedAt) > now.getTime() + maxFutureMs
  ) {
    return { valid: false, reason: 'receipt_from_future' }
  }
  return {
    valid: true,
    finalizationEligible: false,
    reason: 'offline_simulator_only',
    receipt,
  }
}

function simulatorRequestMatchesReceipt(
  request: OfflineSimulatorRequestV1,
  receipt: OfflineExecutionReceiptV1,
): boolean {
  const exactFields = [
    'sourceNamespaceId',
    'commandId',
    'payloadHash',
    'permitV2Id',
    'permitKeyId',
    'acceptedSequence',
    'idempotencyKey',
    'accountId',
    'canonicalSymbol',
    'venue',
    'venueInstrumentId',
    'mode',
    'clientOrderId',
    'side',
    'orderType',
    'timeInForce',
    'reduceOnly',
    'quantity',
    'price',
    'maxNotionalUsd',
    'adapterId',
    'adapterRunId',
    'adapterEpoch',
    'attemptId',
    'attemptNumber',
    'permitIssuedAt',
    'permitExpiresAt',
    'dispatchArmedAt',
  ] as const
  return exactFields.every(field => request[field] === receipt[field])
}

function simulatorResponseMatchesReceipt(
  response: OfflineSimulatorResponseV1,
  receipt: OfflineExecutionReceiptV1,
): boolean {
  return (
    response.sourceNamespaceId === receipt.sourceNamespaceId
    && response.sourceSequence === receipt.sourceSequence
    && response.commandId === receipt.commandId
    && response.attemptId === receipt.attemptId
    && response.requestHash === receipt.requestHash
    && response.clientOrderId === receipt.clientOrderId
    && response.state === receipt.lifecycleKind
    && response.simulatorOccurredAt === receipt.simulatorOccurredAt
    && response.simulatedOrderId === receipt.simulatedOrderId
    && response.filledQuantity === receipt.filledQuantity
    && response.averagePrice === receipt.averagePrice
    && response.reason === receipt.reason
  )
}

function offlineReceiptCore(
  receipt: OfflineExecutionReceiptV1,
): OfflineExecutionReceiptCoreV1 {
  const { receiptId: _receiptId, signature: _signature, ...core } = receipt
  return offlineExecutionReceiptCoreV1Schema.parse(core)
}

function sha256DomainSeparated(domain: string, value: unknown): string {
  return sha256Canonical({ domain, value })
}

function parseCanonicalJsonBytes(raw: Uint8Array, maximumBytes: number): unknown {
  if (!(raw instanceof Uint8Array) || raw.byteLength > maximumBytes) {
    throw new Error('canonical evidence bytes required')
  }
  const text = STRICT_UTF8_DECODER.decode(Buffer.from(raw))
  const parsed: unknown = JSON.parse(text)
  assertBoundedJsonComplexity(parsed)
  if (stableStringify(parsed) !== text) throw new Error('noncanonical')
  return parsed
}

function assertBoundedJsonComplexity(value: unknown): void {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ]
  let nodes = 0
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    nodes += 1
    if (nodes > MAX_JSON_NODES || current.depth > MAX_JSON_DEPTH) {
      throw new Error('canonical JSON exceeds complexity limits')
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        pending.push({ value: item, depth: current.depth + 1 })
      }
    } else if (current.value && typeof current.value === 'object') {
      for (const item of Object.values(current.value)) {
        pending.push({ value: item, depth: current.depth + 1 })
      }
    }
  }
}
