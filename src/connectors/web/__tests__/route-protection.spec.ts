import { Hono } from 'hono'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequireAuth, createRequireTrade } from '../routes/security.js'
import { createTradingRoutes } from '../routes/trading.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from '../routes/chat.js'
import { createDevRoutes } from '../routes/dev.js'
import { createCronRoutes } from '../routes/cron.js'
import { createChannelsRoutes } from '../routes/channels.js'
import { createEventsRoutes } from '../routes/events.js'
import { createSignalRoutes } from '../routes/signals.js'
import { createToolsRoutes } from '../routes/tools.js'
import { createAgentStatusRoutes } from '../routes/agent-status.js'
import { createHeartbeatRoutes } from '../routes/heartbeat.js'
import { createMarketDataRoutes } from '../routes/config.js'

describe('openalice route protection', () => {
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

  it('requires auth for trading routes and trade auth for mutating actions', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'
    delete process.env.DEV_AUTH_BYPASS

    const ctx = {
      accountManager: {
        listAccounts: () => [],
        getAggregatedEquity: vi.fn(async () => ({ equity: 1 })),
        reconnectAccount: vi.fn(async () => ({ success: true })),
      },
    } as any

    const app = new Hono()
    app.route('/api/trading', createTradingRoutes(ctx, {
      requireAuth: createRequireAuth(),
      requireTrade: createRequireTrade(),
    }))

    expect((await app.request('/api/trading/accounts')).status).toBe(401)
    expect((await app.request('/api/trading/accounts', {
      headers: { Authorization: 'Bearer auth-token' },
    })).status).toBe(200)

    expect((await app.request('/api/trading/accounts/acc-1/reconnect', { method: 'POST' })).status).toBe(401)
    expect((await app.request('/api/trading/accounts/acc-1/reconnect', {
      method: 'POST',
      headers: { Authorization: 'Bearer trade-token' },
    })).status).toBe(200)
  })

  it('requires auth for chat and media routes and rejects traversal attempts', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS

    const ctx = {
      eventLog: { append: vi.fn(async () => ({ ts: Date.now() })) },
      agentCenter: { askWithSession: vi.fn() },
    } as any
    const sessions = new Map<string, any>([
      ['default', { readActive: vi.fn(async () => []) }],
    ])
    const sseByChannel = new Map<string, Map<string, SSEClient>>([
      ['default', new Map()],
    ])

    const app = new Hono()
    app.route('/api/chat', createChatRoutes({
      ctx,
      sessions,
      sseByChannel,
      maxSseClients: 10,
      sseMaxDurationMs: 100,
    }, { requireAuth: createRequireAuth() }))
    app.route('/api/media', createMediaRoutes({ requireAuth: createRequireAuth() }))

    expect((await app.request('/api/chat/history')).status).toBe(401)
    expect((await app.request('/api/chat/history', {
      headers: { Authorization: 'Bearer auth-token' },
    })).status).toBe(200)

    expect((await app.request('/api/media/2026-04-07/test.png')).status).toBe(401)
    expect((await app.request('/api/media/2026-04-07/..evil.png', {
      headers: { Authorization: 'Bearer auth-token' },
    })).status).toBe(400)
  })

  it('requires auth for dev, cron, channels, events, and signal readiness', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'
    delete process.env.DEV_AUTH_BYPASS

    const devApp = new Hono()
    devApp.route('/api/dev', createDevRoutes({
      list: () => [],
      getLastInteraction: () => null,
    } as any, { requireAuth: createRequireAuth() }))
    expect((await devApp.request('/api/dev/registry')).status).toBe(401)
    expect((await devApp.request('/api/dev/registry', {
      headers: { Authorization: 'Bearer auth-token' },
    })).status).toBe(200)

    const cronCtx = {
      cronEngine: {
        list: () => [],
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        runNow: vi.fn(),
      },
    } as any
    const cronApp = new Hono()
    cronApp.route('/api/cron', createCronRoutes(cronCtx, { requireAuth: createRequireAuth() }))
    expect((await cronApp.request('/api/cron/jobs')).status).toBe(401)
    expect((await cronApp.request('/api/cron/jobs', {
      headers: { Authorization: 'Bearer auth-token' },
    })).status).toBe(200)

    const channelApp = new Hono()
    channelApp.route('/api/channels', createChannelsRoutes({
      sessions: new Map(),
      sseByChannel: new Map(),
    }, { requireAuth: createRequireAuth() }))
    expect((await channelApp.request('/api/channels')).status).toBe(401)

    const eventsCtx = {
      eventLog: {
        query: vi.fn(async () => ({ entries: [] })),
        recent: vi.fn(() => []),
        lastSeq: vi.fn(() => 0),
        subscribe: vi.fn(() => () => {}),
      },
    } as any
    const eventsApp = new Hono()
    eventsApp.route('/api/events', createEventsRoutes(eventsCtx, { requireAuth: createRequireAuth() }))
    expect((await eventsApp.request('/api/events')).status).toBe(401)

    const toolsApp = new Hono()
    toolsApp.route('/api/tools', createToolsRoutes({
      getInventory: () => [],
    } as any, { requireAuth: createRequireAuth() }))
    expect((await toolsApp.request('/api/tools')).status).toBe(401)

    const agentStatusCtx = {
      toolCallLog: {
        query: vi.fn(async () => ({ entries: [] })),
        recent: vi.fn(() => []),
        lastSeq: vi.fn(() => 0),
        subscribe: vi.fn(() => () => {}),
      },
    } as any
    const agentStatusApp = new Hono()
    agentStatusApp.route('/api/agent-status', createAgentStatusRoutes(agentStatusCtx, { requireAuth: createRequireAuth() }))
    expect((await agentStatusApp.request('/api/agent-status')).status).toBe(401)

    const heartbeatCtx = {
      heartbeat: {
        isEnabled: () => true,
        setEnabled: vi.fn(async () => {}),
      },
      cronEngine: {
        list: () => [{ id: 'hb-1', name: '__heartbeat__' }],
        runNow: vi.fn(async () => {}),
      },
    } as any
    const heartbeatApp = new Hono()
    heartbeatApp.route('/api/heartbeat', createHeartbeatRoutes(heartbeatCtx, { requireAuth: createRequireAuth() }))
    expect((await heartbeatApp.request('/api/heartbeat/status')).status).toBe(401)

    const marketDataApp = new Hono()
    marketDataApp.route('/api/market-data', createMarketDataRoutes({ requireAuth: createRequireAuth() }))
    expect((await marketDataApp.request('/api/market-data/test-provider', { method: 'POST' })).status).toBe(401)

    const signalsCtx = {
      config: { engine: { pairs: ['BTC/USD'] }, strategy: { enabled: false } },
      accountManager: {
        listAccounts: () => [{ health: { status: 'healthy', disabled: false } }],
      },
      eventLog: { append: vi.fn(async () => ({})) },
    } as any
    const signalsApp = new Hono()
    signalsApp.route('/api/signals', createSignalRoutes(signalsCtx, {
      requireAuth: createRequireAuth(),
      requireTrade: createRequireTrade(),
    }))
    expect((await signalsApp.request('/api/signals/readiness')).status).toBe(401)
    expect((await signalsApp.request('/api/signals/intake', { method: 'POST' })).status).toBe(401)
  })
})
