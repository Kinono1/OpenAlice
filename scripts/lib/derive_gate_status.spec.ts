import { describe, expect, it } from 'vitest'
import {
  deriveTopLevelStatus,
  mapToBusinessStatus,
  type CheckVerdict,
} from './derive_gate_status.js'

describe('deriveTopLevelStatus', () => {
  it('returns pass when all verdicts are ok', () => {
    expect(deriveTopLevelStatus(['ok', 'ok', 'ok'])).toBe('pass')
  })

  it('returns pass when all verdicts are pass', () => {
    expect(deriveTopLevelStatus(['pass', 'pass'])).toBe('pass')
  })

  it('returns pass for mixed ok and pass verdicts', () => {
    expect(deriveTopLevelStatus(['ok', 'pass', 'ok'])).toBe('pass')
  })

  it('returns needs_work when any verdict is needs_work', () => {
    expect(deriveTopLevelStatus(['ok', 'needs_work', 'ok'])).toBe('needs_work')
  })

  it('returns needs_work when any verdict is warning', () => {
    expect(deriveTopLevelStatus(['ok', 'warning'])).toBe('needs_work')
  })

  it('returns needs_work when any verdict is unavailable', () => {
    expect(deriveTopLevelStatus(['pass', 'unavailable'])).toBe('needs_work')
  })

  it('returns fail when any verdict is fail', () => {
    expect(deriveTopLevelStatus(['ok', 'fail', 'needs_work'])).toBe('fail')
  })

  it('prioritises fail over needs_work and warning', () => {
    const verdicts: CheckVerdict[] = ['needs_work', 'warning', 'fail', 'ok']
    expect(deriveTopLevelStatus(verdicts)).toBe('fail')
  })

  it('prioritises needs_work over warning and unavailable', () => {
    expect(deriveTopLevelStatus(['warning', 'needs_work', 'unavailable'])).toBe(
      'needs_work',
    )
  })

  it('returns pass for empty input (no checks ⇒ no failures)', () => {
    expect(deriveTopLevelStatus([])).toBe('pass')
  })
})

describe('mapToBusinessStatus', () => {
  it('maps pass → pass', () => {
    expect(mapToBusinessStatus('pass')).toBe('pass')
  })

  it('maps needs_work → warn', () => {
    expect(mapToBusinessStatus('needs_work')).toBe('warn')
  })

  it('maps fail → fail', () => {
    expect(mapToBusinessStatus('fail')).toBe('fail')
  })
})
