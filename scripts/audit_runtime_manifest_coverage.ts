import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

export interface RequiredRuntimeArtifact {
  key: string
  relativePath: string
  required: boolean
}

export interface RuntimeManifestCoverageItem {
  key: string
  artifactPath: string
  manifestPath: string
  required: boolean
  artifactExists: boolean
  manifestExists: boolean
  artifactHash: string | null
  manifestArtifactPath: string | null
  manifestArtifactHash: string | null
  hashMatches: boolean | null
  evidenceTrust: string | null
  dqStatus: string | null
  manifestBusinessStatus: string | null
  manifestErrorClass: string | null
  manifestRunId: string | null
  manifestSchemaVersion: number | null
  manifestSourceKind: string | null
  manifestSourceCommit: string | null
  manifestDirtyStateHash: string | null
  manifestReleaseId: string | null
  manifestReleaseManifestHash: string | null
  manifestReleasePathIdentity: string | null
  manifestSourceIdentityValid: boolean | null
  manifestGitCommit: string | null
  manifestGitDirty: boolean | null
  manifestGitDirtyFilesCount: number | null
  manifestGitDirtyHash: string | null
  promotionEvidenceAllowed: false
  quarantineReason: string | null
  job: string | null
  blockingReasons: string[]
  trustBlockingReasons: string[]
}

export interface RuntimeManifestCoverageReport {
  schemaVersion: 1
  generatedAt: string
  runtimeDir: string
  status: 'complete' | 'blocked'
  coverageStatus: 'complete' | 'blocked'
  evidenceUsabilityStatus: 'pass' | 'quarantine_blocked' | 'fail_blocked' | 'missing_or_invalid_blocked'
  promotionReadinessStatus: 'promotion_ready' | 'coverage_complete_trust_blocked' | 'coverage_blocked'
  coverageCompleteButTrustBlocked: boolean
  promotionAllowedByThisArtifact: false
  promotionEvidenceAllowed: false
  paperOrderEvidenceAllowed: false
  monetizationConclusionAllowedByThisArtifact: false
  monetizationConclusionAllowed: false
  requiredPassManifests: number
  passManifestCount: number
  quarantineManifestCount: number
  allRequiredManifestsPass: boolean
  allRequiredManifestsPresentAndHashMatched: boolean
  coverage: {
    requiredArtifacts: number
    existingArtifacts: number
    missingArtifacts: number
    presentManifests: number
    missingManifests: number
    hashMatchedManifests: number
    hashMismatchManifests: number
    invalidManifests: number
  }
  trustSummary: {
    pass: number
    quarantine: number
    fail: number
    missing: number
    invalid: number
  }
  manifestDirtyStateSummary: {
    dirtyStateDivergenceDetected: boolean
    uniqueDirtyFilesCounts: number[]
    dirtyFilesCountMin: number | null
    dirtyFilesCountMax: number | null
    dirtyFilesCountGroups: Array<{
      dirtyFilesCount: number
      artifactKeys: string[]
    }>
  }
  businessStatusSummary: Record<string, number>
  errorClassSummary: Record<string, number>
  sourceIdentitySummary: {
    requiredIdentityCount: number
    validIdentityCount: number
    invalidIdentityCount: number
    uniqueIdentityKeys: string[]
    consistent: boolean
    sourceKinds: string[]
  }
  trustBlockingReasons: string[]
  blockingReasons: string[]
  items: RuntimeManifestCoverageItem[]
  notes: string[]
}

export interface RuntimeManifestCoverageArgs {
  runtimeDir: string
  outputPath: string | null
  json: boolean
  expectedSourceKind?: 'git_worktree' | 'verified_release'
}

export const DEFAULT_RUNTIME_MANIFEST_COVERAGE_OUTPUT = 'data/runtime/runtime_manifest_coverage.latest.json'

export const DEFAULT_REQUIRED_RUNTIME_ARTIFACTS: RequiredRuntimeArtifact[] = [
  { key: 'strategyPromotion', relativePath: 'strategy_promotion.latest.json', required: true },
  { key: 'releaseGateStatus', relativePath: 'release_gate_status.json', required: true },
  { key: 'phaseReadiness', relativePath: 'phase_readiness.latest.json', required: true },
  { key: 'paperGateStatus', relativePath: 'paper_gate_status.json', required: true },
  { key: 'paperExecutorStatus', relativePath: 'paper_executor_status.latest.json', required: true },
  { key: 'dirtyWorktreeAudit', relativePath: 'dirty_worktree_audit.latest.json', required: true },
  { key: 'externalDerivativesCollect', relativePath: 'external_derivatives_data_collect.latest.json', required: true },
  { key: 'paperPolicyShadowSettle', relativePath: 'paper_policy_shadow_settle.latest.json', required: true },
  { key: 'metaLabelingShadowReadiness', relativePath: 'meta_labeling_shadow_readiness.latest.json', required: true },
  { key: 'icMonitorStatus', relativePath: 'ic_monitor_status.latest.json', required: true },
  { key: 'liveDataFreshness', relativePath: 'live_data_freshness.latest.json', required: true },
  { key: 'feeSnapshot', relativePath: 'fee_snapshot.latest.json', required: true },
  { key: 'routeCostBudget', relativePath: 'route_cost_budget.latest.json', required: true },
  { key: 'productionRiskPolicy', relativePath: 'production_risk_policy.latest.json', required: true },
  { key: 'strategyLanePolicy', relativePath: 'strategy_lane_policy.latest.json', required: true },
  { key: 'dataWarehouseCatalog', relativePath: 'openalice_data_catalog.latest.json', required: true },
  { key: 'assetMetadataRegistry', relativePath: 'openalice_asset_metadata_registry.latest.json', required: true },
  { key: 'coinmetricsOnchainCollect', relativePath: 'openalice_coinmetrics_onchain_collect.latest.json', required: true },
  { key: 'coinmetricsOnchainNormalize', relativePath: 'openalice_coinmetrics_onchain_normalize.latest.json', required: true },
  { key: 'coinmetricsOnchainAudit', relativePath: 'openalice_coinmetrics_onchain_audit.latest.json', required: true },
  { key: 'p1EvidenceIndex', relativePath: 'p1_trading_evidence/p1_trading_evidence.index.latest.json', required: true },
  { key: 'p1GateEffectiveness', relativePath: 'p1_trading_evidence/gate_effectiveness_report.latest.json', required: true },
  { key: 'p1CostModelDiagnostics', relativePath: 'p1_trading_evidence/cost_model_diagnostics.latest.json', required: true },
  { key: 'p1TrialLedger', relativePath: 'p1_trading_evidence/trial_ledger.latest.json', required: true },
  { key: 'p1TrialSourceCoverage', relativePath: 'p1_trading_evidence/trial_source_coverage.latest.json', required: true },
  { key: 'p1MfeMaeStoploss', relativePath: 'p1_trading_evidence/mfe_mae_stoploss_report.latest.json', required: true },
  { key: 'p1StoplossRiskPolicy', relativePath: 'p1_trading_evidence/stoploss_risk_policy.latest.json', required: true },
  { key: 'p1CandidateKillCriteria', relativePath: 'p1_trading_evidence/candidate_kill_criteria.latest.json', required: true },
  { key: 'p1AlphaHypothesisRegistry', relativePath: 'p1_trading_evidence/alpha_hypothesis_registry.latest.json', required: true },
]

export function parseRuntimeManifestCoverageArgs(argv: string[]): RuntimeManifestCoverageArgs {
  const raw = parseRawArgs(argv)
  const expectedSourceKind = parseSourceKind(raw.get('sourceKind'))
  return {
    runtimeDir: raw.get('runtimeDir') ?? 'data/runtime',
    outputPath: parseNullablePath(raw.get('output') ?? raw.get('outputPath') ?? DEFAULT_RUNTIME_MANIFEST_COVERAGE_OUTPUT),
    json: parseBool(raw.get('json'), false),
    ...(expectedSourceKind ? { expectedSourceKind } : {}),
  }
}

export function buildRuntimeManifestCoverageReport(input: {
  runtimeDir: string
  requiredArtifacts?: RequiredRuntimeArtifact[]
  generatedAt?: string
  expectedSourceKind?: 'git_worktree' | 'verified_release'
}): RuntimeManifestCoverageReport {
  const runtimeDir = resolve(input.runtimeDir)
  const items = (input.requiredArtifacts ?? DEFAULT_REQUIRED_RUNTIME_ARTIFACTS)
    .map((artifact) => buildCoverageItem(runtimeDir, artifact, input.expectedSourceKind))
  const blockingReasons = items.flatMap((item) => item.blockingReasons)
  const coverage = {
    requiredArtifacts: items.filter((item) => item.required).length,
    existingArtifacts: items.filter((item) => item.artifactExists).length,
    missingArtifacts: items.filter((item) => item.required && !item.artifactExists).length,
    presentManifests: items.filter((item) => item.manifestExists).length,
    missingManifests: items.filter((item) => item.artifactExists && !item.manifestExists).length,
    hashMatchedManifests: items.filter((item) => item.hashMatches === true).length,
    hashMismatchManifests: items.filter((item) => item.hashMatches === false).length,
    invalidManifests: items.filter((item) => item.manifestExists && item.evidenceTrust == null).length,
  }
  const trustSummary = {
    pass: items.filter((item) => item.evidenceTrust === 'pass').length,
    quarantine: items.filter((item) => item.evidenceTrust === 'quarantine').length,
    fail: items.filter((item) => item.evidenceTrust === 'fail').length,
    missing: items.filter((item) => item.artifactExists && !item.manifestExists).length,
    invalid: items.filter((item) => item.manifestExists && item.evidenceTrust != null && !isEvidenceTrust(item.evidenceTrust)).length,
  }
  const coverageStatus = blockingReasons.length === 0 ? 'complete' : 'blocked'
  const requiredPassManifests = coverage.requiredArtifacts
  const passManifestCount = items.filter((item) =>
    item.required &&
    item.artifactExists &&
    item.manifestExists &&
    item.hashMatches === true &&
    item.evidenceTrust === 'pass' &&
    item.dqStatus === 'pass',
  ).length
  // A manifest whose raw producer trust is `pass` can still be unusable for
  // canonical evidence when its source identity is legacy, missing, or bound
  // to a different source kind. Treat that identity failure as quarantine for
  // usability classification, while preserving the producer's raw trust
  // fields for diagnostics.
  const quarantineManifestCount = items.filter((item) =>
    item.required && (
      item.evidenceTrust === 'quarantine'
      || item.dqStatus === 'quarantine'
      || item.trustBlockingReasons.some((reason) => (
        reason.startsWith('evidence_manifest_legacy_schema:')
        || reason.startsWith('evidence_source_identity_invalid:')
        || reason.startsWith('evidence_source_kind_mismatch:')
      ))
    ),
  ).length
  const allRequiredManifestsPresentAndHashMatched =
    coverage.missingArtifacts === 0 &&
    coverage.missingManifests === 0 &&
    coverage.hashMismatchManifests === 0 &&
    coverage.invalidManifests === 0
  const sourceIdentitySummary = buildSourceIdentitySummary(items, input.expectedSourceKind)
  const allRequiredManifestsIdentityMatched = sourceIdentitySummary.consistent
  const allRequiredManifestsPass = allRequiredManifestsPresentAndHashMatched
    && allRequiredManifestsIdentityMatched
    && passManifestCount === requiredPassManifests
  const trustBlockingReasons = buildTrustBlockingReasons({
    requiredPassManifests,
    passManifestCount,
    quarantineManifestCount,
    trustSummary,
    allRequiredManifestsPresentAndHashMatched: allRequiredManifestsPresentAndHashMatched && allRequiredManifestsIdentityMatched,
    sourceIdentitySummary,
  })
  const evidenceUsabilityStatus: RuntimeManifestCoverageReport['evidenceUsabilityStatus'] =
    allRequiredManifestsPass
      ? 'pass'
      : !allRequiredManifestsPresentAndHashMatched
        ? 'missing_or_invalid_blocked'
      : trustSummary.fail > 0
        ? 'fail_blocked'
        : quarantineManifestCount > 0
          ? 'quarantine_blocked'
          : 'missing_or_invalid_blocked'
  const coverageCompleteButTrustBlocked = coverageStatus === 'complete' && evidenceUsabilityStatus !== 'pass'
  const promotionReadinessStatus: RuntimeManifestCoverageReport['promotionReadinessStatus'] = allRequiredManifestsPass
    ? 'promotion_ready'
    : coverageCompleteButTrustBlocked
      ? 'coverage_complete_trust_blocked'
      : 'coverage_blocked'
  const manifestDirtyStateSummary = buildManifestDirtyStateSummary(items)
  const businessStatusSummary = countStrings(items.map(item => item.manifestBusinessStatus ?? 'missing'))
  const errorClassSummary = countStrings(items.map(item => item.manifestErrorClass ?? 'none'))

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    runtimeDir,
    status: coverageStatus,
    coverageStatus,
    evidenceUsabilityStatus,
    promotionReadinessStatus,
    coverageCompleteButTrustBlocked,
    promotionAllowedByThisArtifact: false,
    promotionEvidenceAllowed: false,
    paperOrderEvidenceAllowed: false,
    monetizationConclusionAllowedByThisArtifact: false,
    monetizationConclusionAllowed: false,
    requiredPassManifests,
    passManifestCount,
    quarantineManifestCount,
    allRequiredManifestsPass,
    allRequiredManifestsPresentAndHashMatched,
    coverage,
    trustSummary,
    manifestDirtyStateSummary,
    businessStatusSummary,
    errorClassSummary,
    sourceIdentitySummary,
    trustBlockingReasons,
    blockingReasons,
    items,
    notes: [
      'This audit only checks runtime artifact manifest coverage and integrity.',
      'coverageStatus=complete only means required files and sidecar hashes are present. evidenceUsabilityStatus must be pass before promotion evidence can be used.',
      'evidenceTrust=quarantine is valid coverage under a dirty worktree, but it remains unusable for promotion or monetization conclusions.',
      'Canonical trust also requires schema-v2 source identity convergence across all required manifests.',
      'This artifact cannot authorize paper orders, live orders, leverage changes, or promotion.',
    ],
  }
}

export async function runRuntimeManifestCoverageAudit(
  args: RuntimeManifestCoverageArgs,
): Promise<RuntimeManifestCoverageReport> {
  const startedAt = new Date()
  const report = buildRuntimeManifestCoverageReport({
    runtimeDir: args.runtimeDir,
    expectedSourceKind: args.expectedSourceKind,
  })
  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'runtime_manifest_coverage_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.evidenceUsabilityStatus === 'pass' ? 'pass' : 'warn',
      recordsIn: report.coverage.requiredArtifacts,
      recordsOut: report.coverage.presentManifests,
      errorClass: report.blockingReasons[0] ?? report.trustBlockingReasons[0] ?? null,
    })
  }
  return report
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseRuntimeManifestCoverageArgs(argv)
  const report = await runRuntimeManifestCoverageAudit(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderRuntimeManifestCoverageMarkdown(report))
  }
  if (report.status === 'blocked') process.exitCode = 2
}

export function renderRuntimeManifestCoverageMarkdown(report: RuntimeManifestCoverageReport): string {
  const lines: string[] = []
  lines.push('# Runtime Manifest Coverage Audit')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Runtime dir: \`${report.runtimeDir}\``)
  lines.push(`Status: \`${report.status}\``)
  lines.push(`Evidence usability: \`${report.evidenceUsabilityStatus}\``)
  lines.push(`Promotion readiness: \`${report.promotionReadinessStatus}\``)
  if (report.coverageCompleteButTrustBlocked) {
    lines.push(`Coverage complete but trust blocked: ${report.quarantineManifestCount}/${report.requiredPassManifests} required manifests are quarantined or not pass.`)
  }
  lines.push(`Missing manifests: ${report.coverage.missingManifests}`)
  lines.push(`Hash mismatches: ${report.coverage.hashMismatchManifests}`)
  lines.push(`Invalid manifests: ${report.coverage.invalidManifests}`)
  lines.push('')
  if (report.manifestDirtyStateSummary.dirtyStateDivergenceDetected) {
    lines.push('## Manifest Dirty State Divergence')
    lines.push('')
    lines.push(`Dirty counts: \`${report.manifestDirtyStateSummary.uniqueDirtyFilesCounts.join(',')}\``)
    lines.push('')
  }
  if (report.trustBlockingReasons.length > 0) {
    lines.push('## Trust Blocking Reasons')
    lines.push('')
    for (const reason of report.trustBlockingReasons) lines.push(`- \`${reason}\``)
    lines.push('')
  }
  if (report.blockingReasons.length > 0) {
    lines.push('## Blocking Reasons')
    lines.push('')
    for (const reason of report.blockingReasons) lines.push(`- \`${reason}\``)
    lines.push('')
  }
  lines.push('## Items')
  lines.push('')
  lines.push('| key | artifact | manifest | evidenceTrust | hashMatches | trust blockers | blockers |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const item of report.items) {
    lines.push(
      `| ${escapePipe(item.key)} | ${item.artifactExists ? 'yes' : 'missing'} | ` +
      `${item.manifestExists ? 'yes' : 'missing'} | ${escapePipe(item.evidenceTrust ?? '')} | ` +
      `${item.hashMatches ?? ''} | ${escapePipe(item.trustBlockingReasons.join('; '))} | ` +
      `${escapePipe(item.blockingReasons.join('; '))} |`,
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function buildCoverageItem(
  runtimeDir: string,
  artifact: RequiredRuntimeArtifact,
  expectedSourceKind?: 'git_worktree' | 'verified_release',
): RuntimeManifestCoverageItem {
  const artifactPath = resolve(runtimeDir, artifact.relativePath)
  const manifestPath = `${artifactPath}.manifest.json`
  const artifactExists = existsSync(artifactPath)
  const manifestExists = existsSync(manifestPath)
  const artifactHash = artifactExists ? sha256File(artifactPath) : null
  const blockingReasons: string[] = []
  let manifest: Record<string, unknown> | null = null

  if (artifact.required && !artifactExists) blockingReasons.push(`artifact_missing:${artifact.key}`)
  if (artifactExists && !manifestExists) blockingReasons.push(`manifest_missing:${artifact.key}`)
  if (manifestExists) {
    try {
      manifest = asRecord(JSON.parse(readFileSync(manifestPath, 'utf-8')))
    } catch {
      blockingReasons.push(`manifest_unreadable:${artifact.key}`)
    }
  }

  const manifestArtifactPath = readString(manifest?.artifactPath)
  const manifestArtifactHash = readString(manifest?.artifactHash)
  const evidenceTrust = readString(manifest?.evidenceTrust)
  const dqStatus = readString(manifest?.dqStatus)
  const manifestBusinessStatus = readString(manifest?.businessStatus)
  const manifestErrorClass = readString(manifest?.errorClass)
  const manifestRunId = readString(manifest?.runId)
  const manifestSchemaVersion = readNumber(manifest?.schemaVersion)
  const manifestSourceKind = readString(manifest?.sourceKind)
  const manifestSourceCommit = readString(manifest?.sourceCommit)
  const manifestDirtyStateHash = readString(manifest?.dirtyStateHash)
  const manifestReleaseId = readString(manifest?.releaseId)
  const manifestReleaseManifestHash = readString(manifest?.releaseManifestHash)
  const manifestReleasePathIdentity = readString(manifest?.releasePathIdentity)
  const manifestSourceIdentityValid = readBoolean(manifest?.sourceIdentityValid)
  const manifestGit = asRecord(manifest?.git)
  const manifestGitCommit = readString(manifestGit?.commit)
  const manifestGitDirty = readBoolean(manifestGit?.dirty)
  const manifestGitDirtyFilesCount = readNumber(manifestGit?.dirtyFilesCount)
  const manifestGitDirtyHash = readString(manifestGit?.dirtyHash)
  const job = readString(manifest?.job)
  const hashMatches = artifactHash && manifestArtifactHash
    ? artifactHash === manifestArtifactHash
    : artifactExists && manifestExists
      ? false
      : null
  const quarantineReason = evidenceTrust === 'quarantine' || dqStatus === 'quarantine'
    ? manifestGitDirty === true
      ? 'manifest_git_dirty'
      : 'manifest_quarantine'
    : evidenceTrust === 'fail' || dqStatus === 'fail'
      ? 'manifest_fail'
      : null
  const trustBlockingReasons = buildItemTrustBlockingReasons({
    key: artifact.key,
    evidenceTrust,
    dqStatus,
    manifestGitDirty,
    manifestGitDirtyFilesCount,
    manifestExists,
  })

  if (manifest) {
    if (!manifestArtifactPath) blockingReasons.push(`manifest_artifact_path_missing:${artifact.key}`)
    else if (resolve(manifestArtifactPath) !== artifactPath) blockingReasons.push(`manifest_artifact_path_mismatch:${artifact.key}`)
    if (!manifestArtifactHash) blockingReasons.push(`manifest_hash_missing:${artifact.key}`)
    else if (artifactHash && manifestArtifactHash !== artifactHash) blockingReasons.push(`manifest_hash_mismatch:${artifact.key}`)
    if (!evidenceTrust) blockingReasons.push(`evidence_trust_missing:${artifact.key}`)
    else if (!isEvidenceTrust(evidenceTrust)) blockingReasons.push(`evidence_trust_invalid:${artifact.key}:${evidenceTrust}`)
    if (dqStatus && !isEvidenceTrust(dqStatus)) blockingReasons.push(`dq_status_invalid:${artifact.key}:${dqStatus}`)
    // Legacy manifests are still readable for diagnostics, but can never be
    // counted as canonical trust evidence after the source-binding upgrade.
    if (manifestSchemaVersion !== 2) {
      trustBlockingReasons.push(`evidence_manifest_legacy_schema:${artifact.key}`)
    } else if (manifestSourceIdentityValid !== true) {
      trustBlockingReasons.push(`evidence_source_identity_invalid:${artifact.key}`)
    }
    if (expectedSourceKind && manifestSourceKind !== expectedSourceKind) {
      trustBlockingReasons.push(
        `evidence_source_kind_mismatch:${artifact.key}:${manifestSourceKind ?? 'missing'}:${expectedSourceKind}`,
      )
    }
  }

  return {
    key: artifact.key,
    artifactPath,
    manifestPath,
    required: artifact.required,
    artifactExists,
    manifestExists,
    artifactHash,
    manifestArtifactPath,
    manifestArtifactHash,
    hashMatches,
    evidenceTrust,
    dqStatus,
    manifestBusinessStatus,
    manifestErrorClass,
    manifestRunId,
    manifestSchemaVersion,
    manifestSourceKind,
    manifestSourceCommit,
    manifestDirtyStateHash,
    manifestReleaseId,
    manifestReleaseManifestHash,
    manifestReleasePathIdentity,
    manifestSourceIdentityValid,
    manifestGitCommit,
    manifestGitDirty,
    manifestGitDirtyFilesCount,
    manifestGitDirtyHash,
    promotionEvidenceAllowed: false,
    quarantineReason,
    job,
    blockingReasons,
    trustBlockingReasons,
  }
}

function buildItemTrustBlockingReasons(input: {
  key: string
  evidenceTrust: string | null
  dqStatus: string | null
  manifestGitDirty: boolean | null
  manifestGitDirtyFilesCount: number | null
  manifestExists: boolean
}): string[] {
  const reasons: string[] = []
  if (!input.manifestExists) return reasons
  if (input.evidenceTrust !== 'pass' || input.dqStatus !== 'pass') {
    reasons.push(`evidence_trust_not_pass:${input.key}:${input.evidenceTrust ?? 'missing'}:${input.dqStatus ?? 'missing'}`)
  }
  if (input.manifestGitDirty === true) {
    reasons.push(`manifest_git_dirty:${input.key}:${input.manifestGitDirtyFilesCount ?? 'unknown'}`)
  }
  return reasons
}

function buildManifestDirtyStateSummary(
  items: RuntimeManifestCoverageItem[],
): RuntimeManifestCoverageReport['manifestDirtyStateSummary'] {
  const counts = items
    .map(item => item.manifestGitDirtyFilesCount)
    .filter((value): value is number => value != null)
  const uniqueDirtyFilesCounts = [...new Set(counts)].sort((left, right) => left - right)
  const dirtyFilesCountGroups = uniqueDirtyFilesCounts.map(dirtyFilesCount => ({
    dirtyFilesCount,
    artifactKeys: items
      .filter(item => item.manifestGitDirtyFilesCount === dirtyFilesCount)
      .map(item => item.key)
      .sort(),
  }))
  return {
    dirtyStateDivergenceDetected: uniqueDirtyFilesCounts.length > 1,
    uniqueDirtyFilesCounts,
    dirtyFilesCountMin: counts.length > 0 ? Math.min(...counts) : null,
    dirtyFilesCountMax: counts.length > 0 ? Math.max(...counts) : null,
    dirtyFilesCountGroups,
  }
}

function buildTrustBlockingReasons(input: {
  requiredPassManifests: number
  passManifestCount: number
  quarantineManifestCount: number
  trustSummary: RuntimeManifestCoverageReport['trustSummary']
  allRequiredManifestsPresentAndHashMatched: boolean
  sourceIdentitySummary: RuntimeManifestCoverageReport['sourceIdentitySummary']
}): string[] {
  const reasons: string[] = []
  if (!input.allRequiredManifestsPresentAndHashMatched) {
    reasons.push('required_manifests_not_all_present_and_hash_matched')
  }
  if (input.passManifestCount < input.requiredPassManifests) {
    reasons.push(`evidence_trust_pass_required:${input.passManifestCount}/${input.requiredPassManifests}`)
  }
  if (input.quarantineManifestCount > 0) {
    reasons.push(`evidence_trust_quarantine:${input.quarantineManifestCount}`)
  }
  if (input.trustSummary.fail > 0) reasons.push(`evidence_trust_fail:${input.trustSummary.fail}`)
  if (input.trustSummary.missing > 0) reasons.push(`evidence_trust_missing:${input.trustSummary.missing}`)
  if (input.trustSummary.invalid > 0) reasons.push(`evidence_trust_invalid:${input.trustSummary.invalid}`)
  if (input.sourceIdentitySummary.invalidIdentityCount > 0) {
    reasons.push(`evidence_source_identity_invalid:${input.sourceIdentitySummary.invalidIdentityCount}`)
  }
  if (!input.sourceIdentitySummary.consistent) reasons.push('evidence_source_identity_mismatch')
  return reasons
}

function buildSourceIdentitySummary(
  items: RuntimeManifestCoverageItem[],
  expectedSourceKind?: 'git_worktree' | 'verified_release',
): RuntimeManifestCoverageReport['sourceIdentitySummary'] {
  const required = items.filter((item) => item.required && item.manifestExists)
  const valid = required.filter((item) => (
    item.manifestSchemaVersion === 2
    && item.manifestSourceIdentityValid === true
    && (!expectedSourceKind || item.manifestSourceKind === expectedSourceKind)
  ))
  const invalid = required.filter((item) => !(
    item.manifestSchemaVersion === 2
    && item.manifestSourceIdentityValid === true
    && (!expectedSourceKind || item.manifestSourceKind === expectedSourceKind)
  ))
  const identityKey = (item: RuntimeManifestCoverageItem): string => [
    item.manifestSourceKind ?? 'missing',
    item.manifestSourceCommit ?? 'missing',
    item.manifestDirtyStateHash ?? 'missing',
    item.manifestReleaseId ?? 'missing',
    item.manifestReleaseManifestHash ?? 'missing',
    item.manifestReleasePathIdentity ?? 'missing',
  ].join('|')
  const uniqueIdentityKeys = [...new Set(valid.map(identityKey))].sort()
  return {
    requiredIdentityCount: required.length,
    validIdentityCount: valid.length,
    invalidIdentityCount: invalid.length,
    uniqueIdentityKeys,
    consistent: required.length > 0 && invalid.length === 0 && uniqueIdentityKeys.length === 1,
    sourceKinds: [...new Set(valid.map((item) => item.manifestSourceKind ?? 'missing'))].sort(),
  }
}

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=', 2)
    if (inlineValue !== undefined) {
      out.set(key, inlineValue)
      continue
    }
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
  return normalized === 'null' || normalized === 'none' || normalized === 'false' ? null : value
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.trim().toLowerCase())
}

function parseSourceKind(value: string | undefined): RuntimeManifestCoverageArgs['expectedSourceKind'] {
  if (value === 'git_worktree' || value === 'verified_release') return value
  return undefined
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function countStrings(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function isEvidenceTrust(value: string): boolean {
  return value === 'pass' || value === 'quarantine' || value === 'fail'
}

function escapePipe(value: string): string {
  return value.replaceAll('|', '\\|')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
