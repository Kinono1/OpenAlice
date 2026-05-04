import { describe, expect, it } from 'vitest'
import { createUrl, getData, getDataMany, getDataUrls } from './helpers.js'

describe('fmp helpers auth injection', () => {
  it('appends api key in createUrl without inline callers building it', () => {
    const url = createUrl(3, 'profile', 'secret123', { symbol: 'AAPL' })
    expect(url).toContain('symbol=AAPL')
    expect(url).toContain('apikey=secret123')
  })

  it('keeps existing query params when appending api key', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      expect(url).toContain('symbol=BTC')
      expect(url).toContain('apikey=secret123')
      return new Response(JSON.stringify([{ symbol: 'BTC' }]), { status: 200 })
    }) as typeof fetch

    try {
      const one = await getData<unknown[]>('https://example.test/path?symbol=BTC', { apiKey: 'secret123' })
      expect(one).toEqual([{ symbol: 'BTC' }])

      const many = await getDataMany('https://example.test/path?symbol=BTC', undefined, { apiKey: 'secret123' })
      expect(many).toEqual([{ symbol: 'BTC' }])

      const urls = await getDataUrls<unknown[]>(['https://example.test/path?symbol=BTC'], { apiKey: 'secret123' })
      expect(urls).toEqual([[{ symbol: 'BTC' }]])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('supports header auth branch without leaking api key into url', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      expect(url).toContain('symbol=BTC')
      expect(url).not.toContain('apikey=secret123')
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('secret123')
      return new Response(JSON.stringify([{ symbol: 'BTC' }]), { status: 200 })
    }) as typeof fetch

    try {
      const many = await getDataMany('https://example.test/path?symbol=BTC', undefined, {
        apiKey: 'secret123',
        authMode: 'header',
      })
      expect(many).toEqual([{ symbol: 'BTC' }])

      const url = createUrl(3, 'profile', 'secret123', { symbol: 'AAPL' }, undefined, { authMode: 'header' })
      expect(url).toContain('symbol=AAPL')
      expect(url).not.toContain('apikey=secret123')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
