import { Hono, type MiddlewareHandler } from 'hono'
import type { EngineContext } from '../../../core/types.js'
import { getWebAuthStatus, isAuthEnabled } from './security.js'
import { evaluateFreezeWindows } from '../../../domain/strategy/event-calendar/index.js'

interface SignalRouteOpts {
  requireAuth?: MiddlewareHandler
  requireTrade?: MiddlewareHandler
}

function getTradingReadiness(ctx: EngineContext): {
  tradingReady: boolean
  reasons: string[]
} {
  const reasons: string[] = []
  const accounts = ctx.accountManager.listAccounts()
  const hasHealthyAccount = accounts.some((account) => account.health.status !== 'offline' && !account.health.disabled)
  if (!hasHealthyAccount) {
    reasons.push('trading_accounts_unavailable')
  }

  return {
    tradingReady: hasHealthyAccount,
    reasons,
  }
}

function getSignalAuthState() {
  const { authConfigured, tradeConfigured, devBypass } = getWebAuthStatus()
  const authEnforced = isAuthEnabled()
  const authReady = !authEnforced || tradeConfigured || devBypass
  const authReasons = authReady ? [] : ['trade_tokens_missing']
  return {
    authEnforced,
    authConfigured,
    tradeConfigured,
    authReady,
    authReasons,
  }
}

export function getSignalReadinessSnapshot(ctx: EngineContext) {
  const auth = getSignalAuthState()
  const { tradingReady, reasons } = getTradingReadiness(ctx)
  const allReasons = [...reasons, ...auth.authReasons]

  const freeze = ctx.config.strategy?.eventCalendar.enabled
    ? evaluateFreezeWindows(
        Date.now(),
        ctx.config.strategy.runtime.marketScope,
        ctx.config.strategy.eventCalendar.events,
      )
    : null
  const freezeReady =
    !ctx.config.strategy?.enabled ||
    !ctx.config.strategy.runtime.runtimeIntegrationEnabled ||
    !freeze?.active
  if (!freezeReady) {
    allReasons.push('strategy_event_freeze_active')
  }

  const ready = tradingReady && auth.authReady && freezeReady
  return {
    status: ready ? 'ready' : 'not-ready',
    ready,
    mode: 'paper_only' as const,
    authEnforced: auth.authEnforced,
    authConfigured: auth.authConfigured,
    tradeConfigured: auth.tradeConfigured,
    supportedSymbols: ctx.config.engine.pairs,
    tradingReady,
    strategyFreezeActive: freeze?.active ?? false,
    reasons: allReasons,
  }
}

/**
 * Paper-signal intake routes for the current master web stack.
 * - GET /api/signals/health
 * - GET /api/signals/readiness
 * - POST /api/signals/intake
 */
export function createSignalRoutes(ctx: EngineContext, opts?: SignalRouteOpts) {
  const app = new Hono()

  if (opts?.requireAuth) {
    app.use('/readiness', opts.requireAuth)
  }
  if (opts?.requireTrade) {
    app.use('/intake', opts.requireTrade)
  }

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      mode: 'paper_only',
      service: 'sidecar_signal_intake',
    })
  })

  app.get('/readiness', (c) => {
    const snapshot = getSignalReadinessSnapshot(ctx)
    return c.json(snapshot, snapshot.ready ? 200 : 503)
  })

  app.post('/intake', async (c) => {
    const auth = getSignalAuthState()
    const { tradingReady, reasons } = getTradingReadiness(ctx)
    const allReasons = [...reasons, ...auth.authReasons]

    if (!auth.authReady || !tradingReady) {
      return c.json({
        accepted: false,
        ready: false,
        mode: 'paper_only',
        reasons: allReasons,
      }, 503)
    }

    const payload = await c.req.json()
    const record = await ctx.eventLog.append('signal.received', {
      mode: 'paper_only',
      supportedSymbols: ctx.config.engine.pairs,
      payload,
    })

    return c.json({
      accepted: true,
      ready: true,
      mode: 'paper_only',
      supportedSymbols: ctx.config.engine.pairs,
      record,
    })
  })

  return app
}
