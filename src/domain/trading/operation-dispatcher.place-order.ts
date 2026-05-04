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

interface PlaceOrderExecutorDeps {
  engine: ICryptoTradingEngine
  options: CryptoOperationDispatcherOptions
  withPlaceOrderLock: <T>(task: () => Promise<T>) => Promise<T>
}

interface PlaceOrderExecutionResult {
  outcome: OperationOutcome
  walletResult: unknown
}

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
        clientOrderId: cap?.supportsClientOrderId
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
          kind: 'executed'
          riskContext?: RiskCheckContext
          riskResult: RiskCheckResult
          orderResult: CryptoOrderResult
          riskCheckedAtMs: number
          brokerSubmittedAtMs: number
        }

    let lockedExecution: LockedExecution
    let lastRiskCheckedAtMs: number | undefined
    let lastBrokerSubmittedAtMs: number | undefined
    let lastRiskDecision: ExecutionTelemetry['riskDecision'] = 'rejected'
    let lastRiskReason: string | null = null
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
          const brokerSubmittedAtMs = Date.now()
          lastBrokerSubmittedAtMs = brokerSubmittedAtMs
          const orderResult = await withTimeout(
            `broker place order ${effectiveRequest.symbol}`,
            operationTimeoutMs,
            () => engine.placeOrder(effectiveRequest),
          )
          return {
            kind: 'executed',
            riskContext,
            riskResult,
            orderResult,
            riskCheckedAtMs,
            brokerSubmittedAtMs,
          }
        },
      )
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
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
          })
          .catch(logErr => {
            warnOnAncillaryFailure('eventLog.append.execution.timeout', logErr, {
              commitId,
              opIndex,
              intentId,
            })
          })
      }
      await finalizeIdempotency('failed', undefined, error)
      await recordIntentFailureEnsuringIntent(error, strategySummary, effectiveRequest, executionTelemetry)
      return failWithStrategy(error, strategySummary)
    }

    const riskContext = lockedExecution.riskContext
    const riskResult = lockedExecution.riskResult
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
        typeof lockedExecution.orderResult.firstFillAtMs === 'number'
          ? lockedExecution.orderResult.firstFillAtMs - signalTimestampMs
          : null,
      signalToCompletedMs:
        signalTimestampMs != null &&
        typeof lockedExecution.orderResult.completedAtMs === 'number'
          ? lockedExecution.orderResult.completedAtMs - signalTimestampMs
          : null,
      dispatchToFirstFillMs:
        typeof lockedExecution.orderResult.firstFillAtMs === 'number'
          ? lockedExecution.orderResult.firstFillAtMs -
            lockedExecution.brokerSubmittedAtMs
          : null,
      dispatchToCompletedMs:
        typeof lockedExecution.orderResult.completedAtMs === 'number'
          ? lockedExecution.orderResult.completedAtMs -
            lockedExecution.brokerSubmittedAtMs
          : null,
      partialFillRatio:
        typeof lockedExecution.orderResult.filledSize === 'number' &&
        typeof lockedExecution.orderResult.requestedSize === 'number' &&
        lockedExecution.orderResult.requestedSize > 0
          ? lockedExecution.orderResult.filledSize /
            lockedExecution.orderResult.requestedSize
          : null,
      riskDecision: 'approved',
      riskReason: null,
      forcedRetryIdempotency: forceRetryIdempotency,
    }
    const orderResult = {
      ...lockedExecution.orderResult,
      strategy: strategySummary,
      executionTelemetry,
    }

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
