import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DuckDBInstance } from '@duckdb/node-api'
import type { OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { appendOkxMarketEvents, listRawSegmentManifests, payloadHash } from './lib/okx_warehouse.js'
import { compactOkxWarehouse } from './compact_okx_warehouse.js'

describe('compact_okx_warehouse', () => {
  it('compacts sealed gzip JSONL to verified Parquet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-compact-'))
    const dataRoot = join(root, 'data')
    const warehouseRoot = join(dataRoot, 'warehouse', 'okx')
    const configPath = join(root, 'config.json')
    await writeFile(configPath, `${JSON.stringify({ enabled: true, dataRoot })}\n`)
    const payload = { last: 100 }
    const event: OkxMarketEvent = {
      schemaVersion: 'okx_market_event.v1', exchange: 'okx', dataset: 'ticker', instrumentType: 'SWAP',
      instrumentId: 'BTC-USDT-SWAP', instrumentFamily: 'BTC-USDT', symbol: 'BTC-USDT-SWAP', channel: 'tickers',
      sourceTransport: 'rest', sourceEndpoint: '/api/v5/market/tickers', eventTime: '2026-07-18T00:00:00Z',
      availableAt: '2026-07-18T00:00:01Z', ingestedAt: '2026-07-18T00:00:02Z', confirmed: null,
      sequenceId: null, checksum: null, collectionRunId: 'compact-test', universeManifestId: null,
      dedupKey: 'okx|ticker|BTC-USDT-SWAP|2026-07-18T00:00:00Z', payloadHash: payloadHash(payload), payload,
    }
    await appendOkxMarketEvents(warehouseRoot, [event])
    const report = await compactOkxWarehouse(['--configPath', configPath])
    expect(report).toMatchObject({ status: 'complete', candidates: 1, compacted: 1, errors: [] })
    const manifests = await listRawSegmentManifests(warehouseRoot)
    expect(manifests[0].manifest.parquetPath).toContain('.parquet')
    expect(manifests[0].manifest.parquetRows).toBe(1)
    expect((await readFile(join(warehouseRoot, manifests[0].manifest.parquetPath!))).byteLength).toBeGreaterThan(0)

    const catalog = await DuckDBInstance.create(report.catalogPath)
    const connection = await catalog.connect()
    try {
      const reader = await connection.runAndReadAll('SELECT count(*)::BIGINT AS row_count FROM okx_market_events')
      expect(Number(reader.getRowObjectsJson()[0]?.row_count ?? 0)).toBe(1)
    } finally {
      connection.closeSync()
    }
  })

  it('builds one catalog view across parquet files with different partition keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-compact-mixed-'))
    const dataRoot = join(root, 'data')
    const warehouseRoot = join(dataRoot, 'warehouse', 'okx')
    const configPath = join(root, 'config.json')
    await writeFile(configPath, `${JSON.stringify({ enabled: true, dataRoot })}\n`)
    const base = {
      schemaVersion: 'okx_market_event.v1' as const,
      exchange: 'okx' as const,
      instrumentType: 'SWAP' as const,
      instrumentId: 'BTC-USDT-SWAP',
      instrumentFamily: 'BTC-USDT',
      symbol: 'BTC-USDT-SWAP',
      sourceTransport: 'rest' as const,
      eventTime: '2026-07-18T00:00:00Z',
      availableAt: '2026-07-18T00:00:01Z',
      ingestedAt: '2026-07-18T00:00:02Z',
      sequenceId: null,
      checksum: null,
      collectionRunId: 'mixed-partition-test',
      universeManifestId: null,
    }
    const candlePayload = { bar: '5m', open: '100', high: '101', low: '99', close: '100.5', volume: '10' }
    const fundingPayload = { fundingRate: '0.0001', nextFundingTime: '2026-07-18T08:00:00Z' }
    const events: OkxMarketEvent[] = [
      {
        ...base,
        dataset: 'candle', channel: 'candle5m', sourceEndpoint: '/api/v5/market/candles', confirmed: true,
        dedupKey: 'okx|candle|BTC-USDT-SWAP|5m|2026-07-18T00:00:00Z', payloadHash: payloadHash(candlePayload), payload: candlePayload,
      },
      {
        ...base,
        dataset: 'funding', channel: 'funding-rate', sourceEndpoint: '/api/v5/public/funding-rate', confirmed: null,
        dedupKey: 'okx|funding|BTC-USDT-SWAP|2026-07-18T00:00:00Z', payloadHash: payloadHash(fundingPayload), payload: fundingPayload,
      },
    ]
    await appendOkxMarketEvents(warehouseRoot, events)
    const report = await compactOkxWarehouse(['--configPath', configPath])
    expect(report).toMatchObject({ status: 'complete', candidates: 2, compacted: 2, errors: [] })

    const catalog = await DuckDBInstance.create(report.catalogPath)
    const connection = await catalog.connect()
    try {
      const reader = await connection.runAndReadAll(`
        SELECT dataset, count(*)::BIGINT AS row_count
        FROM okx_market_events
        GROUP BY dataset
        ORDER BY dataset
      `)
      expect(reader.getRowObjectsJson()).toEqual([
        { dataset: 'candle', row_count: '1' },
        { dataset: 'funding', row_count: '1' },
      ])
    } finally {
      connection.closeSync()
    }
  })
})
