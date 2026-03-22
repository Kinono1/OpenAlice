import { describe, expect, it, vi } from 'vitest'
import { OpenBBCryptoClient } from '@/domain/market-data/client/openbb-api/crypto-client.js'
import { createAnalysisTools } from './analysis.js'

describe('createAnalysisTools', () => {
  it('falls back to provider-compatible crypto symbols when slash symbols error', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.includes('symbol=BTC%2FUSD')) {
        return makeResponse('unsupported symbol', { ok: false, status: 400 })
      }
      if (url.includes('symbol=BTC-USD')) {
        return makeResponse({
          results: [
            { date: '2026-03-17T10:00:00.000Z', open: 95000, high: 96000, low: 94000, close: 95500, volume: 100 },
            { date: '2026-03-17T11:00:00.000Z', open: 95500, high: 96500, low: 94500, close: 95800, volume: 110 },
          ],
        })
      }
      return makeResponse({ results: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const tools = createAnalysisTools(
      { getHistorical: vi.fn() },
      new OpenBBCryptoClient('http://localhost:6900'),
      { getHistorical: vi.fn() },
    )

    const result = await (tools.calculateIndicator.execute as Function)({
      asset: 'crypto',
      formula: "CLOSE('BTC/USD', '1h')[-1]",
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toBe(95800)
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
