import { describe, expect, it } from 'vitest'
import type {
  CryptoAccountInfo,
  CryptoOrder,
  CryptoPlaceOrderRequest,
  CryptoPosition,
  ICryptoTradingEngine,
  RiskConfig,
} from './operation-dispatcher.types.js'
import { preTradeRiskCheck } from './risk.js'

class MockEngine implements ICryptoTradingEngine {
  constructor(
    private readonly account: CryptoAccountInfo,
    private readonly positions: CryptoPosition[],
  ) {}

  async placeOrder(_order: CryptoPlaceOrderRequest) {
    return { success: true }
  }
  async getPositions(): Promise<CryptoPosition[]> {
    return this.positions
  }
  async getOrders(): Promise<CryptoOrder[]> {
    return []
  }
  async getAccount(): Promise<CryptoAccountInfo> {
    return this.account
  }
  async cancelOrder(_orderId: string): Promise<boolean> {
    return true
  }
  async adjustLeverage(_symbol: string, _newLeverage: number) {
    return { success: true }
  }
  async getTicker(): Promise<any> {
    return undefined
  }
  async getFundingRate(): Promise<any> {
    return undefined
  }
  async getOrderBook(): Promise<any> {
    return undefined
  }
}

const baseRisk: RiskConfig = {
  enabled: true,
  killSwitch: false,
  maxOpenPositions: 3,
  maxLeverage: 5,
  maxOrderUsd: 5_000,
  maxPositionPctOfEquity: 30,
  maxDailyLossUsd: 1_000,
}

const healthyAccount: CryptoAccountInfo = {
  balance: 10_000,
  totalMargin: 0,
  unrealizedPnL: 0,
  equity: 10_000,
  realizedPnL: 0,
  totalPnL: 0,
  realizedPnlSource: 'balance_payload',
  realizedPnlConfidence: 0.95,
}

const existingPosition: CryptoPosition = {
  symbol: 'BTC/USD',
  side: 'long',
  size: 0.1,
  entryPrice: 40_000,
  leverage: 2,
  margin: 2000,
  liquidationPrice: 20_000,
  markPrice: 42_000,
  unrealizedPnL: 200,
  positionValue: 4200,
}

describe('preTradeRiskCheck', () => {
  it('rejects orders above leverage cap', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'market',
        usd_size: 1_000,
        leverage: 10,
      },
      baseRisk,
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('exceeds')
  })

  it('rejects new non-reduce-only orders when kill switch is on', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'sell',
        type: 'market',
        usd_size: 500,
      },
      { ...baseRisk, killSwitch: true },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('Kill switch')
  })

  it('blocks new opens on daily loss soft cap breach', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'buy',
        type: 'market',
        usd_size: 500,
      },
      {
        ...baseRisk,
        dailyLossPctSoftCap: -5,
      },
      {
        dailyLossPct: -5.2,
      },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('dailyLossPctSoftCap')
  })

  it('blocks new opens when realized PnL breaches maxDailyLossUsd', async () => {
    const engine = new MockEngine(
      {
        ...healthyAccount,
        realizedPnL: -1_250,
        totalPnL: 250,
        realizedPnlSource: 'balance_payload',
        realizedPnlConfidence: 0.95,
      },
      [],
    )

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'buy',
        type: 'market',
        usd_size: 500,
      },
      baseRisk,
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('realized PnL')
  })

  it('blocks new opens when realized PnL confidence is below threshold', async () => {
    const engine = new MockEngine(
      {
        ...healthyAccount,
        realizedPnlSource: 'derived_fallback',
        realizedPnlConfidence: 0.25,
      },
      [],
    )

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'buy',
        type: 'market',
        usd_size: 500,
      },
      {
        ...baseRisk,
        enforceRealizedPnlConfidence: true,
        minRealizedPnlConfidence: 0.7,
      },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('confidence gate')
  })

  it('allows new opens when confidence gate is explicitly disabled', async () => {
    const engine = new MockEngine(
      {
        ...healthyAccount,
        realizedPnlSource: 'derived_fallback',
        realizedPnlConfidence: 0.1,
      },
      [],
    )

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'buy',
        type: 'market',
        usd_size: 200,
      },
      {
        ...baseRisk,
        enforceRealizedPnlConfidence: false,
      },
    )

    expect(res.approved).toBe(true)
  })

  it('blocks new opens on CVaR tail-loss soft cap breach', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'ETH/USD',
        side: 'buy',
        type: 'market',
        usd_size: 500,
      },
      {
        ...baseRisk,
        cvarLossPctSoftCap: -2.5,
      },
      {
        cvarDailyLossPct: -3.1,
      },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('CVaR')
  })

  it('allows reduce-only close under daily loss soft cap', async () => {
    const engine = new MockEngine(healthyAccount, [existingPosition])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'BTC/USD',
        side: 'sell',
        type: 'market',
        size: 0.05,
        reduceOnly: true,
      },
      {
        ...baseRisk,
        dailyLossPctSoftCap: -5,
      },
      {
        dailyLossPct: -8,
      },
    )

    expect(res.approved).toBe(true)
  })

  it('blocks new opens when consecutive-loss breaker triggers', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'SOL/USD',
        side: 'buy',
        type: 'market',
        usd_size: 300,
      },
      {
        ...baseRisk,
        consecutiveLossDaysLimit: 3,
        consecutiveLossPctThreshold: -2,
      },
      {
        consecutiveLossDays: 4,
        consecutiveLossPct: -3.1,
      },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('Consecutive loss breaker')
  })

  it('applies high-volatility leverage clamp from capital scale rules', async () => {
    const engine = new MockEngine(healthyAccount, [])

    const res = await preTradeRiskCheck(
      engine,
      {
        symbol: 'BTC/USD',
        side: 'buy',
        type: 'market',
        usd_size: 500,
        leverage: 3,
      },
      {
        ...baseRisk,
        highVolatilityQuantileCut: 0.95,
        capitalScaleRules: [
          {
            stage: '10%',
            maxLeverage: 5,
            highVolatilityMaxLeverage: 2,
          },
        ],
      },
      {
        capitalRampStage: '10%',
        volatilityQuantile: 0.97,
      },
    )

    expect(res.approved).toBe(false)
    expect(res.reason).toContain('maxLeverage')
  })
})
