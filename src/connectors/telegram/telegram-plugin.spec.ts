import { describe, expect, it } from 'vitest'
import { pruneThrottleEntries } from './telegram-plugin.js'

describe('pruneThrottleEntries', () => {
  it('removes entries older than the configured ttl', () => {
    const throttle = new Map<number, number>([
      [1, 1_000],
      [2, 3_599_000],
      [3, 3_600_001],
    ])

    const removed = pruneThrottleEntries(throttle, 7_200_000, 3_600_000)

    expect(removed).toBe(2)
    expect([...throttle.keys()]).toEqual([3])
  })
})
