/**
 * ToolCenter — unified tool registry.
 *
 * All tool definitions are registered here once during bootstrap.
 * Consumers (AI providers, MCP plugin, etc.) pull from ToolCenter
 * in the format they need, instead of reaching through Engine.
 */

import type { Tool } from 'ai'
import { readToolsConfig } from './config.js'

interface ToolEntry {
  tool: Tool
  group: string
}

export class ToolCenter {
  private tools: Record<string, ToolEntry> = {}
  private disabledCache: { disabled: string[]; ts: number } | null = null
  private static CACHE_TTL_MS = 5_000

  /** Batch-register tool definitions under a group. Later registrations overwrite same-name tools. */
  register(tools: Record<string, Tool>, group: string): void {
    for (const [name, tool] of Object.entries(tools)) {
      this.tools[name] = { tool, group }
    }
    this.disabledCache = null // invalidate on register
  }

  /** Vercel AI SDK format — returns only enabled tools (reads disabled list from disk, cached with TTL). */
  async getVercelTools(): Promise<Record<string, Tool>> {
    const now = Date.now()
    if (!this.disabledCache || (now - this.disabledCache.ts) > ToolCenter.CACHE_TTL_MS) {
      const { disabled } = await readToolsConfig()
      this.disabledCache = { disabled, ts: now }
    }
    const result: Record<string, Tool> = {}
    if (this.disabledCache.disabled.length === 0) {
      for (const [name, entry] of Object.entries(this.tools)) {
        result[name] = entry.tool
      }
      return result
    }
    const disabledSet = new Set(this.disabledCache.disabled)
    for (const [name, entry] of Object.entries(this.tools)) {
      if (!disabledSet.has(name)) result[name] = entry.tool
    }
    return result
  }

  /** MCP format — same filtering as Vercel. Kept separate for future divergence. */
  async getMcpTools(): Promise<Record<string, Tool>> {
    return this.getVercelTools()
  }

  /** Full tool inventory with group metadata (for frontend / API). */
  getInventory(): Array<{ name: string; group: string; description: string }> {
    return Object.entries(this.tools).map(([name, entry]) => ({
      name,
      group: entry.group,
      description: (entry.tool.description ?? '').slice(0, 200),
    }))
  }

  /** Look up a single tool by name (for detail / execute endpoints). */
  get(name: string): Tool | null {
    return this.tools[name]?.tool ?? null
  }

  /** Look up a tool's group by name. */
  getGroup(name: string): string | null {
    return this.tools[name]?.group ?? null
  }

  /** Tool name list (for logging / debugging). */
  list(): string[] {
    return Object.keys(this.tools)
  }
}
