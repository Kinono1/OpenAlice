import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import { evaluateSignificanceGate } from '../src/backtest/statistical_significance.js'
import { buildCarryEntryGate, buildCarrySignalSeries, loadFundingHistory, type CarrySignalPoint } from './lib/derivatives_history.ts'
import { buildRelativeValueCandles, loadCsvCandles, type PairMarketCandle } from './lib/pair_market_data.ts'
import {
  buildCarryEconomics,
  buildCarryStrategyPlanEvidence,
  runCarryBacktest,
  signalPassesCarryCandidate,
  type CarryBacktestCandidate,
  type CarryBacktestResult,
  type CarryValidationSummary,
} from './lib/carry_backtest.ts'
import { buildMicroSweepCandidates } from './run_eth_carry_short_bias_micro_sweep.ts'
import { buildShortBiasVariants, toSweepCandidate } from './run_eth_carry_short_bias_sweep.ts'
import { buildCarryReportedRegimeGate } from './lib/carry_protocol_artifacts.ts'
import {
  buildCarryPaperPortfolioTarget,
  buildCarryValidationReport,
  writeCarryRuntimeArtifacts,
} from './run_eth_carry_validation.ts'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

interface CliArgs {
  ethFundingPath: string
  btcFundingPath: string
  lookbackBars: number
  trainBars: number
  testBars: number
  stepBars: number
  riskSimulationCount: number
  paperTargetBasisEquityUsd: number
  selfCheck: boolean
  dryRun: boolean
  writeRuntimeArtifacts: boolean
}

interface ShortBiasEvaluation {
  stage: 'validation_selection'
  candidate: CarryBacktestCandidate
  backtest: CarryBacktestResult
  wfo: ShortBiasWalkForwardResult
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  errorRate: number | null
  recent90dErrorRate: number | null
}

interface ShortBiasWalkForwardWindow {
  windowIndex: number
  selectedCandidate: string
  inSampleSharpe: number
  outOfSampleSharpe: number
  outOfSampleTradeCount: number
  outOfSampleNetExpectancyPct: number
  outOfSampleErrorRate: number | null
  degradationRate: number
  gatePassed: boolean
  gateReason?: 'is_non_positive_sharpe' | 'degradation_exceeded' | 'insufficient_oos_trades'
}

interface ShortBiasWalkForwardResult {
  overallPassed: boolean
  failedWindows: number
  windows: ShortBiasWalkForwardWindow[]
  selectionMetrics: {
    averageOutOfSampleErrorRate: number | null
    averageOutOfSampleTradeCount: number
    totalOutOfSampleTradeCount: number
    averageOutOfSampleNetExpectancyPct: number
    averageOutOfSampleSharpe: number
  }
}

interface CarrySlice {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  barCount: number
  startTime: number | null
  endTime: number | null
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
const ZSCORE_LOOKBACK = 30
const SHORT_BIAS_PROTOCOL_VERSION = 'eth_carry_short_bias_selection.v1'

const SHORT_BIAS_IDENTITY = {
  strategyId: 'ETH_CARRY_SHORT_BIAS_V1',
  strategyName: 'ETH Carry Short Bias',
  strategyFamily: 'carry',
  reportFamily: 'eth_carry_short_bias',
  controlArmLabel: 'eth_carry_short_bias_selected_baseline',
  controlArmSource: 'standalone_eth_carry_short_bias_selected_candidate',
  selectionBasis: 'standalone_eth_carry_short_bias',
}

const SHORT_BIAS_CANDIDATES: CarryBacktestCandidate[] = [
  {
    id: 'carry_short_bias_core',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.3,
    shortEntry: { minAbsFundingSpread: 0.0001, minAbsFundingZScore: 1.3 },
    longEntry: { minAbsFundingSpread: 0.00016, minAbsFundingZScore: 1.3 },
    maxHoldingBars: 36,
    stopLossPct: 0.012,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
  {
    id: 'carry_short_bias_soft',
    minAbsFundingSpread: 0.0001,
    minAbsFundingZScore: 1.2,
    shortEntry: { minAbsFundingSpread: 0.0001, minAbsFundingZScore: 1.2 },
    longEntry: { minAbsFundingSpread: 0.00016, minAbsFundingZScore: 1.3 },
    maxHoldingBars: 24,
    stopLossPct: 0.018,
    positionPctOfEquity: 0.015,
    signalPersistenceBars: 8,
  },
]

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const researchSweepCandidates = buildShortBiasVariants().map((thresholds) => toSweepCandidate(thresholds))
  const researchMicroCandidates = buildMicroSweepCandidates()
  const researchUniverse = buildResearchUniverseCandidates({
    sweepCandidates: researchSweepCandidates,
    microCandidates: researchMicroCandidates,
  })

  if (args.selfCheck || args.dryRun) {
    console.log(JSON.stringify({
      family: SHORT_BIAS_IDENTITY.reportFamily,
      strategyId: SHORT_BIAS_IDENTITY.strategyId,
      strategyName: SHORT_BIAS_IDENTITY.strategyName,
      leaderSymbol: ETH.symbol,
      hedgeSymbol: BTC.symbol,
      syntheticSymbol: PAIR_SYMBOL,
      lookbackBars: args.lookbackBars,
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
      riskSimulationCount: args.riskSimulationCount,
      zscoreLookback: ZSCORE_LOOKBACK,
      candidates: SHORT_BIAS_CANDIDATES,
      finalHoldoutBars: args.testBars,
      researchSelection: {
        protocolVersion: SHORT_BIAS_PROTOCOL_VERSION,
        coarseSweepCandidateCount: researchSweepCandidates.length,
        microSweepCandidateCount: researchMicroCandidates.length,
        researchUniverseTrialCount: researchUniverse.length,
        finalists: SHORT_BIAS_CANDIDATES.map((candidate) => candidate.id),
      },
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
  }).slice(-args.lookbackBars)

  const ethFunding = await loadFundingHistory(args.ethFundingPath)
  const btcFunding = await loadFundingHistory(args.btcFundingPath)
  const carrySignals = buildCarrySignalSeries({
    leaderFunding: ethFunding,
    hedgeFunding: btcFunding,
    zScoreLookback: ZSCORE_LOOKBACK,
  })

  const { validationSlice, finalHoldoutSlice } = splitCarrySlicesForFinalHoldout({
    candles: pairCandles,
    carrySignals,
    holdoutBars: args.testBars,
  })
  const validationResearchCandidateReturns = buildCandidateReturnUniverse({
    candles: validationSlice.candles,
    carrySignals: validationSlice.carrySignals,
    candidates: researchUniverse,
  })
  const finalHoldoutResearchCandidateReturns = buildCandidateReturnUniverse({
    candles: finalHoldoutSlice.candles,
    carrySignals: finalHoldoutSlice.carrySignals,
    candidates: researchUniverse,
  })

  const validationBacktests = SHORT_BIAS_CANDIDATES.map((candidate) =>
    runCarryBacktest({
      candles: validationSlice.candles,
      carrySignals: validationSlice.carrySignals,
      candidate,
    }),
  )
  const evaluations: ShortBiasEvaluation[] = []
  for (let index = 0; index < SHORT_BIAS_CANDIDATES.length; index += 1) {
    const candidate = SHORT_BIAS_CANDIDATES[index]
    const backtest = validationBacktests[index]
    const wfo = runShortBiasWalkForward({
      candles: validationSlice.candles,
      carrySignals: validationSlice.carrySignals,
      candidate,
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
    })
    const significance = evaluateSignificanceGate({
      candidateReturns: validationResearchCandidateReturns,
      selectedReturns: backtest.returns,
      partitions: 6,
      pboThreshold: 0.2,
      dsrMin: 0,
      trialCount: researchUniverse.length,
    })
    const riskSimulation = evaluateRiskSimulation(backtest.returns, {
      simulations: args.riskSimulationCount,
      horizonBars: args.testBars,
      blockSize: 24,
      ruinDrawdownPct: 30,
      maxRuinProbability: 0.02,
      minProfitProbability: 0.55,
    })
    const strategyPlanEvidence = buildCarryStrategyPlanEvidence(backtest)
    const releaseGate = evaluateReleaseGate({
      wfo,
      significance,
      riskSimulation,
      economics: buildEconomics(backtest),
      strategyPlanEvidence,
    })
    evaluations.push({
      stage: 'validation_selection',
      candidate,
      backtest,
      wfo,
      significance,
      riskSimulation,
      releaseGate,
      errorRate: computeErrorRate(backtest.trades),
      recent90dErrorRate: computeRecentErrorRate(backtest.trades, 90),
    })
  }

  const validationRanking = [...evaluations].sort(compareShortBiasEvaluations)
  const validationSelected = validationRanking[0]
  const finalHoldoutBacktest = runCarryBacktest({
    candles: finalHoldoutSlice.candles,
    carrySignals: finalHoldoutSlice.carrySignals,
    candidate: validationSelected.candidate,
  })
  const finalHoldoutSignificance = evaluateSignificanceGate({
    candidateReturns: finalHoldoutResearchCandidateReturns,
    selectedReturns: finalHoldoutBacktest.returns,
    partitions: 6,
    pboThreshold: 0.2,
    dsrMin: 0,
    trialCount: researchUniverse.length,
  })
  const finalHoldoutRiskSimulation = evaluateRiskSimulation(finalHoldoutBacktest.returns, {
    simulations: args.riskSimulationCount,
    horizonBars: finalHoldoutSlice.barCount,
    blockSize: 24,
    ruinDrawdownPct: 30,
    maxRuinProbability: 0.02,
    minProfitProbability: 0.55,
  })
  const finalHoldoutStrategyPlanEvidence = buildCarryStrategyPlanEvidence(finalHoldoutBacktest)
  const finalHoldoutReleaseGate = evaluateReleaseGate({
    wfo: validationSelected.wfo,
    significance: finalHoldoutSignificance,
    riskSimulation: finalHoldoutRiskSimulation,
    economics: buildEconomics(finalHoldoutBacktest),
    strategyPlanEvidence: finalHoldoutStrategyPlanEvidence,
  })

  const selected = validationSelected
  const entryGate = buildCarryEntryGate({
    series: carrySignals.filter((signal) => signalPassesCarryCandidate(signal, selected.candidate)),
    minAbsFundingSpread: 0,
    minAbsFundingZScore: 0,
  })
  const entryGateMetadata = {
    signalTimeCount: entryGate.allowedEntryTimes.length,
    firstSignalTime: entryGate.allowedEntryTimes[0] ?? null,
    lastSignalTime: entryGate.allowedEntryTimes.at(-1) ?? null,
    artifactKind: 'historical_signal_observation',
    executable: false,
  }
  const validation: CarryValidationSummary = {
    selectedCandidate: selected.candidate,
    selectedMetrics: finalHoldoutBacktest.metrics,
    trades: finalHoldoutBacktest.trades,
    wfo: selected.wfo,
    significance: finalHoldoutSignificance,
    riskSimulation: finalHoldoutRiskSimulation,
    releaseGate: finalHoldoutReleaseGate,
    strategyPlanEvidence: finalHoldoutStrategyPlanEvidence,
    equityCurve: finalHoldoutBacktest.equityCurve,
  }
  const selectionProtocol = {
    protocolVersion: SHORT_BIAS_PROTOCOL_VERSION,
    researchSelection: {
      artifactKind: 'research_selection',
      executable: false,
      coarseSweepCandidateCount: researchSweepCandidates.length,
      microSweepCandidateCount: researchMicroCandidates.length,
      researchUniverseTrialCount: researchUniverse.length,
      finalists: SHORT_BIAS_CANDIDATES.map((candidate) => candidate.id),
      multipleTestingRegime: {
        significanceTrialCount: researchUniverse.length,
        sourceFamilies: [
          { name: 'coarse_threshold_sweep', trialCount: researchSweepCandidates.length },
          { name: 'micro_family_sweep', trialCount: researchMicroCandidates.length },
        ],
        note: 'Final validation does not shrink multiple-testing accounting to the two-candidate finalist lane.',
      },
    },
    validationSelection: {
      artifactKind: 'validation_selection',
      executable: false,
      selectionMode: 'train_only_wfo_driven',
      candidateCount: SHORT_BIAS_CANDIDATES.length,
      slice: summarizeCarrySlice(validationSlice),
      selectedCandidateId: validationSelected.candidate.id,
      selectedCandidate: validationSelected.candidate,
      selectedMetrics: validationSelected.backtest.metrics,
      selectedReleaseGate: validationSelected.releaseGate,
      selectedSignificance: validationSelected.significance,
      selectedRiskSimulation: validationSelected.riskSimulation,
      selectedWfo: validationSelected.wfo,
      ranking: validationRanking.map((item, rank) => ({
        rank: rank + 1,
        ...toSummaryRow(item),
      })),
    },
    finalHoldout: {
      artifactKind: 'final_holdout_result',
      executable: false,
      slice: summarizeCarrySlice(finalHoldoutSlice),
      selectedCandidateId: validationSelected.candidate.id,
      selectedCandidate: validationSelected.candidate,
      metrics: finalHoldoutBacktest.metrics,
      trades: finalHoldoutBacktest.trades,
      equityCurve: finalHoldoutBacktest.equityCurve,
      significance: finalHoldoutSignificance,
      riskSimulation: finalHoldoutRiskSimulation,
      releaseGate: finalHoldoutReleaseGate,
      summary: buildHoldoutSummary({
        backtest: finalHoldoutBacktest,
        significance: finalHoldoutSignificance,
        releaseGate: finalHoldoutReleaseGate,
      }),
    },
  }

  const generatedAt = new Date().toISOString().replaceAll(':', '-')
  const outputDir = resolve(`data/research/standalone_eth_carry_short_bias/${generatedAt}`)
  await mkdir(outputDir, { recursive: true })
  const validationOutput = resolve(outputDir, 'eth_carry_short_bias.validation.json')
  const releaseGateStatusPath = resolve(outputDir, 'eth_carry_short_bias.release_gate_status.json')
  const validationRunsPath = resolve(outputDir, 'eth_carry_short_bias.strategy_validation_runs.json')
  const experimentVerdictPath = resolve(outputDir, 'eth_carry_short_bias.experiment_verdict.v2.json')
  const championRegistryPath = resolve(outputDir, 'eth_carry_short_bias.paper_champion_registry.json')
  const paperPortfolioTargetPath = resolve(outputDir, 'eth_carry_short_bias.paper_portfolio_target.json')

  const validationReport = buildCarryValidationReport({
    generatedAt,
    validationOutput,
    releaseGateStatusPath,
    args: {
      ...args,
      minAbsFundingSpread: 0.0001,
      minAbsFundingZScore: 1.3,
      minOpenInterestRatio: undefined,
    },
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    carrySignalLookback: ZSCORE_LOOKBACK,
    entryGate: entryGateMetadata,
    regimeGate: buildCarryReportedRegimeGate({
      allowedEntryRegimes: ['HighVolMeanRevert', 'LowVolCarry'],
      exitOnMismatch: true,
    }),
    candidateReports: validationBacktests,
    validation,
    pairCandles: finalHoldoutSlice.candles,
    carrySignals: finalHoldoutSlice.carrySignals,
    selectionProtocol,
    identity: SHORT_BIAS_IDENTITY,
  })
  await writeFile(validationOutput, `${JSON.stringify(validationReport, null, 2)}\n`, 'utf-8')
  const persistedGate = await writeReleaseGateStatus(validation.releaseGate, {
    filePath: releaseGateStatusPath,
    sourceReportPath: validationOutput,
  })
  const paperPortfolioTarget = buildCarryPaperPortfolioTarget({
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    carrySignals,
    pairTimes: pairCandles.map((candle) => candle.time),
    candidate: validation.selectedCandidate,
    basisEquityUsd: args.paperTargetBasisEquityUsd,
    identity: SHORT_BIAS_IDENTITY,
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
        carrySignalLookback: ZSCORE_LOOKBACK,
        candidates: SHORT_BIAS_CANDIDATES,
        identity: SHORT_BIAS_IDENTITY,
      })
    : null

  const summaryPath = resolve(outputDir, 'eth_carry_short_bias_summary.json')
  const summary = {
    generatedAt: new Date().toISOString(),
    family: SHORT_BIAS_IDENTITY.reportFamily,
    strategyId: SHORT_BIAS_IDENTITY.strategyId,
    strategyName: SHORT_BIAS_IDENTITY.strategyName,
    leaderSymbol: ETH.symbol,
    hedgeSymbol: BTC.symbol,
    syntheticSymbol: PAIR_SYMBOL,
    validationOutput,
    releaseGateStatusPath,
    validationRunsPath,
    experimentVerdictPath,
    championRegistryPath,
    paperPortfolioTargetPath,
    selectedParams: validation.selectedCandidate,
    selectedMetrics: validation.selectedMetrics,
    topCandidates: validationRanking.map((item) => toSummaryRow(item)),
    baselineReport: validationReport.baselineReport,
    canonicalScoreboard: validationReport.canonicalScoreboard,
    wfo: validation.wfo,
    significance: validation.significance,
    riskSimulation: validation.riskSimulation,
    releaseGate: validation.releaseGate,
    entryGateMetadata,
    selectionProtocol,
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
  }
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')
  console.log(summaryPath)
}

function runShortBiasWalkForward(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidate: CarryBacktestCandidate
  trainBars: number
  testBars: number
  stepBars: number
}): ShortBiasWalkForwardResult {
  const windows: ShortBiasWalkForwardWindow[] = []
  for (
    let trainStart = 0;
    trainStart + input.trainBars + input.testBars <= input.candles.length;
    trainStart += input.stepBars
  ) {
    const trainEnd = trainStart + input.trainBars
    const testEnd = trainEnd + input.testBars
    const trainCandles = input.candles.slice(trainStart, trainEnd)
    const testCandles = input.candles.slice(trainEnd, testEnd)
    const trainTimes = new Set(trainCandles.map((candle) => candle.time))
    const testTimes = new Set(testCandles.map((candle) => candle.time))
    const trainSignals = input.carrySignals.filter((signal) => trainTimes.has(signal.time))
    const testSignals = input.carrySignals.filter((signal) => testTimes.has(signal.time))
    const trainResult = runCarryBacktest({
      candles: trainCandles,
      carrySignals: trainSignals,
      candidate: input.candidate,
    })
    const testResult = runCarryBacktest({
      candles: testCandles,
      carrySignals: testSignals,
      candidate: input.candidate,
    })
    const degradationRate =
      trainResult.metrics.sharpe > 0
        ? (trainResult.metrics.sharpe - testResult.metrics.sharpe) / Math.abs(trainResult.metrics.sharpe)
        : Number.POSITIVE_INFINITY
    const gatePassed =
      trainResult.metrics.sharpe > 0 &&
      testResult.metrics.tradeCount >= 1 &&
      degradationRate <= 0.4
    const gateReason =
      trainResult.metrics.sharpe <= 0
        ? 'is_non_positive_sharpe'
        : testResult.metrics.tradeCount < 1
          ? 'insufficient_oos_trades'
          : degradationRate > 0.4
            ? 'degradation_exceeded'
            : undefined
    windows.push({
      windowIndex: windows.length,
      selectedCandidate: input.candidate.id,
      inSampleSharpe: trainResult.metrics.sharpe,
      outOfSampleSharpe: testResult.metrics.sharpe,
      outOfSampleTradeCount: testResult.metrics.tradeCount,
      outOfSampleNetExpectancyPct: testResult.metrics.netExpectancyPct,
      outOfSampleErrorRate: computeErrorRate(testResult.trades),
      degradationRate,
      gatePassed,
      gateReason,
    })
  }
  const failedWindows = windows.filter((window) => !window.gatePassed).length
  const outOfSampleErrorRates = windows
    .map((window) => window.outOfSampleErrorRate)
    .filter((value): value is number => typeof value === 'number')
  return {
    overallPassed: failedWindows === 0,
    failedWindows,
    windows,
    selectionMetrics: {
      averageOutOfSampleErrorRate: averageOrNull(outOfSampleErrorRates),
      averageOutOfSampleTradeCount: average(windows.map((window) => window.outOfSampleTradeCount)),
      totalOutOfSampleTradeCount: sum(windows.map((window) => window.outOfSampleTradeCount)),
      averageOutOfSampleNetExpectancyPct: average(windows.map((window) => window.outOfSampleNetExpectancyPct)),
      averageOutOfSampleSharpe: average(windows.map((window) => window.outOfSampleSharpe)),
    },
  }
}

function buildEconomics(backtest: CarryBacktestResult) {
  return buildCarryEconomics(backtest)
}

function computeErrorRate(
  trades: CarryBacktestResult['trades'],
): number | null {
  if (trades.length === 0) return null
  const wins = trades.filter((trade) => trade.netReturnPct > 0).length
  return (trades.length - wins) / trades.length
}

function computeRecentErrorRate(
  trades: CarryBacktestResult['trades'],
  days: number,
): number | null {
  if (trades.length === 0) return null
  const maxExit = Math.max(...trades.map((trade) => trade.exitTime))
  const recent = trades.filter((trade) => trade.exitTime >= maxExit - days * 24 * 3600)
  return computeErrorRate(recent)
}

function compareShortBiasEvaluations(
  left: ShortBiasEvaluation,
  right: ShortBiasEvaluation,
): number {
  if (Number(left.releaseGate.allowPaperTrading) !== Number(right.releaseGate.allowPaperTrading)) {
    return Number(right.releaseGate.allowPaperTrading) - Number(left.releaseGate.allowPaperTrading)
  }
  if (left.wfo.failedWindows !== right.wfo.failedWindows) {
    return left.wfo.failedWindows - right.wfo.failedWindows
  }
  if (left.significance.pboResult.pbo !== right.significance.pboResult.pbo) {
    return left.significance.pboResult.pbo - right.significance.pboResult.pbo
  }
  if (
    (left.wfo.selectionMetrics.averageOutOfSampleErrorRate ?? 1)
    !== (right.wfo.selectionMetrics.averageOutOfSampleErrorRate ?? 1)
  ) {
    return (
      (left.wfo.selectionMetrics.averageOutOfSampleErrorRate ?? 1)
      - (right.wfo.selectionMetrics.averageOutOfSampleErrorRate ?? 1)
    )
  }
  if (left.wfo.selectionMetrics.totalOutOfSampleTradeCount !== right.wfo.selectionMetrics.totalOutOfSampleTradeCount) {
    return right.wfo.selectionMetrics.totalOutOfSampleTradeCount - left.wfo.selectionMetrics.totalOutOfSampleTradeCount
  }
  if (
    left.wfo.selectionMetrics.averageOutOfSampleNetExpectancyPct
    !== right.wfo.selectionMetrics.averageOutOfSampleNetExpectancyPct
  ) {
    return (
      right.wfo.selectionMetrics.averageOutOfSampleNetExpectancyPct
      - left.wfo.selectionMetrics.averageOutOfSampleNetExpectancyPct
    )
  }
  return right.wfo.selectionMetrics.averageOutOfSampleSharpe - left.wfo.selectionMetrics.averageOutOfSampleSharpe
}

function toSummaryRow(item: ShortBiasEvaluation) {
  const shortTrades = item.backtest.trades.filter((trade) => trade.direction === 'short_pair')
  const longTrades = item.backtest.trades.filter((trade) => trade.direction === 'long_pair')
  return {
    candidateId: item.candidate.id,
    thresholds: {
      shortEntry: item.candidate.shortEntry ?? {
        minAbsFundingSpread: item.candidate.minAbsFundingSpread,
        minAbsFundingZScore: item.candidate.minAbsFundingZScore,
      },
      longEntry: item.candidate.longEntry ?? {
        minAbsFundingSpread: item.candidate.minAbsFundingSpread,
        minAbsFundingZScore: item.candidate.minAbsFundingZScore,
      },
      allowLong: item.candidate.allowLong ?? true,
      allowShort: item.candidate.allowShort ?? true,
    },
    tradeCount: item.backtest.metrics.tradeCount,
    winRate: item.backtest.trades.length > 0
      ? item.backtest.trades.filter((trade) => trade.netReturnPct > 0).length / item.backtest.trades.length
      : null,
    errorRate: item.errorRate,
    recent90dTradeCount: (() => {
      if (item.backtest.trades.length === 0) return 0
      const maxExit = Math.max(...item.backtest.trades.map((trade) => trade.exitTime))
      return item.backtest.trades.filter((trade) => trade.exitTime >= maxExit - 90 * 24 * 3600).length
    })(),
    recent90dErrorRate: item.recent90dErrorRate,
    validationStage: item.stage,
    netExpectancyPct: item.backtest.metrics.netExpectancyPct,
    totalReturnPct: item.backtest.metrics.totalReturnPct,
    sharpe: item.backtest.metrics.sharpe,
    averageHoldingHours: item.backtest.metrics.averageHoldingHours,
    validationSelectionAverageOosErrorRate: item.wfo.selectionMetrics.averageOutOfSampleErrorRate,
    validationSelectionAverageOosTradeCount: item.wfo.selectionMetrics.averageOutOfSampleTradeCount,
    validationSelectionTotalOosTradeCount: item.wfo.selectionMetrics.totalOutOfSampleTradeCount,
    validationSelectionAverageOosNetExpectancyPct: item.wfo.selectionMetrics.averageOutOfSampleNetExpectancyPct,
    validationSelectionAverageOosSharpe: item.wfo.selectionMetrics.averageOutOfSampleSharpe,
    shortTradeCount: shortTrades.length,
    shortErrorRate: computeErrorRate(shortTrades),
    longTradeCount: longTrades.length,
    longErrorRate: computeErrorRate(longTrades),
    wfoPassed: item.wfo.overallPassed,
    failedWindows: item.wfo.failedWindows,
    significancePassed: item.significance.passed,
    pbo: item.significance.pboResult.pbo,
    dsrValue: item.significance.dsrResult.dsrValue,
    riskPassed: item.riskSimulation.gatePassed,
    paper: item.releaseGate.allowPaperTrading,
    live: item.releaseGate.allowLiveTrading,
  }
}

function buildHoldoutSummary(input: {
  backtest: CarryBacktestResult
  significance: ReturnType<typeof evaluateSignificanceGate>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}) {
  return {
    tradeCount: input.backtest.metrics.tradeCount,
    recent90dTradeCount: computeRecentTradeCount(input.backtest.trades, 90),
    errorRate: computeErrorRate(input.backtest.trades),
    recent90dErrorRate: computeRecentErrorRate(input.backtest.trades, 90),
    netExpectancyPct: input.backtest.metrics.netExpectancyPct,
    totalReturnPct: input.backtest.metrics.totalReturnPct,
    sharpe: input.backtest.metrics.sharpe,
    pbo: input.significance.pboResult.pbo,
    dsrValue: input.significance.dsrResult.dsrValue,
    paper: input.releaseGate.allowPaperTrading,
    live: input.releaseGate.allowLiveTrading,
  }
}

function buildResearchUniverseCandidates(input: {
  sweepCandidates: CarryBacktestCandidate[]
  microCandidates: CarryBacktestCandidate[]
}): CarryBacktestCandidate[] {
  const byId = new Map<string, CarryBacktestCandidate>()
  for (const candidate of [...input.sweepCandidates, ...input.microCandidates]) {
    if (!byId.has(candidate.id)) {
      byId.set(candidate.id, candidate)
    }
  }
  return [...byId.values()]
}

function buildCandidateReturnUniverse(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  candidates: CarryBacktestCandidate[]
}): number[][] {
  return input.candidates.map((candidate) =>
    runCarryBacktest({
      candles: input.candles,
      carrySignals: input.carrySignals,
      candidate,
    }).returns,
  )
}

function splitCarrySlicesForFinalHoldout(input: {
  candles: PairMarketCandle[]
  carrySignals: CarrySignalPoint[]
  holdoutBars: number
}): {
  validationSlice: CarrySlice
  finalHoldoutSlice: CarrySlice
} {
  if (input.holdoutBars < 2) {
    throw new Error('holdoutBars must be at least 2 to evaluate a final holdout.')
  }
  if (input.candles.length <= input.holdoutBars) {
    throw new Error('Not enough candles to reserve an untouched final holdout.')
  }

  const validationCandles = input.candles.slice(0, -input.holdoutBars)
  const finalHoldoutCandles = input.candles.slice(-input.holdoutBars)
  if (validationCandles.length < 2) {
    throw new Error('Validation slice must contain at least 2 candles after reserving the final holdout.')
  }

  return {
    validationSlice: buildCarrySlice(validationCandles, input.carrySignals),
    finalHoldoutSlice: buildCarrySlice(finalHoldoutCandles, input.carrySignals),
  }
}

function buildCarrySlice(
  candles: PairMarketCandle[],
  carrySignals: CarrySignalPoint[],
): CarrySlice {
  const times = new Set(candles.map((candle) => candle.time))
  return {
    candles,
    carrySignals: carrySignals.filter((signal) => times.has(signal.time)),
    barCount: candles.length,
    startTime: candles[0]?.time ?? null,
    endTime: candles.at(-1)?.time ?? null,
  }
}

function summarizeCarrySlice(slice: CarrySlice) {
  return {
    barCount: slice.barCount,
    startTime: slice.startTime,
    endTime: slice.endTime,
  }
}

function computeRecentTradeCount(
  trades: CarryBacktestResult['trades'],
  days: number,
): number {
  if (trades.length === 0) return 0
  const maxExit = Math.max(...trades.map((trade) => trade.exitTime))
  return trades.filter((trade) => trade.exitTime >= maxExit - days * 24 * 3600).length
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function averageOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  return average(values)
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    ethFundingPath:
      raw.get('ethFundingPath') ??
      'data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json',
    btcFundingPath:
      raw.get('btcFundingPath') ??
      'data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json',
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 6000, 'lookbackBars'),
    trainBars: parseIntArg(raw.get('trainBars'), 3600, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 1200, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 480, 'stepBars'),
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 200, 'riskSimulationCount'),
    paperTargetBasisEquityUsd: parseIntArg(raw.get('paperTargetBasisEquityUsd'), 10_000, 'paperTargetBasisEquityUsd'),
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

export {
  SHORT_BIAS_CANDIDATES,
  SHORT_BIAS_IDENTITY,
  buildResearchUniverseCandidates,
  compareShortBiasEvaluations,
  parseArgs,
  runShortBiasWalkForward,
  splitCarrySlicesForFinalHoldout,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
