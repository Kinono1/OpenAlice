import type { Order } from '@traderalice/ibkr'

/**
 * Returns true when the order reduces an existing position rather than
 * increasing it. Used by position-size and governance guards to avoid
 * penalizing position closures.
 */
export function isRiskReducingOrder(
  order: Order,
  existing: { side: 'long' | 'short' } | undefined,
): boolean {
  if (!existing) return false
  return (
    (existing.side === 'long' && order.action === 'SELL') ||
    (existing.side === 'short' && order.action === 'BUY')
  )
}
