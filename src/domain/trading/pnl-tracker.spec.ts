import { describe, expect, it } from 'vitest'
import { PnLTracker } from './pnl-tracker.js'

describe('PnLTracker', () => {
  it('tracks avg cost and FIFO on fills', () => {
    const tracker = new PnLTracker()
    tracker.recordFill({
      symbol: 'BTC/USD',
      side: 'buy',
      size: 1,
      price: 100,
      timestamp: 1,
    })
    tracker.recordFill({
      symbol: 'BTC/USD',
      side: 'sell',
      size: 0.5,
      price: 120,
      timestamp: 2,
    })

    const avg = tracker.getAvgCostPosition('BTC/USD')
    const fifo = tracker.getFIFOPosition('BTC/USD')

    expect(avg?.realizedPnL).toBe(10)
    expect(fifo?.realizedPnL).toBe(10)
  })

  it('reconciles avg cost vs fifo', () => {
    const tracker = new PnLTracker({ reconciliationThresholdPct: 1 })
    tracker.recordFill({
      symbol: 'ETH/USD',
      side: 'buy',
      size: 1,
      price: 200,
      timestamp: 1,
    })
    tracker.updateMarkPrice('ETH/USD', 210)

    const pos = tracker.getAvgCostPosition('ETH/USD')
    expect(pos?.unrealizedPnL).toBe(10)
    expect(tracker.reconcile('ETH/USD').alert).toBe(false)
  })
})

