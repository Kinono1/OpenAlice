import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OkxMarketEvent } from '../../src/domain/market-data/okx-warehouse-types.js'
import {
  appendOkxMarketEvents,
  buildStoragePressureStatus,
  listRawSegmentManifests,
  payloadHash,
  readRawSegmentEvents,
  stableJson,
} from './okx_warehouse.js'

function event(overrides: Partial<OkxMarketEvent> = {}): OkxMarketEvent {
  const payload = overrides.payload ?? { last: '100', bidPx: '99', askPx: '101' }
  return {
    schemaVersion: 'okx_market_event.v1',
    exchange: 'okx',
    dataset: 'ticker',
    instrumentType: 'SWAP',
    instrumentId: 'BTC-USDT-SWAP',
    instrumentFamily: 'BTC-USDT',
    symbol: 'BTC-USDT-SWAP',
    channel: 'tickers',
    sourceTransport: 'rest',
    sourceEndpoint: '/api/v5/market/tickers',
    eventTime: '2026-07-18T00:00:00.000Z',
    availableAt: '2026-07-18T00:00:01.000Z',
    ingestedAt: '2026-07-18T00:00:02.000Z',
    confirmed: null,
    sequenceId: null,
    checksum: null,
    collectionRunId: 'test-run',
    universeManifestId: null,
    dedupKey: 'okx|ticker|BTC-USDT-SWAP|2026-07-18T00:00:00.000Z',
    payloadHash: payloadHash(payload),
    payload,
    ...overrides,
  }
}

describe('okx_warehouse', () => {
  it('uses canonical stable JSON for payload hashes', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}')
    expect(payloadHash({ b: 2, a: 1 })).toBe(payloadHash({ a: 1, b: 2 }))
  })

  it('writes immutable gzip segments and skips exact duplicates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-wh-'))
    const first = await appendOkxMarketEvents(root, [event()])
    expect(first.writtenRows).toBe(1)
    const second = await appendOkxMarketEvents(root, [event({ collectionRunId: 'test-run-2' })])
    expect(second).toMatchObject({ writtenRows: 0, duplicateRows: 1, conflictingDuplicateRows: 0 })
    const manifests = await listRawSegmentManifests(root)
    expect(manifests).toHaveLength(1)
    const rows = await readRawSegmentEvents(root, manifests[0].manifest)
    expect(rows).toHaveLength(1)
    expect(rows[0].instrumentId).toBe('BTC-USDT-SWAP')
  })

  it('quarantines conflicting duplicate payloads instead of overwriting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-conflict-'))
    await appendOkxMarketEvents(root, [event()])
    const incoming = event({ payload: { last: '110' }, payloadHash: payloadHash({ last: '110' }), collectionRunId: 'conflict' })
    const result = await appendOkxMarketEvents(root, [incoming])
    expect(result).toMatchObject({ writtenRows: 0, conflictingDuplicateRows: 1 })
    expect(result.conflictPaths).toHaveLength(1)
    const conflict = JSON.parse(await readFile(result.conflictPaths[0], 'utf-8'))
    expect(conflict.existingPayloadHash).not.toBe(conflict.incomingPayloadHash)
  })

  it('reports storage pressure without deleting data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-pressure-'))
    const report = await buildStoragePressureStatus({ warehouseRoot: root })
    expect(report.warehouseBytes).toBe(0)
    expect(report.anyMarketWritesAllowed).toBe(true)
  })

  it('enforces the 30 GiB hard stop and resume hysteresis', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-pressure-'))
    const gib = 1024 ** 3
    const emergency = await buildStoragePressureStatus({
      warehouseRoot: root,
      filesystemFreeBytesOverride: 100 * gib,
      warehouseBytesOverride: 30 * gib,
    })
    expect(emergency).toMatchObject({ status: 'emergency_storage_stop', anyMarketWritesAllowed: false })

    const notRecovered = await buildStoragePressureStatus({
      warehouseRoot: root,
      filesystemFreeBytesOverride: 24 * gib,
      warehouseBytesOverride: 25 * gib,
      archiveBacklogBytes: 3 * gib,
      previousStatus: 'degraded_storage_pressure',
    })
    expect(notRecovered.highFrequencyAllowed).toBe(false)

    const recovered = await buildStoragePressureStatus({
      warehouseRoot: root,
      filesystemFreeBytesOverride: 25 * gib,
      warehouseBytesOverride: 25 * gib,
      archiveBacklogBytes: 1 * gib,
      previousStatus: 'degraded_storage_pressure',
    })
    expect(recovered.highFrequencyAllowed).toBe(true)
  })

  it('rejects private websocket event envelopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-okx-private-'))
    await expect(appendOkxMarketEvents(root, [event({ sourceTransport: 'websocket', channel: 'private-orders' })]))
      .rejects.toThrow('private OKX WebSocket channels are forbidden')
  })
})
