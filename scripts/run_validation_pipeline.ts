import { randomUUID } from 'node:crypto'
import { execSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { OhlcvData } from '../src/domain/analysis/indicator/types.js'
import { readStrategyConfig } from '../src/core/config.js'
import type { StrategyConfig } from '../src/core/config.js'
import {
  readAlphaPoolArtifactSync,
  summarizeAlphaPoolArtifact,
} from '../src/domain/strategy/alpha-pool.js'
import { buildStrategyExecutionDecision } from '../src/domain/strategy/execution.js'
import { buildMetaLabelFeatureVector } from '../src/domain/strategy/meta-labeling/feature-builder.js'
import { evaluateTripleBarrierLabel } from '../src/domain/strategy/meta-labeling/triple-barrier.js'
import {
  DEFAULT_REGIME_HMM_CONFIG,
  RegimeHmm,
  evaluateCrossAssetRegimeConsistency,
  evaluateRegime,
  extractHmmObservations,
} from '../src/domain/strategy/regime/index.js'
import type { RegimeEvaluation } from '../src/domain/strategy/regime/index.js'
import { runQuantileTest } from '../src/domain/strategy/research/quantile-test.js'
import { evaluateRuntimeFactorSnapshot } from '../src/domain/strategy/runtime-evaluator.js'
import { evaluateReleaseGate } from '../src/backtest/release_gate.js'
import { buildValidationDecisionSummary } from '../src/backtest/validation-report-summary.js'
import { evaluateRiskSimulation } from '../src/backtest/risk_simulation.js'
import {
  buildTrialLedgerSummary,
  computeSpaLikePValues,
  evaluateSignificanceGate,
  type SpaLikeCandidateResult,
  type SignificanceGateInput,
  type SignificanceGateResult,
} from '../src/backtest/statistical_significance.js'
import { runStrategyWalkForward } from '../src/backtest/wfo.js'
import { runStrategyBacktest } from '../src/backtest/strategy-validation/backtest.js'
import { evaluateStrategy, getStrategyMinimumBars } from '../src/backtest/strategy-validation/strategies.js'
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
import { sessionAwareSlippageEstimate } from '../src/live/execution_quality.js'
import type { IntradayLiquiditySession } from '../src/live/execution_quality.js'
import {
  buildStableCorrelationClusters,
  selectUniverseByRollingSharpe,
} from '../src/portfolio/index.js'
import {
  buildEvidenceId,
  evidenceIdToPathKey,
  hashEvidenceComponent,
} from '../src/evidence/evidence_id.js'
import {
  DATA_LINEAGE_PIT_POLICY,
  DATA_LINEAGE_SCHEMA_VERSION,
  dataLineageGraphToJson,
  hashDataLineageGraph,
  validateDataLineageGraph,
  type DataLineageGraph,
  type DataLineageNode,
} from '../src/data/data_lineage.js'
import {
  appendTrialRecord,
  buildCompleteTrialUniverseMarkerRecord,
  DUPLICATE_TRIAL_ID,
  TrialRegistryError,
  trialRecordToJson,
  type TrialRecord,
} from '../src/evidence/trial_registry.js'
import {
  getStrategyFamilyContract,
  validateStrategyFamilyContract,
  type StrategyFamilyContract,
} from '../src/strategy/contracts/index.js'
import type { FailureCode } from '../src/research/failure_taxonomy.js'
import {
  buildBlockedPromotionVerdictProvenance,
  promotionVerdictProvenanceToJson,
} from '../src/runtime/promotion_v2_verdict_provenance.js'
import { writeReleaseGateStatus } from '../src/runtime/release_gate_status.js'

type ValidationStrategyName = StrategyName

type RegimeGateConfig = {
  allowedEntryRegimes: StrategyRegimeLabel[]
  exitOnMismatch?: boolean
}

function evaluateSignificanceGateForReport(
  input: SignificanceGateInput,
): SignificanceGateResult {
  try {
    const result = evaluateSignificanceGate(input)
    return {
      ...result,
      candidateTrialCount:
        result.candidateTrialCount ??
        Math.max(0, Math.floor(input.trialCount ?? input.candidateReturns.length)),
    }
  } catch {
    const candidateTrialCount = Math.max(
      0,
      Math.floor(input.trialCount ?? input.candidateReturns.length),
    )
    return {
      passed: false,
      pboResult: {
        pbo: 1,
        logits: [],
        splitsEvaluated: 0,
        partitions: input.partitions ?? 8,
      },
      dsrResult: {
        observedSharpe: 0,
        benchmarkSharpe: 0,
        dsrValue: 0,
        dsrProbability: 0,
        skewness: 0,
        kurtosis: 3,
        trialCount: Math.max(2, candidateTrialCount),
      },
      pboThreshold: input.pboThreshold ?? 0.1,
      dsrMin: input.dsrMin ?? 0.95,
      candidateTrialCount,
      fdrQ: null,
      trialLedger: input.trialLedger ?? null,
    }
  }
}

type VolatilityGateConfig = {
  minVolatilityPct?: number
  maxVolatilityPct?: number
  minTrendStrengthPct?: number
  maxTrendStrengthPct?: number
  exitOnMismatch?: boolean
}

interface CliArgs {
  inputCsv: string
  symbol: string
  strategy: ValidationStrategyName
  lookbackBars: number
  output: string
  params: StrategyParams
  candidates?: StrategyParams[]
  peerCsvBySymbol?: Record<string, string>
  volatilityGate?: VolatilityGateConfig
  regimeGate?: RegimeGateConfig
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
  alphaPoolPath: string
  evidenceOutputRoot: string
  trialRegistryPath: string | null
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
  const peerCandlesBySymbol = await loadPeerCsvCandles(args.peerCsvBySymbol, args.lookbackBars)
  const assetCandlesBySymbol = {
    ...peerCandlesBySymbol,
    [args.symbol]: candles,
  }
  if (candles.length < args.trainBars + args.testBars) {
    throw new Error(
      `Not enough candles for WFO. Need >= ${args.trainBars + args.testBars}, got ${candles.length}.`,
    )
  }

  const candidates = ensureCandidates(args.strategy, args.params, args.candidates)
  const executionStrategy = resolveExecutionStrategy(args.strategy)
  const costModel = {
    feeRate: args.feeRate,
    slippageBps: args.slippageBps,
    latencyBars: args.latencyBars,
    fundingRatePer8h: args.fundingRatePer8h,
  }

  const holdoutBars = Math.max(1, Math.min(args.testBars, Math.floor(candles.length * 0.2)))
  const selectionCandles = candles.slice(0, candles.length - holdoutBars)
  const holdoutCandles = candles.slice(candles.length - holdoutBars)
  if (selectionCandles.length < 1 || holdoutCandles.length < 1) {
    throw new Error('Not enough candles to create non-overlapping selection and holdout samples.')
  }

  const reports = candidates.map((candidate) =>
    runStrategyBacktest({
      strategy: executionStrategy,
      candles: selectionCandles,
      params: candidate,
      costModel,
      regimeGate: args.regimeGate,
      volatilityGate: args.volatilityGate,
    }),
  )
  const selected = [...reports].sort((left, right) => right.metrics.sharpe - left.metrics.sharpe)[0]
  const selectedCandidateIndex = reports.indexOf(selected)
  if (selectedCandidateIndex < 0) {
    throw new Error('Selected candidate was not found in the candidate report set.')
  }
  const holdoutReports = candidates.map((candidate) =>
    runStrategyBacktest({
      strategy: executionStrategy,
      candles: holdoutCandles,
      params: candidate,
      costModel,
      regimeGate: args.regimeGate,
      volatilityGate: args.volatilityGate,
    }),
  )
  const selectedEvaluation = holdoutReports[selectedCandidateIndex]
  const selectionLeakageCheck = {
    selectedOn: 'selection',
    evaluatedOn: 'holdout',
    passed: true,
    selectionBars: selectionCandles.length,
    holdoutBars: holdoutCandles.length,
  }

  const wfo = runStrategyWalkForward({
    strategy: executionStrategy,
    candles,
    candidates,
    costModel,
    regimeGate: args.regimeGate,
    volatilityGate: args.volatilityGate,
    config: {
      trainBars: args.trainBars,
      testBars: args.testBars,
      stepBars: args.stepBars,
      degradationThreshold: args.degradationThreshold,
      minTradesPerWindow: 1,
    },
  })

  const candidateReturns = holdoutReports.map((report) => equityCurveToReturns(report.equityCurve))
  const selectedReturns = equityCurveToReturns(selectedEvaluation.equityCurve)
  const trialLedger = buildTrialLedgerSummary({
    rawM: reports.length,
    effectiveM: reports.length,
    survivingTrialCount: 1,
    rawMComplete: false,
    includesFailedTrials: false,
  })
  const significance = evaluateSignificanceGateForReport({
    candidateReturns,
    selectedReturns,
    partitions: args.significancePartitions,
    pboThreshold: 0.2,
    dsrMin: 0,
    trialCount: reports.length,
    trialLedger,
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

  const strategySignalIcByHorizon = computeStrategySignalIcByHorizon({
    strategy: executionStrategy,
    candles: holdoutCandles,
    params: selected.params,
    horizons: [1, 6, 24],
  })
  const strategyConfig = await readStrategyConfig()
  const strategyPlanEvidence = buildStrategyPlanEvidence({
    symbol: args.symbol,
    candles,
    assetCandlesBySymbol,
    holdoutCandles,
    selectedEvaluation,
    costModel,
    strategyConfig,
    alphaPoolPath: args.alphaPoolPath,
  })

  const releaseGate = evaluateReleaseGate({
    wfo,
    significance,
    riskSimulation,
    economics: {
      grossExpectancyPct: selectedEvaluation.metrics.grossExpectancyPct,
      netExpectancyPct: selectedEvaluation.metrics.netExpectancyPct,
      feeExpectancyDragPct: selectedEvaluation.metrics.feeExpectancyDragPct,
      slippageExpectancyDragPct: selectedEvaluation.metrics.slippageExpectancyDragPct,
      fundingExpectancyDragPct: selectedEvaluation.metrics.fundingExpectancyDragPct,
      totalCostsPaid: selectedEvaluation.metrics.totalCostsPaid,
      costDragPctOfInitialCapital: selectedEvaluation.metrics.costDragPctOfInitialCapital,
      averageHoldingHours: selectedEvaluation.metrics.averageHoldingHours,
      medianHoldingHours: selectedEvaluation.metrics.medianHoldingHours,
      tradeCount: selectedEvaluation.metrics.tradeCount,
    },
    strategyPlanEvidence,
  })
  const validationEvidence = buildValidationEvidence({
    symbol: args.symbol,
    candles,
    assetCandlesBySymbol,
    holdoutCandles,
    selectedEvaluation,
    strategySignalIcByHorizon,
    releaseGate,
    costModel,
    strategyConfig,
    alphaPoolPath: args.alphaPoolPath,
    strategyPlanEvidence,
  })

  const baselineReport = buildBaselineReport(selectedEvaluation.metrics)
  const deployableStrategyTarget = buildDeployableStrategyTarget({
    baselineMetrics: selectedEvaluation.metrics,
    baselineReport,
    releaseGate,
  })
  const regimeGateSweep = buildRegimeGateSweep({
    strategy: args.strategy,
    candles,
    params: selected.params,
    costModel,
    baselineMetrics: selectedEvaluation.metrics,
    lockedRegimeGate: args.regimeGate,
  })
  const metaLabelSweep = buildMetaLabelSweep({
    strategy: args.strategy,
    candles,
    costModel,
    strategyConfig,
    baseResult: selectedEvaluation,
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
          strategy: executionStrategy,
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
  const recommendedCandidate = buildRecommendedCandidate({
    baselineMetrics: selectedEvaluation.metrics,
    baselineReport,
    releaseGate,
    abExperiments: {
      regimeGate: regimeGateSweep,
      metaLabel: metaLabelSweep,
      metaLabelWithBestRegimeGate,
    },
  })
  const canonicalScoreboard = buildCanonicalScoreboardSummary({
    controlArm: deployableStrategyTarget.controlArm,
    selectedCandidate: {
      candidateIndex: selectedCandidateIndex,
      params: selected.params,
      metrics: summarizeMetrics(selectedEvaluation.metrics),
      baselineReport,
    },
    recommendation: recommendedCandidate.recommendation,
    wfo,
    significance,
    riskSimulation,
    releaseGate,
  })

  const summaryBase = {
    schemaVersion: 'validation_pipeline_report.v1',
    generatedAt: new Date().toISOString(),
    input: {
      csv: resolve(args.inputCsv),
      symbol: args.symbol,
      strategy: args.strategy,
      lookbackBars: candles.length,
      peerCsvBySymbol: Object.fromEntries(
        Object.entries(args.peerCsvBySymbol ?? {}).map(([symbol, path]) => [symbol, resolve(path)]),
      ),
    },
    configuredGates: {
      regimeGate: args.regimeGate ?? null,
      volatilityGate: args.volatilityGate ?? null,
    },
    deployableStrategyTarget,
    sampleSplit: {
      selection: {
        startTime: selectionCandles[0]?.time ?? null,
        endTime: selectionCandles[selectionCandles.length - 1]?.time ?? null,
        bars: selectionCandles.length,
      },
      holdout: {
        startTime: holdoutCandles[0]?.time ?? null,
        endTime: holdoutCandles[holdoutCandles.length - 1]?.time ?? null,
        bars: holdoutCandles.length,
      },
    },
    selectionLeakageCheck,
    selectedParams: selected.params,
    selectedMetrics: selectedEvaluation.metrics,
    selectedInSampleMetrics: selected.metrics,
    baselineReport,
    validationEvidence,
    candidateMetrics: reports.map((report, index) => ({
      candidateIndex: index,
      params: report.params,
      metrics: report.metrics,
      baselineReport: buildBaselineReport(report.metrics),
    })),
    candidateHoldoutMetrics: holdoutReports.map((report, index) => ({
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
    recommendedCandidate,
    canonicalScoreboard,
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
      fdrQ: significance.fdrQ ?? null,
      candidateTrialCount: significance.candidateTrialCount ?? null,
      trialLedger: significance.trialLedger ?? null,
    },
    riskSimulation,
    releaseGate,
  }
  const evidenceOsV4 = await writeEvidenceOsV4Artifacts({
    args,
    candles,
    holdoutCandles,
    selectedCandidateIndex,
    candidateReturns,
    selectedEvaluation,
    strategySignalIcByHorizon,
    costModel,
    wfo,
    significance,
    riskSimulation,
    releaseGate,
    outputPath: resolve(args.output),
  })
  const summaryBaseWithEvidence = {
    ...summaryBase,
    evidenceOsV4: evidenceOsV4.summary,
  }
  const summary = {
    ...summaryBaseWithEvidence,
    decisionSummary: buildValidationDecisionSummary(summaryBaseWithEvidence),
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
    peerCsvBySymbol: parseJsonArg<Record<string, string> | undefined>(
      raw.get('peerCsvJson'),
      undefined,
    ),
    regimeGate: parseJsonArg<RegimeGateConfig | undefined>(raw.get('regimeGateJson'), undefined),
    volatilityGate: parseJsonArg<VolatilityGateConfig | undefined>(raw.get('volatilityGateJson'), undefined),
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
    alphaPoolPath: raw.get('alphaPoolPath') ?? 'data/research/alpha_pool/latest.json',
    evidenceOutputRoot: raw.get('evidenceOutputRoot') ?? 'runtime/research',
    trialRegistryPath: raw.get('trialRegistryPath') ?? null,
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

interface EvidenceOsV4ArtifactsInput {
  args: CliArgs
  candles: MarketData[]
  holdoutCandles: MarketData[]
  selectedCandidateIndex: number
  candidateReturns: number[][]
  selectedEvaluation: BacktestResult
  strategySignalIcByHorizon: StrategySignalIcHorizon[]
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  wfo: ReturnType<typeof runStrategyWalkForward>
  significance: SignificanceGateResult
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  outputPath: string
}

interface EvidenceOsV4ArtifactsResult {
  summary: Record<string, unknown>
}

interface CompleteTrialUniverseMarkerAppendResult {
  appended: boolean
  reason: string
  trialId: string | null
}

type EvidenceOsFailureCode = 'FDR_INPUTS_INCOMPLETE' | 'PIT_AUDIT_NOT_IMPLEMENTED' | 'PIT_PROXY_ONLY' | 'PIT_VIOLATION'

interface FdrReport {
  schema_version: 'evidence_os_v4_fdr_report.v4_0'
  evidence_id: string
  strategy_family: string
  candidate_id: string
  code_commit: string
  data_manifest_hash: string
  data_lineage_hash: string
  feature_schema_hash: string
  validation_profile_hash: string
  cost_model_hash: string
  created_at: string
  status: 'blocked_inputs_incomplete' | 'ready_explanatory_only'
  promotion_allowed: false
  fdr_method_primary: 'BY_raw_m'
  fdr_method_secondary: 'BY_effective_m'
  raw_m: number
  effective_m: number
  raw_m_complete: boolean
  includes_failed_trials: boolean
  p_values_available: boolean
  missing_p_value_count: number
  p_value: number | null
  p_value_method: string | null
  p_value_scope: 'explanatory_selected_vs_holdout_benchmark' | null
  p_value_is_promotion_grade: false
  benchmark_candidate_index: number | null
  bootstrap_samples: number | null
  bootstrap_block_size: number | null
  bootstrap_block_size_set: number[]
  bootstrap_direction_stable: boolean | null
  p_value_block_sensitivity: Array<{
    block_size: number
    observed_mean_excess: number
    p_value: number
    passed: boolean
  }>
  observed_mean_excess: number | null
  p_adjusted_by_raw_m: number | null
  p_adjusted_by_effective_m: number | null
  p_adjusted_bh_secondary: number | null
  blocking_reasons: Array<{
    code: EvidenceOsFailureCode
    severity: 'hard_block'
    source: string
    required: string
    observed: string
  }>
  notes: string[]
}

type PitAuditCheckStatus = 'pass' | 'fail' | 'blocked'

interface PitAuditCheck {
  id: string
  status: PitAuditCheckStatus
  node_id: string | null
  node_type: string | null
  source: string
  required: string
  observed: string
  details: Record<string, unknown>
}

function buildValidationDataLineageGraph(input: {
  args: CliArgs
  candles: MarketData[]
  holdoutCandles: MarketData[]
  strategyFamily: string
  candidateId: string
  evidenceId: string
  generatedAt: string
}): DataLineageGraph {
  const rawNodeId = `${input.args.symbol.toLowerCase()}_validation_raw`
  const normalizedNodeId = `${input.args.symbol.toLowerCase()}_validation_normalized`
  const featureNodeId = `${input.strategyFamily}_${input.candidateId}_features`
  const strategyInputNodeId = `${input.strategyFamily}_${input.candidateId}_strategy_input`
  const decisionArtifactNodeId = `${input.strategyFamily}_${input.candidateId}_validation_result`

  return {
    schemaVersion: DATA_LINEAGE_SCHEMA_VERSION,
    generatedAt: input.generatedAt,
    nodes: [
      {
        id: rawNodeId,
        type: 'raw_source',
        qualityStatus: 'ok',
        source: 'local_csv',
        endpoint: input.args.inputCsv,
        symbol: input.args.symbol,
        firstTimestamp: input.candles[0]?.time ? marketTimeToIso(input.candles[0].time) : null,
        lastTimestamp: input.candles[input.candles.length - 1]?.time
          ? marketTimeToIso(input.candles[input.candles.length - 1].time)
          : null,
        metadata: {
          selection_bar_count: input.candles.length,
          holdout_bar_count: input.holdoutCandles.length,
          peer_symbols: Object.keys(input.args.peerCsvBySymbol ?? {}).sort(),
        },
      },
      {
        id: normalizedNodeId,
        type: 'normalized_series',
        qualityStatus: 'ok',
        parents: [rawNodeId],
        symbol: input.args.symbol,
      },
      {
        id: featureNodeId,
        type: 'feature',
        qualityStatus: 'ok',
        parents: [normalizedNodeId],
        symbol: input.args.symbol,
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
        metadata: {
          strategy_family: input.strategyFamily,
          pit_audit_status: 'stub_blocked_by_feature_availability_audit',
        },
      },
      {
        id: strategyInputNodeId,
        type: 'strategy_input',
        qualityStatus: 'ok',
        parents: [featureNodeId],
        symbol: input.args.symbol,
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
        metadata: {
          candidate_id: input.candidateId,
        },
      },
      {
        id: decisionArtifactNodeId,
        type: 'decision_artifact',
        qualityStatus: 'ok',
        parents: [strategyInputNodeId],
        symbol: input.args.symbol,
        availableTimePolicy: DATA_LINEAGE_PIT_POLICY,
        metadata: {
          evidence_id: input.evidenceId,
          verdict: 'blocked',
        },
      },
    ],
  }
}

function marketTimeToIso(timeSeconds: number): string {
  return new Date(timeSeconds * 1000).toISOString()
}

function buildFailClosedFdrReport(input: {
  meta: Omit<FdrReport, (
    | 'schema_version'
    | 'status'
    | 'promotion_allowed'
    | 'fdr_method_primary'
    | 'fdr_method_secondary'
    | 'raw_m'
    | 'effective_m'
    | 'raw_m_complete'
    | 'includes_failed_trials'
    | 'p_values_available'
    | 'missing_p_value_count'
    | 'p_value'
    | 'p_value_method'
    | 'p_value_scope'
    | 'p_value_is_promotion_grade'
    | 'benchmark_candidate_index'
    | 'bootstrap_samples'
    | 'bootstrap_block_size'
    | 'bootstrap_block_size_set'
    | 'bootstrap_direction_stable'
    | 'p_value_block_sensitivity'
    | 'observed_mean_excess'
    | 'p_adjusted_by_raw_m'
    | 'p_adjusted_by_effective_m'
    | 'p_adjusted_bh_secondary'
    | 'blocking_reasons'
    | 'notes'
  )>
  significance: SignificanceGateResult
  candidateReturns: number[][]
  selectedCandidateIndex: number
  riskBlockSize: number
}): FdrReport {
  const trialLedger = input.significance.trialLedger
  const rawM = Math.max(0, Math.floor(trialLedger?.rawM ?? input.significance.candidateTrialCount ?? 0))
  const effectiveM = Math.max(0, Math.floor(trialLedger?.effectiveM ?? rawM))
  const rawMComplete = trialLedger?.rawMComplete === true
  const includesFailedTrials = trialLedger?.includesFailedTrials === true
  const pValueEstimate = buildExplanatoryValidationPValue({
    candidateReturns: input.candidateReturns,
    selectedCandidateIndex: input.selectedCandidateIndex,
    riskBlockSize: input.riskBlockSize,
  })
  const pValue: number | null = pValueEstimate.pValue
  const pValuesAvailable = pValue != null && pValueEstimate.blockedReason == null
  const blockingReasons: FdrReport['blocking_reasons'] = []

  if (!rawMComplete) {
    blockingReasons.push({
      code: 'FDR_INPUTS_INCOMPLETE',
      severity: 'hard_block',
      source: 'trial_ledger',
      required: 'raw_m_complete=true from complete trial universe marker',
      observed: 'raw_m_complete=false',
    })
  }
  if (!includesFailedTrials) {
    blockingReasons.push({
      code: 'FDR_INPUTS_INCOMPLETE',
      severity: 'hard_block',
      source: 'trial_ledger',
      required: 'includes_failed_trials=true',
      observed: 'includes_failed_trials=false',
    })
  }
  if (!pValuesAvailable) {
    blockingReasons.push({
      code: 'FDR_INPUTS_INCOMPLETE',
      severity: 'hard_block',
      source: 'validation_runner',
      required: 'finite p_value for every included FDR trial',
      observed: pValueEstimate.blockedReason ?? 'p_value=null',
    })
  }

  return {
    schema_version: 'evidence_os_v4_fdr_report.v4_0',
    ...input.meta,
    status: blockingReasons.length === 0 ? 'ready_explanatory_only' : 'blocked_inputs_incomplete',
    promotion_allowed: false,
    fdr_method_primary: 'BY_raw_m',
    fdr_method_secondary: 'BY_effective_m',
    raw_m: rawM,
    effective_m: effectiveM,
    raw_m_complete: rawMComplete,
    includes_failed_trials: includesFailedTrials,
    p_values_available: pValuesAvailable,
    missing_p_value_count: pValuesAvailable ? 0 : 1,
    p_value: pValue,
    p_value_method: pValueEstimate.method,
    p_value_scope: pValueEstimate.scope,
    p_value_is_promotion_grade: false,
    benchmark_candidate_index: pValueEstimate.benchmarkCandidateIndex,
    bootstrap_samples: pValueEstimate.bootstrapSamples,
    bootstrap_block_size: pValueEstimate.bootstrapBlockSize,
    bootstrap_block_size_set: pValueEstimate.bootstrapBlockSizeSet,
    bootstrap_direction_stable: pValueEstimate.bootstrapDirectionStable,
    p_value_block_sensitivity: pValueEstimate.blockSensitivity.map((entry) => ({
      block_size: entry.blockSize,
      observed_mean_excess: entry.observedMeanExcess,
      p_value: entry.pValue,
      passed: entry.passed,
    })),
    observed_mean_excess: pValueEstimate.observedMeanExcess,
    p_adjusted_by_raw_m: pValuesAvailable
      ? byAdjustedPValue(pValue, rawM)
      : null,
    p_adjusted_by_effective_m: pValuesAvailable
      ? byAdjustedPValue(pValue, effectiveM)
      : null,
    p_adjusted_bh_secondary: pValuesAvailable
      ? bhAdjustedPValue(pValue, rawM)
      : null,
    blocking_reasons: blockingReasons,
    notes: [
      'This artifact exists so downstream ledgers can distinguish missing FDR output from incomplete promotion-grade FDR inputs.',
      'promotion_allowed is hard-coded false until a complete trial universe, failed-trial coverage, promotion-grade p-values, and row-level PIT audit are available.',
      'p_value, when present, is explanatory only: it compares the selected holdout return series against a deterministic holdout benchmark candidate and must not be used alone for promotion.',
      'When the explanatory p-value cannot be computed, p_value is null and fdr_p_value_blocked_reason explains why; do not substitute p=1 into BY/BH sorting.',
      'BY_raw_m remains the primary promotion method; BY_effective_m is explanatory only.',
    ],
  }
}

function resolveCompleteTrialUniverseMarkerInput(input: {
  significance: SignificanceGateResult
  evidenceId: string
  fdrFamily: string
  batchId: string
  createdAt: string
}): Parameters<typeof buildCompleteTrialUniverseMarkerRecord>[0] | null {
  const ledger = input.significance.trialLedger
  if (!ledger?.rawMComplete || !ledger.includesFailedTrials) return null

  const rawM = nonNegativeIntegerOrNull(ledger.rawM)
  const effectiveM = nonNegativeIntegerOrNull(ledger.effectiveM ?? ledger.rawM)
  const failedTrialCount = nonNegativeIntegerOrNull(ledger.failedTrialCount)
  const survivingTrialCount = nonNegativeIntegerOrNull(ledger.survivingTrialCount)
  if (
    rawM == null ||
    effectiveM == null ||
    failedTrialCount == null ||
    survivingTrialCount == null ||
    failedTrialCount + survivingTrialCount !== rawM
  ) {
    return null
  }

  const markerHash = hashEvidenceComponent({
    schema: 'complete_trial_universe_marker.v1',
    evidenceId: input.evidenceId,
    fdrFamily: input.fdrFamily,
    rawM,
    effectiveM,
    failedTrialCount,
    survivingTrialCount,
    batchId: input.batchId,
  }).replace(/^sha256:/, '')

  return {
    trialId: `trial_universe_${markerHash.slice(0, 24)}`,
    evidenceId: input.evidenceId,
    fdrFamily: input.fdrFamily,
    rawM,
    effectiveM,
    includedTrialCount: rawM,
    failedTrialCount,
    survivingTrialCount,
    batchId: input.batchId,
    createdAt: input.createdAt,
  }
}

async function appendCompleteTrialUniverseMarkerIfReady(input: {
  significance: SignificanceGateResult
  evidenceId: string
  fdrFamily: string
  batchId: string
  createdAt: string
  trialRegistryPath: string | null
}): Promise<CompleteTrialUniverseMarkerAppendResult> {
  const ledger = input.significance.trialLedger
  if (!ledger?.rawMComplete) {
    return {
      appended: false,
      reason: 'raw_m_complete_false',
      trialId: null,
    }
  }
  if (!ledger.includesFailedTrials) {
    return {
      appended: false,
      reason: 'includes_failed_trials_false',
      trialId: null,
    }
  }

  const markerInput = resolveCompleteTrialUniverseMarkerInput(input)
  if (!markerInput) {
    return {
      appended: false,
      reason: 'invalid_trial_universe_counts',
      trialId: null,
    }
  }
  if (!input.trialRegistryPath) {
    return {
      appended: false,
      reason: 'trial_registry_path_not_configured',
      trialId: markerInput.trialId,
    }
  }

  try {
    await appendTrialRecord(
      buildCompleteTrialUniverseMarkerRecord(markerInput),
      input.trialRegistryPath,
    )
  } catch (err) {
    if (err instanceof TrialRegistryError && err.code === DUPLICATE_TRIAL_ID) {
      return {
        appended: false,
        reason: 'complete_trial_universe_marker_already_exists',
        trialId: markerInput.trialId,
      }
    }
    throw err
  }
  return {
    appended: true,
    reason: 'complete_trial_universe_marker_appended',
    trialId: markerInput.trialId,
  }
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  if (!Number.isInteger(value) || (value as number) < 0) return null
  return value as number
}

type ExplanatoryValidationPValue = {
  pValue: number | null
  method: string | null
  scope: FdrReport['p_value_scope']
  benchmarkCandidateIndex: number | null
  bootstrapSamples: number | null
  bootstrapBlockSize: number | null
  bootstrapBlockSizeSet: number[]
  bootstrapDirectionStable: boolean | null
  blockSensitivity: SpaLikeCandidateResult['blockSensitivity']
  observedMeanExcess: number | null
  blockedReason: string | null
}

function buildExplanatoryValidationPValue(input: {
  candidateReturns: number[][]
  selectedCandidateIndex: number
  riskBlockSize: number
}): ExplanatoryValidationPValue {
  const empty = (blockedReason: string): ExplanatoryValidationPValue => ({
    pValue: null,
    method: null,
    scope: null,
    benchmarkCandidateIndex: null,
    bootstrapSamples: null,
    bootstrapBlockSize: null,
    bootstrapBlockSizeSet: [],
    bootstrapDirectionStable: null,
    blockSensitivity: [],
    observedMeanExcess: null,
    blockedReason,
  })
  if (input.candidateReturns.length < 2) {
    return empty('need_at_least_two_candidate_return_series')
  }
  const benchmarkCandidateIndex = resolveExplanatoryBenchmarkIndex(
    input.selectedCandidateIndex,
    input.candidateReturns.length,
  )
  if (benchmarkCandidateIndex == null) {
    return empty('no_distinct_holdout_benchmark_candidate_available')
  }

  try {
    const result = computeSpaLikePValues({
      candidateReturns: input.candidateReturns,
      benchmarkIndex: benchmarkCandidateIndex,
      bootstrapSamples: 400,
      blockSize: Math.max(2, Math.floor(input.riskBlockSize)),
      alpha: 0.05,
    })
    const selectedItem = result.items.find(
      (item) => item.candidateIndex === input.selectedCandidateIndex,
    )
    if (!selectedItem || !Number.isFinite(selectedItem.pValue)) {
      return empty('selected_candidate_p_value_not_finite')
    }
    return {
      pValue: selectedItem.pValue,
      method: 'spa_like_moving_block_selected_vs_deterministic_holdout_benchmark_v1',
      scope: 'explanatory_selected_vs_holdout_benchmark',
      benchmarkCandidateIndex,
      bootstrapSamples: result.bootstrapSamples,
      bootstrapBlockSize: result.blockSize,
      bootstrapBlockSizeSet: result.blockSizeSet,
      bootstrapDirectionStable: selectedItem.bootstrapDirectionStable,
      blockSensitivity: selectedItem.blockSensitivity,
      observedMeanExcess: selectedItem.observedMeanExcess,
      blockedReason: null,
    }
  } catch (err) {
    return empty(err instanceof Error ? err.message : String(err))
  }
}

function resolveExplanatoryBenchmarkIndex(
  selectedCandidateIndex: number,
  candidateCount: number,
): number | null {
  if (!Number.isInteger(selectedCandidateIndex) || selectedCandidateIndex < 0 || selectedCandidateIndex >= candidateCount) {
    return null
  }
  if (candidateCount < 2) return null
  if (selectedCandidateIndex !== 0) return 0
  return 1
}

function byAdjustedPValue(pValue: number, trialCount: number): number | null {
  if (!Number.isFinite(pValue) || !Number.isFinite(trialCount) || trialCount < 1) return null
  return Math.min(1, Math.max(0, pValue) * Math.floor(trialCount) * harmonicNumber(Math.floor(trialCount)))
}

function bhAdjustedPValue(pValue: number, trialCount: number): number | null {
  if (!Number.isFinite(pValue) || !Number.isFinite(trialCount) || trialCount < 1) return null
  return Math.min(1, Math.max(0, pValue) * Math.floor(trialCount))
}

function harmonicNumber(n: number): number {
  let total = 0
  for (let index = 1; index <= n; index += 1) total += 1 / index
  return total
}

function buildFeatureAvailabilityAudit(input: {
  meta: Record<string, unknown>
  dataLineageGraph: DataLineageGraph
  strategyFamilyContract: StrategyFamilyContract
  holdoutCandles: MarketData[]
}): Record<string, unknown> {
  const lineageValidation = validateDataLineageGraph(input.dataLineageGraph)
  const holdoutStart = input.holdoutCandles[0]?.time ?? null
  const holdoutEnd = input.holdoutCandles[input.holdoutCandles.length - 1]?.time ?? null
  const holdoutStartIso = holdoutStart == null ? null : marketTimeToIso(holdoutStart)
  const holdoutEndIso = holdoutEnd == null ? null : marketTimeToIso(holdoutEnd)
  const rowLevelProxyAudit = buildCsvRowLevelPitProxyAudit(input.holdoutCandles)
  const checks: PitAuditCheck[] = [
    ...input.dataLineageGraph.nodes.flatMap((node) =>
      pitChecksForLineageNode({
        node,
        holdoutStart,
        holdoutEnd,
      }),
    ),
    ...input.strategyFamilyContract.requiredFeatures.map((feature) => ({
      id: `contract_required_feature:${feature.featureId}`,
      status: feature.availableTimePolicy === DATA_LINEAGE_PIT_POLICY ? 'pass' as const : 'fail' as const,
      node_id: null,
      node_type: 'contract_feature',
      source: 'strategy_family_contract',
      required: DATA_LINEAGE_PIT_POLICY,
      observed: feature.availableTimePolicy,
      details: {
        feature_id: feature.featureId,
        required: feature.required,
        quality_statuses_allowed: feature.qualityStatusesAllowed,
      },
    })),
    {
      id: 'row_level_available_time_audit',
      status: 'blocked',
      node_id: null,
      node_type: null,
      source: 'validation_runner',
      required: 'promotion-grade per-row system arrival_time <= decision_time proof',
      observed: rowLevelProxyAudit.observed,
      details: rowLevelProxyAudit,
    },
  ]
  const blockingReasons = [
    ...lineageValidation.blockingReasons.map((reason) => ({
      code: reason.code,
      severity: 'hard_block',
      source: 'data_lineage',
      node_id: reason.nodeId ?? null,
      required: reason.required ?? DATA_LINEAGE_PIT_POLICY,
      observed: reason.observed ?? reason.qualityStatus ?? 'lineage_validation_block',
    })),
    ...checks
      .filter((check) => check.status !== 'pass')
      .map((check) => ({
        code: pitBlockingCodeForCheck(check),
        severity: 'hard_block',
        source: check.source,
        node_id: check.node_id,
        required: check.required,
        observed: check.observed,
      })),
  ]

  return {
    schema_version: 'evidence_os_v4_feature_availability_audit.v4_0',
    ...input.meta,
    status: blockingReasons.length === 0 ? 'pass' : 'blocked',
    policy: DATA_LINEAGE_PIT_POLICY,
    holdout_window: {
      start_time: holdoutStart,
      end_time: holdoutEnd,
      start_time_iso: holdoutStartIso,
      end_time_iso: holdoutEndIso,
      candle_count: input.holdoutCandles.length,
    },
    lineage_validation: {
      passed: lineageValidation.passed,
      hash: lineageValidation.hash,
      blocking_reasons: lineageValidation.blockingReasons,
    },
    row_level_proxy_audit: rowLevelProxyAudit,
    checks,
    blocking_reasons: blockingReasons,
  }
}

function pitBlockingCodeForCheck(check: PitAuditCheck): EvidenceOsFailureCode {
  if (check.id !== 'row_level_available_time_audit') return 'PIT_VIOLATION'
  return check.details.proxy_status === 'fail' ? 'PIT_VIOLATION' : 'PIT_PROXY_ONLY'
}

function pitChecksForLineageNode(input: {
  node: DataLineageNode
  holdoutStart: number | null
  holdoutEnd: number | null
}): PitAuditCheck[] {
  const checks: PitAuditCheck[] = []
  const { node } = input
  if (node.type === 'feature' || node.type === 'strategy_input' || node.type === 'decision_artifact') {
    checks.push({
      id: `available_time_policy:${node.id}`,
      status: node.availableTimePolicy === DATA_LINEAGE_PIT_POLICY ? 'pass' : 'fail',
      node_id: node.id,
      node_type: node.type,
      source: 'data_lineage',
      required: DATA_LINEAGE_PIT_POLICY,
      observed: node.availableTimePolicy ?? 'missing',
      details: {
        quality_status: node.qualityStatus,
      },
    })
  }
  if (node.lastTimestamp != null && input.holdoutEnd != null) {
    const lastTimestampMs = Date.parse(node.lastTimestamp)
    const holdoutEndMs = input.holdoutEnd * 1000
    checks.push({
      id: `lineage_timestamp_not_after_holdout:${node.id}`,
      status: Number.isFinite(lastTimestampMs) && lastTimestampMs <= holdoutEndMs ? 'pass' : 'fail',
      node_id: node.id,
      node_type: node.type,
      source: 'data_lineage',
      required: 'lineage lastTimestamp <= holdout end',
      observed: node.lastTimestamp,
      details: {
        holdout_end: input.holdoutEnd,
        holdout_end_iso: marketTimeToIso(input.holdoutEnd),
      },
    })
  }
  return checks
}

function buildCsvRowLevelPitProxyAudit(holdoutCandles: MarketData[]): Record<string, unknown> & {
  observed: string
} {
  const rowCount = holdoutCandles.length
  const timestamps = holdoutCandles.map((candle) => candle.time)
  const invalidTimestampCount = timestamps.filter((time) => !Number.isFinite(time)).length
  let nonIncreasingCount = 0
  for (let index = 1; index < timestamps.length; index += 1) {
    if (timestamps[index] <= timestamps[index - 1]) nonIncreasingCount += 1
  }
  const firstDecisionTime = timestamps[0] ?? null
  const lastDecisionTime = timestamps[timestamps.length - 1] ?? null
  const eventTimeAfterDecisionTimeCount = holdoutCandles.filter((candle) => candle.time > candle.time).length
  const proxyPassed =
    rowCount > 0 &&
    invalidTimestampCount === 0 &&
    nonIncreasingCount === 0 &&
    eventTimeAfterDecisionTimeCount === 0

  return {
    observed: proxyPassed
      ? 'proxy_event_time_ordering_passed_but_arrival_time_missing'
      : 'proxy_event_time_ordering_failed_or_empty',
    proxy_status: proxyPassed ? 'pass' : 'fail',
    promotion_grade: false,
    proxy_type: 'csv_bar_event_time_as_decision_time',
    row_count: rowCount,
    invalid_timestamp_count: invalidTimestampCount,
    non_increasing_timestamp_count: nonIncreasingCount,
    event_time_after_decision_time_count: eventTimeAfterDecisionTimeCount,
    first_decision_time: firstDecisionTime,
    first_decision_time_iso: firstDecisionTime == null ? null : marketTimeToIso(firstDecisionTime),
    last_decision_time: lastDecisionTime,
    last_decision_time_iso: lastDecisionTime == null ? null : marketTimeToIso(lastDecisionTime),
    reason: 'CSV validation rows expose bar event times but not per-feature system arrival timestamps; proxy evidence cannot authorize promotion.',
    required_upgrade: 'persist per-feature available_time/arrival_time from the live data pipeline and prove available_time <= decision_time row by row',
  }
}

async function writeEvidenceOsV4Artifacts(
  input: EvidenceOsV4ArtifactsInput,
): Promise<EvidenceOsV4ArtifactsResult> {
  const createdAt = new Date().toISOString()
  const strategyFamily = normalizeStrategyFamily(input.args.strategy)
  const strategyFamilyContract = resolveValidationStrategyFamilyContract(strategyFamily)
  const strategyFamilyContractValidation = validateStrategyFamilyContract(strategyFamilyContract)
  const codeCommit = currentCodeCommit()
  const selectedParams = input.selectedEvaluation.params
  const strategyConfigHash = hashEvidenceComponent({
    strategy: input.args.strategy,
    params: selectedParams,
    candidates: input.args.candidates ?? [input.args.params],
  })
  const dataManifest = {
    schema: 'validation_data_manifest_stub.v4_0',
    inputCsv: input.args.inputCsv,
    symbol: input.args.symbol,
    peerCsvBySymbol: input.args.peerCsvBySymbol ?? {},
    candleCount: input.candles.length,
    firstTimestamp: input.candles[0]?.time ?? null,
    lastTimestamp: input.candles[input.candles.length - 1]?.time ?? null,
    holdoutFirstTimestamp: input.holdoutCandles[0]?.time ?? null,
    holdoutLastTimestamp: input.holdoutCandles[input.holdoutCandles.length - 1]?.time ?? null,
  }
  const dataManifestHash = hashEvidenceComponent(dataManifest)
  const featureSchemaHash = hashEvidenceComponent({
    schema: 'validation_feature_schema.v4_0',
    strategy: input.args.strategy,
    selectedParamKeys: Object.keys(selectedParams).sort(),
    featureLogicNote:
      'Increment this schema input whenever signal, feature lag, smoothing, or label logic changes.',
    icHorizons: input.strategySignalIcByHorizon.map((horizon) => horizon.horizonBars),
    pitPolicy: 'available_time <= decision_time',
  })
  const validationProfileHash = hashEvidenceComponent({
    schema: 'validation_profile.v4_0',
    trainBars: input.args.trainBars,
    testBars: input.args.testBars,
    stepBars: input.args.stepBars,
    degradationThreshold: input.args.degradationThreshold,
    significancePartitions: input.args.significancePartitions,
    riskSimulationMethod: input.args.riskSimulationMethod,
    riskSimulationCount: input.args.riskSimulationCount,
    riskHorizonBars: input.args.riskHorizonBars,
    riskBlockSize: input.args.riskBlockSize,
    riskRuinDrawdownPct: input.args.riskRuinDrawdownPct,
    riskMaxRuinProbability: input.args.riskMaxRuinProbability,
    riskMinProfitProbability: input.args.riskMinProfitProbability,
    selectionPolicy: 'selection_holdout_non_overlapping',
  })
  const costModelHash = hashEvidenceComponent({
    schema: 'validation_cost_model.v4_0',
    ...input.costModel,
  })
  const { evidenceId, hashHex } = buildEvidenceId({
    strategyFamily,
    strategyConfigHash,
    dataManifestHash,
    featureSchemaHash,
    validationProfileHash,
    costModelHash,
  })
  const evidenceKey = evidenceIdToPathKey(evidenceId)
  const artifactDir = resolve(input.args.evidenceOutputRoot, 'validation', evidenceKey)
  const trialId = `trial_${hashHex.slice(0, 16)}_${randomUUID()}`
  const candidateId = `candidate_${input.selectedCandidateIndex}_${hashHex.slice(0, 16)}`
  const validationResultPath = join(artifactDir, 'validation_result.json')
  const trialRecordPath = join(artifactDir, 'trial_record.json')
  const featureAvailabilityAuditPath = join(artifactDir, 'feature_availability_audit.json')
  const fdrReportPath = join(artifactDir, 'fdr_report.json')
  const promotionProvenancePath = join(artifactDir, 'promotion_verdict_provenance.json')
  const dataManifestPath = join(artifactDir, 'data_manifest.json')
  const dataLineagePath = join(artifactDir, 'data_lineage.latest.json')
  const dataLineageGraph = buildValidationDataLineageGraph({
    args: input.args,
    candles: input.candles,
    holdoutCandles: input.holdoutCandles,
    strategyFamily,
    candidateId,
    evidenceId,
    generatedAt: createdAt,
  })
  const dataLineageHash = hashDataLineageGraph(dataLineageGraph)
  const fdrReport = buildFailClosedFdrReport({
    meta: {
      evidence_id: evidenceId,
      strategy_family: strategyFamily,
      candidate_id: candidateId,
      code_commit: codeCommit,
      data_manifest_hash: dataManifestHash,
      data_lineage_hash: dataLineageHash,
      feature_schema_hash: featureSchemaHash,
      validation_profile_hash: validationProfileHash,
      cost_model_hash: costModelHash,
      created_at: createdAt,
    },
    significance: input.significance,
    candidateReturns: input.candidateReturns,
    selectedCandidateIndex: input.selectedCandidateIndex,
    riskBlockSize: input.args.riskBlockSize,
  })
  const featureAvailabilityAudit = buildFeatureAvailabilityAudit({
    meta: {
      evidence_id: evidenceId,
      strategy_family: strategyFamily,
      candidate_id: candidateId,
      code_commit: codeCommit,
      data_manifest_hash: dataManifestHash,
      data_lineage_hash: dataLineageHash,
      feature_schema_hash: featureSchemaHash,
      validation_profile_hash: validationProfileHash,
      cost_model_hash: costModelHash,
      created_at: createdAt,
      strategy_family_contract: strategyFamilyContractToJson(strategyFamilyContract),
      strategy_family_contract_validation: {
        passed: strategyFamilyContractValidation.passed,
        blocking_reasons: strategyFamilyContractValidation.blockingReasons,
      },
    },
    dataLineageGraph,
    strategyFamilyContract,
    holdoutCandles: input.holdoutCandles,
  })
  const fdrBlockingReasons = fdrReport.blocking_reasons.map((reason) => reason.observed)
  const pitProxyAudit = asRecord(featureAvailabilityAudit.row_level_proxy_audit)
  const pitAuditBlockingCodes = featureAvailabilityAudit.blocking_reasons
    .map((reason) => reason.code)
    .filter((code): code is string => typeof code === 'string')
  const failureCodes: FailureCode[] = [...new Set([
    ...fdrReport.blocking_reasons.map((reason) => reason.code),
    ...pitAuditBlockingCodes,
  ])] as FailureCode[]

  const fdrFamily = '2026Q2_crypto_evidence_os_v4'
  const batchId = `batch_${hashHex.slice(0, 12)}`
  const trialRecord: TrialRecord = {
    trialId,
    evidenceId,
    trialType: 'alpha_candidate',
    strategyFamily,
    candidateId,
    hypothesis: `Validate ${strategyFamily} candidate under Evidence OS v4.0 fail-closed gates.`,
    primaryMetric: 'cost_adjusted_net_expectancy_bps',
    secondaryMetrics: ['ic_mean', 'ic_ir', 'max_drawdown', 'turnover'],
    pValue: fdrReport.p_value,
    includedInFdr: true,
    fdrFamily,
    promotionEligible: false,
    status: 'failed_validation',
    failureCodes,
    batchId,
    createdAt,
    metadata: {
      code_commit: codeCommit,
      selected_candidate_index: input.selectedCandidateIndex,
      output_report_path: input.outputPath,
      evidence_os_version: 'v4.0',
      strategy_family_contract_status: strategyFamilyContractValidation.passed ? 'passed' : 'blocked',
      strategy_family_contract_blocks: strategyFamilyContractValidation.blockingReasons,
      raw_m_complete: fdrReport.raw_m_complete,
      includes_failed_trials: fdrReport.includes_failed_trials,
      p_value_source: fdrReport.p_value == null ? 'missing' : 'fdr_report',
      fdr_report_path: fdrReportPath,
      fdr_report_path_source: 'generated_artifact',
      fdr_report_status: fdrReport.status,
      fdr_p_values_available: fdrReport.p_values_available,
      fdr_missing_p_value_count: fdrReport.missing_p_value_count,
      fdr_p_value_blocked_reason: fdrBlockingReasons.find((reason) =>
        reason !== 'raw_m_complete=false' &&
        reason !== 'includes_failed_trials=false'
      ) ?? null,
      fdr_p_value_method: fdrReport.p_value_method,
      fdr_p_value_scope: fdrReport.p_value_scope,
      fdr_p_value_is_promotion_grade: fdrReport.p_value_is_promotion_grade,
      fdr_p_value_promotion_grade_source: 'fdr_report',
      fdr_observed_mean_excess: fdrReport.observed_mean_excess,
      fdr_bootstrap_samples: fdrReport.bootstrap_samples,
      fdr_candidate_count: fdrReport.raw_m,
      fdr_holdout_return_count: input.candidateReturns[input.selectedCandidateIndex]?.length ?? 0,
      fdr_benchmark_candidate_index: fdrReport.benchmark_candidate_index,
      fdr_bootstrap_block_size: fdrReport.bootstrap_block_size,
      fdr_bootstrap_block_size_set: fdrReport.bootstrap_block_size_set,
      fdr_bootstrap_direction_stable: fdrReport.bootstrap_direction_stable,
      feature_availability_audit_path: featureAvailabilityAuditPath,
      pit_audit_path: featureAvailabilityAuditPath,
      pit_audit_source: 'feature_availability_audit',
      pit_audit_status: featureAvailabilityAudit.status,
      pit_audit_blocking_codes: pitAuditBlockingCodes,
      pit_audit_proxy_type: stringOrNull(pitProxyAudit?.proxy_type),
      pit_audit_promotion_grade: booleanOrNull(pitProxyAudit?.promotion_grade) ?? false,
      pit_audit_promotion_grade_source: 'feature_availability_audit',
      promotion_decision_source: 'fail_closed_validation_pipeline',
    },
  }

  const meta = {
    evidence_id: evidenceId,
    strategy_family: strategyFamily,
    candidate_id: candidateId,
    code_commit: codeCommit,
    data_manifest_hash: dataManifestHash,
    data_lineage_hash: dataLineageHash,
    feature_schema_hash: featureSchemaHash,
    validation_profile_hash: validationProfileHash,
    cost_model_hash: costModelHash,
    created_at: createdAt,
    strategy_family_contract: strategyFamilyContractToJson(strategyFamilyContract),
    strategy_family_contract_validation: {
      passed: strategyFamilyContractValidation.passed,
      blocking_reasons: strategyFamilyContractValidation.blockingReasons,
    },
  }
  const icValues = input.strategySignalIcByHorizon
    .map((horizon) => horizon.pearsonIc)
    .filter((value) => Number.isFinite(value))
  const validationResult = {
    schema_version: 'evidence_os_v4_validation_result.v4_0',
    ...meta,
    verdict: 'blocked',
    metrics: {
      cost_adjusted_net_expectancy_bps: input.selectedEvaluation.metrics.netExpectancyPct * 100,
      ic_mean: mean(icValues),
      ic_ir: informationRatio(icValues),
      max_drawdown: input.selectedEvaluation.metrics.maxDrawdownPct,
      turnover: input.selectedEvaluation.metrics.turnoverPctOfInitialCapital,
      trade_count: input.selectedEvaluation.metrics.tradeCount,
      wfo_overall_passed: input.wfo.overallPassed,
      pbo: input.significance.pboResult.pbo,
      dsr_value: input.significance.dsrResult.dsrValue,
      risk_of_ruin: input.riskSimulation.riskOfRuin,
    },
    blocking_reasons: [
      {
        code: 'FDR_INPUTS_INCOMPLETE',
        source: 'fdr_report',
        severity: 'hard_block',
        required: 'complete trial universe with finite p-values before BY_raw_m FDR',
        observed: fdrReport.status,
      },
      {
        code: 'PIT_PROXY_ONLY',
        source: 'feature_availability_audit',
        severity: 'hard_block',
        required: 'promotion-grade row-level system arrival_time <= decision_time audit',
        observed: featureAvailabilityAudit.status,
      },
    ],
  }
  const promotionProvenance = buildBlockedPromotionVerdictProvenance({
    blockingReasons: [
      {
        code: 'FDR_INPUTS_INCOMPLETE',
        source: 'fdr_report',
        severity: 'hard_block',
        required: 'complete trial universe and p-values for BY_raw_m FDR',
        observed: fdrReport.status,
      },
      {
        code: 'PIT_PROXY_ONLY',
        source: 'feature_availability_audit',
        severity: 'hard_block',
        required: 'promotion-grade row-level system arrival_time <= decision_time audit',
        observed: featureAvailabilityAudit.status,
      },
    ],
    supportingEvidenceIds: [],
    excludedEvidenceIds: [
      {
        evidenceId,
        reason: 'validation_artifact_blocked_fdr_inputs_incomplete',
        source: 'validation_runner',
      },
    ],
    missingEvidence: [
      'complete_trial_universe_marker',
      'finite_p_values_for_all_included_trials',
      'promotion_grade_feature_availability_audit.pass',
    ],
    nextRequiredEvidence: [
      'register complete raw_m including failed and aborted trials',
      'emit finite p-values from validation statistics before BY_raw_m FDR',
      'replace CSV proxy PIT audit with row-level system arrival_time evidence',
    ],
    generatedAt: createdAt,
  })

  await mkdir(artifactDir, { recursive: true })
  await writeFile(dataManifestPath, `${JSON.stringify(dataManifest, null, 2)}\n`, 'utf-8')
  await writeFile(dataLineagePath, `${JSON.stringify(dataLineageGraphToJson(dataLineageGraph), null, 2)}\n`, 'utf-8')
  await writeFile(fdrReportPath, `${JSON.stringify(fdrReport, null, 2)}\n`, 'utf-8')
  await writeFile(validationResultPath, `${JSON.stringify(validationResult, null, 2)}\n`, 'utf-8')
  await writeFile(trialRecordPath, `${JSON.stringify(trialRecordToJson(trialRecord), null, 2)}\n`, 'utf-8')
  await writeFile(
    featureAvailabilityAuditPath,
    `${JSON.stringify(featureAvailabilityAudit, null, 2)}\n`,
    'utf-8',
  )
  await writeFile(
    promotionProvenancePath,
    `${JSON.stringify(promotionVerdictProvenanceToJson(promotionProvenance), null, 2)}\n`,
    'utf-8',
  )
  let trialRegistryAppend = {
    appended: false,
    reason: 'trial_registry_path_not_configured',
    trialId,
  }
  if (input.args.trialRegistryPath) {
    await appendTrialRecord(trialRecord, input.args.trialRegistryPath)
    trialRegistryAppend = {
      appended: true,
      reason: 'trial_record_appended',
      trialId,
    }
  }
  const completeTrialUniverseMarker = await appendCompleteTrialUniverseMarkerIfReady({
    significance: input.significance,
    evidenceId,
    fdrFamily,
    batchId,
    createdAt,
    trialRegistryPath: input.args.trialRegistryPath,
  })

  return {
    summary: {
      version: 'v4.0',
      evidenceId,
      evidenceKey,
      artifactDir,
      trialId,
      strategyFamily,
      candidateId,
      selectedCandidateIndex: input.selectedCandidateIndex,
      verdict: 'blocked',
      status: 'blocked_fdr_inputs_incomplete',
      promotionEligible: false,
      dataManifestHash,
      dataLineageHash,
      featureSchemaHash,
      validationProfileHash,
      costModelHash,
      codeCommit,
      artifactPaths: {
        dataManifest: dataManifestPath,
        dataLineage: dataLineagePath,
        fdrReport: fdrReportPath,
        validationResult: validationResultPath,
        trialRecord: trialRecordPath,
        featureAvailabilityAudit: featureAvailabilityAuditPath,
        promotionVerdictProvenance: promotionProvenancePath,
        trialRegistry: input.args.trialRegistryPath ? resolve(input.args.trialRegistryPath) : null,
      },
      trialRegistryAppend,
      completeTrialUniverseMarker,
      failureCodes,
      strategyFamilyContract: strategyFamilyContractToJson(strategyFamilyContract),
      strategyFamilyContractValidation: {
        passed: strategyFamilyContractValidation.passed,
        blockingReasons: strategyFamilyContractValidation.blockingReasons,
      },
    },
  }
}

function normalizeStrategyFamily(strategy: string): string {
  return strategy
    .replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replaceAll(/[^a-zA-Z0-9]+/g, '_')
    .replaceAll(/^_+|_+$/g, '')
    .toLowerCase()
}

function resolveValidationStrategyFamilyContract(strategyFamily: string): StrategyFamilyContract {
  const known = getStrategyFamilyContract(strategyFamily)
  if (known) return known
  return {
    familyId: strategyFamily,
    role: 'research',
    requiredFeatures: [
      {
        featureId: `${strategyFamily}_validation_features`,
        required: true,
        availableTimePolicy: 'available_time <= decision_time',
        qualityStatusesAllowed: ['ok'],
      },
    ],
    decisionHorizon: 'legacy_validation_default',
    labelHorizon: 'legacy_validation_default',
    allowedUniverse: ['validation_input_symbol'],
    maxTurnover: 1,
    maxLeverage: 1,
    promotionEligibility: 'research_only',
    failureModes: ['FDR_INPUTS_INCOMPLETE', 'PIT_PROXY_ONLY'],
    nextMutationAllowed: 'retry_after_new_hypothesis',
    paperEvidenceRequirement: {
      minLiveOnlyDays: 14,
      minDecisionCount: 30,
      minExecutedTradeCount: 10,
      minEventCount: 0,
      maxReportAgeSeconds: 900,
    },
  }
}

function strategyFamilyContractToJson(contract: StrategyFamilyContract): Record<string, unknown> {
  return {
    family_id: contract.familyId,
    role: contract.role,
    required_features: contract.requiredFeatures.map((feature) => ({
      feature_id: feature.featureId,
      required: feature.required,
      available_time_policy: feature.availableTimePolicy,
      quality_statuses_allowed: feature.qualityStatusesAllowed,
    })),
    decision_horizon: contract.decisionHorizon,
    label_horizon: contract.labelHorizon,
    allowed_universe: contract.allowedUniverse,
    max_turnover: contract.maxTurnover,
    max_leverage: contract.maxLeverage,
    promotion_eligibility: contract.promotionEligibility,
    failure_modes: contract.failureModes,
    next_mutation_allowed: contract.nextMutationAllowed,
    paper_evidence_requirement: {
      min_live_only_days: contract.paperEvidenceRequirement.minLiveOnlyDays,
      min_decision_count: contract.paperEvidenceRequirement.minDecisionCount,
      min_executed_trade_count: contract.paperEvidenceRequirement.minExecutedTradeCount,
      min_event_count: contract.paperEvidenceRequirement.minEventCount,
      max_report_age_seconds: contract.paperEvidenceRequirement.maxReportAgeSeconds,
    },
  }
}

function informationRatio(values: number[]): number {
  if (values.length < 2) return 0
  const avg = mean(values)
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / Math.max(1, values.length - 1)
  const stdev = Math.sqrt(variance)
  return stdev > 0 ? avg / stdev : 0
}

function currentCodeCommit(): string {
  if (process.env.OPENALICE_CODE_COMMIT?.trim()) return process.env.OPENALICE_CODE_COMMIT.trim()
  if (process.env.GIT_COMMIT?.trim()) return process.env.GIT_COMMIT.trim()
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
  } catch {
    return 'unknown-local'
  }
}


const ALL_REGIME_LABELS: StrategyRegimeLabel[] = [
  'HighVolTrend',
  'HighVolMeanRevert',
  'LowVolTrend',
  'LowVolCarry',
]

const REGIME_GATE_MIN_TRADE_RETENTION_RATIO = 0.3
const META_LABEL_MIN_TRADE_RETENTION_RATIO = 0.05
const META_LABEL_MIN_REALIZED_TRADE_COUNT = 3
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
  strategy: ValidationStrategyName
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
  if (!isAdditiveSweepStrategy(input.strategy)) {
    return unsupportedSweepResult(
      'meta-label quantile sweep',
      input.strategy,
      'factorMeanReversion, shockFade',
    )
  }

  const executionStrategy = resolveExecutionStrategy(input.strategy)

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
        const passesMinRealizedTradeCountConstraint =
          candidate.metrics.tradeCount >= META_LABEL_MIN_REALIZED_TRADE_COUNT
        const passesDrawdownConstraint =
          candidate.metrics.maxDrawdownPct <= input.baseResult.metrics.maxDrawdownPct
        const qualifies =
          positiveAbsoluteNetExpectancy &&
          passesNetExpectancyConstraint &&
          passesTradeCountConstraint &&
          passesMinRealizedTradeCountConstraint &&
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
            passesMinRealizedTradeCountConstraint,
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
      minRealizedTradeCount: META_LABEL_MIN_REALIZED_TRADE_COUNT,
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
  strategy: ValidationStrategyName
  candles: MarketData[]
  params: StrategyParams
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  baselineMetrics: BacktestMetrics
  lockedRegimeGate?: {
    allowedEntryRegimes: StrategyRegimeLabel[]
    exitOnMismatch?: boolean
  }
}) {
  if (input.lockedRegimeGate) {
    return {
      enabled: false,
      reason: 'Regime-gating sweep is disabled when a fixed regimeGateJson is supplied.',
    }
  }

  if (!isAdditiveSweepStrategy(input.strategy)) {
    return unsupportedSweepResult(
      'regime-gating sweep',
      input.strategy,
      'factorMeanReversion, shockFade',
    )
  }

  const executionStrategy = resolveExecutionStrategy(input.strategy)

  const baseline = {
    metrics: summarizeMetrics(input.baselineMetrics),
    baselineReport: buildBaselineReport(input.baselineMetrics),
  }
  const arms = enumerateRegimeGateConfigs(ALL_REGIME_LABELS)
    .map((gate, index) => {
      const candidate = runStrategyBacktest({
        strategy: executionStrategy,
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
    turnoverPctOfInitialCapital: metrics.turnoverPctOfInitialCapital,
    averageTurnoverPctPerTrade: metrics.averageTurnoverPctPerTrade,
    sharpe: metrics.sharpe,
    sortino: metrics.sortino,
    calmar: metrics.calmar,
  }
}

interface StrategySignalIcHorizon {
  horizonBars: number
  observations: number
  activeSignalObservations: number
  pearsonIc: number
  meanForwardReturnWhenLongPct: number
  meanForwardReturnWhenShortPct: number
}

function computeStrategySignalIcByHorizon(input: {
  strategy: StrategyName
  candles: MarketData[]
  params: Required<StrategyParams>
  horizons: number[]
}): StrategySignalIcHorizon[] {
  const minBars = getStrategyMinimumBars(input.strategy, input.params)
  return input.horizons.map((horizonBars) => {
    const signals: number[] = []
    const forwardReturns: number[] = []
    const longForwardReturns: number[] = []
    const shortForwardReturns: number[] = []
    let currentPosition: -1 | 0 | 1 = 0

    for (
      let index = minBars;
      index + horizonBars < input.candles.length;
      index += 1
    ) {
      const decision = evaluateStrategy({
        strategy: input.strategy,
        candles: input.candles,
        index,
        currentPosition,
        params: input.params,
      })
      currentPosition = decision.signal
      const currentClose = input.candles[index].close
      const futureClose = input.candles[index + horizonBars].close
      if (!Number.isFinite(currentClose) || currentClose <= 0 || !Number.isFinite(futureClose)) {
        continue
      }
      const forwardReturnPct = ((futureClose - currentClose) / currentClose) * 100
      signals.push(decision.signal)
      forwardReturns.push(forwardReturnPct)
      if (decision.signal > 0) {
        longForwardReturns.push(forwardReturnPct)
      } else if (decision.signal < 0) {
        shortForwardReturns.push(forwardReturnPct)
      }
    }

    return {
      horizonBars,
      observations: signals.length,
      activeSignalObservations: signals.filter((signal) => signal !== 0).length,
      pearsonIc: pearsonCorrelation(signals, forwardReturns),
      meanForwardReturnWhenLongPct: mean(longForwardReturns),
      meanForwardReturnWhenShortPct: mean(shortForwardReturns),
    }
  })
}

function buildValidationEvidence(input: {
  symbol: string
  candles: MarketData[]
  assetCandlesBySymbol: Record<string, MarketData[]>
  holdoutCandles: MarketData[]
  selectedEvaluation: BacktestResult
  strategySignalIcByHorizon: StrategySignalIcHorizon[]
  releaseGate: ReturnType<typeof evaluateReleaseGate>
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  strategyConfig: StrategyConfig
  alphaPoolPath: string
  strategyPlanEvidence: ReturnType<typeof buildStrategyPlanEvidence>
}) {
  const metrics = input.selectedEvaluation.metrics
  const executionQualityCheck = input.releaseGate.checks.find(
    (check) => check.name === 'execution_quality',
  )
  return {
    turnover: {
      available: true,
      totalTurnoverUsd: metrics.totalTurnoverUsd,
      turnoverPctOfInitialCapital: metrics.turnoverPctOfInitialCapital,
      averageTurnoverPctPerTrade: metrics.averageTurnoverPctPerTrade,
      tradeCount: metrics.tradeCount,
    },
    costAdjustedReturn: {
      available: true,
      totalReturnPct: metrics.totalReturnPct,
      grossExpectancyPct: metrics.grossExpectancyPct,
      netExpectancyPct: metrics.netExpectancyPct,
      totalCostsPaid: metrics.totalCostsPaid,
      costDragPctOfInitialCapital: metrics.costDragPctOfInitialCapital,
    },
    factorIcByHorizon: {
      available: false,
      reason:
        'This validation run has strategy-level signals only. Factor-level IC requires runtime factor snapshot history.',
      substitute: 'strategySignalIcByHorizon',
    },
    strategySignalIcByHorizon: input.strategySignalIcByHorizon,
    regimeSplitPerformance: metrics.regimeSummary,
    longShortSideAsymmetry: metrics.sideSummary,
    paperExecutionSlippage: {
      available: executionQualityCheck?.status === 'pass' || executionQualityCheck?.status === 'fail',
      gateStatus: executionQualityCheck?.status ?? 'missing',
      summary: executionQualityCheck?.summary ?? 'Execution quality gate not present in release gate output.',
      reason:
        executionQualityCheck?.status === 'skipped'
          ? 'Paper/live fill telemetry is required before paper execution slippage can stand as evidence.'
          : null,
    },
    strategyPlanEvidence: input.strategyPlanEvidence,
  }
}

function buildStrategyPlanEvidence(input: {
  symbol: string
  candles: MarketData[]
  assetCandlesBySymbol: Record<string, MarketData[]>
  holdoutCandles: MarketData[]
  selectedEvaluation: BacktestResult
  costModel: {
    feeRate: number
    slippageBps: number
    latencyBars: number
    fundingRatePer8h: number
  }
  strategyConfig: StrategyConfig
  alphaPoolPath: string
}) {
  const regimeIdentityBySymbol = Object.fromEntries(
    Object.entries(input.assetCandlesBySymbol).map(([symbol, candles]) => [
      symbol,
      buildRegimeIdentityEvidence(candles, input.strategyConfig),
    ]),
  )
  const regimeIdentity =
    regimeIdentityBySymbol[input.symbol] ?? buildRegimeIdentityEvidence(input.candles, input.strategyConfig)
  const regimeState = Object.entries(regimeIdentityBySymbol)
    .flatMap(([symbol, evidence]) =>
      evidence.latestRegimeEvaluation
        ? [{
            symbol,
            regime: evidence.latestRegimeEvaluation.regime,
            confidence: evidence.latestRegimeEvaluation.confidence,
          }]
        : [],
    )
  const crossAssetRegimeConsistency = evaluateCrossAssetRegimeConsistency({
    states: regimeState,
  })
  const alphaAdmission = readAlphaPoolSummaryForEvidence(input.alphaPoolPath)
  const rollingSharpeUniverse = selectUniverseByRollingSharpe([
    ...Object.entries(input.assetCandlesBySymbol).map(([symbol, candles]) => ({
      symbol,
      returns: marketDataToReturns(candles),
    })),
  ])
  const stableClusters = buildStableCorrelationClusters({
    windows: buildValidationCorrelationWindows(input.assetCandlesBySymbol),
    representativeScores: {
      ...Object.fromEntries(Object.keys(input.assetCandlesBySymbol).map((symbol) => [symbol, 0])),
      [input.symbol]: input.selectedEvaluation.metrics.sharpe,
    },
  })
  const sessionAwareSlippage = summarizeSessionAwareSlippage({
    trades: input.selectedEvaluation.trades,
    baselineSlippageBps: input.costModel.slippageBps,
  })

  return {
    regimeIdentityTracking: {
      available: regimeIdentity.available,
      runtimeHmmEnabled: regimeIdentity.runtimeHmmEnabled,
      coldStartMode: regimeIdentity.coldStartMode,
      effectiveSampleSize: regimeIdentity.effectiveSampleSize,
      latestRegime: regimeIdentity.latestRegimeEvaluation
        ? {
            regime: regimeIdentity.latestRegimeEvaluation.regime,
            confidence: regimeIdentity.latestRegimeEvaluation.confidence,
            method: regimeIdentity.latestRegimeEvaluation.method ?? null,
            reasons: regimeIdentity.latestRegimeEvaluation.reasons,
          }
        : null,
      stateIdentity: regimeIdentity.stateIdentity,
      reason: regimeIdentity.reason,
      bySymbol: Object.fromEntries(
        Object.entries(regimeIdentityBySymbol).map(([symbol, evidence]) => [
          symbol,
          {
            available: evidence.available,
            coldStartMode: evidence.coldStartMode,
            effectiveSampleSize: evidence.effectiveSampleSize,
            latestRegime: evidence.latestRegimeEvaluation
              ? {
                  regime: evidence.latestRegimeEvaluation.regime,
                  confidence: evidence.latestRegimeEvaluation.confidence,
                  method: evidence.latestRegimeEvaluation.method ?? null,
                }
              : null,
            stateIdentity: evidence.stateIdentity,
            reason: evidence.reason,
          },
        ]),
      ),
    },
    crossAssetRegimeConsistency: {
      available: regimeState.length >= 2,
      result: crossAssetRegimeConsistency,
      reason:
        regimeState.length >= 2
          ? null
          : 'Validation input contains one symbol; cross-asset consistency needs BTC/ETH or a multi-symbol panel via --peerCsvJson.',
    },
    alphaFactorAdmission: {
      ...alphaAdmission,
      reason: alphaAdmission.available
        ? null
        : alphaAdmission.error
          ? `Alpha pool artifact could not be read: ${alphaAdmission.error}`
          : 'Alpha pool artifact not found; novelty/hypothesis-alignment gate is present but has no candidate pool to audit.',
    },
    rollingSharpeUniverseSelection: {
      available: true,
      selection: rollingSharpeUniverse,
    },
    stableCorrelationClustering: {
      available: stableClusters.clusters.some((cluster) => cluster.symbols.length > 1),
      clusters: stableClusters.clusters,
      coAssignmentFrequency: stableClusters.coAssignmentFrequency,
      reason:
        stableClusters.clusters.some((cluster) => cluster.symbols.length > 1)
          ? null
          : 'Single-symbol validation cannot prove stable cross-asset clustering; pass a multi-symbol return panel for this evidence.',
    },
    sessionAwareSlippageEstimate: sessionAwareSlippage,
  }
}

function buildRegimeIdentityEvidence(
  candles: MarketData[],
  strategyConfig: StrategyConfig,
): {
  available: boolean
  runtimeHmmEnabled: boolean
  coldStartMode: string | null
  effectiveSampleSize: number
  latestRegimeEvaluation: RegimeEvaluation | null
  stateIdentity: Record<string, unknown> | null
  reason: string | null
} {
  const hmmConfig = {
    ...DEFAULT_REGIME_HMM_CONFIG,
    ...(strategyConfig.regime?.hmm ?? {}),
    enabled: true,
  }
  const observations = extractHmmObservations(toOhlcvCandles(candles), {
    realizedVolWindow: hmmConfig.realizedVolWindow,
    volumeBaselineWindow: hmmConfig.volumeBaselineWindow,
    zScoreWindow: hmmConfig.zScoreWindow,
  })
  const hmmOutput = new RegimeHmm(hmmConfig).classify(observations)
  if (!hmmOutput) {
    return {
      available: false,
      runtimeHmmEnabled: strategyConfig.regime?.hmm?.enabled === true,
      coldStartMode: null,
      effectiveSampleSize: observations.length,
      latestRegimeEvaluation: null,
      stateIdentity: null,
      reason: 'No HMM output could be produced from validation candles.',
    }
  }
  const latestRegimeEvaluation = evaluateRegime(
    buildRegimeFeaturesForValidation(candles),
    {
      hmm: hmmOutput,
      hmmConfidenceFloor: hmmConfig.confidenceFloor,
    },
  )

  return {
    available: hmmOutput.stateIdentity != null,
    runtimeHmmEnabled: strategyConfig.regime?.hmm?.enabled === true,
    coldStartMode: hmmOutput.coldStartMode,
    effectiveSampleSize: hmmOutput.effectiveSampleSize,
    latestRegimeEvaluation,
    stateIdentity: hmmOutput.stateIdentity
      ? {
          method: hmmOutput.stateIdentity.method,
          rawState: hmmOutput.stateIdentity.rawState,
          rawStateName: hmmOutput.stateIdentity.rawStateName,
          matchedState: hmmOutput.stateIdentity.matchedState,
          matchedStateName: hmmOutput.stateIdentity.matchedStateName,
          wassersteinDistance: hmmOutput.stateIdentity.wassersteinDistance,
          identityConfidence: hmmOutput.stateIdentity.identityConfidence,
          activeStateCount: hmmOutput.stateIdentity.activeStateCount,
          rawToCanonicalState: hmmOutput.stateIdentity.rawToCanonicalState,
        }
      : null,
    reason: hmmOutput.stateIdentity
      ? null
      : 'HMM is still in threshold cold-start mode; Wasserstein state identity is available after EM activation.',
  }
}

function readAlphaPoolSummaryForEvidence(path: string) {
  try {
    return {
      ...summarizeAlphaPoolArtifact(readAlphaPoolArtifactSync(path), path),
      error: null as string | null,
    }
  } catch (error) {
    return {
      ...summarizeAlphaPoolArtifact(null, path),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function buildRegimeFeaturesForValidation(candles: MarketData[]) {
  return {
    trendStrength: computeValidationTrendStrength(candles),
    realizedVolPct: computeValidationRealizedVolPct(candles),
    realizedVolPercentile: computeValidationRealizedVolPercentile(candles),
    rangeCompressionScore: computeValidationRangeCompressionScore(candles),
    volumeChangeRate: computeValidationVolumeChangeRate(candles),
  }
}

function computeValidationTrendStrength(candles: MarketData[]): number {
  const closes = candles.map((candle) => candle.close).filter((value) => Number.isFinite(value))
  if (closes.length < 25) {
    return 0
  }
  const fast = mean(closes.slice(-12))
  const slow = mean(closes.slice(-48))
  if (slow <= 0) {
    return 0
  }
  return clamp01(Math.abs(fast - slow) / slow * 20)
}

function computeValidationRealizedVolPct(candles: MarketData[]): number {
  const returns = marketDataToReturns(candles).slice(-24)
  if (returns.length < 2) {
    return 0
  }
  return sampleStandardDeviation(returns) * Math.sqrt(24 * 365) * 100
}

function computeValidationRealizedVolPercentile(candles: MarketData[]): number {
  const returns = marketDataToReturns(candles)
  if (returns.length < 48) {
    return 0.5
  }
  const rolling: number[] = []
  for (let index = 23; index < returns.length; index += 1) {
    rolling.push(sampleStandardDeviation(returns.slice(index - 23, index + 1)))
  }
  const latest = rolling[rolling.length - 1]
  if (!Number.isFinite(latest)) {
    return 0.5
  }
  return rolling.filter((value) => value <= latest).length / rolling.length
}

function computeValidationRangeCompressionScore(candles: MarketData[]): number {
  const recent = candles.slice(-24)
  const baseline = candles.slice(-96)
  if (recent.length < 3 || baseline.length < 3) {
    return 0
  }
  const recentRange = mean(recent.map((candle) => candle.high - candle.low))
  const baselineRange = mean(baseline.map((candle) => candle.high - candle.low))
  if (baselineRange <= 0) {
    return 0
  }
  return clamp01(1 - recentRange / baselineRange)
}

function computeValidationVolumeChangeRate(candles: MarketData[]): number {
  const latest = candles[candles.length - 1]?.volume ?? 0
  const baseline = mean(candles.slice(-25, -1).map((candle) => candle.volume))
  return baseline > 0 ? latest / baseline : 0
}

function marketDataToReturns(candles: MarketData[]): number[] {
  const returns: number[] = []
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1].close
    const current = candles[index].close
    if (previous > 0 && Number.isFinite(previous) && Number.isFinite(current)) {
      returns.push(current / previous - 1)
    }
  }
  return returns
}

function sampleStandardDeviation(values: number[]): number {
  if (values.length < 2) {
    return 0
  }
  const valueMean = mean(values)
  const variance =
    values.reduce((sum, value) => sum + (value - valueMean) ** 2, 0) / (values.length - 1)
  return Math.sqrt(Math.max(variance, 0))
}

function buildValidationCorrelationWindows(assetCandlesBySymbol: Record<string, MarketData[]>) {
  const series = Object.entries(assetCandlesBySymbol)
    .map(([symbol, candles]) => ({
      symbol,
      returns: marketDataToReturns(candles),
    }))
    .filter((item) => item.returns.length >= 2)
    .sort((left, right) => left.symbol.localeCompare(right.symbol))

  if (series.length < 1) {
    return []
  }
  if (series.length === 1) {
    return [{
      symbols: [series[0].symbol],
      correlation: [[1]],
    }]
  }

  const minLength = Math.min(...series.map((item) => item.returns.length))
  if (minLength < 12) {
    return [{
      symbols: series.map((item) => item.symbol),
      correlation: buildCorrelationMatrix(series.map((item) => item.returns.slice(-minLength))),
    }]
  }

  const windowSize = Math.min(240, Math.max(12, Math.floor(minLength / 3)))
  const aligned = series.map((item) => item.returns.slice(-minLength))
  const windows = []
  for (let end = windowSize; end <= minLength; end += windowSize) {
    const slices = aligned.map((returns) => returns.slice(end - windowSize, end))
    windows.push({
      symbols: series.map((item) => item.symbol),
      correlation: buildCorrelationMatrix(slices),
    })
  }
  if (windows.length === 0 || windows[windows.length - 1]!.symbols.length !== series.length) {
    windows.push({
      symbols: series.map((item) => item.symbol),
      correlation: buildCorrelationMatrix(aligned.map((returns) => returns.slice(-windowSize))),
    })
  }
  return windows
}

function buildCorrelationMatrix(series: number[][]): number[][] {
  return series.map((left, rowIndex) =>
    series.map((right, columnIndex) => (
      rowIndex === columnIndex ? 1 : pearsonCorrelation(left, right)
    )),
  )
}

function summarizeSessionAwareSlippage(input: {
  trades: BacktestTrade[]
  baselineSlippageBps: number
}) {
  const estimates = input.trades.map((trade) =>
    sessionAwareSlippageEstimate(trade.entryTime * 1000, input.baselineSlippageBps),
  )
  const bySession = (['asia', 'europe', 'us', 'off_hours'] as const).map((session) => {
    const bucket = estimates.filter((estimate) => estimate.session === session)
    return {
      session,
      tradeCount: bucket.length,
      averageEstimatedSlippageBps: mean(bucket.map((estimate) => estimate.estimatedSlippageBps)),
      maxEstimatedSlippageBps:
        bucket.length > 0 ? Math.max(...bucket.map((estimate) => estimate.estimatedSlippageBps)) : 0,
      handoffTradeCount: bucket.filter((estimate) => estimate.handoffPenaltyBps > 0).length,
    }
  })

  return {
    available: estimates.length > 0,
    tradeCount: estimates.length,
    baselineSlippageBps: input.baselineSlippageBps,
    averageEstimatedSlippageBps: mean(
      estimates.map((estimate) => estimate.estimatedSlippageBps),
    ),
    maxEstimatedSlippageBps:
      estimates.length > 0
        ? Math.max(...estimates.map((estimate) => estimate.estimatedSlippageBps))
        : 0,
    bySession,
    dominantSession: selectDominantLiquiditySession(bySession),
    reason:
      estimates.length > 0
        ? null
        : 'No holdout trades were available for session-aware slippage estimation.',
  }
}

function selectDominantLiquiditySession(
  bySession: Array<{
    session: IntradayLiquiditySession
    tradeCount: number
    averageEstimatedSlippageBps: number
  }>,
): IntradayLiquiditySession | null {
  const active = bySession.filter((bucket) => bucket.tradeCount > 0)
  if (active.length === 0) {
    return null
  }
  return [...active].sort((left, right) => right.tradeCount - left.tradeCount)[0].session
}

function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) {
    return 0
  }
  const xMean = mean(x)
  const yMean = mean(y)
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

function mean(values: number[]): number {
  if (values.length < 1) {
    return 0
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length
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

function buildCanonicalScoreboardSummary(input: {
  controlArm: ReturnType<typeof buildDeployableStrategyTarget>['controlArm']
  selectedCandidate: {
    candidateIndex: number
    params: StrategyParams
    metrics: ReturnType<typeof summarizeMetrics>
    baselineReport: ReturnType<typeof buildBaselineReport>
  }
  recommendation: ReturnType<typeof buildRecommendedCandidate>['recommendation']
  wfo: ReturnType<typeof runStrategyWalkForward>
  significance: ReturnType<typeof evaluateSignificanceGate>
  riskSimulation: ReturnType<typeof evaluateRiskSimulation>
  releaseGate: ReturnType<typeof evaluateReleaseGate>
}) {
  return {
    controlArm: input.controlArm,
    selectedCandidate: {
      source: 'selected_candidate',
      selectionBasis: 'best_sharpe',
      candidateIndex: input.selectedCandidate.candidateIndex,
      params: input.selectedCandidate.params,
      metrics: input.selectedCandidate.metrics,
      baselineReport: input.selectedCandidate.baselineReport,
    },
    recommendation: input.recommendation,
    wfo: {
      overallPassed: input.wfo.overallPassed,
      failedWindows: input.wfo.failedWindows,
      windowCount: input.wfo.windows.length,
      failedWindowRatio:
        input.wfo.windows.length > 0 ? input.wfo.failedWindows / input.wfo.windows.length : 0,
      windows: input.wfo.windows.map((window) => ({
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
      passed: input.significance.passed,
      pbo: input.significance.pboResult.pbo,
      pboThreshold: input.significance.pboThreshold,
      dsrValue: input.significance.dsrResult.dsrValue,
      dsrProbability: input.significance.dsrResult.dsrProbability,
      dsrMin: input.significance.dsrMin,
    },
    risk: {
      method: input.riskSimulation.method,
      simulations: input.riskSimulation.simulations,
      horizonBars: input.riskSimulation.horizonBars,
      ruinDrawdownPct: input.riskSimulation.ruinDrawdownPct,
      maxRuinProbability: input.riskSimulation.maxRuinProbability,
      minProfitProbability: input.riskSimulation.minProfitProbability,
      confidenceLevel: input.riskSimulation.confidenceLevel,
      profitProbability: input.riskSimulation.profitProbability,
      riskOfRuin: input.riskSimulation.riskOfRuin,
      expectedFinalReturnPct: input.riskSimulation.expectedFinalReturnPct,
      medianFinalReturnPct: input.riskSimulation.medianFinalReturnPct,
      confidenceInterval: input.riskSimulation.confidenceInterval,
      gatePassed: input.riskSimulation.gatePassed,
    },
    releaseGate: {
      allowPaperTrading: input.releaseGate.allowPaperTrading,
      allowLiveTrading: input.releaseGate.allowLiveTrading,
      hardFail: input.releaseGate.hardFail,
      failedChecks: input.releaseGate.failedChecks,
      warningChecks: input.releaseGate.warningChecks,
      checks: input.releaseGate.checks.map((check) => ({
        name: check.name,
        status: check.status,
        summary: check.summary,
      })),
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function booleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false
  }
  return null
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
    turnover: {
      totalTurnoverUsd: metrics.totalTurnoverUsd,
      turnoverPctOfInitialCapital: metrics.turnoverPctOfInitialCapital,
      averageTurnoverPctPerTrade: metrics.averageTurnoverPctPerTrade,
    },
    bySide: metrics.sideSummary,
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

function parseStrategy(value: string): ValidationStrategyName {
  if (!isValidationStrategyName(value)) {
    throw new Error(`Unsupported strategy: ${value}`)
  }
  return value
}

function isValidationStrategyName(value: unknown): value is ValidationStrategyName {
  return isStrategyName(value)
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
  strategy: ValidationStrategyName,
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
    case 'shockFade':
      return [
        { ...base },
        {
          ...base,
          factorEntryThreshold: Math.max(0.35, (base.factorEntryThreshold ?? 0.45) - 0.05),
          factorExitThreshold: Math.max(0.04, (base.factorExitThreshold ?? 0.08) - 0.02),
          factorMaxHoldingBars: Math.max(18, (base.factorMaxHoldingBars ?? 30) - 6),
          factorPositionPctOfEquity: Math.max(0.008, (base.factorPositionPctOfEquity ?? 0.015) - 0.003),
          factorStopLossPct: Math.max(0.0075, (base.factorStopLossPct ?? 0.012) - 0.0025),
          factorKillSwitchVolPct: Math.max(2.2, (base.factorKillSwitchVolPct ?? 2.8) - 0.3),
          factorKillSwitchTrendStrengthPct: Math.max(
            0.45,
            (base.factorKillSwitchTrendStrengthPct ?? 0.6) - 0.08,
          ),
          shockMinVolumeRatio: Math.max(1.5, (base.shockMinVolumeRatio ?? 1.8) - 0.15),
          shockMinAbsReturnPct: Math.max(1.4, (base.shockMinAbsReturnPct ?? 1.8) - 0.2),
        },
        {
          ...base,
          factorEntryThreshold: Math.min(0.75, (base.factorEntryThreshold ?? 0.45) + 0.08),
          factorExitThreshold: Math.min(0.18, (base.factorExitThreshold ?? 0.08) + 0.03),
          factorMaxHoldingBars: Math.max(24, (base.factorMaxHoldingBars ?? 30) + 6),
          factorPositionPctOfEquity: Math.max(0.008, (base.factorPositionPctOfEquity ?? 0.015) - 0.002),
          factorStopLossPct: Math.min(0.02, (base.factorStopLossPct ?? 0.012) + 0.003),
          factorKillSwitchTrendStrengthPct: Math.max(
            0.45,
            (base.factorKillSwitchTrendStrengthPct ?? 0.6) - 0.05,
          ),
          shockMinVolumeRatio: Math.min(2.4, (base.shockMinVolumeRatio ?? 1.8) + 0.2),
          shockMinAbsReturnPct: Math.min(3.0, (base.shockMinAbsReturnPct ?? 1.8) + 0.3),
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

function isAdditiveSweepStrategy(strategy: ValidationStrategyName): boolean {
  return strategy === 'factorMeanReversion' || strategy === 'shockFade'
}

function unsupportedSweepResult(
  sweepName: string,
  strategy: ValidationStrategyName,
  supportedStrategies: string,
) {
  return {
    enabled: false,
    reason: `${sweepName} is only wired for ${supportedStrategies}; received ${strategy}.`,
  }
}

function resolveExecutionStrategy(strategy: ValidationStrategyName): StrategyName {
  return strategy
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

async function loadPeerCsvCandles(
  peerCsvBySymbol: Record<string, string> | undefined,
  lookbackBars: number,
): Promise<Record<string, MarketData[]>> {
  const entries = Object.entries(peerCsvBySymbol ?? {})
    .filter(([symbol, path]) => symbol.trim().length > 0 && path.trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
  const out: Record<string, MarketData[]> = {}
  for (const [symbol, path] of entries) {
    out[symbol] = (await loadCsvCandles(path, symbol)).slice(-lookbackBars)
  }
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
  appendCompleteTrialUniverseMarkerIfReady,
  buildRecommendedCandidate,
  buildRegimeGateSweep,
  evaluateSignificanceGateForReport,
  buildMetaLabelSweep,
  summarizeMetrics,
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error('run_validation_pipeline failed:', err)
    process.exit(1)
  })
}
