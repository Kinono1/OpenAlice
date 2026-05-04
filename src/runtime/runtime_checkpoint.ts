import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { safePathComponent } from '../core/path-safety.js'
import { writeJsonAtomic } from './atomic_write.js'

export const RUNTIME_CHECKPOINT_VERSION = 1
export const DEFAULT_RUNTIME_CHECKPOINT_ROOT = 'data/runtime/checkpoints'

export interface RuntimeCheckpoint<TState> {
  version: typeof RUNTIME_CHECKPOINT_VERSION
  runId: string
  step: string
  createdAt: string
  updatedAt: string
  state: TState
}

export interface RuntimeCheckpointStoreOptions {
  rootDir?: string
  namespace?: string
}

export type RuntimeCheckpointLoadResult<TState> =
  | { ok: true; checkpoint: RuntimeCheckpoint<TState>; path: string }
  | { ok: false; checkpoint: null; path: string; diagnostic: RuntimeCheckpointDiagnostic }

export type RuntimeCheckpointDiagnostic =
  | { kind: 'missing' }
  | { kind: 'malformed_json'; message: string }
  | { kind: 'schema_invalid'; message: string }
  | { kind: 'version_unsupported'; version: unknown }

const RuntimeCheckpointEnvelopeSchema = z.object({
  version: z.literal(RUNTIME_CHECKPOINT_VERSION),
  runId: z.string().min(1),
  step: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  state: z.unknown(),
})

export class RuntimeCheckpointStore {
  readonly rootDir: string
  readonly namespace: string

  constructor(options?: RuntimeCheckpointStoreOptions) {
    this.rootDir = resolve(options?.rootDir ?? DEFAULT_RUNTIME_CHECKPOINT_ROOT)
    this.namespace = safePathComponent(options?.namespace ?? 'default', {
      kind: 'checkpoint namespace',
      maxLength: 64,
    })
  }

  pathFor(runId: string): string {
    const safeRunId = safePathComponent(runId, { kind: 'checkpoint runId', maxLength: 128 })
    return join(this.rootDir, this.namespace, `${safeRunId}.json`)
  }

  save<TState>(input: {
    runId: string
    step: string
    state: TState
    now?: Date
  }): RuntimeCheckpoint<TState> {
    const path = this.pathFor(input.runId)
    const existing = this.load<TState>(input.runId)
    const now = (input.now ?? new Date()).toISOString()
    const checkpoint: RuntimeCheckpoint<TState> = {
      version: RUNTIME_CHECKPOINT_VERSION,
      runId: input.runId,
      step: input.step,
      createdAt: existing.ok ? existing.checkpoint.createdAt : now,
      updatedAt: now,
      state: input.state,
    }
    writeJsonAtomic(path, checkpoint)
    return checkpoint
  }

  load<TState>(runId: string, stateSchema?: z.ZodType<TState>): RuntimeCheckpointLoadResult<TState> {
    const path = this.pathFor(runId)
    if (!existsSync(path)) {
      return { ok: false, checkpoint: null, path, diagnostic: { kind: 'missing' } }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    } catch (error) {
      return {
        ok: false,
        checkpoint: null,
        path,
        diagnostic: { kind: 'malformed_json', message: errorMessage(error) },
      }
    }

    const version = parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>).version
      : undefined
    if (version !== RUNTIME_CHECKPOINT_VERSION) {
      return {
        ok: false,
        checkpoint: null,
        path,
        diagnostic: { kind: 'version_unsupported', version },
      }
    }

    const envelope = RuntimeCheckpointEnvelopeSchema.safeParse(parsed)
    if (!envelope.success) {
      return {
        ok: false,
        checkpoint: null,
        path,
        diagnostic: { kind: 'schema_invalid', message: z.prettifyError(envelope.error) },
      }
    }

    const state = stateSchema ? stateSchema.safeParse(envelope.data.state) : null
    if (state && !state.success) {
      return {
        ok: false,
        checkpoint: null,
        path,
        diagnostic: { kind: 'schema_invalid', message: z.prettifyError(state.error) },
      }
    }

    const checkpoint: RuntimeCheckpoint<TState> = {
      ...envelope.data,
      state: state ? state.data : envelope.data.state as TState,
    }
    return { ok: true, checkpoint, path }
  }

  clear(runId: string): boolean {
    const path = this.pathFor(runId)
    if (!existsSync(path)) {
      return false
    }
    rmSync(path)
    return true
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
