import { afterEach, describe, expect, it } from 'vitest'
import { tool } from 'ai'
import { z } from 'zod'
import { buildMcpToolRegistration, createMcpApp } from './mcp.js'
import { ToolCenter } from '../core/tool-center.js'

describe('buildMcpToolRegistration', () => {
  it('falls back to the tool name when description is missing', () => {
    const tool = {
      inputSchema: {
        shape: {
          symbol: { type: 'string' },
        },
      },
    }

    expect(buildMcpToolRegistration('fetchPrice', tool)).toEqual({
      description: 'fetchPrice',
      inputSchema: {
        symbol: { type: 'string' },
      },
    })
  })

  it('preserves an explicit description', () => {
    const tool = {
      description: 'Fetch the current price',
      inputSchema: {},
    }

    expect(buildMcpToolRegistration('fetchPrice', tool)).toEqual({
      description: 'Fetch the current price',
      inputSchema: {},
    })
  })
})

describe('createMcpApp', () => {
  const originalAuthToken = process.env.AUTH_TOKEN
  const originalTradeToken = process.env.TRADE_TOKEN

  afterEach(() => {
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN
    else process.env.AUTH_TOKEN = originalAuthToken

    if (originalTradeToken === undefined) delete process.env.TRADE_TOKEN
    else process.env.TRADE_TOKEN = originalTradeToken
  })

  function createApp() {
    const toolCenter = new ToolCenter()
    toolCenter.register({
      pingTool: tool({
        description: 'Return a pong response',
        inputSchema: z.object({}),
        execute: async () => ({ ok: true }),
      }),
    }, 'test')

    return createMcpApp({
      toolCenter,
      enforceAuth: true,
    })
  }

  it('rejects unauthenticated GET requests', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = createApp()
    const res = await app.request('/mcp')

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  it('rejects malformed JSON before reaching the MCP transport', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = createApp()
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'content-type': 'application/json',
      },
      body: '{not-json',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid JSON body' })
  })

  it('rejects non-JSON POST bodies', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = createApp()
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'content-type': 'text/plain',
      },
      body: 'tools/list',
    })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'expected application/json' })
  })

  it('requires the auth token for read-only JSON-RPC requests', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = createApp()

    const unauthorized = await app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
      }),
    })

    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'unauthorized' })

    const authorized = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '2',
        method: 'tools/list',
      }),
    })

    expect(authorized.status).not.toBe(401)
  })

  it('requires the trade token for tools/call requests', async () => {
    process.env.AUTH_TOKEN = 'auth-token'
    process.env.TRADE_TOKEN = 'trade-token'

    const app = createApp()

    const readOnlyToken = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer auth-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '3',
        method: 'tools/call',
        params: {
          name: 'pingTool',
          arguments: {},
        },
      }),
    })

    expect(readOnlyToken.status).toBe(401)
    expect(await readOnlyToken.json()).toEqual({ error: 'unauthorized' })

    const tradeToken = await app.request('/mcp', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer trade-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '4',
        method: 'tools/call',
        params: {
          name: 'pingTool',
          arguments: {},
        },
      }),
    })

    expect(tradeToken.status).not.toBe(401)
  })
})
