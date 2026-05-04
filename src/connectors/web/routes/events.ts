import { Hono, type MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { EngineContext } from '../../../core/types.js'
import { isExternalEventType, validateEventPayload } from '../../../core/agent-event.js'
import type { ProducerHandle } from '../../../core/producer.js'
import { readWebhookConfig } from '../../../core/config.js'
import { checkAuth, extractPresentedToken } from './webhook-auth.js'

interface EventsDeps {
  ctx: EngineContext
  /** Producer for webhook-ingested events. Narrowed to the set of external
   *  types; extend its declaration in WebPlugin when adding new external types. */
  ingestProducer: ProducerHandle<readonly ['task.requested']>
}

interface EventsRouteOpts {
  requireAuth?: MiddlewareHandler
  maxSseClients?: number
  sseMaxDurationMs?: number
}

/** Event log routes: GET /, GET /recent, GET /stream (SSE), POST /ingest, GET /auth-status */
export function createEventsRoutes(deps: EventsDeps | EngineContext, opts?: EventsRouteOpts) {
  const app = new Hono()
  const ctx = 'ctx' in deps ? deps.ctx : deps
  const ingestProducer = 'ingestProducer' in deps ? deps.ingestProducer : undefined
  if (opts?.requireAuth) {
    app.use('*', opts.requireAuth)
  }
  const maxDurationMs = opts?.sseMaxDurationMs ?? Number(process.env.WEB_SSE_MAX_DURATION_MS ?? 15 * 60_000)
  const maxSseClients = opts?.maxSseClients ?? Number(process.env.WEB_SSE_MAX_CLIENTS ?? 100)
  let activeStreams = 0

  // Auth status — surfaces configuration state to the UI without leaking secrets.
  app.get('/auth-status', async (c) => {
    const cfg = await readWebhookConfig()
    return c.json({
      configured: cfg.tokens.length > 0,
      tokenCount: cfg.tokens.length,
      // Token ids are non-secret labels — safe to expose for the admin UI.
      tokenIds: cfg.tokens.map((t) => t.id),
    })
  })

  // Ingest external events — webhook / API producer surface.
  //
  // Body shape: { type: string, payload: unknown }
  // Gates, in order:
  //   1. Auth token (Authorization: Bearer / X-OpenAlice-Token) against
  //      `data/config/webhook.json`. Empty allowlist = 503 default-deny.
  //   2. isExternalEventType — prevents forging internal state transitions
  //      like `cron.done`.
  //   3. validateEventPayload — TypeBox schema validation.
  app.post('/ingest', async (c) => {
    const cfg = await readWebhookConfig()
    const presented = extractPresentedToken({
      authorization: c.req.header('authorization') ?? null,
      'x-openalice-token': c.req.header('x-openalice-token') ?? null,
    })
    const auth = checkAuth(cfg, presented)
    switch (auth.kind) {
      case 'unconfigured':
        return c.json(
          { error: 'Webhook auth not configured. Add a token in data/config/webhook.json before using this endpoint.' },
          503,
        )
      case 'missing':
        return c.json(
          { error: 'Missing auth token. Send Authorization: Bearer <token> or X-OpenAlice-Token header.' },
          401,
        )
      case 'invalid':
        return c.json({ error: 'Invalid auth token' }, 403)
      case 'ok':
        break
    }

    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (
      typeof body !== 'object' ||
      body === null ||
      typeof (body as { type?: unknown }).type !== 'string'
    ) {
      return c.json({ error: 'Body must be { type: string, payload: ... }' }, 400)
    }

    const { type, payload } = body as { type: string; payload: unknown }

    if (!isExternalEventType(type)) {
      return c.json(
        { error: `Event type '${type}' is not in the external allowlist` },
        403,
      )
    }

    try {
      validateEventPayload(type, payload)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return c.json({ error: msg }, 400)
    }

    if (!ingestProducer) {
      return c.json({ error: 'Event ingestion producer not available' }, 503)
    }

    const entry = await (
      ingestProducer.emit as unknown as (
        t: string,
        p: unknown,
      ) => Promise<{ seq: number; ts: number; type: string; payload: unknown }>
    )(type, payload)
    return c.json(entry, 201)
  })

  // Paginated query from disk (full history)
  app.get('/', async (c) => {
    const page = Number(c.req.query('page')) || 1
    const pageSize = Number(c.req.query('pageSize')) || 100
    const type = c.req.query('type') || undefined
    const result = await ctx.eventLog.query({ page, pageSize, type })
    return c.json(result)
  })

  // Fast in-memory query (ring buffer)
  app.get('/recent', (c) => {
    const afterSeq = Number(c.req.query('afterSeq')) || 0
    const limit = Number(c.req.query('limit')) || 100
    const type = c.req.query('type') || undefined
    const entries = ctx.eventLog.recent({ afterSeq, limit, type })
    return c.json({ entries, lastSeq: ctx.eventLog.lastSeq() })
  })

  app.get('/stream', (c) => {
    if (activeStreams >= maxSseClients) {
      return c.json({ error: 'too many SSE clients' }, 429)
    }

    return streamSSE(c, async (stream) => {
      activeStreams += 1
      const unsub = ctx.eventLog.subscribe((entry) => {
        stream.writeSSE({ data: JSON.stringify(entry) }).catch(() => {})
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
