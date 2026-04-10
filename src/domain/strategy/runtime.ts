import {
  readAlphaPoolArtifactSync,
  summarizeAlphaPoolArtifact,
} from './alpha-pool.js'
import type { z } from 'zod'
import { evaluateFreezeWindows } from './event-calendar/index.js'
import type { strategySchema } from '../../core/config.js'
import { isReleaseGateStatusBlocking, loadReleaseGateStatus } from '../../runtime/release_gate_status.js'

export type StrategyConfig = z.infer<typeof strategySchema>

export interface StrategyRuntimeSummary {
  enabled: boolean
  alphaPool: ReturnType<typeof summarizeAlphaPoolArtifact>
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
  const alphaPool = summarizeAlphaPoolArtifact(readAlphaPoolArtifactSync())

  return {
    enabled: config.enabled,
    alphaPool,
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
        alphaPool.available
          ? `Alpha pool artifact detected with ${alphaPool.acceptedCount}/${alphaPool.totalCandidates} runtime-eligible candidates and ${alphaPool.shadowOnlyCount} shadow-only research candidates.`
          : 'Alpha pool artifact not present; runtime is operating on handcrafted strategy factors only.',
      ],
    },
  }
}

export async function buildStrategyRuntimeSummaryWithPaperGate(
  config: StrategyConfig,
  nowUtcMs = Date.now(),
): Promise<StrategyRuntimeSummary> {
  const summary = buildStrategyRuntimeSummary(config, nowUtcMs)
  const gateStatus = await loadReleaseGateStatus()
  const paperGate = isReleaseGateStatusBlocking(gateStatus, 'paper', new Date(nowUtcMs))
  if (paperGate.blocking) {
    summary.readiness.notes.push(`Paper gate blocked: ${paperGate.reason}`)
  } else {
    summary.readiness.notes.push('Paper gate ready: current release gate permits paper trading.')
  }
  return summary
}
