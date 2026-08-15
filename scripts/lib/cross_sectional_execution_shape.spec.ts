import { describe, expect, it } from 'vitest'
import {
  applyCrossSectionalExecutionShape,
  parseCrossSectionalExecutionMode,
  resolveCrossSectionalExecutionShape,
} from './cross_sectional_execution_shape.js'

describe('cross_sectional_execution_shape', () => {
  it('resolves the paper shape used by paper_trade_cross_sectional', () => {
    expect(resolveCrossSectionalExecutionShape(34)).toEqual({
      executionMode: 'paper',
      topN: 1,
      bottomN: 1,
      minUniverseSize: 17,
    })
    expect(resolveCrossSectionalExecutionShape(3)).toMatchObject({
      topN: 1,
      bottomN: 1,
      minUniverseSize: 2,
    })
  })

  it('keeps legacy thirds available only when explicitly selected', () => {
    expect(resolveCrossSectionalExecutionShape(34, { mode: 'legacy_thirds' })).toEqual({
      executionMode: 'legacy_thirds',
      topN: 11,
      bottomN: 11,
      minUniverseSize: 34,
    })
    expect(resolveCrossSectionalExecutionShape(34, {
      mode: 'legacy_thirds',
      minUniverseSizeOverride: 20,
    }).minUniverseSize).toBe(20)
  })

  it('parses execution mode aliases conservatively', () => {
    expect(parseCrossSectionalExecutionMode(undefined)).toBe('paper')
    expect(parseCrossSectionalExecutionMode('paper-top1-bottom1-half-universe')).toBe('paper')
    expect(parseCrossSectionalExecutionMode('thirds')).toBe('legacy_thirds')
    expect(() => parseCrossSectionalExecutionMode('unknown')).toThrow(/Unsupported/)
  })

  it('applies top, bottom, and universe values without changing other config fields', () => {
    expect(applyCrossSectionalExecutionShape({
      lookbackHours: 336,
      minSpreadPct: 3,
      topN: 7,
    }, 34)).toEqual({
      lookbackHours: 336,
      minSpreadPct: 3,
      topN: 1,
      bottomN: 1,
      minUniverseSize: 17,
    })
  })
})
