import { readFileSync } from 'node:fs'
import { z } from 'zod'
import {
  DEFAULT_MICROSTRUCTURE_POSITION_STATE_PATH,
  POSITION_STATE_SCHEMA_VERSION,
} from './market_intel_constants.js'
import { writeJsonAtomicWithGeneration } from './atomic_write.js'

export const MicrostructurePositionStateSchema = z.object({
  schemaVersion: z.number().int().positive(),
  generation: z.number().int().nonnegative(),
  updatedAt: z.string(),
  positions: z.array(z.object({
    accountId: z.string(),
    symbol: z.string(),
    lane: z.enum(['microstructure_10x', 'microstructure_100x']),
    openedAt: z.string(),
    openedWithGeneration: z.number().int().nonnegative(),
    lastValidatedAt: z.string().nullable(),
    lastValidationGeneration: z.number().int().nonnegative().nullable(),
    closeMode: z.enum(['none', 'soft_close', 'hard_close']),
    closeReason: z.string().optional(),
  })),
})

export type MicrostructurePositionState = z.infer<typeof MicrostructurePositionStateSchema>
export type MicrostructurePositionStateEntry = MicrostructurePositionState['positions'][number]

export function createEmptyMicrostructurePositionState(): MicrostructurePositionState {
  return {
    schemaVersion: POSITION_STATE_SCHEMA_VERSION,
    generation: 0,
    updatedAt: new Date().toISOString(),
    positions: [],
  }
}
export function readMicrostructurePositionState(
  path = DEFAULT_MICROSTRUCTURE_POSITION_STATE_PATH,
): MicrostructurePositionState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    return MicrostructurePositionStateSchema.parse(migrateMicrostructurePositionState(raw))
  } catch {
    return createEmptyMicrostructurePositionState()
  }
}

export function writeMicrostructurePositionState(
  state: MicrostructurePositionState,
  opts: { path?: string; expectedGeneration?: number | null } = {},
): boolean {
  const path = opts.path ?? DEFAULT_MICROSTRUCTURE_POSITION_STATE_PATH
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
    purpose: 'paper_microstructure_position_state_write',
  })
  return result.written
}

export function nextMicrostructurePositionState(
  previous: MicrostructurePositionState,
  positions: MicrostructurePositionStateEntry[],
): MicrostructurePositionState {
  return {
    schemaVersion: POSITION_STATE_SCHEMA_VERSION,
    generation: previous.generation + 1,
    updatedAt: new Date().toISOString(),
    positions,
  }
}

export function migrateMicrostructurePositionState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  if (typeof record.schemaVersion === 'number' && record.schemaVersion >= POSITION_STATE_SCHEMA_VERSION) {
    return raw
  }
  return {
    ...createEmptyMicrostructurePositionState(),
    ...record,
    schemaVersion: POSITION_STATE_SCHEMA_VERSION,
    generation: typeof record.generation === 'number' ? record.generation : 0,
    positions: Array.isArray(record.positions) ? record.positions : [],
  }
}
