import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHealthRoutes } from '../routes/health.js'
import { createSignalRoutes } from '../routes/signals.js'
import { createRequireTrade } from '../routes/security.js'

describe('web health and signals routes', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalTradeToken = process.env.TRADE_TOKEN
  const originalDevBypass = process.env.DEV_AUTH_BYPASS

  afterEach(() => {
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = originalAuthToken
    if (originalTradeToken === undefined) delete process.env.TRADE_TOKEN
    else process.env.TRADE_TOKEN = originalTradeToken
    if (originalDevBypass === undefined) delete process.env.DEV_AUTH_BYPASS
    else process.env.DEV_AUTH_BYPASS = originalDevBypass
    vi.clearAllMocks()
  })

  it('reports health and readiness based on connectors and auth tokens', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const ctx = {
      config: { engine: { pairs: ['BTC/USD', 'ETH/USD'] } },
      connectorCenter: { hasConnectors: () => false },
    } as any

    const app = new Hono()
    app.route('/api', createHealthRoutes(ctx))

    const health = await app.request('/api/health')
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({ status: 'ok' })

    const readiness = await app.request('/api/readiness')
    expect(readiness.status).toBe(503)

    const body = await readiness.json() as Record<string, any>
    expect(body.status).toBe('not-ready')
    expect(body.ready).toBe(false)
    expect(body.checks.auth.ok).toBe(true)
    expect(body.checks.auth.detail).toBe('AUTH_TOKEN configured; TRADE_TOKEN missing')
    expect(body.checks.connectors.ok).toBe(false)
  })

  it('reports not-ready when auth enforcement is enabled but tokens are missing', async () => {
    delete process.env.AUTH_TOKEN
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const ctx = {
      config: {
        auth: { enforceAuth: true },
      },
      connectorCenter: { hasConnectors: () => true },
    } as any

    const app = new Hono()
    app.route('/api', createHealthRoutes(ctx))

    const readiness = await app.request('/api/readiness')
    expect(readiness.status).toBe(503)

    const body = await readiness.json() as Record<string, any>
    expect(body.ready).toBe(false)
    expect(body.checks.auth.ok).toBe(false)
    expect(body.checks.auth.detail).toBe('AUTH_TOKEN and TRADE_TOKEN missing')
  })

  it('accepts paper signals when trading is ready and trade auth is present', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'
    delete process.env.DEV_AUTH_BYPASS

    const eventLog = {
      append: vi.fn(async (type: string, payload: unknown) => ({
        seq: 1,
        ts: Date.now(),
        type,
        payload,
      })),
    }

    const ctx = {
      config: { engine: { pairs: ['BTC/USD', 'ETH/USD'] } },
      accountManager: {
        size: 1,
        listAccounts: () => [{
          id: 'acc-1',
          label: 'Primary',
          health: { status: 'healthy', disabled: false },
        }],
      },
      eventLog,
    } as any

    const app = new Hono()
    app.route('/api/signals', createSignalRoutes(ctx, { requireTrade: createRequireTrade() }))

    const readiness = await app.request('/api/signals/readiness')
    expect(readiness.status).toBe(200)
    expect(await readiness.json()).toMatchObject({
      status: 'ready',
      ready: true,
      mode: 'paper_only',
      authEnforced: true,
      authConfigured: true,
      tradeConfigured: true,
    })

    const denied = await app.request('/api/signals/intake')
    expect(denied.status).toBe(401)

    const accepted = await app.request('/api/signals/intake', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer trade-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        signal: 'buy',
        symbol: 'BTC/USD',
      }),
    })

    expect(accepted.status).toBe(200)
    const body = await accepted.json() as Record<string, any>
    expect(body.accepted).toBe(true)
    expect(body.ready).toBe(true)
    expect(body.supportedSymbols).toEqual(['BTC/USD', 'ETH/USD'])
    expect(eventLog.append).toHaveBeenCalledWith('signal.received', expect.objectContaining({
      mode: 'paper_only',
      supportedSymbols: ['BTC/USD', 'ETH/USD'],
    }))
  })

  it('reports signal readiness as not-ready when trade auth is missing even if auth token exists', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const ctx = {
      config: { engine: { pairs: ['BTC/USD'] } },
      accountManager: {
        listAccounts: () => [{
          id: 'acc-1',
          label: 'Primary',
          health: { status: 'healthy', disabled: false },
        }],
      },
      eventLog: {
        append: vi.fn(async () => ({})),
      },
    } as any

    const app = new Hono()
    app.route('/api/signals', createSignalRoutes(ctx, { requireTrade: createRequireTrade() }))

    const readiness = await app.request('/api/signals/readiness')
    expect(readiness.status).toBe(503)
    expect(await readiness.json()).toMatchObject({
      status: 'not-ready',
      ready: false,
      authEnforced: true,
      authConfigured: true,
      tradeConfigured: false,
      reasons: ['trade_tokens_missing'],
    })
  })

  it('marks signal readiness as not-ready during an active strategy freeze window', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const ctx = {
      config: {
        engine: { pairs: ['BTC/USD'] },
        strategy: {
          enabled: true,
          runtime: {
            marketScope: 'crypto',
            runtimeIntegrationEnabled: true,
          },
          eventCalendar: {
            enabled: true,
            events: [
              {
                name: 'CPI',
                releaseTimeUtc: Date.now() + 30 * 60_000,
                severity: 'high',
                marketScope: ['crypto'],
                freezeRule: {
                  preFreezeHours: 2,
                  postFreezeHours: 1,
                  maxActionDuringFreeze: 'reduce',
                },
              },
            ],
          },
        },
      },
      accountManager: {
        listAccounts: () => [{
          id: 'acc-1',
          label: 'Primary',
          health: { status: 'healthy', disabled: false },
        }],
      },
      eventLog: {
        append: vi.fn(async () => ({})),
      },
    } as any

    const app = new Hono()
    app.route('/api/signals', createSignalRoutes(ctx, { requireTrade: createRequireTrade() }))

    const readiness = await app.request('/api/signals/readiness')
    expect(readiness.status).toBe(503)
    const body = await readiness.json() as Record<string, any>
    expect(body.ready).toBe(false)
    expect(body.strategyFreezeActive).toBe(true)
    expect(body.reasons).toContain('strategy_event_freeze_active')
  })
})
