/**
 * LeggedExecutor - safe dual-leg order execution with legging risk protection.
 *
 * Protocol:
 *   1. Submit legA (market order)
 *   2. Poll until legA is filled (or timeout)
 *   3. Submit legB
 *   4. If legB fails or times out -> immediately submit reduce-only market hedge on legA
 *
 * This prevents the "one-legged" position that arises when legA fills but legB doesn't.
 */

import type {
  CryptoPlaceOrderRequest,
  CryptoOrderResult,
  ICryptoTradingEngine,
} from '../../trading/operation-dispatcher.types.js'
import { rejectForbiddenProductionLeverage } from '../../trading/production-leverage-guard.js'
import type { ArbLegPair } from './arbitrage-dispatcher.js'

export interface LeggedExecutorOptions {
  /** Defaults to dry-run. Real order submission requires execute=true. */
  execute?: boolean
  /** Max ms to wait for legA fill before aborting (default 10 000) */
  legAFillTimeoutMs?: number
  /** Max ms to wait for legB fill before hedging (default 8 000) */
  legBFillTimeoutMs?: number
  /** Poll interval for order status (default 500) */
  pollIntervalMs?: number
}

export type LeggedStatus =
  | 'filled_both'        // both legs filled - arb is live
  | 'aborted_leg_a'      // legA never filled - nothing to hedge
  | 'hedged_leg_a'       // legB failed, legA hedged back to flat
  | 'hedge_failed'       // legB failed AND hedge failed - manual intervention needed

export interface LeggedResult {
  status: LeggedStatus
  legAResult: CryptoOrderResult
  legBResult?: CryptoOrderResult
  hedgeResult?: CryptoOrderResult
  description: string
  elapsedMs: number
  dryRun: boolean
}

/** Poll until an order is filled or timeout. Returns the final order result. */
async function waitForFill(
  engine: ICryptoTradingEngine,
  orderId: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<{ filled: boolean; filledSize?: number; filledPrice?: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const orders = await engine.getOrders()
    const order = orders.find(o => o.id === orderId)
    if (!order || order.status === 'filled') {
      return { filled: true, filledSize: order?.size, filledPrice: order?.price }
    }
    if (order.status === 'cancelled' || order.status === 'rejected') {
      return { filled: false }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs))
  }
  return { filled: false }
}

/** Build a reduce-only market hedge for an open leg. */
function buildHedgeOrder(original: CryptoPlaceOrderRequest, filledSize?: number): CryptoPlaceOrderRequest {
  return {
    symbol: original.symbol,
    side: original.side === 'buy' ? 'sell' : 'buy',
    type: 'market',
    size: filledSize ?? original.size,
    usd_size: filledSize ? undefined : original.usd_size,
    reduceOnly: true,
    idempotencyKey: `hedge_${original.idempotencyKey ?? Date.now()}`,
  }
}

/**
 * Execute a dual-leg arbitrage order pair with legging risk protection.
 *
 * @param engine - trading engine (ICryptoTradingEngine)
 * @param pair   - the two legs from buildPairsOrders() or buildFundingArbOrders()
 * @param opts   - timeouts and poll interval
 */
export async function executeLeggedArb(
  engine: ICryptoTradingEngine,
  pair: ArbLegPair,
  opts: LeggedExecutorOptions = {},
): Promise<LeggedResult> {
  const {
    execute = false,
    legAFillTimeoutMs = 10_000,
    legBFillTimeoutMs = 8_000,
    pollIntervalMs = 500,
  } = opts

  const startMs = Date.now()
  const dryRun = !execute

  const legAForbiddenLeverage = rejectForbiddenProductionLeverage(pair.legA)
  if (legAForbiddenLeverage) {
    return {
      status: 'aborted_leg_a',
      legAResult: legAForbiddenLeverage,
      description: `legA failed: ${legAForbiddenLeverage.error ?? 'forbidden leverage'}`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }
  const legBForbiddenLeverage = rejectForbiddenProductionLeverage(pair.legB)
  if (legBForbiddenLeverage) {
    return {
      status: 'aborted_leg_a',
      legAResult: legBForbiddenLeverage,
      description: `legB failed before legA submission: ${legBForbiddenLeverage.error ?? 'forbidden leverage'}`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }

  if (dryRun) {
    return {
      status: 'aborted_leg_a',
      legAResult: {
        success: false,
        error: 'dry_run_legged_arb_requires_execute_true',
      },
      description: `dry-run legged arb preview: ${pair.description}`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }

  // - Step 1: Submit legA -
  const legAResult = await engine.placeOrder(pair.legA)
  if (!legAResult.success) {
    return {
      status: 'aborted_leg_a',
      legAResult,
      description: `legA failed: ${legAResult.error ?? 'unknown'}`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }

  // - Step 2: Wait for legA fill -----------------------
  const legAFill = legAResult.orderId
    ? await waitForFill(engine, legAResult.orderId, legAFillTimeoutMs, pollIntervalMs)
    : { filled: true, filledSize: legAResult.filledSize, filledPrice: legAResult.filledPrice }

  if (!legAFill.filled) {
    // legA timed out - cancel it if possible, then abort
    if (legAResult.orderId) {
      await engine.cancelOrder(legAResult.orderId).catch(() => undefined)
    }
    return {
      status: 'aborted_leg_a',
      legAResult,
      description: `legA fill timeout after ${legAFillTimeoutMs}ms`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }

  // - Step 3: Submit legB -
  const legBResult = await engine.placeOrder(pair.legB)

  if (legBResult.success) {
    // Wait for legB fill (best-effort; don't hedge if it's just slow)
    if (legBResult.orderId) {
      await waitForFill(engine, legBResult.orderId, legBFillTimeoutMs, pollIntervalMs)
    }
    return {
      status: 'filled_both',
      legAResult,
      legBResult,
      description: `arb live: ${pair.description}`,
      elapsedMs: Date.now() - startMs,
      dryRun,
    }
  }

  // - Step 4: legB failed - hedge legA back to flat -------------
  const hedgeOrder = buildHedgeOrder(pair.legA, legAFill.filledSize)
  const hedgeResult = await engine.placeOrder(hedgeOrder)

  return {
    status: hedgeResult.success ? 'hedged_leg_a' : 'hedge_failed',
    legAResult,
    legBResult,
    hedgeResult,
    description: hedgeResult.success
      ? `legB failed, legA hedged: ${hedgeResult.orderId}`
      : `CRITICAL: legB failed AND hedge failed - manual intervention required`,
    elapsedMs: Date.now() - startMs,
    dryRun,
  }
}
