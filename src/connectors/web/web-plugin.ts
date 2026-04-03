import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { resolve } from 'node:path'
import type { Plugin, EngineContext } from '../../core/types.js'
import { SessionStore, type ContentBlock } from '../../core/session.js'
import type { ConnectorCenter, Connector } from '../../core/connector-center.js'
import { persistMedia } from '../../core/media-store.js'
import { createRequireAuth, createRequireTrade } from '../../core/auth.js'
import { createChatRoutes, createMediaRoutes, type SSEClient } from './routes/chat.js'
import { createConfigRoutes, createOpenbbRoutes } from './routes/config.js'
import { createEventsRoutes } from './routes/events.js'
import { createCronRoutes } from './routes/cron.js'
import { createHeartbeatRoutes } from './routes/heartbeat.js'
import { createCryptoRoutes } from './routes/crypto.js'
import { createSignalRoutes } from './routes/signals.js'
import { createSecuritiesRoutes } from './routes/securities.js'
import { createDevRoutes } from './routes/dev.js'
import { createHealthRoutes } from './routes/health.js'
import { createToolsRoutes } from './routes/tools.js'

export interface WebConfig {
  port: number;
  allowOrigins?: string[];
  maxSseClients?: number;
  sseMaxDurationMs?: number;
}

export class WebPlugin implements Plugin {
  name = 'web'
  private server: ReturnType<typeof serve> | null = null
  private sseClients = new Map<string, SSEClient>()
  private unregisterConnector?: () => void
  private stoppedRef = { value: false }

  constructor(private config: WebConfig) {}

  async start(ctx: EngineContext) {
    this.stoppedRef.value = false
    // Initialize session (mirrors Telegram's per-user pattern, single user for web)
    const session = new SessionStore('web/default')
    await session.restore()

    const app = new Hono()
    const allowOrigins = new Set(
      (this.config.allowOrigins ?? []).map(origin => origin.trim()).filter(Boolean),
    )
    const requireConfigAuth = createRequireAuth(ctx.config.auth.enforceAuth)
    const requireTrade = createRequireTrade(ctx.config.auth.enforceAuth)

    app.onError((err, c) => {
      if (err instanceof SyntaxError) {
        return c.json({ error: 'Invalid JSON' }, 400)
      }
      console.error('web: unhandled error:', err)
      return c.json({ error: err.message }, 500)
    })

    if (allowOrigins.size > 0) {
      app.use('/api/*', cors({
        origin: (origin) => (allowOrigins.has(origin) ? origin : ''),
      }))
    }

    // ==================== Rate limiting ====================
    const rateLimitWindow = 60_000 // 1 minute
    const rateLimitMax = 100 // requests per window
    const requestCounts = new Map<string, { count: number; resetAt: number }>()
    app.use('/api/*', async (c, next) => {
      const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? 'unknown'
      const now = Date.now()
      const entry = requestCounts.get(ip)
      if (!entry || now > entry.resetAt) {
        requestCounts.set(ip, { count: 1, resetAt: now + rateLimitWindow })
        return next()
      }
      entry.count++
      if (entry.count > rateLimitMax) {
        return c.json({ error: 'Rate limit exceeded' }, 429)
      }
      return next()
    })

    // ==================== Mount route modules ====================
    app.route('/api/chat', createChatRoutes({
      ctx,
      session,
      sseClients: this.sseClients,
      maxSseClients: this.config.maxSseClients ?? 100,
      sseMaxDurationMs: this.config.sseMaxDurationMs ?? 900_000,
    }))
    app.route('/api/media', createMediaRoutes())
    app.route('/api/config', createConfigRoutes({
      onConnectorsChange: async () => { await ctx.reconnectConnectors?.() },
      requireAuth: requireConfigAuth,
    }))
    app.route('/api/openbb', createOpenbbRoutes())
    app.route('/api/events', createEventsRoutes(ctx))
    app.route('/api/cron', createCronRoutes(ctx))
    app.route('/api/heartbeat', createHeartbeatRoutes(ctx))
    app.route('/api/crypto', createCryptoRoutes(ctx))
    app.route('/api/signals', createSignalRoutes({ ctx, requireTrade }))
    app.route('/api/securities', createSecuritiesRoutes(ctx))
    app.route('/api/dev', createDevRoutes(ctx.connectorCenter))
    app.route('/api', createHealthRoutes(ctx))
    if (ctx.toolCenter) {
      app.route('/api/tools', createToolsRoutes(ctx.toolCenter))
    }

    // ==================== Serve UI (Vite build output) ====================
    const uiRoot = resolve('dist/ui')
    app.use('/*', serveStatic({ root: uiRoot }))
    app.get('*', serveStatic({ root: uiRoot, path: 'index.html' }))

    // ==================== Connector registration ====================
    this.unregisterConnector = ctx.connectorCenter.register(
      this.createConnector(this.sseClients, session),
    )

    // ==================== Start server ====================
    this.server = serve({ fetch: app.fetch, port: this.config.port }, info => {
      console.log(`web plugin listening on http://localhost:${info.port}`);
    });
  }

  async stop() {
    this.stoppedRef.value = true;
    this.sseClients.clear();
    this.unregisterConnector?.();
    this.server?.close();
  }

  private createConnector(
    sseClients: Map<string, SSEClient>,
    session: SessionStore,
  ): Connector {
    return {
      channel: 'web',
      to: 'default',
      capabilities: { push: true, media: true },
      send: async (payload) => {
        // Persist media to data/media/ with 3-word names
        const media: Array<{ type: 'image'; url: string }> = []
        for (const m of payload.media ?? []) {
          const name = await persistMedia(m.path)
          media.push({ type: 'image', url: `/api/media/${name}` })
        }

        const data = JSON.stringify({
          type: 'message',
          kind: payload.kind,
          text: payload.text,
          media: media.length > 0 ? media : undefined,
          source: payload.source,
        })

        for (const client of sseClients.values()) {
          try { client.send(data) } catch { /* client disconnected */ }
        }

        // Persist to session so history survives page refresh (text + image blocks)
        const blocks: ContentBlock[] = [
          { type: 'text', text: payload.text },
          ...media.map((m) => ({ type: 'image' as const, url: m.url })),
        ]
        await session.appendAssistant(blocks, 'engine', {
          kind: payload.kind,
          source: payload.source,
        })

        return { delivered: sseClients.size > 0 }
      },
    }
  }
}
