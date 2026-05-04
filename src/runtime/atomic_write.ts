import {
  closeSync,
  existsSync,
  fdatasyncSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_RUNTIME_LOCK_STALE_MS } from './market_intel_constants.js'
import { acquireRuntimeLock } from './runtime_lock.js'

export interface AtomicWriteResult {
  written: boolean
  reason?: 'lock_busy' | 'generation_mismatch'
  currentGeneration?: number | null
}

export interface WriteJsonAtomicWithGenerationInput<T> {
  latestPath: string
  lockDir?: string
  value: T
  expectedGeneration?: number | null
  readGeneration?: (value: unknown) => number | null
  staleLockMs?: number
  purpose?: string
}

export function writeJsonAtomicWithGeneration<T>(
  input: WriteJsonAtomicWithGenerationInput<T>,
): AtomicWriteResult {
  const latestPath = input.latestPath
  const lockDir = input.lockDir ?? `${latestPath}.lock`
  const lock = acquireRuntimeLock(lockDir, {
    staleMs: input.staleLockMs ?? DEFAULT_RUNTIME_LOCK_STALE_MS,
    purpose: input.purpose ?? `write:${latestPath}`,
  })
  if (!lock) return { written: false, reason: 'lock_busy' }

  const readGeneration = input.readGeneration ?? defaultReadGeneration
  try {
    const currentGeneration = readExistingGeneration(latestPath, readGeneration)
    if (
      input.expectedGeneration !== undefined &&
      input.expectedGeneration !== null &&
      currentGeneration !== input.expectedGeneration &&
      !(currentGeneration === null && input.expectedGeneration === 0)
    ) {
      return {
        written: false,
        reason: 'generation_mismatch',
        currentGeneration,
      }
    }

    writeJsonAtomic(latestPath, input.value)
    return { written: true, currentGeneration }
  } finally {
    lock.release()
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = join(dirname(path), `.${path.split('/').pop()}.${process.pid}.${Date.now()}.tmp`)
  const text = `${JSON.stringify(value, null, 2)}\n`
  let fd: number | null = null
  try {
    fd = openSync(tmpPath, 'w')
    writeFileSync(fd, text, 'utf-8')
    fdatasyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmpPath, path)
    fsyncParentDir(path)
  } finally {
    if (fd !== null) closeSync(fd)
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      // Best effort cleanup only.
    }
  }
}

function readExistingGeneration(
  path: string,
  readGeneration: (value: unknown) => number | null,
): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return readGeneration(parsed)
  } catch {
    return null
  }
}

function defaultReadGeneration(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of ['contextGeneration', 'generation']) {
    const raw = record[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  }
  return null
}

function fsyncParentDir(path: string): void {
  let fd: number | null = null
  try {
    fd = openSync(dirname(path), 'r')
    fsyncSync(fd)
  } catch {
    // Some filesystems do not allow fsync on directories. tmp+fdatasync+rename
    // still protects readers from seeing partial JSON.
  } finally {
    if (fd !== null) closeSync(fd)
  }
}
