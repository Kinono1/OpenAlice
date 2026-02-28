/**
 * Kill Switch — per-symbol circuit breaker.
 * Two modes:
 * - block_new_only: blocks new position opens, allows reduceOnly
 * - block_all: blocks everything except emergency-close
 */

export type KillSwitchPolicy = 'block_new_only' | 'block_all'

export interface KillSwitchConfig {
  /** Default policy when kill switch is triggered */
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

  /** Activate kill switch for a symbol. */
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

  /** Deactivate kill switch for a symbol. */
  deactivate(symbol: string): boolean {
    return this.states.delete(symbol)
  }

  /** Check if an operation is blocked by kill switch. */
  check(symbol: string, reduceOnly: boolean, isEmergencyClose: boolean = false): KillSwitchCheckResult {
    const state = this.states.get(symbol)
    if (!state) {
      return { blocked: false }
    }

    // Emergency close bypasses block_all
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

  /** Get all active kill switch states. */
  getAll(): KillSwitchState[] {
    return Array.from(this.states.values())
  }

  /** Get state for a specific symbol. */
  get(symbol: string): KillSwitchState | undefined {
    return this.states.get(symbol)
  }

  /** Check if any kill switch is active. */
  isAnyActive(): boolean {
    return this.states.size > 0
  }

  /** For tests. */
  _resetForTest(): void {
    this.states.clear()
  }
}
