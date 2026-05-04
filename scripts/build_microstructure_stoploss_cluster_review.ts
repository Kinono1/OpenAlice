import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'
import type {
  MicrostructureStoplossReplayReport,
  ReplayClusterDiagnostic,
  ReplayClusterDimension,
  ReplayVariantName,
} from './run_microstructure_stoploss_replay.js'

export interface MicrostructureStoplossClusterReviewArgs {
  inputPath: string
  outputPath: string | null
  maxClusters: number
  minClosedTrades: number
  minStopLossTrades: number
  minStopLossLossSharePct: number
  json: boolean
}

export type StoplossClusterReviewAction =
  | 'shadow_downweight_candidate'
  | 'pro_review_required'
  | 'insufficient_sample'

export interface StoplossClusterReviewThresholds {
  minClosedTrades: number
  minStopLossTrades: number
  minStopLossLossSharePct: number
  baselineTotalPnlPctMustBeNegative: true
  baselinePfMustBeBelowOne: true
}

export interface StoplossClusterReviewItem {
  dimension: ReplayClusterDimension
  key: string
  lane?: string
  symbol?: string
  side?: 'long' | 'short'
  closedTrades: number
  stopLossTrades: number
  earliestCloseTs: string | null
  latestCloseTs: string | null
  baselineTotalPnlPct: number
  baselinePF: number | null
  baselineWinRate: number | null
  stopLossLossSharePct: number
  maxLossPct: number
  cap25DeltaPct: number | null
  cap10DeltaPct: number | null
  stressStopLossDeltaPct: number | null
  recommendedReviewAction: StoplossClusterReviewAction
  killCandidate: boolean
  killReason: string[]
  reviewReason: string[]
  diagnosticUse: 'closed_row_cluster_review'
  promotionEligible: false
  policyMutationAllowed: false
}

export interface MicrostructureStoplossClusterReviewReport {
  schemaVersion: 1
  generatedAt: string
  sourceReportPath: string
  sourceReportManifestPath: string | null
  sourceArtifactHash: string
  sourceManifest: {
    present: boolean
    artifactHash: string | null
    hashMatchesSourceReport: boolean | null
    evidenceTrust: EvidenceManifest['evidenceTrust'] | null
    dqStatus: EvidenceManifest['dqStatus'] | null
    businessStatus: EvidenceManifest['businessStatus'] | null
  }
  sourceReplay: {
    generatedAt: string
    counterfactualType: MicrostructureStoplossReplayReport['counterfactualType']
    scope: MicrostructureStoplossReplayReport['scope']
    metricBasis: MicrostructureStoplossReplayReport['metricBasis']
    coverage: MicrostructureStoplossReplayReport['coverage']
  }
  diagnosticOnly: true
  promotionEligible: false
  policyMutationAllowed: false
  thresholds: StoplossClusterReviewThresholds
  coverage: {
    sourceClusters: number
    riskyClustersConsidered: number
    reviewedClusters: number
    killCandidates: number
    proReviewRequired: number
    shadowDownweightCandidates: number
    insufficientSample: number
  }
  clusters: StoplossClusterReviewItem[]
  notes: string[]
}

const DEFAULT_INPUT_PATH = 'data/runtime/microstructure_stoploss_replay.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/microstructure_stoploss_cluster_review.latest.json'
const DEFAULT_MAX_CLUSTERS = 25
const DEFAULT_MIN_CLOSED_TRADES = 20
const DEFAULT_MIN_STOP_LOSS_TRADES = 5
const DEFAULT_MIN_STOP_LOSS_LOSS_SHARE_PCT = 40

export function parseMicrostructureStoplossClusterReviewArgs(
  argv: string[],
): MicrostructureStoplossClusterReviewArgs {
  const raw = parseRawArgs(argv)
  return {
    inputPath: raw.get('inputPath') ?? raw.get('input') ?? DEFAULT_INPUT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxClusters: parsePositiveInteger(raw.get('maxClusters'), DEFAULT_MAX_CLUSTERS),
    minClosedTrades: parsePositiveInteger(raw.get('minClosedTrades'), DEFAULT_MIN_CLOSED_TRADES),
    minStopLossTrades: parsePositiveInteger(raw.get('minStopLossTrades'), DEFAULT_MIN_STOP_LOSS_TRADES),
    minStopLossLossSharePct: parsePositiveNumber(
      raw.get('minStopLossLossSharePct'),
      DEFAULT_MIN_STOP_LOSS_LOSS_SHARE_PCT,
    ),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runMicrostructureStoplossClusterReview(
  args: MicrostructureStoplossClusterReviewArgs,
): Promise<MicrostructureStoplossClusterReviewReport> {
  const startedAt = new Date()
  const inputPath = resolve(args.inputPath)
  const inputRaw = await readFile(inputPath, 'utf-8')
  const sourceReport = JSON.parse(inputRaw) as MicrostructureStoplossReplayReport
  const sourceManifestPath = `${inputPath}.manifest.json`
  const sourceManifest = readSourceManifest(sourceManifestPath)
  const report = buildMicrostructureStoplossClusterReviewReport({
    sourceReport,
    sourceReportPath: inputPath,
    sourceReportRaw: inputRaw,
    sourceManifest,
    sourceManifestPath: existsSync(sourceManifestPath) ? sourceManifestPath : null,
    maxClusters: args.maxClusters,
    minClosedTrades: args.minClosedTrades,
    minStopLossTrades: args.minStopLossTrades,
    minStopLossLossSharePct: args.minStopLossLossSharePct,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'microstructure_stoploss_cluster_review',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.coverage.killCandidates > 0 ? 'warn' : 'pass',
      recordsIn: report.coverage.sourceClusters,
      recordsOut: report.coverage.reviewedClusters,
      errorClass: report.coverage.killCandidates > 0 ? 'microstructure_stoploss_kill_candidates' : null,
    })
  }

  return report
}

export function buildMicrostructureStoplossClusterReviewReport(input: {
  sourceReport: MicrostructureStoplossReplayReport
  sourceReportPath: string
  sourceReportRaw?: string
  sourceManifest?: EvidenceManifest | null
  sourceManifestPath?: string | null
  maxClusters?: number
  minClosedTrades?: number
  minStopLossTrades?: number
  minStopLossLossSharePct?: number
  generatedAt?: string
}): MicrostructureStoplossClusterReviewReport {
  const thresholds: StoplossClusterReviewThresholds = {
    minClosedTrades: input.minClosedTrades ?? DEFAULT_MIN_CLOSED_TRADES,
    minStopLossTrades: input.minStopLossTrades ?? DEFAULT_MIN_STOP_LOSS_TRADES,
    minStopLossLossSharePct: input.minStopLossLossSharePct ?? DEFAULT_MIN_STOP_LOSS_LOSS_SHARE_PCT,
    baselineTotalPnlPctMustBeNegative: true,
    baselinePfMustBeBelowOne: true,
  }
  const sourceReportRaw = input.sourceReportRaw ?? `${JSON.stringify(input.sourceReport, null, 2)}\n`
  const sourceArtifactHash = sha256Hex(sourceReportRaw)
  const sourceManifest = input.sourceManifest ?? null
  const riskyClusters = input.sourceReport.clusterDiagnostics
    .map(cluster => buildReviewItem(cluster, thresholds))
    .filter(isRiskyReviewItem)
    .sort(compareReviewItems)
  const clusters = riskyClusters.slice(0, input.maxClusters ?? DEFAULT_MAX_CLUSTERS)
  const counts = summarizeReviewItems(clusters)

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceReportPath: resolve(input.sourceReportPath),
    sourceReportManifestPath: input.sourceManifestPath ? resolve(input.sourceManifestPath) : null,
    sourceArtifactHash,
    sourceManifest: {
      present: sourceManifest != null,
      artifactHash: sourceManifest?.artifactHash ?? null,
      hashMatchesSourceReport: sourceManifest?.artifactHash == null ? null : sourceManifest.artifactHash === sourceArtifactHash,
      evidenceTrust: sourceManifest?.evidenceTrust ?? null,
      dqStatus: sourceManifest?.dqStatus ?? null,
      businessStatus: sourceManifest?.businessStatus ?? null,
    },
    sourceReplay: {
      generatedAt: input.sourceReport.generatedAt,
      counterfactualType: input.sourceReport.counterfactualType,
      scope: input.sourceReport.scope,
      metricBasis: input.sourceReport.metricBasis,
      coverage: input.sourceReport.coverage,
    },
    diagnosticOnly: true,
    promotionEligible: false,
    policyMutationAllowed: false,
    thresholds,
    coverage: {
      sourceClusters: input.sourceReport.clusterDiagnostics.length,
      riskyClustersConsidered: riskyClusters.length,
      reviewedClusters: clusters.length,
      killCandidates: counts.killCandidates,
      proReviewRequired: counts.proReviewRequired,
      shadowDownweightCandidates: counts.shadowDownweightCandidates,
      insufficientSample: counts.insufficientSample,
    },
    clusters,
    notes: [
      'Diagnostic-only review input for Pro/human investigation; this artifact must not mutate strategy, leverage, stop-loss, or live routing.',
      'Cluster metrics are closed-row attribution from the replay report, not a portfolio counterfactual and not promotion evidence.',
      'killCandidate means the cluster deserves explicit retirement/downweight review; it does not authorize automatic policy mutation.',
      'sourceManifest.hashMatchesSourceReport=false invalidates the review as trusted evidence until the source replay artifact is regenerated.',
    ],
  }
}

export function renderMicrostructureStoplossClusterReviewMarkdown(
  report: MicrostructureStoplossClusterReviewReport,
): string {
  const lines: string[] = []
  lines.push('# Microstructure Stop-Loss Cluster Review')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Source: \`${report.sourceReportPath}\``)
  lines.push(`Diagnostic only: \`${report.diagnosticOnly}\``)
  lines.push(`Promotion eligible: \`${report.promotionEligible}\``)
  lines.push(`Policy mutation allowed: \`${report.policyMutationAllowed}\``)
  lines.push(`Source manifest hash match: \`${report.sourceManifest.hashMatchesSourceReport}\``)
  lines.push('')
  lines.push('## Coverage')
  lines.push('')
  lines.push(`- Source clusters: ${report.coverage.sourceClusters}`)
  lines.push(`- Risky clusters considered: ${report.coverage.riskyClustersConsidered}`)
  lines.push(`- Reviewed clusters: ${report.coverage.reviewedClusters}`)
  lines.push(`- Kill candidates: ${report.coverage.killCandidates}`)
  lines.push('')
  lines.push('## Clusters')
  lines.push('')
  lines.push('| action | kill | dimension | key | trades | stopLoss | baselinePnlPct | PF | stopLossLossSharePct | cap25DeltaPct | cap10DeltaPct | stressDeltaPct | reasons |')
  lines.push('| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const cluster of report.clusters) {
    lines.push([
      `| ${cluster.recommendedReviewAction}`,
      String(cluster.killCandidate),
      cluster.dimension,
      cluster.key,
      String(cluster.closedTrades),
      String(cluster.stopLossTrades),
      formatNumber(cluster.baselineTotalPnlPct),
      formatNullable(cluster.baselinePF),
      formatNumber(cluster.stopLossLossSharePct),
      formatNullable(cluster.cap25DeltaPct),
      formatNullable(cluster.cap10DeltaPct),
      formatNullable(cluster.stressStopLossDeltaPct),
      cluster.reviewReason.join(', '),
    ].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## Notes')
  lines.push('')
  for (const note of report.notes) lines.push(`- ${note}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function buildReviewItem(
  cluster: ReplayClusterDiagnostic,
  thresholds: StoplossClusterReviewThresholds,
): StoplossClusterReviewItem {
  const baseline = requireVariant(cluster, 'baseline')
  const cap25 = findVariant(cluster, 'cap_leverage_25x')
  const cap10 = findVariant(cluster, 'cap_leverage_10x')
  const stress = findVariant(cluster, 'stress_stop_loss_loss_1_5x')
  const baselinePF = baseline.metrics.PF
  const baselineTotalPnlPct = baseline.metrics.totalPnlPct
  const stopLossLossSharePct = baseline.metrics.stopLossLossSharePct
  const reviewReason = buildReviewReasons({
    closedTrades: cluster.coverage.closedTrades,
    stopLossTrades: cluster.coverage.stopLossTrades,
    baselineTotalPnlPct,
    baselinePF,
    stopLossLossSharePct,
    thresholds,
  })
  const insufficientSample = cluster.coverage.closedTrades < thresholds.minClosedTrades ||
    cluster.coverage.stopLossTrades < thresholds.minStopLossTrades
  const killCandidate = !insufficientSample &&
    baselineTotalPnlPct < 0 &&
    baselinePF != null &&
    baselinePF < 1 &&
    stopLossLossSharePct >= thresholds.minStopLossLossSharePct
  const recommendedReviewAction: StoplossClusterReviewAction = insufficientSample
    ? 'insufficient_sample'
    : killCandidate
      ? 'shadow_downweight_candidate'
      : 'pro_review_required'

  return {
    dimension: cluster.dimension,
    key: cluster.key,
    lane: cluster.lane,
    symbol: cluster.symbol,
    side: cluster.side,
    closedTrades: cluster.coverage.closedTrades,
    stopLossTrades: cluster.coverage.stopLossTrades,
    earliestCloseTs: cluster.coverage.earliestCloseTs,
    latestCloseTs: cluster.coverage.latestCloseTs,
    baselineTotalPnlPct,
    baselinePF,
    baselineWinRate: baseline.metrics.winRate,
    stopLossLossSharePct,
    maxLossPct: baseline.metrics.maxLossPct,
    cap25DeltaPct: cap25?.deltaVsBaseline.totalPnlPct ?? null,
    cap10DeltaPct: cap10?.deltaVsBaseline.totalPnlPct ?? null,
    stressStopLossDeltaPct: stress?.deltaVsBaseline.totalPnlPct ?? null,
    recommendedReviewAction,
    killCandidate,
    killReason: killCandidate ? [
      `closed_trades>=${thresholds.minClosedTrades}`,
      `stop_loss_trades>=${thresholds.minStopLossTrades}`,
      'baseline_total_pnl_pct<0',
      'baseline_pf<1',
      `stop_loss_loss_share_pct>=${thresholds.minStopLossLossSharePct}`,
    ] : insufficientSample ? ['insufficient_sample'] : [],
    reviewReason,
    diagnosticUse: 'closed_row_cluster_review',
    promotionEligible: false,
    policyMutationAllowed: false,
  }
}

function buildReviewReasons(input: {
  closedTrades: number
  stopLossTrades: number
  baselineTotalPnlPct: number
  baselinePF: number | null
  stopLossLossSharePct: number
  thresholds: StoplossClusterReviewThresholds
}): string[] {
  const reasons: string[] = []
  if (input.closedTrades < input.thresholds.minClosedTrades) reasons.push(`closed_trades<${input.thresholds.minClosedTrades}`)
  if (input.stopLossTrades < input.thresholds.minStopLossTrades) reasons.push(`stop_loss_trades<${input.thresholds.minStopLossTrades}`)
  if (input.stopLossTrades >= input.thresholds.minStopLossTrades) reasons.push(`stop_loss_trades>=${input.thresholds.minStopLossTrades}`)
  if (input.baselineTotalPnlPct < 0) reasons.push('baseline_total_pnl_pct<0')
  if (input.baselinePF != null && input.baselinePF < 1) reasons.push('baseline_pf<1')
  if (input.baselinePF == null) reasons.push('baseline_pf_missing')
  if (input.stopLossLossSharePct >= input.thresholds.minStopLossLossSharePct) {
    reasons.push(`stop_loss_loss_share_pct>=${input.thresholds.minStopLossLossSharePct}`)
  }
  return reasons
}

function isRiskyReviewItem(item: StoplossClusterReviewItem): boolean {
  return item.stopLossTrades > 0 ||
    item.baselineTotalPnlPct < 0 ||
    item.baselinePF == null ||
    item.baselinePF < 1 ||
    item.stopLossLossSharePct > 0
}

function compareReviewItems(a: StoplossClusterReviewItem, b: StoplossClusterReviewItem): number {
  return Number(b.killCandidate) - Number(a.killCandidate) ||
    b.stopLossTrades - a.stopLossTrades ||
    a.baselineTotalPnlPct - b.baselineTotalPnlPct ||
    b.stopLossLossSharePct - a.stopLossLossSharePct ||
    b.closedTrades - a.closedTrades ||
    a.dimension.localeCompare(b.dimension) ||
    a.key.localeCompare(b.key)
}

function summarizeReviewItems(items: StoplossClusterReviewItem[]): {
  killCandidates: number
  proReviewRequired: number
  shadowDownweightCandidates: number
  insufficientSample: number
} {
  return {
    killCandidates: items.filter(item => item.killCandidate).length,
    proReviewRequired: items.filter(item => item.recommendedReviewAction === 'pro_review_required').length,
    shadowDownweightCandidates: items.filter(item => item.recommendedReviewAction === 'shadow_downweight_candidate').length,
    insufficientSample: items.filter(item => item.recommendedReviewAction === 'insufficient_sample').length,
  }
}

function findVariant(cluster: ReplayClusterDiagnostic, name: ReplayVariantName) {
  return cluster.variants.find(variant => variant.name === name) ?? null
}

function requireVariant(cluster: ReplayClusterDiagnostic, name: ReplayVariantName) {
  const variant = findVariant(cluster, name)
  if (!variant) throw new Error(`Cluster ${cluster.dimension}:${cluster.key} is missing ${name} variant`)
  return variant
}

function readSourceManifest(path: string): EvidenceManifest | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as EvidenceManifest
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const withoutPrefix = arg.slice(2)
    const eq = withoutPrefix.indexOf('=')
    if (eq >= 0) {
      out.set(withoutPrefix.slice(0, eq), withoutPrefix.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) {
      out.set(withoutPrefix, next)
      i += 1
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function parseNullablePath(value: string | undefined): string | null {
  if (value === undefined) return null
  const normalized = value.trim()
  if (normalized === '' || normalized.toLowerCase() === 'null') return null
  return normalized
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected positive integer, got ${value}`)
  return parsed
}

function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive number, got ${value}`)
  return parsed
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function sha256Hex(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

function formatNullable(value: number | null): string {
  return value == null ? 'null' : formatNumber(value)
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseMicrostructureStoplossClusterReviewArgs(argv)
  const report = await runMicrostructureStoplossClusterReview(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderMicrostructureStoplossClusterReviewMarkdown(report))
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
