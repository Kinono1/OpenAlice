import type { z } from 'zod'
import { evaluateFreezeWindows } from './event-calendar/index.js'
import type { strategySchema } from '../../core/config.js'

export type StrategyConfig = z.infer<typeof strategySchema>

export interface StrategyRuntimeSummary {
  enabled: boolean
  governance: StrategyConfig['governance']
  runtime: StrategyConfig['runtime']
  eventCalendar: {
    enabled: boolean
    configuredEventCount: number
    active: ReturnType<typeof evaluateFreezeWindows>
  }
  factors: Array<{
    name: string
    enabled: boolean
    weight: number
  }>
  positionSizing: StrategyConfig['positionSizing']
  readiness: {
    governanceReady: boolean
    factorLayerReady: boolean
    dataIntegrationReady: boolean
    runtimeIntegrationReady: boolean
    notes: string[]
  }
}

export function buildStrategyRuntimeSummary(
  config: StrategyConfig,
  nowUtcMs = Date.now(),
): StrategyRuntimeSummary {
  const activeFreeze = evaluateFreezeWindows(
    nowUtcMs,
    config.runtime.marketScope,
    config.eventCalendar.events,
  )

  const factors = Object.entries(config.factors).map(([name, value]) => ({
    name,
    enabled: value.enabled,
    weight: value.weight,
  }))

  return {
    enabled: config.enabled,
    governance: config.governance,
    runtime: config.runtime,
    eventCalendar: {
      enabled: config.eventCalendar.enabled,
      configuredEventCount: config.eventCalendar.events.length,
      active: activeFreeze,
    },
    factors,
    positionSizing: config.positionSizing,
    readiness: {
      governanceReady: true,
      factorLayerReady: true,
      dataIntegrationReady: true,
      runtimeIntegrationReady: config.runtime.runtimeIntegrationEnabled,
      notes: [
        'Governance and factor modules are available on the current architecture.',
        'Runtime strategy sizing and action gating are wired into the CCXT paper execution bridge.',
        'Derivatives data resolves through account-linked CCXT first, then public CCXT fallback.',
      ],
    },
  }
}
