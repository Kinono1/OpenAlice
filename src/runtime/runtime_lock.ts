import { randomUUID } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_RUNTIME_LOCK_STALE_MS, DEFAULT_SYSTEM_FUSE_EVENTS_PATH } from './market_intel_constants.js'
import { appendRuntimeEventSync } from './runtime_events.js'

export interface RuntimeLockOptions {
  staleMs?: number
  purpose?: string
  eventLogPath?: string
}

export interface RuntimeLock {
  lockDir: string
  release: () => void
}

export interface LockInfo {
  pid: number
  ts: number
  hostname: string
  purpose: string
  processStartTime: number
  runId: string
  heartbeatAt: number
}

export function acquireRuntimeLock(lockDir: string, options: RuntimeLockOptions = {}): RuntimeLock | null {
  const staleMs = options.staleMs ?? DEFAULT_RUNTIME_LOCK_STALE_MS
  const eventLogPath = options.eventLogPath ?? DEFAULT_SYSTEM_FUSE_EVENTS_PATH
  mkdirSync(dirname(lockDir), { recursive: true })

  if (tryCreateLock(lockDir, options.purpose ?? 'runtime_write')) {
    return makeLock(lockDir)
  }

  if (!isRuntimeLockStale(lockDir, staleMs)) return null

  rmSync(lockDir, { recursive: true, force: true })
  appendRuntimeEventSync(eventLogPath, {
    type: 'runtime_lock_stale_removed',
    lockDir,
    staleMs,
    purpose: options.purpose ?? 'runtime_write',
  })

  if (!tryCreateLock(lockDir, options.purpose ?? 'runtime_write')) return null
  return makeLock(lockDir)
}

function tryCreateLock(lockDir: string, purpose: string): boolean {
  try {
    mkdirSync(lockDir)
    const info: LockInfo = {
      pid: process.pid,
      ts: Date.now(),
      hostname: hostname(),
      purpose,
      processStartTime: Date.now() - process.uptime() * 1000,
      runId: randomUUID(),
      heartbeatAt: Date.now(),
    }
    writeFileSync(join(lockDir, 'info.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
    return true
  } catch {
    return false
  }
}

function makeLock(lockDir: string): RuntimeLock {
  return {
    lockDir,
    release: () => {
      rmSync(lockDir, { recursive: true, force: true })
    },
  }
}

export function isRuntimeLockStale(lockDir: string, staleMs: number): boolean {
  const now = Date.now()
  try {
    const raw = readFileSync(join(lockDir, 'info.json'), 'utf-8')
    const info = JSON.parse(raw) as Partial<LockInfo>
    const ts = typeof info.ts === 'number' && Number.isFinite(info.ts) ? info.ts : 0
    const pid = typeof info.pid === 'number' && Number.isFinite(info.pid) ? info.pid : 0

    if (typeof info.heartbeatAt === 'number' && Number.isFinite(info.heartbeatAt)) {
      if (now - info.heartbeatAt <= staleMs) {
        // Heartbeat is recent — rely on PID check
        if (pid > 0) return !isProcessAlive(pid)
        return false
      }
      // Heartbeat is stale — do not takeover (possible hung process)
      return false
    }

    // No heartbeat — fall back to old behavior
    if (pid > 0) return !isProcessAlive(pid)
    if (ts > 0 && now - ts > staleMs) return true
    return false
  } catch {
    try {
      const stat = statSync(lockDir)
      return now - stat.mtimeMs > staleMs
    } catch {
      return true
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH')
  }
}

export function refreshHeartbeat(lockDir: string): void {
  try {
    const path = join(lockDir, 'info.json')
    const raw = readFileSync(path, 'utf-8')
    const info = JSON.parse(raw) as LockInfo
    info.heartbeatAt = Date.now()
    writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, 'utf-8')
  } catch {
    // best effort
  }
}

export function readLockInfo(lockDir: string): LockInfo | null {
  try {
    const raw = readFileSync(join(lockDir, 'info.json'), 'utf-8')
    return JSON.parse(raw) as LockInfo
  } catch {
    return null
  }
}
