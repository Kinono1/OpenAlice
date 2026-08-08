import type { Config } from '../core/config.js'
import { loadConfig, resolveTelegramBotToken } from '../core/config.js'
import type { EngineContext, Plugin, ReconnectResult } from '../core/types.js'
import type { ToolCenter } from '../core/tool-center.js'
import { McpPlugin } from '../server/mcp.js'
import { McpAskPlugin } from '../connectors/mcp-ask/index.js'
import { TelegramPlugin } from '../connectors/telegram/index.js'
import { resolveTelegramPollingEnabled } from '../connectors/telegram/types.js'
import { WebPlugin } from '../connectors/web/index.js'
import { OpenBBServerPlugin } from '../server/opentypebb.js'
import type { RuntimePaths } from '../runtime/runtime-paths.js'

export interface ChannelAssembly {
  reconnectConnectors(): Promise<ReconnectResult>
  start(ctx: EngineContext): Promise<void>
  stop(): Promise<void>
}

export function assembleChannels(input: {
  config: Config
  runtime: RuntimePaths
  toolCenter: ToolCenter
}): ChannelAssembly {
  const { config, runtime, toolCenter } = input
  const corePlugins: Plugin[] = []
  const optionalPlugins = new Map<string, Plugin>()
  let context: EngineContext | null = null
  let connectorsReconnecting = false

  // Research exposes the read-only web surface, but not the MCP tool
  // transport. MCP/LLM autonomous asks are outside the research capability
  // matrix and must fail closed at the channel boundary as well as in tools.
  if (runtime.role !== 'research' && config.connectors.mcp.port) {
    corePlugins.push(
      new McpPlugin(
        toolCenter,
        config.connectors.mcp.port,
        config.connectors.mcp.allowOrigins,
      ),
    )
  }
  if (config.connectors.web.port) {
    corePlugins.push(new WebPlugin({
      port: config.connectors.web.port,
      allowOrigins: config.connectors.web.allowOrigins,
      maxSseClients: config.connectors.web.maxSseClients,
      sseMaxDurationMs: config.connectors.web.sseMaxDurationMs,
    }))
  }

  if (runtime.role === 'primary' || runtime.role === 'research') {
    if (runtime.role === 'primary') {
      if (config.connectors.mcpAsk.enabled && config.connectors.mcpAsk.port) {
        optionalPlugins.set('mcp-ask', new McpAskPlugin({
          port: config.connectors.mcpAsk.port,
          allowOrigins: config.connectors.mcpAsk.allowOrigins,
        }))
      }
      if (config.marketData.apiServer.enabled) {
        optionalPlugins.set(
          'openbb-server',
          new OpenBBServerPlugin({ port: config.marketData.apiServer.port }),
        )
      }
    }
    if (config.connectors.telegram.enabled) {
      optionalPlugins.set('telegram', new TelegramPlugin({
        token: resolveTelegramBotToken(config.connectors.telegram),
        allowedChatIds: config.connectors.telegram.chatIds,
        pollingEnabled: resolveTelegramPollingEnabled(
          runtime.role === 'research'
            ? 'false'
            : process.env.OPENALICE_TELEGRAM_POLLING_ENABLED,
        ),
      }))
    }
  }

  const reconnectConnectors = async (): Promise<ReconnectResult> => {
    if (runtime.role !== 'primary' && runtime.role !== 'research') {
      return {
        success: false,
        error: `runtime role ${runtime.role} forbids connector mutation`,
      }
    }
    if (!context) return { success: false, error: 'engine context is not ready' }
    if (connectorsReconnecting) {
      return { success: false, error: 'Reconnect already in progress' }
    }
    connectorsReconnecting = true
    try {
      const fresh = await loadConfig()
      const changes: string[] = []

      if (runtime.role === 'primary') {
        const mcpAskWanted = fresh.connectors.mcpAsk.enabled && !!fresh.connectors.mcpAsk.port
        const mcpAskRunning = optionalPlugins.has('mcp-ask')
        if (mcpAskRunning && !mcpAskWanted) {
          await optionalPlugins.get('mcp-ask')!.stop()
          optionalPlugins.delete('mcp-ask')
          changes.push('mcp-ask stopped')
        } else if (!mcpAskRunning && mcpAskWanted) {
          const plugin = new McpAskPlugin({
            port: fresh.connectors.mcpAsk.port!,
            allowOrigins: fresh.connectors.mcpAsk.allowOrigins,
          })
          await plugin.start(context)
          optionalPlugins.set('mcp-ask', plugin)
          changes.push('mcp-ask started')
        }
      }

      const telegramWanted = fresh.connectors.telegram.enabled
      const telegramRunning = optionalPlugins.has('telegram')
      if (telegramRunning && !telegramWanted) {
        await optionalPlugins.get('telegram')!.stop()
        optionalPlugins.delete('telegram')
        changes.push('telegram stopped')
      } else if (!telegramRunning && telegramWanted) {
        const plugin = new TelegramPlugin({
          token: resolveTelegramBotToken(fresh.connectors.telegram),
          allowedChatIds: fresh.connectors.telegram.chatIds,
          pollingEnabled: resolveTelegramPollingEnabled(
            runtime.role === 'research'
              ? 'false'
              : process.env.OPENALICE_TELEGRAM_POLLING_ENABLED,
          ),
        })
        await plugin.start(context)
        optionalPlugins.set('telegram', plugin)
        changes.push('telegram started')
      }

      if (runtime.role === 'primary') {
        const openbbWanted = fresh.marketData.apiServer.enabled
        const openbbRunning = optionalPlugins.has('openbb-server')
        if (openbbRunning && !openbbWanted) {
          await optionalPlugins.get('openbb-server')!.stop()
          optionalPlugins.delete('openbb-server')
          changes.push('openbb-server stopped')
        } else if (!openbbRunning && openbbWanted) {
          const plugin = new OpenBBServerPlugin({ port: fresh.marketData.apiServer.port })
          await plugin.start(context)
          optionalPlugins.set('openbb-server', plugin)
          changes.push('openbb-server started')
        } else if (openbbRunning && openbbWanted) {
          const current = optionalPlugins.get('openbb-server') as OpenBBServerPlugin
          if (current.port !== fresh.marketData.apiServer.port) {
            await current.stop()
            const plugin = new OpenBBServerPlugin({
              port: fresh.marketData.apiServer.port,
            })
            await plugin.start(context)
            optionalPlugins.set('openbb-server', plugin)
            changes.push(`openbb-server restarted on port ${fresh.marketData.apiServer.port}`)
          }
        }
      }
      if (changes.length > 0) {
        console.log(`reconnect: connectors — ${changes.join(', ')}`)
      }
      return {
        success: true,
        message: changes.length > 0 ? changes.join(', ') : 'no changes',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error('reconnect: connectors failed:', message)
      return { success: false, error: message }
    } finally {
      connectorsReconnecting = false
    }
  }

  return {
    reconnectConnectors,
    async start(ctx) {
      context = ctx
      for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
        try {
          await plugin.start(ctx)
          console.log(`plugin started: ${plugin.name}`)
        } catch (error) {
          if (plugin.name === 'telegram') {
            console.warn(
              `plugin degraded: telegram: ${error instanceof Error ? error.message : error}`,
            )
            ctx.connectorCenter.setChannelStatus(
              'telegram',
              'degraded',
              error instanceof Error ? error.message : String(error),
            )
            continue
          }
          throw error
        }
      }
    },
    async stop() {
      for (const plugin of [...corePlugins, ...optionalPlugins.values()]) {
        try {
          await plugin.stop()
        } catch (error) {
          console.error(`plugin stop failed: ${plugin.name}:`, error)
        }
      }
      context = null
    },
  }
}
