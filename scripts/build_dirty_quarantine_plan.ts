import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'
import type { EvidenceManifest } from '../src/runtime/evidence_manifest.js'
import type {
  DirtyWorktreeAudit,
  DirtyWorktreeEntry,
  PathGroup,
  ProtocolClass,
  StatusKind,
} from './audit_dirty_worktree.js'

export interface DirtyQuarantinePlanArgs {
  inputPath: string
  outputPath: string | null
  maxBatches: number
  representativeLimit: number
  json: boolean
}

export type DirtyPlanActionType =
  | 'isolate_and_rotate_secret'
  | 'resolve_unmerged_conflict'
  | 'explicit_deleted_file_review'
  | 'runtime_artifact_quarantine'
  | 'source_functional_review'
  | 'docs_archive_review'
  | 'uncategorized_review'

export interface DirtyQuarantinePlanBatch {
  batchId: string
  priority: number
  protocolClass: ProtocolClass
  protocolLabel: string
  pathGroup: PathGroup
  topPrefix: string
  statusKinds: StatusKind[]
  count: number
  actionType: DirtyPlanActionType
  p2Blocking: true
  promotionEvidenceAllowed: false
  destructiveOperationAllowed: false
  recommendedAction: string
  redLines: string[]
  representativePaths: string[]
  reasons: string[]
}

export interface DirtyQuarantinePlanReport {
  schemaVersion: 1
  generatedAt: string
  planGeneratedAt: string
  sourceAuditPath: string
  sourceAuditManifestPath: string | null
  sourceAuditHash: string
  sourceAuditGeneratedAt: string | null
  sourceAuditCountsTotal: number
  latestObservedDirtyFilesCount: number | null
  dirtyStateDriftDetected: boolean
  dirtyStateDriftReason: string | null
  sourceAuditAgeMsAtPlan: number | null
  sourceManifest: {
    present: boolean
    artifactHash: string | null
    hashMatchesSourceAudit: boolean | null
    evidenceTrust: EvidenceManifest['evidenceTrust'] | null
    dqStatus: EvidenceManifest['dqStatus'] | null
    businessStatus: EvidenceManifest['businessStatus'] | null
    gitDirtyFilesCount: number | null
  }
  blockingReasons: string[]
  readOnly: true
  mutationAllowed: false
  gitResetAllowed: false
  gitCleanAllowed: false
  bulkAddAllowed: false
  p2PromotionAllowedAfterPlan: false
  monetizationConclusionAllowedAfterPlan: false
  governance: DirtyWorktreeAudit['governance']
  sourceCounts: DirtyWorktreeAudit['counts']
  dirtyScopes: DirtyWorktreeAudit['counts']['scopeCounts']
  coverage: {
    dirtyEntries: number
    sourceBatches: number
    emittedBatches: number
    p2BlockingBatches: number
    protocolClassOrder: ProtocolClass[]
  }
  batchSummary: {
    byActionType: Array<{ key: DirtyPlanActionType; entries: number; batches: number }>
    byProtocolClass: Array<{ key: ProtocolClass; entries: number; batches: number }>
    byPathGroup: Array<{ key: PathGroup; entries: number; batches: number }>
  }
  sourceAuditSampleSummary: {
    promotionRelevantSamples: { count: number; firstPath: string | null }
    generatedArtifactOnlySamples: { count: number; firstPath: string | null }
    secretRiskSamples: { count: number; firstPath: string | null }
    deletedTrackedSamples: { count: number; firstPath: string | null }
  }
  batches: DirtyQuarantinePlanBatch[]
  redLines: string[]
  completionCriteria: string[]
  notes: string[]
}

const DEFAULT_INPUT_PATH = 'data/runtime/dirty_worktree_audit.latest.json'
const DEFAULT_OUTPUT_PATH = 'data/runtime/dirty_quarantine_plan.latest.json'
const DEFAULT_MAX_BATCHES = 80
const DEFAULT_REPRESENTATIVE_LIMIT = 12
const PROTOCOL_ORDER: ProtocolClass[] = ['D', 'B', 'A', 'C']

export function parseDirtyQuarantinePlanArgs(argv: string[]): DirtyQuarantinePlanArgs {
  const raw = parseRawArgs(argv)
  return {
    inputPath: raw.get('inputPath') ?? raw.get('input') ?? DEFAULT_INPUT_PATH,
    outputPath: parseNullablePath(raw.get('outputPath') ?? raw.get('output') ?? DEFAULT_OUTPUT_PATH),
    maxBatches: parsePositiveInteger(raw.get('maxBatches'), DEFAULT_MAX_BATCHES),
    representativeLimit: parsePositiveInteger(raw.get('representativeLimit'), DEFAULT_REPRESENTATIVE_LIMIT),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runDirtyQuarantinePlan(
  args: DirtyQuarantinePlanArgs,
): Promise<DirtyQuarantinePlanReport> {
  const startedAt = new Date()
  const inputPath = resolve(args.inputPath)
  const inputRaw = await readFile(inputPath, 'utf-8')
  const audit = JSON.parse(inputRaw) as DirtyWorktreeAudit
  const sourceManifestPath = `${inputPath}.manifest.json`
  const sourceManifest = readSourceManifest(sourceManifestPath)
  const report = buildDirtyQuarantinePlanReport({
    audit,
    sourceAuditPath: inputPath,
    sourceAuditRaw: inputRaw,
    sourceManifest,
    sourceAuditManifestPath: existsSync(sourceManifestPath) ? sourceManifestPath : null,
    maxBatches: args.maxBatches,
    representativeLimit: args.representativeLimit,
  })

  if (args.outputPath) {
    const outputPath = resolve(args.outputPath)
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'dirty_quarantine_plan',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: report.sourceCounts.total > 0 ? 'warn' : 'pass',
      recordsIn: report.sourceCounts.total,
      recordsOut: report.coverage.emittedBatches,
      errorClass: report.sourceCounts.total > 0 ? 'dirty_worktree_quarantine_plan' : null,
    })
  }

  return report
}

export function buildDirtyQuarantinePlanReport(input: {
  audit: DirtyWorktreeAudit
  sourceAuditPath: string
  sourceAuditRaw?: string
  sourceManifest?: EvidenceManifest | null
  sourceAuditManifestPath?: string | null
  maxBatches?: number
  representativeLimit?: number
  generatedAt?: string
}): DirtyQuarantinePlanReport {
  const sourceAuditRaw = input.sourceAuditRaw ?? `${JSON.stringify(input.audit, null, 2)}\n`
  const sourceAuditHash = sha256Hex(sourceAuditRaw)
  const sourceManifest = input.sourceManifest ?? null
  const allBatches = buildPlanBatches(input.audit.entries, input.representativeLimit ?? DEFAULT_REPRESENTATIVE_LIMIT)
  const batches = allBatches.slice(0, input.maxBatches ?? DEFAULT_MAX_BATCHES)
  const sourceManifestHashMatches = sourceManifest?.artifactHash == null ? null : sourceManifest.artifactHash === sourceAuditHash
  const sourceManifestGitDirtyFilesCount = readManifestDirtyFilesCount(sourceManifest)
  const latestObservedDirtyFilesCount = sourceManifestGitDirtyFilesCount
  const dirtyStateDrift = computeDirtyStateDrift({
    sourceAuditCountsTotal: input.audit.counts.total,
    latestObservedDirtyFilesCount,
    sourceManifestHashMatches,
  })
  const blockingReasons = dirtyPlanBlockingReasons({
    audit: input.audit,
    sourceManifest,
    sourceManifestHashMatches,
    sourceManifestGitDirtyFilesCount,
    dirtyStateDriftDetected: dirtyStateDrift.detected,
  })
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const sourceAuditAgeMsAtPlan = computeAgeMs(input.audit.generatedAt ?? null, generatedAt)
  const batchSummary = buildBatchSummary(batches)
  const sourceAuditSampleSummary = buildSourceAuditSampleSummary(input.audit)

  return {
    schemaVersion: 1,
    generatedAt,
    planGeneratedAt: generatedAt,
    sourceAuditPath: resolve(input.sourceAuditPath),
    sourceAuditManifestPath: input.sourceAuditManifestPath ? resolve(input.sourceAuditManifestPath) : null,
    sourceAuditHash,
    sourceAuditGeneratedAt: input.audit.generatedAt ?? null,
    sourceAuditCountsTotal: input.audit.counts.total,
    latestObservedDirtyFilesCount,
    dirtyStateDriftDetected: dirtyStateDrift.detected,
    dirtyStateDriftReason: dirtyStateDrift.reason,
    sourceAuditAgeMsAtPlan,
    sourceManifest: {
      present: sourceManifest != null,
      artifactHash: sourceManifest?.artifactHash ?? null,
      hashMatchesSourceAudit: sourceManifestHashMatches,
      evidenceTrust: sourceManifest?.evidenceTrust ?? null,
      dqStatus: sourceManifest?.dqStatus ?? null,
      businessStatus: sourceManifest?.businessStatus ?? null,
      gitDirtyFilesCount: sourceManifestGitDirtyFilesCount,
    },
    blockingReasons,
    readOnly: true,
    mutationAllowed: false,
    gitResetAllowed: false,
    gitCleanAllowed: false,
    bulkAddAllowed: false,
    p2PromotionAllowedAfterPlan: false,
    monetizationConclusionAllowedAfterPlan: false,
    governance: input.audit.governance,
    sourceCounts: input.audit.counts,
    dirtyScopes: input.audit.counts.scopeCounts,
    coverage: {
      dirtyEntries: input.audit.counts.total,
      sourceBatches: allBatches.length,
      emittedBatches: batches.length,
      p2BlockingBatches: batches.length,
      protocolClassOrder: PROTOCOL_ORDER,
    },
    batchSummary,
    sourceAuditSampleSummary,
    batches,
    redLines: [
      'Do not run git reset --hard for this cleanup protocol.',
      'Do not run git clean -fd for this cleanup protocol.',
      'Do not run git add .; each batch must be reviewed with an explicit file scope.',
      'Do not commit protocol B runtime/data/log artifacts as promotion evidence.',
      'Do not use dirty-worktree artifacts for monetization conclusions.',
      ...blockingReasons.map(reason => `Plan source blocker: ${reason}`),
    ],
    completionCriteria: [
      'data/runtime/dirty_worktree_audit.latest.json reports counts.total=0.',
      'data/runtime/dirty_worktree_audit.latest.json.manifest.json has evidenceTrust=pass and dqStatus=pass.',
      'The dirty audit sidecar manifest artifactHash matches the final audit JSON bytes.',
      'Protocol B runtime/data/log artifacts are ignored, archived, or regenerated from a clean worktree.',
      'Protocol A source changes are split into explicit reviewable scopes; deleted tracked files have explicit decisions.',
    ],
    notes: [
      'This is a read-only execution plan generated from the dirty worktree audit; it does not clean or mutate the repository.',
      'Every emitted batch remains P2-blocking until the source dirty audit is regenerated clean with a matching pass manifest.',
      'Representative paths are samples for triage only; use the source audit entries for the complete path list.',
    ],
  }
}

export function renderDirtyQuarantinePlanMarkdown(report: DirtyQuarantinePlanReport): string {
  const lines: string[] = []
  lines.push('# Dirty Quarantine Plan')
  lines.push('')
  lines.push(`Generated: \`${report.generatedAt}\``)
  lines.push(`Source audit: \`${report.sourceAuditPath}\``)
  lines.push(`Read only: \`${report.readOnly}\``)
  lines.push(`Mutation allowed: \`${report.mutationAllowed}\``)
  lines.push(`P2 allowed after plan: \`${report.p2PromotionAllowedAfterPlan}\``)
  lines.push(`Source manifest hash match: \`${report.sourceManifest.hashMatchesSourceAudit}\``)
  lines.push(`Source audit generated: \`${report.sourceAuditGeneratedAt}\``)
  lines.push(`Source audit dirty entries: \`${report.sourceAuditCountsTotal}\``)
  lines.push(`Source audit age at plan ms: \`${report.sourceAuditAgeMsAtPlan}\``)
  if (report.blockingReasons.length > 0) {
    lines.push('')
    lines.push('## Source Blockers')
    lines.push('')
    for (const reason of report.blockingReasons) lines.push(`- ${reason}`)
  }
  lines.push('')
  lines.push('## Coverage')
  lines.push('')
  lines.push(`- Dirty entries: ${report.coverage.dirtyEntries}`)
  lines.push(`- Source batches: ${report.coverage.sourceBatches}`)
  lines.push(`- Emitted batches: ${report.coverage.emittedBatches}`)
  lines.push(`- P2 blocking batches: ${report.coverage.p2BlockingBatches}`)
  lines.push('')
  lines.push('## Batch Summary')
  lines.push('')
  lines.push(`- By action: ${report.batchSummary.byActionType.map(item => `${item.key}=${item.entries}/${item.batches}`).join(', ')}`)
  lines.push(`- By protocol: ${report.batchSummary.byProtocolClass.map(item => `${item.key}=${item.entries}/${item.batches}`).join(', ')}`)
  lines.push(`- By path group: ${report.batchSummary.byPathGroup.map(item => `${item.key}=${item.entries}/${item.batches}`).join(', ')}`)
  lines.push('')
  lines.push('## Batches')
  lines.push('')
  lines.push('| priority | action | protocol | pathGroup | topPrefix | status | count | sample |')
  lines.push('| ---: | --- | --- | --- | --- | --- | ---: | --- |')
  for (const batch of report.batches) {
    lines.push([
      `| ${batch.priority}`,
      batch.actionType,
      batch.protocolClass,
      batch.pathGroup,
      batch.topPrefix,
      batch.statusKinds.join(','),
      String(batch.count),
      batch.representativePaths.slice(0, 3).join('<br>'),
    ].join(' | ') + ' |')
  }
  lines.push('')
  lines.push('## Red Lines')
  lines.push('')
  for (const redLine of report.redLines) lines.push(`- ${redLine}`)
  lines.push('')
  return `${lines.join('\n')}\n`
}

function buildPlanBatches(
  entries: DirtyWorktreeEntry[],
  representativeLimit: number,
): DirtyQuarantinePlanBatch[] {
  const groups = new Map<string, DirtyWorktreeEntry[]>()
  for (const entry of entries) {
    const key = [
      entry.protocolClass,
      entry.pathGroup,
      statusKey(entry.statusKinds),
      topPrefix(entry.path),
    ].join('\u0000')
    const group = groups.get(key)
    if (group) {
      group.push(entry)
    } else {
      groups.set(key, [entry])
    }
  }

  return Array.from(groups.values())
    .map((group, index) => buildBatch(group, index, representativeLimit))
    .sort(compareBatches)
    .map((batch, index) => ({
      ...batch,
      batchId: `${String(index + 1).padStart(3, '0')}_${batch.protocolClass}_${sanitizeBatchId(batch.topPrefix)}_${statusKey(batch.statusKinds)}`,
    }))
}

function buildBatch(
  entries: DirtyWorktreeEntry[],
  index: number,
  representativeLimit: number,
): DirtyQuarantinePlanBatch {
  const first = entries[0]
  if (!first) throw new Error('Cannot build dirty quarantine batch from empty entries')
  const actionType = classifyActionType(first)
  const sortedEntries = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const statusKinds = [...new Set(sortedEntries.flatMap(entry => entry.statusKinds))].sort((a, b) => a.localeCompare(b)) as StatusKind[]
  const prefix = topPrefix(first.path)
  const priority = priorityFor(first, statusKinds)
  return {
    batchId: `pending_${index}`,
    priority,
    protocolClass: first.protocolClass,
    protocolLabel: first.protocolLabel,
    pathGroup: first.pathGroup,
    topPrefix: prefix,
    statusKinds,
    count: entries.length,
    actionType,
    p2Blocking: true,
    promotionEvidenceAllowed: false,
    destructiveOperationAllowed: false,
    recommendedAction: recommendedActionFor(actionType),
    redLines: redLinesFor(actionType),
    representativePaths: sortedEntries.slice(0, representativeLimit).map(entry => entry.path),
    reasons: [...new Set(sortedEntries.flatMap(entry => entry.reasons))].sort(),
  }
}

function classifyActionType(entry: DirtyWorktreeEntry): DirtyPlanActionType {
  if (entry.protocolClass === 'D') return 'isolate_and_rotate_secret'
  if (entry.statusKinds.includes('unmerged')) return 'resolve_unmerged_conflict'
  if (entry.statusKinds.includes('deleted')) return 'explicit_deleted_file_review'
  if (entry.protocolClass === 'B') return 'runtime_artifact_quarantine'
  if (entry.protocolClass === 'A') return 'source_functional_review'
  if (entry.protocolClass === 'C') return 'docs_archive_review'
  return 'uncategorized_review'
}

function priorityFor(entry: DirtyWorktreeEntry, statusKinds: StatusKind[]): number {
  if (entry.protocolClass === 'D') return 0
  if (statusKinds.includes('unmerged')) return 1
  if (statusKinds.includes('deleted')) return 2
  if (entry.protocolClass === 'B') return 3
  if (entry.protocolClass === 'A') return 4
  if (entry.protocolClass === 'C') return 5
  return 6
}

function recommendedActionFor(actionType: DirtyPlanActionType): string {
  switch (actionType) {
    case 'isolate_and_rotate_secret':
      return 'Isolate the file, verify whether credentials are real, and rotate any exposed secret before any commit.'
    case 'resolve_unmerged_conflict':
      return 'Resolve the conflict in a narrow file scope and rerun the dirty audit before promotion review.'
    case 'explicit_deleted_file_review':
      return 'Decide delete versus restore per path; do not bulk restore or bulk commit deleted tracked files.'
    case 'runtime_artifact_quarantine':
      return 'Classify as generated/runtime evidence, move to ignore/archive lane or regenerate from a clean worktree.'
    case 'source_functional_review':
      return 'Review as source code change and split into focused patches with tests before promotion evidence is trusted.'
    case 'docs_archive_review':
      return 'Archive or restore docs/research changes in a docs-only scope separate from executable source changes.'
    case 'uncategorized_review':
      return 'Manually classify before any staging or promotion review.'
  }
}

function redLinesFor(actionType: DirtyPlanActionType): string[] {
  const common = [
    'No git add .',
    'No git reset --hard',
    'No git clean -fd',
  ]
  switch (actionType) {
    case 'isolate_and_rotate_secret':
      return [...common, 'Do not commit this batch', 'Rotate real credentials before continuing']
    case 'runtime_artifact_quarantine':
      return [...common, 'Do not use this batch as monetization or promotion evidence']
    case 'explicit_deleted_file_review':
      return [...common, 'Do not bulk restore deleted tracked files']
    default:
      return common
  }
}

function compareBatches(a: DirtyQuarantinePlanBatch, b: DirtyQuarantinePlanBatch): number {
  return a.priority - b.priority ||
    b.count - a.count ||
    protocolRank(a.protocolClass) - protocolRank(b.protocolClass) ||
    a.topPrefix.localeCompare(b.topPrefix) ||
    statusKey(a.statusKinds).localeCompare(statusKey(b.statusKinds))
}

function buildBatchSummary(batches: DirtyQuarantinePlanBatch[]): DirtyQuarantinePlanReport['batchSummary'] {
  const byActionType = summarizeBatchDimension(
    batches,
    batch => batch.actionType,
    [...new Set(batches.map(batch => batch.actionType))].sort(),
  ) as DirtyQuarantinePlanReport['batchSummary']['byActionType']
  const byProtocolClass = summarizeBatchDimension(
    batches,
    batch => batch.protocolClass,
    PROTOCOL_ORDER,
  ) as DirtyQuarantinePlanReport['batchSummary']['byProtocolClass']
  const byPathGroup = summarizeBatchDimension(
    batches,
    batch => batch.pathGroup,
    [...new Set(batches.map(batch => batch.pathGroup))].sort(),
  ) as DirtyQuarantinePlanReport['batchSummary']['byPathGroup']
  return {
    byActionType,
    byProtocolClass,
    byPathGroup,
  }
}

function summarizeBatchDimension<T extends string>(
  batches: DirtyQuarantinePlanBatch[],
  keyFn: (batch: DirtyQuarantinePlanBatch) => T,
  keyOrder: T[],
): Array<{ key: T; entries: number; batches: number }> {
  return keyOrder
    .map(key => {
      const rows = batches.filter(batch => keyFn(batch) === key)
      return {
        key,
        entries: rows.reduce((sum, batch) => sum + batch.count, 0),
        batches: rows.length,
      }
    })
    .filter(item => item.entries > 0 || item.batches > 0)
}

function buildSourceAuditSampleSummary(
  audit: DirtyWorktreeAudit,
): DirtyQuarantinePlanReport['sourceAuditSampleSummary'] {
  return {
    promotionRelevantSamples: summarizeDirtySamples(audit.samples.promotionRelevantSamples),
    generatedArtifactOnlySamples: summarizeDirtySamples(audit.samples.generatedArtifactOnlySamples),
    secretRiskSamples: summarizeDirtySamples(audit.samples.secretRiskSamples),
    deletedTrackedSamples: summarizeDirtySamples(audit.samples.deletedTrackedSamples),
  }
}

function summarizeDirtySamples(samples: DirtyWorktreeEntry[]): { count: number; firstPath: string | null } {
  return {
    count: samples.length,
    firstPath: samples[0]?.path ?? null,
  }
}

function protocolRank(protocolClass: ProtocolClass): number {
  const found = PROTOCOL_ORDER.indexOf(protocolClass)
  return found >= 0 ? found : PROTOCOL_ORDER.length
}

function topPrefix(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return path
  if (parts[0]?.startsWith('.')) return parts.slice(0, Math.min(2, parts.length)).join('/')
  if (['src', 'data', 'docs', 'runtime', 'packages'].includes(parts[0] ?? '') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`
  }
  if (parts[0] === 'scripts' && parts[1] === 'lib') return 'scripts/lib'
  if (parts[0] === 'scripts') return 'scripts'
  return parts[0] ?? path
}

function statusKey(statusKinds: StatusKind[]): string {
  return [...statusKinds].sort((a, b) => a.localeCompare(b)).join('+') || 'unknown'
}

function sanitizeBatchId(value: string): string {
  return value.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'root'
}

function readSourceManifest(path: string): EvidenceManifest | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as EvidenceManifest
}

function dirtyPlanBlockingReasons(input: {
  audit: DirtyWorktreeAudit
  sourceManifest: EvidenceManifest | null
  sourceManifestHashMatches: boolean | null
  sourceManifestGitDirtyFilesCount: number | null
  dirtyStateDriftDetected?: boolean
}): string[] {
  const reasons: string[] = []
  if (!input.sourceManifest) {
    reasons.push('source_audit_manifest_missing')
  } else {
    if (input.sourceManifestHashMatches !== true) {
      reasons.push('source_audit_manifest_hash_mismatch')
    }
    if (input.sourceManifest.evidenceTrust !== 'pass' || input.sourceManifest.dqStatus !== 'pass') {
      reasons.push(`source_audit_manifest_not_pass:${input.sourceManifest.evidenceTrust}:${input.sourceManifest.dqStatus}`)
    }
    if (
      input.sourceManifestGitDirtyFilesCount != null &&
      input.sourceManifestGitDirtyFilesCount !== input.audit.counts.total
    ) {
      reasons.push(`source_audit_manifest_dirty_count_mismatch:${input.sourceManifestGitDirtyFilesCount}:${input.audit.counts.total}`)
    }
    if (input.dirtyStateDriftDetected) {
      reasons.push('dirty_state_drift_detected')
    }
  }
  if (input.audit.counts.total > 0) {
    reasons.push(`source_audit_dirty_entries:${input.audit.counts.total}`)
  }
  if (input.audit.counts.scopeCounts.promotionRelevantTotal > 0) {
    reasons.push(`source_audit_promotion_relevant_dirty:${input.audit.counts.scopeCounts.promotionRelevantTotal}`)
  }
  return reasons
}

function computeDirtyStateDrift(input: {
  sourceAuditCountsTotal: number
  latestObservedDirtyFilesCount: number | null
  sourceManifestHashMatches: boolean | null
}): { detected: boolean; reason: string | null } {
  if (input.latestObservedDirtyFilesCount == null) {
    return { detected: false, reason: null }
  }
  if (input.latestObservedDirtyFilesCount !== input.sourceAuditCountsTotal) {
    return {
      detected: true,
      reason: `manifest_dirty_count:${input.latestObservedDirtyFilesCount} != source_audit_counts_total:${input.sourceAuditCountsTotal}`,
    }
  }
  if (input.sourceManifestHashMatches === false) {
    return {
      detected: true,
      reason: 'source_manifest_hash_mismatch',
    }
  }
  return { detected: false, reason: null }
}

function readManifestDirtyFilesCount(manifest: EvidenceManifest | null): number | null {
  if (!manifest) return null
  const git = manifest.git as { dirtyFilesCount?: unknown } | undefined
  return typeof git?.dirtyFilesCount === 'number' && Number.isFinite(git.dirtyFilesCount)
    ? git.dirtyFilesCount
    : null
}

function computeAgeMs(olderIso: string | null, newerIso: string): number | null {
  if (!olderIso) return null
  const older = Date.parse(olderIso)
  const newer = Date.parse(newerIso)
  if (!Number.isFinite(older) || !Number.isFinite(newer)) return null
  return Math.max(0, newer - older)
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

async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseDirtyQuarantinePlanArgs(argv)
  const report = await runDirtyQuarantinePlan(args)
  if (args.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderDirtyQuarantinePlanMarkdown(report))
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
