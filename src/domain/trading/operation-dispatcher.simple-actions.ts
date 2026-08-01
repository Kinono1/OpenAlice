import type { ICryptoTradingEngine } from './operation-dispatcher.types.js'
import type { Operation, SimpleActionResult, CryptoPlaceOrderRequest } from './operation-dispatcher.types.js'
import { withTimeout } from '../../core/timeout.js'
import { toWalletOrderStatus } from './operation-dispatcher.helpers.js'
import {
  evaluateProductionRiskPreflight,
  productionRiskPreflightError,
} from './production-risk-preflight.js'
import type { ProductionRiskPreflightPolicyLike } from './production-risk-preflight.js'

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
      const resolved = await resolveClosePositionOrder(engine, op, timeoutMs)
      if ('error' in resolved) {
        return { success: false, error: resolved.error }
      }

      const result = await withTimeout(
        `close position order ${resolved.request.symbol}`,
        timeoutMs,
        () => engine.placeOrder(resolved.request),
      )

      return {
        success: result.success,
        error: result.error,
        order: result.success
          ? {
              id: result.orderId,
              status: toWalletOrderStatus(result),
              requestedSize: result.requestedSize,
              remainingSize: result.remainingSize,
              filledPrice: result.filledPrice,
              filledQuantity: result.filledSize,
              firstFillAtMs: result.firstFillAtMs,
              completedAtMs: result.completedAtMs,
            }
          : undefined,
      }
    }

    case 'cancelOrder': {
      const orderId = op.params.orderId as string
      const success = await withTimeout(
        `cancel order ${orderId}`,
        timeoutMs,
        () => engine.cancelOrder(orderId),
      )
      return {
        success,
        error: success ? undefined : 'Failed to cancel order',
      }
    }

    case 'adjustLeverage': {
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
      return await withTimeout(
        `adjust leverage ${symbol}`,
        timeoutMs,
        () => engine.adjustLeverage(symbol, newLeverage),
      )
    }

    default:
      throw new Error(`Unknown operation action: ${op.action}`)
  }
}
