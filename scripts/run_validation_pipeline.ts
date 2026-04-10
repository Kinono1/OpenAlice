import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OhlcvData } from '../src/domain/analysis/indicator/types.js'
import { readStrategyConfig } from '../src/core/config.js'
import type { StrategyConfig } from '../src/core/config.js'
import { buildStrategyExecutionDecision } from '../src/domain/strategy/execution.js'
import { buildMetaLabelFeatureVector } from '../src/domain/strategy/meta-labeling/feature-builder.js'
import { evaluateTripleBarrierLabel } from '../src/domain/strategy/meta-labeling/triple-barrier.js'
import { runQuantileTest } from '../src/domain/strategy/research/quantile-test.js'
import { evaluateRuntimeFactorSnapshot } from '../src/domain/strategy/runtime-evaluator.js'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import { evaluateSignificanceGate } from '../src/backtest/statistical_significance.js'
import { runStrategyWalkForward } from '../src/backtest/wfo.js'
import { runStrategyBacktest } from '../src/backtest/strategy-validation/backtest.js'
import type {
  BacktestMetrics,
  BacktestRegimeSummary,
  BacktestResult,
  BacktestTrade,
} from '../src/backtest/strategy-validation/backtest.js'
import type {
  MarketData,
  StrategyName,
  StrategyParams,
  StrategyRegimeLabel,
} from '../src/backtest/strategy-validation/types.js'
import {
  isStrategyName,
} from '../src/backtest/strategy-validation/types.js'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

interface CliArgs {
  inputCsv: string
  symbol: string
  strategy: StrategyName
  lookbackBars: number
  output: string
  params: StrategyParams
  candidates?: StrategyParams[]
  feeRate: number
  slippageBps: number
  latencyBars: number
  fundingRatePer8h: number
  trainBars: number
  testBars: number
  stepBars: number
  degradationThreshold: number
  significancePartitions: number
  riskSimulationMethod: 'iid_bootstrap' | 'moving_block_bootstrap'
  riskSimulationCount: number
  riskHorizonBars: number
  riskBlockSize: number
  riskRuinDrawdownPct: number
  riskMaxRuinProbability: number
  riskMinProfitProbability: number
  writeReleaseGateStatus: boolean
  releaseGateStatusPath: string
  selfCheck: boolean
}

interface ValidationPipelineRunResult {
  args: CliArgs
  candles: MarketData[]
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  reports: BacktestResult[]
  selected: BacktestResult
  summary: Record<string, unknown>
  outputPath: string
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}

async function main(): Promise<ValidationPipelineRunResult | void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.selfCheck) {
    await runSelfCheck()
    console.log('run_validation_pipeline self-check: ok')
    return
  }

  const candles = (await loadCsvCandles(args.inputCsv, args.symbol)).slice(-args.lookbackBars)
  if (candles.length < args.trainBars + args.testBars) {
    throw new Error(
      `Not enough candles for WFO. Need >= ${args.trainBars + args.testBars}, got ${candles.length}.`,
    )
  }

  const candidates = ensureCandidates(args.strategy, args.params, args.candidates)
  const costModel = {
    feeRate: args.feeRate,
    slippageBps: args.slippageBps,
    latencyBars: args.latencyBars,
    fundingRatePer8h: args.fundingRatePer8h,
  }

  const reports = candidates.map((candidate) =>
    runStrategyBacktest({
      strategy: args.strategy,
      candles,
      params: candidate,
      costModel,
    }),
  )
  const selected = [...reports].sort((left, right) => right.metrics.sharpe - left.metrics.sharpe)[0]

  const wfo = runStrategyWalkForward({
    strategy: args.strategy,
    candles,
    candidates,
    costModel,
    config: {
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
      degradationThreshold: args.degradationThreshold,
      minTradesPerWindow: 1,
    },
  })

  const candidateReturns = reports.map((report) => equityCurveToReturns(report.equityCurve))
  const selectedReturns = equityCurveToReturns(selected.equityCurve)
  const significance = evaluateSignificanceGate({
    candidateReturns,
    selectedReturns,
    partitions: args.significancePartitions,
    pboThreshold: 0.2,
    dsrMin: 0,
    trialCount: reports.length,
  })

  const riskSimulation = evaluateRiskSimulation(selectedReturns, {
    method: args.riskSimulationMethod,
    simulations: args.riskSimulationCount,
    horizonBars: args.riskHorizonBars,
    blockSize: args.riskBlockSize,
    ruinDrawdownPct: args.riskRuinDrawdownPct,
    maxRuinProbability: args.riskMaxRuinProbability,
    minProfitProbability: args.riskMinProfitProbability,
  })

  const releaseGate = evaluateReleaseGate({
    wfo,
    significance,
    riskSimulation,
    economics: {
      grossExpectancyPct: selected.metrics.grossExpectancyPct,
      netExpectancyPct: selected.metrics.netExpectancyPct,
      feeExpectancyDragPct: selected.metrics.feeExpectancyDragPct,
      slippageExpectancyDragPct: selected.metrics.slippageExpectancyDragPct,
      fundingExpectancyDragPct: selected.metrics.fundingExpectancyDragPct,
      totalCostsPaid: selected.metrics.totalCostsPaid,
      costDragPctOfInitialCapital: selected.metrics.costDragPctOfInitialCapital,
      averageHoldingHours: selected.metrics.averageHoldingHours,
      medianHoldingHours: selected.metrics.medianHoldingHours,
      tradeCount: selected.metrics.tradeCount,
    },
  })

  const baselineReport = buildBaselineReport(selected.metrics)
  const regimeGateSweep = buildRegimeGateSweep({
    strategy: args.strategy,
    candles,
    params: selected.params,
    costModel,
    baselineMetrics: selected.metrics,
  })
  const strategyConfig = await readStrategyConfig()
  const metaLabelSweep = buildMetaLabelSweep({
    strategy: args.strategy,
    candles,
    costModel,
    strategyConfig,
    baseResult: selected,
    baseLabel: 'baseline',
  })
  const preferredRegimeGateArm =
    regimeGateSweep.enabled === true
      ? (regimeGateSweep.winner ?? regimeGateSweep.bestArm)
      : null
  const metaLabelWithBestRegimeGate = preferredRegimeGateArm
    ? buildMetaLabelSweep({
        strategy: args.strategy,
        candles,
        costModel,
        strategyConfig,
        baseResult: runStrategyBacktest({
          strategy: args.strategy,
          candles,
          params: selected.params,
          costModel,
          regimeGate: preferredRegimeGateArm.gate,
        }),
        baseLabel: 'baseline_plus_best_regime_gate',
        regimeGate: preferredRegimeGateArm.gate,
        regimeGateSelection: {
          source: regimeGateSweep.winner ? 'winner' : 'bestArm',
          gate: preferredRegimeGateArm.gate,
          parentArmId: preferredRegimeGateArm.armId,
          parentArmQualified: preferredRegimeGateArm.diagnostics.qualifies,
          bootstrappedFromUnqualifiedBestArm:
            !regimeGateSweep.winner && !preferredRegimeGateArm.diagnostics.qualifies,
        },
      })
    : {
        enabled: false,
        reason: 'No regime gate arm available for combined meta-label A/B replay.',
      }

  const summary = {
    schemaVersion: 'validation_pipeline_report.v1',
    generatedAt: new Date().toISOString(),
    input: {
      csv: resolve(args.inputCsv),
      symbol: args.symbol,
      strategy: args.strategy,
      lookbackBars: candles.length,
    },
    deployableStrategyTarget: buildDeployableStrategyTarget({
      baselineMetrics: selected.metrics,
      baselineReport,
      releaseGate,
    }),
    selectedParams: selected.params,
    selectedMetrics: selected.metrics,
    baselineReport,
    candidateMetrics: reports.map((report, index) => ({
      candidateIndex: index,
      params: report.params,
      metrics: report.metrics,
      baselineReport: buildBaselineReport(report.metrics),
    })),
    abExperiments: {
      regimeGate: regimeGateSweep,
      metaLabel: metaLabelSweep,
      metaLabelWithBestRegimeGate,
    },
    recommendedCandidate: buildRecommendedCandidate({
      baselineMetrics: selected.metrics,
      baselineReport,
      releaseGate,
      abExperiments: {
        regimeGate: regimeGateSweep,
        metaLabel: metaLabelSweep,
        metaLabelWithBestRegimeGate,
      },
    }),
    wfo: {
      overallPassed: wfo.overallPassed,
      failedWindows: wfo.failedWindows,
      windows: wfo.windows.map((window) => ({
        windowIndex: window.windowIndex,
        selectedCandidate: window.selectedCandidate.id,
        inSampleSharpe: window.inSample.sharpe,
        outOfSampleSharpe: window.outOfSample.sharpe,
        degradationRate: window.degradationRate,
        gatePassed: window.gatePassed,
        gateReason: window.gateReason ?? null,
      })),
    },
    significance: {
      passed: significance.passed,
      pbo: significance.pboResult.pbo,
      dsrValue: significance.dsrResult.dsrValue,
      dsrProbability: significance.dsrResult.dsrProbability,
    },
    riskSimulation,
    releaseGate,
  }

  const outputPath = resolve(args.output)
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf-8')

  if (args.writeReleaseGateStatus) {
    await writeReleaseGateStatus(releaseGate, {
      filePath: args.releaseGateStatusPath,
      sourceReportPath: outputPath,
    })
  }

  console.log(
    [
      `validationReport=${outputPath}`,
      `releaseGateStatus=${args.writeReleaseGateStatus ? resolve(args.releaseGateStatusPath) : 'skip'}`,
      `paper=${releaseGate.allowPaperTrading}`,
      `live=${releaseGate.allowLiveTrading}`,
      `failedChecks=${releaseGate.failedChecks.join(',') || 'none'}`,
    ].join(' | '),
  )

  if (!releaseGate.allowPaperTrading) {
    process.exitCode = 2
  }
  return {
    args,
    candles,
    costModel,
    reports,
    selected,
    summary,
    outputPath,
    releaseGate,
  }
}

function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    inputCsv: raw.get('inputCsv') ?? 'data/market/okx/BTC_USDT_USDT_1h.csv',
    symbol: raw.get('symbol') ?? 'BTC/USD',
    strategy: parseStrategy(raw.get('strategy') ?? 'trend'),
    lookbackBars: parseIntArg(raw.get('lookbackBars'), 3000, 'lookbackBars'),
    output:
      raw.get('output') ??
      `logs/research/validation_${new Date().toISOString().replaceAll(':', '-')}.json`,
    params: parseJsonArg<StrategyParams>(raw.get('paramsJson'), {}),
    candidates: parseJsonArg<StrategyParams[] | undefined>(raw.get('candidatesJson'), undefined),
    feeRate: parseNumberArg(raw.get('feeRate'), 0.0006, 'feeRate'),
    slippageBps: parseNumberArg(raw.get('slippageBps'), 8, 'slippageBps'),
    latencyBars: parseIntArg(raw.get('latencyBars'), 1, 'latencyBars'),
    fundingRatePer8h: parseNumberArg(raw.get('fundingRatePer8h'), 0, 'fundingRatePer8h'),
    trainBars: parseIntArg(raw.get('trainBars'), 24 * 365, 'trainBars'),
    testBars: parseIntArg(raw.get('testBars'), 24 * 90, 'testBars'),
    stepBars: parseIntArg(raw.get('stepBars'), 24 * 90, 'stepBars'),
    degradationThreshold: parseNumberArg(raw.get('degradationThreshold'), 0.4, 'degradationThreshold'),
    significancePartitions: parseIntArg(
      raw.get('significancePartitions'),
      8,
      'significancePartitions',
    ),
    riskSimulationMethod:
      raw.get('riskSimulationMethod') === 'iid_bootstrap'
        ? 'iid_bootstrap'
        : 'moving_block_bootstrap',
    riskSimulationCount: parseIntArg(raw.get('riskSimulationCount'), 5000, 'riskSimulationCount'),
    riskHorizonBars: parseIntArg(raw.get('riskHorizonBars'), 24 * 90, 'riskHorizonBars'),
    riskBlockSize: parseIntArg(raw.get('riskBlockSize'), 24, 'riskBlockSize'),
    riskRuinDrawdownPct: parseNumberArg(
      raw.get('riskRuinDrawdownPct'),
      30,
      'riskRuinDrawdownPct',
    ),
    riskMaxRuinProbability: parseNumberArg(
      raw.get('riskMaxRuinProbability'),
      0.02,
      'riskMaxRuinProbability',
    ),
    riskMinProfitProbability: parseNumberArg(
      raw.get('riskMinProfitProbability'),
      0.55,
      'riskMinProfitProbability',
    ),
    writeReleaseGateStatus: parseBoolArg(raw.get('writeReleaseGateStatus'), true),
    releaseGateStatusPath:
      raw.get('releaseGateStatusPath') ?? 'data/runtime/release_gate_status.json',
    selfCheck: parseBoolArg(raw.get('selfCheck'), false),
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


const ALL_REGIME_LABELS: StrategyRegimeLabel[] = [
  'HighVolTrend',
  'HighVolMeanRevert',
  'LowVolTrend',
  'LowVolCarry',
]

const REGIME_GATE_MIN_TRADE_RETENTION_RATIO = 0.3
const META_LABEL_MIN_TRADE_RETENTION_RATIO = 0.05
const META_LABEL_TOP_COVERAGE_RATIOS = [0.5, 0.3, 0.2, 0.1, 0.05] as const
const META_LABEL_SELECTION_MODES = ['global', 'perRegime'] as const
const PAPER_RELEASE_GATE_CHECKS = [
  'wfo',
  'significance',
  'risk_simulation',
  'economics',
] as const
const LIVE_RELEASE_GATE_CHECKS = [
  'wfo',
  'significance',
  'risk_simulation',
  'economics',
  'execution_quality',
  'ramp_up',
  'regime_shift',
] as const
const DEFAULT_META_LABELING_CONFIG = {
  enabled: false,
  upperBarrierPct: 2,
  lowerBarrierPct: 1,
  maxHoldingBars: 24,
  minConfidenceToTrade: 0.55,
}

interface RecommendedArmCandidate {
  source: 'regimeGate' | 'metaLabel' | 'metaLabelWithBestRegimeGate'
  armId: string
  label: string
  rank: number | null
  metrics: ReturnType<typeof summarizeMetrics>
  baselineReport: ReturnType<typeof buildBaselineReport>
  delta: ReturnType<typeof buildMetricDelta>
  diagnostics: Record<string, unknown> | null
  selection: Record<string, unknown> | null
  gate: {
    allowedEntryRegimes: StrategyRegimeLabel[]
    exitOnMismatch?: boolean
  } | null
  regimeGateSelection: {
    source: 'winner' | 'bestArm'
    gate: {
      allowedEntryRegimes: StrategyRegimeLabel[]
      exitOnMismatch?: boolean
    }
    parentArmId?: string | null
    parentArmQualified?: boolean | null
    bootstrappedFromUnqualifiedBestArm?: boolean
  } | null
}

interface MetaLabelCandidate {
  trade: BacktestTrade
  entryIndex: number
  entryTime: number
  direction: BacktestTrade['direction']
  score: number
  tripleBarrier: ReturnType<typeof evaluateTripleBarrierLabel>
  featureRecord: Record<string, number>
}

type MetaLabelSelectionMode = typeof META_LABEL_SELECTION_MODES[number]

function buildMetaLabelSweep(input: {
  strategy: StrategyName
  candles: MarketData[]
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  strategyConfig: StrategyConfig
  baseResult: BacktestResult
  baseLabel: string
  regimeGate?: {
    allowedEntryRegimes: StrategyRegimeLabel[]
    exitOnMismatch?: boolean
  }
  regimeGateSelection?: {
    source: 'winner' | 'bestArm'
    gate: {
      allowedEntryRegimes: StrategyRegimeLabel[]
      exitOnMismatch?: boolean
    }
    parentArmId?: string | null
    parentArmQualified?: boolean | null
    bootstrappedFromUnqualifiedBestArm?: boolean
  }
}) {
  if (input.strategy !== 'factorMeanReversion') {
    return {
      enabled: false,
      reason: 'Meta-label quantile sweep is currently only wired for factorMeanReversion.',
    }
  }

  if (input.baseResult.trades.length < 5) {
    return {
      enabled: false,
      reason: 'Meta-label quantile sweep needs at least 5 baseline trades.',
    }
  }

  const metaLabeling = input.strategyConfig.metaLabeling ?? DEFAULT_META_LABELING_CONFIG
  const candidates = buildMetaLabelCandidates({
    candles: input.candles,
    strategyConfig: input.strategyConfig,
    costModel: input.costModel,
    trades: input.baseResult.trades,
    metaLabeling,
    initialCapital: input.baseResult.metrics.initialCapital,
  })

  if (candidates.length < 5) {
    return {
      enabled: false,
      reason: 'Meta-label quantile sweep could not build enough scored trade candidates.',
    }
  }

  const baseline = {
    label: input.baseLabel,
    metrics: summarizeMetrics(input.baseResult.metrics),
    baselineReport: buildBaselineReport(input.baseResult.metrics),
  }
  const quantileDiagnostics = {
    netReturnAfterCost: runQuantileTest(
      candidates.map((candidate) => ({
        factorValue: candidate.score,
        forwardReturn: candidate.trade.netReturnPct,
      })),
      5,
    ),
    tripleBarrierReturn: runQuantileTest(
      candidates.map((candidate) => ({
        factorValue: candidate.score,
        forwardReturn: candidate.tripleBarrier.realizedReturnPct,
      })),
      5,
    ),
  }
  const arms = META_LABEL_SELECTION_MODES
    .flatMap((selectionMode) =>
      META_LABEL_TOP_COVERAGE_RATIOS.map((coverageRatio) => {
        const selectedCandidates = selectMetaLabelCandidates(candidates, coverageRatio, selectionMode)
        const selectedScores = selectedCandidates.map((candidate) => candidate.score)
        const selectedEntryTimes = selectedCandidates.map((candidate) => candidate.entryTime)
        const candidate = runStrategyBacktest({
          strategy: input.strategy,
          candles: input.candles,
          params: input.baseResult.params,
          costModel: input.costModel,
          regimeGate: input.regimeGate,
          entryGate: {
            allowedEntryTimes: selectedEntryTimes,
          },
        })
        const byRegimeSelectionDiagnostics = buildPerRegimeSelectionDiagnostics({
          candidates,
          selectedCandidates,
          realizedTrades: candidate.trades,
        })
        const delta = buildMetricDelta(input.baseResult.metrics, candidate.metrics)
        const tradeCountRetentionRatio =
          input.baseResult.metrics.tradeCount > 0
            ? candidate.metrics.tradeCount / input.baseResult.metrics.tradeCount
            : candidate.metrics.tradeCount > 0
              ? 1
              : 0
        const positiveAbsoluteNetExpectancy = candidate.metrics.netExpectancyPct > 0
        const passesNetExpectancyConstraint = delta.netExpectancyPct > 0
        const passesTradeCountConstraint =
          tradeCountRetentionRatio >= META_LABEL_MIN_TRADE_RETENTION_RATIO
        const passesDrawdownConstraint =
          candidate.metrics.maxDrawdownPct <= input.baseResult.metrics.maxDrawdownPct
        const qualifies =
          positiveAbsoluteNetExpectancy &&
          passesNetExpectancyConstraint &&
          passesTradeCountConstraint &&
          passesDrawdownConstraint &&
          candidate.metrics.tradeCount > 0

        return {
          armId: `meta_label_${selectionMode}_top_${Math.round(coverageRatio * 100)}pct`,
          label: `${input.baseLabel}_plus_meta_label_${selectionMode}_top_${Math.round(coverageRatio * 100)}pct`,
          selection: {
            mode: selectionMode,
            coveragePct: coverageRatio * 100,
            selectedCandidateCount: selectedCandidates.length,
            minScoreIncluded: selectedScores.length > 0 ? Math.min(...selectedScores) : 0,
            maxScoreIncluded: selectedScores.length > 0 ? Math.max(...selectedScores) : 0,
            regimeBreadth: new Set(selectedCandidates.map((item) => item.trade.entryRegime)).size,
            byRegime: byRegimeSelectionDiagnostics,
          },
          metrics: summarizeMetrics(candidate.metrics),
          baselineReport: buildBaselineReport(candidate.metrics),
          delta,
          diagnostics: {
            tradeCountRetentionPct: tradeCountRetentionRatio * 100,
            realizedTradeCount: candidate.metrics.tradeCount,
            realizedSelectedCandidatePct: percentage(
              candidate.metrics.tradeCount,
              selectedCandidates.length,
            ),
            selectedCandidateCollapseCount: Math.max(
              0,
              selectedCandidates.length - candidate.metrics.tradeCount,
            ),
            positiveAbsoluteNetExpectancy,
            positiveTripleBarrierLabelPct: percentage(
              selectedCandidates.filter((item) => item.tripleBarrier.label === 1).length,
              selectedCandidates.length,
            ),
            averageTripleBarrierReturnPct: average(
              selectedCandidates.map((item) => item.tripleBarrier.realizedReturnPct),
            ),
            averageNetTradeReturnPct: average(
              selectedCandidates.map((item) => item.trade.netReturnPct),
            ),
            averageSelectedScore: average(selectedScores),
            passesNetExpectancyConstraint,
            passesTradeCountConstraint,
            passesDrawdownConstraint,
            qualifies,
          },
        }
      }),
    )
    .sort(compareMetaLabelArms)
    .map((arm, index) => ({
      rank: index + 1,
      ...arm,
    }))

  const qualifiedArms = arms.filter((arm) => arm.diagnostics.qualifies)

  return {
    enabled: true,
    baseline,
    baseLabel: input.baseLabel,
    regimeGateSelection: input.regimeGateSelection ?? null,
    referenceConfig: {
      upperBarrierPct: metaLabeling.upperBarrierPct,
      lowerBarrierPct: metaLabeling.lowerBarrierPct,
      maxHoldingBars: metaLabeling.maxHoldingBars,
      minConfidenceToTrade: metaLabeling.minConfidenceToTrade,
    },
    selectionConstraints: {
      selectionModes: [...META_LABEL_SELECTION_MODES],
      minTradeCountRetentionPct: META_LABEL_MIN_TRADE_RETENTION_RATIO * 100,
      requirePositiveAbsoluteNetExpectancy: true,
      requirePositiveNetExpectancyDelta: true,
      requireDrawdownNoWorseThanBaseline: true,
    },
    candidateDiagnostics: {
      candidateCount: candidates.length,
      scoreRange: {
        min: Math.min(...candidates.map((candidate) => candidate.score)),
        max: Math.max(...candidates.map((candidate) => candidate.score)),
        average: average(candidates.map((candidate) => candidate.score)),
      },
      positiveTripleBarrierLabelPct: percentage(
        candidates.filter((candidate) => candidate.tripleBarrier.label === 1).length,
        candidates.length,
      ),
      averageTripleBarrierReturnPct: average(
        candidates.map((candidate) => candidate.tripleBarrier.realizedReturnPct),
      ),
      averageNetTradeReturnPct: average(candidates.map((candidate) => candidate.trade.netReturnPct)),
    },
    quantileDiagnostics,
    evaluatedArmCount: arms.length,
    qualifiedArmCount: qualifiedArms.length,
    winner: qualifiedArms[0] ?? null,
    bestArm: arms[0] ?? null,
    arms,
  }
}

function buildMetaLabelCandidates(input: {
  candles: MarketData[]
  strategyConfig: StrategyConfig
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  trades: BacktestTrade[]
  metaLabeling: {
    enabled: boolean
    upperBarrierPct: number
    lowerBarrierPct: number
    maxHoldingBars: number
    minConfidenceToTrade: number
  }
  initialCapital: number
}): MetaLabelCandidate[] {
  const indexByTime = new Map(input.candles.map((candle, index) => [candle.time, index]))
  const ohlcvCandles = toOhlcvCandles(input.candles)
  const symbol = input.candles[0]?.symbol ?? 'BTC/USD'

  return input.trades.flatMap((trade) => {
    const entryIndex = indexByTime.get(trade.entryTime)
    if (entryIndex == null || entryIndex < 1) {
      return []
    }

    const snapshot = evaluateRuntimeFactorSnapshot({
      symbol,
      candles: ohlcvCandles.slice(0, entryIndex + 1),
      strategyConfig: input.strategyConfig,
      sourceTier: 'L3',
      useType: 'U2',
      sentiment: 'S0',
      fundingRatePct: input.costModel.fundingRatePer8h * 100,
      equity: input.initialCapital,
      currentOpenPositions: 0,
      currentLayerOpenPositions: 0,
    })
    const requestedNotionalUsd = Math.max(
      1,
      snapshot.positionSizing.recommendedNotionalUsd ?? input.initialCapital * 0.01,
    )
    const decision = buildStrategyExecutionDecision({
      snapshot,
      request: {
        symbol,
        side: trade.direction === 'long' ? 'buy' : 'sell',
        type: 'market',
        usd_size: requestedNotionalUsd,
      },
      isNewOpen: true,
      referencePrice: trade.entryReferencePrice,
    })
    const featureVector = buildMetaLabelFeatureVector({
      snapshot,
      decision,
    })

    return [{
      trade,
      entryIndex,
      entryTime: trade.entryTime,
      direction: trade.direction,
      score: computeMetaLabelScore(featureVector.record, trade.direction),
      tripleBarrier: evaluateTripleBarrierLabel({
        candles: ohlcvCandles,
        entryIndex,
        upperBarrierPct: input.metaLabeling.upperBarrierPct,
        lowerBarrierPct: input.metaLabeling.lowerBarrierPct,
        maxHoldingBars: input.metaLabeling.maxHoldingBars,
        side: trade.direction,
      }),
      featureRecord: featureVector.record,
    }]
  })
}

function computeMetaLabelScore(
  features: Record<string, number>,
  direction: BacktestTrade['direction'],
): number {
  const requestedNotional = features['decision-requested-notional'] ?? 0
  const effectiveNotional = features['decision-effective-notional'] ?? 0
  const notionalEfficiency =
    requestedNotional > 0 ? clamp01(effectiveNotional / requestedNotional) : 0
  const shortHorizonReversion = normalizeDirectionalReversion(
    features['return-1h-pct'] ?? 0,
    direction,
    4,
  )
  const mediumHorizonReversion = normalizeDirectionalReversion(
    features['return-24h-pct'] ?? 0,
    direction,
    12,
  )

  return clamp01(
    0.2 * clamp01(features['ensemble-confidence'] ?? 0) +
      0.18 * clamp01(features['governance-total-score'] ?? 0) +
      0.1 * clamp01(features['execution-clarity-score'] ?? 0) +
      0.08 * clamp01(features['regime-confidence'] ?? 0) +
      0.04 * clamp01(features['hmm-confidence'] ?? 0) +
      0.08 * (1 - clamp01(features['hmm-stress-prob'] ?? 0)) +
      0.12 * shortHorizonReversion +
      0.08 * mediumHorizonReversion +
      0.05 * (1 - clamp01((features['realized-vol-pct'] ?? 0) / 100)) +
      0.03 * clamp01((features['position-sizing-pct'] ?? 0) / 0.3) +
      0.02 * (1 - clamp01(features['freeze-active'] ?? 0)) +
      0.02 * clamp01(features['decision-mode-applied'] ?? 0) +
      0.1 * notionalEfficiency,
  )
}

function selectMetaLabelCandidates(
  candidates: MetaLabelCandidate[],
  coverageRatio: number,
  selectionMode: MetaLabelSelectionMode,
): MetaLabelCandidate[] {
  if (selectionMode === 'perRegime') {
    return selectTopMetaLabelCandidatesPerRegime(candidates, coverageRatio)
  }
  return selectTopMetaLabelCandidates(candidates, coverageRatio)
}

function selectTopMetaLabelCandidates(
  candidates: MetaLabelCandidate[],
  coverageRatio: number,
): MetaLabelCandidate[] {
  const ordered = [...candidates].sort(
    (left, right) => right.score - left.score || left.entryTime - right.entryTime,
  )
  const keepCount = Math.max(1, Math.ceil(ordered.length * coverageRatio))
  return ordered.slice(0, keepCount).sort((left, right) => left.entryTime - right.entryTime)
}

function selectTopMetaLabelCandidatesPerRegime(
  candidates: MetaLabelCandidate[],
  coverageRatio: number,
): MetaLabelCandidate[] {
  const groups = new Map<StrategyRegimeLabel, MetaLabelCandidate[]>()
  for (const candidate of candidates) {
    const current = groups.get(candidate.trade.entryRegime) ?? []
    current.push(candidate)
    groups.set(candidate.trade.entryRegime, current)
  }

  return [...groups.values()]
    .flatMap((group) => {
      const ordered = [...group].sort(
        (left, right) => right.score - left.score || left.entryTime - right.entryTime,
      )
      const keepCount = Math.max(1, Math.ceil(ordered.length * coverageRatio))
      return ordered.slice(0, keepCount)
    })
    .sort((left, right) => left.entryTime - right.entryTime)
}

function buildPerRegimeSelectionDiagnostics(input: {
  candidates: MetaLabelCandidate[]
  selectedCandidates: MetaLabelCandidate[]
  realizedTrades: BacktestTrade[]
}) {
  const rawCounts = new Map<StrategyRegimeLabel, number>()
  const selectedCounts = new Map<StrategyRegimeLabel, number>()
  const realizedCounts = new Map<StrategyRegimeLabel, number>()

  for (const candidate of input.candidates) {
    rawCounts.set(candidate.trade.entryRegime, (rawCounts.get(candidate.trade.entryRegime) ?? 0) + 1)
  }
  for (const candidate of input.selectedCandidates) {
    selectedCounts.set(
      candidate.trade.entryRegime,
      (selectedCounts.get(candidate.trade.entryRegime) ?? 0) + 1,
    )
  }
  for (const trade of input.realizedTrades) {
    realizedCounts.set(trade.entryRegime, (realizedCounts.get(trade.entryRegime) ?? 0) + 1)
  }

  return ALL_REGIME_LABELS.map((regime) => {
    const rawCandidateCount = rawCounts.get(regime) ?? 0
    const selectedCandidateCount = selectedCounts.get(regime) ?? 0
    const realizedTradeCount = realizedCounts.get(regime) ?? 0

    return {
      regime,
      rawCandidateCount,
      selectedCandidateCount,
      realizedTradeCount,
      selectedCoveragePct: percentage(selectedCandidateCount, rawCandidateCount),
      realizedSelectedCandidatePct: percentage(realizedTradeCount, selectedCandidateCount),
      selectedCandidateCollapseCount: Math.max(0, selectedCandidateCount - realizedTradeCount),
    }
  })
}

function compareMetaLabelArms(
  left: {
    delta: ReturnType<typeof buildMetricDelta>
    metrics: ReturnType<typeof summarizeMetrics>
    diagnostics: { qualifies: boolean; tradeCountRetentionPct: number }
    selection: { mode: string; coveragePct: number; regimeBreadth: number }
  },
  right: {
    delta: ReturnType<typeof buildMetricDelta>
    metrics: ReturnType<typeof summarizeMetrics>
    diagnostics: { qualifies: boolean; tradeCountRetentionPct: number }
    selection: { mode: string; coveragePct: number; regimeBreadth: number }
  },
): number {
  if (left.diagnostics.qualifies !== right.diagnostics.qualifies) {
    return left.diagnostics.qualifies ? -1 : 1
  }
  if ((left.metrics.netExpectancyPct > 0) !== (right.metrics.netExpectancyPct > 0)) {
    return left.metrics.netExpectancyPct > 0 ? -1 : 1
  }
  if (left.metrics.netExpectancyPct !== right.metrics.netExpectancyPct) {
    return right.metrics.netExpectancyPct - left.metrics.netExpectancyPct
  }
  if (left.delta.netExpectancyPct !== right.delta.netExpectancyPct) {
    return right.delta.netExpectancyPct - left.delta.netExpectancyPct
  }
  if (left.metrics.maxDrawdownPct !== right.metrics.maxDrawdownPct) {
    return left.metrics.maxDrawdownPct - right.metrics.maxDrawdownPct
  }
  if (left.selection.regimeBreadth !== right.selection.regimeBreadth) {
    return right.selection.regimeBreadth - left.selection.regimeBreadth
  }
  if (left.diagnostics.tradeCountRetentionPct !== right.diagnostics.tradeCountRetentionPct) {
    return right.diagnostics.tradeCountRetentionPct - left.diagnostics.tradeCountRetentionPct
  }
  if (left.metrics.tradeCount !== right.metrics.tradeCount) {
    return right.metrics.tradeCount - left.metrics.tradeCount
  }
  if (left.selection.coveragePct !== right.selection.coveragePct) {
    return right.selection.coveragePct - left.selection.coveragePct
  }
  return left.selection.mode.localeCompare(right.selection.mode)
}

function toOhlcvCandles(candles: MarketData[]): OhlcvData[] {
  return candles.map((candle) => ({
    date: new Date(candle.time * 1000).toISOString(),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
  }))
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.min(1, Math.max(0, value))
}

function normalizeDirectionalReversion(
  returnPct: number,
  direction: BacktestTrade['direction'],
  scalePct: number,
): number {
  if (!Number.isFinite(returnPct) || scalePct <= 0) {
    return 0.5
  }
  const signed = direction === 'long' ? -returnPct : returnPct
  return clamp01((signed + scalePct) / (2 * scalePct))
}

function average(values: number[]): number {
  if (values.length < 1) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0
  }
  return (numerator / denominator) * 100
}

function buildRegimeGateSweep(input: {
  strategy: StrategyName
  candles: MarketData[]
  params: StrategyParams
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  baselineMetrics: BacktestMetrics
}) {
  if (input.strategy !== 'factorMeanReversion') {
    return {
      enabled: false,
      reason: 'Regime-gating sweep is currently only wired for factorMeanReversion.',
    }
  }

  const baseline = {
    metrics: summarizeMetrics(input.baselineMetrics),
    baselineReport: buildBaselineReport(input.baselineMetrics),
  }
  const arms = enumerateRegimeGateConfigs(ALL_REGIME_LABELS)
    .map((gate, index) => {
      const candidate = runStrategyBacktest({
        strategy: input.strategy,
        candles: input.candles,
        params: input.params,
        costModel: input.costModel,
        regimeGate: gate,
      })
      const delta = buildMetricDelta(input.baselineMetrics, candidate.metrics)
      const tradeCountRetentionRatio =
        input.baselineMetrics.tradeCount > 0
          ? candidate.metrics.tradeCount / input.baselineMetrics.tradeCount
          : candidate.metrics.tradeCount > 0
            ? 1
            : 0
      const improvedRegimes = Object.entries(delta.byRegimeNetExpectancyPct)
        .filter(([, value]) => value > 0)
        .map(([label]) => label as StrategyRegimeLabel)
      const passesNetExpectancyConstraint = delta.netExpectancyPct > 0
      const passesTradeCountConstraint =
        tradeCountRetentionRatio >= REGIME_GATE_MIN_TRADE_RETENTION_RATIO
      const passesDrawdownConstraint =
        candidate.metrics.maxDrawdownPct <= input.baselineMetrics.maxDrawdownPct
      const qualifies =
        passesNetExpectancyConstraint &&
        passesTradeCountConstraint &&
        passesDrawdownConstraint &&
        improvedRegimes.length > 0

      return {
        armId: `regime_gate_${index + 1}`,
        gate,
        metrics: summarizeMetrics(candidate.metrics),
        baselineReport: buildBaselineReport(candidate.metrics),
        delta,
        diagnostics: {
          tradeCountRetentionPct: tradeCountRetentionRatio * 100,
          improvedRegimes,
          positiveRegimeImprovementCount: improvedRegimes.length,
          passesNetExpectancyConstraint,
          passesTradeCountConstraint,
          passesDrawdownConstraint,
          qualifies,
        },
      }
    })
    .sort(compareRegimeGateArms)
    .map((arm, index) => ({
      rank: index + 1,
      ...arm,
    }))

  const qualifiedArms = arms.filter((arm) => arm.diagnostics.qualifies)

  return {
    enabled: true,
    baseline,
    selectionConstraints: {
      minTradeCountRetentionPct: REGIME_GATE_MIN_TRADE_RETENTION_RATIO * 100,
      requirePositiveNetExpectancyDelta: true,
      requireDrawdownNoWorseThanBaseline: true,
      minPositiveRegimeImprovementCount: 1,
    },
    evaluatedArmCount: arms.length,
    qualifiedArmCount: qualifiedArms.length,
    winner: qualifiedArms[0] ?? null,
    bestArm: arms[0] ?? null,
    arms,
  }
}

function enumerateRegimeGateConfigs(labels: StrategyRegimeLabel[]) {
  const out: Array<{
    allowedEntryRegimes: StrategyRegimeLabel[]
    exitOnMismatch: boolean
  }> = []
  for (let mask = 1; mask < 2 ** labels.length; mask += 1) {
    const allowedEntryRegimes = labels.filter((_, index) => (mask & (1 << index)) !== 0)
    out.push({ allowedEntryRegimes, exitOnMismatch: true })
    out.push({ allowedEntryRegimes, exitOnMismatch: false })
  }
  return out
}

function compareRegimeGateArms(
  left: {
    delta: ReturnType<typeof buildMetricDelta>
    metrics: ReturnType<typeof summarizeMetrics>
    diagnostics: { qualifies: boolean }
    gate: { allowedEntryRegimes: StrategyRegimeLabel[]; exitOnMismatch: boolean }
  },
  right: {
    delta: ReturnType<typeof buildMetricDelta>
    metrics: ReturnType<typeof summarizeMetrics>
    diagnostics: { qualifies: boolean }
    gate: { allowedEntryRegimes: StrategyRegimeLabel[]; exitOnMismatch: boolean }
  },
): number {
  if (left.diagnostics.qualifies !== right.diagnostics.qualifies) {
    return left.diagnostics.qualifies ? -1 : 1
  }
  if (left.delta.netExpectancyPct !== right.delta.netExpectancyPct) {
    return right.delta.netExpectancyPct - left.delta.netExpectancyPct
  }
  if (left.delta.totalReturnPct !== right.delta.totalReturnPct) {
    return right.delta.totalReturnPct - left.delta.totalReturnPct
  }
  if (left.metrics.maxDrawdownPct !== right.metrics.maxDrawdownPct) {
    return left.metrics.maxDrawdownPct - right.metrics.maxDrawdownPct
  }
  if (left.metrics.tradeCount !== right.metrics.tradeCount) {
    return right.metrics.tradeCount - left.metrics.tradeCount
  }
  if (left.gate.allowedEntryRegimes.length !== right.gate.allowedEntryRegimes.length) {
    return right.gate.allowedEntryRegimes.length - left.gate.allowedEntryRegimes.length
  }
  return Number(left.gate.exitOnMismatch) - Number(right.gate.exitOnMismatch)
}

function summarizeMetrics(metrics: BacktestMetrics) {
  return {
    totalReturnPct: metrics.totalReturnPct,
    netExpectancyPct: metrics.netExpectancyPct,
    maxDrawdownPct: metrics.maxDrawdownPct,
    tradeCount: metrics.tradeCount,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    calmar: metrics.calmar,
  }
}

function buildMetricDelta(
  baseline: BacktestMetrics,
  candidate: BacktestMetrics,
) {
  return {
    totalReturnPct: candidate.totalReturnPct - baseline.totalReturnPct,
    netExpectancyPct: candidate.netExpectancyPct - baseline.netExpectancyPct,
    maxDrawdownPct: candidate.maxDrawdownPct - baseline.maxDrawdownPct,
    tradeCount: candidate.tradeCount - baseline.tradeCount,
    sharpe: candidate.sharpe - baseline.sharpe,
    byRegimeNetExpectancyPct: buildRegimeNetExpectancyDelta(
      baseline.regimeSummary,
      candidate.regimeSummary,
    ),
  }
}

function buildRegimeNetExpectancyDelta(
  baseline: BacktestMetrics['regimeSummary'],
  candidate: BacktestMetrics['regimeSummary'],
): Partial<Record<StrategyRegimeLabel, number>> {
  const labels = new Set<StrategyRegimeLabel>([
    ...Object.keys(baseline) as StrategyRegimeLabel[],
    ...Object.keys(candidate) as StrategyRegimeLabel[],
  ])
  const out: Partial<Record<StrategyRegimeLabel, number>> = {}
  for (const label of labels) {
    out[label] =
      (candidate[label]?.netExpectancyPct ?? 0) -
      (baseline[label]?.netExpectancyPct ?? 0)
  }
  return out
}
function buildDeployableStrategyTarget(input: {
  baselineMetrics: BacktestMetrics
  baselineReport: ReturnType<typeof buildBaselineReport>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}) {
  return {
    controlArm: {
      label: 'current_runtime_baseline',
      source: 'selected_runtime_baseline',
      description: 'Use the currently selected runtime baseline as the control arm for additive strategy experiments.',
      metrics: summarizeMetrics(input.baselineMetrics),
      baselineReport: input.baselineReport,
    },
    optimizationTarget: {
      primaryMetric: 'netExpectancyPct',
      objective: 'positive_out_of_sample_net_expectancy_after_fees_slippage_and_funding',
      measurement: 'candidate_net_expectancy_pct_minus_control_arm_net_expectancy_pct',
      requirePositiveDeltaVsControlArm: true,
    },
    robustnessTarget: {
      releaseGate: {
        currentStatus: {
          allowPaperTrading: input.releaseGate.allowPaperTrading,
          allowLiveTrading: input.releaseGate.allowLiveTrading,
          failedChecks: input.releaseGate.failedChecks,
          warningChecks: input.releaseGate.warningChecks,
        },
        paperTrading: {
          requireAllowPaperTrading: true,
          blockingChecks: [...PAPER_RELEASE_GATE_CHECKS],
        },
        liveTrading: {
          requireAllowLiveTrading: true,
          blockingChecks: [...LIVE_RELEASE_GATE_CHECKS],
        },
      },
    },
    practicalConstraints: {
      drawdown: {
        requireNoWorseThanControlArm: true,
        maxDrawdownPctControlArm: input.baselineMetrics.maxDrawdownPct,
      },
      tradeCount: {
        regimeGateMinRetentionPct: REGIME_GATE_MIN_TRADE_RETENTION_RATIO * 100,
        metaLabelMinRetentionPct: META_LABEL_MIN_TRADE_RETENTION_RATIO * 100,
      },
    },
  }
}

function buildRecommendedCandidate(input: {
  baselineMetrics: BacktestMetrics
  baselineReport: ReturnType<typeof buildBaselineReport>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  abExperiments: {
    regimeGate: ReturnType<typeof buildRegimeGateSweep>
    metaLabel: ReturnType<typeof buildMetaLabelSweep>
    metaLabelWithBestRegimeGate: ReturnType<typeof buildMetaLabelSweep>
  }
}) {
  const controlArm = {
    label: 'current_runtime_baseline',
    source: 'selected_runtime_baseline',
    metrics: summarizeMetrics(input.baselineMetrics),
    baselineReport: input.baselineReport,
  }
  const candidatesBySource = {
    regimeGate: selectRecommendedArmCandidate('regimeGate', input.abExperiments.regimeGate),
    metaLabel: selectRecommendedArmCandidate('metaLabel', input.abExperiments.metaLabel),
    metaLabelWithBestRegimeGate: selectRecommendedArmCandidate(
      'metaLabelWithBestRegimeGate',
      input.abExperiments.metaLabelWithBestRegimeGate,
    ),
  }
  const rankedCandidates = Object.values(candidatesBySource)
    .filter((candidate): candidate is RecommendedArmCandidate => candidate != null)
    .sort(compareRecommendedCandidates)
  const champion = rankedCandidates[0] ?? null
  const qualifiedCandidateCount = rankedCandidates.filter(isRecommendedArmQualified).length
  const reasonCodes = buildRecommendedCandidateReasonCodes({
    champion,
    releaseGate: input.releaseGate,
  })
  const promoteChampion = champion != null && reasonCodes.length === 0
  const selectionDiagnosticsSummary = buildRecommendedSelectionDiagnosticsSummary(champion)

  return {
    controlArm,
    candidatesBySource,
    candidateCount: rankedCandidates.length,
    qualifiedCandidateCount,
    champion,
    combinedWinnerEvidence: buildCombinedWinnerEvidence({
      champion,
      candidatesBySource,
    }),
    selectionDiagnosticsSummary,
    releaseGateStatus: {
      allowPaperTrading: input.releaseGate.allowPaperTrading,
      allowLiveTrading: input.releaseGate.allowLiveTrading,
      failedChecks: input.releaseGate.failedChecks,
      warningChecks: input.releaseGate.warningChecks,
    },
    recommendation: {
      action: promoteChampion ? 'promote_candidate' : 'stay_on_baseline',
      targetSource: promoteChampion ? champion.source : 'baseline',
      targetArmId: promoteChampion ? champion.armId : null,
      targetLabel: promoteChampion ? champion.label : controlArm.label,
      fallbackToBaseline: !promoteChampion,
      reasonCodes,
      regimeCollapseWarnings: buildRecommendedRegimeCollapseWarnings(selectionDiagnosticsSummary),
    },
  }
}

function buildRecommendedSelectionDiagnosticsSummary(
  candidate: RecommendedArmCandidate | null,
) {
  if (candidate?.selection == null || candidate.diagnostics == null) {
    return null
  }

  const byRegime = extractRecommendedSelectionByRegime(candidate.selection).sort((left, right) => {
    if (left.selectedCandidateCollapseCount !== right.selectedCandidateCollapseCount) {
      return right.selectedCandidateCollapseCount - left.selectedCandidateCollapseCount
    }
    if (left.realizedSelectedCandidatePct !== right.realizedSelectedCandidatePct) {
      return left.realizedSelectedCandidatePct - right.realizedSelectedCandidatePct
    }
    if (left.selectedCandidateCount !== right.selectedCandidateCount) {
      return right.selectedCandidateCount - left.selectedCandidateCount
    }
    return left.regime.localeCompare(right.regime)
  })

  if (byRegime.length === 0) {
    return null
  }

  return {
    source: candidate.source,
    armId: candidate.armId,
    label: candidate.label,
    mode: typeof candidate.selection.mode === 'string' ? candidate.selection.mode : null,
    coveragePct: toFiniteNumber(candidate.selection.coveragePct),
    selectedCandidateCount: toFiniteNumber(candidate.selection.selectedCandidateCount) ?? 0,
    realizedTradeCount: toFiniteNumber(candidate.diagnostics.realizedTradeCount) ?? 0,
    realizedSelectedCandidatePct:
      toFiniteNumber(candidate.diagnostics.realizedSelectedCandidatePct) ?? 0,
    selectedCandidateCollapseCount:
      toFiniteNumber(candidate.diagnostics.selectedCandidateCollapseCount) ?? 0,
    weakestRegime: byRegime[0] ?? null,
    weakRegimes: byRegime.filter((regime) => regime.selectedCandidateCollapseCount > 0),
    byRegime,
  }
}

function extractRecommendedSelectionByRegime(selection: Record<string, unknown>) {
  if (!Array.isArray(selection.byRegime)) {
    return []
  }

  return selection.byRegime.flatMap((value) => {
    if (!isRecord(value) || typeof value.regime !== 'string') {
      return []
    }

    const selectedCandidateCount = toFiniteNumber(value.selectedCandidateCount) ?? 0
    const realizedTradeCount = toFiniteNumber(value.realizedTradeCount) ?? 0

    return [{
      regime: value.regime,
      rawCandidateCount: toFiniteNumber(value.rawCandidateCount) ?? 0,
      selectedCandidateCount,
      realizedTradeCount,
      selectedCoveragePct: toFiniteNumber(value.selectedCoveragePct) ?? 0,
      realizedSelectedCandidatePct: toFiniteNumber(value.realizedSelectedCandidatePct) ?? 0,
      selectedCandidateCollapseCount:
        toFiniteNumber(value.selectedCandidateCollapseCount) ??
        Math.max(0, selectedCandidateCount - realizedTradeCount),
    }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function buildRecommendedRegimeCollapseWarnings(
  selectionDiagnosticsSummary: ReturnType<typeof buildRecommendedSelectionDiagnosticsSummary>,
) {
  if (selectionDiagnosticsSummary == null) {
    return []
  }

  return selectionDiagnosticsSummary.weakRegimes.map((regime, index) => ({
    regime: regime.regime,
    selectedCandidateCollapseCount: regime.selectedCandidateCollapseCount,
    selectedCandidateCount: regime.selectedCandidateCount,
    realizedTradeCount: regime.realizedTradeCount,
    realizedSelectedCandidatePct: regime.realizedSelectedCandidatePct,
    isWeakestRegime: index === 0,
    warning: `Selection collapsed ${regime.selectedCandidateCollapseCount} of ${regime.selectedCandidateCount} candidates in ${regime.regime}.`,
  }))
}

function buildCombinedWinnerEvidence(input: {
  champion: RecommendedArmCandidate | null
  candidatesBySource: {
    regimeGate: RecommendedArmCandidate | null
    metaLabel: RecommendedArmCandidate | null
    metaLabelWithBestRegimeGate: RecommendedArmCandidate | null
  }
}) {
  if (input.champion?.source !== 'metaLabelWithBestRegimeGate') {
    return null
  }

  const parentRegimeGate = input.candidatesBySource.regimeGate
  const versusRegimeGate = buildHeadToHeadEvidence(input.champion, parentRegimeGate)
  const versusMetaLabel = buildHeadToHeadEvidence(input.champion, input.candidatesBySource.metaLabel)

  return {
    champion: {
      source: input.champion.source,
      armId: input.champion.armId,
      label: input.champion.label,
    },
    provenance: {
      parentRegimeGateSelectionSource: input.champion.regimeGateSelection?.source ?? null,
      parentRegimeGateArmId:
        input.champion.regimeGateSelection?.parentArmId ??
        (input.champion.regimeGateSelection ? parentRegimeGate?.armId ?? null : null),
      parentRegimeGateQualified:
        input.champion.regimeGateSelection?.parentArmQualified ??
        (input.champion.regimeGateSelection ? parentRegimeGate?.diagnostics?.qualifies === true : null),
      bootstrappedFromUnqualifiedBestArm:
        input.champion.regimeGateSelection?.bootstrappedFromUnqualifiedBestArm ??
        (input.champion.regimeGateSelection?.source === 'bestArm' &&
          input.champion.regimeGateSelection?.parentArmQualified === false),
    },
    summary: {
      beatsBothStandaloneArms:
        (versusRegimeGate?.summary.beatsOnNetExpectancy ?? false) &&
        (versusMetaLabel?.summary.beatsOnNetExpectancy ?? false),
      beatsBothStandaloneArmsOnTotalReturn:
        (versusRegimeGate?.summary.beatsOnTotalReturn ?? false) &&
        (versusMetaLabel?.summary.beatsOnTotalReturn ?? false),
      noWorseThanStandaloneArmsOnDrawdown:
        (versusRegimeGate?.summary.noWorseDrawdown ?? false) &&
        (versusMetaLabel?.summary.noWorseDrawdown ?? false),
    },
    versusStandalone: {
      regimeGate: versusRegimeGate,
      metaLabel: versusMetaLabel,
    },
  }
}


function buildHeadToHeadEvidence(
  champion: RecommendedArmCandidate,
  comparator: RecommendedArmCandidate | null,
) {
  if (!comparator) {
    return null
  }

  const delta = {
    totalReturnPct: champion.metrics.totalReturnPct - comparator.metrics.totalReturnPct,
    netExpectancyPct: champion.metrics.netExpectancyPct - comparator.metrics.netExpectancyPct,
    maxDrawdownPct: champion.metrics.maxDrawdownPct - comparator.metrics.maxDrawdownPct,
    tradeCount: champion.metrics.tradeCount - comparator.metrics.tradeCount,
    sharpe: champion.metrics.sharpe - comparator.metrics.sharpe,
    sortino: champion.metrics.sortino - comparator.metrics.sortino,
    calmar: champion.metrics.calmar - comparator.metrics.calmar,
    tradeCountRetentionPct:
      getRecommendedArmTradeRetentionPct(champion) - getRecommendedArmTradeRetentionPct(comparator),
  }

  return {
    comparator: {
      source: comparator.source,
      armId: comparator.armId,
      label: comparator.label,
    },
    delta,
    summary: {
      beatsOnNetExpectancy: delta.netExpectancyPct > 0,
      beatsOnTotalReturn: delta.totalReturnPct > 0,
      noWorseDrawdown: delta.maxDrawdownPct <= 0,
      higherTradeCount: delta.tradeCount > 0,
      higherTradeRetention: delta.tradeCountRetentionPct > 0,
    },
  }
}

function selectRecommendedArmCandidate(
  source: RecommendedArmCandidate['source'],
  experiment: {
    enabled?: boolean
    winner?: {
      armId: string
      label?: string
      rank?: number
      metrics: ReturnType<typeof summarizeMetrics>
      baselineReport: ReturnType<typeof buildBaselineReport>
      delta: ReturnType<typeof buildMetricDelta>
      diagnostics?: Record<string, unknown>
      selection?: Record<string, unknown>
      gate?: {
        allowedEntryRegimes: StrategyRegimeLabel[]
        exitOnMismatch?: boolean
      }
    } | null
    bestArm?: {
      armId: string
      label?: string
      rank?: number
      metrics: ReturnType<typeof summarizeMetrics>
      baselineReport: ReturnType<typeof buildBaselineReport>
      delta: ReturnType<typeof buildMetricDelta>
      diagnostics?: Record<string, unknown>
      selection?: Record<string, unknown>
      gate?: {
        allowedEntryRegimes: StrategyRegimeLabel[]
        exitOnMismatch?: boolean
      }
    } | null
    regimeGateSelection?: RecommendedArmCandidate['regimeGateSelection'] | null
  },
): RecommendedArmCandidate | null {
  if (experiment.enabled !== true) {
    return null
  }

  const arm = experiment.winner ?? experiment.bestArm
  if (!arm) {
    return null
  }

  return {
    source,
    armId: arm.armId,
    label: arm.label ?? arm.armId,
    rank: arm.rank ?? null,
    metrics: arm.metrics,
    baselineReport: arm.baselineReport,
    delta: arm.delta,
    diagnostics: arm.diagnostics ?? null,
    selection: arm.selection ?? null,
    gate: arm.gate ?? null,
    regimeGateSelection: experiment.regimeGateSelection ?? null,
  }
}

function compareRecommendedCandidates(
  left: RecommendedArmCandidate,
  right: RecommendedArmCandidate,
): number {
  if (isRecommendedArmQualified(left) !== isRecommendedArmQualified(right)) {
    return isRecommendedArmQualified(left) ? -1 : 1
  }
  if (hasPositiveNetExpectancy(left) !== hasPositiveNetExpectancy(right)) {
    return hasPositiveNetExpectancy(left) ? -1 : 1
  }
  if (left.metrics.netExpectancyPct !== right.metrics.netExpectancyPct) {
    return right.metrics.netExpectancyPct - left.metrics.netExpectancyPct
  }
  if (left.delta.netExpectancyPct !== right.delta.netExpectancyPct) {
    return right.delta.netExpectancyPct - left.delta.netExpectancyPct
  }
  if (left.delta.totalReturnPct !== right.delta.totalReturnPct) {
    return right.delta.totalReturnPct - left.delta.totalReturnPct
  }
  if (left.metrics.maxDrawdownPct !== right.metrics.maxDrawdownPct) {
    return left.metrics.maxDrawdownPct - right.metrics.maxDrawdownPct
  }

  const leftRetentionPct = getRecommendedArmTradeRetentionPct(left)
  const rightRetentionPct = getRecommendedArmTradeRetentionPct(right)
  if (leftRetentionPct !== rightRetentionPct) {
    return rightRetentionPct - leftRetentionPct
  }
  if (left.metrics.tradeCount !== right.metrics.tradeCount) {
    return right.metrics.tradeCount - left.metrics.tradeCount
  }
  return (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY)
}

function isRecommendedArmQualified(candidate: RecommendedArmCandidate): boolean {
  return candidate.diagnostics?.qualifies === true
}

function hasPositiveNetExpectancy(candidate: RecommendedArmCandidate): boolean {
  return candidate.metrics.netExpectancyPct > 0
}

function getRecommendedArmTradeRetentionPct(candidate: RecommendedArmCandidate): number {
  const value = candidate.diagnostics?.tradeCountRetentionPct
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function buildRecommendedCandidateReasonCodes(input: {
  champion: RecommendedArmCandidate | null
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}): string[] {
  const codes: string[] = []

  if (input.champion == null) {
    codes.push('NO_ADDITIVE_CANDIDATE')
  } else {
    if (!isRecommendedArmQualified(input.champion)) {
      codes.push('CHAMPION_FAILED_EXPERIMENT_CONSTRAINTS')
    }
    if (getRecommendedArmTradeRetentionPct(input.champion) < 20) {
      codes.push('CHAMPION_LOW_TRADE_RETENTION')
    }
    if (input.champion.metrics.tradeCount <= 10) {
      codes.push('CHAMPION_LOW_ABSOLUTE_TRADE_COUNT')
    }
  }

  if (!input.releaseGate.allowPaperTrading) {
    codes.push('PAPER_RELEASE_GATE_BLOCKED')
  }
  if (!input.releaseGate.allowLiveTrading) {
    codes.push('LIVE_RELEASE_GATE_BLOCKED')
  }

  return codes
}

function buildBaselineReport(metrics: BacktestMetrics) {
  return {
    expectancyAfterCost: {
      grossExpectancyPct: metrics.grossExpectancyPct,
      feeExpectancyDragPct: metrics.feeExpectancyDragPct,
      slippageExpectancyDragPct: metrics.slippageExpectancyDragPct,
      fundingExpectancyDragPct: metrics.fundingExpectancyDragPct,
      netExpectancyPct: metrics.netExpectancyPct,
      totalCostExpectancyDragPct:
        metrics.feeExpectancyDragPct +
        metrics.slippageExpectancyDragPct +
        metrics.fundingExpectancyDragPct,
    },
    byRegime: mapRegimeSummary(metrics.regimeSummary),
  }
}

function mapRegimeSummary(
  summary: BacktestMetrics['regimeSummary'],
): Partial<Record<string, ReturnType<typeof mapSingleRegimeSummary>>> {
  const out: Partial<Record<string, ReturnType<typeof mapSingleRegimeSummary>>> = {}
  for (const [label, bucket] of Object.entries(summary)) {
    if (!bucket) continue
    out[label] = mapSingleRegimeSummary(bucket)
  }
  return out
}

function mapSingleRegimeSummary(summary: BacktestRegimeSummary) {
  return {
    tradeCount: summary.tradeCount,
    winRatePct: summary.winRatePct,
    grossExpectancyPct: summary.grossExpectancyPct,
    feeExpectancyDragPct: summary.feeExpectancyDragPct,
    slippageExpectancyDragPct: summary.slippageExpectancyDragPct,
    fundingExpectancyDragPct: summary.fundingExpectancyDragPct,
    totalCostExpectancyDragPct: summary.totalCostExpectancyDragPct,
    netExpectancyPct: summary.netExpectancyPct,
    totalGrossReturnPct: summary.totalGrossReturnPct,
    totalNetReturnPct: summary.totalNetReturnPct,
  }
}

function parseStrategy(value: string): StrategyName {
  if (!isStrategyName(value)) {
    throw new Error(`Unsupported strategy: ${value}`)
  }
  return value
}

function parseJsonArg<T>(raw: string | undefined, fallback: T): T {
  if (!raw) return fallback
  return JSON.parse(raw) as T
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

function parseBoolArg(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function ensureCandidates(
  strategy: StrategyName,
  base: StrategyParams,
  provided?: StrategyParams[],
): StrategyParams[] {
  if (provided && provided.length > 0) {
    return provided
  }

  switch (strategy) {
    case 'trend':
      return [
        { ...base },
        {
          ...base,
          trendFastPeriod: Math.max(5, (base.trendFastPeriod ?? 20) - 5),
          trendSlowPeriod: Math.max(15, (base.trendSlowPeriod ?? 50) + 5),
        },
        {
          ...base,
          trendFastPeriod: Math.max(6, (base.trendFastPeriod ?? 20) + 3),
          trendSlowPeriod: Math.max(18, (base.trendSlowPeriod ?? 50) + 12),
        },
      ]
    case 'regimeTrend':
      return [
        { ...base },
        {
          ...base,
          allowedEntryRegimes: ['HighVolTrend'],
          exitOnRegimeMismatch: true,
        },
        {
          ...base,
          allowedEntryRegimes: ['HighVolTrend', 'LowVolTrend'],
          exitOnRegimeMismatch: true,
        },
      ]
    case 'meanReversion':
      return [
        { ...base },
        {
          ...base,
          rsiOversold: Math.max(10, (base.rsiOversold ?? 30) - 5),
          rsiOverbought: Math.min(90, (base.rsiOverbought ?? 70) + 5),
        },
        {
          ...base,
          bbStdDev: Math.max(1, (base.bbStdDev ?? 2) + 0.5),
        },
      ]
    case 'factorMeanReversion':
      return [
        { ...base },
        {
          ...base,
          factorEntryThreshold: Math.max(0.2, (base.factorEntryThreshold ?? 0.35) - 0.05),
          factorExitThreshold: Math.max(0.05, (base.factorExitThreshold ?? 0.10) - 0.02),
          factorPositionPctOfEquity: Math.max(0.01, (base.factorPositionPctOfEquity ?? 0.03) - 0.01),
        },
        {
          ...base,
          factorEntryThreshold: Math.min(0.6, (base.factorEntryThreshold ?? 0.35) + 0.05),
          factorMaxHoldingBars: Math.max(8, (base.factorMaxHoldingBars ?? 24) + 8),
          factorPositionPctOfEquity: Math.min(0.08, (base.factorPositionPctOfEquity ?? 0.03) + 0.01),
        },
      ]
    case 'breakout':
      return [
        { ...base },
        {
          ...base,
          breakoutPeriod: Math.max(10, (base.breakoutPeriod ?? 20) - 5),
          breakoutExitPeriod: Math.max(5, (base.breakoutExitPeriod ?? 10) - 2),
        },
        {
          ...base,
          breakoutPeriod: (base.breakoutPeriod ?? 20) + 5,
          breakoutExitPeriod: (base.breakoutExitPeriod ?? 10) + 3,
        },
      ]
    case 'ensemble':
      return [
        { ...base },
        {
          ...base,
          ensembleThreshold: Math.min(0.9, (base.ensembleThreshold ?? 0.55) + 0.1),
        },
        {
          ...base,
          ensembleThreshold: Math.max(0.2, (base.ensembleThreshold ?? 0.55) - 0.1),
        },
      ]
  }
}

function equityCurveToReturns(curve: Array<{ time: number; equity: number }>): number[] {
  const returns: number[] = []
  for (let index = 1; index < curve.length; index += 1) {
    const previous = curve[index - 1].equity
    const next = curve[index].equity
    if (previous > 0 && Number.isFinite(previous) && Number.isFinite(next)) {
      returns.push(next / previous - 1)
    }
  }
  return returns
}

async function loadCsvCandles(path: string, symbol: string): Promise<MarketData[]> {
  const raw = await readFile(resolve(path), 'utf-8')
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 2) {
    throw new Error(`CSV has no rows: ${path}`)
  }
  const header = lines[0].split(',')
  const idx = {
    timestamp: header.indexOf('timestamp'),
    open: header.indexOf('open'),
    high: header.indexOf('high'),
    low: header.indexOf('low'),
    close: header.indexOf('close'),
    volume: header.indexOf('volume'),
  }
  for (const [name, value] of Object.entries(idx)) {
    if (value < 0) {
      throw new Error(`CSV missing required column "${name}": ${path}`)
    }
  }

  const out: MarketData[] = []
  for (const row of lines.slice(1)) {
    const cols = row.split(',')
    const rawTs = Number(cols[idx.timestamp])
    const open = Number(cols[idx.open])
    const high = Number(cols[idx.high])
    const low = Number(cols[idx.low])
    const close = Number(cols[idx.close])
    const volume = Number(cols[idx.volume])
    if ([rawTs, open, high, low, close, volume].every((value) => Number.isFinite(value))) {
      const tsSeconds = rawTs > 1e11 ? Math.floor(rawTs / 1000) : Math.floor(rawTs)
      out.push({
        symbol,
        time: tsSeconds,
        open,
        high,
        low,
        close,
        volume,
      })
    }
  }
  out.sort((left, right) => left.time - right.time)
  return out
}

async function runSelfCheck(): Promise<void> {
  const out = resolve('/tmp/openalice-validation-pipeline-self-check.json')
  const gate = resolve('/tmp/openalice-validation-pipeline-release-gate.json')
  const process = await import('node:child_process')
  const child = process.spawn(
    './node_modules/.bin/tsx',
    [
      'scripts/run_validation_pipeline.ts',
      '--inputCsv',
      'data/market/okx/BTC_USDT_USDT_1h.csv',
      '--symbol',
      'BTC/USD',
      '--strategy',
      'trend',
      '--lookbackBars',
      '720',
      '--trainBars',
      '480',
      '--testBars',
      '120',
      '--stepBars',
      '120',
      '--riskSimulationCount',
      '100',
      '--output',
      out,
      '--releaseGateStatusPath',
      gate,
    ],
    { cwd: resolve('.'), stdio: 'ignore' },
  )
  await new Promise<void>((resolvePromise, reject) => {
    child.on('close', (code) => {
      if (code === 0 || code === 2) resolvePromise()
      else reject(new Error(`validation self-check failed with code ${String(code)}`))
    })
    child.on('error', reject)
  })
}

export {
  buildRecommendedCandidate,
  buildRegimeGateSweep,
  buildMetaLabelSweep,
  summarizeMetrics,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('run_validation_pipeline failed:', err)
    process.exit(1)
  })
}
