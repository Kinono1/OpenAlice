import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type EthCarryResearchEvidenceStatus =
  | 'blocked_missing_inputs'
  | 'research_only_blocked'
  | 'watch_only_ready'

interface CliArgs {
  pipelineRefreshPath: string
  controlSummaryPath: string | null
  shadowSummaryPath: string | null
  pairShadowSummaryPath: string | null
  validationPath: string | null
  runtimeStatusPath: string
  ethFundingPath: string
  btcFundingPath: string
  pitFeaturePath: string
  pitAuditPath: string
  feeSnapshotStatusPath: string
  okxAuthPath: string
  nextResearchPlanPath: string
  prospectiveEvidenceStatusPath: string
  outputPath: string | null
  json: boolean
}

interface CandidateEvidence {
  role: 'control' | 'short_bias_shadow' | 'pair_shadow'
  summaryPath: string
  artifactDir: string | null
  available: boolean
  generatedAt: string | null
  candidateId: string | null
  metrics: {
    totalReturnPct: number | null
    netExpectancyPct: number | null
    grossExpectancyPct: number | null
    tradeCount: number | null
    sharpe: number | null
    maxDrawdownPct: number | null
    feeExpectancyDragPct: number | null
    slippageExpectancyDragPct: number | null
    fundingExpectancyDragPct: number | null
    longTradeCount: number | null
    shortTradeCount: number | null
  }
  wfo: {
    overallPassed: boolean | null
    failedWindows: number | null
    windowCount: number | null
    failedWindowRatio: number | null
  }
  significance: {
    passed: boolean | null
    pbo: number | null
    dsrValue: number | null
    dsrProbability: number | null
  }
  riskSimulation: {
    gatePassed: boolean | null
    profitProbability: number | null
    minProfitProbability: number | null
    riskOfRuin: number | null
  }
  releaseGate: {
    allowPaperTrading: boolean | null
    allowLiveTrading: boolean | null
    hardFail: boolean | null
    failedChecks: string[]
    warningChecks: string[]
  }
}

interface FundingInputSummary {
  label: 'ETH' | 'BTC'
  path: string
  exists: boolean
  rows: number
  symbol: string | null
  firstTimestamp: number | null
  firstTime: string | null
  lastTimestamp: number | null
  lastTime: string | null
  monotonic: boolean
  duplicateTimestampCount: number
  medianIntervalHours: number | null
  explicitAvailableTimeRows: number
  explicitAvailableTimeCoveragePct: number | null
  timestampOnlyRows: number
  futureTimestampRows: number
}

interface PitFeatureEvidenceSummary {
  path: string
  exists: boolean
  status: string | null
  fundingEvents: number
  fundingEventsWithAvailableAt: number
  fundingExplicitAvailableTimeCoveragePct: number | null
  basisSnapshots: number
  carryFeatureRows: number
  validCarryFeatureRows: number
  rowsMissingAvailableAt: number | null
  symbolsWithFunding: string[]
  symbolsWithBasis: string[]
  blockers: string[]
  fundingAvailableTimeStatus: 'missing_explicit_available_time' | 'complete' | 'missing_inputs'
  basisAvailableTimeStatus: 'missing_basis_feature' | 'present'
  basisFeaturePresent: boolean
}

export interface EthCarryResearchEvidenceStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionAllowed: false
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  status: EthCarryResearchEvidenceStatus
  profitabilityVerdict:
    | 'cannot_claim_profitable'
    | 'research_watch_only_no_profit_claim'
    | 'blocked_missing_inputs'
  inputs: {
    pipelineRefreshPath: string
    controlSummaryPath: string | null
    shadowSummaryPath: string | null
    pairShadowSummaryPath: string | null
    validationPath: string | null
    runtimeStatusPath: string
    ethFundingPath: string
    btcFundingPath: string
    pitFeaturePath: string
    feeSnapshotStatusPath: string
    okxAuthPath: string
    nextResearchPlanPath: string
    prospectiveEvidenceStatusPath: string
  }
  pipeline: {
    generatedAt: string | null
    publishedArtifactDir: string | null
    bundleDir: string | null
    promotionDecision: string | null
  }
  candidates: CandidateEvidence[]
  selectedCandidate: CandidateEvidence | null
  bestObservedCandidate: CandidateEvidence | null
  fundingInputs: FundingInputSummary[]
  pitFeatureEvidence: PitFeatureEvidenceSummary
  pitAudit: {
    status: string | null
    passingRows: number | null
    failingRows: number | null
    blockers: string[]
  }
  pitEvidence: {
    fundingExplicitAvailableTimeCoveragePct: number | null
    fundingAvailableTimeStatus: 'missing_explicit_available_time' | 'complete' | 'missing_inputs'
    basisAvailableTimeStatus: 'missing_basis_feature' | 'present'
    source: 'pit_feature_dataset' | 'legacy_funding_history'
    pointInTimeUsableForPromotion: false
  }
  costEvidence: {
    runtimeFeeStatus: string | null
    runtimeFeeSnapshotWritten: boolean | null
    runtimeFeePerSymbolFees: number | null
    runtimeFeeSymbols: string[]
    okxPrivateAuthStatus: string | null
    okxPrivateAuthBestMode: string | null
  }
  basisEvidence: {
    available: boolean
    reason: string
    sourcePath: string | null
    validCarryFeatureRows: number
  }
  validationSummary: {
    failedChecks: string[]
    paperExecutionSlippageAvailable: boolean | null
    trialLedgerStatus: string | null
    fdrQ: number | null
    factorIcAvailable: boolean | null
    longNetExpectancyPct: number | null
    shortNetExpectancyPct: number | null
  }
  prospectiveEvidence: {
    status: string | null
    openEvents: number | null
    closedOutcomes: number | null
    closedDecisionWindows: number | null
    minClosedOutcomes: number | null
    minNonOverlappingWindows: number | null
    meanGrossCarryPairReturnPct: number | null
    winRatePct: number | null
    routeCostAdjustedClosedOutcomes: number | null
    fundingCashflowAccountedClosedOutcomes: number | null
    latestOpenObservationId: string | null
    latestOpenDecisionTime: string | null
    latestOpenLabelDueTime: string | null
    blockers: string[]
  }
  nextResearchAlignment: {
    planStatus: string | null
    admittedFundingCarry: boolean
    admittedExperimentId: string | null
  }
  thresholds: {
    maxWfoFailedWindowRatio: 0.3
    minProfitProbability: 0.55
    requirePositiveNetExpectancy: true
    requireExplicitFundingAvailableTime: true
    requireBasisSpreadFeature: true
    requireRuntimeVerifiedFees: true
    requireCompleteTrialLedger: true
    requireByFdr: true
    requirePitAudit: true
    requirePaperExecutionEvidence: true
  }
  blockers: string[]
  killCriteriaTriggered: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_PIPELINE_REFRESH_PATH = 'data/runtime/eth_carry_status/eth_carry_pipeline_refresh.json'
const DEFAULT_RUNTIME_STATUS_PATH = 'data/runtime/eth_carry_status/eth_carry_runtime_status.json'
const DEFAULT_ETH_FUNDING_PATH = 'data/research/derivatives_history/binance_ETH_USDT_USDT_funding_history.json'
const DEFAULT_BTC_FUNDING_PATH = 'data/research/derivatives_history/binance_BTC_USDT_USDT_funding_history.json'
const DEFAULT_PIT_FEATURE_PATH = 'data/research/eth_carry_pit_features.latest.json'
const DEFAULT_PIT_AUDIT_PATH = 'data/research/eth_carry_pit_audit.latest.json'
const DEFAULT_FEE_SNAPSHOT_STATUS_PATH = 'data/runtime/fee_snapshot_refresh.latest.json'
const DEFAULT_OKX_AUTH_PATH = 'data/runtime/okx_private_auth_diagnosis.latest.json'
const DEFAULT_NEXT_RESEARCH_PLAN_PATH = 'data/research/next_research_hypothesis_plan.latest.json'
const DEFAULT_PROSPECTIVE_EVIDENCE_STATUS_PATH = 'data/research/eth_carry_prospective_evidence_status.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_research_evidence_status.latest.json'

async function main(): Promise<void> {
  const args = parseEthCarryResearchEvidenceStatusArgs(process.argv.slice(2))
  const startedAt = new Date()
  const report = await runEthCarryResearchEvidenceStatus(args)

  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderConsoleSummary(report))
  }

  if (args.outputPath) {
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_research_evidence_status',
      artifactPath: resolve(args.outputPath),
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'watch_only_ready' ? 'warn' : 'fail',
      recordsIn: report.candidates.length + report.fundingInputs.reduce((sum, item) => sum + item.rows, 0),
      recordsOut: report.blockers.length,
      errorClass: report.blockers[0] ?? null,
    })
  }
}

export function parseEthCarryResearchEvidenceStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    pipelineRefreshPath: raw.get('pipelineRefreshPath') ?? DEFAULT_PIPELINE_REFRESH_PATH,
    controlSummaryPath: parseNullablePath(raw.get('controlSummaryPath')),
    shadowSummaryPath: parseNullablePath(raw.get('shadowSummaryPath')),
    pairShadowSummaryPath: parseNullablePath(raw.get('pairShadowSummaryPath')),
    validationPath: parseNullablePath(raw.get('validationPath')),
    runtimeStatusPath: raw.get('runtimeStatusPath') ?? DEFAULT_RUNTIME_STATUS_PATH,
    ethFundingPath: raw.get('ethFundingPath') ?? DEFAULT_ETH_FUNDING_PATH,
    btcFundingPath: raw.get('btcFundingPath') ?? DEFAULT_BTC_FUNDING_PATH,
    pitFeaturePath: raw.get('pitFeaturePath') ?? DEFAULT_PIT_FEATURE_PATH,
    pitAuditPath: raw.get('pitAuditPath') ?? DEFAULT_PIT_AUDIT_PATH,
    feeSnapshotStatusPath: raw.get('feeSnapshotStatusPath') ?? DEFAULT_FEE_SNAPSHOT_STATUS_PATH,
    okxAuthPath: raw.get('okxAuthPath') ?? DEFAULT_OKX_AUTH_PATH,
    nextResearchPlanPath: raw.get('nextResearchPlanPath') ?? DEFAULT_NEXT_RESEARCH_PLAN_PATH,
    prospectiveEvidenceStatusPath: raw.get('prospectiveEvidenceStatusPath') ?? DEFAULT_PROSPECTIVE_EVIDENCE_STATUS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryResearchEvidenceStatus(
  args: CliArgs,
): Promise<EthCarryResearchEvidenceStatusReport> {
  const pipelineRefreshPath = resolve(args.pipelineRefreshPath)
  const pipelineRefresh = await readJsonIfExists(pipelineRefreshPath)
  const pipelineResult = asRecord(asRecord(pipelineRefresh)?.pipelineResult) ?? asRecord(pipelineRefresh)
  const controlSummaryPath = resolveOptionalPath(
    args.controlSummaryPath ?? readString(pipelineResult?.controlSummaryPath),
  )
  const shadowSummaryPath = resolveOptionalPath(
    args.shadowSummaryPath ?? readString(pipelineResult?.shadowSummaryPath),
  )
  const pairShadowSummaryPath = resolveOptionalPath(
    args.pairShadowSummaryPath ?? readString(pipelineResult?.pairShadowSummaryPath),
  )
  const controlSummary = controlSummaryPath ? await readJsonIfExists(controlSummaryPath) : null
  const shadowSummary = shadowSummaryPath ? await readJsonIfExists(shadowSummaryPath) : null
  const pairShadowSummary = pairShadowSummaryPath ? await readJsonIfExists(pairShadowSummaryPath) : null
  const validationPath = resolveOptionalPath(
    args.validationPath ??
      readString(asRecord(controlSummary)?.validationOutput) ??
      (readString(pipelineResult?.controlArtifactDir)
        ? `${readString(pipelineResult?.controlArtifactDir)}/eth_carry.validation.json`
        : null),
  )
  const report = buildEthCarryResearchEvidenceStatusReport({
    generatedAt: new Date().toISOString(),
    inputPaths: {
      pipelineRefreshPath,
      controlSummaryPath,
      shadowSummaryPath,
      pairShadowSummaryPath,
      validationPath,
      runtimeStatusPath: resolve(args.runtimeStatusPath),
      ethFundingPath: resolve(args.ethFundingPath),
      btcFundingPath: resolve(args.btcFundingPath),
      pitFeaturePath: resolve(args.pitFeaturePath),
      pitAuditPath: resolve(args.pitAuditPath),
      feeSnapshotStatusPath: resolve(args.feeSnapshotStatusPath),
      okxAuthPath: resolve(args.okxAuthPath),
      nextResearchPlanPath: resolve(args.nextResearchPlanPath),
      prospectiveEvidenceStatusPath: resolve(args.prospectiveEvidenceStatusPath),
    },
    pipelineRefresh,
    pipelineResult,
    controlSummary,
    shadowSummary,
    pairShadowSummary,
    validation: validationPath ? await readJsonIfExists(validationPath) : null,
    runtimeStatus: await readJsonIfExists(args.runtimeStatusPath),
    ethFundingRows: readFundingRows(args.ethFundingPath),
    btcFundingRows: readFundingRows(args.btcFundingPath),
    pitFeatureDataset: await readJsonIfExists(args.pitFeaturePath),
    pitAudit: await readJsonIfExists(args.pitAuditPath),
    feeSnapshotStatus: await readJsonIfExists(args.feeSnapshotStatusPath),
    okxAuth: await readJsonIfExists(args.okxAuthPath),
    nextResearchPlan: await readJsonIfExists(args.nextResearchPlanPath),
    prospectiveEvidenceStatus: await readJsonIfExists(args.prospectiveEvidenceStatusPath),
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
  }

  return report
}

export function buildEthCarryResearchEvidenceStatusReport(input: {
  generatedAt?: string
  inputPaths: EthCarryResearchEvidenceStatusReport['inputs']
  pipelineRefresh?: unknown
  pipelineResult?: UnknownRecord | null
  controlSummary?: unknown
  shadowSummary?: unknown
  pairShadowSummary?: unknown
  validation?: unknown
  runtimeStatus?: unknown
  ethFundingRows: UnknownRecord[]
  btcFundingRows: UnknownRecord[]
  pitFeatureDataset?: unknown
  pitAudit?: unknown
  feeSnapshotStatus?: unknown
  okxAuth?: unknown
  nextResearchPlan?: unknown
  prospectiveEvidenceStatus?: unknown
}): EthCarryResearchEvidenceStatusReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const validation = asRecord(input.validation)
  const runtimeStatus = asRecord(input.runtimeStatus)
  const feeSnapshotStatus = asRecord(input.feeSnapshotStatus)
  const okxAuth = asRecord(input.okxAuth)
  const nextResearchPlan = asRecord(input.nextResearchPlan)
  const prospectiveEvidenceStatus = asRecord(input.prospectiveEvidenceStatus)
  const pipelineRefresh = asRecord(input.pipelineRefresh)
  const pipelineResult = input.pipelineResult

  const candidates = [
    buildCandidateEvidence('control', input.inputPaths.controlSummaryPath, input.controlSummary),
    buildCandidateEvidence('short_bias_shadow', input.inputPaths.shadowSummaryPath, input.shadowSummary),
    buildCandidateEvidence('pair_shadow', input.inputPaths.pairShadowSummaryPath, input.pairShadowSummary),
  ].filter(candidate => candidate.available || candidate.summaryPath)
  const selectedCandidate = resolveSelectedCandidate(candidates, pipelineResult) ?? candidates[0] ?? null
  const bestObservedCandidate = resolveBestObservedCandidate(candidates)
  const ethFunding = summarizeFundingInput('ETH', input.inputPaths.ethFundingPath, input.ethFundingRows)
  const btcFunding = summarizeFundingInput('BTC', input.inputPaths.btcFundingPath, input.btcFundingRows)
  const fundingInputs = [ethFunding, btcFunding]
  const legacyExplicitAvailableTimeCoveragePct = meanNullable(
    fundingInputs
      .map(item => item.explicitAvailableTimeCoveragePct)
      .filter((value): value is number => value != null),
  )
  const pitFeatureEvidence = summarizePitFeatureEvidence(
    input.inputPaths.pitFeaturePath,
    input.pitFeatureDataset,
  )
  const pitAudit = summarizePitAudit(input.pitAudit)
  const pitFeatureUsable = pitFeatureEvidence.fundingAvailableTimeStatus === 'complete' ||
    pitFeatureEvidence.basisAvailableTimeStatus === 'present'
  const explicitAvailableTimeCoveragePct = pitFeatureUsable
    ? pitFeatureEvidence.fundingExplicitAvailableTimeCoveragePct
    : legacyExplicitAvailableTimeCoveragePct
  const fundingAvailableTimeStatus = pitFeatureEvidence.fundingAvailableTimeStatus === 'complete'
    ? 'complete'
    : fundingInputs.some(item => !item.exists || item.rows === 0)
      ? 'missing_inputs'
      : fundingInputs.every(item => item.explicitAvailableTimeCoveragePct === 100)
        ? 'complete'
        : 'missing_explicit_available_time'
  const basisAvailableTimeStatus = pitFeatureEvidence.basisAvailableTimeStatus
  const feeStatus = readString(feeSnapshotStatus?.status)
  const okxAuthStatus = readString(okxAuth?.status)
  const validationSummary = buildValidationSummary(validation)
  const prospectiveEvidence = buildProspectiveEvidenceSummary(prospectiveEvidenceStatus)
  const nextResearchAlignment = buildNextResearchAlignment(nextResearchPlan)
  const blockers = buildBlockers({
    selectedCandidate,
    bestObservedCandidate,
    candidates,
    fundingInputs,
    pitFeatureEvidence,
    pitAudit,
    fundingAvailableTimeStatus,
    basisAvailableTimeStatus,
    feeSnapshotStatus,
    okxAuth,
    nextResearchAlignment,
    validationSummary,
    prospectiveEvidence,
  })
  const missingCriticalInput =
    selectedCandidate == null ||
    validation == null ||
    (fundingAvailableTimeStatus !== 'complete' && fundingInputs.some(item => !item.exists || item.rows === 0))
  const status: EthCarryResearchEvidenceStatus = missingCriticalInput
    ? 'blocked_missing_inputs'
    : blockers.length > 0
      ? 'research_only_blocked'
      : 'watch_only_ready'
  const profitabilityVerdict: EthCarryResearchEvidenceStatusReport['profitabilityVerdict'] =
    missingCriticalInput
      ? 'blocked_missing_inputs'
      : selectedCandidate?.metrics.netExpectancyPct != null &&
          selectedCandidate.metrics.netExpectancyPct > 0 &&
          selectedCandidate.releaseGate.failedChecks.length === 0
        ? 'research_watch_only_no_profit_claim'
        : 'cannot_claim_profitable'

  return {
    schemaVersion: 1,
    generatedAt,
    researchOnly: true,
    diagnosticOnly: true,
    promotionAllowed: false,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    status,
    profitabilityVerdict,
    inputs: input.inputPaths,
    pipeline: {
      generatedAt: readString(pipelineRefresh?.generatedAt),
      publishedArtifactDir: readString(pipelineResult?.publishedArtifactDir),
      bundleDir: readString(pipelineResult?.bundleDir),
      promotionDecision: readString(asRecord(runtimeStatus)?.promotionDecision) ??
        readString(asRecord(input.shadowSummary)?.promotionDecision),
    },
    candidates,
    selectedCandidate,
    bestObservedCandidate,
    fundingInputs,
    pitFeatureEvidence,
    pitAudit,
    pitEvidence: {
      fundingExplicitAvailableTimeCoveragePct: explicitAvailableTimeCoveragePct,
      fundingAvailableTimeStatus,
      basisAvailableTimeStatus,
      source: pitFeatureUsable ? 'pit_feature_dataset' : 'legacy_funding_history',
      pointInTimeUsableForPromotion: false,
    },
    costEvidence: {
      runtimeFeeStatus: feeStatus,
      runtimeFeeSnapshotWritten: readBoolean(feeSnapshotStatus?.snapshotWritten),
      runtimeFeePerSymbolFees: Array.isArray(feeSnapshotStatus?.perSymbolFees)
        ? feeSnapshotStatus.perSymbolFees.length
        : null,
      runtimeFeeSymbols: readStringArray(feeSnapshotStatus?.symbols),
      okxPrivateAuthStatus: okxAuthStatus,
      okxPrivateAuthBestMode: readString(okxAuth?.bestMode),
    },
    basisEvidence: {
      available: pitFeatureEvidence.basisFeaturePresent,
      reason: pitFeatureEvidence.basisFeaturePresent
        ? 'PIT feature dataset contains ETH/BTC mark-index basis spread rows with explicit decisionAvailableAt fields.'
        : 'No complete PIT basis_spread feature dataset is available; funding spread and ETH/BTC relative value are insufficient for carry promotion evidence.',
      sourcePath: pitFeatureEvidence.exists ? pitFeatureEvidence.path : null,
      validCarryFeatureRows: pitFeatureEvidence.validCarryFeatureRows,
    },
    validationSummary,
    prospectiveEvidence,
    nextResearchAlignment,
    thresholds: {
      maxWfoFailedWindowRatio: 0.3,
      minProfitProbability: 0.55,
      requirePositiveNetExpectancy: true,
      requireExplicitFundingAvailableTime: true,
      requireBasisSpreadFeature: true,
      requireRuntimeVerifiedFees: true,
      requireCompleteTrialLedger: true,
      requireByFdr: true,
      requirePitAudit: true,
      requirePaperExecutionEvidence: true,
    },
    blockers,
    killCriteriaTriggered: buildKillCriteriaTriggered(blockers),
    nextActions: buildNextActions(status, blockers),
    safetyNotes: [
      'This artifact summarizes ETH carry research evidence only; it cannot authorize paper or live orders.',
      'Positive historical diagnostics would still not be a profitability guarantee without prospective, WFO, FDR, PIT, and paper execution evidence.',
      'Funding timestamps without explicit available-time fields are insufficient for promotion-grade PIT accounting.',
    ],
  }
}

function buildCandidateEvidence(
  role: CandidateEvidence['role'],
  summaryPath: string | null,
  summaryLike: unknown,
): CandidateEvidence {
  const summary = asRecord(summaryLike)
  const selectedMetrics = asRecord(summary?.selectedMetrics)
  const selectedParams = asRecord(summary?.selectedParams)
  const wfo = asRecord(summary?.wfo)
  const wfoWindows = Array.isArray(wfo?.windows)
    ? wfo.windows.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const significance = asRecord(summary?.significance)
  const pboResult = asRecord(significance?.pboResult)
  const dsrResult = asRecord(significance?.dsrResult)
  const riskSimulation = asRecord(summary?.riskSimulation)
  const releaseGate = asRecord(summary?.releaseGate)
  const failedWindows = readNumber(wfo?.failedWindows)
  const windowCount = readNumber(wfo?.windowCount) ?? wfoWindows.length
  return {
    role,
    summaryPath: summaryPath ?? '',
    artifactDir: summaryPath ? dirname(summaryPath) : null,
    available: summary != null,
    generatedAt: readString(summary?.generatedAt),
    candidateId: readString(selectedParams?.id),
    metrics: {
      totalReturnPct: readNumber(selectedMetrics?.totalReturnPct),
      netExpectancyPct: readNumber(selectedMetrics?.netExpectancyPct),
      grossExpectancyPct: readNumber(selectedMetrics?.grossExpectancyPct),
      tradeCount: readNumber(selectedMetrics?.tradeCount),
      sharpe: readNumber(selectedMetrics?.sharpe),
      maxDrawdownPct: readNumber(selectedMetrics?.maxDrawdownPct),
      feeExpectancyDragPct: readNumber(selectedMetrics?.feeExpectancyDragPct),
      slippageExpectancyDragPct: readNumber(selectedMetrics?.slippageExpectancyDragPct),
      fundingExpectancyDragPct: readNumber(selectedMetrics?.fundingExpectancyDragPct),
      longTradeCount: readNumber(selectedMetrics?.longTradeCount),
      shortTradeCount: readNumber(selectedMetrics?.shortTradeCount),
    },
    wfo: {
      overallPassed: readBoolean(wfo?.overallPassed),
      failedWindows,
      windowCount,
      failedWindowRatio: failedWindows != null && windowCount != null && windowCount > 0
        ? round(failedWindows / windowCount, 10)
        : null,
    },
    significance: {
      passed: readBoolean(significance?.passed),
      pbo: readNumber(pboResult?.pbo) ?? readNumber(significance?.pbo),
      dsrValue: readNumber(dsrResult?.dsrValue) ?? readNumber(significance?.dsrValue),
      dsrProbability: readNumber(dsrResult?.dsrProbability) ?? readNumber(significance?.dsrProbability),
    },
    riskSimulation: {
      gatePassed: readBoolean(riskSimulation?.gatePassed),
      profitProbability: readNumber(riskSimulation?.profitProbability),
      minProfitProbability: readNumber(riskSimulation?.minProfitProbability),
      riskOfRuin: readNumber(riskSimulation?.riskOfRuin),
    },
    releaseGate: {
      allowPaperTrading: readBoolean(releaseGate?.allowPaperTrading),
      allowLiveTrading: readBoolean(releaseGate?.allowLiveTrading),
      hardFail: readBoolean(releaseGate?.hardFail),
      failedChecks: readStringArray(releaseGate?.failedChecks),
      warningChecks: readStringArray(releaseGate?.warningChecks),
    },
  }
}

function resolveSelectedCandidate(
  candidates: CandidateEvidence[],
  pipelineResult: UnknownRecord | null,
): CandidateEvidence | null {
  const published = readString(pipelineResult?.publishedArtifactDir)
  if (published) {
    const found = candidates.find(candidate => candidate.artifactDir === published)
    if (found) return found
  }
  return candidates.find(candidate => candidate.role === 'control' && candidate.available) ??
    candidates.find(candidate => candidate.available) ??
    null
}

function resolveBestObservedCandidate(candidates: CandidateEvidence[]): CandidateEvidence | null {
  const finite = candidates.filter(candidate => Number.isFinite(candidate.metrics.netExpectancyPct))
  if (finite.length === 0) return null
  return [...finite].sort((left, right) =>
    (right.metrics.netExpectancyPct ?? Number.NEGATIVE_INFINITY) -
    (left.metrics.netExpectancyPct ?? Number.NEGATIVE_INFINITY),
  )[0]
}

function summarizeFundingInput(
  label: FundingInputSummary['label'],
  path: string,
  rows: UnknownRecord[],
): FundingInputSummary {
  const resolvedPath = resolve(path)
  const exists = existsSync(resolvedPath) || rows.length > 0
  const timestamps = rows
    .map(row => normalizeTimestampMs(row.timestamp))
    .filter((value): value is number => value != null)
  const sorted = [...timestamps].sort((left, right) => left - right)
  const duplicateTimestampCount = timestamps.length - new Set(timestamps).size
  const explicitAvailableTimeRows = rows.filter(row =>
    row.availableAt != null ||
    row.availableTime != null ||
    row.observedAt != null ||
    row.fetchedAt != null ||
    row.fetchTime != null,
  ).length
  const intervals = sorted.slice(1).map((value, index) => value - sorted[index])
  const now = Date.now()
  return {
    label,
    path: resolvedPath,
    exists,
    rows: rows.length,
    symbol: readString(rows[0]?.symbol),
    firstTimestamp: sorted[0] ?? null,
    firstTime: sorted[0] ? new Date(sorted[0]).toISOString() : null,
    lastTimestamp: sorted.at(-1) ?? null,
    lastTime: sorted.at(-1) ? new Date(sorted.at(-1)!).toISOString() : null,
    monotonic: timestamps.every((value, index) => index === 0 || value >= timestamps[index - 1]),
    duplicateTimestampCount,
    medianIntervalHours: intervals.length > 0 ? round(median(intervals) / 3_600_000, 6) : null,
    explicitAvailableTimeRows,
    explicitAvailableTimeCoveragePct: rows.length > 0
      ? round((explicitAvailableTimeRows / rows.length) * 100, 6)
      : null,
    timestampOnlyRows: rows.length - explicitAvailableTimeRows,
    futureTimestampRows: timestamps.filter(value => value > now + 60_000).length,
  }
}

function buildValidationSummary(validation: UnknownRecord | null): EthCarryResearchEvidenceStatusReport['validationSummary'] {
  const decisionSummary = asRecord(validation?.decisionSummary)
  const evidence = asRecord(validation?.validationEvidence)
  const promotion = asRecord(decisionSummary?.promotion)
  const statistics = asRecord(decisionSummary?.statistics)
  const factorIc = asRecord(decisionSummary?.factorIcByHorizon)
  const sideAsymmetry = asRecord(decisionSummary?.longShortSideAsymmetry)
  const paperExecutionSlippage =
    asRecord(evidence?.paperExecutionSlippage) ??
    asRecord(decisionSummary?.paperExecutionSlippage)
  return {
    failedChecks: readStringArray(promotion?.failedChecks),
    paperExecutionSlippageAvailable: readBoolean(paperExecutionSlippage?.available),
    trialLedgerStatus: readString(statistics?.trialLedgerStatus),
    fdrQ: readNumber(statistics?.fdrQ),
    factorIcAvailable: readBoolean(factorIc?.available),
    longNetExpectancyPct: readNumber(sideAsymmetry?.longNetExpectancyPct),
    shortNetExpectancyPct: readNumber(sideAsymmetry?.shortNetExpectancyPct),
  }
}

function buildProspectiveEvidenceSummary(
  prospectiveEvidenceStatus: UnknownRecord | null,
): EthCarryResearchEvidenceStatusReport['prospectiveEvidence'] {
  const counts = asRecord(prospectiveEvidenceStatus?.counts)
  const metrics = asRecord(prospectiveEvidenceStatus?.metrics)
  const thresholds = asRecord(prospectiveEvidenceStatus?.thresholds)
  const latestOpen = asRecord(prospectiveEvidenceStatus?.latestOpen)
  return {
    status: readString(prospectiveEvidenceStatus?.status),
    openEvents: readNumber(counts?.openEvents),
    closedOutcomes: readNumber(metrics?.closedOutcomes) ?? readNumber(counts?.closedEvents),
    closedDecisionWindows: readNumber(counts?.closedDecisionWindows),
    minClosedOutcomes: readNumber(thresholds?.minClosedOutcomes),
    minNonOverlappingWindows: readNumber(thresholds?.minNonOverlappingWindows),
    meanGrossCarryPairReturnPct: readNumber(metrics?.meanGrossCarryPairReturnPct),
    winRatePct: readNumber(metrics?.winRatePct),
    routeCostAdjustedClosedOutcomes: readNumber(metrics?.routeCostAdjustedClosedOutcomes),
    fundingCashflowAccountedClosedOutcomes: readNumber(metrics?.fundingCashflowAccountedClosedOutcomes),
    latestOpenObservationId: readString(latestOpen?.observationId),
    latestOpenDecisionTime: readString(latestOpen?.decisionTime),
    latestOpenLabelDueTime: readString(latestOpen?.labelDueTime),
    blockers: prospectiveEvidenceStatus
      ? readStringArray(prospectiveEvidenceStatus.blockers)
      : ['prospective_evidence_status_missing'],
  }
}

function buildNextResearchAlignment(
  nextResearchPlan: UnknownRecord | null,
): EthCarryResearchEvidenceStatusReport['nextResearchAlignment'] {
  const cards = Array.isArray(nextResearchPlan?.experimentCards)
    ? nextResearchPlan.experimentCards.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
  const admitted = cards.find(card =>
    readString(card.familyId) === 'funding_carry_rebuild' &&
    readString(card.decision) === 'admit_research_only')
  return {
    planStatus: readString(nextResearchPlan?.planStatus),
    admittedFundingCarry: admitted != null,
    admittedExperimentId: readString(admitted?.experimentId),
  }
}

function buildBlockers(input: {
  selectedCandidate: CandidateEvidence | null
  bestObservedCandidate: CandidateEvidence | null
  candidates: CandidateEvidence[]
  fundingInputs: FundingInputSummary[]
  pitFeatureEvidence: PitFeatureEvidenceSummary
  pitAudit: EthCarryResearchEvidenceStatusReport['pitAudit']
  fundingAvailableTimeStatus: EthCarryResearchEvidenceStatusReport['pitEvidence']['fundingAvailableTimeStatus']
  basisAvailableTimeStatus: EthCarryResearchEvidenceStatusReport['pitEvidence']['basisAvailableTimeStatus']
  feeSnapshotStatus: UnknownRecord | null
  okxAuth: UnknownRecord | null
  nextResearchAlignment: EthCarryResearchEvidenceStatusReport['nextResearchAlignment']
  validationSummary: EthCarryResearchEvidenceStatusReport['validationSummary']
  prospectiveEvidence: EthCarryResearchEvidenceStatusReport['prospectiveEvidence']
}): string[] {
  const blockers: string[] = [
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'not_trial_ledger_fdr_validated',
    'not_paper_execution_evidence',
  ]
  if (input.pitAudit.status !== 'pass') {
    blockers.push('not_pit_audit_validated')
  }
  const selected = input.selectedCandidate
  if (!selected) {
    blockers.push('eth_carry_selected_summary_missing')
  } else {
    for (const check of selected.releaseGate.failedChecks) {
      blockers.push(`release_gate_failed:${check}`)
    }
    if (selected.releaseGate.allowPaperTrading === true || selected.releaseGate.allowLiveTrading === true) {
      blockers.push('eth_carry_artifact_must_not_authorize_execution')
    }
    if (selected.metrics.netExpectancyPct == null) {
      blockers.push('net_expectancy_missing')
    } else if (selected.metrics.netExpectancyPct <= 0) {
      blockers.push(`net_expectancy_non_positive:${round(selected.metrics.netExpectancyPct, 10)}`)
    }
    if (selected.wfo.overallPassed !== true) {
      blockers.push('wfo_not_passed')
    }
    if (
      selected.wfo.failedWindowRatio != null &&
      selected.wfo.failedWindowRatio > 0.3
    ) {
      blockers.push(`wfo_failed_window_ratio:${round(selected.wfo.failedWindowRatio, 6)}>0.3`)
    }
    if (selected.significance.passed !== true) {
      blockers.push(`significance_not_passed:pbo=${formatMaybe(selected.significance.pbo)}`)
    }
    if (selected.riskSimulation.gatePassed !== true) {
      blockers.push(
        `risk_simulation_not_passed:profitProbability=${formatMaybe(selected.riskSimulation.profitProbability)}<0.55`,
      )
    }
  }
  const best = input.bestObservedCandidate
  if (!best) {
    blockers.push('best_observed_candidate_missing')
  } else if (best.metrics.netExpectancyPct == null || best.metrics.netExpectancyPct <= 0) {
    blockers.push(`best_observed_net_expectancy_non_positive:${formatMaybe(best.metrics.netExpectancyPct)}`)
  }
  if (input.candidates.length < 1) blockers.push('eth_carry_candidate_summaries_missing')
  if (input.fundingAvailableTimeStatus !== 'complete') {
    for (const funding of input.fundingInputs) {
      if (!funding.exists || funding.rows === 0) {
        blockers.push(`funding_history_missing:${funding.label}`)
      } else if (funding.explicitAvailableTimeRows < funding.rows) {
        blockers.push(`funding_available_time_missing:${funding.label}:${funding.explicitAvailableTimeRows}/${funding.rows}`)
      }
      if (!funding.monotonic) blockers.push(`funding_history_not_monotonic:${funding.label}`)
      if (funding.duplicateTimestampCount > 0) {
        blockers.push(`funding_history_duplicate_timestamps:${funding.label}:${funding.duplicateTimestampCount}`)
      }
    }
  }
  if (input.basisAvailableTimeStatus !== 'present') {
    blockers.push('basis_spread_feature_missing')
  }
  for (const blocker of input.pitFeatureEvidence.blockers) {
    blockers.push(`pit_feature:${blocker}`)
  }
  for (const blocker of input.pitAudit.blockers) {
    blockers.push(`pit_audit:${blocker}`)
  }
  const feeStatus = readString(input.feeSnapshotStatus?.status)
  if (feeStatus !== 'runtime_verified') {
    blockers.push(`runtime_fee_snapshot_not_verified:${feeStatus ?? 'missing'}`)
  }
  const okxAuthStatus = readString(input.okxAuth?.status)
  if (okxAuthStatus !== 'auth_available') {
    blockers.push(`okx_private_auth_not_available:${okxAuthStatus ?? 'missing'}`)
  }
  if (!input.nextResearchAlignment.admittedFundingCarry) {
    blockers.push('next_research_funding_carry_not_admitted')
  }
  if (input.validationSummary.paperExecutionSlippageAvailable !== true) {
    blockers.push('paper_execution_slippage_telemetry_unavailable')
  }
  if (input.validationSummary.trialLedgerStatus !== 'pass') {
    blockers.push(`trial_ledger_not_pass:${input.validationSummary.trialLedgerStatus ?? 'missing'}`)
  }
  if (input.validationSummary.fdrQ == null) {
    blockers.push('by_fdr_missing')
  }
  for (const blocker of input.prospectiveEvidence.blockers.slice(0, 12)) {
    blockers.push(`prospective:${blocker}`)
  }
  return uniqueStrings(blockers)
}

function buildKillCriteriaTriggered(blockers: string[]): string[] {
  const triggered: string[] = []
  if (blockers.some(blocker => blocker.startsWith('net_expectancy_non_positive') || blocker.startsWith('best_observed_net_expectancy_non_positive'))) {
    triggered.push('net_carry_after_stressed_unwind_cost<=0')
  }
  if (blockers.some(blocker =>
    blocker.startsWith('funding_available_time_missing') ||
    blocker === 'basis_spread_feature_missing' ||
    blocker.startsWith('pit_feature:'),
  )) {
    triggered.push('funding_or_basis_available_time_missing')
  }
  if (blockers.some(blocker => blocker.startsWith('runtime_fee_snapshot_not_verified'))) {
    triggered.push('cost_model_quarantine_persists_after_runtime_fee_refresh')
  }
  if (blockers.some(blocker => blocker === 'eth_carry_artifact_must_not_authorize_execution')) {
    triggered.push('paperTradingAllowed_or_liveTradingAllowed_true_from_research_artifact')
  }
  return uniqueStrings(triggered)
}

function buildNextActions(status: EthCarryResearchEvidenceStatus, blockers: string[]): string[] {
  const actions = [
    'Keep ETH carry in research-only mode; do not publish non-flat paper targets from this evidence.',
    'Rebuild the funding/carry lane with explicit funding available-time, basis_spread, runtime fee, and stressed unwind cost fields before another promotion review.',
  ]
  if (status === 'blocked_missing_inputs') {
    actions.push('Refresh the ETH carry pipeline or provide control summary, validation, and funding-history paths.')
  }
  if (blockers.some(blocker => blocker.startsWith('release_gate_failed:wfo') || blocker === 'wfo_not_passed')) {
    actions.push('Do not tune around the failed WFO windows; change the economic feature set or retire the carry variant.')
  }
  if (blockers.some(blocker => blocker.startsWith('funding_available_time_missing'))) {
    actions.push('Recollect funding history with explicit fetchedAt/availableAt fields and keep decision bars strictly after availability.')
  }
  if (blockers.includes('basis_spread_feature_missing')) {
    actions.push('Add a real basis_spread input rather than using ETH/BTC relative value as a proxy for carry economics.')
  }
  if (blockers.some(blocker => blocker.startsWith('pit_feature:'))) {
    actions.push('Refresh the PIT feature dataset from derivative events until funding, basis, and decisionAvailableAt blockers clear.')
  }
  actions.push('Promotion still requires WFO, BY FDR, PIT audit, prospective closed outcomes, and paper execution telemetry.')
  return actions
}

function summarizePitFeatureEvidence(path: string, datasetLike: unknown): PitFeatureEvidenceSummary {
  const resolvedPath = resolve(path)
  const dataset = asRecord(datasetLike)
  const counts = asRecord(dataset?.counts)
  const fundingEvents = readRecordArray(dataset?.fundingEvents)
  const basisSnapshots = readRecordArray(dataset?.basisSnapshots)
  const carryFeatureRows = readRecordArray(dataset?.carryFeatureRows)
  const symbolsWithFunding = readStringArray(counts?.symbolsWithFunding)
  const symbolsWithBasis = readStringArray(counts?.symbolsWithBasis)
  const fundingEventsCount = readNumber(counts?.fundingEvents) ?? fundingEvents.length
  const basisSnapshotsCount = readNumber(counts?.basisSnapshots) ?? basisSnapshots.length
  const carryFeatureRowsCount = readNumber(counts?.carryFeatureRows) ?? carryFeatureRows.length
  const rowsMissingAvailableAt = readNumber(counts?.rowsMissingAvailableAt)
  const fundingEventsWithAvailableAt = fundingEvents.filter(row => readString(row.availableAt) != null).length
  const fundingCoverage = fundingEventsCount > 0
    ? round((fundingEventsWithAvailableAt / fundingEventsCount) * 100, 6)
    : null
  const validCarryFeatureRows = carryFeatureRows.filter(row => {
    const requiredFields = asRecord(row.requiredFields)
    return readBoolean(requiredFields?.fundingRateCashflow) === true &&
      readBoolean(requiredFields?.basisSpread) === true &&
      readBoolean(requiredFields?.explicitAvailableAt) === true &&
      readString(row.decisionAvailableAt) != null &&
      readNumber(row.basisSpreadDiffPct) != null &&
      readStringArray(row.blockers).length === 0
  }).length
  const hasFundingSymbols = symbolsWithFunding.includes('ETHUSDT') && symbolsWithFunding.includes('BTCUSDT')
  const hasBasisSymbols = symbolsWithBasis.includes('ETHUSDT') && symbolsWithBasis.includes('BTCUSDT')
  const status = readString(dataset?.status)
  const rawBlockers = readStringArray(dataset?.blockers)
  const fundingComplete = dataset != null &&
    fundingEventsCount > 0 &&
    fundingCoverage === 100 &&
    hasFundingSymbols &&
    validCarryFeatureRows > 0
  const basisFeaturePresent = dataset != null &&
    basisSnapshotsCount > 0 &&
    hasBasisSymbols &&
    validCarryFeatureRows > 0
  const blockers = uniqueStrings([
    ...(dataset != null ? [] : ['pit_feature_dataset_missing']),
    ...rawBlockers,
    ...(dataset != null && fundingEventsCount > 0 ? [] : ['pit_feature_funding_events_missing']),
    ...(dataset != null && basisSnapshotsCount > 0 ? [] : ['pit_feature_basis_snapshots_missing']),
    ...(dataset != null && hasFundingSymbols ? [] : ['pit_feature_funding_symbols_incomplete']),
    ...(dataset != null && hasBasisSymbols ? [] : ['pit_feature_basis_symbols_incomplete']),
    ...(dataset != null && validCarryFeatureRows > 0 ? [] : ['pit_feature_valid_carry_rows_missing']),
    ...(dataset != null && rowsMissingAvailableAt != null && rowsMissingAvailableAt > 0
      ? [`pit_feature_rows_missing_available_at:${rowsMissingAvailableAt}`]
      : []),
  ])
  return {
    path: resolvedPath,
    exists: dataset != null || existsSync(resolvedPath),
    status,
    fundingEvents: fundingEventsCount,
    fundingEventsWithAvailableAt,
    fundingExplicitAvailableTimeCoveragePct: fundingCoverage,
    basisSnapshots: basisSnapshotsCount,
    carryFeatureRows: carryFeatureRowsCount,
    validCarryFeatureRows,
    rowsMissingAvailableAt,
    symbolsWithFunding,
    symbolsWithBasis,
    blockers,
    fundingAvailableTimeStatus: dataset == null || fundingEventsCount === 0
      ? 'missing_inputs'
      : fundingComplete
        ? 'complete'
        : 'missing_explicit_available_time',
    basisAvailableTimeStatus: basisFeaturePresent ? 'present' : 'missing_basis_feature',
    basisFeaturePresent,
  }
}

function summarizePitAudit(
  pitAuditLike: unknown,
): EthCarryResearchEvidenceStatusReport['pitAudit'] {
  const report = asRecord(pitAuditLike)
  const counts = asRecord(report?.counts)
  return {
    status: readString(report?.status),
    passingRows: readNumber(counts?.passingRows),
    failingRows: readNumber(counts?.failingRows),
    blockers: report ? readStringArray(report.blockers) : ['pit_audit_report_missing'],
  }
}

function readFundingRows(path: string): UnknownRecord[] {
  const resolved = resolve(path)
  if (!existsSync(resolved)) return []
  const parsed = JSON.parse(readFileSync(resolved, 'utf-8'))
  return Array.isArray(parsed)
    ? parsed.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

async function readJsonIfExists(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(resolve(path), 'utf-8'))
  } catch (error) {
    if (
      error instanceof Error &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null
    }
    throw error
  }
}

function renderConsoleSummary(report: EthCarryResearchEvidenceStatusReport): string {
  const selected = report.selectedCandidate
  return [
    `eth carry research evidence: status=${report.status}, profitability=${report.profitabilityVerdict}`,
    `selected=${selected?.candidateId ?? 'none'}, net=${formatMaybe(selected?.metrics.netExpectancyPct ?? null)}, wfo=${formatMaybe(selected?.wfo.failedWindowRatio ?? null)}, failedChecks=${selected?.releaseGate.failedChecks.join('|') ?? 'none'}`,
    `fundingAvailableTime=${formatMaybe(report.pitEvidence.fundingExplicitAvailableTimeCoveragePct)}%, basis=${report.basisEvidence.available ? 'present' : 'missing'}, fees=${report.costEvidence.runtimeFeeStatus ?? 'missing'}, okxAuth=${report.costEvidence.okxPrivateAuthStatus ?? 'missing'}`,
    `paper=false, live=false, promotion=false`,
    `blockers=${report.blockers.slice(0, 12).join('|') || 'none'}`,
  ].join('\n')
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  const tokens = argv.filter(token => token !== '--')
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token?.startsWith('--')) continue
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) {
      out.set(body.slice(0, eq), body.slice(eq + 1))
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

function parseNullablePath(raw: string | undefined | null): string | null {
  if (raw == null) return null
  const normalized = raw.trim().toLowerCase()
  return !normalized || normalized === 'null' || normalized === 'false' || normalized === 'none'
    ? null
    : raw
}

function resolveOptionalPath(path: string | null): string | null {
  return path ? resolve(path) : null
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw.trim() === '') return fallback
  const normalized = raw.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function normalizeTimestampMs(value: unknown): number | null {
  const parsed = readNumber(value)
  if (parsed == null) return null
  return parsed > 1e11 ? Math.floor(parsed) : Math.floor(parsed * 1000)
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => readString(item)).filter((item): item is string => item != null)
    : []
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
}

function meanNullable(values: number[]): number | null {
  return values.length > 0 ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 6) : null
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number, digits: number): number {
  if (!Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function formatMaybe(value: number | null): string {
  return value == null ? 'null' : String(round(value, 6))
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_research_evidence_status failed:', error)
    process.exit(1)
  })
}
