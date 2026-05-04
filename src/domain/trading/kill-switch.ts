/**
 * Kill Switch — tiered circuit breaker system.
 *
 * Tiers (Level 0-4):
 *   Level 0 — Normal operation
 *   Level 1 — Strategy-level kill (single strategy paused)
 *   Level 2 — Asset-level kill (single symbol blocked)
 *   Level 3 — Exchange-level kill (all positions on one exchange)
 *   Level 4 — Global kill (all positions everywhere)
 *
 * Triggers:
 *   - Consecutive losses > threshold
 *   - Daily PnL drawdown > threshold
 *   - Exchange API errors / insolvency signals
 *   - External kill signal (manual override, news event)
 */

import type { KillSwitchStateStore } from '../../core/durable-state-store.js'

export type KillSwitchPolicy = 'block_new_only' | 'block_all'
export type KillSwitchLevel = 0 | 1 | 2 | 3 | 4

export interface KillSwitchConfig {
  defaultPolicy: KillSwitchPolicy
  stateStore?: KillSwitchStateStore
  maxConsecutiveLosses?: number
  maxDailyDrawdownPct?: number
  maxGlobalDailyDrawdownPct?: number
}

export const DEFAULT_KILL_SWITCH_CONFIG: KillSwitchConfig = {
  defaultPolicy: 'block_new_only',
  maxConsecutiveLosses: 5,
  maxDailyDrawdownPct: 5,
  maxGlobalDailyDrawdownPct: 15,
}

export interface KillSwitchState {
  symbol: string
  level: KillSwitchLevel
  policy: KillSwitchPolicy
  activatedAt: number
  reason: string
}

export interface KillSwitchCheckResult {
  blocked: boolean
  level: KillSwitchLevel
  policy?: KillSwitchPolicy
  reason?: string
  persistenceDegraded?: boolean
}

export class KillSwitch {
  private states = new Map<string, KillSwitchState>()
  private config: KillSwitchConfig
  private persistenceFailureReason: string | undefined
  private globalLevel: KillSwitchLevel = 0

  constructor(config?: Partial<KillSwitchConfig>) {
    this.config = { ...DEFAULT_KILL_SWITCH_CONFIG, ...config }
    this.hydrateFromStore()
  }

  activate(
    symbol: string,
    reason: string,
    levelOrPolicy?: KillSwitchLevel | KillSwitchPolicy,
    policy?: KillSwitchPolicy,
  ): KillSwitchState {
    let level: KillSwitchLevel
    let resolvedPolicy: KillSwitchPolicy
    if (typeof levelOrPolicy === 'number') {
      level = levelOrPolicy
      resolvedPolicy = policy ?? this.config.defaultPolicy
    } else if (typeof levelOrPolicy === 'string') {
      level = 2
      resolvedPolicy = levelOrPolicy
    } else {
      level = 2
      resolvedPolicy = this.config.defaultPolicy
    }
    const state: KillSwitchState = {
      symbol,
      level,
      policy: resolvedPolicy,
      activatedAt: Date.now(),
      reason,
    }
    try {
      this.config.stateStore?.upsert(state)
      this.persistenceFailureReason = undefined
    } catch (error) {
      this.persistenceFailureReason = error instanceof Error ? error.message : String(error)
    }
    this.states.set(symbol, state)
    return state
  }

  activateGlobal(reason: string, level: KillSwitchLevel = 4): void {
    this.globalLevel = Math.max(this.globalLevel, level) as KillSwitchLevel
    this.activate('__global__', reason, level, 'block_all')
  }

  deactivate(symbol: string): boolean {
    try {
      this.config.stateStore?.delete(symbol)
      this.persistenceFailureReason = undefined
    } catch (error) {
      this.persistenceFailureReason = error instanceof Error ? error.message : String(error)
      return false
    }
    if (symbol === '__global__') {
      this.globalLevel = 0
    }
    return this.states.delete(symbol)
  }

  checkStrategyHealth(
    strategyId: string,
    consecutiveLosses: number,
    dailyDrawdownPct: number,
  ): KillSwitchCheckResult {
    if (this.globalLevel >= 3) {
      return {
        blocked: true,
        level: this.globalLevel,
        policy: 'block_all',
        reason: `Global kill switch active (level ${this.globalLevel})`,
      }
    }

    const maxLosses = this.config.maxConsecutiveLosses ?? 5
    const maxDaily = this.config.maxDailyDrawdownPct ?? 5

    if (consecutiveLosses >= maxLosses) {
      this.activate(strategyId, `${consecutiveLosses} consecutive losses`, 1, 'block_new_only')
      return {
        blocked: true,
        level: 1,
        policy: 'block_new_only',
        reason: `Strategy ${strategyId}: ${consecutiveLosses} consecutive losses`,
      }
    }

    if (dailyDrawdownPct >= maxDaily) {
      const globalThreshold = this.config.maxGlobalDailyDrawdownPct ?? 15
      const level: KillSwitchLevel = dailyDrawdownPct >= globalThreshold ? 4 : 2
      this.activate(strategyId, `Daily drawdown ${dailyDrawdownPct.toFixed(1)}%`, level, 'block_all')
      return {
        blocked: true,
        level,
        policy: 'block_all',
        reason: `Daily drawdown ${dailyDrawdownPct.toFixed(1)}% >= ${maxDaily}%`,
      }
    }

    return { blocked: false, level: 0 }
  }

  check(
    symbol: string,
    reduceOnly: boolean,
    isEmergencyClose: boolean = false,
  ): KillSwitchCheckResult {
    if (this.globalLevel >= 4 && !isEmergencyClose) {
      return {
        blocked: true,
        level: this.globalLevel,
        policy: 'block_all',
        reason: 'Global kill switch active',
      }
    }

    if (this.persistenceFailureReason && !reduceOnly && !isEmergencyClose) {
      return {
        blocked: true,
        level: 3,
        policy: this.config.defaultPolicy,
        reason: `Kill switch persistence degraded; blocking new risk for ${symbol}: ${this.persistenceFailureReason}`,
        persistenceDegraded: true,
      }
    }

    const state = this.states.get(symbol)
    if (!state) {
      return { blocked: false, level: 0 }
    }

    if (isEmergencyClose && state.level < 4) {
      return { blocked: false, level: state.level, policy: state.policy }
    }

    switch (state.policy) {
      case 'block_new_only':
        if (reduceOnly) {
          return { blocked: false, level: state.level, policy: state.policy }
        }
        return {
          blocked: true,
          level: state.level,
          policy: state.policy,
          reason: `Kill switch active for ${symbol}: ${state.reason} (block_new_only, level ${state.level})`,
        }

      case 'block_all':
        return {
          blocked: true,
          level: state.level,
          policy: state.policy,
          reason: `Kill switch active for ${symbol}: ${state.reason} (block_all, level ${state.level})`,
        }

      default:
        return { blocked: true, level: 2, policy: state.policy, reason: 'Unknown kill switch policy' }
    }
  }

  getGlobalLevel(): KillSwitchLevel {
    return this.globalLevel
  }

  getAll(): KillSwitchState[] {
    return Array.from(this.states.values())
  }

  get(symbol: string): KillSwitchState | undefined {
    return this.states.get(symbol)
  }

  isAnyActive(): boolean {
    return this.globalLevel > 0 || this.states.size > 0
  }

  _resetForTest(): void {
    this.states.clear()
    this.globalLevel = 0
    this.persistenceFailureReason = undefined
    this.config.stateStore?.clear?.()
  }

  persistenceHealth(): { ok: boolean; degradedReason?: string } {
    if (this.persistenceFailureReason) {
      return { ok: false, degradedReason: this.persistenceFailureReason }
    }
    return this.config.stateStore?.health?.() ?? { ok: true }
  }

  private hydrateFromStore(): void {
    if (!this.config.stateStore) {
      return
    }
    try {
      for (const state of this.config.stateStore.loadAll()) {
        if (state.symbol === '__global__') {
          this.globalLevel = Math.max(this.globalLevel, state.level) as KillSwitchLevel
        }
        this.states.set(state.symbol, state)
      }
      this.persistenceFailureReason = undefined
    } catch (error) {
      this.persistenceFailureReason = error instanceof Error ? error.message : String(error)
    }
  }
}
