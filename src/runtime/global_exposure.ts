import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { isProcessAlive } from './runtime_lock.js'

export { isProcessAlive }

// ── Interfaces ──

export interface GlobalExposureLockV1 {
  pid: number
  processStartTime: number
  hostname: string
  ownerTask: string
  runId: string
  acquiredAt: number
  heartbeatAt: number
  schema_version: number
}

export type ReservationStatus = 'reserved' | 'intent_persisted' | 'submitted' | 'reconciled' | 'expired'

export interface GlobalExposureReservationV1 {
  reservation_id: string
  run_id: string
  strategy_id: string
  symbol: string
  delta_bps: number
  status: ReservationStatus
  created_at: number
  expires_at: number
  order_intent_id: string | null
  reconciled_at: number | null
  reason: string
}

// ── Defaults ──

export const DEFAULT_GLOBAL_EXPOSURE_LOCK_DIR = 'data/runtime/global_exposure_lock'
export const DEFAULT_GLOBAL_EXPOSURE_LEDGER_PATH = 'data/runtime/global_exposure_reservations.jsonl'
export const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 5000
export const DEFAULT_STALE_LOCK_AFTER_MS = 30000
export const DEFAULT_RESERVATION_TTL_MS = 60000
export const DEFAULT_ORPHAN_RESERVATION_AFTER_MS = 90000
export const DEFAULT_GROSS_EXPOSURE_LIMIT_BPS = 10000
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10000

export interface GlobalExposureOptions {
  ownerTask: string
  lockDir?: string
  lockAcquireTimeoutMs?: number
  staleLockAfterMs?: number
  reservationTtlMs?: number
  orphanReservationAfterMs?: number
  grossExposureLimitBps?: number
  ledgerPath?: string
  heartbeatIntervalMs?: number
}

export interface GlobalExposureLock {
  lockDir: string
  runId: string
  release: () => void
  refreshHeartbeat: () => void
}

// ── Global Lock ──

export function tryAcquireGlobalLock(opts: GlobalExposureOptions): GlobalExposureLock | null {
  const lockDir = opts.lockDir ?? DEFAULT_GLOBAL_EXPOSURE_LOCK_DIR
  const acquireTimeoutMs = opts.lockAcquireTimeoutMs ?? DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS
  const staleLockAfterMs = opts.staleLockAfterMs ?? DEFAULT_STALE_LOCK_AFTER_MS
  const deadline = Date.now() + acquireTimeoutMs

  mkdirSync(dirname(lockDir), { recursive: true })

  while (Date.now() < deadline) {
    const runId = tryCreateGlobalLock(lockDir, opts)
    if (runId) {
      return makeGlobalExposureLock(lockDir, runId, opts)
    }
    if (isGlobalLockStale(lockDir, staleLockAfterMs)) {
      rmSync(lockDir, { recursive: true, force: true })
      continue
    }
    sleep(200)
  }
  return null
}

function tryCreateGlobalLock(lockDir: string, opts: GlobalExposureOptions): string | null {
  try {
    mkdirSync(lockDir)
  } catch {
    return null
  }
  const runId = randomUUID()
  const now = Date.now()
  const lockInfo: GlobalExposureLockV1 = {
    pid: process.pid,
    processStartTime: Date.now() - process.uptime() * 1000,
    hostname: hostname(),
    ownerTask: opts.ownerTask,
    runId,
    acquiredAt: now,
    heartbeatAt: now,
    schema_version: 1,
  }
  writeFileSync(join(lockDir, 'info.json'), `${JSON.stringify(lockInfo, null, 2)}\n`, 'utf-8')
  return runId
}

function makeGlobalExposureLock(lockDir: string, runId: string, opts: GlobalExposureOptions): GlobalExposureLock {
  const heartbeatMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
  const heartbeatTimer = setInterval(() => {
    try {
      const path = join(lockDir, 'info.json')
      const raw = readFileSync(path, 'utf-8')
      const info = JSON.parse(raw) as GlobalExposureLockV1
      info.heartbeatAt = Date.now()
      writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
    } catch {
      // lock dir may have been removed
    }
  }, heartbeatMs)

  let released = false
  return {
    lockDir,
    runId,
    release: () => {
      if (released) return
      released = true
      clearInterval(heartbeatTimer)
      rmSync(lockDir, { recursive: true, force: true })
    },
    refreshHeartbeat: () => {
      if (released) return
      try {
        const path = join(lockDir, 'info.json')
        const raw = readFileSync(path, 'utf-8')
        const info = JSON.parse(raw) as GlobalExposureLockV1
        info.heartbeatAt = Date.now()
        writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
      } catch {
        // best effort
      }
    },
  }
}

export function releaseGlobalLock(lock: GlobalExposureLock): void {
  lock.release()
}

export function acquireStaleLock(lockDir: string, ownerTask: string): GlobalExposureLock | null {
  try {
    const raw = readFileSync(join(lockDir, 'info.json'), 'utf-8')
    const info = JSON.parse(raw) as Partial<GlobalExposureLockV1>
    const pid = typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : 0
    if (pid > 0 && isProcessAlive(pid)) {
      // PID is still alive — cannot take over
      return null
    }
  } catch {
    // No info.json or malformed — proceed to takeover
  }
  try {
    rmSync(lockDir, { recursive: true, force: true })
  } catch {
    // Directory may not exist
  }
  return tryAcquireGlobalLock({
    ownerTask,
    lockDir,
    lockAcquireTimeoutMs: 1000,
  })
}

// ── Global Lock Read ──

export function readGlobalExposureLockInfo(lockDir: string): GlobalExposureLockV1 | null {
  try {
    const raw = readFileSync(join(lockDir, 'info.json'), 'utf-8')
    return JSON.parse(raw) as GlobalExposureLockV1
  } catch {
    return null
  }
}

function isGlobalLockStale(lockDir: string, staleLockAfterMs: number): boolean {
  const info = readGlobalExposureLockInfo(lockDir)
  if (!info) return true
  const pid = typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : 0
  if (pid > 0) return !isProcessAlive(pid)
  if (typeof info.acquiredAt === 'number' && Number.isFinite(info.acquiredAt)) {
    return Date.now() - info.acquiredAt > staleLockAfterMs
  }
  return true
}

// ── Reservation Ledger ──

function resolveLedgerPath(ledgerPath?: string): string {
  return ledgerPath ?? DEFAULT_GLOBAL_EXPOSURE_LEDGER_PATH
}

function ensureLedgerDir(ledgerPath: string): void {
  mkdirSync(dirname(ledgerPath), { recursive: true })
}

function appendReservationRecord(record: GlobalExposureReservationV1, ledgerPath: string): void {
  ensureLedgerDir(ledgerPath)
  appendFileSync(ledgerPath, JSON.stringify(record) + '\n', 'utf-8')
}

function loadAllReservations(ledgerPath: string): GlobalExposureReservationV1[] {
  if (!existsSync(ledgerPath)) return []
  const raw = readFileSync(ledgerPath, 'utf-8')
  const lines = raw.trim().split('\n').filter(Boolean)
  return lines.map(line => JSON.parse(line) as GlobalExposureReservationV1)
}

function latestReservations(ledgerPath: string): Map<string, GlobalExposureReservationV1> {
  const records = loadAllReservations(ledgerPath)
  const latest = new Map<string, GlobalExposureReservationV1>()
  for (const record of records) {
    latest.set(record.reservation_id, record)
  }
  return latest
}

export function reserveExposure(
  strategyId: string,
  symbol: string,
  deltaBps: number,
  reason: string,
  opts?: {
    runId?: string
    reservationTtlMs?: number
    ledgerPath?: string
  },
): GlobalExposureReservationV1 {
  const now = Date.now()
  const reservationTtlMs = opts?.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS
  const ledgerPath = resolveLedgerPath(opts?.ledgerPath)
  const reservation: GlobalExposureReservationV1 = {
    reservation_id: randomUUID(),
    run_id: opts?.runId ?? '',
    strategy_id: strategyId,
    symbol,
    delta_bps: deltaBps,
    status: 'reserved',
    created_at: now,
    expires_at: now + reservationTtlMs,
    order_intent_id: null,
    reconciled_at: null,
    reason,
  }
  appendReservationRecord(reservation, ledgerPath)
  return reservation
}

export function markIntentPersisted(reservationId: string, orderIntentId: string, ledgerPath?: string): boolean {
  return updateReservationStatus(reservationId, 'intent_persisted', ledgerPath, { order_intent_id: orderIntentId })
}

export function markSubmitted(reservationId: string, ledgerPath?: string): boolean {
  return updateReservationStatus(reservationId, 'submitted', ledgerPath)
}

export function markReconciled(reservationId: string, ledgerPath?: string): boolean {
  return updateReservationStatus(reservationId, 'reconciled', ledgerPath, { reconciled_at: Date.now() })
}

export function markExpired(reservationId: string, ledgerPath?: string): boolean {
  return updateReservationStatus(reservationId, 'expired', ledgerPath)
}

function updateReservationStatus(
  reservationId: string,
  status: ReservationStatus,
  ledgerPath?: string,
  extra?: Partial<GlobalExposureReservationV1>,
): boolean {
  const resolvedPath = resolveLedgerPath(ledgerPath)
  const latest = latestReservations(resolvedPath)
  const current = latest.get(reservationId)
  if (!current) return false
  const updated: GlobalExposureReservationV1 = {
    ...current,
    status,
    ...extra,
  }
  appendReservationRecord(updated, resolvedPath)
  return true
}

export function loadActiveReservations(opts?: {
  ledgerPath?: string
  orphanReservationAfterMs?: number
}): {
  active: GlobalExposureReservationV1[]
  expired: GlobalExposureReservationV1[]
  orphans: GlobalExposureReservationV1[]
} {
  const ledgerPath = resolveLedgerPath(opts?.ledgerPath)
  const orphanAfterMs = opts?.orphanReservationAfterMs ?? DEFAULT_ORPHAN_RESERVATION_AFTER_MS
  const now = Date.now()
  const latest = latestReservations(ledgerPath)
  const active: GlobalExposureReservationV1[] = []
  const expired: GlobalExposureReservationV1[] = []
  const orphans: GlobalExposureReservationV1[] = []

  const activeStates: ReservationStatus[] = ['reserved', 'intent_persisted', 'submitted']

  for (const reservation of latest.values()) {
    const isExpired = reservation.expires_at <= now
    const isActiveState = activeStates.includes(reservation.status)

    if (isExpired) {
      expired.push(reservation)
    } else if (isActiveState) {
      active.push(reservation)
    }

    if (isActiveState && reservation.created_at > 0 && now - reservation.created_at > orphanAfterMs) {
      orphans.push(reservation)
    }
  }

  return { active, expired, orphans }
}

export function resolveOrphanReservations(opts?: {
  ledgerPath?: string
  orphanReservationAfterMs?: number
  autoExpire?: boolean
}): {
  resolved: GlobalExposureReservationV1[]
  expired: GlobalExposureReservationV1[]
} {
  const ledgerPath = resolveLedgerPath(opts?.ledgerPath)
  const orphanAfterMs = opts?.orphanReservationAfterMs ?? DEFAULT_ORPHAN_RESERVATION_AFTER_MS
  const autoExpire = opts?.autoExpire ?? true
  const now = Date.now()
  const latest = latestReservations(ledgerPath)
  const resolved: GlobalExposureReservationV1[] = []
  const expired: GlobalExposureReservationV1[] = []

  const activeStates: ReservationStatus[] = ['reserved', 'intent_persisted']

  for (const reservation of latest.values()) {
    if (reservation.expires_at <= now) {
      expired.push(reservation)
      continue
    }
    if (
      activeStates.includes(reservation.status) &&
      reservation.created_at > 0 &&
      now - reservation.created_at > orphanAfterMs
    ) {
      if (autoExpire) {
        const updated: GlobalExposureReservationV1 = {
          ...reservation,
          status: 'expired',
        }
        appendReservationRecord(updated, ledgerPath)
        resolved.push(updated)
      } else {
        resolved.push(reservation)
      }
    }
  }

  return { resolved, expired }
}

// ── Helpers ──

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
