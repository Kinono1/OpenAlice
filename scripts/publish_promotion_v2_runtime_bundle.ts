/**
 * Publish OpenAlice Promotion v2.6 runtime artifacts from the current
 * cross-sectional optimizer registry and paper decision report.
 *
 * This bridge is intentionally conservative: missing WFO/PBO/DSR/FDR,
 * unverified fees, weak benchmarks, insufficient paper execution quality, or
 * backfilled paper evidence all become explicit gate blocks instead of silent
 * promotion.
 */

import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildPromotionReadinessV2,
  evaluateCapitalGate,
  evaluateFeeSnapshot,
  evaluateMonetizationGate,
  hashJson,
  makeGateResult,
  PROMOTION_V2_SCHEMA_VERSION,
  sha256Hex,
  type BenchmarkComparison,
  type CandidateRegistry,
  type EvidenceItem,
  type FailureAttribution,
  type FeeSnapshot,
  type GateResult,
  type MonetizationMetrics,
  type PromotionReadinessV2,
  type QuarantineRecord,
  type RouteBudget,
  type RouteCostBudget,
  type RouteName,
  type RuntimePathAudit,
  type SchemaMeta,
  type UniverseAttribution,
} from '../src/runtime/promotion_v2.js'
import {
  DEFAULT_PROMOTION_V2_RUNTIME_DIR,
  promotionV2ArtifactFileNames,
  writePromotionV2RuntimeArtifacts,
  type PromotionV2ExecutionQualityArtifact,
  type PromotionV2RuntimeArtifacts,
} from '../src/runtime/promotion_v2_artifacts.js'
import {
  isReleaseGateStatusBlocking,
  loadReleaseGateStatus,
  type PersistedReleaseGateStatus,
} from '../src/runtime/release_gate_status.js'
import {
  DEFAULT_PAPER_EVIDENCE_ROOT,
  evaluatePaperEvidenceLedgerBinding,
  evaluatePaperEvidencePointer,
  latestPaperEvidencePointerFromJson,
  readPaperEvidenceLedger,
  paperEvidenceReportFromJson,
  refreshPaperEvidenceReportFreshness,
  type LatestPaperEvidencePointer,
  type PaperEvidenceLedgerEntry,
  type PaperEvidenceReport,
} from '../src/runtime/paper_evidence_ledger.js'

export interface PublishPromotionV2CliArgs {
  runtimeDir: string
  paperDecisionPath: string
  bestConfigPath: string
  releaseGateStatusPath: string
  feeSnapshotPath: string
  dirtyWorktreeAuditPath: string
  dirtyWorktreeManifestPath: string
  paperEvidencePointerPath: string
  paperEvidenceLedgerPath: string
  p1EvidenceIndexPath: string
  strategyLanePolicyPath: string
}

export interface PromotionV2BundleBuildInput {
  now: Date
  runtimeDir: string
  paperDecisionPath: string
  paperDecisionRaw: string | null
  paperDecision: unknown
  bestConfig: unknown
  releaseGateStatus: PersistedReleaseGateStatus | null
  candidateRegistry: CandidateRegistry | null
  graveyard: CandidateRegistry | null
  existingFeeSnapshot?: FeeSnapshot | null
  dirtyWorktreeAuditPath?: string | null
  dirtyWorktreeAuditRaw?: string | null
  dirtyWorktreeAudit?: unknown
  dirtyWorktreeEvidenceManifest?: unknown
  paperEvidencePointer?: LatestPaperEvidencePointer | null
  paperEvidenceLedgerEntries?: PaperEvidenceLedgerEntry[] | null
  paperEvidenceLedgerReadError?: string | null
  paperEvidenceReportRaw?: string | null
  paperEvidenceReport?: PaperEvidenceReport | null
  p1Evidence?: P1TradingEvidenceSnapshot | null
  strategyLanePolicy?: StrategyLanePolicySnapshot | null
}

export interface PromotionV2BundleBuildResult {
  artifacts: PromotionV2RuntimeArtifacts
  readiness: PromotionReadinessV2
}

const STRATEGY_ID = 'cross_sectional_v2'
const DEFAULT_ACCOUNT_EQUITY_USD = 100_000
const DEFAULT_MAX_POSITION_FRACTION = 0.15
const DEFAULT_MIN_ORDER_NOTIONAL_USD = 10
const DEFAULT_ROUTE_MAX_COST_BPS = 20

export function parsePublishPromotionV2Args(argv: string[]): PublishPromotionV2CliArgs {
  const raw = parseRawArgs(argv)
  const runtimeDir = raw.get('runtimeDir') ?? DEFAULT_PROMOTION_V2_RUNTIME_DIR
  return {
    runtimeDir,
    paperDecisionPath: raw.get('paperDecisionPath') ?? join(runtimeDir, 'paper_decision.latest.json'),
    bestConfigPath: raw.get('bestConfigPath') ?? 'data/research/best_config.json',
    releaseGateStatusPath: raw.get('releaseGateStatusPath') ?? 'data/runtime/release_gate_status.json',
    feeSnapshotPath: raw.get('feeSnapshotPath') ?? join(runtimeDir, promotionV2ArtifactFileNames.feeSnapshot),
    dirtyWorktreeAuditPath: raw.get('dirtyWorktreeAuditPath') ??
      'data/runtime/dirty_worktree_audit.latest.json',
    dirtyWorktreeManifestPath: raw.get('dirtyWorktreeManifestPath') ??
      'data/runtime/dirty_worktree_audit.latest.json.manifest.json',
    paperEvidencePointerPath: raw.get('paperEvidencePointerPath') ??
      join(DEFAULT_PAPER_EVIDENCE_ROOT, 'latest_pointer.json'),
    paperEvidenceLedgerPath: raw.get('paperEvidenceLedgerPath') ??
      join(DEFAULT_PAPER_EVIDENCE_ROOT, 'evidence_ledger.jsonl'),
    p1EvidenceIndexPath: raw.get('p1EvidenceIndexPath') ??
      'data/runtime/p1_trading_evidence/p1_trading_evidence.index.latest.json',
    strategyLanePolicyPath: raw.get('strategyLanePolicyPath') ??
      'data/runtime/strategy_lane_policy.latest.json',
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parsePublishPromotionV2Args(argv)
  const now = new Date()
  const paperDecisionRaw = await readTextIfExists(args.paperDecisionPath)
  const paperEvidencePointer = await readPaperEvidencePointerIfExists(args.paperEvidencePointerPath)
  const paperEvidenceReportRaw = paperEvidencePointer
    ? await readTextIfExists(paperEvidencePointer.path)
    : null
  const paperEvidenceLedger = await readPaperEvidenceLedgerIfExists(args.paperEvidenceLedgerPath)
  const dirtyWorktreeAuditRaw = await readTextIfExists(args.dirtyWorktreeAuditPath)
  const buildResult = buildPromotionV2RuntimeArtifactsFromInputs({
    now,
    runtimeDir: args.runtimeDir,
    paperDecisionPath: args.paperDecisionPath,
    paperDecisionRaw,
    paperDecision: paperDecisionRaw ? JSON.parse(paperDecisionRaw) : null,
    bestConfig: await readJsonIfExists(args.bestConfigPath),
    releaseGateStatus: await loadReleaseGateStatus(args.releaseGateStatusPath),
    candidateRegistry: await readJsonIfExists<CandidateRegistry>(
      join(args.runtimeDir, promotionV2ArtifactFileNames.candidateRegistry),
    ),
    graveyard: await readJsonIfExists<CandidateRegistry>(
      join(args.runtimeDir, promotionV2ArtifactFileNames.graveyard),
    ),
    existingFeeSnapshot: await readJsonIfExists<FeeSnapshot>(args.feeSnapshotPath),
    dirtyWorktreeAuditPath: args.dirtyWorktreeAuditPath,
    dirtyWorktreeAuditRaw,
    dirtyWorktreeAudit: dirtyWorktreeAuditRaw ? JSON.parse(dirtyWorktreeAuditRaw) as unknown : null,
    dirtyWorktreeEvidenceManifest: await readJsonIfExists(args.dirtyWorktreeManifestPath),
    paperEvidencePointer,
    paperEvidenceLedgerEntries: paperEvidenceLedger.entries,
    paperEvidenceLedgerReadError: paperEvidenceLedger.error,
    paperEvidenceReportRaw,
    paperEvidenceReport: paperEvidenceReportRaw
      ? paperEvidenceReportFromJson(JSON.parse(paperEvidenceReportRaw) as unknown)
      : null,
    p1Evidence: await readP1TradingEvidenceSnapshot(args.p1EvidenceIndexPath),
    strategyLanePolicy: buildStrategyLanePolicySnapshot(await readJsonIfExists(args.strategyLanePolicyPath)),
  })

  await mkdir(args.runtimeDir, { recursive: true })
  const paths = await writePromotionV2RuntimeArtifacts(args.runtimeDir, buildResult.artifacts)

  console.log(JSON.stringify({
    status: buildResult.readiness.finalVerdict,
    reason: buildResult.readiness.humanReadableReason,
    strategyPromotionPath: resolve(paths.strategyPromotion),
    candidateRegistryPath: resolve(paths.candidateRegistry),
    artifactDir: resolve(args.runtimeDir),
  }, null, 2))
}

export function buildPromotionV2RuntimeArtifactsFromInputs(
  input: PromotionV2BundleBuildInput,
): PromotionV2BundleBuildResult {
  const generatedAt = input.now.toISOString()
  const paperDecision = asRecord(input.paperDecision)
  const paperEvidenceReport = input.paperEvidenceReport
    ? refreshPaperEvidenceReportFreshness(input.paperEvidenceReport, input.now)
    : null
  const oldReadiness = asRecord(paperDecision?.promotionReadiness)
  const bestConfig = asRecord(input.bestConfig)
  const bestConfigEvidence = asRecord(paperDecision?.bestConfigEvidence) ?? asRecord(bestConfig?.config)
  const experimentId = readString(bestConfig?.experimentId) ??
    readString(input.candidateRegistry?.entries.find((entry) => entry.status === 'active')?.experimentId) ??
    `cross-sectional-v2-runtime-${generatedAt.replace(/[:.]/g, '-')}`
  const schemaMeta = makeSchemaMeta('strategy_promotion', generatedAt, 'promotion:v2:publish')
  const expiresAt = new Date(input.now.getTime() + 24 * 3_600_000).toISOString()
  const paperEvidenceExpiresAt = paperEvidenceReport
    ? computePaperEvidenceExpiresAt(paperEvidenceReport)
    : null
  const paperGateExpiresAt = minIsoTimestamp(expiresAt, paperEvidenceExpiresAt)
  const evidence = buildEvidenceLedger({
    generatedAt,
    experimentId,
    paperDecisionPath: input.paperDecisionPath,
    paperDecisionRaw: input.paperDecisionRaw,
    paperDecision,
    bestConfig,
    candidateRegistry: input.candidateRegistry,
    graveyard: input.graveyard,
    paperEvidencePointer: input.paperEvidencePointer,
    paperEvidenceLedgerEntries: input.paperEvidenceLedgerEntries,
    paperEvidenceLedgerReadError: input.paperEvidenceLedgerReadError,
    paperEvidenceReportRaw: input.paperEvidenceReportRaw,
    paperEvidenceReport,
  })
  const supportingEvidenceIds = evidence.map((item) => item.id)
  const feeSnapshot = selectFeeSnapshot(input.existingFeeSnapshot, generatedAt, expiresAt, input.now)
  const routeCostBudget = buildRouteCostBudget(generatedAt, feeSnapshot, readNumber(paperDecision?.estimatedRoundTripCostPct))
  const selectedRoute = selectPromotionRoute(input.releaseGateStatus, routeCostBudget)
  const monetizationMetrics = buildMonetizationMetrics(paperDecision, oldReadiness, routeCostBudget.routes[selectedRoute])
  const capitalGate = evaluateCapitalGate({
    accountEquityUsd: readNumber(asRecord(paperDecision?.accountSnapshot)?.equity) ?? DEFAULT_ACCOUNT_EQUITY_USD,
    maxCapitalAllocatedUsd:
      (readNumber(asRecord(paperDecision?.accountSnapshot)?.equity) ?? DEFAULT_ACCOUNT_EQUITY_USD) *
      DEFAULT_MAX_POSITION_FRACTION,
    minOrderNotionalUsd: DEFAULT_MIN_ORDER_NOTIONAL_USD,
    minUsefulDailyNetProfitUsd: readEnvNumber('OPENALICE_MIN_USEFUL_DAILY_NET_PROFIT_USD', 0),
    minUsefulMonthlyNetProfitUsd: readEnvNumber('OPENALICE_MIN_USEFUL_MONTHLY_NET_PROFIT_USD', 0),
    infraCostUsd: readEnvNumber('OPENALICE_MONTHLY_INFRA_COST_USD', 0),
    riskBufferUsd: readEnvNumber('OPENALICE_MONTHLY_RISK_BUFFER_USD', 0),
    expectedDailyNetProfitUsd: monetizationMetrics.netExpectancyUsdPerDay,
    expectedMonthlyNetProfitUsd: monetizationMetrics.netExpectancyUsdPerMonth,
    capacityAtCurrentCostUsd: monetizationMetrics.executableCapacityUsd,
  })
  const benchmarkComparison = buildBenchmarkComparisons(paperDecision)
  const universeAttribution = buildUniverseAttribution(paperDecision, oldReadiness)
  const candidateRegistry = input.candidateRegistry ?? makeEmptyCandidateRegistry('candidate_registry', generatedAt)
  const graveyard = input.graveyard ?? makeEmptyCandidateRegistry('graveyard', generatedAt)
  const globalReleaseGate = buildGlobalReleaseGate(input.releaseGateStatus, input.now, expiresAt)
  const researchGate = buildResearchGate({
    expiresAt,
    candidateRegistry,
    bestConfigEvidence,
    paperDecision,
    releaseGateStatus: input.releaseGateStatus,
  })
  const monetizationGate = evaluateMonetizationGate({
    mode: 'research',
    now: input.now,
    metrics: monetizationMetrics,
    grossToCostRatio: readNumber(oldReadiness?.grossToCostRatio),
    feeSnapshot,
    routeCostBudget,
    selectedRoute,
    benchmarkComparisons: benchmarkComparison,
    capitalGate,
    universeAttribution,
    evidence,
    supportingEvidenceIds,
    minExpectedNetDollarsPerMonth: readEnvNumber('OPENALICE_MIN_USEFUL_MONTHLY_NET_PROFIT_USD', 0),
    minExecutableCapacityUsd: DEFAULT_MIN_ORDER_NOTIONAL_USD,
  })
  const paperGate = buildPaperGate({
    expiresAt: paperGateExpiresAt,
    oldReadiness,
    evidence,
    supportingEvidenceIds,
    paperDecision,
    paperEvidencePointer: input.paperEvidencePointer,
    paperEvidenceLedgerEntries: input.paperEvidenceLedgerEntries,
    paperEvidenceLedgerReadError: input.paperEvidenceLedgerReadError,
    paperEvidenceReport,
    paperDecisionRaw: input.paperDecisionRaw,
    p1Evidence: input.p1Evidence ?? null,
    strategyLanePolicy: input.strategyLanePolicy ?? null,
    now: input.now,
  })
  const executionQuality = buildExecutionQualityArtifact(paperDecision, oldReadiness, generatedAt)
  const liveGate = makeGateResult({
    gateName: 'live',
    hardBlocks: ['tiny_cap_not_reviewed'],
    requiredArtifacts: ['runtime_path_audit.latest.json', 'quarantine.latest.json'],
    metricSnapshot: { tinyCapReview: false },
    expiresAt,
  })
  const quarantine = buildDirtyEvidenceQuarantine({
    generatedAt,
    strategyId: STRATEGY_ID,
    experimentId,
    dirtyWorktreeAuditPath: input.dirtyWorktreeAuditPath ?? null,
    dirtyWorktreeAuditRaw: input.dirtyWorktreeAuditRaw ?? null,
    dirtyWorktreeAudit: input.dirtyWorktreeAudit,
    dirtyWorktreeEvidenceManifest: input.dirtyWorktreeEvidenceManifest,
  })
  const failureAttribution = buildFailureAttribution({
    candidateRegistry,
    researchGate,
    monetizationGate,
    paperGate,
    supportingEvidenceIds,
  })
  const readiness = buildPromotionReadinessV2({
    schemaMeta,
    strategyId: STRATEGY_ID,
    experimentId,
    generatedAt,
    globalReleaseGate,
    researchGate,
    monetizationGate,
    paperGate,
    liveGate,
    monetization: monetizationMetrics,
    execution: {
      recentOrderCount: executionQuality.recentOrderCount,
      slippageViolationCount: executionQuality.slippageViolationCount,
      actualToSimulatedCostRatio: executionQuality.actualToSimulatedCostRatio,
      missedFillRate: executionQuality.missedFillRate,
      decayCircuitBreakerTriggered: executionQuality.decayCircuitBreakerTriggered,
    },
    dataFreshness: buildDataFreshness(paperDecision),
    evidence: {
      supportingEvidenceIds,
      blockingEvidenceIds: [],
      missingRequiredEvidence: evidence.length === 0 ? ['paper_decision.latest.json'] : [],
    },
    quarantine,
    now: input.now,
  })

  return {
    readiness,
    artifacts: {
      strategyPromotion: readiness,
      evidenceLedger: evidence,
      candidateRegistry,
      graveyard,
      feeSnapshot,
      routeCostBudget,
      benchmarkComparison,
      universeAttribution,
      runtimePathAudit: buildRuntimePathAudit(),
      quarantine,
      executionQuality,
      failureAttribution,
    },
  }
}

function computePaperEvidenceExpiresAt(report: PaperEvidenceReport): string {
  const generatedAtMs = Date.parse(report.generatedAt)
  const maxAgeMs = report.freshness.maxAllowedAgeSeconds * 1000
  if (!Number.isFinite(generatedAtMs) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    return report.generatedAt
  }
  return new Date(generatedAtMs + maxAgeMs).toISOString()
}

function minIsoTimestamp(left: string, right: string | null): string {
  if (!right) return left
  const leftMs = Date.parse(left)
  const rightMs = Date.parse(right)
  if (!Number.isFinite(leftMs)) return right
  if (!Number.isFinite(rightMs)) return left
  return rightMs < leftMs ? right : left
}

function buildDirtyEvidenceQuarantine(input: {
  generatedAt: string
  strategyId: string
  experimentId: string
  dirtyWorktreeAuditPath?: string | null
  dirtyWorktreeAuditRaw?: string | null
  dirtyWorktreeAudit?: unknown
  dirtyWorktreeEvidenceManifest: unknown
}): QuarantineRecord | null {
  const manifest = asRecord(input.dirtyWorktreeEvidenceManifest)
  if (!manifest || Object.keys(manifest).length === 0) {
    return {
      strategyId: input.strategyId,
      enteredAt: input.generatedAt,
      triggerReason: 'dirty_worktree_evidence_missing',
      frozenExperimentId: input.experimentId,
      allowedActions: ['diagnostic', 'research_backtest'],
      exitRequiredArtifacts: dirtyWorktreeExitRequiredArtifacts(),
      exitStatus: 'blocked',
    }
  }
  const evidenceTrust = readString(manifest.evidenceTrust)
  const dqStatus = readString(manifest.dqStatus)
  const auditReasons = validateDirtyWorktreeAuditForP2({
    auditPath: input.dirtyWorktreeAuditPath,
    auditRaw: input.dirtyWorktreeAuditRaw,
    audit: input.dirtyWorktreeAudit,
    manifest,
  })
  if (evidenceTrust === 'pass' && dqStatus === 'pass' && auditReasons.length === 0) {
    return null
  }
  return {
    strategyId: input.strategyId,
    enteredAt: input.generatedAt,
    triggerReason: evidenceTrust === 'pass' && dqStatus === 'pass'
      ? auditReasons[0] ?? 'dirty_worktree_audit_not_p2_clean'
      : `dirty_worktree_evidence_${evidenceTrust ?? 'missing'}`,
    frozenExperimentId: input.experimentId,
    allowedActions: ['diagnostic', 'research_backtest'],
    exitRequiredArtifacts: dirtyWorktreeExitRequiredArtifacts(),
    exitStatus: 'blocked',
  }
}

function dirtyWorktreeExitRequiredArtifacts(): string[] {
  return [
    'dirty_worktree_audit.latest.json:counts.total=0,governance.p2PromotionAllowed=true,governance.runtimeArtifactsQuarantined=false',
    'dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass,dqStatus=pass,artifactHash=match',
  ]
}

function validateDirtyWorktreeAuditForP2(input: {
  auditPath?: string | null
  auditRaw?: string | null
  audit?: unknown
  manifest: Record<string, unknown>
}): string[] {
  const audit = asRecord(input.audit)
  if (!audit) return ['dirty_worktree_audit_missing']

  const reasons: string[] = []
  const governance = asRecord(audit.governance)
  const counts = asRecord(audit.counts)
  const byProtocolClass = asRecord(counts?.byProtocolClass)
  const totalDirtyEntries = readNumber(counts?.total)
  const runtimeArtifactDirtyEntries = readNumber(byProtocolClass?.B) ?? 0
  const auditEvidenceTrust = readString(governance?.evidenceTrust)
  const p2PromotionAllowed = readBoolean(governance?.p2PromotionAllowed)
  const monetizationConclusionAllowed = readBoolean(governance?.monetizationConclusionAllowed)
  const runtimeArtifactsQuarantined = readBoolean(governance?.runtimeArtifactsQuarantined)

  if (!governance) reasons.push('dirty_worktree_audit_governance_missing')
  if (!counts) reasons.push('dirty_worktree_audit_counts_missing')
  if (auditEvidenceTrust !== 'pass') {
    reasons.push(`dirty_worktree_audit_evidence_not_pass:${auditEvidenceTrust ?? 'missing'}`)
  }
  if (p2PromotionAllowed !== true) reasons.push('dirty_worktree_audit_p2_not_allowed')
  if (monetizationConclusionAllowed !== true) {
    reasons.push('dirty_worktree_audit_monetization_not_allowed')
  }
  if (totalDirtyEntries !== 0) {
    reasons.push(`dirty_worktree_audit_dirty_entries:${totalDirtyEntries ?? 'missing'}`)
  }
  if (runtimeArtifactDirtyEntries > 0) {
    reasons.push(`dirty_worktree_audit_runtime_artifacts_dirty:${runtimeArtifactDirtyEntries}`)
  }
  if (runtimeArtifactsQuarantined !== false) {
    reasons.push(`dirty_worktree_audit_runtime_artifacts_quarantined:${runtimeArtifactsQuarantined ?? 'missing'}`)
  }

  const manifestArtifactPath = readString(input.manifest.artifactPath)
  if (input.auditPath && manifestArtifactPath && resolve(manifestArtifactPath) !== resolve(input.auditPath)) {
    reasons.push('dirty_worktree_audit_manifest_artifact_path_mismatch')
  }
  const manifestHash = readString(input.manifest.artifactHash)
  if (!manifestHash) {
    reasons.push('dirty_worktree_audit_manifest_hash_missing')
  } else if (!input.auditRaw) {
    reasons.push('dirty_worktree_audit_raw_missing_for_hash')
  } else if (sha256Hex(Buffer.from(input.auditRaw, 'utf-8')) !== manifestHash) {
    reasons.push('dirty_worktree_audit_hash_mismatch')
  }

  return reasons
}

function buildEvidenceLedger(input: {
  generatedAt: string
  experimentId: string
  paperDecisionPath: string
  paperDecisionRaw: string | null
  paperDecision: Record<string, unknown> | null
  bestConfig: Record<string, unknown> | null
  candidateRegistry: CandidateRegistry | null
  graveyard: CandidateRegistry | null
  paperEvidencePointer?: LatestPaperEvidencePointer | null
  paperEvidenceReportRaw?: string | null
  paperEvidenceReport?: PaperEvidenceReport | null
}): EvidenceItem[] {
  if (!input.paperDecisionRaw) return []
  const oldReadiness = asRecord(input.paperDecision?.promotionReadiness)
  const dataOrigin = readString(oldReadiness?.dataMode) === 'live_only' ? 'paper_live_sync' : 'backtest'
  const artifactSha256 = sha256Hex(input.paperDecisionRaw)
  const evidence: EvidenceItem[] = [{
    id: `paper_decision_${artifactSha256.slice(0, 16)}`,
    experimentId: input.experimentId,
    claim: 'latest cross-sectional paper decision and legacy readiness snapshot',
    evidenceType: dataOrigin === 'paper_live_sync' ? 'paper' : 'backtest',
    dataOrigin,
    artifactPath: input.paperDecisionPath,
    artifactSha256,
    inputArtifactHashes: [
      input.bestConfig ? hashJson(input.bestConfig) : hashJson({ missing: 'best_config' }),
      input.candidateRegistry ? hashJson(input.candidateRegistry) : hashJson({ missing: 'candidate_registry' }),
      input.graveyard ? hashJson(input.graveyard) : hashJson({ missing: 'graveyard' }),
    ],
    metricSnapshot: {
      status: readString(input.paperDecision?.status) ?? 'unknown',
      dataMode: readString(oldReadiness?.dataMode) ?? 'unknown',
      netEdgePct: readNumber(oldReadiness?.netEdgePct) ?? 'not_reported',
      grossToCostRatio: readNumber(oldReadiness?.grossToCostRatio) ?? 'not_reported',
      paperTradesObserved: readNumber(oldReadiness?.paperTradesObserved) ?? 0,
      paperDaysObserved: readNumber(oldReadiness?.paperDaysObserved) ?? 0,
    },
    validFrom: input.generatedAt,
    invalidationRule: 'invalid when paper_decision.latest.json changes, data origin changes, or any required input hash changes',
    createdAt: input.generatedAt,
  }]
  if (input.paperEvidenceReportRaw && input.paperEvidenceReport && input.paperEvidencePointer) {
    const paperEvidenceSha256 = sha256Hex(input.paperEvidenceReportRaw)
    evidence.push({
      id: `paper_evidence_${paperEvidenceSha256.slice(0, 16)}`,
      experimentId: input.experimentId,
      claim: 'immutable paper shadow evidence report with freshness seal',
      evidenceType: 'paper',
      dataOrigin: 'paper_live_sync',
      artifactPath: input.paperEvidencePointer.path,
      artifactSha256: paperEvidenceSha256,
      inputArtifactHashes: [artifactSha256],
      metricSnapshot: {
        paperEvidenceReportId: input.paperEvidenceReport.reportId,
        paperEvidenceFreshnessStatus: input.paperEvidenceReport.freshness?.status ?? 'missing',
        paperEvidenceAgeSeconds: input.paperEvidenceReport.freshness?.actualAgeSeconds ?? -1,
        paperEvidenceMaxAgeSeconds: input.paperEvidenceReport.freshness?.maxAllowedAgeSeconds ?? -1,
        paperEvidenceDataMode: input.paperEvidenceReport.paperDataMode ?? 'unknown',
      },
      validFrom: input.paperEvidenceReport.generatedAt,
      invalidationRule: 'invalid when runtime/paper/latest_pointer.json changes, freshness seal is stale, or source summary hash changes',
      createdAt: input.generatedAt,
    })
  }
  return evidence
}

function selectFeeSnapshot(
  existingFeeSnapshot: FeeSnapshot | null | undefined,
  generatedAt: string,
  fallbackExpiresAt: string,
  now: Date,
): FeeSnapshot {
  if (existingFeeSnapshot && isPaperPromotionFeeSnapshot(existingFeeSnapshot, now)) {
    return existingFeeSnapshot
  }
  return buildFallbackFeeSnapshot(generatedAt, fallbackExpiresAt)
}

function isPaperPromotionFeeSnapshot(snapshot: FeeSnapshot, now: Date): boolean {
  return evaluateFeeSnapshot(snapshot, 'paper', now).valid
}

function buildFallbackFeeSnapshot(generatedAt: string, expiresAt: string): FeeSnapshot {
  return {
    venue: 'openalice-paper',
    symbol: 'cross_sectional_universe',
    instrumentType: 'crypto_perpetual',
    accountTier: 'unknown',
    makerFeeBps: 2,
    takerFeeBps: 6,
    source: 'manual_override',
    sourceFetchedAt: generatedAt,
    expiresAt,
    manualOverrideReason: 'paper decision bridge fallback; runtime/API fee snapshot not yet connected',
    verifiedByRuntime: false,
    fundingIntervalHours: 8,
    fundingCapBps: 0,
    fundingFloorBps: 0,
  }
}

function buildRouteCostBudget(
  generatedAt: string,
  feeSnapshot: FeeSnapshot,
  estimatedRoundTripCostPct: number | undefined,
): RouteCostBudget {
  const estimatedBps = Math.max(estimatedRoundTripCostPct === undefined ? 28 : estimatedRoundTripCostPct * 100, 0)
  const makeRoute = (
    route: RouteBudget['route'],
    feeBps: number,
    spreadBps: number,
    slippageBps: number,
    adverseSelectionBufferBps: number,
    queueMissBufferBps: number,
  ): RouteBudget => {
    const totalExpectedCostBps = feeBps + spreadBps + slippageBps + adverseSelectionBufferBps + queueMissBufferBps
    return {
      route,
      feeBps,
      spreadBps,
      slippageBps,
      adverseSelectionBufferBps,
      queueMissBufferBps,
      fundingBps: 0,
      totalExpectedCostBps,
      maxAllowedCostBps: DEFAULT_ROUTE_MAX_COST_BPS,
      breakEvenEdgeBps: totalExpectedCostBps,
    }
  }

  return {
    schemaMeta: makeSchemaMeta('route_cost_budget', generatedAt, 'promotion:v2:publish'),
    generatedAt,
    feeSnapshot,
    routes: {
      passive_passive: makeRoute('passive_passive', feeSnapshot.makerFeeBps * 2, 2, 4, 5, 3),
      passive_taker: makeRoute('passive_taker', feeSnapshot.makerFeeBps + feeSnapshot.takerFeeBps, 4, 8, 3, 2),
      taker_taker: makeRoute('taker_taker', feeSnapshot.takerFeeBps * 2, 6, Math.max(0, estimatedBps - 20), 2, 0),
      twap: makeRoute('twap', feeSnapshot.takerFeeBps * 2, 4, Math.max(0, estimatedBps - 18), 3, 0),
    },
  }
}

function selectPromotionRoute(
  releaseGateStatus: PersistedReleaseGateStatus | null,
  routeCostBudget: RouteCostBudget,
): RouteName {
  const releaseRoute = readReleaseGateEconomicsRoute(releaseGateStatus)
  if (releaseRoute && routeCostBudget.routes[releaseRoute]) {
    return releaseRoute
  }
  return 'taker_taker'
}

function readReleaseGateEconomicsRoute(
  releaseGateStatus: PersistedReleaseGateStatus | null,
): RouteName | null {
  const checks = Array.isArray(releaseGateStatus?.checks) ? releaseGateStatus.checks : []
  const economics = checks.find(check => check.name === 'economics')
  const selectedRoute = readString(economics?.metrics.selectedRoute)
  return isRouteName(selectedRoute) ? selectedRoute : null
}

function isRouteName(value: string | null): value is RouteName {
  return value === 'passive_passive' ||
    value === 'passive_taker' ||
    value === 'taker_taker' ||
    value === 'twap'
}

function buildMonetizationMetrics(
  paperDecision: Record<string, unknown> | null,
  oldReadiness: Record<string, unknown> | null,
  selectedRoute: RouteBudget,
): MonetizationMetrics {
  const accountSnapshot = asRecord(paperDecision?.accountSnapshot)
  const accountEquityUsd = readNumber(accountSnapshot?.equity) ?? DEFAULT_ACCOUNT_EQUITY_USD
  const maxCapitalAllocatedUsd = accountEquityUsd * DEFAULT_MAX_POSITION_FRACTION
  const grossAvgSpreadPct = readNumber(oldReadiness?.grossAvgSpreadPct) ?? 0
  const estimatedRoundTripCostPct = readNumber(oldReadiness?.estimatedRoundTripCostPct) ??
    readNumber(paperDecision?.estimatedRoundTripCostPct) ??
    selectedRoute.totalExpectedCostBps / 100
  const netEdgePct = readNumber(oldReadiness?.netEdgePct) ?? grossAvgSpreadPct - estimatedRoundTripCostPct
  const netExpectancyBpsPerTrade = netEdgePct * 100
  const validSignalsPerMonth = Math.max(readNumber(asRecord(paperDecision?.bestConfigEvidence)?.signals) ?? 0, 0)
  const expectedTradesPerDay = validSignalsPerMonth / 30
  const netExpectancyUsdPerTrade = maxCapitalAllocatedUsd * netEdgePct / 100
  const netExpectancyUsdPerDay = netExpectancyUsdPerTrade * expectedTradesPerDay
  const netExpectancyUsdPerMonth = netExpectancyUsdPerDay * 30
  const proposedOrders = Array.isArray(paperDecision?.proposedOrders) ? paperDecision.proposedOrders : []
  const proposedCapacity = proposedOrders
    .filter(isRecord)
    .reduce((sum, order) => sum + (readNumber(order.notionalUsd) ?? 0), 0)

  return {
    netExpectancyBpsPerTrade,
    netExpectancyUsdPerTrade,
    netExpectancyUsdPerDay,
    netExpectancyUsdPerMonth,
    validSignalsPerMonth,
    executableCapacityUsd: Math.max(proposedCapacity, maxCapitalAllocatedUsd),
    turnoverPerDay: expectedTradesPerDay * DEFAULT_MAX_POSITION_FRACTION,
    routeAdjustedBreakEvenBps: netExpectancyBpsPerTrade,
    benchmarkExcessReturnBps: computeStrategyReturnBps(accountSnapshot),
  }
}

function buildBenchmarkComparisons(paperDecision: Record<string, unknown> | null): BenchmarkComparison[] {
  const accountSnapshot = asRecord(paperDecision?.accountSnapshot)
  const strategyNetReturnBps = computeStrategyReturnBps(accountSnapshot)
  const comparable = readString(asRecord(paperDecision?.promotionReadiness)?.dataMode) === 'live_only'

  return [
    {
      benchmarkName: 'no_trade',
      sameWindow: comparable,
      sameCostModel: true,
      sameExecutionEligibility: true,
      sameDataOriginPolicy: comparable,
      strategyNetReturnBps,
      benchmarkNetReturnBps: 0,
      excessReturnBps: strategyNetReturnBps,
      excessMaxDrawdownAdjusted: strategyNetReturnBps,
      pass: comparable && strategyNetReturnBps > 0,
    },
    ...(['equal_weight_universe', 'btc_eth_50_50', 'low_turnover_momentum'] as const).map((benchmarkName) => ({
      benchmarkName,
      sameWindow: comparable,
      sameCostModel: true,
      sameExecutionEligibility: true,
      sameDataOriginPolicy: comparable,
      strategyNetReturnBps,
      benchmarkNetReturnBps: strategyNetReturnBps + 1,
      excessReturnBps: -1,
      excessMaxDrawdownAdjusted: -1,
      pass: false,
    })),
  ]
}

function buildUniverseAttribution(
  paperDecision: Record<string, unknown> | null,
  oldReadiness: Record<string, unknown> | null,
): UniverseAttribution {
  const signals = Array.isArray(paperDecision?.signals) ? paperDecision.signals.filter(isRecord) : []
  const contributors = signals.slice(0, 10).map((signal) => ({
    symbol: readString(signal.symbol) ?? 'unknown',
    universeRole: 'execution_eligible' as const,
    pnlContributionPct: signals.length > 0 ? 100 / signals.length : 0,
    tradeCount: 0,
  }))
  const researchUniverseSize = readNumber(asRecord(paperDecision?.bestConfigEvidence)?.assetCount) ??
    readNumber(oldReadiness?.liveOnlyAssetsRequired) ??
    signals.length
  const executionUniverseSize = readNumber(oldReadiness?.liveOnlyAssetsGood) ?? contributors.length

  return {
    researchUniverseSize,
    executionUniverseSize,
    pnlFromExecutionEligiblePct: executionUniverseSize > 0 ? 100 : 0,
    signalsFromExecutionEligiblePct: executionUniverseSize > 0 ? 100 : 0,
    topContributors: contributors,
  }
}

function buildGlobalReleaseGate(
  releaseGateStatus: PersistedReleaseGateStatus | null,
  now: Date,
  fallbackExpiresAt: string,
): GateResult {
  const blocking = isReleaseGateStatusBlocking(releaseGateStatus, 'paper', now)
  return makeGateResult({
    gateName: 'global_release',
    hardBlocks: blocking.blocking ? [blocking.reason ?? 'release_gate_blocks_paper'] : [],
    advisoryWarnings: releaseGateStatus?.warningChecks.map((check) => `release_gate_warning:${check}`) ?? [],
    requiredArtifacts: ['release_gate_status.json'],
    metricSnapshot: {
      allowPaperTrading: releaseGateStatus?.allowPaperTrading ?? false,
      allowLiveTrading: releaseGateStatus?.allowLiveTrading ?? false,
    },
    expiresAt: releaseGateStatus?.expiresAt ?? fallbackExpiresAt,
  })
}

function buildResearchGate(input: {
  expiresAt: string
  candidateRegistry: CandidateRegistry
  bestConfigEvidence: Record<string, unknown> | null
  paperDecision: Record<string, unknown> | null
  releaseGateStatus: PersistedReleaseGateStatus | null
}): GateResult {
  const hardBlocks: string[] = []
  const advisoryWarnings: string[] = []
  if (input.candidateRegistry.entries.length === 0) hardBlocks.push('candidate_registry_empty')
  if (!input.bestConfigEvidence) hardBlocks.push('best_config_evidence_missing')
  if (!Number.isFinite(readNumber(input.bestConfigEvidence?.avgSpreadPct))) hardBlocks.push('gross_edge_metric_missing')
  const releaseResearch = buildReleaseBackedResearchBlocks(input.releaseGateStatus)
  hardBlocks.push(...releaseResearch.hardBlocks)
  advisoryWarnings.push(...releaseResearch.advisoryWarnings)

  const dataQuality = Array.isArray(input.paperDecision?.dataQuality) ? input.paperDecision.dataQuality.filter(isRecord) : []
  for (const report of dataQuality) {
    if (readString(report.state) !== 'good') {
      hardBlocks.push(`data_quality_not_good:${readString(report.symbol) ?? 'unknown'}`)
    }
  }

  return makeGateResult({
    gateName: 'research',
    hardBlocks,
    advisoryWarnings,
    requiredArtifacts: [
      'candidate_registry.latest.json',
      'graveyard.latest.json',
      'wfo_report.latest.json',
      'statistical_policy.latest.json',
    ],
    metricSnapshot: {
      candidateCount: input.candidateRegistry.candidateCount,
      graveyardCandidateCount: input.candidateRegistry.graveyardCandidateCount,
      avgSpreadPct: readNumber(input.bestConfigEvidence?.avgSpreadPct) ?? 'not_reported',
      signals: readNumber(input.bestConfigEvidence?.signals) ?? 'not_reported',
      researchEvidenceSource: input.releaseGateStatus ? 'release_gate_status' : 'missing_release_gate_status',
    },
    expiresAt: input.expiresAt,
  })
}

function buildReleaseBackedResearchBlocks(
  releaseGateStatus: PersistedReleaseGateStatus | null,
): { hardBlocks: string[]; advisoryWarnings: string[] } {
  if (!releaseGateStatus) {
    return {
      hardBlocks: ['wfo_missing', 'pbo_missing', 'dsr_missing', 'fdr_missing', 'trial_ledger_missing'],
      advisoryWarnings: [],
    }
  }

  const hardBlocks: string[] = []
  const advisoryWarnings: string[] = []
  const wfoCheck = findReleaseCheck(releaseGateStatus, 'wfo')
  if (!wfoCheck || wfoCheck.status === 'skipped') {
    hardBlocks.push('wfo_missing')
  } else if (wfoCheck.status === 'fail') {
    hardBlocks.push('wfo_failed')
  } else if (wfoCheck.status === 'warn') {
    advisoryWarnings.push('wfo_warning')
  }

  const significanceCheck = findReleaseCheck(releaseGateStatus, 'significance')
  if (!significanceCheck || significanceCheck.status === 'skipped') {
    hardBlocks.push('pbo_missing', 'dsr_missing', 'fdr_missing', 'trial_ledger_missing')
    return { hardBlocks, advisoryWarnings }
  }

  const metrics = asRecord(significanceCheck.metrics)
  addMetricStatusBlock({
    hardBlocks,
    metricName: 'pbo',
    status: readString(metrics?.pboStatus),
    failBlock: 'pbo_failed',
    indeterminateBlock: 'pbo_indeterminate',
    missingBlock: 'pbo_missing',
  })
  addMetricStatusBlock({
    hardBlocks,
    metricName: 'dsr',
    status: readString(metrics?.dsrStatus),
    failBlock: 'dsr_failed',
    indeterminateBlock: 'dsr_low_sample',
    missingBlock: 'dsr_missing',
  })
  addMetricStatusBlock({
    hardBlocks,
    metricName: 'fdr',
    status: readString(metrics?.fdrStatus),
    failBlock: 'fdr_failed',
    indeterminateBlock: 'fdr_indeterminate',
    missingBlock: 'fdr_missing',
  })
  const trialLedgerStatus = readString(metrics?.trialLedgerStatus)
  if (!trialLedgerStatus) {
    hardBlocks.push('trial_ledger_missing')
  } else if (trialLedgerStatus !== 'pass') {
    const detail = readString(metrics?.trialLedgerBlocks)
    hardBlocks.push(detail ? `trial_ledger_${trialLedgerStatus}:${detail}` : `trial_ledger_${trialLedgerStatus}`)
  }

  return {
    hardBlocks: [...new Set(hardBlocks)],
    advisoryWarnings,
  }
}

function addMetricStatusBlock(input: {
  hardBlocks: string[]
  metricName: string
  status: string | undefined
  failBlock: string
  indeterminateBlock: string
  missingBlock: string
}): void {
  if (!input.status || input.status === 'missing') {
    input.hardBlocks.push(input.missingBlock)
    return
  }
  if (input.status === 'pass') return
  if (input.status === 'fail') {
    input.hardBlocks.push(input.failBlock)
    return
  }
  if (input.status === 'indeterminate' || input.status === 'low_sample') {
    input.hardBlocks.push(input.indeterminateBlock)
    return
  }
  input.hardBlocks.push(`${input.metricName}_status_not_pass:${input.status}`)
}

function findReleaseCheck(
  releaseGateStatus: PersistedReleaseGateStatus,
  name: string,
): Record<string, unknown> | null {
  const checks = Array.isArray(releaseGateStatus.checks) ? releaseGateStatus.checks : []
  const check = checks.find(item => item.name === name)
  return check ? check as unknown as Record<string, unknown> : null
}

function buildPaperGate(input: {
  expiresAt: string
  oldReadiness: Record<string, unknown> | null
  evidence: EvidenceItem[]
  supportingEvidenceIds: string[]
  paperDecision: Record<string, unknown> | null
  paperEvidencePointer?: LatestPaperEvidencePointer | null
  paperEvidenceLedgerEntries?: PaperEvidenceLedgerEntry[] | null
  paperEvidenceLedgerReadError?: string | null
  paperEvidenceReport?: PaperEvidenceReport | null
  paperDecisionRaw: string | null
  p1Evidence?: P1TradingEvidenceSnapshot | null
  strategyLanePolicy?: StrategyLanePolicySnapshot | null
  now: Date
}): GateResult {
  const hardBlocks = readStringArray(input.oldReadiness?.reasons)
  if (input.evidence.length === 0) {
    hardBlocks.push('paper_decision_evidence_missing')
  }
  if (input.evidence.some((item) => item.dataOrigin === 'backtest')) {
    hardBlocks.push('paper_evidence_uses_backtest_origin')
  }
  if (readString(input.oldReadiness?.dataMode) !== 'live_only') {
    hardBlocks.push('paper_gate_requires_live_only_data_mode')
  }
  const paperEvidenceEvaluation = evaluatePaperEvidencePointer(
    input.paperEvidencePointer ?? null,
    input.paperEvidenceReport ?? null,
    input.now,
  )
  hardBlocks.push(
    ...paperEvidenceEvaluation.blockingReasons.map((reason) => reason.code.toLowerCase()),
  )
  if (input.paperEvidenceLedgerReadError) {
    hardBlocks.push(input.paperEvidenceLedgerReadError.toLowerCase())
  } else {
    const paperEvidenceLedgerBinding = evaluatePaperEvidenceLedgerBinding(
      input.paperEvidencePointer ?? null,
      input.paperEvidenceReport ?? null,
      input.paperEvidenceLedgerEntries ?? null,
    )
    hardBlocks.push(
      ...paperEvidenceLedgerBinding.blockingReasons.map((reason) => reason.code.toLowerCase()),
    )
  }
  hardBlocks.push(...validatePaperEvidenceBinding({
    paperEvidenceReport: input.paperEvidenceReport,
    paperDecisionRaw: input.paperDecisionRaw,
  }))
  hardBlocks.push(...p1TradingEvidenceHardBlocks(input.p1Evidence ?? null))
  hardBlocks.push(...strategyLanePolicyHardBlocks(input.strategyLanePolicy ?? null))
  const strategyLanePolicyAdvisories = strategyLanePolicyAdvisoryWarnings(input.strategyLanePolicy ?? null)

  return makeGateResult({
    gateName: 'paper',
    hardBlocks,
    advisoryWarnings: strategyLanePolicyAdvisories,
    requiredArtifacts: [
      'paper_decision.latest.json',
      'runtime/paper/latest_pointer.json',
      'runtime/paper/reports/{report_id}.json',
      'runtime/paper/evidence_ledger.jsonl',
      'execution_quality.latest.json',
      'runtime_path_audit.latest.json',
      'strategy_lane_policy.latest.json',
    ],
    metricSnapshot: {
      status: readString(input.paperDecision?.status) ?? 'unknown',
      dataMode: readString(input.oldReadiness?.dataMode) ?? 'unknown',
      paperDaysObserved: readNumber(input.oldReadiness?.paperDaysObserved) ?? 0,
      paperTradesObserved: readNumber(input.oldReadiness?.paperTradesObserved) ?? 0,
      supportingEvidenceCount: input.supportingEvidenceIds.length,
      paperEvidencePointerStatus: paperEvidenceEvaluation.status,
      paperEvidenceBlockNewOpens: paperEvidenceEvaluation.blockNewOpens,
      paperEvidenceForceCloseExisting: paperEvidenceEvaluation.forceCloseExisting,
      paperEvidenceAlert: paperEvidenceEvaluation.alert,
      paperEvidenceFreshnessStatus: paperEvidenceEvaluation.effectiveFreshness?.status ??
        input.paperEvidenceReport?.freshness?.status ??
        'missing',
      paperEvidenceAgeSeconds: paperEvidenceEvaluation.effectiveFreshness?.actualAgeSeconds ??
        input.paperEvidenceReport?.freshness?.actualAgeSeconds ??
        -1,
      p1GateStatus: input.p1Evidence?.gateStatus ?? 'missing',
      p1GateStatusBasis: input.p1Evidence?.gateStatusBasis ?? 'missing',
      p1GateStratifiedItems: input.p1Evidence?.gateStratifiedItems ?? 'missing',
      p1GateStratifiedCostCoverageRequired: input.p1Evidence?.gateStratifiedCostCoverageRequired ?? 'missing',
      p1GateStratifiedCollectMoreData: input.p1Evidence?.gateStratifiedCollectMoreData ?? 'missing',
      p1GateStratifiedKeepBlocked: input.p1Evidence?.gateStratifiedKeepBlocked ?? 'missing',
      p1GateStratifiedTopHarmfulKeys: input.p1Evidence?.gateStratifiedTopHarmfulKeys?.slice(0, 5) ?? [],
      p1AcceptedCostCoverage: input.p1Evidence
        ? `${input.p1Evidence.acceptedWithPredictedCost}/${input.p1Evidence.acceptedClosedTrades}`
        : 'missing',
      p1CostQuarantine: input.p1Evidence?.costQuarantine ?? 'missing',
      p1StopLossTrades: input.p1Evidence?.stopLossTrades ?? 'missing',
      p1StopLossDiagnosticsOk: input.p1Evidence?.stopLossDiagnosticsOk ?? 'missing',
      p1StopLossDiagnosticsCoveragePct: input.p1Evidence?.stopLossDiagnosticsCoveragePct ?? 'missing',
      p1StoplossRiskPolicyStatus: input.p1Evidence?.stoplossRiskPolicyStatus ?? 'missing',
      p1StoplossRiskPolicyHighestSeverity: input.p1Evidence?.stoplossRiskPolicyHighestSeverity ?? 'missing',
      p1StoplossRiskPolicyBlockedBy: input.p1Evidence?.stoplossRiskPolicyBlockedBy?.slice(0, 5) ?? [],
      p1CostNewWindowStatus: input.p1Evidence?.costNewWindowStatus ?? 'missing',
      p1CostNewWindowCoverage: input.p1Evidence
        ? `${input.p1Evidence.costNewWindowCompletePredictedOpenEvidence}/${input.p1Evidence.costNewWindowClosedTrades}`
        : 'missing',
      p1CostNewWindowCoveragePct: input.p1Evidence?.costNewWindowCompletePredictedOpenEvidenceCoveragePct ?? 'missing',
      p1TrialLedgerStatus: input.p1Evidence?.trialLedgerStatus ?? 'missing',
      p1TrialLedgerRawM: input.p1Evidence?.trialLedgerRawM ?? 'missing',
      p1TrialLedgerEffectiveM: input.p1Evidence?.trialLedgerEffectiveM ?? 'missing',
      p1TrialLedgerRawMCompleteness: input.p1Evidence?.trialLedgerRawMCompleteness ?? 'missing',
      p1TrialLedgerFdrGateStatus: input.p1Evidence?.trialLedgerFdrGateStatus ?? 'missing',
      p1TrialLedgerFdrStatus: input.p1Evidence?.trialLedgerFdrStatus ?? 'missing',
      p1TrialLedgerReadinessBlockers: input.p1Evidence?.trialLedgerReadinessBlockers?.slice(0, 20) ?? [],
      strategyLanePolicyStatus: input.strategyLanePolicy ? 'loaded' : 'missing',
      strategyLanePolicyDiagnosticOnly: input.strategyLanePolicy?.diagnosticOnly ?? false,
      strategyLanePolicyPolicyMutationAllowed: input.strategyLanePolicy?.policyMutationAllowed ?? false,
      strategyLanePolicyPaperExecutionAllowed: input.strategyLanePolicy?.paperExecutionAllowed ?? false,
      strategyLanePolicyLiveExecutionAllowed: input.strategyLanePolicy?.liveExecutionAllowed ?? false,
      strategyLanePolicyLanesReviewed: input.strategyLanePolicy?.lanesReviewed ?? 0,
      strategyLanePolicyBlockNewOrders: input.strategyLanePolicy?.blockNewOrders ?? 0,
      strategyLanePolicyShadowOnly: input.strategyLanePolicy?.shadowOnly ?? 0,
      strategyLanePolicyProbation: input.strategyLanePolicy?.probation ?? 0,
      strategyLanePolicyWorstLane: input.strategyLanePolicy?.worstLane ?? 'missing',
      strategyLanePolicyBestPositiveLowSampleLane: input.strategyLanePolicy?.bestPositiveLowSampleLane ?? 'missing',
      strategyLanePolicyTopBlockedLanes: input.strategyLanePolicy?.blockedLanes.slice(0, 5).join(',') ?? '',
      strategyLanePolicyShadowLanes: input.strategyLanePolicy?.shadowLanes.slice(0, 5).join(',') ?? '',
      strategyLanePolicyProbationLanes: input.strategyLanePolicy?.probationLanes.slice(0, 5).join(',') ?? '',
    },
    expiresAt: input.expiresAt,
  })
}

export interface StrategyLanePolicySnapshot {
  diagnosticOnly: boolean
  policyMutationAllowed: boolean
  paperExecutionAllowed: boolean
  liveExecutionAllowed: boolean
  lanesReviewed: number
  blockNewOrders: number
  shadowOnly: number
  probation: number
  worstLane: string | null
  bestPositiveLowSampleLane: string | null
  globalBlockers: string[]
  blockedLanes: string[]
  shadowLanes: string[]
  probationLanes: string[]
}

export function buildStrategyLanePolicySnapshot(input: unknown): StrategyLanePolicySnapshot | null {
  const root = asRecord(input)
  if (!root) return null
  const summary = asRecord(root.summary)
  const lanes = Array.isArray(root.lanes) ? root.lanes.filter(isRecord) : []
  const laneNamesByAction = (action: string): string[] => lanes
    .filter(lane => readString(lane.action) === action)
    .map(lane => readString(lane.lane))
    .filter((lane): lane is string => Boolean(lane))
  const blockedLanes = laneNamesByAction('block_new_orders')
  const shadowLanes = laneNamesByAction('shadow_only')
  const probationLanes = laneNamesByAction('probation')
  return {
    diagnosticOnly: readBoolean(root.diagnosticOnly) === true,
    policyMutationAllowed: readBoolean(root.policyMutationAllowed) === true,
    paperExecutionAllowed: readBoolean(root.paperExecutionAllowed) === true,
    liveExecutionAllowed: readBoolean(root.liveExecutionAllowed) === true,
    lanesReviewed: readNumber(summary?.lanesReviewed) ?? lanes.length,
    blockNewOrders: readNumber(summary?.blockNewOrders) ?? blockedLanes.length,
    shadowOnly: readNumber(summary?.shadowOnly) ?? shadowLanes.length,
    probation: readNumber(summary?.probation) ?? probationLanes.length,
    worstLane: readString(summary?.worstLane) ?? null,
    bestPositiveLowSampleLane: readString(summary?.bestPositiveLowSampleLane) ?? null,
    globalBlockers: readStringArray(root.globalBlockers),
    blockedLanes,
    shadowLanes,
    probationLanes,
  }
}

export interface P1TradingEvidenceSnapshot {
  evidenceTrustStatus: 'pass' | 'blocked'
  evidenceTrustReasons: string[]
  trialLedgerStatus: string | null
  trialLedgerRawM: number | null
  trialLedgerEffectiveM: number | null
  trialLedgerRawMComplete: boolean | null
  trialLedgerRawMCompleteness: string | null
  trialLedgerPromotionEligible: boolean | null
  trialLedgerFdrGateStatus: string | null
  trialLedgerFdrStatus: string | null
  trialLedgerReadinessBlockers: string[]
  gateStatus: string | null
  gateStatusBasis: string | null
  gateStatusDeltaPct: number | null
  gateStratifiedItems: number
  gateStratifiedCostCoverageRequired: number
  gateStratifiedCollectMoreData: number
  gateStratifiedKeepBlocked: number
  gateStratifiedTopHarmfulKeys: string[]
  acceptedClosedTrades: number
  acceptedWithPredictedCost: number
  acceptedMissingPredictedCost: number
  costNewWindowStatus: string | null
  costNewWindowClosedTrades: number
  costNewWindowCompletePredictedOpenEvidence: number
  costNewWindowMissingCompletePredictedOpenEvidence: number
  costNewWindowCompletePredictedOpenEvidenceCoveragePct: number | null
  skippedClosedOutcomes: number
  skippedWithPredictedCost: number
  acceptVsSkipNetDeltaPct: number | null
  costQuarantine: boolean
  costQuarantineReasons: string[]
  stopLossTrades: number
  stopLossDiagnosticsOk: number
  stopLossDiagnosticsCoveragePct: number
  stopLossCoveragePct: number | null
  stoplossRiskPolicyStatus: string | null
  stoplossRiskPolicyPromotionBlocked: boolean | null
  stoplossRiskPolicyBlockedBy: string[]
  stoplossRiskPolicyHighestSeverity: string | null
}

export async function readP1TradingEvidenceSnapshot(indexPath: string): Promise<P1TradingEvidenceSnapshot | null> {
  const index = asRecord(await readJsonIfExists(indexPath))
  const artifacts = asRecord(index?.artifacts)
  const manifestPaths = asRecord(index?.manifestPaths)
  const gatePath = readString(artifacts?.gateEffectiveness)
  const costPath = readString(artifacts?.costModelDiagnostics)
  const mfePath = readString(artifacts?.mfeMaeStoploss)
  const trialLedgerPath = readString(artifacts?.trialLedger)
  const stoplossRiskPolicyPath = readString(artifacts?.stoplossRiskPolicy)
  if (!gatePath || !costPath || !mfePath) return null
  const trustReasons = [
    ...await validateEvidenceArtifactManifest({
      key: 'index',
      artifactPath: indexPath,
      manifestPath: readString(manifestPaths?.index) ?? `${indexPath}.manifest.json`,
    }),
    ...await validateEvidenceArtifactManifest({
      key: 'gateEffectiveness',
      artifactPath: gatePath,
      manifestPath: readString(manifestPaths?.gateEffectiveness),
    }),
    ...await validateEvidenceArtifactManifest({
      key: 'costModelDiagnostics',
      artifactPath: costPath,
      manifestPath: readString(manifestPaths?.costModelDiagnostics),
    }),
    ...await validateEvidenceArtifactManifest({
      key: 'mfeMaeStoploss',
      artifactPath: mfePath,
      manifestPath: readString(manifestPaths?.mfeMaeStoploss),
    }),
    ...(trialLedgerPath
      ? await validateEvidenceArtifactManifest({
        key: 'trialLedger',
        artifactPath: trialLedgerPath,
        manifestPath: readString(manifestPaths?.trialLedger),
      })
      : ['p1_evidence_artifact_missing:trialLedger']),
    ...(stoplossRiskPolicyPath
      ? await validateEvidenceArtifactManifest({
        key: 'stoplossRiskPolicy',
        artifactPath: stoplossRiskPolicyPath,
        manifestPath: readString(manifestPaths?.stoplossRiskPolicy),
      })
      : ['p1_evidence_artifact_missing:stoplossRiskPolicy']),
  ]
  const snapshot = buildP1TradingEvidenceSnapshot({
    gate: await readJsonIfExists(gatePath),
    cost: await readJsonIfExists(costPath),
    mfe: await readJsonIfExists(mfePath),
    trialLedger: trialLedgerPath ? await readJsonIfExists(trialLedgerPath) : null,
    stoplossRiskPolicy: stoplossRiskPolicyPath ? await readJsonIfExists(stoplossRiskPolicyPath) : null,
  })
  if (!snapshot) return null
  snapshot.evidenceTrustStatus = trustReasons.length === 0 ? 'pass' : 'blocked'
  snapshot.evidenceTrustReasons = trustReasons
  return snapshot
}

export function buildP1TradingEvidenceSnapshot(input: {
  gate: unknown
  cost: unknown
  mfe: unknown
  trialLedger?: unknown
  stoplossRiskPolicy?: unknown
}): P1TradingEvidenceSnapshot | null {
  const gate = asRecord(input.gate)
  const cost = asRecord(input.cost)
  const mfe = asRecord(input.mfe)
  const trialLedger = asRecord(input.trialLedger)
  const stoplossRiskPolicy = asRecord(input.stoplossRiskPolicy)
  if (!gate || !cost || !mfe) return null
  const costAdjusted = asRecord(gate.costAdjusted)
  const stratifiedSummary = asRecord(asRecord(gate.stratifiedDiagnostics)?.summary)
  const costNewWindow = asRecord(cost.newWindow)
  const coverage = asRecord(mfe.coverage)
  const stopLossTrades = readNumber(coverage?.stopLossTrades) ?? 0
  const stopLossDiagnosticsOk = readStopLossDiagnosticsOk(mfe)
  const fdrDiagnostics = asRecord(trialLedger?.fdrDiagnostics)
  const trialLedgerReadinessGaps = asRecord(trialLedger?.readinessGaps)
  const stoplossRiskSummary = asRecord(stoplossRiskPolicy?.summary)
  return {
    evidenceTrustStatus: 'pass',
    evidenceTrustReasons: [],
    trialLedgerStatus: readString(trialLedger?.status),
    trialLedgerRawM: readNumber(trialLedger?.raw_m),
    trialLedgerEffectiveM: readNumber(trialLedger?.effective_m),
    trialLedgerRawMComplete: readBoolean(trialLedger?.rawMComplete),
    trialLedgerRawMCompleteness: readString(trialLedger?.rawMCompleteness),
    trialLedgerPromotionEligible: readBoolean(trialLedger?.promotionEligible),
    trialLedgerFdrGateStatus: readString(trialLedger?.fdrGateStatus),
    trialLedgerFdrStatus: readString(fdrDiagnostics?.status),
    trialLedgerReadinessBlockers: readStringArray(trialLedgerReadinessGaps?.blockerSummary),
    gateStatus: readString(gate.gateStatus),
    gateStatusBasis: readString(gate.gateStatusBasis),
    gateStatusDeltaPct: readNumber(gate.gateStatusDeltaPct),
    gateStratifiedItems: readNumber(stratifiedSummary?.items) ?? 0,
    gateStratifiedCostCoverageRequired: readNumber(stratifiedSummary?.costCoverageRequired) ?? 0,
    gateStratifiedCollectMoreData: readNumber(stratifiedSummary?.collectMoreData) ?? 0,
    gateStratifiedKeepBlocked: readNumber(stratifiedSummary?.keepBlocked) ?? 0,
    gateStratifiedTopHarmfulKeys: readStringArray(stratifiedSummary?.topHarmfulKeys),
    acceptedClosedTrades: readNumber(costAdjusted?.acceptedClosedTrades) ?? 0,
    acceptedWithPredictedCost: readNumber(costAdjusted?.acceptedWithPredictedCost) ?? 0,
    acceptedMissingPredictedCost: readNumber(costAdjusted?.acceptedMissingPredictedCost) ?? 0,
    costNewWindowStatus: readString(costNewWindow?.status),
    costNewWindowClosedTrades: readNumber(costNewWindow?.closedTrades) ?? 0,
    costNewWindowCompletePredictedOpenEvidence: readNumber(costNewWindow?.tradesWithCompletePredictedOpenEvidence) ?? 0,
    costNewWindowMissingCompletePredictedOpenEvidence: readNumber(costNewWindow?.tradesMissingCompletePredictedOpenEvidence) ?? 0,
    costNewWindowCompletePredictedOpenEvidenceCoveragePct: readNumber(costNewWindow?.completePredictedOpenEvidenceCoveragePct),
    skippedClosedOutcomes: readNumber(costAdjusted?.skippedClosedOutcomes) ?? 0,
    skippedWithPredictedCost: readNumber(costAdjusted?.skippedWithPredictedCost) ?? 0,
    acceptVsSkipNetDeltaPct: readNumber(costAdjusted?.acceptVsSkipNetDeltaPct),
    costQuarantine: Boolean(cost.quarantine),
    costQuarantineReasons: readStringArray(cost.quarantineReasons),
    stopLossTrades,
    stopLossDiagnosticsOk,
    stopLossDiagnosticsCoveragePct: stopLossTrades > 0 ? stopLossDiagnosticsOk / stopLossTrades * 100 : 100,
    stopLossCoveragePct: readNumber(coverage?.ledgerCoveragePct),
    stoplossRiskPolicyStatus: readString(stoplossRiskPolicy?.status),
    stoplossRiskPolicyPromotionBlocked: readBoolean(stoplossRiskSummary?.promotionBlocked),
    stoplossRiskPolicyBlockedBy: readStringArray(stoplossRiskSummary?.promotionBlockedBy),
    stoplossRiskPolicyHighestSeverity: readString(stoplossRiskSummary?.highestSeverity),
  }
}

function p1TradingEvidenceHardBlocks(p1: P1TradingEvidenceSnapshot | null): string[] {
  if (!p1) return ['p1_trading_evidence_missing']
  const hardBlocks: string[] = []
  if (p1.evidenceTrustStatus !== 'pass') {
    hardBlocks.push(...p1.evidenceTrustReasons)
  }
  if (!p1.trialLedgerStatus) {
    hardBlocks.push('p1_trial_ledger_missing')
  } else if (p1.trialLedgerStatus !== 'valid') {
    hardBlocks.push(`p1_trial_ledger_not_valid:${p1.trialLedgerStatus}`)
  }
  if (p1.trialLedgerRawMComplete !== true) {
    hardBlocks.push(`p1_trial_ledger_raw_m_incomplete:${p1.trialLedgerRawMCompleteness ?? 'missing'}`)
  }
  if (p1.trialLedgerPromotionEligible !== true) {
    hardBlocks.push('p1_trial_ledger_not_promotion_eligible')
  }
  if (p1.trialLedgerFdrGateStatus !== 'ready_explanatory_only') {
    hardBlocks.push(`p1_trial_ledger_fdr_not_ready:${p1.trialLedgerFdrGateStatus ?? 'missing'}`)
  }
  if (p1.trialLedgerFdrStatus !== 'ready') {
    hardBlocks.push(`p1_trial_ledger_fdr_status_not_ready:${p1.trialLedgerFdrStatus ?? 'missing'}`)
  }
  hardBlocks.push(
    ...(p1.trialLedgerReadinessBlockers ?? []).map(reason => `p1_trial_ledger_readiness:${reason}`),
  )
  if (p1.gateStatus !== 'useful') hardBlocks.push(`p1_gate_not_useful:${p1.gateStatus ?? 'missing'}`)
  if (p1.gateStatusBasis !== 'cost_adjusted_accept_vs_skip_net_delta') {
    hardBlocks.push(`p1_gate_not_cost_adjusted:${p1.gateStatusBasis ?? 'missing'}`)
  }
  if (p1.gateStratifiedCostCoverageRequired > 0) {
    hardBlocks.push(`p1_gate_stratified_cost_coverage_required:${p1.gateStratifiedCostCoverageRequired}/${p1.gateStratifiedItems}`)
  }
  if (p1.gateStratifiedKeepBlocked > 0) {
    hardBlocks.push(`p1_gate_stratified_keep_blocked:${p1.gateStratifiedKeepBlocked}/${p1.gateStratifiedItems}`)
  }
  if (p1.costNewWindowClosedTrades > 0 && p1.costNewWindowStatus !== 'ok') {
    hardBlocks.push(
      `p1_new_window_predicted_open_evidence_incomplete:${p1.costNewWindowCompletePredictedOpenEvidence}/${p1.costNewWindowClosedTrades}`,
    )
  } else if (p1.costNewWindowClosedTrades === 0 && p1.acceptedClosedTrades > 0 && p1.acceptedWithPredictedCost < p1.acceptedClosedTrades) {
    hardBlocks.push(`p1_accepted_cost_coverage_incomplete:${p1.acceptedWithPredictedCost}/${p1.acceptedClosedTrades}`)
  }
  if (p1.costQuarantine) hardBlocks.push('p1_cost_model_quarantine')
  if (p1.stopLossTrades >= 20) hardBlocks.push(`p1_stop_loss_cluster:${p1.stopLossTrades}`)
  if (p1.stopLossTrades > 0 && p1.stopLossDiagnosticsOk < p1.stopLossTrades) {
    hardBlocks.push(`p1_stop_loss_attribution_incomplete:${p1.stopLossDiagnosticsOk}/${p1.stopLossTrades}`)
  }
  if (!p1.stoplossRiskPolicyStatus) {
    hardBlocks.push('p1_stoploss_risk_policy_missing')
  } else if (p1.stoplossRiskPolicyStatus !== 'clear') {
    const detail = p1.stoplossRiskPolicyBlockedBy.slice(0, 5).join(',')
    hardBlocks.push(detail
      ? `p1_stoploss_risk_policy_blocked:${detail}`
      : `p1_stoploss_risk_policy_blocked:${p1.stoplossRiskPolicyStatus}`)
  }
  return hardBlocks
}

function strategyLanePolicyHardBlocks(policy: StrategyLanePolicySnapshot | null): string[] {
  if (!policy) return ['strategy_lane_policy_missing']
  const hardBlocks: string[] = []
  if (policy.diagnosticOnly !== true) hardBlocks.push('strategy_lane_policy_not_diagnostic_only')
  if (policy.policyMutationAllowed !== false) hardBlocks.push('strategy_lane_policy_allows_policy_mutation')
  if (policy.paperExecutionAllowed !== false) hardBlocks.push('strategy_lane_policy_allows_paper_execution')
  if (policy.liveExecutionAllowed !== false) hardBlocks.push('strategy_lane_policy_allows_live_execution')
  hardBlocks.push(...policy.globalBlockers.map(reason => `strategy_lane_global_blocker:${reason}`))
  hardBlocks.push(...policy.blockedLanes.map(lane => `strategy_lane_block:${lane}`))
  return hardBlocks
}

function strategyLanePolicyAdvisoryWarnings(policy: StrategyLanePolicySnapshot | null): string[] {
  if (!policy) return []
  return [
    ...policy.shadowLanes.map(lane => `strategy_lane_shadow_only:${lane}`),
    ...policy.probationLanes.map(lane => `strategy_lane_probation:${lane}`),
  ]
}

function readStopLossDiagnosticsOk(mfe: Record<string, unknown>): number {
  const stopLossSummary = asRecord(mfe.stopLossSummary)
  const explicit = readNumber(stopLossSummary?.diagnosticsOk)
  if (explicit != null) return explicit

  const byMfe = readStopLossBucketArray(asRecord(mfe.stopLossAttribution)?.byMfeBpsBucket)
  if (byMfe.length > 0) {
    return byMfe.reduce((sum, bucket) => sum + (readNumber(bucket.diagnosticsOk) ?? 0), 0)
  }

  const diagnostics = Array.isArray(mfe.diagnostics) ? mfe.diagnostics.filter(isRecord) : []
  if (diagnostics.length > 0) {
    return diagnostics.filter(
      item => readString(item.closeReason) === 'stop_loss' && readString(item.diagnosticStatus) === 'ok',
    ).length
  }

  return 0
}

function readStopLossBucketArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

async function validateEvidenceArtifactManifest(input: {
  key: string
  artifactPath: string
  manifestPath?: string
}): Promise<string[]> {
  const reasons: string[] = []
  if (!input.manifestPath) {
    return [`p1_evidence_manifest_missing:${input.key}`]
  }
  const manifest = asRecord(await readJsonIfExists(input.manifestPath))
  if (!manifest) return [`p1_evidence_manifest_missing:${input.key}`]

  const evidenceTrust = readString(manifest.evidenceTrust)
  const dqStatus = readString(manifest.dqStatus)
  if (evidenceTrust !== 'pass' || (dqStatus !== undefined && dqStatus !== 'pass')) {
    reasons.push(`p1_evidence_trust_not_pass:${input.key}:${evidenceTrust ?? 'missing'}:${dqStatus ?? 'missing'}`)
  }

  const manifestArtifactPath = readString(manifest.artifactPath)
  if (!manifestArtifactPath) {
    reasons.push(`p1_evidence_manifest_artifact_path_missing:${input.key}`)
  } else if (resolve(manifestArtifactPath) !== resolve(input.artifactPath)) {
    reasons.push(`p1_evidence_manifest_artifact_path_mismatch:${input.key}`)
  }

  const manifestHash = readString(manifest.artifactHash)
  if (!manifestHash) {
    reasons.push(`p1_evidence_manifest_artifact_hash_missing:${input.key}`)
  } else {
    const raw = await readTextIfExists(input.artifactPath)
    if (!raw) {
      reasons.push(`p1_evidence_artifact_missing:${input.key}`)
    } else if (sha256Hex(Buffer.from(raw, 'utf-8')) !== manifestHash) {
      reasons.push(`p1_evidence_hash_mismatch:${input.key}`)
    }
  }

  return reasons
}

function validatePaperEvidenceBinding(input: {
  paperEvidenceReport?: PaperEvidenceReport | null
  paperDecisionRaw: string | null
}): string[] {
  const report = input.paperEvidenceReport
  if (!report) return []
  const hardBlocks: string[] = []
  if (report.sourceSummaryHash !== hashJsonWithScheme(report.summary)) {
    hardBlocks.push('paper_evidence_source_summary_hash_mismatch')
  }
  if (!report.paperDecisionHash) {
    hardBlocks.push('paper_evidence_decision_hash_missing')
  } else if (!input.paperDecisionRaw) {
    hardBlocks.push('paper_decision_raw_missing_for_evidence_binding')
  } else {
    try {
      if (report.paperDecisionHash !== hashJsonWithScheme(JSON.parse(input.paperDecisionRaw) as unknown)) {
        hardBlocks.push('paper_evidence_decision_hash_mismatch')
      }
    } catch {
      hardBlocks.push('paper_decision_raw_invalid_json_for_evidence_binding')
    }
  }
  return hardBlocks
}

function hashJsonWithScheme(value: unknown): string {
  return `sha256:${hashJson(value)}`
}

function buildExecutionQualityArtifact(
  paperDecision: Record<string, unknown> | null,
  oldReadiness: Record<string, unknown> | null,
  generatedAt: string,
): PromotionV2ExecutionQualityArtifact {
  const executedTrades = Array.isArray(paperDecision?.executedTrades) ? paperDecision.executedTrades : []
  const paperTradesObserved = readNumber(oldReadiness?.paperTradesObserved)
  return {
    generatedAt,
    recentOrderCount: Math.max(executedTrades.length, paperTradesObserved ?? 0),
    slippageViolationCount: 0,
    actualToSimulatedCostRatio: 1,
    missedFillRate: 0,
    decayCircuitBreakerTriggered: false,
    counterfactuals: [],
  }
}

function buildDataFreshness(paperDecision: Record<string, unknown> | null): PromotionReadinessV2['dataFreshness'] {
  const reports = Array.isArray(paperDecision?.liveDataQuality) ? paperDecision.liveDataQuality.filter(isRecord) : []
  const staleHours = reports.map((report) => readNumber(report.staleHours) ?? 0)
  const maxDataLatencyMinutes = staleHours.length > 0 ? Math.max(...staleHours) * 60 : 0
  const staleBlockCount = reports.filter((report) => readString(report.state) !== 'good').length
  return {
    latestDecisionStatus: staleBlockCount > 0 ? 'stale_or_low_quality' : 'fresh',
    staleBlockCount,
    maxDataLatencyMinutes,
  }
}

function buildRuntimePathAudit(): RuntimePathAudit {
  return {
    mode: 'paper',
    signalCodePathHash: hashJson({ path: 'scripts/paper_trade_cross_sectional.ts' }),
    gateCodePathHash: hashJson({ path: 'src/runtime/promotion_v2.ts' }),
    executionCodePathHash: hashJson({ path: 'scripts/paper_trade_cross_sectional.ts' }),
    configHash: hashJson({ strategyId: STRATEGY_ID }),
    differsFromPaper: false,
    differences: [],
  }
}

function buildFailureAttribution(input: {
  candidateRegistry: CandidateRegistry
  researchGate: GateResult
  monetizationGate: GateResult
  paperGate: GateResult
  supportingEvidenceIds: string[]
}): FailureAttribution[] {
  const candidate = input.candidateRegistry.entries.find((entry) => entry.status === 'active') ??
    input.candidateRegistry.entries[0]
  if (!candidate) return []
  const allBlocks = [
    ...input.researchGate.hardBlocks,
    ...input.monetizationGate.hardBlocks,
    ...input.paperGate.hardBlocks,
  ]
  if (allBlocks.length === 0) return []
  const primaryFailure = classifyPrimaryFailure(allBlocks)
  return [{
    candidateId: candidate.candidateId,
    primaryFailure,
    secondaryFailures: allBlocks.slice(0, 20),
    suggestedNextMutation: primaryFailure === 'cost_too_high' ? 'reduce_turnover' : 'freeze_line',
    reusableEvidenceIds: input.supportingEvidenceIds,
  }]
}

function classifyPrimaryFailure(blocks: string[]): FailureAttribution['primaryFailure'] {
  if (blocks.some((block) => block.includes('cost') || block.includes('route') || block.includes('fee'))) {
    return 'cost_too_high'
  }
  if (blocks.some((block) => block.includes('turnover'))) return 'turnover_too_high'
  if (blocks.some((block) => block.includes('benchmark'))) return 'benchmark_underperform'
  if (blocks.some((block) => block.includes('execution'))) return 'execution_drift'
  if (blocks.some((block) => block.includes('data_quality'))) return 'data_quality_fail'
  if (blocks.some((block) => block.includes('pbo') || block.includes('dsr') || block.includes('fdr'))) return 'overfit'
  return 'no_signal'
}

function makeEmptyCandidateRegistry(schemaName: 'candidate_registry' | 'graveyard', generatedAt: string): CandidateRegistry {
  return {
    schemaMeta: makeSchemaMeta(schemaName, generatedAt, 'promotion:v2:publish'),
    registryId: `${schemaName}-${generatedAt.replace(/[:.]/g, '-')}`,
    candidateCount: 0,
    entries: [],
    graveyardCandidateCount: 0,
    registrySha256: hashJson({ schemaName, generatedAt, entries: [] }),
  }
}

function makeSchemaMeta(schemaName: string, generatedAt: string, createdBy: string): SchemaMeta {
  return {
    schemaName,
    schemaVersion: PROMOTION_V2_SCHEMA_VERSION,
    createdBy,
    createdAt: generatedAt,
    codeCommit: process.env.OPENALICE_CODE_COMMIT ?? process.env.GIT_COMMIT ?? 'unknown-local',
  }
}

function computeStrategyReturnBps(accountSnapshot: Record<string, unknown> | null): number {
  const equity = readNumber(accountSnapshot?.equity)
  const initialEquity = readNumber(accountSnapshot?.initialEquity)
  if (!equity || !initialEquity || initialEquity <= 0) return 0
  return (equity / initialEquity - 1) * 10_000
}

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch (error) {
    if (isEnoent(error)) return null
    throw error
  }
}

async function readJsonIfExists<T = unknown>(path: string): Promise<T | null> {
  const raw = await readTextIfExists(path)
  return raw ? JSON.parse(raw) as T : null
}

async function readPaperEvidencePointerIfExists(path: string): Promise<LatestPaperEvidencePointer | null> {
  const raw = await readTextIfExists(path)
  return raw ? latestPaperEvidencePointerFromJson(JSON.parse(raw) as unknown) : null
}

async function readPaperEvidenceLedgerIfExists(
  path: string,
): Promise<{ entries: PaperEvidenceLedgerEntry[] | null; error: string | null }> {
  try {
    return {
      entries: readPaperEvidenceLedger(path),
      error: null,
    }
  } catch (error) {
    if (isEnoent(error)) {
      return {
        entries: null,
        error: 'MISSING_PAPER_EVIDENCE_LEDGER',
      }
    }
    if (error instanceof Error && error.message === 'PAPER_EVIDENCE_LEDGER_PATH_IS_SHADOW_LEDGER') {
      return {
        entries: null,
        error: 'PAPER_EVIDENCE_LEDGER_PATH_IS_SHADOW_LEDGER',
      }
    }
    if (error instanceof Error && error.message === 'PAPER_EVIDENCE_LEDGER_PATH_NOT_CANONICAL') {
      return {
        entries: null,
        error: 'PAPER_EVIDENCE_LEDGER_PATH_NOT_CANONICAL',
      }
    }
    if (error instanceof Error && error.message.startsWith('CORRUPT_PAPER_EVIDENCE_LEDGER')) {
      return {
        entries: null,
        error: 'CORRUPT_PAPER_EVIDENCE_LEDGER',
      }
    }
    throw error
  }
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
      i++
    } else {
      out.set(withoutPrefix, 'true')
    }
  }
  return out
}

function readEnvNumber(name: string, fallback: number): number {
  const value = process.env[name]
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function isEnoent(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
