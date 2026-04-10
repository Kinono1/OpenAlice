/**
 * Tool bridge — converts ToolCenter's Vercel AI SDK tools to an Agent SDK MCP server.
 *
 * Reuses the same pattern as `src/server/mcp.ts` (extract .shape, wrap execute),
 * but targets `createSdkMcpServer()` instead of `@modelcontextprotocol/sdk McpServer`.
 */

import { randomUUID } from 'node:crypto'
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import type { Tool } from 'ai'

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }

/**
 * Convert a Vercel AI SDK tool result to MCP content blocks.
 * Handles both plain values and OpenClaw AgentToolResult `{ content: [...] }` format.
 */
function toMcpContent(result: unknown): McpContent[] {
  if (
    result != null &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as { content: unknown }).content)
  ) {
    const items = (result as { content: Array<Record<string, unknown>> }).content
    const blocks: McpContent[] = []
    for (const item of items) {
      if (item.type === 'image' && typeof item.data === 'string' && typeof item.mimeType === 'string') {
        blocks.push({ type: 'image', data: item.data, mimeType: item.mimeType })
      } else if (item.type === 'text' && typeof item.text === 'string') {
        blocks.push({ type: 'text', text: item.text })
      } else {
        blocks.push({ type: 'text', text: JSON.stringify(item) })
      }
    }
    if ('details' in result && (result as { details: unknown }).details != null) {
      blocks.push({ type: 'text', text: JSON.stringify((result as { details: unknown }).details) })
    }
    return blocks.length > 0 ? blocks : [{ type: 'text', text: JSON.stringify(result) }]
  }
  return [{ type: 'text', text: JSON.stringify(result) }]
}

/**
 * Build an Agent SDK MCP server from a Vercel AI SDK tool map.
 *
 * @param tools  Record<name, Tool> from ToolCenter.getVercelTools()
 * @param disabledTools  Optional list of tool names to exclude
 * @returns McpSdkServerConfigWithInstance ready for `query({ options: { mcpServers } })`
 */
export function buildAgentSdkMcpServer(
  tools: Record<string, Tool>,
  disabledTools?: string[],
) {
  const disabledSet = new Set(disabledTools ?? [])

  const sdkTools = Object.entries(tools)
    .filter(([name, t]) => t.execute && !disabledSet.has(name))
    .map(([name, t]) => {
      // Extract Zod raw shape — same approach as mcp.ts line 76
      const shape = (t.inputSchema as any)?.shape ?? {}

      return tool(name, t.description ?? name, shape, async (args: any) => {
        try {
          const result = await t.execute!(args, {
            toolCallId: randomUUID(),
            messages: [],
          })
          return { content: toMcpContent(result) }
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err}` }],
            isError: true,
          }
        }
      })
    })

  return createSdkMcpServer({ name: 'open-alice', tools: sdkTools })
}
