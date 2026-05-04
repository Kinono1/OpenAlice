import type { CryptoOrderResult, CryptoPlaceOrderRequest } from './operation-dispatcher.types.js'

export const FORBIDDEN_PRODUCTION_LEVERAGE = 100
export const FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE = 'p0d_100x_production_hard_block'

export function isForbiddenProductionLeverage(leverage: unknown): leverage is number {
  return typeof leverage === 'number' &&
    Number.isFinite(leverage) &&
    leverage >= FORBIDDEN_PRODUCTION_LEVERAGE
}

export function buildForbiddenProductionLeverageError(): string {
  return `SECURITY: ${FORBIDDEN_PRODUCTION_LEVERAGE_REASON_CODE}: 100x leverage is forbidden in production order path; use research/replay stress lanes only`
}

export function rejectForbiddenProductionLeverage(
  req: Pick<CryptoPlaceOrderRequest, 'leverage'>,
): CryptoOrderResult | null {
  if (!isForbiddenProductionLeverage(req.leverage)) return null
  return {
    success: false,
    error: buildForbiddenProductionLeverageError(),
    orderStatus: 'rejected',
  }
}
