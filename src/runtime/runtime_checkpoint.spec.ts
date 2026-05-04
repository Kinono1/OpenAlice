import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  RUNTIME_CHECKPOINT_VERSION,
  RuntimeCheckpointStore,
} from './runtime_checkpoint.js'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'openalice-checkpoint-'))
  roots.push(root)
  return root
}

function writeRaw(path: string, raw: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, raw, 'utf-8')
}

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

describe('RuntimeCheckpointStore', () => {
  it('saves and loads versioned checkpoints with stable timestamps', async () => {
    const store = new RuntimeCheckpointStore({ rootDir: tempRoot(), namespace: 'market_intel' })
    const created = store.save({
      runId: 'run_001',
      step: 'started',
      state: { count: 1 },
      now: new Date('2026-05-04T00:00:00.000Z'),
    })
    const updated = store.save({
      runId: 'run_001',
      step: 'finished',
      state: { count: 2 },
      now: new Date('2026-05-04T01:00:00.000Z'),
    })

    expect(created.createdAt).toBe('2026-05-04T00:00:00.000Z')
    expect(updated.createdAt).toBe(created.createdAt)
    expect(updated.updatedAt).toBe('2026-05-04T01:00:00.000Z')

    const loaded = store.load('run_001', z.object({ count: z.number() }))
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.checkpoint).toMatchObject({
        version: RUNTIME_CHECKPOINT_VERSION,
        runId: 'run_001',
        step: 'finished',
        state: { count: 2 },
      })
      expect(JSON.parse(await readFile(loaded.path, 'utf-8'))).toMatchObject({
        runId: 'run_001',
        step: 'finished',
      })
    }
  })

  it('keeps checkpoint runId and namespace as safe path components', () => {
    expect(() => new RuntimeCheckpointStore({
      rootDir: tempRoot(),
      namespace: '../bad',
    })).toThrow(/checkpoint namespace/)

    const store = new RuntimeCheckpointStore({ rootDir: tempRoot() })
    expect(() => store.pathFor('../run')).toThrow(/checkpoint runId/)
    expect(() => store.pathFor('CON')).toThrow(/checkpoint runId/)
  })

  it('returns diagnostics for missing, malformed, unsupported, and invalid checkpoints', () => {
    const root = tempRoot()
    const store = new RuntimeCheckpointStore({ rootDir: root })

    expect(store.load('missing')).toMatchObject({
      ok: false,
      diagnostic: { kind: 'missing' },
    })

    writeRaw(store.pathFor('malformed'), '{"version":')
    expect(store.load('malformed')).toMatchObject({
      ok: false,
      diagnostic: { kind: 'malformed_json' },
    })

    writeRaw(store.pathFor('old'), JSON.stringify({ version: 999 }))
    expect(store.load('old')).toMatchObject({
      ok: false,
      diagnostic: { kind: 'version_unsupported', version: 999 },
    })

    writeRaw(
      store.pathFor('invalid'),
      `${JSON.stringify({
        version: RUNTIME_CHECKPOINT_VERSION,
        runId: 'invalid',
        step: 'started',
        createdAt: '2026-05-04T00:00:00.000Z',
        updatedAt: '2026-05-04T00:00:00.000Z',
        state: { count: 'bad' },
      })}\n`,
    )
    expect(store.load('invalid', z.object({ count: z.number() }))).toMatchObject({
      ok: false,
      diagnostic: { kind: 'schema_invalid' },
    })
  })

  it('clears checkpoints only when present', () => {
    const store = new RuntimeCheckpointStore({ rootDir: tempRoot() })
    expect(store.clear('run_001')).toBe(false)

    store.save({
      runId: 'run_001',
      step: 'started',
      state: {},
      now: new Date('2026-05-04T00:00:00.000Z'),
    })

    expect(store.clear('run_001')).toBe(true)
    expect(store.load('run_001')).toMatchObject({
      ok: false,
      diagnostic: { kind: 'missing' },
    })
  })
})
