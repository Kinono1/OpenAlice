import { describe, expect, it } from 'vitest'
import {
  buildCollectionRunId,
  buildDownloadManifestRecord,
  candidateEntry,
  dataTypeUsesTimeframe,
  type RecordLine,
} from './fast_binance_data_vision_backfill.js'

describe('fast_binance_data_vision_backfill manifest lineage', () => {
  it('writes archive-file lineage that is explicit but not promotion-grade row PIT', () => {
    const record: RecordLine = {
      market: 'um',
      dataType: 'klines',
      symbol: 'BTCUSDT',
      month: '2025-01',
      key: 'data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
      url: 'https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h/BTCUSDT-1h-2025-01.zip',
      zipPath: '/tmp/BTCUSDT-1h-2025-01.zip',
      status: 'downloaded',
      httpStatus: 200,
    }

    const manifestRecord = buildDownloadManifestRecord(record, {
      generatedAt: '2026-05-06T16:05:00.000Z',
      jobId: 'fast_binance_data_vision_backfill',
      collectionRunId: 'fast_binance_data_vision_backfill:test',
    })

    expect(manifestRecord).toMatchObject({
      ...record,
      schemaVersion: 'openalice.binance_data_vision.download_manifest.v2',
      generatedAt: '2026-05-06T16:05:00.000Z',
      jobId: 'fast_binance_data_vision_backfill',
      collectionRunId: 'fast_binance_data_vision_backfill:test',
      collectorObservedAt: '2026-05-06T16:05:00.000Z',
      observedAt: '2026-05-06T16:05:00.000Z',
      fetchedAt: '2026-05-06T16:05:00.000Z',
      availableAt: '2026-05-06T16:05:00.000Z',
      archiveFileAvailableAt: '2026-05-06T16:05:00.000Z',
      archiveLineageStatus: 'available',
      sourceEndpoint: 'https://data.binance.vision',
      sourceUrl: record.url,
      sourcePath: record.key,
      sourceManifestId: expect.stringMatching(/^binance_data_vision:um:klines:BTCUSDT:2025-01:/),
      sourceRowHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceRowHashScope: 'archive_manifest_record',
      lineageScope: 'archive_file',
      pitSuitability: 'archive_download_lineage_only_not_row_pit',
      rowPITUsableForPromotion: false,
    })
  })

  it('keeps missing or failed archive records non-available', () => {
    const baseRecord = {
      market: 'um' as const,
      dataType: 'klines' as const,
      symbol: 'ETHUSDT',
      month: '2025-01',
      key: 'data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2025-01.zip',
      url: 'https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2025-01.zip',
      zipPath: '/tmp/ETHUSDT-1h-2025-01.zip',
    }

    expect(buildDownloadManifestRecord({
      ...baseRecord,
      status: 'missing',
      httpStatus: 404,
    }, {
      generatedAt: '2026-05-06T16:06:00.000Z',
      jobId: 'fast_binance_data_vision_backfill',
      collectionRunId: 'fast_binance_data_vision_backfill:test',
    })).toMatchObject({
      archiveLineageStatus: 'missing',
      fetchedAt: null,
      availableAt: null,
      archiveFileAvailableAt: null,
      rowPITUsableForPromotion: false,
    })

    expect(buildDownloadManifestRecord({
      ...baseRecord,
      status: 'failed',
      error: 'curl failed',
    }, {
      generatedAt: '2026-05-06T16:07:00.000Z',
      jobId: 'fast_binance_data_vision_backfill',
      collectionRunId: 'fast_binance_data_vision_backfill:test',
    })).toMatchObject({
      archiveLineageStatus: 'failed',
      fetchedAt: null,
      availableAt: null,
      archiveFileAvailableAt: null,
      rowPITUsableForPromotion: false,
    })
  })

  it('builds deterministic collection run ids from download scope', () => {
    const scope = {
      market: 'um' as const,
      dataType: 'klines' as const,
      timeframe: '1h',
      startMonth: '2025-01',
      endMonth: '2025-02',
      outDir: '/Volumes/shield/cryptoData/openalice-data/market/binance-public/um-all-usdt-klines-1h',
      retryManifest: undefined,
    }

    expect(buildCollectionRunId(scope, '2026-05-06T16:08:00.000Z')).toBe(
      buildCollectionRunId(scope, '2026-05-06T16:08:00.000Z'),
    )
    expect(buildCollectionRunId(scope, '2026-05-06T16:08:00.000Z')).toMatch(
      /^fast_binance_data_vision_backfill:[a-f0-9]{20}$/,
    )
  })

  it('treats premiumIndexKlines as a timeframe dataset when building Data Vision keys', () => {
    expect(dataTypeUsesTimeframe('premiumIndexKlines')).toBe(true)

    expect(candidateEntry({
      market: 'um',
      dataType: 'premiumIndexKlines',
      timeframe: '1h',
      startMonth: '2026-04',
      endMonth: '2026-04',
    }, 'BTCUSDT', '2026-04')).toMatchObject({
      key: 'data/futures/um/monthly/premiumIndexKlines/BTCUSDT/1h/BTCUSDT-1h-2026-04.zip',
    })
  })
})
