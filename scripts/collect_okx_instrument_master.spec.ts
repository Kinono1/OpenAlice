import { describe, expect, it } from 'vitest'
import { fetchInstrumentRows } from './collect_okx_instrument_master.js'

describe('OKX instrument master fetch contract', () => {
  it('fetches OPTION instruments per public underlying instead of sending an invalid unscoped request', async () => {
    const calls: string[] = []
    const rows = await fetchInstrumentRows('OPTION', async path => {
      calls.push(path)
      if (path.includes('/underlying')) return [['ETH-USD', 'BTC-USD', 'ETH-USD'] as any]
      return [{ instId: path.includes('BTC-USD') ? 'BTC-USD-260719-58000-C' : 'ETH-USD-260719-3000-P' }]
    })
    expect(calls).toEqual([
      '/api/v5/public/underlying?instType=OPTION',
      '/api/v5/public/instruments?instType=OPTION&uly=BTC-USD',
      '/api/v5/public/instruments?instType=OPTION&uly=ETH-USD',
    ])
    expect(rows.map(row => row.instId)).toEqual(['BTC-USD-260719-58000-C', 'ETH-USD-260719-3000-P'])
  })

  it('keeps the unscoped public endpoint for non-option instruments', async () => {
    const calls: string[] = []
    await fetchInstrumentRows('SWAP', async path => { calls.push(path); return [] })
    expect(calls).toEqual(['/api/v5/public/instruments?instType=SWAP'])
  })

  it('ignores only non-addressable pre-open placeholders with an empty instId', async () => {
    const rows = await fetchInstrumentRows('FUTURES', async () => [
      { instId: '', instType: 'FUTURES', instFamily: 'KAITO-USD_UM_XPERP', state: 'preopen' },
      { instId: 'BTC-USDT-260925', instType: 'FUTURES', state: 'preopen' },
      { instId: 'ETH-USDT-260925', instType: 'FUTURES', state: 'live' },
    ])

    expect(rows.map(row => row.instId)).toEqual(['BTC-USDT-260925', 'ETH-USDT-260925'])
  })
})
