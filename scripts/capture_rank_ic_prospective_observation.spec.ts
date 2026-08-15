import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import packageJson from '../package.json' assert { type: 'json' }
import { describe, expect, it } from 'vitest'
import {
  buildRankIcProspectiveObservationCaptureReport,
  parseRankIcProspectiveObservationCaptureArgs,
  runRankIcProspectiveObservationCapture,
} from './capture_rank_ic_prospective_observation.js'

describe('capture_rank_ic_prospective_observation', () => {
  it('parses safe research-only defaults and keeps the package script wired', () => {
    expect(parseRankIcProspectiveObservationCaptureArgs([
      '--lane',
      'lane.json',
      '--walkForward',
      'wf.json',
      '--ledger',
      'obs.jsonl',
      '--output',
      'null',
      '--dryRun',
      'false',
      '--json',
      'true',
    ])).toMatchObject({
      lanePath: 'lane.json',
      walkForwardPath: 'wf.json',
      ledgerPath: 'obs.jsonl',
      outputPath: null,
      dryRun: false,
      json: true,
    })

    const scripts = packageJson.scripts as Record<string, string>
    expect(scripts['research:cross-sectional:prospective-observation:capture']).toContain('capture_rank_ic_prospective_observation.ts')
    expect(scripts['research:cross-sectional:prospective-observation:capture']).toContain('rank_ic_prospective_trial_lane.live_accumulated_fwd72_median_filter.latest.json')
  })

  it('builds an open prospective observation without enabling execution', () => {
    const report = buildRankIcProspectiveObservationCaptureReport({
      generatedAt: '2026-05-05T06:00:00.000Z',
      lanePath: '/repo/lane.json',
      walkForwardPath: '/repo/wf.json',
      dataDir: '/repo/data/market/live_accumulated',
      ledgerPath: '/repo/data/research/obs.jsonl',
      outputPath: null,
      lane: makeLane(),
      walkForward: makeWalkForward(),
      assets: makeAssets(),
      existingLedger: [],
      args: {
        barMinutes: 60,
        maxRows: null,
        maxVolPct: 10000,
        minSpreadPct: 0,
        minUniverseSize: 2,
        executionMode: 'paper',
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
      eventType: 'prospective_decision_open',
      paperTradingAllowed: false,
      liveTradingAllowed: false,
      decisionTime: '2026-05-05T09:00:00.000Z',
      labelDueTime: '2026-05-05T12:00:00.000Z',
      filter: {
        filterId: 'median_return_gte_p33',
        allowed: true,
        thresholds: {
          minMedianReturnPct: -100,
        },
      },
      signalPair: {
        long: {
          symbol: 'AAA-USDT',
          side: 'long',
        },
        short: {
          symbol: 'DDD-USDT',
          side: 'short',
        },
        labelStatus: 'pending_future_close',
      },
      blockers: expect.arrayContaining([
        'prospective_observation_not_execution_evidence',
        'paper_live_execution_disabled',
        'future_label_pending',
      ]),
    })
  })

  it('appends idempotently to the research ledger and writes a capture report', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-prospective-observation-'))
    const dataDir = join(root, 'market')
    const lanePath = join(root, 'lane.json')
    const wfPath = join(root, 'wf.json')
    const ledgerPath = join(root, 'obs.jsonl')
    const outputPath = join(root, 'capture.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(lanePath, `${JSON.stringify(makeLane())}\n`, 'utf-8')
    await writeFile(wfPath, `${JSON.stringify(makeWalkForward())}\n`, 'utf-8')
    for (const asset of makeAssets()) {
      await writeFile(join(dataDir, csvFileFor(asset.symbol)), toCsv(asset), 'utf-8')
    }

    const first = await runRankIcProspectiveObservationCapture({
      lanePath,
      walkForwardPath: wfPath,
      dataDir,
      ledgerPath,
      outputPath,
      symbols: makeAssets().map(asset => asset.symbol),
      barMinutes: 60,
      maxRows: null,
      maxVolPct: 10000,
      minSpreadPct: 0,
      minUniverseSize: 2,
      executionMode: 'paper',
      dryRun: false,
      json: false,
    })
    const second = await runRankIcProspectiveObservationCapture({
      lanePath,
      walkForwardPath: wfPath,
      dataDir,
      ledgerPath,
      outputPath,
      symbols: makeAssets().map(asset => asset.symbol),
      barMinutes: 60,
      maxRows: null,
      maxVolPct: 10000,
      minSpreadPct: 0,
      minUniverseSize: 2,
      executionMode: 'paper',
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
      eventType: 'prospective_decision_open',
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
})

function makeLane() {
  return {
    schemaVersion: 1,
    researchOnly: true,
    prospectiveOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    laneStatus: 'ready_for_future_collection',
    candidate: {
      laneId: 'prospective_test_lane',
      candidateId: 'rank_ic_wf_filter_median_return_gte_p33_signal_confidence_lb2_sec4_fwd3_mtf0.5',
      strategyFamily: 'cross_sectional_rank_ic_walkforward_filter',
      filterId: 'median_return_gte_p33',
      factor: 'signal_confidence',
      lookbackHours: 2,
      secondaryLookbackHours: 4,
      forwardHours: 3,
      mtfWeight: 0.5,
    },
    currentEvidence: {
      walkForwardWfoStatus: 'fail',
      walkForwardPassedWindows: 2,
      walkForwardWindowCount: 4,
      walkForwardFailedWindowRatio: 0.5,
      meanIc: 0.055734,
      icIr: 0.277431,
      netAfterRouteCostPct: 1.349672,
      feeSnapshotSource: 'manual_override',
      feeSnapshotVerifiedByRuntime: false,
    },
    prospectiveProtocol: {
      labelDelayHours: 3,
      orderExecutionAllowed: false,
    },
  }
}

function makeWalkForward() {
  return {
    schemaVersion: 1,
    researchOnly: true,
    promotionEligible: false,
    bestWalkForwardCandidate: {
      filterId: 'median_return_gte_p33',
      windows: [{
        windowIndex: 4,
        filter: {
          id: 'median_return_gte_p33',
          description: 'Keep regimes with median lookback return above the prior-window 33rd percentile.',
          thresholds: {
            minMedianReturnPct: -100,
          },
        },
      }],
    },
  }
}

function makeAssets() {
  const start = Date.parse('2026-05-05T00:00:00.000Z')
  return [
    makeAsset('AAA-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 80, 80]),
    makeAsset('BBB-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]),
    makeAsset('CCC-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 105, 105]),
    makeAsset('DDD-USDT', start, [100, 100, 100, 100, 100, 100, 100, 100, 140, 140]),
  ]
}

function makeAsset(symbol: string, start: number, closes: number[]) {
  return {
    symbol,
    candles: closes.map((close, index) => ({
      time: start + index * 60 * 60 * 1000,
      close,
      volume: 200_000 + index,
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
