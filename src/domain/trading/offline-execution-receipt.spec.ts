import { createPrivateKey, createPublicKey } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { sha256Canonical, stableStringify } from '../../sidecar/contracts.js'
import {
  OFFLINE_EXECUTION_RECEIPT_SCOPE,
  OFFLINE_EXECUTION_RECEIPT_V1,
  OFFLINE_SIMULATOR_REQUEST_V1,
  OFFLINE_SIMULATOR_RESPONSE_V1,
  MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES,
  MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES,
  buildExecutionEventV2FromOfflineReceipt,
  createOfflineExecutionReceiptV1,
  deriveOfflineExecutionAttemptId,
  ed25519PublicKeyFingerprintSha256,
  executionEventV2MatchesOfflineReceipt,
  offlineExecutionReceiptV1Schema,
  parseOfflineExecutionReceiptJsonUtf8,
  verifyOfflineExecutionReceiptV1,
  type OfflineExecutionReceiptCoreV1,
  type OfflineExecutionReceiptExpectedBinding,
} from './offline-execution-receipt.js'

const privateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const publicKey = createPublicKey(privateKey)
const permitPrivateKey = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 7),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const permitPublicKey = createPublicKey(permitPrivateKey)
const commandId = 'a'.repeat(64)
const adapterId = 'openalice.offline-simulator'
const adapterRunId = 'offline-run-1'
const adapterEpoch = '1'
const attemptNumber = '1'
const attemptId = deriveOfflineExecutionAttemptId({
  commandId,
  adapterId,
  adapterRunId,
  adapterEpoch,
  attemptNumber,
})
const sourceNamespaceId = 'e'.repeat(64)
const request = {
  schemaVersion: OFFLINE_SIMULATOR_REQUEST_V1,
  sourceNamespaceId,
  commandId,
  payloadHash: commandId,
  permitV2Id: 'b'.repeat(64),
  permitKeyId: 'permit-test-key',
  acceptedSequence: '1',
  idempotencyKey: 'offline-receipt-1',
  accountId: 'paper-main',
  canonicalSymbol: 'BTC/USDT',
  venue: 'OKX',
  venueInstrumentId: 'BTC-USDT',
  mode: 'PAPER_LOCAL',
  clientOrderId: 'OA1234567890ABCDEF',
  side: 'buy',
  orderType: 'limit',
  timeInForce: 'GTC',
  reduceOnly: false,
  quantity: '0.001',
  price: '100000',
  maxNotionalUsd: '100',
  adapterId,
  adapterRunId,
  adapterEpoch,
  attemptId,
  attemptNumber,
  permitIssuedAt: '2026-08-15T00:59:00.000Z',
  permitExpiresAt: '2026-08-15T01:00:30.000Z',
  dispatchArmedAt: '2026-08-15T00:59:59.000Z',
}
const requestHash = sha256Canonical(request)
const response = {
  schemaVersion: OFFLINE_SIMULATOR_RESPONSE_V1,
  sourceNamespaceId,
  sourceSequence: '1',
  commandId,
  attemptId,
  requestHash,
  clientOrderId: request.clientOrderId,
  simulatorOccurredAt: '2026-08-15T01:00:00.000Z',
  simulatedOrderId: 'SIM0123456789ABCDEF',
  state: 'submitted',
}
const requestBytes = Buffer.from(stableStringify(request), 'utf8')
const responseBytes = Buffer.from(stableStringify(response), 'utf8')

function core(overrides: Partial<OfflineExecutionReceiptCoreV1> = {}): OfflineExecutionReceiptCoreV1 {
  const base = {
    schemaVersion: OFFLINE_EXECUTION_RECEIPT_V1,
    scope: OFFLINE_EXECUTION_RECEIPT_SCOPE,
    commandId,
    payloadHash: commandId,
    permitV2Id: 'b'.repeat(64),
    permitKeyId: 'permit-test-key',
    acceptedSequence: '1',
    lifecycleSequence: '2',
    lifecycleKind: 'submitted' as const,
    idempotencyKey: 'offline-receipt-1',
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT' as const,
    venue: 'OKX' as const,
    venueInstrumentId: 'BTC-USDT' as const,
    mode: 'PAPER_LOCAL' as const,
    clientOrderId: request.clientOrderId,
    side: 'buy' as const,
    orderType: 'limit' as const,
    timeInForce: 'GTC' as const,
    reduceOnly: false as const,
    quantity: request.quantity,
    price: request.price,
    maxNotionalUsd: '100',
    adapterId,
    adapterBuildHash: 'c'.repeat(64),
    adapterConfigHash: 'd'.repeat(64),
    adapterRunId,
    adapterEpoch,
    adapterKeyId: 'offline-simulator-test-key',
    attemptNumber,
    sourceNamespaceId,
    sourceSequence: response.sourceSequence,
    transitionNumber: '1',
    simulatedOrderId: response.simulatedOrderId,
    requestHash,
    responseHash: sha256Canonical(response),
    permitIssuedAt: request.permitIssuedAt,
    permitExpiresAt: request.permitExpiresAt,
    dispatchArmedAt: request.dispatchArmedAt,
    adapterObservedAt: '2026-08-15T01:00:01.000Z',
    simulatorOccurredAt: '2026-08-15T01:00:00.000Z',
  }
  return {
      ...base,
      attemptId,
      ...overrides,
    } as OfflineExecutionReceiptCoreV1
}

function receipt(overrides: Partial<OfflineExecutionReceiptCoreV1> = {}) {
  return createOfflineExecutionReceiptV1({ core: core(overrides), privateKey })
}

function expected(value = receipt()): OfflineExecutionReceiptExpectedBinding {
  return {
    commandId: value.commandId,
    payloadHash: value.payloadHash,
    permitV2Id: value.permitV2Id,
    permitKeyId: value.permitKeyId,
    acceptedSequence: value.acceptedSequence,
    lifecycleSequence: value.lifecycleSequence,
    lifecycleKind: value.lifecycleKind,
    adapterEpoch: value.adapterEpoch,
    attemptId: value.attemptId,
    attemptNumber: value.attemptNumber,
    sourceNamespaceId: value.sourceNamespaceId,
    sourceSequence: value.sourceSequence,
    transitionNumber: value.transitionNumber,
    previousReceiptId: value.previousReceiptId,
    idempotencyKey: value.idempotencyKey,
    accountId: value.accountId,
    canonicalSymbol: value.canonicalSymbol,
    venue: value.venue,
    venueInstrumentId: value.venueInstrumentId,
    mode: value.mode,
    clientOrderId: value.clientOrderId,
    side: value.side,
    orderType: value.orderType,
    timeInForce: value.timeInForce,
    reduceOnly: value.reduceOnly,
    quantity: value.quantity,
    price: value.price,
    maxNotionalUsd: value.maxNotionalUsd,
  }
}

function verifyReceipt(value = receipt(), changes: Record<string, unknown> = {}) {
  return verifyOfflineExecutionReceiptV1({
    receipt: value,
    trustPolicy: {
      keyId: value.adapterKeyId,
      adapterId: value.adapterId,
      adapterBuildHash: value.adapterBuildHash,
      adapterConfigHash: value.adapterConfigHash,
      adapterRunId: value.adapterRunId,
      permitAuthorityKeyIds: [value.permitKeyId],
      permitAuthorityPublicKeyFingerprints: [
        ed25519PublicKeyFingerprintSha256(permitPublicKey),
      ],
      publicKey,
      ...changes.trustPolicy as object,
    },
    expected: { ...expected(value), ...changes.expected as object },
    now: (changes.now as Date | undefined) ?? new Date('2026-08-15T01:00:02.000Z'),
    canonicalRequestJsonUtf8: (changes.requestBytes as Uint8Array | undefined) ?? requestBytes,
    canonicalResponseJsonUtf8: (changes.responseBytes as Uint8Array | undefined) ?? responseBytes,
  })
}

describe('offline execution receipt v1', () => {
  it('builds, hashes, signs, parses exact canonical bytes, and remains ineligible', () => {
    const value = receipt()
    const raw = Buffer.from(stableStringify(value), 'utf8')
    expect(parseOfflineExecutionReceiptJsonUtf8(raw)).toEqual(value)
    expect(verifyReceipt(value)).toEqual({
      valid: true,
      finalizationEligible: false,
      reason: 'offline_simulator_only',
      receipt: value,
    })
    const event = buildExecutionEventV2FromOfflineReceipt(value)
    expect(event).toMatchObject({
      commandId: value.commandId,
      sequence: value.lifecycleSequence,
      kind: value.lifecycleKind,
      evidenceReceiptId: value.receiptId,
    })
    expect(executionEventV2MatchesOfflineReceipt(value, event)).toBe(true)
    const { eventId: _eventId, ...eventCore } = event
    const wrongProjectionCore = { ...eventCore, sequence: '3' }
    expect(executionEventV2MatchesOfflineReceipt(value, {
      ...wrongProjectionCore,
      eventId: sha256Canonical(wrongProjectionCore),
    })).toBe(false)
  })

  it('rejects noncanonical JSON and duplicate-key text', () => {
    const value = receipt()
    expect(() => parseOfflineExecutionReceiptJsonUtf8(
      Buffer.from(JSON.stringify(value, null, 2), 'utf8'),
    )).toThrow('offline_execution_receipt_canonical_json_invalid')
    expect(() => parseOfflineExecutionReceiptJsonUtf8(
      Buffer.from(stableStringify(value).replace('{', '{"scope":"offline_simulator_only",'), 'utf8'),
    )).toThrow('offline_execution_receipt_canonical_json_invalid')
  })

  it('rejects receipt hash and signed-field tampering', () => {
    const value = receipt()
    expect(verifyReceipt({ ...value, receiptId: '0'.repeat(64) }).reason)
      .toBe('receipt_hash_mismatch')
    expect(verifyReceipt({ ...value, signature: Buffer.alloc(64, 1).toString('base64') }).reason)
      .toBe('signature_invalid')
  })

  it('does not trust a receipt-selected key or a different key class', () => {
    const value = receipt()
    expect(verifyReceipt(value, {
      trustPolicy: { keyId: 'different-policy-key' },
    }).reason).toBe('untrusted_adapter_key')
    const wrongPrivate = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.alloc(32, 8),
      ]),
      format: 'der',
      type: 'pkcs8',
    })
    expect(verifyReceipt(value, {
      trustPolicy: { publicKey: createPublicKey(wrongPrivate) },
    }).reason).toBe('signature_invalid')
  })

  it.each([
    ['adapterId', 'different-adapter'],
    ['adapterBuildHash', '0'.repeat(64)],
    ['adapterConfigHash', '0'.repeat(64)],
    ['adapterRunId', 'different-run'],
  ])('rejects trust-policy identity mismatch for %s', (field, changed) => {
    const value = receipt()
    expect(verifyReceipt(value, { trustPolicy: { [field]: changed } }).reason)
      .toBe('adapter_identity_mismatch')
  })

  it.each([
    ['commandId', '0'.repeat(64)],
    ['permitV2Id', '0'.repeat(64)],
    ['acceptedSequence', '9'],
    ['lifecycleSequence', '9'],
    ['idempotencyKey', 'different-key'],
    ['accountId', 'different-account'],
    ['clientOrderId', 'DIFFERENT1'],
    ['quantity', '0.002'],
    ['price', '99999'],
  ])('rejects expected-binding mismatch for %s', (field, changed) => {
    const value = receipt()
    expect(verifyReceipt(value, { expected: { [field]: changed } }).reason)
      .toBe('expected_binding_mismatch')
  })

  it('requires the exact canonical request and response evidence', () => {
    expect(verifyReceipt(receipt(), {
      responseBytes: Buffer.from(stableStringify({ ...response, state: 'filled' }), 'utf8'),
    }).reason).toBe('raw_evidence_mismatch')
    expect(verifyReceipt(receipt(), {
      requestBytes: Buffer.from(JSON.stringify(request, null, 2), 'utf8'),
    }).reason).toBe('raw_evidence_mismatch')
    const projectedAsFilled = receipt({
      lifecycleKind: 'filled',
      filledQuantity: request.quantity,
      averagePrice: request.price,
    })
    expect(verifyReceipt(projectedAsFilled).reason).toBe('raw_evidence_mismatch')
  })

  it('keeps permit-authority and simulator receipt signer roles disjoint', () => {
    const value = receipt()
    expect(verifyReceipt(value, {
      trustPolicy: { permitAuthorityKeyIds: [value.permitKeyId, value.adapterKeyId] },
    }).reason).toBe('untrusted_adapter_key')
    expect(() => receipt({ adapterKeyId: value.permitKeyId })).not.toThrow()
    const sameRole = receipt({ adapterKeyId: value.permitKeyId })
    expect(verifyReceipt(sameRole, {
      trustPolicy: {
        keyId: sameRole.adapterKeyId,
        permitAuthorityKeyIds: [sameRole.permitKeyId],
      },
    }).reason).toBe('untrusted_adapter_key')
    expect(verifyReceipt(value, {
      trustPolicy: {
        permitAuthorityPublicKeyFingerprints: [
          ed25519PublicKeyFingerprintSha256(publicKey),
        ],
      },
    }).reason).toBe('untrusted_adapter_key')
  })

  it('rejects a receipt outside the bounded future-skew policy', () => {
    expect(verifyReceipt(receipt(), {
      now: new Date('2026-08-15T00:59:00.000Z'),
    }).reason).toBe('receipt_from_future')
  })

  it.each([
    { scope: 'broker_terminal' },
    { mode: 'PAPER_EXCHANGE' },
    { lifecycleSequence: '0' },
    { attemptNumber: '01' },
    { attemptId: '0'.repeat(64) },
    { simulatedOrderId: 'OKX123' },
    { adapterObservedAt: '2026-08-15T01:00:01Z' },
    { extra: true },
  ])('rejects malformed or source-upgraded core %#', change => {
    expect(() => createOfflineExecutionReceiptV1({
      core: { ...core(), ...change },
      privateKey,
    })).toThrow()
  })

  it('requires fill facts and forbids them on a submitted receipt', () => {
    expect(() => receipt({ lifecycleKind: 'filled' })).toThrow(/fill receipts require/)
    expect(() => receipt({ filledQuantity: '0.001', averagePrice: '100000' })).toThrow(
      /only fill receipts/,
    )
    expect(() => receipt({
      lifecycleKind: 'filled',
      filledQuantity: request.quantity,
      averagePrice: '100000',
    })).not.toThrow()
    expect(() => receipt({
      lifecycleKind: 'partially_filled',
      filledQuantity: request.quantity,
      averagePrice: '100000',
    })).toThrow(/filled quantity is inconsistent/)
    expect(() => receipt({
      lifecycleKind: 'filled',
      filledQuantity: request.quantity,
      averagePrice: '100001',
    })).toThrow(/authorized price or notional/)
  })

  it('bounds receipt/evidence size, JSON complexity, and decimal precision', () => {
    expect(() => parseOfflineExecutionReceiptJsonUtf8(
      Buffer.alloc(MAX_OFFLINE_EXECUTION_RECEIPT_JSON_BYTES + 1, 0x20),
    )).toThrow('offline_execution_receipt_canonical_json_invalid')
    expect(verifyReceipt(receipt(), {
      requestBytes: Buffer.alloc(MAX_OFFLINE_SIMULATOR_REQUEST_JSON_BYTES + 1, 0x20),
    }).reason).toBe('raw_evidence_mismatch')
    let nested: unknown = 'leaf'
    for (let index = 0; index < 20; index += 1) nested = [nested]
    expect(() => parseOfflineExecutionReceiptJsonUtf8(
      Buffer.from(JSON.stringify(nested), 'utf8'),
    )).toThrow('offline_execution_receipt_canonical_json_invalid')
    expect(() => receipt({ quantity: '1'.repeat(33) })).toThrow(/bounded canonical precision/)
  })

  it('requires the adapter event to follow acknowledgement and stay within notional', () => {
    expect(() => receipt({ lifecycleSequence: '1' })).toThrow(/follow durable acknowledgement/)
    expect(() => receipt({ quantity: '2', price: '100', maxNotionalUsd: '199' }))
      .toThrow(/authorized maximum/)
  })

  it('binds transition, predecessor, source sequence, attempt, and epoch', () => {
    expect(() => receipt({ transitionNumber: '2' })).toThrow(/predecessor/)
    expect(() => receipt({ previousReceiptId: 'f'.repeat(64) })).toThrow(/predecessor/)
    expect(() => receipt({
      transitionNumber: '2',
      sourceSequence: '2',
      lifecycleSequence: '3',
      previousReceiptId: 'f'.repeat(64),
    })).not.toThrow()
    const value = receipt()
    expect(verifyReceipt(value, {
      expected: { previousReceiptId: 'f'.repeat(64) },
    }).reason).toBe('expected_binding_mismatch')
    expect(verifyReceipt(value, {
      expected: { sourceSequence: '2' },
    }).reason).toBe('expected_binding_mismatch')
    expect(verifyReceipt(value, {
      expected: { adapterEpoch: '2' },
    }).reason).toBe('expected_binding_mismatch')
  })

  it('does not accept a runtime-partial expected binding object', () => {
    const value = receipt()
    const result = verifyOfflineExecutionReceiptV1({
      receipt: value,
      canonicalRequestJsonUtf8: requestBytes,
      canonicalResponseJsonUtf8: responseBytes,
      trustPolicy: {
        keyId: value.adapterKeyId,
        adapterId: value.adapterId,
        adapterBuildHash: value.adapterBuildHash,
        adapterConfigHash: value.adapterConfigHash,
        adapterRunId: value.adapterRunId,
        permitAuthorityKeyIds: [value.permitKeyId],
        permitAuthorityPublicKeyFingerprints: [
          ed25519PublicKeyFingerprintSha256(permitPublicKey),
        ],
        publicKey,
      },
      expected: { commandId: value.commandId } as OfflineExecutionReceiptExpectedBinding,
      now: new Date('2026-08-15T01:00:02.000Z'),
    })
    expect(result).toEqual({ valid: false, reason: 'expected_binding_mismatch' })
    const { previousReceiptId: _omitted, ...missingPreviousReceiptId } = expected(value)
    expect(verifyOfflineExecutionReceiptV1({
      receipt: value,
      canonicalRequestJsonUtf8: requestBytes,
      canonicalResponseJsonUtf8: responseBytes,
      trustPolicy: {
        keyId: value.adapterKeyId,
        adapterId: value.adapterId,
        adapterBuildHash: value.adapterBuildHash,
        adapterConfigHash: value.adapterConfigHash,
        adapterRunId: value.adapterRunId,
        permitAuthorityKeyIds: [value.permitKeyId],
        permitAuthorityPublicKeyFingerprints: [
          ed25519PublicKeyFingerprintSha256(permitPublicKey),
        ],
        publicKey,
      },
      expected: missingPreviousReceiptId as OfflineExecutionReceiptExpectedBinding,
      now: new Date('2026-08-15T01:00:02.000Z'),
    })).toEqual({ valid: false, reason: 'expected_binding_mismatch' })
  })
})
