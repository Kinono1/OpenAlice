import type { ICryptoTradingEngine } from './operation-dispatcher.types.js'
import type { Operation, SimpleActionResult, CryptoPlaceOrderRequest } from './operation-dispatcher.types.js'
import { withTimeout } from '../../core/timeout.js'
import { toWalletOrderStatus } from './operation-dispatcher.helpers.js'
import {
  evaluateProductionRiskPreflight,
  productionRiskPreflightError,
} from './production-risk-preflight.js'
import type { ProductionRiskPreflightPolicyLike } from './production-risk-preflight.js'
import type {
  AuthorizedBrokerWriter,
  BrokerWriteOutcome,
  BrokerWriteRoute,
} from './broker-write-router.js'
import type { BrokerWriteAuthorizationContext } from './operation-dispatcher.execution-gate.js'

export interface SimpleActionAuthorization {
  writer: AuthorizedBrokerWriter
  context: BrokerWriteAuthorizationContext
}

export async function resolveClosePositionOrder(
  engine: ICryptoTradingEngine,
  op: Operation,
  timeoutMs?: number,
): Promise<{ request: CryptoPlaceOrderRequest } | { error: string }> {
  const symbol = op.params.symbol as string
  const size = op.params.size as number | undefined

  const positions = await withTimeout(
    `resolve close position ${symbol}`,
    timeoutMs,
    () => engine.getPositions(),
  )
  const position = positions.find(p => p.symbol === symbol)
  if (!position) {
    return { error: `No open position for ${symbol}` }
  }

  const closeSide = position.side === 'long' ? 'sell' : 'buy'
  const closeSize = size ?? position.size
  if (!Number.isFinite(closeSize) || closeSize <= 0) {
    return {
      error: `SECURITY: p0_close_position_invalid_size: closePosition size must be positive and finite for ${symbol}`,
    }
  }
  if (!Number.isFinite(position.size) || position.size <= 0) {
    return {
      error: `SECURITY: p0_close_position_invalid_position: closePosition requires a positive finite open position size for ${symbol}`,
    }
  }
  if (closeSize > position.size) {
    return {
      error: `SECURITY: p0_close_position_oversize: requested close size ${closeSize} exceeds open position size ${position.size} for ${symbol}`,
    }
  }

  return {
    request: {
      symbol,
      side: closeSide,
      type: 'market',
      size: closeSize,
      reduceOnly: true,
    },
  }
}

export async function executeSimpleAction(
  engine: ICryptoTradingEngine,
  op: Operation,
  timeoutMs?: number,
  options: {
    productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null
    authorization?: SimpleActionAuthorization
    brokerWriteRoute?: BrokerWriteRoute
    onWriteStarted?: () => void
  } = {},
): Promise<SimpleActionResult> {
  switch (op.action) {
    case 'syncOrders': {
      const orders = await withTimeout(
        'sync orders',
        timeoutMs,
        () => engine.getOrders(),
      )
      return { success: true, orders }
    }

    case 'closePosition': {
      const authorization = requireSimpleWriteAuthorization(options.authorization)
      if ('error' in authorization) return { success: false, error: authorization.error }
      const resolved = await resolveClosePositionOrder(engine, op, timeoutMs)
      if ('error' in resolved) {
        return { success: false, error: resolved.error }
      }

      options.onWriteStarted?.()
      const outcome = await withTimeout(
        `close position order ${resolved.request.symbol}`,
        timeoutMs,
        () => authorization.writer.placeOrder(resolved.request, authorization.context),
      )
      const result = unwrapBrokerWriteOutcome(outcome, options.brokerWriteRoute)
      if (result.kind !== 'final') return result.value
      const brokerResult = result.result

      return {
        success: brokerResult.success,
        error: brokerResult.error,
        order: brokerResult.success
          ? {
              id: brokerResult.orderId,
              status: toWalletOrderStatus(brokerResult),
              requestedSize: brokerResult.requestedSize,
              remainingSize: brokerResult.remainingSize,
              filledPrice: brokerResult.filledPrice,
              filledQuantity: brokerResult.filledSize,
              firstFillAtMs: brokerResult.firstFillAtMs,
              completedAtMs: brokerResult.completedAtMs,
            }
          : undefined,
      }
    }

    case 'cancelOrder': {
      const authorization = requireSimpleWriteAuthorization(options.authorization)
      if ('error' in authorization) return { success: false, error: authorization.error }
      const orderId = op.params.orderId as string
      options.onWriteStarted?.()
      const outcome = await withTimeout(
        `cancel order ${orderId}`,
        timeoutMs,
        () => authorization.writer.cancelOrder(orderId, authorization.context),
      )
      const result = unwrapBrokerWriteOutcome(outcome, options.brokerWriteRoute)
      if (result.kind !== 'final') return result.value
      const success = result.result
      return {
        success,
        error: success ? undefined : 'Failed to cancel order',
      }
    }

    case 'adjustLeverage': {
      const authorization = requireSimpleWriteAuthorization(options.authorization)
      if ('error' in authorization) return { success: false, error: authorization.error }
      const symbol = op.params.symbol as string
      const newLeverage = op.params.newLeverage as number
      const preflight = evaluateProductionRiskPreflight(
        {
          lane: typeof op.params.lane === 'string' ? op.params.lane : null,
          symbol: typeof symbol === 'string' ? symbol : null,
          side: null,
          leverage: typeof newLeverage === 'number' && Number.isFinite(newLeverage)
            ? newLeverage
            : null,
          requestedAction: 'adjust_leverage',
          decisionTime: new Date().toISOString(),
          sourcePath: 'operation-dispatcher.simple-actions.adjustLeverage',
        },
        options.productionRiskPreflightPolicy,
      )
      if (!preflight.allowed) {
        return {
          success: false,
          error: productionRiskPreflightError(preflight),
        }
      }
      options.onWriteStarted?.()
      const outcome = await withTimeout(
        `adjust leverage ${symbol}`,
        timeoutMs,
        () => authorization.writer.adjustLeverage(symbol, newLeverage, authorization.context),
      )
      const result = unwrapBrokerWriteOutcome(outcome, options.brokerWriteRoute)
      return result.kind === 'final' ? result.result : result.value
    }

    default:
      throw new Error(`Unknown operation action: ${op.action}`)
  }
}

function requireSimpleWriteAuthorization(
  value: SimpleActionAuthorization | undefined,
): SimpleActionAuthorization | { error: string } {
  return value?.writer && value.context
    ? value
    : { error: 'broker write authorization and writer required' }
}

function unwrapBrokerWriteOutcome<T>(
  outcome: BrokerWriteOutcome<T>,
  route: BrokerWriteRoute | undefined,
): { kind: 'final'; result: T } | { kind: 'non_final'; value: SimpleActionResult } {
  if (outcome.kind === 'broker_final') return { kind: 'final', result: outcome.result }
  if (outcome.kind === 'pre_submit_rejected') {
    return {
      kind: 'non_final',
      value: {
        success: false,
        error: route === 'sidecar'
          ? 'execution_sidecar_pre_submit_rejected'
          : outcome.error || 'broker write rejected before submission',
        brokerWriteOutcome: 'pre_submit_rejected',
      },
    }
  }
  if (outcome.kind === 'command_accepted') {
    return {
      kind: 'non_final',
      value: {
        success: false,
        error: route === 'sidecar'
          ? 'broker_outcome_pending'
          : outcome.message ?? 'broker command accepted; broker outcome pending',
        brokerWriteOutcome: 'command_accepted',
        pending: true,
        commandId: outcome.commandId,
        permitV2Id: outcome.permitV2Id,
        acceptedSequence: outcome.acceptedSequence,
        clientOrderId: outcome.clientOrderId,
      },
    }
  }
  return {
    kind: 'non_final',
    value: {
      success: false,
      error: route === 'sidecar'
        ? 'execution_sidecar_submission_unknown'
        : outcome.error || 'broker submission outcome unknown',
      brokerWriteOutcome: 'submission_unknown',
      unknown: true,
      commandId: outcome.commandId,
      permitV2Id: outcome.permitV2Id,
      clientOrderId: outcome.clientOrderId,
    },
  }
}
