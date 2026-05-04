import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  DEFAULT_OPENALICE_HEARTBEAT_PATH,
  DEFAULT_SYSTEM_FUSE_PATH,
  SYSTEM_FUSE_HEARTBEAT_TIMEOUT_MS,
  SYSTEM_FUSE_SCHEMA_VERSION,
} from './market_intel_constants.js'
import { writeJsonAtomicWithGeneration } from './atomic_write.js'

export interface SystemFuseState {
  schemaVersion: number
  generation: number
  updatedAt: string
  status: 'ok' | 'risk_off'
  reason: string | null
  heartbeatAgeMs: number | null
}

export interface HeartbeatState {
  schemaVersion: number
  pid: number
  ts: number
  iso: string
  lane: string
}

export function createOkSystemFuseState(): SystemFuseState {
  return {
    schemaVersion: SYSTEM_FUSE_SCHEMA_VERSION,
    generation: 0,
    updatedAt: new Date().toISOString(),
    status: 'ok',
    reason: null,
    heartbeatAgeMs: null,
  }
}

export function readSystemFuse(path = DEFAULT_SYSTEM_FUSE_PATH): SystemFuseState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<SystemFuseState>
    return {
      schemaVersion: SYSTEM_FUSE_SCHEMA_VERSION,
      generation: typeof raw.generation === 'number' ? raw.generation : 0,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      status: raw.status === 'risk_off' ? 'risk_off' : 'ok',
      reason: typeof raw.reason === 'string' ? raw.reason : null,
      heartbeatAgeMs: typeof raw.heartbeatAgeMs === 'number' ? raw.heartbeatAgeMs : null,
    }
  } catch {
    return createOkSystemFuseState()
  }
}

export function writeSystemFuse(
  state: SystemFuseState,
  opts: { path?: string; expectedGeneration?: number | null } = {},
): boolean {
  const path = opts.path ?? DEFAULT_SYSTEM_FUSE_PATH
  const result = writeJsonAtomicWithGeneration({
    latestPath: path,
    lockDir: `${path}.lock`,
    value: state,
    expectedGeneration: opts.expectedGeneration,
    readGeneration: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const raw = (value as Record<string, unknown>).generation
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    },
    purpose: 'system_fuse_write',
  })
  return result.written
}

export function writeMicrostructureHeartbeat(path = DEFAULT_OPENALICE_HEARTBEAT_PATH): void {
  mkdirSync(dirname(path), { recursive: true })
  const heartbeat: HeartbeatState = {
    schemaVersion: 1,
    pid: process.pid,
    ts: Date.now(),
    iso: new Date().toISOString(),
    lane: 'microstructure_stress',
  }
  writeFileSync(path, `${JSON.stringify(heartbeat, null, 2)}\n`, 'utf-8')
}

export function updateSystemFuseFromHeartbeat(input: {
  heartbeatPath?: string
  fusePath?: string
  nowMs?: number
  timeoutMs?: number
} = {}): SystemFuseState {
  const heartbeatPath = input.heartbeatPath ?? DEFAULT_OPENALICE_HEARTBEAT_PATH
  const fusePath = input.fusePath ?? DEFAULT_SYSTEM_FUSE_PATH
  const nowMs = input.nowMs ?? Date.now()
  const timeoutMs = input.timeoutMs ?? SYSTEM_FUSE_HEARTBEAT_TIMEOUT_MS
  const previous = readSystemFuse(fusePath)
  let heartbeatAgeMs: number | null = null

  if (existsSync(heartbeatPath)) {
    try {
      const heartbeat = JSON.parse(readFileSync(heartbeatPath, 'utf-8')) as Partial<HeartbeatState>
      heartbeatAgeMs = typeof heartbeat.ts === 'number' ? nowMs - heartbeat.ts : null
    } catch {
      heartbeatAgeMs = null
    }
  }

  const next: SystemFuseState = {
    schemaVersion: SYSTEM_FUSE_SCHEMA_VERSION,
    generation: previous.generation + 1,
    updatedAt: new Date(nowMs).toISOString(),
    status: heartbeatAgeMs === null || heartbeatAgeMs > timeoutMs ? 'risk_off' : 'ok',
    reason: heartbeatAgeMs === null || heartbeatAgeMs > timeoutMs ? 'heartbeat_timeout' : null,
    heartbeatAgeMs,
  }
  writeSystemFuse(next, { path: fusePath, expectedGeneration: previous.generation })
  return next
}

