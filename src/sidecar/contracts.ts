import { createHash } from 'node:crypto'
import { z } from 'zod'

export const OPENALICE_SIDECAR_REQUEST_V1 = 'openalice_sidecar_request.v1' as const
export const OPENALICE_SIDECAR_RESULT_V1 = 'openalice_sidecar_result.v1' as const
export const SIDECAR_EVIDENCE_MANIFEST_V1 = 'sidecar_evidence_manifest.v1' as const

export const SIDECAR_SOURCES = ['tradingagents', 'alphaswarm'] as const
export const SIDECAR_ASSETS = ['BTC/USD', 'ETH/USD'] as const

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const commitSchema = z.string().regex(/^[a-f0-9]{40}$/)
const artifactSchema = z.object({
  artifactId: z.string().trim().min(1).max(200),
  sha256: sha256Schema,
}).strict()

const requestCoreSchema = z.object({
  schemaVersion: z.literal(OPENALICE_SIDECAR_REQUEST_V1),
  runId: z.string().trim().min(1).max(200),
  source: z.enum(SIDECAR_SOURCES),
  issuedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  allowedAssets: z.array(z.enum(SIDECAR_ASSETS)).min(1),
  inputArtifacts: z.array(artifactSchema).min(1),
  openAliceCommit: commitSchema,
  sidecarCommit: commitSchema,
  mode: z.literal('research_only'),
  payload: z.record(z.string(), z.unknown()),
}).strict()

export const openAliceSidecarRequestV1Schema = requestCoreSchema.extend({
  requestSha256: sha256Schema,
}).strict()

export const normalizedResearchSignalV1Schema = z.object({
  signalId: z.string().trim().min(1).max(200),
  asset: z.enum(SIDECAR_ASSETS),
  asOf: z.string().datetime(),
  ttlMs: z.number().int().positive().max(900_000),
  targetPositionPct: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  thesis: z.string().trim().min(1).max(20_000),
  riskNote: z.string().trim().min(1).max(10_000).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict()

const failureSchema = z.object({
  category: z.enum([
    'timeout',
    'crash',
    'invalid_request',
    'invalid_output',
    'unknown_version',
    'tampered',
    'internal_error',
  ]),
  message: z.string().trim().min(1).max(2_000),
}).strict()

const runtimeSchema = z.object({
  name: z.string().trim().min(1),
  version: z.string().trim().min(1),
  language: z.string().trim().min(1),
  modelVersions: z.array(z.string().trim().min(1)).default([]),
}).strict()

export const openAliceSidecarResultV1Schema = z.object({
  schemaVersion: z.literal(OPENALICE_SIDECAR_RESULT_V1),
  runId: z.string().trim().min(1).max(200),
  source: z.enum(SIDECAR_SOURCES),
  status: z.enum(['ok', 'empty', 'failed', 'timeout']),
  generatedAt: z.string().datetime(),
  mode: z.literal('research_only'),
  signals: z.array(normalizedResearchSignalV1Schema),
  provenance: z.object({
    openAliceCommit: commitSchema,
    sidecarCommit: commitSchema,
    requestSha256: sha256Schema,
  }).strict(),
  runtime: runtimeSchema,
  outputPayloadSha256: sha256Schema,
  evidenceManifestSha256: sha256Schema,
  failure: failureSchema.nullable(),
}).strict()

const evidenceArtifactSchema = artifactSchema.extend({
  mediaType: z.string().trim().min(1).max(200),
}).strict()

export const sidecarEvidenceManifestV1Schema = z.object({
  schemaVersion: z.literal(SIDECAR_EVIDENCE_MANIFEST_V1),
  runId: z.string().trim().min(1).max(200),
  source: z.enum(SIDECAR_SOURCES),
  mode: z.literal('research_only'),
  createdAt: z.string().datetime(),
  openAliceCommit: commitSchema,
  sidecarCommit: commitSchema,
  requestSha256: sha256Schema,
  outputPayloadSha256: sha256Schema,
  inputArtifacts: z.array(artifactSchema).min(1),
  artifacts: z.array(evidenceArtifactSchema),
}).strict()

export type OpenAliceSidecarRequestV1 = z.infer<typeof openAliceSidecarRequestV1Schema>
export type NormalizedResearchSignalV1 = z.infer<typeof normalizedResearchSignalV1Schema>
export type OpenAliceSidecarResultV1 = z.infer<typeof openAliceSidecarResultV1Schema>
export type SidecarEvidenceManifestV1 = z.infer<typeof sidecarEvidenceManifestV1Schema>

export interface SidecarResultBundleV1 {
  result: OpenAliceSidecarResultV1
  manifest: SidecarEvidenceManifestV1
}

export interface SidecarValidationOptions {
  now?: Date
  allowedAssets: readonly string[]
  allowedOpenAliceCommits: readonly string[]
  allowedSidecarCommits: Partial<Record<(typeof SIDECAR_SOURCES)[number], readonly string[]>>
}

export interface SidecarValidationDecision {
  accepted: boolean
  disposition:
    | 'accepted_research_only'
    | 'degraded_research_only'
    | 'rejected_circuit_open'
  reason: string
  circuitOpen: boolean
  source?: (typeof SIDECAR_SOURCES)[number]
  runId?: string
  signals: NormalizedResearchSignalV1[]
  paperTradingAllowed: false
  liveTradingAllowed: false
  liveExecutionArmed: false
}

const FORBIDDEN_EXECUTION_KEYS = new Set([
  'approval',
  'authorization',
  'brokercredential',
  'brokercredentials',
  'canexecute',
  'canlive',
  'canorder',
  'canpaper',
  'canpromote',
  'cantrade',
  'executionarmed',
  'executionauthorization',
  'liveexecutionarmed',
  'livetradingallowed',
  'orderauthorization',
  'papertradingallowed',
  'tradeallowed',
])

export function buildOpenAliceSidecarRequestV1(
  input: z.input<typeof requestCoreSchema>,
): OpenAliceSidecarRequestV1 {
  const core = requestCoreSchema.parse(input)
  assertNoExecutionAuthorization(core)
  assertUnique(core.allowedAssets, 'allowedAssets')
  assertUnique(core.inputArtifacts.map((item) => item.artifactId), 'inputArtifacts')
  const issuedAt = Date.parse(core.issuedAt)
  const expiresAt = Date.parse(core.expiresAt)
  if (expiresAt <= issuedAt) {
    throw new Error('expiresAt must be later than issuedAt')
  }
  return openAliceSidecarRequestV1Schema.parse({
    ...core,
    requestSha256: sha256Canonical(core),
  })
}

export function buildSidecarResultBundleV1(input: {
  request: OpenAliceSidecarRequestV1
  status: OpenAliceSidecarResultV1['status']
  generatedAt: string
  signals: NormalizedResearchSignalV1[]
  runtime: OpenAliceSidecarResultV1['runtime']
  failure: OpenAliceSidecarResultV1['failure']
  artifacts?: SidecarEvidenceManifestV1['artifacts']
}): SidecarResultBundleV1 {
  const request = openAliceSidecarRequestV1Schema.parse(input.request)
  const signals = input.signals.map((signal) =>
    normalizedResearchSignalV1Schema.parse(signal),
  )
  const outputCore = {
    runId: request.runId,
    source: request.source,
    status: input.status,
    signals,
    failure: input.failure,
  }
  const outputPayloadSha256 = sha256Canonical(outputCore)
  const manifest = sidecarEvidenceManifestV1Schema.parse({
    schemaVersion: SIDECAR_EVIDENCE_MANIFEST_V1,
    runId: request.runId,
    source: request.source,
    mode: 'research_only',
    createdAt: input.generatedAt,
    openAliceCommit: request.openAliceCommit,
    sidecarCommit: request.sidecarCommit,
    requestSha256: request.requestSha256,
    outputPayloadSha256,
    inputArtifacts: request.inputArtifacts,
    artifacts: input.artifacts ?? [],
  })
  const result = openAliceSidecarResultV1Schema.parse({
    schemaVersion: OPENALICE_SIDECAR_RESULT_V1,
    runId: request.runId,
    source: request.source,
    status: input.status,
    generatedAt: input.generatedAt,
    mode: 'research_only',
    signals,
    provenance: {
      openAliceCommit: request.openAliceCommit,
      sidecarCommit: request.sidecarCommit,
      requestSha256: request.requestSha256,
    },
    runtime: input.runtime,
    outputPayloadSha256,
    evidenceManifestSha256: sha256Canonical(manifest),
    failure: input.failure,
  })
  assertNoExecutionAuthorization(result)
  return { result, manifest }
}

export function validateSidecarExchangeV1(input: {
  request: unknown
  result: unknown
  manifest: unknown
  options: SidecarValidationOptions
}): SidecarValidationDecision {
  const rawVersionReason = detectUnknownVersion(input)
  if (rawVersionReason) return rejected(rawVersionReason)
  try {
    assertNoExecutionAuthorization(input.request)
    assertNoExecutionAuthorization(input.result)
    assertNoExecutionAuthorization(input.manifest)
  } catch {
    return rejected('execution_authorization_forbidden')
  }

  let request: OpenAliceSidecarRequestV1
  let result: OpenAliceSidecarResultV1
  let manifest: SidecarEvidenceManifestV1
  try {
    request = openAliceSidecarRequestV1Schema.parse(input.request)
    result = openAliceSidecarResultV1Schema.parse(input.result)
    manifest = sidecarEvidenceManifestV1Schema.parse(input.manifest)
  } catch {
    return rejected('invalid_contract')
  }

  const identity = { source: request.source, runId: request.runId }
  const now = input.options.now ?? new Date()
  const nowMs = now.getTime()
  const issuedAtMs = Date.parse(request.issuedAt)
  const expiresAtMs = Date.parse(request.expiresAt)
  if (issuedAtMs > nowMs + 60_000) {
    return rejected('request_issued_in_future', identity)
  }
  if (expiresAtMs <= issuedAtMs || nowMs > expiresAtMs) {
    return rejected('request_expired', identity)
  }
  if (Date.parse(result.generatedAt) > expiresAtMs) {
    return rejected('result_after_request_expiry', identity)
  }
  if (
    result.runId !== request.runId
    || manifest.runId !== request.runId
    || result.source !== request.source
    || manifest.source !== request.source
  ) {
    return rejected('identity_mismatch', identity)
  }
  if (
    result.mode !== 'research_only'
    || manifest.mode !== 'research_only'
    || request.mode !== 'research_only'
  ) {
    return rejected('research_only_mode_required', identity)
  }
  if (
    !input.options.allowedOpenAliceCommits.includes(request.openAliceCommit)
    || !input.options.allowedSidecarCommits[request.source]?.includes(request.sidecarCommit)
  ) {
    return rejected('commit_not_allowlisted', identity)
  }
  if (
    result.provenance.openAliceCommit !== request.openAliceCommit
    || manifest.openAliceCommit !== request.openAliceCommit
    || result.provenance.sidecarCommit !== request.sidecarCommit
    || manifest.sidecarCommit !== request.sidecarCommit
  ) {
    return rejected('commit_binding_mismatch', identity)
  }
  const { requestSha256: _requestSha256, ...requestCore } = request
  if (
    request.requestSha256 !== sha256Canonical(requestCore)
    || result.provenance.requestSha256 !== request.requestSha256
    || manifest.requestSha256 !== request.requestSha256
  ) {
    return rejected('request_hash_mismatch', identity)
  }
  if (!sameArtifacts(request.inputArtifacts, manifest.inputArtifacts)) {
    return rejected('input_artifact_hash_mismatch', identity)
  }
  const outputCore = {
    runId: result.runId,
    source: result.source,
    status: result.status,
    signals: result.signals,
    failure: result.failure,
  }
  if (
    result.outputPayloadSha256 !== sha256Canonical(outputCore)
    || manifest.outputPayloadSha256 !== result.outputPayloadSha256
  ) {
    return rejected('output_hash_mismatch', identity)
  }
  if (result.evidenceManifestSha256 !== sha256Canonical(manifest)) {
    return rejected('manifest_hash_mismatch', identity)
  }

  const runtimeAssets = new Set(input.options.allowedAssets)
  const requestAssets = new Set(request.allowedAssets)
  if (
    request.allowedAssets.some((asset) => !runtimeAssets.has(asset))
    || result.signals.some(
      (signal) => !runtimeAssets.has(signal.asset) || !requestAssets.has(signal.asset),
    )
  ) {
    return rejected('asset_not_allowlisted', identity)
  }
  if (
    result.signals.some(
      (signal) => Date.parse(signal.asOf) + signal.ttlMs < nowMs,
    )
  ) {
    return rejected('signal_expired', identity)
  }
  if (result.status === 'timeout') {
    return rejected('sidecar_timeout', identity)
  }
  if (result.status === 'failed') {
    return rejected(
      result.failure?.category === 'crash' ? 'sidecar_crash' : 'sidecar_failed',
      identity,
    )
  }
  if (result.status === 'empty' || result.signals.length === 0) {
    return {
      ...baseDecision,
      ...identity,
      accepted: false,
      disposition: 'degraded_research_only',
      reason: 'empty_signal',
      circuitOpen: false,
      signals: [],
    }
  }
  if (result.failure !== null) return rejected('unexpected_failure_payload', identity)

  return {
    ...baseDecision,
    ...identity,
    accepted: true,
    disposition: 'accepted_research_only',
    reason: 'valid_research_only_result',
    circuitOpen: false,
    signals: result.signals,
  }
}

export function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(stableStringify(value), 'utf-8').digest('hex')
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number in contract')
    return Object.is(value, -0) ? '0' : JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`
  }
  throw new Error(`unsupported contract value: ${typeof value}`)
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? 0)
  const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? 0)
  const length = Math.min(leftPoints.length, rightPoints.length)
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index] - rightPoints[index]
    }
  }
  return leftPoints.length - rightPoints.length
}

function detectUnknownVersion(input: {
  request: unknown
  result: unknown
  manifest: unknown
}): string | null {
  const versions = [
    [input.request, OPENALICE_SIDECAR_REQUEST_V1],
    [input.result, OPENALICE_SIDECAR_RESULT_V1],
    [input.manifest, SIDECAR_EVIDENCE_MANIFEST_V1],
  ] as const
  for (const [value, expected] of versions) {
    if (
      value
      && typeof value === 'object'
      && 'schemaVersion' in value
      && (value as { schemaVersion?: unknown }).schemaVersion !== expected
    ) {
      return 'unknown_schema_version'
    }
  }
  return null
}

function assertNoExecutionAuthorization(value: unknown, path = 'root'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoExecutionAuthorization(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (isForbiddenExecutionKey(normalized)) {
      throw new Error(`${path}.${key} contains execution authorization`)
    }
    assertNoExecutionAuthorization(item, `${path}.${key}`)
  }
}

function isForbiddenExecutionKey(normalized: string): boolean {
  if (FORBIDDEN_EXECUTION_KEYS.has(normalized)) return true
  if (
    normalized.includes('authorization')
    || normalized.startsWith('approval')
    || normalized.endsWith('approval')
  ) {
    return true
  }
  return /^(?:can)?(?:paper|live|trade|trading|execution|order|promotion|promote).*(?:allowed|armed|approved|enabled|authorized|eligible)$/
    .test(normalized)
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${field} must contain unique values`)
  }
}

function sameArtifacts(
  left: OpenAliceSidecarRequestV1['inputArtifacts'],
  right: SidecarEvidenceManifestV1['inputArtifacts'],
): boolean {
  const normalize = (items: typeof left) =>
    [...items]
      .map((item) => `${item.artifactId}:${item.sha256}`)
      .sort()
  return stableStringify(normalize(left)) === stableStringify(normalize(right))
}

const baseDecision = {
  paperTradingAllowed: false,
  liveTradingAllowed: false,
  liveExecutionArmed: false,
} as const

function rejected(
  reason: string,
  identity: {
    source?: (typeof SIDECAR_SOURCES)[number]
    runId?: string
  } = {},
): SidecarValidationDecision {
  return {
    ...baseDecision,
    ...identity,
    accepted: false,
    disposition: 'rejected_circuit_open',
    reason,
    circuitOpen: true,
    signals: [],
  }
}
