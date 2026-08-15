/**
 * Tests for feature_builder.ts.
 *
 * IMPORTANT: these tests would normally run via `vitest`, but due to native
 * module code-signing issues with the current Node.js runtime, they are
 * also runnable via the standalone runner at run_tests.ts (tsx-based).
 *
 * The test values account for PIT filtering: the feature builder's bar
 * selection depends on each row's decision timestamp, so expected values
 * are computed from the bar index that matches each row's timestamp.
 */

import { describe, expect, it } from 'vitest'
import {
  buildFeatureMatrix,
  mean,
  std,
} from './feature_builder.js'
import type { Bar } from './feature_builder.js'

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeOHLCV(
  count: number,
  startPrice = 100,
  step = 0.5,
  startTime = new Date('2024-01-01T00:00:00.000Z'),
): Bar[] {
  const bars: Bar[] = []
  for (let i = 0; i < count; i++) {
    const ts = new Date(startTime.getTime() + i * 3600_000)
    const close = startPrice + i * step
    bars.push({
      timestamp: ts.toISOString(),
      open: close - step,
      high: close + step * 0.1,
      low: close - step * 0.1,
      close,
      volume: 1000 + i * 10,
    })
  }
  return bars
}

function makeFunding(
  count: number,
  baseRate = 0.0001,
  startTime = new Date('2024-01-01T00:00:00.000Z'),
): Array<{ timestamp: string; rate: number }> {
  const points: Array<{ timestamp: string; rate: number }> = []
  for (let i = 0; i < count; i++) {
    const ts = new Date(startTime.getTime() + i * 3600_000)
    points.push({ timestamp: ts.toISOString(), rate: baseRate + (i % 100) * 0.000001 })
  }
  return points
}

function findBarIdx(bars: Bar[], timestamp: string): number {
  return bars.findIndex(b => b.timestamp === timestamp)
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('feature_builder — mean/std utilities', () => {
  it('computes mean of numbers', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3)
    expect(mean([10])).toBe(10)
    expect(mean([])).toBeNaN()
  })

  it('computes sample std', () => {
    const v = std([1, 2, 3, 4, 5])
    expect(v).toBeCloseTo(Math.sqrt(2.5), 10)
    expect(std([5])).toBeNaN()
    expect(std([])).toBeNaN()
  })
})

describe('feature_builder — ret_1h calculation', () => {
  it('computes ret_1h from sample OHLCV', () => {
    const bars = makeOHLCV(30, 100, 2)
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', bars)

    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv })
    expect(rows.length).toBeGreaterThan(0)

    const row = rows.find(r => r.symbol === 'BTCUSDT' && r.features.ret_1h !== null)
    expect(row).toBeDefined()
    expect(typeof row!.features.ret_1h).toBe('number')

    const barIdx = findBarIdx(bars, row!.timestamp)
    expect(barIdx).toBeGreaterThanOrEqual(1)

    // ret_1h = (current_bar.close - previous_bar.close) / previous_bar.close
    const expected = (bars[barIdx].close - bars[barIdx - 1].close) / bars[barIdx - 1].close
    expect(row!.features.ret_1h).toBeCloseTo(expected, 10)
  })
})

describe('feature_builder — realized_vol_24h', () => {
  it('computes realized vol from 24 hourly returns', () => {
    const bars = makeOHLCV(50, 100, 0.5)
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', bars)

    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv })
    const row = rows.find(r => r.features.realized_vol_24h !== null)
    expect(row).toBeDefined()
    expect(typeof row!.features.realized_vol_24h).toBe('number')

    const barIdx = findBarIdx(bars, row!.timestamp)
    expect(barIdx).toBeGreaterThanOrEqual(24)

    const rets: number[] = []
    for (let i = barIdx - 23; i <= barIdx; i++) {
      rets.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close)
    }
    const expectedVol = std(rets)
    expect(row!.features.realized_vol_24h).toBeCloseTo(expectedVol, 8)
  })
})

describe('feature_builder — volume_z_24h', () => {
  it('computes volume z-score from last 24 volumes', () => {
    const bars = makeOHLCV(50, 100, 0.5)
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', bars)

    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv })
    const row = rows.find(r => r.features.volume_z_24h !== null)
    expect(row).toBeDefined()
    expect(typeof row!.features.volume_z_24h).toBe('number')

    const barIdx = findBarIdx(bars, row!.timestamp)
    expect(barIdx).toBeGreaterThanOrEqual(23)

    const vol24: number[] = []
    for (let i = barIdx - 23; i <= barIdx; i++) {
      vol24.push(bars[i].volume)
    }
    const m = mean(vol24)
    const s = std(vol24)
    const expectedZ = s > 0 ? (bars[barIdx].volume - m) / s : null
    if (expectedZ !== null) {
      expect(row!.features.volume_z_24h).toBeCloseTo(expectedZ, 8)
    }
  })
})

describe('feature_builder — funding_z_30d', () => {
  it('computes funding z-score from 720 hourly samples', () => {
    const bars = makeOHLCV(750, 100, 0.1)
    const fundingData = makeFunding(750, 0.0001)

    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', bars)

    const funding = new Map<string, Array<{ timestamp: string; rate: number }>>()
    funding.set('BTCUSDT', fundingData)

    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv, funding })
    const row = rows.find(r => r.features.funding_z_30d !== null)
    expect(row).toBeDefined()
    expect(typeof row!.features.funding_z_30d).toBe('number')

    const barIdx = findBarIdx(bars, row!.timestamp)
    expect(barIdx).toBeGreaterThanOrEqual(719)

    // funding_z_30d: last 720 funding points with timestamps <= cutoff
    const windowStart = Math.max(0, barIdx - 719)
    const window = fundingData.slice(windowStart, barIdx + 1)
    const rates = window.map(p => p.rate)
    const m = mean(rates)
    const s = std(rates)
    if (s > 0) {
      const expectedZ = (fundingData[barIdx].rate - m) / s
      expect(row!.features.funding_z_30d).toBeCloseTo(expectedZ, 8)
    }
  })
})

describe('feature_builder — PIT contract enforcement', () => {
  it('excludes data after decision time via cutoff', () => {
    const bars = makeOHLCV(50, 100, 1)
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', bars)

    // Decision at bars[0].timestamp → only 1 bar → freshness too low → no rows
    const rowsEarly = buildFeatureMatrix('live', ['BTCUSDT'], { ohlcv }, {
      decisionTime: bars[0].timestamp,
      forcedDelayMs: 0,
    })
    expect(rowsEarly).toHaveLength(0)

    // Decision at bars[30].timestamp → 31 bars → plenty
    const rowsEnough = buildFeatureMatrix('live', ['BTCUSDT'], { ohlcv }, {
      decisionTime: bars[30].timestamp,
      forcedDelayMs: 0,
    })
    expect(rowsEnough).toHaveLength(1)
    expect(rowsEnough[0].features.ret_1h).toBeCloseTo(
      (bars[30].close - bars[29].close) / bars[29].close, 10,
    )

    // With forced delay that excludes the most recent bar
    const dt30 = new Date(new Date(bars[30].timestamp).getTime() + 100).toISOString()
    const rowsDelayed = buildFeatureMatrix('live', ['BTCUSDT'], { ohlcv }, {
      decisionTime: dt30,
      forcedDelayMs: 3_600_100, // 1h + 100ms — excludes bars[30]
    })
    expect(rowsDelayed).toHaveLength(1)
    expect(rowsDelayed[0].features.ret_1h).toBeCloseTo(
      (bars[29].close - bars[28].close) / bars[28].close, 10,
    )
  })
})

describe('feature_builder — feature_freshness tracking', () => {
  it('tracks freshness and excludes rows below 0.8', () => {
    const ohlcv = new Map<string, Bar[]>()

    const sparse = makeOHLCV(1, 100, 1)
    ohlcv.set('SPARSE', sparse)

    const full = makeOHLCV(50, 100, 1)
    ohlcv.set('FULL', full)

    const rows = buildFeatureMatrix('historical', ['SPARSE', 'FULL'], { ohlcv })

    const sparseRows = rows.filter(r => r.symbol === 'SPARSE')
    expect(sparseRows).toHaveLength(0)

    const fullRows = rows.filter(r => r.symbol === 'FULL')
    expect(fullRows.length).toBeGreaterThan(25)
    for (const row of fullRows) {
      expect(row.metadata.feature_freshness).toBeGreaterThanOrEqual(0.8)
    }
  })
})

describe('feature_builder — cross-sectional features', () => {
  it('computes btc_ret_24h for non-BTC symbols', () => {
    const btcBars = makeOHLCV(50, 100, 1)
    const ethBars = makeOHLCV(50, 50, 0.5)

    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', btcBars)
    ohlcv.set('ETHUSDT', ethBars)

    const rows = buildFeatureMatrix('historical', ['BTCUSDT', 'ETHUSDT'], { ohlcv })

    const btcRow = rows.find(r => r.symbol === 'BTCUSDT')
    expect(btcRow).toBeDefined()
    expect(btcRow!.features.btc_ret_24h).toBeNull()

    const ethRow = rows.find(r => r.symbol === 'ETHUSDT' && r.features.btc_ret_24h !== null)
    expect(ethRow).toBeDefined()

    const ethBarIdx = findBarIdx(ethBars, ethRow!.timestamp)
    expect(ethBarIdx).toBeGreaterThanOrEqual(24)

    const btcRet24 = (btcBars[ethBarIdx].close - btcBars[ethBarIdx - 24].close) / btcBars[ethBarIdx - 24].close
    expect(ethRow!.features.btc_ret_24h).toBeCloseTo(btcRet24, 8)
  })

  it('computes market_dispersion across symbols', () => {
    const ohlcv = new Map<string, Bar[]>()
    const nBars = 50
    for (const sym of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT']) {
      ohlcv.set(sym, makeOHLCV(nBars, 100 + Math.random() * 200, 0.2 + Math.random() * 0.8))
    }

    const rows = buildFeatureMatrix('historical', Array.from(ohlcv.keys()), { ohlcv })

    const rowWith = rows.find(r => r.features.market_dispersion !== null)
    expect(rowWith).toBeDefined()

    if (rowWith) {
      expect(rowWith.features.market_dispersion).toBeGreaterThan(0)
      expect(typeof rowWith.features.market_dispersion).toBe('number')
    }
  })
})

describe('feature_builder — live mode', () => {
  it('generates a single row per symbol at a specific decision time', () => {
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', makeOHLCV(50, 100, 1))
    ohlcv.set('ETHUSDT', makeOHLCV(50, 50, 0.5))

    const lastTs = ohlcv.get('BTCUSDT')![49].timestamp
    const dt = new Date(new Date(lastTs).getTime() + 3600_000).toISOString()

    const rows = buildFeatureMatrix('live', ['BTCUSDT', 'ETHUSDT'], { ohlcv }, {
      decisionTime: dt,
      forcedDelayMs: 0,
    })

    expect(rows).toHaveLength(2)
    expect(rows.every(r => r.timestamp === dt)).toBe(true)

    for (const row of rows) {
      expect(row.metadata.decision_time).toBe(dt)
      expect(typeof row.features.ret_1h).toBe('number')
      expect(typeof row.features.ret_4h).toBe('number')
      expect(typeof row.features.ret_24h).toBe('number')
    }
  })

  it('defaults forcedDelayMs to 500ms in live mode', () => {
    const ohlcv = new Map<string, Bar[]>()
    const bars = makeOHLCV(50, 100, 1)
    ohlcv.set('BTCUSDT', bars)

    const lastBarTs = bars[49].timestamp
    const dt = new Date(new Date(lastBarTs).getTime() + 100).toISOString()

    const rows = buildFeatureMatrix('live', ['BTCUSDT'], { ohlcv }, {
      decisionTime: dt,
    })

    expect(rows).toHaveLength(1)
    expect(rows[0].features.ret_1h).toBeCloseTo(
      (bars[48].close - bars[47].close) / bars[47].close, 8,
    )
  })
})

describe('feature_builder — edge cases', () => {
  it('handles empty ohlcv map', () => {
    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv: new Map() })
    expect(rows).toEqual([])
  })

  it('handles symbol with no matching OHLCV data', () => {
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', makeOHLCV(30, 100, 1))

    const rows = buildFeatureMatrix('historical', ['NONEXISTENT'], { ohlcv })
    expect(rows).toEqual([])
  })

  it('returns null for missing funding/OI data', () => {
    const ohlcv = new Map<string, Bar[]>()
    ohlcv.set('BTCUSDT', makeOHLCV(50, 100, 1))

    const rows = buildFeatureMatrix('historical', ['BTCUSDT'], { ohlcv })
    expect(rows.length).toBeGreaterThan(0)
    const row = rows[0]

    expect(row.features.funding_rate).toBeNull()
    expect(row.features.funding_z_30d).toBeNull()
    expect(row.features.oi_change_24h).toBeNull()
    expect(row.features.basis_bps).toBeNull()
  })
})
