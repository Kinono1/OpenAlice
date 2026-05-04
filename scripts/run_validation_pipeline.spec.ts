import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import type { BacktestMetrics } from '../src/backtest/strategy-validation/backtest.js'
import type { StrategyRegimeLabel } from '../src/backtest/strategy-validation/types.js'
import { buildRecommendedCandidate } from './run_validation_pipeline.ts'

function makeMetrics(overrides: Partial<BacktestMetrics> = {}): BacktestMetrics {
  return {
    initialCapital: 10_000,
    finalEquity: 10_000,
    totalReturnPct: 0,
    annualizedReturnPct: 0,
    maxDrawdownPct: 10,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    winRatePct: 0,
    profitFactor: 0,
    payoffRatio: 0,
    averageWinPct: 0,
    averageLossPct: 0,
    grossExpectancyPct: 0,
    feeExpectancyDragPct: 0,
    slippageExpectancyDragPct: 0,
    fundingExpectancyDragPct: 0,
    netExpectancyPct: 0,
    expectancyPct: 0,
    tradeCount: 20,
    longTradeCount: 10,
    shortTradeCount: 10,
    averageHoldingBars: 1,
    averageHoldingHours: 1,
    medianHoldingBars: 1,
    medianHoldingHours: 1,
    totalFeesPaid: 0,
    totalSlippagePaid: 0,
    totalFundingPaid: 0,
    totalCostsPaid: 0,
    costDragPctOfInitialCapital: 0,
    regimeSummary: {},
    ...overrides,
  }
}

function makeBaselineReport(netExpectancyPct = 0) {
  return {
    expectancyAfterCost: { netExpectancyPct },
  }
}

function makeDelta(overrides: Partial<Record<string, number | Record<string, number>>> = {}) {
  return {
    totalReturnPct: 0,
    netExpectancyPct: 0,
    maxDrawdownPct: 0,
    tradeCount: 0,
    sharpe: 0,
    sortino: 0,
    calmar: 0,
    byRegimeNetExpectancyPct: {},
    ...overrides,
  }
}

function makeArm(input: {
  armId: string
  label?: string
  rank?: number
  metrics?: BacktestMetrics
  diagnostics?: Record<string, unknown>
  selection?: Record<string, unknown>
  gate?: { allowedEntryRegimes: StrategyRegimeLabel[]; exitOnMismatch?: boolean }
}) {
  const metrics = input.metrics ?? makeMetrics()
  return {
    armId: input.armId,
    label: input.label ?? input.armId,
    rank: input.rank ?? 1,
    metrics,
    baselineReport: makeBaselineReport(metrics.netExpectancyPct),
    delta: makeDelta(),
    diagnostics: input.diagnostics,
    selection: input.selection,
    gate: input.gate,
  }
}

function runValidationPipeline(args: string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      './node_modules/.bin/tsx',
      ['scripts/run_validation_pipeline.ts', ...args],
      {
        cwd: resolve('.'),
        stdio: 'ignore',
      },
    )

    child.on('close', (code) => {
      if (code == null) {
        reject(new Error('run_validation_pipeline exited without a code'))
        return
      }
      resolvePromise(code)
    })
    child.on('error', reject)
  })
}
describe('run_validation_pipeline', () => {
  it('emits additive regime-gate and meta-label quantile A/B outputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oa-validation-pipeline-'))
    const outputPath = join(root, 'validation.json')
    const statusPath = join(root, 'release-gate-status.json')

    const exitCode = await runValidationPipeline([
      '--inputCsv',
      'data/market/okx/BTC_USDT_USDT_1h.csv',
      '--symbol',
      'BTC/USD',
      '--strategy',
      'factorMeanReversion',
      '--lookbackBars',
      '1500',
      '--trainBars',
      '720',
      '--testBars',
      '240',
      '--stepBars',
      '240',
      '--riskSimulationCount',
      '100',
      '--output',
      outputPath,
      '--releaseGateStatusPath',
      statusPath,
    ])

    expect([0, 2]).toContain(exitCode)

    const report = JSON.parse(await readFile(outputPath, 'utf-8')) as {
      deployableStrategyTarget: {
        controlArm: {
          label: string
          source: string
          description: string
          metrics: { netExpectancyPct: number; maxDrawdownPct: number }
          baselineReport: {
            expectancyAfterCost: { netExpectancyPct: number }
          }
        }
        optimizationTarget: {
          primaryMetric: string
          objective: string
          measurement: string
          requirePositiveDeltaVsControlArm: boolean
        }
        robustnessTarget: {
          releaseGate: {
            currentStatus: {
              allowPaperTrading: boolean
              allowLiveTrading: boolean
              failedChecks: string[]
              warningChecks: string[]
            }
            paperTrading: { requireAllowPaperTrading: boolean; blockingChecks: string[] }
            liveTrading: { requireAllowLiveTrading: boolean; blockingChecks: string[] }
          }
        }
        practicalConstraints: {
          drawdown: {
            requireNoWorseThanControlArm: boolean
            maxDrawdownPctControlArm: number
          }
          tradeCount: {
            regimeGateMinRetentionPct: number
            metaLabelMinRetentionPct: number
          }
        }
      }
      abExperiments: {
        regimeGate: {
          enabled: boolean
          bestArm: { armId: string; gate: { allowedEntryRegimes: string[] } } | null
        }
        metaLabel: {
          enabled: boolean
          baseLabel: string
          evaluatedArmCount: number
          qualifiedArmCount: number
          selectionConstraints: { selectionModes: string[] }
          arms: Array<{
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          }>
          bestArm: {
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          } | null
          quantileDiagnostics: {
            netReturnAfterCost: { buckets: Array<unknown> }
            tripleBarrierReturn: { buckets: Array<unknown> }
          }
        }
        metaLabelWithBestRegimeGate: {
          enabled: boolean
          regimeGateSelection: {
            source: 'winner' | 'bestArm'
            gate: { allowedEntryRegimes: string[] }
            parentArmId: string | null
            parentArmQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          } | null
          evaluatedArmCount: number
          qualifiedArmCount: number
          selectionConstraints: { selectionModes: string[] }
          arms: Array<{
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          }>
          bestArm: {
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            }
            diagnostics: {
              qualifies: boolean
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }
          } | null
          quantileDiagnostics: {
            netReturnAfterCost: { buckets: Array<unknown> }
            tripleBarrierReturn: { buckets: Array<unknown> }
          }
        }
      }
      recommendedCandidate: {
        controlArm: {
          label: string
          source: string
        }
        candidatesBySource: {
          regimeGate: null | { source: string; armId: string }
          metaLabel: null | {
            source: string
            armId: string
            diagnostics: {
              qualifies: boolean
              tradeCountRetentionPct: number
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            } | null
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            } | null
          }
          metaLabelWithBestRegimeGate: null | {
            source: string
            armId: string
            diagnostics: {
              qualifies: boolean
              tradeCountRetentionPct: number
              realizedTradeCount: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            } | null
            selection: {
              mode: string
              coveragePct: number
              selectedCandidateCount: number
              minScoreIncluded: number
              maxScoreIncluded: number
              byRegime: Array<{
                regime: string
                rawCandidateCount: number
                selectedCandidateCount: number
                realizedTradeCount: number
                selectedCoveragePct: number
                realizedSelectedCandidatePct: number
                selectedCandidateCollapseCount: number
              }>
            } | null
            regimeGateSelection: {
              source: 'winner' | 'bestArm'
              gate: { allowedEntryRegimes: string[] }
              parentArmId: string | null
              parentArmQualified: boolean | null
              bootstrappedFromUnqualifiedBestArm: boolean
            } | null
          }
        }
        candidateCount: number
        qualifiedCandidateCount: number
        champion: null | {
          source: string
          armId: string
          label: string
          diagnostics: {
            qualifies: boolean
            tradeCountRetentionPct: number
            realizedTradeCount: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          } | null
          selection: {
            mode: string
            coveragePct: number
            selectedCandidateCount: number
            minScoreIncluded: number
            maxScoreIncluded: number
            byRegime: Array<{
              regime: string
              rawCandidateCount: number
              selectedCandidateCount: number
              realizedTradeCount: number
              selectedCoveragePct: number
              realizedSelectedCandidatePct: number
              selectedCandidateCollapseCount: number
            }>
          } | null
          regimeGateSelection: {
            source: 'winner' | 'bestArm'
            gate: { allowedEntryRegimes: string[] }
            parentArmId: string | null
            parentArmQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          } | null
        }
        combinedWinnerEvidence: null | {
          champion: {
            source: string
            armId: string
            label: string
          }
          provenance: {
            parentRegimeGateSelectionSource: 'winner' | 'bestArm' | null
            parentRegimeGateArmId: string | null
            parentRegimeGateQualified: boolean | null
            bootstrappedFromUnqualifiedBestArm: boolean
          }
          summary: {
            beatsBothStandaloneArms: boolean
            beatsBothStandaloneArmsOnTotalReturn: boolean
            noWorseThanStandaloneArmsOnDrawdown: boolean
          }
          versusStandalone: {
            regimeGate: null | {
              comparator: { source: string; armId: string; label: string }
              delta: {
                netExpectancyPct: number
                totalReturnPct: number
                maxDrawdownPct: number
                tradeCount: number
                tradeCountRetentionPct: number
              }
              summary: {
                beatsOnNetExpectancy: boolean
                beatsOnTotalReturn: boolean
                noWorseDrawdown: boolean
                higherTradeCount: boolean
                higherTradeRetention: boolean
              }
            }
            metaLabel: null | {
              comparator: { source: string; armId: string; label: string }
              delta: {
                netExpectancyPct: number
                totalReturnPct: number
                maxDrawdownPct: number
                tradeCount: number
                tradeCountRetentionPct: number
              }
              summary: {
                beatsOnNetExpectancy: boolean
                beatsOnTotalReturn: boolean
                noWorseDrawdown: boolean
                higherTradeCount: boolean
                higherTradeRetention: boolean
              }
            }
          }
        }
        selectionDiagnosticsSummary: null | {
          source: string
          armId: string
          label: string
          mode: string | null
          coveragePct: number | null
          selectedCandidateCount: number
          realizedTradeCount: number
          realizedSelectedCandidatePct: number
          selectedCandidateCollapseCount: number
          weakestRegime: null | {
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }
          weakRegimes: Array<{
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }>
          byRegime: Array<{
            regime: string
            rawCandidateCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            selectedCoveragePct: number
            realizedSelectedCandidatePct: number
            selectedCandidateCollapseCount: number
          }>
        }
        releaseGateStatus: {
          allowPaperTrading: boolean
          allowLiveTrading: boolean
          failedChecks: string[]
          warningChecks: string[]
        }
        recommendation: {
          action: 'promote_candidate' | 'stay_on_baseline'
          targetSource: string
          targetArmId: string | null
          targetLabel: string
          fallbackToBaseline: boolean
          reasonCodes: string[]
          regimeCollapseWarnings: Array<{
            regime: string
            selectedCandidateCollapseCount: number
            selectedCandidateCount: number
            realizedTradeCount: number
            realizedSelectedCandidatePct: number
            isWeakestRegime: boolean
            warning: string
          }>
        }
      }
    }
    const status = JSON.parse(await readFile(statusPath, 'utf-8')) as {
      sourceReportPath: string
    }

    expect(report.deployableStrategyTarget.controlArm.label).toBe('current_runtime_baseline')
    expect(report.deployableStrategyTarget.controlArm.source).toBe('selected_runtime_baseline')
    expect(
      report.deployableStrategyTarget.controlArm.baselineReport.expectancyAfterCost.netExpectancyPct,
    ).toBe(report.deployableStrategyTarget.controlArm.metrics.netExpectancyPct)
    expect(report.deployableStrategyTarget.optimizationTarget.primaryMetric).toBe('netExpectancyPct')
    expect(report.deployableStrategyTarget.optimizationTarget.requirePositiveDeltaVsControlArm).toBe(true)
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.paperTrading.blockingChecks,
    ).toEqual(['wfo', 'significance', 'risk_simulation', 'economics'])
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.liveTrading.blockingChecks,
    ).toEqual([
      'wfo',
      'significance',
      'risk_simulation',
      'economics',
      'execution_quality',
      'ramp_up',
      'regime_shift',
    ])
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.paperTrading.requireAllowPaperTrading,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.robustnessTarget.releaseGate.liveTrading.requireAllowLiveTrading,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.practicalConstraints.drawdown.requireNoWorseThanControlArm,
    ).toBe(true)
    expect(
      report.deployableStrategyTarget.practicalConstraints.drawdown.maxDrawdownPctControlArm,
    ).toBe(report.deployableStrategyTarget.controlArm.metrics.maxDrawdownPct)
    expect(report.deployableStrategyTarget.practicalConstraints.tradeCount.regimeGateMinRetentionPct).toBe(30)
    expect(report.deployableStrategyTarget.practicalConstraints.tradeCount.metaLabelMinRetentionPct).toBe(5)

    expect(report.abExperiments.regimeGate.enabled).toBe(true)
    expect(report.abExperiments.regimeGate.bestArm?.gate.allowedEntryRegimes.length).toBeGreaterThan(0)

    expect(report.abExperiments.metaLabel.enabled).toBe(true)
    expect(report.abExperiments.metaLabel.baseLabel).toBe('baseline')
    expect(report.abExperiments.metaLabel.evaluatedArmCount).toBe(10)
    expect(report.abExperiments.metaLabel.qualifiedArmCount).toBe(0)
    expect(report.abExperiments.metaLabel.selectionConstraints.selectionModes).toEqual([
      'global',
      'perRegime',
    ])
    expect(report.abExperiments.metaLabel.arms).toHaveLength(10)
    expect(
      report.abExperiments.metaLabel.arms
        .map((arm) => `${arm.selection.mode}:${arm.selection.coveragePct}`)
        .sort(),
    ).toEqual([
      'global:10',
      'global:20',
      'global:30',
      'global:5',
      'global:50',
      'perRegime:10',
      'perRegime:20',
      'perRegime:30',
      'perRegime:5',
      'perRegime:50',
    ])
    expect(report.abExperiments.metaLabel.quantileDiagnostics.netReturnAfterCost.buckets).toHaveLength(5)
    expect(report.abExperiments.metaLabel.quantileDiagnostics.tripleBarrierReturn.buckets).toHaveLength(5)
    for (const arm of report.abExperiments.metaLabel.arms) {
      expect(arm.selection.byRegime).toHaveLength(4)
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.selectedCandidateCount, 0)).toBe(
        arm.selection.selectedCandidateCount,
      )
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.realizedTradeCount, 0)).toBe(
        arm.diagnostics.realizedTradeCount,
      )
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCandidateCount <= regime.rawCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.realizedTradeCount <= regime.selectedCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCoveragePct >= 0 && regime.selectedCoveragePct <= 100),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.realizedSelectedCandidatePct >= 0 && regime.realizedSelectedCandidatePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.selectedCandidateCollapseCount ===
            regime.selectedCandidateCount - regime.realizedTradeCount,
        ),
      ).toBe(true)
    }
    expect(report.abExperiments.metaLabel.bestArm?.selection.coveragePct).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabel.bestArm?.selection.mode).toMatch(/^(global|perRegime)$/)
    expect(report.abExperiments.metaLabel.bestArm?.selection.maxScoreIncluded).toBeGreaterThanOrEqual(
      report.abExperiments.metaLabel.bestArm?.selection.minScoreIncluded ?? 0,
    )
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedTradeCount).toBeLessThanOrEqual(
      report.abExperiments.metaLabel.bestArm?.selection.selectedCandidateCount ?? 0,
    )
    expect(report.abExperiments.metaLabel.bestArm?.selection.byRegime).toHaveLength(4)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabel.bestArm?.selection.selectedCandidateCount)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedTradeCount)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.every(
        (regime) => regime.realizedTradeCount <= regime.selectedCandidateCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabel.bestArm?.selection.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.realizedSelectedCandidatePct).toBeLessThanOrEqual(100)
    expect(report.abExperiments.metaLabel.bestArm?.diagnostics.selectedCandidateCollapseCount).toBeGreaterThanOrEqual(0)
    const perRegimeArm = report.abExperiments.metaLabel.arms.find(
      (arm) => arm.selection.mode === 'perRegime' && arm.selection.coveragePct === 30,
    )
    expect(perRegimeArm?.selection.byRegime).toHaveLength(4)
    expect(
      perRegimeArm?.selection.byRegime.every(
        (bucket) =>
          bucket.selectedCandidateCount <= bucket.rawCandidateCount &&
          bucket.realizedTradeCount <= bucket.selectedCandidateCount &&
          bucket.selectedCandidateCollapseCount ===
            bucket.selectedCandidateCount - bucket.realizedTradeCount,
      ),
    ).toBe(true)

    expect(report.abExperiments.metaLabelWithBestRegimeGate.enabled).toBe(true)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection).toBeTruthy()
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.source,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.gate.allowedEntryRegimes.length,
    ).toBeGreaterThan(0)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmId,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId ?? null)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmQualified,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified ?? null)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection?.parentArmQualified,
    ).toBe(true)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.parentArmId,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId ?? null)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.parentArmQualified,
    ).toBe(report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified ?? null)
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.evaluatedArmCount).toBe(10)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.qualifiedArmCount).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.selectionConstraints.selectionModes).toEqual([
      'global',
      'perRegime',
    ])
    expect(report.abExperiments.metaLabelWithBestRegimeGate.arms).toHaveLength(10)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.arms
        .map((arm) => `${arm.selection.mode}:${arm.selection.coveragePct}`)
        .sort(),
    ).toEqual([
      'global:10',
      'global:20',
      'global:30',
      'global:5',
      'global:50',
      'perRegime:10',
      'perRegime:20',
      'perRegime:30',
      'perRegime:5',
      'perRegime:50',
    ])
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.quantileDiagnostics.netReturnAfterCost.buckets,
    ).toHaveLength(5)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.quantileDiagnostics.tripleBarrierReturn.buckets,
    ).toHaveLength(5)
    for (const arm of report.abExperiments.metaLabelWithBestRegimeGate.arms) {
      expect(arm.selection.byRegime).toHaveLength(4)
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.selectedCandidateCount, 0)).toBe(
        arm.selection.selectedCandidateCount,
      )
      expect(arm.selection.byRegime.reduce((sum, regime) => sum + regime.realizedTradeCount, 0)).toBe(
        arm.diagnostics.realizedTradeCount,
      )
      expect(
        arm.selection.byRegime.every((regime) => regime.selectedCandidateCount <= regime.rawCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every((regime) => regime.realizedTradeCount <= regime.selectedCandidateCount),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) => regime.selectedCoveragePct >= 0 && regime.selectedCoveragePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.realizedSelectedCandidatePct >= 0 && regime.realizedSelectedCandidatePct <= 100,
        ),
      ).toBe(true)
      expect(
        arm.selection.byRegime.every(
          (regime) =>
            regime.selectedCandidateCollapseCount ===
            regime.selectedCandidateCount - regime.realizedTradeCount,
        ),
      ).toBe(true)
    }
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.coveragePct).toBeGreaterThan(0)
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.mode).toMatch(
      /^(global|perRegime)$/,
    )
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.maxScoreIncluded,
    ).toBeGreaterThanOrEqual(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.minScoreIncluded ?? 0,
    )
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedTradeCount,
    ).toBeLessThanOrEqual(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.selectedCandidateCount ?? 0,
    )
    expect(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime).toHaveLength(4)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.selectedCandidateCount)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedTradeCount)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (regime) => regime.realizedTradeCount <= regime.selectedCandidateCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.realizedSelectedCandidatePct,
    ).toBeLessThanOrEqual(100)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.diagnostics.selectedCandidateCollapseCount,
    ).toBeGreaterThanOrEqual(0)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime,
    ).toHaveLength(4)
    expect(
      report.abExperiments.metaLabelWithBestRegimeGate.bestArm?.selection.byRegime.every(
        (bucket) =>
          bucket.selectedCandidateCount <= bucket.rawCandidateCount &&
          bucket.realizedTradeCount <= bucket.selectedCandidateCount &&
          bucket.selectedCandidateCollapseCount ===
            bucket.selectedCandidateCount - bucket.realizedTradeCount,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.champion?.selection?.byRegime,
    ).toHaveLength(4)

    const recommendedMetaLabel = report.recommendedCandidate.candidatesBySource.metaLabel
    const recommendedCombined = report.recommendedCandidate.candidatesBySource.metaLabelWithBestRegimeGate
    const combinedBestArm = report.abExperiments.metaLabelWithBestRegimeGate.bestArm
    const combinedRegimeGateSelection = report.abExperiments.metaLabelWithBestRegimeGate.regimeGateSelection

    expect(report.recommendedCandidate.controlArm.label).toBe('current_runtime_baseline')
    expect(report.recommendedCandidate.controlArm.source).toBe('selected_runtime_baseline')
    expect(report.recommendedCandidate.candidateCount).toBeGreaterThan(0)
    expect(report.recommendedCandidate.qualifiedCandidateCount).toBeGreaterThan(0)
    expect(report.recommendedCandidate.candidatesBySource.regimeGate?.source).toBe('regimeGate')
    expect(recommendedMetaLabel?.source).toBe('metaLabel')
    expect(recommendedMetaLabel?.diagnostics?.realizedTradeCount).toBeGreaterThan(0)
    expect(recommendedMetaLabel?.diagnostics?.realizedSelectedCandidatePct).toBeGreaterThan(0)
    expect(recommendedMetaLabel?.diagnostics?.selectedCandidateCollapseCount).toBeGreaterThanOrEqual(0)
    expect(recommendedMetaLabel?.selection?.byRegime).toHaveLength(4)
    expect(
      recommendedMetaLabel?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(recommendedMetaLabel?.diagnostics?.realizedTradeCount)
    expect(
      recommendedMetaLabel?.selection?.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(combinedBestArm).toBeTruthy()
    expect(combinedRegimeGateSelection).toBeTruthy()
    expect(recommendedCombined?.source).toBe('metaLabelWithBestRegimeGate')
    expect(recommendedCombined?.armId).toBe(combinedBestArm?.armId)
    expect(recommendedCombined?.selection?.mode).toBe(combinedBestArm?.selection.mode)
    expect(recommendedCombined?.selection?.coveragePct).toBe(combinedBestArm?.selection.coveragePct)
    expect(recommendedCombined?.selection?.selectedCandidateCount).toBe(
      combinedBestArm?.selection.selectedCandidateCount,
    )
    expect(recommendedCombined?.selection?.minScoreIncluded).toBe(
      combinedBestArm?.selection.minScoreIncluded,
    )
    expect(recommendedCombined?.selection?.maxScoreIncluded).toBe(
      combinedBestArm?.selection.maxScoreIncluded,
    )
    expect(recommendedCombined?.selection?.byRegime).toEqual(combinedBestArm?.selection.byRegime)
    expect(recommendedCombined?.diagnostics?.qualifies).toBe(combinedBestArm?.diagnostics.qualifies)
    expect(recommendedCombined?.diagnostics?.realizedTradeCount).toBe(
      combinedBestArm?.diagnostics.realizedTradeCount,
    )
    expect(recommendedCombined?.diagnostics?.realizedSelectedCandidatePct).toBe(
      combinedBestArm?.diagnostics.realizedSelectedCandidatePct,
    )
    expect(recommendedCombined?.diagnostics?.selectedCandidateCollapseCount).toBe(
      combinedBestArm?.diagnostics.selectedCandidateCollapseCount,
    )
    expect(recommendedCombined?.diagnostics?.tradeCountRetentionPct).toBeGreaterThan(0)
    expect(recommendedCombined?.selection?.byRegime).toHaveLength(4)
    expect(
      recommendedCombined?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(recommendedCombined?.diagnostics?.realizedTradeCount)
    expect(recommendedCombined?.regimeGateSelection).toEqual(combinedRegimeGateSelection)
    expect(
      recommendedCombined?.selection?.byRegime.every(
        (regime) =>
          regime.selectedCandidateCollapseCount ===
          regime.selectedCandidateCount - regime.realizedTradeCount,
      ),
    ).toBe(true)
    expect(report.recommendedCandidate.champion).toBeTruthy()
    expect(report.recommendedCandidate.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.recommendedCandidate.champion?.armId).toBe(recommendedCombined?.armId)
    expect(report.recommendedCandidate.champion?.armId).toMatch(
      /^meta_label_(global|perRegime)_top_\d+pct$/,
    )
    expect(report.recommendedCandidate.champion?.diagnostics).toEqual(recommendedCombined?.diagnostics ?? null)
    expect(report.recommendedCandidate.champion?.selection).toEqual(recommendedCombined?.selection ?? null)
    expect(report.recommendedCandidate.champion?.regimeGateSelection).toEqual(
      recommendedCombined?.regimeGateSelection ?? null,
    )
    expect(report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount).toBe(10)
    expect(report.recommendedCandidate.champion?.diagnostics?.realizedSelectedCandidatePct).toBeGreaterThan(0)
    expect(report.recommendedCandidate.champion?.selection?.maxScoreIncluded).toBeGreaterThanOrEqual(
      report.recommendedCandidate.champion?.selection?.minScoreIncluded ?? 0,
    )
    expect(report.recommendedCandidate.champion?.selection?.coveragePct).toBeGreaterThan(0)
    expect(report.recommendedCandidate.champion?.selection?.mode).toBe('perRegime')
    expect(report.recommendedCandidate.champion?.selection?.byRegime).toHaveLength(4)
    expect(
      report.recommendedCandidate.champion?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount)
    expect(report.recommendedCandidate.champion?.regimeGateSelection).toBeTruthy()
    expect(
      report.recommendedCandidate.champion?.regimeGateSelection?.source,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.champion.source,
    ).toBe(recommendedCombined?.source)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.champion.armId,
    ).toBe(recommendedCombined?.armId)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource,
    ).toBe(combinedRegimeGateSelection?.source ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId,
    ).toBe(combinedRegimeGateSelection?.parentArmId ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified,
    ).toBe(combinedRegimeGateSelection?.parentArmQualified ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm,
    ).toBe(combinedRegimeGateSelection?.bootstrappedFromUnqualifiedBestArm ?? false)
    expect(report.recommendedCandidate.combinedWinnerEvidence).toBeTruthy()
    expect(report.recommendedCandidate.combinedWinnerEvidence?.champion.source).toBe(
      'metaLabelWithBestRegimeGate',
    )
    expect(report.recommendedCandidate.combinedWinnerEvidence?.champion.armId).toBe(
      report.recommendedCandidate.champion?.armId,
    )
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource,
    ).toMatch(/^(winner|bestArm)$/)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateArmId,
    ).toBe(report.recommendedCandidate.candidatesBySource.regimeGate?.armId ?? null)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.parentRegimeGateQualified,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm,
    ).toBe(false)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary.beatsBothStandaloneArms,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary
        .noWorseThanStandaloneArmsOnDrawdown,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.summary
        .beatsBothStandaloneArmsOnTotalReturn,
    ).toBe(false)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.comparator.source,
    ).toBe('regimeGate')
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.summary
        .beatsOnNetExpectancy,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.regimeGate?.delta
        .netExpectancyPct,
    ).toBeGreaterThan(0)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.comparator.source,
    ).toBe('metaLabel')
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.summary
        .beatsOnNetExpectancy,
    ).toBe(true)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.delta
        .netExpectancyPct,
    ).toBeGreaterThan(0)
    expect(
      report.recommendedCandidate.combinedWinnerEvidence?.versusStandalone.metaLabel?.summary
        .noWorseDrawdown,
    ).toBe(true)
    expect(report.recommendedCandidate.selectionDiagnosticsSummary).toBeTruthy()
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.armId).toBe(
      report.recommendedCandidate.champion?.armId,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.source).toBe(
      report.recommendedCandidate.champion?.source,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.mode).toBe(
      report.recommendedCandidate.champion?.selection?.mode ?? null,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.coveragePct).toBe(
      report.recommendedCandidate.champion?.selection?.coveragePct ?? null,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedTradeCount).toBe(
      report.recommendedCandidate.champion?.diagnostics?.realizedTradeCount ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(
      report.recommendedCandidate.champion?.diagnostics?.realizedSelectedCandidatePct ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(
      report.recommendedCandidate.champion?.selection?.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCollapseCount,
        0,
      ) ?? 0,
    )
    expect(report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime).toHaveLength(4)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime.reduce(
        (sum, regime) => sum + regime.realizedTradeCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.selectionDiagnosticsSummary?.realizedTradeCount)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime.reduce(
        (sum, regime) => sum + regime.selectedCandidateCount,
        0,
      ),
    ).toBe(report.recommendedCandidate.selectionDiagnosticsSummary?.selectedCandidateCount)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakRegimes.every(
        (regime) => regime.selectedCandidateCollapseCount > 0,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount ?? 0,
    ).toBeGreaterThanOrEqual(0)
    expect(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount,
    ).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.byRegime[0]?.selectedCandidateCollapseCount,
    )

    expect(report.recommendedCandidate.releaseGateStatus.allowLiveTrading).toBe(false)
    expect(report.recommendedCandidate.releaseGateStatus.warningChecks).toEqual([])
    expect(report.recommendedCandidate.recommendation.action).toBe('stay_on_baseline')
    expect(report.recommendedCandidate.recommendation.targetSource).toBe('baseline')
    expect(report.recommendedCandidate.recommendation.targetArmId).toBeNull()
    expect(report.recommendedCandidate.recommendation.targetLabel).toBe('current_runtime_baseline')
    expect(report.recommendedCandidate.recommendation.fallbackToBaseline).toBe(true)
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('PAPER_RELEASE_GATE_BLOCKED')
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('LIVE_RELEASE_GATE_BLOCKED')
    expect(report.recommendedCandidate.recommendation.reasonCodes).toContain('CHAMPION_LOW_TRADE_RETENTION')
    expect(report.recommendedCandidate.recommendation.regimeCollapseWarnings).toHaveLength(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakRegimes.length ?? 0,
    )
    expect(report.recommendedCandidate.recommendation.regimeCollapseWarnings[0]?.regime).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.regime,
    )
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings[0]?.selectedCandidateCollapseCount,
    ).toBe(
      report.recommendedCandidate.selectionDiagnosticsSummary?.weakestRegime?.selectedCandidateCollapseCount,
    )
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings.every(
        (warning) => warning.selectedCandidateCollapseCount > 0,
      ),
    ).toBe(true)
    expect(
      report.recommendedCandidate.recommendation.regimeCollapseWarnings.filter(
        (warning) => warning.isWeakestRegime,
      ),
    ).toHaveLength(report.recommendedCandidate.recommendation.regimeCollapseWarnings.length > 0 ? 1 : 0)

    expect(status.sourceReportPath).toBe(outputPath)
  })

  it('reports qualified regime-gate winner provenance for combined champion evidence', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 70 },
            selection: { mode: 'perRegime', coveragePct: 30 },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.regimeGateSelection?.source).toBe('winner')
    expect(report.champion?.regimeGateSelection?.parentArmId).toBe('regime_gate_winner')
    expect(report.champion?.regimeGateSelection?.parentArmQualified).toBe(true)
    expect(report.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm).toBe(false)
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe('winner')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe('regime_gate_winner')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(true)
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(false)
    expect(report.selectionDiagnosticsSummary).toBeNull()
  })

  it('reports unqualified bestArm fallback provenance for combined champion evidence', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: null,
          bestArm: makeArm({
            armId: 'regime_gate_fallback',
            metrics: makeMetrics({ netExpectancyPct: 0.4, tradeCount: 12 }),
            diagnostics: { qualifies: false, tradeCountRetentionPct: 60 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 70 },
            selection: { mode: 'perRegime', coveragePct: 30 },
          }),
          regimeGateSelection: {
            source: 'bestArm',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_fallback',
            parentArmQualified: false,
            bootstrappedFromUnqualifiedBestArm: true,
          },
        },
      },
    })

    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.regimeGateSelection?.source).toBe('bestArm')
    expect(report.champion?.regimeGateSelection?.parentArmId).toBe('regime_gate_fallback')
    expect(report.champion?.regimeGateSelection?.parentArmQualified).toBe(false)
    expect(report.champion?.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm).toBe(true)
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe('bestArm')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe('regime_gate_fallback')
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(false)
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(true)
    expect(report.selectionDiagnosticsSummary).toBeNull()
    expect(report.recommendation.regimeCollapseWarnings).toEqual([])
  })

  it('derives and sorts selection diagnostics summary deterministically', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: ['regime_shift_watch'],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: {
              qualifies: true,
              tradeCountRetentionPct: 70,
              realizedTradeCount: 9,
              realizedSelectedCandidatePct: 75,
              selectedCandidateCollapseCount: 3,
            },
            selection: {
              mode: 'perRegime',
              coveragePct: 30,
              selectedCandidateCount: 12,
              byRegime: [
                {
                  regime: 'LowVolTrend',
                  rawCandidateCount: 5,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 60,
                  realizedSelectedCandidatePct: 66.67,
                  selectedCandidateCollapseCount: 1,
                },
                {
                  regime: 'HighVolChop',
                  rawCandidateCount: 4,
                  selectedCandidateCount: 2,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 50,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'HighVolTrend',
                  rawCandidateCount: 6,
                  selectedCandidateCount: 4,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 50,
                },
                {
                  regime: 'LowVolChop',
                  rawCandidateCount: 3,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 3,
                  selectedCoveragePct: 100,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
              ],
            },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.releaseGateStatus.warningChecks).toEqual(['regime_shift_watch'])
    expect(report.champion?.source).toBe('metaLabelWithBestRegimeGate')
    expect(report.champion?.armId).toBe(report.candidatesBySource.metaLabelWithBestRegimeGate?.armId)
    expect(report.champion?.label).toBe(report.candidatesBySource.metaLabelWithBestRegimeGate?.label)
    expect(report.champion?.diagnostics).toEqual(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics,
    )
    expect(report.champion?.selection).toEqual(report.candidatesBySource.metaLabelWithBestRegimeGate?.selection)
    expect(report.champion?.regimeGateSelection).toEqual(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection,
    )
    expect(report.combinedWinnerEvidence?.champion).toEqual({
      source: report.candidatesBySource.metaLabelWithBestRegimeGate?.source,
      armId: report.candidatesBySource.metaLabelWithBestRegimeGate?.armId,
      label: report.candidatesBySource.metaLabelWithBestRegimeGate?.label,
    })
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateSelectionSource).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.source ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateArmId).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.parentArmId ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.parentRegimeGateQualified).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection?.parentArmQualified ?? null,
    )
    expect(report.combinedWinnerEvidence?.provenance.bootstrappedFromUnqualifiedBestArm).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.regimeGateSelection
        ?.bootstrappedFromUnqualifiedBestArm ?? false,
    )
    expect(report.selectionDiagnosticsSummary?.source).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.source,
    )
    expect(report.selectionDiagnosticsSummary?.armId).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.armId,
    )
    expect(report.selectionDiagnosticsSummary?.label).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.label,
    )
    expect(report.selectionDiagnosticsSummary?.mode).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.mode ?? null,
    )
    expect(report.selectionDiagnosticsSummary?.coveragePct).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.coveragePct ?? null,
    )
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.selection?.selectedCandidateCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedTradeCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.realizedTradeCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.realizedSelectedCandidatePct ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(
      report.candidatesBySource.metaLabelWithBestRegimeGate?.diagnostics?.selectedCandidateCollapseCount ?? 0,
    )
    expect(report.selectionDiagnosticsSummary?.realizedSelectedCandidatePct).toBe(75)
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCount).toBe(12)
    expect(report.selectionDiagnosticsSummary?.selectedCandidateCollapseCount).toBe(3)
    expect(report.selectionDiagnosticsSummary?.byRegime.map((regime) => regime.regime)).toEqual([
      'HighVolTrend',
      'LowVolTrend',
      'LowVolChop',
      'HighVolChop',
    ])
    expect(report.selectionDiagnosticsSummary?.byRegime[0]).toEqual({
      regime: 'HighVolTrend',
      rawCandidateCount: 6,
      selectedCandidateCount: 4,
      realizedTradeCount: 2,
      selectedCoveragePct: 66.67,
      realizedSelectedCandidatePct: 50,
      selectedCandidateCollapseCount: 2,
    })
    expect(report.selectionDiagnosticsSummary?.weakestRegime).toEqual(
      report.selectionDiagnosticsSummary?.byRegime[0],
    )
    expect(report.selectionDiagnosticsSummary?.weakRegimes).toEqual([
      {
        regime: 'HighVolTrend',
        rawCandidateCount: 6,
        selectedCandidateCount: 4,
        realizedTradeCount: 2,
        selectedCoveragePct: 66.67,
        realizedSelectedCandidatePct: 50,
        selectedCandidateCollapseCount: 2,
      },
      {
        regime: 'LowVolTrend',
        rawCandidateCount: 5,
        selectedCandidateCount: 3,
        realizedTradeCount: 2,
        selectedCoveragePct: 60,
        realizedSelectedCandidatePct: 66.67,
        selectedCandidateCollapseCount: 1,
      },
    ])
    expect(report.recommendation.regimeCollapseWarnings).toEqual([
      {
        regime: 'HighVolTrend',
        selectedCandidateCollapseCount: 2,
        selectedCandidateCount: 4,
        realizedTradeCount: 2,
        realizedSelectedCandidatePct: 50,
        isWeakestRegime: true,
        warning: 'Selection collapsed 2 of 4 candidates in HighVolTrend.',
      },
      {
        regime: 'LowVolTrend',
        selectedCandidateCollapseCount: 1,
        selectedCandidateCount: 3,
        realizedTradeCount: 2,
        realizedSelectedCandidatePct: 66.67,
        isWeakestRegime: false,
        warning: 'Selection collapsed 1 of 3 candidates in LowVolTrend.',
      },
    ])
  })

  it('surfaces recommendation regime collapse warnings from weak regimes', () => {
    const report = buildRecommendedCandidate({
      baselineMetrics: makeMetrics(),
      baselineReport: makeBaselineReport(),
      releaseGate: {
        allowPaperTrading: true,
        allowLiveTrading: true,
        failedChecks: [],
        warningChecks: [],
        checks: [],
      },
      abExperiments: {
        regimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'regime_gate_winner',
            metrics: makeMetrics({ netExpectancyPct: 0.6, tradeCount: 16 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 80 },
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
          }),
        },
        metaLabel: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_global_top_50pct',
            metrics: makeMetrics({ netExpectancyPct: 0.5, tradeCount: 12 }),
            diagnostics: { qualifies: true, tradeCountRetentionPct: 60 },
            selection: { mode: 'global', coveragePct: 50 },
          }),
        },
        metaLabelWithBestRegimeGate: {
          enabled: true,
          winner: makeArm({
            armId: 'meta_label_perRegime_top_30pct',
            label: 'baseline_plus_best_regime_gate_plus_meta_label_perRegime_top_30pct',
            metrics: makeMetrics({ netExpectancyPct: 1.2, totalReturnPct: 3, tradeCount: 14 }),
            diagnostics: {
              qualifies: true,
              tradeCountRetentionPct: 70,
              realizedTradeCount: 7,
              realizedSelectedCandidatePct: 70,
              selectedCandidateCollapseCount: 3,
            },
            selection: {
              mode: 'perRegime',
              coveragePct: 30,
              selectedCandidateCount: 10,
              byRegime: [
                {
                  regime: 'HighVolTrend',
                  rawCandidateCount: 6,
                  selectedCandidateCount: 4,
                  realizedTradeCount: 1,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 25,
                  selectedCandidateCollapseCount: 3,
                },
                {
                  regime: 'LowVolTrend',
                  rawCandidateCount: 4,
                  selectedCandidateCount: 3,
                  realizedTradeCount: 3,
                  selectedCoveragePct: 75,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'HighVolChop',
                  rawCandidateCount: 3,
                  selectedCandidateCount: 2,
                  realizedTradeCount: 2,
                  selectedCoveragePct: 66.67,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
                {
                  regime: 'LowVolChop',
                  rawCandidateCount: 2,
                  selectedCandidateCount: 1,
                  realizedTradeCount: 1,
                  selectedCoveragePct: 50,
                  realizedSelectedCandidatePct: 100,
                  selectedCandidateCollapseCount: 0,
                },
              ],
            },
          }),
          regimeGateSelection: {
            source: 'winner',
            gate: { allowedEntryRegimes: ['HighVolTrend'] },
            parentArmId: 'regime_gate_winner',
            parentArmQualified: true,
            bootstrappedFromUnqualifiedBestArm: false,
          },
        },
      },
    })

    expect(report.selectionDiagnosticsSummary?.weakestRegime?.regime).toBe('HighVolTrend')
    expect(report.recommendation.regimeCollapseWarnings).toEqual([
      {
        regime: 'HighVolTrend',
        selectedCandidateCollapseCount: 3,
        selectedCandidateCount: 4,
        realizedTradeCount: 1,
        realizedSelectedCandidatePct: 25,
        isWeakestRegime: true,
        warning: 'Selection collapsed 3 of 4 candidates in HighVolTrend.',
      },
    ])
  })
})
