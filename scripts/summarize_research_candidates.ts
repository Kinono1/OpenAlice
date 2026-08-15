import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type EvidenceTier =
  | 'release_validated'
  | 'diagnostic_validation'
  | 'optimization_prevalidation'
  | 'risk_diagnostic'

type CandidateStatus =
  | 'paper_candidate_observed'
  | 'research_only_blocked'
  | 'diagnostic_only'
  | 'prevalidation_only'

interface CliArgs {
  researchRoot: string
  outputPath: string | null
  maxCandidates: number
  json: boolean
}

export interface ResearchArtifactFile {
  path: string
  value: unknown
}

export interface CandidateMetricsSummary {
  totalReturnPct: number | null
  netExpectancyPct: number | null
  grossExpectancyPct: number | null
  profitFactor: number | null
  sharpe: number | null
  sortino: number | null
  maxDrawdownPct: number | null
  tradeCount: number | null
  winRatePct: number | null
  costDragPctOfInitialCapital: number | null
  riskProfitProbability: number | null
  riskOfRuin: number | null
  pbo: number | null
  dsrProbability: number | null
  fdrQ: number | null
  meanIc?: number | null
  icIr?: number | null
  icWinRatePct?: number | null
  signalPeriods?: number | null
  commonPeriods?: number | null
  averageLongShortSpreadPct?: number | null
  longShortWinRatePct?: number | null
  rankIcWfoStatus?: string | null
  rankIcWfoFailedWindowRatio?: number | null
  rankIcWfoWindowCount?: number | null
  rankIcWfoPassedWindows?: number | null
  bestRoute?: string | null
  routeCostValidationStatus?: string | null
  netAfterRouteCostPct?: number | null
  grossToPairCostRatio?: number | null
  pairRoundTripCostPct?: number | null
  feeSnapshotSource?: string | null
  feeSnapshotStale?: boolean | null
  feeSnapshotVerifiedByRuntime?: boolean | null
}

export interface ResearchCandidateRow {
  rank: number
  candidateKey: string
  sourcePath: string
  sourceKind: string
  evidenceTier: EvidenceTier
  generatedAt: string | null
  family: string
  strategy: string
  symbol: string
  candidateId: string
  status: CandidateStatus
  researchScore: number
  metrics: CandidateMetricsSummary
  gates: {
    releaseGatePresent: boolean
    allowPaperTrading: boolean
    allowLiveTrading: boolean
    failedChecks: string[]
    wfoPassed: boolean | null
    significancePassed: boolean | null
    riskSimulationPassed: boolean | null
  }
  whyNotTradable: string[]
  nextAction: string
}

export interface ResearchCandidateSummaryReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  promotionAllowed: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  sourceRoot: string
  sourceFilesScanned: number
  candidateRowsFound: number
  counts: {
    byEvidenceTier: Array<{ key: EvidenceTier; count: number }>
    byStatus: Array<{ key: CandidateStatus; count: number }>
    blockedTradableRows: number
    positiveNetExpectancyRows: number
    positiveGrossButNegativeNetRows: number
  }
  topCandidates: ResearchCandidateRow[]
  bestByTier: Array<{ evidenceTier: EvidenceTier; candidate: ResearchCandidateRow | null }>
  focusRecommendations: string[]
  safetyNotes: string[]
}

const DEFAULT_RESEARCH_ROOT = 'data/research'
const DEFAULT_OUTPUT_PATH = 'data/research/candidate_ranking.latest.json'
const DEFAULT_MAX_CANDIDATES = 40

async function main(): Promise<void> {
  const args = parseResearchCandidateSummaryArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runResearchCandidateSummary(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'research_candidate_summary',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.candidateRowsFound > 0 ? 'warn' : 'fail',
      recordsIn: report.sourceFilesScanned,
      recordsOut: report.candidateRowsFound,
      errorClass: report.candidateRowsFound > 0 ? null : 'no_research_candidates_found',
    })
  }
}

export function parseResearchCandidateSummaryArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    researchRoot: raw.get('researchRoot') ?? raw.get('root') ?? DEFAULT_RESEARCH_ROOT,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxCandidates: parsePositiveInteger(raw.get('maxCandidates'), DEFAULT_MAX_CANDIDATES, 'maxCandidates'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runResearchCandidateSummary(
  args: CliArgs,
): Promise<ResearchCandidateSummaryReport> {
  const researchRoot = resolve(args.researchRoot)
  const files = await loadResearchArtifacts(researchRoot)
  const report = buildResearchCandidateSummaryReport({
    files,
    sourceRoot: researchRoot,
    maxCandidates: args.maxCandidates,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildResearchCandidateSummaryReport(input: {
  files: ResearchArtifactFile[]
  sourceRoot: string
  generatedAt?: string
  maxCandidates?: number
}): ResearchCandidateSummaryReport {
  const rows = input.files.flatMap(extractCandidateRows)
  const deduped = dedupeRows(rows)
    .sort((a, b) => b.researchScore - a.researchScore)
    .map((row, index) => ({ ...row, rank: index + 1 }))
  const maxCandidates = input.maxCandidates ?? DEFAULT_MAX_CANDIDATES
  const topCandidates = deduped.slice(0, maxCandidates)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    promotionAllowed: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    sourceRoot: resolve(input.sourceRoot),
    sourceFilesScanned: input.files.length,
    candidateRowsFound: deduped.length,
    counts: {
      byEvidenceTier: countBy(deduped, row => row.evidenceTier),
      byStatus: countBy(deduped, row => row.status),
      blockedTradableRows: deduped.filter(row => row.whyNotTradable.length > 0).length,
      positiveNetExpectancyRows: deduped.filter(row => (row.metrics.netExpectancyPct ?? 0) > 0).length,
      positiveGrossButNegativeNetRows: deduped.filter(row =>
        (row.metrics.grossExpectancyPct ?? Number.NEGATIVE_INFINITY) > 0 &&
        (row.metrics.netExpectancyPct ?? 0) <= 0,
      ).length,
    },
    topCandidates,
    bestByTier: ([
      'release_validated',
      'diagnostic_validation',
      'optimization_prevalidation',
      'risk_diagnostic',
    ] as EvidenceTier[]).map(evidenceTier => ({
      evidenceTier,
      candidate: deduped.find(row => row.evidenceTier === evidenceTier) ?? null,
    })),
    focusRecommendations: buildFocusRecommendations(deduped),
    safetyNotes: [
      'This artifact is research-only and cannot authorize paper or live orders.',
      'Backtest and diagnostic rows must not be promoted without clean WFO, complete trial ledger, BY FDR, PIT-safe features, runtime fee evidence, and route-cost-adjusted economics.',
      'Rows without release gates are useful for choosing the next experiment, not for execution.',
    ],
  }
}

function extractCandidateRows(file: ResearchArtifactFile): ResearchCandidateRow[] {
  const root = asRecord(file.value)
  if (!root) return []
  const out: ResearchCandidateRow[] = []

  if (isValidationArtifact(file.path, root)) {
    out.push(...extractValidationRows(file.path, root))
  }
  if (Array.isArray(root.strategies) || isRecord(root.crossSectionalMomentum)) {
    out.push(...extractNewStrategyRows(file.path, root))
  }
  if (isCryptoFactorFamilyArtifact(root)) {
    out.push(...extractCryptoFactorFamilyRows(file.path, root))
  } else if (isLiquidityConditionedFactorArtifact(root)) {
    out.push(...extractLiquidityConditionedFactorRows(file.path, root))
  } else if (isRankIcArtifact(root)) {
    out.push(...extractRankIcRows(file.path, root))
  } else if (isRankIcWalkForwardFilterArtifact(root)) {
    out.push(...extractRankIcWalkForwardFilterRows(file.path, root))
  } else if (isRankIcProspectiveLaneArtifact(root)) {
    out.push(...extractRankIcProspectiveLaneRows(file.path, root))
  } else if (isRankIcRouteCostArtifact(root)) {
    out.push(...extractRankIcRouteCostRows(file.path, root))
  } else if (Array.isArray(root.topConfigs) || isRecord(root.summary)) {
    out.push(...extractOptimizationRows(file.path, root))
  }
  if (Array.isArray(root.strategies) && file.path.includes('/risk_analysis/')) {
    out.push(...extractRiskRows(file.path, root))
  }

  return out
}

function isCryptoFactorFamilyArtifact(root: Record<string, unknown>): boolean {
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    asRecord(root.hypothesis)?.id === 'crypto_base_factor_family_v1' &&
    Array.isArray(root.topConfigs)
}

function extractCryptoFactorFamilyRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const routeCost = asRecord(root.routeCost)
  const configs = Array.isArray(root.topConfigs) ? root.topConfigs : []
  return configs.flatMap(item => {
    const config = asRecord(item)
    if (!config) return []
    const wfo = asRecord(config.wfo)
    const candidateId = readString(config.candidateId) ?? [
      'factor',
      readString(config.factor) ?? 'factor',
      `lb${readNumber(config.lookbackHours) ?? 'na'}`,
      `fwd${readNumber(config.forwardHours) ?? 'na'}`,
    ].join('_')
    return buildRow({
      sourcePath: path,
      sourceKind: 'crypto_factor_family',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: 'crypto_factor_family',
      strategy: readString(config.factor) ?? 'unknown_factor',
      symbol: 'multi_asset',
      candidateId,
      metrics: {
        totalReturnPct: null,
        netExpectancyPct: readNumber(config.netAfterRouteCostPct),
        grossExpectancyPct: readNumber(config.averageLongShortSpreadPct),
        profitFactor: null,
        sharpe: null,
        sortino: null,
        maxDrawdownPct: null,
        tradeCount: readNumber(config.signalPeriods),
        winRatePct: toPct(readNumber(config.longShortWinRate)),
        costDragPctOfInitialCapital: readNumber(config.routeCostPct) ?? readNumber(routeCost?.pairRoundTripCostPct),
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
        meanIc: readNumber(config.meanIc),
        icIr: readNumber(config.icIr),
        icWinRatePct: toPct(readNumber(config.winRate)),
        signalPeriods: readNumber(config.signalPeriods),
        commonPeriods: readNumber(root.commonPeriods),
        averageLongShortSpreadPct: readNumber(config.averageLongShortSpreadPct),
        longShortWinRatePct: toPct(readNumber(config.longShortWinRate)),
        rankIcWfoStatus: readString(wfo?.status),
        rankIcWfoFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
        rankIcWfoWindowCount: readNumber(wfo?.windowCount),
        rankIcWfoPassedWindows: readNumber(wfo?.passedWindows),
        routeCostValidationStatus: readBool(config.passedIc) === true &&
          (readNumber(config.netAfterRouteCostPct) ?? Number.NEGATIVE_INFINITY) > 0
          ? 'positive_after_cost_diagnostic'
          : 'base_factor_not_promotion_grade',
        netAfterRouteCostPct: readNumber(config.netAfterRouteCostPct),
        pairRoundTripCostPct: readNumber(config.routeCostPct) ?? readNumber(routeCost?.pairRoundTripCostPct),
        feeSnapshotSource: readString(routeCost?.source),
        feeSnapshotVerifiedByRuntime: readBool(routeCost?.runtimeVerified),
        feeSnapshotStale: null,
      },
      gates: emptyGates(),
      extraBlockers: [
        ...readStringArray(root.blockers),
        ...readStringArray(config.blockers),
        `crypto_factor_verdict:${readString(config.candidateVerdict) ?? 'missing'}`,
      ],
    })
  })
}

function isLiquidityConditionedFactorArtifact(root: Record<string, unknown>): boolean {
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    asRecord(root.hypothesis)?.id === 'liquidity_conditioned_momentum_reversal_v1' &&
    Array.isArray(root.topConfigs)
}

function extractLiquidityConditionedFactorRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const routeCost = asRecord(root.routeCost)
  const configs = Array.isArray(root.topConfigs) ? root.topConfigs : []
  return configs.flatMap(item => {
    const config = asRecord(item)
    if (!config) return []
    const wfo = asRecord(config.wfo)
    const candidateId = readString(config.configId) ?? [
      'liquidity_conditioned',
      readString(config.liquidityBucket) ?? 'bucket',
      readString(config.factor) ?? 'factor',
      `lb${readNumber(config.lookbackHours) ?? 'na'}`,
      `fwd${readNumber(config.forwardHours) ?? 'na'}`,
    ].join('_')
    return buildRow({
      sourcePath: path,
      sourceKind: 'liquidity_conditioned_factor',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: 'liquidity_conditioned_factor',
      strategy: [
        readString(config.liquidityBucket) ?? 'unknown_bucket',
        readString(config.factor) ?? 'unknown_factor',
      ].join('_'),
      symbol: 'multi_asset',
      candidateId,
      metrics: {
        totalReturnPct: null,
        netExpectancyPct: readNumber(config.netAfterRouteCostPct),
        grossExpectancyPct: readNumber(config.averageLongShortSpreadPct),
        profitFactor: null,
        sharpe: null,
        sortino: null,
        maxDrawdownPct: null,
        tradeCount: readNumber(config.signalPeriods),
        winRatePct: toPct(readNumber(config.longShortWinRate)),
        costDragPctOfInitialCapital: readNumber(config.routeCostPct) ?? readNumber(routeCost?.pairRoundTripCostPct),
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
        meanIc: readNumber(config.meanIc),
        icIr: readNumber(config.icIr),
        icWinRatePct: toPct(readNumber(config.winRate)),
        signalPeriods: readNumber(config.signalPeriods),
        commonPeriods: readNumber(root.commonPeriods),
        averageLongShortSpreadPct: readNumber(config.averageLongShortSpreadPct),
        longShortWinRatePct: toPct(readNumber(config.longShortWinRate)),
        rankIcWfoStatus: readString(wfo?.status),
        rankIcWfoFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
        rankIcWfoWindowCount: readNumber(wfo?.windowCount),
        rankIcWfoPassedWindows: readNumber(wfo?.passedWindows),
        routeCostValidationStatus: readBool(config.positiveAfterCost) === true
          ? 'positive_after_cost_diagnostic'
          : 'liquidity_conditioned_net_non_positive',
        netAfterRouteCostPct: readNumber(config.netAfterRouteCostPct),
        pairRoundTripCostPct: readNumber(config.routeCostPct) ?? readNumber(routeCost?.pairRoundTripCostPct),
        feeSnapshotSource: readString(routeCost?.source),
        feeSnapshotVerifiedByRuntime: readBool(routeCost?.runtimeVerified),
        feeSnapshotStale: null,
      },
      gates: emptyGates(),
      extraBlockers: [
        ...readStringArray(root.blockers),
        ...readStringArray(config.blockers),
        `liquidity_conditioned_verdict:${readString(config.candidateVerdict) ?? 'missing'}`,
      ],
    })
  })
}

function isRankIcRouteCostArtifact(root: Record<string, unknown>): boolean {
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    readString(root.routeCostValidationStatus) != null &&
    isRecord(root.bestDiagnosticRoute) &&
    isRecord(root.candidate)
}

function isRankIcWalkForwardFilterArtifact(root: Record<string, unknown>): boolean {
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    isRecord(root.trainingPolicy) &&
    Array.isArray(root.candidates) &&
    root.trainingPolicy?.thresholdSource === 'previous_wfo_windows_only'
}

function isRankIcProspectiveLaneArtifact(root: Record<string, unknown>): boolean {
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    root.prospectiveOnly === true &&
    isRecord(root.candidate) &&
    isRecord(root.currentEvidence) &&
    isRecord(root.prospectiveProtocol)
}

function extractRankIcProspectiveLaneRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const candidate = asRecord(root.candidate)
  const evidence = asRecord(root.currentEvidence)
  const protocol = asRecord(root.prospectiveProtocol)
  if (!candidate || !evidence) return []
  return [buildRow({
    sourcePath: path,
    sourceKind: 'cross_sectional_rank_ic_prospective_lane',
    evidenceTier: 'diagnostic_validation',
    generatedAt: readString(root.generatedAt),
    family: 'cross_sectional_rank_ic_prospective_lane',
    strategy: readString(candidate.filterId) ?? 'unknown_filter',
    symbol: 'multi_asset',
    candidateId: readString(candidate.candidateId) ?? 'rank_ic_prospective_lane',
    metrics: {
      totalReturnPct: null,
      netExpectancyPct: readNumber(evidence.netAfterRouteCostPct),
      grossExpectancyPct: readNumber(evidence.averageLongShortSpreadPct),
      profitFactor: null,
      sharpe: null,
      sortino: null,
      maxDrawdownPct: null,
      tradeCount: readNumber(evidence.walkForwardWindowCount),
      winRatePct: null,
      costDragPctOfInitialCapital: null,
      riskProfitProbability: null,
      riskOfRuin: null,
      pbo: null,
      dsrProbability: null,
      fdrQ: null,
      meanIc: readNumber(evidence.meanIc),
      icIr: readNumber(evidence.icIr),
      signalPeriods: readNumber(protocol?.minimumFutureSignalPeriods),
      commonPeriods: null,
      averageLongShortSpreadPct: readNumber(evidence.averageLongShortSpreadPct),
      rankIcWfoStatus: readString(evidence.walkForwardWfoStatus),
      rankIcWfoFailedWindowRatio: readNumber(evidence.walkForwardFailedWindowRatio),
      rankIcWfoWindowCount: readNumber(evidence.walkForwardWindowCount),
      rankIcWfoPassedWindows: readNumber(evidence.walkForwardPassedWindows),
      bestRoute: readString(evidence.route),
      routeCostValidationStatus: 'prospective_lane',
      netAfterRouteCostPct: readNumber(evidence.netAfterRouteCostPct),
      grossToPairCostRatio: readNumber(evidence.grossToPairCostRatio),
      pairRoundTripCostPct: null,
      feeSnapshotSource: readString(evidence.feeSnapshotSource),
      feeSnapshotVerifiedByRuntime: readBool(evidence.feeSnapshotVerifiedByRuntime),
      feeSnapshotStale: null,
    },
    gates: emptyGates(),
    extraBlockers: [
      ...readStringArray(root.blockers),
      'prospective_lane_future_outcomes_required',
    ],
  })]
}

function extractRankIcWalkForwardFilterRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const config = asRecord(root.config)
  const baseline = asRecord(root.baseline)
  const best = asRecord(root.bestWalkForwardCandidate)
  const selected = best ?? baseline
  if (!selected || !config) return []
  const rows = [selected]
  if (best && baseline && best !== baseline) rows.push(baseline)
  return rows.flatMap(candidate => {
    const aggregate = asRecord(candidate.aggregate)
    const wfo = asRecord(candidate.wfo)
    if (!aggregate || !wfo) return []
    const filterId = readString(candidate.filterId) ?? 'unknown_filter'
    const candidateId = [
      'rank_ic_wf_filter',
      filterId,
      readString(config.factor) ?? 'factor',
      `lb${readNumber(config.lookbackHours) ?? 'na'}`,
      `sec${readNumber(config.secondaryLookbackHours) ?? 'na'}`,
      `fwd${readNumber(config.forwardHours) ?? 'na'}`,
      `mtf${readNumber(config.mtfWeight) ?? 'na'}`,
    ].join('_')
    return buildRow({
      sourcePath: path,
      sourceKind: 'cross_sectional_rank_ic_walkforward_filter',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: 'cross_sectional_rank_ic_walkforward_filter',
      strategy: filterId,
      symbol: 'multi_asset',
      candidateId,
      metrics: {
        totalReturnPct: null,
        netExpectancyPct: null,
        grossExpectancyPct: readNumber(aggregate.averageLongShortSpreadPct),
        profitFactor: null,
        sharpe: null,
        sortino: null,
        maxDrawdownPct: null,
        tradeCount: readNumber(aggregate.observations),
        winRatePct: toPct(readNumber(aggregate.winRate)),
        costDragPctOfInitialCapital: null,
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
        meanIc: readNumber(aggregate.meanIc),
        icIr: readNumber(aggregate.icIr),
        icWinRatePct: toPct(readNumber(aggregate.winRate)),
        signalPeriods: readNumber(aggregate.signalPeriods),
        commonPeriods: readNumber(asRecord(root.dataAlignment)?.loadedCommonPeriods),
        averageLongShortSpreadPct: readNumber(aggregate.averageLongShortSpreadPct),
        longShortWinRatePct: toPct(readNumber(aggregate.longShortWinRate)),
        rankIcWfoStatus: readString(wfo.status),
        rankIcWfoFailedWindowRatio: readNumber(wfo.failedWindowRatio),
        rankIcWfoWindowCount: readNumber(wfo.windowCount),
        rankIcWfoPassedWindows: readNumber(wfo.passedWindows),
      },
      gates: emptyGates(),
      extraBlockers: [
        ...readStringArray(root.blockers),
        ...readStringArray(candidate.warnings).map(warning => `walk_forward_warning:${warning}`),
        `walk_forward_verdict:${readString(candidate.diagnosticVerdict) ?? 'missing'}`,
      ],
    })
  })
}

function extractRankIcRouteCostRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const candidate = asRecord(root.candidate)
  const bestRoute = asRecord(root.bestDiagnosticRoute)
  const feeSnapshot = asRecord(root.feeSnapshot)
  if (!candidate || !bestRoute) return []
  const candidateId = readString(candidate.candidateId) ?? 'rank_ic_route_cost_candidate'
  return [buildRow({
    sourcePath: path,
    sourceKind: 'cross_sectional_rank_ic_route_cost',
    evidenceTier: 'diagnostic_validation',
    generatedAt: readString(root.generatedAt),
    family: 'cross_sectional_rank_ic_route_cost',
    strategy: readString(candidate.factor) ?? 'unknown_factor',
    symbol: 'multi_asset',
    candidateId,
    metrics: {
      totalReturnPct: null,
      netExpectancyPct: readNumber(bestRoute.netAfterRouteCostPct),
      grossExpectancyPct: readNumber(bestRoute.grossLongShortSpreadPct),
      profitFactor: null,
      sharpe: null,
      sortino: null,
      maxDrawdownPct: null,
      tradeCount: readNumber(candidate.observations),
      winRatePct: null,
      costDragPctOfInitialCapital: readNumber(bestRoute.pairRoundTripCostPct),
      riskProfitProbability: null,
      riskOfRuin: null,
      pbo: null,
      dsrProbability: null,
      fdrQ: null,
      meanIc: readNumber(candidate.meanIc),
      icIr: readNumber(candidate.icIr),
      signalPeriods: readNumber(candidate.signalPeriods),
      commonPeriods: readNumber(candidate.commonPeriods),
      averageLongShortSpreadPct: readNumber(candidate.averageLongShortSpreadPct),
      rankIcWfoStatus: readString(candidate.wfoStatus),
      bestRoute: readString(bestRoute.route),
      routeCostValidationStatus: readString(root.routeCostValidationStatus),
      netAfterRouteCostPct: readNumber(bestRoute.netAfterRouteCostPct),
      grossToPairCostRatio: readNumber(bestRoute.grossToPairCostRatio),
      pairRoundTripCostPct: readNumber(bestRoute.pairRoundTripCostPct),
      feeSnapshotSource: readString(feeSnapshot?.source),
      feeSnapshotStale: readBool(feeSnapshot?.stale),
      feeSnapshotVerifiedByRuntime: readBool(feeSnapshot?.verifiedByRuntime),
    },
    gates: emptyGates(),
    extraBlockers: readStringArray(root.blockers),
  })]
}

function isRankIcArtifact(root: Record<string, unknown>): boolean {
  if (readString(root.dataDir) == null || !Array.isArray(root.topConfigs)) return false
  return root.researchOnly === true &&
    root.promotionEligible === false &&
    root.topConfigs.some(item => readNumber(asRecord(item)?.meanIc) != null)
}

function extractRankIcRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const configs = Array.isArray(root.topConfigs) ? root.topConfigs : []
  const wfo = asRecord(root.wfo)
  return configs.flatMap((item, index) => {
    const config = asRecord(item)
    if (!config) return []
    const candidateId = [
      `rank_ic_${readString(config.factor) ?? 'factor'}_${index}`,
      `lb${readNumber(config.lookbackHours) ?? 'na'}`,
      `sec${readNumber(config.secondaryLookbackHours) ?? 'na'}`,
      `fwd${readNumber(config.forwardHours) ?? 'na'}`,
      `mtf${readNumber(config.mtfWeight) ?? 'na'}`,
    ].join('_')
    return buildRow({
      sourcePath: path,
      sourceKind: 'cross_sectional_rank_ic',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: 'cross_sectional_rank_ic',
      strategy: readString(config.factor) ?? 'unknown_factor',
      symbol: 'multi_asset',
      candidateId,
      metrics: {
        totalReturnPct: null,
        netExpectancyPct: null,
        grossExpectancyPct: readNumber(config.averageLongShortSpreadPct),
        profitFactor: null,
        sharpe: null,
        sortino: null,
        maxDrawdownPct: null,
        tradeCount: readNumber(config.observations),
        winRatePct: toPct(readNumber(config.winRate)),
        costDragPctOfInitialCapital: null,
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
        meanIc: readNumber(config.meanIc),
        icIr: readNumber(config.icIr),
        icWinRatePct: toPct(readNumber(config.winRate)),
        signalPeriods: readNumber(config.signalPeriods),
        commonPeriods: readNumber(root.commonPeriods),
        averageLongShortSpreadPct: readNumber(config.averageLongShortSpreadPct),
        longShortWinRatePct: toPct(readNumber(config.longShortWinRate)),
        rankIcWfoStatus: readString(wfo?.status),
        rankIcWfoFailedWindowRatio: readNumber(wfo?.failedWindowRatio),
        rankIcWfoWindowCount: readNumber(wfo?.windowCount),
        rankIcWfoPassedWindows: readNumber(wfo?.passedWindows),
      },
      gates: emptyGates(),
      extraBlockers: buildRankIcExtraBlockers(root),
    })
  })
}

function buildRankIcExtraBlockers(root: Record<string, unknown>): string[] {
  const blockers = [...readStringArray(root.blockers)]
  const wfo = asRecord(root.wfo)
  if (!wfo) {
    blockers.push('rank_ic_wfo_missing')
    return uniqueStrings(blockers)
  }
  const status = readString(wfo.status)
  const windowCount = readNumber(wfo.windowCount)
  const failedWindowRatio = readNumber(wfo.failedWindowRatio)
  const threshold = readNumber(wfo.failWindowRatioThreshold) ?? 0.3
  const minWindows = readNumber(wfo.minWindows) ?? 3
  const minTotalPeriods = readNumber(wfo.minTotalPeriods) ?? 30
  const minTotalSignalPeriods = readNumber(wfo.minTotalSignalPeriods) ?? 30
  const best = asRecord(root.best)
  const periods = readNumber(best?.periods)
  const signalPeriods = readNumber(best?.signalPeriods)
  if (status && status !== 'pass') blockers.push(`rank_ic_wfo_status:${status}`)
  if ((periods ?? 0) < minTotalPeriods) {
    blockers.push(`rank_ic_wfo_total_periods_low:${periods ?? 0}<${minTotalPeriods}`)
  }
  if ((signalPeriods ?? 0) < minTotalSignalPeriods) {
    blockers.push(`rank_ic_wfo_total_signal_periods_low:${signalPeriods ?? 0}<${minTotalSignalPeriods}`)
  }
  if ((windowCount ?? 0) < minWindows) blockers.push(`rank_ic_wfo_windows_low:${windowCount ?? 0}<${minWindows}`)
  if (failedWindowRatio != null && failedWindowRatio > threshold) {
    blockers.push(`rank_ic_wfo_failed_window_ratio:${round(failedWindowRatio, 6)}>${threshold}`)
  }
  blockers.push(...readStringArray(wfo.blockers).map(blocker => `rank_ic_${blocker}`))
  return uniqueStrings(blockers)
}

function extractValidationRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const rows: ResearchCandidateRow[] = []
  const selectedMetrics = asRecord(root.selectedMetrics)
  if (selectedMetrics) {
    rows.push(buildRow({
      sourcePath: path,
      sourceKind: 'validation_selected',
      evidenceTier: 'release_validated',
      generatedAt: readString(root.generatedAt),
      family: readString(asRecord(root.input)?.family) ?? inferFamily(path),
      strategy: readString(asRecord(root.input)?.strategy) ?? inferFamily(path),
      symbol: readString(asRecord(root.input)?.symbol) ?? readString(asRecord(root.input)?.pairSymbol) ?? inferSymbol(path),
      candidateId: readString(asRecord(root.selectedParams)?.id) ??
        readString(asRecord(root.recommendedCandidate)?.id) ??
        'selected',
      metrics: extractMetrics(selectedMetrics, root),
      gates: extractGates(root),
    }))
  }

  const candidateMetrics = Array.isArray(root.candidateMetrics) ? root.candidateMetrics : []
  for (const [index, item] of candidateMetrics.entries()) {
    const candidate = asRecord(item)
    const metrics = asRecord(candidate?.metrics)
    if (!candidate || !metrics) continue
    const params = asRecord(candidate.params)
    rows.push(buildRow({
      sourcePath: path,
      sourceKind: 'validation_candidate_metric',
      evidenceTier: 'release_validated',
      generatedAt: readString(root.generatedAt),
      family: readString(asRecord(root.input)?.family) ?? inferFamily(path),
      strategy: readString(asRecord(root.input)?.strategy) ?? inferFamily(path),
      symbol: readString(asRecord(root.input)?.symbol) ?? inferSymbol(path),
      candidateId: readString(params?.id) ?? readString(candidate.candidateId) ?? `candidate_${index}`,
      metrics: extractMetrics(metrics, root),
      gates: extractGates(root),
    }))
  }

  const scoreboard = asRecord(root.canonicalScoreboard)
  const selected = asRecord(scoreboard?.selectedCandidate)
  const selectedScoreMetrics = asRecord(selected?.metrics)
  if (selectedScoreMetrics) {
    rows.push(buildRow({
      sourcePath: path,
      sourceKind: 'canonical_scoreboard_selected',
      evidenceTier: 'release_validated',
      generatedAt: readString(root.generatedAt),
      family: inferFamily(path),
      strategy: readString(selected?.strategy) ?? inferFamily(path),
      symbol: readString(selected?.symbol) ?? inferSymbol(path),
      candidateId: readString(selected?.candidateId) ?? readString(selected?.id) ?? 'scoreboard_selected',
      metrics: extractMetrics(selectedScoreMetrics, root),
      gates: extractGates(root),
    }))
  }

  return rows
}

function extractNewStrategyRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const rows: ResearchCandidateRow[] = []
  const strategies = Array.isArray(root.strategies) ? root.strategies : []
  for (const [index, item] of strategies.entries()) {
    const strategy = asRecord(item)
    if (!strategy) continue
    rows.push(buildRow({
      sourcePath: path,
      sourceKind: 'new_strategy_diagnostic',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: readString(strategy.strategy) ?? 'new_strategies',
      strategy: readString(strategy.strategy) ?? 'unknown',
      symbol: readString(strategy.symbol) ?? 'UNKNOWN',
      candidateId: readString(strategy.candidateId) ?? `${readString(strategy.strategy) ?? 'strategy'}_${index}`,
      metrics: extractMetrics(strategy, root),
      gates: emptyGates(),
    }))
  }

  const crossSectional = asRecord(root.crossSectionalMomentum)
  if (crossSectional) {
    rows.push(buildRow({
      sourcePath: path,
      sourceKind: 'cross_sectional_momentum_diagnostic',
      evidenceTier: 'diagnostic_validation',
      generatedAt: readString(root.generatedAt),
      family: 'cross_sectional_momentum',
      strategy: 'cross_sectional_momentum',
      symbol: 'multi_asset',
      candidateId: 'cross_sectional_momentum_summary',
      metrics: {
        totalReturnPct: readNumber(crossSectional.spreadReturnPct),
        netExpectancyPct: readNumber(crossSectional.averageRankSpread),
        grossExpectancyPct: readNumber(crossSectional.averageRankSpread),
        profitFactor: null,
        sharpe: null,
        sortino: null,
        maxDrawdownPct: null,
        tradeCount: readNumber(crossSectional.totalPeriods),
        winRatePct: readNumber(crossSectional.winRate),
        costDragPctOfInitialCapital: null,
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
      },
      gates: emptyGates(),
    }))
  }

  return rows
}

function extractOptimizationRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const rows: ResearchCandidateRow[] = []
  const topConfigs = Array.isArray(root.topConfigs) ? root.topConfigs : []
  for (const [index, item] of topConfigs.entries()) {
    const config = asRecord(item)
    if (!config) continue
    rows.push(buildOptimizationRow(path, root, config, `top_config_${index}`))
  }

  const summary = asRecord(root.summary)
  for (const key of ['bestWR', 'bestSpread', 'bestSharpe']) {
    const config = asRecord(summary?.[key])
    if (config) rows.push(buildOptimizationRow(path, root, config, key))
  }
  return rows
}

function buildOptimizationRow(
  path: string,
  root: Record<string, unknown>,
  config: Record<string, unknown>,
  id: string,
): ResearchCandidateRow {
  const candidateId = [
    id,
    `lb${readNumber(config.lookbackHours) ?? 'na'}`,
    `fwd${readNumber(config.forwardHours) ?? 'na'}`,
    `w${readNumber(config.mtfWeight) ?? 'na'}`,
  ].join('_')
  return buildRow({
    sourcePath: path,
    sourceKind: 'optimization_sweep',
    evidenceTier: 'optimization_prevalidation',
    generatedAt: readString(root.generatedAt),
    family: 'cross_sectional_optimization',
    strategy: 'cross_sectional_reversal',
    symbol: 'multi_asset',
    candidateId,
    metrics: {
      totalReturnPct: readNumber(config.spreadCum),
      netExpectancyPct: readNumber(config.avgSpread),
      grossExpectancyPct: readNumber(config.avgSpread),
      profitFactor: null,
      sharpe: readNumber(config.sharpeApprox),
      sortino: null,
      maxDrawdownPct: null,
      tradeCount: readNumber(config.signals),
      winRatePct: readNumber(config.winRate),
      costDragPctOfInitialCapital: null,
      riskProfitProbability: null,
      riskOfRuin: null,
      pbo: null,
      dsrProbability: null,
      fdrQ: null,
    },
    gates: emptyGates(),
  })
}

function extractRiskRows(path: string, root: Record<string, unknown>): ResearchCandidateRow[] {
  const strategies = Array.isArray(root.strategies) ? root.strategies : []
  return strategies.flatMap((item, index) => {
    const strategy = asRecord(item)
    if (!strategy) return []
    return buildRow({
      sourcePath: path,
      sourceKind: 'risk_diagnostic',
      evidenceTier: 'risk_diagnostic',
      generatedAt: readString(root.generatedAt),
      family: readString(strategy.strategyName) ?? 'risk_analysis',
      strategy: readString(strategy.strategyName) ?? 'unknown',
      symbol: readString(strategy.symbol) ?? 'UNKNOWN',
      candidateId: readString(strategy.candidateId) ?? `risk_${index}`,
      metrics: {
        totalReturnPct: readNumber(strategy.totalReturnPct),
        netExpectancyPct: null,
        grossExpectancyPct: null,
        profitFactor: readNumber(strategy.payoffRatio),
        sharpe: null,
        sortino: null,
        maxDrawdownPct: readNumber(strategy.maxDrawdownPct),
        tradeCount: readNumber(strategy.trades),
        winRatePct: readNumber(strategy.winRate),
        costDragPctOfInitialCapital: null,
        riskProfitProbability: null,
        riskOfRuin: null,
        pbo: null,
        dsrProbability: null,
        fdrQ: null,
      },
      gates: emptyGates(),
    })
  })
}

function buildRow(input: {
  sourcePath: string
  sourceKind: string
  evidenceTier: EvidenceTier
  generatedAt: string | null
  family: string
  strategy: string
  symbol: string
  candidateId: string
  metrics: CandidateMetricsSummary
  gates: ResearchCandidateRow['gates']
  extraBlockers?: string[]
}): ResearchCandidateRow {
  const whyNotTradable = buildBlockers(input, input.extraBlockers ?? [])
  const status = computeStatus(input.evidenceTier, input.gates, whyNotTradable)
  const score = scoreCandidate(input.metrics, input.gates, input.evidenceTier)
  const candidateKey = sha256Hex([
    input.sourcePath,
    input.sourceKind,
    input.family,
    input.strategy,
    input.symbol,
    input.candidateId,
  ].join('|')).slice(0, 16)

  return {
    rank: 0,
    candidateKey,
    sourcePath: input.sourcePath,
    sourceKind: input.sourceKind,
    evidenceTier: input.evidenceTier,
    generatedAt: input.generatedAt,
    family: input.family,
    strategy: input.strategy,
    symbol: input.symbol,
    candidateId: input.candidateId,
    status,
    researchScore: round(score, 4),
    metrics: input.metrics,
    gates: input.gates,
    whyNotTradable,
    nextAction: chooseNextAction(input, whyNotTradable),
  }
}

function extractMetrics(
  metrics: Record<string, unknown>,
  root: Record<string, unknown>,
): CandidateMetricsSummary {
  const significance = asRecord(root.significance)
  const dsrResult = asRecord(significance?.dsrResult)
  const pboResult = asRecord(significance?.pboResult)
  const risk = asRecord(root.riskSimulation)
  const baseline = asRecord(metrics.baselineReport)
  const expectancy = asRecord(baseline?.expectancyAfterCost)
  return {
    totalReturnPct: readNumber(metrics.totalReturnPct),
    netExpectancyPct: readNumber(metrics.netExpectancyPct) ?? readNumber(expectancy?.netExpectancyPct),
    grossExpectancyPct: readNumber(metrics.grossExpectancyPct) ?? readNumber(expectancy?.grossExpectancyPct),
    profitFactor: readNumber(metrics.profitFactor),
    sharpe: readNumber(metrics.sharpe),
    sortino: readNumber(metrics.sortino),
    maxDrawdownPct: readNumber(metrics.maxDrawdownPct),
    tradeCount: readNumber(metrics.tradeCount) ?? readNumber(metrics.trades),
    winRatePct: readNumber(metrics.winRatePct) ?? readNumber(metrics.winRate),
    costDragPctOfInitialCapital: readNumber(metrics.costDragPctOfInitialCapital),
    riskProfitProbability: readNumber(risk?.profitProbability),
    riskOfRuin: readNumber(risk?.riskOfRuin),
    pbo: readNumber(significance?.pbo) ?? readNumber(pboResult?.pbo),
    dsrProbability: readNumber(significance?.dsrProbability) ?? readNumber(dsrResult?.dsrProbability),
    fdrQ: readNumber(significance?.fdrQ),
  }
}

function extractGates(root: Record<string, unknown>): ResearchCandidateRow['gates'] {
  const releaseGate = asRecord(root.releaseGate)
  const checks = Array.isArray(releaseGate?.checks)
    ? releaseGate.checks.map(asRecord).filter((value): value is Record<string, unknown> => Boolean(value))
    : []
  const wfoCheck = checks.find(check => check.name === 'wfo')
  const sigCheck = checks.find(check => check.name === 'significance')
  const riskCheck = checks.find(check => check.name === 'risk_simulation')
  const wfo = asRecord(root.wfo)
  const significance = asRecord(root.significance)
  const riskSimulation = asRecord(root.riskSimulation)
  return {
    releaseGatePresent: releaseGate != null,
    allowPaperTrading: releaseGate?.allowPaperTrading === true,
    allowLiveTrading: releaseGate?.allowLiveTrading === true,
    failedChecks: readStringArray(releaseGate?.failedChecks),
    wfoPassed: readBool(readNested(asRecord(wfoCheck?.metrics), ['overallPassed'])) ??
      readBool(wfo?.overallPassed) ??
      readBool(wfo?.passed),
    significancePassed: readBool(sigCheck?.status === 'pass' ? true : sigCheck?.status === 'fail' ? false : null) ??
      readBool(significance?.passed),
    riskSimulationPassed: readBool(riskCheck?.status === 'pass' ? true : riskCheck?.status === 'fail' ? false : null) ??
      readBool(riskSimulation?.gatePassed),
  }
}

function emptyGates(): ResearchCandidateRow['gates'] {
  return {
    releaseGatePresent: false,
    allowPaperTrading: false,
    allowLiveTrading: false,
    failedChecks: [],
    wfoPassed: null,
    significancePassed: null,
    riskSimulationPassed: null,
  }
}

function buildBlockers(input: {
  evidenceTier: EvidenceTier
  metrics: CandidateMetricsSummary
  gates: ResearchCandidateRow['gates']
}, extraBlockers: string[] = []): string[] {
  const blockers: string[] = []
  blockers.push(...extraBlockers)
  if (input.evidenceTier !== 'release_validated') blockers.push('not_release_validated')
  if (!input.gates.releaseGatePresent) blockers.push('release_gate_missing')
  if (input.gates.releaseGatePresent && !input.gates.allowPaperTrading) blockers.push('release_gate_blocks_paper')
  for (const check of input.gates.failedChecks) blockers.push(`failed_check:${check}`)
  if (input.gates.wfoPassed === false) blockers.push('wfo_failed')
  if (input.gates.significancePassed === false) blockers.push('significance_failed')
  if (input.gates.riskSimulationPassed === false) blockers.push('risk_simulation_failed')
  if ((input.metrics.netExpectancyPct ?? 0) <= 0) blockers.push('net_expectancy_non_positive')
  if ((input.metrics.tradeCount ?? 0) < 30) blockers.push(`low_trade_count:${input.metrics.tradeCount ?? 0}<30`)
  if ((input.metrics.riskProfitProbability ?? 1) < 0.55) blockers.push('risk_profit_probability_below_55pct')
  if ((input.metrics.dsrProbability ?? 1) < 0.95) blockers.push('dsr_probability_below_95pct')
  if (input.metrics.fdrQ == null && input.evidenceTier === 'release_validated') blockers.push('fdr_missing')
  if (input.metrics.meanIc != null) {
    if ((input.metrics.commonPeriods ?? 0) < 1_000) blockers.push(`rank_ic_common_periods_low:${input.metrics.commonPeriods ?? 0}<1000`)
    if ((input.metrics.signalPeriods ?? 0) < 30) blockers.push(`rank_ic_signal_periods_low:${input.metrics.signalPeriods ?? 0}<30`)
    if ((input.metrics.icIr ?? 0) < 1) blockers.push(`rank_ic_ir_low:${input.metrics.icIr ?? 0}<1`)
    if (input.metrics.longShortWinRatePct != null && input.metrics.longShortWinRatePct < 50) {
      blockers.push(`rank_ic_long_short_win_rate_low:${input.metrics.longShortWinRatePct}<50`)
    }
    if (input.metrics.rankIcWfoStatus == null) blockers.push('rank_ic_wfo_missing')
    if (input.metrics.rankIcWfoStatus != null && input.metrics.rankIcWfoStatus !== 'pass') {
      blockers.push(`rank_ic_wfo_status:${input.metrics.rankIcWfoStatus}`)
    }
    if (input.metrics.rankIcWfoWindowCount != null && input.metrics.rankIcWfoWindowCount < 3) {
      blockers.push(`rank_ic_wfo_windows_low:${input.metrics.rankIcWfoWindowCount}<3`)
    }
    if ((input.metrics.commonPeriods ?? 0) < 1_000 && (input.metrics.signalPeriods ?? 0) < 30) {
      blockers.push(`rank_ic_wfo_total_signal_periods_low:${input.metrics.signalPeriods ?? 0}<30`)
    }
    if ((input.metrics.rankIcWfoFailedWindowRatio ?? 0) > 0.3) {
      blockers.push(`rank_ic_wfo_failed_window_ratio:${round(input.metrics.rankIcWfoFailedWindowRatio ?? 0, 6)}>0.3`)
    }
  }
  if (input.metrics.routeCostValidationStatus != null) {
    if (input.metrics.routeCostValidationStatus !== 'positive_after_cost_diagnostic') {
      blockers.push(`route_cost_validation_status:${input.metrics.routeCostValidationStatus}`)
    }
    if ((input.metrics.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) <= 0) {
      blockers.push(`route_cost_net_after_cost_non_positive:${input.metrics.netAfterRouteCostPct ?? 'missing'}`)
    }
    if (input.metrics.feeSnapshotStale === true) blockers.push('fee_snapshot_stale')
    if (input.metrics.feeSnapshotSource === 'manual_override') blockers.push('fee_snapshot_manual_override')
    if (input.metrics.feeSnapshotVerifiedByRuntime !== true) blockers.push('fee_snapshot_not_runtime_verified')
  }
  return uniqueStrings(blockers)
}

function computeStatus(
  evidenceTier: EvidenceTier,
  gates: ResearchCandidateRow['gates'],
  whyNotTradable: string[],
): CandidateStatus {
  if (gates.allowPaperTrading && whyNotTradable.length === 0) return 'paper_candidate_observed'
  if (evidenceTier === 'optimization_prevalidation') return 'prevalidation_only'
  if (evidenceTier === 'diagnostic_validation' || evidenceTier === 'risk_diagnostic') return 'diagnostic_only'
  return 'research_only_blocked'
}

function scoreCandidate(
  metrics: CandidateMetricsSummary,
  gates: ResearchCandidateRow['gates'],
  evidenceTier: EvidenceTier,
): number {
  let score = 0
  score += clamp(metrics.totalReturnPct ?? 0, -20, 20) * 0.6
  score += clamp(metrics.netExpectancyPct ?? 0, -1, 1) * 35
  score += clamp(metrics.grossExpectancyPct ?? 0, -1, 1) * 10
  score += clamp(metrics.sharpe ?? 0, -5, 5) * 4
  score += clamp(((metrics.winRatePct ?? 50) - 50) / 5, -5, 5)
  score -= clamp(metrics.maxDrawdownPct ?? 0, 0, 50) * 0.25
  score -= clamp(metrics.costDragPctOfInitialCapital ?? 0, 0, 20) * 0.5

  const trades = metrics.tradeCount ?? 0
  if (trades >= 100) score += 4
  else if (trades >= 30) score += 1
  else if (trades > 0) score -= 5
  else score -= 8

  if (gates.wfoPassed === true) score += 10
  if (gates.wfoPassed === false) score -= 10
  if (gates.significancePassed === true) score += 6
  if (gates.significancePassed === false) score -= 6
  if (gates.riskSimulationPassed === true) score += 4
  if (gates.riskSimulationPassed === false) score -= 4
  if (gates.allowPaperTrading) score += 20
  if (gates.releaseGatePresent && !gates.allowPaperTrading) score -= 5

  if (metrics.dsrProbability != null) score += clamp((metrics.dsrProbability - 0.5) * 10, -6, 6)
  if (metrics.pbo != null) score -= clamp(metrics.pbo * 8, 0, 8)
  if (metrics.riskProfitProbability != null) score += clamp((metrics.riskProfitProbability - 0.5) * 10, -5, 5)

  if (evidenceTier === 'optimization_prevalidation') score -= 6
  if (evidenceTier === 'diagnostic_validation') score -= 3
  if (evidenceTier === 'risk_diagnostic') score -= 8
  return score
}

function chooseNextAction(
  input: {
    evidenceTier: EvidenceTier
    family: string
    strategy: string
    metrics: CandidateMetricsSummary
    gates: ResearchCandidateRow['gates']
  },
  blockers: string[],
): string {
  const name = `${input.family} ${input.strategy}`.toLowerCase()
  if (input.metrics.meanIc != null) {
    const wfoStatus = input.metrics.rankIcWfoStatus ?? 'missing'
    if (input.metrics.routeCostValidationStatus != null) {
      const feeAction = input.metrics.feeSnapshotVerifiedByRuntime === true && input.metrics.feeSnapshotStale !== true
        ? 'Keep runtime fees fresh and complete trial ledger before any paper execution.'
        : 'Replace stale/manual fees and complete trial ledger before any paper execution.'
      return `Treat as route-cost diagnostic only: bestRoute=${input.metrics.bestRoute ?? 'missing'}, netAfterRouteCostPct=${formatMaybe(input.metrics.netAfterRouteCostPct ?? null)}, feeSnapshot=${input.metrics.feeSnapshotSource ?? 'missing'}, internalWFO=${wfoStatus}. ${feeAction}`
    }
    return 'Treat as a money-smell only: run WFO/CPCV, route-cost validation, and a complete trial ledger before any paper execution.'
      + ` Current internal RankIC WFO status=${wfoStatus}.`
  }
  if (input.evidenceTier === 'optimization_prevalidation') {
    return 'Re-run this config through release validation with WFO, trial ledger, BY FDR, PIT audit, and route-cost economics.'
  }
  if (name.includes('cross') && blockers.includes('not_release_validated')) {
    return 'Build true cross-sectional RankIC and validate the runtime-sized low-turnover reversal config before any execution work.'
  }
  if (name.includes('cross') && blockers.some(value => value.includes('economics') || value.includes('net_expectancy'))) {
    return 'Reduce turnover, narrow the universe, and re-score post-cost before spending on execution plumbing.'
  }
  if (name.includes('carry')) {
    return 'Keep research-only; rebuild carry accounting and require positive gross edge before tuning execution.'
  }
  if (name.includes('breakout') || name.includes('liquidation')) {
    return 'Run symbol/liquidity/spread gated validation and verify stop-loss and holding-expired attribution.'
  }
  if (blockers.includes('wfo_failed')) {
    return 'Mutate the strategy around the failed WFO window and rerun validation; do not change thresholds.'
  }
  if (blockers.includes('fdr_missing')) {
    return 'Register the full trial universe including failed trials, then compute promotion-grade BY FDR.'
  }
  if ((input.metrics.netExpectancyPct ?? 0) > 0 && (input.metrics.tradeCount ?? 0) >= 30) {
    return 'Promote only to the next research review pack: add PIT rows, complete trial ledger, and route-cost validation.'
  }
  return 'Treat as research-only and either gather cleaner evidence or retire if repeated windows stay negative.'
}

function buildFocusRecommendations(rows: ResearchCandidateRow[]): string[] {
  const validated = rows.filter(row => row.evidenceTier === 'release_validated')
  const liveRankIcRows = rows.filter(row =>
    row.sourceKind === 'cross_sectional_rank_ic' &&
    isLiveAccumulatedDiagnostic(row) &&
    (row.metrics.meanIc ?? 0) > 0 &&
    (row.metrics.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) > 0,
  )
  const liveRankIcCostCandidate = newestRow(rows.filter(row =>
    row.sourceKind === 'cross_sectional_rank_ic_route_cost' &&
    isLiveAccumulatedDiagnostic(row),
  ))
  const liveWalkForwardFilterCandidate = newestRow(rows.filter(row =>
    row.sourceKind === 'cross_sectional_rank_ic_walkforward_filter' &&
    isLiveAccumulatedDiagnostic(row) &&
    row.candidateId.includes('rank_ic_wf_filter') &&
    !row.candidateId.includes('_no_filter_'),
  ))
  const liveProspectiveLane = newestRow(rows.filter(row =>
    row.sourceKind === 'cross_sectional_rank_ic_prospective_lane' &&
    isLiveAccumulatedDiagnostic(row),
  ))
  const liveFiveMinuteRankIcCostCandidate = newestRow(rows.filter(row =>
    row.sourceKind === 'cross_sectional_rank_ic_route_cost' &&
    isLiveFiveMinuteDiagnostic(row),
  ))
  const liveLiquidityConditionedFactor = newestRow(rows.filter(row =>
    row.sourceKind === 'liquidity_conditioned_factor' &&
    isLiveAccumulatedDiagnostic(row),
  ))
  const liveCryptoFactorFamily = newestRow(rows.filter(row =>
    row.sourceKind === 'crypto_factor_family' &&
    isLiveAccumulatedDiagnostic(row),
  ))
  const liveRankIcCandidate = findMatchingRankIcRow(liveRankIcRows, liveRankIcCostCandidate) ??
    bestRankIcDiagnosticRow(liveRankIcRows)
  const crossPrevalidation = rows.find(row =>
    row.family.includes('cross_sectional') &&
    row.evidenceTier === 'optimization_prevalidation' &&
    (row.metrics.netExpectancyPct ?? 0) > 0,
  )
  const rankIcCandidate = rows.find(row =>
    row.sourceKind === 'cross_sectional_rank_ic' &&
    (row.metrics.meanIc ?? 0) > 0 &&
    (row.metrics.icIr ?? 0) > 1,
  )
  const rankIcCostCandidate = rows.find(row =>
    row.sourceKind === 'cross_sectional_rank_ic_route_cost' &&
    (row.metrics.netAfterRouteCostPct ?? Number.NEGATIVE_INFINITY) > 0,
  )
  const grossFragile = rows.find(row =>
    (row.metrics.grossExpectancyPct ?? Number.NEGATIVE_INFINITY) > 0 &&
    (row.metrics.netExpectancyPct ?? 0) <= 0,
  )
  const recommendations: string[] = []

  if (liveRankIcCandidate) {
    const wfoStatus = liveRankIcCandidate.metrics.rankIcWfoStatus ?? 'missing'
    recommendations.push(
      `Latest live RankIC diagnostic: ${liveRankIcCandidate.candidateId}; meanIC=${formatMaybe(liveRankIcCandidate.metrics.meanIc ?? null)}, IC_IR=${formatMaybe(liveRankIcCandidate.metrics.icIr ?? null)}, internalWFO=${wfoStatus}, blockers=${liveRankIcCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveRankIcCostCandidate) {
    recommendations.push(
      `Latest live route-cost diagnostic: ${liveRankIcCostCandidate.candidateId} bestRoute=${liveRankIcCostCandidate.metrics.bestRoute ?? 'missing'} netAfterRouteCostPct=${formatMaybe(liveRankIcCostCandidate.metrics.netAfterRouteCostPct ?? null)}, but blockers=${liveRankIcCostCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveWalkForwardFilterCandidate) {
    recommendations.push(
      `Latest live walk-forward filter diagnostic: ${liveWalkForwardFilterCandidate.candidateId}; meanIC=${formatMaybe(liveWalkForwardFilterCandidate.metrics.meanIc ?? null)}, IC_IR=${formatMaybe(liveWalkForwardFilterCandidate.metrics.icIr ?? null)}, WFO=${liveWalkForwardFilterCandidate.metrics.rankIcWfoStatus ?? 'missing'}, passWindows=${formatMaybe(liveWalkForwardFilterCandidate.metrics.rankIcWfoPassedWindows ?? null)}/${formatMaybe(liveWalkForwardFilterCandidate.metrics.rankIcWfoWindowCount ?? null)}, blockers=${liveWalkForwardFilterCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveProspectiveLane) {
    recommendations.push(
      `Prospective trial lane ready for future collection: ${liveProspectiveLane.candidateId}; netAfterRouteCostPct=${formatMaybe(liveProspectiveLane.metrics.netAfterRouteCostPct ?? null)}, WFO=${liveProspectiveLane.metrics.rankIcWfoStatus ?? 'missing'}, blockers=${liveProspectiveLane.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveFiveMinuteRankIcCostCandidate) {
    recommendations.push(
      `Latest 5m acceleration diagnostic: ${liveFiveMinuteRankIcCostCandidate.candidateId} bestRoute=${liveFiveMinuteRankIcCostCandidate.metrics.bestRoute ?? 'missing'} netAfterRouteCostPct=${formatMaybe(liveFiveMinuteRankIcCostCandidate.metrics.netAfterRouteCostPct ?? null)}, research-only blockers=${liveFiveMinuteRankIcCostCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveLiquidityConditionedFactor) {
    recommendations.push(
      `Liquidity-conditioned pivot candidate: ${liveLiquidityConditionedFactor.candidateId}; netAfterRouteCostPct=${formatMaybe(liveLiquidityConditionedFactor.metrics.netAfterRouteCostPct ?? null)}, WFO=${liveLiquidityConditionedFactor.metrics.rankIcWfoStatus ?? 'missing'}, failedWindowRatio=${formatMaybe(liveLiquidityConditionedFactor.metrics.rankIcWfoFailedWindowRatio ?? null)}, blockers=${liveLiquidityConditionedFactor.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (liveCryptoFactorFamily) {
    recommendations.push(
      `Base crypto factor-family diagnostic: ${liveCryptoFactorFamily.candidateId}; factor=${liveCryptoFactorFamily.strategy}, netAfterRouteCostPct=${formatMaybe(liveCryptoFactorFamily.metrics.netAfterRouteCostPct ?? null)}, WFO=${liveCryptoFactorFamily.metrics.rankIcWfoStatus ?? 'missing'}, failedWindowRatio=${formatMaybe(liveCryptoFactorFamily.metrics.rankIcWfoFailedWindowRatio ?? null)}, blockers=${liveCryptoFactorFamily.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (rankIcCandidate && !sameCandidate(rankIcCandidate, liveRankIcCandidate)) {
    const wfoStatus = rankIcCandidate.metrics.rankIcWfoStatus ?? 'missing'
    recommendations.push(
      `First money-focused experiment: validate current RankIC money-smell ${rankIcCandidate.candidateId}; meanIC=${formatMaybe(rankIcCandidate.metrics.meanIc ?? null)}, IC_IR=${formatMaybe(rankIcCandidate.metrics.icIr ?? null)}, internalWFO=${wfoStatus}, blockers=${rankIcCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (rankIcCostCandidate && !sameCandidate(rankIcCostCandidate, liveRankIcCostCandidate)) {
    recommendations.push(
      `Route-cost diagnostic: ${rankIcCostCandidate.candidateId} bestRoute=${rankIcCostCandidate.metrics.bestRoute ?? 'missing'} netAfterRouteCostPct=${formatMaybe(rankIcCostCandidate.metrics.netAfterRouteCostPct ?? null)}, but blockers=${rankIcCostCandidate.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  if (crossPrevalidation) {
    recommendations.push(
      `Legacy optimization follow-up: re-run ${crossPrevalidation.candidateId} through true cross-sectional RankIC, WFO, trial ledger, and route-cost validation because it is prevalidation-only, not executable.`,
    )
  }
  if (grossFragile) {
    recommendations.push(
      `Cost choke point: ${grossFragile.family}/${grossFragile.candidateId} has gross edge that does not survive net checks; prioritize turnover and route-cost reduction before model complexity.`,
    )
  }
  const bestValidated = validated[0]
  if (bestValidated) {
    recommendations.push(
      `Best release-validated row is still ${bestValidated.status}: ${bestValidated.family}/${bestValidated.candidateId}, blockers=${bestValidated.whyNotTradable.slice(0, 5).join('|') || 'none'}.`,
    )
  }
  recommendations.push(
    'Do not enable paper/live from this report; use it to choose the next validation run and kill weak families faster.',
  )
  return recommendations
}

function findMatchingRankIcRow(
  rows: ResearchCandidateRow[],
  routeCostCandidate: ResearchCandidateRow | null,
): ResearchCandidateRow | null {
  const signature = routeCostCandidate ? rankIcCandidateSignature(routeCostCandidate.candidateId) : null
  if (!signature) return null
  return bestRankIcDiagnosticRow(rows.filter(row => rankIcCandidateSignature(row.candidateId) === signature))
}

function sameCandidate(left: ResearchCandidateRow | null, right: ResearchCandidateRow | null): boolean {
  if (!left || !right) return false
  if (left.candidateKey === right.candidateKey || left.candidateId === right.candidateId) return true
  const leftSignature = rankIcCandidateSignature(left.candidateId)
  const rightSignature = rankIcCandidateSignature(right.candidateId)
  return leftSignature != null && leftSignature === rightSignature
}

function bestRankIcDiagnosticRow(rows: ResearchCandidateRow[]): ResearchCandidateRow | null {
  return [...rows].sort((left, right) => {
    const leftTime = Date.parse(left.generatedAt ?? '')
    const rightTime = Date.parse(right.generatedAt ?? '')
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0) ||
      (right.metrics.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) -
        (left.metrics.averageLongShortSpreadPct ?? Number.NEGATIVE_INFINITY) ||
      (right.metrics.icIr ?? Number.NEGATIVE_INFINITY) - (left.metrics.icIr ?? Number.NEGATIVE_INFINITY) ||
      right.researchScore - left.researchScore
  })[0] ?? null
}

function rankIcCandidateSignature(candidateId: string): string | null {
  const match = candidateId.match(/^rank_ic_(.+)_(?:best|\d+)_lb([^_]+)_sec([^_]+)_fwd([^_]+)_mtf(.+)$/)
  if (!match) return null
  const [, factor, lookback, secondaryLookback, forward, mtfWeight] = match
  return [
    factor,
    `lb${lookback}`,
    `sec${secondaryLookback}`,
    `fwd${forward}`,
    `mtf${mtfWeight}`,
  ].join('|')
}

function isLiveAccumulatedDiagnostic(row: ResearchCandidateRow): boolean {
  return row.sourcePath.includes('live_accumulated')
}

function isLiveFiveMinuteDiagnostic(row: ResearchCandidateRow): boolean {
  return row.sourcePath.includes('live_5m')
}

function newestRow(rows: ResearchCandidateRow[]): ResearchCandidateRow | null {
  return [...rows].sort((left, right) => {
    const leftTime = Date.parse(left.generatedAt ?? '')
    const rightTime = Date.parse(right.generatedAt ?? '')
    return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0) ||
      right.researchScore - left.researchScore
  })[0] ?? null
}

function isValidationArtifact(path: string, root: Record<string, unknown>): boolean {
  return path.endsWith('.validation.json') ||
    path.endsWith('current_btc_runtime_validation.json') ||
    root.selectedMetrics != null ||
    root.candidateMetrics != null ||
    root.releaseGate != null
}

async function loadResearchArtifacts(researchRoot: string): Promise<ResearchArtifactFile[]> {
  if (!existsSync(researchRoot)) return []
  const paths = await walkJsonFiles(researchRoot)
  const files: ResearchArtifactFile[] = []
  for (const path of paths) {
    if (!isCandidateArtifactPath(path)) continue
    try {
      files.push({
        path,
        value: JSON.parse(await readFile(path, 'utf-8')),
      })
    } catch {
      // Skip malformed or partial artifacts; this summarizer is diagnostic.
    }
  }
  return files
}

async function walkJsonFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function visit(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
      } else if (entry.isFile() && path.endsWith('.json') && !path.endsWith('.manifest.json')) {
        const info = await stat(path)
        if (info.size <= 25_000_000) out.push(path)
      }
    }
  }
  await visit(root)
  return out.sort((a, b) => a.localeCompare(b))
}

function isCandidateArtifactPath(path: string): boolean {
  const fileName = path.replaceAll('\\', '/').split('/').pop() ?? ''
  return path.endsWith('.validation.json') ||
    path.endsWith('current_btc_runtime_validation.json') ||
    /^crypto_factor_family(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    /^liquidity_conditioned_factor_report(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    /^cross_sectional_rank_ic(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    /^rank_ic_route_cost_validation(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    /^rank_ic_walkforward_filter_validation(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    /^rank_ic_prospective_trial_lane(?:\.[A-Za-z0-9_-]+)*\.latest\.json$/.test(fileName) ||
    path.includes('/new_strategies_validation/') ||
    path.includes('/optimization/sweep_') ||
    path.includes('/risk_analysis/risk_')
}

function dedupeRows(rows: ResearchCandidateRow[]): ResearchCandidateRow[] {
  const byKey = new Map<string, ResearchCandidateRow>()
  for (const row of rows) {
    const existing = byKey.get(row.candidateKey)
    if (!existing || row.researchScore > existing.researchScore) byKey.set(row.candidateKey, row)
  }
  return Array.from(byKey.values())
}

function inferFamily(path: string): string {
  const normalized = path.replaceAll('\\', '/')
  if (normalized.includes('eth_carry_short_bias')) return 'eth_carry_short_bias'
  if (normalized.includes('eth_carry')) return 'eth_carry'
  if (normalized.includes('current_btc')) return 'current_btc_runtime'
  if (normalized.includes('new_strategies')) return 'new_strategies'
  if (normalized.includes('optimization')) return 'optimization'
  return normalized.split('/').slice(-2, -1)[0] ?? 'unknown'
}

function inferSymbol(path: string): string {
  const normalized = path.toUpperCase()
  if (normalized.includes('BTC')) return 'BTC-USDT'
  if (normalized.includes('ETH')) return 'ETH-USDT'
  return 'UNKNOWN'
}

function renderConsoleSummary(report: ResearchCandidateSummaryReport): string {
  const lines = [
    `research candidate summary: rows=${report.candidateRowsFound}, files=${report.sourceFilesScanned}`,
    `paper=${report.paperTradingAllowed}, live=${report.liveTradingAllowed}, promotion=${report.promotionAllowed}`,
    'top candidates:',
  ]
  for (const row of report.topCandidates.slice(0, 10)) {
    lines.push([
      `#${row.rank}`,
      row.evidenceTier,
      row.family,
      row.candidateId,
      `score=${row.researchScore}`,
      `net=${formatMaybe(row.metrics.netExpectancyPct)}`,
      `ret=${formatMaybe(row.metrics.totalReturnPct)}`,
      `trades=${formatMaybe(row.metrics.tradeCount)}`,
      `blockers=${row.whyNotTradable.slice(0, 4).join('|') || 'none'}`,
    ].join(' | '))
  }
  lines.push('focus:')
  for (const item of report.focusRecommendations) lines.push(`- ${item}`)
  return lines.join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const equals = body.indexOf('=')
    if (equals >= 0) {
      out.set(body.slice(0, equals), body.slice(equals + 1))
      continue
    }
    const next = tokens[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(body, next)
      index += 1
    } else {
      out.set(body, 'true')
    }
  }
  return out
}

function parseNullablePath(raw: string | undefined): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  if (!normalized || normalized === 'null' || normalized === 'none' || normalized === 'false') return null
  return raw
}

function parsePositiveInteger(raw: string | undefined, fallback: number, label: string): number {
  if (raw == null) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`)
  return value
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null) return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  return fallback
}

function countBy<T, K extends string>(items: T[], readKey: (item: T) => K): Array<{ key: K; count: number }> {
  const counts = new Map<K, number>()
  for (const item of items) counts.set(readKey(item), (counts.get(readKey(item)) ?? 0) + 1)
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
}

function readNested(root: Record<string, unknown> | null, path: string[]): unknown {
  let current: unknown = root
  for (const key of path) {
    const record = asRecord(current)
    if (!record) return null
    current = record[key]
  }
  return current
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function readBool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function toPct(value: number | null): number | null {
  if (value == null) return null
  return Math.abs(value) <= 1 ? value * 100 : value
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function formatMaybe(value: number | null): string {
  return value == null ? 'null' : String(round(value, 4))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('summarize_research_candidates failed:', error)
    process.exit(1)
  })
}
