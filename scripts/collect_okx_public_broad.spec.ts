import { describe, expect, it } from 'vitest'
import type { OkxInstrumentRecord } from '../src/domain/market-data/okx-warehouse-types.js'
import { mapDerivativeBatchRows, selectBroadInstruments } from './collect_okx_public_broad.js'

function instrument(instrumentId: string, instrumentType: 'SPOT' | 'SWAP', settleCurrency: string | null, quoteCurrency: string | null): OkxInstrumentRecord {
  return {
    schemaVersion: 'okx_instrument.v1', exchange: 'okx', instrumentId, instrumentType, instrumentFamily: null,
    underlying: null, baseCurrency: null, quoteCurrency, settleCurrency, contractValue: null, contractMultiplier: null,
    tickSize: '1', lotSize: '1', minimumOrderSize: '1', listingTime: null, expiryTime: null,
    optionType: null, strikePrice: null, state: 'live', marginEligibility: null,
    eventTime: '2026-07-18T00:00:00Z', availableAt: '2026-07-18T00:00:01Z', payloadHash: instrumentId,
  }
}

describe('collect_okx_public_broad selection', () => {
  it('applies explicit canary symbols to both candles and derivative snapshots', () => {
    const master = [
      instrument('BTC-USDT-SWAP', 'SWAP', 'USDT', null),
      instrument('ETH-USDT-SWAP', 'SWAP', 'USDT', null),
      instrument('BTC-USDT', 'SPOT', null, 'USDT'),
    ]
    const selected = selectBroadInstruments(master, new Set(['BTC-USDT-SWAP']))
    expect(selected.broad.map(item => item.instrumentId)).toEqual(['BTC-USDT-SWAP'])
    expect(selected.swaps.map(item => item.instrumentId)).toEqual(['BTC-USDT-SWAP'])
  })

  it('maps batched OI and mark/index rows without filling missing values with zero', () => {
    const swap = { ...instrument('BTC-USDT-SWAP', 'SWAP', 'USDT', null), instrumentFamily: 'BTC-USDT' }
    const rows = mapDerivativeBatchRows([swap], {
      openInterest: [{ instId: 'BTC-USDT-SWAP', oi: '10', oiUsd: '1000', ts: '1784367000000' }],
      marks: [{ instId: 'BTC-USDT-SWAP', markPx: '101', ts: '1784367000001' }],
      indices: [{ instId: 'BTC-USDT', idxPx: '100', ts: '1784367000002' }],
    }, '2026-07-18T09:30:03.000Z', 'broad-batch-test')
    expect(rows.map(row => row.dataset)).toEqual(['open_interest', 'mark_index'])
    expect(rows[1].payload).toMatchObject({ markPx: 101, indexPx: 100, premium: 0.01 })
    const missing = mapDerivativeBatchRows([swap], { openInterest: [], marks: [{ instId: 'BTC-USDT-SWAP', markPx: '101', ts: '1784367000001' }], indices: [] }, '2026-07-18T09:30:03.000Z', 'broad-batch-missing')
    expect(missing[0].payload).toMatchObject({ markPx: 101, indexPx: null, premium: null })
  })
})
