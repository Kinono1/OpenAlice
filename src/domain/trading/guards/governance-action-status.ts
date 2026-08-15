import type { OperationGuard, GuardContext } from './types.js'
import { isRiskReducingOrder } from './helpers.js'

/**
 * GovernanceActionStatusGuard blocks new open orders when the strategy
 * governance layer has assigned a restrictive action status.
 *
 * It reads the governance metadata attached to the Operation at stage time.
 * If no governance metadata is present, the guard allows (backward compatible).
 *
 * Rule table:
 *   - closePosition: always allowed (already risk-reducing)
 *   - placeOrder with existing opposite-side position: allowed (risk-reducing)
 *   - placeOrder and actionStatus is 'no-trade' | 'exit' | 'reduce': blocked
 *   - all other cases: allowed
 */
export class GovernanceActionStatusGuard implements OperationGuard {
  readonly name = 'governance-action-status'
  private blockOn: Set<string>

  constructor(options: Record<string, unknown>) {
    const statuses = options.blockOn as string[] ?? ['no-trade', 'exit', 'reduce']
    this.blockOn = new Set(statuses)
  }

  check(ctx: GuardContext): string | null {
    if (ctx.operation.action !== 'placeOrder') return null

    const gov = ctx.operation.governance
    if (!gov?.actionStatus) return null // no governance metadata — allow

    const actionStatus = gov.actionStatus

    // Check if this status should block
    if (!this.blockOn.has(actionStatus)) return null

    // Check if the order reduces an existing position (always allow risk-reducing)
    const positions = [...ctx.positions]
    const symbol = ctx.operation.contract.symbol
    const existing = positions.find(p => p.contract.symbol === symbol)
    if (existing && isRiskReducingOrder(ctx.operation.order, existing)) return null

    return `governance action status "${actionStatus}" blocks new open orders for ${symbol}`
  }
}
