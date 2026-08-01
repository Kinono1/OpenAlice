import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createCryptoOperationDispatcher, executeCommit } from './operation-dispatcher.core.js'
import type { ICryptoTradingEngine, CryptoPosition } from './operation-dispatcher.types.js'
import type { Operation } from './operation-dispatcher.types.js'
import { DecisionTicketStore } from './decision-ticket.js'
import {
  READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
} from './production-risk-preflight.js'
import type {
  ProductionRiskPreflightPolicyLike,
} from './production-risk-preflight.js'

const DEFAULT_TEST_LANE = 'volume_breakout_3x'
const DEFAULT_TEST_LEVERAGE = 3
const READY_PRODUCTION_RISK_POLICY: ProductionRiskPreflightPolicyLike = {
  ...READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
}

function createTestDispatcher(
  engine: ICryptoTradingEngine,
  options: Parameters<typeof createCryptoOperationDispatcher>[1] = {},
) {
  const explicitPolicy = (
    options as { productionRiskPreflightPolicy?: ProductionRiskPreflightPolicyLike | null }
  )?.productionRiskPreflightPolicy
  const mergedOptions = options && 'enabled' in options
      ? {
          riskConfig: options,
          productionRiskPreflightPolicy: READY_PRODUCTION_RISK_POLICY,
          allowTestExecutionPermitBypass: true,
        }
      : {
          ...options,
          allowTestExecutionPermitBypass:
            options.allowTestExecutionPermitBypass ?? true,
          productionRiskPreflightPolicy:
          explicitPolicy === null ? undefined : explicitPolicy ?? READY_PRODUCTION_RISK_POLICY,
      }
  const dispatcher = createCryptoOperationDispatcher(engine, mergedOptions)
  const wrapped = ((op: Operation) => dispatcher(withPreflightDefaults(op))) as typeof dispatcher
  wrapped.dispatch = (op: Operation) => dispatcher.dispatch(withPreflightDefaults(op))
  wrapped.push = (commitId: string, operations: Operation[]) =>
    dispatcher.push(commitId, operations.map(withPreflightDefaults))
  return wrapped
}

function withPreflightDefaults(op: Operation): Operation {
  if (op.action === 'placeOrder') {
    return {
      ...op,
      params: {
        lane: DEFAULT_TEST_LANE,
        leverage: DEFAULT_TEST_LEVERAGE,
        ...op.params,
      },
    }
  }
  if (op.action === 'adjustLeverage') {
    return {
      ...op,
      params: {
        lane: DEFAULT_TEST_LANE,
        ...op.params,
      },
    }
  }
  return op
}

function assertOrderEntryParamsHavePreflightDefaults(params: Record<string, unknown>) {
  expect(params).toEqual(expect.objectContaining({
    lane: DEFAULT_TEST_LANE,
  }))
  expect(typeof params.leverage).toBe('number')
}

function createMockEngine(overrides: Partial<ICryptoTradingEngine> = {}): ICryptoTradingEngine {
  return {
    placeOrder: vi.fn().mockResolvedValue({
      success: true,
      orderId: 'ord-001',
      filledPrice: 95000,
      filledSize: 0.1,
    }),
    getPositions: vi.fn().mockResolvedValue([]),
    getOrders: vi.fn().mockResolvedValue([]),
    getAccount: vi.fn().mockResolvedValue({
      balance: 10000, totalMargin: 0, unrealizedPnL: 0,
      equity: 10000, realizedPnL: 0, totalPnL: 0,
    }),
    cancelOrder: vi.fn().mockResolvedValue(true),
    adjustLeverage: vi.fn().mockResolvedValue({ success: true }),
    getTicker: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', last: 95000, bid: 94999, ask: 95001,
      high: 96000, low: 94000, volume: 1000, timestamp: new Date(),
    }),
    getFundingRate: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', fundingRate: 0.0001, timestamp: new Date(),
    }),
    getOrderBook: vi.fn().mockResolvedValue({
      symbol: 'BTC/USD', bids: [], asks: [], timestamp: new Date(),
    }),
    ...overrides,
  }
}

function makeLongPosition(overrides: Partial<CryptoPosition> = {}): CryptoPosition {
  return {
    symbol: 'BTC/USD', side: 'long', size: 0.5, entryPrice: 90000,
    leverage: 5, margin: 9000, liquidationPrice: 72000,
    markPrice: 95000, unrealizedPnL: 2500, positionValue: 47500,
    ...overrides,
  }
}

function makeShortPosition(overrides: Partial<CryptoPosition> = {}): CryptoPosition {
  return {
    symbol: 'ETH/USD', side: 'short', size: 10, entryPrice: 3500,
    leverage: 3, margin: 11667, liquidationPrice: 4500,
    markPrice: 3400, unrealizedPnL: 1000, positionValue: 34000,
    ...overrides,
  }
}

describe('createCryptoOperationDispatcher', () => {
  let engine: ICryptoTradingEngine
  let dispatch: (op: Operation) => Promise<unknown>

  beforeEach(() => {
    engine = createMockEngine()
    dispatch = createTestDispatcher(engine)
  })

  describe('placeOrder', () => {
    it('maps Operation params to CryptoPlaceOrderRequest', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD', side: 'buy', type: 'limit',
          size: 0.5, price: 90000, leverage: 10, reduceOnly: false,
        },
      }

      await dispatch(op)

      assertOrderEntryParamsHavePreflightDefaults(
        vi.mocked(engine.placeOrder).mock.calls[0][0] as unknown as Record<string, unknown>,
      )
      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'BTC/USD', side: 'buy', type: 'limit',
        lane: DEFAULT_TEST_LANE,
        size: 0.5, usd_size: undefined, price: 90000,
        leverage: 10, reduceOnly: false,
      })
    })

    it('passes usd_size when size is not provided', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market', usd_size: 1000 },
      }

      await dispatch(op)

      expect(engine.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          lane: DEFAULT_TEST_LANE,
          leverage: DEFAULT_TEST_LEVERAGE,
          size: undefined,
          usd_size: 1000,
        }),
      )
    })

    it('wraps successful filled result', async () => {
      const op: Operation = {
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      }

      const result = await dispatch(op)

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          executionTelemetry: expect.objectContaining({
            dispatcherStartedAtMs: expect.any(Number),
            riskDecision: 'approved',
          }),
          order: expect.objectContaining({
            id: 'ord-001',
            status: 'filled',
            filledPrice: 95000,
            filledQuantity: 0.1,
            executionTelemetry: expect.objectContaining({
              dispatcherStartedAtMs: expect.any(Number),
              riskDecision: 'approved',
            }),
          }),
        }),
      )
    })

    it('wraps successful pending result (no filledPrice)', async () => {
      engine = createMockEngine({
        placeOrder: vi.fn().mockResolvedValue({
          success: true, orderId: 'ord-002',
          filledPrice: undefined, filledSize: undefined,
        }),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'limit', price: 90000 },
      })

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          executionTelemetry: expect.objectContaining({
            dispatcherStartedAtMs: expect.any(Number),
            riskDecision: 'approved',
          }),
          order: expect.objectContaining({
            id: 'ord-002',
            status: 'pending',
            filledPrice: undefined,
            filledQuantity: undefined,
          }),
        }),
      )
    })

    it('wraps failed result with error', async () => {
      engine = createMockEngine({
        placeOrder: vi.fn().mockResolvedValue({
          success: false, error: 'Insufficient balance',
        }),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market', size: 100 },
      })

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: 'Insufficient balance',
          executionTelemetry: expect.objectContaining({
            dispatcherStartedAtMs: expect.any(Number),
            riskDecision: 'approved',
          }),
        }),
      )
    })

    it('times out a hung broker placeOrder and records timeout telemetry', async () => {
      const append = vi.fn().mockResolvedValue(undefined)
      engine = createMockEngine({
        placeOrder: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      dispatch = createTestDispatcher(engine, {
        operationTimeoutMs: 5,
        eventLog: { append },
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      })

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: 'broker place order BTC/USD timed out after 5ms',
        }),
      )
      expect(append).toHaveBeenCalledWith(
        'execution.timeout',
        expect.objectContaining({
          symbol: 'BTC/USD',
          executionTelemetry: expect.objectContaining({
            riskDecision: 'approved',
            timeoutMs: 5,
            timeoutPhase: 'broker_submit',
          }),
        }),
      )
    })

    it('rejects orders without a ticket when the ticket store requires one', async () => {
      const ticketStore = new DecisionTicketStore({ required: true, ttlMs: 60_000 })
      dispatch = createTestDispatcher(engine, { ticketStore })

      const result = await dispatch({
        action: 'placeOrder',
        params: { symbol: 'BTC/USD', side: 'buy', type: 'market' },
      })

      expect(result).toEqual({
        success: false,
        error: 'ticket: missing required decision ticket',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
      ticketStore.destroy()
    })

    it('fails closed without production risk policy before broker submission', async () => {
      const append = vi.fn().mockResolvedValue(undefined)
      dispatch = createTestDispatcher(engine, {
        eventLog: { append },
        productionRiskPreflightPolicy: null,
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          lane: DEFAULT_TEST_LANE,
          leverage: DEFAULT_TEST_LEVERAGE,
        },
      })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('production_risk_policy_missing'),
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
      expect(append).toHaveBeenCalledWith(
        'risk.rejected',
        expect.objectContaining({
          reason: 'production_risk_preflight',
          reasonCodes: ['production_risk_policy_missing'],
        }),
      )
    })

    it.each([
      ['blocked', { ...READY_PRODUCTION_RISK_POLICY, status: 'blocked' }],
      [
        'quarantine blocker',
        {
          ...READY_PRODUCTION_RISK_POLICY,
          blockers: ['source_evidence_not_trusted:quarantine'],
        },
      ],
      ['invalid mode', { ...READY_PRODUCTION_RISK_POLICY, mode: 'authorize_execution' }],
      [
        'paper authorization attempt',
        {
          ...READY_PRODUCTION_RISK_POLICY,
          paperExecutionAllowedByThisArtifact: true,
        },
      ],
      [
        'live authorization attempt',
        {
          ...READY_PRODUCTION_RISK_POLICY,
          liveExecutionAllowedByThisArtifact: true,
        },
      ],
    ])('fails closed on %s production risk policy', async (_name, policy) => {
      dispatch = createTestDispatcher(engine, {
        productionRiskPreflightPolicy: policy,
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          lane: DEFAULT_TEST_LANE,
          leverage: DEFAULT_TEST_LEVERAGE,
        },
      })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('production_risk_preflight_reject'),
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it.each([
      ['cooldown', 'cooldown'],
      ['shadow_only', 'shadow_only'],
      ['downweight', 'downweight'],
    ] as const)('does not submit broker orders for %s production risk rules', async (_name, decision) => {
      dispatch = createTestDispatcher(engine, {
        productionRiskPreflightPolicy: {
          ...READY_PRODUCTION_RISK_POLICY,
          rules: [
            {
              ruleId: `${decision}_btc`,
              decision,
              scope: {
                lane: DEFAULT_TEST_LANE,
                symbol: 'BTC/USD',
                side: null,
                minLeverage: null,
              },
              maxWeightMultiplier: decision === 'downweight' ? 0.5 : null,
            },
          ],
        },
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          lane: DEFAULT_TEST_LANE,
          leverage: DEFAULT_TEST_LEVERAGE,
        },
      })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining(`production_risk_preflight_${decision}`),
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it('hard-blocks new 100x production orders before broker submission', async () => {
      const append = vi.fn().mockResolvedValue(undefined)
      dispatch = createTestDispatcher(engine, {
        eventLog: { append },
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          usd_size: 100,
          leverage: 100,
          reduceOnly: false,
        },
      })

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0d_100x_production_hard_block: 100x leverage is forbidden in production order path; use research/replay stress lanes only',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
      expect(append).toHaveBeenCalledWith(
        'risk.rejected',
        expect.objectContaining({
          symbol: 'BTC/USD',
          reason: 'production_risk_preflight',
          reasonCodes: expect.arrayContaining([
            'p0d_100x_production_hard_block',
          ]),
          requestedLeverage: 100,
        }),
      )
    })

    it('hard-blocks reduce-only 100x orders before broker submission', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition({ leverage: 100 })]),
      })
      dispatch = createTestDispatcher(engine)
      const op: Operation = {
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'sell',
          type: 'market',
          size: 0.1,
          leverage: 100,
          reduceOnly: true,
        },
      }

      const result = await dispatch(op)

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0d_100x_production_hard_block: 100x leverage is forbidden in production order path; use research/replay stress lanes only',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it('allows verified reduce-only orders below the 100x hard block', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'sell',
          type: 'market',
          size: 0.1,
          leverage: 25,
          reduceOnly: true,
        },
      })

      expect(result).toEqual(expect.objectContaining({ success: true }))
      expect(engine.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
        symbol: 'BTC/USD',
        side: 'sell',
        size: 0.1,
        lane: DEFAULT_TEST_LANE,
        leverage: 25,
        reduceOnly: true,
      }))
    })

    it('rejects reduce-only orders that do not match an existing reducing position', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          size: 0.1,
          leverage: 25,
          reduceOnly: true,
        },
      })

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0_reduce_only_unverified: reduceOnly order is not verified as risk-reducing (wrong_side:buy_does_not_reduce_long)',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })
  })

  describe('closePosition', () => {
    it('places sell order with reduceOnly for long position', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD' } })

      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'BTC/USD', side: 'sell', type: 'market',
        lane: undefined, size: 0.5, reduceOnly: true,
      })
    })

    it('places buy order with reduceOnly for short position', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeShortPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      await dispatch({ action: 'closePosition', params: { symbol: 'ETH/USD' } })

      expect(engine.placeOrder).toHaveBeenCalledWith({
        symbol: 'ETH/USD', side: 'buy', type: 'market',
        lane: undefined, size: 10, reduceOnly: true,
      })
    })

    it('uses specified partial size', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD', size: 0.2 } })

      expect(engine.placeOrder).toHaveBeenCalledWith(
        expect.objectContaining({ size: 0.2 }),
      )
    })

    it('rejects oversized partial closes before broker submission', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition({ size: 0.5 })]),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD', size: 0.6 } })

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0_close_position_oversize: requested close size 0.6 exceeds open position size 0.5 for BTC/USD',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it('rejects invalid close sizes before broker submission', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({ action: 'closePosition', params: { symbol: 'BTC/USD', size: 0 } })

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0_close_position_invalid_size: closePosition size must be positive and finite for BTC/USD',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it('returns error when no position exists', async () => {
      const result = await dispatch({
        action: 'closePosition', params: { symbol: 'BTC/USD' },
      })

      expect(result).toEqual({
        success: false,
        error: 'No open position for BTC/USD',
      })
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })

    it('wraps the placeOrder result in standard format', async () => {
      engine = createMockEngine({
        getPositions: vi.fn().mockResolvedValue([makeLongPosition()]),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'closePosition', params: { symbol: 'BTC/USD' },
      })

      expect(result).toEqual(
        expect.objectContaining({
          success: true,
          executionTelemetry: expect.objectContaining({
            dispatcherStartedAtMs: expect.any(Number),
            riskDecision: 'approved',
          }),
          order: expect.objectContaining({
            id: 'ord-001',
            status: 'filled',
            filledPrice: 95000,
            filledQuantity: 0.1,
            executionTelemetry: expect.objectContaining({
              dispatcherStartedAtMs: expect.any(Number),
              riskDecision: 'approved',
            }),
          }),
        }),
      )
    })
  })

  describe('cancelOrder', () => {
    it('returns success when cancellation succeeds', async () => {
      const result = await dispatch({
        action: 'cancelOrder', params: { orderId: 'ord-001' },
      })

      expect(engine.cancelOrder).toHaveBeenCalledWith('ord-001')
      expect(result).toEqual({ success: true, error: undefined })
    })

    it('returns error when cancellation fails', async () => {
      engine = createMockEngine({
        cancelOrder: vi.fn().mockResolvedValue(false),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'cancelOrder', params: { orderId: 'ord-999' },
      })

      expect(result).toEqual({ success: false, error: 'Failed to cancel order' })
    })

    it('times out a hung cancelOrder', async () => {
      engine = createMockEngine({
        cancelOrder: vi.fn().mockImplementation(() => new Promise(() => {})),
      })
      dispatch = createTestDispatcher(engine, { operationTimeoutMs: 5 })

      const result = await dispatch({
        action: 'cancelOrder', params: { orderId: 'ord-stuck' },
      })

      expect(result).toEqual({
        success: false,
        error: 'cancel order ord-stuck timed out after 5ms',
      })
    })
  })

  describe('adjustLeverage', () => {
    it('passes through to engine.adjustLeverage', async () => {
      const result = await dispatch({
        action: 'adjustLeverage',
        params: { symbol: 'BTC/USD', newLeverage: 10 },
      })

      expect(engine.adjustLeverage).toHaveBeenCalledWith('BTC/USD', 10)
      expect(result).toEqual({ success: true })
    })

    it('returns error from engine', async () => {
      engine = createMockEngine({
        adjustLeverage: vi.fn().mockResolvedValue({
          success: false, error: 'Leverage too high',
        }),
      })
      dispatch = createTestDispatcher(engine)

      const result = await dispatch({
        action: 'adjustLeverage',
        params: { symbol: 'BTC/USD', newLeverage: 50 },
      })

      expect(result).toEqual({ success: false, error: 'Leverage too high' })
    })

    it('hard-blocks 100x leverage adjustments before engine call', async () => {
      const result = await dispatch({
        action: 'adjustLeverage',
        params: { symbol: 'BTC/USD', newLeverage: 100 },
      })

      expect(result).toEqual({
        success: false,
        error: 'SECURITY: p0d_100x_production_hard_block: 100x leverage is forbidden in production order path; use research/replay stress lanes only',
      })
      expect(engine.adjustLeverage).not.toHaveBeenCalled()
    })
  })

  describe('syncOrders', () => {
    it('is a read-only synchronization action', async () => {
      await expect(
        dispatch({ action: 'syncOrders', params: {} }),
      ).resolves.toEqual({ success: true, orders: [] })
      expect(engine.placeOrder).not.toHaveBeenCalled()
      expect(engine.cancelOrder).not.toHaveBeenCalled()
      expect(engine.adjustLeverage).not.toHaveBeenCalled()
    })
  })

  describe('push', () => {
    it('stops after first failure and marks remaining operations as skipped', async () => {
      const dispatcher = createTestDispatcher(engine)

      const result = await dispatcher.push('commit-1', [
        { action: 'cancelOrder', params: { orderId: 'ord-001' } },
        { action: 'closePosition', params: { symbol: 'BTC/USD' } },
        { action: 'adjustLeverage', params: { symbol: 'BTC/USD', newLeverage: 3 } },
      ])

      expect(engine.cancelOrder).toHaveBeenCalledWith('ord-001')
      expect(engine.getPositions).toHaveBeenCalledTimes(1)
      expect(engine.adjustLeverage).not.toHaveBeenCalled()
      expect(result.operations.map(entry => entry.status)).toEqual([
        'success',
        'failed',
        'skipped',
      ])
      expect(result.summary).toEqual({
        succeeded: 1,
        failed: 1,
        skipped: 1,
      })
    })
  })

  describe('execution telemetry', () => {
    it('emits structured telemetry and risk rejection events for blocked orders', async () => {
      const append = vi.fn().mockResolvedValue(undefined)
      dispatch = createTestDispatcher(engine, {
        eventLog: { append },
        riskConfig: {
          enabled: true,
          killSwitch: false,
          maxOpenPositions: 3,
          maxLeverage: 2,
          maxOrderUsd: 5_000,
          maxPositionPctOfEquity: 30,
          maxDailyLossUsd: 1_000,
        },
      })

      const result = await dispatch({
        action: 'placeOrder',
        params: {
          symbol: 'BTC/USD',
          side: 'buy',
          type: 'market',
          usd_size: 500,
          leverage: 10,
          signalTimestampMs: 1_700_000_000_000,
        },
      })

      expect(result).toEqual(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('risk:'),
        }),
      )
      expect(append).toHaveBeenCalledWith(
        'risk.rejected',
        expect.objectContaining({
          symbol: 'BTC/USD',
          executionTelemetry: expect.objectContaining({
            signalTimestampMs: 1_700_000_000_000,
            riskDecision: 'rejected',
            riskReason: expect.stringContaining('exceeds'),
          }),
        }),
      )
      expect(engine.placeOrder).not.toHaveBeenCalled()
    })
  })

  describe('executeCommit', () => {
    it('passes idempotency store through to the place-order pipeline', async () => {
      const idempotencyStore = {
        reserve: vi.fn().mockResolvedValue({
          acquired: true,
          retriedFromFailed: false,
        }),
        finalize: vi.fn().mockResolvedValue(undefined),
      }

      const result = await executeCommit(
        [
          {
            action: 'placeOrder',
            ticketId: 'ticket-1',
            params: {
              symbol: 'BTC/USD',
              side: 'buy',
              type: 'market',
              lane: DEFAULT_TEST_LANE,
              leverage: DEFAULT_TEST_LEVERAGE,
            },
          },
        ],
        {
          engine,
          idempotencyStore: idempotencyStore as any,
          productionRiskPreflightPolicy: READY_PRODUCTION_RISK_POLICY,
          allowTestExecutionPermitBypass: true,
        },
      )

      expect(idempotencyStore.reserve).toHaveBeenCalledWith({
        key: 'ticket:ticket-1',
        symbol: 'BTC/USD',
        ticketId: 'ticket-1',
        allowRetryOnFailed: false,
      })
      expect(idempotencyStore.finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'ticket:ticket-1',
          status: 'succeeded',
          orderId: 'ord-001',
        }),
      )
      expect(result.summary).toEqual({
        succeeded: 1,
        failed: 0,
        skipped: 0,
      })
    })
  })
})
