import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
type Mode = 'observe' | 'candidate' | 'promote'
type Recommendation = 'reject' | 'watch' | 'paper-candidate'
type GateStatus = 'pass' | 'fail' | 'missing'

interface CliArgs {
  mode: Mode
  repoRoot: string
  dataRoot: string
  evolutionRoot: string
  candidateId: string | null
  approvalPath: string | null
  approvalSecretEnv: string
  notificationPath: string
  force: boolean
  json: boolean
}

interface EvidenceBinding {
  id: string
  path: string
  exists: boolean
  sha256: string | null
  size: number | null
  mtime: string | null
  status: GateStatus
  reason: string
}

interface ValidationCheck {
  id: string
  status: GateStatus
  sourcePath: string | null
  reason: string
}

interface ApprovalDocument {
  schemaVersion: 1
  candidateId: string
  action: 'promote-to-paper-shadow'
  approvedBy: string
  approvedAt: string
  expiresAt: string
  signature: string
}

interface RunResult {
  mode: Mode
  status: string
  generatedAt: string
  candidateId?: string
  outputPath?: string
  blockers?: string[]
  recommendation?: Recommendation
}

export interface CandidateBundle {
  schemaVersion: 1
  candidateId: string
  generatedAt: string
  mode: 'candidate'
  safety: {
    researchOnly: true
    paperShadowOnly: true
    sourceMutationAllowed: false
    productionConfigMutationAllowed: false
    accountMutationAllowed: false
    tradingGateMutationAllowed: false
    orderCreationAllowed: false
  }
  parent: {
    configPath: string
    configHash: string | null
    sourceCommit: string | null
    dirtyWorktreeHash: string
    dirtyFileCount: number
  }
  materialDelta: {
    digest: string
    previousDigest: string | null
    changed: boolean
    inputs: EvidenceBinding[]
  }
  proposedCandidate: {
    strategyFamily: 'low_vol_research'
    parameters: Record<string, number | string | boolean>
    rationale: string[]
    patchSuggestions: string[]
  }
  validation: {
    status: 'pass' | 'blocked'
    checks: ValidationCheck[]
    missingMethods: Array<{ method: 'PBO' | 'DSR' | 'FDR'; reason: string }>
    baselines: Array<{ id: 'no-trade' | 'simple-btc-buy-hold' | 'current-champion'; status: GateStatus; reason: string }>
    failureConditions: string[]
  }
  recommendation: Recommendation
  recommendedActionReason: string
}

const MATERIAL_INPUTS = [
  ['paper-trade-results', 'paper_trading/paper_trade_result.jsonl'],
  ['paper-trade-log', 'paper_trading/trade_log.jsonl'],
  ['low-vol-research', 'research/low_vol_research_daily.latest.json'],
  ['external-derivatives-audit', 'runtime/external_derivatives_data_audit.latest.json'],
  ['route-cost-readiness', 'runtime/okx_route_cost_slippage_readiness.latest.json'],
  ['pit-audit', 'runtime/pit_audit_global_gate_status.latest.json'],
  ['wfo-status', 'runtime/wfo_stability_gate_status.latest.json'],
] as const

const VALIDATION_SOURCES = {
  schedulerSecurity: 'runtime/scheduler_security_audit.latest.json',
  dataQuality: 'runtime/external_derivatives_data_audit.latest.json',
  pit: 'runtime/pit_audit_global_gate_status.latest.json',
  cost: 'runtime/okx_route_cost_slippage_readiness.latest.json',
  wfo: 'runtime/wfo_stability_gate_status.latest.json',
  releaseGate: 'runtime/release_gate_status.json',
  promotion: 'runtime/strategy_promotion.latest.json',
  dirtyWorktree: 'runtime/dirty_worktree_audit.latest.json',
  stopLoss: 'runtime/microstructure_stoploss_replay.latest.json',
} as const

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const result = await runGatedImprovement(args)
  if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  if (result.status.startsWith('rejected') || result.status.startsWith('blocked')) process.exitCode = 2
}

export function parseArgs(argv: string[]): CliArgs {
  const raw = parseRawArgs(argv)
  const mode = parseMode(raw.get('mode') ?? 'observe')
  const repoRoot = resolve(raw.get('repoRoot') ?? '.')
  const dataRoot = resolve(raw.get('dataRoot') ?? process.env.OPENALICE_DATA_ROOT ?? join(repoRoot, 'data'))
  const evolutionRoot = resolve(raw.get('evolutionRoot') ?? join(dataRoot, 'research', 'evolution'))
  return {
    mode,
    repoRoot,
    dataRoot,
    evolutionRoot,
    candidateId: normalizeOptional(raw.get('candidateId')),
    approvalPath: normalizeOptional(raw.get('approvalPath')),
    approvalSecretEnv: raw.get('approvalSecretEnv') ?? 'OPENALICE_CANDIDATE_APPROVAL_SECRET',
    notificationPath: resolve(raw.get('notificationPath') ?? join(dataRoot, 'runtime', 'gated_improvement_notification.json')),
    force: parseBool(raw.get('force'), false),
    json: parseBool(raw.get('json'), false),
  }
}

export async function runGatedImprovement(args: CliArgs): Promise<RunResult> {
  enforceEvolutionRoot(args)
  if (args.mode === 'observe') return runObserve(args)
  if (args.mode === 'candidate') return runCandidate(args)
  return runPromote(args)
}

async function runObserve(args: CliArgs): Promise<RunResult> {
  const generatedAt = new Date().toISOString()
  const inputs = await collectMaterialInputs(args.dataRoot)
  const observation = {
    schemaVersion: 1,
    generatedAt,
    mode: 'observe',
    researchOnly: true,
    sourceMutationAllowed: false,
    productionConfigMutationAllowed: false,
    inputs,
    opportunities: inputs.filter(input => input.status !== 'pass').map(input => ({
      evidenceId: input.id,
      reason: input.reason,
      action: 'collect_or_validate_more_evidence',
    })),
  }
  const outputPath = join(args.evolutionRoot, 'observations', `observe_${compactUtc(generatedAt)}.json`)
  await atomicWriteJson(outputPath, observation)
  const result: RunResult = { mode: 'observe', status: 'complete', generatedAt, outputPath }
  await writeNotification(args.notificationPath, result, false)
  return result
}

async function runCandidate(args: CliArgs): Promise<RunResult> {
  const generatedAt = new Date().toISOString()
  const inputs = await collectMaterialInputs(args.dataRoot)
  const digest = sha256(JSON.stringify(inputs.map(input => [input.id, input.sha256, input.mtime])))
  const statePath = join(args.evolutionRoot, 'state', 'candidate_material_delta.json')
  const previousState = await readJsonIfExists(statePath)
  const previousDigest = readString(previousState?.digest)
  if (!args.force && previousDigest === digest) {
    const outputPath = join(args.evolutionRoot, 'validation', `suppressed_${compactUtc(generatedAt)}.json`)
    const result: RunResult = { mode: 'candidate', status: 'suppressed_no_material_delta', generatedAt, outputPath }
    await atomicWriteJson(outputPath, { ...result, materialDigest: digest, previousDigest })
    await writeNotification(args.notificationPath, result, false)
    return result
  }

  const git = await readGitSnapshot(args.repoRoot)
  const parentConfigPath = join(args.dataRoot, 'research', 'best_config.json')
  const parentConfig = await readJsonIfExists(parentConfigPath)
  const candidateId = args.candidateId ?? `candidate_${compactUtc(generatedAt)}_${randomUUID().slice(0, 8)}`
  validateCandidateId(candidateId)
  const candidateDir = join(args.evolutionRoot, 'candidates', candidateId)
  const validation = await buildValidation(args.dataRoot)
  const proposedCandidate = buildProposedCandidate(parentConfig)
  const recommendation = decideRecommendation(validation.checks)
  const bundle: CandidateBundle = {
    schemaVersion: 1,
    candidateId,
    generatedAt,
    mode: 'candidate',
    safety: {
      researchOnly: true,
      paperShadowOnly: true,
      sourceMutationAllowed: false,
      productionConfigMutationAllowed: false,
      accountMutationAllowed: false,
      tradingGateMutationAllowed: false,
      orderCreationAllowed: false,
    },
    parent: {
      configPath: parentConfigPath,
      configHash: await hashFileIfExists(parentConfigPath),
      sourceCommit: git.commit,
      dirtyWorktreeHash: git.dirtyHash,
      dirtyFileCount: git.dirtyFileCount,
    },
    materialDelta: { digest, previousDigest, changed: previousDigest !== digest, inputs },
    proposedCandidate,
    validation: {
      status: recommendation === 'paper-candidate' ? 'pass' : 'blocked',
      checks: validation.checks,
      missingMethods: validation.missingMethods,
      baselines: buildBaselineAssessment(args.dataRoot, parentConfig),
      failureConditions: [
        'Reject if any point-in-time or leakage audit fails or is unavailable.',
        'Reject if realistic cost and slippage coverage does not exceed the configured threshold.',
        'Reject if WFO/OOS evidence is missing, unstable, or materially worse than no-trade, a simple baseline, or the current champion.',
        'Reject if scheduler security, data quality, release, quarantine, or stop-loss gates are not pass.',
        'Never promote beyond paper/shadow without separate human approval and a new evidence review.',
      ],
    },
    recommendation,
    recommendedActionReason: recommendationReason(recommendation, validation.checks),
  }

  await Promise.all([
    atomicWriteJson(join(candidateDir, 'candidate.json'), bundle),
    atomicWriteJson(join(candidateDir, 'validation.json'), bundle.validation),
    atomicWriteJson(join(candidateDir, 'data_manifest.json'), { generatedAt, digest, inputs }),
    atomicWriteJson(join(candidateDir, 'proposed_paper_config.json'), {
      schemaVersion: 1,
      candidateId,
      paperShadowOnly: true,
      executionAllowed: false,
      parentConfigHash: bundle.parent.configHash,
      parameters: proposedCandidate.parameters,
    }),
    atomicWriteJson(join(candidateDir, 'README.json'), {
      candidateId,
      recommendation,
      humanApprovalRequired: true,
      allowedPromotionTarget: 'paper-shadow-only',
      prohibitedTargets: ['source-code', 'production-config', 'private-account', 'live-trading'],
    }),
  ])
  await atomicWriteJson(statePath, { generatedAt, digest, candidateId })
  const result: RunResult = {
    mode: 'candidate', status: 'candidate_generated', generatedAt, candidateId, outputPath: candidateDir, recommendation,
    blockers: validation.checks.filter(check => check.status !== 'pass').map(check => `${check.id}:${check.reason}`),
  }
  await writeNotification(args.notificationPath, result, recommendation !== 'paper-candidate')
  return result
}

async function runPromote(args: CliArgs): Promise<RunResult> {
  const generatedAt = new Date().toISOString()
  if (!args.candidateId) throw new Error('promote requires --candidateId')
  validateCandidateId(args.candidateId)
  const candidateDir = join(args.evolutionRoot, 'candidates', args.candidateId)
  const candidatePath = join(candidateDir, 'candidate.json')
  const bundle = await readRequiredJson(candidatePath) as unknown as CandidateBundle
  const blockers: string[] = []
  if (bundle.candidateId !== args.candidateId) blockers.push('candidate_id_mismatch')
  if (bundle.recommendation !== 'paper-candidate' || bundle.validation.status !== 'pass') blockers.push('candidate_validation_not_pass')
  if (!args.approvalPath) blockers.push('human_approval_missing')
  else blockers.push(...await verifyApproval(args, args.candidateId))
  blockers.push(...await validatePromotionEnvironment(args.dataRoot))

  if (blockers.length > 0) {
    const outputPath = join(candidateDir, `promotion_reject_${compactUtc(generatedAt)}.json`)
    const result: RunResult = { mode: 'promote', status: 'rejected_gate_failure', generatedAt, candidateId: args.candidateId, outputPath, blockers }
    await atomicWriteJson(outputPath, {
      ...result,
      sourceMutationPerformed: false,
      productionConfigMutationPerformed: false,
      accountMutationPerformed: false,
      orderCreationPerformed: false,
    })
    await writeNotification(args.notificationPath, result, true)
    return result
  }

  const proposedConfig = await readRequiredJson(join(candidateDir, 'proposed_paper_config.json'))
  const targetPath = join(args.dataRoot, 'paper_shadow', 'promoted_candidates', args.candidateId, 'paper_config.json')
  await atomicWriteJson(targetPath, {
    ...proposedConfig,
    promotedAt: generatedAt,
    target: 'paper-shadow-only',
    liveTradingAllowed: false,
    executionAllowed: false,
    requiresPromotionV2ForPaperExecution: true,
  })
  const result: RunResult = { mode: 'promote', status: 'promoted_to_paper_shadow', generatedAt, candidateId: args.candidateId, outputPath: targetPath }
  await atomicWriteJson(join(candidateDir, `promotion_${compactUtc(generatedAt)}.json`), result)
  await writeNotification(args.notificationPath, result, true)
  return result
}

async function buildValidation(dataRoot: string): Promise<{ checks: ValidationCheck[]; missingMethods: CandidateBundle['validation']['missingMethods'] }> {
  const checks = await Promise.all([
    checkArtifact(dataRoot, 'scheduler_security', VALIDATION_SOURCES.schedulerSecurity, ['pass']),
    checkArtifact(dataRoot, 'data_quality', VALIDATION_SOURCES.dataQuality, ['complete', 'pass']),
    checkArtifact(dataRoot, 'pit_time_leakage', VALIDATION_SOURCES.pit, ['pass']),
    checkArtifact(dataRoot, 'cost_slippage', VALIDATION_SOURCES.cost, ['pass', 'ready', 'complete']),
    checkArtifact(dataRoot, 'walk_forward_oos', VALIDATION_SOURCES.wfo, ['pass']),
    checkArtifact(dataRoot, 'release_gate', VALIDATION_SOURCES.releaseGate, ['PASS', 'pass'], ['allowPaperTrading']),
    checkArtifact(dataRoot, 'promotion_quarantine', VALIDATION_SOURCES.promotion, ['paper_allowed']),
    checkArtifact(dataRoot, 'dirty_worktree_traceability', VALIDATION_SOURCES.dirtyWorktree, [], [], true),
  ])
  return {
    checks,
    missingMethods: [
      { method: 'PBO', reason: 'No dedicated PBO artifact is registered in the canonical runtime evidence set.' },
      { method: 'DSR', reason: 'No dedicated deflated Sharpe ratio artifact is registered in the canonical runtime evidence set.' },
      { method: 'FDR', reason: 'FDR evidence is not independently sealed and bound to this candidate.' },
    ],
  }
}

async function validatePromotionEnvironment(dataRoot: string): Promise<string[]> {
  const blockers: string[] = []
  const validation = await buildValidation(dataRoot)
  for (const check of validation.checks) {
    if (check.id === 'dirty_worktree_traceability') {
      if (check.status === 'missing') blockers.push(`${check.id}:${check.reason}`)
    } else if (check.status !== 'pass') blockers.push(`${check.id}:${check.reason}`)
  }
  const accounts = await readJsonIfExists(join(dataRoot, 'config', 'accounts.json'))
  const activeAccounts = Array.isArray(accounts) ? accounts.filter(isActivePrivateAccount).length : accounts == null ? 0 : 1
  if (activeAccounts > 0) blockers.push(`active_private_accounts:${activeAccounts}`)
  const agent = await readJsonIfExists(join(dataRoot, 'config', 'agent.json'))
  if (agent?.evolutionMode === true) blockers.push('global_evolution_mode_enabled')
  const stopLoss = await readJsonIfExists(join(dataRoot, VALIDATION_SOURCES.stopLoss))
  const stopStatus = artifactStatus(stopLoss)
  if (stopLoss && !['pass', 'complete', 'ok'].includes(stopStatus)) blockers.push(`stop_loss_blocker:${stopStatus}`)
  return blockers
}

async function verifyApproval(args: CliArgs, candidateId: string): Promise<string[]> {
  const approval = await readRequiredJson(args.approvalPath!) as unknown as ApprovalDocument
  const blockers: string[] = []
  if (approval.schemaVersion !== 1) blockers.push('approval_schema_invalid')
  if (approval.candidateId !== candidateId) blockers.push('approval_candidate_mismatch')
  if (approval.action !== 'promote-to-paper-shadow') blockers.push('approval_action_invalid')
  if (!approval.approvedBy?.trim()) blockers.push('approval_actor_missing')
  if (!Number.isFinite(Date.parse(approval.approvedAt))) blockers.push('approval_time_invalid')
  if (!Number.isFinite(Date.parse(approval.expiresAt)) || Date.parse(approval.expiresAt) <= Date.now()) blockers.push('approval_expired')
  const secret = process.env[args.approvalSecretEnv]
  if (!secret) return [...blockers, `approval_secret_missing:${args.approvalSecretEnv}`]
  const expected = signApprovalPayload(approval, secret)
  const actual = approval.signature ?? ''
  if (actual.length !== expected.length || !timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) blockers.push('approval_signature_invalid')
  return blockers
}

export function signApprovalPayload(approval: Omit<ApprovalDocument, 'signature'> | ApprovalDocument, secret: string): string {
  const payload = [approval.schemaVersion, approval.candidateId, approval.action, approval.approvedBy, approval.approvedAt, approval.expiresAt].join('\n')
  return createHmac('sha256', secret).update(payload).digest('hex')
}

async function checkArtifact(dataRoot: string, id: string, relativePath: string, allowedStatuses: string[], trueFields: string[] = [], existenceOnly = false): Promise<ValidationCheck> {
  const path = join(dataRoot, relativePath)
  const artifact = await readJsonIfExists(path)
  if (artifact == null) return { id, status: 'missing', sourcePath: path, reason: 'artifact_missing' }
  if (existenceOnly) return { id, status: 'pass', sourcePath: path, reason: 'artifact_present_and_hashable' }
  const status = artifactStatus(artifact)
  const fieldsPass = trueFields.every(field => artifact[field] === true)
  const statusPass = allowedStatuses.some(allowed => allowed.toLowerCase() === status.toLowerCase())
  return {
    id,
    status: statusPass && fieldsPass ? 'pass' : 'fail',
    sourcePath: path,
    reason: statusPass && fieldsPass ? `status=${status}` : `status=${status || 'unknown'} required=${allowedStatuses.join('|')} fields=${trueFields.join('|') || 'none'}`,
  }
}

async function collectMaterialInputs(dataRoot: string): Promise<EvidenceBinding[]> {
  return Promise.all(MATERIAL_INPUTS.map(async ([id, relativePath]) => {
    const path = join(dataRoot, relativePath)
    if (!existsSync(path)) return { id, path, exists: false, sha256: null, size: null, mtime: null, status: 'missing' as const, reason: 'artifact_missing' }
    const [raw, fileStat] = await Promise.all([readFile(path), stat(path)])
    const json = path.endsWith('.json') ? safeParseJson(raw.toString('utf-8')) : null
    const status = json ? artifactStatus(json) : 'present'
    return {
      id, path, exists: true, sha256: sha256(raw), size: fileStat.size, mtime: fileStat.mtime.toISOString(),
      status: ['pass', 'complete', 'ready', 'present'].includes(status.toLowerCase()) ? 'pass' as const : 'fail' as const,
      reason: `status=${status}`,
    }
  }))
}

function buildProposedCandidate(parentConfig: Record<string, unknown> | null): CandidateBundle['proposedCandidate'] {
  return {
    strategyFamily: 'low_vol_research',
    parameters: {
      executionMode: 'paper-shadow-only', requirePromotionV2: true, allowLiveTrading: false, allowPrivateAccount: false,
      volatilityLookbackHours: 504, rebalanceHours: 24, maxCandidateWeight: 0.10, costBufferBps: 20,
      parentConfigAvailable: parentConfig != null,
    },
    rationale: [
      'Constrain the proposal to the existing low-vol research lane and local OKX data.',
      'Require cost, PIT, WFO/OOS, scheduler, and Promotion-v2 evidence before paper/shadow promotion.',
      'Keep live trading, private accounts, source mutation, and production configuration mutation disabled.',
    ],
    patchSuggestions: [
      'Evaluate parameters only in an isolated candidate workspace; do not apply a source patch automatically.',
      'Add PBO, DSR, and candidate-bound FDR artifacts before recommending paper promotion.',
    ],
  }
}

function buildBaselineAssessment(dataRoot: string, parentConfig: Record<string, unknown> | null): CandidateBundle['validation']['baselines'] {
  return [
    { id: 'no-trade', status: 'pass', reason: 'No-trade is the mandatory safety baseline and has zero execution exposure.' },
    { id: 'simple-btc-buy-hold', status: 'missing', reason: `Candidate-bound comparison is not sealed under ${join(dataRoot, 'research', 'evolution')}.` },
    { id: 'current-champion', status: 'missing', reason: parentConfig ? 'Parent config is hashed, but candidate-bound metric comparison is not sealed.' : 'Current champion config is unavailable.' },
  ]
}

function decideRecommendation(checks: ValidationCheck[]): Recommendation {
  if (checks.some(check => check.status === 'fail')) return 'reject'
  if (checks.some(check => check.status === 'missing')) return 'watch'
  return 'paper-candidate'
}

function recommendationReason(recommendation: Recommendation, checks: ValidationCheck[]): string {
  const blocked = checks.filter(check => check.status !== 'pass').map(check => `${check.id}:${check.reason}`)
  return recommendation === 'paper-candidate'
    ? 'All registered mandatory validation checks passed; human approval is still required.'
    : `${recommendation} because ${blocked.join('; ') || 'candidate-bound evidence is incomplete'}`
}

async function readGitSnapshot(repoRoot: string): Promise<{ commit: string | null; dirtyHash: string; dirtyFileCount: number }> {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot }),
      execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repoRoot, maxBuffer: 20 * 1024 * 1024 }),
    ])
    const lines = status.split('\n').filter(Boolean)
    return { commit: commit.trim() || null, dirtyHash: sha256(status), dirtyFileCount: lines.length }
  } catch {
    return { commit: null, dirtyHash: sha256('git_unavailable'), dirtyFileCount: 0 }
  }
}

function enforceEvolutionRoot(args: CliArgs): void {
  assertWithin(args.evolutionRoot, join(args.dataRoot, 'research', 'evolution'), 'evolutionRoot')
  assertWithin(args.notificationPath, args.dataRoot, 'notificationPath')
}

function assertWithin(path: string, root: string, label: string): void {
  const rel = relative(resolve(root), resolve(path))
  if (rel.startsWith('..') || rel === '..' || rel.includes(`..${sep}`)) throw new Error(`${label} must stay inside ${root}`)
}

function isActivePrivateAccount(value: unknown): boolean {
  if (!isRecord(value)) return true
  const enabled = value.enabled !== false && value.active !== false && value.disabled !== true
  const kind = String(value.type ?? value.kind ?? value.mode ?? '').toLowerCase()
  const paper = kind.includes('paper') || kind.includes('shadow') || value.paper === true
  return enabled && !paper
}

function artifactStatus(value: unknown): string {
  if (!isRecord(value)) return 'unknown'
  for (const key of ['status', 'result', 'finalVerdict', 'verdict', 'readiness']) {
    const raw = value[key]
    if (typeof raw === 'string') return raw
  }
  if (value.pass === true || value.ready === true || value.canPromote === true) return 'pass'
  return 'unknown'
}

async function hashFileIfExists(path: string): Promise<string | null> { return existsSync(path) ? sha256(await readFile(path)) : null }

async function readRequiredJson(path: string): Promise<Record<string, unknown>> {
  const value = await readJsonIfExists(path)
  if (!isRecord(value)) throw new Error(`required JSON artifact missing or invalid: ${path}`)
  return value
}

async function readJsonIfExists(path: string): Promise<any | null> {
  if (!existsSync(path)) return null
  try { return JSON.parse(await readFile(path, 'utf-8')) }
  catch { return null }
}

function safeParseJson(raw: string): Record<string, unknown> | null {
  try { const value = JSON.parse(raw) as unknown; return isRecord(value) ? value : null }
  catch { return null }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
  await rename(tempPath, path)
}

async function writeNotification(path: string, result: RunResult, shouldNotify: boolean): Promise<void> {
  await atomicWriteJson(path, {
    shouldNotify,
    deliveryDecision: shouldNotify ? 'notify' : 'skip',
    headline: `gated improvement ${result.status}`,
    content: `mode=${result.mode} status=${result.status} candidateId=${result.candidateId ?? 'none'} recommendation=${result.recommendation ?? 'none'} blockers=${result.blockers?.join('|') || 'none'}`,
  })
}

function validateCandidateId(value: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value)) throw new Error('invalid candidateId') }
function parseMode(raw: string): Mode { if (raw === 'observe' || raw === 'candidate' || raw === 'promote') return raw; throw new Error(`invalid mode: ${raw}`) }
function normalizeOptional(raw: string | undefined): string | null { return !raw || ['null', 'none', 'false'].includes(raw.toLowerCase()) ? null : raw }
function readString(value: unknown): string | null { return typeof value === 'string' ? value : null }
function isRecord(value: unknown): value is Record<string, any> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function compactUtc(value: string): string { return value.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z') }
function parseBool(raw: string | undefined, fallback: boolean): boolean { return raw == null ? fallback : ['1', 'true', 'yes', 'y', 'on'].includes(raw.trim().toLowerCase()) }

function parseRawArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (!next || next.startsWith('--')) out.set(key, 'true')
    else { out.set(key, next); index += 1 }
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
}
