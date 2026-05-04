import { Hono, type MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EngineContext } from '../../../core/types.js'

interface AgentStatusRouteOpts {
  requireAuth?: MiddlewareHandler
  maxSseClients?: number
  sseMaxDurationMs?: number
}

/** Tool call log routes: GET /, GET /recent, GET /stream (SSE) */
export function createAgentStatusRoutes(ctx: EngineContext, opts?: AgentStatusRouteOpts) {
  const app = new Hono()
  if (opts?.requireAuth) {
    app.use('*', opts.requireAuth)
  }
  const maxDurationMs = opts?.sseMaxDurationMs ?? Number(process.env.WEB_SSE_MAX_DURATION_MS ?? 15 * 60_000)
  const maxSseClients = opts?.maxSseClients ?? Number(process.env.WEB_SSE_MAX_CLIENTS ?? 100)
  let activeStreams = 0

  // Paginated query from disk (full history)
  app.get('/', async (c) => {
    const page = Number(c.req.query('page')) || 1
    const pageSize = Number(c.req.query('pageSize')) || 100
    const name = c.req.query('name') || undefined
    const result = await ctx.toolCallLog.query({ page, pageSize, name })
    return c.json(result)
  })

  // Fast in-memory query (ring buffer)
  app.get('/recent', (c) => {
    const afterSeq = Number(c.req.query('afterSeq')) || 0
    const limit = Number(c.req.query('limit')) || 100
    const name = c.req.query('name') || undefined
    const entries = ctx.toolCallLog.recent({ afterSeq, limit, name })
    return c.json({ entries, lastSeq: ctx.toolCallLog.lastSeq() })
  })

  // Real-time SSE stream
  app.get('/stream', (c) => {
    if (activeStreams >= maxSseClients) {
      return c.json({ error: 'too many SSE clients' }, 429)
    }

    return streamSSE(c, async (stream) => {
      activeStreams += 1
      const unsub = ctx.toolCallLog.subscribe((record) => {
        stream.writeSSE({ data: JSON.stringify(record) }).catch(() => {})
      })
      let cleanedUp = false
      let finished = false
      let finish!: () => void
      const completion = new Promise<void>((resolve) => {
        finish = () => {
          if (finished) return
          finished = true
          resolve()
        }
      })

      const pingInterval = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }, 30_000)

      const cleanup = () => {
        if (cleanedUp) return
        cleanedUp = true
        clearInterval(pingInterval)
        clearTimeout(maxDurationTimer)
        unsub()
        activeStreams = Math.max(0, activeStreams - 1)
        finish()
      }

      const maxDurationTimer = setTimeout(() => {
        void (async () => {
          await stream.writeSSE({ event: 'closing', data: 'max-duration-reached' }).catch(() => {})
          cleanup()
        })()
      }, maxDurationMs)

      stream.onAbort(cleanup)

      try {
        await completion
      } finally {
        cleanup()
      }
    })
  })

  return app
}
