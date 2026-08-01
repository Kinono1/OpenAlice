import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { sha256Canonical } from '../sidecar/contracts.js'
import { writeJsonAtomic } from './atomic_write.js'
import {
  evidenceRefV1Schema,
  verifyEvidenceArtifact,
  type EvidenceRefV1,
} from './evidence_store.js'

export const ADMISSION_DECISION_V1 = 'admission_decision.v1' as const
export const ADMISSION_DECISION_MAX_TTL_MS = 15 * 60_000
export const DEFAULT_ADMISSION_DECISION_TTL_MS = 5 * 60_000

export const ADMISSION_STAGES = [
  'research_only',
  'paper_candidate',
  'paper_allowed',
  'tiny_cap_review',
  'live_admission_eligible',
  'live_allowed',
  'scaled_live_eligible',
] as const

export type AdmissionStage = (typeof ADMISSION_STAGES)[number]
export type AdmissionGateStatus = 'pass' | 'fail' | 'unknown' | 'stale'
export type AdmissionGateRequirement =
  | 'engineering'
  | 'paper'
  | 'tiny_cap'
  | 'live'
  | 'live_approval'
  | 'arm'
  | 'scaled_live'

const SHA256_RE = /^[a-f0-9]{64}$/
const COMMIT_RE = /^[a-f0-9]{40}$/

export const admissionGateResultV1Schema = z.object({
  gateId: z.string().trim().min(1).max(200),
  status: z.enum(['pass', 'fail', 'unknown', 'stale']),
  evidenceRefs: z.array(z.string().regex(SHA256_RE)),
  reasonCodes: z.array(z.string().trim().min(1).max(500)),
}).strict()

export const admissionDecisionV1Schema = z.object({
  schemaVersion: z.literal(ADMISSION_DECISION_V1),
  decisionId: z.string().regex(SHA256_RE),
  candidateId: z.string().trim().min(1).max(300).nullable(),
  evaluatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  sourceCommit: z.string().regex(COMMIT_RE),
  dirtyStateHash: z.string().regex(SHA256_RE),
  releaseManifestHash: z.string().regex(SHA256_RE),
  stage: z.enum(ADMISSION_STAGES),
  paperTradingAllowed: z.boolean(),
  liveTradingAllowed: z.boolean(),
  liveExecutionArmed: z.boolean(),
  gateResults: z.array(admissionGateResultV1Schema),
  blockingReasons: z.array(z.string().trim().min(1).max(500)),
  evidenceRefs: z.array(z.string().regex(SHA256_RE)),
  approvalRefs: z.array(z.string().trim().min(1).max(500)),
  accountScope: z.array(z.string().trim().min(1).max(200)),
  assetScope: z.array(z.string().trim().min(1).max(100)),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.evaluatedAt)) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'expiresAt must be later than evaluatedAt',
    })
  }
  if (value.paperTradingAllowed && stageRank(value.stage) < stageRank('paper_allowed')) {
    ctx.addIssue({
      code: 'custom',
      path: ['paperTradingAllowed'],
      message: 'paper trading requires paper_allowed or later stage',
    })
  }
  if (value.liveTradingAllowed && stageRank(value.stage) < stageRank('live_allowed')) {
    ctx.addIssue({
      code: 'custom',
      path: ['liveTradingAllowed'],
      message: 'live trading requires live_allowed or later stage',
    })
  }
  if (value.liveExecutionArmed && !value.liveTradingAllowed) {
    ctx.addIssue({
      code: 'custom',
      path: ['liveExecutionArmed'],
      message: 'execution arm requires live trading admission',
    })
  }
})

export type AdmissionGateResultV1 = z.infer<typeof admissionGateResultV1Schema>
export type AdmissionDecisionV1 = z.infer<typeof admissionDecisionV1Schema>

export interface AdmissionGateEvidenceInput {
  gateId: string
  requirement: AdmissionGateRequirement
  providerStatus: AdmissionGateStatus
  evidence: EvidenceRefV1[]
  acceptedSchemaVersions: string[]
  reasonCodes?: string[]
}

export interface AdmissionPolicyGate {
  gateId: string
  requirement: AdmissionGateRequirement
}

export interface AdmissionReducerInput {
  candidateId: string | null
  sourceCommit: string
  dirtyStateHash: string
  releaseManifestHash: string
  gates: AdmissionGateEvidenceInput[]
  evidenceGraph?: EvidenceRefV1[]
  approvalRefs?: string[]
  accountScope?: string[]
  assetScope?: string[]
  requestLiveExecutionArm?: boolean
  now?: Date
  ttlMs?: number
  policy?: readonly AdmissionPolicyGate[]
}

export const DEFAULT_ADMISSION_POLICY: readonly AdmissionPolicyGate[] = [
  { gateId: 'source_clean', requirement: 'engineering' },
  { gateId: 'release_manifest', requirement: 'engineering' },
  { gateId: 'pipeline_registry', requirement: 'engineering' },
  { gateId: 'scheduler_single_owner', requirement: 'engineering' },
  { gateId: 'credential_rotation', requirement: 'engineering' },
  { gateId: 'canary_isolation', requirement: 'engineering' },
  { gateId: 'rollback_drill', requirement: 'engineering' },
  { gateId: 'engineering_stability_24h', requirement: 'engineering' },
  { gateId: 'promotion_v2_6', requirement: 'paper' },
  { gateId: 'pit', requirement: 'paper' },
  { gateId: 'wfo_oos', requirement: 'paper' },
  { gateId: 'fdr', requirement: 'paper' },
  { gateId: 'current_ic', requirement: 'paper' },
  { gateId: 'replay', requirement: 'paper' },
  { gateId: 'cost_model', requirement: 'paper' },
  { gateId: 'risk', requirement: 'paper' },
  { gateId: 'kill_switch', requirement: 'paper' },
  { gateId: 'data_freshness', requirement: 'paper' },
  { gateId: 'paper_shadow_7d', requirement: 'paper' },
  { gateId: 'severe_incidents_7d_zero', requirement: 'paper' },
  { gateId: 'tiny_cap_review', requirement: 'tiny_cap' },
  { gateId: 'live_evidence_30d', requirement: 'live' },
  { gateId: 'net_return_after_costs_positive', requirement: 'live' },
  { gateId: 'max_drawdown_lte_5pct', requirement: 'live' },
  { gateId: 'severe_incidents_unresolved_zero', requirement: 'live' },
  { gateId: 'okx_readonly_health', requirement: 'live' },
  { gateId: 'okx_permission_preflight', requirement: 'live' },
  { gateId: 'live_dual_approval', requirement: 'live_approval' },
  { gateId: 'live_execution_arm', requirement: 'arm' },
  { gateId: 'scaled_live_observation', requirement: 'scaled_live' },
] as const

export type AdmissionDecisionLoadResult =
  | { kind: 'loaded'; path: string; decision: AdmissionDecisionV1 }
  | { kind: 'missing' | 'invalid' | 'stale'; path: string; error: string; decision?: AdmissionDecisionV1 }

export async function reduceAdmissionDecision(
  input: AdmissionReducerInput,
): Promise<AdmissionDecisionV1> {
  validateReducerContext(input)
  const now = input.now ?? new Date()
  const policy = input.policy ?? DEFAULT_ADMISSION_POLICY
  const evaluated = await evaluateGateInputs(input.gates, policy, {
    now,
    sourceCommit: input.sourceCommit,
    dirtyStateHash: input.dirtyStateHash,
  }, input.evidenceGraph ?? [])

  const engineeringPass = requirementPass(evaluated, policy, 'engineering')
  const paperPass = requirementPass(evaluated, policy, 'paper')
  const tinyCapPass = requirementPass(evaluated, policy, 'tiny_cap')
  const livePass = requirementPass(evaluated, policy, 'live')
  const liveApprovalPass = requirementPass(evaluated, policy, 'live_approval')
  const armPass = requirementPass(evaluated, policy, 'arm')
  const scaledLivePass = requirementPass(evaluated, policy, 'scaled_live')

  let stage: AdmissionStage = 'research_only'
  let paperTradingAllowed = false
  let liveTradingAllowed = false

  if (input.candidateId && engineeringPass) {
    stage = 'paper_candidate'
    if (paperPass) {
      stage = 'paper_allowed'
      paperTradingAllowed = true
      if (tinyCapPass) {
        stage = 'tiny_cap_review'
        if (livePass) {
          stage = 'live_admission_eligible'
          if (liveApprovalPass) {
            stage = 'live_allowed'
            liveTradingAllowed = true
            if (scaledLivePass) {
              stage = 'scaled_live_eligible'
            }
          }
        }
      }
    }
  }

  const liveExecutionArmed = Boolean(
    input.requestLiveExecutionArm
    && liveTradingAllowed
    && armPass,
  )
  const ttlMs = clampTtl(input.ttlMs)
  const expiresAtMs = Math.min(
    now.getTime() + ttlMs,
    ...passingEvidenceExpiries(evaluated, now.getTime() + ttlMs),
  )
  const gateResults = [...evaluated.values()]
    .map((gate) => ({
      gateId: gate.gateId,
      status: gate.status,
      evidenceRefs: sortedUnique(gate.evidenceRefs),
      reasonCodes: sortedUnique(gate.reasonCodes),
    }))
    .sort((left, right) => left.gateId.localeCompare(right.gateId))
  const blockingReasons = resolveBlockingReasons({
    stage,
    candidateId: input.candidateId,
    requestLiveExecutionArm: input.requestLiveExecutionArm === true,
    liveExecutionArmed,
    gates: evaluated,
    policy,
  })
  const core = {
    candidateId: input.candidateId,
    evaluatedAt: now.toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    sourceCommit: input.sourceCommit,
    dirtyStateHash: input.dirtyStateHash,
    releaseManifestHash: input.releaseManifestHash,
    stage,
    paperTradingAllowed,
    liveTradingAllowed,
    liveExecutionArmed,
    gateResults,
    blockingReasons,
    evidenceRefs: sortedUnique(gateResults.flatMap((gate) => gate.evidenceRefs)),
    approvalRefs: sortedUnique(input.approvalRefs ?? []),
    accountScope: sortedUnique(input.accountScope ?? []),
    assetScope: sortedUnique(input.assetScope ?? []),
  }
  return admissionDecisionV1Schema.parse({
    schemaVersion: ADMISSION_DECISION_V1,
    decisionId: admissionDecisionId(core),
    ...core,
  })
}

export function admissionDecisionId(
  decision: Omit<AdmissionDecisionV1, 'schemaVersion' | 'decisionId'>,
): string {
  return sha256Canonical(decision)
}

export function validateAdmissionDecision(input: unknown): AdmissionDecisionV1 {
  const decision = admissionDecisionV1Schema.parse(input)
  const { schemaVersion: _schemaVersion, decisionId, ...core } = decision
  if (admissionDecisionId(core) !== decisionId) {
    throw new Error('admission_decision_hash_mismatch')
  }
  return decision
}

export async function tryLoadAdmissionDecision(
  path: string,
  options: { now?: Date } = {},
): Promise<AdmissionDecisionLoadResult> {
  let raw: string
  try {
    raw = await readFile(path, 'utf-8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    return {
      kind: code === 'ENOENT' ? 'missing' : 'invalid',
      path,
      error: code === 'ENOENT'
        ? 'admission_decision_missing'
        : error instanceof Error
          ? error.message
          : String(error),
    }
  }

  let decision: AdmissionDecisionV1
  try {
    decision = validateAdmissionDecision(JSON.parse(raw))
  } catch (error) {
    return {
      kind: 'invalid',
      path,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  const now = options.now ?? new Date()
  if (Date.parse(decision.expiresAt) <= now.getTime()) {
    return {
      kind: 'stale',
      path,
      error: 'admission_decision_expired',
      decision,
    }
  }
  return { kind: 'loaded', path, decision }
}

export function writeAdmissionDecision(path: string, decision: AdmissionDecisionV1): void {
  const parsed = validateAdmissionDecision(decision)
  writeJsonAtomic(path, parsed)
}

export function gatePassed(
  decision: AdmissionDecisionV1 | null | undefined,
  gateId: string,
): boolean {
  return decision?.gateResults.some(
    (gate) => gate.gateId === gateId && gate.status === 'pass',
  ) === true
}

export function decisionAllowsPaperAsset(
  decision: AdmissionDecisionV1 | null | undefined,
  asset: string,
): boolean {
  return Boolean(
    decision
    && Date.parse(decision.expiresAt) > Date.now()
    && decision.paperTradingAllowed
    && stageRank(decision.stage) >= stageRank('paper_allowed')
    && decision.assetScope.includes(asset),
  )
}

export function stageRank(stage: AdmissionStage): number {
  return ADMISSION_STAGES.indexOf(stage)
}

interface EvaluatedGate {
  gateId: string
  requirement: AdmissionGateRequirement
  status: AdmissionGateStatus
  evidenceRefs: string[]
  reasonCodes: string[]
  expiries: number[]
}

async function evaluateGateInputs(
  inputs: AdmissionGateEvidenceInput[],
  policy: readonly AdmissionPolicyGate[],
  context: { now: Date; sourceCommit: string; dirtyStateHash: string },
  evidenceGraph: EvidenceRefV1[],
): Promise<Map<string, EvaluatedGate>> {
  const policyMap = new Map(policy.map((gate) => [gate.gateId, gate]))
  const grouped = new Map<string, AdmissionGateEvidenceInput[]>()
  for (const input of inputs) {
    const policyGate = policyMap.get(input.gateId)
    if (!policyGate || policyGate.requirement !== input.requirement) continue
    grouped.set(input.gateId, [...(grouped.get(input.gateId) ?? []), input])
  }

  const evidenceIndex = buildEvidenceIndex(inputs, evidenceGraph)
  const evaluated = new Map<string, EvaluatedGate>()
  for (const policyGate of policy) {
    const candidates = grouped.get(policyGate.gateId) ?? []
    if (candidates.length === 0) {
      evaluated.set(policyGate.gateId, {
        ...policyGate,
        status: 'unknown',
        evidenceRefs: [],
        reasonCodes: [`missing_gate_evidence:${policyGate.gateId}`],
        expiries: [],
      })
      continue
    }
    if (candidates.length > 1) {
      evaluated.set(policyGate.gateId, {
        ...policyGate,
        status: 'unknown',
        evidenceRefs: sortedUnique(candidates.flatMap((item) => item.evidence.map((ref) => ref.artifactHash))),
        reasonCodes: [`conflicting_gate_evidence:${policyGate.gateId}`],
        expiries: [],
      })
      continue
    }
    evaluated.set(
      policyGate.gateId,
      await evaluateOneGate(candidates[0]!, policyGate, context, evidenceIndex),
    )
  }
  return evaluated
}

async function evaluateOneGate(
  input: AdmissionGateEvidenceInput,
  policyGate: AdmissionPolicyGate,
  context: { now: Date; sourceCommit: string; dirtyStateHash: string },
  evidenceIndex: Map<string, EvidenceRefV1 | null>,
): Promise<EvaluatedGate> {
  const reasonCodes = [...(input.reasonCodes ?? [])]
  const evidenceRefs: string[] = []
  const expiries: number[] = []
  if (input.providerStatus !== 'pass') {
    return {
      ...policyGate,
      status: input.providerStatus,
      evidenceRefs: input.evidence.map((ref) => ref.artifactHash),
      reasonCodes: reasonCodes.length > 0
        ? reasonCodes
        : [`gate_provider_${input.providerStatus}:${input.gateId}`],
      expiries,
    }
  }
  if (input.evidence.length === 0) {
    return {
      ...policyGate,
      status: 'unknown',
      evidenceRefs,
      reasonCodes: [...reasonCodes, `missing_evidence_ref:${input.gateId}`],
      expiries,
    }
  }
  if (input.acceptedSchemaVersions.length === 0) {
    return {
      ...policyGate,
      status: 'unknown',
      evidenceRefs: input.evidence.map((ref) => ref.artifactHash),
      reasonCodes: [...reasonCodes, `missing_schema_allowlist:${input.gateId}`],
      expiries,
    }
  }

  let status: AdmissionGateStatus = 'pass'
  for (const rawRef of input.evidence) {
    let ref: EvidenceRefV1
    try {
      ref = evidenceRefV1Schema.parse(rawRef)
    } catch {
      status = 'unknown'
      reasonCodes.push(`invalid_evidence_ref:${input.gateId}`)
      continue
    }
    evidenceRefs.push(ref.artifactHash)
    expiries.push(Date.parse(ref.expiresAt))
    if (!input.acceptedSchemaVersions.includes(ref.schemaVersion)) {
      status = 'unknown'
      reasonCodes.push(`unknown_evidence_schema:${ref.schemaVersion}`)
      continue
    }
    if (ref.sourceCommit !== context.sourceCommit) {
      status = 'stale'
      reasonCodes.push(`source_commit_mismatch:${input.gateId}`)
      continue
    }
    if (ref.dirtyStateHash !== context.dirtyStateHash) {
      status = 'stale'
      reasonCodes.push(`dirty_state_hash_mismatch:${input.gateId}`)
      continue
    }
    if (Date.parse(ref.expiresAt) <= context.now.getTime()) {
      status = 'stale'
      reasonCodes.push(`evidence_expired:${input.gateId}`)
      continue
    }
    if (Date.parse(ref.generatedAt) > context.now.getTime() + 30_000) {
      status = 'stale'
      reasonCodes.push(`evidence_from_future:${input.gateId}`)
      continue
    }
    const artifact = verifyEvidenceDag(ref, evidenceIndex, context)
    if (artifact.status !== 'pass') {
      status = artifact.status === 'tampered' ? 'fail' : artifact.status
      reasonCodes.push(`${artifact.status}:${input.gateId}:${artifact.reason}`)
    }
  }
  return {
    ...policyGate,
    status,
    evidenceRefs: sortedUnique(evidenceRefs),
    reasonCodes: sortedUnique(reasonCodes),
    expiries,
  }
}

function buildEvidenceIndex(
  inputs: AdmissionGateEvidenceInput[],
  evidenceGraph: EvidenceRefV1[],
): Map<string, EvidenceRefV1 | null> {
  const index = new Map<string, EvidenceRefV1 | null>()
  for (const ref of [
    ...evidenceGraph,
    ...inputs.flatMap((input) => input.evidence),
  ]) {
    const parsed = evidenceRefV1Schema.safeParse(ref)
    if (!parsed.success) continue
    const existing = index.get(parsed.data.artifactHash)
    if (existing && sha256Canonical(existing) !== sha256Canonical(parsed.data)) {
      index.set(parsed.data.artifactHash, null)
      continue
    }
    if (existing === undefined) index.set(parsed.data.artifactHash, parsed.data)
  }
  return index
}

function verifyEvidenceDag(
  root: EvidenceRefV1,
  evidenceIndex: Map<string, EvidenceRefV1 | null>,
  context: { now: Date; sourceCommit: string; dirtyStateHash: string },
): { status: 'pass' | 'fail' | 'unknown' | 'stale' | 'tampered'; reason: string } {
  const visited = new Set<string>()
  const active = new Set<string>()

  const visit = (
    ref: EvidenceRefV1,
  ): { status: 'pass' | 'fail' | 'unknown' | 'stale' | 'tampered'; reason: string } => {
    if (active.has(ref.artifactHash)) {
      return { status: 'fail', reason: `evidence_cycle:${ref.artifactHash}` }
    }
    if (visited.has(ref.artifactHash)) return { status: 'pass', reason: 'verified' }
    active.add(ref.artifactHash)

    if (ref.sourceCommit !== context.sourceCommit) {
      active.delete(ref.artifactHash)
      return { status: 'stale', reason: `parent_source_commit_mismatch:${ref.artifactHash}` }
    }
    if (ref.dirtyStateHash !== context.dirtyStateHash) {
      active.delete(ref.artifactHash)
      return { status: 'stale', reason: `parent_dirty_state_hash_mismatch:${ref.artifactHash}` }
    }
    if (Date.parse(ref.expiresAt) <= context.now.getTime()) {
      active.delete(ref.artifactHash)
      return { status: 'stale', reason: `parent_evidence_expired:${ref.artifactHash}` }
    }
    if (Date.parse(ref.generatedAt) > context.now.getTime() + 30_000) {
      active.delete(ref.artifactHash)
      return { status: 'stale', reason: `parent_evidence_from_future:${ref.artifactHash}` }
    }

    const artifact = verifyEvidenceArtifact(ref)
    if (artifact.status !== 'pass') {
      active.delete(ref.artifactHash)
      return {
        status: artifact.status === 'tampered' ? 'tampered' : 'unknown',
        reason: `${artifact.reason}:${ref.artifactHash}`,
      }
    }

    for (const parentHash of ref.parentEvidenceRefs) {
      const parent = evidenceIndex.get(parentHash)
      if (parent === null) {
        active.delete(ref.artifactHash)
        return { status: 'fail', reason: `conflicting_parent_evidence:${parentHash}` }
      }
      if (!parent) {
        active.delete(ref.artifactHash)
        return { status: 'unknown', reason: `missing_parent_evidence:${parentHash}` }
      }
      const result = visit(parent)
      if (result.status !== 'pass') {
        active.delete(ref.artifactHash)
        return result
      }
    }

    active.delete(ref.artifactHash)
    visited.add(ref.artifactHash)
    return { status: 'pass', reason: 'verified' }
  }

  return visit(root)
}

function requirementPass(
  gates: Map<string, EvaluatedGate>,
  policy: readonly AdmissionPolicyGate[],
  requirement: AdmissionGateRequirement,
): boolean {
  const required = policy.filter((gate) => gate.requirement === requirement)
  return required.length > 0 && required.every(
    (gate) => gates.get(gate.gateId)?.status === 'pass',
  )
}

function resolveBlockingReasons(input: {
  stage: AdmissionStage
  candidateId: string | null
  requestLiveExecutionArm: boolean
  liveExecutionArmed: boolean
  gates: Map<string, EvaluatedGate>
  policy: readonly AdmissionPolicyGate[]
}): string[] {
  if (!input.candidateId) return ['candidate_missing']
  const nextRequirement: AdmissionGateRequirement | null =
    input.stage === 'research_only' ? 'engineering'
      : input.stage === 'paper_candidate' ? 'paper'
        : input.stage === 'paper_allowed' ? 'tiny_cap'
          : input.stage === 'tiny_cap_review' ? 'live'
            : input.stage === 'live_admission_eligible' ? 'live_approval'
              : input.stage === 'live_allowed' ? 'scaled_live'
                : null
  const reasons = nextRequirement
    ? input.policy
        .filter((gate) => gate.requirement === nextRequirement)
        .flatMap((gate) => {
          const result = input.gates.get(gate.gateId)
          return result?.status === 'pass'
            ? []
            : result?.reasonCodes.length
              ? result.reasonCodes
              : [`gate_blocked:${gate.gateId}`]
        })
    : []
  if (input.requestLiveExecutionArm && !input.liveExecutionArmed) {
    reasons.push(
      ...input.policy
        .filter((gate) => gate.requirement === 'arm')
        .flatMap((gate) => input.gates.get(gate.gateId)?.reasonCodes ?? [`gate_blocked:${gate.gateId}`]),
    )
  }
  return sortedUnique(reasons)
}

function passingEvidenceExpiries(
  gates: Map<string, EvaluatedGate>,
  fallback: number,
): number[] {
  const values = [...gates.values()]
    .filter((gate) => gate.status === 'pass')
    .flatMap((gate) => gate.expiries)
    .filter((value) => Number.isFinite(value))
  return values.length > 0 ? values : [fallback]
}

function validateReducerContext(input: AdmissionReducerInput): void {
  if (!COMMIT_RE.test(input.sourceCommit)) {
    throw new Error('sourceCommit must be a 40-character lowercase SHA')
  }
  if (!SHA256_RE.test(input.dirtyStateHash)) {
    throw new Error('dirtyStateHash must be a SHA-256 digest')
  }
  if (!SHA256_RE.test(input.releaseManifestHash)) {
    throw new Error('releaseManifestHash must be a SHA-256 digest')
  }
}

function clampTtl(value: number | undefined): number {
  const requested = value ?? DEFAULT_ADMISSION_DECISION_TTL_MS
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error('admission decision TTL must be positive')
  }
  return Math.min(Math.floor(requested), ADMISSION_DECISION_MAX_TTL_MS)
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}
