import { describe, expect, it } from 'vitest'
import { evaluateDataQuality } from './data-quality-gate.js'

function bar(timestamp: number, close: number, volume = 100) {
  return {
    timestamp,
    open: close,
    high: close,
    low: close,
    close,
    volume,
  }
}

describe('evaluateDataQuality', () => {
  it('blocks empty datasets fail-closed', () => {
    expect(evaluateDataQuality('BTCUSDT', [])).toMatchObject({
      symbol: 'BTCUSDT',
      missing_bar_rate: 1,
      stale_price_detected: true,
      verdict: 'BLOCK',
    })
  })

  it('warns on duplicate timestamps and zero-volume degradation without blocking clean gaps', () => {
    const result = evaluateDataQuality(
      'ETHUSDT',
      [
        bar(0, 100, 0),
        bar(60_000, 101, 0),
        bar(60_000, 102, 100),
        bar(120_000, 103, 100),
      ],
      { maxZeroVolumeRate: 0.25 },
    )

    expect(result.duplicate_bar_count).toBe(1)
    expect(result.zero_volume_rate).toBe(0.5)
    expect(result.verdict).toBe('WARN')
  })

  it('blocks excessive missing bar gaps', () => {
    const result = evaluateDataQuality(
      'SOLUSDT',
      [
        bar(0, 100),
        bar(60_000, 101),
        bar(600_000, 102),
        bar(660_000, 103),
      ],
      { maxMissingBarRateBlock: 0.1 },
    )

    expect(result.missing_bar_rate).toBeGreaterThan(0.1)
    expect(result.verdict).toBe('BLOCK')
  })

  it('marks stale repeated closes as stale when not otherwise blocked', () => {
    const result = evaluateDataQuality(
      'DOGEUSDT',
      [
        bar(0, 1),
        bar(60_000, 1),
        bar(120_000, 1),
        bar(180_000, 1),
      ],
      { staleBarCount: 2 },
    )

    expect(result.stale_price_detected).toBe(true)
    expect(result.verdict).toBe('STALE')
  })
})
