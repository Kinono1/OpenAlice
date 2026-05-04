import { Hono, type MiddlewareHandler } from 'hono'
import { readStrategyConfig, writeConfigSection, type StrategyConfig } from '../../../core/config.js'
import { buildStrategyRuntimeSummaryWithPaperGate } from '../../../domain/strategy/runtime.js'
import { evaluateRuntimeStrategySnapshotFromSources } from '../../../domain/strategy/runtime-service.js'
import { createRequireAuth } from './security.js'
import type { EngineContext } from '../../../core/types.js'

interface StrategyRouteOpts {
  requireAuth?: MiddlewareHandler
}

export function createStrategyRoutes(ctx: EngineContext, opts?: StrategyRouteOpts) {
  const app = new Hono()
  app.use('*', opts?.requireAuth ?? createRequireAuth())

  app.get('/config', async (c) => {
    try {
      const config = await readStrategyConfig()
      return c.json(config)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.put('/config', async (c) => {
    try {
      const body = await c.req.json()
      const validated = await writeConfigSection('strategy', body) as StrategyConfig
      Object.assign(ctx.config.strategy, validated)
      return c.json(validated)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.get('/runtime', async (c) => {
    try {
      const config = await readStrategyConfig()
      return c.json(await buildStrategyRuntimeSummaryWithPaperGate(config))
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  app.post('/evaluate', async (c) => {
    try {
      const body = await c.req.json<{
        symbol: string
        interval?: string
        source?: string
        exchangeId?: string
        sourceTier?: 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
        useType?: 'U1' | 'U2' | 'U3' | 'U4'
        sentiment?: 'S+2' | 'S+1' | 'S0' | 'S-1' | 'S-2'
        fundingRatePct?: number
        openInterest?: number
        openInterestValue?: number
        liquidationCount24h?: number
        liquidationNotional24h?: number
        equity?: number
        assetLayer?: 'core' | 'extended' | 'watch-only'
        winRate?: number
        avgWinLossRatio?: number
        side?: 'buy' | 'sell'
        requestedSize?: number
        requestedUsdSize?: number
        price?: number
        reduceOnly?: boolean
        basisInput?: {
          futuresPrice: number
          spotPrice: number
          daysToExpiry?: number
        }
      }>()

      const snapshot = await evaluateRuntimeStrategySnapshotFromSources({
        utaManager: ctx.utaManager,
        cryptoClient: ctx.marketSearch.cryptoClient,
        request: body,
      })
      return c.json(snapshot)
    } catch (err) {
      return c.json({ error: String(err) }, 500)
    }
  })

  return app
}
