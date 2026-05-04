import { describe, expect, it } from 'vitest'
import { buildMicroSweepCandidates, parseArgs } from './run_eth_carry_short_bias_micro_sweep.ts'

describe('run_eth_carry_short_bias_micro_sweep', () => {
  it('defaults CLI execution to dry-run research inspection', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
    expect(args.selfCheck).toBe(false)
  })

  it('requires explicit opt-in before writing research micro-sweep artifacts', () => {
    const args = parseArgs(['--dryRun', 'false'])

    expect(args.dryRun).toBe(false)
  })

  it('builds a compact long-entry micro-sweep family around the short-bias champion', () => {
    const candidates = buildMicroSweepCandidates()
    expect(candidates.length).toBe(3 * 2 * 3 * 2)
    expect(candidates[0]?.shortEntry).toEqual({
      minAbsFundingSpread: 0.0001,
      minAbsFundingZScore: 1.2,
    })
    expect(candidates.some((candidate) => candidate.longEntry?.minAbsFundingSpread === 0.00012)).toBe(true)
    expect(candidates.some((candidate) => candidate.signalPersistenceBars === 12)).toBe(true)
    expect(candidates.some((candidate) => candidate.maxHoldingBars === 36)).toBe(true)
  })
})
