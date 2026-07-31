import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildOkxOrderbookSpreadRow,
  parseOkxOrderbookSpreadSnapshotArgs,
  summarizeOkxOrderbookSpreadQuality,
} from './collect_okx_orderbook_spread_snapshot.js'

describe('collect_okx_orderbook_spread_snapshot', () => {
  it('parses defaults and keeps package scripts wired', () => {
    expect(parseOkxOrderbookSpreadSnapshotArgs([
      '--symbols',
      'BTCUSDT,ETHUSDT',
      '--report',
      'none',
      '--dryRun',
      'true',
      '--depth',
      '10',
      '--timeoutMs',
      '1234',
      '--retryAttempts',
      '0',
      '--retryDelayMs',
      '0',
    ])).toMatchObject({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      outputPath: expect.stringMatching(/data\/normalized\/orderbook\/okx_swap_orderbook_spread_live\.normalized\.jsonl$/),
      reportPath: null,
      dryRun: true,
      depth: 10,
      timeoutMs: 1234,
      retryAttempts: 0,
      retryDelayMs: 0,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:okx:orderbook-spread-snapshot']).toContain('collect_okx_orderbook_spread_snapshot.ts')
    expect(scripts['status:research-evidence']).toContain('collect_okx_orderbook_spread_snapshot.ts')
    expect(scripts['research:okx:orderbook-spread-snapshot']).not.toContain('/Volumes/shield')
  })

  it('builds a research-only normalized order-book spread row with explicit lineage', () => {
    const row = buildOkxOrderbookSpreadRow({
      symbol: 'ETHUSDT',
      instId: 'ETH-USDT-SWAP',
      fetchedAt: '2026-05-07T01:30:00.000Z',
      observedAt: '2026-05-07T01:30:01.000Z',
      availableAt: '2026-05-07T01:30:02.000Z',
      jobId: 'job-1',
      reportPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json',
      manifestPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json.manifest.json',
      depth: 10,
      book: {
        ts: '1778117400000',
        bids: [
          ['2345.00', '10', '0', '1'],
          ['2344.90', '20', '0', '1'],
          ['2344.80', '30', '0', '1'],
          ['2344.70', '40', '0', '1'],
          ['2344.60', '50', '0', '1'],
        ],
        asks: [
          ['2345.50', '11', '0', '1'],
          ['2345.60', '21', '0', '1'],
          ['2345.70', '31', '0', '1'],
          ['2345.80', '41', '0', '1'],
          ['2345.90', '51', '0', '1'],
        ],
      },
    })

    expect(row).toMatchObject({
      schemaVersion: 'openalice.orderbook_spread_snapshot.v1',
      eventTime: '2026-05-07T01:30:00.000Z',
      eventTimeMs: 1778117400000,
      exchange: 'okx',
      market: 'swap',
      symbol: 'ETHUSDT',
      endpointId: 'okxOrderbookSpreadSnapshot',
      sourceEndpoint: '/api/v5/market/books',
      sourceTimestampBasis: 'exchange_book_ts',
      fetchedAt: '2026-05-07T01:30:00.000Z',
      observedAt: '2026-05-07T01:30:01.000Z',
      availableAt: '2026-05-07T01:30:02.000Z',
      jobId: 'job-1',
      collectionRunId: 'job-1',
      lineageStatus: 'explicit_row_lineage',
      quality: {
        status: 'pass',
        blockers: [],
      },
      fields: {
        symbol: 'ETHUSDT',
        instId: 'ETH-USDT-SWAP',
        bestBid: 2345,
        bestAsk: 2345.5,
        midPrice: 2345.25,
        spreadAbs: 0.5,
        spreadBps: 2.13196887,
        bidSizeTop: 10,
        askSizeTop: 11,
        bidNotionalTop: 23450,
        askNotionalTop: 25800.5,
        bidNotionalDepth5: 351710,
        askNotionalDepth5: 363593.5,
        depthLevelsReturned: 5,
        requestedDepth: 10,
        sourceBookTs: 1778117400000,
      },
    })
    expect(row.dedupKey).toBe('okx|swap|okxOrderbookSpreadSnapshot|ETHUSDT|1778117400000')
    expect(row.rawPayloadHash).toHaveLength(64)
    expect(row.normalizedPayloadHash).toHaveLength(64)
  })

  it('marks thin or wide books as quality-blocked without authorizing execution', () => {
    const row = buildOkxOrderbookSpreadRow({
      symbol: 'ORDIUSDT',
      instId: 'ORDI-USDT-SWAP',
      fetchedAt: '2026-05-07T01:30:00.000Z',
      observedAt: '2026-05-07T01:30:01.000Z',
      availableAt: '2026-05-07T01:30:02.000Z',
      jobId: 'job-1',
      reportPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json',
      manifestPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json.manifest.json',
      depth: 10,
      book: {
        ts: '1778117400000',
        bids: [['10.00', '20', '0', '1']],
        asks: [['10.08', '15', '0', '1']],
      },
    })

    expect(row.quality.status).toBe('blocked')
    expect(row.quality.blockers).toEqual(expect.arrayContaining([
      'spread_bps_high:79.6812749>20',
      'depth5_usd_low:151.2<100000',
      'book_depth_levels_low:1',
    ]))
    expect(row.fields.spreadBps).toBe(79.6812749)
  })

  it('summarizes pass and blocked symbol quality for runtime reports', () => {
    const pass = buildOkxOrderbookSpreadRow({
      symbol: 'BTCUSDT',
      instId: 'BTC-USDT-SWAP',
      fetchedAt: '2026-05-07T01:30:00.000Z',
      observedAt: '2026-05-07T01:30:01.000Z',
      availableAt: '2026-05-07T01:30:02.000Z',
      jobId: 'job-1',
      reportPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json',
      manifestPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json.manifest.json',
      depth: 10,
      book: {
        ts: '1778117400000',
        bids: [
          ['100.00', '1000', '0', '1'],
          ['99.99', '1000', '0', '1'],
          ['99.98', '1000', '0', '1'],
          ['99.97', '1000', '0', '1'],
          ['99.96', '1000', '0', '1'],
        ],
        asks: [
          ['100.01', '1000', '0', '1'],
          ['100.02', '1000', '0', '1'],
          ['100.03', '1000', '0', '1'],
          ['100.04', '1000', '0', '1'],
          ['100.05', '1000', '0', '1'],
        ],
      },
    })
    const blocked = buildOkxOrderbookSpreadRow({
      symbol: 'ETHUSDT',
      instId: 'ETH-USDT-SWAP',
      fetchedAt: '2026-05-07T01:31:00.000Z',
      observedAt: '2026-05-07T01:31:01.000Z',
      availableAt: '2026-05-07T01:31:02.000Z',
      jobId: 'job-1',
      reportPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json',
      manifestPath: '/repo/data/runtime/okx_orderbook_spread_snapshot.latest.json.manifest.json',
      depth: 10,
      book: {
        ts: '1778117460000',
        bids: [['2000.00', '10', '0', '1']],
        asks: [['2000.20', '10', '0', '1']],
      },
    })

    expect(summarizeOkxOrderbookSpreadQuality([blocked, pass])).toMatchObject({
      passedSymbols: ['BTCUSDT'],
      blockedSymbols: ['ETHUSDT'],
      qualityBySymbol: [
        {
          symbol: 'BTCUSDT',
          status: 'pass',
          blockers: [],
          depth5Usd: 499900,
          availableAt: '2026-05-07T01:30:02.000Z',
        },
        {
          symbol: 'ETHUSDT',
          status: 'blocked',
          blockers: expect.arrayContaining([
            'depth5_usd_low:20000<100000',
            'book_depth_levels_low:1',
          ]),
          depth5Usd: 20000,
          availableAt: '2026-05-07T01:31:02.000Z',
        },
      ],
    })
  })
})
