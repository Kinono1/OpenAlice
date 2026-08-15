import { createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildExecutionCommandV1,
  buildExecutionEventV1,
  createExecutionPermitV2Signer,
  deriveOkxClientOrderId,
  executionCommandPayloadV1Schema,
  executionEventV1Schema,
  executionEventV2Schema,
  executionEventSchema,
  executionPermitV2Id,
  executionPermitV2Schema,
  verifyExecutionPermitV2,
  type ExecutionPermitV2,
} from './execution-protocol.js'
import {
  executionPermitId,
  issueExecutionPermit,
  type ExecutionAuthoritySnapshot,
  type ExecutionPermitRequest,
  type ExecutionPermitV1,
} from './execution-permit.js'
import {
  admissionDecisionId,
  type AdmissionDecisionV1,
} from '../../runtime/admission.js'

const NOW = new Date('2026-08-15T00:00:01.000Z')
const ISSUED_AT = new Date('2026-08-15T00:00:00.000Z')
const SOURCE_COMMIT = '1'.repeat(40)
const DIRTY_HASH = '2'.repeat(64)
const RELEASE_HASH = '3'.repeat(64)
// RFC 8032, test vector 1. The public/private keys are deliberately public test material.
const PRIVATE_KEY_DER = Buffer.from(
  '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
  'hex',
)
const PUBLIC_KEY_DER = Buffer.from(
  '302a300506032b6570032100d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a',
  'hex',
)
const PRIVATE_KEY = createPrivateKey({ key: PRIVATE_KEY_DER, format: 'der', type: 'pkcs8' })
const PUBLIC_KEY = createPublicKey({ key: PUBLIC_KEY_DER, format: 'der', type: 'spki' })
const fixture = JSON.parse(readFileSync(
  new URL('../../sidecar/fixtures/openalice_execution_contract_v1.json', import.meta.url),
  'utf8',
)) as { command: unknown; permit: unknown; event: unknown }

describe('OpenAlice execution protocol v1', () => {
  it('matches and verifies the static RFC8032-signed golden paper command', async () => {
    const snapshot = makeSnapshot()
    const v1Permit = issueV1Permit(snapshot)
    const command = buildExecutionCommandV1(makePayload())
    const permit = await makeSigner(snapshot).sign({
      v1Permit,
      v1Request: makeRequest(),
      payload: command.payload,
      now: NOW,
    })

    expect(fixture.command).toEqual(command)
    expect(fixture.permit).toEqual(permit)
    expect(deriveOkxClientOrderId('intent-1')).toHaveLength(32)
    expect(verifyExecutionPermitV2({
      ...fixture,
      now: NOW,
      resolvePublicKey: keyId => keyId === 'rfc8032-test-1' ? PUBLIC_KEY : undefined,
    })).toEqual(expect.objectContaining({ valid: true }))
  })

  it('refuses to sign a content-hashed V1 object that the current authority did not authorize', async () => {
    const snapshot = makeSnapshot()
    const valid = issueV1Permit(snapshot)
    const { schemaVersion: _schemaVersion, permitId: _permitId, ...core } = valid
    const forgedCore = { ...core, notionalUsd: 500 }
    const forged: ExecutionPermitV1 = {
      schemaVersion: 'execution_permit.v1',
      ...forgedCore,
      permitId: executionPermitId(forgedCore),
    }

    await expect(makeSigner(snapshot).sign({
      v1Permit: forged,
      v1Request: makeRequest(),
      payload: makePayload(),
      now: NOW,
    })).rejects.toThrow('v1_execution_permit_not_authorized')
  })

  it('preserves the V1 economic scope and risk direction in the signed command', async () => {
    const snapshot = makeSnapshot()
    const signer = makeSigner(snapshot)
    const v1Permit = issueV1Permit(snapshot)

    await expect(signer.sign({
      v1Permit,
      v1Request: makeRequest(),
      payload: makePayload({ maxNotionalUsd: '51' }),
      now: NOW,
    })).rejects.toThrow('v1_notional_command_mismatch')
    await expect(signer.sign({
      v1Permit,
      v1Request: makeRequest(),
      payload: makePayload({ reduceOnly: true }),
      now: NOW,
    })).rejects.toThrow('v1_risk_direction_command_mismatch')
    await expect(makeSigner(snapshot, 'PAPER_LOCAL').sign({
      v1Permit,
      v1Request: makeRequest(),
      payload: makePayload(),
      now: NOW,
    })).rejects.toThrow('configured_mode_command_mismatch')
  })

  it('rejects tampered permit signatures and altered command bindings', () => {
    const permit = fixture.permit as ExecutionPermitV2
    const tamperedCore = { ...permit, decisionId: '9'.repeat(64) }
    const tampered = {
      ...tamperedCore,
      permitId: executionPermitV2Id(withoutPermitSignature(tamperedCore)),
    }
    expect(verifyExecutionPermitV2({
      permit: tampered,
      command: fixture.command,
      now: NOW,
      resolvePublicKey: () => PUBLIC_KEY,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'invalid_signature' }))

    const altered = buildExecutionCommandV1(makePayload({ quantity: '0.0004' }))
    expect(verifyExecutionPermitV2({
      permit: fixture.permit,
      command: altered,
      now: NOW,
      resolvePublicKey: () => PUBLIC_KEY,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'command_hash_mismatch' }))
  })

  it('fails closed for expiry, future issue time, unknown keys, and excessive TTL', () => {
    expect(verifyExecutionPermitV2({
      ...fixture,
      now: new Date('2026-08-15T00:01:00.000Z'),
      resolvePublicKey: () => PUBLIC_KEY,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'permit_expired' }))
    expect(verifyExecutionPermitV2({
      ...fixture,
      now: NOW,
      resolvePublicKey: () => undefined,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'unknown_key_id' }))

    const permit = fixture.permit as ExecutionPermitV2
    const longCore = withoutPermitSignature({
      ...permit,
      expiresAt: '2026-08-15T00:02:00.000Z',
    })
    const longTtl = { ...permit, ...longCore, permitId: executionPermitV2Id(longCore) }
    expect(verifyExecutionPermitV2({
      permit: longTtl,
      command: fixture.command,
      now: NOW,
      resolvePublicKey: () => PUBLIC_KEY,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'permit_ttl_exceeded' }))

    const futureCore = withoutPermitSignature({
      ...permit,
      issuedAt: '2026-08-15T00:01:00.000Z',
      expiresAt: '2026-08-15T00:01:30.000Z',
    })
    const future = { ...permit, ...futureCore, permitId: executionPermitV2Id(futureCore) }
    expect(verifyExecutionPermitV2({
      permit: future,
      command: fixture.command,
      now: NOW,
      maxFutureMs: 5_000,
      resolvePublicKey: () => PUBLIC_KEY,
    })).toEqual(expect.objectContaining({ valid: false, reason: 'permit_from_future' }))
  })

  it('enforces spot identity, deterministic IDs, TIF, decimals, and canonical wire text', () => {
    const payload = makePayload()
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, clientOrderId: 'bad-id' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, clientOrderId: 'OA202608150001' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, venueInstrumentId: 'BTC-USDT-SWAP' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, accountId: ' paper-main' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, quantity: '01.2' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, price: '100.0' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({ ...payload, quantity: '0.001', maxNotionalUsd: '50' }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({
      ...payload,
      mode: 'PAPER_LOCAL',
      canonicalSymbol: 'ETH/USDT',
      venueInstrumentId: 'ETH-USDT',
    }).success).toBe(false)
    expect(executionCommandPayloadV1Schema.safeParse({
      ...payload,
      orderType: 'market',
      price: undefined,
      timeInForce: 'IOC',
      quantity: '999999999',
      maxNotionalUsd: '50',
    }).success).toBe(false)
    expect(executionPermitV2Schema.safeParse({
      ...(fixture.permit as ExecutionPermitV2),
      signature: equivalentNonCanonicalBase64((fixture.permit as ExecutionPermitV2).signature),
    }).success).toBe(false)
  })

  it('keeps reduce, close, cancel, and non-buy broker permits disabled until state proofs exist', async () => {
    const snapshot = makeSnapshot()
    const signer = makeSigner(snapshot)
    const v1Permit = issueV1Permit(snapshot)
    await expect(signer.sign({
      v1Permit,
      v1Request: makeRequest(),
      payload: {
        schemaVersion: 'openalice_execution_command_payload.v1',
        accountId: 'paper-main',
        canonicalSymbol: 'BTC/USDT',
        venue: 'OKX',
        venueInstrumentId: 'BTC-USDT',
        idempotencyKey: 'intent-1',
        mode: 'PAPER_EXCHANGE',
        kind: 'cancel',
        targetClientOrderId: deriveOkxClientOrderId('intent-1'),
      },
      now: NOW,
    })).rejects.toThrow('mvp_only_open_buy_submit_permitted')

    const permit = fixture.permit as ExecutionPermitV2
    expect(executionPermitV2Schema.safeParse({
      ...permit,
      authorityAction: 'reduce',
      riskReducing: true,
      side: 'sell',
    }).success).toBe(false)
    expect(executionPermitV2Schema.safeParse({
      ...permit,
      authorityAction: 'close',
      riskReducing: true,
      side: 'sell',
    }).success).toBe(false)
    expect(executionPermitV2Schema.safeParse({
      ...permit,
      action: 'cancel',
      authorityAction: 'cancel',
      authorizedNotionalUsd: undefined,
    }).success).toBe(false)
    expect(executionPermitV2Schema.safeParse({ ...permit, side: 'sell' }).success).toBe(false)
  })

  it('hash-binds lifecycle events and covers adverse paper states', () => {
    const command = fixture.command as { commandId: string }
    const event = buildExecutionEventV1({
      schemaVersion: 'openalice_execution_event.v1',
      commandId: command.commandId,
      sequence: '1',
      occurredAt: NOW.toISOString(),
      kind: 'submission_unknown',
      clientOrderId: deriveOkxClientOrderId('intent-1'),
      reason: 'broker_ack_timeout',
    })
    expect(executionEventV1Schema.parse(fixture.event)).toEqual(fixture.event)
    expect(executionEventV1Schema.parse(event)).toEqual(event)
    expect(executionEventV1Schema.safeParse({ ...event, reason: 'tampered' }).success).toBe(false)
    expect(() => buildExecutionEventV1({
      schemaVersion: 'openalice_execution_event.v1',
      commandId: command.commandId,
      sequence: '2',
      occurredAt: NOW.toISOString(),
      kind: 'drift',
    })).toThrow()
  })

  it('hash-binds a structural receipt reference without weakening V1', () => {
    const command = fixture.command as { commandId: string }
    const event = executionEventV2Schema.parse({
      schemaVersion: 'openalice_execution_event.v2',
      eventId: '9fcd55d1c093ea16d2d7bc7d956673901bf3dc9f076c2e7c1f09993e0fc29171',
      commandId: command.commandId,
      sequence: '2',
      occurredAt: NOW.toISOString(),
      kind: 'submitted',
      clientOrderId: deriveOkxClientOrderId('intent-1'),
      venueOrderId: 'SIM0123456789ABCDEF',
      evidenceSchemaVersion: 'openalice_offline_execution_receipt.v1',
      evidenceReceiptId: 'b'.repeat(64),
    })
    expect(executionEventV2Schema.parse(event)).toEqual(event)
    expect(executionEventSchema.parse(event)).toEqual(event)
    expect(event.eventId).toBe('9fcd55d1c093ea16d2d7bc7d956673901bf3dc9f076c2e7c1f09993e0fc29171')
    expect(executionEventV2Schema.safeParse({
      ...event,
      evidenceReceiptId: 'c'.repeat(64),
    }).success).toBe(false)
    expect(executionEventV1Schema.safeParse(event).success).toBe(false)
    expect(() => executionEventV2Schema.parse({
      schemaVersion: 'openalice_execution_event.v2',
      eventId: '0'.repeat(64),
      commandId: command.commandId,
      sequence: '3',
      occurredAt: NOW.toISOString(),
      kind: 'rejected',
      clientOrderId: deriveOkxClientOrderId('intent-1'),
      evidenceSchemaVersion: 'openalice_offline_execution_receipt.v1',
      evidenceReceiptId: 'b'.repeat(64),
    })).toThrow(/reason/)
  })
})

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'openalice_execution_command_payload.v1',
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT',
    venue: 'OKX',
    venueInstrumentId: 'BTC-USDT',
    idempotencyKey: 'intent-1',
    mode: 'PAPER_EXCHANGE',
    kind: 'submit',
    clientOrderId: deriveOkxClientOrderId('intent-1'),
    side: 'buy',
    orderType: 'limit',
    quantity: '0.0005',
    price: '100000.5',
    timeInForce: 'GTC',
    reduceOnly: false,
    maxNotionalUsd: '50.00025',
    ...overrides,
  }
}

function makeRequest(overrides: Partial<ExecutionPermitRequest> = {}): ExecutionPermitRequest {
  return {
    intentId: 'intent-1',
    action: 'open',
    riskReducing: false,
    accountId: 'paper-main',
    accountMode: 'paper_only',
    symbol: 'BTC/USDT',
    side: 'buy',
    notionalUsd: 50.00025,
    ticketId: 'ticket-1',
    idempotencyKey: 'intent-1',
    completedChecks: [
      'account_fresh',
      'authority_fresh',
      'idempotency_reserved',
      'kill_switch_passed',
      'limits_passed',
      'market_data_fresh',
      'positions_fresh',
      'risk_passed',
      'slippage_policy_loaded',
      'ticket_valid',
    ],
    now: ISSUED_AT,
    ttlMs: 30_000,
    ...overrides,
  }
}

function issueV1Permit(snapshot: ExecutionAuthoritySnapshot): ExecutionPermitV1 {
  const issued = issueExecutionPermit(makeRequest(), snapshot)
  if (!issued.allowed) throw new Error(`test fixture V1 rejected: ${issued.reasonCodes.join(',')}`)
  return issued.permit
}

function makeSigner(
  snapshot: ExecutionAuthoritySnapshot,
  configuredMode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE' = 'PAPER_EXCHANGE',
) {
  return createExecutionPermitV2Signer({
    authorityProvider: async () => snapshot,
    mode: configuredMode,
    keyId: 'rfc8032-test-1',
    privateKey: PRIVATE_KEY,
  })
}

function makeSnapshot(): ExecutionAuthoritySnapshot {
  return {
    decision: makeDecision(),
    identity: {
      runtimeRole: 'primary',
      sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH,
      releaseManifestHash: RELEASE_HASH,
    },
  }
}

function makeDecision(): AdmissionDecisionV1 {
  const gateIds = ['promotion_v2_6', 'risk', 'kill_switch', 'data_freshness']
  const core: Omit<AdmissionDecisionV1, 'schemaVersion' | 'decisionId'> = {
    candidateId: 'candidate-v2',
    evaluatedAt: ISSUED_AT.toISOString(),
    expiresAt: new Date(ISSUED_AT.getTime() + 5 * 60_000).toISOString(),
    sourceCommit: SOURCE_COMMIT,
    dirtyStateHash: DIRTY_HASH,
    releaseManifestHash: RELEASE_HASH,
    stage: 'paper_allowed',
    paperTradingAllowed: true,
    liveTradingAllowed: false,
    liveExecutionArmed: false,
    gateResults: gateIds.map((gateId, index) => ({
      gateId,
      status: 'pass' as const,
      evidenceRefs: [String(index + 4).repeat(64).slice(0, 64)],
      reasonCodes: [],
    })),
    blockingReasons: [],
    evidenceRefs: gateIds.map((_, index) => String(index + 4).repeat(64).slice(0, 64)),
    approvalRefs: [],
    accountScope: ['paper-main'],
    assetScope: ['BTC/USDT'],
  }
  return {
    schemaVersion: 'admission_decision.v1',
    decisionId: admissionDecisionId(core),
    ...core,
  }
}

function withoutPermitSignature(value: Record<string, unknown>) {
  const { permitId: _permitId, signature: _signature, ...core } = value
  return core as Parameters<typeof executionPermitV2Id>[0]
}

function equivalentNonCanonicalBase64(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  if (!value.endsWith('==')) throw new Error('expected a 64-byte base64 value')
  const position = value.length - 3
  const canonicalIndex = alphabet.indexOf(value[position]!)
  if (canonicalIndex < 0 || canonicalIndex % 16 !== 0) throw new Error('input is not canonical base64')
  return `${value.slice(0, position)}${alphabet[canonicalIndex + 1]}==`
}
