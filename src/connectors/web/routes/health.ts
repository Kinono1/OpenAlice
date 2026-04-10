import { Hono } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import { getWebAuthStatus } from './security.js'

/**
 * Health and readiness endpoints for monitoring.
 * - GET /api/health — process is alive (always 200)
 * - GET /api/readiness — ready to accept traffic (checks config, auth, connectors)
 */
export function createHealthRoutes(ctx: EngineContext) {
  const app = new Hono()

  app.get('/health', (c) => {
    return c.json(getProcessHealthSnapshot(), 200)
  })

  app.get('/readiness', (c) => {
    const snapshot = getWebReadinessSnapshot(ctx)
    return c.json(snapshot, snapshot.ready ? 200 : 503)
  })

  return app
}

export function getProcessHealthSnapshot() {
  return { status: 'ok', uptime: process.uptime() }
}

export function getWebReadinessSnapshot(ctx: EngineContext) {
  const checks: Record<string, { ok: boolean; detail?: string }> = {}
  const { authConfigured, tradeConfigured, devBypass, devBypassRequested } = getWebAuthStatus()
  const enforceAuth = ctx.config?.auth?.enforceAuth ?? true

  checks.config = { ok: !!ctx.config, detail: 'Config loaded' }
  checks.auth = {
    ok: !enforceAuth || authConfigured || tradeConfigured || devBypass,
    detail: enforceAuth
      ? authConfigured && tradeConfigured
        ? 'AUTH_TOKEN and TRADE_TOKEN configured'
        : authConfigured
          ? 'AUTH_TOKEN configured; TRADE_TOKEN missing'
          : tradeConfigured
            ? 'TRADE_TOKEN configured; AUTH_TOKEN missing'
            : devBypass
              ? 'DEV_AUTH_BYPASS active'
              : devBypassRequested
                ? 'DEV_AUTH_BYPASS requested but not allowed'
                : 'AUTH_TOKEN and TRADE_TOKEN missing'
      : 'Auth enforcement disabled',
  }
  checks.connectors = {
    ok: ctx.connectorCenter?.hasConnectors?.() ?? false,
    detail: ctx.connectorCenter?.hasConnectors?.()
      ? 'Outbound connector available'
      : 'No outbound connector registered',
  }

  const ready = Object.values(checks).every((check) => check.ok)
  return {
    status: ready ? 'ready' : 'not-ready',
    ready,
    checks,
  }
}
