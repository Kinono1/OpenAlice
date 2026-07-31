import { afterEach, describe, expect, it } from 'vitest'
import { resolveOkxPublicApiBaseUrls, resolveProxyUrl } from './live-fetcher.js'

const proxyEnvKeys = [
  'OPENALICE_MARKET_DATA_BYPASS_PROXY',
  'OPENALICE_MARKET_DATA_PROXY_URL',
  'OPENALICE_OKX_PUBLIC_API_BASE_URLS',
  'OPENALICE_OKX_PUBLIC_API_HOSTS',
  'OPENALICE_OKX_PUBLIC_API_HOST',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
] as const

const originalEnv = new Map<string, string | undefined>(
  proxyEnvKeys.map(key => [key, process.env[key]]),
)

describe('live market data proxy resolution', () => {
  afterEach(() => {
    for (const key of proxyEnvKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  })

  it('honors explicit market-data proxy before generic proxy variables', () => {
    clearProxyEnv()
    process.env.OPENALICE_MARKET_DATA_PROXY_URL = ' http://127.0.0.1:9999 '
    process.env.https_proxy = 'http://127.0.0.1:7892'

    expect(resolveProxyUrl()).toBe('http://127.0.0.1:9999')
  })

  it('can explicitly bypass generic proxy variables for public market data', () => {
    clearProxyEnv()
    process.env.OPENALICE_MARKET_DATA_BYPASS_PROXY = 'true'
    process.env.https_proxy = ' http://127.0.0.1:7892 '

    expect(resolveProxyUrl()).toBeNull()
  })

  it('treats an explicit direct market-data proxy value as no proxy', () => {
    clearProxyEnv()
    process.env.OPENALICE_MARKET_DATA_PROXY_URL = 'direct'
    process.env.https_proxy = ' http://127.0.0.1:7892 '

    expect(resolveProxyUrl()).toBeNull()
  })

  it('falls back to lower-case proxy variables used by launchd plists', () => {
    clearProxyEnv()
    process.env.https_proxy = ' http://127.0.0.1:7892 '

    expect(resolveProxyUrl()).toBe('http://127.0.0.1:7892')
  })

  it('returns null when no proxy variable is configured', () => {
    clearProxyEnv()

    expect(resolveProxyUrl()).toBeNull()
  })

  it('keeps OKX public host fallbacks available for domain or regional TLS failures', () => {
    clearProxyEnv()
    process.env.OPENALICE_OKX_PUBLIC_API_HOSTS = 'https://custom.okx.test, us.okx.com'

    expect(resolveOkxPublicApiBaseUrls()).toEqual([
      'https://custom.okx.test',
      'https://us.okx.com',
      'https://www.okx.com',
      'https://aws.okx.com',
      'https://eea.okx.com',
    ])
  })

  it('defaults OKX public data fetches to all known production hosts', () => {
    clearProxyEnv()

    expect(resolveOkxPublicApiBaseUrls()).toEqual([
      'https://www.okx.com',
      'https://aws.okx.com',
      'https://eea.okx.com',
      'https://us.okx.com',
    ])
  })
})

function clearProxyEnv(): void {
  for (const key of proxyEnvKeys) {
    delete process.env[key]
  }
}
