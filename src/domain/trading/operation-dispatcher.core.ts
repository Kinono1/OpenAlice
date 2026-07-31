import { randomUUID } from 'node:crypto'
import type { ICryptoTradingEngine, Operation } from './operation-dispatcher.types.js'
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
      return await executeSimpleAction(engine, op, operationTimeoutMs, {
        productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
      })
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
        const simpleResult = await executeSimpleAction(engine, op, operationTimeoutMs, {
          productionRiskPreflightPolicy: options.productionRiskPreflightPolicy,
        })
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
  }

  const dispatcher = createCryptoOperationDispatcher(deps.engine, options)
  const commitId = randomUUID()
  const mappedOperations: Operation[] = operations.map(operation => ({
    action: operation.action as Operation['action'],
    params: { ...operation.params, ticketId: operation.ticketId },
  }))
  return dispatcher.push(commitId, mappedOperations)
}
