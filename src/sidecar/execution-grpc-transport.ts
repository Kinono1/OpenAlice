import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import type {
  ExecutionLifecycleReadModel,
  ExecutionLifecycleReadOptions,
  ExecutionLifecycleReplayRequest,
  ExecutionLifecycleSnapshot,
  ExecutionLifecycleSnapshotRequest,
  ExecutionLifecycleStreamOptions,
  ExecutionLifecycleStreamRequest,
} from '../domain/trading/execution-lifecycle-read-model.js'
import type {
  ExecutionSidecarTransport,
  ExecutionSidecarTransportRequest,
} from '../domain/trading/execution-sidecar-writer.js'
import type {
  ExecutionSidecarCommandAdmission,
  ExecutionSidecarReadModel,
} from '../domain/trading/execution-sidecar-read-model.js'
import type {
  ExecutionOfflineReceiptReadModel,
  ExecutionOfflineReceiptReadOptions,
  ExecutionOfflineReceiptReadResult,
  ExecutionOfflineReceiptRequest,
} from '../domain/trading/execution-offline-receipt-read-model.js'
import {
  ed25519PublicKeyFingerprintSha256,
  executionEventV2MatchesOfflineReceipt,
  offlineExecutionReceiptV1Schema,
  parseOfflineExecutionReceiptJsonUtf8,
  verifyOfflineExecutionReceiptV1,
  type OfflineExecutionReceiptV1,
} from '../domain/trading/offline-execution-receipt.js'
import {
  executionCommandV1Schema,
  executionEventSchema,
  validateExecutionPermitV2,
  type ExecutionCommandPayloadV1,
  type ExecutionEvent,
  type ExecutionPermitV2,
} from '../domain/trading/execution-protocol.js'
import { stableStringify } from './contracts.js'

const HASH_RE = /^[a-f0-9]{64}$/
const POSITIVE_UINT64_RE = /^(?:[1-9][0-9]*)$/
const UINT64_RE = /^(?:0|[1-9][0-9]*)$/
const MAX_UINT64 = 18_446_744_073_709_551_615n
const REASON_RE = /^[A-Za-z0-9._:-]{1,200}$/
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,300}$/

export const EXECUTION_GRPC_PROTOCOL_VERSION = 'openalice.execution.v1'
export const EXECUTION_GRPC_SERVICE_ID = 'openalice.nautilus_paper.durable_admission'

const EXECUTE_DISPOSITION = {
  ACCEPTED: 1,
  DUPLICATE: 2,
  REJECTED: 3,
  SUSPENDED: 4,
  UNAVAILABLE: 5,
} as const

const SERVICE_STATUS = { READY: 2, READ_ONLY: 4 } as const

const COMMAND_KIND = {
  submit: 1,
  cancel: 2,
  replace: 3,
  reconcile: 4,
  suspend: 5,
} as const

const PAPER_MODE = { PAPER_LOCAL: 1, PAPER_EXCHANGE: 2 } as const
const VENUE = { OKX: 1 } as const
const ORDER_SIDE = { buy: 1, sell: 2 } as const
const ORDER_TYPE = { limit: 2 } as const
const TIME_IN_FORCE = { GTC: 1, IOC: 2, FOK: 3 } as const
const EXECUTION_EVENT_KIND = {
  1: 'acknowledged',
  2: 'submitted',
  3: 'partially_filled',
  4: 'filled',
  5: 'canceled',
  6: 'rejected',
  7: 'expired',
  8: 'submission_unknown',
  9: 'reconciled',
  10: 'drift',
  11: 'suspended',
} as const
const MAX_REPLAY_LIMIT = 1_000
const MAX_LIFECYCLE_ANCHORS = 100_000
const MAX_OFFLINE_RECEIPT_FUTURE_MS = 30_000
const OFFLINE_RECEIPT_EXPECTED_FIELDS = [
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
] as const
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true })

export interface ExecutionGrpcRawUnaryCall {
  cancel(): void
}

export interface ExecutionGrpcRawServerStream {
  cancel(): void
  on(event: 'data', listener: (response: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'end', listener: () => void): this
  removeListener(event: 'data', listener: (response: unknown) => void): this
  removeListener(event: 'error', listener: (error: Error) => void): this
  removeListener(event: 'end', listener: () => void): this
}

export interface ExecutionGrpcRawClient {
  Handshake(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  Execute(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  GetCommand(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  GetOfflineExecutionReceipt(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  GetSnapshot(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  ReplayEvents(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  StreamEvents(
    request: Record<string, unknown>,
    options: { deadline?: Date },
  ): ExecutionGrpcRawServerStream
  Health(
    request: Record<string, unknown>,
    options: { deadline: Date },
    callback: (error: Error | null, response?: unknown) => void,
  ): ExecutionGrpcRawUnaryCall
  close?(): void
}

export interface ExecutionGrpcExpectedIdentity {
  readonly clientId: string
  readonly mode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE'
  readonly runId: string
  readonly environmentProofHash: string
  readonly schemaHash: string
}

export interface ExecutionGrpcVerifiedIdentity {
  readonly protocolVersion: typeof EXECUTION_GRPC_PROTOCOL_VERSION
  readonly serviceId: typeof EXECUTION_GRPC_SERVICE_ID
  readonly mode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE'
  readonly runId: string
  readonly environmentProofHash: string
  readonly schemaHash: string
  readonly writerEpoch: string
  readonly latestSequence: string
}

export interface ExecutionGrpcReadyProbe {
  verifyReady(expected: ExecutionGrpcExpectedIdentity): Promise<ExecutionGrpcVerifiedIdentity>
}

export interface ExecutionGrpcReadableProbe {
  /** Pin an exact, irreversibly write-disarmed peer for diagnostic reads only. */
  verifyReadable(expected: ExecutionGrpcExpectedIdentity): Promise<ExecutionGrpcVerifiedIdentity>
}

export interface CreateExecutionGrpcTransportOptions {
  /** Absolute filesystem path only; TCP targets and relative paths are forbidden. */
  readonly socketPath: string
  /** Applied independently to each unary RPC. */
  readonly rpcDeadlineMs: number
  /** Test-only injection point.  Supplying this never starts a process or opens a broker. */
  readonly client?: ExecutionGrpcRawClient
  /** Test-only factory; receives a UDS target, never a TCP address. */
  readonly createClient?: (target: string) => ExecutionGrpcRawClient
}

/**
 * UDS-only client for the sidecar's durable admission API. It has no broker,
 * credential, TCP, fallback, or process-start capability.
 */
export class ExecutionGrpcTransport implements
  ExecutionSidecarTransport,
  ExecutionSidecarReadModel,
  ExecutionOfflineReceiptReadModel,
  ExecutionLifecycleReadModel {
  private readonly client: ExecutionGrpcRawClient
  private readonly rpcDeadlineMs: number
  private readonly activeLifecycleStreams = new Set<VerifiedLifecycleEventStream>()
  private readonly lifecycleAnchors = new Map<string, string>()
  private peerProbeTail: Promise<void> = Promise.resolve()
  private closed = false
  private readyVerified = false
  private readableVerified = false
  private integrityPoisoned = false
  private verifiedExpected: ExecutionGrpcExpectedIdentity | undefined
  private pinnedWriterEpoch: string | undefined
  private pinnedLatestSequence: string | undefined
  private verifiedAccess: 'ready' | 'read_only' | undefined

  constructor(options: CreateExecutionGrpcTransportOptions) {
    const socketPath = assertAbsoluteUnixSocketPath(options.socketPath)
    this.rpcDeadlineMs = assertRpcDeadlineMs(options.rpcDeadlineMs)
    if (options.client && options.createClient) {
      throw new Error('execution_grpc_client_source_ambiguous')
    }
    this.client = options.client ?? (options.createClient
      ? options.createClient(toUnixTarget(socketPath))
      : createNativeGrpcClient(toUnixTarget(socketPath)))
  }

  async execute(
    request: ExecutionSidecarTransportRequest,
    options: { signal: AbortSignal },
  ): Promise<unknown> {
    this.assertOpen()
    this.assertReadyVerified()
    await this.assertPinnedPeer(options.signal)
    const response = await this.unary('Execute', mapExecuteRequest(request), options.signal)
    return mapExecuteResponse(response)
  }

  async getCommand(commandId: string): Promise<ExecutionSidecarCommandAdmission> {
    this.assertOpen()
    this.assertReadableVerified()
    if (!HASH_RE.test(commandId)) throw new Error('execution_grpc_command_id_invalid')
    await this.assertPinnedPeer()
    const response = await this.unary('GetCommand', { command_id: commandId }, undefined)
    try {
      return mapGetCommandResponse(response, commandId)
    } catch (error) {
      const normalized = normalizeError(error)
      this.poisonIntegrity(normalized)
      throw normalized
    }
  }

  async getOfflineExecutionReceipt(
    request: ExecutionOfflineReceiptRequest,
    options: ExecutionOfflineReceiptReadOptions = {},
  ): Promise<ExecutionOfflineReceiptReadResult> {
    this.assertOpen()
    this.assertReadableVerified()
    const validatedRequest = validateOfflineReceiptReadRequest(
      request,
      options,
      this.verifiedExpected?.mode,
    )
    await this.assertPinnedPeer(options.signal)
    const response = await this.unary(
      'GetOfflineExecutionReceipt',
      { receipt_id: validatedRequest.receiptId },
      options.signal,
    )
    try {
      const result = mapGetOfflineExecutionReceiptResponse(response, validatedRequest)
      if (result.found) this.rememberLifecycleEvent(result.lifecycleEvent)
      return result
    } catch (error) {
      // A peer that returns a malformed, untrusted, or semantically unbound
      // receipt has violated the pinned read-model integrity contract.  Keep
      // this client permanently poisoned; a fresh process/transport is needed.
      const normalized = normalizeError(error)
      this.poisonIntegrity(normalized)
      throw normalized
    }
  }

  async getSnapshot(
    request: ExecutionLifecycleSnapshotRequest,
    options: ExecutionLifecycleReadOptions = {},
  ): Promise<ExecutionLifecycleSnapshot> {
    this.assertOpen()
    this.assertReadableVerified()
    const mappedRequest = mapGetSnapshotRequest(request)
    await this.assertPinnedPeer(options.signal)
    const response = await this.unary('GetSnapshot', mappedRequest, options.signal)
    try {
      return mapGetSnapshotResponse(response)
    } catch (error) {
      const normalized = normalizeError(error)
      this.poisonIntegrity(normalized)
      throw normalized
    }
  }

  async replayEvents(
    request: ExecutionLifecycleReplayRequest,
    options: ExecutionLifecycleReadOptions = {},
  ): Promise<readonly ExecutionEvent[]> {
    this.assertOpen()
    this.assertReadableVerified()
    const mappedRequest = mapReplayEventsRequest(request)
    await this.assertPinnedPeer(options.signal)
    const response = await this.unary('ReplayEvents', mappedRequest, options.signal)
    try {
      const events = mapReplayEventsResponse(response, request.afterSequence, request.limit)
      for (const event of events) this.rememberLifecycleEvent(event)
      return events
    } catch (error) {
      const normalized = normalizeError(error)
      this.poisonIntegrity(normalized)
      throw normalized
    }
  }

  streamEvents(
    request: ExecutionLifecycleStreamRequest,
    options: ExecutionLifecycleStreamOptions,
  ): AsyncIterable<ExecutionEvent> {
    this.assertOpen()
    this.assertReadableVerified()
    const afterSequence = requiredInputUint64(request?.afterSequence, 'execution_grpc_stream_request_invalid')
    const signal = options?.signal
    if (!(signal instanceof AbortSignal)) throw new Error('execution_grpc_stream_signal_required')
    if (signal.aborted) throw abortError()
    const call = this.client.StreamEvents(
      { after_sequence: afterSequence },
      {},
    )
    const verified = new VerifiedLifecycleEventStream(
      call,
      afterSequence,
      signal,
      event => this.rememberLifecycleEvent(event),
      verificationSignal => this.assertPinnedPeer(verificationSignal),
      error => this.poisonIntegrity(error),
      closed => this.activeLifecycleStreams.delete(closed),
    )
    this.activeLifecycleStreams.add(verified)
    if (verified.finished) this.activeLifecycleStreams.delete(verified)
    return verified
  }

  /**
   * Bind this client to one exact durable-admission sidecar identity before
   * any Execute/GetCommand call is allowed.  This is intentionally stricter
   * than transport connectivity: it does not treat broker readiness as proven.
   */
  async verifyReady(expectedInput: ExecutionGrpcExpectedIdentity): Promise<ExecutionGrpcVerifiedIdentity> {
    return this.serializePeerProbe(async () => {
      this.assertOpen()
      if (this.integrityPoisoned) throw new Error('execution_grpc_integrity_poisoned')
      if (this.verifiedAccess === 'read_only') {
        throw new Error('execution_grpc_read_only_rearm_forbidden')
      }
      this.readyVerified = false
      this.readableVerified = false
      const expected = validateExpectedIdentity(expectedInput)
      if (this.verifiedExpected && !sameExpectedIdentity(this.verifiedExpected, expected)) {
        throw new Error('execution_grpc_ready_identity_rebind_forbidden')
      }
      const verified = await this.probeReady(expected, undefined)
      if (this.pinnedWriterEpoch && verified.writerEpoch !== this.pinnedWriterEpoch) {
        throw new Error('execution_grpc_writer_epoch_changed')
      }
      this.pinProbeCursor(verified.latestSequence)
      this.verifiedExpected = { ...expected }
      this.pinnedWriterEpoch = verified.writerEpoch
      this.readyVerified = true
      this.readableVerified = true
      this.verifiedAccess = 'ready'
      return verified
    })
  }

  /**
   * Bind diagnostic reads to an exact identity which is already and
   * irreversibly WRITE_DISARMED. This never authorizes Execute.
   */
  async verifyReadable(
    expectedInput: ExecutionGrpcExpectedIdentity,
  ): Promise<ExecutionGrpcVerifiedIdentity> {
    return this.serializePeerProbe(async () => {
      this.assertOpen()
      if (this.integrityPoisoned) throw new Error('execution_grpc_integrity_poisoned')
      this.readyVerified = false
      this.readableVerified = false
      const expected = validateExpectedIdentity(expectedInput)
      if (this.verifiedExpected && !sameExpectedIdentity(this.verifiedExpected, expected)) {
        throw new Error('execution_grpc_readable_identity_rebind_forbidden')
      }
      const verified = await this.probeReadable(expected, undefined)
      if (this.pinnedWriterEpoch && verified.writerEpoch !== this.pinnedWriterEpoch) {
        throw new Error('execution_grpc_writer_epoch_changed')
      }
      this.pinProbeCursor(verified.latestSequence)
      this.verifiedExpected = { ...expected }
      this.pinnedWriterEpoch = verified.writerEpoch
      this.readableVerified = true
      this.verifiedAccess = 'read_only'
      return verified
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stream of [...this.activeLifecycleStreams]) {
      stream.cancel(new Error('execution_grpc_client_closed'))
    }
    this.activeLifecycleStreams.clear()
    this.client.close?.()
  }

  private unary(
    method:
      | 'Handshake'
      | 'Execute'
      | 'GetCommand'
      | 'GetOfflineExecutionReceipt'
      | 'GetSnapshot'
      | 'ReplayEvents'
      | 'Health',
    request: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted) return Promise.reject(abortError())
    return new Promise((resolve, reject) => {
      let settled = false
      let call: ExecutionGrpcRawUnaryCall | undefined
      const onAbort = () => {
        if (settled) return
        settled = true
        call?.cancel()
        reject(abortError())
      }
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        callback()
      }
      try {
        call = this.client[method](
          request,
          { deadline: this.deadline() },
          (error, response) => finish(() => error ? reject(error) : resolve(response)),
        )
        // A synchronous fake client can complete before listener registration;
        // do not retain a listener after the unary result is already final.
        if (!settled) {
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted) onAbort()
        }
      } catch (error) {
        finish(() => reject(error))
      }
    })
  }

  private deadline(): Date {
    return new Date(Date.now() + this.rpcDeadlineMs)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('execution_grpc_client_closed')
  }

  private assertReadyVerified(): void {
    if (!this.readyVerified) throw new Error('execution_grpc_ready_not_verified')
  }

  private assertReadableVerified(): void {
    if (!this.readableVerified) throw new Error('execution_grpc_ready_not_verified')
  }

  private async assertPinnedPeer(signal?: AbortSignal): Promise<void> {
    await this.serializePeerProbe(async () => {
      this.assertOpen()
      this.assertReadableVerified()
      const expected = this.verifiedExpected
      const writerEpoch = this.pinnedWriterEpoch
      const access = this.verifiedAccess
      if (!expected || !writerEpoch || !access) {
        throw new Error('execution_grpc_ready_not_verified')
      }
      try {
        const verified = access === 'ready'
          ? await this.probeReady(expected, signal)
          : await this.probeReadable(expected, signal)
        if (verified.writerEpoch !== writerEpoch) {
          throw new Error('execution_grpc_writer_epoch_changed')
        }
        this.pinProbeCursor(verified.latestSequence)
      } catch (error) {
        const normalized = normalizeError(error)
        this.readyVerified = false
        this.readableVerified = false
        if (access === 'read_only') this.poisonIntegrity(normalized)
        throw normalized
      }
    })
  }

  private serializePeerProbe<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.peerProbeTail.then(operation)
    this.peerProbeTail = result.then(() => undefined, () => undefined)
    return result
  }

  private async probeReady(
    expected: ExecutionGrpcExpectedIdentity,
    signal: AbortSignal | undefined,
  ): Promise<ExecutionGrpcVerifiedIdentity> {
    const handshake = mapHandshakeResponse(
      await this.unary('Handshake', {
        protocol_version: EXECUTION_GRPC_PROTOCOL_VERSION,
        client_id: expected.clientId,
      }, signal),
      expected,
    )
    const health = mapHealthResponse(
      await this.unary('Health', {}, signal),
      expected,
      handshake.writerEpoch,
    )
    return { ...handshake, latestSequence: health.latestSequence }
  }

  private async probeReadable(
    expected: ExecutionGrpcExpectedIdentity,
    signal: AbortSignal | undefined,
  ): Promise<ExecutionGrpcVerifiedIdentity> {
    const handshake = mapHandshakeResponse(
      await this.unary('Handshake', {
        protocol_version: EXECUTION_GRPC_PROTOCOL_VERSION,
        client_id: expected.clientId,
      }, signal),
      expected,
    )
    const health = mapReadOnlyHealthResponse(
      await this.unary('Health', {}, signal),
      expected,
      handshake.writerEpoch,
    )
    return { ...handshake, latestSequence: health.latestSequence }
  }

  private rememberLifecycleEvent(event: ExecutionEvent): void {
    const anchored = this.lifecycleAnchors.get(event.sequence)
    if (anchored !== undefined) {
      if (anchored !== event.eventId) {
        const error = new Error('execution_grpc_lifecycle_cross_rpc_equivocation')
        this.poisonIntegrity(error)
        throw error
      }
      return
    }
    if (this.lifecycleAnchors.size >= MAX_LIFECYCLE_ANCHORS) {
      const error = new Error('execution_grpc_lifecycle_anchor_capacity_exceeded')
      this.poisonIntegrity(error)
      throw error
    }
    this.lifecycleAnchors.set(event.sequence, event.eventId)
  }

  private pinProbeCursor(latestSequence: string): void {
    const pinned = this.pinnedLatestSequence
    if (pinned !== undefined && BigInt(latestSequence) < BigInt(pinned)) {
      const error = new Error('execution_grpc_health_cursor_retrograde')
      this.poisonIntegrity(error)
      throw error
    }
    this.pinnedLatestSequence = latestSequence
  }

  private poisonIntegrity(_cause: Error): void {
    if (this.integrityPoisoned) return
    this.integrityPoisoned = true
    this.readyVerified = false
    this.readableVerified = false
    const poison = new Error('execution_grpc_integrity_poisoned')
    for (const stream of [...this.activeLifecycleStreams]) stream.cancel(poison)
  }
}

export function createExecutionGrpcTransport(
  options: CreateExecutionGrpcTransportOptions,
): ExecutionGrpcTransport {
  return new ExecutionGrpcTransport(options)
}

function createNativeGrpcClient(target: string): ExecutionGrpcRawClient {
  const protoPath = fileURLToPath(new URL('./proto/openalice_execution_v1.proto', import.meta.url))
  const definition = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: Number,
    bytes: Buffer,
    defaults: false,
    arrays: false,
    objects: false,
    oneofs: true,
  })
  const loaded = grpc.loadPackageDefinition(definition) as unknown as {
    openalice?: { execution?: { v1?: { OpenAliceExecutionService?: grpc.ServiceClientConstructor } } }
  }
  const Service = loaded.openalice?.execution?.v1?.OpenAliceExecutionService
  if (!Service) throw new Error('execution_grpc_proto_service_missing')
  return new Service(target, grpc.credentials.createInsecure()) as unknown as ExecutionGrpcRawClient
}

function assertAbsoluteUnixSocketPath(socketPath: string): string {
  if (
    typeof socketPath !== 'string'
    || !socketPath
    || socketPath.includes('\0')
    || !isAbsolute(socketPath)
    || socketPath.startsWith('//')
    || socketPath.includes('://')
    || socketPath.startsWith('unix:')
  ) {
    throw new Error('execution_grpc_uds_socket_path_invalid')
  }
  return socketPath
}

function toUnixTarget(socketPath: string): string {
  return `unix:${socketPath}`
}

function assertRpcDeadlineMs(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 30_000) {
    throw new Error('execution_grpc_deadline_invalid')
  }
  return value
}

function mapExecuteRequest(request: ExecutionSidecarTransportRequest): Record<string, unknown> {
  return {
    command: {
      schema_version: request.command.schemaVersion,
      command_id: request.command.commandId,
      payload_hash: request.command.payloadHash,
      payload: mapPayload(request.command.payload),
      // Buffer.from preserves the supplied canonical bytes exactly.
      canonical_payload_json_utf8: Buffer.from(request.canonicalPayloadJsonUtf8),
    },
    permit_json_utf8: Buffer.from(request.permitJsonUtf8),
  }
}

function mapPayload(payload: ExecutionCommandPayloadV1): Record<string, unknown> {
  const mapped: Record<string, unknown> = {
    schema_version: payload.schemaVersion,
    kind: COMMAND_KIND[payload.kind],
    account_id: payload.accountId,
    canonical_symbol: payload.canonicalSymbol,
    venue: VENUE[payload.venue],
    venue_instrument_id: payload.venueInstrumentId,
    idempotency_key: payload.idempotencyKey,
    mode: PAPER_MODE[payload.mode],
  }
  if (payload.kind === 'submit') {
    Object.assign(mapped, {
      client_order_id: payload.clientOrderId,
      side: ORDER_SIDE[payload.side],
      order_type: ORDER_TYPE[payload.orderType],
      quantity: payload.quantity,
      price: payload.price,
      time_in_force: TIME_IN_FORCE[payload.timeInForce],
      reduce_only: payload.reduceOnly,
      max_notional_usd: payload.maxNotionalUsd,
    })
  } else if (payload.kind === 'cancel') {
    mapped.target_client_order_id = payload.targetClientOrderId
  } else if (payload.kind === 'replace') {
    Object.assign(mapped, {
      target_client_order_id: payload.targetClientOrderId,
      replacement_client_order_id: payload.replacementClientOrderId,
      quantity: payload.quantity,
      price: payload.price,
      time_in_force: TIME_IN_FORCE[payload.timeInForce],
      max_notional_usd: payload.maxNotionalUsd,
    })
  } else if (payload.kind === 'reconcile') {
    if (payload.afterSequence !== undefined) mapped.after_sequence = payload.afterSequence
  } else {
    mapped.reason = payload.reason
  }
  return mapped
}

function mapExecuteResponse(response: unknown): {
  commandId: string
  disposition: 'accepted' | 'duplicate' | 'rejected' | 'suspended' | 'unavailable'
  acceptedSequence?: string
  reason?: string
} {
  const raw = requiredRecord(response)
  const commandId = requiredHash(raw.command_id)
  const disposition = requiredNumber(raw.disposition)
  switch (disposition) {
    case EXECUTE_DISPOSITION.ACCEPTED:
      return { commandId, disposition: 'accepted', acceptedSequence: requiredPositiveUint64(raw.accepted_sequence) }
    case EXECUTE_DISPOSITION.DUPLICATE:
      return { commandId, disposition: 'duplicate', acceptedSequence: requiredPositiveUint64(raw.accepted_sequence) }
    case EXECUTE_DISPOSITION.REJECTED:
      return { commandId, disposition: 'rejected', reason: requiredReason(raw.reason) }
    case EXECUTE_DISPOSITION.SUSPENDED:
      return { commandId, disposition: 'suspended', reason: requiredReason(raw.reason) }
    case EXECUTE_DISPOSITION.UNAVAILABLE:
      return { commandId, disposition: 'unavailable', reason: requiredReason(raw.reason) }
    default:
      throw new Error('execution_grpc_execute_response_invalid')
  }
}

function mapGetCommandResponse(response: unknown, requestedCommandId: string): ExecutionSidecarCommandAdmission {
  const raw = requiredRecord(response)
  assertOnlyKeys(raw, [
    'found',
    'command',
    'permit_json_utf8',
    'disposition',
    'accepted_sequence',
  ], 'execution_grpc_get_command_response_invalid')
  const found = requiredProtoBoolean(raw.found)
  if (!found) {
    if (
      raw.command !== undefined
      || optionalBytes(raw.permit_json_utf8).byteLength !== 0
      || (raw.disposition !== undefined && raw.disposition !== 0)
      || requiredProtoUint64(raw.accepted_sequence) !== '0'
    ) throw new Error('execution_grpc_get_command_response_invalid')
    return { found: false }
  }
  const command = mapGetCommandEnvelope(raw.command)
  const commandId = command.commandId
  if (commandId !== requestedCommandId) throw new Error('execution_grpc_get_command_id_mismatch')
  const permit = mapStoredPermit(raw.permit_json_utf8, command)
  const disposition = requiredNumber(raw.disposition)
  if (disposition !== EXECUTE_DISPOSITION.ACCEPTED && disposition !== EXECUTE_DISPOSITION.DUPLICATE) {
    throw new Error('execution_grpc_get_command_disposition_invalid')
  }
  const clientOrderId = command.payload.kind === 'submit' ? command.payload.clientOrderId : undefined
  return {
    found: true,
    command,
    commandId,
    disposition: disposition === EXECUTE_DISPOSITION.ACCEPTED ? 'accepted' : 'duplicate',
    acceptedSequence: requiredPositiveUint64(raw.accepted_sequence),
    permitV2Id: permit.permitId,
    ...(clientOrderId ? { clientOrderId } : {}),
  }
}

function validateOfflineReceiptReadRequest(
  input: ExecutionOfflineReceiptRequest,
  options: ExecutionOfflineReceiptReadOptions,
  peerMode: ExecutionGrpcExpectedIdentity['mode'] | undefined,
): ExecutionOfflineReceiptRequest {
  const errorCode = 'execution_grpc_offline_receipt_request_invalid'
  try {
    if (
      !input
      || typeof input !== 'object'
      || Array.isArray(input)
      || !HASH_RE.test(input.receiptId)
      || peerMode !== 'PAPER_LOCAL'
      || !options
      || typeof options !== 'object'
      || Array.isArray(options)
      || (options.signal !== undefined && !(options.signal instanceof AbortSignal))
    ) throw new Error(errorCode)
    const trust = input.trustPolicy
    const expected = input.expected
    if (
      !trust
      || typeof trust !== 'object'
      || Array.isArray(trust)
      || !expected
      || typeof expected !== 'object'
      || Array.isArray(expected)
      || expected.mode !== 'PAPER_LOCAL'
      || !OFFLINE_RECEIPT_EXPECTED_FIELDS.every(field => Object.hasOwn(expected, field))
      || typeof trust.keyId !== 'string'
      || typeof trust.adapterId !== 'string'
      || !HASH_RE.test(trust.adapterBuildHash)
      || !HASH_RE.test(trust.adapterConfigHash)
      || typeof trust.adapterRunId !== 'string'
      || !Array.isArray(trust.permitAuthorityKeyIds)
      || trust.permitAuthorityKeyIds.length === 0
      || !trust.permitAuthorityKeyIds.every(keyId => typeof keyId === 'string' && keyId.length > 0)
      || !Array.isArray(trust.permitAuthorityPublicKeyFingerprints)
      || trust.permitAuthorityPublicKeyFingerprints.length === 0
      || !trust.permitAuthorityPublicKeyFingerprints.every(fingerprint => HASH_RE.test(fingerprint))
      || trust.publicKey === undefined
      || trust.publicKey === null
      || !trust.permitAuthorityKeyIds.includes(expected.permitKeyId)
      || trust.permitAuthorityKeyIds.includes(trust.keyId)
    ) throw new Error(errorCode)
    requiredCanonicalText(trust.keyId, 100, errorCode)
    requiredCanonicalText(trust.adapterId, 200, errorCode)
    requiredCanonicalText(trust.adapterRunId, 300, errorCode)
    const receiptKeyFingerprint = ed25519PublicKeyFingerprintSha256(trust.publicKey)
    if (trust.permitAuthorityPublicKeyFingerprints.includes(receiptKeyFingerprint)) {
      throw new Error(errorCode)
    }
    if (
      input.now !== undefined
      && (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime()))
    ) throw new Error(errorCode)
    if (
      input.maxFutureMs !== undefined
      && (
        !Number.isFinite(input.maxFutureMs)
        || input.maxFutureMs < 0
        || input.maxFutureMs > MAX_OFFLINE_RECEIPT_FUTURE_MS
      )
    ) throw new Error(errorCode)
    return {
      receiptId: input.receiptId,
      trustPolicy: {
        ...trust,
        permitAuthorityKeyIds: [...trust.permitAuthorityKeyIds],
        permitAuthorityPublicKeyFingerprints: [
          ...trust.permitAuthorityPublicKeyFingerprints,
        ],
      },
      expected: { ...expected },
      ...(input.now === undefined ? {} : { now: new Date(input.now.getTime()) }),
      ...(input.maxFutureMs === undefined ? {} : { maxFutureMs: input.maxFutureMs }),
    }
  } catch {
    throw new Error(errorCode)
  }
}

function mapGetOfflineExecutionReceiptResponse(
  response: unknown,
  request: ExecutionOfflineReceiptRequest,
): ExecutionOfflineReceiptReadResult {
  const raw = requiredRecord(response)
  assertOnlyKeys(raw, [
    'found',
    'receipt',
    'canonical_receipt_json_utf8',
    'canonical_request_json_utf8',
    'canonical_response_json_utf8',
    'lifecycle_event',
  ], 'execution_grpc_offline_receipt_response_invalid')
  const found = requiredProtoBoolean(raw.found)
  const receiptBytes = optionalBytes(raw.canonical_receipt_json_utf8)
  const requestBytes = optionalBytes(raw.canonical_request_json_utf8)
  const responseBytes = optionalBytes(raw.canonical_response_json_utf8)
  if (!found) {
    if (
      raw.receipt !== undefined
      || raw.lifecycle_event !== undefined
      || receiptBytes.byteLength !== 0
      || requestBytes.byteLength !== 0
      || responseBytes.byteLength !== 0
    ) throw new Error('execution_grpc_offline_receipt_response_invalid')
    return { found: false }
  }
  if (
    raw.receipt === undefined
    || raw.lifecycle_event === undefined
    || receiptBytes.byteLength === 0
    || requestBytes.byteLength === 0
    || responseBytes.byteLength === 0
  ) throw new Error('execution_grpc_offline_receipt_response_invalid')

  let receipt: OfflineExecutionReceiptV1
  try {
    receipt = parseOfflineExecutionReceiptJsonUtf8(receiptBytes)
  } catch {
    throw new Error('execution_grpc_offline_receipt_canonical_json_invalid')
  }
  if (receipt.receiptId !== request.receiptId) {
    throw new Error('execution_grpc_offline_receipt_id_mismatch')
  }
  const projectedReceipt = mapOfflineExecutionReceiptProjection(raw.receipt)
  if (stableStringify(projectedReceipt) !== stableStringify(receipt)) {
    throw new Error('execution_grpc_offline_receipt_projection_mismatch')
  }
  const verification = verifyOfflineExecutionReceiptV1({
    receipt,
    canonicalRequestJsonUtf8: requestBytes,
    canonicalResponseJsonUtf8: responseBytes,
    trustPolicy: request.trustPolicy,
    expected: request.expected,
    ...(request.now === undefined ? {} : { now: request.now }),
    ...(request.maxFutureMs === undefined ? {} : { maxFutureMs: request.maxFutureMs }),
  })
  if (!verification.valid) throw new Error('execution_grpc_offline_receipt_untrusted')
  const lifecycleEvent = mapExecutionEvent(raw.lifecycle_event)
  if (
    lifecycleEvent.schemaVersion !== 'openalice_execution_event.v2'
    || !executionEventV2MatchesOfflineReceipt(receipt, lifecycleEvent)
  ) throw new Error('execution_grpc_offline_receipt_event_mismatch')
  return {
    found: true,
    finalizationEligible: false,
    receipt: verification.receipt,
    lifecycleEvent,
    canonicalReceiptJsonUtf8: Uint8Array.from(receiptBytes),
    canonicalRequestJsonUtf8: Uint8Array.from(requestBytes),
    canonicalResponseJsonUtf8: Uint8Array.from(responseBytes),
  }
}

function mapOfflineExecutionReceiptProjection(value: unknown): OfflineExecutionReceiptV1 {
  try {
    const raw = requiredRecord(value)
    assertOnlyKeys(raw, [
      'schema_version',
      'scope',
      'command_id',
      'payload_hash',
      'permit_v2_id',
      'permit_key_id',
      'accepted_sequence',
      'lifecycle_sequence',
      'lifecycle_kind',
      'idempotency_key',
      'account_id',
      'canonical_symbol',
      'venue',
      'venue_instrument_id',
      'mode',
      'client_order_id',
      'side',
      'order_type',
      'time_in_force',
      'reduce_only',
      'quantity',
      'price',
      'max_notional_usd',
      'adapter_id',
      'adapter_build_hash',
      'adapter_config_hash',
      'adapter_run_id',
      'adapter_epoch',
      'adapter_key_id',
      'attempt_id',
      'attempt_number',
      'source_namespace_id',
      'source_sequence',
      'transition_number',
      'simulated_order_id',
      'request_hash',
      'response_hash',
      'permit_issued_at',
      'permit_expires_at',
      'dispatch_armed_at',
      'adapter_observed_at',
      'simulator_occurred_at',
      'previous_receipt_id',
      'filled_quantity',
      'average_price',
      'reason',
      'receipt_id',
      'signature',
    ], 'execution_grpc_offline_receipt_response_invalid')
    const lifecycleKind = EXECUTION_EVENT_KIND[requiredNumber(raw.lifecycle_kind) as keyof typeof EXECUTION_EVENT_KIND]
    if (
      lifecycleKind !== 'submitted'
      && lifecycleKind !== 'partially_filled'
      && lifecycleKind !== 'filled'
      && lifecycleKind !== 'canceled'
      && lifecycleKind !== 'rejected'
      && lifecycleKind !== 'expired'
      && lifecycleKind !== 'submission_unknown'
    ) throw new Error('execution_grpc_offline_receipt_response_invalid')
    return offlineExecutionReceiptV1Schema.parse({
      schemaVersion: requiredString(raw.schema_version),
      scope: requiredString(raw.scope),
      commandId: requiredHash(raw.command_id),
      payloadHash: requiredHash(raw.payload_hash),
      permitV2Id: requiredHash(raw.permit_v2_id),
      permitKeyId: requiredString(raw.permit_key_id),
      acceptedSequence: requiredPositiveUint64(raw.accepted_sequence),
      lifecycleSequence: requiredPositiveUint64(raw.lifecycle_sequence),
      lifecycleKind,
      idempotencyKey: requiredString(raw.idempotency_key),
      accountId: requiredString(raw.account_id),
      canonicalSymbol: requiredString(raw.canonical_symbol),
      venue: raw.venue === VENUE.OKX ? 'OKX' : invalidOfflineReceiptProjection(),
      venueInstrumentId: requiredString(raw.venue_instrument_id),
      mode: raw.mode === PAPER_MODE.PAPER_LOCAL ? 'PAPER_LOCAL' : invalidOfflineReceiptProjection(),
      clientOrderId: requiredString(raw.client_order_id),
      side: raw.side === ORDER_SIDE.buy ? 'buy' : invalidOfflineReceiptProjection(),
      orderType: raw.order_type === ORDER_TYPE.limit ? 'limit' : invalidOfflineReceiptProjection(),
      timeInForce: mapOfflineReceiptTimeInForce(raw.time_in_force),
      reduceOnly: requiredProtoBoolean(raw.reduce_only),
      quantity: requiredString(raw.quantity),
      price: requiredString(raw.price),
      maxNotionalUsd: requiredString(raw.max_notional_usd),
      adapterId: requiredString(raw.adapter_id),
      adapterBuildHash: requiredHash(raw.adapter_build_hash),
      adapterConfigHash: requiredHash(raw.adapter_config_hash),
      adapterRunId: requiredString(raw.adapter_run_id),
      adapterEpoch: requiredPositiveUint64(raw.adapter_epoch),
      adapterKeyId: requiredString(raw.adapter_key_id),
      attemptId: requiredHash(raw.attempt_id),
      attemptNumber: requiredPositiveUint64(raw.attempt_number),
      sourceNamespaceId: requiredHash(raw.source_namespace_id),
      sourceSequence: requiredPositiveUint64(raw.source_sequence),
      transitionNumber: requiredPositiveUint64(raw.transition_number),
      ...optionalOfflineReceiptString('simulatedOrderId', raw.simulated_order_id),
      requestHash: requiredHash(raw.request_hash),
      responseHash: requiredHash(raw.response_hash),
      permitIssuedAt: requiredString(raw.permit_issued_at),
      permitExpiresAt: requiredString(raw.permit_expires_at),
      dispatchArmedAt: requiredString(raw.dispatch_armed_at),
      adapterObservedAt: requiredString(raw.adapter_observed_at),
      simulatorOccurredAt: requiredString(raw.simulator_occurred_at),
      ...optionalOfflineReceiptString('previousReceiptId', raw.previous_receipt_id),
      ...optionalOfflineReceiptString('filledQuantity', raw.filled_quantity),
      ...optionalOfflineReceiptString('averagePrice', raw.average_price),
      ...optionalOfflineReceiptString('reason', raw.reason),
      receiptId: requiredHash(raw.receipt_id),
      signature: requiredString(raw.signature),
    })
  } catch (error) {
    if (
      error instanceof Error
      && error.message === 'execution_grpc_offline_receipt_response_invalid'
    ) throw error
    throw new Error('execution_grpc_offline_receipt_response_invalid')
  }
}

function mapOfflineReceiptTimeInForce(value: unknown): 'GTC' | 'IOC' | 'FOK' {
  if (value === TIME_IN_FORCE.GTC) return 'GTC'
  if (value === TIME_IN_FORCE.IOC) return 'IOC'
  if (value === TIME_IN_FORCE.FOK) return 'FOK'
  throw new Error('execution_grpc_offline_receipt_response_invalid')
}

function invalidOfflineReceiptProjection(): never {
  throw new Error('execution_grpc_offline_receipt_response_invalid')
}

function optionalOfflineReceiptString<Key extends string>(
  key: Key,
  value: unknown,
): { [Property in Key]?: string } {
  if (value === undefined || value === '') return {}
  if (typeof value !== 'string') throw new Error('execution_grpc_offline_receipt_response_invalid')
  return { [key]: value } as { [Property in Key]?: string }
}

function mapStoredPermit(value: unknown, command: ReturnType<typeof mapGetCommandEnvelope>): ExecutionPermitV2 {
  try {
    const canonical = parseCanonicalJsonUtf8(
      value,
      'execution_grpc_get_command_permit_invalid',
    )
    const permit = validateExecutionPermitV2(canonical.parsed)
    if (
      command.payload.kind !== 'submit'
      || permit.commandHash !== command.commandId
      || permit.action !== command.payload.kind
      || permit.accountId !== command.payload.accountId
      || permit.canonicalSymbol !== command.payload.canonicalSymbol
      || permit.venueInstrumentId !== command.payload.venueInstrumentId
      || permit.idempotencyKey !== command.payload.idempotencyKey
      || permit.mode !== command.payload.mode
      || permit.side !== command.payload.side
      || permit.riskReducing !== command.payload.reduceOnly
      || permit.authorizedNotionalUsd !== command.payload.maxNotionalUsd
    ) throw new Error('execution_grpc_get_command_permit_binding_invalid')
    // Signature authenticity was verified by the admitting Python core.  The
    // Node read path has no public-key resolver, so it verifies canonical
    // bytes, deterministic permitId, and exact command/economic binding only.
    return permit
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'execution_grpc_get_command_permit_invalid'
        || error.message === 'execution_grpc_get_command_permit_binding_invalid'
      )
    ) throw error
    throw new Error('execution_grpc_get_command_permit_invalid')
  }
}

function mapGetCommandEnvelope(value: unknown) {
  try {
    const raw = requiredRecord(value)
    assertOnlyKeys(raw, [
      'schema_version',
      'command_id',
      'payload_hash',
      'payload',
      'canonical_payload_json_utf8',
    ], 'execution_grpc_get_command_response_invalid')
    const canonical = parseCanonicalJsonUtf8(
      raw.canonical_payload_json_utf8,
      'execution_grpc_get_command_canonical_payload_invalid',
    )
    const command = executionCommandV1Schema.parse({
      schemaVersion: requiredString(raw.schema_version),
      commandId: requiredHash(raw.command_id),
      payloadHash: requiredHash(raw.payload_hash),
      payload: canonical.parsed,
    })
    assertWirePayloadMatches(requiredRecord(raw.payload), mapPayload(command.payload))
    return command
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'execution_grpc_get_command_response_invalid'
        || error.message === 'execution_grpc_get_command_canonical_payload_invalid'
      )
    ) throw error
    throw new Error('execution_grpc_get_command_response_invalid')
  }
}

function assertWirePayloadMatches(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
): void {
  assertOnlyKeys(actual, Object.keys(expected), 'execution_grpc_get_command_response_invalid')
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key]
    // proto3 omits encoded scalar defaults when proto-loader defaults are off.
    if (actualValue === undefined && (
      (key === 'reduce_only' && expectedValue === false)
      || (key === 'after_sequence' && expectedValue === '0')
    )) continue
    if (actualValue !== expectedValue) throw new Error('execution_grpc_get_command_response_invalid')
  }
}

function mapGetSnapshotRequest(request: ExecutionLifecycleSnapshotRequest): Record<string, unknown> {
  if (!request || typeof request !== 'object') throw new Error('execution_grpc_snapshot_request_invalid')
  const accountId = requiredCanonicalText(request.accountId, 200, 'execution_grpc_snapshot_request_invalid')
  if (request.canonicalSymbol !== 'BTC/USDT') throw new Error('execution_grpc_snapshot_request_invalid')
  return { account_id: accountId, canonical_symbol: request.canonicalSymbol }
}

function mapGetSnapshotResponse(response: unknown): ExecutionLifecycleSnapshot {
  const raw = requiredRecord(response)
  assertOnlyKeys(
    raw,
    ['found', 'as_of_sequence', 'snapshot_json_utf8'],
    'execution_grpc_snapshot_response_invalid',
  )
  const found = requiredProtoBoolean(raw.found)
  const asOfSequence = requiredProtoUint64(raw.as_of_sequence)
  if (!found) {
    const bytes = optionalBytes(raw.snapshot_json_utf8)
    if (asOfSequence !== '0' || bytes.byteLength !== 0) {
      throw new Error('execution_grpc_snapshot_response_invalid')
    }
    return { found: false }
  }
  const canonical = parseCanonicalJsonUtf8(
    raw.snapshot_json_utf8,
    'execution_grpc_snapshot_canonical_json_invalid',
  )
  return {
    found: true,
    asOfSequence,
    canonicalJsonUtf8: canonical.bytes,
    parsed: canonical.parsed,
  }
}

function mapReplayEventsRequest(request: ExecutionLifecycleReplayRequest): Record<string, unknown> {
  if (!request || typeof request !== 'object') throw new Error('execution_grpc_replay_request_invalid')
  const afterSequence = requiredInputUint64(request.afterSequence, 'execution_grpc_replay_request_invalid')
  if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_REPLAY_LIMIT) {
    throw new Error('execution_grpc_replay_request_invalid')
  }
  return { after_sequence: afterSequence, limit: request.limit }
}

function mapReplayEventsResponse(
  response: unknown,
  afterSequence: string,
  limit: number,
): readonly ExecutionEvent[] {
  const raw = requiredRecord(response)
  assertOnlyKeys(raw, ['events'], 'execution_grpc_replay_response_invalid')
  if (raw.events === undefined) return []
  if (!Array.isArray(raw.events) || raw.events.length > limit) {
    throw new Error('execution_grpc_replay_response_invalid')
  }
  const tracker = new LifecycleSequenceTracker(afterSequence)
  const events: ExecutionEvent[] = []
  for (let index = 0; index < raw.events.length; index += 1) {
    if (!Object.hasOwn(raw.events, index)) throw new Error('execution_grpc_replay_response_invalid')
    events.push(tracker.accept(mapExecutionEvent(raw.events[index])))
  }
  return events
}

function mapExecutionEvent(value: unknown): ExecutionEvent {
  try {
    const raw = requiredRecord(value)
    assertOnlyKeys(raw, [
      'schema_version',
      'event_id',
      'command_id',
      'sequence',
      'occurred_at',
      'kind',
      'client_order_id',
      'venue_order_id',
      'filled_quantity',
      'average_price',
      'reason',
      'evidence_schema_version',
      'evidence_receipt_id',
    ], 'execution_grpc_lifecycle_event_invalid')
    const kindNumber = requiredNumber(raw.kind)
    const kind = EXECUTION_EVENT_KIND[kindNumber as keyof typeof EXECUTION_EVENT_KIND]
    if (!kind) throw new Error('execution_grpc_lifecycle_event_invalid')
    const schemaVersion = requiredString(raw.schema_version)
    if (
      schemaVersion === 'openalice_execution_event.v1'
      && (
        (typeof raw.evidence_schema_version === 'string' && raw.evidence_schema_version.length > 0)
        || (typeof raw.evidence_receipt_id === 'string' && raw.evidence_receipt_id.length > 0)
      )
    ) throw new Error('execution_grpc_lifecycle_event_invalid')
    return executionEventSchema.parse({
      schemaVersion,
      eventId: requiredHash(raw.event_id),
      commandId: requiredHash(raw.command_id),
      sequence: requiredPositiveUint64(raw.sequence),
      occurredAt: requiredString(raw.occurred_at),
      kind,
      ...optionalStringProperty('clientOrderId', raw.client_order_id),
      ...optionalStringProperty('venueOrderId', raw.venue_order_id),
      ...optionalStringProperty('filledQuantity', raw.filled_quantity),
      ...optionalStringProperty('averagePrice', raw.average_price),
      ...optionalStringProperty('reason', raw.reason),
      ...(schemaVersion === 'openalice_execution_event.v2'
        ? {
            evidenceSchemaVersion: requiredString(raw.evidence_schema_version),
            evidenceReceiptId: requiredHash(raw.evidence_receipt_id),
          }
        : {}),
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'execution_grpc_lifecycle_event_invalid') throw error
    throw new Error('execution_grpc_lifecycle_event_invalid')
  }
}

function validateExpectedIdentity(input: ExecutionGrpcExpectedIdentity): ExecutionGrpcExpectedIdentity {
  if (!input || typeof input !== 'object') throw new Error('execution_grpc_expected_identity_invalid')
  if (typeof input.clientId !== 'string' || !CLIENT_ID_RE.test(input.clientId)) {
    throw new Error('execution_grpc_expected_identity_invalid')
  }
  if (input.mode !== 'PAPER_LOCAL' && input.mode !== 'PAPER_EXCHANGE') {
    throw new Error('execution_grpc_expected_identity_invalid')
  }
  if (typeof input.runId !== 'string' || !RUN_ID_RE.test(input.runId)) {
    throw new Error('execution_grpc_expected_identity_invalid')
  }
  if (!HASH_RE.test(input.environmentProofHash) || !HASH_RE.test(input.schemaHash)) {
    throw new Error('execution_grpc_expected_identity_invalid')
  }
  return input
}

function sameExpectedIdentity(
  left: ExecutionGrpcExpectedIdentity,
  right: ExecutionGrpcExpectedIdentity,
): boolean {
  return left.clientId === right.clientId
    && left.mode === right.mode
    && left.runId === right.runId
    && left.environmentProofHash === right.environmentProofHash
    && left.schemaHash === right.schemaHash
}

function mapHandshakeResponse(
  response: unknown,
  expected: ExecutionGrpcExpectedIdentity,
): Omit<ExecutionGrpcVerifiedIdentity, 'latestSequence'> {
  const raw = requiredRecord(response)
  const writerEpoch = requiredPositiveUint64(raw.writer_epoch)
  if (
    raw.protocol_version !== EXECUTION_GRPC_PROTOCOL_VERSION
    || raw.service_id !== EXECUTION_GRPC_SERVICE_ID
    || raw.mode !== PAPER_MODE[expected.mode]
    || raw.run_id !== expected.runId
    || raw.environment_proof_hash !== expected.environmentProofHash
    || raw.schema_hash !== expected.schemaHash
  ) {
    throw new Error('execution_grpc_handshake_identity_mismatch')
  }
  return {
    protocolVersion: EXECUTION_GRPC_PROTOCOL_VERSION,
    serviceId: EXECUTION_GRPC_SERVICE_ID,
    mode: expected.mode,
    runId: expected.runId,
    environmentProofHash: expected.environmentProofHash,
    schemaHash: expected.schemaHash,
    writerEpoch,
  }
}

function mapHealthResponse(
  response: unknown,
  expected: ExecutionGrpcExpectedIdentity,
  expectedWriterEpoch: string,
): { latestSequence: string } {
  const raw = requiredRecord(response)
  const writerEpoch = requiredPositiveUint64(raw.writer_epoch)
  // proto3 omits a scalar uint64 whose canonical value is zero when defaults
  // are disabled in proto-loader; absence therefore means exactly "0" here.
  const latestSequence = requiredProtoUint64(raw.latest_sequence)
  const circuitReason = raw.circuit_reason
  if (
    raw.status !== SERVICE_STATUS.READY
    || raw.detail !== 'durable_admission_ready_not_broker_ready'
    || (circuitReason !== undefined && circuitReason !== '')
  ) {
    throw new Error('execution_grpc_health_not_ready')
  }
  if (
    raw.mode !== PAPER_MODE[expected.mode]
    || raw.run_id !== expected.runId
    || raw.environment_proof_hash !== expected.environmentProofHash
    || raw.schema_hash !== expected.schemaHash
    || writerEpoch !== expectedWriterEpoch
  ) {
    throw new Error('execution_grpc_health_identity_mismatch')
  }
  return { latestSequence }
}

function mapReadOnlyHealthResponse(
  response: unknown,
  expected: ExecutionGrpcExpectedIdentity,
  expectedWriterEpoch: string,
): { latestSequence: string } {
  const raw = requiredRecord(response)
  const writerEpoch = requiredPositiveUint64(raw.writer_epoch)
  const latestSequence = requiredProtoUint64(raw.latest_sequence)
  if (
    raw.status !== SERVICE_STATUS.READ_ONLY
    || raw.detail !== 'durable_admission_read_only'
    || raw.circuit_reason !== 'runtime_write_disarmed'
  ) {
    throw new Error('execution_grpc_health_not_read_only')
  }
  if (
    raw.mode !== PAPER_MODE[expected.mode]
    || raw.run_id !== expected.runId
    || raw.environment_proof_hash !== expected.environmentProofHash
    || raw.schema_hash !== expected.schemaHash
    || writerEpoch !== expectedWriterEpoch
  ) {
    throw new Error('execution_grpc_health_identity_mismatch')
  }
  return { latestSequence }
}

class LifecycleSequenceTracker {
  private expected: bigint
  private lastSequence: bigint | undefined
  private lastEventId: string | undefined

  constructor(afterSequence: string) {
    this.expected = BigInt(requiredInputUint64(afterSequence, 'execution_grpc_lifecycle_cursor_invalid')) + 1n
  }

  accept(event: ExecutionEvent): ExecutionEvent {
    const actual = BigInt(event.sequence)
    if (actual !== this.expected) {
      if (this.lastSequence === actual) {
        throw new Error(
          this.lastEventId === event.eventId
            ? 'execution_grpc_lifecycle_sequence_duplicate'
            : 'execution_grpc_lifecycle_sequence_equivocation',
        )
      }
      throw new Error(
        actual < this.expected
          ? 'execution_grpc_lifecycle_sequence_retrograde'
          : 'execution_grpc_lifecycle_sequence_gap',
      )
    }
    this.lastSequence = actual
    this.lastEventId = event.eventId
    this.expected += 1n
    return event
  }
}

interface PendingStreamRead {
  readonly resolve: (result: IteratorResult<ExecutionEvent>) => void
  readonly reject: (error: Error) => void
}

/**
 * Starts the read-only stream immediately so return/close can cancel a pending
 * read, but gates every value behind a fresh pinned-identity probe.  No event
 * is exposed to the caller before that probe succeeds.
 */
class VerifiedLifecycleEventStream implements AsyncIterable<ExecutionEvent>, AsyncIterator<ExecutionEvent> {
  private readonly verificationController = new AbortController()
  private readonly managed: ManagedLifecycleEventStream
  private readonly verification: Promise<void>
  private iteratorClaimed = false
  private cleaned = false

  private readonly onExternalAbort = (): void => {
    this.cancel(abortError())
  }

  constructor(
    call: ExecutionGrpcRawServerStream,
    afterSequence: string,
    private readonly externalSignal: AbortSignal,
    onValidatedEvent: (event: ExecutionEvent) => void,
    verify: (signal: AbortSignal) => Promise<void>,
    onIntegrityFailure: (error: Error) => void,
    private readonly onClosed: (stream: VerifiedLifecycleEventStream) => void,
  ) {
    this.managed = new ManagedLifecycleEventStream(
      call,
      afterSequence,
      this.verificationController.signal,
      onValidatedEvent,
      onIntegrityFailure,
      () => this.cleanup(),
    )
    this.externalSignal.addEventListener('abort', this.onExternalAbort, { once: true })
    if (this.externalSignal.aborted) this.onExternalAbort()
    this.verification = verify(this.verificationController.signal).catch(error => {
      const normalized = normalizeError(error)
      this.managed.cancel(normalized)
      throw normalized
    })
    // `return()` may intentionally abandon the iterator before the identity
    // probe settles; retain no unhandled rejection in that path.
    void this.verification.catch(() => undefined)
  }

  get finished(): boolean {
    return this.managed.finished
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    if (this.iteratorClaimed) throw new Error('execution_grpc_stream_single_consumer_required')
    this.iteratorClaimed = true
    return this
  }

  async next(): Promise<IteratorResult<ExecutionEvent>> {
    try {
      await this.verification
    } catch {
      // The managed iterator owns the authoritative terminal outcome. This
      // preserves consumer return (done), explicit close, and abort causes
      // when cancellation races the serialized identity probe.
      return this.managed.next()
    }
    return this.managed.next()
  }

  async return(): Promise<IteratorResult<ExecutionEvent>> {
    const result = this.managed.return()
    this.verificationController.abort()
    return result
  }

  cancel(error: Error): void {
    this.managed.cancel(error)
    this.verificationController.abort()
  }

  private cleanup(): void {
    if (this.cleaned) return
    this.cleaned = true
    this.externalSignal.removeEventListener('abort', this.onExternalAbort)
    this.onClosed(this)
  }
}

class ManagedLifecycleEventStream implements AsyncIterable<ExecutionEvent>, AsyncIterator<ExecutionEvent> {
  private readonly queued: ExecutionEvent[] = []
  private readonly tracker: LifecycleSequenceTracker
  private pending: PendingStreamRead | undefined
  private terminalError: Error | undefined
  private errorDelivered = false
  private iteratorClaimed = false
  private ended = false
  private cleaned = false
  private cancellationCleanupTimer: ReturnType<typeof setTimeout> | undefined

  private readonly onData = (response: unknown): void => {
    if (this.ended) return
    try {
      if (!this.pending && this.queued.length >= MAX_REPLAY_LIMIT) {
        throw new Error('execution_grpc_stream_buffer_overflow')
      }
      const event = this.tracker.accept(mapExecutionEvent(response))
      this.onValidatedEvent(event)
      const pending = this.pending
      if (pending) {
        this.pending = undefined
        pending.resolve({ done: false, value: event })
      } else {
        this.queued.push(event)
      }
    } catch (error) {
      const normalized = normalizeError(error)
      this.fail(normalized, true)
      this.onIntegrityFailure(normalized)
    }
  }

  private readonly onError = (error: Error): void => {
    if (this.ended) {
      this.cleanup()
      return
    }
    this.fail(normalizeError(error), false)
  }

  private readonly onEnd = (): void => {
    if (this.ended) {
      this.cleanup()
      return
    }
    this.ended = true
    this.cleanup()
    if (this.queued.length === 0 && this.pending) {
      const pending = this.pending
      this.pending = undefined
      pending.resolve({ done: true, value: undefined })
    }
  }

  private readonly onAbort = (): void => {
    this.fail(abortError(), true)
  }

  constructor(
    private readonly call: ExecutionGrpcRawServerStream,
    afterSequence: string,
    private readonly signal: AbortSignal,
    private readonly onValidatedEvent: (event: ExecutionEvent) => void,
    private readonly onIntegrityFailure: (error: Error) => void,
    private readonly onClosed: (stream: ManagedLifecycleEventStream) => void,
  ) {
    this.tracker = new LifecycleSequenceTracker(afterSequence)
    try {
      this.call.on('data', this.onData)
      this.call.on('error', this.onError)
      this.call.on('end', this.onEnd)
      this.signal.addEventListener('abort', this.onAbort, { once: true })
      if (this.signal.aborted) this.onAbort()
    } catch (error) {
      this.removeListeners()
      try { this.call.cancel() } catch { /* best-effort cleanup after construction failure */ }
      throw error
    }
  }

  get finished(): boolean {
    return this.ended
  }

  [Symbol.asyncIterator](): AsyncIterator<ExecutionEvent> {
    if (this.iteratorClaimed) throw new Error('execution_grpc_stream_single_consumer_required')
    this.iteratorClaimed = true
    return this
  }

  next(): Promise<IteratorResult<ExecutionEvent>> {
    const queued = this.queued.shift()
    if (queued) return Promise.resolve({ done: false, value: queued })
    if (this.terminalError) {
      if (this.errorDelivered) return Promise.resolve({ done: true, value: undefined })
      this.errorDelivered = true
      return Promise.reject(this.terminalError)
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    if (this.pending) return Promise.reject(new Error('execution_grpc_stream_concurrent_next_invalid'))
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  return(): Promise<IteratorResult<ExecutionEvent>> {
    if (!this.ended) {
      this.ended = true
      this.queued.length = 0
      const pending = this.pending
      this.pending = undefined
      pending?.resolve({ done: true, value: undefined })
      this.cancelAndAwaitTerminal()
    }
    return Promise.resolve({ done: true, value: undefined })
  }

  cancel(error: Error): void {
    this.fail(error, true)
  }

  private fail(error: Error, cancelCall: boolean): void {
    if (this.ended) return
    this.ended = true
    this.queued.length = 0
    this.terminalError = error
    const pending = this.pending
    this.pending = undefined
    pending?.reject(error)
    if (cancelCall) {
      this.cancelAndAwaitTerminal()
    } else {
      this.cleanup()
    }
  }

  private cancelAndAwaitTerminal(): void {
    try {
      // Keep the error/end handlers installed until grpc-js reports the
      // expected CANCELLED terminal status; removing them before cancel()
      // would turn that status into an uncaught EventEmitter error.
      this.call.cancel()
    } catch {
      this.cleanup()
      return
    }
    if (this.cleaned) return
    this.cancellationCleanupTimer = setTimeout(() => this.cleanup(), 1_000)
    this.cancellationCleanupTimer.unref?.()
  }

  private cleanup(): void {
    if (this.cleaned) return
    this.cleaned = true
    if (this.cancellationCleanupTimer) clearTimeout(this.cancellationCleanupTimer)
    this.cancellationCleanupTimer = undefined
    this.removeListeners()
    this.signal.removeEventListener('abort', this.onAbort)
    this.onClosed(this)
  }

  private removeListeners(): void {
    try { this.call.removeListener('data', this.onData) } catch { /* best effort */ }
    try { this.call.removeListener('error', this.onError) } catch { /* best effort */ }
    try { this.call.removeListener('end', this.onEnd) } catch { /* best effort */ }
  }
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('execution_grpc_response_invalid')
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('execution_grpc_response_invalid')
  return value
}

function requiredCanonicalText(value: unknown, maxLength: number, errorCode: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maxLength
    || value !== value.trim()
  ) throw new Error(errorCode)
  return value
}

function requiredInputUint64(value: unknown, errorCode: string): string {
  if (typeof value !== 'string' || !UINT64_RE.test(value) || BigInt(value) > MAX_UINT64) {
    throw new Error(errorCode)
  }
  return value
}

function requiredHash(value: unknown): string {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new Error('execution_grpc_response_invalid')
  return value
}

function requiredNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('execution_grpc_response_invalid')
  }
  return value
}

function requiredPositiveUint64(value: unknown): string {
  if (typeof value !== 'string' || !POSITIVE_UINT64_RE.test(value) || BigInt(value) > MAX_UINT64) {
    throw new Error('execution_grpc_response_invalid')
  }
  return value
}

function requiredProtoUint64(value: unknown): string {
  if (value === undefined) return '0'
  if (typeof value !== 'string' || !UINT64_RE.test(value) || BigInt(value) > MAX_UINT64) {
    throw new Error('execution_grpc_response_invalid')
  }
  return value
}

function requiredProtoBoolean(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new Error('execution_grpc_response_invalid')
  return value
}

function requiredReason(value: unknown): string {
  if (typeof value !== 'string' || !REASON_RE.test(value)) throw new Error('execution_grpc_response_invalid')
  return value
}

function optionalStringProperty<Key extends string>(
  key: Key,
  value: unknown,
): { [Property in Key]?: string } {
  if (value === undefined || value === '') return {}
  if (typeof value !== 'string') throw new Error('execution_grpc_lifecycle_event_invalid')
  return { [key]: value } as { [Property in Key]?: string }
}

function optionalBytes(value: unknown): Buffer {
  if (value === undefined) return Buffer.alloc(0)
  if (!(value instanceof Uint8Array)) throw new Error('execution_grpc_response_invalid')
  return Buffer.from(value)
}

function parseCanonicalJsonUtf8(
  value: unknown,
  errorCode: string,
): { readonly bytes: Uint8Array, readonly parsed: unknown } {
  try {
    if (!(value instanceof Uint8Array) || value.byteLength === 0) throw new Error(errorCode)
    const bytes = Buffer.from(value)
    const decoded = STRICT_UTF8_DECODER.decode(bytes)
    const parsed: unknown = JSON.parse(decoded)
    if (stableStringify(parsed) !== decoded) throw new Error(errorCode)
    if (!Buffer.from(decoded, 'utf8').equals(bytes)) throw new Error(errorCode)
    return { bytes: Uint8Array.from(bytes), parsed }
  } catch {
    throw new Error(errorCode)
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  errorCode: string,
): void {
  const allowedSet = new Set(allowed)
  if (Object.keys(value).some(key => !allowedSet.has(key))) throw new Error(errorCode)
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error('execution_grpc_stream_error')
}

function abortError(): Error {
  const error = new Error('execution_grpc_aborted')
  error.name = 'AbortError'
  return error
}
