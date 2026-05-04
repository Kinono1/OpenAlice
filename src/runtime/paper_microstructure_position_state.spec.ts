import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEmptyMicrostructurePositionState,
  migrateMicrostructurePositionState,
  nextMicrostructurePositionState,
  readMicrostructurePositionState,
  writeMicrostructurePositionState,
} from './paper_microstructure_position_state.js'

describe('paper microstructure position state', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function tempPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'openalice-position-state-'))
    roots.push(root)
    return join(root, 'state.json')
  }

  it('returns a conservative empty state when the file is missing', () => {
    const state = readMicrostructurePositionState(tempPath())

    expect(state.generation).toBe(0)
    expect(state.positions).toEqual([])
  })

  it('writes with generation checks and refuses stale writes', () => {
    const path = tempPath()
    const first = createEmptyMicrostructurePositionState()

    expect(writeMicrostructurePositionState(first, { path, expectedGeneration: 0 })).toBe(true)

    const second = nextMicrostructurePositionState(first, [{
      accountId: 'paper-1',
      symbol: 'BTC-USDT',
      lane: 'microstructure_10x',
      openedAt: '2026-05-04T00:00:00.000Z',
      openedWithGeneration: 0,
      lastValidatedAt: null,
      lastValidationGeneration: null,
      closeMode: 'none',
    }])

    expect(writeMicrostructurePositionState(second, { path, expectedGeneration: 0 })).toBe(true)
    expect(writeMicrostructurePositionState(
      nextMicrostructurePositionState(second, []),
      { path, expectedGeneration: 0 },
    )).toBe(false)

    const loaded = readMicrostructurePositionState(path)
    expect(loaded.generation).toBe(1)
    expect(loaded.positions).toHaveLength(1)
  })

  it('migrates legacy-like records into the current schema', () => {
    expect(migrateMicrostructurePositionState({
      generation: 3,
      positions: [],
    })).toMatchObject({
      schemaVersion: 1,
      generation: 3,
      positions: [],
    })
  })
})
