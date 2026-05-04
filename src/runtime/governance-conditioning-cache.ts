/**
 * GovernanceConditioningCache — periodic scheduler for the LLM governance agent.
 *
 * Runs runGovernanceContextAgent() on a configurable interval (default 15 min).
 * Caches the last successful FactorWeightConditioning so the ensemble can call
 * getConditioning() at any time without blocking on the LLM.
 *
 * Usage:
 *   const cache = new GovernanceConditioningCache()
 *   cache.start(getCtx)
 *   // in ensemble:
 *   const conditioning = cache.getConditioning()
 *   combineFactorSignals(signals, weights, conditioning)
 */

import type { FactorWeightConditioning } from '../domain/strategy/factors/types.js'
import { runGovernanceContextAgent, type GovernanceContextInput } from './governance-context-agent.js'

export interface GovernanceCacheConfig {
  /** How often to re-run the agent (ms). Default: 15 minutes. */
  intervalMs?: number
  /** If true, run immediately on start(). Default: true. */
  runOnStart?: boolean
}

export class GovernanceConditioningCache {
  private conditioning: FactorWeightConditioning = { multiplierBySignal: {}, reasons: ['governance_not_yet_run'] }
  private lastRunAt: number | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly intervalMs: number
  private readonly runOnStart: boolean

  constructor(config: GovernanceCacheConfig = {}) {
    this.intervalMs = config.intervalMs ?? 15 * 60 * 1000
    this.runOnStart = config.runOnStart ?? true
  }

  /** Start the periodic scheduler. getCtx is called each tick to build the input. */
  start(getCtx: () => GovernanceContextInput | Promise<GovernanceContextInput>): void {
    if (this.timer) return

    const run = async () => {
      try {
        const ctx = await getCtx()
        const result = await runGovernanceContextAgent(ctx)
        if (result) {
          this.conditioning = result.conditioning
          this.lastRunAt = Date.now()
        }
      } catch {
        // keep last known conditioning on error
      }
    }

    if (this.runOnStart) {
      run()
    }
    this.timer = setInterval(run, this.intervalMs)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Returns the latest cached FactorWeightConditioning. Never throws. */
  getConditioning(): FactorWeightConditioning {
    return this.conditioning
  }

  getLastRunAt(): number | null {
    return this.lastRunAt
  }
}
