import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryPitFeatureDatasetReport,
  parseEthCarryPitFeatureDatasetArgs,
  runEthCarryPitFeatureDataset,
} from './build_eth_carry_pit_feature_dataset.js'

describe('build_eth_carry_pit_feature_dataset', () => {
  it('parses defaults and keeps package script wired', () => {
    expect(parseEthCarryPitFeatureDatasetArgs([
      '--output',
      'null',
      '--json',
      'true',
      '--maxPairSkewMs',
      '600000',
    ])).toMatchObject({
      sourcePath: 'data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl',
      outputPath: null,
      json: true,
      maxPairSkewMs: 600000,
      sourcePaths: ['data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl'],
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:pit-features']).toContain('build_eth_carry_pit_feature_dataset.ts')
    expect(scripts['research:eth-carry:pit-features']).toContain('data/normalized/derivatives/okx_swap_derivatives_events.normalized.jsonl')
    expect(scripts['research:eth-carry:pit-features']).not.toContain('/Volumes/shield')
    expect(scripts['research:eth-carry:pit-features']).not.toContain('binance_usdm')
  })

  it('builds PIT funding and basis features from external derivative events', () => {
    const report = buildEthCarryPitFeatureDatasetReport({
      generatedAt: '2026-05-05T10:00:00.000Z',
      sourcePath: '/repo/events.jsonl',
      sourceExists: true,
      maxPairSkewMs: 10 * 60_000,
      events: [
        makeFundingEvent('ETHUSDT', '2026-05-05T08:00:00.000Z', '-0.00002'),
        makeFundingEvent('BTCUSDT', '2026-05-05T08:00:00.000Z', '0.00001'),
        makePremiumEvent({
          symbol: 'ETHUSDT',
          time: '2026-05-05T08:07:32.000Z',
          ingestedAt: '2026-05-05T08:07:34.000Z',
          markPrice: '2382',
          indexPrice: '2380',
          lastFundingRate: '-0.00002',
        }),
        makePremiumEvent({
          symbol: 'BTCUSDT',
          time: '2026-05-05T08:07:30.000Z',
          ingestedAt: '2026-05-05T08:07:33.000Z',
          markPrice: '95095',
          indexPrice: '95100',
          lastFundingRate: '0.00001',
        }),
      ],
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      generatedAt: '2026-05-05T10:00:00.000Z',
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'ready_for_research',
      counts: {
        fundingEvents: 2,
        basisSnapshots: 2,
        carryFeatureRows: 1,
        symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
        symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
        sourceLineageIncompleteRows: 0,
      },
    })
    expect(report.carryFeatureRows[0]).toMatchObject({
      decisionAvailableAt: '2026-05-05T08:07:34.000Z',
      fundingSpread: -0.00003,
      requiredFields: {
        fundingRateCashflow: true,
        basisSpread: true,
        explicitAvailableAt: true,
      },
      blockers: [],
    })
    expect(report.blockers).toEqual([])
  })

  it('writes the PIT feature artifact without authorizing execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-'))
    const sourcePath = join(root, 'events.jsonl')
    const outputPath = join(root, 'eth_carry_pit_features.latest.json')
    await mkdir(root, { recursive: true })
    await writeFile(sourcePath, [
      JSON.stringify(makeFundingEvent('ETHUSDT', '2026-05-05T08:00:00.000Z', '-0.00002')),
      JSON.stringify(makeFundingEvent('BTCUSDT', '2026-05-05T08:00:00.000Z', '0.00001')),
      JSON.stringify(makePremiumEvent({
        symbol: 'ETHUSDT',
        time: '2026-05-05T08:07:32.000Z',
        ingestedAt: '2026-05-05T08:07:34.000Z',
        markPrice: '2382',
        indexPrice: '2380',
        lastFundingRate: '-0.00002',
      })),
      JSON.stringify(makePremiumEvent({
        symbol: 'BTCUSDT',
        time: '2026-05-05T08:07:30.000Z',
        ingestedAt: '2026-05-05T08:07:33.000Z',
        markPrice: '95095',
        indexPrice: '95100',
        lastFundingRate: '0.00001',
      })),
    ].join('\n'))

    const report = await runEthCarryPitFeatureDataset({
      sourcePath,
      outputPath,
      maxPairSkewMs: 10 * 60_000,
      json: false,
    })

    expect(report.status).toBe('ready_for_research')
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      researchOnly: true,
      promotionAllowed: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'ready_for_research',
    })
  })

  it('reads normalized external derivatives rows and excludes incomplete lineage rows from PIT features', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-normalized-'))
    const sourcePath = join(root, 'normalized.jsonl')
    await mkdir(root, { recursive: true })
    await writeFile(sourcePath, [
      JSON.stringify(makeNormalizedFundingEvent('ETHUSDT', '2026-05-05T08:00:00.000Z', '-0.00002', true)),
      JSON.stringify(makeNormalizedFundingEvent('BTCUSDT', '2026-05-05T08:00:00.000Z', '0.00001', false)),
      JSON.stringify(makeNormalizedPremiumEvent({
        symbol: 'ETHUSDT',
        time: '2026-05-05T08:07:32.000Z',
        availableAt: '2026-05-05T08:07:34.000Z',
        markPrice: '2382',
        indexPrice: '2380',
        lastFundingRate: '-0.00002',
        completeLineage: true,
      })),
      JSON.stringify(makeNormalizedPremiumEvent({
        symbol: 'BTCUSDT',
        time: '2026-05-05T08:07:30.000Z',
        availableAt: '2026-05-05T08:07:33.000Z',
        markPrice: '95095',
        indexPrice: '95100',
        lastFundingRate: '0.00001',
        completeLineage: true,
      })),
    ].join('\n') + '\n', 'utf-8')

    const report = await runEthCarryPitFeatureDataset({
      sourcePath,
      outputPath: null,
      maxPairSkewMs: 10 * 60_000,
      json: false,
    })

    expect(report).toMatchObject({
      sourcePath,
      status: 'blocked_missing_pit_features',
      counts: {
        sourceEvents: 4,
        fundingEvents: 1,
        basisSnapshots: 2,
        carryFeatureRows: 1,
        sourceLineageIncompleteRows: 1,
      },
    })
    expect(report.fundingEvents.map(row => row.symbol)).toEqual(['ETHUSDT'])
    expect(report.blockers).toContain('funding_rows_missing:BTCUSDT')
  })

  it('streams JSONL while preserving full source counts and retaining only carry-relevant events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-stream-'))
    const sourcePath = join(root, 'streamed.jsonl')
    const irrelevantRows = Array.from({ length: 2_500 }, (_, index) => JSON.stringify({
      ...makeNormalizedFundingEvent(
        `ALT${index}USDT`,
        '2026-05-05T08:00:00.000Z',
        '0.00001',
        true,
      ),
      endpointId: 'openInterest',
      sourceEndpoint: '/fapi/v1/openInterest',
      fields: {
        symbol: `ALT${index}USDT`,
        openInterest: String(1_000 + index),
      },
    }))
    const relevantRows = [
      JSON.stringify(makeNormalizedFundingEvent('ETHUSDT', '2026-05-05T08:00:00.000Z', '-0.00002', true)),
      JSON.stringify(makeNormalizedFundingEvent('BTCUSDT', '2026-05-05T08:00:00.000Z', '0.00001', true)),
      JSON.stringify(makeNormalizedPremiumEvent({
        symbol: 'ETHUSDT',
        time: '2026-05-05T08:07:32.000Z',
        availableAt: '2026-05-05T08:07:34.000Z',
        markPrice: '2382',
        indexPrice: '2380',
        lastFundingRate: '-0.00002',
        completeLineage: true,
      })),
      JSON.stringify(makeNormalizedPremiumEvent({
        symbol: 'BTCUSDT',
        time: '2026-05-05T08:07:30.000Z',
        availableAt: '2026-05-05T08:07:33.000Z',
        markPrice: '95095',
        indexPrice: '95100',
        lastFundingRate: '0.00001',
        completeLineage: true,
      })),
    ]
    await writeFile(sourcePath, [...irrelevantRows, '', '{"malformed":', ...relevantRows].join('\n') + '\n', 'utf-8')

    const report = await runEthCarryPitFeatureDataset({
      sourcePath,
      outputPath: null,
      maxPairSkewMs: 10 * 60_000,
      json: false,
    })

    expect(report).toMatchObject({
      status: 'ready_for_research',
      counts: {
        sourceEvents: 2_504,
        fundingEvents: 2,
        basisSnapshots: 2,
        carryFeatureRows: 1,
        symbolsWithFunding: ['BTCUSDT', 'ETHUSDT'],
        symbolsWithBasis: ['BTCUSDT', 'ETHUSDT'],
      },
    })
  })

  it('guards against whole-file UTF-8 materialization for JSONL inputs', async () => {
    const source = await readFile(new URL('./build_eth_carry_pit_feature_dataset.ts', import.meta.url), 'utf-8')

    expect(source).toContain('createReadStream')
    expect(source).toContain('createInterface')
    expect(source).toContain('for await (const line of lines)')
    expect(source).not.toContain("readFileSync(resolvedPath, 'utf-8')")
  })

  it('builds a fresh carry feature from multi-source OKX normalized snapshot rows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-okx-'))
    const historicalPath = join(root, 'historical.jsonl')
    const livePath = join(root, 'okx-live.jsonl')
    await mkdir(root, { recursive: true })
    await writeFile(historicalPath, `${JSON.stringify(makeNormalizedPremiumEvent({
      symbol: 'ETHUSDT',
      time: '2026-05-01T00:00:00.000Z',
      availableAt: '2026-05-01T00:00:05.000Z',
      markPrice: '2001',
      indexPrice: '2000',
      lastFundingRate: '0.00001',
      completeLineage: true,
    }))}\n`, 'utf-8')
    await writeFile(livePath, [
      JSON.stringify(makeOkxSnapshotEvent({
        symbol: 'BTCUSDT',
        sourceTimestamp: '2026-05-07T00:42:49.358Z',
        availableAt: '2026-05-07T00:42:49.220Z',
        markPrice: '80999.4',
        indexPrice: '81044.6',
        fundingRate: '-0.0000269720932491',
      })),
      JSON.stringify(makeOkxSnapshotEvent({
        symbol: 'ETHUSDT',
        sourceTimestamp: '2026-05-07T00:42:49.460Z',
        availableAt: '2026-05-07T00:42:49.601Z',
        markPrice: '2338.52',
        indexPrice: '2339.53',
        fundingRate: '0.0000812039669279',
      })),
    ].join('\n') + '\n', 'utf-8')

    const report = await runEthCarryPitFeatureDataset({
      sourcePath: historicalPath,
      sourcePaths: [historicalPath, livePath],
      outputPath: null,
      maxPairSkewMs: 10 * 60_000,
      json: false,
    })

    expect(report).toMatchObject({
      sourcePath: historicalPath,
      sourcePaths: [historicalPath, livePath],
      status: 'ready_for_research',
      counts: {
        sourceEvents: 3,
        fundingEvents: 2,
        basisSnapshots: 3,
        carryFeatureRows: 1,
        rowsMissingAvailableAt: 0,
        sourceLineageIncompleteRows: 0,
      },
    })
    expect(report.carryFeatureRows[0]).toMatchObject({
      exchange: 'okx',
      market: 'swap',
      decisionAvailableAt: '2026-05-07T00:42:49.601Z',
      fundingSpread: 0.00010817606,
      requiredFields: {
        fundingRateCashflow: true,
        basisSpread: true,
        explicitAvailableAt: true,
      },
      blockers: [],
    })
  })

  it('joins canonical OKX funding and premium rows without using future-available funding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-pit-okx-canonical-'))
    const sourcePath = join(root, 'canonical.jsonl')
    const fundingAvailableAt = '2026-05-07T00:40:00.000Z'
    const basisAvailableAt = '2026-05-07T00:42:00.000Z'
    const futureFundingAvailableAt = '2026-05-07T00:50:00.000Z'
    await writeFile(sourcePath, [
      JSON.stringify(makeCanonicalOkxFundingEvent('BTCUSDT', '-0.00002', fundingAvailableAt)),
      JSON.stringify(makeCanonicalOkxFundingEvent('ETHUSDT', '0.00008', fundingAvailableAt)),
      JSON.stringify(makeCanonicalOkxFundingEvent('ETHUSDT', '0.5', futureFundingAvailableAt)),
      JSON.stringify(makeCanonicalOkxPremiumEvent('BTCUSDT', '81000', '81010', basisAvailableAt)),
      JSON.stringify(makeCanonicalOkxPremiumEvent('ETHUSDT', '2340', '2341', basisAvailableAt)),
    ].join('\n') + '\n', 'utf-8')

    const report = await runEthCarryPitFeatureDataset({
      sourcePath,
      outputPath: null,
      maxPairSkewMs: 10 * 60_000,
      json: false,
    })

    expect(report.status).toBe('ready_for_research')
    expect(report.carryFeatureRows).toHaveLength(1)
    expect(report.carryFeatureRows[0]).toMatchObject({
      fundingSpread: 0.0001,
      ethFundingRate: 0.00008,
      btcFundingRate: -0.00002,
      blockers: [],
    })
    expect(report.carryFeatureRows[0].sourceFeatures.ethFundingFeatureId).toBeTruthy()
    expect(report.blockers).toEqual([])
  })
})

function makeFundingEvent(symbol: string, fundingTime: string, fundingRate: string) {
  const fetchTimestamp = '2026-05-05T08:07:30.000Z'
  const payloadReceivedAt = '2026-05-05T08:07:31.000Z'
  const ingestedAt = '2026-05-05T08:07:32.000Z'
  return {
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol,
    sourceEndpoint: '/fapi/v1/fundingRate',
    sourceTimestamp: fundingTime,
    sourceTimestampMs: Date.parse(fundingTime),
    sourceTimestampBasis: 'exchange_event',
    fetchTimestamp,
    fetchedAt: fetchTimestamp,
    payloadReceivedAt,
    observedAt: payloadReceivedAt,
    ingestedAt,
    availableAt: ingestedAt,
    dedupKey: `funding-${symbol}-${fundingTime}`,
    rawPayloadHash: `hash-${symbol}-funding`,
    collectionRunId: 'run-1',
    jobId: 'run-1',
    generatedAt: '2026-05-05T08:08:00.000Z',
    lineageStatus: 'explicit_row_lineage',
    reportPath: '/repo/report.json',
    manifestPath: '/repo/report.manifest.json',
    payload: {
      symbol,
      fundingTime: Date.parse(fundingTime),
      fundingRate,
      markPrice: '100',
    },
  }
}

function makePremiumEvent(input: {
  symbol: string
  time: string
  ingestedAt: string
  markPrice: string
  indexPrice: string
  lastFundingRate: string
}) {
  const fetchTimestamp = '2026-05-05T08:07:30.000Z'
  const payloadReceivedAt = '2026-05-05T08:07:31.000Z'
  return {
    schemaVersion: 'external_derivatives_event.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol: input.symbol,
    sourceEndpoint: '/fapi/v1/premiumIndex',
    sourceTimestamp: input.time,
    sourceTimestampMs: Date.parse(input.time),
    sourceTimestampBasis: 'exchange_event',
    fetchTimestamp,
    fetchedAt: fetchTimestamp,
    payloadReceivedAt,
    observedAt: payloadReceivedAt,
    ingestedAt: input.ingestedAt,
    availableAt: input.ingestedAt,
    dedupKey: `premium-${input.symbol}-${input.time}`,
    rawPayloadHash: `hash-${input.symbol}-premium`,
    collectionRunId: 'run-1',
    jobId: 'run-1',
    generatedAt: '2026-05-05T08:08:00.000Z',
    lineageStatus: 'explicit_row_lineage',
    reportPath: '/repo/report.json',
    manifestPath: '/repo/report.manifest.json',
    payload: {
      symbol: input.symbol,
      markPrice: input.markPrice,
      indexPrice: input.indexPrice,
      lastFundingRate: input.lastFundingRate,
      nextFundingTime: Date.parse('2026-05-05T16:00:00.000Z'),
      time: Date.parse(input.time),
    },
  }
}

function makeNormalizedFundingEvent(
  symbol: string,
  fundingTime: string,
  fundingRate: string,
  completeLineage: boolean,
) {
  const availableAt = '2026-05-05T08:07:32.000Z'
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol,
    endpointId: 'fundingRate',
    sourceEndpoint: '/fapi/v1/fundingRate',
    eventTime: fundingTime,
    eventTimeMs: Date.parse(fundingTime),
    sourceTimestamp: fundingTime,
    sourceTimestampMs: Date.parse(fundingTime),
    sourceTimestampBasis: 'exchange_event',
    fetchedAt: '2026-05-05T08:07:30.000Z',
    observedAt: '2026-05-05T08:07:31.000Z',
    availableAt,
    ingestedAt: availableAt,
    jobId: completeLineage ? 'run-1' : null,
    collectionRunId: completeLineage ? 'run-1' : null,
    generatedAt: completeLineage ? '2026-05-05T08:08:00.000Z' : null,
    lineageStatus: completeLineage ? 'explicit_row_lineage' : 'recovered_from_run_ledger',
    reportPath: completeLineage ? '/repo/report.json' : null,
    manifestPath: completeLineage ? '/repo/report.manifest.json' : null,
    dedupKey: `funding-${symbol}-${fundingTime}`,
    rawPayloadHash: `hash-${symbol}-funding`,
    fields: {
      symbol,
      fundingTime: Date.parse(fundingTime),
      fundingRate,
      markPrice: '100',
    },
  }
}

function makeNormalizedPremiumEvent(input: {
  symbol: string
  time: string
  availableAt: string
  markPrice: string
  indexPrice: string
  lastFundingRate: string
  completeLineage: boolean
}) {
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    exchange: 'binance',
    market: 'usdm',
    symbol: input.symbol,
    endpointId: 'premiumIndex',
    sourceEndpoint: '/fapi/v1/premiumIndex',
    eventTime: input.time,
    eventTimeMs: Date.parse(input.time),
    sourceTimestamp: input.time,
    sourceTimestampMs: Date.parse(input.time),
    sourceTimestampBasis: 'exchange_event',
    fetchedAt: '2026-05-05T08:07:30.000Z',
    observedAt: '2026-05-05T08:07:31.000Z',
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: input.completeLineage ? 'run-1' : null,
    collectionRunId: input.completeLineage ? 'run-1' : null,
    generatedAt: input.completeLineage ? '2026-05-05T08:08:00.000Z' : null,
    lineageStatus: input.completeLineage ? 'explicit_row_lineage' : 'missing',
    reportPath: input.completeLineage ? '/repo/report.json' : null,
    manifestPath: input.completeLineage ? '/repo/report.manifest.json' : null,
    dedupKey: `premium-${input.symbol}-${input.time}`,
    rawPayloadHash: `hash-${input.symbol}-premium`,
    fields: {
      symbol: input.symbol,
      markPrice: input.markPrice,
      indexPrice: input.indexPrice,
      lastFundingRate: input.lastFundingRate,
      nextFundingTime: Date.parse('2026-05-05T16:00:00.000Z'),
      time: Date.parse(input.time),
    },
  }
}

function makeOkxSnapshotEvent(input: {
  symbol: string
  sourceTimestamp: string
  availableAt: string
  markPrice: string
  indexPrice: string
  fundingRate: string
}) {
  const sourceTimestampMs = Date.parse(input.sourceTimestamp)
  return {
    schemaVersion: 'openalice.external_derivatives.normalized.v1',
    eventTime: input.sourceTimestamp,
    eventTimeMs: sourceTimestampMs,
    exchange: 'okx',
    market: 'swap',
    symbol: input.symbol,
    endpointId: 'okxCarrySnapshot',
    sourceEndpoint: '/api/v5/public/okx-carry-snapshot',
    sourceTimestamp: input.sourceTimestamp,
    sourceTimestampMs,
    sourceTimestampBasis: 'exchange_snapshot_max_ts',
    fetchedAt: input.availableAt,
    observedAt: input.availableAt,
    availableAt: input.availableAt,
    ingestedAt: input.availableAt,
    jobId: 'okx-job-1',
    collectionRunId: 'okx-job-1',
    generatedAt: input.availableAt,
    lineageStatus: 'explicit_row_lineage',
    reportPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json',
    manifestPath: '/repo/data/runtime/okx_carry_snapshot_collect.latest.json.manifest.json',
    dedupKey: `okx|swap|okxCarrySnapshot|${input.symbol}|${sourceTimestampMs}`,
    rawPayloadHash: `okx-hash-${input.symbol}`,
    fields: {
      symbol: input.symbol,
      markPrice: input.markPrice,
      indexPrice: input.indexPrice,
      lastFundingRate: input.fundingRate,
      fundingRate: input.fundingRate,
      fundingTime: Date.parse('2026-05-07T08:00:00.000Z'),
      nextFundingTime: Date.parse('2026-05-07T16:00:00.000Z'),
    },
  }
}

function makeCanonicalOkxFundingEvent(symbol: string, fundingRate: string, availableAt: string) {
  const eventTime = '2026-05-07T00:00:00.000Z'
  return {
    ...makeNormalizedFundingEvent(symbol, eventTime, fundingRate, true),
    exchange: 'okx',
    market: 'swap',
    sourceEndpoint: '/api/v5/public/fundingRate',
    availableAt,
    ingestedAt: availableAt,
    observedAt: availableAt,
    fields: {
      symbol,
      fundingTime: Date.parse(eventTime),
      fundingRate,
      instId: `${symbol.replace(/USDT$/, '')}-USDT-SWAP`,
    },
  }
}

function makeCanonicalOkxPremiumEvent(
  symbol: string,
  markPrice: string,
  indexPrice: string,
  availableAt: string,
) {
  const eventTime = '2026-05-07T00:41:30.000Z'
  return {
    ...makeNormalizedPremiumEvent({
      symbol,
      time: eventTime,
      availableAt,
      markPrice,
      indexPrice,
      lastFundingRate: '0',
      completeLineage: true,
    }),
    exchange: 'okx',
    market: 'swap',
    sourceEndpoint: '/api/v5/public/premiumIndex',
    fields: {
      symbol,
      markPrice,
      indexPrice,
      timestamp: Date.parse(eventTime),
    },
  }
}
