import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DEFAULT_INFLIGHT_CALL_PATH, INFLIGHT_CALL_SCHEMA_VERSION } from './market_intel_constants.js'
import { writeJsonAtomicWithGeneration } from './atomic_write.js'

export interface InflightMarketIntelCall {
  schemaVersion: number
  generation: number
  callId: string
  trigger: 'ttl' | 'event' | 'manual'
  priority: 'low' | 'medium' | 'high' | 'critical'
  startedAt: string
  supersedesCallId?: string
}

export function createInflightCall(input: {
  trigger: InflightMarketIntelCall['trigger']
  priority: InflightMarketIntelCall['priority']
  supersedesCallId?: string
  path?: string
}): InflightMarketIntelCall {
  const previous = readInflightCall(input.path)
  const call: InflightMarketIntelCall = {
    schemaVersion: INFLIGHT_CALL_SCHEMA_VERSION,
    generation: (previous?.generation ?? -1) + 1,
    callId: randomUUID(),
    trigger: input.trigger,
    priority: input.priority,
    startedAt: new Date().toISOString(),
    supersedesCallId: input.supersedesCallId,
  }
  writeInflightCall(call, { path: input.path, expectedGeneration: previous?.generation ?? null })
  return call
}

export function readInflightCall(path = DEFAULT_INFLIGHT_CALL_PATH): InflightMarketIntelCall | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<InflightMarketIntelCall>
    if (typeof raw.callId !== 'string') return null
    return {
      schemaVersion: INFLIGHT_CALL_SCHEMA_VERSION,
      generation: typeof raw.generation === 'number' ? raw.generation : 0,
      callId: raw.callId,
      trigger: raw.trigger === 'event' || raw.trigger === 'manual' ? raw.trigger : 'ttl',
      priority: raw.priority === 'critical' || raw.priority === 'high' || raw.priority === 'medium'
        ? raw.priority
        : 'low',
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
      supersedesCallId: typeof raw.supersedesCallId === 'string' ? raw.supersedesCallId : undefined,
    }
  } catch {
    return null
  }
}

export function writeInflightCall(
  call: InflightMarketIntelCall,
  opts: { path?: string; expectedGeneration?: number | null } = {},
): boolean {
  const path = opts.path ?? DEFAULT_INFLIGHT_CALL_PATH
  const result = writeJsonAtomicWithGeneration({
    latestPath: path,
    lockDir: `${path}.lock`,
    value: call,
    expectedGeneration: opts.expectedGeneration,
    readGeneration: value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const raw = (value as Record<string, unknown>).generation
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
    },
    purpose: 'inflight_market_intel_call_write',
  })
  return result.written
}

export function isInflightCallCurrent(callId: string, path = DEFAULT_INFLIGHT_CALL_PATH): boolean {
  return readInflightCall(path)?.callId === callId
}

