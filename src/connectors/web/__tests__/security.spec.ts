import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connInfoMock = vi.hoisted(() => vi.fn())

vi.mock('@hono/node-server/conninfo', () => ({
  getConnInfo: connInfoMock,
}))

import {
  createRateLimitMiddleware,
  createRequireAuth,
  createRequireStrongAuth,
  createRequireTrade,
  createRuntimeRoleGuard,
} from '../routes/security.js'

describe('web security middleware', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalTradeToken = process.env.TRADE_TOKEN
  const originalDevBypass = process.env.DEV_AUTH_BYPASS
  const originalAllowUnsafeDevBypass = process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS
  const originalNodeEnv = process.env.NODE_ENV
  const originalTrustedProxies = process.env.WEB_TRUSTED_PROXIES

  beforeEach(() => {
    connInfoMock.mockReturnValue({ remote: { address: '127.0.0.1' } })
  })

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

  it('requires a strong AUTH_TOKEN and never honors the development bypass', async () => {
    process.env.AUTH_TOKEN = 'short-token'
    process.env.DEV_AUTH_BYPASS = 'true'
    process.env.ALLOW_UNSAFE_DEV_AUTH_BYPASS = 'true'
    process.env.NODE_ENV = 'development'

    const app = new Hono()
    app.use('*', createRequireStrongAuth())
    app.get('/', (c) => c.json({ ok: true }))

    expect((await app.request('/', {
      headers: { Authorization: 'Bearer short-token' },
    })).status).toBe(401)

    const strongToken = 's'.repeat(40)
    process.env.AUTH_TOKEN = strongToken
    expect((await app.request('/')).status).toBe(401)
    expect((await app.request('/', {
      headers: { Authorization: `Bearer ${strongToken}` },
    })).status).toBe(200)
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

    connInfoMock
      .mockReturnValueOnce({ remote: { address: '198.51.100.10' } })
      .mockReturnValueOnce({ remote: { address: '198.51.100.10' } })
      .mockReturnValueOnce({ remote: { address: '10.0.0.5' } })
      .mockReturnValueOnce({ remote: { address: '10.0.0.5' } })

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
        'x-forwarded-for': '2.2.2.2',
      },
    })
    const trustedSecond = await app.request('/', {
      headers: {
        'x-forwarded-for': '3.3.3.3',
      },
    })

    expect(trustedFirst.status).toBe(200)
    expect(trustedSecond.status).toBe(200)
  })

  it('keeps the research web surface read-only while allowing health reads', async () => {
    const app = new Hono()
    app.use('*', createRuntimeRoleGuard('research'))
    app.get('/', (c) => c.json({ ok: true }))
    app.post('/', (c) => c.json({ mutated: true }))

    expect((await app.request('/')).status).toBe(200)
    const denied = await app.request('/', { method: 'POST' })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({
      code: 'runtime_read_only',
      runtimeRole: 'research',
    })
  })
})
