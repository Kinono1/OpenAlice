import { describe, expect, it } from 'vitest'
import { evaluateFreezeWindows } from './index.js'

describe('event freeze rules', () => {
  it('detects active freeze windows for relevant market scope', () => {
    const now = Date.UTC(2026, 3, 3, 12, 0, 0)
    const result = evaluateFreezeWindows(now, 'crypto', [
      {
        name: 'CPI',
        releaseTimeUtc: Date.UTC(2026, 3, 3, 13, 0, 0),
        severity: 'high',
        marketScope: ['crypto'],
        freezeRule: {
          preFreezeHours: 2,
          postFreezeHours: 0.5,
          maxActionDuringFreeze: 'reduce',
        },
      },
    ])

    expect(result.active).toBe(true)
    expect(result.maxActionDuringFreeze).toBe('reduce')
    expect(result.activeWindows).toHaveLength(1)
  })

  it('ignores irrelevant market scopes', () => {
    const now = Date.UTC(2026, 3, 3, 12, 0, 0)
    const result = evaluateFreezeWindows(now, 'crypto', [
      {
        name: 'A-share close review',
        releaseTimeUtc: Date.UTC(2026, 3, 3, 13, 0, 0),
        severity: 'medium',
        marketScope: ['a-share'],
        freezeRule: {
          preFreezeHours: 2,
          postFreezeHours: 1,
          maxActionDuringFreeze: 'reduce',
        },
      },
    ])

    expect(result.active).toBe(false)
    expect(result.activeWindows).toHaveLength(0)
  })
})
