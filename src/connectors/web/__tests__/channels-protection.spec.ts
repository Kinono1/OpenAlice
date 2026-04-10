import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readWebSubchannels: vi.fn(),
  writeWebSubchannels: vi.fn(),
}))

vi.mock('../../../core/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/config.js')>()
  return {
    ...actual,
    readWebSubchannels: mocks.readWebSubchannels,
    writeWebSubchannels: mocks.writeWebSubchannels,
  }
})

import { createChannelsRoutes } from '../routes/channels.js'
import { createRequireAuth } from '../routes/security.js'

describe('web channels protection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.AUTH_TOKEN = 'auth-token'
    delete process.env.TRADE_TOKEN
    delete process.env.DEV_AUTH_BYPASS
    mocks.readWebSubchannels.mockResolvedValue([
      {
        id: 'desk',
        label: 'Desk',
        provider: 'vercel-ai-sdk',
        vercelAiSdk: {
          provider: 'openai-compatible',
          model: 'gpt-4o-mini',
          apiKey: 'secret-openai-key',
        },
        agentSdk: {
          model: 'claude-sonnet',
          apiKey: 'secret-agent-key',
        },
      },
    ])
    mocks.writeWebSubchannels.mockResolvedValue(undefined)
  })

  it('masks provider secrets when listing channels', async () => {
    const app = new Hono()
    app.route('/api/channels', createChannelsRoutes({
      sessions: new Map(),
      sseByChannel: new Map(),
    }, { requireAuth: createRequireAuth() }))

    const res = await app.request('/api/channels', {
      headers: { Authorization: 'Bearer auth-token' },
    })

    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, any>
    const desk = body.channels.find((channel: Record<string, any>) => channel.id === 'desk')
    expect(desk.vercelAiSdk.apiKey).toBe('****-key')
    expect(desk.agentSdk.apiKey).toBe('****-key')
  })

  it('restores masked provider secrets when updating channels', async () => {
    const app = new Hono()
    app.route('/api/channels', createChannelsRoutes({
      sessions: new Map(),
      sseByChannel: new Map(),
    }, { requireAuth: createRequireAuth() }))

    const res = await app.request('/api/channels/desk', {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer auth-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        label: 'Desk 2',
        vercelAiSdk: {
          provider: 'openai-compatible',
          model: 'gpt-4o-mini',
          apiKey: '****-key',
        },
        agentSdk: {
          model: 'claude-sonnet',
          apiKey: '****-key',
        },
      }),
    })

    expect(res.status).toBe(200)
    expect(mocks.writeWebSubchannels).toHaveBeenCalledWith([
      expect.objectContaining({
        id: 'desk',
        label: 'Desk 2',
        vercelAiSdk: expect.objectContaining({ apiKey: 'secret-openai-key' }),
        agentSdk: expect.objectContaining({ apiKey: 'secret-agent-key' }),
      }),
    ])

    const body = await res.json() as Record<string, any>
    expect(body.channel.vercelAiSdk.apiKey).toBe('****-key')
    expect(body.channel.agentSdk.apiKey).toBe('****-key')
  })
})
