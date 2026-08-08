import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeEvidenceManifestForArtifact } from '../src/runtime/evidence_manifest.js'

const execFileAsync = promisify(execFile)

export type PathGroup = 'src' | 'scripts' | 'docs' | 'data' | 'logs' | 'secrets' | 'other'
export type StatusKind = 'modified' | 'deleted' | 'untracked' | 'added' | 'renamed' | 'copied' | 'typechange' | 'unmerged'
export type ProtocolClass = 'A' | 'B' | 'C' | 'D'

export interface DirtyWorktreeEntry {
  path: string
  originalPath?: string
  porcelain: string
  indexStatus: string
  worktreeStatus: string
  pathGroup: PathGroup
  statusKinds: StatusKind[]
  protocolClass: ProtocolClass
  protocolLabel: string
  reasons: string[]
}

export interface DirtyWorktreeAudit {
  generatedAt: string
  repoRoot: string
  purpose: 'canonical_release' | 'legacy_wip' | 'unknown'
  sourceMode: 'git_worktree' | 'clean_worktree' | 'verified_release' | 'unknown'
  branch: string | null
  commit: string | null
  statusHash: string
  isDirty: boolean
  counts: {
    total: number
    byPathGroup: Record<PathGroup, number>
    byStatusKind: Record<StatusKind, number>
    byProtocolClass: Record<ProtocolClass, number>
    scopeCounts: {
      promotionRelevantTotal: number
      generatedArtifactOnlyTotal: number
      sourceReviewTotal: number
      secretRiskTotal: number
      deletedTrackedTotal: number
    }
  }
  samples: {
    promotionRelevantSamples: DirtyWorktreeEntry[]
    promotionCriticalSamples: DirtyWorktreeEntry[]
    generatedArtifactOnlySamples: DirtyWorktreeEntry[]
    secretRiskSamples: DirtyWorktreeEntry[]
    deletedTrackedSamples: DirtyWorktreeEntry[]
  }
  promotionCriticalScope: {
    description: string
    paths: string[]
    dirtyTotal: number
    sourceCodeDirtyTotal: number
    docsOrReadmeDirtyTotal: number
    generatedArtifactDirtyTotal: number
    clean: boolean
    status: 'clean' | 'dirty'
    entries: DirtyWorktreeEntry[]
  }
  entries: DirtyWorktreeEntry[]
  protocol: Record<ProtocolClass, {
    label: string
    count: number
    action: string
    entries: DirtyWorktreeEntry[]
  }>
  governance: DirtyWorktreeGovernance
}

export interface DirtyWorktreeGovernance {
  evidenceTrust: 'pass' | 'quarantine' | 'fail'
  p2PromotionAllowed: boolean
  monetizationConclusionAllowed: boolean
  runtimeArtifactsQuarantined: boolean
  reviewProtocol: 'clean' | 'dirty_quarantine' | 'secret_risk_fail'
  blockingReasons: string[]
  requiredActions: string[]
  p2RequiredEvidence: string[]
}

export interface AuditCliArgs {
  json: boolean
  outputPath: string | null
  repoRoot?: string | null
  purpose?: DirtyWorktreeAudit['purpose']
  sourceMode?: DirtyWorktreeAudit['sourceMode']
}

const DEFAULT_OUTPUT_PATH = 'data/runtime/dirty_worktree_audit.latest.json'
const DEFAULT_SAMPLE_LIMIT = 25

const PATH_GROUPS: PathGroup[] = ['src', 'scripts', 'docs', 'data', 'logs', 'secrets', 'other']
const STATUS_KINDS: StatusKind[] = ['modified', 'deleted', 'untracked', 'added', 'renamed', 'copied', 'typechange', 'unmerged']
const PROTOCOL_CLASSES: ProtocolClass[] = ['A', 'B', 'C', 'D']

const PROTOCOL_LABELS: Record<ProtocolClass, string> = {
  A: 'source functionality changes',
  B: 'runtime/data/logs should be ignored or archived',
  C: 'docs/research archival changes',
  D: 'secret-risk files require rotation or isolation',
}

const PROTOCOL_ACTIONS: Record<ProtocolClass, string> = {
  A: 'Review as functional source change; keep separate from generated artifacts.',
  B: 'Do not commit by default; ignore, archive, or move into an explicit artifact lane.',
  C: 'Archive intentionally or separate from code changes before review.',
  D: 'Do not commit; rotate exposed credentials if real and isolate the file immediately.',
}

const PROMOTION_CRITICAL_SCOPE_PATHS = [
  'src/domain',
  'src/runtime',
  'scripts/lib',
  'packages/opentypebb',
]

export function parseAuditArgs(argv: string[]): AuditCliArgs {
  const raw = parseRawArgs(argv)
  const result: AuditCliArgs = {
    json: parseBool(raw.get('json'), false),
    outputPath: raw.get('output') ?? raw.get('outputPath') ?? null,
  }
  if (raw.has('repoRoot')) result.repoRoot = raw.get('repoRoot') ?? null
  if (raw.has('purpose')) {
    result.purpose = raw.get('purpose') === 'canonical_release' || raw.get('purpose') === 'legacy_wip'
      ? raw.get('purpose') as DirtyWorktreeAudit['purpose']
      : 'unknown'
  }
  if (raw.has('sourceMode')) {
    result.sourceMode = raw.get('sourceMode') === 'git_worktree' || raw.get('sourceMode') === 'clean_worktree' || raw.get('sourceMode') === 'verified_release'
      ? raw.get('sourceMode') as DirtyWorktreeAudit['sourceMode']
      : 'unknown'
  }
  return result
}

export async function readGitPorcelainStatus(repoRoot = process.cwd()): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  })
  return stdout
}

export function parsePorcelainStatus(raw: string): DirtyWorktreeEntry[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(parsePorcelainLine)
}

export function buildDirtyWorktreeAudit(input: {
  porcelain: string
  repoRoot?: string
  generatedAt?: string
  purpose?: DirtyWorktreeAudit['purpose']
  sourceMode?: DirtyWorktreeAudit['sourceMode']
  branch?: string | null
  commit?: string | null
}): DirtyWorktreeAudit {
  const repoRoot = input.repoRoot ?? process.cwd()
  const entries = parsePorcelainStatus(input.porcelain)
  const counts = {
    total: entries.length,
    byPathGroup: countBy(PATH_GROUPS, entries, (entry) => entry.pathGroup),
    byStatusKind: countManyBy(STATUS_KINDS, entries, (entry) => entry.statusKinds),
    byProtocolClass: countBy(PROTOCOL_CLASSES, entries, (entry) => entry.protocolClass),
    scopeCounts: buildDirtyScopeCounts(entries),
  }
  const samples = buildDirtySamples(entries)
  const promotionCriticalScope = buildPromotionCriticalScope(entries)

  const protocol = Object.fromEntries(
    PROTOCOL_CLASSES.map((protocolClass) => [
      protocolClass,
      {
        label: PROTOCOL_LABELS[protocolClass],
        count: counts.byProtocolClass[protocolClass],
        action: PROTOCOL_ACTIONS[protocolClass],
        entries: entries.filter((entry) => entry.protocolClass === protocolClass),
      },
    ]),
  ) as DirtyWorktreeAudit['protocol']
  const governance = buildDirtyWorktreeGovernance(counts)

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    repoRoot,
    purpose: input.purpose ?? 'unknown',
    sourceMode: input.sourceMode ?? 'unknown',
    branch: input.branch ?? null,
    commit: input.commit ?? null,
    statusHash: createHash('sha256').update(input.porcelain).digest('hex'),
    isDirty: entries.length > 0,
    counts,
    samples,
    promotionCriticalScope,
    entries,
    protocol,
    governance,
  }
}

export function renderDirtyWorktreeMarkdown(audit: DirtyWorktreeAudit): string {
  const lines: string[] = []
  lines.push('# Dirty Worktree Audit')
  lines.push('')
  lines.push(`Repo: \`${audit.repoRoot}\``)
  lines.push(`Purpose: \`${audit.purpose}\``)
  lines.push(`Source mode: \`${audit.sourceMode}\``)
  lines.push(`Commit: \`${audit.commit ?? 'unknown'}\``)
  lines.push(`Status hash: \`${audit.statusHash}\``)
  lines.push(`Generated: \`${audit.generatedAt}\``)
  lines.push(`Dirty entries: ${audit.counts.total}`)
  lines.push(`Promotion-relevant dirty entries: ${audit.counts.scopeCounts.promotionRelevantTotal}`)
  lines.push(`Promotion-critical scope dirty entries: ${audit.promotionCriticalScope.dirtyTotal}`)
  lines.push(`Generated-artifact-only dirty entries: ${audit.counts.scopeCounts.generatedArtifactOnlyTotal}`)
  lines.push(`Secret-risk dirty entries: ${audit.counts.scopeCounts.secretRiskTotal}`)
  lines.push(`Deleted tracked dirty entries: ${audit.counts.scopeCounts.deletedTrackedTotal}`)
  lines.push('')
  lines.push('## Protocol Summary')
  lines.push('')
  for (const protocolClass of PROTOCOL_CLASSES) {
    const item = audit.protocol[protocolClass]
    lines.push(`- ${protocolClass}: ${item.label} - ${item.count}`)
    lines.push(`  Action: ${item.action}`)
  }
  lines.push('')
  lines.push('## Governance')
  lines.push('')
  lines.push(`- evidenceTrust: ${audit.governance.evidenceTrust}`)
  lines.push(`- reviewProtocol: ${audit.governance.reviewProtocol}`)
  lines.push(`- p2PromotionAllowed: ${audit.governance.p2PromotionAllowed}`)
  lines.push(`- monetizationConclusionAllowed: ${audit.governance.monetizationConclusionAllowed}`)
  lines.push(`- runtimeArtifactsQuarantined: ${audit.governance.runtimeArtifactsQuarantined}`)
  lines.push(`- promotionCriticalScope: ${audit.promotionCriticalScope.status}`)
  lines.push(`- blockingReasons: ${audit.governance.blockingReasons.join(',') || 'none'}`)
  lines.push('')
  lines.push('### Required Actions')
  lines.push('')
  for (const action of audit.governance.requiredActions) {
    lines.push(`- ${action}`)
  }
  lines.push('')
  lines.push('### P2 Required Evidence')
  lines.push('')
  for (const artifact of audit.governance.p2RequiredEvidence) {
    lines.push(`- ${artifact}`)
  }
  lines.push('')
  lines.push('## Path Groups')
  lines.push('')
  for (const group of PATH_GROUPS) {
    lines.push(`- ${group}: ${audit.counts.byPathGroup[group]}`)
  }
  lines.push('')
  lines.push('## Status Kinds')
  lines.push('')
  for (const kind of STATUS_KINDS) {
    lines.push(`- ${kind}: ${audit.counts.byStatusKind[kind]}`)
  }
  lines.push('')
  lines.push('## Top-Level Samples')
  lines.push('')
  appendSampleSection(lines, 'Promotion Relevant', audit.samples.promotionRelevantSamples)
  appendSampleSection(lines, 'Promotion Critical', audit.samples.promotionCriticalSamples)
  appendSampleSection(lines, 'Generated Artifact Only', audit.samples.generatedArtifactOnlySamples)
  appendSampleSection(lines, 'Secret Risk', audit.samples.secretRiskSamples)
  appendSampleSection(lines, 'Deleted Tracked', audit.samples.deletedTrackedSamples)
  lines.push('')
  lines.push('## Entries')
  lines.push('')
  if (audit.entries.length === 0) {
    lines.push('No dirty worktree entries.')
  } else {
    lines.push('| protocol | pathGroup | status | porcelain | path | reasons |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const entry of audit.entries) {
      lines.push(
        `| ${entry.protocolClass} | ${entry.pathGroup} | ${entry.statusKinds.join(',')} | ` +
        `\`${escapePipe(entry.porcelain)}\` | \`${escapePipe(entry.path)}\` | ${escapePipe(entry.reasons.join('; '))} |`,
      )
    }
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const startedAt = new Date()
  const args = parseAuditArgs(argv)
  const repoRoot = args.repoRoot ? resolve(args.repoRoot) : process.cwd()
  const sourceMode = args.sourceMode ?? 'git_worktree'
  let porcelain = ''
  let branch: string | null = null
  let commit: string | null = null
  if (sourceMode === 'verified_release') {
    const manifestPath = resolve(repoRoot, 'release_manifest.v1.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
    if (manifest.liveExecutionArmed !== false || typeof manifest.sourceCommit !== 'string' || typeof manifest.dirtyStateHash !== 'string') {
      throw new Error('verified_release_audit_manifest_invalid')
    }
    branch = null
    commit = manifest.sourceCommit
  } else {
    porcelain = await readGitPorcelainStatus(repoRoot)
    branch = await readGitValue(repoRoot, ['symbolic-ref', '--short', 'HEAD'])
    commit = await readGitValue(repoRoot, ['rev-parse', 'HEAD'])
  }
  const audit = buildDirtyWorktreeAudit({
    porcelain,
    repoRoot,
    purpose: args.purpose ?? 'unknown',
    sourceMode,
    branch,
    commit,
  })
  const outputPath = args.outputPath ? resolve(args.outputPath) : null
  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf-8')
    await writeEvidenceManifestForArtifact({
      job: 'dirty_worktree_audit',
      artifactPath: outputPath,
      startedAt,
      finishedAt: new Date(),
      exitCode: 0,
      businessStatus: audit.counts.byProtocolClass.D > 0 ? 'fail' : audit.isDirty ? 'warn' : 'pass',
      recordsIn: audit.counts.total,
      recordsOut: audit.counts.total,
      errorClass: audit.governance.blockingReasons[0] ?? null,
    })
  }
  if (args.json) {
    console.log(JSON.stringify(audit, null, 2))
  } else {
    console.log(renderDirtyWorktreeMarkdown(audit))
  }
}

async function readGitValue(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: repoRoot })
    return stdout.trim() || null
  } catch {
    return null
  }
}

function buildDirtyWorktreeGovernance(
  counts: DirtyWorktreeAudit['counts'],
): DirtyWorktreeGovernance {
  const blockingReasons: string[] = []
  const requiredActions: string[] = []

  if (counts.byProtocolClass.D > 0) {
    blockingReasons.push('secret_risk_dirty_file')
    requiredActions.push('Do not commit protocol D files; isolate them and rotate exposed credentials if real.')
  }
  if (counts.total > 0) {
    blockingReasons.push('dirty_worktree')
    requiredActions.push('Treat every artifact generated from this worktree as quarantine evidence.')
  }
  if (counts.byProtocolClass.A > 0) {
    blockingReasons.push('source_changes_require_review')
    requiredActions.push('Review protocol A source changes separately from generated/runtime artifacts.')
  }
  if (counts.byStatusKind.deleted > 0) {
    blockingReasons.push('deleted_files_require_explicit_review')
    requiredActions.push('Resolve deleted tracked files explicitly; do not bulk restore or bulk commit.')
  }
  if (counts.byProtocolClass.B > 0) {
    blockingReasons.push('runtime_artifacts_dirty')
    requiredActions.push('Move protocol B runtime/data/log artifacts into ignore/archive lanes before promotion review.')
    requiredActions.push('Do not let promotion consume dirty runtime artifacts unless the dirty-worktree audit and manifest both pass.')
  }
  if (counts.scopeCounts.generatedArtifactOnlyTotal > 0) {
    requiredActions.push('Review generated-artifact-only dirty files separately; they explain artifact churn but do not make the worktree clean.')
  }
  if (counts.byProtocolClass.C > 0) {
    blockingReasons.push('docs_research_archive_dirty')
    requiredActions.push('Archive protocol C docs/research changes independently from executable code changes.')
  }
  if (counts.total === 0) {
    requiredActions.push('No dirty worktree action required.')
  }

  const evidenceTrust = counts.byProtocolClass.D > 0
    ? 'fail'
    : counts.total > 0
      ? 'quarantine'
      : 'pass'
  const p2RequiredEvidence = evidenceTrust === 'pass'
    ? [
        'data/runtime/dirty_worktree_audit.latest.json:governance.p2PromotionAllowed=true',
        'data/runtime/dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass',
      ]
    : [
        'data/runtime/dirty_worktree_audit.latest.json:counts.total=0,governance.p2PromotionAllowed=true',
        'data/runtime/dirty_worktree_audit.latest.json.manifest.json:evidenceTrust=pass,dqStatus=pass,artifactHash=match',
      ]

  return {
    evidenceTrust,
    p2PromotionAllowed: evidenceTrust === 'pass',
    monetizationConclusionAllowed: evidenceTrust === 'pass',
    runtimeArtifactsQuarantined: counts.total > 0,
    reviewProtocol: evidenceTrust === 'pass'
      ? 'clean'
      : evidenceTrust === 'fail'
        ? 'secret_risk_fail'
        : 'dirty_quarantine',
    blockingReasons,
    requiredActions,
    p2RequiredEvidence,
  }
}

function parsePorcelainLine(line: string): DirtyWorktreeEntry {
  const indexStatus = line[0] ?? ' '
  const worktreeStatus = line[1] ?? ' '
  const body = line.slice(3)
  const renameParts = body.split(' -> ')
  const originalPath = renameParts.length > 1 ? renameParts[0] : undefined
  const path = renameParts.length > 1 ? renameParts.slice(1).join(' -> ') : body
  const statusKinds = classifyStatusKinds(indexStatus, worktreeStatus)
  const pathGroup = classifyPathGroup(path)
  const secretRisk = isSecretRiskPath(path) || (originalPath ? isSecretRiskPath(originalPath) : false)
  const { protocolClass, reasons } = classifyProtocol({
    path,
    pathGroup,
    statusKinds,
    secretRisk,
  })

  return {
    path,
    ...(originalPath ? { originalPath } : {}),
    porcelain: line.slice(0, 2),
    indexStatus,
    worktreeStatus,
    pathGroup,
    statusKinds,
    protocolClass,
    protocolLabel: PROTOCOL_LABELS[protocolClass],
    reasons,
  }
}

function classifyStatusKinds(indexStatus: string, worktreeStatus: string): StatusKind[] {
  const statuses = new Set<StatusKind>()
  const raw = `${indexStatus}${worktreeStatus}`
  if (raw === '??') statuses.add('untracked')
  if (raw.includes('M')) statuses.add('modified')
  if (raw.includes('D')) statuses.add('deleted')
  if (raw.includes('A')) statuses.add('added')
  if (raw.includes('R')) statuses.add('renamed')
  if (raw.includes('C')) statuses.add('copied')
  if (raw.includes('T')) statuses.add('typechange')
  if (raw.includes('U')) statuses.add('unmerged')
  return [...statuses]
}

function classifyPathGroup(path: string): PathGroup {
  const normalized = normalizePath(path)
  if (isSecretRiskPath(normalized)) return 'secrets'
  if (normalized.startsWith('src/')) return 'src'
  if (normalized.startsWith('scripts/')) return 'scripts'
  if (normalized.startsWith('docs/')) return 'docs'
  if (
    normalized.startsWith('data/') ||
    normalized.startsWith('runtime/') ||
    normalized.startsWith('generated/') ||
    normalized.startsWith('.cache/') ||
    normalized.startsWith('coverage/')
  ) {
    return 'data'
  }
  if (
    normalized.startsWith('logs/') ||
    normalized.includes('/logs/') ||
    normalized.endsWith('.log') ||
    normalized.endsWith('.jsonl')
  ) {
    return 'logs'
  }
  return 'other'
}

function classifyProtocol(input: {
  path: string
  pathGroup: PathGroup
  statusKinds: StatusKind[]
  secretRisk: boolean
}): { protocolClass: ProtocolClass; reasons: string[] } {
  const normalized = normalizePath(input.path)
  if (input.secretRisk) {
    return { protocolClass: 'D', reasons: ['secret-risk path or credential-like filename'] }
  }
  if (input.pathGroup === 'data' || input.pathGroup === 'logs') {
    return { protocolClass: 'B', reasons: [`${input.pathGroup} artifact`] }
  }
  if (
    normalized.startsWith('docs/research/') ||
    normalized.startsWith('docs/archive/') ||
    normalized.includes('/archive/')
  ) {
    return { protocolClass: 'C', reasons: ['docs/research archival lane'] }
  }
  if (input.pathGroup === 'docs') {
    return { protocolClass: 'C', reasons: ['documentation lane'] }
  }
  if (input.pathGroup === 'src' || input.pathGroup === 'scripts') {
    return { protocolClass: 'A', reasons: [`${input.pathGroup} source lane`] }
  }
  if (input.statusKinds.includes('deleted')) {
    return { protocolClass: 'A', reasons: ['deleted tracked file needs explicit review'] }
  }
  return { protocolClass: 'A', reasons: ['uncategorized dirty file needs source review'] }
}

function buildDirtyScopeCounts(entries: DirtyWorktreeEntry[]): DirtyWorktreeAudit['counts']['scopeCounts'] {
  const generatedArtifactOnly = entries.filter(isGeneratedArtifactOnlyEntry)
  const deletedTracked = entries.filter(
    entry => entry.statusKinds.includes('deleted') && !entry.statusKinds.includes('untracked'),
  )
  const secretRisk = entries.filter(entry => entry.protocolClass === 'D')
  const sourceReview = entries.filter(entry => entry.protocolClass === 'A' || entry.protocolClass === 'C')
  const generatedSet = new Set(generatedArtifactOnly)
  return {
    promotionRelevantTotal: entries.filter(entry => !generatedSet.has(entry)).length,
    generatedArtifactOnlyTotal: generatedArtifactOnly.length,
    sourceReviewTotal: sourceReview.length,
    secretRiskTotal: secretRisk.length,
    deletedTrackedTotal: deletedTracked.length,
  }
}

function buildDirtySamples(entries: DirtyWorktreeEntry[]): DirtyWorktreeAudit['samples'] {
  const generatedArtifactOnly = entries.filter(isGeneratedArtifactOnlyEntry)
  const generatedSet = new Set(generatedArtifactOnly)
  const promotionCriticalScope = buildPromotionCriticalScope(entries)
  return {
    promotionRelevantSamples: sampleEntries(entries.filter(entry => !generatedSet.has(entry))),
    promotionCriticalSamples: sampleEntries(promotionCriticalScope.entries),
    generatedArtifactOnlySamples: sampleEntries(generatedArtifactOnly),
    secretRiskSamples: sampleEntries(entries.filter(entry => entry.protocolClass === 'D')),
    deletedTrackedSamples: sampleEntries(entries.filter(
      entry => entry.statusKinds.includes('deleted') && !entry.statusKinds.includes('untracked'),
    )),
  }
}

function buildPromotionCriticalScope(entries: DirtyWorktreeEntry[]): DirtyWorktreeAudit['promotionCriticalScope'] {
  const scopedEntries = entries.filter(isPromotionCriticalEntry)
  const sourceCodeDirtyTotal = scopedEntries.filter(entry => isPromotionCriticalSourceCodeEntry(entry)).length
  const docsOrReadmeDirtyTotal = scopedEntries.filter(entry => isDocsOrReadmeEntry(entry)).length
  const generatedArtifactDirtyTotal = scopedEntries.filter(isGeneratedArtifactOnlyEntry).length
  return {
    description: 'Narrow executable promotion scope used to separate core trading code dirtiness from unrelated docs/archive churn.',
    paths: PROMOTION_CRITICAL_SCOPE_PATHS,
    dirtyTotal: scopedEntries.length,
    sourceCodeDirtyTotal,
    docsOrReadmeDirtyTotal,
    generatedArtifactDirtyTotal,
    clean: scopedEntries.length === 0,
    status: scopedEntries.length === 0 ? 'clean' : 'dirty',
    entries: scopedEntries,
  }
}

function isPromotionCriticalEntry(entry: DirtyWorktreeEntry): boolean {
  const normalized = normalizePath(entry.path)
  return PROMOTION_CRITICAL_SCOPE_PATHS.some(scope => normalized === scope || normalized.startsWith(`${scope}/`))
}

function isPromotionCriticalSourceCodeEntry(entry: DirtyWorktreeEntry): boolean {
  if (!isPromotionCriticalEntry(entry)) return false
  if (isGeneratedArtifactOnlyEntry(entry)) return false
  if (isDocsOrReadmeEntry(entry)) return false
  return true
}

function isDocsOrReadmeEntry(entry: DirtyWorktreeEntry): boolean {
  const normalized = normalizePath(entry.path)
  const basename = normalized.split('/').at(-1)?.toLowerCase() ?? normalized
  return normalized.startsWith('docs/') ||
    basename === 'readme.md' ||
    basename === 'design.md' ||
    basename.endsWith('.md')
}

function sampleEntries(entries: DirtyWorktreeEntry[], limit = DEFAULT_SAMPLE_LIMIT): DirtyWorktreeEntry[] {
  return entries.slice(0, limit)
}

function isGeneratedArtifactOnlyEntry(entry: DirtyWorktreeEntry): boolean {
  if (entry.protocolClass !== 'B') return false
  const normalized = normalizePath(entry.path)
  if (entry.statusKinds.includes('deleted')) return false
  if (normalized.startsWith('data/runtime/') || normalized.startsWith('runtime/')) return true
  if (normalized.startsWith('logs/') || normalized.endsWith('.log')) return true
  if (normalized.startsWith('coverage/') || normalized.startsWith('.cache/')) return true
  return false
}

function isSecretRiskPath(path: string): boolean {
  const normalized = normalizePath(path)
  const basename = normalized.split('/').at(-1) ?? normalized
  if (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.pem') ||
    basename.endsWith('.key') ||
    basename.endsWith('.p12') ||
    basename.endsWith('.pfx') ||
    basename.endsWith('.kubeconfig')
  ) {
    return true
  }
  return /(^|[._/-])(secret|secrets|credential|credentials|token|api[_-]?key|private[_-]?key|id_rsa|id_dsa|id_ed25519)([._/-]|$)/i
    .test(normalized)
}

function countBy<T extends string>(
  keys: readonly T[],
  entries: DirtyWorktreeEntry[],
  selector: (entry: DirtyWorktreeEntry) => T,
): Record<T, number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>
  for (const entry of entries) out[selector(entry)] += 1
  return out
}

function countManyBy<T extends string>(
  keys: readonly T[],
  entries: DirtyWorktreeEntry[],
  selector: (entry: DirtyWorktreeEntry) => T[],
): Record<T, number> {
  const out = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>
  for (const entry of entries) {
    for (const key of selector(entry)) out[key] += 1
  }
  return out
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

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false
  throw new Error(`Invalid boolean value: ${value}`)
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function escapePipe(value: string): string {
  return value.replaceAll('|', '\\|')
}

function appendSampleSection(
  lines: string[],
  title: string,
  entries: DirtyWorktreeEntry[],
): void {
  lines.push(`### ${title}`)
  lines.push('')
  if (entries.length === 0) {
    lines.push('No samples.')
    lines.push('')
    return
  }
  for (const entry of entries) {
    lines.push(`- ${entry.protocolClass} ${entry.statusKinds.join(',')}: \`${entry.path}\``)
  }
  lines.push('')
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
