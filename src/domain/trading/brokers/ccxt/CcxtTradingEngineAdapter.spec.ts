import { beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const releaseGateMocks = vi.hoisted(() => ({
  loadReleaseGateStatus: vi.fn(),
  isReleaseGateStatusBlocking: vi.fn(),
}))

vi.mock('../../../../runtime/release_gate_status.js', () => ({
  loadReleaseGateStatus: releaseGateMocks.loadReleaseGateStatus,
  isReleaseGateStatusBlocking: releaseGateMocks.isReleaseGateStatusBlocking,
}))

vi.mock('ccxt', () => {
  const MockExchange = vi.fn(function (this: any) {
    this.id = 'bybit'
    this.markets = {}
    this.options = { fetchMarkets: { types: ['spot', 'linear'] } }
    this.setSandboxMode = vi.fn()
    this.loadMarkets = vi.fn().mockResolvedValue({})
    this.fetchMarkets = vi.fn().mockResolvedValue([])
    this.fetchTicker = vi.fn().mockResolvedValue({
      symbol: 'BTC/USDT:USDT',
      last: 100000,
      bid: 99999,
      ask: 100001,
      high: 101000,
      low: 98000,
      baseVolume: 123,
      timestamp: Date.now(),
    })
    this.fetchBalance = vi.fn()
    this.fetchPositions = vi.fn().mockResolvedValue([])
    this.fetchMyTrades = vi.fn()
    this.fetchOpenOrders = vi.fn()
    this.fetchClosedOrders = vi.fn()
    this.createOrder = vi.fn().mockResolvedValue({
      id: 'ord-ccxt-1',
      status: 'open',
    })
    this.cancelOrder = vi.fn().mockResolvedValue({})
    this.editOrder = vi.fn()
    this.fetchOrder = vi.fn()
    this.fetchOpenOrder = vi.fn()
    this.fetchClosedOrder = vi.fn()
    this.fetchFundingRate = vi.fn().mockResolvedValue({
      fundingRate: 0.0001,
      timestamp: Date.now(),
    })
    this.fetchOrderBook = vi.fn().mockResolvedValue({
      bids: [[99999, 1]],
      asks: [[100001, 1]],
      timestamp: Date.now(),
    })
  })

  return {
    default: {
      bybit: MockExchange,
    },
  }
})

import { Contract, OrderState, Order } from '@traderalice/ibkr'
import Decimal from 'decimal.js'
import { KillSwitch } from '../../kill-switch.js'
import {
  READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
} from '../../production-risk-preflight.js'
import type { CryptoPlaceOrderRequest } from '../../operation-dispatcher.types.js'
import type { AuthorizedBrokerWriter } from '../../broker-write-router.js'
import { TradeIdempotencyStore } from '../../idempotency-store.js'
import type {
  ProductionRiskPreflightPolicyLike,
} from '../../production-risk-preflight.js'
import { CcxtBroker } from './CcxtBroker.js'
import {
  CcxtTradingEngineAdapter,
  createCcxtExecutionBridge,
  createCcxtSlippageProtectionTracker,
  mapGitOperationToCrypto,
} from './CcxtTradingEngineAdapter.js'

const READY_PRODUCTION_RISK_POLICY: ProductionRiskPreflightPolicyLike = {
  ...READY_DENY_ONLY_PRODUCTION_RISK_POLICY,
}

const CCXT_TEST_LANE = 'ccxt_direct_test'
const CCXT_TEST_LEVERAGE = 1

function withCcxtPreflightDefaults(
  request: CryptoPlaceOrderRequest,
): CryptoPlaceOrderRequest {
  return {
    lane: CCXT_TEST_LANE,
    leverage: CCXT_TEST_LEVERAGE,
    ...request,
  }
}

function withReadyProductionRiskPolicy<T extends Record<string, unknown>>(input: T): T {
  return {
    ...input,
    cryptoExecution: {
      ...((input.cryptoExecution as Record<string, unknown> | undefined) ?? {}),
      productionRiskPreflightPolicy: READY_PRODUCTION_RISK_POLICY,
    },
  }
}

function makeSwapMarket(base: string, quote: string, symbol?: string): any {
  return {
    id: symbol ?? `${base}${quote}`,
    symbol: symbol ?? `${base}/${quote}:${quote}`,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    type: 'swap',
    active: true,
    precision: { price: 0.01 },
    limits: {},
    settle: quote.toUpperCase(),
  }
}

function setInitialized(acc: CcxtBroker, markets: Record<string, any>) {
  ;(acc as any).initialized = true
  ;(acc as any).exchange.markets = markets
}

describe('CcxtTradingEngineAdapter', () => {
  beforeEach(() => {
    releaseGateMocks.loadReleaseGateStatus.mockResolvedValue({
      version: 1,
      generatedAt: new Date().toISOString(),
      allowPaperTrading: true,
      allowLiveTrading: false,
      failedChecks: [],
      warningChecks: [],
    })
    releaseGateMocks.isReleaseGateStatusBlocking.mockReturnValue({ blocking: false })
  })

  it('passes reduceOnly and idempotency params through CCXT placeOrder', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const result = await adapter.placeOrder(withCcxtPreflightDefaults({
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      type: 'market',
      size: 0.01,
      reduceOnly: true,
      idempotencyKey: 'ticket:1',
    }))

    expect(result.success).toBe(true)
    expect((broker as any).exchange.createOrder).toHaveBeenCalledWith(
      'BTC/USDT:USDT',
      'market',
      'sell',
      0.01,
      undefined,
      { reduceOnly: true, orderLinkId: 'ticket:1' },
    )
  })

  it('cannot mint a broker write scope for adapter placeOrder outside test runtime', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    try {
      const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
      const result = await adapter.placeOrder(withCcxtPreflightDefaults({
        symbol: 'BTC/USDT:USDT',
        side: 'buy',
        type: 'market',
        size: 0.01,
      }))

      expect(result.success).toBe(false)
      expect(result.error).toContain('ccxt broker direct write is forbidden')
      expect((broker as any).exchange.createOrder).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('fails closed outside tests when production did not assemble a sidecar writer', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const broker = new CcxtBroker({
      exchange: 'bybit', apiKey: 'k', apiSecret: 's', sandbox: true,
    })
    try {
      await expect(createCcxtExecutionBridge(withReadyProductionRiskPolicy({
        accountId: 'production-sidecar-required',
        broker,
      }))).rejects.toThrow('production CCXT execution requires an explicit sidecar writer')
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('fails closed when a production sidecar assembly does not share its authority provider', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const broker = new CcxtBroker({
      exchange: 'bybit', apiKey: 'k', apiSecret: 's', sandbox: true,
    })
    ;(broker.meta as { exchange: string }).exchange = 'okx'
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn(), cancelOrder: vi.fn(), adjustLeverage: vi.fn(),
    }
    try {
      await expect(createCcxtExecutionBridge(withReadyProductionRiskPolicy({
        accountId: 'production-authority-required',
        broker,
        brokerWriteAssembly: { route: 'sidecar', writer },
      }))).rejects.toThrow('production execution sidecar requires a shared authority provider')
    } finally {
      process.env.NODE_ENV = previousNodeEnv
    }
  })

  it('maps only an explicit supported Git TIF into the sidecar request contract', () => {
    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT'
    contract.symbol = 'BTC/USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'LMT'
    order.totalQuantity = new Decimal('0.0005')
    order.lmtPrice = 100_000
    order.tif = 'GTC'
    expect(mapGitOperationToCrypto({ action: 'placeOrder', contract, order }))
      .toEqual(expect.objectContaining({
        action: 'placeOrder',
        params: expect.objectContaining({
          symbol: 'BTC/USDT', side: 'buy', type: 'limit',
          size: 0.0005, price: 100_000, timeInForce: 'GTC',
        }),
      }))

    order.tif = 'DAY'
    expect(mapGitOperationToCrypto({ action: 'placeOrder', contract, order }))
      .toEqual(expect.objectContaining({
        params: expect.objectContaining({ timeInForce: undefined }),
      }))
  })

  it('hard-blocks 100x direct adapter orders before broker submission', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const result = await adapter.placeOrder(withCcxtPreflightDefaults({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      size: 0.01,
      leverage: 100,
    }))

    expect(result.success).toBe(false)
    expect(result.error).toContain('p0d_100x_production_hard_block')
    expect(result.orderStatus).toBe('rejected')
    expect((broker as any).exchange.createOrder).not.toHaveBeenCalled()
  })

  it('maps broker positions into crypto position shape', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC'
    ;(broker as any).getPositions = vi.fn().mockResolvedValue([
      {
        contract,
        side: 'long',
        quantity: new Decimal('0.25'),
        avgCost: 90000,
        marketPrice: 95000,
        marketValue: 23750,
        unrealizedPnL: 1250,
        realizedPnL: 0,
      },
    ])

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const positions = await adapter.getPositions()

    expect(positions).toEqual([
      expect.objectContaining({
        symbol: 'BTC/USDT:USDT',
        side: 'long',
        size: 0.25,
        entryPrice: 90000,
        markPrice: 95000,
        positionValue: 23750,
      }),
    ])
  })

  it('derives realized PnL provenance from balance payloads when available', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    ;(broker as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      total: { USDT: 10000 },
      free: { USDT: 8000 },
      used: { USDT: 2000 },
      info: { totalRealizedPnl: '123.45' },
    })
    ;(broker as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        contracts: 1,
        contractSize: 1,
        markPrice: 1500,
        unrealizedPnl: 500,
        side: 'long',
      },
    ])

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const info = await adapter.getAccount()

    expect(info.realizedPnL).toBeCloseTo(123.45)
    expect(info.realizedPnlSource).toBe('balance_payload')
    expect(info.realizedPnlConfidence).toBeGreaterThan(0.9)
  })

  it('falls back to closed-trades provenance when balance payload has no realized PnL', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    ;(broker as any).exchange.fetchBalance = vi.fn().mockResolvedValue({
      total: { USDT: 10000 },
      free: { USDT: 8000 },
      used: { USDT: 2000 },
      info: {},
    })
    ;(broker as any).exchange.has = { fetchMyTrades: true }
    ;(broker as any).exchange.fetchPositions = vi.fn().mockResolvedValue([
      {
        contracts: 1,
        contractSize: 1,
        markPrice: 1500,
        unrealizedPnl: 500,
        side: 'long',
      },
    ])
    ;(broker as any).exchange.fetchMyTrades = vi.fn().mockResolvedValue([
      { id: 't1', info: { realizedPnl: '-5.5' } },
      { id: 't2', pnl: '2.25' },
    ])

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const info = await adapter.getAccount()

    expect(info.realizedPnL).toBeCloseTo(-3.25)
    expect(info.realizedPnlSource).toBe('closed_trades_ledger')
    expect(info.realizedPnlConfidence).toBeGreaterThan(0.7)
  })

  it('activates a symbol kill switch after repeated excessive slippage', () => {
    const killSwitch = new KillSwitch({ defaultPolicy: 'block_new_only' })
    const tracker = createCcxtSlippageProtectionTracker(killSwitch, 2)

    const first = tracker.observe({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      expectedPrice: 100,
      filledPrice: 101,
    })
    expect(first.breached).toBe(true)
    expect(first.activated).toBe(false)
    expect(killSwitch.get('BTC/USDT:USDT')).toBeUndefined()

    const second = tracker.observe({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      expectedPrice: 100,
      filledPrice: 101,
    })
    expect(second.breached).toBe(true)
    expect(second.activated).toBe(true)
    expect(killSwitch.get('BTC/USDT:USDT')?.policy).toBe('block_new_only')
    expect(killSwitch.check('BTC/USDT:USDT', false).blocked).toBe(true)
    expect(killSwitch.check('BTC/USDT:USDT', true).blocked).toBe(false)
  })

  it('treats missing filled price as a protective slippage breach', () => {
    const killSwitch = new KillSwitch({ defaultPolicy: 'block_new_only' })
    const tracker = createCcxtSlippageProtectionTracker(killSwitch, 1)

    const observation = tracker.observe({
      symbol: 'ETH/USDT:USDT',
      side: 'buy',
      expectedPrice: 100,
      filledPrice: undefined,
    })

    expect(observation.breached).toBe(true)
    expect(observation.activated).toBe(true)
    expect(observation.reason).toContain('MISSING_FILL_PRICE')
    expect(killSwitch.check('ETH/USDT:USDT', false).blocked).toBe(true)
  })

  it('treats non-finite filled price as a protective slippage breach', () => {
    const killSwitch = new KillSwitch({ defaultPolicy: 'block_new_only' })
    const tracker = createCcxtSlippageProtectionTracker(killSwitch, 1)

    const observation = tracker.observe({
      symbol: 'ETH/USDT:USDT',
      side: 'sell',
      expectedPrice: 100,
      filledPrice: Number.NaN,
    })

    expect(observation.breached).toBe(true)
    expect(observation.activated).toBe(true)
    expect(observation.reason).toContain('MISSING_FILL_PRICE')
    expect(killSwitch.check('ETH/USDT:USDT', false).blocked).toBe(true)
  })

  it('fails closed when a filled broker result has no auditable fill price', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })
    const orderState = new OrderState()
    orderState.status = 'Filled'
    ;(broker as any).placeOrder = vi.fn().mockResolvedValue({
      success: true,
      orderId: 'ord-missing-fill',
      orderState,
    })

    const adapter = new CcxtTradingEngineAdapter(broker, READY_PRODUCTION_RISK_POLICY)
    const result = await adapter.placeOrder(withCcxtPreflightDefaults({
      symbol: 'BTC/USDT:USDT',
      side: 'buy',
      type: 'market',
      size: 0.01,
    }))

    expect(result.success).toBe(false)
    expect(result.error).toContain('MISSING_FILL_PRICE')
    expect(result.orderStatus).toBe('filled')
  })

  it('blocks new opens when strategy runtime integration is enabled and a freeze window is active', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId: 'bybit-main',
      broker,
      strategyConfig: {
        enabled: true,
        governance: {
          useGovernanceGate: true,
          staleDataCapsExecution: true,
          preferReduceOnWeakSignal: false,
        },
        runtime: {
          marketScope: 'crypto',
          runtimeIntegrationEnabled: true,
        },
        eventCalendar: {
          enabled: true,
          events: [
            {
              name: 'CPI',
              releaseTimeUtc: Date.now() + 30 * 60_000,
              severity: 'high',
              marketScope: ['crypto'],
              freezeRule: {
                preFreezeHours: 2,
                postFreezeHours: 1,
                maxActionDuringFreeze: 'reduce',
              },
            },
          ],
        },
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: true, weight: 1 },
          volumeSurge: { enabled: true, weight: 1 },
          momentumComposite: { enabled: true, weight: 1 },
          meanReversion: { enabled: true, weight: 1 },
          volatilityRegime: { enabled: true, weight: 1 },
          liquidationPressure: { enabled: true, weight: 1 },
          crossTimeframeDivergence: { enabled: true, weight: 1 },
        },
        positionSizing: {
          enabled: true,
          method: 'fixed',
          defaultAssetLayer: 'core',
          targetVolPct: 10,
          maxPctOfEquity: 0.3,
          kellyFraction: 0.15,
          layerConfigs: [
            {
              layer: 'core',
              maxPositions: 5,
              maxPositionPctOfEquity: 0.3,
              minActionStatusToTrade: 'probe',
              requiresCoreNotRiskOff: false,
            },
          ],
        },
      },
    }))

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const result = await bridge.wrapExecuteOperation(async () => ({ success: true }))({
      action: 'placeOrder',
      contract,
      order,
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('strategy event freeze active'),
      strategy: expect.objectContaining({
        mode: 'blocked',
        actionStatus: 'reduce',
      }),
    })

    await bridge.close()
  })

  it('blocks new opens in paper_only when broker is not sandbox/demo', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: false,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId: 'bybit-main',
      broker,
      strategyConfig: {
        enabled: true,
        governance: {
          useGovernanceGate: true,
          staleDataCapsExecution: true,
          preferReduceOnWeakSignal: false,
        },
        runtime: {
          marketScope: 'crypto',
          runtimeIntegrationEnabled: true,
        },
        eventCalendar: { enabled: true, events: [] },
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: true, weight: 1 },
          volumeSurge: { enabled: true, weight: 1 },
          momentumComposite: { enabled: true, weight: 1 },
          meanReversion: { enabled: true, weight: 1 },
          volatilityRegime: { enabled: true, weight: 1 },
          liquidationPressure: { enabled: true, weight: 1 },
          crossTimeframeDivergence: { enabled: true, weight: 1 },
        },
        positionSizing: {
          enabled: true,
          method: 'fixed',
          defaultAssetLayer: 'core',
          targetVolPct: 10,
          maxPctOfEquity: 0.3,
          kellyFraction: 0.15,
          layerConfigs: [
            {
              layer: 'core',
              maxPositions: 5,
              maxPositionPctOfEquity: 0.3,
              minActionStatusToTrade: 'probe',
              requiresCoreNotRiskOff: false,
            },
          ],
        },
      },
    }))

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const result = await bridge.wrapExecuteOperation(async () => ({ success: true }))({
      action: 'placeOrder',
      contract,
      order,
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('paper_only requires sandbox/demo broker target'),
      strategy: expect.objectContaining({
        mode: 'blocked',
        actionStatus: 'no-trade',
      }),
    })

    await bridge.close()
  })

  it('forbids write operations outside test when crypto dispatcher is disabled', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    const bridge = await createCcxtExecutionBridge({
      accountId: 'bybit-disabled-dispatcher',
      broker,
      cryptoExecution: { enableCryptoDispatcher: false },
    })
    const fallback = vi.fn().mockResolvedValue({ success: true })
    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    try {
      const result = await bridge.wrapExecuteOperation(fallback)({
        action: 'placeOrder',
        contract,
        order,
      })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('crypto dispatcher is disabled'),
      })
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      await bridge.close()
    }
  })

  it('allows read-only sync fallback outside test when crypto dispatcher is disabled', async () => {
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    const bridge = await createCcxtExecutionBridge({
      accountId: 'bybit-disabled-dispatcher-sync',
      broker,
      cryptoExecution: { enableCryptoDispatcher: false },
    })
    const fallback = vi.fn().mockResolvedValue({ success: true, status: 'submitted' })

    try {
      const result = await bridge.wrapExecuteOperation(fallback)({ action: 'syncOrders' })

      expect(result).toEqual({ success: true, status: 'submitted' })
      expect(fallback).toHaveBeenCalledWith({ action: 'syncOrders' })
    } finally {
      process.env.NODE_ENV = previousNodeEnv
      await bridge.close()
    }
  })

  it('blocks unmapped CCXT write fallback when crypto dispatcher is enabled', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId: 'bybit-enabled-unmapped-write',
      broker,
    }))
    const fallback = vi.fn().mockResolvedValue({ success: true })

    try {
      const result = await bridge.wrapExecuteOperation(fallback)({
        action: 'modifyOrder',
        orderId: 'ord-001',
        changes: new Order(),
      })

      expect(result).toEqual({
        success: false,
        error: expect.stringContaining('unsupported CCXT write operation modifyOrder'),
      })
      expect(fallback).not.toHaveBeenCalled()
    } finally {
      await bridge.close()
    }
  })

  it('reconciles unresolved intents and stale idempotency records on bridge init', async () => {
    const accountId = `bybit-reconcile-${Date.now()}`
    const baseDir = resolve('data/trading', accountId)
    await rm(baseDir, { recursive: true, force: true })
    await mkdir(baseDir, { recursive: true })

    const ledgerPath = resolve(baseDir, 'intent-ledger.jsonl')
    await writeFile(
      ledgerPath,
      [
        JSON.stringify({
          type: 'intent',
          data: {
            intentId: 'intent-1',
            ticketId: 'ticket-1',
            symbol: 'BTC/USDT:USDT',
            action: 'placeOrder',
            side: 'buy',
            type: 'market',
            clientOrderId: 'ticket:ticket-1',
            createdAt: Date.now(),
          },
        }),
      ].join('\n') + '\n',
      'utf-8',
    )
    const idempotencyPath = resolve(baseDir, 'idempotency-store.json')
    await writeFile(
      idempotencyPath,
      JSON.stringify({
        records: {
          'ticket:ticket-1': {
            key: 'ticket:ticket-1',
            status: 'in_progress',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            expiresAt: Date.now() + 60_000,
            symbol: 'BTC/USDT:USDT',
            ticketId: 'ticket-1',
          },
        },
      }, null, 2) + '\n',
      'utf-8',
    )

    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })
    ;(broker as any).findOrderIdByClientOrderId = vi.fn().mockResolvedValue('ord-ccxt-1')

    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId,
      broker,
      strategyConfig: {
        enabled: true,
        governance: {
          useGovernanceGate: true,
          staleDataCapsExecution: true,
          preferReduceOnWeakSignal: false,
        },
        runtime: {
          marketScope: 'crypto',
          runtimeIntegrationEnabled: false,
        },
        eventCalendar: { enabled: true, events: [] },
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: true, weight: 1 },
          volumeSurge: { enabled: true, weight: 1 },
          momentumComposite: { enabled: true, weight: 1 },
          meanReversion: { enabled: true, weight: 1 },
          volatilityRegime: { enabled: true, weight: 1 },
          liquidationPressure: { enabled: true, weight: 1 },
          crossTimeframeDivergence: { enabled: true, weight: 1 },
        },
        positionSizing: {
          enabled: true,
          method: 'fixed',
          defaultAssetLayer: 'core',
          targetVolPct: 10,
          maxPctOfEquity: 0.3,
          kellyFraction: 0.15,
          layerConfigs: [
            {
              layer: 'core',
              maxPositions: 5,
              maxPositionPctOfEquity: 0.3,
              minActionStatusToTrade: 'probe',
              requiresCoreNotRiskOff: false,
            },
          ],
        },
      },
    }))

    const ledgerRaw = await readFile(ledgerPath, 'utf-8')
    expect(ledgerRaw).toContain('"status":"success"')
    expect(ledgerRaw).toContain('"orderId":"ord-ccxt-1"')

    const idempotencyRaw = JSON.parse(await readFile(idempotencyPath, 'utf-8'))
    expect(idempotencyRaw.records['ticket:ticket-1'].status).toBe('succeeded')
    expect(idempotencyRaw.records['ticket:ticket-1'].orderId).toBe('ord-ccxt-1')

    await bridge.close()
    await rm(baseDir, { recursive: true, force: true })
  })

  it('keeps sidecar-accepted state unresolved across restart without native CCXT reconciliation', async () => {
    const accountId = `okx-sidecar-reconcile-${Date.now()}`
    const baseDir = resolve('data/trading', accountId)
    await rm(baseDir, { recursive: true, force: true })
    await mkdir(baseDir, { recursive: true })
    const idempotencyKey = 'sidecar-restart-1'
    const commandId = 'a'.repeat(64)
    const permitV2Id = 'b'.repeat(64)
    const clientOrderId = `OA${'C'.repeat(30)}`
    const ledgerPath = resolve(baseDir, 'intent-ledger.jsonl')
    await writeFile(ledgerPath, [
      JSON.stringify({
        type: 'intent',
        data: {
          intentId: 'sidecar-intent-1', ticketId: 'ticket-sidecar-1',
          symbol: 'BTC/USDT', action: 'placeOrder', side: 'buy', type: 'limit',
          idempotencyKey, brokerWriteRoute: 'sidecar', clientOrderId,
          createdAt: Date.now() - 10_000,
        },
      }),
      JSON.stringify({
        type: 'result',
        data: {
          intentId: 'sidecar-intent-1', status: 'unknown',
          error: 'broker_outcome_pending', completedAt: Date.now() - 9_000,
          brokerWriteRoute: 'sidecar', brokerWriteOutcome: 'command_accepted',
          commandId, permitV2Id, acceptedSequence: '7', clientOrderId,
        },
      }),
    ].join('\n') + '\n', 'utf-8')
    const idempotencyPath = resolve(baseDir, 'idempotency-store.json')
    await writeFile(idempotencyPath, JSON.stringify({
      records: {
        [idempotencyKey]: {
          key: idempotencyKey, status: 'in_progress',
          createdAt: Date.now() - 10_000, updatedAt: Date.now() - 10_000,
          expiresAt: Date.now() - 1,
          symbol: 'BTC/USDT', ticketId: 'ticket-sidecar-1',
        },
      },
    }, null, 2) + '\n', 'utf-8')

    const broker = new CcxtBroker({
      exchange: 'bybit', apiKey: 'k', apiSecret: 's', sandbox: true,
    })
    ;(broker.meta as { exchange: string }).exchange = 'okx'
    const nativeFind = vi.fn().mockResolvedValue(null)
    ;(broker as any).findOrderIdByClientOrderId = nativeFind
    const writer: AuthorizedBrokerWriter = {
      placeOrder: vi.fn(), cancelOrder: vi.fn(), adjustLeverage: vi.fn(),
    }
    const getCommand = vi.fn().mockResolvedValue({
      found: true, commandId, disposition: 'accepted', acceptedSequence: '7', clientOrderId,
    })
    const closeSidecar = vi.fn()
    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId,
      broker,
      brokerWriteAssembly: {
        route: 'sidecar', writer, readModel: { getCommand }, close: closeSidecar,
      },
    }))
    try {
      expect(getCommand).toHaveBeenCalledWith(commandId)
      expect(nativeFind).not.toHaveBeenCalled()
      await expect(new TradeIdempotencyStore(idempotencyPath).get(idempotencyKey))
        .resolves.toEqual(expect.objectContaining({
          status: 'unresolved', commandId, permitV2Id,
          acceptedSequence: '7', clientOrderId,
        }))
      expect(bridge.runtime().brokerWriteRoute).toBe('sidecar')
    } finally {
      await bridge.close()
      expect(closeSidecar).toHaveBeenCalledOnce()
      await rm(baseDir, { recursive: true, force: true })
    }
  })

  it('blocks new opens when strategy sizing cannot produce a safe executable order', async () => {
    const broker = new CcxtBroker({
      exchange: 'bybit',
      apiKey: 'k',
      apiSecret: 's',
      sandbox: true,
    })
    setInitialized(broker, {
      'BTC/USDT:USDT': makeSwapMarket('BTC', 'USDT', 'BTC/USDT:USDT'),
    })

    const bridge = await createCcxtExecutionBridge(withReadyProductionRiskPolicy({
      accountId: 'bybit-main',
      broker,
      strategyConfig: {
        enabled: true,
        governance: {
          useGovernanceGate: true,
          staleDataCapsExecution: true,
          preferReduceOnWeakSignal: false,
        },
        runtime: {
          marketScope: 'crypto',
          runtimeIntegrationEnabled: true,
        },
        eventCalendar: { enabled: true, events: [] },
        factors: {
          fundingRate: { enabled: true, weight: 1 },
          basis: { enabled: true, weight: 1 },
          volumeSurge: { enabled: true, weight: 1 },
          momentumComposite: { enabled: true, weight: 1 },
          meanReversion: { enabled: true, weight: 1 },
          volatilityRegime: { enabled: true, weight: 1 },
          liquidationPressure: { enabled: true, weight: 1 },
          crossTimeframeDivergence: { enabled: true, weight: 1 },
        },
        positionSizing: {
          enabled: true,
          method: 'fixed',
          defaultAssetLayer: 'core',
          targetVolPct: 10,
          maxPctOfEquity: 0.3,
          kellyFraction: 0.15,
          layerConfigs: [
            {
              layer: 'core',
              maxPositions: 5,
              maxPositionPctOfEquity: 0.3,
              minActionStatusToTrade: 'probe',
              requiresCoreNotRiskOff: false,
            },
          ],
        },
      },
      cryptoClient: {
        getHistorical: vi.fn().mockResolvedValue(Array.from({ length: 48 }, (_, index) => {
          const startMs = Date.now() - 47 * 60 * 60_000
          return {
            date: new Date(startMs + index * 60 * 60_000).toISOString(),
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100 + index,
            volume: 1000 + index * 10,
          }
        })),
      } as any,
      accountManager: {
        resolve: vi.fn().mockReturnValue([
          {
            id: 'bybit-main',
            broker,
            getAccount: vi.fn(async () => ({ netLiquidation: 10000 })),
            getPositions: vi.fn(async () => Array.from({ length: 5 }, (_, index) => {
              const positionContract = new Contract()
              positionContract.localSymbol = 'BTC/USDT:USDT'
              positionContract.symbol = 'BTC/USDT:USDT'
              return {
                contract: positionContract,
                side: 'long',
                quantity: new Decimal('1'),
                avgCost: 100,
                marketPrice: 100,
                marketValue: 100,
                unrealizedPnL: 0,
                realizedPnL: 0,
              }
            })),
          },
        ]),
      } as any,
    }))

    const contract = new Contract()
    contract.localSymbol = 'BTC/USDT:USDT'
    contract.symbol = 'BTC/USDT:USDT'
    const order = new Order()
    order.action = 'BUY'
    order.orderType = 'MKT'
    order.totalQuantity = new Decimal('0.01')

    const result = await bridge.wrapExecuteOperation(async () => ({ success: true }))({
      action: 'placeOrder',
      contract,
      order,
    })

    expect(result).toEqual({
      success: false,
      error: expect.stringContaining('strategy action attack-lite blocked new open'),
      strategy: expect.objectContaining({
        mode: 'blocked',
      }),
    })

    await bridge.close()
  })
})
