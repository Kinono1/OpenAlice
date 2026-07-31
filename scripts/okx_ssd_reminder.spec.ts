import { describe, expect, it } from 'vitest'
import { deriveConnectedThisWeek } from './okx_ssd_reminder.js'

describe('okx_ssd_reminder', () => {
  it('does not suppress followups for an unverified same-name volume', () => {
    expect(deriveConnectedThisWeek(false, { connected: true, identityVerified: false })).toBe(false)
  })

  it('remembers a verified enrolled volume for the rest of the week', () => {
    expect(deriveConnectedThisWeek(false, { connected: true, identityVerified: true })).toBe(true)
    expect(deriveConnectedThisWeek(true, { connected: false, identityVerified: false })).toBe(true)
  })
})
