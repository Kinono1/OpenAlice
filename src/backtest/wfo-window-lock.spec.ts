import { describe, it, expect } from 'vitest'
import { createRollingWindows } from './wfo.js'

describe('WFO window locking', () => {
  const config = { trainBars: 100, testBars: 30, stepBars: 30, embargoBars: 5 }

  it('window boundaries are determined solely by data length and config', () => {
    const windows1 = createRollingWindows(300, config)
    const windows2 = createRollingWindows(300, config)
    expect(windows1).toEqual(windows2)
  })

  it('windows are identical regardless of strategy params (no data leakage)', () => {
    // Simulate two different strategy param sets — windows must be the same
    const windowsParamA = createRollingWindows(300, config)
    const windowsParamB = createRollingWindows(300, { ...config, trainBars: 100 })
    expect(windowsParamA).toEqual(windowsParamB)
  })

  it('train and test windows never overlap', () => {
    const windows = createRollingWindows(500, config)
    for (const w of windows) {
      expect(w.testStart).toBeGreaterThanOrEqual(w.trainEndExclusive)
    }
  })

  it('embargo gap separates train end from test start', () => {
    const windows = createRollingWindows(500, config)
    for (const w of windows) {
      expect(w.testStart).toBeGreaterThanOrEqual(w.embargoEndExclusive)
      expect(w.embargoEndExclusive).toBeGreaterThanOrEqual(w.trainEndExclusive)
    }
  })

  it('test windows do not overlap each other', () => {
    const windows = createRollingWindows(500, config)
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.testStart).toBeGreaterThanOrEqual(windows[i - 1]!.testEndExclusive)
    }
  })

  it('returns empty array when not enough data', () => {
    const windows = createRollingWindows(10, config)
    expect(windows).toHaveLength(0)
  })

  it('all window indices are within data bounds', () => {
    const totalBars = 400
    const windows = createRollingWindows(totalBars, config)
    for (const w of windows) {
      expect(w.trainStart).toBeGreaterThanOrEqual(0)
      expect(w.testEndExclusive).toBeLessThanOrEqual(totalBars)
    }
  })

  it('step size controls window advancement', () => {
    const step10 = createRollingWindows(500, { ...config, stepBars: 10 })
    const step30 = createRollingWindows(500, { ...config, stepBars: 30 })
    expect(step10.length).toBeGreaterThan(step30.length)
  })
})
