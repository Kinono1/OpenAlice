import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../../core/types.js'
import { createCorsOriginResolver } from '../../core/cors.js'
import { SessionStore } from '../../core/session.js'
import { WebConnector } from './web-connector.js'
import { loadConfig, readWebSubchannels } from '../../core/config.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from './routes/chat.js'
import { createChannelsRoutes } from './routes/channels.js'
import { createConfigRoutes, createMarketDataRoutes } from './routes/config.js'
import { createEventsRoutes } from './routes/events.js'
import { createCronRoutes } from './routes/cron.js'
import { createHeartbeatRoutes } from './routes/heartbeat.js'
import { createTradingRoutes } from './routes/trading.js'
import { createTradingConfigRoutes } from './routes/trading-config.js'
import { createDevRoutes } from './routes/dev.js'
import { createToolsRoutes } from './routes/tools.js'
import { createAgentStatusRoutes } from './routes/agent-status.js'
import { createHealthRoutes } from './routes/health.js'
import { createSignalRoutes } from './routes/signals.js'
import { createStrategyRoutes } from './routes/strategy.js'
import { createRateLimitMiddleware, createRequireAuth, createRequireTrade } from './routes/security.js'

export interface WebConfig {
  port: number
  allowOrigins?: string[]
  rateLimitMax?: number
  rateLimitWindowMs?: number
  maxSseClients?: number
  sseMaxDurationMs?: number
}

export class WebPlugin implements Plugin {
  name = 'web'
  private server: ReturnType<typeof serve> | null = null
  /** SSE clients grouped by channel ID. Default channel: 'default'. */
  private sseByChannel = new Map<string, Map<string, SSEClient>>()
  private unregisterConnector?: () => void

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    // Load sub-channel definitions
    const subChannels = await readWebSubchannels()
    const appConfig = await loadConfig().catch(() => null)
    const enforceAuth = appConfig?.auth.enforceAuth ?? true
    const rateLimitMax = this.config.rateLimitMax ?? Number(process.env.WEB_RATE_LIMIT_MAX ?? 100)
    const rateLimitWindowMs = this.config.rateLimitWindowMs ?? Number(process.env.WEB_RATE_LIMIT_WINDOW_MS ?? 60_000)
    const maxSseClients = this.config.maxSseClients ?? Number(process.env.WEB_SSE_MAX_CLIENTS ?? 100)
    const sseMaxDurationMs = this.config.sseMaxDurationMs ?? Number(process.env.WEB_SSE_MAX_DURATION_MS ?? 15 * 60_000)
    const requireAuth = createRequireAuth(enforceAuth)
    const requireTrade = createRequireTrade(enforceAuth)

    // Initialize sessions for the default channel and all sub-channels
    const sessions = new Map<string, SessionStore>()

    const defaultSession = new SessionStore('web/default')
    await defaultSession.restore()
    sessions.set('default', defaultSession)

    for (const ch of subChannels) {
      const session = new SessionStore(`web/${ch.id}`)
      await session.restore()
      sessions.set(ch.id, session)
    }

    // Initialize SSE map for known channels (entries are created lazily too)
    this.sseByChannel.set('default', new Map())
    for (const ch of subChannels) {
      this.sseByChannel.set(ch.id, new Map())
    }

    const app = new Hono()

    app.onError((err: Error, c: Context) => {
      if (err instanceof SyntaxError) {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      console.error('web: unhandled error:', err)
      return c.json({ error: err.message }, 500)
    })

    app.use('/api/*', cors({ origin: createCorsOriginResolver(this.config.allowOrigins) }))
    app.use('/api/*', createRateLimitMiddleware({ maxRequests: rateLimitMax, windowMs: rateLimitWindowMs }))

    // ==================== Mount route modules ====================
    app.route('/api/chat', createChatRoutes({
      ctx,
      sessions,
      sseByChannel: this.sseByChannel,
      maxSseClients,
      sseMaxDurationMs,
    }, { requireAuth }))
    app.route('/api/channels', createChannelsRoutes({ sessions, sseByChannel: this.sseByChannel }, { requireAuth }))
    app.route('/api/media', createMediaRoutes({ requireAuth }))
    app.route('/api/config', createConfigRoutes({
      onConnectorsChange: async () => { await ctx.reconnectConnectors() },
      requireAuth,
    }))
    app.route('/api/market-data', createMarketDataRoutes({ requireAuth }))
    app.route('/api/events', createEventsRoutes(ctx, { requireAuth, maxSseClients, sseMaxDurationMs }))
    app.route('/api/cron', createCronRoutes(ctx, { requireAuth }))
    app.route('/api/heartbeat', createHeartbeatRoutes(ctx, { requireAuth }))
    app.route('/api/trading/config', createTradingConfigRoutes(ctx, { requireAuth }))
    app.route('/api/trading', createTradingRoutes(ctx, { requireAuth, requireTrade }))
    app.route('/api/dev', createDevRoutes(ctx.connectorCenter, { requireAuth }))
    app.route('/api/signals', createSignalRoutes(ctx, { requireAuth, requireTrade }))
    app.route('/api/strategy', createStrategyRoutes(ctx, { requireAuth }))
    app.route('/api', createHealthRoutes(ctx))
    app.route('/api/tools', createToolsRoutes(ctx.toolCenter, { requireAuth }))
    app.route('/api/agent-status', createAgentStatusRoutes(ctx, { requireAuth, maxSseClients, sseMaxDurationMs }))

    // ==================== Serve UI (Vite build output) ====================
    const uiRoot = resolve('dist/ui')
    app.use('/*', serveStatic({ root: uiRoot }))
    app.get('*', serveStatic({ root: uiRoot, path: 'index.html' }))

    // ==================== Connector registration ====================
    // The web connector only targets the main 'default' channel (heartbeat/cron notifications).
    this.unregisterConnector = ctx.connectorCenter.register(
      new WebConnector(this.sseByChannel, defaultSession),
    )

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, port: this.config.port }, (info: { port: number }) => {
      console.log(`web plugin listening on http://localhost:${info.port}`)
    })
  }

  async stop() {
    this.sseByChannel.clear()
    this.unregisterConnector?.()
    this.server?.close()
  }
}
