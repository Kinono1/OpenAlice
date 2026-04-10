import { describe, expect, it } from 'vitest'
import {
  isReleaseGateStatusBlocking,
  type PersistedReleaseGateStatus,
} from './release_gate_status.js'

function makeStatus(overrides?: Partial<PersistedReleaseGateStatus>): PersistedReleaseGateStatus {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    allowPaperTrading: true,
    allowLiveTrading: true,
    failedChecks: [],
    warningChecks: [],
    ...overrides,
  }
}

describe('release_gate_status', () => {
  it('blocks paper mode when allowPaperTrading is false', () => {
    const result = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: false, allowLiveTrading: true, failedChecks: ['significance'] }),
      'paper',
    )

    expect(result).toEqual({
      blocking: true,
      reason: 'paper_release_gate_failed:significance',
    })
  })

  it('allows paper mode when allowPaperTrading is true even if live remains blocked', () => {
    const paper = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: true, allowLiveTrading: false, failedChecks: ['execution_quality'] }),
      'paper',
    )
    const live = isReleaseGateStatusBlocking(
      makeStatus({ allowPaperTrading: true, allowLiveTrading: false, failedChecks: ['execution_quality'] }),
      'live',
    )

    expect(paper).toEqual({ blocking: false })
    expect(live).toEqual({
      blocking: true,
      reason: 'live_release_gate_failed:execution_quality',
    })
  })
})
