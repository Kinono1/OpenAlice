import { describe, expect, it } from 'vitest'
import type { OkxInstrumentRecord } from '../src/domain/market-data/okx-warehouse-types.js'
import { applyHysteresis, rankEligibleSwaps, selectTopMinute } from './select_okx_depth_universe.js'

const instrument = (id: string): OkxInstrumentRecord => ({ schemaVersion: 'okx_instrument.v1', exchange: 'okx', instrumentId: id, instrumentType: 'SWAP', instrumentFamily: id.replace('-SWAP', ''), underlying: null, baseCurrency: id.split('-')[0], quoteCurrency: 'USDT', settleCurrency: 'USDT', contractValue: null, contractMultiplier: null, tickSize: '0.1', lotSize: '1', minimumOrderSize: '1', listingTime: null, expiryTime: null, optionType: null, strikePrice: null, state: 'live', marginEligibility: null, eventTime: '2026-07-18T00:00:00Z', availableAt: '2026-07-18T00:00:01Z', payloadHash: id })

describe('depth universe', () => {
  it('ranks liquid tight-spread swaps deterministically', () => {
    const ranked = rankEligibleSwaps([instrument('A-USDT-SWAP'), instrument('B-USDT-SWAP'), instrument('C-USDT-SWAP')], new Map([
      ['A-USDT-SWAP', { quoteVolume24h: 100, spreadBps: 3 }], ['B-USDT-SWAP', { quoteVolume24h: 200, spreadBps: 5 }], ['C-USDT-SWAP', { quoteVolume24h: 1000, spreadBps: 70 }],
    ]), new Set(), 50)
    expect(ranked.map(item => item.instrumentId)).toEqual(['B-USDT-SWAP', 'A-USDT-SWAP'])
  })

  it('limits changes and requires challenger improvement', () => {
    const ranked = [
      { instrumentId: 'C', score: 0.9 }, { instrumentId: 'D', score: 0.8 }, { instrumentId: 'A', score: 0.5 }, { instrumentId: 'B', score: 0.49 },
    ].map(item => ({ ...item, quoteTurnover24h: 1, spreadBps: 1, turnoverPercentile: item.score, inverseSpreadPercentile: item.score }))
    const selected = applyHysteresis({ ranked, previous: ['A', 'B'], count: 2, maxChanges: 1, challengerImprovementPct: 10 })
    expect(selected).toHaveLength(2)
    expect(selected.filter(id => !['A', 'B'].includes(id))).toHaveLength(1)
  })

  it('includes USDT-settled swaps even when quote currency is absent', () => {
    const swap = { ...instrument('BTC-USDT-SWAP'), quoteCurrency: null }
    const spot = { ...instrument('ETH-USDT'), instrumentType: 'SPOT' as const, settleCurrency: null, quoteCurrency: 'USDT' }
    expect(selectTopMinute([swap, spot], new Map([
      [swap.instrumentId, { quoteVolume24h: 200 }],
      [spot.instrumentId, { quoteVolume24h: 100 }],
    ]), 50)).toEqual(['BTC-USDT-SWAP', 'ETH-USDT'])
  })
})
