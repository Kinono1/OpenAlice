import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { buildPortfolioTargetFromWeights } from '../src/portfolio/target.js'
import { buildValidationDecisionSummary } from '../src/backtest/validation-report-summary.js'
import {
  buildCarryEntryGate,
  buildCarrySignalSeries,
  loadFundingHistory,
  loadOpenInterestHistory,
  type CarrySignalPoint,
} from './lib/derivatives_history.ts'
import { buildCarryReportedRegimeGate } from './lib/carry_protocol_artifacts.ts'
import { buildRelativeValueCandles, loadCsvCandles } from './lib/pair_market_data.ts'
import {
  buildCarryEconomics,
  runCarryBacktest,
  signalPassesCarryCandidate,
  runCarryValidation,
  type CarryBacktestCandidate,
  type CarryBacktestMetrics,
  type CarryBacktestResult,
  type CarryTrade,
  type CarryValidationSummary,
} from './lib/carry_backtest.ts'
import { writeChampionRegistry } from '../src/runtime/champion_registry.js'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

interface CliArgs {
  ethFundingPath: string
  btcFundingPath: string
  ethOpenInterestPath?: string
  btcOpenInterestPath?: string
  lookbackBars: number
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
  minAbsFundingSpread: number
  minAbsFundingZScore: number
  minOpenInterestRatio?: number
  paperTargetBasisEquityUsd: number
  selfCheck: boolean
  dryRun: boolean
  writeRuntimeArtifacts: boolean
}

const ETH = {
  symbol: 'ETH/USDT:USDT',
  csv: 'data/market/gate/ETH_USDT_USDT_1h.csv',
}

const BTC = {
  symbol: 'BTC/USDT:USDT',
  csv: 'data/market/gate/BTC_USDT_USDT_1h.csv',
}

const PAIR_SYMBOL = 'ETH/BTC_CARRY'
const CARRY_SIGNAL_LOOKBACK = 30
const ETH_CARRY_STRATEGY_ID = 'ETH_CARRY_BINANCE_FUNDING_V1'
const ETH_CARRY_STRATEGY_NAME = 'ETH Carry Binance Funding'
const ETH_CARRY_STRATEGY_FAMILY = 'carry'

interface CarryStrategyIdentity {
  strategyId: string
  strategyName: string
  strategyFamily: string
  reportFamily?: string
  controlArmLabel?: string
  controlArmSource?: string
  selectionBasis?: string
}

const DEFAULT_CARRY_IDENTITY: CarryStrategyIdentity = {
  strategyId: ETH_CARRY_STRATEGY_ID,
  strategyName: ETH_CARRY_STRATEGY_NAME,
  strategyFamily: ETH_CARRY_STRATEGY_FAMILY,
  reportFamily: 'eth_carry',
  controlArmLabel: 'eth_carry_selected_baseline',
  controlArmSource: 'standalone_eth_carry_selected_candidate',
  selectionBasis: 'standalone_eth_carry',
}

const BASE_PARAMS = {
  allowShort: true,
  factorEntryThreshold: 0.24,
  factorExitThreshold: 0.06,
  factorPositionPctOfEquity: 0.015,
  factorMaxHoldingBars: 60,
  factorStopLossPct: 0.012,
  factorKillSwitchVolPct: 2.5,
  factorKillSwitchTrendStrengthPct: 0.9,
}

const BASE_REGIME_GATE = buildCarryReportedRegimeGate({
  allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
  exitOnMismatch: true,
})

const BASE_CANDIDATES = [
  {
    id: 'carry_24h_z13',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.3,
    maxHoldingBars: 24,
    stopLossPct: 0.015,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
  {
    id: 'carry_24h_z15',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.5,
    maxHoldingBars: 24,
    stopLossPct: 0.015,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
  {
    id: 'carry_36h_z14',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.4,
    maxHoldingBars: 36,
    stopLossPct: 0.015,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
  {
    id: 'carry_48h_z14',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.4,
    maxHoldingBars: 48,
    stopLossPct: 0.012,
    positionPctOfEquity: 0.0125,
    signalPersistenceBars: 8,
  },
]

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.selfCheck || args.dryRun) {
    const ethCandles = await loadCsvCandles(ETH.csv, ETH.symbol)
    const btcCandles = await loadCsvCandles(BTC.csv, BTC.symbol)
    const pairCandles = buildRelativeValueCandles({
      leader: ethCandles,
      hedge: btcCandles,
      symbol: PAIR_SYMBOL,
    })
    console.log(JSON.stringify({
      family: 'eth_carry',
      leaderSymbol: ETH.symbol,
      hedgeSymbol: BTC.symbol,
      syntheticSymbol: PAIR_SYMBOL,
      alignedPairBars: pairCandles.length,
      derivativeInputs: {
        ethFundingPath: { path: resolve(args.ethFundingPath), exists: existsSync(resolve(args.ethFundingPath)) },
        btcFundingPath: { path: resolve(args.btcFundingPath), exists: existsSync(resolve(args.btcFundingPath)) },
        ethOpenInterestPath: args.ethOpenInterestPath
          ? { path: resolve(args.ethOpenInterestPath), exists: existsSync(resolve(args.ethOpenInterestPath)) }
          : null,
        btcOpenInterestPath: args.btcOpenInterestPath
          ? { path: resolve(args.btcOpenInterestPath), exists: existsSync(resolve(args.btcOpenInterestPath)) }
          : null,
      },
      minAbsFundingSpread: args.minAbsFundingSpread,
      minAbsFundingZScore: args.minAbsFundingZScore,
      minOpenInterestRatio: args.minOpenInterestRatio ?? null,
      carrySignalLookback: CARRY_SIGNAL_LOOKBACK,
      regimeGate: BASE_REGIME_GATE,
      params: BASE_PARAMS,
      candidateGrid: BASE_CANDIDATES,
      executionMode: {
        selfCheck: args.selfCheck,
        dryRun: args.dryRun,
        writeRuntimeArtifacts: args.writeRuntimeArtifacts,
        writesResearchArtifacts: false,
        writesPromotionRuntimeArtifacts: false,
      },
    }, null, 2))
    return
  }

  const ethCandles = await loadCsvCandles(ETH.csv, ETH.symbol)
  const btcCandles = await loadCsvCandles(BTC.csv, BTC.symbol)
  const pairCandles = buildRelativeValueCandles({
    leader: ethCandles,
    hedge: btcCandles,
    symbol: PAIR_SYMBOL,
  })

  const ethFunding = await loadFundingHistory(args.ethFundingPath)
  const btcFunding = await loadFundingHistory(args.btcFundingPath)
  const ethOi = args.ethOpenInterestPath
    ? await loadOpenInterestHistory(args.ethOpenInterestPath)
    : undefined
  const btcOi = args.btcOpenInterestPath
    ? await loadOpenInterestHistory(args.btcOpenInterestPath)
    : undefined

  const carrySeries = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    leaderOpenInterest: ethOi,
    hedgeOpenInterest: btcOi,
    zScoreLookback: CARRY_SIGNAL_LOOKBACK,
  })
  const entryGate = buildCarryEntryGate({
    series: carrySeries,
    minAbsFundingSpread: args.minAbsFundingSpread,
    minAbsFundingZScore: args.minAbsFundingZScore,
    minOpenInterestRatio: args.minOpenInterestRatio,
  })

  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_carry/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const validationOutput = resolve(outputDir, 'eth_carry.validation.json')
  const releaseGateStatusPath = resolve(outputDir, 'eth_carry.release_gate_status.json')
  const validationRunsPath = resolve(outputDir, 'eth_carry.strategy_validation_runs.json')
  const experimentVerdictPath = resolve(outputDir, 'eth_carry.experiment_verdict.v2.json')
  const championRegistryPath = resolve(outputDir, 'eth_carry.paper_champion_registry.json')
  const paperPortfolioTargetPath = resolve(outputDir, 'eth_carry.paper_portfolio_target.json')

  const candidateReports = BASE_CANDIDATES.map((candidate) =>
    runCarryBacktest({
      candles: pairCandles.slice(-args.lookbackBars),
      carrySignals: carrySeries,
      candidate,
    }),
  )
  const validation = runCarryValidation({
    candles: pairCandles.slice(-args.lookbackBars),
    carrySignals: carrySeries,
    candidates: BASE_CANDIDATES,
    trainBars: args.trainBars,
    testBars: args.testBars,
    stepBars: args.stepBars,
    riskSimulationCount: args.riskSimulationCount,
  })

  const validationReport = buildCarryValidationReport({
    generatedAt,
    validationOutput,
    releaseGateStatusPath,
    args,
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    carrySignalLookback: CARRY_SIGNAL_LOOKBACK,
    entryGate,
    regimeGate: BASE_REGIME_GATE,
    candidateReports,
    validation,
    pairCandles: pairCandles.slice(-args.lookbackBars),
    carrySignals: carrySeries,
  })
  await writeFile(validationOutput, `${JSON.stringify(validationReport, null, 2)}\n`, 'utf-8')
  const persistedGate = await writeReleaseGateStatus(validation.releaseGate, {
    filePath: releaseGateStatusPath,
    sourceReportPath: validationOutput,
  })
  const paperPortfolioTarget = buildCarryPaperPortfolioTarget({
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    carrySignals: carrySeries,
    pairTimes: pairCandles.slice(-args.lookbackBars).map((candle) => candle.time),
    candidate: validation.selectedCandidate,
    basisEquityUsd: args.paperTargetBasisEquityUsd,
  })
  await writeFile(paperPortfolioTargetPath, `${JSON.stringify(paperPortfolioTarget, null, 2)}\n`, 'utf-8')
  const runtimeArtifacts = args.writeRuntimeArtifacts
    ? await writeCarryRuntimeArtifacts({
        generatedAt,
        validationRunsPath,
        experimentVerdictPath,
        championRegistryPath,
        paperPortfolioTargetPath,
        validationOutput,
        releaseGateStatusPath,
        selectedCandidate: validation.selectedCandidate,
        selectedMetrics: validation.selectedMetrics,
        significance: validation.significance,
        releaseGate: validation.releaseGate,
        leaderSymbol: ETH.symbol,
        hedgeSymbol: BTC.symbol,
        syntheticSymbol: PAIR_SYMBOL,
        carrySignalLookback: CARRY_SIGNAL_LOOKBACK,
        candidates: BASE_CANDIDATES,
      })
    : null

  const summaryPath = resolve(outputDir, 'eth_carry_summary.json')

  await writeFile(summaryPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    family: 'eth_carry',
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    carrySignalPoints: carrySeries.length,
    entryGate,
    carrySignalLookback: CARRY_SIGNAL_LOOKBACK,
    regimeGate: BASE_REGIME_GATE,
    params: BASE_PARAMS,
    candidates: BASE_CANDIDATES,
    validationOutput,
    releaseGateStatusPath,
    validationRunsPath,
    experimentVerdictPath,
    championRegistryPath,
    paperPortfolioTargetPath,
    selectedParams: validation.selectedCandidate,
    selectedMetrics: validation.selectedMetrics,
    baselineReport: validationReport.baselineReport,
    deployableStrategyTarget: validationReport.deployableStrategyTarget,
    recommendedCandidate: validationReport.recommendedCandidate,
    canonicalScoreboard: validationReport.canonicalScoreboard,
    trades: validation.trades,
    wfo: validation.wfo,
    significance: validation.significance,
    riskSimulation: validation.riskSimulation,
    releaseGate: validation.releaseGate,
    persistedGate,
    paperPortfolioTarget,
    runtimeArtifacts,
    runtimeArtifactPolicy: {
      dryRun: args.dryRun,
      writeRuntimeArtifacts: args.writeRuntimeArtifacts,
      writesPromotionRuntimeArtifacts: args.writeRuntimeArtifacts,
      note: args.writeRuntimeArtifacts
        ? 'Runtime artifacts were explicitly enabled for this run.'
        : 'Runtime promotion artifacts were not written; this run is research-only.',
    },
  }, null, 2)}\n`, 'utf-8')

  console.log(summaryPath)
}

interface CarryValidationArtifactsInput {
  generatedAt: string
  validationOutput: string
  releaseGateStatusPath: string
  args: CliArgs
  leaderSymbol: string
  hedgeSymbol: string
  syntheticSymbol: string
  carrySignalLookback: number
  entryGate: {
    signalTimeCount: number
    firstSignalTime: number | null
    lastSignalTime: number | null
    artifactKind: string
    executable: boolean
  }
  regimeGate: typeof BASE_REGIME_GATE
  candidateReports: CarryBacktestResult[]
  validation: CarryValidationSummary
  pairCandles?: PairMarketCandle[]
  carrySignals?: CarrySignalPoint[]
  selectionProtocol?: {
    protocolVersion: string
    researchSelection: Record<string, unknown>
    validationSelection: Record<string, unknown>
    finalHoldout: Record<string, unknown>
  }
  identity?: CarryStrategyIdentity
}

interface CarryRuntimeArtifactsInput {
  generatedAt: string
  validationRunsPath: string
  experimentVerdictPath: string
  championRegistryPath: string
  paperPortfolioTargetPath: string
  validationOutput: string
  releaseGateStatusPath: string
  selectedCandidate: CarryBacktestCandidate
  selectedMetrics: CarryBacktestMetrics
  significance: CarryValidationSummary['significance']
  releaseGate: CarryValidationSummary['releaseGate']
  leaderSymbol: string
  hedgeSymbol: string
  syntheticSymbol: string
  carrySignalLookback: number
  candidates: CarryBacktestCandidate[]
  identity?: CarryStrategyIdentity
}

function buildCarryValidationReport(input: CarryValidationArtifactsInput) {
  const identity = input.identity ?? DEFAULT_CARRY_IDENTITY
  const reportRegimeGate = buildCarryReportedRegimeGate(input.regimeGate)
  const selectedCandidateIndex = input.candidateReports.findIndex(
    (report) => report.candidate.id === input.validation.selectedCandidate.id,
  )
  const selectedCandidateReport =
    input.candidateReports[selectedCandidateIndex] ??
    input.candidateReports.find((report) => report.candidate.id === input.validation.selectedCandidate.id) ??
    input.candidateReports[0]
  const controlMetrics = summarizeCarryMetrics(input.validation.selectedMetrics)
  const baselineReport = buildCarryBaselineReport({
    metrics: input.validation.selectedMetrics,
    trades: input.validation.trades,
  })
  const validationEvidence = buildCarryValidationEvidence(input)
  const controlArm = {
    label: identity.controlArmLabel ?? `${identity.strategyId.toLowerCase()}_selected_baseline`,
    source: identity.controlArmSource ?? `standalone_${identity.strategyId.toLowerCase()}_selected_candidate`,
    description: `Use the selected ${identity.strategyName} candidate from standalone carry validation as the control arm.`,
    metrics: controlMetrics,
    baselineReport,
  }
  const reasonCodes = buildCarryRecommendationReasonCodes({
    releaseGate: input.validation.releaseGate,
    tradeCount: input.validation.selectedMetrics.tradeCount,
  })
  const champion =
    input.validation.releaseGate.allowPaperTrading
      ? {
          source: 'selected_candidate',
          armId: input.validation.selectedCandidate.id,
          label: input.validation.selectedCandidate.id,
          rank: 1,
          metrics: controlMetrics,
          baselineReport,
          delta: {
            totalReturnPct: 0,
            netExpectancyPct: 0,
            maxDrawdownPct: 0,
            tradeCount: 0,
            sharpe: 0,
            sortino: 0,
            calmar: 0,
          },
          diagnostics: {
            qualifies: true,
            tradeCountRetentionPct: 100,
          },
          selection: null,
          gate: reportRegimeGate,
          regimeGateSelection: null,
        }
      : null
  const recommendedCandidate = {
    controlArm,
    candidatesBySource: {
      regimeGate: null,
      metaLabel: null,
      metaLabelWithBestRegimeGate: null,
    },
    candidateCount: input.candidateReports.length,
    qualifiedCandidateCount: champion ? 1 : 0,
    champion,
    combinedWinnerEvidence: null,
    selectionDiagnosticsSummary: null,
    releaseGateStatus: {
      allowPaperTrading: input.validation.releaseGate.allowPaperTrading,
      allowLiveTrading: input.validation.releaseGate.allowLiveTrading,
      failedChecks: input.validation.releaseGate.failedChecks,
      warningChecks: input.validation.releaseGate.warningChecks,
    },
    recommendation: {
      action: champion ? 'promote_candidate' : 'stay_on_baseline',
      targetSource: champion ? 'selected_candidate' : 'baseline',
      targetArmId: champion ? champion.armId : null,
      targetLabel: champion ? champion.label : controlArm.label,
      fallbackToBaseline: !champion,
      reasonCodes,
      regimeCollapseWarnings: [],
    },
  }

  const report = {
    schemaVersion: 'validation_pipeline_report.v1',
    generatedAt: new Date().toISOString(),
    input: {
      family: identity.reportFamily ?? identity.strategyFamily,
      leaderSymbol: input.leaderSymbol,
      hedgeSymbol: input.hedgeSymbol,
      syntheticSymbol: input.syntheticSymbol,
      lookbackBars: input.args.lookbackBars,
      carrySignalLookback: input.carrySignalLookback,
      fundingInputs: {
        ethFundingPath: resolve(input.args.ethFundingPath),
        btcFundingPath: resolve(input.args.btcFundingPath),
        ethOpenInterestPath: input.args.ethOpenInterestPath ? resolve(input.args.ethOpenInterestPath) : null,
        btcOpenInterestPath: input.args.btcOpenInterestPath ? resolve(input.args.btcOpenInterestPath) : null,
      },
    },
    configuredGates: {
      regimeGate: reportRegimeGate,
      entryGate: input.entryGate,
    },
    deployableStrategyTarget: {
      controlArm,
      optimizationTarget: {
        primaryMetric: 'netExpectancyPct',
        objective: 'positive_out_of_sample_net_expectancy_after_fees_slippage_and_funding',
        measurement: 'candidate_net_expectancy_pct_minus_control_arm_net_expectancy_pct',
        requirePositiveDeltaVsControlArm: true,
      },
      robustnessTarget: {
        releaseGate: {
          currentStatus: {
            allowPaperTrading: input.validation.releaseGate.allowPaperTrading,
            allowLiveTrading: input.validation.releaseGate.allowLiveTrading,
            failedChecks: input.validation.releaseGate.failedChecks,
            warningChecks: input.validation.releaseGate.warningChecks,
          },
          paperTrading: {
            requireAllowPaperTrading: true,
            blockingChecks: ['wfo', 'significance', 'risk_simulation', 'economics', 'strategy_plan_evidence'],
          },
          liveTrading: {
            requireAllowLiveTrading: true,
            blockingChecks: ['wfo', 'significance', 'risk_simulation', 'economics', 'strategy_plan_evidence', 'execution_quality', 'ramp_up', 'regime_shift'],
          },
        },
      },
      practicalConstraints: {
        drawdown: {
          requireNoWorseThanControlArm: true,
          maxDrawdownPctControlArm: input.validation.selectedMetrics.maxDrawdownPct,
        },
        tradeCount: {
          regimeGateMinRetentionPct: 30,
          metaLabelMinRetentionPct: 5,
        },
      },
    },
    selectedParams: input.validation.selectedCandidate,
    selectedMetrics: input.validation.selectedMetrics,
    validationEvidence,
    baselineReport,
    candidateMetrics: input.candidateReports.map((report, index) => ({
      candidateIndex: index,
      params: report.candidate,
      metrics: report.metrics,
      baselineReport: buildCarryBaselineReport(report),
    })),
    recommendedCandidate,
    canonicalScoreboard: {
      controlArm,
      selectedCandidate: {
        source: 'selected_candidate',
        selectionBasis: identity.selectionBasis ?? 'standalone_eth_carry',
        candidateIndex: selectedCandidateIndex >= 0 ? selectedCandidateIndex : 0,
        params: input.validation.selectedCandidate,
        metrics: controlMetrics,
        baselineReport,
      },
      recommendation: recommendedCandidate.recommendation,
      wfo: {
        overallPassed: input.validation.wfo.overallPassed,
        failedWindows: input.validation.wfo.failedWindows,
        windowCount: input.validation.wfo.windows.length,
        failedWindowRatio:
          input.validation.wfo.windows.length > 0
            ? input.validation.wfo.failedWindows / input.validation.wfo.windows.length
            : 0,
        windows: input.validation.wfo.windows,
      },
      significance: {
        passed: input.validation.significance.passed,
        pbo: input.validation.significance.pboResult.pbo,
        pboThreshold: input.validation.significance.pboThreshold,
        dsrValue: input.validation.significance.dsrResult.dsrValue,
        dsrProbability: input.validation.significance.dsrResult.dsrProbability,
        dsrMin: input.validation.significance.dsrMin,
      },
      risk: {
        ...input.validation.riskSimulation,
      },
      releaseGate: {
        allowPaperTrading: input.validation.releaseGate.allowPaperTrading,
        allowLiveTrading: input.validation.releaseGate.allowLiveTrading,
        hardFail: input.validation.releaseGate.hardFail,
        failedChecks: input.validation.releaseGate.failedChecks,
        warningChecks: input.validation.releaseGate.warningChecks,
        checks: input.validation.releaseGate.checks.map((check) => ({
          name: check.name,
          status: check.status,
          summary: check.summary,
        })),
      },
    },
    wfo: input.validation.wfo,
    significance: input.validation.significance,
    riskSimulation: input.validation.riskSimulation,
    releaseGate: input.validation.releaseGate,
    selectionProtocol: input.selectionProtocol ?? null,
    artifactPaths: {
      validationOutput: input.validationOutput,
      releaseGateStatusPath: input.releaseGateStatusPath,
    },
    notes: {
      candidateSelection: selectedCandidateReport?.candidate.id ?? input.validation.selectedCandidate.id,
      reportFamily: identity.reportFamily ?? identity.strategyFamily,
      selectionProtocolVersion: input.selectionProtocol?.protocolVersion ?? null,
    },
  }

  return {
    ...report,
    decisionSummary: buildValidationDecisionSummary(report),
  }
}

function summarizeCarryMetrics(metrics: CarryBacktestMetrics) {
  return {
    totalReturnPct: metrics.totalReturnPct,
    netExpectancyPct: metrics.netExpectancyPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    tradeCount: metrics.tradeCount,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino ?? 0,
    calmar: metrics.maxDrawdownPct > 0 ? metrics.totalReturnPct / metrics.maxDrawdownPct : 0,
  }
}

function buildCarryValidationEvidence(input: CarryValidationArtifactsInput) {
  const metrics = input.validation.selectedMetrics
  const signalIcByHorizon =
    input.pairCandles && input.carrySignals
      ? computeCarrySignalIcByHorizon({
          candles: input.pairCandles,
          carrySignals: input.carrySignals,
          candidate: input.validation.selectedCandidate,
          horizons: [1, 6, 24],
        })
      : []

  return {
    turnover: {
      available: true,
      totalTurnoverUsd: metrics.totalTurnoverUsd ?? 0,
      turnoverPctOfInitialCapital: metrics.turnoverPctOfInitialCapital ?? 0,
      averageTurnoverPctPerTrade: metrics.averageTurnoverPctPerTrade ?? 0,
      tradeCount: metrics.tradeCount,
    },
    costAdjustedReturn: {
      available: true,
      totalReturnPct: metrics.totalReturnPct,
      grossExpectancyPct: metrics.grossExpectancyPct ?? 0,
      netExpectancyPct: metrics.netExpectancyPct,
      totalCostsPaid: metrics.totalCostsPaid ?? 0,
      costDragPctOfInitialCapital: metrics.costDragPctOfInitialCapital ?? 0,
    },
    factorIcByHorizon: {
      available: signalIcByHorizon.length > 0,
      factorName: 'eth_btc_funding_spread_direction',
      horizons: signalIcByHorizon,
      reason:
        signalIcByHorizon.length > 0
          ? null
          : 'Carry signal IC requires pair candles and carry signal history.',
    },
    strategySignalIcByHorizon: signalIcByHorizon,
    regimeSplitPerformance: {
      available: false,
      reason:
        'Standalone carry validation does not assign runtime regime labels per trade; use generic runtime validation for regime-split evidence.',
    },
    longShortSideAsymmetry: summarizeCarrySideAsymmetry(input.validation.trades),
    paperExecutionSlippage: {
      available: false,
      gateStatus: 'skipped',
      summary: 'Paper fill telemetry is not part of standalone carry backtest output.',
      reason:
        'Standalone carry validation uses deterministic cost assumptions. Paper execution slippage must come from live/paper order telemetry.',
      substitute: 'strategyPlanEvidence.sessionAwareSlippageEstimate',
    },
    strategyPlanEvidence: input.validation.strategyPlanEvidence,
  }
}

function computeCarrySignalIcByHorizon(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidate: CarryBacktestCandidate
  horizons: number[]
}) {
  const indexByTime = new Map(input.candles.map((candle, index) => [candle.time, index]))
  return input.horizons.map((horizonBars) => {
    const signals: number[] = []
    const forwardReturns: number[] = []
    const longForwardReturns: number[] = []
    const shortForwardReturns: number[] = []

    for (const point of input.carrySignals) {
      if (!signalPassesCarryCandidate(point, input.candidate)) {
        continue
      }
      const index = indexByTime.get(point.time)
      if (index == null || index + horizonBars >= input.candles.length) {
        continue
      }
      const currentClose = input.candles[index]?.close
      const futureClose = input.candles[index + horizonBars]?.close
      if (!Number.isFinite(currentClose) || !Number.isFinite(futureClose) || currentClose <= 0) {
        continue
      }
      const signal = point.fundingSpread > 0 ? -1 : 1
      const forwardReturnPct = ((futureClose - currentClose) / currentClose) * 100
      signals.push(signal)
      forwardReturns.push(forwardReturnPct)
      if (signal > 0) {
        longForwardReturns.push(forwardReturnPct)
      } else {
        shortForwardReturns.push(forwardReturnPct)
      }
    }

    return {
      horizonBars,
      observations: signals.length,
      activeSignalObservations: signals.filter((signal) => signal !== 0).length,
      pearsonIc: pearsonCorrelation(signals, forwardReturns),
      meanForwardReturnWhenLongPct: finiteMean(longForwardReturns),
      meanForwardReturnWhenShortPct: finiteMean(shortForwardReturns),
    }
  })
}

function summarizeCarrySideAsymmetry(trades: CarryTrade[]) {
  return {
    long: summarizeCarrySide(trades.filter((trade) => trade.direction === 'long_pair')),
    short: summarizeCarrySide(trades.filter((trade) => trade.direction === 'short_pair')),
  }
}

function summarizeCarrySide(trades: CarryTrade[]) {
  return {
    tradeCount: trades.length,
    winRatePct:
      trades.length > 0
        ? (trades.filter((trade) => trade.netReturnPct > 0).length / trades.length) * 100
        : 0,
    grossExpectancyPct: finiteMean(trades.map((trade) => trade.rawReturnPct)),
    netExpectancyPct: finiteMean(trades.map((trade) => trade.netReturnPct)),
    totalGrossReturnPct: trades.reduce((sum, trade) => sum + trade.rawReturnPct, 0),
    totalNetReturnPct: trades.reduce((sum, trade) => sum + trade.netReturnPct, 0),
    averageHoldingHours: finiteMean(trades.map((trade) => trade.holdingHours ?? trade.holdingBars)),
  }
}

function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) {
    return 0
  }
  const xMean = finiteMean(x)
  const yMean = finiteMean(y)
  let numerator = 0
  let xVariance = 0
  let yVariance = 0
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - xMean
    const dy = y[index] - yMean
    numerator += dx * dy
    xVariance += dx * dx
    yVariance += dy * dy
  }
  const denominator = Math.sqrt(xVariance * yVariance)
  return denominator > 0 ? numerator / denominator : 0
}

function finiteMean(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value))
  return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : 0
}

function buildCarryBaselineReport(input: {
  metrics: CarryBacktestMetrics
  trades: CarryTrade[]
} | CarryBacktestResult) {
  const backtest = 'candidate' in input
    ? input
    : {
        candidate: {
          id: 'report_only',
          minAbsFundingSpread: 0,
          maxHoldingBars: 1,
          stopLossPct: 0,
          positionPctOfEquity: 0,
        },
        trades: input.trades,
        equityCurve: [],
        returns: [],
        metrics: input.metrics,
      }
  const economics = buildCarryEconomics(backtest)

  return {
    expectancyAfterCost: {
      grossExpectancyPct: economics.grossExpectancyPct,
      feeExpectancyDragPct: economics.feeExpectancyDragPct,
      slippageExpectancyDragPct: economics.slippageExpectancyDragPct,
      fundingExpectancyDragPct: economics.fundingExpectancyDragPct,
      netExpectancyPct: economics.netExpectancyPct,
      totalCostExpectancyDragPct:
        economics.feeExpectancyDragPct
        + economics.slippageExpectancyDragPct
        + economics.fundingExpectancyDragPct,
    },
    byRegime: {},
  }
}

function buildCarryRecommendationReasonCodes(input: {
  releaseGate: CarryValidationSummary['releaseGate']
  tradeCount: number
}): string[] {
  const codes: string[] = []
  if (!input.releaseGate.allowPaperTrading) {
    codes.push('PAPER_RELEASE_GATE_BLOCKED')
  }
  if (!input.releaseGate.allowLiveTrading) {
    codes.push('LIVE_RELEASE_GATE_BLOCKED')
  }
  if (input.tradeCount <= 10) {
    codes.push('CHAMPION_LOW_ABSOLUTE_TRADE_COUNT')
  }
  return codes
}

function buildCarryPaperPortfolioTarget(input: {
  leaderSymbol: string
  hedgeSymbol: string
  carrySignals: Array<{ time: number; fundingSpread: number; fundingSpreadZScore: number }>
  pairTimes: number[]
  candidate: CarryBacktestCandidate
  basisEquityUsd: number
  identity?: CarryStrategyIdentity
}) {
  const identity = input.identity ?? DEFAULT_CARRY_IDENTITY
  const currentSignal = resolveCurrentCarrySignal({
    carrySignals: input.carrySignals,
    pairTimes: input.pairTimes,
    candidate: input.candidate,
  })
  if (!currentSignal) {
    return buildPortfolioTargetFromWeights({
      basisEquityUsd: input.basisEquityUsd,
      weights: {
        [input.leaderSymbol]: 0,
        [input.hedgeSymbol]: 0,
      },
      notes: [
        'source=eth_carry_validation',
        `strategy_id=${identity.strategyId}`,
        'signal_state=flat',
        'reason=no_active_carry_signal',
      ],
      sizingReasonBySymbol: {
        [input.leaderSymbol]: 'eth_carry:no_active_signal',
        [input.hedgeSymbol]: 'eth_carry:no_active_signal',
      },
    })
  }

  const baseWeight = input.candidate.positionPctOfEquity
  const isLongPair = currentSignal.fundingSpread < 0
  return buildPortfolioTargetFromWeights({
    basisEquityUsd: input.basisEquityUsd,
    weights: {
      [input.leaderSymbol]: isLongPair ? baseWeight : -baseWeight,
      [input.hedgeSymbol]: isLongPair ? -baseWeight : baseWeight,
    },
    confidenceBySymbol: {
      [input.leaderSymbol]: Math.min(1, Math.abs(currentSignal.fundingSpreadZScore) / 3),
      [input.hedgeSymbol]: Math.min(1, Math.abs(currentSignal.fundingSpreadZScore) / 3),
    },
    sizingReasonBySymbol: {
      [input.leaderSymbol]: `eth_carry:${isLongPair ? 'long_pair' : 'short_pair'}`,
      [input.hedgeSymbol]: `eth_carry:${isLongPair ? 'long_pair' : 'short_pair'}`,
    },
    regimeTagBySymbol: {
      [input.leaderSymbol]: 'carry_pair',
      [input.hedgeSymbol]: 'carry_pair',
    },
    notes: [
      'source=eth_carry_validation',
      `strategy_id=${identity.strategyId}`,
      `signal_state=${isLongPair ? 'long_pair' : 'short_pair'}`,
      `signal_time=${currentSignal.time}`,
      `funding_spread=${currentSignal.fundingSpread}`,
      `funding_spread_zscore=${currentSignal.fundingSpreadZScore}`,
      'basis_equity_placeholder=true',
    ],
  })
}

function resolveCurrentCarrySignal(input: {
  carrySignals: Array<{ time: number; fundingSpread: number; fundingSpreadZScore: number }>
  pairTimes: number[]
  candidate: CarryBacktestCandidate
}) {
  const signalByTime = new Map(
    input.carrySignals
      .filter((point) => signalPassesCarryCandidate(point, input.candidate))
      .map((point) => [point.time, point]),
  )
  if (input.pairTimes.length < 2) {
    return undefined
  }
  const currentTime = input.pairTimes[input.pairTimes.length - 1]
  const barSeconds = Math.max(1, input.pairTimes[input.pairTimes.length - 1] - input.pairTimes[input.pairTimes.length - 2])
  const persistenceBars = input.candidate.signalPersistenceBars ?? 8
  const direct = signalByTime.get(currentTime)
  if (direct) return direct
  for (let offset = 1; offset <= persistenceBars; offset += 1) {
    const signal = signalByTime.get(currentTime - offset * barSeconds)
    if (signal) return signal
  }
  return undefined
}

async function writeCarryRuntimeArtifacts(input: CarryRuntimeArtifactsInput) {
  const identity = input.identity ?? DEFAULT_CARRY_IDENTITY
  const generatedAtIso = new Date().toISOString()
  const symbols = [input.leaderSymbol, input.hedgeSymbol]
  const championSet = symbols.map((symbol) => ({
    symbol,
    strategyId: identity.strategyId,
    strategy: identity.strategyFamily,
    strategyFamily: identity.strategyFamily,
    strategyName: identity.strategyName,
    candidateId: input.selectedCandidate.id,
  }))
  const validationRuns = {
    schemaVersion: 'strategy_validation_runs.v1',
    generatedAt: generatedAtIso,
    champion: {
      strategyId: identity.strategyId,
      strategy: identity.strategyFamily,
      strategyFamily: identity.strategyFamily,
      strategyName: identity.strategyName,
      symbols,
      candidateId: input.selectedCandidate.id,
    },
    championSet,
    candidates: input.candidates.map((candidate) => ({
      strategyId:
        candidate.id === input.selectedCandidate.id
          ? identity.strategyId
          : `${identity.strategyId}__${candidate.id}`,
      strategy: identity.strategyFamily,
      strategyFamily: identity.strategyFamily,
      strategyName: `${identity.strategyName} ${candidate.id}`,
      candidateId: candidate.id,
    })),
    portfolio: {
      championSet,
      releaseGate: {
        allowPaperTrading: input.releaseGate.allowPaperTrading,
        allowLiveTrading: input.releaseGate.allowLiveTrading,
        failedChecks: input.releaseGate.failedChecks,
      },
      result: input.releaseGate.allowPaperTrading ? 'GO' : 'NO_GO',
      reasonCodes: buildCarryRecommendationReasonCodes({
        releaseGate: input.releaseGate,
        tradeCount: input.selectedMetrics.tradeCount,
      }),
      aggregateMetrics: {
        netExpectancyPct: input.selectedMetrics.netExpectancyPct,
        totalReturnPct: input.selectedMetrics.totalReturnPct,
        tradeCount: input.selectedMetrics.tradeCount,
        sharpe: input.selectedMetrics.sharpe,
        maxDrawdownPct: input.selectedMetrics.maxDrawdownPct,
      },
    },
  }
  await writeFile(input.validationRunsPath, `${JSON.stringify(validationRuns, null, 2)}\n`, 'utf-8')

  const verdictPayload = {
    schemaVersion: 'experiment_verdict.v2',
    generatedAt: generatedAtIso,
    result: input.releaseGate.allowPaperTrading ? 'GO' : 'NO_GO',
    reasonCodes: buildCarryRecommendationReasonCodes({
      releaseGate: input.releaseGate,
      tradeCount: input.selectedMetrics.tradeCount,
    }),
    thresholds: {
      meanPboMax: input.significance.pboThreshold,
      meanDsrProbabilityMin: 0.5,
      fdrQMax: 0.2,
    },
    aggregateMetrics: {
      meanPbo: input.significance.pboResult.pbo,
      meanDsrProbability: input.significance.dsrResult.dsrProbability,
      fdrQ: 0,
      tradeCount: input.selectedMetrics.tradeCount,
      netExpectancyPct: input.selectedMetrics.netExpectancyPct,
      totalReturnPct: input.selectedMetrics.totalReturnPct,
      sharpe: input.selectedMetrics.sharpe,
      maxDrawdownPct: input.selectedMetrics.maxDrawdownPct,
    },
    outputPaths: {
      validationRuns: input.validationRunsPath,
      validationReport: input.validationOutput,
      releaseGateStatus: input.releaseGateStatusPath,
      championRegistrySnapshot: input.championRegistryPath,
    },
    champion: {
      strategyId: identity.strategyId,
      strategy: identity.strategyFamily,
      strategyFamily: identity.strategyFamily,
      strategyName: identity.strategyName,
      candidateId: input.selectedCandidate.id,
      symbols,
    },
    portfolio: {
      requiredSymbols: symbols,
      championSet,
      releaseGate: {
        allowPaperTrading: input.releaseGate.allowPaperTrading,
        allowLiveTrading: input.releaseGate.allowLiveTrading,
        failedChecks: input.releaseGate.failedChecks,
      },
      result: input.releaseGate.allowPaperTrading ? 'GO' : 'NO_GO',
      reasonCodes: buildCarryRecommendationReasonCodes({
        releaseGate: input.releaseGate,
        tradeCount: input.selectedMetrics.tradeCount,
      }),
    },
    symbols: symbols.map((symbol) => ({
      symbol,
      result: input.releaseGate.allowPaperTrading ? 'GO' : 'NO_GO',
      reasonCodes: buildCarryRecommendationReasonCodes({
        releaseGate: input.releaseGate,
        tradeCount: input.selectedMetrics.tradeCount,
      }),
      champion: {
        strategyId: identity.strategyId,
        strategyFamily: identity.strategyFamily,
        strategyName: identity.strategyName,
        candidateId: input.selectedCandidate.id,
      },
      aggregateMetrics: {
        pbo: input.significance.pboResult.pbo,
        dsrProbability: input.significance.dsrResult.dsrProbability,
        fdrQ: 0,
        netExpectancyPct: input.selectedMetrics.netExpectancyPct,
        totalReturnPct: input.selectedMetrics.totalReturnPct,
        tradeCount: input.selectedMetrics.tradeCount,
        sharpe: input.selectedMetrics.sharpe,
      },
    })),
  }
  await writeFile(input.experimentVerdictPath, `${JSON.stringify(verdictPayload, null, 2)}\n`, 'utf-8')

  const registry = await writeChampionRegistry(
    {
      version: 1,
      generatedAt: generatedAtIso,
      entries: [
        {
          strategyId: identity.strategyId,
          strategyFamily: identity.strategyFamily,
          strategyName: identity.strategyName,
          symbols,
          candidateId: input.selectedCandidate.id,
          metadata: {
            family: 'eth_carry',
            syntheticSymbol: input.syntheticSymbol,
            carrySignalLookback: input.carrySignalLookback,
            netExpectancyPct: input.selectedMetrics.netExpectancyPct,
            sharpe: input.selectedMetrics.sharpe,
            tradeCount: input.selectedMetrics.tradeCount,
            validationOutput: input.validationOutput,
          },
        },
      ],
      sourceVerdictPath: input.experimentVerdictPath,
      releaseGateStatusPath: input.releaseGateStatusPath,
    },
    { filePath: input.championRegistryPath },
  )

  return {
    validationRunsPath: input.validationRunsPath,
    experimentVerdictPath: input.experimentVerdictPath,
    championRegistryPath: input.championRegistryPath,
    paperPortfolioTargetPath: input.paperPortfolioTargetPath,
    strategyId: ETH_CARRY_STRATEGY_ID,
    strategyFamily: ETH_CARRY_STRATEGY_FAMILY,
    strategyName: ETH_CARRY_STRATEGY_NAME,
    symbols,
    championSet,
    registry,
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ethFundingPath: raw.get('ethFundingPath') ?? 'data/research/derivatives_history/bybit_ETH_USDT_USDT_funding_history.json',
    btcFundingPath: raw.get('btcFundingPath') ?? 'data/research/derivatives_history/bybit_BTC_USDT_USDT_funding_history.json',
    ethOpenInterestPath: raw.get('ethOpenInterestPath') ?? undefined,
    btcOpenInterestPath: raw.get('btcOpenInterestPath') ?? undefined,
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 6000, 'lookbackBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 3600, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 1200, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 480, 'stepBars'),
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 200, 'riskSimulationCount'),
    minAbsFundingSpread: parseNumberArg(raw.get('minAbsFundingSpread'), 0.0001, 'minAbsFundingSpread'),
    minAbsFundingZScore: parseNumberArg(raw.get('minAbsFundingZScore'), 1.3, 'minAbsFundingZScore'),
    minOpenInterestRatio: parseOptionalNumber(raw.get('minOpenInterestRatio')),
    paperTargetBasisEquityUsd: parseNumberArg(raw.get('paperTargetBasisEquityUsd'), 10_000, 'paperTargetBasisEquityUsd'),
    selfCheck: parseBoolArg(raw.get('selfCheck'), false),
    dryRun: parseBoolArg(raw.get('dryRun'), true),
    writeRuntimeArtifacts: parseBoolArg(raw.get('writeRuntimeArtifacts'), false),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) {
      out.set(key, 'true')
      continue
    }
    out.set(key, next)
    index += 1
  }
  return out
}

function parseIntArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`)
  }
  return value
}

function parseNumberArg(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`)
  }
  return value
}

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (raw == null) return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error('minOpenInterestRatio must be a finite number.')
  }
  return value
}

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export {
  buildCarryBaselineReport,
  buildCarryPaperPortfolioTarget,
  buildCarryRecommendationReasonCodes,
  buildCarryValidationReport,
  parseArgs,
  resolveCurrentCarrySignal,
  summarizeCarryMetrics,
  writeCarryRuntimeArtifacts,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
