import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatRoutes, type SSEClient } from '../routes/chat.js'

function makeCtx() {
  return {
    eventLog: {
      append: vi.fn(),
    },
    agentCenter: {
      askWithSession: vi.fn(),
    },
  } as any
}

interface TestServer {
  port: number
  close: () => void
}

function startServer(app: Hono): Promise<TestServer> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({ port: info.port, close: () => server.close() })
    })
  })
}

describe('web chat SSE limits', () => {
  const servers: TestServer[] = []

  afterEach(() => {
    servers.forEach((server) => server.close())
    servers.length = 0
  })

  it('rejects additional SSE clients when the channel cap is reached', async () => {
    const ctx = makeCtx()
    const sessions = new Map<string, any>()
    const existingClients = new Map<string, SSEClient>([
      ['client-1', { id: 'client-1', send: vi.fn() }],
    ])
    const sseByChannel = new Map<string, Map<string, SSEClient>>([
      ['default', existingClients],
    ])

    const app = new Hono()
    app.route('/api/chat', createChatRoutes({
      ctx,
      sessions,
      sseByChannel,
      maxSseClients: 1,
      sseMaxDurationMs: 50,
    }))

    const res = await app.request('/api/chat/events')
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'too many SSE clients' })
  })

  it('closes SSE clients after the configured max duration', async () => {
    const ctx = makeCtx()
    const sessions = new Map<string, any>()
    const sseByChannel = new Map<string, Map<string, SSEClient>>([
      ['default', new Map()],
    ])

    const app = new Hono()
    app.route('/api/chat', createChatRoutes({
      ctx,
      sessions,
      sseByChannel,
      maxSseClients: 10,
      sseMaxDurationMs: 25,
    }))

    const server = await startServer(app)
    servers.push(server)

    const res = await fetch(`http://localhost:${server.port}/api/chat/events`)
    expect(res.ok).toBe(true)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const text = await res.text()
    expect(text).toContain('max-duration-reached')
    expect(text).toContain('event: closing')
  })
})
