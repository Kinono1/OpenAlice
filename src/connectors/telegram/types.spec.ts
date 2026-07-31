import { describe, expect, it } from 'vitest'
import { resolveTelegramPollingEnabled, resolveTelegramProxyUrl } from './types.js'

describe('resolveTelegramPollingEnabled', () => {
  it('keeps polling enabled by default', () => {
    expect(resolveTelegramPollingEnabled(undefined)).toBe(true)
    expect(resolveTelegramPollingEnabled('')).toBe(true)
    expect(resolveTelegramPollingEnabled('true')).toBe(true)
  })

  it('supports outbound-only shared-bot mode', () => {
    expect(resolveTelegramPollingEnabled('false')).toBe(false)
    expect(resolveTelegramPollingEnabled('0')).toBe(false)
    expect(resolveTelegramPollingEnabled('off')).toBe(false)
  })
})

describe('resolveTelegramProxyUrl', () => {
  it('prefers a Telegram-specific proxy and otherwise inherits HTTPS proxy', () => {
    expect(resolveTelegramProxyUrl({
      OPENALICE_TELEGRAM_PROXY_URL: 'http://127.0.0.1:7892',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
    })).toBe('http://127.0.0.1:7892')
    expect(resolveTelegramProxyUrl({ HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBe('http://127.0.0.1:7890')
  })

  it('supports an explicit direct route', () => {
    expect(resolveTelegramProxyUrl({ OPENALICE_TELEGRAM_PROXY_URL: 'direct', HTTPS_PROXY: 'http://127.0.0.1:7890' })).toBeNull()
  })
})
