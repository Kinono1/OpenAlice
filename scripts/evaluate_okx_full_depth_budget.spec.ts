import { describe, expect, it } from 'vitest'
import { decideFullDepthBudget } from './evaluate_okx_full_depth_budget.js'

describe('full depth storage budget', () => {
  it('requires a real six-hour canary', () => {
    expect(decideFullDepthBudget({ observedHours: 5.99, projectedContinuous8DayGiB: 10, projectedWindowed8DayGiB: 2 })).toMatchObject({
      status: 'blocked_insufficient_canary_duration', recommendedMode: 'canary_btc',
    })
  })

  it('allows continuous capture only below the 18 GiB threshold', () => {
    expect(decideFullDepthBudget({ observedHours: 6, projectedContinuous8DayGiB: 17.99, projectedWindowed8DayGiB: 3 })).toEqual({
      status: 'continuous_allowed', recommendedMode: 'continuous', blockers: [],
    })
  })

  it('falls back to bounded windows and then disables without changing the budget', () => {
    expect(decideFullDepthBudget({ observedHours: 6, projectedContinuous8DayGiB: 30, projectedWindowed8DayGiB: 5 })).toMatchObject({ status: 'bounded_capture_window', recommendedMode: 'bounded_capture_window' })
    expect(decideFullDepthBudget({ observedHours: 6, projectedContinuous8DayGiB: 200, projectedWindowed8DayGiB: 33 })).toMatchObject({ status: 'blocked_storage_budget', recommendedMode: 'disabled' })
  })
})
