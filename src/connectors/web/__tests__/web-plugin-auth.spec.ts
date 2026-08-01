import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  serve: vi.fn(() => ({ close: vi.fn() })),
  readWebSubchannels: vi.fn(),
  createRequireAuth: vi.fn(() => vi.fn(async (_c: unknown, next: () => Promise<void>) => next())),
  createRequireStrongAuth: vi.fn(() => vi.fn(async (_c: unknown, next: () => Promise<void>) => next())),
  createRequireTrade: vi.fn(() => vi.fn(async (_c: unknown, next: () => Promise<void>) => next())),
  createRuntimeRoleGuard: vi.fn(() => vi.fn(async (_c: unknown, next: () => Promise<void>) => next())),
  createRateLimitMiddleware: vi.fn(() => vi.fn(async (_c: unknown, next: () => Promise<void>) => next())),
}))

vi.mock('@hono/node-server', () => ({
  serve: mocks.serve,
}))

vi.mock('@hono/node-server/serve-static', () => ({
  serveStatic: () => vi.fn(async (_c: unknown, next: () => Promise<void>) => next()),
}))

vi.mock('../../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config.js')>()
  return {
    ...actual,
    readWebSubchannels: mocks.readWebSubchannels,
  }
})

vi.mock('./web-connector.js', () => ({
  WebConnector: vi.fn(),
}))

vi.mock('../routes/security.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../routes/security.js')>()
  return {
    ...actual,
    createRequireAuth: mocks.createRequireAuth,
    createRequireStrongAuth: mocks.createRequireStrongAuth,
    createRequireTrade: mocks.createRequireTrade,
    createRuntimeRoleGuard: mocks.createRuntimeRoleGuard,
    createRateLimitMiddleware: mocks.createRateLimitMiddleware,
  }
})

vi.mock('../routes/chat.js', async () => {
  const { Hono } = await import('hono')
  return {
    createChatRoutes: () => new Hono(),
    createMediaRoutes: () => new Hono(),
  }
})

vi.mock('../routes/channels.js', async () => {
  const { Hono } = await import('hono')
  return { createChannelsRoutes: () => new Hono() }
})

vi.mock('../routes/config.js', async () => {
  const { Hono } = await import('hono')
  return {
    createConfigRoutes: () => new Hono(),
    createMarketDataRoutes: () => new Hono(),
  }
})

vi.mock('../routes/events.js', async () => {
  const { Hono } = await import('hono')
  return { createEventsRoutes: () => new Hono() }
})

vi.mock('../routes/cron.js', async () => {
  const { Hono } = await import('hono')
  return { createCronRoutes: () => new Hono() }
})

vi.mock('../routes/heartbeat.js', async () => {
  const { Hono } = await import('hono')
  return { createHeartbeatRoutes: () => new Hono() }
})

vi.mock('../routes/trading.js', async () => {
  const { Hono } = await import('hono')
  return { createTradingRoutes: () => new Hono() }
})

vi.mock('../routes/trading-config.js', async () => {
  const { Hono } = await import('hono')
  return { createTradingConfigRoutes: () => new Hono() }
})

vi.mock('../routes/dev.js', async () => {
  const { Hono } = await import('hono')
  return { createDevRoutes: () => new Hono() }
})

vi.mock('../routes/tools.js', async () => {
  const { Hono } = await import('hono')
  return { createToolsRoutes: () => new Hono() }
})

vi.mock('../routes/agent-status.js', async () => {
  const { Hono } = await import('hono')
  return { createAgentStatusRoutes: () => new Hono() }
})

vi.mock('../routes/health.js', async () => {
  const { Hono } = await import('hono')
  return { createHealthRoutes: () => new Hono() }
})

vi.mock('../routes/signals.js', async () => {
  const { Hono } = await import('hono')
  return { createSignalRoutes: () => new Hono() }
})

vi.mock('../routes/strategy.js', async () => {
  const { Hono } = await import('hono')
  return { createStrategyRoutes: () => new Hono() }
})

vi.mock('../routes/system.js', async () => {
  const { Hono } = await import('hono')
  return { createSystemRoutes: () => new Hono() }
})

import { WebPlugin } from '../web-plugin.js'

function makeCtx(input?: {
  enforceAuth?: boolean
  role?: 'primary' | 'canary' | 'test'
}) {
  return {
    config: {
      auth: { enforceAuth: input?.enforceAuth ?? true },
    },
    runtime: {
      role: input?.role ?? 'primary',
    },
    reconnectConnectors: vi.fn(),
    connectorCenter: {
      register: vi.fn(() => undefined),
    },
  }
}

describe('WebPlugin auth wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readWebSubchannels.mockResolvedValue([])
  })

  it('passes auth.enforceAuth=true into protected route middleware', async () => {
    const plugin = new WebPlugin({ port: 3002 })
    await plugin.start(makeCtx({ enforceAuth: true }) as any)

    expect(mocks.createRequireAuth).toHaveBeenCalledWith(true)
    expect(mocks.createRequireStrongAuth).toHaveBeenCalledWith()
    expect(mocks.createRequireTrade).toHaveBeenCalledWith(true)
  })

  it('passes auth.enforceAuth=false into protected route middleware', async () => {
    const plugin = new WebPlugin({ port: 3002 })
    await plugin.start(makeCtx({ enforceAuth: false }) as any)

    expect(mocks.createRequireAuth).toHaveBeenCalledWith(false)
    expect(mocks.createRequireStrongAuth).toHaveBeenCalledWith()
    expect(mocks.createRequireTrade).toHaveBeenCalledWith(false)
  })

  it('mounts a fail-closed runtime role guard for canary', async () => {
    const plugin = new WebPlugin({ port: 3002 })
    await plugin.start(makeCtx({ role: 'canary' }) as any)

    expect(mocks.createRuntimeRoleGuard).toHaveBeenCalledWith('canary')
  })
})
