import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import {
  loadSystemStatus,
  serializeSystemStatus,
  type SystemStatusV1,
} from '../../../runtime/system_status.js'

type SystemContext = Pick<EngineContext, 'runtime' | 'cronEngine'>

export function createSystemRoutes(
  ctx: SystemContext,
  deps: {
    requireStrongAuth: MiddlewareHandler
    loadStatus?: () => Promise<SystemStatusV1>
  },
) {
  const app = new Hono()
  app.get('/status', deps.requireStrongAuth, async (c) => {
    try {
      const status = deps.loadStatus
        ? await deps.loadStatus()
        : await loadSystemStatus({
            runtime: ctx.runtime,
            cronJobs: ctx.cronEngine.list(),
          })
      return c.body(serializeSystemStatus(status), 200, {
        'Content-Type': 'application/json; charset=UTF-8',
        'Cache-Control': 'no-store',
      })
    } catch {
      return c.json({ error: 'system_status_unavailable' }, 503)
    }
  })
  return app
}
