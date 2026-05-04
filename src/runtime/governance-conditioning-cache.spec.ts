import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GovernanceConditioningCache } from './governance-conditioning-cache.js'
import { runGovernanceContextAgent } from './governance-context-agent.js'

vi.mock('./governance-context-agent.js', () => ({
  runGovernanceContextAgent: vi.fn(),
}))

describe('GovernanceConditioningCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-04T00:00:00.000Z'))
    vi.mocked(runGovernanceContextAgent).mockReset()
  })

  it('returns conservative default conditioning before the first successful run', () => {
    const cache = new GovernanceConditioningCache({ runOnStart: false })

    expect(cache.getConditioning()).toEqual({
      multiplierBySignal: {},
      reasons: ['governance_not_yet_run'],
    })
  })

  it('keeps last known conditioning when a later run fails', async () => {
    vi.mocked(runGovernanceContextAgent)
      .mockResolvedValueOnce({
        override: {
          macroRegime: 'normal',
          action: 'no_change',
          parameters: {},
          reasoning: 'ok',
          confidenceScore: 0.7,
        },
        conditioning: {
          multiplierBySignal: { 'momentum-composite': 0.5 },
          reasons: ['test_conditioning'],
        },
      })
      .mockRejectedValueOnce(new Error('later failure'))

    const cache = new GovernanceConditioningCache({ intervalMs: 1_000 })
    cache.start(() => ({
      currentRegime: 'normal',
      factorICByName: {},
      dataQualityState: 'good',
      recentDrawdown: 0,
    }))

    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(cache.getConditioning()).toEqual({
      multiplierBySignal: { 'momentum-composite': 0.5 },
      reasons: ['test_conditioning'],
    })
    expect(cache.getLastRunAt()).toBeGreaterThan(0)

    cache.stop()
    vi.useRealTimers()
  })
})
