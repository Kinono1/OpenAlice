import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { compactOkxWarehouse } from './compact_okx_warehouse.js'
import { archiveSealedWarehouse, enrollArchiveVolume, type VolumeInfo } from './lib/okx_ssd_archive.js'
import { appendOkxMarketEvents, payloadHash } from './lib/okx_warehouse.js'
import { queryOkxWarehouse } from './query_okx_warehouse.js'

function volume(mountPoint: string): VolumeInfo {
  return { mountPoint, volumeName: 'shield', volumeUuid: 'UUID-query', fileSystem: 'apfs', deviceNode: '/dev/disk9s1', internal: false, network: false, readOnly: false, totalBytes: 500 * 1024 ** 3, freeBytes: 400 * 1024 ** 3 }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'oa-okx-query-'))
  const dataRoot = join(root, 'data')
  const warehouseRoot = join(dataRoot, 'warehouse', 'okx')
  const enrollmentPath = join(root, 'enrollment.json')
  const configPath = join(root, 'config.json')
  const defaults = (await import('../src/domain/market-data/okx-market-data-config.js')).defaultOkxMarketDataConfig()
  await writeFile(configPath, `${JSON.stringify({ ...defaults, dataRoot, archive: { ...defaults.archive, enrollmentPath } })}\n`)
  const payload = { bar: '5m', open: '100', high: '101', low: '99', close: '100.5', volume: '10' }
  const event: OkxMarketEvent = {
    schemaVersion: 'okx_market_event.v1', exchange: 'okx', dataset: 'candle', instrumentType: 'SWAP',
    instrumentId: 'BTC-USDT-SWAP', instrumentFamily: 'BTC-USDT', symbol: 'BTC-USDT-SWAP', channel: 'candle5m',
    sourceTransport: 'rest', sourceEndpoint: '/api/v5/market/candles', eventTime: '2026-07-01T00:00:00.000Z',
    availableAt: '2026-07-01T00:00:01.000Z', ingestedAt: '2026-07-01T00:00:02.000Z', confirmed: true,
    sequenceId: null, checksum: null, collectionRunId: 'query-test', universeManifestId: null,
    dedupKey: 'okx|candle|BTC-USDT-SWAP|5m|2026-07-01T00:00:00.000Z', payloadHash: payloadHash(payload), payload,
  }
  await appendOkxMarketEvents(warehouseRoot, [event])
  await compactOkxWarehouse(['--configPath', configPath, '--allowDisabled', 'true'])
  const mountPoint = join(root, 'Volumes', 'shield')
  const deps = { inspectVolume: async () => volume(mountPoint), listMountedVolumes: async () => [volume(mountPoint)], now: () => new Date(Date.now() + 24 * 60 * 60 * 1000), allowNonVolumesMountForTests: true }
  return { root, dataRoot, warehouseRoot, enrollmentPath, configPath, mountPoint, deps }
}

describe('query_okx_warehouse', () => {
  it('queries hot parquet with explicit coverage and PIT fields', async () => {
    const fx = await fixture()
    const report = await queryOkxWarehouse(['--configPath', fx.configPath, '--dataset', 'candle', '--from', '2026-07-01', '--to', '2026-07-01'], { ...fx.deps, listMountedVolumes: async () => [] })
    expect(report).toMatchObject({ status: 'complete', hotFiles: 1, coldFiles: 0, coveredDates: ['2026-07-01'], missingDates: [], rows: 1 })
    expect(report.events[0]).toMatchObject({ exchange: 'okx', eventTime: '2026-07-01T00:00:00.000Z', availableAt: '2026-07-01T00:00:01.000Z', _sourceLocation: 'hot' })
  })

  it('fails closed when the request exceeds local coverage and cold storage is offline', async () => {
    const fx = await fixture()
    const report = await queryOkxWarehouse(['--configPath', fx.configPath, '--dataset', 'candle', '--from', '2026-06-30', '--to', '2026-07-01'], { ...fx.deps, listMountedVolumes: async () => [] })
    expect(report).toMatchObject({ status: 'blocked_cold_storage_offline', rows: 0, events: [], missingDates: ['2026-06-30'] })
  })

  it('unions committed cold parquet and deduplicates the hot copy', async () => {
    const fx = await fixture()
    const config = (await import('../src/domain/market-data/okx-market-data-config.js')).defaultOkxMarketDataConfig()
    const configured = { ...config, dataRoot: fx.dataRoot, archive: { ...config.archive, enrollmentPath: fx.enrollmentPath } }
    await mkdir(fx.mountPoint, { recursive: true })
    await enrollArchiveVolume({ mountPoint: fx.mountPoint, config: configured, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, dependencies: fx.deps })
    const archived = await archiveSealedWarehouse({ config: configured, warehouseRoot: fx.warehouseRoot, enrollmentPath: fx.enrollmentPath, minAgeMs: 0, dependencies: fx.deps })
    expect(archived.status.status).toBe('archive_complete')
    const report = await queryOkxWarehouse(['--configPath', fx.configPath, '--dataset', 'candle', '--from', '2026-07-01', '--to', '2026-07-01'], fx.deps)
    expect(report).toMatchObject({ status: 'complete', hotFiles: 1, coldFiles: 1, rows: 1 })
    expect(report.events[0]?._sourceLocation).toBe('hot')
    expect(JSON.parse(await readFile(fx.enrollmentPath, 'utf-8')).volume.archiveId).toBeTruthy()
  })
})
