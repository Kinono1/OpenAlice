import { describe, expect, it } from 'vitest'
import { PAIR_SHADOW_CANDIDATES, parseArgs } from './run_eth_carry_short_bias_pair_shadow_validation.ts'

describe('run_eth_carry_short_bias_pair_shadow_validation', () => {
  it('defaults CLI execution to dry-run shadow inspection', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
    expect(args.selfCheck).toBe(false)
  })

  it('requires explicit opt-in before writing pair shadow artifacts', () => {
    const args = parseArgs(['--dryRun', 'false'])

    expect(args.dryRun).toBe(false)
  })

  it('defines the intended two-candidate shadow family', () => {
    expect(PAIR_SHADOW_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      'carry_short_bias_soft',
      'carry_short_bias_fast_confirm',
    ])
    expect(PAIR_SHADOW_CANDIDATES[1]?.signalPersistenceBars).toBe(4)
    expect(PAIR_SHADOW_CANDIDATES[1]?.longEntry).toEqual({
      minAbsFundingSpread: 0.00016,
      minAbsFundingZScore: 1.2,
    })
  })
})
