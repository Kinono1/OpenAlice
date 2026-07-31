import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildEthCarryConfluenceValidationReport,
  parseEthCarryConfluenceValidationArgs,
  runEthCarryConfluenceValidation,
} from './validate_eth_carry_confluence_candidate.js'

describe('validate_eth_carry_confluence_candidate', () => {
  it('parses args and keeps package script research-only', () => {
    expect(parseEthCarryConfluenceValidationArgs([
      '--candidatePath',
      '/tmp/candidate.json',
      '--featurePath',
      '/tmp/features.json',
      '--dataDir',
      '/tmp/candles',
      '--output',
      'none',
      '--barMinutes',
      '60',
      '--labelDelayHours',
      '4',
      '--maxFeatureRows',
      '200',
      '--minTrades',
      '10',
      '--minWindows',
      '2',
      '--minWinRatePct',
      '60',
      '--minMeanNetPct',
      '0.01',
      '--routeCostPct',
      '0.25',
      '--json',
    ])).toMatchObject({
      confluenceCandidatePath: '/tmp/candidate.json',
      featurePath: '/tmp/features.json',
      dataDir: '/tmp/candles',
      outputPath: null,
      barMinutes: 60,
      labelDelayHours: 4,
      maxFeatureRows: 200,
      minTrades: 10,
      minWindows: 2,
      minWinRatePct: 60,
      minMeanNetPct: 0.01,
      routeCostPct: 0.25,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:eth-carry:confluence-validate']).toContain('validate_eth_carry_confluence_candidate.ts')
    expect(scripts['status:research-evidence']).toContain('validate_eth_carry_confluence_candidate.ts')
  })

  it('validates a confluence rule offline without enabling execution', () => {
    const report = buildEthCarryConfluenceValidationReport({
      generatedAt: '2026-05-08T03:05:00.000Z',
      confluenceCandidatePath: '/tmp/missing-candidate.json',
      featurePath: '/tmp/missing-features.json',
      dataDir: '/tmp/candles',
      candidateArtifact: makeCandidateArtifact(),
      featureRows: [
        makeFeature({ id: 'f1', availableAtMs: 1_000, fundingSpread: 0.0001, basisSpreadDiffPct: 0.02 }),
        makeFeature({ id: 'f2', availableAtMs: 2_000, fundingSpread: -0.0001, basisSpreadDiffPct: 0.02 }),
      ],
      ethCandles: [
        { timeMs: 2_000, close: 100 },
        { timeMs: 28_802_000, close: 90 },
      ],
      btcCandles: [
        { timeMs: 2_000, close: 100 },
        { timeMs: 28_802_000, close: 105 },
      ],
      args: {
        barMinutes: 5,
        labelDelayHours: 8,
        maxFeatureRows: null,
        minTrades: 1,
        minWindows: 1,
        minWinRatePct: 50,
        minMeanNetPct: 0,
        routeCostPct: 0.2,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      diagnosticOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      executionAllowed: false,
      candidate: {
        candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
        fundingSpreadSign: 'positive',
        basisSpreadDiffPctSign: 'positive',
        direction: 'short_eth_long_btc',
      },
      counts: {
        featureRowsLoaded: 2,
        featureRowsAfterRule: 1,
        tradesBuilt: 1,
      },
      summary: {
        tradeCount: 1,
        winRatePct: 100,
      },
    })
    expect(report.summary.meanNetPct ?? 0).toBeGreaterThan(0)
    expect(report.blockers).toEqual(expect.arrayContaining([
      'research_only_not_execution_evidence',
      'paper_live_execution_disabled',
      'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry',
    ]))
  })

  it('writes validation artifact and manifest sidecar', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-eth-carry-confluence-validate-'))
    const candidatePath = join(root, 'candidate.json')
    const featurePath = join(root, 'features.json')
    const dataDir = join(root, 'candles')
    const outputPath = join(root, 'out.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(candidatePath, JSON.stringify(makeCandidateArtifact()), 'utf-8')
    await writeFile(featurePath, JSON.stringify({
      carryFeatureRows: [
        makeFeature({ id: 'f1', availableAtMs: 1_000, fundingSpread: 0.0001, basisSpreadDiffPct: 0.02 }),
      ],
    }), 'utf-8')
    await writeFile(join(dataDir, 'ETH_USDT_USDT_5m.csv'), candleCsv([
      [2_000, 100],
      [28_802_000, 90],
    ]), 'utf-8')
    await writeFile(join(dataDir, 'BTC_USDT_USDT_5m.csv'), candleCsv([
      [2_000, 100],
      [28_802_000, 105],
    ]), 'utf-8')

    const report = await runEthCarryConfluenceValidation({
      confluenceCandidatePath: candidatePath,
      featurePath,
      dataDir,
      outputPath,
      barMinutes: 5,
      labelDelayHours: 8,
      maxFeatureRows: null,
      minTrades: 2,
      minWindows: 1,
      minWinRatePct: 55,
      minMeanNetPct: 0,
      routeCostPct: 0.2,
      json: false,
    })

    expect(report.status).toBe('blocked_insufficient_evidence')
    expect(JSON.parse(await readFile(outputPath, 'utf-8'))).toMatchObject({
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        tradesBuilt: 1,
      },
    })
    expect(JSON.parse(await readFile(`${outputPath}.manifest.json`, 'utf-8'))).toMatchObject({
      job: 'eth_carry_confluence_validation',
      businessStatus: 'warn',
      recordsOut: 1,
    })
  })
})

function makeCandidateArtifact() {
  return {
    recommendedCandidate: {
      candidateId: 'eth_carry_confluence_filter_funding_positive_basis_positive_short_eth_long_btc',
      sourceBucketId: 'confluence:funding_positive:basis_positive:direction_short_eth_long_btc',
      rule: {
        fundingSpreadSign: 'positive',
        basisSpreadDiffPctSign: 'positive',
        direction: 'short_eth_long_btc',
      },
    },
  }
}

function makeFeature(input: {
  id: string
  availableAtMs: number
  fundingSpread: number
  basisSpreadDiffPct: number
}) {
  return {
    featureId: input.id,
    exchange: 'okx',
    market: 'swap',
    strategyFamily: 'funding_carry_rebuild',
    symbols: {
      leader: 'ETHUSDT',
      hedge: 'BTCUSDT',
    },
    decisionAvailableAt: new Date(input.availableAtMs).toISOString(),
    decisionAvailableAtMs: input.availableAtMs,
    pairSkewMs: 0,
    fundingSpread: input.fundingSpread,
    basisSpreadDiffPct: input.basisSpreadDiffPct,
    ethFundingRate: 0.0001,
    btcFundingRate: 0,
    ethBasisSpreadPct: 0.02,
    btcBasisSpreadPct: 0,
    ethNextFundingTime: new Date(10_000).toISOString(),
    btcNextFundingTime: new Date(10_000).toISOString(),
    requiredFields: {
      fundingRateCashflow: true,
      basisSpread: true,
      explicitAvailableAt: true,
    },
    sourceFeatures: {
      ethBasisFeatureId: `${input.id}-eth`,
      btcBasisFeatureId: `${input.id}-btc`,
    },
    blockers: [],
  }
}

function candleCsv(rows: Array<[number, number]>) {
  return [
    'timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange',
    ...rows.map(([time, close]) => `${time},${new Date(time).toISOString()},${close},${close},${close},${close},1,ETH/USDT:USDT,5m,test`),
    '',
  ].join('\n')
}
