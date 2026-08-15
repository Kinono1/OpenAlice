import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildLiquidityConditionedProspectiveObservationCaptureReport,
  parseLiquidityConditionedProspectiveObservationCaptureArgs,
  runLiquidityConditionedProspectiveObservationCapture,
} from './capture_liquidity_conditioned_prospective_observation.js'

describe('capture_liquidity_conditioned_prospective_observation', () => {
  it('parses defaults and keeps the package script wired', () => {
    expect(parseLiquidityConditionedProspectiveObservationCaptureArgs([
      '--factorReportPath',
      'factor.json',
      '--ledger',
      'obs.jsonl',
      '--output',
      'null',
      '--dryRun',
      'true',
      '--json',
      'true',
    ])).toMatchObject({
      factorReportPath: 'factor.json',
      ledgerPath: 'obs.jsonl',
      outputPath: null,
      maxCandidates: 1,
      dryRun: true,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:liquidity-conditioned:prospective-observation:capture']).toContain('capture_liquidity_conditioned_prospective_observation.ts')
    expect(scripts['research:liquidity-conditioned:prospective-observation:capture']).toContain('liquidity_conditioned_factor_report.live_accumulated.latest.json')
    expect(scripts['research:liquidity-conditioned:prospective-observation:capture']).toContain('--maxCandidates 6')
  })

  it('builds an open prospective observation without enabling execution', () => {
    const report = buildLiquidityConditionedProspectiveObservationCaptureReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      factorReportPath: '/repo/factor.json',
      dataDir: '/repo/data/market/live_accumulated',
      ledgerPath: '/repo/data/research/obs.jsonl',
      outputPath: null,
      factorReport: makeFactorReport(),
      assets: makeAssets(),
      existingLedger: [],
      args: {
        candidateId: null,
        maxCandidates: 1,
        barMinutes: 60,
        maxRows: null,
        minUniverseSize: 2,
        minBucketAssets: 1,
        topBottomFraction: 0.2,
        dryRun: true,
      },
    })

    expect(report).toMatchObject({
      researchOnly: true,
      prospectiveOnly: true,
      promotionEligible: false,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      dryRun: true,
      status: 'captured',
      appendResult: {
        appended: false,
        reason: 'dry_run',
      },
      counts: {
        symbolsLoaded: 4,
        observationsBuilt: 1,
        signalPairsOpened: 1,
      },
    })
    expect(report.observation).toMatchObject({
      eventType: 'liquidity_conditioned_prospective_decision_open',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      strategyFamily: 'liquidity_conditioned_momentum_reversal',
      strategy: 'high_reversal',
      signalPair: {
        labelStatus: 'pending_future_close',
      },
      blockers: expect.arrayContaining([
        'liquidity_conditioned_prospective_observation_not_execution_evidence',
        'paper_live_execution_disabled',
        'future_label_pending',
        'runtime_fee_not_verified',
      ]),
    })
  })

  it('appends idempotently to the research ledger and writes a capture report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-liquidity-prospective-observation-'))
    const dataDir = join(root, 'market')
    const factorPath = join(root, 'factor.json')
    const ledgerPath = join(root, 'obs.jsonl')
    const outputPath = join(root, 'capture.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(factorPath, `${JSON.stringify(makeFactorReport())}\n`, 'utf-8')
    for (const asset of makeAssets()) {
      await writeFile(join(dataDir, csvFileFor(asset.symbol)), toCsv(asset), 'utf-8')
    }

    const first = await runLiquidityConditionedProspectiveObservationCapture({
      factorReportPath: factorPath,
      dataDir,
      ledgerPath,
      outputPath,
      candidateId: null,
      maxCandidates: 1,
      symbols: makeAssets().map(asset => asset.symbol),
      barMinutes: null,
      maxRows: null,
      minUniverseSize: 2,
      minBucketAssets: 1,
      topBottomFraction: 0.2,
      dryRun: false,
      json: false,
    })
    const second = await runLiquidityConditionedProspectiveObservationCapture({
      factorReportPath: factorPath,
      dataDir,
      ledgerPath,
      outputPath,
      candidateId: null,
      maxCandidates: 1,
      symbols: makeAssets().map(asset => asset.symbol),
      barMinutes: null,
      maxRows: null,
      minUniverseSize: 2,
      minBucketAssets: 1,
      topBottomFraction: 0.2,
      dryRun: false,
      json: false,
    })

    expect(first).toMatchObject({
      status: 'captured',
      appendResult: {
        appended: true,
        reason: 'appended',
      },
      counts: {
        appendedObservations: 1,
      },
    })
    expect(second).toMatchObject({
      status: 'skipped_duplicate',
      appendResult: {
        appended: false,
        reason: 'duplicate_observation_id',
      },
    })
    const ledgerLines = (await readFile(ledgerPath, 'utf-8')).trim().split('\n')
    expect(ledgerLines).toHaveLength(1)
    const event = JSON.parse(ledgerLines[0])
    expect(event).toMatchObject({
      eventType: 'liquidity_conditioned_prospective_decision_open',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      signalPair: {
        labelStatus: 'pending_future_close',
      },
    })
    const written = JSON.parse(await readFile(outputPath, 'utf-8'))
    expect(written).toMatchObject({
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      status: 'skipped_duplicate',
    })
  })

  it('can capture multiple correlated candidate observations without enabling execution', () => {
    const report = buildLiquidityConditionedProspectiveObservationCaptureReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      factorReportPath: '/repo/factor.json',
      dataDir: '/repo/data/market/live_accumulated',
      ledgerPath: '/repo/data/research/obs.jsonl',
      outputPath: null,
      factorReport: makeFactorReport(),
      assets: makeAssets(),
      existingLedger: [],
      args: {
        candidateId: null,
        maxCandidates: 2,
        barMinutes: 60,
        maxRows: null,
        minUniverseSize: 2,
        minBucketAssets: 1,
        topBottomFraction: 0.2,
        dryRun: true,
      },
    })

    expect(report).toMatchObject({
      status: 'captured',
      researchOnly: true,
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      counts: {
        candidatesEvaluated: 2,
        observationsBuilt: 2,
        signalPairsOpened: 2,
      },
      appendResults: [
        {
          appended: false,
          reason: 'dry_run',
        },
        {
          appended: false,
          reason: 'dry_run',
        },
      ],
    })
    expect(report.observations.map(observation => observation.candidateId)).toEqual([
      'liq_high_reversal_lb2_fwd3',
      'liq_all_momentum_lb2_fwd3',
    ])
    expect(report.notes.join(' ')).toContain('correlated research observations')
  })
})

function makeFactorReport() {
  return {
    schemaVersion: 1,
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    generatedAt: '2026-05-05T06:00:00.000Z',
    dataCadence: {
      barMinutes: 60,
    },
    routeCost: {
      source: 'manual_diagnostic_override',
      runtimeVerified: false,
      pairRoundTripCostPct: 0.36,
    },
    commonPeriods: 1200,
    symbolsLoaded: ['AAA-USDT', 'BBB-USDT', 'CCC-USDT', 'DDD-USDT'],
    best: {
      configId: 'liq_high_reversal_lb2_fwd3',
      liquidityBucket: 'high',
      factor: 'reversal',
      lookbackHours: 2,
      forwardHours: 3,
      lookbackBars: 2,
      forwardBars: 3,
      routeCostPct: 0.36,
      netAfterRouteCostPct: 2.59443,
      meanIc: 0.04925,
      icIr: 0.144898,
      averageLongShortSpreadPct: 2.95443,
      longShortWinRate: 0.596455,
      candidateVerdict: 'incubate_observation',
      wfo: {
        status: 'fail',
        failedWindowRatio: 0.6,
        failedWindowRatioThreshold: 0.3,
        passedWindows: 2,
        windowCount: 5,
      },
      blockers: [
        'wfo_failed_window_ratio:0.6>0.3',
      ],
    },
    topConfigs: [{
      configId: 'liq_high_reversal_lb2_fwd3',
      liquidityBucket: 'high',
      factor: 'reversal',
      lookbackHours: 2,
      forwardHours: 3,
      lookbackBars: 2,
      forwardBars: 3,
      routeCostPct: 0.36,
      netAfterRouteCostPct: 2.59443,
      meanIc: 0.04925,
      icIr: 0.144898,
      averageLongShortSpreadPct: 2.95443,
      longShortWinRate: 0.596455,
      candidateVerdict: 'incubate_observation',
      wfo: {
        status: 'fail',
        failedWindowRatio: 0.6,
        failedWindowRatioThreshold: 0.3,
        passedWindows: 2,
        windowCount: 5,
      },
      blockers: ['wfo_failed_window_ratio:0.6>0.3'],
    }, {
      configId: 'liq_all_momentum_lb2_fwd3',
      liquidityBucket: 'all',
      factor: 'momentum',
      lookbackHours: 2,
      forwardHours: 3,
      lookbackBars: 2,
      forwardBars: 3,
      routeCostPct: 0.36,
      netAfterRouteCostPct: 1.1,
      meanIc: 0.03,
      icIr: 0.12,
      averageLongShortSpreadPct: 1.46,
      longShortWinRate: 0.55,
      candidateVerdict: 'incubate_observation',
      wfo: {
        status: 'fail',
        failedWindowRatio: 0.4,
        failedWindowRatioThreshold: 0.3,
        passedWindows: 3,
        windowCount: 5,
      },
      blockers: ['wfo_failed_window_ratio:0.4>0.3'],
    }],
    blockers: ['route_cost_manual_not_runtime_verified'],
  }
}

function makeAssets() {
  const start = Date.parse('2026-05-05T00:00:00.000Z')
  return [
    makeAsset('AAA-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 80, 80], [100, 110, 120, 130, 140, 150, 160, 170, 180, 190]),
    makeAsset('BBB-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100], [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
    makeAsset('CCC-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 105, 105], [30, 40, 50, 60, 70, 80, 90, 100, 110, 120]),
    makeAsset('DDD-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 140, 140], [5, 10, 15, 20, 25, 30, 35, 40, 45, 50]),
  ]
}

function makeAsset(symbol: string, start: number, closes: number[], volumes: number[]) {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: start + index * 60 * 60 * 1000,
      close,
      volume: volumes[index] ?? 1000 + index,
    })),
  }
}

function csvFileFor(symbol: string): string {
  return `${symbol.replace('-USDT', '')}_USDT_USDT_1h.csv`
}

function toCsv(asset: ReturnType<typeof makeAssets>[number]): string {
  const lines = ['timestamp,datetime,open,high,low,close,volume,symbol,timeframe,exchange']
  for (const candle of asset.candles) {
    lines.push([
      candle.time,
      new Date(candle.time).toISOString(),
      candle.close,
      candle.close,
      candle.close,
      candle.close,
      candle.volume,
      asset.symbol.replace('-', '_'),
      '1h',
      'okx',
    ].join(','))
  }
  return `${lines.join('\n')}\n`
}
