import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CompatibilityRow } from './materialize_okx_compatibility.js'
import { compatibilitySourceRelation, parseDuckDbUtcTimestamp, validateCompatibilityRows, writeCompatibilityCsvAtomic } from './materialize_okx_compatibility.js'

function row(timestamp: number): CompatibilityRow {
  return {
    timestamp, datetime: new Date(timestamp).toISOString(), open: 100, high: 102, low: 99, close: 101, volume: 5,
    symbol: 'BTC_USDT_USDT', timeframe: '5m', exchange: 'okx', instrumentId: 'BTC-USDT-SWAP',
    availableAt: new Date(timestamp + 1_000).toISOString(), sourceTransport: 'rest', sourceEndpoint: '/api/v5/market/candles',
  }
}

describe('materialize_okx_compatibility', () => {
  it('writes sorted validated legacy CSV atomically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-materialize-'))
    const path = join(root, 'BTC_USDT_USDT_5m.csv')
    const report = await writeCompatibilityCsvAtomic(path, [row(300_000), row(0)], '5m')
    expect(report).toMatchObject({ rows: 2, minTimestamp: 0, maxTimestamp: 300_000 })
    expect((await readFile(path, 'utf-8')).split('\n').slice(0, 3)).toEqual([
      'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
      '0,1970-01-01T00:00:00.000Z,100,102,99,101,5,BTC_USDT_USDT,5m,okx',
      '300000,1970-01-01T00:05:00.000Z,100,102,99,101,5,BTC_USDT_USDT,5m,okx',
    ])
  })

  it('rejects duplicates before replacing the last complete file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-materialize-'))
    const path = join(root, 'BTC_USDT_USDT_5m.csv')
    await writeFile(path, 'previous-complete-file\n', 'utf-8')
    await expect(writeCompatibilityCsvAtomic(path, [row(0), row(0)], '5m')).rejects.toThrow('non_monotonic_or_duplicate_timestamp')
    await expect(readFile(path, 'utf-8')).resolves.toBe('previous-complete-file\n')
  })

  it('rejects mixed exchange or timeframe rows', () => {
    expect(() => validateCompatibilityRows([{ ...row(0), exchange: 'binance' as any }], '5m')).toThrow('exchange_mismatch')
    expect(() => validateCompatibilityRows([{ ...row(0), timeframe: '1h' }], '5m')).toThrow('timeframe_mismatch')
  })

  it('treats zone-less DuckDB timestamps as UTC instead of local time', () => {
    expect(parseDuckDbUtcTimestamp('2026-07-20 06:05:00')).toBe(Date.parse('2026-07-20T06:05:00.000Z'))
    expect(parseDuckDbUtcTimestamp('2026-07-20T06:05:00.123')).toBe(Date.parse('2026-07-20T06:05:00.123Z'))
  })

  it('unions sealed uncompacted raw segments into compatibility reads', () => {
    expect(compatibilitySourceRelation([])).toBe('SELECT * FROM okx_market_events')
    const relation = compatibilitySourceRelation(['/tmp/b.jsonl.gz', '/tmp/a.jsonl.gz'])
    expect(relation).toContain('UNION ALL BY NAME')
    expect(relation.indexOf('/tmp/a.jsonl.gz')).toBeLessThan(relation.indexOf('/tmp/b.jsonl.gz'))
    expect(relation).toContain("compression='gzip'")
  })
})
