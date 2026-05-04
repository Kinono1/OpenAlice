import { describe, expect, it } from 'vitest'
import { redactUrlForLogs } from '../helpers.js'

describe('redactUrlForLogs', () => {
  it('redacts sensitive query params', () => {
    const redacted = redactUrlForLogs('https://example.test/path?apikey=secret123&symbol=BTC&token=abc')
    expect(redacted).toContain('apikey=***REDACTED***')
    expect(redacted).toContain('token=***REDACTED***')
    expect(redacted).toContain('symbol=BTC')
    expect(redacted).not.toContain('secret123')
    expect(redacted).not.toContain('token=abc')
  })

  it('falls back for invalid urls', () => {
    const redacted = redactUrlForLogs('/relative?api_key=secret123&foo=bar')
    expect(redacted).toContain('api_key=***REDACTED***')
    expect(redacted).toContain('foo=bar')
    expect(redacted).not.toContain('secret123')
  })
})
