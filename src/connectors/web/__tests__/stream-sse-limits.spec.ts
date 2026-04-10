import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusRoutes } from '../routes/agent-status.js'
import { createEventsRoutes } from '../routes/events.js'

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

describe('web non-chat SSE limits', () => {
  const servers: TestServer[] = []

  afterEach(() => {
    servers.forEach((server) => server.close())
    servers.length = 0
  })

  it('rejects additional event-stream clients when the cap is reached', async () => {
    const app = new Hono()
    app.route('/api/events', createEventsRoutes({
      eventLog: {
        query: vi.fn(async () => ({ entries: [] })),
        recent: vi.fn(() => []),
        lastSeq: vi.fn(() => 0),
        subscribe: vi.fn(() => () => {}),
      },
    } as any, { maxSseClients: 1, sseMaxDurationMs: 500 }))

    const server = await startServer(app)
    servers.push(server)

    const first = await fetch(`http://localhost:${server.port}/api/events/stream`)
    expect(first.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 25))

    const second = await fetch(`http://localhost:${server.port}/api/events/stream`)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({ error: 'too many SSE clients' })

    await first.body?.cancel()
  })

  it('rejects additional agent-status stream clients when the cap is reached', async () => {
    const app = new Hono()
    app.route('/api/agent-status', createAgentStatusRoutes({
      toolCallLog: {
        query: vi.fn(async () => ({ entries: [] })),
        recent: vi.fn(() => []),
        lastSeq: vi.fn(() => 0),
        subscribe: vi.fn(() => () => {}),
      },
    } as any, { maxSseClients: 1, sseMaxDurationMs: 500 }))

    const server = await startServer(app)
    servers.push(server)

    const first = await fetch(`http://localhost:${server.port}/api/agent-status/stream`)
    expect(first.status).toBe(200)

    await new Promise((resolve) => setTimeout(resolve, 25))

    const second = await fetch(`http://localhost:${server.port}/api/agent-status/stream`)
    expect(second.status).toBe(429)
    expect(await second.json()).toEqual({ error: 'too many SSE clients' })

    await first.body?.cancel()
  })
})
