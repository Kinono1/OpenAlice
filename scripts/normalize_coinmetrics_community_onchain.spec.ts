import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNormalizeCoinMetricsArgs, runNormalizeCoinMetricsOnchain } from './normalize_coinmetrics_community_onchain.js'

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'openalice-coinmetrics-normalize-'))
}

describe('normalize_coinmetrics_community_onchain', () => {
  it('parses cli args', () => {
    expect(parseNormalizeCoinMetricsArgs(['--input', '/tmp/in.jsonl', '--output', '/tmp/out.jsonl', '--report', 'null', '--json'])).toEqual({
      inputPath: '/tmp/in.jsonl',
      outputPath: '/tmp/out.jsonl',
      reportPath: null,
      json: true,
    })
  })

  it('uses OPENALICE_DATA_ROOT for local canonical defaults', () => {
    const previous = process.env.OPENALICE_DATA_ROOT
    process.env.OPENALICE_DATA_ROOT = '/local/openalice-data'
    try {
      expect(parseNormalizeCoinMetricsArgs([])).toEqual({
        inputPath: '/local/openalice-data/onchain/coinmetrics/asset_metrics_1d.jsonl',
        outputPath: '/local/openalice-data/normalized/onchain/coinmetrics/asset_metrics_1d.normalized.jsonl',
        reportPath: join(process.cwd(), 'data/runtime/openalice_coinmetrics_onchain_normalize.latest.json'),
        json: false,
      })
    } finally {
      if (previous == null) delete process.env.OPENALICE_DATA_ROOT
      else process.env.OPENALICE_DATA_ROOT = previous
    }
  })

  it('normalizes raw coinmetrics envelopes into warehouse rows', async () => {
    const root = await tempRoot()
    const inputPath = join(root, 'asset_metrics_1d.jsonl')
    const outputPath = join(root, 'normalized.jsonl')
    const reportPath = join(root, 'runtime/report.json')
    await writeFile(inputPath, [
      JSON.stringify({ schemaVersion: 'coinmetrics_community_asset_metric.v1', source: 'coinmetrics_community', ingestedAt: '2026-05-06T00:00:00.000Z', frequency: '1d', payload: { asset: 'btc', time: '2026-05-01T00:00:00.000Z', PriceUSD: '60000.25' } }),
      JSON.stringify({ schemaVersion: 'coinmetrics_community_asset_metric.v1', source: 'coinmetrics_community', ingestedAt: '2026-05-06T00:00:00.000Z', frequency: '1d', payload: { asset: 'eth', time: '2026-05-01T00:00:00.000Z', TxCnt: 12345 } }),
    ].join('\n') + '\n', 'utf-8')

    const report = await runNormalizeCoinMetricsOnchain({ inputPath, outputPath, reportPath, json: true })
    expect(report).toMatchObject({
      status: 'complete',
      rowsRead: 2,
      rowsNormalized: 2,
      rowsDropped: 0,
      assets: ['btc', 'eth'],
      metrics: ['PriceUSD', 'TxCnt'],
    })
    const persistedRows = (await readFile(outputPath, 'utf-8')).trim().split('\n').map(line => JSON.parse(line))
    expect(persistedRows[0]).toMatchObject({
      schemaVersion: 'openalice.coinmetrics.asset_metric.normalized.v1',
      source: 'coinmetrics_community',
      sourceEndpoint: '/timeseries/asset-metrics',
      exchange: 'coinmetrics',
      symbol: expect.any(String),
      eventTime: '2026-05-01T00:00:00.000Z',
      fetchedAt: '2026-05-06T00:00:00.000Z',
      observedAt: '2026-05-06T00:00:00.000Z',
      availableAt: '2026-05-06T00:00:00.000Z',
      ingestedAt: '2026-05-06T00:00:00.000Z',
      jobId: 'coinmetrics_community_onchain_normalize',
      lineageStatus: 'explicit_raw_envelope_lineage',
      quality: {
        promotionGrade: false,
        blockers: [
          'coinmetrics_community_research_only_not_execution_evidence',
          'onchain_rows_require_strategy_specific_pit_join_audit',
        ],
      },
    })
    expect(persistedRows[0].availableAtMs).toBe(Date.parse('2026-05-06T00:00:00.000Z'))
    expect(persistedRows[0].availableAtMs).toBeGreaterThan(persistedRows[0].eventTimeMs)
    const reportArtifact = JSON.parse(await readFile(reportPath, 'utf-8'))
    expect(reportArtifact.status).toBe('complete')
  })
})
