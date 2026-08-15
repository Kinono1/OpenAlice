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
import {
  resolveAuthorizedBrokerWriter,
  type AuthorizedBrokerWriter,
} from './broker-write-router.js'

interface PlaceOrderGateState {
  queue: Promise<void>
  queuePoisoned: boolean
  circuitOpen: boolean
}

const sidecarPlaceOrderGates = new WeakMap<AuthorizedBrokerWriter, PlaceOrderGateState>()
const sidecarPlaceOrderGatesByAccount = new Map<string, PlaceOrderGateState>()

function createPlaceOrderGateState(): PlaceOrderGateState {
  return { queue: Promise.resolve(), queuePoisoned: false, circuitOpen: false }
}

function resolvePlaceOrderGateState(
  route: 'native' | 'sidecar',
  writer: AuthorizedBrokerWriter,
  accountId: string | undefined,
): PlaceOrderGateState {
  if (route === 'native') return createPlaceOrderGateState()
  const accountScope = accountId?.trim()
  if (accountScope) {
    const existing = sidecarPlaceOrderGatesByAccount.get(accountScope)
    if (existing) return existing
    const created = createPlaceOrderGateState()
    sidecarPlaceOrderGatesByAccount.set(accountScope, created)
    return created
  }
  const existing = sidecarPlaceOrderGates.get(writer)
  if (existing) return existing
  const created = createPlaceOrderGateState()
  sidecarPlaceOrderGates.set(writer, created)
  return created
}

export function createCryptoOperationDispatcher(
  engine: ICryptoTradingEngine,
  optionsOrRiskConfig?: CryptoOperationDispatcherOptions | RiskConfig,
): CryptoOperationDispatcher {
  const options = normalizeDispatcherOptions(optionsOrRiskConfig)
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
  const brokerRoute = resolveAuthorizedBrokerWriter(engine, {
    route: options.brokerWriteRoute,
    writer: options.authorizedBrokerWriter,
  })
  const placeOrderLockTimeoutMs = operationTimeoutMs + 10_000 // lock timeout > operation timeout
  const placeOrderGate = resolvePlaceOrderGateState(
    brokerRoute.route,
    brokerRoute.writer,
    options.accountId,
  )
  const placeOrderCircuitOpenError =
    'SECURITY: sidecar place-order circuit open; restart required before submitting another order'

  function poisonPlaceOrderCircuit(): void {
    placeOrderGate.circuitOpen = true
  }

  async function withPlaceOrderLock<T>(task: () => Promise<T>): Promise<T> {
    if (placeOrderGate.circuitOpen) {
      throw new Error(placeOrderCircuitOpenError)
    }
    if (placeOrderGate.queuePoisoned) {
      throw new Error('place-order lock queue poisoned — restart required before submitting another order')
    }

    const prev = placeOrderGate.queue
    let release!: () => void
    placeOrderGate.queue = new Promise<void>(resolve => {
      release = resolve
    })

    let queueTimedOut = false
    let resolveQueueTimeout!: () => void
    const queueTimeout = setTimeout(() => {
      queueTimedOut = true
      placeOrderGate.queuePoisoned = true
      console.warn(`[crypto-dispatcher] place-order lock timed out after ${placeOrderLockTimeoutMs}ms — queue poisoned`)
      release()
      resolveQueueTimeout()
    }, placeOrderLockTimeoutMs)

    try {
      await Promise.race([
        prev,
        new Promise<void>(resolve => {
          resolveQueueTimeout = resolve
        }),
      ])
    } finally {
      clearTimeout(queueTimeout)
    }

    if (queueTimedOut) {
      release()
      throw new Error('place-order lock queue timeout — queue poisoned; restart required before submitting another order')
    }
    if (placeOrderGate.queuePoisoned) {
      release()
      throw new Error('place-order lock queue poisoned — restart required before submitting another order')
    }
    if (placeOrderGate.circuitOpen) {
      release()
      throw new Error(placeOrderCircuitOpenError)
    }

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
    writer: brokerRoute.writer,
    brokerWriteRoute: brokerRoute.route,
    poisonPlaceOrderCircuit,
    placeOrderCircuitOpenError,
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
      const authorization = await authorizeBrokerWrite(engine, options, {
        intentId: randomUUID(),
        action: op.action === 'cancelOrder' ? 'cancel' : 'adjust_leverage',
        riskReducing: false,
        symbol: typeof op.params.symbol === 'string' ? op.params.symbol : 'test-bypass',
        ticketId: 'test-bypass',
        idempotencyKey: `test-bypass:${randomUUID()}`,
        completedChecks: [],
      })
      if (!authorization.allowed) {
        return { success: false, error: `execution-permit: ${authorization.reasonCodes.join(',')}` }
      }
      return executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
        authorization: { writer: brokerRoute.writer, context: authorization.context },
        brokerWriteRoute: brokerRoute.route,
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
    let sidecarWriteStarted = false
    try {
      result = await executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
        authorization: {
          writer: brokerRoute.writer,
          context: authorization.context,
        },
        brokerWriteRoute: brokerRoute.route,
        onWriteStarted: () => {
          sidecarWriteStarted = brokerRoute.route === 'sidecar'
        },
      })
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = sidecarWriteStarted
        ? 'execution_sidecar_submission_unknown'
        : rawMessage
      if (sidecarWriteStarted) {
        let unresolvedPersisted = true
        try {
          await options.idempotencyStore.markUnresolved({
            key: idempotencyKey,
            error: message,
            symbol: context.symbol,
            ticketId,
          })
        } catch {
          unresolvedPersisted = false
          poisonPlaceOrderCircuit()
          console.warn('[operation-dispatcher] Failed to persist unresolved idempotency', {
            action: op.action,
            intentId,
            idempotencyKey,
            placeOrderCircuit: 'opened',
          })
        }
        const publicMessage = unresolvedPersisted ? message : placeOrderCircuitOpenError
        await options.eventLog
          ?.append('execution.submission_unknown', {
            action: op.action,
            intentId,
            ticketId,
            idempotencyKey,
            symbol: context.symbol,
            error: publicMessage,
            brokerWriteRoute: brokerRoute.route,
          })
          .catch(logError => {
            console.warn('[operation-dispatcher] Event log append failed:', logError)
          })
        return {
          success: false,
          error: publicMessage,
          brokerWriteOutcome: 'submission_unknown',
          unknown: true,
        }
      }
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
        authorization.context.kind === 'execution_permit_v1'
          ? authorization.context.permit
          : null,
      )
      throw error
    }
    if (
      result.brokerWriteOutcome === 'command_accepted'
      || result.brokerWriteOutcome === 'submission_unknown'
    ) {
      let unresolvedPersisted = true
      try {
        await options.idempotencyStore.markUnresolved({
          key: idempotencyKey,
          error: result.error ?? 'sidecar broker outcome unresolved',
          symbol: context.symbol,
          ticketId,
          commandId: asOptionalString(result.commandId),
          permitV2Id: asOptionalString(result.permitV2Id),
          clientOrderId: asOptionalString(result.clientOrderId),
          acceptedSequence: asOptionalString(result.acceptedSequence),
        })
      } catch {
        unresolvedPersisted = false
        poisonPlaceOrderCircuit()
        console.warn('[operation-dispatcher] Failed to persist unresolved idempotency', {
          action: op.action,
          intentId,
          idempotencyKey,
          placeOrderCircuit: 'opened',
        })
      }
      if (!unresolvedPersisted) {
        return {
          success: false,
          error: placeOrderCircuitOpenError,
          brokerWriteOutcome: 'submission_unknown',
          unknown: true,
        }
      }
      return result
    }
    await options.idempotencyStore.finalize({
      key: idempotencyKey,
      status: result.success ? 'succeeded' : 'failed',
      error: result.error,
    })
    await recordExecutionReceipt(
      options,
      authorizationInput,
      result.success
        ? 'broker_succeeded'
        : result.brokerWriteOutcome === 'pre_submit_rejected'
          ? 'rejected'
          : 'broker_failed',
      result.success ? [] : [result.error ?? 'simple_action_failed'],
      authorization.context.kind === 'execution_permit_v1'
        ? authorization.context.permit
        : null,
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
          if (outcome.status === 'failed' || outcome.status === 'unknown') {
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
        if (simpleResult.brokerWriteOutcome === 'command_accepted'
          || simpleResult.brokerWriteOutcome === 'submission_unknown') {
          results.push({
            opIndex: i,
            ticketId: (op.params.ticketId as string) ?? '',
            intentId: '',
            status: 'unknown',
            error: simpleResult.error,
          })
          stopped = true
        } else if (simpleResult && !simpleResult.success) {
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
      unknown: results.filter(r => r.status === 'unknown').length,
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

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
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
    brokerWriteRoute: deps.brokerWriteRoute,
    authorizedBrokerWriter: deps.authorizedBrokerWriter,
  }

  const dispatcher = createCryptoOperationDispatcher(deps.engine, options)
  const commitId = randomUUID()
  const mappedOperations: Operation[] = operations.map(operation => ({
    action: operation.action as Operation['action'],
    params: { ...operation.params, ticketId: operation.ticketId },
  }))
  return dispatcher.push(commitId, mappedOperations)
}
