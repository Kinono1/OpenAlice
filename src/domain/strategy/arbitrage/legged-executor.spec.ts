import { describe, it, expect, vi } from 'vitest'
import { executeLeggedArb } from './legged-executor.js'
import type { ICryptoTradingEngine, CryptoOrderResult, CryptoOrder } from '../../trading/operation-dispatcher.types.js'
import type { ArbLegPair } from './arbitrage-dispatcher.js'

function mockEngine(overrides: Partial<ICryptoTradingEngine> = {}): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({ success: true, orderId: 'order-1', filledSize: 1 } as CryptoOrderResult),
    getOrders: vi.fn().mockResolvedValue([{ id: 'order-1', status: 'filled', symbol: 'BTC/USDT', side: 'buy', type: 'market', size: 1 }] as CryptoOrder[]),
    cancelOrder: vi.fn().mockResolvedValue(true),
    getPositions: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({ balance: 10000, equity: 10000, totalPnL: 0 }),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', last: 50000, bid: 49999, ask: 50001 }),
    getFundingRate: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', fundingRate: 0.0001, nextFundingTime: Date.now() }),
    getOrderBook: vi.fn().mockResolvedValue({ symbol: 'BTC/USDT', bids: [], asks: [] }),
    ...overrides,
  }
}

function executionOptions(engine: ICryptoTradingEngine) {
  return {
    submitOrder: (order: Parameters<ICryptoTradingEngine['placeOrder']>[0]) => engine.placeOrder(order),
    cancelOrder: (orderId: string) => engine.cancelOrder(orderId),
  }
}

const pair: ArbLegPair = {
  legA: { symbol: 'BTC/USDT', side: 'buy', type: 'market', usd_size: 100, idempotencyKey: 'leg-a' },
  legB: { symbol: 'ETH/USDT', side: 'sell', type: 'market', usd_size: 100, idempotencyKey: 'leg-b' },
  description: 'test pair',
}

describe('executeLeggedArb', () => {
  it('defaults to dry-run and does not submit engine orders', async () => {
    const engine = mockEngine()
    const result = await executeLeggedArb(engine, pair, { pollIntervalMs: 1 })
    expect(result.status).toBe('aborted_leg_a')
    expect(result.dryRun).toBe(true)
    expect(result.legAResult.success).toBe(false)
    expect(result.legAResult.error).toBe('dry_run_legged_arb_requires_execute_true')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('rejects execute=true without an authorized dispatcher submitter', async () => {
    const engine = mockEngine()
    const result = await executeLeggedArb(engine, pair, {
      execute: true,
      pollIntervalMs: 1,
    })
    expect(result.status).toBe('aborted_leg_a')
    expect(result.legAResult.error).toBe('authorized_dispatcher_submitter_required')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('returns filled_both when both legs succeed', async () => {
    const engine = mockEngine()
    const result = await executeLeggedArb(engine, pair, {
      ...executionOptions(engine), execute: true, pollIntervalMs: 1,
    })
    expect(result.status).toBe('filled_both')
    expect(result.dryRun).toBe(false)
    expect(engine.placeOrder).toHaveBeenCalledTimes(2)
  })

  it('returns aborted_leg_a when legA fails', async () => {
    const engine = mockEngine({
      placeOrder: vi.fn().mockResolvedValue({ success: false, error: 'rejected' } as CryptoOrderResult),
    })
    const result = await executeLeggedArb(engine, pair, {
      ...executionOptions(engine), execute: true, pollIntervalMs: 1,
    })
    expect(result.status).toBe('aborted_leg_a')
    expect(engine.placeOrder).toHaveBeenCalledTimes(1)
  })

  it('hard-blocks 100x legA before any engine submission', async () => {
    const engine = mockEngine()
    const result = await executeLeggedArb(
      engine,
      {
        ...pair,
        legA: { ...pair.legA, leverage: 100 },
      },
      { ...executionOptions(engine), execute: true, pollIntervalMs: 1 },
    )

    expect(result.status).toBe('aborted_leg_a')
    expect(result.legAResult.success).toBe(false)
    expect(result.legAResult.error).toContain('p0d_100x_production_hard_block')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('hard-blocks 100x legB before submitting legA', async () => {
    const engine = mockEngine()
    const result = await executeLeggedArb(
      engine,
      {
        ...pair,
        legB: { ...pair.legB, leverage: 100 },
      },
      { ...executionOptions(engine), execute: true, pollIntervalMs: 1 },
    )

    expect(result.status).toBe('aborted_leg_a')
    expect(result.legAResult.success).toBe(false)
    expect(result.description).toContain('legB failed before legA submission')
    expect(result.description).toContain('p0d_100x_production_hard_block')
    expect(engine.placeOrder).not.toHaveBeenCalled()
  })

  it('hedges legA when legB fails', async () => {
    let callCount = 0
    const engine = mockEngine({
      placeOrder: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) return { success: true, orderId: 'order-1', filledSize: 1 } as CryptoOrderResult
        if (callCount === 2) return { success: false, error: 'rejected' } as CryptoOrderResult
        return { success: true, orderId: 'hedge-1' } as CryptoOrderResult  // hedge
      }),
    })
    const result = await executeLeggedArb(engine, pair, {
      ...executionOptions(engine), execute: true, pollIntervalMs: 1,
    })
    expect(result.status).toBe('hedged_leg_a')
    expect(engine.placeOrder).toHaveBeenCalledTimes(3)
    // hedge order must be reduce-only
    const hedgeCall = (engine.placeOrder as ReturnType<typeof vi.fn>).mock.calls[2][0]
    expect(hedgeCall.reduceOnly).toBe(true)
    expect(hedgeCall.side).toBe('sell')  // opposite of legA buy
  })

  it('returns hedge_failed when both legB and hedge fail', async () => {
    let callCount = 0
    const engine = mockEngine({
      placeOrder: vi.fn().mockImplementation(async () => {
        callCount++
        if (callCount === 1) return { success: true, orderId: 'order-1', filledSize: 1 } as CryptoOrderResult
        return { success: false, error: 'rejected' } as CryptoOrderResult
      }),
    })
    const result = await executeLeggedArb(engine, pair, {
      ...executionOptions(engine), execute: true, pollIntervalMs: 1,
    })
    expect(result.status).toBe('hedge_failed')
  })
})
