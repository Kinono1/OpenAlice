import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  materializeRowsFromArchiveCsvs,
  parseMaterializeEthCarryDataVisionDerivativesArgs,
} from './materialize_eth_carry_data_vision_derivatives.js'

describe('materialize_eth_carry_data_vision_derivatives', () => {
  it('parses defaults and keeps package scripts wired research-only', () => {
    expect(parseMaterializeEthCarryDataVisionDerivativesArgs([
      '--warehouseRoot',
      '/tmp/warehouse',
      '--output',
      '/tmp/out.jsonl',
      '--report',
      'none',
      '--json',
    ])).toMatchObject({
      warehouseRoot: '/tmp/warehouse',
      outputPath: '/tmp/out.jsonl',
      reportPath: null,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:materialize-data-vision-derivatives']).toContain('materialize_eth_carry_data_vision_derivatives.ts')
    expect(scripts['status:research-evidence']).toContain('materialize_eth_carry_data_vision_derivatives.ts')
    expect(scripts['status:research-evidence']).toContain('build_eth_carry_pit_feature_dataset.ts')
  })

  it('materializes funding and basis rows from Data Vision CSV inputs without promotion authorization', () => {
    const generatedAt = '2026-05-06T22:00:00.000Z'
    const rows = materializeRowsFromArchiveCsvs({
      generatedAt,
      reportPath: '/repo/data/runtime/materialize.latest.json',
      manifestRecords: [
        manifest('fundingRate', 'BTCUSDT', '2026-04'),
        manifest('fundingRate', 'ETHUSDT', '2026-04'),
        manifest('markPriceKlines', 'BTCUSDT', '2026-04'),
        manifest('markPriceKlines', 'ETHUSDT', '2026-04'),
        manifest('indexPriceKlines', 'BTCUSDT', '2026-04'),
        manifest('indexPriceKlines', 'ETHUSDT', '2026-04'),
        manifest('premiumIndexKlines', 'BTCUSDT', '2026-04'),
        manifest('premiumIndexKlines', 'ETHUSDT', '2026-04'),
      ],
      readCsvText: zipPath => csvByZipPath(zipPath),
    })

    expect(rows.counts).toMatchObject({
      archiveManifests: 4,
      archiveZipFiles: 8,
      fundingArchiveRows: 2,
      markKlineRows: 2,
      indexKlineRows: 2,
      premiumKlineRows: 2,
      normalizedFundingRows: 2,
      normalizedBasisRows: 2,
      normalizedRows: 4,
    })
    expect(rows.rows.every(row => row.rowPITUsableForPromotion === false)).toBe(true)
    expect(rows.rows.map(row => row.endpointId).sort()).toEqual([
      'fundingRate',
      'fundingRate',
      'premiumIndex',
      'premiumIndex',
    ])
    expect(rows.rows.find(row => row.endpointId === 'premiumIndex' && row.symbol === 'ETHUSDT')).toMatchObject({
      sourceEndpoint: '/fapi/v1/premiumIndex',
      sourceTimestampBasis: 'data_vision_premium_mark_index_kline_close_time_research_proxy',
      availableAt: '2024-04-01T00:59:59.999Z',
      availableAtBasis: 'derived_archive_event_available_time_research_proxy',
      pitSuitability: 'archive_event_time_research_proxy_not_promotion_grade',
      reportPath: '/repo/data/runtime/materialize.latest.json',
      manifestPath: '/tmp/manifest-premiumIndexKlines.jsonl',
      fields: {
        markPrice: 3200,
        indexPrice: 3198,
        lastFundingRate: -0.00002,
        nextFundingTime: null,
        premiumIndexClose: 0.0002,
      },
    })
  })
})

function manifest(dataType: 'fundingRate' | 'markPriceKlines' | 'indexPriceKlines' | 'premiumIndexKlines', symbol: string, month: string) {
  return {
    market: 'um',
    dataType,
    symbol,
    month,
    key: `data/futures/um/monthly/${dataType}/${symbol}/${symbol}-${dataType}-${month}.zip`,
    url: `https://data.binance.vision/${symbol}-${dataType}-${month}.zip`,
    zipPath: `/tmp/${symbol}-${dataType}-${month}.zip`,
    status: 'downloaded',
    collectorObservedAt: '2026-05-06T21:00:00.000Z',
    archiveAvailableAt: '2026-05-06T21:00:00.000Z',
    sourceUrl: `https://data.binance.vision/${symbol}-${dataType}-${month}.zip`,
    sourcePath: `data/futures/um/monthly/${dataType}/${symbol}/${symbol}-${dataType}-${month}.zip`,
    collectionRunId: `run-${dataType}`,
    manifestPath: `/tmp/manifest-${dataType}.jsonl`,
  }
}

function csvByZipPath(zipPath: string): string {
  if (zipPath.includes('fundingRate') && zipPath.includes('BTCUSDT')) {
    return [
      'calc_time,funding_interval_hours,last_funding_rate',
      '1711929600000,8,0.00001',
      '',
    ].join('\n')
  }
  if (zipPath.includes('fundingRate') && zipPath.includes('ETHUSDT')) {
    return [
      'calc_time,funding_interval_hours,last_funding_rate',
      '1711929600000,8,-0.00002',
      '',
    ].join('\n')
  }
  if (zipPath.includes('markPriceKlines') && zipPath.includes('BTCUSDT')) return klineCsv(1711929600000, 70000)
  if (zipPath.includes('markPriceKlines') && zipPath.includes('ETHUSDT')) return klineCsv(1711929600000, 3200)
  if (zipPath.includes('indexPriceKlines') && zipPath.includes('BTCUSDT')) return klineCsv(1711929600000, 69950)
  if (zipPath.includes('indexPriceKlines') && zipPath.includes('ETHUSDT')) return klineCsv(1711929600000, 3198)
  if (zipPath.includes('premiumIndexKlines') && zipPath.includes('BTCUSDT')) return klineCsv(1711929600000, 0.0001)
  if (zipPath.includes('premiumIndexKlines') && zipPath.includes('ETHUSDT')) return klineCsv(1711929600000, 0.0002)
  return ''
}

function klineCsv(openTimeMs: number, close: number): string {
  return [
    'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
    `${openTimeMs},${close},${close},${close},${close},0,${openTimeMs + 3_599_998},0,3600,0,0,0`,
    '',
  ].join('\n')
}
