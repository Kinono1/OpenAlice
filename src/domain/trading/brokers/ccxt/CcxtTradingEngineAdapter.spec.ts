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
import { CcxtBroker } from './CcxtBroker.js'
import { CcxtTradingEngineAdapter, createCcxtExecutionBridge } from './CcxtTradingEngineAdapter.js'

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

    const adapter = new CcxtTradingEngineAdapter(broker)
    const result = await adapter.placeOrder({
      symbol: 'BTC/USDT:USDT',
      side: 'sell',
      type: 'market',
      size: 0.01,
      reduceOnly: true,
      idempotencyKey: 'ticket:1',
    })

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

    const adapter = new CcxtTradingEngineAdapter(broker)
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

    const bridge = await createCcxtExecutionBridge({
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
    })

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

    const bridge = await createCcxtExecutionBridge({
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
    })

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

    const bridge = await createCcxtExecutionBridge({
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
    })

    const ledgerRaw = await readFile(ledgerPath, 'utf-8')
    expect(ledgerRaw).toContain('"status":"success"')
    expect(ledgerRaw).toContain('"orderId":"ord-ccxt-1"')

    const idempotencyRaw = JSON.parse(await readFile(idempotencyPath, 'utf-8'))
    expect(idempotencyRaw.records['ticket:ticket-1'].status).toBe('succeeded')
    expect(idempotencyRaw.records['ticket:ticket-1'].orderId).toBe('ord-ccxt-1')

    await bridge.close()
    await rm(baseDir, { recursive: true, force: true })
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

    const bridge = await createCcxtExecutionBridge({
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
        getHistorical: vi.fn().mockResolvedValue(Array.from({ length: 48 }, (_, index) => ({
          date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
          open: 100 + index,
          high: 101 + index,
          low: 99 + index,
          close: 100 + index,
          volume: 1000 + index * 10,
        }))),
      } as any,
      accountManager: {
        resolve: vi.fn().mockReturnValue([]),
      } as any,
    })

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
