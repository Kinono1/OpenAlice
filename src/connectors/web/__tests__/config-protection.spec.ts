import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  writeConfigSection: vi.fn(),
  readAIProviderConfig: vi.fn(),
  readMarketDataConfig: vi.fn(),
  writeAIBackend: vi.fn(),
}))

vi.mock('../../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config.js')>()
  return {
    ...actual,
    loadConfig: mocks.loadConfig,
    writeConfigSection: mocks.writeConfigSection,
    readAIProviderConfig: mocks.readAIProviderConfig,
    readMarketDataConfig: mocks.readMarketDataConfig,
    writeAIBackend: mocks.writeAIBackend,
  }
})

import { createConfigRoutes } from '../routes/config.js'

describe('web config protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS
    mocks.loadConfig.mockResolvedValue({
      engine: { pairs: ['BTC/USD'], interval: 5_000, port: 3_000 },
      agent: {},
      crypto: {},
      securities: {},
      marketData: {
        apiUrl: 'http://localhost:6900',
        providerKeys: { fred: 'fred-secret' },
      },
      compaction: {},
      aiProvider: {
        backend: 'claude-code',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        apiKeys: { anthropic: 'anthropic-secret', openai: 'openai-secret' },
      },
      heartbeat: {},
      snapshot: {},
      connectors: {
        web: { port: 3002 },
        mcp: { port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: 'telegram-secret', chatIds: [] },
      },
      news: {},
      tools: { disabled: [] },
    })
    mocks.readAIProviderConfig.mockResolvedValue({ apiKeys: { anthropic: 'anthropic-secret' } })
    mocks.readMarketDataConfig.mockResolvedValue({ apiUrl: 'http://localhost:6900' })
    mocks.writeConfigSection.mockImplementation(async (_section, body) => body)
    mocks.writeAIBackend.mockResolvedValue(undefined)
  })

  it('requires auth and masks secrets in GET /api/config', async () => {
    const app = new Hono()
    app.route('/api/config', createConfigRoutes())

    const denied = await app.request('/api/config')
    expect(denied.status).toBe(401)

    const allowed = await app.request('/api/config', {
      headers: { Authorization: 'Bearer auth-token' },
    })
    expect(allowed.status).toBe(200)

    const body = await allowed.json() as Record<string, any>
    expect(body.aiProvider.apiKeys.anthropic).toBe('****cret')
    expect(body.aiProvider.apiKeys.openai).toBe('****cret')
    expect(body.connectors.telegram.botToken).toBe('****cret')
    expect(body.marketData.providerKeys.fred).toBe('****cret')
  })

  it('preserves masked secrets when updating config sections', async () => {
    const app = new Hono()
    app.route('/api/config', createConfigRoutes())

    const res = await app.request('/api/config/connectors', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer auth-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        web: { port: 3002 },
        mcp: { port: 3001 },
        mcpAsk: { enabled: false },
        telegram: { enabled: true, botToken: '****cret', chatIds: [] },
      }),
    })

    expect(res.status).toBe(200)
    expect(mocks.writeConfigSection).toHaveBeenCalledTimes(1)
    expect(mocks.writeConfigSection).toHaveBeenCalledWith('connectors', expect.objectContaining({
      telegram: expect.objectContaining({ botToken: 'telegram-secret' }),
    }))

    const body = await res.json() as Record<string, any>
    expect(body.telegram.botToken).toBe('****cret')
  })
})
