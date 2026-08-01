import { randomUUID } from 'node:crypto'
import type {
  ICryptoTradingEngine,
  Operation,
  SimpleActionResult,
} from './operation-dispatcher.types.js'
import type { RiskConfig } from './operation-dispatcher.types.js'
import type {
  CommitExecutorDeps,
  CommitOperation,
  CryptoOperationDispatcher,
  CryptoOperationDispatcherOptions,
  OperationOutcome,
  PushResult,
} from './operation-dispatcher.types.js'
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  normalizeDispatcherOptions,
} from './operation-dispatcher.helpers.js'
import { createPlaceOrderExecutor } from './operation-dispatcher.place-order.js'
import { cloneOperationWithPrefetchedRiskState } from './prefetched-state.js'
import {
  executeSimpleAction,
  resolveClosePositionOrder,
} from './operation-dispatcher.simple-actions.js'
import {
  authorizeBrokerWrite,
  recordExecutionReceipt,
  type BrokerWriteAuthorizationInput,
} from './operation-dispatcher.execution-gate.js'
import {
  evaluateProductionRiskPreflight,
  productionRiskPreflightError,
} from './production-risk-preflight.js'

export function createCryptoOperationDispatcher(
  engine: ICryptoTradingEngine,
  optionsOrRiskConfig?: CryptoOperationDispatcherOptions | RiskConfig,
): CryptoOperationDispatcher {
  const options = normalizeDispatcherOptions(optionsOrRiskConfig)
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const placeOrderLockTimeoutMs = operationTimeoutMs + 10_000 // lock timeout > operation timeout
  let placeOrderQueue: Promise<void> = Promise.resolve()

  async function withPlaceOrderLock<T>(task: () => Promise<T>): Promise<T> {
    const prev = placeOrderQueue
    let release!: () => void
    let queueTimedOut = false
    const queueTimeout = setTimeout(() => {
      queueTimedOut = true
      console.warn(`[crypto-dispatcher] place-order lock timed out after ${placeOrderLockTimeoutMs}ms — releasing`)
      release()
    }, placeOrderLockTimeoutMs)
    placeOrderQueue = new Promise<void>(resolve => {
      release = resolve
    })

    try {
      await prev
    } finally {
      clearTimeout(queueTimeout)
    }
    // If release already fired via timeout, the queue was reset — we can't proceed
    if (queueTimedOut) throw new Error('place-order lock queue timeout — previous operation did not complete')
    try {
      const result = await task()
      return result
    } finally {
      release()
    }
  }

  const executePlaceOrder = createPlaceOrderExecutor({
    engine,
    options,
    withPlaceOrderLock,
  })

  async function toExecutableOrderOperation(
    op: Operation,
  ): Promise<Operation | { error: string }> {
    if (op.action !== 'closePosition') {
      return op
    }

    const resolved = await resolveClosePositionOrder(engine, op, operationTimeoutMs)
    if ('error' in resolved) {
      return { error: resolved.error }
    }

    return cloneOperationWithPrefetchedRiskState(op, {
      ...op.params,
      ...resolved.request,
    })
  }

  async function executeAuthorizedSimpleAction(
    op: Operation,
  ): Promise<SimpleActionResult> {
    if (op.action === 'syncOrders') {
      return executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
      })
    }
    if (options.allowTestExecutionPermitBypass && process.env.NODE_ENV === 'test') {
      return executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
      })
    }

    const context = await resolveSimpleAuthorizationContext(engine, op)
    if ('error' in context) return { success: false, error: context.error }
    const intentId = randomUUID()
    const ticketId = typeof op.params.ticketId === 'string'
      ? op.params.ticketId.trim()
      : ''
    const idempotencyKey = typeof op.params.idempotencyKey === 'string'
      && op.params.idempotencyKey.trim()
      ? op.params.idempotencyKey.trim()
      : `${context.action}:${context.symbol}:${ticketId || 'missing-ticket'}`
    const authorizationInput: BrokerWriteAuthorizationInput = {
      intentId,
      action: context.action,
      riskReducing: context.riskReducing,
      symbol: context.symbol,
      side: context.side,
      ticketId,
      idempotencyKey,
      completedChecks: [],
    }

    if (!options.ticketStore || !ticketId) {
      const reason = 'ticket: missing required decision ticket'
      await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
      return { success: false, error: reason }
    }
    const ticketResult = options.ticketStore.validate(ticketId, context.symbol, op.action)
    if (!ticketResult.valid) {
      const reason = `ticket: ${ticketResult.reason ?? 'invalid'}`
      await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
      return { success: false, error: reason }
    }
    authorizationInput.completedChecks.push('ticket_valid')

    if (!options.idempotencyStore) {
      const reason = 'idempotency: store missing'
      await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
      return { success: false, error: reason }
    }
    const reservation = await options.idempotencyStore.reserve({
      key: idempotencyKey,
      symbol: context.symbol,
      ticketId,
    })
    if (!reservation.acquired) {
      const reason = `idempotency: duplicate key ${idempotencyKey}`
      await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
      return { success: false, error: reason }
    }
    authorizationInput.completedChecks.push('idempotency_reserved')

    const killSwitch = options.killSwitch?.check(
      context.symbol,
      context.riskReducing,
      context.action === 'cancel' && context.riskReducing,
    )
    if (!killSwitch || killSwitch.blocked) {
      const reason = `kill-switch: ${killSwitch?.reason ?? 'not configured'}`
      await options.idempotencyStore.finalize({
        key: idempotencyKey,
        status: 'failed',
        error: reason,
      })
      await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
      return { success: false, error: reason }
    }
    authorizationInput.completedChecks.push('kill_switch_passed')

    if (context.riskReducing) {
      authorizationInput.completedChecks.push('risk_reduction_proven')
    } else if (context.action === 'adjust_leverage') {
      const preflight = evaluateProductionRiskPreflight(
        {
          lane: typeof op.params.lane === 'string' ? op.params.lane : null,
          symbol: context.symbol,
          side: null,
          leverage: typeof op.params.newLeverage === 'number'
            ? op.params.newLeverage
            : null,
          requestedAction: 'adjust_leverage',
          decisionTime: new Date().toISOString(),
          sourcePath: 'operation-dispatcher.core.adjustLeverage',
        },
        options.productionRiskPreflightPolicy,
      )
      if (!preflight.allowed) {
        const reason = productionRiskPreflightError(preflight)
        await options.idempotencyStore.finalize({
          key: idempotencyKey,
          status: 'failed',
          error: reason,
        })
        await recordExecutionReceipt(options, authorizationInput, 'rejected', [reason])
        return { success: false, error: reason }
      }
      authorizationInput.completedChecks.push('risk_passed', 'limits_passed')
    }

    const authorization = await authorizeBrokerWrite(
      engine,
      options,
      authorizationInput,
    )
    if (!authorization.allowed) {
      const error = `execution-permit: ${authorization.reasonCodes.join(',')}`
      await options.idempotencyStore.finalize({
        key: idempotencyKey,
        status: 'failed',
        error,
      })
      return { success: false, error }
    }

    let result: SimpleActionResult
    try {
      result = await executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await options.idempotencyStore.finalize({
        key: idempotencyKey,
        status: 'failed',
        error: message,
      })
      await recordExecutionReceipt(
        options,
        authorizationInput,
        'broker_failed',
        [message],
        authorization.permit,
      )
      throw error
    }
    await options.idempotencyStore.finalize({
      key: idempotencyKey,
      status: result.success ? 'succeeded' : 'failed',
      error: result.error,
    })
    await recordExecutionReceipt(
      options,
      authorizationInput,
      result.success ? 'broker_succeeded' : 'broker_failed',
      result.success ? [] : [result.error ?? 'simple_action_failed'],
      authorization.permit,
    )
    return result
  }

  async function dispatch(op: Operation): Promise<unknown> {
    if (op.action === 'placeOrder' || op.action === 'closePosition') {
      const executableOp = await toExecutableOrderOperation(op)
      if ('error' in executableOp) {
        return { success: false, error: executableOp.error }
      }
      const commitId = randomUUID()
      const { walletResult } = await executePlaceOrder(executableOp, 0, commitId)
      return walletResult
    }
    try {
      return await executeAuthorizedSimpleAction(op)
    } catch (err) {
      if (op.action === 'cancelOrder' || op.action === 'adjustLeverage') {
        return {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      throw err
    }
  }

  async function push(
    commitId: string,
    operations: Operation[],
  ): Promise<PushResult> {
    const results: OperationOutcome[] = []
    let stopped = false

    await options.eventLog
      ?.append('commit.started', {
        commitId,
        operationCount: operations.length,
      })
      .catch((err) => {
        console.warn('[operation-dispatcher] Event log append failed:', err)
      })

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i]

      if (stopped) {
        results.push({
          opIndex: i,
          ticketId: (op.params.ticketId as string) ?? '',
          intentId: '',
          status: 'skipped',
        })
        continue
      }

      if (op.action === 'placeOrder' || op.action === 'closePosition') {
        try {
          const executableOp = await toExecutableOrderOperation(op)
          if ('error' in executableOp) {
            results.push({
              opIndex: i,
              ticketId: (op.params.ticketId as string) ?? '',
              intentId: '',
              status: 'failed',
              error: executableOp.error,
            })
            stopped = true
            continue
          }

          const { outcome } = await executePlaceOrder(executableOp, i, commitId)
          results.push(outcome)
          if (outcome.status === 'failed') {
            stopped = true
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err)
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? '',
            intentId: '',
            status: 'failed',
            error,
          })
          stopped = true
        }
        continue
      }

      if (options.killSwitch) {
        const symbol = (op.params.symbol as string) ?? ''
        if (symbol) {
          const ksResult = options.killSwitch.check(symbol, false, false)
          if (ksResult.blocked) {
            results.push({
              opIndex: i,
              ticketId: (op.params.ticketId as string) ?? '',
              intentId: '',
              status: 'failed',
              error: `kill-switch: ${ksResult.reason ?? 'blocked'}`,
            })
            stopped = true
            continue
          }
        }
      }

      try {
        const simpleResult = await executeAuthorizedSimpleAction(op)
        if (simpleResult && !simpleResult.success) {
          const error = simpleResult.error ?? 'operation failed'
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? '',
            intentId: '',
            status: 'failed',
            error,
          })
          stopped = true
        } else {
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? '',
            intentId: '',
            status: 'success',
          })
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        results.push({
          opIndex: i,
          ticketId: (op.params.ticketId as string) ?? '',
          intentId: '',
          status: 'failed',
          error,
        })
        stopped = true
      }
    }

    const summary = {
      succeeded: results.filter(r => r.status === 'success').length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    }

    await options.eventLog
      ?.append('commit.completed', {
        commitId,
        summary,
        operations: results,
      })
      .catch((err) => {
        console.warn('[operation-dispatcher] Event log commit.failed append failed:', err)
      })

    return { commitId, operations: results, summary }
  }

  const dispatcher = (async (op: Operation) =>
    dispatch(op)) as CryptoOperationDispatcher
  dispatcher.dispatch = dispatch
  dispatcher.push = push
  return dispatcher
}

async function resolveSimpleAuthorizationContext(
  engine: ICryptoTradingEngine,
  op: Operation,
): Promise<
  | {
      action: 'cancel' | 'adjust_leverage'
      symbol: string
      side?: 'buy' | 'sell'
      riskReducing: boolean
    }
  | { error: string }
> {
  if (op.action === 'cancelOrder') {
    const orderId = typeof op.params.orderId === 'string'
      ? op.params.orderId.trim()
      : ''
    if (!orderId) return { error: 'cancelOrder requires orderId' }
    const orders = await engine.getOrders()
    const order = orders.find((item) => item.id === orderId)
    if (!order) return { error: `cancelOrder could not resolve order ${orderId}` }
    return {
      action: 'cancel',
      symbol: order.symbol,
      side: order.side,
      riskReducing: order.reduceOnly !== true,
    }
  }
  if (op.action === 'adjustLeverage') {
    const symbol = typeof op.params.symbol === 'string'
      ? op.params.symbol.trim()
      : ''
    const newLeverage = typeof op.params.newLeverage === 'number'
      ? op.params.newLeverage
      : Number.NaN
    if (!symbol) return { error: 'adjustLeverage requires symbol' }
    const positions = await engine.getPositions()
    const position = positions.find((item) => item.symbol === symbol)
    return {
      action: 'adjust_leverage',
      symbol,
      riskReducing: Boolean(
        position
        && Number.isFinite(newLeverage)
        && newLeverage > 0
        && newLeverage <= position.leverage,
      ),
    }
  }
  return { error: `unsupported broker write action: ${op.action}` }
}

export async function executeCommit(
  operations: CommitOperation[],
  deps: CommitExecutorDeps,
): Promise<PushResult> {
  const options: CryptoOperationDispatcherOptions = {
    riskConfig: deps.riskConfig,
    getRiskContext: deps.getRiskContext,
    estimateExpectedPrice: deps.estimateExpectedPrice
      ? input => deps.estimateExpectedPrice!(input.request)
      : undefined,
    preparePlaceOrder: deps.preparePlaceOrder,
    ticketStore: deps.ticketStore,
    intentLedger: deps.intentLedger,
    idempotencyStore: deps.idempotencyStore,
    killSwitch: deps.killSwitch,
    exchangeId: deps.exchangeId,
    slippageConfig: deps.slippageConfig,
    operationTimeoutMs: deps.operationTimeoutMs,
    eventLog: deps.onEvent
      ? {
          append: (type, payload) =>
            deps.onEvent!(type, payload).then(() => undefined),
        }
      : undefined,
    productionRiskPreflightPolicy: deps.productionRiskPreflightPolicy,
    executionAuthorityProvider: deps.executionAuthorityProvider,
    accountId: deps.accountId,
    accountMode: deps.accountMode,
    executionPermitTtlMs: deps.executionPermitTtlMs,
    maxExecutionMarketDataAgeMs: deps.maxExecutionMarketDataAgeMs,
    executionReceiptSink: deps.executionReceiptSink,
    allowTestExecutionPermitBypass: deps.allowTestExecutionPermitBypass,
  }

  const dispatcher = createCryptoOperationDispatcher(deps.engine, options)
  const commitId = randomUUID()
  const mappedOperations: Operation[] = operations.map(operation => ({
    action: operation.action as Operation['action'],
    params: { ...operation.params, ticketId: operation.ticketId },
  }))
  return dispatcher.push(commitId, mappedOperations)
}
