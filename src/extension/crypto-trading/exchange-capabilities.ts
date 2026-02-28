/**
 * Exchange capability matrix for intent idempotency.
 * Maps exchange IDs to their clientOrderId field names.
 */

/** Field name each exchange uses for client-supplied order IDs */
export const CLIENT_ORDER_ID_FIELD: Record<string, string> = {
  bybit: 'orderLinkId',
  binance: 'newClientOrderId',
  okx: 'clOrdId',
  bitget: 'clientOid',
  gate: 'text',
}

export interface ExchangeCapability {
  supportsClientOrderId: boolean
  clientOrderIdField?: string
}

/**
 * Get capabilities for an exchange.
 */
export function getExchangeCapability(exchangeId: string): ExchangeCapability {
  const field = CLIENT_ORDER_ID_FIELD[exchangeId.toLowerCase()]
  return {
    supportsClientOrderId: !!field,
    clientOrderIdField: field,
  }
}

/**
 * Idempotency degradation policy.
 * - New positions on exchanges without clientOrderId support: REJECT
 * - ReduceOnly on exchanges without clientOrderId support: ALLOW with warning
 */
export type IdempotencyDegradation = 'reject' | 'allow-with-warning'

export function getIdempotencyPolicy(
  exchangeId: string,
  reduceOnly: boolean,
): { allowed: boolean; degradation?: IdempotencyDegradation; warning?: string } {
  const cap = getExchangeCapability(exchangeId)
  if (cap.supportsClientOrderId) {
    return { allowed: true }
  }
  if (reduceOnly) {
    return {
      allowed: true,
      degradation: 'allow-with-warning',
      warning: `Exchange ${exchangeId} does not support clientOrderId. ReduceOnly order allowed with degraded idempotency.`,
    }
  }
  return {
    allowed: false,
    degradation: 'reject',
    warning: `Exchange ${exchangeId} does not support clientOrderId. New position orders rejected for safety.`,
  }
}
