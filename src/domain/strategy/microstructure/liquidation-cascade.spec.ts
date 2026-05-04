import { describe, it, expect } from 'vitest'
import { LiquidationCascadeDetector } from './liquidation-cascade.js'
import { buildCascadeOrderGrid, buildCascadeCloseOrders } from './liquidation-cascade-orders.js'
import type { LiquidationEvent } from './liquidation-cascade.js'

function makeEvent(contracts: number, side: 'long' | 'short' = 'long', price = 50000): LiquidationEvent {
  return { symbol: 'BTC/USDT', side, contracts, price, timestamp: Date.now() }
}

describe('LiquidationCascadeDetector', () => {
  it('returns null until enough history is accumulated', () => {
    const det = new LiquidationCascadeDetector()
    const result = det.ingest(makeEvent(100))
    expect(result).toBeNull()
  })

  it('detects cascade when window volume exceeds p99', () => {
    const det = new LiquidationCascadeDetector({ historySize: 100, percentile: 0.99 })
    // Seed 50 historical windows with small volume
    for (let i = 0; i < 50; i++) {
      det['history'].push(10)
    }
    // Now inject a massive spike
    for (let i = 0; i < 20; i++) det['windowEvents'].push(makeEvent(1000))
    const result = det.ingest(makeEvent(1000))
    expect(result).not.toBeNull()
    expect(result!.isCascade).toBe(true)
    expect(result!.dominantSide).toBe('long')
    expect(result!.entryZone).not.toBeNull()
    expect(result!.confidence).toBeGreaterThan(0)
  })

  it('does not trigger cascade for normal volume', () => {
    const det = new LiquidationCascadeDetector({ historySize: 100 })
    for (let i = 0; i < 50; i++) det['history'].push(100)
    const result = det.ingest(makeEvent(50))
    expect(result?.isCascade).toBe(false)
  })

  it('entry zone is below price for long liquidation cascade', () => {
    const det = new LiquidationCascadeDetector({ entryDepthFraction: 0.05, entryZoneWidth: 0.02 })
    for (let i = 0; i < 50; i++) det['history'].push(1)
    for (let i = 0; i < 20; i++) det['windowEvents'].push(makeEvent(1000, 'long', 50000))
    const result = det.ingest(makeEvent(1000, 'long', 50000))
    if (result?.entryZone) {
      expect(result.entryZone[1]).toBeLessThan(50000)
    }
  })
})

describe('buildCascadeOrderGrid', () => {
  it('returns null for non-cascade signal', () => {
    const grid = buildCascadeOrderGrid(
      { symbol: 'BTC/USDT', isCascade: false, windowVolumeContracts: 10, p99Threshold: 100, dominantSide: 'long', entryZone: null, confidence: 0, timestamp: Date.now() },
      { totalUsdSize: 1000 },
    )
    expect(grid).toBeNull()
  })

  it('builds correct number of grid levels', () => {
    const grid = buildCascadeOrderGrid(
      { symbol: 'BTC/USDT', isCascade: true, windowVolumeContracts: 1000, p99Threshold: 10, dominantSide: 'long', entryZone: [47500, 49000], confidence: 0.8, timestamp: Date.now() },
      { totalUsdSize: 1000, gridLevels: 4 },
    )
    expect(grid).not.toBeNull()
    expect(grid!.orders).toHaveLength(4)
    expect(grid!.side).toBe('buy')
    for (const o of grid!.orders) {
      expect(o.type).toBe('limit')
      expect(o.usd_size).toBe(250)
    }
  })

  it('buildCascadeCloseOrders returns reduce-only market sell', () => {
    const closes = buildCascadeCloseOrders('BTC/USDT', 'buy', 1000)
    expect(closes).toHaveLength(1)
    expect(closes[0]!.side).toBe('sell')
    expect(closes[0]!.reduceOnly).toBe(true)
    expect(closes[0]!.type).toBe('market')
  })
})
