import { mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultOkxMarketDataConfig } from '../src/domain/market-data/okx-market-data-config.js'
import type { OkxMarketEvent } from '../src/domain/market-data/okx-warehouse-types.js'
import { appendOkxMarketEvents, listRawSegmentManifests, payloadHash } from './lib/okx_warehouse.js'
import { archiveSealedWarehouse, enrollArchiveVolume, type VolumeInfo } from './lib/okx_ssd_archive.js'
import { runOkxWarehouseRetention } from './run_okx_warehouse_retention.js'

describe('OKX warehouse retention', () => {
  it('deletes only an old, committed, reverified local source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-retention-'))
    const dataRoot = join(root, 'data')
    const warehouseRoot = join(dataRoot, 'warehouse', 'okx')
    const mountPoint = join(root, 'Volumes', 'shield')
    const configPath = join(root, 'config.json')
    const enrollmentPath = join(root, 'enrollment.json')
    const config = { ...defaultOkxMarketDataConfig(), dataRoot, archive: { ...defaultOkxMarketDataConfig().archive, enrollmentPath } }
    await writeFile(configPath, `${JSON.stringify(config)}\n`)
    const payload = { tradeId: '1', px: '100', sz: '1' }
    const event: OkxMarketEvent = { schemaVersion: 'okx_market_event.v1', exchange: 'okx', dataset: 'trade', instrumentType: 'SWAP', instrumentId: 'BTC-USDT-SWAP', instrumentFamily: 'BTC-USDT', symbol: 'BTC-USDT-SWAP', channel: 'trades-all', sourceTransport: 'websocket', sourceEndpoint: 'wss://public/trades-all', eventTime: '2026-07-01T00:00:00Z', availableAt: '2026-07-01T00:00:01Z', ingestedAt: '2026-07-01T00:00:02Z', confirmed: null, sequenceId: '1', checksum: null, collectionRunId: 'retention', universeManifestId: 'u1', dedupKey: 'okx|trade|BTC-USDT-SWAP|1', payloadHash: payloadHash(payload), payload }
    await appendOkxMarketEvents(warehouseRoot, [event])
    const vol: VolumeInfo = { mountPoint, volumeName: 'shield', volumeUuid: 'UUID-R', fileSystem: 'apfs', deviceNode: '/dev/disk9s1', internal: false, network: false, readOnly: false, totalBytes: 500 * 1024 ** 3, freeBytes: 400 * 1024 ** 3 }
    const deps = { inspectVolume: async () => vol, listMountedVolumes: async () => [vol], now: () => new Date(Date.now() + 24 * 60 * 60 * 1000), allowNonVolumesMountForTests: true }
    await enrollArchiveVolume({ mountPoint, config, warehouseRoot, enrollmentPath, dependencies: deps })
    await archiveSealedWarehouse({ config, warehouseRoot, enrollmentPath, minAgeMs: 0, dependencies: deps })
    const before = await listRawSegmentManifests(warehouseRoot)
    await expect(stat(join(warehouseRoot, before[0].manifest.relativePath))).resolves.toBeDefined()
    const report = await runOkxWarehouseRetention(['--configPath', configPath, '--now', '2026-07-20T00:00:00Z'], deps)
    expect(report).toMatchObject({ status: 'complete', eligibleSegments: 1, deletedFiles: 1, errors: [] })
    await expect(stat(join(warehouseRoot, before[0].manifest.relativePath))).rejects.toThrow()
    const after = await listRawSegmentManifests(warehouseRoot)
    expect(after[0].manifest.localDeletedAt).toBe('2026-07-20T00:00:00.000Z')
  })

  it('never deletes when the enrolled SSD is offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-retention-offline-'))
    const dataRoot = join(root, 'data')
    const configPath = join(root, 'config.json')
    await writeFile(configPath, `${JSON.stringify({ enabled: false, dataRoot })}\n`)
    const report = await runOkxWarehouseRetention(['--configPath', configPath])
    expect(report.status).toBe('blocked')
    expect(report.deletedFiles).toBe(0)
  })
})
