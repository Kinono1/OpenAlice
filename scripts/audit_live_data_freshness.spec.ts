import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  auditLiveDataDirectory,
  buildLiveDataFreshnessReport,
  parseLiveDataFreshnessArgs,
  runLiveDataFreshnessAudit,
} from './audit_live_data_freshness.js'

describe('audit_live_data_freshness', () => {
  it('parses conservative defaults and overrides', () => {
    expect(parseLiveDataFreshnessArgs([])).toMatchObject({
      oneHourDir: 'data/market/live_accumulated',
      fiveMinuteDir: 'data/market/live_5m',
      oneSecondDir: 'data/market/live_1s',
      outputPath: 'data/runtime/live_data_freshness.latest.json',
      maxAge1hMs: 7_200_000,
      maxAge5mMs: 900_000,
      maxAge1sMs: 300_000,
      minRows1h: 408,
      minRows5m: 1000,
      minRows1s: 300,
      minCommonPeriods1h: 1000,
      json: false,
    })

    expect(parseLiveDataFreshnessArgs([
      '--oneHourDir',
      'tmp/1h',
      '--fiveMinuteDir=tmp/5m',
      '--oneSecondDir',
      'tmp/1s',
      '--output',
      'null',
      '--maxAge1hMs',
      '3600000',
      '--minCommonPeriods1h',
      '1200',
      '--json',
      'true',
    ])).toMatchObject({
      oneHourDir: 'tmp/1h',
      fiveMinuteDir: 'tmp/5m',
      oneSecondDir: 'tmp/1s',
      outputPath: null,
      maxAge1hMs: 3_600_000,
      minCommonPeriods1h: 1200,
      json: true,
    })
  })

  it('audits a fresh directory while degrading for insufficient incubation common periods', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-live-freshness-dir-'))
    const dataDir = join(root, 'live_accumulated')
    await mkdir(dataDir, { recursive: true })
    const generatedAt = '2026-05-05T02:00:00.000Z'
    const assets = [
      { paperSymbol: 'BTC-USDT', storageSymbol: 'BTC_USDT_USDT', file: 'BTC_USDT_USDT_1h.csv' },
      { paperSymbol: 'ETH-USDT', storageSymbol: 'ETH_USDT_USDT', file: 'ETH_USDT_USDT_1h.csv' },
    ]
    await writeCsv(join(dataDir, assets[0].file), [
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T01:00:00.000Z',
    ], 'BTC_USDT_USDT', '1h')
    await writeCsv(join(dataDir, assets[1].file), [
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T01:00:00.000Z',
    ], 'ETH_USDT_USDT', '1h')

    const directory = await auditLiveDataDirectory({
      timeframe: '1h',
      dataDir,
      assets,
      generatedAt,
      thresholds: {
        maxAgeMsByTimeframe: { '1h': 2 * 60 * 60 * 1000, '5m': 15 * 60 * 1000, '1s': 5 * 60 * 1000 },
        minRowsByTimeframe: { '1h': 2, '5m': 2, '1s': 2 },
        minCommonPeriods1h: 3,
      },
    })

    expect(directory).toMatchObject({
      timeframe: '1h',
      status: 'degraded',
      expectedAssets: 2,
      presentAssets: 2,
      freshAssets: 2,
      enoughRowsAssets: 2,
      commonPeriods: 2,
      commonLatestDatetime: '2026-05-05T01:00:00.000Z',
      incubationCommonPeriodsReady: false,
      blockers: ['common_periods_low:2<3'],
    })
  })

  it('blocks when files are stale, missing, or too short without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-live-freshness-blocked-'))
    const dataDir = join(root, 'live_5m')
    await mkdir(dataDir, { recursive: true })
    const assets = [
      { paperSymbol: 'BTC-USDT', storageSymbol: 'BTC_USDT_USDT', file: 'BTC_USDT_USDT_5m.csv' },
      { paperSymbol: 'ETH-USDT', storageSymbol: 'ETH_USDT_USDT', file: 'ETH_USDT_USDT_5m.csv' },
    ]
    await writeCsv(join(dataDir, assets[0].file), [
      '2026-05-05T00:00:00.000Z',
    ], 'BTC_USDT_USDT', '5m')

    const directory = await auditLiveDataDirectory({
      timeframe: '5m',
      dataDir,
      assets,
      generatedAt: '2026-05-05T02:00:00.000Z',
      thresholds: {
        maxAgeMsByTimeframe: { '1h': 2 * 60 * 60 * 1000, '5m': 15 * 60 * 1000, '1s': 5 * 60 * 1000 },
        minRowsByTimeframe: { '1h': 2, '5m': 2, '1s': 2 },
        minCommonPeriods1h: 1000,
      },
    })
    const report = buildLiveDataFreshnessReport({
      generatedAt: '2026-05-05T02:00:00.000Z',
      thresholds: {
        maxAgeMsByTimeframe: { '1h': 2 * 60 * 60 * 1000, '5m': 15 * 60 * 1000, '1s': 5 * 60 * 1000 },
        minRowsByTimeframe: { '1h': 2, '5m': 2, '1s': 2 },
        minCommonPeriods1h: 1000,
      },
      directories: [directory],
    })

    expect(directory.status).toBe('blocked')
    expect(directory.blockers).toEqual(expect.arrayContaining([
      'missing_asset:ETH-USDT',
      'stale_asset:BTC-USDT:7200000>900000',
      'insufficient_rows:BTC-USDT:1<2',
      'common_periods_missing',
    ]))
    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'blocked',
    })
  })

  it('writes the audit artifact and sidecar manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-live-freshness-run-'))
    const oneHourDir = join(root, '1h')
    const fiveMinuteDir = join(root, '5m')
    const oneSecondDir = join(root, '1s')
    const runtimeDir = join(root, 'runtime')
    await mkdir(oneHourDir, { recursive: true })
    await mkdir(fiveMinuteDir, { recursive: true })
    await mkdir(oneSecondDir, { recursive: true })
    for (const base of ['BTC', 'ETH', 'SOL', 'BNB', 'XRP']) {
      await writeCsv(join(oneHourDir, `${base}_USDT_USDT_1h.csv`), [
        '2026-05-05T00:00:00.000Z',
        '2026-05-05T01:00:00.000Z',
      ], `${base}_USDT_USDT`, '1h')
      await writeCsv(join(fiveMinuteDir, `${base}_USDT_USDT_5m.csv`), [
        '2026-05-05T01:50:00.000Z',
        '2026-05-05T01:55:00.000Z',
      ], `${base}_USDT_USDT`, '5m')
    }
    for (const base of ['BTC', 'ETH', 'SOL']) {
      await writeCsv(join(oneSecondDir, `${base}_USDT_USDT_1s.csv`), [
        '2026-05-05T01:59:58.000Z',
        '2026-05-05T01:59:59.000Z',
      ], `${base}_USDT_USDT`, '1s')
    }

    const outputPath = join(runtimeDir, 'live_data_freshness.latest.json')
    const report = await runLiveDataFreshnessAudit({
      oneHourDir,
      fiveMinuteDir,
      oneSecondDir,
      outputPath,
      maxAge1hMs: 365 * 24 * 60 * 60 * 1000,
      maxAge5mMs: 365 * 24 * 60 * 60 * 1000,
      maxAge1sMs: 365 * 24 * 60 * 60 * 1000,
      minRows1h: 2,
      minRows5m: 2,
      minRows1s: 2,
      minCommonPeriods1h: 2,
      json: false,
    })

    expect(report.status).toBe('fresh')
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      status: 'fresh',
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      summary: {
        publicDataUsableForLiveOnlyResearch: true,
        oneHourIncubationCommonPeriodsReady: true,
      },
    })
    const manifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'live_data_freshness_audit',
      exitCode: 0,
      businessStatus: 'pass',
      recordsIn: 13,
      recordsOut: 13,
    })
  })
})

async function writeCsv(path: string, datetimes: string[], symbol: string, timeframe: string): Promise<void> {
  const lines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
  for (const datetime of datetimes) {
    lines.push([
      Date.parse(datetime),
      datetime,
      100,
      101,
      99,
      100.5,
      10,
      symbol,
      timeframe,
      'okx',
    ].join(','))
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf-8')
}
