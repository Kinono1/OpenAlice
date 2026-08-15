import { randomUUID } from 'node:crypto'
import { isOperationTimeoutError, withTimeout } from '../../core/timeout.js'
import type {
  CryptoOrderResult,
  CryptoPlaceOrderRequest,
  ExecutionTelemetry,
  ICryptoTradingEngine,
  RiskCheckContext,
  RiskCheckResult,
} from './operation-dispatcher.types.js'
import type { Operation } from './operation-dispatcher.types.js'
import { preTradeRiskCheck } from './risk.js'
import type {
  CryptoOperationDispatcherOptions,
  OperationOutcome,
  SlippageConfig,
} from './operation-dispatcher.types.js'
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  DEFAULT_SLIPPAGE,
  asTrimmedString,
  checkSlippage,
  estimateExpectedPrice,
  resolveIdempotencyKey,
  safeRunAfterHook,
  sanitizeIdempotencyRecord,
  toWalletOrderStatus,
} from './operation-dispatcher.helpers.js'
import { getPrefetchedRiskState } from './prefetched-state.js'
import { getExchangeCapability, getIdempotencyPolicy } from './exchange-capabilities.js'
import {
  evaluateProductionRiskPreflight,
  productionRiskPreflightError,
} from './production-risk-preflight.js'
import {
  authorizeBrokerWrite,
  recordExecutionReceipt,
  type BrokerWriteAuthorizationInput,
} from './operation-dispatcher.execution-gate.js'
import type { ExecutionPermitV1 } from './execution-permit.js'
import { deriveOkxClientOrderId } from './execution-protocol.js'
import type {
  AuthorizedBrokerWriter,
  BrokerWriteOutcome,
  BrokerWriteRoute,
} from './broker-write-router.js'
import { constrainBrokerWriteOutcomeToRoute } from './broker-write-router.js'

interface PlaceOrderExecutorDeps {
  engine: ICryptoTradingEngine
  options: CryptoOperationDispatcherOptions
  withPlaceOrderLock: <T>(task: () => Promise<T>) => Promise<T>
  writer: AuthorizedBrokerWriter
  brokerWriteRoute: BrokerWriteRoute
  poisonPlaceOrderCircuit: () => void
  placeOrderCircuitOpenError: string
}

interface PlaceOrderExecutionResult {
  outcome: OperationOutcome
  walletResult: unknown
}

const SIDECAR_BROKER_OUTCOME_PENDING = 'broker_outcome_pending'
const SIDECAR_PRE_SUBMIT_REJECTED = 'execution_sidecar_pre_submit_rejected'
const SIDECAR_SUBMISSION_UNKNOWN = 'execution_sidecar_submission_unknown'

function warnOnAncillaryFailure(
  action: string,
  err: unknown,
  meta?: Record<string, unknown>,
): void {
  console.warn(
    `[crypto-dispatcher] ${action} failed`,
    meta ?? {},
    err instanceof Error ? err.message : err,
  )
}

export function createPlaceOrderExecutor({
  engine,
  options,
  withPlaceOrderLock,
  writer,
  brokerWriteRoute,
  poisonPlaceOrderCircuit,
  placeOrderCircuitOpenError,
}: PlaceOrderExecutorDeps) {
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS

  return async function executePlaceOrder(
    op: Operation,
    opIndex: number,
    commitId: string,
  ): Promise<PlaceOrderExecutionResult> {
    const dispatcherStartedAtMs = Date.now()
    const signalTimestampMs =
      typeof op.params.signalTimestampMs === 'number' &&
      Number.isFinite(op.params.signalTimestampMs) &&
      op.params.signalTimestampMs > 0
        ? op.params.signalTimestampMs
        : undefined
    const ticketId = (op.params.ticketId as string) ?? ''
    const intentId = randomUUID()
    const contextId = undefined

    const req: CryptoPlaceOrderRequest = {
      symbol: op.params.symbol as string,
      side: op.params.side as 'buy' | 'sell',
      type: op.params.type as 'market' | 'limit',
      lane: op.params.lane as string | undefined,
      size: op.params.size as number | undefined,
      usd_size: op.params.usd_size as number | undefined,
      price: op.params.price as number | undefined,
      timeInForce: op.params.timeInForce as CryptoPlaceOrderRequest['timeInForce'],
      leverage: op.params.leverage as number | undefined,
      reduceOnly: op.params.reduceOnly as boolean | undefined,
    }
    const idempotencyKey = resolveIdempotencyKey(op, req, ticketId)
    const forceRetryIdempotency = Boolean(op.params.forceRetryIdempotency)
    const retryReason = asTrimmedString(op.params.retryReason)
    const retryApprovedBy = asTrimmedString(op.params.retryApprovedBy)
    const retryApprovalTicketId = asTrimmedString(
      op.params.retryApprovalTicketId,
    )
    const prefetchedState = getPrefetchedRiskState(op)
    const prefetchedPositions = prefetchedState?.positions
    const prefetchedAccount = prefetchedState?.account
    let strategySummary: NonNullable<CryptoOrderResult['strategy']> | undefined
    let expectedPrice: number | undefined
    let ticketValidated = false
    let killSwitchPassed = false
    let riskReductionProven = false
    if (idempotencyKey) {
      req.idempotencyKey = idempotencyKey
    }
    let idempotencyReserved = false

    async function finalizeIdempotency(
      status: 'succeeded' | 'failed',
      result?: CryptoOrderResult,
      error?: string,
    ): Promise<void> {
      if (!idempotencyReserved || !idempotencyKey || !options.idempotencyStore) {
        return
      }
      await options.idempotencyStore
        .finalize({
          key: idempotencyKey,
          status,
          orderId: result?.orderId,
          error: error ?? result?.error,
        })
        .catch(err => {
          warnOnAncillaryFailure('idempotency.finalize', err, {
            key: idempotencyKey,
            status,
            intentId,
          })
        })
    }

    async function markUnresolvedAfterSidecarWrite(
      input: {
        key: string
        error: string
        symbol: string
        ticketId: string
        commandId?: string
        permitV2Id?: string
        clientOrderId?: string
        acceptedSequence?: string
      },
      action: string,
    ): Promise<boolean> {
      if (!options.idempotencyStore) {
        return true
      }
      try {
        await options.idempotencyStore.markUnresolved(input)
        return true
      } catch (idempotencyError) {
        poisonPlaceOrderCircuit()
        warnOnAncillaryFailure(action, new Error('idempotency_persistence_failed'), {
          intentId,
          opIndex,
          idempotencyKey: input.key,
          placeOrderCircuit: 'opened',
        })
        return false
      }
    }

    const fail = (error: string): PlaceOrderExecutionResult => ({
      outcome: { opIndex, ticketId, intentId, status: 'failed', error },
      walletResult: { success: false, error },
    })

    const failWithStrategy = (
      error: string,
      strategy?: NonNullable<CryptoOrderResult['strategy']>,
    ): PlaceOrderExecutionResult => ({
      outcome: {
        opIndex,
        ticketId,
        intentId,
        status: 'failed',
        error,
        result: strategy
          ? { success: false, error, strategy }
          : undefined,
      },
      walletResult: strategy
        ? { success: false, error, strategy }
        : { success: false, error },
    })

    let intentRecorded = false
    async function recordIntentIfNeeded(
      currentRequest: CryptoPlaceOrderRequest = req,
      strategy: NonNullable<CryptoOrderResult['strategy']> | undefined = strategySummary,
    ): Promise<void> {
      if (intentRecorded || !options.intentLedger) {
        return
      }
      const cap = options.exchangeId
        ? getExchangeCapability(options.exchangeId)
        : undefined
      await options.intentLedger.recordIntent({
        intentId,
        ticketId,
        symbol: req.symbol,
        action: op.action,
        side: currentRequest.side,
        type: currentRequest.type,
        size: currentRequest.size,
        usdSize: currentRequest.usd_size,
        requestedSize: req.size,
        requestedUsdSize: req.usd_size,
        price: currentRequest.price,
        reduceOnly: currentRequest.reduceOnly,
        leverage: currentRequest.leverage,
        contextId,
        exchangeId: options.exchangeId,
        idempotencyKey,
        brokerWriteRoute,
        clientOrderId: brokerWriteRoute === 'sidecar' && idempotencyKey
          ? deriveOkxClientOrderId(idempotencyKey)
          : cap?.supportsClientOrderId
            ? (idempotencyKey ?? intentId)
            : undefined,
        createdAt: Date.now(),
        strategy,
        signalTimestampMs,
        dispatcherStartedAtMs,
        expectedPrice,
        forcedRetryIdempotency: forceRetryIdempotency,
      })
      intentRecorded = true
    }

    async function recordIntentFailureEnsuringIntent(
      error: string,
      strategy?: NonNullable<CryptoOrderResult['strategy']>,
      currentRequest: CryptoPlaceOrderRequest = req,
      executionTelemetry?: ExecutionTelemetry,
    ): Promise<void> {
      await recordIntentIfNeeded(currentRequest, strategy)
      await recordIntentFailure(options, intentId, error, strategy, executionTelemetry)
    }

    const preflight = evaluateProductionRiskPreflight(
      {
        lane: typeof req.lane === 'string' ? req.lane : null,
        symbol: typeof req.symbol === 'string' ? req.symbol : null,
        side: typeof req.side === 'string' ? req.side : null,
        leverage: typeof req.leverage === 'number' && Number.isFinite(req.leverage)
          ? req.leverage
          : null,
        requestedAction: req.reduceOnly ? 'position_mutation' : 'paper_order',
        decisionTime: new Date(dispatcherStartedAtMs).toISOString(),
        sourcePath: 'operation-dispatcher.place-order',
        riskReducing: req.reduceOnly === true,
      },
      options.productionRiskPreflightPolicy,
    )
    if (!preflight.allowed) {
      const error = productionRiskPreflightError(preflight)
      await options.eventLog
        ?.append('risk.rejected', {
          commitId,
          opIndex,
          intentId,
          symbol: req.symbol,
          reason: 'production_risk_preflight',
          decision: preflight.decision,
          reasonCodes: preflight.reasonCodes,
          matchedRules: preflight.matchedRules,
          auditId: preflight.auditId,
          requestedLeverage: req.leverage,
          lane: req.lane,
        })
        .catch(err => {
          warnOnAncillaryFailure('eventLog.append.risk.rejected.production_risk_preflight', err, {
            commitId,
            opIndex,
            intentId,
          })
        })
      await recordIntentFailureEnsuringIntent(error, strategySummary)
      return failWithStrategy(error, strategySummary)
    }

    if (req.reduceOnly) {
      const positions = prefetchedPositions ?? await engine.getPositions()
      const position = positions.find(item => item.symbol === req.symbol)
      const requestedSize = typeof req.size === 'number' && Number.isFinite(req.size)
        ? req.size
        : undefined
      const expectedSide = position?.side === 'long'
        ? 'sell'
        : position?.side === 'short'
          ? 'buy'
          : null
      const invalidReason = (() => {
        if (!position || position.size <= 0) {
          return 'missing_position'
        }
        if (expectedSide !== req.side) {
          return `wrong_side:${req.side}_does_not_reduce_${position.side}`
        }
        if (requestedSize !== undefined && requestedSize > position.size) {
          return `size_exceeds_position:${requestedSize}>${position.size}`
        }
        if (requestedSize === undefined && (typeof req.usd_size === 'number' && req.usd_size > 0)) {
          return 'usd_size_not_allowed_for_verified_reduce_only'
        }
        return null
      })()
      if (invalidReason) {
        const reasonCode = 'p0_reduce_only_unverified'
        const error = `SECURITY: ${reasonCode}: reduceOnly order is not verified as risk-reducing (${invalidReason})`
        await options.eventLog
          ?.append('risk.rejected', {
            commitId,
            opIndex,
            intentId,
            symbol: req.symbol,
            reason: 'unverified_reduce_only',
            reasonCode,
            reduceOnlyReason: invalidReason,
            requestedSide: req.side,
            requestedSize,
            positionSide: position?.side,
            positionSize: position?.size,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.risk.rejected.reduce_only_unverified', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(error, strategySummary)
        return failWithStrategy(error, strategySummary)
      }
      riskReductionProven = true
    }

    if (options.killSwitch) {
      const ksResult = options.killSwitch.check(req.symbol, !!req.reduceOnly, false)
      if (ksResult.blocked) {
        const error = `kill-switch: ${ksResult.reason ?? 'blocked'}`
        await options.eventLog
          ?.append('kill-switch.blocked', {
            commitId,
            opIndex,
            symbol: req.symbol,
            reason: ksResult.reason,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.kill-switch.blocked', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(error, strategySummary)
        return failWithStrategy(error, strategySummary)
      }
      killSwitchPassed = true
    }

    if (options.ticketStore?.isRequired() && !ticketId) {
      const error = 'ticket: missing required decision ticket'
      await options.eventLog
        ?.append('ticket.skipped', {
          commitId,
          opIndex,
          reason: 'no-ticket-id',
          required: true,
        })
        .catch(err => {
          warnOnAncillaryFailure('eventLog.append.ticket.skipped', err, {
            commitId,
            opIndex,
            intentId,
          })
        })
      await recordIntentFailureEnsuringIntent(error, strategySummary)
      return failWithStrategy(error, strategySummary)
    }
    if (options.ticketStore && ticketId) {
      const ticketResult = options.ticketStore.validate(
        ticketId,
        req.symbol,
        op.action,
      )
      if (!ticketResult.valid) {
        const error = `ticket: ${ticketResult.reason ?? 'invalid'}`
        await options.eventLog
          ?.append('ticket.rejected', {
            commitId,
            opIndex,
            ticketId,
            reason: ticketResult.reason,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.ticket.rejected', err, {
              commitId,
              opIndex,
              ticketId,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(error)
        return fail(error)
      }
      ticketValidated = true
    }

    if (options.exchangeId) {
      const idempPolicy = getIdempotencyPolicy(
        options.exchangeId,
        !!req.reduceOnly,
      )
      if (!idempPolicy.allowed) {
        const error = `idempotency: ${idempPolicy.warning ?? 'rejected'}`
        await options.eventLog
          ?.append('idempotency.rejected', {
            commitId,
            opIndex,
            exchangeId: options.exchangeId,
            warning: idempPolicy.warning,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.idempotency.rejected', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(error)
        return fail(error)
      }
      if (idempPolicy.warning) {
        await options.eventLog
          ?.append('idempotency.warning', {
            commitId,
            opIndex,
            exchangeId: options.exchangeId,
            warning: idempPolicy.warning,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.idempotency.warning', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
      }
    }

    expectedPrice = await estimateExpectedPrice(req, op, options)
    const prepared = await options.preparePlaceOrder?.({
      operation: op,
      request: req,
      expectedPrice,
    })
    const effectiveRequest = prepared?.request
      ? {
          ...req,
          ...prepared.request,
        }
      : req
    strategySummary = prepared?.strategy
    if (prepared?.strategy) {
      await options.eventLog
        ?.append('strategy.prepare', {
          commitId,
          opIndex,
          intentId,
          symbol: req.symbol,
          mode: prepared.strategy.mode,
          actionStatus: prepared.strategy.actionStatus,
          requestedNotionalUsd: prepared.strategy.requestedNotionalUsd,
          recommendedNotionalUsd: prepared.strategy.recommendedNotionalUsd,
          effectiveNotionalUsd: prepared.strategy.effectiveNotionalUsd,
          fallbackReason: prepared.strategy.fallbackReason,
        })
        .catch(err => {
          warnOnAncillaryFailure('eventLog.append.strategy.prepare', err, {
            commitId,
            opIndex,
            intentId,
          })
        })
    }
    await recordIntentIfNeeded(effectiveRequest, strategySummary)
    if (prepared && !prepared.approved) {
      const error = `strategy: ${prepared.reason ?? 'rejected'}`
      await options.onRiskRejected?.({
        operation: op,
        request: effectiveRequest,
        reason: prepared.reason ?? 'strategy prepare hook rejected order',
        details: prepared.details,
      })
      await recordIntentFailureEnsuringIntent(error, strategySummary, effectiveRequest)
      return failWithStrategy(error, strategySummary)
    }
    const preGate = await options.beforePlaceOrderGate?.({
      operation: op,
      request: effectiveRequest,
      expectedPrice,
      strategy: strategySummary,
    })
    if (preGate && !preGate.approved) {
      const error = `pre-gate: ${preGate.reason ?? 'rejected'}`
      await options.onRiskRejected?.({
        operation: op,
        request: effectiveRequest,
        reason: preGate.reason ?? 'pre-place-order gate rejected order',
        details: preGate.details,
      })
      await recordIntentFailureEnsuringIntent(error, strategySummary, effectiveRequest)
      return failWithStrategy(error, strategySummary)
    }

    if (forceRetryIdempotency) {
      if (!retryReason) {
        const error =
          'idempotency: forceRetryIdempotency requires non-empty retryReason'
        await options.eventLog
          ?.append('idempotency.retry_rejected', {
            commitId,
            opIndex,
            key: idempotencyKey,
            reason: 'missing-retry-reason',
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.idempotency.retry_rejected', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(error)
        return fail(error)
      }

      if (options.ticketStore) {
        if (!retryApprovalTicketId) {
          const error =
            'idempotency: forceRetryIdempotency requires retryApprovalTicketId when ticketStore is enabled'
          await options.eventLog
            ?.append('idempotency.retry_rejected', {
              commitId,
              opIndex,
              key: idempotencyKey,
              reason: 'missing-retry-approval-ticket',
            })
            .catch(err => {
              warnOnAncillaryFailure('eventLog.append.idempotency.retry_rejected', err, {
                commitId,
                opIndex,
                intentId,
              })
            })
          await recordIntentFailureEnsuringIntent(error, strategySummary)
          return failWithStrategy(error, strategySummary)
        }
        const retryTicketResult = options.ticketStore.validate(
          retryApprovalTicketId,
          req.symbol,
          op.action,
        )
        if (!retryTicketResult.valid) {
          const error = `idempotency: retry approval ticket invalid (${retryTicketResult.reason ?? 'invalid'})`
          await options.eventLog
            ?.append('idempotency.retry_rejected', {
              commitId,
              opIndex,
              key: idempotencyKey,
              reason: 'invalid-retry-approval-ticket',
              ticketId: retryApprovalTicketId,
              ticketValidationReason: retryTicketResult.reason,
            })
            .catch(err => {
              warnOnAncillaryFailure('eventLog.append.idempotency.retry_rejected', err, {
                commitId,
                opIndex,
                intentId,
              })
            })
          await recordIntentFailureEnsuringIntent(error, strategySummary)
          return failWithStrategy(error, strategySummary)
        }
      }
    }

    if (idempotencyKey && options.idempotencyStore) {
      let reservation
      try {
        reservation = await options.idempotencyStore.reserve({
          key: idempotencyKey,
          symbol: req.symbol,
          ticketId: ticketId || undefined,
          allowRetryOnFailed: forceRetryIdempotency,
        })
      } catch (err) {
        const error =
          err instanceof Error
            ? `idempotency: reserve failed (${err.message})`
            : `idempotency: reserve failed (${String(err)})`
        await recordIntentFailureEnsuringIntent(error, strategySummary)
        return failWithStrategy(error, strategySummary)
      }
      if (reservation && !reservation.acquired) {
        const prev = reservation.record
        const duplicateError = `idempotency: duplicate key ${idempotencyKey} (status=${prev.status}${prev.orderId ? `, orderId=${prev.orderId}` : ''})`
        await options.eventLog
          ?.append('idempotency.duplicate', {
            commitId,
            opIndex,
            key: idempotencyKey,
            previous: sanitizeIdempotencyRecord(prev),
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.idempotency.duplicate', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
        await recordIntentFailureEnsuringIntent(duplicateError, strategySummary)
        return failWithStrategy(duplicateError, strategySummary)
      }
      if (reservation?.acquired) {
        idempotencyReserved = true
        if (reservation.retriedFromFailed) {
          await options.eventLog
            ?.append('idempotency.retry_override', {
              commitId,
              opIndex,
              key: idempotencyKey,
              retryReason,
              retryApprovedBy,
              retryApprovalTicketId,
            })
            .catch(err => {
              warnOnAncillaryFailure('eventLog.append.idempotency.retry_override', err, {
                commitId,
                opIndex,
                intentId,
              })
            })
        }
      }
    }

    type LockedExecution =
      | {
          kind: 'risk_rejected'
          riskContext?: RiskCheckContext
          riskResult: RiskCheckResult
          riskCheckedAtMs: number
        }
      | {
          kind: 'permit_rejected'
          riskContext?: RiskCheckContext
          riskResult: RiskCheckResult
          riskCheckedAtMs: number
          reasonCodes: string[]
        }
      | {
          kind: 'executed'
          riskContext?: RiskCheckContext
          riskResult: RiskCheckResult
          brokerOutcome: BrokerWriteOutcome<CryptoOrderResult>
          riskCheckedAtMs: number
          brokerSubmittedAtMs: number
          permit: ExecutionPermitV1 | null
          unresolvedPersisted?: boolean
        }

    let lockedExecution: LockedExecution
    let lastRiskCheckedAtMs: number | undefined
    let lastBrokerSubmittedAtMs: number | undefined
    let lastRiskDecision: ExecutionTelemetry['riskDecision'] = 'rejected'
    let lastRiskReason: string | null = null
    let lastPermit: ExecutionPermitV1 | null = null
    let sidecarUnresolvedPersistenceHandled = false
    let sidecarUnresolvedPersisted = true
    try {
      lockedExecution = await withPlaceOrderLock<LockedExecution>(
        async (): Promise<LockedExecution> => {
          const baseRiskContext = await options.getRiskContext?.()
          const riskContext: RiskCheckContext | undefined = baseRiskContext
            ? {
                ...baseRiskContext,
                positions: prefetchedPositions ?? baseRiskContext.positions,
                account: prefetchedAccount ?? baseRiskContext.account,
              }
            : prefetchedPositions || prefetchedAccount
              ? {
                  positions: prefetchedPositions,
                  account: prefetchedAccount,
                }
              : undefined
          const riskResult = await withTimeout(
            `risk check ${effectiveRequest.symbol}`,
            operationTimeoutMs,
            () => preTradeRiskCheck(
              engine,
              effectiveRequest,
              options.riskConfig,
              riskContext,
            ),
          )
          const riskCheckedAtMs = Date.now()
          lastRiskCheckedAtMs = riskCheckedAtMs

          if (!riskResult.approved) {
            lastRiskDecision = 'rejected'
            lastRiskReason = riskResult.reason ?? null
            return { kind: 'risk_rejected', riskContext, riskResult, riskCheckedAtMs }
          }

          lastRiskDecision = 'approved'
          lastRiskReason = null
          const authorizationInput = buildPlaceOrderAuthorizationInput({
            op,
            request: effectiveRequest,
            intentId,
            ticketId,
            idempotencyKey: idempotencyKey ?? '',
            expectedPrice,
            ticketValidated,
            idempotencyReserved,
            killSwitchPassed,
            riskReductionProven,
          })
          const authorization = await authorizeBrokerWrite(
            engine,
            options,
            authorizationInput,
          )
          if (!authorization.allowed) {
            lastRiskDecision = 'rejected'
            lastRiskReason = authorization.reasonCodes.join(',')
            return {
              kind: 'permit_rejected',
              riskContext,
              riskResult,
              riskCheckedAtMs,
              reasonCodes: authorization.reasonCodes,
            }
          }
          lastPermit = authorization.context.kind === 'execution_permit_v1'
            ? authorization.context.permit
            : null
          const brokerSubmittedAtMs = Date.now()
          lastBrokerSubmittedAtMs = brokerSubmittedAtMs
          let brokerOutcome: BrokerWriteOutcome<CryptoOrderResult>
          try {
            brokerOutcome = constrainBrokerWriteOutcomeToRoute(
              brokerWriteRoute,
              await withTimeout(
                `broker place order ${effectiveRequest.symbol}`,
                operationTimeoutMs,
                () => writer.placeOrder(effectiveRequest, authorization.context),
              ),
            )
          } catch (brokerError) {
            if (brokerWriteRoute === 'sidecar' && idempotencyKey && options.idempotencyStore) {
              sidecarUnresolvedPersistenceHandled = true
              sidecarUnresolvedPersisted = await markUnresolvedAfterSidecarWrite({
                key: idempotencyKey,
                error: SIDECAR_SUBMISSION_UNKNOWN,
                symbol: effectiveRequest.symbol,
                ticketId,
              }, 'idempotencyStore.markUnresolved.submission_unknown')
            }
            throw brokerError
          }
          let unresolvedPersisted: boolean | undefined
          if (
            brokerWriteRoute === 'sidecar'
            && brokerOutcome.kind !== 'broker_final'
            && brokerOutcome.kind !== 'pre_submit_rejected'
            && idempotencyKey
            && options.idempotencyStore
          ) {
            const unresolvedError = brokerOutcome.kind === 'command_accepted'
              ? SIDECAR_BROKER_OUTCOME_PENDING
              : SIDECAR_SUBMISSION_UNKNOWN
            sidecarUnresolvedPersistenceHandled = true
            sidecarUnresolvedPersisted = await markUnresolvedAfterSidecarWrite({
              key: idempotencyKey,
              error: unresolvedError,
              symbol: effectiveRequest.symbol,
              ticketId,
              commandId: brokerOutcome.commandId,
              permitV2Id: brokerOutcome.permitV2Id,
              clientOrderId: brokerOutcome.clientOrderId,
              acceptedSequence: brokerOutcome.kind === 'command_accepted'
                ? brokerOutcome.acceptedSequence
                : undefined,
            }, 'idempotencyStore.markUnresolved.broker_outcome')
            unresolvedPersisted = sidecarUnresolvedPersisted
          }
          return {
            kind: 'executed',
            riskContext,
            riskResult,
            brokerOutcome,
            riskCheckedAtMs,
            brokerSubmittedAtMs,
            permit: lastPermit,
            unresolvedPersisted,
          }
        },
      )
    } catch (err) {
      const rawError = err instanceof Error ? err.message : String(err)
      const error = brokerWriteRoute === 'sidecar' && lastBrokerSubmittedAtMs !== undefined
        ? SIDECAR_SUBMISSION_UNKNOWN
        : rawError
      const executionTelemetry: ExecutionTelemetry | undefined = isOperationTimeoutError(err)
        ? {
            signalTimestampMs,
            dispatcherStartedAtMs,
            riskCheckedAtMs: lastRiskCheckedAtMs,
            brokerSubmittedAtMs: lastBrokerSubmittedAtMs,
            expectedPrice,
            signalToDispatchMs:
              signalTimestampMs != null
                ? (lastBrokerSubmittedAtMs ?? lastRiskCheckedAtMs ?? Date.now()) - signalTimestampMs
                : null,
            riskDecision: lastRiskDecision,
            riskReason: lastRiskReason,
            forcedRetryIdempotency: forceRetryIdempotency,
            timeoutMs: err.timeoutMs,
            timeoutPhase: resolveTimeoutPhase(err.operationName),
          }
        : undefined
      if (executionTelemetry) {
        await options.eventLog
          ?.append('execution.timeout', {
            commitId,
            opIndex,
            intentId,
            symbol: req.symbol,
            error,
            executionTelemetry,
            brokerWriteRoute,
            brokerWriteOutcome: 'submission_unknown',
          })
          .catch(logErr => {
            warnOnAncillaryFailure('eventLog.append.execution.timeout', logErr, {
              commitId,
              opIndex,
              intentId,
            })
          })
      }
      if (brokerWriteRoute === 'sidecar' && lastBrokerSubmittedAtMs !== undefined) {
        const publicError = sidecarUnresolvedPersistenceHandled && !sidecarUnresolvedPersisted
          ? placeOrderCircuitOpenError
          : error
        await recordIntentIfNeeded(effectiveRequest, strategySummary)
        await options.intentLedger
          ?.recordResult({
            intentId,
            status: 'unknown',
            error: publicError,
            completedAt: Date.now(),
            strategy: strategySummary,
            executionTelemetry,
            brokerWriteRoute,
            brokerWriteOutcome: 'submission_unknown',
          })
          .catch(intentError => warnOnAncillaryFailure(
            'intentLedger.recordResult.submission_unknown',
            intentError,
            { intentId, opIndex },
          ))
        await options.eventLog
          ?.append('execution.submission_unknown', {
            commitId,
            opIndex,
            intentId,
            symbol: req.symbol,
            error: publicError,
            brokerWriteRoute,
            idempotencyKey,
            executionTelemetry,
          })
          .catch(logError => warnOnAncillaryFailure(
            'eventLog.append.execution.submission_unknown',
            logError,
            { commitId, opIndex, intentId },
          ))
        return {
          outcome: { opIndex, ticketId, intentId, status: 'unknown', error: publicError },
          walletResult: {
            success: false,
            error: publicError,
            unknown: true,
            brokerWriteOutcome: 'submission_unknown',
            ...(executionTelemetry ? { executionTelemetry } : {}),
            ...(strategySummary ? { strategy: strategySummary } : {}),
          },
        }
      }
      if (lastPermit) {
        await recordExecutionReceipt(
          options,
          buildPlaceOrderAuthorizationInput({
            op,
            request: effectiveRequest,
            intentId,
            ticketId,
            idempotencyKey: idempotencyKey ?? '',
            expectedPrice,
            ticketValidated,
            idempotencyReserved,
            killSwitchPassed,
            riskReductionProven,
          }),
          'broker_failed',
          [error],
          lastPermit,
        )
      }
      await finalizeIdempotency('failed', undefined, error)
      await recordIntentFailureEnsuringIntent(error, strategySummary, effectiveRequest, executionTelemetry)
      return failWithStrategy(error, strategySummary)
    }

    const riskContext = lockedExecution.riskContext
    const riskResult = lockedExecution.riskResult
    if (lockedExecution.kind === 'permit_rejected') {
      const error = `execution-permit: ${lockedExecution.reasonCodes.join(',')}`
      await finalizeIdempotency('failed', undefined, error)
      await recordIntentFailureEnsuringIntent(
        error,
        strategySummary,
        effectiveRequest,
      )
      return failWithStrategy(error, strategySummary)
    }
    if (lockedExecution.kind === 'risk_rejected') {
      const error = `risk: ${riskResult.reason ?? 'unknown reason'}`
      const executionTelemetry: ExecutionTelemetry = {
        signalTimestampMs,
        dispatcherStartedAtMs,
        riskCheckedAtMs: lockedExecution.riskCheckedAtMs,
        expectedPrice,
        signalToDispatchMs:
          signalTimestampMs != null
            ? lockedExecution.riskCheckedAtMs - signalTimestampMs
            : null,
        riskDecision: 'rejected',
        riskReason: riskResult.reason ?? null,
        forcedRetryIdempotency: forceRetryIdempotency,
      }
      await options.eventLog
        ?.append('risk.rejected', {
          commitId,
          opIndex,
          intentId,
          symbol: req.symbol,
          reason: riskResult.reason ?? 'risk gate rejected order',
          details: riskResult.details,
          executionTelemetry,
        })
        .catch(err => {
          warnOnAncillaryFailure('eventLog.append.risk.rejected', err, {
            commitId,
            opIndex,
            intentId,
          })
        })
      await options.onRiskRejected?.({
        operation: op,
        request: effectiveRequest,
        reason: riskResult.reason ?? 'risk gate rejected order',
        details: riskResult.details,
      })
      await finalizeIdempotency('failed', undefined, error)
      await recordIntentFailureEnsuringIntent(
        error,
        strategySummary,
        effectiveRequest,
        executionTelemetry,
      )
      return failWithStrategy(error, strategySummary)
    }
    const brokerOutcome = lockedExecution.brokerOutcome
    if (brokerOutcome.kind === 'pre_submit_rejected') {
      const error = brokerWriteRoute === 'sidecar'
        ? SIDECAR_PRE_SUBMIT_REJECTED
        : brokerOutcome.error || 'broker write rejected before submission'
      await finalizeIdempotency('failed', undefined, error)
      await recordIntentFailureEnsuringIntent(
        error,
        strategySummary,
        effectiveRequest,
      )
      await recordExecutionReceipt(
        options,
        buildPlaceOrderAuthorizationInput({
          op,
          request: effectiveRequest,
          intentId,
          ticketId,
          idempotencyKey: idempotencyKey ?? '',
          expectedPrice,
          ticketValidated,
          idempotencyReserved,
          killSwitchPassed,
          riskReductionProven,
        }),
        'rejected',
        [error],
        lockedExecution.permit,
      )
      return {
        outcome: { opIndex, ticketId, intentId, status: 'failed', error },
        walletResult: {
          success: false,
          error,
          brokerWriteOutcome: 'pre_submit_rejected',
          ...(strategySummary ? { strategy: strategySummary } : {}),
        },
      }
    }
    if (brokerOutcome.kind !== 'broker_final') {
      const error = brokerOutcome.kind === 'command_accepted'
        ? SIDECAR_BROKER_OUTCOME_PENDING
        : SIDECAR_SUBMISSION_UNKNOWN
      const unresolvedPersisted = lockedExecution.unresolvedPersisted ?? true
      await options.intentLedger
        ?.recordResult({
          intentId,
          status: 'unknown',
          error,
          completedAt: Date.now(),
          strategy: strategySummary,
          brokerWriteRoute,
          brokerWriteOutcome: brokerOutcome.kind,
          ...(brokerOutcome.commandId ? { commandId: brokerOutcome.commandId } : {}),
          ...(brokerOutcome.permitV2Id ? { permitV2Id: brokerOutcome.permitV2Id } : {}),
          ...(brokerOutcome.clientOrderId ? { clientOrderId: brokerOutcome.clientOrderId } : {}),
          ...(brokerOutcome.kind === 'command_accepted' && brokerOutcome.acceptedSequence
            ? { acceptedSequence: brokerOutcome.acceptedSequence }
            : {}),
        })
        .catch(err => warnOnAncillaryFailure('intentLedger.recordResult.unknown', err, { intentId, opIndex }))
      return {
        outcome: {
          opIndex,
          ticketId,
          intentId,
          status: 'unknown',
          error: unresolvedPersisted ? error : placeOrderCircuitOpenError,
        },
        walletResult: {
          success: false,
          error: unresolvedPersisted ? error : placeOrderCircuitOpenError,
          pending: unresolvedPersisted && brokerOutcome.kind === 'command_accepted',
          unknown: !unresolvedPersisted || brokerOutcome.kind === 'submission_unknown',
          brokerWriteOutcome: unresolvedPersisted
            ? brokerOutcome.kind
            : 'submission_unknown',
          ...(unresolvedPersisted && brokerOutcome.kind === 'command_accepted' && brokerOutcome.commandId
            ? { commandId: brokerOutcome.commandId }
            : {}),
          ...(brokerOutcome.permitV2Id ? { permitV2Id: brokerOutcome.permitV2Id } : {}),
          ...(brokerOutcome.clientOrderId ? { clientOrderId: brokerOutcome.clientOrderId } : {}),
          ...(brokerOutcome.kind === 'command_accepted' && brokerOutcome.acceptedSequence
            ? { acceptedSequence: brokerOutcome.acceptedSequence }
            : {}),
        },
      }
    }
    const executionTelemetry: ExecutionTelemetry = {
      signalTimestampMs,
      dispatcherStartedAtMs,
      riskCheckedAtMs: lockedExecution.riskCheckedAtMs,
      brokerSubmittedAtMs: lockedExecution.brokerSubmittedAtMs,
      expectedPrice,
      signalToDispatchMs:
        signalTimestampMs != null
          ? lockedExecution.brokerSubmittedAtMs - signalTimestampMs
          : null,
      signalToFirstFillMs:
        signalTimestampMs != null &&
        typeof brokerOutcome.result.firstFillAtMs === 'number'
          ? brokerOutcome.result.firstFillAtMs - signalTimestampMs
          : null,
      signalToCompletedMs:
        signalTimestampMs != null &&
        typeof brokerOutcome.result.completedAtMs === 'number'
          ? brokerOutcome.result.completedAtMs - signalTimestampMs
          : null,
      dispatchToFirstFillMs:
        typeof brokerOutcome.result.firstFillAtMs === 'number'
          ? brokerOutcome.result.firstFillAtMs -
            lockedExecution.brokerSubmittedAtMs
          : null,
      dispatchToCompletedMs:
        typeof brokerOutcome.result.completedAtMs === 'number'
          ? brokerOutcome.result.completedAtMs -
            lockedExecution.brokerSubmittedAtMs
          : null,
      partialFillRatio:
        typeof brokerOutcome.result.filledSize === 'number' &&
        typeof brokerOutcome.result.requestedSize === 'number' &&
        brokerOutcome.result.requestedSize > 0
          ? brokerOutcome.result.filledSize /
            brokerOutcome.result.requestedSize
          : null,
      riskDecision: 'approved',
      riskReason: null,
      forcedRetryIdempotency: forceRetryIdempotency,
    }
    const orderResult = {
      ...brokerOutcome.result,
      strategy: strategySummary,
      executionTelemetry,
    }

    await recordExecutionReceipt(
      options,
      buildPlaceOrderAuthorizationInput({
        op,
        request: effectiveRequest,
        intentId,
        ticketId,
        idempotencyKey: idempotencyKey ?? '',
        expectedPrice,
        ticketValidated,
        idempotencyReserved,
        killSwitchPassed,
        riskReductionProven,
      }),
      orderResult.success ? 'broker_succeeded' : 'broker_failed',
      orderResult.success ? [] : [orderResult.error ?? 'broker_order_failed'],
      lockedExecution.permit,
    )

    await safeRunAfterHook(options, {
      operation: op,
      request: effectiveRequest,
      expectedPrice,
      riskContext,
      strategy: strategySummary,
      result: orderResult,
    })

    if (orderResult.success && orderResult.filledPrice) {
      const slipCfg: SlippageConfig = options.slippageConfig
        ? { ...DEFAULT_SLIPPAGE, ...options.slippageConfig }
        : DEFAULT_SLIPPAGE
      const slipCheck = checkSlippage(
        expectedPrice,
        orderResult.filledPrice,
        req.side,
        !!req.reduceOnly,
        slipCfg,
      )
      if (!slipCheck.ok) {
        await options.eventLog
          ?.append('slippage.exceeded', {
            commitId,
            opIndex,
            intentId,
            symbol: req.symbol,
            expectedPrice,
            filledPrice: orderResult.filledPrice,
            slippagePct: slipCheck.slippagePct,
            limit: slipCheck.limit,
          })
          .catch(err => {
            warnOnAncillaryFailure('eventLog.append.slippage.exceeded', err, {
              commitId,
              opIndex,
              intentId,
            })
          })
      }
      orderResult.executionTelemetry = {
        ...orderResult.executionTelemetry,
        slippagePct: slipCheck.slippagePct,
        slippageBps:
          typeof slipCheck.slippagePct === 'number'
            ? slipCheck.slippagePct * 10_000
            : undefined,
        slippageLimitPct: slipCheck.limit,
      }
    }
    await options.eventLog
      ?.append('execution.telemetry', {
        commitId,
        opIndex,
        intentId,
        symbol: req.symbol,
        orderId: orderResult.orderId,
        success: orderResult.success,
        executionTelemetry: orderResult.executionTelemetry,
      })
      .catch(err => {
        warnOnAncillaryFailure('eventLog.append.execution.telemetry', err, {
          commitId,
          opIndex,
          intentId,
        })
      })

    if (options.intentLedger) {
      await options.intentLedger
        .recordResult({
          intentId,
          status: orderResult.success ? 'success' : 'failed',
          orderId: orderResult.orderId,
          filledPrice: orderResult.filledPrice,
          filledSize: orderResult.filledSize,
          error: orderResult.error,
          completedAt: Date.now(),
          strategy: strategySummary,
          executionTelemetry: orderResult.executionTelemetry,
        })
        .catch(err => {
          warnOnAncillaryFailure('intentLedger.recordResult', err, {
            intentId,
            opIndex,
          })
        })
    }

    if (!orderResult.success) {
      await finalizeIdempotency('failed', orderResult)
      return {
        outcome: {
          opIndex,
          ticketId,
          intentId,
          status: 'failed',
          result: orderResult,
          error: orderResult.error,
        },
        walletResult: {
          success: false,
          error: orderResult.error,
          executionTelemetry: orderResult.executionTelemetry,
          ...(strategySummary ? { strategy: strategySummary } : {}),
        },
      }
    }

    await finalizeIdempotency('succeeded', orderResult)

    return {
      outcome: {
        opIndex,
        ticketId,
        intentId,
        status: 'success',
        result: orderResult,
      },
      walletResult: {
        success: true,
        order: {
          id: orderResult.orderId,
          status: toWalletOrderStatus(orderResult),
          requestedSize: orderResult.requestedSize,
          remainingSize: orderResult.remainingSize,
          filledPrice: orderResult.filledPrice,
          filledQuantity: orderResult.filledSize,
          idempotencyKey: orderResult.idempotencyKey ?? idempotencyKey,
          firstFillAtMs: orderResult.firstFillAtMs,
          completedAtMs: orderResult.completedAtMs,
          executionTelemetry: orderResult.executionTelemetry,
          ...(strategySummary ? { strategy: strategySummary } : {}),
        },
        executionTelemetry: orderResult.executionTelemetry,
        ...(strategySummary ? { strategy: strategySummary } : {}),
      },
    }
  }
}

function buildPlaceOrderAuthorizationInput(input: {
  op: Operation
  request: CryptoPlaceOrderRequest
  intentId: string
  ticketId: string
  idempotencyKey: string
  expectedPrice?: number
  ticketValidated: boolean
  idempotencyReserved: boolean
  killSwitchPassed: boolean
  riskReductionProven: boolean
}): BrokerWriteAuthorizationInput {
  const completedChecks = ['risk_passed', 'limits_passed', 'slippage_policy_loaded']
  if (input.ticketValidated) completedChecks.push('ticket_valid')
  if (input.idempotencyReserved) completedChecks.push('idempotency_reserved')
  if (input.killSwitchPassed) completedChecks.push('kill_switch_passed')
  if (input.riskReductionProven) completedChecks.push('risk_reduction_proven')
  const riskReducing = input.request.reduceOnly === true
  return {
    intentId: input.intentId,
    action: input.op.action === 'closePosition'
      ? 'close'
      : riskReducing
        ? 'reduce'
        : 'open',
    riskReducing,
    symbol: input.request.symbol,
    side: input.request.side,
    notionalUsd: estimateOrderNotionalUsd(input.request, input.expectedPrice),
    ticketId: input.ticketId,
    idempotencyKey: input.idempotencyKey,
    completedChecks,
  }
}

function estimateOrderNotionalUsd(
  request: CryptoPlaceOrderRequest,
  expectedPrice?: number,
): number | undefined {
  if (
    typeof request.usd_size === 'number'
    && Number.isFinite(request.usd_size)
    && request.usd_size > 0
  ) {
    return request.usd_size
  }
  const price = request.price ?? expectedPrice
  if (
    typeof request.size === 'number'
    && Number.isFinite(request.size)
    && request.size > 0
    && typeof price === 'number'
    && Number.isFinite(price)
    && price > 0
  ) {
    return request.size * price
  }
  return undefined
}

function resolveTimeoutPhase(operationName: string): ExecutionTelemetry['timeoutPhase'] {
  if (operationName.startsWith('risk check')) {
    return 'risk_check'
  }
  if (operationName.startsWith('broker place order')) {
    return 'broker_submit'
  }
  if (operationName.startsWith('resolve close position')) {
    return 'close_position_resolution'
  }
  return 'simple_action'
}

async function recordIntentFailure(
  options: CryptoOperationDispatcherOptions,
  intentId: string,
  error: string,
  strategy?: NonNullable<CryptoOrderResult['strategy']>,
  executionTelemetry?: ExecutionTelemetry,
): Promise<void> {
  await options.intentLedger
    ?.recordResult({
      intentId,
      status: 'failed',
      error,
      completedAt: Date.now(),
      strategy,
      executionTelemetry,
    })
    .catch(err => {
      warnOnAncillaryFailure('intentLedger.recordResult.failure', err, {
        intentId,
      })
    })
}
