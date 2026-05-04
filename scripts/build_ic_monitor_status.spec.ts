import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FactorIcMonitorConfig, IcMonitorSnapshot } from '../src/domain/strategy/factors/index.js'
import {
  buildIcMonitorStatusReport,
  parseIcMonitorStatusArgs,
  runIcMonitorStatus,
} from './build_ic_monitor_status.js'

const HOUR_MS = 60 * 60 * 1000

const testConfig: FactorIcMonitorConfig = {
  enabled: true,
  mode: 'shadow',
  icHorizons: [1, 2],
  lookbackWindows: [48, 48],
  minSamples: 5,
  minSampleCount: 8,
  warmupWindows: 4,
  decayThresholds: {
    meanIcFloor: 0.03,
    icIrFloor: 0.1,
    signStabilityFloor: 0.6,
  },
  autoDisable: false,
}

describe('build_ic_monitor_status', () => {
  it('parses runtime defaults', () => {
    expect(parseIcMonitorStatusArgs([])).toEqual({
      snapshotPath: 'data/runtime/ic_monitor_snapshot.latest.json',
      outputPath: 'data/runtime/ic_monitor_status.latest.json',
      asOfMs: null,
      json: false,
    })
    expect(parseIcMonitorStatusArgs([
      '--snapshotPath',
      'tmp/snapshot.json',
      '--outputPath',
      'null',
      '--asOfMs',
      '1700000000000',
      '--json',
      'true',
    ])).toEqual({
      snapshotPath: 'tmp/snapshot.json',
      outputPath: null,
      asOfMs: 1700000000000,
      json: true,
    })
  })

  it('marks missing snapshots as not promotion eligible', () => {
    const report = buildIcMonitorStatusReport({
      snapshot: null,
      snapshotPresent: false,
      snapshotPath: '/repo/data/runtime/ic_monitor_snapshot.latest.json',
      config: testConfig,
      generatedAt: '2026-05-03T00:00:00.000Z',
    })

    expect(report).toMatchObject({
      status: 'missing_snapshot',
      promotionEligible: false,
      usableForPaperExecution: false,
      sampleCountTotal: 0,
      returnCount: 0,
      symbolCount: 0,
      symbols: [],
      factorCount: 0,
      blockingReasons: expect.arrayContaining([
        'ic_monitor_snapshot_missing',
        'ic_factor_signals_missing',
        'ic_realized_returns_missing',
        'ic_sample_count_below_minimum:0<8',
        'ic_warmup_windows_below_minimum:0<4',
      ]),
      governance: {
        promotionAllowedByThisArtifact: false,
        liveTradingAllowedByThisArtifact: false,
        paperExecutionAllowedByThisArtifact: false,
      },
    })
  })

  it('marks low-sample snapshots as warmup', () => {
    const snapshot = makeSnapshot({ count: 3 })
    const report = buildIcMonitorStatusReport({
      snapshot,
      snapshotPresent: true,
      snapshotPath: '/repo/data/runtime/ic_monitor_snapshot.latest.json',
      config: {
        ...testConfig,
        decayThresholds: {
          ...testConfig.decayThresholds,
          meanIcFloor: 1.1,
        },
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
      asOfMs: 1_700_000_000_000 + 10 * HOUR_MS,
    })

    expect(report.status).toBe('warmup')
    expect(report.promotionEligible).toBe(false)
    expect(report.blockingReasons).toEqual(expect.arrayContaining([
      'ic_sample_count_below_minimum:3<8',
      'ic_warmup_windows_below_minimum:3<4',
      'factor:momentum:sample_count_below_minimum:3<8',
    ]))
  })

  it('marks sufficient healthy snapshots as ready', () => {
    const snapshot = makeMultiHorizonSnapshot({ count: 20 })
    const readyConfig: FactorIcMonitorConfig = {
      ...testConfig,
      icHorizons: [1, 2],
      lookbackWindows: [48, 48],
      decayThresholds: {
        ...testConfig.decayThresholds,
        icIrFloor: 0.1,
      },
    }
    const report = buildIcMonitorStatusReport({
      snapshot,
      snapshotPresent: true,
      snapshotPath: '/repo/data/runtime/ic_monitor_snapshot.latest.json',
      config: readyConfig,
      generatedAt: '2026-05-03T00:00:00.000Z',
      asOfMs: 1_700_000_000_000 + 70 * HOUR_MS,
    })

    expect(report.status).toBe('ready')
    expect(report.promotionEligible).toBe(true)
    expect(report.usableForPaperExecution).toBe(true)
    expect(report.factorCount).toBe(1)
    expect(report.symbols).toEqual(['__legacy__'])
    expect(report.factors[0]).toMatchObject({
      factorName: 'momentum',
      promotionStatus: 'ready',
      blockedReasons: [],
    })
  })

  it('writes status artifact and manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ic-monitor-status-'))
    const snapshotPath = join(root, 'ic_monitor_snapshot.latest.json')
    const outputPath = join(root, 'ic_monitor_status.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(snapshotPath, `${JSON.stringify(makeSnapshot({ count: 3 }), null, 2)}\n`, 'utf-8')

    const report = await runIcMonitorStatus({
      snapshotPath,
      outputPath,
      asOfMs: 1_700_000_000_000 + 10 * HOUR_MS,
      json: true,
    })

    expect(report.status).toBe('warmup')
    const persisted = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(persisted.status).toBe('warmup')
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'ic_monitor_status',
      exitCode: 0,
      businessStatus: 'warn',
      recordsIn: 3,
      recordsOut: 1,
      errorClass: 'warmup',
    })
  })

  it('reports symbol-aware factor status without mixing same-timestamp records', () => {
    const snapshot = makeSymbolAwareSnapshot({ count: 20 })
    const report = buildIcMonitorStatusReport({
      snapshot,
      snapshotPresent: true,
      snapshotPath: '/repo/data/runtime/ic_monitor_snapshot.latest.json',
      config: {
        ...testConfig,
        decayThresholds: {
          ...testConfig.decayThresholds,
          meanIcFloor: 1.1,
        },
      },
      generatedAt: '2026-05-03T00:00:00.000Z',
      asOfMs: 1_700_000_000_000 + 70 * HOUR_MS,
    })

    expect(report.symbolCount).toBe(2)
    expect(report.symbols).toEqual(['BTC-USDT', 'ETH-USDT'])
    expect(report.factorCount).toBe(1)
    expect(report.factors).toHaveLength(2)
    expect(report.factors.map(factor => factor.symbol).sort()).toEqual(['BTC-USDT', 'ETH-USDT'])
    expect(report.blockingReasons.some(reason => reason.includes('symbol:BTC-USDT:'))).toBe(true)
  })
})

function makeSnapshot(input: { count: number }): IcMonitorSnapshot {
  const baseTime = 1_700_000_000_000
  const signals = []
  const returns = []
  for (let i = 0; i < input.count; i++) {
    const signalTime = baseTime + i * HOUR_MS
    signals.push({
      factor: 'momentum',
      value: i,
      timestamp: signalTime,
    })
    returns.push({
      value: i * 0.01,
      timestamp: signalTime + HOUR_MS,
    })
  }
  return {
    version: 1,
    signals,
    returns,
  }
}

function makeMultiHorizonSnapshot(input: { count: number }): IcMonitorSnapshot {
  const baseTime = 1_700_000_000_000
  const signals = []
  const returns = []
  for (let i = 0; i < input.count; i++) {
    const signalTime = baseTime + i * 3 * HOUR_MS
    signals.push({
      factor: 'momentum',
      value: i,
      timestamp: signalTime,
    })
    returns.push({
      value: i * 0.01,
      timestamp: signalTime + HOUR_MS,
    })
    returns.push({
      value: i * 0.02,
      timestamp: signalTime + 2 * HOUR_MS,
    })
  }
  return {
    version: 1,
    signals,
    returns,
  }
}

function makeSymbolAwareSnapshot(input: { count: number }): IcMonitorSnapshot {
  const baseTime = 1_700_000_000_000
  const signals = []
  const returns = []
  for (let i = 0; i < input.count; i++) {
    const signalTime = baseTime + i * 3 * HOUR_MS
    signals.push({
      factor: 'momentum',
      value: i,
      timestamp: signalTime,
      symbol: 'BTC-USDT',
    })
    returns.push({
      value: i * 0.01,
      timestamp: signalTime + HOUR_MS,
      symbol: 'BTC-USDT',
    })
    returns.push({
      value: i * 0.02,
      timestamp: signalTime + 2 * HOUR_MS,
      symbol: 'BTC-USDT',
    })
    signals.push({
      factor: 'momentum',
      value: input.count - i,
      timestamp: signalTime,
      symbol: 'ETH-USDT',
    })
    returns.push({
      value: i * 0.01,
      timestamp: signalTime + HOUR_MS,
      symbol: 'ETH-USDT',
    })
    returns.push({
      value: i * 0.02,
      timestamp: signalTime + 2 * HOUR_MS,
      symbol: 'ETH-USDT',
    })
  }
  return {
    version: 1,
    signals,
    returns,
  }
}
