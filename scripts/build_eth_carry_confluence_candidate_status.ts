import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

type UnknownRecord = Record<string, unknown>

type ConfluenceCandidateStatus =
  | 'blocked_missing_inputs'
  | 'no_positive_confluence_candidate'
  | 'research_candidate_insufficient_evidence'
  | 'research_candidate_ready_for_offline_validation'

interface CliArgs {
  signalDiagnosticsPath: string
  outputPath: string | null
  minTotalClosedOutcomes: number
  minBucketClosedOutcomes: number
  minBucketWinRatePct: number
  minBucketMeanNetPct: number
  json: boolean
}

interface SignalBucketDiagnostics {
  bucketId: string
  count: number
  closedOutcomes: number
  winRatePct: number | null
  meanGrossPct: number | null
  meanFundingCashflowPct: number | null
  meanRouteCostPct: number | null
  meanNetPct: number | null
}

interface ConfluenceRule {
  fundingSpreadSign: 'positive' | 'negative' | 'zero' | 'missing' | null
  basisSpreadDiffPctSign: 'positive' | 'negative' | 'zero' | 'missing' | null
  direction: string | null
}

interface ResearchCandidate {
  candidateId: string
  familyId: 'funding_carry_rebuild'
  researchOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  hypothesis: string
  rule: ConfluenceRule
  sourceBucketId: string
  evidence: SignalBucketDiagnostics
  requiredBeforeValidationClaim: string[]
}

export interface EthCarryConfluenceCandidateStatusReport {
  schemaVersion: 1
  generatedAt: string
  researchOnly: true
  diagnosticOnly: true
  promotionEligible: false
  paperTradingAllowed: false
  liveTradingAllowed: false
  executionAllowed: false
  status: ConfluenceCandidateStatus
  sourceArtifacts: {
    signalDiagnosticsPath: string
  }
  thresholds: {
    minTotalClosedOutcomes: number
    minBucketClosedOutcomes: number
    minBucketWinRatePct: number
    minBucketMeanNetPct: number
  }
  signalDiagnostics: {
    status: string | null
    closedDiagnosticRows: number | null
    meanNetPct: number | null
    winRateNetPct: number | null
    strongestPositiveBucket: string | null
    strongestNegativeBucket: string | null
  }
  recommendedCandidate: ResearchCandidate | null
  avoidListCandidate: ResearchCandidate | null
  confluenceBuckets: SignalBucketDiagnostics[]
  blockers: string[]
  nextActions: string[]
  safetyNotes: string[]
}

const DEFAULT_SIGNAL_DIAGNOSTICS_PATH = 'data/research/eth_carry_signal_diagnostics.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/research/eth_carry_confluence_candidate_status.latest.json'
const DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES = 100
const DEFAULT_MIN_BUCKET_CLOSED_OUTCOMES = 30
const DEFAULT_MIN_BUCKET_WIN_RATE_PCT = 55
const DEFAULT_MIN_BUCKET_MEAN_NET_PCT = 0

async function main(): Promise<void> {
  const args = parseEthCarryConfluenceCandidateStatusArgs(process.argv.slice(2))
  const report = await runEthCarryConfluenceCandidateStatus(args)
  if (args.json) console.log(JSON.stringify(report, null, 2))
  else console.log(renderConsoleSummary(report))
}

export function parseEthCarryConfluenceCandidateStatusArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  return {
    signalDiagnosticsPath: raw.get('signalDiagnosticsPath') ?? raw.get('diagnostics') ?? DEFAULT_SIGNAL_DIAGNOSTICS_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    minTotalClosedOutcomes: parsePositiveInteger(
      raw.get('minTotalClosedOutcomes'),
      DEFAULT_MIN_TOTAL_CLOSED_OUTCOMES,
      'minTotalClosedOutcomes',
    ),
    minBucketClosedOutcomes: parsePositiveInteger(
      raw.get('minBucketClosedOutcomes'),
      DEFAULT_MIN_BUCKET_CLOSED_OUTCOMES,
      'minBucketClosedOutcomes',
    ),
    minBucketWinRatePct: parseFiniteNumber(
      raw.get('minBucketWinRatePct'),
      DEFAULT_MIN_BUCKET_WIN_RATE_PCT,
      'minBucketWinRatePct',
    ),
    minBucketMeanNetPct: parseFiniteNumber(
      raw.get('minBucketMeanNetPct'),
      DEFAULT_MIN_BUCKET_MEAN_NET_PCT,
      'minBucketMeanNetPct',
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runEthCarryConfluenceCandidateStatus(
  args: CliArgs,
): Promise<EthCarryConfluenceCandidateStatusReport> {
  const startedAt = new Date()
  const signalDiagnosticsPath = resolve(args.signalDiagnosticsPath)
  const report = buildEthCarryConfluenceCandidateStatusReport({
    generatedAt: new Date().toISOString(),
    signalDiagnosticsPath,
    signalDiagnostics: readJsonIfExists(signalDiagnosticsPath),
    minTotalClosedOutcomes: args.minTotalClosedOutcomes,
    minBucketClosedOutcomes: args.minBucketClosedOutcomes,
    minBucketWinRatePct: args.minBucketWinRatePct,
    minBucketMeanNetPct: args.minBucketMeanNetPct,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'eth_carry_confluence_candidate_status',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.status === 'blocked_missing_inputs' ? 'fail' : 'warn',
      recordsIn: report.confluenceBuckets.length,
      recordsOut: report.recommendedCandidate ? 1 : 0,
      errorClass: report.blockers[0] ?? null,
    })
  }

  return report
}

export function buildEthCarryConfluenceCandidateStatusReport(input: {
  generatedAt?: string
  signalDiagnosticsPath: string
  signalDiagnostics?: unknown
  minTotalClosedOutcomes: number
  minBucketClosedOutcomes: number
  minBucketWinRatePct: number
  minBucketMeanNetPct: number
}): EthCarryConfluenceCandidateStatusReport {
  const signalDiagnostics = asRecord(input.signalDiagnostics)
  const summary = asRecord(signalDiagnostics?.summary)
  const counts = asRecord(signalDiagnostics?.counts)
  const confluenceBuckets = readBuckets(signalDiagnostics?.byConfluence)
  const closedDiagnosticRows = readNumber(counts?.closedDiagnosticRows)
  const recommendedBucket = selectRecommendedBucket(confluenceBuckets, input.minBucketMeanNetPct)
  const avoidBucket = selectAvoidBucket(confluenceBuckets)
  const recommendedCandidate = recommendedBucket
    ? buildCandidate({
        role: 'recommended',
        bucket: recommendedBucket,
      })
    : null
  const avoidListCandidate = avoidBucket
    ? buildCandidate({
        role: 'avoid',
        bucket: avoidBucket,
      })
    : null
  const blockers = uniqueStrings([
    ...(!signalDiagnostics ? ['eth_carry_signal_diagnostics_missing'] : []),
    ...(confluenceBuckets.length > 0 ? [] : ['eth_carry_confluence_buckets_missing']),
    ...(recommendedBucket ? [] : ['positive_confluence_bucket_missing']),
    ...(closedDiagnosticRows != null && closedDiagnosticRows >= input.minTotalClosedOutcomes
      ? []
      : [`prospective_closed_outcomes_low:${closedDiagnosticRows ?? 0}<${input.minTotalClosedOutcomes}`]),
    ...(recommendedBucket && recommendedBucket.closedOutcomes >= input.minBucketClosedOutcomes
      ? []
      : [`confluence_bucket_closed_outcomes_low:${recommendedBucket?.closedOutcomes ?? 0}<${input.minBucketClosedOutcomes}`]),
    ...(recommendedBucket?.winRatePct != null && recommendedBucket.winRatePct >= input.minBucketWinRatePct
      ? []
      : [`confluence_bucket_win_rate_low:${recommendedBucket?.winRatePct ?? 'missing'}<${input.minBucketWinRatePct}`]),
    ...(recommendedBucket?.meanNetPct != null && recommendedBucket.meanNetPct > input.minBucketMeanNetPct
      ? []
      : [`confluence_bucket_mean_net_not_positive:${recommendedBucket?.meanNetPct ?? 'missing'}<=${input.minBucketMeanNetPct}`]),
    'research_only_not_execution_evidence',
    'paper_live_execution_disabled',
    'wfo_fdr_pit_route_cost_prospective_paper_gates_required',
  ])
  const status = classifyStatus({
    hasSignalDiagnostics: signalDiagnostics != null,
    recommendedBucket,
    blockers,
  })

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
      signalDiagnosticsPath: resolve(input.signalDiagnosticsPath),
    },
    thresholds: {
      minTotalClosedOutcomes: input.minTotalClosedOutcomes,
      minBucketClosedOutcomes: input.minBucketClosedOutcomes,
      minBucketWinRatePct: input.minBucketWinRatePct,
      minBucketMeanNetPct: input.minBucketMeanNetPct,
    },
    signalDiagnostics: {
      status: readString(signalDiagnostics?.status),
      closedDiagnosticRows,
      meanNetPct: readNumber(summary?.meanNetPct),
      winRateNetPct: readNumber(summary?.winRateNetPct),
      strongestPositiveBucket: readString(summary?.strongestPositiveBucket),
      strongestNegativeBucket: readString(summary?.strongestNegativeBucket),
    },
    recommendedCandidate,
    avoidListCandidate,
    confluenceBuckets,
    blockers,
    nextActions: buildNextActions(status, recommendedCandidate, avoidListCandidate),
    safetyNotes: [
      'This artifact converts prospective diagnostics into research hypotheses only.',
      'Positive confluence evidence here is bucket-level label evidence, not a strategy pass, not account PnL, and not a profitability claim.',
      'Promotion still requires independent PIT WFO, BY/FDR, route-cost and slippage stress, risk simulation, prospective sample size, and paper execution telemetry.',
      'This artifact must not mutate best_config.json, paper targets, live orders, or release gates.',
    ],
  }
}

function classifyStatus(input: {
  hasSignalDiagnostics: boolean
  recommendedBucket: SignalBucketDiagnostics | null
  blockers: string[]
}): ConfluenceCandidateStatus {
  if (!input.hasSignalDiagnostics) return 'blocked_missing_inputs'
  if (!input.recommendedBucket) return 'no_positive_confluence_candidate'
  const onlySafetyBlockers = input.blockers.every(blocker =>
    blocker === 'research_only_not_execution_evidence' ||
    blocker === 'paper_live_execution_disabled' ||
    blocker === 'wfo_fdr_pit_route_cost_prospective_paper_gates_required',
  )
  return onlySafetyBlockers
    ? 'research_candidate_ready_for_offline_validation'
    : 'research_candidate_insufficient_evidence'
}

function selectRecommendedBucket(
  buckets: SignalBucketDiagnostics[],
  minBucketMeanNetPct: number,
): SignalBucketDiagnostics | null {
  const positive = buckets.filter(bucket =>
    bucket.meanNetPct != null &&
    bucket.meanNetPct > minBucketMeanNetPct &&
    bucket.closedOutcomes > 0,
  )
  if (positive.length === 0) return null
  return [...positive].sort(comparePositiveBuckets)[0]
}

function comparePositiveBuckets(left: SignalBucketDiagnostics, right: SignalBucketDiagnostics): number {
  return (
    (right.meanNetPct ?? -Infinity) - (left.meanNetPct ?? -Infinity) ||
    (right.winRatePct ?? -Infinity) - (left.winRatePct ?? -Infinity) ||
    right.closedOutcomes - left.closedOutcomes ||
    left.bucketId.localeCompare(right.bucketId)
  )
}

function selectAvoidBucket(buckets: SignalBucketDiagnostics[]): SignalBucketDiagnostics | null {
  const negative = buckets.filter(bucket => bucket.meanNetPct != null && bucket.meanNetPct < 0)
  if (negative.length === 0) return null
  return [...negative].sort((left, right) =>
    (left.meanNetPct ?? Infinity) - (right.meanNetPct ?? Infinity) ||
    right.closedOutcomes - left.closedOutcomes ||
    left.bucketId.localeCompare(right.bucketId),
  )[0]
}

function buildCandidate(input: {
  role: 'recommended' | 'avoid'
  bucket: SignalBucketDiagnostics
}): ResearchCandidate {
  const rule = parseConfluenceRule(input.bucket.bucketId)
  const ruleId = [
    rule.fundingSpreadSign ? `funding_${rule.fundingSpreadSign}` : 'funding_unknown',
    rule.basisSpreadDiffPctSign ? `basis_${rule.basisSpreadDiffPctSign}` : 'basis_unknown',
    rule.direction ?? 'direction_unknown',
  ].join('_')
  const candidateId = input.role === 'recommended'
    ? `eth_carry_confluence_filter_${ruleId}`
    : `eth_carry_confluence_avoid_${ruleId}`

  return {
    candidateId: sanitizeId(candidateId),
    familyId: 'funding_carry_rebuild',
    researchOnly: true,
    promotionEligible: false,
    paperTradingAllowed: false,
    liveTradingAllowed: false,
    hypothesis: input.role === 'recommended'
      ? 'Trade only the carry confluence bucket that has positive route-cost-adjusted prospective labels, then verify with independent PIT WFO and FDR.'
      : 'Avoid the carry confluence bucket that has the worst route-cost-adjusted prospective labels, then verify out-of-sample.',
    rule,
    sourceBucketId: input.bucket.bucketId,
    evidence: input.bucket,
    requiredBeforeValidationClaim: [
      'closed_outcomes_gte_threshold',
      'non_overlapping_prospective_windows_gte_threshold',
      'pit_wfo_pass',
      'by_fdr_pass',
      'route_cost_and_slippage_stress_pass',
      'risk_simulation_pass',
      'trial_ledger_complete',
      'paper_execution_telemetry_available_after_release_gate',
    ],
  }
}

function parseConfluenceRule(bucketId: string): ConfluenceRule {
  const match = /^confluence:funding_([^:]+):basis_([^:]+):direction_(.+)$/.exec(bucketId)
  if (!match) {
    return {
      fundingSpreadSign: null,
      basisSpreadDiffPctSign: null,
      direction: null,
    }
  }
  return {
    fundingSpreadSign: normalizeSign(match[1]),
    basisSpreadDiffPctSign: normalizeSign(match[2]),
    direction: match[3],
  }
}

function normalizeSign(value: string): ConfluenceRule['fundingSpreadSign'] {
  return ['positive', 'negative', 'zero', 'missing'].includes(value)
    ? value as ConfluenceRule['fundingSpreadSign']
    : null
}

function buildNextActions(
  status: ConfluenceCandidateStatus,
  recommendedCandidate: ResearchCandidate | null,
  avoidListCandidate: ResearchCandidate | null,
): string[] {
  const actions = [
    'Keep this confluence candidate research-only and do not publish paper/live targets from it.',
  ]
  if (recommendedCandidate) {
    actions.push(`Run an offline PIT WFO/FDR validation for ${recommendedCandidate.candidateId} before considering any prospective expansion.`)
    actions.push(`Continue prospective labeling until ${recommendedCandidate.sourceBucketId} has enough closed outcomes across non-overlapping windows.`)
  } else {
    actions.push('Continue prospective labeling before selecting a confluence filter candidate.')
  }
  if (avoidListCandidate) {
    actions.push(`Treat ${avoidListCandidate.sourceBucketId} as an avoid-list hypothesis until out-of-sample evidence disproves it.`)
  }
  if (status === 'research_candidate_ready_for_offline_validation') {
    actions.push('Build a dedicated offline validator that consumes this rule and emits PIT WFO, BY/FDR, route-cost, and risk-simulation evidence.')
  }
  return actions
}

function readBuckets(value: unknown): SignalBucketDiagnostics[] {
  return readRecordArray(value)
    .map(row => ({
      bucketId: readString(row.bucketId) ?? '',
      count: readNonNegativeInteger(row.count) ?? 0,
      closedOutcomes: readNonNegativeInteger(row.closedOutcomes) ?? readNonNegativeInteger(row.count) ?? 0,
      winRatePct: readNumber(row.winRatePct),
      meanGrossPct: readNumber(row.meanGrossPct),
      meanFundingCashflowPct: readNumber(row.meanFundingCashflowPct),
      meanRouteCostPct: readNumber(row.meanRouteCostPct),
      meanNetPct: readNumber(row.meanNetPct),
    }))
    .filter(row => row.bucketId.startsWith('confluence:'))
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

function parseFiniteNumber(value: string | undefined, fallback: number, label: string): number {
  if (value == null) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite number`)
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

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readNumber(value)
  return parsed != null && Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function sanitizeId(value: string): string {
  return value
    .replaceAll('/', '_')
    .replaceAll(':', '_')
    .replaceAll('-', '_')
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
}

function renderConsoleSummary(report: EthCarryConfluenceCandidateStatusReport): string {
  return [
    `eth carry confluence candidate status: status=${report.status}`,
    `closed=${report.signalDiagnostics.closedDiagnosticRows ?? 'null'}/${report.thresholds.minTotalClosedOutcomes}`,
    `candidate=${report.recommendedCandidate?.candidateId ?? 'none'}`,
    `bucket=${report.recommendedCandidate?.sourceBucketId ?? 'none'} meanNet=${report.recommendedCandidate?.evidence.meanNetPct ?? 'null'} win=${report.recommendedCandidate?.evidence.winRatePct ?? 'null'} count=${report.recommendedCandidate?.evidence.closedOutcomes ?? 0}`,
    `paper=false live=false promotion=false execution=false`,
    report.blockers.length > 0 ? `blockers=${report.blockers.slice(0, 8).join(',')}` : 'blockers=none',
  ].join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('build_eth_carry_confluence_candidate_status failed:', error)
    process.exitCode = 1
  })
}
