import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import type { KillSwitchState } from '../domain/trading/kill-switch.js'

export interface DurableStateStoreHealth {
  ok: boolean
  degradedReason?: string
}

export interface KillSwitchStateStore {
  loadAll(): KillSwitchState[]
  upsert(state: KillSwitchState): void
  delete(symbol: string): void
  clear?(): void
  close?(): void
  health?(): DurableStateStoreHealth
}

interface KillSwitchStateRow {
  symbol: unknown
  policy: unknown
  level: unknown
  activated_at: unknown
  reason: unknown
}

export class SqliteDurableStateStore implements KillSwitchStateStore {
  private readonly db: DatabaseSync
  private degradedReason: string | undefined

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true })
    this.db = new DatabaseSync(filePath)
    try {
      this.db.enableDefensive(true)
    } catch {
      // Older Node SQLite builds may not expose defensive mode.
    }
    this.initialize()
  }

  loadAll(): KillSwitchState[] {
    try {
      const rows = this.db.prepare(
        `SELECT symbol, policy, activated_at, reason
         FROM kill_switch_state
         ORDER BY symbol ASC`,
      ).all() as unknown as KillSwitchStateRow[]
      this.degradedReason = undefined
      return rows.map(rowToKillSwitchState).filter(isKillSwitchState)
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  upsert(state: KillSwitchState): void {
    try {
      this.db.prepare(
        `INSERT INTO kill_switch_state(symbol, policy, level, activated_at, reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol) DO UPDATE SET
           policy = excluded.policy,
           level = excluded.level,
           activated_at = excluded.activated_at,
           reason = excluded.reason,
           updated_at = excluded.updated_at`,
      ).run(
        state.symbol,
        state.policy,
        state.level,
        state.activatedAt,
        state.reason,
        Date.now(),
      )
      this.degradedReason = undefined
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  delete(symbol: string): void {
    try {
      this.db.prepare('DELETE FROM kill_switch_state WHERE symbol = ?').run(symbol)
      this.degradedReason = undefined
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  clear(): void {
    try {
      this.db.exec('DELETE FROM kill_switch_state')
      this.degradedReason = undefined
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  close(): void {
    this.db.close()
  }

  health(): DurableStateStoreHealth {
    return this.degradedReason
      ? { ok: false, degradedReason: this.degradedReason }
      : { ok: true }
  }

  private initialize(): void {
    try {
      this.db.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS kill_switch_state (
          symbol TEXT PRIMARY KEY NOT NULL,
          policy TEXT NOT NULL CHECK (policy IN ('block_new_only', 'block_all')),
          level INTEGER NOT NULL DEFAULT 2 CHECK (level >= 0 AND level <= 4),
          activated_at INTEGER NOT NULL,
          reason TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      this.degradedReason = undefined
    } catch (error) {
      this.markDegraded(error)
      throw error
    }
  }

  private markDegraded(error: unknown): void {
    this.degradedReason = error instanceof Error ? error.message : String(error)
  }
}

function rowToKillSwitchState(row: KillSwitchStateRow): KillSwitchState | null {
  if (
    typeof row.symbol !== 'string' ||
    (row.policy !== 'block_new_only' && row.policy !== 'block_all') ||
    typeof row.activated_at !== 'number' ||
    typeof row.reason !== 'string'
  ) {
    return null
  }

  return {
    symbol: row.symbol,
    level: (typeof row.level === 'number' && row.level >= 0 && row.level <= 4 ? row.level : 2) as import('../domain/trading/kill-switch.js').KillSwitchLevel,
    policy: row.policy,
    activatedAt: row.activated_at,
    reason: row.reason,
  }
}

function isKillSwitchState(state: KillSwitchState | null): state is KillSwitchState {
  return state !== null
}
