import { describe, it, expect } from 'vitest'
import { FactorIcMonitor } from './ic-monitor.js'
import type { FactorIcMonitorConfig } from './ic-monitor.js'

const enabledConfig: FactorIcMonitorConfig = {
  enabled: true,
  mode: 'shadow',
  icHorizons: [1, 24, 48],
  lookbackWindows: [24, 48, 168],
  minSamples: 5,
  minSampleCount: 5,
  warmupWindows: 1,
  decayThresholds: {
    meanIcFloor: 0.03,
    icIrFloor: 0.5,
    signStabilityFloor: 0.6,
  },
  autoDisable: false,
}

const HOUR_MS = 60 * 60 * 1000

describe('FactorIcMonitor', () => {
  describe('computeRollingIc uses future returns', () => {
    it('matches signal_t with return_{t+h}, not return_t', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = Date.now() - 12 * HOUR_MS

      for (let i = 0; i < 10; i++) {
        const signalTime = baseTime + i * HOUR_MS
        const futureReturnTime = signalTime + 1 * HOUR_MS
        monitor.recordSignal('test-factor', i * 0.1, signalTime)
        monitor.recordReturn(futureReturnTime, i * 0.05)
      }

      const ic = monitor.computeRollingIc('test-factor', 24, 1)
      expect(ic).not.toBeNaN()
      expect(ic).toBeGreaterThan(0.5)
    })

    it('does NOT match same-period returns when no future returns exist', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = Date.now() - 12 * HOUR_MS

      for (let i = 0; i < 10; i++) {
        const signalTime = baseTime + i * HOUR_MS
        monitor.recordSignal('test-factor', i * 0.1, signalTime)
      }
      monitor.recordReturn(baseTime - 100 * HOUR_MS, 0.5)

      const ic = monitor.computeRollingIc('test-factor', 24, 1)
      expect(ic).toBeNaN()
    })

    it('returns NaN when insufficient samples', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = Date.now() - 5 * HOUR_MS

      for (let i = 0; i < 3; i++) {
        monitor.recordSignal('test-factor', i * 0.1, baseTime + i * HOUR_MS)
        monitor.recordReturn(baseTime + (i + 1) * HOUR_MS, i * 0.05)
      }

      const ic = monitor.computeRollingIc('test-factor', 24, 1)
      expect(ic).toBeNaN()
    })
  })

  describe('computeRollingIc with asOfMs', () => {
    it('uses explicit asOfMs when provided instead of Date.now()', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = 1_700_000_000_000

      for (let i = 0; i < 10; i++) {
        const signalTime = baseTime + i * HOUR_MS
        const futureReturnTime = signalTime + 1 * HOUR_MS
        monitor.recordSignal('test-factor', i * 0.1, signalTime)
        monitor.recordReturn(futureReturnTime, i * 0.05)
      }

      const asOfMs = baseTime + 15 * HOUR_MS
      const ic = monitor.computeRollingIc('test-factor', 24, 1, asOfMs)
      expect(ic).not.toBeNaN()
      expect(ic).toBeGreaterThan(0.5)
    })

    it('filters signals after asOfMs', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = 1_700_000_000_000

      for (let i = 0; i < 20; i++) {
        const signalTime = baseTime + i * HOUR_MS
        monitor.recordSignal('test-factor', i * 0.1, signalTime)
        monitor.recordReturn(signalTime + HOUR_MS, i * 0.05)
      }

      const asOfMs = baseTime + 10 * HOUR_MS
      const ic = monitor.computeRollingIc('test-factor', 24, 1, asOfMs)
      expect(ic).not.toBeNaN()
    })
  })

  describe('detectDecay matches horizon to lookback', () => {
    it('uses corresponding lookback for each icHorizon', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = 1_700_000_000_000

      for (let i = 0; i < 200; i++) {
        const signalTime = baseTime + i * HOUR_MS
        monitor.recordSignal('test-factor', Math.sin(i * 0.1), signalTime)
        monitor.recordReturn(signalTime + HOUR_MS, Math.sin(i * 0.1) * 0.5)
      }

      const asOfMs = baseTime + 200 * HOUR_MS
      const metrics = monitor.detectDecay('test-factor', asOfMs)
      expect(metrics.sampleCount).toBeGreaterThanOrEqual(200)
    })
  })

  describe('exportSnapshot / importSnapshot', () => {
    it('round-trips state correctly', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = Date.now() - 12 * HOUR_MS

      for (let i = 0; i < 10; i++) {
        monitor.recordSignal('factor-a', i * 0.1, baseTime + i * HOUR_MS)
        monitor.recordReturn(baseTime + (i + 1) * HOUR_MS, i * 0.05)
      }

      const snapshot = monitor.exportSnapshot()
      expect(snapshot.signals).toHaveLength(10)
      expect(snapshot.returns).toHaveLength(10)
      expect(snapshot.version).toBe(1)

      const monitor2 = new FactorIcMonitor(enabledConfig)
      monitor2.importSnapshot(snapshot)

      const ic1 = monitor.computeRollingIc('factor-a', 24, 1)
      const ic2 = monitor2.computeRollingIc('factor-a', 24, 1)
      expect(ic2).toBe(ic1)
    })

    it('imports legacy snapshots without symbol fields as legacy scope', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = 1_700_000_000_000

      monitor.importSnapshot({
        version: 1,
        signals: Array.from({ length: 10 }, (_, i) => ({
          factor: 'legacy-factor',
          value: i,
          timestamp: baseTime + i * HOUR_MS,
        })),
        returns: Array.from({ length: 10 }, (_, i) => ({
          value: i * 0.01,
          timestamp: baseTime + (i + 1) * HOUR_MS,
        })),
      })

      const ic = monitor.computeRollingIc('legacy-factor', 24, 1, baseTime + 12 * HOUR_MS)
      expect(ic).not.toBeNaN()
      expect(ic).toBeGreaterThan(0.5)
      expect(monitor.exportSnapshot().signals[0]?.symbol).toBe('__legacy__')
    })
  })

  describe('symbol-aware records', () => {
    it('keeps same-timestamp signals and returns isolated by symbol', () => {
      const monitor = new FactorIcMonitor(enabledConfig)
      const baseTime = 1_700_000_000_000

      for (let i = 0; i < 10; i++) {
        const signalTime = baseTime + i * HOUR_MS
        monitor.recordSignal('momentum', i, signalTime, 'BTC-USDT')
        monitor.recordReturn(signalTime + HOUR_MS, i * 0.01, 'BTC-USDT')
        monitor.recordSignal('momentum', 10 - i, signalTime, 'ETH-USDT')
        monitor.recordReturn(signalTime + HOUR_MS, i * 0.01, 'ETH-USDT')
      }

      const snapshot = monitor.exportSnapshot()
      expect(snapshot.signals).toHaveLength(20)
      expect(snapshot.returns).toHaveLength(20)
      expect(snapshot.signals.filter(record => record.symbol === 'BTC-USDT')).toHaveLength(10)
      expect(snapshot.signals.filter(record => record.symbol === 'ETH-USDT')).toHaveLength(10)

      const asOfMs = baseTime + 12 * HOUR_MS
      const btcIc = monitor.computeRollingIc('momentum', 24, 1, asOfMs, 'BTC-USDT')
      const ethIc = monitor.computeRollingIc('momentum', 24, 1, asOfMs, 'ETH-USDT')
      expect(btcIc).toBeGreaterThan(0.5)
      expect(ethIc).toBeLessThan(-0.5)

      const btcMetrics = monitor.detectDecay('momentum', asOfMs, 'BTC-USDT')
      expect(btcMetrics.symbol).toBe('BTC-USDT')
      expect(btcMetrics.sampleCount).toBe(10)
    })
  })

  describe('detectDecay', () => {
    it('marks factor as decayed when IC is below floor', () => {
      const monitor = new FactorIcMonitor({
        ...enabledConfig,
        icHorizons: [1],
      })
      const baseTime = Date.now() - 12 * HOUR_MS

      for (let i = 0; i < 10; i++) {
        monitor.recordSignal('noise', Math.random() - 0.5, baseTime + i * HOUR_MS)
        monitor.recordReturn(baseTime + (i + 1) * HOUR_MS, Math.random() - 0.5)
      }

      const metrics = monitor.detectDecay('noise')
      expect(metrics.factorName).toBe('noise')
      expect(metrics.decayStatus).toBe('decayed')
    })
  })

  describe('getConditioning with autoDisable', () => {
    it('sets multiplier to 0 for decayed factors when autoDisable is true', () => {
      const monitor = new FactorIcMonitor({
        ...enabledConfig,
        autoDisable: true,
      })
      const baseTime = Date.now() - 12 * HOUR_MS

      for (let i = 0; i < 10; i++) {
        monitor.recordSignal('noise', Math.random() - 0.5, baseTime + i * HOUR_MS)
        monitor.recordReturn(baseTime + (i + 1) * HOUR_MS, Math.random() - 0.5)
      }

      const conditioning = monitor.getConditioning()
      expect(conditioning.multipliers['noise']).toBe(0)
      expect(conditioning.decayedByFactor['noise']).toBe(true)
    })
  })
})
