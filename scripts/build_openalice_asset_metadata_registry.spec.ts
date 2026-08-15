import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildOpenAliceAssetMetadataRegistry,
  parseOpenAliceAssetMetadataRegistryArgs,
  runOpenAliceAssetMetadataRegistry,
} from './build_openalice_asset_metadata_registry.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openalice-asset-metadata-'))
}

async function writeManifest(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`, 'utf-8')
}

describe('build_openalice_asset_metadata_registry', () => {
  it('parses default paths from warehouse root', () => {
    expect(parseOpenAliceAssetMetadataRegistryArgs([
      '--warehouseRoot',
      '/warehouse',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      warehouseRoot: '/warehouse',
      binanceRoot: '/warehouse/market/binance-public',
      registryPath: '/warehouse/metadata/assets/openalice_asset_registry.latest.json',
      outputPath: null,
      json: true,
    })
  })

  it('derives symbol metadata from local Binance manifest rows without inventing chain fields', async () => {
    const root = await tempRoot()
    const binanceRoot = join(root, 'warehouse/market/binance-public')
    await writeManifest(join(binanceRoot, 'spot-all-usdt-klines-1m/manifest.fast-binance-download.jsonl'), [
      {
        market: 'spot',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        month: '2017-08',
        key: 'data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-08.zip',
        url: 'https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-08.zip',
        status: 'downloaded',
      },
      {
        market: 'spot',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        month: '2017-09',
        key: 'data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-09.zip',
        url: 'https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-09.zip',
        status: 'downloaded',
      },
    ])
    await writeManifest(join(binanceRoot, 'um-all-usdt-klines-1h/manifest.fast-binance-download.jsonl'), [
      {
        market: 'um',
        dataType: 'klines',
        symbol: 'ETHUSDT',
        month: '2019-09',
        key: 'data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2019-09.zip',
        url: 'https://data.binance.vision/data/futures/um/monthly/klines/ETHUSDT/1h/ETHUSDT-1h-2019-09.zip',
        status: 'downloaded',
      },
    ])

    const registry = await buildOpenAliceAssetMetadataRegistry({
      binanceRoot,
      generatedAt: '2026-05-06T00:00:00.000Z',
    })

    expect(registry).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-06T00:00:00.000Z',
      status: 'partial',
      source: {
        manifestFilesRead: 2,
        manifestRowsRead: 3,
        manifestRowsParsed: 3,
      },
      summary: {
        assets: 2,
        spotAssets: 1,
        usdmAssets: 1,
        missingContractAddresses: 2,
        missingDecimals: 2,
        earliestObservedMonth: '2017-08',
        latestObservedMonth: '2019-09',
      },
    })
    expect(registry.entries.find(entry => entry.assetId === 'binance:spot:BTCUSDT')).toMatchObject({
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      canonicalSymbol: 'BTC/USDT',
      firstDataMonth: '2017-08',
      lastDataMonth: '2017-09',
      listingDate: '2017-08-01',
      contractAddress: null,
      decimals: null,
      timeframes: ['1m'],
      blockers: expect.arrayContaining([
        'contract_address_unknown',
        'decimals_unknown',
      ]),
    })
  })

  it('writes warehouse registry, registry manifest, runtime report, and report manifest', async () => {
    const root = await tempRoot()
    const warehouseRoot = join(root, 'warehouse')
    const binanceRoot = join(warehouseRoot, 'market/binance-public')
    const registryPath = join(warehouseRoot, 'metadata/assets/openalice_asset_registry.latest.json')
    const outputPath = join(root, 'repo-data/runtime/openalice_asset_metadata_registry.latest.json')
    await writeManifest(join(binanceRoot, 'spot-all-usdt-klines-1m/manifest.fast-binance-download.jsonl'), [
      {
        market: 'spot',
        dataType: 'klines',
        symbol: 'BTCUSDT',
        month: '2017-08',
        key: 'data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-08.zip',
        url: 'https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2017-08.zip',
      },
    ])

    const report = await runOpenAliceAssetMetadataRegistry({
      warehouseRoot,
      binanceRoot,
      registryPath,
      outputPath,
      json: true,
    })

    expect(report.status).toBe('partial')
    const registryRaw = await readFile(registryPath, 'utf-8')
    const reportRaw = await readFile(outputPath, 'utf-8')
    const registryManifest = JSON.parse(await readFile(`${registryPath}.manifest.json`, 'utf-8'))
    const reportManifest = JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))
    expect(JSON.parse(registryRaw)).toMatchObject({
      status: 'partial',
      summary: {
        assets: 1,
      },
    })
    expect(registryManifest).toMatchObject({
      job: 'openalice_asset_metadata_registry_warehouse',
      artifactPath: registryPath,
      businessStatus: 'warn',
    })
    expect(reportManifest).toMatchObject({
      job: 'openalice_asset_metadata_registry_report',
      artifactPath: outputPath,
      businessStatus: 'warn',
    })
    expect(registryManifest.artifactHash).toBe(sha256Hex(registryRaw))
    expect(reportManifest.artifactHash).toBe(sha256Hex(reportRaw))
  })
})
