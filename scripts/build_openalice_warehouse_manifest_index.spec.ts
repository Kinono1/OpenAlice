import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildWarehouseManifestIndexReport,
  parseWarehouseManifestIndexArgs,
  runWarehouseManifestIndex,
} from './build_openalice_warehouse_manifest_index.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_openalice_warehouse_manifest_index', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseWarehouseManifestIndexArgs([
      '--warehouseRoot',
      '/warehouse',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      warehouseRoot: '/warehouse',
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['data:warehouse:manifest-index']).toContain('build_openalice_warehouse_manifest_index.ts')
    expect(scripts['status:research-evidence']).toContain('build_openalice_warehouse_manifest_index.ts')
  })

  it('indexes warehouse evidence manifests and manifest JSONL files without authorizing trading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-warehouse-manifest-index-'))
    const warehouseRoot = join(root, 'warehouse')
    const downloadDir = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-1m')
    const normalizedDir = join(warehouseRoot, 'parquet/derivatives')
    await mkdir(downloadDir, { recursive: true })
    await mkdir(normalizedDir, { recursive: true })
    await writeFile(join(downloadDir, 'manifest.fast-binance-download.jsonl'), [
      JSON.stringify({
        source: 'binance_data_vision',
        symbol: 'BTCUSDT',
        path: 'BTCUSDT-1m-2024-01.zip',
      }),
      JSON.stringify({
        source: 'binance_data_vision',
        symbol: 'ETHUSDT',
        path: 'ETHUSDT-1m-2024-01.zip',
      }),
    ].join('\n'), 'utf-8')
    await writeFile(join(normalizedDir, 'binance_usdm_derivatives_events.normalized.jsonl.manifest.json'), JSON.stringify({
      job: 'normalize_external_derivatives_data',
      artifactPath: join(normalizedDir, 'binance_usdm_derivatives_events.normalized.jsonl'),
      manifestPath: join(normalizedDir, 'binance_usdm_derivatives_events.normalized.jsonl.manifest.json'),
      businessStatus: 'pass',
      evidenceTrust: 'quarantine',
      dqStatus: 'quarantine',
      artifactHash: 'abc123',
    }, null, 2), 'utf-8')

    const report = await buildWarehouseManifestIndexReport({
      warehouseRoot,
      generatedAt: '2026-05-07T05:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T05:00:00.000Z',
      warehouseRoot: resolve(warehouseRoot),
      manifestRoot: resolve(warehouseRoot, 'manifests'),
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'complete',
      summary: {
        manifestFiles: 2,
        evidenceManifestJsonFiles: 1,
        manifestJsonlFiles: 1,
        readableFiles: 2,
        quarantineEvidenceTrustFiles: 1,
      },
      blockers: [],
    })
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'manifest_jsonl',
        parseStatus: 'jsonl',
        lineCount: 2,
      }),
      expect.objectContaining({
        kind: 'evidence_manifest_json',
        parseStatus: 'ok',
        job: 'normalize_external_derivatives_data',
        evidenceTrust: 'quarantine',
      }),
    ]))
  })

  it('blocks empty or invalid manifest files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-warehouse-manifest-index-bad-'))
    const warehouseRoot = join(root, 'warehouse')
    const dir = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-1m')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.fast-binance-download.jsonl'), '', 'utf-8')
    await writeFile(join(dir, 'bad.manifest.json'), 'not-json', 'utf-8')

    const report = await buildWarehouseManifestIndexReport({ warehouseRoot })

    expect(report.status).toBe('blocked')
    expect(report.summary).toMatchObject({
      manifestFiles: 2,
      emptyFiles: 1,
      notJsonFiles: 1,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'warehouse_manifest_empty_files:1',
      'warehouse_manifest_not_json_files:1',
    ]))
  })

  it('writes index artifact and sidecar manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-warehouse-manifest-index-write-'))
    const warehouseRoot = join(root, 'warehouse')
    const dir = join(warehouseRoot, 'market/binance-public/spot-all-usdt-klines-1m')
    const outputPath = join(warehouseRoot, 'manifests/openalice_warehouse_manifest_index.latest.json')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.fast-binance-download.jsonl'), '{}\n', 'utf-8')

    const report = await runWarehouseManifestIndex({
      warehouseRoot,
      outputPath,
      json: false,
    })

    expect(report.status).toBe('complete')
    const persistedRaw = await readFile(outputPath, 'utf-8')
    expect(JSON.parse(persistedRaw)).toMatchObject({
      schemaVersion: 1,
      status: 'complete',
      promotionEligible: false,
      executionAllowed: false,
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'openalice_warehouse_manifest_index',
      artifactPath: outputPath,
      businessStatus: 'pass',
      recordsIn: 1,
      recordsOut: 1,
      artifactHash: sha256Hex(persistedRaw),
    })
  })
})
