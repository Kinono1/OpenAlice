import { describe, expect, it } from 'vitest'
import {
  buildCandidateRegistries,
  buildOptimizationSweepArtifact,
  createSeededRng,
  parseOptimizerArgs,
  rankNormalizeSweepResults,
  type SweepResult,
} from './optimize_cross_sectional.js'

describe('optimize_cross_sectional promotion v2 integration', () => {
  it('uses deterministic seed and sample defaults', () => {
    expect(parseOptimizerArgs([])).toMatchObject({
      seed: 'openalice-cross-sectional-v2.6',
      samples: 200,
      runtimeDir: 'data/runtime',
      dryRun: true,
    })
    expect(parseOptimizerArgs(['--seed', 'abc', '--samples', '7', '--dryRun', 'false'])).toMatchObject({
      seed: 'abc',
      samples: 7,
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
