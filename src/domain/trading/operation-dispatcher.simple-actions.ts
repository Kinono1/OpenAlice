import type { ICryptoTradingEngine } from './operation-dispatcher.types.js'
import type { Operation, SimpleActionResult, CryptoPlaceOrderRequest } from './operation-dispatcher.types.js'
import { toWalletOrderStatus } from './operation-dispatcher.helpers.js'

export async function resolveClosePositionOrder(
  engine: ICryptoTradingEngine,
  op: Operation,
): Promise<{ request: CryptoPlaceOrderRequest } | { error: string }> {
  const symbol = op.params.symbol as string
  const size = op.params.size as number | undefined

  const positions = await engine.getPositions()
  const position = positions.find(p => p.symbol === symbol)
  if (!position) {
    return { error: `No open position for ${symbol}` }
  }

  const closeSide = position.side === 'long' ? 'sell' : 'buy'
  const closeSize = size ?? position.size

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
): Promise<SimpleActionResult> {
  switch (op.action) {
    case 'closePosition': {
      const resolved = await resolveClosePositionOrder(engine, op)
      if ('error' in resolved) {
        return { success: false, error: resolved.error }
      }

      const result = await engine.placeOrder(resolved.request)

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
      const success = await engine.cancelOrder(orderId)
      return {
        success,
        error: success ? undefined : 'Failed to cancel order',
      }
    }

    case 'adjustLeverage': {
      const symbol = op.params.symbol as string
      const newLeverage = op.params.newLeverage as number
      return await engine.adjustLeverage(symbol, newLeverage)
    }

    default:
      throw new Error(`Unknown operation action: ${op.action}`)
  }
}

