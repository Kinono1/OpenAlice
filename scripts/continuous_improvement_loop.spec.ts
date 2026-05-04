import { describe, expect, it } from 'vitest'
import { parseArgs } from './continuous_improvement_loop.ts'

describe('continuous_improvement_loop CLI safety', () => {
  it('defaults to dry-run before writing optimizer, policy, audit, or runtime shadow artifacts', () => {
    const args = parseArgs([])

    expect(args).toMatchObject({
      dryRun: true,
      wfoShadow: false,
      wfoActive: false,
      fastMode: false,
      costShadow: false,
    })
  })

  it('requires explicit opt-in before running the artifact-producing improvement loop', () => {
    expect(parseArgs(['--dryRun', 'false']).dryRun).toBe(false)
    expect(parseArgs(['--dryRun=false']).dryRun).toBe(false)
  })

  it('parses optional shadow and fast-mode flags without disabling dry-run', () => {
    const args = parseArgs(['--wfo-shadow', '--cost-shadow=true', '--fast'])

    expect(args).toMatchObject({
      dryRun: true,
      wfoShadow: true,
      costShadow: true,
      fastMode: true,
      wfoActive: false,
    })
  })
})
