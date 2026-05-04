import { describe, expect, it } from 'vitest'
import {
  SHORT_BIAS_CANDIDATES,
  SHORT_BIAS_IDENTITY,
  buildResearchUniverseCandidates,
  compareShortBiasEvaluations,
  parseArgs,
  splitCarrySlicesForFinalHoldout,
} from './run_eth_carry_short_bias_validation.ts'
import { buildMicroSweepCandidates } from './run_eth_carry_short_bias_micro_sweep.ts'
import { buildShortBiasVariants, toSweepCandidate } from './run_eth_carry_short_bias_sweep.ts'

describe('run_eth_carry_short_bias_validation', () => {
  it('defaults CLI execution to dry-run without runtime artifact publication', () => {
    const args = parseArgs([])

    expect(args.dryRun).toBe(true)
    expect(args.writeRuntimeArtifacts).toBe(false)
    expect(args.selfCheck).toBe(false)
  })

  it('requires explicit opt-in before writing runtime promotion artifacts', () => {
    const args = parseArgs(['--dryRun', 'false', '--writeRuntimeArtifacts', 'true'])

    expect(args.dryRun).toBe(false)
    expect(args.writeRuntimeArtifacts).toBe(true)
  })

  it('builds the full research universe instead of shrinking significance accounting to the finalist lane', () => {
    const candidates = buildResearchUniverseCandidates({
      sweepCandidates: buildShortBiasVariants().map((thresholds) => toSweepCandidate(thresholds)),
      microCandidates: buildMicroSweepCandidates(),
    })

    expect(candidates).toHaveLength(336)
    expect(new Set(candidates.map((candidate) => candidate.id)).size).toBe(336)
  })

  it('reserves an untouched final holdout from the tail of the candle series', () => {
    const slices = splitCarrySlicesForFinalHoldout({
      candles: [
        { time: 1, close: 1 },
        { time: 2, close: 1.01 },
        { time: 3, close: 1.02 },
        { time: 4, close: 1.03 },
        { time: 5, close: 1.04 },
      ] as any,
      carrySignals: [
        { time: 1, fundingSpread: 0.0002, fundingSpreadZScore: 1.4 },
        { time: 2, fundingSpread: 0.0002, fundingSpreadZScore: 1.4 },
        { time: 3, fundingSpread: -0.0002, fundingSpreadZScore: -1.4 },
        { time: 4, fundingSpread: -0.0002, fundingSpreadZScore: -1.4 },
        { time: 5, fundingSpread: -0.0002, fundingSpreadZScore: -1.4 },
      ],
      holdoutBars: 2,
    })

    expect(slices.validationSlice.candles.map((candle) => candle.time)).toEqual([1, 2, 3])
    expect(slices.finalHoldoutSlice.candles.map((candle) => candle.time)).toEqual([4, 5])
    expect(slices.finalHoldoutSlice.carrySignals.map((signal) => signal.time)).toEqual([4, 5])
  })

  it('prefers stronger WFO out-of-sample selection metrics once paper, failed windows, and pbo tie', () => {
    expect(SHORT_BIAS_IDENTITY.strategyId).toBe('ETH_CARRY_SHORT_BIAS_V1')
    expect(SHORT_BIAS_CANDIDATES.map((candidate) => candidate.id)).toEqual([
      'carry_short_bias_core',
      'carry_short_bias_soft',
    ])

    const left = {
      stage: 'validation_selection',
      candidate: SHORT_BIAS_CANDIDATES[0],
      backtest: { metrics: { netExpectancyPct: 0.02, sharpe: 2, tradeCount: 20 } },
      wfo: {
        failedWindows: 0,
        selectionMetrics: {
          averageOutOfSampleErrorRate: 0.22,
          totalOutOfSampleTradeCount: 18,
          averageOutOfSampleTradeCount: 9,
          averageOutOfSampleNetExpectancyPct: 0.011,
          averageOutOfSampleSharpe: 1.1,
        },
      },
      significance: { pboResult: { pbo: 0.3 } },
      releaseGate: { allowPaperTrading: true },
      errorRate: 0.2,
      recent90dErrorRate: 0.05,
    }
    const right = {
      stage: 'validation_selection',
      candidate: SHORT_BIAS_CANDIDATES[1],
      backtest: { metrics: { netExpectancyPct: 0.018, sharpe: 1.9, tradeCount: 25 } },
      wfo: {
        failedWindows: 0,
        selectionMetrics: {
          averageOutOfSampleErrorRate: 0.18,
          totalOutOfSampleTradeCount: 26,
          averageOutOfSampleTradeCount: 13,
          averageOutOfSampleNetExpectancyPct: 0.013,
          averageOutOfSampleSharpe: 1.4,
        },
      },
      significance: { pboResult: { pbo: 0.3 } },
      releaseGate: { allowPaperTrading: true },
      errorRate: 0.2,
      recent90dErrorRate: 0.25,
    }

    expect(compareShortBiasEvaluations(left as any, right as any)).toBeGreaterThan(0)
  })
})
