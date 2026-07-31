import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildNormalizedWarehouseIndexReport,
  parseNormalizedWarehouseIndexArgs,
  runNormalizedWarehouseIndex,
} from './build_openalice_normalized_warehouse_index.js'

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('build_openalice_normalized_warehouse_index', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseNormalizedWarehouseIndexArgs([
      '--warehouseRoot',
      '/warehouse',
      '--normalizedRoot',
      '/warehouse/custom-normalized',
      '--output',
      'null',
      '--json',
    ])).toEqual({
      warehouseRoot: '/warehouse',
      normalizedRoot: '/warehouse/custom-normalized',
      outputPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['data:warehouse:normalized-index']).toContain('build_openalice_normalized_warehouse_index.ts')
    expect(scripts['status:research-evidence']).toContain('build_openalice_normalized_warehouse_index.ts')
  })

  it('indexes PIT-safe normalized rows without authorizing trading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-normalized-index-'))
    const warehouseRoot = join(root, 'warehouse')
    const normalizedRoot = join(warehouseRoot, 'parquet')
    const derivativesDir = join(normalizedRoot, 'derivatives')
    await mkdir(derivativesDir, { recursive: true })
    const path = join(derivativesDir, 'binance_usdm_derivatives_events.normalized.jsonl')
    await writeFile(path, `${JSON.stringify({
      schemaVersion: 'openalice.external_derivatives.normalized.v1',
      sourceEndpoint: '/fapi/v1/fundingRate',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      eventTime: '2026-05-05T00:00:00.000Z',
      fetchedAt: '2026-05-05T00:00:01.000Z',
      observedAt: '2026-05-05T00:00:01.500Z',
      availableAt: '2026-05-05T00:00:02.000Z',
      ingestedAt: '2026-05-05T00:00:02.000Z',
      jobId: 'normalize_external_derivatives_data',
      lineageStatus: 'explicit_row_lineage',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })}\n`, 'utf-8')
    await writeFile(`${path}.manifest.json`, JSON.stringify({
      job: 'normalize_external_derivatives_data',
      artifactPath: path,
      businessStatus: 'pass',
      evidenceTrust: 'quarantine',
      dqStatus: 'quarantine',
    }, null, 2), 'utf-8')

    const report = await buildNormalizedWarehouseIndexReport({
      warehouseRoot,
      generatedAt: '2026-05-07T06:00:00.000Z',
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-07T06:00:00.000Z',
      warehouseRoot: resolve(warehouseRoot),
      normalizedRoot: resolve(normalizedRoot),
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      status: 'blocked',
      coverageStatus: 'complete',
      pitReadinessStatus: 'blocked',
      summary: {
        normalizedFiles: 1,
        jsonlFiles: 1,
        filesWithSidecarManifest: 1,
        quarantineEvidenceTrustFiles: 1,
        pitContractCompleteFiles: 1,
        pitContractCoveragePct: 100,
      },
      blockers: ['normalized_warehouse_evidence_trust_quarantine:1'],
    })
    expect(report.entries[0]).toMatchObject({
      manifestPresent: true,
      evidenceTrust: 'quarantine',
      pitContractComplete: true,
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })
  })

  it('blocks missing manifests and incomplete PIT fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-normalized-index-blocked-'))
    const warehouseRoot = join(root, 'warehouse')
    const normalizedRoot = join(warehouseRoot, 'parquet/onchain')
    await mkdir(normalizedRoot, { recursive: true })
    await writeFile(join(normalizedRoot, 'asset_metrics_1d.normalized.jsonl'), `${JSON.stringify({
      schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1',
      asset: 'btc',
      time: '2010-01-01T00:00:00.000Z',
      availableAt: '2010-01-01T00:00:00.000Z',
    })}\n`, 'utf-8')

    const report = await buildNormalizedWarehouseIndexReport({ warehouseRoot })

    expect(report.status).toBe('blocked')
    expect(report.summary).toMatchObject({
      normalizedFiles: 1,
      filesWithSidecarManifest: 0,
      pitContractCompleteFiles: 0,
    })
    expect(report.blockers).toEqual(expect.arrayContaining([
      'normalized_warehouse_manifest_coverage_low:0/1',
      'normalized_warehouse_field_coverage_low:pit_contract:0<100',
      'normalized_warehouse_field_coverage_low:exchange:0<100',
      'normalized_warehouse_field_coverage_low:observedOrFetchedAt:0<100',
    ]))
  })

  it('separates an expected empty AI candidate placeholder from active normalized data failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-normalized-index-placeholder-'))
    const warehouseRoot = join(root, 'warehouse')
    const normalizedRoot = join(warehouseRoot, 'normalized')
    const activePath = join(normalizedRoot, 'derivatives/okx.normalized.jsonl')
    const placeholderPath = join(normalizedRoot, 'research/ai_scientist/openalice_pit_inputs.sample.normalized.jsonl')
    await mkdir(join(normalizedRoot, 'derivatives'), { recursive: true })
    await mkdir(join(normalizedRoot, 'research/ai_scientist'), { recursive: true })
    await writeFile(activePath, `${JSON.stringify({
      schemaVersion: 1,
      source: 'okx',
      exchange: 'okx',
      symbol: 'BTCUSDT',
      eventTime: '2026-05-05T00:00:00.000Z',
      observedAt: '2026-05-05T00:00:01.000Z',
      availableAt: '2026-05-05T00:00:01.000Z',
      generatedAt: '2026-05-05T00:00:01.000Z',
      jobId: 'normalize_okx',
      quality: { promotionGrade: false },
    })}\n`, 'utf-8')
    await writeFile(`${activePath}.manifest.json`, JSON.stringify({
      job: 'normalize_okx',
      recordsOut: 1,
      businessStatus: 'pass',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
    }), 'utf-8')
    await writeFile(placeholderPath, '', 'utf-8')
    await writeFile(`${placeholderPath}.manifest.json`, JSON.stringify({
      job: 'ai_scientist_openalice_pit_input_rows',
      recordsOut: 0,
      businessStatus: 'fail',
      evidenceTrust: 'fail',
      dqStatus: 'fail',
      errorClass: 'ai_scientist_pit_input_rows_missing',
    }), 'utf-8')

    const report = await buildNormalizedWarehouseIndexReport({
      warehouseRoot,
      normalizedRoot,
    })

    expect(report.coverageStatus).toBe('complete')
    expect(report.summary).toMatchObject({
      normalizedFiles: 2,
      sampledFiles: 1,
      emptyFiles: 0,
      failEvidenceTrustFiles: 0,
      candidatePlaceholderFiles: 1,
      pitContractCompleteFiles: 1,
      pitContractCoveragePct: 100,
    })
    expect(report.blockers).toEqual([
      'ai_scientist_normalized_candidate_placeholder_missing_rows:1',
    ])
    expect(report.entries.find(entry => entry.path === placeholderPath)).toMatchObject({
      sampleStatus: 'empty',
      artifactLifecycle: 'candidate_placeholder',
      runtimeBlocking: false,
      evidenceTrust: 'fail',
    })
  })

  it('writes index artifact and sidecar manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-normalized-index-write-'))
    const warehouseRoot = join(root, 'warehouse')
    const normalizedRoot = join(warehouseRoot, 'parquet/research')
    const outputPath = join(warehouseRoot, 'manifests/openalice_normalized_warehouse_index.latest.json')
    await mkdir(normalizedRoot, { recursive: true })
    const dataPath = join(normalizedRoot, 'openalice_okx_public_ohlcv_pit_rows.research_only.jsonl')
    await writeFile(dataPath, `${JSON.stringify({
      schemaVersion: 1,
      sourceType: 'okx_public_market_candles',
      exchange: 'okx',
      symbol: 'BTC_USDT_USDT',
      eventTime: '2026-05-05T18:35:00.000Z',
      observedAt: '2026-05-06T19:30:26.546Z',
      availableAt: '2026-05-06T19:30:26.546Z',
      generatedAt: '2026-05-06T19:30:26.045Z',
      jobId: 'okx_public_ohlcv_5m_collector',
      researchOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
    })}\n`, 'utf-8')
    await writeFile(`${dataPath}.manifest.json`, JSON.stringify({
      job: 'okx_public_ohlcv_5m_collector',
      artifactPath: dataPath,
      businessStatus: 'pass',
      evidenceTrust: 'pass',
      dqStatus: 'pass',
    }, null, 2), 'utf-8')

    const report = await runNormalizedWarehouseIndex({
      warehouseRoot,
      normalizedRoot: join(warehouseRoot, 'parquet'),
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
      job: 'openalice_normalized_warehouse_index',
      artifactPath: outputPath,
      businessStatus: 'pass',
      recordsIn: 1,
      recordsOut: 1,
      artifactHash: sha256Hex(persistedRaw),
    })
  })
})
