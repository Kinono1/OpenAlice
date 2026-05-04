import { describe, expect, it } from 'vitest'
import { parseArgs } from './refresh_market_intel_context.ts'

describe('refresh_market_intel_context CLI safety', () => {
  it('defaults to dry-run without context writes or LLM calls', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
  })

  it('requires explicit opt-in before refreshing the effective market intel context', () => {
    const args = parseArgs(['--dryRun', 'false'])

    expect(args.dryRun).toBe(false)
  })
})
