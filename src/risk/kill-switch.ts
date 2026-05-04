import { existsSync, readFileSync } from 'node:fs'

export type KillState = 'normal' | 'block_new_positions' | 'close_only' | 'halt_all' | 'manual_override'

export interface KillSwitch {
  enabled: boolean
  state: KillState
  reason: string
  created_at: string
  allow_close_only: boolean
  block_new_positions: boolean
}

const DEFAULT_KILL_PATH = 'data/runtime/KILL_SWITCH.json'

export function readKillSwitch(path: string = DEFAULT_KILL_PATH): KillSwitch | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    if (!raw || typeof raw.enabled !== 'boolean') return null
    return {
      enabled: raw.enabled,
      state: raw.state ?? 'normal',
      reason: raw.reason ?? '',
      created_at: raw.created_at ?? '',
      allow_close_only: raw.allow_close_only ?? false,
      block_new_positions: raw.block_new_positions ?? false,
    }
  } catch {
    // malformed file → fail closed
    return {
      enabled: true,
      state: 'halt_all',
      reason: 'malformed KILL_SWITCH.json',
      created_at: new Date().toISOString(),
      allow_close_only: true,
      block_new_positions: true,
    }
  }
}

export function getKillState(path?: string): KillState {
  const ks = readKillSwitch(path)
  if (!ks || !ks.enabled) return 'normal'
  return ks.state
}

export function isTradingAllowed(path?: string): boolean {
  const state = getKillState(path)
  return state === 'normal' || state === 'manual_override'
}

export function isCloseOnly(path?: string): boolean {
  const ks = readKillSwitch(path)
  return ks?.enabled === true && (ks.state === 'close_only' || ks.allow_close_only === true)
}
