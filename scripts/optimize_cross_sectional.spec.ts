import { describe, expect, it } from 'vitest'
import {
  alignAssetsByTailLength,
  buildBestConfigArtifact,
  buildCandidateRegistries,
  buildOptimizationSweepArtifact,
  createSeededRng,
  evaluateConfig,
  parseOptimizerArgs,
  rankNormalizeSweepResults,
  summarizeHardGateRejections,
  type SweepResult,
} from './optimize_cross_sectional.js'

describe('optimize_cross_sectional promotion v2 integration', () => {
  it('uses deterministic seed and sample defaults', () => {
    expect(parseOptimizerArgs([])).toMatchObject({
      seed: 'openalice-cross-sectional-v2.6',
      samples: 200,
      runtimeDir: 'data/runtime',
      forwardHours: [12, 24, 48],
      executionMode: 'paper',
      dryRun: true,
    })
    expect(parseOptimizerArgs(['--seed', 'abc', '--samples', '7', '--forwardHours', '24,48,24', '--executionMode', 'legacy_thirds', '--dryRun', 'false'])).toMatchObject({
      seed: 'abc',
      samples: 7,
      forwardHours: [24, 48],
      executionMode: 'legacy_thirds',
      dryRun: false,
    })
  })

  it('produces repeatable random sequences for candidate search', () => {
    const left = createSeededRng('same-seed')
    const right = createSeededRng('same-seed')

    expect(Array.from({ length: 5 }, () => left())).toEqual(
      Array.from({ length: 5 }, () => right()),
    )
  })

  it('registers all evaluated candidates and keeps failed candidates in graveyard', () => {
    const best = makeSweepResult({ lookbackHours: 72, score: 10 })
    const other = makeSweepResult({ lookbackHours: 120, score: 1 })
    const { candidateRegistry, graveyard } = buildCandidateRegistries({
      generatedAt: '2026-04-30T12:00:00.000Z',
      experimentId: 'experiment-1',
      seed: 'seed',
      candidates: [best, other],
      best,
    })

    expect(candidateRegistry.candidateCount).toBe(2)
    expect(candidateRegistry.entries.map((entry) => entry.status)).toEqual(['active', 'graveyard'])
    expect(candidateRegistry.graveyardCandidateCount).toBe(1)
    expect(graveyard.candidateCount).toBe(1)
    expect(graveyard.entries[0].status).toBe('graveyard')
  })

  it('can represent optimizer runs with no passing best config without reusing stale winners', () => {
    const artifact = buildBestConfigArtifact({
      experimentId: 'experiment-1',
      generatedAt: '2026-05-05T00:00:00.000Z',
      dataRange: { start: '2026-05-01T00:00:00.000Z', end: '2026-05-05T00:00:00.000Z' },
      assetCount: 34,
      best: undefined,
      evaluatedConfigs: 178,
      hardGatePassedCount: 0,
    })

    expect(artifact).toMatchObject({
      strategyId: 'cross_sectional_v2',
      status: 'no_passing_config',
      selectedConfig: false,
      config: null,
      hardGatePassedCount: 0,
      noPassingConfigReason: 'optimizer_hard_gate_passed_count_zero',
    })
  })

  it('ranks by normalized utility rather than raw mixed-unit metric scale', () => {
    const balanced = makeSweepResult({
      lookbackHours: 72,
      signals: 35,
      winRate: 60,
      avgSpread: 0.58,
      netAvgSpread: 0.3,
      sharpeApprox: 2.5,
    })
    const hugeRawSpread = makeSweepResult({
      lookbackHours: 120,
      signals: 11,
      winRate: 52,
      avgSpread: 100.28,
      netAvgSpread: 100,
      sharpeApprox: 0.5,
    })
    const highWinRate = makeSweepResult({
      lookbackHours: 168,
      signals: 40,
      winRate: 61,
      avgSpread: 0.48,
      netAvgSpread: 0.2,
      sharpeApprox: 2,
    })

    const ranked = rankNormalizeSweepResults([balanced, hugeRawSpread, highWinRate])
      .sort((a, b) => b.score - a.score)

    expect(ranked[0].lookbackHours).toBe(72)
    expect(ranked[0].rankScore).toMatchObject({
      netAvgSpread: 0.5,
      sharpe: 1,
    })
    expect(ranked.every((result) => result.score >= 0 && result.score <= 1)).toBe(true)
  })

  it('keeps ranking invariant when raw spread metrics are rescaled together', () => {
    const base = [
      makeSweepResult({ lookbackHours: 72, signals: 35, winRate: 60, avgSpread: 0.58, netAvgSpread: 0.3, sharpeApprox: 2.5 }),
      makeSweepResult({ lookbackHours: 120, signals: 11, winRate: 52, avgSpread: 100.28, netAvgSpread: 100, sharpeApprox: 0.5 }),
      makeSweepResult({ lookbackHours: 168, signals: 40, winRate: 61, avgSpread: 0.48, netAvgSpread: 0.2, sharpeApprox: 2 }),
    ]
    const scaled = base.map((result) => ({
      ...result,
      spreadCum: result.spreadCum * 100,
      avgSpread: result.avgSpread * 100,
      netAvgSpread: result.netAvgSpread * 100,
      netExpectancyPct: result.netExpectancyPct * 100,
      netExpectancyBps: result.netExpectancyBps * 100,
    }))

    const rankIds = (results: SweepResult[]) =>
      rankNormalizeSweepResults(results)
        .sort((a, b) => b.score - a.score)
        .map((result) => result.lookbackHours)

    expect(rankIds(scaled)).toEqual(rankIds(base))
  })

  it('assigns zero utility to candidates that fail hard gates', () => {
    const failed = makeSweepResult({
      lookbackHours: 72,
      signals: 3,
      winRate: 80,
      avgSpread: 5,
      netAvgSpread: 4.72,
      hardGateStatus: 'fail',
      hardGateReasons: ['insufficient_signals:3<10'],
    })
    const passed = makeSweepResult({
      lookbackHours: 120,
      signals: 20,
      winRate: 55,
      avgSpread: 0.8,
      netAvgSpread: 0.52,
      hardGateStatus: 'pass',
      hardGateReasons: [],
    })

    const scored = rankNormalizeSweepResults([failed, passed])

    expect(scored.find((result) => result.lookbackHours === 72)?.score).toBe(0)
    expect(scored.find((result) => result.lookbackHours === 120)?.score).toBe(1)
  })

  it('summarizes hard-gate rejection causes without relying on ad hoc artifact queries', () => {
    const insufficientSignals = makeSweepResult({
      lookbackHours: 72,
      signals: 3,
      netAvgSpread: 0.7,
      hardGateStatus: 'fail',
      hardGateReasons: ['insufficient_signals:3<10'],
    })
    const negativeNetA = makeSweepResult({
      lookbackHours: 120,
      signals: 20,
      netAvgSpread: -0.2,
      hardGateStatus: 'fail',
      hardGateReasons: ['non_positive_net_expectancy:-0.2000'],
    })
    const negativeNetB = makeSweepResult({
      lookbackHours: 168,
      signals: 25,
      netAvgSpread: -0.1,
      hardGateStatus: 'fail',
      hardGateReasons: ['non_positive_net_expectancy:-0.2000'],
    })
    const passed = makeSweepResult({
      lookbackHours: 240,
      hardGateStatus: 'pass',
      hardGateReasons: [],
    })

    const summary = summarizeHardGateRejections([insufficientSignals, negativeNetA, negativeNetB, passed])

    expect(summary.rejectedCount).toBe(3)
    expect(summary.byReason).toEqual([
      { reason: 'non_positive_net_expectancy:-0.2000', count: 2 },
      { reason: 'insufficient_signals:3<10', count: 1 },
    ])
    expect(summary.byReasonSet[0]).toMatchObject({
      reasons: ['non_positive_net_expectancy:-0.2000'],
      count: 2,
      bestByNetAvgSpread: {
        lookbackHours: 168,
        signals: 25,
        netAvgSpread: -0.1,
      },
      bestBySignalCount: {
        lookbackHours: 168,
        signals: 25,
      },
    })
  })

  it('aligns assets by common tail length before cross-sectional evaluation', () => {
    const aligned = alignAssetsByTailLength([
      {
        symbol: 'A-USDT',
        candles: [
          candle(1, 101),
          candle(2, 102),
          candle(3, 103),
          candle(4, 104),
        ],
      },
      {
        symbol: 'B-USDT',
        candles: [
          candle(3, 203),
          candle(4, 204),
        ],
      },
    ])

    expect(aligned).toEqual([
      {
        symbol: 'A-USDT',
        candles: [
          candle(3, 103),
          candle(4, 104),
        ],
      },
      {
        symbol: 'B-USDT',
        candles: [
          candle(3, 203),
          candle(4, 204),
        ],
      },
    ])
  })

  it('evaluates optimizer candidates with the same top/bottom universe shape as paper execution', () => {
    const result = evaluateConfig(
      syntheticOptimizerAssets(34, 80),
      24,
      48,
      12,
      0,
      0,
      99,
      'paper',
    )

    expect(result).toMatchObject({
      executionMode: 'paper',
      topN: 1,
      bottomN: 1,
      minUniverseSize: 17,
    })
  })

  it('emits every scanned config into a complete optimizer trial universe', () => {
    const passed = makeSweepResult({ lookbackHours: 72, hardGateStatus: 'pass', hardGateReasons: [], score: 1 })
    const failed = makeSweepResult({
      lookbackHours: 120,
      hardGateStatus: 'fail',
      hardGateReasons: ['insufficient_signals:3<10'],
      score: 0,
    })

    const artifact = buildOptimizationSweepArtifact({
      generatedAt: '2026-05-04T00:00:00.000Z',
      experimentId: 'experiment-1',
      seed: 'seed',
      scoredCandidates: [passed, failed],
      ranked: [passed],
      bestWR: passed,
      bestSpread: passed,
      bestSharpe: passed,
    })

    expect(artifact).toMatchObject({
      schemaVersion: 'cross_sectional_optimizer_sweep.v2',
      candidateCount: 2,
      hardGatePassedCount: 1,
      summary: {
        hardGateRejections: {
          rejectedCount: 1,
          byReason: [{ reason: 'insufficient_signals:3<10', count: 1 }],
        },
      },
      trialUniverse: {
        completeForThisSweep: true,
        rawM: 2,
        includesFailedTrials: true,
        fdrMethodPrimary: 'BY_raw_m',
        pValueStatus: 'not_computed',
      },
    })
    expect(artifact.allConfigs).toHaveLength(2)
    expect(artifact.trialUniverse.trials).toHaveLength(2)
    expect(artifact.trialUniverse.trials.map((trial) => trial.status).sort()).toEqual(['active', 'killed'])
    expect(artifact.trialUniverse.trials.every((trial) =>
      trial.failureCodes.includes('FDR_INPUTS_INCOMPLETE') &&
      trial.failureCodes.includes('PIT_AUDIT_NOT_IMPLEMENTED') &&
      trial.pValue === null &&
      trial.includedInRawM === true
    )).toBe(true)
  })
})

function makeSweepResult(overrides: Partial<{
  lookbackHours: number
  signals: number
  winRate: number
  avgSpread: number
  netAvgSpread: number
  sharpeApprox: number
  score: number
  hardGateStatus: SweepResult['hardGateStatus']
  hardGateReasons: string[]
}> = {}): SweepResult {
  const estimatedRoundTripCostPct = 0.28
  const netAvgSpread = overrides.netAvgSpread ?? 0.4
  return {
    lookbackHours: overrides.lookbackHours ?? 72,
    secondaryLookback: 336,
    mtfWeight: 0.25,
    minSpreadPct: 1,
    maxVolPct: 90,
    forwardHours: 48,
    executionMode: 'paper',
    topN: 1,
    bottomN: 1,
    minUniverseSize: 17,
    signals: overrides.signals ?? 20,
    winRate: overrides.winRate ?? 55,
    spreadCum: 8,
    avgSpread: overrides.avgSpread ?? netAvgSpread + estimatedRoundTripCostPct,
    sharpeApprox: overrides.sharpeApprox ?? 1,
    estimatedRoundTripCostPct,
    estimatedRoundTripCostBps: 28,
    netAvgSpread,
    netExpectancyPct: netAvgSpread,
    netExpectancyBps: netAvgSpread * 100,
    hardGateStatus: overrides.hardGateStatus ?? 'pass',
    hardGateReasons: overrides.hardGateReasons ?? [],
    rankScore: {
      winRate: 0,
      netAvgSpread: 0,
      sharpe: 0,
      signalCount: 0,
      costEfficiency: 0,
    },
    filteredCount: 0,
    score: overrides.score ?? 1,
  }
}

function candle(time: number, close: number) {
  return {
    time,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }
}

function syntheticOptimizerAssets(assetCount: number, candleCount: number) {
  return Array.from({ length: assetCount }, (_, assetIndex) => ({
    symbol: `S${assetIndex}-USDT`,
    candles: Array.from({ length: candleCount }, (_, index) =>
      candle(1_700_000_000_000 + index * 3_600_000, 100 + index * 0.01 + assetIndex * 0.1),
    ),
  }))
}
