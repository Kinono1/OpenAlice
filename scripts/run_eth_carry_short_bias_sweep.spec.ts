import { describe, expect, it } from 'vitest'
import {
  buildShortBiasVariants,
  filterAsymmetricCarrySignals,
  parseArgs,
  toSweepCandidate,
} from './run_eth_carry_short_bias_sweep.ts'

describe('run_eth_carry_short_bias_sweep helpers', () => {
  it('defaults CLI execution to dry-run research inspection', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
    expect(args.selfCheck).toBe(false)
  })

  it('requires explicit opt-in before writing research sweep artifacts', () => {
    const args = parseArgs(['--dryRun', 'false'])

    expect(args.dryRun).toBe(false)
  })

  it('filters short and long signals with asymmetric thresholds', () => {
    const filtered = filterAsymmetricCarrySignals(
      [
        { time: 1, fundingSpread: 0.00011, fundingSpreadZScore: 1.35 },
        { time: 2, fundingSpread: 0.00009, fundingSpreadZScore: 1.5 },
        { time: 3, fundingSpread: -0.00015, fundingSpreadZScore: -1.4 },
        { time: 4, fundingSpread: -0.00011, fundingSpreadZScore: -1.2 },
      ],
      {
        shortSpread: 0.0001,
        shortZ: 1.3,
        longSpread: 0.00014,
        longZ: 1.3,
      },
    )

    expect(filtered.map((item) => item.time)).toEqual([1, 3])
  })

  it('builds a dense asymmetric search grid and 24h sweep candidates', () => {
    const variants = buildShortBiasVariants()
    expect(variants.length).toBe(3 * 4 * 5 * 5)

    const candidate = toSweepCandidate({
      shortSpread: 0.0001,
      shortZ: 1.3,
      longSpread: 0.00016,
      longZ: 1.9,
    })
    expect(candidate.maxHoldingBars).toBe(24)
    expect(candidate.signalPersistenceBars).toBe(8)
    expect(candidate.id).toContain('ss0.0001')
  })
})
