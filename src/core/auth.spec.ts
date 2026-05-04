import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import {
  createRequireAuth,
  createRequireTrade,
  getAuthTokens,
  isAuthEnabled,
} from './auth.js'

function withBearer(token: string) {
  return { Authorization: `Bearer ${token}` }
}

function withCookie(token: string) {
  return { Cookie: `alice_token=${encodeURIComponent(token)}` }
}

describe('auth middleware token resolution', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalTradeToken = process.env.TRADE_TOKEN

  beforeEach(() => {
    delete process.env.AUTH_TOKEN
    delete process.env.TRADE_TOKEN
  })

  afterEach(() => {
    if (originalAuthToken === undefined) {
      delete process.env.AUTH_TOKEN
    } else {
      process.env.AUTH_TOKEN = originalAuthToken
    }
    if (originalTradeToken === undefined) {
      delete process.env.TRADE_TOKEN
    } else {
      process.env.TRADE_TOKEN = originalTradeToken
    }
  })

  it('reports auth/trade token availability without fallback aliasing', () => {
    process.env.AUTH_TOKEN = 'auth-only'
    delete process.env.TRADE_TOKEN

    expect(getAuthTokens()).toEqual({
      auth: 'auth-only',
      trade: '',
      authConfigured: true,
      tradeConfigured: false,
    })
    expect(isAuthEnabled()).toBe(true)
  })

  it('rejects trade endpoints when TRADE_TOKEN is unset', async () => {
    process.env.AUTH_TOKEN = 'auth-only'
    delete process.env.TRADE_TOKEN

    const app = new Hono()
    app.use('/trade/*', createRequireTrade())
    app.get('/trade/ping', c => c.json({ ok: true }))

    const unauthorized = await app.request('/trade/ping', {
      headers: withBearer('auth-only'),
    })
    expect(unauthorized.status).toBe(401)

    const noToken = await app.request('/trade/ping')
    expect(noToken.status).toBe(401)
  })

  it('requires TRADE_TOKEN for trade endpoints when both tokens are set', async () => {
    process.env.AUTH_TOKEN = 'read-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = new Hono()
    app.use('/trade/*', createRequireTrade())
    app.get('/trade/ping', c => c.json({ ok: true }))

    const readTokenRes = await app.request('/trade/ping', {
      headers: withBearer('read-token'),
    })
    expect(readTokenRes.status).toBe(401)

    const tradeTokenRes = await app.request('/trade/ping', {
      headers: withBearer('trade-token'),
    })
    expect(tradeTokenRes.status).toBe(200)
  })

  it('leaves read endpoints open when AUTH_TOKEN is unset and enforcement is disabled', async () => {
    delete process.env.AUTH_TOKEN
    process.env.TRADE_TOKEN = 'trade-only'

    const app = new Hono()
    app.use('/read/*', createRequireAuth())
    app.get('/read/ping', c => c.json({ ok: true }))

    const res = await app.request('/read/ping')
    expect(res.status).toBe(200)
  })

  it('rejects read endpoints with query token', async () => {
    process.env.AUTH_TOKEN = 'read-token'

    const app = new Hono()
    app.use('/read/*', createRequireAuth())
    app.get('/read/ping', c => c.json({ ok: true }))

    const res = await app.request('/read/ping?token=read-token')
    expect(res.status).toBe(401)
  })

  it('allows read endpoints with auth cookie for browser resources', async () => {
    process.env.AUTH_TOKEN = 'cookie-token'

    const app = new Hono()
    app.use('/read/*', createRequireAuth())
    app.get('/read/ping', c => c.json({ ok: true }))

    const res = await app.request('/read/ping', {
      headers: withCookie('cookie-token'),
    })
    expect(res.status).toBe(200)
  })

  it('rejects when enforcement is enabled but no auth tokens are configured', async () => {
    const app = new Hono()
    app.use('/read/*', createRequireAuth(true))
    app.get('/read/ping', c => c.json({ ok: true }))

    const res = await app.request('/read/ping')
    expect(res.status).toBe(401)
  })
})
