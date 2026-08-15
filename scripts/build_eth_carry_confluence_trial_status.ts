import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runLedgerBoundFdrCorrection } from '../src/backtest/fdr.js'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type TrialStatus =
  | 'blocked_missing_inputs'
  | 'research_trial_insufficient_evidence'
  | 'research_trial_watch_only'

interface CliArgs {
  confluenceCandidatePath: string
  confluenceValidationPath: string
  signalDiagnosticsPath: string
  outputPath: string | null
  minTotalClosedOutcomes: number
  minSelectedBucketClosedOutcomes: number
  minValidationTrades: number
  minValidationWindows: number
  maxFdrQ: number
  minProfitProbability: number
  maxLossTailProbability: number
  json: boolean
}

interface TrialLedgerEntry {
  trialId: string
  candidateId: string
  sourceBucketId: string
  role: 'selected' | 'rejected' | 'avoid'
  closedOutcomes: number
  wins: number
  losses: number
  winRatePct: number | null
  meanGrossPct: number | null
  meanFundingCashflowPct: number | null
  meanRouteCostPct: number | null
  meanNetPct: number | null
  pValue: number
  pValueMethod: 'one_sided_binomial_win_rate_vs_50pct'
  pValueScope: 'prospective_bucket_closed_outcomes'
  pValuePromotionGrade: false
  pAdjustedBYRawM: number | null
  fdrPassed: boolean | null
  blockers: string[]
}

export interface EthCarryConfluenceTrialStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: TrialStatus
  sourceArtifacts: {
    confluenceCandidatePath: string
    confluenceValidationPath: string
    signalDiagnosticsPath: string
  }
  thresholds: {
    minTotalClosedOutcomes: number
    minSelectedBucketClosedOutcomes: number
    minValidationTrades: number
    minValidationWindows: number
    maxFdrQ: number
    minProfitProbability: number
    maxLossTailProbability: number
  }
  selectedCandidate: {
    candidateId: string | null
    sourceBucketId: string | null
  }
  trialLedger: {
    rawM: number
    rawMComplete: boolean
    includesFailedTrials: boolean
    fdrMethodPrimary: 'BY_raw_m'
    pValueSource: 'prospective_bucket_closed_outcomes'
    pValuePromotionGrade: false
    entries: TrialLedgerEntry[]
  }
  fdr: {
    status: 'not_computed' | 'computed_research_only'
    method: 'BY_raw_m'
    alpha: number
    selectedPValue: number | null
    selectedQValue: number | null
    selectedPassed: boolean | null
    harmonicFactorCm: number | null
    blocker: string | null
  }
  wfo: {
    status: 'missing' | 'fail' | 'pass_research_only'
    passedWindows: number | null
    failedWindows: number | null
    windowCount: number | null
    failedWindowRatio: number | null
  }
  riskSimulation: {
    status: 'missing' | 'fail' | 'pass_research_only'
    profitProbability: number | null
    lossTailProbability: number | null
  }
  evidenceCounts: {
    totalClosedOutcomes: number
    selectedBucketClosedOutcomes: number
    validationTrades: number
    validationWindows: number
  }
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_CONFLUENCE_CANDIDATE_PATH = 'data/research/eth_carry_confluence_candidate_status.latest.json'
const DEFAULT_CONFLUENCE_VALIDATION_PATH = 'data/research/eth_carry_confluence_validation.latest.json'
const DEFAULT_SIGNAL_DIAGNOSTICS_PATH = 'data/research/eth_carry_signal_diagnostics.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_confluence_trial_status.latest.json'
const DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_SELECTED_BUCKET_CLOSED_OUTCOMES = 30
const DEFAULT_MIN_VALIDATION_TRADES = 100
const DEFAULT_MIN_VALIDATION_WINDOWS = 3
const DEFAULT_MAX_FDR_Q = 0.1
const DEFAULT_MIN_PROFIT_PROBABILITY = 0.55
const DEFAULT_MAX_LOSS_TAIL_PROBABILITY = 0.45

async function main(): Promise<void> {
  const args = parseEthCarryConfluenceTrialStatusArgs(process.argv.slice(2))
  const report = await runEthCarryConfluenceTrialStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryConfluenceTrialStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    confluenceCandidatePath: raw.get('confluenceCandidatePath') ?? raw.get('candidatePath') ?? DEFAULT_CONFLUENCE_CANDIDATE_PATH,
    confluenceValidationPath: raw.get('confluenceValidationPath') ?? raw.get('validationPath') ?? DEFAULT_CONFLUENCE_VALIDATION_PATH,
    signalDiagnosticsPath: raw.get('signalDiagnosticsPath') ?? raw.get('diagnostics') ?? DEFAULT_SIGNAL_DIAGNOSTICS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    minTotalClosedOutcomes: parsePositiveInteger(raw.get('minTotalClosedOutcomes'), DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES, 'minTotalClosedOutcomes'),
    minSelectedBucketClosedOutcomes: parsePositiveInteger(raw.get('minSelectedBucketClosedOutcomes'), DEFAULT_MIN_SELECTED_BUCKET_CLOSED_OUTCOMES, 'minSelectedBucketClosedOutcomes'),
    minValidationTrades: parsePositiveInteger(raw.get('minValidationTrades'), DEFAULT_MIN_VALIDATION_TRADES, 'minValidationTrades'),
    minValidationWindows: parsePositiveInteger(raw.get('minValidationWindows'), DEFAULT_MIN_VALIDATION_WINDOWS, 'minValidationWindows'),
    maxFdrQ: parseProbability(raw.get('maxFdrQ'), DEFAULT_MAX_FDR_Q, 'maxFdrQ'),
    minProfitProbability: parseProbability(raw.get('minProfitProbability'), DEFAULT_MIN_PROFIT_PROBABILITY, 'minProfitProbability'),
    maxLossTailProbability: parseProbability(raw.get('maxLossTailProbability'), DEFAULT_MAX_LOSS_TAIL_PROBABILITY, 'maxLossTailProbability'),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryConfluenceTrialStatus(
  args: CliArgs,
): Promise<EthCarryConfluenceTrialStatusReport> {
  const startedAt = new Date()
  const confluenceCandidatePath = resolve(args.confluenceCandidatePath)
  const confluenceValidationPath = resolve(args.confluenceValidationPath)
  const signalDiagnosticsPath = resolve(args.signalDiagnosticsPath)
  const report = buildEthCarryConfluenceTrialStatusReport({
    generatedAt: new Date().toISOString(),
    confluenceCandidatePath,
    confluenceValidationPath,
    signalDiagnosticsPath,
    candidateArtifact: readJsonIfExists(confluenceCandidatePath),
    validationArtifact: readJsonIfExists(confluenceValidationPath),
    signalDiagnostics: readJsonIfExists(signalDiagnosticsPath),
    args,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_confluence_trial_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_missing_inputs' ? 'fail' : 'warn',
      recordsIn: report.trialLedger.entries.length,
      recordsOut: report.blockers.length,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildEthCarryConfluenceTrialStatusReport(input: {
  generatedAt?: string
  confluenceCandidatePath: string
  confluenceValidationPath: string
  signalDiagnosticsPath: string
  candidateArtifact?: unknown
  validationArtifact?: unknown
  signalDiagnostics?: unknown
  args: Pick<CliArgs, 'minTotalClosedOutcomes' | 'minSelectedBucketClosedOutcomes' | 'minValidationTrades' | 'minValidationWindows' | 'maxFdrQ' | 'minProfitProbability' | 'maxLossTailProbability'>
}): EthCarryConfluenceTrialStatusReport {
  const candidateArtifact = asRecord(input.candidateArtifact)
  const validationArtifact = asRecord(input.validationArtifact)
  const signalDiagnostics = asRecord(input.signalDiagnostics)
  const recommendedCandidate = asRecord(candidateArtifact?.recommendedCandidate)
  const selectedCandidateId = readString(recommendedCandidate?.candidateId)
  const selectedBucketId = readString(recommendedCandidate?.sourceBucketId)
  const buckets = readBuckets(candidateArtifact?.confluenceBuckets)
    .length > 0
    ? readBuckets(candidateArtifact?.confluenceBuckets)
    : readBuckets(signalDiagnostics?.byConfluence)
  const totalClosedOutcomes = readNumber(asRecord(signalDiagnostics?.counts)?.closedDiagnosticRows) ??
    sum(buckets.map(bucket => bucket.closedOutcomes))
  const selectedBucket = buckets.find(bucket => bucket.bucketId === selectedBucketId) ?? null
  const entries = buckets.map(bucket => buildTrialLedgerEntry({
    bucket,
    selectedBucketId,
  }))
  const fdr = computeFdr({
    entries,
    selectedBucketId,
    maxFdrQ: input.args.maxFdrQ,
  })
  const validationSummary = asRecord(validationArtifact?.summary)
  const validationCounts = asRecord(validationArtifact?.counts)
  const validationTrades = readNumber(validationCounts?.tradesBuilt) ?? 0
  const validationPassedWindows = readNumber(validationSummary?.passedWindows)
  const validationFailedWindows = readNumber(validationSummary?.failedWindows)
  const validationWindowCount = validationPassedWindows != null && validationFailedWindows != null
    ? validationPassedWindows + validationFailedWindows
    : null
  const failedWindowRatio = validationWindowCount != null && validationWindowCount > 0 && validationFailedWindows != null
    ? round(validationFailedWindows / validationWindowCount, 10)
    : null
  const wfoStatus = validationWindowCount == null || validationTrades <= 0
    ? 'missing'
    : validationTrades >= input.args.minValidationTrades &&
        validationWindowCount >= input.args.minValidationWindows &&
        validationFailedWindows === 0
      ? 'pass_research_only'
      : 'fail'
  const validationWinRatePct = readNumber(validationSummary?.winRatePct)
  const validationMeanNetPct = readNumber(validationSummary?.meanNetPct)
  const profitProbability = validationWinRatePct == null ? null : round(validationWinRatePct / 100, 10)
  const lossTailProbability = profitProbability == null ? null : round(1 - profitProbability, 10)
  const riskStatus = profitProbability == null || lossTailProbability == null
    ? 'missing'
    : profitProbability >= input.args.minProfitProbability &&
        lossTailProbability <= input.args.maxLossTailProbability &&
        validationMeanNetPct != null &&
        validationMeanNetPct > 0
      ? 'pass_research_only'
      : 'fail'
  const missingInputBlockers = uniqueStrings([
    ...(existsSync(input.confluenceCandidatePath) ? [] : ['confluence_candidate_status_missing']),
    ...(existsSync(input.confluenceValidationPath) ? [] : ['confluence_validation_missing']),
    ...(existsSync(input.signalDiagnosticsPath) ? [] : ['eth_carry_signal_diagnostics_missing']),
    ...(selectedCandidateId ? [] : ['selected_confluence_candidate_missing']),
    ...(selectedBucketId ? [] : ['selected_confluence_bucket_missing']),
    ...(buckets.length > 0 ? [] : ['confluence_trial_buckets_missing']),
  ])
  const blockers = uniqueStrings([
    ...missingInputBlockers,
    ...(totalClosedOutcomes >= input.args.minTotalClosedOutcomes
      ? []
      : [`trial_total_closed_outcomes_low:${totalClosedOutcomes}<${input.args.minTotalClosedOutcomes}`]),
    ...(selectedBucket && selectedBucket.closedOutcomes >= input.args.minSelectedBucketClosedOutcomes
      ? []
      : [`selected_bucket_closed_outcomes_low:${selectedBucket?.closedOutcomes ?? 0}<${input.args.minSelectedBucketClosedOutcomes}`]),
    ...(entries.length >= 2 ? [] : [`trial_raw_m_low:${entries.length}<2`]),
    ...(fdr.selectedQValue != null && fdr.selectedQValue <= input.args.maxFdrQ
      ? []
      : [`by_fdr_q_not_passed:${fdr.selectedQValue ?? 'missing'}>${input.args.maxFdrQ}`]),
    ...entries
      .filter(entry => entry.role === 'selected')
      .flatMap(entry => entry.blockers
        .filter(blocker => blocker !== 'p_value_not_promotion_grade')
        .map(blocker => `selected_trial:${blocker}`)),
    ...(wfoStatus === 'pass_research_only' ? [] : [`confluence_wfo_${wfoStatus}`]),
    ...(riskStatus === 'pass_research_only' ? [] : [`confluence_risk_simulation_${riskStatus}`]),
    'p_values_research_only_not_promotion_grade',
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry',
  ])
  const status = missingInputBlockers.length > 0
    ? 'blocked_missing_inputs'
    : blockers.every(isSafetyOrPromotionGradeBlocker)
      ? 'research_trial_watch_only'
      : 'research_trial_insufficient_evidence'

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    researchOnly: true,
    diagnosticOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    executionAllowed: false,
    status,
    sourceArtifacts: {
      confluenceCandidatePath: resolve(input.confluenceCandidatePath),
      confluenceValidationPath: resolve(input.confluenceValidationPath),
      signalDiagnosticsPath: resolve(input.signalDiagnosticsPath),
    },
    thresholds: {
      minTotalClosedOutcomes: input.args.minTotalClosedOutcomes,
      minSelectedBucketClosedOutcomes: input.args.minSelectedBucketClosedOutcomes,
      minValidationTrades: input.args.minValidationTrades,
      minValidationWindows: input.args.minValidationWindows,
      maxFdrQ: input.args.maxFdrQ,
      minProfitProbability: input.args.minProfitProbability,
      maxLossTailProbability: input.args.maxLossTailProbability,
    },
    selectedCandidate: {
      candidateId: selectedCandidateId,
      sourceBucketId: selectedBucketId,
    },
    trialLedger: {
      rawM: entries.length,
      rawMComplete: entries.length > 0,
      includesFailedTrials: entries.some(entry => entry.role !== 'selected'),
      fdrMethodPrimary: 'BY_raw_m',
      pValueSource: 'prospective_bucket_closed_outcomes',
      pValuePromotionGrade: false,
      entries: fdr.entries,
    },
    fdr: {
      status: fdr.status,
      method: 'BY_raw_m',
      alpha: input.args.maxFdrQ,
      selectedPValue: fdr.selectedPValue,
      selectedQValue: fdr.selectedQValue,
      selectedPassed: fdr.selectedPassed,
      harmonicFactorCm: fdr.harmonicFactorCm,
      blocker: fdr.blocker,
    },
    wfo: {
      status: wfoStatus,
      passedWindows: validationPassedWindows,
      failedWindows: validationFailedWindows,
      windowCount: validationWindowCount,
      failedWindowRatio,
    },
    riskSimulation: {
      status: riskStatus,
      profitProbability,
      lossTailProbability,
    },
    evidenceCounts: {
      totalClosedOutcomes,
      selectedBucketClosedOutcomes: selectedBucket?.closedOutcomes ?? 0,
      validationTrades,
      validationWindows: validationWindowCount ?? 0,
    },
    blockers,
    nextActions: buildNextActions(status, selectedCandidateId),
    safetyNotes: [
      'This artifact is a research-only trial accounting report; it must not authorize paper or live execution.',
      'The p-values are bucket-level prospective diagnostics and are explicitly not promotion-grade FDR evidence.',
      'All confluence buckets are included in raw_m so the report does not only account for the surviving selected bucket.',
      'Promotion still requires independent PIT WFO, promotion-grade BY/FDR, route-cost and slippage stress, risk simulation, prospective sample size, and paper execution telemetry.',
    ],
  }
}

function buildTrialLedgerEntry(input: {
  bucket: Bucket
  selectedBucketId: string | null
}): TrialLedgerEntry {
  const wins = input.bucket.winRatePct == null
    ? 0
    : Math.round(input.bucket.closedOutcomes * input.bucket.winRatePct / 100)
  const losses = Math.max(0, input.bucket.closedOutcomes - wins)
  const role = input.bucket.bucketId === input.selectedBucketId
    ? 'selected'
    : input.bucket.meanNetPct != null && input.bucket.meanNetPct < 0
      ? 'avoid'
      : 'rejected'
  const pValue = input.bucket.closedOutcomes > 0 && input.bucket.meanNetPct != null && input.bucket.meanNetPct > 0
    ? binomialUpperTail(input.bucket.closedOutcomes, wins, 0.5)
    : 1
  const blockers = uniqueStrings([
    ...(input.bucket.closedOutcomes > 0 ? [] : ['closed_outcomes_missing']),
    ...(input.bucket.meanNetPct != null && input.bucket.meanNetPct > 0 ? [] : [`mean_net_not_positive:${input.bucket.meanNetPct ?? 'missing'}`]),
    ...(input.bucket.winRatePct != null && input.bucket.winRatePct > 50 ? [] : [`win_rate_not_above_half:${input.bucket.winRatePct ?? 'missing'}`]),
    'p_value_not_promotion_grade',
  ])
  return {
    trialId: `eth_carry_confluence_trial_${sanitizeId(input.bucket.bucketId)}`,
    candidateId: `eth_carry_confluence_${sanitizeId(input.bucket.bucketId)}`,
    sourceBucketId: input.bucket.bucketId,
    role,
    closedOutcomes: input.bucket.closedOutcomes,
    wins,
    losses,
    winRatePct: input.bucket.winRatePct,
    meanGrossPct: input.bucket.meanGrossPct,
    meanFundingCashflowPct: input.bucket.meanFundingCashflowPct,
    meanRouteCostPct: input.bucket.meanRouteCostPct,
    meanNetPct: input.bucket.meanNetPct,
    pValue: round(pValue, 12),
    pValueMethod: 'one_sided_binomial_win_rate_vs_50pct',
    pValueScope: 'prospective_bucket_closed_outcomes',
    pValuePromotionGrade: false,
    pAdjustedBYRawM: null,
    fdrPassed: null,
    blockers,
  }
}

function computeFdr(input: {
  entries: TrialLedgerEntry[]
  selectedBucketId: string | null
  maxFdrQ: number
}): {
  status: 'not_computed' | 'computed_research_only'
  entries: TrialLedgerEntry[]
  selectedPValue: number | null
  selectedQValue: number | null
  selectedPassed: boolean | null
  harmonicFactorCm: number | null
  blocker: string | null
} {
  if (input.entries.length === 0) {
    return {
      status: 'not_computed',
      entries: input.entries,
      selectedPValue: null,
      selectedQValue: null,
      selectedPassed: null,
      harmonicFactorCm: null,
      blocker: 'trial_entries_missing',
    }
  }
  if (input.entries.length < 2 || !input.entries.some(entry => entry.role !== 'selected')) {
    return {
      status: 'not_computed',
      entries: input.entries,
      selectedPValue: input.entries.find(entry => entry.sourceBucketId === input.selectedBucketId)?.pValue ?? null,
      selectedQValue: null,
      selectedPassed: null,
      harmonicFactorCm: null,
      blocker: 'trial_raw_m_incomplete_or_survivor_only',
    }
  }
  const result = runLedgerBoundFdrCorrection({
    pValues: input.entries.map(entry => entry.pValue),
    alpha: input.maxFdrQ,
    trialLedger: {
      rawM: input.entries.length,
      rawMComplete: true,
      includesFailedTrials: input.entries.some(entry => entry.role !== 'selected'),
      failedTrialCount: input.entries.filter(entry => entry.role !== 'selected').length,
      survivingTrialCount: input.entries.filter(entry => entry.role === 'selected').length,
      fdrMethodPrimary: 'BY_raw_m',
    },
  })
  const byIndex = new Map(result.items.map(item => [item.index, item]))
  const entries = input.entries.map((entry, index) => {
    const item = byIndex.get(index)
    return {
      ...entry,
      pAdjustedBYRawM: item ? round(item.qValue, 12) : null,
      fdrPassed: item?.passed ?? null,
    }
  })
  const selected = entries.find(entry => entry.sourceBucketId === input.selectedBucketId) ?? null
  return {
    status: 'computed_research_only',
    entries,
    selectedPValue: selected?.pValue ?? null,
    selectedQValue: selected?.pAdjustedBYRawM ?? null,
    selectedPassed: selected?.fdrPassed ?? null,
    harmonicFactorCm: result.diagnostics.harmonicFactorCm,
    blocker: null,
  }
}

interface Bucket {
  bucketId: string
  closedOutcomes: number
  winRatePct: number | null
  meanGrossPct: number | null
  meanFundingCashflowPct: number | null
  meanRouteCostPct: number | null
  meanNetPct: number | null
}

function readBuckets(value: unknown): Bucket[] {
  return readRecordArray(value)
    .map(item => {
      const bucketId = readString(item.bucketId)
      if (!bucketId) return null
      return {
        bucketId,
        closedOutcomes: readNumber(item.closedOutcomes) ?? readNumber(item.count) ?? 0,
        winRatePct: readNumber(item.winRatePct),
        meanGrossPct: readNumber(item.meanGrossPct),
        meanFundingCashflowPct: readNumber(item.meanFundingCashflowPct),
        meanRouteCostPct: readNumber(item.meanRouteCostPct),
        meanNetPct: readNumber(item.meanNetPct),
      }
    })
    .filter((item): item is Bucket => item != null)
}

function binomialUpperTail(n: number, successes: number, p: number): number {
  if (!Number.isInteger(n) || n <= 0) return 1
  const boundedSuccesses = Math.max(0, Math.min(n, Math.round(successes)))
  let probability = 0
  for (let k = boundedSuccesses; k <= n; k += 1) {
    probability += binomialCoefficient(n, k) * (p ** k) * ((1 - p) ** (n - k))
  }
  return Math.max(0, Math.min(1, probability))
}

function binomialCoefficient(n: number, k: number): number {
  const boundedK = Math.min(k, n - k)
  let result = 1
  for (let i = 1; i <= boundedK; i += 1) {
    result = result * (n - boundedK + i) / i
  }
  return result
}

function buildNextActions(status: TrialStatus, selectedCandidateId: string | null): string[] {
  const actions = [
    'Keep this trial status research-only; do not publish paper/live targets or mutate best_config.json from it.',
  ]
  if (status !== 'research_trial_watch_only') {
    actions.push('Continue prospective labeling until selected and rejected confluence buckets have enough closed outcomes for stable FDR accounting.')
  }
  if (selectedCandidateId) {
    actions.push(`Use ${selectedCandidateId} only as a candidate for independent PIT WFO/BY-FDR/risk validation, not as execution evidence.`)
  }
  actions.push('Require paper execution telemetry only after release gates explicitly allow paper.')
  return actions
}

function isSafetyOrPromotionGradeBlocker(blocker: string): boolean {
  return blocker === 'p_values_research_only_not_promotion_grade' ||
    blocker === 'research_only_not_execution_evidence' ||
    blocker === 'paper_live_execution_disabled' ||
    blocker === 'requires_independent_wfo_by_fdr_route_cost_risk_and_paper_telemetry'
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return null
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (next && !next.startsWith('--')) {
      out.set(key, next)
      index += 1
    } else {
      out.set(key, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n'].includes(normalized)) return false
  return fallback
}

function parsePositiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`)
  return parsed
}

function parseProbability(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${label} must be within [0, 1]`)
  return parsed
}

function asRecord(value: unknown): UnknownRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null
}

function readRecordArray(value: unknown): UnknownRecord[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is UnknownRecord => item != null)
    : []
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase()
}

function renderConsoleSummary(report: EthCarryConfluenceTrialStatusReport): string {
  return [
    `eth carry confluence trial status: status=${report.status}`,
    `selected=${report.selectedCandidate.candidateId ?? 'none'} bucket=${report.selectedCandidate.sourceBucketId ?? 'none'}`,
    `rawM=${report.trialLedger.rawM} selectedClosed=${report.evidenceCounts.selectedBucketClosedOutcomes}/${report.thresholds.minSelectedBucketClosedOutcomes} totalClosed=${report.evidenceCounts.totalClosedOutcomes}/${report.thresholds.minTotalClosedOutcomes}`,
    `selectedQ=${report.fdr.selectedQValue ?? 'null'} wfo=${report.wfo.status} risk=${report.riskSimulation.status}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_confluence_trial_status failed:', error)
    process.exitCode = 1
  })
}
