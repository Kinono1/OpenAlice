import { describe, expect, it } from 'vitest'
import { parseCoinMetricsOnchainArgs } from './collect_coinmetrics_community_onchain.js'

describe('collect_coinmetrics_community_onchain', () => {
  it('uses OPENALICE_DATA_ROOT for the canonical raw output', () => {
    const previous = process.env.OPENALICE_DATA_ROOT
    process.env.OPENALICE_DATA_ROOT = '/local/openalice-data'
    try {
      expect(parseCoinMetricsOnchainArgs([])).toMatchObject({
        warehouseRoot: '/local/openalice-data',
        outputPath: '/local/openalice-data/onchain/coinmetrics/asset_metrics_1d.jsonl',
        reportPath: 'data/runtime/openalice_coinmetrics_onchain_collect.latest.json',
        baseUrl: 'https://community-api.coinmetrics.io/v4',
        assets: ['btc', 'eth'],
        frequency: '1d',
        json: false,
      })
    } finally {
      if (previous == null) delete process.env.OPENALICE_DATA_ROOT
      else process.env.OPENALICE_DATA_ROOT = previous
    }
  })

  it('allows an explicit offline data root without changing the runtime report path', () => {
    expect(parseCoinMetricsOnchainArgs([
      '--dataRoot', '/offline/openalice-data',
      '--report', 'null',
      '--json',
    ])).toMatchObject({
      warehouseRoot: '/offline/openalice-data',
      outputPath: '/offline/openalice-data/onchain/coinmetrics/asset_metrics_1d.jsonl',
      reportPath: null,
      json: true,
    })
  })
})
