import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getKillState, isCloseOnly, isTradingAllowed, readKillSwitch } from './kill-switch.js'

describe('kill-switch', () => {
  let root: string | null = null

  afterEach(() => {
    if (root) {
      rmSync(root, { recursive: true, force: true })
      root = null
    }
  })

  it('treats missing file as normal and trading allowed', () => {
    expect(readKillSwitch(join(tmpdir(), `missing-${Date.now()}.json`))).toBeNull()
    expect(getKillState(join(tmpdir(), `missing-${Date.now()}.json`))).toBe('normal')
    expect(isTradingAllowed(join(tmpdir(), `missing-${Date.now()}.json`))).toBe(true)
  })

  it('parses close-only state from persisted file', () => {
    root = mkdtempSync(join(tmpdir(), 'openalice-kill-'))
    const path = join(root, 'KILL_SWITCH.json')
    writeFileSync(path, JSON.stringify({
      enabled: true,
      state: 'close_only',
      reason: 'test',
      created_at: '2026-05-04T00:00:00.000Z',
      allow_close_only: true,
      block_new_positions: true,
    }))

    expect(getKillState(path)).toBe('close_only')
    expect(isCloseOnly(path)).toBe(true)
    expect(isTradingAllowed(path)).toBe(false)
  })

  it('fails closed on malformed files', () => {
    root = mkdtempSync(join(tmpdir(), 'openalice-kill-malformed-'))
    const path = join(root, 'KILL_SWITCH.json')
    writeFileSync(path, '{broken')

    expect(getKillState(path)).toBe('halt_all')
    expect(isCloseOnly(path)).toBe(true)
    expect(isTradingAllowed(path)).toBe(false)
  })
})
