import { UNSET_DOUBLE, UNSET_DECIMAL } from '@traderalice/ibkr'
import type { Order } from '@traderalice/ibkr'
import type { OperationGuard, GuardContext } from './types.js'
import { isRiskReducingOrder } from './helpers.js'

const DEFAULT_MAX_PERCENT = 25

function estimateAddedNotionalUsd(
  order: Order,
  existing: { marketPrice: number } | undefined,
): number | null {
  const cashQty = order.cashQty !== UNSET_DOUBLE ? order.cashQty : undefined
  if (typeof cashQty === 'number' && cashQty > 0) {
    return cashQty
  }

  const qty = !order.totalQuantity.equals(UNSET_DECIMAL)
    ? order.totalQuantity.toNumber()
    : undefined
  if (typeof qty !== 'number' || qty <= 0) {
    return null
  }

  const limitPrice = order.lmtPrice !== UNSET_DOUBLE ? order.lmtPrice : undefined
  if (typeof limitPrice === 'number' && limitPrice > 0) {
    return qty * limitPrice
  }

  if (existing && typeof existing.marketPrice === 'number' && existing.marketPrice > 0) {
    return qty * existing.marketPrice
  }

  return null
}

export class MaxPositionSizeGuard implements OperationGuard {
  readonly name = 'max-position-size'
  private maxPercent: number

  constructor(options: Record<string, unknown>) {
    this.maxPercent = Number(options.maxPercentOfEquity ?? DEFAULT_MAX_PERCENT)
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const { positions, account, operation } = ctx
    const symbol = operation.contract.symbol

    const existing = positions.find(p => p.contract.symbol === symbol)
    const currentValue = existing?.marketValue ?? 0

    const addedValue = estimateAddedNotionalUsd(operation.order, existing)
    if (addedValue === null) {
      if (!existing) {
        return `Cannot estimate position size for ${symbol}: qty-only new-symbol order needs cashQty or limit price.`
      }
      return null
    }

    const projectedValue = isRiskReducingOrder(operation.order, existing)
      ? Math.max(0, currentValue - addedValue)
      : currentValue + addedValue
    const percent = account.netLiquidation > 0 ? (projectedValue / account.netLiquidation) * 100 : 0

    if (percent > this.maxPercent) {
      return `Position for ${symbol} would be ${percent.toFixed(1)}% of equity (limit: ${this.maxPercent}%)`
    }

    return null
  }
}
