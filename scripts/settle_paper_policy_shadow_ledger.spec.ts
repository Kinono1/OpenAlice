import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appendPaperPolicyShadowOpen,
  readPaperPolicyShadowLedger,
} from '../src/runtime/paper_policy_shadow_ledger.js'
import { paperSymbolToCsvFile } from './lib/paper_universe.js'
import {
  parseMarketCandleCsv,
  parsePaperPolicyShadowSettleArgs,
  settlePaperPolicyShadowLedger,
} from './settle_paper_policy_shadow_ledger.js'

const OPEN_BAR_TIME = 1_700_000_000_000

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'paper-policy-shadow-settle-'))
}

function baseShadow(overrides = {}) {
  return {
    counterfactualType: 'trade_level_shadow' as const,
    eventType: 'open' as const,
    shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000:long',
    lane: 'volume_breakout_1x',
    symbol: 'BTC-USDT',
    side: 'long' as const,
    entryPrice: 100,
    openTs: '2026-05-02T00:00:00.000Z',
    openBarTime: OPEN_BAR_TIME,
    horizonMs: 600_000,
    notionalUsd: 1_000,
    stopLossPrice: 98,
    blockReasons: ['test_gate'],
    context: {
      contextSnapshotId: 'market_intel:schema:1:generation:7:lane:volume_breakout_1x:flash:3:pro:4:news:5',
      decisionTime: '2026-05-02T00:00:00.000Z',
      marketDataWatermarkAtDecisionTime: '2026-05-02T00:00:00.000Z',
      watermark: '2026-05-02T00:00:00.000Z',
      featuresAvailableAtDecisionTime: true,
      featureSchemaVersion: 'paper_open_context.v3',
      contextGenerationAtOpen: 7,
      contextStatus: 'ok',
      flashContextStatus: 'ok',
      contextReason: null,
      flashEpochAtOpen: 3,
      flashConfidenceLowAtOpen: 0.42,
      proEpochAtOpen: 4,
      marketIntelTriggerAtOpen: 'cached_market_intel',
    },
    quality: {},
    ...overrides,
  }
}

async function writeCandles(dataDir: string, symbol: string, rows: string[]): Promise<void> {
  const path = join(dataDir, paperSymbolToCsvFile(symbol, '5m'))
  await writeFile(path, [
    'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
    ...rows,
  ].join('\n'), 'utf-8')
}

describe('settle_paper_policy_shadow_ledger', () => {
  it('parses args with dry-run default enabled', () => {
    expect(parsePaperPolicyShadowSettleArgs([])).toMatchObject({
      ledgerPath: 'data/paper_trading/paper_policy_shadow_ledger.jsonl',
      dataDir: 'data/market/live_5m',
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: true,
      maxOutcomes: null,
      outputPath: 'data/runtime/paper_policy_shadow_settle.latest.json',
      lockDir: 'data/runtime/locks/paper_policy_shadow_settle.script.lock',
      json: false,
    })

    expect(parsePaperPolicyShadowSettleArgs([
      '--timeframe',
      '1s',
      '--dryRun',
      'false',
      '--asOf',
      '2026-05-02T00:10:00.000Z',
      '--maxOutcomes',
      '3',
      '--outputPath',
      'null',
    ])).toMatchObject({
      dataDir: 'data/market/live_1s',
      timeframe: '1s',
      dryRun: false,
      asOfMs: Date.parse('2026-05-02T00:10:00.000Z'),
      maxOutcomes: 3,
      outputPath: null,
    })
  })

  it('dry-runs horizon outcomes on the first eligible candle without appending', async () => {
    const root = await tempRoot()
    const ledgerPath = join(root, 'ledger.jsonl')
    const dataDir = root
    appendPaperPolicyShadowOpen(baseShadow(), ledgerPath)
    await writeCandles(dataDir, 'BTC-USDT', [
      `${OPEN_BAR_TIME},2026-05-02T00:00:00.000Z,100,110,90,105,1,BTC_USDT_USDT,5m,test`,
      `${OPEN_BAR_TIME + 300_000},2026-05-02T00:05:00.000Z,100,102,99,101,1,BTC_USDT_USDT,5m,test`,
      `${OPEN_BAR_TIME + 600_000},2026-05-02T00:10:00.000Z,101,104,100,103,1,BTC_USDT_USDT,5m,test`,
      `${OPEN_BAR_TIME + 900_000},2026-05-02T00:15:00.000Z,103,204,102,200,1,BTC_USDT_USDT,5m,test`,
    ])

    const report = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: true,
      maxOutcomes: null,
      outputPath: join(root, 'report.json'),
      json: true,
    })

    expect(report.counts).toMatchObject({
      openShadowsLoaded: 1,
      shadowsConsidered: 1,
      dueOutcomes: 1,
      appendedOutcomes: 0,
      notDue: 0,
    })
    expect(report.outcomes[0]).toMatchObject({
      shadowId: 'volume_breakout_1x:BTC-USDT:1700000000000:long',
      closeReason: 'shadow_horizon_expired',
      closePrice: 103,
      closeBarTime: OPEN_BAR_TIME + 600_000,
      pnlPct: 3,
    })
    expect(readPaperPolicyShadowLedger(ledgerPath)).toHaveLength(1)
    const persistedRaw = await readFile(join(root, 'report.json'), 'utf-8')
    const persistedReport = JSON.parse(persistedRaw)
    expect(persistedReport.dryRun).toBe(true)
    expect(persistedReport.evidenceManifest).toMatchObject({
      job: 'paper_policy_shadow_settle',
      artifactPath: join(root, 'report.json'),
      manifestPath: join(root, 'report.json.manifest.json'),
      recordsIn: 1,
      recordsOut: 0,
      artifactHash: null,
    })
    expect(persistedReport.evidenceManifest.evidenceTrust).toMatch(/^(pass|quarantine)$/)
    const manifest = JSON.parse(await readFile(join(root, 'report.json.manifest.json'), 'utf-8'))
    expect(manifest).toMatchObject({
      job: 'paper_policy_shadow_settle',
      recordsIn: 1,
      recordsOut: 0,
    })
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('appends stop-loss outcomes using OHLC detection and stop price fill', async () => {
    const root = await tempRoot()
    const ledgerPath = join(root, 'ledger.jsonl')
    const dataDir = root
    appendPaperPolicyShadowOpen(baseShadow(), ledgerPath)
    await writeCandles(dataDir, 'BTC-USDT', [
      `${OPEN_BAR_TIME + 300_000},2026-05-02T00:05:00.000Z,100,102,97,101,1,BTC_USDT_USDT,5m,test`,
      `${OPEN_BAR_TIME + 600_000},2026-05-02T00:10:00.000Z,101,104,100,103,1,BTC_USDT_USDT,5m,test`,
    ])

    const report = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: false,
      maxOutcomes: null,
      outputPath: null,
      json: true,
    })

    expect(report.counts.appendedOutcomes).toBe(1)
    expect(report.outcomes[0]).toMatchObject({
      closeReason: 'shadow_stop_loss',
      closePrice: 98,
      closeBarTime: OPEN_BAR_TIME + 300_000,
      pnlPct: -2,
      pnlUsd: -20,
    })
    const ledger = readPaperPolicyShadowLedger(ledgerPath)
    expect(ledger).toHaveLength(2)
    expect(ledger[1]).toMatchObject({
      eventType: 'closed',
      closeReason: 'shadow_stop_loss',
      closePrice: 98,
    })
  })

  it('is idempotent across repeated non-dry-run settlements', async () => {
    const root = await tempRoot()
    const ledgerPath = join(root, 'ledger.jsonl')
    const dataDir = root
    appendPaperPolicyShadowOpen(baseShadow(), ledgerPath)
    await writeCandles(dataDir, 'BTC-USDT', [
      `${OPEN_BAR_TIME + 300_000},2026-05-02T00:05:00.000Z,100,102,97,101,1,BTC_USDT_USDT,5m,test`,
    ])

    const first = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: false,
      maxOutcomes: null,
      outputPath: null,
      json: true,
    })
    const second = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: false,
      maxOutcomes: null,
      outputPath: null,
      json: true,
    })

    expect(first.counts.appendedOutcomes).toBe(1)
    expect(second.counts).toMatchObject({
      openShadowsLoaded: 0,
      dueOutcomes: 0,
      appendedOutcomes: 0,
    })
    expect(readPaperPolicyShadowLedger(ledgerPath)).toHaveLength(2)
  })

  it('skips non-dry-run settlement when the internal runtime lock is held', async () => {
    const root = await tempRoot()
    const ledgerPath = join(root, 'ledger.jsonl')
    const dataDir = root
    const lockDir = join(root, 'settle.lock')
    const reportPath = join(root, 'report.json')
    await mkdir(lockDir)
    appendPaperPolicyShadowOpen(baseShadow(), ledgerPath)
    await writeCandles(dataDir, 'BTC-USDT', [
      `${OPEN_BAR_TIME + 300_000},2026-05-02T00:05:00.000Z,100,102,97,101,1,BTC_USDT_USDT,5m,test`,
    ])

    const report = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: false,
      maxOutcomes: null,
      outputPath: reportPath,
      lockDir,
      json: true,
    })

    expect(report.counts).toMatchObject({
      openShadowsLoaded: 0,
      shadowsConsidered: 0,
      dueOutcomes: 0,
      appendedOutcomes: 0,
    })
    expect(report.inputs.lockDir).toBe(lockDir)
    expect(report.notes.join('\n')).toContain('internal runtime lock is already held')
    expect(readPaperPolicyShadowLedger(ledgerPath)).toHaveLength(1)
    const persistedRaw = await readFile(reportPath, 'utf-8')
    const persistedReport = JSON.parse(persistedRaw)
    expect(persistedReport.notes.join('\n')).toContain('internal runtime lock is already held')
    expect(persistedReport.evidenceManifest).toMatchObject({
      job: 'paper_policy_shadow_settle',
      recordsIn: 0,
      recordsOut: 0,
      artifactHash: null,
    })
    const manifest = JSON.parse(await readFile(`${reportPath}.manifest.json`, 'utf-8'))
    expect(manifest.artifactHash).toBe(sha256Hex(persistedRaw))
  })

  it('detects short stop-loss from candle high and keeps linear return units', async () => {
    const root = await tempRoot()
    const ledgerPath = join(root, 'ledger.jsonl')
    const dataDir = root
    appendPaperPolicyShadowOpen(baseShadow({
      shadowId: 'volume_breakout_1x:ETH-USDT:1700000000000:short',
      symbol: 'ETH-USDT',
      side: 'short',
      entryPrice: 100,
      stopLossPrice: 104,
    }), ledgerPath)
    await writeCandles(dataDir, 'ETH-USDT', [
      `${OPEN_BAR_TIME + 300_000},2026-05-02T00:05:00.000Z,100,105,95,99,1,ETH_USDT_USDT,5m,test`,
    ])

    const report = await settlePaperPolicyShadowLedger({
      ledgerPath,
      dataDir,
      timeframe: '5m',
      lane: null,
      symbol: null,
      asOfMs: null,
      dryRun: true,
      maxOutcomes: null,
      outputPath: null,
      json: true,
    })

    expect(report.outcomes[0]).toMatchObject({
      side: 'short',
      closeReason: 'shadow_stop_loss',
      closePrice: 104,
      pnlPct: -4,
      pnlUsd: -40,
    })
  })

  it('parses candle CSV by headers and skips invalid rows', () => {
    const parsed = parseMarketCandleCsv([
      'datetime,close,low,high,open,timestamp',
      '2026-05-02T00:00:00.000Z,101,99,102,100,1700000000000',
      'bad,0,0,0,0,not-a-time',
    ].join('\n'))

    expect(parsed.candles).toEqual([{
      timestamp: 1_700_000_000_000,
      datetime: '2026-05-02T00:00:00.000Z',
      open: 100,
      high: 102,
      low: 99,
      close: 101,
    }])
    expect(parsed.invalidRows).toBe(1)
  })
})

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
