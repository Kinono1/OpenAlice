/**
 * Kill Switch — per-symbol circuit breaker.
 * Two modes:
 * - block_new_only: blocks new position opens, allows reduceOnly
 * - block_all: blocks everything except emergency-close
 */

export type KillSwitchPolicy = 'block_new_only' | 'block_all'

export interface KillSwitchConfig {
  defaultPolicy: KillSwitchPolicy
}

export const DEFAULT_KILL_SWITCH_CONFIG: KillSwitchConfig = {
  defaultPolicy: 'block_new_only',
}

export interface KillSwitchState {
  symbol: string
  policy: KillSwitchPolicy
  activatedAt: number
  reason: string
}

export interface KillSwitchCheckResult {
  blocked: boolean
  policy?: KillSwitchPolicy
  reason?: string
}

export class KillSwitch {
  private states = new Map<string, KillSwitchState>()
  private config: KillSwitchConfig

  constructor(config?: Partial<KillSwitchConfig>) {
    this.config = { ...DEFAULT_KILL_SWITCH_CONFIG, ...config }
  }

  activate(symbol: string, reason: string, policy?: KillSwitchPolicy): KillSwitchState {
    const state: KillSwitchState = {
      symbol,
      policy: policy ?? this.config.defaultPolicy,
      activatedAt: Date.now(),
      reason,
    }
    this.states.set(symbol, state)
    return state
  }

  deactivate(symbol: string): boolean {
    return this.states.delete(symbol)
  }

  check(symbol: string, reduceOnly: boolean, isEmergencyClose: boolean = false): KillSwitchCheckResult {
    const state = this.states.get(symbol)
    if (!state) {
      return { blocked: false }
    }

    if (isEmergencyClose) {
      return { blocked: false, policy: state.policy }
    }

    switch (state.policy) {
      case 'block_new_only':
        if (reduceOnly) {
          return { blocked: false, policy: state.policy }
        }
        return {
          blocked: true,
          policy: state.policy,
          reason: `Kill switch active for ${symbol}: ${state.reason} (block_new_only)`,
        }

      case 'block_all':
        return {
          blocked: true,
          policy: state.policy,
          reason: `Kill switch active for ${symbol}: ${state.reason} (block_all — use emergency-close)`,
        }

      default:
        return { blocked: true, policy: state.policy, reason: 'Unknown kill switch policy' }
    }
  }

  getAll(): KillSwitchState[] {
    return Array.from(this.states.values())
  }

  get(symbol: string): KillSwitchState | undefined {
    return this.states.get(symbol)
  }

  isAnyActive(): boolean {
    return this.states.size > 0
  }

  _resetForTest(): void {
    this.states.clear()
  }
}

