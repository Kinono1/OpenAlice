import { Hono } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import { isAuthEnabled } from '../../../core/auth.js'

/**
 * Health and readiness endpoints for monitoring.
 * - GET /api/health — process is alive (always 200)
 * - GET /api/readiness — ready to accept live signals (checks config, auth, exchange)
 */
export function createHealthRoutes(ctx: EngineContext) {
  const app = new Hono()

  // Health: process is alive
  app.get('/health', (c) => {
    return c.json({ status: 'ok', uptime: process.uptime() }, 200)
  })

  // Readiness: ready to accept live signals
  app.get('/readiness', (c) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {}
    const authEnforced = ctx.config.auth.enforceAuth
    const authConfigured = isAuthEnabled()
    const devBypass = process.env.DEV_AUTH_BYPASS === 'true'

    // Check config loaded
    checks['config'] = { ok: !!ctx.config, detail: 'Config loaded' }

    checks['auth'] = {
      ok: !authEnforced || authConfigured || devBypass,
      detail: authEnforced
        ? authConfigured
          ? 'Auth enforced and tokens configured'
          : devBypass
            ? 'Auth enforced but DEV_AUTH_BYPASS active'
            : 'Auth enforced but AUTH_TOKEN / TRADE_TOKEN missing'
        : 'Auth enforcement disabled',
    }

    // Check exchange connector
    const hasExchange = ctx.connectorCenter?.hasConnectors?.() ?? false
    checks['exchange'] = {
      ok: hasExchange,
      detail: hasExchange ? 'Exchange connector available' : 'No exchange connector',
    }

    const allOk = Object.values(checks).every((c: any) => c.ok)
    return c.json({
      status: allOk ? 'ready' : 'not-ready',
      checks,
    }, allOk ? 200 : 503)
  })

  return app
}
