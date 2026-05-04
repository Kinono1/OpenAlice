import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { Plugin, EngineContext } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'
import { extractMcpShape, wrapToolExecute } from '../core/mcp-export.js'
import type { Tool } from 'ai'

export function buildMcpToolRegistration(name: string, tool: {
  description?: string
  inputSchema?: unknown
}) {
  return {
    description: tool.description ?? name,
    inputSchema: extractMcpShape(tool as Tool),
  }
}

/**
 * MCP Plugin — exposes tools via Streamable HTTP.
 *
 * Holds a reference to ToolCenter and queries it per-request, so tool
 * changes (reconnect, disable/enable) are picked up automatically.
 */
export class McpPlugin implements Plugin {
  name = 'mcp'
  private server: ReturnType<typeof serve> | null = null

  constructor(
    private toolCenter: ToolCenter,
    private port: number,
  ) {}

  async start(_ctx: EngineContext) {
    const toolCenter = this.toolCenter

    const createMcpServer = async () => {
      const tools = await toolCenter.getMcpTools()
      const mcp = new McpServer({ name: 'open-alice', version: '1.0.0' })

      for (const [name, t] of Object.entries(tools)) {
        if (!t.execute) continue

        mcp.registerTool(name, buildMcpToolRegistration(name, t), wrapToolExecute(t))
      }

      return mcp
    }

    const app = new Hono()

    app.use('*', cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
      exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
    }))

    app.all('/mcp', async (c) => {
      const transport = new WebStandardStreamableHTTPServerTransport()
      const mcp = await createMcpServer()
      await mcp.connect(transport)
      return transport.handleRequest(c.req.raw)
    })

    this.server = serve({ fetch: app.fetch, port: this.port }, (info) => {
      console.log(`mcp plugin listening on http://localhost:${info.port}/mcp`)
    })
  }

  async stop() {
    this.server?.close()
  }
}
