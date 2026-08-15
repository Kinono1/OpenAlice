import { createPrivateKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { stableStringify } from '../../sidecar/contracts.js'
import {
  createExecutionPermitV2Signer,
  executionPermitV2Id,
  type ExecutionPermitV2,
  type ExecutionPermitV2Signer,
} from './execution-protocol.js'
import {
  issueExecutionPermit,
  type ExecutionAuthoritySnapshot,
  type ExecutionPermitRequest,
  type ExecutionPermitV1,
} from './execution-permit.js'
import {
  createExecutionSidecarWriter,
  type ExecutionSidecarTransport,
  type ExecutionSidecarTransportRequest,
} from './execution-sidecar-writer.js'
import type { BrokerWriteAuthorizationContext } from './operation-dispatcher.execution-gate.js'
import type { CryptoPlaceOrderRequest } from './operation-dispatcher.types.js'
import { admissionDecisionId, type AdmissionDecisionV1 } from '../../runtime/admission.js'

// RFC 8032 test vector 1 private key; it is deliberately public test material.
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
})
const SOURCE_COMMIT = '1'.repeat(40)
const DIRTY_HASH = '2'.repeat(64)
const RELEASE_HASH = '3'.repeat(64)
const MAX_UINT64 = '18446744073709551615'

describe('execution sidecar writer', () => {
  it('uses the real signer and sends canonical exact command and permit bytes for accepted and duplicate receipts', async () => {
    const capture: ExecutionSidecarTransportRequest[] = []
    const transport: ExecutionSidecarTransport = {
      async execute(request) {
        capture.push(request)
        return {
          disposition: capture.length === 1 ? 'accepted' : 'duplicate',
          commandId: request.command.commandId,
          acceptedSequence: capture.length === 1 ? '1' : MAX_UINT64,
        }
      },
    }
    const { context, signer } = makeAuthorizedContext()
    const writer = createWriter(signer, transport)

    const accepted = await writer.placeOrder(makeOrder(), context)
    const duplicate = await writer.placeOrder(makeOrder(), context)

    expect(accepted).toMatchObject({
      kind: 'command_accepted', acceptedSequence: '1', permitV2Id: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(duplicate).toMatchObject({ kind: 'command_accepted', acceptedSequence: MAX_UINT64 })
    expect(capture).toHaveLength(2)
    for (const request of capture) {
      expect(Buffer.from(request.canonicalPayloadJsonUtf8).toString('utf8'))
        .toBe(stableStringify(request.command.payload))
      expect(Buffer.from(request.permitJsonUtf8).toString('utf8'))
        .toBe(stableStringify(request.permit))
      expect(request.command.commandId).toBe(request.permit.commandHash)
      expect(request.command.payload.idempotencyKey).toBe('intent-1')
    }
  })

  it.each(['rejected', 'suspended', 'unavailable'] as const)(
    'keeps remote %s admission disposition unresolved without broker proof',
    async disposition => {
      const transport: ExecutionSidecarTransport = {
        async execute(request) {
          return { disposition, commandId: request.command.commandId, reason: 'policy_denied' }
        },
      }
      const { context, signer } = makeAuthorizedContext()
      const result = await createWriter(signer, transport).placeOrder(makeOrder(), context)
      expect(result).toEqual(expect.objectContaining({
        kind: 'submission_unknown',
        error: `execution_sidecar_${disposition}:policy_denied`,
        commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
        permitV2Id: expect.stringMatching(/^[a-f0-9]{64}$/),
        clientOrderId: expect.stringMatching(/^OA[A-F0-9]{30}$/),
      }))
    },
  )

  it('maps thrown transport errors to unknown and never leaks an error message', async () => {
    const transport: ExecutionSidecarTransport = {
      async execute() { throw new Error('credential=must-not-leak') },
    }
    const { context, signer } = makeAuthorizedContext()
    await expect(createWriter(signer, transport).placeOrder(makeOrder(), context)).resolves.toEqual(expect.objectContaining({
      kind: 'submission_unknown', error: 'execution_sidecar_transport_error:Error',
      commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
    }))
  })

  it('aborts the in-flight transport and reports unknown on timeout', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const transport: ExecutionSidecarTransport = {
        execute(_request, options) {
          signal = options.signal
          return new Promise(() => undefined)
        },
      }
      const { context, signer } = makeAuthorizedContext()
      const pending = createWriter(signer, transport, 10).placeOrder(makeOrder(), context)
      await vi.advanceTimersByTimeAsync(10)
      await expect(pending).resolves.toEqual(expect.objectContaining({
        kind: 'submission_unknown', error: 'execution_sidecar_transport_timeout:10ms',
        commandId: expect.stringMatching(/^[a-f0-9]{64}$/),
      }))
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['extra response field', (id: string) => ({ disposition: 'accepted', commandId: id, acceptedSequence: '1', extra: true })],
    ['zero sequence', (id: string) => ({ disposition: 'accepted', commandId: id, acceptedSequence: '0' })],
    ['overflow sequence', (id: string) => ({ disposition: 'accepted', commandId: id, acceptedSequence: '18446744073709551616' })],
    ['noncanonical sequence', (id: string) => ({ disposition: 'accepted', commandId: id, acceptedSequence: '01' })],
    ['wrong command id', (_id: string) => ({ disposition: 'accepted', commandId: '0'.repeat(64), acceptedSequence: '1' })],
  ])('fails closed for %s', async (_name, response) => {
    const transport: ExecutionSidecarTransport = { async execute(request) { return response(request.command.commandId) } }
    const { context, signer } = makeAuthorizedContext()
    const result = await createWriter(signer, transport).placeOrder(makeOrder(), context)
    expect(result).toEqual(expect.objectContaining({ kind: 'submission_unknown' }))
  })

  it('refuses the dispatcher test bypass before signing or transport', async () => {
    const execute = vi.fn<ExecutionSidecarTransport['execute']>()
    const { signer } = makeAuthorizedContext()
    await expect(createWriter(signer, { execute }).placeOrder(makeOrder(), { kind: 'test_bypass' }))
      .resolves.toEqual({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_test_bypass_forbidden',
      })
    expect(execute).not.toHaveBeenCalled()
  })

  it.each([
    ['market', { type: 'market' }],
    ['sell', { side: 'sell' }],
    ['reduce only', { reduceOnly: true }],
    ['malformed reduce-only flag', { reduceOnly: 'false' as unknown as boolean }],
    ['wrong symbol', { symbol: 'ETH/USDT' }],
    ['usd size', { usd_size: 50 }],
    ['unsupported leverage', { leverage: 2 }],
    ['missing size', { size: undefined }],
    ['missing price', { price: undefined }],
    ['missing time in force', { timeInForce: undefined }],
  ] as const)('rejects %s before transport', async (_name, patch) => {
    const execute = vi.fn<ExecutionSidecarTransport['execute']>()
    const { context, signer } = makeAuthorizedContext()
    await expect(createWriter(signer, { execute }).placeOrder({ ...makeOrder(), ...patch }, context))
      .resolves.toEqual(expect.objectContaining({
        kind: 'pre_submit_rejected',
        error: expect.stringMatching(/^execution_sidecar_/),
      }))
    expect(execute).not.toHaveBeenCalled()
  })

  it('rejects signer failure and structurally valid malicious V2 command mismatch before transport', async () => {
    const execute = vi.fn<ExecutionSidecarTransport['execute']>()
    const { context, signer } = makeAuthorizedContext()
    const failingSigner: ExecutionPermitV2Signer = {
      async sign() { throw new Error('credential=must-not-leak') },
    }
    await expect(createWriter(failingSigner, { execute }).placeOrder(makeOrder(), context))
      .resolves.toEqual({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_signing_failed',
      })

    const maliciousSigner: ExecutionPermitV2Signer = {
      async sign(input) {
        const signed = await signer.sign(input)
        const core = withoutPermitSignature({ ...signed, commandHash: 'f'.repeat(64) })
        return { ...signed, ...core, permitId: executionPermitV2Id(core) }
      },
    }
    await expect(createWriter(maliciousSigner, { execute }).placeOrder(makeOrder(), context))
      .resolves.toEqual({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_v2_binding_mismatch:commandHash',
      })
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps cancel and leverage adjustment disabled without calling transport', async () => {
    const execute = vi.fn<ExecutionSidecarTransport['execute']>()
    const { context, signer } = makeAuthorizedContext()
    const writer = createWriter(signer, { execute })
    await expect(writer.cancelOrder('order-1', context)).resolves.toEqual({
      kind: 'pre_submit_rejected',
      error: 'execution_sidecar_cancel_unsupported',
    })
    await expect(writer.adjustLeverage('BTC/USDT', 2, context))
      .resolves.toEqual({
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_adjust_leverage_unsupported',
      })
    expect(execute).not.toHaveBeenCalled()
  })
})

function createWriter(
  signer: ExecutionPermitV2Signer,
  transport: ExecutionSidecarTransport,
  transportTimeoutMs = 1000,
) {
  return createExecutionSidecarWriter({
    mode: 'PAPER_EXCHANGE', signer, transport, transportTimeoutMs,
  })
}

function makeOrder(overrides: Partial<CryptoPlaceOrderRequest> = {}): CryptoPlaceOrderRequest {
  return {
    symbol: 'BTC/USDT', side: 'buy', type: 'limit', size: 0.0005, price: 100000.5,
    timeInForce: 'GTC', leverage: 1, reduceOnly: false, idempotencyKey: 'intent-1', ...overrides,
  }
}

function makeAuthorizedContext(): {
  context: Extract<BrokerWriteAuthorizationContext, { kind: 'execution_permit_v1' }>
  signer: ExecutionPermitV2Signer
} {
  const now = new Date()
  const snapshot = makeSnapshot(now)
  const request = makeRequest(now)
  const issued = issueExecutionPermit(request, snapshot)
  if (!issued.allowed) throw new Error(`test permit failed: ${issued.reasonCodes.join(',')}`)
  return {
    context: { kind: 'execution_permit_v1', permit: issued.permit, request },
    signer: createExecutionPermitV2Signer({
      authorityProvider: async () => snapshot,
      mode: 'PAPER_EXCHANGE', keyId: 'rfc8032-test-1', privateKey: PRIVATE_KEY,
    }),
  }
}

function makeRequest(now: Date): ExecutionPermitRequest {
  return {
    intentId: 'intent-1', action: 'open', riskReducing: false,
    accountId: 'paper-main', accountMode: 'paper_only', symbol: 'BTC/USDT', side: 'buy',
    notionalUsd: 50.00025, ticketId: 'ticket-1', idempotencyKey: 'intent-1',
    completedChecks: [
      'account_fresh', 'authority_fresh', 'idempotency_reserved', 'kill_switch_passed',
      'limits_passed', 'market_data_fresh', 'positions_fresh', 'risk_passed',
      'slippage_policy_loaded', 'ticket_valid',
    ],
    now, ttlMs: 30_000,
  }
}

function makeSnapshot(now: Date): ExecutionAuthoritySnapshot {
  return {
    decision: makeDecision(now),
    identity: {
      runtimeRole: 'primary', sourceCommit: SOURCE_COMMIT,
      dirtyStateHash: DIRTY_HASH, releaseManifestHash: RELEASE_HASH,
    },
  }
}

function makeDecision(now: Date): AdmissionDecisionV1 {
  const gateIds = ['promotion_v2_6', 'risk', 'kill_switch', 'data_freshness']
  const core: Omit<AdmissionDecisionV1, 'schemaVersion' | 'decisionId'> = {
    candidateId: 'candidate-v2', evaluatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
    sourceCommit: SOURCE_COMMIT, dirtyStateHash: DIRTY_HASH, releaseManifestHash: RELEASE_HASH,
    stage: 'paper_allowed', paperTradingAllowed: true, liveTradingAllowed: false, liveExecutionArmed: false,
    gateResults: gateIds.map((gateId, index) => ({
      gateId, status: 'pass' as const, evidenceRefs: [String(index + 4).repeat(64).slice(0, 64)], reasonCodes: [],
    })),
    blockingReasons: [], evidenceRefs: gateIds.map((_, index) => String(index + 4).repeat(64).slice(0, 64)),
    approvalRefs: [], accountScope: ['paper-main'], assetScope: ['BTC/USDT'],
  }
  return { schemaVersion: 'admission_decision.v1', decisionId: admissionDecisionId(core), ...core }
}

function withoutPermitSignature(value: Record<string, unknown>) {
  const { permitId: _permitId, signature: _signature, ...core } = value
  return core as Parameters<typeof executionPermitV2Id>[0]
}
