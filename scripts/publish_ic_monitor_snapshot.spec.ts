import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  parsePublishIcMonitorSnapshotArgs,
  publishIcMonitorSnapshot,
} from './publish_ic_monitor_snapshot.js'

const HOUR_MS = 60 * 60 * 1000

describe('publish_ic_monitor_snapshot', () => {
  it('parses defaults', () => {
    expect(parsePublishIcMonitorSnapshotArgs([])).toEqual({
      dataDir: 'data/market/live_accumulated',
      symbols: ['BTC', 'ETH', 'SOL'],
      timeframe: '1h',
      outputPath: 'data/runtime/ic_monitor_snapshot.latest.json',
      maxBars: 240,
      minWarmupBars: 48,
      json: false,
    })
    expect(parsePublishIcMonitorSnapshotArgs([
      '--dataDir',
      'tmp/data',
      '--symbols',
      'btc,sol',
      '--timeframe',
      '5m',
      '--outputPath',
      'null',
      '--maxBars',
      '80',
      '--minWarmupBars',
      '24',
      '--json',
      'true',
    ])).toEqual({
      dataDir: 'tmp/data',
      symbols: ['BTC', 'SOL'],
      timeframe: '5m',
      outputPath: null,
      maxBars: 80,
      minWarmupBars: 24,
      json: true,
    })
  })

  it('replays local OHLCV into an IC monitor snapshot without trading side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ic-monitor-snapshot-'))
    const dataDir = join(root, 'market')
    const outputPath = join(root, 'runtime', 'ic_monitor_snapshot.latest.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'BTC_USDT_USDT_1h.csv'), buildCsvRows(72), 'utf-8')

    const report = await publishIcMonitorSnapshot({
      dataDir,
      symbols: ['BTC'],
      timeframe: '1h',
      outputPath,
      maxBars: 72,
      minWarmupBars: 48,
      json: true,
    })

    expect(report.status).toBe('ok')
    expect(report.samplesWritten).toBeGreaterThan(0)
    expect(report.returnCount).toBeGreaterThan(0)
    expect(report.factorCount).toBeGreaterThan(0)
    expect(report.symbolDiagnostics).toEqual([
      expect.objectContaining({
        symbol: 'BTC-USDT',
        status: 'ok',
        rowsLoaded: 72,
      }),
    ])
    expect(report.notes.join('\n')).toContain('No orders are submitted')

    const snapshot = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(snapshot.signals.length).toBe(report.samplesWritten)
    expect(snapshot.returns.length).toBe(report.returnCount)
    expect(snapshot.signals[0]).toMatchObject({
      factor: expect.any(String),
      value: expect.any(Number),
      timestamp: expect.any(Number),
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'ic_monitor_snapshot',
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: 72,
      recordsOut: report.samplesWritten,
    })
  })

  it('reports missing data without writing samples', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ic-monitor-snapshot-missing-'))
    const report = await publishIcMonitorSnapshot({
      dataDir: root,
      symbols: ['BTC'],
      timeframe: '1h',
      outputPath: null,
      maxBars: 72,
      minWarmupBars: 48,
      json: true,
    })

    expect(report.status).toBe('missing_data')
    expect(report.samplesWritten).toBe(0)
    expect(report.symbolDiagnostics[0]).toMatchObject({
      symbol: 'BTC-USDT',
      status: 'missing',
    })
  })

  it('replays multi-symbol OHLCV into symbol-isolated IC records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ic-monitor-snapshot-multi-'))
    const dataDir = join(root, 'market')
    const outputPath = join(root, 'runtime', 'ic_monitor_snapshot.latest.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'BTC_USDT_USDT_1h.csv'), buildCsvRows(72), 'utf-8')
    await writeFile(join(dataDir, 'ETH_USDT_USDT_1h.csv'), buildCsvRows(72, 200), 'utf-8')

    const report = await publishIcMonitorSnapshot({
      dataDir,
      symbols: ['BTC', 'ETH'],
      timeframe: '1h',
      outputPath,
      maxBars: 72,
      minWarmupBars: 48,
      json: true,
    })

    expect(report.status).toBe('ok')
    expect(report.symbolDiagnostics).toEqual([
      expect.objectContaining({ symbol: 'BTC-USDT', status: 'ok' }),
      expect.objectContaining({ symbol: 'ETH-USDT', status: 'ok' }),
    ])
    const snapshot = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(snapshot.signals.length).toBe(report.samplesWritten)
    expect(snapshot.signals.some((record: { symbol?: string }) => record.symbol === 'BTC-USDT')).toBe(true)
    expect(snapshot.signals.some((record: { symbol?: string }) => record.symbol === 'ETH-USDT')).toBe(true)
    expect(snapshot.returns.some((record: { symbol?: string }) => record.symbol === 'BTC-USDT')).toBe(true)
    expect(snapshot.returns.some((record: { symbol?: string }) => record.symbol === 'ETH-USDT')).toBe(true)
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'ic_monitor_snapshot',
      businessStatus: 'pass',
    })
  })
})

function buildCsvRows(count: number, basePrice = 100): string {
  const lines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
  const baseTime = 1_700_000_000_000
  for (let i = 0; i < count; i++) {
    const timestamp = baseTime + i * HOUR_MS
    const close = basePrice + i + Math.sin(i / 3)
    lines.push([
      timestamp,
      new Date(timestamp).toISOString(),
      close - 0.5,
      close + 1,
      close - 1,
      close,
      1000 + i * 5,
      'BTC_USDT_USDT',
      '1h',
      'test',
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}
