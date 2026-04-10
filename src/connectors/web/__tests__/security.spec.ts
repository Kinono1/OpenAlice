import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimitMiddleware, createRequireAuth, createRequireTrade } from '../routes/security.js'

describe('web security middleware', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalTradeToken = process.env.TRADE_TOKEN
  const originalDevBypass = process.env.DEV_AUTH_BYPASS
  const originalAllowUnsafeDevBypass = process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS
  const originalNodeEnv = process.env.NODE_ENV
  const originalTrustedProxies = process.env.WEB_TRUSTED_PROXIES

  afterEach(() => {
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = originalAuthToken
    if (originalTradeToken === undefined) delete process.env.TRADE_TOKEN
    else process.env.TRADE_TOKEN = originalTradeToken
    if (originalDevBypass === undefined) delete process.env.DEV_AUTH_BYPASS
    else process.env.DEV_AUTH_BYPASS = originalDevBypass
    if (originalAllowUnsafeDevBypass === undefined) delete process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS
    else process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS = originalAllowUnsafeDevBypass
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalTrustedProxies === undefined) delete process.env.WEB_TRUSTED_PROXIES
    else process.env.WEB_TRUSTED_PROXIES = originalTrustedProxies
    vi.clearAllMocks()
  })

  it('requires AUTH_TOKEN for protected routes', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const app = new Hono()
    app.use('*', createRequireAuth())
    app.get('/', (c) => c.json({ ok: true }))

    const denied = await app.request('/')
    expect(denied.status).toBe(401)

    const allowed = await app.request('/', {
      headers: { Authorization: 'Bearer auth-token' },
    })
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({ ok: true })
  })

  it('rejects trade routes when only AUTH_TOKEN is configured', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const app = new Hono()
    app.use('*', createRequireTrade())
    app.get('/', (c) => c.json({ ok: true }))

    const denied = await app.request('/', {
      headers: { Authorization: 'Bearer auth-token' },
    })
    expect(denied.status).toBe(401)
  })

  it('requires trade token and accepts alice_token cookie', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'
    delete process.env.DEV_AUTH_BYPASS

    const app = new Hono()
    app.use('*', createRequireTrade())
    app.get('/', (c) => c.json({ ok: true }))

    const denied = await app.request('/')
    expect(denied.status).toBe(401)

    const allowed = await app.request('/', {
      headers: { Cookie: 'alice_token=trade-token' },
    })
    expect(allowed.status).toBe(200)
  })

  it('rate limits repeated requests from the same client', async () => {
    const app = new Hono()
    app.use('*', createRateLimitMiddleware({ maxRequests: 2, windowMs: 1_000 }))
    app.get('/', (c) => c.json({ ok: true }))

    expect((await app.request('/')).status).toBe(200)
    expect((await app.request('/')).status).toBe(200)
    const denied = await app.request('/')
    expect(denied.status).toBe(429)
    expect(denied.headers.get('Retry-After')).toBeTruthy()
  })

  it('does not honor DEV_AUTH_BYPASS without explicit unsafe opt-in', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.DEV_AUTH_BYPASS = 'true'
    delete process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS
    delete process.env.NODE_ENV

    const app = new Hono()
    app.use('*', createRequireAuth())
    app.get('/', (c) => c.json({ ok: true }))

    const denied = await app.request('/')
    expect(denied.status).toBe(401)
  })

  it('does not honor DEV_AUTH_BYPASS outside development mode', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.DEV_AUTH_BYPASS = 'true'
    process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS = 'true'
    process.env.NODE_ENV = 'test'

    const app = new Hono()
    app.use('*', createRequireAuth())
    app.get('/', (c) => c.json({ ok: true }))

    const denied = await app.request('/')
    expect(denied.status).toBe(401)
  })

  it('only trusts forwarded headers when the remote source is configured as a trusted proxy', async () => {
    process.env.WEB_TRUSTED_PROXIES = '10.0.0.0/8'

    const app = new Hono()
    app.use('*', createRateLimitMiddleware({ maxRequests: 1, windowMs: 1_000 }))
    app.get('/', (c) => c.json({ ok: true }))

    expect((await app.request('/', {
      headers: {
        'x-forwarded-for': '1.2.3.4',
      },
    })).status).toBe(200)
    expect((await app.request('/', {
      headers: {
        'x-forwarded-for': '9.9.9.9',
      },
    })).status).toBe(429)

    const trustedFirst = await app.request('/', {
      headers: {
        'x-openclaw-remote-addr': '10.0.0.5',
        'x-forwarded-for': '2.2.2.2',
      },
    })
    const trustedSecond = await app.request('/', {
      headers: {
        'x-openclaw-remote-addr': '10.0.0.5',
        'x-forwarded-for': '3.3.3.3',
      },
    })

    expect(trustedFirst.status).toBe(429)
    expect(trustedSecond.status).toBe(429)
  })
})
