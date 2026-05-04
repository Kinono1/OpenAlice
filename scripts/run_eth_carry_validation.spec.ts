import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildCarryBaselineReport,
  buildCarryPaperPortfolioTarget,
  buildCarryValidationReport,
  parseArgs,
  resolveCurrentCarrySignal,
  summarizeCarryMetrics,
  writeCarryRuntimeArtifacts,
} from './run_eth_carry_validation.ts'

describe('run_eth_carry_validation reporting bridge', () => {
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

  it('materializes a unified validation report and keeps release-pass carry candidates actionable', () => {
    const candidate = {
      id: 'carry_24h_z13',
      minAbsFundingSpread: 0.0001,
      minAbsFundingZScore: 1.3,
      maxHoldingBars: 24,
      stopLossPct: 0.015,
      positionPctOfEquity: 0.015,
      signalPersistenceBars: 8,
    }
    const trades = [
      {
        direction: 'long_pair' as const,
        entryTime: 1,
        entryPrice: 1,
        exitTime: 25,
        exitPrice: 1.02,
        holdingBars: 24,
        holdingHours: 24,
        rawReturnPct: 0.02,
        feeDragPct: 0.0012,
        slippageDragPct: 0.0012,
        fundingDragPct: -0.0004,
        totalCostPct: 0.002,
        netReturnPct: 0.018,
        fundingSpreadAtEntry: -0.00012,
      },
    ]
    const metrics = {
      initialCapital: 1,
      finalEquity: 1.0052,
      totalReturnPct: 0.52,
      grossExpectancyPct: 0.02,
      netExpectancyPct: 0.0155,
      feeExpectancyDragPct: 0.0012,
      slippageExpectancyDragPct: 0.0012,
      fundingExpectancyDragPct: -0.0004,
      totalCostsPaid: 0.00002,
      totalFeesPaid: 0.000012,
      totalSlippagePaid: 0.000012,
      totalFundingPaid: -0.000004,
      costDragPctOfInitialCapital: 0.002,
      totalTurnoverUsd: 1.14,
      turnoverPctOfInitialCapital: 114,
      averageTurnoverPctPerTrade: 3,
      tradeCount: 38,
      longTradeCount: 35,
      shortTradeCount: 3,
      averageHoldingBars: 20.6,
      averageHoldingHours: 20.6,
      medianHoldingBars: 20.6,
      medianHoldingHours: 20.6,
      maxDrawdownPct: 0.09,
      sharpe: 2.71,
      sortino: 3.14,
    }
    const report = {
      candidate,
      trades,
      equityCurve: [],
      returns: [],
      metrics,
    }
    const validation = {
      selectedCandidate: candidate,
      selectedMetrics: metrics,
      trades,
      wfo: {
        overallPassed: true,
        failedWindows: 0,
        windows: [
          {
            windowIndex: 0,
            selectedCandidate: candidate.id,
            inSampleSharpe: 3.05,
            outOfSampleSharpe: 4.37,
            degradationRate: -0.43,
            gatePassed: true,
          },
        ],
      },
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.1,
          logits: [0.4],
          splitsEvaluated: 1,
          partitions: 6,
        },
        dsrResult: {
          observedSharpe: 0.029,
          benchmarkSharpe: 0.012,
          dsrValue: 0.017,
          dsrProbability: 0.93,
          skewness: 1.2,
          kurtosis: 4.5,
          trialCount: 4,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
      },
      riskSimulation: {
        method: 'moving_block_bootstrap' as const,
        simulations: 200,
        horizonBars: 1200,
        ruinDrawdownPct: 30,
        maxRuinProbability: 0.02,
        minProfitProbability: 0.55,
        confidenceLevel: 0.95,
        profitProbability: 0.88,
        riskOfRuin: 0,
        expectedFinalReturnPct: 0.12,
        medianFinalReturnPct: 0.11,
        confidenceInterval: {
          finalReturnPct: [-0.1, 0.37] as [number, number],
          maxDrawdownPct: [0, 0.16] as [number, number],
        },
        gatePassed: true,
      },
      releaseGate: {
        checks: [
          {
            name: 'wfo' as const,
            status: 'pass' as const,
            summary: 'WFO gate passed.',
            metrics: {},
          },
        ],
        failedChecks: [],
        warningChecks: [],
        hardFail: false,
        allowPaperTrading: true,
        allowLiveTrading: true,
      },
      strategyPlanEvidence: {
        sessionAwareSlippageEstimate: {
          available: true,
          tradeCount: 1,
          reason: null,
        },
      },
      equityCurve: [],
    }

    const baselineReport = buildCarryBaselineReport(report)
    expect(baselineReport.expectancyAfterCost.netExpectancyPct).toBe(metrics.netExpectancyPct)
    expect(baselineReport.expectancyAfterCost.fundingExpectancyDragPct).toBe(metrics.fundingExpectancyDragPct)

    const controlMetrics = summarizeCarryMetrics(metrics)
    expect(controlMetrics.tradeCount).toBe(metrics.tradeCount)
    expect(controlMetrics.calmar).toBeGreaterThan(0)

    const unified = buildCarryValidationReport({
      generatedAt: '2026-04-13T03-40-37.422Z',
      validationOutput: '/tmp/eth_carry.validation.json',
      releaseGateStatusPath: '/tmp/eth_carry.release_gate_status.json',
      args: {
        ethFundingPath: '/tmp/eth.json',
        btcFundingPath: '/tmp/btc.json',
        ethOpenInterestPath: undefined,
        btcOpenInterestPath: undefined,
        lookbackBars: 6000,
        trainBars: 3600,
        testBars: 1200,
        stepBars: 480,
        riskSimulationCount: 200,
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 1.3,
        minOpenInterestRatio: undefined,
        paperTargetBasisEquityUsd: 10_000,
        selfCheck: false,
        dryRun: false,
        writeRuntimeArtifacts: false,
      },
      leaderSymbol: 'ETH/USDT:USDT',
      hedgeSymbol: 'BTC/USDT:USDT',
      syntheticSymbol: 'ETH/BTC_CARRY',
      carrySignalLookback: 30,
      entryGate: {
        signalTimeCount: 3,
        firstSignalTime: 1,
        lastSignalTime: 3,
        artifactKind: 'historical_signal_observation',
        executable: false,
      },
      regimeGate: {
        allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
        exitOnMismatch: true,
      },
      candidateReports: [report],
      validation,
      selectionProtocol: {
        protocolVersion: 'eth_carry_short_bias_selection.v1',
        researchSelection: {
          artifactKind: 'research_selection',
          researchUniverseTrialCount: 336,
        },
        validationSelection: {
          artifactKind: 'validation_selection',
          selectedCandidateId: candidate.id,
        },
        finalHoldout: {
          artifactKind: 'final_holdout_result',
          selectedCandidateId: candidate.id,
        },
      },
    })

    expect(unified.schemaVersion).toBe('validation_pipeline_report.v1')
    expect(unified.deployableStrategyTarget.controlArm.baselineReport).toEqual(unified.baselineReport)
    expect(unified.recommendedCandidate.recommendation.action).toBe('promote_candidate')
    expect(unified.recommendedCandidate.recommendation.targetArmId).toBe(candidate.id)
    expect(unified.canonicalScoreboard.selectedCandidate.params).toEqual(candidate)
    expect(unified.canonicalScoreboard.significance.pbo).toBe(0.1)
    expect(unified.canonicalScoreboard.releaseGate.allowLiveTrading).toBe(true)
    expect(unified.validationEvidence.turnover.turnoverPctOfInitialCapital).toBe(114)
    expect(unified.validationEvidence.costAdjustedReturn.netExpectancyPct).toBe(metrics.netExpectancyPct)
    expect(unified.validationEvidence.longShortSideAsymmetry.long.tradeCount).toBe(1)
    expect(unified.validationEvidence.paperExecutionSlippage.available).toBe(false)
    expect(unified.validationEvidence.strategyPlanEvidence.sessionAwareSlippageEstimate.available).toBe(true)
    expect(unified.configuredGates.regimeGate).toEqual({
      allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
      exitOnMismatch: true,
      artifactKind: 'reported_regime_gate_metadata',
      executable: false,
      implementedInBacktest: false,
      note: 'Reported policy metadata only; the ETH carry backtest path does not execute a regime gate.',
    })
    expect(unified.configuredGates.entryGate).toEqual({
      signalTimeCount: 3,
      firstSignalTime: 1,
      lastSignalTime: 3,
      artifactKind: 'historical_signal_observation',
      executable: false,
    })
    expect(unified.selectionProtocol).toEqual({
      protocolVersion: 'eth_carry_short_bias_selection.v1',
      researchSelection: {
        artifactKind: 'research_selection',
        researchUniverseTrialCount: 336,
      },
      validationSelection: {
        artifactKind: 'validation_selection',
        selectedCandidateId: candidate.id,
      },
      finalHoldout: {
        artifactKind: 'final_holdout_result',
        selectedCandidateId: candidate.id,
      },
    })
    expect(unified.artifactPaths.validationOutput).toBe('/tmp/eth_carry.validation.json')
  })

  it('writes promotion-ready runtime artifacts for the carry champion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eth-carry-runtime-artifacts-'))
    const result = await writeCarryRuntimeArtifacts({
      generatedAt: '2026-04-13T03-54-52.967Z',
      validationRunsPath: join(dir, 'eth_carry.strategy_validation_runs.json'),
      experimentVerdictPath: join(dir, 'eth_carry.experiment_verdict.v2.json'),
      championRegistryPath: join(dir, 'eth_carry.paper_champion_registry.json'),
      validationOutput: join(dir, 'eth_carry.validation.json'),
      releaseGateStatusPath: join(dir, 'eth_carry.release_gate_status.json'),
      selectedCandidate: {
        id: 'carry_24h_z13',
        minAbsFundingSpread: 0.0001,
        minAbsFundingZScore: 1.3,
        maxHoldingBars: 24,
        stopLossPct: 0.015,
        positionPctOfEquity: 0.015,
        signalPersistenceBars: 8,
      },
      selectedMetrics: {
        initialCapital: 1,
        finalEquity: 1.0052,
        totalReturnPct: 0.52,
        grossExpectancyPct: 0.02,
        netExpectancyPct: 0.0155,
        feeExpectancyDragPct: 0.0012,
        slippageExpectancyDragPct: 0.0012,
        fundingExpectancyDragPct: -0.0004,
        totalCostsPaid: 0.00002,
        totalFeesPaid: 0.000012,
        totalSlippagePaid: 0.000012,
        totalFundingPaid: -0.000004,
        costDragPctOfInitialCapital: 0.002,
        tradeCount: 38,
        longTradeCount: 35,
        shortTradeCount: 3,
        averageHoldingBars: 20.6,
        averageHoldingHours: 20.6,
        medianHoldingBars: 20.6,
        medianHoldingHours: 20.6,
        maxDrawdownPct: 0.09,
        sharpe: 2.71,
      },
      significance: {
        passed: true,
        pboResult: {
          pbo: 0.1,
          logits: [0.4],
          splitsEvaluated: 1,
          partitions: 6,
        },
        dsrResult: {
          observedSharpe: 0.029,
          benchmarkSharpe: 0.012,
          dsrValue: 0.017,
          dsrProbability: 0.93,
          skewness: 1.2,
          kurtosis: 4.5,
          trialCount: 4,
        },
        pboThreshold: 0.2,
        dsrMin: 0,
      },
      releaseGate: {
        checks: [],
        failedChecks: [],
        warningChecks: [],
        hardFail: false,
        allowPaperTrading: true,
        allowLiveTrading: true,
      },
      leaderSymbol: 'ETH/USDT:USDT',
      hedgeSymbol: 'BTC/USDT:USDT',
      syntheticSymbol: 'ETH/BTC_CARRY',
      carrySignalLookback: 30,
      candidates: [
        {
          id: 'carry_24h_z13',
          minAbsFundingSpread: 0.0001,
          minAbsFundingZScore: 1.3,
          maxHoldingBars: 24,
          stopLossPct: 0.015,
          positionPctOfEquity: 0.015,
          signalPersistenceBars: 8,
        },
      ],
    })

    expect(result.strategyFamily).toBe('carry')
    expect(result.symbols).toEqual(['ETH/USDT:USDT', 'BTC/USDT:USDT'])

    const validationRuns = JSON.parse(await readFile(result.validationRunsPath, 'utf-8')) as {
      championSet: Array<{ symbol: string; strategyId: string }>
      candidates: Array<{ strategy: string }>
    }
    expect(validationRuns.championSet).toHaveLength(2)
    expect(validationRuns.candidates[0]?.strategy).toBe('carry')

    const verdict = JSON.parse(await readFile(result.experimentVerdictPath, 'utf-8')) as {
      result: string
      portfolio: { requiredSymbols: string[] }
    }
    expect(verdict.result).toBe('GO')
    expect(verdict.portfolio.requiredSymbols).toEqual(['ETH/USDT:USDT', 'BTC/USDT:USDT'])

    const registry = JSON.parse(await readFile(result.championRegistryPath, 'utf-8')) as {
      entries: Array<{ strategyFamily: string; symbols: string[] }>
    }
    expect(registry.entries[0]?.strategyFamily).toBe('carry')
    expect(registry.entries[0]?.symbols).toEqual(['ETH/USDT:USDT', 'BTC/USDT:USDT'])
  })

  it('builds a flat carry portfolio target when no current standardized signal is active', () => {
    const candidate = {
      id: 'carry_24h_z13',
      minAbsFundingSpread: 0.0001,
      minAbsFundingZScore: 1.3,
      maxHoldingBars: 24,
      stopLossPct: 0.015,
      positionPctOfEquity: 0.015,
      signalPersistenceBars: 8,
    }

    const currentSignal = resolveCurrentCarrySignal({
      carrySignals: [
        { time: 100, fundingSpread: 0.00009, fundingSpreadZScore: 1.8 },
        { time: 200, fundingSpread: -0.00008, fundingSpreadZScore: -1.9 },
      ],
      pairTimes: [260, 320, 380],
      candidate,
    })
    expect(currentSignal).toBeUndefined()

    const target = buildCarryPaperPortfolioTarget({
      leaderSymbol: 'ETH/USDT:USDT',
      hedgeSymbol: 'BTC/USDT:USDT',
      carrySignals: [
        { time: 100, fundingSpread: 0.00009, fundingSpreadZScore: 1.8 },
        { time: 200, fundingSpread: -0.00008, fundingSpreadZScore: -1.9 },
      ],
      pairTimes: [260, 320, 380],
      candidate,
      basisEquityUsd: 10_000,
    })

    expect(target.positions.map((position) => position.targetWeight)).toEqual([0, 0])
    expect(target.notes).toEqual(expect.arrayContaining(['signal_state=flat', 'reason=no_active_carry_signal']))
  })
})
