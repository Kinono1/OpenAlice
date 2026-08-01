import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchCandlesWithRetry, filterAssets, mergeLatestRows, parseArgs, parseCSV, rowsToCSV } from './accumulate_5m_data.js'
import { appendOhlcvCollectorPitRows, buildOhlcvCollectorPitRows } from './lib/ohlcv_collector_pit.js'

describe('accumulate_5m_data CSV handling', () => {
  it('parses rows by header name instead of fixed offsets', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,0.1784,0.179,0.1779,0.1787,123.4,JUP_USDT_USDT,5m,okx',
    ].join('\n'))

    expect(parsed.rows.get(1777701000000)).toEqual({
      timestamp: 1777701000000,
      open: 0.1784,
      high: 0.179,
      low: 0.1779,
      close: 0.1787,
      volume: 123.4,
    })
  })

  it('drops header-shifted placeholder rows while parsing existing CSV', () => {
    const parsed = parseCSV([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '1777701000000,2026-05-02T05:50:00.000Z,2026,2026,2026,2026,2026,JUP_USDT_USDT,5m,okx',
      '1777701300000,2026-05-02T05:55:00.000Z,0.1784,0.179,0.1779,0.1787,123.4,JUP_USDT_USDT,5m,okx',
    ].join('\n'))

    expect(parsed.rows.has(1777701000000)).toBe(false)
    expect(parsed.rows.has(1777701300000)).toBe(true)
  })

  it('refreshes overlapping rows so newly fetched data repairs corrupt candles', () => {
    const existing = new Map([
      [1777701300000, {
        timestamp: 1777701300000,
        open: 2026,
        high: 2026,
        low: 2026,
        close: 2026,
        volume: 2026,
      }],
    ])

    const merged = mergeLatestRows(existing, [{
      timestamp: 1777701300000,
      open: 0.1784,
      high: 0.179,
      low: 0.1779,
      close: 0.1787,
      volume: 123.4,
    }])

    expect(merged.newBars).toBe(0)
    expect(merged.replacedBars).toBe(1)
    expect(merged.rows.get(1777701300000)?.open).toBe(0.1784)
  })

  it('writes rows in chronological order', () => {
    const csv = rowsToCSV(
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      new Map([
        [2, { timestamp: 2, open: 2, high: 3, low: 1, close: 2.5, volume: 10 }],
        [1, { timestamp: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }],
      ]),
      'BTC_USDT_USDT',
      'okx',
    )

    const rows = csv.split('\n')
    expect(rows[1]?.startsWith('1,')).toBe(true)
    expect(rows[2]?.startsWith('2,')).toBe(true)
  })

  it('parses and applies symbol subsets for targeted carry settlement refreshes', () => {
    expect(parseArgs(['--symbols', 'BTC,ETH,SOL-USDT']).symbols).toEqual(['BTC', 'ETH', 'SOL'])
    expect(filterAssets([
      { base: 'BTC', id: 1 },
      { base: 'ETH', id: 2 },
      { base: 'SOL', id: 3 },
    ], ['BTC', 'ETH'])).toEqual([
      { base: 'BTC', id: 1 },
      { base: 'ETH', id: 2 },
    ])
  })

  it('retries transient OKX 5m fetch failures before giving up', async () => {
    let attempts = 0
    const rows = await fetchCandlesWithRetry(
      async () => {
        attempts += 1
        if (attempts < 3) throw new Error('transient tls reset')
        return [{ timestamp: 1778205900000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }]
      },
      'ETH-USDT-SWAP',
      '5m',
      300,
      3,
      0,
    )

    expect(attempts).toBe(3)
    expect(rows).toHaveLength(1)
  })

  it('throws the final OKX 5m fetch error after retry attempts are exhausted', async () => {
    let attempts = 0
    await expect(fetchCandlesWithRetry(
      async () => {
        attempts += 1
        throw new Error('persistent tls reset')
      },
      'BTC-USDT-SWAP',
      '5m',
      300,
      2,
      0,
    )).rejects.toThrow('persistent tls reset')

    expect(attempts).toBe(2)
  })

  it('builds research-only row-explicit PIT sidecar rows for 5m collection', () => {
    const rows = buildOhlcvCollectorPitRows({
      generatedAt: '2026-05-07T01:00:00.000Z',
      jobId: 'okx_public_ohlcv_5m_collector',
      collectionRunId: 'run-1',
      symbol: 'ETH_USDT_USDT',
      storageSymbol: 'ETH_USDT_USDT',
      instId: 'ETH-USDT-SWAP',
      timeframe: '5m',
      bar: '5m',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{ timestamp: 1778112000000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      timeframe: '5m',
      bar: '5m',
      availableAtBasis: 'row_explicit_collector_response_time_research_availability',
      observedAtBasis: 'row_explicit_collector_response_time',
      fetchedAtBasis: 'row_explicit_collector_request_start_time',
      quality: {
        promotionGrade: false,
      },
    })
  })

  it('writes a sidecar evidence manifest when appending collector PIT rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-pit-append-'))
    const outputPath = join(root, 'parquet/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl')
    await mkdir(join(root, 'parquet/research'), { recursive: true })
    const rows = buildOhlcvCollectorPitRows({
      generatedAt: '2026-05-07T01:00:00.000Z',
      jobId: 'okx_public_ohlcv_5m_collector',
      collectionRunId: 'run-1',
      symbol: 'ETH_USDT_USDT',
      storageSymbol: 'ETH_USDT_USDT',
      instId: 'ETH-USDT-SWAP',
      timeframe: '5m',
      bar: '5m',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{ timestamp: 1778112000000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }],
    })

    const result = await appendOhlcvCollectorPitRows(outputPath, rows)

    expect(result).toEqual({ rowsWritten: 1, path: outputPath })
    expect((await readFile(outputPath, 'utf-8')).trim().split('\n')).toHaveLength(1)
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'okx_public_ohlcv_pit_rows_research_only',
      artifactPath: outputPath,
      businessStatus: 'warn',
      evidenceTrust: expect.stringMatching(/^(pass|quarantine)$/),
      recordsIn: 1,
      recordsOut: 1,
      errorClass: 'research_only_not_execution_evidence',
    })
  })

  it('hashes only appended PIT sidecar rows so large existing logs do not need full reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-ohlcv-pit-append-hash-'))
    const outputPath = join(root, 'parquet/research/openalice_okx_public_ohlcv_pit_rows.research_only.jsonl')
    await mkdir(join(root, 'parquet/research'), { recursive: true })
    const rows = buildOhlcvCollectorPitRows({
      generatedAt: '2026-05-07T01:00:00.000Z',
      jobId: 'okx_public_ohlcv_5m_collector',
      collectionRunId: 'run-1',
      symbol: 'BTC_USDT_USDT',
      storageSymbol: 'BTC_USDT_USDT',
      instId: 'BTC-USDT-SWAP',
      timeframe: '5m',
      bar: '5m',
      limit: 300,
      requestStartedAt: '2026-05-07T01:00:01.000Z',
      responseObservedAt: '2026-05-07T01:00:02.000Z',
      candles: [{ timestamp: 1778112000000, open: 1, high: 2, low: 1, close: 1.5, volume: 10 }],
    })

    await appendOhlcvCollectorPitRows(outputPath, rows)
    await appendOhlcvCollectorPitRows(outputPath, rows)

    const appendedBatch = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      artifactHash: createHash('sha256').update(appendedBatch).digest('hex'),
      recordsIn: 1,
      recordsOut: 1,
    })
    expect((await readFile(outputPath, 'utf-8')).trim().split('\n')).toHaveLength(2)
  })
})
