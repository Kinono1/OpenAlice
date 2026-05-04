import { describe, expect, it } from 'vitest'
import { selectUniverseByRollingSharpe } from './universe-selection.js'

describe('rolling Sharpe universe selection', () => {
  it('selects long and short universes with asymmetric Sharpe thresholds', () => {
    const selection = selectUniverseByRollingSharpe(
      [
        { symbol: 'BTC', returns: Array.from({ length: 60 }, () => 0.01).map((value, index) => value + (index % 2) * 0.001) },
        { symbol: 'ALT', returns: Array.from({ length: 60 }, () => -0.012).map((value, index) => value - (index % 2) * 0.001) },
        { symbol: 'NOISE', returns: Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? 0.01 : -0.01)) },
      ],
      {
        lookback: 60,
        minObservations: 30,
        annualizationFactor: 365,
        minLongSharpe: 1.3,
        minShortSharpe: 1.7,
      },
    )

    expect(selection.longSymbols).toContain('BTC')
    expect(selection.shortSymbols).toContain('ALT')
    expect(selection.longSymbols).not.toContain('NOISE')
    expect(selection.shortSymbols).not.toContain('NOISE')
  })

  it('marks under-sampled assets ineligible instead of extrapolating Sharpe', () => {
    const selection = selectUniverseByRollingSharpe(
      [{ symbol: 'NEW', returns: [0.01, 0.02, 0.03] }],
      { lookback: 60, minObservations: 10 },
    )

    expect(selection.longSymbols).toEqual([])
    expect(selection.shortSymbols).toEqual([])
    expect(selection.scores[0]?.rollingSharpe).toBeNull()
    expect(selection.scores[0]?.reason).toContain('insufficient observations')
  })
})
