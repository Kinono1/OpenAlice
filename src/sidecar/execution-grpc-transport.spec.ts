import { EventEmitter } from 'node:events'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  EXECUTION_COMMAND_PAYLOAD_V1,
  buildExecutionCommandV1,
  buildExecutionEventV1,
  deriveOkxClientOrderId,
  executionEventV2Schema,
  executionPermitV2Id,
  type ExecutionCommandPayloadV1,
  type ExecutionCommandV1,
  type ExecutionEvent,
  type ExecutionPermitV2,
} from '../domain/trading/execution-protocol.js'
import type { ExecutionSidecarTransportRequest } from '../domain/trading/execution-sidecar-writer.js'
import {
  OFFLINE_EXECUTION_RECEIPT_SCOPE,
  OFFLINE_EXECUTION_RECEIPT_V1,
  OFFLINE_SIMULATOR_REQUEST_V1,
  OFFLINE_SIMULATOR_RESPONSE_V1,
  buildExecutionEventV2FromOfflineReceipt,
  createOfflineExecutionReceiptV1,
  deriveOfflineExecutionAttemptId,
  ed25519PublicKeyFingerprintSha256,
  type OfflineExecutionReceiptCoreV1,
  type OfflineExecutionReceiptExpectedBinding,
  type OfflineExecutionReceiptTrustPolicy,
  type OfflineExecutionReceiptV1,
} from '../domain/trading/offline-execution-receipt.js'
import { sha256Canonical, stableStringify } from './contracts.js'
import {
  EXECUTION_GRPC_PROTOCOL_VERSION,
  EXECUTION_GRPC_SERVICE_ID,
  ExecutionGrpcTransport,
  type ExecutionGrpcExpectedIdentity,
  type ExecutionGrpcRawClient,
  type ExecutionGrpcRawServerStream,
} from './execution-grpc-transport.js'

const COMMAND = makeCommand()
const TEST_PERMIT = makePermit(COMMAND)
const EXPECTED_IDENTITY: ExecutionGrpcExpectedIdentity = {
  clientId: 'openalice.test-client',
  mode: 'PAPER_EXCHANGE',
  runId: 'paper-grpc-test-run',
  environmentProofHash: 'b'.repeat(64),
  schemaHash: 'a'.repeat(64),
}
const LOCAL_EXPECTED_IDENTITY: ExecutionGrpcExpectedIdentity = {
  ...EXPECTED_IDENTITY,
  mode: 'PAPER_LOCAL',
  runId: 'offline-run-1',
}
const ACKNOWLEDGED_EVENT = buildExecutionEventV1({
  schemaVersion: 'openalice_execution_event.v1',
  commandId: COMMAND.commandId,
  sequence: '1',
  occurredAt: '2026-08-15T00:00:00.000Z',
  kind: 'acknowledged',
  clientOrderId: deriveOkxClientOrderId('intent-1'),
})
const SUBMITTED_EVENT = buildExecutionEventV1({
  schemaVersion: 'openalice_execution_event.v1',
  commandId: COMMAND.commandId,
  sequence: '2',
  occurredAt: '2026-08-15T00:00:01.000Z',
  kind: 'submitted',
  clientOrderId: deriveOkxClientOrderId('intent-1'),
  venueOrderId: 'okx-paper-order-1',
})
const OFFLINE_V2_EVENT_CORE = {
  schemaVersion: 'openalice_execution_event.v2' as const,
  commandId: COMMAND.commandId,
  sequence: '2',
  occurredAt: '2026-08-15T00:00:01.000Z',
  kind: 'submitted' as const,
  clientOrderId: deriveOkxClientOrderId('intent-1'),
  venueOrderId: 'SIM0123456789ABCDEF',
  evidenceSchemaVersion: 'openalice_offline_execution_receipt.v1' as const,
  evidenceReceiptId: 'b'.repeat(64),
}
const OFFLINE_V2_EVENT = executionEventV2Schema.parse({
  ...OFFLINE_V2_EVENT_CORE,
  eventId: sha256Canonical(OFFLINE_V2_EVENT_CORE),
})
const OFFLINE_RECEIPT_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const OFFLINE_RECEIPT_PUBLIC_KEY = createPublicKey(OFFLINE_RECEIPT_PRIVATE_KEY)
const OFFLINE_PERMIT_PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.alloc(32, 7),
  ]),
  format: 'der',
  type: 'pkcs8',
})
const OFFLINE_PERMIT_PUBLIC_KEY = createPublicKey(OFFLINE_PERMIT_PRIVATE_KEY)

describe('ExecutionGrpcTransport', () => {
  it('uses an absolute UDS target and maps an Execute request without changing canonical bytes', async () => {
    const target = vi.fn()
    const raw = makeRawClient({
      command_id: COMMAND.commandId,
      disposition: 1,
      accepted_sequence: '1',
    })
    const transport = new ExecutionGrpcTransport({
      socketPath: '/private/tmp/openalice.sock',
      rpcDeadlineMs: 500,
      createClient: receivedTarget => {
        target(receivedTarget)
        return raw.client
      },
    })

    await expect(transport.verifyReady(EXPECTED_IDENTITY)).resolves.toMatchObject({
      protocolVersion: EXECUTION_GRPC_PROTOCOL_VERSION,
      serviceId: EXECUTION_GRPC_SERVICE_ID,
      writerEpoch: '1',
      latestSequence: '0',
    })

    const response = await transport.execute(makeRequest(), { signal: new AbortController().signal })

    expect(target).toHaveBeenCalledWith('unix:/private/tmp/openalice.sock')
    expect(raw.executeRequest).toMatchObject({
      command: {
        schema_version: COMMAND.schemaVersion,
        command_id: COMMAND.commandId,
        payload_hash: COMMAND.payloadHash,
        payload: {
          schema_version: COMMAND.payload.schemaVersion,
          kind: 1,
          account_id: 'paper-main',
          canonical_symbol: 'BTC/USDT',
          venue: 1,
          venue_instrument_id: 'BTC-USDT',
          idempotency_key: 'intent-1',
          mode: 2,
          client_order_id: COMMAND.payload.kind === 'submit' ? COMMAND.payload.clientOrderId : undefined,
          side: 1,
          order_type: 2,
          quantity: '0.0005',
          price: '100000.5',
          time_in_force: 1,
          reduce_only: false,
          max_notional_usd: '50.00025',
        },
      },
    })
    expect(Buffer.isBuffer(raw.executeRequest?.command && (raw.executeRequest.command as Record<string, unknown>).canonical_payload_json_utf8)).toBe(true)
    expect(Buffer.from((raw.executeRequest?.command as Record<string, unknown>).canonical_payload_json_utf8 as Uint8Array))
      .toEqual(Buffer.from(makeRequest().canonicalPayloadJsonUtf8))
    expect(Buffer.from(raw.executeRequest?.permit_json_utf8 as Uint8Array))
      .toEqual(Buffer.from(makeRequest().permitJsonUtf8))
    expect(response).toEqual({ commandId: COMMAND.commandId, disposition: 'accepted', acceptedSequence: '1' })
    expect(raw.executeDeadline?.getTime()).toBeGreaterThan(Date.now())
    transport.close()
    expect(raw.close).toHaveBeenCalledOnce()
  })

  it.each([
    [1, { disposition: 'accepted', acceptedSequence: '1' }],
    [2, { disposition: 'duplicate', acceptedSequence: '18446744073709551615' }],
    [3, { disposition: 'rejected', reason: 'policy_denied' }],
    [4, { disposition: 'suspended', reason: 'writer_fenced' }],
    [5, { disposition: 'unavailable', reason: 'receiver_unavailable' }],
  ] as const)('maps Execute disposition %i', async (disposition, expected) => {
    const raw = makeRawClient({
      command_id: COMMAND.commandId,
      disposition,
      ...(disposition === 1 ? { accepted_sequence: '1' }
        : disposition === 2 ? { accepted_sequence: '18446744073709551615' }
          : disposition === 3 ? { reason: 'policy_denied' }
            : disposition === 4 ? { reason: 'writer_fenced' }
              : { reason: 'receiver_unavailable' }),
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.execute(makeRequest(), { signal: new AbortController().signal }))
      .resolves.toEqual({ commandId: COMMAND.commandId, ...expected })
  })

  it.each([
    ['cancel', makeVariantCommand({ kind: 'cancel', targetClientOrderId: deriveOkxClientOrderId('target-1') }), {
      kind: 2, target_client_order_id: deriveOkxClientOrderId('target-1'),
    }],
    ['replace', makeVariantCommand({
      kind: 'replace', targetClientOrderId: deriveOkxClientOrderId('target-1'),
      replacementClientOrderId: deriveOkxClientOrderId('intent-1'),
      quantity: '0.0004', price: '100000', timeInForce: 'IOC', maxNotionalUsd: '50',
    }), {
      kind: 3, target_client_order_id: deriveOkxClientOrderId('target-1'),
      replacement_client_order_id: deriveOkxClientOrderId('intent-1'), quantity: '0.0004',
      price: '100000', time_in_force: 2, max_notional_usd: '50',
    }],
    ['reconcile', makeVariantCommand({ kind: 'reconcile', afterSequence: '9' }), {
      kind: 4, after_sequence: '9',
    }],
    ['suspend', makeVariantCommand({ kind: 'suspend', reason: 'manual_circuit_open' }), {
      kind: 5, reason: 'manual_circuit_open',
    }],
  ] as const)('maps %s typed command payload fields', async (_name, command, expectedPayload) => {
    const raw = makeRawClient({ command_id: command.commandId, disposition: 1, accepted_sequence: '1' })
    const transport = await makeReadyTransport(raw.client)
    await transport.execute(makeRequest(command), { signal: new AbortController().signal })
    expect((raw.executeRequest?.command as Record<string, unknown>).payload).toMatchObject(expectedPayload)
  })

  it('maps GetCommand admission and verifies the returned command id', async () => {
    const raw = makeRawClient(undefined, {
      ...wireAdmission(COMMAND),
      disposition: 2,
      accepted_sequence: '8',
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.getCommand(COMMAND.commandId)).resolves.toEqual({
      found: true,
      command: COMMAND,
      commandId: COMMAND.commandId,
      disposition: 'duplicate',
      acceptedSequence: '8',
      permitV2Id: TEST_PERMIT.permitId,
      clientOrderId: deriveOkxClientOrderId('intent-1'),
    })
    expect(raw.getCommandRequest).toEqual({ command_id: COMMAND.commandId })
  })

  it.each([
    ['cancel', makeVariantCommand({ kind: 'cancel', targetClientOrderId: deriveOkxClientOrderId('target-1') })],
    ['replace', makeVariantCommand({
      kind: 'replace',
      targetClientOrderId: deriveOkxClientOrderId('target-1'),
      replacementClientOrderId: deriveOkxClientOrderId('intent-1'),
      quantity: '0.0004',
      price: '100000',
      timeInForce: 'IOC',
      maxNotionalUsd: '50',
    })],
    ['reconcile zero cursor', makeVariantCommand({ kind: 'reconcile', afterSequence: '0' })],
    ['suspend', makeVariantCommand({ kind: 'suspend', reason: 'manual_circuit_open' })],
  ])('rejects a durable %s admission until that command kind has a command-bound permit schema', async (_label, command) => {
    const transport = await makeReadyTransport(makeRawClient(undefined, {
      found: true,
      command: wireCommand(command),
      permit_json_utf8: Buffer.from(stableStringify(TEST_PERMIT), 'utf8'),
      disposition: 1,
      accepted_sequence: '9',
    }).client)
    await expect(transport.getCommand(command.commandId))
      .rejects.toThrow('execution_grpc_get_command_permit_binding_invalid')
  })

  it.each([
    ['noncanonical payload bytes', wireCommand(COMMAND, {
      canonical_payload_json_utf8: Buffer.from(`${stableStringify(COMMAND.payload)}\n`, 'utf8'),
    })],
    ['typed projection drift', wireCommand(COMMAND, {
      payload: { ...wirePayload(COMMAND.payload), side: 2 },
    })],
    ['payload hash drift', wireCommand(COMMAND, { payload_hash: 'f'.repeat(64) })],
    ['unexpected wire field', wireCommand(COMMAND, { extra: 'untrusted' })],
  ])('fails closed on GetCommand %s', async (_label, command) => {
    const transport = await makeReadyTransport(makeRawClient(undefined, {
      ...wireAdmission(COMMAND),
      command,
    }).client)
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow(/execution_grpc_get_command/)
  })

  it('rejects a different internally valid command for the requested command id', async () => {
    const other = makeSubmitCommand('intent-other')
    const transport = await makeReadyTransport(makeRawClient(undefined, {
      ...wireAdmission(other),
    }).client)
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow('execution_grpc_get_command_id_mismatch')
  })

  it('maps a not-found command and fails closed on response id or uint64 corruption', async () => {
    await expect((await makeReadyTransport(makeRawClient(undefined, {}).client)).getCommand(COMMAND.commandId))
      .resolves.toEqual({ found: false })
    await expect((await makeReadyTransport(makeRawClient(undefined, {
      ...wireAdmission(COMMAND),
      command: wireCommand(COMMAND, { command_id: 'f'.repeat(64) }),
    }).client)).getCommand(COMMAND.commandId)).rejects.toMatchObject({ name: 'Error' })
    for (const acceptedSequence of ['0', '01', '18446744073709551616', 1] as const) {
      await expect((await makeReadyTransport(makeRawClient({
        command_id: COMMAND.commandId,
        disposition: 1,
        accepted_sequence: acceptedSequence,
      }).client)).execute(makeRequest(), { signal: new AbortController().signal })).rejects.toMatchObject({ name: 'Error' })
    }
  })

  it.each([
    ['missing permit bytes', undefined],
    ['noncanonical permit bytes', Buffer.from(`${stableStringify(TEST_PERMIT)}\n`, 'utf8')],
    [
      'unrelated permit',
      Buffer.from(stableStringify(makePermit(makeSubmitCommand('intent-other'))), 'utf8'),
    ],
  ])('fails closed on GetCommand %s', async (_label, permitBytes) => {
    const response = wireAdmission(COMMAND)
    if (permitBytes === undefined) delete response.permit_json_utf8
    else response.permit_json_utf8 = permitBytes
    const transport = await makeReadyTransport(makeRawClient(undefined, response).client)
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow(/execution_grpc_get_command_permit/)
  })

  it('returns only a signature-verified offline receipt with exact raw evidence and V2 projection', async () => {
    const fixture = makeOfflineReceiptFixture()
    const { transport, raw } = await makeReadyOfflineTransport(fixture.wireResponse)
    await expect(transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .resolves.toEqual({
        found: true,
        finalizationEligible: false,
        receipt: fixture.receipt,
        lifecycleEvent: fixture.event,
        canonicalReceiptJsonUtf8: Uint8Array.from(fixture.canonicalReceiptJsonUtf8),
        canonicalRequestJsonUtf8: Uint8Array.from(fixture.canonicalRequestJsonUtf8),
        canonicalResponseJsonUtf8: Uint8Array.from(fixture.canonicalResponseJsonUtf8),
      })
    expect(raw.offlineReceiptRequest).toEqual({ receipt_id: fixture.receipt.receiptId })
    expect(raw.offlineReceiptDeadline?.getTime()).toBeGreaterThan(Date.now())
  })

  it('preserves a missing offline receipt and rejects payload smuggling on found=false', async () => {
    const fixture = makeOfflineReceiptFixture()
    const missing = await makeReadyOfflineTransport({ found: false })
    await expect(missing.transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .resolves.toEqual({ found: false })

    const smuggled = await makeReadyOfflineTransport({
      found: false,
      canonical_receipt_json_utf8: fixture.canonicalReceiptJsonUtf8,
    })
    await expect(smuggled.transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .rejects.toThrow('execution_grpc_offline_receipt_response_invalid')
  })

  it('rejects drift between the typed offline receipt projection and canonical signed bytes', async () => {
    const fixture = makeOfflineReceiptFixture()
    const response = {
      ...fixture.wireResponse,
      receipt: {
        ...wireOfflineReceipt(fixture.receipt),
        signature: Buffer.alloc(64, 1).toString('base64'),
      },
    }
    const { transport } = await makeReadyOfflineTransport(response)
    await expect(transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .rejects.toThrow('execution_grpc_offline_receipt_projection_mismatch')
  })

  it.each([
    ['bad signature', (fixture: ReturnType<typeof makeOfflineReceiptFixture>) => {
      const receipt = {
        ...fixture.receipt,
        signature: Buffer.alloc(64, 1).toString('base64'),
      }
      return {
        ...fixture.wireResponse,
        receipt: wireOfflineReceipt(receipt),
        canonical_receipt_json_utf8: Buffer.from(stableStringify(receipt), 'utf8'),
      }
    }],
    ['noncanonical request evidence', (fixture: ReturnType<typeof makeOfflineReceiptFixture>) => ({
      ...fixture.wireResponse,
      canonical_request_json_utf8: Buffer.from(`${stableStringify(JSON.parse(
        fixture.canonicalRequestJsonUtf8.toString('utf8'),
      ))}\n`, 'utf8'),
    })],
  ] as const)('rejects an offline receipt with %s', async (_label, mutate) => {
    const fixture = makeOfflineReceiptFixture()
    const { transport } = await makeReadyOfflineTransport(mutate(fixture))
    await expect(transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .rejects.toThrow('execution_grpc_offline_receipt_untrusted')
    await expect(transport.verifyReady(LOCAL_EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('rejects a structurally valid V2 event that is not the exact receipt-derived projection', async () => {
    const fixture = makeOfflineReceiptFixture()
    const { eventId: _eventId, ...eventCore } = fixture.event
    const wrongCore = { ...eventCore, sequence: '3' }
    const wrongEvent = executionEventV2Schema.parse({
      ...wrongCore,
      eventId: sha256Canonical(wrongCore),
    })
    const { transport } = await makeReadyOfflineTransport({
      ...fixture.wireResponse,
      lifecycle_event: wireEvent(wrongEvent),
    })
    await expect(transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .rejects.toThrow('execution_grpc_offline_receipt_event_mismatch')
  })

  it('binds offline receipt reads to both the requested receipt ID and a PAPER_LOCAL peer', async () => {
    const fixture = makeOfflineReceiptFixture()
    const { transport } = await makeReadyOfflineTransport(fixture.wireResponse)
    await expect(transport.getOfflineExecutionReceipt({
      ...offlineReceiptReadRequest(fixture),
      receiptId: 'f'.repeat(64),
    })).rejects.toThrow('execution_grpc_offline_receipt_id_mismatch')

    const exchangeRaw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      offlineReceiptResponse: fixture.wireResponse,
    })
    const exchangeTransport = await makeReadyTransport(exchangeRaw.client)
    await expect(exchangeTransport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .rejects.toThrow('execution_grpc_offline_receipt_request_invalid')
    expect(exchangeRaw.offlineReceiptRequest).toBeUndefined()
  })

  it('rejects malformed local receipt trust inputs before issuing the read RPC without poisoning the peer', async () => {
    const fixture = makeOfflineReceiptFixture()
    const { transport, raw } = await makeReadyOfflineTransport(fixture.wireResponse)
    const { previousReceiptId: _previousReceiptId, ...incompleteExpected } = fixture.expected
    await expect(transport.getOfflineExecutionReceipt({
      ...offlineReceiptReadRequest(fixture),
      expected: incompleteExpected as typeof fixture.expected,
    })).rejects.toThrow('execution_grpc_offline_receipt_request_invalid')
    await expect(transport.getOfflineExecutionReceipt({
      ...offlineReceiptReadRequest(fixture),
      maxFutureMs: 30_001,
    })).rejects.toThrow('execution_grpc_offline_receipt_request_invalid')
    expect(raw.offlineReceiptRequest).toBeUndefined()
    await expect(transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture)))
      .resolves.toMatchObject({ found: true, finalizationEligible: false })
  })

  it('anchors a verified receipt event against cross-RPC lifecycle equivocation', async () => {
    const fixture = makeOfflineReceiptFixture()
    const { eventId: _eventId, ...eventCore } = fixture.event
    const conflictingCore = { ...eventCore, venueOrderId: 'SIMFEDCBA9876543210' }
    const conflictingEvent = executionEventV2Schema.parse({
      ...conflictingCore,
      eventId: sha256Canonical(conflictingCore),
    })
    const raw = makeRawClient(
      undefined,
      undefined,
      handshakeResponse({ mode: 1, run_id: LOCAL_EXPECTED_IDENTITY.runId }),
      healthResponse({ mode: 1, run_id: LOCAL_EXPECTED_IDENTITY.runId }),
      {
        offlineReceiptResponse: fixture.wireResponse,
        replayResponse: { events: [wireEvent(conflictingEvent)] },
      },
    )
    const transport = makeTransport(raw.client)
    await transport.verifyReady(LOCAL_EXPECTED_IDENTITY)
    await transport.getOfflineExecutionReceipt(offlineReceiptReadRequest(fixture))
    await expect(transport.replayEvents({ afterSequence: '1', limit: 1 }))
      .rejects.toThrow('execution_grpc_lifecycle_cross_rpc_equivocation')
    await expect(transport.verifyReady(LOCAL_EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('requires an exact durable-admission Handshake and READY Health before data RPCs', async () => {
    const raw = makeRawClient({ command_id: COMMAND.commandId, disposition: 1, accepted_sequence: '1' })
    const transport = makeTransport(raw.client)

    await expect(transport.execute(makeRequest(), { signal: new AbortController().signal }))
      .rejects.toThrow('execution_grpc_ready_not_verified')
    await expect(transport.verifyReady(EXPECTED_IDENTITY)).resolves.toEqual({
      protocolVersion: EXECUTION_GRPC_PROTOCOL_VERSION,
      serviceId: EXECUTION_GRPC_SERVICE_ID,
      mode: 'PAPER_EXCHANGE',
      runId: EXPECTED_IDENTITY.runId,
      environmentProofHash: EXPECTED_IDENTITY.environmentProofHash,
      schemaHash: EXPECTED_IDENTITY.schemaHash,
      writerEpoch: '1',
      latestSequence: '0',
    })
    expect(raw.handshakeRequest).toEqual({
      protocol_version: EXECUTION_GRPC_PROTOCOL_VERSION,
      client_id: EXPECTED_IDENTITY.clientId,
    })
    expect(raw.healthRequest).toEqual({})
    await expect(transport.execute(makeRequest(), { signal: new AbortController().signal }))
      .resolves.toMatchObject({ disposition: 'accepted' })
  })

  it('pins an exact READ_ONLY identity for diagnostics without authorizing Execute', async () => {
    const raw = makeRawClient(
      { command_id: COMMAND.commandId, disposition: 1, accepted_sequence: '1' },
      wireAdmission(COMMAND),
      handshakeResponse(),
      readOnlyHealthResponse({ latest_sequence: '1' }),
    )
    const transport = makeTransport(raw.client)

    await expect(transport.verifyReadable(EXPECTED_IDENTITY)).resolves.toEqual({
      protocolVersion: EXECUTION_GRPC_PROTOCOL_VERSION,
      serviceId: EXECUTION_GRPC_SERVICE_ID,
      mode: 'PAPER_EXCHANGE',
      runId: EXPECTED_IDENTITY.runId,
      environmentProofHash: EXPECTED_IDENTITY.environmentProofHash,
      schemaHash: EXPECTED_IDENTITY.schemaHash,
      writerEpoch: '1',
      latestSequence: '1',
    })
    await expect(transport.getCommand(COMMAND.commandId)).resolves.toMatchObject({
      found: true,
      commandId: COMMAND.commandId,
    })
    await expect(transport.execute(
      makeRequest(),
      { signal: new AbortController().signal },
    )).rejects.toThrow('execution_grpc_ready_not_verified')
    expect(raw.executeRequest).toBeUndefined()
  })

  it('keeps the writer READY probe fail-closed for an exact READ_ONLY peer', async () => {
    const raw = makeRawClient(
      undefined,
      undefined,
      handshakeResponse(),
      readOnlyHealthResponse(),
    )
    const transport = makeTransport(raw.client)
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_health_not_ready')
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow('execution_grpc_ready_not_verified')
  })

  it.each([
    ['identity drift', { run_id: 'other-run' }, 'execution_grpc_health_identity_mismatch'],
    ['epoch drift', { writer_epoch: '2' }, 'execution_grpc_health_identity_mismatch'],
    ['status drift', { status: 2, detail: 'durable_admission_ready_not_broker_ready', circuit_reason: '' }, 'execution_grpc_health_not_read_only'],
  ])('poisons a READ_ONLY diagnostic peer after %s', async (_label, patch, reason) => {
    const health = readOnlyHealthResponse()
    const raw = makeRawClient(
      undefined,
      wireAdmission(COMMAND),
      handshakeResponse(),
      health,
    )
    const transport = makeTransport(raw.client)
    await transport.verifyReadable(EXPECTED_IDENTITY)
    Object.assign(health, patch)

    await expect(transport.getCommand(COMMAND.commandId)).rejects.toThrow(reason)
    await expect(transport.verifyReadable(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('pins a monotonic health cursor and permanently poisons a retrograde peer', async () => {
    const health = readOnlyHealthResponse({ latest_sequence: '10' })
    const raw = makeRawClient(undefined, { found: false }, handshakeResponse(), health)
    const transport = makeTransport(raw.client)
    await transport.verifyReadable(EXPECTED_IDENTITY)
    health.latest_sequence = '9'

    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow('execution_grpc_health_cursor_retrograde')
    await expect(transport.verifyReadable(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('serializes concurrent peer probes so callback order cannot fabricate cursor rollback', async () => {
    const base = makeRawClient(undefined, { found: false }).client
    let healthCalls = 0
    let releaseFirstRead: (() => void) | undefined
    const client: ExecutionGrpcRawClient = {
      ...base,
      Health: (_request, _options, callback) => {
        healthCalls += 1
        if (healthCalls === 1) {
          callback(null, readOnlyHealthResponse({ latest_sequence: '9' }))
        } else if (healthCalls === 2) {
          releaseFirstRead = () => callback(
            null,
            readOnlyHealthResponse({ latest_sequence: '10' }),
          )
        } else {
          callback(null, readOnlyHealthResponse({ latest_sequence: '11' }))
        }
        return { cancel: vi.fn() }
      },
    }
    const transport = makeTransport(client)
    await transport.verifyReadable(EXPECTED_IDENTITY)
    const first = transport.getCommand(COMMAND.commandId)
    const second = transport.getCommand(COMMAND.commandId)
    await vi.waitFor(() => expect(releaseFirstRead).toBeTypeOf('function'))
    expect(healthCalls).toBe(2)
    releaseFirstRead?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { found: false },
      { found: false },
    ])
    expect(healthCalls).toBe(3)
    await expect(transport.verifyReadable(EXPECTED_IDENTITY)).resolves.toMatchObject({
      latestSequence: '11',
    })
  })

  it('never reauthorizes Execute after the transport has pinned READ_ONLY access', async () => {
    const health = readOnlyHealthResponse()
    const transport = makeTransport(makeRawClient(
      { command_id: COMMAND.commandId, disposition: 1, accepted_sequence: '1' },
      undefined,
      handshakeResponse(),
      health,
    ).client)
    await transport.verifyReadable(EXPECTED_IDENTITY)
    Object.assign(health, healthResponse())

    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_read_only_rearm_forbidden')
    await expect(transport.execute(
      makeRequest(),
      { signal: new AbortController().signal },
    )).rejects.toThrow('execution_grpc_ready_not_verified')
  })

  it.each([
    ['protocol', handshakeResponse({ protocol_version: 'openalice.execution.v0' }), healthResponse()],
    ['service', handshakeResponse({ service_id: 'untrusted.service' }), healthResponse()],
    ['mode', handshakeResponse({ mode: 1 }), healthResponse()],
    ['run', handshakeResponse({ run_id: 'other-run' }), healthResponse()],
    ['proof', handshakeResponse({ environment_proof_hash: 'c'.repeat(64) }), healthResponse()],
    ['schema', handshakeResponse({ schema_hash: 'c'.repeat(64) }), healthResponse()],
    ['zero epoch', handshakeResponse({ writer_epoch: '0' }), healthResponse()],
    ['not ready', handshakeResponse(), healthResponse({ status: 3, detail: 'durable_admission_suspended_read_only', circuit_reason: 'suspended' })],
    ['health epoch drift', handshakeResponse(), healthResponse({ writer_epoch: '2' })],
    ['health identity drift', handshakeResponse(), healthResponse({ run_id: 'other-run' })],
    ['noncanonical cursor', handshakeResponse(), healthResponse({ latest_sequence: '01' })],
  ])('fails closed when startup identity check has %s mismatch', async (_label, handshake, health) => {
    const raw = makeRawClient(undefined, undefined, handshake, health)
    const transport = makeTransport(raw.client)
    await expect(transport.verifyReady(EXPECTED_IDENTITY)).rejects.toMatchObject({ name: 'Error' })
    await expect(transport.getCommand(COMMAND.commandId)).rejects.toThrow('execution_grpc_ready_not_verified')
  })

  it('rejects malformed expected startup identity before issuing an RPC', async () => {
    const raw = makeRawClient()
    const transport = makeTransport(raw.client)
    await expect(transport.verifyReady({
      ...EXPECTED_IDENTITY,
      clientId: 'bad client',
    })).rejects.toThrow('execution_grpc_expected_identity_invalid')
    expect(raw.handshakeRequest).toBeUndefined()
  })

  it('cancels an in-flight unary call on AbortSignal and sends an RPC deadline', async () => {
    const cancel = vi.fn()
    const executeStarted = vi.fn()
    const client: ExecutionGrpcRawClient = {
      Handshake: (_request, _options, callback) => {
        callback(null, handshakeResponse())
        return { cancel }
      },
      Execute: (_request, _options, _callback) => {
        executeStarted()
        return { cancel }
      },
      GetCommand: (_request, _options, _callback) => ({ cancel }),
      GetOfflineExecutionReceipt: (_request, _options, _callback) => ({ cancel }),
      GetSnapshot: (_request, _options, _callback) => ({ cancel }),
      ReplayEvents: (_request, _options, _callback) => ({ cancel }),
      StreamEvents: () => makeRawServerStream().stream,
      Health: (_request, _options, callback) => {
        callback(null, healthResponse())
        return { cancel }
      },
    }
    const transport = await makeReadyTransport(client, 123)
    const controller = new AbortController()
    const pending = transport.execute(makeRequest(), { signal: controller.signal })
    await vi.waitFor(() => expect(executeStarted).toHaveBeenCalledOnce())
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('returns only a canonical opaque snapshot diagnostic and preserves missing as missing', async () => {
    const snapshotJson = stableStringify({ nested: { sequence: 2 }, status: 'diagnostic_only' })
    const raw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      snapshotResponse: {
        found: true,
        as_of_sequence: '2',
        snapshot_json_utf8: Buffer.from(snapshotJson, 'utf8'),
      },
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.getSnapshot({ accountId: 'paper-main', canonicalSymbol: 'BTC/USDT' }))
      .resolves.toEqual({
        found: true,
        asOfSequence: '2',
        canonicalJsonUtf8: Uint8Array.from(Buffer.from(snapshotJson, 'utf8')),
        parsed: { nested: { sequence: 2 }, status: 'diagnostic_only' },
      })
    expect(raw.snapshotRequest).toEqual({ account_id: 'paper-main', canonical_symbol: 'BTC/USDT' })
    expect(raw.snapshotDeadline?.getTime()).toBeGreaterThan(Date.now())

    const missing = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      snapshotResponse: { found: false },
    }).client)
    await expect(missing.getSnapshot({ accountId: 'paper-main', canonicalSymbol: 'BTC/USDT' }))
      .resolves.toEqual({ found: false })
  })

  it.each([
    ['invalid UTF-8', { found: true, as_of_sequence: '1', snapshot_json_utf8: Buffer.from([0xc3, 0x28]) }],
    ['noncanonical JSON', { found: true, as_of_sequence: '1', snapshot_json_utf8: Buffer.from('{"b":1, "a":2}', 'utf8') }],
    ['noncanonical cursor', { found: true, as_of_sequence: '01', snapshot_json_utf8: Buffer.from('{}', 'utf8') }],
    ['not-found payload', { found: false, as_of_sequence: '1', snapshot_json_utf8: Buffer.from('{}', 'utf8') }],
  ])('fails closed on snapshot %s', async (_label, snapshotResponse) => {
    const transport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      snapshotResponse,
    }).client)
    await expect(transport.getSnapshot({ accountId: 'paper-main', canonicalSymbol: 'BTC/USDT' }))
      .rejects.toMatchObject({ name: 'Error' })
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('replays a strictly contiguous lifecycle page with a bounded request', async () => {
    const raw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events: [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(SUBMITTED_EVENT)] },
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.replayEvents({ afterSequence: '0', limit: 2 }))
      .resolves.toEqual([ACKNOWLEDGED_EVENT, SUBMITTED_EVENT])
    expect(raw.replayRequest).toEqual({ after_sequence: '0', limit: 2 })
    expect(raw.replayDeadline?.getTime()).toBeGreaterThan(Date.now())
  })

  it('reads V2 lifecycle diagnostics with an immutable receipt reference', async () => {
    const raw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events: [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(OFFLINE_V2_EVENT)] },
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.replayEvents({ afterSequence: '0', limit: 2 }))
      .resolves.toEqual([ACKNOWLEDGED_EVENT, OFFLINE_V2_EVENT])
  })

  it('pins observed sequence hashes across separate replay calls', async () => {
    const replayResponse: { events: unknown[] } = { events: [wireEvent(ACKNOWLEDGED_EVENT)] }
    const raw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse,
    })
    const transport = await makeReadyTransport(raw.client)
    await expect(transport.replayEvents({ afterSequence: '0', limit: 1 }))
      .resolves.toEqual([ACKNOWLEDGED_EVENT])

    const fork = buildExecutionEventV1({
      schemaVersion: 'openalice_execution_event.v1',
      commandId: COMMAND.commandId,
      sequence: '1',
      occurredAt: '2026-08-15T00:00:00.001Z',
      kind: 'submitted',
      venueOrderId: 'forked-order',
    })
    replayResponse.events = [wireEvent(fork)]
    await expect(transport.replayEvents({ afterSequence: '0', limit: 1 }))
      .rejects.toThrow('execution_grpc_lifecycle_cross_rpc_equivocation')
    await expect(transport.getSnapshot({
      accountId: 'paper-main', canonicalSymbol: 'BTC/USDT',
    })).rejects.toThrow('execution_grpc_ready_not_verified')
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('revalidates and pins the writer epoch before every read call', async () => {
    const handshake = handshakeResponse()
    const health = healthResponse()
    const raw = makeRawClient(undefined, undefined, handshake, health)
    const transport = await makeReadyTransport(raw.client)
    handshake.writer_epoch = '2'
    health.writer_epoch = '2'

    await expect(transport.getSnapshot({
      accountId: 'paper-main', canonicalSymbol: 'BTC/USDT',
    })).rejects.toThrow('execution_grpc_writer_epoch_changed')
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow('execution_grpc_ready_not_verified')
  })

  it('revalidates and pins the writer epoch before Execute', async () => {
    const handshake = handshakeResponse()
    const health = healthResponse()
    const raw = makeRawClient(
      { command_id: COMMAND.commandId, disposition: 1, accepted_sequence: '1' },
      undefined,
      handshake,
      health,
    )
    const transport = await makeReadyTransport(raw.client)
    handshake.writer_epoch = '2'
    health.writer_epoch = '2'

    await expect(transport.execute(
      makeRequest(),
      { signal: new AbortController().signal },
    )).rejects.toThrow('execution_grpc_writer_epoch_changed')
    expect(raw.executeRequest).toBeUndefined()
  })

  it('rejects sparse or over-limit lifecycle pages', async () => {
    const sparse = new Array<unknown>(1)
    const sparseTransport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events: sparse },
    }).client)
    await expect(sparseTransport.replayEvents({ afterSequence: '0', limit: 1 }))
      .rejects.toThrow('execution_grpc_replay_response_invalid')

    const oversizedTransport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events: [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(SUBMITTED_EVENT)] },
    }).client)
    await expect(oversizedTransport.replayEvents({ afterSequence: '0', limit: 1 }))
      .rejects.toThrow('execution_grpc_replay_response_invalid')
  })

  it.each([
    ['gap', '0', [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(buildExecutionEventV1({
      schemaVersion: 'openalice_execution_event.v1',
      commandId: COMMAND.commandId,
      sequence: '3',
      occurredAt: '2026-08-15T00:00:02.000Z',
      kind: 'submitted',
      venueOrderId: 'gap-order',
    }))]],
    ['duplicate', '0', [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(ACKNOWLEDGED_EVENT)]],
    ['equivocation', '0', [wireEvent(ACKNOWLEDGED_EVENT), wireEvent(buildExecutionEventV1({
      schemaVersion: 'openalice_execution_event.v1',
      commandId: COMMAND.commandId,
      sequence: '1',
      occurredAt: '2026-08-15T00:00:00.001Z',
      kind: 'submitted',
      venueOrderId: 'other-order',
    }))]],
    ['retrograde', '2', [wireEvent(ACKNOWLEDGED_EVENT)]],
  ])('fails closed on lifecycle page %s', async (_label, afterSequence, events) => {
    const transport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events },
    }).client)
    await expect(transport.replayEvents({ afterSequence, limit: events.length }))
      .rejects.toThrow(/execution_grpc_lifecycle_sequence_/)
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it.each([
    ['unknown enum', { ...wireEvent(ACKNOWLEDGED_EVENT), kind: 99 }],
    ['noncanonical uint64', { ...wireEvent(ACKNOWLEDGED_EVENT), sequence: '01' }],
    ['noncanonical timestamp', { ...wireEvent(ACKNOWLEDGED_EVENT), occurred_at: '2026-08-15T00:00:00Z' }],
    ['tampered hash', { ...wireEvent(ACKNOWLEDGED_EVENT), event_id: 'f'.repeat(64) }],
    ['fill without fields', { ...wireEvent(ACKNOWLEDGED_EVENT), kind: 3 }],
    ['reason-required event without reason', { ...wireEvent(ACKNOWLEDGED_EVENT), kind: 6 }],
    ['V1 evidence smuggling', {
      ...wireEvent(ACKNOWLEDGED_EVENT),
      evidence_schema_version: 'openalice_offline_execution_receipt.v1',
      evidence_receipt_id: 'b'.repeat(64),
    }],
    ['V2 missing receipt identity', {
      ...wireEvent(OFFLINE_V2_EVENT),
      evidence_receipt_id: undefined,
    }],
  ])('rejects malformed lifecycle event %s', async (_label, event) => {
    const transport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      replayResponse: { events: [event] },
    }).client)
    await expect(transport.replayEvents({ afterSequence: '0', limit: 1 }))
      .rejects.toThrow('execution_grpc_lifecycle_event_invalid')
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it.each([
    [{ afterSequence: '01', limit: 1 }, 'cursor'],
    [{ afterSequence: '0', limit: 0 }, 'zero limit'],
    [{ afterSequence: '0', limit: 1_001 }, 'oversized limit'],
    [{ afterSequence: '0', limit: 1.5 }, 'fractional limit'],
  ])('rejects replay request outside the canonical bounded contract: %s', async (request) => {
    const transport = await makeReadyTransport(makeRawClient().client)
    await expect(transport.replayEvents(request)).rejects.toThrow('execution_grpc_replay_request_invalid')
  })

  it('streams a contiguous lifecycle cursor and cleans up on server end', async () => {
    const serverStream = makeRawServerStream()
    const raw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      serverStream,
    })
    const transport = await makeReadyTransport(raw.client)
    const controller = new AbortController()
    const iterator = transport.streamEvents({ afterSequence: '0' }, { signal: controller.signal })[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => expect(raw.streamRequest).toEqual({ after_sequence: '0' }))
    serverStream.emitData(wireEvent(ACKNOWLEDGED_EVENT))
    await expect(first).resolves.toEqual({ done: false, value: ACKNOWLEDGED_EVENT })
    const second = iterator.next()
    serverStream.emitData(wireEvent(SUBMITTED_EVENT))
    await expect(second).resolves.toEqual({ done: false, value: SUBMITTED_EVENT })
    const ended = iterator.next()
    serverStream.emitEnd()
    await expect(ended).resolves.toEqual({ done: true, value: undefined })
    expect(raw.streamRequest).toEqual({ after_sequence: '0' })
    expect(raw.streamDeadline).toBeUndefined()
    expect(serverStream.listenerCount()).toBe(0)
    expect(serverStream.cancel).not.toHaveBeenCalled()
  })

  it('fails and cancels a stream on a sequence gap', async () => {
    const serverStream = makeRawServerStream()
    const transport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      serverStream,
    }).client)
    const iterator = transport.streamEvents(
      { afterSequence: '0' },
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]()
    const next = iterator.next()
    await vi.waitFor(() => expect(serverStream.listenerCount()).toBeGreaterThan(0))
    serverStream.emitData(wireEvent(SUBMITTED_EVENT))
    await expect(next).rejects.toThrow('execution_grpc_lifecycle_sequence_gap')
    expect(serverStream.cancel).toHaveBeenCalledOnce()
    expect(serverStream.listenerCount()).toBe(0)
    await expect(transport.verifyReady(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('cancels an already verified READ_ONLY stream when a concurrent read detects peer drift', async () => {
    const serverStream = makeRawServerStream()
    const health = readOnlyHealthResponse({ latest_sequence: '1' })
    const raw = makeRawClient(
      undefined,
      { found: false },
      handshakeResponse(),
      health,
      { serverStream },
    )
    const transport = makeTransport(raw.client)
    await transport.verifyReadable(EXPECTED_IDENTITY)
    const iterator = transport.streamEvents(
      { afterSequence: '0' },
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => expect(serverStream.listenerCount()).toBeGreaterThan(0))
    serverStream.emitData(wireEvent(ACKNOWLEDGED_EVENT))
    await expect(first).resolves.toEqual({ done: false, value: ACKNOWLEDGED_EVENT })

    const pending = iterator.next()
    health.run_id = 'other-run'
    await expect(transport.getCommand(COMMAND.commandId))
      .rejects.toThrow('execution_grpc_health_identity_mismatch')
    await expect(pending).rejects.toThrow('execution_grpc_integrity_poisoned')
    expect(serverStream.cancel).toHaveBeenCalledOnce()
    expect(serverStream.listenerCount()).toBe(0)
    await expect(transport.verifyReadable(EXPECTED_IDENTITY))
      .rejects.toThrow('execution_grpc_integrity_poisoned')
  })

  it('cancels active streams and removes listeners on AbortSignal, consumer return, and close', async () => {
    const abortedStream = makeRawServerStream()
    const abortTransport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      serverStream: abortedStream,
    }).client)
    const controller = new AbortController()
    const abortedIterator = abortTransport.streamEvents({ afterSequence: '0' }, { signal: controller.signal })[Symbol.asyncIterator]()
    const abortedNext = abortedIterator.next()
    await vi.waitFor(() => expect(abortedStream.listenerCount()).toBeGreaterThan(0))
    controller.abort()
    await expect(abortedNext).rejects.toMatchObject({ name: 'AbortError' })
    expect(abortedStream.cancel).toHaveBeenCalledOnce()
    expect(abortedStream.listenerCount()).toBe(0)

    const returnedStream = makeRawServerStream()
    const returnedTransport = await makeReadyTransport(makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      serverStream: returnedStream,
    }).client)
    const returnedIterator = returnedTransport.streamEvents(
      { afterSequence: '0' },
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]()
    const returnedNext = returnedIterator.next()
    await vi.waitFor(() => expect(returnedStream.listenerCount()).toBeGreaterThan(0))
    await returnedIterator.return?.()
    await expect(returnedNext).resolves.toEqual({ done: true, value: undefined })
    expect(returnedStream.cancel).toHaveBeenCalledOnce()
    expect(returnedStream.listenerCount()).toBe(0)

    const closedStream = makeRawServerStream()
    const closedRaw = makeRawClient(undefined, undefined, handshakeResponse(), healthResponse(), {
      serverStream: closedStream,
    })
    const closedTransport = await makeReadyTransport(closedRaw.client)
    const closedIterator = closedTransport.streamEvents(
      { afterSequence: '0' },
      { signal: new AbortController().signal },
    )[Symbol.asyncIterator]()
    const closedNext = closedIterator.next()
    await vi.waitFor(() => expect(closedStream.listenerCount()).toBeGreaterThan(0))
    closedTransport.close()
    await expect(closedNext).rejects.toThrow('execution_grpc_client_closed')
    expect(closedStream.cancel).toHaveBeenCalledOnce()
    expect(closedStream.listenerCount()).toBe(0)
    expect(closedRaw.close).toHaveBeenCalledOnce()
  })

  it.each([
    '127.0.0.1:50051',
    'dns:///127.0.0.1:50051',
    'unix:/private/tmp/openalice.sock',
    'relative.sock',
    '/private/tmp/openalice\0.sock',
    '',
  ])('rejects non-UDS socket target %s before constructing a client', target => {
    const createClient = vi.fn<() => ExecutionGrpcRawClient>()
    expect(() => new ExecutionGrpcTransport({
      socketPath: target,
      rpcDeadlineMs: 100,
      createClient,
    })).toThrow('execution_grpc_uds_socket_path_invalid')
    expect(createClient).not.toHaveBeenCalled()
  })

  it('refuses post-close calls and malformed deadlines', async () => {
    const raw = makeRawClient({ command_id: COMMAND.commandId, disposition: 1, accepted_sequence: '1' })
    const transport = makeTransport(raw.client)
    transport.close()
    await expect(transport.execute(makeRequest(), { signal: new AbortController().signal }))
      .rejects.toThrow('execution_grpc_client_closed')
    expect(() => makeTransport(raw.client, 0)).toThrow('execution_grpc_deadline_invalid')
  })
})

function makeTransport(client: ExecutionGrpcRawClient, rpcDeadlineMs = 500): ExecutionGrpcTransport {
  return new ExecutionGrpcTransport({ socketPath: '/private/tmp/openalice.sock', rpcDeadlineMs, client })
}

async function makeReadyTransport(
  client: ExecutionGrpcRawClient,
  rpcDeadlineMs = 500,
): Promise<ExecutionGrpcTransport> {
  const transport = makeTransport(client, rpcDeadlineMs)
  await transport.verifyReady(EXPECTED_IDENTITY)
  return transport
}

async function makeReadyOfflineTransport(
  offlineReceiptResponse: unknown,
): Promise<{
  transport: ExecutionGrpcTransport
  raw: ReturnType<typeof makeRawClient>
}> {
  const raw = makeRawClient(
    undefined,
    undefined,
    handshakeResponse({ mode: 1, run_id: LOCAL_EXPECTED_IDENTITY.runId }),
    healthResponse({ mode: 1, run_id: LOCAL_EXPECTED_IDENTITY.runId }),
    { offlineReceiptResponse },
  )
  const transport = makeTransport(raw.client)
  await transport.verifyReady(LOCAL_EXPECTED_IDENTITY)
  return { transport, raw }
}

function makeRawClient(
  executeResponse?: unknown,
  getCommandResponse?: unknown,
  handshake = handshakeResponse(),
  health = healthResponse(),
  lifecycle: {
    offlineReceiptResponse?: unknown
    snapshotResponse?: unknown
    replayResponse?: unknown
    serverStream?: TestRawServerStream
  } = {},
): {
  client: ExecutionGrpcRawClient
  handshakeRequest?: Record<string, unknown>
  executeRequest?: Record<string, unknown>
  getCommandRequest?: Record<string, unknown>
  offlineReceiptRequest?: Record<string, unknown>
  snapshotRequest?: Record<string, unknown>
  replayRequest?: Record<string, unknown>
  streamRequest?: Record<string, unknown>
  healthRequest?: Record<string, unknown>
  executeDeadline?: Date
  offlineReceiptDeadline?: Date
  snapshotDeadline?: Date
  replayDeadline?: Date
  streamDeadline?: Date
  close: ReturnType<typeof vi.fn<() => void>>
} {
  const captured: {
    handshakeRequest?: Record<string, unknown>
    executeRequest?: Record<string, unknown>
    getCommandRequest?: Record<string, unknown>
    offlineReceiptRequest?: Record<string, unknown>
    snapshotRequest?: Record<string, unknown>
    replayRequest?: Record<string, unknown>
    streamRequest?: Record<string, unknown>
    healthRequest?: Record<string, unknown>
    executeDeadline?: Date
    offlineReceiptDeadline?: Date
    snapshotDeadline?: Date
    replayDeadline?: Date
    streamDeadline?: Date
    close: ReturnType<typeof vi.fn<() => void>>
  } = { close: vi.fn<() => void>() }
  return {
    get client() {
      return {
        Handshake(
          request: Record<string, unknown>,
          _options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.handshakeRequest = request
          callback(null, handshake)
          return { cancel: vi.fn() }
        },
        Execute(
          request: Record<string, unknown>,
          options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.executeRequest = request
          captured.executeDeadline = options.deadline
          callback(null, executeResponse)
          return { cancel: vi.fn() }
        },
        GetCommand(
          request: Record<string, unknown>,
          _options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.getCommandRequest = request
          callback(null, getCommandResponse)
          return { cancel: vi.fn() }
        },
        GetOfflineExecutionReceipt(
          request: Record<string, unknown>,
          options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.offlineReceiptRequest = request
          captured.offlineReceiptDeadline = options.deadline
          callback(null, lifecycle.offlineReceiptResponse ?? { found: false })
          return { cancel: vi.fn() }
        },
        GetSnapshot(
          request: Record<string, unknown>,
          options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.snapshotRequest = request
          captured.snapshotDeadline = options.deadline
          callback(null, lifecycle.snapshotResponse ?? { found: false })
          return { cancel: vi.fn() }
        },
        ReplayEvents(
          request: Record<string, unknown>,
          options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.replayRequest = request
          captured.replayDeadline = options.deadline
          callback(null, lifecycle.replayResponse ?? {})
          return { cancel: vi.fn() }
        },
        StreamEvents(
          request: Record<string, unknown>,
          options: { deadline?: Date },
        ) {
          captured.streamRequest = request
          captured.streamDeadline = options.deadline
          return (lifecycle.serverStream ?? makeRawServerStream()).stream
        },
        Health(
          request: Record<string, unknown>,
          _options: { deadline: Date },
          callback: (error: Error | null, response?: unknown) => void,
        ) {
          captured.healthRequest = request
          callback(null, health)
          return { cancel: vi.fn() }
        },
        close: () => { captured.close() },
      }
    },
    get handshakeRequest() { return captured.handshakeRequest },
    get executeRequest() { return captured.executeRequest },
    get getCommandRequest() { return captured.getCommandRequest },
    get offlineReceiptRequest() { return captured.offlineReceiptRequest },
    get snapshotRequest() { return captured.snapshotRequest },
    get replayRequest() { return captured.replayRequest },
    get streamRequest() { return captured.streamRequest },
    get healthRequest() { return captured.healthRequest },
    get executeDeadline() { return captured.executeDeadline },
    get offlineReceiptDeadline() { return captured.offlineReceiptDeadline },
    get snapshotDeadline() { return captured.snapshotDeadline },
    get replayDeadline() { return captured.replayDeadline },
    get streamDeadline() { return captured.streamDeadline },
    get close() { return captured.close },
  }
}

class TestRawServerStream {
  private readonly emitter = new EventEmitter()
  readonly cancel = vi.fn(() => {
    if (this.emitter.listenerCount('error') > 0) {
      this.emitter.emit('error', new Error('test_stream_cancelled'))
    }
  })

  readonly stream: ExecutionGrpcRawServerStream = {
    cancel: this.cancel,
    on: ((event: string, listener: (...args: unknown[]) => void) => {
      this.emitter.on(event, listener)
      return this.stream
    }) as ExecutionGrpcRawServerStream['on'],
    removeListener: ((event: string, listener: (...args: unknown[]) => void) => {
      this.emitter.removeListener(event, listener)
      return this.stream
    }) as ExecutionGrpcRawServerStream['removeListener'],
  }

  emitData(value: unknown): void {
    this.emitter.emit('data', value)
  }

  emitEnd(): void {
    this.emitter.emit('end')
  }

  listenerCount(): number {
    return ['data', 'error', 'end'].reduce((count, event) => count + this.emitter.listenerCount(event), 0)
  }
}

function makeRawServerStream(): TestRawServerStream {
  return new TestRawServerStream()
}

function wireCommand(
  command: ExecutionCommandV1,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema_version: command.schemaVersion,
    command_id: command.commandId,
    payload_hash: command.payloadHash,
    payload: wirePayload(command.payload),
    canonical_payload_json_utf8: Buffer.from(stableStringify(command.payload), 'utf8'),
    ...patch,
  }
}

function wirePayload(payload: ExecutionCommandPayloadV1): Record<string, unknown> {
  const result: Record<string, unknown> = {
    schema_version: payload.schemaVersion,
    kind: { submit: 1, cancel: 2, replace: 3, reconcile: 4, suspend: 5 }[payload.kind],
    account_id: payload.accountId,
    canonical_symbol: payload.canonicalSymbol,
    venue: 1,
    venue_instrument_id: payload.venueInstrumentId,
    idempotency_key: payload.idempotencyKey,
    mode: payload.mode === 'PAPER_LOCAL' ? 1 : 2,
  }
  if (payload.kind === 'submit') {
    Object.assign(result, {
      client_order_id: payload.clientOrderId,
      side: payload.side === 'buy' ? 1 : 2,
      order_type: 2,
      quantity: payload.quantity,
      price: payload.price,
      time_in_force: { GTC: 1, IOC: 2, FOK: 3 }[payload.timeInForce],
      // proto-loader with defaults:false omits this encoded false.
      max_notional_usd: payload.maxNotionalUsd,
    })
  } else if (payload.kind === 'cancel') {
    result.target_client_order_id = payload.targetClientOrderId
  } else if (payload.kind === 'replace') {
    Object.assign(result, {
      target_client_order_id: payload.targetClientOrderId,
      replacement_client_order_id: payload.replacementClientOrderId,
      quantity: payload.quantity,
      price: payload.price,
      time_in_force: { GTC: 1, IOC: 2, FOK: 3 }[payload.timeInForce],
      max_notional_usd: payload.maxNotionalUsd,
    })
  } else if (payload.kind === 'reconcile') {
    if (payload.afterSequence !== undefined && payload.afterSequence !== '0') {
      result.after_sequence = payload.afterSequence
    }
  } else {
    result.reason = payload.reason
  }
  return result
}

function wireEvent(event: ExecutionEvent): Record<string, unknown> {
  const kind = {
    acknowledged: 1,
    submitted: 2,
    partially_filled: 3,
    filled: 4,
    canceled: 5,
    rejected: 6,
    expired: 7,
    submission_unknown: 8,
    reconciled: 9,
    drift: 10,
    suspended: 11,
  }[event.kind]
  return {
    schema_version: event.schemaVersion,
    event_id: event.eventId,
    command_id: event.commandId,
    sequence: event.sequence,
    occurred_at: event.occurredAt,
    kind,
    ...(event.clientOrderId ? { client_order_id: event.clientOrderId } : {}),
    ...(event.venueOrderId ? { venue_order_id: event.venueOrderId } : {}),
    ...(event.filledQuantity ? { filled_quantity: event.filledQuantity } : {}),
    ...(event.averagePrice ? { average_price: event.averagePrice } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.schemaVersion === 'openalice_execution_event.v2'
      ? {
          evidence_schema_version: event.evidenceSchemaVersion,
          evidence_receipt_id: event.evidenceReceiptId,
        }
      : {}),
  }
}

function makeOfflineReceiptFixture(): {
  receipt: OfflineExecutionReceiptV1
  expected: OfflineExecutionReceiptExpectedBinding
  trustPolicy: OfflineExecutionReceiptTrustPolicy
  event: ReturnType<typeof buildExecutionEventV2FromOfflineReceipt>
  canonicalReceiptJsonUtf8: Buffer
  canonicalRequestJsonUtf8: Buffer
  canonicalResponseJsonUtf8: Buffer
  wireResponse: Record<string, unknown>
} {
  const commandId = '6'.repeat(64)
  const adapterId = 'openalice.offline-simulator'
  const adapterRunId = LOCAL_EXPECTED_IDENTITY.runId
  const adapterEpoch = '1'
  const attemptNumber = '1'
  const sourceNamespaceId = 'e'.repeat(64)
  const attemptId = deriveOfflineExecutionAttemptId({
    commandId,
    adapterId,
    adapterRunId,
    adapterEpoch,
    attemptNumber,
  })
  const simulatorRequest = {
    schemaVersion: OFFLINE_SIMULATOR_REQUEST_V1,
    sourceNamespaceId,
    commandId,
    payloadHash: commandId,
    permitV2Id: '7'.repeat(64),
    permitKeyId: 'permit-test-key',
    acceptedSequence: '1',
    idempotencyKey: 'offline-receipt-transport-1',
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT' as const,
    venue: 'OKX' as const,
    venueInstrumentId: 'BTC-USDT' as const,
    mode: 'PAPER_LOCAL' as const,
    clientOrderId: 'OA1234567890ABCDEF',
    side: 'buy' as const,
    orderType: 'limit' as const,
    timeInForce: 'GTC' as const,
    reduceOnly: false as const,
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
  const canonicalRequestJsonUtf8 = Buffer.from(stableStringify(simulatorRequest), 'utf8')
  const requestHash = sha256Canonical(simulatorRequest)
  const simulatorResponse = {
    schemaVersion: OFFLINE_SIMULATOR_RESPONSE_V1,
    sourceNamespaceId,
    sourceSequence: '1',
    commandId,
    attemptId,
    requestHash,
    clientOrderId: simulatorRequest.clientOrderId,
    state: 'submitted' as const,
    simulatorOccurredAt: '2026-08-15T01:00:00.000Z',
    simulatedOrderId: 'SIM0123456789ABCDEF',
  }
  const canonicalResponseJsonUtf8 = Buffer.from(stableStringify(simulatorResponse), 'utf8')
  const core: OfflineExecutionReceiptCoreV1 = {
    schemaVersion: OFFLINE_EXECUTION_RECEIPT_V1,
    scope: OFFLINE_EXECUTION_RECEIPT_SCOPE,
    commandId,
    payloadHash: commandId,
    permitV2Id: simulatorRequest.permitV2Id,
    permitKeyId: simulatorRequest.permitKeyId,
    acceptedSequence: simulatorRequest.acceptedSequence,
    lifecycleSequence: '2',
    lifecycleKind: 'submitted',
    idempotencyKey: simulatorRequest.idempotencyKey,
    accountId: simulatorRequest.accountId,
    canonicalSymbol: simulatorRequest.canonicalSymbol,
    venue: simulatorRequest.venue,
    venueInstrumentId: simulatorRequest.venueInstrumentId,
    mode: simulatorRequest.mode,
    clientOrderId: simulatorRequest.clientOrderId,
    side: simulatorRequest.side,
    orderType: simulatorRequest.orderType,
    timeInForce: simulatorRequest.timeInForce,
    reduceOnly: simulatorRequest.reduceOnly,
    quantity: simulatorRequest.quantity,
    price: simulatorRequest.price,
    maxNotionalUsd: simulatorRequest.maxNotionalUsd,
    adapterId,
    adapterBuildHash: '8'.repeat(64),
    adapterConfigHash: '9'.repeat(64),
    adapterRunId,
    adapterEpoch,
    adapterKeyId: 'offline-simulator-test-key',
    attemptId,
    attemptNumber,
    sourceNamespaceId,
    sourceSequence: simulatorResponse.sourceSequence,
    transitionNumber: '1',
    simulatedOrderId: simulatorResponse.simulatedOrderId,
    requestHash,
    responseHash: sha256Canonical(simulatorResponse),
    permitIssuedAt: simulatorRequest.permitIssuedAt,
    permitExpiresAt: simulatorRequest.permitExpiresAt,
    dispatchArmedAt: simulatorRequest.dispatchArmedAt,
    adapterObservedAt: '2026-08-15T01:00:01.000Z',
    simulatorOccurredAt: simulatorResponse.simulatorOccurredAt,
  }
  const receipt = createOfflineExecutionReceiptV1({ core, privateKey: OFFLINE_RECEIPT_PRIVATE_KEY })
  const expected: OfflineExecutionReceiptExpectedBinding = {
    commandId: receipt.commandId,
    payloadHash: receipt.payloadHash,
    permitV2Id: receipt.permitV2Id,
    permitKeyId: receipt.permitKeyId,
    acceptedSequence: receipt.acceptedSequence,
    lifecycleSequence: receipt.lifecycleSequence,
    lifecycleKind: receipt.lifecycleKind,
    adapterEpoch: receipt.adapterEpoch,
    attemptId: receipt.attemptId,
    attemptNumber: receipt.attemptNumber,
    sourceNamespaceId: receipt.sourceNamespaceId,
    sourceSequence: receipt.sourceSequence,
    transitionNumber: receipt.transitionNumber,
    previousReceiptId: receipt.previousReceiptId,
    idempotencyKey: receipt.idempotencyKey,
    accountId: receipt.accountId,
    canonicalSymbol: receipt.canonicalSymbol,
    venue: receipt.venue,
    venueInstrumentId: receipt.venueInstrumentId,
    mode: receipt.mode,
    clientOrderId: receipt.clientOrderId,
    side: receipt.side,
    orderType: receipt.orderType,
    timeInForce: receipt.timeInForce,
    reduceOnly: receipt.reduceOnly,
    quantity: receipt.quantity,
    price: receipt.price,
    maxNotionalUsd: receipt.maxNotionalUsd,
  }
  const trustPolicy: OfflineExecutionReceiptTrustPolicy = {
    keyId: receipt.adapterKeyId,
    adapterId: receipt.adapterId,
    adapterBuildHash: receipt.adapterBuildHash,
    adapterConfigHash: receipt.adapterConfigHash,
    adapterRunId: receipt.adapterRunId,
    permitAuthorityKeyIds: [receipt.permitKeyId],
    permitAuthorityPublicKeyFingerprints: [
      ed25519PublicKeyFingerprintSha256(OFFLINE_PERMIT_PUBLIC_KEY),
    ],
    publicKey: OFFLINE_RECEIPT_PUBLIC_KEY,
  }
  const event = buildExecutionEventV2FromOfflineReceipt(receipt)
  const canonicalReceiptJsonUtf8 = Buffer.from(stableStringify(receipt), 'utf8')
  return {
    receipt,
    expected,
    trustPolicy,
    event,
    canonicalReceiptJsonUtf8,
    canonicalRequestJsonUtf8,
    canonicalResponseJsonUtf8,
    wireResponse: {
      found: true,
      receipt: wireOfflineReceipt(receipt),
      canonical_receipt_json_utf8: canonicalReceiptJsonUtf8,
      canonical_request_json_utf8: canonicalRequestJsonUtf8,
      canonical_response_json_utf8: canonicalResponseJsonUtf8,
      lifecycle_event: wireEvent(event),
    },
  }
}

function wireOfflineReceipt(receipt: OfflineExecutionReceiptV1): Record<string, unknown> {
  return {
    schema_version: receipt.schemaVersion,
    scope: receipt.scope,
    command_id: receipt.commandId,
    payload_hash: receipt.payloadHash,
    permit_v2_id: receipt.permitV2Id,
    permit_key_id: receipt.permitKeyId,
    accepted_sequence: receipt.acceptedSequence,
    lifecycle_sequence: receipt.lifecycleSequence,
    lifecycle_kind: { submitted: 2, partially_filled: 3, filled: 4, canceled: 5, rejected: 6, expired: 7, submission_unknown: 8 }[receipt.lifecycleKind],
    idempotency_key: receipt.idempotencyKey,
    account_id: receipt.accountId,
    canonical_symbol: receipt.canonicalSymbol,
    venue: 1,
    venue_instrument_id: receipt.venueInstrumentId,
    mode: 1,
    client_order_id: receipt.clientOrderId,
    side: 1,
    order_type: 2,
    time_in_force: { GTC: 1, IOC: 2, FOK: 3 }[receipt.timeInForce],
    quantity: receipt.quantity,
    price: receipt.price,
    max_notional_usd: receipt.maxNotionalUsd,
    adapter_id: receipt.adapterId,
    adapter_build_hash: receipt.adapterBuildHash,
    adapter_config_hash: receipt.adapterConfigHash,
    adapter_run_id: receipt.adapterRunId,
    adapter_epoch: receipt.adapterEpoch,
    adapter_key_id: receipt.adapterKeyId,
    attempt_id: receipt.attemptId,
    attempt_number: receipt.attemptNumber,
    source_namespace_id: receipt.sourceNamespaceId,
    source_sequence: receipt.sourceSequence,
    transition_number: receipt.transitionNumber,
    ...(receipt.simulatedOrderId ? { simulated_order_id: receipt.simulatedOrderId } : {}),
    request_hash: receipt.requestHash,
    response_hash: receipt.responseHash,
    permit_issued_at: receipt.permitIssuedAt,
    permit_expires_at: receipt.permitExpiresAt,
    dispatch_armed_at: receipt.dispatchArmedAt,
    adapter_observed_at: receipt.adapterObservedAt,
    simulator_occurred_at: receipt.simulatorOccurredAt,
    ...(receipt.previousReceiptId ? { previous_receipt_id: receipt.previousReceiptId } : {}),
    ...(receipt.filledQuantity ? { filled_quantity: receipt.filledQuantity } : {}),
    ...(receipt.averagePrice ? { average_price: receipt.averagePrice } : {}),
    ...(receipt.reason ? { reason: receipt.reason } : {}),
    receipt_id: receipt.receiptId,
    signature: receipt.signature,
  }
}

function offlineReceiptReadRequest(fixture: ReturnType<typeof makeOfflineReceiptFixture>) {
  return {
    receiptId: fixture.receipt.receiptId,
    trustPolicy: fixture.trustPolicy,
    expected: fixture.expected,
    now: new Date('2026-08-15T01:00:02.000Z'),
  }
}

function handshakeResponse(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocol_version: EXECUTION_GRPC_PROTOCOL_VERSION,
    service_id: EXECUTION_GRPC_SERVICE_ID,
    mode: 2,
    run_id: EXPECTED_IDENTITY.runId,
    environment_proof_hash: EXPECTED_IDENTITY.environmentProofHash,
    schema_hash: EXPECTED_IDENTITY.schemaHash,
    writer_epoch: '1',
    ...patch,
  }
}

function healthResponse(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 2,
    mode: 2,
    run_id: EXPECTED_IDENTITY.runId,
    writer_epoch: '1',
    latest_sequence: '0',
    circuit_reason: '',
    environment_proof_hash: EXPECTED_IDENTITY.environmentProofHash,
    schema_hash: EXPECTED_IDENTITY.schemaHash,
    detail: 'durable_admission_ready_not_broker_ready',
    ...patch,
  }
}

function readOnlyHealthResponse(
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return healthResponse({
    status: 4,
    circuit_reason: 'runtime_write_disarmed',
    detail: 'durable_admission_read_only',
    ...patch,
  })
}

function makeCommand() {
  return buildExecutionCommandV1({
    schemaVersion: EXECUTION_COMMAND_PAYLOAD_V1,
    kind: 'submit',
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT',
    venue: 'OKX',
    venueInstrumentId: 'BTC-USDT',
    idempotencyKey: 'intent-1',
    mode: 'PAPER_EXCHANGE',
    clientOrderId: deriveOkxClientOrderId('intent-1'),
    side: 'buy',
    orderType: 'limit',
    quantity: '0.0005',
    price: '100000.5',
    timeInForce: 'GTC',
    reduceOnly: false,
    maxNotionalUsd: '50.00025',
  })
}

function makeSubmitCommand(idempotencyKey: string): ExecutionCommandV1 {
  return buildExecutionCommandV1({
    ...COMMAND.payload,
    idempotencyKey,
    clientOrderId: deriveOkxClientOrderId(idempotencyKey),
  })
}

function makePermit(command: ExecutionCommandV1): ExecutionPermitV2 {
  if (command.payload.kind !== 'submit') throw new Error('test_submit_command_required')
  const core: Omit<ExecutionPermitV2, 'permitId' | 'signature'> = {
    schemaVersion: 'openalice_execution_permit.v2',
    decisionId: 'd'.repeat(64),
    candidateId: 'candidate-test',
    intentId: command.payload.idempotencyKey,
    ticketId: 'ticket-test',
    commandHash: command.commandId,
    action: 'submit',
    authorityAction: 'open',
    riskReducing: false,
    scope: 'paper_only',
    accountId: command.payload.accountId,
    canonicalSymbol: command.payload.canonicalSymbol,
    venueInstrumentId: command.payload.venueInstrumentId,
    idempotencyKey: command.payload.idempotencyKey,
    side: 'buy',
    authorizedNotionalUsd: command.payload.maxNotionalUsd,
    mode: command.payload.mode,
    sourceCommit: '1'.repeat(40),
    releaseManifestHash: '2'.repeat(64),
    authoritySnapshotHash: '3'.repeat(64),
    requiredChecks: ['test_check'],
    approvalRefs: [],
    issuedAt: '2026-08-15T00:00:00.000Z',
    expiresAt: '2026-08-15T00:00:30.000Z',
    keyId: 'test-key',
  }
  return {
    permitId: executionPermitV2Id(core),
    ...core,
    signature: Buffer.alloc(64, 7).toString('base64'),
  }
}

function wireAdmission(
  command: ExecutionCommandV1,
  patch: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    found: true,
    command: wireCommand(command),
    permit_json_utf8: Buffer.from(stableStringify(makePermit(command)), 'utf8'),
    disposition: 1,
    accepted_sequence: '1',
    ...patch,
  }
}

function makeVariantCommand(patch: Record<string, unknown>) {
  return buildExecutionCommandV1({
    schemaVersion: EXECUTION_COMMAND_PAYLOAD_V1,
    accountId: 'paper-main',
    canonicalSymbol: 'BTC/USDT',
    venue: 'OKX',
    venueInstrumentId: 'BTC-USDT',
    idempotencyKey: 'intent-1',
    mode: 'PAPER_EXCHANGE',
    ...patch,
  })
}

function makeRequest(command = COMMAND): ExecutionSidecarTransportRequest {
  return {
    command,
    permit: {} as ExecutionSidecarTransportRequest['permit'],
    canonicalPayloadJsonUtf8: Buffer.from('{"canonical":"payload"}', 'utf8'),
    permitJsonUtf8: Buffer.from('{"canonical":"permit"}', 'utf8'),
  }
}
