import { describe, expect, it } from 'vitest'
import { evaluateOrderBookImbalance } from './order-book-imbalance.js'
import { evaluateStablecoinFlow } from './stablecoin-flow.js'
import type { StablecoinTransfer } from './stablecoin-flow.js'

describe('evaluateOrderBookImbalance', () => {
  it('returns positive signal when bids dominate', () => {
    const result = evaluateOrderBookImbalance({
      bids: [
        { price: 50000, volume: 10 },
        { price: 49990, volume: 8 },
        { price: 49980, volume: 5 },
      ],
      asks: [
        { price: 50010, volume: 3 },
        { price: 50020, volume: 2 },
        { price: 50030, volume: 1 },
      ],
    })
    expect(result.value).toBeGreaterThan(0)
    expect(result.confidence).toBeGreaterThan(0.5)
  })

  it('returns negative signal when asks dominate', () => {
    const result = evaluateOrderBookImbalance({
      bids: [
        { price: 50000, volume: 2 },
        { price: 49990, volume: 1 },
      ],
      asks: [
        { price: 50010, volume: 10 },
        { price: 50020, volume: 8 },
      ],
    })
    expect(result.value).toBeLessThan(0)
  })

  it('returns neutral when balanced', () => {
    const result = evaluateOrderBookImbalance({
      bids: [
        { price: 50000, volume: 5 },
        { price: 49990, volume: 5 },
      ],
      asks: [
        { price: 50010, volume: 5 },
        { price: 50020, volume: 5 },
      ],
    })
    expect(Math.abs(result.value)).toBeLessThan(0.1)
  })

  it('incorporates aggressor buy ratio', () => {
    const neutral = evaluateOrderBookImbalance({
      bids: [{ price: 50000, volume: 5 }],
      asks: [{ price: 50010, volume: 5 }],
    })
    const withBuyPressure = evaluateOrderBookImbalance({
      bids: [{ price: 50000, volume: 5 }],
      asks: [{ price: 50010, volume: 5 }],
      aggressorBuyRatio: 0.8,
    })
    expect(withBuyPressure.value).toBeGreaterThan(neutral.value)
  })

  it('respects custom depth', () => {
    const deep = evaluateOrderBookImbalance({
      bids: Array.from({ length: 10 }, (_, i) => ({ price: 50000 - i * 10, volume: 1 })),
      asks: Array.from({ length: 10 }, (_, i) => ({ price: 50010 + i * 10, volume: 10 })),
      depth: 10,
    })
    expect(deep.value).toBeLessThan(0)
  })
})

describe('evaluateStablecoinFlow', () => {
  const exchangeAddresses = new Set(['0xexchange1', '0xexchange2'])
  const now = Date.now()

  it('returns bullish signal on large inflow', () => {
    const transfers: StablecoinTransfer[] = [
      {
        symbol: 'USDT',
        amount: 50_000_000,
        from: '0xwhale',
        to: '0xexchange1',
        timestamp: now - 1000,
        txHash: '0xabc',
      },
    ]
    const result = evaluateStablecoinFlow(transfers, 500_000_000, {
      exchangeAddresses,
      lookbackHours: 4,
    })
    expect(result.value).toBeGreaterThan(0)
    expect(result.confidence).toBeGreaterThan(0.3)
  })

  it('returns bearish signal on large outflow', () => {
    const transfers: StablecoinTransfer[] = [
      {
        symbol: 'USDC',
        amount: 30_000_000,
        from: '0xexchange2',
        to: '0xwhale',
        timestamp: now - 2000,
        txHash: '0xdef',
      },
    ]
    const result = evaluateStablecoinFlow(transfers, 500_000_000, {
      exchangeAddresses,
      lookbackHours: 4,
    })
    expect(result.value).toBeLessThan(0)
  })

  it('filters transfers below minimum', () => {
    const transfers: StablecoinTransfer[] = [
      {
        symbol: 'USDT',
        amount: 100_000,
        from: '0xwhale',
        to: '0xexchange1',
        timestamp: now - 1000,
        txHash: '0xghi',
      },
    ]
    const result = evaluateStablecoinFlow(transfers, 500_000_000, {
      exchangeAddresses,
      minTransferUsd: 1_000_000,
    })
    expect(result.value).toBe(0)
    expect(result.metadata.transferCount).toBe(0)
  })

  it('filters transfers outside lookback window', () => {
    const transfers: StablecoinTransfer[] = [
      {
        symbol: 'USDT',
        amount: 10_000_000,
        from: '0xwhale',
        to: '0xexchange1',
        timestamp: now - 10 * 3600_000, // 10 hours ago
        txHash: '0xjkl',
      },
    ]
    const result = evaluateStablecoinFlow(transfers, 500_000_000, {
      exchangeAddresses,
      lookbackHours: 4,
    })
    expect(result.metadata.transferCount).toBe(0)
  })

  it('detects known exchange addresses by tag', () => {
    const transfers: StablecoinTransfer[] = [
      {
        symbol: 'USDT',
        amount: 20_000_000,
        from: '0xwhale',
        to: '0xBinanceHotWallet',
        timestamp: now - 1000,
        txHash: '0xmno',
      },
    ]
    const result = evaluateStablecoinFlow(transfers, 500_000_000, { lookbackHours: 4 })
    expect(result.value).toBeGreaterThan(0)
  })
})
