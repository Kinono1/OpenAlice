import Decimal from 'decimal.js'
import { z } from 'zod'
import { stableStringify } from '../../sidecar/contracts.js'
import {
  validateExecutionPermit,
  type ExecutionPermitRequest,
  type ExecutionPermitV1,
} from './execution-permit.js'
import {
  EXECUTION_COMMAND_PAYLOAD_V1,
  buildExecutionCommandV1,
  deriveOkxClientOrderId,
  validateExecutionPermitV2,
  type ExecutionCommandV1,
  type ExecutionPermitV2,
  type ExecutionPermitV2Signer,
} from './execution-protocol.js'
import type {
  AuthorizedBrokerWriter,
  BrokerWriteOutcome,
} from './broker-write-router.js'
import type { BrokerWriteAuthorizationContext } from './operation-dispatcher.execution-gate.js'
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
} from './operation-dispatcher.types.js'

const HASH_RE = /^[a-f0-9]{64}$/
const UINT64_RE = /^(?:0|[1-9][0-9]*)$/
const MAX_UINT64 = 18_446_744_073_709_551_615n
const TIMEOUT = Symbol('execution_sidecar_transport_timeout')

const commandIdSchema = z.string().regex(HASH_RE)
const acceptedSequenceSchema = z.string().regex(UINT64_RE).refine(
  value => value !== '0' && BigInt(value) <= MAX_UINT64,
  'accepted sequence must be a canonical positive uint64',
)
const reasonCodeSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,200}$/)

export const executionSidecarExecuteResponseSchema = z.discriminatedUnion('disposition', [
  z.object({
    commandId: commandIdSchema,
    disposition: z.literal('accepted'),
    acceptedSequence: acceptedSequenceSchema,
  }).strict(),
  z.object({
    commandId: commandIdSchema,
    disposition: z.literal('duplicate'),
    acceptedSequence: acceptedSequenceSchema,
  }).strict(),
  z.object({
    commandId: commandIdSchema,
    disposition: z.literal('rejected'),
    reason: reasonCodeSchema,
  }).strict(),
  z.object({
    commandId: commandIdSchema,
    disposition: z.literal('suspended'),
    reason: reasonCodeSchema,
  }).strict(),
  z.object({
    commandId: commandIdSchema,
    disposition: z.literal('unavailable'),
    reason: reasonCodeSchema,
  }).strict(),
])

export type ExecutionSidecarExecuteResponse = z.infer<
  typeof executionSidecarExecuteResponseSchema
>

export interface ExecutionSidecarTransportRequest {
  readonly command: ExecutionCommandV1
  readonly permit: ExecutionPermitV2
  readonly canonicalPayloadJsonUtf8: Uint8Array
  readonly permitJsonUtf8: Uint8Array
}

export interface ExecutionSidecarTransport {
  execute(
    request: ExecutionSidecarTransportRequest,
    options: { signal: AbortSignal },
  ): Promise<unknown>
}

export interface CreateExecutionSidecarWriterOptions {
  readonly mode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE'
  readonly signer: ExecutionPermitV2Signer
  readonly transport: ExecutionSidecarTransport
  readonly transportTimeoutMs: number
}

/**
 * Builds the paper-only command and submits it to exactly one sidecar transport.
 * This module has no native broker capability and never implements fallback.
 */
export function createExecutionSidecarWriter(
  options: CreateExecutionSidecarWriterOptions,
): AuthorizedBrokerWriter {
  const mode = z.enum(['PAPER_LOCAL', 'PAPER_EXCHANGE']).parse(options.mode)
  const transportTimeoutMs = z.number().int().positive().max(30_000)
    .parse(options.transportTimeoutMs)
  if (!options.signer || typeof options.signer.sign !== 'function') {
    throw new Error('execution_sidecar_signer_missing')
  }
  if (!options.transport || typeof options.transport.execute !== 'function') {
    throw new Error('execution_sidecar_transport_missing')
  }

  return {
    async placeOrder(request, authorization) {
      let context: Extract<BrokerWriteAuthorizationContext, { kind: 'execution_permit_v1' }>
      let v1Permit: ExecutionPermitV1
      let command: ExecutionCommandV1
      try {
        context = requireExecutionPermitContext(authorization)
        v1Permit = validateExecutionPermit(context.permit)
        assertV1ContextBinding(v1Permit, context.request, request)
        const payload = buildSubmitPayload(request, v1Permit, mode)
        command = buildExecutionCommandV1(payload)
      } catch (error) {
        return preSubmitRejected(error, 'execution_sidecar_authorization_or_request_invalid')
      }

      let permit: ExecutionPermitV2
      try {
        permit = validateExecutionPermitV2(await options.signer.sign({
          v1Permit,
          v1Request: context.request,
          payload: command.payload,
        }))
      } catch {
        return {
          kind: 'pre_submit_rejected',
          error: 'execution_sidecar_signing_failed',
        }
      }
      try {
        // Re-read all caller-owned mutable objects after the asynchronous signer
        // boundary before any transport can observe the command.
        assertV1ContextBinding(v1Permit, context.request, request)
        assertV2CommandBinding(permit, command, v1Permit)
      } catch (error) {
        return preSubmitRejected(error, 'execution_sidecar_signed_permit_invalid')
      }

      return executeTransport(
        options.transport,
        {
          command,
          permit,
          canonicalPayloadJsonUtf8: Buffer.from(
            stableStringify(command.payload),
            'utf8',
          ),
          permitJsonUtf8: Buffer.from(stableStringify(permit), 'utf8'),
        },
        transportTimeoutMs,
      )
    },

    async cancelOrder(_orderId, _authorization) {
      return {
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_cancel_unsupported',
      }
    },

    async adjustLeverage(_symbol, _newLeverage, _authorization) {
      return {
        kind: 'pre_submit_rejected',
        error: 'execution_sidecar_adjust_leverage_unsupported',
      }
    },
  }
}

function requireExecutionPermitContext(
  authorization: BrokerWriteAuthorizationContext,
): Extract<BrokerWriteAuthorizationContext, { kind: 'execution_permit_v1' }> {
  if (authorization.kind !== 'execution_permit_v1') {
    throw new Error('execution_sidecar_test_bypass_forbidden')
  }
  return authorization
}

function assertV1ContextBinding(
  permit: ExecutionPermitV1,
  request: ExecutionPermitRequest,
  order: CryptoPlaceOrderRequest,
): void {
  const expected: Array<[string, unknown, unknown]> = [
    ['intentId', permit.intentId, request.intentId],
    ['action', permit.action, request.action],
    ['riskReducing', permit.riskReducing, request.riskReducing],
    ['accountId', permit.accountId, request.accountId],
    ['accountMode', permit.accountMode, request.accountMode],
    ['symbol', permit.symbol, request.symbol],
    ['side', permit.side, request.side],
    ['notionalUsd', permit.notionalUsd, request.notionalUsd],
    ['ticketId', permit.ticketId, request.ticketId],
    ['idempotencyKey', permit.idempotencyKey, request.idempotencyKey],
    ['order.symbol', permit.symbol, order.symbol],
    ['order.side', permit.side, order.side],
    ['order.idempotencyKey', permit.idempotencyKey, order.idempotencyKey],
  ]
  for (const [field, left, right] of expected) {
    if (left !== right) throw new Error(`execution_sidecar_v1_context_mismatch:${field}`)
  }
  if (permit.accountMode !== 'paper_only') {
    throw new Error('execution_sidecar_live_permit_forbidden')
  }
  if (permit.action !== 'open' || permit.riskReducing) {
    throw new Error('execution_sidecar_only_open_nonreducing_permitted')
  }
  if (permit.symbol !== 'BTC/USDT' || permit.side !== 'buy') {
    throw new Error('execution_sidecar_mvp_scope_forbidden')
  }
  if (permit.notionalUsd === undefined) {
    throw new Error('execution_sidecar_notional_required')
  }
}

function buildSubmitPayload(
  request: CryptoPlaceOrderRequest,
  permit: ExecutionPermitV1,
  mode: 'PAPER_LOCAL' | 'PAPER_EXCHANGE',
) {
  if (request.symbol !== 'BTC/USDT') throw new Error('execution_sidecar_symbol_unsupported')
  if (request.side !== 'buy') throw new Error('execution_sidecar_side_unsupported')
  if (request.type !== 'limit') throw new Error('execution_sidecar_order_type_unsupported')
  if (request.reduceOnly !== undefined && request.reduceOnly !== false) {
    throw new Error('execution_sidecar_reduce_only_unsupported')
  }
  if (request.usd_size !== undefined) throw new Error('execution_sidecar_usd_size_ambiguous')
  if (request.leverage !== undefined && request.leverage !== 1) {
    throw new Error('execution_sidecar_leverage_unsupported')
  }
  const timeInForce = z.enum(['GTC', 'IOC', 'FOK']).safeParse(request.timeInForce)
  if (!timeInForce.success) throw new Error('execution_sidecar_time_in_force_required')
  const idempotencyKey = requiredCanonicalText(
    request.idempotencyKey,
    'execution_sidecar_idempotency_key_required',
    500,
  )
  const quantity = canonicalPositiveDecimal(request.size, 'execution_sidecar_quantity_invalid')
  const price = canonicalPositiveDecimal(request.price, 'execution_sidecar_price_invalid')
  const maxNotionalUsd = canonicalPositiveDecimal(
    permit.notionalUsd,
    'execution_sidecar_notional_invalid',
  )
  if (new Decimal(quantity).mul(price).gt(maxNotionalUsd)) {
    throw new Error('execution_sidecar_notional_exceeds_permit')
  }
  return {
    schemaVersion: EXECUTION_COMMAND_PAYLOAD_V1,
    kind: 'submit' as const,
    accountId: permit.accountId,
    canonicalSymbol: 'BTC/USDT' as const,
    venue: 'OKX' as const,
    venueInstrumentId: 'BTC-USDT' as const,
    idempotencyKey,
    mode,
    clientOrderId: deriveOkxClientOrderId(idempotencyKey),
    side: 'buy' as const,
    orderType: 'limit' as const,
    quantity,
    price,
    timeInForce: timeInForce.data,
    reduceOnly: false as const,
    maxNotionalUsd,
  }
}

function assertV2CommandBinding(
  permit: ExecutionPermitV2,
  command: ExecutionCommandV1,
  v1: ExecutionPermitV1,
): void {
  if (command.payload.kind !== 'submit') {
    throw new Error('execution_sidecar_submit_command_required')
  }
  const expected: Array<[string, unknown, unknown]> = [
    ['commandHash', permit.commandHash, command.commandId],
    ['action', permit.action, command.payload.kind],
    ['accountId', permit.accountId, command.payload.accountId],
    ['canonicalSymbol', permit.canonicalSymbol, command.payload.canonicalSymbol],
    ['venueInstrumentId', permit.venueInstrumentId, command.payload.venueInstrumentId],
    ['idempotencyKey', permit.idempotencyKey, command.payload.idempotencyKey],
    ['mode', permit.mode, command.payload.mode],
    ['side', permit.side, command.payload.side],
    ['riskReducing', permit.riskReducing, command.payload.reduceOnly],
    ['authorizedNotionalUsd', permit.authorizedNotionalUsd, command.payload.maxNotionalUsd],
    ['decisionId', permit.decisionId, v1.decisionId],
    ['candidateId', permit.candidateId, v1.candidateId],
    ['intentId', permit.intentId, v1.intentId],
    ['ticketId', permit.ticketId, v1.ticketId],
    ['sourceCommit', permit.sourceCommit, v1.sourceCommit],
    ['releaseManifestHash', permit.releaseManifestHash, v1.releaseManifestHash],
    ['authoritySnapshotHash', permit.authoritySnapshotHash, v1.authoritySnapshotHash],
    ['issuedAt', permit.issuedAt, v1.issuedAt],
    ['expiresAt', permit.expiresAt, v1.expiresAt],
    ['requiredChecks', stableStringify(permit.requiredChecks), stableStringify(v1.requiredChecks)],
    ['approvalRefs', stableStringify(permit.approvalRefs), stableStringify(v1.approvalRefs)],
  ]
  for (const [field, left, right] of expected) {
    if (left !== right) throw new Error(`execution_sidecar_v2_binding_mismatch:${field}`)
  }
}

async function executeTransport(
  transport: ExecutionSidecarTransport,
  request: ExecutionSidecarTransportRequest,
  timeoutMs: number,
): Promise<BrokerWriteOutcome<CryptoOrderResult>> {
  const controller = new AbortController()
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => transport.execute(request, { signal: controller.signal })),
      new Promise<typeof TIMEOUT>(resolve => {
        timeoutHandle = setTimeout(() => resolve(TIMEOUT), timeoutMs)
      }),
    ])
    if (response === TIMEOUT) {
      controller.abort()
      return submissionUnknown(
        request,
        `execution_sidecar_transport_timeout:${timeoutMs}ms`,
      )
    }
    const parsed = executionSidecarExecuteResponseSchema.safeParse(response)
    if (!parsed.success) {
      return submissionUnknown(request, 'execution_sidecar_response_invalid')
    }
    if (parsed.data.commandId !== request.command.commandId) {
      return submissionUnknown(request, 'execution_sidecar_response_command_mismatch')
    }
    if (parsed.data.disposition === 'accepted' || parsed.data.disposition === 'duplicate') {
      return {
        kind: 'command_accepted',
        commandId: request.command.commandId,
        permitV2Id: request.permit.permitId,
        acceptedSequence: parsed.data.acceptedSequence,
        clientOrderId: request.command.payload.kind === 'submit'
          ? request.command.payload.clientOrderId
          : undefined,
        message: `execution_sidecar_${parsed.data.disposition}:${parsed.data.acceptedSequence};broker_outcome_pending`,
      }
    }
    // Execute crossed the transport boundary.  Rejected, suspended, and
    // unavailable are command/admission dispositions, not authenticated broker
    // terminal evidence, so all three remain unresolved until reconciliation.
    return submissionUnknown(
      request,
      `execution_sidecar_${parsed.data.disposition}:${parsed.data.reason}`,
    )
  } catch (error) {
    controller.abort()
    return submissionUnknown(
      request,
      `execution_sidecar_transport_error:${transportErrorClass(error)}`,
    )
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
  }
}

function canonicalPositiveDecimal(value: unknown, errorCode: string): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(errorCode)
  }
  const canonical = new Decimal(value.toString()).toFixed()
  if (canonical.length > 50) throw new Error(errorCode)
  return canonical
}

function requiredCanonicalText(
  value: unknown,
  errorCode: string,
  maximum: number,
): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maximum) {
    throw new Error(errorCode)
  }
  return value
}

function transportErrorClass(error: unknown): string {
  if (error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(error.name)) {
    return error.name
  }
  return 'UnknownError'
}

function submissionUnknown(
  request: ExecutionSidecarTransportRequest,
  error: string,
): Extract<BrokerWriteOutcome<never>, { kind: 'submission_unknown' }> {
  return {
    kind: 'submission_unknown',
    error,
    commandId: request.command.commandId,
    permitV2Id: request.permit.permitId,
    clientOrderId: request.command.payload.kind === 'submit'
      ? request.command.payload.clientOrderId
      : undefined,
  }
}

function preSubmitRejected(
  error: unknown,
  fallback: string,
): Extract<BrokerWriteOutcome<never>, { kind: 'pre_submit_rejected' }> {
  const message = error instanceof Error ? error.message : ''
  return {
    kind: 'pre_submit_rejected',
    error: /^execution_sidecar_[A-Za-z0-9_.:-]{1,180}$/.test(message)
      ? message
      : fallback,
  }
}
