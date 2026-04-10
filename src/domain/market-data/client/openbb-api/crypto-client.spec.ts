import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenBBCryptoClient } from './crypto-client.js'

describe('OpenBBCryptoClient.getHistorical', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to provider-compatible symbols when slash pairs return no rows', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('symbol=BTC%2FUSD')) {
        return makeResponse({ results: [] })
      }
      if (url.includes('symbol=BTC-USD')) {
        return makeResponse({
          results: [{ date: '2026-03-17', open: 1, high: 2, low: 0.5, close: 1.5 }],
        })
      }
      return makeResponse({ results: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenBBCryptoClient('http://localhost:6900')
    const rows = await client.getHistorical({
      symbol: 'BTC/USD',
      start_date: '2026-03-16',
      interval: '1h',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
  })

  it('continues fallback when the first provider call throws', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('symbol=BTC%2FUSD')) {
        return makeResponse('unsupported symbol', { ok: false, status: 400 })
      }
      if (url.includes('symbol=BTC-USD')) {
        return makeResponse({
          results: [{ date: '2026-03-17', open: 1, high: 2, low: 0.5, close: 1.5 }],
        })
      }
      return makeResponse({ results: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenBBCryptoClient('http://localhost:6900')
    const rows = await client.getHistorical({
      symbol: 'BTC/USD',
      start_date: '2026-03-16',
      interval: '1h',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(rows).toHaveLength(1)
  })

  it('rethrows the last provider error when all symbol candidates fail', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      const symbol = decodeURIComponent(url.split('symbol=')[1]?.split('&')[0] ?? '')
      return makeResponse(`unsupported ${symbol}`, { ok: false, status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const client = new OpenBBCryptoClient('http://localhost:6900')

    await expect(
      client.getHistorical({
        symbol: 'BTC/USD',
        start_date: '2026-03-16',
        interval: '1h',
      }),
    ).rejects.toThrow('OpenBB API error 400 on /price/historical')

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

function makeResponse(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): Pick<Response, 'ok' | 'status' | 'json' | 'text'> {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
  }
}
